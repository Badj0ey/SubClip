<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppSettings } from '@shared/types'
import { FFMPEG_DOWNLOAD_URL, QUALITY_OPTIONS } from '@shared/constants'
import { BRIDGE_PROTOCOL_VERSION } from '@shared/bridge'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  eventToBinding,
  findConflicts,
  formatBinding,
  normalizeShortcuts,
  type ShortcutAction
} from '@shared/shortcuts'
import {
  applyReadingStyle,
  applyTheme,
  loadBridgeStatus,
  loadTree,
  openSliceOutput,
  refreshSliceCheck,
  restartBridge,
  state,
  toast
} from '../store'
import { useSemanticStore } from '../stores/semantic'
import { useAiStore } from '../stores/ai'

import { DEFAULT_NAME_TEMPLATE } from '@shared/naming'

/** 重新拉一次统计（备份恢复 / 清空数据后用） */
async function refreshStats(): Promise<void> {
  stats.value = await window.api.getStats()
}

function onNameTemplate(e: Event): void {
  void save({ sliceNameTemplate: (e.target as HTMLInputElement).value })
}

/** 切换模型下载源 */
function onEmbedHost(e: Event): void {
  void save({ embedHost: (e.target as HTMLSelectElement).value })
}

/* ------------------------------ AI 能力层（第六阶段） ----------------------------- */
const ai = useAiStore()

/** 切换后端后立刻探测一次，用户马上知道通不通 */
async function onAiProvider(e: Event): Promise<void> {
  const value = (e.target as HTMLSelectElement).value as AppSettings['aiProvider']
  await save({ aiProvider: value })
  await ai.probe()
}

async function probeAiNow(): Promise<void> {
  await ai.probe()
  if (ai.ready) toast(ai.statusText, 'success', 4600)
  else if (ai.enabled) toast(ai.status.message || '连接失败', 'error', 6000)
}

function resetNameTemplate(): void {
  void save({ sliceNameTemplate: DEFAULT_NAME_TEMPLATE })
}

const env = ref<Record<string, { path: string; exists: boolean }> | null>(null)
const login = ref<{ loggedIn: boolean; name?: string }>({ loggedIn: false })
const stats = ref<{
  uploaders: number
  collections: number
  videos: number
  docs: number
  clips: number
  missingCues: number
  dataDir: string
}>({
  uploaders: 0,
  collections: 0,
  videos: 0,
  docs: 0,
  clips: 0,
  missingCues: 0,
  dataDir: ''
})
const cookieDraft = ref('')
const checking = ref(false)
const userscript = ref<{ path: string; exists: boolean; content: string } | null>(null)

/* ------------------------------ 语义检索状态 ------------------------------ */
const semantic = useSemanticStore()

async function refreshSemantic(): Promise<void> {
  await semantic.refresh()
  await semantic.loadModelPath()
}

const FONTS = [
  { value: '', label: '系统默认' },
  { value: "'Microsoft YaHei', sans-serif", label: '微软雅黑' },
  { value: "'PingFang SC', sans-serif", label: '苹方' },
  { value: "'Source Han Sans SC', 'Noto Sans SC', sans-serif", label: '思源黑体' },
  { value: "'SimSun', serif", label: '宋体' },
  { value: "'KaiTi', serif", label: '楷体' },
  { value: "'Consolas', 'Courier New', monospace", label: '等宽' }
]

onMounted(async () => {
  env.value = await window.api.checkEnv()
  stats.value = await window.api.getStats()
  // 不回显已保存的凭证，只在用户主动填写时才提交
  cookieDraft.value = ''
  login.value = await window.api.loginStatus()
  userscript.value = await window.api.userscript()
  await refreshSemantic()
  await ai.probe()
  await loadBridgeStatus()
})

async function save(patch: Partial<AppSettings>): Promise<void> {
  state.settings = await window.api.saveSettings(patch)
  applyTheme(state.settings.theme)
  applyReadingStyle()
}

async function pickDir(field: keyof AppSettings): Promise<void> {
  const current = state.settings?.[field]
  const dir = await window.api.pickDir(typeof current === 'string' ? current : '')
  if (!dir) return
  await save({ [field]: dir } as Partial<AppSettings>)
  env.value = await window.api.checkEnv()
  toast('路径已更新', 'success')
}

/** 只检测当前登录态，不改动已保存的凭证 */
async function checkLoginStatus(): Promise<void> {
  checking.value = true
  try {
    login.value = await window.api.loginStatus()
    if (login.value.loggedIn) {
      toast(`已登录${login.value.name ? `：${login.value.name}` : ''}`, 'success')
    } else {
      toast('未检测到有效登录态', 'error', 4200)
    }
  } finally {
    checking.value = false
  }
}

