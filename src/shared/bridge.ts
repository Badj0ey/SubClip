/**
 * 桌面端 ↔ 浏览器用户脚本 的本地 WebSocket 通信协议。
 *
 * 桌面端是 WebSocket 服务端（监听 127.0.0.1:port，默认 8765），插件是客户端。
 * 本文件为两端共享的协议定义，插件侧对应 userscript/SubClip.user.js（同一份定义的 JS 版本）。
 *
 * ⚠️ 安全前提：WebSocket 握手**不受 CORS 约束**，任何网页都能连 `ws://127.0.0.1:端口`。
 * 所以这里有两道闸门（见 `BRIDGE_ALLOWED_ORIGINS` 与 `parseClientMessage`）：
 *   1. `bridge.ts` 校验握手来源 Origin，只放行 B站页面（用户脚本的 Origin 就是页面来源）；
 *   2. 所有入站消息都经过本文件的**逐类型校验**，不合法直接丢弃，不信任任何字段。
 *
 * 用户脚本没有固定扩展 ID，只能按页面来源放行。建议在设置里配置**配对令牌**：
 * 页面里的普通脚本无法读取篡改猴的存储，拿不到令牌就发不了业务消息。
 */

/**
 * 协议版本。
 * v3：加入握手来源校验与配对令牌，并收紧消息校验。
 * v4：新增 `pull-request`（插件请桌面端拉取某视频的全部分P）。
 * v5：**统一信封**：每条消息都可带 `v`（协议版本）与 `caps`（能力表，见下）。
 *
 * 注意：桌面端对**不认识的消息类型是静默丢弃**的，所以插件必须靠 hello-ack 里的
 * `protocol` / `caps` 做能力协商，不能只看「发送是否成功」。
 */
export const BRIDGE_PROTOCOL_VERSION = 5
export const BRIDGE_SERVER_NAME = 'subclip'

/**
 * 能力表（capabilities）。
 *
 * 解决的问题：协议版本号只能表达「整体是否兼容」，而实际使用中两端往往是
 * **部分功能**不同步（比如桌面端已经会处理 `pull-request`，插件却还没升级）。
 * 有了能力表，双方可以按能力逐项协商，而不是靠版本号一刀切。
 *
 * 约定：键是能力名，值是「我这边是否支持」。新增消息类型时**先加能力名**，
 * 对端不支持就跳过该功能，不需要为此再抬版本号。
 */
export const BRIDGE_CAPABILITIES = {
  /** 插件能自动识别页面并上报（page-info） */
  pageInfo: 'pageInfo',
  /** 插件能抓取并推送字幕（subtitle） */
  subtitle: 'subtitle',
  /** 大字幕按顺序分块上传，桌面端组装后一次入库 */
  subtitleChunk: 'subtitleChunk',
  /** 插件能同步 B站登录凭证（cookies） */
  cookies: 'cookies',
  /** 插件能请求桌面端拉取某个视频的全部分P（pull-request） */
  pullRequest: 'pullRequest',
  /** 桌面端能反过来要求插件去抓某一 P 的字幕（request-subtitles） */
  requestSubtitles: 'requestSubtitles'
} as const

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[keyof typeof BRIDGE_CAPABILITIES]

/** 能力表：只有明确为 true 才算支持（缺字段 = 不支持） */
export type BridgeCapabilities = Partial<Record<BridgeCapability, boolean>>

/** 把能力对象规整成受信任的形状（丢掉未知键与非布尔值） */
export function normalizeCapabilities(value: unknown): BridgeCapabilities {
  if (!isObject(value)) return {}
  const known = new Set<string>(Object.values(BRIDGE_CAPABILITIES))
  const out: BridgeCapabilities = {}
  for (const [key, raw] of Object.entries(value)) {
    if (known.has(key) && raw === true) out[key as BridgeCapability] = true
  }
  return out
}

/** 判断对方是否支持某能力 */
export function supportsCap(caps: BridgeCapabilities | undefined, cap: BridgeCapability): boolean {
  return caps?.[cap] === true
}


/**
 * 握手时允许的 Origin 列表。
 *
 * 篡改猴脚本运行在 B站页面里，WebSocket 的 Origin 是 `https://*.bilibili.com`，
 * 不再是固定的 `chrome-extension://`。`*` 可匹配任意字符（正则 `.*`），整串锚定，
 * 所以 `https://www.bilibili.com.evil.example` 这类伪装域名不会被放行。
 */
export const BRIDGE_ALLOWED_ORIGINS = ['https://*.bilibili.com']

