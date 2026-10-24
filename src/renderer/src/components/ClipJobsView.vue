<script setup lang="ts">
/**
 * 剪辑任务（3.5.0 新增一级页面）。
 *
 * ## 为什么要有这一页
 *
 * 原来「待执行的任务队列」「切片历史」「失败重试」「切片进度」全塞在
 * 右侧那个「选择结果 / 切片任务」面板里，与「当前选择」挤在一起 ——
 * 审计里点名的架构问题：**同一块区域同时承担编辑与任务管理两件事**。
 *
 * 现在按提示词拆开：
 * - 右栏（`ClipPanel`）只负责「当前选择 → 调时间 → 命名 → 保存片段 → 添加到任务」；
 * - 任务的**执行、进度、失败重试、历史**都在这一页。
 *
 * ## 三个页签
 *
 * `待处理`（片段库里等着输出的）→ `进行中`（正在跑）→ `已完成`（含失败与取消）。
 * 失败不是单独一个页签，而是**已完成里的状态筛选** ——
 * 失败任务和成功任务本质是同一批历史记录的不同状态，
 * 单独开页签会让人以为它们是两类东西。
 */
import { computed, onMounted, ref } from 'vue'
import { formatTime } from '@shared/time'
import { useClipStore } from '../stores/clip'
import { useJobsStore } from '../stores/jobs'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

const jobs = useJobsStore()
const ui = useUiStore()
// `clip` / `settings` 在下方「执行切片」一节使用（切片动作与输出目录都在那边）

/**
 * 页面进入时刷新一次。
 *
 * 数据的**权威来源是 `jobs` store**（不是组件本地 ref）——
 * 这样别处（素材库加片段、切片完成）改动队列后，
 * 只要调 `jobs.load()` 就能让这一页同步，不会出现「显示的还是旧列表」。
 * 队列的增删重试都直接改 store 状态，界面跟着响应式更新。
 */
onMounted(() => {
  void jobs.load()
  // 设置里存着切片输出目录；没加载过就拉一次，否则界面上会显示「未设置」
  if (!settings.settings) void settings.load()
})

type Tab = 'pending' | 'running' | 'done'
const tab = ref<Tab>('pending')
/** 已完成页签里的状态筛选（失败单独看时用） */
const historyFilter = ref<'all' | 'ok' | 'failed'>('all')

const pendingJobs = computed(() => jobs.pending)
const runningJobs = computed(() => jobs.running)

const history = computed(() => {
  const list = jobs.finished
  if (historyFilter.value === 'all') return list
  if (historyFilter.value === 'ok') return list.filter((j) => j.state === 'done')
  return list.filter((j) => j.state === 'failed' || j.state === 'canceled')
})

const TAB_ITEMS: Array<{ key: Tab; label: string }> = [
  { key: 'pending', label: '待处理' },
  { key: 'running', label: '进行中' },
  { key: 'done', label: '已完成' }
]

function tabCount(key: Tab): number {
  if (key === 'pending') return pendingJobs.value.length
  if (key === 'running') return runningJobs.value.length
  return jobs.finished.length
}

/** 页头摘要：说明当前页签在看什么（比一串按钮更容易读懂） */
const headSummary = computed(() => {
  const map: Record<Tab, string> = {
    pending: `待输出 ${pendingJobs.value.length} 条（可调顺序）`,
    running: runningJobs.value.length ? `${runningJobs.value.length} 条正在执行` : '当前没有执行中的任务',
    done: `历史 ${jobs.finished.length} 条（成功 ${jobs.okCount}）`
  }
  return map[tab.value]
})

function statusLabel(s: string): string {
  return s === 'done'
    ? '已完成'
    : s === 'failed'
      ? '失败'
      : s === 'canceled'
        ? '已取消'
        : s === 'running'
          ? '进行中'
          : '排队中'
}

async function openOutput(path: string): Promise<void> {
  if (!path) return
  const err = await window.api.openPath(path)
  if (err) ui.showToast(`打不开：${err}`, 'error')
}

/** 失败 / 取消的任务重新排队 */
async function retry(ids: number[]): Promise<void> {
  const n = await jobs.retry(ids)
  ui.showToast(n ? `已重新排队 ${n} 条` : '没有可重试的任务', n ? 'success' : 'info')
}

