<script setup lang="ts">
/**
 * 视频预览（第二阶段）。
 *
 * ## DASH 为什么是两个元素
 *
 * B站给的是 DASH：视频轨与音频轨是**两个独立文件**，`<video>` 只能播其中一个。
 * 所以这里用一个 `<video>` 出画面 + 一个 `<audio>` 出声音，两者靠
 * `timeupdate` / `seeking` / `ratechange` 三个事件互相对齐。
 * （用 MSE 自己拼 mp4 理论上也行，但那要引入 demuxer，收益不成比例。）
 *
 * ## 为什么 src 是 bilistream://
 *
 * CDN 校验 Referer，而 `<video>` 不允许自定义 Referer，
 * 因此字节由主进程带正确请求头代取。详见 `src/main/media.ts`。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { formatTime } from '@shared/time'
import { QUALITY_OPTIONS } from '@shared/constants'
import { useVideoStore } from '../stores/video'
import { useSubtitleStore } from '../stores/subtitle'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

const video = useVideoStore()
const sub = useSubtitleStore()
const settings = useSettingsStore()
const ui = useUiStore()

/**
 * 收起预览（3.8.0）。
 *
 * 只发事件、不改自己的可见性：可见性由 App.vue 的中栏布局决定
 * （收起时整个组件会被卸载，字幕阅读占满中栏），
 * 组件自己藏自己会和布局状态两处打架。
 */
const emit = defineEmits<{ (e: 'collapse'): void }>()

const vEl = ref<HTMLVideoElement | null>(null)
const aEl = ref<HTMLAudioElement | null>(null)

/** 拖动进度条时不回写位置，避免和播放器打架 */
const scrubbing = ref(false)
const scrubValue = ref(0)

const duration = computed(() => video.session?.duration || 0)
const progressPercent = computed(() =>
  duration.value ? Math.min(100, (video.position / duration.value) * 100) : 0
)

/* ------------------------------ 音视频对齐 ------------------------------ */

/** 把音频元素对齐到视频元素（差值超过 120ms 才纠，避免一直在微调抖动） */
function syncAudio(): void {
  const v = vEl.value
  const a = aEl.value
  if (!v || !a) return
  if (Math.abs(a.currentTime - v.currentTime) > 0.12) a.currentTime = v.currentTime
  a.playbackRate = v.playbackRate
}

function onVideoTime(): void {
  const v = vEl.value
  if (!v) return
  if (!scrubbing.value) video.setPosition(v.currentTime)
  syncAudio()
}

async function onPlay(): Promise<void> {
  video.setPlaying(true)
  try {
    await aEl.value?.play()
  } catch {
    /* 没有音轨或自动播放被拦，画面照常 */
  }
}

function onPause(): void {
  video.setPlaying(false)
  aEl.value?.pause()
}

function onSeeking(): void {
  syncAudio()
}

function onVolume(): void {
  if (aEl.value) aEl.value.muted = video.muted
}

/* ------------------------------ 玩家能力注册 ----------------------------- */

/**
 * 把 seek / play / pause 注册给 store。
 * store 不碰 DOM，所以视频跳转统一从这里走（点击字幕、快捷键都受益）。
 */
/**
 * 本组件实例的注册标识。
 *
 * 传给 store 用于「注销时校验我是不是当前注册者」——
 * 切视图会让本组件卸载再挂载，若旧实例的 unmount 晚于新实例的 mount，
 * 旧实例会把新句柄清成 null，播放按钮就静默失效了（实测踩到过）。
 */
const ownerId = Math.random()

/**
 * 播放 / 暂停（由组件自己直接操作媒体元素）。
 *
 * ## 为什么不走 store 的 `togglePlay()`
 *
 * store 里的播放能力是通过 `registerPlayer()` **注册进来的回调**，
 * 存在模块级变量里。而 VideoPreview 会随视图切换卸载/挂载，
 * 这个注册-注销的过程有生命周期竞态：实测出现过「注册计数=1，但句柄已是 null」，
 * 于是 `togglePlay()` 第一行 `if (!player) return` **静默失败** ——
 * 用户看到的就是「播放按钮点了没反应」，而且没有任何提示。
 *
 * 按钮是**本组件自己的 DOM**，直接操作 `vEl` 最直接，也不受注册时序影响；
 * store 的注册仍然保留（点字幕定位、跟随等跨组件链路需要它）。
 */
