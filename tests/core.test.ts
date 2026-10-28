/**
 * 核心逻辑测试（纯函数，不依赖 Electron）。
 * 运行：npm run test:core
 */
import assert from 'node:assert'
import type { AppSettings, Cue } from '../src/shared/types'
import { formatTime, parseTime } from '../src/shared/time'
import { buildRanges, normalizeRanges, totalDuration, type RangeCue } from '../src/shared/ranges'
import {
  biliSubtitleToCues,
  decodeBuffer,
  parseSrt,
  replaceInCues,
  shiftCues,
  toPlainText,
  toSrt,
  toVtt
} from '../src/main/srt'
import { toCsv } from '../src/main/exporter'
import { sanitizeFileName } from '../src/main/slice/filename'
import { buildDiagnostics, redactSettings } from '../src/main/diagnostics'
import { DEFAULT_NAME_TEMPLATE, compactDuration, fileStamp, renderNameTemplate } from '../src/shared/naming'
import { joinCueText, mergeCues, splitCue } from '../src/shared/cues'
import { parseClipTasksJson, serializeClipTasks } from '../src/main/clipIO'
import { classifyTargetUrl, parseCollectionUrl } from '../src/main/bilibili'
import {
  applyRangeSelection,
  cueIndexAtTime,
  cueIndexesInRange,
  pxToSecond,
  secondToPx
} from '../src/shared/timeline'
import { generateAiTitle, generateClipTitle } from '../src/shared/clipTitle'
import { buildSummaryPrompt, buildTagsPrompt, buildTitlePrompt, parseTagSuggestions } from '../src/main/ai/prompts'
import type { ClipTask } from '../src/shared/types'
import { readFileSync } from 'node:fs'
import {
  buildPublishKit,
  buildStoryboard,
  hms,
  renderClipCsv,
  renderKitReadme,
  renderStoryboardTable,
  safeKitName,
  type KitClip,
  type KitInput
} from '../src/shared/publishKit'
import { normalizeTitles, normalizeVideoTitle } from '../src/shared/titleName'
import { classifyBracket, listPlatformLabels } from '../src/shared/titleNameBrackets'
import {
  BUILTIN_TEMPLATES,
  extractTokens,
  renderCopyTemplate,
  splitForPublish
} from '../src/shared/copyTemplate'
import {
  chattyRatio,
  countTerms,
  isTermLike,
  mergeIntoSentences,
  pickTopics,
  scoreSentences,
  scoreTerms,
  tokenize,
  topicFocusRatio
} from '../src/shared/extract'
import {
  cosine,
  decodeVector,
  dedupeNearby,
  encodeVector,
  highlightReason,
  meanVector,
  topN,
  twinsReason,
  typicalReason
} from '../src/shared/recommend'
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_LIMITS,
  BRIDGE_PROTOCOL_VERSION,
  normalizeCapabilities,
  parseClientMessage,
  requiredCapability,
  serialize,
  serverCapabilities,
  supportsCap
} from '../src/shared/bridge'
import * as constants from '../src/shared/constants'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  eventToBinding,
  findConflicts,
  formatBinding,
  normalizeShortcuts,
  resolveAction
} from '../src/shared/shortcuts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const cue = (index: number, start: number, end: number, text = `第${index}句`): Cue => ({
  index,
  start,
  end,
  text
})

/* ---------------------------- 时间轴 ↔ 选择映射（第五阶段） ---------------------------- */
section('时间轴选片映射')

const mergedCues = [
  { index: 1, start: 0, end: 2, text: '第一句', docId: 1, page: 1, origIndex: 1 },
  { index: 2, start: 5, end: 7, text: '第二句', docId: 1, page: 1, origIndex: 2 },
  { index: 3, start: 10, end: 12, text: '第三句', docId: 1, page: 1, origIndex: 3 }
]

test('时间落在字幕区间内直接命中', () => {
  assert.strictEqual(cueIndexAtTime(mergedCues, 0), 1, '起点算命中')
  assert.strictEqual(cueIndexAtTime(mergedCues, 1), 1)
  assert.strictEqual(cueIndexAtTime(mergedCues, 2), 1, '终点也算命中')
  assert.strictEqual(cueIndexAtTime(mergedCues, 6), 2)
  assert.strictEqual(cueIndexAtTime(mergedCues, 11), 3)
})

test('时间落在空白处给最近的一条', () => {
  // 3 秒：距第一句终点（2）1 秒，距第二句起点（5）2 秒 → 第一句更近
  assert.strictEqual(cueIndexAtTime(mergedCues, 3), 1)
  // 8.5 秒：距第二句终点 1.5，距第三句起点 1.5 → 平手时取先遇到的（后者距离严格更小才替换）
  assert.strictEqual(cueIndexAtTime(mergedCues, 8.5), 2)
  // 很靠后：最近的是第三句
  assert.strictEqual(cueIndexAtTime(mergedCues, 100), 3)
  assert.strictEqual(cueIndexAtTime([], 1), null, '没有字幕时返回 null')
})

test('拖选按“有重叠”判定，不需要完全覆盖字幕', () => {
  // 只拖到 1~1.5，与第一句有重叠 → 选中（若用“完全包含”会一条都选不上）
  assert.deepStrictEqual(cueIndexesInRange(mergedCues, 1, 1.5), [1])
  // 覆盖第一句末尾到第二句开头
  assert.deepStrictEqual(cueIndexesInRange(mergedCues, 1.5, 5.5), [1, 2])
  // 反向拖动（从右往左）结果一样
  assert.deepStrictEqual(cueIndexesInRange(mergedCues, 5.5, 1.5), [1, 2])
  // 完全没有交集
  assert.deepStrictEqual(cueIndexesInRange(mergedCues, 3, 4), [])
  // 全选
  assert.deepStrictEqual(cueIndexesInRange(mergedCues, -1, 999), [1, 2, 3])
})

test('拖选是替换语义，Shift 拖选是追加语义', () => {
  const current = new Set([3])
  assert.deepStrictEqual([...applyRangeSelection(current, [1, 2], false)], [1, 2], '默认替换')
  assert.deepStrictEqual(
    [...applyRangeSelection(current, [1, 2], true)].sort((a, b) => a - b),
    [1, 2, 3],
    'Shift 追加，原有选择保留'
  )
  assert.deepStrictEqual([...applyRangeSelection(new Set(), [], false)], [], '空区间得到空选择')
})

test('像素与秒的换算（含边界与非法参数）', () => {
  assert.strictEqual(pxToSecond(0, 100, 200), 0)
  assert.strictEqual(pxToSecond(50, 100, 200), 100)
  assert.strictEqual(pxToSecond(100, 100, 200), 200)
  assert.strictEqual(pxToSecond(150, 100, 200), 200, '越界要夹住')
  assert.strictEqual(pxToSecond(-10, 100, 200), 0, '负数要夹住')
  assert.strictEqual(pxToSecond(50, 0, 200), 0, '宽度为 0 时返回 0（避免除零得到 NaN）')
  assert.strictEqual(secondToPx(100, 100, 200), 50)
  assert.strictEqual(secondToPx(999, 100, 200), 100, '越界夹住')
  assert.strictEqual(secondToPx(1, 100, 0), 0, '时长为 0 时返回 0')
})

/* ------------------------------ 素材推荐算法（第八阶段） ------------------------------ */
section('素材推荐算法')

test('余弦相似度：归一化向量的点积，且不受向量长度影响', () => {
  assert.strictEqual(cosine([1, 0, 0], [1, 0, 0]), 1, '同向 = 1')
  assert.strictEqual(cosine([1, 0], [0, 1]), 0, '正交 = 0')
  assert.strictEqual(cosine([1, 0], [-1, 0]), -1, '反向 = -1')
  // 未归一化的向量也要给对（落库再读出来不保证归一化）
  assert.ok(Math.abs(cosine([2, 0], [5, 0]) - 1) < 1e-9, '模长不同不影响余弦')
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9, '45 度 = √2/2')
})

test('余弦相似度：零向量 / 维度不一致不返回 NaN', () => {
  assert.strictEqual(cosine([0, 0], [1, 1]), 0, '零向量给 0 而不是 NaN')
  assert.strictEqual(cosine([], []), 0, '空向量给 0')
  assert.strictEqual(cosine([1, 0, 0], [1, 0]), 1, '维度不一致时按较短的对齐')
  // 浮点误差可能让结果略微越界，必须夹住，否则界面会出现 1.0000002 这种分数
  const v = new Array(300).fill(0.1)
  const s = cosine(v, v)
  assert.ok(s <= 1 && s >= -1, `分数必须在 [-1,1]，实际 ${s}`)
})

test('平均向量：求「视频语义中心」', () => {
  const mean = meanVector([
    [1, 0],
    [0, 1]
  ])
  assert.deepStrictEqual(Array.from(mean), [0.5, 0.5])
  assert.strictEqual(meanVector([]).length, 0, '空输入给空数组')
  // 维度不一致的向量被跳过，不污染结果
  const mixed = meanVector([
    [1, 1],
    [9, 9, 9]
  ])
  assert.deepStrictEqual(Array.from(mixed), [1, 1])
})

test('topN：按分数排序、排除指定项、尊重下限', () => {
  const scored = [
    { chunkId: 1, score: 0.9 },
    { chunkId: 2, score: 0.8 },
    { chunkId: 3, score: 0.4 },
    { chunkId: 4, score: 0.1 }
  ]
  assert.deepStrictEqual(
    topN(scored, 2).map((s) => s.chunkId),
    [1, 2],
    '取前两名'
  )
  assert.deepStrictEqual(
    topN(scored, 10, new Set([1])).map((s) => s.chunkId),
    [2, 3, 4],
    '排除指定项'
  )
  assert.deepStrictEqual(
    topN(scored, 10, new Set(), 0.5).map((s) => s.chunkId),
    [1, 2],
    '低于下限的不给'
  )
  assert.deepStrictEqual(topN(scored, 0), [], 'n=0 给空')
})

test('邻近去重：同一文档里挨得近的段落只留分数最高的', () => {
  // 1、2、3 都在同一文档的相邻窗口里，4 在另一文档
  const items = [
    { chunkId: 1, score: 0.9 },
    { chunkId: 2, score: 0.85 },
    { chunkId: 3, score: 0.8 },
    { chunkId: 4, score: 0.7 }
  ]
  const meta = (id: number): { docId: number; start: number } | null => {
    switch (id) {
      case 1:
        return { docId: 10, start: 100 }
      case 2:
        return { docId: 10, start: 110 }
      case 3:
        return { docId: 10, start: 130 }
      case 4:
        return { docId: 11, start: 105 }
      default:
        return null
    }
  }
  const out = dedupeNearby(items, meta, 120)
  assert.deepStrictEqual(
    out.map((i) => i.chunkId),
    [1, 4],
    '同一文档 100/110/130 秒只留最高分的第 1 条；另一文档的第 4 条保留'
  )

  const far = dedupeNearby(
    [
      { chunkId: 1, score: 0.9 },
      { chunkId: 2, score: 0.8 }
    ],
    (id) => ({ docId: 10, start: id === 1 ? 0 : 500 }),
    120
  )
  assert.strictEqual(far.length, 2, '间隔超过窗口就该都保留')

  assert.deepStrictEqual(dedupeNearby([{ chunkId: 99, score: 1 }], () => null), [])
})

test('向量编解码：非零 byteOffset 的视图也不能写歪（回归测试）', () => {
  // 回归的是什么：第一版用 `Buffer.from(mean.buffer, mean.byteOffset, mean.byteLength)`
  // 写语义中心，读回来是 -4.56e+27 这种垃圾值，导致「离主题最远」的推荐永远挑不出段落。
  // 正确做法见 encodeVector / decodeVector 的注释。
  const original = [0.0625, -0.0793, 1.5, -2.25, 0.001]
  const buffer = encodeVector(original)
  assert.strictEqual(buffer.byteLength, original.length * 4, 'Float32：每元素 4 字节')

  const decoded = decodeVector(buffer)
  assert.strictEqual(decoded.length, original.length, '元素数应一致')
  for (let i = 0; i < original.length; i++) {
    // Float32 精度有限，用容差比
    assert.ok(
      Math.abs(decoded[i] - original[i]) < 1e-5,
      `第 ${i} 个元素应往返一致：${decoded[i]} vs ${original[i]}`
    )
  }

  // 关键场景：视图带非零 byteOffset（正是踩坑的那种输入）
  const backing = new Float64Array([9, 9, 0.5, -0.25, 0.125])
  const view = backing.subarray(2) // byteOffset = 16
  assert.ok(view.byteOffset > 0, '这个视图确实带非零偏移')
  const fromView = encodeVector(view)
  assert.strictEqual(fromView.byteLength, view.length * 4, '只编视图里的数据，不含前面的 9')
  assert.deepStrictEqual(
    Array.from(decodeVector(fromView)).map((x) => Math.round(x * 1000) / 1000),
    [0.5, -0.25, 0.125],
    '编出来的必须是视图那一段，而不是整块底层缓冲'
  )

  // 再验一次「自己和自己」必须是 1（当初 bug 的表现就是这里莫名其妙变 0）
  const self = cosine(decodeVector(buffer), decodeVector(buffer))
  assert.ok(Math.abs(self - 1) < 1e-6, `自己和自己应为 1，实际 ${self}`)

  // 解码原样返回的 Buffer（模拟 SQLite 的共享视图）也要正确
  const shared = Buffer.allocUnsafe(64)
  buffer.copy(shared, 13) // 故意放到非零偏移上
  const slice = shared.subarray(13, 13 + buffer.length)
  assert.deepStrictEqual(
    Array.from(decodeVector(slice)),
    Array.from(decoded),
    '带偏移的共享 Buffer 解码结果必须一致'
  )
})

