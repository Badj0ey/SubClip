<script setup lang="ts">
/**
 * AI 面板（第六阶段）。
 *
 * 放在右侧「选择结果 / 切片任务」面板里，因为 AI 要用的上下文就是
 * 「当前打开的字幕文档 / 视频」—— 它已经在那儿了。
 *
 * 三条界面约定：
 * 1. **未启用时只提示，不隐藏入口**：用户得先知道有这个能力，才会去设置里开；
 * 2. 结果落库后重开应用直接读（`aiStore.loadCachedSummary`），不重复调模型；
 * 3. **标签建议必须人审核**：AI 只给候选与理由，勾选后才写入库（AI 生成 + 人审核）。
 */
import { computed, ref, watch } from 'vue'
import { useAiStore } from '../stores/ai'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'

const ai = useAiStore()
const subtitle = useSubtitleStore()
const ui = useUiStore()

/** 标签建议里被勾选的项（默认全选，用户取消掉不想要的） */
const picked = ref<Set<string>>(new Set())

const emit = defineEmits<{
  (e: 'summary'): void
  (e: 'tags'): void
  (e: 'apply-tags', names: string[]): void
}>()

const hasDoc = computed(() => Boolean(subtitle.doc))

function togglePick(name: string, checked: boolean): void {
  const next = new Set(picked.value)
  if (checked) next.add(name)
  else next.delete(name)
  picked.value = next
}

/** 新一批建议来了：默认全选「库里还没有的」 */
function syncPicks(): void {
  picked.value = new Set(ai.tagSuggestions.filter((s) => !s.exists).map((s) => s.name))
}

/** 有建议时自动初始化勾选状态（watch 比让父组件记得调用更不容易漏） */
watch(
  () => ai.tagSuggestions,
  (list) => {
    if (list.length) syncPicks()
  },
  { immediate: true }
)

async function copySummary(): Promise<void> {
  await window.api.copyText(ai.summary)
  ui.showToast('已复制摘要', 'success')
}

function apply(): void {
  const names = ai.tagSuggestions.filter((s) => picked.value.has(s.name)).map((s) => s.name)
  if (!names.length) {
    ui.showToast('请至少勾选一个标签', 'error')
    return
  }
  emit('apply-tags', names)
}

const busyText = computed(() => {
  switch (ai.busyKind) {
    case 'summary':
      return '正在生成摘要…'
    case 'tags':
      return '正在分析标签…'
    case 'title':
      return '正在生成标题…'
    case 'explain':
      return '正在解释…'
    default:
      return ''
  }
})
</script>

<template>
  <section class="ai-panel" aria-label="AI 助手">
    <div class="ai-head">
      <strong>AI 助手</strong>
      <span class="grow"></span>
      <span
        class="ai-status"
        :class="{ ok: ai.ready, bad: ai.enabled && !ai.ready }"
        :title="ai.statusText"
      >
        {{ ai.statusText }}
      </span>
    </div>

    <div v-if="!ai.enabled" class="ai-hint ai-setup-hint">
      AI 可以生成字幕摘要、推荐标签和解释单句字幕。不开启也能正常搜索字幕、保存片段和剪辑视频。
      如需使用，请在设置中选择本地 Ollama 或 OpenAI 兼容服务。
      <button class="btn sm" @click="ui.setView('settings')">配置 AI 助手</button>
    </div>

    <template v-else>
      <div v-if="!hasDoc" class="ai-hint">先打开一份字幕，再生成摘要或标签。</div>
      <div v-else-if="!ai.ready" class="ai-hint">AI 服务尚未连接，请到设置中检查连接。</div>
      <div class="ai-actions">
        <button
          class="btn sm"
          :disabled="!hasDoc || Boolean(ai.busyKind) || !ai.ready"
          title="为该视频的全部字幕生成摘要（结果存在本地）"
          @click="emit('summary')"
        >
          摘要
        </button>
        <button
          class="btn sm"
          :disabled="!hasDoc || Boolean(ai.busyKind) || !ai.ready"
          title="让 AI 建议几个分类标签，勾选后再写入"
          @click="emit('tags')"
        >
          标签建议
        </button>
        <span v-if="busyText" class="muted" style="font-size: 12px">{{ busyText }}</span>
      </div>

      <!-- 标签建议：AI 只给候选，必须人审核 -->
      <div v-if="ai.tagSuggestions.length" class="ai-suggest">
        <div class="ai-suggest-head">
          <span>标签建议（勾选后保存）</span>
          <span class="grow"></span>
          <button class="btn sm" :disabled="!picked.size || Boolean(ai.busyKind)" @click="apply">保存 {{ picked.size }} 个</button>
          <button class="btn sm" @click="ai.clearTagSuggestions()">忽略</button>
        </div>
        <label v-for="s in ai.tagSuggestions" :key="s.name" class="ai-tag-row">
          <input
            type="checkbox"
            :checked="picked.has(s.name)"
            @change="togglePick(s.name, ($event.target as HTMLInputElement).checked)"
          />
          <span class="ai-tag-name">{{ s.name }}</span>
          <span v-if="s.exists" class="ai-tag-exists">已有</span>
          <span class="muted" style="font-size: 11px">{{ s.reason }}</span>
        </label>
      </div>

      <!-- 摘要 -->
      <div v-if="ai.summary" class="ai-summary">
        <div class="ai-summary-head">
          <span>摘要</span>
          <span class="muted" style="font-size: 11px">{{ ai.summaryProvider }}</span>
          <span class="grow"></span>
          <button class="btn sm" title="复制摘要" @click="copySummary">复制</button>
        </div>
        <p class="ai-summary-text">{{ ai.summary }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ai-panel {
  border-bottom: 1px solid var(--hairline);
  padding: 8px 10px;
}

.ai-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  margin-bottom: 6px;
}

.ai-status {
  font-size: 11px;
  color: var(--text-dim);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-status.ok {
  color: var(--success, #10b981);
}

.ai-status.bad {
  color: var(--danger);
}

.ai-hint {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.6;
}

.ai-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.ai-suggest {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  padding: var(--sp-2) var(--sp-3);
  margin-bottom: 6px;
}

.ai-suggest-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 4px;
}

.ai-tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}

.ai-tag-name {
  font-weight: 550;
}

.ai-tag-exists {
  font-size: 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0 3px;
  color: var(--text-dim);
}

.ai-summary {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  padding: var(--sp-2) var(--sp-3);
}

.ai-summary-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 4px;
}

.ai-summary-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  max-height: 180px;
  overflow: auto;
}
</style>
