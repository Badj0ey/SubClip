/**
 * 核心逻辑测试（纯函数，不依赖 Electron）。
 * 运行：npm run test:core
 */
import assert from 'node:assert'
import type { AppSettings, Cue } from '../src/shared/types'
import { formatTime, parseTime } from '../src/shared/time'
import { buildRanges, normalizeRanges, totalDuration, type RangeCue } from '../src/shared/ranges'
import {
  biliSubtitleToCues,
  decodeBuffer,
  parseSrt,
  replaceInCues,
  shiftCues,
  toPlainText,
  toSrt,
  toVtt
} from '../src/main/srt'
import { toCsv } from '../src/main/exporter'
import { sanitizeFileName } from '../src/main/slice/filename'
import { buildDiagnostics, redactSettings } from '../src/main/diagnostics'
import { BRIDGE_LIMITS, parseClientMessage } from '../src/shared/bridge'
import * as constants from '../src/shared/constants'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  eventToBinding,
  findConflicts,
  formatBinding,
  normalizeShortcuts,
  resolveAction
} from '../src/shared/shortcuts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
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

const cue = (index: number, start: number, end: number, text = `第${index}句`): Cue => ({
  index,
  start,
  end,
  text
})

/* -------------------------------- 时间工具 -------------------------------- */
section('时间工具')

test('formatTime 秒 → HH:MM:SS', () => {
  assert.strictEqual(formatTime(0), '00:00:00')
  assert.strictEqual(formatTime(80), '00:01:20')
  assert.strictEqual(formatTime(3725), '01:02:05')
  assert.strictEqual(formatTime(359999), '99:59:59')
})

test('formatTime 带毫秒', () => {
  assert.strictEqual(formatTime(80.5, true), '00:01:20,500')
  assert.strictEqual(formatTime(1.007, true), '00:00:01,007')
})

test('formatTime 处理非法输入', () => {
  assert.strictEqual(formatTime(NaN), '00:00:00')
  assert.strictEqual(formatTime(-5), '00:00:00')
})

test('parseTime 各类写法', () => {
  assert.strictEqual(parseTime('00:01:20,000'), 80)
  assert.strictEqual(parseTime('00:01:20.000'), 80)
  assert.strictEqual(parseTime('1:20'), 80)
  assert.strictEqual(parseTime('01:20'), 80)
  assert.strictEqual(parseTime('83.5'), 83.5)
  assert.strictEqual(parseTime('1分30秒'), 90)
  assert.strictEqual(parseTime('1时2分3秒'), 3723)
})

test('parseTime 非法输入返回 NaN', () => {
  assert.ok(Number.isNaN(parseTime('abc')))
  assert.ok(Number.isNaN(parseTime('')))
})

/* --------------------------------- SRT ---------------------------------- */
section('SRT 解析')

test('标准 SRT 解析', () => {
  const src = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    '你好世界',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    '第二句',
    ''
  ].join('\n')
  const { cues, warnings } = parseSrt(src)
  assert.strictEqual(cues.length, 2)
  assert.strictEqual(warnings.length, 0)
  assert.strictEqual(cues[0].index, 1)
  assert.strictEqual(cues[0].start, 1)
  assert.strictEqual(cues[0].end, 3.5)
  assert.strictEqual(cues[0].text, '你好世界')
  assert.strictEqual(cues[1].start, 4)
})

test('CRLF 与 BOM', () => {
  const src = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n测试\r\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues.length, 1)
  assert.strictEqual(cues[0].text, '测试')
})

test('缺少序号仍能解析', () => {
  const src = '00:00:01,000 --> 00:00:02,000\n无序号字幕\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues.length, 1)
  assert.strictEqual(cues[0].index, 1)
  assert.strictEqual(cues[0].text, '无序号字幕')
})

test('时间轴带坐标后缀', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200\n带坐标\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues.length, 1)
  assert.strictEqual(cues[0].end, 2)
})

