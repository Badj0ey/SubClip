/**
 * 成片拼接（第九阶段）。
 *
 * ## 它做什么
 *
 * 把片段库里的**多条片段**按顺序合成**一条 mp4**（跨视频也支持）——
 * 这是「智能剪辑 → 内容发布」之间缺的那一步：切片工具一次只产出一个文件，
 * 而发布一条成片往往要把选好的几段接起来。
 *
 * ## 为什么不重写切片逻辑
 *
 * 切片（解析播放地址 → 下载分片 → 裁剪 → 混流）已经有一套**专门处理 B站 DASH**
 * 的实现（`slice/engine.ts`），里面有分P、音视频流分离、cookie 等一堆坑。
 * 所以这里只做**编排**：先让 `runSliceTasks()` 把每条片段切成单独的 mp4，
 * 再用 `concatVideos()` 按顺序拼起来 —— 复用经过验证的路径，而不是平行实现一套。
 *
 * ## 中间产物一定要清理
 *
 * 每条的单独 mp4 只是中间物。不清理的话用户的输出目录会被一堆
 * 「本来没想要」的文件塞满 —— 而且它们和成片长得一样，很难分辨。
 * 所以只在**全部成功**后删；失败了保留，方便用户看是哪一段出的问题。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as db from './db'
import { loadSettings } from './settings'
import { concatVideos, resolveFfmpeg } from './slice/ffmpeg'
import { runSliceTasks, type SliceTaskInput } from './slice/engine'
import { safeKitName } from '@shared/publishKit'
import type { SliceSegmentInput } from './slice/engine'

export interface ComposeProgress {
  phase: 'prepare' | 'slice' | 'concat' | 'done' | 'error'
  /** 0~100（整个成片任务的进度，不是单条片段） */
  percent: number
  message: string
}

export interface ComposeResult {
  ok: boolean
  /** 成片路径（失败时为空） */
  output?: string
  /** 各条片段的切片结果 */
  outputs: string[]
  message?: string
  /** 被保留的中间文件（失败时保留，便于排查） */
  keptIntermediate?: string[]
}

/**
 * 把多条片段合成一条成片。
 *
 * @param clipIds 片段顺序（就是成片里的顺序）
 * @param title 成片文件名（会做安全清理）
 */
