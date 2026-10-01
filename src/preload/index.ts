import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  BiliTarget,
  Cue,
  OpResult,
  ParseResult,
  PullProgressInfo,
  SliceCheckResult,
  SliceProgressInfo,
  SliceRowLike,
  TreeNode
} from '@shared/types'
import type { BridgePageInfo, BridgeStatus } from '@shared/bridge'

export type SliceRowPayload = SliceRowLike

/** 订阅主进程推送，返回取消订阅函数 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /* 资源树 */
  listTree: (): Promise<TreeNode[]> => ipcRenderer.invoke('tree:list'),
  getStats: (): Promise<{
    uploaders: number
    collections: number
    videos: number
    docs: number
    clips: number
    missingCues: number
    dataDir: string
  }> => ipcRenderer.invoke('stats:get'),
  deleteNode: (key: string): Promise<{ tree: TreeNode[]; snapshot: unknown }> =>
    ipcRenderer.invoke('node:delete', key),
  /** 用删除时拿到的快照把整棵子树按原 id 写回去 */
  restoreNode: (snapshot: unknown): Promise<TreeNode[]> =>
    ipcRenderer.invoke('node:restore', snapshot),
  toggleFavorite: (key: string): Promise<TreeNode[]> => ipcRenderer.invoke('node:favorite', key),
  renameNode: (key: string, name: string): Promise<TreeNode[]> =>
    ipcRenderer.invoke('node:rename', { key, name }),

  /* 字幕 */
  getCues: (docId: number): Promise<Cue[]> => ipcRenderer.invoke('doc:cues', docId),
  updateCues: (docId: number, cues: Cue[]): Promise<boolean> =>
    ipcRenderer.invoke('doc:updateCues', docId, cues),
  /** 批量查找替换（支持正则） */
  replaceInDoc: (payload: {
    docId: number
    pattern: string
    replacement: string
    useRegex: boolean
    ignoreCase?: boolean
  }): Promise<OpResult<{ changed: number; total: number }>> =>
    ipcRenderer.invoke('doc:replace', payload),
  /** 整体平移 / 缩放时间轴 */
  shiftDocTime: (payload: {
    docId: number
    offsetMs: number
    scale?: number
  }): Promise<OpResult<{ count: number }>> => ipcRenderer.invoke('doc:shift', payload),
  /** 导出为 SRT / VTT / TXT */
  exportDocAs: (payload: {
    docId: number
    format: 'srt' | 'vtt' | 'txt'
    includeAllPages?: boolean
  }): Promise<OpResult<{ path: string; count: number }>> =>
    ipcRenderer.invoke('doc:exportAs', payload),
  /** 写系统剪贴板（走主进程，不依赖 file:// 下的 Clipboard API） */
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
  getDocMeta: (docId: number): Promise<any> => ipcRenderer.invoke('doc:meta', docId),

  /** 合并加载同一视频的所有分P 字幕（连续阅读） */
  loadMerged: (docId: number): Promise<any> => ipcRenderer.invoke('doc:loadMerged', docId),
  /** 按来源文档写回某一条字幕 */
  updateMergedCue: (docId: number, origIndex: number, text: string): Promise<boolean> =>
    ipcRenderer.invoke('doc:updateMergedCue', { docId, origIndex, text }),
  previewSrt: (path: string): Promise<ParseResult> => ipcRenderer.invoke('srt:preview', path),
  importSrt: (
    paths: string[],
    bvid?: string
  ): Promise<
    OpResult<{
      imported: number
      updated: number
      failures: string[]
      warnings: string[]
      notes: string[]
    }>
  > => ipcRenderer.invoke('srt:import', { paths, bvid }),

  /* B站 */
  loginStatus: (): Promise<{ loggedIn: boolean; name?: string; avatar?: string }> =>
    ipcRenderer.invoke('bili:loginStatus'),
  fetchVideo: (input: string): Promise<OpResult<{ videoId: number; info: any }>> =>
    ipcRenderer.invoke('bili:fetchVideo', input),
  listTracks: (
    videoId: number,
    page: number
  ): Promise<OpResult<{ tracks: Array<{ lang: string; label: string; url: string }>; cid?: number }>> =>
    ipcRenderer.invoke('bili:tracks', { videoId, page }),
  importTrack: (
    videoId: number,
    page: number,
    track: { lang: string; label: string; url: string }
  ): Promise<OpResult<{ docId: number; count: number }>> =>
    ipcRenderer.invoke('bili:importTrack', { videoId, page, track }),

  /** 解析任意 B 站链接，返回类型与视频列表 */
  resolveTarget: (input: string): Promise<OpResult<BiliTarget>> =>
    ipcRenderer.invoke('bili:resolve', input),

  /** 批量拉取字幕 */
  pullSubtitles: (
    videos: Array<{ bvid: string; title: string }>
  ): Promise<
    OpResult<{
      docs: number
      updated: number
      videos: number
      failed: number
      skipped: number
      messages: string[]
    }>
  > => ipcRenderer.invoke('bili:pull', { videos }),

  onPullProgress: (cb: (p: PullProgressInfo) => void) => subscribe('bili:pull-progress', cb),

  /* 全库检索 */
  searchLibrary: (payload: {
    keyword: string
    limit?: number
    uploaderId?: number
    collectionId?: number
    videoId?: number
  }): Promise<
    Array<{
      docId: number
      videoId: number
      bvid: string
      page: number
      index: number
      start: number
      end: number
      text: string
      videoTitle: string
      uploaderName: string
      docLabel: string
      uploaderId: number | null
      collectionId: number | null
    }>
  > => ipcRenderer.invoke('search:library', payload),
  addClipsFromSearch: (payload: {
    hits: Array<{
      docId: number
      bvid: string
      page: number
      start: number
      end: number
      text: string
    }>
    notePrefix?: string
  }): Promise<OpResult<{ count: number }>> => ipcRenderer.invoke('clips:addHits', payload),

  /* 切片任务 */
  listClips: (): Promise<any[]> => ipcRenderer.invoke('clips:list'),
  addClips: (payload: {
    docId: number
    bvid: string
    page: number
    ranges: Array<{
      start: number
      end: number
      segments?: Array<{ page: number; start: number; end: number }>
    }>
    notePrefix?: string
  }): Promise<OpResult<{ count: number }>> => ipcRenderer.invoke('clips:add', payload),
  deleteClip: (id: number): Promise<any[]> => ipcRenderer.invoke('clips:delete', id),
  clearClips: (): Promise<boolean> => ipcRenderer.invoke('clips:clear'),
  exportClips: (payload: {
    rows: SliceRowPayload[]
    format: 'csv' | 'xlsx'
    outPath?: string
  }): Promise<OpResult<{ path: string }>> => ipcRenderer.invoke('clips:export', payload),

  /* 设置 */
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', patch),
  checkEnv: (): Promise<any> => ipcRenderer.invoke('env:check'),

  /* 浏览器插件通信 */
  bridgeStatus: (): Promise<BridgeStatus> => ipcRenderer.invoke('bridge:status'),
  bridgeRestart: (port?: number): Promise<BridgeStatus> =>
    ipcRenderer.invoke('bridge:restart', port),
  requestSubtitles: (bvid: string, page: number, cid?: number | null): Promise<boolean> =>
    ipcRenderer.invoke('bridge:requestSubtitles', { bvid, page, cid }),
  extensionDir: (): Promise<{ path: string; exists: boolean }> =>
    ipcRenderer.invoke('bridge:extensionDir'),

  /* 本地切片 */
  sliceCheck: (): Promise<SliceCheckResult> => ipcRenderer.invoke('slice:check'),
  sliceRun: (
    tasks: Array<{
      bvid: string
      page: number
      start: number
      end: number
      note: string
      segments?: Array<{ page: number; start: number; end: number }>
    }>
  ): Promise<OpResult<{ ok: number; failed: number; outputs: string[]; messages: string[] }>> =>
    ipcRenderer.invoke('slice:run', { tasks }),
  sliceCancel: (): Promise<boolean> => ipcRenderer.invoke('slice:cancel'),
  onSliceProgress: (cb: (p: SliceProgressInfo) => void) => subscribe('slice:progress', cb),

  /* 主进程事件订阅（返回取消订阅函数） */
  onBridgeStatus: (cb: (s: BridgeStatus) => void) => subscribe('bridge:status', cb),
  onBridgePageInfo: (cb: (p: { info: BridgePageInfo; videoId: number | null; message?: string }) => void) =>
    subscribe('bridge:page-info', cb),
  onBridgeSubtitle: (
    cb: (p: {
      bvid: string
      page: number
      label: string
      ok: boolean
      docId: number | null
      count: number
      /** false 表示覆盖了同语言的已有字幕 */
      created: boolean
      /** true 表示没查到视频信息，暂时挂在「未关联」下 */
      unlinked: boolean
      title: string
    }) => void
  ) => subscribe('bridge:subtitle', cb),
  onBridgeLog: (cb: (p: { level: string; message: string }) => void) =>
    subscribe('bridge:log', cb),
  onDataWarning: (cb: (p: { missing: number; message: string }) => void) =>
    subscribe('data:warning', cb),
  onBridgeCookies: (
    cb: (p: {
      ok: boolean
      loggedIn?: boolean
      userName?: string
      count?: number
      message?: string
    }) => void
  ) => subscribe('bridge:cookies', cb),

  /* 数据管理 */
  /** 备份整库到用户选定的文件 */
  backupData: (): Promise<OpResult<{ path: string }>> => ipcRenderer.invoke('data:backup'),
  /** 从备份文件恢复整库（失败会自动回滚） */
  restoreData: (): Promise<OpResult<{ path: string; backup: string }>> =>
    ipcRenderer.invoke('data:restore'),
  /** 导出诊断信息（不含 Cookie 内容） */
  exportDiagnostics: (): Promise<OpResult<{ path: string }>> =>
    ipcRenderer.invoke('data:diagnostics'),
  /** 清空全部数据（需要二次确认） */
  clearAllData: (): Promise<OpResult<{ cleared: number }>> => ipcRenderer.invoke('data:clearAll'),

  /* 系统 */
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),
  pickDir: (defaultPath?: string): Promise<string> => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  pickFfmpeg: (): Promise<string> => ipcRenderer.invoke('dialog:pickFfmpeg'),
  saveFile: (defaultName: string, format: string): Promise<string> =>
    ipcRenderer.invoke('dialog:saveFile', { defaultName, format }),
  openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:openPath', target),
  openExternal: (url: string): Promise<string> => ipcRenderer.invoke('shell:openExternal', url),
  showItem: (target: string): Promise<boolean> => ipcRenderer.invoke('shell:showItem', target)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
