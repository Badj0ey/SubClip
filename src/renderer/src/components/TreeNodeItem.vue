<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { TreeNode } from '@shared/types'
import { state } from '../store'

defineOptions({ name: 'TreeNodeItem' })

const props = withDefaults(defineProps<{ node: TreeNode; depth: number; forceOpen?: boolean }>(), {
  forceOpen: false
})
const emit = defineEmits<{
  (e: 'open', node: TreeNode): void
  (e: 'delete', node: TreeNode): void
  (e: 'favorite', node: TreeNode): void
  (e: 'rename', node: TreeNode, name: string): void
}>()

/* ------------------------------- 内联重命名 ------------------------------- */

const renaming = ref(false)
const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

function startRename(): void {
  renaming.value = true
  draft.value = props.node.label
  void nextTick(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}

let cancelled = false

function commitRename(): void {
  if (cancelled) {
    cancelled = false
    return
  }
  if (!renaming.value) return
  renaming.value = false
  const name = draft.value.trim()
  if (name && name !== props.node.label) emit('rename', props.node, name)
}

function cancelRename(): void {
  cancelled = true
  renaming.value = false
}

const icons: Record<TreeNode['type'], string> = {
  uploader: '👤',
  collection: '📁',
  video: '🎬',
  doc: '📄'
}

const isOpen = computed(() => props.forceOpen || state.expanded.has(props.node.key))
const hasChildren = computed(() => Boolean(props.node.children?.length))
const isActive = computed(() => state.activeKey === props.node.key)

function toggle(): void {
  if (!hasChildren.value) return
  if (state.expanded.has(props.node.key)) state.expanded.delete(props.node.key)
  else state.expanded.add(props.node.key)
}

function onClick(): void {
  if (props.node.type === 'doc') emit('open', props.node)
  else toggle()
}
</script>

<template>
  <div>
    <div
      class="tnode"
      :class="{ active: isActive }"
      :style="{ paddingLeft: `${6 + depth * 13}px` }"
      :title="node.subtitle ? `${node.label}（${node.subtitle}）` : node.label"
      @click="onClick"
    >
      <span class="arrow" :class="{ open: isOpen }">{{ hasChildren ? '▶' : '' }}</span>
      <span class="ico">{{ icons[node.type] }}</span>

      <input
        v-if="renaming"
        ref="inputEl"
        v-model="draft"
        class="tnode-input"
        spellcheck="false"
        @click.stop
        @dblclick.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="label" :title="node.label">{{ node.label }}</span>

      <span v-if="node.subtitle && !renaming" class="badge">{{ node.subtitle }}</span>
      <span v-if="!renaming" class="ops">
        <button
          :class="{ fav: node.favorite }"
          :title="node.favorite ? '取消收藏' : '收藏'"
          @click.stop="emit('favorite', node)"
        >
          {{ node.favorite ? '★' : '☆' }}
        </button>
        <button title="重命名" @click.stop="startRename">✎</button>
        <button title="删除" @click.stop="emit('delete', node)">✕</button>
      </span>
    </div>

    <template v-if="isOpen && node.children && node.children.length">
      <TreeNodeItem
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :depth="depth + 1"
        :force-open="forceOpen"
        @open="(n) => emit('open', n)"
        @delete="(n) => emit('delete', n)"
        @favorite="(n) => emit('favorite', n)"
        @rename="(n, name) => emit('rename', n, name)"
      />
    </template>
  </div>
</template>

<style scoped>
.ico {
  flex: 0 0 auto;
  font-size: 12px;
}

.tnode-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 1px 5px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text);
  font-family: inherit;
  font-size: inherit;
  outline: none;
  user-select: text;
}
</style>
