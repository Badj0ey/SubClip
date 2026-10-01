<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Cue, MergedCue } from '@shared/types'
import { formatTime } from '@shared/time'
import { totalDuration } from '@shared/ranges'
import { useVirtualList } from '../composables/useVirtualList'
import {
  applyReadingStyle,
  clearSelection,
  editRequest,
  expandTo,
  invertSelection,
  matchedIndexes,
  ranges,
  registerScroller,
  selectAll,
  selectMatches,
  state,
  toggleSelect,
  toast
} from '../store'

/* --------------------------------- 虚拟滚动 -------------------------------- */

const listEl = ref<HTMLElement | null>(null)

const cueCount = computed(() => state.cues.length)
/** 预估行高：字号 × 行距 + 上下内边距 */
const estimateHeight = computed(() => {
  const size = state.settings?.fontSize ?? 15
  const lh = state.settings?.lineHeight ?? 1.7
  return Math.round(size * lh) + 16
})
/** 字号 / 行距 / 字体变化时丢弃全部测量结果 */
const styleKey = computed(
  () => `${state.settings?.fontSize}|${state.settings?.lineHeight}|${state.settings?.fontFamily}`
)

/** 阅读条位于列表高度的百分比位置（偏上，符合阅读习惯） */
const READ_LINE_PERCENT = 38

const viewportH = ref(0)

/**
 * 首尾留白：让第一条能上浮到阅读条、最后一条能下沉到阅读条，
 * 否则列表两端各有约一条字幕永远读不到。
 */
const extraTop = computed(() =>
  Math.max(0, Math.round((viewportH.value * READ_LINE_PERCENT) / 100 - estimateHeight.value / 2))
)
const extraBottom = computed(() =>
  Math.max(
    0,
    Math.round(viewportH.value * (1 - READ_LINE_PERCENT / 100) - estimateHeight.value / 2)
  )
)

const vlist = useVirtualList({
  container: listEl,
  count: cueCount,
  estimate: estimateHeight,
  overscan: 8,
  resetKey: styleKey,
  indexAttr: 'data-vindex',
  extraTop,
  extraBottom
})

const { visibleIndexes, topPad, bottomPad, startIndex, onScroll, scrollToIndexAt } = vlist

watch(
  vlist.viewportHeight,
  (h) => {
    viewportH.value = h
  },
  { immediate: true }
)

const visibleCues = computed(() =>
  visibleIndexes.value.map((i) => state.cues[i]).filter((c): c is MergedCue => Boolean(c))
)

/* --------------------------------- 阅读条 --------------------------------- */
const readLineIndex = ref<number | null>(null)
const readLineEnabled = computed(() => state.settings?.readLine !== false)

let rafRead = 0

function scheduleReadLine(): void {
  if (rafRead) return
  rafRead = requestAnimationFrame(() => {
    rafRead = 0
    updateReadLine()
  })
}

/** 找出最接近阅读条的那一行，用于放大突出 */
function updateReadLine(): void {
  const el = listEl.value
  if (!el || !readLineEnabled.value) {
    readLineIndex.value = null
    return
  }
  const rect = el.getBoundingClientRect()
  const lineY = rect.top + (el.clientHeight * READ_LINE_PERCENT) / 100
  let best: number | null = null
  let bestDist = Infinity
  for (const row of el.querySelectorAll<HTMLElement>('[data-cue]')) {
    const r = row.getBoundingClientRect()
    const d = Math.abs(r.top + r.height / 2 - lineY)
    if (d < bestDist) {
      bestDist = d
      best = Number(row.dataset.cue)
    }
  }
  readLineIndex.value = best
  syncActiveDocFromReadLine()
}

/**
 * 阅读条落到另一分P 时，把左侧工作区的高亮切过去。
 * 只在跨分P 时才动，且顺带展开该分P 的祖先，保证高亮看得见。
 */
function syncActiveDocFromReadLine(): void {
  const idx = readLineIndex.value
  if (idx == null || !state.cues.length) return
  // 合并列表的 index 是从 1 开始的连续编号，可以直接按下标取
  const cue = state.cues[idx - 1]
  if (!cue || cue.index !== idx) return

  const key = `doc:${cue.docId}`
  if (state.activeKey === key) return
  state.activeKey = key
  expandTo(key)
}

