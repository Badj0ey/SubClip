/**
 * B站弹幕解析（纯函数，不依赖 Electron）。
 *
 * 两种数据源共用同一套输出结构：
 * - 新版 `/x/v2/dm/web/seg.so` 分段接口，protobuf 编码；
 * - 旧版 `/comment.bilibili.com/{cid}.xml`，XML 编码（作为兼容回退）。
 *
 * 解析器只负责把字节 / 文本变成 `DanmakuItem`，不发起网络请求，
 * 这样回归测试可以直接用 node 跑，不需要 Electron 运行时。
 */
import type { DanmakuEmptyReason, DanmakuItem } from './types'

/** 一次读取 / 单段解析最多保留的弹幕条数 */
export const DANMAKU_MAX_ITEMS = 15000

/** 单条弹幕正文的最大保留长度，避免异常数据撑大内存与界面 */
export const DANMAKU_MAX_TEXT = 500

/**
 * 解析一段 `DmSegMobileReply` protobuf。
 *
 * 字段定义（bilibili-API-collect）：
 *   DanmakuElem: id=1, progress=2(毫秒), mode=3, fontsize=4, color=5,
 *                midHash=6, content=7, ctime=8, weight=9, action=10,
 *                pool=11, idStr=12, attr=13
 *   DmSegMobileReply: elems=1, state=2, aiFlag=3
 *
 * 注意：id 数字字段是 int64，超出 JS 安全整数范围后不可靠，
 * 因此优先使用 `idStr`（field 12），缺失时生成稳定兜底 id。
 */
export function parseDanmakuSegment(
  bytes: Uint8Array,
  page: number,
  maxItems = DANMAKU_MAX_ITEMS
): DanmakuItem[] {
  const items: DanmakuItem[] = []
  walkFields(bytes, (field, wire, value) => {
    if (field !== 1 || wire !== 2 || !(value instanceof Uint8Array)) return
    if (items.length >= maxItems) return
    const item = parseDanmakuElem(value, page, items.length)
    if (item) items.push(item)
  })
  return items
}

function parseDanmakuElem(
  bytes: Uint8Array,
  page: number,
  index: number
): DanmakuItem | null {
  let progress = -1
  let text = ''
  let idStr = ''
  let mode = 1
  let color = 0xffffff
  walkFields(bytes, (field, wire, value) => {
    if (field === 2 && wire === 0) progress = Number(value)
    else if (field === 3 && wire === 0) mode = Number(value)
    else if (field === 5 && wire === 0) color = Number(value)
    else if (field === 7 && wire === 2 && value instanceof Uint8Array) {
      text = decoder.decode(value)
    } else if (field === 12 && wire === 2 && value instanceof Uint8Array) {
      idStr = decoder.decode(value)
    }
  })
  const content = text.trim()
  if (progress < 0 || !content) return null
  return {
    id: idStr || `${page}:${progress}:${index}`,
    page,
    time: progress / 1000,
    text: content.slice(0, DANMAKU_MAX_TEXT),
    mode,
    color
  }
}

/** 解析旧版 XML 弹幕；`p` 属性格式：time,mode,fontsize,color,ctime,pool,midHash,dmid */
export function parseDanmakuXml(xml: string, page: number, maxItems = DANMAKU_MAX_ITEMS): DanmakuItem[] {
  const out: DanmakuItem[] = []
  // 兼容属性顺序变化；只取 <d> 元素，避免误吃其他标签。
  const re = /<d\b[^>]*\bp="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null && out.length < maxItems) {
    const parts = match[1].split(',')
    const time = Number(parts[0])
    if (!Number.isFinite(time) || time < 0) continue
    const text = decodeXmlText(match[2]).trim()
    if (!text) continue
    const mode = Number(parts[1])
    const color = Number(parts[3])
    out.push({
      id: parts[7] || `${page}:${time}:${out.length}`,
      page,
      time,
      text: text.slice(0, DANMAKU_MAX_TEXT),
      mode: Number.isFinite(mode) && mode > 0 ? mode : 1,
      color: Number.isFinite(color) && color >= 0 ? color : 0xffffff
    })
  }
  return out
}

const decoder = new TextDecoder()

type FieldVisitor = (field: number, wire: number, value: number | Uint8Array) => void

/** 极简 protobuf 字段遍历；只支持弹幕接口实际用到的 wire type 0/1/2/5。 */
function walkFields(bytes: Uint8Array, visit: FieldVisitor): void {
  let pos = 0
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos)
    pos = afterTag
    const wire = tag & 7
    const field = Math.floor(tag / 8)
    if (!field) throw new Error('弹幕字段无效')
    if (wire === 0) {
      const [value, next] = readVarint(bytes, pos)
      pos = next
      visit(field, wire, value)
    } else if (wire === 2) {
      const [length, next] = readVarint(bytes, pos)
      pos = next
      if (length > bytes.length - pos) throw new Error('弹幕长度不正确')
      visit(field, wire, bytes.subarray(pos, pos + length))
      pos += length
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4
      if (pos > bytes.length) throw new Error('弹幕数据不完整')
    } else {
      throw new Error('不支持的弹幕编码')
    }
  }
}

function readVarint(bytes: Uint8Array, start: number): [number, number] {
  let result = 0
  let factor = 1
  let pos = start
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new Error('弹幕数据不完整')
    const byte = bytes[pos++]
    result += (byte & 127) * factor
    if (!(byte & 128)) return [result, pos]
    factor *= 128
  }
  throw new Error('弹幕数据格式不正确')
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (raw, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePoint(Number.parseInt(body.slice(2), 16), raw)
    }
    if (body.startsWith('#')) {
      return codePoint(Number.parseInt(body.slice(1), 10), raw)
    }
    return XML_ENTITIES[body] ?? raw
  })
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return fallback
  if (value >= 0xd800 && value <= 0xdfff) return fallback
  return String.fromCodePoint(value)
}

/** 直播回放投稿的简介通常保留直播间链接 */
const LIVE_ROOM_LINK = /live\.bilibili\.com\/\d+/
/** 直播回放的标题通常带场次时间，如「2026年10月19日19点场」 */
const LIVE_REPLAY_TITLE = /\d{4}年\d{1,2}月\d{1,2}日\d{1,2}点/

/**
 * 视频弹幕总数为 0 时，判断更可能的原因。
 *
 * 直播回放投稿的弹幕池里没有直播期间的聊天弹幕，B站也不提供公开存档接口；
 * 面板据此直接说明原因，而不是把空弹幕池说成「接口暂不可用」。
 * 只有简介和标题两个信号同时出现才判为直播回放，避免误判普通视频。
 */
export function classifyEmptyDanmaku(desc: string, title: string): DanmakuEmptyReason {
  return LIVE_ROOM_LINK.test(desc) && LIVE_REPLAY_TITLE.test(title)
    ? 'live-replay'
    : 'no-danmaku'
}
