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
  createdAt: number
  /**
   * 跨分P 切片：各分P 的独立时间段，依次裁剪后拼成一个视频。
   * 普通单段任务为空。
   */
  segments?: Array<{ page: number; start: number; end: number }>
}

/** 资源树节点（渲染进程用） */
export interface TreeNode {
  key: string
  type: 'uploader' | 'collection' | 'video' | 'doc'
  label: string
  subtitle?: string
  favorite?: boolean
  children?: TreeNode[]
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
  /** 自定义快捷键 */
  shortcuts: ShortcutMap
  /** 是否启用阅读条（滚动时放大突出屏幕偏上位置的字幕） */
  readLine: boolean
  /** 切片画质（B站 qn 值：16=360P 32=480P 64=720P 80=1080P 120=4K） */
  sliceQuality: number
  /** 切片并发下载数 */
  sliceConcurrency: number
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
  /** 浏览器插件通信端口 */
  port: number
  /**
   * 插件配对令牌（可选，留空表示不校验）。
   * 留空时本地服务只靠 Origin 白名单挡网页；若在乎本机其它程序伪造 Origin，
   * 可以在这里设一个随机串，并在插件弹窗里填同样的值。
   */
  bridgeToken: string
  /** B站 Cookie（拉取字幕需要登录态） */
  biliCookie: string
}

/** B站视频信息 */
export interface BiliVideoInfo {
  bvid: string
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

/** 解析 SRT 的结果 */
export interface ParseResult {
  cues: Cue[]
  /** 解析过程中的告警（格式异常等） */
  warnings: string[]
}
