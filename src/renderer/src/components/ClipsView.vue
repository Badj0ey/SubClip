<script setup lang="ts">
/**
 * 片段库（第三阶段：素材库升级）。
 *
 * ## 「片段」是什么
 *
 * 片段 = **带名称、标签与收藏状态的时间范围**（存在 `clips` 表里）。
 * 它和「切片任务」是同一批数据的两面：
 * - 在右侧面板看，它是「待执行的切片任务」；
 * - 在这里看，它是「我攒下来的素材」——可以命名、打标签、收藏、跳回原片。
 *
 * 为什么不做成两张表：时间范围、分P、跨P 分段、来源文档这些字段完全一样，
 * 拆开就必须双向同步，只会制造「一边改了另一边还是旧的」这类 bug。
 * 「执行」是另一个动作（队列在右栏），不是另一种数据。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ClipTask } from '@shared/types'
import { formatTime } from '@shared/time'
import { rangeDuration } from '@shared/ranges'
import { useClipStore } from '../stores/clip'
import { useTagsStore } from '../stores/tags'
import { useSubtitleStore } from '../stores/subtitle'
import { useResourceStore } from '../stores/resource'
import { useUiStore } from '../stores/ui'
import { toast } from '../store'
import RecommendView from './RecommendView.vue'
import GraphView from './GraphView.vue'
import TemplateView from './TemplateView.vue'
import KitView from './KitView.vue'

const clip = useClipStore()
/**
 * 页签：`clips` 片段库 / `recommend` 素材推荐 / `graph` 知识图谱 / `template` 文案模板
 * （后三个都是第八阶段加的）。
 * 只存组件本地状态 —— 用户切走再回来应该看到「片段库」这个默认视图，
 * 而不是上次停在哪就一直停在哪（那会让人以为片段列表空了）。
 */
const tab = ref<'clips' | 'recommend' | 'graph' | 'template' | 'kit'>('clips')

/**
 * 页签定义（3.10.0 起按**业务阶段**命名）。
 *
 * 重命名理由：
 * - 「推荐」→「**发现**」：旧名容易被读成「系统给我推荐」，
 *   而它实际是「按相似度从**你自己的库**里找出可以搭着用的素材」；
 * - 「知识图谱」→「**探索**」：图谱是实现手段，用户的问题是「这些内容什么关系」；
 * - 「文案模板」「发布素材包」保留原名 —— 它们本身就是用户要的东西，没有歧义。
 */
const STAGE_TABS: Array<{ key: 'clips' | 'recommend' | 'graph' | 'template' | 'kit'; label: string; hint: string }> = [
  { key: 'clips', label: '片段库', hint: '你攒下来的片段：命名、标签、收藏、跳回原片' },
  { key: 'recommend', label: '发现', hint: '从你的库里找出可以搭着用的相似素材' },
  { key: 'graph', label: '探索', hint: '看内容之间的关系：主题、视频、观点' },
  { key: 'template', label: '文案模板', hint: '把片段信息填进标题 / 简介 / 标签的模板' },
  { key: 'kit', label: '素材包', hint: '为发布准备的一整套素材（清单 / 封面文案 / 成片）' }
]

/** 页头摘要：只说明「这一页在干什么」，具体计数交给各页签自己显示 */
const headSummary = computed(() => {
  const hit = STAGE_TABS.find((t) => t.key === tab.value)
  return hit?.hint ?? ''
})
const tags = useTagsStore()
const subtitle = useSubtitleStore()
const resource = useResourceStore()
const ui = useUiStore()

const keyword = ref('')
const sourceFilter = ref<'all' | ClipTask['source']>('all')
const tagFilter = ref<number | null>(null)
const favoriteOnly = ref(false)

onMounted(() => {
  void Promise.all([clip.loadClips(), tags.load()]).catch((error: unknown) => {
    ui.showToast(`片段库加载失败：${String(error)}`, 'error')
  })
})

/**
 * Load details after the clip store is ready, in bounded batches. The previous
 * setup-time loop ran before loadClips() and could silently hydrate zero rows.
 * Batch IPC also avoids scanning all clips for every individual card.
 */
