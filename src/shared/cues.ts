/**
 * 字幕条目的合并 / 拆分。
 *
 * 纯函数：只做「一组字幕 → 新的字幕列表」，不碰数据库，便于单测。
 * 索引在最后统一重排，所以调用方不用关心序号怎么变。
 */
import type { Cue } from './types'

/** 中日韩字符（含全角标点）：这些字符之间拼接不需要空格 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/**
 * 拼接多条字幕文本。
 *
 * 规则：**只有两侧都是中日韩字符时才不加空格**。
 * - 中文 + 中文 →「今天天气好」（中文本来就不按词空格）
 * - 英文 + 英文 →「Hello world」（否则会黏成 `Helloworld`）
 * - 中英混排 →「你好 world」「Hello 你好」（拉丁词需要与前后分隔）
 */
export function joinCueText(parts: string[]): string {
  let out = ''
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) continue
    if (!out) {
      out = p
      continue
    }
    const bothCjk = CJK.test(out[out.length - 1]) && CJK.test(p[0])
    out += bothCjk ? p : ` ${p}`
  }
  return out
}

/** 按起点重排并重新编号（1 起） */
export function renumber(cues: Cue[]): Cue[] {
  return [...cues]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((c, i) => ({ ...c, index: i + 1 }))
}

export interface MergeOutcome {
  cues: Cue[]
  /** 实际合并掉的条数（<2 表示什么都没做） */
  merged: number
}

/**
 * 把指定的若干条合并成一条：时间取首条起点 → 末条终点，文本按顺序拼接。
 * 只要选中条数 ≥2 就合并，不要求它们在时间上完全连续（用户自己选的就是意图）。
 */
export function mergeCues(cues: Cue[], indexes: number[]): MergeOutcome {
  const want = new Set(indexes)
  const picked = cues.filter((c) => want.has(c.index)).sort((a, b) => a.start - b.start)
  if (picked.length < 2) return { cues, merged: 0 }

  const merged: Cue = {
    index: 0,
    start: picked[0].start,
    end: Math.max(...picked.map((c) => c.end)),
    text: joinCueText(picked.map((c) => c.text))
  }
  return {
    cues: renumber([...cues.filter((c) => !want.has(c.index)), merged]),
    merged: picked.length
  }
}

export interface SplitOutcome {
  cues: Cue[]
  ok: boolean
  /** 实际切分点（被夹到 [start, end] 内） */
  at: number
}

/**
 * 在 `atSecond` 处把某一条切成两条。
 *
 * 文本按时间比例粗略切分 —— 这本来就只是个起点，切完用户还会自己改词。
 * 切分点会被夹到条目内部（留 1 帧的余量），保证两半都有正的时长。
 */
export function splitCue(cues: Cue[], index: number, atSecond: number): SplitOutcome {
  const target = cues.find((c) => c.index === index)
  if (!target) return { cues, ok: false, at: 0 }

  const minGap = 0.04 // 约 1 帧，避免出现零长度条目
  const span = target.end - target.start
  if (!(span > minGap * 2)) return { cues, ok: false, at: 0 }

  const at = Math.min(target.end - minGap, Math.max(target.start + minGap, atSecond))
  const ratio = (at - target.start) / span
  const len = target.text.length
  const cut = Math.max(0, Math.min(len, Math.round(len * ratio)))

  const left: Cue = { ...target, start: target.start, end: at, text: target.text.slice(0, cut).trim() }
  const right: Cue = {
    index: 0,
    start: at,
    end: target.end,
    text: target.text.slice(cut).trim()
  }

  return {
    cues: renumber([...cues.filter((c) => c.index !== index), left, right]),
    ok: true,
    at
  }
}