function onListScroll(): void {
  onScroll()
  scheduleReadLine()
}

/* -------------------------------- 按行滚动 -------------------------------- */
/**
 * 一次滚轮 = 移动一条字幕。
 * 做法是拦截 wheel，把「阅读条上的那一行」按方向推进一行，
 * 并把它对齐回阅读条位置；滚动条总长度不变，只是步长变成一行。
 */
let wheelTarget = -1
let wheelTimer: number | undefined

function onWheel(e: WheelEvent): void {
  const el = listEl.value
  if (!el || !readLineEnabled.value || !state.cues.length) return
  if (e.ctrlKey || e.metaKey) return // 交给系统缩放等行为

  const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0
  if (!dir) return
  e.preventDefault()

  // 连续滚动时以上一次的目标为基准，避免平滑动画未结束就重复计算
  if (wheelTarget < 0) {
    const cur = readLineIndex.value
    const idx = cur == null ? -1 : state.cues.findIndex((c) => c.index === cur)
    wheelTarget = idx < 0 ? (dir > 0 ? -1 : state.cues.length) : idx
  }

  const next = Math.min(state.cues.length - 1, Math.max(0, wheelTarget + dir))
  if (next === wheelTarget) return
  wheelTarget = next

  scrollToIndexAt(next, READ_LINE_PERCENT / 100, 'smooth')

  if (wheelTimer) window.clearTimeout(wheelTimer)
  wheelTimer = window.setTimeout(() => {
    wheelTarget = -1
  }, 240)
}

watch(visibleCues, () => scheduleReadLine(), { flush: 'post' })
watch(readLineEnabled, () => scheduleReadLine())

onMounted(() => {
  vlist.attach()
  registerScroller((index) => {
    const i = state.cues.findIndex((c) => c.index === index)
    if (i >= 0) scrollToIndexAt(i, 0.5, 'smooth')
  })
  listEl.value?.addEventListener('wheel', onWheel, { passive: false })
  scheduleReadLine()
})

onUnmounted(() => {
  registerScroller(null)
  if (rafRead) cancelAnimationFrame(rafRead)
  if (wheelTimer) window.clearTimeout(wheelTimer)
  listEl.value?.removeEventListener('wheel', onWheel)
})

/* ---------------------------------- 搜索 ---------------------------------- */

const kw = computed({
  get: () => state.keyword,
  set: (v: string) => (state.keyword = v)
})

const matchCount = computed(() => matchedIndexes.value.length)
const matchPosition = computed(() => {
  const i = matchedIndexes.value.indexOf(state.cursor)
  return i === -1 ? '–' : String(i + 1)
})

function segments(text: string): Array<{ t: string; m: boolean }> {
  const k = state.keyword.trim().toLowerCase()
  if (!k) return [{ t: text, m: false }]
  const lower = text.toLowerCase()
  const out: Array<{ t: string; m: boolean }> = []
  let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(k, i)
    if (idx === -1) {
      out.push({ t: text.slice(i), m: false })
      break
    }
    if (idx > i) out.push({ t: text.slice(i, idx), m: false })
    out.push({ t: text.slice(idx, idx + k.length), m: true })
    i = idx + k.length
  }
  return out.length ? out : [{ t: text, m: false }]
}

function isChecked(cue: Cue): boolean {
  return state.selected.has(cue.index)
}

/* ------------------------------- 分P 分界提示 ------------------------------ */

/** 是否为某个分P 的第一条（用于在阅读区插入醒目的分P 提示） */
function isPageStart(globalIndex: number): boolean {
  if (globalIndex <= 0) return state.cues.length > 0 && state.docs.length > 1
  const cur = state.cues[globalIndex]
  const prev = state.cues[globalIndex - 1]
  return Boolean(cur && prev && cur.page !== prev.page)
}