function togglePlayLocal(): void {
  const v = vEl.value
  if (!v) return
  if (v.paused) {
    void v
      .play()
      .then(() => {
        video.setPlaying(true)
      })
      .catch((err: Error) => {
        // 不再静默失败：播不动必须告诉用户为什么
        ui.showToast(`无法播放：${err.message}`, 'error')
      })
  } else {
    v.pause()
    video.setPlaying(false)
  }
}

function registerHandle(): void {
  video.registerPlayer(
    {
      seek: (second) => {
        const v = vEl.value
        if (!v) return
        v.currentTime = Math.max(0, Math.min(second, duration.value || second))
        syncAudio()
      },
      play: () => {
        void vEl.value?.play()
      },
      pause: () => {
        vEl.value?.pause()
      }
    },
    ownerId
  )
}

watch(vEl, () => registerHandle())

onBeforeUnmount(() => {
  video.registerPlayer(null, ownerId)
})

/* --------------------------------- 交互 --------------------------------- */

function onScrubInput(e: Event): void {
  scrubValue.value = Number((e.target as HTMLInputElement).value)
}

function onScrubCommit(): void {
  const second = scrubValue.value
  scrubbing.value = false
  const v = vEl.value
  if (v) v.currentTime = second
  video.setPosition(second)
  syncAudio()
}

function toggleFollow(): void {
  video.setFollowSuppressed(!video.followSuppressed)
  ui.showToast(video.followSuppressed ? '已关闭自动跟随字幕' : '已开启自动跟随字幕', 'info')
}

/** 把播放器对齐到当前光标那条字幕 */
function jumpToCursor(): void {
  const cue = sub.cues.find((c) => c.index === sub.cursor)
  if (!cue) return
  void video.followCue(cue.page, cue.start, sub.video?.bvid)
}

const errorText = computed(() => video.error)

/** 把 B站 qn 值翻成人看的画质名（原来直接显示 `80P画质`，很误导） */
const qualityLabel = computed(() => {
  const q = video.session?.video.quality ?? 0
  return QUALITY_OPTIONS.find((o) => o.value === q)?.label ?? (q ? `qn ${q}` : '')
})
const hint = computed(() => {
  if (video.loading) return '正在解析播放地址…'
  if (errorText.value) return errorText.value
  if (!sub.video?.bvid) return '当前字幕没有关联的 B站视频'
  return '打开一个字幕文档即可预览'
})
</script>

