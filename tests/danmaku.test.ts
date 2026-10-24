import { strict as assert } from 'node:assert'
import {
  classifyEmptyDanmaku,
  parseDanmakuSegment,
  parseDanmakuXml
} from '../src/shared/danmaku'

/**
 * 弹幕解析回归测试（3.17.0）。
 *
 * 这里按 bilibili-API-collect 的真实字段编码构造 protobuf：
 * idStr=12、progress=2、mode=3、color=5、content=7。
 * 旧整合包曾把 id 写成 field 8、color 写成 field 4，本测试专门防止再次写错。
 */
const encoder = new TextEncoder()
const bytes = (s: string): number[] => [...encoder.encode(s)]

const vint = (n: number): number[] => {
  const out: number[] = []
  let value = Math.max(0, Math.floor(n))
  do {
    const b = value & 127
    value = Math.floor(value / 128)
    out.push(b | (value ? 128 : 0))
  } while (value)
  return out
}
const fieldBytes = (id: number, data: number[]): number[] => [
  ...vint(id * 8 + 2),
  ...vint(data.length),
  ...data
]
const fieldStr = (id: number, value: string): number[] => fieldBytes(id, bytes(value))
const fieldVarint = (id: number, value: number): number[] => [...vint(id * 8), ...vint(value)]

const elem = (fields: number[]): number[] => fieldBytes(1, fields)
const reply = (...elems: number[][]): Uint8Array =>
  new Uint8Array([...elems.flatMap((e) => elem(e)), ...fieldVarint(2, 0)])

// 一条完整弹幕：真实字段顺序不固定，解析器不应依赖顺序。
const first = [
  ...fieldStr(12, '42'),
  ...fieldVarint(2, 12500),
  ...fieldVarint(3, 1),
  ...fieldVarint(4, 25),
  ...fieldVarint(5, 0xff0000),
  ...fieldStr(7, '你好'),
  ...fieldVarint(8, 1700000000)
]
const second = [...fieldVarint(2, 0), ...fieldStr(7, '第二条')]

const parsed = parseDanmakuSegment(reply(first, second), 2)
assert.equal(parsed.length, 2)
assert.equal(parsed[0].id, '42')
assert.equal(parsed[0].time, 12.5)
assert.equal(parsed[0].text, '你好')
assert.equal(parsed[0].page, 2)
assert.equal(parsed[0].mode, 1)
assert.equal(parsed[0].color, 0xff0000)
assert.equal(parsed[1].time, 0)
assert.equal(parsed[1].text, '第二条')
assert.equal(parsed[1].color, 0xffffff)
assert.match(parsed[1].id, /^2:0:1$/)

// 正文为空、时间缺失的条目应被丢弃；正文超长截断。
const skipped = parseDanmakuSegment(
  reply(
    [...fieldStr(7, '   '), ...fieldVarint(2, 1000)],
    [...fieldStr(7, 'x'.repeat(600)), ...fieldVarint(2, 2000)],
    [...fieldStr(7, '没有时间')]
  ),
  1
)
assert.equal(skipped.length, 1)
assert.equal(skipped[0].text.length, 500)

// 分段数据被截断时应明确报错，而不是返回半条弹幕。
assert.throws(() => parseDanmakuSegment(new Uint8Array([0x0a, 0x05, 0x01]), 1), /弹幕/)

const xml = parseDanmakuXml(
  '<i><d p="12.5,1,25,16777215,0,0,abc,9001">测试&amp;字幕</d>' +
    '<d ctime="0" p="3,4,25,255,0,0,def,9002">&#20320;&#x597d;</d>' +
    '<d p="bad,1,25,255,0,0,ghi,9003">坏数据</d>' +
    '<d p="4,1,25,255,0,0,jkl,9004">   </d></i>',
  1
)
assert.equal(xml.length, 2)
assert.equal(xml[0].id, '9001')
assert.equal(xml[0].time, 12.5)
assert.equal(xml[0].text, '测试&字幕')
assert.equal(xml[0].color, 16777215)
assert.equal(xml[1].id, '9002')
assert.equal(xml[1].mode, 4)
assert.equal(xml[1].color, 255)
assert.equal(xml[1].text, '你好')

// 视频弹幕总数为 0 时区分「直播回放」和「普通无弹幕视频」：
// 只有简介里的直播间链接 + 标题里的场次时间同时出现才算直播回放。
const liveDesc = '日常直播，欢迎来玩～b站直播间：https://live.bilibili.com/31421411'
assert.equal(classifyEmptyDanmaku(liveDesc, '【弥雾meow】元气杂谈 2026年10月19日19点场'), 'live-replay')
assert.equal(classifyEmptyDanmaku(liveDesc, '普通投稿标题'), 'no-danmaku')
assert.equal(classifyEmptyDanmaku('没有直播间链接', '2026年10月19日19点场'), 'no-danmaku')
assert.equal(classifyEmptyDanmaku('', ''), 'no-danmaku')

console.log('danmaku parser tests passed')
