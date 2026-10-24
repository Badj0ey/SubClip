/**
 * AI 提示词（第六阶段）。
 *
 * 单独放一个文件的原因：提示词是**产品行为的一部分**（输出风格、长度、语言都在这里定），
 * 与「怎么发请求」无关。两个后端（Ollama / OpenAI 兼容）共用同一套提示词，
 * 所以切换后端时输出风格不会突然变化。
 *
 * 约定：
 * - 全部用中文系统提示，并明确「只输出结果本身」——模型很爱加「好的，以下是…」；
 * - 需要结构化结果时在提示里写明 JSON 形状，并在 `parseTagSuggestions` 里做容错
 *   （模型返回的 JSON 经常带围栏、缺字段、多字段）。
 */
import type { AiTagSuggestion } from '@shared/types'

/** 字幕文本给模型前的裁剪：太长既烧 token 又容易跑题 */
export function clipText(text: string, maxChars = 6000): string {
  const t = text.trim()
  if (t.length <= maxChars) return t
  // 头尾都留：开头往往是主题，结尾常有结论
  const head = t.slice(0, Math.floor(maxChars * 0.7))
  const tail = t.slice(-Math.floor(maxChars * 0.3))
  return `${head}\n……（中间省略）……\n${tail}`
}

export function buildSummaryPrompt(title: string, text: string): { system: string; user: string } {
  return {
    system:
      '你是一个视频字幕分析助手。用简体中文输出，直接给结果，不要任何寒暄或「以下是」之类的前缀。',
    user:
      `请为下面这段视频字幕写一个摘要。要求：\n` +
      `1. 3~5 句话，说明这段视频讲了什么、有哪些主要观点；\n` +
      `2. 用陈述句，不要写成「视频讲述了…」这种套话开头；\n` +
      `3. 不要编造字幕里没有的信息。\n\n` +
      `视频标题：${title || '（无）'}\n` +
      `字幕内容：\n${clipText(text)}`
  }
}

export function buildTagsPrompt(title: string, text: string): { system: string; user: string } {
  return {
    system:
      '你是一个内容分类助手。只输出一个 JSON 对象，不要输出任何解释文字。',
    user:
      `请为下面这段视频字幕建议 3~6 个分类标签（用于素材库筛选）。\n` +
      `要求：\n` +
      `1. 每个标签 2~6 个字，是**主题词**（如「人工智能」「创业」「美食」），不要写成句子；\n` +
      `2. 不要用「其他」「综合」这类没有区分度的词；\n` +
      `3. 每个标签给一句很短的理由（不超过 20 字）。\n` +
      `输出格式（严格按此 JSON）：\n` +
      `{"tags":[{"name":"人工智能","reason":"讨论了模型能力与局限"}]}\n\n` +
      `视频标题：${title || '（无）'}\n` +
      `字幕内容：\n${clipText(text, 4000)}`
  }
}

export function buildTitlePrompt(text: string): { system: string; user: string } {
  return {
    system: '你是一个视频剪辑命名助手。只输出一个标题，不要引号、不要解释。',
    user:
      `为下面这段字幕内容起一个短视频标题。要求：\n` +
      `1. 8~20 个字，概括这段的核心内容；\n` +
      `2. 不要用「震惊」「必看」这类标题党词汇；\n` +
      `3. 不要加书名号、引号或标点结尾。\n\n` +
      `字幕内容：\n${clipText(text, 2000)}`
  }
}

export function buildExplainPrompt(context: string, cue: string): { system: string; user: string } {
  return {
    system:
      '你是一个字幕理解助手。用简体中文解释，2~4 句话，直接给解释，不要复述原句。',
    user:
      `下面是一条视频字幕，以及它前后的上下文。请解释这句话的意思` +
      `（如果包含梗、术语或专业名词，一并说明）。\n\n` +
      `上下文：\n${clipText(context, 800)}\n\n` +
      `要解释的这句：${cue}`
  }
}

/**
 * 解析标签建议。
 *
 * 容错优先：模型可能返回 `{"tags":[...]}`、直接一个数组、带围栏、字段名不同，
 * 甚至把 `reason` 写成 `why`。任何解析失败都不抛错，而是返回空数组
 * （界面显示「没有建议」比弹一个看不懂的 JSON 解析错误好）。
 */
export function parseTagSuggestions(raw: string): AiTagSuggestion[] {
  const text = raw.trim()
  const attempts: string[] = [text]

  // 去掉可能的代码围栏
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(text)
  if (fence) attempts.push(fence[1])

  // 截取第一个 { 到最后一个 }（有的模型会在前后加一句话）
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1))
  const a1 = text.indexOf('[')
  const a2 = text.lastIndexOf(']')
  if (a1 >= 0 && a2 > a1) attempts.push(text.slice(a1, a2 + 1))

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { tags?: unknown }).tags)
          ? ((parsed as { tags: unknown[] }).tags as unknown[])
          : null
      if (!list) continue
      const out: AiTagSuggestion[] = []
      for (const item of list) {
        if (typeof item === 'string') {
          if (item.trim()) out.push({ name: item.trim().slice(0, 20), reason: '' })
          continue
        }
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        const name = String(obj.name ?? obj.tag ?? obj.label ?? '').trim()
        if (!name) continue
        const reason = String(obj.reason ?? obj.why ?? obj.说明 ?? '').trim()
        out.push({ name: name.slice(0, 20), reason: reason.slice(0, 60) })
      }
      if (out.length) return out.slice(0, 10)
    } catch {
      /* 试下一种解析方式 */
    }
  }
  return []
}
