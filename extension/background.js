/**
 * Service Worker：
 *   1. 维护到桌面端（ws://127.0.0.1:port）的长连接，断线自动重连
 *   2. 接收 content script 上报的页面信息，补全后转发给桌面端
 *   3. 响应字幕抓取请求：把「需要 Cookie 的接口调用」交给页面上下文执行，
 *      字幕文件本体（CDN 资源，不需要 Cookie）由扩展侧下载
 */
import {
  CAPABILITY,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  detectBrowser,
  parse,
  peerSupports
} from './shared/protocol.js'
import { fetchSubtitleJson } from './shared/bilibili.js'

const RECONNECT_MAX = 30_000
const ALARM_NAME = 'srt-helper-keepalive'

let ws = null
let reconnectDelay = 1000
let reconnectTimer = null

/** 自动同步登录状态的开关（chrome.storage.local，默认开启） */
const AUTO_COOKIE_KEY = 'scAutoCookie'

const state = {
  connected: false,
  port: DEFAULT_PORT,
  /** 与桌面端约定的配对令牌（桌面端没设就留空） */
  token: '',
  serverVersion: '',
  /**
   * 桌面端上报的协议版本。
   * 用来做能力协商：桌面端对不认识的客户端消息是**静默丢弃**的，
   * 不看版本号的话插件会以为发送成功、实际什么都不会发生。
   */
  serverProtocol: 0,
  /** 桌面端自报的能力表（v5；老桌面端为空对象） */
  serverCaps: {},
  lastError: '',
  lastPage: null,
  lastSync: null,
  /** 最近一次登录凭证同步结果 */
  cookieSync: null,
  events: []
}

/* ------------------------------- 状态与日志 ------------------------------- */

function pushEvent(text, level = 'info') {
  state.events.unshift({ at: Date.now(), text, level })
  state.events = state.events.slice(0, 30)
  if (level === 'error') console.warn('[srt-helper]', text)
}

function getStatus() {
  return {
    connected: state.connected,
    port: state.port,
    token: state.token,
    serverVersion: state.serverVersion,
    lastError: state.lastError,
    lastPage: state.lastPage,
    lastSync: state.lastSync,
    cookieSync: state.cookieSync,
    events: state.events,
    version: chrome.runtime.getManifest().version
  }
}

/* ----------------------------- 请求头注入规则 ----------------------------- */

async function ensureHeaderRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
              { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' }
            ]
          },
          condition: {
            urlFilter: '||hdslb.com',
            resourceTypes: ['xmlhttprequest', 'other']
          }
        }
      ]
    })
  } catch (err) {
    pushEvent(`请求头规则注册失败：${err.message}`, 'error')
  }
}

/* -------------------------------- 连接管理 -------------------------------- */

