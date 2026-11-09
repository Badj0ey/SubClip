/**
 * 切片任务编排。
 *
 * 单个任务的流程：
 *   1. 拿视频信息（cid）与 DASH 播放地址
 *   2. 下载 SIDX 索引 → 算出目标时间对应的字节区间 → 只下载这一段
 *   3. ffmpeg 裁剪音视频并封装 mp4
 *
 * 跨分P：一个任务可包含多段（segments）。各段分别裁剪成临时 mp4，
 * 再用 concat 拼成一个视频 —— 这样「Pn 末尾 + Pn+1 开头」能合成一个连续片段。
 *
 * 任务之间串行（ffmpeg 同一时刻只跑一个），任务内部的字节区间可并发下载。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { qualityLabel } from '@shared/constants'
import type { BiliVideoInfo } from '@shared/types'
import * as bili from '../bilibili'
import { loadSettings } from '../settings'
import { buildAss, type BurnCue } from './ass'
import { downloadRange, downloadRangesConcurrent } from './downloader'
import { sanitizeFileName } from './filename'
import { concatVideos, cutAndMux, resolveFfmpeg } from './ffmpeg'
import { getPlayInfo, type DashStream, type PlayInfo } from './playurl'
import { buildChunks, computeRange, parallelFactor, parseSidx, splitRange } from './sidx'

export interface SliceSegmentInput {
  page: number
  start: number
  end: number
}

export interface SliceTaskInput {
  bvid: string
  page: number
  start: number
  end: number
  note: string
  /** 跨分P：多段依次裁剪后拼接（单段时留空） */
  segments?: SliceSegmentInput[]
  /** 来源**片段**的 id（拆表后仅作追溯：片段可能已被删或改名） */
  clipId?: number
  /**
   * 来源**任务**的 id（3.7.0 起）。
   *
   * 有了它，一次切片就能把 `export_jobs` 里对应那条从 pending 推到 running → done/failed；
   * 没有它的话跑完只能补一条历史，队列里那条会永远停在「排队中」。
   */
  jobId?: number
  /**
   * 烧录字幕（可选）：与 segments 对齐的每组字幕，时间已平移为相对该段起点。
   * 只有设置里开了「字幕烧录」且该任务能取到字幕时才有值；
   * 拿不到字幕（导入的任务没有文档、区间内无字幕）时由 ipc 层留空，引擎负责提示。
   */
  subtitleSegments?: BurnCue[][]
}

export type SlicePhase = 'resolve' | 'download' | 'cut' | 'mux' | 'done' | 'error'

/**
 * 输出文件路径去重：目标已存在时加 `-2`/`-3` 后缀，绝不覆盖已有文件。
 * 与 publishKit.uniqueDir 同思路——覆盖是唯一不可逆的操作。
 */