test('多行正文与样式标签清理', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n<i>斜体</i>\n第二行\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues[0].text, '斜体\n第二行')
})

test('序号自动重新编号', () => {
  const src = [
    '7',
    '00:00:01,000 --> 00:00:02,000',
    'A',
    '',
    '3',
    '00:00:03,000 --> 00:00:04,000',
    'B',
    ''
  ].join('\n')
  const { cues } = parseSrt(src)
  assert.deepStrictEqual(
    cues.map((c) => c.index),
    [1, 2]
  )
})

test('无法识别的时间轴产生告警', () => {
  const { cues, warnings } = parseSrt('1\nbad --> worse\n内容\n\n2\n00:00:01,000 --> 00:00:02,000\n好的\n')
  assert.strictEqual(cues.length, 1)
  assert.ok(warnings.length >= 1)
})

test('空内容不崩溃', () => {
  const { cues } = parseSrt('')
  assert.strictEqual(cues.length, 0)
})

test('toSrt 往返一致', () => {
  const cues = [cue(1, 1, 3.5, '你好'), cue(2, 4, 6, '世界\n换行')]
  const { cues: back } = parseSrt(toSrt(cues))
  assert.strictEqual(back.length, 2)
  assert.strictEqual(back[0].start, 1)
  assert.strictEqual(back[1].text, '世界\n换行')
})

test('decodeBuffer 识别 UTF-8 BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好', 'utf8')])
  const { text, encoding } = decodeBuffer(buf)
  assert.strictEqual(encoding, 'utf-8-bom')
  assert.strictEqual(text, '你好')
})

test('decodeBuffer 识别 GBK', () => {
  // 「你好」的 GBK 编码
  const buf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
  const { text, encoding } = decodeBuffer(buf)
  assert.strictEqual(text, '你好')
  assert.strictEqual(encoding, 'gbk')
})

test('B站字幕 json 转换', () => {
  const cues = biliSubtitleToCues({
    body: [
      { from: 1.2, to: 3.4, content: '句子一' },
      { from: 3.5, to: 4.0, content: '  ' },
      { from: 5.0, to: 6.0, content: '句子二' }
    ]
  })
  assert.strictEqual(cues.length, 2)
  assert.strictEqual(cues[0].start, 1.2)
  assert.strictEqual(cues[1].text, '句子二')
  assert.strictEqual(cues[1].index, 2)
})

/* ------------------------------ 时间坐标生成 ------------------------------ */
section('时间坐标生成')

test('连续字幕合并为一段', () => {
  const cues = [cue(1, 0, 2), cue(2, 2, 4), cue(3, 4, 6), cue(4, 8, 10)]
  const ranges = buildRanges(cues, new Set([1, 2, 3]), 0)
  assert.strictEqual(ranges.length, 1)
  assert.strictEqual(ranges[0].start, 0)
  assert.strictEqual(ranges[0].end, 6)
  assert.deepStrictEqual(ranges[0].cueIndexes, [1, 2, 3])
})

test('非连续字幕生成多段（需求文档示例）', () => {
  const cues = [cue(1, 80, 135), cue(2, 200, 260), cue(3, 630, 680)]
  const ranges = buildRanges(cues, new Set([1, 3]), 0)
  assert.strictEqual(ranges.length, 2)
  assert.strictEqual(ranges[0].start, 80)
  assert.strictEqual(ranges[0].end, 135)
  assert.strictEqual(ranges[1].start, 630)
  assert.strictEqual(ranges[1].end, 680)
})

test('maxGap 合并间隔很小的相邻段', () => {
  const cues = [cue(1, 0, 2), cue(3, 2.2, 4)]
  assert.strictEqual(buildRanges(cues, new Set([1, 3]), 0).length, 2)
  assert.strictEqual(buildRanges(cues, new Set([1, 3]), 0.5).length, 1)
})

