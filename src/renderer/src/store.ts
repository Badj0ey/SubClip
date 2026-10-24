/**
 * 渲染进程状态入口门面（第一阶段-1 / 1-2）。
 *
 * ## 为什么还留着这个文件
 *
 * 状态已经从「一个 1100 行的模块级 reactive」拆成 `stores/` 下的八个 Pinia store。
 * 但十来个组件都在 `import { state, xxx } from '../store'`，
 * 一次性全改完风险太大（任何一处漏改都是运行时白屏，而不是类型错误）。
 *
 * 所以这里保留**原样不变的对外 API**，内部全部转发到新 store：
 * - 组件不需要改一行，功能表现与我们重构前完全一致；
 * - 后续哪个组件有空，就把它改成直接 `useXxxStore()`；
 * - store 全部迁完后再删掉本文件。
 *
 * ## 实现要点（踩过的坑）
 *
 * 1. **store 必须在调用时才解析**（`pinia()`）：本模块会在 `createApp()`
 *    之前被 import，那时 Pinia 还没装上。
 * 2. `state` 用 Proxy 做**属性级转发**，不是 `reactive()` 快照 ——
 *    否则 `state.tree` 读到的会是拷贝，界面不会跟着变。
 * 3. 组件里存在 `state.tree = ...` 这种**直接赋值**，setter 必须一并实现。
 * 4. 撤销 / 重做栈、删除快照等放在 store 内部，不经过门面，避免被响应式包成 Proxy
 *    （Proxy 无法通过 IPC 的结构化克隆，这是老代码里明确记过的坑）。
 */
import { computed, ref } from 'vue'
import type {
  AppSettings,
  ClipTask,
  Cue,
  CueSearchHit,
  MergedCue,
  SliceHistoryEntry,
  SubtitleDoc,
  TimeRange,
  TreeNode,
  VideoItem
} from '@shared/types'
import { useUiStore } from './stores/ui'
import { useSettingsStore } from './stores/settings'
import { useResourceStore } from './stores/resource'
import { useSubtitleStore } from './stores/subtitle'
import { useClipStore } from './stores/clip'
import { useSearchStore } from './stores/search'
import { useSemanticStore } from './stores/semantic'
import { useAiStore } from './stores/ai'
import { setupIpcEvents, setupBusWiring } from './stores/ipcEvents'
import { hitKey } from './stores/search'

type Stores = {
  ui: ReturnType<typeof useUiStore>
  settings: ReturnType<typeof useSettingsStore>
  resource: ReturnType<typeof useResourceStore>
  subtitle: ReturnType<typeof useSubtitleStore>
  clip: ReturnType<typeof useClipStore>
  search: ReturnType<typeof useSearchStore>
  semantic: ReturnType<typeof useSemanticStore>
  ai: ReturnType<typeof useAiStore>
}

/** 惰性取全部 store（Pinia 未装时会抛出，提示信息足够明确） */
let cached: Stores | null = null

function stores(): Stores {
  if (!cached) {
    try {
      cached = {
        ui: useUiStore(),
        settings: useSettingsStore(),
        resource: useResourceStore(),
        subtitle: useSubtitleStore(),
        clip: useClipStore(),
        search: useSearchStore(),
        semantic: useSemanticStore(),
        ai: useAiStore()
      }
    } catch (err) {
      throw new Error(
        'store 尚未初始化：请在 createApp 后调用 installPinia()（详见 main.ts）。' +
          `原始错误：${(err as Error).message}`
      )
    }
  }
  return cached
}

/** `installPinia()` 里调用：清掉缓存，让下次访问重新解析到新 Pinia */
export function resetStoreCache(): void {
  cached = null
}

/* ------------------------------ 状态转发（Proxy） ---------------------------- */

/**
 * 门面状态的可写键 → 落到哪个 store 的哪个字段。
 *
 * 这份表就是「哪些状态被门面暴露」的**唯一事实来源**：
 * 漏一个键组件里读到的就是 undefined，会比类型错误更早暴露出来。
 */
