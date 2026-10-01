/**
 * 切片任务编排。
 *
 * 单个任务的流程：
 *   1. 拿视频信息（cid）与 DASH 播放地址
 *   2. 下载 SIDX 索引 → 算出目标时间对应的字节区间 → 只下载这一段
 *   3. ffmpeg 裁剪音视频并封装 mp4
 *
 * 跨分P：一个任务可包含多段（segments）。各段分别裁剪成临时 mp4，
 * 再用 concat 拼成一个视频 —— 这样「Pn 末尾 + Pn+1 开头」能合成一个连续片段。
 *
 * 任务之间串行（ffmpeg 同一时刻只跑一个），任务内部的字节区间可并发下载。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BiliVideoInfo } from '@shared/types'
import * as bili from '../bilibili'
import { loadSettings } from '../settings'
import { downloadRange, downloadRangesConcurrent } from './downloader'
import { concatVideos, cutAndMux, resolveFfmpeg } from './ffmpeg'
import { getPlayInfo, type DashStream, type PlayInfo } from './playurl'
import { buildChunks, computeRange, parallelFactor, parseSidx, splitRange } from './sidx'

export interface SliceSegmentInput {
  page: number
  start: number
  end: number
}

export interface SliceTaskInput {
  bvid: string
  page: number
  start: number
  end: number
  note: string
  /** 跨分P：多段依次裁剪后拼接（单段时留空） */
  segments?: SliceSegmentInput[]
}

export type SlicePhase = 'resolve' | 'download' | 'cut' | 'mux' | 'done' | 'error'

export interface SliceProgress {
  index: number
  total: number
  note: string
  phase: SlicePhase
  /** 0~100 */
  percent: number
  message?: string
}

export interface SliceResult {
  ok: number
  failed: number
  outputs: string[]
  messages: string[]
}

function sanitize(name: string): string {
  return (
    String(name || 'clip')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 96) || 'clip'
  )
}

/** 下载某个流在 [startSec, endSec] 内需要的字节，返回分片数据与裁剪参数 */
async function fetchSegment(
  stream: DashStream,
  startSec: number,
  endSec: number,
  isVideo: boolean,
  concurrency: number,
  signal: AbortSignal,
  onBytes?: (n: number) => void
): Promise<{ buffer: Buffer; ss: number; t: number }> {
  const [indexStart, indexEnd] = stream.indexRange.split('-').map((x) => Number(x))
  if (!Number.isFinite(indexStart) || !Number.isFinite(indexEnd)) {
    throw new Error(`无法解析 index_range：${stream.indexRange}`)
  }

  const head = await downloadRange(stream.url, 0, indexEnd, { signal })
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const sidx = parseSidx(view, indexStart)
  const chunks = buildChunks(sidx, indexEnd)
  if (!chunks.length) throw new Error('SIDX 里没有分片信息')

  const range = computeRange(chunks, startSec, endSec, isVideo)
  const parts = splitRange(
    range.dataRange,
    parallelFactor(range.totalSize) * Math.max(1, concurrency)
  )
  const body = await downloadRangesConcurrent(stream.url, parts, concurrency, { signal, onBytes })

  return {
    buffer: Buffer.concat([head, body]),
    ss: Math.max(0, range.ffmpegSs),
    t: Math.max(0.05, range.ffmpegT)
  }
}

interface RunContext {
  ffmpeg: string
  cookie: string
  quality: number
  concurrency: number
  outDir: string
  signal: AbortSignal
  infoCache: Map<string, BiliVideoInfo>
  streamCache: Map<string, PlayInfo>
  report: (phase: SlicePhase, percent: number) => void
}

