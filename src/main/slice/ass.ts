/**
 * 烧录字幕的 ASS 生成与路径转义。
 *
 * 本地切片支持「字幕烧录」：把切片区间内的字幕直接画进视频画面（硬字幕）。
 * 这里负责两点：
 *   1. 把字幕条目转成 ASS 文本（libass 能认的样式与时间格式）；
 *   2. 把文件路径转义成 ffmpeg subtitles 滤镜参数能正确解析的形式。
 *
 * Windows 下滤镜参数以冒号分隔，盘符冒号、单引号都必须转义，
 * 反斜杠统一换成斜杠，否则带空格 / 中文的路径会解析失败（已实测）。
 */

/** 一条待烧录的字幕（时间为相对切片起点的秒数） */
export interface BurnCue {
  start: number
  end: number
  text: string
}

/** 把秒数转成 ASS 时间戳 H:MM:SS.cc */
export function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(2).padStart(5, '0')
  return `${h}:${String(m).padStart(2, '0')}:${sec}`
}

/**
 * 转义字幕文本里的 ASS 控制字符。
 * - `{`/`}` 是覆盖块定界符，直接删会少字，换成全角括号最接近原意；
 * - 换行转成 `\N`（ASS 软换行），否则会被当成事件结束、破坏整行解析。
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\r\n?/g, '\\N')
    .replace(/\n/g, '\\N')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
}

export interface AssStyle {
  /** 视频宽度（ASS PlayResX，设计画布按视频分辨率走） */
  width: number
  /** 视频高度（ASS PlayResY；字号按它等比换算） */
  height: number
  /** 字体族名（内置字体走系统 DirectWrite；导入字体配合 fontsDir 使用） */
  fontName: string
  /** 字号（调用方已按视频高度换算后的值） */
  fontSize: number
}

/** 生成一份烧录用 ASS（V4+，白字黑边，底部居中） */
export function buildAss(cues: BurnCue[], style: AssStyle): string {
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(style.width)}`,
    `PlayResY: ${Math.round(style.height)}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.fontName},${Math.round(style.fontSize)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  for (const cue of cues) {
    const text = escapeAssText(cue.text).trim()
    if (!text) continue
    const start = Math.max(0, cue.start)
    // 至少显示 0.05s，避免被 libass 当成无效事件丢掉
    const end = Math.max(start + 0.05, cue.end)
    lines.push(`Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * 转义滤镜参数里的路径。
 * ffmpeg 滤镜参数用冒号分项、单引号包裹值，
 * 所以盘符冒号要加反斜杠、路径分隔符换成斜杠、单引号本身也要转义。
 */
export function escapeFilterPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
}

/**
 * subtitles 滤镜字符串。
 * fontsDir 传入时会把该目录注册给 libass（导入字体场景）；留空走系统字体。
 */
export function subtitlesFilter(assPath: string, fontsDir?: string): string {
  let filter = `subtitles=filename='${escapeFilterPath(assPath)}'`
  if (fontsDir) filter += `:fontsdir='${escapeFilterPath(fontsDir)}'`
  return filter
}
