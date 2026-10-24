<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TreeNode } from '@shared/types'
import {
  deleteTreeNode,
  lastDeletedLabel,
  loadTree,
  openDoc,
  state,
  toast,
  undoDelete
} from '../store'
import { useResourceStore } from '../stores/resource'
import TreeNodeItem from './TreeNodeItem.vue'
import TagDialog from './TagDialog.vue'
import ContextMenu from './ContextMenu.vue'
import type { MenuItem } from './ContextMenu.vue'

const resource = useResourceStore()

/**
 * 搜索关键词与「只看收藏」都放在 `resource` store 里。
 *
 * 原来这两个是组件本地 `ref`，与 store 里的 `treeFilter` / `favoriteOnly`
 * **重复了一份**（审计发现的问题）—— 两份状态意味着「检索页改了筛选、素材库这边不知道」，
 * 而且刷新组件就丢。现在统一以 store 为准。
 */
const kw = computed({
  get: () => resource.treeFilter,
  set: (v: string) => {
    resource.treeFilter = v
  }
})
const favOnly = computed({
  get: () => resource.favoriteOnly,
  set: (v: boolean) => {
    resource.favoriteOnly = v
  }
})

const keyword = computed(() => resource.treeFilter.trim().toLowerCase())
const searching = computed(() => Boolean(keyword.value) || resource.favoriteOnly)

function matchSelf(n: TreeNode): boolean {
  if (!keyword.value) return true
  return (
    n.label.toLowerCase().includes(keyword.value) ||
    (n.subtitle ?? '').toLowerCase().includes(keyword.value)
  )
}

/* --------------------------- 字幕正文匹配（异步） --------------------------- */

/**
 * 命中了关键词的**字幕正文**所在的视频 id（以及字幕文档 id）。
 *
 * 为什么需要它：树上的搜索原来只匹配「标题 / BV 号」，
 * 而用户的真实需求常常是「哪场直播里说过这句话」——只搜标题根本找不到。
 * 全库检索（`searchCues`）本来就有这个能力，这里复用它，让素材库的搜索框
 * 也能搜正文（用户选定的行为）。
 */
const bodyHitVideoIds = ref<Set<number>>(new Set())
const bodyHitDocIds = ref<Set<number>>(new Set())
const bodySearching = ref(false)

let searchTimer: number | null = null

watch(keyword, (k) => {
  if (searchTimer) window.clearTimeout(searchTimer)
  // 字数太少就不查正文：单字命中太多，既慢又等于没过滤
  if (k.length < 2) {
    bodyHitVideoIds.value = new Set()
    bodyHitDocIds.value = new Set()
    return
  }
  // 防抖：每敲一个字都查库会把输入卡住
  searchTimer = window.setTimeout(async () => {
    bodySearching.value = true
    try {
      const page = await window.api.searchLibrary({ keyword: k, limit: 300 })
      const hits = page.hits ?? []
      bodyHitVideoIds.value = new Set(hits.map((h) => h.videoId))
      bodyHitDocIds.value = new Set(hits.map((h) => h.docId))
    } catch {
      /* 检索失败不影响标题过滤 */
    } finally {
      bodySearching.value = false
    }
  }, 260)
})

/** 该节点是否命中**正文** */
function matchesBody(n: TreeNode): boolean {
  if (n.type === 'video') return n.videoId != null && bodyHitVideoIds.value.has(n.videoId)
  if (n.type === 'doc') {
    const id = (n.payload as { id?: number } | undefined)?.id
    return id != null && bodyHitDocIds.value.has(id)
  }
  return false
}

/**
 * 过滤树。
 *
 * ## 命中分级（这是刻意的，不是随手写的「或」）
 *
 * 1. **标题命中优先**：标题是用户给视频起的名字，命中它基本就是「我要找的那个视频」。
 * 2. **标题没命中时才看正文**：正文命中的是「说过这句话的视频」，往往一大片。
 *
 * 如果无脑用「标题命中 ∪ 正文命中」，用户搜「哑巴着急」时，
 * 只要某场直播里有人说过这四个字，那场也会挤进来 —— 精确结果被淹掉，反而更找不到。
 * 所以：**只要有标题命中，就只给标题命中**；一条都没有，才用正文命中兜底。
 *
 * 保留规则：自己命中、或子孙命中（否则命中项会被父级过滤掉而看不见）。
 * `favOnly` 是**与**关系。
 */
