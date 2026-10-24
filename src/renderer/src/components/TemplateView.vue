<script setup lang="ts">
/**
 * 剪辑文案模板（第八阶段）。
 *
 * ## 它解决什么问题
 *
 * 切片做完了，发布前还得写标题、简介、话题标签 —— 这一步每次都要重写一遍，
 * 而且很容易漏（比如忘了带 BV 号或时长）。模板把「固定的骨架」沉淀下来，
 * 每次只填真正每次不同的那一两个槽位。
 *
 * ## 与「片段命名模板」（第五阶段）的区别
 *
 * 那个渲染的是**单行文件名**（切片产物的名字），换行会被压掉；
 * 这个渲染的是**多行发布文案**，换行就是它的结构。两者语法一致（都用 `{token}`）。
 *
 * ## 渲染放在渲染进程
 *
 * `renderCopyTemplate` 是纯函数（`@shared/copyTemplate`），
 * 这里直接算预览 —— 不必为了每次输入都走一趟 IPC。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { CopyTemplate, CopyContext } from '@shared/copyTemplate'
import {
  BUILTIN_TEMPLATES,
  extractTokens,
  isListToken,
  renderCopyTemplate,
  splitForPublish,
  tokenLabel
} from '@shared/copyTemplate'
import { useSubtitleStore } from '../stores/subtitle'
import { useClipStore } from '../stores/clip'
import { useUiStore } from '../stores/ui'
import { usePublishStore } from '../stores/publish'
import { formatTime } from '@shared/time'

const ui = useUiStore()
const subtitle = useSubtitleStore()
const clip = useClipStore()
/** 发布草稿：渲染结果可一键带进「发布素材包」页签 */
const publish = usePublishStore()

/**
 * 通知父组件「已带入」。
 *
 * 由父组件（ClipsView）决定要不要顺手切到素材包页签 ——
 * 组件自己不该知道页签结构，那是父组件的职责。
 */
const emit = defineEmits<{ carried: [] }>()

interface TemplateItem extends CopyTemplate {
  builtin: boolean
}

const templates = ref<TemplateItem[]>([])
const activeId = ref('')
const active = computed(() => templates.value.find((t) => t.id === activeId.value) ?? null)

/** 用户填的槽位值 */
const values = ref<Record<string, string>>({})
/** 标题类占位符用单行，简介/分镜用多行 —— 见 `isListToken` */
const tokens = computed(() => (active.value ? extractTokens(active.value.body) : []))

/** 编辑模板本身（改名字/正文），与「填槽位」是两件事 */
const editing = ref(false)
const draft = ref({ name: '', description: '', body: '' })

async function load(): Promise<void> {
  templates.value = await window.api.templateList()
  if (!templates.value.length) {
    // 理论上首次运行已灌入内置模板；万一被删光了，用内置的兜底提示用户
    templates.value = BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true }))
  }
  if (!activeId.value || !templates.value.some((t) => t.id === activeId.value)) {
    activeId.value = templates.value[0]?.id ?? ''
  }
}

/**
 * 自动值：从「当前打开的视频」能**确实知道**的东西。
 *
 * ⚠️ 这里不做隐式兜底。第一版是「输入框为空时预览自动用当前视频的值」，
 * 结果是**预览里显示着标题、输入框却空着** —— 用户看到两个不一致的东西，
 * 也没法判断这个值能不能改。现在改成显式：自动值只用于**填充输入框**，
 * 预览只反映输入框里的内容，做到「所见即所填」。
 */
const autoValues = computed<Record<string, string>>(() => {
  const video = subtitle.video
  if (!video) return {}
  const out: Record<string, string> = {
    title: video.title ?? '',
    uploader: video.uploaderName ?? '',
    bvid: video.bvid ?? ''
  }
  // 时长：优先用视频自带的；没有就从字幕最后一条推算（有的来源不记录时长）
  const last = subtitle.cues.length ? subtitle.cues[subtitle.cues.length - 1].end : 0
  const duration = video.duration || last
  if (duration) out.duration = formatTime(duration)
  out.clipCount = String(clip.clips.length)
  return out
})

