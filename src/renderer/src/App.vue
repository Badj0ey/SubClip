<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { DEFAULT_SHORTCUTS, resolveAction } from '@shared/shortcuts'
import type { CommandId } from '@shared/commands'
import {
  applyTheme, clearSelection, enqueueCurrentRanges, exportSlice, importDroppedSrt,
  initApp, moveCursor, redoLastEdit, requestEditCurrent, scrollToCursor,
  selectAll, state, toggleSelect, toast, undoLastEdit
} from './store'
import { usePaneLayout } from './composables/usePaneLayout'
import { useVideoStore } from './stores/video'
import { useSubtitleStore } from './stores/subtitle'
import { useUiStore } from './stores/ui'
import ResourceTree from './components/ResourceTree.vue'
import SubtitleReader from './components/SubtitleReader.vue'
import ClipPanel from './components/ClipPanel.vue'
import SettingsView from './components/SettingsView.vue'
import SearchView from './components/SearchView.vue'
import ClipsView from './components/ClipsView.vue'
import DashboardView from './components/DashboardView.vue'
import VideoPreview from './components/VideoPreview.vue'
import ClipJobsView from './components/ClipJobsView.vue'
import AppNav from './components/AppNav.vue'
import UiIcon from './components/UiIcon.vue'
import CommandPalette from './components/CommandPalette.vue'
import ImportDialog from './components/ImportDialog.vue'
import PullDialog from './components/PullDialog.vue'

const ui = useUiStore()
const videoStore = useVideoStore()
const subtitleStore = useSubtitleStore()
const showImport = ref(false)
const showPull = ref(false)
const showPalette = ref(false)
const previewCollapsed = ref(false)
const { treeWidth, taskWidth, previewHeight, dragging, startDrag, onResizeKey, resetPaneWidths } =
  usePaneLayout(() => state.settings)

// A change of document, BV or page invalidates the previous preview session.
watch(
  () => [subtitleStore.activeDocId, subtitleStore.video?.bvid, subtitleStore.doc?.page] as const,
  ([docId, bvid, page]) => {
    if (docId == null || !bvid) { void videoStore.close(); return }
    void videoStore.open(bvid, page ?? 1)
  }
)

const collectionNote = computed(() => {
  const c = state.pendingCollection
  if (!c) return ''
  const kind = c.pageType === 'favlist' ? '收藏夹' : c.pageType === 'space' ? 'UP主投稿页' : c.pageType === 'series' ? '系列' : '合集'
  return `浏览器用户脚本检测到${kind}${c.title ? `《${c.title}》` : ''}`
})

const themeLabel: Record<string, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
const shortcuts = computed(() => state.settings?.shortcuts ?? DEFAULT_SHORTCUTS)
const themeIcon = computed<'sun' | 'moon' | 'monitor'>(() =>
  state.settings?.theme === 'dark' ? 'moon' : state.settings?.theme === 'light' ? 'sun' : 'monitor'
)

function closePull(): void {
  showPull.value = false
  state.pendingCollection = null
}

async function toggleTheme(): Promise<void> {
  if (!state.settings) return
  const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
  const next = order[(order.indexOf(state.settings.theme) + 1) % order.length]
  state.settings = await window.api.saveSettings({ theme: next })
  applyTheme(next)
}

function runCommand(id: CommandId): void {
  showPalette.value = false
  switch (id) {
    case 'home': case 'library': case 'search': case 'clips': case 'clipjobs': case 'settings':
      ui.setView(id)
      break
    case 'import': showImport.value = true; break
    case 'pull': showPull.value = true; break
    case 'theme': void toggleTheme(); break
    case 'layout': resetPaneWidths(); break
  }
}

// File-drag depth prevents the overlay flashing when crossing nested elements.
const fileDragging = ref(false)
let dragDepth = 0
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}
function onDragEnter(e: DragEvent): void {
  if (!hasFiles(e)) return
  dragDepth++
  fileDragging.value = true
}
function onDragOver(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e: DragEvent): void {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) fileDragging.value = false
}
async function onDrop(e: DragEvent): Promise<void> {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  fileDragging.value = false
  const paths = Array.from(e.dataTransfer?.files ?? [])
    .map((file) => window.api.getPathForFile(file))
    .filter(Boolean)
  if (!paths.length) {
    toast('无法识别文件路径，请使用「导入字幕」按钮', 'error', 5000)
    return
  }
  await importDroppedSrt(paths)
}

