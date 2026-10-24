/**
 * 素材推荐引擎（第八阶段）。
 *
 * 依赖的是**本地向量**（第四阶段的 `semantic_vectors`），所以：
 * - 不需要外部模型，也不需要用户配 AI；
 * - 但需要索引建过（没有向量时给一句明确说明，而不是空结果）。
 *
 * 两种推荐的具体算法见 `@shared/recommend`（纯函数、可单测）；
 * 这里只负责「从数据库取向量 → 调用算法 → 拼装结果」。
 */
import type { Recommendation, RecommendationResult, RecommendKind } from '@shared/types'
import * as db from './db'
import {
  cosine,
  decodeVector,
  dedupeNearby,
  encodeVector,
  highlightReason,
  meanVector,
  topN,
  twinsReason,
  typicalReason
} from '@shared/recommend'

/** 编解码统一走 `@shared/recommend` 的实现（可单测，见 core.test.ts） */
const decode = decodeVector
const encode = encodeVector

/**
 * 求某条段落所属视频的「语义中心」并缓存进 `videos.centroid`。
 *
 * 缓存的意义：一场两小时直播有几百段，求中心要扫几百条向量；
 * 而「找这场直播的代表段落」是会被反复点的操作。
 */
/** 语义中心既可能是缓存的 Float32，也可能是刚算出来的 Float64（平均用双精度更稳） */
function ensureCentroid(videoId: number): Float32Array | Float64Array | null {
  const cached = db.getVideoCentroid(videoId)
  if (cached && cached.length) return decode(cached)

  const vectors = db.listVideoChunkVectors(videoId)
  if (!vectors.length) return null
  const mean = meanVector(vectors.map((v) => decode(v.vector)))
  if (!mean.length) return null
  db.saveVideoCentroid(videoId, encode(mean))
  return mean
}

/** 把 chunkId 变成一条可展示的推荐条目 */
function toRecommendation(
  kind: RecommendKind,
  chunkId: number,
  score: number,
  reason: string
): Recommendation | null {
  const meta = db.chunkMeta(chunkId)
  if (!meta) return null
  const video = db.getVideo(meta.videoId)
  if (!video) return null
  return {
    kind,
    videoId: meta.videoId,
    videoTitle: video.title,
    uploaderName: video.uploaderName ?? '',
    bvid: video.bvid,
    docId: meta.docId,
    page: meta.page,
    index: meta.firstIdx,
    start: meta.start,
    end: meta.end,
    // 文本截断：推荐列表是「扫一眼」的场景，太长反而不看
    text: meta.text.length > 160 ? `${meta.text.slice(0, 160)}…` : meta.text,
    score: Math.round(score * 1000) / 1000,
    reason
  }
}

function partialFlag(): Pick<RecommendationResult, 'partial' | 'indexedChunks' | 'totalChunks'> {
  const counts = db.semanticCounts()
  return {
    partial: counts.indexed < counts.total,
    indexedChunks: counts.indexed,
    totalChunks: counts.total
  }
}

/** 空结果（附原因），避免界面拿到一个没有解释的空列表 */
function empty(kind: RecommendKind, message: string): RecommendationResult {
  return { kind, items: [], ...partialFlag(), message }
}

/**
 * 「语义双胞胎」的最低相似度。
 *
 * 第一版用 0.35，实测在直播类内容上**全是噪音**：返回的是
 * 「谢谢安妮老师的粉丝灯牌」「谢谢三送什么」这类**功能相同但内容无意义**的套话 ——
 * 因为这类内容在语料里占比极高，任何一段都能在别的视频里找到长得一样的。
 * 提到 0.55 之后剩下的才算「真的在讲同一件事」。
 *
 * 这个值同样与语料有关：换成信息密度高的知识类视频可以调回 0.4 左右。
 */
const MIN_TWINS_SIMILARITY = 0.55

/**
 * 诊断：直接看某个视频的原始向量与「自己和自己」的相似度。
 *
 * 存在的理由：实测遇到过「某视频的段落两两相似度 0.8，但与**自己视频的平均向量**
 * 相似度却低于 0.05」—— 数学上不可能，说明向量解码有问题。
 * 这个接口把原始 BLOB 的字节数、前几个元素、以及两条原始向量之间的余弦直接摊开，
 * 让「到底是存坏了还是解错了」一眼可判。
 */
