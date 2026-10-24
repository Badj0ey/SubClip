<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DanmakuItem } from '@shared/types'
import { useSubtitleStore } from '../stores/subtitle'
import { useVideoStore } from '../stores/video'
import { state } from '../store'

/**
 * 弹幕参考面板（3.17.0）。
 *
 * 弹幕只是定位字幕的辅助信息：
 * - 默认折叠，**展开后才读取**，避免打开任意字幕就产生几十个网络请求；
 * - 点击弹幕只移动阅读光标，不改变勾选集合，也不把弹幕写进数据库；
 * - 只有当前分P 的播放器已经打开时才顺带跳转播放时间。
 */
const subtitles = useSubtitleStore()
const video = useVideoStore()

const expanded = ref(false)
const loading = ref(false)
const error = ref('')
const items = ref<DanmakuItem[]>([])
const warnings = ref<string[]>([])
const truncated = ref(false)
const keyword = ref('')
const pageFilter = ref(0)
const nearOnly = ref(true)
const selectedKey = ref('')
const loadedBvid = ref('')
let requestId = 0

const bvid = computed(() => subtitles.video?.bvid || '')
const pageOptions = computed(() => [...new Set(state.cues.map((c) => c.page))].sort((a, b) => a - b))
const activeCue = computed(() => state.cues.find((c) => c.index === state.cursor) ?? null)
const currentPage = computed(() => activeCue.value?.page || pageOptions.value[0] || 1)

function firstCueOfPage(page: number): (typeof state.cues)[number] | undefined {
  return state.cues.find((c) => c.page === page)
}

/** 没打开播放器时用字幕时间作为「附近」的参照，避免定位到 0 秒 */
const currentTime = computed(() => {
  const page = currentPage.value
  // 预览刚打开、还没开始播放时 position 是 0；此时用当前字幕时间更贴近用户正在看的上下文。
  if (video.session?.bvid === bvid.value && video.session?.page === page && video.position > 0.5) {
    return video.position
  }
  const cue = activeCue.value
  if (cue && cue.page === page) return cue.start
  return firstCueOfPage(page)?.start ?? 0
})

const filterPage = computed(() => pageFilter.value || currentPage.value)
/** 切到其他分P 时「附近」没有参照意义，此时不套用时间窗 */
const nearApplies = computed(() => nearOnly.value && filterPage.value === currentPage.value)

const matched = computed(() => {
  const term = keyword.value.trim().toLowerCase()
  const page = filterPage.value
  const around = currentTime.value
  const list = items.value.filter(
    (d) =>
      d.page === page &&
      (!term || d.text.toLowerCase().includes(term)) &&
      (!nearApplies.value || Math.abs(d.time - around) <= 90)
  )
  // 「附近」筛选下按离当前字幕的时间距离排序，否则 350 条上限会先塞满 0 秒附近的弹幕，
  // 真正贴近当前时间的内容反而被截掉。
  if (nearApplies.value) {
    list.sort((a, b) => Math.abs(a.time - around) - Math.abs(b.time - around) || a.time - b.time)
  }
  return list
})
const visible = computed(() => matched.value.slice(0, 350))

