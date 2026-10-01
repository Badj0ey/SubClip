import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { bridge } from './bridge'
import { closeDb, initDb, stats } from './db'
import { registerIpc } from './ipc'
import { loadSettings, saveSettings } from './settings'
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
    backgroundColor: '#f5f6f8',
    title: 'SRT 字幕检索与视频切片辅助工具',
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
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

app.whenReady().then(() => {
  // 字幕缓存目录取自设置，便于用户自定义
  initDb(app.getPath('userData'), loadSettings().subtitleCacheDir)

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
  closeDb()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  bridge.stop()
  closeDb()
})
