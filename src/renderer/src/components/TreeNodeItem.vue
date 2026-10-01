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
  (e: 'tag', node: TreeNode): void
  (e: 'menu', node: TreeNode, event: MouseEvent): void
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
  doc: '📄',
  tags: '🏷',
  tag: '🏷'
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

function onKeydown(e: KeyboardEvent): void {
  // 只用键盘也能走遍资源树：Enter/Space 打开或展开，左右键收放
  switch (e.key) {
    case 'Enter':
    case ' ':
      e.preventDefault()
      onClick()
      break
    case 'ArrowRight':
      if (hasChildren.value && !isOpen.value) {
        e.preventDefault()
        toggle()
      }
      break
    case 'ArrowLeft':
      if (hasChildren.value && isOpen.value) {
        e.preventDefault()
        toggle()
      }
      break
    case 'F2':
      e.preventDefault()
      void startRename()
      break
    default:
      break
  }
}

</script>

<template>
  <div>
    <div
      class="tnode"
      :class="{ active: isActive }"
      :data-key="node.key"
      role="treeitem"
      :aria-level="depth + 1"
      :aria-expanded="hasChildren ? isOpen : undefined"
      :aria-selected="isActive"
      :aria-label="`${node.label}${node.subtitle ? `，${node.subtitle}` : ''}`"
      tabindex="0"
      :style="{ paddingLeft: `${6 + depth * 13}px` }"
      :title="node.subtitle ? `${node.label}（${node.subtitle}）` : node.label"
      @click="onClick"
      @keydown="onKeydown"
      @contextmenu.prevent="emit('menu', node, $event)"
    >
      <span class="arrow" aria-hidden="true" :class="{ open: isOpen }">{{ hasChildren ? '▶' : '' }}</span>
      <span class="ico" aria-hidden="true">{{ icons[node.type] }}</span>

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

      <span v-if="node.tags && node.tags.length" class="chips">
        <span v-for="t in node.tags" :key="t" class="chip">{{ t }}</span>
      </span>
      <span v-if="node.subtitle && !renaming" class="badge">{{ node.subtitle }}</span>
      <span v-if="!renaming" class="ops">
        <button
          v-if="node.type === 'video'"
          type="button"
          title="打标签"
          :aria-label="`给 ${node.label} 打标签`"
          @click.stop="emit('tag', node)"
        >
          🏷
        </button>
        <button
          type="button"
          :class="{ fav: node.favorite }"
          :title="node.favorite ? '取消收藏' : '收藏'"
          :aria-label="node.favorite ? `取消收藏 ${node.label}` : `收藏 ${node.label}`"
          :aria-pressed="Boolean(node.favorite)"
          @click.stop="emit('favorite', node)"
        >
          {{ node.favorite ? '★' : '☆' }}
        </button>
        <button
          type="button"
          title="重命名"
          :aria-label="`重命名 ${node.label}`"
          @click.stop="startRename"
        >
          ✎
        </button>
        <button
          type="button"
          title="删除"
          :aria-label="`删除 ${node.label}`"
          @click.stop="emit('delete', node)"
        >
          ✕
        </button>
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
        @tag="(n) => emit('tag', n)"
        @menu="(n, ev) => emit('menu', n, ev)"
      />
    </template>
  </div>
</template>

<style scoped>
.ico {
  flex: 0 0 auto;
  font-size: 12px;
}

/* 标签小圆片：让「待剪辑」「重点」这类人工标记在树里一眼可见 */
.chips {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 3px;
  max-width: 130px;
  overflow: hidden;
}

.chip {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 15px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  white-space: nowrap;
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
