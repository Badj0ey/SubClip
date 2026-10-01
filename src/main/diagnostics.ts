/**
 * 诊断信息组装（纯函数，不依赖 Electron，便于单测）。
 *
 * 用户报 bug 时，光有一句「导不出字幕」没法查；带上版本、路径是否存在、统计与配置项就好定位。
 * 但这里必须**严格脱敏**：Cookie 与配对令牌只能体现「有没有配」，绝不能把内容写进文件
 * —— 诊断包是要发给别人的。
 */
import type { AppSettings } from '@shared/types'

export interface DiagnosticsInput {
  appVersion: string
  packaged: boolean
  versions: { electron: string; chrome: string; node: string }
  platform: { platform: string; arch: string; release: string }
  stats: unknown
  paths: Record<string, unknown>
  settings: AppSettings
  bridge: unknown
  recentPluginEvents: unknown
}

/** 需要脱敏的字段：只报告是否配置与长度，不写内容 */
const SECRET_KEYS = ['biliCookie', 'bridgeToken'] as const

export function redactSettings(settings: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings }
  for (const key of SECRET_KEYS) {
    const value = String(settings[key] ?? '')
    out[key] = value ? `（已配置，${value.length} 字符，内容已隐去）` : '（未配置）'
  }
  return out
}

export function buildDiagnostics(input: DiagnosticsInput): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    app: { version: input.appVersion, packaged: input.packaged },
    runtime: input.versions,
    system: input.platform,
    stats: input.stats,
    paths: input.paths,
    settings: redactSettings(input.settings),
    bridge: input.bridge,
    recentPluginEvents: input.recentPluginEvents
  }
}