test('乱序选择仍按序号排序', () => {
  const cues = [cue(1, 0, 2), cue(2, 2, 4), cue(3, 4, 6)]
  const ranges = buildRanges(cues, new Set([3, 1]), 0)
  assert.strictEqual(ranges.length, 2)
  assert.strictEqual(ranges[0].start, 0)
  assert.strictEqual(ranges[1].start, 4)
})

test('空选择返回空数组', () => {
  assert.strictEqual(buildRanges([cue(1, 0, 2)], new Set<number>(), 0).length, 0)
})

test('normalizeRanges 合并重叠区间', () => {
  const merged = normalizeRanges([
    { start: 10, end: 20, cueIndexes: [1] },
    { start: 15, end: 25, cueIndexes: [2] },
    { start: 40, end: 50, cueIndexes: [3] }
  ])
  assert.strictEqual(merged.length, 2)
  assert.strictEqual(merged[0].start, 10)
  assert.strictEqual(merged[0].end, 25)
})

/* ------------------------------ 跨分P 切片合并 ------------------------------ */
section('跨分P 切片')

/** 带分P 信息的字幕 */
const pcue = (index: number, start: number, end: number, page: number): RangeCue => ({
  index,
  start,
  end,
  text: `P${page}-${index}`,
  page
})

test('相邻两条分属不同分P 时标记为跨P', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1), pcue(3, 0, 2, 2), pcue(4, 2, 4, 2)]
  // 选中 P1 的末条 + P2 的首条
  const ranges = buildRanges(cues, new Set([2, 3]), 0)
  assert.strictEqual(ranges.length, 1)
  assert.strictEqual(ranges[0].crossPage, true)
  assert.strictEqual(ranges[0].segments?.length, 2)
  assert.deepStrictEqual(ranges[0].segments?.[0], { page: 1, start: 2, end: 4 })
  assert.deepStrictEqual(ranges[0].segments?.[1], { page: 2, start: 0, end: 2 })
})

test('跨P 的整体时间范围覆盖两段', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1), pcue(3, 0, 5, 2)]
  const ranges = buildRanges(cues, new Set([2, 3]), 0)
  assert.strictEqual(ranges[0].start, 2)
  assert.strictEqual(ranges[0].end, 5)
})

test('同一分P 内不标记跨P', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1)]
  const ranges = buildRanges(cues, new Set([1, 2]), 0)
  assert.strictEqual(ranges[0].crossPage, false)
  assert.strictEqual(ranges[0].segments?.length, 1)
})

test('跨P 但只选中单侧时不合并', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1), pcue(3, 0, 5, 2)]
  // 只选了 P1 的末条，没选 P2 首条
  const ranges = buildRanges(cues, new Set([2]), 0)
  assert.strictEqual(ranges.length, 1)
  assert.strictEqual(ranges[0].crossPage, false)
  assert.deepStrictEqual(ranges[0].segments, [{ page: 1, start: 2, end: 4 }])
})

test('跨三段分P 时记录三个分段', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 0, 2, 2), pcue(3, 0, 2, 3)]
  const ranges = buildRanges(cues, new Set([1, 2, 3]), 0)
  assert.strictEqual(ranges[0].crossPage, true)
  assert.strictEqual(ranges[0].segments?.length, 3)
  assert.deepStrictEqual(
    ranges[0].segments?.map((s) => s.page),
    [1, 2, 3]
  )
})

test('无 page 信息时视为同一分P', () => {
  const cues = [cue(1, 0, 2), cue(2, 2, 4)]
  const ranges = buildRanges(cues, new Set([1, 2]), 0)
  assert.strictEqual(ranges[0].crossPage, false)
})

test('totalDuration 统计总时长', () => {
  const total = totalDuration([
    { start: 0, end: 10, cueIndexes: [] },
    { start: 20, end: 25, cueIndexes: [] }
  ])
  assert.strictEqual(total, 15)
})

/* -------------------------------- 切片表导出 ------------------------------- */
section('切片表导出')

