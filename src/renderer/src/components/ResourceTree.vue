<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TreeNode } from '@shared/types'
import { loadTree, openDoc, state, toast } from '../store'
import TreeNodeItem from './TreeNodeItem.vue'

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
  // 删除不再二次确认：资源重新拉取的成本很低，误删可以直接再抓一次
  state.tree = await window.api.deleteNode(node.key)

  const stillThere = JSON.stringify(state.tree).includes(`"${node.key}"`)
  if (!stillThere && state.activeDocId) {
    // 当前打开的字幕被删（或其父级被删）时清空阅读区
    const docStillThere = JSON.stringify(state.tree).includes(`doc:${state.activeDocId}`)
    if (!docStillThere) {
      state.activeDocId = null
      state.doc = null
      state.docs = []
      state.cues = []
      state.selected = new Set<number>()
    }
  }
  toast('已删除', 'success')
}

/** 重命名（名称由树节点内联编辑产生） */
async function onRename(node: TreeNode, name: string): Promise<void> {
  state.tree = await window.api.renameNode(node.key, name)
  // 当前打开的字幕被改名时同步一下标题
  if (state.doc && node.type === 'doc' && node.key === `doc:${state.doc.id}`) {
    state.doc = { ...state.doc, label: name }
  }
  toast('已重命名', 'success')
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
  <aside class="pane pane-left">
    <div class="pane-head">
      <strong style="font-size: 13px">工作区</strong>
      <span class="grow"></span>
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
      <div v-else class="tree">
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
        />
      </div>
    </div>
  </aside>
</template>
