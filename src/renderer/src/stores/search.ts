/**
 * 全库检索 store（第一阶段-1）。
 *
 * 这是「字幕检索」工具的本体：一次搜遍库里所有视频 / 分P 的字幕
 * （主进程走 SQLite FTS5，短词回退 LIKE），命中可以批量加入切片任务。
 *
 * 与 `subtitle` store 里的 `keyword` 区别：
 * - 这里搜**整个库**（跨文档），结果是 `CueSearchHit[]`；
 * - `subtitle.keyword` 只作用于**当前打开的文档**（阅读区高亮定位）。
 * 两者以前挤在一个 state 里，命名上容易写错，现在彻底分开。
 */
import { defineStore } from 'pinia'
import type { CueSearchHit } from '@shared/types'
import { emit } from '@renderer/bus'
import { useUiStore } from './ui'
import { useSubtitleStore } from './subtitle'
import { useClipStore } from './clip'
import { useJobsStore } from './jobs'
import { useResourceStore } from './resource'

export type SearchScope = 'all' | 'video' | 'collection'

/** 命中的稳定 key（纯函数，组件与 store 共用） */
export function hitKey(hit: CueSearchHit): string {
  return `${hit.docId}:${hit.index}`
}

/**
 * 高级筛选（第四阶段）。
 *
 * 这些都是**服务端（SQL）筛选**，不是拿回来再过滤：
 * 「先取 200 条再筛」会把符合条件的条目挡在 200 名之外，看起来就是「搜不到」。
 */
export interface SearchFilters {
  /** 只看带这些标签的视频（多个之间「或」） */
  tagIds: number[]
  /** 只要收藏过的视频 */
  favoriteOnly: boolean
  /** 入库时间范围（本地日期字符串 yyyy-MM-dd，空表示不限） */
  createdFrom: string
  createdTo: string
  /** 单条字幕时长（秒，空表示不限）。注意 `v-model.number` 清空后会得到空字符串 */
  minDuration: number | null
  maxDuration: number | null
}

/** 把「空的 / 非数字的」时长输入统一成 null（`v-model.number` 清空会给空字符串） */
function numOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function emptyFilters(): SearchFilters {
  return {
    tagIds: [],
    favoriteOnly: false,
    createdFrom: '',
    createdTo: '',
    minDuration: null,
    maxDuration: null
  }
}

/** 本地日期（yyyy-MM-dd）→ 当天 00:00 / 23:59:59.999 的时间戳 */
function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const t = new Date(`${value}T00:00:00`).getTime()
  return Number.isFinite(t) ? t : undefined
}
function dayEnd(value: string): number | undefined {
  if (!value) return undefined
  const t = new Date(`${value}T23:59:59.999`).getTime()
  return Number.isFinite(t) ? t : undefined
}

/** 一页多少条（够用且不至于一次塞爆渲染进程） */
export const SEARCH_PAGE_SIZE = 100

