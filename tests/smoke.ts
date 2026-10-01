/**
 * 端到端冒烟测试：在真实 Electron 主进程中跑完整链路。
 *   导入 SRT → 资源树 → 读取字幕 → 生成时间坐标 → 切片任务 → 导出 CSV/XLSX
 * 运行：npm run test:smoke
 */
import { app } from 'electron'
import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from '../src/main/db'
import { exportSlice, hasSubtitles, importLocalSrt, loadMergedDoc } from '../src/main/services'
import type { Cue, TreeNode } from '../src/shared/types'
import { buildRanges } from '../src/shared/ranges'

let passed = 0
let failed = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

function walk(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children) walk(n.children, out)
  }
  return out
}

const cue = (index: number, start: number, end: number, text = `第${index}句`): Cue => ({
  index,
  start,
  end,
  text
})

const workDir = mkdtempSync(join(tmpdir(), 'srt-tool-smoke-'))
app.setPath('userData', workDir)

const SRT_A = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '第一句话，包含关键词：高光',
  '',
  '2',
  '00:00:03,600 --> 00:00:06,000',
  '第二句话',
  '',
  '3',
  '00:00:10,000 --> 00:00:12,000',
  '第三句话，也有高光',
  '',
  '4',
  '00:01:20,000 --> 00:02:15,000',
  '第四句话',
  ''
].join('\r\n')