const STATE_ROUTES = {
  /* 界面 */
  view: ['ui', 'view'],
  loading: ['ui', 'loading'],
  bridge: ['ui', 'bridge'],
  pendingCollection: ['ui', 'pendingCollection'],
  pluginPull: ['ui', 'pluginPull'],
  sliceRunning: ['ui', 'sliceRunning'],
  sliceProgress: ['ui', 'sliceProgress'],
  sliceResult: ['ui', 'sliceResult'],
  toast: ['ui', 'toast'],

  /* 设置 */
  settings: ['settings', 'settings'],

  /* 资源库 */
  tree: ['resource', 'tree'],
  expanded: ['resource', 'expanded'],
  activeKey: ['resource', 'activeKey'],
  lastDeleted: ['resource', 'lastDeleted'],
  lastDeletedLabel: ['resource', 'lastDeletedLabel'],

  /* 字幕 */
  activeDocId: ['subtitle', 'activeDocId'],
  doc: ['subtitle', 'doc'],
  docs: ['subtitle', 'docs'],
  video: ['subtitle', 'video'],
  cues: ['subtitle', 'cues'],
  focusDocId: ['subtitle', 'focusDocId'],
  focusCueIndex: ['subtitle', 'focusCueIndex'],
  focusNonce: ['subtitle', 'focusNonce'],
  editRequest: ['subtitle', 'editNonce'],
  selected: ['subtitle', 'selected'],
  anchor: ['subtitle', 'anchor'],
  cursor: ['subtitle', 'cursor'],
  keyword: ['subtitle', 'keyword'],
  maxGap: ['subtitle', 'maxGap'],
  siblingDocs: ['subtitle', 'siblingDocs'],
  compareDocId: ['subtitle', 'compareDocId'],
  comparePage: ['subtitle', 'comparePage'],
  compareCues: ['subtitle', 'compareCues'],

  /* 切片 */
  clips: ['clip', 'clips'],
  sliceHistory: ['clip', 'history'],
  ffmpegReady: ['clip', 'ffmpegReady'],
  ffmpegPath: ['clip', 'ffmpegPath'],

  /* 全库检索 */
  searchKeyword: ['search', 'keyword'],
  searchScope: ['search', 'scope'],
  searchResults: ['search', 'results'],
  searchSelected: ['search', 'selected'],
  searching: ['search', 'searching'],
  searchDone: ['search', 'done'],
  searchNotePrefix: ['search', 'notePrefix']
} as const

type StateKey = keyof typeof STATE_ROUTES

/**
 * 门面状态对象。
 *
 * `reactive()` 不能直接包 Pinia store（拿不到属性级转发），所以用 Proxy 转发。
 * 读取走 store 的当前值，写入落到对应 store —— 组件里 `state.tree = xxx` 才会生效。
 */
export const state = new Proxy({} as Record<StateKey, unknown>, {
  get(_t, key: string | symbol): unknown {
    if (typeof key !== 'string') return undefined
    const route = STATE_ROUTES[key as StateKey]
    if (!route) return undefined
    const [name, field] = route
    return (stores()[name] as unknown as Record<string, unknown>)[field]
  },
  set(_t, key: string | symbol, value: unknown): boolean {
    const route = STATE_ROUTES[key as StateKey]
    if (!route) {
      throw new Error(`[store] 未知的状态字段：${String(key)}（请同步更新 STATE_ROUTES）`)
    }
    const [name, field] = route
    ;(stores()[name] as unknown as Record<string, unknown>)[field] = value
    return true
  },
  has(_t, key: string | symbol): boolean {
    return typeof key === 'string' && key in STATE_ROUTES
  }
}) as unknown as AppState

/** 门面暴露的状态类型（与拆分前的 `state` 形状一致） */
export interface AppState {
  /**
   * 当前主视图。
   *
   * ⚠️ 这里要和 `stores/ui.ts` 的 `AppView` **保持一致** ——
   * 加一级导航项时容易只改 store 忘了改门面，症状是
   * `state.view === 'xxx'` 报「类型没有重叠」（类型系统会拦住，实测踩到过）。
   */
  view: import('./stores/ui').AppView
  loading: boolean
  bridge: import('@shared/bridge').BridgeStatus | null
  pendingCollection: {
    pageType: string
    seasonId: number | null
    uid: number | null
    title: string
    url: string
  } | null
  pluginPull: import('@shared/types').PullProgressInfo | null
  sliceRunning: boolean
  sliceProgress: import('@shared/types').SliceProgressInfo | null
  sliceResult: { ok: number; failed: number; outputs: string[]; messages: string[] } | null
  toast: { text: string; type: 'info' | 'error' | 'success'; visible: boolean; timer: number | null }