export function inspectVideoVectors(videoId: number): {
  count: number
  byteLengths: number[]
  firstElements: number[][]
  selfCosine: number
  storedCentroidBytes: number | null
  centroidFirstElements: number[]
} {
  const rows = db.listVideoChunkVectors(videoId)
  if (!rows.length) {
    return {
      count: 0,
      byteLengths: [],
      firstElements: [],
      selfCosine: 0,
      storedCentroidBytes: db.getVideoCentroid(videoId)?.length ?? null,
      centroidFirstElements: []
    }
  }
  const decoded = rows.slice(0, 3).map((r) => decode(r.vector))
  const cached = db.getVideoCentroid(videoId)
  return {
    count: rows.length,
    byteLengths: rows.slice(0, 3).map((r) => r.vector.byteLength),
    firstElements: decoded.map((d) => Array.from(d.slice(0, 4)).map((x) => Math.round(x * 1e4) / 1e4)),
    // 第 1 条与第 2 条之间的余弦：同视频相邻段落，正常应该很高（>0.5）
    selfCosine: decoded.length > 1 ? Math.round(cosine(decoded[0], decoded[1]) * 1000) / 1000 : 0,
    storedCentroidBytes: cached?.length ?? null,
    centroidFirstElements: cached
      ? Array.from(decode(cached).slice(0, 4)).map((x) => Math.round(x * 1e4) / 1e4)
      : []
  }
}

/**
 * 诊断：抽样统计「跨视频」段落相似度的分布。
 *
 * 存在的理由：推荐的阈值（`MIN_TWINS_SIMILARITY` / `MIN_TOPIC_SIMILARITY`）必须按语料标定，
 * 而「这个库的相似度大概在什么区间」不能靠感觉猜。设置页不暴露它，
 * 只在开发/诊断时通过 IPC 调用，用真实数据决定阈值。
 *
 * @param samples 抽多少个参照段落
 * @param topK 每个参照段落取最像的前 K 个（跨视频）
 */
export function similarityStats(samples = 20, topK = 10): {
  samples: number
  avgTop: number
  avgMedian: number
  buckets: Array<{ range: string; count: number }>
  topTexts: string[]
} {
  const all = db.allChunkVectors()
  if (all.length < 2) {
    return { samples: 0, avgTop: 0, avgMedian: 0, buckets: [], topTexts: [] }
  }
  const index = db.chunkIndexMap()
  const step = Math.max(1, Math.floor(all.length / Math.max(1, samples)))
  const tops: number[] = []
  const medians: number[] = []
  const topTexts: string[] = []

  for (let s = 0; s < all.length && tops.length < samples; s += step) {
    const base = all[s]
    const baseInfo = index.get(base.chunkId)
    if (!baseInfo) continue
    const baseVec = decode(base.vector)
    const sims: number[] = []
    let best = { score: -1, chunkId: -1 }
    for (const row of all) {
      const info = index.get(row.chunkId)
      // 只要别的视频的段落（与推荐逻辑一致）
      if (!info || info.videoId === baseInfo.videoId) continue
      const score = cosine(baseVec, decode(row.vector))
      sims.push(score)
      if (score > best.score) best = { score, chunkId: row.chunkId }
    }
    if (!sims.length) continue
    sims.sort((a, b) => b - a)
    tops.push(sims.slice(0, topK).reduce((a, b) => a + b, 0) / Math.min(topK, sims.length))
    medians.push(sims[Math.floor(sims.length / 2)])
    if (best.chunkId >= 0) {
      const text = db.chunkMeta(best.chunkId)?.text ?? ''
      if (text) topTexts.push(`${best.score.toFixed(3)} ${text.slice(0, 40).replace(/\n/g, ' ')}`)
    }
  }

  const buckets = [
    { range: '0.9~1.0', count: 0 },
    { range: '0.8~0.9', count: 0 },
    { range: '0.7~0.8', count: 0 },
    { range: '0.6~0.7', count: 0 },
    { range: '0.5~0.6', count: 0 },
    { range: '<0.5', count: 0 }
  ]
  for (const t of tops) {
    if (t >= 0.9) buckets[0].count++
    else if (t >= 0.8) buckets[1].count++
    else if (t >= 0.7) buckets[2].count++
    else if (t >= 0.6) buckets[3].count++
    else if (t >= 0.5) buckets[4].count++
    else buckets[5].count++
  }

  const avg = (xs: number[]): number =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0

  return {
    samples: tops.length,
    avgTop: avg(tops),
    avgMedian: avg(medians),
    buckets,
    topTexts: topTexts.slice(0, 10)
  }
}