function sendToServer(msg) {
  if (!ws || ws.readyState !== 1) return false
  try {
    ws.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(RECONNECT_MAX, Math.round(reconnectDelay * 1.6))
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return

  let socket
  try {
    socket = new WebSocket(`ws://127.0.0.1:${state.port}`)
  } catch (err) {
    state.lastError = `无法创建连接：${err.message}`
    scheduleReconnect()
    return
  }
  ws = socket

  socket.onopen = () => {
    state.connected = true
    state.lastError = ''
    reconnectDelay = 1000
    pushEvent(`已连接本地服务 127.0.0.1:${state.port}`)
    sendToServer({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      browser: detectBrowser(),
      ...(state.token ? { token: state.token } : {})
    })

  }

  socket.onmessage = (ev) => {
    const msg = parse(typeof ev.data === 'string' ? ev.data : '')
    if (msg) handleServerMessage(msg)
  }

  socket.onerror = () => {
    state.lastError = '连接失败，请确认桌面端已启动'
  }

  socket.onclose = () => {
    const wasConnected = state.connected
    state.connected = false
    ws = null
    if (wasConnected) pushEvent('与本地服务的连接已断开', 'warn')
    scheduleReconnect()
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'hello-ack':
      // 桌面端会校验握手来源，来源不在白名单时直接告知并断开
      if (msg.rejected) {
        state.serverVersion = ''
        state.lastError = '桌面端拒绝了本次连接（来源校验未通过）'
        pushEvent('连接被桌面端拒绝：扩展 ID 与桌面端白名单不一致', 'error')
        break
      }
      state.serverVersion = msg.version || ''
      state.serverProtocol = Number(msg.protocol) || 0
      // v5 起以**能力表**为准：版本号只表达整体兼容性，能不能用某个功能看 caps
      state.serverCaps = (msg.caps && typeof msg.caps === 'object') ? msg.caps : {}
      if (msg.tokenRequired && !state.token) {
        state.lastError = '桌面端已开启配对令牌，请在下面填写'
        pushEvent('桌面端要求配对令牌，请在「配对令牌」里填入桌面端设置页显示的值', 'warn')
      } else if (!peerSupports(msg, CAPABILITY.PULL_REQUEST)) {
        // 兼容两条路径：新桌面端给 caps，老桌面端只有 protocol
        pushEvent(
          `桌面端协议 v${state.serverProtocol} 低于插件所需的 v${PROTOCOL_VERSION}，` +
            '「让桌面端拉取全部分P」等功能不可用，请更新桌面端',
          'warn'
        )
      } else {
        pushEvent(`握手成功（桌面端 v${msg.version}，协议 v${state.serverProtocol}）`)
        void maybeAutoSyncCookies()
      }
      break
    case 'request-subtitles':
      void fetchAndSend(msg.bvid, msg.page, msg.cid)
      break
    case 'ack':
      if (msg.message) pushEvent(msg.message, msg.ok === false ? 'warn' : 'info')
      break
    default:
      break
  }
}

/* -------------------------------- 登录凭证 -------------------------------- */

/** 关键字段优先，其余字段也一并带上，兼容不同接口的校验 */
const COOKIE_PRIORITY = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4'
]

/** 读取浏览器里的 B站 Cookie 并拼成 Cookie 头字符串 */
async function collectCookies() {
  const urls = [
    'https://www.bilibili.com/',
    'https://api.bilibili.com/',
    'https://space.bilibili.com/'
  ]
  const map = new Map()
  for (const url of urls) {
    try {
      const list = await chrome.cookies.getAll({ url })
      for (const c of list) {
        if (!c?.name) continue
        map.set(c.name, c.value ?? '')
      }
    } catch (err) {
      console.warn('[srt-helper] 读取 Cookie 失败', url, err)
    }
  }

  const parts = []
  for (const name of COOKIE_PRIORITY) {
    if (map.has(name)) parts.push(`${name}=${map.get(name)}`)
  }
  for (const [name, value] of map) {
    if (!COOKIE_PRIORITY.includes(name)) parts.push(`${name}=${value}`)
  }

  return {
    cookie: parts.join('; '),
    count: map.size,
    hasSession: map.has('SESSDATA')
  }
}

/** 实时检测浏览器登录态：只读本地 Cookie，不发网络请求，也不同步给桌面端 */
async function checkLoginState() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://www.bilibili.com/' })
    const sess = cookies.find((c) => c.name === 'SESSDATA')
    const dede = cookies.find((c) => c.name === 'DedeUserID')
    return {
      ok: true,
      loggedIn: Boolean(sess?.value),
      /** UP主 / 账号 UID（对应 B站接口的 mid） */
      uid: dede?.value || '',
      count: cookies.length
    }
  } catch (err) {
    return { ok: false, loggedIn: false, message: err.message }
  }
}

/** 把浏览器登录态同步给桌面端（桌面端据此自行调用 B站接口） */
async function syncCookies() {
  try {
    const { cookie, count, hasSession } = await collectCookies()
    if (!cookie) {
      pushEvent('没有读取到 B 站 Cookie，请先在浏览器登录 B 站', 'warn')
      return { ok: false, message: '没有读取到 Cookie，请先登录 B 站' }
    }

    const sent = sendToServer({
      type: 'cookies',
      payload: { cookie, count, loggedIn: hasSession, userName: '' }
    })

    if (!sent) {
      pushEvent('桌面端未连接，登录凭证未发送', 'warn')
      return { ok: false, message: '桌面端未连接' }
    }

    state.cookieSync = { at: Date.now(), count, loggedIn: hasSession }
    pushEvent(
      hasSession
        ? `已同步登录凭证（${count} 项）`
        : `已同步 Cookie（${count} 项），但未发现 SESSDATA，可能尚未登录`
    )
    return { ok: true, count, loggedIn: hasSession }
  } catch (err) {
    pushEvent(`同步登录凭证失败：${err.message}`, 'error')
    return { ok: false, message: err.message }
  }
}


