/**
 * 端到端冒烟测试：在真实 Electron 主进程中跑完整链路。
 *   导入 SRT → 资源树 → 读取字幕 → 生成时间坐标 → 切片任务 → 导出 CSV/XLSX
 * 运行：npm run test:smoke
 */
import { app } from 'electron'
import assert from 'node:assert'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as db from '../src/main/db'
import { exportSlice, hasSubtitles, importLocalSrt, loadMergedDoc } from '../src/main/services'
import { recommendHighlights, recommendTwins } from '../src/main/recommend'
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
  db.addClips(
    splitRanges.map((r, i) => ({
      docId,
      bvid: video?.bvid ?? '',
      page: 2,
      start: r.start,
      end: r.end,
      note: `高光片段_${i + 1}`
    }))
  )
  const clips = db.listClips()
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
    assert.strictEqual(db.listClips().length, 0)
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
  check('数据已落盘，重新打开数据库后仍可读', () => {
    const dbFile = join(workDir, 'subclip-data', 'srt-tool.db')
    assert.ok(existsSync(dbFile), '数据库文件不存在')
    db.initDb(workDir) // 重新打开
    const s = db.stats()
    assert.strictEqual(s.uploaders, 1)
    assert.ok(s.docs >= 1, `docs 应至少为 1，实际 ${s.docs}`)
    assert.ok(s.videos >= 3, `videos 应至少为 3，实际 ${s.videos}`)
  })

  /* -------------------- 10. 老数据迁移（JSON → SQLite） -------------------- */
  check('老数据（JSON + 每文档一个正文文件）能完整迁移进 SQLite', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'srt-tool-legacy-'))
    const dataDir = join(legacyDir, 'subclip-data')
    mkdirSync(join(dataDir, 'docs'), { recursive: true })
    // 老版本的正文是单独文件，迁移时要一并读进来
    writeFileSync(
      join(dataDir, 'docs', '1.json'),
      JSON.stringify([
        { index: 1, start: 1, end: 2, text: '老版本第一句' },
        { index: 2, start: 3, end: 4, text: '老版本第二句' }
      ]),
      'utf8'
    )
    writeFileSync(
      join(dataDir, 'srt-tool.json'),
      JSON.stringify({
        seq: { uploaders: 1, collections: 1, videos: 1, docs: 1, clips: 1 },
        // 老版本字段名是 mid，v2 起统一为 uid
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
        clips: [
          {
            id: 1,
            docId: 1,
            bvid: 'BV1LEGACY001',
            page: 1,
            start: 1,
            end: 4,
            note: '老切片',
            createdAt: 1
          }
        ]
      }),
      'utf8'
    )

    db.initDb(legacyDir)

    const tree = db.buildTree()
    assert.strictEqual(tree.length, 1)
    assert.strictEqual(tree[0].subtitle, 'UID 88888', 'mid 应迁移成 uid 并显示出来')
    assert.strictEqual(tree[0].children?.[0].children?.[0].label, '老视频')

    const cues = db.loadCues(1)
    assert.strictEqual(cues.length, 2, '正文文件应一起迁移')
    assert.strictEqual(cues[0].text, '老版本第一句')
    assert.strictEqual(db.listClips().length, 1, '切片任务应一起迁移')

    // 迁移后老文件改名留档，不删除
    const migrated = readdirSync(dataDir).filter((f) => f.startsWith('srt-tool.json.migrated-'))
    assert.strictEqual(migrated.length, 1, '老 JSON 应改名留档')
    // 迁移进来的正文也应当能被检索到
    assert.strictEqual(db.searchCues('老版本第一句').length, 1)

    db.closeDb()
    rmSync(legacyDir, { recursive: true, force: true })
  })

  /* --------------------- 11. 跨文档全文检索（FTS5） --------------------- */
  // 上一节迁移测试用的是另一个临时目录，这里切回本测试的主库
  db.initDb(workDir)

  check('跨文档检索能一次搜到不同视频里的字幕', () => {
    const upId = db.upsertUploader(700001, '检索测试UP主')
    const colId = db.upsertCollection(upId, null, '单视频')
    const v1 = db.upsertVideo(colId, 'BV1SEARCH001', '检索测试视频一', {})
    const v2 = db.upsertVideo(colId, 'BV1SEARCH002', '检索测试视频二', {})
    // 第四阶段起「关键词命中」也会看**视频标题与字幕文件名**，所以下面
    // 「某关键词必须彻底消失」这类断言要用**只出现在正文里的词**（见 613 行起的用例，
    // 那里的关键词都刻意与标题无关，否则标题命中会让断言永远失败）。
    db.upsertDoc(v1, 1, 'zh-CN', '简体中文', 's1.srt', 'bilibili', [
      cue(1, 0, 1, '这里出现了独角兽这个词'),
      cue(2, 2, 3, '无关内容')
    ])
    db.upsertDoc(v2, 1, 'zh-CN', '简体中文', 's2.srt', 'bilibili', [
      cue(1, 5, 6, '另一个视频里的独角兽')
    ])

    // 4 个字 → 走 FTS5 索引
    const ftsHits = db.searchCues('独角兽')
    assert.ok(
      ftsHits.length >= 2,
      `FTS 至少应命中两条（标题命中也算），实际 ${ftsHits.length}`
    )
    const hitVideoIds = new Set(ftsHits.map((h) => h.videoId))
    assert.ok(hitVideoIds.has(v1) && hitVideoIds.has(v2), '两个测试视频都该被命中')
    assert.strictEqual(ftsHits[0].uploaderName, '检索测试UP主')
    assert.ok(ftsHits[0].videoTitle.startsWith('检索测试视频'))

    // 2 个字 → trigram 要求至少 3 字符，自动回退 LIKE，语义仍然正确
    const shortHits = db.searchCues('独角')
    assert.ok(shortHits.length >= 2, `短查询应回退 LIKE 并命中，实际 ${shortHits.length}`)

    // 搜不到的词不该有结果
    assert.strictEqual(db.searchCues('不存在的词').length, 0)
    assert.strictEqual(db.searchCues('   ').length, 0)
  })

  /* ------------------ 11.5 检索升级：排序权重 / 筛选 / 分页（第四阶段） ------------------ */
  check('检索排序：标题命中优先于正文命中', () => {
    const upId = db.upsertUploader(700002, '排序检索UP主')
    const colId = db.upsertCollection(upId, null, '单视频')
    // 正文命中
    const bodyVideo = db.upsertVideo(colId, 'BV1RANK0001', '平平无奇的标题', {})
    db.upsertDoc(bodyVideo, 1, 'zh-CN', '简体中文', 'r1.srt', 'bilibili', [
      cue(1, 0, 1, '正文里提到了彩虹独角兽这种东西')
    ])
    // 标题命中（后建，如果按入库时间排会排在后面）
    const titleVideo = db.upsertVideo(colId, 'BV1RANK0002', '彩虹独角兽大合集', {})
    db.upsertDoc(titleVideo, 1, 'zh-CN', '简体中文', 'r2.srt', 'bilibili', [
      cue(1, 0, 1, '这里只是随口提了一句')
    ])

    const page = db.searchCuesPage('彩虹独角兽')
    assert.ok(page.total >= 2, `至少命中两条，实际 ${page.total}`)
    assert.strictEqual(page.hits[0].videoId, titleVideo, '标题命中的那条应排第一')
    assert.strictEqual(page.hits[0].hitWeight, 3, '标题命中权重应为 3')
    const bodyHit = page.hits.find((h) => h.videoId === bodyVideo)
    assert.strictEqual(bodyHit?.hitWeight, 1, '正文命中权重应为 1')
  })

  check('检索筛选：标签 / 收藏 / 时长 / 时间范围，且都在 SQL 层生效', () => {
    const upId = db.upsertUploader(700003, '筛选检索UP主')
    const colId = db.upsertCollection(upId, null, '单视频')

    const taggedVideo = db.upsertVideo(colId, 'BV1FILT0001', '带标签的视频', {})
    db.upsertDoc(taggedVideo, 1, 'zh-CN', '简体中文', 'f1.srt', 'bilibili', [
      cue(1, 0, 0.5, '短句里的银月关键词'),
      cue(2, 10, 40, '长段落里的银月关键词描述了一大段')
    ])
    const plainVideo = db.upsertVideo(colId, 'BV1FILT0002', '没标签的视频', {})
    db.upsertDoc(plainVideo, 1, 'zh-CN', '简体中文', 'f2.srt', 'bilibili', [
      cue(1, 0, 1, '另一条银月关键词')
    ])

    const tagId = db.createTag('筛选用例标签')
    db.setVideoTags(taggedVideo, [tagId])

    // 标签筛选：只剩带标签那个视频的两条
    const byTag = db.searchCuesPage('银月关键词', { tagIds: [tagId] })
    assert.strictEqual(byTag.total, 2, `标签筛选应命中 2 条，实际 ${byTag.total}`)
    assert.ok(byTag.hits.every((h) => h.videoId === taggedVideo))

    // 时长筛选：只要 1 秒以内 → 只剩那条 0.5 秒的
    const byDuration = db.searchCuesPage('银月关键词', { tagIds: [tagId], maxDuration: 1 })
    assert.strictEqual(byDuration.total, 1, `时长筛选应只剩 1 条，实际 ${byDuration.total}`)
    assert.ok(byDuration.hits[0].end - byDuration.hits[0].start <= 1)

    // 收藏筛选：没人收藏时一条都没有
    const byFav = db.searchCuesPage('银月关键词', { favoriteOnly: true })
    assert.strictEqual(byFav.total, 0, '没有收藏视频时收藏筛选应为空')

    // 时间筛选：未来时间不该命中
    const future = db.searchCuesPage('银月关键词', { createdFrom: Date.now() + 86_400_000 })
    assert.strictEqual(future.total, 0, '未来时间范围不该命中')

    db.deleteTag(tagId)
  })

  check('检索分页：total 是命中总数，翻页不重不漏', () => {
    const upId = db.upsertUploader(700004, '分页检索UP主')
    const colId = db.upsertCollection(upId, null, '单视频')
    const video = db.upsertVideo(colId, 'BV1PAGE0001', '分页测试视频', {})
    const cues = Array.from({ length: 7 }, (_, i) => cue(i + 1, i, i + 0.5, `第 ${i + 1} 句分页样本内容`))
    db.upsertDoc(video, 1, 'zh-CN', '简体中文', 'p1.srt', 'bilibili', cues)

    const first = db.searchCuesPage('分页样本内容', { limit: 3, offset: 0 })
    assert.strictEqual(first.total, 7, `总数应为 7，实际 ${first.total}`)
    assert.strictEqual(first.returned, 3, '本页应返回 3 条')
    assert.strictEqual(first.hasMore, true, '还有下一页')

    const second = db.searchCuesPage('分页样本内容', { limit: 3, offset: 3 })
    const third = db.searchCuesPage('分页样本内容', { limit: 3, offset: 6 })
    assert.strictEqual(second.returned, 3)
    assert.strictEqual(third.returned, 1)
    assert.strictEqual(third.hasMore, false, '最后一页不该说还有更多')

    // 三页合起来不重不漏
    const key = (h: { docId: number; index: number }): string => `${h.docId}:${h.index}`
    const all = [...first.hits, ...second.hits, ...third.hits].map(key)
    assert.strictEqual(new Set(all).size, 7, '三页合起来应正好 7 条且不重复')
  })

  check('删除视频时它的切片任务不会被留下（孤儿任务会让列表打不开）', () => {
    const upId = db.upsertUploader(880001, '级联测试UP主')
    const colId = db.upsertCollection(upId, null, '单视频')
    const vid = db.upsertVideo(colId, 'BV1CASCADE01', '级联测试视频', {})
    const res = db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'c.srt', 'bilibili', [
      cue(1, 0, 1, '级联测试字幕')
    ])
    db.addClips([
      { docId: res.docId, bvid: 'BV1CASCADE01', page: 1, start: 0, end: 1, note: '级联测试切片' }
    ])
    assert.ok(
      db.listClips().some((c) => c.docId === res.docId),
      '切片任务应已写入'
    )

    db.deleteVideo(vid)
    assert.ok(
      !db.listClips().some((c) => c.docId === res.docId),
      '删视频后不应残留指向它的切片任务'
    )
  })

  /* ------------------- 12. 删除后整棵恢复（撤销删除） ------------------- */
  check('删除后可整棵恢复（含正文、切片任务与全文索引）', () => {
    const upId = db.upsertUploader(880002, '可恢复UP主')
    const colId = db.upsertCollection(upId, null, '单视频')
    const vid = db.upsertVideo(colId, 'BV1RESTORE01', '可恢复视频', {})
    const res = db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'r.srt', 'bilibili', [
      cue(1, 0, 1, '恢复测试第一句'),
      cue(2, 2, 3, '恢复测试第二句')
    ])
    db.addClips([
      { docId: res.docId, bvid: 'BV1RESTORE01', page: 1, start: 0, end: 1, note: '恢复测试切片' }
    ])

    const before = db.stats()
    const snapshot = db.exportNode(`uploader:${upId}`)
    assert.ok(snapshot, '应能导出快照')
    assert.strictEqual(snapshot!.docs.length, 1)
    assert.strictEqual(snapshot!.cues.length, 2, '正文应进快照')
    assert.strictEqual(snapshot!.clips.length, 1, '切片任务应进快照')

    db.deleteUploader(upId)
    assert.strictEqual(db.getDoc(res.docId), null, '删除后文档应消失')
    assert.strictEqual(db.loadCues(res.docId).length, 0, '删除后正文应清空')
    assert.strictEqual(db.searchCues('恢复测试第一句').length, 0, '删除后不应还能搜到')

    db.importNode(snapshot!)
    assert.ok(db.getDoc(res.docId), '恢复后文档应回来')
    assert.strictEqual(db.loadCues(res.docId).length, 2, '正文应一起恢复')
    assert.strictEqual(
      db.listClips().some((c) => c.docId === res.docId),
      true,
      '切片任务应一起恢复'
    )
    assert.strictEqual(db.searchCues('恢复测试第一句').length, 1, '全文索引应重建')
    assert.strictEqual(db.stats().videos, before.videos, '视频数应回到删除前')
    assert.strictEqual(db.stats().docs, before.docs, '文档数应回到删除前')

    // 清场，避免影响后续断言
    db.deleteUploader(upId)
  })

  check('改写正文后全文索引同步更新（不会搜到已删掉的句子）', () => {
    const video = db.findVideoByBvid('BV1SEARCH001')
    assert.ok(video)
    const docId = db.listDocsByVideo(video!.id)[0].id
    // 关键：这次用的关键词只出现在正文里，与视频标题（`检索测试视频一`）无关。
    // 第四阶段起标题命中也会算命中，用「独角兽」这种也挂在标题上的词来断言
    // 「消失」是测不出来的。
    db.updateDocCues(docId, [cue(1, 0, 1, '换成了完全不同的内容')])
    // 断言「这个文档不再被这个词命中的」而不是「总数为 0」——
    // 库里还有其它视频的正文/标题含这个词，总数本来就不该是 0
    assert.ok(
      !db.searchCues('独角兽').some((h) => h.docId === docId),
      '该文档的旧句子应从索引里消失'
    )
    assert.strictEqual(db.searchCues('完全不同').length, 1, '新句子应能被搜到')
  })

  check('删除视频后其字幕也不再出现在检索结果里', () => {
    const video = db.findVideoByBvid('BV1SEARCH002')
    assert.ok(video)
    db.deleteVideo(video!.id)
    assert.strictEqual(db.searchCues('另一个视频里的').length, 0, '被删视频的字幕不该还能搜到')
  })

  /* ------------------------------ 13. 标签（分类） ----------------------------- */
  check('标签：新建去重 / 打标 / 按标签成组 / 删标签不影响视频', () => {
    const video = db.findVideoByBvid('BV1SEARCH001')
    assert.ok(video, '前置视频应存在')

    const tagA = db.createTag('待剪辑')
    const tagB = db.createTag('重点')
    assert.strictEqual(db.createTag('待剪辑'), tagA, '同名标签应复用而不是新建')
    assert.strictEqual(db.listTags().filter((t) => t.name === '待剪辑').length, 1)

    db.setVideoTags(video!.id, [tagA, tagB])
    assert.deepStrictEqual(
      db.getVideoTagIds(video!.id).sort((a, b) => a - b),
      [tagA, tagB].sort((a, b) => a - b),
      '两个标签都应打上'
    )
    // 重复设置同一集合不应产生重复关联
    db.setVideoTags(video!.id, [tagA, tagB, tagA])
    assert.strictEqual(db.getVideoTagIds(video!.id).length, 2, '重复的 tagId 应被去重')

    const tree = db.buildTree()
    const tagRoot = tree.find((n) => n.type === 'tags')
    assert.ok(tagRoot, '资源树顶部应有「标签」分组')
    const nodeA = tagRoot!.children!.find((n) => n.label === '待剪辑')
    assert.ok(nodeA, '应有「待剪辑」标签节点')
    assert.strictEqual(nodeA!.children!.length, 1, '该标签下应有 1 个视频')
    assert.strictEqual(nodeA!.children![0].videoId, video!.id, '标签下的视频节点应带 videoId')

    // 视频节点自身也应带上标签名（树里直接显示成小圆片）
    // 注意：这时库里已经有好几个 UP主，不能只看第一个，要整棵树找
    const findVideoNode = (nodes: typeof tree): (typeof tree)[number] | undefined => {
      for (const n of nodes) {
        if (n.videoId === video!.id) return n
        const hit = n.children ? findVideoNode(n.children) : undefined
        if (hit) return hit
      }
      return undefined
    }
    const videoNode = findVideoNode(tree)
    assert.ok(videoNode, '树里应能找到该视频节点')
    assert.deepStrictEqual(
      (videoNode!.tags ?? []).slice().sort(),
      ['待剪辑', '重点'],
      '视频节点应带上它的标签名'
    )

    // 改成只剩一个标签
    db.setVideoTags(video!.id, [tagB])
    assert.deepStrictEqual(db.getVideoTagIds(video!.id), [tagB], '覆盖式设置应移除未勾选的标签')

    // 删标签：只删标签，视频必须还在
    db.deleteTag(tagA)
    assert.ok(!db.listTags().some((t) => t.id === tagA), '标签应被删除')
    assert.ok(db.findVideoByBvid('BV1SEARCH001'), '删标签不能把视频一起删掉')
    assert.deepStrictEqual(db.getVideoTagIds(video!.id), [tagB], '其它标签不受影响')

    db.renameTag(tagB, '重要')
    assert.ok(db.listTags().some((t) => t.name === '重要'), '标签应能改名')

    // 空标签不应在树里占位
    db.deleteTag(tagB)
    assert.strictEqual(db.buildTree().find((n) => n.type === 'tags'), undefined, '没有标签时不应有「标签」分组')
  })

  /* ------------------ 14.5 素材库升级（第三阶段） ------------------ */
  check('标签升级：颜色 / 备注 / 两个方向的计数', () => {
    const video = db.findVideoByBvid('BV1SEARCH001')
    assert.ok(video, '前置视频应存在')

    const tag = db.createTag('高光候选')
    // 合法颜色会被规范化成小写；非法值一律清空（避免把任意字符串写进 CSS）
    db.updateTagMeta(tag, { color: '#3B82F6' })
    db.updateTagMeta(tag, { note: '准备剪成短视频的段落' })
    let row = db.listTags().find((t) => t.id === tag)
    assert.strictEqual(row?.color, '#3b82f6', '颜色应被规范化')
    assert.strictEqual(row?.note, '准备剪成短视频的段落', '备注应写入')

    db.updateTagMeta(tag, { color: 'red; background: url(evil)' })
    row = db.listTags().find((t) => t.id === tag)
    assert.strictEqual(row?.color, '', '非法颜色应被清空')

    // 批量给多个视频追加标签（第三阶段新能力）
    const up = db.upsertUploader(880010, '批量打标UP主')
    const col = db.upsertCollection(up, null, '单视频')
    const v2 = db.upsertVideo(col, 'BV1TAGS0002', '第二个视频', {})
    db.addVideoTags([video!.id, v2], [tag])

    const after = db.listTags().find((t) => t.id === tag)
    assert.strictEqual(after?.videoCount, 2, '两个视频都该打上标签')

    db.deleteTag(tag)
    assert.ok(!db.listTags().some((t) => t.id === tag))
  })

  check('片段：名称 / 来源 / 收藏 / 标签，且切片排序不受影响', () => {
    const up = db.upsertUploader(880011, '片段UP主')
    const col = db.upsertCollection(up, null, '单视频')
    const vid = db.upsertVideo(col, 'BV1CLIP0001', '片段测试视频', {})
    const doc = db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'c.srt', 'bilibili', [
      cue(1, 0, 2, '片段一'),
      cue(2, 3, 5, '片段二')
    ])

    db.addClips([
      {
        docId: doc.docId,
        bvid: 'BV1CLIP0001',
        page: 1,
        start: 0,
        end: 2,
        note: '输出文件_1',
        name: '开场钩子',
        source: 'manual',
        favorite: true
      },
      {
        docId: doc.docId,
        bvid: 'BV1CLIP0001',
        page: 1,
        start: 3,
        end: 5,
        note: '输出文件_2',
        name: '检索命中片段',
        source: 'search'
      }
    ])

    const clips = db.listClips().filter((c) => c.bvid === 'BV1CLIP0001')
    assert.strictEqual(clips.length, 2)
    assert.strictEqual(clips[0].name, '开场钩子', '片段名称应写入')
    assert.strictEqual(clips[0].note, '输出文件_1', '输出文件名与片段名称是两回事')
    assert.strictEqual(clips[0].source, 'manual')
    assert.strictEqual(clips[1].source, 'search', '来源应记录')
    assert.strictEqual(clips[1].favorite, false, '未收藏的片段 favorite 应为 false')
    // 没显式给 name 时用 note 兜底，保证列表里永远有可读名字
    assert.ok(clips[1].name.length > 0)

    // 改名只动 name，不动 note
    db.updateClipName(clips[0].id, '新的片段名')
    const renamed = db.listClips().find((c) => c.id === clips[0].id)!
    assert.strictEqual(renamed.name, '新的片段名')
    assert.strictEqual(renamed.note, '输出文件_1', '改名不该影响输出文件名')

    // 收藏开关（先开再关，验证两个方向都对）
    assert.strictEqual(db.toggleClipFavorite(clips[1].id), true, '第一次点应变成已收藏')
    assert.strictEqual(db.toggleClipFavorite(clips[1].id), false, '再点应取消收藏')

    // 片段标签：与视频标签共用一套 tags
    const tag = db.createTag('片段标签测试')
    db.setClipTags(clips[0].id, [tag])
    assert.deepStrictEqual(db.getClipTagIds(clips[0].id), [tag])
    assert.deepStrictEqual(db.listClipIdsByTag(tag), [clips[0].id])
    const tagRow = db.listTags().find((t) => t.id === tag)
    assert.strictEqual(tagRow?.clipCount, 1, '标签应统计到片段')

    // 首页「收藏片段」用的是同一个 favorite 标记（clips[0] 建的时候就带了 favorite）
    const overview = db.dashboardOverview()
    const saved = db.listClips().find((c) => c.id === clips[0].id)
    assert.strictEqual(
      saved?.favorite,
      true,
      `收藏标记应回读为 true（实际 ${String(saved?.favorite)}，source=${String(saved?.source)}）`
    )
    assert.ok(
      overview.favoriteClips.some((c) => c.id === clips[0].id),
      '收藏的片段应出现在首页数据里'
    )
  })

  check('分析结果表：写入 / 覆盖 / 按类型读取（第六阶段的接口先测通）', () => {
    db.saveAnalysis({
      targetType: 'video',
      targetId: 1,
      kind: 'summary',
      payload: JSON.stringify({ text: '第一版摘要' }),
      provider: 'manual'
    })
    // 同一对象同一类型只保留最新一条
    db.saveAnalysis({
      targetType: 'video',
      targetId: 1,
      kind: 'summary',
      payload: JSON.stringify({ text: '第二版摘要' }),
      provider: 'manual'
    })
    db.saveAnalysis({
      targetType: 'video',
      targetId: 1,
      kind: 'tags',
      payload: JSON.stringify({ tags: ['科技', 'AI'] })
    })

    const summaries = db.listAnalysis('video', 1, 'summary')
    assert.strictEqual(summaries.length, 1, '同类型应只保留最新一条')
    assert.strictEqual(JSON.parse(summaries[0].payload).text, '第二版摘要')

    const all = db.listAnalysis('video', 1)
    assert.strictEqual(all.length, 2, '不同 kind 应各留一条')
    assert.strictEqual(db.listAnalysis('doc', 999).length, 0, '没有结果时返回空数组')
  })

  /* ------------------ 14.6 语义索引的切分与状态（第四阶段下半） ------------------ */
  check('语义段落切分：按时间窗口合并，且可反复调用不重复', () => {
    const up = db.upsertUploader(880020, '语义测试UP主')
    const col = db.upsertCollection(up, null, '单视频')
    const vid = db.upsertVideo(col, 'BV1SEM00001', '语义测试视频', {})
    const doc = db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'sem.srt', 'bilibili', [
      // 前 3 条紧密相连 → 应并成一段
      cue(1, 0, 2, '第一句'),
      cue(2, 2.5, 5, '第二句'),
      cue(3, 5.5, 8, '第三句'),
      // 间隔大（> 3 秒）→ 另起一段
      cue(4, 30, 32, '换话题了')
    ])

    const created = db.buildSemanticChunks(45)
    const totalAfter = db.semanticCounts().total
    assert.ok(created >= 2, `至少应切出 2 段，实际 ${created}`)
    assert.ok(totalAfter >= created, `段落总数 ${totalAfter} 不该少于本次切出的 ${created}`)

    // 取这一篇的段落（**不能**用 nextUnindexedChunks：它按全局 id 排序，
    // 库里还有别的测试文档的段落排在前面，拿到的会是别人的）
    const docChunks = db.listChunksByDoc(doc.docId)
    assert.strictEqual(docChunks.length, 2, `这一篇应切出 2 段，实际 ${docChunks.length}`)
    const meta = docChunks[0]
    assert.strictEqual(meta.docId, doc.docId)
    assert.strictEqual(meta.videoId, vid)
    assert.strictEqual(meta.firstIdx, 1, '段落首句序号应是 1')
    assert.ok(meta.text.includes('第一句') && meta.text.includes('第三句'), '同段应含前三条')
    assert.ok(docChunks[1].text.includes('换话题'), '第二段应是换话题那句')

    // 写入向量后 indexed 计数要跟上（向量内容无所谓，这里只验证链路）
    const dim = 4
    const indexedBefore = db.semanticCounts().indexed
    db.saveChunkVectors([{ chunkId: meta.id, vector: Buffer.alloc(dim * 4) }], dim, 'test')
    const after = db.semanticCounts()
    assert.strictEqual(after.indexed, indexedBefore + 1, '写入一条向量后已索引数应 +1')
    assert.ok(
      db.allChunkVectors().some((v) => v.chunkId === meta.id),
      '应能取回刚写入的向量'
    )

    // 正文改了 → 该文档的段落与向量必须清掉（否则语义检索会拿旧正文的结果）
    const before = db.semanticCounts().total
    db.updateDocCues(doc.docId, [cue(1, 0, 2, '完全换掉的内容')])
    const cleared = db.semanticCounts()
    assert.strictEqual(cleared.total, before - 2, '该文档的两段应被清掉（其余文档的段落保留）')
    assert.strictEqual(db.listChunksByDoc(doc.docId).length, 0, '该文档已无段落')
    assert.ok(!db.allChunkVectors().some((v) => v.chunkId === meta.id), '它的向量也该没了')

    // 清空全部索引
    db.clearAllChunks()
    assert.deepStrictEqual(db.semanticCounts(), { total: 0, indexed: 0 })
  })

  /* --------------- 视频标题规范化在所有出口一致（第九阶段） --------------- */
  check('标题规范化：树 / getVideo / 检索 三处出口都要一致', () => {
    // 这条测试防的是一个**真实踩过的坑**：标题规范化最初只加在 `toVideo()` 上，
    // 而 `buildTree()` 直接读 `v.title` 绕过了它 → 「列表里是规范标题、树上还是旧的」。
    // 规范化的意义就是按时间排序一眼可见，两边不一致等于没做。
    const up = db.upsertUploader(880099, '标题测试UP主')
    const col = db.upsertCollection(up, null, '标题测试合集')
    const raw = '【标题测试UP主】杂谈节目 2026年10月15日19点场'
    const vid = db.upsertVideo(col, 'BV1TITLE001', raw, {})
    db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'title.srt', 'bilibili', [
      cue(1, 0, 5, '这句里有独特关键词 zzzq')
    ])

    const expected = '2026年10月15日19点场 标题测试UP主 杂谈节目'

    assert.strictEqual(db.getVideo(vid)!.title, expected, 'getVideo 应给规范标题')

    const findInTree = (nodes: unknown[]): { label?: string } | null => {
      for (const raw of nodes) {
        const n = raw as { key?: string; label?: string; children?: unknown[] }
        if (n.key === `video:${vid}`) return n
        const hit = n.children ? findInTree(n.children) : null
        if (hit) return hit
      }
      return null
    }
    const node = findInTree(db.buildTree())
    assert.ok(node, '应能在树里找到该视频')
    assert.strictEqual(node!.label, expected, '资源树的 label 也必须是规范标题')

    const hits = db.searchCues('zzzq')
    const hit = hits.find((h) => h.videoId === vid)
    assert.ok(hit, '应能检索到该字幕')
    assert.strictEqual(hit!.videoTitle, expected, '检索结果里的视频标题也要规范')
  })

  /* --------------- 剪辑文案模板的数据库链路（第八阶段） --------------- */
  check('剪辑文案模板：首灌内置模板 + 增删改查', () => {
    // 首次运行时 `initDb` 会灌入内置模板（表非空则跳过，绝不覆盖用户改动）
    const initial = db.listCopyTemplates()
    assert.ok(initial.length >= 3, `首次运行应灌入内置模板，实际 ${initial.length} 个`)
    assert.ok(
      initial.every((t) => t.builtin === 1),
      '灌进去的都应标记为内置'
    )
    assert.ok(
      initial.some((t) => t.id === 'shortvideo'),
      '应包含「短视频发布文案」'
    )

    // 再调一次不该重复灌（幂等）
    const seededAgain = db.seedCopyTemplatesIfEmpty([
      { id: 'x', name: 'X', description: '', body: 'B' }
    ])
    assert.strictEqual(seededAgain, false, '表非空时不该再灌种子')
    assert.strictEqual(db.listCopyTemplates().length, initial.length, '数量不该变')

    // 新建自定义模板
    db.saveCopyTemplate({ id: 'custom-1', name: '我的模板', description: '说明', body: '{title}' })
    const custom = db.getCopyTemplate('custom-1')
    assert.ok(custom, '应能按 id 取回')
    assert.strictEqual(custom!.name, '我的模板')
    assert.strictEqual(custom!.builtin, 0, '自定义模板不该被标成内置')

    // 更新：内置标记必须保留（界面据此显示「内置」），且不能产生重复行
    db.saveCopyTemplate({ id: 'custom-1', name: '改名后', description: 'd', body: '{title}{tag}' })
    assert.strictEqual(db.getCopyTemplate('custom-1')!.name, '改名后')
    assert.strictEqual(db.listCopyTemplates().filter((t) => t.id === 'custom-1').length, 1)

    db.saveCopyTemplate({ id: 'shortvideo', name: '改过的内置', description: '', body: 'x' })
    assert.strictEqual(db.getCopyTemplate('shortvideo')!.builtin, 1, '内置标记要保留')

    db.deleteCopyTemplate('custom-1')
    assert.strictEqual(db.getCopyTemplate('custom-1'), null, '删除后应取不到')
  })

  /* --------------- 知识图谱的数据库链路（第八阶段） --------------- */
  check('知识图谱：主题 / 视频 / 观点三层都能查，且 SQL 与 schema 对得上', () => {
    // 为什么必须有这条：图谱的查询是手写 SQL，`tsc` **抓不到列名写错**。
    // 实测踩过一次 —— `listTopicVideos` 里写了 `col.name`，
    // 而 collections 表的列其实叫 `title`，UP主名在 uploaders.name，
    // 于是「点主题 → 视频列表永远是 0 条」，编译与类型检查全绿。
    const up = db.upsertUploader(880077, '图谱测试UP主')
    const col = db.upsertCollection(up, null, '图谱测试合集')
    const vid = db.upsertVideo(col, 'BV1GRAPH001', '图谱测试视频', {})
    db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'graph.srt', 'bilibili', [
      cue(1, 0, 5, '人工智能的关键在于数据质量'),
      cue(2, 6, 12, '短视频剪辑其实很看选题'),
      cue(3, 13, 20, '人工智能可以帮我们做字幕')
    ])

    // 写入主题与观点（模拟建图结果）
    db.saveVideoTopics(vid, [
      { term: '人工智能', count: 2, score: 9.5 },
      { term: '短视频剪辑', count: 1, score: 4.2 }
    ])
    const doc = db.listDocsForGraph().find((d) => d.videoId === vid)!
    db.saveVideoViewpoints(vid, doc.id, 1, [
      { index: 1, start: 0, end: 5, text: '人工智能的关键在于数据质量。', score: 7 }
    ])
    db.refreshTopicStats()

    const topics = db.listTopics('人工智能', 10)
    const topic = topics.find((t) => t.term === '人工智能')
    assert.ok(topic, '应能按关键词查到主题')
    assert.strictEqual(topic!.videoCount, 1, '主题应关联到 1 个视频')

    // 这一条就是当初报 `no such column` 的那次调用
    const videos = db.listTopicVideos(topic!.id, 10)
    assert.strictEqual(videos.length, 1, '主题下应能查到视频（SQL 列名必须与 schema 一致）')
    assert.strictEqual(videos[0].videoId, vid)
    assert.strictEqual(videos[0].uploaderName, '图谱测试UP主', 'UP主名要取到（来自 uploaders 表）')
    assert.strictEqual(videos[0].viewpoints, 1, '应带上该视频的观点数')

    const vps = db.listViewpoints(vid, 10)
    assert.strictEqual(vps.length, 1, '应能查到观点句')
    assert.strictEqual(vps[0].index, 1, '观点要记住它覆盖的首条字幕序号（跳转要用）')
    assert.strictEqual(vps[0].docId, doc.id)

    const videoTopics = db.listVideoTopics(vid, 10)
    assert.strictEqual(videoTopics.length, 2, '「视频 → 主题」应能反向查到')

    // 幂等：重复写入不应产生重复行（重建图谱会反复调）
    db.saveVideoTopics(vid, [{ term: '人工智能', count: 5, score: 12 }])
    assert.strictEqual(db.listVideoTopics(vid, 10).length, 1, '重复保存应覆盖而不是叠加')
    assert.strictEqual(
      db.listTopicVideos(topic!.id, 10)[0].count,
      5,
      '覆盖后 count 应更新'
    )

    // 清理，避免影响后续用例
    db.saveVideoTopics(vid, [])
    db.saveVideoViewpoints(vid, doc.id, 1, [])
    db.refreshTopicStats()
  })

  /* --------------- 素材推荐的数据库链路（第八阶段） --------------- */
  check('素材推荐：从向量到结果的整条链路（含跨视频排除与近邻去重）', () => {
    // 造两个视频，各两条段落；用「手工构造的向量」把相似关系写死，避免依赖模型
    const up = db.upsertUploader(880030, '推荐测试UP主')
    const col = db.upsertCollection(up, null, '单视频')
    const vA = db.upsertVideo(col, 'BV1REC00001', '推荐测试视频A', {})
    const vB = db.upsertVideo(col, 'BV1REC00002', '推荐测试视频B', {})
    // A 的两段离得很近（同文档 0s 与 10s）+ 内容不同；B 的一段与 A 的某段几乎相同
    const docA = db.upsertDoc(vA, 1, 'zh-CN', '简体中文', 'a.srt', 'bilibili', [
      cue(1, 0, 5, 'A 的第一段：讲了怎么做短视频'),
      cue(2, 10, 15, 'A 的第二段：完全无关的话题')
    ])
    const docB = db.upsertDoc(vB, 1, 'zh-CN', '简体中文', 'b.srt', 'bilibili', [
      cue(1, 0, 5, 'B 的段落：也是讲怎么做短视频')
    ])

    // 注意：`buildSemanticChunks` 是**全局**的（会把库里所有还没切过的文档都切一遍），
    // 所以不假设「库里只有本用例的文档」——直接断言**本用例这两个文档**切出了几段
    db.buildSemanticChunks(45)
    const chunksA = db.listChunksByDoc(docA.docId)
    const chunksB = db.listChunksByDoc(docB.docId)
    assert.strictEqual(chunksA.length, 2, `文档 A 应切出 2 段，实际 ${chunksA.length}`)
    assert.strictEqual(chunksB.length, 1, `文档 B 应切出 1 段，实际 ${chunksB.length}`)

    // 手工给三段写向量：A1 与 B1 几乎同向，A2 与它们正交
    const vecA1 = [1, 0]
    const vecB1 = [0.99, 0.01]
    const vecA2 = [0, 1]
    assert.strictEqual(chunksA.length, 2)
    assert.strictEqual(chunksB.length, 1)
    // 浮点统一用 Float32 落库，读回来会有极小误差，断言时留容差
    db.saveChunkVectors(
      [
        { chunkId: chunksA[0].id, vector: Buffer.from(Float32Array.from(vecA1).buffer) },
        { chunkId: chunksA[1].id, vector: Buffer.from(Float32Array.from(vecA2).buffer) },
        { chunkId: chunksB[0].id, vector: Buffer.from(Float32Array.from(vecB1).buffer) }
      ],
      2,
      'test'
    )

    // 以 A 的第一段为参照找双胞胎：应命中 B 的段落，且**不**返回 A 自己的段落
    const twins = recommendTwins({ chunkId: chunksA[0].id, limit: 10, })
    assert.strictEqual(twins.items.length, 1, `应只有 B 的一段，实际 ${twins.items.length}`)
    assert.strictEqual(twins.items[0].videoId, vB, '双胞胎必须来自别的视频')
    assert.ok(twins.items[0].score > 0.99, `同向向量相似度应接近 1，实际 ${twins.items[0].score}`)
    assert.ok(twins.items[0].reason.length > 0, '要给出可读的理由')

    // 视频 A 的「主题鲜明」段落：闸门用真实相似度，这里 A1/A2 与中心都很低，
    // 所以断言的是「要么给出结果、要么给出可解释的说明」，而不是硬要几条
    const hl = recommendHighlights({ videoId: vA, limit: 5 })
    assert.ok(
      hl.items.length > 0 || (hl.message ?? '').length > 0,
      '推荐要么给结果、要么给可解释的说明，不能两者皆空'
    )

    // 没有向量的视频要给明确说明而不是空结果
    const empty = recommendHighlights({ videoId: 999999, limit: 5 })
    assert.strictEqual(empty.items.length, 0)
    assert.ok((empty.message ?? '').includes('还没有'), `应说明原因，实际：${empty.message}`)

    // 清理，避免影响后续用例的段落计数
    db.clearDocChunks(docA.docId)
    db.clearDocChunks(docB.docId)
  })


  check('视频作者：与 UP主 分开记录，互不干扰分组', () => {    const up = db.upsertUploader(880012, '投稿账号')
    const col = db.upsertCollection(up, null, '单视频')
    const vid = db.upsertVideo(col, 'BV1CREW0001', '合作视频', {})
    db.setVideoCreators(vid, [
      { name: '出镜的人', mid: 111 },
      { name: '剪辑的人', mid: 222 }
    ])
    assert.deepStrictEqual(db.listVideoCreators(vid).sort(), ['出镜的人', '剪辑的人'].sort())

    // 重设时旧署名要被清掉，避免越攒越多
    db.setVideoCreators(vid, [{ name: '只有一个人', mid: 111 }])
    assert.deepStrictEqual(db.listVideoCreators(vid), ['只有一个人'])

    // 作者不影响资源树的分组（分组只看 UP主）
    const tree = db.buildTree()
    const owner = tree.find((n) => n.label === '投稿账号')
    assert.ok(owner, '投稿账号应作为 UP主 出现在树里')
  })

  /* ---------------------- 15. 切片任务排序 / 改名 / 历史 ---------------------- */
  check('切片任务可上下移动，顺序会持久化', () => {
    const up = db.upsertUploader(880003, '排序测试UP主')
    const col = db.upsertCollection(up, null, '单视频')
    const vid = db.upsertVideo(col, 'BV1ORDER001', '排序测试视频', {})
    const doc = db.upsertDoc(vid, 1, 'zh-CN', '简体中文', 'o.srt', 'bilibili', [
      cue(1, 0, 1, '排序测试字幕')
    ])
    // 加片段并**同时排进队列**（拆表后「片段」与「任务」是两件事，
    // 队列顺序属于 export_jobs，所以这里要看任务列表）
    db.addClips(
      ['A', 'B', 'C'].map((n, i) => ({
        docId: doc.docId,
        bvid: 'BV1ORDER001',
        page: 1,
        start: i,
        end: i + 1,
        note: `排序_${n}`
      })),
      true
    )

    const mine = (): string[] =>
      db
        .listExportJobs('pending')
        .filter((t) => t.bvid === 'BV1ORDER001')
        .map((t) => t.note)

    assert.deepStrictEqual(mine(), ['排序_A', '排序_B', '排序_C'], '新任务按加入顺序排列')

    const b = db.listExportJobs('pending').find((t) => t.note === '排序_B')!
    db.moveExportJob(b.id, -1)
    assert.deepStrictEqual(mine(), ['排序_B', '排序_A', '排序_C'], '上移应换位')

    db.moveExportJob(b.id, 1)
    assert.deepStrictEqual(mine(), ['排序_A', '排序_B', '排序_C'], '下移应换回来')

    // 边界：第一条上移、最后一条下移都不该越界
    const a = db.listExportJobs('pending').find((t) => t.note === '排序_A')!
    const c = db.listExportJobs('pending').find((t) => t.note === '排序_C')!
    db.moveExportJob(a.id, -1)
    db.moveExportJob(c.id, 1)
    assert.deepStrictEqual(mine(), ['排序_A', '排序_B', '排序_C'], '边界移动应被忽略')

    // 改名（备注就是输出文件名）：这是对**片段**的改名
    const clipB = db.listClips().find((t) => t.note === '排序_B')!
    db.updateClipNote(clipB.id, '排序_改过名')
    assert.strictEqual(db.listClips().find((t) => t.id === clipB.id)?.note, '排序_改过名')
    // 任务里存的是**快照**，所以改片段不会追改已在队列中的任务
    assert.strictEqual(
      db.listExportJobs('pending').find((t) => t.id === b.id)?.note,
      '排序_B',
      '任务存快照：改片段名不该回头改任务'
    )

    db.clearClips()
    assert.strictEqual(db.listClips().filter((t) => t.bvid === 'BV1ORDER001').length, 0)
    db.clearPendingExportJobs()
    db.deleteUploader(up)
  })

  check('切片历史可记录、可查询，且任务被清空后历史仍在', () => {
    db.clearSliceHistory()
    assert.strictEqual(db.listSliceHistory().length, 0)

    db.recordSliceHistory([
      { clipId: 1, note: '历史_成功', bvid: 'BV1HIST001', page: 1, start: 0, end: 5, status: 'ok', output: 'D:/out/a.mp4', message: '' },
      { clipId: 2, note: '历史_失败', bvid: 'BV1HIST001', page: 2, start: 5, end: 9, status: 'error', output: '', message: '下载失败' }
    ])

    const list = db.listSliceHistory()
    assert.strictEqual(list.length, 2)
    assert.strictEqual(list.filter((h) => h.status === 'error').length, 1, '失败状态应保留')
    assert.strictEqual(list.find((h) => h.status === 'error')?.message, '下载失败')
    assert.strictEqual(list.find((h) => h.status === 'ok')?.output, 'D:/out/a.mp4')

    // 任务清空后历史不该消失（这就是 clip_id 不加外键的原因）
    db.clearClips()
    assert.strictEqual(db.listSliceHistory().length, 2, '清空任务不应连带清掉历史')

    db.clearSliceHistory()
    assert.strictEqual(db.listSliceHistory().length, 0)
  })

  /* ------------------------- 16. 备份 / 恢复 / 清空 ------------------------- */
  check('备份是单个自洽文件（换一份库目录也能读到同样的数据）', () => {
    const backupFile = join(workDir, 'backup.db')
    db.backupTo(backupFile)

    assert.ok(existsSync(backupFile), '备份文件应生成')
    assert.ok(db.looksLikeSqliteFile(backupFile), '备份应是合法的 SQLite 文件')
    assert.ok(!existsSync(`${backupFile}-wal`), '备份不该依赖 -wal 边车文件')

    const before = db.stats()
    assert.ok(before.videos > 0, '备份前应已有数据')

    // 清空：数据全没了，但表结构留着
    const cleared = db.clearAllData()
    assert.ok(cleared > 0, '清空应报告清掉的记录数')
    assert.strictEqual(db.stats().videos, 0, '清空后视频应为 0')
    assert.strictEqual(db.stats().docs, 0, '清空后文档应为 0')
    assert.strictEqual(db.buildTree().length, 0, '清空后资源树应为空')
    assert.strictEqual(db.searchCues('独角兽').length, 0, '清空后检索不应有结果')

    // 把备份当成「换台机器」：放到一个全新的库目录里打开
    const otherDir = mkdtempSync(join(tmpdir(), 'srt-tool-restore-'))
    const otherData = join(otherDir, 'subclip-data')
    mkdirSync(otherData, { recursive: true })
    copyFileSync(backupFile, join(otherData, 'srt-tool.db'))
    db.initDb(otherDir)
    assert.strictEqual(db.stats().videos, before.videos, '恢复后视频数应一致')
    assert.strictEqual(db.stats().docs, before.docs, '恢复后文档数应一致')
    db.closeDb()
    rmSync(otherDir, { recursive: true, force: true })

    // 再按真实恢复流程把主库写回来（关库 → 覆盖 → 重开）
    const mainData = join(workDir, 'subclip-data')
    copyFileSync(backupFile, join(mainData, 'srt-tool.db'))
    rmSync(join(mainData, 'srt-tool.db-wal'), { force: true })
    rmSync(join(mainData, 'srt-tool.db-shm'), { force: true })
    db.initDb(workDir)
    assert.strictEqual(db.stats().videos, before.videos, '恢复后主库应回到备份时的状态')
  })

  check('非 SQLite 文件会被拒绝，不会被误当成备份导入', () => {
    const fake = join(workDir, 'not-a-db.db')
    writeFileSync(fake, '这不是数据库', 'utf8')
    assert.strictEqual(db.looksLikeSqliteFile(fake), false)
    assert.strictEqual(db.looksLikeSqliteFile(join(workDir, '不存在的文件.db')), false)
  })

  /* ------------- 拆表迁移：老 clips 队列 + slice_history → export_jobs ------------- */
  check('拆表迁移：老「队列 + 历史」搬进 export_jobs，片段全部保留', () => {
    /**
     * 这一条覆盖 3.6.0 最需要保证的事：**拆表不能丢东西，也不能把重复记录插两遍**。
     *
     * 做法是先在隔离目录里手工造出**老结构的库**（`clips` 带 sort_order、
     * 外加一张 `slice_history`），再让 `initDb()` 打开它触发迁移。
     * 直接把老表塞进主库是不行的 —— 主库已经跑过迁移，`slice_history` 已被删掉。
     */
    const isoDir = mkdtempSync(join(tmpdir(), 'srt-tool-split-'))
    const dataDir = join(isoDir, 'subclip-data')
    mkdirSync(dataDir, { recursive: true })

    // 1. 手工建出「拆表前」的库结构
    const raw = new DatabaseSync(join(dataDir, 'srt-tool.db'))
    raw.exec(`
      create table videos (
        id integer primary key autoincrement, collection_id integer, bvid text not null default '',
        title text not null default '', url text, cover text, duration real, page_count integer,
        favorite integer not null default 0, created_at integer not null
      );
      create table docs (
        id integer primary key autoincrement, video_id integer not null, page integer not null default 1,
        lang text not null default 'zh-CN', label text, filename text, source text,
        created_at integer not null
      );
      create table clips (
        id integer primary key autoincrement, doc_id integer, bvid text not null default '',
        page integer not null default 1, start real not null default 0, end real not null default 0,
        note text not null default '', name text not null default '', source text not null default 'manual',
        favorite integer not null default 0, segments text, created_at integer not null,
        sort_order integer not null default 0
      );
      create table slice_history (
        id integer primary key autoincrement, clip_id integer, note text not null,
        bvid text not null default '', page integer not null default 1, start real not null default 0,
        end real not null default 0, segments text, status text not null, output text, message text,
        created_at integer not null
      );
      insert into clips (doc_id, bvid, page, start, end, note, name, sort_order, created_at)
        values (0, 'BV1SPLIT001', 1, 1, 2, '老队列_甲', '甲', 0, 100),
               (0, 'BV1SPLIT001', 1, 3, 4, '老队列_乙', '乙', 1, 200);
      insert into slice_history (clip_id, note, bvid, page, start, end, status, output, message, created_at)
        values (1, '老历史_成功', 'BV1SPLIT001', 1, 1, 2, 'ok', 'D:/out/a.mp4', null, 300),
               (2, '老历史_失败', 'BV1SPLIT001', 1, 3, 4, 'error', null, 'ffmpeg 挂了', 400);
    `)
    raw.close()

    // 2. 打开它 → 触发迁移
    db.closeDb()
    db.initDb(isoDir)

    // 片段一个都不能少（这是用户资产）
    const clips = db.listClips()
    assert.strictEqual(clips.length, 2, '老队列里的片段应全部保留')
    assert.deepStrictEqual(
      clips.map((c) => c.name).sort(),
      ['乙', '甲'],
      '片段名称应保留'
    )

    // 老队列 → 2 条 pending（顺序沿用原 sort_order）
    const pending = db.listExportJobs('pending')
    assert.strictEqual(pending.length, 2, '老队列应变成待处理任务')
    assert.deepStrictEqual(
      pending.map((j) => j.note),
      ['老队列_甲', '老队列_乙'],
      '队列顺序应沿用原来的 sort_order'
    )

    // 老历史 → 终态任务，状态名映射正确（ok→done、error→failed）
    const done = db.listSliceHistory()
    assert.strictEqual(done.length, 2, '老历史应迁成终态任务')
    const okRow = done.find((h) => h.note === '老历史_成功')!
    const errRow = done.find((h) => h.note === '老历史_失败')!
    assert.strictEqual(okRow.status, 'ok', 'ok 应映射成完成态')
    assert.strictEqual(okRow.output, 'D:/out/a.mp4', '产物路径应保留')
    assert.strictEqual(errRow.status, 'error', 'error 应映射成失败态')
    assert.strictEqual(errRow.message, 'ffmpeg 挂了', '失败原因应保留（重试要用）')

    // 老表已删除、老列已删除 —— 避免留一张永远为空的死表
    assert.strictEqual(db.hasTable('slice_history'), false, '老表应被删除')
    assert.strictEqual(db.clipsHasColumn('sort_order'), false, '老列应被删除')

    // 3. 幂等：再打开一次不该把记录插两遍
    db.closeDb()
    db.initDb(isoDir)
    assert.strictEqual(db.listExportJobs('pending').length, 2, '重复打开不应重复插入')
    assert.strictEqual(db.listSliceHistory().length, 2, '重复打开不应重复插入历史')

    db.closeDb()
    rmSync(isoDir, { recursive: true, force: true })
    db.initDb(workDir)
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