/**
 * Origin 是否在白名单里。
 *
 * - 没有 Origin 头的是非浏览器客户端（调试脚本 / 命令行），保持放行；
 * - 白名单为空表示不限制（测试或用户显式配置）；
 * - 支持 `*` 通配，但必须整串匹配。
 */
export function isBridgeOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[] = BRIDGE_ALLOWED_ORIGINS
): boolean {
  if (!origin) return true
  if (!allowed.length) return true
  return allowed.some((pattern) => {
    if (pattern === origin) return true
    if (!pattern.includes('*')) return false
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(origin)
  })
}

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
  maxMessagesPerSecond: 60,
  /** 大字幕分块传输上限：避免单帧超限及无限制占用内存 */
  maxChunkCues: 2000,
  maxChunkCount: 128,
  maxUploadBytes: 32 * 1024 * 1024
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

/** 一条字幕文档的一个分块；严格按 index 顺序接收，全部到齐后才入库。 */
export interface BridgeSubtitleChunk extends BridgeSubtitle {
  uploadId: string
  index: number
  total: number
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

/**
 * 信封（v5）。
 *
 * 每条消息都可以带这两个字段：
 * - `v`：协议版本。**缺失时按 1 处理**（老插件不带），桌面端只在「版本更高」时才提示升级，
 *   不去拒绝 —— 版本号是用来协商的，不是用来断连的；
 * - `caps`：能力表（见 `BRIDGE_CAPABILITIES`）。
 */
export interface BridgeEnvelope {
  /** 协议版本 */
  v?: number
  /** 能力表 */
  caps?: BridgeCapabilities
}

export type ClientMessage =
  | ({ type: 'hello'; version: string; browser: string; token?: string } & BridgeEnvelope)
  | ({ type: 'page-info'; payload: BridgePageInfo } & BridgeEnvelope)
  | ({ type: 'subtitle'; payload: BridgeSubtitle } & BridgeEnvelope)
  | ({ type: 'subtitle-chunk'; payload: BridgeSubtitleChunk } & BridgeEnvelope)
  | ({ type: 'cookies'; payload: BridgeCookies } & BridgeEnvelope)
  | ({ type: 'pull-request'; payload: BridgePullRequest } & BridgeEnvelope)
  | ({ type: 'log'; level: 'info' | 'warn' | 'error'; message: string } & BridgeEnvelope)
  | ({ type: 'ping' } & BridgeEnvelope)

/* ----------------------------- 桌面端 → 插件 ----------------------------- */

export type ServerMessage =
  | ({
      type: 'hello-ack'
      server: string
      version: string
      protocol: number
      /** 桌面端支持的能力表（插件据此逐项判断，而不是只比版本号） */
      caps: BridgeCapabilities
      /** 桌面端希望插件在识别到页面后自动抓取字幕 */
      autoFetchSubtitles: boolean
      /** 桌面端设置了配对令牌时，插件需要在 hello 里带上它 */
      tokenRequired: boolean
      /** 本次握手是否已被拒绝（Origin 不在白名单） */
      rejected?: boolean
    } & BridgeEnvelope)
  | ({
      type: 'request-subtitles'
      bvid: string
      page: number
      cid?: number | null
      /** 一次请求多个缺失分P，避免多个浏览器标签重复抓取 */
      pages?: Array<{ page: number; cid: number | null }>
      /** 桌面端无法取得分P列表时，由浏览器枚举全部分P */
      allPages?: boolean
    } & BridgeEnvelope)
  | ({ type: 'pull-status'; bvid: string; stage: 'running' | 'fallback' | 'done' | 'error'; message: string } & BridgeEnvelope)
  | ({ type: 'subtitle-result'; bvid: string; page: number; lang: string; ok: boolean; message: string } & BridgeEnvelope)
  | ({ type: 'cookies-result'; ok: boolean; message: string } & BridgeEnvelope)
  | ({ type: 'ack'; ok: boolean; message?: string } & BridgeEnvelope)
  | ({ type: 'pong' } & BridgeEnvelope)

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
  /** 插件自报的协议版本（v5 信封里的 `v`；老插件按 1 记） */
  protocol: number
  /** 插件自报的能力表（握手时带上） */
  caps: BridgeCapabilities
}

/**
 * 消息类型 → 需要插件声明支持的能力。
 *
 * 有了它，桌面端可以**按能力**判断该不该处理这条消息，而不是只看类型：
 * 插件没声明支持某项能力却发来对应消息，会被直接丢弃并记一条日志 ——
 * 与「桌面端对不认识的消息静默丢弃」形成对称的契约。
 *
 * `log` / `ping` / `hello` 是基础信道，不需要能力声明。
 */
