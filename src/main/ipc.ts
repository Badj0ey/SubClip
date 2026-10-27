/**
 * 主进程 IPC 注册中心（薄封装）。
 * 业务逻辑位于 services.ts，渲染进程通过 preload 暴露的 window.api 调用。
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { existsSync, rmSync, copyFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep, dirname } from 'node:path'
import * as os from 'node:os'

/** 允许导入 / 打开的字幕文件扩展名（拖拽导入靠它把关） */
const SUBTITLE_EXTS = ['.srt', '.vtt', '.txt']
import type {
  AiResult,
  AiStatus,
  AiTagSuggestion,
  AppSettings,
  Cue,
  CueSearchPage,
  OpResult,
  ParseResult,
  GraphCounts,
  GraphProgress,
  RecommendationResult,
  SemanticSearchResult,
  SemanticStatus,
  SliceRowLike
} from '@shared/types'
import { APP_DATA_DIR } from '@shared/constants'
import { safeExternalUrl } from '@shared/externalUrl'
import * as bili from './bilibili'
import { fetchDanmaku } from './danmaku'
import { bridge } from './bridge'
import { buildDiagnostics } from './diagnostics'
import { renderNameTemplate } from '@shared/naming'
import { generateClipTitle } from '@shared/clipTitle'
import { parseClipTasksJson, serializeClipTasks } from './clipIO'
import * as db from './db'
import { decodeBuffer, parseSrt, replaceInCues, shiftCues, toPlainText, toSrt, toVtt } from './srt'
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
import { readFile, writeFile } from 'node:fs/promises'
import { resolveFfmpeg } from './slice/ffmpeg'
import { sanitizeFileName } from './slice/filename'
import { closeAllSessions, openMediaSession, type MediaSession } from './media'
import * as embed from './embed/engine'
import * as ai from './ai/provider'
import { composeMovie, type ComposeProgress, type ComposeResult } from './compose'
import { buildPublishKit, safeKitName } from '@shared/publishKit'
import { buildKitData, uniqueDir, type PublishKitData } from './publishKit'
import { buildGraph, cancelGraph, graphStatus } from './graph'
import {
  inspectVideoVectors,
  recommendHighlights,
  recommendTwins,
  recommendTypical,
  similarityStats
} from './recommend'

/**
 * 把要交给 AI 分析的字幕文本收集起来。
 *
 * `video` 会把该视频所有分P 拼起来（分析「这个视频讲了什么」时不能只看第一个分P），
 * 但会**限长**：几十万字的直播回放直接发过去既慢又超上下文，所以按 `aiMaxChars` 截断。
 */
function gatherText(targetType: 'video' | 'doc', targetId: number): string {
  const MAX = 12000
  if (targetType === 'doc') {
    const cues = db.loadCues(targetId)
    return cues
      .map((c) => c.text)
      .join('\n')
      .slice(0, MAX)
  }
  const docs = db.listDocsByVideo(targetId)
  const parts: string[] = []
  let total = 0
  for (const doc of docs) {
    for (const cue of db.loadCues(doc.id)) {
      parts.push(cue.text)
      total += cue.text.length
      if (total > MAX) break
    }
    if (total > MAX) break
  }
  return parts.join('\n').slice(0, MAX)
}

import { runSliceTasks, type SliceProgress, type SliceTaskInput } from './slice/engine'

/** 当前运行的切片任务（同一时刻只允许一个） */
let sliceAbort: AbortController | null = null
/** 成片拼接的取消句柄（与切片分开：两者可以各自独立取消） */
let composeAbort: AbortController | null = null

/** 用户脚本的可能位置（开发态在工程里，打包后在 resources 下） */
function userscriptCandidates(): string[] {
  // 打包态优先使用真实的 resources/userscript，不能把 app.asar 内的虚拟文件交给文件管理器。
  const roots = [process.resourcesPath, app.getAppPath()].filter(
    (root): root is string => Boolean(root)
  )
  return roots.map((root) => join(root, 'userscript', 'SubClip.user.js'))
}

