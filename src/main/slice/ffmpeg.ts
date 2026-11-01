/**
 * ffmpeg 调用。
 *
 * 原工具用的是 ffmpeg.wasm（浏览器里跑）；移植到桌面端后改用原生 ffmpeg 可执行文件，
 * 速度快很多。裁剪流程与原实现保持一致：先 remux 成 mp4，再精确裁剪，最后合并音视频。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { loadSettings } from '../settings'
import { subtitlesFilter } from './ass'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

function findInPath(exe: string): string | null {
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const p of paths) {
    if (!p) continue
    const full = join(p, exe)
    try {
      if (existsSync(full)) return full
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 用户自备副本的位置：设置里指定路径之外，也可以手动放到这里 */
export function userFfmpegPath(): string {
  return join(app.getPath('userData'), 'bin', EXE)
}

/**
 * 安装包内置的 ffmpeg。
 *
 * `electron-builder.yml` 把 `vendor/ffmpeg` 复制到 `resources/ffmpeg`，
 * 所以正式安装后无需联网、无需配置即可切片；开发态没有这个目录，返回空串。
 */
export function packagedFfmpegPath(): string {
  if (!app.isPackaged) return ''
  return join(process.resourcesPath, 'ffmpeg', EXE)
}

/**
 * 定位 ffmpeg：设置里指定 → 用户自备副本 → 安装包内置 → PATH。
 * 返回 null 表示没找到，切片功能会提示先安装。
 */
export function resolveFfmpeg(): string | null {
  const settings = loadSettings()

  const custom = settings.ffmpegPath?.trim()
  if (custom && existsSync(custom)) return custom

  const userCopy = userFfmpegPath()
  if (existsSync(userCopy)) return userCopy

  const packaged = packagedFfmpegPath()
  if (packaged && existsSync(packaged)) return packaged

  return findInPath(EXE)
}