test('CSV 表头与切片工具一致', () => {
  const csv = toCsv([
    { bvid: 'BV1GJ411x7h7', page: 1, start: 5, end: 15, note: 'A-SOUL-开场片段' }
  ])
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n')
  assert.strictEqual(lines[0], 'BV号,分P,开始时间,结束时间,备注(文件名)')
  assert.strictEqual(lines[1], 'BV1GJ411x7h7,1,00:00:05,00:00:15,A-SOUL-开场片段')
})

test('CSV 带 BOM 且转义特殊字符', () => {
  const csv = toCsv([{ bvid: 'BV1', page: 2, start: 3723, end: 3800, note: '含,逗号"引号' }])
  assert.ok(csv.startsWith('﻿'))
  assert.ok(csv.includes('01:02:03,01:03:20'))
  assert.ok(csv.includes('"含,逗号""引号"'))
})

test('共享常量里不再内置开发机绝对路径', () => {
  // 早期版本把需求文档里的 D:\subtitle2clip\... 当成默认值写死，
  // 导致每个人新装后一进设置页就看到「目录不存在」。这里锁住这个回归。
  for (const [key, value] of Object.entries(constants)) {
    if (key.startsWith('DEFAULT_') && typeof value === 'string') {
      assert.ok(!/[A-Za-z]:[\\/]/.test(value), `${key} 不应包含盘符路径：${value}`)
    }
  }
  assert.strictEqual(constants.DEFAULT_PORT, 8765)
  assert.strictEqual(constants.APP_DATA_DIR, 'srt-tool-data')
})

/* ------------------------------ 切片输出文件名 ----------------------------- */
section('切片输出文件名净化')

test('普通名字原样保留', () => {
  assert.strictEqual(sanitizeFileName('A-SOUL-开场片段'), 'A-SOUL-开场片段')
})

test('非法字符替换成下划线（目录穿越被消解）', () => {
  assert.strictEqual(sanitizeFileName('a/b\\c:d*e?f'), 'a_b_c_d_e_f')
  assert.strictEqual(sanitizeFileName('..\\..\\Windows\\evil'), '.._.._Windows_evil')
  assert.ok(!sanitizeFileName('..\\..\\evil').includes('\\'))
})

test('去掉结尾的点和空格（Windows 会悄悄吞掉，导致上报的文件名与实际不符）', () => {
  assert.strictEqual(sanitizeFileName('clip.'), 'clip')
  assert.strictEqual(sanitizeFileName('clip...'), 'clip')
  assert.strictEqual(sanitizeFileName('clip   '), 'clip')
  assert.strictEqual(sanitizeFileName('clip. . '), 'clip')
})

test('Windows 保留设备名加前缀避开', () => {
  for (const n of ['CON', 'con', 'NUL', 'COM1', 'LPT9', 'aux', 'prn']) {
    assert.strictEqual(sanitizeFileName(n), `_${n}`)
  }
  // 只是以保留名开头、但不是保留名的，不该被改
  assert.strictEqual(sanitizeFileName('console'), 'console')
  assert.strictEqual(sanitizeFileName('COM10'), 'COM10')
})

test('空名与超长名有兜底', () => {
  assert.strictEqual(sanitizeFileName(''), 'clip')
  assert.strictEqual(sanitizeFileName('   '), 'clip')
  assert.strictEqual(sanitizeFileName('...'), 'clip')
  const long = sanitizeFileName('长'.repeat(200))
  assert.ok(long.length <= 96, `应被截断，实际 ${long.length}`)
  // 截断后不能留下点结尾
  assert.ok(!/[. ]$/.test(sanitizeFileName(`${'a'.repeat(95)}.`)))
})

/* ------------------------------ 字幕导出与批量编辑 ----------------------------- */
section('字幕导出与批量编辑')

const sample: Cue[] = [
  { index: 1, start: 1, end: 3.5, text: '第一句' },
  { index: 2, start: 3.6, end: 6, text: '第二句，含高光' }
]

