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
    /**
     * 切片时把字幕直接烧进画面（硬字幕）。
     * 需要重新编码（不再是无损复制），切片速度会明显变慢。
     */
    sliceBurnSubtitles: false,
    /** 烧录字体（内置字体族名，Windows 常见中文字体） */
    sliceSubtitleFont: 'Microsoft YaHei',
    /** 导入的字体文件名（存于 userData/fonts 下；留空表示用内置字体） */
    sliceSubtitleFontFile: '',
    /** 导入字体解析出的族名（写进 ASS Fontname） */
    sliceSubtitleFontFamily: '',
    /** 字幕字号（1080p 基准，按视频高度等比缩放） */
    sliceSubtitleFontSize: 54,
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
  if (!existsSync(p)) {
    // 全新安装：默认生成随机配对令牌并落盘。
    // 旧版本升级上来的用户设置文件已存在，保持原值不变（不破坏已配对的连接）。
    const fresh = { ...base, bridgeToken: randomUUID().replace(/-/g, '') }
    try {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(encodeSecrets(fresh), null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 写盘失败不阻塞启动：这次用内存值，下次 load 再重试
    }
    return fresh
  }
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
  // 渲染进程不可信（本项目的既定安全模型）：只接受已知键，
  // 并对 URL / 路径 / 端口这类高危字段做值校验，非法值直接丢弃（保持旧值）。
  const merged = { ...loadSettings(), ...sanitizePatch(patch) }
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

const SETTINGS_KEYS = new Set(Object.keys(defaultSettings()))

/**
 * 设置键白名单 + 高危字段值校验。
 *
 * - 未知键：丢弃（防止被攻陷的渲染进程往设置文件里塞任意内容）；
 * - port：1~65535 整数，否则丢弃（非法端口会被持久化，导致 bridge 停服）；
 * - URL 类：必须是 http(s)（防止 aiOpenaiUrl 被改指向攻击者服务器，API Key 外泄）；
 * - embedModel：拒绝 `..` / 反斜杠 / 盘符（它会被拼进缓存目录路径）。
 */
function sanitizePatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTINGS_KEYS.has(key)) continue
    if (key === 'port') {
      const p = Number(value)
      if (Number.isInteger(p) && p >= 1 && p <= 65535) out[key] = p
      continue
    }
    if (key === 'aiOpenaiUrl' || key === 'aiOllamaUrl' || key === 'embedHost') {
      const s = String(value ?? '').trim()
      if (/^https?:\/\//i.test(s)) out[key] = s
      continue
    }
    if (key === 'embedModel') {
      const s = String(value ?? '').trim()
      if (s && !s.includes('..') && !s.includes('\\') && !/^[A-Za-z]:/.test(s)) out[key] = s
      continue
    }
    out[key] = value
  }
  return out as Partial<AppSettings>
}
