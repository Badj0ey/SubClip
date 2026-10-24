/** Refactor regression suite; can run without Electron's GUI. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterCommands } from '../src/shared/commands'
import { safeExternalUrl } from '../src/shared/externalUrl'
import { constrainPanes, constrainPreview, resizeSidePane } from '../src/shared/layout'
import * as db from '../src/main/db'

let passed = 0
function check(label: string, fn: () => void): void {
  fn()
  passed++
  console.log(`  ✓ ${label}`)
}

check('外链：只放行合法 http(s) URL', () => {
  assert.equal(safeExternalUrl(' https://example.com/docs '), 'https://example.com/docs')
  assert.equal(safeExternalUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765/')
  for (const bad of [
    'javascript:alert(1)', 'file:///etc/passwd', 'https://', 'https://user:pass@example.com',
    'https://example.com\r\nX: injected', 'https://example.com\u0000', '', 17, null, 'https://' + 'a'.repeat(4100)
  ]) assert.equal(safeExternalUrl(bad), null, String(bad).slice(0, 30))
})
check('布局：超出宽度时仍保留阅读区与面板最小宽度', () => {
  assert.deepEqual(constrainPanes(1480, 288, 350), { tree: 288, task: 350 })
  assert.deepEqual(constrainPanes(1120, 520, 620), { tree: 428, task: 280 })
  assert.deepEqual(constrainPanes(900, 520, 620), { tree: 208, task: 280 })
  assert.deepEqual(constrainPanes(Number.NaN, Number.NaN, Number.NaN), { tree: 288, task: 350 })
  assert.equal(constrainPreview(800, 999), 550)
  assert.equal(constrainPreview(200, -30), 120)
})
check('布局：拖动左栏不改变右栏，拖动右栏不改变左栏', () => {
  assert.deepEqual(resizeSidePane(1120, 288, 350, 'left', 1000), { tree: 358, task: 350 })
  assert.deepEqual(resizeSidePane(1120, 288, 350, 'right', -1000), { tree: 288, task: 420 })
  assert.deepEqual(resizeSidePane(1480, 288, 350, 'left', -1000), { tree: 200, task: 350 })
})
check('命令搜索：支持多关键词、大小写、空查询与无结果', () => {
  assert.ok(filterCommands('').length >= 8)
  assert.deepEqual(filterCommands('b站 下载').map((c) => c.id), ['pull'])
  assert.deepEqual(filterCommands('FFMPEG').map((c) => c.id), ['clipjobs'])
  assert.deepEqual(filterCommands('不存在的指令'), [])
})

const dir = mkdtempSync(join(tmpdir(), 'subclip-refactor-'))
try {
  db.initDb(dir)
  const uploader = db.upsertUploader(123456, '测试作者')
  const collection = db.upsertCollection(uploader, 'test-series', '测试合集')
  const video = db.upsertVideo(collection, 'BV1AA411c7mD', '测试视频')
  const doc = db.upsertDoc(video, 1, 'zh', '中文字幕', 'test.srt', 'local', [
    { index: 1, start: 1, end: 3, text: '精彩片段' }
  ]).docId
  db.setVideoCreators(video, [{ name: '创作者甲' }, { name: '创作者乙' }])
  db.addClips([{ docId: doc, bvid: 'BV1AA411c7mD', page: 1, start: 1, end: 3, note: '高光' }])
  const clip = db.listClips()[0]
  const tag = db.createTag('精彩')
  db.setClipTags(clip.id, [tag])
  db.toggleFavorite(`collection:${collection}`)

  check('片段批量详情：去重、过滤无效 ID、作者与标签完整', () => {
    const details = db.listClipDetails([clip.id, clip.id, 0, -2, 999999])
    assert.equal(details.length, 1)
    assert.equal(details[0].videoTitle, '测试视频')
    assert.equal(details[0].docLabel, '中文字幕')
    assert.deepEqual(details[0].creators, ['创作者乙', '创作者甲'])
    assert.deepEqual(details[0].tagIds, [tag])
    assert.equal(db.getClip(clip.id)?.note, '高光')
    assert.equal(db.getClip(-1), null)
  })
  check('首页统计：全库计数不受最近列表 limit 影响', () => {
    const overview = db.dashboardOverview(0)
    assert.equal(overview.totalVideos, 1)
    assert.equal(overview.totalDocs, 1)
    assert.equal(overview.clipCount, 1)
    assert.equal(overview.recentVideos.length, 0)
    const full = db.dashboardOverview(12)
    assert.equal(full.recentVideos.length, 1)
    assert.ok(full.favorites.some((f) => f.type === 'collection' && f.label === '测试合集'))
  })
} finally {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n通过 ${passed} 项重构回归测试`)