function clock(time: number): string {
  const t = Math.max(0, Math.floor(time))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function load(force = false): Promise<void> {
  const target = bvid.value
  if (!target) return
  const id = ++requestId
  loading.value = true
  error.value = ''
  if (force) items.value = []
  try {
    const result = await window.api.getDanmaku(target, force)
    if (id !== requestId) return
    if (!result.ok || !result.data) throw new Error(result.message || '弹幕获取失败')
    items.value = result.data.items
    warnings.value = result.data.warnings
    truncated.value = result.data.truncated
    loadedBvid.value = target
  } catch (e) {
    if (id === requestId) {
      error.value = e instanceof Error ? e.message : '弹幕获取失败'
    }
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch(
  bvid,
  () => {
    ++requestId
    items.value = []
    warnings.value = []
    truncated.value = false
    selectedKey.value = ''
    error.value = ''
    pageFilter.value = 0
    loadedBvid.value = ''
    if (expanded.value && bvid.value) void load()
  },
  { immediate: true }
)

watch(expanded, (open) => {
  if (open && bvid.value && loadedBvid.value !== bvid.value && !loading.value) void load()
})

function jump(d: DanmakuItem): void {
  selectedKey.value = `${d.page}:${d.id}`
  const candidates = state.cues.filter((c) => c.page === d.page)
  if (!candidates.length) return
  // 字幕优先：落在区间内优先，否则按最近区间边缘定位；不改变勾选集合。
  let best = candidates[0]
  let distance = Infinity
  for (const cue of candidates) {
    const delta = d.time < cue.start ? cue.start - d.time : d.time > cue.end ? d.time - cue.end : 0
    if (delta < distance) {
      best = cue
      distance = delta
    }
    if (distance === 0) break
  }
  state.cursor = best.index
  subtitles.focusDocId = best.docId
  subtitles.focusCueIndex = best.origIndex
  subtitles.focusNonce++
  // 只有已经打开对应分P预览时才跳播放时间，避免无意发起网络视频请求。
  if (video.session?.page === d.page && video.session?.bvid === bvid.value) video.seek(d.time)
}
</script>

<template>
  <section class="dm-panel" aria-label="弹幕参考">
    <div class="dm-head">
      <button type="button" class="dm-toggle" :aria-expanded="expanded" @click="expanded = !expanded">
        <span class="dm-arrow" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <strong>弹幕参考</strong>
        <span class="dm-muted">{{ items.length ? `${items.length.toLocaleString()} 条` : '辅助定位字幕' }}</span>
      </button>
      <span v-if="expanded" class="dm-muted dm-hint">点击定位，不改选区</span>
    </div>

    <div v-if="expanded" class="dm-content">
      <div class="dm-tools">
        <input
          v-model="keyword"
          type="search"
          class="dm-input"
          placeholder="筛选弹幕内容"
          aria-label="筛选弹幕内容"
        />
        <select v-model.number="pageFilter" class="dm-select" aria-label="弹幕分P">
          <option :value="0">跟随字幕分P</option>
          <option v-for="p in pageOptions" :key="p" :value="p">P{{ p }}</option>
        </select>
        <label class="dm-check">
          <input v-model="nearOnly" type="checkbox" />
          当前分P附近 ±90 秒
        </label>
        <button
          type="button"
          class="dm-refresh"
          :disabled="loading || !bvid"
          @click="load(true)"
        >
          {{ loading ? '读取中…' : '重新获取' }}
        </button>
      </div>

      <div v-if="loading" class="dm-message" role="status">正在读取弹幕，较长的视频可能需要一点时间…</div>
      <div v-else-if="error" class="dm-message dm-error" role="alert">
        {{ error }}。字幕仍可正常使用。
      </div>
      <div v-else-if="!bvid" class="dm-message">该字幕没有关联的 B 站视频。</div>
      <template v-else>
        <div v-if="truncated" class="dm-notice">
          弹幕量较大或读取时间较长，只显示了部分结果；字幕不受影响。
        </div>
        <div v-if="warnings.length" class="dm-notice">{{ warnings.slice(0, 2).join('；') }}</div>
        <div v-if="!matched.length" class="dm-message">
          {{
            items.length
              ? nearApplies
                ? '当前字幕附近没有弹幕，可关闭「附近」筛选。'
                : '当前筛选范围没有弹幕。'
              : '没有可用弹幕，可能是该视频未开放弹幕或接口暂不可用。'
          }}
        </div>
        <div v-else class="dm-list" role="list" aria-label="弹幕列表">
          <button
            v-for="d in visible"
            :key="`${d.page}:${d.id}`"
            type="button"
            class="dm-row"
            :class="{ 'dm-active': selectedKey === `${d.page}:${d.id}` }"
            :title="`P${d.page} ${clock(d.time)}，点击定位字幕`"
            @click="jump(d)"
          >
            <span class="dm-time">{{ clock(d.time) }}</span>
            <span class="dm-text">{{ d.text }}</span>
          </button>
        </div>
        <div class="dm-foot">
          <span v-if="matched.length > visible.length">
            匹配 {{ matched.length }} 条，显示前 {{ visible.length }} 条
          </span>
          <span v-else>显示 {{ visible.length }} 条</span>
          <span> · 弹幕只用于定位，不参与剪辑</span>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.dm-panel {
  flex: 0 0 auto;
  border-top: 1px solid var(--hairline);
  background: var(--panel);
  min-width: 0;
}
.dm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  gap: 8px;
}
.dm-toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 0;
  background: none;
  color: var(--text);
  cursor: pointer;
  padding: 4px;
  font: inherit;
}
.dm-arrow {
  color: var(--accent);
  font-size: 16px;
}
.dm-muted {
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.dm-content {
  padding: 0 12px 9px;
}
.dm-tools {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.dm-input,
.dm-select {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  padding: 6px 8px;
  font-size: var(--fs-sm);
  min-width: 0;
}
.dm-input {
  flex: 1 1 120px;
}
.dm-check {
  display: flex;
  gap: 5px;
  align-items: center;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.dm-refresh {
  background: var(--accent-soft);
  color: var(--accent);
  border: 0;
  border-radius: var(--radius-xs);
  padding: 7px 10px;
  cursor: pointer;
  font-size: var(--fs-sm);
}
.dm-refresh:disabled {
  opacity: 0.5;
  cursor: wait;
}
.dm-list {
  max-height: 205px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dm-row {
  display: flex;
  gap: 12px;
  align-items: baseline;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 5px;
  padding: 7px 9px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: var(--fs-sm);
}
.dm-row:hover,
.dm-active {
  background: var(--accent-soft);
}
.dm-time {
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  flex: 0 0 64px;
}
.dm-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-message,
.dm-notice {
  padding: 12px 5px;
  color: var(--text-dim);
  font-size: var(--fs-sm);
}
.dm-error {
  color: var(--danger);
}
.dm-notice {
  padding: 5px;
}
.dm-foot {
  text-align: right;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  margin-top: 5px;
}
.dm-toggle:focus-visible,
.dm-row:focus-visible,
.dm-refresh:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 720px) {
  .dm-hint {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dm-panel * {
    transition: none !important;
  }
}
</style>
