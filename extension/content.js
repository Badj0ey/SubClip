/**
 * 内容脚本：
 *   1. 识别当前 B 站页面类型并提取视频信息，上报给 background
 *   2. 在本页面上下文里调用 B 站接口拿字幕轨列表
 *
 * 为什么接口调用必须放在这里，而不是 service worker：
 *   B 站的 SESSDATA 多为 SameSite=Lax，而 service worker 发起的请求对 bilibili.com
 *   而言是「跨站」请求，浏览器不会带上该 Cookie，导致接口返回未登录状态、拿不到字幕。
 *   内容脚本运行在页面里，www.bilibili.com → api.bilibili.com 属于同站，Cookie 与
 *   Referer 都天然正确。
 */

/* =============================== 一、页面检测 =============================== */

const SUFFIX_RE = /\s*[-_|]\s*哔哩哔哩.*$/i

function text(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    const t = el?.textContent?.trim()
    if (t) return t
  }
  return ''
}

function attr(selectors, name) {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    const v = el?.getAttribute?.(name)
    if (v) return v
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

function getCover() {
  return (
    attr(['meta[itemprop="image"]', 'meta[property="og:image"]'], 'content') ||
    attr(['.bili-video-card__image img', 'video'], 'poster') ||
    null
  )
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
    cover: getCover()
  }

  const bv = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(path)
  if (bv) {
    return {
      ...base,
      pageType: 'video',
      bvid: bv[1],
      page: Math.max(1, Number(url.searchParams.get('p') || '1') || 1),
      uploader: getUploader()
    }
  }

  if (/^\/list\//.test(path)) {
    const sid = url.searchParams.get('sid')
    return {
      ...base,
      pageType: 'season',
      bvid: '',
      seasonId: sid ? Number(sid) : null,
      seasonTitle: base.title,
      uploader: getUploader()
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
      uploader: { uid: Number(lists[1]), name: getUploader().name, avatar: null }
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
      uploader: { uid: Number(fav[1]), name: getUploader().name, avatar: null }
    }
  }

  const space = /^\/(\d+)(?:\/(video|dynamic|index))?\/?$/.exec(path)
  if (space) {
    return {
      ...base,
      pageType: 'space',
      bvid: '',
      uploader: { uid: Number(space[1]), name: getUploader().name, avatar: null }
    }
  }

  const loose = /(BV[0-9A-Za-z]{10})/.exec(location.href)
  return {
    ...base,
    pageType: loose ? 'video' : 'unknown',
    bvid: loose ? loose[1] : '',
    uploader: getUploader()
  }
}

/* ============================ 二、WBI 签名与接口 ============================ */

/** 页面内接口单次请求超时：卡住的请求会让弹窗一直停在「检测中…」 */
const API_TIMEOUT_MS = 15_000

/* ---- WBI-BLOCK-START （此段由 tests/wbi.test.ts 提取后单测，请勿挪动标记） ---- */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
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
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
    20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
    10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
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
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'include',
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  const nav = await res.json()
  const key = buildMixinKey(nav?.data?.wbi_img?.img_url, nav?.data?.wbi_img?.sub_url)
  wbiCache = { key, ts: Date.now() }
  return key
}

