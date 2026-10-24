/**
 * 发布素材包（第九阶段）。
 *
 * ## 它是什么
 *
 * 把「录完 / 切完」到「能发布」之间那些**琐碎但每次都要做**的事一次做完：
 * 标题、简介、话题标签（套用第八阶段的文案模板），加上切片清单、分镜表、
 * 每个片段的字幕稿。产出一个文件夹，打开就能照着发。
 *
 * ## 为什么先做这个（不做成片拼接）
 *
 * 成片拼接要 ffmpeg，而**产物在开发机上无法验证**（本机没有 ffmpeg）；
 * 这一半是纯文本，今天就能端到端验完。成片拼接留到后面单独做。
 *
 * ## 纯函数
 *
 * 生成逻辑（表格对齐、时间格式、文件名清理、缺值兜底）全部在这里，
 * 组件与主进程只负责取数据 —— 这样才测得了。
 */

/** 一个片段在成片里的位置（按顺序） */
export interface KitClip {
  /** 在成片里的序号，从 1 开始 */
  order: number
  /** 片段名（也是切片产物的备注） */
  name: string
  bvid: string
  page: number
  start: number
  end: number
  /** 来源视频标题 */
  videoTitle: string
  /** 备注 */
  note: string
  /** 覆盖的字幕文本（可空） */
  subtitle: string
}

/** 生成素材包所需的全部输入 */
export interface KitInput {
  /** 包裹名（会做文件名清理） */
  title: string
  /** 简介 / 正文（已经过模板渲染） */
  description: string
  /** 话题标签（不带 #） */
  tags: string[]
  /** 成片总时长（秒） */
  totalDuration: number
  clips: KitClip[]
  /** 生成时间（毫秒时间戳；由调用方传入，方便测试固定值） */
  generatedAt: number
  /** 来源说明（UP主 / BV 号等，可空） */
  source?: string
}

/** 秒 → `00:01:02` */
export function hms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/**
 * 把文本清成安全的文件名 / 文件夹名。
 *
 * 不能直接复用 `@shared/filename` 的 `sanitizeFileName`：
 * 那个面向「切片产物名」，会保留一些在这里不该留的字符（比如 `#`）；
 * 而这里是给用户自己看的文件夹名，规则更严一点、并且要处理空值。
 */
