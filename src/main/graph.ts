/**
 * 知识图谱构建（第八阶段）。
 *
 * ## 图谱的形状
 *
 *     主题  ← 从字幕文本抽出的词（跨视频聚合）
 *      |
 *     视频
 *      |
 *     观点  ← 从字幕里挑出的「像话的句子」
 *      |
 *     片段  ← 已有的 clips（观点句可直接加入切片任务）
 *
 * ## 为什么要两遍
 *
 * 主题打分用「词频 × 稀有度」，而**稀有度要看全库**：
 * 「这个词是这场直播独有的，还是 200 个视频都在说」——
 * 不先算全局文档频次，每个视频的主题层都会被「直播间 / 粉丝」这类全库高频词统治
 * （实测就是这样）。所以第一遍统计词频，第二遍才出主题。
 *
 * ## 本地、零依赖、可中断
 *
 * 分词用 `Intl.Segmenter`，不引库、不联网、不依赖 AI。
 * 490 份字幕的处理量不小，所以按批 yield，界面不卡；中断后重跑是幂等的。
 */
import * as db from './db'
import { countTerms, mergeIntoSentences, pickTopics, scoreSentences, scoreTerms } from '@shared/extract'

/** 每个视频取多少个主题（图谱要能看，不能糊成一片） */
const TOPICS_PER_VIDEO = 10
/** 每个文档抽多少条观点句 */
const VIEWPOINTS_PER_DOC = 12
/** 观点句的最低分（低于它宁可不给 —— 观点层是给人看的） */
const MIN_VIEWPOINT_SCORE = 4

export interface GraphProgress {
  busy: boolean
  phase: 'idle' | 'counting' | 'extracting' | 'done' | 'error'
  /** 已处理 / 总共（阶段内） */
  done: number
  total: number
  message: string
}

let progress: GraphProgress = { busy: false, phase: 'idle', done: 0, total: 0, message: '' }
let cancelRequested = false

export function graphStatus(): GraphProgress {
  return { ...progress }
}

/** 请求中断（下次检查点时退出；已经写好的部分保留，重跑是幂等的） */
export function cancelGraph(): void {
  cancelRequested = true
}

function setProgress(patch: Partial<GraphProgress>): void {
  progress = { ...progress, ...patch }
}

/**
 * 构建图谱。
 *
 * @param rebuild 是否清空重来（默认增量：只处理还没视图谱数据的文档）
 */
export async function buildGraph(rebuild = false): Promise<GraphProgress> {
  if (progress.busy) return graphStatus()
  cancelRequested = false
  setProgress({ busy: true, phase: 'counting', done: 0, total: 0, message: '正在统计全库词频…' })

  try {
    const docs = db.listDocsForGraph()
    if (!docs.length) {
      setProgress({ busy: false, phase: 'done', message: '还没有字幕，无需建图' })
      return graphStatus()
    }

    if (rebuild) {
      db.clearGraph()
      setProgress({ message: '已清空旧图谱，正在统计全库词频…' })
    }

    /* ---------------- 第一遍：全局文档频次（主题稀有度要用） ---------------- */

    const textsByDoc = db.allCueTextsByDoc()
    const docCounts = new Map<string, number>()
    let counted = 0
    for (const [, texts] of textsByDoc) {
      // 每个文档内部的词只算一次「文档频次」
      const seen = new Set<string>()
      for (const text of texts) {
        for (const term of countTerms([text]).keys()) seen.add(term)
      }
      for (const term of seen) docCounts.set(term, (docCounts.get(term) ?? 0) + 1)
      counted++
      if (counted % 50 === 0) {
        setProgress({ done: counted, total: textsByDoc.size, message: `统计词频 ${counted}/${textsByDoc.size}` })
        await yieldToLoop()
      }
      if (cancelRequested) {
        setProgress({ busy: false, phase: 'idle', message: '已中断（已写入的部分保留，可继续）' })
        return graphStatus()
      }
    }
    const totalDocs = Math.max(1, textsByDoc.size)

    /* ---------------- 第二遍：逐文档抽主题与观点 ---------------- */

    // 同一视频可能有多个分P：主题要按视频汇总，观点按文档存
    const perVideoTerms = new Map<number, Map<string, number>>()
    setProgress({ phase: 'extracting', done: 0, total: docs.length, message: '正在抽取主题与观点…' })

    let processed = 0
    for (const doc of docs) {
      const cues = db.listDocTexts(doc.id)
      if (cues.length) {
        // --- 观点句 ---
        const sentences = mergeIntoSentences(
          cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })),
          1.5,
          120
        )
        // 先用本视频的词（此刻还没选主题，就用手头的高频词当命中线索）
        const roughTopics = pickTopics(
          scoreTerms(countTerms(cues.map((c) => c.text)), docCounts, totalDocs, 2),
          TOPICS_PER_VIDEO
        ).map((t) => t.term)
        const ranked = scoreSentences(sentences, roughTopics, MIN_VIEWPOINT_SCORE)
        db.saveVideoViewpoints(
          doc.videoId,
          doc.id,
          doc.page,
          ranked.slice(0, VIEWPOINTS_PER_DOC).map((s) => ({
            index: s.index,
            start: s.start,
            end: s.end,
            text: s.text,
            score: s.score
          }))
        )

        // --- 词频累加到视频 ---
        const counts = perVideoTerms.get(doc.videoId) ?? new Map<string, number>()
        for (const [term, n] of countTerms(cues.map((c) => c.text))) {
          counts.set(term, (counts.get(term) ?? 0) + n)
        }
        perVideoTerms.set(doc.videoId, counts)
      }

      processed++
      if (processed % 20 === 0) {
        setProgress({ done: processed, total: docs.length, message: `抽取主题与观点 ${processed}/${docs.length}` })
        await yieldToLoop()
      }
      if (cancelRequested) {
        setProgress({ busy: false, phase: 'idle', message: '已中断（已写入的部分保留，可继续）' })
        return graphStatus()
      }
    }

    /* ---------------- 汇总：视频 → 主题 ---------------- */

    setProgress({ message: '正在汇总主题…' })
    for (const [videoId, counts] of perVideoTerms) {
      const stats = pickTopics(scoreTerms(counts, docCounts, totalDocs, 2), TOPICS_PER_VIDEO)
      db.saveVideoTopics(
        videoId,
        stats.map((s) => ({ term: s.term, count: s.count, score: s.score }))
      )
      await yieldToLoop()
    }
    db.refreshTopicStats()
    db.setGraphMeta('builtAt', String(Date.now()))
    db.setGraphMeta('docs', String(docs.length))

    const counts = db.graphCounts()
    setProgress({
      busy: false,
      phase: 'done',
      done: docs.length,
      total: docs.length,
      message: `完成：${counts.topics} 个主题 / ${counts.viewpoints} 条观点 / 覆盖 ${counts.videos} 个视频`
    })
    return graphStatus()
  } catch (err) {
    setProgress({ busy: false, phase: 'error', message: `建图失败：${(err as Error).message}` })
    return graphStatus()
  }
}

/**
 * 让出事件循环。
 *
 * 建图要处理 490 份字幕、十万条字幕，一口气跑完主进程会假死；
 * 每批让一次循环，界面才能更新进度、也才有机会响应中断。
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
