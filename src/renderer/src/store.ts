import { computed, reactive, ref } from 'vue'
import type {
  AppSettings,
  ClipTask,
  Cue,
  CueSearchHit,
  SubtitleDoc,
  TimeRange,
  TreeNode,
  VideoItem
} from '@shared/types'
import type { BridgeStatus } from '@shared/bridge'
import type { MergedCue, SliceProgressInfo } from '@shared/types'
import { buildRanges } from '@shared/ranges'

interface ToastState {
  text: string
  type: 'info' | 'error' | 'success'
  visible: boolean
  timer: number | null
}

export const state = reactive({
  tree: [] as TreeNode[],
  expanded: new Set<string>(),
  treeFilter: '',
  favoriteOnly: false,

  activeKey: '' as string,
  activeDocId: null as number | null,
  /** 打开文档后需要聚焦到的来源文档（阅读区据此滚动到该分P 的第一条字幕） */
  focusDocId: null as number | null,
  /** 需要精确聚焦到某一条（全库检索跳转用；为 null 时只定位到该分P 的第一条） */
  focusCueIndex: null as number | null,
  /** 每次点击都自增：即使重复点同一个分P 也能重新触发跳转 */
  focusNonce: 0,
  doc: null as SubtitleDoc | null,
  /** 当前视频下的全部字幕文档（多P 合并阅读时用） */
  docs: [] as SubtitleDoc[],
  video: null as (VideoItem & { uploaderName?: string }) | null,
  cues: [] as MergedCue[],

  selected: new Set<number>(),
  anchor: null as number | null,
  cursor: 1,

  keyword: '',
  maxGap: 0.5,

  clips: [] as ClipTask[],
  settings: null as AppSettings | null,
  view: 'library' as 'library' | 'search' | 'settings',
  loading: false,
  bridge: null as BridgeStatus | null,

  /* 全库检索 */
  searchKeyword: '',
  /** 检索范围：全部 / 当前视频 / 当前分组（合集或「单视频」） */
  searchScope: 'all' as 'all' | 'video' | 'collection',
  searchResults: [] as CueSearchHit[],
  /** 用 `${docId}:${index}` 作 key，避免跨文档时序号撞车 */
  searchSelected: new Set<string>(),
  searching: false,
  /** 是否已经搜过一次（用于区分「还没搜」和「没结果」） */
  searchDone: false,
  searchNotePrefix: '检索',

  /* 本地切片 */
  ffmpegReady: false,
  ffmpegPath: '',
  sliceRunning: false,
  sliceProgress: null as SliceProgressInfo | null,
  sliceResult: null as { ok: number; failed: number; outputs: string[]; messages: string[] } | null,

  toast: { text: '', type: 'info', visible: false, timer: null } as ToastState
})

/* --------------------------------- 计算属性 -------------------------------- */

export const matchedIndexes = computed<number[]>(() => {
  const kw = state.keyword.trim().toLowerCase()
  if (!kw) return []
  return state.cues
    .filter((c) => c.text.toLowerCase().includes(kw) || String(c.index) === kw)
    .map((c) => c.index)
})

export const ranges = computed<TimeRange[]>(() =>
  buildRanges(state.cues, state.selected, state.maxGap)
)

export const selectedCues = computed(() => state.cues.filter((c) => state.selected.has(c.index)))

/* ---------------------------------- 工具 ---------------------------------- */

export function toast(text: string, type: ToastState['type'] = 'info', duration = 2600): void {
  const t = state.toast
  if (t.timer) window.clearTimeout(t.timer)
  t.text = text
  t.type = type
  t.visible = true
  t.timer = window.setTimeout(() => {
    t.visible = false
    t.timer = null
  }, duration)
}