const detailCache = ref<Record<number, { videoTitle: string; docLabel: string; creators: string[]; tagIds: number[] }>>({})
let detailRequest = 0
watch(
  () => clip.clips.map((c) => c.id).join(','),
  async () => {
    const request = ++detailRequest
    const ids = clip.clips.map((c) => c.id)
    if (!ids.length) { detailCache.value = {}; return }
    const next: typeof detailCache.value = {}
    for (const id of ids) if (detailCache.value[id]) next[id] = detailCache.value[id]
    const missing = ids.filter((id) => !next[id])
    if (!missing.length) { detailCache.value = next; return }
    try {
      for (let i = 0; i < missing.length; i += 200) {
        const batch = await window.api.getClipDetails(missing.slice(i, i + 200))
        if (request !== detailRequest) return
        for (const d of batch) {
          next[d.clipId] = {
            videoTitle: d.videoTitle,
            docLabel: d.docLabel,
            creators: d.creators,
            tagIds: d.tagIds
          }
        }
        // Large libraries become progressively usable instead of waiting for all pages.
        detailCache.value = { ...next }
      }
    } catch (error) {
      if (request === detailRequest) ui.showToast(`片段详情加载失败：${String(error)}`, 'error')
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => { detailRequest++ })

async function ensureDetail(c: ClipTask): Promise<void> {
  if (detailCache.value[c.id]) return
  const [d] = await window.api.getClipDetails([c.id])
  if (d) detailCache.value = {
    ...detailCache.value,
    [c.id]: { videoTitle: d.videoTitle, docLabel: d.docLabel, creators: d.creators, tagIds: d.tagIds }
  }
}

const visible = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return clip.clips.filter((c) => {
    if (sourceFilter.value !== 'all' && c.source !== sourceFilter.value) return false
    if (favoriteOnly.value && !c.favorite) return false
    if (tagFilter.value != null) {
      const ids = detailCache.value[c.id]?.tagIds ?? []
      if (!ids.includes(tagFilter.value)) return false
    }
    if (!kw) return true
    const d = detailCache.value[c.id]
    return (
      c.name.toLowerCase().includes(kw) ||
      c.note.toLowerCase().includes(kw) ||
      (d?.videoTitle ?? '').toLowerCase().includes(kw) ||
      (d?.creators ?? []).some((n) => n.toLowerCase().includes(kw))
    )
  })
})

const totalDuration = computed(() =>
  visible.value.reduce((n, c) => n + Math.max(0, c.end - c.start), 0)
)

/* --------------------------------- 操作 --------------------------------- */

const editingId = ref<number | null>(null)
const editingName = ref('')

function startRename(c: ClipTask): void {
  editingId.value = c.id
  editingName.value = c.name
}

async function commitRename(): Promise<void> {
  const id = editingId.value
  editingId.value = null
  const name = editingName.value.trim()
  if (id == null || !name) return
  await clip.renameName(id, name)
  toast('已重命名片段', 'success')
}

const tagDialogFor = ref<ClipTask | null>(null)
const tagDraft = ref<number[]>([])

async function openTagDialog(c: ClipTask): Promise<void> {
  tagDialogFor.value = c
  tagDraft.value = await clip.getTagIds(c.id)
}

async function saveTags(): Promise<void> {
  const c = tagDialogFor.value
  if (!c) return
  await clip.setTags(c.id, tagDraft.value)
  // 详情缓存里的标签也要跟着更新，否则筛选会用到旧值
  const d = detailCache.value[c.id]
  if (d) detailCache.value = { ...detailCache.value, [c.id]: { ...d, tagIds: [...tagDraft.value] } }
  else await ensureDetail(c)
  tagDialogFor.value = null
  toast('已更新片段标签', 'success')
}

function toggleDraftTag(id: number): void {
  tagDraft.value = tagDraft.value.includes(id)
    ? tagDraft.value.filter((x) => x !== id)
    : [...tagDraft.value, id]
}

/** 跳回原片对应的字幕位置（顺便让播放器跟过去） */
async function jumpToSource(c: ClipTask): Promise<void> {
  ui.setView('library')
  await subtitle.open(c.docId, undefined)
  resource.activeKey = `doc:${c.docId}`
  // 找到这条片段起点的字幕，把光标移过去
  const cue = subtitle.cues.find((x) => x.page === c.page && x.start >= c.start - 0.01)
  if (cue) {
    subtitle.setCursor(cue.index)
    subtitle.scrollToCursor()
    // 经总线让播放器跟过去（组件不直接依赖 video store）
    subtitle.followCueAt(cue.index)
  }
}

async function removeClip(c: ClipTask): Promise<void> {
  await clip.remove(c.id)
  toast(`已删除片段「${c.name}」`, 'success')
}

function tagOf(id: number): { name: string; color: string } | null {
  const t = tags.byId.get(id)
  return t ? { name: t.name, color: t.color } : null
}

function tagIdsOf(c: ClipTask): number[] {
  return detailCache.value[c.id]?.tagIds ?? []
}

const sourceLabel: Record<ClipTask['source'], string> = {
  manual: '手动',
  search: '检索',
  slice: '切片'
}
</script>

