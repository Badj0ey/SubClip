/**
 * 字幕文本抽取（第八阶段：知识图谱的「主题」与「观点」层）。
 *
 * ## 为什么主题要从字幕文本里抽
 *
 * 图谱要连的是「主题 → 视频 → 观点 → 片段」，而**主题不是标签**：
 * 用户手里的库通常有大几百份字幕却只有个位数的标签（本机实测 490 份字幕 / 2 个标签）。
 * 若把主题层建立在标签上，图谱就是空的。所以主题必须从**字幕正文**里抽。
 *
 * ## 全部本地、零依赖
 *
 * 中文分词用运行时自带的 `Intl.Segmenter`（Chromium / Node 都有，实测可用），
 * 不引入任何分词库；观点句用启发式打分。不联网、不依赖 AI。
 *
 * ## 本文件是纯函数
 *
 * 抽取质量完全取决于这里的规则（停用词、二元组合并、打分公式），
 * 而这些规则**必须能单测** —— 放在主进程里和 SQLite 缠在一起就没法测了。
 */

/* --------------------------------- 分词 ---------------------------------- */

/**
 * 停用词。
 *
 * 这份表是**按实测语料补出来的**：直播类字幕里「就是 / 然后 / 那个 / 这个」能占
 * 高频词的绝大部分，不过滤的话抽出来的「主题」全是这些，图谱毫无信息量。
 *
 * 只收**确定没有主题意义**的词；像「不是」「视频」这类有实义的词一律不收
 * （第五阶段做片段命名时踩过同样的坑：「不是」是实词，剥掉就把意思改了）。
 */
const STOPWORDS = new Set([
  // 语气 / 连接 / 填充
  '就是', '然后', '那个', '这个', '什么', '怎么', '因为', '所以', '但是', '可是',
  '如果', '而且', '不过', '还是', '可能', '应该', '觉得', '知道', '感觉', '真的',
  '其实', '现在', '一下', '一点', '有点', '非常', '特别', '反正', '总之', '于是',
  '然后呢', '对不对', '是不是', '好不好', '有没有', '好吧', '哈哈', '哈哈哈', '哎呀',
  '诶', '嗯', '哦', '啊', '呀', '吧', '呢', '吗', '嘛', '咯', '噢', '喔', '哎',
  // 人称 / 指代
  '我们', '你们', '他们', '她们', '大家', '自己', '别人', '这里', '那里', '时候',
  '今天', '明天', '昨天', '现在', '刚才', '一会', '一样', '这样', '那样', '怎么',
  // 泛动词
  '可以', '没有', '不能', '不要', '不会', '还有', '出来', '过去',
  '过来', '起来', '下去', '上去', '进来', '回去', '看看', '说说', '聊聊',
  // ⚠️ 注意：「不是」**不能**收进来 —— 它是有实义的词。
  // 第五阶段做片段命名时已经论证过这一点（「不是就是B站嗯」不能剥成「就是B站嗯」），
  // 这里保持一致；core.test.ts 有断言盯着。
  // 它**不该**当高频主题，那件事由「最多覆盖多少语料」的过滤来做（见 scoreTerms），
  // 而不是靠把它当停用词 —— 那是两回事。
  //
  // 数量 / 程度 / 泛指的泛词（实测能挤进主题榜前列，但没有主题意义）
  '一个', '一些', '一直', '一起', '一定', '一般', '一样', '一点', '一下',
  '那种', '这种', '这种', '的话', '这么', '那么', '多少', '几个', '两个',
  '好像', '可能吧', '是吧', '好的好的', '嗯嗯', '哦哦', '对对',
  // 问候（直播标题里几乎都有，不构成「这个视频在讲什么」）
  '晚上好', '早上好', '下午好', '中午好', '大家好', '晚安啦',
  // 直播间的格式化社交话术（实测占高频词极大比例，且完全没有主题意义）
  '谢谢', '感谢', '关注', '点赞', '投票', '礼物', '灯牌', '粉丝', '直播', '直播间',
  '欢迎', '辛苦', '加油', '晚安', '早安', '好的', '好好', '没事', '没问题'
])

