/**
 * 下载并校验随安装包分发的 ffmpeg（Windows x64）。
 *
 * 为什么要在构建时下载，而不是把 80MB 的 exe 提交进仓库：
 * - Git 仓库不该存二进制；安装包需要的是「构建时一定拿得到」。
 * - 来源固定（ffmpeg-static 的 Windows 构建，gyan.dev 静态 GPLv3），
 *   下载后按 SHA-256 校验，避免镜像被替换或文件损坏。
 *
 * 安装包里的位置：`resources/ffmpeg/ffmpeg.exe`（见 electron-builder.yml 的 extraResources），
 * 主进程 `resolveFfmpeg()` 会优先使用它，用户不需要再手动配置。
 *
 * 环境变量：
 * - `FFMPEG_DOWNLOAD_URL`：镜像不可用时可换成其它直链（必须是同一个二进制，否则校验失败）；
 * - `FFMPEG_SKIP=1`：跳过下载（本地已放好 vendor/ffmpeg/ffmpeg.exe 时用）。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { get } from 'node:https'
import { join } from 'node:path'

const VERSION = 'b6.1.1'
const BASE = process.env.FFMPEG_DOWNLOAD_BASE || `https://registry.npmmirror.com/-/binary/ffmpeg-static/${VERSION}`
const FILES = [
  { name: 'ffmpeg.exe', remote: 'ffmpeg-win32-x64', sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00' },
  { name: 'ffmpeg.LICENSE', remote: 'win32-x64.LICENSE' },
  { name: 'ffmpeg.README', remote: 'win32-x64.README' }
]
const DEST = join(process.cwd(), 'vendor', 'ffmpeg')

function sha256(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

/** 带重定向与进度输出的下载（镜像站会 302 到 CDN） */
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'))
    const req = get(url, { headers: { 'User-Agent': 'SubClip-build' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode}：${url}`))
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      let lastPrint = 0
      const out = createWriteStream(dest)
      res.on('data', (chunk) => {
        received += chunk.length
        const now = Date.now()
        if (now - lastPrint > 1000) {
          lastPrint = now
          const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : ''
          process.stdout.write(`\r  下载 ${(received / 1024 / 1024).toFixed(1)} MB${pct}`)
        }
      })
      res.pipe(out)
      out.on('finish', () => {
        out.close(resolve)
        process.stdout.write('\n')
      })
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(300_000, () => req.destroy(new Error('下载超时')))
  })
}

async function main() {
  if (process.env.FFMPEG_SKIP === '1') {
    console.log('FFMPEG_SKIP=1，跳过 ffmpeg 下载')
    return
  }
  mkdirSync(DEST, { recursive: true })
  for (const file of FILES) {
    const target = join(DEST, file.name)
    if (existsSync(target) && statSync(target).size > 0) {
      if (!file.sha256 || sha256(target) === file.sha256) {
        console.log(`  已存在：${file.name}`)
        continue
      }
      console.log(`  ${file.name} 校验不一致，重新下载`)
    }
    const temp = `${target}.${process.pid}.tmp`
    const url = `${BASE}/${file.remote}`
    console.log(`  下载 ${file.name} ← ${url}`)
    try {
      await download(url, temp)
      if (file.sha256) {
        const actual = sha256(temp)
        if (actual !== file.sha256) {
          throw new Error(`${file.name} 的 SHA-256 不匹配：期望 ${file.sha256}，实际 ${actual}`)
        }
      }
      renameSync(temp, target)
    } catch (err) {
      try { rmSync(temp, { force: true }) } catch { /* ignore */ }
      console.error(`\n下载 ${file.name} 失败：${err.message}`)
      console.error('可设置 FFMPEG_DOWNLOAD_URL / FFMPEG_DOWNLOAD_BASE 指向可达镜像，或手动把文件放进 vendor/ffmpeg/。')
      process.exit(1)
    }
  }
  const exe = join(DEST, 'ffmpeg.exe')
  console.log(`ffmpeg 就绪：${exe}（${(statSync(exe).size / 1024 / 1024).toFixed(0)} MB，SHA-256 已校验）`)
}

await main()
