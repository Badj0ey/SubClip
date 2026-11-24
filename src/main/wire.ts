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
const activePulls = new Set<string>()
const pullWaiters = new Map<string, Set<number>>()

function notifyPull(bvid: string, stage: 'running' | 'fallback' | 'done' | 'error', message: string, owner: number): void {
  for (const id of pullWaiters.get(bvid) ?? []) {
    const secondary = stage === 'fallback' && id !== owner
    bridge.sendToClient(id, {
      type: 'pull-status', bvid,
      stage: secondary ? 'done' : stage,
      message: secondary ? '另一个浏览器标签已接手补抓，请在该标签查看结果' : message
    })
  }
}

function askBrowser(
  bvid: string, owner: number, page: number,
  options: { pages?: Array<{ page: number; cid: number | null }>; allPages?: boolean }
): number | null {
  const candidates = new Set([owner, ...(pullWaiters.get(bvid) ?? [])])
  for (const id of candidates) {
    if (bridge.requestSubtitlesTo(id, bvid, page, null, options)) return id
  }
  return null
}

/** 把 Cookie 字符串拆成键值表（同名的后写覆盖先写，与浏览器的组织方式一致） */
function parseCookie(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of text.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    if (key) map.set(key, part.slice(eq + 1).trim())
  }
  return map
}

/**
 * 合并插件同步来的凭证与桌面端已存的凭证。
 *
 * 背景：插件在 GM_cookie 未授权时会回退 document.cookie，那是没有 HttpOnly
 * 键（SESSDATA 等）的子集。无条件覆盖会把桌面端已有的完整登录态悄悄降级。
 * 规则：新值里有的键以新值为准（用户主动同步的最新凭证）；旧值里有、新值里
 * 没有的键保留旧值（保住 HttpOnly 键）。
 */