let themeMedia: MediaQueryList | null = null
onMounted(() => {
  window.addEventListener('keydown', onKey)
  themeMedia = window.matchMedia('(prefers-color-scheme: dark)')
  themeMedia.addEventListener('change', onSystemTheme)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  void initApp().catch((err: unknown) => {
    toast(`启动失败：${err instanceof Error ? err.message : String(err)}`, 'error', 9000)
  })
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  themeMedia?.removeEventListener('change', onSystemTheme)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
function onSystemTheme(): void {
  if (state.settings?.theme === 'system') applyTheme('system')
}

function onKey(e: KeyboardEvent): void {
  if (showPalette.value || document.querySelector('.mask')) return
  // Global commands work while typing, unlike subtitle-row shortcuts.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    showPalette.value = true
    return
  }
  const el = e.target as HTMLElement | null
  const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  const action = resolveAction(e, shortcuts.value)
  if (!action) return

  // Ctrl+Shift+F is a global navigation shortcut, even inside a text field.
  if (action === 'librarySearch') {
    e.preventDefault()
    ui.setView(ui.view === 'search' ? 'library' : 'search')
    return
  }
  if (typing) {
    if (action === 'clearSelection' && el?.id === 'search-input') {
      const input = el as HTMLInputElement
      if (input.value) {
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      } else input.blur()
      e.preventDefault()
    }
    return
  }
  if (ui.view !== 'library' && action !== 'focusSearch') return
  switch (action) {
    case 'focusSearch':
      if (ui.view === 'library') { e.preventDefault(); document.getElementById('search-input')?.focus() }
      break
    case 'nextCue': e.preventDefault(); moveCursor(1, false); scrollToCursor(); break
    case 'prevCue': e.preventDefault(); moveCursor(-1, false); scrollToCursor(); break
    case 'extendNext': e.preventDefault(); moveCursor(1, true); scrollToCursor(); break
    case 'extendPrev': e.preventDefault(); moveCursor(-1, true); scrollToCursor(); break
    case 'toggleSelect': e.preventDefault(); toggleSelect(state.cursor); break
    case 'editCue': e.preventDefault(); requestEditCurrent(); break
    case 'togglePlay': e.preventDefault(); videoStore.togglePlay(); break
    case 'selectAll': e.preventDefault(); selectAll(); break
    case 'clearSelection': e.preventDefault(); clearSelection(); break
    case 'addClip': e.preventDefault(); void enqueueCurrentRanges(); break
    case 'exportCsv': e.preventDefault(); void exportSlice('csv'); break
    case 'undoEdit': e.preventDefault(); void undoLastEdit(); break
    case 'redoEdit': e.preventDefault(); void redoLastEdit(); break
  }
}
function onImported(): void {
  showImport.value = false
  toast('字幕已导入', 'success')
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <button class="brand" type="button" title="返回工作台" @click="ui.setView('home')">
        <span class="brand-mark" aria-hidden="true"><span class="brand-wave"><i></i><i></i><i></i><i></i></span></span>
        <span class="brand-copy"><strong>字幕剪</strong><small>SUBCLIP STUDIO</small></span>
      </button>
      <span class="topbar-divider" aria-hidden="true"></span>
      <AppNav />
      <span class="grow"></span>
      <button class="topbar-command" type="button" title="快捷操作 (Ctrl+K)" @click="showPalette = true">
        <UiIcon name="search" :size="16" />
        <span>快速操作</span><kbd>Ctrl K</kbd>
      </button>
      <div class="topbar-actions">
        <span class="connection-status" :class="{ online: ui.pluginOnline }" :title="ui.pluginTitle">
          <span class="connection-dot"></span><span class="connection-label">{{ ui.pluginOnline ? '插件已连接' : '插件未连接' }}</span>
        </span>
        <button class="btn header-import" type="button" title="导入本地 SRT / VTT / TXT" @click="showImport = true">
          <UiIcon name="upload" :size="16" /><span>导入</span>
        </button>
        <button class="btn primary header-pull" type="button" title="从 B 站视频、合集、系列或收藏夹拉取字幕" @click="showPull = true">
          <UiIcon name="download" :size="16" /><span>拉取字幕</span>
        </button>
        <span class="topbar-divider compact" aria-hidden="true"></span>
        <button class="header-icon" type="button" title="恢复默认布局" aria-label="恢复默认布局" @click="resetPaneWidths">
          <UiIcon name="panel" :size="18" />
        </button>
        <button class="header-icon" :class="{ active: ui.view === 'settings' }" type="button" title="设置" aria-label="设置" @click="ui.setView('settings')">
          <UiIcon name="settings" :size="18" />
        </button>
        <button class="header-icon" type="button" :title="`主题：${themeLabel[state.settings?.theme ?? 'system']}`" aria-label="切换主题" @click="toggleTheme">
          <UiIcon :name="themeIcon" :size="18" />
        </button>
      </div>
    </header>

    <div v-if="state.pluginPull" class="activity-strip" role="status">
      <UiIcon name="download" :size="15" />
      正在拉取字幕 {{ state.pluginPull.current }}/{{ state.pluginPull.total }}
      <span v-if="state.pluginPull.title" class="activity-title">{{ state.pluginPull.title }}</span>
    </div>

    <main class="main" :style="{
      '--tree-w': `${treeWidth}px`, '--task-w': `${taskWidth}px`, '--preview-h': `${previewHeight}px`
    }">
      <template v-if="ui.view === 'library'">
        <ResourceTree />
        <div class="resizer" :class="{ active: dragging === 'left' }" role="separator" tabindex="0"
          aria-label="调整素材库宽度" aria-orientation="vertical" :aria-valuenow="treeWidth"
          @pointerdown="startDrag('left', $event)" @keydown.stop="onResizeKey('left', $event)" @dblclick="resetPaneWidths"></div>
        <div class="pane-column">
          <template v-if="!previewCollapsed">
            <VideoPreview @collapse="previewCollapsed = true" />
            <div class="resizer-h" :class="{ active: dragging === 'preview' }" role="separator" tabindex="0"
              aria-label="调整视频预览高度" aria-orientation="horizontal" :aria-valuenow="previewHeight"
              @pointerdown="startDrag('preview', $event)" @keydown.stop="onResizeKey('preview', $event)" @dblclick="resetPaneWidths"></div>
          </template>
          <SubtitleReader :preview-collapsed="previewCollapsed" @expand-preview="previewCollapsed = false" />
        </div>
        <div class="resizer" :class="{ active: dragging === 'right' }" role="separator" tabindex="0"
          aria-label="调整剪辑助手宽度" aria-orientation="vertical" :aria-valuenow="taskWidth"
          @pointerdown="startDrag('right', $event)" @keydown.stop="onResizeKey('right', $event)" @dblclick="resetPaneWidths"></div>
        <ClipPanel />
      </template>
      <DashboardView v-else-if="ui.view === 'home'" @import="showImport = true" @pull="showPull = true" />
      <ClipsView v-else-if="ui.view === 'clips'" />
      <ClipJobsView v-else-if="ui.view === 'clipjobs'" />
      <SearchView v-else-if="ui.view === 'search'" />
      <SettingsView v-else />
    </main>

    <ImportDialog v-if="showImport" @close="showImport = false" @done="onImported" />
    <PullDialog v-if="showPull || state.pendingCollection" :prefill-url="state.pendingCollection?.url ?? ''"
      :prefill-note="collectionNote" @close="closePull" />
    <CommandPalette v-if="showPalette" @close="showPalette = false" @run="runCommand" />

    <div v-if="fileDragging" class="drop-mask" aria-hidden="true">
      <div class="drop-box">
        <span class="drop-ico"><UiIcon name="file-text" :size="32" /></span>
        <strong>松开即可导入字幕</strong>
        <span class="muted">支持 .srt / .vtt / .txt，可一次拖入多个文件</span>
      </div>
    </div>
    <div v-if="state.toast.visible" class="toast" :class="state.toast.type" role="status" aria-live="polite">
      {{ state.toast.text }}
    </div>
  </div>
</template>

<style scoped>
.drop-mask { position: fixed; inset: 0; z-index: 75; display: grid; place-items: center; background: rgba(21, 31, 58, .24); backdrop-filter: blur(3px); pointer-events: none; }
.drop-box { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 36px 48px; border: 2px dashed var(--accent); border-radius: 18px; background: var(--panel); box-shadow: var(--shadow-lg); color: var(--text); font-size: 14px; }
.drop-ico { color: var(--accent); }
.drop-box .muted { font-size: 12px; }
</style>