/**
 * 连上桌面端后自动同步一次登录状态。
 *
 * 为什么要自动：拉取字幕完全依赖桌面端自己持有 Cookie，用户装完插件
 * 大概率想不起来单独点一次「同步登录状态」，于是第一次拉取静默失败。
 * 自动同步一次能把这个坑填掉；担心隐私的话可以在设置页关掉。
 * 每次后台启动只自动做一次，避免重连时反复上报凭证。
 */
let autoCookieSynced = false
async function maybeAutoSyncCookies() {
  if (autoCookieSynced) return
  autoCookieSynced = true
  let enabled = true
  try {
    const v = await chrome.storage.local.get(AUTO_COOKIE_KEY)
    if (v && v[AUTO_COOKIE_KEY] === false) enabled = false
  } catch {
    /* 读不到设置就按默认开启 */
  }
  if (!enabled) return
  if (state.cookieSync && Date.now() - state.cookieSync.at < 60_000) return
  await syncCookies()
}

/* ------------------------------ 标签页与页面 ------------------------------ */

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForTabReady(tabId, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('标签页加载超时'))
    }, timeout)
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        cleanup()
        resolve()
      }
    }
    function cleanup() {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}

/**
 * 拿到一个可用于调用 B 站接口的页面。
 * 只要页面在 bilibili.com 域下即可（同站，Cookie 一致），不要求正好是目标视频页。
 * 返回 { tabId, created }。
 */
async function ensureBiliTab() {
  const tabs = await chrome.tabs.query({ url: ['*://*.bilibili.com/*'] })
  if (tabs.length) {
    const active = tabs.find((t) => t.active)
    const chosen = active || tabs[0]
    return { tabId: chosen.id, created: false }
  }

  const created = await chrome.tabs.create({
    url: 'https://www.bilibili.com/',
    active: false
  })
  try {
    await waitForTabReady(created.id)
  } catch {
    await wait(1500)
  }
  return { tabId: created.id, created: true }
}

/**
 * 给 Promise 加超时。
 * 没有超时的话，内容脚本不响应（页面卡住 / 脚本被卸载）会让弹窗永远停在「抓取中…」。
 */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ])
}

/** 让页面上下文调用接口拿字幕轨；若内容脚本未注入则先注入 */
async function askPageForTracks(tabId, bvid, page) {
  const payload = { type: 'collect-tracks', bvid, page }
  // 页面里要连着调 view + player 两个接口，给宽一点
  const ask = () =>
    withTimeout(chrome.tabs.sendMessage(tabId, payload), 25_000, '页面内接口调用超时')
  try {
    return await ask()
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    await wait(700)
    return await ask()
  }
}

/* ------------------------------- 业务动作 -------------------------------- */

/**
 * 记录页面信息（**不**推送给桌面端）。
 * 页面切换只更新本地状态供弹窗展示，真正同步由用户在弹窗里手动触发。
 */
function handlePageDetected(info) {
  state.lastPage = { ...info, at: Date.now() }
  return getStatus()
}

/** 用户点击「同步到桌面端」时才真正发送当前页面信息 */
async function syncPage() {
  const info = state.lastPage
  if (!info) {
    return { ok: false, message: '尚未识别到页面，请先打开 B 站页面' }
  }
  if (!sendToServer({ type: 'page-info', payload: info })) {
    pushEvent('桌面端未连接，页面信息未发送', 'warn')
    return { ok: false, message: '桌面端未连接' }
  }
  pushEvent(`已同步页面：${info.title || info.bvid || info.pageType}`)
  return { ok: true, ...getStatus() }
}