/**
 * 语义双胞胎：与给定片段最像的、**来自其它视频**的片段。
 *
 * @param chunkId 参照段落（未指定时用 `docId + second` 定位）
 */
export function recommendTwins(input: {
  chunkId?: number
  docId?: number
  second?: number
  limit?: number
}): RecommendationResult {
  const counts = db.semanticCounts()
  if (counts.indexed === 0) {
    return empty('twins', '还没有语义索引：设置 → 语义检索 → 开始建索引')
  }

  // 定位参照段落：优先用明确的 chunkId，否则按「文档 + 时间」找覆盖该时刻的那一段
  let sourceId: number | null = input.chunkId ?? null
  if (sourceId == null && input.docId != null) {
    const hit = db.chunkAt(input.docId, input.second ?? 0)?.id ?? null
    sourceId = hit
  }
  if (sourceId == null) return empty('twins', '找不到参照片段（换个位置再试）')

  const source = db.chunkVectorsByIds([sourceId]).get(sourceId)
  if (!source) return empty('twins', '这条片段还没有向量（索引未覆盖到它）')

  const sourceMeta = db.chunkMeta(sourceId)
  if (!sourceMeta) return empty('twins', '找不到参照片段的信息')
  const sourceVec = decode(source.vector)

  // 一次性把「段落 → 文档/视频/起点」读进内存：十万条向量上逐条 join 查询会慢到不可用
  const index = db.chunkIndexMap()
  const scored = db
    .allChunkVectors()
    .map((row) => {
      const info = index.get(row.chunkId)
      return {
        chunkId: row.chunkId,
        score: cosine(sourceVec, decode(row.vector)),
        videoId: info?.videoId ?? -1
      }
    })
    // 只要**别**的视频：同一场直播里前后重复的话没有取材价值
    .filter((r) => r.videoId !== sourceMeta.videoId)

  const picked = dedupeNearby(
    topN(
      scored.map((s) => ({ chunkId: s.chunkId, score: s.score })),
      (input.limit ?? 20) * 3,
      new Set([sourceId]),
      MIN_TWINS_SIMILARITY
    ),
    (id) => index.get(id) ?? null
  ).slice(0, input.limit ?? 20)

  const items = picked
    .map((p) => toRecommendation('twins', p.chunkId, p.score, twinsReason(p.score)))
    .filter((x): x is Recommendation => Boolean(x))

  if (!items.length) {
    return empty(
      'twins',
      `没有找到足够相似的片段（门槛 ${MIN_TWINS_SIMILARITY}）。闲聊型内容里高相似度的段落往往是「谢谢灯牌」这类套话，宁可不给也不拿它们凑数。`
    )
  }
  return { kind: 'twins', items, ...partialFlag() }
}

/**
 * 「主题鲜明」的最低相干性门槛。
 *
 * 实测：直播聊天类视频里，45 秒窗口拼出来的段落与视频平均语义的相似度大多落在
 * 0.25~0.35；其中最低的那些是「蜘蛛侠啊 什么蜘蛛侠」「张萌张萌」这种彼此无关的短句 ——
 * 也就是说**「离中心最远」在这里恰好等于「最语无伦次」**。
 * 所以要有这道下限：低于它只能说明「这段跟整场都不搭」，不能拿来推荐。
 *
 * 0.3 是按本机真实库（489 份直播字幕）的分布定的；换成口语化程度完全不同的内容时，
 * 这个值值得重新标定，所以单独提出来、带注释。
 */
const MIN_TOPIC_SIMILARITY = 0.3

