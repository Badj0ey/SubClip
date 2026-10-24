<script setup lang="ts">
/**
 * 视频知识图谱（第八阶段）。
 *
 * ## 图谱的形状
 *
 *     主题  ← 从字幕文本抽出的词（跨视频聚合）
 *      |
 *     视频
 *      |
 *     观点  ← 从字幕里挑出的「像话的句子」
 *      |
 *     片段  ← 已有的切片任务
 *
 * ## 为什么做成三层列表而不是画一张网络图
 *
 * 「主题 → 视频 → 观点」本质上是一棵树（一个主题下有若干视频，一个视频下有若干观点），
 * 用列表一层层展开**能定位、能读、能直接跳过去**；而力导向图在这个数据量下
 * （本机实测 1998 个主题）既画不清也没法精确点到某一条。
 * 图谱的价值在于「顺着关系找到想看的内容」，不在于「好看」。
 *
 * ## 全部本地
 *
 * 主题与观点都是本地抽的（`Intl.Segmenter` 分词 + 启发式打分），
 * 不联网、不依赖 AI。语料里混着外语轨，所以抽取层做了语言过滤
 * —— 这些取舍写在 `@shared/extract` 的注释里。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { GraphCounts, GraphTopic, GraphTopicVideo, GraphViewpoint } from '@shared/types'
import { formatTime } from '@shared/time'
import { useClipStore } from '../stores/clip'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const subtitle = useSubtitleStore()
const clip = useClipStore()

const counts = ref<GraphCounts>({ topics: 0, viewpoints: 0, videos: 0, builtAt: 0 })
const progress = ref<{ busy: boolean; message: string }>({ busy: false, message: '' })

const keyword = ref('')
const topics = ref<GraphTopic[]>([])
const activeTopic = ref<GraphTopic | null>(null)
const topicVideos = ref<GraphTopicVideo[]>([])
const activeVideo = ref<GraphTopicVideo | null>(null)
const viewpoints = ref<GraphViewpoint[]>([])

const loading = ref(false)
/** 轮询建图进度用的定时器（组件卸载/建完即清） */
let pollTimer: number | null = null

const builtAtText = computed(() =>
  counts.value.builtAt ? new Date(counts.value.builtAt).toLocaleString() : '还没建过'
)

async function refreshCounts(): Promise<void> {
  counts.value = await window.api.graphCounts()
}

async function loadTopics(): Promise<void> {
  topics.value = await window.api.graphTopics({ keyword: keyword.value, limit: 300 })
}

async function build(rebuild: boolean): Promise<void> {
  const res = await window.api.graphBuild({ rebuild })
  if (!res.ok) {
    ui.showToast(res.message || '建图失败', 'error')
    return
  }
  ui.showToast(rebuild ? '已开始重建图谱' : '已开始建图', 'success')
  startPolling()
}

/**
 * 轮询建图进度。
 *
 * 建图要处理 490 份字幕（十几秒到一分钟），所以主进程那边**不 await**，
 * 立刻返回「已开始」；界面靠轮询刷新 —— 否则 IPC 一直挂着，界面像卡死。
 */
function startPolling(): void {
  if (pollTimer !== null) return
  progress.value = { busy: true, message: '正在建图…' }
  pollTimer = window.setInterval(async () => {
    const s = await window.api.graphStatus()
    progress.value = { busy: s.busy, message: s.message }
    if (!s.busy) {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      await refreshCounts()
      await loadTopics()
      ui.showToast(s.message, s.phase === 'error' ? 'error' : 'success', 6000)
    }
  }, 1200)
}

async function selectTopic(t: GraphTopic): Promise<void> {
  activeTopic.value = t
  activeVideo.value = null
  viewpoints.value = []
  loading.value = true
  try {
    topicVideos.value = await window.api.graphTopicVideos({ topicId: t.id, limit: 100 })
  } finally {
    loading.value = false
  }
}

async function selectVideo(v: GraphTopicVideo): Promise<void> {
  activeVideo.value = v
  loading.value = true
  try {
    viewpoints.value = await window.api.graphViewpoints({ videoId: v.videoId, limit: 30 })
  } finally {
    loading.value = false
  }
}