test('推荐理由文案：按分数给出可读说法', () => {
  assert.strictEqual(twinsReason(0.9), '几乎在讲同一件事')
  assert.strictEqual(twinsReason(0.75), '主题高度重合')
  assert.strictEqual(twinsReason(0.6), '内容相关')
  assert.strictEqual(twinsReason(0.4), '有一点关联')

  // highlight 的分数是「距离」（越大 = 越鲜明），理由要如实区分强弱
  assert.ok(highlightReason(0.5, 1).includes('第 1 推荐'))
  assert.ok(highlightReason(0.5, 1).includes('主题很鲜明'))
  assert.ok(highlightReason(0.35, 2).includes('有明确内容'))
  assert.ok(highlightReason(0.1, 3).includes('差别不大'))

  // 整场本身很泛时（fromTopic 低）要说实话，不能给虚假期待
  assert.ok(
    highlightReason(0.5, 1, 0.3).includes('可挑选余地有限'),
    'fromTopic 低于阈值时要说明可挑的余地有限'
  )
  assert.ok(!highlightReason(0.5, 1, 0.9).includes('余地有限'), '整场不泛时不该乱加免责')

  assert.ok(typicalReason(0.9, 1).includes('缩影'))
  assert.ok(typicalReason(0.75, 2).includes('很贴近'))
  assert.ok(typicalReason(0.5, 3).includes('部分贴近'))
})

/* ------------------------- 字幕文本抽取（第八阶段·知识图谱） ------------------------- */
section('字幕抽取：分词与主题词')

test('分词：相邻二元组合并，避免把复合词切碎', () => {
  const terms = tokenize('今天我们来聊聊人工智能与短视频剪辑').map((t) => t.text)
  // Intl.Segmenter 会把「人工智能」切成「人工 / 智能」、「剪辑」切成「剪 / 辑」，
  // 不合并的话抽出来的主题就是碎片（这是本模块最主要的坑）
  assert.ok(terms.includes('人工智能'), `应能合并出「人工智能」，实际：${terms.join('/')}`)
  assert.ok(terms.includes('短视频'), `应能合并出「短视频」，实际：${terms.join('/')}`)
  // 原形也保留，让统计自己决定谁更常用
  assert.ok(terms.includes('人工'), '原形也应保留')
})

test('分词：停用词被过滤，实义词一律保留', () => {
  assert.strictEqual(isTermLike('就是'), false, '填充词要滤掉')
  assert.strictEqual(isTermLike('然后'), false)
  assert.strictEqual(isTermLike('谢谢'), false, '直播套话要滤掉')
  assert.strictEqual(isTermLike('1234'), false, '纯数字滤掉')
  assert.strictEqual(isTermLike('的'), false, '单字默认滤掉')
  assert.strictEqual(isTermLike('人'), true, '实义单字保留')
  // ⚠️「不是」是实词：第五阶段做片段命名时就论证过（「不是就是B站嗯」不能剥成「就是B站嗯」）。
  // 这里同样**不**把它当停用词 —— 这个断言就是为了防止以后又有人顺手加进去。
  assert.strictEqual(isTermLike('不是'), true, '「不是」有实义，不能当停用词滤掉')
  assert.strictEqual(isTermLike('视频'), true)
  assert.strictEqual(isTermLike('人工智能'), true)
  // 直播间套话确实该滤（实测占高频词极大比例，且毫无主题意义）
  assert.strictEqual(isTermLike('灯牌'), false, '直播间套话要滤掉')
})

test('词频统计 + 打分：独有的词要压过全库高频词，且泛词被直接砍掉', () => {
  const texts = ['我们聊聊人工智能', '人工智能很有意思', '人工智能真不错']
  const counts = countTerms(texts)
  assert.ok((counts.get('人工智能') ?? 0) >= 3, '合并后的复合词应被统计到')

  // 「人工智能」只在 1 个文档里出现；「视频」在全部 10 个文档里出现
  const docCounts = new Map([
    ['人工智能', 1],
    ['视频', 10]
  ])
  const stats = scoreTerms(counts, docCounts, 10, 1)
  const ai = stats.find((s) => s.term === '人工智能')
  assert.ok(ai, '应打出「人工智能」的分')

  const withCommon = scoreTerms(
    new Map([
      ['人工智能', 3],
      ['视频', 3]
    ]),
    docCounts,
    10,
    1
  )
  const ai2 = withCommon.find((s) => s.term === '人工智能')!
  assert.ok(ai2.score > 0, '稀有词应拿到正分')

  // ⚠️ 覆盖率过滤：覆盖 10/10 个文档的词直接排除。
  // 这条是实测加的 —— 光靠 IDF 不够，「不是」「一个」「人」这类词
  // 即便覆盖 40% 语料也还能占据主题榜前列（实测前二十名一半是这种）。
  assert.strictEqual(
    withCommon.find((s) => s.term === '视频'),
    undefined,
    '覆盖全部文档的泛词应被直接砍掉，而不是只压低分数'
  )
})

test('语言过滤：非中文字幕的碎片不能成为主题', () => {
  // 实测：语料里混着外语字幕（外语视频 / 机翻轨），不过滤的话
  // `the` / `não` / `que` / `ない` / `la` 会挤进主题榜前二十
  for (const junk of ['the', 'não', 'que', 'de', 'ない', 'って', 'لا', 'في', 'of']) {
    assert.strictEqual(isTermLike(junk), false, `「${junk}」不该成为主题`)
  }
  // 夹着拉丁字母/数字的中文词是有效主题，必须保留
  for (const good of ['B站', 'UP主', '4K画质', '人工智能', '短视频']) {
    assert.strictEqual(isTermLike(good), true, `「${good}」应保留`)
  }

  /**
   * 取舍（有意为之）：**纯拉丁词一律不要**，哪怕它是英文实词。
   *
   * 判据是「必须含汉字」。这样做会顺带滤掉 `AI`、`Vue` 这类纯英文术语 ——
   * 但反过来放开「短拉丁词也收」，`the` / `of` / `que` 就会立刻回来
   * （实测它们正是靠"短"混进来的）。语料是中文 B站字幕，
   * 「宁可漏几个英文术语，也不要满屏外语碎片」是更划算的一边。
   * 需要找英文术语时，用全库检索比图谱主题更合适。
   */
  for (const latin of ['AI', 'video', 'the']) {
    assert.strictEqual(isTermLike(latin), false, `纯拉丁词「${latin}」按取舍一律不收`)
  }

  /**
   * 日语特有词要排除：日语**大量使用汉字**，所以「必须含汉字」拦不住它们。
   * 实测 `大丈夫` / `時間` / `自分` / `結構` / `配信` 都进了主题榜。
   * 判据是「整词等于常见日语词」而不是「识别语言」—— 中日共用汉字，没有可靠的语言判据。
   */
  for (const jp of ['大丈夫', '時間', '自分', '結構', '配信', '本当']) {
    assert.strictEqual(isTermLike(jp), false, `日语词「${jp}」不该成为主题`)
  }
})

test('词首助词不能当合并起点（避免「的薯条」这种碎片）', () => {
  // 实测问题：分词把「的」单独切出来后，二元组把它和后一个词黏在一起，
  // 主题榜上真的出现了 `的薯条`、`的棒棒糖`
  for (const bad of ['的薯条', '的棒棒糖', '了东西', '就我们', '也很']) {
    assert.strictEqual(isTermLike(bad), false, `「${bad}」不该成为主题（词首是助词/泛副词）`)
  }
  // 但只拦**词首**：「是」在「不是」里、助词在后面都是正常成分，不能误伤
  for (const good of ['不是', '好吃', '词典']) {
    assert.strictEqual(isTermLike(good), true, `「${good}」是正常词，不该被误伤`)
  }
})

test('打分：出现次数太少的不算主题（口误与分词碎片）', () => {
  const stats = scoreTerms(new Map([['只出现一次', 1], ['出现很多次', 10]]), new Map(), 10, 3)
  assert.deepStrictEqual(
    stats.map((s) => s.term),
    ['出现很多次'],
    '低于 minCount 的应被过滤'
  )
  assert.strictEqual(pickTopics(stats, 8).length, 1)
})

section('字幕抽取：观点句')

test('句子合并：按标点、时间间隔与长度断开', () => {
  const cues = [
    { index: 1, start: 0, end: 2, text: '然后我们就' },
    { index: 2, start: 2.2, end: 4, text: '把这个东西做出来。' },
    // 间隔 10 秒 → 应断开
    { index: 3, start: 14, end: 16, text: '另一段完全无关的话' }
  ]
  const sentences = mergeIntoSentences(cues, 1.5, 120)
  assert.strictEqual(sentences.length, 2, `应合并成 2 句，实际 ${sentences.length}`)
  assert.strictEqual(sentences[0].text, '然后我们就把这个东西做出来。', '前两条应合并')
  assert.strictEqual(sentences[0].index, 1, '合并后取第一条的序号')
  assert.strictEqual(sentences[1].index, 3)
})

test('句子合并：句末标点后立即断开', () => {
  const cues = [
    { index: 1, start: 0, end: 2, text: '第一句说完了。' },
    { index: 2, start: 2.1, end: 4, text: '第二句接着来。' }
  ]
  assert.strictEqual(mergeIntoSentences(cues, 5, 500).length, 2, '已以句号结尾就该断开')
})

test('句子合并：超长也要断开（避免合出一大段）', () => {
  const cues = Array.from({ length: 6 }, (_, i) => ({
    index: i + 1,
    start: i * 2,
    end: i * 2 + 2,
    text: '这是一句比较长的字幕内容用来把长度顶上去，'
  }))
  const sentences = mergeIntoSentences(cues, 5, 60)
  assert.ok(sentences.length >= 2, `超长应断开，实际合成 ${sentences.length} 句`)
})

test('观点句打分：命中主题词、长度适中的排前面，垃圾句被滤掉', () => {
  const sentences = [
    { index: 1, start: 0, end: 2, text: '嗯', score: 0 },
    { index: 2, start: 3, end: 8, text: '人工智能的关键在于数据质量与训练方法。', score: 0 },
    { index: 3, start: 9, end: 20, text: '哈哈哈哈哈', score: 0 }
  ]
  const ranked = scoreSentences(sentences, ['人工智能'], 0)
  assert.strictEqual(ranked[0].index, 2, '有主题词且完整的句子应排第一')

  // 短句与纯语气词拿到的是**负分**，在 minScore=0 下直接被滤掉 ——
  // 「不返回垃圾」比「把垃圾排在后面」更好：观点层是要给人看的。
  assert.ok(
    !ranked.some((s) => s.index === 1 || s.index === 3),
    `垃圾句应被滤掉而不是排在后面，实际返回：${ranked.map((s) => s.index).join(',')}`
  )

  // 放宽门槛时能看清排序与区分度
  const all = scoreSentences(sentences, ['人工智能'], -99)
  assert.strictEqual(all.length, 3, '放宽门槛后应全部返回')
  assert.strictEqual(all[0].index, 2)
  assert.ok(all[0].score > all[1].score, '好句与垃圾句之间要有区分度')
  assert.notStrictEqual(all[1].score, all[2].score, '两类垃圾句之间也应有区分度（不同分才有序）')
})

test('观点句打分：互动话术密度高的句子被压掉（实测第一屏全是寒暄）', () => {
  const sentences = [
    {
      index: 1,
      start: 0,
      end: 20,
      text: '下午好大家欢迎来到直播间谢谢米球的灯牌谢谢空叔哥哥投喂的望月神光谢谢大家的关注',
      score: 0
    },
    { index: 2, start: 21, end: 30, text: '这个项目的关键在于先想清楚目标用户是谁。', score: 0 },
    // 偶尔一个「谢谢」不该被罚：正常表达里也会出现
    { index: 3, start: 31, end: 40, text: '谢谢你提醒我，这个思路确实更清晰一些。', score: 0 }
  ]
  const ranked = scoreSentences(sentences, [], -99)
  const chatty = ranked.find((s) => s.index === 1)!
  const normal = ranked.find((s) => s.index === 2)!
  assert.ok(
    normal.score > chatty.score,
    `正常表达应排在寒暄前面（${normal.score} > ${chatty.score}）`
  )
  // 偶尔一个「谢谢」的句子罚得轻：仍应高于寒暄大杂烩
  const mild = ranked.find((s) => s.index === 3)!
  assert.ok(mild.score > chatty.score, '轻度命中不该被重罚')
})

test('文档级降权：整份都在寒暄时，连看着还行的句子也整体沉下去', () => {
  // 为什么需要：单句惩罚挡不住「寒暄被切成多条 40~60 字句子」的情况 ——
  // 每条单看密度都不高，于是一条条全溜过去（实测观点第一屏全是这种）。
  // 按整份文档的互动占比降权，才能让这类视频的观点层**诚实地空着**。
  const greetings = [
    { index: 1, start: 0, end: 20, text: '下午好大家欢迎来到直播间今天感觉还不错'.repeat(1), score: 0 },
    { index: 2, start: 21, end: 40, text: '谢谢米球的灯牌谢谢大家的关注和点赞'.repeat(1), score: 0 },
    { index: 3, start: 41, end: 60, text: '欢迎新来的朋友谢谢你们的粉丝团灯牌'.repeat(1), score: 0 },
    // 一条看起来还算正常的句子，但整场都在寒暄，它也不该拿高分
    { index: 4, start: 61, end: 80, text: '我们今天要聊的是怎么把长视频剪成短视频。', score: 0 }
  ]
  assert.ok(chattyRatio(greetings) >= 0.5, `寒暄占比应被识别为高，实际 ${chattyRatio(greetings)}`)

  const ranked = scoreSentences(greetings, [], -99)
  const normal = ranked.find((s) => s.index === 4)!
  const greeting = ranked.find((s) => s.index === 2)!
  assert.ok(normal.score > greeting.score, '正常情况下，像样的句子仍应排前面')
  // 关键：整场寒暄时，连这条「像样」的句子也被降权（否则它会以绝对高分霸榜）
  const soloScore = scoreSentences([greetings[3]], [], -99)[0].score
  assert.ok(
    normal.score < soloScore,
    `同一句话在寒暄为主的视频里应被降权（${normal.score} < 独立打分 ${soloScore}）`
  )

  // 反例：不寒暄的文档不该被降权
  const clean = [
    { index: 1, start: 0, end: 10, text: '这个项目的关键在于先想清楚目标用户是谁。', score: 0 },
    { index: 2, start: 11, end: 20, text: '数据质量决定了最终效果的上限。', score: 0 }
  ]
  assert.strictEqual(chattyRatio(clean), 0, '正常文档的寒暄占比应为 0')
})

