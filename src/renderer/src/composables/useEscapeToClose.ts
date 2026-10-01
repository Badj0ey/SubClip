/**
 * 按 Esc 关闭弹窗。
 *
 * 四个弹窗（导入 SRT / 拉取字幕 / 字幕工具 / 标签）原本都没有这个处理。
 * 后果不只是「少个快捷键」：弹窗盖住整个窗口，背景点什么都没反应，
 * 用户按 Esc 又毫无动静，很容易判断成「界面卡住了 / 点不开了」。
 *
 * 用捕获阶段监听：焦点在弹窗内的输入框里时也能收到 Esc。
 * 同时阻断冒泡，避免同一次按键又被 App.vue 的全局快捷键当成「清空选择」。
 */
import { onMounted, onUnmounted } from 'vue'

export function useEscapeToClose(close: () => void, enabled?: () => boolean): void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (enabled && !enabled()) return
    e.preventDefault()
    e.stopPropagation()
    close()
  }
  onMounted(() => window.addEventListener('keydown', onKey, true))
  onUnmounted(() => window.removeEventListener('keydown', onKey, true))
}
