/**
 * 剪辑文案模板（第八阶段）。
 *
 * ## 为什么和 `naming.ts` 分开
 *
 * `naming.ts` 渲染的是**单行文件名**（备注字段就是切片产物名），
 * 所以它把换行/制表符统统压成空格。
 * 文案模板渲染的是**多行文本**（简介、标签），换行正是它的结构。
 * 两者语法一致（都用 `{token}`），但规则相反，混在一个函数里必然互相破坏。
 *
 * ## 语法
 *
 * - `{token}` —— 普通占位符；**未知占位符原样保留**（拼错了能一眼看出来，
 *   而不是悄悄变成空字符串 —— 这一点沿用 `naming.ts` 的取舍）；
 * - `{@list:token}` —— 列表项占位符。上下文里该 token 是数组时，
 *   逐项渲染并把整行重复多次；是单个值时就当普通占位符。用于「标签」「分镜」这类内容；
 * - `{#tag}` —— 标签专用：把上下文里的 tags 拼成 `#a #b #c`。
 *
 * ## 纯函数
 *
 * 渲染规则（尤其列表展开与未知占位符保留）是这套功能的核心，
 * 放这里才测得了 —— 组件里只能靠肉眼看。
 */

/** 一个文案模板 */
export interface CopyTemplate {
  id: string
  name: string
  /** 用途说明（界面上告诉用户这个模板是干什么的） */
  description: string
  /** 模板正文，可多行 */
  body: string
}

/** 渲染上下文：值可以是字符串、数字，或字符串数组（配合 `{@list:...}`） */
export type CopyContext = Record<string, string | number | string[]>

/**
 * 内置模板。
 *
 * 提供三个起步模板而不是留空：空状态下的模板编辑器对用户毫无抓手
 * ——「我该写什么占位符」正是他们要问的问题。这三个也顺带充当语法示例。
 */
export const BUILTIN_TEMPLATES: CopyTemplate[] = [
  {
    id: 'shortvideo',
    name: '短视频发布文案',
    description: '一句话标题 + 三段式简介 + 话题标签',
    body: [
      '{title}',
      '',
      '{hook}',
      '',
      '【本期内容】',
      '{summary}',
      '',
      '⏱ 时长：{duration}',
      '{#tag}'
    ].join('\n')
  },
  {
    id: 'collection',
    name: '合集 / 系列文案',
    description: '适合把同一主题的多条片段攒起来发',
    body: [
      '{title}｜第 {episode} 期',
      '',
      '本期围绕「{topic}」整理了 {clipCount} 个片段：',
      '{@list:outline}',
      '',
      '素材来源：{uploader} · {bvid}',
      '{#tag}'
    ].join('\n')
  },
  {
    id: 'clipnote',
    name: '单条片段备注',
    description: '给某一条切片写备注，直接填进切片任务',
    body: '{title} · {start}-{end} ｜ {note}'
  }
]

/**
 * 渲染文案模板。
 *
 * @param template 模板正文（可多行）
 * @param ctx 取值上下文
 */
export function renderCopyTemplate(template: string, ctx: CopyContext): string {
  let out = template ?? ''

  /**
   * 先处理列表占位符。
   *
   * 必须**先**处理 `{@list:x}` 再处理普通 `{x}`：
   * 否则普通的 `{x}` 规则会先把 `{@list:x}` 里的部分内容吃掉，
   * 导致整行重复的次数不对（第一版就是这个顺序问题）。
   */
  out = out.replace(/\{@list:(\w+)\}/g, (whole, key: string) => {
    const value = ctx[key]
    if (!Array.isArray(value)) return whole
    return value.join('\n')
  })

  /**
   * 标签专用：把 tags 数组拼成 #a #b。
   *
   * ⚠️ 与普通占位符**规则相反**：没有标签时这里返回空字符串（整行消失），
   * 而不是像 `{titel}` 那样原样保留。
   * 理由是两者的性质不同：
   * - `{#tag}` 是**可选装饰**，留一个 `{#tag}` 在发布文案里比什么都不留更糟；
   * - 普通占位符拼错是**用户的输入错误**，原样保留才能让人一眼看出来。
   */
  out = out.replace(/\{#(\w+)\}/g, (_whole, key: string) => {
    const value = ctx[key]
    if (Array.isArray(value)) {
      // 去掉已有的 # 前缀再统一加，避免出现 ##
      return value
        .map((t) => t.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .map((t) => `#${t}`)
        .join(' ')
    }
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(/[\s,，、]+/)
        .map((t) => t.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .map((t) => `#${t}`)
        .join(' ')
    }
    // 没有标签（或不是数组/字符串）时留空，让整行干净地消失
    return ''
  })

  // 普通占位符：未知的**原样保留**（与 naming.ts 同一取舍）
  out = out.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = ctx[key]
    if (Array.isArray(value)) return value.join('、')
    if (value === undefined || value === null) return whole
    return String(value)
  })

  /**
   * 收尾清理：
   * - 去掉因为空占位符留下的**行尾空白**；
   * - 把连续 3 个以上换行压成 2 个（空占位符会留下空行，但完全不动又会出现大片空白）。
   */
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从模板正文里提取用到的占位符名（去重、保持出现顺序）。
 *
 * 界面据此生成「填写槽位」的输入框 —— 用户不必自己记有哪些占位符；
 * 设置页也用它在模板列表里展示「这个模板需要填什么」。
 */