  settings: AppSettings | null

  tree: TreeNode[]
  expanded: Set<string>
  activeKey: string
  lastDeleted: unknown
  lastDeletedLabel: string

  activeDocId: number | null
  doc: SubtitleDoc | null
  docs: SubtitleDoc[]
  video: (VideoItem & { uploaderName?: string }) | null
  cues: MergedCue[]
  focusDocId: number | null
  focusCueIndex: number | null
  focusNonce: number
  editRequest: number
  selected: Set<number>
  anchor: number | null
  cursor: number
  keyword: string
  maxGap: number
  siblingDocs: SubtitleDoc[]
  compareDocId: number | null
  comparePage: number | null
  compareCues: Cue[]

  clips: ClipTask[]
  sliceHistory: SliceHistoryEntry[]
  ffmpegReady: boolean
  ffmpegPath: string

  searchKeyword: string
  searchScope: 'all' | 'video' | 'collection'
  searchResults: CueSearchHit[]
  searchSelected: Set<string>
  searching: boolean
  searchDone: boolean
  searchNotePrefix: string

  [key: string]: unknown
}

/* --------------------------------- 计算属性 -------------------------------- */

export const matchedIndexes = computed<number[]>(() => stores().subtitle.matchedIndexes)

export const ranges = computed<TimeRange[]>(() => stores().subtitle.ranges)

export const selectedCues = computed<MergedCue[]>(() => stores().subtitle.selectedCues)

export const searchSelectedHits = computed<CueSearchHit[]>(() => stores().search.selectedHits)

export const lastDeletedLabel = computed<string>(() => stores().resource.lastDeletedLabel)

export const undoDepth = computed<number>(() => stores().subtitle.undoDepth)
export const undoLabel = computed<string>(() => stores().subtitle.undoLabel)
export const redoDepth = computed<number>(() => stores().subtitle.redoDepth)
export const redoLabel = computed<string>(() => stores().subtitle.redoLabel)

/** 编辑请求信号：组件 watch 它进入编辑态 */
export const editRequest = computed<number>(() => stores().subtitle.editNonce)

/* ---------------------------------- 工具 ---------------------------------- */

export function toast(text: string, type: 'info' | 'error' | 'success' = 'info', duration = 2600): void {
  stores().ui.showToast(text, type, duration)
}

export function applyTheme(theme: AppSettings['theme']): void {
  stores().settings.applyTheme(theme)
}

export function applyReadingStyle(): void {
  stores().settings.applyReadingStyle()
}

/* ---------------------------------- 启动 ---------------------------------- */

export async function initApp(): Promise<void> {
  const s = stores()
  await s.settings.load()
  s.settings.applyTheme()
  s.settings.applyReadingStyle()
  // IPC → store / 总线的桥接只注册一次（内部幂等）
  setupIpcEvents()
  // store 之间的联动（字幕选择 → 播放器跟随）也在这里接上
  setupBusWiring()
  await s.resource.load()
  await s.clip.loadClips()
  await s.clip.loadHistory()
  await loadBridgeStatus()
  await s.clip.refreshCheck()
  // AI 状态（第六阶段）：启动时探一次，右侧面板才能正确显示「已连接 / 未启用」。
  // 不 await：探测要打网络，失败也不该拖慢启动。
  void s.ai.probe()
  void s.semantic.refresh()
}

/* ------------------------------ 浏览器插件通信 ----------------------------- */

export async function loadBridgeStatus(): Promise<void> {
  const s = stores()
  try {
    s.ui.setBridge(await window.api.bridgeStatus())
  } catch {
    s.ui.setBridge(null)
  }
}

export async function restartBridge(port?: number): Promise<void> {
  const s = stores()
  const status = await window.api.bridgeRestart(port)
  s.ui.setBridge(status)
  s.ui.showToast(
    status.running ? `本地服务已启动，端口 ${status.port}` : '本地服务启动失败',
    status.running ? 'success' : 'error'
  )
}

