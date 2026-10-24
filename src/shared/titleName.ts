/**
 * 视频标题规范化。
 *
 * ## 目标格式
 *
 * ```
 * 日期 UP主 内容
 * ```
 *
 * 例：
 * - `【弥雾meow】元气杂谈 2026年10月15日19点场` → `2026年10月15日19点场 弥雾meow 元气杂谈`
 * - `【直播回放】幸运流铸剑大师 2026年10月14日19点场` → `2026年10月14日19点场 幸运流铸剑大师`
 *
 * ## 为什么需要它
 *
 * B站标题把**日期藏在中间**，而按时间找素材时这正是最该先看到的信息；
 * 同时 UP主 名被塞在 `【】` 里、平台分类（`【直播回放】`）混在前面。
 * 规范后同一场直播的多个分P、同一天的多场直播一眼就能排好序。
 *
 * ## 规则
 *
 * 1. **先取日期**（找不到就原样返回，见下）；
 * 2. 剥掉 `【…】` 这类方括号片段，逐个判断：
 *    - 与 **UP主 名相同** → 归到 `up主` 位（而不是当噪音丢掉）；
 *    - 是**已知平台标签**（直播回放 / 录播 / 预告…）→ 丢弃；
 *    - 其余 → 当作**内容**保留。
 * 3. 剩下的正文也是内容；
 * 4. 按 `日期 UP主 内容` 拼接，**空缺的位直接省略**（不会留下两个空格）。
 *
 * ## 两条刻意的保守设计
 *
 * - **拿不到日期就原样返回**：把 `【某某】新手教程` 硬剥成 `新手教程` 看起来干净，
 *   但用户可能正是靠 UP主 名区分同名教程的。不确定就不要改 ——
 *   「更整洁但丢信息」的改动比不改更糟。
 * - **平台标签用显式名单**：判据是「整段等于常见平台词」，不是「短就一定是标签」。
 *   名单外的词一律当内容 —— 宁可多留一点，也不要误删这一场的真正标题。
 */
import { classifyBracket } from './titleNameBrackets'

/** 日期时间片段的候选写法，按优先级排列（长的先匹配） */
const DATE_PATTERNS: RegExp[] = [
  // 2026年10月15日19点场 / 2026年10月15日 19点场 / 2026年10月15日晚上19点场
  /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*\d{1,2}\s*[：:点时]\s*(?:\d{1,2}\s*分?)?\s*(?:场|直播|开播)?)/,
  // 2026年10月15日（没有时刻）
  /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/,
  // 2026-10-15 19:00 / 2026/10/15
  /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
  // 10月15日19点场（没有年份）
  /(\d{1,2}\s*月\s*\d{1,2}\s*日\s*(?:凌晨|早上|上午|中午|下午|晚上)?\s*\d{1,2}\s*[：:点时]\s*(?:\d{1,2}\s*分?)?\s*(?:场|直播|开播)?)/
]

/** 开头/结尾的方括号片段（UP主名、平台分类等） */
const BRACKET_PREFIX = /^\s*[【\[（(]([^】\]）)]{0,24})[】\]）)]\s*/

export interface NormalizeOptions {
  /**
   * 该视频的 UP主 名与合集/频道名（用于把括号里的署名认出来并保留）。
   *
   * 为什么要**两个**：实测存在「投稿账号」与「频道名」不同的情况 ——
   * 本机真实数据里投稿账号是 `恩仙仙`，合集却叫 `弥雾meow`，
   * 而标题括号里写的是 `弥雾meow`（用户认得的正是频道名）。
   * 只比对账号名会认不出来，结果署名被当正文留在末尾，位置就错了。
   */
  uploaderName?: string
  collectionName?: string
}

/**
 * 把标题规范成「日期 UP主 内容」。
 *
 * @returns 规范化后的标题；**解析不出日期时原样返回入参**
 */
export function normalizeVideoTitle(raw: string, opts: NormalizeOptions = {}): string {
  const original = (raw ?? '').trim()
  if (!original) return original

  /* ---------------- 1. 剥方括号并分类 ---------------- */

  const contents: string[] = []
  let bracketUploader = ''
  let body = original
  let guard = 0
  while (BRACKET_PREFIX.test(body) && guard++ < 6) {
    const m = body.match(BRACKET_PREFIX)
    if (!m) break
    const inner = (m[1] ?? '').trim()
    const kind = classifyBracket(inner, opts.uploaderName, opts.collectionName)
    if (kind === 'uploader' && !bracketUploader) bracketUploader = inner
    else if (kind === 'content') contents.push(inner)
    // kind === 'platform' → 丢弃
    body = body.replace(BRACKET_PREFIX, '').trim()
  }

  /* ---------------- 2. 取日期 ---------------- */

  let date = ''
  let rest = body
  for (const pattern of DATE_PATTERNS) {
    const m = body.match(pattern)
    if (!m) continue
    date = normalizeTime(m[1])
    rest = (body.slice(0, m.index ?? 0) + body.slice((m.index ?? 0) + m[1].length))
      .replace(/\s+/g, ' ')
      .trim()
    break
  }

  // 拿不到日期 → 原样返回，不猜
  if (!date) return original

  /* ---------------- 3. 拼装 `日期 UP主 内容` ---------------- */

  const uploader = bracketUploader || ''
  // 正文与括号内容合成「内容」，正文在前（正文通常更像标题主体）
  const contentParts = [rest, ...contents].filter((s) => s.length > 0)
  // 内容里如果再出现 UP主 名（有些标题把它写在正文里），去掉以免重复
  const content = contentParts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(uploader ? new RegExp(`^${escapeRegExp(uploader)}\\s*`) : /^$/, '')
    .trim()

  // 空缺的位直接省略，不会留下连续空格
  return [date, uploader, content].filter((s) => s.length > 0).join(' ')
}

/**
 * 规整时间片段内部的空白。
 *
 * 踩过的坑：把所有空白删掉会把 `2026-10-15 19:00` 变成
 * `2026-10-1519:00`（日期和时刻粘在一起，完全读不出来）。
 * 所以只压掉**日期内部**的空格，并在「日期」与「时刻」之间保留一个空格。
 */
function normalizeTime(raw: string): string {
  const compact = raw.replace(/\s+/g, '')
  const m = compact.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})(\d{1,2}:\d{2})$/)
  if (m) return `${m[1]} ${m[2]}`
  return compact
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 批量规范化并返回统计（用于「改之前先看看会影响多少」）。
 */
export function normalizeTitles(
  titles: string[],
  opts: NormalizeOptions = {}
): {
  changed: number
  samples: Array<{ from: string; to: string }>
  missed: string[]
} {
  const samples: Array<{ from: string; to: string }> = []
  const missed: string[] = []
  let changed = 0
  for (const raw of titles) {
    const next = normalizeVideoTitle(raw, opts)
    if (next !== (raw ?? '').trim()) {
      changed++
      if (samples.length < 5) samples.push({ from: raw, to: next })
    } else if (missed.length < 5) {
      missed.push(raw)
    }
  }
  return { changed, samples, missed }
}
