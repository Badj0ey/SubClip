/**
 * 页面内「SubClip 工具箱」：视频页 / 直播间左下角的悬浮小圆点，点开是操作面板。
 *
 * 为什么做成页面内悬浮而不是只用 popup：
 *   popup 一失焦就关，而「开音频模式」「点 +1」都是要看着页面用的操作。
 *
 * 面板里只放「与当前页强相关」的东西（音频模式、+1、一键同步）；
 * 端口/令牌这类配置留在 popup 的设置页，避免页面里出现一堆输入框。
 *
 * 依赖（按 manifest 的注入顺序先后加载）：
 *   video 页：shared/sidx.js → shared/audio-player.js → agent.js
 *   live  页：vendor/mpegts.js → shared/live-audio.js → shared/live-danmaku.js → agent.js
 */

;(function () {
  const ns = globalThis.__SUBCLIP_EXT__
  if (!ns) return
  if (globalThis.__SUBCLIP_AGENT_LOADED__) return
  globalThis.__SUBCLIP_AGENT_LOADED__ = true

  const STORE_KEY = 'scAgent'
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /* ------------------------------ 页面识别 ------------------------------ */

  const path = location.pathname
  const isLive = /^\/(blanc\/)?\d+/.test(path) || /^\/live\//.test(path)
  const videoMatch = path.match(/^\/video\/(BV[0-9A-Za-z]+)/)
  const isVideo = !!videoMatch
  if (!isLive && !isVideo) return

  const bvid = isVideo ? videoMatch[1] : ''
  const pageNo = (() => {
    const p = new URLSearchParams(location.search).get('p')
    return p ? Math.max(1, Number(p) || 1) : 1
  })()

  /* ------------------------------ 小工具 ------------------------------ */

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  function storageGet() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORE_KEY, (v) => {
          resolve((v && v[STORE_KEY]) || {})
          void chrome.runtime.lastError
        })
      } catch {
        resolve({})
      }
    })
  }

  function storageSet(patch) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORE_KEY, (v) => {
          const next = { ...((v && v[STORE_KEY]) || {}), ...patch }
          chrome.storage.local.set({ [STORE_KEY]: next }, () => {
            void chrome.runtime.lastError
            resolve(next)
          })
        })
      } catch {
        resolve(patch)
      }
    })
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
          void chrome.runtime.lastError
          resolve(res || { ok: false, message: '后台没有响应' })
        })
      } catch {
        resolve({ ok: false, message: '扩展已重载，请刷新页面' })
      }
    })
  }

  /* --------------------- 与页面主世界通信（直播要停原生播放器） --------------------- */

  let bridgeSeq = 0
  /**
   * @param {string} action
   * @param {object} [payload] 附加参数（如 {qn}）
   * @param {number} [timeout]
   */
  function bridge(action, payload, timeout = 4000) {
    if (typeof payload === 'number') {
      timeout = payload
      payload = null
    }
    return new Promise((resolve) => {
      const id = ++bridgeSeq
      const onReply = (ev) => {
        let data = {}
        try {
          data = JSON.parse(ev.detail || '{}')
        } catch {
          data = {}
        }
        if (data.id !== id) return
        cleanup()
        resolve(data)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve({ ok: false, error: '主世界桥超时' })
      }, timeout)
      function cleanup() {
        clearTimeout(timer)
        document.removeEventListener('subclip:bridge-reply', onReply)
      }
      document.addEventListener('subclip:bridge-reply', onReply)
      try {
        document.dispatchEvent(
          new CustomEvent('subclip:bridge', {
            detail: JSON.stringify(Object.assign({ action, id }, payload || {})),
          })
        )
      } catch {
        cleanup()
        resolve({ ok: false, error: '无法派发桥事件' })
      }
    })
  }

  /* ------------------------------ 面板 DOM ------------------------------ */

  const root = document.createElement('div')
  root.className = 'sc-agent'
  root.setAttribute('data-open', '0')
  root.innerHTML = `
    <button class="sc-dot" id="sc-dot" aria-expanded="false" aria-controls="sc-panel"
            title="SubClip 工具箱" aria-label="SubClip 工具箱">♪</button>
    <div class="sc-panel" id="sc-panel" role="dialog" aria-label="SubClip 工具箱" hidden>
      <div class="sc-head"><span>SubClip 工具箱</span>
        <button class="sc-x" id="sc-close" aria-label="收起面板">×</button></div>
      <div class="sc-conn" id="sc-conn">正在获取桌面端状态…</div>
      <div class="sc-status" id="sc-status"></div>
      <div class="sc-row">
        <label><input type="checkbox" id="sc-audio"> 只放音频（省流量）</label>
        <select id="sc-quality" aria-label="音质" title="音质越高流量越大">
          <option value="auto">自动</option>
          <option value="high">高</option>
          <option value="mid">中</option>
          <option value="low">低</option>
        </select>
      </div>
      <div class="sc-row" id="sc-vq-row" hidden>
        <label for="sc-vq">画质</label>
        <select id="sc-vq" aria-label="画质" title="画质（只放音频时不影响流量，切回画面才生效）"></select>
      </div>
      <div class="sc-player" id="sc-player" hidden>
        <div class="sc-line">
          <button class="sc-play" id="sc-play">播放</button>
          <span class="sc-time" id="sc-time">0:00 / 0:00</span>
        </div>
        <input type="range" id="sc-seek" min="0" max="0" step="0.1" value="0" aria-label="进度">
        <input type="range" id="sc-vol" min="0" max="1" step="0.01" value="1" aria-label="音量">
      </div>
      <div class="sc-row" id="sc-danmaku-row" hidden>
        <label><input type="checkbox" id="sc-danmaku"> 弹幕 +1（点一下原样重发）</label>
      </div>
      <button class="sc-sync" id="sc-sync">同步到桌面端</button>
      <div class="sc-log" id="sc-log"></div>
    </div>`

  const $ = (id) => root.querySelector('#' + id)
  const dot = $('sc-dot')
  const panel = $('sc-panel')
  const elConn = $('sc-conn')
  const elStatus = $('sc-status')
  const elAudio = $('sc-audio')
  const elQuality = $('sc-quality')
  const elVqRow = $('sc-vq-row')
  const elVq = $('sc-vq')
  // 直播页的音频流是整条 FLV，没有「选音轨」这回事，音质下拉在那儿是死控件
  if (isLive) elQuality.hidden = true
  const elPlayerBox = $('sc-player')
  const elPlay = $('sc-play')
  const elTime = $('sc-time')
  const elSeek = $('sc-seek')
  const elVol = $('sc-vol')
  const elDanmakuRow = $('sc-danmaku-row')
  const elDanmaku = $('sc-danmaku')
  const elSync = $('sc-sync')
  const elLog = $('sc-log')

  let logLines = 0
  function log(text, tone = '') {
    if (!text) return
    const div = document.createElement('div')
    if (tone) div.setAttribute('data-tone', tone)
    div.textContent = text
    elLog.prepend(div)
    logLines += 1
    while (logLines > 30 && elLog.lastChild) {
      elLog.removeChild(elLog.lastChild)
      logLines -= 1
    }
  }
  /** 连接状态单独一行（每 4 秒刷新一次）；操作反馈走 setStatus，两者不再互相覆盖 */
  function setConn(text, tone = '') {
    elConn.textContent = text
    if (tone) elConn.setAttribute('data-tone', tone)
    else elConn.removeAttribute('data-tone')
  }

  function setStatus(text, tone = '') {
    elStatus.textContent = text
    if (tone) elStatus.setAttribute('data-tone', tone)
    else elStatus.removeAttribute('data-tone')
  }

  function openPanel(open) {
    panel.hidden = !open
    root.setAttribute('data-open', open ? '1' : '0')
    dot.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) void refreshStatus()
  }
  dot.addEventListener('click', () => openPanel(panel.hidden))
  $('sc-close').addEventListener('click', () => openPanel(false))

  /* ------------------------------ 状态刷新 ------------------------------ */

  let lastPageInfo = null
  async function refreshStatus() {
    const st = await send('get-status')
    if (!st) {
      setConn('无法连接扩展后台', 'error')
      return
    }
    lastPageInfo = st.lastPage || lastPageInfo
    if (st.connected) {
      const who = st.serverVersion ? `桌面端 v${st.serverVersion}` : '桌面端'
      setConn(`已连接 ${who}`, 'ok')
    } else {
      setConn(st.lastError ? `未连接：${st.lastError}` : '桌面端未连接', 'warn')
    }
    const type = lastPageInfo ? lastPageInfo.pageType : isLive ? 'live' : 'video'
    const label =
      { video: '这个视频（含全部分P）', season: '这个合集的全部视频',
        series: '这个系列的全部视频', favlist: '这个收藏夹的全部视频',
        space: '这位UP主的全部投稿' }[type] || '本页内容'
    if (isLive) {
      elSync.disabled = true
      elSync.textContent = '直播间无需同步字幕'
    } else {
      elSync.disabled = !st.connected
      elSync.textContent = `同步${label}`
    }
    return st
  }

  /* ------------------------------ 音频模式：视频页 ------------------------------ */

  let dash = null
  let dashInfo = null
  let nativeVideo = null
  let overlay = null

  function playerHost() {
    const v = document.querySelector('video')
    if (!v) return null
    const box =
      v.closest(
        '.bpx-player-video-wrap, .bpx-player-container, #bilibili-player, .bpx-player-primary-area, #live-player, .web-player'
      ) || v.parentElement
    return { video: v, box }
  }

  function showOverlay({ cover, title, sub }) {
    const hit = playerHost()
    if (!hit || !hit.box) return
    if (getComputedStyle(hit.box).position === 'static') hit.box.style.position = 'relative'
    removeOverlay()
    overlay = document.createElement('div')
    overlay.className = 'sc-overlay'
    const img = document.createElement('img')
    img.alt = ''
    if (cover) img.src = cover
    const wrap = document.createElement('div')
    wrap.className = 'sc-ov-text'
    const t = document.createElement('div')
    t.className = 'sc-ov-title'
    t.textContent = title || ''
    const s = document.createElement('div')
    s.className = 'sc-ov-sub'
    s.textContent = sub || '音频模式：已在省流量播放，画面已暂停'
    wrap.append(t, s)
    if (cover) overlay.append(img)
    overlay.append(wrap)
    hit.box.appendChild(overlay)
  }

  function removeOverlay() {
    if (overlay && overlay.parentElement) overlay.remove()
    overlay = null
  }

  async function startVideoAudio(quality) {
    const hit = playerHost()
    if (!hit) throw new Error('页面里还没找到播放器')
    nativeVideo = hit.video
    const startAt = nativeVideo.currentTime || 0
    nativeVideo.pause()

    setStatus('正在获取音轨…', 'warn')
    dashInfo = await ns.dashAudio.fetchVideoInfo(bvid, pageNo)
    const track = ns.dashAudio.pickAudioTrack(dashInfo.audios, quality)
    if (!track) throw new Error('这个视频没有可用的音频流')

    dash = ns.dashAudio.createDashAudio({
      onChange: (s) => renderPlayer(s),
      onError: (err) => log(String(err.message || err), 'error'),
    })
    await dash.load({ track, duration: dashInfo.duration, startAt })
    await dash.play()
    elPlayerBox.hidden = false
    showOverlay({
      cover: dashInfo.cover,
      title: dashInfo.title,
      sub: `音频模式 · ${Math.round((track.bandwidth || 0) / 1000)} kbps · P${dashInfo.page}`,
    })
    setStatus('音频模式已开启，画面已暂停', 'ok')
    await offerVideoQuality()
  }

  /** B 站 qn 的中文名兜底（playurl 没给 support_formats 时用） */
  const QN_NAMES = {
    127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P60',
    112: '1080P+', 80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P', 6: '240P',
  }

  /**
   * 视频页画质：档位由播放器自己给（getSupportedQualityList），切换走 requestQuality。
   * 只放音频时切它不影响流量，但切回画面时就是这一档 —— 用户要的就是这个「提前选好」。
   */
  async function offerVideoQuality() {
    const r = await bridge('quality')
    const supported = (r && r.ok && r.list) || []
    const fromApi = (dashInfo && dashInfo.formats) || []
    const list = supported.length
      ? supported.map((qn) => {
          const f = fromApi.find((x) => x.quality === qn)
          return { qn, name: (f && (f.new_description || f.display_desc)) || QN_NAMES[qn] || String(qn) }
        })
      : []
    if (!list.length) {
      log(`画质下拉不可用：${(r && r.error) || '播放器没有返回可用档位'}`, 'warn')
      return
    }
    fillQuality(list, r && r.ok ? r.current : 0, async (qn) => {
      const res = await bridge('set-quality', { qn })
      if (res && res.ok) log(`画质已切换为 ${QN_NAMES[qn] || qn}（${res.method}）`)
      else log(`切画质失败：${(res && res.error) || '页面没有暴露画质接口'}`, 'warn')
    })
  }

  function stopVideoAudio() {
    elVqRow.hidden = true
    if (dash) {
      const t = dash.stats ? dash.stats().currentTime : 0
      dash.destroy()
      dash = null
      if (nativeVideo && t > 0) {
        try {
          nativeVideo.currentTime = t
        } catch {
          /* ignore */
        }
      }
    }
    if (nativeVideo) {
      try {
        nativeVideo.play()
      } catch {
        /* 自动播放限制，用户点一下即可 */
      }
    }
    nativeVideo = null
    removeOverlay()
    elPlayerBox.hidden = true
    setStatus('音频模式已关闭', '')
  }

  function renderPlayer(s) {
    if (!s) return
    // 直播是无穷流：没有总时长、不能拖进度，只显示已播时长 + 音量
    if (s.live || !s.duration) {
      elTime.textContent = s.live ? `直播 · ${fmtTime(s.currentTime)}` : `${fmtTime(s.currentTime)} / 0:00`
      elSeek.hidden = true
    } else {
      elTime.textContent = `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}`
      elSeek.hidden = false
      elSeek.max = String(Math.max(1, s.duration || 0))
      if (document.activeElement !== elSeek) elSeek.value = String(s.currentTime || 0)
    }
    elPlay.textContent = s.paused ? '播放' : '暂停'
    elVol.value = String(s.volume == null ? 1 : s.volume)
    root.setAttribute('data-active', '1')
  }

  /**
   * 填画质下拉。
   * 视频页的档位来自 playurl 的 support_formats（带中文名），直播页来自房间的 g_qn_desc。
   * 拿不到就整行隐藏 —— 宁可不显示，也不给一个点了没反应的控件。
   */
  function fillQuality(list, current, onPick) {
    if (!list || !list.length) {
      elVqRow.hidden = true
      return
    }
    elVq.innerHTML = list.map((x) => `<option value="${x.qn}">${x.name}</option>`).join('')
    if (current && list.some((x) => x.qn === current)) elVq.value = String(current)
    elVqRow.hidden = false
    elVq.onchange = () => {
      const qn = Number(elVq.value)
      void onPick(qn)
    }
  }

  /* ------------------------------ 音频模式：直播页 ------------------------------ */

  let live = null
  let nativeStopped = false

  async function startLiveAudio() {
    live = ns.liveAudio.createLiveAudio({
      onChange: (s) => {
        renderPlayer(s)
        if (s.error) log(s.error, 'error')
      },
      onError: (err) => {
        log(String(err.message || err), 'error')
        setStatus(String(err.message || err), 'error')
      },
    })
    setStatus('正在获取直播音频流…', 'warn')
    // 传数字房间号：接口只认 room_id，传整条 URL 会得到 -400「请求错误」
    try {
      await live.start(ns.liveAudio.toRoomId(location.pathname))
    } catch (err) {
      // 少数房间（刚开播 / 未转码）不给纯音频流。与其让用户以为「点了没反应」，
      // 不如退回正常画面播放并说清原因 —— 这时会重新消耗视频流量。
      const msg = String(err.message || err)
      log(`纯音频流不可用：${msg}`, 'warn')
      elAudio.checked = false
      const back = await bridge('resume')
      setStatus(
        back && back.ok
          ? `该房间不提供纯音频流，已恢复画面播放（${msg}）`
          : `该房间不提供纯音频流：${msg}`,
        'warn'
      )
      return
    }
    // 停掉原生播放器，否则视频流照旧在下载，流量没省
    const r = await bridge('stop')
    nativeStopped = !!r.ok
    if (!r.ok) log(`停原生播放器失败：${r.error || '未知原因'}`, 'warn')
    // 面板要留着：用户得能调音量（直播没有进度可拖，renderPlayer 会隐藏进度条）
    elPlayerBox.hidden = false
    showOverlay({
      cover: document.querySelector('meta[property="og:image"]')?.content || '',
      title: document.title.replace(/_哔哩哔哩直播.*$/, ''),
      sub: '音频模式 · 画面已停止以节省流量' + (r.ok ? '' : '（原生播放器未停掉，可能仍在耗流量）'),
    })
    setStatus(r.ok ? '直播音频模式已开启' : '音频已播放，但原生播放器没停掉', r.ok ? 'ok' : 'warn')
    // 直播页拿不到播放器接口，画质只能作用于「万一要退回视频流」时的档位
    fillQuality(live && live.stats().qualities, live && live.stats().qn, async (qn) => {
      try {
        await live.setQuality(qn)
        log(`画质已切换为 ${QN_NAMES[qn] || qn}`)
      } catch (err) {
        log(`切画质失败：${String(err.message || err)}`, 'warn')
      }
    })
  }

  function stopLiveAudio() {
    elVqRow.hidden = true
    if (live) {
      live.destroy()
      live = null
    }
    removeOverlay()
    if (nativeStopped) {
      nativeStopped = false
      void bridge('resume').then((r) => {
        if (!r.ok) log(`恢复画面失败：${r.error || '需手动刷新页面'}`, 'warn')
      })
    }
    setStatus('音频模式已关闭', '')
  }

  /* ------------------------------ 开关联动 ------------------------------ */

  let busy = false
  async function applyAudioMode(on, quality) {
    if (busy) return
    busy = true
    try {
      if (on) {
        if (isVideo) await startVideoAudio(quality)
        else await startLiveAudio()
        root.setAttribute('data-active', '1')
      } else {
        if (isVideo) stopVideoAudio()
        else stopLiveAudio()
        root.removeAttribute('data-active')
      }
      await storageSet({ audioMode: on, quality })
    } catch (err) {
      const msg = String((err && err.message) || err)
      log(msg, 'error')
      setStatus(msg, 'error')
      elAudio.checked = false
      // 失败要保证原生播放器回到能用的状态
      if (isVideo) stopVideoAudio()
      else {
        removeOverlay()
        if (nativeStopped) {
          nativeStopped = false
          void bridge('resume')
        }
      }
      await storageSet({ audioMode: false })
    } finally {
      busy = false
    }
  }

  elAudio.addEventListener('change', () => applyAudioMode(elAudio.checked, elQuality.value))
  elQuality.addEventListener('change', async () => {
    await storageSet({ quality: elQuality.value })
    if (elAudio.checked && isVideo) {
      // 换档位：重启音频管线，保持当前进度
      await applyAudioMode(false, elQuality.value)
      await wait(150)
      await applyAudioMode(true, elQuality.value)
    }
  })

  elPlay.addEventListener('click', () => {
    if (!dash) return
    if (dash.stats().paused) void dash.play()
    else dash.pause()
  })
  elSeek.addEventListener('input', () => {
    if (dash) void dash.seekTo(Number(elSeek.value))
  })
  elVol.addEventListener('input', () => {
    const v = Number(elVol.value)
    if (dash) dash.setVolume(v)
    if (live) live.setVolume(v)
  })

  /* ------------------------------ 弹幕 +1 ------------------------------ */

  let danmaku = null
  async function applyDanmaku(on) {
    if (!isLive || !ns.liveDanmaku) return
    try {
      if (on) {
        if (!danmaku) danmaku = ns.liveDanmaku.createDanmakuPlus({ onLog: log })
        await danmaku.start()
      } else if (danmaku) {
        danmaku.destroy()
        danmaku = null
        log('弹幕 +1 已关闭')
      }
      await storageSet({ danmakuPlus: on })
    } catch (err) {
      const msg = String((err && err.message) || err)
      log(msg, 'error')
      elDanmaku.checked = false
      await storageSet({ danmakuPlus: false })
    }
  }
  elDanmaku.addEventListener('change', () => applyDanmaku(elDanmaku.checked))

  /* ------------------------------ 一键同步 ------------------------------ */

  elSync.addEventListener('click', async () => {
    elSync.disabled = true
    const old = elSync.textContent
    elSync.textContent = '正在同步…'
    try {
      const r = await send('sync-all')
      const ok = !!(r && r.ok)
      log((r && r.message) || (ok ? '已同步' : '同步失败'), ok ? 'ok' : 'error')
      setStatus((r && r.message) || (ok ? '已同步' : '同步失败'), ok ? 'ok' : 'warn')
    } finally {
      elSync.textContent = old
      await refreshStatus()
    }
  })

  /* ------------------------------ 初始化 ------------------------------ */

  async function boot() {
    document.documentElement.appendChild(root)
    if (isLive) elDanmakuRow.hidden = false

    const saved = await storageGet()
    if (saved.quality) elQuality.value = saved.quality
    if (saved.panelOpen) openPanel(true)

    await refreshStatus()
    setInterval(() => {
      if (panel.hidden) return
      void refreshStatus()
    }, 4000)

    // 恢复上次的开关状态。音频模式静默恢复失败也算正常（比如换了视频/主播没开播）
    if (saved.danmakuPlus && isLive) {
      elDanmaku.checked = true
      await applyDanmaku(true)
    }
    if (saved.audioMode) {
      elAudio.checked = true
      await applyAudioMode(true, saved.quality || 'auto')
    }

    log(`${isVideo ? '视频页' : '直播间'}工具箱已就绪`)
  }

  // 页面可能是 SPA 切过来的，等 body 出来再挂
  if (document.body) void boot()
  else document.addEventListener('DOMContentLoaded', () => void boot(), { once: true })
})()