/** 把某一段裁剪输出成 mp4（output 是该段的最终文件） */
async function sliceSegment(
  ctx: RunContext,
  bvid: string,
  segment: SliceSegmentInput,
  output: string,
  stamp: string
): Promise<void> {
  let info = ctx.infoCache.get(bvid)
  if (!info) {
    info = await bili.getVideoInfo(bvid, ctx.cookie)
    ctx.infoCache.set(bvid, info)
  }
  const pageInfo = info.pages.find((p) => p.page === segment.page) ?? info.pages[0]
  if (!pageInfo?.cid) throw new Error(`找不到第 ${segment.page} P 的 cid`)

  const cacheKey = `${bvid}:${pageInfo.cid}:${ctx.quality}`
  let play = ctx.streamCache.get(cacheKey)
  if (!play) {
    play = await getPlayInfo(bvid, pageInfo.cid, ctx.cookie, ctx.quality)
    ctx.streamCache.set(cacheKey, play)
  }
  const videoStream = play.video[0]
  if (!videoStream) throw new Error('没有可用的视频流')
  const audioStream = play.audio[0] ?? null

  ctx.report('download', 12)

  const videoSeg = await fetchSegment(
    videoStream,
    segment.start,
    segment.end,
    true,
    ctx.concurrency,
    ctx.signal
  )
  let audioSeg: { buffer: Buffer; ss: number; t: number } | null = null
  if (audioStream) {
    ctx.report('download', 55)
    audioSeg = await fetchSegment(
      audioStream,
      segment.start,
      segment.end,
      false,
      ctx.concurrency,
      ctx.signal
    )
  }

  ctx.report('cut', 78)

  const videoFile = join(ctx.outDir, `.slice-src-${stamp}.m4s`)
  const audioFile = audioSeg ? join(ctx.outDir, `.slice-src-${stamp}.a.m4s`) : null
  writeFileSync(videoFile, videoSeg.buffer)
  if (audioFile && audioSeg) writeFileSync(audioFile, audioSeg.buffer)

  try {
    await cutAndMux({
      ffmpeg: ctx.ffmpeg,
      videoFile,
      audioFile,
      vSs: videoSeg.ss,
      vT: videoSeg.t,
      aSs: audioSeg?.ss ?? 0,
      aT: audioSeg?.t ?? 0,
      audioCodec: audioStream?.codecs ?? '',
      output,
      signal: ctx.signal
    })
  } finally {
    rmSync(videoFile, { force: true })
    if (audioFile) rmSync(audioFile, { force: true })
  }
}

/** 执行一批切片任务 */
export async function runSliceTasks(
  tasks: SliceTaskInput[],
  onProgress: (p: SliceProgress) => void,
  signal: AbortSignal
): Promise<SliceResult> {
  const settings = loadSettings()
  const ffmpeg = resolveFfmpeg()
  if (!ffmpeg) {
    throw new Error('未找到 ffmpeg，请先在「设置 → 本地切片」里指定路径或一键下载')
  }

  const outDir = settings.sliceOutputDir?.trim() || settings.outputDir
  mkdirSync(outDir, { recursive: true })

  const outputs: string[] = []
  const messages: string[] = []
  let ok = 0
  let failed = 0

  const baseCtx = {
    ffmpeg,
    quality: settings.sliceQuality || 80,
    concurrency: Math.max(1, Math.min(8, settings.sliceConcurrency || 3)),
    outDir,
    signal,
    infoCache: new Map<string, BiliVideoInfo>(),
    streamCache: new Map<string, PlayInfo>()
  }

  for (let i = 0; i < tasks.length; i++) {
    if (signal.aborted) break
    const task = tasks[i]
    const label = task.note || `${task.bvid} P${task.page} ${task.start}-${task.end}`

    const report = (phase: SlicePhase, percent: number): void => {
      onProgress({ index: i, total: tasks.length, note: label, phase, percent })
    }
    const ctx: RunContext = { ...baseCtx, cookie: loadSettings().biliCookie, report }

    // 组装要切的段：跨P 时会有多段
    const segments: SliceSegmentInput[] =
      task.segments && task.segments.length > 1
        ? task.segments
        : [{ page: task.page, start: task.start, end: task.end }]

    const stamp = `${i}-${process.pid}-${Date.now()}`

    try {
      report('resolve', 3)
      const output = join(outDir, `${sanitize(label)}.mp4`)

      if (segments.length === 1) {
        await sliceSegment(ctx, task.bvid, segments[0], output, stamp)
      } else {
        // 跨分P：逐段裁到临时文件，再拼接
        const temps: string[] = []
        try {
          for (let s = 0; s < segments.length; s++) {
            report(
              'download',
              Math.round((s / segments.length) * 70)
            )
            const tmp = join(outDir, `.slice-part-${stamp}-${s}.mp4`)
            await sliceSegment(ctx, task.bvid, segments[s], tmp, `${stamp}-${s}`)
            temps.push(tmp)
          }
          report('mux', 88)
          try {
            await concatVideos(ffmpeg, temps, output, { signal })
          } catch {
            // 各段编码参数不一致时 copy 会失败，回退到重编码
            await concatVideos(ffmpeg, temps, output, { signal, reencode: true })
          }
        } finally {
          for (const t of temps) rmSync(t, { force: true })
        }
      }

      ok++
      outputs.push(output)
      report('done', 100)
    } catch (err) {
      if ((err as Error).name === 'AbortError' || signal.aborted) break
      failed++
      messages.push(`${label}：${(err as Error).message}`)
      onProgress({
        index: i,
        total: tasks.length,
        note: label,
        phase: 'error',
        percent: 0,
        message: (err as Error).message
      })
    }
  }

  return { ok, failed, outputs, messages }
}
