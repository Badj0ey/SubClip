/**
 * 视频页「只放音频」播放器。
 *
 * 思路：B 站视频是 DASH（音视频分离、fMP4 分片）。正常播放会同时拉视频轨和音频轨，
 * 视频轨占绝大多数流量。这里只取音频轨：
 *   1. playurl 接口拿 dash.audio（多条码率，按需选）
 *   2. 取该轨的 init 段（SegmentBase.Initialization）与 SIDX 索引（indexRange）
 *   3. 由 SIDX 算出「时间 → 字节区间」，按需 Range 请求分片
 *   4. 用 MediaSource + SourceBuffer 拼成一条只有音频的流，交给 <audio> 播放
 *
 * 同时把原生 <video> 暂停 —— 暂停会让它停止拉流，于是整页只剩音频流量。
 *
 * 关键实现约束（都是踩过的坑）：
 *   - CDN 请求必须带 Range，且**不能**带 credentials（部分节点返回 ACAO:* ，带凭证会被浏览器拦）
 *   - 必须校验返回字节数，非 206 或长度不足要报错，否则会把残片喂给 SourceBuffer
 *   - SourceBuffer 同一时刻只能有一个 appendBuffer 在途，必须排队
 *   - 跳转时目标段可能不在已缓冲区间，要「先补该段、再定位播放位置」
 */