/** 保存手动填写的 Cookie 并检测 */
async function saveCookie(): Promise<void> {
  const value = cookieDraft.value.trim()
  if (!value) return
  checking.value = true
  try {
    await save({ biliCookie: value })
    cookieDraft.value = ''
    login.value = await window.api.loginStatus()
    if (login.value.loggedIn) {
      toast(`已保存并登录${login.value.name ? `：${login.value.name}` : ''}`, 'success')
    } else {
      toast('已保存，但未检测到登录态，请检查 Cookie 是否正确', 'error', 4800)
    }
  } finally {
    checking.value = false
  }
}

function onFontSize(e: Event): void {
  void save({ fontSize: Number((e.target as HTMLInputElement).value) })
}

function onLineHeight(e: Event): void {
  void save({ lineHeight: Number((e.target as HTMLInputElement).value) })
}

function onFontFamily(e: Event): void {
  void save({ fontFamily: (e.target as HTMLSelectElement).value })
}

function onTheme(e: Event): void {
  void save({ theme: (e.target as HTMLSelectElement).value as AppSettings['theme'] })
}

function onReadLine(e: Event): void {
  void save({ readLine: (e.target as HTMLInputElement).checked })
}

async function onPort(e: Event): Promise<void> {
  const port = Number((e.target as HTMLInputElement).value) || 8765
  await save({ port })
  await restartBridge(port)
}

/** 生成一个随机配对令牌（用 Web Crypto，避免引入额外依赖 + 不用 Math.random） */async function generateBridgeToken(): Promise<void> {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  await save({ bridgeToken: token })
  toast('已生成配对令牌，请在 B 站左下角浮框的「连接设置」里填入同样的值', 'success', 5600)
}

async function clearBridgeToken(): Promise<void> {
  await save({ bridgeToken: '' })
  toast('已清除配对令牌（恢复为只做来源校验）', 'success')
}

async function onRestartBridge(): Promise<void> {
  await restartBridge(state.settings?.port)
}

/* --------------------------------- 本地切片 -------------------------------- */

async function pickFfmpeg(): Promise<void> {
  const file = await window.api.pickFfmpeg()
  if (!file) return
  await save({ ffmpegPath: file })
  await refreshSliceCheck()
  toast(
    state.ffmpegReady ? 'ffmpeg 已就绪，可以本地切片了' : '该文件无法执行，请重新选择',
    state.ffmpegReady ? 'success' : 'error',
    4200
  )
}

async function recheckFfmpeg(): Promise<void> {
  await refreshSliceCheck()
  toast(state.ffmpegReady ? '已检测到 ffmpeg' : '仍未检测到 ffmpeg', state.ffmpegReady ? 'success' : 'error')
}

function onSliceQuality(e: Event): void {
  void save({ sliceQuality: Number((e.target as HTMLSelectElement).value) })
}

function onSliceConcurrency(e: Event): void {
  void save({ sliceConcurrency: Number((e.target as HTMLInputElement).value) })
}

async function openFfmpegDownload(): Promise<void> {
  await window.api.openExternal(FFMPEG_DOWNLOAD_URL)
}

async function openUserscriptFolder(): Promise<void> {
  const file = userscript.value?.path
  if (!file) return
  await window.api.showItem(file)
}

async function copyUserscript(): Promise<void> {
  const content = userscript.value?.content
  if (!content) {
    toast('读取用户脚本失败，请打开所在文件夹手动复制', 'error', 4200)
    return
  }
  const ok = await window.api.copyText(content)
  toast(ok ? '脚本已复制，去篡改猴「添加新脚本」粘贴保存' : '复制失败', ok ? 'success' : 'error', 4200)
}

async function openTampermonkey(): Promise<void> {
  await window.api.openExternal('https://www.tampermonkey.net/')
}

const lastEventText = computed(() => {
  const e = state.bridge?.lastEvent
  if (!e) return ''
  return `${new Date(e.at).toLocaleTimeString()} · ${e.text}`
})

const connectedClients = computed(() => state.bridge?.clients ?? [])
const pluginOnline = computed(() => connectedClients.value.length > 0)

/**
 * 能力名字 → 中文说明（第七阶段）。
 *
 * 为什么要展示：v5 的协商结果（协议版本 + 能力表）如果不显示出来，用户遇到
 * 「插件连上了但某个功能没反应」时完全没有线索 —— 而这正是引入能力表的初衷。
 */
const CAP_LABELS: Record<string, string> = {
  pageInfo: '页面识别',
  subtitle: '字幕推送',
  cookies: '登录同步',
  pullRequest: '请求拉取',
  requestSubtitles: '抓取分P'
}

function capLabel(cap: string): string {
  return CAP_LABELS[cap] ?? cap
}

