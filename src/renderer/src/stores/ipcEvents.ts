/**
 * IPC 事件统一层（第一阶段-2）。
 *
 * 背景：主进程 → 渲染进程的推送原先散落在 `store.ts` 的一个大函数里
 * （`setupBridgeListeners`，十几个订阅混着 toast、刷新树的副作用）。
 * 结果是谁也说不清「一条插件消息最终会改动哪些东西」。
 *
 * 现在收成一处，规则很简单：
 * 1. 订阅 IPC 推送 → **翻译成总线事件**（`bus.emit`）；
 * 2. 更新 store 里对应的状态；
 * 3. 需要弹提示、刷新列表的副作用，各自找对应的 store 做。
 *
 * 组件只订阅总线事件，不再直接 `window.api.onXxx`，
 * 所以将来换通道（例如第二阶段加视频预览）只需改这里。
 */
import { useUiStore } from './ui'
import { useResourceStore } from './resource'
import { useClipStore } from './clip'
import { useSettingsStore } from './settings'
import { useSubtitleStore } from './subtitle'
import { useVideoStore } from './video'
import { emit, on } from '@renderer/bus'

/** 已注册的取消订阅函数（`disposeIpcEvents()` 用） */
let disposers: Array<() => void> = []

/**
 * 注册全部 IPC 推送监听。
 *
 * 幂等：重复调用会先解绑旧的，避免热更新时监听器越积越多
 * （开发模式下 electron-vite 会重建渲染进程，旧监听器不清掉会重复弹提示）。
 */
