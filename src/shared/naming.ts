/**
 * 切片任务命名模板。
 *
 * 备注字段就是切片工具的输出文件名，所以模板直接影响产物命名。
 * 占位符写成 `{name}`，未知占位符原样保留（用户拼错了能一眼看出来，而不是悄悄变成空）。
 */

export interface NameTemplateContext {
  /** 用户填的前缀（默认是视频标题） */
  prefix: string
  /** 第几条，从 1 开始 */
  index: number
  bvid: string
  page: number
  /** 秒 */
  start: number
  end: number
  duration: number
  title: string
}

export const DEFAULT_NAME_TEMPLATE = '{prefix}_{index}'

/** 可用占位符（设置页据此展示提示） */
export const NAME_TEMPLATE_TOKENS = [
  '{prefix}',
  '{index}',
  '{bvid}',
  '{page}',
  '{start}',
  '{end}',
  '{duration}',
  '{title}'
] as const

/** 秒 → `1m02s` / `12s`，用在文件名里比 `00:01:02` 更短且不含冒号 */
export function compactDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`
}

/** 秒 → `00-01-02`（文件名安全的时间戳） */
export function fileStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}-${pad(m)}-${pad(s)}`
}

export function renderNameTemplate(template: string, ctx: NameTemplateContext): string {
  const tpl = (template ?? '').trim() || DEFAULT_NAME_TEMPLATE
  const values: Record<string, string> = {
    prefix: ctx.prefix ?? '',
    index: String(ctx.index),
    bvid: ctx.bvid ?? '',
    page: String(ctx.page ?? 1),
    start: fileStamp(ctx.start),
    end: fileStamp(ctx.end),
    duration: compactDuration(ctx.duration),
    title: ctx.title ?? ''
  }
  return tpl
    .replace(/\{(\w+)\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
    )
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
}
