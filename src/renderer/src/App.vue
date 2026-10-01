<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { DEFAULT_SHORTCUTS, resolveAction } from '@shared/shortcuts'
import {
  applyTheme,
  clearSelection,
  enqueueCurrentRanges,
  exportSlice,
  initApp,
  moveCursor,
  requestEditCurrent,
  scrollToCursor,
  selectAll,
  state,
  toggleSelect,
  toast,
  undoLastEdit
} from './store'
import ResourceTree from './components/ResourceTree.vue'
import SubtitleReader from './components/SubtitleReader.vue'
import ClipPanel from './components/ClipPanel.vue'
import SettingsView from './components/SettingsView.vue'
import SearchView from './components/SearchView.vue'
import ImportDialog from './components/ImportDialog.vue'
import PullDialog from './components/PullDialog.vue'

const showImport = ref(false)
const showPull = ref(false)

const themeLabel: Record<string, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统'
}

const pluginOnline = computed(() => (state.bridge?.clients.length ?? 0) > 0)
const pluginTitle = computed(() => {
  const b = state.bridge
  if (!b) return '插件通信服务状态未知'
  if (!b.running) return b.error ? `服务未运行：${b.error}` : '插件通信服务未运行'
  if (!b.clients.length) return `服务运行中（ws://127.0.0.1:${b.port}），暂无插件连接`
  const c = b.clients[0]
  return `已连接 ${b.clients.length} 个插件（${c.browser} v${c.version}）`
})

const shortcuts = computed(() => state.settings?.shortcuts ?? DEFAULT_SHORTCUTS)

/* ------------------------------- 面板宽度拖拽 ------------------------------ */

const treeWidth = ref(290)
const taskWidth = ref(380)
const dragging = ref<'left' | 'right' | null>(null)