/** 单字词几乎都是噪声（「的」「了」「是」），但少数实义单字要留 */
const MEANINGFUL_SINGLE = new Set(['人', '钱', '书', '歌', '猫', '狗', '画', '雨', '雪'])

export interface Token {
  text: string
  /** 在原文中的起始位置（用于把二元组映射回句子） */
  start: number
}

/**
 * 分词并做**相邻二元组合并**。
 *
 * 为什么需要合并：`Intl.Segmenter` 会把常见的复合词切碎 ——
 * 实测「短视频」→「短 / 视频」、「人工智能」→「人工 / 智能」、「剪辑」→「剪 / 辑」。
 * 不做合并，抽出来的「主题」就是「短」「人工」这类碎片，比不抽还糟。
 *
 * 合并规则：相邻两个都是「像词」的片段时，同时产出**合并形式**与**各自的原形**，
 * 让后续统计自己决定谁更常用（合并形式很少出现时自然会被淘汰）。
 */
export function tokenize(text: string): Token[] {
  const seg = new Intl.Segmenter('zh-Hans', { granularity: 'word' })
  const parts: Token[] = []
  for (const piece of seg.segment(text)) {
    if (!piece.isWordLike) continue
    const t = piece.segment.trim()
    if (!t) continue
    parts.push({ text: t, start: piece.index })
  }

  const out: Token[] = []
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i]
    out.push(cur)
    const next = parts[i + 1]
    if (!next) continue
    // 相邻且中间没有标点/空白（位置连续）才考虑合并
    if (next.start !== cur.start + cur.text.length) continue
    if (!isTermLike(cur.text) && !isTermLike(next.text)) continue
    // 合并形式的位置用前者，方便回溯到句子
    out.push({ text: cur.text + next.text, start: cur.start })
  }
  return out
}

/**
 * 不能出现在**词首**的单字。
 *
 * 实测问题：分词把「的」单独切出来之后，二元组会把它和后一个词黏起来，
 * 于是抽出的主题里出现 `的薯条`、`的棒棒糖` 这种带前缀的碎片（榜上真有）。
 * 词首的助词/程度词没有信息量，直接不让它当合并起点。
 *
 * 只拦词首：`是` 在「不是」里、`不` 在「不好」里都是正常成分，
 * 一律拦掉会把真词也误伤（第五阶段剥语气词时踩过同类坑）。
 */
const BAD_PREFIX = new Set([
  '的', '了', '着', '过', '地', '得', '呢', '吧', '吗', '啊', '呀', '嗯', '哦',
  '就', '都', '也', '还', '很', '太', '挺', '才', '再', '又', '被', '把', '给',
  '在', '有', '和', '与', '或', '而', '但', '因', '所', '之', '其', '此'
])

/**
 * 日语特有汉字。
 *
 * 实测问题：语料里混着日文内容，而日语**大量使用汉字**，
 * 所以「必须含汉字」的过滤拦不住 `大丈夫` / `時間` / `自分` / `結構` / `配信`
 * 这些词（它们确实全是汉字，混在中文主题里非常扎眼）。
 *
 * 做法：只在**整词等于**这些常见日语词时排除。
 * 用「排除法白名单」而不是「识别语言」的原因：中文和日文共用汉字，
 * 没有可靠的语言判据；而这些词在中文直播字幕里几乎不作为独立词出现，
 * 所以点名排除的误伤很小、收益明确。
 */
const JP_ONLY = new Set([
  '大丈夫', '時間', '自分', '結構', '配信', '本当', '一緒', '気持', '気持ち',
  '今日', '明日', '昨日', '最高', '無理', '可愛', '可愛い', '綺麗', '綺麗い',
  '頑張', '頑張れ', 'ありがとう', 'ごめん', 'はじめ', 'たぶん', 'ぜひ',
  '放送', '視聴', '感謝', '応援', '無料', '情報', '参加', '確認', '予定'
])

/**
 * 这个词像不像「主题词」。
 *
 * 规则：过滤停用词、纯数字、**非中文语种**、词首助词、日语特有词。
 * 2~4 字的中文/英文数字串算候选；单字只有出现在 `MEANINGFUL_SINGLE` 里才收。
 */
