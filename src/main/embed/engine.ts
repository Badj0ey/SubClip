/**
 * 语义索引引擎（第四阶段下半）。
 *
 * ## 数据模型
 *
 * - `semantic_chunks`：一个「段落」= 同一分P 内相邻若干条字幕合并成的一段话（默认 45 秒窗口），
 *   存起止时间、首句序号与拼接文本，**向量单独放 `semantic_vectors`**（BLOB，Float32 小端）。
 * - 索引粒度刻意不是「每一条字幕」：真实库有十万条字幕，逐条向量化要 7 分钟以上、
 *   还要存 200MB 向量；按 45 秒窗口合并后大约少一个数量级，而检索精度几乎无损
 *   （用户要的是「这个意思在哪一段」，不是精确到哪一句）。
 *
 * ## 建索引的方式
 *
 * 自动排队、慢慢来（用户选的方案）：`startIndexing()` 把「还没有向量的段落」
 * 一批一批（默认 32 条）喂给 worker，批间让出事件循环，随时可以暂停/继续。
 * 主进程重启后自动接着上次的进度（判断依据就是「有没有向量」）。
 *
 * ## 检索
 *
 * 暴力余弦：向量已归一化，点积即余弦。十万条 × 512 维的点积约 0.2 秒（纯 JS），
 * 而实际是几千到几万条，几十毫秒级 —— 不值得为此引入向量数据库依赖。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SemanticHit, SemanticSearchResult, SemanticStatus } from '@shared/types'
import * as db from '../db'
import { loadSettings } from '../settings'
import { downloadModel, isModelReady, modelDir, modelSizeMb, removeModel } from './download'

/** 一批处理多少段落（太大卡顿，太小开销高） */
const BATCH = 32

interface WorkerRequest {
  id: number
  type: 'init' | 'embed'
  texts?: string[]
}

interface WorkerReply {
  id?: number
  type?: 'ready' | 'error'
  ok?: boolean
  message?: string
  vectors?: Float32Array
  dim?: number
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>()

/** 运行状态（给设置页 / 检索页看） */
let busy: SemanticStatus['busy'] = 'idle'
let message = ''
let indexing = false
let stopRequested = false
/** 已加载进内存的向量维度（0 = 还没跑过） */
let dim = 0

function cacheRoot(): string {
  // 模型缓存放在应用数据目录下（与数据库同级），换机器时直接拷走可用
  return join(db.dataDir(), 'embed-models')
}

/**
 * 找 worker 文件。
 *
 * 开发（electron-vite dev）与生产（打包后的 asar）下 `__dirname` 不一样，
 * 所以按几个候选位置依次找 —— 比在构建期注入绝对路径更抗折腾：
 *  - `out/main/embed/worker.cjs`（生产：构建产物里）
 *  - `src/main/embed/worker.cjs`（开发：源码目录）
 *  - `<cwd>/src/main/embed/worker.cjs`
 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'embed', 'worker.cjs'),
    join(__dirname, 'worker.cjs'),
    join(process.cwd(), 'src', 'main', 'embed', 'worker.cjs'),
    join(process.cwd(), 'out', 'main', 'embed', 'worker.cjs')
  ]
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) {
    throw new Error(
      `找不到 Embedding worker（已找过：${candidates.join(' / ')}）。` +
        '若这是打包后的应用，说明构建时没有把 worker.cjs 拷进 out/main/embed/。'
    )
  }
  return hit
}

/**
 * 启动（或复用）worker。
 * 每次都要重新读设置：模型名与下载源都可能在设置页改过。
 */
function ensureWorker(): Worker {
  if (worker) return worker
  const url = resolveWorkerPath()
  const settings = loadSettings()
  worker = new Worker(url, {
    workerData: { cacheDir: cacheRoot(), modelId: settings.embedModel }
  })
  worker.on('message', (reply: WorkerReply) => {
    if (reply?.type === 'ready') return
    const id = reply?.id
    if (id == null) return
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    if (reply.ok) waiter.resolve(reply)
    else waiter.reject(new Error(reply.message || 'Embedding 计算失败'))
  })
  worker.on('error', (err) => {
    for (const [, waiter] of pending) waiter.reject(err)
    pending.clear()
    worker = null
  })
  worker.on('exit', () => {
    worker = null
  })
  return worker
}

function call(req: Omit<WorkerRequest, 'id'>): Promise<WorkerReply> {
  const w = ensureWorker()
  const id = ++seq
  return new Promise<WorkerReply>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ ...req, id } as WorkerRequest)
  })
}

