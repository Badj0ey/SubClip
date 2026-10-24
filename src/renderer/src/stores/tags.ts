/**
 * 标签 store（第三阶段：素材库升级）。
 *
 * 职责：标签的读取 / 新建 / 重命名 / 颜色备注，以及「给视频打标签」的批量操作。
 *
 * 为什么单独一个 store：标签是**跨对象**的一维（视频与片段共用同一套标签体系），
 * 放资源库或片段 store 都会造成「另一个也要用」的耦合。
 *
 * 对应提示词的「智能标签系统」：本轮只做 **A 方案（手动标签）**，
 * AI 自动标签（B/C 混合模式）留到第六阶段接 `AIProvider`，
 * 数据层已经预留好位置（`analysis` 表可存 `kind = 'tags'` 的建议结果）。
 */
import { defineStore } from 'pinia'
import type { TagInfo } from '@shared/types'
import { useUiStore } from './ui'
import { useResourceStore } from './resource'

/** 预置颜色（新建标签时按顺序轮流取；避免每个标签都长得一样） */
export const TAG_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16'
] as const

export const useTagsStore = defineStore('tags', {
  state: () => ({
    tags: [] as TagInfo[],
    loading: false
  }),

  getters: {
    /** 带标签的视频数总和（首页 / 统计用） */
    totalVideoTags(state): number {
      return state.tags.reduce((n, t) => n + t.videoCount, 0)
    },
    byId(state): Map<number, TagInfo> {
      return new Map(state.tags.map((t) => [t.id, t]))
    }
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.tags = await window.api.listTags()
      } finally {
        this.loading = false
      }
    },

    /**
     * 新建标签。
     * 已存在同名标签时不会报错（后端直接返回既有 id），
     * 并给出「已存在」的提示，避免用户以为没生效。
     */
    async create(name: string): Promise<number | null> {
      const ui = useUiStore()
      const value = name.trim()
      if (!value) {
        ui.showToast('标签名不能为空', 'error')
        return null
      }
      const existed = this.tags.find((t) => t.name === value)
      const res = await window.api.createTag(value)
      await this.load()
      await useResourceStore().load()
      // 新标签给个默认颜色，方便在一堆标签里区分。
      // 默认颜色按「当前数量」取模，所以每次都要重新读一遍 tags（上面 load 过）。
      if (!existed) {
        const color = TAG_COLORS[this.tags.length % TAG_COLORS.length]
        await this.updateMeta(res.id, { color })
        ui.showToast(`已新建标签「${value}」`, 'success')
      } else {
        ui.showToast(`标签「${value}」已存在`, 'info')
      }
      return res.id
    },

    async rename(id: number, name: string): Promise<void> {
      const ui = useUiStore()
      await window.api.renameTag(id, name)
      await this.load()
      await useResourceStore().load()
      ui.showToast('已重命名标签', 'success')
    },

    async remove(id: number): Promise<void> {
      const ui = useUiStore()
      await window.api.deleteTag(id)
      await this.load()
      await useResourceStore().load()
      ui.showToast('已删除标签（视频与片段未受影响）', 'success')
    },

    async updateMeta(id: number, patch: { color?: string; note?: string }): Promise<void> {
      this.tags = await window.api.updateTagMeta({ id, ...patch })
    },

    /** 某个视频身上的标签 id */
    videoTagIds(videoId: number): Promise<number[]> {
      return window.api.getVideoTags(videoId)
    },

    /** 覆盖式设置某个视频的标签 */
    async setVideoTags(videoId: number, tagIds: number[]): Promise<void> {
      await window.api.setVideoTags(videoId, tagIds)
      await this.load()
      await useResourceStore().load()
    },

    /**
     * 批量给多个视频**追加**标签。
     * 这是第三阶段新增的能力：以前只能一个一个视频打标签，
     * 想给「这次直播的 12 个分P」都打上「高光候选」得点 12 次。
     */
    async addToVideos(videoIds: number[], tagIds: number[]): Promise<void> {
      const ui = useUiStore()
      if (!videoIds.length || !tagIds.length) {
        ui.showToast('请先选择视频与标签', 'error')
        return
      }
      const res = await window.api.addTagsToVideos({ videoIds, tagIds })
      if (!res.ok) {
        ui.showToast(res.message || '批量打标签失败', 'error')
        return
      }
      await this.load()
      await useResourceStore().load()
      const names = tagIds
        .map((id) => this.byId.get(id)?.name)
        .filter(Boolean)
        .join('、')
      ui.showToast(`已给 ${videoIds.length} 个视频加上「${names}」`, 'success', 4600)
    },

    /** 某个片段的标签 id */
    clipTagIds(clipId: number): Promise<number[]> {
      return window.api.getClipTags(clipId)
    }
  }
})