/** 打开某条候选句所在的原片并定位（复用已验证的路径） */
async function openViewpoint(vp: GraphViewpoint): Promise<void> {
  ui.setView('library')
  await subtitle.open(vp.docId, undefined)
  subtitle.setCursor(vp.index)
  subtitle.scrollToCursor()
  subtitle.followCueAt(vp.index)
  // 顺手把这句话覆盖的字幕勾上，用户可以直接「加入切片任务」——
  // 这就是图谱最底下那层「片段」的入口，不另造一套操作
  subtitle.selectRange(vp.start, vp.end, true)
}

/**
 * 点视频行：打开该视频**第一条候选句**所在的原片。
 *
 * 之所以不做「打开视频」再让用户自己找：一个视频可能有多条候选句，
 * 而用户在图谱里点视频的意图就是「看看这个视频讲了什么」——
 * 直接落到第一条最省事。想看别的在右栏点即可。
 */
async function openVideo(v: GraphTopicVideo): Promise<void> {
  const list = viewpoints.value.length && activeVideo.value?.videoId === v.videoId
    ? viewpoints.value
    : await window.api.graphViewpoints({ videoId: v.videoId, limit: 1 })
  const first = list[0]
  if (!first) {
    ui.showToast('这个视频还没有抽到候选句，无法定位', 'error')
    return
  }
  await openViewpoint(first)
}

async function cancel(): Promise<void> {
  await window.api.graphCancel()
  ui.showToast('已请求中断，当前批次结束后停止', 'info')
}

onMounted(async () => {
  await refreshCounts()
  await loadTopics()
  // 上次建图还在跑（比如切换视图前刚点过），接着显示进度
  const s = await window.api.graphStatus()
  if (s.busy) startPolling()
})

/** 关键词筛选防抖：每次按键都查库没必要 */
let searchTimer: number | null = null
watch(keyword, () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void loadTopics(), 250)
})
</script>

