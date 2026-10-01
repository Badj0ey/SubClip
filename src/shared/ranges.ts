/**
 * 时间坐标生成：把「选中的字幕序号集合」转换成「时间范围数组」。
 *
 * 规则（对应需求文档 3.5）：
 * - 连续字幕：取第一条字幕开始时间 与 最后一条字幕结束时间，合成一个范围。
 * - 非连续字幕：分别生成多个独立时间范围。
 * - 可选 maxGap：两条字幕序号不连续、但时间间隔很小时也合并成一段，避免同一句话被切碎。
 * - 跨分P：如果 Pn 的最后一条与 Pn+1 的第一条都被选中，两段视为同一个切片，
 *   会记录各分P 的独立时间段（segments），切片时分别裁剪再拼成一个视频。
 */
import type { Cue, TimeRange } from './types'

/** 参与计算的最小结构：带可选的分P 信息 */
export type RangeCue = Cue & { page?: number }

interface MutableRange extends TimeRange {
  lastIndex: number
  segments: Array<{ page: number; start: number; end: number }>
}

export function buildRanges(
  cues: RangeCue[],
  selected: Set<number>,
  maxGap = 0.5
): TimeRange[] {
  const picked = cues.filter((c) => selected.has(c.index)).sort((a, b) => a.index - b.index)
  const ranges: MutableRange[] = []

  for (const cue of picked) {
    const page = cue.page ?? 1
    const last = ranges[ranges.length - 1]

    if (last) {
      const sequential = cue.index === last.lastIndex + 1
      const closeEnough = maxGap > 0 && cue.start - last.end <= maxGap
      if (sequential || closeEnough) {
        last.cueIndexes.push(cue.index)
        last.lastIndex = cue.index

        // 同一段内按分P 拆成若干子段；跨P 时多出一段
        const seg = last.segments[last.segments.length - 1]
        if (seg.page === page) {
          // 同一分P 内的时间轴是连续的，可以正常取并集
          seg.start = Math.min(seg.start, cue.start)
          seg.end = Math.max(seg.end, cue.end)
          last.start = Math.min(last.start, cue.start)
          last.end = Math.max(last.end, cue.end)
        } else {
          // 跨P：两个分P 的时间轴互相独立，不能做 min/max。
          // 整体范围取「第一段起点 → 最后一段终点」，实际剪裁按 segments 走。
          last.segments.push({ page, start: cue.start, end: cue.end })
          last.end = cue.end
        }
        continue
      }
    }

    ranges.push({
      start: cue.start,
      end: cue.end,
      cueIndexes: [cue.index],
      lastIndex: cue.index,
      segments: [{ page, start: cue.start, end: cue.end }]
    })
  }

  return ranges.map((r) => ({
    start: r.start,
    end: r.end,
    cueIndexes: r.cueIndexes,
    segments: r.segments,
    crossPage: r.segments.length > 1
  }))
}

/**
 * 时间范围总时长（秒）。
 * 跨分P 时整体 start/end 跨越了两个独立时间轴，没有直接相减的意义，改为累加各段时长。
 */
export function totalDuration(ranges: TimeRange[]): number {
  return ranges.reduce((sum, r) => {
    if (r.segments && r.segments.length > 1) {
      return sum + r.segments.reduce((s, seg) => s + Math.max(0, seg.end - seg.start), 0)
    }
    return sum + Math.max(0, r.end - r.start)
  }, 0)
}

/** 单个范围的可读描述（跨P 时逐段展示） */
export function describeRange(r: TimeRange): string {
  if (r.segments && r.segments.length > 1) {
    return r.segments.map((s) => `P${s.page}`).join(' + ')
  }
  return ''
}

/** 单个范围的时长（秒） */
export function rangeDuration(r: TimeRange): number {
  if (r.segments && r.segments.length > 1) {
    return r.segments.reduce((s, seg) => s + Math.max(0, seg.end - seg.start), 0)
  }
  return Math.max(0, r.end - r.start)
}

/**
 * 把扁平的时间范围列表合并重叠 / 相邻的区间（导出前做一次清理）。
 */
export function normalizeRanges(ranges: TimeRange[], gap = 0.05): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start - last.end <= gap) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r, cueIndexes: [...r.cueIndexes] })
    }
  }
  return out
}
