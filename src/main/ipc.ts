/**
 * 主进程 IPC 注册中心（薄封装）。
 * 业务逻辑位于 services.ts，渲染进程通过 preload 暴露的 window.api 调用。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  AppSettings,
  Cue,
  OpResult,
  ParseResult,
  SliceRowLike
} from '@shared/types'
import { APP_DATA_DIR } from '@shared/constants'
import * as bili from './bilibili'
import { bridge } from './bridge'
import * as db from './db'
import { decodeBuffer, parseSrt } from './srt'
import {
  exportSlice,
  hasSubtitles,
  importBiliTrack,
  importLocalSrt,
  listBiliTracks,
  loadMergedDoc,
  persistVideo,
  pullSubtitles,
  resolveTarget,
  type ImportSrtResult,
  type PullProgress
} from './services'
import { loadSettings, saveSettings } from './settings'
import { readFile } from 'node:fs/promises'
import { resolveFfmpeg } from './slice/ffmpeg'
import { sanitizeFileName } from './slice/filename'
import { runSliceTasks, type SliceProgress, type SliceTaskInput } from './slice/engine'

/** 当前运行的切片任务（同一时刻只允许一个） */
let sliceAbort: AbortController | null = null

/** 插件目录的可能位置（开发态在工程里，打包后在 resources 下） */
function extensionDirCandidates(): string[] {
  return [join(app.getAppPath(), 'extension'), join(process.resourcesPath ?? '', 'extension')].filter(
    (p): p is string => Boolean(p)
  )
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* ------------------------------- 资源树 / 统计 ------------------------------ */

  ipcMain.handle('tree:list', () => db.buildTree())
  ipcMain.handle('stats:get', () => db.stats())

  ipcMain.handle('node:delete', (_e, key: string) => {
    db.deleteNode(key)
    return db.buildTree()
  })

  ipcMain.handle('node:favorite', (_e, key: string) => {
    db.toggleFavorite(key)
    return db.buildTree()
  })

  ipcMain.handle('node:rename', (_e, payload: { key: string; name: string }) => {
    db.renameNode(payload.key, payload.name)
    return db.buildTree()
  })

  /* --------------------------------- 字幕内容 -------------------------------- */

  ipcMain.handle('doc:cues', (_e, docId: number) => db.loadCues(docId))

  ipcMain.handle('doc:updateCues', (_e, docId: number, cues: Cue[]) => {
    db.updateDocCues(docId, cues)
    return true
  })

  ipcMain.handle('doc:meta', (_e, docId: number) => {
    const doc = db.getDoc(docId)
    if (!doc) return null
    return { doc, video: db.getVideo(doc.videoId) }
  })

  /**
   * 合并加载：把同一视频的所有分P 字幕首尾相接成一个连续列表（重新编号）。
   * 这样多P 字幕可以连续阅读，切片时也能跨P 合并。逻辑在 services.loadMergedDoc，便于测试。
   */
  ipcMain.handle('doc:loadMerged', (_e, docId: number) => loadMergedDoc(docId))

  /** 保存合并列表中的某一条（按 docId 写回对应文档） */
  ipcMain.handle(
    'doc:updateMergedCue',
    (_e, payload: { docId: number; origIndex: number; text: string }) => {
      const cues = db.loadCues(payload.docId)
      const target = cues.find((c) => c.index === payload.origIndex)
      if (!target) return false
      target.text = payload.text
      db.updateDocCues(payload.docId, cues)
      return true
    }
  )

  /* -------------------------------- 本地 SRT -------------------------------- */

  ipcMain.handle('srt:preview', async (_e, path: string): Promise<ParseResult> => {
    // 只读用户在本会话里用「选择文件」对话框亲自选过的路径
    if (!isApproved(path)) throw new Error('该路径未经过文件选择对话框，已拒绝读取')
    const buf = await readFile(path)
    const { text } = decodeBuffer(buf as Buffer)
    return parseSrt(text)
  })

  ipcMain.handle(
    'srt:import',
    async (_e, payload: { paths: string[]; bvid?: string }): Promise<OpResult<ImportSrtResult>> => {
      const paths = (payload.paths ?? []).filter((p) => isApproved(p))
      const rejected = (payload.paths ?? []).length - paths.length
      if (!paths.length) {
        return { ok: false, message: '这些路径未经过文件选择对话框，已拒绝导入' }
      }
      const data = await importLocalSrt(paths, payload.bvid)
      if (rejected > 0) {
        data.failures.push(`${rejected} 个路径未经文件选择对话框，已跳过`)
      }
      // 重复导入同一个文件时只会「更新」，所以新增 + 更新都算成功
      return { ok: data.imported + data.updated > 0, data }
    }
  )

  /* --------------------------------- B站字幕 -------------------------------- */

  ipcMain.handle('bili:loginStatus', async () => {
    const cookie = loadSettings().biliCookie
    if (!cookie.trim()) return { loggedIn: false }
    return bili.checkLogin(cookie)
  })

  ipcMain.handle('bili:fetchVideo', async (_e, input: string) => {
    try {
      const { videoId, info } = await persistVideo(input)
      return { ok: true, data: { videoId, info } }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('bili:tracks', (_e, payload: { videoId: number; page: number }) =>
    listBiliTracks(payload.videoId, payload.page)
  )

  /** 解析任意 B 站链接：视频 / 合集 / 系列 / 收藏夹 / 投稿页 / 短链 */
  ipcMain.handle('bili:resolve', async (_e, input: string) => {
    try {
      const target = await resolveTarget(input)
      // 标记哪些视频本地已经有字幕了，界面上提前提示，避免重复拉取
      return {
        ok: true,
        data: {
          ...target,
          videos: target.videos.map((v) => ({ ...v, exists: hasSubtitles(v.bvid) }))
        }
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  /** 批量拉取字幕（进度通过 bili:pull-progress 推送） */
  ipcMain.handle(
    'bili:pull',
    async (_e, payload: { videos: Array<{ bvid: string; title: string }> }) => {
      try {
        const push = (p: PullProgress): void => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('bili:pull-progress', p)
          }
        }
        const result = await pullSubtitles(payload.videos ?? [], push)
        return { ok: true, data: result }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'bili:importTrack',
    (
      _e,
      payload: { videoId: number; page: number; track: { lang: string; label: string; url: string } }
    ) => importBiliTrack(payload.videoId, payload.page, payload.track)
  )

  /* --------------------------------- 切片任务 ------------------------------- */

  ipcMain.handle('clips:list', () => db.listClipTasks())
  ipcMain.handle('clips:clear', () => {
    db.clearClipTasks()
    return true
  })
  ipcMain.handle('clips:delete', (_e, id: number) => {
    db.deleteClipTask(id)
    return db.listClipTasks()
  })

  ipcMain.handle(
    'clips:add',
    (
      _e,
      payload: {
        docId: number
        bvid: string
        page: number
        ranges: Array<{
          start: number
          end: number
          segments?: Array<{ page: number; start: number; end: number }>
        }>
        notePrefix?: string
      }
    ) => {
      const video = db.getVideo(db.getDoc(payload.docId)?.videoId ?? -1)
      const bvid = payload.bvid || video?.bvid || ''
      const rows = payload.ranges.map((r, i) => ({
        docId: payload.docId,
        bvid,
        // 跨分P 时以第一段所属分P 作为主分P，完整分段存在 segments 里
        page: r.segments?.[0]?.page ?? payload.page,
        start: r.start,
        end: r.end,
        note: `${payload.notePrefix || video?.title || 'clip'}_${i + 1}`,
        segments: r.segments
      }))
      return { ok: true, data: { count: db.addClipTasks(rows) } }
    }
  )

  ipcMain.handle(
    'clips:export',
    (_e, payload: { rows: SliceRowLike[]; format: 'csv' | 'xlsx'; outPath?: string }) => {
      // 只信白名单里的格式，避免「声明 csv 实际写 xlsx」这类错配
      const format = payload.format === 'xlsx' ? 'xlsx' : 'csv'
      // outPath 必须来自「另存为」对话框；否则忽略它，回退到设置里的输出目录
      const outPath =
        payload.outPath && isApproved(payload.outPath) ? payload.outPath : undefined
      return exportSlice(payload.rows ?? [], format, outPath)
    }
  )

  /* -------------------------------- 全库检索 ------------------------------- */

  ipcMain.handle(
    'search:library',
    (
      _e,
      payload: {
        keyword: string
        limit?: number
        uploaderId?: number
        collectionId?: number
        videoId?: number
      }
    ) =>
      db.searchCues(payload?.keyword ?? '', {
        limit: payload?.limit,
        uploaderId: payload?.uploaderId,
        collectionId: payload?.collectionId,
        videoId: payload?.videoId
      })
  )

  /** 把检索结果里的若干条直接加入切片任务（每条命中 = 一个时间范围） */
  ipcMain.handle(
    'clips:addHits',
    (
      _e,
      payload: {
        hits: Array<{
          docId: number
          bvid: string
          page: number
          start: number
          end: number
          text: string
        }>
        notePrefix?: string
      }
    ) => {
      const hits = (payload?.hits ?? []).slice(0, 500)
      if (!hits.length) return { ok: false, message: '没有选中的检索结果' }
      const prefix = sanitizeFileName(payload?.notePrefix || '检索').slice(0, 32)
      const rows = hits.map((h, i) => ({
        docId: h.docId,
        bvid: String(h.bvid ?? ''),
        page: Number(h.page) || 1,
        start: Number(h.start) || 0,
        end: Number(h.end) || 0,
        // 备注带上命中文本片段，便于在切片列表里认出是哪一句
        note: `${prefix}_${String(i + 1).padStart(2, '0')}_${sanitizeFileName(h.text).slice(0, 24)}`
      }))
      return { ok: true, data: { count: db.addClipTasks(rows) } }
    }
  )

  /* ---------------------------------- 设置 ---------------------------------- */

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    const before = loadSettings()
    const after = saveSettings(patch)
    // 端口或配对令牌变化时都要重启本地服务（令牌要重新装到服务上）
    const portChanged = patch.port !== undefined && Number(patch.port) !== before.port
    const tokenChanged =
      patch.bridgeToken !== undefined && after.bridgeToken !== before.bridgeToken
    if (portChanged || tokenChanged) {
      bridge.configure({ token: after.bridgeToken })
      bridge.start(after.port)
    }
    return after
  })

  /* ---------------------------- 浏览器插件通信服务 ---------------------------- */

  ipcMain.handle('bridge:status', () => bridge.status())

  ipcMain.handle('bridge:restart', (_e, port?: number) => {
    const target = Number(port) || loadSettings().port
    bridge.start(target)
    return bridge.status()
  })

  ipcMain.handle(
    'bridge:requestSubtitles',
    (_e, payload: { bvid: string; page: number; cid?: number | null }) =>
      bridge.requestSubtitles(payload.bvid, payload.page, payload.cid)
  )

  /* --------------------------------- 本地切片 -------------------------------- */

  ipcMain.handle('slice:check', () => {
    const ffmpeg = resolveFfmpeg()
    return { available: Boolean(ffmpeg), ffmpeg: ffmpeg ?? '' }
  })

  ipcMain.handle('slice:run', async (_e, payload: { tasks: SliceTaskInput[] }) => {
    if (sliceAbort) return { ok: false, message: '已有切片任务正在运行，请稍候或先取消' }
    const controller = new AbortController()
    sliceAbort = controller
    try {
      const push = (p: SliceProgress): void => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('slice:progress', p)
        }
      }
      const result = await runSliceTasks(payload.tasks ?? [], push, controller.signal)
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    } finally {
      sliceAbort = null
    }
  })

  ipcMain.handle('slice:cancel', () => {
    sliceAbort?.abort()
    sliceAbort = null
    return true
  })

  /** 浏览器插件所在目录（便于用户加载扩展） */
  ipcMain.handle('bridge:extensionDir', () => {
    const candidates = extensionDirCandidates()
    for (const dir of candidates) {
      if (existsSync(dir)) return { path: dir, exists: true }
    }
    return { path: candidates[0] ?? '', exists: false }
  })

  ipcMain.handle('env:check', () => {
    const s = loadSettings()
    const probe = (p: string): { path: string; exists: boolean } => ({
      path: p,
      exists: Boolean(p) && existsSync(p)
    })
    return {
      sliceToolDir: probe(s.sliceToolDir),
      outputDir: probe(s.outputDir)
    }
  })

  /* --------------------------------- 系统交互 -------------------------------- */

  /*
   * 渲染进程传来的路径默认**不可信**：
   * 只要渲染进程被注入（XSS / 恶意依赖），它就能借主进程的权限读写任意文件、
   * 甚至用 shell.openPath 启动任意 exe。所以规定：
   *   - 文件读写只认「本会话里用户亲自在系统对话框里选过的路径」；
   *   - 打开目录只允许打开应用自己的那几个目录，且拒绝可执行扩展名。
   */
  const approvedPaths = new Set<string>()

  const approve = (p: string): string => {
    if (p) approvedPaths.add(resolve(p))
    return p
  }

  const isApproved = (p: string): boolean => Boolean(p) && approvedPaths.has(resolve(p))

  /** 允许用「打开目录」打开的根目录 */
  const allowedOpenRoots = (): string[] => {
    const s = loadSettings()
    return [
      s.outputDir,
      s.sliceOutputDir,
      s.subtitleCacheDir,
      s.sliceToolDir,
      join(app.getPath('userData'), APP_DATA_DIR),
      ...extensionDirCandidates()
    ]
      .filter(Boolean)
      .map((p) => resolve(p))
  }

  /** 双击就执行的危险扩展名，一律不允许通过「打开」直接启动 */
  const BLOCKED_EXT =
    /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|lnk|reg|hta|cpl|dll|sys|jar)$/i

  const isSafeToOpen = (target: string): boolean => {
    const full = resolve(target)
    if (BLOCKED_EXT.test(full)) return false
    return allowedOpenRoots().some((root) => full === root || full.startsWith(root + sep))
  }

  ipcMain.handle('dialog:pickFiles', async () => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择字幕文件',
      filters: [
        // 只列真正能解析的格式：解析器认 `-->` 时间轴（SRT / WebVTT）。
        // 早期这里还列了 ass / lrc，但解析器并不支持，用户选了必然失败。
        { name: '字幕文件', extensions: ['srt', 'txt', 'vtt'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths.map(approve)
  })

  ipcMain.handle('dialog:pickFfmpeg', async () => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择 ffmpeg 可执行文件',
      filters:
        process.platform === 'win32'
          ? [{ name: '可执行文件', extensions: ['exe'] }, { name: '全部文件', extensions: ['*'] }]
          : [{ name: '全部文件', extensions: ['*'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? '' : approve(res.filePaths[0])
  })

  ipcMain.handle('dialog:pickDir', async (_e, defaultPath?: string) => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择目录',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? '' : approve(res.filePaths[0])
  })

  ipcMain.handle('dialog:saveFile', async (_e, payload: { defaultName: string; format: string }) => {
    const win = getWindow()
    // 只在白名单里取扩展名，避免渲染进程塞进任意字符串
    const ext = payload.format === 'xlsx' ? 'xlsx' : 'csv'
    const opts: SaveDialogOptions = {
      title: '导出切片表',
      defaultPath: payload.defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return res.canceled ? '' : approve(res.filePath)
  })

  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    if (!target) return '路径为空'
    if (!isSafeToOpen(target)) return `拒绝打开该路径（不在允许的目录内）：${target}`
    if (!existsSync(target)) return `路径不存在：${target}`
    return shell.openPath(target)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return '仅支持 http(s) 链接'
    await shell.openExternal(url)
    return ''
  })

  ipcMain.handle('shell:showItem', (_e, target: string) => {
    if (target && existsSync(target)) shell.showItemInFolder(target)
    return true
  })
}