<template>
  <section class="pane preview-pane" role="region" aria-label="视频预览">
    <div class="pane-head">
      <strong style="font-size: 13px">视频预览</strong>
      <span v-if="video.session" class="muted" style="font-size: 12px">
        P{{ video.session.page }} · {{ qualityLabel }}
      </span>
      <span class="grow"></span>

      <button
        class="btn sm"
        :disabled="!video.ready"
        :title="video.muted ? '取消静音' : '静音'"
        @click="video.toggleMute()"
      >
        {{ video.muted ? '🔇' : '🔊' }}
      </button>
      <button
        class="btn sm"
        :class="{ primary: video.autoFollow }"
        :title="video.autoFollow ? '点击字幕时播放器会跟随（点击可关闭）' : '自动跟随已关闭'"
        :disabled="!video.ready"
        @click="toggleFollow"
      >
        跟随
      </button>
      <button class="btn sm" :disabled="!video.ready" title="跳到当前字幕" @click="jumpToCursor">
        同步
      </button>
      <button
        class="btn sm"
        type="button"
        title="收起预览，让字幕阅读占满中栏（可随时展开）"
        @click="emit('collapse')"
      >
        收起
      </button>
    </div>

    <div class="pane-body preview-body">
      <div v-if="!video.session" class="empty preview-empty">
        <div class="preview-ico">🎬</div>
        <div>{{ hint }}</div>
        <div v-if="errorText" class="muted" style="font-size: 12px">
          若视频为会员专享 / 地区限制，需要先在设置里配置登录状态
        </div>
      </div>

      <template v-else>
        <!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
        <video
          ref="vEl"
          class="preview-video"
          :src="video.session.video.url"
          muted
          playsinline
          preload="metadata"
          @timeupdate="onVideoTime"
          @play="onPlay"
          @pause="onPause"
          @seeking="onSeeking"
          @seeked="onSeeking"
          @ended="onPause"
          @click="togglePlayLocal()"
        ></video>

        <!--
          播放按钮（第九阶段补）。
          之前**没有任何播放入口**：`<video>` 没有 controls、界面上没有按钮、
          `video.togglePlay()` 全项目零调用、快捷键也没绑播放，
          而点字幕只走 `seek()` 且默认不自动播放 —— 也就是说视频根本播不起来。
        -->
        <button
          v-if="!video.playing"
          class="preview-play-big"
          type="button"
          title="播放（空格）"
          @click="togglePlayLocal()"
        >
          ▶
        </button>

        <audio
          v-if="video.session.audio"
          ref="aEl"
          :src="video.session.audio.url"
          :muted="video.muted"
          preload="auto"
          @volumechange="onVolume"
        ></audio>
      </template>
    </div>

    <div v-if="video.session" class="preview-bar">
      <button
        class="btn sm preview-play"
        type="button"
        :title="video.playing ? '暂停（空格）' : '播放（空格）'"
        @click="togglePlayLocal()"
      >
        {{ video.playing ? '⏸' : '▶' }}
      </button>
      <span class="muted mono">{{ formatTime(video.position) }}</span>
      <input
        class="preview-range"
        type="range"
        min="0"
        :max="Math.max(1, duration)"
        step="0.1"
        :value="video.playing && !scrubbing ? video.position : scrubbing ? scrubValue : video.position"
        :style="{ '--pct': `${progressPercent}%` }"
        aria-label="播放进度"
        @mousedown="scrubbing = true"
        @input="onScrubInput"
        @change="onScrubCommit"
      />
      <span class="muted mono">{{ formatTime(duration) }}</span>
    </div>
  </section>
</template>

<style scoped>
.preview-pane {
  border-bottom: 1px solid var(--hairline);
}

/*
 * 视频画面容器：加圆角与内背景，让它像一个「播放器」而不是一块贴边的黑矩形。
 * 用 `--radius` 而不是直角 —— 这是画面区，圆角能让它从中栏背景里"浮"出来。
 */
.preview-body {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border-radius: var(--radius);
  margin: 0 var(--sp-3);
  overflow: hidden;
  padding: 0;
}

.preview-video {
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
  color: var(--text-dim);
  text-align: center;
  padding: var(--sp-3) var(--sp-5);
}

.preview-ico {
  font-size: 26px;
  opacity: 0.55;
}

.preview-play {
  min-width: 34px;
  font-size: var(--fs-base);
}

/*
 * 中央播放大按钮：未播放时才显示。
 * 用半透明圆形而不是实心块 —— 不遮挡画面内容，但足够显眼。
 */
.preview-play-big {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, transform 0.15s ease;
}

.preview-play-big:hover {
  background: rgba(0, 0, 0, 0.75);
  transform: translate(-50%, -50%) scale(1.06);
}

.preview-body {
  position: relative;
}

.preview-video {
  cursor: pointer;
}

.preview-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-4) var(--sp-2);
  font-size: var(--fs-sm);
}

.mono {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.preview-range {
  flex: 1;
  height: 4px;
  appearance: none;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--accent) 0%,
    var(--accent) var(--pct),
    var(--border) var(--pct),
    var(--border) 100%
  );
  cursor: pointer;
}

.preview-range::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--panel);
}
</style>
