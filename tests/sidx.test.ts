/**
 * 本地切片的 SIDX 解析与字节区间计算测试（纯逻辑，不需要网络与 ffmpeg）。
 * 运行：npm run test:slice
 */
import assert from 'node:assert'
import {
  buildChunks,
  computeRange,
  parallelFactor,
  parseSidx,
  splitRange
} from '../src/main/slice/sidx'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** 手工拼一个 version 0 的 SIDX box（用于测试解析） */
function buildSidx(opts: {
  timescale: number
  earliest: number
  firstOffset: number
  entries: Array<{ duration: number; size: number }>
  version?: number
}): Buffer {
  const version = opts.version ?? 0
  const entryBytes = opts.entries.length * 12
  const headerLen = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 // size+type+ver/flags+refID+timescale+ept+firstoffset+reserved+count
  const total = headerLen + entryBytes

  const buf = Buffer.alloc(total)
  let o = 0
  buf.writeUInt32BE(total, o); o += 4
  buf.write('sidx', o); o += 4
  buf.writeUInt8(version, o); o += 1
  buf.writeUIntBE(0, o, 3); o += 3
  buf.writeUInt32BE(0, o); o += 4 // reference_ID
  buf.writeUInt32BE(opts.timescale, o); o += 4
  buf.writeUInt32BE(opts.earliest, o); o += 4
  buf.writeUInt32BE(opts.firstOffset, o); o += 4
  buf.writeUInt16BE(0, o); o += 2 // reserved
  buf.writeUInt16BE(opts.entries.length, o); o += 2

  for (const e of opts.entries) {
    buf.writeUInt32BE(e.size, o); o += 4
    buf.writeUInt32BE(e.duration, o); o += 4
    buf.writeUInt32BE(0, o); o += 4 // SAP
  }
  return buf
}

/* -------------------------------- SIDX 解析 -------------------------------- */
section('SIDX 解析')

const sample = buildSidx({
  timescale: 1000,
  earliest: 0,
  firstOffset: 0,
  entries: [
    { duration: 2000, size: 100_000 },
    { duration: 2000, size: 120_000 },
    { duration: 2000, size: 110_000 }
  ]
})

check('解析出正确的时间刻度与分片数', () => {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  const sidx = parseSidx(view, 0)
  assert.strictEqual(sidx.timescale, 1000)
  assert.strictEqual(sidx.entries.length, 3)
  assert.strictEqual(sidx.entries[0].subsegmentDuration, 2000)
  assert.strictEqual(sidx.entries[0].referencedSize, 100_000)
})

check('unused 字段不影响解析', () => {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  const sidx = parseSidx(view, 0)
  assert.strictEqual(sidx.version, 0)
  assert.strictEqual(sidx.firstOffset, 0)
})

/* ------------------------------- 分片位置推算 ------------------------------- */
section('分片位置推算')

check('buildChunks 的时间与偏移累加正确', () => {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  const sidx = parseSidx(view, 0)
  const chunks = buildChunks(sidx, 999) // index_end = 999

  // 首个分片从 indexEnd + firstOffset + 1 开始
  assert.strictEqual(chunks[0].offset, 1000)
  assert.strictEqual(chunks[0].time, 0)
  assert.strictEqual(chunks[0].duration, 2)
  assert.strictEqual(chunks[0].size, 100_000)

  assert.strictEqual(chunks[1].offset, 1000 + 100_000)
  assert.strictEqual(chunks[1].time, 2)

  assert.strictEqual(chunks[2].offset, 1000 + 100_000 + 120_000)
  assert.strictEqual(chunks[2].time, 4)
})

check('末尾追加哨兵分片，便于区间计算', () => {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  const chunks = buildChunks(parseSidx(view, 0), 999)
  assert.strictEqual(chunks.length, 4)
  assert.strictEqual(chunks[3].duration, 0)
  assert.strictEqual(chunks[3].time, 6)
})

/* ------------------------------- 区间计算 -------------------------------- */
section('字节区间计算')

