/**
 * Embedding 推理工人（第四阶段下半）。
 *
 * ## 为什么用 worker_threads 而不是子进程
 *
 * ONNX（WASM 后端）是 **CPU 密集**的：一次批量编码能把主线程占满几十到几百毫秒，
 * 放在主进程里会让窗口卡顿、插件 WebSocket 掉线。
 * Worker 与主进程共享内存、启动更快，且不需要额外的 IPC 序列化层。
 *
 * ## 为什么是 .cjs
 *
 * electron-vite 只打包 `src/main` 的 TypeScript 入口，worker 文件是要在运行时
 * 用文件路径加载的，所以直接写成 CommonJS 放在 `src/main/embed/` 下，
 * 由构建配置原样拷贝（见 electron.vite.config.ts 的 copy 说明）。
 * 里面用动态 import 加载 ESM 的 transformers，避免 CJS/ESM 转换问题。
 *
 * 协议（父子用 postMessage 通信，消息都是朴素对象）：
 *   父 → 子：{ id, type: 'init' | 'embed', ... }
 *   子 → 父：{ id, ok, ... } / { type: 'ready' } / { type: 'error', message }
 */
const { parentPort, workerData } = require('node:worker_threads')

/** 已加载的 pipeline（只加载一次，之后复用） */
let extractor = null
/** 模型是否已初始化完成 */
let ready = false
/** 初始化中的 promise（并发调用时复用同一个初始化） */
let initPromise = null

async function init() {
  if (extractor) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    const t = await import('@huggingface/transformers')
    const env = t.env
    // 只从本地缓存加载：模型文件由主进程的 download.ts 下好放在这里。
    // 关掉远程模型是为了让「没下完就去搜」得到一个明确的错误，而不是静静地去联网下载。
    env.cacheDir = workerData.cacheDir
    env.allowRemoteModels = false
    env.allowLocalModels = true
    // 单线程 WASM：多线程后端在 Node 里需要 SharedArrayBuffer 支持，收益不稳
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1
    }

    extractor = await t.pipeline('feature-extraction', workerData.modelId, {
      dtype: workerData.dtype || 'q8'
      // 不指定 device：transformers v4 的 ONNX 后端里 Node 只认 dml / webgpu / cpu
      // （`wasm` 是浏览器侧的概念），默认走 CPU，不需要原生 onnxruntime-node 的 GPU 支持。
    })
    ready = true
    parentPort.postMessage({ type: 'ready' })
  })()

  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

parentPort.on('message', async (msg) => {
  const { id, type } = msg || {}
  try {
    if (type === 'init') {
      await init()
      parentPort.postMessage({ id, ok: true, dims: null })
      return
    }

    if (type === 'embed') {
      await init()
      const texts = Array.isArray(msg.texts) ? msg.texts : []
      if (!texts.length) {
        parentPort.postMessage({ id, ok: true, vectors: [], dim: 0 })
        return
      }
      const out = await extractor(texts, { pooling: 'mean', normalize: true })
      const dims = out.dims
      const dim = dims[dims.length - 1]
      // Float32Array 可以结构化克隆，不必转成普通数组（十万条时这个差别很大）
      const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
      parentPort.postMessage({ id, ok: true, vectors: data, dim, count: texts.length })
      return
    }

    parentPort.postMessage({ id, ok: false, message: `未知消息类型：${String(type)}` })
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      message: err && err.message ? err.message : String(err),
      ready
    })
  }
})
