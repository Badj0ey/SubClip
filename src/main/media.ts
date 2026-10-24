/**
 * 视频预览的流媒体层（第二阶段）。
 *
 * ## 为什么需要它
 *
 * 播放器是渲染进程里的 HTML5 `<video>`，而 B站 DASH 分片地址有两个硬约束：
 * 1. **CDN 校验 Referer**，必须带 `Referer: https://www.bilibili.com/`；
 * 2. `<video>` **不允许自定义 Referer**（`Referer` 是禁止修改的请求头）。
 *
 * 所以主进程做两件事：
 * - 解析出 DASH 音 / 视频地址（`openMediaSession`）；
 * - 用 `session.webRequest.onBeforeSendHeaders` 给**去往 CDN 的请求**补上
 *   Referer / UA / Origin（`installStreamHeaderBridge`）。
 *
 * ## 为什么不用自定义协议代理
 *
 * 一开始实现的是 `bilistream://` 自定义协议（主进程代取字节再回吐），
 * 已验证协议处理器本身没问题（`fetch('bilistream://…', {Range})` 能拿到 206），
 * 但 **`<video>` 的媒体加载会被 Electron 的 URL 安全检查拒绝**
 * （`MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`；
 * 关掉 `bypassCSP` 也只是从「立刻报错」变成「一直卡在 readyState=0」）。
 * 直连 CDN + 注入请求头这条路更短，也少一次内存中转 —— 播放器自己就能做 Range。
 *
 * ## Range 语义
 *
 * 完全交给 CDN：浏览器的媒体栈会自己发 `Range` 请求，CDN 返回 `206`，
 * 主进程只负责请求头，不碰字节。
 */
import { randomUUID } from 'node:crypto'
import type { Session } from 'electron'
import type { MediaSession, MediaTrack } from '@shared/types'
import { getPlayInfo, type PlayInfo } from './slice/playurl'
import { getVideoInfo, UA } from './bilibili'
import { loadSettings } from './settings'

/** 会话有效期：B站播放地址通常几小时内有效，超时后重新解析 */
const SESSION_TTL_MS = 50 * 60 * 1000

export type { MediaSession, MediaTrack }

/** 需要补请求头的 CDN 域名（B站会在这几个之间轮换） */
const CDN_HOSTS = [
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
  'bilibili.com',
  'akamaized.net'
]

interface SessionState {
  createdAt: number
  videoUrl: string
  audioUrl: string | null
}

const sessions = new Map<string, SessionState>()

/** 所有已解析出来的真实 CDN 地址（请求头注入时用它判断「是不是我们发起的」） */
const allowedUrls = new Set<string>()

function cleanup(): void {
  const now = Date.now()
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(token)
      allowedUrls.delete(s.videoUrl)
      if (s.audioUrl) allowedUrls.delete(s.audioUrl)
    }
  }
}

function isCdnHost(hostname: string): boolean {
  return CDN_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))
}

/**
 * 给去往 B站 CDN 的请求补上 Referer / UA / Origin。
 *
 * 只对**已经解析出来的播放地址**生效（`allowedUrls` 白名单），
 * 不做「凡是 CDN 域名就放行」——否则等于给整个渲染进程开了一个改请求头的口子。
 */
export function installStreamHeaderBridge(session: Session): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const url = new URL(details.url)
      if (!allowedUrls.has(details.url) || !isCdnHost(url.hostname)) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      const headers = { ...details.requestHeaders }
      // 媒体栈会带上 `Origin: file://` 之类，CDN 校验可能因此拒绝，统一盖掉
      headers.Referer = 'https://www.bilibili.com/'
      headers.Origin = 'https://www.bilibili.com'
      headers['User-Agent'] = UA
      callback({ requestHeaders: headers })
    } catch {
      callback({ requestHeaders: details.requestHeaders })
    }
  })
}

/**
 * 解析某个分P 的可播放流。
 *
 * 画质取设置里的「切片画质」（两处共用同一个偏好：预览流畅与切片体积诉求一致）。
 */
export async function openMediaSession(bvid: string, page: number): Promise<MediaSession> {
  cleanup()

  const settings = loadSettings()
  const cookie = settings.biliCookie || ''
  const info = await getVideoInfo(bvid, cookie)
  const pageInfo = info.pages.find((p) => p.page === page) ?? info.pages[0]
  if (!pageInfo) throw new Error('找不到该分P 的播放信息')

  const play: PlayInfo = await getPlayInfo(bvid, pageInfo.cid, cookie, settings.sliceQuality || 80)
  const video = play.video[0]
  if (!video) throw new Error('没有可用的视频流')
  const audio = play.audio[0] ?? null

  const token = randomUUID().replace(/-/g, '')
  const videoUrl = withExtension(video.url, 'mp4')
  const audioUrl = audio ? withExtension(audio.url, 'm4a') : null
  sessions.set(token, { createdAt: Date.now(), videoUrl, audioUrl })
  // 登记白名单：请求头注入只认这些地址
  allowedUrls.add(videoUrl)
  if (audioUrl) allowedUrls.add(audioUrl)

  return {
    token,
    bvid,
    page: pageInfo.page,
    title: pageInfo.title || info.title,
    duration: play.duration || pageInfo.duration,
    video: { url: videoUrl, codec: video.codecs, quality: video.id },
    audio: audio ? { url: audioUrl as string, codec: audio.codecs, quality: audio.id } : null
  }
}

/**
 * 给 DASH 地址补一个 `.mp4` / `.m4a` 后缀。
 *
 * 播放器靠扩展名 / 路径猜容器格式，B站给的是无扩展名的地址
 * （`.../video.m4s?deadline=...` 这种），补上更稳；顺便把查询串顺手改一下，
 * 让「同一地址不同 token」在浏览器缓存里不会互相串。
 */
function withExtension(rawUrl: string, ext: string): string {
  const u = new URL(rawUrl)
  if (!/\.[A-Za-z0-9]+$/.test(u.pathname)) u.pathname = `${u.pathname}.${ext}`
  return u.toString()
}

/** 关闭全部会话（换视频 / 退出时调用） */
export function closeAllSessions(): void {
  for (const s of sessions.values()) {
    allowedUrls.delete(s.videoUrl)
    if (s.audioUrl) allowedUrls.delete(s.audioUrl)
  }
  sessions.clear()
}

/** 诊断用：协议 / 会话数（脱敏，只有数量） */
export function mediaInfo(): { sessions: number; allowed: number } {
  return { sessions: sessions.size, allowed: allowedUrls.size }
}
