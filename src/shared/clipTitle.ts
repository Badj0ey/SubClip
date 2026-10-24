/**
 * 切片自动命名（第五阶段）。
 *
 * 目标：让输出的文件名能说明内容。原先命名只能拼「模板占位符」，
 * 结果是一堆 `前缀_1`、`前缀_2`，回头看完全认不出哪条是哪条。
 *
 * 策略（提示词里的「规则 + AI 优化」，本轮先做规则，AI 留接口）：
 * 1. **优先用字幕**：取该范围第一条字幕的文本当名字（「AI改变软件开发」比
 *    「弥雾meow #3」有用得多）；
 * 2. 太短 / 太空（如「啊」「然后」「那个」）就往后找下一条有信息的；
 * 3. 都不可用才回退到「视频标题 + 序号」；
 * 4. 最后统一走文件名净化（Windows 保留名、非法字符等由 sanitizeFileName 负责）。
 *
 * `generateAiTitle` 是给第六阶段 `AIProvider` 留的接口位：签名与返回值已定，
 * 现在返回 null 表示「没有 AI 结果」，调用方自然回退到规则结果。
 */

import type { Cue } from './types'
import { sanitizeFileName } from './filename'

/** 这些词单独当地名/标题没有信息量，遇到就继续往后找 */
const MEANINGLESS = new Set([
  '啊',
  '嗯',
  '哦',
  '呃',
  '哎',
  '诶',
  '哈',
  '哈哈',
  '然后',
  '那个',
  '这个',
  '就是',
  '所以',
  '但是',
  '对对对',
  '是的',
  '没有',
  '不知道',
  'hello',
  'hi',
  'ok',
  'okay'
])

export interface TitleInput {
  /** 该范围覆盖的字幕（已按时间排序） */
  cues: Pick<Cue, 'text'>[]
  /** 视频标题（兜底用） */
  videoTitle: string
  /** 该范围在本次批量里的序号（从 1 起，兜底用） */
  index: number
  /** 最长字符数（文件名不宜太长；Windows 路径总长也有限制） */
  maxLength?: number
}

/** 开头常见的语气词 / 连接词，取名时剥掉（`哦对了` → `对了`，`那我们就开始吧` → `我们就开始吧`） */
const LEADING_PARTICLES = /^(?:[啊嗯哦呃哎诶唉诶呀哇哈嘿喂咦噢喔]|那个|这个|然后|就是|所以|但是|不过|其实|反正|好吧|对了|那|好)+/u

/**
 * 把一条字幕整理成「可以当名字」的样子。
 * 返回空串表示这条不适合当名字。
 */
function cleanCandidate(text: string): string {
  let t = text.trim()
  // 去掉开头的语气词（最多剥两轮，处理「嗯那我们就」这类叠加）
  for (let i = 0; i < 2; i++) t = t.replace(LEADING_PARTICLES, '').trim()
  // 去掉开头残留的标点
  t = t.replace(/^[，。、！？；：,.!?;:…~\-—\s]+/, '').trim()
  if (!worthUsing(t)) return ''
  return sanitizeFileName(t).trim()
}

/** 判断一段文本是否值得当名字 */
function worthUsing(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // 去掉纯标点 / 纯空白
  if (!/[\p{L}\p{N}]/u.test(t)) return false
  if (MEANINGLESS.has(t.toLowerCase())) return false
  // 太短（1 个字）基本是语气词；英文 2 个字母可能是有效词，所以按字符类型放宽
  if (t.length < 2 && !/[A-Za-z0-9]/.test(t)) return false
  // 只有一个汉字（剥完语气词后剩「对」「好」这种）也不值得当名字
  if (t.length === 1) return false
  return true
}

/**
 * 规则生成名字（纯函数，可单测）。
 *
 * 返回的名字**已经过文件名净化**，可以直接当 `note` 用。
 */
export function generateClipTitle(input: TitleInput): string {
  const maxLength = Math.max(8, Math.min(120, input.maxLength ?? 40))

  // 1) 从第一条「清理后还有信息量」的字幕里取名
  for (const cue of input.cues) {
    const cleaned = cleanCandidate(cue.text)
    if (cleaned) return cleaned.slice(0, maxLength)
  }

  // 2) 兜底：视频标题 + 序号
  const base = sanitizeFileName(input.videoTitle || 'clip').trim() || 'clip'
  return `${base.slice(0, maxLength - 6)}_${input.index}`.slice(0, maxLength + 8)
}

/**
 * AI 命名接口位（第六阶段接 `AIProvider`）。
 *
 * 现在恒返回 null，表示「没有 AI 结果」→ 调用方用规则结果。
 * 之所以先把签名定下来：接口一旦接上，调用点不必再改。
 */
export async function generateAiTitle(
  _input: TitleInput,
  _provider: unknown
): Promise<string | null> {
  return null
}
