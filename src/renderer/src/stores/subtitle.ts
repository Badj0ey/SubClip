/**
 * 字幕 store（第一阶段-1）—— 整个工具最核心的一块。
 *
 * 职责：
 * - 当前打开的文档 + 同一视频的全部字幕轨（多分P 合并阅读）
 * - 勾选（单选 / Shift 连选 / 全选 / 反选）与光标
 * - 当前文档内的搜索（关键词高亮、匹配定位）
 * - 双语对照
 * - 字幕编辑（合并 / 拆分 / 撤销 / 重做）
 * - 由勾选推导出的时间范围 `ranges`
 *
 * 不负责：切片任务（`clip` store）、全库检索（`search` store）、
 * 资源树（`resource` store）、视图与提示条（`ui` store）。
 *
 * 拆出来的原因：原先这些全在一个模块级 `reactive` 里，任何一处改动都可能
 * 影响其它功能；现在按域收进 store，改字幕不会碰到切片逻辑。
 */
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { Cue, MergedCue, SubtitleDoc, TimeRange, VideoItem } from '@shared/types'
import { buildRanges } from '@shared/ranges'
import { cueIndexesInRange } from '@shared/timeline'
import { emit } from '@renderer/bus'
import { useUiStore } from './ui'
import { useSettingsStore } from './settings'

/**
 * 滚动能力由阅读区组件注册进来（虚拟滚动下目标行可能还没渲染）。
 *
 * 刻意放在模块级普通变量而不是 store state 里：它是 DOM 回调，
 * 进响应式只会徒增开销，而且没有任何界面需要「观察」它。
 */
let scroller: ((index: number) => void) | null = null

interface UndoEntry {
  docId: number
  label: string
  cues: Cue[]
}

