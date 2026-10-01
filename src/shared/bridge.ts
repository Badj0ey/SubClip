/**
 * 桌面端 ↔ 浏览器插件 的本地 WebSocket 通信协议。
 *
 * 桌面端是 WebSocket 服务端（监听 127.0.0.1:port，默认 8765），插件是客户端。
 * 本文件为两端共享的协议定义，插件侧对应 extension/shared/protocol.js（同一份定义的 JS 版本）。
 *
 * ⚠️ 安全前提：WebSocket 握手**不受 CORS 约束**，任何网页都能连 `ws://127.0.0.1:端口`。
 * 所以这里有两道闸门（见 `BRIDGE_EXTENSION_ID` 与 `parseClientMessage`）：
 *   1. `bridge.ts` 校验握手来源 Origin，只放行**固定 ID 的自家扩展**；
 *   2. 所有入站消息都经过本文件的**逐类型校验**，不合法直接丢弃，不信任任何字段。
 */

/**
 * 协议版本。
 * v3：加入握手来源校验与配对令牌，并收紧消息校验。
 * v4：新增 `pull-request`（插件请桌面端拉取某视频的全部分P）。
 *
 * 注意：桌面端对**不认识的消息类型是静默丢弃**的，所以插件必须靠 hello-ack 里的
 * `protocol` 做能力协商，不能只看「发送是否成功」。
 */
export const BRIDGE_PROTOCOL_VERSION = 4
export const BRIDGE_SERVER_NAME = 'srt-clip-helper'

/**
 * 浏览器插件的固定 ID。
 *
 * 解压加载的扩展 ID 默认由安装路径推导，每台机器都不同，没法写死校验；
 * `extension/manifest.json` 里的 `key` 字段（公钥）让 ID 变成确定值。
 * 改动 manifest 的 key 必须同步改这里，`tests/wbi.test.ts` 会校验两者一致。
 */
export const BRIDGE_EXTENSION_ID = 'lmchilpnlhdfbpjklnfpfgkbddcdekpl'

/** 握手时允许的 Origin 列表（固定 ID 的扩展页来源） */
export const BRIDGE_ALLOWED_ORIGINS = [`chrome-extension://${BRIDGE_EXTENSION_ID}`]

/** 各类入站数据的上限，防止畸形/恶意消息把内存与磁盘撑爆 */
export const BRIDGE_LIMITS = {
  /** 单条消息最大字节数（同时作为 ws 的 maxPayload） */
  maxMessageBytes: 512 * 1024,
  /** 单条字幕最多多少行 */
  maxCues: 20000,
  /** 字幕正文单行最大长度 */
  maxCueText: 2000,
  /** 通用字符串字段上限 */
  maxString: 500,
  /** 标题 / 标签类字段上限 */
  maxLabel: 200,
  /** Cookie 头最大长度 */
  maxCookie: 8192,
  /** 每个连接每秒最多处理多少条消息（超出即断开） */
  maxMessagesPerSecond: 60
}

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

/**
 * 插件请桌面端「把这个视频的字幕拉下来」。
 *
 * 之所以不让插件自己去抓：桌面端的 `pullSubtitles` 会**遍历该视频的全部分P**
 * 并按「分P + 语言」去重，插件那边做同样的事会把浏览器页面拖慢。
 * 插件只负责说明「是哪个视频」，抓取交给桌面端。
 */
export interface BridgePullRequest {
  bvid: string
  /** 用户当时所在的分P（仅用于提示，实际会拉全部分P） */
  page: number
  title?: string
}

export type ClientMessage =
  | { type: 'hello'; version: string; browser: string; token?: string }
  | { type: 'page-info'; payload: BridgePageInfo }
  | { type: 'subtitle'; payload: BridgeSubtitle }
  | { type: 'cookies'; payload: BridgeCookies }
  | { type: 'pull-request'; payload: BridgePullRequest }
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
      /** 桌面端设置了配对令牌时，插件需要在 hello 里带上它 */
      tokenRequired: boolean
      /** 本次握手是否已被拒绝（Origin 不在白名单） */
      rejected?: boolean
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
  /** 握手来源 Origin（便于排查「为什么连不上」） */
  origin: string
  /** 桌面端设置了令牌时，该连接是否已通过令牌校验 */
  authenticated: boolean
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

/* --------------------------------- 校验 ---------------------------------- */

const BV_RE = /^BV[0-9A-Za-z]{10}$/
const PAGE_TYPES: PageType[] = ['video', 'season', 'favlist', 'space', 'unknown']
const LOG_LEVELS: Array<'info' | 'warn' | 'error'> = ['info', 'warn', 'error']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max = BRIDGE_LIMITS.maxString): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

