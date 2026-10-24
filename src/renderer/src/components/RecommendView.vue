<script setup lang="ts">
/**
 * 素材推荐（第八阶段）。
 *
 * ## 这里和「语义检索」的区别
 *
 * 语义检索是**你带着问题去找**（输入一句话，列出最像的段落）；
 * 这里是**工具主动告诉你有什么值得用**，三种问法：
 * - `twins`：我正看到这一段 —— 别的视频里谁讲过同一件事？（攒合集用）
 * - `highlight`：这个视频里哪几段**主题最鲜明**？（挑高光用）
 * - `typical`：哪几段最像这个视频的**缩影**？（做预告 / 选封面片段用）
 *
 * ## 为什么把「挑不到」当正常结果展示
 *
 * 实测：闲聊型直播里段落与整体语义的相似度中位数高达 0.53，最低的那些是
 * 「蜘蛛侠啊 什么蜘蛛侠」这类彼此无关的短句 —— 也就是说这类内容**本来就没有**
 * 「主题鲜明的段落」。这时如实显示原因（引擎给的 `message`）比硬凑几条有用得多。
 *
 * 推荐全部用**本地向量**算，不需要外部模型、不需要配 AI，也不联网。
 */
import { computed, ref, watch } from 'vue'
import type { Recommendation, RecommendationResult, RecommendKind } from '@shared/types'
import { formatTime } from '@shared/time'
import { useSubtitleStore } from '../stores/subtitle'
import { useUiStore } from '../stores/ui'

const subtitle = useSubtitleStore()
const ui = useUiStore()

const kind = ref<RecommendKind>('twins')
const loading = ref(false)
const result = ref<RecommendationResult | null>(null)
/** 用户可调条数（推荐是「扫一眼」的场景，给太多反而没人看） */
const limit = ref(10)

/**
 * 三种问法。
 *
 * `hint` 用 `[强]...[/强]` 自定义标记而不是 markdown 的 `**` ——
 * 模板里 `**` 会被当字面文本渲染出来（Vue 不解析 markdown），
 * 第一版就是这么漏的。
 */
const KINDS: Array<{ value: RecommendKind; label: string; hint: string }> = [
  {
    value: 'twins',
    label: '跨视频同主题',
    hint: '以当前光标所在段落为参照，找出[强]别的视频[/强]里讲同一件事的段落 —— 攒合集用'
  },
  {
    value: 'highlight',
    label: '本片高光段落',
    hint: '当前视频里[强]主题最鲜明[/强]（和整场泛泛而谈明显不同）的段落 —— 挑高光用'
  },
  {
    value: 'typical',
    label: '本片代表段落',
    hint: '当前视频里[强]最贴近整体基调[/强]的段落 —— 做预告 / 选封面片段用'
  }
]

/** 把 `[强]…[/强]` 转成 HTML（只处理这一种标记，其余一律转义，避免注入） */
function hintHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/\[强\](.*?)\[\/强\]/g, '<strong>$1</strong>')
}

const currentHint = computed(() => KINDS.find((k) => k.value === kind.value)?.hint ?? '')
const hasDoc = computed(() => Boolean(subtitle.doc && subtitle.video))

/** 当前光标覆盖的那条字幕（作为 twins 的参照） */
const cursorCue = computed(() => subtitle.cues.find((c) => c.index === subtitle.cursor) ?? null)

/** 参照位置的说明文案（让用户知道「以哪一段为参照」） */
const referenceText = computed(() => {
  if (kind.value !== 'twins') return subtitle.video?.title ?? ''
  const cue = cursorCue.value
  if (!cue) return '（未定位到字幕）'
  return `${formatTime(cue.start)} · ${cue.text.slice(0, 40)}`
})

async function run(): Promise<void> {
  if (!hasDoc.value) {
    ui.showToast('请先打开一个字幕文档', 'error')
    return
  }
  loading.value = true
  result.value = null
  try {
    if (kind.value === 'twins') {
      const cue = cursorCue.value
      if (!cue || !subtitle.doc) {
        ui.showToast('请先把光标停在一条字幕上', 'error')
        return
      }
      result.value = await window.api.recommendTwins({
        docId: subtitle.doc.id,
        second: cue.start,
        limit: limit.value
      })
    } else {
      if (!subtitle.video) return
      const payload = { videoId: subtitle.video.id, limit: limit.value }
      result.value =
        kind.value === 'highlight'
          ? await window.api.recommendHighlights(payload)
          : await window.api.recommendTypical(payload)
    }
  } catch (err) {
    ui.showToast(`推荐失败：${(err as Error).message}`, 'error')
  } finally {
    loading.value = false
  }
}

/** 打开结果所在的原片，并把它对应的时间范围选中（复用既有的「勾选 → 切片」流程） */
async function openAndSelect(item: Recommendation): Promise<void> {
  ui.setView('library')
  await subtitle.open(item.docId, undefined)
  const count = subtitle.selectRange(item.start, item.end, true)
  if (count) {
    subtitle.scrollToCursor()
    subtitle.followCueAt(subtitle.cursor)
    ui.showToast(`已定位并选中 ${count} 条字幕，可直接加入切片任务`, 'success')
  } else {
    ui.showToast('已跳到该片段，但没有找到对应的字幕行', 'error')
  }
}

