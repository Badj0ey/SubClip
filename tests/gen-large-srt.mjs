/**
 * 生成超大字幕文件，用于验证虚拟滚动与性能。
 * 用法：node tests/gen-large-srt.mjs [条数] [输出路径]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const count = Number(process.argv[2] || 5000)
const out = process.argv[3] || join(process.cwd(), 'tests', `large-${count}.srt`)

function fmt(sec) {
  const s = Math.max(0, sec)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(Math.floor(s % 60)).padStart(2, '0')
  const ms = String(Math.round((s - Math.floor(s)) * 1000)).padStart(3, '0')
  return `${hh}:${mm}:${ss},${ms}`
}

const blocks = []
for (let i = 1; i <= count; i++) {
  const start = (i - 1) * 2
  const end = start + 1.8
  const marker = i % 137 === 0 ? '【高光片段】' : ''
  const tail = i % 3 === 0 ? '这一行特意写得比较长，用来测试不同行高下的虚拟滚动表现是否稳定。' : '短句。'
  blocks.push(
    `${i}\n${fmt(start)} --> ${fmt(end)}\n第 ${i} 条字幕内容。${marker}${tail}`
  )
}

writeFileSync(out, blocks.join('\n\n') + '\n', 'utf8')
console.log(`已生成 ${count} 条字幕 → ${out}`)