export function setupIpcEvents(): void {
  disposeIpcEvents()

  const ui = useUiStore()
  const resource = useResourceStore()
  const clip = useClipStore()
  const settings = useSettingsStore()

  const subs: Array<() => void> = []
  disposers = subs

  /* -------------------------------- 插件状态 -------------------------------- */

  subs.push(
    window.api.onBridgeStatus((s) => {
      ui.setBridge(s)
      emit('bridge.status', s)
    })
  )

  subs.push(
    window.api.onBridgePageInfo(({ info, videoId, message }) => {
      if (videoId) {
        ui.showToast(`插件已同步：${info.title || info.bvid}`, 'success')
        // 展开到刚同步的视频，但不影响其它已展开的分支
        void resource.load(`video:${videoId}`)
      } else {
        // 合集页 / 收藏夹 / 投稿页没有具体视频，不再因此建出空条目
        ui.showToast(message || '该页面没有可同步的视频', 'info', 4200)
        void resource.load()
      }
    })
  )

  /**
   * 插件字幕入库提示聚合。
   *
   * 批量补抓（收藏夹 / 系列 / 投稿页交给浏览器补抓）时，插件会逐视频逐分P
   * 推送字幕并逐条触发这里，单条 toast 的提示框会被连续顶掉、看起来在刷屏。
   * 因此按 2.5 秒静默窗口聚合：窗口内只有一条时沿用原详细文案，
   * 多条则汇总成一条；库树刷新（resource.load）也合并到窗口结束时做一次。
   * 单个视频的常规同步只产生一条消息，最多晚 2.5 秒显示，无感。
   */
  let subtitleAggTimer: ReturnType<typeof setTimeout> | null = null
  let subtitleAggNeedsLoad = false
  const subtitleAgg = {
    ok: 0,
    cues: 0,
    unlinked: 0,
    errors: 0,
    videos: new Set<string>(),
    last: '',
    lastUnlinked: false,
    lastError: ''
  }

  const flushSubtitleAgg = (): void => {
    subtitleAggTimer = null
    if (subtitleAggNeedsLoad) {
      subtitleAggNeedsLoad = false
      void resource.load()
    }
    const { ok, cues, unlinked, errors } = subtitleAgg
    if (ok === 1 && errors === 0) {
      // 单条：原样保留详细文案
      ui.showToast(subtitleAgg.last, subtitleAgg.lastUnlinked ? 'info' : 'success', subtitleAgg.lastUnlinked ? 5200 : 4000)
    } else if (ok > 1) {
      const extra: string[] = []
      if (unlinked) extra.push(`${unlinked} 条暂归「未关联」`)
      if (errors) extra.push(`${errors} 条失败`)
      ui.showToast(
        `插件批量导入完成：${subtitleAgg.videos.size} 个视频共 ${cues} 条字幕${extra.length ? `（${extra.join('，')}）` : ''}`,
        cues > 0 ? 'success' : 'error',
        5600
      )
    } else if (errors === 1) {
      ui.showToast(subtitleAgg.lastError, 'error', 4200)
    } else if (errors > 1) {
      ui.showToast(`插件补抓有 ${errors} 条字幕未入库，最近一条：${subtitleAgg.lastError}`, 'error', 5600)
    }
    subtitleAgg.ok = 0
    subtitleAgg.cues = 0
    subtitleAgg.unlinked = 0
    subtitleAgg.errors = 0
    subtitleAgg.videos.clear()
    subtitleAgg.last = ''
    subtitleAgg.lastUnlinked = false
    subtitleAgg.lastError = ''
  }

  const scheduleSubtitleFlush = (): void => {
    if (subtitleAggTimer) clearTimeout(subtitleAggTimer)
    subtitleAggTimer = setTimeout(flushSubtitleAgg, 2500)
  }

  subs.push(
    window.api.onBridgeSubtitle((p) => {
      if (!p.ok) {
        subtitleAgg.errors += 1
        subtitleAgg.lastError = `插件推送的字幕为空或缺少 BV 号：${p.bvid || '(无 BV 号)'} P${p.page}`
        subtitleAggNeedsLoad = true
        scheduleSubtitleFlush()
        return
      }
      subtitleAgg.ok += 1
      subtitleAgg.cues += p.count ?? 0
      if (p.unlinked) subtitleAgg.unlinked += 1
      if (p.bvid) subtitleAgg.videos.add(p.bvid)
      subtitleAggNeedsLoad = true
      subtitleAgg.last =
        `插件${p.created ? '已导入' : '已更新'}字幕：${p.label}（${p.count} 条）` +
        (p.unlinked
          ? '，暂时归入「未关联」，同步页面信息后会自动归位'
          : p.title
            ? ` → ${p.title}`
            : '')
      subtitleAgg.lastUnlinked = p.unlinked
      scheduleSubtitleFlush()
    })
  )
  // 组件卸载 / 热更新时清掉未触发的聚合定时器，避免卸载后还弹提示
  subs.push(() => {
    if (subtitleAggTimer) clearTimeout(subtitleAggTimer)
  })

  subs.push(
    window.api.onBridgeLog(({ level, message }) => {
      if (level === 'error' || level === 'warn') ui.showToast(message, 'error', 4200)
    })
  )

  /**
   * 插件协议版本高于桌面端（第七阶段）。
   *
   * 这种事必须让用户看见：后果是「插件的新功能在桌面端毫无反应」，
   * 而用户只会以为「功能坏了」。给一条能直接照做的提示（更新桌面端）。
   */
  subs.push(
    window.api.onBridgeVersionSkew((info) => {
      ui.showToast(
        `插件协议 v${info.clientProtocol} 比桌面端 v${info.serverProtocol} 新，` +
          '部分新功能可能不可用，请更新桌面端。',
        'error',
        9000
      )
      emit('bridge.versionSkew', info)
    })
  )

  /* -------------- 插件浏览到合集 / 系列 / 收藏夹：问用户是否批量拉取 -------------- */

  subs.push(
    window.api.onBridgeCollection((hint) => {
      if (!hint?.url) return
      // 这里不做「同一合集只问一次」的去重：插件端没有自动上报收藏页的路径，
      // 每一条无 bvid 的 page-info 都来自用户在插件上的显式点击，
      // 去重会把用户的重试静默吞掉（3.18.5 修复：重试永远重新弹框）。
      ui.pendingCollection = { ...hint }
      emit('bridge.collection', { ...hint })
      ui.showToast(
        `插件检测到${hint.pageType === 'favlist' ? '收藏夹' : hint.pageType === 'space' ? 'UP主投稿页' : hint.pageType === 'series' ? '系列' : '合集'}，已列出可拉取的视频`,
        'info',
        5200
      )
    })
  )

  /* -------------------- 插件请求拉取某视频字幕（全部分P） -------------------- */

  subs.push(
    window.api.onBridgePullProgress((p) => {
      ui.pluginPull = p
      emit('task.pull', p)
    })
  )

  subs.push(
    window.api.onBridgePull((p) => {
      ui.pluginPull = null
      if (p.browserFallback) {
        void resource.load()
        ui.showToast('桌面端已完成可获取部分，剩余分P正在由浏览器补抓', 'info', 5600)
        return
      }
      if (!p.ok) {
        if (p.needCookie) {
          ui.showToast(p.message || '桌面端缺少 B站登录状态', 'error', 8000)
        } else {
          ui.showToast(p.message || '拉取失败', 'error', 6000)
        }
        return
      }
      void resource.load()
      const { docs = 0, updated = 0, failed = 0, skipped = 0, videos = 0 } = p
      const parts: string[] = []
      if (docs) parts.push(`新增 ${docs} 条`)
      if (updated) parts.push(`更新 ${updated} 条`)
      if (skipped) parts.push(`${skipped} 个已齐全跳过`)
      if (failed) parts.push(`${failed} 个失败`)
      ui.showToast(
        parts.length
          ? `插件请求拉取完成：${parts.join('，')}（${videos} 个视频）`
          : '没有拉到新字幕，本地可能已是最新',
        docs + updated > 0 ? 'success' : 'info',
        5600
      )
      if (p.messages?.length) ui.showToast(p.messages.slice(0, 2).join('\n'), 'error', 7000)
    })
  )

  /* --------------------------------- 数据告警 -------------------------------- */

  subs.push(
    window.api.onDataWarning(({ message }) => {
      ui.showToast(message, 'error', 8000)
    })
  )

  /* ------------------------------ 插件同步登录态 ----------------------------- */

  subs.push(
    window.api.onBridgeCookies((p) => {
      if (p.ok) {
        ui.showToast(
          `已从浏览器同步登录状态${p.userName ? `（${p.userName}）` : ''}，现在可直接拉取字幕`,
          'success',
          4600
        )
        void settings.load()
        void loadBridgeStatusSafe()
      } else {
        ui.showToast(`登录状态同步失败：${p.message ?? '未知原因'}`, 'error', 4600)
      }
    })
  )

  /* -------------------------------- 切片进度 -------------------------------- */

  subs.push(
    window.api.onSliceProgress((p) => {
      ui.setSliceProgress(p)
      emit('task.update', p)
    })
  )

  // 批量拉取进度（桌面端自己在对话框里触发的那条路，与插件触发共用同一事件）
  subs.push(
    window.api.onPullProgress((p) => {
      emit('task.pull', p)
    })
  )
}