/** 每个连接的协商摘要：协议版本是否达标 + 支持哪些能力 */
const clientDetails = computed(() =>
  connectedClients.value.map((c) => {
    const caps = Object.entries(c.caps ?? {})
      .filter(([, on]) => on)
      .map(([name]) => capLabel(name))
    return {
      id: c.id,
      browser: c.browser,
      version: c.version,
      protocol: c.protocol ?? 1,
      /** 协议版本落后桌面端的连接（功能可能不全） */
      outdated: (c.protocol ?? 1) < BRIDGE_PROTOCOL_VERSION,
      /** 没声明能力表 = v4 及更早的老插件 */
      legacy: Object.keys(c.caps ?? {}).length === 0,
      caps
    }
  })
)

/** 是否有插件协议版本落后（用于给一条汇总提示） */
const hasOutdatedClient = computed(() => clientDetails.value.some((c) => c.outdated))


/* --------------------------------- 快捷键 --------------------------------- */

const recording = ref<ShortcutAction | null>(null)

const shortcutMap = computed(() => state.settings?.shortcuts ?? DEFAULT_SHORTCUTS)
const conflicts = computed(() => findConflicts(shortcutMap.value))
const conflictIds = computed(() => new Set(conflicts.value.flat()))
const conflictText = computed(() =>
  conflicts.value
    .map((group) =>
      group.map((id) => SHORTCUT_DEFS.find((d) => d.id === id)?.label ?? id).join(' / ')
    )
    .join('；')
)

function stopRecord(): void {
  recording.value = null
  window.removeEventListener('keydown', captureKey, true)
}

function captureKey(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    stopRecord()
    return
  }
  const binding = eventToBinding(e)
  if (!binding) return
  const id = recording.value
  if (!id) return
  void saveShortcut(id, binding)
  stopRecord()
}

function startRecord(id: ShortcutAction): void {
  if (recording.value === id) {
    stopRecord()
    return
  }
  stopRecord()
  recording.value = id
  window.addEventListener('keydown', captureKey, true)
}

async function saveShortcut(id: ShortcutAction, binding: string): Promise<void> {
  if (!state.settings) return
  const next = { ...shortcutMap.value, [id]: binding }
  state.settings = await window.api.saveSettings({ shortcuts: next })
}

async function resetOne(id: ShortcutAction): Promise<void> {
  stopRecord()
  await saveShortcut(id, DEFAULT_SHORTCUTS[id])
}

async function resetAllShortcuts(): Promise<void> {
  stopRecord()
  state.settings = await window.api.saveSettings({ shortcuts: normalizeShortcuts(undefined) })
  toast('快捷键已恢复默认', 'success')
}

onUnmounted(stopRecord)

async function openDataDir(): Promise<void> {
  const dir = stats.value.dataDir
  if (!dir) {
    toast('数据目录尚未初始化', 'error')
    return
  }
  const err = await window.api.openPath(dir)
  if (err) toast(err, 'error', 4200)
}

/* -------------------------------- 数据管理 -------------------------------- */

async function doBackup(): Promise<void> {
  const res = await window.api.backupData()
  if (!res.ok || !res.data) {
    if (res.message !== '已取消') toast(res.message || '备份失败', 'error', 4600)
    return
  }
  toast(`已备份到：${res.data.path}`, 'success', 6000)
}

async function doRestore(): Promise<void> {
  const res = await window.api.restoreData()
  if (!res.ok || !res.data) {
    if (res.message !== '已取消') toast(res.message || '恢复失败', 'error', 6000)
    return
  }
  await refreshStats()
  toast(`已从备份恢复。原数据已留档：${res.data.backup}`, 'success', 7000)
}

async function doDiagnostics(): Promise<void> {
  const res = await window.api.exportDiagnostics()
  if (!res.ok || !res.data) {
    if (res.message !== '已取消') toast(res.message || '导出失败', 'error', 4600)
    return
  }
  toast(`已导出诊断信息：${res.data.path}`, 'success', 6000)
}

async function doClearAll(): Promise<void> {
  const res = await window.api.clearAllData()
  if (!res.ok || !res.data) {
    if (res.message !== '已取消') toast(res.message || '清空失败', 'error')
    return
  }
  await refreshStats()
  await loadTree()
  toast(`已清空数据（${res.data.cleared} 条记录）`, 'success', 4600)
}

async function openOutputDir(): Promise<void> {
  const dir = state.settings?.outputDir ?? ''
  if (!dir) {
    toast('尚未设置输出目录', 'error')
    return
  }
  const err = await window.api.openPath(dir)
  if (err) toast(err, 'error', 4200)
}
</script>

