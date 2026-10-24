/**
 * 素材推荐的纯算法（第八阶段）。
 *
 * ## 为什么单独抽出来
 *
 * 推荐结果好不好，取决于**向量怎么算**：向量没归一化、平均向量算错、
 * 同一分P 内相邻段落没去重 —— 每一种都会让推荐「看起来像随机」。
 * 这些逻辑放在主进程里跟 SQLite 缠在一起就没法测，所以算法全部放在这里：
 * 纯函数、零依赖、可单测。
 *
 * ## 两种推荐
 *
 * - **twins（语义双胞胎）**：给一个片段，找出**其它视频**里讲同一件事的片段。
 *   用途：同一个知识点在几场直播里都讲过 → 攒一起做合集。
 *   刻意**排除同一个视频** —— 同一场直播里前后重复的话没有取材价值。
 * - **highlight（代表段落）**：一个视频里离它**语义中心**最近的几段。
 *   用来回答「这场两小时的直播，哪几段最值得剪」。
 *
 * ## 归一化约定
 *
 * 模型输出的向量本来已归一化（transformers 的 `normalize: true`），但**落库再读出来**
 * 之后不保证（旧数据、手工写入）。所以这里一律按「任意向量」处理：
 * 需要余弦时自己算模长，避免出现余弦 > 1 这种明显不对的分数。
 */

/**
 * 把向量编码成可落库的 Buffer（Float32 小端）。
 *
 * ⚠️ **必须先复制再取 `buffer`**。
 * `Float32Array.from()` / `meanVector()` 返回的视图可能带非零 `byteOffset`，
 * 而 `Buffer.from(view.buffer, offset, length)` 与「元素数」两类长度混在一起极易写歪。
 * 实测这样写出来的语义中心读回来是 `-4.565477072096698e+27` 这种垃圾值，
 * 表现为「某视频的段落与**自己视频的平均向量**相似度却低于 0.05」——
 * 数学上不可能，但代码不报错，只有「按距离排序」的推荐会暴露成「永远挑不出段落」。
 *
 * 复制一份（`byteOffset` 归零、`byteLength` 就是全部数据）是唯一不会错的做法。
 */
export function encodeVector(vec: ArrayLike<number>): Buffer {
  const safe = Float32Array.from(vec)
  return Buffer.from(safe.buffer, safe.byteOffset, safe.byteLength)
}

/**
 * 把落库的 Buffer 解码回向量（Float32 小端）。
 *
 * ⚠️ 同样必须先复制：SQLite 返回的 Buffer 常常是共享缓冲上的视图（`byteOffset` ≠ 0），
 * 直接拿 `buf.buffer` 构造会得到错误的长度或偏移 ——
 * 表现为 `RangeError: Invalid typed array length`（实测踩过）。
 */
export function decodeVector(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}

/** 余弦相似度；任一向量为零向量时返回 0（而不是 NaN） */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  const score = dot / (Math.sqrt(na) * Math.sqrt(nb))
  // 浮点误差可能让它略微超出 [-1,1]
  return Math.max(-1, Math.min(1, score))
}

/** 向量平均（用于求「一个视频的语义中心」）；空输入返回空数组 */
export function meanVector(vectors: ArrayLike<number>[]): Float64Array {
  if (!vectors.length) return new Float64Array(0)
  const dim = vectors[0].length
  const out = new Float64Array(dim)
  let count = 0
  for (const v of vectors) {
    if (v.length !== dim) continue
    for (let i = 0; i < dim; i++) out[i] += v[i]
    count++
  }
  if (!count) return new Float64Array(0)
  for (let i = 0; i < dim; i++) out[i] /= count
  return out
}

export interface ScoredChunk {
  chunkId: number
  score: number
}

/**
 * 从候选里挑 top-N。
 *
 * @param exclude 需要排除的 chunkId（例如查询来源自己）
 * @param minScore 分数下限（低于它的不推荐，宁缺毋滥）
 */
export function topN(
  scored: ScoredChunk[],
  n: number,
  exclude: Set<number> = new Set(),
  minScore = 0
): ScoredChunk[] {
  return scored
    .filter((s) => !exclude.has(s.chunkId) && s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, n))
}

/**
 * 同一文档内「挨得太近」的段落只保留分数最高的那条。
 *
 * 为什么需要：一个 45 秒窗口切出来的相邻段落内容高度重叠，
 * 不去重的话 top-10 里可能全是同一分钟里的相邻段 —— 看起来像只推荐了一条。
 *
 * @param meta 取每个 chunk 的 (docId, start)，用于判重
 * @param windowSeconds 多近算「挨着」（默认 120 秒）
 */
export function dedupeNearby<T extends { chunkId: number; score: number }>(
  items: T[],
  meta: (chunkId: number) => { docId: number; start: number } | null,
  windowSeconds = 120
): T[] {
  const accepted: Array<{ docId: number; start: number }> = []
  const out: T[] = []
  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const m = meta(item.chunkId)
    if (!m) continue
    const tooClose = accepted.some(
      (a) => a.docId === m.docId && Math.abs(a.start - m.start) < windowSeconds
    )
    if (tooClose) continue
    accepted.push(m)
    out.push(item)
  }
  return out
}

/**
 * 推荐理由文案（给用户看的一句话）。
 * 分数就是余弦相似度，用「同义」/「接近」这类词比裸数字好懂。
 */
export function twinsReason(score: number): string {
  if (score >= 0.85) return '几乎在讲同一件事'
  if (score >= 0.7) return '主题高度重合'
  if (score >= 0.55) return '内容相关'
  return '有一点关联'
}

/**
 * 「主题最鲜明」的理由。
 *
 * ⚠️ 这里刻意**不**用「最贴近视频主题」那种说法：
 * 实测按「离语义中心最近」挑出来的全是「哈哈啊我我」「你们能懂吗」这类**最泛泛的口水话**
 * （直播类内容里近 20% 的字幕都是这类），对「哪段值得剪」毫无帮助。
 * 真正有用的恰恰是**离铺陈基调最远**的那些 —— 讲具体事、给具体观点、有明确信息量的段落。
 *
 * @param distance 1 - 余弦相似度（越大 = 越偏离视频平均语义）
 * @param rank 第几名
 * @param fromTopic 视频自身的「泛泛程度」：整场越泛，能挑出的「鲜明」段落也越泛，
 *   这时要如实说明，不能让用户以为捡到宝了
 */
export function highlightReason(distance: number, rank: number, fromTopic = 1): string {
  const level =
    distance >= 0.45
      ? '主题很鲜明（和整场的泛泛而谈明显不同）'
      : distance >= 0.3
        ? '有明确内容（不是铺陈）'
        : '与整场基调差别不大'
  const caveat =
    fromTopic < 0.5 ? '；注意这场内容本身比较散，可挑选余地有限' : ''
  return `第 ${rank} 推荐 · ${level}${caveat}`
}

/** 「贴近整体基调」的理由（预告 / 切片选段用） */
export function typicalReason(score: number, rank: number): string {
  const level =
    score >= 0.85 ? '几乎就是这个视频的缩影' : score >= 0.7 ? '很贴近整体基调' : '部分贴近整体基调'
  return `第 ${rank} 推荐 · ${level}`
}
