/**
 * 时间轴 ↔ 字幕选择的映射（第五阶段）。
 *
 * 抽成纯函数是为了能单测：时间轴的核心风险不是画得好看，而是
 * **拖出来的像素对应到哪几条字幕** —— 差一条就是切错内容，
 * 而这部分在组件里（有 canvas、有指针事件）根本没法测。
 *
 * 交互约定（与界面一致）：
 * - 在时间轴上**拖出一个区间** → 区间内的字幕被勾选（与列表复选框共享同一份选择）；
 * - `shift` 拖动 → 在原有选择上追加，而不是替换；
 * - 单击某处 → 把光标移到那一刻所属的字幕。
 */

import type { MergedCue } from '@shared/types'

/** 时间 → 该时刻所属字幕的序号；落在空白处时给「最近的一条」 */
export function cueIndexAtTime(cues: MergedCue[], second: number): number | null {
  if (!cues.length) return null
  // 落在某条的区间内 → 直接命中（含起点、含终点）
  for (const c of cues) {
    if (second >= c.start && second <= c.end) return c.index
  }
  // 空白处：取时间上最近的一条（往前优先，符合「往回找刚才那句」的直觉）
  let best = cues[0]
  let bestDist = Math.abs(cues[0].start - second)
  for (const c of cues) {
    const dist = Math.min(Math.abs(c.start - second), Math.abs(c.end - second))
    if (dist < bestDist) {
      best = c
      bestDist = dist
    }
  }
  return best.index
}

/**
 * 找出与 [from, to] 有重叠的所有字幕序号。
 *
 * 判定用**重叠**而不是「完全包含」：用户在时间轴上随手拖一小段，
 * 几乎不可能精确覆盖字幕边界；用包含判定会导致「拖了却没选中任何东西」。
 */
export function cueIndexesInRange(cues: MergedCue[], from: number, to: number): number[] {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const out: number[] = []
  for (const c of cues) {
    // 区间与字幕有交集：字幕起点不晚于区间终点，且字幕终点不早于区间起点
    if (c.start <= hi && c.end >= lo) out.push(c.index)
  }
  return out
}

/**
 * 计算新的选择集合。
 *
 * @param additive `shift` 拖动：在现有选择上追加（已选的不取消），否则替换
 */
export function applyRangeSelection(
  current: Set<number>,
  indexes: number[],
  additive: boolean
): Set<number> {
  if (additive) {
    const next = new Set(current)
    for (const i of indexes) next.add(i)
    return next
  }
  return new Set(indexes)
}

/**
 * 把一条时间轴像素位置换算成秒。
 * 单独抽出来是因为「左右留白」这类细节一旦算错，整体会偏一点、很难看出来。
 */
export function pxToSecond(px: number, width: number, duration: number): number {
  if (width <= 0 || duration <= 0) return 0
  const ratio = Math.min(1, Math.max(0, px / width))
  return ratio * duration
}

/** 秒 → 像素（时间轴画图与命中判定都用它） */
export function secondToPx(second: number, width: number, duration: number): number {
  if (duration <= 0) return 0
  return (Math.min(duration, Math.max(0, second)) / duration) * width
}
