/**
 * 插件端 SIDX 解析与桌面端实现的一致性测试。
 *
 * 为什么要有这个测试：播放器「只放音频」时靠自己解析 SIDX 算分片字节区间，
 * 而切片功能用的是桌面端的 `src/main/slice/sidx.ts`。两边是同一算法的两份实现，
 * 一旦漂移就会变成「切片切得对、但音频播不出来」这种极难排查的问题。
 *
 * 做法：从 extension/shared/sidx.js 里抽出代码块（而不是复制一份），
 * 用同一份合成的 SIDX 字节喂给两边，逐字段比对。
 * 运行：npm run test:extension
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildChunks, parseSidx } from '../src/main/slice/sidx'

interface Chunk {
  time: number
  offset: number
  duration: number
  size: number
}
interface SidxLike {
  version: number
  timescale: number
  earliestPresentationTime: number
  firstOffset: number
  entries: Array<{ subsegmentDuration: number; referencedSize: number }>
}
interface ExtBundle {
  parseSidx: (view: DataView, offset: number) => SidxLike
  buildChunks: (sidx: SidxLike, indexEnd: number) => Chunk[]
  findSegment: (chunks: Chunk[], t: number) => number
}

function loadExt(): ExtBundle {
  const src = readFileSync(join(__dirname, '../extension/shared/sidx.js'), 'utf8')
  const startMark = '/* ---- SIDX-BLOCK-START ---- */'
  const endMark = '/* ---- SIDX-BLOCK-END ---- */'
  const start = src.indexOf(startMark)
  const end = src.indexOf(endMark)
  assert.ok(start !== -1, 'sidx.js 里找不到 SIDX-BLOCK-START 标记')
  assert.ok(end !== -1, 'sidx.js 里找不到 SIDX-BLOCK-END 标记')
  const block = src.slice(start + startMark.length, end)
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${block}\nreturn { parseSidx, buildChunks, findSegment }`)
  return factory() as ExtBundle
}

const ext = loadExt()

/** 合成一个 SIDX box，返回 ArrayBuffer */
function makeSidxBox(opts: {
  version: 0 | 1
  timescale: number
  earliest: number
  firstOffset: number
  entries: Array<{ size: number; duration: number }>
}): ArrayBuffer {
  const headerLen = opts.version === 0 ? 32 : 40
  const total = headerLen + opts.entries.length * 12
  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  let p = 0
  view.setUint32(p, total)
  p += 4
  // 'sidx'
  view.setUint8(p, 0x73)
  view.setUint8(p + 1, 0x69)
  view.setUint8(p + 2, 0x64)
  view.setUint8(p + 3, 0x78)
  p += 4
  view.setUint8(p, opts.version)
  p += 4 // version + flags
  p += 4 // reference_ID
  view.setUint32(p, opts.timescale)
  p += 4
  if (opts.version === 0) {
    view.setUint32(p, opts.earliest)
    p += 4
    view.setUint32(p, opts.firstOffset)
    p += 4
  } else {
    view.setUint32(p, 0)
    view.setUint32(p + 4, opts.earliest)
    p += 8
    view.setUint32(p, 0)
    view.setUint32(p + 4, opts.firstOffset)
    p += 8
  }
  p += 2 // reserved
  view.setUint16(p, opts.entries.length)
  p += 2
  for (const e of opts.entries) {
    view.setUint32(p, e.size & 0x7fffffff)
    p += 4
    view.setUint32(p, e.duration)
    p += 4
    view.setUint32(p, 0x90000000)
    p += 4
  }
  return buf
}

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

console.log('\n【插件 SIDX 解析与桌面端一致性】')

/* ------------------------------ v0 基本解析 ------------------------------ */
const ENTRIES_V0 = [
  { size: 132756, duration: 239608 },
  { size: 131072, duration: 240000 },
  { size: 133333, duration: 233333 },
  { size: 69048, duration: 111600 },
]
const boxV0 = makeSidxBox({
  version: 0,
  timescale: 48000,
  earliest: 0,
  firstOffset: 0,
  entries: ENTRIES_V0,
})
const indexEndV0 = boxV0.byteLength - 1

check('v0：解析出的 timescale 与分片数一致', () => {
  const a = parseSidx(new DataView(boxV0), 0)
  const b = ext.parseSidx(new DataView(boxV0), 0)
  assert.strictEqual(a.timescale, 48000)
  assert.strictEqual(a.entries.length, ENTRIES_V0.length)
  assert.strictEqual(b.entries.length, ENTRIES_V0.length)
})

check('v0：两个实现的解析结果逐字段相等', () => {
  const a = parseSidx(new DataView(boxV0), 0)
  const b = ext.parseSidx(new DataView(boxV0), 0)
  assert.deepStrictEqual(b, {
    version: a.version,
    timescale: a.timescale,
    earliestPresentationTime: a.earliestPresentationTime,
    firstOffset: a.firstOffset,
    entries: a.entries,
  })
})

check('v0：两个实现算出的分片表完全相等（含末尾哨兵）', () => {
  const a = buildChunks(parseSidx(new DataView(boxV0), 0), indexEndV0)
  const b = ext.buildChunks(ext.parseSidx(new DataView(boxV0), 0), indexEndV0)
  assert.deepStrictEqual(b, a)
  assert.strictEqual(a.length, ENTRIES_V0.length + 1, '末尾应有一个 size=0 的哨兵分片')
})

check('v0：分片偏移首尾相接，累计量等于总字节数', () => {
  const chunks = ext.buildChunks(ext.parseSidx(new DataView(boxV0), 0), indexEndV0)
  const real = chunks.filter((c) => c.size > 0)
  assert.strictEqual(real[0].offset, indexEndV0 + 1, '第一个分片应从 indexEnd+1 开始')
  for (let i = 1; i < real.length; i++) {
    assert.strictEqual(real[i].offset, real[i - 1].offset + real[i - 1].size)
  }
  const total = real.reduce((s, c) => s + c.size, 0)
  assert.strictEqual(total, ENTRIES_V0.reduce((s, e) => s + e.size, 0))
})

/* ------------------------------ v1 64 位字段 ------------------------------ */
const boxV1 = makeSidxBox({
  version: 1,
  timescale: 44100,
  earliest: 1024,
  firstOffset: 16,
  entries: [
    { size: 220000, duration: 220500 },
    { size: 219000, duration: 220500 },
  ],
})
const indexEndV1 = boxV1.byteLength - 1

check('v1：两个实现解析一致', () => {
  const a = parseSidx(new DataView(boxV1), 0)
  const b = ext.parseSidx(new DataView(boxV1), 0)
  assert.deepStrictEqual(
    { ...b, entries: b.entries },
    {
      version: a.version,
      timescale: a.timescale,
      earliestPresentationTime: a.earliestPresentationTime,
      firstOffset: a.firstOffset,
      entries: a.entries,
    }
  )
  assert.strictEqual(a.timescale, 44100)
})

check('v1：first_offset 计入起始偏移', () => {
  const chunks = ext.buildChunks(ext.parseSidx(new DataView(boxV1), 0), indexEndV1)
  assert.strictEqual(chunks[0].offset, indexEndV1 + 1 + 16)
})

check('v1：两个实现算出的分片表相等', () => {
  const a = buildChunks(parseSidx(new DataView(boxV1), 0), indexEndV1)
  const b = ext.buildChunks(ext.parseSidx(new DataView(boxV1), 0), indexEndV1)
  assert.deepStrictEqual(b, a)
})

/* ------------------------------- findSegment ------------------------------- */
check('findSegment：能定位到覆盖目标时间的分片', () => {
  const chunks = ext.buildChunks(ext.parseSidx(new DataView(boxV0), 0), indexEndV0)
  // 第一个分片约 4.99s
  assert.strictEqual(ext.findSegment(chunks, 0), 0)
  assert.strictEqual(ext.findSegment(chunks, 4.9), 0)
  assert.strictEqual(ext.findSegment(chunks, 5.1), 1)
  const lastReal = chunks.length - 2
  assert.strictEqual(ext.findSegment(chunks, chunks[lastReal].time + 1), lastReal)
})

check('findSegment：超出末尾退到最后一个有数据的分片，空表返回 -1', () => {
  const chunks = ext.buildChunks(ext.parseSidx(new DataView(boxV0), 0), indexEndV0)
  const lastReal = chunks.length - 2
  assert.strictEqual(ext.findSegment(chunks, 1e6), lastReal)
  assert.strictEqual(ext.findSegment([], 3), -1)
  assert.strictEqual(ext.findSegment(null as unknown as Chunk[], 3), -1)
})

check('findSegment：时间点落在每个分片起点上时不会错位', () => {
  const chunks = ext.buildChunks(ext.parseSidx(new DataView(boxV0), 0), indexEndV0)
  for (let i = 0; i < chunks.length - 1; i++) {
    assert.strictEqual(ext.findSegment(chunks, chunks[i].time), i, `第 ${i} 个分片起点定位错误`)
  }
})

/* ------------------------- 真实字节：与现场一致的结构 ------------------------- */
check('真实 SIDX 结构（43 分片 / timescale 48000）也能解析', () => {
  // 按实测到的 B 站音频索引结构造：43 个分片，末尾分片时长不整除
  const entries = Array.from({ length: 43 }, (_, i) => ({
    size: 132000 + i * 37,
    duration: i === 42 ? 111600 : 239608,
  }))
  const box = makeSidxBox({ version: 0, timescale: 48000, earliest: 0, firstOffset: 0, entries })
  const indexEnd = box.byteLength - 1
  const a = buildChunks(parseSidx(new DataView(box), 0), indexEnd)
  const b = ext.buildChunks(ext.parseSidx(new DataView(box), 0), indexEnd)
  assert.deepStrictEqual(b, a)
  assert.strictEqual(b.length, 44)
})

/* --------------------------- 直播间号归一化 --------------------------- */

/**
 * `toRoomId` 是从「插件把整条 URL 当房间号传给接口」这个真实 bug 里长出来的
 * （接口只收数字，传 URL 会得到 `-400 请求错误`，界面上完全看不出原因）。
 * 这里把 extension/shared/live-audio.js 里的实现抽出来测，避免再退化。
 */
function loadToRoomId(): (input: unknown) => number {
  const src = readFileSync(join(__dirname, '../extension/shared/live-audio.js'), 'utf8')
  const startMark = '/* ---- ROOMID-BLOCK-START ---- */'
  const endMark = '/* ---- ROOMID-BLOCK-END ---- */'
  const start = src.indexOf(startMark)
  const end = src.indexOf(endMark)
  assert.ok(start >= 0 && end > start, 'live-audio.js 里找不到 ROOMID-BLOCK 标记')
  const body = src.slice(start + startMark.length, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return toRoomId`)() as (input: unknown) => number
}