/* --------------------------------- 执行切片 -------------------------------- */

const clip = useClipStore()
const settings = useSettingsStore()

/** 缺 BV 号的任务切不了，所以可用数要单独算（按钮上显示的是这个数） */
const runnableCount = computed(() => pendingJobs.value.filter((j) => Boolean(j.bvid)).length)
const canRun = computed(() => runnableCount.value > 0 && clip.ffmpegReady && !ui.sliceRunning)
const jobsLoading = computed(() => jobs.loading)

/**
 * 输出目录：用 settings store 的 `effectiveSliceOutputDir`。
 *
 * 它有「留空则退回切片表输出目录」的兜底逻辑，和实际切片落点一致 ——
 * 自己再拼一次很容易拼出与真实行为不同的路径（实测第一版就显示了「未设置」）。
 */
const outputDir = computed(() => settings.effectiveSliceOutputDir || '（未设置）')

const runHint = computed(() => {
  if (ui.sliceRunning) return '正在切片'
  if (!clip.ffmpegReady) return '需要先配置 ffmpeg（设置 → 本地切片）'
  if (!pendingJobs.value.length) return '队列为空'
  if (!runnableCount.value) return '所有任务都缺少 BV 号'
  return `开始处理队列里的 ${runnableCount.value} 条任务`
})

async function runAll(): Promise<void> {
  await clip.startSlice()
  // 状态由主进程写库，跑完要拉回最新的任务列表
  await jobs.load()
}

async function runOne(jobId: number): Promise<void> {
  await clip.startSlice([jobId])
  await jobs.load()
}

async function cancelSlice(): Promise<void> {
  await window.api.sliceCancel()
  ui.showToast('已请求取消', 'info')
}

async function pickOutputDir(): Promise<void> {
  const dir = await window.api.pickDir(settings.settings?.sliceOutputDir || undefined)
  if (dir) {
    await settings.save({ sliceOutputDir: dir })
    ui.showToast('输出目录已更新', 'success')
  }
}

/** 阶段名（主进程给的是英文枚举，界面要中文） */
function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    resolve: '解析地址',
    download: '下载片段',
    cut: '裁剪',
    mux: '合并',
    done: '完成',
    error: '出错'
  }
  return map[phase] ?? phase
}

/** 切到素材库去挑素材（待处理为空时的主要出路） */
function goLibrary(): void {
  ui.setView('library')
}
</script>

