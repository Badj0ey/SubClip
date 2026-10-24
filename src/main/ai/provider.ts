/**
 * AI 能力层（第六阶段）。
 *
 * ## 设计原则（提示词里写死的）
 *
 * **AI 必须是增强功能，基础功能不能依赖 AI。**
 * 所以这里的所有出口都遵循同一套约定：
 * - 后端默认是 `off`（设置里的默认值），关掉时所有 AI 调用直接抛错，界面显示「未启用」；
 * - 任何失败都只影响这一次 AI 请求，不影响字幕 / 检索 / 切片；
 * - 结果落库到第三阶段就建好的 `analysis` 表（`kind` 区分摘要 / 标签 / 标题 / 解释），
 *   下次打开直接读，不重复烧 token。
 *
 * ## 两个后端
 *
 * - `ollama`：本地 HTTP 接口（`/api/chat`、`/api/embeddings`、`/api/tags`），隐私好、免费；
 * - `openai`：任何 OpenAI 兼容的 `/chat/completions`、`/embeddings`
 *   （OpenAI / DeepSeek / 智谱 / vLLM / LM Studio 都兼容这一套）。
 *
 * 两边的提示词完全共用（见 `prompts.ts`），只有传输层不同 —— 这样切后端时输出风格不会变。
 */
import type { AiStatus, AiTagSuggestion } from '@shared/types'
import { loadSettings } from '../settings'
import {
  buildExplainPrompt,
  buildSummaryPrompt,
  buildTagsPrompt,
  buildTitlePrompt,
  parseTagSuggestions
} from './prompts'

export interface ChatOptions {
  system: string
  user: string
  /** 期望返回 JSON（Ollama 用 format=json；OpenAI 用 response_format） */
  json?: boolean
  /** 覆盖温度 */
  temperature?: number
}

/** 当前生效的后端描述（落库时记进 `analysis.provider`，便于回溯是谁生成的） */
export function currentProviderName(): string {
  const s = loadSettings()
  if (s.aiProvider === 'ollama') return `ollama:${s.aiOllamaModel}`
  if (s.aiProvider === 'openai') return `openai:${s.aiOpenaiModel}`
  return 'off'
}

function ensureEnabled(): 'ollama' | 'openai' {
  const s = loadSettings()
  if (s.aiProvider === 'off') {
    throw new Error('AI 功能未启用（设置 → AI 能力层）。基础功能不受影响。')
  }
  return s.aiProvider
}

function timeoutSignal(seconds: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3, seconds) * 1000)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

/* --------------------------------- Ollama -------------------------------- */

async function ollamaChat(opts: ChatOptions): Promise<string> {
  const s = loadSettings()
  const url = `${s.aiOllamaUrl.replace(/\/$/, '')}/api/chat`
  const { signal, done } = timeoutSignal(s.aiTimeoutSeconds)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: s.aiOllamaModel,
        stream: false,
        // Ollama 的 JSON 模式：模型必须输出合法 JSON 时用它，省掉解析容错
        ...(opts.json ? { format: 'json' } : {}),
        options: { temperature: opts.temperature ?? s.aiTemperature },
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ]
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama 返回 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
    }
    const data = (await res.json()) as { message?: { content?: string } }
    const content = data.message?.content ?? ''
    if (!content.trim()) throw new Error('Ollama 返回了空内容')
    return content.trim()
  } finally {
    done()
  }
}

/** 探测 Ollama：列模型即探测（顺便拿到可用模型名供设置页选择） */
async function ollamaStatus(): Promise<AiStatus> {
  const s = loadSettings()
  const url = `${s.aiOllamaUrl.replace(/\/$/, '')}/api/tags`
  const t0 = Date.now()
  const { signal, done } = timeoutSignal(8)
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) {
      return {
        provider: 'ollama',
        available: false,
        message: `Ollama 返回 HTTP ${res.status}（服务在跑但不是预期接口？）`,
        models: [],
        latencyMs: Date.now() - t0
      }
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    const models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean)
    return {
      provider: 'ollama',
      available: true,
      message: models.length ? `已连接，${models.length} 个模型可用` : '已连接，但还没有拉取任何模型',
      models,
      latencyMs: Date.now() - t0
    }
  } catch (err) {
    // Node 的 fetch 失败只会给一句 "fetch failed"，真正的原因在 cause 里
    // （ECONNREFUSED / ENOTFOUND / 超时…）。不挖出来用户没法排查。
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code || cause?.message || (err as Error).message
    return {
      provider: 'ollama',
      available: false,
      message: `连接不到 Ollama（${s.aiOllamaUrl}）：${detail}。请确认服务已启动。`,
      models: [],
      latencyMs: Date.now() - t0
    }
  } finally {
    done()
  }
}

/* ---------------------------- OpenAI 兼容接口 ---------------------------- */

async function openaiChat(opts: ChatOptions): Promise<string> {
  const s = loadSettings()
  const url = `${s.aiOpenaiUrl.replace(/\/$/, '')}/chat/completions`
  const { signal, done } = timeoutSignal(s.aiTimeoutSeconds)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.aiOpenaiKey}`
      },
      signal,
      body: JSON.stringify({
        model: s.aiOpenaiModel,
        temperature: opts.temperature ?? s.aiTemperature,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ]
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`接口返回 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    if (!content.trim()) throw new Error('接口返回了空内容')
    return content.trim()
  } finally {
    done()
  }
}

