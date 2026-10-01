/**
 * 与桌面端共享的通信协议（JS 版本）。
 * 对应桌面端的 src/shared/bridge.ts，改动时请同步两边。
 */

/**
 * 协议版本。
 * v4：新增 `pull-request`（插件请桌面端拉取某视频的**全部分P**）。
 *     桌面端对不认识的消息类型是静默丢弃的，所以插件必须靠这个版本号
 *     判断能力是否可用，否则会误报成功。
 */
export const PROTOCOL_VERSION = 4
export const SERVER_NAME = 'srt-clip-helper'
export const DEFAULT_PORT = 8765

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

export function serialize(msg) {
  return JSON.stringify(msg)
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
