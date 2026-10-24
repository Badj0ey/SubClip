<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { formatTime } from '@shared/time'
import { rangeDuration, totalDuration } from '@shared/ranges'
import { useClipStore } from '../stores/clip'
import { useAiStore } from '../stores/ai'
import { useTagsStore } from '../stores/tags'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'
import AiPanel from './AiPanel.vue'
import {
  cancelSlice,
  clearSliceHistory,
  enqueueCurrentRanges,
  exportClipsJson,
  exportSlice,
  importClipsJson,
  loadClips,
  moveClip,
  openSliceOutput,
  ranges,
  renameClip,
  renameClipName,
  retryFailedSlices,
  startSlice,
  state,
  toast
} from '../store'

/** 右侧面板分两个页签：任务列表 / 切片历史 */
const tab = ref<'tasks' | 'history'>('tasks')

/** 第三阶段：收藏片段要直接改 store（列表项上的星标） */
const clipStore = useClipStore()

/* ---------------------------- AI 能力层（第六阶段） ---------------------------- */
const aiStore = useAiStore()
const tagsStore = useTagsStore()
const subtitleStore = useSubtitleStore()
const ui = useUiStore()

/** 有字幕文档在打开时才能做「摘要 / 标签建议」 */
const aiTarget = computed(() => {
  const doc = subtitleStore.doc
  const video = subtitleStore.video
  if (!doc) return null
  return {
    targetType: 'video' as const,
    targetId: doc.videoId,
    title: video?.title ?? doc.label
  }
})

async function onAiSummary(): Promise<void> {
  const t = aiTarget.value
  if (!t) {
    ui.showToast('请先打开一个字幕文档', 'error')
    return
  }
  await aiStore.summarize(t.targetType, t.targetId, t.title)
}

/** 标签建议：AI 生成 + 人审核，所以在 AiPanel 里勾选后再保存 */
async function onAiTags(): Promise<void> {
  const t = aiTarget.value
  if (!t) {
    ui.showToast('请先打开一个字幕文档', 'error')
    return
  }
  await aiStore.suggestTags(t.targetType, t.targetId, t.title)
}

/** 把审核通过的标签建议落库，并打在当前视频上 */
async function applyTagSuggestions(names: string[]): Promise<void> {
  const video = subtitleStore.video
  if (!video) return
  const ids: number[] = []
  for (const name of names) {
    const id = await tagsStore.create(name)
    if (id) ids.push(id)
  }
  await tagsStore.addToVideos([video.id], ids)
  aiStore.clearTagSuggestions()
}

// 换视频时把上一篇的摘要/建议清掉（否则会以为是当前这篇的）
watch(
  () => subtitleStore.doc?.videoId,
  (id) => {
    aiStore.clearTagSuggestions()
    if (id != null) void aiStore.loadCachedSummary('video', id)
    else aiStore.summary = ''
  },
  { immediate: true }
)

const failedCount = computed(() => state.sliceHistory.filter((h) => h.status !== 'ok').length)
const okCount = computed(() => state.sliceHistory.filter((h) => h.status === 'ok').length)

/* ------------------------------ 任务：重命名 ------------------------------ */

const editingId = ref<number | null>(null)
const editingNote = ref('')
const noteEl = ref<HTMLInputElement | null>(null)

async function startRenameClip(id: number, name: string): Promise<void> {
  editingId.value = id
  editingNote.value = name
  await nextTick()
  noteEl.value?.focus()
  noteEl.value?.select()
}

/** 提交改名：改的是「片段名称」，输出文件名（note）不受影响 */
async function commitRenameClip(): Promise<void> {
  const id = editingId.value
  if (id == null) return
  const name = editingNote.value.trim()
  editingId.value = null
  if (!name) return
  await renameClipName(id, name)
}

/* ---------------------------- 任务：排序与导入导出 ---------------------------- */

/*
 * 3.7.0 瘦身：这一节原有的「任务排序 / 导入 / 导出 / 智能命名 / 任务页签」
 * 全部随任务列表一起搬去「剪辑任务」页（或随任务列表一起删掉）。
 *
 * 右栏现在只负责「当前选择 → 保存片段 → 添加到任务」，
 * 所以这里只留「打开输出目录」这类与当前面板直接相关的小动作。
 */

async function onOpenOutput(): Promise<void> {
  await openSliceOutput()
}

const notePrefix = ref('')

const currentVideoTitle = computed(() => state.video?.title ?? '')
const currentBvid = computed(() => state.video?.bvid ?? '')
const currentPage = computed(() => state.doc?.page ?? 1)

const total = computed(() => totalDuration(ranges.value))

async function onEnqueue(): Promise<void> {
  await enqueueCurrentRanges(notePrefix.value || undefined)
}

async function onExport(format: 'csv' | 'xlsx'): Promise<void> {
  await exportSlice(format)
}

/** 切片输出目录：留空则退回到「切片表输出目录」 */
const outputDir = computed(
  () => state.settings?.sliceOutputDir?.trim() || state.settings?.outputDir || ''
)

async function pickOutputDir(): Promise<void> {
  const dir = await window.api.pickDir(outputDir.value)
  if (!dir) return
  state.settings = await window.api.saveSettings({ sliceOutputDir: dir })
  toast('切片输出目录已更新', 'success')
}

// 切换视频时同步默认备注前缀
watch(currentVideoTitle, (title) => {
  notePrefix.value = title.slice(0, 40)
})
</script>

