<script setup lang="ts">
/**
 * 发布素材包（第九阶段）。
 *
 * ## 它做什么
 *
 * 把「录完 / 切完」到「能发布」之间那些琐碎但每次都要做的事一次做完：
 * 套文案模板得到标题与简介、整理标签，加上切片清单、分镜表、每个片段的字幕稿，
 * 导出成一个文件夹，打开就能照着发。
 *
 * ## 为什么先做这个（而不是成片拼接）
 *
 * 成片拼接需要 ffmpeg；这一半是纯文本，不依赖任何外部程序，能完整验证。
 *
 * ## 两步走：先看再写
 *
 * 「生成」只组装数据并预览，「导出」才写盘。写文件是**不可撤销**的动作，
 * 应该让用户先看清楚要导出什么 —— 而且导出目录已存在时**不会覆盖**，
 * 会加 `-2`/`-3` 后缀（覆盖是唯一真正不可逆的操作，多留几份的代价小得多）。
 */
import { computed, onUnmounted, ref } from 'vue'
import { formatTime } from '@shared/time'
import { useClipStore } from '../stores/clip'
import { useUiStore } from '../stores/ui'
import { usePublishStore } from '../stores/publish'

const ui = useUiStore()
const clip = useClipStore()
/** 发布草稿：与「文案模板」页签共享，模板渲染结果可一键带进来 */
const publish = usePublishStore()

interface KitData {
  folder: string
  files: Array<{ path: string; content: string }>
  clipCount: number
  totalDuration: number
  missingSubtitle: number[]
}

/**
 * 标题 / 简介 / 标签直接读写共享草稿。
 *
 * 用 `computed` 的 get/set 而不是本地 ref：这样「文案模板」页签带进来的内容
 * 会立刻反映到这里的输入框，用户在任一侧改也立刻生效 —— 不需要 watch 同步，
 * 也就不会有「两边不同步」这类经典 bug。
 */
const title = computed({
  get: () => publish.title,
  set: (v: string) => {
    publish.title = v
  }
})
const description = computed({
  get: () => publish.description,
  set: (v: string) => {
    publish.description = v
  }
})
const tagText = computed({
  get: () => publish.tagText,
  set: (v: string) => {
    publish.tagText = v
  }
})
/** 被排除的片段 id（默认全选，用户勾掉不想发的） */
const excluded = ref<Set<number>>(new Set())

const data = ref<KitData | null>(null)
const busy = ref(false)
const exportedDir = ref('')

/* ------------------------------ 成片合成（第九阶段） ------------------------------ */

const composing = ref(false)
const composePercent = ref(0)
const composeMessage = ref('')
const composeOutput = ref('')
/** 订阅句柄，卸载时要退订（否则切来切去会叠加监听） */
let offProgress: (() => void) | null = null
let offDone: (() => void) | null = null

async function compose(): Promise<void> {
  if (selectedIds.value.length < 2) {
    ui.showToast('至少需要两条片段才能拼成成片', 'error')
    return
  }
  composing.value = true
  composePercent.value = 0
  composeOutput.value = ''
  composeMessage.value = '准备中…'
  // 进度靠主进程推事件；这里只负责显示
  offProgress = window.api.onComposeProgress((p) => {
    composePercent.value = p.percent
    composeMessage.value = p.message
  })
  offDone = window.api.onComposeDone((r) => {
    composing.value = false
    if (r.ok && r.output) {
      composeOutput.value = r.output
      composePercent.value = 100
      composeMessage.value = '成片已生成'
      ui.showToast('成片已生成', 'success')
    } else {
      composeMessage.value = r.message ?? '合成失败'
      ui.showToast(r.message ?? '合成失败', 'error', 8000)
      if (r.keptIntermediate?.length) {
        composeMessage.value += `（已保留 ${r.keptIntermediate.length} 个中间文件，便于排查）`
      }
    }
    offProgress?.()
    offDone?.()
    offProgress = null
    offDone = null
  })
  const res = await window.api.composeRun({
    clipIds: selectedIds.value,
    title: title.value.trim() || clip.clips[0]?.name || '成片'
  })
  if (!res.ok) {
    composing.value = false
    ui.showToast(res.message || '无法开始合成', 'error')
  }
}