test('主题集中度：讲具体事的文档命中主题的比例更高', () => {
  // 依据：文档在讲具体东西时，句子会反复落在同一批词上；闲聊则天南海北
  const focused = [
    { index: 1, start: 0, end: 10, text: '短视频剪辑的第一步是找素材。', score: 0 },
    { index: 2, start: 11, end: 20, text: '短视频剪辑还要注意节奏。', score: 0 },
    { index: 3, start: 21, end: 30, text: '所以短视频剪辑很难一次做完美。', score: 0 }
  ]
  const scattered = [
    { index: 1, start: 0, end: 10, text: '今天天气不错我吃了碗面。', score: 0 },
    { index: 2, start: 11, end: 20, text: '楼下那只猫又跑来蹭我。', score: 0 },
    { index: 3, start: 21, end: 30, text: '话说你昨天看那部电影了吗。', score: 0 }
  ]
  assert.strictEqual(topicFocusRatio(focused, ['短视频剪辑']), 1, '聚焦文档应全部命中')
  assert.strictEqual(topicFocusRatio(scattered, ['短视频剪辑']), 0, '发散文档应一条都不命中')
  assert.strictEqual(topicFocusRatio(focused, []), 0, '没有主题词时给 0 而不是 NaN')

  // 两个文档级信号取较重者而不是相加：否则「既闲聊又发散」会被罚到连好句子都成负分
  const both = scoreSentences(
    [
      { index: 1, start: 0, end: 20, text: '谢谢大家的灯牌谢谢欢迎来到直播间', score: 0 },
      { index: 2, start: 21, end: 40, text: '这个方案的关键是先把数据清洗干净。', score: 0 }
    ],
    [],
    -99
  )
  const good = both.find((s) => s.index === 2)!
  assert.ok(good.score > -6, `文档级惩罚应取较重者而不是叠加，实际 ${good.score}`)
})

/* ------------------------- 剪辑文案模板（第八阶段·模板系统） ------------------------- */
section('剪辑文案模板')

test('文案模板：普通占位符替换，未知占位符原样保留', () => {
  const out = renderCopyTemplate('{title} ｜ {bvid}', { title: '某视频', bvid: 'BV1xx411c7mD' })
  assert.strictEqual(out, '某视频 ｜ BV1xx411c7mD')

  // 与命名模板同一取舍：拼错的占位符要留着（而不是悄悄变空）
  const typo = renderCopyTemplate('{titel}', { title: '某视频' })
  assert.strictEqual(typo, '{titel}', '未知占位符必须原样保留，否则用户看不出自己拼错了')
})

test('文案模板：列表占位符按行展开', () => {
  const out = renderCopyTemplate('本期内容：\n{@list:outline}\n结束', {
    outline: ['1. 开场', '2. 正题', '3. 收尾']
  })
  assert.strictEqual(out, '本期内容：\n1. 开场\n2. 正题\n3. 收尾\n结束')

  // 列表占位符**先**处理：否则普通 {x} 规则会先吃掉一部分，导致展开次数不对
  const tricky = renderCopyTemplate('{@list:items}{items}', { items: ['A', 'B'] })
  assert.strictEqual(tricky, 'A\nBA、B'.replace('BA、B', 'B' + 'A、B'), '列表先展开，普通占位符再替换')
})

test('文案模板：标签占位符去重井号、空值不留痕', () => {
  assert.strictEqual(renderCopyTemplate('{#tag}', { tag: ['人工智能', '#剪辑'] }), '#人工智能 #剪辑')
  assert.strictEqual(
    renderCopyTemplate('{#tag}', { tag: '人工智能, 剪辑、#短片' }),
    '#人工智能 #剪辑 #短片',
    '字符串也要支持（逗号/顿号分隔）'
  )
  // 没有标签时整行应干净地消失，而不是留下 `{#tag}`
  assert.strictEqual(renderCopyTemplate('正文\n{#tag}', {}), '正文')
  assert.strictEqual(renderCopyTemplate('{#tag}', { tag: [] }), '')
})

test('文案模板：清理空占位符留下的行尾空白与多余空行', () => {
  const out = renderCopyTemplate('标题\n{missing}   \n\n\n\n正文', {})
  assert.ok(!/[ \t]+\n/.test(out), '不应留下行尾空白')
  assert.ok(!/\n{3,}/.test(out), '连续空行应压缩，避免文案里出现大片空白')
})

test('文案模板：提取占位符（含列表与标签写法），按出现顺序去重', () => {
  const tokens = extractTokens('{title}\n{topic}\n{@list:outline}\n{#tag}\n{title}')
  assert.deepStrictEqual(tokens, ['title', 'topic', 'outline', 'tag'], '应去重且保持顺序')
  assert.deepStrictEqual(extractTokens('没有占位符'), [])
})

