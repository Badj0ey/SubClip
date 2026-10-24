/**
 * Embedding 模型下载器（第四阶段下半）。
 *
 * ## 为什么不用 transformers 自带的下载器
 *
 * 它在本机会报 `self-signed certificate in certificate chain`：
 * 模型大文件会被镜像 302 到 `cas-bridge.xethub.hf.co`，那个域名的证书链在本机不全，
 * 而 transformers 内部只用一个 fetch 实例、没有「先严格后放宽」的余地。
 * 自己下载则可以把「严格失败 → 明确告诉用户 → 用户开开关再试」这条路径做出来。
 *
 * ## 目录结构
 *
 * 按 HuggingFace 的约定摆放，这样 transformers 能直接**从本地加载**：
 * ```
 * <userData>/embed-models/<org>/<model>/
 *   config.json  tokenizer.json  tokenizer_config.json  special_tokens_map.json  vocab.txt
 *   onnx/model_quantized.onnx
 * ```
 * 只下 q8 量化那一个变体（约 95MB）—— 此外的 fp16 / int8 / q4 等变体用不到。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as https from 'node:https'

/** 需要下载的文件（相对模型目录） */
export const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_quantized.onnx'
] as const

export interface DownloadProgress {
  /** 已完成文件数 / 总文件数（按文件计，单文件内部不再细分） */
  done: number
  total: number
  /** 当前文件名 */
  file: string
  /** 已下载字节 / 总字节（单文件，未知时为 0） */
  received: number
  /** 当前文件总字节（未知时为 0） */
  fileBytes: number
}

export interface DownloadResult {
  ok: boolean
  /** 失败原因（成功时为空） */
  message: string
  /** 是否因为证书问题失败（界面据此建议打开「放宽 TLS 校验」） */
  tlsError: boolean
  bytes: number
}

/** 模型在本地缓存里的目录 */
export function modelDir(cacheRoot: string, modelId: string): string {
  return join(cacheRoot, modelId)
}

/** 模型是否已经全部下载好 */
export function isModelReady(cacheRoot: string, modelId: string): boolean {
  return MODEL_FILES.every((f) => existsSync(join(modelDir(cacheRoot, modelId), f)))
}

/** 模型占用体积（MB，用于设置页展示） */
export function modelSizeMb(cacheRoot: string, modelId: string): number {
  const dir = modelDir(cacheRoot, modelId)
  if (!existsSync(dir)) return 0
  let bytes = 0
  const walk = (p: string): void => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else bytes += statSync(full).size
    }
  }
  try {
    walk(dir)
  } catch {
    return 0
  }
  return Math.round((bytes / 1024 / 1024) * 10) / 10
}

function isCertError(err: unknown): boolean {
  const msg = String((err as { cause?: { message?: string } })?.cause?.message ?? (err as Error)?.message ?? err)
  return /certificate|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(msg)
}

/**
 * 下载单个文件。
 *
 * 刻意**不用全局的 `NODE_TLS_REJECT_UNAUTHORIZED=0`**：那是进程级的，
 * 会连带降低插件通信、B站接口等所有请求的安全性 —— 而用户授权放宽的只是「模型下载」这一件事。
 * 用 `node:https` 直接发请求，`rejectUnauthorized` 只作用于这一个连接。
 */
async function downloadOne(
  url: string,
  target: string,
  insecureTls: boolean,
  onChunk?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<number> {
  const tmp = `${target}.part`
  mkdirSync(dirname(target), { recursive: true })

  return await new Promise<number>((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': 'subclip', Accept: '*/*' },
        // 只在这一个连接上放宽证书校验（用户明确打开开关时才为 true）
        rejectUnauthorized: !insecureTls,
        signal
      },
      (res) => {
        // 跟随重定向（镜像会把大文件 302 到另一个域名）
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          downloadOne(next, target, insecureTls, onChunk, signal).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const total = Number(res.headers['content-length'] ?? 0)
        let received = 0
        const out = createWriteStream(tmp)
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          onChunk?.(received, total)
        })
        res.pipe(out)
        out.on('finish', () => {
          out.close()
          // 先写 .part 再改名：中途失败不会留下一个「看起来完整」的坏文件
          renameSync(tmp, target)
          resolve(received)
        })
        out.on('error', reject)
      }
    )
    req.on('error', reject)
  })
}

/**
 * 下载模型文件。
 *
 * @param insecureTls 放宽证书校验（对应设置里的 `embedInsecureTls`），
 *   **只作用于模型下载的 HTTP 连接**，不影响进程里其它网络请求。
 */
export async function downloadModel(
  cacheRoot: string,
  modelId: string,
  host: string,
  insecureTls: boolean,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const dir = modelDir(cacheRoot, modelId)
  mkdirSync(dir, { recursive: true })

  let totalBytes = 0
  try {
    for (let i = 0; i < MODEL_FILES.length; i++) {
      const rel = MODEL_FILES[i]
      const target = join(dir, rel)
      if (existsSync(target) && statSync(target).size > 0) {
        onProgress?.({ done: i + 1, total: MODEL_FILES.length, file: rel, received: 0, fileBytes: 0 })
        continue
      }
      const url = `${host.replace(/\/$/, '')}/${modelId}/resolve/main/${rel}`
      const received = await downloadOne(url, target, insecureTls, (got, total) => {
        onProgress?.({
          done: i,
          total: MODEL_FILES.length,
          file: rel,
          received: got,
          fileBytes: total
        })
      }, signal)
      totalBytes += received
      onProgress?.({
        done: i + 1,
        total: MODEL_FILES.length,
        file: rel,
        received,
        fileBytes: received
      })
    }

    return { ok: true, message: '', tlsError: false, bytes: totalBytes }
  } catch (err) {
    const tls = isCertError(err)
    return {
      ok: false,
      message: tls
        ? '下载被 TLS 证书拦住了（镜像的大文件会跳转到证书链不全的域名）。可以在设置里打开「放宽 TLS 校验」后重试，或手动把模型文件放进 embed-models 目录。'
        : `下载失败：${(err as Error).message}`,
      tlsError: tls,
      bytes: totalBytes
    }
  }
}

/** 删除已下载的模型（设置页「删除模型」用） */
export function removeModel(cacheRoot: string, modelId: string): void {
  const dir = modelDir(cacheRoot, modelId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
