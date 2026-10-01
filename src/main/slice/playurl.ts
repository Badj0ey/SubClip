/**
 * 获取 B 站 DASH 播放地址。
 *
 * 逻辑移植自 D:\subtitle2clip\bilibili-slice-downloader\js\bilibili.js：
 *   1. 先试免签名的 x/player/playurl
 *   2. 失败再用 WBI 签名的 x/player/wbi/playurl
 *   3. 在候选流里按画质挑选，同画质优先 avc1 编码（兼容性更好）
 */
import { getWbiKey, requestJson, signWbi, UA } from '../bilibili'

const API_PLAYURL = 'https://api.bilibili.com/x/player/playurl'
const API_PLAYURL_WBI = 'https://api.bilibili.com/x/player/wbi/playurl'

export { QUALITY_OPTIONS } from '@shared/constants'

export interface DashStream {
  /** 清晰度（视频）或音质代码（音频） */
  id: number
  url: string
  backupUrl: string
  codecs: string
  bandwidth: number
  /** 形如 `1234-5678` */
  indexRange: string
  initRange: string
}

export interface PlayInfo {
  video: DashStream[]
  audio: DashStream[]
  /** 视频总时长（秒） */
  duration: number
}

interface RawStream {
  id?: number
  baseUrl?: string
  base_url?: string
  backupUrl?: string[]
  backup_url?: string[]
  codecs?: string
  bandwidth?: number
  segment_base?: { index_range?: string; init_range?: string }
  segmentBase?: { index_range?: string; init_range?: string }
}

function toStream(raw: RawStream): DashStream | null {
  const url = raw.baseUrl || raw.base_url || ''
  const backup = (raw.backupUrl?.[0] ?? raw.backup_url?.[0] ?? '') as string
  const seg = raw.segment_base ?? raw.segmentBase ?? {}
  const indexRange = String(seg.index_range ?? '')
  if (!indexRange) return null
  return {
    id: Number(raw.id) || 0,
    url: url || backup,
    backupUrl: backup,
    codecs: String(raw.codecs ?? ''),
    bandwidth: Number(raw.bandwidth) || 0,
    indexRange,
    initRange: String(seg.init_range ?? '')
  }
}

/** 在候选里挑不超过 qn 的最高清晰度；同清晰度优先 avc1 */
function pickVideo(streams: DashStream[], qn: number): DashStream | null {
  if (!streams.length) return null
  const sorted = [...streams].sort((a, b) => b.id - a.id)
  const under = sorted.filter((s) => s.id <= qn)
  const candidates = under.length ? under : sorted
  const targetId = candidates[0].id
  const sameId = candidates.filter((s) => s.id === targetId)
  return sameId.find((s) => /avc1/i.test(s.codecs)) ?? sameId[0]
}

function pickAudio(streams: DashStream[]): DashStream | null {
  if (!streams.length) return null
  return [...streams].sort((a, b) => b.id - a.id)[0]
}

/**
 * 拉取某个分P 的 DASH 播放信息。
 * @param qn 期望画质（B站 qn 值），实际会降级到不超过它的最高档
 */
export async function getPlayInfo(
  bvid: string,
  cid: number,
  cookie: string,
  qn = 80
): Promise<PlayInfo> {
  const params: Record<string, string | number> = {
    bvid,
    cid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    qn
  }

  let data: any = null
  try {
    data = await requestJson(API_PLAYURL, params, cookie, 2)
  } catch {
    /* 继续尝试 WBI 端点 */
  }

  if (!data?.data?.dash) {
    const key = await getWbiKey(cookie)
    const signed = signWbi(params, key)
    data = await requestJson(API_PLAYURL_WBI, signed, cookie)
  }

  const d = data?.data
  if (!d) throw new Error('获取播放地址失败（可能是会员专享 / 地区限制 / 未登录）')
  if (!d.dash) {
    throw new Error('该视频没有 DASH 流（可能是较老的 durl 格式），暂不支持本地切片')
  }

  const video = ((d.dash.video ?? []) as RawStream[])
    .map(toStream)
    .filter((s): s is DashStream => Boolean(s))
  const audio = ((d.dash.audio ?? []) as RawStream[])
    .map(toStream)
    .filter((s): s is DashStream => Boolean(s))

  if (!video.length) throw new Error('没有可用的视频流')

  const pickedVideo = pickVideo(video, qn)
  const pickedAudio = pickAudio(audio)

  return {
    video: pickedVideo ? [pickedVideo] : [],
    audio: pickedAudio ? [pickedAudio] : [],
    duration: Number(d.timelength || 0) / 1000
  }
}

export { UA }