/** 诊断包里用：某段信息取不到时不要因此整包失败 */
function safe<T>(fn: () => T): T | { error: string } {
  try {
    return fn()
  } catch (err) {
    return { error: (err as Error).message }
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* ------------------------------- 资源树 / 统计 ------------------------------ */

  ipcMain.handle('tree:list', () => db.buildTree())
  ipcMain.handle('stats:get', () => db.stats())
  /** 首页 Dashboard 的全部卡片数据（第二阶段，只读） */
  ipcMain.handle('dashboard:overview', () => db.dashboardOverview())

  ipcMain.handle('node:delete', (_e, key: string) => {
    // 先存快照再删：本地导入的字幕、手工改过的正文，删掉就拉不回来了，
    // 所以要留一份能让「撤销删除」按原 id 写回去。
    const snapshot = db.exportNode(key)
    db.deleteNode(key)
    return { tree: db.buildTree(), snapshot }
  })

  ipcMain.handle('node:restore', (_e, snapshot: db.NodeSnapshot) => {
    db.importNode(snapshot)
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

  /**
   * 同一视频的所有字幕轨（含不同语言）。
   * 双语对照要用它列出「可以拿来跟当前字幕并排看的另一条轨」——
   * 合并阅读每分P 只取一条，所以另一条不在 state.docs 里。
   */
  ipcMain.handle('doc:siblings', (_e, docId: number) => {
    const doc = db.getDoc(docId)
    if (!doc) return []
    return db.listDocsByVideo(doc.videoId)
  })

  /** 保存合并列表中的某一条（按 docId 写回对应文档） */  ipcMain.handle(
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

  /* ----------------------------- 批量编辑 / 导出 ----------------------------- */

  /** 批量查找替换（支持正则）。返回改动条数，界面据此决定是否提示。 */
  ipcMain.handle(
    'doc:replace',
    (
      _e,
      payload: {
        docId: number
        pattern: string
        replacement: string
        useRegex: boolean
        ignoreCase?: boolean
      }
    ): OpResult<{ changed: number; total: number }> => {
      const cues = db.loadCues(payload.docId)
      if (!cues.length) return { ok: false, message: '这个字幕文档是空的' }
      let result
      try {
        result = replaceInCues(
          cues,
          String(payload.pattern ?? ''),
          String(payload.replacement ?? ''),
          Boolean(payload.useRegex),
          Boolean(payload.ignoreCase)
        )
      } catch (err) {
        return { ok: false, message: `正则表达式无效：${(err as Error).message}` }
      }
      if (!result.changed) return { ok: true, data: { changed: 0, total: cues.length } }
      db.updateDocCues(payload.docId, result.cues)
      return { ok: true, data: { changed: result.changed, total: cues.length } }
    }
  )

  /** 合并选中的若干条字幕 */
  ipcMain.handle(
    'doc:mergeCues',
    (_e, payload: { docId: number; indexes: number[] }): OpResult<{ merged: number }> => {
      const merged = db.mergeDocCues(payload.docId, payload.indexes ?? [])
      if (merged < 2) return { ok: false, message: '至少选中同一文档里的 2 条字幕才能合并' }
      return { ok: true, data: { merged } }
    }
  )

  /** 在某一条的内部时间点把它拆成两条 */
  ipcMain.handle(
    'doc:splitCue',
    (
      _e,
      payload: { docId: number; index: number; atSecond: number }
    ): OpResult<{ at: number }> => {
      const at = Number(payload.atSecond)
      if (!db.splitDocCue(payload.docId, payload.index, at)) {
        return { ok: false, message: '这一条太短（或切分点不在它内部），无法拆分' }
      }
      return { ok: true, data: { at } }
    }
  )

  /** 整体平移 / 缩放时间轴 */
  ipcMain.handle(
    'doc:shift',
    (
      _e,
      payload: { docId: number; offsetMs: number; scale?: number }
    ): OpResult<{ count: number }> => {
      const cues = db.loadCues(payload.docId)
      if (!cues.length) return { ok: false, message: '这个字幕文档是空的' }
      const next = shiftCues(cues, Number(payload.offsetMs) || 0, Number(payload.scale) || 1)
      db.updateDocCues(payload.docId, next)
      return { ok: true, data: { count: next.length } }
    }
  )

  /**
   * 导出字幕文件。
   * 默认只导出当前文档；`includeAllPages` 为真时把同一视频的所有分P 合成一份。
   */
  ipcMain.handle(
    'doc:exportAs',
    async (
      _e,
      payload: { docId: number; format: 'srt' | 'vtt' | 'txt'; includeAllPages?: boolean }
    ): Promise<OpResult<{ path: string; count: number }>> => {
      const doc = db.getDoc(payload.docId)
      if (!doc) return { ok: false, message: '字幕不存在' }
      const video = db.getVideo(doc.videoId)
      const docs = payload.includeAllPages ? db.listDocsByVideo(doc.videoId) : [doc]
      const cues: Cue[] = []
      for (const d of docs) cues.push(...db.loadCues(d.id))
      if (!cues.length) return { ok: false, message: '没有可导出的字幕内容' }

      const format: 'srt' | 'vtt' | 'txt' =
        payload.format === 'vtt' ? 'vtt' : payload.format === 'txt' ? 'txt' : 'srt'
      const content =
        format === 'vtt' ? toVtt(cues) : format === 'txt' ? toPlainText(cues) : toSrt(cues)

      const win = getWindow()
      const base = sanitizeFileName(video?.title || doc.label || 'subtitle').slice(0, 60)
      const defaultName = `${base}${payload.includeAllPages ? '_全部' : `_P${doc.page}`}.${format}`
      const opts: SaveDialogOptions = {
        title: '导出字幕',
        defaultPath: join(app.getPath('documents'), defaultName),
        filters: [
          { name: format.toUpperCase(), extensions: [format] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }

      try {
        await writeFile(res.filePath, content, 'utf8')
      } catch (err) {
        return { ok: false, message: `写入失败：${(err as Error).message}` }
      }
      return { ok: true, data: { path: res.filePath, count: cues.length } }
    }
  )

  /* -------------------------------- 视频预览 -------------------------------- */

  /**
   * 打开一个预览会话：解析 DASH 播放地址并返回 `bilistream://` 地址。
   * 只解析，不写入任何数据（预览是纯只读能力）。
   */
  ipcMain.handle(
    'media:open',
    async (_e, payload: { bvid: string; page: number }): Promise<OpResult<MediaSession>> => {
      if (!payload?.bvid || !/^BV[0-9A-Za-z]{10}$/.test(payload.bvid)) {
        return { ok: false, message: '缺少有效的 BV 号' }
      }
      try {
        const session = await openMediaSession(payload.bvid, Number(payload.page) || 1)
        return { ok: true, data: session }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  /** 关闭全部预览会话（换视频 / 退出播放器时释放 CDN 连接） */
  ipcMain.handle('media:close', (): boolean => {
    closeAllSessions()
    return true
  })

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

  /**
   * 拖拽导入。
   *
   * 拖进来的路径没经过「选择文件」对话框，所以这里**自己把关**：
   * 只接受真实存在、且扩展名在白名单里的普通文件，然后才登记为已批准。
   * 这样即便渲染进程被注入，也无法借这个入口去读任意本地文件（exe/dll 之类一律拒绝）。
   */
  ipcMain.handle(
    'srt:importDropped',
    async (_e, paths: string[]): Promise<OpResult<ImportSrtResult>> => {
      const allowed: string[] = []
      const rejected: string[] = []
      for (const raw of (paths ?? []).slice(0, 200)) {
        const p = typeof raw === 'string' ? raw : ''
        const ext = extname(p).toLowerCase()
        if (!p || !SUBTITLE_EXTS.includes(ext) || !existsSync(p) || !statSync(p).isFile()) {
          rejected.push(p || '(空路径)')
          continue
        }
        allowed.push(approve(p))
      }
      if (!allowed.length) {
        return { ok: false, message: '拖入的文件里没有可识别的字幕文件（支持 .srt / .vtt / .txt）' }
      }
      const data = await importLocalSrt(allowed)
      if (rejected.length) {
        data.failures.push(`${rejected.length} 个文件格式不支持或不可读，已跳过`)
      }
      return { ok: data.imported + data.updated > 0, data }
    }
  )

  /* --------------------------------- B站字幕 -------------------------------- */

  ipcMain.handle('bili:loginStatus', async () => {
    const cookie = loadSettings().biliCookie
    if (!cookie.trim()) return { loggedIn: false }
    return bili.checkLogin(cookie)
  })

  /**
   * 读取弹幕（3.17.0）：只作为字幕定位的辅助信息。
   * `force` 为 true 时跳过主进程缓存，供面板的「重新获取」使用。
   */
  ipcMain.handle('bili:danmaku', async (_e, bvid: unknown, force?: unknown) => {
    try {
      if (typeof bvid !== 'string') return { ok: false, message: 'BV号格式不正确' }
      return { ok: true, data: await fetchDanmaku(bvid, force === true) }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
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
        // 桌面端没有页面 Cookie 时，仍先尝试公开字幕；失败分P交给已连接的浏览器补抓。
        const missing = new Set([
          ...result.retryAll,
          ...result.retryPages.map((p) => p.bvid)
        ])
        let browserFallback = 0
        for (const bvid of missing) {
          const allPages = result.retryAll.includes(bvid)
          const pages = result.retryPages
            .filter((p) => p.bvid === bvid)
            .map(({ page, cid }) => ({ page, cid }))
          if (bridge.requestSubtitles(bvid, pages[0]?.page ?? 1, pages[0]?.cid, {
            allPages, pages: allPages ? undefined : pages
          })) browserFallback++
        }
        return { ok: true, data: { ...result, browserFallback } }
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

  ipcMain.handle('clips:list', () => db.listClips())
  ipcMain.handle('clips:clear', () => {
    db.clearClips()
    return true
  })
  ipcMain.handle('clips:delete', (_e, id: number) => {
    db.deleteClip(id)
    return db.listClips()
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
      const template = loadSettings().sliceNameTemplate
      const prefix = payload.notePrefix || video?.title || 'clip'
      // 第五阶段：片段名称默认「按内容生成」——取该范围覆盖的字幕文本，
      // 比 `前缀 #3` 有用得多（回看列表时一眼知道这段讲什么）。
      // 取不到字幕时 generateClipTitle 自己会回退到「视频标题 + 序号」。
      const docCues = db.loadCues(payload.docId)
      const rows = payload.ranges.map((r, i) => {
        const page = r.segments?.[0]?.page ?? payload.page
        const covered = docCues.filter(
          (c) => c.start <= Math.max(r.start, r.end) && c.end >= Math.min(r.start, r.end)
        )
        return {
          docId: payload.docId,
          bvid,
          // 跨分P 时以第一段所属分P 作为主分P，完整分段存在 segments 里
          page,
          start: r.start,
          end: r.end,
          // 备注 = 输出文件名（按命名模板渲染）
          note: renderNameTemplate(template, {
            prefix,
            index: i + 1,
            bvid,
            page,
            start: r.start,
            end: r.end,
            duration: Math.max(0, r.end - r.start),
            title: video?.title ?? ''
          }),
          name: generateClipTitle({
            cues: covered,
            videoTitle: video?.title ?? '',
            index: i + 1
          }),
          source: 'manual' as const,
          segments: r.segments
        }
      })
      return { ok: true, data: { count: db.addClips(rows, true) } }
    }
  )

  /**
   * 重新为已有片段按内容生成名称（第五阶段）。
   * 适用场景：早先加入的任务名字是「前缀 #1」，现在想让它们变成有意义的标题。
   */
  ipcMain.handle('clips:autoName', (): OpResult<{ renamed: number }> => {
    const clips = db.listClips()
    if (!clips.length) return { ok: false, message: '没有切片任务' }
    const cueCache = new Map<number, Cue[]>()
    const loadFor = (docId: number): Cue[] => {
      const hit = cueCache.get(docId)
      if (hit) return hit
      const cues = db.loadCues(docId)
      cueCache.set(docId, cues)
      return cues
    }
    let renamed = 0
    for (const [i, clip] of clips.entries()) {
      const cues = loadFor(clip.docId)
      const covered = cues.filter(
        (c) => c.start <= Math.max(clip.start, clip.end) && c.end >= Math.min(clip.start, clip.end)
      )
      const doc = db.getDoc(clip.docId)
      const video = doc ? db.getVideo(doc.videoId) : null
      const name = generateClipTitle({
        cues: covered,
        videoTitle: video?.title ?? '',
        index: i + 1
      })
      if (name && name !== clip.name) {
        db.updateClipName(clip.id, name)
        renamed++
      }
    }
    return { ok: true, data: { renamed } }
  })

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
        offset?: number
        uploaderId?: number
        collectionId?: number
        videoId?: number
        tagIds?: number[]
        favoriteOnly?: boolean
        createdFrom?: number
        createdTo?: number
        minDuration?: number
        maxDuration?: number
      }
    ): CueSearchPage =>
      // 分页与筛选全部下推到 SQL：先取 200 条再在 JS 里排，会把最相关的那条挡在门外
      db.searchCuesPage(payload?.keyword ?? '', {
        limit: payload?.limit,
        offset: payload?.offset,
        uploaderId: payload?.uploaderId,
        collectionId: payload?.collectionId,
        videoId: payload?.videoId,
        tagIds: payload?.tagIds,
        favoriteOnly: payload?.favoriteOnly,
        createdFrom: payload?.createdFrom,
        createdTo: payload?.createdTo,
        minDuration: payload?.minDuration,
        maxDuration: payload?.maxDuration
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
          videoTitle?: string
        }>
        notePrefix?: string
      }
    ) => {
      const hits = (payload?.hits ?? []).slice(0, 500)
      if (!hits.length) return { ok: false, message: '没有选中的检索结果' }
      const template = loadSettings().sliceNameTemplate
      const prefix = sanitizeFileName(payload?.notePrefix || '检索').slice(0, 32)
      const rows = hits.map((h, i) => ({
        docId: h.docId,
        bvid: String(h.bvid ?? ''),
        page: Number(h.page) || 1,
        start: Number(h.start) || 0,
        end: Number(h.end) || 0,
        // 模板没用到 {title} 时，把命中文本拼在后面便于在切片列表里认出是哪一句
        note: `${renderNameTemplate(template, {
          prefix,
          index: i + 1,
          bvid: String(h.bvid ?? ''),
          page: Number(h.page) || 1,
          start: Number(h.start) || 0,
          end: Number(h.end) || 0,
          duration: Math.max(0, (Number(h.end) || 0) - (Number(h.start) || 0)),
          title: String(h.videoTitle ?? '')
        })}_${sanitizeFileName(h.text).slice(0, 20)}`,
        // 片段名称直接用命中的那句话，在片段列表里一眼能认出内容
        name: sanitizeFileName(h.text).slice(0, 40) || `${prefix} #${i + 1}`,
        source: 'search' as const
      }))
      return { ok: true, data: { count: db.addClips(rows, true) } }
    }
  )

  /* --------------------------- 导出任务管理 / 历史（3.6.0） --------------------------- */

  /*
   * 拆表后「队列顺序」属于任务而不是片段，所以上移/下移作用于 `export_jobs`。
   * 界面传进来的仍是**片段 id**（右栏与片段库都是按片段操作的），
   * 这里翻译成「该片段对应的待处理任务」再移动 —— 保持调用方不变，
   * 同时语义上移动的确实是任务。
   */
  ipcMain.handle('clips:move', (_e, payload: { id: number; dir: -1 | 1 }) => {
    const job = db
      .listExportJobs('pending')
      .find((j) => j.clipId === payload.id)
    if (job) db.moveExportJob(job.id, payload.dir === -1 ? -1 : 1)
    return db.listClips()
  })

  /** 待处理队列（剪辑任务页「待处理」） */
  ipcMain.handle('jobs:listPending', () => db.listExportJobs('pending'))
  /** 全部任务（含历史；剪辑任务页「已完成」） */
  ipcMain.handle('jobs:listAll', () => db.listExportJobs())
  /** 把片段排进队列 */
  ipcMain.handle('jobs:enqueue', (_e, clipIds: number[]) =>
    db.enqueueExportJobsFromClips(Array.isArray(clipIds) ? clipIds : [])
  )
  ipcMain.handle('jobs:delete', (_e, id: number) => {
    db.deleteExportJob(id)
    return db.listExportJobs()
  })
  ipcMain.handle('jobs:clearPending', () => {
    db.clearPendingExportJobs()
    return db.listExportJobs()
  })
  /** 失败/取消的任务重新排队（保留原记录，便于对比重试结果） */
  ipcMain.handle('jobs:retry', (_e, ids: number[]) =>
    db.retryExportJobs(Array.isArray(ids) ? ids : [])
  )
  ipcMain.handle('jobs:move', (_e, payload: { id: number; dir: -1 | 1 }) => {
    db.moveExportJob(payload.id, payload.dir === -1 ? -1 : 1)
    return db.listExportJobs('pending')
  })

  ipcMain.handle('clips:rename', (_e, payload: { id: number; note: string }) => {
    db.updateClipNote(payload.id, payload.note)
    return db.listClips()
  })

  /* --------------------------- 片段（第三阶段） --------------------------- */

  /** 改名：片段名称（库里认它的名字，与输出文件名分开） */
  ipcMain.handle('clips:renameName', (_e, payload: { id: number; name: string }) => {
    db.updateClipName(payload.id, payload.name)
    return db.listClips()
  })

  /** 片段的标签（与视频标签共用一套 tags 表） */
  ipcMain.handle('clips:tags', (_e, clipId: number) => db.getClipTagIds(clipId))
  ipcMain.handle('clips:setTags', (_e, payload: { clipId: number; tagIds: number[] }) => {
    db.setClipTags(payload.clipId, payload.tagIds ?? [])
    return db.listClips()
  })
  ipcMain.handle('clips:byTag', (_e, tagId: number) => db.listClipIdsByTag(tagId))

  /** 收藏 / 取消收藏片段 */
  ipcMain.handle('clips:favorite', (_e, clipId: number) => {
    const favorite = db.toggleClipFavorite(clipId)
    return { favorite, tasks: db.listClips() }
  })

  /** 批量获取片段详情：固定最多 200 个 id，避免逐条扫描整库。 */
  ipcMain.handle('clips:details', (_e, clipIds: number[]) =>
    db.listClipDetails(Array.isArray(clipIds) ? clipIds : [])
  )

  /** 保留旧接口，供第三方调用兼容；单条查询不再扫描整个片段库。 */
  ipcMain.handle('clips:detail', (_e, clipId: number) => {
    const clip = db.getClip(clipId)
    if (!clip) return null
    const doc = db.getDoc(clip.docId)
    const video = doc ? db.getVideo(doc.videoId) : null
    return {
      clip,
      docLabel: doc?.label ?? '',
      videoTitle: video?.title ?? '',
      uploaderName: video?.uploaderName ?? '',
      creators: doc ? db.listVideoCreators(doc.videoId) : [],
      tagIds: db.getClipTagIds(clipId)
    }
  })

  /* --------------------------- 标签（第三阶段升级） -------------------------- */

  /** 改标签的颜色 / 备注 */
  ipcMain.handle(
    'tags:updateMeta',
    (_e, payload: { id: number; color?: string; note?: string }) => {
      db.updateTagMeta(payload.id, { color: payload.color, note: payload.note })
      return db.listTags()
    }
  )

  /** 批量给多个视频**追加**标签（不动它们已有的标签） */
  ipcMain.handle(
    'tags:addToVideos',
    (_e, payload: { videoIds: number[]; tagIds: number[] }): OpResult<{ count: number }> => {
      const videos = (payload?.videoIds ?? []).filter((n) => Number.isFinite(n)).slice(0, 2000)
      const tags = (payload?.tagIds ?? []).filter((n) => Number.isFinite(n)).slice(0, 50)
      if (!videos.length || !tags.length) return { ok: false, message: '请选择视频与标签' }
      const count = db.addVideoTags(videos, tags)
      return { ok: true, data: { count } }
    }
  )

  /* ------------------------------ 分析结果（阶段三建表 / 阶段六接入） ------------- */

  ipcMain.handle(
    'analysis:list',
    (_e, payload: { targetType: 'video' | 'doc' | 'cue' | 'clip'; targetId: number; kind?: string }) =>
      db.listAnalysis(payload.targetType, payload.targetId, payload.kind)
  )

  /** 导出任务列表为 JSON（用户选路径） */
  ipcMain.handle('clips:exportJson', async (): Promise<OpResult<{ path: string; count: number }>> => {
    const tasks = db.listClips()
    if (!tasks.length) return { ok: false, message: '任务列表为空' }
    const win = getWindow()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const opts: SaveDialogOptions = {
      title: '导出切片任务',
      defaultPath: join(app.getPath('documents'), `切片任务-${stamp}.json`),
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }
    try {
      await writeFile(res.filePath, serializeClipTasks(tasks), 'utf8')
      approve(res.filePath)
      return { ok: true, data: { path: res.filePath, count: tasks.length } }
    } catch (err) {
      return { ok: false, message: `导出失败：${(err as Error).message}` }
    }
  })

  /** 从 JSON 导入任务（追加到现有列表） */
  ipcMain.handle(
    'clips:importJson',
    async (): Promise<OpResult<{ count: number; warnings: string[] }>> => {
      const win = getWindow()
      const opts: OpenDialogOptions = {
        title: '导入切片任务',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: '全部文件', extensions: ['*'] }
        ],
        properties: ['openFile']
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = res.canceled ? '' : res.filePaths[0]
      if (!file) return { ok: false, message: '已取消' }
      approve(file)
      try {
        const parsed = parseClipTasksJson(await readFile(file, 'utf8'))
        if (!parsed.tasks.length) {
          return { ok: false, message: `没有可导入的任务${parsed.warnings.length ? `（${parsed.warnings[0]}）` : ''}` }
        }
        // 导入的任务没有对应文档，docId 记 0（切片只需 bvid + 时间）
        // 导入的是**任务清单**（别人给你的待切列表）→ 同时排进队列
        const count = db.addClips(
          parsed.tasks.map((t) => ({
            docId: 0,
            bvid: t.bvid,
            page: t.page,
            start: t.start,
            end: t.end,
            note: t.note,
            segments: t.segments
          })),
          true
        )
        return { ok: true, data: { count, warnings: parsed.warnings } }
      } catch (err) {
        return { ok: false, message: `导入失败：${(err as Error).message}` }
      }
    }
  )

  ipcMain.handle('slice:history', (_e, limit?: number) => db.listSliceHistory(limit ?? 200))
  ipcMain.handle('slice:clearHistory', () => {
    db.clearSliceHistory()
    return true
  })

  /* --------------------------------- 设置 ---------------------------------- */

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

  /* ---------------------------- 浏览器用户脚本通信服务 ---------------------------- */

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
    const tasks = payload.tasks ?? []
    /**
     * 先把队列里对应的任务标成「进行中」。
     *
     * 3.7.0 起任务状态由这里维护（而不是跑完补一条历史）——
     * 否则界面上那条永远停在「排队中」，用户看不出到底在跑哪一条。
     */
    for (const t of tasks) {
      if (t.jobId) db.updateExportJobState(t.jobId, { state: 'running', progress: 0 })
    }
    try {
      const push = (p: SliceProgress): void => {
        // 进度同时写回任务表，这样剪辑任务页刷新后也能看到百分比
        if (p.note != null) {
          const job = tasks.find((t) => t.note === p.note && t.jobId)
          if (job?.jobId) db.updateExportJobState(job.jobId, { progress: p.percent })
        }
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('slice:progress', p)
        }
      }
      const result = await runSliceTasks(tasks, push, controller.signal)
      /**
       * 把结果写回**对应的任务**（而不是新建历史行）。
       *
       * 有 `jobId` 的更新那条任务；没有的（例如临时切片）才退回补一条记录，
       * 这样两种入口都能在「已完成」里看到。
       */
      try {
        const legacy: Array<Parameters<typeof db.recordSliceHistory>[0][number]> = []
        for (const e of result.entries) {
          const src = tasks[e.index] ?? ({} as SliceTaskInput)
          if (src.jobId) {
            db.updateExportJobState(src.jobId, {
              state: e.status === 'ok' ? 'done' : e.status === 'canceled' ? 'canceled' : 'failed',
              progress: e.status === 'ok' ? 100 : 0,
              output: e.output ?? '',
              message: e.message ?? ''
            })
          } else {
            legacy.push({
              clipId: src.clipId ?? null,
              note: e.note,
              bvid: src.bvid ?? '',
              page: src.page ?? 1,
              start: src.start ?? 0,
              end: src.end ?? 0,
              segments: src.segments,
              status: e.status,
              output: e.output ?? '',
              message: e.message ?? ''
            })
          }
        }
        if (legacy.length) db.recordSliceHistory(legacy)
      } catch {
        /* 历史写不进去不该让切片结果本身失败 */
      }
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

  /** 返回用户脚本路径与内容，设置页可以直接复制或打开所在文件夹 */
  ipcMain.handle('bridge:userscript', async () => {
    const candidates = userscriptCandidates()
    for (const file of candidates) {
      if (!existsSync(file)) continue
      try {
        return { path: file, exists: true, content: await readFile(file, 'utf8') }
      } catch {
        return { path: file, exists: true, content: '' }
      }
    }
    return { path: candidates[0] ?? '', exists: false, content: '' }
  })

  /** 只定位随应用提供的脚本，不接收任意路径；避免 .js 执行禁令误拦截“在文件管理器中显示”。 */
  ipcMain.handle('bridge:revealUserscript', async () => {
    const file = userscriptCandidates().find((candidate) =>
      !/[\\/]app\.asar[\\/]/i.test(candidate) && existsSync(candidate)
    )
    if (!file) return false
    // 打开目录而非执行 JS；openPath 会返回系统错误，设置页可以准确提示失败。
    return (await shell.openPath(dirname(file))) === ''
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

  /* ---------------------------------- 标签 ---------------------------------- */

  ipcMain.handle('tags:list', () => db.listTags())
  ipcMain.handle('tags:create', (_e, name: string) => {
    const id = db.createTag(name)
    return { id, tree: db.buildTree() }
  })
  ipcMain.handle('tags:rename', (_e, payload: { id: number; name: string }) => {
    db.renameTag(payload.id, payload.name)
    return db.buildTree()
  })
  ipcMain.handle('tags:delete', (_e, id: number) => {
    // 只删标签本身；视频、字幕都不受影响（video_tags 由外键级联清理）
    db.deleteTag(id)
    return db.buildTree()
  })
  ipcMain.handle('tags:ofVideo', (_e, videoId: number) => db.getVideoTagIds(videoId))
  ipcMain.handle('tags:setVideo', (_e, payload: { videoId: number; tagIds: number[] }) => {
    db.setVideoTags(payload.videoId, payload.tagIds ?? [])
    return db.buildTree()
  })

  /* ------------------------------ 语义检索（第四阶段下半） ----------------------------- */

  ipcMain.handle('semantic:status', (): SemanticStatus => embed.status())

  /** 下载模型（阻塞式，返回结果；进度通过 semantic:status 轮询） */
  ipcMain.handle('semantic:download', async (): Promise<OpResult<{ message: string }>> => {
    const res = await embed.downloadModelForApp()
    return { ok: res.ok, message: res.message, data: { message: res.message } }
  })

  ipcMain.handle('semantic:deleteModel', () => {
    embed.deleteModel()
    return embed.status()
  })

  /** 开始 / 继续建索引（后台跑，用 semantic:status 看进度） */
  ipcMain.handle('semantic:index', (): SemanticStatus => {
    void embed.startIndexing()
    return embed.status()
  })

  ipcMain.handle('semantic:stopIndex', (): SemanticStatus => {
    embed.stopIndexing()
    return embed.status()
  })

  /** 清空全部语义索引（改了模型或觉得结果不对时重建） */
  ipcMain.handle('semantic:clearIndex', (): SemanticStatus => {
    db.clearAllChunks()
    return embed.status()
  })

  /** 语义搜索：按意思找（与 FTS5 的关键词搜索互补） */
  ipcMain.handle(
    'semantic:search',
    async (_e, payload: { keyword: string; limit?: number }): Promise<OpResult<SemanticSearchResult>> => {
      try {
        const data = await embed.semanticSearch(payload?.keyword ?? '', payload?.limit ?? 50)
        return { ok: true, data }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  /** 模型缓存目录（设置页展示 + 手动放置模型文件用） */
  ipcMain.handle('semantic:modelPath', () => embed.modelPath())

  /* ------------------------------ AI 能力层（第六阶段） ----------------------------- */

  /** 探测 AI 后端是否可用（关掉时也返回明确原因，不会抛错） */
  ipcMain.handle('ai:status', (): Promise<AiStatus> => ai.probeAi())

  /**
   * 生成摘要 / 标签建议。
   * 结果写入 `analysis` 表（第三阶段就建好了），下次直接读，不重复烧 token。
   */
  ipcMain.handle(
    'ai:summary',
    async (
      _e,
      payload: { targetType: 'video' | 'doc'; targetId: number; title?: string }
    ): Promise<OpResult<AiResult>> => {
      try {
        const text = gatherText(payload.targetType, payload.targetId)
        if (!text) return { ok: false, message: '没有可分析的字幕内容' }
        const value = await ai.generateSummary(payload.title ?? '', text)
        const provider = ai.currentProviderName()
        db.saveAnalysis({
          targetType: payload.targetType,
          targetId: payload.targetId,
          kind: 'summary',
          payload: JSON.stringify({ text: value }),
          provider
        })
        return { ok: true, data: { kind: 'summary', value, provider, createdAt: Date.now() } }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'ai:tags',
    async (
      _e,
      payload: { targetType: 'video' | 'doc'; targetId: number; title?: string }
    ): Promise<OpResult<AiResult<AiTagSuggestion[]>>> => {
      try {
        const text = gatherText(payload.targetType, payload.targetId)
        if (!text) return { ok: false, message: '没有可分析的字幕内容' }
        const suggestions = await ai.generateTags(payload.title ?? '', text)
        if (!suggestions.length) return { ok: false, message: '模型没有给出可解析的标签建议' }
        // 标出哪些标签库里已经有了（界面据此显示「已有」/「新建」）
        const existing = new Set(db.listTags().map((t) => t.name))
        const withFlag = suggestions.map((s) => ({ ...s, exists: existing.has(s.name) }))
        const provider = ai.currentProviderName()
        db.saveAnalysis({
          targetType: payload.targetType,
          targetId: payload.targetId,
          kind: 'tags',
          payload: JSON.stringify({ tags: withFlag }),
          provider
        })
        return {
          ok: true,
          data: { kind: 'tags', value: withFlag, provider, createdAt: Date.now() }
        }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  /** 标题建议（给切片命名用，不落库：结果会被用户改，存了反而是垃圾） */
  ipcMain.handle(
    'ai:title',
    async (_e, payload: { text: string }): Promise<OpResult<string>> => {
      try {
        const value = await ai.generateTitle(payload?.text ?? '')
        if (!value) return { ok: false, message: '模型没有给出标题' }
        return { ok: true, data: value }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  /** 逐句解释（按 cue 存，同一句只留最新一条） */
  ipcMain.handle(
    'ai:explain',
    async (
      _e,
      payload: { docId: number; index: number }
    ): Promise<OpResult<AiResult>> => {
      try {
        const cues = db.loadCues(payload.docId)
        const target = cues.find((c) => c.index === payload.index)
        if (!target) return { ok: false, message: '找不到这条字幕' }
        const at = cues.findIndex((c) => c.index === payload.index)
        const context = cues
          .slice(Math.max(0, at - 3), at + 4)
          .map((c) => c.text)
          .join('\n')
        const value = await ai.explainCue(context, target.text)
        const provider = ai.currentProviderName()
        db.saveAnalysis({
          targetType: 'cue',
          // cue 没有独立主键，用 `docId * 1e6 + index` 拼一个稳定 id（同一句永远同一 id）
          targetId: payload.docId * 1_000_000 + payload.index,
          kind: 'explain',
          payload: JSON.stringify({ text: value, docId: payload.docId, index: payload.index }),
          provider
        })
        return { ok: true, data: { kind: 'explain', value, provider, createdAt: Date.now() } }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  /** 读取某个对象已存的 AI 结果（不调用模型） */
  ipcMain.handle(
    'ai:cached',
    (
      _e,
      payload: { targetType: 'video' | 'doc' | 'cue' | 'clip'; targetId: number; kind?: string }
    ) => db.listAnalysis(payload.targetType, payload.targetId, payload.kind)
  )

  /** 云端语义打分（没建本地索引时的替代路线） */
  ipcMain.handle(
    'ai:rank',
    async (
      _e,
      payload: { query: string; candidates: string[] }
    ): Promise<OpResult<number[]>> => {
      try {
        const scores = await ai.rankByMeaning(payload?.query ?? '', payload?.candidates ?? [])
        return { ok: true, data: scores }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  )

  /* --------------------------- AI 素材推荐（第八阶段） --------------------------- */

  /**
   * 语义双胞胎：找出**其它视频**里与指定片段讲同一件事的段落。
   * 用本地向量算，不需要外部模型、也不需要配 AI。
   */
  ipcMain.handle(
    'recommend:twins',
    (
      _e,
      payload: { chunkId?: number; docId?: number; second?: number; limit?: number }
    ): RecommendationResult =>
      recommendTwins({
        chunkId: payload?.chunkId,
        docId: payload?.docId,
        second: payload?.second,
        limit: payload?.limit
      })
  )

  /** 主题最鲜明的段落（挑高光用）：离视频铺陈基调最远 */
  ipcMain.handle(
    'recommend:highlights',
    (_e, payload: { videoId: number; limit?: number }): RecommendationResult =>
      recommendHighlights({ videoId: Number(payload?.videoId) || 0, limit: payload?.limit })
  )

  /** 最贴近整体基调的段落（做预告 / 选封面片段用） */
  ipcMain.handle(
    'recommend:typical',
    (_e, payload: { videoId: number; limit?: number }): RecommendationResult =>
      recommendTypical({ videoId: Number(payload?.videoId) || 0, limit: payload?.limit })
  )

  /**
   * 诊断用：抽样统计跨视频相似度分布。
   * 推荐阈值必须按语料标定，不能凭感觉猜 —— 这个接口就是用真实数据定阈值的工具。
   */
  ipcMain.handle('recommend:stats', (_e, payload: { samples?: number; topK?: number }) =>
    similarityStats(payload?.samples ?? 15, payload?.topK ?? 10)
  )

  /** 诊断用：直接看某个视频的原始向量（排查「自己和自己不像」这类解码问题） */
  ipcMain.handle('recommend:inspect', (_e, payload: { videoId: number }) =>
    inspectVideoVectors(Number(payload?.videoId) || 0)
  )

  /* ---------------------------- 知识图谱（第八阶段） ---------------------------- */

  /**
   * 建图（主题 → 视频 → 观点 → 片段）。
   *
   * 全程本地：分词用运行时自带的 `Intl.Segmenter`，观点句用启发式打分，
   * 不联网、不依赖 AI。建图可能要十几秒，所以**后台跑 + 轮询进度**，
   * 不让 IPC 一直挂着。
   */
  ipcMain.handle('graph:build', async (_e, payload: { rebuild?: boolean }): Promise<OpResult> => {
    if (graphStatus().busy) return { ok: false, message: '正在建图，请稍候' }
    // 故意不 await：立刻返回，界面去轮询 graph:status
    void buildGraph(Boolean(payload?.rebuild))
    return { ok: true, message: '已开始建图' }
  })

  ipcMain.handle('graph:cancel', (): void => cancelGraph())

  ipcMain.handle('graph:status', (): GraphProgress => graphStatus())

  /** 图谱规模 + 上次建图时间（界面据此提示「是否需要重建」） */
  ipcMain.handle('graph:counts', (): GraphCounts => {
    const c = db.graphCounts()
    return { ...c, builtAt: Number(db.getGraphMeta('builtAt') ?? 0) }
  })

  /** 主题列表（按覆盖视频数排序） */
  ipcMain.handle('graph:topics', (_e, payload: { keyword?: string; limit?: number }) =>
    db.listTopics(payload?.keyword ?? '', payload?.limit ?? 200)
  )

  /** 某个主题下的视频（「主题 → 视频」这一层） */
  ipcMain.handle('graph:topicVideos', (_e, payload: { topicId: number; limit?: number }) =>
    db.listTopicVideos(Number(payload?.topicId) || 0, payload?.limit ?? 100)
  )

  /** 某个视频的主题（「视频 → 主题」） */
  ipcMain.handle('graph:videoTopics', (_e, payload: { videoId: number; limit?: number }) =>
    db.listVideoTopics(Number(payload?.videoId) || 0, payload?.limit ?? 20)
  )

  /** 某个视频的观点句（「视频 → 观点」；观点句可一键加入切片任务） */
  ipcMain.handle('graph:viewpoints', (_e, payload: { videoId: number; limit?: number }) =>
    db.listViewpoints(Number(payload?.videoId) || 0, payload?.limit ?? 30)
  )

  /* -------------------------- 剪辑文案模板（第八阶段） -------------------------- */

  ipcMain.handle('template:list', () =>
    db.listCopyTemplates().map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      body: r.body,
      builtin: r.builtin === 1
    }))
  )

  ipcMain.handle(
    'template:save',
    (_e, payload: { id: string; name: string; description?: string; body: string }): OpResult => {
      const id = String(payload?.id ?? '').trim()
      const name = String(payload?.name ?? '').trim()
      const body = String(payload?.body ?? '')
      if (!id) return { ok: false, message: '模板 id 不能为空' }
      if (!name) return { ok: false, message: '模板名不能为空' }
      if (!body.trim()) return { ok: false, message: '模板内容不能为空' }
      // 内置模板允许改内容，但保留 builtin 标记（界面据此提示「这是内置的」）
      const existing = db.getCopyTemplate(id)
      db.saveCopyTemplate({
        id,
        name,
        description: payload?.description ?? '',
        body,
        builtin: existing?.builtin ?? 0
      })
      return { ok: true }
    }
  )

  ipcMain.handle('template:delete', (_e, id: string): OpResult => {
    const key = String(id ?? '').trim()
    if (!key) return { ok: false, message: '模板 id 不能为空' }
    db.deleteCopyTemplate(key)
    return { ok: true }
  })

  /* --------------------------- 发布素材包（第九阶段） --------------------------- */

  /**
   * 组装「发布素材包」的数据（不落盘）。
   *
   * 渲染进程负责把它显示给用户确认，用户点了导出再走 `kit:export`。
   * 分成两步的理由：写文件是**不可撤销**的动作，应该让用户先看到内容。
   */
  ipcMain.handle(
    'kit:build',
    (
      _e,
      payload: { title: string; description: string; tags: string[]; clipIds?: number[] }
    ): PublishKitData => buildKitData(payload)
  )

  /**
   * 导出素材包到磁盘。
   *
   * 目标目录：设置里的切片输出目录下再开一个包裹文件夹。
   * 已存在同名文件夹时不覆盖，而是加 `-2`/`-3` 后缀 ——
   * 覆盖用户已有的导出是最容易造成不可逆损失的操作，宁可多留几份。
   */
  ipcMain.handle(
    'kit:export',
    async (_e, payload: { data: PublishKitData }): Promise<OpResult<{ dir: string; files: number }>> => {
      try {
        const data = payload?.data
        if (!data?.folder) return { ok: false, message: '素材包内容为空' }
        const settings = loadSettings()
        const base = settings.sliceOutputDir?.trim() || settings.outputDir
        const target = uniqueDir(join(base, safeKitName(data.folder)))
        mkdirSync(target, { recursive: true })
        for (const file of data.files) {
          const full = join(target, ...file.path.split('/'))
          mkdirSync(dirname(full), { recursive: true })
          writeFileSync(full, file.content, 'utf8')
        }
        return { ok: true, data: { dir: target, files: data.files.length } }
      } catch (err) {
        return { ok: false, message: `导出失败：${(err as Error).message}` }
      }
    }
  )

  /* ------------------------------ 成片拼接（第九阶段） ------------------------------ */

  /**
   * 把多条片段合成一条成片。
   *
   * 进度靠 `compose:progress` 事件推（而不是 await 一个长请求）——
   * 切片 + 拼接可能几分钟，挂在 IPC 上界面会像卡死。
   */
  ipcMain.handle(
    'compose:run',
    async (_e, payload: { clipIds: number[]; title: string }): Promise<OpResult> => {
      if (composeAbort) return { ok: false, message: '已有成片任务在运行，请先取消' }
      const controller = new AbortController()
      composeAbort = controller
      void (async () => {
        try {
          const res = await composeMovie(
            payload?.clipIds ?? [],
            payload?.title ?? '成片',
            // 与切片进度同一套推法：直接发给窗口，不走 wire 的事件总线
            (p) => {
              const win = getWindow()
              if (win && !win.isDestroyed()) win.webContents.send('compose:progress', p)
            },
            controller.signal
          )
          const win = getWindow()
          if (win && !win.isDestroyed()) win.webContents.send('compose:done', res)
        } catch (err) {
          const win = getWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('compose:done', {
              ok: false,
              outputs: [],
              message: (err as Error).message
            })
          }
        } finally {
          composeAbort = null
        }
      })()
      return { ok: true, message: '已开始合成' }
    }
  )

  ipcMain.handle('compose:cancel', (): void => {
    composeAbort?.abort()
    composeAbort = null
  })

  /* --------------------------------- 数据管理 -------------------------------- */

  /** 备份整库到用户选定的文件（单个自洽的 .db，拿走即可） */
  ipcMain.handle('data:backup', async (): Promise<OpResult<{ path: string }>> => {
    const win = getWindow()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const opts: SaveDialogOptions = {
      title: '备份字幕库',
      defaultPath: join(app.getPath('documents'), `srt-tool-backup-${stamp}.db`),
      filters: [
        { name: 'SQLite 数据库', extensions: ['db'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }
    try {
      // VACUUM INTO 不会覆盖已存在的文件，先把空的占位删掉
      if (existsSync(res.filePath)) rmSync(res.filePath, { force: true })
      db.backupTo(res.filePath)
      approve(res.filePath)
      return { ok: true, data: { path: res.filePath } }
    } catch (err) {
      return { ok: false, message: `备份失败：${(err as Error).message}` }
    }
  })

  /** 从备份文件恢复整库（会先把当前库另存一份，失败则自动回滚） */
  ipcMain.handle('data:restore', async (): Promise<OpResult<{ path: string; backup: string }>> => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择要恢复的备份文件',
      filters: [
        { name: 'SQLite 数据库', extensions: ['db'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const source = res.canceled ? '' : res.filePaths[0]
    if (!source) return { ok: false, message: '已取消' }
    approve(source)

    if (!db.looksLikeSqliteFile(source)) {
      return { ok: false, message: '这个文件不是本工具的数据库备份（文件头不是 SQLite）' }
    }

    const target = db.dbFilePath()
    // 先关库并落盘，再把当前库另存一份，出问题好回滚
    db.closeDb()
    const safety = `${target}.before-restore-${Date.now()}`
    try {
      copyFileSync(target, safety)
      copyFileSync(source, target)
      // WAL/SHM 属于旧库，必须一起挪走，否则会与新库内容冲突
      rmSync(`${target}-wal`, { force: true })
      rmSync(`${target}-shm`, { force: true })
      db.reopenDb()
      db.stats() // 触发一次查询，确认新库确实能用
      return { ok: true, data: { path: source, backup: safety } }
    } catch (err) {
      // 回滚到恢复前的那份
      try {
        copyFileSync(safety, target)
        rmSync(`${target}-wal`, { force: true })
        rmSync(`${target}-shm`, { force: true })
      } catch {
        /* ignore */
      }
      try {
        db.reopenDb()
      } catch {
        /* ignore */
      }
      return { ok: false, message: `恢复失败，已回滚到原来的数据：${(err as Error).message}` }
    }
  })

  /** 导出诊断包：方便用户报 bug 时附上，不包含 Cookie 内容 */
  ipcMain.handle('data:diagnostics', async (): Promise<OpResult<{ path: string }>> => {
    const win = getWindow()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const opts: SaveDialogOptions = {
      title: '导出诊断信息',
      defaultPath: join(app.getPath('documents'), `srt-tool-diagnostics-${stamp}.json`),
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, message: '已取消' }

    const s = loadSettings()
    const probe = (p: string): { path: string; exists: boolean } => ({
      path: p || '',
      exists: Boolean(p) && existsSync(p)
    })
    const report = buildDiagnostics({
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      versions: {
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? ''
      },
      platform: { platform: process.platform, arch: process.arch, release: os.release() },
      stats: safe(() => db.stats()),
      paths: {
        userData: app.getPath('userData'),
        database: db.dbFilePath(),
        outputDir: probe(s.outputDir),
        sliceOutputDir: probe(s.sliceOutputDir),
        ffmpeg: probe(s.ffmpegPath),
        dataDir: probe(join(app.getPath('userData'), APP_DATA_DIR))
      },
      settings: s,
      bridge: safe(() => {
        const st = bridge.status()
        return { running: st.running, port: st.port, error: st.error, clients: st.clients.length }
      }),
      recentPluginEvents: safe(() => {
        const st = bridge.status()
        return st.lastEvent ? [st.lastEvent] : []
      })
    })

    try {
      await writeFile(res.filePath, JSON.stringify(report, null, 2), 'utf8')
      approve(res.filePath)
      return { ok: true, data: { path: res.filePath } }
    } catch (err) {
      return { ok: false, message: `导出失败：${(err as Error).message}` }
    }
  })

  /** 清空全部数据（不可撤销，需二次确认） */
  ipcMain.handle('data:clearAll', async (): Promise<OpResult<{ cleared: number }>> => {
    const win = getWindow()
    const opts = {
      type: 'warning' as const,
      buttons: ['取消', '确认清空'],
      defaultId: 0,
      cancelId: 0,
      title: '清空全部数据',
      message: '确定要清空所有视频、字幕与切片任务吗？',
      detail: '此操作不可撤销。建议先用「备份数据库」留一份。'
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (res.response !== 1) return { ok: false, message: '已取消' }
    return { ok: true, data: { cleared: db.clearAllData() } }
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
      ...userscriptCandidates().map((file) => dirname(file))
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

  /** 写系统剪贴板。走主进程而不是渲染进程的 Clipboard API —— 后者在 file:// 下不保证可用。 */
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    // 限制长度，避免渲染进程被注入后拿它做内存放大
    clipboard.writeText(String(text ?? '').slice(0, 500_000))
    return true
  })

  ipcMain.handle('shell:openPath', async (_e, target: string) => {
    if (!target) return '路径为空'
    if (!isSafeToOpen(target)) return `拒绝打开该路径（不在允许的目录内）：${target}`
    if (!existsSync(target)) return `路径不存在：${target}`
    return shell.openPath(target)
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    const safe = safeExternalUrl(url)
    if (!safe) return '仅支持有效且不含账号凭据的 http(s) 链接'
    await shell.openExternal(safe)
    return ''
  })

  ipcMain.handle('shell:showItem', (_e, target: string) => {
    if (!target || (!isSafeToOpen(target) && !isApproved(target)) || !existsSync(target)) return false
    shell.showItemInFolder(target)
    return true
  })
}