const context = computed<CopyContext>(() => {
  const ctx: CopyContext = {}
  for (const token of tokens.value) {
    ctx[token] = values.value[token] ?? ''
  }
  // 列表类：把用户输入按行拆开
  if (tokens.value.includes('outline') && typeof ctx.outline === 'string') {
    ctx.outline = String(ctx.outline)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return ctx
})

const preview = computed(() =>
  active.value ? renderCopyTemplate(active.value.body, context.value) : ''
)

/** 用当前视频的信息一键填充（省掉手打标题/BV 号/时长） */
function fillFromVideo(): void {
  if (!subtitle.video) {
    ui.showToast('请先在「工作区」打开一个字幕文档', 'error')
    return
  }
  const auto = autoValues.value
  let filled = 0
  for (const token of tokens.value) {
    const value = auto[token]
    if (value && values.value[token] !== value) {
      values.value[token] = value
      filled++
    }
  }
  ui.showToast(
    filled ? `已填入 ${filled} 项（可继续手改）` : '能自动填的项都已是当前值',
    'success'
  )
}

/** 打开模板/切换视频时静默填一次能填的；填不到的留空交给用户 */
function autoFillQuietly(): void {
  const auto = autoValues.value
  for (const token of tokens.value) {
    if (!values.value[token] && auto[token]) values.value[token] = auto[token]
  }
}

async function copy(): Promise<void> {
  const text = preview.value
  if (!text) {
    ui.showToast('没有可复制的内容', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    ui.showToast('已复制到剪贴板', 'success')
  } catch (err) {
    ui.showToast(`复制失败：${(err as Error).message}`, 'error')
  }
}

/**
 * 把渲染结果带进「发布素材包」页签。
 *
 * 切分规则在 `splitForPublish`（纯函数、可单测）里 —— 它决定带过去的内容对不对，
 * 不该只藏在组件里。切完仍然让用户看到结果并可改，不静默决定。
 */
function carryToKit(): void {
  const fields = splitForPublish(preview.value)
  if (!fields.title && !fields.description && !fields.tagText) {
    ui.showToast('没有可带走的内容', 'error')
    return
  }
  publish.applyFromTemplate(fields.title, fields.description, fields.tagText)
  emit('carried')
  ui.showToast(
    fields.title
      ? `已带到「发布素材包」：标题「${fields.title.slice(0, 12)}」+ 正文`
      : '已带到「发布素材包」（未识别出标题，整段作为正文）',
    'success',
    4600
  )
}

function startEdit(): void {
  if (!active.value) return
  draft.value = {
    name: active.value.name,
    description: active.value.description,
    body: active.value.body
  }
  editing.value = true
}

async function saveEdit(): Promise<void> {
  if (!active.value) return
  const res = await window.api.templateSave({
    id: active.value.id,
    name: draft.value.name,
    description: draft.value.description,
    body: draft.value.body
  })
  if (!res.ok) {
    ui.showToast(res.message || '保存失败', 'error')
    return
  }
  editing.value = false
  await load()
  ui.showToast('模板已保存', 'success')
}

async function createTemplate(): Promise<void> {
  const name = window.prompt('新模板名称', '我的模板')
  if (!name) return
  const id = `custom-${Date.now()}`
  const res = await window.api.templateSave({
    id,
    name,
    description: '',
    body: '标题：{title}\n\n简介：{summary}\n\n{#tag}'
  })
  if (!res.ok) {
    ui.showToast(res.message || '新建失败', 'error')
    return
  }
  await load()
  activeId.value = id
  ui.showToast('已新建模板，可在右侧编辑正文', 'success')
}

async function removeActive(): Promise<void> {
  if (!active.value) return
  if (!window.confirm(`删除模板「${active.value.name}」？`)) return
  await window.api.templateDelete(active.value.id)
  await load()
  ui.showToast('已删除', 'success')
}

onMounted(async () => {
  await load()
  autoFillQuietly()
})

/** 换模板、或用当前视频填充之前：清掉旧槽位（占位符不同，留着只会误导）再重填 */
watch([activeId, templates], () => {
  values.value = {}
  editing.value = false
  autoFillQuietly()
})

/** 换了视频：把还没被手动改过的自动项更新掉（用户改过的保留） */
watch(
  () => subtitle.video?.id,
  () => {
    const auto = autoValues.value
    for (const token of tokens.value) {
      if (auto[token] && !values.value[token]) values.value[token] = auto[token]
    }
  }
)

</script>

<template>
  <section class="tpl" aria-label="剪辑文案模板">
    <header class="tpl-bar">
      <div class="tpl-list">
        <button
          v-for="t in templates"
          :key="t.id"
          type="button"
          class="btn sm"
          :class="{ primary: activeId === t.id }"
          :title="t.description"
          @click="activeId = t.id"
        >
          {{ t.name }}<span v-if="t.builtin" class="tpl-badge">内置</span>
        </button>
        <button class="btn sm" type="button" @click="createTemplate">+ 新建</button>
      </div>
    </header>

    <p v-if="active?.description" class="muted tpl-desc">{{ active.description }}</p>

    <div class="tpl-body">
      <!-- 左：填槽位 -->
      <div class="tpl-col">
        <div class="tpl-col-head">
          <span>填写内容</span>
          <span class="grow"></span>
          <button class="btn sm" type="button" @click="fillFromVideo">用当前视频填充</button>
        </div>
        <div class="tpl-fields">
          <label v-for="token in tokens" :key="token" class="tpl-field">
            <span class="tpl-label">
              {{ tokenLabel(token) }}
              <code class="tpl-token">{{ '{' + token + '}' }}</code>
            </span>
            <textarea
              v-if="isListToken(token)"
              v-model="values[token]"
              class="input tpl-input"
              rows="4"
              :placeholder="`每行一条（${token}）`"
            ></textarea>
            <input
              v-else
              v-model="values[token]"
              class="input"
              type="text"
              :placeholder="tokenLabel(token)"
            />
          </label>
          <p v-if="!tokens.length" class="muted">这个模板没有占位符，可直接复制。</p>
          <p class="muted tpl-tip">
            标题、UP主、BV 号、时长为空时会自动用<strong>当前打开的视频</strong>；其余留给手填。
          </p>
        </div>
      </div>

      <!-- 中：预览 -->
      <div class="tpl-col">
        <div class="tpl-col-head">
          <span>预览</span>
          <span class="grow"></span>
          <button class="btn sm" type="button" @click="carryToKit" title="把标题/正文/标签带进「发布素材包」页签">
            带到素材包
          </button>
          <button class="btn sm primary" type="button" @click="copy">复制</button>
        </div>
        <pre class="tpl-preview">{{ preview }}</pre>
      </div>

      <!-- 右：编辑模板 -->
      <div class="tpl-col">
        <div class="tpl-col-head">
          <span>模板正文</span>
          <span class="grow"></span>
          <button v-if="!editing" class="btn sm" type="button" @click="startEdit">编辑</button>
          <template v-else>
            <button class="btn sm" type="button" @click="editing = false">取消</button>
            <button class="btn sm primary" type="button" @click="saveEdit">保存</button>
          </template>
          <button class="btn sm" type="button" @click="removeActive">删除</button>
        </div>
        <div class="tpl-fields">
          <template v-if="editing">
            <label class="tpl-field">
              <span class="tpl-label">模板名</span>
              <input v-model="draft.name" class="input" type="text" />
            </label>
            <label class="tpl-field">
              <span class="tpl-label">说明</span>
              <input v-model="draft.description" class="input" type="text" />
            </label>
            <label class="tpl-field">
              <span class="tpl-label">正文</span>
              <textarea v-model="draft.body" class="input tpl-input mono" rows="14"></textarea>
            </label>
          </template>
          <pre v-else class="tpl-source mono">{{ active?.body }}</pre>
          <p class="muted tpl-tip">
            占位符：<code>{token}</code> 普通替换；<code>{@list:token}</code> 逐行展开；
            <code>{#tag}</code> 拼成 #话题。未知占位符<strong>原样保留</strong>，方便看出拼错。
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tpl {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 4px 2px;
  overflow: hidden;
}

.tpl-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tpl-list {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tpl-badge {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.7;
}

.tpl-desc {
  margin: 0;
  font-size: 12px;
}

.tpl-body {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.2fr) minmax(240px, 1fr);
  gap: 10px;
  min-height: 0;
  flex: 1;
}

.tpl-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  overflow: hidden;
}

.tpl-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12px;
  min-height: 34px;
}

.tpl-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}

.tpl-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tpl-label {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tpl-token {
  font-size: 11px;
  opacity: 0.6;
}

.tpl-input {
  resize: vertical;
  font-family: inherit;
}

.tpl-preview,
.tpl-source {
  margin: 0;
  padding: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
}

.tpl-source {
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, Consolas, monospace;
}

.tpl-tip {
  font-size: 11px;
  line-height: 1.7;
  margin: 0;
}
</style>
