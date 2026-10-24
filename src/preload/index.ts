import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  AiResult,
  AiStatus,
  AiTagSuggestion,
  AnalysisRecord,
  AppSettings,
  BiliTarget,
  ClipTask,
  ClipDetailSummary,
  Cue,
  CueSearchPage,
  DanmakuResult,
  DashboardOverview,
  MediaSession,
  OpResult,
  ParseResult,
  PullProgressInfo,
  GraphCounts,
  GraphProgress,
  GraphTopic,
  GraphTopicVideo,
  GraphViewpoint,
  RecommendationResult,
  SemanticSearchResult,
  SemanticStatus,
  SliceCheckResult,
  SliceHistoryEntry,
  SliceProgressInfo,
  SliceRowLike,
  SubtitleDoc,
  TagInfo,
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
  /** 合并选中的若干条字幕 */
  mergeCues: (docId: number, indexes: number[]): Promise<OpResult<{ merged: number }>> =>
    ipcRenderer.invoke('doc:mergeCues', { docId, indexes }),
  /** 在某一条内部的时间点拆成两条 */
  splitCue: (docId: number, index: number, atSecond: number): Promise<OpResult<{ at: number }>> =>
    ipcRenderer.invoke('doc:splitCue', { docId, index, atSecond }),
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
  /** 同一视频的全部字幕轨（双语对照用） */
  listSiblingDocs: (docId: number): Promise<SubtitleDoc[]> =>
    ipcRenderer.invoke('doc:siblings', docId),
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
  /** 拖拽导入：主进程会自己校验扩展名与可读性，不走对话框白名单 */
  importDroppedSrt: (
    paths: string[]
  ): Promise<
    OpResult<{
      imported: number
      updated: number
      failures: string[]
      warnings: string[]
      notes: string[]
    }>
  > => ipcRenderer.invoke('srt:importDropped', paths),
  /**
   * 取拖入文件的真实路径。
   * Electron 32 起 `File.path` 被移除，只能用 preload 里的 webUtils 拿。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /* B站 */
  loginStatus: (): Promise<{ loggedIn: boolean; name?: string; avatar?: string }> =>
    ipcRenderer.invoke('bili:loginStatus'),
  /** 读取弹幕作为字幕定位辅助；force=true 跳过 10 分钟缓存 */
  getDanmaku: (bvid: string, force = false): Promise<OpResult<DanmakuResult>> =>
    ipcRenderer.invoke('bili:danmaku', bvid, force),
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

  /* 全库检索（第四阶段：排序权重 / 筛选 / 分页） */
  searchLibrary: (payload: {
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
  }): Promise<CueSearchPage> => ipcRenderer.invoke('search:library', payload),
  addClipsFromSearch: (payload: {
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

  /* 导出任务（3.6.0 拆表后与「片段」分开） */
  listPendingJobs: (): Promise<any[]> => ipcRenderer.invoke('jobs:listPending'),
  listAllJobs: (): Promise<any[]> => ipcRenderer.invoke('jobs:listAll'),
  enqueueJobs: (clipIds: number[]): Promise<number> => ipcRenderer.invoke('jobs:enqueue', clipIds),
  deleteJob: (id: number): Promise<any[]> => ipcRenderer.invoke('jobs:delete', id),
  clearPendingJobs: (): Promise<any[]> => ipcRenderer.invoke('jobs:clearPending'),
  retryJobs: (ids: number[]): Promise<number> => ipcRenderer.invoke('jobs:retry', ids),
  moveJob: (payload: { id: number; dir: -1 | 1 }): Promise<any[]> =>
    ipcRenderer.invoke('jobs:move', payload),

  /* 设置 */
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', patch),
  checkEnv: (): Promise<any> => ipcRenderer.invoke('env:check'),

  /* 浏览器用户脚本通信 */
  bridgeStatus: (): Promise<BridgeStatus> => ipcRenderer.invoke('bridge:status'),
  bridgeRestart: (port?: number): Promise<BridgeStatus> =>
    ipcRenderer.invoke('bridge:restart', port),
  requestSubtitles: (bvid: string, page: number, cid?: number | null): Promise<boolean> =>
    ipcRenderer.invoke('bridge:requestSubtitles', { bvid, page, cid }),
  userscript: (): Promise<{ path: string; exists: boolean; content: string }> =>
    ipcRenderer.invoke('bridge:userscript'),

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

  /** 首页 Dashboard 的全部卡片数据（第二阶段） */
  dashboardOverview: (): Promise<DashboardOverview> => ipcRenderer.invoke('dashboard:overview'),

  /* 视频预览（第二阶段）：解析 DASH 流并返回 bilistream:// 地址 */  mediaOpen: (payload: { bvid: string; page: number }): Promise<OpResult<MediaSession>> =>
    ipcRenderer.invoke('media:open', payload),
  /** 关闭全部预览会话（换视频 / 卸载播放器时调用） */
  mediaClose: (): Promise<boolean> => ipcRenderer.invoke('media:close'),

  /* 语义检索（第四阶段下半）：下载模型 / 建索引 / 按意思搜 */
  semanticStatus: (): Promise<SemanticStatus> => ipcRenderer.invoke('semantic:status'),
  semanticDownload: (): Promise<OpResult<{ message: string }>> =>
    ipcRenderer.invoke('semantic:download'),
  semanticDeleteModel: (): Promise<SemanticStatus> => ipcRenderer.invoke('semantic:deleteModel'),
  semanticIndex: (): Promise<SemanticStatus> => ipcRenderer.invoke('semantic:index'),
  semanticStopIndex: (): Promise<SemanticStatus> => ipcRenderer.invoke('semantic:stopIndex'),
  semanticClearIndex: (): Promise<SemanticStatus> => ipcRenderer.invoke('semantic:clearIndex'),
  semanticSearch: (payload: {
    keyword: string
    limit?: number
  }): Promise<OpResult<SemanticSearchResult>> => ipcRenderer.invoke('semantic:search', payload),
  semanticModelPath: (): Promise<string> => ipcRenderer.invoke('semantic:modelPath'),

  /* AI 能力层（第六阶段）：摘要 / 标签建议 / 标题 / 逐句解释 / 云端语义打分 */
  aiStatus: (): Promise<AiStatus> => ipcRenderer.invoke('ai:status'),
  aiSummary: (payload: {
    targetType: 'video' | 'doc'
    targetId: number
    title?: string
  }): Promise<OpResult<AiResult>> => ipcRenderer.invoke('ai:summary', payload),
  aiTags: (payload: {
    targetType: 'video' | 'doc'
    targetId: number
    title?: string
  }): Promise<OpResult<AiResult<AiTagSuggestion[]>>> => ipcRenderer.invoke('ai:tags', payload),
  aiTitle: (payload: { text: string }): Promise<OpResult<string>> =>
    ipcRenderer.invoke('ai:title', payload),
  aiExplain: (payload: { docId: number; index: number }): Promise<OpResult<AiResult>> =>
    ipcRenderer.invoke('ai:explain', payload),
  aiCached: (payload: {
    targetType: 'video' | 'doc' | 'cue' | 'clip'
    targetId: number
    kind?: string
  }): Promise<AnalysisRecord[]> => ipcRenderer.invoke('ai:cached', payload),
  aiRank: (payload: { query: string; candidates: string[] }): Promise<OpResult<number[]>> =>
    ipcRenderer.invoke('ai:rank', payload),

  /* AI 素材推荐（第八阶段）：用本地向量算，不需要外部模型 */
  recommendTwins: (payload: {
    chunkId?: number
    docId?: number
    second?: number
    limit?: number
  }): Promise<RecommendationResult> => ipcRenderer.invoke('recommend:twins', payload),
  recommendHighlights: (payload: {
    videoId: number
    limit?: number
  }): Promise<RecommendationResult> => ipcRenderer.invoke('recommend:highlights', payload),
  recommendTypical: (payload: {
    videoId: number
    limit?: number
  }): Promise<RecommendationResult> => ipcRenderer.invoke('recommend:typical', payload),
  /** 诊断用：抽样统计跨视频相似度分布（用于按真实语料标定推荐阈值） */
  recommendStats: (payload: {
    samples?: number
    topK?: number
  }): Promise<{
    samples: number
    avgTop: number
    avgMedian: number
    buckets: Array<{ range: string; count: number }>
    topTexts: string[]
  }> => ipcRenderer.invoke('recommend:stats', payload),
  /** 诊断用：直接看某个视频的原始向量（排查「自己和自己不像」这类解码问题） */
  recommendInspect: (payload: { videoId: number }): Promise<{
    count: number
    byteLengths: number[]
    firstElements: number[][]
    selfCosine: number
    storedCentroidBytes: number | null
    centroidFirstElements: number[]
  }> => ipcRenderer.invoke('recommend:inspect', payload),

  /* 知识图谱（第八阶段）：全部本地抽取，不联网、不依赖 AI */
  graphBuild: (payload: { rebuild?: boolean }): Promise<OpResult> =>
    ipcRenderer.invoke('graph:build', payload),
  graphCancel: (): Promise<void> => ipcRenderer.invoke('graph:cancel'),
  graphStatus: (): Promise<GraphProgress> => ipcRenderer.invoke('graph:status'),
  graphCounts: (): Promise<GraphCounts> => ipcRenderer.invoke('graph:counts'),
  graphTopics: (payload: {
    keyword?: string
    limit?: number
  }): Promise<GraphTopic[]> => ipcRenderer.invoke('graph:topics', payload),
  graphTopicVideos: (payload: {
    topicId: number
    limit?: number
  }): Promise<GraphTopicVideo[]> => ipcRenderer.invoke('graph:topicVideos', payload),
  graphVideoTopics: (payload: {
    videoId: number
    limit?: number
  }): Promise<GraphTopic[]> => ipcRenderer.invoke('graph:videoTopics', payload),
  graphViewpoints: (payload: {
    videoId: number
    limit?: number
  }): Promise<GraphViewpoint[]> => ipcRenderer.invoke('graph:viewpoints', payload),

  /* 剪辑文案模板（第八阶段）：模板 CRUD，渲染在渲染进程做（纯函数） */
  templateList: (): Promise<
    Array<{ id: string; name: string; description: string; body: string; builtin: boolean }>
  > => ipcRenderer.invoke('template:list'),
  templateSave: (payload: {
    id: string
    name: string
    description?: string
    body: string
  }): Promise<OpResult> => ipcRenderer.invoke('template:save', payload),
  templateDelete: (id: string): Promise<OpResult> => ipcRenderer.invoke('template:delete', id),

  /* 发布素材包（第九阶段）：装配与导出分离，导出前让用户先确认内容 */
  kitBuild: (payload: {
    title: string
    description: string
    tags: string[]
    clipIds?: number[]
  }): Promise<{
    folder: string
    files: Array<{ path: string; content: string }>
    clipCount: number
    totalDuration: number
    missingSubtitle: number[]
  }> => ipcRenderer.invoke('kit:build', payload),
  kitExport: (payload: {
    data: {
      folder: string
      files: Array<{ path: string; content: string }>
    }
  }): Promise<OpResult<{ dir: string; files: number }>> =>
    ipcRenderer.invoke('kit:export', payload),

  /* 成片拼接（第九阶段）：多条片段 → 一条 mp4 */
  composeRun: (payload: { clipIds: number[]; title: string }): Promise<OpResult> =>
    ipcRenderer.invoke('compose:run', payload),
  composeCancel: (): Promise<void> => ipcRenderer.invoke('compose:cancel'),
  onComposeProgress: (
    cb: (p: {
      phase: 'prepare' | 'slice' | 'concat' | 'done' | 'error'
      percent: number
      message: string
    }) => void
  ) => subscribe('compose:progress', cb),
  onComposeDone: (
    cb: (r: {
      ok: boolean
      output?: string
      outputs: string[]
      message?: string
      keptIntermediate?: string[]
    }) => void
  ) => subscribe('compose:done', cb),

  /* 主进程事件订阅（返回取消订阅函数） */
  onBridgeStatus: (cb: (s: BridgeStatus) => void) => subscribe('bridge:status', cb),
  onBridgePageInfo: (cb: (p: { info: BridgePageInfo; videoId: number | null; message?: string }) => void) =>
    subscribe('bridge:page-info', cb),
  /** 插件浏览到合集 / 收藏夹 / 投稿页：界面据此询问是否批量拉取 */
  onBridgeCollection: (
    cb: (p: {
      pageType: string
      seasonId: number | null
      uid: number | null
      title: string
      url: string
    }) => void
  ) => subscribe('bridge:collection', cb),
  /** 插件请求拉取某个视频的结果（成功或失败） */
  onBridgePull: (
    cb: (p: {
      bvid: string
      ok: boolean
      /** 桌面端缺登录态时为 true，界面据此引导去同步 */
      needCookie?: boolean
      message?: string
      docs?: number
      updated?: number
      videos?: number
      failed?: number
      skipped?: number
      messages?: string[]
    }) => void
  ) => subscribe('bridge:pull', cb),
  onBridgePullProgress: (cb: (p: PullProgressInfo) => void) =>
    subscribe('bridge:pull-progress', cb),
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
  /** 插件协议版本高于桌面端（第七阶段）：界面据此提示用户更新桌面端 */
  onBridgeVersionSkew: (
    cb: (p: {
      clientProtocol: number
      serverProtocol: number
      clientVersion: string
      clientBrowser: string
    }) => void
  ) => subscribe('bridge:version-skew', cb),
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

  /** 标签（需求文档 §6 的「分类」） */
  listTags: (): Promise<TagInfo[]> => ipcRenderer.invoke('tags:list'),
  createTag: (name: string): Promise<{ id: number; tree: TreeNode[] }> =>
    ipcRenderer.invoke('tags:create', name),
  renameTag: (id: number, name: string): Promise<TreeNode[]> =>
    ipcRenderer.invoke('tags:rename', { id, name }),
  deleteTag: (id: number): Promise<TreeNode[]> => ipcRenderer.invoke('tags:delete', id),
  /** 改颜色 / 备注（第三阶段） */
  updateTagMeta: (payload: { id: number; color?: string; note?: string }): Promise<TagInfo[]> =>
    ipcRenderer.invoke('tags:updateMeta', payload),
  getVideoTags: (videoId: number): Promise<number[]> =>
    ipcRenderer.invoke('tags:ofVideo', videoId),
  setVideoTags: (videoId: number, tagIds: number[]): Promise<TreeNode[]> =>
    ipcRenderer.invoke('tags:setVideo', { videoId, tagIds }),
  /** 批量给多个视频追加标签（第三阶段） */
  addTagsToVideos: (payload: { videoIds: number[]; tagIds: number[] }): Promise<OpResult<{ count: number }>> =>
    ipcRenderer.invoke('tags:addToVideos', payload),

  /* 片段（第三阶段）：切片任务 = 带名字与标签的时间范围收藏 */
  renameClipName: (id: number, name: string): Promise<ClipTask[]> =>
    ipcRenderer.invoke('clips:renameName', { id, name }),
  getClipTags: (clipId: number): Promise<number[]> => ipcRenderer.invoke('clips:tags', clipId),
  setClipTags: (clipId: number, tagIds: number[]): Promise<ClipTask[]> =>
    ipcRenderer.invoke('clips:setTags', { clipId, tagIds }),
  listClipIdsByTag: (tagId: number): Promise<number[]> =>
    ipcRenderer.invoke('clips:byTag', tagId),
  toggleClipFavorite: (clipId: number): Promise<{ favorite: boolean; tasks: ClipTask[] }> =>
    ipcRenderer.invoke('clips:favorite', clipId),
  /** 片段详情：所属视频 / 字幕 / 作者 / 标签 */
  getClipDetails: (clipIds: number[]): Promise<ClipDetailSummary[]> =>
    ipcRenderer.invoke('clips:details', clipIds),
  getClipDetail: (clipId: number): Promise<{
    clip: ClipTask
    docLabel: string
    videoTitle: string
    uploaderName: string
    creators: string[]
    tagIds: number[]
  } | null> => ipcRenderer.invoke('clips:detail', clipId),

  /** 按片段内容重新生成名称（第五阶段：把「前缀 #1」变成有意义的标题） */
  autoNameClips: (): Promise<OpResult<{ renamed: number }>> => ipcRenderer.invoke('clips:autoName'),

  /* 分析结果（第三阶段建表，第六阶段接 AIProvider 写入） */
  listAnalysis: (payload: {
    targetType: 'video' | 'doc' | 'cue' | 'clip'
    targetId: number
    kind?: string
  }): Promise<AnalysisRecord[]> => ipcRenderer.invoke('analysis:list', payload),

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

  /* 切片任务管理 / 历史 */
  moveClip: (id: number, dir: -1 | 1): Promise<ClipTask[]> =>
    ipcRenderer.invoke('clips:move', { id, dir }),
  renameClip: (id: number, note: string): Promise<ClipTask[]> =>
    ipcRenderer.invoke('clips:rename', { id, note }),
  exportClipsJson: (): Promise<OpResult<{ path: string; count: number }>> =>
    ipcRenderer.invoke('clips:exportJson'),
  importClipsJson: (): Promise<OpResult<{ count: number; warnings: string[] }>> =>
    ipcRenderer.invoke('clips:importJson'),
  listSliceHistory: (limit?: number): Promise<SliceHistoryEntry[]> =>
    ipcRenderer.invoke('slice:history', limit),
  clearSliceHistory: (): Promise<boolean> => ipcRenderer.invoke('slice:clearHistory'),

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
