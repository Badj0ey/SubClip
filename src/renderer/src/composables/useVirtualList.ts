/**
 * 轻量虚拟滚动（支持动态行高）。
 *
 * 适用场景：字幕条目高度不固定（文本会换行），不能简单地用「固定行高 × 序号」定位。
 * 做法：
 *   - 维护每条实测高度 heights[] 与累计偏移 offsets[]（未测到的用预估值）
 *   - 滚动时二分查找可见区间，只渲染可见部分 + overscan 缓冲
 *   - 渲染后测量真实高度，若与记录不符则重算偏移
 *   - 用上下两个占位块撑出滚动条总高度
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

export interface UseVirtualListOptions {
  /** 滚动容器 */
  container: Ref<HTMLElement | null>
  /** 数据条数 */
  count: Ref<number>
  /** 预估行高（px），实际高度会在渲染后修正 */
  estimate: Ref<number>
  /** 上下各多渲染几行 */
  overscan?: number
  /** 变化时需要丢弃全部测量结果（例如字号、行距改变） */
  resetKey?: Ref<unknown>
  /** 行元素的属性名，值需为该行在列表中的下标 */
  indexAttr?: string
  /**
   * 列表首尾额外的空白（px）。
   * 用于让第一条 / 最后一条也能滚动到视口内的特定位置（例如「阅读条」处）。
   */
  extraTop?: Ref<number>
  extraBottom?: Ref<number>
}

