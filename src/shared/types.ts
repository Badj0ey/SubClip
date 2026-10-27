/**
 * 全局共享类型定义：主进程 / 预加载 / 渲染进程三方共用。
 * 数据层级：UP主 → 合集 → 视频 → 字幕 → 切片任务
 */
import type { ShortcutMap } from './shortcuts'

/** UP主 */
export interface Uploader {
  id: number
  /**
   * B站用户 UID（接口返回的 `owner.mid`）。
   * 这是 UP主 的**唯一身份**：不管是桌面端拉取、插件推送还是本地导入，
   * 只要 UID 相同就归到同一个 UP主 节点下。
   * 只有确实拿不到 UID 的来源（纯本地文件、插件推送时查询失败）才为 null。
   */
  uid: number | null
  name: string
  avatar: string | null
  createdAt: number
}

/** 合集 / 系列 / 收藏夹 */
export interface Collection {
  id: number
  uploaderId: number | null
  /** 合集或系列 id */
  sid: string | null
  title: string
  url: string | null
  createdAt: number
}

/** 视频（对应一个 BV 号） */
export interface VideoItem {
  id: number
  collectionId: number | null
  bvid: string
  title: string
  url: string
  cover: string | null
  /** 总时长（秒） */
  duration: number | null
  /** 分P数量 */
  pageCount: number | null
  createdAt: number
}

/** 一个字幕文档（对应某个视频的某一 P、某种语言） */
export interface SubtitleDoc {
  id: number
  videoId: number
  /** 第几 P，从 1 开始 */
  page: number
  /** 语言代码，如 zh-CN / ai-zh */
  lang: string
  /** 展示名，如「简体中文（AI）」「本地文件」 */
  label: string
  filename: string
  source: 'local' | 'bilibili'
  createdAt: number
}

/** 单条字幕 */
export interface Cue {
  /** 在文档内的序号，从 1 开始 */
  index: number
  /** 开始时间（秒） */
  start: number
  /** 结束时间（秒） */
  end: number
  text: string
}

/**
 * 合并阅读时的字幕条目：同一视频的多个分P 首尾相接，统一重新编号。
 * 保留了来源信息，编辑与切片时才知道该写回哪个文档、属于哪个分P。
 */
export interface MergedCue extends Cue {
  /** 所属字幕文档 id */
  docId: number
  /** 所属分P */
  page: number
  /** 在该文档内的原始序号 */
  origIndex: number
}

/** 时间范围（由选中的字幕计算而来） */
export interface TimeRange {
  start: number
  end: number
  /** 组成该范围的字幕序号 */
  cueIndexes: number[]
  /** 按分P 拆分的子段（同一分P 内为一段；跨P 时会有多段） */
  segments?: Array<{ page: number; start: number; end: number }>
  /** 是否为跨分P 的合并切片 */
  crossPage?: boolean
}

/** 切片任务（导出给切片工具的一行） */
export interface ClipTask {
  id: number
  docId: number
  bvid: string
  page: number
  start: number
  end: number
  /** 备注 / 输出文件名 */
  note: string
  /**
   * 片段名称（第三阶段）。
   * 与 `note` 分开：名称是「你在库里找它的名字」，备注是「产物文件名」。
   */
  name: string
  /**
   * 片段来源（第三阶段）：
   * - `manual`：手动从字幕选区保存
   * - `search`：从全库检索结果批量加入
   * - `slice`：切片产物归档回来
   */
  source: 'manual' | 'search' | 'slice'
  /** 是否收藏（第三阶段：首页「收藏片段」） */
  favorite: boolean
  createdAt: number
  /**
   * 跨分P 切片：各分P 的独立时间段，依次裁剪后拼成一个视频。
   * 普通单段任务为空。
   */
  segments?: Array<{ page: number; start: number; end: number }>
}

export type NewClipTask = Omit<ClipTask, 'id' | 'createdAt' | 'name' | 'source' | 'favorite'> &
  Partial<Pick<ClipTask, 'name' | 'source' | 'favorite'>>

/** 标签（第三阶段升级：颜色 / 备注 / 多对象统计） */
export interface TagInfo {
  id: number
  name: string
  /** 十六进制颜色，空串表示用主题默认色 */
  color: string
  note: string
  /** 打了这个标签的视频数 */
  videoCount: number
  /** 打了这个标签的片段数 */
  clipCount: number
}

