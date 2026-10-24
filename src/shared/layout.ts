/** Layout constraints shared by the resizer and its regression tests. */
export const DEFAULT_PANES = { tree: 288, task: 350, preview: 286 } as const
export const MIN_PANES = { tree: 200, task: 280, center: 400, preview: 120 } as const
export const MAX_PANES = { tree: 520, task: 620, preview: 720 } as const
const SPLITTER_WIDTH = 12

export function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/**
 * Keep the reader usable while resizing side panels. A very small viewport
 * cannot satisfy every minimum; side panes retain their minimum sizes.
 */
export function constrainPanes(
  viewportWidth: number,
  requestedTree: number,
  requestedTask: number
): { tree: number; task: number } {
  let tree = clampFinite(requestedTree, MIN_PANES.tree, MAX_PANES.tree, DEFAULT_PANES.tree)
  let task = clampFinite(requestedTask, MIN_PANES.task, MAX_PANES.task, DEFAULT_PANES.task)
  const budget = Math.max(
    MIN_PANES.tree + MIN_PANES.task,
    (Number.isFinite(viewportWidth) ? viewportWidth : 1280) - MIN_PANES.center - SPLITTER_WIDTH
  )
  if (tree + task > budget) {
    task = Math.max(MIN_PANES.task, task - (tree + task - budget))
    tree = Math.max(MIN_PANES.tree, Math.min(tree, budget - task))
  }
  return { tree, task }
}

export function constrainPreview(viewportHeight: number, requested: number): number {
  const max = Math.max(MIN_PANES.preview, Math.min(MAX_PANES.preview, viewportHeight - 250))
  return clampFinite(requested, MIN_PANES.preview, max, Math.min(DEFAULT_PANES.preview, max))
}

/** Resize only the requested side: the opposite panel must not unexpectedly move. */
export function resizeSidePane(
  viewportWidth: number,
  tree: number,
  task: number,
  which: 'left' | 'right',
  delta: number
): { tree: number; task: number } {
  const initial = constrainPanes(viewportWidth, tree, task)
  const budget = Math.max(
    MIN_PANES.tree + MIN_PANES.task,
    (Number.isFinite(viewportWidth) ? viewportWidth : 1280) - MIN_PANES.center - SPLITTER_WIDTH
  )
  if (which === 'left') {
    return {
      tree: clampFinite(initial.tree + delta, MIN_PANES.tree, Math.min(MAX_PANES.tree, budget - initial.task), initial.tree),
      task: initial.task
    }
  }
  return {
    tree: initial.tree,
    task: clampFinite(initial.task - delta, MIN_PANES.task, Math.min(MAX_PANES.task, budget - initial.tree), initial.task)
  }
}