;(function (root) {
  const ns = (root.__SUBCLIP_EXT__ = root.__SUBCLIP_EXT__ || {})
  const { parseSidx, buildChunks, findSegment } = ns.sidx

  const PLAYURL = 'https://api.bilibili.com/x/player/playurl'
  const VIEW = 'https://api.bilibili.com/x/web-interface/view'

  /** 缓冲：往前保持多少秒 */
  const AHEAD_SEC = 30
  /** 缓冲：总量上限（超过就丢弃旧数据，避免 QuotaExceededError） */
  const KEEP_SEC = 120
  /** 单次 append 后允许的最大重试次数 */
  const MAX_RETRY = 3

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  async function getJson(url, label = '接口') {
    let res
    try {
      res = await fetch(url, { credentials: 'include' })
    } catch (err) {
      // 浏览器给的 "Failed to fetch" 信息量为零，得自己补上说清是谁、为什么
      throw new Error(`${label}连不上（${describeNetError(err)}）`)
    }
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`)
    let json
    try {
      json = await res.json()
    } catch {
      throw new Error(`${label}返回的不是 JSON（可能被风控页拦截）`)
    }
    if (json.code !== 0) throw new Error(json.message || `${label} code=${json.code}`)
    return json.data
  }

  /** 把底层 fetch 异常翻译成用户能看懂的一句话 */
  function describeNetError(err) {
    const name = err && err.name
    if (name === 'AbortError') return '请求超时'
    if (name === 'TypeError') return '网络或跨域被拒'
    return (err && err.message) || '未知错误'
  }

  /** 只请求一段字节；返回 ArrayBuffer */
  async function getRange(url, start, end, retry = 0) {
    try {
      const res = await fetch(url, {
        credentials: 'omit',
        headers: { Range: `bytes=${start}-${end}` },
      })
      if (!res.ok) throw new Error(`分片 HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      const want = end - start + 1
      if (buf.byteLength !== want) {
        throw new Error(`分片长度不符：期望 ${want}，实得 ${buf.byteLength}`)
      }
      return buf
    } catch (err) {
      if (retry < MAX_RETRY) {
        await wait(300 * (retry + 1))
        return getRange(url, start, end, retry + 1)
      }
      // 把主机名带出来：CDN 有多个节点，失败时得知道是哪个节点不通
      let host = '未知主机'
      try {
        host = new URL(url).host
      } catch {
        /* 地址本身不合法，就用默认文案 */
      }
      throw new Error(`音频分片请求失败（${host}）：${describeNetError(err)}`)
    }
  }

  /**
   * 取某条音轨的分片表与 init 段。
   * @returns {{init: ArrayBuffer, chunks: Array, duration: number, mime: string, url: string}}
   */
  async function loadTrack(track) {
    // 先把形状校验清楚：缺字段时报「缺少播放地址」比「Invalid URL」好查一百倍
    if (!track || !track.baseUrl) {
      const keys = track ? Object.keys(track).join(',') : '空对象'
      throw new Error(`这条音轨没有播放地址（实有字段：${keys}）`)
    }
    const seg = track.SegmentBase
    if (!seg || !seg.Initialization || !seg.indexRange) {
      throw new Error('这条音轨没有分片索引，无法按需拉取')
    }
    const initEnd = Number(seg.Initialization.split('-')[1])
    const [idxStart, idxEnd] = seg.indexRange.split('-').map(Number)

    const init = await getRange(track.baseUrl, 0, initEnd)
    const idx = await getRange(track.baseUrl, idxStart, idxEnd)
    const sidx = parseSidx(new DataView(idx), 0)
    const chunks = buildChunks(sidx, idxEnd)
    if (chunks.length < 2) throw new Error('SIDX 里没有分片信息')

    return { init, chunks, url: track.baseUrl }
  }

  /**
   * 创建一个「只放音频」的播放器。
   * @param {{onChange?: (state: object) => void, onError?: (err: Error) => void}} hooks
   */
  function createDashAudio(hooks = {}) {
    const onChange = hooks.onChange || (() => {})
    const onError = hooks.onError || (() => {})

    let audio = null
    let mediaSource = null
    let sb = null
    let track = null
    /** 音轨的真实取流地址（playurl 给的 baseUrl，可能随签名过期，切换/重载时更新） */
    let trackUrl = ''
    let chunks = null
    let totalDuration = 0
    let destroyed = false
    let pumping = false
    let appendBusy = null // 串行化 append 的 promise
    let fetchCursor = 0 // 下一个要追加的真实分片下标
    let lastError = null

    const notify = () => {
      if (destroyed) return
      onChange(stats())
    }

    function stats() {
      let bufferedEnd = 0
      let bufferedStart = 0
      if (sb && sb.buffered.length) {
        try {
          bufferedStart = sb.buffered.start(0)
          bufferedEnd = sb.buffered.end(sb.buffered.length - 1)
        } catch {
          /* SourceBuffer 正在更新时读取会抛，忽略即可 */
        }
      }
      return {
        ready: !!audio,
        currentTime: audio ? audio.currentTime : 0,
        duration: totalDuration || (audio && isFinite(audio.duration) ? audio.duration : 0),
        paused: audio ? audio.paused : true,
        bufferedStart,
        bufferedEnd,
        ahead: Math.max(0, bufferedEnd - (audio ? audio.currentTime : 0)),
        volume: audio ? audio.volume : 1,
        error: lastError ? String(lastError.message || lastError) : '',
      }
    }

    /** 串行执行 append，返回 promise */
    function append(buf) {
      const run = async () => {
        if (destroyed || !sb) return
        if (sb.updating) await waitForUpdate()
        await new Promise((resolve, reject) => {
          const ok = () => {
            sb.removeEventListener('updateend', ok)
            sb.removeEventListener('error', bad)
            resolve()
          }
          const bad = () => {
            sb.removeEventListener('updateend', ok)
            sb.removeEventListener('error', bad)
            reject(new Error('SourceBuffer 追加失败'))
          }
          sb.addEventListener('updateend', ok)
          sb.addEventListener('error', bad)
          try {
            sb.appendBuffer(buf)
          } catch (err) {
            sb.removeEventListener('updateend', ok)
            sb.removeEventListener('error', bad)
            reject(err)
          }
        })
      }
      const next = (appendBusy || Promise.resolve()).then(run, run)
      appendBusy = next.catch(() => {})
      return next
    }

    function waitForUpdate(timeout = 3000) {
      return new Promise((resolve) => {
        if (!sb || !sb.updating) return resolve()
        const done = () => {
          sb.removeEventListener('updateend', done)
          resolve()
        }
        sb.addEventListener('updateend', done)
        setTimeout(() => {
          sb.removeEventListener('updateend', done)
          resolve()
        }, timeout)
      })
    }

    /** 丢掉 currentTime 之前太旧的缓冲，防止 SourceBuffer 超配额 */
    function prune() {
      if (!sb || !sb.buffered.length || sb.updating) return
      const cut = Math.max(0, (audio ? audio.currentTime : 0) - 10)
      try {
        if (sb.buffered.start(0) < cut) sb.remove(0, cut)
      } catch {
        /* 忽略：下一轮再试 */
      }
    }

    /** 追加某个真实分片（下标基于 chunks，哨兵不算） */
    async function appendChunk(i) {
      const c = chunks[i]
      if (!c || !c.size) return
      const buf = await getRange(trackUrl, c.offset, c.offset + c.size - 1)
      await append(buf)
    }

    /** 从 givenTime 开始，把缓冲补到 AHEAD_SEC */
    async function pump() {
      if (pumping || destroyed) return
      pumping = true
      try {
        while (!destroyed) {
          const cur = audio ? audio.currentTime : 0
          const end = sb && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0
          if (end - cur >= AHEAD_SEC) break
          // 下一个该补的位置：取「缓冲末尾」所在分片的下一个
          const at = Math.max(end, cur)
          let i = findSegment(chunks, at)
          if (i < 0) i = 0
          // 若缓冲末尾恰好压在分片边界上，从下一个开始
          if (chunks[i] && at > chunks[i].time + chunks[i].duration - 0.001) i += 1
          if (i >= chunks.length - 1) break
          await appendChunk(i)
          prune()
          notify()
        }
      } catch (err) {
        lastError = err
        onError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        pumping = false
      }
    }

    /** 跳到 t 秒：保证该位置的段已 buffer，再定位 */
    async function seekTo(t) {
      if (!audio || !chunks) return
      const clamped = Math.max(0, Math.min(t, Math.max(0, totalDuration - 0.2)))
      const i = findSegment(chunks, clamped)
      if (i < 0) return
      const haveData =
        sb &&
        sb.buffered.length > 0 &&
        (() => {
          try {
            for (let k = 0; k < sb.buffered.length; k++) {
              if (clamped >= sb.buffered.start(k) && clamped <= sb.buffered.end(k)) return true
            }
          } catch {
            /* ignore */
          }
          return false
        })()
      if (!haveData) {
        try {
          await appendChunk(i)
          // 往前多补一段，避免刚跳过去就卡住
          if (chunks[i + 1] && chunks[i - 1] && chunks[i - 2]) await appendChunk(i - 2).catch(() => {})
        } catch (err) {
          lastError = err
          onError(err instanceof Error ? err : new Error(String(err)))
        }
      }
      audio.currentTime = clamped
      fetchCursor = i + 1
      notify()
      pump()
    }

    /**
     * 加载某条音轨并从头（或指定位置）播放。
     * @param {{track: object, duration: number, startAt?: number}} opts
     */
    async function load(opts) {
      destroyed = false
      lastError = null
      track = opts.track
      totalDuration = opts.duration || 0

      const loaded = await loadTrack(track)
      chunks = loaded.chunks
      trackUrl = loaded.url

      const codecs = track.codecs || 'mp4a.40.2'
      const candidates = [`audio/mp4; codecs="${codecs}"`, 'audio/mp4']
      let mime = candidates.find((m) => MediaSource.isTypeSupported(m))
      if (!mime) throw new Error(`浏览器不支持解码 ${codecs}`)

      audio = document.createElement('audio')
      audio.preload = 'auto'
      audio.volume = 1
      audio.style.display = 'none'
      document.body.appendChild(audio)

      mediaSource = new MediaSource()
      audio.src = URL.createObjectURL(mediaSource)
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('MediaSource 打开超时')), 6000)
        mediaSource.addEventListener(
          'sourceopen',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true }
        )
      })

      try {
        sb = mediaSource.addSourceBuffer(mime)
      } catch {
        mime = 'audio/mp4'
        sb = mediaSource.addSourceBuffer(mime)
      }
      sb.mode = 'segments'

      audio.addEventListener('timeupdate', () => {
        notify()
        pump()
      })
      audio.addEventListener('play', notify)
      audio.addEventListener('pause', notify)
      audio.addEventListener('seeked', () => {
        notify()
        pump()
      })
      audio.addEventListener('error', () => {
        const err = new Error('音频解码失败')
        lastError = err
        onError(err)
      })
      if (mediaSource) {
        mediaSource.addEventListener('sourceended', () => notify())
      }

      if (totalDuration > 0) {
        try {
          mediaSource.duration = totalDuration
        } catch {
          /* 某些实现此时不允许设置，忽略 */
        }
      }

      await append(loaded.init)

      const startAt = Math.max(0, Math.min(opts.startAt || 0, Math.max(0, totalDuration - 0.2)))
      const i = Math.max(0, findSegment(chunks, startAt))
      await appendChunk(i)
      // 起来之后立刻再补两段，避免第一段播完就断
      for (const k of [i + 1, i + 2]) {
        if (chunks[k] && chunks[k].size) await appendChunk(k).catch(() => {})
      }
      fetchCursor = i + 3
      audio.currentTime = startAt
      notify()
      return stats()
    }

    async function play() {
      if (!audio) return
      try {
        await audio.play()
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
      pump()
    }

    function pause() {
      if (audio) audio.pause()
    }

    function setVolume(v) {
      if (audio) audio.volume = Math.max(0, Math.min(1, v))
      notify()
    }

    function getElement() {
      return audio
    }

    function getDuration() {
      return totalDuration || (audio ? audio.duration : 0)
    }

    async function destroy() {
      destroyed = true
      try {
        if (audio) {
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
          audio.remove()
        }
      } catch {
        /* ignore */
      }
      try {
        if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream()
      } catch {
        /* ignore */
      }
      try {
        if (audio && audio.src) URL.revokeObjectURL(audio.src)
      } catch {
        /* ignore */
      }
      audio = null
      sb = null
      mediaSource = null
      chunks = null
      track = null
    }

    return { load, play, pause, seekTo, setVolume, getElement, getDuration, destroy, stats }
  }

  /** 从 playurl 里按档位挑一条音轨：high / mid / low / auto */
  function pickAudioTrack(audios, quality) {
    if (!audios || !audios.length) return null
    const sorted = [...audios].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
    if (quality === 'low') return sorted[sorted.length - 1]
    if (quality === 'mid') return sorted[Math.floor((sorted.length - 1) / 2)]
    if (quality === 'high') return sorted[0]
    // auto：取中间偏上，兼顾音质与流量
    return sorted[Math.min(1, sorted.length - 1)]
  }

  /** 取视频信息与音轨列表 */
  async function fetchVideoInfo(bvid, page) {
    const view = await getJson(`${VIEW}?bvid=${bvid}`, '视频信息接口')
    const pages = view.pages || []
    const target = pages.find((x) => x.page === page) || pages[0] || {}
    const cid = target.cid || view.cid
    const duration = target.duration || view.duration || 0
    const data = await getJson(
      `${PLAYURL}?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1&platform=pc`,
      '播放地址接口'
    )
    return {
      bvid,
      cid,
      page: target.page || page,
      title: view.title || '',
      duration,
      cover: view.pic || '',
      audios: (data.dash && data.dash.audio) || [],
      acceptQuality: data.accept_quality || [],
      // 画质下拉用：support_formats 里有中文名（超清 1080P / 高清 720P …）
      formats: data.support_formats || [],
    }
  }

  ns.dashAudio = { createDashAudio, pickAudioTrack, fetchVideoInfo }
})(typeof window !== 'undefined' ? window : globalThis)
