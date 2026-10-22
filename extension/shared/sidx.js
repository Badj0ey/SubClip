/**
 * DASH SIDX 索引解析（插件端）。
 *
 * 与桌面端 `src/main/slice/sidx.ts` 是同一套算法的两份实现：
 *   - 桌面端在 Node/Electron 里跑，用来算「切片要下载哪一段字节」
 *   - 插件端在浏览器里跑，用来算「只放音频时要按需拉哪些分片」
 * 两份实现必须给出一致结果，`tests/extension-sidx.test.ts` 会用同一份字节对比两者。
 *
 * 边界标记 `SIDX-BLOCK-START/END` 供测试直接抽取代码块运行（与 content.js 的 WBI 块同一做法）。
 */

/* ---- SIDX-BLOCK-START ---- */
function round3(n) {
  return Math.round(1000 * n) / 1000
}

/** 解析 SIDX box（offset 指向 box 的 size 字段） */
function parseSidx(view, offset) {
  let size = view.getUint32(offset)
  offset += 4
  if (size === 1) {
    const hi = view.getUint32(offset)
    const lo = view.getUint32(offset + 4)
    size = Number((BigInt(hi) << 32n) | BigInt(lo))
    offset += 8
  }

  offset += 4 // box type（'sidx'）

  const version = view.getUint8(offset)
  offset += 1
  offset += 3 // flags
  offset += 4 // reference_ID
  const timescale = view.getUint32(offset)
  offset += 4

  let earliestPresentationTime = 0
  let firstOffset = 0

  if (version === 0) {
    earliestPresentationTime = view.getUint32(offset)
    offset += 4
    firstOffset = view.getUint32(offset)
    offset += 4
  } else if (version === 1) {
    const a = view.getUint32(offset)
    const b = view.getUint32(offset + 4)
    earliestPresentationTime = Number((BigInt(a) << 32n) | BigInt(b))
    offset += 8
    const c = view.getUint32(offset)
    const d = view.getUint32(offset + 4)
    firstOffset = Number((BigInt(c) << 32n) | BigInt(d))
    offset += 8
  } else {
    throw new Error('不支持的 SIDX 版本：' + version)
  }

  offset += 2 // reserved
  const referenceCount = view.getUint16(offset)
  offset += 2

  const entries = []
  for (let i = 0; i < referenceCount; i++) {
    const m = view.getUint32(offset)
    offset += 4
    const referencedSize = m & 0x7fffffff
    const subsegmentDuration = view.getUint32(offset)
    offset += 4
    offset += 4 // SAP
    entries.push({ subsegmentDuration, referencedSize })
  }

  return { version, timescale: timescale || 1, earliestPresentationTime, firstOffset, entries }
}

/** 由 SIDX 与 index_range 终点推出每个分片在文件中的位置 */
function buildChunks(sidx, indexEnd) {
  const timescale = sidx.timescale || 1
  let acc = sidx.earliestPresentationTime || 0
  let time = round3(acc / timescale)
  let offset = indexEnd + (sidx.firstOffset || 0) + 1

  const chunks = sidx.entries.map((entry) => {
    const duration = round3(entry.subsegmentDuration / timescale)
    const item = { time, offset, duration, size: entry.referencedSize }
    acc += entry.subsegmentDuration
    time = round3(acc / timescale)
    offset += entry.referencedSize
    return item
  })

  // 末尾补一个「哨兵」分片（时长 0），方便用二分查找定位时间点
  if (chunks.length) chunks.push({ time, offset, duration: 0, size: 0 })
  return chunks
}

/**
 * 音轨真实时长：最后一个「有数据」分片的起点 + 时长（末尾哨兵不算）。
 * 它常比视频时长略短（实测某视频视频 213.000、音轨 212.394），
 * 差别虽小，但直接拿视频时长当 MediaSource.duration 会让 <audio> 卡在尾部永不 ended。
 */
function trackEnd(chunks) {
  if (!chunks || !chunks.length) return 0
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i]
    if (c && c.size > 0) return round3(c.time + c.duration)
  }
  return 0
}

/** 找到 t 秒所在的真实分片下标（哨兵不参与），找不到返回 -1 */
function findSegment(chunks, t) {
  if (!chunks || !chunks.length) return -1
  let lo = 0
  let hi = chunks.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (chunks[mid].time <= t) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  // best 可能落在哨兵上（t >= 末尾时间），退回到最后一个有数据的分片
  if (best >= 0 && chunks[best].size === 0) best -= 1
  return best
}
/* ---- SIDX-BLOCK-END ---- */

;(function (root) {
  const ns = (root.__SUBCLIP_EXT__ = root.__SUBCLIP_EXT__ || {})
  ns.sidx = { parseSidx, buildChunks, findSegment, trackEnd }
})(typeof window !== 'undefined' ? window : globalThis)
