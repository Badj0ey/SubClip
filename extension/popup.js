/**
 * 弹出面板：连接状态、登录状态同步、当前页面信息与字幕抓取。
 */

const $ = (id) => document.getElementById(id)

let currentStatus = null
let initialized = false

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

/* -------------------------------- 状态渲染 -------------------------------- */

function renderStatus(status) {
  currentStatus = status
  if (!status) return

  $('dot').className = `dot${status.connected ? ' on' : ''}`
  $('statusText').textContent = status.connected
    ? `已连接桌面端${status.serverVersion ? ` v${status.serverVersion}` : ''}`
    : '未连接桌面端'
  $('port').value = status.port
  $('token').value = status.token || ''
  $('hint').textContent = status.connected
    ? '本地服务运行中，页面信息与字幕会自动同步。'
    : status.lastError || '请先启动桌面端「SRT 字幕检索与视频切片辅助工具」。'
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
  // 自动滚到最底部，保证最新事件可见
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
  if (!page) {
    box.textContent = '未识别（请打开 B 站视频页面）'
    trackList = []
    trackNote = ''
    renderTracks()
    return
  }
  const typeMap = {
    video: '视频页',
    season: '合集页',
    favlist: '收藏夹',
    space: '投稿页',
    unknown: '未知页面'
  }
  const lines = [
    `类型：${typeMap[page.pageType] || page.pageType}`,
    page.bvid ? `BV号：${page.bvid}${page.page > 1 ? ` （第 ${page.page} P）` : ''}` : '',
    page.title ? `标题：${page.title}` : '',
    page.uploader?.name ? `UP主：${page.uploader.name}` : ''
  ].filter(Boolean)
  box.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')
  renderTracks()
}

async function refresh() {
  const status = await ask({ type: 'get-status' })
  renderStatus(status)

  if (!initialized) {
    initialized = true
  }

  // 实时读取浏览器登录态（只读，不发送）
  renderLogin(await ask({ type: 'check-login' }))

  const live = await askPageInfo()
  if (live) {
    if (currentStatus) currentStatus.livePage = live
    // 字幕轨要从页面上下文去查（需要 cookie），页面/BV 变了才重新查
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

$('btnSyncCookies').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  btn.textContent = '同步中…'
  const res = await ask({ type: 'sync-cookies' })
  btn.disabled = false
  btn.textContent = '同步登录状态到桌面端'

  if (!res?.ok) {
    $('cookieState').textContent = res?.message || '同步失败'
    $('cookieState').className = 'pill warn'
  }
  renderStatus(await ask({ type: 'get-status' }))
})

/** 同步当前页面（视频）到桌面端 */
$('btnSync').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  btn.textContent = '同步中…'
  const res = await ask({ type: 'sync-now' })
  btn.disabled = false
  btn.textContent = '同步该视频到桌面端'
  if (res?.ok) {
    renderStatus(res)
  } else {
    $('pageInfo').textContent = res?.message || '同步失败'
  }
})

$('btnFetch').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  const page = currentStatus?.livePage || currentStatus?.lastPage
  if (!page?.bvid) {
    $('tracks').textContent = '当前页面没有可抓取的字幕（需要是视频页）'
    return
  }
  btn.disabled = true
  btn.textContent = '抓取中…'
  // 先把视频信息同步过去，再抓字幕，避免桌面端缺少视频条目
  await ask({ type: 'sync-now' })
  const res = await ask({
    type: 'fetch-subtitles',
    bvid: page.bvid,
    page: page.page || 1,
    cid: page.cid || null
  })
  btn.disabled = false
  btn.textContent = '同时拉取字幕'
  if (res?.ok) {
    renderStatus(await ask({ type: 'get-status' }))
  } else {
    $('tracks').textContent = res?.message || '抓取失败'
  }
})

refresh()
setInterval(refresh, 1500)
