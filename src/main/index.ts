import { app, BrowserWindow, session, shell } from 'electron'
import { cpSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { APP_DATA_DIR } from '@shared/constants'
import { safeExternalUrl } from '@shared/externalUrl'
import { bridge } from './bridge'
import { closeDb, initDb, stats } from './db'
import { registerIpc } from './ipc'
import { loadSettings, saveSettings } from './settings'
import { closeAllSessions, installStreamHeaderBridge } from './media'
import { shutdownEmbed } from './embed/engine'
import { wireBridge } from './wire'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6fb',
    title: '字幕剪 SubClip',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // 启动自检：元数据在、正文文件缺失说明之前丢过数据，提醒用户重拉
    try {
      const s = stats()
      if (s.missingCues > 0) {
        mainWindow?.webContents.send('data:warning', {
          missing: s.missingCues,
          message: `检测到 ${s.missingCues} 条字幕正文缺失（早期版本把缓存放在了会被浏览器清空的目录）。相关视频重新拉取一次字幕即可恢复。`
        })
      }
    } catch {
      /* 自检失败不影响启动 */
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Never forward file:, javascript:, or custom protocols to the OS handler.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
    return { action: 'deny' }
  })

  // Renderer links must not replace our privileged application document.
  mainWindow.webContents.on('will-navigate', (event, legacyUrl) => {
    // Electron 36 exposes details.url; older signatures passed the URL separately.
    const target = (event as typeof event & { url?: string }).url ||
      (typeof legacyUrl === 'string' ? legacyUrl : '')
    if (target === mainWindow?.webContents.getURL()) return
    event.preventDefault()
    const safe = safeExternalUrl(target)
    if (safe) void shell.openExternal(safe)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 把主进程事件转发给所有渲染窗口 */
function push(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 老版本（更名前）的应用数据目录名 */
const LEGACY_USER_DATA = 'srt-clip-helper'
/** 更名前的业务数据子目录名 */
const LEGACY_APP_DATA = 'srt-tool-data'

/**
 * 更名迁移：把老版本的 userData 目录挪到新名字下。
 *
 * ## 为什么必须做
 *
 * Electron 的 `app.getPath('userData')` 由 `package.json` 的 `name` 决定。
 * 产品从 `srt-clip-helper` 改名为 `subclip` 后，userData 会指向一个**全新空目录** ——
 * 用户的素材库（数据库 762MB）、设置、已下载的 ffmpeg（100MB）与嵌入模型全都不见了。
 * 对用户来说这和「数据被删」没有区别。
 *
 * ## 为什么用 rename 而不是复制
 *
 * 老目录约 **1GB**（数据库 + ffmpeg + 模型）。复制既慢又占双份空间，
 * 而 rename 在同一分区上是**瞬时**的，语义上也正是「搬家」。
 *
 * ## 失败不阻断启动
 *
 * 迁移只是「尽力而为」：老目录不存在（首次安装 / 已经迁移过）、
 * 或跨分区 rename 失败（`EXDEV`）时都**不抛错**，让应用照常以新目录启动
 * —— 用户最多是重新导入一次素材，而不是打不开软件。
 */
function migrateLegacyUserData(): void {
  try {
    /**
     * 用**启动参数**判断用户是否显式指定了数据目录。
     *
     * 不能用「`userData` 目录是否存在」来判断：Electron 在 `whenReady` 之前
     * 就已经把 userData 目录建出来了，所以那个判断永远为真 ——
     * 第一版就是这么写的，结果迁移**从未执行**，应用以空库启动
     * （用户会以为素材库被清空了）。
     *
     * 只有用户/打包配置显式指定过才该跳过自动迁移。
     */
    const explicit = process.argv.some((a) => a.startsWith('--user-data-dir'))
    if (explicit) return

    const current = app.getPath('userData')
    const parent = dirname(current)
    const legacy = join(parent, LEGACY_USER_DATA)
    if (legacy === current) return
    // 老目录不存在 → 首次安装或已迁移过
    if (!existsSync(legacy)) return

    /**
     * 新目录里已经有**业务数据**时才认为「已迁移过」。
     *
     * 注意判据要用**数据库文件的实际大小**，不能用「目录是否存在」：
     * 首次以新名字启动时，应用会立刻建出一个**空库**，
     * 于是 `subclip-data` 目录存在但里面什么都没有 ——
     * 若按目录存在就跳过，就永远不会把真实数据搬过来
     * （第一版就是这么漏的，实测以空库启动）。
     */
    const newDb = join(current, APP_DATA_DIR, 'srt-tool.db')
    if (existsSync(newDb) && statSync(newDb).size > 1024 * 1024) return

    /**
     * 只搬**自己的数据**，不整体 rename userData 目录。
     *
     * 为什么不整体搬：Electron 在启动早期就往 userData 里写了自己的东西
     * （缓存、Local State、Preferences…），整体 rename 会与正在运行的进程打架；
     * 而用户真正在意的是素材库、设置、ffmpeg、模型这几样，
     * 逐个搬既安全又能明确告诉你搬了什么。
     */
    const moved: string[] = []
    for (const [from, to] of [
      [LEGACY_APP_DATA, APP_DATA_DIR],
      ['settings.json', 'settings.json'],
      ['bin', 'bin']
    ] as Array<[string, string]>) {
      const src = join(legacy, from)
      const dest = join(current, to)
      if (!existsSync(src)) continue
      /**
       * 目标已存在时：**只允许覆盖空壳**（刚建出来的空库），
       * 有真实内容就跳过 —— 宁可少搬，也不能把已有数据覆盖掉。
       */
      if (existsSync(dest)) {
        const isEmptyDb = dest.endsWith(APP_DATA_DIR) && !hasRealDb(dest)
        if (!isEmptyDb) continue
        rmSync(dest, { recursive: true, force: true })
      }
      try {
        renameSync(src, dest)
      } catch {
        // 跨分区（EXDEV）等情况下退化为复制
        cpSync(src, dest, { recursive: true })
      }
      moved.push(from)
    }
    if (moved.length) {
      console.log(`[migrate] 已从 ${LEGACY_USER_DATA} 迁移：${moved.join('、')}`)
    }
  } catch (err) {
    // 迁移失败不影响使用：以新目录启动，用户重新导入即可
    console.error('[migrate] 迁移旧数据目录失败：', (err as Error).message)
  }
}

/** 该业务数据目录里是否已有「真实」数据库（大于 1MB 才算，空库只有几十 KB） */
function hasRealDb(dir: string): boolean {
  try {
    const db = join(dir, 'srt-tool.db')
    return existsSync(db) && statSync(db).size > 1024 * 1024
  } catch {
    return false
  }
}

app.whenReady().then(() => {
  // 更名迁移：老版本的应用数据目录叫 srt-clip-helper，改名后会变成 subclip。
  // 必须在任何读写之前执行，否则会以空目录启动（用户会以为数据丢了）。
  migrateLegacyUserData()

  // 字幕缓存目录取自设置，便于用户自定义
  initDb(app.getPath('userData'), loadSettings().subtitleCacheDir)

  // 视频预览：给去往 CDN 的请求补 Referer / UA（<video> 自己不能设这些头）
  installStreamHeaderBridge(session.defaultSession)

  bridge.version = app.getVersion()
  wireBridge(push)

  const settings = loadSettings()
  // 被纠正过的路径（例如历史遗留的 cache 目录）写回文件，避免每次启动都要修正
  saveSettings({ subtitleCacheDir: settings.subtitleCacheDir })
  // 启动本地服务前先装上配对令牌（留空即不校验，只靠 Origin 白名单）
  bridge.configure({ token: settings.bridgeToken })
  bridge.start(settings.port)

  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  bridge.stop()
  closeAllSessions()
  closeDb()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  bridge.stop()
  closeAllSessions()
  closeDb()
  // Embedding worker 是一条活线程，不收掉 Electron 不会真正退出
  void shutdownEmbed()
})
