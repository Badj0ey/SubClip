<script setup lang="ts">
/**
 * 全库检索：一次搜遍库里所有视频 / 分P 的字幕。
 *
 * 这是本工具叫「字幕检索」的本体 —— 中间阅读区的搜索只作用于**当前打开的文档**，
 * 这里才是跨文档的。命中可以直接批量加入切片任务。
 *
 * ## 第四阶段的改动
 *
 * 1. **排序有说法**：标题命中 > 字幕文件名命中 > 正文命中（主进程 SQL 里加权），
 *    结果左侧会标出是哪一类，不再是一堆同权重的裸句子。
 * 2. **筛选条**（默认收起）：UP主范围 / 标签 / 只看收藏 / 入库时间 / 字幕时长。
 *    全部下推到 SQL —— 先取 200 条再在界面过滤会把目标挡在 200 名之外。
 * 3. **分页**：一次 100 条，底部「加载更多」；顶栏显示「已显示 M / 共 N 条」。
 */
import { computed, onMounted, ref } from 'vue'
import type { CueSearchHit } from '@shared/types'
import { formatTime } from '@shared/time'
import { useSearchStore } from '../stores/search'
import { useSemanticStore } from '../stores/semantic'
import { useTagsStore } from '../stores/tags'
import { useUiStore } from '../stores/ui'
import { toast } from '../store'

const search = useSearchStore()
const semantic = useSemanticStore()
const tags = useTagsStore()
const ui = useUiStore()

/** 检索方式（第四阶段下半加语义）：关键词 / 按意思 */
const mode = ref<'keyword' | 'semantic'>('keyword')

/** 筛选条默认收起，需要时再展开（不挤占结果区域） */
const filtersOpen = ref(false)

onMounted(() => {
  void tags.load()
  void semantic.refresh()
})

function switchMode(next: 'keyword' | 'semantic'): void {
  mode.value = next
  if (next === 'semantic') void semantic.refresh()
}

async function runSemantic(): Promise<void> {
  await semantic.run()
}

const results = computed(() => search.results)
const selectedCount = computed(() => search.selectedCount())

/** 检索范围的显示名（让「仅当前视频 / 仅当前分组」在摘要里可读） */
const scopeLabel = computed(() => {
  const map: Record<string, string> = {
    all: '全部字幕',
    video: '仅当前视频',
    collection: '仅当前分组'
  }
  return map[search.scope] ?? search.scope
})

async function searchNow(): Promise<void> {
  await search.run()
  if (search.done && !search.results.length) toast('没有匹配的字幕', 'info')
}

function clearFilters(): void {
  search.resetFilters()
  toast('已清除筛选条件', 'info')
}

/** 把命中文本按键分词，前端自己拼 <mark>（不用 v-html，避免注入） */
function segments(text: string): Array<{ hit: boolean; text: string }> {
  const kw = search.keyword.trim()
  if (!kw) return [{ hit: false, text }]
  const out: Array<{ hit: boolean; text: string }> = []
  let rest = text
  for (;;) {
    const at = rest.indexOf(kw)
    if (at < 0) {
      if (rest) out.push({ hit: false, text: rest })
      break
    }
    if (at > 0) out.push({ hit: false, text: rest.slice(0, at) })
    out.push({ hit: true, text: kw })
    rest = rest.slice(at + kw.length)
  }
  return out
}

/** 命中位置的中文说明（解释为什么这条排得靠前） */
const WEIGHT_LABEL: Record<number, string> = {
  3: '标题命中',
  2: '字幕文件名命中',
  1: '正文命中'
}

function weightLabel(hit: CueSearchHit): string {
  return WEIGHT_LABEL[hit.hitWeight ?? 1] ?? '正文命中'
}
</script>

