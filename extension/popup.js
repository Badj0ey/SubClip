/**
 * 弹出面板。
 *
 * 结构刻意分成两屏：
 *   主屏 —— 只放「现在该点什么」（连接状态 / 当前页面 / 字幕轨 / 一键同步 / 事件）
 *   设置 —— 端口、配对令牌、自动同步登录状态这些配一次就不动的项，收在右上角齿轮里
 *
 * 主屏不再要求用户判断「该点哪个按钮」：页面类型决定同步动作（见 background 的 syncAll）。
 */

const $ = (id) => document.getElementById(id)
const AUTO_COOKIE_KEY = 'scAutoCookie'

let currentStatus = null

async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message)
  } catch (err) {
    return { ok: false, message: err?.message ?? '扩展后台未响应' }
  }
}

/** 向当前标签页的内容脚本索取页面信息（内容脚本可能尚未注入） */
async function askPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return null
    return await chrome.tabs.sendMessage(tab.id, { type: 'get-page-info' })
  } catch {
    return null
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

const PAGE_TYPE_LABEL = {
  video: '视频页',
  season: '合集页',
  series: '系列页',
  favlist: '收藏夹',
  space: '投稿页',
  live: '直播间',
  unknown: '未知页面'
}

/** 一键同步按钮的文案：让用户一眼知道这次会发生什么 */
function syncLabel(page) {
  const t = page?.pageType
  if (t === 'video') return '同步到桌面端（含全部分P）'
  if (t === 'season') return '同步这个合集的全部视频'
  if (t === 'series') return '同步这个系列的全部视频'
  if (t === 'favlist') return '同步这个收藏夹的全部视频'
  if (t === 'space') return '同步这位UP主的全部投稿'
  if (t === 'live') return '直播间没有字幕可同步'
  return '同步到桌面端'
}

/* -------------------------------- 视图切换 -------------------------------- */

function showSettings(on) {
  $('viewMain').hidden = on
  $('viewSettings').hidden = !on
  $('btnSettings').textContent = on ? '←' : '⚙'
  $('btnSettings').title = on ? '返回' : '设置'
  if (on) void loadAutoCookie()
}
$('btnSettings').addEventListener('click', () => showSettings($('viewSettings').hidden))
$('btnBack').addEventListener('click', () => showSettings(false))

/* --------------------------------- 状态渲染 -------------------------------- */

function renderStatus(status) {
  currentStatus = status
  if (!status) return

  $('dot').className = `dot${status.connected ? ' on' : ''}`
  $('statusText').textContent = status.connected
    ? `已连接桌面端${status.serverVersion ? ` v${status.serverVersion}` : ''}`
    : '未连接桌面端'

  // 用户正在输入时不要覆盖（每 1.5 秒刷新一次，会把输入冲掉）
  if (document.activeElement !== $('port')) $('port').value = status.port
  if (document.activeElement !== $('token')) $('token').value = status.token || ''

  $('hint').textContent = status.connected
    ? '本地服务运行中，页面信息只在点「同步」时发送。'
    : status.lastError || '请先启动桌面端「字幕剪 SubClip」。'
  $('hint').className = `hint${status.connected ? '' : ' err'}`

  renderCookie(status)

  const events = $('events')
  events.innerHTML = ''
  // 事件按时间倒序存放，展示时反过来，让最新的始终在最底部
  for (const e of [...(status.events || [])].reverse()) {
    const li = document.createElement('li')
    li.textContent = `${new Date(e.at).toLocaleTimeString()} ${e.text}`
    if (e.level === 'error') li.className = 'err'
    else if (e.level === 'warn') li.className = 'warn'
    events.appendChild(li)
  }
  events.scrollTop = events.scrollHeight
}

function renderCookie(status) {
  const el = $('cookieState')
  if (!status?.connected) {
    el.textContent = '桌面端未连接'
    el.className = 'pill warn'
    return
  }
  const cs = status.cookieSync
  if (!cs) {
    el.textContent = '尚未同步'
    el.className = 'pill warn'
    return
  }
  if (cs.loggedIn) {
    el.textContent = `已同步 · ${cs.count} 项`
    el.className = 'pill ok'
  } else {
    el.textContent = '已同步，未见登录态'
    el.className = 'pill warn'
  }
}

/** 浏览器登录态是实时读取的，但不会自动同步给桌面端 */
function renderLogin(login) {
  const el = $('loginState')
  if (!login?.ok) {
    el.textContent = '无法读取'
    el.className = 'pill warn'
    return
  }
  if (login.loggedIn) {
    el.textContent = `已登录${login.uid ? ` · UID ${login.uid}` : ''}`
    el.className = 'pill ok'
  } else {
    el.textContent = '未登录'
    el.className = 'pill warn'
  }
}

/* ------------------------------ 字幕轨检测 ------------------------------ */

/** 上一次查询字幕轨用的 key，避免每秒重复请求 */
let lastTracksKey = ''
let trackList = []
let trackNote = ''

/**
 * 字幕轨必须由页面上下文去查（需要 cookie，见 content.js 顶部说明）。
 * 这里在页面/BV 变化时才重新查一次，并把结果缓存下来供渲染使用。
 */
async function refreshTracks(page) {
  if (!page?.bvid) {
    lastTracksKey = ''
    trackList = []
    trackNote = page ? '该页面没有具体视频' : ''
    return
  }

  const key = `${page.bvid}:${page.page || 1}`
  if (key === lastTracksKey) return
  lastTracksKey = key
  trackList = []
  trackNote = '检测中…'

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) {
      trackNote = '找不到当前标签页'
      return
    }
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: 'collect-tracks',
      bvid: page.bvid,
      page: page.page || 1
    })
    if (!res?.ok) {
      trackNote = res?.message || '检测失败'
      return
    }
    trackList = res.tracks || []
    trackNote = trackList.length ? '' : '该分P 没有可用字幕'
  } catch (err) {
    trackNote = `检测失败：${err?.message ?? '内容脚本未响应'}`
  }
}

