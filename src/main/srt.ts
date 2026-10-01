/**
 * SRT 解析 / 生成 / 编码识别。
 *
 * 需求要点（文档 3.1）：支持 UTF-8、常见 SRT 格式、格式异常处理。
 * 实现上额外兼容 GBK、UTF-16 与各种不规范写法，尽量不丢字幕。
 */
import type { Cue, ParseResult } from '@shared/types'
import { formatTime, parseTime } from '@shared/time'

/** 去掉字幕里的样式标签：<i> <b> <font ...> {\an8} 等 */
function stripTags(input: string): string {
  return input
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * 将文件 Buffer 解码为字符串。
 * 依次识别 UTF-8 BOM、UTF-16 BOM、UTF-8，失败则回退 GBK。
 */
export function decodeBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' }
  }

  const asUtf8 = buf.toString('utf8')
  if (!asUtf8.includes('�')) return { text: asUtf8, encoding: 'utf-8' }

  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf)
    if (!gbk.includes('�')) return { text: gbk, encoding: 'gbk' }
    return { text: gbk, encoding: 'gbk(近似)' }
  } catch {
    return { text: asUtf8, encoding: 'utf-8(近似)' }
  }
}

/** 判断一行是否时间轴行 */
function findTimelineIndex(lines: string[]): number {
  const limit = Math.min(lines.length, 4)
  for (let i = 0; i < limit; i++) {
    if (lines[i].includes('-->')) return i
  }
  return -1
}

/**
 * 解析 SRT 文本。
 * 返回按出现顺序重新编号（1..N）的字幕列表与告警信息。
 */
export function parseSrt(content: string): ParseResult {
  const warnings: string[] = []
  const raw: Array<{ start: number; end: number; text: string }> = []

  const normalized = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n{2,}/)

  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^\n+|\n+$/g, '')
    if (!block.trim()) continue

    const lines = block.split('\n')
    const timelineIdx = findTimelineIndex(lines)

    if (timelineIdx === -1) {
      warnings.push(`忽略无法识别的内容块：「${block.slice(0, 24).replace(/\n/g, ' ')}…」`)
      continue
    }

    const parts = lines[timelineIdx].split('-->')
    if (parts.length !== 2) {
      warnings.push(`时间轴格式异常，已跳过：「${lines[timelineIdx].slice(0, 40)}」`)
      continue
    }

    const start = parseTime(parts[0])
    // 结束时间可能带有 X1:... Y1:... 之类的坐标后缀，只取第一个 token
    const end = parseTime(parts[1].trim().split(/\s+/)[0])

    if (Number.isNaN(start) || Number.isNaN(end)) {
      warnings.push(`时间无法解析，已跳过：「${lines[timelineIdx].slice(0, 40)}」`)
      continue
    }

    const text = stripTags(lines.slice(timelineIdx + 1).join('\n'))
    if (!text) {
      warnings.push(`第 ${raw.length + 1} 条字幕正文为空，已跳过`)
      continue
    }

    raw.push({ start, end: Math.max(end, start), text })
  }

  // 统一重新编号，保证序号唯一且递增，供前端选中逻辑使用
  const cues: Cue[] = raw.map((item, i) => ({
    index: i + 1,
    start: item.start,
    end: item.end,
    text: item.text
  }))

  return { cues, warnings }
}

/** 字幕列表 → SRT 文本 */
export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => {
      const body = c.text.trim()
      return `${i + 1}\n${formatTime(c.start, true)} --> ${formatTime(c.end, true)}\n${body}`
    })
    .join('\n\n')
    .concat('\n')
}

/** 字幕列表 → WebVTT 文本（时间用点做小数分隔符，且不写序号） */
export function toVtt(cues: Cue[]): string {
  const lines = cues.map((c) => {
    const from = formatTime(c.start, true).replace(',', '.')
    const to = formatTime(c.end, true).replace(',', '.')
    return `${from} --> ${to}\n${c.text.trim()}`
  })
  return `WEBVTT\n\n${lines.join('\n\n')}\n`
}

/** 字幕列表 → 纯文本（每行一句，用于做文案、喂给别的工具） */
export function toPlainText(cues: Cue[]): string {
  return cues
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join('\n')
    .concat('\n')
}

/**
 * 批量调整时间轴。
 *
 * @param offsetMs 整体平移毫秒数（可为负）
 * @param scale 倍速缩放（1 = 不变），围绕第一条字幕的起点缩放，避免整段飘走
 * @returns 新的字幕列表（不修改入参），起点会被夹到 >= 0
 */
export function shiftCues(cues: Cue[], offsetMs: number, scale = 1): Cue[] {
  const offset = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1
  const origin = cues.length ? cues[0].start : 0
  const fix = (t: number): number => Math.max(0, Math.round((origin + (t - origin) * k + offset) * 1000) / 1000)
  return cues.map((c) => ({ ...c, start: fix(c.start), end: fix(c.end) }))
}

/** 批量替换结果 */
export interface ReplaceResult {
  cues: Cue[]
  /** 被改动的字幕条数 */
  changed: number
}

/**
 * 批量查找替换。
 * @param useRegex 为正则模式；正则非法时抛错，由调用方提示用户
 */
export function replaceInCues(
  cues: Cue[],
  pattern: string,
  replacement: string,
  useRegex: boolean,
  ignoreCase = false
): ReplaceResult {
  if (!pattern) return { cues, changed: 0 }

  const re = useRegex
    ? new RegExp(pattern, ignoreCase ? 'gi' : 'g')
    : new RegExp(
        // 非正则模式下把用户输入当字面量，特殊字符全部转义
        pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        ignoreCase ? 'gi' : 'g'
      )

  let changed = 0
  const next = cues.map((c) => {
    const text = c.text.replace(re, replacement)
    if (text === c.text) return c
    changed++
    return { ...c, text }
  })
  return { cues: next, changed }
}

/** B站字幕 json（body: [{from,to,content}]）→ Cue[] */
export function biliSubtitleToCues(json: unknown): Cue[] {
  const body = (json as { body?: Array<{ from: number; to: number; content: string }> })?.body
  if (!Array.isArray(body)) return []
  return body
    .filter((item) => typeof item?.content === 'string' && item.content.trim())
    .map((item, i) => ({
      index: i + 1,
      start: Number(item.from) || 0,
      end: Number(item.to) || Number(item.from) || 0,
      text: String(item.content).trim()
    }))
}