/** 分析结果（第三阶段建表，第六阶段接 AIProvider 写入） */
export interface AnalysisRecord {
  id: number
  targetType: 'video' | 'doc' | 'cue' | 'clip'
  targetId: number
  kind: string
  /** 结果 JSON 字符串（结构随 kind 变） */
  payload: string
  provider: string
  createdAt: number
}

/** 切片历史里的一条 */
export interface SliceHistoryEntry {
  id: number
  clipId: number | null
  note: string
  bvid: string
  page: number
  start: number
  end: number
  segments?: Array<{ page: number; start: number; end: number }>
  status: 'ok' | 'error' | 'canceled'
  output: string
  message: string
  createdAt: number
}

/** 资源树节点（渲染进程用） */
export interface TreeNode {
  key: string
  type: 'uploader' | 'collection' | 'video' | 'doc' | 'tags' | 'tag'
  label: string
  subtitle?: string
  favorite?: boolean
  children?: TreeNode[]
  /** 视频节点带上 id 与标签，便于右键打标签、直接展示标签 */
  videoId?: number
  tags?: string[]
  payload?: Uploader | Collection | VideoItem | SubtitleDoc
}

/** 应用设置 */
export interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  fontSize: number
  fontFamily: string
  lineHeight: number
  /** 面板宽度（像素），支持拖拽调整 */
  treePaneWidth: number
  taskPaneWidth: number
  /**
   * 中栏里「视频预览」的高度（像素，第二阶段）。
   * 预览在上、字幕阅读在下，中间可拖拽；这个值会被记住。
   */
  videoPaneHeight: number
  /** 自定义快捷键 */
  shortcuts: ShortcutMap
  /** 是否启用阅读条（滚动时放大突出屏幕偏上位置的字幕） */
  readLine: boolean
  /**
   * 视频预览：点击 / 移动选中字幕时，是否自动把播放器跳到那一刻（第二阶段）。
   * 默认开；不想要「跟读时播放器乱跳」的用户可以关掉。
   */
  videoAutoFollow: boolean
  /** 切片画质（B站 qn 值：16=360P 32=480P 64=720P 80=1080P 120=4K） */
  sliceQuality: number
  /** 切片并发下载数 */
  sliceConcurrency: number
  /**
   * 切片任务命名模板（备注字段即输出文件名）。
   * 占位符见 `@shared/naming` 的 NAME_TEMPLATE_TOKENS。
   */
  sliceNameTemplate: string
  /** ffmpeg 可执行文件路径（留空则自动查找） */
  ffmpegPath: string
  /** 切片输出目录（留空则用切片表输出目录） */
  sliceOutputDir: string
  /** 字幕缓存目录 */
  subtitleCacheDir: string
  /**
   * 外部切片工具（Edge 扩展 bilibili-slice-downloader）所在目录，可选。
   * 只服务于「导出表格 → 手动导入外部扩展」这条旧路径；本地切片已内置，留空即可。
   */
  sliceToolDir: string
  /** 切片表输出目录 */
  outputDir: string
  /** 浏览器用户脚本通信端口 */
  port: number
  /**
   * 插件配对令牌（可选，留空表示不校验）。
   * 留空时本地服务只靠 Origin 白名单挡网页；若在乎本机其它程序伪造 Origin，
   * 可以在这里设一个随机串，并在 B 站左下角浮框的「连接设置」里填同样的值。
   */
  bridgeToken: string
  /** B站 Cookie（拉取字幕需要登录态） */
  biliCookie: string

  /* ------------------------- 语义检索（第四阶段下半） ------------------------- */

  /** 语义检索用的 Embedding 模型（HuggingFace 仓库名） */
  embedModel: string
  /**
   * 模型下载源。默认 `https://hf-mirror.com`：
   * 实测本机直连 huggingface.co 会报「证书链不全」，而镜像能正常校验通过。
   */
  embedHost: string
  /**
   * 下载时是否放宽 TLS 校验（默认关）。
   *
   * 模型大文件会被镜像 302 到 `cas-bridge.xethub.hf.co`，那个域名的证书链在本机不全，
   * 严格校验下会下载失败。打开这个开关才能下下来 —— 代价是这一段下载不再防中间人。
   * 关着也能用：把模型文件按目录结构手动放进 `<userData>/embed-models/` 即可。
   */
  embedInsecureTls: boolean
  /** 语义检索索引的段落窗口（秒）。越大向量越少、越粗糙 */
  embedWindowSeconds: number

  /* ---------------------------- AI 能力层（第六阶段） ---------------------------- */

  /**
   * AI 后端：
   * - `ollama`：本地模型（默认，隐私好、免费，但需要用户装 Ollama）
   * - `openai`：任何 OpenAI 兼容接口（OpenAI / DeepSeek / 智谱 / vLLM / LM Studio…）
   * - `off`：关闭（**默认**）。基础功能不依赖 AI，所以默认必须是关的
   */
  aiProvider: 'off' | 'ollama' | 'openai'
  /** Ollama 服务地址 */
  aiOllamaUrl: string
  /** Ollama 使用的模型名（如 qwen2.5:7b） */
  aiOllamaModel: string
  /** OpenAI 兼容接口的 base URL（含 /v1） */
  aiOpenaiUrl: string
  /** OpenAI 兼容接口的 API Key（只存本地，不进诊断包） */
  aiOpenaiKey: string
  /** OpenAI 兼容接口的模型名 */
  aiOpenaiModel: string
  /** 生成温度（0~1，越低越稳定） */
  aiTemperature: number
  /** 单次请求超时（秒） */
  aiTimeoutSeconds: number
}

