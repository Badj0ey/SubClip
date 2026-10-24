/**
 * 应用设置持久化（userData/settings.json）。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
    /** 视频预览高度（中栏上下分割线上方的部分） */
    videoPaneHeight: 300,
    shortcuts: normalizeShortcuts(undefined),
    readLine: true,
    /** 视频预览：点击选中字幕时自动把播放器跳到那一刻（第二阶段） */
    videoAutoFollow: true,
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
    biliCookie: '',
    // 语义检索（第四阶段下半）。默认走国内可用的镜像：直连 huggingface.co 会因证书链不全失败
    embedModel: 'Xenova/bge-small-zh-v1.5',
    embedHost: 'https://hf-mirror.com',
    embedInsecureTls: false,
    embedWindowSeconds: 45,
    // AI 能力层（第六阶段）。**默认关闭**：基础功能不依赖 AI，这一点必须体现在默认值上
    aiProvider: 'off',
    aiOllamaUrl: 'http://127.0.0.1:11434',
    aiOllamaModel: 'qwen2.5:7b',
    aiOpenaiUrl: 'https://api.openai.com/v1',
    aiOpenaiKey: '',
    aiOpenaiModel: 'gpt-4o-mini',
    aiTemperature: 0.3,
    aiTimeoutSeconds: 60
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

const SECRET_KEYS = ['bridgeToken', 'biliCookie', 'aiOpenaiKey'] as const
const SECRET_PREFIX = 'safeStorage:v1:'

function decodeSecrets(raw: Partial<AppSettings>): Partial<AppSettings> {
  const result = { ...raw }
  for (const key of SECRET_KEYS) {
    const value = result[key]
    if (typeof value !== 'string' || !value.startsWith(SECRET_PREFIX)) continue
    try {
      result[key] = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'))
        : ''
    } catch {
      result[key] = ''
    }
  }
  return result
}

function encodeSecrets(settings: AppSettings): AppSettings {
  const result = { ...settings }
  if (!safeStorage.isEncryptionAvailable()) return result
  for (const key of SECRET_KEYS) {
    const value = result[key]
    if (typeof value === 'string' && value)
      result[key] = SECRET_PREFIX + safeStorage.encryptString(value).toString('base64')
  }
  return result
}

export function loadSettings(): AppSettings {
  const base = defaultSettings()
  const p = settingsPath()
  if (!existsSync(p)) return base
  try {
    const raw = decodeSecrets(JSON.parse(readFileSync(p, 'utf8')) as Partial<AppSettings>)
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
  const temp = `${p}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(encodeSecrets(merged), null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, p)
  } catch (err) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* 原设置文件保持不变 */ }
    throw err
  }
  return merged
}
