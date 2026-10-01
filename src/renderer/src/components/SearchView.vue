<script setup lang="ts">
/**
 * 全库检索：一次搜遍库里所有视频 / 分P 的字幕。
 *
 * 这是本工具叫「字幕检索」的本体 —— 中间阅读区的搜索只作用于**当前打开的文档**，
 * 这里才是跨文档的。命中可以直接批量加入切片任务。
 */
import { computed } from 'vue'
import type { CueSearchHit } from '@shared/types'
import { formatTime } from '@shared/time'
import {
  clearSearchHits,
  enqueueSearchHits,
  openSearchHit,
  runLibrarySearch,
  searchHitKey,
  searchSelectedHits,
  selectAllSearchHits,
  state,
  toast,
  toggleSearchHit
} from '../store'

const results = computed(() => state.searchResults)
const selectedCount = computed(() => searchSelectedHits.value.length)

/** 把命中文本按键分词，前端自己拼 <mark>（不用 v-html，避免注入） */
function segments(text: string): Array<{ hit: boolean; text: string }> {
  const kw = state.searchKeyword.trim()
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

async function search(): Promise<void> {
  await runLibrarySearch()
  if (!state.searchResults.length) toast('没有匹配的字幕', 'info')
}

async function openHit(hit: CueSearchHit): Promise<void> {
  await openSearchHit(hit)
}
</script>

<template>
  <section class="search-view">
    <header class="search-bar">
      <input
        v-model="state.searchKeyword"
        class="input grow"
        type="search"
        placeholder="在整个字幕库里搜索（例如某个词、某句话）"
        @keydown.enter.prevent="search"
      />
      <select v-model="state.searchScope" class="input" style="width: 150px">
        <option value="all">全部字幕</option>
        <option value="video">仅当前视频</option>
        <option value="collection">仅当前分组</option>
      </select>
      <button class="btn primary" :disabled="state.searching" @click="search">
        {{ state.searching ? '检索中…' : '检索' }}
      </button>
      <button class="btn" @click="state.view = 'library'">返回工作区</button>
    </header>

    <div class="search-meta">
      <template v-if="state.searchDone">
        命中 <strong>{{ results.length }}</strong> 条
        <template v-if="results.length >= 500">（已达单次上限 500 条，请换更精确的关键词）</template>
        <template v-if="state.searchScope !== 'all'">
          · 范围：{{ state.searchScope === 'video' ? '当前视频' : '当前分组' }}
        </template>
      </template>
      <template v-else>输入关键词后回车或点「检索」。检索范围默认是整个字幕库。</template>
    </div>

    <div v-if="results.length" class="search-tools">
      <button class="btn sm" @click="selectAllSearchHits">全选</button>
      <button class="btn sm" :disabled="!selectedCount" @click="clearSearchHits">清空选择</button>
      <span class="grow"></span>
      <span class="muted" style="font-size: 12px">备注前缀</span>
      <input
        v-model="state.searchNotePrefix"
        class="input"
        style="width: 130px"
        placeholder="检索"
        title="加入切片任务时用作输出文件名前缀"
      />
      <button class="btn primary" :disabled="!selectedCount" @click="enqueueSearchHits">
        把选中的 {{ selectedCount }} 条加入切片任务
      </button>
    </div>

    <div class="search-list">
      <div v-if="!results.length" class="empty">
        {{ state.searchDone ? '没有匹配的字幕' : '还没有检索结果' }}
      </div>
      <div
        v-for="hit in results"
        :key="searchHitKey(hit)"
        class="search-hit"
        :class="{ on: state.searchSelected.has(searchHitKey(hit)) }"
      >
        <input
          type="checkbox"
          :checked="state.searchSelected.has(searchHitKey(hit))"
          @change="toggleSearchHit(hit)"
        />
        <div class="hit-main" @click="openHit(hit)">
          <div class="hit-text">
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
            <span v-if="hit.bvid" class="sep">·</span>
            <span v-if="hit.bvid" class="muted">{{ hit.bvid }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.search-view {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 14px;
  gap: 8px;
  overflow: hidden;
}

.search-bar,
.search-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.search-meta {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-dim);
}

.search-list {
  flex: 1 1 auto;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.search-hit {
  display: flex;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  align-items: flex-start;
}

.search-hit:last-child {
  border-bottom: none;
}

.search-hit:hover {
  background: var(--hover);
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
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

.hit-text .mark {
  background: var(--accent);
  color: #fff;
  border-radius: 3px;
  padding: 0 2px;
}

.hit-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.hit-meta .sep {
  opacity: 0.5;
}
</style>