async function openaiStatus(): Promise<AiStatus> {
  const s = loadSettings()
  const t0 = Date.now()
  if (!s.aiOpenaiKey.trim()) {
    return {
      provider: 'openai',
      available: false,
      message: '还没填 API Key',
      models: [],
      latencyMs: 0
    }
  }
  const url = `${s.aiOpenaiUrl.replace(/\/$/, '')}/models`
  const { signal, done } = timeoutSignal(10)
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${s.aiOpenaiKey}` }, signal })
    if (!res.ok) {
      return {
        provider: 'openai',
        available: false,
        // 有些兼容服务不实现 /models，这时不能判定为「不可用」
        message:
          res.status === 404
            ? '该服务没有 /models 接口（不影响使用，直接试生成即可）'
            : `接口返回 HTTP ${res.status}（检查 Key 与 base URL）`,
        models: [s.aiOpenaiModel],
        latencyMs: Date.now() - t0
      }
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean)
    return {
      provider: 'openai',
      available: true,
      message: '已连接',
      models: models.length ? models : [s.aiOpenaiModel],
      latencyMs: Date.now() - t0
    }
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code || cause?.message || (err as Error).message
    return {
      provider: 'openai',
      available: false,
      message: `连接失败：${detail}`,
      models: [],
      latencyMs: Date.now() - t0
    }
  } finally {
    done()
  }
}

/* --------------------------------- 出口 --------------------------------- */

/** 探测当前后端是否可用（设置页「测试连接」与状态展示都用它） */
export async function probeAi(): Promise<AiStatus> {
  const s = loadSettings()
  if (s.aiProvider === 'off') {
    return {
      provider: 'off',
      available: false,
      message: 'AI 功能未启用（基础功能不受影响）',
      models: [],
      latencyMs: 0
    }
  }
  return s.aiProvider === 'ollama' ? ollamaStatus() : openaiStatus()
}

/** 统一的对话入口（后端差异只在这里体现） */
export async function chat(opts: ChatOptions): Promise<string> {
  const provider = ensureEnabled()
  // 中文提示：模型经常在前后加解释性文字，这里统一清一遍
  const raw = provider === 'ollama' ? await ollamaChat(opts) : await openaiChat(opts)
  return stripFence(raw)
}

/** 去掉模型爱包的 ```json ``` 代码围栏 */
export function stripFence(text: string): string {
  const t = text.trim()
  const m = /^```(?:json|[a-z]*)\s*\n([\s\S]*?)\n?```$/i.exec(t)
  return (m ? m[1] : t).trim()
}

/* ------------------------------- 五个能力 ------------------------------- */

/** 视频 / 字幕段落的摘要 */
export async function generateSummary(title: string, text: string): Promise<string> {
  const p = buildSummaryPrompt(title, text)
  return chat({ system: p.system, user: p.user })
}

/** 标签建议（返回结构化数组，交给用户审核后再落库） */
export async function generateTags(title: string, text: string): Promise<AiTagSuggestion[]> {
  const p = buildTagsPrompt(title, text)
  const raw = await chat({ system: p.system, user: p.user, json: true })
  return parseTagSuggestions(raw)
}

/** 标题建议（给切片命名用；单条结果，调用方拿到后可直接填进备注） */
export async function generateTitle(text: string): Promise<string> {
  const p = buildTitlePrompt(text)
  const raw = await chat({ system: p.system, user: p.user })
  // 模型有时会带引号或「标题：」前缀，清掉
  return raw
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/^(标题|片名|名称)\s*[:：]\s*/, '')
    .split('\n')[0]
    .trim()
    .slice(0, 60)
}

/** 逐句解释（选中一句字幕让它讲一下） */
export async function explainCue(context: string, cue: string): Promise<string> {
  const p = buildExplainPrompt(context, cue)
  return chat({ system: p.system, user: p.user, temperature: 0.2 })
}

/**
 * 只把「查询 → 一批文本」的相似度打分交给模型（云端语义搜索的兜底路线）。
 *
 * 说明：本地语义检索（第四阶段）已经能离线做这件事，所以这里的定位是
 * **没建本地索引、也不想下载模型**时的替代方案 —— 代价是要把候选文本发到云端。
 */
export async function rankByMeaning(query: string, candidates: string[]): Promise<number[]> {
  if (!candidates.length) return []
  const list = candidates.map((c, i) => `${i + 1}. ${c.slice(0, 120)}`).join('\n')
  const raw = await chat({
    json: true,
    system:
      '你是一个文本相关性打分器。给每个候选片段与查询的语义相关度打分（0~100 的整数），' +
      '只输出 JSON：{"scores":[{"i":1,"score":80}]}，不要解释。',
    user: `查询：${query}\n\n候选片段：\n${list}`
  })
  try {
    const parsed = JSON.parse(raw) as { scores?: Array<{ i?: number; score?: number }> }
    const out = new Array(candidates.length).fill(0) as number[]
    for (const item of parsed.scores ?? []) {
      const idx = Number(item.i) - 1
      if (idx >= 0 && idx < out.length) out[idx] = Number(item.score) || 0
    }
    return out
  } catch {
    throw new Error('模型没有返回可解析的打分 JSON')
  }
}