function uniqueOutputPath(base: string): string {
  if (!existsSync(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > base.lastIndexOf('/') && dot > base.lastIndexOf('\\') ? base.slice(0, dot) : base
  const ext = stem === base ? '' : base.slice(dot)
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

export interface SliceProgress {
  index: number
  total: number
  note: string
  phase: SlicePhase
  /** 0~100 */
  percent: number
  message?: string
}

export interface SliceResult {
  ok: number
  failed: number
  outputs: string[]
  messages: string[]
  /**
   * 非致命提示（如「该任务没有字幕来源，未烧录」）。
   * 与 messages（错误）分开，前端用 info 级别展示。
   */
  warnings: string[]
  /** 逐条结果：切片历史靠它把输出文件对回具体任务 */
  entries: SliceEntryResult[]
}

export interface SliceEntryResult {
  /** 在传入任务数组里的下标 */
  index: number
  note: string
  status: 'ok' | 'error' | 'canceled'
  output?: string
  message?: string
}

/**
 * 尽力删除临时文件。
 * 取消切片时 ffmpeg 的子进程可能还没释放句柄，`rmSync` 会抛 EBUSY/EPERM；
 * 以前这个异常会往外冒，被当成「该任务切片失败」，还在输出目录里留下 .m4s 垃圾。
 */
function safeRemove(...paths: Array<string | null | undefined>): void {
  for (const p of paths) {
    if (!p) continue
    try {
      rmSync(p, { force: true })
    } catch {
      /* 句柄未释放时删不掉，忽略即可，不该让整个任务失败 */
    }
  }
}

/**
 * 实际画质低于设置值时的说明文案（不低于就是正常，返回 null）。
 *
 * 为什么需要这个：B 站 playurl **不会**因为权限不够而报错，它只是把
 * `dash.video` 里的高档位删掉（实测匿名 qn=80 只回 32/16，而 `data.quality`
 * 还照样写 64）。以前这里拿到什么就用什么，用户在设置里选 1080P、导出却是
 * 480P，看不到任何提示——480P 的反馈基本都是这么来的。
 *
 * 文案分三种原因，免得用户白折腾（去升级会员 / 去查稿子 / 去登录）：
 */
function downgradeText(play: PlayInfo): string | null {
  if (!play.quality || play.quality >= play.requested) return null
  const got = qualityLabel(play.quality)
  const want = qualityLabel(play.requested)
  // 稿件本身就没这一档，跟账号无关
  if (play.qualityCap && play.quality >= play.qualityCap) {
    return `该视频最高只有 ${got}（设置为 ${want}），已按 ${got} 切片`
  }
  // 720P 及以上说明登录态是有效的，差的是大会员档位
  if (play.quality >= 64) {
    return `实际只取到 ${got}（设置为 ${want}）：更高档位需要大会员，或该分P没有这一档`
  }
  return `实际只取到 ${got}（设置为 ${want}）：B 站未登录时最高只给 480P，请到「设置 → B站账号」登录，或点用户脚本浮框里的「同步登录状态」后重试`
}

/** 成功任务的补充说明：只在实际降级时写，正常画质不刷屏 */
function qualityNote(actual: number, requested: number): string | undefined {
  if (!actual || actual >= requested) return undefined
  return `实际画质 ${qualityLabel(actual)}（设置为 ${qualityLabel(requested)}）`
}

/** 下载某个流在 [startSec, endSec] 内需要的字节，返回分片数据与裁剪参数 */
async function fetchSegment(
  stream: DashStream,
  startSec: number,
  endSec: number,
  isVideo: boolean,
  concurrency: number,
  signal: AbortSignal,
  onBytes?: (n: number) => void
): Promise<{ buffer: Buffer; ss: number; t: number }> {
  const [indexStart, indexEnd] = stream.indexRange.split('-').map((x) => Number(x))
  if (!Number.isFinite(indexStart) || !Number.isFinite(indexEnd)) {
    throw new Error(`无法解析 index_range：${stream.indexRange}`)
  }

  const head = await downloadRange(stream.url, 0, indexEnd, { signal })
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const sidx = parseSidx(view, indexStart)
  const chunks = buildChunks(sidx, indexEnd)
  if (!chunks.length) throw new Error('SIDX 里没有分片信息')

  const range = computeRange(chunks, startSec, endSec, isVideo)
  const parts = splitRange(
    range.dataRange,
    parallelFactor(range.totalSize) * Math.max(1, concurrency)
  )
  const body = await downloadRangesConcurrent(stream.url, parts, concurrency, { signal, onBytes })

  return {
    buffer: Buffer.concat([head, body]),
    ss: Math.max(0, range.ffmpegSs),
    t: Math.max(0.05, range.ffmpegT)
  }
}

interface RunContext {
  ffmpeg: string
  cookie: string
  quality: number
  concurrency: number
  outDir: string
  signal: AbortSignal
  infoCache: Map<string, BiliVideoInfo>
  streamCache: Map<string, PlayInfo>
  /** 烧录配置（设置里关掉时整体不传，此字段为空） */
  subtitle?: {
    fontName: string
    /** 1080p 基准字号，按视频高度等比换算后写进 ASS */
    fontSize: number
    /** 导入字体目录（注册给 libass）；留空走系统字体 */
    fontsDir?: string
  }
  /** 拿到播放信息后回调（用于发现「设置 1080P、实际只有 480P」这类静默降级） */
  onQuality?: (play: PlayInfo) => void
  report: (phase: SlicePhase, percent: number) => void
}

/** 把某一段裁剪输出成 mp4（output 是该段的最终文件） */
async function sliceSegment(
  ctx: RunContext,
  bvid: string,
  segment: SliceSegmentInput,
  output: string,
  stamp: string,
  subtitles?: BurnCue[]
): Promise<number> {
  let info = ctx.infoCache.get(bvid)
  if (!info) {
    info = await bili.getVideoInfo(bvid, ctx.cookie)
    ctx.infoCache.set(bvid, info)
  }
  const pageInfo = info.pages.find((p) => p.page === segment.page) ?? info.pages[0]
  if (!pageInfo?.cid) throw new Error(`找不到第 ${segment.page} P 的 cid`)

  const cacheKey = `${bvid}:${pageInfo.cid}:${ctx.quality}`
  let play = ctx.streamCache.get(cacheKey)
  if (!play) {
    play = await getPlayInfo(bvid, pageInfo.cid, ctx.cookie, ctx.quality)
    ctx.streamCache.set(cacheKey, play)
  }
  // 缓存命中也回调一次：引擎按文案去重，同一批任务不会刷出几十条一样的提示
  ctx.onQuality?.(play)
  const videoStream = play.video[0]
  if (!videoStream) throw new Error('没有可用的视频流')
  const audioStream = play.audio[0] ?? null

  ctx.report('download', 12)

  const videoSeg = await fetchSegment(
    videoStream,
    segment.start,
    segment.end,
    true,
    ctx.concurrency,
    ctx.signal
  )
  let audioSeg: { buffer: Buffer; ss: number; t: number } | null = null
  if (audioStream) {
    ctx.report('download', 55)
    audioSeg = await fetchSegment(
      audioStream,
      segment.start,
      segment.end,
      false,
      ctx.concurrency,
      ctx.signal
    )
  }

  ctx.report('cut', 78)

  const videoFile = join(ctx.outDir, `.slice-src-${stamp}.m4s`)
  const audioFile = audioSeg ? join(ctx.outDir, `.slice-src-${stamp}.a.m4s`) : null
  writeFileSync(videoFile, videoSeg.buffer)
  if (audioFile && audioSeg) writeFileSync(audioFile, audioSeg.buffer)

  // 烧录字幕：字幕时间是相对本段起点的，直接写进 ASS，滤镜会按 PTS 对齐
  let assFile: string | null = null
  if (ctx.subtitle && subtitles?.length) {
    const height = info.height || 1080
    assFile = join(ctx.outDir, `.slice-sub-${stamp}.ass`)
    writeFileSync(
      assFile,
      buildAss(subtitles, {
        width: info.width || 1920,
        height,
        fontName: ctx.subtitle.fontName,
        fontSize: Math.max(16, Math.round(ctx.subtitle.fontSize * (height / 1080)))
      }),
      'utf8'
    )
  }

  try {
    await cutAndMux({
      ffmpeg: ctx.ffmpeg,
      videoFile,
      audioFile,
      vSs: videoSeg.ss,
      vT: videoSeg.t,
      aSs: audioSeg?.ss ?? 0,
      aT: audioSeg?.t ?? 0,
      audioCodec: audioStream?.codecs ?? '',
      output,
      assFile: assFile ?? undefined,
      fontsDir: ctx.subtitle?.fontsDir,
      signal: ctx.signal
    })
  } finally {
    safeRemove(videoFile, audioFile, assFile)
  }
  return play.quality
}

/** 执行一批切片任务 */
export async function runSliceTasks(
  tasks: SliceTaskInput[],
  onProgress: (p: SliceProgress) => void,
  signal: AbortSignal
): Promise<SliceResult> {
  const settings = loadSettings()
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error('未找到 ffmpeg，请先在「设置 → 本地切片」里指定路径或一键下载')
  }

  const outDir = settings.sliceOutputDir?.trim() || settings.outputDir
  mkdirSync(outDir, { recursive: true })

  const outputs: string[] = []
  const messages: string[] = []
  const warnings: string[] = []
  const entries: SliceEntryResult[] = []
  let ok = 0
  let failed = 0

  // 烧录字幕配置：设置关了就没有；导入字体文件丢了就退回系统字体并提示一次
  let subtitle: RunContext['subtitle']
  if (settings.sliceBurnSubtitles) {
    subtitle = {
      fontName: settings.sliceSubtitleFont || 'Microsoft YaHei',
      fontSize: Math.max(20, Math.min(120, settings.sliceSubtitleFontSize || 54))
    }
    const fontFile = settings.sliceSubtitleFontFile?.trim()
    if (fontFile) {
      const fontsDir = join(app.getPath('userData'), 'fonts')
      if (existsSync(join(fontsDir, fontFile))) {
        subtitle.fontName = settings.sliceSubtitleFontFamily || subtitle.fontName
        subtitle.fontsDir = fontsDir
      } else {
        warnings.push('导入的字幕字体文件不存在，已改用系统字体')
      }
    }
  }

  const baseCtx = {
    ffmpeg,
    quality: settings.sliceQuality || 80,
    concurrency: Math.max(1, Math.min(8, settings.sliceConcurrency || 3)),
    outDir,
    signal,
    infoCache: new Map<string, BiliVideoInfo>(),
    streamCache: new Map<string, PlayInfo>(),
    subtitle,
    /**
     * 降级提示按**文案**去重：一批 20 条任务都在 480P 时只提示一次，
     * 而不是每切完一条就弹一条一模一样的。
     */
    onQuality: (play: PlayInfo): void => {
      const text = downgradeText(play)
      if (text && !warnings.includes(text)) warnings.push(text)
    }
  }

  // 没有登录凭证时 B 站只下发 480P（2026-11-09 实测：匿名 dash 仅 32/16）。
  // 提前说一句，别等切完才让用户自己发现画质不对。设置本来就是 480P 及以下时不吵。
  if (!settings.biliCookie?.trim() && baseCtx.quality > 32) {
    warnings.push(
      '未检测到 B 站登录凭证：游客最高只能取到 480P。要切 720P 及以上，请到「设置 → B站账号」登录，或点用户脚本浮框里的「同步登录状态」'
    )
  }

  for (let i = 0; i < tasks.length; i++) {
    if (signal.aborted) break
    const task = tasks[i]
    const label = task.note || `${task.bvid} P${task.page} ${task.start}-${task.end}`

    const report = (phase: SlicePhase, percent: number): void => {
      onProgress({ index: i, total: tasks.length, note: label, phase, percent })
    }
    const ctx: RunContext = { ...baseCtx, cookie: loadSettings().biliCookie, report }

    // 组装要切的段：跨P 时会有多段
    const segments: SliceSegmentInput[] =
      task.segments && task.segments.length > 1
        ? task.segments
        : [{ page: task.page, start: task.start, end: task.end }]

    const stamp = `${i}-${process.pid}-${Date.now()}`

    // 烧录提示：开了烧录但拿不到字幕时，说明原因而不是静默跳过
    if (subtitle) {
      if (!task.subtitleSegments) {
        warnings.push(`《${label}》没有可用的字幕来源，未烧录字幕`)
      } else if (task.subtitleSegments.every((group) => !group.length)) {
        warnings.push(`《${label}》切片区间内没有字幕，未烧录`)
      }
    }

    try {
      report('resolve', 3)
      // 同名文件不覆盖：重跑同一条切片（或不同片段备注撞名）时加 -2/-3 后缀，
      // 覆盖用户已有的导出是最容易造成不可逆损失的操作（与 kit:export 的 uniqueDir 同理）。
      const output = uniqueOutputPath(join(outDir, `${sanitizeFileName(label)}.mp4`))

      // 实际拿到的画质：单段就是它，跨分P 取最低的那一段（拼接后整体按低的算）
      let pickedQuality = 0

      if (segments.length === 1) {
        pickedQuality = await sliceSegment(
          ctx,
          task.bvid,
          segments[0],
          output,
          stamp,
          task.subtitleSegments?.[0]
        )
      } else {
        // 跨分P：逐段裁到临时文件，再拼接
        const temps: string[] = []
        try {
          for (let s = 0; s < segments.length; s++) {
            report(
              'download',
              Math.round((s / segments.length) * 70)
            )
            const tmp = join(outDir, `.slice-part-${stamp}-${s}.mp4`)
            const q = await sliceSegment(
              ctx,
              task.bvid,
              segments[s],
              tmp,
              `${stamp}-${s}`,
              task.subtitleSegments?.[s]
            )
            pickedQuality = pickedQuality ? Math.min(pickedQuality, q) : q
            temps.push(tmp)
          }
          report('mux', 88)
          try {
            await concatVideos(ffmpeg, temps, output, { signal })
          } catch {
            // 各段编码参数不一致时 copy 会失败，回退到重编码
            await concatVideos(ffmpeg, temps, output, { signal, reencode: true })
          }
        } finally {
          safeRemove(...temps)
        }
      }

      ok++
      outputs.push(output)
      entries.push({
        index: i,
        note: label,
        status: 'ok',
        output,
        // 降级时把实际画质写进任务行，历史列表里能直接看出这条是 480P 还是 1080P
        message: qualityNote(pickedQuality, ctx.quality)
      })
      report('done', 100)
    } catch (err) {
      if ((err as Error).name === 'AbortError' || signal.aborted) {
        entries.push({ index: i, note: label, status: 'canceled' })
        break
      }
      failed++
      messages.push(`${label}：${(err as Error).message}`)
      entries.push({
        index: i,
        note: label,
        status: 'error',
        message: (err as Error).message
      })
      onProgress({
        index: i,
        total: tasks.length,
        note: label,
        phase: 'error',
        percent: 0,
        message: (err as Error).message
      })
    }
  }

  return { ok, failed, outputs, messages, warnings, entries }
}