/** B站视频信息 */
export interface BiliVideoInfo {
  bvid: string
  /** 视频 avid；部分播放器字幕接口需要 aid + cid，单传 BV 号会得到空轨道。 */
  aid?: number
  title: string
  cover: string
  duration: number
  /** UP主 UID（B站接口字段名是 `owner.mid`，本地统一叫 uid） */
  ownerUid: number
  ownerName: string
  ownerAvatar: string
  /** 所属合集 id（ugc_season），没有则为 null */
  seasonId: number | null
  /** 所属合集标题 */
  seasonTitle: string | null
  pages: BiliPageInfo[]
  /** 视频弹幕总数（B站 `stat.danmaku`）；只用于判断“本来就没有弹幕”，不参与入库 */
  danmakuCount?: number
  /** 视频简介原文；直播回放投稿通常保留直播间链接 */
  desc?: string
}

/** B站分P信息 */
export interface BiliPageInfo {
  page: number
  cid: number
  title: string
  duration: number
}

/** B站字幕轨 */
export interface BiliSubtitleTrack {
  lang: string
  label: string
  /** 字幕 json 地址 */
  url: string
}

/** B站链接解析结果：类型 + 包含的视频列表 */
export type BiliTargetKind = 'video' | 'season' | 'series' | 'favlist' | 'space'

export interface BiliTargetVideo {
  bvid: string
  title: string
  cover?: string
  duration?: number
  /** 本地已有该视频的字幕（由主进程在解析时补齐） */
  exists?: boolean
}

export interface BiliTarget {
  kind: BiliTargetKind
  title: string
  url: string
  /** UP主 UID */
  uid: number | null
  sid: number | null
  videos: BiliTargetVideo[]
  /** 是否因分页上限被截断 */
  truncated: boolean
}

/** 批量拉取字幕的进度 */
export interface PullProgressInfo {
  current: number
  total: number
  title: string
  /** skipped 表示该视频已存在，被跳过 */
  status: 'running' | 'done' | 'skipped'
  message?: string
}

/** 本地切片进度 */
export interface SliceProgressInfo {
  index: number
  total: number
  note: string
  phase: 'resolve' | 'download' | 'cut' | 'done' | 'error'
  /** 0~100 */
  percent: number
  message?: string
}

/** ffmpeg 可用性检测结果 */
export interface SliceCheckResult {
  available: boolean
  ffmpeg: string
}

/** 切片表的一行（与 bilibili-slice-downloader 的表格列一一对应） */
export interface SliceRowLike {
  bvid: string
  page: number
  /** 开始时间（秒） */
  start: number
  /** 结束时间（秒） */
  end: number
  /** 备注 / 输出文件名 */
  note: string
}