export const useSubtitleStore = defineStore('subtitle', {
  state: () => ({
    /* -------------------------------- 当前文档 ------------------------------- */
    activeDocId: null as number | null,
    doc: null as SubtitleDoc | null,
    /** 当前视频下的全部字幕文档（多P 合并阅读用） */
    docs: [] as SubtitleDoc[],
    video: null as (VideoItem & { uploaderName?: string }) | null,
    /** 合并后的字幕列表（同一视频多个分P 首尾相接，全局重新编号） */
    cues: [] as MergedCue[],

    /** 打开文档后需要聚焦到的来源文档（阅读区据此滚到该分P 的第一条） */
    focusDocId: null as number | null,
    /** 需要精确聚焦到某一条（全库检索跳转用；null 表示只定位该分P 第一条） */
    focusCueIndex: null as number | null,
    /** 每次点击都自增：即使重复点同一个分P 也能重新触发跳转 */
    focusNonce: 0,

    /* --------------------------------- 勾选 --------------------------------- */
    selected: new Set<number>(),
    /** Shift 连选的锚点 */
    anchor: null as number | null,
    cursor: 1,
    /** 请求进入编辑态的信号（自增即触发，组件 watch 它） */
    editNonce: 0,

    /* ------------------------------- 文档内搜索 ------------------------------ */
    keyword: '',
    /** 合并相邻段的时间间隔阈值（秒） */
    maxGap: 0.5,

    /* -------------------------------- 双语对照 ------------------------------- */
    /** 同一视频的全部字幕轨（含不同语言） */
    siblingDocs: [] as SubtitleDoc[],
    /** 对照轨的 docId；null 表示未开启对照 */
    compareDocId: null as number | null,
    /** 对照轨属于哪个分P（对照只在同一分P 内有意义） */
    comparePage: null as number | null,
    /** 对照轨的正文 */
    compareCues: [] as Cue[],

    /* ------------------------------- 编辑撤销栈 ------------------------------ */
    // 撤销 / 重做栈刻意不放进 state 的深层响应式对象里：里面存的是 cue 快照，
    // 深度代理既浪费性能又会在传给 IPC 时炸掉。用普通数组 + 计数 ref 暴露状态。
    _undoStack: [] as UndoEntry[],
    _redoStack: [] as UndoEntry[],
    undoDepth: 0,
    undoLabel: '',
    redoDepth: 0,
    redoLabel: ''
  }),

  getters: {
    /** 当前文档内的关键词命中序号 */
    matchedIndexes(state): number[] {
      const kw = state.keyword.trim().toLowerCase()
      if (!kw) return []
      return state.cues
        .filter((c) => c.text.toLowerCase().includes(kw) || String(c.index) === kw)
        .map((c) => c.index)
    },

    /** 由勾选推导出的时间范围（连续合并、非连续分段、跨P 分段） */
    ranges(state): TimeRange[] {
      return buildRanges(state.cues, state.selected, state.maxGap)
    },

    selectedCues(state): MergedCue[] {
      return state.cues.filter((c) => state.selected.has(c.index))
    },

    /** 阅读条是否启用（默认开） */
    readLineEnabled(): boolean {
      return useSettingsStore().readLineEnabled
    }
  },

  actions: {
    /* -------------------------------- 打开文档 ------------------------------- */

    /**
     * 打开字幕文档。
     * 会把同一视频的所有分P 字幕合并成一个连续列表，便于连续阅读与跨P 切片。
     *
     * @param focusOrigIndex 需要精确跳到的那一条（全库检索用），不传则定位到该分P 的第一条
     */
    async open(docId: number, focusOrigIndex?: number): Promise<void> {
      const ui = useUiStore()
      ui.loading = true
      try {
        const merged = await window.api.loadMerged(docId)
        if (!merged) {
          ui.showToast('字幕不存在', 'error')
          return
        }
        this.activeDocId = docId
        this.doc = merged.doc as SubtitleDoc
        this.video = merged.video
        this.docs = merged.docs as SubtitleDoc[]
        this.cues = merged.cues as MergedCue[]
        this.selected = new Set<number>()
        this.anchor = null
        // 光标落在该分P 的第一条上；阅读区渲染后会把这一条对齐到阅读条
        const firstOfDoc = this.cues.findIndex((c) => c.docId === docId)
        this.cursor = firstOfDoc >= 0 ? this.cues[firstOfDoc].index : 1
        this.focusDocId = docId
        this.focusCueIndex = focusOrigIndex ?? null
        this.focusNonce++
        ui.view = 'library'
        // 换文档了，对照轨要跟着重算（不在同一视频里就自动关掉）
        await this.loadSiblingDocs()
        emit('subtitle.docChanged', { docId })
      } finally {
        ui.loading = false
      }
    },

    /** 重新加载当前文档（编辑 / 撤销后刷新阅读区） */
    async reload(): Promise<void> {
      const id = this.activeDocId
      if (id == null) return
      const merged = await window.api.loadMerged(id)
      if (!merged) return
      this.doc = merged.doc as SubtitleDoc
      this.video = merged.video
      this.docs = merged.docs as SubtitleDoc[]
      this.cues = merged.cues as MergedCue[]
    },

    /**
     * 清空阅读区。
     * 删除节点时如果删的正是当前文档，资源库 store 会调它。
     */
    clear(): void {
      this.activeDocId = null
      this.doc = null
      this.docs = []
      this.video = null
      this.cues = []
      this.selected = new Set<number>()
      this.anchor = null
      this.compareDocId = null
      this.comparePage = null
      this.compareCues = []
      this.siblingDocs = []
      emit('subtitle.docChanged', { docId: null })
    },

    /* --------------------------------- 勾选 --------------------------------- */

    toggleSelect(index: number, shift = false): void {
      if (shift && this.anchor !== null) {
        const from = Math.min(this.anchor, index)
        const to = Math.max(this.anchor, index)
        const on = !this.selected.has(index)
        for (let i = from; i <= to; i++) {
          if (on) this.selected.add(i)
          else this.selected.delete(i)
        }
      } else {
        if (this.selected.has(index)) this.selected.delete(index)
        else this.selected.add(index)
        this.anchor = index
      }
      this.cursor = index
      // 通知外界「选中变了」：视频预览据此跟随（接线在 stores/ipcEvents.ts）
      emit('subtitle.select', { index, shift })
    },

    selectAll(): void {
      for (const c of this.cues) this.selected.add(c.index)
    },

    /**
     * 按时间范围选中字幕（第八阶段：素材推荐点「打开并选中」用）。
     *
     * 用**重叠**判定（`cueIndexesInRange`）：推荐给出的是段落边界，
     * 与字幕行几乎不可能精确对齐，用包含判定会「点了却没选中任何东西」。
     *
     * @param replace 是否替换当前选择（默认替换）
     * @returns 选中的字幕条数
     */
    selectRange(start: number, end: number, replace = true): number {
      const indexes = cueIndexesInRange(this.cues, start, end)
      if (!indexes.length) return 0
      if (replace) this.selected = new Set<number>()
      for (const i of indexes) this.selected.add(i)
      this.anchor = indexes[0]
      this.cursor = indexes[0]
      emit('subtitle.select', { index: indexes[0], shift: false })
      return indexes.length
    },

    clearSelection(): void {
      this.selected = new Set<number>()
      this.anchor = null
    },

    invertSelection(): void {
      const next = new Set<number>()
      for (const c of this.cues) if (!this.selected.has(c.index)) next.add(c.index)
      this.selected = next
    },

    /** 选中当前搜索的全部命中 */
    selectMatches(): void {
      for (const i of this.matchedIndexes) this.selected.add(i)
    },

    setCursor(index: number): void {
      this.cursor = index
    },

    moveCursor(delta: number, extend = false): void {
      if (!this.cues.length) return
      const idx = this.cues.findIndex((c) => c.index === this.cursor)
      const nextIdx = Math.max(0, Math.min(this.cues.length - 1, (idx < 0 ? 0 : idx) + delta))
      const target = this.cues[nextIdx]
      if (!target) return
      if (extend) {
        if (this.anchor === null) this.anchor = this.cursor
        this.toggleSelect(target.index, true)
        return
      }
      this.cursor = target.index
      // 上下移动光标也带着播放器走，跟读才连贯
      emit('subtitle.select', { index: target.index })
    },

    /**
     * 滚动定位委托给字幕列表组件（模块级 `scroller`，见文件头注释）。
     */
    registerScroller(fn: ((index: number) => void) | null): void {
      scroller = fn
    },

    scrollToCursor(): void {
      scroller?.(this.cursor)
    },

    /** 请求进入当前条的编辑态（由快捷键触发，组件 watch editNonce） */
    requestEditCurrent(): void {
      if (!this.cues.length) return
      this.editNonce++
    },

    /**
     * 请求播放器跳到某条字幕所在时刻。
     *
     * 组件不该直接认识 video store（那是跨域依赖），所以这里统一**经过总线**广播，
     * 由 `stores/ipcEvents.ts` 的 `setupBusWiring()` 接给播放器。
     */
    followCueAt(index: number): void {
      emit('subtitle.select', { index })
    },

    /* -------------------------------- 双语对照 ------------------------------- */

    /**
     * 列出同一视频的全部字幕轨，供「对照」下拉选择。
     * 合并阅读每分P 只取一条轨，所以另一条语言不在 `docs` 里，必须单独查。
     */
    async loadSiblingDocs(): Promise<void> {
      const id = this.doc?.id
      this.siblingDocs = id == null ? [] : await window.api.listSiblingDocs(id)
      // 当前对照轨已不在这个视频里（比如换视频了）就自动关掉
      if (this.compareDocId != null && !this.siblingDocs.some((d) => d.id === this.compareDocId)) {
        this.compareDocId = null
        this.comparePage = null
        this.compareCues = []
      }
    },

    /** 开启 / 关闭对照，或换一条对照轨 */
    async setCompareDoc(docId: number | null): Promise<void> {
      if (docId == null) {
        this.compareDocId = null
        this.comparePage = null
        this.compareCues = []
        return
      }
      const doc = this.siblingDocs.find((d) => d.id === docId)
      this.compareDocId = docId
      this.comparePage = doc?.page ?? null
      this.compareCues = (await window.api.getCues(docId)) as Cue[]
    },

    /**
     * 找出与某条合并字幕对应的对照文本。
     *
     * 前提是「同一分P」—— 拿 P1 的中文去对 P2 的英文没有意义，所以分P 不同直接返回空。
     * 优先按相同原始序号匹配（翻译轨通常与原文轨一一对应）；
     * 对不上时退化为时间重叠最多的那条。
     */
    compareTextFor(cue: MergedCue): string {
      if (!this.compareCues.length || this.comparePage == null) return ''
      if (this.comparePage !== cue.page) return ''

      const exact = this.compareCues.find((c) => c.index === cue.origIndex)
      if (exact) return exact.text

      let best = ''
      let bestScore = -1
      for (const c of this.compareCues) {
        const overlap = Math.min(cue.end, c.end) - Math.max(cue.start, c.start)
        if (overlap > bestScore) {
          bestScore = overlap
          best = c.text
        }
      }
      return bestScore > 0 ? best : ''
    },

    /* ------------------------------ 编辑撤销 / 重做 ---------------------------- */

    /** 同步对外暴露的撤销栈深度与标签 */
    _syncUndo(): void {
      this.undoDepth = this._undoStack.length
      this.undoLabel = this._undoStack.length
        ? this._undoStack[this._undoStack.length - 1].label
        : ''
      this.redoDepth = this._redoStack.length
      this.redoLabel = this._redoStack.length
        ? this._redoStack[this._redoStack.length - 1].label
        : ''
    },

    /**
     * 在破坏性编辑之前记一份快照。
     * 快照取的是**该文档自己的字幕**（不是合并列表），因此还原时直接写回即可。
     * 新编辑一旦发生，重做链就断了（这是撤销/重做的通用语义）。
     */
    async pushUndo(docId: number, label: string): Promise<void> {
      try {
        const cues = await window.api.getCues(docId)
        // markRaw：cue 快照要原样传回 IPC，不能被 reactive 包成 Proxy
        this._undoStack.push(markRaw({ docId, label, cues: cues as Cue[] }))
        while (this._undoStack.length > 20) this._undoStack.shift()
      } catch {
        /* 拿不到快照就不记，不影响编辑本身 */
      }
      this._redoStack.length = 0
      this._syncUndo()
    },

    async undoLastEdit(): Promise<void> {
      const ui = useUiStore()
      const entry = this._undoStack.pop()
      if (!entry) {
        this._syncUndo()
        ui.showToast('没有可撤销的操作', 'info')
        return
      }
      // 把「撤销前」的状态压进重做栈，才能再重做回来
      try {
        const current = await window.api.getCues(entry.docId)
        this._redoStack.push(markRaw({ docId: entry.docId, label: entry.label, cues: current as Cue[] }))
      } catch {
        /* 拿不到当前状态就不支持重做这一步，撤销本身照做 */
      }
      await window.api.updateCues(entry.docId, entry.cues)
      await this.reload()
      this._syncUndo()
      ui.showToast(`已撤销：${entry.label}`, 'success')
    },

    async redoLastEdit(): Promise<void> {
      const ui = useUiStore()
      const entry = this._redoStack.pop()
      if (!entry) {
        this._syncUndo()
        ui.showToast('没有可重做的操作', 'info')
        return
      }
      // 与撤销对称：把当前状态压回撤销栈
      try {
        const current = await window.api.getCues(entry.docId)
        this._undoStack.push(markRaw({ docId: entry.docId, label: entry.label, cues: current as Cue[] }))
      } catch {
        /* 同上 */
      }
      await window.api.updateCues(entry.docId, entry.cues)
      await this.reload()
      this._syncUndo()
      ui.showToast(`已重做：${entry.label}`, 'success')
    },

    /* ------------------------------ 合并 / 拆分 ------------------------------ */

    /** 合并当前选中的若干条字幕（必须都在当前打开的文档里） */
    async mergeSelected(): Promise<void> {
      const ui = useUiStore()
      const docId = this.doc?.id
      if (docId == null) {
        ui.showToast('请先打开一个字幕文档', 'error')
        return
      }
      const picked = this.cues.filter((c) => this.selected.has(c.index) && c.docId === docId)
      if (picked.length < 2) {
        ui.showToast('请先勾选同一分P 里至少 2 条字幕', 'error', 4600)
        return
      }
      await this.pushUndo(docId, `合并 ${picked.length} 条字幕`)
      const res = await window.api.mergeCues(
        docId,
        picked.map((c) => c.origIndex)
      )
      if (!res.ok) {
        ui.showToast(res.message || '合并失败', 'error')
        return
      }
      this.selected = new Set<number>()
      await this.reload()
      ui.showToast(`已合并 ${res.data?.merged ?? 0} 条字幕`, 'success')
    },

    /** 在某一条的内部时间点拆分它 */
    async splitAt(cue: MergedCue, atSecond: number): Promise<void> {
      const ui = useUiStore()
      await this.pushUndo(cue.docId, `拆分第 ${cue.index} 条`)
      const res = await window.api.splitCue(cue.docId, cue.origIndex, atSecond)
      if (!res.ok) {
        ui.showToast(res.message || '拆分失败', 'error', 4600)
        return
      }
      await this.reload()
      ui.showToast(`已在 ${atSecond.toFixed(2)} 秒处拆分`, 'success')
    }
  }
})
