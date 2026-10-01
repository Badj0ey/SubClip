<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { BiliTarget, PullProgressInfo } from '@shared/types'
import { formatTime } from '@shared/time'
import { loadTree, state, toast } from '../store'

const props = withDefaults(
  defineProps<{
    /** 打开时预填的目标地址（插件检测到合集/收藏夹时用），会立刻自动解析 */
    prefillUrl?: string
    /** 预填来源的说明，例如「浏览器插件检测到合集」 */
    prefillNote?: string
  }>(),
  { prefillUrl: '', prefillNote: '' }
)
const emit = defineEmits<{ (e: 'close'): void }>()

const input = ref(props.prefillUrl)
const resolving = ref(false)
const target = ref<BiliTarget | null>(null)
const chosen = ref<Set<string>>(new Set())
const pulling = ref(false)
const progress = ref<PullProgressInfo | null>(null)
const summary = ref<{
  docs: number
  updated: number
  videos: number
  failed: number
  skipped: number
  messages: string[]
} | null>(null)
const keyword = ref('')

const pluginOnline = computed(() => (state.bridge?.clients.length ?? 0) > 0)
const hasCookie = computed(() => Boolean(state.settings?.biliCookie))

const kindText: Record<string, string> = {
  video: '单个视频',
  season: '合集',
  series: '系列',
  favlist: '收藏夹',
  space: 'UP主投稿'
}

const filteredVideos = computed(() => {
  const list = target.value?.videos ?? []
  const k = keyword.value.trim().toLowerCase()
  if (!k) return list
  return list.filter(
    (v) => v.title.toLowerCase().includes(k) || v.bvid.toLowerCase().includes(k)
  )
})

const progressPercent = computed(() => {
  const p = progress.value
  if (!p || !p.total) return 0
  return Math.round((p.current / p.total) * 100)
})

let offProgress: (() => void) | null = null

onMounted(() => {
  offProgress = window.api.onPullProgress((p) => {
    progress.value = p
  })
  // 从插件带过来的地址：直接解析，省掉用户再粘一次
  if (props.prefillUrl) void resolve()
})

onUnmounted(() => {
  offProgress?.()
})

async function resolve(): Promise<void> {
  const text = input.value.trim()
  if (!text) {
    toast('请输入 BV 号或链接', 'error')
    return
  }
  resolving.value = true
  summary.value = null
  progress.value = null
  try {
    const res = await window.api.resolveTarget(text)
    if (!res.ok || !res.data) {
      toast(res.message || '解析失败', 'error', 4600)
      return
    }
    target.value = res.data
    // 默认全选：已有字幕的视频只会补齐缺失的字幕轨，重复拉取是安全的
    chosen.value = new Set(res.data.videos.map((v) => v.bvid))
    keyword.value = ''

    const existsCount = res.data.videos.filter((v) => v.exists).length
    if (!res.data.videos.length) {
      toast('没有解析到任何视频', 'error')
    } else {
      toast(
        `共 ${res.data.videos.length} 个视频` +
          (existsCount ? `，其中 ${existsCount} 个本地已有字幕（再拉只会补齐缺失的字幕轨）` : ''),
        'success',
        4600
      )
    }
  } finally {
    resolving.value = false
  }
}

function toggle(bvid: string): void {
  if (chosen.value.has(bvid)) chosen.value.delete(bvid)
  else chosen.value.add(bvid)
}

function selectAll(): void {
  chosen.value = new Set(filteredVideos.value.map((v) => v.bvid))
}

function invert(): void {
  const next = new Set(chosen.value)
  for (const v of filteredVideos.value) {
    if (next.has(v.bvid)) next.delete(v.bvid)
    else next.add(v.bvid)
  }
  chosen.value = next
}

function clearAll(): void {
  chosen.value = new Set()
}

async function pull(): Promise<void> {
  if (!target.value) return
  const videos = target.value.videos.filter((v) => chosen.value.has(v.bvid))
  if (!videos.length) {
    toast('请至少选择一个视频', 'error')
    return
  }
  if (!hasCookie.value && !pluginOnline.value) {
    toast('需要 B 站登录状态：请在设置里同步登录状态，或让浏览器插件保持连接', 'error', 5200)
    return
  }

  pulling.value = true
  summary.value = null
  progress.value = { current: 0, total: videos.length, title: '', status: 'running' }
  try {
    const res = await window.api.pullSubtitles(videos.map((v) => ({ bvid: v.bvid, title: v.title })))
    if (!res.ok || !res.data) {
      toast(res.message || '拉取失败', 'error', 4600)
      return
    }
    summary.value = res.data
    await loadTree()
    const added = res.data.docs
    const updated = res.data.updated ?? 0
    if (added > 0 || updated > 0) {
      const parts: string[] = []
      if (added) parts.push(`新增 ${added} 条`)
      if (updated) parts.push(`更新 ${updated} 条`)
      toast(
        `${parts.join('，')}字幕（来自 ${res.data.videos} 个视频）` +
          (res.data.skipped ? `，${res.data.skipped} 个已存在跳过` : ''),
        'success',
        4600
      )
    } else if (res.data.skipped > 0) {
      toast(`${res.data.skipped} 个视频的字幕本地已齐全，已跳过`, 'info', 4600)
    } else {
      toast('没有拉到任何字幕，请检查登录状态', 'error', 4600)
    }
  } finally {
    pulling.value = false
    progress.value = null
  }
}

async function openSettings(): Promise<void> {
  emit('close')
  state.view = 'settings'
}
</script>