<template>
  <aside class="pane pane-right" role="complementary" aria-label="当前选择与片段">
    <div class="pane-head">
      <strong style="font-size: 13px">当前选择</strong>
      <span class="grow"></span>
      <span class="muted">{{ state.clips.length }} 个片段</span>
    </div>

    <div class="pane-body">
      <!-- AI 助手（第六阶段）：摘要 / 标签建议。未启用时只提示，不影响其它功能 -->
      <AiPanel @summary="onAiSummary" @tags="onAiTags" @apply-tags="applyTagSuggestions" />

      <!-- 当前文档信息 -->
      <div class="seg">
        <div class="seg-title">当前字幕</div>
        <div v-if="state.doc" style="font-size: 13px; line-height: 1.7">
          <div style="font-weight: 600; word-break: break-all">
            {{ currentVideoTitle || '（本地字幕）' }}
          </div>
          <div class="muted">
            <template v-if="currentBvid">
              BV：{{ currentBvid }} · 第 {{ currentPage }} P ·
            </template>
            {{ state.doc.label }}
          </div>
        </div>
        <div v-else class="muted">尚未打开字幕文档</div>
      </div>

      <!-- 时间范围 -->
      <div class="seg">
        <div class="seg-title">
          <span>时间范围（{{ ranges.length }} 段，共 {{ total.toFixed(1) }} 秒）</span>
          <span class="grow"></span>
          <label class="muted" title="相邻选中字幕间隔小于该值时合并为一段">
            合并间隔
            <input
              v-model.number="state.maxGap"
              class="input"
              type="number"
              min="0"
              max="10"
              step="0.1"
              style="width: 62px; padding: 2px 5px"
            />
            秒
          </label>
        </div>

        <div v-if="!ranges.length" class="muted" style="padding: 6px 2px">
          勾选左侧字幕条目即可生成时间坐标
        </div>

        <div
          v-for="(r, i) in ranges"
          :key="i"
          class="range-item"
        >
          <span class="idx">#{{ i + 1 }}</span>
          <span class="times">
            <template v-if="r.crossPage && r.segments">
              <div v-for="s in r.segments" :key="s.page">
                P{{ s.page }} {{ formatTime(s.start) }} → {{ formatTime(s.end) }}
              </div>
            </template>
            <template v-else>{{ formatTime(r.start) }} → {{ formatTime(r.end) }}</template>
          </span>
          <span
            v-if="r.crossPage"
            class="badge-soft"
            title="跨分P：会把各分P 的片段按顺序合成一个视频"
          >
            跨P 合成
          </span>
          <span class="muted">{{ rangeDuration(r).toFixed(1) }}s / {{ r.cueIndexes.length }}条</span>
        </div>
      </div>

      <!-- 加入任务 -->
      <div class="seg">
        <div class="seg-title">备注 / 输出文件名前缀</div>
        <input v-model="notePrefix" class="input" style="width: 100%" placeholder="例如：A-SOUL-名场面" />
        <div style="display: flex; gap: 8px; margin-top: 8px">
          <button class="btn primary grow" :disabled="!ranges.length" @click="onEnqueue">
            加入切片任务（{{ ranges.length }}）
          </button>
        </div>
      </div>

    </div>

    <!--
      3.7.0：切片执行相关的界面（切片按钮、进度、取消、输出目录、ffmpeg 提示）
      已全部搬到「剪辑任务」页。

      为什么搬：右栏的职责是「当前选择」，而执行是队列的事。
      混在一起时用户只是想保存片段，却很容易点到「本地切片」——
      实测这正是「片段与任务混淆」最容易出问题的地方。
      现在右栏只负责：看当前文档 → 调时间范围 → 命名 → 保存片段 → 添加到任务。
    -->
    <div class="footer-actions">
      <button class="btn" :disabled="!state.clips.length" @click="onExport('xlsx')">
        导出 XLSX
      </button>
      <button
        class="btn icon"
        type="button"
        title="打开切片输出目录"
        aria-label="打开切片输出目录"
        @click="onOpenOutput"
      >
        📁
      </button>
    </div>
  </aside>
</template>

<style scoped>
/* 任务排序按钮：上下箭头竖排，占位极小 */
.order-ops {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.order-ops .del {
  font-size: 9px;
  line-height: 1;
  padding: 1px 3px;
}

.order-ops .del:disabled {
  opacity: 0.25;
  cursor: default;
}

/* 备注就是输出文件名，允许双击改名 */
.note-text {
  font-size: 12px;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-text:hover {
  color: var(--accent);
}

/* 第三阶段：片段名称（主标题）+ 输出文件名（副行） */
.clip-title-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.clip-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip-name:hover {
  color: var(--accent);
}

.note-hint {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.badge-err {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 15%, transparent);
}

.out-path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.out-path span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.err-msg {
  margin-top: 2px;
  font-size: 12px;
  color: var(--danger);
  word-break: break-all;
}

.slice-progress {
  padding: 10px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--panel-2);
}

.progress-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}

.progress-inner {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.25s var(--ease);
}

.slice-progress-text {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}

.slice-progress-text .muted {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slice-warn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-soft);
  border-top: 1px solid var(--warn-border);
}

.slice-out {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--panel-2);
}

.slice-out .input {
  font-size: 12px;
}
</style>

<style scoped>
.badge-soft {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  white-space: nowrap;
  flex: 0 0 auto;
}
</style>
