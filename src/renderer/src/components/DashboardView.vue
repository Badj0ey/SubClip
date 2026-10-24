<script setup lang="ts">
/**
 * 新首页 Dashboard（第二阶段）。
 *
 * 定位：从「打开就是一个空工作区」变成「打开就知道库里有什么、能去哪」。
 *
 * 五块内容（对应提示词第 2 阶段-1）：
 * - 最近视频 / 最近项目（合集）：点一下直接进工作区并打开
 * - 收藏片段：视频与字幕都收进同一张卡，可撤销删除的收藏也在这里找得到
 * - 待处理任务：切片任务数 + 还没拉字幕的视频数（这两个是真实的「待办」）
 * - 快速入口：导入 / 拉取 / 检索 / 设置
 *
 * 实现选型：**Vue 组件卡片布局**（提示词的 A 方案）。
 * 没做「插件化 Dashboard」——那需要先定义一套模块注册协议，
 * 而目前首页只有 5 块固定内容，先做成组件、以后真需要再抽。
 */
import { computed, onMounted, ref } from 'vue'
import type { DashboardFavorite, DashboardOverview } from '@shared/types'
import { useResourceStore } from '../stores/resource'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'
import { useClipStore } from '../stores/clip'
import { useJobsStore } from '../stores/jobs'
import { useSearchStore } from '../stores/search'
import { toast } from '../store'

const emit = defineEmits<{ (e: 'import'): void; (e: 'pull'): void }>()

const resource = useResourceStore()
const subtitle = useSubtitleStore()
const ui = useUiStore()
const clip = useClipStore()
const jobs = useJobsStore()
const search = useSearchStore()

const data = ref<DashboardOverview | null>(null)
const loading = ref(true)

/**
 * 页头摘要：说明「库里现在有什么」。
 *
 * 计数来源要分清：**片段**是攒下来的资产、**任务**是等着输出的。
 * 原来把两者都写成「切片任务」，用户无法判断「到底排没排进队列」。
 */
const headSummary = computed(
  () =>
    `素材库 ${data.value?.recentVideos.length ?? 0} 个最近视频 · ` +
    `片段 ${clip.clips.length} 个 · 待输出任务 ${jobs.pending.length} 条`
)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    // 首页同时展示片段与任务，两个 store 都要有数据
    const [overview] = await Promise.all([window.api.dashboardOverview(), jobs.load()])
    data.value = overview
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  /**
   * 首页同时展示「片段」（`clip` store）与「待输出任务」（`jobs` store），
   * 而这两个 store 可能是空的（例如启动后直接进首页）—— 都要先加载，
   * 否则卡片上显示 0，看起来像「数据没了」。
   */
  await Promise.all([clip.loadClips(), refresh()])
})

/* --------------------------------- 统计条 -------------------------------- */

const stats = computed(() => ({
  videos: data.value?.recentVideos.length ? data.value.recentVideos.length : 0,
  clips: clip.clips.length,
  pending: data.value?.videosWithoutDocs ?? 0,
  favorites: data.value?.favorites.length ?? 0
}))

/* --------------------------------- 交互 --------------------------------- */

/**
 * 打开某个视频：进工作区 → 展开到它 → 打开第一条字幕。
 * 没字幕时只展开，让用户看到它确实还没有字幕。
 */
async function openVideo(videoId: number, docId: number | null): Promise<void> {
  ui.setView('library')
  const key = `video:${videoId}`
  resource.activeKey = key
  resource.expandTo(key)
  if (docId != null) await subtitle.open(docId)
  else toast('该视频还没有字幕，可在「拉取字幕」里补齐', 'info', 4200)
}

async function openFavorite(item: DashboardFavorite): Promise<void> {
  ui.setView('library')
  resource.activeKey = item.key
  resource.expandTo(item.key)
  if (item.type === 'doc' && item.docId != null) await subtitle.open(item.docId)
}

/** 用「当前关键词」直接进全库检索（首页只负责把人送过去） */
function goSearch(): void {
  ui.setView('search')
}

function goSettings(): void {
  ui.setView('settings')
}

function goLibrary(): void {
  ui.setView('library')
}

