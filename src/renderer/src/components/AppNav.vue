<script setup lang="ts">
/**
 * 全局导航组件（3.5.0）。
 *
 * ## 解决什么问题
 *
 * 原来顶栏是一排**同级的 `.btn`**，把三种性质完全不同的东西混在一起：
 * - **一级导航**：工作台 / 素材库 / 字幕检索 / 片段库 / 剪辑任务 —— 切换主页面；
 * - **动作**：导入 SRT / 拉取字幕 —— 做一件事，不切换页面；
 * - **工具**：重置布局 / 主题 —— 局部或全局设置。
 *
 * 而且导航用的是「再点一次返回工作区」的 toggle 语义，与页签语义冲突：
 * 用户点「片段库」时预期是「去片段库」，不是「切过去 / 再点回来」。
 *
 * 现在：导航是**纯切换**（点当前项不做任何事），动作与工具移到右侧动作区，
 * 三者在视觉上也明确区分（导航是页签样式，动作是按钮样式）。
 */
import type { AppNavKey } from '../stores/ui'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()

/**
 * 一级导航项。
 *
 * 顺序按用户的**主流程**排：获取素材 → 检索内容 → 攒下片段 → 输出成片，
 * 最后是概览。工作台放在最后而不是最前，是因为它是「回看进度」的地方，
 * 而日常操作是从素材库开始的（打开某个视频）。
 */
const NAV_ITEMS: Array<{ key: AppNavKey; label: string; hint: string }> = [
  { key: 'library', label: '素材库', hint: '视频与字幕资源：浏览、导入、拉取字幕' },
  { key: 'search', label: '字幕检索', hint: '跨视频检索字幕内容（关键词 / 语义）' },
  { key: 'clips', label: '片段库', hint: '已保存的片段：命名、标签、收藏、复用' },
  { key: 'clipjobs', label: '剪辑任务', hint: '把片段输出成视频：待处理 / 进行中 / 已完成' },
  { key: 'home', label: '工作台', hint: '概览：最近视频、最近片段、待处理任务' }
]
</script>

<template>
  <nav class="app-nav" aria-label="主导航">
    <button
      v-for="item in NAV_ITEMS"
      :key="item.key"
      type="button"
      class="app-nav-item"
      :class="{ active: ui.view === item.key }"
      :aria-current="ui.view === item.key ? 'page' : undefined"
      :title="item.hint"
      @click="ui.setView(item.key)"
    >
      {{ item.label }}
    </button>
  </nav>
</template>

<style scoped>
/*
 * 导航用**页签**样式而不是按钮样式：这是一级导航的通用语言
 * （浏览器、IDE、办公软件都这样），而按钮只用于「做一件事」。
 */
.app-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.app-nav-item {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-base);
  font-weight: var(--fw-medium);
  height: var(--h-lg);
  padding: 0 var(--sp-4);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s var(--ease), color 0.14s var(--ease);
}

.app-nav-item:hover:not(.active) {
  background: var(--row-hover);
  color: var(--text);
}

/*
 * 选中态用「底色 + 主色文字」而不是纯色块：
 * 顶栏是长时间停留的区域，满色块会让整条栏过重、抢走内容区的注意力。
 */
.app-nav-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.app-nav-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
