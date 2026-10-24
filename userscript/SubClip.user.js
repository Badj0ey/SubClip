// ==UserScript==
// @name         字幕剪 SubClip · B站桥接
// @name:en      SubClip Bilibili Bridge
// @namespace    https://github.com/Badj0ey/SubClip
// @version      3.17.0
// @description  在 B 站页面左下角识别视频，把页面信息、登录态与字幕同步给「字幕剪」桌面端
// @author       Badj0ey
// @homepageURL  https://github.com/Badj0ey/SubClip
// @supportURL   https://github.com/Badj0ey/SubClip/issues
// @match        https://*.bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_cookie
// @grant        GM_xmlhttpRequest
// @connect      hdslb.com
// @connect      *.hdslb.com
// @connect      *.bilibili.com
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * 这是「字幕剪」的浏览器端桥接脚本（单文件，代替旧的 Manifest V3 扩展）。
 *
 * 运行位置是 B 站页面内容脚本沙箱：
 *   - 调 B 站接口直接用页面 fetch，天然带 SESSDATA（SameSite=Lax，后台请求会丢）；
 *   - 字幕 JSON 在 CDN 上，用 GM_xmlhttpRequest 补 Referer 下载；
 *   - Cookie 用 GM_cookie 读取（含 HttpOnly），读不到就回退 document.cookie，并如实提示；
 *   - WebSocket 连本机桌面端，握手 Origin 是 https://*.bilibili.com。
 *
 * 界面全部关在 Shadow DOM 里，避免和 B 站样式互相污染。
 */

