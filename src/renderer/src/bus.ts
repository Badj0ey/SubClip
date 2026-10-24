/**
 * 渲染进程内部事件总线（第一阶段-2）。
 *
 * 为什么要有它：组件之间原本靠 store 里的「信号字段 + watch」互相通知
 * （例如检索页让阅读器跳到某一句、插件让 App 弹出拉取对话框），
 * 这类跨组件意图用事件表达更直白，也避免 store 变成什么都往里塞的杂物间。
 *
 * 边界约定（重要，别越界）：
 * - **UI 内部**的「谁该做什么」用本总线；
 * - **主进程 ↔ 渲染进程**的数据与推送统一走 `ipcEvents.ts`，由它把
 *   Electron IPC 推送翻译成总线事件抛出来；
 * - **持久化状态**（资源树、字幕、切片任务、设置）只放 Pinia store，
 *   不要用事件传数据 —— 事件是「通知」，不是「存储」。
 *
 * 事件清单见 `AppEvents`，新增事件必须在这里补类型，且带命名空间前缀。
 */
import mitt from 'mitt'
import type { BridgeStatus } from '@shared/bridge'
import type {
  AppSettings,
  CueSearchHit,
  PullProgressInfo,
  SliceProgressInfo
} from '@shared/types'

/** 插件上报的「待确认批量拉取」信息 */
export interface PendingCollectionHint {
  pageType: string
  seasonId: number | null
  uid: number | null
  title: string
  url: string
}

/** 提示条（toast）请求 */
export interface ToastRequest {
  text: string
  type: 'info' | 'error' | 'success'
  /** 毫秒，缺省由 uiStore 决定 */
  duration?: number
}

/**
 * 全部应用级事件。
 *
 * 命名规则：`<域>.<动作>`。`video.* / subtitle.* / clip.* / search.* / task.*`
 * 这五个是提示词里点名的域，其余按需扩展。
 */
export type AppEvents = {
  /* ------------------------------- 视频 / 播放 ------------------------------- */
  /** 请求把视频预览跳到某个时间点（第二阶段接上 HTML5 Video 后消费） */
  'video.seek': { page: number; second: number }
  /** 视频预览的就绪状态变化（未接播放器时也可能被触发，消费方需容错） */
  'video.ready': { bvid: string; page: number }

  /* --------------------------------- 字幕 ---------------------------------- */
  /** 请求选中某一条字幕（按合并列表里的全局序号） */
  'subtitle.select': { index: number; shift?: boolean }
  /** 请求滚动定位到某一条（虚拟滚动下由阅读区实现） */
  'subtitle.scrollTo': { index: number }
  /** 请求进入编辑态 */
  'subtitle.edit': Record<string, never>
  /** 文档已切换（阅读区据此重算对照轨等） */
  'subtitle.docChanged': { docId: number | null }

  /* --------------------------------- 切片 ---------------------------------- */
  /** 请求把给定时间范围加入切片任务 */
  'clip.create': { ranges: Array<{ start: number; end: number }>; notePrefix?: string }
  /** 切片任务列表发生变化 */
  'clip.listChanged': { count: number }

  /* --------------------------------- 检索 ---------------------------------- */
  /** 请求跳到某条检索命中 */
  'search.jump': { hit: CueSearchHit }
  /** 请求打开 / 关闭全库检索视图 */
  'search.toggle': { open?: boolean }

  /* ------------------------------- 任务进度 -------------------------------- */
  /** 本地切片进度 */
  'task.update': SliceProgressInfo
  /** 批量拉取字幕进度 */
  'task.pull': PullProgressInfo

  /* --------------------------------- 通用 ---------------------------------- */
  /** 弹提示条 */
  'ui.toast': ToastRequest
  /** 插件连接状态变化 */
  'bridge.status': BridgeStatus
  /**
   * 插件协议版本比桌面端新（第七阶段）。
   * 目前消费方只提示用户更新桌面端；单独抛出事件是为了将来能做更细的处理
   * （例如按缺失能力禁用具体按钮）。
   */
  'bridge.versionSkew': {
    clientProtocol: number
    serverProtocol: number
    clientVersion: string
    clientBrowser: string
  }
  /** 插件检测到合集 / 收藏夹，请求用户确认批量拉取 */
  'bridge.collection': PendingCollectionHint
  /** 设置被重新加载 */
  'settings.changed': AppSettings
}

export const bus = mitt<AppEvents>()

/**
 * 类型安全地发事件。
 *
 * 直接用 `bus.emit` 也行，但包一层的好处是：载荷形状不对时 TS 立刻报错，
 * 而不是运行时才在某个监听器里炸。
 */
export function emit<K extends keyof AppEvents>(type: K, payload: AppEvents[K]): void {
  bus.emit(type, payload)
}

/** 订阅并返回取消订阅函数（组件 `onUnmounted` 里调用它，避免重复注册） */
export function on<K extends keyof AppEvents>(
  type: K,
  handler: (payload: AppEvents[K]) => void
): () => void {
  bus.on(type, handler)
  return () => bus.off(type, handler)
}
