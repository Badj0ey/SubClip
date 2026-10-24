/**
 * 语义检索 store（第四阶段下半）。
 *
 * 与「全文检索」是什么关系：**互补，不是替代**。
 * - 全文检索（FTS5）：知道要找哪个词时最快、最准，本地、零依赖；
 * - 语义检索（本地 Embedding）：「按意思找」—— 搜「怎么剪短视频」能命中
 *   「做长视频切条的几个要点」这种一个词都不重合的段落。
 *
 * 成本也是互补的：语义检索要下 ~95MB 模型、要花时间建向量索引，
 * 所以它是**可选能力**，没建好索引时全文检索完全不受影响。
 */
import { defineStore } from 'pinia'
import type { SemanticHit, SemanticStatus } from '@shared/types'
import { useUiStore } from './ui'
import { useSubtitleStore } from './subtitle'
import { useResourceStore } from './resource'
import { useClipStore } from './clip'

const EMPTY_STATUS: SemanticStatus = {
  modelReady: false,
  modelSizeMb: 0,
  loaded: false,
  totalChunks: 0,
  indexedChunks: 0,
  indexing: false,
  busy: 'idle',
  message: ''
}

export const useSemanticStore = defineStore('semantic', {
  state: () => ({
    status: { ...EMPTY_STATUS } as SemanticStatus,
    /** 模型缓存目录（手动放模型文件时要显示给用户） */
    modelPath: '',
    /** 语义搜索结果 */
    hits: [] as SemanticHit[],
    /** 结果是否不完整（索引还没建完） */
    partial: false,
    searching: false,
    /** 已经搜过至少一次（区分「没搜」与「没结果」） */
    done: false,
    /** 当前关键词（与全文检索的关键词分开，避免互相覆盖） */
    keyword: '',
    /** 轮询句柄 */
    _timer: null as ReturnType<typeof setInterval> | null
  }),

  getters: {
    /** 索引进度（0~100） */
    progress(state): number {
      if (!state.status.totalChunks) return 0
      return Math.round((state.status.indexedChunks / state.status.totalChunks) * 100)
    },
    /** 现在能不能直接语义搜索 */
    usable(state): boolean {
      return state.status.modelReady && state.status.indexedChunks > 0
    }
  },

  actions: {
    async refresh(): Promise<void> {
      this.status = await window.api.semanticStatus()
    },

    async loadModelPath(): Promise<void> {
      this.modelPath = await window.api.semanticModelPath()
    },

    /** 开始轮询状态（下载 / 建索引都是后台跑的，界面靠它出进度） */
    startPolling(intervalMs = 1200): void {
      if (this._timer) return
      this._timer = setInterval(() => {
        void this.refresh()
      }, intervalMs)
    },

    stopPolling(): void {
      if (this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
    },

    /** 下载模型（约 95MB；失败会把原因放进 status.message） */
    async downloadModel(): Promise<boolean> {
      const ui = useUiStore()
      this.startPolling()
      const res = await window.api.semanticDownload()
      this.status = await window.api.semanticStatus()
      if (res.ok) ui.showToast('模型下载完成，可以开始建索引了', 'success', 4600)
      else ui.showToast(res.message || '模型下载失败', 'error', 8000)
      if (this.status.modelReady) this.stopPolling()
      return res.ok
    },

    async deleteModel(): Promise<void> {
      const ui = useUiStore()
      this.status = await window.api.semanticDeleteModel()
      ui.showToast('已删除模型（索引仍在，重新下载后可直接复用）', 'success')
    },

    /** 开始 / 继续建索引 */
    async startIndex(): Promise<void> {
      const ui = useUiStore()
      if (!this.status.modelReady) {
        ui.showToast('请先下载模型（设置 → 语义检索）', 'error', 5200)
        return
      }
      this.status = await window.api.semanticIndex()
      this.startPolling()
      ui.showToast('已开始建索引，可以继续做别的事', 'info', 4200)
    },

    async stopIndex(): Promise<void> {
      const ui = useUiStore()
      this.status = await window.api.semanticStopIndex()
      ui.showToast('已请求暂停（当前这一批跑完就停）', 'info')
    },

    async clearIndex(): Promise<void> {
      const ui = useUiStore()
      this.status = await window.api.semanticClearIndex()
      this.hits = []
      this.done = false
      ui.showToast('已清空语义索引', 'success')
    },

    /** 按意思搜索 */
    async run(): Promise<void> {
      const ui = useUiStore()
      const keyword = this.keyword.trim()
      if (!keyword) {
        ui.showToast('请输入要搜索的意思（可以用一整句话）', 'error')
        return
      }
      if (!this.status.modelReady) {
        ui.showToast('语义检索需要先下载模型（设置 → 语义检索）', 'error', 5200)
        return
      }
      this.searching = true
      try {
        const res = await window.api.semanticSearch({ keyword, limit: 50 })
        if (!res.ok || !res.data) {
          ui.showToast(res.message || '语义搜索失败', 'error', 5200)
          return
        }
        this.hits = res.data.hits
        this.partial = res.data.partial
        this.done = true
        if (!this.hits.length && res.data.totalChunks === 0) {
          // 最常见的「搜了没结果」其实是索引还没建
          ui.showToast('索引还没建：设置 → 语义检索 → 开始建索引', 'info', 5600)
        }
      } finally {
        this.searching = false
      }
    },

    /** 命中跳转（复用全文检索那套：打开文档 + 精确跳转 + 播放器跟随） */
    async jump(hit: SemanticHit): Promise<void> {
      const sub = useSubtitleStore()
      await sub.open(hit.docId, hit.index)
      const resource = useResourceStore()
      resource.activeKey = `video:${hit.videoId}`
      resource.expandTo(resource.activeKey)
      sub.followCueAt(hit.index)
    },

    /** 把一条语义命中加入切片任务 */
    async enqueue(hit: SemanticHit): Promise<void> {
      const ui = useUiStore()
      const res = await window.api.addClipsFromSearch({
        hits: [
          {
            docId: hit.docId,
            bvid: hit.bvid,
            page: hit.page,
            start: hit.start,
            end: hit.end,
            text: hit.text.slice(0, 60),
            videoTitle: hit.videoTitle
          }
        ],
        notePrefix: '语义'
      })
      if (!res.ok) {
        ui.showToast(res.message || '加入切片任务失败', 'error')
        return
      }
      await useClipStore().loadClips()
      ui.showToast('已加入 1 条切片任务', 'success')
    }
  }
})