(() => {
  'use strict'

  if (window.top !== window.self) return
  if (globalThis.__SUBCLIP_BRIDGE_LOADED__) return
  globalThis.__SUBCLIP_BRIDGE_LOADED__ = true

  /* =============================== 常量 =============================== */

  const PROTOCOL_VERSION = 4
  const DEFAULT_PORT = 8765
  const VERSION =
    (typeof GM_info === 'object' && GM_info?.script?.version) || '0.0.0'
  const STORAGE = {
    port: 'subclip.port',
    token: 'subclip.token',
    collapsed: 'subclip.collapsed'
  }
  const API_TIMEOUT_MS = 15_000
  const SUBTITLE_TIMEOUT_MS = 30_000
  const TRACKS_TTL_MS = 60_000
  const LOGIN_TTL_MS = 60_000
  const RECONNECT_BASE_MS = 1_000
  const RECONNECT_MAX_MS = 30_000
  const MAX_EVENTS = 30
  const COOKIE_LIMIT = 8_000
  const COOKIE_PRIORITY = [
    'SESSDATA',
    'bili_jct',
    'DedeUserID',
    'DedeUserID__ckMd5',
    'sid',
    'buvid3',
    'buvid4'
  ]
  const PAGE_TYPE_LABEL = {
    video: '视频',
    season: '合集',
    favlist: '收藏夹',
    space: 'UP主投稿',
    unknown: '未识别'
  }
  const SERVER_STATUS = {
    idle: { text: '未连接', state: 'idle' },
    connecting: { text: '连接中', state: 'warn' },
    online: { text: '已连接', state: 'ok' },
    offline: { text: '未连接', state: 'idle' },
    auth: { text: '校验中', state: 'warn' },
    token: { text: '待验证', state: 'bad' },
    rejected: { text: '来源被拒', state: 'bad' },
    outdated: { text: '版本过旧', state: 'warn' },
    permission: { text: '待授权', state: 'warn' }
  }

  const state = {
    collapsed: true,
    port: DEFAULT_PORT,
    token: '',
    ws: null,
    status: 'idle',
    statusDetail: '',
    auth: 'unknown',
    helloAcks: 0,
    serverVersion: '',
    serverProtocol: null,
    compatible: false,
    blockReconnect: false,
    retry: 0,
    retryTimer: 0,
    connectTimer: 0,
    lna: 'unsupported',
    lnaStatus: null,
    permissionNeedsReload: false,
    lastAnnounced: '',
    cookieSynced: false,
    page: null,
    pageSignature: '',
    tracks: { key: '', at: 0, data: null, error: '', loading: false },
    login: { at: 0, data: null, loading: false },
    events: [],
    fetching: new Set()
  }

  const els = {}

  /* =============================== 基础工具 =============================== */

  function gmGet(key, fallback) {
    try {
      const value = GM_getValue(key, fallback)
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }

  function gmSet(key, value) {
    try {
      GM_setValue(key, value)
    } catch {
      /* 存储被禁用时不影响当前会话 */
    }
  }

  function detectBrowser() {
    const ua = navigator.userAgent
    if (/Edg\//.test(ua)) return 'Edge'
    if (/Chrome\//.test(ua)) return 'Chrome'
    if (/Firefox\//.test(ua)) return 'Firefox'
    if (/Safari\//.test(ua)) return 'Safari'
    return 'Chromium'
  }

  function truncate(value, max) {
    const text = String(value ?? '')
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }

  function normalizePort(value) {
    const port = Math.trunc(Number(value))
    if (!Number.isFinite(port) || port < 1 || port > 65_535) return null
    return port
  }

  function formatTime(ts) {
    const d = new Date(ts)
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')
  }

  function isSocketOpen() {
    return state.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Chrome/Edge 142 起把「公网页面连接 127.0.0.1」纳入本地网络访问（LNA）权限。
   * 首次连接必须由用户手势触发，浏览器会弹出授权；未授权时 WebSocket 会一直停在
   * CONNECTING 或直接报 ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS。
   * 这里查询权限状态，用来决定是自动连接还是先提示用户点一下。
   */
  async function queryLocalNetworkPermission() {
    try {
      if (!navigator.permissions?.query) return 'unsupported'
      const status = await navigator.permissions.query({ name: 'local-network-access' })
      return status.state || 'unsupported'
    } catch {
      // 浏览器不认识这个权限名（Firefox/Safari/旧版 Chromium）时不需要 LNA 授权
      return 'unsupported'
    }
  }

  function permissionDetail(permission) {
    return permission === 'denied'
      ? '本地网络访问被拒绝：点地址栏站点图标 →「本地网络访问」→ 允许，再点连接状态重试'
      : '点连接状态重试，浏览器会询问是否允许访问本地网络'
  }

  function clearConnectTimer() {
    if (state.connectTimer) {
      clearTimeout(state.connectTimer)
      state.connectTimer = 0
    }
  }

  function watchLocalNetworkPermission() {
    if (state.lnaStatus || !navigator.permissions?.query) return
    navigator.permissions
      .query({ name: 'local-network-access' })
      .then((status) => {
        state.lnaStatus = status
        status.onchange = () => {
          state.lna = status.state
          if (status.state === 'granted') {
            state.blockReconnect = false
            if (isSocketOpen()) return
            state.permissionNeedsReload = false
            addEvent('已获得本地网络访问权限，正在连接桌面端')
            // 授权前发起的连接可能一直卡在 CONNECTING，浏览器不会自动恢复；
            // 丢到旧 socket 后重新发起一次。
            if (state.ws) {
              const stale = state.ws
              state.ws = null
              clearConnectTimer()
              try {
                stale.close()
              } catch {
                /* 忽略关闭异常 */
              }
            }
            state.retry = 0
            connect()
          } else if (status.state === 'denied') {
            setStatus('permission', permissionDetail('denied'))
          }
        }
      })
      .catch(() => {
        /* 不支持 LNA 的浏览器不需要监听 */
      })
  }

  /* =============================== 页面识别 =============================== */

  const SUFFIX_RE = /\s*[-_|]\s*哔哩哔哩.*$/i

  function text(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      const value = el?.textContent?.trim()
      if (value) return value
    }
    return ''
  }

  function attr(selectors, name) {
    for (const sel of selectors) {
      const el = document.querySelector(sel)
      const value = el?.getAttribute?.(name)
      if (value) return value
    }
    return ''
  }

  function getTitle() {
    const dom = text([
      'h1.video-title',
      '.video-title',
      'h1[title]',
      '.video-info-title',
      '.mediainfo_mediaTitle__Zyiqh',
      'h1'
    ])
    if (dom) return dom
    const og = attr(['meta[property="og:title"]', 'meta[name="title"]'], 'content')
    if (og) return og
    return document.title.replace(SUFFIX_RE, '').trim()
  }

  function getUploader() {
    const name =
      text([
        '.up-name',
        '.up-info .name',
        '.up-info-container .up-name',
        '.up-detail-top a.up-name',
        '.username',
        '.bili-video-card__info--author'
      ]) || ''
    let uid = null
    const href =
      attr(['.up-name', '.up-info-container a[href*="space.bilibili.com"]', 'a.up-name'], 'href') ||
      (document.querySelector('a[href*="space.bilibili.com/"]')?.getAttribute('href') ?? '')
    const m = /space\.bilibili\.com\/(\d+)/.exec(href)
    if (m) uid = Number(m[1])
    const avatar = attr(['.up-avatar img', '.bili-avatar img', '.up-info img'], 'src') || null
    return { uid, name: name || '未知UP主', avatar }
  }

  function detectPage() {
    const url = new URL(location.href)
    const path = url.pathname
    const base = {
      url: location.href,
      title: getTitle(),
      page: 1,
      cid: null,
      seasonId: null,
      seasonTitle: null,
      uploader: getUploader()
    }

    const bv = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(path)
    if (bv) {
      return {
        ...base,
        pageType: 'video',
        bvid: bv[1],
        page: Math.max(1, Number(url.searchParams.get('p') || '1') || 1)
      }
    }

    if (/^\/list\//.test(path)) {
      const sid = url.searchParams.get('sid')
      return {
        ...base,
        pageType: 'season',
        bvid: '',
        seasonId: sid ? Number(sid) : null,
        seasonTitle: base.title
      }
    }

    const lists = /^\/(\d+)\/lists\/(\d+)/.exec(path)
    if (lists) {
      return {
        ...base,
        pageType: 'season',
        bvid: '',
        seasonId: Number(lists[2]),
        seasonTitle: base.title,
        uploader: { uid: Number(lists[1]), name: base.uploader.name, avatar: null }
      }
    }

    const fav = /^\/(\d+)\/favlist/.exec(path)
    if (fav) {
      return {
        ...base,
        pageType: 'favlist',
        bvid: '',
        seasonId: Number(url.searchParams.get('fid') || '0') || null,
        seasonTitle: base.title,
        uploader: { uid: Number(fav[1]), name: base.uploader.name, avatar: null }
      }
    }

    const space = /^\/(\d+)(?:\/(video|dynamic|index))?\/?$/.exec(path)
    if (space) {
      return {
        ...base,
        pageType: 'space',
        bvid: '',
        uploader: { uid: Number(space[1]), name: base.uploader.name, avatar: null }
      }
    }

    const loose = /(BV[0-9A-Za-z]{10})/.exec(location.href)
    return {
      ...base,
      pageType: loose ? 'video' : 'unknown',
      bvid: loose ? loose[1] : ''
    }
  }

  function pageKey(page) {
    if (!page) return ''
    return [page.pageType, page.bvid || '', page.page || 1].join(':')
  }

  /* =============================== WBI 与接口 =============================== */

  /* ---- WBI-BLOCK-START （此段由 tests/wbi.test.ts 提取后单测，请勿挪动标记） ---- */
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ]

  /** 标准 MD5（Web Crypto 不提供 md5，只能自带一份） */
  function md5(input) {
    const msg = unescape(encodeURIComponent(String(input)))
    const len = msg.length
    const words = new Array((((len + 8) >> 6) + 1) * 16).fill(0)
    for (let i = 0; i < len; i++) {
      words[i >> 2] |= msg.charCodeAt(i) << ((i % 4) * 8)
    }
    words[len >> 2] |= 0x80 << ((len % 4) * 8)
    words[words.length - 2] = len * 8

    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
      14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
      21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ]
    const K = []
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

    let a = 1732584193
    let b = -271733879
    let c = -1732584194
    let d = 271733878

    for (let i = 0; i < words.length; i += 16) {
      const oa = a
      const ob = b
      const oc = c
      const od = d

      for (let j = 0; j < 64; j++) {
        let f
        let g
        if (j < 16) {
          f = (b & c) | (~b & d)
          g = j
        } else if (j < 32) {
          f = (d & b) | (~d & c)
          g = (5 * j + 1) % 16
        } else if (j < 48) {
          f = b ^ c ^ d
          g = (3 * j + 5) % 16
        } else {
          f = c ^ (b | ~d)
          g = (7 * j) % 16
        }
        const tmp = d
        d = c
        c = b
        const sum = (a + f + K[j] + words[i + g]) | 0
        b = (b + ((sum << S[j]) | (sum >>> (32 - S[j])))) | 0
        a = tmp
      }

      a = (a + oa) | 0
      b = (b + ob) | 0
      c = (c + oc) | 0
      d = (d + od) | 0
    }

    return [a, b, c, d]
      .map((n) => {
        let s = ''
        for (let i = 0; i < 4; i++) s += ((n >> (i * 8)) & 0xff).toString(16).padStart(2, '0')
        return s
      })
      .join('')
  }

  function signWbi(params, mixinKey) {
    const signed = {}
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue
      signed[k] = String(v).replace(/[!'()*]/g, '')
    }
    signed.wts = String(Math.floor(Date.now() / 1000))
    const query = new URLSearchParams(
      Object.keys(signed)
        .sort()
        .map((k) => [k, signed[k]])
    ).toString()
    signed.w_rid = md5(query + mixinKey)
    return signed
  }

  /** 从 img_url / sub_url 提取 wbi 密钥并重排 */
  function buildMixinKey(imgUrl, subUrl) {
    const stem = (u) => (String(u).split('?')[0].split('/').pop() || '').replace(/\.\w+$/, '')
    const raw = stem(imgUrl) + stem(subUrl)
    if (raw.length < 32) throw new Error('无法获取 WBI 签名密钥')
    return MIXIN_KEY_ENC_TAB.filter((i) => i < raw.length)
      .map((i) => raw[i])
      .join('')
      .slice(0, 32)
  }
  /* ---- WBI-BLOCK-END ---- */

  let wbiCache = null

  async function getWbiKey() {
    if (wbiCache && Date.now() - wbiCache.ts < 30_000) return wbiCache.key
    const nav = await apiGet('/x/web-interface/nav')
    const key = buildMixinKey(nav?.wbi_img?.img_url, nav?.wbi_img?.sub_url)
    wbiCache = { key, ts: Date.now() }
    return key
  }

  function buildApiUrl(path, params) {
    const url = new URL(path.startsWith('http') ? path : `https://api.bilibili.com${path}`)
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v))
    }
    return url.toString()
  }

  async function apiGet(path, params) {
    const res = await fetch(buildApiUrl(path, params), {
      credentials: 'include',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    let data
    try {
      data = await res.json()
    } catch {
      throw new Error('接口返回不是 JSON')
    }
    if (data && typeof data === 'object' && Number(data.code) !== 0) {
      throw new Error(`接口返回 ${data.code}：${data.message || '未知错误'}`)
    }
    return data?.data
  }

  function pickTracks(playerData) {
    const list = playerData?.subtitle?.subtitles
    if (!Array.isArray(list)) return []
    return list
      .map((s) => ({
        lang: String(s?.lan || ''),
        label: String(s?.lan_doc || s?.lan || ''),
        url: String(s?.subtitle_url || '')
      }))
      .filter((t) => t.url)
  }

  async function getVideoInfo(bvid) {
    return apiGet('/x/web-interface/view', { bvid })
  }

  /**
   * 拿某个分P 的字幕轨。
   * 与参考实现（bilibili_api.py 的 get_player_info）保持一致：
   *   1. 先试带 WBI 签名的 x/player/wbi/v2（同时带 aid，部分稿件只认 aid）
   *   2. 失败回退免签名的 x/player/v2
   * 每次都会记录失败原因，便于在面板上看到到底是哪一步断了。
   */
  async function getSubtitleTracks(bvid, cid, aid) {
    const errors = []

    try {
      const key = await getWbiKey()
      const params = { bvid, cid }
      if (aid) params.aid = aid
      const data = await apiGet('/x/player/wbi/v2', signWbi(params, key))
      const tracks = pickTracks(data)
      if (tracks.length) return { tracks, via: 'wbi/v2' }
      errors.push('wbi/v2: 无字幕轨')
    } catch (err) {
      errors.push(`wbi/v2: ${err.message}`)
    }

    try {
      const data = await apiGet('/x/player/v2', { bvid, cid })
      const tracks = pickTracks(data)
      if (tracks.length) return { tracks, via: 'player/v2' }
      errors.push('player/v2: 无字幕轨')
    } catch (err) {
      errors.push(`player/v2: ${err.message}`)
    }

    const onlyEmpty = errors.every((e) => e.endsWith('无字幕轨'))
    if (onlyEmpty) return { tracks: [], via: 'none' }
    throw new Error(errors.join('；'))
  }

  async function collectTracks(bvid, page, cidHint) {
    const info = await getVideoInfo(bvid)
    const pages = info?.pages || []
    if (!pages.length) throw new Error('视频没有分P 信息')
    const byCid = cidHint ? pages.find((p) => Number(p.cid) === Number(cidHint)) : null
    const target =
      byCid || pages.find((p) => Number(p.page) === Number(page)) || pages[0]

    const { tracks, via } = await getSubtitleTracks(bvid, Number(target.cid), info?.aid)
    return {
      bvid,
      page: Number(target.page) || 1,
      cid: Number(target.cid),
      title: String(info?.title || ''),
      owner: {
        uid: Number(info?.owner?.mid) || null,
        name: String(info?.owner?.name || ''),
        avatar: String(info?.owner?.face || '')
      },
      tracks,
      via
    }
  }

  /* =============================== Cookie =============================== */

  function cookieUrlList() {
    return [
      'https://www.bilibili.com',
      'https://api.bilibili.com',
      'https://space.bilibili.com'
    ]
  }

  /**
   * GM_cookie.list 在不同脚本管理器里既可能回调，也可能返回 Promise。
   * 双兼容 + 防重复 settle + 超时，避免面板永远卡在「检测中」。
   */
  function listCookies(details) {
    return new Promise((resolve, reject) => {
      if (typeof GM_cookie === 'undefined' || typeof GM_cookie?.list !== 'function') {
        reject(new Error('脚本管理器不支持 GM_cookie'))
        return
      }
      let settled = false
      let timer = 0
      const done = (cookies, error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(new Error(String(error)))
        else resolve(Array.isArray(cookies) ? cookies : [])
      }
      timer = setTimeout(() => done(null, new Error('读取 Cookie 超时')), 5_000)
      try {
        const maybe = GM_cookie.list(details, done)
        if (maybe && typeof maybe.then === 'function') {
          maybe.then((cookies) => done(cookies, null), (err) => done(null, err))
        }
      } catch (err) {
        done(null, err)
      }
    })
  }

  function readDocumentCookies() {
    const map = new Map()
    for (const part of String(document.cookie || '').split(';')) {
      const index = part.indexOf('=')
      if (index <= 0) continue
      const name = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      if (name) map.set(name, value)
    }
    return map
  }

  async function collectCookies() {
    const map = new Map()
    let usedGM = false
    let apiError = ''

    for (const details of [
      ...cookieUrlList().map((url) => ({ url })),
      { domain: '.bilibili.com' }
    ]) {
      try {
        const cookies = await listCookies(details)
        usedGM = true
        for (const cookie of cookies) {
          if (cookie?.name) map.set(String(cookie.name), String(cookie.value ?? ''))
        }
      } catch (err) {
        if (!apiError) apiError = err?.message || String(err)
      }
    }

    for (const [name, value] of readDocumentCookies()) {
      if (!map.has(name)) map.set(name, value)
    }

    const keys = [...map.keys()]
    const ordered = [
      ...COOKIE_PRIORITY.filter((name) => map.has(name)),
      ...keys.filter((name) => !COOKIE_PRIORITY.includes(name)).sort()
    ]
    let cookie = ordered.map((name) => `${name}=${map.get(name)}`).join('; ')

    // 正常 B 站 Cookie 只有几 KB；超限时只保留关键项，绝不发送一个被截断的 Cookie
    if (cookie.length > COOKIE_LIMIT) {
      const onlyPrimary = ordered.filter((name) => COOKIE_PRIORITY.includes(name))
      cookie = onlyPrimary.map((name) => `${name}=${map.get(name)}`).join('; ')
      if (cookie.length > COOKIE_LIMIT) {
        return { cookie: '', count: map.size, hasSession: map.has('SESSDATA'), tooLarge: true, usedGM, apiError }
      }
    }

    return {
      cookie,
      count: map.size,
      hasSession: map.has('SESSDATA'),
      tooLarge: false,
      usedGM,
      apiError
    }
  }

  async function checkBrowserLogin() {
    try {
      const data = await apiGet('/x/web-interface/nav')
      return {
        loggedIn: Boolean(data?.isLogin),
        verified: true,
        name: String(data?.uname || ''),
        uid: Number(data?.mid) || null
      }
    } catch (err) {
      const hasSession = readDocumentCookies().has('SESSDATA')
      const message = err?.message || String(err)
      if (/未登录|-101/.test(message)) {
        return { loggedIn: false, verified: true, name: '', uid: null, message }
      }
      return { loggedIn: hasSession, verified: false, name: '', uid: null, message }
    }
  }

  /* =============================== 字幕下载 =============================== */

  function gmRequest(url, withReferer = true) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('脚本管理器不支持 GM_xmlhttpRequest'))
        return
      }
      let settled = false
      const fail = (message) => {
        if (settled) return
        settled = true
        reject(new Error(message))
      }
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: SUBTITLE_TIMEOUT_MS,
          headers: withReferer ? { Referer: 'https://www.bilibili.com/' } : {},
          onload(res) {
            if (settled) return
            if (res.status < 200 || res.status >= 300) {
              fail(`HTTP ${res.status}`)
              return
            }
            settled = true
            try {
              resolve(JSON.parse(res.responseText))
            } catch {
              reject(new Error('字幕文件不是 JSON'))
            }
          },
          onerror: () => fail('网络错误'),
          ontimeout: () => fail('下载超时'),
          onabort: () => fail('下载被中止')
        })
      } catch (err) {
        fail(err?.message || String(err))
      }
    })
  }

  async function fetchSubtitleJson(rawUrl) {
    const url = String(rawUrl || '').startsWith('//') ? `https:${rawUrl}` : String(rawUrl || '')
    if (!url) throw new Error('字幕地址为空')

    let data
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        data = await gmRequest(url, true)
      } catch {
        // 少数管理器会拒绝自定义 Referer；去掉头再试一次
        data = await gmRequest(url, false)
      }
    } else {
      const res = await fetch(url, {
        credentials: 'omit',
        signal: AbortSignal.timeout(SUBTITLE_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
    }

    if (!data || !Array.isArray(data.body)) throw new Error('字幕文件格式不正确')
    return data
  }

  function toCues(body) {
    const cues = []
    for (const row of body) {
      if (cues.length >= 20_000) break
      const from = Number(row?.from)
      const to = Number(row?.to)
      const content = String(row?.content ?? '').replace(/\r/g, '').trim()
      if (!Number.isFinite(from) || !Number.isFinite(to) || !content) continue
      cues.push({
        from,
        to,
        content: content.length > 2_000 ? content.slice(0, 2_000) : content
      })
    }
    return cues
  }

  /* =============================== WebSocket =============================== */

  function sendRaw(message) {
    if (!isSocketOpen()) return false
    try {
      state.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  function send(message) {
    if (!sendRaw(message)) {
      feedback('未连接桌面端', 'error')
      return false
    }
    return true
  }

  function sendHello() {
    state.helloAcks = 0
    const payload = {
      type: 'hello',
      version: VERSION,
      browser: detectBrowser()
    }
    if (state.token) payload.token = state.token.slice(0, 128)
    sendRaw(payload)
  }

  function connect() {
    if (state.ws) return
    clearConnectTimer()
    const startedWithoutPermission = state.lna === 'prompt' || state.lna === 'denied'
    state.permissionNeedsReload = false
    let ws
    try {
      ws = new WebSocket(`ws://127.0.0.1:${state.port}`)
    } catch (err) {
      setStatus('offline', err?.message || '无法创建连接')
      scheduleReconnect()
      return
    }

    state.ws = ws
    state.helloAcks = 0
    state.auth = 'unknown'
    state.cookieSynced = false
    setStatus('connecting', `127.0.0.1:${state.port}`)

    ws.onopen = () => {
      clearConnectTimer()
      state.permissionNeedsReload = false
      state.retry = 0
      sendHello()
    }

    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data || ''))
      } catch {
        return
      }
      if (!message || typeof message !== 'object') return
      if (message.type === 'hello-ack') onHelloAck(message)
      else if (message.type === 'ack') onAck(message)
      else if (message.type === 'request-subtitles') onRequestSubtitles(message)
      else if (message.type === 'pong') {
        /* 浏览器 WebSocket 自带心跳，这里只做兼容 */
      }
    }

    ws.onerror = () => {
      /* 具体原因由 onclose 统一处理 */
    }

    ws.onclose = () => {
      if (state.ws !== ws) return
      clearConnectTimer()
      state.ws = null
      state.helloAcks = 0
      state.auth = 'unknown'
      state.cookieSynced = false
      if (state.blockReconnect) {
        if (state.status === 'online' || state.status === 'outdated') {
          setStatus('offline', '连接已断开')
        }
        return
      }
      void handleDisconnect()
    }

    // 权限弹窗没人点、或者被浏览器直接拦下时，onclose 可能很久都不来；
    // 给用户一个明确的状态，而不是永远停在「连接中」。
    state.connectTimer = setTimeout(async () => {
      if (state.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return
      const permission = await queryLocalNetworkPermission()
      state.lna = permission
      if (permission === 'prompt') {
        setStatus('permission', '等待本地网络访问授权：请在浏览器弹窗里选择「允许」')
      } else if (permission === 'denied') {
        setStatus('permission', permissionDetail('denied'))
      } else if (permission === 'granted' && startedWithoutPermission) {
        // 有些 Chromium 版本在授权后仍缓存了「未授权」的结果，需要刷新页面
        state.permissionNeedsReload = true
        setStatus('permission', '权限已允许，但当前页面仍被浏览器拦截，请刷新页面后重试。')
      } else {
        setStatus('connecting', '桌面端没有响应，请确认桌面端已启动')
      }
    }, 3_500)
  }

  async function handleDisconnect() {
    const permission = await queryLocalNetworkPermission()
    state.lna = permission
    if (permission === 'prompt' || permission === 'denied') {
      state.blockReconnect = true
      setStatus('permission', permissionDetail(permission))
      return
    }
    if (state.ws) return
    setStatus('offline', '桌面端未连接')
    scheduleReconnect()
  }

  function closeSocket() {
    const ws = state.ws
    state.ws = null
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleReconnect() {
    if (state.blockReconnect) return
    if (state.retryTimer) clearTimeout(state.retryTimer)
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(1.6, state.retry),
      RECONNECT_MAX_MS
    )
    state.retry++
    state.statusDetail = `约 ${Math.max(1, Math.round(delay / 1000))} 秒后重试`
    renderConnection()
    state.retryTimer = setTimeout(() => {
      state.retryTimer = 0
      connect()
    }, delay)
  }

  function reconnectNow() {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = 0
    }
    clearConnectTimer()
    state.blockReconnect = false
    state.retry = 0
    closeSocket()
    connect()
  }

  function onHelloAck(message) {
    state.helloAcks++
    state.serverVersion = String(message.version || '')
    state.serverProtocol = Number(message.protocol) || null

    if (message.rejected) {
      state.blockReconnect = true
      setStatus('rejected', '桌面端拒绝了该来源，请把桌面端更新到 3.15 或更高版本')
      return
    }

    state.compatible = Number(message.protocol) >= PROTOCOL_VERSION
    if (!state.compatible) {
      state.auth = 'ok'
      state.blockReconnect = false
      setStatus(
        'outdated',
        `桌面端协议 v${message.protocol ?? '?'}，脚本需要 v${PROTOCOL_VERSION}；请更新桌面端`
      )
      return
    }

    if (message.tokenRequired && !state.token) {
      state.auth = 'bad'
      state.blockReconnect = true
      setStatus('token', '桌面端已设置配对令牌，请在「连接设置」里填写')
      els.settings.open = true
      return
    }

    // 服务端连接建立时会先发一次 hello-ack；带令牌时以收到 hello 后的第二次为准
    if (message.tokenRequired && state.helloAcks < 2) {
      setStatus('auth', '正在校验配对令牌…')
      return
    }

    state.auth = 'ok'
    state.blockReconnect = false
    setStatus('online', state.serverVersion ? `桌面端 v${state.serverVersion}` : '')
  }

  function onAck(message) {
    if (message.ok) {
      const text = String(message.message || '')
      // 每条字幕都会 ack，避免把事件列表刷满
      if (/拉取|登录凭证|页面信息/.test(text)) addEvent(text, 'info')
      return
    }

    const text = String(message.message || '桌面端拒绝了请求')
    if (/令牌/.test(text)) {
      state.auth = 'bad'
      state.blockReconnect = true
      setStatus('token', text)
      els.settings.open = true
      return
    }
    addEvent(text, 'warn')
    feedback(text, 'error')
  }

  function onRequestSubtitles(message) {
    const bvid = String(message.bvid || '')
    const page = Math.max(1, Number(message.page) || 1)
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return
    addEvent(`桌面端请求抓取 ${bvid} P${page} 的字幕`)
    void fetchAndSend(bvid, page, message.cid)
  }

  async function fetchAndSend(bvid, page, cidHint) {
    const key = `${bvid}:${page}`
    if (state.fetching.has(key)) return
    state.fetching.add(key)

    try {
      const data = await collectTracks(bvid, page, cidHint)
      const tracks = data.tracks || []
      if (!tracks.length) {
        addEvent(`${bvid} P${data.page} 没有可用字幕轨`, 'warn')
        feedback('没有找到可用字幕轨', 'warn')
        return
      }

      addEvent(`开始抓取 ${tracks.length} 条字幕轨（${data.via}）`)
      let sent = 0
      for (const track of tracks) {
        if (!isSocketOpen()) {
          addEvent('连接已断开，停止抓取', 'warn')
          break
        }
        try {
          const json = await fetchSubtitleJson(track.url)
          const cues = toCues(json.body)
          if (!cues.length) {
            addEvent(`字幕「${track.label || track.lang}」没有有效行`, 'warn')
            continue
          }
          const ok = sendRaw({
            type: 'subtitle',
            payload: {
              bvid,
              page: data.page,
              lang: truncate(track.lang || 'unknown', 40),
              label: truncate(track.label || track.lang || '字幕', 200),
              cues
            }
          })
          if (!ok) {
            addEvent('连接已断开，停止抓取', 'warn')
            break
          }
          sent++
        } catch (err) {
          addEvent(`字幕「${track.label || track.lang}」下载失败：${err.message}`, 'error')
        }
      }
      addEvent(`已发送 ${sent}/${tracks.length} 条字幕`, sent ? 'ok' : 'warn')
      feedback(sent ? `已发送 ${sent} 条字幕` : '没有发送成功', sent ? 'ok' : 'warn')
    } catch (err) {
      addEvent(`抓取失败：${err.message}`, 'error')
      feedback(`抓取失败：${truncate(err.message, 100)}`, 'error')
    } finally {
      state.fetching.delete(key)
    }
  }

  /* =============================== 动作 =============================== */

  function currentPageInfo() {
    const page = state.page
    if (!page) return null
    const tracksData = state.tracks.data
    return {
      pageType: page.pageType,
      bvid: page.bvid || '',
      title: truncate(page.title || document.title, 500),
      url: location.href,
      page: Math.max(1, Number(page.page) || 1),
      cid: tracksData?.cid ?? null,
      uploader: {
        uid: page.uploader?.uid ?? null,
        name: truncate(page.uploader?.name || '未知UP主', 200),
        avatar: page.uploader?.avatar ? truncate(page.uploader.avatar, 500) : null
      },
      seasonId: page.seasonId ?? null,
      seasonTitle: page.seasonTitle ? truncate(page.seasonTitle, 200) : null
    }
  }

  function ensureOnline() {
    if (isSocketOpen() && state.status !== 'token' && state.status !== 'rejected') {
      return true
    }
    if (state.status === 'token') feedback('请先在「连接设置」里填写配对令牌', 'warn')
    else if (state.status === 'rejected') feedback('桌面端拒绝了该来源，请更新桌面端', 'error')
    else feedback('未连接桌面端', 'error')
    return false
  }

  function syncPage() {
    if (!ensureOnline()) return
    const page = state.page
    if (!page?.bvid) {
      feedback('当前页面没有可同步的视频', 'warn')
      return
    }
    const payload = currentPageInfo()
    if (!payload) return
    if (send({ type: 'page-info', payload })) {
      addEvent(`已发送页面信息 ${page.bvid} P${page.page}`)
      feedback('页面信息已发送', 'ok')
    }
  }

  function pullVideo() {
    if (!ensureOnline()) return
    if (!state.compatible) {
      feedback('桌面端协议过旧，请先更新桌面端', 'error')
      return
    }
    const page = state.page
    if (!page?.bvid) {
      feedback('当前页面没有可拉取的视频', 'warn')
      return
    }
    const payload = currentPageInfo()
    if (!payload) return
    // 先让桌面端知道页面信息，再请它拉全部分P
    send({ type: 'page-info', payload })
    if (
      send({
        type: 'pull-request',
        payload: {
          bvid: page.bvid,
          page: Math.max(1, Number(page.page) || 1),
          title: truncate(page.title, 200)
        }
      })
    ) {
      addEvent(`已请求桌面端拉取 ${page.bvid} 的全部分P`)
      feedback('已请求桌面端拉取全部分P', 'ok')
    }
  }

  async function syncCookies() {
    if (!ensureOnline()) return
    feedback('正在读取浏览器登录状态…')

    const result = await collectCookies()
    if (result.tooLarge) {
      feedback('Cookie 过大，已取消同步', 'error')
      addEvent('Cookie 超过 8KB，为避免写入不完整凭证已取消同步', 'error')
      return
    }
    if (!result.hasSession) {
      const reason = result.usedGM
        ? '没有读到 SESSDATA（可能未登录，或脚本管理器未授权 Cookie）'
        : '脚本管理器不支持 GM_cookie，读不到 HttpOnly 的 SESSDATA'
      feedback('未读取到有效登录状态', 'error')
      addEvent(`${reason}；可在桌面端手动粘贴 Cookie`, 'warn')
      return
    }

    const login = state.login.data
    const payload = {
      cookie: result.cookie,
      count: result.count,
      loggedIn: Boolean(login?.loggedIn) || result.hasSession,
      userName: login?.verified ? login.name : ''
    }
    if (!send({ type: 'cookies', payload })) return
    state.cookieSynced = true
    addEvent(`已同步登录状态（${result.count} 项）`)
    feedback('登录状态已同步到桌面端', 'ok')
    renderLogin()
  }

  /* =============================== UI 构建 =============================== */

  const CSS = `
    :host { all: initial; color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .sc-root {
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      color: #e8ebf5;
      -webkit-font-smoothing: antialiased;
    }
    .sc-panel {
      width: 360px;
      max-height: min(72vh, 640px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(25, 29, 40, .98), rgba(17, 20, 29, .98));
      border: 1px solid rgba(255, 255, 255, .09);
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .3);
      backdrop-filter: blur(14px);
    }
    .sc-launcher {
      position: relative;
      width: 46px;
      height: 46px;
      padding: 0;
      border: 0;
      border-radius: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #4f7cff, #7a5cff);
      color: #fff;
      font: 700 20px/1 "Microsoft YaHei", sans-serif;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(29, 58, 160, .45);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .sc-launcher:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(29, 58, 160, .55); }
    .sc-launcher-dot {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 12px;
      height: 12px;
      border: 2px solid #151821;
      border-radius: 50%;
      background: #8a90a4;
    }
    .sc-launcher-dot[data-state="ok"] { background: #38d39f; }
    .sc-launcher-dot[data-state="warn"] { background: #f5b544; }
    .sc-launcher-dot[data-state="bad"] { background: #ff6b81; }
    .sc-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 11px 12px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, .07);
      background: rgba(255, 255, 255, .02);
    }
    .sc-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .sc-brand-mark {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #4f7cff, #7a5cff);
      color: #fff;
      font: 700 14px/1 "Microsoft YaHei", sans-serif;
      flex: none;
    }
    .sc-brand-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
    .sc-brand-text strong { font-size: 13px; font-weight: 600; letter-spacing: .2px; }
    .sc-brand-text small { font-size: 10px; color: #7e879d; }
    .sc-head-actions { display: flex; align-items: center; gap: 4px; flex: none; }
    .sc-icon {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: #8f98ae;
      cursor: pointer;
      transition: background .15s ease, color .15s ease;
    }
    .sc-icon:hover { background: rgba(255, 255, 255, .08); color: #dfe4f2; }
    .sc-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 12px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.16) transparent; }
    .sc-body::-webkit-scrollbar { width: 6px; }
    .sc-body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .16); border-radius: 3px; }
    .sc-card {
      margin-top: 12px;
      padding: 10px 11px;
      border: 1px solid rgba(255, 255, 255, .06);
      border-radius: 11px;
      background: rgba(255, 255, 255, .035);
    }
    .sc-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .sc-badge {
      flex: none;
      padding: 2px 7px;
      border-radius: 5px;
      background: rgba(79, 124, 255, .18);
      color: #9db4ff;
      font-size: 10px;
      line-height: 1.5;
    }
    .sc-badge[data-type="season"], .sc-badge[data-type="favlist"] { background: rgba(122, 92, 255, .18); color: #c0b1ff; }
    .sc-badge[data-type="space"] { background: rgba(56, 211, 159, .14); color: #8ef0c8; }
    .sc-mono {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #8a92a8;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .sc-title {
      margin: 7px 0 0;
      font-size: 13.5px;
      font-weight: 600;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }
    .sc-up { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8a92a8; font-size: 11.5px; }
    .sc-tracks-head { display: flex; align-items: center; justify-content: space-between; margin-top: 9px; color: #8a92a8; font-size: 11px; }
    .sc-tracks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; min-height: 20px; }
    .sc-track {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(255, 255, 255, .06);
      color: #c7cde0;
      font-size: 11px;
    }
    .sc-track small { margin-left: 4px; color: #7a8298; }
    .sc-empty { color: #7a8298; font-size: 11.5px; line-height: 1.5; }
    .sc-empty[data-state="error"] { color: #ff9aa8; }
    .sc-link {
      padding: 0;
      border: 0;
      background: none;
      color: #8fa9ff;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .sc-link:hover { color: #b3c4ff; }
    .sc-link:disabled { color: #596178; cursor: not-allowed; }
    .sc-actions { display: flex; gap: 8px; margin-top: 10px; }
    .sc-btn {
      flex: 1;
      min-width: 0;
      padding: 7px 8px;
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 8px;
      background: rgba(255, 255, 255, .05);
      color: #dfe4f2;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: filter .15s ease, background .15s ease;
    }
    .sc-btn:hover:not(:disabled) { filter: brightness(1.14); }
    .sc-btn:disabled { opacity: .4; cursor: not-allowed; }
    .sc-btn.primary { background: #4f7cff; border-color: #4f7cff; color: #fff; }
    .sc-btn.small { flex: none; padding: 6px 12px; font-size: 11.5px; }
    .sc-feedback { min-height: 16px; margin-top: 6px; color: #8a92a8; font-size: 11px; overflow-wrap: anywhere; }
    .sc-notice {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-top: 12px;
      padding: 9px 10px;
      border: 1px solid rgba(245, 181, 68, .32);
      border-radius: 10px;
      background: rgba(245, 181, 68, .08);
    }
    .sc-notice[hidden] { display: none; }
    .sc-notice p { margin: 0; color: #f5cf8b; font-size: 10.5px; line-height: 1.55; overflow-wrap: anywhere; }
    .sc-notice .sc-btn { align-self: flex-end; }
    .sc-feedback[data-state="ok"] { color: #8ef0c8; }
    .sc-feedback[data-state="warn"] { color: #f5cf8b; }
    .sc-feedback[data-state="error"] { color: #ff9aa8; }
    .sc-section { margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(255, 255, 255, .07); }
    .sc-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: #9aa2b8; font-size: 11.5px; }
    .sc-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .sc-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      max-width: 190px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .06);
      color: #aab1c4;
      font-size: 11px;
      white-space: nowrap;
    }
    .sc-pill i { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #8a90a4; }
    .sc-pill b { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .sc-pill[data-state="ok"] { background: rgba(56, 211, 159, .12); color: #8ef0c8; }
    .sc-pill[data-state="ok"] i { background: #38d39f; }
    .sc-pill[data-state="warn"] { background: rgba(245, 181, 68, .12); color: #f5cf8b; }
    .sc-pill[data-state="warn"] i { background: #f5b544; }
    .sc-pill[data-state="bad"] { background: rgba(255, 107, 129, .12); color: #ff9aa8; }
    .sc-pill[data-state="bad"] i { background: #ff6b81; }
    .sc-hint { margin: 6px 0 0; color: #737c92; font-size: 10.5px; line-height: 1.55; }
    .sc-details { margin-top: 10px; padding-top: 9px; border-top: 1px solid rgba(255, 255, 255, .07); }
    .sc-details summary {
      display: flex;
      align-items: center;
      gap: 5px;
      list-style: none;
      color: #9aa2b8;
      font-size: 11.5px;
      cursor: pointer;
      user-select: none;
    }
    .sc-details summary::-webkit-details-marker { display: none; }
    .sc-details summary::before {
      content: "";
      width: 0;
      height: 0;
      border-left: 4px solid #7c849a;
      border-top: 3px solid transparent;
      border-bottom: 3px solid transparent;
      transition: transform .15s ease;
    }
    .sc-details[open] summary::before { transform: rotate(90deg); }
    .sc-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
    .sc-field { flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: 3px; color: #8a92a8; font-size: 10.5px; }
    .sc-field input {
      width: 100%;
      padding: 5px 7px;
      border: 1px solid rgba(255, 255, 255, .1);
      border-radius: 6px;
      outline: none;
      background: rgba(0, 0, 0, .25);
      color: #e8ebf5;
      font: inherit;
      font-size: 12px;
    }
    .sc-field input:focus { border-color: #4f7cff; }
    .sc-form-foot { display: flex; align-items: center; gap: 8px; width: 100%; }
    .sc-form-foot .sc-hint { margin: 0; }
    .sc-log { display: flex; flex-direction: column; gap: 3px; max-height: 118px; margin-top: 7px; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; }
    .sc-log-item { display: flex; gap: 6px; color: #9aa2b8; font-size: 10.5px; line-height: 1.45; overflow-wrap: anywhere; }
    .sc-log-item time { flex: none; color: #626b82; font-variant-numeric: tabular-nums; }
    .sc-log-item[data-level="warn"] { color: #f5cf8b; }
    .sc-log-item[data-level="error"] { color: #ff9aa8; }
    .sc-log-item[data-level="ok"] { color: #8ef0c8; }
    .sc-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 12px;
      border-top: 1px solid rgba(255, 255, 255, .06);
      color: #626b82;
      font-size: 10px;
    }
    .sc-foot span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sc-btn:focus-visible, .sc-icon:focus-visible, .sc-link:focus-visible, .sc-launcher:focus-visible, summary:focus-visible, input:focus-visible {
      outline: 2px solid #8fa9ff;
      outline-offset: 2px;
    }
    @media (max-width: 420px) {
      .sc-panel { width: calc(100vw - 24px); max-height: 70vh; }
    }
    @media (max-height: 520px) {
      .sc-panel { max-height: calc(100vh - 24px); }
    }
  `

  const ICON_REFRESH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`
  const ICON_CHEVRON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`

  function buildUI() {
    const host = document.createElement('div')
    host.id = 'subclip-bridge-host'
    host.style.cssText =
      'all:initial; position:fixed; left:16px; bottom:16px; z-index:2147483646; display:block;'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="sc-root" data-collapsed="true">
        <button class="sc-launcher" type="button" data-ref="launcher" aria-label="打开字幕剪桥接面板" aria-expanded="false">
          <span aria-hidden="true">剪</span>
          <span class="sc-launcher-dot" data-ref="launcherDot" data-state="idle"></span>
        </button>
        <section class="sc-panel" data-ref="panel" aria-label="字幕剪 B站桥接" hidden>
          <header class="sc-head">
            <div class="sc-brand">
              <span class="sc-brand-mark" aria-hidden="true">剪</span>
              <span class="sc-brand-text"><strong>字幕剪</strong><small>B站桥接</small></span>
            </div>
            <div class="sc-head-actions">
              <span class="sc-pill" data-ref="connPill" data-state="idle" title="桌面端连接状态"><i></i><b>未连接</b></span>
              <button class="sc-icon" type="button" data-ref="reconnect" title="重新连接" aria-label="重新连接">${ICON_REFRESH}</button>
              <button class="sc-icon" type="button" data-ref="collapse" title="收起（Esc）" aria-label="收起面板">${ICON_CHEVRON}</button>
            </div>
          </header>
          <div class="sc-body">
            <div class="sc-notice" data-ref="lnaNotice" hidden>
              <p data-ref="lnaText">浏览器需要「本地网络访问」权限才能连接桌面端。</p>
              <button class="sc-btn small primary" type="button" data-ref="lnaConnect">允许并连接</button>
            </div>
            <section class="sc-card">
              <div class="sc-row">
                <span class="sc-badge" data-ref="pageBadge" data-type="unknown">识别中</span>
                <span class="sc-mono" data-ref="pageId">—</span>
              </div>
              <h2 class="sc-title" data-ref="pageTitle">正在识别当前页面…</h2>
              <div class="sc-up" data-ref="pageUp"></div>
              <div class="sc-tracks-head"><span>字幕轨</span><button class="sc-link" type="button" data-ref="refreshTracks">刷新</button></div>
              <div class="sc-tracks" data-ref="tracks"><span class="sc-empty">等待识别页面…</span></div>
            </section>
            <div class="sc-actions">
              <button class="sc-btn primary" type="button" data-ref="syncPage">同步该视频</button>
              <button class="sc-btn" type="button" data-ref="pullVideo">拉取全部分P</button>
            </div>
            <div class="sc-feedback" data-ref="feedback" role="status" aria-live="polite"></div>
            <section class="sc-section">
              <div class="sc-section-head"><span>登录状态</span><button class="sc-link" type="button" data-ref="syncCookies">同步登录状态</button></div>
              <div class="sc-pills">
                <span class="sc-pill" data-ref="loginBrowser" data-state="idle" title="B站登录状态"><i></i><b>浏览器 · 检测中</b></span>
                <span class="sc-pill" data-ref="loginDesktop" data-state="idle" title="桌面端是否已连接"><i></i><b>桌面端 · 未连接</b></span>
              </div>
              <p class="sc-hint">登录态只同步给本机桌面端；读不到 HttpOnly Cookie 时，可在桌面端手动粘贴。</p>
            </section>
            <details class="sc-details" data-ref="settings">
              <summary>连接设置</summary>
              <div class="sc-form">
                <label class="sc-field">端口<input data-ref="port" type="number" min="1" max="65535" inputmode="numeric"></label>
                <label class="sc-field">配对令牌<input data-ref="token" type="password" placeholder="留空表示不校验" autocomplete="off" spellcheck="false"></label>
                <div class="sc-form-foot">
                  <button class="sc-btn small" type="button" data-ref="saveConn">保存并重连</button>
                  <span class="sc-hint">与桌面端「设置 → 用户脚本通信」保持一致</span>
                </div>
              </div>
            </details>
            <details class="sc-details" data-ref="eventsBox">
              <summary>最近事件</summary>
              <div class="sc-log" data-ref="events"></div>
            </details>
          </div>
          <footer class="sc-foot"><span data-ref="footer">127.0.0.1:${DEFAULT_PORT} · 协议 v${PROTOCOL_VERSION}</span><span>v${VERSION}</span></footer>
        </section>
      </div>
    `
    document.documentElement.appendChild(host)

    for (const el of shadow.querySelectorAll('[data-ref]')) {
      els[el.dataset.ref] = el
    }
    els.panel = shadow.querySelector('.sc-panel')
    els.root = shadow.querySelector('.sc-root')
    els.shadow = shadow
    els.host = host
    els.settings.open = false
    els.eventsBox.open = false
    els.port.value = String(state.port)
    els.token.value = state.token
    els.footer.textContent = `127.0.0.1:${state.port} · 协议 v${PROTOCOL_VERSION}`
    els.body = shadow.querySelector('.sc-body')

    renderPage()
    renderTracks()
    renderLogin()
    renderConnection()
    renderEvents()
  }

  function setPill(el, text, pillState) {
    if (!el) return
    el.dataset.state = pillState
    const label = el.querySelector('b')
    if (label) label.textContent = text
    else el.textContent = text
  }

  function feedback(text, level) {
    if (!els.feedback) return
    els.feedback.textContent = String(text || '')
    els.feedback.dataset.state = level || ''
  }

  function renderConnection() {
    if (!els.connPill) return
    const meta = SERVER_STATUS[state.status] || SERVER_STATUS.idle
    setPill(els.connPill, meta.text, meta.state)
    els.connPill.title = state.statusDetail
      ? `${meta.text} · ${state.statusDetail}`
      : meta.text
    els.launcherDot.dataset.state = meta.state
    if (els.lnaNotice) {
      const needsPermission = state.status === 'permission'
      els.lnaNotice.hidden = !needsPermission
      if (needsPermission) {
        els.lnaText.textContent = state.statusDetail || '浏览器需要「本地网络访问」权限才能连接桌面端。'
        els.lnaConnect.textContent = state.permissionNeedsReload
          ? '刷新页面'
          : state.lna === 'denied'
            ? '重试连接'
            : '允许并连接'
      }
    }
    if (els.footer) {
      els.footer.textContent = `127.0.0.1:${state.port} · 协议 v${PROTOCOL_VERSION}${
        state.serverVersion ? ` · 桌面端 v${state.serverVersion}` : ''
      }`
    }
    updateActionAvailability()
  }

  function updateActionAvailability() {
    const page = state.page
    const hasVideo = Boolean(page?.bvid)
    const online = isSocketOpen() && state.status !== 'token' && state.status !== 'rejected'
    if (els.syncPage) els.syncPage.disabled = !hasVideo || !online
    if (els.pullVideo) {
      els.pullVideo.disabled = !hasVideo || !online || !state.compatible
    }
    if (els.refreshTracks) {
      els.refreshTracks.disabled = !hasVideo || state.tracks.loading
    }
    if (els.syncCookies) els.syncCookies.disabled = !online
  }

  function renderPage() {
    if (!els.pageBadge) return
    const page = state.page
    if (!page) {
      els.pageBadge.textContent = '识别中'
      els.pageBadge.dataset.type = 'unknown'
      els.pageId.textContent = '—'
      els.pageTitle.textContent = '正在识别当前页面…'
      els.pageUp.textContent = ''
      updateActionAvailability()
      return
    }

    els.pageBadge.textContent = PAGE_TYPE_LABEL[page.pageType] || '未识别'
    els.pageBadge.dataset.type = page.pageType

    let id = '—'
    if (page.bvid) id = `${page.bvid} · P${page.page}`
    else if (page.seasonId) id = `合集 ${page.seasonId}`
    else if (page.pageType === 'space' && page.uploader?.uid) id = `UID ${page.uploader.uid}`
    els.pageId.textContent = id
    els.pageId.title = id

    els.pageTitle.textContent = page.title || document.title || '未识别到标题'
    els.pageTitle.title = els.pageTitle.textContent

    const name = page.uploader?.name || '未知UP主'
    const uid = page.uploader?.uid
    els.pageUp.textContent = uid ? `UP主 · ${name}（UID ${uid}）` : `UP主 · ${name}`
    els.pageUp.title = els.pageUp.textContent
    updateActionAvailability()
  }

  function renderTracks() {
    if (!els.tracks) return
    els.tracks.replaceChildren()
    const page = state.page
    const add = (message, level) => {
      const span = document.createElement('span')
      span.className = 'sc-empty'
      if (level) span.dataset.state = level
      span.textContent = message
      els.tracks.appendChild(span)
    }

    if (!page?.bvid) {
      add('仅视频页支持字幕轨')
    } else if (state.tracks.loading) {
      add('读取字幕轨…')
    } else if (state.tracks.error) {
      add(`读取失败：${truncate(state.tracks.error, 100)}`, 'error')
      els.tracks.lastChild.title = state.tracks.error
    } else if (!state.tracks.data) {
      add('等待读取字幕轨…')
    } else if (!state.tracks.data.tracks.length) {
      add('没有可用字幕轨（可能未登录或视频没有 CC 字幕）')
    } else {
      for (const track of state.tracks.data.tracks) {
        const chip = document.createElement('span')
        chip.className = 'sc-track'
        chip.textContent = track.label || track.lang || '字幕'
        if (track.lang && track.lang !== track.label) {
          const small = document.createElement('small')
          small.textContent = track.lang
          chip.appendChild(small)
        }
        chip.title = `${track.label || track.lang} · ${track.lang || '未知语言'}${
          state.tracks.data.via ? ` · ${state.tracks.data.via}` : ''
        }`
        els.tracks.appendChild(chip)
      }
    }
    updateActionAvailability()
  }

  function renderLogin() {
    if (!els.loginBrowser) return
    if (state.login.loading) {
      setPill(els.loginBrowser, '浏览器 · 检测中', 'warn')
    } else if (state.login.data?.loggedIn) {
      const data = state.login.data
      const suffix = data.name ? ` · ${data.name}` : ''
      setPill(
        els.loginBrowser,
        `浏览器 · ${data.verified ? '已登录' : '已登录（未验证）'}${suffix}`,
        'ok'
      )
      els.loginBrowser.title = data.message || '已读取到浏览器登录态'
    } else if (state.login.data?.verified) {
      setPill(els.loginBrowser, '浏览器 · 未登录', 'bad')
      els.loginBrowser.title = 'B 站接口返回未登录'
    } else if (state.login.data) {
      setPill(els.loginBrowser, '浏览器 · 检测失败', 'warn')
      els.loginBrowser.title = state.login.data.message || '接口请求失败'
    } else {
      setPill(els.loginBrowser, '浏览器 · 未知', 'idle')
    }

    if (state.cookieSynced && isSocketOpen()) {
      setPill(els.loginDesktop, '桌面端 · 已同步', 'ok')
    } else if (state.status === 'token') {
      setPill(els.loginDesktop, '桌面端 · 待验证', 'bad')
    } else if (isSocketOpen() && state.auth === 'ok') {
      setPill(els.loginDesktop, '桌面端 · 已连接', 'ok')
    } else if (state.status === 'outdated') {
      setPill(els.loginDesktop, '桌面端 · 版本过旧', 'warn')
    } else {
      setPill(els.loginDesktop, '桌面端 · 未连接', 'idle')
    }
    updateActionAvailability()
  }

  function renderEvents() {
    if (!els.events) return
    els.events.replaceChildren()
    for (const item of state.events) {
      const row = document.createElement('div')
      row.className = 'sc-log-item'
      row.dataset.level = item.level
      const time = document.createElement('time')
      time.textContent = formatTime(item.at)
      const text = document.createElement('span')
      text.textContent = item.text
      row.append(time, text)
      els.events.appendChild(row)
    }
    if (els.eventsBox?.open) els.events.scrollTop = els.events.scrollHeight
  }

  function addEvent(text, level) {
    const record = { at: Date.now(), text: String(text), level: level || 'info' }
    state.events.push(record)
    if (state.events.length > MAX_EVENTS) state.events.shift()
    renderEvents()
    const method = record.level === 'error' ? 'warn' : 'log'
    try {
      console[method](`[字幕剪] ${record.text}`)
    } catch {
      /* ignore */
    }
  }

  function setStatus(status, detail) {
    const changed = state.status !== status
    state.status = status
    state.statusDetail = detail || ''
    renderConnection()
    renderLogin()

    if (!changed) return
    if (status === 'online') {
      addEvent(`已连接桌面端${state.serverVersion ? ` v${state.serverVersion}` : ''}`, 'ok')
    } else if (status === 'outdated') {
      addEvent(detail || '桌面端协议过旧', 'warn')
    } else if (status === 'token') {
      addEvent(detail || '需要配对令牌', 'warn')
    } else if (status === 'rejected') {
      addEvent(detail || '桌面端拒绝了该来源', 'error')
    } else if (status === 'permission') {
      addEvent(detail || '需要本地网络访问权限', 'warn')
    } else if (status === 'offline' && state.lastAnnounced !== 'offline') {
      addEvent('未连接桌面端，正在自动重试', 'warn')
    }
    state.lastAnnounced = status
  }

  function setCollapsed(collapsed) {
    state.collapsed = Boolean(collapsed)
    gmSet(STORAGE.collapsed, state.collapsed)
    if (!els.root) return
    els.root.dataset.collapsed = String(state.collapsed)
    els.panel.hidden = state.collapsed
    els.launcher.hidden = !state.collapsed
    els.launcher.setAttribute('aria-expanded', String(!state.collapsed))
    els.panel.setAttribute('aria-hidden', String(state.collapsed))
    if (!state.collapsed) {
      renderPage()
      renderTracks()
      renderLogin()
      renderConnection()
      renderEvents()
      void refreshTracks(false)
      void refreshLogin(false)
    }
  }

  /* =============================== 数据刷新 =============================== */

  async function refreshTracks(force) {
    const page = state.page
    if (!page?.bvid) {
      renderTracks()
      return
    }
    const key = pageKey(page)
    if (state.tracks.loading && state.tracks.key === key) return
    if (!force && state.tracks.key === key && Date.now() - state.tracks.at < TRACKS_TTL_MS) {
      return
    }

    state.tracks = { key, at: 0, data: null, error: '', loading: true }
    renderTracks()

    try {
      const data = await collectTracks(page.bvid, page.page)
      if (state.tracks.key !== key) return
      state.tracks.data = data
      state.tracks.at = Date.now()
      state.tracks.error = ''
      if (data.title && !page.title) page.title = data.title
    } catch (err) {
      if (state.tracks.key !== key) return
      state.tracks.error = err?.message || String(err)
      state.tracks.at = Date.now()
    } finally {
      if (state.tracks.key === key) {
        state.tracks.loading = false
        renderTracks()
        renderPage()
      }
    }
  }

  async function refreshLogin(force) {
    if (state.login.loading) return
    if (!force && Date.now() - state.login.at < LOGIN_TTL_MS) return
    state.login.loading = true
    renderLogin()
    try {
      state.login.data = await checkBrowserLogin()
      state.login.at = Date.now()
    } finally {
      state.login.loading = false
      renderLogin()
    }
  }

  function applyPage(page) {
    const previousKey = pageKey(state.page)
    const nextKey = pageKey(page)
    state.page = page
    if (previousKey !== nextKey) {
      state.tracks = { key: '', at: 0, data: null, error: '', loading: false }
      renderTracks()
    }
    renderPage()
    if (!state.collapsed && nextKey !== previousKey) {
      void refreshTracks(false)
    }
  }

  function tick() {
    let page
    try {
      page = detectPage()
    } catch {
      return
    }
    const signature = [
      page.pageType,
      page.bvid,
      page.page,
      page.title,
      page.uploader?.name,
      location.href
    ].join('|')
    if (signature !== state.pageSignature) {
      state.pageSignature = signature
      applyPage(page)
    }
    if (!state.collapsed) {
      void refreshTracks(false)
      void refreshLogin(false)
    }
  }

  /* =============================== 事件绑定 =============================== */

  function bindUI() {
    els.launcher.addEventListener('click', () => {
      setCollapsed(false)
      // 展开动作本身带用户手势，可以借机申请本地网络权限
      if (!state.ws && (state.status === 'permission' || state.status === 'offline' || state.status === 'idle')) {
        state.blockReconnect = false
        connect()
      }
    })
    els.collapse.addEventListener('click', () => setCollapsed(true))

    // 连接状态做成可点的「连接」入口：Chrome/Edge 的本地网络权限必须有用户手势，
    // 不能只靠页面加载时自动连接。
    els.connPill.setAttribute('role', 'button')
    els.connPill.tabIndex = 0
    els.connPill.addEventListener('click', () => {
      if (state.ws) {
        feedback('桌面端已连接')
        return
      }
      feedback('正在连接桌面端…')
      reconnectNow()
    })
    els.connPill.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        els.connPill.click()
      }
    })
    els.lnaConnect.addEventListener('click', () => {
      if (state.permissionNeedsReload) {
        window.location.reload()
        return
      }
      feedback('正在请求本地网络访问权限…')
      reconnectNow()
    })

    els.reconnect.addEventListener('click', () => {
      addEvent(`手动重连 127.0.0.1:${state.port}`)
      feedback('正在重新连接…')
      reconnectNow()
    })

    els.refreshTracks.addEventListener('click', () => {
      void refreshTracks(true)
    })

    els.syncPage.addEventListener('click', syncPage)
    els.pullVideo.addEventListener('click', pullVideo)
    els.syncCookies.addEventListener('click', () => {
      void syncCookies()
    })

    els.saveConn.addEventListener('click', () => {
      const port = normalizePort(els.port.value)
      if (!port) {
        feedback('端口需在 1–65535 之间', 'error')
        return
      }
      const token = String(els.token.value || '').trim()
      state.port = port
      state.token = token
      els.port.value = String(port)
      gmSet(STORAGE.port, port)
      gmSet(STORAGE.token, token)
      state.cookieSynced = false
      addEvent(`连接设置已保存：127.0.0.1:${port}${token ? '（带配对令牌）' : ''}`)
      feedback('已保存，正在重新连接…', 'ok')
      reconnectNow()
    })

    els.port.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') els.saveConn.click()
    })
    els.token.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') els.saveConn.click()
    })

    els.eventsBox.addEventListener('toggle', () => {
      if (els.eventsBox.open) els.events.scrollTop = els.events.scrollHeight
    })

    els.shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !state.collapsed) {
        event.stopPropagation()
        setCollapsed(true)
      }
    })

    window.addEventListener('beforeunload', () => {
      state.blockReconnect = true
      closeSocket()
    })
  }

  /* =============================== 启动 =============================== */

  function init() {
    const storedPort = normalizePort(gmGet(STORAGE.port, DEFAULT_PORT))
    state.port = storedPort || DEFAULT_PORT
    state.token = String(gmGet(STORAGE.token, '') || '').trim()
    const storedCollapsed = gmGet(STORAGE.collapsed, true)
    state.collapsed = typeof storedCollapsed === 'boolean' ? storedCollapsed : true

    buildUI()
    bindUI()
    setCollapsed(state.collapsed)

    addEvent(`脚本 v${VERSION} 已载入（${detectBrowser()}）`)
    tick()
    window.setInterval(tick, 1_500)
    window.addEventListener('popstate', tick)
    window.addEventListener('hashchange', tick)

    void bootstrapConnection()
  }

  /**
   * LNA 权限是 prompt / denied 时不要自动连接：浏览器只会在用户手势后弹授权，
   * 页面加载时偷偷连一次通常会被静默拦下，用户只会看到「未连接」。
   */
  async function bootstrapConnection() {
    const permission = await queryLocalNetworkPermission()
    state.lna = permission
    watchLocalNetworkPermission()
    if (permission === 'prompt' || permission === 'denied') {
      setStatus('permission', permissionDetail(permission))
      return
    }
    connect()
  }

  if (document.documentElement) init()
  else document.addEventListener('DOMContentLoaded', init, { once: true })
})()