export function requiredCapability(type: ClientMessage['type']): BridgeCapability | null {
  switch (type) {
    case 'page-info':
      return BRIDGE_CAPABILITIES.pageInfo
    case 'subtitle':
      return BRIDGE_CAPABILITIES.subtitle
    case 'subtitle-chunk':
      return BRIDGE_CAPABILITIES.subtitleChunk
    case 'cookies':
      return BRIDGE_CAPABILITIES.cookies
    case 'pull-request':
      return BRIDGE_CAPABILITIES.pullRequest
    default:
      return null
  }
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

function parseSubtitleChunk(v: unknown): BridgeSubtitleChunk | null {
  if (!isObject(v)) return null
  const uploadId = str(v.uploadId, 64)
  const index = num(v.index, NaN)
  const total = num(v.total, NaN)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uploadId) ||
      !Number.isInteger(index) || !Number.isInteger(total) ||
      total < 2 || total > BRIDGE_LIMITS.maxChunkCount ||
      index < 0 || index >= total ||
      !Array.isArray(v.cues) || v.cues.length > BRIDGE_LIMITS.maxChunkCues) return null
  const sub = parseSubtitle(v)
  return sub ? { ...sub, uploadId, index, total } : null
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

  // 统一信封（v5）：每条消息都可以带版本与能力表。
  // 版本缺失按 1 处理（老插件不带），**只用来协商，不用来拒绝** ——
  // 真正决定「某个功能能不能用」的是能力表。
  const envelope: BridgeEnvelope = {
    v: Number.isFinite(Number(obj.v)) ? Math.max(1, Math.trunc(Number(obj.v))) : 1,
    caps: normalizeCapabilities(obj.caps)
  }

  switch (obj.type) {
    case 'hello':
      return {
        type: 'hello',
        ...envelope,
        version: str(obj.version, 32) || 'unknown',
        browser: str(obj.browser, 32) || 'unknown',
        token: typeof obj.token === 'string' ? obj.token.slice(0, 128) : undefined
      }

    case 'ping':
      return { type: 'ping', ...envelope }

    case 'log':
      return {
        type: 'log',
        ...envelope,
        level: LOG_LEVELS.includes(obj.level as 'info') ? (obj.level as 'info') : 'info',
        message: str(obj.message, BRIDGE_LIMITS.maxString)
      }

    case 'cookies': {
      const payload = parseCookies(obj.payload)
      return payload ? { type: 'cookies', ...envelope, payload } : null
    }

    case 'page-info': {
      const payload = parsePageInfo(obj.payload)
      return payload ? { type: 'page-info', ...envelope, payload } : null
    }

    case 'subtitle': {
      const payload = parseSubtitle(obj.payload)
      return payload ? { type: 'subtitle', ...envelope, payload } : null
    }

    case 'subtitle-chunk': {
      const payload = parseSubtitleChunk(obj.payload)
      return payload ? { type: 'subtitle-chunk', ...envelope, payload } : null
    }

    case 'pull-request': {
      if (!isObject(obj.payload)) return null
      const bvid = str(obj.payload.bvid, 32)
      // 没有合法 BV 号就没法拉，直接丢弃（宁可让插件那边超时，也不要发起一次无意义的抓取）
      if (!BV_RE.test(bvid)) return null
      return {
        type: 'pull-request',
        ...envelope,
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

/**
 * 序列化出站消息，并**自动补上统一信封**。
 *
 * 出站消息不必每个调用点手写 `v` / `caps`（漏写一处就是「协议形状不一致」），
 * 由这里统一补；调用方显式给了就以调用方为准（`hello-ack` 会带上 `caps`）。
 */
export function serialize(msg: ServerMessage): string {
  return JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    caps: serverCapabilities(),
    ...msg
  })
}

/** 桌面端支持的能力表（hello-ack 里发给插件做逐项协商） */
export function serverCapabilities(): BridgeCapabilities {
  return {
    [BRIDGE_CAPABILITIES.pageInfo]: true,
    [BRIDGE_CAPABILITIES.subtitle]: true,
    [BRIDGE_CAPABILITIES.cookies]: true,
    [BRIDGE_CAPABILITIES.subtitleChunk]: true,
    [BRIDGE_CAPABILITIES.pullRequest]: true,
    [BRIDGE_CAPABILITIES.requestSubtitles]: true
  }
}
