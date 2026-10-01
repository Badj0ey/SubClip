/**
 * 本地 WebSocket 服务端：监听 127.0.0.1:port，供浏览器插件连接。
 *
 * 职责：连接管理、协议收发、心跳保活；收到的业务数据通过事件抛给上层处理。
 * 事件：'status'（连接状态变化）、'page-info'、'subtitle'、'log'
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
}

export interface BridgeEvents {
  status: (status: BridgeStatus) => void
  'page-info': (payload: BridgePageInfo, clientId: number) => void
  subtitle: (payload: BridgeSubtitle, clientId: number) => void
  cookies: (payload: BridgeCookies, clientId: number) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

const HEARTBEAT_MS = 30_000

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

  start(port: number): void {
    this.stop()
    this.port = port
    this.error = null

    try {
      const wss = new WebSocketServer({ host: '127.0.0.1', port })
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

  /** 向所有已连接插件广播 */
  broadcast(msg: ServerMessage): number {
    const text = serialize(msg)
    let n = 0
    for (const c of this.clients.values()) {
      if (c.socket.readyState === 1) {
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
    const id = ++this.seq
    const info: BridgeClientInfo = {
      id,
      version: 'unknown',
      browser: 'unknown',
      connectedAt: Date.now(),
      remote: req.socket.remoteAddress ?? '',
      cookieSynced: false
    }
    const client: Client = { id, socket, info, alive: true }
    this.clients.set(id, client)
    this.touch(`插件 #${id} 已连接`)
    this.emit('status', this.status())

    socket.on('message', (raw) => {
      const msg = parseClientMessage(raw.toString())
      if (!msg) {
        this.touch(`收到无法解析的消息 #${id}`)
        return
      }
      this.handleMessage(client, msg)
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
    this.sendTo(client, {
      type: 'hello-ack',
      server: BRIDGE_SERVER_NAME,
      version: this.version,
      protocol: BRIDGE_PROTOCOL_VERSION,
      autoFetchSubtitles: true
    })
  }

  private handleMessage(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello': {
        client.info.version = String(msg.version ?? 'unknown')
        client.info.browser = String(msg.browser ?? 'unknown')
        this.touch(`插件 #${client.id} 握手（${client.info.browser} v${client.info.version}）`)
        this.sendTo(client, {
          type: 'hello-ack',
          server: BRIDGE_SERVER_NAME,
          version: this.version,
          protocol: BRIDGE_PROTOCOL_VERSION,
          autoFetchSubtitles: true
        })
        this.emit('status', this.status())
        break
      }
      case 'page-info': {
        this.touch(`收到页面信息：${msg.payload?.title || msg.payload?.bvid || '未知'}`)
        this.emit('page-info', msg.payload, client.id)
        this.sendTo(client, { type: 'ack', ok: true, message: '页面信息已接收' })
        break
      }
      case 'subtitle': {
        this.touch(`收到字幕：${msg.payload?.bvid} P${msg.payload?.page} ${msg.payload?.label}`)
        this.emit('subtitle', msg.payload, client.id)
        this.sendTo(client, { type: 'ack', ok: true, message: '字幕已接收' })
        break
      }
      case 'cookies': {
        const payload = msg.payload
        client.info.cookieSynced = Boolean(payload?.cookie)
        // 注意：不要把 cookie 内容写进事件文本，避免泄漏到日志
        this.touch(
          `插件 #${client.id} 同步了 B 站登录凭证${payload?.userName ? `（${payload.userName}）` : ''}`
        )
        this.emit('cookies', payload, client.id)
        this.sendTo(client, { type: 'ack', ok: true, message: '登录凭证已接收' })
        this.emit('status', this.status())
        break
      }
      case 'log': {
        this.emit('log', msg.level ?? 'info', msg.message ?? '')
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