/**
 * 去「剪辑任务」页。
 *
 * 拆表后队列与失败重试都在那一页 —— 原来这两个入口跳的是素材库，
 * 到了那儿根本找不到「待处理队列」（3.11.0 修正）。
 */
function goJobs(): void {
  ui.setView('clipjobs')
}

function goClips(): void {
  ui.setView('clips')
}

/** 点收藏的片段：直接去片段库（那里能看标签、跳回原片） */
function openClip(clipId: number): void {
  ui.setView('clips')
  // 让片段库知道要聚焦哪一条（组件里按 ref 高亮）
  ui.focusClipId = clipId
}

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

defineExpose({ refresh })
</script>

<template>
  <section class="dashboard" aria-label="工作台">
    <header class="view-head">
      <h2 class="view-title">工作台</h2>
      <span class="view-sub muted">{{ headSummary }}</span>
      <span class="grow"></span>
      <button class="btn" title="重新读取首页数据" @click="refresh">刷新</button>
      <button class="btn primary" @click="goLibrary">进入素材库 →</button>
    </header>

    <div class="dash-grid">
      <!-- ------------------------------ 快速入口 ------------------------------ -->
      <div class="card quick">
        <div class="card-title">快速入口</div>
        <div class="quick-grid">
          <button class="quick-btn" @click="emit('import')">
            <span class="q-ico">📄</span>
            <span>导入 SRT</span>
          </button>
          <button class="quick-btn" @click="emit('pull')">
            <span class="q-ico">⬇️</span>
            <span>拉取字幕</span>
          </button>
          <button class="quick-btn" @click="goSearch">
            <span class="q-ico">🔍</span>
            <span>字幕检索</span>
          </button>
          <button class="quick-btn" @click="goSettings">
            <span class="q-ico">⚙️</span>
            <span>设置</span>
          </button>
        </div>
      </div>

      <!-- ------------------------------ 待处理任务 ----------------------------- -->
      <div class="card pending">
        <div class="card-title">待处理</div>
        <ul class="todo-list">
          <!--
            计数来源必须是 **任务队列**（`jobs.pending`）而不是片段数。
            拆表后「片段」是攒下来的资产、「任务」才是等着输出的 ——
            用片段数会让人以为「攒了 20 个片段 = 有 20 个待输出」，
            而实际上没排进队列的片段根本不会被切（3.11.0 修正）。
          -->
          <li>
            <span class="todo-n">{{ jobs.pending.length }}</span>
            <span class="todo-t">条任务在队列里等着输出</span>
            <button class="btn sm" :disabled="!jobs.pending.length" @click="goJobs">
              去剪辑
            </button>
          </li>
          <li>
            <span class="todo-n">{{ stats.pending }}</span>
            <span class="todo-t">个视频还没有字幕</span>
            <button class="btn sm" @click="emit('pull')">去拉取</button>
          </li>
          <li>
            <span class="todo-n">{{ jobs.failed.length }}</span>
            <span class="todo-t">条输出失败（可一键重试）</span>
            <button class="btn sm" :disabled="!jobs.failed.length" @click="goJobs">
              去重试
            </button>
          </li>
        </ul>
      </div>

      <!-- ------------------------------- 最近视频 ------------------------------ -->
      <div class="card span2">
        <div class="card-title">
          最近视频
          <span class="muted" style="font-weight: 400">（按字幕入库时间）</span>
        </div>
        <div v-if="loading" class="empty">加载中…</div>
        <div v-else-if="!data?.recentVideos.length" class="empty">
          还没有视频。从「拉取字幕」或「导入 SRT」开始。
        </div>
        <ul v-else class="video-list">
          <li v-for="v in data.recentVideos" :key="v.videoId" class="video-row">
            <button class="video-main" @click="openVideo(v.videoId, v.firstDocId)">
              <span class="video-title">{{ v.title }}</span>
              <span class="muted video-meta">
                {{ v.uploaderName }}
                <template v-if="v.collectionTitle"> · {{ v.collectionTitle }}</template>
                · {{ v.docCount }} 条字幕
                <template v-if="v.bvid"> · {{ v.bvid }}</template>
              </span>
            </button>
            <span class="muted video-date">{{ fmt(v.createdAt) }}</span>
          </li>
        </ul>
      </div>

      <!-- ------------------------------- 最近项目 ------------------------------ -->
      <div class="card">
        <div class="card-title">最近项目（合集）</div>
        <div v-if="!data?.recentCollections.length" class="empty">还没有合集</div>
        <ul v-else class="mini-list">
          <li v-for="c in data.recentCollections" :key="c.collectionId">
            <button
              class="mini-main"
              @click="resource.expandTo(`collection:${c.collectionId}`), ui.setView('library')"
            >
              <span class="mini-title">{{ c.title }}</span>
              <span class="muted mini-meta">{{ c.uploaderName }} · {{ c.videoCount }} 个视频</span>
            </button>
          </li>
        </ul>
      </div>

      <!-- ------------------------------- 收藏片段 ------------------------------ -->
      <div class="card">
        <div class="card-title">收藏的片段</div>
        <div v-if="!data?.favoriteClips.length && !data?.favorites.length" class="card-empty">
          <p>还没有收藏。</p>
          <p class="muted">在片段库给片段点 ☆，或在素材库的树 / 字幕行上右键收藏。</p>
        </div>
        <ul v-else class="mini-list">
          <li v-for="c in data.favoriteClips" :key="`clip-${c.id}`">
            <button class="mini-main" @click="openClip(c.id)">
              <span class="mini-title">{{ c.name }}</span>
              <span class="muted mini-meta">
                片段 · {{ Math.round(Math.max(0, c.end - c.start) * 10) / 10 }}s · P{{ c.page }}
              </span>
            </button>
          </li>
          <li v-for="f in data.favorites" :key="f.key">
            <button class="mini-main" @click="openFavorite(f)">
              <span class="mini-title">{{ f.label }}</span>
              <span class="muted mini-meta">
                {{ f.type === 'doc' ? '字幕' : f.type === 'video' ? '视频' : f.type === 'collection' ? '合集' : 'UP主' }}
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dashboard {
  flex: 1 1 auto;
  overflow: auto;
  padding: var(--sp-6) var(--sp-7) var(--sp-8);
  min-width: 0;
}

