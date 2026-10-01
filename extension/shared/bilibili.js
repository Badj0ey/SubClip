/**
 * 字幕文件下载（在扩展的 service worker 中执行）。
 *
 * 注意：这里**只做 CDN 文件下载**，不做任何需要登录态的接口调用。
 * B 站接口（player/wbi/v2 等）必须放在页面上下文里调，原因见 content.js 顶部注释：
 * service worker 发起的请求对 bilibili.com 属于跨站，SameSite=Lax 的 SESSDATA 不会带上。
 *
 * 字幕 json 位于公开 CDN（hdslb.com），不需要 Cookie；扩展请求不受 CORS 限制，
 * 只需 background 注册的 declarativeNetRequest 规则补上 Referer。
 */

/** 单次下载超时：卡住的请求会让弹窗一直停在「抓取中…」 */
const DOWNLOAD_TIMEOUT_MS = 30_000

/** 下载字幕 json（body: [{from,to,content}]） */
export async function fetchSubtitleJson(url) {
  const full = url.startsWith('//') ? `https:${url}` : url

  const res = await fetch(full, {
    credentials: 'omit',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('字幕资源不是合法 JSON（可能被风控拦截）')
  }
  if (!data || typeof data !== 'object' || !('body' in data)) {
    throw new Error('字幕资源缺少 body 字段')
  }
  return data
}
