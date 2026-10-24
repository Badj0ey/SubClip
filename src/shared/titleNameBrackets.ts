/**
 * 方括号内容的分类（配合 `titleName.ts`）。
 *
 * ## 为什么要单独一个文件
 *
 * 「括号里的东西是什么」需要一张**可维护的名单**，而名单会随使用不断补充
 * （B站的分类词不是固定的）。把它和解析逻辑放在一起会让解析函数越来越长、
 * 也不好一眼看出「到底认哪些词」。这里只回答一个问题：**这段括号属于哪一类？**
 *
 * ## 三分类
 *
 * - `uploader`：就是 UP主 名（要**保留**到「日期 UP主 内容」的第二个位置）
 * - `platform`：平台/类型的标签（**丢弃**，例如「直播回放」）
 * - `content`：真正的内容（例如「生日会后日谈」）→ 保留
 *
 * ## 判据为什么是「整段相等」而不是「看起来短」
 *
 * 「短的就是标签」这种模糊判据会把 `【杂谈】`、`【演唱会】` 这种
 * **真正的内容标题**误删。所以这里只认**整段完全等于**名单里的词——
 * 名单外的一律当内容，宁可多留一点。
 */

/**
 * 平台 / 类型标签（整段相等才算）。
 *
 * 维护说明：只放「放在标题里不说明这场讲了什么」的词。
 * 收录标准是**实测见过**的，不是凭空罗列 —— 编名单很容易把内容词误收进来。
 */
const PLATFORM_LABELS = new Set([
  '直播回放',
  '直播录像',
  '直播',
  '回放',
  '录播',
  '录像',
  '重播',
  '预告',
  '花絮',
  '切片',
  '精华',
  '合集',
  'cut',
  'CUT',
  '生肉',
  '熟肉',
  '转载',
  '搬运',
  '投稿',
  '视频',
  '官方',
  '片段'
])

export type BracketKind = 'uploader' | 'platform' | 'content'

/**
 * 判断一段括号内容属于哪一类。
 *
 * @param inner 括号里的内容（已 trim）
 * @param uploaderName 投稿账号名（可空）
 * @param collectionName 合集 / 频道名（可空）
 *
 * 为什么要比对**两个**名字：实测投稿账号与频道名会不同 ——
 * 本机真实数据里账号是 `恩仙仙`、合集叫 `弥雾meow`，标题括号写的是后者。
 * 只比账号名会认不出署名，结果它被当正文留在末尾（位置就错了）。
 */
export function classifyBracket(
  inner: string,
  uploaderName?: string,
  collectionName?: string
): BracketKind {
  const t = (inner ?? '').trim()
  if (!t) return 'platform' // 空括号没有信息，按噪音处理

  // 1. 与投稿账号名或频道名相同 → 这是署名，保留
  const up = (uploaderName ?? '').trim()
  const col = (collectionName ?? '').trim()
  if (up && same(t, up)) return 'uploader'
  if (col && same(t, col)) return 'uploader'
  // 合集名常常带后缀（「弥雾meow的直播间」），前缀命中也算署名
  if (col && col.length >= 2 && (t.startsWith(col) || col.startsWith(t))) return 'uploader'

  // 2. 命中平台标签名单 → 丢弃
  if (PLATFORM_LABELS.has(t)) return 'platform'

  // 3. 其余一律当内容
  return 'content'
}

/** 比较两个名字是否相同（容忍大小写、全角空格与多余空白） */
function same(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/[\s\u3000]/g, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 供设置页/文档展示当前认哪些平台标签 */
export function listPlatformLabels(): string[] {
  return [...PLATFORM_LABELS]
}