/** 执行 ffmpeg，收集 stderr（ffmpeg 的输出都在 stderr） */
export function runFfmpeg(
  bin: string,
  args: string[],
  opts: {
    onLog?: (line: string) => void
    signal?: AbortSignal
    /** 无输出多久判为卡死（毫秒），默认 10 分钟（ffmpeg 正常时持续刷统计行） */
    idleTimeoutMs?: number
  } = {}
): Promise<void> {
  const { onLog, signal, idleTimeoutMs = 10 * 60_000 } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let tail = ''

    // 卡死兜底：ffmpeg 正常工作时会持续往 stderr 刷统计行；
    // 长时间没有任何输出说明它已挂住，杀掉并让任务明确报错而不是无限等待。
    const killHang = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      reject(
        new Error(`ffmpeg 长时间无输出（超过 ${Math.round(idleTimeoutMs / 60000)} 分钟），已中止`)
      )
    }
    let idleTimer: NodeJS.Timeout | null = setTimeout(killHang, idleTimeoutMs)
    const poke = (): void => {
      if (!idleTimer) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(killHang, idleTimeoutMs)
    }
    const stopIdle = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-6000)
      onLog?.(text)
      poke()
    })
    child.stdout?.on('data', () => {
      poke()
    })

    child.on('error', (err) => {
      stopIdle()
      reject(new Error(`无法启动 ffmpeg：${err.message}`))
    })
    child.on('close', (code) => {
      stopIdle()
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}\n${tail.slice(-1000)}`))
    })

    if (signal) {
      const onAbort = (): void => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      child.on('close', () => signal.removeEventListener('abort', onAbort))
    }
  })
}

/**
 * 顺序拼接多个 mp4（跨分P 切片时用）。
 * 用 concat demuxer + `-c copy`，要求各段编码参数一致（同一稿件的不同分P 通常一致）；
 * 若参数不一致导致失败，调用方可以回退到重编码。
 */
export async function concatVideos(
  ffmpeg: string,
  inputs: string[],
  output: string,
  opts: { onLog?: (line: string) => void; signal?: AbortSignal; reencode?: boolean } = {}
): Promise<void> {
  if (inputs.length < 2) throw new Error('拼接至少需要两个片段')
  const dir = dirname(output)
  mkdirSync(dir, { recursive: true })
  const listFile = join(dir, `.slice-concat-${process.pid}-${Date.now()}.txt`)

  const escape = (p: string): string => p.replace(/\\/g, '/').replace(/'/g, "'\\''")
  writeFileSync(listFile, inputs.map((f) => `file '${escape(f)}'`).join('\n'), 'utf8')

  const args = opts.reencode
    ? [
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        '-y', output
      ]
    : ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', output]

  try {
    await runFfmpeg(ffmpeg, args, opts)
  } finally {
    rmSync(listFile, { force: true })
  }
}

export interface CutOptions {
  ffmpeg: string
  /** 已下载好的视频分片文件（.m4s） */
  videoFile: string
  /** 已下载好的音频分片文件（.m4s），可为空 */
  audioFile: string | null
  vSs: number
  vT: number
  aSs: number
  aT: number
  /** 音频 codecs 串，用于判断要不要转码（flac 需要） */
  audioCodec?: string
  output: string
  /**
   * 烧录字幕：ASS 文件（时间已平移为相对本段起点）。
   * 有值即启用重新编码烧录，否则走无损 copy。
   */
  assFile?: string
  /** 附加字体目录（导入字体时注册给 libass；留空走系统字体） */
  fontsDir?: string
  onLog?: (line: string) => void
  signal?: AbortSignal
}

/**
 * 精确裁剪并封装成 mp4。
 * 参数语义与原工具的 cutAndMux 一致。
 */
export async function cutAndMux(opts: CutOptions): Promise<void> {
  const { ffmpeg, videoFile, audioFile, vSs, vT, aSs, aT, output, onLog, signal } = opts
  const isFlac = /flac/i.test(opts.audioCodec ?? '')
  const ss = (n: number): string => Number(n).toFixed(3)

  const dir = dirname(output)
  mkdirSync(dir, { recursive: true })

  const stamp = `${process.pid}-${Date.now()}`
  const tempV = join(dir, `.slice-${stamp}-v.mp4`)
  const midV = join(dir, `.slice-${stamp}-mid.mp4`)
  const tempA = join(dir, `.slice-${stamp}-a.${isFlac ? 'flac' : 'm4a'}`)
  const midA = join(dir, `.slice-${stamp}-out.${isFlac ? 'flac' : 'm4a'}`)
  const cleanup = [tempV, midV, tempA, midA]

  try {
    // 1. 视频：remux 成标准 mp4
    await runFfmpeg(ffmpeg, ['-i', videoFile, '-c', 'copy', '-y', tempV], { onLog, signal })
    // 2. 视频：精确裁剪；烧录字幕时必须重编码（copy 只是复制原始画面）
    if (opts.assFile) {
      await runFfmpeg(
        ffmpeg,
        [
          '-ss', ss(vSs),
          '-i', tempV,
          '-t', ss(vT),
          '-vf', subtitlesFilter(opts.assFile, opts.fontsDir),
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-y', midV
        ],
        { onLog, signal }
      )
    } else {
      await runFfmpeg(
        ffmpeg,
        ['-ss', ss(vSs), '-i', tempV, '-t', ss(vT), '-c', 'copy', '-y', midV],
        { onLog, signal }
      )
    }

    if (audioFile) {
      // 3. 音频：remux + 裁剪
      await runFfmpeg(
        ffmpeg,
        ['-i', audioFile, '-c', 'copy', '-y', tempA],
        { onLog, signal }
      )
      await runFfmpeg(
        ffmpeg,
        ['-i', tempA, '-ss', ss(aSs), '-t', ss(aT), '-c', 'copy', '-y', midA],
        { onLog, signal }
      )

      // 4. 合并（flac 需要转成 aac，否则 mp4 容器装不下）
      const audioArgs = isFlac ? ['-c:a', 'aac', '-b:a', '320k'] : ['-c:a', 'copy']
      await runFfmpeg(
        ffmpeg,
        ['-i', midV, '-i', midA, '-c:v', 'copy', ...audioArgs, '-shortest', '-y', output],
        { onLog, signal }
      )
    } else {
      await runFfmpeg(ffmpeg, ['-i', midV, '-c', 'copy', '-y', output], { onLog, signal })
    }
  } finally {
    for (const f of cleanup) {
      try {
        rmSync(f, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
