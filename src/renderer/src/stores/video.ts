/**
 * 视频预览 store（第二阶段）。
 *
 * 职责：把「当前分P 的可播放流」解析出来、暴露给 `<video>` 元素；
 * 维护播放位置与「点击字幕即跳到那一刻」的联动开关。
 *
 * 边界：
 * - 真正的字节由主进程的自定义协议 `bilistream://` 代取（CDN 校验 Referer，
 *   而 `<video>` 不允许自定义 Referer），这里只拿地址；
 * - DOM（video 元素）不进 store：播放器组件挂载时把自己的 seek / play 能力
 *   注册进来，store 通过回调驱动它（与 `subtitle` 的滚动定位同一套思路）。
 */
import { defineStore } from 'pinia'
import type { MediaSession } from '@shared/types'
import { emit } from '@renderer/bus'
import { useUiStore } from './ui'
import { useSubtitleStore } from './subtitle'
import { useSettingsStore } from './settings'

/** 播放器注册进来的能力（由 VideoPreview 组件在挂载 / 卸载时设置） */
interface PlayerHandle {
  seek: (second: number) => void
  play: () => void
  pause: () => void
}

let player: PlayerHandle | null = null
/** 当前句柄的注册者（用于避免旧实例卸载时清掉新实例的句柄，见 registerPlayer） */
let playerOwner = 0

export const useVideoStore = defineStore('video', {
  state: () => ({
    /** 当前预览会话（null 表示没有可预览的视频） */
    session: null as MediaSession | null,
    /** 正在解析播放地址 */
    loading: false,
    /** 解析失败原因（界面直接展示，例如「会员专享」） */
    error: '' as string,
    /** 当前播放位置（秒），由播放器上报 */
    position: 0,
    /** 播放中 */
    playing: false,
    /** 静音（默认静音：跟读场景下用户主要在读字幕） */
    muted: true,
    /** 用户手动关掉过自动跟随（本会话内有效，不写设置） */
    followSuppressed: false
  }),

  getters: {
    ready(state): boolean {
      return state.session != null
    },
    /** 是否有独立音轨需要单独播放（DASH 的音视频是分开的） */
    hasAudio(state): boolean {
      return state.session?.audio != null
    },
    /** 自动跟随是否生效（设置开关 + 用户本会话未手动关闭） */
    autoFollow(): boolean {
      return useSettingsStore().settings?.videoAutoFollow !== false && !this.followSuppressed
    },

    /**
     * 播放器句柄是否已注册。
     *
     * 暴露它是为了让界面能显示「播放按钮为什么按不动」——
     * `togglePlay()` 在句柄为空时静默返回，用户看到的就是「点了没反应」。
     */
    hasPlayer(): boolean {
      return player !== null
    }
  },

  actions: {
    /**
     * 组件挂载时注册播放能力。
     *
     * ## 为什么要带 `ownerId`
     *
     * `player` 是**模块级变量**（所有 VideoPreview 实例共享一个）。原来的写法是
     * 挂载时 `player = handle`、卸载时 `player = null` —— 这有竞态：
     * 切换视图会让 VideoPreview 卸载再挂载，若**旧实例的 unmount 晚于新实例的 mount**，
     * 旧实例就会把新实例刚注册的句柄清成 null，于是 `togglePlay()` 第一行
     * `if (!player) return` 静默失败 —— 用户看到的就是「播放按钮点了没反应」。
     *
     * 修法：注销时校验「我是不是当前注册者」，只有自己注册的才允许清空。
     * 这样新旧实例的先后顺序就不再影响结果。
     */
    registerPlayer(handle: PlayerHandle | null, ownerId = 0): void {
      if (handle === null) {
        // 只允许当前持有者注销自己，避免晚到的 unmount 清掉新实例的句柄
        if (playerOwner === ownerId) {
          player = null
          playerOwner = 0
        }
        return
      }
      player = handle
      playerOwner = ownerId
    },

    /**
     * 为某个分P 打开预览。
     *
     * 同一个 bvid + page 重复调用会直接复用（避免每次点击字幕都重新解析接口）。
     */
    async open(bvid: string, page: number): Promise<void> {
      const ui = useUiStore()
      if (!bvid) {
        this.error = '该字幕没有关联 BV 号（本地导入的字幕无法预览）'
        this.session = null
        return
      }
      const current = this.session
      if (current && current.bvid === bvid && current.page === page && !this.error) return

      this.loading = true
      this.error = ''
      try {
        // 换视频时先释放旧的会话，别让旧 CDN 连接挂着
        if (current && (current.bvid !== bvid || current.page !== page)) {
          await window.api.mediaClose()
          this.session = null
          this.position = 0
          this.playing = false
        }
        const res = await window.api.mediaOpen({ bvid, page })
        if (!res.ok || !res.data) {
          this.error = res.message || '无法解析播放地址'
          ui.showToast(this.error, 'error', 5200)
          return
        }
        this.session = res.data
        this.position = 0
        emit('video.ready', { bvid, page })
        if (!res.data.audio) {
          // 少数视频没有独立音频轨，说明一下，免得用户以为是静音 bug
          ui.showToast('该视频没有独立音频轨，预览将只有画面', 'info', 4200)
        }
      } catch (err) {
        this.error = (err as Error).message
        ui.showToast(`预览失败：${this.error}`, 'error', 5200)
      } finally {
        this.loading = false
      }
    },

    /** 关闭预览并释放会话 */
    async close(): Promise<void> {
      player?.pause()
      this.session = null
      this.error = ''
      this.position = 0
      this.playing = false
      try {
        await window.api.mediaClose()
      } catch {
        /* 关不掉也无所谓，会话有 TTL */
      }
    },

    /**
     * 跳到某个时间点。
     * 播放器没挂载时静默忽略 —— 用户可能只是没开预览面板。
     */
    seek(second: number, autoplay = false): void {
      if (!player) return
      player.seek(Math.max(0, second))
      this.position = Math.max(0, second)
      if (autoplay && !this.playing) player.play()
    },

    /**
     * 跳到某条字幕所在时刻。
     *
     * 只在「同一分P」时生效：当前预览的 P 与字幕所属 P 不同就先去打开那个 P，
     * 否则会把 P3 的时间点套到 P1 的视频上，位置完全对不上。
     */
    async followCue(page: number, second: number, bvid?: string): Promise<void> {
      if (!this.autoFollow) return
      const target = bvid || this.session?.bvid
      if (!target) return
      if (this.session && (this.session.page !== page || this.session.bvid !== target)) {
        await this.open(target, page)
      }
      this.seek(second)
    },

    togglePlay(): void {
      if (!player) return
      if (this.playing) player.pause()
      else player.play()
    },

    setPlaying(v: boolean): void {
      this.playing = v
    },

    setPosition(second: number): void {
      this.position = second
    },

    toggleMute(): void {
      this.muted = !this.muted
    },

    /** 用户手动关掉自动跟随（本会话内有效） */
    setFollowSuppressed(v: boolean): void {
      this.followSuppressed = v
    }
  }
})

/**
 * 供门面 / 快捷键使用：把「当前字幕」喂给播放器。
 * 放在 store 外面是因为要读 subtitle 的当前光标，跨 store 读会互相依赖。
 */
export function followCurrentCue(): void {
  const sub = useSubtitleStore()
  const video = useVideoStore()
  const cue = sub.cues.find((c) => c.index === sub.cursor)
  if (!cue) return
  void video.followCue(cue.page, cue.start, sub.video?.bvid)
}