export const useSearchStore = defineStore('search', {
  state: () => ({
    keyword: '',
    /** 检索范围：全部 / 当前视频 / 当前分组（合集或「单视频」） */
    scope: 'all' as SearchScope,
    /** 高级筛选 */
    filters: emptyFilters(),

    results: [] as CueSearchHit[],
    /** 命中总数（不是已加载条数） */
    total: 0,
    /** 命中数是否触顶（按标题搜时总量可能二十万+，只统计到上限） */
    totalCapped: false,
    /** 已加载到第几页（从 0 起） */
    page: 0,
    hasMore: false,

    /** 用 `${docId}:${index}` 作 key，避免跨文档时序号撞车 */
    selected: new Set<string>(),
    searching: false,
    /** 是否已经搜过一次（用于区分「还没搜」和「没结果」） */
    done: false,
    /** 加入切片任务时的备注前缀 */
    notePrefix: '检索'
  }),

  getters: {
    selectedHits(state): CueSearchHit[] {
      return state.results.filter((h) => state.selected.has(hitKey(h)))
    },
    /** 筛选条件里有没有启用的项（界面据此显示「清除筛选」与高亮） */
    hasActiveFilters(state): boolean {
      const f = state.filters
      return (
        f.tagIds.length > 0 ||
        f.favoriteOnly ||
        Boolean(f.createdFrom) ||
        Boolean(f.createdTo) ||
        numOrNull(f.minDuration) != null ||
        numOrNull(f.maxDuration) != null
      )
    }
  },

  actions: {
    /** 命中的稳定 key（组件里也常直接用 hitKey） */
    key(hit: CueSearchHit): string {
      return hitKey(hit)
    },

    /** 已勾选的命中条数 */
    selectedCount(): number {
      return this.selectedHits.length
    },

    resetFilters(): void {
      this.filters = emptyFilters()
    },

    toggleTagFilter(tagId: number): void {
      const has = this.filters.tagIds.includes(tagId)
      this.filters.tagIds = has
        ? this.filters.tagIds.filter((id) => id !== tagId)
        : [...this.filters.tagIds, tagId]
    },

    /** 组装实际发给主进程的查询参数（范围 + 筛选 + 分页） */
    buildQuery(offset: number): Parameters<typeof window.api.searchLibrary>[0] {
      const sub = useSubtitleStore()
      const q: Parameters<typeof window.api.searchLibrary>[0] = {
        keyword: this.keyword.trim(),
        limit: SEARCH_PAGE_SIZE,
        offset
      }
      // 范围只取自「当前打开的文档」，不需要额外查询
      if (this.scope === 'video' && sub.doc) q.videoId = sub.doc.videoId
      else if (this.scope === 'collection' && sub.video?.collectionId != null) {
        q.collectionId = sub.video.collectionId
      }
      const f = this.filters
      if (f.tagIds.length) q.tagIds = f.tagIds
      if (f.favoriteOnly) q.favoriteOnly = true
      const from = dayStart(f.createdFrom)
      const to = dayEnd(f.createdTo)
      if (from != null) q.createdFrom = from
      if (to != null) q.createdTo = to
      const min = numOrNull(f.minDuration)
      const max = numOrNull(f.maxDuration)
      if (min != null) q.minDuration = min
      if (max != null) q.maxDuration = max
      return q
    },

    /** 按当前关键词、范围与筛选检索整个字幕库（第一页） */
    async run(): Promise<void> {
      const ui = useUiStore()
      const keyword = this.keyword.trim()
      if (!keyword) {
        ui.showToast('请输入要检索的关键词', 'error')
        return
      }
      this.searching = true
      try {
        const page = await window.api.searchLibrary(this.buildQuery(0))
        this.results = page.hits
        this.total = page.total
        this.totalCapped = Boolean(page.totalCapped)
        this.hasMore = page.hasMore
        this.page = 0
        this.selected = new Set<string>()
        this.done = true
      } finally {
        this.searching = false
      }
    },

    /** 加载下一页并追加（「加载更多」按钮） */
    async loadMore(): Promise<void> {
      if (!this.hasMore || this.searching) return
      this.searching = true
      try {
        const next = this.page + 1
        const page = await window.api.searchLibrary(this.buildQuery(next * SEARCH_PAGE_SIZE))
        // 去重后追加（排序稳定，理论上不会重复，但不去重一旦重复就是难以察觉的脏数据）
        const seen = new Set(this.results.map(hitKey))
        this.results = [...this.results, ...page.hits.filter((h) => !seen.has(hitKey(h)))]
        this.total = page.total
        this.totalCapped = Boolean(page.totalCapped)
        this.hasMore = page.hasMore
        this.page = next
      } finally {
        this.searching = false
      }
    },

    toggle(hit: CueSearchHit): void {
      const k = hitKey(hit)
      const next = new Set(this.selected)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      this.selected = next
    },

    selectAll(): void {
      this.selected = new Set(this.results.map(hitKey))
    },

    clearSelected(): void {
      this.selected = new Set<string>()
    },

    /** 点检索结果 → 打开对应文档并精确跳到那一条 */
    async jump(hit: CueSearchHit): Promise<void> {
      const sub = useSubtitleStore()
      await sub.open(hit.docId, hit.index)
      // 树上的高亮与展开跟着走：否则左侧看不出「现在在哪」
      const resource = useResourceStore()
      resource.activeKey = `video:${hit.videoId}`
      resource.expandTo(resource.activeKey)
      // 播放器跟随（接线在 stores/ipcEvents.ts 的 setupBusWiring）
      emit('search.jump', { hit })
    },

    /** 把选中的检索结果批量加入切片任务（每条命中 = 一个时间范围） */
    async enqueueSelected(): Promise<void> {
      const ui = useUiStore()
      const hits = this.selectedHits
      if (!hits.length) {
        ui.showToast('请先勾选要加入的检索结果', 'error')
        return
      }
      const res = await window.api.addClipsFromSearch({
        hits: hits.map((h) => ({
          docId: h.docId,
          bvid: h.bvid,
          page: h.page,
          start: h.start,
          end: h.end,
          text: h.text,
          videoTitle: h.videoTitle
        })),
        notePrefix: this.notePrefix || '检索'
      })
      if (!res.ok) {
        ui.showToast(res.message || '加入切片任务失败', 'error')
        return
      }
      await useClipStore().loadClips()
      /**
       * 同时刷新**任务队列**。
       *
       * `addClipsFromSearch` 会顺带排任务（`withPendingJob`），
       * 但只刷新片段列表的话，剪辑任务页的待处理数不会变 ——
       * 用户会以为「加了但没进队列」（上一轮在素材库入口踩过同样的问题）。
       */
      await useJobsStore().load()
      ui.showToast(`已加入 ${res.data?.count ?? 0} 条切片任务`, 'success')
    }
  }
})