/**
 * 请桌面端拉取某个视频的全部分P。
 *
 * 抽成函数是因为「工具箱的一键同步」和 popup 的按钮都要用它。
 * 桌面端对不认识的客户端消息是静默丢弃的，所以先按能力表判断，
 * 否则插件会报「发送成功」而桌面端什么都不会做。
 */
function requestPull(bvid, page, title) {
  const canPull =
    state.serverCaps && Object.keys(state.serverCaps).length > 0
      ? peerSupports({ caps: state.serverCaps }, CAPABILITY.PULL_REQUEST)
      : state.serverProtocol >= 5
  if (state.connected && !canPull) {
    return {
      ok: false,
      message: `桌面端协议 v${state.serverProtocol} 不支持该功能，请更新桌面端`,
    }
  }
  const sent = sendToServer({
    type: 'pull-request',
    payload: { bvid, page: Number(page || 1), title: title || '' },
  })
  if (!sent) {
    return { ok: false, message: '桌面端未连接，请先启动桌面端并重连' }
  }
  pushEvent(`已请桌面端拉取 ${bvid} 的全部分P`)
  return { ok: true, message: `已请桌面端拉取 ${bvid} 的全部分P，进度见桌面端顶部` }
}

const PAGE_TYPE_LABEL = {
  video: '视频',
  season: '合集',
  series: '系列',
  favlist: '收藏夹',
  space: 'UP主投稿',
  live: '直播间',
  unknown: '未知',
}

/**
 * 「一键同步」：按当前页面类型挑最合适的动作，用户不用自己判断该点哪个按钮。
 *   - 视频页 → 只送 BV，由桌面端拉这个视频的**全部分P**（抓取在桌面端做，不拖慢浏览器）
 *   - 合集 / 系列 / 收藏夹 / 投稿页 → 把页面信息交给桌面端解析出视频清单，桌面端会弹确认框
 */
async function syncAll() {
  const info = state.lastPage
  if (!info) return { ok: false, message: '尚未识别到页面，请先打开 B 站页面' }
  if (!state.connected) return { ok: false, message: '桌面端未连接，请先启动桌面端' }

  if (info.pageType === 'video' && info.bvid) {
    return requestPull(info.bvid, info.page || 1, info.title || '')
  }
  if (info.pageType === 'live') {
    return { ok: false, message: '直播间没有字幕可同步' }
  }

  const label = PAGE_TYPE_LABEL[info.pageType] || '该'
  const r = await syncPage()
  if (!r.ok) return r
  pushEvent(`已把${label}页交给桌面端解析视频清单`)
  return { ok: true, message: `已交给桌面端解析这个${label}的视频清单，请到桌面端确认` }
}

/** 抓取字幕：接口调用走页面，字幕文件下载走扩展 */
async function fetchAndSend(bvid, page, cid) {
  let createdTabId = null
  try {
    pushEvent(`开始抓取字幕：${bvid} P${page || 1}`)

    const { tabId, created } = await ensureBiliTab()
    if (created) createdTabId = tabId

    const res = await askPageForTracks(tabId, bvid, page || 1)
    if (!res?.ok) throw new Error(res?.message || '页面内接口调用失败')

    const tracks = res.tracks || []
    if (!tracks.length) {
      const loggedIn = await checkLogin(tabId)
      throw new Error(
        loggedIn
          ? '该分P 没有可用字幕（可能需要大会员 / 视频无 CC 字幕）'
          : '未在浏览器中登录 B 站，请先登录后重试'
      )
    }

    let sent = 0
    const failures = []
    for (const t of tracks) {
      try {
        const json = await fetchSubtitleJson(t.url)
        const cues = (json.body || [])
          .filter((c) => String(c?.content ?? '').trim())
          .map((c) => ({
            from: Number(c.from) || 0,
            to: Number(c.to) || 0,
            content: String(c.content).trim()
          }))
        if (!cues.length) continue
        sendToServer({
          type: 'subtitle',
          payload: { bvid, page: res.page, lang: t.lang, label: t.label || t.lang, cues }
        })
        sent++
      } catch (err) {
        failures.push(`${t.label || t.lang}：${err.message}`)
      }
    }

    if (!sent) {
      throw new Error(failures.length ? `字幕下载失败（${failures[0]}）` : '字幕内容为空')
    }

    state.lastSync = { at: Date.now(), bvid, page: res.page, count: sent }
    pushEvent(`已推送 ${sent} 条字幕轨${failures.length ? `（${failures.length} 条失败）` : ''}`)
    return { ok: true, count: sent }
  } catch (err) {
    state.lastError = err.message
    pushEvent(`抓取字幕失败：${err.message}`, 'error')
    return { ok: false, message: err.message }
  } finally {
    if (createdTabId !== null) {
      try {
        await chrome.tabs.remove(createdTabId)
      } catch {
        /* ignore */
      }
    }
  }
}