/** 统一读一次插件连接状态（失败就当服务没起，不抛给界面） */
async function loadBridgeStatusSafe(): Promise<void> {
  const ui = useUiStore()
  try {
    ui.setBridge(await window.api.bridgeStatus())
  } catch {
    ui.setBridge({ running: false, port: 0, error: '无法获取服务状态', clients: [], lastEvent: null, protocol: 0 })
  }
}

/** 解绑全部监听（热更新 / 退出时用） */
export function disposeIpcEvents(): void {
  for (const off of disposers) {
    try {
      off()
    } catch {
      /* 解绑失败无所谓，重点是不要中断后续解绑 */
    }
  }
  disposers = []
}

/* ------------------------------ 应用内事件接线 ----------------------------- */

/** 应用内事件总线的取消订阅函数 */
let busDisposers: Array<() => void> = []

/**
 * 把 store 之间「谁该跟着谁动」的关系接起来。
 *
 * 为什么要有这一层：状态拆分之后，subtitle 与 video 是两个 store，
 * 让 subtitle 直接 import video 会绕成循环依赖，让组件自己 watch 又会
 * 散落到各个 .vue 里。统一在事件层接线，两个 store 都只认识总线。
 *
 * 当前接线：
 * - `subtitle.select` → 视频预览跟随跳转（第二阶段）
 * - `clip.listChanged` → 无用（列表本身就是 store 状态），保留事件给将来用
 */
export function setupBusWiring(): void {
  disposeBusWiring()

  const video = useVideoStore()
  const subtitle = useSubtitleStore()

  busDisposers = [
    on('subtitle.select', ({ index }) => {
      const cue = subtitle.cues.find((c) => c.index === index)
      if (!cue) return
      void video.followCue(cue.page, cue.start, subtitle.video?.bvid)
    }),
    on('search.jump', ({ hit }) => {
      void video.followCue(hit.page, hit.start, hit.bvid)
    })
  ]
}

export function disposeBusWiring(): void {
  for (const off of busDisposers) {
    try {
      off()
    } catch {
      /* 同上 */
    }
  }
  busDisposers = []
}