check('toRoomId：直播间地址 / 路径 / 数字 / 空值都能归一化', () => {
  const toRoomId = loadToRoomId()
  assert.equal(toRoomId(22491717), 22491717, '数字原样返回')
  assert.equal(toRoomId('22491717'), 22491717, '纯数字字符串')
  assert.equal(toRoomId(' 22491717 '), 22491717, '首尾空格不影响')
  assert.equal(toRoomId('https://live.bilibili.com/22491717'), 22491717, '完整地址取路径数字')
  assert.equal(toRoomId('https://live.bilibili.com/22491717?x=1'), 22491717, '带查询串也能取')
  assert.equal(toRoomId('https://live.bilibili.com/blanc/22491717'), 22491717, 'blanc 分支同样适用')
  assert.equal(toRoomId('/22491717/'), 22491717, '纯路径也认（agent.js 传的是 location.pathname）')
  assert.equal(toRoomId('https://live.bilibili.com/'), 0, '没有数字就是 0（调用方据此报错）')
  assert.equal(toRoomId(''), 0, '空串')
  assert.equal(toRoomId(null), 0, 'null')
  assert.equal(toRoomId(undefined), 0, 'undefined')
  assert.equal(toRoomId(Number.NaN), 0, 'NaN 不能当房间号')
})

console.log(`\n通过 ${passed}，失败 ${failed}\n`)
if (failed > 0) process.exit(1)

