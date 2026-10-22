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
  const { parseSidx, buildChunks, findSegment, trackEnd } = ns.sidx

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
   * @returns {{init: ArrayBuffer, chunks: Array, trackDuration: number, url: string}}
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

    // 音轨真实长度。它可能比视频时长略短（实测 213.000 vs 212.394），
    // 拿视频时长当 MediaSource.duration 会让播放器在最后几百毫秒空转、永不 ended。
    return { init, chunks, trackDuration: trackEnd(chunks), url: track.baseUrl }
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
    /** 视频时长（来自接口） */
    let totalDuration = 0
    /** 音轨真实时长（由 SIDX 算出）；播放与进度条都以它为准 */
    let trackDuration = 0
    let destroyed = false
    let pumping = false
    let appendBusy = null // 串行化 append 的 promise
    /** 尾部分片是否已经处理过（收尾只需要一次） */
    let tailSettled = false
    /** 数据已经追加到分片表末尾，不会再有新数据进来 */
    let tailDone = false
    /** 已经「播完」：尾部样品不完整，靠看门狗判定，不依赖 ended 事件 */
    let finished = false
    /** 上一次播放位置有推进的时刻与位置，用来判断尾部僵住 */
    let lastMoveAt = 0
    let lastMoveT = 0
    let tailTimer = 0
    let lastError = null

    const notify = () => {
      if (destroyed) return
      onChange(stats())
    }

    function stats() {
      const cur = audio ? audio.currentTime : 0
      let bufferedEnd = 0
      let bufferedStart = 0
      if (sb && sb.buffered.length) {
        try {
          bufferedStart = sb.buffered.start(0)
          // 进度要报「当前位置能连续播到哪」，不是整条轨最远的缓冲末端：
          // 往回跳之后远处那段旧缓冲还在，报最远端会让人误以为已经缓冲够了
          bufferedEnd = bufferEndAt(cur) || sb.buffered.end(sb.buffered.length - 1)
        } catch {
          /* SourceBuffer 正在更新时读取会抛，忽略即可 */
        }
      }
      return {
        ready: !!audio,
        // 判定播完之后位置直接报总长，UI 才不会停在 3:32 还差 0.06 秒
        currentTime: finished ? playbackDuration() : audio ? audio.currentTime : 0,
        duration: playbackDuration(),
        paused: audio ? audio.paused || finished : true,
        ended: finished || (audio ? audio.ended : false),
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

    /** 播放总长：优先用音轨真实时长 */
    function playbackDuration() {
      if (trackDuration > 0) return trackDuration
      if (audio && isFinite(audio.duration) && audio.duration > 0) return audio.duration
      return totalDuration || 0
    }

    /** 包含 t 的那段缓冲的末端；t 不在任何缓冲区间内返回 0 */
    function bufferEndAt(t) {
      if (!sb || !sb.buffered.length) return 0
      const b = sb.buffered
      try {
        for (let k = 0; k < b.length; k++) {
          if (t >= b.start(k) - 0.05 && t <= b.end(k)) return b.end(k)
        }
      } catch {
        /* SourceBuffer 更新中读取会抛 */
      }
      return 0
    }

    /** 丢掉太旧的缓冲（配额），以及回跳之后留在远处的旧缓冲 */
    function prune() {
      if (!sb || !sb.buffered.length || sb.updating) return
      // 定位还没完成时 currentTime 仍是旧值：这时候剪会剪掉刚补到新位置的数据
      if (audio && audio.seeking) return
      const cur = audio ? audio.currentTime : 0
      const cut = Math.max(0, cur - 10)
      const dropFrom = cur + KEEP_SEC
      try {
        for (let k = sb.buffered.length - 1; k >= 0; k--) {
          const s0 = sb.buffered.start(k)
          const e0 = sb.buffered.end(k)
          if (e0 < cut || s0 >= dropFrom) {
            sb.remove(s0, e0)
            return // 一次只删一段，等 updateend 后下一轮接着删
          }
        }
      } catch {
        /* 忽略：下一轮再试 */
      }
    }

    /**
     * 收尾：最后一个分片追加完以后，把总长对齐到「真实缓冲末端」。
     *
     * SIDX 记的时长比最后一个分片里实际能解出来的样本长几百毫秒（B 站常见），
     * 于是 mediaSource.duration 比数据末端大，<audio> 会永远卡在最后那一下
     * （readyState=2、paused=false），ended 永远不触发。把 duration 收到缓冲末端，
     * 播放位置一到达就自然 ended。
     */
    function settleTail() {
      if (tailSettled || !sb || !mediaSource) return
      if (mediaSource.readyState !== 'open') return
      let be = 0
      try {
        if (sb.buffered.length) be = sb.buffered.end(sb.buffered.length - 1)
      } catch {
        return
      }
      if (be <= 0) return
      tailSettled = true
      const want = playbackDuration()
      if (want > 0 && be >= want - 0.02) return // 数据是齐的，交给正常的 ended
      trackDuration = Math.round(be * 1000) / 1000
      try {
        mediaSource.duration = trackDuration
      } catch {
        /* 部分实现会拒绝改 duration，那就只能等用户手动拖走 */
      }
      notify()
    }

    /**
     * 尾部收尾。
     *
     * B 站音轨最后一个分片常常是「半截样品」：SIDX 记的时长到了 212.394，但能解出来的
     * 样本只到 212.28 左右。此时 buffered 末端 == duration，<audio> 却在最后 0.05 秒前
     * 僵住（readyState 掉回 1/2、paused=false），ended 永远不触发。
     * 所以数据拉齐以后自己盯着：位置不再前进、且离总长不到 1 秒，就认定播完。
     */
    function checkTail() {
      if (destroyed || finished || !audio || !tailDone) return
      if (audio.paused) return
      const dur = playbackDuration()
      if (!(dur > 0)) return
      if (dur - audio.currentTime > 1.2) return
      if (!lastMoveAt || Date.now() - lastMoveAt < 1600) return
      finishTail()
    }

    function finishTail() {
      if (finished || !audio) return
      finished = true
      const dur = playbackDuration()
      try {
        audio.pause()
      } catch {
        /* ignore */
      }
      // 不要往总长处 seek：那里没有数据，还会把 MediaSource 推到 ended 状态，
      // 之后「重播」就再也 append 不进去了。位置原样留着，UI 按 finished 显示总长
      notify()
    }

    /** 数据拉齐了：收尾一次，并让 MSE 正式结束，部分实现据此会触发 ended */
    function markTailDone() {
      if (tailDone) return
      tailDone = true
      settleTail()
      if (audio && !finished) lastMoveAt = lastMoveAt || Date.now()
      notify()
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
      // 重建播放器时旧元素的 timeupdate 还会再捅进来一次，这里必须挡住
      if (pumping || destroyed || !chunks || !audio) return
      pumping = true
      try {
        const lastReal = chunks.length - 2 // chunks 末尾是 size=0 的哨兵，不是真分片
        while (!destroyed) {
          const cur = audio ? audio.currentTime : 0
          // 只看「当前位置」这一段缓冲。以前取的是最后一段区间，回跳之后
          // 远处旧缓冲会让这里误判成「已经缓冲够了」，于是不再补流、播几秒就停
          const end = bufferEndAt(cur)
          if (end - cur >= AHEAD_SEC) break
          if (end > 0 && end >= playbackDuration() - 0.05) {
            // 已经到尾，没有可补的
            markTailDone()
            break
          }
          const at = end > cur ? end : cur
          let i = findSegment(chunks, at)
          if (i < 0) i = 0
          // 若缓冲末尾恰好压在分片边界上，从下一个开始
          if (chunks[i] && at > chunks[i].time + chunks[i].duration - 0.001) i += 1
          if (i > lastReal) {
            markTailDone()
            break
          }
          // 这片已经在缓冲里了：再 append 只是重复拉流。以前尾部就是这么死循环的
          if (chunks[i].time + chunks[i].duration <= end + 0.05) break
          await appendChunk(i)
          if (i === lastReal) markTailDone()
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
      finished = false
      lastMoveAt = Date.now()
      lastMoveT = 0
      const limit = Math.max(0, playbackDuration() - 0.05)
      const clamped = Math.max(0, Math.min(t, limit))
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
      finished = false
      tailDone = false
      tailSettled = false
      lastMoveT = 0
      lastMoveAt = Date.now()
      track = opts.track
      totalDuration = opts.duration || 0

      const loaded = await loadTrack(track)
      chunks = loaded.chunks
      trackDuration = loaded.trackDuration
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
        if (audio && audio.currentTime > lastMoveT + 0.01) {
          lastMoveT = audio.currentTime
          lastMoveAt = Date.now()
        }
        if (audio && !audio.paused) checkTail()
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
      audio.addEventListener('ended', () => {
        finished = true
        notify()
      })
      if (mediaSource) {
        mediaSource.addEventListener('sourceended', () => notify())
      }

      // 时长按「音轨真实长度」设：设成视频时长会多出尾部一小段空洞，
      // <audio> 会一直等那段不存在的数据（readyState=2），ended 永远不来
      const mseDuration = trackDuration || totalDuration
      if (mseDuration > 0) {
        try {
          mediaSource.duration = mseDuration
        } catch {
          /* 某些实现此时不允许设置，忽略 */
        }
      }

      await append(loaded.init)

      const startAt = Math.max(0, Math.min(opts.startAt || 0, Math.max(0, playbackDuration() - 0.05)))
      const i = Math.max(0, findSegment(chunks, startAt))
      await appendChunk(i)
      // 起来之后立刻再补两段，避免第一段播完就断
      for (const k of [i + 1, i + 2]) {
        if (chunks[k] && chunks[k].size) await appendChunk(k).catch(() => {})
      }
      audio.currentTime = startAt
      // 尾部样品不全时 ended 不会来，自己盯住最后 1 秒的僵持
      if (tailTimer) clearInterval(tailTimer)
      tailTimer = setInterval(checkTail, 500)
      notify()
      return stats()
    }

    async function play() {
      if (!audio) return
      // 播完再点播放：从头开始（音频播放器的通行行为）。
      // 这里整条重建而不是把 currentTime 拨回 0 —— 播完之后 MediaSource 可能已经
      // 进入 ended 状态，再 append 会抛 InvalidStateError，重建最稳。
      if (finished || audio.ended) {
        const tk = track
        const dur = totalDuration
        finished = false
        tailDone = false
        await destroy()
        await load({ track: tk, duration: dur, startAt: 0 })
        await play()
        return
      }
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
      return playbackDuration()
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
      trackDuration = 0
      tailSettled = false
      tailDone = false
      finished = false
      if (tailTimer) {
        clearInterval(tailTimer)
        tailTimer = 0
      }
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