export function applyTheme(theme: AppSettings['theme']): void {
  const root = document.documentElement
  let effective = theme
  if (theme === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  root.setAttribute('data-theme', effective)
  if (state.settings) {
    root.style.setProperty('--font-family', state.settings.fontFamily || '')
    root.style.setProperty('font-size', `${state.settings.fontSize}px`)
  }
}

export function applyReadingStyle(): void {
  const s = state.settings
  if (!s) return
  document.documentElement.style.setProperty('--line-height', String(s.lineHeight))
  document.documentElement.style.setProperty('--font-size', `${s.fontSize}px`)
  document.body.style.fontSize = `${s.fontSize}px`
}

/* ---------------------------------- 加载 ---------------------------------- */

export async function initApp(): Promise<void> {
  state.settings = await window.api.getSettings()
  applyTheme(state.settings.theme)
  applyReadingStyle()
  setupBridgeListeners()
  window.api.onSliceProgress((p) => {
    state.sliceProgress = p
  })
  await loadTree()
  await loadClips()
  await loadBridgeStatus()
  await refreshSliceCheck()
}

/* ------------------------------ 浏览器插件通信 ----------------------------- */

export async function loadBridgeStatus(): Promise<void> {
  try {
    state.bridge = await window.api.bridgeStatus()
  } catch {
    state.bridge = null
  }
}

export async function restartBridge(port?: number): Promise<void> {
  state.bridge = await window.api.bridgeRestart(port)
  toast(
    state.bridge.running ? `本地服务已启动，端口 ${state.bridge.port}` : '本地服务启动失败',
    state.bridge.running ? 'success' : 'error'
  )
}

function setupBridgeListeners(): void {
  window.api.onBridgeStatus((s) => {
    state.bridge = s
  })

  window.api.onBridgePageInfo(({ info, videoId, message }) => {
    if (videoId) {
      toast(`插件已同步：${info.title || info.bvid}`, 'success')
      // 展开到刚同步的视频，但不影响其它已展开的分支
      void loadTree(`video:${videoId}`)
    } else {
      // 合集页 / 收藏夹 / 投稿页没有具体视频，不再因此建出空条目
      toast(message || '该页面没有可同步的视频', 'info', 4200)
      void loadTree()
    }
  })

  window.api.onBridgeSubtitle((p) => {
    if (!p.ok) {
      toast(
        `插件推送的字幕为空或缺少 BV 号：${p.bvid || '(无 BV 号)'} P${p.page}`,
        'error',
        4200
      )
      void loadTree()
      return
    }
    const action = p.created ? '已导入' : '已更新'
    const where = p.unlinked
      ? '，暂时归入「未关联」，同步页面信息后会自动归位'
      : p.title
        ? ` → ${p.title}`
        : ''
    toast(
      `插件${action}字幕：${p.label}（${p.count} 条）${where}`,
      p.unlinked ? 'info' : 'success',
      p.unlinked ? 5200 : 4000
    )
    void loadTree()
  })

  window.api.onBridgeLog(({ level, message }) => {
    if (level === 'error' || level === 'warn') toast(message, 'error', 4200)
  })

  window.api.onDataWarning(({ message }) => {
    toast(message, 'error', 8000)
  })

  window.api.onBridgeCookies((p) => {
    if (p.ok) {
      toast(
        `已从浏览器同步登录状态${p.userName ? `（${p.userName}）` : ''}，现在可直接拉取字幕`,
        'success',
        4600
      )
      void refreshSettings()
      void loadBridgeStatus()
    } else {
      toast(`登录状态同步失败：${p.message ?? '未知原因'}`, 'error', 4600)
    }
  })
}

/** 重新拉取设置（例如插件刚同步了 Cookie） */
export async function refreshSettings(): Promise<void> {
  state.settings = await window.api.getSettings()
}

/** 找出从根到某个节点的整条路径 */
function findPath(nodes: TreeNode[], key: string, path: string[] = []): string[] | null {
  for (const n of nodes) {
    const next = [...path, n.key]
    if (n.key === key) return next
    if (n.children?.length) {
      const found = findPath(n.children, key, next)
      if (found) return found
    }
  }
  return null
}

/** 展开到指定节点（只追加，不收起已经展开的分支） */
export function expandTo(key: string): void {
  const path = findPath(state.tree, key)
  if (path) for (const k of path) state.expanded.add(k)
}

/**
 * 刷新资源树。
 * 已展开的分支会保留（不会因为刷新而收起），可选地展开到指定节点。
 */
export async function loadTree(expandKey?: string): Promise<void> {
  state.tree = await window.api.listTree()
  // 首次加载时默认展开第一层
  if (state.expanded.size === 0) {
    for (const n of state.tree) state.expanded.add(n.key)
  }
  if (expandKey) expandTo(expandKey)
}

export async function loadClips(): Promise<void> {
  state.clips = await window.api.listClips()
}

/**
 * 打开字幕文档。
 * 会把同一视频的所有分P 字幕合并成一个连续列表，便于连续阅读与跨P 切片。
 *
 * @param focusOrigIndex 需要精确跳到的那一条（全库检索用），不传则定位到该分P 的第一条
 */
export async function openDoc(docId: number, key = '', focusOrigIndex?: number): Promise<void> {
  state.loading = true
  try {
    const merged = await window.api.loadMerged(docId)
    if (!merged) {
      toast('字幕不存在', 'error')
      return
    }
    state.activeDocId = docId
    state.doc = merged.doc as SubtitleDoc
    state.video = merged.video
    state.docs = merged.docs as SubtitleDoc[]
    state.cues = merged.cues as MergedCue[]
    state.selected = new Set<number>()
    state.anchor = null
    // 光标落在该分P 的第一条上；阅读区渲染后会把这一条对齐到阅读条
    const firstOfDoc = state.cues.findIndex((c) => c.docId === docId)
    state.cursor = firstOfDoc >= 0 ? state.cues[firstOfDoc].index : 1
    state.focusDocId = docId
    state.focusCueIndex = focusOrigIndex ?? null
    state.focusNonce++
    if (key) state.activeKey = key
    state.view = 'library'
  } finally {
    state.loading = false
  }
}

/* ---------------------------------- 选择 ---------------------------------- */

export function toggleSelect(index: number, shift = false): void {
  if (shift && state.anchor !== null) {
    const from = Math.min(state.anchor, index)
    const to = Math.max(state.anchor, index)
    const on = !state.selected.has(index)
    for (let i = from; i <= to; i++) {
      if (on) state.selected.add(i)
      else state.selected.delete(i)
    }
  } else {
    if (state.selected.has(index)) state.selected.delete(index)
    else state.selected.add(index)
    state.anchor = index
  }
  state.cursor = index
}

export function selectAll(): void {
  for (const c of state.cues) state.selected.add(c.index)
}

export function clearSelection(): void {
  state.selected = new Set<number>()
  state.anchor = null
}

export function invertSelection(): void {
  const next = new Set<number>()
  for (const c of state.cues) if (!state.selected.has(c.index)) next.add(c.index)
  state.selected = next
}

/** 选中当前搜索结果 */
export function selectMatches(): void {
  for (const i of matchedIndexes.value) state.selected.add(i)
}

export function moveCursor(delta: number, extend = false): void {
  if (!state.cues.length) return
  const idx = state.cues.findIndex((c) => c.index === state.cursor)
  const nextIdx = Math.max(0, Math.min(state.cues.length - 1, (idx < 0 ? 0 : idx) + delta))
  const target = state.cues[nextIdx]
  if (!target) return
  if (extend) {
    if (state.anchor === null) state.anchor = state.cursor
    toggleSelect(target.index, true)
  }
  state.cursor = target.index
}

/**
 * 滚动定位委托给字幕列表组件。
 * 虚拟滚动下目标行可能尚未渲染，不能直接 querySelector。
 */
let scroller: ((index: number) => void) | null = null

export function registerScroller(fn: ((index: number) => void) | null): void {
  scroller = fn
}

export function scrollToCursor(): void {
  scroller?.(state.cursor)
}

/** 请求进入第 cursor 条的编辑态（由快捷键触发，组件监听） */
export const editRequest = ref(0)

export function requestEditCurrent(): void {
  if (!state.cues.length) return
  editRequest.value++
}

/* --------------------------------- 切片任务 -------------------------------- */

export async function enqueueCurrentRanges(notePrefix?: string): Promise<void> {
  if (!state.doc || !state.video) {
    toast('请先打开一个字幕文档', 'error')
    return
  }
  if (!ranges.value.length) {
    toast('还没有选中任何字幕', 'error')
    return
  }
  const res = await window.api.addClips({
    docId: state.doc.id,
    bvid: state.video.bvid || '',
    page: state.doc.page || 1,
    ranges: ranges.value.map((r) => ({
      start: r.start,
      end: r.end,
      segments: r.segments
    })),
    notePrefix: notePrefix || state.video.title || 'clip'
  })
  if (!res.ok) {
    toast(res.message || '加入切片任务失败', 'error')
    return
  }
  await loadClips()
  toast(`已加入 ${res.data?.count ?? 0} 条切片任务`, 'success')
}

export async function exportSlice(format: 'csv' | 'xlsx'): Promise<void> {
  if (!state.clips.length) {
    toast('切片任务列表为空，请先加入任务', 'error')
    return
  }
  const missing = state.clips.filter((t) => !t.bvid)
  if (missing.length) {
    toast(`有 ${missing.length} 条任务缺少 BV 号，切片工具可能无法处理`, 'error', 4200)
  }

  // 跨分P 的切片无法用单行表格表示，拆成多行输出
  const rows: Array<{ bvid: string; page: number; start: number; end: number; note: string }> = []
  let splitCount = 0
  for (const t of state.clips) {
    if (t.segments && t.segments.length > 1) {
      splitCount++
      t.segments.forEach((s, i) => {
        rows.push({
          bvid: t.bvid,
          page: s.page,
          start: s.start,
          end: s.end,
          note: `${t.note}_p${i + 1}`
        })
      })
    } else {
      rows.push({ bvid: t.bvid, page: t.page, start: t.start, end: t.end, note: t.note })
    }
  }

  const res = await window.api.exportClips({ rows, format })
  if (!res.ok || !res.data) {
    toast(res.message || '导出失败', 'error')
    return
  }
  toast(
    `已导出：${res.data.path}${splitCount ? `（${splitCount} 条跨分P 切片已拆成多行）` : ''}`,
    'success',
    5600
  )
  await window.api.showItem(res.data.path)
}

/* --------------------------------- 本地切片 -------------------------------- */

export async function refreshSliceCheck(): Promise<void> {
  try {
    const res = await window.api.sliceCheck()
    state.ffmpegReady = res.available
    state.ffmpegPath = res.ffmpeg
  } catch {
    state.ffmpegReady = false
  }
}

/** 用当前切片任务列表在本机直接切片 */
export async function startSlice(): Promise<void> {
  if (state.sliceRunning) return
  if (!state.clips.length) {
    toast('切片任务列表为空', 'error')
    return
  }
  if (!state.ffmpegReady) {
    toast('未检测到 ffmpeg，请先在「设置 → 本地切片」中配置', 'error', 5200)
    return
  }

  const usable = state.clips.filter((t) => t.bvid)
  if (!usable.length) {
    toast('所有任务都缺少 BV 号，无法切片', 'error', 5200)
    return
  }

  state.sliceRunning = true
  state.sliceProgress = null
  state.sliceResult = null

  try {
    const res = await window.api.sliceRun(
      usable.map((t) => ({
        bvid: t.bvid,
        page: t.page,
        start: t.start,
        end: t.end,
        note: t.note,
        segments: t.segments
      }))
    )
    if (!res.ok || !res.data) {
      toast(res.message || '切片失败', 'error', 5200)
      return
    }
    state.sliceResult = res.data
    if (res.data.ok > 0) {
      toast(
        `切片完成：成功 ${res.data.ok} 个${res.data.failed ? `，失败 ${res.data.failed} 个` : ''}`,
        'success',
        5200
      )
    } else {
      toast('没有生成任何切片', 'error', 5200)
    }
    if (res.data.messages.length) {
      toast(res.data.messages.slice(0, 3).join('\n'), 'error', 7000)
    }
  } finally {
    state.sliceRunning = false
    state.sliceProgress = null
  }
}

export async function cancelSlice(): Promise<void> {
  await window.api.sliceCancel()
  toast('已请求取消切片', 'info')
}

export async function openSliceOutput(): Promise<void> {
  const dir = state.settings?.sliceOutputDir?.trim() || state.settings?.outputDir || ''
  if (!dir) {
    toast('尚未设置输出目录', 'error')
    return
  }
  const err = await window.api.openPath(dir)
  if (err) toast(err, 'error', 4200)
}

/* -------------------------------- 全库检索 -------------------------------- */

/** 命中的稳定 key（跨文档时序号会重复，必须带上 docId） */
export function searchHitKey(hit: CueSearchHit): string {
  return `${hit.docId}:${hit.index}`
}

export function openLibrarySearch(): void {
  state.view = 'search'
}

/** 按当前关键词与范围检索整个字幕库 */
export async function runLibrarySearch(): Promise<void> {
  const keyword = state.searchKeyword.trim()
  if (!keyword) {
    toast('请输入要检索的关键词', 'error')
    return
  }
  state.searching = true
  try {
    // 范围只取自「当前打开的文档」，不需要额外查询
    const scope: { videoId?: number; collectionId?: number } = {}
    if (state.searchScope === 'video' && state.doc) {
      scope.videoId = state.doc.videoId
    } else if (state.searchScope === 'collection' && state.video?.collectionId != null) {
      scope.collectionId = state.video.collectionId
    }
    state.searchResults = await window.api.searchLibrary({ keyword, limit: 500, ...scope })
    state.searchSelected = new Set<string>()
    state.searchDone = true
  } finally {
    state.searching = false
  }
}

export function toggleSearchHit(hit: CueSearchHit): void {
  const key = searchHitKey(hit)
  const next = new Set(state.searchSelected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  state.searchSelected = next
}

export function selectAllSearchHits(): void {
  state.searchSelected = new Set(state.searchResults.map(searchHitKey))
}

export function clearSearchHits(): void {
  state.searchSelected = new Set<string>()
}

/** 点检索结果 → 打开对应文档并精确跳到那一条 */
export async function openSearchHit(hit: CueSearchHit): Promise<void> {
  await openDoc(hit.docId, `video:${hit.videoId}`, hit.index)
}

export const searchSelectedHits = computed(() =>
  state.searchResults.filter((h) => state.searchSelected.has(searchHitKey(h)))
)

/** 把选中的检索结果批量加入切片任务（每条命中 = 一个时间范围） */
export async function enqueueSearchHits(): Promise<void> {
  const hits = searchSelectedHits.value
  if (!hits.length) {
    toast('请先勾选要加入的检索结果', 'error')
    return
  }
  const res = await window.api.addClipsFromSearch({
    hits: hits.map((h) => ({
      docId: h.docId,
      bvid: h.bvid,
      page: h.page,
      start: h.start,
      end: h.end,
      text: h.text
    })),
    notePrefix: state.searchNotePrefix || '检索'
  })
  if (!res.ok) {
    toast(res.message || '加入切片任务失败', 'error')
    return
  }
  await loadClips()
  toast(`已加入 ${res.data?.count ?? 0} 条切片任务`, 'success')
}