<template>
  <section class="pane" style="flex: 1 1 auto">
    <div class="pane-head">
      <strong style="font-size: 13px">设置</strong>
    </div>

    <div class="settings">
      <!-- 字幕显示 -->
      <h2>字幕显示</h2>
      <div class="field">
        <label>字体大小</label>
        <div class="row">
          <input
            :value="state.settings?.fontSize"
            type="range"
            min="11"
            max="30"
            step="1"
            style="width: 220px"
            @input="onFontSize"
          />
          <span class="muted">{{ state.settings?.fontSize }} px</span>
        </div>
      </div>
      <div class="field">
        <label>字体</label>
        <div class="row">
          <select
            :value="state.settings?.fontFamily"
            class="select grow"
            @change="onFontFamily"
          >
            <option v-for="f in FONTS" :key="f.label" :value="f.value">{{ f.label }}</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>行距</label>
        <div class="row">
          <input
            :value="state.settings?.lineHeight"
            type="range"
            min="1.2"
            max="2.6"
            step="0.1"
            style="width: 220px"
            @input="onLineHeight"
          />
          <span class="muted">{{ state.settings?.lineHeight }}</span>
        </div>
      </div>
      <div class="field">
        <label>主题</label>
        <div class="row">
          <select
            :value="state.settings?.theme"
            class="select"
            @change="onTheme"
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>阅读条</label>
        <div class="row">
          <label class="switch">
            <input
              type="checkbox"
              :checked="state.settings?.readLine !== false"
              @change="onReadLine"
            />
            <span>滚动时把屏幕偏上位置的那条字幕放大突出，便于跟读</span>
          </label>
        </div>
      </div>

      <!-- 快捷键 -->
      <h2>
        快捷键
        <button class="btn sm" style="float: right; font-weight: 400" @click="resetAllShortcuts">
          恢复全部默认
        </button>
      </h2>

      <div v-if="conflicts.length" class="hint warn-hint">
        ⚠ 检测到快捷键冲突：{{ conflictText }}
      </div>

      <div v-for="def in SHORTCUT_DEFS" :key="def.id" class="field">
        <label>{{ def.label }}</label>
        <div class="row">
          <button
            class="btn shortcut-key"
            :class="{ recording: recording === def.id, conflict: conflictIds.has(def.id) }"
            @click="startRecord(def.id)"
          >
            {{ recording === def.id ? '按下按键…' : formatBinding(shortcutMap[def.id]) }}
          </button>
          <button
            class="btn sm"
            :disabled="shortcutMap[def.id] === DEFAULT_SHORTCUTS[def.id]"
            @click="resetOne(def.id)"
          >
            重置
          </button>
          <span class="muted">{{ def.description }}</span>
        </div>
      </div>
      <div class="hint">
        点击按键按钮后按下新的组合键即可修改，按 Esc 取消录制。
        提示：Shift + 单击字幕行可连续选择一段。
      </div>

      <!-- 路径设置 -->
      <h2>路径设置</h2>
      <div class="field">
        <label>旧版字幕正文目录</label>
        <div class="row">
          <input :value="state.settings?.subtitleCacheDir" class="input grow" readonly />
          <button class="btn" @click="pickDir('subtitleCacheDir')">选择…</button>
        </div>
      </div>
      <div class="hint">
        仅用于迁移：新版已把字幕正文存进数据库，这里指的是旧版本放 <code>&lt;docId&gt;.json</code> 的位置。
        首次启动会自动从这里导入，导入完成后就不再使用；留空则用默认位置。
      </div>
      <div class="field">
        <label>外部切片工具目录</label>
        <div class="row">
          <input
            :value="state.settings?.sliceToolDir"
            class="input grow"
            readonly
            placeholder="可选，未设置"
          />
          <button class="btn" @click="pickDir('sliceToolDir')">选择…</button>
        </div>
      </div>
      <div class="hint">
        <template v-if="!state.settings?.sliceToolDir">
          未设置（可选）。本地切片已内置，只有走「导出表格 → 手动导入 Edge 扩展」这条旧路径时才需要填。
        </template>
        <span
          v-else
          :style="{ color: env?.sliceToolDir?.exists ? 'var(--success)' : 'var(--danger)' }"
        >
          {{ env?.sliceToolDir?.exists ? '✓ 目录存在' : '✗ 目录不存在' }}
        </span>
      </div>
      <div class="field">
        <label>切片表输出目录</label>
        <div class="row">
          <input :value="state.settings?.outputDir" class="input grow" readonly />
          <button class="btn" @click="pickDir('outputDir')">选择…</button>
          <button class="btn" @click="openOutputDir">打开</button>
        </div>
      </div>

      <!-- 本地切片 -->
      <h2>
        本地切片
        <button class="btn sm" style="font-weight: 400" @click="openFfmpegDownload">
          获取 ffmpeg
        </button>
      </h2>

      <div class="field">
        <label>ffmpeg</label>
        <div class="row">
          <span :style="{ color: state.ffmpegReady ? 'var(--success)' : 'var(--danger)' }">
            {{ state.ffmpegReady ? '✓ 已就绪' : '✗ 未找到' }}
          </span>
          <input
            :value="state.ffmpegPath"
            class="input grow"
            readonly
            placeholder="未检测到，请手动指定"
          />
          <button class="btn" @click="pickFfmpeg">选择…</button>
          <button class="btn" @click="recheckFfmpeg">重新检测</button>
        </div>
      </div>
      <div class="hint">
        本地切片需要 ffmpeg。若系统未安装，可点右上角「获取 ffmpeg」下载，解压后把
        <code>bin\ffmpeg.exe</code> 的路径填到上面。
      </div>

      <!-- ------------------------------ 语义检索 ------------------------------ -->
      <h2 class="sec">语义检索（按意思搜）</h2>
      <div class="hint" style="margin-top: -4px">
        全文检索找的是「字面」，语义检索找的是「意思」：搜「怎么把长视频切成短视频」
        也能命中完全不含这几个字的段落。它需要本地模型（约 95MB，只需下一次）与一次建索引，
        <b>不影响</b>普通检索。
      </div>

      <div class="field">
        <label>模型</label>
        <div class="row">
          <span :style="{ color: semantic.status.modelReady ? 'var(--success)' : 'var(--text-dim)' }">
            {{ semantic.status.modelReady ? `✓ 已下载（${semantic.status.modelSizeMb}MB）` : '✗ 未下载' }}
          </span>
          <input :value="state.settings?.embedModel" class="input grow" readonly />
          <button
            class="btn primary"
            :disabled="semantic.status.busy === 'downloading'"
            @click="semantic.downloadModel()"
          >
            {{ semantic.status.busy === 'downloading' ? '下载中…' : '下载模型' }}
          </button>
          <button
            class="btn"
            :disabled="!semantic.status.modelReady"
            @click="semantic.deleteModel()"
          >
            删除
          </button>
        </div>
      </div>

      <div v-if="semantic.status.message" class="hint" style="margin-top: -2px">
        {{ semantic.status.message }}
      </div>

      <div class="field">
        <label>索引</label>
        <div class="row">
          <span class="muted">
            {{ semantic.status.indexedChunks }} / {{ semantic.status.totalChunks }} 段已索引
            <template v-if="semantic.status.totalChunks">（{{ semantic.progress }}%）</template>
          </span>
          <button
            class="btn primary"
            :disabled="!semantic.status.modelReady || semantic.status.indexing"
            @click="semantic.startIndex()"
          >
            开始 / 继续建索引
          </button>
          <button class="btn" :disabled="!semantic.status.indexing" @click="semantic.stopIndex()">
            暂停
          </button>
          <button class="btn danger" :disabled="!semantic.status.indexedChunks" @click="semantic.clearIndex()">
            清空索引
          </button>
        </div>
      </div>

      <div class="field">
        <label>下载源</label>
        <div class="row">
          <select :value="state.settings?.embedHost" class="select" @change="onEmbedHost">
            <option value="https://hf-mirror.com">hf-mirror.com（国内推荐）</option>
            <option value="https://huggingface.co">huggingface.co（官方）</option>
          </select>
          <label class="row" style="gap: 4px; margin-left: 8px">
            <input
              type="checkbox"
              :checked="state.settings?.embedInsecureTls"
              @change="save({ embedInsecureTls: ($event.target as HTMLInputElement).checked })"
            />
            放宽 TLS 校验
          </label>
        </div>
      </div>
      <div class="hint">
        本机直连 <code>huggingface.co</code> 会因证书链不全会失败，所以默认走镜像。
        镜像的大文件还会 302 到另一个域名，那个域名的证书同样校验不过 ——
        <b>只有打开「放宽 TLS 校验」才下得下来</b>（只影响模型下载这一条连接，不影响其它网络请求）。
        不想放宽的话，也可以手动把模型文件按目录结构放到下面这个路径：
        <br />
        <code>{{ semantic.modelPath }}</code>
        <br />
        需要放：<code>config.json</code>、<code>tokenizer.json</code>、<code>tokenizer_config.json</code>、
        <code>special_tokens_map.json</code>、<code>vocab.txt</code>、<code>onnx/model_quantized.onnx</code>
      </div>

      <!-- ------------------------------- AI 能力层 ------------------------------- -->
      <h2 class="sec">AI 能力层</h2>
      <div class="hint" style="margin-top: -4px">
        AI 是<b>增强功能</b>：默认关闭，关掉时字幕、检索、切片全部照常工作。
        结果只存在本地数据库（<code>analysis</code> 表），不会自动上传；用云端接口时字幕内容会发给你配置的服务。
      </div>

      <div class="field">
        <label>后端</label>
        <div class="row">
          <select :value="state.settings?.aiProvider" class="select" @change="onAiProvider">
            <option value="off">不用 AI（默认）</option>
            <option value="ollama">本地 Ollama（隐私好、免费）</option>
            <option value="openai">OpenAI 兼容接口（云端）</option>
          </select>
          <button class="btn" :disabled="ai.probing" @click="probeAiNow">
            {{ ai.probing ? '检测中…' : '测试连接' }}
          </button>
          <span :style="{ color: ai.ready ? 'var(--success)' : 'var(--text-dim)' }">
            {{ ai.statusText }}
          </span>
        </div>
      </div>

      <!-- Ollama -->
      <template v-if="state.settings?.aiProvider === 'ollama'">
        <div class="field">
          <label>Ollama 地址</label>
          <div class="row">
            <input
              :value="state.settings?.aiOllamaUrl"
              class="input grow"
              spellcheck="false"
              @change="save({ aiOllamaUrl: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>
        <div class="field">
          <label>模型</label>
          <div class="row">
            <input
              :value="state.settings?.aiOllamaModel"
              class="input grow"
              spellcheck="false"
              list="ollama-models"
              @change="save({ aiOllamaModel: ($event.target as HTMLInputElement).value })"
            />
            <datalist id="ollama-models">
              <option v-for="m in ai.status.models" :key="m" :value="m" />
            </datalist>
          </div>
        </div>
        <div class="hint">
          没装 Ollama？到 <code>ollama.com</code> 下载后执行 <code>ollama pull qwen2.5:7b</code>
          （中文场景推荐 qwen 系列；7B 在 16GB 内存的机器上可跑）。
        </div>
      </template>

      <!-- OpenAI 兼容 -->
      <template v-if="state.settings?.aiProvider === 'openai'">
        <div class="field">
          <label>Base URL</label>
          <div class="row">
            <input
              :value="state.settings?.aiOpenaiUrl"
              class="input grow"
              spellcheck="false"
              placeholder="https://api.openai.com/v1"
              @change="save({ aiOpenaiUrl: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>
        <div class="field">
          <label>API Key</label>
          <div class="row">
            <input
              :value="state.settings?.aiOpenaiKey"
              class="input grow"
              type="password"
              spellcheck="false"
              placeholder="sk-..."
              @change="save({ aiOpenaiKey: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>
        <div class="field">
          <label>模型</label>
          <div class="row">
            <input
              :value="state.settings?.aiOpenaiModel"
              class="input grow"
              spellcheck="false"
              list="cloud-models"
              @change="save({ aiOpenaiModel: ($event.target as HTMLInputElement).value })"
            />
            <datalist id="cloud-models">
              <option v-for="m in ai.status.models.slice(0, 100)" :key="m" :value="m" />
            </datalist>
          </div>
        </div>
        <div class="hint">
          兼容任何 OpenAI 协议的服务：OpenAI、DeepSeek、智谱、通义、vLLM、LM Studio…
          填它们的 base URL（一般以 <code>/v1</code> 结尾）与 Key 即可。API Key 只存在本机设置文件里，
          <b>不会</b>出现在导出的诊断信息中。
        </div>
      </template>

      <div v-if="state.settings?.aiProvider !== 'off'" class="field">
        <label>生成温度</label>
        <div class="row">
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            :value="state.settings?.aiTemperature"
            style="width: 180px"
            @change="save({ aiTemperature: Number(($event.target as HTMLInputElement).value) })"
          />
          <span class="muted">{{ state.settings?.aiTemperature }}（越低越稳定，摘要 / 标签建议 0.2~0.4 合适）</span>
        </div>
      </div>

      <div class="field">
        <label>切片画质</label>
        <div class="row">
          <select
            :value="state.settings?.sliceQuality"
            class="select"
            @change="onSliceQuality"
          >
            <option v-for="q in QUALITY_OPTIONS" :key="q.value" :value="q.value">
              {{ q.label }}
            </option>
          </select>
          <span class="muted">实际清晰度受账号权限限制，会自动降级</span>
        </div>
      </div>

      <div class="field">
        <label>下载并发数</label>
        <div class="row">
          <input
            :value="state.settings?.sliceConcurrency"
            type="range"
            min="1"
            max="8"
            step="1"
            style="width: 200px"
            @input="onSliceConcurrency"
          />
          <span class="muted">{{ state.settings?.sliceConcurrency }}</span>
        </div>
      </div>

      <div class="field">
        <label>任务命名模板</label>
        <div class="row">
          <input
            :value="state.settings?.sliceNameTemplate"
            class="input grow"
            spellcheck="false"
            placeholder="{prefix}_{index}"
            @change="onNameTemplate"
          />
          <button class="btn sm" @click="resetNameTemplate">恢复默认</button>
        </div>
      </div>
      <div class="hint">
        备注字段就是切片输出的文件名。可用占位符：
        <code>{prefix}</code> 前缀（默认视频标题）、<code>{index}</code> 序号、
        <code>{bvid}</code>、<code>{page}</code> 分P、
        <code>{start}</code> / <code>{end}</code> 时间戳（如 <code>00-01-20</code>）、
        <code>{duration}</code> 时长（如 <code>1m20s</code>）、<code>{title}</code> 视频标题。
        例：<code>{index}_{title}_{duration}</code>。
      </div>

      <div class="field">
        <label>切片输出目录</label>
        <div class="row">
          <input
            :value="state.settings?.sliceOutputDir"
            class="input grow"
            readonly
            placeholder="默认使用切片表输出目录"
          />
          <button class="btn" @click="pickDir('sliceOutputDir')">选择…</button>
          <button class="btn" @click="openSliceOutput">打开</button>
        </div>
      </div>

      <!-- 浏览器用户脚本通信 -->
      <h2>浏览器用户脚本通信</h2>
      <div class="field">
        <label>本地端口</label>
        <div class="row">
          <input
            :value="state.settings?.port"
            class="input"
            type="number"
            style="width: 120px"
            @change="onPort"
          />
          <button class="btn" @click="onRestartBridge">重启服务</button>
          <span class="muted">仅监听 127.0.0.1，用户脚本通过该端口连接</span>
        </div>
      </div>

      <div class="field">
        <label>服务状态</label>
        <div class="row">
          <span
            :style="{ color: state.bridge?.running ? 'var(--success)' : 'var(--danger)' }"
          >
            {{ state.bridge?.running ? `✓ 运行中 · ws://127.0.0.1:${state.bridge.port}` : '✗ 未运行' }}
          </span>
        </div>
      </div>

      <div v-if="state.bridge?.error" class="hint" style="color: var(--danger)">
        {{ state.bridge.error }}
      </div>

      <div class="field">
        <label>配对令牌</label>
        <div class="row">
          <input
            :value="state.settings?.bridgeToken"
            class="input grow"
            spellcheck="false"
            placeholder="可选，留空表示只做来源校验"
          />
          <button class="btn" @click="generateBridgeToken">生成</button>
          <button class="btn" @click="clearBridgeToken">清除</button>
        </div>
      </div>
      <div class="hint">
        本地服务只放行 B 站页面来源（<code>https://*.bilibili.com</code>），普通网页连不进来。
        若还想防本机其它程序伪造来源，可在这里生成一个随机令牌，并在左下角浮框的「连接设置」里填同样的值。
      </div>

      <div class="field" style="align-items: flex-start">
        <label style="padding-top: 6px">用户脚本连接</label>
        <div class="col grow">
          <div v-if="!connectedClients.length" class="muted">暂无用户脚本连接</div>
          <template v-else>
            <div v-for="c in clientDetails" :key="c.id" class="client-row">
              <span :style="{ color: 'var(--success)' }">
                ✓ {{ c.browser }} v{{ c.version }}
              </span>
              <span
                class="proto-chip"
                :class="{ warn: c.outdated }"
                :title="
                  c.legacy
                    ? 'v4 及更早的用户脚本不带能力表，桌面端按「老客户端」放行（功能不受影响）'
                    : `协议 v${c.protocol}（桌面端 v${BRIDGE_PROTOCOL_VERSION}）`
                "
              >
                协议 v{{ c.protocol }}
              </span>
              <span v-if="c.legacy" class="muted" style="font-size: 12px">未声明能力（老版本）</span>
              <template v-else>
                <span v-if="!c.caps.length" class="muted" style="font-size: 12px">未声明任何能力</span>
                <span v-for="cap in c.caps" :key="cap" class="cap-chip">{{ cap }}</span>
              </template>
            </div>
            <div v-if="hasOutdatedClient" class="hint" style="margin-top: 4px">
              有用户脚本的协议版本低于桌面端（v{{ BRIDGE_PROTOCOL_VERSION }}），部分新功能可能不可用；
              到脚本管理器里点一次「检查更新」即可。
            </div>
          </template>
        </div>
      </div>

      <div v-if="lastEventText" class="hint">最近事件：{{ lastEventText }}</div>

      <div class="field">
        <label>用户脚本</label>
        <div class="row">
          <input :value="userscript?.path" class="input grow" readonly />
          <button class="btn" :disabled="!userscript?.exists" @click="openUserscriptFolder">
            打开所在文件夹
          </button>
          <button class="btn" :disabled="!userscript?.content" @click="copyUserscript">
            复制脚本
          </button>
        </div>
      </div>
      <div class="hint">
        安装：先装 <a href="https://www.tampermonkey.net/" @click.prevent="openTampermonkey">篡改猴（Tampermonkey）</a>，
        点上面的「复制脚本」→ 篡改猴「添加新脚本」→ 粘贴并保存；
        也可以直接打开脚本所在文件夹，把 <code>SubClip.user.js</code> 拖进浏览器。
        Chrome / Edge 142+ 首次连接会询问「本地网络访问」，请在弹窗里允许；没弹窗就点左下角浮框的「待授权」重试。
      </div>

      <!-- 账号 -->
      <h2>B站账号</h2>

      <div class="field">
        <label>登录状态</label>
        <div class="row">
          <span :style="{ color: login.loggedIn ? 'var(--success)' : 'var(--danger)' }">
            {{ login.loggedIn ? `✓ 已登录${login.name ? `（${login.name}）` : ''}` : '✗ 未登录 / 未验证' }}
          </span>
          <button class="btn sm" :disabled="checking" @click="checkLoginStatus">
            {{ checking ? '检测中…' : '重新检测' }}
          </button>
        </div>
      </div>

      <div class="field" style="align-items: flex-start">
        <label style="padding-top: 6px">从用户脚本同步</label>
        <div class="row">
          <span class="muted" style="line-height: 1.8">
            <template v-if="pluginOnline">
              用户脚本已连接 —— 点 B 站左下角浮框里的「同步登录状态」即可，无需手动获取 Cookie。
            </template>
            <template v-else>
              用户脚本未连接。安装脚本后打开任意 B 站视频页，左下角会出现「剪」按钮；
              展开后点一次「同步登录状态」即可，免去手动配置 Cookie。
            </template>
          </span>
        </div>
      </div>

      <div class="field" style="align-items: flex-start">
        <label style="padding-top: 6px">手动填写 Cookie</label>
        <div class="row">
          <input
            v-model="cookieDraft"
            class="input grow"
            type="password"
            placeholder="留空表示不修改；也可只填 SESSDATA=xxxxx"
          />
          <button class="btn" :disabled="checking || !cookieDraft.trim()" @click="saveCookie">
            保存
          </button>
        </div>
      </div>
      <div class="hint">
        仅在不方便使用用户脚本时需要。在浏览器登录 bilibili.com 后，从开发者工具复制 Cookie 粘贴到此处。
      </div>

      <!-- 数据 -->
      <h2>数据</h2>
      <div class="field">
        <label>本地数据</label>
        <div class="row muted">
          UP主 {{ stats.uploaders ?? 0 }} · 合集 {{ stats.collections ?? 0 }} · 视频
          {{ stats.videos ?? 0 }} · 字幕 {{ stats.docs ?? 0 }} · 切片任务
          {{ stats.clips ?? 0 }}
        </div>
      </div>
      <div class="field">
        <label>数据目录</label>
        <div class="row">
          <input :value="stats.dataDir" class="input grow" readonly />
          <button class="btn" @click="openDataDir">打开</button>
        </div>
      </div>
      <div v-if="stats.missingCues" class="hint warn-hint">
        ⚠ 检测到 {{ stats.missingCues }} 条字幕正文缺失。
        这通常发生在旧版本（正文曾被放在会被浏览器清空的目录）。对相关视频重新拉取一次字幕即可恢复。
      </div>
      <div class="hint">
        所有数据都在本机，关闭软件不会丢失；每次改动都会立刻写入磁盘。
      </div>

      <div class="field">
        <label>备份与恢复</label>
        <div class="row">
          <button class="btn" @click="doBackup">备份数据库…</button>
          <button class="btn" @click="doRestore">从备份恢复…</button>
          <button class="btn" @click="doDiagnostics">导出诊断信息…</button>
        </div>
      </div>
      <div class="hint">
        备份会把整库导出成**单个** `.db` 文件（用 SQLite 的 VACUUM INTO，连未落盘的内容一起带上），
        换台机器拷过去就能用。恢复前会自动把当前库另存一份，恢复失败会自动回滚。
        诊断信息只含版本、路径、统计与配置项（**Cookie 与配对令牌只记录是否配置，不写内容**），
        报 bug 时附上它最有用。
      </div>

      <div class="field">
        <label>危险操作</label>
        <div class="row">
          <button class="btn danger" @click="doClearAll">清空全部数据</button>
          <span class="muted">删除所有视频、字幕与切片任务，需二次确认且不可撤销</span>
        </div>
      </div>

      <h2>关于切片流程</h2>
      <div class="muted" style="line-height: 2">
        1. 在本工具中选定字幕段 → 右侧「加入切片任务」。<br />
        2. 点击「导出 CSV / XLSX」，生成切片表（列：BV号 / 分P / 开始时间 / 结束时间 / 备注）。<br />
        3. 打开 Edge 扩展《B站表格批量切片下载器》，导入该表格并开始批量下载。
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * 插件连接列表（第七阶段）：把 v5 的能力协商结果显式展示出来。
 * 不显示的话，用户遇到「插件连上了但某功能没反应」时完全没有线索 ——
 * 而这正是引入能力表的初衷。
 */
.client-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
  padding: 2px 0;
}

.proto-chip,
.cap-chip {
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
  color: var(--text-dim);
  white-space: nowrap;
}

.proto-chip.warn {
  border-color: var(--danger);
  color: var(--danger);
}

.cap-chip {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

/* 让「插件连接」这一栏的右侧内容占满剩余宽度（.field 里 label 是固定宽） */
.field > .grow {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