/** 重新拉取设置（例如插件刚同步了 Cookie） */
export async function refreshSettings(): Promise<void> {
  await stores().settings.load()
}

/* -------------------------------- 资源库 ---------------------------------- */

export function expandTo(key: string): void {
  stores().resource.expandTo(key)
}

export async function loadTree(expandKey?: string): Promise<void> {
  await stores().resource.load(expandKey)
}

export async function deleteTreeNode(key: string, label: string): Promise<void> {
  const s = stores()
  await s.resource.deleteNode(key, label)
  s.ui.showToast(`已删除「${label}」，可用左侧的「撤销删除」恢复`, 'success', 4600)
}

export async function undoDelete(): Promise<void> {
  await stores().resource.undoDelete()
}

/* --------------------------------- 字幕 ---------------------------------- */

export async function openDoc(
  docId: number,
  key = '',
  focusOrigIndex?: number
): Promise<void> {
  const s = stores()
  await s.subtitle.open(docId, focusOrigIndex)
  if (key) s.resource.activeKey = key
}

export async function reloadActiveDoc(): Promise<void> {
  await stores().subtitle.reload()
}

export function toggleSelect(index: number, shift = false): void {
  stores().subtitle.toggleSelect(index, shift)
}

export function selectAll(): void {
  stores().subtitle.selectAll()
}

export function clearSelection(): void {
  stores().subtitle.clearSelection()
}

export function invertSelection(): void {
  stores().subtitle.invertSelection()
}

export function selectMatches(): void {
  stores().subtitle.selectMatches()
}

export function moveCursor(delta: number, extend = false): void {
  stores().subtitle.moveCursor(delta, extend)
}

export function registerScroller(fn: ((index: number) => void) | null): void {
  stores().subtitle.registerScroller(fn)
}

export function scrollToCursor(): void {
  stores().subtitle.scrollToCursor()
}

export function requestEditCurrent(): void {
  stores().subtitle.requestEditCurrent()
}

export async function loadSiblingDocs(): Promise<void> {
  await stores().subtitle.loadSiblingDocs()
}

export async function setCompareDoc(docId: number | null): Promise<void> {
  await stores().subtitle.setCompareDoc(docId)
}

export function compareTextFor(cue: MergedCue): string {
  return stores().subtitle.compareTextFor(cue)
}

export async function pushUndo(docId: number, label: string): Promise<void> {
  await stores().subtitle.pushUndo(docId, label)
}

export async function undoLastEdit(): Promise<void> {
  await stores().subtitle.undoLastEdit()
}

export async function redoLastEdit(): Promise<void> {
  await stores().subtitle.redoLastEdit()
}

export async function mergeSelectedCues(): Promise<void> {
  await stores().subtitle.mergeSelected()
}

export async function splitCueAt(cue: MergedCue, atSecond: number): Promise<void> {
  await stores().subtitle.splitAt(cue, atSecond)
}

/* -------------------------------- 复制到剪贴板 ------------------------------- */

/** 复制指定几条字幕的文本；不传就按当前选中（没选中则全部） */
export async function copyCueTexts(cues?: MergedCue[]): Promise<void> {
  const s = stores()
  const list =
    cues ??
    (s.subtitle.selected.size
      ? s.subtitle.cues.filter((c) => s.subtitle.selected.has(c.index))
      : s.subtitle.cues)
  const text = list
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join('\n')
  if (!text) {
    s.ui.showToast('没有可复制的内容', 'error')
    return
  }
  await window.api.copyText(text)
  s.ui.showToast(`已复制 ${list.length} 条字幕文本`, 'success')
}

export function copySelectedText(): Promise<void> {
  return copyCueTexts()
}

/**
 * 复制某一条字幕的 B站 链接（带分P 与时间戳）。
 * 直接粘到浏览器就能跳到那一刻，比手抄时间方便得多。
 */
export async function copyCueLink(cue?: MergedCue): Promise<void> {
  const s = stores()
  const target = cue ?? s.subtitle.cues.find((c) => c.index === s.subtitle.cursor)
  const video = s.subtitle.video
  if (!video?.bvid || !target) {
    s.ui.showToast('需要先打开一个带 BV 号的视频', 'error')
    return
  }
  const url = `https://www.bilibili.com/video/${video.bvid}?p=${target.page}&t=${Math.max(0, Math.floor(target.start))}`
  await window.api.copyText(url)
  s.ui.showToast(`已复制链接：${url}`, 'success', 4600)
}