/** 只接受有限数值，其余一律给默认值（NaN / Infinity / 字符串都挡掉） */
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function intOrNull(v: unknown): number | null {
  const n = num(v, NaN)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function parsePageInfo(v: unknown): BridgePageInfo | null {
  if (!isObject(v)) return null
  const up = isObject(v.uploader) ? v.uploader : {}
  const pageType = PAGE_TYPES.includes(v.pageType as PageType)
    ? (v.pageType as PageType)
    : 'unknown'

  let tracks: BridgePageInfo['tracks']
  if (Array.isArray(v.tracks)) {
    tracks = v.tracks.slice(0, 50).map((t) => {
      const item = isObject(t) ? t : {}
      return {
        lang: str(item.lang, 32),
        label: str(item.label, BRIDGE_LIMITS.maxLabel),
        url: str(item.url, BRIDGE_LIMITS.maxString) || undefined
      }
    })
  }

  return {
    pageType,
    bvid: BV_RE.test(str(v.bvid, 32)) ? str(v.bvid, 32) : '',
    title: str(v.title, BRIDGE_LIMITS.maxLabel),
    url: str(v.url, BRIDGE_LIMITS.maxString),
    page: Math.max(1, Math.trunc(num(v.page, 1))),
    cid: intOrNull(v.cid),
    uploader: {
      uid: intOrNull(up.uid ?? up.mid),
      name: str(up.name, BRIDGE_LIMITS.maxLabel),
      avatar: str(up.avatar, BRIDGE_LIMITS.maxString) || null
    },
    seasonId: intOrNull(v.seasonId),
    seasonTitle: str(v.seasonTitle, BRIDGE_LIMITS.maxLabel) || null,
    tracks
  }
}

function parseSubtitle(v: unknown): BridgeSubtitle | null {
  if (!isObject(v)) return null
  const bvid = str(v.bvid, 32)
  if (!BV_RE.test(bvid)) return null
  if (!Array.isArray(v.cues)) return null

  const cues: BridgeSubtitle['cues'] = []
  for (const raw of v.cues.slice(0, BRIDGE_LIMITS.maxCues)) {
    if (!isObject(raw)) continue
    const content = str(raw.content, BRIDGE_LIMITS.maxCueText)
    if (!content.trim()) continue
    const from = num(raw.from, NaN)
    if (!Number.isFinite(from) || from < 0) continue
    const to = num(raw.to, from)
    cues.push({ from, to: Number.isFinite(to) && to >= from ? to : from, content })
  }
  if (!cues.length) return null

  return {
    bvid,
    page: Math.max(1, Math.trunc(num(v.page, 1))),
    lang: str(v.lang, 32) || 'unknown',
    label: str(v.label, BRIDGE_LIMITS.maxLabel),
    cues
  }
}

function parseCookies(v: unknown): BridgeCookies | null {
  if (!isObject(v)) return null
  const cookie = typeof v.cookie === 'string' ? v.cookie.trim() : ''
  if (!cookie || cookie.length > BRIDGE_LIMITS.maxCookie) return null
  return {
    cookie,
    loggedIn: Boolean(v.loggedIn),
    userName: str(v.userName, 64) || undefined,
    count: Math.max(0, Math.trunc(num(v.count, 0)))
  }
}

/**
 * 把原始报文解析成**受信任**的协议消息；任何不合法的地方都返回 null。
 *
 * 这是唯一的安全边界：插件（乃至伪造 Origin 的本地进程）发来的内容
 * 一律先经过这里，下游服务层可以假定字段类型与范围都是正常的。
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > BRIDGE_LIMITS.maxMessageBytes) return null

  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(obj)) return null

  switch (obj.type) {
    case 'hello':
      return {
        type: 'hello',
        version: str(obj.version, 32) || 'unknown',
        browser: str(obj.browser, 32) || 'unknown',
        token: typeof obj.token === 'string' ? obj.token.slice(0, 128) : undefined
      }

    case 'ping':
      return { type: 'ping' }

    case 'log':
      return {
        type: 'log',
        level: LOG_LEVELS.includes(obj.level as 'info') ? (obj.level as 'info') : 'info',
        message: str(obj.message, BRIDGE_LIMITS.maxString)
      }

    case 'cookies': {
      const payload = parseCookies(obj.payload)
      return payload ? { type: 'cookies', payload } : null
    }

    case 'page-info': {
      const payload = parsePageInfo(obj.payload)
      return payload ? { type: 'page-info', payload } : null
    }

    case 'subtitle': {
      const payload = parseSubtitle(obj.payload)
      return payload ? { type: 'subtitle', payload } : null
    }

    case 'pull-request': {
      if (!isObject(obj.payload)) return null
      const bvid = str(obj.payload.bvid, 32)
      // 没有合法 BV 号就没法拉，直接丢弃（宁可让插件那边超时，也不要发起一次无意义的抓取）
      if (!BV_RE.test(bvid)) return null
      return {
        type: 'pull-request',
        payload: {
          bvid,
          page: Math.max(1, Math.trunc(num(obj.payload.page, 1))),
          title: str(obj.payload.title, BRIDGE_LIMITS.maxLabel)
        }
      }
    }

    default:
      return null
  }
}

export function serialize(msg: ServerMessage): string {
  return JSON.stringify(msg)
}
