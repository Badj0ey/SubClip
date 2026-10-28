/**
 * 业务服务层：不依赖 ipcMain，便于单元 / 冒烟测试。
 * IPC 层只做参数透传与错误包装。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type {
  BiliVideoInfo,
  Cue,
  MergedCue,
  OpResult,
  PullProgressInfo,
  SubtitleDoc,
  VideoItem
} from '@shared/types'
import type { BridgePageInfo, BridgeSubtitle } from '@shared/bridge'
import * as bili from './bilibili'
import * as db from './db'
import { biliSubtitleToCues, decodeBuffer, parseSrt } from './srt'
import { defaultNote, writeCsv, writeXlsx, type SliceRow } from './exporter'
import { loadSettings } from './settings'

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 从文件名粗略推断分P号，如 `xxx P2.srt` / `xxx_2.srt` */
export function guessPage(filename: string): number {
  const stem = basename(filename, extname(filename))
  const m = /[Pp]\s*(\d{1,3})\b/.exec(stem) || /[_\-](\d{1,3})$/.exec(stem)
  return m ? Number(m[1]) : 1
}

export interface PersistVideoResult {
  videoId: number
  info: BiliVideoInfo
}

/** 把已拿到的视频信息落库（含 UP主 / 合集归属），返回 videoId */
function persistVideoInfo(info: BiliVideoInfo): number {
  const uploaderId = db.upsertUploader(info.ownerUid || null, info.ownerName, info.ownerAvatar)
  const collectionId = info.seasonId
    ? db.upsertCollection(
        uploaderId,
        String(info.seasonId),
        info.seasonTitle ?? '合集',
        `https://space.bilibili.com/${info.ownerUid}/lists/${info.seasonId}`
      )
    : db.upsertCollection(uploaderId, null, '单视频')

  const videoId = db.upsertVideo(collectionId, info.bvid, info.title, {
    url: `https://www.bilibili.com/video/${info.bvid}`,
    cover: info.cover,
    duration: info.duration,
    pageCount: info.pages.length
  })

  // 第三阶段：记录**内容署名**（与 UP主 分开）。
  // 现在 B站 接口只稳定给出 owner 一个人，将来接口给出 staff 时这里直接接上，
  // 不需要再改表 —— 这也是把作者做成独立表而不是 videos 里一个字段的原因。
  try {
    db.setVideoCreators(videoId, [
      { name: info.ownerName, mid: info.ownerUid || null }
    ])
  } catch {
    /* 署名失败不该影响视频入库 */
  }

  return videoId
}

/**
 * 拿到某个 BV 号对应的视频条目；本地还没有时，按**真实** UP主 / 合集 信息建库。
 *
 * 这是「插件推送也能一次归对位置」的关键：插件推来一条本地还没见过的 BV 号时，
 * 桌面端先自己查一次视频信息拿到真实 UID，字幕就直接落进正确的
 * `UP主 → 合集 → 视频` 下，而不是先在树里建一个临时分组。
 * 查不到（未登录 / 断网 / 接口异常）时返回 null，由调用方决定怎么兜底。
 */
async function resolveVideoByBvid(bvid: string): Promise<{ videoId: number; created: boolean } | null> {
  const existing = db.findVideoByBvid(bvid)
  if (existing) return { videoId: existing.id, created: false }
  try {
    const info = await bili.getVideoInfo(bvid, loadSettings().biliCookie)
    return { videoId: persistVideoInfo(info), created: true }
  } catch {
    return null
  }
}

