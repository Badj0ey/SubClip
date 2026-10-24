/**
 * 发布素材包的装配（第九阶段）。
 *
 * 从数据库取「片段 + 字幕」，拼成 `@shared/publishKit` 需要的输入，
 * 再生成文件清单。真正的排版/渲染逻辑都在 `@shared/publishKit`（纯函数、可单测），
 * 这里只负责**取数据**与**决定取哪些片段**。
 */
import { existsSync } from 'node:fs'
import * as db from './db'
import { buildPublishKit, type KitClip } from '@shared/publishKit'

export interface PublishKitData {
  folder: string
  files: Array<{ path: string; content: string }>
  /** 片段条数与总时长，界面显示用 */
  clipCount: number
  totalDuration: number
  /** 取不到字幕的片段序号（界面要提示用户这些没有字幕稿） */
  missingSubtitle: number[]
}

/**
 * 取某个片段覆盖的字幕文本。
 *
 * 用**重叠**判定（与 `subtitle.selectRange` 一致）：片段边界几乎不可能和字幕行精确对齐，
 * 用包含判定会「明明有字幕却取不到」。
 */
function cueTextFor(docId: number, start: number, end: number, maxChars = 4000): string {
  const cues = db.loadCues(docId)
  const lines: string[] = []
  let total = 0
  for (const c of cues) {
    if (c.end < start || c.start > end) continue
    const text = c.text.trim()
    if (!text) continue
    // 一个片段最多带上限字数：素材包是给人读的，不是做全文字幕归档
    if (total + text.length > maxChars) break
    lines.push(text)
    total += text.length
  }
  return lines.join('\n')
}

/** 组装素材包数据（不落盘） */
export function buildKitData(input: {
  title: string
  description: string
  tags: string[]
  clipIds?: number[]
}): PublishKitData {
  const all = db.listClips()
  // 用户指定了顺序就按它来；没指定就用片段库当前顺序
  const picked = input.clipIds?.length
    ? input.clipIds
        .map((id) => all.find((c) => c.id === id))
        .filter((c): c is (typeof all)[number] => Boolean(c))
    : all

  const missingSubtitle: number[] = []
  const clips: KitClip[] = picked.map((c, i) => {
    const text = cueTextFor(c.docId, c.start, c.end)
    if (!text.trim()) missingSubtitle.push(i + 1)
    // 片段只记 docId，视频信息要经文档查（ClipTask 上没有 videoId 字段）
    const doc = db.getDoc(c.docId)
    const video = doc ? db.getVideo(doc.videoId) : null
    return {
      order: i + 1,
      name: c.name,
      bvid: c.bvid || video?.bvid || '',
      page: c.page || 1,
      start: c.start,
      end: c.end,
      videoTitle: video?.title ?? '',
      note: c.note ?? '',
      subtitle: text
    }
  })

  const totalDuration = clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
  const built = buildPublishKit({
    title: input.title,
    description: input.description,
    tags: input.tags ?? [],
    totalDuration,
    clips,
    generatedAt: Date.now(),
    source: sourceLine(clips)
  })

  return {
    folder: built.folder,
    files: built.files,
    clipCount: clips.length,
    totalDuration,
    missingSubtitle
  }
}

/** 「来源」一行：UP主与 BV 号去重后拼起来（多来源时用「等 N 个视频」概括） */
function sourceLine(clips: KitClip[]): string {
  const bvids = [...new Set(clips.map((c) => c.bvid).filter(Boolean))]
  const titles = [...new Set(clips.map((c) => c.videoTitle).filter(Boolean))]
  if (!titles.length) return ''
  if (titles.length === 1) return `${titles[0]}（${bvids[0] ?? ''}）`
  return `${titles[0]} 等 ${titles.length} 个视频`
}

/**
 * 目标目录不存在时直接用，存在则加 `-2`/`-3` 后缀。
 *
 * **不覆盖**已有的导出：覆盖是唯一不可逆的操作，
 * 而多留几份的代价只是用户自己删一下。
 */
export function uniqueDir(base: string): string {
  if (!existsSync(base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
