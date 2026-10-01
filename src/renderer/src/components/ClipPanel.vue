<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { formatTime } from '@shared/time'
import { rangeDuration, totalDuration } from '@shared/ranges'
import {
  cancelSlice,
  enqueueCurrentRanges,
  exportSlice,
  loadClips,
  openSliceOutput,
  ranges,
  startSlice,
  state,
  toast
} from '../store'

const PHASE_TEXT: Record<string, string> = {
  resolve: '解析',
  download: '下载',
  cut: '裁剪',
  done: '完成',
  error: '失败'
}

const slicePhase = computed(() => PHASE_TEXT[state.sliceProgress?.phase ?? ''] ?? '')

async function onSlice(): Promise<void> {
  await startSlice()
}

async function onCancelSlice(): Promise<void> {
  await cancelSlice()
}

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

async function onDeleteClip(id: number): Promise<void> {
  state.clips = await window.api.deleteClip(id)
}

async function onClearClips(): Promise<void> {
  if (!state.clips.length) return
  if (!window.confirm(`确定清空全部 ${state.clips.length} 条切片任务？`)) return
  await window.api.clearClips()
  await loadClips()
  toast('已清空切片任务', 'success')
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
  <aside class="pane pane-right">
    <div class="pane-head">
      <strong style="font-size: 13px">选择结果 / 切片任务</strong>
      <span class="grow"></span>
      <span class="muted">{{ state.clips.length }} 条任务</span>
    </div>

    <div class="pane-body">
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

      <!-- 切片任务列表 -->
      <div class="seg">
        <div class="seg-title">
          <span>切片任务列表</span>
          <span class="grow"></span>
          <button class="btn sm danger" :disabled="!state.clips.length" @click="onClearClips">
            清空
          </button>
        </div>

        <div v-if="!state.clips.length" class="muted">暂无任务</div>

        <div v-for="t in state.clips" :key="t.id" class="range-item">
          <div style="flex: 1 1 auto; min-width: 0">
            <div style="font-size: 12px; font-variant-numeric: tabular-nums">
              {{ formatTime(t.start) }} → {{ formatTime(t.end) }}
            </div>
            <div class="muted" style="word-break: break-all">
              {{ t.bvid || '（无BV号）' }} ·
              <template v-if="t.segments && t.segments.length > 1">
                <span class="badge-soft" style="margin-right: 4px">
                  跨P {{ t.segments.map((s) => `P${s.page}`).join(' + ') }}
                </span>
              </template>
              <template v-else>P{{ t.page }} ·</template>
              {{ t.note }}
            </div>
          </div>
          <button class="del" title="删除该任务" @click="onDeleteClip(t.id)">✕</button>
        </div>
      </div>
    </div>

    <!-- 切片进度 -->
    <div v-if="state.sliceRunning && state.sliceProgress" class="slice-progress">
      <div class="progress-bar">
        <div class="progress-inner" :style="{ width: `${state.sliceProgress.percent}%` }"></div>
      </div>
      <div class="slice-progress-text">
        <span class="muted">
          {{ slicePhase }} {{ state.sliceProgress.index + 1 }}/{{ state.sliceProgress.total }}
          · {{ state.sliceProgress.note }}
        </span>
        <button class="btn sm danger" @click="onCancelSlice">取消</button>
      </div>
    </div>

    <!-- ffmpeg 未就绪提示 -->
    <div v-if="!state.ffmpegReady" class="slice-warn">
      未检测到 ffmpeg，本地切片不可用。
      <button class="btn sm" @click="state.view = 'settings'">去设置</button>
    </div>

    <!-- 切片输出目录（可自定义） -->
    <div class="slice-out">
      <span class="muted">输出到</span>
      <input :value="outputDir" class="input grow" readonly :title="outputDir" />
      <button class="btn sm" @click="pickOutputDir">更改</button>
    </div>

    <div class="footer-actions">
      <button class="btn" :disabled="!state.clips.length" @click="onExport('xlsx')">
        导出 XLSX
      </button>
      <button
        class="btn primary grow"
        :disabled="!state.clips.length || state.sliceRunning || !state.ffmpegReady"
        :title="state.ffmpegReady ? '在本机直接切片' : '需要先配置 ffmpeg'"
        @click="onSlice"
      >
        {{ state.sliceRunning ? '切片中…' : `本地切片（${state.clips.length}）` }}
      </button>
      <button class="btn icon" title="打开切片输出目录" @click="onOpenOutput">📁</button>
    </div>
  </aside>
</template>

<style scoped>
.slice-progress {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
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
  border-top: 1px solid var(--border);
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
