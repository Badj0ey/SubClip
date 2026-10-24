<script setup lang="ts">
/** The right pane only edits the current selection; execution lives in ClipJobsView. */
import { computed, ref, watch } from 'vue'
import { formatTime } from '@shared/time'
import { rangeDuration, totalDuration } from '@shared/ranges'
import { useAiStore } from '../stores/ai'
import { useTagsStore } from '../stores/tags'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'
import { enqueueCurrentRanges, exportSlice, openSliceOutput, ranges, state } from '../store'
import AiPanel from './AiPanel.vue'
import UiIcon from './UiIcon.vue'

const ai = useAiStore()
const tags = useTagsStore()
const subtitle = useSubtitleStore()
const ui = useUiStore()
const notePrefix = ref('')

const currentTitle = computed(() => subtitle.video?.title ?? '')
const currentBvid = computed(() => subtitle.video?.bvid ?? '')
const currentPage = computed(() => subtitle.doc?.page ?? 1)
const duration = computed(() => totalDuration(ranges.value))
const aiTarget = computed(() => subtitle.doc ? {
  type: 'video' as const,
  id: subtitle.doc.videoId,
  title: currentTitle.value || subtitle.doc.label
} : null)

watch(currentTitle, (title) => { notePrefix.value = title.slice(0, 40) }, { immediate: true })
watch(() => subtitle.doc?.videoId, (id) => {
  ai.clearTagSuggestions()
  if (id != null) void ai.loadCachedSummary('video', id)
  else ai.summary = ''
}, { immediate: true })

async function onAiSummary(): Promise<void> {
  if (!aiTarget.value) { ui.showToast('请先打开一个字幕文档', 'error'); return }
  await ai.summarize('video', aiTarget.value.id, aiTarget.value.title)
}
async function onAiTags(): Promise<void> {
  if (!aiTarget.value) { ui.showToast('请先打开一个字幕文档', 'error'); return }
  await ai.suggestTags('video', aiTarget.value.id, aiTarget.value.title)
}
async function applyTagSuggestions(names: string[]): Promise<void> {
  const video = subtitle.video
  if (!video) return
  const ids: number[] = []
  for (const name of names) {
    const id = await tags.create(name)
    if (id) ids.push(id)
  }
  if (ids.length) await tags.addToVideos([video.id], ids)
  ai.clearTagSuggestions()
}
function normalizeGap(): void {
  const value = Number(state.maxGap)
  state.maxGap = Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : 0
}
async function onEnqueue(): Promise<void> {
  await enqueueCurrentRanges(notePrefix.value.trim() || undefined)
}
</script>

