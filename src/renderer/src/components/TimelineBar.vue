<script setup lang="ts">
/**
 * 时间轴（第五阶段）。
 *
 * ## 它解决什么问题
 *
 * 在列表里勾字幕是「逐条读」的路径；但剪辑时经常是「这片子 15 分到 20 分之间那段不错」——
 * 这时候用户脑子里是**时间**，不是「第 842 条字幕」。时间轴就是给这种时候用的：
 * 拖一段出来，落到的字幕自动被勾上（与列表共享同一份选择，不引入第二套状态）。
 *
 * ## 为什么用 canvas 画字幕轨
 *
 * 一个两小时的直播回放有几千条字幕。用 DOM 渲染就是几千个元素，
 * 每次滚动 / 缩放 / 拖选都要重排，秒级卡顿。canvas 只在需要时重绘一次，
 * 且能顺手画出「哪儿字幕密、哪儿空着」这种整体形状 —— 那才是选片时要看的信息。
 *
 * ## 交互
 *
 * - 空白处按下拖动 → 拖出的区间内字幕被**勾选**（替换当前选择）；
 * - `Shift` 拖动 → 追加到现有选择；
 * - 单击（没拖动）→ 把光标移到那一刻的字幕。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MergedCue } from '@shared/types'
import { formatTime } from '@shared/time'
import { cueIndexAtTime, cueIndexesInRange, pxToSecond, secondToPx } from '@shared/timeline'

const props = defineProps<{
  /** 当前文档的全部字幕（合并阅读后的列表） */
  cues: MergedCue[]
  /** 已勾选的字幕序号 */
  selected: Set<number>
  /** 视频总时长（秒）；拿不到时用最后一条字幕的终点兜底 */
  duration: number
  /** 当前光标那条的序号 */
  cursor: number
  /** 播放器当前时间（秒），没开预览时为 0 */
  playPosition?: number
}>()

const emit = defineEmits<{
  /** 拖选出的区间（已换算成字幕序号） */
  (e: 'select', payload: { indexes: number[]; additive: boolean }): void
  /** 单击定位到某条 */
  (e: 'seek', payload: { index: number; second: number }): void
  /** 拖动过程中的实时位置（用于预览栏提示） */
  (e: 'scrub', payload: { from: number; to: number } | null): void
}>()

const wrapEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const width = ref(0)

/** 实际使用的总时长：优先视频时长，否则用最后一条字幕的终点 */
const totalDuration = computed(() => {
  if (props.duration > 0) return props.duration
  const last = props.cues[props.cues.length - 1]
  return last ? Math.max(last.end, 1) : 1
})

/** 拖动中的选区（秒）；null 表示没在拖 */
const drag = ref<{ from: number; to: number } | null>(null)
/** 是否已经超过阈值（超过才算拖选，否则算单击） */
const dragged = ref(false)
let pointerId: number | null = null
let startPx = 0

const cursorCue = computed(() => props.cues.find((c) => c.index === props.cursor) ?? null)

function toSecond(clientX: number): number {
  const el = canvasEl.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  return pxToSecond(clientX - rect.left, rect.width, totalDuration.value)
}

/* --------------------------------- 绘制 --------------------------------- */