<template>
  <div class="mask" @click.self="!pulling && emit('close')">
    <div class="modal modal-lg">
      <h3>拉取字幕</h3>

      <div v-if="prefillNote" class="hint" style="margin-left: 0; color: var(--accent)">
        {{ prefillNote }}：已自动解析出下面这些视频。<strong>逐条确认要拉哪些</strong>，
        再点「开始拉取」——同一个视频会拉取它的<strong>全部分P</strong>。
      </div>

      <div class="field">
        <label>链接 / BV号</label>
        <div class="row">
          <input
            v-model="input"
            class="input grow"
            placeholder="粘贴视频、合集、系列、收藏夹、UP主主页或 b23.tv 短链"
            :disabled="pulling"
            @keyup.enter="resolve"
          />
          <button class="btn primary" :disabled="resolving || pulling" @click="resolve">
            {{ resolving ? '解析中…' : '解析' }}
          </button>
        </div>
      </div>

      <div class="hint" style="margin-left: 0">
        支持：<code>视频页</code> · <code>合集 / 系列</code> · <code>收藏夹</code> ·
        <code>UP主投稿页</code> · <code>b23.tv 短链</code>；也可直接输入 BV 号。
      </div>

      <div v-if="!hasCookie" class="notice">
        <span>
          尚未配置 B 站登录状态，拉取字幕会失败。
          <template v-if="pluginOnline">浏览器插件已连接，可到插件弹窗点「同步登录状态到桌面端」。</template>
        </span>
        <button class="btn sm" @click="openSettings">前往设置</button>
      </div>

      <template v-if="target">
        <div class="seg">
          <div class="seg-title">
            <span class="badge-soft">{{ kindText[target.kind] ?? target.kind }}</span>
            <span style="flex: 1 1 auto; word-break: break-all">{{ target.title }}</span>
            <span class="muted">{{ target.videos.length }} 个视频</span>
          </div>
          <div v-if="target.truncated" class="hint" style="margin-left: 0">
            内容较多，仅解析了前 {{ target.videos.length }} 个视频。
          </div>

          <div class="row" style="margin-top: 8px">
            <input v-model="keyword" class="input grow" placeholder="筛选视频标题 / BV号" />
            <button class="btn sm" @click="selectAll">全选</button>
            <button class="btn sm" @click="invert">反选</button>
            <button class="btn sm" @click="clearAll">清空</button>
            <span class="muted">已选 {{ chosen.size }}</span>
          </div>
        </div>

        <div class="video-list">
          <label v-for="v in filteredVideos" :key="v.bvid" class="video-item">
            <input
              type="checkbox"
              :checked="chosen.has(v.bvid)"
              :disabled="pulling"
              @change="toggle(v.bvid)"
            />
            <img v-if="v.cover" class="video-cover" :src="v.cover" alt="" loading="lazy" />
            <span class="video-title">{{ v.title || v.bvid }}</span>
            <span v-if="v.exists" class="badge-exists" title="本地已有该视频的字幕；再拉一次只会补齐缺失的字幕轨">
              已有字幕
            </span>
            <span class="muted video-meta">{{ v.bvid }}</span>
            <span v-if="v.duration" class="muted video-meta">{{ formatTime(v.duration) }}</span>
          </label>
          <div v-if="!filteredVideos.length" class="empty" style="padding: 22px">
            没有匹配的视频
          </div>
        </div>
      </template>

      <div v-if="pulling && progress" class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-inner" :style="{ width: `${progressPercent}%` }"></div>
        </div>
        <div class="muted" style="margin-top: 6px">
          正在处理 {{ progress.current }} / {{ progress.total }}：{{ progress.title }}
        </div>
      </div>

      <div v-if="summary" class="seg" style="margin-top: 10px">
        <div class="seg-title">拉取结果</div>
        <div class="muted" style="line-height: 1.9">
          成功 {{ summary.videos }} 个视频 · 新增 {{ summary.docs }} 条字幕 ·
          <template v-if="summary.updated">更新 {{ summary.updated }} 条 · </template>
          失败/无字幕 {{ summary.failed }} 个
          <template v-if="summary.skipped"> · 已存在跳过 {{ summary.skipped }} 个</template>
        </div>
        <div v-if="summary.messages.length" class="hint" style="margin-left: 0; max-height: 96px; overflow: auto">
          <div v-for="(m, i) in summary.messages.slice(0, 20)" :key="i">· {{ m }}</div>
        </div>
      </div>

      <div class="actions">
        <button class="btn" :disabled="pulling" @click="emit('close')">关闭</button>
        <button
          class="btn primary"
          :disabled="pulling || !target || !chosen.size"
          @click="pull"
        >
          {{ pulling ? '拉取中…' : `拉取选中字幕（${chosen.size}）· 每个视频含全部分P` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-lg {
  width: 720px;
}

.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  margin: 8px 0;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  border: 1px solid var(--warn-border);
  color: var(--text);
  font-size: 12px;
  line-height: 1.7;
}

.notice > span {
  flex: 1 1 auto;
}

.badge-soft {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  flex: 0 0 auto;
}

.video-list {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.video-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.12s;
}

.video-item:last-child {
  border-bottom: none;
}

.video-item:hover {
  background: var(--row-hover);
}

.video-item input {
  flex: 0 0 auto;
  cursor: pointer;
}

.video-cover {
  width: 46px;
  height: 29px;
  object-fit: cover;
  border-radius: 4px;
  flex: 0 0 auto;
  background: var(--border);
}

.video-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.video-meta {
  flex: 0 0 auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.progress-wrap {
  margin-top: 12px;
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
  transition: width 0.25s ease;
}
</style>

<style scoped>
.badge-exists {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--warn-soft);
  border: 1px solid var(--warn-border);
  color: var(--warn);
  font-size: 11px;
  white-space: nowrap;
}
</style>
