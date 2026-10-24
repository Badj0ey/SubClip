<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { filterCommands, type CommandId } from '@shared/commands'
import UiIcon from './UiIcon.vue'

const emit = defineEmits<{ (e: 'close'): void; (e: 'run', id: CommandId): void }>()
const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const results = computed(() => filterCommands(query.value))
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

watch(query, () => { active.value = 0 })
onMounted(() => { void nextTick(() => input.value?.focus()) })
onBeforeUnmount(() => previousFocus?.focus())

function run(id: CommandId): void { emit('run', id) }
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); return }
  if (event.key === 'Tab') { event.preventDefault(); return }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (results.value.length) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + results.value.length) % results.value.length
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const command = results.value[active.value]
    if (command) run(command.id)
  }
}
</script>

<template>
  <div class="command-overlay" @click.self="emit('close')" @keydown="onKey">
    <section class="command-dialog" role="dialog" aria-modal="true" aria-label="快捷操作">
      <div class="command-search">
        <UiIcon name="search" :size="20" />
        <input
          ref="input"
          v-model="query"
          type="search"
          placeholder="搜索页面、操作或设置…"
          aria-label="搜索快捷操作"
          aria-controls="command-results"
          :aria-activedescendant="results.length ? `command-${results[active]?.id}` : undefined"
        />
        <kbd>ESC</kbd>
      </div>
      <div id="command-results" class="command-results" role="listbox" aria-label="匹配的操作">
        <div v-if="!results.length" class="command-empty">没有匹配的操作，换个关键词试试。</div>
        <button
          v-for="(item, index) in results"
          :id="`command-${item.id}`"
          :key="item.id"
          type="button"
          role="option"
          :aria-selected="active === index"
          class="command-result"
          :class="{ active: active === index }"
          @mouseenter="active = index"
          @click="run(item.id)"
        >
          <span class="command-result-icon"><UiIcon :name="item.icon" :size="18" /></span>
          <span class="command-result-copy"><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
          <span class="command-result-group">{{ item.group }}</span>
          <UiIcon name="arrow-right" :size="16" />
        </button>
      </div>
      <footer class="command-footer">
        <span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 执行</span>
        <span class="command-footer-tip">SubClip · 快捷操作</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.command-overlay { position: fixed; inset: 0; z-index: 70; display: flex; justify-content: center; align-items: flex-start; padding: min(17vh, 140px) 16px 16px; background: rgba(13, 23, 43, .48); backdrop-filter: blur(7px); }
.command-dialog { width: min(580px, 100%); max-height: min(650px, 76vh); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 18px; background: var(--panel); box-shadow: 0 32px 90px rgba(8, 19, 42, .26); animation: command-enter .18s ease-out; }
.command-search { display: flex; align-items: center; gap: 12px; padding: 17px 20px; color: var(--text-dim); border-bottom: 1px solid var(--hairline); }
.command-search input { flex: 1; width: 0; min-width: 0; border: 0; outline: 0; color: var(--text); background: transparent; font-size: 16px; }
.command-search input::placeholder { color: var(--text-dim); }
.command-results { padding: 8px; overflow: auto; }
.command-result { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; padding: 9px 12px; text-align: left; border: 0; border-radius: 10px; color: var(--text); background: transparent; cursor: pointer; }
.command-result.active, .command-result:hover { background: var(--accent-soft); }
.command-result-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: var(--accent); background: var(--panel-2); }
.command-result-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.command-result-copy strong { font-size: 13px; font-weight: 650; }
.command-result-copy small { font-size: 12px; color: var(--text-dim); }
.command-result-group { color: var(--text-dim); font-size: 11px; }
.command-result > svg:last-child { color: var(--text-dim); }
.command-empty { padding: 38px 16px; text-align: center; color: var(--text-dim); }
.command-footer { display: flex; gap: 16px; padding: 12px 18px; border-top: 1px solid var(--hairline); color: var(--text-dim); font-size: 11px; }
.command-footer-tip { margin-left: auto; }
kbd { padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel-2); color: var(--text-dim); font-family: inherit; font-size: 10px; }
@keyframes command-enter { from { opacity: 0; transform: translateY(-10px) scale(.99); } }
@media (prefers-reduced-motion: reduce) { .command-dialog { animation: none; } }
</style>