/** 借页面上下文判断登录态（同样是为了带上 Cookie） */
async function checkLogin(tabId) {
  try {
    const [result] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
            credentials: 'include',
            signal: AbortSignal.timeout(10_000)
          })
          const d = await r.json()
          return Boolean(d?.data?.isLogin)
        }
      }),
      15_000,
      '登录状态检测超时'
    )
    return Boolean(result?.result)
  } catch {
    return false
  }
}

/* --------------------------------- 生命周期 -------------------------------- */

async function bootstrap() {
  const stored = await chrome.storage.local.get(['port', 'token'])
  state.port = Number(stored.port) || DEFAULT_PORT
  state.token = typeof stored.token === 'string' ? stored.token : ''
  await ensureHeaderRules()
  connect()
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) connect()
})

chrome.runtime.onStartup.addListener(() => void bootstrap())
chrome.runtime.onInstalled.addListener(() => void bootstrap())

void bootstrap()

/* ------------------------------- 消息路由 -------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'page-detected':
      sendResponse(handlePageDetected(msg.payload))
      return true

    case 'get-status':
      sendResponse(getStatus())
      return true

    case 'set-port': {
      const port = Number(msg.port) || DEFAULT_PORT
      state.port = port
      chrome.storage.local.set({ port })
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        ws = null
      }
      state.connected = false
      reconnectDelay = 1000
      connect()
      sendResponse(getStatus())
      return true
    }

    case 'set-token': {
      // 配对令牌改了要重连，重新握手时才带得上新值
      state.token = typeof msg.token === 'string' ? msg.token.trim() : ''
      chrome.storage.local.set({ token: state.token })
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        ws = null
      }
      state.connected = false
      reconnectDelay = 1000
      connect()
      sendResponse(getStatus())
      return true
    }

    case 'reconnect':
      state.lastError = ''
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        ws = null
      }
      reconnectDelay = 1000
      state.connected = false
      connect()
      sendResponse(getStatus())
      return true

    case 'sync-now':
      syncPage().then(sendResponse)
      return true

    case 'fetch-subtitles': {
      fetchAndSend(msg.bvid, msg.page, msg.cid).then(sendResponse)
      return true
    }

    /**
     * 请桌面端拉取该视频的字幕。
     *
     * 与 fetch-subtitles 的区别：抓取动作交给桌面端做，因此会**拉取全部分P**
     * （桌面端的 pullSubtitles 会遍历 pages，并按「分P + 语言」跳过已有的）。
     * 插件只把「是哪个视频」告诉桌面端即可，不必在页面里循环调接口、拖慢浏览器。
     */
    case 'pull-video': {
      const page = state.livePage || state.lastPage
      const bvid = msg.bvid || page?.bvid
      if (!bvid) {
        sendResponse({ ok: false, message: '当前页面没有识别到 BV 号' })
        return true
      }
      sendResponse(requestPull(bvid, msg.page || page?.page || 1, page?.title || ''))
      return true
    }

    /** 「工具箱一键同步」：页面类型决定动作（视频拉全部分P，合集/收藏夹交给桌面端解析） */
    case 'sync-all':
      syncAll().then(sendResponse)
      return true

    case 'sync-cookies':
      syncCookies().then(sendResponse)
      return true

    /** 实时查询浏览器登录态（只读，不同步给桌面端） */
    case 'check-login': {
      checkLoginState().then(sendResponse)
      return true
    }

    default:
      return false
  }
})
