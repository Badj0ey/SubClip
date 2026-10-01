<script setup lang="ts">
import { computed, ref } from 'vue'
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
import TreeNodeItem from './TreeNodeItem.vue'
import TagDialog from './TagDialog.vue'
import ContextMenu from './ContextMenu.vue'
import type { MenuItem } from './ContextMenu.vue'

const kw = ref('')
const favOnly = ref(false)

const keyword = computed(() => kw.value.trim().toLowerCase())
const searching = computed(() => Boolean(keyword.value) || favOnly.value)

function matchSelf(n: TreeNode): boolean {
  if (!keyword.value) return true
  return (
    n.label.toLowerCase().includes(keyword.value) ||
    (n.subtitle ?? '').toLowerCase().includes(keyword.value)
  )
}

function filterTree(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = []
  for (const n of nodes) {
    const kids = n.children ? filterTree(n.children) : []
    const selfMatch = matchSelf(n) && (!favOnly.value || n.favorite)
    if (selfMatch || kids.length) {
      out.push({ ...n, children: kids.length ? kids : selfMatch ? n.children : [] })
    }
  }
  return out
}

const visibleTree = computed(() =>
  searching.value ? filterTree(state.tree) : state.tree
)

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
  <aside class="pane pane-left" role="navigation" aria-label="资源树">
    <div class="pane-head">
      <strong style="font-size: 13px">工作区</strong>
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
        placeholder="搜索视频 / BV号 / 字幕"
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
      <div v-if="!visibleTree.length" class="empty">
        暂无内容<br />
        点击顶部「导入 SRT」或「BV 号拉取字幕」
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
