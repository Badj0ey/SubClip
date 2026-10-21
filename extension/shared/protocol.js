/**
 * 与桌面端共享的通信协议（JS 版本）。
 * 对应桌面端的 src/shared/bridge.ts，改动时请同步两边。
 */

/**
 * 协议版本。
 * v4：新增 `pull-request`（插件请桌面端拉取某视频的**全部分P**）。
 * v5：**统一信封** —— 每条消息都带 `v`（协议版本）与 `caps`（能力表）。
 *
 * 桌面端对不认识的消息类型是静默丢弃的，所以不能只看「发送成功」，
 * 必须靠 `hello-ack.protocol` 与 `hello-ack.caps` 做协商；v5 起以**能力表**为准
 * （版本号只表达整体兼容性，具体功能按能力逐项判断）。
 */
export const PROTOCOL_VERSION = 5
export const SERVER_NAME = 'srt-clip-helper'
export const DEFAULT_PORT = 8765

/**
 * 能力表（与桌面端 bridge.ts 的 BRIDGE_CAPABILITIES 一一对应）。
 * 键是能力名，值是「插件这边是否支持」。
 */
export const CAPABILITY = {
  PAGE_INFO: 'pageInfo',
  SUBTITLE: 'subtitle',
  COOKIES: 'cookies',
  PULL_REQUEST: 'pullRequest',
  REQUEST_SUBTITLES: 'requestSubtitles'
}

/** 插件支持的能力表（握手时发给桌面端） */
export function clientCapabilities() {
  return {
    [CAPABILITY.PAGE_INFO]: true,
    [CAPABILITY.SUBTITLE]: true,
    [CAPABILITY.COOKIES]: true,
    [CAPABILITY.PULL_REQUEST]: true,
    // requestSubtitles 是「桌面端要求插件去抓」，插件这边实现了，所以也声明支持
    [CAPABILITY.REQUEST_SUBTITLES]: true
  }
}

/** 页面类型 */
export const PAGE_TYPE = {
  VIDEO: 'video',
  SEASON: 'season',
  FAVLIST: 'favlist',
  SPACE: 'space',
  UNKNOWN: 'unknown'
}

/**
 * 插件 → 桌面端的消息类型（与 bridge.ts 的 ClientMessage 一一对应）。
 *
 * `PULL_REQUEST` 是让桌面端去拉某个视频的字幕：插件只说「是哪个 BV」，
 * 抓取由桌面端完成 —— 这样不管用户在哪个分P 触发，都会拉到该视频的全部分P，
 * 也不会因为在页面里循环调接口而拖慢浏览器。
 */
export const CLIENT_MESSAGE = {
  HELLO: 'hello',
  PAGE_INFO: 'page-info',
  SUBTITLE: 'subtitle',
  COOKIES: 'cookies',
  PULL_REQUEST: 'pull-request',
  LOG: 'log',
  PING: 'ping'
}

export function buildHello(browser) {
  return {
    type: 'hello',
    version: browser.runtime.getManifest().version,
    browser: browser === undefined ? 'unknown' : detectBrowser()
  }
}

export function detectBrowser() {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('Chrome/')) return 'Chrome'
  return 'Chromium'
}

/**
 * 序列化出站消息，并**自动补上统一信封**（v5）。
 *
 * 与桌面端 `serialize` 对称：调用点不必手写 `v` / `caps`（漏一处就是形状不一致），
 * 统一在这里补；调用方显式给了就以其为准。
 */
export function serialize(msg) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    caps: clientCapabilities(),
    ...msg
  })
}

export function parse(raw) {
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null
    return obj
  } catch {
    return null
  }
}

/** 对方（桌面端）是否支持某能力；老版本没有 caps 时按「不支持」处理 */
export function peerSupports(ack, capability) {
  return Boolean(ack && ack.caps && ack.caps[capability] === true)
}