export function useVirtualList(options: UseVirtualListOptions) {
  const {
    container,
    count,
    estimate,
    overscan = 6,
    resetKey,
    indexAttr = 'data-vindex',
    extraTop,
    extraBottom
  } = options

  let heights: number[] = []
  let offsets: number[] = []
  let rafId = 0
  let resizeObserver: ResizeObserver | null = null

  const startIndex = ref(0)
  const endIndex = ref(0)
  const topPad = ref(0)
  const bottomPad = ref(0)
  const totalHeight = ref(0)
  const viewportHeight = ref(0)
  const atTop = ref(true)

  const visibleIndexes = computed(() => {
    const list: number[] = []
    for (let i = startIndex.value; i < endIndex.value; i++) list.push(i)
    return list
  })

  function rebuildOffsets(): void {
    const n = count.value
    const top = extraTop?.value ?? 0
    const bottom = extraBottom?.value ?? 0
    offsets = new Array<number>(n + 1)
    let acc = top
    for (let i = 0; i < n; i++) {
      offsets[i] = acc
      acc += heights[i] || estimate.value
    }
    offsets[n] = acc
    totalHeight.value = acc + bottom
  }

  function syncHeightArray(): void {
    const n = count.value
    if (heights.length === n && count.value === 0) return
    const next = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) next[i] = heights[i] ?? 0
    heights = next
  }

  function findStartIndex(top: number): number {
    const n = count.value
    if (!n) return 0
    let lo = 0
    let hi = n - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((offsets[mid] ?? 0) <= top) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  function updateRange(): void {
    const el = container.value
    const n = count.value
    if (!el || !n) {
      startIndex.value = 0
      endIndex.value = 0
      topPad.value = 0
      bottomPad.value = 0
      return
    }

    const top = el.scrollTop
    atTop.value = top <= 4

    if (!offsets.length || offsets.length !== n + 1) {
      syncHeightArray()
      rebuildOffsets()
    }

    const viewport = el.clientHeight
    viewportHeight.value = viewport
    const s = findStartIndex(top)
    let e = s
    while (e < n && (offsets[e] ?? 0) < top + viewport) e++

    const from = Math.max(0, s - overscan)
    const to = Math.min(n, e + overscan)

    startIndex.value = from
    endIndex.value = to
    topPad.value = offsets[from] ?? 0
    bottomPad.value = Math.max(0, totalHeight.value - (offsets[to] ?? totalHeight.value))
  }

  /** 测量当前已渲染行的真实高度，必要时重算 */
  function measure(): void {
    const root = container.value
    if (!root) return
    let changed = false
    const rows = root.querySelectorAll<HTMLElement>(`[${indexAttr}]`)
    for (const row of rows) {
      const i = Number(row.getAttribute(indexAttr))
      if (!Number.isFinite(i)) continue
      const h = row.offsetHeight
      if (h > 0 && Math.abs((heights[i] ?? 0) - h) > 0.5) {
        heights[i] = h
        changed = true
      }
    }
    if (changed) {
      rebuildOffsets()
      updateRange()
    }
  }

  function scheduleMeasure(): void {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      measure()
    })
  }

  function onScroll(): void {
    updateRange()
    scheduleMeasure()
  }

  /** 滚动到指定行（若已可见则不动） */
  function scrollToIndex(index: number, behavior: ScrollBehavior = 'auto'): void {
    const el = container.value
    if (!el) return
    if (!offsets.length || offsets.length !== count.value + 1) {
      syncHeightArray()
      rebuildOffsets()
    }
    const top = offsets[index] ?? 0
    const h = heights[index] || estimate.value
    const viewTop = el.scrollTop
    const viewBottom = viewTop + el.clientHeight
    if (top >= viewTop && top + h <= viewBottom) return
    el.scrollTo({ top: Math.max(0, top - (el.clientHeight - h) / 2), behavior })
    updateRange()
  }

  /**
   * 把某一行滚动到视口内指定比例位置。
   * ratio=0 表示对齐顶部，0.38 表示对齐到 38% 高度处（阅读条位置）。
   */
  function scrollToIndexAt(index: number, ratio: number, behavior: ScrollBehavior = 'auto'): void {
    const el = container.value
    if (!el) return
    if (!offsets.length || offsets.length !== count.value + 1) {
      syncHeightArray()
      rebuildOffsets()
    }
    const h = heights[index] || estimate.value
    const top = (offsets[index] ?? 0) + h / 2 - el.clientHeight * ratio
    el.scrollTo({ top: Math.max(0, top), behavior })
    updateRange()
  }

  /** 某一行当前的顶部偏移与高度（供外部做精确滚动） */
  function metricsOf(index: number): { offset: number; height: number } {
    if (!offsets.length || offsets.length !== count.value + 1) {
      syncHeightArray()
      rebuildOffsets()
    }
    return { offset: offsets[index] ?? 0, height: heights[index] || estimate.value }
  }

  /** 回到顶部 */
  function scrollToTop(): void {
    container.value?.scrollTo({ top: 0 })
    updateRange()
  }

  /** 丢弃测量结果（字号 / 行距变化后调用） */
  function reset(): void {
    heights = []
    syncHeightArray()
    rebuildOffsets()
    updateRange()
    void nextTick(scheduleMeasure)
  }

  function refresh(): void {
    syncHeightArray()
    rebuildOffsets()
    updateRange()
    void nextTick(scheduleMeasure)
  }

  if (resetKey) {
    watch(resetKey, () => reset())
  }

  // 首尾留白变化（例如窗口尺寸变了）需要重算偏移
  if (extraTop || extraBottom) {
    watch([extraTop ?? ref(0), extraBottom ?? ref(0)], () => {
      rebuildOffsets()
      updateRange()
    })
  }

  watch(
    count,
    () => {
      heights = []
      syncHeightArray()
      rebuildOffsets()
      scrollToTop()
      updateRange()
      void nextTick(scheduleMeasure)
    },
    { flush: 'post' }
  )

  watch([startIndex, endIndex], () => scheduleMeasure(), { flush: 'post' })

  function attach(): void {
    const el = container.value
    if (!el) return
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateRange())
      resizeObserver.observe(el)
    }
    syncHeightArray()
    rebuildOffsets()
    updateRange()
    void nextTick(scheduleMeasure)
  }

  onBeforeUnmount(() => {
    if (rafId) cancelAnimationFrame(rafId)
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return {
    visibleIndexes,
    topPad,
    bottomPad,
    totalHeight,
    viewportHeight,
    atTop,
    startIndex,
    endIndex,
    onScroll,
    scrollToIndex,
    scrollToIndexAt,
    metricsOf,
    scrollToTop,
    refresh,
    reset,
    attach,
    /** 让外部在内容变化后主动触发一次测量 */
    remeasure: scheduleMeasure
  }
}