test('导出 WebVTT：带 WEBVTT 头，毫秒用点分隔', () => {
  const vtt = toVtt(sample)
  assert.ok(vtt.startsWith('WEBVTT\n\n'), '应以 WEBVTT 头开始')
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'), '时间格式应为点分隔')
  assert.ok(!vtt.includes('--> 00:00:03,500'), '不应残留 SRT 的逗号写法')
  assert.ok(vtt.includes('第一句'))
})

test('导出纯文本：每行一句，不含时间轴', () => {
  const txt = toPlainText(sample)
  assert.strictEqual(txt, '第一句\n第二句，含高光\n')
  assert.ok(!txt.includes('-->'))
})

test('时间轴整体平移（含负值夹到 0）', () => {
  const forward = shiftCues(sample, 1500)
  assert.strictEqual(forward[0].start, 2.5)
  assert.strictEqual(forward[1].end, 7.5)

  const backward = shiftCues(sample, -2000)
  assert.strictEqual(backward[0].start, 0, '起点不应变成负数')
  assert.strictEqual(backward[0].end, 1.5)
  assert.strictEqual(backward[1].start, 1.6)
})

test('时间轴倍速缩放：围绕第一条起点，不影响入参', () => {
  const scaled = shiftCues(sample, 0, 2)
  assert.strictEqual(scaled[0].start, 1, '第一条起点是缩放原点，保持不变')
  assert.strictEqual(scaled[0].end, 6)
  assert.strictEqual(scaled[1].start, 6.2)
  // 原数组不应被改动
  assert.strictEqual(sample[0].start, 1)
  assert.strictEqual(sample[1].end, 6)
})

test('纯文本替换：特殊字符按字面量处理', () => {
  const res = replaceInCues(sample, '高光', '亮点', false)
  assert.strictEqual(res.changed, 1)
  assert.strictEqual(res.cues[1].text, '第二句，含亮点')
  assert.strictEqual(res.cues[0].text, '第一句', '没命中的不应改动')

  // 正则元字符不应被当成语法
  const literal = replaceInCues([{ index: 1, start: 0, end: 1, text: 'a.b' }], 'a.b', 'X', false)
  assert.strictEqual(literal.cues[0].text, 'X')
})

test('正则替换支持捕获组与忽略大小写', () => {
  const cues: Cue[] = [{ index: 1, start: 0, end: 1, text: '第12句 and 第34句' }]
  const grouped = replaceInCues(cues, '第(\\d+)句', '[$1]', true)
  assert.strictEqual(grouped.cues[0].text, '[12] and [34]')

  const ci = replaceInCues([{ index: 1, start: 0, end: 1, text: 'Hello WORLD' }], 'world', 'x', false, true)
  assert.strictEqual(ci.cues[0].text, 'Hello x')
})

test('正则非法时抛错（由调用方提示用户）', () => {
  assert.throws(() => replaceInCues(sample, '(', 'x', true), /Invalid|Unterminated|nothing to repeat/i)
})

test('空模式不产生任何改动', () => {
  const res = replaceInCues(sample, '', 'x', false)
  assert.strictEqual(res.changed, 0)
  assert.strictEqual(res.cues, sample)
})

/* ------------------------------ 插件消息校验 ------------------------------ */
section('插件消息校验（安全边界）')

const hello = { bvid: 'BV1GJ411x7h7' }
const sub = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'subtitle',
    payload: {
      bvid: hello.bvid,
      page: 1,
      lang: 'zh-CN',
      label: '简体中文',
      cues: [{ from: 1, to: 2, content: '正常字幕' }],
      ...extra
    }
  })

test('合法消息通过并规整字段', () => {
  const msg = parseClientMessage(sub())
  assert.ok(msg && msg.type === 'subtitle')
  if (msg?.type !== 'subtitle') throw new Error('unreachable')
  assert.strictEqual(msg.payload.bvid, hello.bvid)
  assert.strictEqual(msg.payload.cues.length, 1)
})