<template>
  <section class="clips-view" aria-label="片段库">
    <header class="view-head">
      <h2 class="view-title">片段库</h2>
      <span class="view-sub muted">{{ headSummary }}</span>
      <span class="grow"></span>
      <input
        v-if="tab === 'clips'"
        v-model="keyword"
        class="input"
        style="width: 200px"
        type="search"
        placeholder="搜索片段名 / 备注 / 视频标题 / 作者"
      />
      <button class="btn" @click="ui.setView('library')">返回素材库</button>
    </header>

    <!--
      页签按**业务阶段**命名（3.10.0 重命名）：
      片段库（我攒下的）→ 发现（从库里找出可用的）→ 探索（看内容之间的关系）
      → 文案模板 / 素材包（为发布做准备）。

      原来叫「推荐 / 知识图谱」：那是**实现手段**的名字，
      而用户脑子里的问题是「还有什么素材能用」「这些内容什么关系」。
      另外「推荐」容易被读成「系统推荐」，实际它是「按相似度从你的库里找伙伴」。

      五个页签都留在这一页（用户选定）：它们的产物都要回到「片段 → 输出」这条主线上，
      来回切顶层视图会打断操作。
    -->
    <nav class="stage-tabs" role="tablist" aria-label="片段库功能">
      <button
        v-for="t in STAGE_TABS"
        :key="t.key"
        type="button"
        class="stage-tab"
        :class="{ active: tab === t.key }"
        role="tab"
        :aria-selected="tab === t.key"
        :title="t.hint"
        @click="tab = t.key"
      >
        {{ t.label }}
      </button>
    </nav>

    <!-- 片段库的筛选与计数条：只属于「片段库」这个页签，所以放在页签下面而不是页头里 -->
    <div v-if="tab === 'clips'" class="clips-filters">
      <span class="muted clips-count">
        {{ visible.length }} / {{ clip.clips.length }} 个片段 · 合计 {{ formatTime(totalDuration) }}
      </span>
      <span class="grow"></span>
      <button class="btn" :class="{ primary: favoriteOnly }" @click="favoriteOnly = !favoriteOnly">
        ★ 只看收藏
      </button>
    </div>

    <RecommendView v-if="tab === 'recommend'" />
    <GraphView v-else-if="tab === 'graph'" />
    <TemplateView v-else-if="tab === 'template'" @carried="tab = 'kit'" />
    <KitView v-else-if="tab === 'kit'" />

    <template v-else>
    <!--
      筛选条：**只放下拉筛选**，搜索框在页头（3.12.0 合并）。
      原来页头与这里各有一个搜索框、绑同一个 keyword，看起来像两个不同的功能。
    -->
    <div class="clips-filters">
      <select v-model="sourceFilter" class="input" style="width: 130px" aria-label="来源筛选">
        <option value="all">全部来源</option>
        <option value="manual">手动保存</option>
        <option value="search">检索加入</option>
        <option value="slice">切片归档</option>
      </select>
      <select
        :value="tagFilter ?? ''"
        class="input"
        style="width: 150px"
        aria-label="标签筛选"
        @change="tagFilter = ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null"
      >
        <option value="">全部标签</option>
        <option v-for="t in tags.tags" :key="t.id" :value="t.id">
          {{ t.name }}（{{ t.clipCount }}）
        </option>
      </select>
    </div>

    <div v-if="!visible.length" class="empty">
      <template v-if="!clip.clips.length">
        还没有片段。<br />
        在字幕阅读区勾选若干条字幕，然后点右侧「加入切片任务」，就会在这里出现。
      </template>
      <template v-else>没有符合筛选条件的片段</template>
    </div>

    <div v-else class="clip-grid">
      <article
        v-for="c in visible"
        :key="c.id"
        class="clip-card"
        :class="{ fav: c.favorite, focused: ui.focusClipId === c.id }"
      >
        <header class="card-top">
          <input
            v-if="editingId === c.id"
            v-model="editingName"
            class="input clip-name-input"
            @keydown.enter="commitRename"
            @keydown.esc="editingId = null"
            @blur="commitRename"
          />
          <button v-else class="clip-name" :title="'双击或点此改名（当前：' + c.name + '）'" @dblclick="startRename(c)" @click="startRename(c)">
            {{ c.name }}
          </button>
          <span class="grow"></span>
          <button
            class="icon-btn"
            :class="{ on: c.favorite }"
            :title="c.favorite ? '取消收藏' : '收藏片段'"
            @click="clip.toggleFavorite(c.id)"
          >
            {{ c.favorite ? '★' : '☆' }}
          </button>
        </header>

        <div class="clip-meta muted">
          <span class="src-tag">{{ sourceLabel[c.source] }}</span>
          <span class="mono">{{ formatTime(c.start) }} → {{ formatTime(c.end) }}</span>
          <span>{{ Math.round(Math.max(0, c.end - c.start) * 10) / 10 }}s</span>
          <span>P{{ c.page }}</span>
        </div>

        <div class="clip-video muted">
          {{ detailCache[c.id]?.videoTitle || '（未知视频）' }}
          <template v-if="detailCache[c.id]?.creators?.length">
            · {{ detailCache[c.id].creators.join('、') }}
          </template>
        </div>

        <div v-if="tagIdsOf(c).length" class="clip-tags">
          <span
            v-for="id in tagIdsOf(c)"
            :key="id"
            class="tag-chip"
            :style="tagOf(id)?.color ? { background: tagOf(id)!.color, color: '#fff' } : undefined"
          >
            {{ tagOf(id)?.name ?? '已删除标签' }}
          </span>
        </div>

        <footer class="card-actions">
          <button class="btn sm" title="跳回这条片段所在的字幕位置" @click="jumpToSource(c)">
            定位
          </button>
          <button class="btn sm" @click="openTagDialog(c)">标签</button>
          <span class="grow"></span>
          <button class="btn sm danger" title="从片段库删除" @click="removeClip(c)">删除</button>
        </footer>
      </article>
    </div>

    <!-- 片段打标签 -->
    <div v-if="tagDialogFor" class="mask" @click.self="tagDialogFor = null">
      <div class="dialog" role="dialog" aria-label="给片段打标签">
        <h3 class="dlg-title">给「{{ tagDialogFor.name }}」打标签</h3>
        <div v-if="!tags.tags.length" class="empty">还没有标签，先在工作区左侧「标签」分组里新建</div>
        <div v-else class="tag-picker">
          <button
            v-for="t in tags.tags"
            :key="t.id"
            class="tag-pick"
            :class="{ on: tagDraft.includes(t.id) }"
            :style="t.color ? { '--chip': t.color } : undefined"
            @click="toggleDraftTag(t.id)"
          >
            <span class="dot"></span>{{ t.name }}
          </button>
        </div>
        <div class="dlg-actions">
          <button class="btn" @click="tagDialogFor = null">取消</button>
          <button class="btn primary" @click="saveTags">保存</button>
        </div>
      </div>
    </div>
    </template>
  </section>
