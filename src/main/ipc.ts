/**
 * 主进程 IPC 注册中心（薄封装）。
 * 业务逻辑位于 services.ts，渲染进程通过 preload 暴露的 window.api 调用。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  Cue,
  OpResult,
  ParseResult,
  SliceRowLike
} from '@shared/types'
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
import { runSliceTasks, type SliceProgress, type SliceTaskInput } from './slice/engine'

/** 当前运行的切片任务（同一时刻只允许一个） */
let sliceAbort: AbortController | null = null

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
    const buf = await readFile(path)
    const { text } = decodeBuffer(buf as Buffer)
    return parseSrt(text)
  })

  ipcMain.handle(
    'srt:import',
    async (_e, payload: { paths: string[]; bvid?: string }): Promise<OpResult<ImportSrtResult>> => {
      const data = await importLocalSrt(payload.paths ?? [], payload.bvid)
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
    (_e, payload: { rows: SliceRowLike[]; format: 'csv' | 'xlsx'; outPath?: string }) =>
      exportSlice(payload.rows, payload.format, payload.outPath)
  )

  /* ---------------------------------- 设置 ---------------------------------- */

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    const before = loadSettings()
    const after = saveSettings(patch)
    // 端口变化时自动重启本地服务
    if (patch.port !== undefined && Number(patch.port) !== before.port) {
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
    const candidates = [
      join(app.getAppPath(), 'extension'),
      join(process.resourcesPath ?? '', 'extension')
    ]
    for (const dir of candidates) {
      if (dir && existsSync(dir)) return { path: dir, exists: true }
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

  ipcMain.handle('dialog:pickFiles', async () => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择字幕文件',
      filters: [
        { name: '字幕文件', extensions: ['srt', 'txt', 'vtt', 'ass', 'lrc'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
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
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle('dialog:pickDir', async (_e, defaultPath?: string) => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择目录',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? '' : res.filePaths[0]
  })

  ipcMain.handle('dialog:saveFile', async (_e, payload: { defaultName: string; format: string }) => {
    const win = getWindow()
    const opts: SaveDialogOptions = {
      title: '导出切片表',
      defaultPath: payload.defaultName,
      filters: [{ name: payload.format.toUpperCase(), extensions: [payload.format] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return res.canceled ? '' : res.filePath
  })

  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    if (!target) return '路径为空'
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