test('非法 JSON / 非对象 / 未知类型一律丢弃', () => {
  assert.strictEqual(parseClientMessage('这不是 JSON'), null)
  assert.strictEqual(parseClientMessage('[]'), null)
  assert.strictEqual(parseClientMessage('null'), null)
  assert.strictEqual(parseClientMessage('{"payload":{}}'), null)
  assert.strictEqual(parseClientMessage('{"type":"no-such-type"}'), null)
})

test('BV 号必须合法，否则整条丢弃（防止 bvid 为空的垃圾条目）', () => {
  assert.strictEqual(parseClientMessage(sub({ bvid: '' })), null)
  assert.strictEqual(parseClientMessage(sub({ bvid: '不是BV' })), null)
  assert.strictEqual(parseClientMessage(sub({ bvid: 'BV1GJ411x7h' })), null) // 少一位
})

test('字幕正文按上限截断，空白与非法时间被剔除', () => {
  const raw = JSON.stringify({
    type: 'subtitle',
    payload: {
      bvid: hello.bvid,
      page: 1,
      lang: 'zh-CN',
      label: 'x',
      cues: [
        { from: 1, to: 2, content: '好的' },
        { from: 1, to: 2, content: '   ' }, // 空白 → 丢
        { from: Number.NaN, to: 2, content: 'NaN 起点' }, // → 丢
        { from: -5, to: 2, content: '负起点' }, // → 丢
        null,
        '字符串项',
        { from: 3, to: 1, content: '终点早于起点' } // to 回退成 from
      ]
    }
  })
  const msg = parseClientMessage(raw)
  assert.ok(msg && msg.type === 'subtitle')
  if (msg?.type !== 'subtitle') throw new Error('unreachable')
  assert.strictEqual(msg.payload.cues.length, 2, '只应保留两条合法字幕')
  assert.strictEqual(msg.payload.cues[0].content, '好的')
  assert.strictEqual(msg.payload.cues[1].from, 3)
  assert.strictEqual(msg.payload.cues[1].to, 3, '终点早于起点时应回退为起点')
})

test('超长字幕正文被截断而不是原样入库', () => {
  const msg = parseClientMessage(
    sub({ cues: [{ from: 0, to: 1, content: 'x'.repeat(5000) }] })
  )
  assert.ok(msg && msg.type === 'subtitle')
  if (msg?.type !== 'subtitle') throw new Error('unreachable')
  assert.ok(msg.payload.cues[0].content.length <= BRIDGE_LIMITS.maxCueText)
})

test('page-info 兼容旧插件的 mid 字段并归一成 uid', () => {
  const raw = JSON.stringify({
    type: 'page-info',
    payload: {
      pageType: 'video',
      bvid: hello.bvid,
      title: '标题',
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
      page: 2,
      uploader: { mid: 12345, name: 'UP主', avatar: null }
    }
  })
  const msg = parseClientMessage(raw)
  assert.ok(msg && msg.type === 'page-info')
  if (msg?.type !== 'page-info') throw new Error('unreachable')
  assert.strictEqual(msg.payload.uploader.uid, 12345)
  assert.strictEqual(msg.payload.page, 2)
  assert.strictEqual(msg.payload.pageType, 'video')
})

test('page-info 的 pageType 只接受枚举值', () => {
  const raw = JSON.stringify({
    type: 'page-info',
    payload: { pageType: '不存在的类型', bvid: '', title: '', url: '', page: 0, uploader: {} }
  })
  const msg = parseClientMessage(raw)
  assert.ok(msg && msg.type === 'page-info')
  if (msg?.type !== 'page-info') throw new Error('unreachable')
  assert.strictEqual(msg.payload.pageType, 'unknown')
  assert.strictEqual(msg.payload.page, 1, 'page 至少为 1')
})