</template>

<style scoped>
.clips-view {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  padding: var(--sp-5) var(--sp-6) var(--sp-7);
}

/*
 * 页签用**页签语言**而不是一排 `.btn`（3.10.0）。
 * 原来五个页签都是按钮样式、靠 `primary` 表示选中 ——
 * 于是「切换页面」和「执行动作」长得一样，而这一页里两种按钮都有。
 * 样式与全局导航、剪辑任务页保持一致。
 */
/* 页签样式见 styles/foundation.css 的 .stage-tabs / .stage-tab（全局共享） */

.clips-count {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
}

.clips-filters {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}

.clip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--sp-4);
}

.clip-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: var(--panel-2);
  min-width: 0;
}

.clip-card.fav {
  border-color: var(--accent);
}

/* 从首页点进来的那条：闪一下边框，告诉用户「就是它」 */
.clip-card.focused {
  box-shadow: 0 0 0 2px var(--accent);
}

.card-top {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.clip-name {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-md);
  font-weight: 600;
  text-align: left;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
}

.clip-name-input {
  flex: 1 1 auto;
  min-width: 0;
}

.icon-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: var(--fs-lg);
  color: var(--text-dim);
  padding: 2px var(--sp-1);
}

.icon-btn.on {
  color: #f59e0b;
}

.clip-meta,
.clip-video {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
}

.clip-video {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.src-tag {
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  padding: 0 4px;
}

.mono {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.clip-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}

.tag-chip {
  font-size: var(--fs-xs);
  padding: 1px var(--sp-2);
  border-radius: 999px;
  background: var(--border);
  color: var(--text);
}

.card-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: 4px;
}

.mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.dialog {
  width: min(520px, 92vw);
  max-height: 80vh;
  overflow: auto;
  background: var(--panel);
  border-radius: var(--radius);
  padding: var(--sp-5);
  border: 1px solid transparent;
}

.dlg-title {
  margin: 0 0 12px;
  font-size: var(--fs-lg);
}

.tag-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}

.tag-pick {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: var(--fs-sm);
}

.tag-pick .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--chip, var(--accent));
}

.tag-pick.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--bg));
}

.dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-3);
}

.btn.danger {
  color: var(--danger);
}
</style>