function pageLabel(page: number): string {
  const doc = state.docs.find((d) => d.page === page)
  const title = (doc?.label ?? '').replace(/^[^·]*·\s*/, '').replace(/\.(srt|txt|vtt|ass|lrc)$/i, '')
  return title && title !== doc?.label ? `P${page} · ${title}` : `第 ${page} P`
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/**
 * 精确滚动到某一行，使其与阅读条重合。
 * 目标行可能尚未渲染（行高是实测的），所以先粗定位让它进入渲染范围，
 * 等测量完成后按真实高度再校正一次 —— 否则会停在偏上/偏下的位置。
 */
async function scrollToIndexAccurate(
  index: number,
  behavior: ScrollBehavior = 'smooth'
): Promise<void> {
  if (index < 0) return
  const ratio = READ_LINE_PERCENT / 100
  scrollToIndexAt(index, ratio, 'auto')
  await nextTick()
  await nextFrame()
  await nextFrame()
  scrollToIndexAt(index, ratio, behavior)
}

function scrollToCue(index: number): void {
  const i = state.cues.findIndex((c) => c.index === index)
  void scrollToIndexAccurate(i, 'smooth')
}

/** 打开某个分P 后，把它在本列表中的第一条字幕对齐到阅读条 */
watch(
  () => state.focusNonce,
  () => {
    const docId = state.focusDocId
    if (docId == null || !state.cues.length) return
    const idx = state.cues.findIndex((c) => c.docId === docId)
    if (idx < 0) return
    state.cursor = state.cues[idx].index
    void (async () => {
      await nextTick()
      vlist.refresh()
      await scrollToIndexAccurate(idx, 'auto')
    })()
  },
  { flush: 'post' }
)

function gotoMatch(dir: 1 | -1): void {
  const list = matchedIndexes.value
  if (!list.length) return
  let target: number
  if (dir === 1) {
    const cur = list.findIndex((i) => i > state.cursor)
    target = cur === -1 ? list[0] : list[cur]
  } else {
    const before = list.filter((i) => i < state.cursor)
    target = before.length ? before[before.length - 1] : list[list.length - 1]
  }
  state.cursor = target
  scrollToCue(target)
}

/* --------------------------------- 正文编辑 -------------------------------- */

const editingIndex = ref<number | null>(null)
const editingText = ref('')
const editEl = ref<HTMLTextAreaElement | null>(null)
let cancelling = false
let busy = false

/**
 * 把修改写回来源文档。
 * 多P 合并阅读时界面上的序号是全局的，必须用 cue 自带的 docId / origIndex 精确定位。
 * 另外：reactive 代理无法被 IPC 结构化克隆，只传朴素值。
 */
async function persist(cue: MergedCue): Promise<boolean> {
  if (busy) return false
  busy = true
  try {
    const ok = await window.api.updateMergedCue(cue.docId, cue.origIndex, cue.text)
    return ok !== false
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error', 4200)
    return false
  } finally {
    busy = false
  }
}

async function startEdit(cue: Cue): Promise<void> {
  if (editingIndex.value === cue.index) return
  // 正在编辑另一条时先提交，避免内容丢失
  if (editingIndex.value !== null) await commitEdit()

  cancelling = false
  editingIndex.value = cue.index
  editingText.value = cue.text
  scrollToCue(cue.index)
  await nextTick()
  editEl.value?.focus()
  editEl.value?.setSelectionRange(editingText.value.length, editingText.value.length)
}

async function commitEdit(): Promise<void> {
  if (cancelling) {
    cancelling = false
    return
  }
  const idx = editingIndex.value
  if (idx === null) return
  editingIndex.value = null

  const cue = state.cues.find((c) => c.index === idx)
  if (!cue) return

  const next = editingText.value.replace(/\s+$/, '')
  if (next === cue.text) return
  if (!next.trim()) {
    toast('字幕正文不能为空，已放弃修改', 'error', 3200)
    return
  }

  cue.text = next
  // 文本长度变化会影响行高，重新测量
  vlist.reset()
  const ok = await persist(cue)
  toast(
    ok ? `已保存第 ${idx} 条` : `第 ${idx} 条保存失败（仅本地生效）`,
    ok ? 'success' : 'error',
    ok ? 1600 : 4200
  )
}

function cancelEdit(): void {
  cancelling = true
  editingIndex.value = null
}

async function toggleReadLine(): Promise<void> {
  if (!state.settings) return
  state.settings = await window.api.saveSettings({ readLine: !readLineEnabled.value })
  scheduleReadLine()
}

async function changeFont(delta: number): Promise<void> {
  if (!state.settings) return
  const size = Math.min(30, Math.max(11, state.settings.fontSize + delta))
  state.settings = await window.api.saveSettings({ fontSize: size })
  applyReadingStyle()
}

function onRowClick(cue: Cue, e: MouseEvent): void {
  if (editingIndex.value !== null) return
  toggleSelect(cue.index, e.shiftKey)
}

function onRowDblClick(cue: Cue, e: MouseEvent): void {
  e.preventDefault()
  void startEdit(cue)
}

// 换文档时退出编辑态
watch(
  () => state.doc?.id,
  () => {
    editingIndex.value = null
    cancelling = false
  }
)

// 快捷键请求编辑当前行
watch(editRequest, () => {
  const cue = state.cues.find((c) => c.index === state.cursor)
  if (cue) void startEdit(cue)
})

const totalSeconds = computed(() => totalDuration(ranges.value))
</script>

<template>
  <section class="pane pane-center">
    <div class="sub-toolbar">
      <input
        id="search-input"
        v-model="kw"
        class="input"
        style="width: 210px"
        type="search"
        placeholder="搜索字幕文本"
      />
      <span class="muted" style="min-width: 58px">
        {{ matchCount ? `${matchPosition} / ${matchCount}` : '无匹配' }}
      </span>
      <button class="btn sm" :disabled="!matchCount" title="上一处" @click="gotoMatch(-1)">↑</button>
      <button class="btn sm" :disabled="!matchCount" title="下一处" @click="gotoMatch(1)">↓</button>
      <button class="btn sm" :disabled="!matchCount" title="选中全部匹配项" @click="selectMatches">
        选中匹配
      </button>

      <span class="divider-v"></span>

      <button class="btn sm" title="选中全部字幕" @click="selectAll">全选</button>
      <button class="btn sm" title="反选" @click="invertSelection">反选</button>
      <button class="btn sm" title="清除选择" @click="clearSelection">清除</button>

      <span class="grow"></span>

      <button
        class="btn sm"
        :class="{ primary: readLineEnabled }"
        title="阅读条：滚动时放大突出屏幕偏上位置的那一条字幕"
        @click="toggleReadLine"
      >
        阅读条
      </button>
      <button class="btn sm" title="减小字号" @click="changeFont(-1)">A−</button>
      <button class="btn sm" title="增大字号" @click="changeFont(1)">A+</button>
    </div>

    <div v-if="!state.cues.length" class="empty pane-body">
      <div class="empty-art">📄</div>
      <template v-if="state.doc">该字幕文档没有内容</template>
      <template v-else>
        从左侧资源树选择一个字幕文档<br />
        或先导入 SRT / 拉取 B 站字幕
      </template>
    </div>

    <div v-else class="cue-wrap">
      <div
        v-if="readLineEnabled"
        class="read-marker"
        :style="{ top: `${READ_LINE_PERCENT}%` }"
      ></div>

      <div ref="listEl" class="cue-list" @scroll.passive="onListScroll">
        <div :style="{ height: `${topPad}px` }"></div>

      <div
        v-for="(cue, vi) in visibleCues"
        :key="cue.index"
        :data-vindex="startIndex + vi"
        :data-cue="cue.index"
        class="cue"
        :class="{
          checked: isChecked(cue),
          cursor: state.cursor === cue.index,
          'read-line': readLineIndex === cue.index,
          'page-start': isPageStart(startIndex + vi)
        }"
        :data-page="isPageStart(startIndex + vi) ? pageLabel(cue.page) : null"
        @click="onRowClick(cue, $event)"
        @dblclick="onRowDblClick(cue, $event)"
      >
        <input
          type="checkbox"
          :checked="isChecked(cue)"
          @click.stop="onRowClick(cue, $event)"
        />
        <span class="num">{{ cue.index }}</span>
        <span class="times">
          {{ formatTime(cue.start) }}<br />{{ formatTime(cue.end) }}
        </span>

        <textarea
          v-if="editingIndex === cue.index"
          ref="editEl"
          v-model="editingText"
          class="cue-editor"
          spellcheck="false"
          @click.stop
          @dblclick.stop
          @keydown.enter.exact.prevent="commitEdit"
          @keydown.enter.shift.stop
          @keydown.esc.prevent="cancelEdit"
          @blur="commitEdit"
        ></textarea>

        <span v-else class="text">
          <template v-for="(seg, i) in segments(cue.text)" :key="i">
            <mark v-if="seg.m">{{ seg.t }}</mark>
            <template v-else>{{ seg.t }}</template>
          </template>
        </span>

        <button
          v-if="editingIndex !== cue.index"
          class="row-op"
          title="编辑正文（双击行也可）"
          @click.stop="startEdit(cue)"
        >
          ✎
        </button>
      </div>

        <div :style="{ height: `${bottomPad}px` }"></div>
      </div>
    </div>

    <div v-if="state.cues.length" class="status-bar">
      <span>共 {{ state.cues.length }} 条</span>
      <span class="divider-v"></span>
      <span>已选 {{ state.selected.size }} 条</span>
      <span class="divider-v"></span>
      <span>{{ ranges.length }} 段 · {{ totalSeconds.toFixed(1) }} 秒</span>
      <span class="grow"></span>
      <span v-if="matchCount">匹配 {{ matchCount }} 处</span>
      <span class="divider-v" v-if="matchCount"></span>
      <span>{{ state.doc?.label }}</span>
    </div>
  </section>
