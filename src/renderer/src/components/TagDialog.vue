<script setup lang="ts">
/**
 * 给一个视频打标签（需求文档 §6 资源管理里的「分类」）。
 *
 * 做成标签而不是「手动分组」，是因为自动层级（UP主 → 合集 → 视频）已经表达了归属；
 * 标签是正交的另一维，同一个视频可以同时是「待剪辑」和「重点」。
 */
import { computed, onMounted, ref } from 'vue'
import { state, toast } from '../store'
import { useEscapeToClose } from '../composables/useEscapeToClose'

const props = defineProps<{ videoId: number; title: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const all = ref<Array<{ id: number; name: string; count: number }>>([])
const checked = ref<Set<number>>(new Set())
const draft = ref('')
const busy = ref(false)

useEscapeToClose(() => emit('close'), () => !busy.value)

const checkedCount = computed(() => checked.value.size)

onMounted(async () => {
  all.value = await window.api.listTags()
  checked.value = new Set(await window.api.getVideoTags(props.videoId))
})

function toggle(id: number): void {
  const next = new Set(checked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checked.value = next
}

/** 回车即新建标签并勾上 */
async function addTag(): Promise<void> {
  const name = draft.value.trim()
  if (!name) return
  busy.value = true
  try {
    const res = await window.api.createTag(name)
    all.value = await window.api.listTags()
    checked.value = new Set([...checked.value, res.id])
    draft.value = ''
  } catch (err) {
    toast(`新建标签失败：${(err as Error).message}`, 'error', 4200)
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  busy.value = true
  try {
    state.tree = await window.api.setVideoTags(props.videoId, [...checked.value])
    toast(`已更新标签（${checkedCount.value} 个）`, 'success')
    emit('close')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="modal" style="width: 460px">
      <h3>标签</h3>
      <div class="hint" style="margin-left: 0">{{ title }}</div>

      <div class="tag-list">
        <div v-if="!all.length" class="muted" style="padding: 8px 0">
          还没有标签。在下面输入一个名字回车即可新建。
        </div>
        <label v-for="t in all" :key="t.id" class="tag-row">
          <input type="checkbox" :checked="checked.has(t.id)" @change="toggle(t.id)" />
          <span class="tag-name">{{ t.name }}</span>
          <span class="muted">{{ t.count }} 个视频</span>
        </label>
      </div>

      <div class="row" style="margin-top: 8px">
        <input
          v-model="draft"
          class="input grow"
          placeholder="新建标签，回车确认"
          spellcheck="false"
          @keydown.enter.prevent="addTag"
        />
        <button class="btn" :disabled="busy || !draft.trim()" @click="addTag">新建</button>
      </div>

      <div class="hint" style="margin-left: 0">
        标签只影响分类方式，不会改动视频与字幕内容。资源树顶部会出现「标签」分组。
      </div>

      <div class="actions">
        <span class="muted" style="margin-right: auto; font-size: 12px">
          已选 {{ checkedCount }} 个
        </span>
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="busy" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tag-list {
  max-height: 240px;
  overflow: auto;
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.tag-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  /* 全局 .field label 是「左标签右控件」的样式，这里要覆盖回普通行 */
  width: auto;
  font-weight: normal;
  color: var(--text);
}

.tag-row:hover {
  background: var(--hover);
}

.tag-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