<template>
  <section class="search-view">
    <!--
      页头（3.9.0）：这一页以前没有标题，进来只有一排控件，看不出是什么页面 / 结果多少。
      标题 + 一行摘要（命中数 / 已加载 / 范围 / 筛选）让状态一眼可见。
    -->
    <header class="view-head">
      <h2 class="view-title">字幕检索</h2>
      <span v-if="mode === 'keyword'" class="view-sub muted">
        <template v-if="search.done">
          命中 {{ search.total }}{{ search.totalCapped ? '+' : '' }} 条 · 已加载 {{ results.length }}
          <template v-if="search.scope !== 'all'"> · {{ scopeLabel }}</template>
          <template v-if="search.hasActiveFilters"> · 已筛选</template>
        </template>
        <template v-else>搜整个素材库的字幕内容（跨视频 / 跨分P）</template>
      </span>
      <span v-else class="view-sub muted">按意思找：用一句话描述想要的内容</span>
      <span class="grow"></span>
      <button class="btn" @click="ui.setView('library')">返回素材库</button>
    </header>

    <header class="search-bar">
      <!-- 检索方式：关键词（FTS5）/ 按意思（本地 Embedding） -->
      <div class="mode-switch" role="tablist" aria-label="检索方式">
        <button
          class="mode-btn"
          :class="{ on: mode === 'keyword' }"
          role="tab"
          :aria-selected="mode === 'keyword'"
          title="全文检索：知道要找哪个词时最快最准"
          @click="switchMode('keyword')"
        >
          关键词
        </button>
        <button
          class="mode-btn"
          :class="{ on: mode === 'semantic' }"
          role="tab"
          :aria-selected="mode === 'semantic'"
          title="语义检索：按意思找（需要先下载模型并建索引）"
          @click="switchMode('semantic')"
        >
          按意思
        </button>
      </div>

      <input
        v-if="mode === 'keyword'"
        v-model="search.keyword"
        class="input grow"
        type="search"
        placeholder="在整个字幕库里搜索（例如某个词、某句话）"
        @keydown.enter.prevent="searchNow"
      />
      <input
        v-else
        v-model="semantic.keyword"
        class="input grow"
        type="search"
        placeholder="用一句话描述你想找的内容（例如：怎么把长视频切成短视频）"
        @keydown.enter.prevent="runSemantic"
      />

      <select v-if="mode === 'keyword'" v-model="search.scope" class="input" style="width: 150px">
        <option value="all">全部字幕</option>
        <option value="video">仅当前视频</option>
        <option value="collection">仅当前分组</option>
      </select>

      <button
        v-if="mode === 'keyword'"
        class="btn primary"
        :disabled="search.searching"
        @click="searchNow"
      >
        {{ search.searching ? '检索中…' : '检索' }}
      </button>
      <button v-else class="btn primary" :disabled="semantic.searching" @click="runSemantic">
        {{ semantic.searching ? '搜索中…' : '按意思搜' }}
      </button>

      <button
        v-if="mode === 'keyword'"
        class="btn"
        :class="{ primary: filtersOpen || search.hasActiveFilters }"
        title="按标签 / 收藏 / 时间 / 时长筛选"
        @click="filtersOpen = !filtersOpen"
      >
        筛选{{ search.hasActiveFilters ? ' ·' : '' }}
      </button>
    </header>

    <!-- 语义模式的索引状态提示 -->
    <div v-if="mode === 'semantic'" class="semantic-bar">
      <template v-if="!semantic.status.modelReady">
        <span class="muted">语义检索需要先下载模型（约 95MB，只需一次）。</span>
        <button class="btn sm primary" @click="semantic.downloadModel()">下载模型</button>
        <button class="btn sm" @click="ui.setView('settings')">去设置</button>
      </template>
      <template v-else>
        <span class="muted">
          索引：{{ semantic.status.indexedChunks }} / {{ semantic.status.totalChunks }} 段
          <template v-if="semantic.status.indexing">
            · 正在建（{{ semantic.progress }}%）· {{ semantic.status.message }}
          </template>
        </span>
        <button v-if="!semantic.status.indexing" class="btn sm" @click="semantic.startIndex()">
          继续建索引
        </button>
        <button v-else class="btn sm" @click="semantic.stopIndex()">暂停</button>
      </template>
    </div>

    <!-- 高级筛选（第四阶段） -->
    <div v-if="filtersOpen && mode === 'keyword'" class="search-filters">
      <div class="filter-row">
        <span class="filter-label">标签</span>
        <div class="tag-picks">
          <button
            v-for="t in tags.tags"
            :key="t.id"
            class="tag-pick"
            :class="{ on: search.filters.tagIds.includes(t.id) }"
            :style="t.color ? { '--chip': t.color } : undefined"
            @click="search.toggleTagFilter(t.id)"
          >
            <span class="dot"></span>{{ t.name }}（{{ t.videoCount }}）
          </button>
          <span v-if="!tags.tags.length" class="muted" style="font-size: var(--fs-sm)">
            还没有标签（在资源树「标签」分组里新建）
          </span>
        </div>
      </div>

      <div class="filter-row">
        <span class="filter-label">其它</span>
        <label class="filter-check">
          <input
            type="checkbox"
            :checked="search.filters.favoriteOnly"
            @change="search.filters.favoriteOnly = ($event.target as HTMLInputElement).checked"
          />
          只看收藏的视频
        </label>
        <span class="filter-label" style="margin-left: 8px">入库时间</span>
        <input v-model="search.filters.createdFrom" class="input" type="date" style="width: 140px" />
        <span class="muted">→</span>
        <input v-model="search.filters.createdTo" class="input" type="date" style="width: 140px" />
        <span class="filter-label" style="margin-left: 8px">字幕时长</span>
        <input
          v-model.number="search.filters.minDuration"
          class="input"
          type="number"
          min="0"
          step="0.5"
          placeholder="最少秒"
          style="width: 90px"
        />
        <span class="muted">→</span>
        <input
          v-model.number="search.filters.maxDuration"
          class="input"
          type="number"
          min="0"
          step="0.5"
          placeholder="最多秒"
          style="width: 90px"
        />
        <span class="grow"></span>
        <button class="btn sm" :disabled="!search.hasActiveFilters" @click="clearFilters">
          清除筛选
        </button>
      </div>
      <div class="muted" style="font-size: var(--fs-sm); margin-top: 4px">
        筛选条件改完后再点一次「检索」生效（避免每敲一个字就打一次库）。
      </div>
    </div>

    <div v-if="mode === 'keyword'" class="search-meta">
      <template v-if="search.done">
        命中 <strong>{{ search.total }}{{ search.totalCapped ? '+' : '' }}</strong> 条
        <template v-if="search.results.length < search.total">
          · 已显示 <strong>{{ search.results.length }}</strong> 条
        </template>
        <template v-if="search.scope !== 'all'">
          · 范围：{{ search.scope === 'video' ? '当前视频' : '当前分组' }}
        </template>
        <template v-if="search.hasActiveFilters"> · 已启用筛选</template>
        <span class="muted"> · 排序：标题 &gt; 字幕文件名 &gt; 正文</span>
        <template v-if="search.totalCapped">
          · <span class="warn-text">命中过多，已截断统计：加个标签 / 时长筛选会准得多</span>
        </template>
      </template>
      <template v-else>输入关键词后回车或点「检索」。检索范围默认是整个字幕库。</template>
    </div>

    <!-- 语义模式：结果与说明 -->
    <template v-if="mode === 'semantic'">
      <div class="search-meta">
        <template v-if="semantic.done">
          按意思命中 <strong>{{ semantic.hits.length }}</strong> 段
          <template v-if="semantic.partial">
            · <span class="warn-text">索引还没建完（{{ semantic.status.indexedChunks }}/{{ semantic.status.totalChunks }}），结果可能不全</span>
          </template>
        </template>
        <template v-else>
          语义检索看的是**意思**而不是字面：搜「怎么剪短视频」也能命中完全不含这几个字的段落。
          相似度是余弦值（0~1，越大越像）。
        </template>
      </div>

      <div class="search-list">
        <div v-if="!semantic.hits.length" class="empty">
          {{ semantic.done ? '没有相近的段落' : '输入一句话后回车或点「按意思搜」' }}
        </div>
        <div v-for="hit in semantic.hits" :key="`${hit.docId}:${hit.start}`" class="search-hit">
          <div class="hit-main" @click="semantic.jump(hit)">
            <div class="hit-text">
              <span class="hit-badge" :title="`余弦相似度 ${hit.score}`">{{ hit.score.toFixed(3) }}</span>
              {{ hit.text }}
            </div>
            <div class="hit-meta">
              <span v-if="hit.uploaderName">{{ hit.uploaderName }}</span>
              <span class="sep">·</span>
              <span>{{ hit.videoTitle }}</span>
              <span class="sep">·</span>
              <span>P{{ hit.page }}</span>
              <span class="sep">·</span>
              <span>{{ formatTime(hit.start) }} → {{ formatTime(hit.end) }}</span>
              <span v-if="hit.bvid" class="sep">·</span>
              <span v-if="hit.bvid" class="muted">{{ hit.bvid }}</span>
            </div>
          </div>
          <button class="btn sm" title="把这段加入切片任务" @click="semantic.enqueue(hit)">加入</button>
        </div>
      </div>
    </template>

    <!-- ------------------------------ 关键词模式 ------------------------------ -->
    <template v-if="mode === 'keyword'">
      <!--
        结果工具条（3.9.0 移到结果区正上方）：
        它操作的是**下面的结果**，所以必须紧贴结果 —— 原来夹在筛选面板与列表之间，
        勾选后要向上找按钮，视线来回跳。
      -->
      <div v-if="results.length" class="result-tools">
        <button class="btn sm" @click="search.selectAll()">
          全选（已加载的 {{ results.length }} 条）
        </button>
        <button class="btn sm" :disabled="!selectedCount" @click="search.clearSelected()">
          清空选择
        </button>
        <span v-if="selectedCount" class="muted result-sel">已选 {{ selectedCount }}</span>
        <span class="grow"></span>
        <span class="muted">备注前缀</span>
        <input
          v-model="search.notePrefix"
          class="input"
          style="width: 130px"
          placeholder="检索"
          title="加入切片任务时用作输出文件名前缀"
        />
        <button class="btn primary" :disabled="!selectedCount" @click="search.enqueueSelected()">
          把选中的 {{ selectedCount }} 条加入切片任务
        </button>
      </div>

    <div class="search-list">
      <div v-if="!results.length" class="empty">
        {{ search.done ? '没有匹配的字幕' : '还没有检索结果' }}
      </div>
      <div
        v-for="hit in results"
        :key="search.key(hit)"
        class="search-hit"
        :class="{ on: search.selected.has(search.key(hit)) }"
      >
        <input
          type="checkbox"
          :checked="search.selected.has(search.key(hit))"
          @change="search.toggle(hit)"
        />
        <div class="hit-main" @click="search.jump(hit)">
          <div class="hit-text">
            <span
              v-if="(hit.hitWeight ?? 1) > 1"
              class="hit-badge"
              :title="`关键词出现在${weightLabel(hit)}里，所以排在前面`"
            >
              {{ weightLabel(hit) }}
            </span>
            <span v-for="(seg, i) in segments(hit.text)" :key="i" :class="{ mark: seg.hit }">{{
              seg.text
            }}</span>
          </div>
          <div class="hit-meta">
            <span v-if="hit.uploaderName">{{ hit.uploaderName }}</span>
            <span class="sep">·</span>
            <span>{{ hit.videoTitle }}</span>
            <span class="sep">·</span>
            <span>P{{ hit.page }}</span>
            <span class="sep">·</span>
            <span>{{ formatTime(hit.start) }} → {{ formatTime(hit.end) }}</span>
            <span class="sep">·</span>
            <span>{{ Math.round((hit.end - hit.start) * 10) / 10 }}s</span>
            <span v-if="hit.bvid" class="sep">·</span>
            <span v-if="hit.bvid" class="muted">{{ hit.bvid }}</span>
          </div>
        </div>
      </div>

      <div v-if="search.hasMore" class="load-more">
        <button class="btn" :disabled="search.searching" @click="search.loadMore()">
          {{ search.searching ? '加载中…' : `加载更多（还有 ${search.total - search.results.length} 条）` }}
        </button>
      </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.search-view {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: var(--sp-4) var(--sp-5) 0;
  overflow: hidden;
}

