/**
 * 导出任务 store（3.6.0 拆表后新增）。
 *
 * ## 为什么和 `clip` store 分开
 *
 * 拆表前 `clips` 一表三义：「待执行队列」和「已保存片段」是同一批行，
 * 所以一个 store 就够了。拆开后它们是两件事：
 *
 * | | 片段（`clip` store） | 任务（本 store） |
 * | --- | --- | --- |
 * | 是什么 | 用户攒下来、可复用的时间范围 | 一次实际的输出请求 |
 * | 关键字段 | 名称 / 标签 / 收藏 / 来源 | 状态 / 进度 / 产物 / 错误 |
 * | 生命周期 | 长期保留，是资产 | 跑完就进历史 |
 * | 谁在改 | 片段库、右栏「保存片段」 | 队列、切片引擎 |
 *
 * 分开的**直接收益**：「清空任务」不再会删掉用户攒的片段。
 *
 * ## 为什么要放在 store 而不是组件里
 *
 * 任务列表有**两个消费方**（剪辑任务页、右栏的任务摘要），
 * 而且「加片段 → 排任务」发生在素材库。数据放组件里的话，
 * 别处改了队列，这一页不会知道 —— 实测踩到过：
 * 加了 2 个片段后切到剪辑任务页仍显示「还没有待处理的任务」，
 * 必须切走再回来才刷新，看起来就像「加任务没生效」。
 */
import { defineStore } from 'pinia'

/** 任务的生命周期状态 */
export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

export interface ExportJob {
  id: number
  /** 来源片段（可能已删，仅作追溯） */
  clipId: number | null
  bvid: string
  page: number
  start: number
  end: number
  segments?: Array<{ page: number; start: number; end: number }>
  note: string
  state: JobState
  progress: number
  output: string
  message: string
  sortOrder: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export const useJobsStore = defineStore('jobs', {
  state: () => ({
    /** 全部任务（含历史）；派生 getter 再去分状态，避免多处各拉一次 */
    jobs: [] as ExportJob[],
    loading: false
  }),

  getters: {
    /** 待处理队列（按队列顺序，就是列表顺序） */
    pending(state): ExportJob[] {
      return state.jobs.filter((j) => j.state === 'pending')
    },
    /** 正在执行 */
    running(state): ExportJob[] {
      return state.jobs.filter((j) => j.state === 'running')
    },
    /** 已结束（成功 / 失败 / 取消）—— 页面上的「已完成」页签 */
    finished(state): ExportJob[] {
      return state.jobs.filter((j) => j.state !== 'pending' && j.state !== 'running')
    },
    failed(state): ExportJob[] {
      return state.jobs.filter((j) => j.state === 'failed' || j.state === 'canceled')
    },
    okCount(state): number {
      return state.jobs.filter((j) => j.state === 'done').length
    }
  },

  actions: {
    /** 重新拉取全部任务（列表、队列、历史一次到位） */
    async load(): Promise<void> {
      this.loading = true
      try {
        this.jobs = (await window.api.listAllJobs()) as ExportJob[]
      } finally {
        this.loading = false
      }
    },

    /** 把片段排进队列（片段库 / 右栏「添加到任务」都走它） */
    async enqueue(clipIds: number[]): Promise<number> {
      const n = await window.api.enqueueJobs(clipIds)
      await this.load()
      return n
    },

    async remove(id: number): Promise<void> {
      this.jobs = (await window.api.deleteJob(id)) as ExportJob[]
    },

    async clearPending(): Promise<void> {
      this.jobs = (await window.api.clearPendingJobs()) as ExportJob[]
    },

    /** 失败 / 取消的重新排队 */
    async retry(ids: number[]): Promise<number> {
      const n = await window.api.retryJobs(ids)
      await this.load()
      return n
    },

    async move(id: number, dir: -1 | 1): Promise<void> {
      await window.api.moveJob({ id, dir })
      await this.load()
    }
  }
})
