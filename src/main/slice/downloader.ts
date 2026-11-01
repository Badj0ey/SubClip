/**
 * DASH 分片下载（HTTP Range）。
 * 移植自 bilibili-slice-downloader 的 downloadRange / downloadRanges，
 * 改用 Node 的 fetch + Buffer，并支持多区间并发。
 */
import { UA } from '../bilibili'

export interface DownloadOptions {
  signal?: AbortSignal
  /** 每拿到一段字节回调一次，用于进度统计 */
  onBytes?: (n: number) => void
  retries?: number
  /** 单次请求超时（毫秒），默认 30s；网络挂起时任务不会无限等待 */
  timeoutMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 把「用户取消」和「超时」合成一个信号：哪个先来都中止这次 fetch */
function timedSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException(`下载超时（${timeoutMs}ms）`, 'TimeoutError')),
    timeoutMs
  )
  const onAbort = (): void =>
    controller.abort(signal?.reason ?? new DOMException('已取消', 'AbortError'))
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** 带 Range 的单区间下载，自动重试；服务器忽略 Range 时手动裁剪 */
export async function downloadRange(
  url: string,
  start: number,
  end: number,
  opts: DownloadOptions = {}
): Promise<Buffer> {
  const { signal, onBytes, retries = 2, timeoutMs = 30_000 } = opts
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const { signal: combined, dispose } = timedSignal(signal, timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          Range: `bytes=${start}-${end}`,
          Referer: 'https://www.bilibili.com/',
          'User-Agent': UA
        },
        signal: combined
      })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

      const raw = Buffer.from(await res.arrayBuffer())
      let out: Buffer
      if (res.status === 206) {
        // 服务器按 Range 返回，直接用
        out = raw
      } else {
        // 200：服务器忽略了 Range，可能返回整个文件（能自己裁），也可能被中间层截断。
        // 以前这里不校验长度，短包会被当成完整数据一路拼下去，
        // 最后只在 ffmpeg 阶段报一个看不懂的错。宁可在这里明确失败。
        if (raw.length < end + 1) {
          throw new Error(
            `服务器未按 Range 返回且数据不完整：需要到第 ${end} 字节，实际只收到 ${raw.length} 字节`
          )
        }
        out = raw.subarray(start, end + 1)
      }

      onBytes?.(out.length)
      return out
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      // 超时是网络挂起，重试也大概率同样挂起，直接失败让任务尽早报错
      if ((err as Error).name === 'TimeoutError') throw err
      lastError = err
      if (attempt < retries) await sleep(600 * (attempt + 1))
    } finally {
      dispose()
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 顺序下载多个区间并拼接 */
export async function downloadRanges(
  url: string,
  ranges: Array<[number, number]>,
  opts: DownloadOptions = {}
): Promise<Buffer> {
  const parts: Buffer[] = []
  for (const [s, e] of ranges) {
    parts.push(await downloadRange(url, s, e, opts))
  }
  return Buffer.concat(parts)
}

/**
 * 并发下载多个区间，结果按原顺序拼接。
 * 并发只影响网络并行度，拼接顺序始终保持一致。
 */
export async function downloadRangesConcurrent(
  url: string,
  ranges: Array<[number, number]>,
  concurrency: number,
  opts: DownloadOptions = {}
): Promise<Buffer> {
  if (ranges.length <= 1 || concurrency <= 1) {
    return downloadRanges(url, ranges, opts)
  }

  const results: Buffer[] = new Array(ranges.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= ranges.length) return
      const [s, e] = ranges[index]
      results[index] = await downloadRange(url, s, e, opts)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker())
  )
  return Buffer.concat(results)
}
