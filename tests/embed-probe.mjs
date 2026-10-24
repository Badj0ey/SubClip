/**
 * 语义检索可行性探针（第四阶段下半）。
 *
 * 在写正式代码之前确认三件事：
 *  1. 模型能否从镜像（hf-mirror）**下载到本地目录**；
 *  2. WASM 后端（transformers.js 默认）能否真的算出向量；
 *  3. 一条文本要多久 —— 决定十万条字幕建索引的时间是否可接受。
 *
 * 实现方式刻意**不用 transformers 自带的下载器**：
 * 它在本机会报 `self-signed certificate in certificate chain`（直连 huggingface.co 的证书链不全），
 * 而同样的地址用 Node 原生 fetch 访问 hf-mirror 是正常的。
 * 所以我们自己下载文件、自己摆成 HF 的目录结构，再让 transformers **从本地加载**。
 *
 * 用法：node tests/embed-probe.mjs [缓存根目录]
 *   缓存根目录默认为 ./.embed-probe-cache（正式实现里是 userData/embed-models）
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const HOST = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
const cacheRoot = process.argv[2] || './.embed-probe-cache'
// transformers 的 cacheDir 约定：<cacheDir>/<org>/<model>/...
const modelDir = join(cacheRoot, MODEL_ID)

/** 只下这一个变体（q8 量化，95MB 左右）；其它变体等用到再说 */
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_quantized.onnx'
]

async function downloadFile(rel) {
  const target = join(modelDir, rel)
  if (existsSync(target)) return { rel, skipped: true, bytes: 0 }
  const url = `${HOST}/${MODEL_ID}/resolve/main/${rel}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${rel} 下载失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buf)
  return { rel, skipped: false, bytes: buf.length }
}

console.log(`模型：${MODEL_ID}`)
console.log(`下载源：${HOST}`)
console.log(`本地目录：${modelDir}`)

let t0 = Date.now()
let total = 0
for (const rel of FILES) {
  const r = await downloadFile(rel)
  total += r.bytes
  console.log(`  ${r.skipped ? '已有' : '下载'} ${rel}${r.bytes ? ` (${(r.bytes / 1024 / 1024).toFixed(1)}MB)` : ''}`)
}
if (total) console.log(`下载完成，共 ${(total / 1024 / 1024).toFixed(1)}MB，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// 让 transformers 只从本地加载（allowRemoteModels=false 会断掉一切网络请求）
const { env, pipeline } = await import('@huggingface/transformers')
env.cacheDir = cacheRoot
env.allowRemoteModels = false
env.allowLocalModels = true
// 不关闭也不使用：明确写在探针里，方便对照
console.log(`TLS 放宽：${process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? '已关闭证书校验' : '无（走正常校验）'}`)

t0 = Date.now()
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
console.log(`模型就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const samples = ['今天直播聊了聊怎么剪短视频', '他分享了自己的学习方法', '这只猫真可爱']
t0 = Date.now()
const out = await extractor(samples, { pooling: 'mean', normalize: true })
const tEmbed = Date.now() - t0
const dims = out.dims
console.log(`一次算 ${samples.length} 条，用时 ${tEmbed}ms，维度 ${JSON.stringify(dims)}`)

const dim = dims[dims.length - 1]
const vec = (i) => Array.from(out.data.slice(i * dim, (i + 1) * dim))
const cos = (a, b) => a.reduce((s, x, k) => s + x * b[k], 0)
const v0 = vec(0)
console.log(`相似度（与第 1 句比）：第 2 句 ${cos(v0, vec(1)).toFixed(4)}，第 3 句 ${cos(v0, vec(2)).toFixed(4)}`)
console.log(
  `单条平均 ${(tEmbed / samples.length).toFixed(1)}ms；按此估算 10 万条约 ${(((tEmbed / samples.length) * 100000) / 1000 / 60).toFixed(1)} 分钟`
)