export function extractTokens(template: string): string[] {
  const out: string[] = []
  const re = /\{@list:(\w+)\}|\{#(\w+)\}|\{(\w+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template ?? '')) !== null) {
    const name = m[1] ?? m[2] ?? m[3]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 占位符的中文说明。
 *
 * 只有**内置**的这些有说明；用户自己写的占位符没说明时就显示占位符本身
 * —— 不要编一个可能错的解释。
 */
export const TOKEN_LABELS: Record<string, string> = {
  title: '标题',
  hook: '开场一句',
  summary: '内容简介',
  topic: '主题',
  episode: '第几期',
  clipCount: '片段数量',
  outline: '分镜列表（每行一条）',
  uploader: 'UP主',
  bvid: 'BV 号',
  duration: '总时长',
  start: '片段起点',
  end: '片段终点',
  note: '备注',
  tag: '话题标签'
}

export function tokenLabel(token: string): string {
  return TOKEN_LABELS[token] ?? token
}

/** 槽位是否应当用多行输入框（列表类占位符写一行明显不够） */
export function isListToken(token: string): boolean {
  return token === 'outline' || token === 'summary'
}

/* --------------------------- 渲染结果 → 发布字段 --------------------------- */

export interface CarriedFields {
  title: string
  description: string
  /** 空格分隔的标签原文（不带 #），交给素材包的标签输入框 */
  tagText: string
}

/**
 * 把模板渲染结果拆成「标题 / 正文 / 标签」。
 *
 * ## 为什么是启发式（以及为什么仍然可用）
 *
 * 模板渲染出来的是一段自由文本，而发布要的是三个分开的字段。第一行通常是标题
 * （内置的三个模板都这么写），所以规则是：**第一行当标题，其余当正文**。
 *
 * 这是启发式，所以有一条明显的兜底：第一行**过长**时不可能是标题
 * （标题超过 60 字在 B站会被截断），此时整段都算正文、标题留空，
 * 让用户自己决定 —— 而不是硬塞一个长句当标题。
 *
 * 抽成纯函数是为了能测：切分错了会直接影响用户带过去的内容。
 */
export function splitForPublish(rendered: string, maxTitleLength = 60): CarriedFields {
  const text = (rendered ?? '').trim()
  if (!text) return { title: '', description: '', tagText: '' }

  const allLines = text.split('\n')

  /**
   * 标签：从整段里捞 `#xxx`。
   *
   * 用「# 后面非空白非标点」而不是「以 # 开头的整行」：
   * 模板里的话题标签可能与别的文字同处一行，按行取会漏。
   */
  const tags = [...text.matchAll(/#([^\s#,，、]+)/g)].map((m) => m[1])

  /**
   * 正文里要**去掉纯标签行**。
   *
   * 为什么：标签已经单独提到 `tagText` 了，再在正文里留一份，
   * 用户看到的就是重复内容（实测带过去后正文末尾挂着 `#人工智能 #剪辑`）。
   * 只删「整行去掉标签与空格后为空」的行 —— 正文里正常引用的 `#话题` 不会被误删。
   */
  const lines = allLines.filter((line) => {
    const withoutTags = line.replace(/#[^\s#,，、]+/g, '').replace(/[\s,，、]+/g, '')
    return withoutTags !== ''
  })

  const first = (lines[0] ?? '').trim()
  const rest = lines.slice(1).join('\n').trim()

  const titleLooksRight = first.length > 0 && first.length <= maxTitleLength
  const title = titleLooksRight ? first : ''
  const description = (titleLooksRight ? rest : lines.join('\n').trim())
    // 去标签后可能留下多余空行，收一下
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, description, tagText: tags.join(' ') }
}