function filterTree(nodes: TreeNode[]): TreeNode[] {
  // 第一遍先看有没有标题命中，用来决定这一轮要不要启用正文命中
  const useBody = !hasTitleHit(nodes)

  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const n of list) {
      const kids = n.children ? walk(n.children) : []
      const favOk = !favOnly.value || n.favorite
      const titleHit = matchSelf(n) && favOk
      const bodyHit = useBody && matchesBody(n) && favOk
      const selfMatch = titleHit || bodyHit
      if (selfMatch || kids.length) {
        out.push({ ...n, children: kids.length ? kids : selfMatch ? n.children : [] })
      }
    }
    return out
  }
  return walk(nodes)
}

/** 整棵树里有没有标题命中的节点（只看视觉层级上的自己命中，不看子孙） */
function hasTitleHit(nodes: TreeNode[]): boolean {
  for (const n of nodes) {
    if (matchSelf(n) && (!favOnly.value || n.favorite)) return true
    if (n.children && hasTitleHit(n.children)) return true
  }
  return false
}

const visibleTree = computed(() =>
  searching.value ? filterTree(state.tree) : state.tree
)

/**
 * 本次搜索是不是**标题命中**。
 *
 * 暴露成 computed 是为了让提示文案能正确区分「标题命中」与「正文兜底」——
 * 两者都可能有结果，但含义完全不同（一个是「名字里有这个词」，
 * 一个是「说过这句话」），must 说明清楚。
 */
const titleMatched = computed(() => hasTitleHit(state.tree))

async function onOpen(node: TreeNode): Promise<void> {
  const doc = node.payload as { id: number } | undefined
  if (doc?.id) await openDoc(doc.id, node.key)
}

async function onDelete(node: TreeNode): Promise<void> {
  // 删标签只删标签本身，视频与字幕不受影响，所以不走「可撤销删除」那套快照
  if (node.key.startsWith('tag:')) {
    state.tree = await window.api.deleteTag(Number(node.key.slice(4)))
    toast('已删除标签（视频与字幕未受影响）', 'success')
    return
  }
  // 删除不再二次确认：快照留在 store 里，顶部「撤销删除」可以整棵恢复
  await deleteTreeNode(node.key, node.label)
}

/** 重命名（名称由树节点内联编辑产生） */
async function onRename(node: TreeNode, name: string): Promise<void> {
  if (node.key.startsWith('tag:')) {
    state.tree = await window.api.renameTag(Number(node.key.slice(4)), name)
    toast('已重命名标签', 'success')
    return
  }
  state.tree = await window.api.renameNode(node.key, name)
  // 当前打开的字幕被改名时同步一下标题
  if (state.doc && node.type === 'doc' && node.key === `doc:${state.doc.id}`) {
    state.doc = { ...state.doc, label: name }
  }
  toast('已重命名', 'success')
}

/* --------------------------------- 右键菜单 -------------------------------- */

const menu = ref<{ x: number; y: number; node: TreeNode } | null>(null)

function onMenu(node: TreeNode, event: MouseEvent): void {
  menu.value = { x: event.clientX, y: event.clientY, node }
}

