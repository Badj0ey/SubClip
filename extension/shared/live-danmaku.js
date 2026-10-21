/**
 * 直播间弹幕「+1」。
 *
 * 做什么：在每一条直播弹幕右侧加一个点击区（默认透明，鼠标悬停该条弹幕时出现），
 * 点一下就把它**原样再发一遍**。
 *
 * 为什么不在别处放：需求里「+1」是给「看到一句好弹幕想跟着复读」用的，
 * 目标就是那一条，所以按钮必须长在那一条上，而不是固定在面板里。
 *
 * 发送接口：POST https://api.live.bilibili.com/msg/send（表单）
 *   必填：msg / roomid / csrf（= Cookie 里的 bili_jct）/ color / mode / fontsize /
 *         rnd / bubble / reply_mid / reply_attr / replay_dmid / statistics
 *   web_location 走 WBI 签名（拿不到签名就用未签名的，接口多数情况下也接受）
 *
 * 限流：服务端对同一账号的发弹幕频率有硬限制（太快会 code 10030/10031）。
 * 这里统一排队，任意两次之间至少间隔 1010ms；收到限流错误后整体冷却 6 秒。
 */

;(function (root) {
  const ns = (root.__SUBCLIP_EXT__ = root.__SUBCLIP_EXT__ || {})

  const SEND_API = 'https://api.live.bilibili.com/msg/send'
  const ROOM_INIT_API = 'https://api.live.bilibili.com/room/v1/Room/room_init'
  /** 两次发送的最小间隔，低于 1 秒基本必被限流 */
  const HARD_MIN_GAP_MS = 1010
  /** 排队上限，防止手滑狂点堆出几百条 */
  const MAX_QUEUE = 20
  /** 被限流后的冷却时间 */
  const COOLDOWN_MS = 6000
  /**
   * 弹幕条目的选择器。
   * 新版直播间（useNewDanmu）并不总是用 `.chat-item.danmaku-item`，所以再认一次
   * 「聊天区里带 data-danmaku 的元素」—— 这个属性是 B 站自己用来存原始弹幕文本的，
   * 新旧两套渲染都有，比类名稳。
   */
  const ITEM_SEL = '.chat-item.danmaku-item, .chat-items [data-danmaku]'
  const PLUS_CLASS = 'subclip-plus'
  /** 「复制」按钮的类名（对应参考实现里那个「偷」） */
  const COPY_CLASS = 'subclip-copy'
  /** 两个按钮的外层容器 */
  const ACTS_CLASS = 'subclip-acts'
  const MARK = 'data-subclip-plus'

  function cookie(name) {
    const hit = document.cookie.split('; ').find((s) => s.startsWith(name + '='))
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : ''
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  /** 直播间短号（URL 里的）→ 真实 room_id */
  async function resolveRoomId(shortId) {
    try {
      const res = await fetch(`${ROOM_INIT_API}?id=${shortId}`, { credentials: 'include' })
      const json = await res.json()
      if (json.code === 0 && json.data && json.data.room_id) return Number(json.data.room_id)
    } catch {
      /* 失败就用原值兜底 */
    }
    return Number(shortId) || 0
  }

  /**
   * 从弹幕 DOM 里取出要重发的内容。
   * 优先用 data-danmaku（原始文本，不带昵称/粉丝牌）；新版渲染偶尔没有这个属性，
   * 就退回视觉文本，并尽量剥掉开头的昵称。
   */
  function readItem(node) {
    let raw = String(node.dataset.danmaku || '').trim()
    if (!raw) {
      const body = node.querySelector('.danmaku-content') || node.querySelector('.danmaku-item-right') || node
      raw = String(body.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
      const uname = String(node.dataset.uname || '').trim()
      if (uname && raw.startsWith(uname)) raw = raw.slice(uname.length).replace(/^[:：\s]+/, '').trim()
    }
    return {
      text: raw,
      uname: String(node.dataset.uname || ''),
      isReply: String(node.dataset.replymid || '0') !== '0',
    }
  }

    /** 写剪贴板：优先 async API，失败退回 execCommand（老页面/无权限时仍能用） */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        return ok
      } catch {
        return false
      }
    }
  }

  /** 真正发一条弹幕 */
  async function sendDanmaku(roomId, text) {
    const csrf = cookie('bili_jct')
    if (!csrf) throw new Error('没有登录态（缺 bili_jct），请先在 B 站登录')

    const body = new FormData()
    body.set('bubble', '2')
    body.set('msg', text)
    body.set('color', '16777215')
    body.set('mode', '1')
    body.set('fontsize', '25')
    body.set('rnd', String(Math.floor(Date.now() / 1000)))
    body.set('roomid', String(roomId))
    body.set('csrf', csrf)
    body.set('csrf_token', csrf)
    body.set('reply_mid', '0')
    body.set('reply_attr', '0')
    body.set('replay_dmid', '')
    body.set('statistics', JSON.stringify({ appId: 100, platform: 5 }))
    body.set('jumpfrom', '0')
    body.set('room_type', '0')

    // web_location 尽量走 WBI 签名；签名拿不到就退回未签名
    let query = '?web_location=444.8'
    try {
      const wbi = ns.wbi
      if (wbi && wbi.getWbiKey) {
        const key = await wbi.getWbiKey()
        const signed = wbi.signWbi({ web_location: '444.8' }, key)
        query = '?' + new URLSearchParams(signed).toString()
      }
    } catch {
      /* 忽略：未签名也能发 */
    }

    const res = await fetch(SEND_API + query, {
      method: 'POST',
      credentials: 'include',
      body,
    })
    if (!res.ok) throw new Error(`发送接口 HTTP ${res.status}`)
    const json = await res.json()
    if (json.code !== 0) {
      const err = new Error(json.message || `发送失败 code=${json.code}`)
      err.code = json.code
      throw err
    }
    return true
  }

  /**
   * 创建 +1 功能。
   * @param {{onLog?: (text: string, level?: string) => void}} hooks
   */
  function createDanmakuPlus(hooks = {}) {
    const onLog = hooks.onLog || (() => {})

    let observer = null
    let chatRoot = null
    let enabled = false
    let roomId = 0
    let queue = []
    let running = false
    let lastSentAt = 0
    let cooldownUntil = 0
    let watchdog = null
    let destroyed = false

    async function initRoom() {
      if (roomId) return roomId
      const m = location.pathname.match(/^\/(?:blanc\/)?(\d+)/)
      const shortId = m ? Number(m[1]) : 0
      if (!shortId) throw new Error('这一页不是直播间')
      roomId = await resolveRoomId(shortId)
      return roomId
    }

    /** 按钮上的小提示：排队中/冷却中给个视觉反馈 */
    function setBadge(node, text) {
      const plus = node && node.querySelector('.' + PLUS_CLASS)
      if (plus) plus.dataset.badge = text || ''
    }

    async function drain() {
      if (running) return
      running = true
      try {
        while (queue.length) {
          if (destroyed) break
          const now = Date.now()
          if (now < cooldownUntil) {
            await sleep(cooldownUntil - now)
            continue
          }
          const gap = now - lastSentAt
          if (gap < HARD_MIN_GAP_MS) await sleep(HARD_MIN_GAP_MS - gap)

          const job = queue.shift()
          try {
            await sendDanmaku(job.roomId, job.text)
            lastSentAt = Date.now()
            setBadge(job.node, '✓')
            onLog(`+1 已发送：${job.text.slice(0, 20)}`, 'ok')
          } catch (err) {
            const code = err && err.code
            if (code === 10030 || code === 10031) {
              cooldownUntil = Date.now() + COOLDOWN_MS
              queue.unshift(job)
              onLog('发送太频繁，冷却 6 秒后重试', 'warn')
            } else {
              setBadge(job.node, '!')
              onLog(`+1 失败：${err.message || err}`, 'error')
            }
          }
          // 徽标 1.2 秒后自动消失
          const done = job
          setTimeout(() => {
            if (done.node) setBadge(done.node, '')
          }, 1200)
        }
      } finally {
        running = false
      }
    }

    function enqueue(node) {
      const info = readItem(node)
      if (!info.text) {
        setBadge(node, '×')
        setTimeout(() => setBadge(node, ''), 1200)
        return
      }
      if (queue.length >= MAX_QUEUE) {
        onLog('+1 排队太多了，先等等', 'warn')
        return
      }
      queue.push({ node, text: info.text, roomId })
      setBadge(node, '…')
      void drain()
    }

    /** 把「复制 / +1」两个小按钮挂到一条弹幕上 */
    function decorate(node) {
      if (node.hasAttribute(MARK)) return
      node.setAttribute(MARK, '1')
      // 挂到内容右侧；没有 .danmaku-item-right 就退回挂到条目本身
      const anchor = node.querySelector('.danmaku-item-right') || node

      const acts = document.createElement('span')
      acts.className = ACTS_CLASS

      // 复制：只把文本拷到剪贴板，不发送（参考实现里这一步叫「偷」，这里改成直白的名字）
      const copy = document.createElement('span')
      copy.className = COPY_CLASS
      copy.setAttribute('role', 'button')
      copy.setAttribute('tabindex', '0')
      copy.setAttribute('aria-label', '复制这条弹幕')
      copy.title = '复制这条弹幕的文字'
      copy.textContent = '复制'
      copy.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()
        const info = readItem(node)
        if (!info.text) {
          setBadge(node, '×')
          return
        }
        const ok = await copyToClipboard(info.text)
        copy.dataset.badge = ok ? '✓' : '!'
        onLog(ok ? `已复制：${info.text.slice(0, 20)}` : '复制失败，浏览器拒绝了剪贴板写入', ok ? 'ok' : 'error')
        setTimeout(() => {
          copy.dataset.badge = ''
        }, 1200)
      })
      copy.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          copy.click()
        }
      })

      const plus = document.createElement('span')
      plus.className = PLUS_CLASS
      plus.setAttribute('role', 'button')
      plus.setAttribute('tabindex', '0')
      plus.setAttribute('aria-label', '复读这条弹幕')
      plus.title = '点一下把这条弹幕再发一遍'
      plus.textContent = '+1'
      plus.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        enqueue(node)
      })
      plus.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          enqueue(node)
        }
      })

      acts.appendChild(copy)
      acts.appendChild(plus)
      // 有右侧内容容器就插在它后面（保持同行、跟在文本之后）；
      // 没有的话（新版渲染）直接挂进条目内部，别变成独占一行的兄弟节点
      if (anchor === node) node.appendChild(acts)
      else anchor.insertAdjacentElement('afterend', acts)
    }

    function scan(root = document) {
      if (!enabled) return
      const items = root.querySelectorAll ? root.querySelectorAll(ITEM_SEL) : []
      for (const node of items) decorate(node)
    }

    function attachObserver() {
      const root = document.querySelector('.chat-items')
      if (!root) return
      if (root === chatRoot && observer) return
      if (observer) observer.disconnect()
      chatRoot = root
      observer = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue
            if (n.matches && n.matches(ITEM_SEL)) decorate(n)
            else if (n.querySelectorAll) for (const x of n.querySelectorAll(ITEM_SEL)) decorate(x)
          }
        }
      })
      observer.observe(root, { childList: true, subtree: true })
      scan(root)
    }

    async function start() {
      enabled = true
      destroyed = false
      await initRoom()
      attachObserver()
      // B 站切换清晰度/刷新聊天区会重建 .chat-items，定时兜一下
      watchdog = setInterval(() => {
        if (!enabled) return
        attachObserver()
        if (!chatRoot) return
        // 兜底扫描：有些条目是原地复用的，不会触发 childList
        scan(chatRoot)
      }, 2500)
      onLog('弹幕 +1 已开启', 'ok')
    }

    function stop() {
      enabled = false
      if (observer) {
        observer.disconnect()
        observer = null
      }
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
      chatRoot = null
      for (const el of document.querySelectorAll('.' + ACTS_CLASS)) el.remove()
      for (const el of document.querySelectorAll('.' + PLUS_CLASS + ', .' + COPY_CLASS)) el.remove()
      for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK)
      queue = []
    }

    function destroy() {
      destroyed = true
      stop()
    }

    return { start, stop, destroy, stats: () => ({ enabled, queued: queue.length, roomId }) }
  }

  ns.liveDanmaku = { createDanmakuPlus, sendDanmaku, resolveRoomId, copyToClipboard }
})(typeof window !== 'undefined' ? window : globalThis)