</template>

<style scoped>
/* 列表外层：用于固定阅读条（绝对定位不能放在滚动容器里，否则会跟着滚） */
.cue-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.cue-list {
  height: 100%;
  overflow: auto;
  padding: 4px 0 28px;
}

/* -------------------------------- 阅读条 -------------------------------- */
.read-marker {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dashed var(--accent);
  opacity: 0.4;
  pointer-events: none;
  z-index: 3;
}

.cue.read-line {
  background: linear-gradient(90deg, var(--accent-soft) 0%, transparent 76%);
}

/* 用 scale + text-stroke 做“放大加粗”，避免改变 font-weight 引起的重排 */
.cue.read-line .text {
  display: inline-block;
  transform: scale(1.075);
  transform-origin: left center;
  color: var(--accent);
  -webkit-text-stroke: 0.4px currentColor;
}

.divider-v {
  width: 1px;
  height: 16px;
  background: var(--border);
  flex: 0 0 auto;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  font-size: 11px;
  color: var(--text-dim);
  border-top: 1px solid var(--border);
  background: var(--panel);
  flex: 0 0 auto;
  white-space: nowrap;
  overflow: hidden;
}

.status-bar > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-art {
  font-size: 36px;
  opacity: 0.3;
  margin-bottom: 8px;
}

.cue-editor {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 48px;
  padding: 6px 8px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--text);
  font-family: inherit;
  font-size: inherit;
  line-height: var(--line-height, 1.7);
  resize: vertical;
  outline: none;
  user-select: text;
}

.row-op {
  flex: 0 0 auto;
  align-self: flex-start;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
  font-size: 12px;
  line-height: 1;
}

.cue:hover .row-op {
  opacity: 1;
}

.row-op:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>

<style scoped>
/* 分P 分界：在阅读区给出明显但不打断阅读的提示 */
.cue.page-start {
  margin-top: 12px;
  border-top: 1px solid var(--accent);
  opacity: 1;
  padding-top: 26px;
  position: relative;
}

.cue.page-start::before {
  content: attr(data-page);
  position: absolute;
  top: 6px;
  left: 14px;
  font-size: 11px;
  line-height: 18px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  letter-spacing: 0.02em;
  pointer-events: none;
  max-width: calc(100% - 40px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
