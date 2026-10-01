/**
 * 时间工具：内部统一使用「秒」（浮点），对外展示使用 HH:MM:SS。
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/**
 * 秒 → 时间字符串。
 * @param totalSeconds 秒数
 * @param withMs 是否带毫秒（SRT 写回时需要）
 */
export function formatTime(totalSeconds: number, withMs = false): string {
  const s = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const whole = Math.floor(s)
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  const base = `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`
  if (!withMs) return base
  const ms = Math.round((s - whole) * 1000)
  // 四舍五入到 1000ms 时向上进位
  if (ms >= 1000) return formatTime(whole + 1, true)
  return `${base},${pad3(ms)}`
}

/**
 * 时间字符串 → 秒。尽量宽容地接受各种写法：
 * `00:01:20,000`、`00:01:20.000`、`01:20`、`83.5`、`1分30秒`、纯数字。
 * 无法解析时返回 NaN。
 */
export function parseTime(raw: string): number {
  if (raw === null || raw === undefined) return NaN
  let text = String(raw).trim()
  if (!text) return NaN

  // 中文写法：1分30秒 / 1时2分3秒
  if (/[一-龥]/.test(text)) {
    const h = /(\d+(?:\.\d+)?)\s*(?:小时|时)/.exec(text)
    const m = /(\d+(?:\.\d+)?)\s*分/.exec(text)
    const s = /(\d+(?:\.\d+)?)\s*秒/.exec(text)
    if (h || m || s) {
      return (
        (h ? parseFloat(h[1]) * 3600 : 0) +
        (m ? parseFloat(m[1]) * 60 : 0) +
        (s ? parseFloat(s[1]) : 0)
      )
    }
    return NaN
  }

  // 纯数字（秒）
  if (/^\d+(?:\.\d+)?$/.test(text)) return parseFloat(text)

  // 统一分隔符：把逗号替换为点，便于处理毫秒
  text = text.replace(',', '.')
  const parts = text.split(':').map((p) => p.trim())
  if (parts.length < 2 || parts.length > 3) return NaN

  const nums = parts.map((p) => (p === '' ? 0 : parseFloat(p)))
  if (nums.some((n) => Number.isNaN(n))) return NaN

  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
  return nums[0] * 60 + nums[1]
}

/** 时间范围的可读描述 */
export function formatRange(start: number, end: number): string {
  return `${formatTime(start)} → ${formatTime(end)}`
}

/** 时长可读描述（带「共 X 秒」） */
export function formatDuration(seconds: number): string {
  return `${formatTime(seconds)}（${seconds.toFixed(1)} 秒）`
}