export function copyTimestampLink(): Promise<void> {
  return copyCueLink()
}

/** 单独把某一条字幕加进切片任务（右键菜单用） */
export async function enqueueSingleCue(cue: MergedCue): Promise<void> {
  await stores().clip.enqueueOne(cue.start, cue.end, cue.page, cue.docId)
}

/* -------------------------------- 切片任务 -------------------------------- */

export async function loadClips(): Promise<void> {
  await stores().clip.loadClips()
}

export async function enqueueCurrentRanges(notePrefix?: string): Promise<void> {
  await stores().clip.enqueueCurrentRanges(notePrefix)
}

export async function exportSlice(format: 'csv' | 'xlsx'): Promise<void> {
  await stores().clip.exportTable(format)
}

export async function loadSliceHistory(): Promise<void> {
  await stores().clip.loadHistory()
}

export async function moveClip(id: number, dir: -1 | 1): Promise<void> {
  await stores().clip.move(id, dir)
}

export async function renameClip(id: number, note: string): Promise<void> {
  await stores().clip.rename(id, note)
}

/* ------------------------------ 片段（第三阶段） ----------------------------- */

/** 改名：片段名称（与输出文件名分开） */
export async function renameClipName(id: number, name: string): Promise<void> {
  await stores().clip.renameName(id, name)
}

export async function toggleClipFavorite(id: number): Promise<void> {
  await stores().clip.toggleFavorite(id)
}

export async function getClipTagIds(clipId: number): Promise<number[]> {
  return stores().clip.getTagIds(clipId)
}

export async function setClipTags(clipId: number, tagIds: number[]): Promise<void> {
  await stores().clip.setTags(clipId, tagIds)
}

export async function exportClipsJson(): Promise<void> {
  await stores().clip.exportJson()
}

export async function importClipsJson(): Promise<void> {
  await stores().clip.importJson()
}

export async function clearSliceHistory(): Promise<void> {
  await stores().clip.clearHistory()
}

export async function retryFailedSlices(): Promise<void> {
  await stores().clip.retryFailed()
}

export async function refreshSliceCheck(): Promise<void> {
  await stores().clip.refreshCheck()
}

export async function startSlice(): Promise<void> {
  await stores().clip.startSlice()
}

export async function cancelSlice(): Promise<void> {
  await stores().clip.cancel()
}

export async function openSliceOutput(): Promise<void> {
  await stores().clip.openOutputDir()
}

/* -------------------------------- 拖拽导入 -------------------------------- */

/**
 * 把拖进窗口的字幕文件导入资源库。
 * 路径校验在主进程做（只认 .srt/.vtt/.txt 且真实存在），这里只负责提示与刷新。
 */
export async function importDroppedSrt(paths: string[]): Promise<void> {
  const s = stores()
  const res = await window.api.importDroppedSrt(paths)
  if (!res.ok || !res.data) {
    s.ui.showToast(res.message || '导入失败', 'error', 5200)
    return
  }
  await s.resource.load()
  const { imported, updated, failures } = res.data
  s.ui.showToast(
    `已导入 ${imported} 个，更新 ${updated} 个${failures.length ? `，跳过 ${failures.length} 个` : ''}`,
    'success',
    5200
  )
  if (failures.length) s.ui.showToast(failures.slice(0, 3).join('\n'), 'error', 7000)
}

/* -------------------------------- 全库检索 -------------------------------- */

export const searchHitKey = hitKey

export function openLibrarySearch(): void {
  stores().ui.view = 'search'
}

export async function runLibrarySearch(): Promise<void> {
  await stores().search.run()
}

export function toggleSearchHit(hit: CueSearchHit): void {
  stores().search.toggle(hit)
}

export function selectAllSearchHits(): void {
  stores().search.selectAll()
}

export function clearSearchHits(): void {
  stores().search.clearSelected()
}

export async function openSearchHit(hit: CueSearchHit): Promise<void> {
  await stores().search.jump(hit)
}

export async function enqueueSearchHits(): Promise<void> {
  await stores().search.enqueueSelected()
}
