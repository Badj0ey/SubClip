/**
 * 字幕烧录的 ASS 生成、滤镜路径转义与字体族名解析测试（纯逻辑，不需要网络与 ffmpeg）。
 * 运行：npm run test:ass
 */
import assert from 'node:assert'
import {
  buildAss,
  escapeAssText,
  escapeFilterPath,
  subtitlesFilter,
  type BurnCue
} from '../src/main/slice/ass'
import { parseFontFamily } from '../src/main/slice/fontName'

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

/* ------------------------------- ASS 生成 ------------------------------- */

const STYLE = { width: 1920, height: 1080, fontName: 'Microsoft YaHei', fontSize: 54 }

function cue(start: number, end: number, text: string): BurnCue {
  return { start, end, text }
}

section('buildAss')

check('包含 Script Info / Styles / Events 三个段', () => {
  const ass = buildAss([cue(0.4, 2.4, '你好')], STYLE)
  assert.ok(ass.includes('[Script Info]'))
  assert.ok(ass.includes('[V4+ Styles]'))
  assert.ok(ass.includes('[Events]'))
})

check('时间戳格式为 H:MM:SS.cc', () => {
  const ass = buildAss([cue(0.5, 65.25, 'x')], STYLE)
  assert.ok(ass.includes('Dialogue: 0,0:00:00.50,0:01:05.25,Default'))
})

check('PlayRes 与字号写入样式', () => {
  const ass = buildAss([], { width: 1280, height: 720, fontName: 'KaiTi', fontSize: 36 })
  assert.ok(ass.includes('PlayResX: 1280'))
  assert.ok(ass.includes('PlayResY: 720'))
  assert.ok(ass.includes('KaiTi,36,'))
})

check('负起点被钳到 0', () => {
  const ass = buildAss([cue(-1, 1, 'x')], STYLE)
  assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:01.00,Default'))
})

check('空文本被跳过', () => {
  const ass = buildAss([cue(0, 1, '  '), cue(1, 2, '有效')], STYLE)
  assert.equal(ass.split('Dialogue: ').length - 1, 1)
})

check('结束早于起点时至少显示 0.05 秒', () => {
  const ass = buildAss([cue(2, 0.5, 'x')], STYLE)
  assert.ok(ass.includes('0:00:02.00,0:00:02.05,Default'))
})

check('样式为白字黑边、底部居中', () => {
  const ass = buildAss([cue(0, 1, 'x')], STYLE)
  // Style 行的最后三个字段：Alignment=2（底部居中）, MarginV=40, Encoding=1
  assert.ok(ass.includes('&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1'))
})

check('多行文本中的换行转成 \\N', () => {
  const ass = buildAss([cue(0, 1, '第一行\r\n第二行')], STYLE)
  assert.ok(ass.includes('第一行\\N第二行'))
})

/* ------------------------------- 文本转义 ------------------------------- */

section('escapeAssText')

check('花括号换成全角、换行换成 \\N', () => {
  assert.equal(escapeAssText('{重点}a\nb'), '｛重点｝a\\Nb')
})

/* ------------------------------- 滤镜路径 ------------------------------- */

section('subtitlesFilter / escapeFilterPath')

check('反斜杠换斜杠、冒号与引号转义', () => {
  assert.equal(escapeFilterPath("D:\\my dir\\a'b.ass"), "D\\:/my dir/a\\'b.ass")
})

check('subtitles 滤镜带 filename 与可选 fontsdir', () => {
  const f = subtitlesFilter('D:/tmp/my dir/a b.ass', 'D:/tmp/fonts 字体')
  assert.ok(f.startsWith("subtitles=filename='D\\:/tmp/my dir/a b.ass'"))
  assert.ok(f.includes(":fontsdir='D\\:/tmp/fonts 字体'"))
  const noFonts = subtitlesFilter('D:/tmp/a.ass')
  assert.ok(!noFonts.includes('fontsdir'))
})