export function safeKitName(name: string, fallback = '发布素材包'): string {
  const cleaned = (name ?? '')
    .replace(/[\\/:*?"<>|#\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim()
  return cleaned || fallback
}

/** 分镜表里一行（对齐用，所以先算好单元格） */
export interface StoryboardRow {
  order: number
  name: string
  time: string
  duration: string
  source: string
}

/** 生成分镜表行 */
export function buildStoryboard(clips: KitClip[]): StoryboardRow[] {
  return clips.map((c) => ({
    order: c.order,
    name: c.name || `片段 ${c.order}`,
    time: `${hms(c.start)} → ${hms(c.end)}`,
    duration: hms(Math.max(0, c.end - c.start)),
    source: c.page > 1 ? `${c.videoTitle} · P${c.page}` : c.videoTitle
  }))
}

/** 把分镜表渲染成 Markdown 表格（列宽对齐，便于直接读） */
export function renderStoryboardTable(rows: StoryboardRow[]): string {
  if (!rows.length) return '_（没有片段）_'
  const header = ['#', '片段', '原片时间', '时长', '来源']
  const cells = rows.map((r) => [String(r.order), r.name, r.time, r.duration, r.source])

  /**
   * 计算显示宽度：中文按 2 格算。
   *
   * 表格对齐必须按**显示宽度**算 —— 否则中文列会看起来"短"，表格歪掉。
   * （这类表格在编辑器里用等宽字体看，中文恰好占两格。）
   */
  const width = (s: string): number =>
    [...s].reduce((n, ch) => n + (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0)

  /** 按显示宽度补空格 */
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - width(s)))

  const widths = header.map((h, i) => Math.max(width(h), ...cells.map((row) => width(row[i] ?? ''))))
  const line = (arr: string[]): string => `| ${arr.map((s, i) => pad(s, widths[i])).join(' | ')} |`

  /**
   * 分隔行也必须逐格走 `pad`。
   *
   * 踩过的坑：直接写 `'-'.repeat(widths[i])` 看起来"填满了"，但那是**字符数**，
   * 而 `widths` 是**显示宽度**（中文按 2 格算）。两种单位混用 →
   * 分隔行比数据行窄 2 格（实测 69 vs 71），Markdown 渲染出来整张表是歪的。
   *
   * 破折号个数就取 `w`（ASCII 破折号显示宽度是 1，`'-'.repeat(w)` 的显示宽度恰好是 `w`），
   * 再由 `pad` 补齐可能缺的空格。**不要**在这里再套 `Math.max(3, …)` ——
   * 那会让破折号少 1 格，整行跟着差 1 格（实测又踩了一次）。
   */
  const dashes = widths.map((w) => pad('-'.repeat(Math.max(1, w)), w))

  return [line(header), line(dashes), ...cells.map(line)].join('\n')
}

/**
 * 生成 README.md（素材包的主文件）。
 *
 * 刻意用 Markdown：用户大概率要把它连同成片一起贴到某个地方，
 * 或者自己再看一遍 —— 纯文本表格在编辑器里读起来最舒服。
 */
export function renderKitReadme(input: KitInput): string {
  const tags = input.tags.map((t) => t.trim().replace(/^#+/, '')).filter(Boolean)
  const lines: string[] = []
  lines.push(`# ${input.title || '发布素材包'}`)
  lines.push('')
  lines.push(`> 生成时间：${new Date(input.generatedAt).toLocaleString()}`)
  lines.push(`> 片段：${input.clips.length} 条 · 成片预计时长：${hms(input.totalDuration)}`)
  if (input.source) lines.push(`> 来源：${input.source}`)
  lines.push('')

  if (input.description.trim()) {
    lines.push('## 发布文案')
    lines.push('')
    lines.push(input.description.trim())
    lines.push('')
  }

  if (tags.length) {
    lines.push('## 话题标签')
    lines.push('')
    lines.push(tags.map((t) => `#${t}`).join(' '))
    lines.push('')
  }

  lines.push('## 分镜表')
  lines.push('')
  lines.push(renderStoryboardTable(buildStoryboard(input.clips)))
  lines.push('')
  lines.push('> 时间列为**原片时间**（切片工具的输入），不是成片内的时间。')
  lines.push('')

  lines.push('## 片段明细')
  lines.push('')
  for (const c of input.clips) {
    lines.push(`### ${c.order}. ${c.name || `片段 ${c.order}`}`)
    lines.push('')
    lines.push(`- 原片时间：${hms(c.start)} → ${hms(c.end)}（${hms(Math.max(0, c.end - c.start))}）`)
    lines.push(`- 来源：${c.videoTitle}${c.page > 1 ? ` · P${c.page}` : ''}（${c.bvid}）`)
    if (c.note && c.note !== c.name) lines.push(`- 备注：${c.note}`)
    if (c.subtitle.trim()) {
      lines.push('')
      lines.push('**字幕稿**')
      lines.push('')
      lines.push('```')
      lines.push(c.subtitle.trim())
      lines.push('```')
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** 生成切片清单（CSV），可直接喂给切片工具批量跑 */
export function renderClipCsv(clips: KitClip[]): string {
  const esc = (s: string): string => `"${String(s).replace(/"/g, '""')}"`
  const header = ['序号', 'BV号', '分P', '开始秒', '结束秒', '备注']
  const rows = clips.map((c) =>
    [String(c.order), c.bvid, String(c.page), c.start.toFixed(2), c.end.toFixed(2), c.name].map(esc)
  )
  return [header.map(esc).join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n'
}

/** 素材包里的一个文件 */
export interface KitFile {
  /** 相对路径（目录分隔统一用 `/`，落盘时再转） */
  path: string
  content: string
}

/**
 * 生成整个素材包的文件列表（不落盘，纯数据 —— 便于单测与实际写入分离）。
 */
export function buildPublishKit(input: KitInput): { folder: string; files: KitFile[] } {
  const folder = safeKitName(input.title)
  const tags = input.tags.map((t) => t.trim().replace(/^#+/, '')).filter(Boolean)
  const files: KitFile[] = [
    { path: 'README.md', content: renderKitReadme(input) },
    { path: '标题.txt', content: `${input.title}\n` },
    { path: '简介.txt', content: `${input.description.trim()}\n` },
    {
      path: '标签.txt',
      content: tags.length ? tags.map((t) => `#${t}`).join(' ').concat('\n') : '（未填写）\n'
    },
    { path: '切片清单.csv', content: renderClipCsv(input.clips) }
  ]

  // 每个片段的字幕稿单独成文件：真实投稿时常常要一条条贴，
  // 混在一个大文件里反而要来回找
  input.clips.forEach((c, i) => {
    if (!c.subtitle.trim()) return
    const name = `${String(i + 1).padStart(2, '0')}-${safeKitName(c.name, `片段${i + 1}`)}.txt`
    files.push({ path: `字幕稿/${name}`, content: `${c.subtitle.trim()}\n` })
  })

  return { folder, files }
}