async function run(): Promise<void> {
  console.log('\n【端到端冒烟测试】')

  db.initDb(workDir)

  /* ---------------------------- 1. 导入本地 SRT ---------------------------- */
  const srtPath = join(workDir, 'P2 测试字幕.srt')
  writeFileSync(srtPath, SRT_A, 'utf8')

  // GBK 文件
  const gbkPath = join(workDir, 'gbk字幕.srt')
  const gbkCues = '1\n00:00:01,000 --> 00:00:02,000\n中文测试\n'
  const gbkBuf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 「你好」
  writeFileSync(
    gbkPath,
    Buffer.concat([
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n', 'utf8'),
      gbkBuf,
      Buffer.from('\n', 'utf8')
    ])
  )
  void gbkCues

  const result = await importLocalSrt([srtPath, gbkPath])
  check('导入两个 SRT 文件成功', () => {
    assert.strictEqual(result.failures.length, 0, `失败项：${result.failures.join('; ')}`)
    assert.strictEqual(result.imported, 2)
  })

  /* ------------------------------ 2. 资源树 ------------------------------ */
  const tree = db.buildTree()
  check('资源树结构为 UP主 → 合集 → 视频 → 字幕', () => {
    assert.strictEqual(tree.length, 1)
    assert.strictEqual(tree[0].type, 'uploader')
    assert.strictEqual(tree[0].label, db.LOCAL_UPLOADER_NAME)
    assert.strictEqual(tree[0].children?.[0].type, 'collection')
    assert.strictEqual(tree[0].children?.[0].label, '本地文件')
    assert.ok((tree[0].children?.[0].children?.length ?? 0) >= 2)
  })

  const allNodes = walk(tree)
  const docNodes = allNodes.filter((n) => n.type === 'doc')
  check('字幕节点数量正确', () => {
    assert.strictEqual(docNodes.length, 2)
  })

  /* --------------------------- 3. 读取字幕内容 --------------------------- */
  const targetDoc = docNodes.find((n) => n.label.includes('测试字幕'))
  assert.ok(targetDoc, '找不到目标字幕文档')
  const docId = (targetDoc!.payload as { id: number }).id
  const cues = db.loadCues(docId)

  check('字幕条数与内容正确', () => {
    assert.strictEqual(cues.length, 4)
    assert.strictEqual(cues[0].start, 1)
    assert.strictEqual(cues[3].end, 135)
    assert.ok(cues[0].text.includes('高光'))
  })

  check('GBK 字幕正确解码', () => {
    const gbkDoc = docNodes.find((n) => n.label.includes('gbk') || n.label.includes('GBK'))
    assert.ok(gbkDoc, '找不到 GBK 字幕文档')
    const gbkCuesLoaded = db.loadCues((gbkDoc!.payload as { id: number }).id)
    assert.strictEqual(gbkCuesLoaded.length, 1)
    assert.strictEqual(gbkCuesLoaded[0].text, '你好')
  })

  /* ------------------------- 4. 搜索（关键词匹配） ------------------------- */
  check('关键词搜索命中 2 条', () => {
    const hits = cues.filter((c) => c.text.includes('高光'))
    assert.strictEqual(hits.length, 2)
    assert.deepStrictEqual(hits.map((c) => c.index), [1, 3])
  })

  /* --------------------------- 5. 时间坐标生成 --------------------------- */
  const ranges = buildRanges(cues, new Set([1, 2]), 0)
  check('连续选择合并为一段（1.000 → 6.000）', () => {
    assert.strictEqual(ranges.length, 1)
    assert.strictEqual(ranges[0].start, 1)
    assert.strictEqual(ranges[0].end, 6)
  })

  const splitRanges = buildRanges(cues, new Set([1, 4]), 0)
  check('非连续选择生成两段（需求文档示例形态）', () => {
    assert.strictEqual(splitRanges.length, 2)
    assert.strictEqual(splitRanges[0].start, 1)
    assert.strictEqual(splitRanges[0].end, 3.5)
    assert.strictEqual(splitRanges[1].start, 80)
    assert.strictEqual(splitRanges[1].end, 135)
  })

  /* ---------------------------- 6. 切片任务 ---------------------------- */
  const video = db.getVideo((targetDoc!.payload as { videoId: number }).videoId)
  db.addClipTasks(
    splitRanges.map((r, i) => ({
      docId,
      bvid: video?.bvid ?? '',
      page: 2,
      start: r.start,
      end: r.end,
      note: `高光片段_${i + 1}`
    }))
  )
  const clips = db.listClipTasks()
  check('切片任务写入成功', () => {
    assert.strictEqual(clips.length, 2)
    assert.strictEqual(clips[0].page, 2)
  })

  /* ---------------------------- 7. 导出切片表 ---------------------------- */
  const csvPath = join(workDir, '切片表.csv')
  const xlsxPath = join(workDir, '切片表.xlsx')
  const csvRes = await exportSlice(
    clips.map((c) => ({ bvid: c.bvid, page: c.page, start: c.start, end: c.end, note: c.note })),
    'csv',
    csvPath
  )
  const xlsxRes = await exportSlice(
    clips.map((c) => ({ bvid: c.bvid, page: c.page, start: c.start, end: c.end, note: c.note })),
    'xlsx',
    xlsxPath
  )

  check('CSV 导出成功且格式与切片工具一致', () => {
    assert.ok(csvRes.ok, csvRes.message)
    assert.ok(existsSync(csvPath))
    const text = readFileSync(csvPath, 'utf8')
    assert.ok(text.startsWith('﻿'), '缺少 UTF-8 BOM')
    const lines = text.replace(/^﻿/, '').trim().split('\r\n')
    assert.strictEqual(lines[0], 'BV号,分P,开始时间,结束时间,备注(文件名)')
    assert.strictEqual(lines.length, 3)
    assert.strictEqual(lines[1], ',2,00:00:01,00:00:03,高光片段_1')
    assert.strictEqual(lines[2], ',2,00:01:20,00:02:15,高光片段_2')
  })

  check('XLSX 导出成功', () => {
    assert.ok(xlsxRes.ok, xlsxRes.message)
    assert.ok(existsSync(xlsxPath))
    assert.ok(readFileSync(xlsxPath).length > 1000)
  })

  /* ---------------------------- 7.5 字幕正文编辑 ---------------------------- */
  check('字幕正文可编辑并持久化', () => {
    const edited = cues.map((c) =>
      c.index === 1 ? { ...c, text: '【已编辑】修改后的第一句' } : c
    )
    db.updateDocCues(docId, edited)

    const back = db.loadCues(docId)
    assert.strictEqual(back.length, 4)
    assert.strictEqual(back[0].text, '【已编辑】修改后的第一句')
    // 编辑正文不应影响时间坐标
    assert.strictEqual(back[0].start, 1)
    assert.strictEqual(back[3].end, 135)
  })

  /* --------------------------- 7.6 视频唯一性 --------------------------- */
  check('同一 BV 号只对应一个视频条目', () => {
    const first = db.upsertVideo(null, 'BV1DUP000001', '重复测试', {})
    const second = db.upsertVideo(null, 'BV1DUP000001', '重复测试（改标题）', {})
    assert.strictEqual(first, second, '相同 bvid 应复用同一条目')
    assert.strictEqual(db.findVideoByBvid('BV1DUP000001')?.id, first)
  })

  check('已有字幕的视频会被识别为「已存在」', () => {
    const videoId = db.upsertVideo(null, 'BV1DUP000002', '带字幕的视频', {})
    assert.strictEqual(hasSubtitles('BV1DUP000002'), false, '还没加字幕时应为 false')
    db.addDoc(videoId, 1, 'zh-CN', '简体中文', 'a.srt', 'bilibili', [cue(1, 0, 1, '内容')])
    assert.strictEqual(hasSubtitles('BV1DUP000002'), true)
    assert.strictEqual(hasSubtitles('BV1NOTEXIST01'), false)
  })

  /* --------------------------- 8. 收藏 / 删除 --------------------------- */
  check('收藏切换生效', () => {
    const videoNode = allNodes.find((n) => n.type === 'video')
    assert.ok(videoNode)
    assert.strictEqual(db.toggleFavorite(videoNode!.key), true)
    const after = walk(db.buildTree()).find((n) => n.key === videoNode!.key)
    assert.strictEqual(after?.favorite, true)
  })

  check('删除字幕同时清理其切片任务', () => {
    db.deleteDoc(docId)
    assert.strictEqual(db.loadCues(docId).length, 0)
    assert.strictEqual(db.listClipTasks().length, 0)
  })

  check('统计接口正确', () => {
    const s = db.stats()
    assert.strictEqual(s.uploaders, 1)
    // 前面章节又建了几个测试用视频/字幕，这里只校验量级与一致性
    assert.ok(s.docs >= 1, `docs 应至少为 1，实际 ${s.docs}`)
    assert.ok(s.videos >= 3, `videos 应至少为 3，实际 ${s.videos}`)
    assert.strictEqual(s.clips, 0)
  })

  /* -------------------------- 8.5 重复导入同一文件 -------------------------- */
  await checkAsync('重复导入同一个文件时原地更新，不再堆出重复字幕', async () => {
    const before = db.stats().docs
    // 用 GBK 那份：前面的章节已经把另一个文档删掉了
    const again = await importLocalSrt([gbkPath])
    assert.strictEqual(again.imported, 0, '不应新增文档')
    assert.strictEqual(again.updated, 1, '应更新已有文档')
    assert.strictEqual(db.stats().docs, before, '文档总数不应变化')
  })

  /* ------------------- 8.6 多语言分P 的合并阅读取一条 ------------------- */
  check('同一分P 有多种语言时，合并阅读按当前语言取一条，不重复显示', () => {
    const videoId = db.upsertVideo(null, 'BV1LANGTEST1', '多语言测试', {})
    const zh = db.upsertDoc(videoId, 1, 'zh-CN', '简体中文', 'zh.srt', 'bilibili', [
      cue(1, 1, 2, 'P1 人工第一句'),
      cue(2, 3, 4, 'P1 人工第二句')
    ])
    db.upsertDoc(videoId, 1, 'ai-zh', '简体中文（AI）', 'ai.srt', 'bilibili', [
      cue(1, 1, 2, 'P1 AI 第一句'),
      cue(2, 3, 4, 'P1 AI 第二句'),
      cue(3, 5, 6, 'P1 AI 第三句')
    ])
    db.upsertDoc(videoId, 2, 'ai-zh', '简体中文（AI）', 'ai2.srt', 'bilibili', [
      cue(1, 10, 11, 'P2 AI 第一句')
    ])

    // 从人工字幕进去读：P1 用人工，P2 只有 AI 就退回 AI
    const mergedZh = loadMergedDoc(zh.docId)
    assert.ok(mergedZh, '合并加载失败')
    assert.strictEqual(mergedZh!.docs.length, 2, '两个分P 各取一条，不应把同分P 的另一种语言也算进来')
    assert.deepStrictEqual(
      mergedZh!.docs.map((d) => `${d.page}:${d.lang}`),
      ['1:zh-CN', '2:ai-zh']
    )
    assert.strictEqual(mergedZh!.cues.length, 3, 'P1 两条人工 + P2 一条 AI')
    assert.strictEqual(mergedZh!.cues[0].text, 'P1 人工第一句')
    assert.deepStrictEqual(
      [...new Set(mergedZh!.cues.map((c) => c.page))],
      [1, 2],
      '每个分P 只应出现一次'
    )

    // 从 AI 字幕进去读：两个分P 都用 AI
    const mergedAi = loadMergedDoc(mergedZh!.docs[1].id)
    assert.ok(mergedAi)
    assert.strictEqual(mergedAi!.cues.length, 4, 'P1 三条 AI + P2 一条 AI')
    assert.strictEqual(mergedAi!.cues[0].text, 'P1 AI 第一句')
  })

  /* ------------------------ 9. 持久化（重新加载） ------------------------ */
  db.closeDb()
  check('数据已落盘且可重新加载', () => {
    const dataFile = join(workDir, 'srt-tool-data', 'srt-tool.json')
    assert.ok(existsSync(dataFile), '数据文件不存在')
    const raw = JSON.parse(readFileSync(dataFile, 'utf8'))
    assert.strictEqual(raw.uploaders.length, 1)
    assert.ok(raw.docs.length >= 1)
    assert.ok(raw.videos.length >= 3)
  })

  /* ------------------- 10. 老数据迁移（UP主 mid → uid） ------------------- */
  check('老数据里的 UP主 mid 会迁移成 uid', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'srt-tool-legacy-'))
    const dataDir = join(legacyDir, 'srt-tool-data')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(join(dataDir, 'docs'), { recursive: true })
    writeFileSync(
      join(dataDir, 'srt-tool.json'),
      JSON.stringify({
        seq: { uploaders: 1, collections: 1, videos: 1, docs: 1, clips: 0 },
        uploaders: [{ id: 1, mid: 88888, name: '老版本UP主', avatar: null, favorite: 0, createdAt: 1 }],
        collections: [
          { id: 1, uploaderId: 1, sid: null, title: '单视频', url: null, favorite: 0, createdAt: 1 }
        ],
        videos: [
          {
            id: 1,
            collectionId: 1,
            bvid: 'BV1LEGACY001',
            title: '老视频',
            url: '',
            cover: null,
            duration: null,
            pageCount: null,
            favorite: 0,
            createdAt: 1
          }
        ],
        docs: [
          {
            id: 1,
            videoId: 1,
            page: 1,
            lang: 'zh-CN',
            label: '简体中文',
            filename: 'a.srt',
            source: 'bilibili',
            favorite: 0,
            createdAt: 1
          }
        ],
        clips: []
      }),
      'utf8'
    )

    db.initDb(legacyDir)
    const tree = db.buildTree()
    assert.strictEqual(tree.length, 1)
    assert.strictEqual(tree[0].subtitle, 'UID 88888', 'mid 应迁移成 uid 并显示出来')
    db.closeDb()
    rmSync(legacyDir, { recursive: true, force: true })
  })

  console.log(`\n通过 ${passed}，失败 ${failed}\n`)

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  app.exit(failed > 0 ? 1 : 0)
}

app.whenReady().then(run).catch((err) => {
  console.error('冒烟测试异常：', err)
  app.exit(1)
})
