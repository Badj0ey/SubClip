/**
 * 界面 store（第一阶段-1）。
 *
 * 只放「当前界面长什么样」的状态：视图切换、提示条、插件连接与拉取进度。
 * 这些都是**易失**的（关掉应用即消失），不涉及持久化，也不掺业务数据。
 *
 * 插件 / 切片进度为什么放这里而不是各自的业务 store：
 * 它们的作用是「顶部告诉我正在进行什么」，属于纯展示状态；
 * 真正的任务数据（切片历史、字幕）在 clip / subtitle store 里。
 */
import { defineStore } from 'pinia'
import type { BridgeStatus } from '@shared/bridge'
import type { PullProgressInfo, SliceProgressInfo } from '@shared/types'
import type { PendingCollectionHint, ToastRequest } from '@renderer/bus'

/**
 * 一级导航的页面（3.5.0 重构）。
 *
 * 按用户的**主流程**组织：素材库 → 字幕检索 → 片段库 → 剪辑任务（+ 工作台概览）。
 *
 * - `library` 素材库：视频与字幕资源（原「工作区」）——
 *   它同时是「打开某个视频后的编辑工作区」，两种身份合并是刻意的：
 *   选素材与编辑素材本来就是同一条连续操作，分成两个页面反而要来回切。
 * - `clipjobs` 剪辑任务：片段输出成视频（新增一级页）——
 *   它原来埋在右侧面板里，和「当前选择」挤在一起，是一个被点名的架构问题。
 * - `settings` 不在导航里：它是全局入口，放在动作区（不参与主流程）。
 */
export type AppView = 'home' | 'library' | 'search' | 'clips' | 'clipjobs' | 'settings'

/** 出现在一级导航里的页面（不含 settings —— 它不参与主流程） */
export type AppNavKey = Exclude<AppView, 'settings'>

interface ToastState {
  text: string
  type: 'info' | 'error' | 'success'
  visible: boolean
  timer: number | null
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    /** 当前主视图 */
    view: 'library' as AppView,
    /** 加载态（打开文档等耗时操作） */
    loading: false,
    /** 需要聚焦的片段 id（首页点收藏片段 → 片段库高亮） */
    focusClipId: null as number | null,
    /** 提示条 */
    toast: { text: '', type: 'info', visible: false, timer: null } as ToastState,

    /* ------------------------------- 插件联动 ------------------------------- */
    bridge: null as BridgeStatus | null,
    /**
     * 插件浏览到合集 / 收藏夹时待用户确认的批量拉取。
     * App.vue 看到它就打开预填好的「拉取字幕」对话框。
     */
    pendingCollection: null as PendingCollectionHint | null,
    /** 插件请求拉取时的进度（用于顶部提示） */
    pluginPull: null as PullProgressInfo | null,

    /* ------------------------------- 本地切片 ------------------------------- */
    sliceRunning: false,
    sliceProgress: null as SliceProgressInfo | null,
    sliceResult: null as {
      ok: number
      failed: number
      outputs: string[]
      messages: string[]
    } | null
  }),

  getters: {
    pluginOnline(state): boolean {
      return (state.bridge?.clients.length ?? 0) > 0
    },
    /** 插件连接状态的一行人话描述（服务没起来时要给出原因，否则用户只能干瞪眼） */
    pluginTitle(state): string {
      const b = state.bridge
      if (!b) return '插件通信服务状态未知'
      if (!b.running) return b.error ? `服务未运行：${b.error}` : '插件通信服务未运行'
      if (!b.clients.length) return `服务运行中（ws://127.0.0.1:${b.port}），暂无插件连接`
      const c = b.clients[0]
      return `已连接 ${b.clients.length} 个插件（${c.browser} v${c.version}）`
    }
  },

  actions: {
    setView(view: AppView): void {
      this.view = view
    },

    /**
     * 在「工作区」与某视图之间来回切。
     *
     * @deprecated 3.5.0 起一级导航改为**纯切换语义**（`setView`）：
     * 「再点一次返回」与页签的直觉冲突 —— 用户点「片段库」预期是去片段库，
     * 而不是切过去 / 再点回来。保留此方法只为兼容既有调用（它会逐步清空）。
     */
    toggleView(view: Exclude<AppView, 'library'>): void {
      this.view = this.view === view ? 'library' : view
    },

    /**
     * 弹一条提示。
     * 同一个提示条复用：后来的会顶掉前一条并重置计时，避免排队等半天。
     */
    showToast(text: string, type: ToastState['type'] = 'info', duration = 2600): void {
      const t = this.toast
      if (t.timer) window.clearTimeout(t.timer)
      t.text = text
      t.type = type
      t.visible = true
      t.timer = window.setTimeout(() => {
        t.visible = false
        t.timer = null
      }, duration)
    },

    /** 供事件总线里的 `ui.toast` 使用 */
    toastFromBus(req: ToastRequest): void {
      this.showToast(req.text, req.type, req.duration ?? 2600)
    },

    setBridge(status: BridgeStatus | null): void {
      this.bridge = status
    },

    setSliceProgress(p: SliceProgressInfo): void {
      this.sliceProgress = p
    }
  }
})
