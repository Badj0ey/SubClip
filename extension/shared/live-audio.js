/**
 * 直播间「只放音频」。
 *
 * 直播不像点播有 SIDX 分片表，最省流量的公开形态是 **HTTP-FLV 纯音频流**：
 *   `xlive/app-room/v2/index/getRoomPlayInfo` 带 `only_audio=1` 时，
 *   http_stream 那一路返回的 FLV 里只有音频 tag（实测：65 KB 里 183 个 audio tag、0 个 video tag）。
 *   HLS(fmp4) 那一路即使只请求音频，返回的 init 段仍带 `avc1` 视频编码，流量没省下来。
 *
 * 所以这里走 FLV + mpegts.js（已内包在 vendor/mpegts.js）。
 * 关掉原生播放器由 page-bridge.js 在页面主世界完成（见那边注释）。
 *
 * 几个必须处理的现实问题：
 *   - url_info 里可能混着**裸 IP 的 host**，证书是 *.bilivideo.com 会直接 TLS 失败 → 必须跳过
 *   - 部分节点 404，要按顺序换 host 重试
 *   - 响应头是 `access-control-allow-origin: *` → 请求**不能**带 credentials，否则被浏览器拦
 *   - 主播没开播时返回 http_stream 为空 / is_pushing=0，要给出人话提示
 */