async function cancelCompose(): Promise<void> {
  await window.api.composeCancel()
  ui.showToast('已请求取消', 'info')
}

onUnmounted(() => {
  offProgress?.()
  offDone?.()
})

const selectedIds = computed(() =>
  clip.clips.filter((c) => !excluded.value.has(c.id)).map((c) => c.id)
)

const tags = computed(() =>
  tagText.value
    .split(/[\s,，、#]+/)
    .map((t) => t.trim())
    .filter(Boolean)
)

/** 预览里默认展示 README（其余文件在下面列出来） */
const readmeContent = computed(
  () => data.value?.files.find((f) => f.path === 'README.md')?.content ?? ''
)

function toggle(id: number): void {
  const next = new Set(excluded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  excluded.value = next
  // 选择变了，旧预览就过期了 —— 清掉避免用户导出到没看过的内容
  data.value = null
}

async function build(): Promise<void> {
  if (!clip.clips.length) {
    ui.showToast('片段库还是空的，先在素材库选中字幕加入切片任务', 'error')
    return
  }
  if (!selectedIds.value.length) {
    ui.showToast('至少要保留一个片段', 'error')
    return
  }
  busy.value = true
  exportedDir.value = ''
  try {
    data.value = await window.api.kitBuild({
      title: title.value.trim() || clip.clips[0]?.name || '发布素材包',
      description: description.value,
      tags: tags.value,
      clipIds: selectedIds.value
    })
    if (data.value.missingSubtitle.length) {
      ui.showToast(
        `片段 ${data.value.missingSubtitle.join('、')} 取不到字幕，包里不会有它们的字幕稿`,
        'info',
        6000
      )
    }
  } catch (err) {
    ui.showToast(`生成失败：${(err as Error).message}`, 'error')
  } finally {
    busy.value = false
  }
}

async function exportKit(): Promise<void> {
  if (!data.value) {
    ui.showToast('先生成再导出', 'error')
    return
  }
  busy.value = true
  try {
    const res = await window.api.kitExport({ data: data.value })
    if (!res.ok) {
      ui.showToast(res.message || '导出失败', 'error')
      return
    }
    exportedDir.value = res.data?.dir ?? ''
    ui.showToast(`已导出 ${res.data?.files ?? 0} 个文件`, 'success')
  } finally {
    busy.value = false
  }
}

async function openExported(): Promise<void> {
  if (!exportedDir.value) return
  await window.api.openPath(exportedDir.value)
}

/** 打开成片所在的目录（成片文件的路径由主进程给出） */
async function openPath(target: string): Promise<void> {
  const err = await window.api.openPath(target)
  if (err) ui.showToast(`打不开：${err}`, 'error')
}

/** 用当前打开视频的标题预填，省一次输入 */
function useCurrentTitle(): void {
  if (title.value.trim()) return
  title.value = clip.clips[0]?.name ?? ''
}
</script>

<template>
  <section class="kit" aria-label="发布素材包">
    <header class="kit-bar">
      <h2 class="kit-title">素材包</h2>
      <span class="muted kit-sub">
        两种产出，都用「左边这份片段选择」：① 文案素材包（文本）② 合成成片（mp4）
      </span>
      <span class="grow"></span>
      <button class="btn primary" :disabled="busy || composing" @click="build">
        {{ busy ? '处理中…' : '生成预览' }}
      </button>
      <button class="btn" :disabled="busy || composing || !data" @click="exportKit">
        导出素材包
      </button>
      <button class="btn" :disabled="composing || busy" @click="compose">
        {{ composing ? '合成中…' : '合成成片' }}
      </button>
      <button v-if="composing" class="btn" @click="cancelCompose">取消</button>
      <button v-if="exportedDir" class="btn" @click="openExported">打开文件夹</button>
    </header>

    <!-- 合成进度：切片 + 拼接可能几分钟，必须有可见进度与取消入口 -->
    <div v-if="composing || composeMessage" class="kit-compose">
      <div class="kit-progress">
        <div class="kit-progress-fill" :style="{ width: `${composePercent}%` }"></div>
      </div>
      <span class="muted">{{ composePercent }}% · {{ composeMessage }}</span>
      <button v-if="composeOutput" class="btn sm" @click="openPath(composeOutput)">打开成片</button>
    </div>

    <div class="kit-cols">
      <!-- 左：文案与片段选择 -->
      <div class="kit-col">
        <div class="kit-col-head">
          <span>1. 填写</span>
          <span class="grow"></span>
          <button class="btn sm" type="button" @click="useCurrentTitle">用首条片段名</button>
        </div>
        <div class="kit-fields">
          <label class="kit-field">
            <span class="kit-label">
              标题
              <span v-if="publish.fromTemplate" class="kit-from">来自文案模板</span>
            </span>
            <input v-model="title" class="input" type="text" placeholder="发布用的标题" />
          </label>
          <label class="kit-field">
            <span class="kit-label">简介 / 正文</span>
            <textarea
              v-model="description"
              class="input kit-area"
              rows="6"
              placeholder="可直接从「文案模板」页签复制过来"
            ></textarea>
          </label>
          <label class="kit-field">
            <span class="kit-label">话题标签</span>
            <input
              v-model="tagText"
              class="input"
              type="text"
              placeholder="空格或逗号分隔，会自动加 #"
            />
          </label>

          <div class="kit-field">
            <span class="kit-label">
              片段（{{ selectedIds.length }} / {{ clip.clips.length }} 条，共
              {{ formatTime(clip.clips.reduce((n, c) => n + Math.max(0, c.end - c.start), 0)) }}）
            </span>
            <div v-if="!clip.clips.length" class="muted">片段库是空的</div>
            <ul v-else class="kit-clips">
              <li
                v-for="(c, i) in clip.clips"
                :key="c.id"
                class="kit-clip"
                :class="{ off: excluded.has(c.id) }"
                @click="toggle(c.id)"
              >
                <span class="kit-order">{{ excluded.has(c.id) ? '—' : i + 1 }}</span>
                <span class="kit-clip-name" :title="c.name">{{ c.name }}</span>
                <span class="muted kit-clip-time">
                  {{ formatTime(c.start) }} → {{ formatTime(c.end) }}
                </span>
              </li>
            </ul>
            <p class="muted kit-tip">
              点一条可把它排除在素材包之外（序号会重排）；导出顺序就是这里的顺序。
            </p>
          </div>
        </div>
      </div>

      <!-- 右：预览 -->
      <div class="kit-col">
        <div class="kit-col-head">
          <span>2. 预览</span>
          <span class="grow"></span>
          <span v-if="data" class="muted">
            文件夹名：{{ data.folder }} · {{ data.files.length }} 个文件
          </span>
        </div>
        <div v-if="!data" class="muted kit-empty">点「生成预览」后会在这里显示 README.md 的内容</div>
        <template v-else>
          <div class="kit-files">
            <span v-for="f in data.files" :key="f.path" class="kit-file">{{ f.path }}</span>
          </div>
          <pre class="kit-preview">{{ readmeContent }}</pre>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.kit {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 4px 2px;
  overflow: hidden;
}

.kit-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.kit-title {
  margin: 0;
  font-size: 15px;
}

.kit-sub {
  font-size: 12px;
}

.kit-progress {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
  min-width: 120px;
}

.kit-progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}

.kit-compose {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.kit-cols {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.3fr);
  gap: 10px;
  min-height: 0;
  flex: 1;
}

.kit-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  overflow: hidden;
}

.kit-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12px;
  min-height: 34px;
}

.kit-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}

.kit-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.kit-label {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.kit-from {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
}

.kit-area {
  resize: vertical;
  font-family: inherit;
}

.kit-clips {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  background: var(--panel-2);
  border-radius: 5px;
  max-height: 200px;
  overflow: auto;
}

.kit-clip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}

.kit-clip:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.kit-clip.off {
  opacity: 0.45;
  text-decoration: line-through;
}

.kit-order {
  width: 18px;
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.kit-clip-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kit-clip-time {
  font-variant-numeric: tabular-nums;
}

.kit-tip {
  font-size: 11px;
  line-height: 1.7;
  margin: 0;
}

.kit-empty {
  padding: 20px 10px;
  font-size: 12px;
}

.kit-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--hairline);
}

.kit-file {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
  color: var(--text-dim);
}

.kit-preview {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  flex: 1;
  min-height: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.7;
}
</style>
