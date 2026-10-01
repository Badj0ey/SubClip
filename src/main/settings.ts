/**
 * 应用设置持久化（userData/settings.json）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/types'
import {
  APP_DATA_DIR,
  DEFAULT_PORT
} from '@shared/constants'
import { normalizeShortcuts } from '@shared/shortcuts'
import { DEFAULT_NAME_TEMPLATE } from '@shared/naming'

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    fontSize: 15,
    fontFamily: '',
    lineHeight: 1.7,
    treePaneWidth: 290,
    taskPaneWidth: 380,
    shortcuts: normalizeShortcuts(undefined),
    readLine: true,
    sliceQuality: 80,
    sliceConcurrency: 3,
    sliceNameTemplate: DEFAULT_NAME_TEMPLATE,
    ffmpegPath: '',
    sliceOutputDir: '',
    subtitleCacheDir: join(app.getPath('userData'), APP_DATA_DIR, 'docs'),
    // 外部工具目录默认留空：本地切片与字幕获取都已内置，这类目录只在需要
    // 「导出表格给外部浏览器插件」时才有意义，由用户按需指定。
    sliceToolDir: '',
    outputDir: join(app.getPath('documents'), 'subtitle-clips'),
    port: DEFAULT_PORT,
    bridgeToken: '',
    biliCookie: ''
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * 修正字幕缓存目录。
 *
 * 早期版本把字幕正文放在 `<userData>/cache`，而那个目录会被 Chromium 当成自己的
 * 磁盘缓存接管并清空 —— 表现为「关掉再打开，字幕就没了」。
 * 这里把历史遗留的错误路径统一纠正到 APP_DATA_DIR 下。
 */
export function sanitizeCacheDir(dir: string | undefined): string {
  const fallback = join(app.getPath('userData'), APP_DATA_DIR, 'docs')
  const value = (dir ?? '').trim()
  if (!value) return fallback
  if (/(^|[\\/])cache$/i.test(value)) return fallback
  return value
}

export function loadSettings(): AppSettings {
  const base = defaultSettings()
  const p = settingsPath()
  if (!existsSync(p)) return base
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AppSettings>
    return {
      ...base,
      ...raw,
      // 快捷键在版本升级后可能缺项，始终补齐
      shortcuts: normalizeShortcuts(raw.shortcuts),
      subtitleCacheDir: sanitizeCacheDir(raw.subtitleCacheDir)
    }
  } catch {
    return base
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch }
  const p = settingsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