;(function (root) {
  const ns = (root.__SUBCLIP_EXT__ = root.__SUBCLIP_EXT__ || {})

  /**
   * 取流接口。
   * 曾经用 `xlive/app-room/v2/...`（带公开 appkey 免签），但 2026-10 起该端点对所有参数
   * 组合都返回 `code -400 请求错误`；同一组参数换到 **web-room v2** 就正常。
   * 所以固定走 web 版，且**不带 appkey**（带了反而 -400）。
   */
  const API = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo'
  /** 取流接口的超时：节点抽风时不能无限等 */
  const API_TIMEOUT_MS = 8000
  /** 播放停滞多久算「这个节点废了」，换下一个 */
  const STALL_MS = 12000
  /** 裸 IP 的 host 会因证书不匹配被拒，直接跳过 */
  const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/

  /* ---- ROOMID-BLOCK-START ---- */
  /**
   * 把「直播间地址 / 短号 / 真实 room_id」统一成数字 room_id。
   * 之前 agent.js 传的是 location.href，接口收到
   * `room_id=https://live.bilibili.com/22491717` 直接回 -400 请求错误 ——
   * 这种错在界面上只显示「请求错误」，极难查，所以在这里一次性收口。
   */
  function toRoomId(input) {
    if (typeof input === 'number' && Number.isFinite(input)) return Math.trunc(input)
    const str = String(input == null ? '' : input)
    const m = str.match(/^\s*(\d+)\s*$/) || str.match(/\/(\d+)(?:[/?#]|$)/)
    return m ? Number(m[1]) : 0
  }
  /* ---- ROOMID-BLOCK-END ---- */

  function buildUrl(roomId, qn) {
    const q = new URLSearchParams({
      room_id: String(roomId),
      protocol: '0,1',
      format: '0,1,2',
      codec: '0,1',
      qn: String(qn || 250),
      platform: 'web',
      ptype: '8',
      dolby: '5',
      panorama: '1',
      only_audio: '1',
    })
    return `${API}?${q.toString()}`
  }

  /**
   * 取纯音频 FLV 地址。
   * @returns {Promise<{url: string, host: string, codec: string, candidateHosts: string[]}>}
   */
  async function fetchAudioStream(roomInput, options) {
    const qn = (options && options.qn) || 250
    const roomId = toRoomId(roomInput)
    if (!roomId) throw new Error(`认不出直播间号（收到的是「${String(roomInput).slice(0, 40)}」）`)
    let res
    try {
      res = await fetch(buildUrl(roomId, qn), {
        credentials: 'omit',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`直播取流接口连不上（${err.name === 'TypeError' ? '网络或跨域被拒' : err.message}）`)
    }
    if (!res.ok) throw new Error(`直播取流接口 HTTP ${res.status}`)
    let json
    try {
      json = await res.json()
    } catch {
      throw new Error('直播取流接口返回的不是 JSON（可能被风控页拦截）')
    }
    if (json.code !== 0) throw new Error(`直播取流失败：${json.message || 'code=' + json.code}`)
    const info = (json.data && json.data.playurl_info && json.data.playurl_info.playurl) || {}
    // g_qn_desc 是房间支持的全部画质（含中文名），null 表示不限制
    const qualities = (info.g_qn_desc || [])
      .filter((x) => x && typeof x.qn === 'number')
      .map((x) => ({ qn: x.qn, name: x.desc || String(x.qn) }))

    const d = json.data || {}
    const liveStatus = d.room_info ? d.room_info.live_status : d.live_status
    if (liveStatus !== 1) throw new Error('主播未开播')

    const pi = d.playurl_info && d.playurl_info.playurl
    if (!pi || !pi.stream) throw new Error('直播接口没有返回播放地址')

    const httpStream = pi.stream.find((s) => s.protocol_name === 'http_stream')
    if (!httpStream) throw new Error('没有 http_stream 流（可能是特殊房间）')

    // flv 优先；没有就退 hls（hls 不是纯音频，但比彻底不可用强）
    const order = ['flv', 'ts']
    let picked = null
    for (const name of order) {
      const fmt = (httpStream.format || []).find((f) => f.format_name === name)
      const codecInfo = fmt && (fmt.codec || [])[0]
      if (codecInfo && codecInfo.url_info && codecInfo.url_info.length) {
        picked = { fmtName: name, codecInfo }
        break
      }
    }
    if (!picked) throw new Error('直播流里没有可用编码')
    if (picked.fmtName !== 'flv') {
      throw new Error('只拿到 HLS 流，不是纯音频，已放弃以省流量')
    }

    const infos = picked.codecInfo.url_info
    const domainHosts = infos.map((x) => x.host).filter((h) => h && !IP_RE.test(h))
    if (!domainHosts.length) throw new Error('直播流只给了 IP 地址节点，证书会失败')

    const build = (info) => `${info.host}${picked.codecInfo.base_url}${info.extra || ''}`
    return {
      url: build(infos.find((x) => domainHosts.includes(x.host))),
      host: domainHosts[0],
      codec: picked.codecInfo.codec_name || 'avc1',
      candidateHosts: domainHosts,
      allInfos: infos,
      baseUrl: picked.codecInfo.base_url,
      // 画质下拉：纯音频流本身没有画质概念，这里给的是「换成视频流时的画质」
      qualities,
      qn,
    }
  }

  /** 用第 n 个候选 host 拼地址（换节点重试用） */
  function urlAt(info, index) {
    const i = info.allInfos.findIndex((x) => x.host === info.candidateHosts[index])
    if (i < 0) return null
    const x = info.allInfos[i]
    return `${x.host}${info.baseUrl}${x.extra || ''}`
  }

  /**
   * 创建直播音频播放器。
   * @param {{onChange?: Function, onError?: Function}} hooks
   */
  function createLiveAudio(hooks = {}) {
    const onChange = hooks.onChange || (() => {})
    const onError = hooks.onError || (() => {})

    let player = null
    let el = null
    let stream = null
    let hostIndex = 0
    let destroyed = false
    let lastError = null
    let volume = 1
    /** 用户主动暂停：这时看门狗不能把「暂停」当成断流去换节点 */
    let userPaused = false
    let stopTimer = null
    let currentRoomId = 0

    function stats() {
      return {
        ready: !!player,
        paused: !player || !el || el.paused,
        currentTime: el ? el.currentTime : 0,
        volume,
        live: true,
        host: stream ? stream.candidateHosts[hostIndex] || '' : '',
        qualities: stream ? stream.qualities : [],
        qn: stream ? stream.qn : 0,
        error: lastError ? String(lastError.message || lastError) : '',
      }
    }
    const notify = () => {
      if (!destroyed) onChange(stats())
    }

    function ensureElement() {
      if (el) return el
      el = document.createElement('video')
      el.setAttribute('playsinline', '')
      // 不放 display:none —— 部分情况下浏览器会挂起完全不可见的媒体元素
      el.style.cssText =
        'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;'
      el.volume = volume
      el.addEventListener('playing', notify)
      el.addEventListener('pause', notify)
      el.addEventListener('error', () => {
        const err = new Error('直播音频播放失败')
        lastError = err
        onError(err)
      })
      document.body.appendChild(el)
      return el
    }

    function destroyPlayer() {
      if (player) {
        try {
          player.pause()
          player.unload()
          player.detachMediaElement()
          player.destroy()
        } catch {
          /* ignore */
        }
        player = null
      }
      if (stopTimer) {
        clearInterval(stopTimer)
        stopTimer = null
      }
    }

    /** 记录当前节点的「时间戳/进度」，用来判断是不是卡死了 */
    let lastTick = 0
    let lastTickAt = 0

    function attach(url) {
      destroyPlayer()
      lastTick = 0
      lastTickAt = Date.now()
      const mpegts = root.mpegts
      if (!mpegts || !mpegts.isSupported()) {
        throw new Error('浏览器不支持 MSE/FLV，无法解析直播纯音频流')
      }
      const media = ensureElement()
      player = mpegts.createPlayer(
        { type: 'flv', isLive: true, hasVideo: false, hasAudio: true, url },
        {
          enableWorker: false,
          // 纯音频流里没有视频轨，不设这个会一直等视频
          hasVideo: false,
          lazyLoad: false,
          liveBufferLatencyChasing: true,
          autoCleanupSourceBuffer: true,
        }
      )
      player.on(mpegts.Events.ERROR, (type, detail) => {
        lastError = new Error(`直播流错误：${type} ${detail}`)
        onError(lastError)
      })
      player.attachMediaElement(media)
      player.load()
      // 用户暂停着的时候换节点/换画质，不能顺手把播放恢复起来
      if (!userPaused) player.play()
      notify()
    }

    /** 开始播放某直播间 */
    async function start(roomId) {
      destroyed = false
      lastError = null
      hostIndex = 0
      userPaused = false
      currentRoomId = toRoomId(roomId)
      stream = await fetchAudioStream(currentRoomId)
      attach(stream.url)
      // 看门狗：既处理「断了」（paused），也处理「卡着不动」（currentTime 不前进）。
      // 参考实现最大的坑之一就是节点抽风时不报错也不重连，用户只看到「切了没反应」。
      stopTimer = setInterval(() => {
        if (!el || destroyed || userPaused) return
        const t = el.currentTime
        if (t > lastTick + 0.001) {
          lastTick = t
          lastTickAt = Date.now()
          return
        }
        const stalled = Date.now() - lastTickAt > STALL_MS
        if (!el.paused && !stalled) return
        if (!player || !stream) return
        const next = hostIndex + 1
        if (next >= stream.candidateHosts.length) {
          if (stalled) {
            lastError = new Error('直播流卡住了，且没有备用节点可换')
            onError(lastError)
          }
          return
        }
        hostIndex = next
        lastTickAt = Date.now()
        const url = urlAt(stream, next)
        if (!url) return
        try {
          attach(url)
          onError(new Error(`已切换到备用节点 ${stream.candidateHosts[next].replace(/^https?:\/\//, '')}`))
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          onError(lastError)
        }
      }, 3000)
      return stats()
    }

    /** 换画质：音频流本身不变，但改成视频流时的档位会跟着变，所以重取一次 */
    async function setQuality(nextQn) {
      if (!stream) return stats()
      stream = await fetchAudioStream(currentRoomId, { qn: nextQn })
      hostIndex = 0
      attach(stream.url)
      return stats()
    }

    function stop() {
      destroyPlayer()
      if (el) {
        try {
          el.pause()
          el.removeAttribute('src')
          el.load()
        } catch {
          /* ignore */
        }
      }
      notify()
    }

    /** 暂停：连 mpegts 拉流一起停，否则「暂停」了还在偷偷下载，省流量就白做了 */
    function pause() {
      userPaused = true
      try {
        if (player) player.pause()
      } catch {
        /* ignore */
      }
      try {
        if (el) el.pause()
      } catch {
        /* ignore */
      }
      notify()
    }

    /** 恢复播放：直播没有「接着刚才」这回事，重新贴到直播边缘即可 */
    function play() {
      userPaused = false
      lastTickAt = Date.now()
      try {
        if (player) {
          const r = player.play()
          if (r && typeof r.catch === 'function') r.catch(() => {})
        }
      } catch {
        /* ignore */
      }
      if (el) {
        try {
          const r = el.play()
          if (r && typeof r.catch === 'function') r.catch((err) => onError(err))
        } catch (err) {
          onError(err)
        }
      }
      notify()
    }

    function setVolume(v) {
      volume = Math.max(0, Math.min(1, v))
      if (el) el.volume = volume
      notify()
    }

    function destroy() {
      destroyed = true
      stop()
      if (el) {
        el.remove()
        el = null
      }
      stream = null
    }

    return { start, stop, play, pause, setVolume, setQuality, stats, destroy, getElement: () => el }
  }

  ns.liveAudio = { createLiveAudio, fetchAudioStream, toRoomId }
})(typeof window !== 'undefined' ? window : globalThis)