/** 通用操作结果 */
export interface OpResult<T = unknown> {
  ok: boolean
  message?: string
  data?: T
}

/** 全库检索的一条命中（跨视频 / 跨分P） */
export interface CueSearchHit {
  docId: number
  videoId: number
  bvid: string
  page: number
  /** 在该文档内的原始序号（用于精确跳转到那一条） */
  index: number
  start: number
  end: number
  text: string
  videoTitle: string
  uploaderName: string
  docLabel: string
  uploaderId: number | null
  collectionId: number | null
  /**
   * 排序权重（第四阶段）：3 = 标题命中、2 = 字幕文件名命中、1 = 字幕正文命中。
   * 界面据此在结果左侧标出「标题命中」，也解释了为什么这条排得靠前。
   */
  hitWeight?: number
}

/** 检索过滤条件（第四阶段） */
export interface CueSearchFilters {
  /** 只搜某个 UP主 */
  uploaderId?: number
  /** 只搜某个合集 */
  collectionId?: number
  /** 只搜某个视频 */
  videoId?: number
  /** 只看带这些标签的视频（多个之间是「或」） */
  tagIds?: number[]
  /** 只要收藏过的视频 */
  favoriteOnly?: boolean
  /** 视频入库时间范围（毫秒时间戳，含边界） */
  createdFrom?: number
  createdTo?: number
  /** 单条字幕时长范围（秒）：用来找「短句」或「长段落」 */
  minDuration?: number
  maxDuration?: number
}

/** 全库检索的一页结果 */
export interface CueSearchPage {
  hits: CueSearchHit[]
  /** 命中总数（用于「共 N 条 / 已显示 M 条」与翻页） */
  total: number
  /** 本次实际返回的条数 */
  returned: number
  /** 是否是分页截断（还有更多） */
  hasMore: boolean
  /**
   * 命中数是否触顶（第四阶段）。
   * 命中判定包含「视频标题 / 字幕文件名」，按标题搜会命中该视频的每一条字幕，
   * 总量可能二十万+，此时只统计到上限为止（界面显示「5000+」并引导加筛选）。
   */
  totalCapped?: boolean
}

/* ------------------------------- 首页 Dashboard（第二阶段） ------------------------------ */

/** 首页卡片里的一条视频 */
export interface DashboardVideo {
  videoId: number
  bvid: string
  title: string
  uploaderName: string
  collectionId: number | null
  collectionTitle: string | null
  /** 该视频下已入库的字幕文档数 */
  docCount: number
  /** 该视频下**最早入库**的字幕文档 id（首页点一下直接打开它） */
  firstDocId: number | null
  createdAt: number
}

/** 首页卡片里的一条合集 / 分组 */
export interface DashboardCollection {
  collectionId: number
  title: string
  uploaderName: string
  videoCount: number
  /** 该分组下最近一次入库时间 */
  updatedAt: number
}

/** 首页「收藏片段」的一条：可能是收藏的视频，也可能是收藏的字幕文档 */
export interface DashboardFavorite {
  key: string
  type: 'video' | 'doc' | 'collection' | 'uploader'
  label: string
  /** 视频 / 字幕才有 BV 号 */
  bvid: string | null
  /** 字幕节点才有，点一下直接打开正文 */
  docId: number | null
  videoId: number | null
}

/** 首页一次性拉回的全部数据 */
export interface DashboardOverview {
  /** 全库真实数量（不受最近列表的 limit 影响） */
  totalVideos: number
  totalDocs: number
  recentVideos: DashboardVideo[]
  recentCollections: DashboardCollection[]
  favorites: DashboardFavorite[]
  /** 收藏的片段（第三阶段：片段本身就是「可收藏的时间范围」） */
  favoriteClips: ClipTask[]
  /** 库里有多少视频还没有任何字幕（「待处理」里的漏拉项） */
  videosWithoutDocs: number
  /** 已保存片段数（clips 表，非 export_jobs 任务数） */
  clipCount: number
}

/** 片段库列表所需的轻量详情；批量获取以避免 N 次 IPC。 */
export interface ClipDetailSummary {
  clipId: number
  docLabel: string
  videoTitle: string
  creators: string[]
  tagIds: number[]
}

