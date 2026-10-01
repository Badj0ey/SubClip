/**
 * 本地 WebSocket 服务端：监听 127.0.0.1:port，供浏览器插件连接。
 *
 * 职责：连接管理、协议收发、心跳保活；收到的业务数据通过事件抛给上层处理。
 * 事件：'status'（连接状态变化）、'page-info'、'subtitle'、'cookies'、'log'
 *
 * ⚠️ 安全模型（很重要）：
 * WebSocket 握手**不受 CORS 约束** —— 用户访问的任何网页都能向 `ws://127.0.0.1:端口` 发起连接。
 * 只绑 127.0.0.1 挡得住外部主机，挡不住本地网页。所以这里必须自己校验来源：
 *   1. **Origin 白名单**：只放行固定 ID 的自家扩展（见 `BRIDGE_EXTENSION_ID`）；
 *   2. **maxPayload**：限制单帧体积（`ws` 默认高达 100 MiB，足以打爆主进程内存）；
 *   3. **消息速率限制**：每个连接每秒超过上限即断开；
 *   4. **逐类型校验**：交给 `parseClientMessage`，不合法直接丢弃；
 *   5. **可选配对令牌**：设置里配了令牌时，hello 必须带上正确的值，否则只能握手不能发业务消息。
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  BridgeClientInfo,
  BridgeCookies,
  BridgePageInfo,
  BridgeStatus,
  BridgeSubtitle,
  ClientMessage,
  ServerMessage
} from '@shared/bridge'
import {
  BRIDGE_ALLOWED_ORIGINS,
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SERVER_NAME,
  parseClientMessage,
  serialize
} from '@shared/bridge'

interface Client {
  id: number
  socket: WebSocket
  info: BridgeClientInfo
  alive: boolean
  /** 速率限制窗口 */
  windowStart: number
  windowCount: number
}

export interface BridgeEvents {
  status: (status: BridgeStatus) => void
  'page-info': (payload: BridgePageInfo, clientId: number) => void
  subtitle: (payload: BridgeSubtitle, clientId: number) => void
  cookies: (payload: BridgeCookies, clientId: number) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

const HEARTBEAT_MS = 30_000

export interface BridgeOptions {
  /**
   * 允许的握手 Origin。默认只放行自家扩展。
   * 传空数组表示不校验 Origin（仅供测试；生产不要这么用）。
   */
  allowedOrigins?: string[]
  /** 配对令牌；非空时插件必须在 hello 里带上同样的值 */
  token?: string
}

export class BridgeServer extends EventEmitter {
  private wss: WebSocketServer | null = null
  private clients = new Map<number, Client>()
  private seq = 0
  private port = 0
  private running = false
  private error: string | null = null
  private lastEvent: { at: number; text: string } | null = null
  private heartbeat: NodeJS.Timeout | null = null

  /** 应用版本，用于握手回包 */
  version = '0.1.0'

  private allowedOrigins: string[] = [...BRIDGE_ALLOWED_ORIGINS]
  private token = ''

  /** 运行期可以调整（设置里改了端口/令牌后调用） */
  configure(options: BridgeOptions): void {
    if (options.allowedOrigins) this.allowedOrigins = [...options.allowedOrigins]
    if (options.token !== undefined) this.token = options.token.trim()
  }

  /** 某个 Origin 是否被允许（没有 Origin 头的是非浏览器客户端，放行） */
  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true
    if (!this.allowedOrigins.length) return true
    return this.allowedOrigins.includes(origin)
  }

  start(port: number): void {
    this.stop()
    this.port = port
    this.error = null

    try {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        // 默认值是 100 MiB，一条畸形帧就能把主进程内存打满
        maxPayload: BRIDGE_LIMITS.maxMessageBytes,
        perMessageDeflate: false
      })
      this.wss = wss

      wss.on('listening', () => {
        this.running = true
        this.error = null
        this.emit('status', this.status())
      })

      wss.on('connection', (socket, req) => this.handleConnection(socket, req))