const menuItems = computed<MenuItem[]>(() => {
  const node = menu.value?.node
  if (!node) return []
  const isTag = node.key.startsWith('tag:')
  const isDoc = node.type === 'doc'
  const items: MenuItem[] = [
    {
      label: isDoc ? '打开字幕' : '展开 / 折叠',
      icon: isDoc ? '📄' : '▸',
      action: () => {
        if (isDoc) void onOpen(node)
        else document.querySelector<HTMLElement>(`[data-key="${node.key}"]`)?.click()
      }
    },
    {
      label: node.favorite ? '取消收藏' : '收藏',
      icon: node.favorite ? '★' : '☆',
      action: () => void onFavorite(node)
    },
    {
      label: '重命名',
      icon: '✎',
      action: () => {
        // 让该行进入内联编辑：派发一次 dblclick 比自己操作 DOM 稳
        document
          .querySelector<HTMLElement>(`[data-key="${node.key}"] .label`)
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      }
    }
  ]

  if (node.type === 'video') {
    items.push({ label: '打标签…', icon: '🏷', divider: true, action: () => onTag(node) })
  }

  items.push({
    label: isTag ? '删除标签' : '删除',
    icon: '✕',
    danger: true,
    divider: true,
    action: () => void onDelete(node)
  })
  return items
})


/* --------------------------------- 标签 --------------------------------- */

const tagTarget = ref<{ videoId: number; title: string } | null>(null)

function onTag(node: TreeNode): void {
  if (node.videoId == null) return
  tagTarget.value = { videoId: node.videoId, title: node.label }
}

async function onFavorite(node: TreeNode): Promise<void> {
  state.tree = await window.api.toggleFavorite(node.key)
}

async function refresh(): Promise<void> {
  await loadTree()
  toast('资源树已刷新', 'success')
}
</script>

<template>
  <aside class="pane pane-left" role="navigation" aria-label="素材库">
    <div class="pane-head">
      <strong style="font-size: 13px">素材库</strong>
      <span class="grow"></span>
      <button
        v-if="lastDeletedLabel"
        class="btn sm"
        :title="`恢复「${lastDeletedLabel}」`"
        @click="undoDelete"
      >
        撤销删除
      </button>
      <button class="btn sm" title="刷新" @click="refresh">刷新</button>
    </div>

    <div class="tree-search">
      <input
        v-model="kw"
        class="input grow"
        type="search"
        :placeholder="'搜索标题 / BV号 / 字幕内容'"
      />
      <button
        class="btn sm"
        :class="{ primary: favOnly }"
        title="只看收藏"
        @click="favOnly = !favOnly"
      >
        ★
      </button>
    </div>

    <div class="pane-body">
      <!--
        搜索状态提示：让用户知道这次结果是「标题命中」还是「字幕内容命中」。
        这个区别很重要 —— 正文命中是「说过这句话的视频」，
        与「标题里就有这个词」不是一回事，不说明会让人以为搜索结果怪。
        判断顺序也要对：**先看标题命中**，否则标题命中时会被误报成「标题无命中」。
      -->
      <div v-if="searching" class="tree-hint muted">
        <template v-if="bodySearching">正在搜索字幕内容…</template>
        <template v-else-if="titleMatched">
          标题命中{{ bodyHitVideoIds.size ? `（另有 ${bodyHitVideoIds.size} 个视频在字幕内容里命中）` : '' }}
        </template>
        <template v-else-if="bodyHitVideoIds.size">
          标题无命中，下面是<strong>字幕内容</strong>命中的 {{ bodyHitVideoIds.size }} 个视频
        </template>
        <template v-else-if="keyword && keyword.length < 2"> 输入 2 个字以上可搜索字幕内容 </template>
      </div>
      <div v-if="!visibleTree.length" class="empty">
        <template v-if="searching">
          没有匹配「{{ resource.treeFilter }}」的视频<br />
          <span class="muted">已同时搜索标题与字幕内容</span>
        </template>
        <template v-else>
          暂无内容<br />
          点击顶部「导入 SRT」或「拉取字幕」
        </template>
      </div>
      <div v-else class="tree" role="tree" aria-label="视频资源树">
        <TreeNodeItem
          v-for="node in visibleTree"
          :key="node.key"
          :node="node"
          :depth="0"
          :force-open="searching"
          @open="onOpen"
          @delete="onDelete"
          @favorite="onFavorite"
          @rename="onRename"
          @tag="onTag"
          @menu="onMenu"
        />
      </div>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @close="menu = null"
    />

    <TagDialog
      v-if="tagTarget"
      :video-id="tagTarget.videoId"
      :title="tagTarget.title"
      @close="tagTarget = null"
    />
  </aside>
</template>