<template>
  <section class="jobs" aria-label="剪辑任务">
    <header class="view-head">
      <h2 class="view-title">剪辑任务</h2>
      <span class="view-sub muted">{{ headSummary }}</span>
      <span class="grow"></span>
      <button class="btn sm" :disabled="jobs.loading" @click="jobs.load()">刷新</button>
      <button class="btn" @click="goLibrary">去挑素材</button>
    </header>

    <nav class="stage-tabs" role="tablist" aria-label="任务状态">
      <button
        v-for="t in TAB_ITEMS"
        :key="t.key"
        type="button"
        class="stage-tab"
        :class="{ active: tab === t.key }"
        role="tab"
        :aria-selected="tab === t.key"
        @click="tab = t.key"
      >
        {{ t.label }}
        <span v-if="tabCount(t.key)" class="jobs-count">{{ tabCount(t.key) }}</span>
      </button>
    </nav>


    <!--
      执行条：切片的入口在这里（3.7.0 从右栏搬过来）。
      拆表前「本地切片」按钮在右栏，而右栏同时承担「当前选择」，
      所以用户只是想保存片段却容易误点切片；现在执行与选择彻底分开。
    -->
    <div v-if="tab === 'pending' && pendingJobs.length" class="jobs-run">
      <button
        class="btn primary"
        :disabled="!canRun || jobsLoading"
        :title="runHint"
        @click="runAll"
      >
        {{ ui.sliceRunning ? '切片中…' : `开始切片（${runnableCount}）` }}
      </button>
      <button v-if="ui.sliceRunning" class="btn danger" @click="cancelSlice">取消</button>
      <span class="muted jobs-run-out" :title="outputDir">
        输出到 {{ outputDir }}
        <button class="btn sm" @click="pickOutputDir">更改</button>
      </span>
      <span class="grow"></span>
      <!--
        清单导入 / 导出（3.7.0 从右栏搬来）。
        它操作的是**任务清单**（换机器继续切），属于任务管理，所以跟着搬到这一页。
      -->
      <button class="btn sm" title="把队列导出成 JSON（换台机器继续切）" @click="clip.exportJson()">
        导出清单
      </button>
      <button class="btn sm" title="从 JSON 追加导入任务" @click="clip.importJson()">导入清单</button>
    </div>

    <!-- 切片进度（执行中显示；数据来自主进程推送） -->
    <div v-if="ui.sliceRunning && ui.sliceProgress" class="jobs-progress">
      <div class="jobs-bar-track">
        <div class="jobs-bar-fill" :style="{ width: `${ui.sliceProgress.percent}%` }"></div>
      </div>
      <div class="muted">
        {{ phaseLabel(ui.sliceProgress.phase) }}
        {{ ui.sliceProgress.index + 1 }}/{{ ui.sliceProgress.total }} ·
        {{ ui.sliceProgress.note }} · {{ ui.sliceProgress.percent }}%
      </div>
    </div>

    <!-- 待处理 -->
    <div v-if="tab === 'pending'" class="jobs-body">
      <div v-if="!pendingJobs.length" class="jobs-empty">
        <p>还没有待处理的任务。</p>
        <p class="muted">
          到<strong>素材库</strong>打开一个字幕文档，<strong>勾选字幕</strong>后在右侧
          「当前选择」里<strong>保存片段</strong>并<strong>添加到任务</strong>。
        </p>
      </div>
      <ul v-else class="jobs-list">
        <li v-for="(j, i) in pendingJobs" :key="j.id" class="jobs-item">
          <span class="jobs-idx muted">{{ i + 1 }}</span>
          <span class="jobs-name">{{ j.note }}</span>
          <span class="muted jobs-time">
            {{ formatTime(j.start) }} → {{ formatTime(j.end) }}（{{ formatTime(Math.max(0, j.end - j.start)) }}）
          </span>
          <span v-if="!j.bvid" class="jobs-warn" title="没有 BV 号，无法在线切片">缺 BV 号</span>
          <span class="grow"></span>
          <button
            class="btn sm"
            :disabled="!j.bvid || ui.sliceRunning"
            :title="j.bvid ? '只跑这一条' : '缺少 BV 号'"
            @click="runOne(j.id)"
          >
            ▶
          </button>
          <button class="btn sm" title="上移" @click="jobs.move(j.id, -1)">↑</button>
          <button class="btn sm" title="下移" @click="jobs.move(j.id, 1)">↓</button>
        </li>
      </ul>
    </div>

    <!-- 进行中 -->
    <div v-else-if="tab === 'running'" class="jobs-body">
      <div v-if="!runningJobs.length" class="jobs-empty">
        <p class="muted">当前没有正在执行的任务。</p>
        <p v-if="ui.sliceRunning" class="muted">
          切片引擎正在跑（进度 {{ ui.sliceProgress?.percent ?? 0 }}%），稍后刷新看看。
        </p>
      </div>
      <ul v-else class="jobs-list">
        <li v-for="j in runningJobs" :key="j.id" class="jobs-item">
          <span class="jobs-status running">{{ statusLabel(j.state) }}</span>
          <span class="jobs-name">{{ j.note }}</span>
          <span class="muted jobs-time">{{ j.progress }}%</span>
        </li>
      </ul>
    </div>

    <!-- 已完成（含失败 / 取消） -->
    <div v-else class="jobs-body">
      <div class="jobs-filters">
        <button class="btn sm" :class="{ primary: historyFilter === 'all' }" @click="historyFilter = 'all'">
          全部 {{ jobs.finished.length }}
        </button>
        <button class="btn sm" :class="{ primary: historyFilter === 'ok' }" @click="historyFilter = 'ok'">
          成功 {{ jobs.finished.filter((j) => j.state === 'done').length }}
        </button>
        <button
          class="btn sm"
          :class="{ primary: historyFilter === 'failed' }"
          @click="historyFilter = 'failed'"
        >
          失败 {{ jobs.finished.filter((j) => j.state !== 'done').length }}
        </button>
        <span class="grow"></span>
        <button
          class="btn sm"
          :disabled="!jobs.finished.some((j) => j.state !== 'done')"
          title="把所有失败/取消的任务重新排队"
          @click="retry(jobs.finished.filter((j) => j.state !== 'done').map((j) => j.id))"
        >
          全部重试
        </button>
      </div>
      <div v-if="!history.length" class="jobs-empty">
        <p class="muted">还没有执行记录。</p>
      </div>
      <ul v-else class="jobs-list">
        <li v-for="j in history" :key="j.id" class="jobs-item">
          <span class="jobs-status" :class="j.state === 'done' ? 'ok' : 'error'">
            {{ statusLabel(j.state) }}
          </span>
          <span class="jobs-name">{{ j.note }}</span>
          <span class="muted jobs-time">{{ new Date(j.createdAt).toLocaleString() }}</span>
          <span v-if="j.message" class="muted jobs-msg" :title="j.message">{{ j.message }}</span>
          <span class="grow"></span>
          <button v-if="j.output" class="btn sm" @click="openOutput(j.output)">打开文件</button>
          <button v-if="j.state !== 'done'" class="btn sm" @click="retry([j.id])">重试</button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/*
 * 这一页用**设计 token**（间距/字号/高度/层级）而不是写死的像素 ——
 * 3.5.0 起新写的界面一律如此，避免又长出一套「只有这页长这样」的数值。
 */
