import { onBeforeUnmount, ref, watch } from 'vue'
import type { AppSettings } from '@shared/types'
import { constrainPanes, constrainPreview, resizeSidePane, DEFAULT_PANES } from '@shared/layout'

type Pane = 'left' | 'right' | 'preview'

/** Pointer + keyboard resizers, with viewport-aware limits and guaranteed cleanup. */
export function usePaneLayout(settings: () => AppSettings | null) {
  const treeWidth = ref<number>(DEFAULT_PANES.tree)
  const taskWidth = ref<number>(DEFAULT_PANES.task)
  const previewHeight = ref<number>(DEFAULT_PANES.preview)
  const dragging = ref<Pane | null>(null)
  let cleanupDrag: (() => void) | null = null

  function constrain(): void {
    const next = constrainPanes(window.innerWidth, treeWidth.value, taskWidth.value)
    treeWidth.value = next.tree
    taskWidth.value = next.task
    previewHeight.value = constrainPreview(window.innerHeight, previewHeight.value)
  }

  watch(settings, (s) => {
    if (!s) return
    treeWidth.value = s.treePaneWidth || DEFAULT_PANES.tree
    taskWidth.value = s.taskPaneWidth || DEFAULT_PANES.task
    previewHeight.value = s.videoPaneHeight || DEFAULT_PANES.preview
    constrain()
  }, { immediate: true })

  function persist(which: Pane): void {
    if (which === 'preview') {
      void window.api.saveSettings({ videoPaneHeight: previewHeight.value })
    } else {
      void window.api.saveSettings({ treePaneWidth: treeWidth.value, taskPaneWidth: taskWidth.value })
    }
  }

  function startDrag(which: Pane, event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    cleanupDrag?.()
    event.preventDefault()
    dragging.value = which
    const { clientX: startX, clientY: startY } = event
    const initialTree = treeWidth.value
    const initialTask = taskWidth.value
    const initialPreview = previewHeight.value
    const pointerId = event.pointerId
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = which === 'preview' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      if (which === 'preview') {
        previewHeight.value = constrainPreview(window.innerHeight, initialPreview + e.clientY - startY)
        return
      }
      const delta = e.clientX - startX
      const next = resizeSidePane(window.innerWidth, initialTree, initialTask, which, delta)
      treeWidth.value = next.tree
      taskWidth.value = next.task
    }
    const onEnd = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      cleanupDrag?.()
      persist(which)
    }
    cleanupDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      dragging.value = null
      cleanupDrag = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  function onResizeKey(which: Pane, event: KeyboardEvent): void {
    const horizontal = which !== 'preview'
    if (!(horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']).includes(event.key)) return
    event.preventDefault()
    const amount = event.shiftKey ? 32 : 12
    const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? amount : -amount
    if (which === 'preview') previewHeight.value = constrainPreview(window.innerHeight, previewHeight.value + delta)
    else {
      const next = resizeSidePane(window.innerWidth, treeWidth.value, taskWidth.value, which, delta)
      treeWidth.value = next.tree
      taskWidth.value = next.task
    }
    persist(which)
  }

  function resetPaneWidths(): void {
    treeWidth.value = DEFAULT_PANES.tree
    taskWidth.value = DEFAULT_PANES.task
    previewHeight.value = DEFAULT_PANES.preview
    constrain()
    void window.api.saveSettings({
      treePaneWidth: treeWidth.value,
      taskPaneWidth: taskWidth.value,
      videoPaneHeight: previewHeight.value
    })
  }

  window.addEventListener('resize', constrain)
  onBeforeUnmount(() => {
    cleanupDrag?.()
    window.removeEventListener('resize', constrain)
  })

  return { treeWidth, taskWidth, previewHeight, dragging, startDrag, onResizeKey, resetPaneWidths }
}