test('文案模板：内置模板本身必须渲染得出来（不能有写错的占位符）', () => {
  // 内置模板是用户的第一参照，写错了会直接误导人 —— 用一份「什么都填上」的上下文过一遍
  const ctx = {
    title: '标题',
    hook: '开场',
    summary: '简介',
    topic: '主题',
    episode: 3,
    clipCount: 2,
    outline: ['一', '二'],
    uploader: 'UP主',
    bvid: 'BV1xx411c7mD',
    duration: '1m02s',
    start: '00-00-01',
    end: '00-01-03',
    note: '备注',
    tag: ['人工智能']
  }
  for (const tpl of BUILTIN_TEMPLATES) {
    const out = renderCopyTemplate(tpl.body, ctx)
    assert.ok(out.length > 0, `内置模板「${tpl.name}」渲染结果不能为空`)
    assert.ok(!/\{\w+\}/.test(out), `内置模板「${tpl.name}」不该留下未替换的占位符：${out}`)
    assert.ok(!/\{@list|\{#/.test(out), `列表/标签写法应已展开：${out}`)
  }
})

test('文案模板：内置模板的三处定义必须一致（渲染层 / 建表种子 / 文档）', () => {
  // 内置模板在 `@shared/copyTemplate` 与 `main/db.ts` 的种子数据里各有一份
  // （避免建表逻辑依赖渲染逻辑），所以必须断言两处不漂移 ——
  // 否则会出现「设置里看到的模板」和「首次运行灌进去的模板」不一样。
  // 测试跑在项目根目录（npm script 的 cwd），用相对路径读源码即可
  const dbSource = readFileSync('src/main/db.ts', 'utf8')
  for (const tpl of BUILTIN_TEMPLATES) {
    assert.ok(
      dbSource.includes(`id: '${tpl.id}'`),
      `种子数据里应包含内置模板 ${tpl.id}`
    )
    assert.ok(
      dbSource.includes(`name: '${tpl.name}'`),
      `种子数据里的模板名应与渲染层一致：${tpl.name}`
    )
  }
  assert.strictEqual(
    (dbSource.match(/id: '(shortvideo|collection|clipnote)'/g) ?? []).length,
    BUILTIN_TEMPLATES.length,
    '种子模板数量应与内置模板数量一致'
  )
})

/* ------------------------- 发布素材包（第九阶段） ------------------------- */
section('发布素材包')

const kitClips: KitClip[] = [
  {
    order: 1,
    name: '开场白',
    bvid: 'BV1xx411c7mD',
    page: 1,
    start: 5,
    end: 65,
    videoTitle: '某场直播回放',
    note: '开场白',
    subtitle: '大家好，今天聊聊短视频'
  },
  {
    order: 2,
    name: '核心观点',
    bvid: 'BV1xx411c7mD',
    page: 2,
    start: 3725,
    end: 3845,
    videoTitle: '某场直播回放',
    note: '核心观点',
    subtitle: '剪辑的关键是节奏'
  }
]

const kitInput: KitInput = {
  title: '短视频剪辑的三个关键',
  description: '本期聊聊剪辑节奏。',
  tags: ['#人工智能', '剪辑'],
  totalDuration: 120,
  clips: kitClips,
  generatedAt: 1760000000000,
  source: '某UP主 · BV1xx411c7mD'
}

test('素材包：时间格式与文件夹名清理', () => {
  assert.strictEqual(hms(0), '00:00:00')
  assert.strictEqual(hms(65), '00:01:05')
  assert.strictEqual(hms(3725), '01:02:05')
  assert.strictEqual(hms(-5), '00:00:00', '负数按 0 处理，不该出 -00:00:05')

  // 文件夹名要比切片产物名更严：# 在文件名里合法，但作为文件夹名很别扭
  assert.strictEqual(safeKitName('a/b:c*d?e"f<g>h|i#j'), 'a b c d e f g h i j')
  assert.strictEqual(safeKitName('   '), '发布素材包', '空名给兜底')
  assert.strictEqual(safeKitName('...'), '发布素材包', '只有点号也给兜底（避免生成隐藏/非法名）')
  assert.ok(safeKitName('x'.repeat(200)).length <= 80, '过长要截断')
})

test('素材包：分镜表按中文宽度对齐（Markdown 表格不能歪）', () => {
  const rows = buildStoryboard(kitClips)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].time, '00:00:05 → 00:01:05')
  assert.strictEqual(rows[1].time, '01:02:05 → 01:04:05')
  assert.ok(rows[1].source.includes('P2'), '跨分P 要标出来')

  const table = renderStoryboardTable(rows)
  const lines = table.split('\n')
  assert.strictEqual(lines.length, 4, '表头 + 分隔 + 两行数据')
  // 每行的可视宽度必须一致 —— 否则 Markdown 渲染出来是歪的
  const dispWidth = (s: string): number =>
    [...s].reduce((n, ch) => n + (/[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0)
  const widths = lines.map((l) => dispWidth(l))
  assert.strictEqual(new Set(widths).size, 1, `各行宽度应一致，实际：${widths.join(',')}`)

  assert.strictEqual(renderStoryboardTable([]), '_（没有片段）_', '空列表给明确占位')
})

test('素材包：README 含文案 / 标签 / 分镜 / 明细，且标签去重井号', () => {
  const readme = renderKitReadme(kitInput)
  assert.ok(readme.startsWith('# 短视频剪辑的三个关键'), '标题在第一行')
  assert.ok(readme.includes('本期聊聊剪辑节奏。'), '应含简介')
  assert.ok(readme.includes('#人工智能 #剪辑'), '标签要统一带 #，且不出现 ##')
  assert.ok(readme.includes('## 分镜表'), '应含分镜表')
  assert.ok(readme.includes('01:02:05'), '应含原片时间（而不是成片内时间）')
  assert.ok(readme.includes('**字幕稿**'), '应含字幕稿')
  assert.ok(readme.includes('P2'), '跨分P 要标出')
  assert.ok(!/\n{3,}/.test(readme), '不应出现连续空行')
})

test('素材包：缺内容时不出现空白章节', () => {
  const bare = renderKitReadme({ ...kitInput, description: '   ', tags: [], source: undefined })
  assert.ok(!bare.includes('## 发布文案'), '没简介就不该出现「发布文案」标题')
  assert.ok(!bare.includes('## 话题标签'), '没标签就不该出现「话题标签」标题')
  assert.ok(bare.includes('## 分镜表'), '分镜表始终要有')
})

test('素材包：CSV 转义正确（备注里有逗号与引号也不能串列）', () => {
  const csv = renderClipCsv([
    { ...kitClips[0], name: '他说"这个,很重要"' }
  ])
  const lines = csv.trim().split('\n')
  assert.strictEqual(lines.length, 2)
  // 双引号要翻倍，整个字段用引号包住 —— 否则 Excel 会把一列拆成两列
  assert.ok(lines[1].includes('"他说""这个,很重要"""'), `实际：${lines[1]}`)
  assert.strictEqual(lines[1].split('","').length, 6, '应保持 6 列')
})

test('素材包：文件清单完整，字幕稿一片段一文件，空字幕不产生空文件', () => {
  const { folder, files } = buildPublishKit(kitInput)
  assert.strictEqual(folder, '短视频剪辑的三个关键')
  const paths = files.map((f) => f.path)
  for (const need of ['README.md', '标题.txt', '简介.txt', '标签.txt', '切片清单.csv']) {
    assert.ok(paths.includes(need), `应包含 ${need}`)
  }
  assert.strictEqual(
    files.filter((f) => f.path.startsWith('字幕稿/')).length,
    2,
    '两条片段都有字幕，应各出一个文件'
  )

  // 没有字幕的片段不该生成空文件（否则包里一堆空 txt）
  const noSub = buildPublishKit({
    ...kitInput,
    clips: [{ ...kitClips[0], subtitle: '  ' }]
  })
  assert.strictEqual(
    noSub.files.filter((f) => f.path.startsWith('字幕稿/')).length,
    0,
    '空字幕不该产生空文件'
  )

  // 标签为空时标签.txt 也要有内容说明，而不是空文件
  const noTags = buildPublishKit({ ...kitInput, tags: [] })
  assert.strictEqual(noTags.files.find((f) => f.path === '标签.txt')!.content.trim(), '（未填写）')
})

test('文案模板：渲染结果切分成标题 / 正文 / 标签（带到素材包用）', () => {
  const fields = splitForPublish(
    '短视频剪辑的三个关键\n\n本期聊聊节奏。\n\n#人工智能 #剪辑'
  )
  assert.strictEqual(fields.title, '短视频剪辑的三个关键', '第一行当标题')
  assert.ok(fields.description.includes('本期聊聊节奏。'), '其余当正文')
  assert.ok(!fields.description.includes('短视频剪辑的三个关键'), '标题不该重复出现在正文里')
  assert.strictEqual(fields.tagText, '人工智能 剪辑', '标签取出来且不带 #')

  // 第一行过长时不可能是标题（B站会截断）→ 整段算正文、标题留空，交给用户决定
  const long = '这是一句特别长的开场白'.repeat(6)
  const longFields = splitForPublish(`${long}\n\n正文`)
  assert.strictEqual(longFields.title, '', '过长时不该硬塞成标题')
  assert.ok(longFields.description.startsWith(long), '整段都算正文')

  // 空输入
  assert.deepStrictEqual(splitForPublish(''), { title: '', description: '', tagText: '' })
  assert.deepStrictEqual(splitForPublish('   \n  '), { title: '', description: '', tagText: '' })

  // 标签与别的文字同处一行也要能捞出来（按行取会漏）
  const sameLine = splitForPublish('标题\n正文里有 #话题 混在中间')
  assert.strictEqual(sameLine.tagText, '话题', '同行内的 #标签 也要捞出来')

  // 只有一行且不长：当标题，正文为空
  const only = splitForPublish('就一行标题')
  assert.strictEqual(only.title, '就一行标题')
  assert.strictEqual(only.description, '')

  /**
   * 纯标签行要从正文里去掉。
   *
   * 实测问题：带过去之后正文末尾挂着 `#人工智能 #剪辑`，
   * 而标签已经单独提到 tagText —— 用户看到的就是重复内容。
   */
  const withTagLine = splitForPublish('标题\n\n正文内容\n\n#人工智能 #剪辑')
  assert.strictEqual(withTagLine.tagText, '人工智能 剪辑')
  assert.strictEqual(withTagLine.description, '正文内容', '纯标签行不该留在正文里')

  // 但正文里正常引用的 #话题 不能删（只删「整行除了标签没别的」的行）
  const inline = splitForPublish('标题\n\n这里提到 #话题 但还有别的文字')
  assert.ok(inline.description.includes('#话题'), '正文内引用的标签要保留')
  assert.ok(inline.description.includes('还有别的文字'))
})

test('文案模板：内置模板渲染后都能切出非空标题（切分规则与实际模板匹配）', () => {
  const ctx = {
    title: '短视频剪辑的三个关键',
    hook: '开场一句',
    summary: '内容简介',
    topic: '主题',
    episode: 3,
    clipCount: 2,
    outline: ['一', '二'],
    uploader: 'UP主',
    bvid: 'BV1xx411c7mD',
    duration: '1m02s',
    start: '00-00-01',
    end: '00-01-03',
    note: '备注',
    tag: ['人工智能']
  }
  for (const tpl of BUILTIN_TEMPLATES) {
    const fields = splitForPublish(renderCopyTemplate(tpl.body, ctx))
    assert.ok(
      fields.title.length > 0,
      `内置模板「${tpl.name}」渲染后应能切出标题，实际 title="${fields.title}"`
    )
  }
})

/* ------------------------- 视频标题规范化（第九阶段） ------------------------- */
section('视频标题规范化')

test('标题规范化：目标格式是「日期 UP主 内容」', () => {
  // 用户定的格式：日期在前，UP主 名保留在中间，内容在后
  assert.strictEqual(
    normalizeVideoTitle('【弥雾meow】元气杂谈 2026年10月15日19点场', { uploaderName: '弥雾meow' }),
    '2026年10月15日19点场 弥雾meow 元气杂谈'
  )
  // 没有 UP主 名（如平台分类开头的标题）时，中间那一格直接省略，不留多余空格
  assert.strictEqual(
    normalizeVideoTitle('【直播回放】幸运流铸剑大师 2026年10月14日19点场'),
    '2026年10月14日19点场 幸运流铸剑大师'
  )
})

test('标题规范化：平台标签丢弃、内容标签保留', () => {
  // 「直播回放」是平台分类（丢弃），「生日会后日谈」是这一场的真正标题（保留）
  assert.strictEqual(
    normalizeVideoTitle('【直播回放】【生日会后日谈】 2026年08月16日12点场', {
      uploaderName: '弥雾meow'
    }),
    '2026年08月16日12点场 生日会后日谈'
  )
  // 【杂谈】不在平台名单里 → 当内容保留（名单只认整段相等，不靠"看起来短"）
  assert.strictEqual(
    normalizeVideoTitle('【杂谈】2026年10月15日19点场', { uploaderName: '某人' }),
    '2026年10月15日19点场 杂谈'
  )
})

test('标题规范化：括号里的 UP主 名不会被当成内容重复一次', () => {
  // 典型：括号只有 UP主 名，日期之外没有内容 → 结果就是「日期 UP主」
  assert.strictEqual(
    normalizeVideoTitle('【弥雾meow】 2026年10月15日19点场', { uploaderName: '弥雾meow' }),
    '2026年10月15日19点场 弥雾meow'
  )
})

test('标题规范化：解析不出日期就原样返回，不硬剥前缀', () => {
  // 硬剥会得到「新手教程」，看起来干净了，但用户可能正是靠 UP主 名区分同名教程的。
  // 不确定就不要改 —— 这类「更整洁但丢信息」的改动比不改更糟。
  assert.strictEqual(normalizeVideoTitle('【某某】新手教程', { uploaderName: '某某' }), '【某某】新手教程')
  assert.strictEqual(normalizeVideoTitle('没有日期的标题'), '没有日期的标题')
  assert.strictEqual(normalizeVideoTitle(''), '')
})

test('标题规范化：日期与时刻之间不能被粘起来', () => {
  // 踩过的坑：把所有空白删掉会把 `2026-10-15 19:00` 变成 `2026-10-1519:00`
  assert.strictEqual(
    normalizeVideoTitle('【A-SOUL】录播 2026-10-15 19:00', { uploaderName: 'A-SOUL' }),
    // 注意：这里的「录播」在**正文**里（不在括号内），而平台标签名单只作用于括号内容，
    // 所以它会作为内容保留 —— 名单故意不碰正文，避免误删真实标题词
    '2026-10-15 19:00 A-SOUL 录播'
  )
})

test('标题规范化：幂等（可以安全地在读边界反复调用）', () => {
  const cases: Array<[string, string]> = [
    ['【弥雾meow】元气杂谈 2026年10月15日19点场', '弥雾meow'],
    ['2026年10月15日19点场 弥雾meow 元气杂谈', '弥雾meow'],
    ['【直播回放】【生日会后日谈】 2026年08月16日12点场', '弥雾meow'],
    ['【某某】新手教程', '某某']
  ]
  for (const [c, up] of cases) {
    const once = normalizeVideoTitle(c, { uploaderName: up })
    assert.strictEqual(
      normalizeVideoTitle(once, { uploaderName: up }),
      once,
      `「${c}」应幂等，实际二次结果变了`
    )
  }
})

test('标题规范化：不留下连续空格', () => {
  for (const t of [
    '【弥雾meow】 2026年10月15日19点场',
    '【直播回放】 2026年10月15日',
    '【x】标题 2026年10月15日'
  ]) {
    const out = normalizeVideoTitle(t)
    assert.ok(!out.includes('  '), `「${t}」规范化后不该有连续空格，实际：${out}`)
    assert.strictEqual(out.trim(), out, '首尾也不该有空白')
  }
})

test('标题规范化：批量统计（用于评估改动影响面）', () => {
  const stat = normalizeTitles([
    '【弥雾meow】元气杂谈 2026年10月15日19点场',
    '没有日期的标题'
  ])
  assert.strictEqual(stat.changed, 1)
  assert.strictEqual(stat.samples.length, 1)
  assert.strictEqual(stat.missed.length, 1, '没识别的要单独列出来，便于人工核对')
})

test('标题规范化：投稿账号名与频道名不同时，两个都要认（实测的真实情况）', () => {
  // 本机真实数据：投稿账号是「恩仙仙」，合集/频道叫「弥雾meow」，
  // 而标题括号里写的是频道名。只比对账号名会认不出署名 →
  // 结果它被当正文留在末尾，位置就错了（实测得到过 `… 哑巴着急 弥雾meow`）。
  assert.strictEqual(
    normalizeVideoTitle('【弥雾meow】哑巴着急 2026年10月13日19点场', {
      uploaderName: '恩仙仙',
      collectionName: '弥雾meow'
    }),
    '2026年10月13日19点场 弥雾meow 哑巴着急'
  )
  // 合集名常见带后缀的情况（「弥雾meow的直播间」）也要能前缀命中
  assert.strictEqual(
    normalizeVideoTitle('【弥雾meow的直播间】晚安 2026年10月13日19点场', {
      uploaderName: '恩仙仙',
      collectionName: '弥雾meow'
    }),
    '2026年10月13日19点场 弥雾meow的直播间 晚安'
  )
})

test('方括号分类：UP主 / 平台标签 / 内容 三分类', () => {
  assert.strictEqual(classifyBracket('弥雾meow', '弥雾meow'), 'uploader')
  assert.strictEqual(classifyBracket('弥雾meow', '恩仙仙', '弥雾meow'), 'uploader', '频道名也要认')
  assert.strictEqual(classifyBracket('弥雾meow', '另一个UP主'), 'content', '对不上就当内容')
  assert.strictEqual(classifyBracket('直播回放', '弥雾meow'), 'platform')
  assert.strictEqual(classifyBracket('录播', ''), 'platform')
  assert.strictEqual(classifyBracket('生日会后日谈', '弥雾meow'), 'content')
  assert.strictEqual(classifyBracket('', '弥雾meow'), 'platform', '空括号没有信息')
  assert.ok(listPlatformLabels().includes('直播回放'), '名单要能被读出来（便于文档/界面展示）')
})

/* ------------------------------ AI 提示词与解析（第六阶段） ------------------------------ */
section('AI 提示词与解析')

test('摘要提示词包含标题与字幕，并要求不要寒暄', () => {
  const p = buildSummaryPrompt('某场直播', '今天聊了聊怎么做短视频')
  assert.ok(p.user.includes('某场直播'), '应带上标题')
  assert.ok(p.user.includes('今天聊了聊怎么做短视频'), '应带上字幕内容')
  assert.ok(p.system.includes('不要'), '系统提示应明确「不要寒暄」')
})

test('超长字幕会被裁剪（头尾都留，中间省略）', () => {
  const long = `开头内容${'中间'.repeat(5000)}结尾内容`
  const p = buildSummaryPrompt('t', long)
  assert.ok(p.user.includes('开头内容'), '应保留开头')
  assert.ok(p.user.includes('结尾内容'), '应保留结尾')
  assert.ok(p.user.includes('中间省略'), '应有省略标记')
  assert.ok(p.user.length < long.length, '裁剪后应更短')
})

test('标签提示词要求输出 JSON 并限定标签长度', () => {
  const p = buildTagsPrompt('t', '文本')
  assert.ok(p.user.includes('JSON'), '应说明 JSON 格式')
  assert.ok(p.user.includes('2~6'), '应限定标签长度')
})

test('标题提示词要求只输出标题', () => {
  const p = buildTitlePrompt('文本')
  assert.ok(p.system.includes('只输出'), '系统提示应要求只输出标题')
})

test('解析标签建议：标准 JSON', () => {
  const out = parseTagSuggestions('{"tags":[{"name":"人工智能","reason":"聊了大模型"}]}')
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].name, '人工智能')
  assert.strictEqual(out[0].reason, '聊了大模型')
})

test('解析标签建议：带代码围栏 / 前后有废话 / 字段名不同', () => {
  const fenced = parseTagSuggestions('```json\n{"tags":[{"name":"A","reason":"r"}]}\n```')
  assert.strictEqual(fenced[0].name, 'A', '应能处理代码围栏')

  const chatty = parseTagSuggestions('好的，结果如下：{"tags":[{"name":"B","reason":"r"}]} 以上。')
  assert.strictEqual(chatty[0].name, 'B', '应能从废话里截出 JSON')

  const alias = parseTagSuggestions('{"tags":[{"tag":"C","why":"因为"}]}')
  assert.strictEqual(alias[0].name, 'C', '应兼容 tag/why 这类字段名')

  const plainArray = parseTagSuggestions('["D","E"]')
  assert.deepStrictEqual(
    plainArray.map((t) => t.name),
    ['D', 'E'],
    '应兼容「直接给数组」'
  )
})

test('解析标签建议：完全无法解析时返回空数组而不是抛错', () => {
  assert.deepStrictEqual(parseTagSuggestions('这不是 JSON'), [])
  assert.deepStrictEqual(parseTagSuggestions('{"tags":[]}'), [])
  assert.deepStrictEqual(parseTagSuggestions(''), [])
})

test('诊断包脱敏覆盖 AI 的 API Key', () => {
  const settings: AppSettings = { ...baseSettings(), aiOpenaiKey: 'sk-secret-should-not-leak' }
  const redacted = redactSettings(settings)
  const key = String(redacted.aiOpenaiKey)
  assert.ok(key.includes('已配置'), '应说明已配置')
  assert.ok(!key.includes('sk-secret'), '字段里不能出现 Key 内容')
  assert.ok(
    !JSON.stringify(redacted).includes('sk-secret-should-not-leak'),
    '整份脱敏结果里都不该有 Key'
  )
})


test('优先用第一条有信息量的字幕当名字', () => {
  const title = generateClipTitle({
    cues: [{ text: 'AI改变软件开发' }, { text: '后面还有别的' }],
    videoTitle: '某场直播',
    index: 1
  })
  assert.strictEqual(title, 'AI改变软件开发')
})
test('语气词 / 空文本会被跳过，继续往后找', () => {
  const title = generateClipTitle({
    cues: [{ text: '嗯' }, { text: '   ' }, { text: '。。。' }, { text: '今天讲讲剪辑' }],
    videoTitle: '某场直播',
    index: 2
  })
  assert.strictEqual(title, '今天讲讲剪辑')
})

test('开头的语气词会被剥掉', () => {
  // 「诶」是语气词，剥掉；「不是」是实词（否定），不能剥 —— 剥了就改变了语义
  assert.strictEqual(
    generateClipTitle({ cues: [{ text: '诶我真的很喜欢那个眼神' }], videoTitle: 'x', index: 1 }),
    '我真的很喜欢那个眼神'
  )
  assert.strictEqual(
    generateClipTitle({ cues: [{ text: '不是就是B站嗯' }], videoTitle: 'x', index: 1 }),
    '不是就是B站嗯',
    '「不是」是实词，不该被当成语气词剥掉'
  )
  assert.strictEqual(
    generateClipTitle({ cues: [{ text: '我打游戏又不开麦' }], videoTitle: 'x', index: 1 }),
    '我打游戏又不开麦'
  )
  // 「哦对了」剥完只剩「对了」，不够当名字 → 往后找下一条
  assert.strictEqual(
    generateClipTitle({
      cues: [{ text: '哦对了' }, { text: '诶我真的很喜欢那个眼神' }],
      videoTitle: 'x',
      index: 1
    }),
    '我真的很喜欢那个眼神'
  )
})

test('剥完语气词只剩一个字时不算合格名字', () => {
  // 「嗯对」剥掉「嗯」剩「对」（单字）→ 不合格；应回退到视频标题
  const title = generateClipTitle({ cues: [{ text: '嗯对' }], videoTitle: '某场直播', index: 2 })
  assert.ok(title.startsWith('某场直播'), `应回退到视频标题，实际 ${title}`)
})

test('全是没有信息量的内容时回退到「视频标题 + 序号」', () => {
  const title = generateClipTitle({
    cues: [{ text: '啊' }, { text: '' }],
    videoTitle: '某场直播',
    index: 3
  })
  assert.ok(title.startsWith('某场直播'), `应回退到视频标题，实际 ${title}`)
  assert.ok(title.includes('3'), '应带上序号')
})

test('生成的名字可以直接当文件名（非法字符与 Windows 保留名都被净化）', () => {
  const title = generateClipTitle({
    cues: [{ text: '标题里有 a/b\\c:d*e?f 这些字符' }],
    videoTitle: 'x',
    index: 1
  })
  assert.ok(!/[<>:"/\\|?*]/.test(title), `不该残留非法字符：${title}`)
  // 极端情况：字幕正好是保留名
  const reserved = generateClipTitle({
    cues: [{ text: 'CON' }],
    videoTitle: 'x',
    index: 1
  })
  assert.strictEqual(reserved, '_CON', 'Windows 保留名要加前缀')
})

test('名字会被截断（避免超长文件名）', () => {
  const long = '很长'.repeat(200)
  const title = generateClipTitle({ cues: [{ text: long }], videoTitle: 'x', index: 1, maxLength: 20 })
  assert.ok(title.length <= 20, `应截断到 20 字以内，实际 ${title.length}`)
})

test('AI 命名接口位当前返回 null（第六阶段接上后由调用方回退规则结果）', async () => {
  const result = await generateAiTitle({ cues: [{ text: 'x' }], videoTitle: 'y', index: 1 }, null)
  assert.strictEqual(result, null)
})

/* -------------------------------- 时间工具 -------------------------------- */
section('时间工具')

test('formatTime 秒 → HH:MM:SS', () => {
  assert.strictEqual(formatTime(0), '00:00:00')
  assert.strictEqual(formatTime(80), '00:01:20')
  assert.strictEqual(formatTime(3725), '01:02:05')
  assert.strictEqual(formatTime(359999), '99:59:59')
})

test('formatTime 带毫秒', () => {
  assert.strictEqual(formatTime(80.5, true), '00:01:20,500')
  assert.strictEqual(formatTime(1.007, true), '00:00:01,007')
})

test('formatTime 处理非法输入', () => {
  assert.strictEqual(formatTime(NaN), '00:00:00')
  assert.strictEqual(formatTime(-5), '00:00:00')
})

test('parseTime 各类写法', () => {
  assert.strictEqual(parseTime('00:01:20,000'), 80)
  assert.strictEqual(parseTime('00:01:20.000'), 80)
  assert.strictEqual(parseTime('1:20'), 80)
  assert.strictEqual(parseTime('01:20'), 80)
  assert.strictEqual(parseTime('83.5'), 83.5)
  assert.strictEqual(parseTime('1分30秒'), 90)
  assert.strictEqual(parseTime('1时2分3秒'), 3723)
})

test('parseTime 非法输入返回 NaN', () => {
  assert.ok(Number.isNaN(parseTime('abc')))
  assert.ok(Number.isNaN(parseTime('')))
})

/* --------------------------------- SRT ---------------------------------- */
section('SRT 解析')

test('标准 SRT 解析', () => {
  const src = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    '你好世界',
    '',
    '2',
    '00:00:04,000 --> 00:00:06,000',
    '第二句',
    ''
  ].join('\n')
  const { cues, warnings } = parseSrt(src)
  assert.strictEqual(cues.length, 2)
  assert.strictEqual(warnings.length, 0)
  assert.strictEqual(cues[0].index, 1)
  assert.strictEqual(cues[0].start, 1)
  assert.strictEqual(cues[0].end, 3.5)
  assert.strictEqual(cues[0].text, '你好世界')
  assert.strictEqual(cues[1].start, 4)
})

test('CRLF 与 BOM', () => {
  const src = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n测试\r\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues.length, 1)
  assert.strictEqual(cues[0].text, '测试')
})

test('缺少序号仍能解析', () => {
  const src = '00:00:01,000 --> 00:00:02,000\n无序号字幕\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues.length, 1)
  assert.strictEqual(cues[0].index, 1)
  assert.strictEqual(cues[0].text, '无序号字幕')
})

test('时间轴带坐标后缀', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000 X1:100 X2:200\n带坐标\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues.length, 1)
  assert.strictEqual(cues[0].end, 2)
})