function mergeBiliCookie(stored: string, incoming: string): string {
  const merged = parseCookie(stored)
  for (const [key, value] of parseCookie(incoming)) merged.set(key, value)
  return [...merged.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
}

/**
 * 判断两份凭证是不是「同一个登录身份」。
 *
 * 自动同步会在每次打开 B 站页面时跑一遍，而浏览器 cookie 里的 buvid3 / buvid4 之类
 * 会自己轮换 —— 全串比较几乎每次都不相等，于是界面每隔一会儿就弹一次「已同步」。
 * 真正决定登录态的是这几个键：它们没变，就没有必要重新探测、写盘、提示。
 */
function cookieIdentity(text: string): string {
  const map = parseCookie(text)
  return ['SESSDATA', 'DedeUserID', 'bili_jct']
    .map((key) => `${key}=${map.get(key) ?? ''}`)
    .join('&')
}

/**
 * 插件上报的「合集 / 系列 / 收藏夹 / 投稿页」。
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
      // 合集 / 系列 / 收藏夹 / 投稿页没有具体视频：不要建一条空条目，
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
          message: '检测到合集 / 系列 / 收藏夹 / 投稿页，等待用户确认是否批量拉取'
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
  bridge.on('pull-request', (payload, clientId) => {
    void (async () => {
      const bvid = String(payload?.bvid ?? '').trim()
      if (!bvid) return
      if (activePulls.has(bvid)) {
        pullWaiters.get(bvid)?.add(clientId)
        bridge.sendToClient(clientId, {
          type: 'pull-status', bvid, stage: 'running', message: '该视频正在拉取，请等待完成'
        })
        return
      }
      activePulls.add(bvid)
      pullWaiters.set(bvid, new Set([clientId]))
      notifyPull(bvid, 'running', '正在读取视频信息与全部分P字幕…', clientId)

      try {
        const res = await pullSubtitles(
          [{ bvid, title: String(payload?.title ?? '') }],
          (p) => push('bridge:pull-progress', p)
        )
        const pages = res.retryPages
          .filter((p) => p.bvid === bvid)
          .map(({ page, cid }) => ({ page, cid }))
        const allPages = res.retryAll.includes(bvid)
        const needsBrowser = allPages || pages.length > 0

        const fallbackClient = needsBrowser ? askBrowser(bvid, clientId, payload.page, {
          pages: allPages ? undefined : pages,
          allPages
        }) : null
        if (fallbackClient !== null) {
          notifyPull(bvid, 'fallback',
            `桌面端已处理可用字幕，另有${allPages ? '全部' : ` ${pages.length} 个`}分P交由浏览器补抓`, fallbackClient)
          push('bridge:pull', { bvid, ok: true, browserFallback: true, ...res })
          return
        }

        const ok = res.docs + res.updated > 0 || res.skipped > 0
        const message = ok ? '视频及字幕同步完成' :
          res.messages[0] || '未发现可用字幕；请确认视频存在 CC 字幕及账号访问权限'
        notifyPull(bvid, ok ? 'done' : 'error', message, clientId)
        push('bridge:pull', { bvid, ok, message, ...res })
      } catch (err) {
        const message = `桌面端拉取失败：${(err as Error).message}`
        const fallbackClient = askBrowser(bvid, clientId, payload.page, { allPages: true })
        if (fallbackClient !== null) {
          notifyPull(bvid, 'fallback', `${message}，已改用浏览器抓取`, fallbackClient)
          push('bridge:pull', { bvid, ok: true, browserFallback: true, message })
          return
        }
        notifyPull(bvid, 'error', message, clientId)
        push('bridge:pull', {
          bvid,
          ok: false,
          message
        })
      } finally {
        activePulls.delete(bvid)
        pullWaiters.delete(bvid)
      }
    })()
  })

  bridge.on('subtitle', (payload, clientId) => {
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
        bridge.sendToClient(clientId, {
          type: 'subtitle-result', bvid: payload.bvid, page: payload.page,
          lang: payload.lang, ok: Boolean(res),
          message: res ? `已入库 ${res.count} 行字幕` : '字幕内容为空，未入库'
        })
      } catch (err) {
        const message = `字幕入库失败：${(err as Error).message}`
        push('bridge:log', { level: 'error', message })
        bridge.sendToClient(clientId, {
          type: 'subtitle-result', bvid: payload.bvid, page: payload.page,
          lang: payload.lang, ok: false, message
        })
      }
    })()
  })

  // 插件同步过来的登录凭证：写入设置后，桌面端即可自行调用 B 站接口
  bridge.on('cookies', (payload, clientId) => {
    void (async () => {
      const reject = (message: string, extra: Record<string, unknown> = {}): void => {
        bridge.markCookieSynced(clientId, false)
        push('bridge:cookies', { ok: false, message, ...extra })
        bridge.sendToClient(clientId, {
          type: 'cookies-result', ok: false, kept: Boolean(extra.kept), message
        })
      }
      try {
        const cookie = payload?.cookie?.trim()
        if (!cookie) return reject('插件未提供有效的登录凭证')

        const current = (loadSettings().biliCookie ?? '').trim()
        // 同一份登录身份重复同步（打开每个 B 站页面都会自动来一次）：不写盘、不推送，
        // 否则界面会被「已同步」提示反复打扰，而其实什么都没变。
        // 但仍然要向 B站复核一次：凭证可能还在浏览器里、却已经被服务端判死
        // （改密码、别处退出登录），只比字符串是发现不了的 —— 这种「看起来已同步、
        // 实际早失效」正是切片静默掉到 480P 的典型现场。
        if (current && cookieIdentity(current) === cookieIdentity(cookie)) {
          const same = await bili.probeLogin(cookie, 1)
          if (same.state === 'out') {
            return reject('桌面端保存的登录凭证已被 B站判定失效（画质会被限制在 480P 以内）；请在浏览器里重新登录 B站，再点「同步登录状态」', {
              kept: true
            })
          }
          bridge.markCookieSynced(clientId, true)
          bridge.sendToClient(clientId, {
            type: 'cookies-result', ok: true, unchanged: true,
            loggedIn: same.state === 'in',
            message: same.state === 'in'
              ? '桌面端已是最新的登录状态，无需重复保存'
              : '桌面端已是最新的登录状态（本次未能向 B站复核，画质若偏低请再点一次「同步登录状态」）'
          })
          return
        }

        const probe = await bili.probeLogin(cookie)
        // 浏览器里的凭证可能已经失效（比如从旧设备、旧配置复制来的），而桌面端原来的凭证还有效。
        // 宁可不更新，也不能让坏凭证盖掉好凭证 —— 一旦盖掉，下一次切片就会掉到 480P。
        if (probe.state === 'out' && current) {
          // 这一枪只是「保住旧凭证」的兜底，用户在等回执，别重试太多次
          const kept = await bili.probeLogin(current, 1)
          if (kept.state === 'in') {
            return reject('浏览器里的 B站登录态已失效；桌面端原有凭证仍然有效，已保留未覆盖', {
              kept: true
            })
          }
        }

        // 合并而不是覆盖：插件回退到 document.cookie 时会缺 HttpOnly 键（SESSDATA 等），
        // 直接覆盖等于把桌面端完整的登录态降级成匿名。
        saveSettings({ biliCookie: mergeBiliCookie(current, cookie) })
        bridge.markCookieSynced(clientId, probe.state !== 'out')

        const loggedIn = probe.state === 'in'
        push('bridge:cookies', {
          ok: true,
          loggedIn,
          userName: probe.name ?? payload.userName ?? '',
          count: Number(payload.count) || 0
        })
        bridge.sendToClient(clientId, {
          type: 'cookies-result', ok: true, loggedIn,
          message: loggedIn
            ? '登录状态已保存到桌面端，切片可按账号权限取流'
            : probe.state === 'out'
              ? '凭证已保存，但 B站接口确认当前未登录（画质会被限制在 480P 以内）；请重新登录 B站后再点「同步登录状态」'
              : '凭证已保存，但暂时无法向 B站确认登录状态（网络异常）；若切片画质偏低请再点一次「同步登录状态」'
        })
      } catch (err) {
        reject(`登录状态保存失败：${(err as Error).message}`)
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

  /**
   * 插件版本太旧（低于自动同步登录态那一版）。
   * 必须让用户看见：老脚本不会主动送 Cookie，桌面端凭证过期后切片只会静默降到 480P。
   */
  bridge.on('userscript-old', (info) => push('bridge:userscript-old', info))
}

/** 仅供测试重置换线状态 */
export function resetWire(): void {
  wired = false
  activePulls.clear()
  pullWaiters.clear()
  bridge.removeAllListeners()
}