<template>
  <section class="graph" aria-label="视频知识图谱">
    <header class="graph-bar">
      <h2 class="graph-title">探索</h2>
      <span class="muted graph-sub">
        {{ counts.topics }} 个主题 · {{ counts.viewpoints }} 候选句 · 覆盖 {{ counts.videos }} 个视频
        · 上次建图：{{ builtAtText }}
      </span>
      <span class="grow"></span>
      <button class="btn" :disabled="progress.busy" @click="build(false)">建图</button>
      <button class="btn" :disabled="progress.busy" @click="build(true)">重建</button>
      <button v-if="progress.busy" class="btn" @click="cancel">中断</button>
      <button class="btn" @click="ui.setView('library')">返回素材库</button>
    </header>

    <p v-if="progress.busy" class="graph-progress">{{ progress.message }}</p>

    <p class="graph-hint">
      <strong>主题</strong>是从字幕文本里抽出来的词，跨视频聚合；
      <strong>候选句</strong>是从字幕里挑出的信息量较高的句子。
      点「跳到并勾选」可跳到原片并勾好这段话，直接加入切片任务 —— 图谱最底下那层「片段」就是这么来的。
      <span class="muted">（全部本地抽取：不联网、不依赖 AI）</span>
    </p>

    <!--
      如实说明抽取质量的边界。这一段是**必需的**，不是免责声明式的客套：
      自动生成字幕（无标点 + 大量口语）里本来就很难分出「观点」，
      不说清楚的话，用户会以为「工具连观点都抽不出来」是坏了。
    -->
    <p class="graph-caveat">
      ⚠️ 候选句的质量**取决于字幕本身**：自动生成字幕常常没有标点、口语碎句多，
      这类内容里没有真正的「观点」可抽，选出来的句子会比较粗糙。
      字幕质量高（人工字幕 / 口播类）的视频效果明显更好。
      候选句只作**索引线索**用 —— 点进去看原片上下文才是最可靠的。
    </p>

    <div v-if="!counts.topics && !progress.busy" class="graph-empty">
      <p>还没有图谱数据。</p>
      <p class="muted">
        点上面的「建图」即可：会扫描全部字幕抽出主题与观点，全程本地。
        语料较多时可能要一分钟左右。
      </p>
    </div>

    <div v-else class="graph-cols">
      <!-- 第一层：主题 -->
      <div class="graph-col">
        <div class="graph-col-head">
          <input v-model="keyword" class="input sm grow" type="search" placeholder="筛选主题" />
        </div>
        <ul class="graph-list">
          <li
            v-for="t in topics"
            :key="t.id"
            class="graph-item"
            :class="{ active: activeTopic?.id === t.id }"
            @click="selectTopic(t)"
          >
            <span class="graph-term">{{ t.term }}</span>
            <span class="graph-count" :title="`出现在 ${t.videoCount} 个视频，共 ${t.totalCount} 次`">
              {{ t.videoCount }}
            </span>
          </li>
        </ul>
        <p v-if="!topics.length" class="muted graph-none">没有匹配的主题</p>
      </div>

      <!-- 第二层：视频 -->
      <div class="graph-col">
        <div class="graph-col-head">
          <span class="muted">
            <template v-if="activeTopic">
              「{{ activeTopic.term }}」下的视频（{{ topicVideos.length }}）
            </template>
            <template v-else>← 先选一个主题</template>
          </span>
        </div>
        <ul class="graph-list">
          <li
            v-for="v in topicVideos"
            :key="v.videoId"
            class="graph-item tall"
            :class="{ active: activeVideo?.videoId === v.videoId }"
            @click="selectVideo(v)"
          >
            <div class="graph-video-title" :title="v.title">{{ v.title }}</div>
            <div class="muted graph-meta">
              {{ v.count }} 次 · {{ v.viewpoints }} 候选句
              <span v-if="v.uploaderName"> · {{ v.uploaderName }}</span>
            </div>
            <button class="btn sm" type="button" @click.stop="openVideo(v)">打开视频</button>
          </li>
        </ul>
        <p v-if="activeTopic && !topicVideos.length && !loading" class="muted graph-none">
          这个主题下没有视频
        </p>
      </div>

      <!-- 第三层：观点（→ 片段） -->
      <div class="graph-col wide">
        <div class="graph-col-head">
          <span class="muted">
            <template v-if="activeVideo">「{{ activeVideo.title }}」候选句句</template>
            <template v-else>← 再选一个视频</template>
          </span>
        </div>
        <ul class="graph-list">
          <li v-for="vp in viewpoints" :key="vp.id" class="graph-item vp">
            <div class="graph-vp-text">{{ vp.text }}</div>
            <div class="graph-vp-foot">
              <span class="muted">
                {{ formatTime(vp.start) }} → {{ formatTime(vp.end) }}
                <span v-if="vp.page > 1"> · P{{ vp.page }}</span>
                · 评分 {{ vp.score }}
              </span>
              <span class="grow"></span>
              <button class="btn sm primary" type="button" @click="openViewpoint(vp)">
                跳到并勾选
              </button>
            </div>
          </li>
        </ul>
        <p v-if="activeVideo && !viewpoints.length && !loading" class="muted graph-none">
          这个视频还没有抽到候选句（可能字幕太短，或都是口语碎句）
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.graph {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 4px 2px;
  overflow: hidden;
}

.graph-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.graph-title {
  margin: 0;
  font-size: 15px;
}

.graph-sub,
.graph-hint,
.graph-progress {
  font-size: 12px;
  line-height: 1.7;
}

.graph-progress {
  color: var(--accent);
  margin: 0;
}

.graph-caveat {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.7;
}

.graph-empty {
  padding: 20px 4px;
}

.graph-cols {
  display: grid;
  grid-template-columns: 200px 260px 1fr;
  gap: 10px;
  min-height: 0;
  flex: 1;
}

.graph-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  overflow: hidden;
}

.graph-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12px;
  min-height: 34px;
}

.graph-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}

.graph-item {
  padding: 5px 7px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.graph-item.tall {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
}

.graph-item:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.graph-item.active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}

.graph-term {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-count {
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.graph-video-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-meta {
  font-size: 11px;
}

/* 与其它两侧视觉一致：这里的 item 里嵌了按钮，靠内边距拉开一点 */
.graph-item.tall .btn {
  align-self: flex-start;
}

.graph-item.vp {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  cursor: default;
}

.graph-item.vp:hover {
  background: transparent;
}

.graph-vp-text {
  line-height: 1.7;
}

.graph-vp-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.graph-none {
  padding: 10px;
  font-size: 12px;
}
</style>
