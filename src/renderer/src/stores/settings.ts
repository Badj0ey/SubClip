/**
 * 设置 store（第一阶段-1）。
 *
 * 职责边界：
 * - 持有 `AppSettings` 单例与主题 / 阅读样式这类**由设置派生的副作用**；
 * - 不做业务请求（拉字幕、切片那些在各业务 store 里）。
 *
 * 主题与阅读样式原先是 `store.ts` 里的裸函数，现在收进 store，
 * 好处是任何 store / 组件都能直接调，不必再 import 一堆自由函数。
 */
import { defineStore } from 'pinia'
import type { AppSettings } from '@shared/types'
import { emit } from '@renderer/bus'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    /** null 表示还没从主进程读回来（启动期） */
    settings: null as AppSettings | null
  }),

  getters: {
    /** 快捷键映射；设置还没加载时给个空对象，由调用方兜底到默认值 */
    shortcuts(state): AppSettings['shortcuts'] | null {
      return state.settings?.shortcuts ?? null
    },
    readLineEnabled(state): boolean {
      return state.settings?.readLine !== false
    },
    /** 切片输出目录：优先专用目录，其次切片表目录 */
    effectiveSliceOutputDir(state): string {
      return state.settings?.sliceOutputDir?.trim() || state.settings?.outputDir || ''
    }
  },

  actions: {
    /** 从主进程重新拉一次设置（插件同步 Cookie、设置页保存后都会用到） */
    async load(): Promise<AppSettings> {
      this.settings = await window.api.getSettings()
      emit('settings.changed', this.settings)
      return this.settings
    },

    /**
     * 保存部分设置并更新本地副本。
     * 主进程返回的是**整份**设置，所以这里直接覆盖而不是自己合并，
     * 免得两边对「默认值长什么样」的理解产生分叉。
     */
    async save(patch: Partial<AppSettings>): Promise<AppSettings> {
      const next = await window.api.saveSettings(patch)
      this.settings = next
      emit('settings.changed', next)
      return next
    },

    /** 应用主题（`system` 会跟随系统深浅色） */
    applyTheme(theme?: AppSettings['theme']): void {
      const wanted = theme ?? this.settings?.theme ?? 'system'
      let effective = wanted
      if (wanted === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      document.documentElement.setAttribute('data-theme', effective)
      if (this.settings) {
        document.documentElement.style.setProperty('--font-family', this.settings.fontFamily || '')
      }
      // 字号统一交给 applyReadingStyle 处理，避免两处各设一半
    },

    /** 应用字号 / 行距等阅读样式 */
    applyReadingStyle(): void {
      const s = this.settings
      if (!s) return
      const root = document.documentElement
      root.style.setProperty('--line-height', String(s.lineHeight))
      root.style.setProperty('--font-size', `${s.fontSize}px`)
      root.style.fontSize = `${s.fontSize}px`
      document.body.style.fontSize = `${s.fontSize}px`
    }
  }
})