/** 从插件上报的信息里取 UP主 UID（兼容旧插件发来的 `mid` 字段） */
function readUploaderUid(uploader: BridgePageInfo['uploader'] | undefined): number | null {
  if (!uploader) return null
  const legacy = uploader as { uid?: number | null; mid?: number | null }
  const value = legacy.uid ?? legacy.mid ?? null
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

/** 拉取 B 站视频信息并落库（含 UP主 / 合集归属） */
export async function persistVideo(input: string): Promise<PersistVideoResult> {
  const bvid = bili.extractBvid(input)
  if (!bvid) throw new Error('没有识别到 BV 号（应为 BV 开头 + 10 位字符）')
  const info = await bili.getVideoInfo(bvid, loadSettings().biliCookie)
  return { videoId: persistVideoInfo(info), info }
}

/** 解析任意 B 站链接（视频 / 合集 / 系列 / 收藏夹 / 投稿页 / 短链） */
export async function resolveTarget(input: string): Promise<bili.ResolvedTarget> {
  const cookie = loadSettings().biliCookie
  return bili.resolveTarget(input, cookie, bili.DEFAULT_TARGET_MAX_PAGES)
}

export type PullProgress = PullProgressInfo

/** 判断某个视频是否已经导入过字幕（任意分P） */
export function hasSubtitles(bvid: string): boolean {
  const video = db.findVideoByBvid(bvid)
  if (!video) return false
  return db.listDocsByVideo(video.id).length > 0
}

/**
 * 该视频本地已经有哪些字幕轨（key = `${page}:${lang}`）。
 *
 * 早期版本只记「已经有哪些分P」，于是某个分P 只要有任意一条字幕，
 * 这个分P 的其它语言（比如先有 AI 字幕、后补人工字幕）就永远拉不到了。
 * 改成按「分P + 语言」判断，才既不会重复又能补齐缺失语言。
 */
function importedTracks(bvid: string): Set<string> {
  const video = db.findVideoByBvid(bvid)
  if (!video) return new Set()
  return new Set(db.listDocsByVideo(video.id)
    .filter((d) => db.docHasCues(d.id))
    .map((d) => `${d.page}:${d.lang}`))
}

export interface PullResult {
  docs: number
  updated: number
  videos: number
  failed: number
  skipped: number
  messages: string[]
  /** 桌面端没拿到字幕的分P，由浏览器脚本利用页面登录态补抓。 */
  retryPages: Array<{ bvid: string; page: number; cid: number | null }>
  /** 连分P信息也拿不到的 BV 号，浏览器侧需要重新枚举全部分P。 */
  retryAll: string[]
}

/**
 * 批量拉取字幕：视频信息 → 全部分P → 字幕轨 → 下载 → 入库。
 * 网络请求不能包在 SQLite 的异步事务中，否则插件同时推送时会插入同一事务，
 * 还可能导致长时间写锁。每条字幕入库使用 upsertDoc 自身的短事务。
 */
export async function pullSubtitles(
  videos: Array<{ bvid: string; title: string }>,
  onProgress: (p: PullProgress) => void
): Promise<PullResult> {
  const cookie = loadSettings().biliCookie
  let docs = 0
  let updated = 0
  let okVideos = 0
  let failed = 0
  let skipped = 0
  const messages: string[] = []
  const retryPages: PullResult['retryPages'] = []
  const retryAll: string[] = []

  for (let i = 0; i < videos.length; i++) {
    const item = videos[i]
    const label = item.title || item.bvid
    onProgress({ current: i + 1, total: videos.length, title: label, status: 'running' })

    try {
      const info = await bili.getVideoInfo(item.bvid, cookie)
      const videoId = persistVideoInfo(info)
      const done = importedTracks(item.bvid)
      let got = 0
      let hadMissing = false

      if (!info.pages.length) {
        retryAll.push(item.bvid)
        hadMissing = true
      }

      for (const p of info.pages) {
        if (!p.cid) {
          retryPages.push({ bvid: item.bvid, page: p.page, cid: null })
          hadMissing = true
          continue
        }

        let tracks: Array<{ lang: string; label: string; url: string }>
        try {
          tracks = await bili.getSubtitleTracks(item.bvid, p.cid, cookie, info.aid)
        } catch (err) {
          retryPages.push({ bvid: item.bvid, page: p.page, cid: p.cid })
          hadMissing = true
          messages.push(`${label} P${p.page}：${(err as Error).message}`)
          continue
        }

        if (!tracks.length) {
          // 可能真没有字幕，也可能桌面端未携带页面登录态，交给浏览器确认。
          retryPages.push({ bvid: item.bvid, page: p.page, cid: p.cid })
          hadMissing = true
          continue
        }

        let pageFailed = false
        for (const track of tracks) {
          const lang = track.lang || 'unknown'
          if (done.has(`${p.page}:${lang}`)) continue
          try {
            const json = await bili.fetchSubtitleJson(track.url, item.bvid, cookie)
            const cues = biliSubtitleToCues(json)
            if (!cues.length) throw new Error('字幕文件没有有效正文')
            const res = db.upsertDoc(
              videoId, p.page, lang, track.label || lang,
              `${item.bvid}_P${p.page}_${lang}.srt`, 'bilibili', cues
            )
            if (res.created) docs++
            else updated++
            done.add(`${p.page}:${lang}`)
            got++
          } catch (err) {
            pageFailed = true
            messages.push(`${label} P${p.page} ${track.label || lang}：${(err as Error).message}`)
          }
        }
        if (pageFailed) {
          retryPages.push({ bvid: item.bvid, page: p.page, cid: p.cid })
          hadMissing = true
        }
      }

      if (got) {
        okVideos++
      } else if (!hadMissing && done.size) {
        skipped++
        messages.push(`${label}：本地已有全部可用字幕轨`)
        onProgress({ current: i + 1, total: videos.length, title: label,
          status: 'skipped', message: '已存在' })
      } else {
        failed++
        messages.push(`${label}：桌面端未取得新字幕${hadMissing ? '，可由浏览器补抓' : ''}`)
      }
    } catch (err) {
      failed++
      retryAll.push(item.bvid)
      messages.push(`${label}：${(err as Error).message}`)
    }
  }

  onProgress({ current: videos.length, total: videos.length, title: '', status: 'done' })
  return { docs, updated, videos: okVideos, failed, skipped, messages, retryPages, retryAll }
}

export interface ImportSrtResult {
  /** 新建的字幕文档数 */
  imported: number
  /** 覆盖更新（同一文件/同一分P 重新导入）的文档数 */
  updated: number
  failures: string[]
  /** 格式 / 解析类提示 */
  warnings: string[]
  /** 归类说明（例如从文件名识别到了 BV 号、归入了本地导入） */
  notes: string[]
}

/** 本地导入统一挂在哪个合集下 */
const LOCAL_COLLECTION_NAME = '本地文件'

/**
 * 导入本地 SRT 文件。
 *
 * 归类优先级：
 *   1. 用户填了 BV 号 → 拉取视频信息，归到**真实 UP主 / 合集**下
 *   2. 文件名里带 BV 号 → 同上（并在结果里说明）
 *   3. 都没有 → 落到「本地导入 / 本地文件」
 * 也就是说，只要拿得到 UID，本地文件和插件推送、桌面端拉取都会进同一个 UP主 分组。
 */
export async function importLocalSrt(paths: string[], bvid?: string): Promise<ImportSrtResult> {
  const failures: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  let imported = 0
  let updated = 0

  const explicit = (bvid ?? '').trim()
  let targetVideoId: number | null = null

  if (explicit) {
    try {
      targetVideoId = (await persistVideo(explicit)).videoId
    } catch (err) {
      warnings.push(`BV号信息获取失败，将作为本地文件导入：${(err as Error).message}`)
    }
  }

  // 文件读取与 B站查询都在事务外进行，避免长时间占用 SQLite 写事务。
  for (const path of paths) {
    try {
      const buf = await readFile(path)
      const { text, encoding } = decodeBuffer(buf as Buffer)
      const parsed = parseSrt(text)
      if (!parsed.cues.length) {
        failures.push(`${basename(path)}：没有解析出任何字幕`)
        continue
      }
      warnings.push(...parsed.warnings.slice(0, 3).map((w) => `${basename(path)}：${w}`))

      const fileTitle = basename(path, extname(path))
      let videoId = targetVideoId
      let page = guessPage(path)

      // 没填 BV 号时，看看文件名里有没有，让本地文件也能归到真实 UP主 下
      if (!videoId && !explicit) {
        const guessed = bili.extractBvid(fileTitle)
        if (guessed) {
          try {
            videoId = (await persistVideo(guessed)).videoId
            notes.push(`${basename(path)}：已从文件名识别到 ${guessed}，归入该视频`)
          } catch {
            /* 识别失败就仍然按本地文件处理 */
          }
        }
      }

      // 每个文件的分组与字幕写入保持原子性，但不在事务内等待网络/磁盘 IO。
      const res = db.transaction(() => {
        if (!videoId) {
          const uploaderId = db.upsertUploader(null, db.LOCAL_UPLOADER_NAME)
          const collectionId = db.upsertCollection(uploaderId, null, LOCAL_COLLECTION_NAME)
          videoId = db.findLocalVideo(fileTitle)?.id ?? db.upsertVideo(collectionId, '', fileTitle, {})
          page = 1
        }
        return db.upsertDoc(
          videoId, page, 'local', `${encoding} · ${basename(path)}`,
          basename(path), 'local', parsed.cues
        )
      })
      if (res.created) imported++
      else updated++
    } catch (err) {
      failures.push(`${basename(path)}：${(err as Error).message}`)
    }
  }

  return { imported, updated, failures, warnings, notes }
}

/** 拉取并保存某条 B站字幕轨 */
export async function importBiliTrack(
  videoId: number,
  page: number,
  track: { lang: string; label: string; url: string }
): Promise<OpResult<{ docId: number; count: number; created: boolean }>> {
  const video = db.getVideo(videoId)
  if (!video?.bvid) return { ok: false, message: '该条目没有 BV 号' }
  try {
    const cookie = loadSettings().biliCookie
    const json = await bili.fetchSubtitleJson(track.url, video.bvid, cookie)
    const cues = biliSubtitleToCues(json)
    if (!cues.length) return { ok: false, message: '字幕内容为空' }
    const res = db.upsertDoc(
      videoId,
      page,
      track.lang,
      track.label || track.lang,
      `${video.bvid}_P${page}_${track.lang}.srt`,
      'bilibili',
      cues
    )
    return { ok: true, data: { docId: res.docId, count: cues.length, created: res.created } }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** 查询某个视频某个分P 的字幕轨 */
export async function listBiliTracks(
  videoId: number,
  page: number
): Promise<OpResult<{ tracks: Array<{ lang: string; label: string; url: string }>; cid?: number }>> {
  const video = db.getVideo(videoId)
  if (!video?.bvid) return { ok: false, message: '该条目没有 BV 号' }
  try {
    const cookie = loadSettings().biliCookie
    const info = await bili.getVideoInfo(video.bvid, cookie)
    const target = info.pages.find((p) => p.page === page) ?? info.pages[0]
    if (!target) return { ok: false, message: '没有找到该分P' }
    const tracks = await bili.getSubtitleTracks(video.bvid, target.cid, cookie, info.aid)
    return { ok: true, data: { tracks, cid: target.cid } }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/* ------------------------------ 浏览器插件推送 ------------------------------ */

export interface IngestPageResult {
  /** 落库后的视频 id；页面本身没有具体视频（合集页 / 收藏夹 / 投稿页）时为 null */
  videoId: number | null
  /** 没有落库时的说明，界面直接展示 */
  message?: string
}

/**
 * 接收插件识别到的页面信息并落库。
 *
 * 和桌面端直接拉取共用同一套层级与同一套 UP主 身份（UID）：
 * 同一个 UP主 不管是插件推送还是桌面端拉取，都会进同一个分组。
 * 页面没有具体视频时（合集页 / 收藏夹 / 投稿页）不再建空条目——早期版本会因此
 * 产出一堆 bvid 为空的垃圾视频。
 */
export function ingestPageInfo(info: BridgePageInfo): IngestPageResult {
  const bvid = String(info?.bvid ?? '').trim()
  if (!bvid) {
    return { videoId: null, message: '该页面没有具体视频（合集 / 系列 / 收藏夹 / 投稿页），无需同步' }
  }

  const uid = readUploaderUid(info.uploader)
  const name = info.uploader?.name?.trim() || (uid ? `UID ${uid}` : '未知 UP主')
  const uploaderId = db.upsertUploader(uid, name, info.uploader?.avatar ?? undefined)

  const collectionId = info.seasonId
    ? db.upsertCollection(
        uploaderId,
        String(info.seasonId),
        info.seasonTitle?.trim() || '合集',
        uid ? `https://space.bilibili.com/${uid}/lists/${info.seasonId}` : undefined
      )
    : db.upsertCollection(uploaderId, null, '单视频')

  const videoId = db.upsertVideo(collectionId, bvid, info.title || bvid, {
    url: info.url || `https://www.bilibili.com/video/${bvid}`
  })
  return { videoId }
}

export interface IngestSubtitleResult {
  docId: number
  count: number
  /** true = 新建字幕文档；false = 覆盖了同语言已有的文档 */
  created: boolean
  /** 没能查到真实视频信息，暂时挂在「未关联」下（补上页面信息后会自动归位） */
  unlinked: boolean
  /** 归位后的视频标题，便于界面提示 */
  title: string
}

/**
 * 接收插件抓取到的字幕并入库。
 *
 * 归类流程：
 *   1. 本地已有该 BV 号 → 直接用（不再发请求）
 *   2. 本地没有 → 先查一次 B站视频信息，拿到真实 UID / 合集，直接归到正确分组
 *   3. 查询失败（未登录 / 断网 / 接口异常）→ 暂时挂到「未关联 / 来自浏览器插件」，
 *      等之后同步到页面信息时视频会自动归位，空掉的占位分组会被清理
 *
 * 没有 BV 号的推送直接丢弃：早期版本会为此建一个 bvid 为空的条目，
 * 之后所有没有 BV 号的推送都会挤进那同一个垃圾条目里。
 */
export async function ingestSubtitle(sub: BridgeSubtitle): Promise<IngestSubtitleResult | null> {
  const bvid = String(sub?.bvid ?? '').trim()
  if (!bvid || !bili.extractBvid(bvid)) return null

  const cues: Cue[] = (sub.cues ?? [])
    .filter((c) => String(c?.content ?? '').trim())
    .map((c, i) => ({
      index: i + 1,
      start: Number(c.from) || 0,
      end: Number(c.to) || Number(c.from) || 0,
      text: String(c.content).trim()
    }))
  if (!cues.length) return null

  let unlinked = false
  let resolved = await resolveVideoByBvid(bvid)
  if (!resolved) {
    unlinked = true
    const uploaderId = db.upsertUploader(null, db.UNKNOWN_UPLOADER_NAME)
    const collectionId = db.upsertCollection(uploaderId, null, '来自浏览器插件')
    const videoId = db.upsertVideo(collectionId, bvid, bvid, {
      url: `https://www.bilibili.com/video/${bvid}`
    })
    resolved = { videoId, created: true }
  }

  const page = Number(sub.page) || 1
  const lang = String(sub.lang || 'unknown')
  const res = db.upsertDoc(
    resolved.videoId,
    page,
    lang,
    sub.label || lang,
    `${bvid}_P${page}_${lang}.srt`,
    'bilibili',
    cues
  )

  return {
    docId: res.docId,
    count: cues.length,
    created: res.created,
    unlinked,
    title: db.getVideo(resolved.videoId)?.title || bvid
  }
}

/** 合并阅读时返回给渲染进程的数据 */
export interface MergedDocPayload {
  /** 当前打开的那份文档 */
  doc: SubtitleDoc
  video: (VideoItem & { uploaderName?: string }) | null
  /** 实际参与合并的文档（每个分P 一份） */
  docs: SubtitleDoc[]
  /** 首尾相接、全局重新编号后的字幕 */
  cues: MergedCue[]
}

/**
 * 合并加载：把同一视频的所有分P 字幕首尾相接成一个连续列表，便于连续阅读与跨P 切片。
 *
 * 同一分P 可能存在多条语言轨，这里**每个分P 只取一条**，否则读起来同一段会出现两遍。
 * 取哪一条：优先与当前打开文档同语言的那条，该分P 没有这个语言时退回它的第一条。
 * 其它语言仍然可以在资源树里单独点开。
 */
export function loadMergedDoc(docId: number): MergedDocPayload | null {
  const doc = db.getDoc(docId)
  if (!doc) return null
  const video = db.getVideo(doc.videoId)

  const byPage = new Map<number, SubtitleDoc[]>()
  for (const d of db.listDocsByVideo(doc.videoId)) {
    const list = byPage.get(d.page)
    if (list) list.push(d)
    else byPage.set(d.page, [d])
  }

  const picked: SubtitleDoc[] = []
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(page) ?? []
    picked.push(list.find((d) => d.lang === doc.lang) ?? list[0])
  }

  const cues: MergedCue[] = []
  let seq = 0
  for (const d of picked) {
    for (const c of db.loadCues(d.id)) {
      cues.push({
        index: ++seq,
        start: c.start,
        end: c.end,
        text: c.text,
        docId: d.id,
        page: d.page,
        origIndex: c.index
      })
    }
  }

  return { doc, video, docs: picked, cues }
}

/** 导出切片表（CSV / XLSX） */
export async function exportSlice(
  rows: SliceRow[],
  format: 'csv' | 'xlsx',
  outPath?: string
): Promise<OpResult<{ path: string }>> {
  try {
    let target = outPath
    if (!target) {
      const settings = loadSettings()
      const dir = settings.outputDir || settings.sliceOutputDir
      if (!dir) {
        return { ok: false, message: '请先在「设置 → 路径设置」里指定切片表输出目录' }
      }
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      target = join(dir, `切片表_${stamp()}.${format}`)
    }
    const normalized = rows.map((r) => ({ ...r, note: defaultNote(r) }))
    if (format === 'xlsx') writeXlsx(target, normalized)
    else writeCsv(target, normalized)
    return { ok: true, data: { path: target } }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
