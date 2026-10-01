/**
 * 把浏览器插件通信事件接到业务处理上。
 * 抽成独立模块，便于在主进程和端到端测试中复用同一套接线逻辑。
 */
import * as bili from './bilibili'
import { bridge } from './bridge'
import { ingestPageInfo, ingestSubtitle } from './services'
import { saveSettings } from './settings'

export type PushFn = (channel: string, payload: unknown) => void

let wired = false

export function wireBridge(push: PushFn): void {
  if (wired) return
  wired = true

  bridge.on('status', (status) => push('bridge:status', status))

  bridge.on('page-info', (payload) => {
    try {
      const res = ingestPageInfo(payload)
      push('bridge:page-info', { info: payload, videoId: res.videoId, message: res.message })
    } catch (err) {
      push('bridge:log', { level: 'error', message: `页面信息入库失败：${(err as Error).message}` })
    }
  })

  bridge.on('subtitle', (payload) => {
    // 入库时可能要先查一次 B站视频信息（把字幕直接归到正确的 UP主 下），因此是异步的
    void (async () => {
      try {
        const res = await ingestSubtitle(payload)
        push('bridge:subtitle', {
          bvid: payload.bvid,
          page: payload.page,
          label: payload.label,
          ok: Boolean(res),
          docId: res?.docId ?? null,
          count: res?.count ?? 0,
          created: res?.created ?? false,
          unlinked: res?.unlinked ?? false,
          title: res?.title ?? ''
        })
      } catch (err) {
        push('bridge:log', { level: 'error', message: `字幕入库失败：${(err as Error).message}` })
      }
    })()
  })

  // 插件同步过来的登录凭证：写入设置后，桌面端即可自行调用 B 站接口
  bridge.on('cookies', (payload) => {
    void (async () => {
      try {
        const cookie = payload?.cookie?.trim()
        if (!cookie) {
          push('bridge:cookies', { ok: false, message: '插件未提供有效的登录凭证' })
          return
        }
        saveSettings({ biliCookie: cookie })

        // 用桌面端自己的实现复验一次，顺便拿到昵称
        let loggedIn = Boolean(payload.loggedIn)
        let userName = payload.userName ?? ''
        try {
          const res = await bili.checkLogin(cookie)
          loggedIn = res.loggedIn
          userName = res.name ?? userName
        } catch {
          /* 网络异常不影响凭证已保存 */
        }

        push('bridge:cookies', { ok: true, loggedIn, userName, count: payload.count ?? 0 })
      } catch (err) {
        push('bridge:cookies', { ok: false, message: (err as Error).message })
      }
    })()
  })

  bridge.on('log', (level, message) => push('bridge:log', { level, message }))
}

/** 仅供测试重置换线状态 */
export function resetWire(): void {
  wired = false
  bridge.removeAllListeners()
}
