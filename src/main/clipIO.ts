/**
 * 切片任务的 JSON 导入 / 导出。
 *
 * 用途：把一批任务存下来（或发给别人），换台机器 / 换个人继续切。
 * 纯函数，不碰文件系统，便于单测；解析时**逐条校验**，坏数据只跳过并记告警，
 * 不整份拒绝 —— 用户手改过的文件里有一条写错，不该让另外 99 条也白费。
 */
import type { ClipTask } from '@shared/types'

export const CLIP_JSON_KIND = 'subclip/clip-tasks'
/**
 * 老版本导出的清单用这些 kind。
 *
 * 必须继续认：用户以前导出的 `*.json` 表如果直接打不开，
 * 那就是「更名把功能改坏了」—— 改名字不该让已有文件失效。
 */
export const LEGACY_CLIP_JSON_KINDS = ['srt-clip-helper/clip-tasks']
export const CLIP_JSON_VERSION = 1

export interface ClipJsonFile {
  kind: string
  version: number
  exportedAt: string
  tasks: Array<{
    bvid: string
    page: number
    start: number
    end: number
    note: string
    segments?: Array<{ page: number; start: number; end: number }>
  }>
}

/** 导出：只保留可移植字段（丢掉本地自增 id 与文档关联） */
export function serializeClipTasks(tasks: ClipTask[]): string {
  const payload: ClipJsonFile = {
    kind: CLIP_JSON_KIND,
    version: CLIP_JSON_VERSION,
    exportedAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      bvid: t.bvid,
      page: t.page,
      start: t.start,
      end: t.end,
      note: t.note,
      ...(t.segments && t.segments.length > 1 ? { segments: t.segments } : {})
    }))
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

export interface ParsedClipTasks {
  tasks: Array<{
    bvid: string
    page: number
    start: number
    end: number
    note: string
    segments?: Array<{ page: number; start: number; end: number }>
  }>
  warnings: string[]
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function parseClipTasksJson(text: string): ParsedClipTasks {
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`不是合法的 JSON：${(err as Error).message}`)
  }

  // 允许两种形态：带信封的导出文件，或者干脆就是一个数组
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { tasks?: unknown })?.tasks as unknown)

  if (!Array.isArray(list)) {
    throw new Error('文件里没有找到任务数组（期望 { tasks: [...] } 或直接是数组）')
  }

  /**
   * kind 只在**明显不对**时给一条告警，不拒绝导入。
   *
   * 为什么不拒绝：这个格式是「无信封也能读」的宽容设计 ——
   * 用户可能手写一个数组、也可能用旧版本导出的文件（kind 还是老名字）。
   * 把 kind 当硬门槛会把这两种正常情况一并挡掉。
   */
  const declaredKind = (raw as { kind?: unknown })?.kind
  if (
    typeof declaredKind === 'string' &&
    declaredKind !== CLIP_JSON_KIND &&
    !LEGACY_CLIP_JSON_KINDS.includes(declaredKind)
  ) {
    warnings.push(`文件标记的类型是「${declaredKind}」，不是本工具导出的清单，仍按任务列表尝试读取`)
  }

  const tasks: ParsedClipTasks['tasks'] = []
  list.forEach((item, i) => {
    const at = `第 ${i + 1} 条`
    if (!item || typeof item !== 'object') {
      warnings.push(`${at}：不是对象，已跳过`)
      return
    }
    const row = item as Record<string, unknown>
    const start = num(row.start, NaN)
    const end = num(row.end, NaN)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      warnings.push(`${at}：开始/结束时间不是数字，已跳过`)
      return
    }
    if (end <= start) {
      warnings.push(`${at}：结束时间不大于开始时间，已跳过`)
      return
    }

    const segments = Array.isArray(row.segments)
      ? (row.segments as Array<Record<string, unknown>>)
          .map((s) => ({
            page: Math.max(1, Math.trunc(num(s?.page, 1))),
            start: num(s?.start, 0),
            end: num(s?.end, 0)
          }))
          .filter((s) => s.end > s.start)
      : undefined

    tasks.push({
      bvid: String(row.bvid ?? '').trim().slice(0, 40),
      page: Math.max(1, Math.trunc(num(row.page, 1))),
      start,
      end,
      note: String(row.note ?? '').trim().slice(0, 120) || `导入_${i + 1}`,
      ...(segments && segments.length > 1 ? { segments } : {})
    })
  })

  return { tasks, warnings }
}
