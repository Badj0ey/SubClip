/**
 * 发布草稿（第九阶段）。
 *
 * ## 为什么需要它
 *
 * 「文案模板」与「发布素材包」是两个兄弟页签，各自持局部状态。
 * 但两者的关系是**流水线**：模板渲染出标题/简介/标签 → 带进素材包 → 导出。
 * 用户现在的做法是手动复制粘贴，这一步完全可以省掉。
 *
 * ## 为什么不放在 ClipsView 里提升状态
 *
 * 提升后要给两个子组件各透传一批 props 与事件（三个字段 + 一个「带入」动作），
 * 而这份状态**只服务于这两个页签**，没有别的消费者。用一个小 store
 * 比在父组件里中转更直接，也和第一阶段定的「状态进 store」一致。
 *
 * ## 为什么**不持久化**
 *
 * 这是一份**草稿**：临时填的标题、还没导出的简介。
 * 持久化会让下次打开应用时冒出上次没发出去的残稿，反而像 bug；
 * 而且真正的成品（素材包、成片）都在磁盘上，不需要靠这里记住。
 */
import { defineStore } from 'pinia'

export const usePublishStore = defineStore('publish', {
  state: () => ({
    /** 发布标题 */
    title: '',
    /** 简介 / 正文（多行） */
    description: '',
    /** 话题标签（用空格/逗号分隔的原始输入，与素材包页签的输入框一致） */
    tagText: '',
    /** 这份草稿是不是从「文案模板」带过来的（界面上给个来源提示） */
    fromTemplate: false
  }),

  actions: {
    /**
     * 从文案模板带入。
     *
     * @param title 标题（模板渲染结果的第一行，或用户单独填的）
     * @param description 简介 / 正文
     * @param tagText 标签原文（不带 # 也可）
     */
    applyFromTemplate(title: string, description: string, tagText: string): void {
      // 空值不覆盖已有内容：用户可能在素材包页签里补过东西，
      // 一次「带入」把它清空是最讨厌的行为
      if (title.trim()) this.title = title.trim()
      if (description.trim()) this.description = description.trim()
      if (tagText.trim()) this.tagText = tagText.trim()
      this.fromTemplate = true
    },

    clear(): void {
      this.title = ''
      this.description = ''
      this.tagText = ''
      this.fromTemplate = false
    }
  }
})