.jobs {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
  min-height: 0;
  overflow: hidden;
  flex: 1;
}

/* 页头与页签样式见 styles.css 的 .view-head / .stage-tabs（多页面共享） */

.jobs-count {
  font-size: var(--fs-xs);
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}

.jobs-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  min-height: 0;
  overflow: auto;
  flex: 1;
}

.jobs-filters {
  display: flex;
  gap: var(--sp-2);
}

/*
 * 执行条：切片入口（3.7.0 从右栏搬来）。
 * 用独立一行而不是塞进顶栏 —— 它是这一页的**主操作**，
 * 顶栏已有导航与工具，再塞主操作会让「现在该点哪里」变得不明确。
 */
.jobs-run {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  flex-wrap: wrap;
}

.jobs-run-out {
  font-size: var(--fs-sm);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 空态：与全局 `.empty` 保持同一套观感（居中 + 留白 + 次级色）。
 * 只额外限制最大宽度 —— 这一页的指引文案比别处长，
 * 不限宽会横着拉成一行、读起来费劲。
 */
.jobs-empty {
  padding: var(--sp-8) var(--sp-5);
  text-align: center;
  max-width: 620px;
  margin: 0 auto;
  color: var(--text-dim);
  font-size: var(--fs-base);
  line-height: 2;
}

.jobs-empty p {
  margin: 0 0 var(--sp-2);
}

.jobs-empty p:last-child {
  margin-bottom: 0;
}

.jobs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.jobs-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-size: var(--fs-base);
}

.jobs-name {
  font-weight: var(--fw-medium);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jobs-time {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
}

.jobs-msg {
  font-size: var(--fs-sm);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jobs-warn {
  font-size: var(--fs-xs);
  color: var(--warn);
  border: 1px solid var(--warn-border);
  border-radius: var(--radius-xs);
  padding: 0 var(--sp-1);
}

.jobs-status {
  font-size: var(--fs-xs);
  padding: 0 var(--sp-2);
  border-radius: var(--radius-xs);
  border: 1px solid transparent;
  white-space: nowrap;
}

.jobs-status.ok {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 40%, var(--border));
}

.jobs-status.error {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
}

.jobs-status.running {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

/* 队列序号：让「顺序可以调」这件事一眼可见 */
.jobs-idx {
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  min-width: 1.5em;
  text-align: right;
}

.jobs-progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-width: 620px;
  padding: var(--sp-4);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.jobs-bar-track {
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.jobs-bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s var(--ease);
}
</style>