/** 把普通向量数组编码成 BLOB（Float32 小端） */
export function encodeVector(vec: Float32Array | number[]): Buffer {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

/** BLOB → Float32Array */
export function decodeVector(buf: Buffer): Float32Array {
  // Buffer 可能来自 sqlite 的共享缓冲，copy 一份避免对齐问题
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/* --------------------------------- 状态 --------------------------------- */

export function status(): SemanticStatus {
  const settings = loadSettings()
  const counts = db.semanticCounts()
  return {
    modelReady: isModelReady(cacheRoot(), settings.embedModel),
    modelSizeMb: modelSizeMb(cacheRoot(), settings.embedModel),
    loaded: dim > 0,
    totalChunks: counts.total,
    indexedChunks: counts.indexed,
    indexing,
    busy,
    message
  }
}

/** 供 db 层拿到向量维度的写入（维度由模型决定，写入时才知道） */
export function setVectorDim(value: number): void {
  dim = value
}

export function getVectorDim(): number {
  return dim
}

/* ------------------------------- 建索引 --------------------------------- */

/**
 * 开始（或继续）建索引。
 *
 * 幂等：已经在跑就直接返回。处理完所有待索引段落自动停。
 * 每批之间 `setImmediate` 让出事件循环，界面与插件通信不会被饿死。
 */
export async function startIndexing(): Promise<void> {
  if (indexing) return
  const settings = loadSettings()
  if (!isModelReady(cacheRoot(), settings.embedModel)) {
    message = '模型还没下载，请先在设置页下载'
    return
  }
  indexing = true
  stopRequested = false
  busy = 'loading'
  message = '正在加载模型…'
  try {
    // 段落切分：把所有还没有段落的文档切一遍（便宜，先做掉）
    db.buildSemanticChunks()
    busy = 'indexing'
    for (;;) {
      if (stopRequested) {
        message = '已暂停'
        break
      }
      const batch = db.nextUnindexedChunks(BATCH)
      if (!batch.length) {
        message = '索引已是最新'
        break
      }
      message = `正在索引 ${db.semanticCounts().indexed}/${db.semanticCounts().total} 段…`
      const reply = await call({ type: 'embed', texts: batch.map((c) => c.text) })
      const vectors = reply.vectors
      const d = reply.dim ?? 0
      if (!vectors || !d) throw new Error('Embedding 返回为空')
      dim = d
      db.saveChunkVectors(
        batch.map((c, i) => ({
          chunkId: c.id,
          // 一个 Float32Array 里按顺序排了 batch.length 个向量，这里按维度切片
          vector: encodeVector(vectors.subarray(i * d, (i + 1) * d))
        })),
        d
      )
      await new Promise((r) => setImmediate(r))
    }
  } catch (err) {
    message = `索引失败：${(err as Error).message}`
  } finally {
    indexing = false
    busy = 'idle'
  }
}

/** 请求暂停（当前这一批跑完就停） */
export function stopIndexing(): void {
  stopRequested = true
}

/* ------------------------------- 模型下载 ------------------------------- */

export interface DownloadReport {
  ok: boolean
  message: string
  tlsError: boolean
}

/** 下载模型（带进度回调，统一写进 message 供界面轮询显示） */
export async function downloadModelForApp(
  onProgress?: (p: { done: number; total: number; file: string; received: number; fileBytes: number }) => void
): Promise<DownloadReport> {
  const settings = loadSettings()
  busy = 'downloading'
  message = '开始下载模型…'
  try {
    const res = await downloadModel(
      cacheRoot(),
      settings.embedModel,
      settings.embedHost,
      settings.embedInsecureTls,
      (p) => {
        const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)
        message =
          p.fileBytes > 0
            ? `下载 ${p.file}（${mb(p.received)}/${mb(p.fileBytes)}MB）`
            : `下载 ${p.file}（${p.done}/${p.total}）`
        onProgress?.(p)
      }
    )
    message = res.ok ? '模型下载完成' : res.message
    return { ok: res.ok, message: res.message, tlsError: res.tlsError }
  } finally {
    busy = 'idle'
  }
}

export function deleteModel(): void {
  const settings = loadSettings()
  removeModel(cacheRoot(), settings.embedModel)
  message = '模型已删除'
}

export function modelPath(): string {
  const settings = loadSettings()
  return modelDir(cacheRoot(), settings.embedModel)
}

/* -------------------------------- 语义检索 ------------------------------- */

/**
 * 语义搜索。
 *
 * @param keyword 自然语言查询（不需要非得是关键词）
 * @param limit   返回多少条
 */
export async function semanticSearch(keyword: string, limit = 50): Promise<SemanticSearchResult> {
  const settings = loadSettings()
  const kw = (keyword ?? '').trim()
  const counts = db.semanticCounts()
  if (!kw) return { hits: [], partial: false, indexedChunks: counts.indexed, totalChunks: counts.total }
  if (!isModelReady(cacheRoot(), settings.embedModel)) {
    throw new Error('语义检索需要先下载模型（设置 → 语义检索）')
  }

  busy = 'loading'
  message = '正在编码查询…'
  try {
    const reply = await call({ type: 'embed', texts: [kw] })
    const vectors = reply.vectors
    const d = reply.dim ?? 0
    if (!vectors || !d) throw new Error('查询编码失败')
    dim = d
    const query = vectors.subarray(0, d)

    // 取回全部向量暴力算余弦（已归一化 → 点积即余弦）
    const rows = db.allChunkVectors()
    const scored: Array<{ chunkId: number; score: number }> = []
    for (const row of rows) {
      const v = decodeVector(row.vector)
      let dot = 0
      for (let i = 0; i < d; i++) dot += query[i] * v[i]
      scored.push({ chunkId: row.chunkId, score: dot })
    }
    scored.sort((a, b) => b.score - a.score)

    // 同一条视频内相邻段落会被同时召回，做一次去重：同一分P 只留分数最高的一段
    const seen = new Set<string>()
    const picked: Array<{ chunkId: number; score: number }> = []
    for (const s of scored) {
      if (picked.length >= limit) break
      const meta = db.chunkMeta(s.chunkId)
      if (!meta) continue
      const key = `${meta.docId}:${Math.floor(meta.start / 30)}`
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(s)
    }

    const hits: SemanticHit[] = []
    for (const p of picked) {
      const meta = db.chunkMeta(p.chunkId)
      if (!meta) continue
      const video = db.getVideo(meta.videoId)
      hits.push({
        docId: meta.docId,
        videoId: meta.videoId,
        bvid: video?.bvid ?? '',
        page: meta.page,
        index: meta.firstIdx,
        start: meta.start,
        end: meta.end,
        text: meta.text,
        videoTitle: video?.title ?? '',
        uploaderName: video?.uploaderName ?? '',
        docLabel: meta.docLabel,
        // 视频所属集合（范围筛选用）；UP主 id 由 db 层带出来
        uploaderId: meta.uploaderId,
        collectionId: video?.collectionId ?? null,
        score: Math.round(p.score * 1000) / 1000
      })
    }

    message = ''
    return {
      hits,
      partial: counts.indexed < counts.total,
      indexedChunks: counts.indexed,
      totalChunks: counts.total
    }
  } finally {
    busy = 'idle'
  }
}

/** 退出前收掉 worker（否则 Electron 会因为还有线程活着而不退出） */
export async function shutdownEmbed(): Promise<void> {
  const w = worker
  worker = null
  if (w) await w.terminate()
}