/**
 * 主题最鲜明的段落（挑高光用）。
 *
 * ## 为什么不是「离语义中心最近」
 *
 * 那是第一版实现，实测挑出来的全是「哈哈啊我我」「你们能懂吗」这种**最泛泛的口水话**：
 * 直播类内容里这类字幕占比很高，平均向量自然被它们主导，
 * 于是「最贴近平均」= 「最没内容」。所以反过来 —— 挑**离平均最远**的段落，
 * 但**必须过相干性下限**（见 `MIN_TOPIC_SIMILARITY`）。
 *
 * `score` 用「距离」（1 - 余弦），越大越鲜明。
 */
export function recommendHighlights(input: {
  videoId: number
  limit?: number
}): RecommendationResult {
  const counts = db.semanticCounts()
  if (counts.indexed === 0) {
    return empty('highlight', '还没有语义索引：设置 → 语义检索 → 开始建索引')
  }
  const centroid = ensureCentroid(input.videoId)
  if (!centroid) return empty('highlight', '这个视频还没有可用的段落向量')

  const rows = db.listVideoChunkVectors(input.videoId)
  if (!rows.length) return empty('highlight', '这个视频还没有可用的段落向量')

  const index = db.chunkIndexMap()
  // 视频自身的「泛泛程度」：段落与平均语义的平均相似度
  const sims = rows.map((row) => cosine(centroid, decode(row.vector)))
  const fromTopic = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 1

  const scored = rows
    .map((row, i) => ({
      chunkId: row.chunkId,
      // 距离 = 1 - 余弦；越大 = 越偏离整场铺陈
      score: Math.max(0, 1 - sims[i]),
      // 是否够「搭题」：低于门槛的段落不能算高光，只能算跑题
      coherent: sims[i] >= MIN_TOPIC_SIMILARITY
    }))
    .filter((s) => s.coherent)
    .map(({ chunkId, score }) => ({ chunkId, score }))

  if (!scored.length) {
    // 这是**正常**结果而不是错误：整场都是彼此无关的闲聊时，本来就没有「鲜明的段落」。
    // 如实说明比硬凑几条更有用。
    return empty(
      'highlight',
      '这个视频的段落彼此都比较独立（典型的闲聊型直播），没有明显「主题鲜明」的段落。可以改用「最贴近基调」或直接按关键词检索。'
    )
  }

  const picked = dedupeNearby(
    topN(scored, (input.limit ?? 12) * 3),
    (id) => index.get(id) ?? null
  ).slice(0, input.limit ?? 12)

  const items = picked
    .map((p, i) =>
      toRecommendation('highlight', p.chunkId, p.score, highlightReason(p.score, i + 1, fromTopic))
    )
    .filter((x): x is Recommendation => Boolean(x))

  if (!items.length) return empty('highlight', '没找到主题鲜明的段落')
  return { kind: 'highlight', items, ...partialFlag() }
}

/**
 * 最贴近整体基调的段落（做预告 / 选封面片段用）。
 *
 * 与 `recommendHighlights` 恰好相反：这里要的是「这个视频的缩影」，
 * 所以按与语义中心的余弦相似度降序。
 */
export function recommendTypical(input: {
  videoId: number
  limit?: number
}): RecommendationResult {
  const counts = db.semanticCounts()
  if (counts.indexed === 0) {
    return empty('typical', '还没有语义索引：设置 → 语义检索 → 开始建索引')
  }
  const centroid = ensureCentroid(input.videoId)
  if (!centroid) return empty('typical', '这个视频还没有可用的段落向量')

  const rows = db.listVideoChunkVectors(input.videoId)
  if (!rows.length) return empty('typical', '这个视频还没有可用的段落向量')

  const index = db.chunkIndexMap()
  const scored = rows.map((row) => ({
    chunkId: row.chunkId,
    score: cosine(centroid, decode(row.vector))
  }))

  const picked = dedupeNearby(
    topN(scored, (input.limit ?? 8) * 3),
    (id) => index.get(id) ?? null
  ).slice(0, input.limit ?? 8)

  const items = picked
    .map((p, i) => toRecommendation('typical', p.chunkId, p.score, typicalReason(p.score, i + 1)))
    .filter((x): x is Recommendation => Boolean(x))

  if (!items.length) return empty('typical', '没找到贴近整体基调的段落')
  return { kind: 'typical', items, ...partialFlag() }
}