test('多行正文与样式标签清理', () => {
  const src = '1\n00:00:01,000 --> 00:00:02,000\n<i>斜体</i>\n第二行\n'
  const { cues } = parseSrt(src)
  assert.strictEqual(cues[0].text, '斜体\n第二行')
})

test('序号自动重新编号', () => {
  const src = [
    '7',
    '00:00:01,000 --> 00:00:02,000',
    'A',
    '',
    '3',
    '00:00:03,000 --> 00:00:04,000',
    'B',
    ''
  ].join('\n')
  const { cues } = parseSrt(src)
  assert.deepStrictEqual(
    cues.map((c) => c.index),
    [1, 2]
  )
})

test('无法识别的时间轴产生告警', () => {
  const { cues, warnings } = parseSrt('1\nbad --> worse\n内容\n\n2\n00:00:01,000 --> 00:00:02,000\n好的\n')
  assert.strictEqual(cues.length, 1)
  assert.ok(warnings.length >= 1)
})

test('空内容不崩溃', () => {
  const { cues } = parseSrt('')
  assert.strictEqual(cues.length, 0)
})

test('toSrt 往返一致', () => {
  const cues = [cue(1, 1, 3.5, '你好'), cue(2, 4, 6, '世界\n换行')]
  const { cues: back } = parseSrt(toSrt(cues))
  assert.strictEqual(back.length, 2)
  assert.strictEqual(back[0].start, 1)
  assert.strictEqual(back[1].text, '世界\n换行')
})

test('decodeBuffer 识别 UTF-8 BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好', 'utf8')])
  const { text, encoding } = decodeBuffer(buf)
  assert.strictEqual(encoding, 'utf-8-bom')
  assert.strictEqual(text, '你好')
})

test('decodeBuffer 识别 GBK', () => {
  // 「你好」的 GBK 编码
  const buf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
  const { text, encoding } = decodeBuffer(buf)
  assert.strictEqual(text, '你好')
  assert.strictEqual(encoding, 'gbk')
})

test('B站字幕 json 转换', () => {
  const cues = biliSubtitleToCues({
    body: [
      { from: 1.2, to: 3.4, content: '句子一' },
      { from: 3.5, to: 4.0, content: '  ' },
      { from: 5.0, to: 6.0, content: '句子二' }
    ]
  })
  assert.strictEqual(cues.length, 2)
  assert.strictEqual(cues[0].start, 1.2)
  assert.strictEqual(cues[1].text, '句子二')
  assert.strictEqual(cues[1].index, 2)
})

/* ------------------------------ 时间坐标生成 ------------------------------ */
section('时间坐标生成')

test('连续字幕合并为一段', () => {
  const cues = [cue(1, 0, 2), cue(2, 2, 4), cue(3, 4, 6), cue(4, 8, 10)]
  const ranges = buildRanges(cues, new Set([1, 2, 3]), 0)
  assert.strictEqual(ranges.length, 1)
  assert.strictEqual(ranges[0].start, 0)
  assert.strictEqual(ranges[0].end, 6)
  assert.deepStrictEqual(ranges[0].cueIndexes, [1, 2, 3])
})

test('非连续字幕生成多段（需求文档示例）', () => {
  const cues = [cue(1, 80, 135), cue(2, 200, 260), cue(3, 630, 680)]
  const ranges = buildRanges(cues, new Set([1, 3]), 0)
  assert.strictEqual(ranges.length, 2)
  assert.strictEqual(ranges[0].start, 80)
  assert.strictEqual(ranges[0].end, 135)
  assert.strictEqual(ranges[1].start, 630)
  assert.strictEqual(ranges[1].end, 680)
})

test('maxGap 合并间隔很小的相邻段', () => {
  const cues = [cue(1, 0, 2), cue(3, 2.2, 4)]
  assert.strictEqual(buildRanges(cues, new Set([1, 3]), 0).length, 2)
  assert.strictEqual(buildRanges(cues, new Set([1, 3]), 0.5).length, 1)
})

test('乱序选择仍按序号排序', () => {
  const cues = [cue(1, 0, 2), cue(2, 2, 4), cue(3, 4, 6)]
  const ranges = buildRanges(cues, new Set([3, 1]), 0)
  assert.strictEqual(ranges.length, 2)
  assert.strictEqual(ranges[0].start, 0)
  assert.strictEqual(ranges[1].start, 4)
})

test('空选择返回空数组', () => {
  assert.strictEqual(buildRanges([cue(1, 0, 2)], new Set<number>(), 0).length, 0)
})

test('normalizeRanges 合并重叠区间', () => {
  const merged = normalizeRanges([
    { start: 10, end: 20, cueIndexes: [1] },
    { start: 15, end: 25, cueIndexes: [2] },
    { start: 40, end: 50, cueIndexes: [3] }
  ])
  assert.strictEqual(merged.length, 2)
  assert.strictEqual(merged[0].start, 10)
  assert.strictEqual(merged[0].end, 25)
})

/* ------------------------------ 跨分P 切片合并 ------------------------------ */
section('跨分P 切片')

/** 带分P 信息的字幕 */
const pcue = (index: number, start: number, end: number, page: number): RangeCue => ({
  index,
  start,
  end,
  text: `P${page}-${index}`,
  page
})

test('相邻两条分属不同分P 时标记为跨P', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1), pcue(3, 0, 2, 2), pcue(4, 2, 4, 2)]
  // 选中 P1 的末条 + P2 的首条
  const ranges = buildRanges(cues, new Set([2, 3]), 0)
  assert.strictEqual(ranges.length, 1)
  assert.strictEqual(ranges[0].crossPage, true)
  assert.strictEqual(ranges[0].segments?.length, 2)
  assert.deepStrictEqual(ranges[0].segments?.[0], { page: 1, start: 2, end: 4 })
  assert.deepStrictEqual(ranges[0].segments?.[1], { page: 2, start: 0, end: 2 })
})

test('跨P 的整体时间范围覆盖两段', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1), pcue(3, 0, 5, 2)]
  const ranges = buildRanges(cues, new Set([2, 3]), 0)
  assert.strictEqual(ranges[0].start, 2)
  assert.strictEqual(ranges[0].end, 5)
})

test('同一分P 内不标记跨P', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1)]
  const ranges = buildRanges(cues, new Set([1, 2]), 0)
  assert.strictEqual(ranges[0].crossPage, false)
  assert.strictEqual(ranges[0].segments?.length, 1)
})

test('跨P 但只选中单侧时不合并', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 2, 4, 1), pcue(3, 0, 5, 2)]
  // 只选了 P1 的末条，没选 P2 首条
  const ranges = buildRanges(cues, new Set([2]), 0)
  assert.strictEqual(ranges.length, 1)
  assert.strictEqual(ranges[0].crossPage, false)
  assert.deepStrictEqual(ranges[0].segments, [{ page: 1, start: 2, end: 4 }])
})

test('跨三段分P 时记录三个分段', () => {
  const cues = [pcue(1, 0, 2, 1), pcue(2, 0, 2, 2), pcue(3, 0, 2, 3)]
  const ranges = buildRanges(cues, new Set([1, 2, 3]), 0)
  assert.strictEqual(ranges[0].crossPage, true)
  assert.strictEqual(ranges[0].segments?.length, 3)
  assert.deepStrictEqual(
    ranges[0].segments?.map((s) => s.page),
    [1, 2, 3]
  )
})

test('无 page 信息时视为同一分P', () => {
  const cues = [cue(1, 0, 2), cue(2, 2, 4)]
  const ranges = buildRanges(cues, new Set([1, 2]), 0)
  assert.strictEqual(ranges[0].crossPage, false)
})

test('totalDuration 统计总时长', () => {
  const total = totalDuration([
    { start: 0, end: 10, cueIndexes: [] },
    { start: 20, end: 25, cueIndexes: [] }
  ])
  assert.strictEqual(total, 15)
})

/* -------------------------------- 切片表导出 ------------------------------- */
section('切片表导出')

test('CSV 表头与切片工具一致', () => {
  const csv = toCsv([
    { bvid: 'BV1GJ411x7h7', page: 1, start: 5, end: 15, note: 'A-SOUL-开场片段' }
  ])
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n')
  assert.strictEqual(lines[0], 'BV号,分P,开始时间,结束时间,备注(文件名)')
  assert.strictEqual(lines[1], 'BV1GJ411x7h7,1,00:00:05,00:00:15,A-SOUL-开场片段')
})

test('CSV 带 BOM 且转义特殊字符', () => {
  const csv = toCsv([{ bvid: 'BV1', page: 2, start: 3723, end: 3800, note: '含,逗号"引号' }])
  assert.ok(csv.startsWith('﻿'))
  assert.ok(csv.includes('01:02:03,01:03:20'))
  assert.ok(csv.includes('"含,逗号""引号"'))
})

