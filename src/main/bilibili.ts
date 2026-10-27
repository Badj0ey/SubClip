/**
 * B站接口封装（Electron 主进程版）。
 *
 * 逻辑参考 D:\bili_subtitle_extension_native_v1.2.8\native_host\bilibili_api.py，
 * 用 Node 原生 fetch 重写，去掉 Python 依赖：
 *   1. view / pagelist 拿视频信息与分P
 *   2. nav 拿 WBI 签名密钥
 *   3. player/wbi/v2 拿字幕轨列表
 *   4. 下载字幕 json 并转换成 Cue[]
 */
import { createHash } from 'node:crypto'
import type {
  BiliPageInfo,
  BiliSubtitleTrack,
  BiliTarget,
  BiliTargetKind,
  BiliTargetVideo,
  BiliVideoInfo
} from '@shared/types'

const API_NAV = 'https://api.bilibili.com/x/web-interface/nav'
const API_VIEW = 'https://api.bilibili.com/x/web-interface/view'
const API_PAGELIST = 'https://api.bilibili.com/x/player/pagelist'
const API_PLAYER_WBI_V2 = 'https://api.bilibili.com/x/player/wbi/v2'
const API_PLAYER_V2 = 'https://api.bilibili.com/x/player/v2'
const API_SEASON_ARCHIVES = 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list'
const API_SERIES_INFO = 'https://api.bilibili.com/x/series/series'
const API_SERIES_ARCHIVES = 'https://api.bilibili.com/x/series/archives'
const API_FAV_RESOURCES = 'https://api.bilibili.com/x/v3/fav/resource/list'
const API_FAV_INFO = 'https://api.bilibili.com/x/v3/fav/folder/info'
const API_SPACE_ARC = 'https://api.bilibili.com/x/space/wbi/arc/search'

/**
 * 单次请求超时。
 *
 * Node 的 fetch 没有内建超时（undici 默认要等好几分钟才断），而插件推送字幕时
 * 桌面端要同步等一次 `view` 接口的结果才能归对分组 —— 没有超时的话，
 * 网络卡住会让这次推送一直挂着、界面既不入库也不报错。
 */
const API_TIMEOUT_MS = 15_000
/** 字幕文件体积更大，给宽一点 */
const DOWNLOAD_TIMEOUT_MS = 30_000

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const BVID_RE = /BV[0-9A-Za-z]{10}/
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

export class BiliApiError extends Error {
  code: number | null
  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = 'BiliApiError'
    this.code = code
  }
}

/** 从任意文本中提取 BV 号 */
export function extractBvid(text: string): string | null {
  const m = BVID_RE.exec(text || '')
  return m ? m[0] : null
}

/** 解析合集链接里的 mid / season_id / 类型 */
export function parseCollectionUrl(url: string): {
  mid: number | null
  sid: number | null
  kind: 'season' | 'series' | null
} {
  try {
    const u = new URL(url)
    const midRaw = u.searchParams.get('mid')
    const sidRaw = u.searchParams.get('season_id') || u.searchParams.get('sid')
    const isSeries = u.pathname.includes('/seriesdetail')
    return {
      mid: midRaw ? Number(midRaw) : null,
      sid: sidRaw ? Number(sidRaw) : null,
      kind: isSeries ? 'series' : sidRaw ? 'season' : null
    }
  } catch {
    return { mid: null, sid: null, kind: null }
  }
}

