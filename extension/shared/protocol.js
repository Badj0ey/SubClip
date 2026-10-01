/**
 * 与桌面端共享的通信协议（JS 版本）。
 * 对应桌面端的 src/shared/bridge.ts，改动时请同步两边。
 */

export const PROTOCOL_VERSION = 2
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
