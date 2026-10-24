<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { DEFAULT_SHORTCUTS, resolveAction } from '@shared/shortcuts'
import {
  applyTheme,
  clearSelection,
  enqueueCurrentRanges,
  exportSlice,
  importDroppedSrt,
  initApp,
  moveCursor,
  redoLastEdit,
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
import ClipsView from './components/ClipsView.vue'
import DashboardView from './components/DashboardView.vue'
import VideoPreview from './components/VideoPreview.vue'
import ClipJobsView from './components/ClipJobsView.vue'
import AppNav from './components/AppNav.vue'
import ImportDialog from './components/ImportDialog.vue'
import PullDialog from './components/PullDialog.vue'
import { useVideoStore } from './stores/video'
import { useSubtitleStore } from './stores/subtitle'

const showImport = ref(false)
const showPull = ref(false)
const videoStore = useVideoStore()
const subtitleStore = useSubtitleStore()

/**
 * 打开的文档一变就自动解析预览流（第二阶段）。
 *
 * 依赖里带上 `bvid` 与 `page`：同一条字幕在 P1/P2 之间切换、
 * 或从「本地导入（无 BV 号）」换到 B站视频，都必须重新解析。
 * 没有 BV 号（纯本地字幕）时直接关掉预览，避免留一个空面板。
 */
watch(
  () => [subtitleStore.activeDocId, subtitleStore.video?.bvid, subtitleStore.doc?.page] as const,
  ([docId, bvid, page]) => {
    if (docId == null || !bvid) {
      void videoStore.close()
      return
    }
    void videoStore.open(bvid, page ?? 1)
  }
)

/** 用户脚本检测到合集 / 收藏夹时，在对话框顶部说明来源 */
const collectionNote = computed(() => {
  const c = state.pendingCollection
  if (!c) return ''
  const kind =
    c.pageType === 'favlist' ? '收藏夹' : c.pageType === 'space' ? 'UP主投稿页' : '合集 / 系列'
  return `浏览器用户脚本检测到${kind}${c.title ? `《${c.title}》` : ''}`
})

/** 关闭拉取对话框：两个入口（手动按钮 / 用户脚本检测）都要复位 */
function closePull(): void {
  showPull.value = false
  state.pendingCollection = null
}

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
/** 中栏里视频预览的高度（第二阶段，可拖拽并记忆） */
const previewHeight = ref(300)
const dragging = ref<'left' | 'right' | 'preview' | null>(null)

/**
 * 视频预览是否收起（3.8.0）。
 *
 * 为什么需要：中栏是「预览（上）+ 字幕阅读（下）」，而这两者的使用比重会变 ——
 * 挑片段、调时间范围时你会一直盯着字幕，预览只是想确认一下边界。
 * 有了收起，字幕阅读就能占满整个中栏（实测 300px 的预览对长字幕列表是明显浪费）。
 *
 * 这个状态**不持久化**：它是一次性的查看偏好，不是配置；
 * 下次打开还按默认布局最符合预期（和 `publish` 草稿同样的取舍）。
 */
const previewCollapsed = ref(false)

watch(
  () => state.settings,
  (s) => {
    if (!s) return
    treeWidth.value = s.treePaneWidth || 290
    taskWidth.value = s.taskPaneWidth || 380
    previewHeight.value = s.videoPaneHeight || 300
  },
  { immediate: true }
)

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function startDrag(which: 'left' | 'right' | 'preview', e: MouseEvent): void {
  e.preventDefault()
  dragging.value = which
  const startX = e.clientX
  const startY = e.clientY
  const startW = which === 'left' ? treeWidth.value : which === 'right' ? taskWidth.value : 0
  const startH = previewHeight.value

  const onMove = (ev: MouseEvent): void => {
    if (which === 'preview') {
      previewHeight.value = clamp(startH + (ev.clientY - startY), 120, 720)
      return
    }
    const delta = ev.clientX - startX
    if (which === 'left') treeWidth.value = clamp(startW + delta, 200, 560)
    else taskWidth.value = clamp(startW - delta, 280, 680)
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    const was = dragging.value
    dragging.value = null
    if (was === 'preview') {
      void window.api.saveSettings({ videoPaneHeight: previewHeight.value })
    } else {
      void window.api.saveSettings({
        treePaneWidth: treeWidth.value,
        taskPaneWidth: taskWidth.value
      })
    }
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function resetPaneWidths(): void {
  treeWidth.value = 290
  taskWidth.value = 380
  previewHeight.value = 300
  void window.api.saveSettings({ treePaneWidth: 290, taskPaneWidth: 380, videoPaneHeight: 300 })
}

/* -------------------------------- 拖拽导入 -------------------------------- */

/**
 * 把 .srt / .vtt / .txt 拖进窗口即可导入。
 *
 * 用 dragenter/dragleave 计数而不是简单的 true/false：拖过子元素时会连发
 * dragleave → 立刻变回 false，遮罩会闪。计数能避免这个抖动。
 */
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
  // 不 preventDefault 的话浏览器会拒收，drop 事件根本不会触发
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

  // Electron 32 起 File.path 被移除，路径只能从 preload 的 webUtils 取
  const paths = Array.from(e.dataTransfer?.files ?? [])
    .map((f) => window.api.getPathForFile(f))
    .filter(Boolean)
  if (!paths.length) {
    toast('没能识别拖入文件的路径，请改用「导入 SRT」按钮', 'error', 5200)
    return
  }
  await importDroppedSrt(paths)
}

/* --------------------------------- 生命周期 -------------------------------- */

onMounted(async () => {
  await initApp()
  window.addEventListener('keydown', onKey)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onSystemTheme)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', onSystemTheme)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
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
  // 有弹窗打开时，全局快捷键一律不生效。
  // 弹窗是模态的（盖住整个窗口），此时按键作用到背景上只会造成困惑：
  // 最典型的是 Esc —— 用户想关弹窗，结果把弹窗背后的字幕选择清空了。
  // 弹窗自己会处理 Esc（见 composables/useEscapeToClose.ts）。
  if (document.querySelector('.mask')) return

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
    case 'togglePlay':
      // 空格播放/暂停（第九阶段补：之前没有任何播放入口）。
      // 输入框里按空格是打字 —— 上面的 `typing` 守卫已经把这种情况挡掉了，
      // 所以这里不必再判断焦点。
      //
      // 这里走 store：store 的 `togglePlay()` 依赖组件注册进来的播放句柄，
      // 而预览**没有挂载**时句柄为空（静默返回，这是合理的 —— 没开预览就不该有反应）。
      // 预览自己的按钮走组件本地调用，不受注册时序影响。
      e.preventDefault()
      videoStore.togglePlay()
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
    case 'redoEdit':
      e.preventDefault()
      void redoLastEdit()
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
      <!-- 品牌 -->
      <span class="title">字幕剪 <span class="title-en">SubClip</span></span>

      <!-- ---------------------------------------------------------------------
        一级导航：只切页面（纯切换语义，不再「再点一次返回」）
        与动作、工具在视觉上明确区分 —— 页签样式 vs 按钮样式。
        --------------------------------------------------------------------- -->
      <AppNav />

      <!-- 插件连接状态：属于「环境状态」，不占主导航位置 -->
      <span class="plugin-badge" :class="{ on: pluginOnline }" :title="pluginTitle">
        {{ pluginOnline ? '🔌 已连接' : '🔌 未连接' }}
      </span>

      <!-- 插件请求拉取时的进度：这一步可能几十秒，得让用户看到还在动 -->
      <span
        v-if="state.pluginPull"
        class="plugin-badge on"
        :title="`正在为插件请求拉取字幕：${state.pluginPull.title || ''}`"
      >
        ⏳ {{ state.pluginPull.current }}/{{ state.pluginPull.total }}
        {{ state.pluginPull.title ? `· ${state.pluginPull.title}` : '' }}
      </span>

      <span class="grow"></span>

      <!-- ---------------------------------------------------------------------
        动作区：做一件事，**不切换页面**。
        「导入 SRT」是次要动作，「拉取字幕」是主要动作（日常最高频的入口）。
        --------------------------------------------------------------------- -->
      <button class="btn" title="导入本地 SRT 字幕文件" @click="showImport = true">
        导入 SRT
      </button>
      <button
        class="btn primary"
        title="从视频 / 合集 / 系列 / 收藏夹 / UP主主页拉取字幕"
        @click="showPull = true"
      >
        拉取字幕
      </button>

      <span class="topbar-sep" aria-hidden="true"></span>

      <!-- 工具区：全局设置类操作 -->
      <button class="btn sm" title="恢复默认面板宽度" @click="resetPaneWidths">重置布局</button>
      <button
        class="btn sm"
        :class="{ primary: state.view === 'settings' }"
        title="设置：账号、切片、检索、插件、AI 等全部配置"
        @click="state.view = 'settings'"
      >
        设置
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
      :style="{
        '--tree-w': `${treeWidth}px`,
        '--task-w': `${taskWidth}px`,
        '--preview-h': `${previewHeight}px`
      }"
    >
      <template v-if="state.view === 'library'">
        <ResourceTree />
        <div
          class="resizer"
          :class="{ active: dragging === 'left' }"
          title="拖动调整宽度"
          @mousedown="startDrag('left', $event)"
        ></div>

        <!-- 中栏：视频预览（上） / 字幕阅读（下），中间可拖拽；预览可收起 -->
        <div class="pane-column">
          <template v-if="!previewCollapsed">
            <VideoPreview @collapse="previewCollapsed = true" />
            <div
              class="resizer-h"
              :class="{ active: dragging === 'preview' }"
              title="拖动调整预览高度"
              @mousedown="startDrag('preview', $event)"
            ></div>
          </template>
          <SubtitleReader :preview-collapsed="previewCollapsed" @expand-preview="previewCollapsed = false" />
        </div>

        <div
          class="resizer"
          :class="{ active: dragging === 'right' }"
          title="拖动调整宽度"
          @mousedown="startDrag('right', $event)"
        ></div>
        <ClipPanel />
      </template>
      <DashboardView
        v-else-if="state.view === 'home'"
        @import="showImport = true"
        @pull="showPull = true"
      />
      <ClipsView v-else-if="state.view === 'clips'" />
      <ClipJobsView v-else-if="state.view === 'clipjobs'" />
      <SearchView v-else-if="state.view === 'search'" />
      <SettingsView v-else />
    </div>

    <ImportDialog v-if="showImport" @close="showImport = false" @done="onImported" />
    <PullDialog
      v-if="showPull || state.pendingCollection"
      :prefill-url="state.pendingCollection?.url ?? ''"
      :prefill-note="collectionNote"
      @close="closePull"
    />

    <!-- 拖拽导入遮罩 -->
    <div v-if="fileDragging" class="drop-mask">
      <div class="drop-box">
        <div class="drop-ico">📄</div>
        <div>松开即可导入字幕</div>
        <div class="muted" style="font-size: 12px">支持 .srt / .vtt / .txt，可一次拖多个</div>
      </div>
    </div>

    <div
      v-if="state.toast.visible"
      class="toast"
      :class="state.toast.type"
      role="status"
      aria-live="polite"
    >
      {{ state.toast.text }}
    </div>
  </div>
</template>

<style scoped>
/* 整窗拖拽遮罩：pointer-events 必须关掉，否则它会挡住后面的 drop 事件 */
.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: none;
}

.drop-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 26px 40px;
  border: 2px dashed var(--accent);
  border-radius: 12px;
  background: var(--panel);
  color: var(--text);
  font-size: 14px;
}

.drop-ico {
  font-size: 30px;
}
</style>