/** 解析 SRT 的结果 */
export interface ParseResult {
  cues: Cue[]
  /** 解析过程中的告警（格式异常等） */
  warnings: string[]
}

/* --------------------------- AI 素材推荐（第八阶段） --------------------------- */

/** 推荐类型 */
export type RecommendKind =
  /** 与所选片段「讲的是同一件事」但来自**不同视频**的片段 */
  | 'twins'
  /** 该视频里**主题最鲜明**的段落（离视频铺陈基调最远）—— 挑高光用 */
  | 'highlight'
  /** 该视频里**最贴近整体基调**的段落（离语义中心最近）—— 挑预告/片段用 */
  | 'typical'

/** 一条推荐结果 */
export interface Recommendation {
  kind: RecommendKind
  /** 目标视频 */
  videoId: number
  videoTitle: string
  uploaderName: string
  bvid: string
  docId: number
  page: number
  /** 该段落第一句在文档内的序号（跳转定位用） */
  index: number
  start: number
  end: number
  /** 段落文本 */
  text: string
  /**
   * 相关度 0~1。
   * - `twins`：与给定片段的余弦相似度；
   * - `highlight`：该段落**离视频语义中心的距离**（越大 = 主题越鲜明、越不像铺陈）；
   * - `typical`：与视频语义中心的余弦相似度（越大 = 越贴近视频整体基调）。
   */
  score: number
  /** 这条推荐为什么被选出来（一句话，给用户看） */
  reason: string
}

/** 推荐结果 */
export interface RecommendationResult {
  kind: RecommendKind
  items: Recommendation[]
  /** 索引还没建完时为 true（结果可能不全） */
  partial: boolean
  /** 已索引段落数 / 总段落数 */
  indexedChunks: number
  totalChunks: number
  /** 没法给结果时的说明（例如「没有足够的向量」） */
  message?: string
}

/* --------------------------- 知识图谱（第八阶段） --------------------------- */

/** 图谱里的一个主题（从字幕文本抽出、跨视频聚合） */
export interface GraphTopic {
  id: number
  term: string
  /** 覆盖多少个视频 */
  videoCount: number
  /** 全库总命中次数 */
  totalCount: number
}

/** 主题下的一个视频 */
export interface GraphTopicVideo {
  videoId: number
  title: string
  bvid: string
  uploaderName: string
  /** 该主题在这个视频里出现多少次 */
  count: number
  /** 该主题在这个视频里的权重 */
  score: number
  /** 该视频有多少条观点句 */
  viewpoints: number
}

/** 一条观点句（图谱的「视频 → 观点」层；它同时指向「片段」） */
export interface GraphViewpoint {
  id: number
  videoId: number
  docId: number
  page: number
  index: number
  start: number
  end: number
  text: string
  score: number
}

/** 建图进度 */
export interface GraphProgress {
  busy: boolean
  phase: 'idle' | 'counting' | 'extracting' | 'done' | 'error'
  done: number
  total: number
  message: string
}

/** 图谱规模 */
export interface GraphCounts {
  topics: number
  viewpoints: number
  videos: number
  /** 上次建图时间（毫秒时间戳，0 表示从未建过） */
  builtAt: number
}

/* ------------------------------ 语义检索（第四阶段下半） ----------------------------- */

/** AI 后端连通性 / 可用性（第六阶段） */
export interface AiStatus {
  /** 设置里选的后端 */
  provider: 'off' | 'ollama' | 'openai'
  /** 是否可用（关掉时为 false；探测失败也是 false） */
  available: boolean
  /** 不可用的原因（界面直接展示） */
  message: string
  /** 当前后端可用的模型名（Ollama 会列出来；openai 只回报配置的那个） */
  models: string[]
  /** 探测耗时（毫秒） */
  latencyMs: number
}

/** AI 生成结果的元信息（与 analysis 表对应） */
export interface AiResult<T = string> {
  kind: string
  /** 生成内容（摘要 / 标题 / 标签建议的 JSON / 逐句解释） */
  value: T
  /** 谁生成的（provider + model，便于回溯） */
  provider: string
  createdAt: number
}

/** 标签建议（AI 返回的结构化结果，供人审核后落库） */
export interface AiTagSuggestion {
  /** 建议的标签名 */
  name: string
  /** 为什么建议它（给用户审核用：AI 生成 + 人审核） */
  reason: string
  /** 是否已存在于库里（界面据此显示「已有」还是「新建」） */
  exists?: boolean
}