/** 换视频 / 换文档后旧结果就没意义了，清掉避免误导 */
watch(
  () => subtitle.doc?.id,
  () => {
    result.value = null
  }
)

/**
 * 换推荐类型时也要清掉旧结果。
 *
 * 不清的后果是：从「跨视频同主题」切到「本片高光段落」，界面还挂着上一种的提示
 * （实测就会看到「找不到参照片段」出现在高光页签下面），用户会以为新类型也失败了。
 */
watch(kind, () => {
  result.value = null
})
</script>

<template>
  <section class="recommend" aria-label="素材推荐">
    <header class="rec-bar">
      <div class="rec-kinds" role="tablist">
        <button
          v-for="k in KINDS"
          :key="k.value"
          type="button"
          class="btn sm"
          :class="{ primary: kind === k.value }"
          role="tab"
          :aria-selected="kind === k.value"
          @click="kind = k.value"
        >
          {{ k.label }}
        </button>
      </div>
      <span class="grow"></span>
      <label class="muted rec-limit">
        条数
        <select v-model.number="limit" class="input sm" aria-label="推荐条数">
          <option :value="5">5</option>
          <option :value="10">10</option>
          <option :value="20">20</option>
        </select>
      </label>
      <button class="btn primary" :disabled="loading || !hasDoc" @click="run">
        {{ loading ? '计算中…' : '生成推荐' }}
      </button>
    </header>

    <p class="rec-hint">
      <strong>{{ KINDS.find((k) => k.value === kind)?.label }}</strong>：<span
        v-html="hintHtml(currentHint)"
      ></span>
    </p>

    <p v-if="!hasDoc" class="muted rec-empty">请先在工作区打开字幕文件，然后再生成推荐。</p>
    <template v-else>
      <p class="muted rec-ref">
        <span v-if="kind === 'twins'">参照段落：</span>
        <span v-else>参照视频：</span>{{ referenceText }}
        <span class="rec-badge">本地向量 · 不联网</span>
      </p>

      <div v-if="loading" class="muted rec-empty">正在用本地向量计算…</div>

      <!-- 挑不到时要给出**原因**，而不是一个空列表（闲聊型内容经常这样） -->
      <div v-else-if="result && !result.items.length" class="rec-note">
        <p>{{ result.message || '没有找到合适的推荐。' }}</p>
        <p class="muted">
          提示：推荐基于语义相似度，闲聊型内容里「高相似」的往往是套话，
          所以宁可不给也不拿它们凑数。可以换成「本片代表段落」，或直接用关键词 / 语义检索。
        </p>
      </div>

      <ul v-else-if="result" class="rec-list">
        <li v-for="(item, i) in result.items" :key="`${item.docId}-${item.start}-${i}`" class="rec-item">
          <div class="rec-item-head">
            <span class="rec-rank">{{ i + 1 }}</span>
            <span class="rec-score" :title="`相似度/鲜明度 ${item.score}`">
              {{ (item.score * 100).toFixed(1) }}%
            </span>
            <span class="rec-video" :title="item.videoTitle">{{ item.videoTitle }}</span>
            <span class="rec-time">{{ formatTime(item.start) }} → {{ formatTime(item.end) }}</span>
            <span class="grow"></span>
            <button class="btn sm" type="button" @click="openAndSelect(item)">打开并选中</button>
          </div>
          <p class="rec-text">{{ item.text }}</p>
          <p class="muted rec-reason">
            {{ item.reason }}
            <span v-if="item.uploaderName"> · {{ item.uploaderName }}</span>
            <span v-if="item.page > 1"> · P{{ item.page }}</span>
          </p>
        </li>
      </ul>

      <p v-if="result?.partial" class="muted rec-partial">
        语义索引还在建（{{ result.indexedChunks }} / {{ result.totalChunks }} 段），
        结果可能不全；建完后再生成一次会更完整。
      </p>
    </template>
  </section>
</template>

<style scoped>
.recommend {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px;
  min-height: 0;
  overflow: auto;
}

.rec-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.rec-kinds {
  display: flex;
  gap: 4px;
}

.rec-limit {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.rec-hint,
.rec-ref,
.rec-partial,
.rec-reason {
  font-size: 12px;
  line-height: 1.6;
}

.rec-badge {
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
}

.rec-empty {
  padding: 18px 4px;
}

.rec-note {
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.rec-note p {
  margin: 0 0 6px;
}

.rec-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rec-item {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  padding: var(--sp-3);
}

.rec-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.rec-rank {
  width: 18px;
  color: var(--text-dim);
  text-align: right;
}

.rec-score {
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

.rec-video {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-time {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.rec-text {
  margin: 6px 0 4px;
  line-height: 1.7;
  font-size: 13px;
}

.rec-reason {
  margin: 0;
}
</style>