test('共享常量里不再内置开发机绝对路径', () => {
  // 早期版本把需求文档里的 D:\subtitle2clip\... 当成默认值写死，
  // 导致每个人新装后一进设置页就看到「目录不存在」。这里锁住这个回归。
  for (const [key, value] of Object.entries(constants)) {
    if (key.startsWith('DEFAULT_') && typeof value === 'string') {
      assert.ok(!/[A-Za-z]:[\\/]/.test(value), `${key} 不应包含盘符路径：${value}`)
    }
  }
  assert.strictEqual(constants.DEFAULT_PORT, 8765)
  assert.strictEqual(constants.APP_DATA_DIR, 'subclip-data')
})

/* ------------------------------ 切片输出文件名 ----------------------------- */
section('切片输出文件名净化')

test('普通名字原样保留', () => {
  assert.strictEqual(sanitizeFileName('A-SOUL-开场片段'), 'A-SOUL-开场片段')
})

test('非法字符替换成下划线（目录穿越被消解）', () => {
  assert.strictEqual(sanitizeFileName('a/b\\c:d*e?f'), 'a_b_c_d_e_f')
  assert.strictEqual(sanitizeFileName('..\\..\\Windows\\evil'), '.._.._Windows_evil')
  assert.ok(!sanitizeFileName('..\\..\\evil').includes('\\'))
})

test('去掉结尾的点和空格（Windows 会悄悄吞掉，导致上报的文件名与实际不符）', () => {
  assert.strictEqual(sanitizeFileName('clip.'), 'clip')
  assert.strictEqual(sanitizeFileName('clip...'), 'clip')
  assert.strictEqual(sanitizeFileName('clip   '), 'clip')
  assert.strictEqual(sanitizeFileName('clip. . '), 'clip')
})

test('Windows 保留设备名加前缀避开', () => {
  for (const n of ['CON', 'con', 'NUL', 'COM1', 'LPT9', 'aux', 'prn']) {
    assert.strictEqual(sanitizeFileName(n), `_${n}`)
  }
  // 只是以保留名开头、但不是保留名的，不该被改
  assert.strictEqual(sanitizeFileName('console'), 'console')
  assert.strictEqual(sanitizeFileName('COM10'), 'COM10')
})

test('空名与超长名有兜底', () => {
  assert.strictEqual(sanitizeFileName(''), 'clip')
  assert.strictEqual(sanitizeFileName('   '), 'clip')
  assert.strictEqual(sanitizeFileName('...'), 'clip')
  const long = sanitizeFileName('长'.repeat(200))
  assert.ok(long.length <= 96, `应被截断，实际 ${long.length}`)
  // 截断后不能留下点结尾
  assert.ok(!/[. ]$/.test(sanitizeFileName(`${'a'.repeat(95)}.`)))
})

/* ------------------------------ 字幕导出与批量编辑 ----------------------------- */
section('字幕导出与批量编辑')

const sample: Cue[] = [
  { index: 1, start: 1, end: 3.5, text: '第一句' },
  { index: 2, start: 3.6, end: 6, text: '第二句，含高光' }
]

test('导出 WebVTT：带 WEBVTT 头，毫秒用点分隔', () => {
  const vtt = toVtt(sample)
  assert.ok(vtt.startsWith('WEBVTT\n\n'), '应以 WEBVTT 头开始')
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'), '时间格式应为点分隔')
  assert.ok(!vtt.includes('--> 00:00:03,500'), '不应残留 SRT 的逗号写法')
  assert.ok(vtt.includes('第一句'))
})

test('导出纯文本：每行一句，不含时间轴', () => {
  const txt = toPlainText(sample)
  assert.strictEqual(txt, '第一句\n第二句，含高光\n')
  assert.ok(!txt.includes('-->'))
})

test('时间轴整体平移（含负值夹到 0）', () => {
  const forward = shiftCues(sample, 1500)
  assert.strictEqual(forward[0].start, 2.5)
  assert.strictEqual(forward[1].end, 7.5)

  const backward = shiftCues(sample, -2000)
  assert.strictEqual(backward[0].start, 0, '起点不应变成负数')
  assert.strictEqual(backward[0].end, 1.5)
  assert.strictEqual(backward[1].start, 1.6)
})

test('时间轴倍速缩放：围绕第一条起点，不影响入参', () => {
  const scaled = shiftCues(sample, 0, 2)
  assert.strictEqual(scaled[0].start, 1, '第一条起点是缩放原点，保持不变')
  assert.strictEqual(scaled[0].end, 6)
  assert.strictEqual(scaled[1].start, 6.2)
  // 原数组不应被改动
  assert.strictEqual(sample[0].start, 1)
  assert.strictEqual(sample[1].end, 6)
})

test('纯文本替换：特殊字符按字面量处理', () => {
  const res = replaceInCues(sample, '高光', '亮点', false)
  assert.strictEqual(res.changed, 1)
  assert.strictEqual(res.cues[1].text, '第二句，含亮点')
  assert.strictEqual(res.cues[0].text, '第一句', '没命中的不应改动')

  // 正则元字符不应被当成语法
  const literal = replaceInCues([{ index: 1, start: 0, end: 1, text: 'a.b' }], 'a.b', 'X', false)
  assert.strictEqual(literal.cues[0].text, 'X')
})

test('正则替换支持捕获组与忽略大小写', () => {
  const cues: Cue[] = [{ index: 1, start: 0, end: 1, text: '第12句 and 第34句' }]
  const grouped = replaceInCues(cues, '第(\\d+)句', '[$1]', true)
  assert.strictEqual(grouped.cues[0].text, '[12] and [34]')

  const ci = replaceInCues([{ index: 1, start: 0, end: 1, text: 'Hello WORLD' }], 'world', 'x', false, true)
  assert.strictEqual(ci.cues[0].text, 'Hello x')
})

test('正则非法时抛错（由调用方提示用户）', () => {
  assert.throws(() => replaceInCues(sample, '(', 'x', true), /Invalid|Unterminated|nothing to repeat/i)
})

test('空模式不产生任何改动', () => {
  const res = replaceInCues(sample, '', 'x', false)
  assert.strictEqual(res.changed, 0)
  assert.strictEqual(res.cues, sample)
})

/* ------------------------------ 插件消息校验 ------------------------------ */
section('插件消息校验（安全边界）')

const hello = { bvid: 'BV1GJ411x7h7' }
const sub = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'subtitle',
    payload: {
      bvid: hello.bvid,
      page: 1,
      lang: 'zh-CN',
      label: '简体中文',
      cues: [{ from: 1, to: 2, content: '正常字幕' }],
      ...extra
    }
  })

test('合法消息通过并规整字段', () => {
  const msg = parseClientMessage(sub())
  assert.ok(msg && msg.type === 'subtitle')
  if (msg?.type !== 'subtitle') throw new Error('unreachable')
  assert.strictEqual(msg.payload.bvid, hello.bvid)
  assert.strictEqual(msg.payload.cues.length, 1)
})

test('非法 JSON / 非对象 / 未知类型一律丢弃', () => {
  assert.strictEqual(parseClientMessage('这不是 JSON'), null)
  assert.strictEqual(parseClientMessage('[]'), null)
  assert.strictEqual(parseClientMessage('null'), null)
  assert.strictEqual(parseClientMessage('{"payload":{}}'), null)
  assert.strictEqual(parseClientMessage('{"type":"no-such-type"}'), null)
})

test('BV 号必须合法，否则整条丢弃（防止 bvid 为空的垃圾条目）', () => {
  assert.strictEqual(parseClientMessage(sub({ bvid: '' })), null)
  assert.strictEqual(parseClientMessage(sub({ bvid: '不是BV' })), null)
  assert.strictEqual(parseClientMessage(sub({ bvid: 'BV1GJ411x7h' })), null) // 少一位
})

test('字幕正文按上限截断，空白与非法时间被剔除', () => {
  const raw = JSON.stringify({
    type: 'subtitle',
    payload: {
      bvid: hello.bvid,
      page: 1,
      lang: 'zh-CN',
      label: 'x',
      cues: [
        { from: 1, to: 2, content: '好的' },
        { from: 1, to: 2, content: '   ' }, // 空白 → 丢
        { from: Number.NaN, to: 2, content: 'NaN 起点' }, // → 丢
        { from: -5, to: 2, content: '负起点' }, // → 丢
        null,
        '字符串项',
        { from: 3, to: 1, content: '终点早于起点' } // to 回退成 from
      ]
    }
  })
  const msg = parseClientMessage(raw)
  assert.ok(msg && msg.type === 'subtitle')
  if (msg?.type !== 'subtitle') throw new Error('unreachable')
  assert.strictEqual(msg.payload.cues.length, 2, '只应保留两条合法字幕')
  assert.strictEqual(msg.payload.cues[0].content, '好的')
  assert.strictEqual(msg.payload.cues[1].from, 3)
  assert.strictEqual(msg.payload.cues[1].to, 3, '终点早于起点时应回退为起点')
})

test('超长字幕正文被截断而不是原样入库', () => {
  const msg = parseClientMessage(
    sub({ cues: [{ from: 0, to: 1, content: 'x'.repeat(5000) }] })
  )
  assert.ok(msg && msg.type === 'subtitle')
  if (msg?.type !== 'subtitle') throw new Error('unreachable')
  assert.ok(msg.payload.cues[0].content.length <= BRIDGE_LIMITS.maxCueText)
})

test('page-info 兼容旧插件的 mid 字段并归一成 uid', () => {
  const raw = JSON.stringify({
    type: 'page-info',
    payload: {
      pageType: 'video',
      bvid: hello.bvid,
      title: '标题',
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
      page: 2,
      uploader: { mid: 12345, name: 'UP主', avatar: null }
    }
  })
  const msg = parseClientMessage(raw)
  assert.ok(msg && msg.type === 'page-info')
  if (msg?.type !== 'page-info') throw new Error('unreachable')
  assert.strictEqual(msg.payload.uploader.uid, 12345)
  assert.strictEqual(msg.payload.page, 2)
  assert.strictEqual(msg.payload.pageType, 'video')
})

test('page-info 的 pageType 只接受枚举值', () => {
  const raw = JSON.stringify({
    type: 'page-info',
    payload: { pageType: '不存在的类型', bvid: '', title: '', url: '', page: 0, uploader: {} }
  })
  const msg = parseClientMessage(raw)
  assert.ok(msg && msg.type === 'page-info')
  if (msg?.type !== 'page-info') throw new Error('unreachable')
  assert.strictEqual(msg.payload.pageType, 'unknown')
  assert.strictEqual(msg.payload.page, 1, 'page 至少为 1')
})

test('page-info 正确保留系列页类型', () => {
  const msg = parseClientMessage(JSON.stringify({
    type: 'page-info',
    payload: {
      pageType: 'series',
      bvid: '',
      title: '系列标题',
      url: 'https://space.bilibili.com/3546581515111228/lists/4130269?type=series',
      page: 1,
      uploader: { uid: 3546581515111228, name: 'UP主' },
      seasonId: 4130269
    }
  }))
  assert.ok(msg && msg.type === 'page-info')
  if (msg?.type !== 'page-info') throw new Error('unreachable')
  assert.strictEqual(msg.payload.pageType, 'series')
})

test('cookies 缺少内容或超长时丢弃', () => {
  const build = (cookie: string): string =>
    JSON.stringify({ type: 'cookies', payload: { cookie, loggedIn: true, count: 1 } })
  assert.strictEqual(parseClientMessage(build('')), null)
  assert.strictEqual(parseClientMessage(JSON.stringify({ type: 'cookies', payload: {} })), null)
  assert.strictEqual(
    parseClientMessage(build('SESSDATA=' + 'x'.repeat(BRIDGE_LIMITS.maxCookie + 10))),
    null
  )
  assert.ok(parseClientMessage(build('SESSDATA=abc')))
})

test('整条报文超过体积上限直接丢弃', () => {
  const huge = 'x'.repeat(BRIDGE_LIMITS.maxMessageBytes + 1)
  assert.strictEqual(parseClientMessage(huge), null)
})

/* -------------------------------- 诊断包脱敏 ------------------------------- */
section('诊断包脱敏')

/** 一份最小的设置对象（真实默认值来自 settings.ts，那里依赖 electron，测试里不能直接引） */
function baseSettings(): AppSettings {
  return {
    theme: 'system',
    fontSize: 15,
    fontFamily: '',
    lineHeight: 1.7,
    treePaneWidth: 290,
    taskPaneWidth: 380,
    videoPaneHeight: 300,
    shortcuts: DEFAULT_SHORTCUTS,
    readLine: true,
    videoAutoFollow: true,
    sliceQuality: 80,
    sliceConcurrency: 3,
    sliceNameTemplate: DEFAULT_NAME_TEMPLATE,
    ffmpegPath: '',
    sliceOutputDir: '',
    subtitleCacheDir: '',
    sliceToolDir: '',
    outputDir: '',
    port: 8765,
    bridgeToken: '',
    biliCookie: '',
    embedModel: 'Xenova/bge-small-zh-v1.5',
    embedHost: 'https://hf-mirror.com',
    embedInsecureTls: false,
    embedWindowSeconds: 45,
    aiProvider: 'off',
    aiOllamaUrl: 'http://127.0.0.1:11434',
    aiOllamaModel: 'qwen2.5:7b',
    aiOpenaiUrl: 'https://api.openai.com/v1',
    aiOpenaiKey: '',
    aiOpenaiModel: 'gpt-4o-mini',
    aiTemperature: 0.3,
    aiTimeoutSeconds: 60
  }
}

test('诊断包脱敏覆盖 AI 的 API Key', () => {
  const settings: AppSettings = { ...baseSettings(), aiOpenaiKey: 'sk-secret-should-not-leak' }
  const redacted = redactSettings(settings)
  const key = String(redacted.aiOpenaiKey)
  assert.ok(key.includes('已配置'), '应说明已配置')
  assert.ok(!key.includes('sk-secret'), '字段里不能出现 Key 内容')
  assert.ok(
    !JSON.stringify(redacted).includes('sk-secret-should-not-leak'),
    '整份脱敏结果里都不该有 Key'
  )
})