<template>
  <aside class="pane pane-right clip-assistant" role="complementary" aria-label="剪辑助手">
    <header class="pane-head">
      <strong>剪辑助手</strong>
      <span class="grow"></span>
      <span class="assistant-count">{{ state.clips.length }} 个已保存片段</span>
    </header>
    <div class="pane-body">
      <AiPanel @summary="onAiSummary" @tags="onAiTags" @apply-tags="applyTagSuggestions" />

      <section class="seg">
        <div class="seg-title"><UiIcon name="file-text" :size="14" /> 当前字幕</div>
        <div v-if="subtitle.doc" class="source-card">
          <strong>{{ currentTitle || '本地字幕' }}</strong>
          <span>{{ currentBvid ? `${currentBvid} · P${currentPage} · ` : '' }}{{ subtitle.doc.label }}</span>
        </div>
        <div v-else class="assistant-empty">从左侧素材库打开字幕，开始选择精彩片段。</div>
      </section>

      <section class="seg">
        <div class="seg-title">
          <UiIcon name="scissors" :size="14" /> 已选时间范围
          <span class="grow"></span>
          <span class="range-count">{{ ranges.length }} 段 · {{ duration.toFixed(1) }} 秒</span>
        </div>
        <label class="gap-setting">
          <span>相邻字幕合并间隔</span>
          <span class="grow"></span>
          <input v-model.number="state.maxGap" class="input" type="number" min="0" max="10" step="0.1"
            aria-label="合并间隔（秒）" @change="normalizeGap" />
          <span>秒</span>
        </label>
        <div v-if="!ranges.length" class="assistant-empty ranges-empty">
          <UiIcon name="layers" :size="23" />
          <strong>还没有选中片段</strong>
          <span>勾选字幕行，或在时间轴上拖选，即可自动生成切片范围。</span>
        </div>
        <div v-else class="range-list">
          <div v-for="(range, index) in ranges" :key="index" class="range-card">
            <span class="range-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <div class="range-info">
              <template v-if="range.crossPage && range.segments">
                <span v-for="segment in range.segments" :key="segment.page" class="range-time">
                  P{{ segment.page }} · {{ formatTime(segment.start) }} → {{ formatTime(segment.end) }}
                </span>
              </template>
              <span v-else class="range-time">{{ formatTime(range.start) }} → {{ formatTime(range.end) }}</span>
              <small>{{ range.cueIndexes.length }} 条字幕 · {{ rangeDuration(range).toFixed(1) }} 秒</small>
            </div>
            <span v-if="range.crossPage" class="cross-page">跨P</span>
          </div>
        </div>
      </section>

      <section class="seg">
        <div class="seg-title"><UiIcon name="file-text" :size="14" /> 输出文件名前缀</div>
        <input v-model="notePrefix" class="input assistant-note" maxlength="120" placeholder="例如：视频标题-精彩片段" aria-label="切片备注前缀" />
        <button class="btn primary enqueue-button" type="button" :disabled="!ranges.length" @click="onEnqueue">
          <UiIcon name="queue" :size="17" /> 加入剪辑任务 <span v-if="ranges.length">({{ ranges.length }})</span>
          <UiIcon name="arrow-right" :size="16" />
        </button>
        <p class="assistant-hint">保存的片段可在「片段库」管理，输出进度请到「剪辑任务」查看。</p>
      </section>
    </div>
    <footer class="footer-actions">
      <button class="btn" type="button" :disabled="!state.clips.length" @click="exportSlice('xlsx')"><UiIcon name="download" :size="16" /> 导出切片表</button>
      <span class="grow"></span>
      <button class="btn icon" type="button" title="打开切片输出目录" aria-label="打开切片输出目录" @click="openSliceOutput"><UiIcon name="folder" :size="18" /></button>
    </footer>
  </aside>
</template>

<style scoped>
.assistant-count { font-size: 11px; color: var(--text-dim); }
.source-card { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 10px; background: var(--panel-2); }
.source-card strong { font-size: 12px; line-height: 1.6; word-break: break-word; }
.source-card > span { color: var(--text-dim); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.assistant-empty { padding: 18px 12px; color: var(--text-dim); font-size: 12px; line-height: 1.8; }
.gap-setting { display: flex; align-items: center; gap: 7px; margin: 12px 0; color: var(--text-dim); font-size: 11px; }
.gap-setting .input { width: 66px; height: 29px; padding: 0 7px; text-align: center; font-variant-numeric: tabular-nums; }
.range-count { font-size: 11px; font-weight: 500; letter-spacing: 0; }
.ranges-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px 18px; border: 1px dashed var(--border-strong); border-radius: 12px; text-align: center; }
.ranges-empty svg { color: var(--accent); opacity: .65; }.ranges-empty strong { color: var(--text); font-size: 12px; }
.range-list { display: flex; flex-direction: column; gap: 7px; max-height: 280px; overflow: auto; }
.range-card { display: flex; align-items: flex-start; gap: 10px; padding: 11px 10px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--panel-2); }
.range-number { display: grid; place-items: center; width: 26px; height: 26px; flex: 0 0 26px; border-radius: 7px; background: var(--accent-soft); color: var(--accent); font-size: 10px; font-weight: 800; font-variant-numeric: tabular-nums; }
.range-info { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.range-time { font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.range-info small { color: var(--text-dim); font-size: 10px; }
.cross-page { padding: 3px 6px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-size: 10px; white-space: nowrap; }
.assistant-note { width: 100%; }
.enqueue-button { width: 100%; height: 40px; margin-top: 10px; gap: 9px; }
.enqueue-button > svg:last-child { margin-left: auto; }
.assistant-hint { margin: 10px 0 0; color: var(--text-dim); font-size: 10.5px; line-height: 1.75; }
</style>
