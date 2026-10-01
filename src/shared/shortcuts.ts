/**
 * 快捷键定义、解析与匹配。
 * 绑定字符串格式：`Ctrl+Shift+ArrowDown`、`F2`、`Enter`、`Space`（修饰键固定为 Ctrl / Alt / Shift 顺序）。
 */

export type ShortcutAction =
  | 'focusSearch'
  | 'nextCue'
  | 'prevCue'
  | 'extendNext'
  | 'extendPrev'
  | 'toggleSelect'
  | 'editCue'
  | 'selectAll'
  | 'clearSelection'
  | 'addClip'
  | 'exportCsv'

export interface ShortcutDef {
  id: ShortcutAction
  label: string
  description: string
  /** 默认绑定 */
  fallback: string
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: 'focusSearch', label: '聚焦搜索', description: '把光标移到搜索框', fallback: 'Ctrl+F' },
  { id: 'nextCue', label: '下一条字幕', description: '光标下移一行', fallback: 'ArrowDown' },
  { id: 'prevCue', label: '上一条字幕', description: '光标上移一行', fallback: 'ArrowUp' },
  { id: 'extendNext', label: '向下扩展选择', description: '从锚点连续选中到下一行', fallback: 'Shift+ArrowDown' },
  { id: 'extendPrev', label: '向上扩展选择', description: '从锚点连续选中到上一行', fallback: 'Shift+ArrowUp' },
  { id: 'toggleSelect', label: '勾选当前行', description: '选中 / 取消当前字幕', fallback: 'Enter' },
  { id: 'editCue', label: '编辑当前行', description: '进入字幕正文编辑', fallback: 'F2' },
  { id: 'selectAll', label: '全选', description: '选中全部字幕', fallback: 'Ctrl+A' },
  { id: 'clearSelection', label: '清除选择', description: '取消所有已选字幕', fallback: 'Escape' },
  { id: 'addClip', label: '加入切片任务', description: '把当前时间范围加入任务列表', fallback: 'Ctrl+Enter' },
  { id: 'exportCsv', label: '导出切片表', description: '导出为 CSV', fallback: 'Ctrl+E' }
]

export type ShortcutMap = Record<ShortcutAction, string>

export const DEFAULT_SHORTCUTS: ShortcutMap = SHORTCUT_DEFS.reduce((acc, def) => {
  acc[def.id] = def.fallback
  return acc
}, {} as ShortcutMap)

/** 补齐缺失项，保证设置里存的是完整映射 */
export function normalizeShortcuts(raw: Partial<ShortcutMap> | undefined): ShortcutMap {
  const out = { ...DEFAULT_SHORTCUTS }
  if (raw) {
    for (const def of SHORTCUT_DEFS) {
      const v = raw[def.id]
      if (typeof v === 'string' && v.trim()) out[def.id] = v.trim()
    }
  }
  return out
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead'])

/** KeyboardEvent → 绑定字符串；只按修饰键时返回空串 */
export function eventToBinding(e: {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string {
  if (MODIFIER_KEYS.has(e.key)) return ''

  const parts: string[] = []
  // metaKey 归一到 Ctrl，兼容 Mac 的 Cmd
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  let key = e.key
  if (key === ' ' || e.code === 'Space' || key === 'Spacebar') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()

  parts.push(key)
  return parts.join('+')
}

/** 事件是否命中某个绑定 */
export function matchesBinding(
  e: Parameters<typeof eventToBinding>[0],
  binding: string | undefined
): boolean {
  if (!binding) return false
  return eventToBinding(e) === binding
}

/** 在当前绑定表里查找命中的动作 */
export function resolveAction(
  e: Parameters<typeof eventToBinding>[0],
  map: ShortcutMap
): ShortcutAction | null {
  const pressed = eventToBinding(e)
  if (!pressed) return null
  for (const def of SHORTCUT_DEFS) {
    if (map[def.id] === pressed) return def.id
  }
  return null
}

/** 展示用：把内部名称换成更友好的符号 */
const DISPLAY: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: '空格',
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete'
}

export function formatBinding(binding: string): string {
  if (!binding) return '未设置'
  return binding
    .split('+')
    .map((p) => DISPLAY[p] ?? p)
    .join(' + ')
}

/** 检测绑定冲突，返回冲突的动作 id 列表 */
export function findConflicts(map: ShortcutMap): ShortcutAction[][] {
  const groups = new Map<string, ShortcutAction[]>()
  for (const def of SHORTCUT_DEFS) {
    const key = map[def.id]
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(def.id)
    groups.set(key, list)
  }
  return [...groups.values()].filter((list) => list.length > 1)
}