test('诊断信息里绝不出现 Cookie 与配对令牌的内容', () => {
  const settings: AppSettings = {
    ...baseSettings(),
    biliCookie: 'SESSDATA=this-must-never-leak; bili_jct=also-secret',
    bridgeToken: 'super-secret-token'
  } 
  const report = JSON.stringify(
    buildDiagnostics({
      appVersion: '0.1.0',
      packaged: true,
      versions: { electron: '36.0.0', chrome: '136', node: '22' },
      platform: { platform: 'win32', arch: 'x64', release: '10.0' },
      stats: { videos: 1 },
      paths: {},
      settings,
      bridge: {},
      recentPluginEvents: []
    })
  )

  assert.ok(!report.includes('this-must-never-leak'), 'Cookie 内容不能出现在诊断包里')
  assert.ok(!report.includes('bili_jct'), 'Cookie 的任何片段都不能出现')
  assert.ok(!report.includes('super-secret-token'), '配对令牌不能出现在诊断包里')
  assert.ok(report.includes('内容已隐去'), '应报告「已配置但隐去」')
})

test('未配置凭证时诊断包如实标注', () => {
  const report = redactSettings(baseSettings())
  assert.strictEqual(report.biliCookie, '（未配置）')
  assert.strictEqual(report.bridgeToken, '（未配置）')
})

/* -------------------------------- 命名模板 -------------------------------- */
section('命名模板')

const nameCtx = {
  prefix: 'A-SOUL',
  index: 3,
  bvid: 'BV1xx411c7mD',
  page: 2,
  start: 80,
  end: 205,
  duration: 125,
  title: '名场面合集'
}

test('默认模板 {prefix}_{index}', () => {
  assert.strictEqual(renderNameTemplate('', nameCtx), 'A-SOUL_3')
  assert.strictEqual(renderNameTemplate(DEFAULT_NAME_TEMPLATE, nameCtx), 'A-SOUL_3')
})

test('全部占位符都能替换', () => {
  const out = renderNameTemplate(
    '{index}-{prefix}-{bvid}-P{page}-{start}-{end}-{duration}-{title}',
    nameCtx
  )
  assert.strictEqual(out, '3-A-SOUL-BV1xx411c7mD-P2-00-01-20-00-03-25-2m05s-名场面合集')
})

test('未知占位符原样保留（拼错了能一眼看出来，而不是悄悄变空）', () => {
  assert.strictEqual(renderNameTemplate('{prefix}_{nope}', nameCtx), 'A-SOUL_{nope}')
})

test('时长格式化：不足一分钟不带 m 段', () => {
  assert.strictEqual(compactDuration(9), '9s')
  assert.strictEqual(compactDuration(60), '1m00s')
  assert.strictEqual(compactDuration(125), '2m05s')
})

test('时间戳格式化与边界', () => {
  assert.strictEqual(fileStamp(0), '00-00-00')
  assert.strictEqual(fileStamp(3725), '01-02-05')
  assert.strictEqual(fileStamp(-5), '00-00-00', '负数夹到 0')
})

test('模板里的换行 / 制表符会被压成空格（文件名不能带这些）', () => {
  assert.strictEqual(renderNameTemplate('a\nb\tc', nameCtx), 'a b c')
})

/* ------------------------------ 切片任务 JSON ------------------------------ */
section('切片任务 JSON 导入导出')

const clipFixture: ClipTask[] = [
  {
    id: 1,
    docId: 9,
    bvid: 'BV1xx411c7mD',
    page: 1,
    start: 1,
    end: 4,
    note: '第一段',
    name: '第一段',
    source: 'manual',
    favorite: false,
    createdAt: 1
  },
  {
    id: 2,
    docId: 9,
    bvid: 'BV1xx411c7mD',
    page: 2,
    start: 10,
    end: 20,
    note: '跨P 段',
    name: '跨P 段',
    source: 'manual',
    favorite: false,
    createdAt: 2,
    segments: [
      { page: 2, start: 10, end: 12 },
      { page: 3, start: 0, end: 3 }
    ]
  }
]

test('导出的 JSON 可原样解析回来（跨P 分段不丢）', () => {
  const parsed = parseClipTasksJson(serializeClipTasks(clipFixture))
  assert.strictEqual(parsed.warnings.length, 0)
  assert.strictEqual(parsed.tasks.length, 2)
  assert.deepStrictEqual(parsed.tasks[0], {
    bvid: 'BV1xx411c7mD',
    page: 1,
    start: 1,
    end: 4,
    note: '第一段'
  })
  assert.strictEqual(parsed.tasks[1].segments?.length, 2, '跨P 分段应保留')
})

test('导出不含本地 id 与文档关联（换台机器也不冲突）', () => {
  const text = serializeClipTasks(clipFixture)
  assert.ok(!text.includes('"docId"'), '不该带 docId')
  assert.ok(!text.includes('"id"'), '不该带本地自增 id')
  assert.ok(text.includes('subclip/clip-tasks'), '应带信封标识（更名后为新名）')
})

test('老版本导出的清单仍能导入（改名不能把已有文件变成打不开）', () => {
  // 更名后信封标识从 `srt-clip-helper/clip-tasks` 变成 `subclip/clip-tasks`。
  // 如果解析时把 kind 当硬门槛，用户以前导出的表就全废了 —— 那等于「改名改坏了功能」。
  const legacy = JSON.stringify({
    kind: 'srt-clip-helper/clip-tasks',
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks: [{ bvid: 'BV1xx411c7mD', page: 1, start: 1, end: 2, note: '老清单' }]
  })
  const parsed = parseClipTasksJson(legacy)
  assert.strictEqual(parsed.tasks.length, 1, '老 kind 应照常读出来')
  assert.strictEqual(parsed.tasks[0].note, '老清单')
  assert.deepStrictEqual(parsed.warnings, [], '老 kind 是已知的，不该报警告')

  // 完全不认识的 kind：仍尝试读取，但给一条告警（不拒绝）
  const alien = JSON.stringify({ kind: '别的工具/clips', tasks: [{ bvid: 'BV1xx411c7mD', start: 1, end: 2 }] })
  const parsed2 = parseClipTasksJson(alien)
  assert.strictEqual(parsed2.tasks.length, 1, '未知 kind 也按任务列表尝试读取')
  assert.ok(parsed2.warnings.some((w) => w.includes('别的工具/clips')), '应告知类型不符')
})

test('坏条目只跳过并告警，不整份拒绝', () => {  const parsed = parseClipTasksJson(
    JSON.stringify({
      tasks: [
        { bvid: 'BV1', page: 1, start: 0, end: 5, note: '好的' },
        { bvid: 'BV2', start: 0, end: 5 }, // 缺 page → 默认 1，仍可用
        { bvid: 'BV3', page: 1, start: 5, end: 5, note: '零长度' },
        { bvid: 'BV4', page: 1, start: 'x', end: 5, note: '时间不是数字' },
        'not-an-object'
      ]
    })
  )
  assert.strictEqual(parsed.tasks.length, 2, '只有两条可用')
  assert.strictEqual(parsed.warnings.length, 3, '其余三条各记一条告警')
  assert.strictEqual(parsed.tasks[1].page, 1, '缺 page 应默认 1')
  assert.strictEqual(parsed.tasks[1].note, '导入_2', '缺 note 应补默认名')
})

test('也接受「直接就是数组」的形态', () => {
  const parsed = parseClipTasksJson('[{"bvid":"BV1","page":1,"start":0,"end":3,"note":"x"}]')
  assert.strictEqual(parsed.tasks.length, 1)
})

test('非法 JSON 与缺数组都抛错（由调用方提示用户）', () => {
  assert.throws(() => parseClipTasksJson('{ not json'), /不是合法的 JSON/)
  assert.throws(() => parseClipTasksJson('{"foo":1}'), /没有找到任务数组/)
})

/* ------------------------------ 双语对照对齐 ------------------------------ */
section('双语对照对齐')

/** 复刻 store 里 compareTextFor 的匹配规则（那边依赖响应式状态，这里单独验证算法） */
function alignCompare(
  cue: { page: number; origIndex: number; start: number; end: number },
  comparePage: number | null,
  pool: Array<{ index: number; start: number; end: number; text: string }>
): string {
  if (!pool.length || comparePage == null) return ''
  if (comparePage !== cue.page) return ''
  const exact = pool.find((c) => c.index === cue.origIndex)
  if (exact) return exact.text
  let best = ''
  let bestScore = -1
  for (const c of pool) {
    const overlap = Math.min(cue.end, c.end) - Math.max(cue.start, c.start)
    if (overlap > bestScore) {
      bestScore = overlap
      best = c.text
    }
  }
  return bestScore > 0 ? best : ''
}

const enPool = [
  { index: 1, start: 0, end: 3, text: 'Hello' },
  { index: 2, start: 4, end: 7, text: 'World' }
]

test('同一分P 且序号相同 → 直接取对照轨那一条', () => {
  assert.strictEqual(
    alignCompare({ page: 1, origIndex: 2, start: 4, end: 7 }, 1, enPool),
    'World'
  )
})

test('序号对不上时按时间重叠最多的匹配', () => {
  const shifted = [{ index: 9, start: 5, end: 8, text: 'Overlap' }]
  assert.strictEqual(alignCompare({ page: 1, origIndex: 2, start: 4, end: 7 }, 1, shifted), 'Overlap')
})

test('完全没有时间重叠 → 不硬凑，返回空', () => {
  const far = [{ index: 9, start: 100, end: 110, text: 'Far' }]
  assert.strictEqual(alignCompare({ page: 1, origIndex: 2, start: 4, end: 7 }, 1, far), '')
})

test('分P 不同就不对照（拿 P1 中文对 P2 英文没有意义）', () => {
  assert.strictEqual(alignCompare({ page: 1, origIndex: 1, start: 0, end: 3 }, 2, enPool), '')
})

test('未选择对照轨 → 返回空', () => {
  assert.strictEqual(alignCompare({ page: 1, origIndex: 1, start: 0, end: 3 }, null, enPool), '')
})

/* ------------------------------ 字幕合并 / 拆分 ----------------------------- */
section('字幕合并 / 拆分')

const mergeFixture: Cue[] = [
  { index: 1, start: 0, end: 2, text: '今天' },
  { index: 2, start: 2.5, end: 5, text: '天气好' },
  { index: 3, start: 6, end: 8, text: '我们出去玩' }
]

test('中文之间拼接不加空格', () => {
  assert.strictEqual(joinCueText(['今天', '天气好']), '今天天气好')
})

test('英文之间拼接补空格（否则会黏成 Helloworld）', () => {
  assert.strictEqual(joinCueText(['Hello', 'world']), 'Hello world')
})

test('中英混排：拉丁词前后补空格', () => {
  assert.strictEqual(joinCueText(['你好', 'world']), '你好 world')
  assert.strictEqual(joinCueText(['Hello', '你好']), 'Hello 你好')
})

test('空白片段被忽略', () => {
  assert.strictEqual(joinCueText(['a', '   ', '', 'b']), 'a b')
})

test('合并：时间取首条起点 → 末条终点，索引重排', () => {
  const res = mergeCues(mergeFixture, [1, 2])
  assert.strictEqual(res.merged, 2)
  assert.strictEqual(res.cues.length, 2)
  assert.deepStrictEqual(
    res.cues.map((c) => ({ index: c.index, start: c.start, end: c.end, text: c.text })),
    [
      { index: 1, start: 0, end: 5, text: '今天天气好' },
      { index: 2, start: 6, end: 8, text: '我们出去玩' }
    ]
  )
})

test('合并：只选一条不做任何事', () => {
  const res = mergeCues(mergeFixture, [2])
  assert.strictEqual(res.merged, 0)
  assert.strictEqual(res.cues, mergeFixture, '应原样返回')
})

test('合并：不要求选中项在时间上连续（用户选的就是意图）', () => {
  const res = mergeCues(mergeFixture, [1, 3])
  assert.strictEqual(res.merged, 2)
  assert.strictEqual(res.cues.length, 2)
  assert.strictEqual(res.cues[0].start, 0)
  assert.strictEqual(res.cues[0].end, 8)
})

test('拆分：中间切开，两半时长都为正，文本按比例分', () => {
  const res = splitCue(mergeFixture, 2, 3.75)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.at, 3.75)
  assert.strictEqual(res.cues.length, 4)
  const left = res.cues.find((c) => c.start === 2.5)!
  const right = res.cues.find((c) => c.start === 3.75)!
  assert.strictEqual(left.end, 3.75)
  assert.strictEqual(right.end, 5)
  assert.strictEqual(left.text + right.text, '天气好', '两半拼起来应还是原文')
})

test('拆分：切分点越界会被夹进条目内部（不会产生零长度条目）', () => {
  const before = splitCue(mergeFixture, 1, -100)
  assert.strictEqual(before.ok, true)
  assert.ok(before.at > 0, '应被夹到起点之后')
  assert.ok(before.cues.every((c) => c.end > c.start), '不应出现零长度条目')

  const after = splitCue(mergeFixture, 1, 999)
  assert.strictEqual(after.ok, true)
  const first = after.cues.find((c) => c.start === 0)!
  assert.ok(first.end < 2, '应被夹到终点之前')
  assert.ok(after.cues.every((c) => c.end > c.start))
})

test('拆分：过短的条目拒绝拆分', () => {
  const tiny: Cue[] = [{ index: 1, start: 1, end: 1.01, text: 'x' }]
  assert.strictEqual(splitCue(tiny, 1, 1.005).ok, false)
})

test('拆分：找不到序号时原样返回', () => {
  const res = splitCue(mergeFixture, 99, 3)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.cues, mergeFixture)
})

/* ------------------------ 插件「请桌面端拉取」协议 ------------------------ */
section('插件拉取请求')

test('合法的 pull-request 通过，并规整分P 与标题', () => {
  const msg = parseClientMessage(
    JSON.stringify({
      type: 'pull-request',
      payload: { bvid: 'BV1xx411c7mD', page: 3, title: '某个视频' }
    })
  )
  assert.ok(msg, '应被接受')
  assert.strictEqual(msg!.type, 'pull-request')
  const p = (msg as { payload: { bvid: string; page: number; title: string } }).payload
  assert.strictEqual(p.bvid, 'BV1xx411c7mD')
  assert.strictEqual(p.page, 3)
  assert.strictEqual(p.title, '某个视频')
})

