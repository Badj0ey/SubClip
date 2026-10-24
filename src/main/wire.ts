/**
 * 把浏览器插件通信事件接到业务处理上。
 * 抽成独立模块，便于在主进程和端到端测试中复用同一套接线逻辑。
 */
import * as bili from './bilibili'
import { bridge } from './bridge'
import { ingestPageInfo, ingestSubtitle, pullSubtitles } from './services'
import { loadSettings, saveSettings } from './settings'

export type PushFn = (channel: string, payload: unknown) => void

let wired = false

/**
 * 插件上报的「合集 / 收藏夹 / 投稿页」。
 * 这类页面没有具体 BV 号，桌面端不建条目，而是交给界面提示用户「是否批量拉取」。
 */
export interface CollectionHint {
  pageType: string
  /** 合集 / 收藏夹 / 系列的 id */
  seasonId: number | null
  uid: number | null
  title: string
  /** 原始页面地址，直接喂给 resolveTarget 解析（省得在两边各拼一次 URL） */
  url: string
}

export function wireBridge(push: PushFn): void {
  if (wired) return
  wired = true

  bridge.on('status', (status) => push('bridge:status', status))

  bridge.on('page-info', (payload) => {
    try {
      // 合集 / 收藏夹 / 投稿页没有具体视频：不要建一条空条目，
      // 而是把「这里有整包内容」告诉界面，由用户决定要不要批量拉。
      if (!String(payload?.bvid ?? '').trim()) {
        const hint: CollectionHint = {
          pageType: payload?.pageType ?? 'unknown',
          seasonId: payload?.seasonId ?? null,
          uid: payload?.uploader?.uid ?? null,
          title: payload?.seasonTitle?.trim() || payload?.title?.trim() || '',
          url: payload?.url ?? ''
        }
        push('bridge:page-info', {
          info: payload,
          videoId: null,
          message: '检测到合集 / 收藏夹 / 投稿页，等待用户确认是否批量拉取'
        })
        if (hint.url) push('bridge:collection', hint)
        return
      }

      const res = ingestPageInfo(payload)
      push('bridge:page-info', { info: payload, videoId: res.videoId, message: res.message })
    } catch (err) {
      push('bridge:log', { level: 'error', message: `页面信息入库失败：${(err as Error).message}` })
    }
  })

  /**
   * 插件请桌面端拉某个视频的字幕。
   * 这里是「不管用户在哪个分P 触发，都拉该视频全部分P」的落点 ——
   * `pullSubtitles` 内部会遍历 `info.pages` 并按「分P + 语言」跳过已有的。
   */
  bridge.on('pull-request', (payload) => {
    void (async () => {
      const bvid = String(payload?.bvid ?? '').trim()
      if (!bvid) return

      // 桌面端要自己直连 B 站接口，必须先有登录态
      if (!loadSettings().biliCookie.trim()) {
        push('bridge:pull', {
          bvid,
          ok: false,
          needCookie: true,
          message: '桌面端还没有 B 站登录状态，请先在 B 站左下角浮框里点「同步登录状态」'
        })
        return
      }

      try {
        const res = await pullSubtitles(
          [{ bvid, title: String(payload?.title ?? '') }],
          (p) => push('bridge:pull-progress', p)
        )
        push('bridge:pull', { bvid, ok: true, ...res })
      } catch (err) {
        push('bridge:pull', {
          bvid,
          ok: false,
          message: `拉取失败：${(err as Error).message}`
        })
      }
    })()
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

  /**
   * 插件协议版本高于桌面端（第七阶段）。
   * 转发给渲染进程弹一次提示 ——「新功能悄悄不可用」是版本倒挂最典型的后果，
   * 而这种信息只写在 `lastEvent` 里用户看不到。
   */
  bridge.on('version-skew', (info) => push('bridge:version-skew', info))
}

/** 仅供测试重置换线状态 */
export function resetWire(): void {
  wired = false
  bridge.removeAllListeners()
}
