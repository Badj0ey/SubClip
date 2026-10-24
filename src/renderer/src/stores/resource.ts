/**
 * 资源库 store（第一阶段-1）。
 *
 * 职责：资源树（UP主 → 合集 → 视频 → 字幕）、树的筛选 / 展开状态、
 * 以及「可整棵撤销的删除」。
 *
 * 拆出来的原因：这块状态原先和字幕正文、切片任务混在一个 1100 行的文件里，
 * 改树的逻辑要通读整份文件才敢动手。现在树的增删改只在这里。
 *
 * 边界：**字幕正文与当前打开的文档不在这个 store**，在 `subtitle` store；
 * 这里只负责「库里有什么」，不负责「正在看什么」。
 */
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { TreeNode } from '@shared/types'
import { useUiStore } from './ui'
import { useSubtitleStore } from './subtitle'

/** 从根到某个节点的整条路径 */
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

export const useResourceStore = defineStore('resource', {
  state: () => ({
    /** 完整资源树（未筛选） */
    tree: [] as TreeNode[],
    /** 展开的节点 key 集合 */
    expanded: new Set<string>(),
    /** 侧栏筛选关键词（树内搜索） */
    treeFilter: '',
    /** 只看收藏 */
    favoriteOnly: false,
    /** 当前在树上高亮的节点 key（阅读区滚动时也会更新它） */
    activeKey: '',

    /**
     * 最近一次删除的快照（主进程导出的整棵子树）。
     *
     * ⚠️ 必须 `markRaw`：快照是普通对象，Pinia（Vue reactive）会把它包成 Proxy，
     * 而 Proxy 无法通过 IPC 的结构化克隆（会静默失败或抛错），撤销就写不回去了。
     * 原来的 store.ts 里是用「放在响应式状态之外的模块级变量」达到同样效果。
     */
    lastDeleted: null as unknown,
    /** 供界面显示「撤销删除」按钮 */
    lastDeletedLabel: ''
  }),

  actions: {
    /**
     * 刷新资源树。已展开的分支会保留（不会因为刷新而收起），
     * 可选地展开到指定节点。
     */
    async load(expandKey?: string): Promise<void> {
      this.tree = await window.api.listTree()
      /**
       * 首次加载：默认把**有分P 的视频**也展开。
       *
       * 为什么：用户现在只有展开到视频那一层才看得到 P1/P2/P3，
       * 而「这个视频有哪些分P」正是决定「要不要点进去」的关键信息 ——
       * 折叠着等于每次都要多点一下。
       *
       * 只展开到 `video` 这一层，**不往下展开 doc**（字幕轨）：
       * 一个视频可能有多个分P、每P 有多语言字幕轨，全展开会把树撑得很长，
       * 反而看不出层级。文档层留给用户自己点。
       */
      if (this.expanded.size === 0) {
        for (const n of this.tree) {
          this.expanded.add(n.key)
          if (n.type === 'uploader' || n.type === 'collection') {
            for (const child of n.children ?? []) {
              if (child.type === 'video') this.expanded.add(child.key)
            }
          }
        }
      }
      if (expandKey) this.expandTo(expandKey)
    },

    /** 展开到指定节点（只追加，不收起已经展开的分支） */
    expandTo(key: string): void {
      const path = findPath(this.tree, key)
      if (path) for (const k of path) this.expanded.add(k)
    },

    toggleExpanded(key: string): void {
      if (this.expanded.has(key)) this.expanded.delete(key)
      else this.expanded.add(key)
    },

    setFilter(keyword: string): void {
      this.treeFilter = keyword
    },

    toggleFavoriteOnly(): void {
      this.favoriteOnly = !this.favoriteOnly
    },

    /**
     * 删除节点，并留一份快照以便整棵恢复。
     *
     * 删除不做二次确认：快照留在 store 里，顶部「撤销删除」可以整块回来
     * （含正文、标签与切片任务）。
     */
    async deleteNode(key: string, label: string): Promise<void> {
      const res = await window.api.deleteNode(key)
      this.tree = res.tree
      // 快照是主进程导出的普通对象，类型上只保证「不是基本类型」
      this.lastDeleted = res.snapshot == null ? null : markRaw(res.snapshot as object)
      this.lastDeletedLabel = label

      // 当前打开的字幕被删掉时清空阅读区
      const openedId = useSubtitleStore().activeDocId
      const stillThere = JSON.stringify(this.tree).includes(`"doc:${openedId}"`)
      if (openedId != null && !stillThere) {
        useSubtitleStore().clear()
      }
    },

    /** 撤销最近一次删除（按原 id 写回整棵子树） */
    async undoDelete(): Promise<void> {
      const ui = useUiStore()
      if (!this.lastDeleted) {
        ui.showToast('没有可恢复的删除', 'info')
        return
      }
      const label = this.lastDeletedLabel
      this.tree = await window.api.restoreNode(this.lastDeleted)
      this.lastDeleted = null
      this.lastDeletedLabel = ''
      ui.showToast(`已恢复「${label}」`, 'success')
    }
  }
})