function chunksOf(): ReturnType<typeof buildChunks> {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  return buildChunks(parseSidx(view, 0), 999)
}

check('音频：取覆盖 [start, end] 的分片', () => {
  const chunks = chunksOf()
  const r = computeRange(chunks, 2.5, 4.5, false)
  // 2.5 落在 time=2 的分片，往前取它本身
  assert.strictEqual(r.dataRange[0], chunks[1].offset)
  // 4.5 落在 time=4 的分片内，需下到该分片结束（即下一个分片的 offset - 1）
  assert.strictEqual(r.dataRange[1], chunks[3].offset - 1)
  assert.strictEqual(r.ffmpegSs, 0.5) // 2.5 - 2
})

check('视频：额外向前取 3 个分片作为关键帧缓冲', () => {
  const chunks = chunksOf()
  const audio = computeRange(chunks, 4.5, 5.5, false)
  const video = computeRange(chunks, 4.5, 5.5, true)
  assert.ok(video.dataRange[0] < audio.dataRange[0], '视频起点应更靠前')
  // 不足 3 个分片时从头开始
  assert.strictEqual(video.dataRange[0], chunks[0].offset)
})

check('视频：分片充足时只前移 3 个', () => {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength)
  const big = buildChunks(parseSidx(view, 0), 999)
  // 构造一个更长的分片表：复制若干份，观察前移恰好 3 个
  const long = [...big]
  for (let i = 0; i < 6; i++) {
    const last = long[long.length - 2]
    long.splice(long.length - 1, 0, {
      time: last.time + last.duration,
      offset: last.offset + last.size,
      duration: last.duration,
      size: last.size
    })
  }
  const r = computeRange(long, 10, 11, true)
  const index = long.findIndex((c) => c.offset === r.dataRange[0])
  const natural = long.findIndex((c) => c.time > 10)
  assert.strictEqual(natural - 1 - 3, index, '应恰好前移 3 个分片')
})

check('起点早于首个分片时不会越界', () => {
  const r = computeRange(chunksOf(), 0, 1, true)
  assert.strictEqual(r.dataRange[0], 1000)
  assert.ok(r.ffmpegSs >= 0)
})

check('终点超出范围时收敛到最后一个分片', () => {
  const r = computeRange(chunksOf(), 5, 999, false)
  const chunks = chunksOf()
  assert.strictEqual(r.dataRange[1], chunks[chunks.length - 1].offset - 1)
})

check('totalSize 与区间长度一致', () => {
  const r = computeRange(chunksOf(), 2, 6, false)
  assert.strictEqual(r.totalSize, r.dataRange[1] - r.dataRange[0] + 1)
})

check('空分片列表返回安全默认值', () => {
  const r = computeRange([], 1, 3, false)
  assert.strictEqual(r.totalSize, 0)
  assert.strictEqual(r.ffmpegT, 2)
})

/* ------------------------------- 区间拆分 -------------------------------- */
section('区间拆分与并发')

check('splitRange 拆分后能完整覆盖原区间', () => {
  const parts = splitRange([100, 499], 4)
  assert.strictEqual(parts[0][0], 100)
  assert.strictEqual(parts[parts.length - 1][1], 499)
  for (let i = 1; i < parts.length; i++) {
    assert.strictEqual(parts[i][0], parts[i - 1][1] + 1, '区间必须连续无缝隙')
  }
  const total = parts.reduce((s, [a, b]) => s + (b - a + 1), 0)
  assert.strictEqual(total, 400)
})

check('splitRange 处理异常区间', () => {
  assert.deepStrictEqual(splitRange([10, 5], 3), [])
})

check('parallelFactor 随体积递增', () => {
  assert.strictEqual(parallelFactor(5 * 1024 * 1024), 1)
  assert.strictEqual(parallelFactor(50 * 1024 * 1024), 3)
  assert.strictEqual(parallelFactor(200 * 1024 * 1024), 5)
  assert.strictEqual(parallelFactor(500 * 1024 * 1024), 8)
})

console.log(`\n通过 ${passed}，失败 ${failed}\n`)
if (failed > 0) process.exit(1)