function draw(): void {
  const canvas = canvasEl.value
  const el = wrapEl.value
  if (!canvas || !el) return
  const w = el.clientWidth
  const h = el.clientHeight
  if (w <= 0 || h <= 0) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const style = getComputedStyle(el)
  const accent = style.getPropertyValue('--accent').trim() || '#3b82f6'
  const border = style.getPropertyValue('--border').trim() || '#d0d4da'
  const muted = style.getPropertyValue('--muted').trim() || '#8a8f98'
  const text = style.getPropertyValue('--text').trim() || '#1f2328'

  const dur = totalDuration.value
  const px = (s: number): number => secondToPx(s, w, dur)

  // 底槽
  ctx.fillStyle = border
  ctx.globalAlpha = 0.35
  ctx.fillRect(0, h / 2 - 1, w, 2)
  ctx.globalAlpha = 1

  // 字幕轨：每条字幕画一段细竖条，高度按该条文本长度略作起伏（长的更高，看得出信息密度）
  let lastPage: number | null = null
  const pageMarks: Array<{ page: number; x: number }> = []
  for (const cue of props.cues) {
    // 跨分P 阅读时，时间轴是各分P 首尾相接的（每 P 的时间都从 0 开始）。
    // 不标出分界的话，用户根本不知道拖到的这段属于哪一 P —— 而切片结果完全取决于这个。
    if (cue.page !== lastPage) {
      pageMarks.push({ page: cue.page, x: px(cue.start) })
      lastPage = cue.page
    }
    const x = px(cue.start)
    const x2 = Math.max(x + 1, px(cue.end))
    const len = Math.min(40, cue.text.length)
    const barH = 8 + Math.min(14, len * 0.5)
    const on = props.selected.has(cue.index)
    ctx.fillStyle = on ? accent : muted
    ctx.globalAlpha = on ? 1 : 0.55
    ctx.fillRect(x, h / 2 - barH / 2, Math.max(1, x2 - x), barH)
  }
  ctx.globalAlpha = 1

  // 分P 分界线 + 标签
  if (pageMarks.length > 1) {
    ctx.font = '10px system-ui, sans-serif'
    ctx.textBaseline = 'bottom'
    for (const mark of pageMarks) {
      ctx.fillStyle = text
      ctx.globalAlpha = 0.35
      ctx.fillRect(mark.x, 0, 1, h)
      ctx.globalAlpha = 0.8
      ctx.fillText(`P${mark.page}`, mark.x + 3, h - 2)
    }
    ctx.globalAlpha = 1
  }

  // 刻度：按总时长挑一个"整"的间隔，画 4~8 个刻度
  const steps = [10, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const step = steps.find((s) => dur / s <= 8) ?? 3600
  ctx.fillStyle = muted
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  for (let t = 0; t <= dur; t += step) {
    const x = px(t)
    ctx.globalAlpha = 0.5
    ctx.fillRect(x, 0, 1, 6)
    ctx.globalAlpha = 1
    if (x < w - 34) ctx.fillText(formatTime(t), x + 3, 2)
  }

  // 播放进度
  if (props.playPosition && props.playPosition > 0) {
    const x = px(props.playPosition)
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.35
    ctx.fillRect(0, 0, x, h)
    ctx.globalAlpha = 1
    ctx.fillRect(x, 0, 1.5, h)
  }

  // 拖选中的区间
  if (drag.value) {
    const a = Math.min(drag.value.from, drag.value.to)
    const b = Math.max(drag.value.from, drag.value.to)
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.28
    ctx.fillRect(px(a), 0, Math.max(1, px(b) - px(a)), h)
    ctx.globalAlpha = 1
  }

  // 光标位置
  const c = cursorCue.value
  if (c) {
    const x = px(c.start)
    ctx.fillStyle = text
    ctx.globalAlpha = 0.75
    ctx.fillRect(x - 0.5, 0, 1, h)
    ctx.globalAlpha = 1
  }
}

/* -------------------------------- 指针交互 ------------------------------- */

const DRAG_THRESHOLD_PX = 4

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  const el = canvasEl.value
  if (!el) return
  el.setPointerCapture(e.pointerId)
  pointerId = e.pointerId
  startPx = e.clientX
  dragged.value = false
  const sec = toSecond(e.clientX)
  drag.value = { from: sec, to: sec }
}

function onPointerMove(e: PointerEvent): void {
  if (pointerId !== e.pointerId || !drag.value) return
  if (!dragged.value && Math.abs(e.clientX - startPx) < DRAG_THRESHOLD_PX) return
  dragged.value = true
  const sec = toSecond(e.clientX)
  drag.value = { from: drag.value.from, to: sec }
  emit('scrub', { from: drag.value.from, to: sec })
  draw()
}

function onPointerUp(e: PointerEvent): void {
  if (pointerId !== e.pointerId) return
  const el = canvasEl.value
  el?.releasePointerCapture(e.pointerId)
  pointerId = null
  const current = drag.value
  drag.value = null
  emit('scrub', null)
  if (!current) return

  if (dragged.value) {
    // 拖选：把区间内的字幕交给上层（由它决定替换还是追加）
    const indexes = cueIndexesInRange(props.cues, current.from, current.to)
    emit('select', { indexes, additive: e.shiftKey })
  } else {
    // 单击：定位到那一刻的字幕
    const index = cueIndexAtTime(props.cues, current.from)
    if (index != null) emit('seek', { index, second: current.from })
  }
  draw()
}

function onPointerCancel(): void {
  pointerId = null
  drag.value = null
  emit('scrub', null)
  draw()
}

/* -------------------------------- 生命周期 ------------------------------- */

let ro: ResizeObserver | null = null

onMounted(() => {
  draw()
  const el = wrapEl.value
  if (el) {
    ro = new ResizeObserver(() => {
      width.value = el.clientWidth
      draw()
    })
    ro.observe(el)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
})

// 选择 / 光标 / 播放位置 / 字幕变化都要重绘
watch(
  () => [props.selected, props.cursor, props.playPosition, props.cues] as const,
  () => draw(),
  { deep: true }
)
watch(totalDuration, () => draw())

const dragHint = computed(() => {
  if (!drag.value) return ''
  const a = Math.min(drag.value.from, drag.value.to)
  const b = Math.max(drag.value.from, drag.value.to)
  const n = cueIndexesInRange(props.cues, a, b).length
  return `${formatTime(a)} → ${formatTime(b)} · ${n} 条`
})
</script>

<template>
  <div ref="wrapEl" class="timeline" role="group" aria-label="时间轴">
    <canvas
      ref="canvasEl"
      class="timeline-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    ></canvas>
    <div v-if="dragHint" class="timeline-hint">{{ dragHint }}</div>
    <div v-else class="timeline-tip">拖动选择一段 → 范围内的字幕会被勾选；Shift 拖动 = 追加；单击 = 跳到那一刻</div>
  </div>
</template>

<style scoped>
.timeline {
  position: relative;
  height: 44px;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--hairline);
  background: var(--bg);
  cursor: crosshair;
  user-select: none;
  touch-action: none;
}

.timeline-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.timeline-hint,
.timeline-tip {
  position: absolute;
  right: 8px;
  bottom: 2px;
  font-size: 11px;
  color: var(--text-dim);
  pointer-events: none;
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  border-radius: 4px;
  padding: 0 4px;
}

.timeline-hint {
  color: var(--accent);
}
</style>