      wss.on('error', (err: NodeJS.ErrnoException) => {
        this.running = false
        this.error =
          err.code === 'EADDRINUSE'
            ? `端口 ${port} 已被占用，请在设置中更换端口`
            : (err.message ?? String(err))
        this.emit('status', this.status())
      })

      this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS)
      this.heartbeat.unref?.()
    } catch (err) {
      this.running = false
      this.error = (err as Error).message
    }
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const c of this.clients.values()) {
      try {
        c.socket.close()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    if (this.wss) {
      try {
        this.wss.close()
      } catch {
        /* ignore */
      }
      this.wss = null
    }
    this.running = false
  }

  status(): BridgeStatus {
    return {
      running: this.running,
      port: this.port,
      error: this.error,
      clients: [...this.clients.values()].map((c) => c.info),
      lastEvent: this.lastEvent,
      protocol: BRIDGE_PROTOCOL_VERSION
    }
  }

  /** 向所有已连接（且通过了令牌校验）的插件广播 */
  broadcast(msg: ServerMessage): number {
    const text = serialize(msg)
    let n = 0
    for (const c of this.clients.values()) {
      if (c.info.authenticated && c.socket.readyState === 1) {
        try {
          c.socket.send(text)
          n++
        } catch {
          /* ignore */
        }
      }
    }
    return n
  }

  /** 请求插件去抓取某个分P 的字幕 */
  requestSubtitles(bvid: string, page: number, cid?: number | null): boolean {
    return (
      this.broadcast({
        type: 'request-subtitles',
        bvid,
        page,
        cid: cid ?? null
      }) > 0
    )
  }

  private touch(text: string): void {
    this.lastEvent = { at: Date.now(), text }
  }

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin

    const id = ++this.seq
    const info: BridgeClientInfo = {
      id,
      version: 'unknown',
      browser: 'unknown',
      connectedAt: Date.now(),
      remote: req.socket.remoteAddress ?? '',
      cookieSynced: false,
      origin: origin ?? '',
      // 没配令牌时默认就是「已认证」
      authenticated: !this.token
    }

    // 关键的一道闸门：拒绝来历不明的网页。握手已经被接受（WebSocket 无法在升级阶段
    // 优雅回绝），所以这里立刻告知原因并断开，不给它发任何数据。
    if (!this.isOriginAllowed(origin)) {
      this.touch(`拒绝了来源不明的连接：${origin ?? '未知来源'}`)
      try {
        this.sendRaw(socket, {
          type: 'hello-ack',
          server: BRIDGE_SERVER_NAME,
          version: this.version,
          protocol: BRIDGE_PROTOCOL_VERSION,
          autoFetchSubtitles: false,
          tokenRequired: Boolean(this.token),
          rejected: true
        })
        socket.close(1008, 'origin not allowed')
      } catch {
        /* ignore */
      }
      this.emit('status', this.status())
      return
    }

    const client: Client = { id, socket, info, alive: true, windowStart: Date.now(), windowCount: 0 }
    this.clients.set(id, client)
    this.touch(`插件 #${id} 已连接`)
    this.emit('status', this.status())

    socket.on('message', (raw) => {
      try {
        if (!this.allowMessage(client)) return
        const msg = parseClientMessage(raw.toString())
        if (!msg) {
          this.touch(`收到无法解析/不合法的消息 #${id}`)
          return
        }
        this.handleMessage(client, msg)
      } catch (err) {
        // 任何意外都不该把主进程带走（未捕获异常在 Electron 下会直接退出）
        this.emit('log', 'error', `处理插件消息失败：${(err as Error).message}`)
      }
    })

    socket.on('pong', () => {
      client.alive = true
    })

    socket.on('close', () => {
      this.clients.delete(id)
      this.touch(`插件 #${id} 已断开`)
      this.emit('status', this.status())
    })

    socket.on('error', () => {
      this.clients.delete(id)
      this.emit('status', this.status())
    })

    // 主动握手，让插件立即知道服务端就绪
    this.sendTo(client, this.helloAck())
  }

  /** 速率限制：固定窗口计数，超限直接断开 */
  private allowMessage(client: Client): boolean {
    const now = Date.now()
    if (now - client.windowStart >= 1000) {
      client.windowStart = now
      client.windowCount = 0
    }
    client.windowCount++
    if (client.windowCount > BRIDGE_LIMITS.maxMessagesPerSecond) {
      this.touch(`插件 #${client.id} 发送过于频繁，已断开`)
      this.clients.delete(client.id)
      try {
        client.socket.close(1008, 'too many messages')
      } catch {
        /* ignore */
      }
      this.emit('status', this.status())
      return false
    }
    return true
  }

  private helloAck(): ServerMessage {
    return {
      type: 'hello-ack',
      server: BRIDGE_SERVER_NAME,
      version: this.version,
      protocol: BRIDGE_PROTOCOL_VERSION,
      autoFetchSubtitles: true,
      tokenRequired: Boolean(this.token)
    }
  }

  private handleMessage(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello': {
        client.info.version = msg.version
        client.info.browser = msg.browser

        // 配了令牌就必须带上正确的值，否则只能握手、不能发业务消息
        if (this.token) {
          const ok = msg.token === this.token
          client.info.authenticated = ok
          if (!ok) {
            this.touch(`插件 #${client.id} 未通过令牌校验`)
            this.sendTo(client, { type: 'ack', ok: false, message: '配对令牌不正确' })
            this.emit('status', this.status())
            break
          }
        }

        this.touch(`插件 #${client.id} 握手（${client.info.browser} v${client.info.version}）`)
        this.sendTo(client, this.helloAck())
        this.emit('status', this.status())
        break
      }

      case 'page-info':
      case 'subtitle':
      case 'cookies': {
        if (!this.requireAuth(client)) break

        if (msg.type === 'page-info') {
          this.touch(`收到页面信息：${msg.payload.title || msg.payload.bvid || '未知'}`)
          this.emit('page-info', msg.payload, client.id)
          this.sendTo(client, { type: 'ack', ok: true, message: '页面信息已接收' })
          break
        }

        if (msg.type === 'subtitle') {
          this.touch(`收到字幕：${msg.payload.bvid} P${msg.payload.page} ${msg.payload.label}`)
          this.emit('subtitle', msg.payload, client.id)
          this.sendTo(client, { type: 'ack', ok: true, message: '字幕已接收' })
          break
        }

        client.info.cookieSynced = true
        // 注意：不要把 cookie 内容写进事件文本，避免泄漏到日志
        this.touch(
          `插件 #${client.id} 同步了 B 站登录凭证${msg.payload.userName ? `（${msg.payload.userName}）` : ''}`
        )
        this.emit('cookies', msg.payload, client.id)
        this.sendTo(client, { type: 'ack', ok: true, message: '登录凭证已接收' })
        this.emit('status', this.status())
        break
      }

      case 'log': {
        this.emit('log', msg.level, msg.message)
        break
      }

      case 'ping': {
        this.sendTo(client, { type: 'pong' })
        break
      }

      default:
        break
    }
  }

  /** 业务消息一律要求已通过令牌校验 */
  private requireAuth(client: Client): boolean {
    if (client.info.authenticated) return true
    this.sendTo(client, { type: 'ack', ok: false, message: '请先在插件里填写配对令牌' })
    return false
  }

  private sendRaw(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState !== 1) return
    socket.send(serialize(msg))
  }

  private sendTo(client: Client, msg: ServerMessage): void {
    if (client.socket.readyState !== 1) return
    try {
      client.socket.send(serialize(msg))
    } catch {
      /* ignore */
    }
  }

  /** 心跳：清掉没有响应的连接 */
  private sweep(): void {
    for (const [id, c] of this.clients) {
      if (!c.alive) {
        this.clients.delete(id)
        try {
          c.socket.terminate()
        } catch {
          /* ignore */
        }
        continue
      }
      c.alive = false
      try {
        c.socket.ping()
      } catch {
        /* ignore */
      }
    }
  }
}

export const bridge = new BridgeServer()
