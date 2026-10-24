<script setup lang="ts">
import type { AppNavKey } from '../stores/ui'
import { useUiStore } from '../stores/ui'
import UiIcon from './UiIcon.vue'

const ui = useUiStore()
const items = [
  { key: 'home', label: '工作台', icon: 'home', hint: '查看最近素材、收藏和任务' },
  { key: 'library', label: '素材库', icon: 'library', hint: '查看和编辑视频字幕' },
  { key: 'search', label: '字幕检索', icon: 'search', hint: '按关键词或语义查找字幕' },
  { key: 'clips', label: '片段库', icon: 'scissors', hint: '管理片段和发布素材' },
  { key: 'clipjobs', label: '剪辑任务', icon: 'queue', hint: '查看导出进度和历史记录' }
] as const satisfies ReadonlyArray<{
  key: AppNavKey; label: string; icon: 'home' | 'library' | 'search' | 'scissors' | 'queue'; hint: string
}>
</script>

<template>
  <nav class="app-nav" aria-label="主导航">
    <button
      v-for="item in items"
      :key="item.key"
      class="app-nav-item"
      type="button"
      :class="{ active: ui.view === item.key }"
      :aria-current="ui.view === item.key ? 'page' : undefined"
      :title="item.hint"
      @click="ui.setView(item.key)"
    >
      <UiIcon :name="item.icon" :size="16" />
      <span>{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.app-nav { display: flex; align-items: center; gap: 3px; min-width: 0; }
.app-nav-item {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 38px; padding: 0 12px; border: 1px solid transparent;
  border-radius: 10px; color: var(--text-dim); background: transparent;
  font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
  white-space: nowrap; transition: background .16s ease, color .16s ease;
}
.app-nav-item:hover:not(.active) { background: var(--row-hover); color: var(--text); }
.app-nav-item.active { background: var(--accent-soft); color: var(--accent); }
.app-nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 1310px) {
  .app-nav-item { padding: 0 9px; gap: 6px; font-size: 12px; }
}
@media (max-width: 1170px) {
  .app-nav-item { padding: 0 8px; }
  .app-nav-item svg { display: none; }
}
</style>
