// 为 dist/ 下的安装包与免安装包生成 SHA-256 校验文件。
// 用法：npm run dist:checksums
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const distDir = join(process.cwd(), 'dist')
const outputFile = join(distDir, 'SHA256SUMS.txt')
const wanted = /\.(exe|zip)$/i
const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))

async function sha256(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

let names
try {
  names = (await readdir(distDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && wanted.test(entry.name) && entry.name.includes(`-${packageJson.version}-`))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
} catch (error) {
  console.error(`无法读取 ${distDir}，请先运行 npm run dist。`)
  process.exit(1)
}

if (names.length === 0) {
  console.error(`dist/ 下没有 ${packageJson.version} 的 .exe 或 .zip 产物，请先运行 npm run dist。`)
  process.exit(1)
}

const lines = []
for (const name of names) {
  const digest = await sha256(join(distDir, name))
  lines.push(`${digest}  ${name}`)
  console.log(`${digest}  ${name}`)
}

await writeFile(outputFile, `${lines.join('\n')}\n`, 'utf8')
console.log(`\n已写入 ${outputFile}`)