/* ------------------------------- 字体族名解析 ------------------------------- */

section('parseFontFamily')

/** 把记录编码成 name 表（format 0；字符串区统一 UTF-16BE） */
function makeNameTable(
  records: Array<{ platform: number; encoding: number; nameId: number; text: string }>
): Buffer {
  const enc = (s: string): Buffer => {
    const buf = Buffer.alloc(s.length * 2)
    for (let i = 0; i < s.length; i++) buf.writeUInt16BE(s.charCodeAt(i), i * 2)
    return buf
  }
  const recs = records.map((r) => enc(r.text))
  const headerSize = 6 + records.length * 12
  const buf = Buffer.alloc(headerSize + recs.reduce((a, b) => a + b.length, 0))
  buf.writeUInt16BE(0, 0)
  buf.writeUInt16BE(records.length, 2)
  buf.writeUInt16BE(headerSize, 4)
  let off = 0
  records.forEach((r, i) => {
    const rec = 6 + i * 12
    buf.writeUInt16BE(r.platform, rec)
    buf.writeUInt16BE(r.encoding, rec + 2)
    buf.writeUInt16BE(0, rec + 4)
    buf.writeUInt16BE(r.nameId, rec + 6)
    buf.writeUInt16BE(recs[i].length, rec + 8)
    buf.writeUInt16BE(off, rec + 10)
    recs[i].copy(buf, headerSize + off)
    off += recs[i].length
  })
  return buf
}

/** 把 name 表包成单表 sfnt（tag 0x00010000，table 目录 + name 表） */
function makeFont(nameBuf: Buffer): Buffer {
  const buf = Buffer.alloc(12 + 16 + nameBuf.length)
  buf.writeUInt32BE(0x00010000, 0)
  buf.writeUInt16BE(1, 4)
  buf.write('name', 12, 'ascii')
  buf.writeUInt32BE(0, 16)
  buf.writeUInt32BE(12 + 16, 20)
  buf.writeUInt32BE(nameBuf.length, 24)
  nameBuf.copy(buf, 12 + 16)
  return buf
}

/** 包成 TTC：'ttcf' + u32@8 字体偏移 + 字体本体 */
function makeTtc(fontBuf: Buffer): Buffer {
  const header = Buffer.alloc(12)
  header.write('ttcf', 0, 'ascii')
  header.writeUInt32BE(12, 8)
  return Buffer.concat([header, fontBuf])
}

check('Windows(3)/nameID1 的 UTF-16BE 族名', () => {
  const font = makeFont(
    makeNameTable([{ platform: 3, encoding: 1, nameId: 1, text: '测试字体' }])
  )
  assert.equal(parseFontFamily(font), '测试字体')
})

check('Windows 平台优先于 Unicode 平台', () => {
  const font = makeFont(
    makeNameTable([
      { platform: 0, encoding: 3, nameId: 1, text: 'Unicode 版' },
      { platform: 3, encoding: 1, nameId: 1, text: 'Windows 版' }
    ])
  )
  assert.equal(parseFontFamily(font), 'Windows 版')
})

check('没有 nameID 1 时用 16 兜底', () => {
  const font = makeFont(
    makeNameTable([{ platform: 3, encoding: 1, nameId: 16, text: '排版族名' }])
  )
  assert.equal(parseFontFamily(font), '排版族名')
})

check('TTC 集合按偏移取第一个字体', () => {
  const font = makeFont(
    makeNameTable([{ platform: 3, encoding: 1, nameId: 1, text: '集合字体' }])
  )
  assert.equal(parseFontFamily(makeTtc(font)), '集合字体')
})

check('垃圾数据返回 null 而不是抛异常', () => {
  assert.equal(parseFontFamily(Buffer.from('not a font')), null)
  assert.equal(parseFontFamily(Buffer.alloc(4)), null)
})

/* ------------------------------- 汇总 ------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
