/**
 * AI 能力层 store（第六阶段）。
 *
 * 三条硬性约定（与主进程一致，也是提示词的要求）：
 * 1. **AI 是增强功能**：没启用 / 连不上时，界面只显示「未启用」或具体原因，
 *    字幕、检索、切片一概照常工作；
 * 2. **结果落库**（`analysis` 表）：同一对象同一类型只留最新一条，重开应用直接读，不重复烧 token；
 * 3. **AI 生成 + 人审核**：标签建议不会自动落库，要用户在界面里勾完再保存。
 */
import { defineStore } from 'pinia'
import type { AiResult, AiStatus, AiTagSuggestion } from '@shared/types'
import { useUiStore } from './ui'

const UNKNOWN: AiStatus = {
  provider: 'off',
  available: false,
  message: '还没探测过',
  models: [],
  latencyMs: 0
}

export const useAiStore = defineStore('ai', {
  state: () => ({
    status: { ...UNKNOWN } as AiStatus,
    probing: false,
    /** 正在生成的类型（界面用它显示「生成中…」并禁用按钮） */
    busyKind: '' as '' | 'summary' | 'tags' | 'title' | 'explain',
    /** 当前展示的摘要 */
    summary: '' as string,
    summaryProvider: '',
    /** 当前展示的标签建议（未审核） */
    tagSuggestions: [] as AiTagSuggestion[],
    /** 逐句解释（按字幕序号缓存，避免来回点重复请求） */
    explanations: {} as Record<number, string>,
    /** 解释弹窗当前显示的那条 */
    explainIndex: null as number | null
  }),

  getters: {
    enabled(state): boolean {
      return state.status.provider !== 'off'
    },
    ready(state): boolean {
      return state.status.provider !== 'off' && state.status.available
    },
    /** 给界面的一行状态说明 */
    statusText(state): string {
      const s = state.status
      if (s.provider === 'off') return '未启用（设置 → AI 能力层）'
      if (!s.available) return s.message || '不可用'
      const model =
        s.provider === 'ollama' ? s.models[0] ?? '' : s.models[0] ?? ''
      return `已连接${model ? ` · ${model}` : ''}（${s.latencyMs}ms）`
    }
  },

  actions: {
    async probe(): Promise<void> {
      this.probing = true
      try {
        this.status = await window.api.aiStatus()
      } finally {
        this.probing = false
      }
    },

    /** 读已缓存的摘要（不调模型）；没有就不动界面 */
    async loadCachedSummary(targetType: 'video' | 'doc', targetId: number): Promise<void> {
      try {
        const rows = await window.api.aiCached({ targetType, targetId, kind: 'summary' })
        const hit = rows[0]
        if (!hit) {
          this.summary = ''
          this.summaryProvider = ''
          return
        }
        this.summary = (JSON.parse(hit.payload) as { text?: string }).text ?? ''
        this.summaryProvider = hit.provider
      } catch {
        /* 缓存读不出来不影响功能 */
      }
    },

    /** 生成摘要（已存在时会覆盖） */
    async summarize(targetType: 'video' | 'doc', targetId: number, title: string): Promise<void> {
      const ui = useUiStore()
      if (!this.ready) {
        ui.showToast(this.statusText, 'error', 5200)
        return
      }
      this.busyKind = 'summary'
      try {
        const res = await window.api.aiSummary({ targetType, targetId, title })
        if (!res.ok || !res.data) {
          ui.showToast(res.message || '生成摘要失败', 'error', 6000)
          return
        }
        const data = res.data as AiResult
        this.summary = String(data.value)
        this.summaryProvider = data.provider
        ui.showToast('摘要已生成（已存入本地）', 'success')
      } finally {
        this.busyKind = ''
      }
    },

    /** 生成标签建议（**不落库**，等用户审核） */
    async suggestTags(targetType: 'video' | 'doc', targetId: number, title: string): Promise<void> {
      const ui = useUiStore()
      if (!this.ready) {
        ui.showToast(this.statusText, 'error', 5200)
        return
      }
      this.busyKind = 'tags'
      try {
        const res = await window.api.aiTags({ targetType, targetId, title })
        if (!res.ok || !res.data) {
          ui.showToast(res.message || '生成标签建议失败', 'error', 6000)
          return
        }
        this.tagSuggestions = (res.data as AiResult<AiTagSuggestion[]>).value
        ui.showToast(
          `建议了 ${this.tagSuggestions.length} 个标签，勾选后保存`,
          'info',
          4600
        )
      } finally {
        this.busyKind = ''
      }
    },

    /** 给一段文字生成标题（切片命名用） */
    async generateTitle(text: string): Promise<string | null> {
      const ui = useUiStore()
      if (!this.ready) {
        ui.showToast(this.statusText, 'error', 5200)
        return null
      }
      this.busyKind = 'title'
      try {
        const res = await window.api.aiTitle({ text: text.slice(0, 2000) })
        if (!res.ok || !res.data) {
          ui.showToast(res.message || '生成标题失败', 'error', 6000)
          return null
        }
        return res.data
      } finally {
        this.busyKind = ''
      }
    },

    /** 逐句解释（先看缓存） */
    async explain(docId: number, index: number, text: string): Promise<void> {
      const ui = useUiStore()
      this.explainIndex = index
      if (this.explanations[index]) return
      if (!this.ready) {
        ui.showToast(this.statusText, 'error', 5200)
        return
      }
      // 先查库里有没有存过（`cue` 的 targetId 约定是 docId*1e6+index）
      try {
        const rows = await window.api.aiCached({
          targetType: 'cue',
          targetId: docId * 1_000_000 + index
        })
        const hit = rows.find((r) => r.kind === 'explain')
        if (hit) {
          const parsed = JSON.parse(hit.payload) as { text?: string }
          if (parsed.text) {
            this.explanations = { ...this.explanations, [index]: parsed.text }
            return
          }
        }
      } catch {
        /* 读缓存失败就继续调模型 */
      }

      this.busyKind = 'explain'
      try {
        const res = await window.api.aiExplain({ docId, index })
        if (!res.ok || !res.data) {
          ui.showToast(res.message || '解释失败', 'error', 6000)
          return
        }
        const value = String((res.data as AiResult).value)
        this.explanations = { ...this.explanations, [index]: value }
      } finally {
        this.busyKind = ''
      }
    },

    closeExplain(): void {
      this.explainIndex = null
    },

    clearTagSuggestions(): void {
      this.tagSuggestions = []
    }
  }
})