export function isTermLike(term: string): boolean {
  const t = term.trim()
  if (!t || t.length > 8) return false
  if (STOPWORDS.has(t)) return false
  if (JP_ONLY.has(t)) return false
  // 纯数字 / 纯标点
  if (/^[\d\s.,%+-]+$/.test(t)) return false

  /**
   * 语言过滤（实测必须要有）。
   *
   * 语料里混着大量非中文字幕（外语视频、B站的机翻轨、外文歌），
   * 不过滤的话抽出来的「主题」是 `the` / `não` / `que` / `ない` / `って` / `لا` 这种东西
   * —— 实测它们能挤进主题榜前二十，图谱直接废掉。
   *
   * 判据：不许出现假名/谚文/西里尔/阿拉伯/希伯来，且**必须含汉字**。
   * 这样会顺带滤掉 `AI`、`Vue` 这类纯英文术语 —— 是有意的取舍，见 core.test.ts。
   */
  if (/[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0590-\u05ff]/.test(t)) return false
  const han = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (han === 0) return false

  // 词首的助词/泛副词会让合并结果变成碎片（`的薯条`）
  if (BAD_PREFIX.has(t[0])) return false

  // 单字：仅白名单
  if (t.length === 1) return MEANINGFUL_SINGLE.has(t)
  return true
}

/* ------------------------------- 词频统计 -------------------------------- */

export interface TermStat {
  term: string
  /** 在该文档内出现的次数 */
  count: number
  /** 出现在多少个文档里（全局统计，用于区辨「这个视频在讲什么」） */
  docCount: number
  /** 综合分（越大越像该视频的主题） */
  score: number
}

/**
 * 统计一个文档里的候选词频。
 *
 * @param texts 该文档的全部字幕文本（按顺序）
 * @param docCounts 全局「词 → 出现在多少个文档」表；不传则按 1 处理
 */
export function countTerms(
  texts: string[],
  docCounts: Map<string, number> = new Map()
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!isTermLike(token.text)) continue
      counts.set(token.text, (counts.get(token.text) ?? 0) + 1)
    }
  }
  void docCounts
  return counts
}

/**
 * 给候选词打分。
 *
 * 用「词频 × 稀有度」而不是纯词频：纯词频下「直播间」「粉丝」这类
 * 全库高频词会统治每个视频的主题层（实测就是这样），
 * 除以「出现在多少个文档」能把「这个视频独有的说法」顶上来。
 *
 * @param minCount 最少出现次数（只出现一次的多半是口误或分词碎片）
 * @param maxDocRatio 最多允许覆盖多少比例的文档。
 *   **这一条是实测加的**：光有 IDF 不够 —— 「不是」「一个」「人」这类泛词
 *   即便出现在 40% 的文档里，IDF 也只把它们压到中游，结果还是占据主题榜前列
 *   （实测前二十名里一半是这种词）。它们的共同点是「覆盖大半个语料」，
 *   所以直接按覆盖率砍掉，比继续调 IDF 权重更可靠。
 *   取 0.25：一个词要是出现在四分之一以上的视频里，它就不可能说明「这个视频在讲什么」。
 */