let wbiCache: { key: string; ts: number } | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 带重试的 JSON 请求 */
export async function requestJson(
  url: string,
  params: Record<string, string | number | boolean | undefined>,
  cookie: string,
  retries = 3
): Promise<any> {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }

  let lastError: unknown = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        'User-Agent': UA
      }
      if (cookie) headers.Cookie = cookie

      const res = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
      if (res.status >= 500 || [408, 409, 425, 429].includes(res.status)) {
        throw new BiliApiError(`HTTP ${res.status}`)
      }
      if (!res.ok) throw new BiliApiError(`HTTP ${res.status}`)

      const data = (await res.json()) as any
      if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 0) {
        throw new BiliApiError(
          `接口返回 ${data.code}：${data.message || data.msg || '未知错误'}`,
          Number(data.code)
        )
      }
      return data
    } catch (err) {
      lastError = err
      // 账号权限、稿件不存在等确定性错误重试不会改变结果；只重试网络和限流。
      if (err instanceof BiliApiError &&
          ((err.code !== null && ![-352, -412, -509].includes(err.code)) ||
           /^HTTP 4\d\d/.test(err.message) && !/^HTTP (408|409|425|429)$/.test(err.message))) break
      if (attempt >= retries) break
      await sleep(Math.min(6000, 800 * 2 ** (attempt - 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new BiliApiError(String(lastError))
}

function buildMixinKey(raw: string): string {
  return MIXIN_KEY_ENC_TAB.filter((i) => i < raw.length)
    .map((i) => raw[i])
    .join('')
    .slice(0, 32)
}

export async function getWbiKey(cookie: string, force = false): Promise<string> {
  if (!force && wbiCache && Date.now() - wbiCache.ts < 30_000) return wbiCache.key
  const nav = await requestJson(API_NAV, {}, cookie)
  const imgUrl: string = nav?.data?.wbi_img?.img_url ?? ''
  const subUrl: string = nav?.data?.wbi_img?.sub_url ?? ''
  const stem = (u: string): string => {
    const path = u.split('?')[0]
    const file = path.split('/').pop() ?? ''
    return file.replace(/\.\w+$/, '')
  }
  const raw = stem(imgUrl) + stem(subUrl)
  if (raw.length < 32) throw new BiliApiError('无法获取 WBI 签名密钥（可能未登录或接口变更）')
  const key = buildMixinKey(raw)
  wbiCache = { key, ts: Date.now() }
  return key
}

export function signWbi(
  params: Record<string, string | number>,
  mixinKey: string
): Record<string, string> {
  const signed: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    signed[k] = String(v).replace(/[!'()*]/g, '')
  }
  signed.wts = String(Math.floor(Date.now() / 1000))

  const sorted = Object.keys(signed)
    .sort()
    .map((k) => [k, signed[k]] as [string, string])
  const query = new URLSearchParams(sorted).toString()
  signed.w_rid = createHash('md5').update(query + mixinKey).digest('hex')
  return signed
}

/** 获取视频基本信息（标题 / UP主 / 分P） */
export async function getVideoInfo(bvid: string, cookie = ''): Promise<BiliVideoInfo> {
  const res = await requestJson(API_VIEW, { bvid }, cookie)
  const d = res?.data
  if (!d || typeof d !== 'object') throw new BiliApiError('视频信息接口未返回有效数据')
  let pages: BiliPageInfo[] = (Array.isArray(d.pages) ? d.pages : []).map((p: any) => ({
    page: Number(p.page) || 1,
    cid: Number(p.cid),
    title: String(p.part || ''),
    duration: Number(p.duration) || 0
  }))
  if (!pages.length) {
    try {
      pages = await getPages(bvid, cookie)
    } catch {
      /* 某些视频限制了分P接口；交给浏览器侧按页面信息补抓 */
    }
  }

  const ugcSeason = d.ugc_season ?? null

  return {
    bvid,
    aid: Number(d.aid) || undefined,
    title: String(d.title || bvid),
    cover: String(d.pic || ''),
    duration: Number(d.duration) || 0,
    ownerUid: Number(d.owner?.mid) || 0,
    ownerName: String(d.owner?.name || '未知UP主'),
    ownerAvatar: String(d.owner?.face || ''),
    seasonId: ugcSeason?.id ? Number(ugcSeason.id) : null,
    seasonTitle: ugcSeason?.title ? String(ugcSeason.title) : null,
    pages,
    danmakuCount: Number(d.stat?.danmaku) || 0,
    desc: String(d.desc || '')
  }
}

/** 获取分P列表（view 里没有时兜底） */
export async function getPages(bvid: string, cookie = ''): Promise<BiliPageInfo[]> {
  const res = await requestJson(API_PAGELIST, { bvid }, cookie)
  return (Array.isArray(res?.data) ? res.data : []).map((p: any) => ({
    page: Number(p.page) || 1,
    cid: Number(p.cid),
    title: String(p.part || ''),
    duration: Number(p.duration) || 0
  }))
}

/** 获取某个分P 的字幕轨列表 */
export async function getSubtitleTracks(
  bvid: string,
  cid: number,
  cookie = '',
  aid?: number
): Promise<BiliSubtitleTrack[]> {
  const parseTracks = (data: any): BiliSubtitleTrack[] => {
    const lists = [data?.subtitle?.subtitles, data?.subtitle?.list, data?.subtitles]
    const found = new Map<string, BiliSubtitleTrack>()
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const s of list) {
        const url = String(s?.subtitle_url || s?.url || '').trim()
        if (!url) continue
        const lang = String(s?.lan || s?.lang || 'unknown')
        found.set(`${lang}:${url}`, {
          lang, label: String(s?.lan_doc || s?.label || lang), url
        })
      }
    }
    return [...found.values()]
  }

  const errors: string[] = []
  const query = async (name: string, url: string, params: Record<string, string | number>): Promise<BiliSubtitleTrack[]> => {
    try {
      const res = await requestJson(url, params, cookie, 2)
      return parseTracks(res?.data)
    } catch (err) {
      errors.push(`${name}：${(err as Error).message}`)
      return []
    }
  }

  // 首选 WBI，返回空列表也必须继续查 v2；空列表不代表接口调用失败。
  try {
    const key = await getWbiKey(cookie)
    const signed = signWbi({ bvid, cid, ...(aid ? { aid } : {}) }, key)
    const tracks = await query('wbi/v2', API_PLAYER_WBI_V2, signed)
    if (tracks.length) return tracks
    if (aid) {
      const byAid = await query('wbi/v2(aid)', API_PLAYER_WBI_V2, signWbi({ aid, cid }, key))
      if (byAid.length) return byAid
    }
  } catch (err) {
    errors.push(`WBI 签名：${(err as Error).message}`)
  }

  const plain = await query('player/v2', API_PLAYER_V2, { bvid, cid, ...(aid ? { aid } : {}) })
  if (plain.length) return plain
  if (aid) {
    const byAid = await query('player/v2(aid)', API_PLAYER_V2, { aid, cid })
    if (byAid.length) return byAid
  }
  if (errors.length) throw new BiliApiError(`字幕接口读取不完整：${errors.join('；')}`)
  return []
}

/** 下载字幕 json 原始内容 */
export async function fetchSubtitleJson(url: string, bvid: string, cookie = ''): Promise<any> {
  const full = url.startsWith('//') ? `https:${url}` : url
  const target = new URL(full)
  const host = target.hostname.toLowerCase()
  if (target.protocol !== 'https:' ||
      !['bilibili.com', 'hdslb.com', 'bilivideo.cn', 'bilivideo.com'].some((root) => host === root || host.endsWith(`.${root}`))) {
    throw new BiliApiError('字幕下载地址不是受信任的 B站 HTTPS 域名')
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    Referer: `https://www.bilibili.com/video/${bvid}/`,
    'User-Agent': UA
  }
  // CDN 不需要 SESSDATA，禁止把登录 Cookie 发送给非 bilibili.com 域名。
  if (cookie && (host === 'bilibili.com' || host.endsWith('.bilibili.com'))) headers.Cookie = cookie
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new BiliApiError(`字幕下载失败：HTTP ${res.status}`)
  const data = await res.json()
  if (!data || typeof data !== 'object' || !('body' in data)) {
    throw new BiliApiError('字幕资源缺少 body 字段')
  }
  return data
}

/* 合集视频列表见下方 getSeasonVideos（统一在「链接解析」一节） */

/* ---------------------------- 链接解析与资源列表 ---------------------------- */

export type TargetKind = BiliTargetKind
export type ResolvedVideo = BiliTargetVideo
export type ResolvedTarget = BiliTarget

const KIND_LABEL: Record<TargetKind, string> = {
  video: '单个视频',
  season: '合集',
  series: '系列',
  favlist: '收藏夹',
  space: 'UP主投稿'
}

export function kindLabel(kind: TargetKind): string {
  return KIND_LABEL[kind] ?? kind
}

/** "12:34" / "1:02:03" → 秒 */
function parseDurationText(text: string): number {
  if (!text) return 0
  const parts = String(text).split(':').map((p) => Number(p) || 0)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/** b23.tv 短链 → 真实地址 */
export async function resolveShortLink(input: string): Promise<string> {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return input
  }
  if (!/(^|\.)b23\.tv$/i.test(u.hostname)) return input
  try {
    const res = await fetch(u.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    return res.url || input
  } catch {
    return input
  }
}

/**
 * 去重后追加。
 *
 * 分页拉取期间合集 / 收藏夹可能被作者改动，导致同一个视频落在两页里；
 * 三个列表接口都走这里，避免「同一个视频出现两次」。
 */
function pushUnique(list: ResolvedVideo[], item: ResolvedVideo): void {
  if (!item.bvid) return
  if (list.some((v) => v.bvid === item.bvid)) return
  list.push(item)
}

/** 合集（season） */
async function getSeasonVideos(mid: number, seasonId: number, cookie: string, maxPages: number) {
  const videos: ResolvedVideo[] = []
  let title = `合集 ${seasonId}`
  let truncated = false

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const res = await requestJson(
      API_SEASON_ARCHIVES,
      { mid, season_id: seasonId, sort_reverse: 'false', page_num: pageNum, page_size: 30 },
      cookie
    )
    const data = res?.data ?? {}
    title = String(data.meta?.name || title)
    const archives = (data.archives ?? []) as any[]
    if (!archives.length) break
    for (const a of archives) {
      pushUnique(videos, {
        bvid: String(a.bvid || ''),
        title: String(a.title || ''),
        cover: String(a.pic || ''),
        duration: Number(a.duration) || 0
      })
    }
    const total = Number(data.page?.total) || 0
    if (total && videos.length >= total) break
    if (pageNum === maxPages) truncated = true
  }
  return { title, videos, truncated }
}

/** 系列（series） */
async function getSeriesVideos(mid: number, seriesId: number, cookie: string, maxPages: number) {
  const videos: ResolvedVideo[] = []
  let title = `系列 ${seriesId}`
  let truncated = false

  try {
    const info = await requestJson(API_SERIES_INFO, { series_id: seriesId }, cookie)
    const meta = info?.data?.meta ?? info?.data
    title = String(meta?.name || title)
  } catch {
    /* 标题拿不到不影响列表 */
  }

  for (let pn = 1; pn <= maxPages; pn++) {
    const res = await requestJson(
      API_SERIES_ARCHIVES,
      { mid, series_id: seriesId, only_normal: true, sort: 'desc', pn, ps: 30 },
      cookie
    )
    const archives = (res?.data?.archives ?? []) as any[]
    if (!archives.length) break
    for (const a of archives) {
      pushUnique(videos, {
        bvid: String(a.bvid || ''),
        title: String(a.title || ''),
        cover: String(a.pic || ''),
        duration: Number(a.duration) || 0
      })
    }
    const total = Number(res?.data?.page?.total) || 0
    if (total && videos.length >= total) break
    if (pn === maxPages) truncated = true
  }
  return { title, videos, truncated }
}

/** 收藏夹 */
async function getFavVideos(mediaId: number, cookie: string, maxPages: number) {
  const videos: ResolvedVideo[] = []
  let title = `收藏夹 ${mediaId}`
  let truncated = false

  try {
    const info = await requestJson(API_FAV_INFO, { media_id: mediaId }, cookie)
    title = String(info?.data?.title || title)
  } catch {
    /* 私有收藏夹可能拿不到标题 */
  }

  for (let pn = 1; pn <= maxPages; pn++) {
    const res = await requestJson(
      API_FAV_RESOURCES,
      { media_id: mediaId, pn, ps: 20, platform: 'web' },
      cookie
    )
    const medias = (res?.data?.medias ?? []) as any[]
    if (!medias.length) break
    for (const m of medias) {
      // type 2 = 视频稿件；收藏夹里还可能混有音频 / 专栏等，跳过
      if (m.type != null && Number(m.type) !== 2) continue
      pushUnique(videos, {
        bvid: String(m.bvid || ''),
        title: String(m.title || ''),
        cover: String(m.cover || ''),
        duration: Number(m.duration) || 0
      })
    }
    if (!res?.data?.has_more) break
    if (pn === maxPages) truncated = true
  }
  return { title, videos, truncated }
}

/** UP主投稿（需要 WBI 签名） */
async function getSpaceVideos(mid: number, cookie: string, maxPages: number) {
  const videos: ResolvedVideo[] = []
  let title = `UP主 ${mid} 的投稿`
  let truncated = false

  try {
    const card = await requestJson(
      'https://api.bilibili.com/x/web-interface/card',
      { mid, photo: false },
      cookie
    )
    title = `${String(card?.data?.card?.name || mid)} 的投稿`
  } catch {
    /* ignore */
  }

  const mixinKey = await getWbiKey(cookie)
  for (let pn = 1; pn <= maxPages; pn++) {
    const signed = signWbi({ mid, pn, ps: 30, order: 'pubdate', tid: 0 }, mixinKey)
    const res = await requestJson(API_SPACE_ARC, signed, cookie)
    const vlist = (res?.data?.list?.vlist ?? []) as any[]
    if (!vlist.length) break
    for (const v of vlist) {
      pushUnique(videos, {
        bvid: String(v.bvid || ''),
        title: String(v.title || ''),
        cover: String(v.pic || ''),
        duration: parseDurationText(String(v.length || ''))
      })
    }
    const count = Number(res?.data?.page?.count) || 0
    if (count && videos.length >= count) break
    if (pn === maxPages) truncated = true
  }
  return { title, videos, truncated }
}

/**
 * 链接要拉的是什么。
 *
 * 抽成纯函数是为了能单测：URL 形态（尤其 `?type=series` 与 `favlist?fid=`）一旦改错，
 * 表现是「解析出来是空的或拉错东西」，很难从报错里看出来。
 */
export type TargetRef =
  | { kind: 'video'; bvid: string }
  | { kind: 'season'; mid: number; sid: number }
  | { kind: 'series'; mid: number; sid: number }
  | { kind: 'favlist'; mid: number; sid: number }
  | { kind: 'space'; mid: number }

/**
 * 把 B 站链接分类。不认识返回 null。
 *
 * 支持的形态：
 *   - 视频页      /video/BVxxx
 *   - 合集播放页  /list/{mid}?sid=xxx
 *   - 空间合集/系列 /{mid}/lists/{sid}（`?type=series` 时为系列）
 *   - 收藏夹      /{mid}/favlist?fid=xxx
 *   - 投稿页      /{mid}[/video|/dynamic|/index]
 */
export function classifyTargetUrl(raw: string): TargetRef | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const path = u.pathname

  // 视频页
  const bv = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(path)
  if (bv) return { kind: 'video', bvid: bv[1] }

  // 合集播放页：/list/{mid}?sid=xxx
  const listMatch = /^\/list\/(\d+)/.exec(path)
  if (listMatch) {
    const sid = Number(u.searchParams.get('sid') || '0')
    if (!sid) return null
    const mid = Number(listMatch[1])
    return u.searchParams.get('type') === 'series'
      ? { kind: 'series', mid, sid }
      : { kind: 'season', mid, sid }
  }

  // 空间合集 / 系列：/{mid}/lists/{sid}
  const listsMatch = /^\/(\d+)\/lists\/(\d+)/.exec(path)
  if (listsMatch) {
    const mid = Number(listsMatch[1])
    const sid = Number(listsMatch[2])
    // 系列与合集走的是**不同接口**，靠查询参数区分，不能只看路径
    return u.searchParams.get('type') === 'series'
      ? { kind: 'series', mid, sid }
      : { kind: 'season', mid, sid }
  }

  // 收藏夹：/{mid}/favlist?fid=xxx
  // 注意 `ftype=` 常常是空的，不能要求它非空
  const favMatch = /^\/(\d+)\/favlist/.exec(path)
  if (favMatch) {
    const sid = Number(u.searchParams.get('fid') || '0')
    if (!sid) return null
    return { kind: 'favlist', mid: Number(favMatch[1]), sid }
  }

  // 投稿页：/{mid} 或 /{mid}/video|/dynamic|/index
  const spaceMatch = /^\/(\d+)(?:\/(?:video|dynamic|index))?\/?$/.exec(path)
  if (spaceMatch) return { kind: 'space', mid: Number(spaceMatch[1]) }

  // 兜底：链接里任何位置带 BV 号
  const loose = extractBvid(raw)
  if (loose) return { kind: 'video', bvid: loose }

  return null
}

/**
 * 解析任意 B 站输入（BV 号 / 视频链接 / 合集 / 系列 / 收藏夹 / 投稿页 / b23 短链），
 * 返回类型与包含的视频列表。
 */
export async function resolveTarget(
  input: string,
  cookie = '',
  maxPages = 30
): Promise<ResolvedTarget> {
  const trimmed = (input || '').trim()
  if (!trimmed) throw new BiliApiError('请输入 BV 号或链接')

  const single = async (bvid: string, url: string): Promise<ResolvedTarget> => {
    const info = await getVideoInfo(bvid, cookie)
    return {
      kind: 'video',
      title: info.title,
      url,
      uid: info.ownerUid || null,
      sid: null,
      videos: [{ bvid, title: info.title, cover: info.cover, duration: info.duration }],
      truncated: false
    }
  }

  // 只输入了 BV 号
  if (!trimmed.includes('/')) {
    const bv = extractBvid(trimmed)
    if (!bv) throw new BiliApiError('没有识别到 BV 号，请输入完整链接或形如 BV1xx411c7xx 的编号')
    return single(bv, `https://www.bilibili.com/video/${bv}`)
  }

  const url = await resolveShortLink(trimmed)
  const ref = classifyTargetUrl(url)
  if (!ref) {
    throw new BiliApiError(
      '暂不支持该链接。支持：视频页、合集/系列页、收藏夹、UP主投稿页、b23.tv 短链'
    )
  }

  const listed = async (
    kind: 'season' | 'series' | 'favlist' | 'space',
    res: { title: string; videos: ResolvedVideo[]; truncated: boolean }
  ): Promise<ResolvedTarget> => ({
    kind,
    title: res.title,
    url,
    uid: 'mid' in ref ? ref.mid : null,
    sid: 'sid' in ref ? ref.sid : null,
    videos: res.videos,
    truncated: res.truncated
  })

  if (ref.kind === 'video') return single(ref.bvid, url)

  if (ref.kind === 'series') {
    return listed('series', await getSeriesVideos(ref.mid, ref.sid, cookie, maxPages))
  }
  if (ref.kind === 'season') {
    return listed('season', await getSeasonVideos(ref.mid, ref.sid, cookie, maxPages))
  }
  if (ref.kind === 'favlist') {
    return listed('favlist', await getFavVideos(ref.sid, cookie, maxPages))
  }
  return listed('space', await getSpaceVideos(ref.mid, cookie, maxPages))
}

/** 探测当前 Cookie 的登录状态 */
export async function checkLogin(cookie: string): Promise<{
  loggedIn: boolean
  name?: string
  avatar?: string
}> {
  try {
    const res = await requestJson(API_NAV, {}, cookie)
    const d = res?.data
    return {
      loggedIn: Boolean(d?.isLogin),
      name: d?.uname || undefined,
      avatar: d?.face || undefined
    }
  } catch {
    return { loggedIn: false }
  }
}
