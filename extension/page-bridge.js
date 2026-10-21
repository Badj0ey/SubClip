/**
 * 页面主世界（MAIN world）桥：只做一件事 —— 把直播间原生播放器停下来 / 恢复。
 *
 * 为什么要主世界：B 站直播播放器实例挂在页面自己的 `window.player` 上，
 * 内容脚本运行在隔离世界，看不到页面的 `window` 属性，也调不到它的方法。
 * 只有 `world: "MAIN"` 的脚本能碰。
 *
 * 为什么要停原生播放器：纯音频方案是我们自己拉的 FLV，原生播放器如果继续跑，
 * 视频流照旧在下载，流量一点没省 —— 这是整个「只放音频」能不能成立的关键。
 *
 * 跨世界通信只传**字符串**：CustomEvent 的 detail 对象跨越 V8 上下文时不可靠
 * （只能拿到包装对象、方法不可调用），所以这里全部 JSON.stringify。
 */

;(function () {
  const REQ = 'subclip:bridge'
  const RES = 'subclip:bridge-reply'

  /** 页面里可能挂在多个全局上，按常见名字依次找 */
  const PLAYER_NAMES = ['player', 'livePlayer', 'bilibiliPlayer', '__biliPlayer']

  function candidates() {
    const list = []
    for (const name of PLAYER_NAMES) {
      try {
        const v = window[name]
        if (v && typeof v === 'object') list.push({ where: 'window.' + name, obj: v })
      } catch {
        /* 跨域属性访问可能抛，忽略 */
      }
    }
    // 同源 iframe 里也可能有（部分直播间把播放器放 iframe）
    try {
      for (let i = 0; i < window.frames.length; i++) {
        const f = window.frames[i]
        if (!f || f === window) continue
        for (const name of PLAYER_NAMES) {
          try {
            const v = f[name]
            if (v && typeof v === 'object') list.push({ where: `frames[${i}].${name}`, obj: v })
          } catch {
            /* 跨域，跳过 */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return list
  }

  function findPlayer() {
    const list = candidates()
    // 优先能 stopPlayback 的
    for (const c of list) if (typeof c.obj.stopPlayback === 'function') return c
    for (const c of list) if (typeof c.obj.pause === 'function' || typeof c.obj.play === 'function') return c
    return null
  }

  function pauseMediaElements() {
    let n = 0
    for (const v of document.querySelectorAll('video')) {
      try {
        v.pause()
        n += 1
      } catch {
        /* ignore */
      }
    }
    return n
  }

  function stop() {
    const hit = findPlayer()
    if (hit) {
      try {
        if (typeof hit.obj.stopPlayback === 'function') {
          hit.obj.stopPlayback()
          return { ok: true, method: hit.where + '.stopPlayback()' }
        }
        if (typeof hit.obj.pause === 'function') {
          hit.obj.pause()
          const n = pauseMediaElements()
          return { ok: true, method: hit.where + '.pause()', media: n }
        }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }
    const n = pauseMediaElements()
    if (n) return { ok: true, method: 'video.pause()', media: n }
    return { ok: false, error: '页面里没找到播放器实例' }
  }

  function resume() {
    const hit = findPlayer()
    if (hit) {
      try {
        if (typeof hit.obj.reload === 'function') {
          hit.obj.reload()
          return { ok: true, method: hit.where + '.reload()' }
        }
        if (typeof hit.obj.play === 'function') {
          hit.obj.play()
          return { ok: true, method: hit.where + '.play()' }
        }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }
    let n = 0
    for (const v of document.querySelectorAll('video')) {
      try {
        v.play()
        n += 1
      } catch {
        /* 可能是自动播放限制，交给页面原有交互 */
      }
    }
    if (n) return { ok: true, method: 'video.play()', media: n }
    return { ok: false, error: '页面里没找到可恢复的播放器' }
  }

  /* --------------------------- 画质 --------------------------- */
  /**
   * B 站播放器的画质接口没有公开文档，属于「有就用、没有就别显示」的能力：
   * 视频页实测 `window.player` 上有 `getSupportedQualityList()` / `getQuality()` / `requestQuality(qn)`；
   * 直播页（SistersPlayer）完全拿不到，所以那边只做「取流时按 qn 请求」。
   */
  function qualityApi() {
    for (const c of [window.player, window.bp]) {
      if (!c) continue
      if (typeof c.requestQuality === 'function' || typeof c.setQuality === 'function') return c
      if (typeof c.getSupportedQualityList === 'function') return c
    }
    return null
  }

  function readQuality() {
    const p = qualityApi()
    if (!p) return { ok: false, error: '当前页面没有暴露画质接口' }
    let list = []
    try {
      list = (typeof p.getSupportedQualityList === 'function' && p.getSupportedQualityList()) || []
    } catch {
      list = []
    }
    let current = 0
    try {
      const q = typeof p.getQuality === 'function' ? p.getQuality() : null
      current = (q && (q.realQ || q.nowQ || q.newQ)) || 0
    } catch {
      current = 0
    }
    return { ok: true, list: list.filter((x) => typeof x === 'number'), current }
  }

  function writeQuality(qn) {
    const p = qualityApi()
    if (!p) return { ok: false, error: '当前页面没有暴露画质接口' }
    if (typeof p.requestQuality === 'function') {
      p.requestQuality(qn)
      return { ok: true, method: 'player.requestQuality()', qn }
    }
    if (typeof p.setQuality === 'function') {
      p.setQuality(qn)
      return { ok: true, method: 'player.setQuality()', qn }
    }
    return { ok: false, error: '这个页面不支持切画质' }
  }

  document.addEventListener(REQ, (ev) => {
    let payload = {}
    try {
      payload = JSON.parse(ev.detail || '{}')
    } catch {
      payload = {}
    }
    const id = payload.id
    let result
    try {
      if (payload.action === 'stop') result = stop()
      else if (payload.action === 'resume') result = resume()
      else if (payload.action === 'quality') result = readQuality()
      else if (payload.action === 'set-quality') result = writeQuality(Number(payload.qn))
      else if (payload.action === 'status') {
        const hit = findPlayer()
        result = {
          ok: true,
          found: !!hit,
          where: hit ? hit.where : '',
          videos: document.querySelectorAll('video').length,
        }
      } else result = { ok: false, error: '未知动作：' + String(payload.action) }
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) }
    }
    result.id = id
    try {
      document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(result) }))
    } catch (err) {
      /* 页面禁用 CustomEvent 也无能为力 */
    }
  })
})()
