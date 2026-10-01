/**
 * DASH SIDX 索引解析与字节区间计算。
 *
 * B 站的 DASH 流是分片的（fMP4）。每个流的 segment_base.index_range 指向一段
 * SIDX box，里面记录了「每个分片的时长」和「字节大小」。据此就能由「时间区间」
 * 反推出「需要下载的字节区间」，从而只下载目标片段而不是整段视频。
 *
 * 逻辑移植自 D:\subtitle2clip\bilibili-slice-downloader\js\bilibili.js（仿 A-SOUL 切片插件）。
 */

export interface SidxEntry {
  subsegmentDuration: number
  referencedSize: number
}

export interface Sidx {
  version: number
  timescale: number
  earliestPresentationTime: number
  firstOffset: number
  entries: SidxEntry[]
}

/** 分片：时间（秒）/ 字节偏移 / 时长（秒）/ 大小（字节） */
export interface Chunk {
  time: number
  offset: number
  duration: number
  size: number
}

export interface ByteRange {
  /** 需要的字节区间（闭区间） */
  dataRange: [number, number]
  /** ffmpeg 裁剪参数 */
  ffmpegSs: number
  ffmpegT: number
  totalSize: number
}

function round3(n: number): number {
  return Math.round(1000 * n) / 1000
}

/** 解析 SIDX box */
export function parseSidx(view: DataView, offset: number): Sidx {
  const t0 = offset
  let size = view.getUint32(offset)
  offset += 4
  if (size === 1) {
    const hi = view.getUint32(offset)
    const lo = view.getUint32(offset + 4)
    size = Number((BigInt(hi) << 32n) | BigInt(lo))
    offset += 8
  }

  const type = String.fromCharCode(
    (view.getUint32(offset) >> 24) & 0xff,
    (view.getUint32(offset) >> 16) & 0xff,
    (view.getUint32(offset) >> 8) & 0xff,
    view.getUint32(offset) & 0xff
  ).trim()
  offset += 4

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
    throw new Error(`不支持的 SIDX 版本：${version}`)
  }

  offset += 2 // reserved
  const referenceCount = view.getUint16(offset)
  offset += 2

  const entries: SidxEntry[] = []
  for (let i = 0; i < referenceCount; i++) {
    const m = view.getUint32(offset)
    offset += 4
    const referencedSize = m & 0x7fffffff
    const subsegmentDuration = view.getUint32(offset)
    offset += 4
    offset += 4 // SAP 信息
    entries.push({ subsegmentDuration, referencedSize })
  }

  void t0
  void type
  void size
  return { version, timescale: timescale || 1, earliestPresentationTime, firstOffset, entries }
}

/**
 * 由 SIDX 与 index_range 终点推出每个分片在文件中的位置。
 * 偏移从 `indexEnd + firstOffset + 1` 开始（index_end 之后紧接分片数据）。
 */
export function buildChunks(sidx: Sidx, indexEnd: number): Chunk[] {
  const timescale = sidx.timescale || 1
  let acc = sidx.earliestPresentationTime || 0
  let time = round3(acc / timescale)
  let offset = indexEnd + (sidx.firstOffset || 0) + 1

  const chunks: Chunk[] = sidx.entries.map((entry) => {
    const duration = round3(entry.subsegmentDuration / timescale)
    const item: Chunk = { time, offset, duration, size: entry.referencedSize }
    acc += entry.subsegmentDuration
    time = round3(acc / timescale)
    offset += entry.referencedSize
    return item
  })

  if (chunks.length) chunks.push({ time, offset, duration: 0, size: 0 })
  return chunks
}

/**
 * 计算 [startSec, endSec] 对应的字节区间与 ffmpeg 裁剪参数。
 * 视频要多往前取 3 个分片作为关键帧缓冲，否则 seek 后开头会花屏。
 */
export function computeRange(
  chunks: Chunk[],
  startSec: number,
  endSec: number,
  isVideo: boolean
): ByteRange {
  if (!chunks.length) {
    return {
      dataRange: [0, -1],
      ffmpegSs: 0,
      ffmpegT: Math.max(0, endSec - startSec),
      totalSize: 0
    }
  }

  let i = chunks.findIndex((c) => c.time > startSec)
  if (i > 0) i -= 1
  // 视频要往前多取 3 个分片；不足 3 个时直接从头开始（否则 seek 后开头会花屏）
  if (isVideo) i = i > 3 ? i - 3 : 0

  let c = chunks.findIndex((chunk) => chunk.time >= endSec)
  if (c < 0) c = chunks.length - 1
  if (c < i) c = i

  const startChunk = chunks[i]
  const endChunk = chunks[c]

  const ffmpegSs = Number((startSec - startChunk.time).toFixed(3))
  const ffmpegT = Number((Math.min(endSec, endChunk.time) - startSec).toFixed(3))
  const dataRange: [number, number] = [startChunk.offset, endChunk.offset - 1]

  return {
    dataRange,
    ffmpegSs,
    ffmpegT: Math.max(0, ffmpegT),
    totalSize: dataRange[1] - dataRange[0] + 1
  }
}

/** 把大区间拆成若干子区间，便于并发下载 */
export function splitRange(range: [number, number], parts: number): Array<[number, number]> {
  if (!range || range[1] < range[0]) return []
  const total = range[1] - range[0] + 1
  const step = Math.ceil(total / Math.max(1, parts))
  const out: Array<[number, number]> = []
  for (let s = range[0]; s <= range[1]; s += step) {
    out.push([s, Math.min(s + step - 1, range[1])])
  }
  return out
}

/** 按体积决定并发分片数 */
export function parallelFactor(totalSize: number): number {
  const mb = totalSize / 1024 / 1024
  if (mb <= 20) return 1
  if (mb <= 100) return 3
  if (mb <= 300) return 5
  return 8
}