function renderTracks() {
  const el = $('tracks')
  if (trackList.length) {
    el.textContent = trackList.map((t) => t.label || t.lang).join('、')
    el.className = 'value'
    el.style.color = ''
  } else {
    el.textContent = trackNote || '—'
    el.style.color = trackNote && !trackNote.includes('没有可用') ? 'var(--err)' : ''
  }
}

function renderPage(page) {
  const box = $('pageInfo')
  const btn = $('btnSync')
  if (!page) {
    box.textContent = '未识别（请打开 B 站视频 / 合集 / 收藏夹页面）'
    trackList = []
    trackNote = ''
    renderTracks()
    btn.textContent = '同步到桌面端'
    btn.disabled = false
    return
  }
  const lines = [
    `类型：${PAGE_TYPE_LABEL[page.pageType] || page.pageType}`,
    page.bvid ? `BV号：${page.bvid}${page.page > 1 ? ` （第 ${page.page} P）` : ''}` : '',
    page.title ? `标题：${page.title}` : '',
    page.uploader?.name ? `UP主：${page.uploader.name}` : ''
  ].filter(Boolean)
  box.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')
  renderTracks()
  btn.textContent = syncLabel(page)
  btn.disabled = page.pageType === 'live'
}

async function refresh() {
  const status = await ask({ type: 'get-status' })
  renderStatus(status)

  renderLogin(await ask({ type: 'check-login' }))

  const live = await askPageInfo()
  if (live) {
    if (currentStatus) currentStatus.livePage = live
    await refreshTracks(live)
    renderPage(live)
  } else {
    renderPage(status?.lastPage)
  }
}

/* --------------------------------- 交互 ---------------------------------- */

$('btnReconnect').addEventListener('click', async () => {
  renderStatus(await ask({ type: 'reconnect' }))
})

$('btnSavePort').addEventListener('click', async () => {
  renderStatus(await ask({ type: 'set-port', port: Number($('port').value) || 8765 }))
})

$('btnSaveToken').addEventListener('click', async () => {
  renderStatus(await ask({ type: 'set-token', token: $('token').value }))
})

/** 自动同步登录状态的开关（后台在握手成功后读它） */
async function loadAutoCookie() {
  try {
    const v = await chrome.storage.local.get(AUTO_COOKIE_KEY)
    $('autoCookie').checked = !v || v[AUTO_COOKIE_KEY] !== false
  } catch {
    $('autoCookie').checked = true
  }
}

$('autoCookie').addEventListener('change', async () => {
  const on = $('autoCookie').checked
  try {
    await chrome.storage.local.set({ [AUTO_COOKIE_KEY]: on })
  } catch {
    /* 存不进去也不影响当前会话 */
  }
  $('autoCookie').blur()
})

$('btnSyncCookies').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  btn.textContent = '同步中…'
  const res = await ask({ type: 'sync-cookies' })
  btn.disabled = false
  btn.textContent = '立即同步登录状态'

  if (!res?.ok) {
    $('cookieState').textContent = res?.message || '同步失败'
    $('cookieState').className = 'pill warn'
  }
  renderStatus(await ask({ type: 'get-status' }))
})

/** 一键同步：动作由页面类型决定，交给后台的 syncAll 判断 */
$('btnSync').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = '同步中…'
  const res = await ask({ type: 'sync-all' })
  btn.disabled = false
  btn.textContent = label
  const msg = res?.message || (res?.ok ? '已同步' : '同步失败')
  // 用字幕轨那一行当结果回显位，避免再加一块区域
  $('tracks').textContent = msg
  $('tracks').style.color = res?.ok ? '' : 'var(--err)'
  renderStatus(await ask({ type: 'get-status' }))
  if (res?.ok) setTimeout(() => void refresh(), 1600)
})

void loadAutoCookie()
refresh()
setInterval(refresh, 1500)