/** 语义索引的状态（设置页与检索页都要显示） */
export interface SemanticStatus {
  /** 模型文件是否已下载到本地 */
  modelReady: boolean
  /** 模型占用体积（MB，未下载时为 0） */
  modelSizeMb: number
  /** 模型是否已加载进内存（首次语义搜索会触发加载） */
  loaded: boolean
  /** 需要索引的段落总数 */
  totalChunks: number
  /** 已索引段落数 */
  indexedChunks: number
  /** 当前是否正在建索引 */
  indexing: boolean
  /** 正在加载模型 / 下载模型 */
  busy: 'idle' | 'downloading' | 'loading' | 'indexing'
  /** 进度文案（下载 / 加载 / 索引时给用户看的） */
  message: string
}

/** 语义检索的一条命中 */
export interface SemanticHit {
  docId: number
  videoId: number
  bvid: string
  page: number
  /** 该段落第一句在文档内的序号（供跳转定位） */
  index: number
  start: number
  end: number
  /** 段落拼接后的文本 */
  text: string
  videoTitle: string
  uploaderName: string
  docLabel: string
  uploaderId: number | null
  collectionId: number | null
  /** 余弦相似度（0~1，越大越像） */
  score: number
}

/** 语义搜索结果 */
export interface SemanticSearchResult {
  hits: SemanticHit[]
  /** 索引还没建完时为 true，界面要提示「结果可能不全」 */
  partial: boolean
  /** 已索引的段落数 / 总段落数 */
  indexedChunks: number
  totalChunks: number
}

/* ------------------------------- 视频预览（第二阶段） ------------------------------ */

/**
 * 一条可播放的音 / 视频轨。
 *
 * `url` 是主进程自定义协议地址（`bilistream://...`），不是 B站 CDN 原地址：
 * CDN 校验 Referer，而 `<video>` 不允许自定义 Referer，
 * 所以字节由主进程带正确请求头代取（见 `src/main/media.ts`）。
 */
export interface MediaTrack {
  /** 可直接塞给 `<video>` / `<audio>` 的 src */
  url: string
  codec: string
  /** 期望画质（B站 qn 值），实际可能被降级 */
  quality: number
}

/** 一次视频预览会话 */
export interface MediaSession {
  /** 会话令牌（出现在 url 里；关闭时用它失效） */
  token: string
  bvid: string
  page: number
  /** 该分P 标题 */
  title: string
  /** 总时长（秒） */
  duration: number
  video: MediaTrack
  /** DASH 音频轨；个别视频没有则为 null */
  audio: MediaTrack | null
}

/* --------------------------------- 弹幕参考（3.17.0） -------------------------------- */

/**
 * 一条弹幕。
 *
 * 弹幕只作为字幕定位的辅助信息，**不入库、不参与全文检索、不进入导出**；
 * `time` 是该分P 内的相对秒数，与字幕的 `start` / `end` 同一时间基准。
 */
export interface DanmakuItem {
  /** B站弹幕 id（新版接口取 idStr；缺失时由解析器生成兜底值） */
  id: string
  /** 分P 序号 */
  page: number
  /** 相对该分P 开头的秒数 */
  time: number
  text: string
  /** 弹幕模式（1 滚动、4 底部、5 顶部等） */
  mode: number
  /** RGB 颜色值，默认白色 0xffffff */
  color: number
}

/** 视频没有弹幕时的原因，供面板显示准确说明 */
export type DanmakuEmptyReason = 'live-replay' | 'no-danmaku'

/** 一次弹幕读取的结果 */
export interface DanmakuResult {
  bvid: string
  /** 该视频的分P 数（不一定都已读到弹幕） */
  pages: number
  items: DanmakuItem[]
  /** 因分段 / 条数 / 时间预算限制而只读到部分弹幕 */
  truncated: boolean
  /** 部分分P 或分段失败时的可读提示；不影响字幕功能 */
  warnings: string[]
  /** 弹幕为空时更具体的原因：直播回放，或视频本来就没有弹幕 */
  emptyReason?: DanmakuEmptyReason
}
