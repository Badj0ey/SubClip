/**
 * 桌面端 ↔ 浏览器插件 的本地 WebSocket 通信协议。
 *
 * 桌面端是 WebSocket 服务端（监听 127.0.0.1:port，默认 8765），插件是客户端。
 * 本文件为两端共享的协议定义，插件侧对应 extension/shared/protocol.js（同一份定义的 JS 版本）。
 */

export const BRIDGE_PROTOCOL_VERSION = 2
export const BRIDGE_SERVER_NAME = 'srt-clip-helper'

/** 页面类型 */
export type PageType = 'video' | 'season' | 'favlist' | 'space' | 'unknown'

/** 插件识别出的页面视频信息 */
export interface BridgePageInfo {
  pageType: PageType
  bvid: string
  title: string
  url: string
  /** 第几 P，从 1 开始 */
  page: number
  cid?: number | null
  uploader: {
    /**
     * UP主 UID（B站接口里的 `owner.mid`）。
     * v2 起字段名由 `mid` 改为 `uid`；桌面端读取时仍兼容旧插件发来的 `mid`。
     */
    uid: number | null
    name: string
    avatar: string | null
  }
  seasonId?: number | null
  seasonTitle?: string | null
  /** 插件侧识别到该页面的可用字幕轨（可选，便于桌面端展示） */
  tracks?: Array<{ lang: string; label: string; url?: string }>
}

/** 插件抓取到的字幕内容 */
export interface BridgeSubtitle {
  bvid: string
  page: number
  lang: string
  label: string
  cues: Array<{ from: number; to: number; content: string }>
}

/** 插件同步过来的 B站登录凭证（用于桌面端自己直连接口） */
export interface BridgeCookies {
  /** 拼好的 Cookie 头字符串 */
  cookie: string
  loggedIn: boolean
  userName?: string
  /** Cookie 条数，便于界面展示 */
  count: number
}

/* ----------------------------- 插件 → 桌面端 ----------------------------- */

export type ClientMessage =
  | { type: 'hello'; version: string; browser: string }
  | { type: 'page-info'; payload: BridgePageInfo }
  | { type: 'subtitle'; payload: BridgeSubtitle }
  | { type: 'cookies'; payload: BridgeCookies }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'ping' }

/* ----------------------------- 桌面端 → 插件 ----------------------------- */

export type ServerMessage =
  | {
      type: 'hello-ack'
      server: string
      version: string
      protocol: number
      /** 桌面端希望插件在识别到页面后自动抓取字幕 */
      autoFetchSubtitles: boolean
    }
  | {
      type: 'request-subtitles'
      bvid: string
      page: number
      cid?: number | null
    }
  | { type: 'ack'; ok: boolean; message?: string }
  | { type: 'pong' }

/* -------------------------------- 状态展示 -------------------------------- */

export interface BridgeClientInfo {
  id: number
  version: string
  browser: string
  connectedAt: number
  remote: string
  /** 该插件是否已同步过 B站登录凭证 */
  cookieSynced: boolean
}

export interface BridgeStatus {
  running: boolean
  port: number
  /** 最近一次启动失败的原因（如端口被占用） */
  error: string | null
  clients: BridgeClientInfo[]
  /** 最近收到的一条插件消息摘要 */
  lastEvent: { at: number; text: string } | null
  protocol: number
}

/** 安全地把任意值转成协议消息（解析失败返回 null） */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const obj = JSON.parse(raw) as ClientMessage
    if (!obj || typeof obj !== 'object' || typeof (obj as { type?: unknown }).type !== 'string') {
      return null
    }
    return obj
  } catch {
    return null
  }
}

export function serialize(msg: ServerMessage): string {
  return JSON.stringify(msg)
}