/* 页头样式见 styles.css 的 .view-head / .view-title / .view-sub（多页面共享） */

/*
 * 卡片：**无描边、无阴影**。
 * 层级靠它与页面背景的明度差 + 圆角 + 留白 ——
 * 旧版每张卡片都带 1px 描边与一点阴影，五六张叠下来就是「一堆盒子」。
 */
.card {
  background: var(--panel);
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: var(--sp-4) var(--sp-4) var(--sp-5);
  min-width: 0;
}

.span2 {
  grid-column: span 2;
}

@media (max-width: 1100px) {
  .span2 {
    grid-column: span 1;
  }
}

.card-title {
  font-size: var(--fs-base);
  font-weight: 600;
  margin-bottom: var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

/*
 * 空态：与全局 `.empty` 同一套观感（居中 + 留白 + 次级色），
 * 只多限制最大宽度 —— 首页卡片窄，全文横排会很难读。
 */
.card-empty {
  padding: var(--sp-5) var(--sp-4);
  text-align: center;
  color: var(--text-dim);
  line-height: 1.8;
}

.card-empty p {
  margin: 0;
}

.card-empty p + p {
  margin-top: var(--sp-1);
  font-size: var(--fs-sm);
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-3);
}

.quick-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-4) 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: var(--fs-sm);
  transition: border-color 0.12s, transform 0.12s;
}

.quick-btn:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.q-ico {
  font-size: var(--fs-lg);
}

.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.todo-list li {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-base);
}

.todo-n {
  min-width: 30px;
  text-align: right;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.todo-t {
  flex: 1 1 auto;
  min-width: 0;
}

.video-list,
.mini-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow: auto;
}

.video-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.video-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.mini-main {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--sp-2) var(--sp-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  min-width: 0;
}

.video-main:hover,
.mini-main:hover {
  background: var(--hover, rgba(127, 127, 127, 0.09));
}

.video-title,
.mini-title {
  font-size: var(--fs-base);
  font-weight: 550;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-meta,
.mini-meta {
  font-size: var(--fs-sm);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.video-date {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
</style>