.search-bar {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
  margin-bottom: var(--sp-3);
}

/*
 * 页头（`.view-head` / `.view-title` / `.view-sub`）见 styles/foundation.css ——
 * 3.10.0 起它属于**页面骨架**、多页面共享，组件里不再各写一份
 *（各写一份的下场就是两个页面的标题字号/间距慢慢长歪）。
 */

/*
 * 结果工具条：紧贴结果区上方，加背景与分隔线，
 * 让「它管的是下面这份列表」在视觉上成立（原来夹在筛选面板与列表之间，视线要来回找）。
 */
.result-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
  margin-bottom: var(--sp-2);
  border-bottom: 1px solid var(--hairline);
  flex-wrap: wrap;
}

.result-sel {
  font-size: var(--fs-sm);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/*
 * 检索方式切换（关键词 / 按意思）
 *
 * 3.13.0：选中态从「主题色实心块」改为「浅色底 + 主题色文字」——
 * 与页签、导航的选中语言统一（这套界面里选中态到处都是，
 * 实心色块铺开会把内容压下去）。
 */
.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  /* 容器用抬升面：比页面背景亮一档，让「一组的两个选项」有整体感 */
  background: var(--panel);
  flex: 0 0 auto;
}

.mode-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: var(--sp-1) var(--sp-4);
  border-radius: var(--radius-xs);
  font-size: var(--fs-base);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition:
    background 0.14s var(--ease),
    color 0.14s var(--ease);
}