watch(
  () => state.settings,
  (s) => {
    if (!s) return
    treeWidth.value = s.treePaneWidth || 290
    taskWidth.value = s.taskPaneWidth || 380
  },
  { immediate: true }
)

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function startDrag(which: 'left' | 'right', e: MouseEvent): void {
  e.preventDefault()
  dragging.value = which
  const startX = e.clientX
  const startW = which === 'left' ? treeWidth.value : taskWidth.value

  const onMove = (ev: MouseEvent): void => {
    const delta = ev.clientX - startX
    if (which === 'left') treeWidth.value = clamp(startW + delta, 200, 560)
    else taskWidth.value = clamp(startW - delta, 280, 680)
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    dragging.value = null
    void window.api.saveSettings({
      treePaneWidth: treeWidth.value,
      taskPaneWidth: taskWidth.value
    })
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function resetPaneWidths(): void {
  treeWidth.value = 290
  taskWidth.value = 380
  void window.api.saveSettings({ treePaneWidth: 290, taskPaneWidth: 380 })
}

/* --------------------------------- 生命周期 -------------------------------- */

onMounted(async () => {
  await initApp()
  window.addEventListener('keydown', onKey)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onSystemTheme)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', onSystemTheme)
})

function onSystemTheme(): void {
  if (state.settings?.theme === 'system') applyTheme('system')
}

async function toggleTheme(): Promise<void> {
  if (!state.settings) return
  const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
  const next = order[(order.indexOf(state.settings.theme) + 1) % order.length]
  state.settings = await window.api.saveSettings({ theme: next })
  applyTheme(next)
}

/* --------------------------------- 快捷键 --------------------------------- */

function onKey(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null
  const typing =
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

  const action = resolveAction(e, shortcuts.value)
  if (!action) return

  if (typing) {
    // 输入状态下只允许「清空搜索框」这一条，其余交给输入框自己处理
    if (action === 'clearSelection' && el?.id === 'search-input') {
      const input = el as HTMLInputElement
      if (input.value) {
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        input.blur()
      }
      e.preventDefault()
    }
    return
  }

  // 全库检索在任何视图下都能用（包括正在输入时）
  if (action === 'librarySearch') {
    e.preventDefault()
    state.view = state.view === 'search' ? 'library' : 'search'
    return
  }

  if (state.view !== 'library' && action !== 'focusSearch') return

  switch (action) {
    case 'focusSearch':
      e.preventDefault()
      if (state.view === 'library') document.getElementById('search-input')?.focus()
      break
    case 'nextCue':
      e.preventDefault()
      moveCursor(1, false)
      scrollToCursor()
      break
    case 'prevCue':
      e.preventDefault()
      moveCursor(-1, false)
      scrollToCursor()
      break
    case 'extendNext':
      e.preventDefault()
      moveCursor(1, true)
      scrollToCursor()
      break
    case 'extendPrev':
      e.preventDefault()
      moveCursor(-1, true)
      scrollToCursor()
      break
    case 'toggleSelect':
      e.preventDefault()
      toggleSelect(state.cursor)
      break
    case 'editCue':
      e.preventDefault()
      requestEditCurrent()
      break
    case 'selectAll':
      e.preventDefault()
      selectAll()
      break
    case 'clearSelection':
      e.preventDefault()
      clearSelection()
      break
    case 'addClip':
      e.preventDefault()
      void enqueueCurrentRanges()
      break
    case 'exportCsv':
      e.preventDefault()
      void exportSlice('csv')
      break
    case 'undoEdit':
      e.preventDefault()
      void undoLastEdit()
      break
    default:
      break
  }
}

function onImported(): void {
  showImport.value = false
  toast('导入完成', 'success')
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <span class="title">SRT 字幕检索与视频切片辅助工具</span>

      <span class="plugin-badge" :class="{ on: pluginOnline }" :title="pluginTitle">
        {{ pluginOnline ? '🔌 已连接' : '🔌 未连接' }}
      </span>

      <button class="btn" title="导入本地 SRT 字幕文件" @click="showImport = true">导入 SRT</button>
      <button
        class="btn primary"
        title="从视频 / 合集 / 系列 / 收藏夹 / UP主主页拉取字幕"
        @click="showPull = true"
      >
        拉取字幕
      </button>
      <button
        class="btn"
        :class="{ primary: state.view === 'search' }"
        :title="`全库检索：搜库里所有视频的字幕（${shortcuts.librarySearch || 'Ctrl+Shift+F'}）`"
        @click="state.view = state.view === 'search' ? 'library' : 'search'"
      >
        全库检索
      </button>

      <span class="grow"></span>

      <button class="btn sm" title="恢复默认面板宽度" @click="resetPaneWidths">重置布局</button>
      <button
        class="btn"
        @click="state.view = state.view === 'settings' ? 'library' : 'settings'"
      >
        {{ state.view === 'settings' ? '← 返回工作区' : '设置' }}
      </button>
      <button
        class="btn icon"
        :title="`主题：${themeLabel[state.settings?.theme ?? 'system']}`"
        @click="toggleTheme"
      >
        {{ state.settings?.theme === 'dark' ? '🌙' : state.settings?.theme === 'light' ? '☀️' : '🌓' }}
      </button>
    </header>

    <div
      class="main"
      :style="{ '--tree-w': `${treeWidth}px`, '--task-w': `${taskWidth}px` }"
    >
      <template v-if="state.view === 'library'">
        <ResourceTree />
        <div
          class="resizer"
          :class="{ active: dragging === 'left' }"
          title="拖动调整宽度"
          @mousedown="startDrag('left', $event)"
        ></div>
        <SubtitleReader />
        <div
          class="resizer"
          :class="{ active: dragging === 'right' }"
          title="拖动调整宽度"
          @mousedown="startDrag('right', $event)"
        ></div>
        <ClipPanel />
      </template>
      <SearchView v-else-if="state.view === 'search'" />
      <SettingsView v-else />
    </div>

    <ImportDialog v-if="showImport" @close="showImport = false" @done="onImported" />
    <PullDialog v-if="showPull" @close="showPull = false" />

    <div v-if="state.toast.visible" class="toast" :class="state.toast.type">
      {{ state.toast.text }}
    </div>
  </div>
</template>
