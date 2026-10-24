<script setup lang="ts">
/**
 * 通用右键菜单。
 *
 * 自己用 HTML 画而不是走主进程的 Menu.popup()：样式能跟主题走，
 * 而且渲染进程内就能测（主进程菜单在 CDP 里驱动不了）。
 */
import { computed, onMounted, onUnmounted } from 'vue'

export interface MenuItem {
  label: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  /** 分隔线（放在该项之前） */
  divider?: boolean
  action: () => void
}

const props = defineProps<{ x: number; y: number; items: MenuItem[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const MENU_WIDTH = 190
const ITEM_HEIGHT = 30

/** 贴近右 / 下边缘时往回缩，避免菜单被裁掉 */
const pos = computed(() => {
  const height = props.items.length * ITEM_HEIGHT + 12
  const x = Math.min(props.x, Math.max(0, window.innerWidth - MENU_WIDTH - 8))
  const y = Math.min(props.y, Math.max(0, window.innerHeight - height - 8))
  return { left: `${x}px`, top: `${y}px` }
})

function run(item: MenuItem): void {
  if (item.disabled) return
  item.action()
  emit('close')
}

function onGlobalClick(): void {
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  // 捕获阶段：先于任何业务点击关闭菜单，避免「菜单项没点到、下面的东西被点了」
  document.addEventListener('click', onGlobalClick, true)
  document.addEventListener('contextmenu', onGlobalClick, true)
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  document.removeEventListener('click', onGlobalClick, true)
  document.removeEventListener('contextmenu', onGlobalClick, true)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="ctx-menu" :style="pos" role="menu" @click.stop @contextmenu.stop.prevent>
    <template v-for="(item, i) in items" :key="i">
      <div v-if="item.divider" class="ctx-divider"></div>
      <button
        class="ctx-item"
        role="menuitem"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        @click="run(item)"
      >
        <span class="ctx-ico">{{ item.icon ?? '' }}</span>
        <span>{{ item.label }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 180px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 26px rgb(0 0 0 / 28%);
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 9px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.ctx-item:hover:not(:disabled) {
  background: var(--row-hover);
}

.ctx-item:disabled {
  opacity: 0.4;
  cursor: default;
}

.ctx-item.danger {
  color: var(--danger);
}

.ctx-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.ctx-ico {
  flex: 0 0 16px;
  text-align: center;
  font-size: 12px;
}

.ctx-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
</style>