export async function composeMovie(
  clipIds: number[],
  title: string,
  onProgress: (p: ComposeProgress) => void,
  signal: AbortSignal
): Promise<ComposeResult> {
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    // 明确告知怎么做，而不是抛一句「ffmpeg not found」让用户自己猜
    return {
      ok: false,
      outputs: [],
      message: '未找到 ffmpeg：请在「设置 → 本地切片」里指定路径，或点「自动下载」'
    }
  }

  const all = db.listClips()
  const picked = clipIds
    .map((id) => all.find((c) => c.id === id))
    .filter((c): c is (typeof all)[number] => Boolean(c))
  if (picked.length < 2) {
    return { ok: false, outputs: [], message: '至少需要两条片段才能拼成成片' }
  }

  const settings = loadSettings()
  const outDir = settings.sliceOutputDir?.trim() || settings.outputDir
  mkdirSync(outDir, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}`

  /**
   * 中间产物放**独立子目录**。
   *
   * 为什么不直接放输出目录：那是用户看结果的地方，中间文件（每条片段各自的 mp4）
   * 和成片长得一模一样，堆在一起用户分不清哪些是想要的。
   * 放到 `.compose-<时间戳>/` 里，成功即删，失败保留方便排查。
   */
  const stageDir = join(outDir, `.compose-${stamp}`)
  mkdirSync(stageDir, { recursive: true })

  const tasks: SliceTaskInput[] = picked.map((c, i) => ({
    bvid: c.bvid,
    page: c.page || 1,
    start: c.start,
    end: c.end,
    // 中间文件名：用序号 + 片段名，失败时一眼能看出是哪一段
    note: `${stageDir}/${String(i + 1).padStart(2, '0')}-${safeKitName(c.name, `片段${i + 1}`)}`,
    // 跨分P 的片段要把它自己的段带上，否则只会切到第一段
    segments:
      Array.isArray(c.segments) && c.segments.length > 1
        ? (c.segments as SliceSegmentInput[])
        : undefined,
    clipId: c.id
  }))

  onProgress({ phase: 'prepare', percent: 2, message: `准备切片 ${tasks.length} 条片段…` })

  let sliceOutputs: string[] = []
  try {
    const res = await runSliceTasks(tasks, (p) => {
      // 切片占总进度 80%，拼接占 20%
      const perClip = 80 / tasks.length
      const percent = Math.min(80, Math.round(p.index * perClip + (p.percent / 100) * perClip))
      onProgress({ phase: 'slice', percent, message: `切片 ${p.index + 1}/${p.total}：${p.note}` })
    }, signal)
    sliceOutputs = res.entries
      .filter((e) => e.status === 'ok' && e.output)
      .map((e) => e.output as string)

    if (res.failed || sliceOutputs.length !== tasks.length) {
      return {
        ok: false,
        outputs: sliceOutputs,
        keptIntermediate: sliceOutputs,
        message: `有 ${res.failed} 条片段切片失败，成片未生成。${
          res.messages.length ? `原因：${res.messages.join('；')}` : ''
        }`
      }
    }
    if (signal.aborted) {
      return { ok: false, outputs: sliceOutputs, keptIntermediate: sliceOutputs, message: '已取消' }
    }
  } catch (err) {
    return {
      ok: false,
      outputs: sliceOutputs,
      keptIntermediate: sliceOutputs,
      message: `切片失败：${(err as Error).message}`
    }
  }

  /* ------------------------------- 拼接成片 ------------------------------- */

  const output = join(outDir, `${safeKitName(title, '成片')}.mp4`)
  // 同名不覆盖：覆盖是唯一不可逆的操作
  const finalOutput = uniqueFile(output)

  onProgress({ phase: 'concat', percent: 85, message: `正在拼接 ${sliceOutputs.length} 段…` })

  /**
   * 先试 `-c copy`（秒级完成、无损）；失败再回退重编码。
   *
   * 为什么需要回退：`-c copy` 要求各段编码参数完全一致。
   * 同一稿件同分P 通常一致，但**跨视频/跨清晰度**拼时可能不一致
   * （分辨率、像素格式、帧率任一不同都会失败）。
   * 重编码慢得多，所以只在必要时才做 —— 而不是一开始就重编码。
   */
  try {
    await concatVideos(ffmpeg, sliceOutputs, finalOutput, { signal })
  } catch (err) {
    if (signal.aborted) {
      return { ok: false, outputs: sliceOutputs, keptIntermediate: sliceOutputs, message: '已取消' }
    }
    onProgress({
      phase: 'concat',
      percent: 90,
      message: '各段编码参数不一致，改为重编码拼接（会慢一些）…'
    })
    try {
      await concatVideos(ffmpeg, sliceOutputs, finalOutput, { signal, reencode: true })
    } catch (err2) {
      return {
        ok: false,
        outputs: sliceOutputs,
        keptIntermediate: sliceOutputs,
        message: `拼接失败：${(err as Error).message}；重编码后仍失败：${(err2 as Error).message}`
      }
    }
  }

  /* ------------------------------- 清理中间物 ------------------------------ */

  // 只在成功时删：失败了要把各段留着，用户才知道是哪一段有问题
  for (const file of sliceOutputs) rmSync(file, { force: true })
  rmSync(stageDir, { recursive: true, force: true })
  // 不再单独记一条「成片」历史：`runSliceTasks` 内部已经为每条片段记过切片历史，
  // 成片本身是这些片段的组合，再记一条只会让历史列表里出现重复信息。

  onProgress({ phase: 'done', percent: 100, message: `成片已生成：${finalOutput}` })
  return { ok: true, output: finalOutput, outputs: sliceOutputs }
}

/** 目标文件已存在时加 `-2`/`-3` 后缀，绝不覆盖 */
function uniqueFile(path: string): string {
  if (!existsSync(path)) return path
  const dot = path.lastIndexOf('.')
  const stem = dot >= 0 ? path.slice(0, dot) : path
  const ext = dot >= 0 ? path.slice(dot) : ''
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}
