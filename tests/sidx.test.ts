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
import { getPlayInfo } from '../src/main/slice/playurl'

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

/* ---------------------------- 播放地址选流 ---------------------------- */
section('播放地址选流（画质降级判定）')

/** 造一条 DASH 视频流；index_range 缺失会被 toStream 丢掉，所以必须带上 */
function dashVideo(id: number, codecs = 'avc1.640028'): Record<string, unknown> {
  return {
    id,
    baseUrl: `https://cdn.example/v-${id}-${codecs}`,
    codecs,
    bandwidth: 1000,
    segment_base: { index_range: '0-999', init_range: '0-99' }
  }
}

function playurlPayload(opts: {
  streams: Array<Record<string, unknown>>
  acceptQuality: number[]
  /** 接口自称的画质，用来证明它不可信 */
  selfReportedQuality?: number
}): unknown {
  return {
    code: 0,
    message: '0',
    data: {
      quality: opts.selfReportedQuality ?? 0,
      accept_quality: opts.acceptQuality,
      timelength: 60_000,
      dash: {
        duration: 60,
        video: opts.streams,
        audio: [
          {
            id: 30280,
            baseUrl: 'https://cdn.example/a',
            codecs: 'mp4a.40.2',
            bandwidth: 128000,
            segment_base: { index_range: '0-99', init_range: '0-9' }
          }
        ]
      }
    }
  }
}

/** 替换全局 fetch，只服务这一次请求；返回还原函数 */
function stubFetchOnce(body: unknown): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body
  })) as unknown as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

async function runPlayInfoTests(): Promise<void> {
  // 实测（2026-11-09，BV1GJ411x7h7）：未登录要 1080P 时接口回 data.quality=64、
  // accept_quality 含 112，但 dash 里只有 480P/360P。选流必须看实际流。
  {
    const restore = stubFetchOnce(
      playurlPayload({
        streams: [dashVideo(32, 'hev1.1.6'), dashVideo(32, 'avc1.640028'), dashVideo(16, 'avc1.64000d')],
        acceptQuality: [112, 80, 64, 32, 16],
        selfReportedQuality: 64
      })
    )
    try {
      await checkAsync('未登录：按实际流选 480P，不会误报 1080P', async () => {
        const play = await getPlayInfo('BV1xx411c7mD', 1, '')
        assert.strictEqual(play.quality, 32, 'dash 里最高就是 480P，不能信 data.quality')
        assert.strictEqual(play.requested, 80)
        assert.strictEqual(play.qualityCap, 112, 'accept_quality 最大值 = 稿件支持的最高档')
        assert.strictEqual(play.video.length, 1)
        assert.match(play.video[0].codecs, /avc1/, '同清晰度优先 avc1（兼容性更好）')
      })
    } finally {
      restore()
    }
  }

  {
    const restore = stubFetchOnce(
      playurlPayload({
        streams: [
          dashVideo(112, 'avc1.640032'),
          dashVideo(80, 'hev1.1.6'),
          dashVideo(80, 'avc1.640028'),
          dashVideo(64)
        ],
        acceptQuality: [112, 80, 64, 32, 16]
      })
    )
    try {
      await checkAsync('要 1080P 且有权限：选 80，不越级到 112', async () => {
        const play = await getPlayInfo('BV1xx411c7mD', 1, 'SESSDATA=x', 80)
        assert.strictEqual(play.quality, 80)
        assert.strictEqual(play.qualityCap, 112)
        assert.match(play.video[0].codecs, /avc1/)
      })
    } finally {
      restore()
    }
  }

  // 稿件本身最高 720P：quality 与上限都是 64，降级提示才会说「该视频最高只有 720P」，
  // 而不是误导成「需要大会员」。
  {
    const restore = stubFetchOnce(
      playurlPayload({ streams: [dashVideo(64)], acceptQuality: [64, 32, 16] })
    )
    try {
      await checkAsync('稿件本身只有 720P：quality 与上限都应为 64', async () => {
        const play = await getPlayInfo('BV1xx411c7mD', 1, 'SESSDATA=x', 80)
        assert.strictEqual(play.quality, 64)
        assert.strictEqual(play.qualityCap, 64)
      })
    } finally {
      restore()
    }
  }
}

void runPlayInfoTests().then(() => {
  console.log(`\n通过 ${passed}，失败 ${failed}\n`)
  if (failed > 0) process.exit(1)
})