test('cookies 缺少内容或超长时丢弃', () => {
  const build = (cookie: string): string =>
    JSON.stringify({ type: 'cookies', payload: { cookie, loggedIn: true, count: 1 } })
  assert.strictEqual(parseClientMessage(build('')), null)
  assert.strictEqual(parseClientMessage(JSON.stringify({ type: 'cookies', payload: {} })), null)
  assert.strictEqual(
    parseClientMessage(build('SESSDATA=' + 'x'.repeat(BRIDGE_LIMITS.maxCookie + 10))),
    null
  )
  assert.ok(parseClientMessage(build('SESSDATA=abc')))
})

test('整条报文超过体积上限直接丢弃', () => {
  const huge = 'x'.repeat(BRIDGE_LIMITS.maxMessageBytes + 1)
  assert.strictEqual(parseClientMessage(huge), null)
})

/* -------------------------------- 诊断包脱敏 ------------------------------- */
section('诊断包脱敏')

/** 一份最小的设置对象（真实默认值来自 settings.ts，那里依赖 electron，测试里不能直接引） */
function baseSettings(): AppSettings {
  return {
    theme: 'system',
    fontSize: 15,
    fontFamily: '',
    lineHeight: 1.7,
    treePaneWidth: 290,
    taskPaneWidth: 380,
    shortcuts: DEFAULT_SHORTCUTS,
    readLine: true,
    sliceQuality: 80,
    sliceConcurrency: 3,
    ffmpegPath: '',
    sliceOutputDir: '',
    subtitleCacheDir: '',
    sliceToolDir: '',
    outputDir: '',
    port: 8765,
    bridgeToken: '',
    biliCookie: ''
  }
}

test('诊断信息里绝不出现 Cookie 与配对令牌的内容', () => {
  const settings: AppSettings = {
    ...baseSettings(),
    biliCookie: 'SESSDATA=this-must-never-leak; bili_jct=also-secret',
    bridgeToken: 'super-secret-token'
  }
  const report = JSON.stringify(
    buildDiagnostics({
      appVersion: '0.1.0',
      packaged: true,
      versions: { electron: '36.0.0', chrome: '136', node: '22' },
      platform: { platform: 'win32', arch: 'x64', release: '10.0' },
      stats: { videos: 1 },
      paths: {},
      settings,
      bridge: {},
      recentPluginEvents: []
    })
  )

  assert.ok(!report.includes('this-must-never-leak'), 'Cookie 内容不能出现在诊断包里')
  assert.ok(!report.includes('bili_jct'), 'Cookie 的任何片段都不能出现')
  assert.ok(!report.includes('super-secret-token'), '配对令牌不能出现在诊断包里')
  assert.ok(report.includes('内容已隐去'), '应报告「已配置但隐去」')
})

test('未配置凭证时诊断包如实标注', () => {
  const report = redactSettings(baseSettings())
  assert.strictEqual(report.biliCookie, '（未配置）')
  assert.strictEqual(report.bridgeToken, '（未配置）')
})

/* --------------------------------- 快捷键 -------------------------------- */
section('快捷键')