export function scoreTerms(
  counts: Map<string, number>,
  docCounts: Map<string, number>,
  totalDocs: number,
  minCount = 3,
  maxDocRatio = 0.25
): TermStat[] {
  const out: TermStat[] = []
  const dfLimit = Math.max(2, Math.floor(totalDocs * maxDocRatio))
  for (const [term, count] of counts) {
    if (count < minCount) continue
    const df = docCounts.get(term) ?? 1
    // 覆盖太广的泛词直接排除（它们不可能说明「这个视频在讲什么」）
    if (df > dfLimit) continue
    // 平滑 IDF：全库都出现的词权重趋近 0，独有词权重高
    const idf = Math.log(1 + totalDocs / Math.max(1, df))
    // 长词信息量更大（「人工智能」比「人工」具体），轻微加权
    const lengthBoost = 1 + Math.min(0.5, (term.length - 2) * 0.15)
    const score = count * idf * lengthBoost
    out.push({ term, count, docCount: df, score: Math.round(score * 1000) / 1000 })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** 取该文档的 top-N 主题词 */
export function pickTopics(stats: TermStat[], limit = 8): TermStat[] {
  return stats.slice(0, Math.max(0, limit))
}

/* ------------------------------- 观点句抽取 ------------------------------- */

export interface SentenceCandidate {
  /** 该候选覆盖的字幕起始序号（文档内下标，与 `cues` 一致） */
  index: number
  start: number
  end: number
  text: string
  score: number
}

/**
 * 互动话术的特征词。
 *
 * 实测问题：直播开头的寒暄会被合并成一大段「观点」——
 * 「下午好大家这个中秋节快乐欢迎来到BIUBIU直播间……谢谢米球的灯牌谢谢空叔哥哥投喂的望月神光」
 * 这种东西被当成「观点句」列出来，整个观点层就没人看了。
 *
 * 判据是「密度」而不是「出现」：一句话里带一两个「谢谢」很正常，
 * 但互动话术**密度高**才是它的特征 —— 所以按命中比例扣分，见 `scoreSentences`。
 */
const CHATTY_MARKERS = [
  '谢谢', '感谢', '欢迎', '灯牌', '粉丝团', '投喂', '礼物', '关注', '点赞',
  '直播间', '弹幕', '点歌', '打赏', '来了吗', '在吗', '下午好', '晚上好',
  '早上好', '大家好', '生日快乐', '加油', '么么', '辛苦了'
]

/** 命中多少个互动特征词 */
export function chattyHits(text: string): number {
  let n = 0
  for (const marker of CHATTY_MARKERS) {
    if (text.includes(marker)) n++
  }
  return n
}

/**
 * 把连续字幕合并成候选句子。
 *
 * 合并的理由：单条字幕往往是半句话（「然后我们就」/「把这个东西」），
 * 单独拿出来既不像观点也不好读；按标点与时间间隔合并才成句。
 *
 * @param gapSeconds 两条字幕间隔超过它就断开（默认 1.5 秒；直播里说话中断的典型长度）
 * @param maxChars 单句上限，超了就断开（避免合出一大段）
 */
export function mergeIntoSentences(
  cues: Array<{ index: number; start: number; end: number; text: string }>,
  gapSeconds = 1.5,
  maxChars = 120
): SentenceCandidate[] {
  const out: SentenceCandidate[] = []
  let buf: typeof cues = []

  const flush = (): void => {
    if (!buf.length) return
    const text = buf.map((c) => c.text.trim()).join('')
    out.push({
      index: buf[0].index,
      start: buf[0].start,
      end: buf[buf.length - 1].end,
      text,
      score: 0
    })
    buf = []
  }

  for (const cue of cues) {
    const prev = buf[buf.length - 1]
    const tooFar = prev ? cue.start - prev.end > gapSeconds : false
    const tooLong = buf.reduce((n, c) => n + c.text.length, 0) + cue.text.length > maxChars
    // 上一条已经以句末标点结束，就该断开
    const prevEnded = prev ? /[。！？!?…]$/.test(prev.text.trim()) : false
    if (buf.length && (tooFar || tooLong || prevEnded)) flush()
    buf.push(cue)
  }
  flush()
  return out
}

/**
 * 整份文档的互动话术占比（0~1）。
 *
 * 为什么要按文档算，而不是只按句子算：
 * 实测发现**单句惩罚不够** —— 直播开播那几分钟的寒暄会被切成好几条
 * 40~60 字的句子，每一条单看「互动词密度」都不算高，于是一条条全溜过去了。
 * 但把整个文档摊开看，这类句子占了绝大多数 —— 这才是可判定的信号。
 */
export function chattyRatio(sentences: SentenceCandidate[]): number {
  if (!sentences.length) return 0
  let chatty = 0
  for (const s of sentences) {
    // 命中 2 个以上互动特征词就算「寒暄类」
    if (chattyHits(s.text) >= 2) chatty++
  }
  return chatty / sentences.length
}

/**
 * 候选句里有多少条**真的提到了本视频的主题**（0~1）。
 *
 * 这是继「互动话术占比」之后第二个**文档级**信号。
 *
 * 依据：一份文档在讲具体东西时，句子会反复落在同一批词上（主题集中）；
 * 闲聊则天南海北，提到「主题词」的句子寥寥无几。
 * 实测直播闲聊类文档这个比例很低，而知识型内容明显更高 ——
 * 用它来判断「这份文档值不值得抽观点」，比继续给单句加惩罚更准确。
 */
export function topicFocusRatio(sentences: SentenceCandidate[], topics: string[]): number {
  if (!sentences.length || !topics.length) return 0
  let hit = 0
  for (const s of sentences) {
    if (topics.some((t) => s.text.includes(t))) hit++
  }
  return hit / sentences.length
}

/**
 * 给候选句打分，挑出「观点句」。
 *
 * 打分维度（每一项都对应一种「读起来像观点」的特征）：
 * - 含该视频的主题词 → 更像在讲正事（权重最高）；
 * - 长度适中（12~60 字）→ 太短没说完整，太长是闲聊；
 * - 以句末标点收尾 → 是个完整表达；
 * - 提到具体信息（数字 / 专有名词感）→ 加分；
 * - 互动话术密度 → 扣分（见 `CHATTY_MARKERS`）；
 * - **文档级信号**：互动占比高 / 主题集中度低 → 整份文档降权。
 *
 * @param minScore 分数下限；调用方调高它就能只保留最像观点的那些
 */
export function scoreSentences(
  sentences: SentenceCandidate[],
  topics: string[],
  minScore = 0
): SentenceCandidate[] {
  const docChatty = chattyRatio(sentences)
  const focus = topicFocusRatio(sentences, topics)

  /**
   * 文档级调整量。
   *
   * 两个信号**取较重的那个**，而不是相加 —— 相加会把「既闲聊又发散」的文档
   * 一次罚掉 10 分，连里面真正像样的句子也被压到负分，
   * 结果是「观点层空白」和「观点层全是废话」两种极端之间反复横跳（前两版就是这样）。
   */
  let docPenalty = 0
  if (docChatty >= 0.5) docPenalty = Math.max(docPenalty, 4)
  else if (docChatty >= 0.3) docPenalty = Math.max(docPenalty, 2)
  // 主题集中度低说明这份文档没有在讲什么具体的事
  if (focus < 0.1) docPenalty = Math.max(docPenalty, 3)
  else if (focus < 0.25) docPenalty = Math.max(docPenalty, 1.5)

  const out = sentences.map((s) => {
    let score = 0
    // 1. 命中主题词
    const hits = topics.filter((t) => s.text.includes(t)).length
    score += hits * 2.5
    // 2. 长度：太短没说完整（口语里的「嗯」「对对对」全是这种）
    const len = s.text.length
    if (len >= 12 && len <= 60) score += 2
    else if (len < 8) score -= 2.5
    else if (len > 120) score -= 1
    // 3. 完整收尾
    if (/[。！？!?…]$/.test(s.text.trim())) score += 1
    // 4. 具体信息
    if (/\d/.test(s.text)) score += 0.5
    // 5. 念白式的口水话特征（同一个字连着重复）扣分
    if (/(.)\1{2,}/.test(s.text)) score -= 1

    /**
     * 6. 互动话术密度（实测必须加）。
     *
     * 直播开播那几分钟基本全是「下午好 / 欢迎来到 / 谢谢灯牌 / 谢谢投喂」，
     * 按字符数一合并就变成一条长长的「观点」，还因为够长、够完整而拿到高分，
     * 把真正的观点挤出榜单（实测第一屏全是这种）。
     */
    const chatty = chattyHits(s.text)
    if (chatty) {
      const density = chatty / Math.max(1, len / 8)
      score -= density >= 0.75 ? 6 : density >= 0.4 ? 3 : 1
    }

    // 7. 文档级降权（取较重信号，见上文说明）
    score -= docPenalty

    return { ...s, score: Math.round(score * 1000) / 1000 }
  })
  return out.filter((s) => s.score >= minScore).sort((a, b) => b.score - a.score)
}