.mode-btn:hover:not(.on) {
  color: var(--text);
}

.mode-btn.on {
  background: var(--panel-2);
  color: var(--accent);
}

/* 语义模式的索引状态条 */
.semantic-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
  padding: var(--sp-2) var(--sp-3);
  margin-bottom: var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel);
}

.search-filters {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: var(--sp-3) var(--sp-4);
  margin-bottom: var(--sp-3);
  background: var(--panel);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  margin-bottom: var(--sp-2);
}

.filter-label {
  font-size: var(--fs-sm);
  color: var(--text-dim);
}

.filter-check {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-base);
}

.tag-picks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.tag-pick {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 3px var(--sp-3);
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

.search-meta {
  font-size: var(--fs-sm);
  color: var(--text-dim);
  margin-bottom: var(--sp-3);
}

.warn-text {
  color: var(--danger);
}

.search-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.search-list {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
  padding-bottom: 16px;
}

.search-hit {
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-bottom: 1px solid var(--hairline);
}

.search-hit.on {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.hit-main {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}

.hit-text {
  font-size: var(--fs-md);
  line-height: 1.6;
  word-break: break-all;
}

.hit-badge {
  display: inline-block;
  margin-right: var(--sp-2);
  padding: 0 var(--sp-1);
  border-radius: var(--radius-xs);
  font-size: var(--fs-xs);
  border: 1px solid var(--accent);
  color: var(--accent);
  vertical-align: 1px;
}

.hit-text .mark {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: var(--radius-xs);
}

.hit-meta {
  font-size: var(--fs-sm);
  color: var(--text-dim);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit-meta .sep {
  margin: 0 2px;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: var(--sp-4) 0 var(--sp-1);
}
</style>