interface KeyLike {
  key: string
  code?: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

function ev(o: KeyLike): Required<KeyLike> {
  return {
    key: o.key,
    code: o.code ?? '',
    ctrlKey: Boolean(o.ctrlKey),
    altKey: Boolean(o.altKey),
    shiftKey: Boolean(o.shiftKey),
    metaKey: Boolean(o.metaKey)
  }
}

test('eventToBinding 规范化各种按键', () => {
  assert.strictEqual(eventToBinding(ev({ key: 'f', ctrlKey: true })), 'Ctrl+F')
  assert.strictEqual(eventToBinding(ev({ key: 'ArrowDown' })), 'ArrowDown')
  assert.strictEqual(eventToBinding(ev({ key: 'ArrowDown', shiftKey: true })), 'Shift+ArrowDown')
  assert.strictEqual(eventToBinding(ev({ key: ' ', code: 'Space' })), 'Space')
  assert.strictEqual(eventToBinding(ev({ key: 'F2' })), 'F2')
  assert.strictEqual(eventToBinding(ev({ key: 'Escape' })), 'Escape')
})

test('只按修饰键不产生绑定', () => {
  assert.strictEqual(eventToBinding(ev({ key: 'Control', ctrlKey: true })), '')
  assert.strictEqual(eventToBinding(ev({ key: 'Shift', shiftKey: true })), '')
})

test('修饰键顺序固定为 Ctrl+Alt+Shift', () => {
  const binding = eventToBinding(ev({ key: 'j', ctrlKey: true, altKey: true, shiftKey: true }))
  assert.strictEqual(binding, 'Ctrl+Alt+Shift+J')
})

test('metaKey 归一到 Ctrl（兼容 Mac）', () => {
  assert.strictEqual(eventToBinding(ev({ key: 'f', metaKey: true })), 'Ctrl+F')
})

test('resolveAction 命中默认绑定', () => {
  assert.strictEqual(resolveAction(ev({ key: 'f', ctrlKey: true }), DEFAULT_SHORTCUTS), 'focusSearch')
  assert.strictEqual(resolveAction(ev({ key: 'ArrowDown' }), DEFAULT_SHORTCUTS), 'nextCue')
  assert.strictEqual(resolveAction(ev({ key: 'F2' }), DEFAULT_SHORTCUTS), 'editCue')
  assert.strictEqual(resolveAction(ev({ key: 'Enter' }), DEFAULT_SHORTCUTS), 'toggleSelect')
})

test('resolveAction 未绑定的按键返回 null', () => {
  assert.strictEqual(resolveAction(ev({ key: 'q' }), DEFAULT_SHORTCUTS), null)
  assert.strictEqual(resolveAction(ev({ key: 'ArrowDown', ctrlKey: true }), DEFAULT_SHORTCUTS), null)
})

test('自定义绑定覆盖默认值', () => {
  const custom = { ...DEFAULT_SHORTCUTS, nextCue: 'Ctrl+J' }
  assert.strictEqual(resolveAction(ev({ key: 'j', ctrlKey: true }), custom), 'nextCue')
  // 旧绑定不再响应
  assert.strictEqual(resolveAction(ev({ key: 'ArrowDown' }), custom), null)
})

test('findConflicts 检测重复绑定', () => {
  const map = { ...DEFAULT_SHORTCUTS, prevCue: DEFAULT_SHORTCUTS.nextCue }
  const conflicts = findConflicts(map)
  assert.strictEqual(conflicts.length, 1)
  assert.ok(conflicts[0].includes('nextCue'))
  assert.ok(conflicts[0].includes('prevCue'))
})

test('默认配置无冲突', () => {
  assert.strictEqual(findConflicts(DEFAULT_SHORTCUTS).length, 0)
})

test('normalizeShortcuts 补齐缺失与非法项', () => {
  const partial = normalizeShortcuts({ nextCue: 'Ctrl+J', prevCue: '' as string })
  assert.strictEqual(partial.nextCue, 'Ctrl+J')
  assert.strictEqual(partial.prevCue, DEFAULT_SHORTCUTS.prevCue)
  assert.strictEqual(partial.focusSearch, DEFAULT_SHORTCUTS.focusSearch)
  assert.strictEqual(Object.keys(partial).length, SHORTCUT_DEFS.length)
})

test('normalizeShortcuts 处理 undefined', () => {
  assert.deepStrictEqual(normalizeShortcuts(undefined), DEFAULT_SHORTCUTS)
})

test('formatBinding 转成友好名称', () => {
  assert.strictEqual(formatBinding('Shift+ArrowDown'), 'Shift + ↓')
  assert.strictEqual(formatBinding('Space'), '空格')
  assert.strictEqual(formatBinding('Ctrl+F'), 'Ctrl + F')
  assert.strictEqual(formatBinding(''), '未设置')
})

/* --------------------------------- 汇总 --------------------------------- */
console.log(`\n通过 ${passed}，失败 ${failed}\n`)
if (failed > 0) process.exit(1)
