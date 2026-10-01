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
  if (!d) throw new BiliApiError('视频信息为空')
  const pages: BiliPageInfo[] = (d.pages ?? []).map((p: any) => ({
    page: Number(p.page) || 1,
    cid: Number(p.cid),
    title: String(p.part || ''),
    duration: Number(p.duration) || 0
  }))

  const ugcSeason = d.ugc_season ?? null

  return {
    bvid,
    title: String(d.title || bvid),
    cover: String(d.pic || ''),
    duration: Number(d.duration) || 0,
    ownerUid: Number(d.owner?.mid) || 0,
    ownerName: String(d.owner?.name || '未知UP主'),
    ownerAvatar: String(d.owner?.face || ''),
    seasonId: ugcSeason?.id ? Number(ugcSeason.id) : null,
    seasonTitle: ugcSeason?.title ? String(ugcSeason.title) : null,
    pages
  }
}

/** 获取分P列表（view 里没有时兜底） */
export async function getPages(bvid: string, cookie = ''): Promise<BiliPageInfo[]> {
  const res = await requestJson(API_PAGELIST, { bvid }, cookie)
  return ((res?.data ?? []) as any[]).map((p) => ({
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
  cookie = ''
): Promise<BiliSubtitleTrack[]> {
  const referer = `https://www.bilibili.com/video/${bvid}/`

  const parseTracks = (data: any): BiliSubtitleTrack[] =>
    ((data?.subtitle?.subtitles ?? []) as any[]).map((s) => ({
      lang: String(s.lan || ''),
      label: String(s.lan_doc || s.lan || ''),
      url: String(s.subtitle_url || '')
    }))

  try {
    const mixinKey = await getWbiKey(cookie)
    const signed = signWbi({ bvid, cid }, mixinKey)
    const res = await requestJson(API_PLAYER_WBI_V2, signed, cookie)
    return parseTracks(res?.data)
  } catch {
    // 兼容老接口
    const res = await requestJson(API_PLAYER_V2, { bvid, cid }, cookie)
    return parseTracks(res?.data)
  }
}

/** 下载字幕 json 原始内容 */
export async function fetchSubtitleJson(url: string, bvid: string, cookie = ''): Promise<any> {
  const full = url.startsWith('//') ? `https:${url}` : url
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    Referer: `https://www.bilibili.com/video/${bvid}/`,
    'User-Agent': UA
  }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(full, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
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
      const bvid = String(a.bvid || '')
      if (!bvid) continue
      if (videos.some((v) => v.bvid === bvid)) continue
      videos.push({
        bvid,
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
      const bvid = String(a.bvid || '')
      if (!bvid) continue
      videos.push({
        bvid,
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
      if (m.type != null && Number(m.type) !== 2) continue // 2 = 视频稿件
      const bvid = String(m.bvid || '')
      if (!bvid) continue
      videos.push({
        bvid,
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
      const bvid = String(v.bvid || '')
      if (!bvid) continue
      videos.push({
        bvid,
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

  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new BiliApiError('无法识别的输入，请检查链接是否完整')
  }
  const path = u.pathname

  // 视频页
  const bv = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(path)
  if (bv) return single(bv[1], url)

  // 合集播放页：/list/{mid}?sid=xxx
  const listMatch = /^\/list\/(\d+)/.exec(path)
  const sidParam = u.searchParams.get('sid')
  if (listMatch && sidParam) {
    const mid = Number(listMatch[1])
    const sid = Number(sidParam)
    const isSeries = u.searchParams.get('type') === 'series'
    const res = isSeries
      ? await getSeriesVideos(mid, sid, cookie, maxPages)
      : await getSeasonVideos(mid, sid, cookie, maxPages)
    return {
      kind: isSeries ? 'series' : 'season',
      title: res.title,
      url,
      uid: mid,
      sid,
      videos: res.videos,
      truncated: res.truncated
    }
  }

  // 空间合集 / 系列：/{mid}/lists/{sid}
  const listsMatch = /^\/(\d+)\/lists\/(\d+)/.exec(path)
  if (listsMatch) {
    const mid = Number(listsMatch[1])
    const sid = Number(listsMatch[2])
    const isSeries = u.searchParams.get('type') === 'series'
    const res = isSeries
      ? await getSeriesVideos(mid, sid, cookie, maxPages)
      : await getSeasonVideos(mid, sid, cookie, maxPages)
    return {
      kind: isSeries ? 'series' : 'season',
      title: res.title,
      url,
      uid: mid,
      sid,
      videos: res.videos,
      truncated: res.truncated
    }
  }

  // 收藏夹：/{mid}/favlist?fid=xxx
  const favMatch = /^\/(\d+)\/favlist/.exec(path)
  if (favMatch) {
    const mid = Number(favMatch[1])
    const fid = Number(u.searchParams.get('fid') || '0')
    if (!fid) throw new BiliApiError('收藏夹链接缺少 fid 参数')
    const res = await getFavVideos(fid, cookie, maxPages)
    return {
      kind: 'favlist',
      title: res.title,
      url,
      uid: mid,
      sid: fid,
      videos: res.videos,
      truncated: res.truncated
    }
  }

  // 投稿页：/{mid} 或 /{mid}/video 或 /{mid}/dynamic
  const spaceMatch = /^\/(\d+)(?:\/(?:video|dynamic|index))?\/?$/.exec(path)
  if (spaceMatch) {
    const mid = Number(spaceMatch[1])
    const res = await getSpaceVideos(mid, cookie, maxPages)
    return {
      kind: 'space',
      title: res.title,
      url,
      uid: mid,
      sid: null,
      videos: res.videos,
      truncated: res.truncated
    }
  }

  // 兜底：链接里带 BV 号
  const loose = extractBvid(url)
  if (loose) return single(loose, url)

  throw new BiliApiError(
    '暂不支持该链接。支持：视频页、合集/系列页、收藏夹、UP主投稿页、b23.tv 短链'
  )
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