test('分P 非法时归一为 1（不因为一个坏字段丢掉整条请求）', () => {
  const msg = parseClientMessage(
    JSON.stringify({ type: 'pull-request', payload: { bvid: 'BV1xx411c7mD', page: 'x' } })
  )
  assert.ok(msg)
  assert.strictEqual((msg as { payload: { page: number } }).payload.page, 1)
})

test('BV 号不合法时整条丢弃（不要发起一次注定失败的抓取）', () => {
  assert.strictEqual(
    parseClientMessage(JSON.stringify({ type: 'pull-request', payload: { bvid: 'not-a-bv' } })),
    null
  )
  assert.strictEqual(
    parseClientMessage(JSON.stringify({ type: 'pull-request', payload: { bvid: '' } })),
    null
  )
  assert.strictEqual(parseClientMessage(JSON.stringify({ type: 'pull-request' })), null)
})

test('桌面端协议版本为 5（跨端一致由 tests/wbi.test.ts 校验）', () => {
  assert.strictEqual(BRIDGE_PROTOCOL_VERSION, 5)
})

/* ------------------------- 统一信封与能力表（第七阶段） ------------------------- */

test('能力表：只认已知能力，且只认显式 true', () => {
  const caps = normalizeCapabilities({
    pageInfo: true,
    subtitle: false,
    cookies: 'yes',
    unknownCap: true,
    pullRequest: true
  })
  assert.deepStrictEqual(caps, { pageInfo: true, pullRequest: true }, '只保留已知且为 true 的项')
  assert.deepStrictEqual(normalizeCapabilities(null), {}, '非对象一律给空表')
  assert.deepStrictEqual(normalizeCapabilities([1, 2]), {}, '数组不是能力表')
})

test('supportsCap 只认显式 true', () => {
  assert.strictEqual(supportsCap({ cookies: true }, BRIDGE_CAPABILITIES.cookies), true)
  assert.strictEqual(supportsCap({ cookies: false }, BRIDGE_CAPABILITIES.cookies), false)
  assert.strictEqual(supportsCap(undefined, BRIDGE_CAPABILITIES.cookies), false)
  assert.strictEqual(supportsCap({}, BRIDGE_CAPABILITIES.cookies), false)
})

test('消息类型 → 所需能力映射', () => {
  assert.strictEqual(requiredCapability('page-info'), BRIDGE_CAPABILITIES.pageInfo)
  assert.strictEqual(requiredCapability('subtitle'), BRIDGE_CAPABILITIES.subtitle)
  assert.strictEqual(requiredCapability('cookies'), BRIDGE_CAPABILITIES.cookies)
  assert.strictEqual(requiredCapability('pull-request'), BRIDGE_CAPABILITIES.pullRequest)
  // 基础信道不需要能力声明，否则老插件连心跳都发不了
  assert.strictEqual(requiredCapability('hello'), null)
  assert.strictEqual(requiredCapability('ping'), null)
  assert.strictEqual(requiredCapability('log'), null)
})

test('入站消息统一补上信封：缺 v 按 1、caps 规整化', () => {
  const old = parseClientMessage(JSON.stringify({ type: 'ping' }))
  assert.strictEqual(old?.v, 1, '老插件不带 v → 按 1 处理（只用于协商，不用于拒绝）')
  assert.deepStrictEqual(old?.caps, {}, '没有 caps 时给空表')

  const withEnvelope = parseClientMessage(
    JSON.stringify({ type: 'ping', v: 5, caps: { pageInfo: true, bogus: true } })
  )
  assert.strictEqual(withEnvelope?.v, 5)
  assert.deepStrictEqual(withEnvelope?.caps, { pageInfo: true }, '未知能力被丢掉')

  // 每条业务消息都要带信封，不能只在 ping 上生效
  const pageInfo = parseClientMessage(
    JSON.stringify({
      type: 'page-info',
      v: 5,
      caps: { pageInfo: true },
      payload: { pageType: 'video', bvid: 'BV1xx411c7mD', title: 't', url: 'u', page: 1, uploader: { uid: 1, name: 'n' } }
    })
  )
  assert.strictEqual(pageInfo?.v, 5, '业务消息同样带信封')
  assert.deepStrictEqual(pageInfo?.caps, { pageInfo: true })
})

test('出站消息自动带协议版本与服务端能力表', () => {
  const raw = JSON.parse(serialize({ type: 'pong' })) as Record<string, unknown>
  assert.strictEqual(raw.v, BRIDGE_PROTOCOL_VERSION, '出站消息应自动补 v')
  assert.deepStrictEqual(raw.caps, serverCapabilities(), '出站消息应自动补 caps')
  assert.ok(serverCapabilities()[BRIDGE_CAPABILITIES.pullRequest], '桌面端应声明支持 pull-request')
})

/* ------------------------------ 链接分类（纯函数） ----------------------------- */
section('B站链接分类')

test('系列：/{mid}/lists/{sid}?type=series → series（而不是 season）', () => {
  const ref = classifyTargetUrl(
    'https://space.bilibili.com/3546581515111228/lists/4130269?type=series'
  )
  assert.deepStrictEqual(ref, { kind: 'series', mid: 3546581515111228, sid: 4130269 })
})

test('用户给出的系列链接可解析，复制时省略协议也可解析', () => {
  const expected = { kind: 'series', mid: 3546581515111228, sid: 4130269 }
  assert.deepStrictEqual(
    classifyTargetUrl('https://space.bilibili.com/3546581515111228/lists/4130269?type=series'),
    expected
  )
  assert.deepStrictEqual(
    classifyTargetUrl('space.bilibili.com/3546581515111228/lists/4130269?type=series'),
    expected
  )
  assert.deepStrictEqual(
    parseCollectionUrl('https://space.bilibili.com/3546581515111228/lists/4130269?type=series'),
    { mid: 3546581515111228, sid: 4130269, kind: 'series' }
  )
})

test('合集：/{mid}/lists/{sid} 不带 type → season', () => {
  assert.deepStrictEqual(
    classifyTargetUrl('https://space.bilibili.com/123/lists/456'),
    { kind: 'season', mid: 123, sid: 456 }
  )
})

test('收藏夹：favlist?fid=xxx，且 ftype 为空也要认（实际链接常常就是空的）', () => {
  assert.deepStrictEqual(
    classifyTargetUrl('https://space.bilibili.com/500278643/favlist?fid=4061631943&ftype='),
    { kind: 'favlist', mid: 500278643, sid: 4061631943 }
  )
  // 带 ftype=create 时同样要认
  assert.deepStrictEqual(
    classifyTargetUrl('https://space.bilibili.com/500278643/favlist?fid=4061631943&ftype=create'),
    { kind: 'favlist', mid: 500278643, sid: 4061631943 }
  )
  assert.deepStrictEqual(
    classifyTargetUrl('https://space.bilibili.com/500278643/favlist?fid=4262986443\\&ftype=create'),
    { kind: 'favlist', mid: 500278643, sid: 4262986443 }
  )
  assert.deepStrictEqual(
    classifyTargetUrl('https://space.bilibili.com/500278643/favlist?media_id=4262986443'),
    { kind: 'favlist', mid: 500278643, sid: 4262986443 }
  )
})

test('收藏夹缺 fid → 不认识（不能猜一个默认收藏夹）', () => {
  assert.strictEqual(classifyTargetUrl('https://space.bilibili.com/123/favlist'), null)
})

test('合集播放页 /list/{mid}?sid=xxx：按 type 区分合集与系列', () => {
  assert.deepStrictEqual(classifyTargetUrl('https://www.bilibili.com/list/123?sid=456'), {
    kind: 'season',
    mid: 123,
    sid: 456
  })
  assert.deepStrictEqual(
    classifyTargetUrl('https://www.bilibili.com/list/123?sid=456&type=series'),
    { kind: 'series', mid: 123, sid: 456 }
  )
  // 缺 sid 就不认识
  assert.strictEqual(classifyTargetUrl('https://www.bilibili.com/list/123'), null)
})

test('视频页与投稿页', () => {
  assert.deepStrictEqual(classifyTargetUrl('https://www.bilibili.com/video/BV1xx411c7mD'), {
    kind: 'video',
    bvid: 'BV1xx411c7mD'
  })
  for (const p of ['12345', '12345/video', '12345/dynamic', '12345/index']) {
    assert.deepStrictEqual(
      classifyTargetUrl(`https://space.bilibili.com/${p}`),
      { kind: 'space', mid: 12345 },
      `${p} 应识别为投稿页`
    )
  }
})

test('兜底：链接任意位置带 BV 号 → 视频', () => {
  assert.deepStrictEqual(
    classifyTargetUrl('https://www.bilibili.com/some/weird/path?x=BV1xx411c7mD'),
    { kind: 'video', bvid: 'BV1xx411c7mD' }
  )
})

test('不认识的链接与非法 URL → null', () => {
  assert.strictEqual(classifyTargetUrl('https://www.bilibili.com/bangumi/play/ep123'), null)
  assert.strictEqual(classifyTargetUrl('不是URL'), null)
  assert.strictEqual(classifyTargetUrl(''), null)
})

/* --------------------------------- 快捷键 -------------------------------- */
section('快捷键')

interface KeyLike {
  key: string
  code?: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

function ev(o: KeyLike): Required<KeyLike> {
  return {
    key: o.key,
    code: o.code ?? '',
    ctrlKey: Boolean(o.ctrlKey),
    altKey: Boolean(o.altKey),
    shiftKey: Boolean(o.shiftKey),
    metaKey: Boolean(o.metaKey)
  }
}

test('eventToBinding 规范化各种按键', () => {
  assert.strictEqual(eventToBinding(ev({ key: 'f', ctrlKey: true })), 'Ctrl+F')
  assert.strictEqual(eventToBinding(ev({ key: 'ArrowDown' })), 'ArrowDown')
  assert.strictEqual(eventToBinding(ev({ key: 'ArrowDown', shiftKey: true })), 'Shift+ArrowDown')
  assert.strictEqual(eventToBinding(ev({ key: ' ', code: 'Space' })), 'Space')
  assert.strictEqual(eventToBinding(ev({ key: 'F2' })), 'F2')
  assert.strictEqual(eventToBinding(ev({ key: 'Escape' })), 'Escape')
})

test('只按修饰键不产生绑定', () => {
  assert.strictEqual(eventToBinding(ev({ key: 'Control', ctrlKey: true })), '')
  assert.strictEqual(eventToBinding(ev({ key: 'Shift', shiftKey: true })), '')
})

test('修饰键顺序固定为 Ctrl+Alt+Shift', () => {
  const binding = eventToBinding(ev({ key: 'j', ctrlKey: true, altKey: true, shiftKey: true }))
  assert.strictEqual(binding, 'Ctrl+Alt+Shift+J')
})

test('metaKey 归一到 Ctrl（兼容 Mac）', () => {
  assert.strictEqual(eventToBinding(ev({ key: 'f', metaKey: true })), 'Ctrl+F')
})

test('resolveAction 命中默认绑定', () => {
  assert.strictEqual(resolveAction(ev({ key: 'f', ctrlKey: true }), DEFAULT_SHORTCUTS), 'focusSearch')
  assert.strictEqual(resolveAction(ev({ key: 'ArrowDown' }), DEFAULT_SHORTCUTS), 'nextCue')
  assert.strictEqual(resolveAction(ev({ key: 'F2' }), DEFAULT_SHORTCUTS), 'editCue')
  assert.strictEqual(resolveAction(ev({ key: 'Enter' }), DEFAULT_SHORTCUTS), 'toggleSelect')
})

test('resolveAction 未绑定的按键返回 null', () => {
  assert.strictEqual(resolveAction(ev({ key: 'q' }), DEFAULT_SHORTCUTS), null)
  assert.strictEqual(resolveAction(ev({ key: 'ArrowDown', ctrlKey: true }), DEFAULT_SHORTCUTS), null)
})

test('自定义绑定覆盖默认值', () => {
  const custom = { ...DEFAULT_SHORTCUTS, nextCue: 'Ctrl+J' }
  assert.strictEqual(resolveAction(ev({ key: 'j', ctrlKey: true }), custom), 'nextCue')
  // 旧绑定不再响应
  assert.strictEqual(resolveAction(ev({ key: 'ArrowDown' }), custom), null)
})

test('findConflicts 检测重复绑定', () => {
  const map = { ...DEFAULT_SHORTCUTS, prevCue: DEFAULT_SHORTCUTS.nextCue }
  const conflicts = findConflicts(map)
  assert.strictEqual(conflicts.length, 1)
  assert.ok(conflicts[0].includes('nextCue'))
  assert.ok(conflicts[0].includes('prevCue'))
})

test('默认配置无冲突', () => {
  assert.strictEqual(findConflicts(DEFAULT_SHORTCUTS).length, 0)
})

test('normalizeShortcuts 补齐缺失与非法项', () => {
  const partial = normalizeShortcuts({ nextCue: 'Ctrl+J', prevCue: '' as string })
  assert.strictEqual(partial.nextCue, 'Ctrl+J')
  assert.strictEqual(partial.prevCue, DEFAULT_SHORTCUTS.prevCue)
  assert.strictEqual(partial.focusSearch, DEFAULT_SHORTCUTS.focusSearch)
  assert.strictEqual(Object.keys(partial).length, SHORTCUT_DEFS.length)
})

test('normalizeShortcuts 处理 undefined', () => {
  assert.deepStrictEqual(normalizeShortcuts(undefined), DEFAULT_SHORTCUTS)
})

test('formatBinding 转成友好名称', () => {
  assert.strictEqual(formatBinding('Shift+ArrowDown'), 'Shift + ↓')
  assert.strictEqual(formatBinding('Space'), '空格')
  assert.strictEqual(formatBinding('Ctrl+F'), 'Ctrl + F')
  assert.strictEqual(formatBinding(''), '未设置')
})

/* --------------------------------- 汇总 --------------------------------- */
console.log(`\n通过 ${passed}，失败 ${failed}\n`)
if (failed > 0) process.exit(1)
