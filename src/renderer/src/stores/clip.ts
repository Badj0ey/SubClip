/**
 * 切片 store（第一阶段-1）。
 *
 * 职责：切片任务列表、切片历史、本机切片执行与进度、ffmpeg 可用性。
 *
 * 「生成时间范围」不在这个 store —— 那是字幕勾选的派生结果，属于 `subtitle`；
 * 这里只负责「拿到范围之后怎么变成视频文件」。
 */
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { ClipTask, SliceHistoryEntry, SliceRowLike } from '@shared/types'
import { emit } from '@renderer/bus'
import { useUiStore } from './ui'
import { useSettingsStore } from './settings'
import { useSubtitleStore } from './subtitle'
import { useJobsStore } from './jobs'

export const useClipStore = defineStore('clip', {
  state: () => ({
    /** 切片任务（导出给切片工具 / 本机切片的输入） */
    clips: [] as ClipTask[],
    /** 切片历史（最近 200 条），用于查失败与一键重试 */
    history: [] as SliceHistoryEntry[],

    /* ------------------------------ ffmpeg 状态 ------------------------------ */
    ffmpegReady: false,
    ffmpegPath: ''
  }),

  getters: {
    failedHistory: (state): SliceHistoryEntry[] => state.history.filter((h) => h.status !== 'ok'),
    okHistoryCount: (state): number => state.history.filter((h) => h.status === 'ok').length,
    /** 有 BV 号的任务才能切片（本地导入且没识别到 BV 号的不行） */
    usableTasks: (state): ClipTask[] => state.clips.filter((t) => Boolean(t.bvid)),
    /** 缺少 BV 号的任务数（导出前给出警告用） */
    missingBvidCount: (state): number => state.clips.filter((t) => !t.bvid).length,
    /** 收藏的片段（第三阶段，首页与片段视图都用） */
    favoriteClips: (state): ClipTask[] => state.clips.filter((c) => c.favorite),
    /** 片段来源的计数（片段视图的筛选条用） */
    sourceCounts(state): Record<ClipTask['source'], number> {
      const out: Record<ClipTask['source'], number> = { manual: 0, search: 0, slice: 0 }
      for (const c of state.clips) out[c.source] = (out[c.source] ?? 0) + 1
      return out
    }
  },

  actions: {
    /**
     * 重新拉片段列表。
     *
     * 拆表后这里**只**管片段。`clip.listChanged` 事件保留原义（片段列表变了），
     * 但任务队列的刷新归 `jobs` store —— 两边各自负责，避免互相触发。
     */
    async loadClips(): Promise<void> {
      this.clips = await window.api.listClips()
      emit('clip.listChanged', { count: this.clips.length })
    },

    async loadHistory(limit = 200): Promise<void> {
      this.history = await window.api.listSliceHistory(limit)
    },

    /** 检测 ffmpeg（设置里指定的路径 / 内置目录 / PATH 三处找） */
    async refreshCheck(): Promise<void> {
      try {
        const res = await window.api.sliceCheck()
        this.ffmpegReady = res.available
        this.ffmpegPath = res.ffmpeg
      } catch {
        this.ffmpegReady = false
      }
    },

    /* ------------------------------ 任务增删改查 ----------------------------- */

    /**
     * 把当前勾选算出的时间范围加入任务列表。
     * 范围由 subtitle store 推导，这里只负责提交与刷新。
     */
    async enqueueCurrentRanges(notePrefix?: string): Promise<void> {
      const ui = useUiStore()
      const sub = useSubtitleStore()
      if (!sub.doc || !sub.video) {
        ui.showToast('请先打开一个字幕文档', 'error')
        return
      }
      if (!sub.ranges.length) {
        ui.showToast('还没有选中任何字幕', 'error')
        return
      }
      const res = await window.api.addClips({
        docId: sub.doc.id,
        bvid: sub.video.bvid || '',
        page: sub.doc.page || 1,
        ranges: sub.ranges.map((r) => ({ start: r.start, end: r.end, segments: r.segments })),
        notePrefix: notePrefix || sub.video.title || 'clip'
      })
      if (!res.ok) {
        ui.showToast(res.message || '加入切片任务失败', 'error')
        return
      }
      await this.loadClips()
      // 加片段的同时也排了任务 → 队列变了，让剪辑任务页跟着更新
      await useJobsStore().load()
      ui.showToast(`已加入 ${res.data?.count ?? 0} 条切片任务`, 'success')
    },

    /** 单独把某一条字幕加进切片任务（右键菜单用） */
    async enqueueOne(cueStart: number, cueEnd: number, page: number, docId: number): Promise<void> {
      const ui = useUiStore()
      const sub = useSubtitleStore()
      const res = await window.api.addClips({
        docId,
        bvid: sub.video?.bvid ?? '',
        page,
        ranges: [{ start: cueStart, end: cueEnd }],
        notePrefix: sub.video?.title || 'clip'
      })
      if (!res.ok) {
        ui.showToast(res.message || '加入切片任务失败', 'error')
        return
      }
      await this.loadClips()
      // 单选加入同样会排任务
      await useJobsStore().load()
      ui.showToast('已加入 1 条切片任务', 'success')
    },

    async remove(id: number): Promise<void> {
      this.clips = await window.api.deleteClip(id)
      emit('clip.listChanged', { count: this.clips.length })
    },

    async clearAll(): Promise<void> {
      await window.api.clearClips()
      await this.loadClips()
    },

    async move(id: number, dir: -1 | 1): Promise<void> {
      this.clips = await window.api.moveClip(id, dir)
    },

    async rename(id: number, note: string): Promise<void> {
      this.clips = await window.api.renameClip(id, note)
    },

    /**
     * 按片段内容批量重命名（第五阶段）。
     * 用在该「早先加的任务名字都是 `前缀 #1`，现在想变成有意义的标题」的时候。
     */
    async autoNameAll(): Promise<void> {
      const ui = useUiStore()
      const res = await window.api.autoNameClips()
      if (!res.ok) {
        ui.showToast(res.message || '自动命名失败', 'error')
        return
      }
      await this.loadClips()
      const n = res.data?.renamed ?? 0
      ui.showToast(n ? `已按内容重命名 ${n} 个片段` : '现有名称已经很好，无需改动', 'success', 4600)
    },

    /* --------------------------- 片段（第三阶段） --------------------------- */

    /** 改名：片段名称（与输出文件名 `note` 分开） */
    async renameName(id: number, name: string): Promise<void> {
      this.clips = await window.api.renameClipName(id, name)
    },

    /** 收藏 / 取消收藏片段 */
    async toggleFavorite(id: number): Promise<void> {
      const res = await window.api.toggleClipFavorite(id)
      this.clips = res.tasks
      const ui = useUiStore()
      ui.showToast(res.favorite ? '已收藏该片段' : '已取消收藏', 'success')
    },

    async getTagIds(clipId: number): Promise<number[]> {
      return window.api.getClipTags(clipId)
    },

    async setTags(clipId: number, tagIds: number[]): Promise<void> {
      this.clips = await window.api.setClipTags(clipId, tagIds)
    },

    clipDetail(clipId: number): ReturnType<typeof window.api.getClipDetail> {
      return window.api.getClipDetail(clipId)
    },

    /* -------------------------------- 导出表格 ------------------------------- */

    async exportTable(format: 'csv' | 'xlsx'): Promise<void> {
      const ui = useUiStore()
      if (!this.clips.length) {
        ui.showToast('切片任务列表为空，请先加入任务', 'error')
        return
      }
      if (this.missingBvidCount) {
        ui.showToast(
          `有 ${this.missingBvidCount} 条任务缺少 BV 号，切片工具可能无法处理`,
          'error',
          4200
        )
      }

      // 跨分P 的切片无法用单行表格表示，拆成多行输出
      const rows: SliceRowLike[] = []
      let splitCount = 0
      for (const t of this.clips) {
        if (t.segments && t.segments.length > 1) {
          splitCount++
          t.segments.forEach((s, i) => {
            rows.push({
              bvid: t.bvid,
              page: s.page,
              start: s.start,
              end: s.end,
              note: `${t.note}_p${i + 1}`
            })
          })
        } else {
          rows.push({ bvid: t.bvid, page: t.page, start: t.start, end: t.end, note: t.note })
        }
      }

      const res = await window.api.exportClips({ rows, format })
      if (!res.ok || !res.data) {
        ui.showToast(res.message || '导出失败', 'error')
        return
      }
      ui.showToast(
        `已导出：${res.data.path}${splitCount ? `（${splitCount} 条跨分P 切片已拆成多行）` : ''}`,
        'success',
        5600
      )
      await window.api.showItem(res.data.path)
    },

    async exportJson(): Promise<void> {
      const ui = useUiStore()
      const res = await window.api.exportClipsJson()
      if (!res.ok || !res.data) {
        if (res.message !== '已取消') ui.showToast(res.message || '导出失败', 'error')
        return
      }
      ui.showToast(`已导出 ${res.data.count} 条任务：${res.data.path}`, 'success', 5600)
    },

    async importJson(): Promise<void> {
      const ui = useUiStore()
      const res = await window.api.importClipsJson()
      if (!res.ok || !res.data) {
        if (res.message !== '已取消') ui.showToast(res.message || '导入失败', 'error', 5200)
        return
      }
      await this.loadClips()
      ui.showToast(
        `已导入 ${res.data.count} 条任务${res.data.warnings.length ? `（跳过 ${res.data.warnings.length} 条）` : ''}`,
        'success',
        5600
      )
      if (res.data.warnings.length) {
        ui.showToast(res.data.warnings.slice(0, 3).join('\n'), 'error', 7000)
      }
    },

    /* -------------------------------- 本机切片 ------------------------------- */

    /**
     * 执行**待处理队列**里的任务（本机切片）。
     *
     * 3.7.0 起队列的权威来源是 `export_jobs`（`jobs` store），不再是 `clips`。
     * 拆表前这个方法跑的是「片段列表」——那正是「片段与任务混为一谈」的根源：
     * 用户只是想保存一个片段，结果一点「本地切片」它就被拿去切了。
     *
     * @param jobIds 只跑指定的几条（不传则跑全部待处理）；剪辑任务页用得到
     */
    async startSlice(jobIds?: number[]): Promise<void> {
      const ui = useUiStore()
      const jobs = useJobsStore()
      if (ui.sliceRunning) return
      if (!jobs.jobs.length) await jobs.load()
      const pending = jobs.pending.filter((j) => !jobIds?.length || jobIds.includes(j.id))
      if (!pending.length) {
        ui.showToast('待处理队列为空', 'error')
        return
      }
      if (!this.ffmpegReady) {
        ui.showToast('未检测到 ffmpeg，请先在「设置 → 本地切片」中配置', 'error', 5200)
        return
      }
      const usable = pending.filter((j) => Boolean(j.bvid))
      if (!usable.length) {
        ui.showToast('所有任务都缺少 BV 号，无法切片', 'error', 5200)
        return
      }

      ui.sliceRunning = true
      ui.sliceProgress = null
      ui.sliceResult = null

      try {
        const res = await window.api.sliceRun(
          usable.map((j) => ({
            bvid: j.bvid,
            page: j.page,
            start: j.start,
            end: j.end,
            note: j.note,
            segments: j.segments,
            // clipId 仅作追溯（片段可能已删）；jobId 用来把任务推进到终态
            clipId: j.clipId ?? undefined,
            jobId: j.id
          }))
        )
        if (!res.ok || !res.data) {
          ui.showToast(res.message || '切片失败', 'error', 5200)
          return
        }
        ui.sliceResult = markRaw(res.data)
        if (res.data.ok > 0) {
          ui.showToast(
            `切片完成：成功 ${res.data.ok} 个${res.data.failed ? `，失败 ${res.data.failed} 个` : ''}`,
            'success',
            5200
          )
        } else {
          ui.showToast('没有生成任何切片', 'error', 5200)
        }
        if (res.data.messages.length) {
          ui.showToast(res.data.messages.slice(0, 3).join('\n'), 'error', 7000)
        }
      } finally {
        ui.sliceRunning = false
        ui.sliceProgress = null
        await this.loadHistory()
        // 任务状态（pending → running → done/failed）由引擎改库，
        // 跑完要把任务列表拉回最新，否则剪辑任务页还显示「排队中」
        await useJobsStore().load()
      }
    },

    async cancel(): Promise<void> {
      const ui = useUiStore()
      await window.api.sliceCancel()
      ui.showToast('已请求取消切片', 'info')
    },

    async clearHistory(): Promise<void> {
      await window.api.clearSliceHistory()
      this.history = []
    },

    /**
     * 把失败（或被取消）的切片重新加回任务列表。
     * 这是「跑 20 条挂了 3 条」时最省事的补救方式：不用回去重新勾字幕。
     */
    async retryFailed(): Promise<void> {
      const ui = useUiStore()
      const failed = this.failedHistory
      if (!failed.length) {
        ui.showToast('没有失败的任务需要重试', 'info')
        return
      }
      // 逐条带自己的 bvid / 分P，所以走 addClipsFromSearch 那条通道
      //（clips:add 是「一个文档 + 多个时间范围」，这里恰好相反）
      const added = await window.api.addClipsFromSearch({
        hits: failed.map((h) => ({
          docId: 0,
          bvid: h.bvid,
          page: h.page,
          start: h.start,
          end: h.end,
          text: h.note,
          videoTitle: h.note
        })),
        notePrefix: '重试'
      })
      if (!added.ok) {
        ui.showToast(added.message || '重试失败', 'error')
        return
      }
      await this.loadClips()
      ui.showToast(`已把 ${added.data?.count ?? 0} 条失败任务重新加入列表`, 'success', 5200)
    },

    /** 打开切片输出目录 */
    async openOutputDir(): Promise<void> {
      const ui = useUiStore()
      const dir = useSettingsStore().effectiveSliceOutputDir
      if (!dir) {
        ui.showToast('尚未设置输出目录', 'error')
        return
      }
      const err = await window.api.openPath(dir)
      if (err) ui.showToast(err, 'error', 4200)
    }
  }
})
