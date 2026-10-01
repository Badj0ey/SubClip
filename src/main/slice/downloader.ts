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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带 Range 的单区间下载，自动重试；服务器忽略 Range 时手动裁剪 */
export async function downloadRange(
  url: string,
  start: number,
  end: number,
  opts: DownloadOptions = {}
): Promise<Buffer> {
  const { signal, onBytes, retries = 2 } = opts
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    try {
      const res = await fetch(url, {
        headers: {
          Range: `bytes=${start}-${end}`,
          Referer: 'https://www.bilibili.com/',
          'User-Agent': UA
        },
        signal
      })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

      const raw = Buffer.from(await res.arrayBuffer())
      const out =
        res.status !== 206 && raw.length > end - start + 1
          ? raw.subarray(start, end + 1)
          : raw

      onBytes?.(out.length)
      return out
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      lastError = err
      if (attempt < retries) await sleep(600 * (attempt + 1))
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