async function apiGet(url, params) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined) u.searchParams.set(k, String(v))
  }
  const res = await fetch(u.toString(), {
    credentials: 'include',
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (data && typeof data === 'object' && Number(data.code) !== 0) {
    throw new Error(`接口返回 ${data.code}：${data.message || '未知错误'}`)
  }
  return data.data
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

/**
 * 拿某个分P 的字幕轨。
 * 与参考实现（bilibili_api.py 的 get_player_info）保持一致：
 *   1. 先试带 WBI 签名的 x/player/wbi/v2（同时带 aid，部分稿件只认 aid）
 *   2. 失败回退免签名的 x/player/v2
 * 每次都会记录失败原因，便于在面板上看到到底是哪一步断了。
 */
async function getSubtitleTracks(bvid, cid, aid) {
  const errors = []

  // 1. WBI 签名接口
  try {
    const key = await getWbiKey()
    const params = { bvid, cid }
    if (aid) params.aid = aid
    const signed = signWbi(params, key)
    const data = await apiGet('https://api.bilibili.com/x/player/wbi/v2', signed)
    const tracks = pickTracks(data)
    if (tracks.length) return { tracks, via: 'wbi/v2' }
    // 接口通了但没有字幕轨，也记一笔，继续用老接口确认一次
    errors.push('wbi/v2: 无字幕轨')
  } catch (err) {
    errors.push(`wbi/v2: ${err.message}`)
  }

  // 2. 免签名老接口
  try {
    const data = await apiGet('https://api.bilibili.com/x/player/v2', { bvid, cid })
    const tracks = pickTracks(data)
    if (tracks.length) return { tracks, via: 'player/v2' }
    errors.push('player/v2: 无字幕轨')
  } catch (err) {
    errors.push(`player/v2: ${err.message}`)
  }

  // 两个接口都通了但确实没字幕，属于正常情况（视频没有 CC 字幕）
  const onlyEmpty = errors.every((e) => e.endsWith('无字幕轨'))
  if (onlyEmpty) return { tracks: [], via: 'none' }
  throw new Error(errors.join('；'))
}

/** 页面内获取视频信息（同样依赖登录态） */
async function getVideoInfo(bvid) {
  return apiGet('https://api.bilibili.com/x/web-interface/view', { bvid })
}

/**
 * 抓取某分P 的字幕轨列表。
 * 只负责「需要 Cookie 的接口调用」，字幕文件本体由 background 下载（那里不受 CORS 限制）。
 */
async function collectTracks(bvid, page) {
  const info = await getVideoInfo(bvid)
  const pages = info?.pages || []
  if (!pages.length) throw new Error('视频没有分P 信息')
  const target = pages.find((p) => Number(p.page) === Number(page)) || pages[0]

  const { tracks, via } = await getSubtitleTracks(bvid, target.cid, info?.aid)
  return {
    ok: true,
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

/* ============================ 三、上报与消息路由 ============================ */

let lastKey = ''

function report() {
  let info
  try {
    info = detectPage()
  } catch {
    return
  }
  const key = [info.pageType, info.bvid, info.page, info.url].join('|')
  if (key === lastKey) return
  lastKey = key

  try {
    chrome.runtime.sendMessage({ type: 'page-detected', payload: info }, () => void chrome.runtime.lastError)
  } catch {
    /* 扩展重载期间会抛错，忽略 */
  }
}

// background 在内容脚本缺失时可能用 scripting 再注入一次，这里做幂等守卫
if (!globalThis.__SRT_HELPER_CONTENT_LOADED__) {
  globalThis.__SRT_HELPER_CONTENT_LOADED__ = true

  report()
  window.addEventListener('popstate', report)
  window.addEventListener('hashchange', report)
  setInterval(report, 1500)

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'get-page-info') {
      sendResponse(detectPage())
      return true
    }

    if (msg?.type === 'collect-tracks') {
      collectTracks(msg.bvid, msg.page)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, message: err?.message || String(err) }))
      return true
    }

    return false
  })
}

/* ============================ 四、给同世界脚本的导出 ============================ */

// agent.js 等后续内容脚本与本文件共享同一个「隔离世界」，理论上能直接引用这里的
// 顶层函数，但那属于隐式耦合：manifest 里脚本顺序一变就会变成 TDZ 报错。
// 这里显式挂到一个命名空间上，用到的只有 WBI 签名（直播发弹幕要）。
;(function () {
  const ns = (globalThis.__SUBCLIP_EXT__ = globalThis.__SUBCLIP_EXT__ || {})
  ns.wbi = { signWbi, buildMixinKey, getWbiKey, apiGet }
  ns.page = { detectPage }
})()
