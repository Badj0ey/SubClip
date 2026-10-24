/**
 * 数据层：SQLite。
 *
 * 为什么不用原来的单文件 JSON：
 *   - 每次写操作都要重写整个文件，批量拉字幕时放大得很厉害；
 *   - 文件一坏全库皆失，而且「元数据在、正文文件丢了」这种半损坏状态没法自愈；
 *   - 没法做全文检索（跨文档搜索要靠 FTS5）。
 *
 * 用的是 **Electron 内置的 `node:sqlite`**（Electron 36+ / Node 22+），
 * 零原生依赖、不需要 MSVC 工具链，也就不会重演 better-sqlite3 编译失败的坑。
 *
 * 层级：uploaders → collections → videos → docs → cues / clips
 * 字幕正文（cues）从「一个文档一个 JSON 文件」改为入库，于是：
 *   - 不再有 missingCues 那类半损坏状态；
 *   - 可以用 FTS5 做跨文档全文检索（见 `searchCues`）。
 *
 * 老数据（srt-tool.json + docs/*.json）会在首次启动时自动迁移，
 * 原文件改名保留为 `srt-tool.json.migrated-<时间戳>`，不做删除。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AnalysisRecord,
  ClipTask,
  Cue,
  CueSearchFilters,
  CueSearchHit,
  CueSearchPage,
  DashboardCollection,
  DashboardFavorite,
  DashboardOverview,
  DashboardVideo,
  NewClipTask,
  SubtitleDoc,
  TagInfo,
  TreeNode,
  VideoItem
} from '@shared/types'
import { APP_DATA_DIR } from '@shared/constants'
import { mergeCues, splitCue } from '@shared/cues'
import { normalizeVideoTitle } from '@shared/titleName'

/** 本地导入用的虚拟 UP主（整份本地字幕都挂在它下面） */
export const LOCAL_UPLOADER_NAME = '本地导入'

/**
 * 兜底用的虚拟 UP主。
 *
 * 插件推送字幕时，桌面端会先按 BV 号去查一次视频信息，从而拿到真实 UID / 合集，
 * 直接归到正确的 UP主 下。只有在**查不到**（未登录、接口失败、离线）时，
 * 才先落到这里占位；等真实信息补上后视频会自动归位，
 * 而空掉的占位分组不会再出现在资源树里（见 `pruneEmptyGroups`）。
 */
export const UNKNOWN_UPLOADER_NAME = '未关联'

/* ------------------------------- 数据库行类型 ------------------------------ */

interface UploaderRow {
  id: number
  uid: number | null
  name: string
  avatar: string | null
  favorite: number
  created_at: number
}

interface CollectionRow {
  id: number
  uploader_id: number | null
  sid: string | null
  title: string
  url: string | null
  favorite: number
  created_at: number
}

interface VideoRow {
  id: number
  collection_id: number | null
  bvid: string
  title: string
  url: string
  cover: string | null
  duration: number | null
  page_count: number | null
  favorite: number
  created_at: number
}

interface DocRow {
  id: number
  video_id: number
  page: number
  lang: string
  label: string
  filename: string
  source: 'local' | 'bilibili'
  favorite: number
  created_at: number
}

interface ClipRow {
  id: number
  doc_id: number
  bvid: string
  page: number
  start: number
  end: number
  note: string
  name?: string
  source?: string
  favorite?: number
  segments: string | null
  created_at: number
}

/* --------------------------------- 标签 ---------------------------------- */

export interface TagRow {
  id: number
  name: string
  color: string
  note: string
  created_at: number
}

/**
 * 全部标签，带视频 / 片段两个方向的计数。
 *
 * 第三阶段把标签从「只作用于视频」扩成「视频 + 片段」共用一套标签体系，
 * 所以计数要分开给：同一个「高光」标签可能既打了视频也打了片段，
 * 混成一个数字看不出来。
 */
export function listTags(): TagInfo[] {
  return requireDb()
    .prepare(
      `select t.id as id, t.name as name, t.color as color, t.note as note,
              (select count(*) from video_tags vt where vt.tag_id = t.id) as videoCount,
              (select count(*) from clip_tags ct where ct.tag_id = t.id) as clipCount
       from tags t order by t.name asc`
    )
    .all() as unknown as TagInfo[]
}

/** 新建标签；已存在时直接返回既有标签的 id */
export function createTag(name: string): number {
  const value = (name ?? '').trim().slice(0, 40)
  if (!value) throw new Error('标签名不能为空')
  const handle = requireDb()
  const hit = handle.prepare('select id from tags where name = ?').get(value) as
    | { id: number }
    | undefined
  if (hit) return hit.id
  const res = handle
    .prepare('insert into tags (name, created_at) values (?, ?)')
    .run(value, Date.now())
  return Number(res.lastInsertRowid)
}

/** 改标签的外观属性（颜色 / 备注）。名称另有 `renameTag`。 */
export function updateTagMeta(id: number, patch: { color?: string; note?: string }): void {
  const handle = requireDb()
  if (patch.color !== undefined) {
    // 只接受 #RGB / #RRGGBB，其余一律清空（避免把任意字符串写进 CSS）
    const color = /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color.toLowerCase() : ''
    handle.prepare('update tags set color = ? where id = ?').run(color, id)
  }
  if (patch.note !== undefined) {
    handle
      .prepare('update tags set note = ? where id = ?')
      .run(String(patch.note).slice(0, 120), id)
  }
}

/** 给多个视频**追加**标签（批量打标，不动已有标签） */
export function addVideoTags(videoIds: number[], tagIds: number[]): number {
  const handle = requireDb()
  const ins = handle.prepare('insert or ignore into video_tags (video_id, tag_id) values (?, ?)')
  let n = 0
  withTransaction(() => {
    for (const v of videoIds) {
      for (const t of tagIds) {
        ins.run(v, t)
        n++
      }
    }
  })
  return n
}

/** 整体覆盖某个视频的标签集合（界面上勾选的结果就是最终结果） */
export function setVideoTags(videoId: number, tagIds: number[]): void {
  const handle = requireDb()
  const wanted = [...new Set(tagIds.filter((n) => Number.isFinite(n)))]
  withTransaction(() => {
    handle.prepare('delete from video_tags where video_id = ?').run(videoId)
    const ins = handle.prepare('insert or ignore into video_tags (video_id, tag_id) values (?, ?)')
    for (const tagId of wanted) ins.run(videoId, tagId)
  })
}

/** 某个片段的标签 id */
export function getClipTagIds(clipId: number): number[] {
  const rows = requireDb()
    .prepare('select tag_id from clip_tags where clip_id = ?')
    .all(clipId) as unknown as Array<{ tag_id: number }>
  return rows.map((r) => r.tag_id)
}

/** 替换式设置片段的标签 */
export function setClipTags(clipId: number, tagIds: number[]): void {
  const handle = requireDb()
  withTransaction(() => {
    handle.prepare('delete from clip_tags where clip_id = ?').run(clipId)
    const ins = handle.prepare('insert or ignore into clip_tags (clip_id, tag_id) values (?, ?)')
    for (const id of tagIds) ins.run(clipId, id)
  })
}

/** 按标签查片段 id（片段视图的筛选用） */
export function listClipIdsByTag(tagId: number): number[] {
  const rows = requireDb()
    .prepare('select clip_id from clip_tags where tag_id = ?')
    .all(tagId) as unknown as Array<{ clip_id: number }>
  return rows.map((r) => r.clip_id)
}

/* -------------------------------- 视频作者 -------------------------------- */

/**
 * 记录一个视频的作者（B站 staff / owner）。
 *
 * 与 UP主 分开的理由：投稿账号决定归属分组，作者是内容署名，
 * 合作视频里两者常常不是同一个人。这里只做**平铺的署名关联**，
 * 不往资源树里加层级（那会把树搞乱，且与合作视频的直觉不符）。
 */
export function setVideoCreators(videoId: number, creators: Array<{ name: string; mid?: number | null }>): void {
  const handle = requireDb()
  const clean = creators
    .map((c) => ({ name: String(c.name ?? '').trim().slice(0, 60), mid: c.mid ?? null }))
    .filter((c) => c.name)
  withTransaction(() => {
    handle.prepare('delete from video_creators where video_id = ?').run(videoId)
    for (const c of clean) {
      let row = handle.prepare('select id from creators where name = ?').get(c.name) as
        | { id: number }
        | undefined
      if (!row) {
        const res = handle
          .prepare('insert into creators (name, mid, created_at) values (?, ?, ?)')
          .run(c.name, c.mid, Date.now())
        row = { id: Number(res.lastInsertRowid) }
      }
      handle
        .prepare('insert or ignore into video_creators (video_id, creator_id) values (?, ?)')
        .run(videoId, row.id)
    }
  })
}

/** 某个视频的作者名列表 */
export function listVideoCreators(videoId: number): string[] {
  const rows = requireDb()
    .prepare(
      `select c.name as name from video_creators vc
       join creators c on c.id = vc.creator_id
       where vc.video_id = ? order by c.name asc`
    )
    .all(videoId) as unknown as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/* -------------------------------- 分析结果 -------------------------------- */

/** 写入一条分析结果（同一对象 + 同一类型只保留最新一条） */
export function saveAnalysis(input: {
  targetType: AnalysisRecord['targetType']
  targetId: number
  kind: string
  payload: string
  provider?: string
}): number {
  const handle = requireDb()
  return Number(
    withTransaction(() => {
      handle
        .prepare('delete from analysis where target_type = ? and target_id = ? and kind = ?')
        .run(input.targetType, input.targetId, input.kind)
      const res = handle
        .prepare(
          `insert into analysis (target_type, target_id, kind, payload, provider, created_at)
           values (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.targetType,
          input.targetId,
          input.kind,
          input.payload,
          input.provider ?? 'manual',
          Date.now()
        )
      return Number(res.lastInsertRowid)
    })
  )
}

/** 读某个对象的分析结果（不传 kind 就是全部类型） */
export function listAnalysis(
  targetType: AnalysisRecord['targetType'],
  targetId: number,
  kind?: string
): AnalysisRecord[] {
  const handle = requireDb()
  const rows = (
    kind
      ? handle
          .prepare(
            'select * from analysis where target_type = ? and target_id = ? and kind = ? order by created_at desc'
          )
          .all(targetType, targetId, kind)
      : handle
          .prepare(
            'select * from analysis where target_type = ? and target_id = ? order by created_at desc'
          )
          .all(targetType, targetId)
  ) as unknown as Array<{
    id: number
    target_type: string
    target_id: number
    kind: string
    payload: string
    provider: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    targetType: r.target_type as AnalysisRecord['targetType'],
    targetId: r.target_id,
    kind: r.kind,
    payload: r.payload,
    provider: r.provider,
    createdAt: r.created_at
  }))
}

export function renameTag(id: number, name: string): void {
  const value = (name ?? '').trim().slice(0, 40)
  if (!value) return
  requireDb().prepare('update tags set name = ? where id = ?').run(value, id)
}

/** 删除标签本身（video_tags 由外键级联清理，不影响视频） */
export function deleteTag(id: number): void {
  requireDb().prepare('delete from tags where id = ?').run(id)
}

/** 某个视频身上的标签 id */
export function getVideoTagIds(videoId: number): number[] {
  const rows = requireDb()
    .prepare('select tag_id from video_tags where video_id = ?')
    .all(videoId) as unknown as Array<{ tag_id: number }>
  return rows.map((r) => r.tag_id)
}

/** 某个标签下的视频 id（用于资源树的「标签」分组） */
function videoIdsByTag(): Map<number, number[]> {
  const rows = requireDb()
    .prepare('select tag_id, video_id from video_tags order by video_id asc')
    .all() as unknown as Array<{ tag_id: number; video_id: number }>
  const out = new Map<number, number[]>()
  for (const r of rows) {
    const list = out.get(r.tag_id)
    if (list) list.push(r.video_id)
    else out.set(r.tag_id, [r.video_id])
  }
  return out
}

/* ---------------------------------- 建表 ---------------------------------- */

const SCHEMA = `
create table if not exists uploaders (
  id integer primary key autoincrement,
  uid integer,
  name text not null,
  avatar text,
  favorite integer not null default 0,
  created_at integer not null
);
-- UP主 身份只认 UID：同一个 UID 只能有一行
create unique index if not exists idx_uploaders_uid on uploaders(uid) where uid is not null;
create index if not exists idx_uploaders_name on uploaders(name) where uid is null;

create table if not exists collections (
  id integer primary key autoincrement,
  uploader_id integer references uploaders(id) on delete cascade,
  sid text,
  title text not null,
  url text,
  favorite integer not null default 0,
  created_at integer not null
);
create index if not exists idx_collections_uploader on collections(uploader_id);
-- 有 sid（B站合集 / 系列）时按「UP主 + sid」唯一，避免不同 UP主 互相串组
create unique index if not exists idx_collections_sid on collections(uploader_id, sid) where sid is not null;

create table if not exists videos (
  id integer primary key autoincrement,
  collection_id integer references collections(id) on delete cascade,
  bvid text not null default '',
  title text not null,
  url text not null default '',
  cover text,
  duration real,
  page_count integer,
  favorite integer not null default 0,
  created_at integer not null
);
create index if not exists idx_videos_collection on videos(collection_id);
-- 同一个 BV 号只允许一行（本地导入的 bvid 为空，不受此约束）
create unique index if not exists idx_videos_bvid on videos(bvid) where bvid <> '';

create table if not exists docs (
  id integer primary key autoincrement,
  video_id integer not null references videos(id) on delete cascade,
  page integer not null,
  lang text not null,
  label text not null,
  filename text not null,
  source text not null,
  favorite integer not null default 0,
  created_at integer not null
);
-- 去重键：同一视频 + 同一分P + 同一语言只保留一份
create unique index if not exists idx_docs_key on docs(video_id, page, lang);

create table if not exists cues (
  doc_id integer not null references docs(id) on delete cascade,
  idx integer not null,
  start real not null,
  end real not null,
  text text not null,
  primary key (doc_id, idx)
);
create index if not exists idx_cues_doc on cues(doc_id);

create table if not exists clips (
  id integer primary key autoincrement,
  -- 外键带级联：删文档时它的切片任务必须一起走，否则会留下指向不存在文档的孤儿任务
  doc_id integer not null references docs(id) on delete cascade,
  bvid text not null default '',
  page integer not null,
  start real not null,
  end real not null,
  note text not null,
  segments text,
  created_at integer not null
);
create index if not exists idx_clips_doc on clips(doc_id);

-- 跨文档全文检索。
-- 用 trigram 分词器：unicode61 会把一整串中文当成一个词，搜「高光」匹配不到「这是高光片段」，
-- 而 trigram 支持子串匹配（代价是查询串至少要 3 个字符，更短的查询由 searchCues 回退到 LIKE）。
-- rowid 与 cues.rowid 对齐，便于按文档批量清理。
create virtual table if not exists cue_search using fts5(
  text,
  doc_id unindexed,
  page unindexed,
  idx unindexed,
  tokenize='trigram'
);

-- 用户自定义标签（需求文档 §6 资源管理里的「分类」）。
-- 刻意做成标签而不是「手动分组」：自动层级（UP主 → 合集）已经表达了归属，
-- 标签是正交的另一维，一个视频可以同时属于「待剪辑」「重点」等多个标签。
create table if not exists tags (
  id integer primary key autoincrement,
  name text not null unique,
  created_at integer not null
);

create table if not exists video_tags (
  video_id integer not null references videos(id) on delete cascade,
  tag_id integer not null references tags(id) on delete cascade,
  primary key (video_id, tag_id)
);
create index if not exists idx_video_tags_tag on video_tags(tag_id);

-- ---------------------------------------------------------------------------
-- 导出任务（3.6.0 拆表）
--
-- 为什么从 clips 里拆出来：原来一张表同时承担三件事 ——
--   ① 待执行的切片队列  ② 已保存的片段库  ③ 任务来源（经 slice_history.clip_id）
-- 结果是「片段」与「任务」在界面上是同一批行，只是名字不同（审计点名的架构问题），
-- 而且「清空任务」会把用户攒的片段一起删掉。
--
-- 现在：
--   clips       = 用户确认并保存的、可复用的时间范围（名称/标签/收藏/来源）
--   export_jobs = 一次实际的输出请求（快照 + 状态 + 进度 + 错误 + 产物路径）
--
-- **快照是刻意的**：任务把 bvid/page/start/end/note 复制一份存下来，
-- 所以片段被改或删之后，历史任务仍能如实展示「当时切了什么」、也能据此重试。
-- 注意：本段在 JS 模板字符串里，**不能用反引号**标注表名（会提前闭合字符串）。
-- ---------------------------------------------------------------------------
create table if not exists export_jobs (
  id integer primary key autoincrement,
  -- 来源片段（仅作追溯，**不加外键**：片段删了历史也要留着）
  clip_id integer,
  -- 执行快照
  bvid text not null default '',
  page integer not null default 1,
  start real not null default 0,
  end real not null default 0,
  segments text,
  note text not null default '',
  -- 生命周期：pending → running → done / failed / canceled
  state text not null default 'pending',
  -- 0~100
  progress integer not null default 0,
  output text,
  message text,
  -- 队列顺序（只有 pending 状态有意义；原来这个顺序存在 clips.sort_order 上）
  sort_order integer not null default 0,
  created_at integer not null,
  started_at integer,
  finished_at integer
);
create index if not exists idx_export_jobs_state on export_jobs(state, sort_order asc);
create index if not exists idx_export_jobs_created on export_jobs(created_at desc);

-- ---------------------------------------------------------------------------
-- 【已废弃】切片历史（clips 拆表前的老表）
--
-- 数据在 runSchemaMigrations() 里迁进 export_jobs，之后不再写入。
-- 这里**不再建表**：老库里的那张表由迁移负责搬走并删除，
-- 新库直接就不会有它 —— 免得留一张永远为空的死表让人误会。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 第三阶段：素材库升级
-- ---------------------------------------------------------------------------

-- 视频作者（B站接口的 staff / owner）。与「UP主」是**正交**的两维：
-- UP主 是投稿账号（归属，决定资源树分组），作者是内容署名（合作视频有多个，
-- 出镜的人不一定是投稿的人）。刻意不做成层级，避免把资源树搞乱。
create table if not exists creators (
  id integer primary key autoincrement,
  name text not null unique,
  mid integer,
  created_at integer not null
);

create table if not exists video_creators (
  video_id integer not null references videos(id) on delete cascade,
  creator_id integer not null references creators(id) on delete cascade,
  primary key (video_id, creator_id)
);
create index if not exists idx_video_creators_creator on video_creators(creator_id);

-- 片段的标签（与视频标签同一套 tags 表，多一个关联方向）
create table if not exists clip_tags (
  clip_id integer not null references clips(id) on delete cascade,
  tag_id integer not null references tags(id) on delete cascade,
  primary key (clip_id, tag_id)
);
create index if not exists idx_clip_tags_tag on clip_tags(tag_id);

-- 分析结果：第三阶段先把表建好（结构稳定），写入能力在第六阶段接 AIProvider。
-- 知识图谱（第八阶段）：主题 → 视频 → 观点 → 片段。
--
-- 为什么主题要单独建表而不是塞进 analysis 的 JSON：
-- 主题层要**跨视频聚合**（「这个主题下有哪些视频」），必须能 join；
-- 而 analysis 是「一个对象一条结果」的形态，聚合起来只能全表扫 JSON。
create table if not exists topics (
  id integer primary key autoincrement,
  -- 主题词（同一份文档里抽出来的同一个词归一到一个 topic）
  term text not null unique,
  -- 全局统计：出现在多少个视频里 / 总命中次数（列表要按影响力排序）
  video_count integer not null default 0,
  total_count integer not null default 0
);

-- 视频 ↔ 主题：图谱的「主题 | 视频」这条边
create table if not exists video_topics (
  video_id integer not null,
  topic_id integer not null,
  -- 该主题在这个视频里出现的次数
  count integer not null default 0,
  -- 该视频的「主题分」（词频 × 稀有度），用于挑「这个视频主要在讲什么」
  score real not null default 0,
  primary key (video_id, topic_id)
);
create index if not exists idx_video_topics_topic on video_topics(topic_id);

-- 观点：从字幕里挑出的「像话的句子」，图谱的「视频 → 观点」与「观点 → 片段」两层
create table if not exists viewpoints (
  id integer primary key autoincrement,
  video_id integer not null,
  doc_id integer not null,
  page integer not null default 1,
  -- 该观点覆盖的字幕范围（首条字幕的序号 / 起止秒）
  first_idx integer not null,
  start real not null,
  end real not null,
  text text not null,
  score real not null default 0
);
create index if not exists idx_viewpoints_video on viewpoints(video_id, score desc);
create index if not exists idx_viewpoints_doc on viewpoints(doc_id);

-- 谁建的索引、什么时候建的（进度与「是否需要重建」的判断依据）
create table if not exists graph_meta (
  key text primary key,
  value text not null
);

-- 剪辑文案模板（第八阶段）。
--
-- 为什么建表而不是塞进 settings：
-- 模板是**用户会攒的一批内容**（多个模板、可增删改），塞进设置里的一个 JSON 字段
-- 会让「改一个模板」变成「重写整个字段」，而且没法单独查询/排序。
create table if not exists copy_templates (
  id text primary key,
  name text not null,
  description text not null default '',
  body text not null,
  builtin integer not null default 0,
  created_at integer not null
);

-- 故意设计成「一条分析结果 = 一个对象 + 一种类型」的通用表，
-- 这样摘要 / 标签建议 / 知识点 / 知识图谱的节点边都能放进来，不必频繁改表。
create table if not exists analysis (
  id integer primary key autoincrement,
  -- 分析对象：video / doc / cue / clip
  target_type text not null,
  target_id integer not null,
  -- 分析类型：summary / tags / keywords / outline / sentiment / graph
  kind text not null,
  -- 结果 JSON（结构随 kind 变，避免为每种分析各建一张表）
  payload text not null,
  -- 谁生成的：manual / local-model / 云端 provider 名
  provider text not null default 'manual',
  created_at integer not null
);
create index if not exists idx_analysis_target on analysis(target_type, target_id, kind);

-- 语义检索的「段落」（第四阶段下半）。
-- 一个段落 = 同一分P 内相邻若干条字幕合并成的一段话（默认 45 秒窗口）。
-- 不做「每条字幕一个向量」：真实库十万条字幕，逐条向量化要 7 分钟以上、还要存 200MB，
-- 而用户要的是「这个意思在哪一段」。
create table if not exists semantic_chunks (
  id integer primary key autoincrement,
  doc_id integer not null references docs(id) on delete cascade,
  page integer not null,
  /** 段落首句在文档内的原始序号（跳转定位用） */
  first_idx integer not null,
  start real not null,
  end real not null,
  text text not null,
  created_at integer not null
);
create index if not exists idx_semantic_chunks_doc on semantic_chunks(doc_id);

-- 段落向量。刻意与 semantic_chunks 分开：
-- 写向量是慢路径（要跑模型），而段落切分是快路径；分开后「切好了但还没算向量」
-- 是一个可表达的状态，也便于随时删掉向量重算。
create table if not exists semantic_vectors (
  chunk_id integer primary key references semantic_chunks(id) on delete cascade,
  dim integer not null,
  vector blob not null,
  model text not null default '',
  created_at integer not null
);
`

/* ---------------------------------- 状态 ---------------------------------- */

let db: DatabaseSync | null = null
let dbFile = ''
/** 老版本正文 JSON 所在目录（**只用于迁移**，新版本正文已入库） */
let legacyCacheDir = ''
/** 批量写入深度：>0 时复用外层事务 */
let batchDepth = 0
/** 记录 initDb 的参数，恢复备份后可以按同样的参数重开 */
let initArgs: { userDataDir: string; cacheDir?: string } | null = null

function requireDb(): DatabaseSync {
  if (!db) throw new Error('数据层尚未初始化（请先调用 initDb）')
  return db
}

/* --------------------------------- 初始化 --------------------------------- */

/**
 * 初始化数据层。
 * @param userDataDir Electron 的 userData 目录
 * @param customCacheDir 设置里指定的字幕缓存目录（**只用于迁移老数据**）
 */
export function initDb(userDataDir: string, customCacheDir?: string): void {
  // 防御：重复初始化时先关掉旧连接。
  // 否则旧的 DatabaseSync 句柄会泄漏，还会一直锁着数据库文件（WAL 删不掉、文件被占用）。
  if (db) closeDb()
  initArgs = { userDataDir, cacheDir: customCacheDir }
  const dataDir = join(userDataDir, APP_DATA_DIR)
  mkdirSync(dataDir, { recursive: true })
  dbFile = join(dataDir, 'srt-tool.db')
  legacyCacheDir = customCacheDir?.trim() ? customCacheDir.trim() : join(dataDir, 'docs')

  db = new DatabaseSync(dbFile)
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma synchronous = NORMAL')
  db.exec('pragma foreign_keys = ON')
  db.exec(SCHEMA)
  runSchemaMigrations()
  // 拆表迁移必须在建表之后、任何业务读写之前
  migrateClipsToExportJobs()

  // 首次运行时灌入内置文案模板（表非空就跳过，绝不覆盖用户改过的模板）
  seedCopyTemplatesIfEmpty(BUILTIN_COPY_TEMPLATES)

  migrateFromJson(dataDir, userDataDir)
  rescueLegacyCacheDocs(userDataDir)
}

/**
 * 内置文案模板的种子数据。
 *
 * 放在 db.ts 里（而不是 import `@shared/copyTemplate`）是为了避免建表逻辑
 * 与渲染逻辑互相依赖；两边的内容由 core.test.ts 的一致性断言盯着。
 */
const BUILTIN_COPY_TEMPLATES = [
  {
    id: 'shortvideo',
    name: '短视频发布文案',
    description: '一句话标题 + 三段式简介 + 话题标签',
    body: [
      '{title}',
      '',
      '{hook}',
      '',
      '【本期内容】',
      '{summary}',
      '',
      '⏱ 时长：{duration}',
      '{#tag}'
    ].join('\n')
  },
  {
    id: 'collection',
    name: '合集 / 系列文案',
    description: '适合把同一主题的多条片段攒起来发',
    body: [
      '{title}｜第 {episode} 期',
      '',
      '本期围绕「{topic}」整理了 {clipCount} 个片段：',
      '{@list:outline}',
      '',
      '素材来源：{uploader} · {bvid}',
      '{#tag}'
    ].join('\n')
  },
  {
    id: 'clipnote',
    name: '单条片段备注',
    description: '给某一条切片写备注，直接填进切片任务',
    body: '{title} · {start}-{end} ｜ {note}'
  }
]

/**
 * 补列迁移。
 *
 * `create table if not exists` 不会给**已存在**的表加新列，所以新增字段必须在这里补，
 * 否则老用户的库会缺列，查询直接报「no such column」。
 */
function runSchemaMigrations(): void {
  const handle = requireDb()
  const hasColumn = (table: string, column: string): boolean => {
    const cols = handle.prepare(`pragma table_info(${table})`).all() as unknown as Array<{
      name: string
    }>
    return cols.some((c) => c.name === column)
  }

  // 切片任务的手工排序（0 起，列表按它升序）
  //
  // 3.6.0 起这个顺序**属于队列而不是片段**，已搬到 `export_jobs.sort_order`；
  // 这里保留补列逻辑只为兼容老库（迁移在下面把它们读出去）。
  if (!hasColumn('clips', 'sort_order')) {
    handle.exec('alter table clips add column sort_order integer not null default 0')
    // 老数据按原有顺序（创建时间倒序 → id 升序）填一遍，保持观感不变
    const rows = handle
      .prepare('select id from clips order by created_at desc, id asc')
      .all() as unknown as Array<{ id: number }>
    const upd = handle.prepare('update clips set sort_order = ? where id = ?')
    rows.forEach((r, i) => upd.run(i, r.id))
  }

  /* ------------------------- 第三阶段：素材库升级 ------------------------- */

  // 片段名称（与「备注 / 输出文件名」分开：备注是产物名，名称是你在库里找它的名字）
  if (!hasColumn('clips', 'name')) {
    handle.exec("alter table clips add column name text not null default ''")
    // 老数据用备注兜底，避免片段列表一片空白
    handle.exec("update clips set name = note where name = ''")
  }

  // 片段来源：手动存下来的，还是从检索结果 / 切片产物归档来的
  if (!hasColumn('clips', 'source')) {
    handle.exec("alter table clips add column source text not null default 'manual'")
  }

  // 片段是否收藏（第三阶段：首页「收藏片段」要用）
  if (!hasColumn('clips', 'favorite')) {
    handle.exec('alter table clips add column favorite integer not null default 0')
  }

  // 标签颜色（第三阶段：标签体系升级）
  if (!hasColumn('tags', 'color')) {
    handle.exec("alter table tags add column color text not null default ''")
  }

  // 标签备注（说明这个标签用来干什么，避免攒出一堆「待定」）
  if (!hasColumn('tags', 'note')) {
    handle.exec("alter table tags add column note text not null default ''")
  }

  // 视频的语义中心（第八阶段：素材推荐要按「离主题最近」挑代表段落）。
  // 缓存它是因为求中心要扫该视频的全部段落向量，而这是会被反复点的操作。
  if (!hasColumn('videos', 'centroid')) {
    handle.exec('alter table videos add column centroid blob')
  }
  clearCorruptCentroids()
}

/**
 * 清掉长度不合理的语义中心缓存。
 *
 * 起因：第一版把平均向量（`Float64Array` 视图）按错误的字节长度写进库，
 * 读回来是 `-4.56e+27` 这种垃圾值，导致「某视频的段落与自己的平均向量相似度 < 0.05」
 * （数学上不可能），推荐功能表现为「永远挑不出段落」。
 * 正常写入是 `Float32`、长度 = 维度 × 4（本项目的模型是 512 维 → 2048 字节），
 * 所以**长度不是 4 的倍数倍数、或与任一现有向量的长度都不同的**，一律按损坏清掉。
 * 清掉只是让下次重算，代价极小；留着污染结果才是灾难。
 */
function clearCorruptCentroids(): void {
  const handle = requireDb()
  // 以现有段落向量的实际长度为准（同一次索引里它们必然一致）
  const ref = handle
    .prepare('select length(vector) as len from semantic_vectors limit 1')
    .get() as { len: number } | undefined
  if (!ref?.len) return
  const cleared = handle.prepare('update videos set centroid = null where centroid is not null and length(centroid) <> ?').run(ref.len)
  if (cleared.changes > 0) {
    console.log(`[db] 已清掉 ${cleared.changes} 个长度异常的语义中心缓存（会在下次推荐时重算）`)
  }
}

/**
 * 3.6.0 拆表迁移：把老的「任务队列」与「切片历史」搬进 `export_jobs`。
 *
 * ## 老模型长什么样
 *
 * 拆表前 `clips` 一表三义：每一行既是「待执行的任务」也是「已保存的片段」；
 * 跑完之后往 `slice_history` 记一条结果。所以「清空任务」会把用户攒的片段一起删掉 ——
 * 这正是要拆表的原因之一。
 *
 * ## 迁移怎么保证不丢东西
 *
 * - `clips` 里的行**全部保留为片段**（片段是用户资产，不能因为拆表就丢）；
 * - 同时按它们原来的 `sort_order` 生成对应的 `pending` 任务
 *   —— 老库里那些行本来就在队列里等着切片；
 * - `slice_history` 的每一行迁成一条已完成态任务（带上原状态/产物/错误信息），
 *   失败记录因此仍可重试。
 *
 * ## 幂等
 *
 * 只在 `export_jobs` 为空时执行，并在结束后删掉老表
 * —— 否则下次启动会把同样的记录再插一遍。
 */
function migrateClipsToExportJobs(): void {
  const handle = requireDb()
  const tableExists = (name: string): boolean =>
    Boolean(
      handle
        .prepare("select name from sqlite_master where type = 'table' and name = ?")
        .get(name)
    )

  const jobs = handle.prepare('select count(*) as n from export_jobs').get() as { n: number }
  if (jobs.n > 0) return

  const hasLegacyHistory = tableExists('slice_history')
  const clips = handle
    .prepare('select * from clips order by sort_order asc, id asc')
    .all() as unknown as Array<{
    id: number
    bvid: string
    page: number
    start: number
    end: number
    note: string
    segments: string | null
    created_at: number
  }>
  // 全新库（既没有片段也没有老历史）：无事可做，也不必建空表
  if (!clips.length && !hasLegacyHistory) return

  const insert = handle.prepare(
    `insert into export_jobs
       (clip_id, bvid, page, start, end, segments, note, state, progress, output, message,
        sort_order, created_at, started_at, finished_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  withTransaction(() => {
    // 1. 老队列 → pending 任务（顺序沿用原来的 sort_order）
    clips.forEach((c, i) => {
      insert.run(
        c.id,
        c.bvid,
        c.page,
        c.start,
        c.end,
        c.segments,
        c.note,
        'pending',
        0,
        null,
        null,
        i,
        c.created_at,
        null,
        null
      )
    })

    // 2. 老历史 → 终态任务（状态名一并映射）
    if (hasLegacyHistory) {
      const rows = handle
        .prepare('select * from slice_history order by created_at asc, id asc')
        .all() as unknown as Array<{
        clip_id: number | null
        note: string
        bvid: string
        page: number
        start: number
        end: number
        segments: string | null
        status: string
        output: string | null
        message: string | null
        created_at: number
      }>
      // 老状态：ok / error / canceled → 新状态：done / failed / canceled
      const map: Record<string, string> = { ok: 'done', error: 'failed', canceled: 'canceled' }
      let order = clips.length
      for (const r of rows) {
        const state = map[r.status] ?? 'done'
        insert.run(
          r.clip_id,
          r.bvid,
          r.page,
          r.start,
          r.end,
          r.segments,
          r.note,
          state,
          state === 'done' ? 100 : 0,
          r.output,
          r.message,
          order++,
          r.created_at,
          r.created_at,
          r.created_at
        )
      }
      handle.exec('drop table if exists slice_history')
    }

    // 3. 老队列顺序已搬到 export_jobs，clips 不再需要 sort_order
    if (hasColumnOf('clips', 'sort_order')) {
      handle.exec('alter table clips drop column sort_order')
    }
  })
  console.log(`[db] 已迁移导出任务：${clips.length} 条待处理 + 历史若干`)
}

/** `pragma table_info` 查列（迁移内部用，和 runSchemaMigrations 里那个同义） */
function hasColumnOf(table: string, column: string): boolean {
  const cols = requireDb()
    .prepare(`pragma table_info(${table})`)
    .all() as unknown as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

/** 表是否存在（测试用：验证拆表迁移真的把老表删掉了） */
export function hasTable(name: string): boolean {
  return Boolean(
    requireDb()
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .get(name)
  )
}

/** 列是否存在（测试用：验证 sort_order 已从 clips 移除） */
export function clipsHasColumn(column: string): boolean {
  return hasColumnOf('clips', column)
}

/**
 * 从旧版本的单文件 JSON（+ 每个文档一个正文 JSON）迁移到 SQLite。
 * 只在「新库还是空的 且 老文件存在」时执行；迁移完把老文件改名留档，不删除。
 */
function migrateFromJson(dataDir: string, userDataDir: string): void {
  const oldFile = join(dataDir, 'srt-tool.json')
  if (!existsSync(oldFile)) return

  const handle = requireDb()
  const existing = handle.prepare('select count(*) as n from videos').get() as { n: number }
  if (existing.n > 0) return // 新库里已经有数据了，不覆盖

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(oldFile, 'utf8')) as Record<string, unknown>
  } catch {
    return // 老文件坏了就跳过，不影响新库启动
  }

  const rows = <T>(key: string): T[] => (Array.isArray(parsed[key]) ? (parsed[key] as T[]) : [])
  const now = Date.now()

  try {
    withTransaction(() => {
      const insUploader = handle.prepare(
        'insert into uploaders (id, uid, name, avatar, favorite, created_at) values (?, ?, ?, ?, ?, ?)'
      )
      for (const u of rows<Record<string, unknown>>('uploaders')) {
        // 老版本字段名是 mid，v2 起统一成 uid
        const uid = u.uid != null ? u.uid : u.mid
        insUploader.run(
          Number(u.id),
          uid == null ? null : Number(uid),
          String(u.name ?? ''),
          u.avatar == null ? null : String(u.avatar),
          Number(u.favorite ?? 0),
          Number(u.createdAt ?? now)
        )
      }

      const insCollection = handle.prepare(
        'insert into collections (id, uploader_id, sid, title, url, favorite, created_at) values (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const c of rows<Record<string, unknown>>('collections')) {
        insCollection.run(
          Number(c.id),
          c.uploaderId == null ? null : Number(c.uploaderId),
          c.sid == null ? null : String(c.sid),
          String(c.title ?? ''),
          c.url == null ? null : String(c.url),
          Number(c.favorite ?? 0),
          Number(c.createdAt ?? now)
        )
      }

      const insVideo = handle.prepare(
        `insert into videos (id, collection_id, bvid, title, url, cover, duration, page_count, favorite, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const v of rows<Record<string, unknown>>('videos')) {
        insVideo.run(
          Number(v.id),
          v.collectionId == null ? null : Number(v.collectionId),
          String(v.bvid ?? ''),
          String(v.title ?? ''),
          String(v.url ?? ''),
          v.cover == null ? null : String(v.cover),
          v.duration == null ? null : Number(v.duration),
          v.pageCount == null ? null : Number(v.pageCount),
          Number(v.favorite ?? 0),
          Number(v.createdAt ?? now)
        )
      }

      const insDoc = handle.prepare(
        `insert into docs (id, video_id, page, lang, label, filename, source, favorite, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const d of rows<Record<string, unknown>>('docs')) {
        const docId = Number(d.id)
        insDoc.run(
          docId,
          Number(d.videoId),
          Number(d.page ?? 1),
          String(d.lang ?? 'unknown'),
          String(d.label ?? ''),
          String(d.filename ?? ''),
          String(d.source ?? 'local'),
          Number(d.favorite ?? 0),
          Number(d.createdAt ?? now)
        )
        const cues = readLegacyCues(docId, userDataDir)
        if (cues.length) saveCues(docId, cues)
      }

      const insClip = handle.prepare(
        `insert into clips (id, doc_id, bvid, page, start, end, note, segments, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const c of rows<Record<string, unknown>>('clips')) {
        insClip.run(
          Number(c.id),
          Number(c.docId),
          String(c.bvid ?? ''),
          Number(c.page ?? 1),
          Number(c.start ?? 0),
          Number(c.end ?? 0),
          String(c.note ?? ''),
          Array.isArray(c.segments) && c.segments.length > 1 ? JSON.stringify(c.segments) : null,
          Number(c.createdAt ?? now)
        )
      }
    })

    renameSync(oldFile, `${oldFile}.migrated-${Date.now()}`)
  } catch {
    // 迁移失败就保持原样：老文件还在，下次启动仍可重试
  }
}

/** 读老版本留在磁盘上的正文 JSON（当前缓存目录 + 历史遗留的 cache/docs） */
function readLegacyCues(docId: number, userDataDir: string): Cue[] {
  const candidates = [
    join(legacyCacheDir, `${docId}.json`),
    join(userDataDir, 'cache', 'docs', `${docId}.json`)
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Cue[]
      if (Array.isArray(parsed) && parsed.length) return parsed
    } catch {
      /* 单个文件坏了就试下一个 */
    }
  }
  return []
}

/**
 * 从历史遗留的 `<userData>/cache/docs` 抢救正文。
 * 那个目录会被 Chromium 的磁盘缓存接管，能救回多少算多少。
 */
function rescueLegacyCacheDocs(userDataDir: string): void {
  try {
    const legacy = join(userDataDir, 'cache', 'docs')
    if (!existsSync(legacy) || legacy === legacyCacheDir) return
    const handle = requireDb()
    for (const name of readdirSync(legacy)) {
      const docId = Number(name.replace(/\.json$/, ''))
      if (!Number.isFinite(docId)) continue
      const has = handle.prepare('select count(*) as n from cues where doc_id = ?').get(docId) as {
        n: number
      }
      if (has.n > 0) continue
      const cues = readLegacyCues(docId, userDataDir)
      if (cues.length) saveCues(docId, cues)
    }
  } catch {
    /* 抢救失败不影响启动 */
  }
}

/* --------------------------------- 事务 ---------------------------------- */

/**
 * 在事务里执行。**可重入**：已经在事务里时直接复用外层，
 * 否则里面任何一处（例如 `saveCues`）再开一次 BEGIN 都会让 SQLite 报
 * 「cannot start a transaction within a transaction」。
 */
function withTransaction<T>(fn: () => T): T {
  if (batchDepth > 0) return fn()
  const handle = requireDb()
  batchDepth++
  handle.exec('BEGIN')
  try {
    const out = fn()
    handle.exec('COMMIT')
    return out
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    batchDepth--
  }
}

/**
 * 把一段连续的写操作合并成一个 SQL 事务。
 * 批量拉字幕时从「每条一次写盘」降到「每批一次提交」，同时保证要么全成要么全不成。
 */
export function transaction<T>(fn: () => T): T {
  return withTransaction(fn)
}

/**
 * `transaction` 的异步版本（批量拉取要等网络，必须 await）。
 * 注意：事务期间不能有其他写操作插进来，所以这里独占 batchDepth。
 */
export async function transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
  if (batchDepth > 0) return await fn()
  const handle = requireDb()
  batchDepth++
  handle.exec('BEGIN')
  try {
    const out = await fn()
    handle.exec('COMMIT')
    return out
  } catch (err) {
    try {
      handle.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    batchDepth--
  }
}

export function closeDb(): void {
  if (!db) return
  try {
    db.exec('pragma wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
  try {
    db.close()
  } catch {
    /* ignore */
  }
  db = null
}

/* ------------------------------ 备份 / 恢复 / 诊断 ----------------------------- */

/** 数据库文件路径（备份、恢复、诊断用） */
export function dbFilePath(): string {
  return dbFile
}

/** 按上次的参数重新打开数据库（恢复备份之后调用） */
export function reopenDb(): void {
  if (initArgs) initDb(initArgs.userDataDir, initArgs.cacheDir)
}

/**
 * 导出成一个干净、自洽的数据库副本。
 * 用 `VACUUM INTO` 而不是直接复制文件：它会带上 WAL 里还没落盘的内容，
 * 并且目标文件不带 `-wal` / `-shm`，单个文件就能拿走。
 */
export function backupTo(target: string): void {
  const handle = requireDb()
  // VACUUM INTO 的路径是 SQL 表达式，单引号要转义（Windows 路径里少见但并非不可能）
  handle.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
}

/** 是不是一个 SQLite 文件（只查文件头，不打开，避免坏文件把主进程带崩） */
export function looksLikeSqliteFile(file: string): boolean {
  try {
    const head = readFileSync(file, { encoding: null }).subarray(0, 16).toString('latin1')
    return head.startsWith('SQLite format 3')
  } catch {
    return false
  }
}

/** 清空所有数据（保留表结构）。返回清掉的记录数。 */
export function clearAllData(): number {
  const handle = requireDb()
  const before = stats()
  withTransaction(() => {
    // 顺序无关紧要（有外键级联），但显式清一遍更直观。
    // tags 必须一起清 —— 否则「清空数据」后资源树里还挂着一个空的「标签」分组。
    handle.exec('delete from clips')
    handle.exec('delete from cue_search')
    handle.exec('delete from cues')
    handle.exec('delete from docs')
    handle.exec('delete from video_tags')
    handle.exec('delete from tags')
    handle.exec('delete from videos')
    handle.exec('delete from collections')
    handle.exec('delete from uploaders')
  })
  return before.uploaders + before.videos + before.docs + before.clips
}

/* --------------------------------- 正文读写 -------------------------------- */

function deleteCues(docId: number): void {
  const handle = requireDb()
  // FTS 表没有外键，必须显式清理，否则索引会残留已删文档的正文
  handle.prepare('delete from cue_search where doc_id = ?').run(docId)
  handle.prepare('delete from cues where doc_id = ?').run(docId)
}

/** 覆盖写入某个文档的字幕正文（同时维护全文索引） */
export function saveCues(docId: number, cues: Cue[]): void {
  const handle = requireDb()
  const run = (): void => {
    deleteCues(docId)
    const ins = handle.prepare(
      'insert into cues (doc_id, idx, start, end, text) values (?, ?, ?, ?, ?)'
    )
    cues.forEach((c, i) => {
      const idx = Number.isFinite(c.index) ? c.index : i + 1
      ins.run(docId, idx, Number(c.start) || 0, Number(c.end) || 0, String(c.text ?? ''))
    })
    // page 在 docs 上，cues 里没有，所以要 join 一下
    handle
      .prepare(
        `insert into cue_search (rowid, text, doc_id, page, idx)
         select c.rowid, c.text, c.doc_id, d.page, c.idx
         from cues c join docs d on d.id = c.doc_id
         where c.doc_id = ?`
      )
      .run(docId)
  }
  // 单独调用时自己开事务；已在批量事务里就直接做（否则会嵌套报错）
  if (batchDepth > 0) run()
  else withTransaction(run)
}

export function loadCues(docId: number): Cue[] {
  const rows = requireDb()
    .prepare('select idx, start, end, text from cues where doc_id = ? order by idx asc')
    .all(docId) as Array<{ idx: number; start: number; end: number; text: string }>
  return rows.map((r) => ({ index: r.idx, start: r.start, end: r.end, text: r.text }))
}

/* ------------------------------ 全文检索（FTS5） ----------------------------- */

/** 检索范围与筛选（第四阶段扩展；旧字段保持兼容） */
export interface CueSearchOptions extends CueSearchFilters {
  /** 本页最多返回多少条（默认 200，上限 2000） */
  limit?: number
  /** 跳过多少条（分页用；排序稳定，所以 offset 安全） */
  offset?: number
}

/**
 * 跨文档全文检索。
 *
 * 走 FTS5 的 trigram 索引，因此**查询串至少 3 个字符**；更短的查询（中文里很常见，
 * 比如「高光」）退回 LIKE 扫描 —— 索引用不上，但语义正确，几万条字幕量级也就几十毫秒。
 * FTS 查询若因任何原因失败（例如查询串里有特殊语法），也会自动回退到 LIKE。
 *
 * ## 第四阶段的改动
 *
 * 1. **排序有说法了**：原先按 `doc_id, idx` 排，结果里「标题就叫《高光时刻》的视频」
 *    和「正文里随口提了一句高光」混在一起、看不出谁更相关。
 *    现在按命中位置加权：标题 3 > 字幕文件名 2 > 正文 1，同级再按时间轴排。
 * 2. **筛选变多**：UP主 / 合集 / 视频 / 标签 / 收藏 / 入库时间 / 字幕时长。
 *    标签走 `in (小范围 id 列表)`，不引子查询 —— 标签总量本来就小。
 * 3. **分页**：`limit` + `offset`，配合 `searchCuesPage()` 一起给出总数。
 *
 * 权重与筛选都写在 SQL 里（而不是取回来在 JS 里再排），因为「先取 200 条再排」
 * 会把真正相关的那条挡在 200 名之外。
 */
function buildCueSearchWhere(
  keyword: string,
  options: CueSearchOptions,
  forceLike = false
): { where: string; params: Array<string | number> } {
  const parts: string[] = []
  const params: Array<string | number> = []

  // 命中条件：**正文 / 视频标题 / 字幕文件名** 任一包含关键词。
  //
  // 为什么要带上标题与文件名：第四阶段的排序里「标题命中」排在正文命中之前，
  // 如果命中判定只看正文，那些最相关的标题匹配结果会在 SQL 阶段就被筛掉，
  // 排序权重形同虚设（这一点是 smoke 测试逼出来的：改完排序后
  // 「改写正文后旧句子不该还能搜到」直接失败 —— 因为旧关键词还挂在标题上）。
  //
  // 长查询走 FTS 子查询（快）+ 标题/文件名 LIKE 兜底；短查询全部走 LIKE。
  if (keyword.length >= 3 && !forceLike) {
    parts.push(
      `(c.doc_id in (select doc_id from cue_search where cue_search match ?)
        or v.title like ? escape '\\'
        or d.filename like ? escape '\\')`
    )
    params.push(`"${keyword.replace(/"/g, '""')}"`)
    params.push(escapeLike(keyword))
    params.push(escapeLike(keyword))
  } else {
    parts.push(
      `(c.text like ? escape '\\' or v.title like ? escape '\\' or d.filename like ? escape '\\')`
    )
    const like = escapeLike(keyword)
    params.push(like, like, like)
  }

  // 可选范围
  if (options.videoId) {
    parts.push('d.video_id = ?')
    params.push(options.videoId)
  }
  if (options.collectionId) {
    parts.push('v.collection_id = ?')
    params.push(options.collectionId)
  }
  if (options.uploaderId) {
    parts.push('col.uploader_id = ?')
    params.push(options.uploaderId)
  }
  if (options.favoriteOnly) {
    parts.push('v.favorite = 1')
  }
  if (options.createdFrom) {
    parts.push('v.created_at >= ?')
    params.push(options.createdFrom)
  }
  if (options.createdTo) {
    parts.push('v.created_at <= ?')
    params.push(options.createdTo)
  }
  if (typeof options.minDuration === 'number' && Number.isFinite(options.minDuration)) {
    parts.push('(c.end - c.start) >= ?')
    params.push(options.minDuration)
  }
  if (typeof options.maxDuration === 'number' && Number.isFinite(options.maxDuration)) {
    parts.push('(c.end - c.start) <= ?')
    params.push(options.maxDuration)
  }

  const tags = (options.tagIds ?? []).map((n) => Math.trunc(Number(n))).filter((n) => n > 0)
  if (tags.length) {
    parts.push(
      `v.id in (select video_id from video_tags where tag_id in (${tags.map(() => '?').join(', ')}))`
    )
    params.push(...tags)
  }

  return { where: parts.join(' and '), params }
}

/** LIKE 通配符转义（`%` `_` `\` 都要转，否则用户输入会被当通配符） */
function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/** 单次查询的硬上限：再大也不给（避免一次把几十万条塞进渲染进程） */
const CUE_SEARCH_MAX = 2000

/**
 * 「命中总数」的统计上限。
 *
 * 现实场景：按视频标题搜（如「萌音杂谈」）会命中那些视频的**每一条**字幕，
 * 几百个视频 × 上千条字幕 = 二十多万行。真把它们全查出来再 slice，
 * 既慢又毫无意义（没人会翻第 212664 条）。
 * 所以到 5000 就停手：`total` 会是 5000（`totalCapped: true`），
 * 界面显示「5000+」，引导用户去加筛选条件而不是继续翻页。
 */
const CUE_SEARCH_COUNT_CAP = 5000

export function searchCuesPage(
  keyword: string,
  options: CueSearchOptions = {},
  forceLike = false
): CueSearchPage {
  const kw = (keyword ?? '').trim()
  if (!kw) return { hits: [], total: 0, returned: 0, hasMore: false }

  const handle = requireDb()
  const limit = Math.max(1, Math.min(CUE_SEARCH_MAX, Math.trunc(options.limit ?? 200)))
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))

  const { where, params } = buildCueSearchWhere(kw, options, forceLike)
  const like = escapeLike(kw)

  // 权重：标题命中 3 > 字幕文件名命中 2 > 正文命中 1。
  // 参数顺序必须与下面 SQL 里的 ? 一一对应：先三个 case，再 where 的 params。
  const sql = `
    select c.doc_id as docId, d.video_id as videoId, v.bvid as bvid, d.page as page,
           c.idx as idx, c.start as start, c.end as end, c.text as text,
           v.title as videoTitle, d.label as docLabel, d.filename as filename,
           col.uploader_id as uploaderId, v.collection_id as collectionId,
           case
             when v.title like ? escape '\\' then 3
             when d.filename like ? escape '\\' then 2
             else 1
           end as hitWeight
    from cues c
    join docs d on d.id = c.doc_id
    join videos v on v.id = d.video_id
    left join collections col on col.id = v.collection_id
    where ${where}
    order by hitWeight desc, v.created_at desc, c.doc_id asc, c.idx asc`

  let rows: Array<Record<string, unknown>> = []
  try {
    rows = handle.prepare(sql).all(like, like, ...params) as Array<Record<string, unknown>>
  } catch {
    // FTS 语法问题（例如查询串里带特殊字符）时退回 LIKE，语义等价
    if (kw.length >= 3) {
      return searchCuesPage(keyword, { ...options, limit, offset }, true)
    }
    return { hits: [], total: 0, returned: 0, hasMore: false }
  }

  // 命中判定放宽到「标题 / 文件名」后，命中行数可能非常大（按标题搜会命中该视频的每一条字幕），
  // 所以统计到 CAP 就停手，并把这件事告诉调用方（totalCapped）。
  const filtered = forceLike
    ? rows
    : rows.filter(
        (r) =>
          String(r.text).includes(kw) ||
          String(r.videoTitle).includes(kw) ||
          String(r.filename).includes(kw)
      )

  const totalCapped = filtered.length > CUE_SEARCH_COUNT_CAP
  const total = totalCapped ? CUE_SEARCH_COUNT_CAP : filtered.length
  const page = filtered.slice(offset, offset + limit)

  const uploaderName = handle.prepare('select name from uploaders where id = ?')
  const uploaderCache = new Map<number, string>()

  const hits = page.map((r) => {
    const uploaderId = r.uploaderId == null ? null : Number(r.uploaderId)
    const cacheKey = uploaderId ?? -1
    let name = uploaderCache.get(cacheKey)
    if (name === undefined) {
      const hit =
        uploaderId !== null
          ? (uploaderName.get(uploaderId) as { name: string } | undefined)
          : undefined
      name = hit?.name ?? ''
      uploaderCache.set(cacheKey, name)
    }
    return {
      docId: Number(r.docId),
      videoId: Number(r.videoId),
      bvid: String(r.bvid ?? ''),
      page: Number(r.page),
      index: Number(r.idx),
      start: Number(r.start),
      end: Number(r.end),
      text: String(r.text),
      videoTitle: normalizeVideoTitle(String(r.videoTitle ?? ''), { uploaderName: name }),
      docLabel: String(r.docLabel ?? ''),
      uploaderName: name,
      uploaderId,
      collectionId: r.collectionId == null ? null : Number(r.collectionId),
      hitWeight: Number(r.hitWeight ?? 1)
    }
  })

  return { hits, total, returned: hits.length, hasMore: offset + hits.length < total, totalCapped }
}

/**
 * 兼容入口：只要命中列表时用它（内部走 `searchCuesPage`）。
 * 保留旧签名是为了不惊动既有调用点与测试。
 */
export function searchCues(keyword: string, options: CueSearchOptions = {}): CueSearchHit[] {
  return searchCuesPage(keyword, options).hits
}

/* --------------------------------- 资源写入 -------------------------------- */

export function upsertUploader(uid: number | null, name: string, avatar?: string): number {
  const handle = requireDb()
  if (uid) {
    const hit = handle.prepare('select * from uploaders where uid = ?').get(uid) as
      | UploaderRow
      | undefined
    if (hit) {
      if (hit.name !== name || (avatar && hit.avatar !== avatar)) {
        handle
          .prepare('update uploaders set name = ?, avatar = coalesce(?, avatar) where id = ?')
          .run(name, avatar ?? null, hit.id)
      }
      return hit.id
    }
  } else {
    const hit = handle
      .prepare('select id from uploaders where uid is null and name = ?')
      .get(name) as { id: number } | undefined
    if (hit) return hit.id
  }

  const res = handle
    .prepare(
      'insert into uploaders (uid, name, avatar, favorite, created_at) values (?, ?, ?, 0, ?)'
    )
    .run(uid ?? null, name, avatar ?? null, Date.now())
  return Number(res.lastInsertRowid)
}

export function upsertCollection(
  uploaderId: number | null,
  sid: string | null,
  title: string,
  url?: string
): number {
  const handle = requireDb()
  // 有 sid（B站合集 / 系列）时按「UP主 + sid」定位，否则按「UP主 + 标题」定位。
  // 用 `is ?` 而不是 `= ?`，这样 uploaderId 为 null 时也能正确比较。
  const hit = sid
    ? (handle
        .prepare('select * from collections where sid = ? and uploader_id is ?')
        .get(sid, uploaderId ?? null) as CollectionRow | undefined)
    : (handle
        .prepare('select * from collections where sid is null and title = ? and uploader_id is ?')
        .get(title, uploaderId ?? null) as CollectionRow | undefined)

  if (hit) {
    if ((title && hit.title !== title) || (url && hit.url !== url)) {
      handle
        .prepare(
          'update collections set title = coalesce(nullif(?, \'\'), title), url = coalesce(?, url) where id = ?'
        )
        .run(title ?? '', url ?? null, hit.id)
    }
    return hit.id
  }

  const res = handle
    .prepare(
      'insert into collections (uploader_id, sid, title, url, favorite, created_at) values (?, ?, ?, ?, 0, ?)'
    )
    .run(uploaderId ?? null, sid ?? null, title, url ?? null, Date.now())
  return Number(res.lastInsertRowid)
}

export function upsertVideo(
  collectionId: number | null,
  bvid: string,
  title: string,
  extra: Partial<Pick<VideoItem, 'url' | 'cover' | 'duration' | 'pageCount'>> = {}
): number {
  const handle = requireDb()
  if (bvid) {
    const hit = handle.prepare('select * from videos where bvid = ?').get(bvid) as
      | VideoRow
      | undefined
    if (hit) {
      const moved = collectionId != null && hit.collection_id !== collectionId
      handle
        .prepare(
          `update videos set
             title = coalesce(nullif(?, ''), title),
             url = coalesce(?, url),
             cover = coalesce(?, cover),
             duration = coalesce(?, duration),
             page_count = coalesce(?, page_count),
             collection_id = coalesce(?, collection_id)
           where id = ?`
        )
        .run(
          title ?? '',
          extra.url ?? null,
          extra.cover ?? null,
          extra.duration ?? null,
          extra.pageCount ?? null,
          collectionId ?? null,
          hit.id
        )
      // 视频换了归属分组（插件先占位、随后补上真实 UP主/合集）时清理空掉的旧分组
      if (moved) pruneEmptyGroups()
      return hit.id
    }
  }

  const res = handle
    .prepare(
      `insert into videos (collection_id, bvid, title, url, cover, duration, page_count, favorite, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      collectionId ?? null,
      bvid,
      title,
      extra.url ?? '',
      extra.cover ?? null,
      extra.duration ?? null,
      extra.pageCount ?? null,
      Date.now()
    )
  return Number(res.lastInsertRowid)
}

/** 定位「同一视频 + 同一分P + 同一语言」的字幕文档（去重用） */
export function findDoc(videoId: number, page: number, lang: string): DocRow | undefined {
  return requireDb()
    .prepare('select * from docs where video_id = ? and page = ? and lang = ?')
    .get(videoId, page, lang) as DocRow | undefined
}

export interface UpsertDocResult {
  docId: number
  /** true = 新建；false = 覆盖了已有的同语言文档 */
  created: boolean
  /** 覆盖时原有的字幕条数，便于界面提示「更新」而不是「导入」 */
  previousCount: number
}

/**
 * 写入字幕文档。
 * **去重键是「视频 + 分P + 语言」**：同一条字幕轨重复拉取 / 重复推送时原地覆盖。
 */
export function upsertDoc(
  videoId: number,
  page: number,
  lang: string,
  label: string,
  filename: string,
  source: 'local' | 'bilibili',
  cues: Cue[]
): UpsertDocResult {
  const handle = requireDb()
  const hit = findDoc(videoId, page, lang)
  if (hit) {
    const previousCount = (
      handle.prepare('select count(*) as n from cues where doc_id = ?').get(hit.id) as { n: number }
    ).n
    handle
      .prepare(
        `update docs set
           label = coalesce(nullif(?, ''), label),
           filename = coalesce(nullif(?, ''), filename),
           source = ?
         where id = ?`
      )
      .run(label ?? '', filename ?? '', source, hit.id)
    saveCues(hit.id, cues)
    return { docId: hit.id, created: false, previousCount }
  }

  const res = handle
    .prepare(
      `insert into docs (video_id, page, lang, label, filename, source, favorite, created_at)
       values (?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(videoId, page, lang, label, filename, source, Date.now())
  const docId = Number(res.lastInsertRowid)
  saveCues(docId, cues)
  return { docId, created: true, previousCount: 0 }
}

/** 兼容旧调用：写入并只返回文档 id */
export function addDoc(
  videoId: number,
  page: number,
  lang: string,
  label: string,
  filename: string,
  source: 'local' | 'bilibili',
  cues: Cue[]
): number {
  return upsertDoc(videoId, page, lang, label, filename, source, cues).docId
}

export function updateDocCues(docId: number, cues: Cue[]): void {
  saveCues(docId, cues)
  // 正文变了，语义段落与向量就过期了（段落文本来自旧正文）。
  // 这里直接清掉，等下一轮建索引时按新正文重新切、重新算。
  clearDocChunks(docId)
}

/** 应用数据目录（模型缓存等外部文件放这里；未初始化时返回空串） */
export function dataDir(): string {
  return dbFile ? dirname(dbFile) : ''
}

/* --------------------------------- 资源读取 -------------------------------- */

function toDoc(r: DocRow): SubtitleDoc {
  return {
    id: r.id,
    videoId: r.video_id,
    page: r.page,
    lang: r.lang,
    label: r.label,
    filename: r.filename,
    source: r.source,
    createdAt: r.created_at
  }
}

/**
 * 数据库行 → 领域对象。
 *
 * **标题在这里统一规范化**（第九阶段新增）。
 * 之所以放在这个出口而不是改数据库：
 * - `toVideo()` 是**所有**视频数据的唯一映射点（`getVideo` / 资源树 / 检索结果都走它），
 *   在这里处理即「一处生效」，不会出现「列表里是规范的、搜索里还是旧的」；
 * - 规范函数是**幂等**的（有测试盯着），所以即使库里已是新标题也不会重复改写；
 * - 不改库意味着**不需要迁移、可随时回退** —— 用户想回到原始 B站 标题时，
 *   只要去掉这一行即可，数据没有被破坏。
 *
 * @param uploaderName UP主 名、@param collectionName 合集/频道名。
 *   规范格式是「日期 UP主 内容」，所以要把名字传下去，否则中间那一格是空的。
 *   两个都要传：实测投稿账号与频道名会不同（账号 `恩仙仙` / 频道 `弥雾meow`），
 *   而标题括号里写的是频道名。拿不到时标题仍能正确解析，只是少一格。
 */
function toVideo(r: VideoRow, uploaderName?: string, collectionName?: string): VideoItem {
  return {
    id: r.id,
    collectionId: r.collection_id,
    bvid: r.bvid,
    title: normalizeVideoTitle(r.title, { uploaderName, collectionName }),
    url: r.url,
    cover: r.cover,
    duration: r.duration,
    pageCount: r.page_count,
    createdAt: r.created_at
  }
}

export function getDoc(docId: number): SubtitleDoc | null {
  const row = requireDb().prepare('select * from docs where id = ?').get(docId) as
    | DocRow
    | undefined
  return row ? toDoc(row) : null
}

/** 同一视频下的全部字幕文档，按分P 排序 */
export function listDocsByVideo(videoId: number): SubtitleDoc[] {
  const rows = requireDb()
    .prepare('select * from docs where video_id = ? order by page asc, created_at asc')
    .all(videoId) as unknown as DocRow[]
  return rows.map(toDoc)
}

/** 按 BV 号查找视频（插件推送字幕时用） */
export function findVideoByBvid(bvid: string): VideoItem | null {
  const row = requireDb().prepare('select * from videos where bvid = ?').get(bvid) as
    | VideoRow
    | undefined
  return row ? toVideo(row) : null
}

/**
 * 按标题查找「本地导入」的视频条目（也就是没有 BV 号的那些）。
 * 重复导入同一个文件时会复用它，不会每次都新建一个视频节点。
 */
export function findLocalVideo(title: string): VideoItem | null {
  const row = requireDb()
    .prepare("select * from videos where bvid = '' and title = ? limit 1")
    .get(title) as VideoRow | undefined
  return row ? toVideo(row) : null
}

export function getVideo(videoId: number): (VideoItem & { uploaderName?: string }) | null {
  const row = requireDb()
    .prepare(
      `select v.*, u.name as uploaderName, c.title as collectionName
       from videos v
       left join collections c on c.id = v.collection_id
       left join uploaders u on u.id = c.uploader_id
       where v.id = ?`
    )
    .get(videoId) as (VideoRow & { uploaderName: string | null; collectionName: string | null }) | undefined
  if (!row) return null
  const upName = row.uploaderName ?? undefined
  const colName = row.collectionName ?? undefined
  return { ...toVideo(row, upName, colName), uploaderName: upName }
}

/* --------------------------------- 资源树 --------------------------------- */

/** 语言代码 → 展示名（有 B站 返回的 label 时优先用 label） */
const LANG_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-Hans': '简体中文',
  'zh-TW': '繁体中文',
  'zh-Hant': '繁体中文',
  'ai-zh': '简体中文（AI）',
  en: 'English',
  'en-US': 'English',
  'ai-en': 'English（AI）',
  ja: '日本語',
  ko: '한국어',
  local: '本地字幕'
}

function docNode(d: DocRow): TreeNode {
  return {
    key: `doc:${d.id}`,
    type: 'doc',
    label: d.label || LANG_LABELS[d.lang] || d.lang || d.filename || `第 ${d.page} P`,
    subtitle: `${d.source === 'bilibili' ? 'B站' : '本地'} · 第${d.page}P`,
    favorite: Boolean(d.favorite),
    payload: toDoc(d)
  }
}

/**
 * 构建左侧资源树。
 *
 * 分组规则（不管数据来自桌面端拉取、插件推送还是本地导入，都走同一套）：
 *   UP主（按 UID 唯一）→ 合集（真实合集才有 sid）→ 视频 → 字幕
 * 空分组不会出现在树里，所以插件占位残留不会越攒越多。
 * 只取元数据、不碰字幕正文，所以几万条字幕也不会拖慢这里。
 */
export function buildTree(): TreeNode[] {
  const handle = requireDb()
  const uploaders = handle
    .prepare('select * from uploaders order by created_at asc, id asc')
    .all() as unknown as UploaderRow[]
  const collections = handle
    .prepare('select * from collections order by created_at asc, id asc')
    .all() as unknown as CollectionRow[]
  const videos = handle
    .prepare('select * from videos order by created_at asc, id asc')
    .all() as unknown as VideoRow[]
  const docs = handle
    .prepare('select * from docs order by page asc, created_at asc, id asc')
    .all() as unknown as DocRow[]

  const docsByVideo = new Map<number, DocRow[]>()
  for (const d of docs) {
    const list = docsByVideo.get(d.video_id)
    if (list) list.push(d)
    else docsByVideo.set(d.video_id, [d])
  }

  const videosByCollection = new Map<number, VideoRow[]>()
  const orphanVideos: VideoRow[] = []
  for (const v of videos) {
    if (v.collection_id == null) {
      orphanVideos.push(v)
      continue
    }
    const list = videosByCollection.get(v.collection_id)
    if (list) list.push(v)
    else videosByCollection.set(v.collection_id, [v])
  }

  const collectionsByUploader = new Map<number, CollectionRow[]>()
  for (const c of collections) {
    if (c.uploader_id == null) continue
    const list = collectionsByUploader.get(c.uploader_id)
    if (list) list.push(c)
    else collectionsByUploader.set(c.uploader_id, [c])
  }

  /** 视频的署名（投稿账号名 + 合集/频道名；本地导入的视频两者皆空） */
  const uploaderById = new Map<number, string>()
  for (const u of uploaders) uploaderById.set(u.id, u.name)
  const collectionById = new Map<number, CollectionRow>()
  for (const c of collections) collectionById.set(c.id, c)
  const namesOfVideo = (v: VideoRow): { uploaderName: string; collectionName: string } => {
    if (v.collection_id == null) return { uploaderName: '', collectionName: '' }
    const col = collectionById.get(v.collection_id)
    if (!col) return { uploaderName: '', collectionName: '' }
    return {
      uploaderName: col.uploader_id == null ? '' : (uploaderById.get(col.uploader_id) ?? ''),
      collectionName: col.title ?? ''
    }
  }

  // 每个视频身上的标签名（树里直接显示，不用再查一次）
  const tagsByVideo = new Map<number, string[]>()
  for (const row of handle
    .prepare(
      `select vt.video_id as videoId, t.name as name
       from video_tags vt join tags t on t.id = vt.tag_id
       order by t.name asc`
    )
    .all() as unknown as Array<{ videoId: number; name: string }>) {
    const list = tagsByVideo.get(row.videoId)
    if (list) list.push(row.name)
    else tagsByVideo.set(row.videoId, [row.name])
  }

  const videoNode = (v: VideoRow): TreeNode => {
    const list = docsByVideo.get(v.id) ?? []
    const where = v.bvid || '本地'
    return {
      key: `video:${v.id}`,
      type: 'video',
      /**
       * 标题要**与 `toVideo()` 走同一套规范化**。
       *
       * 这里原来直接读 `v.title`，于是出现过「列表里是规范标题、树上还是旧的」——
       * 标题规范化的意义就是「按时间找素材时一眼能排序」，两边不一致等于没做。
       * UP主 名从 collection → uploader 查出来，好让规范化能填上「日期 UP主 内容」的中间那格。
       */
      label:
        normalizeVideoTitle(v.title, {
          uploaderName: namesOfVideo(v).uploaderName,
          collectionName: namesOfVideo(v).collectionName
        }) ||
        v.bvid ||
        '未命名字幕',
      subtitle: list.length ? `${where} · ${list.length} 条字幕` : where,
      favorite: Boolean(v.favorite),
      videoId: v.id,
      tags: tagsByVideo.get(v.id) ?? [],
      children: list.map(docNode)
    }
  }

  const nodes: TreeNode[] = []

  // 标签视图放在最前面：它是用户自己筛出来的重点，比自动层级更常看
  const allTags = listTags()
  if (allTags.length) {
    const grouped = videoIdsByTag()
    const videoById = new Map(videos.map((v) => [v.id, v]))
    nodes.push({
      key: 'tags',
      type: 'tags',
      label: '标签',
      subtitle: `${allTags.length} 个标签`,
      children: allTags.map((t) => {
        const list = (grouped.get(t.id) ?? [])
          .map((id) => videoById.get(id))
          .filter((v): v is VideoRow => Boolean(v))
        return {
          key: `tag:${t.id}`,
          type: 'tag' as const,
          label: t.name,
          subtitle: `${list.length} 个视频`,
          children: list.map(videoNode)
        }
      })
    })
  }

  for (const up of uploaders) {
    const colNodes: TreeNode[] = []
    for (const c of collectionsByUploader.get(up.id) ?? []) {
      const vids = videosByCollection.get(c.id) ?? []
      if (!vids.length) continue // 空分组不显示
      colNodes.push({
        key: `collection:${c.id}`,
        type: 'collection',
        label: c.title,
        // 标签本身已经说明了是合集还是单视频，这里只显示体量
        subtitle: `${vids.length} 个视频`,
        favorite: Boolean(c.favorite),
        children: vids.map(videoNode)
      })
    }
    if (!colNodes.length) continue // 没有视频的 UP主 不显示
    nodes.push({
      key: `uploader:${up.id}`,
      type: 'uploader',
      label: up.name,
      subtitle: up.uid ? `UID ${up.uid}` : '本地',
      favorite: Boolean(up.favorite),
      children: colNodes
    })
  }

  if (orphanVideos.length) {
    nodes.push({
      key: 'orphan',
      type: 'collection',
      label: '未分类视频',
      subtitle: `未分类 · ${orphanVideos.length}`,
      children: orphanVideos.map(videoNode)
    })
  }

  return nodes
}

/**
 * 清理空分组：没有任何视频的合集，以及没有任何合集的 UP主。
 * @returns 被清掉的节点数
 */
export function pruneEmptyGroups(): number {
  const handle = requireDb()
  const cols = handle
    .prepare(
      'delete from collections where id not in (select distinct collection_id from videos where collection_id is not null)'
    )
    .run().changes
  const ups = handle
    .prepare(
      'delete from uploaders where id not in (select distinct uploader_id from collections where uploader_id is not null)'
    )
    .run().changes
  return Number(cols) + Number(ups)
}

/* ---------------------------------- 删除 ---------------------------------- */

export function deleteDoc(docId: number): void {
  const handle = requireDb()
  handle.prepare('delete from clips where doc_id = ?').run(docId)
  deleteCues(docId)
  handle.prepare('delete from docs where id = ?').run(docId)
}

export function deleteVideo(videoId: number): void {
  const handle = requireDb()
  // 外键级联会清掉 docs → cues，但 FTS 索引与 clips 不走级联（老库的 clips 也没有外键），
  // 所以这两处必须显式清，否则会留下搜得到却打不开的残留。
  const docIds = 'select id from docs where video_id = ?'
  handle.prepare(`delete from clips where doc_id in (${docIds})`).run(videoId)
  handle.prepare(`delete from cue_search where doc_id in (${docIds})`).run(videoId)
  handle.prepare('delete from videos where id = ?').run(videoId)
  pruneEmptyGroups()
}

export function deleteCollection(collectionId: number): void {
  const handle = requireDb()
  const docIds = `select d.id from docs d join videos v on v.id = d.video_id where v.collection_id = ?`
  handle.prepare(`delete from clips where doc_id in (${docIds})`).run(collectionId)
  handle.prepare(`delete from cue_search where doc_id in (${docIds})`).run(collectionId)
  handle.prepare('delete from collections where id = ?').run(collectionId)
  pruneEmptyGroups()
}

export function deleteUploader(uploaderId: number): void {
  const handle = requireDb()
  const docIds = `select d.id from docs d
                  join videos v on v.id = d.video_id
                  join collections c on c.id = v.collection_id
                  where c.uploader_id = ?`
  handle.prepare(`delete from clips where doc_id in (${docIds})`).run(uploaderId)
  handle.prepare(`delete from cue_search where doc_id in (${docIds})`).run(uploaderId)
  handle.prepare('delete from uploaders where id = ?').run(uploaderId)
  pruneEmptyGroups()
}

/** 通用删除入口：根据节点 key 分派 */
export function deleteNode(key: string): void {
  const [type, idRaw] = key.split(':')
  const id = Number(idRaw)
  if (!id) return
  if (type === 'doc') deleteDoc(id)
  else if (type === 'video') deleteVideo(id)
  else if (type === 'collection') deleteCollection(id)
  else if (type === 'uploader') deleteUploader(id)
}

/* ------------------------------ 删除与恢复（撤销） ----------------------------- */

/**
 * 被删除子树的快照。
 *
 * 删除是破坏性的：本地导入的字幕、手工改过的正文，删掉就再也拉不回来了
 * （早期版本的注释认为「重新拉取成本很低」，这只对纯 B站 来源成立）。
 * 所以删除前把整棵子树导出成快照，撤销时按原 id 写回去。
 */
export interface NodeSnapshot {
  uploaders: UploaderRow[]
  collections: CollectionRow[]
  videos: VideoRow[]
  docs: DocRow[]
  cues: Array<{ doc_id: number; idx: number; start: number; end: number; text: string }>
  clips: ClipRow[]
  /** 这些视频身上的标签（标签本身也在 tags 里，恢复时一并写回） */
  tags: TagRow[]
  videoTags: Array<{ video_id: number; tag_id: number }>
}

type Row = Record<string, unknown>

function queryRows<T>(sql: string, params: Array<number | string | null>): T[] {
  return requireDb()
    .prepare(sql)
    .all(...params) as unknown as T[]
}

/** 导出某个节点（含其下所有内容）的快照；节点不存在时返回 null */
export function exportNode(key: string): NodeSnapshot | null {
  const [type, idRaw] = key.split(':')
  const id = Number(idRaw)
  if (!id) return null

  const snap: NodeSnapshot = {
    uploaders: [],
    collections: [],
    videos: [],
    docs: [],
    cues: [],
    clips: [],
    tags: [],
    videoTags: []
  }

  const collectByVideos = (videoIds: number[]): void => {
    if (!videoIds.length) return
    const marks = videoIds.map(() => '?').join(',')
    snap.docs = queryRows<DocRow>(`select * from docs where video_id in (${marks})`, videoIds)
    const docIds = snap.docs.map((d) => d.id)
    if (docIds.length) {
      const dMarks = docIds.map(() => '?').join(',')
      snap.cues = queryRows(`select * from cues where doc_id in (${dMarks})`, docIds)
      snap.clips = queryRows<ClipRow>(`select * from clips where doc_id in (${dMarks})`, docIds)
    }
    // 标签与视频的关联也要一起留档，否则「撤销删除」会把标签悄悄丢掉
    snap.videoTags = queryRows(`select * from video_tags where video_id in (${marks})`, videoIds)
    const tagIds = [...new Set(snap.videoTags.map((vt) => vt.tag_id))]
    if (tagIds.length) {
      const tMarks = tagIds.map(() => '?').join(',')
      snap.tags = queryRows<TagRow>(`select * from tags where id in (${tMarks})`, tagIds)
    }
  }

  const collectByCollections = (collectionIds: number[]): void => {
    if (!collectionIds.length) return
    const marks = collectionIds.map(() => '?').join(',')
    snap.videos = queryRows<VideoRow>(
      `select * from videos where collection_id in (${marks})`,
      collectionIds
    )
    collectByVideos(snap.videos.map((v) => v.id))
  }

  if (type === 'doc') {
    const doc = getDoc(id)
    if (!doc) return null
    snap.docs = queryRows<DocRow>('select * from docs where id = ?', [id])
    snap.cues = queryRows('select * from cues where doc_id = ?', [id])
    snap.clips = queryRows<ClipRow>('select * from clips where doc_id = ?', [id])
  } else if (type === 'video') {
    const video = getVideo(id)
    if (!video) return null
    snap.videos = queryRows<VideoRow>('select * from videos where id = ?', [id])
    collectByVideos([id])
  } else if (type === 'collection') {
    snap.collections = queryRows<CollectionRow>('select * from collections where id = ?', [id])
    if (!snap.collections.length) return null
    collectByCollections([id])
  } else if (type === 'uploader') {
    snap.uploaders = queryRows<UploaderRow>('select * from uploaders where id = ?', [id])
    if (!snap.uploaders.length) return null
    snap.collections = queryRows<CollectionRow>('select * from collections where uploader_id = ?', [
      id
    ])
    collectByCollections(snap.collections.map((c) => c.id))
  } else {
    return null
  }

  return snap
}

/** 把快照写回库（按原 id），返回恢复的“视频 + 字幕文档”总数，便于界面提示 */
export function importNode(snap: NodeSnapshot): number {
  if (!snap) return 0
  const handle = requireDb()

  withTransaction(() => {
    const insUploader = handle.prepare(
      'insert or ignore into uploaders (id, uid, name, avatar, favorite, created_at) values (?, ?, ?, ?, ?, ?)'
    )
    for (const u of snap.uploaders ?? []) {
      insUploader.run(u.id, u.uid, u.name, u.avatar, u.favorite, u.created_at)
    }

    const insCollection = handle.prepare(
      'insert or ignore into collections (id, uploader_id, sid, title, url, favorite, created_at) values (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const c of snap.collections ?? []) {
      insCollection.run(c.id, c.uploader_id, c.sid, c.title, c.url, c.favorite, c.created_at)
    }

    const insVideo = handle.prepare(
      `insert or ignore into videos
         (id, collection_id, bvid, title, url, cover, duration, page_count, favorite, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const v of snap.videos ?? []) {
      insVideo.run(
        v.id,
        v.collection_id,
        v.bvid,
        v.title,
        v.url,
        v.cover,
        v.duration,
        v.page_count,
        v.favorite,
        v.created_at
      )
    }

    const insDoc = handle.prepare(
      `insert or ignore into docs
         (id, video_id, page, lang, label, filename, source, favorite, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const d of snap.docs ?? []) {
      insDoc.run(
        d.id,
        d.video_id,
        d.page,
        d.lang,
        d.label,
        d.filename,
        d.source,
        d.favorite,
        d.created_at
      )
    }

    // 正文与切片先清掉同 id 的残留，避免唯一键冲突
    const insCue = handle.prepare(
      'insert or replace into cues (doc_id, idx, start, end, text) values (?, ?, ?, ?, ?)'
    )
    for (const c of snap.cues ?? []) {
      insCue.run(c.doc_id, c.idx, c.start, c.end, c.text)
    }

    const insClip = handle.prepare(
      `insert or ignore into clips
         (id, doc_id, bvid, page, start, end, note, segments, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const c of snap.clips ?? []) {
      insClip.run(
        c.id,
        c.doc_id,
        c.bvid,
        c.page,
        c.start,
        c.end,
        c.note,
        c.segments,
        c.created_at
      )
    }

    const insTag = handle.prepare(
      'insert or ignore into tags (id, name, created_at) values (?, ?, ?)'
    )
    for (const t of snap.tags ?? []) insTag.run(t.id, t.name, t.created_at)

    const insVideoTag = handle.prepare(
      'insert or ignore into video_tags (video_id, tag_id) values (?, ?)'
    )
    for (const vt of snap.videoTags ?? []) insVideoTag.run(vt.video_id, vt.tag_id)
  })

  // 全文索引跟着正文一起重建（快照里没有 FTS 表，必须显式补）
  for (const docId of new Set((snap.cues ?? []).map((c) => c.doc_id))) {
    handle.prepare('delete from cue_search where doc_id = ?').run(docId)
    handle
      .prepare(
        `insert into cue_search (rowid, text, doc_id, page, idx)
         select c.rowid, c.text, c.doc_id, d.page, c.idx
         from cues c join docs d on d.id = c.doc_id where c.doc_id = ?`
      )
      .run(docId)
  }

  return (snap.videos?.length ?? 0) + (snap.docs?.length ?? 0)
}


/* --------------------------------- 重命名 --------------------------------- */

/** 重命名资源（UP主 / 合集 / 视频 / 字幕文档） */
export function renameNode(key: string, name: string): void {
  const [type, idRaw] = key.split(':')
  const id = Number(idRaw)
  const value = (name ?? '').trim()
  if (!id || !value) return
  const handle = requireDb()
  if (type === 'doc') handle.prepare('update docs set label = ? where id = ?').run(value, id)
  else if (type === 'video') handle.prepare('update videos set title = ? where id = ?').run(value, id)
  else if (type === 'collection')
    handle.prepare('update collections set title = ? where id = ?').run(value, id)
  else if (type === 'uploader')
    handle.prepare('update uploaders set name = ? where id = ?').run(value, id)
}

/* ---------------------------------- 收藏 ---------------------------------- */

export function toggleFavorite(key: string): boolean {
  const [type, idRaw] = key.split(':')
  const id = Number(idRaw)
  if (!id) return false
  const table =
    type === 'doc'
      ? 'docs'
      : type === 'video'
        ? 'videos'
        : type === 'collection'
          ? 'collections'
          : type === 'uploader'
            ? 'uploaders'
            : ''
  // 表名来自上面的白名单，不存在注入面
  if (!table) return false

  const handle = requireDb()
  handle.prepare(`update ${table} set favorite = 1 - favorite where id = ?`).run(id)
  const row = handle.prepare(`select favorite from ${table} where id = ?`).get(id) as
    | { favorite: number }
    | undefined
  return Boolean(row?.favorite)
}

/* --------------------------------- 切片任务 -------------------------------- */

function toClip(r: ClipRow): ClipTask {
  let segments: ClipTask['segments']
  if (r.segments) {
    try {
      const parsed = JSON.parse(r.segments) as ClipTask['segments']
      if (Array.isArray(parsed) && parsed.length > 1) segments = parsed
    } catch {
      /* 坏数据就当没有分段 */
    }
  }
  const source: ClipTask['source'] =
    r.source === 'search' || r.source === 'slice' ? r.source : 'manual'
  return {
    id: r.id,
    docId: r.doc_id,
    bvid: r.bvid,
    page: r.page,
    start: r.start,
    end: r.end,
    note: r.note,
    // 老数据的 name 为空时用备注兜底（迁移里也补过，这里再兜一层）
    name: r.name || r.note,
    source,
    favorite: Number(r.favorite ?? 0) === 1,
    createdAt: r.created_at,
    ...(segments ? { segments } : {})
  }
}

/**
 * 写入一条切片任务（/ 片段）。
 *
 * `name` / `source` / `favorite` 允许缺省：老调用点（导出、检索批量加入）只关心时间范围，
 * 让 db 层统一兜底比在每个调用点重复写默认值更不容易漏。
 */
/**
 * 新增片段（3.6.0 拆表后语义收窄）。
 *
 * 这里**只写片段**：新片段不会自动变成任务。
 * 「要不要输出」是另一个动作（`enqueueExportJobs`），
 * 拆表前这两件事是一起发生的 —— 那正是「清空任务把片段也删了」的根源。
 *
 * @param withPendingJob 兼容旧行为：加片段的同时排一条 pending 任务
 *   （界面上的「添加到任务」用得到；纯保存片段时不传）
 */
export function addClips(tasks: NewClipTask[], withPendingJob = false): number {
  const handle = requireDb()
  const now = Date.now()
  const ins = handle.prepare(
    `insert into clips
       (doc_id, bvid, page, start, end, note, name, source, favorite, segments, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const ids: number[] = []
  const run = (): number => {
    tasks.forEach((t) => {
      const res = ins.run(
        t.docId,
        t.bvid,
        t.page,
        t.start,
        t.end,
        t.note,
        // 没给名称就用备注兜底，保证片段列表永远有可读的名字
        (t.name ?? '').trim() || t.note,
        t.source ?? 'manual',
        t.favorite ? 1 : 0,
        t.segments && t.segments.length > 1 ? JSON.stringify(t.segments) : null,
        now
      )
      ids.push(Number(res.lastInsertRowid))
    })
    if (withPendingJob && ids.length) {
      enqueueExportJobsFromClips(ids)
    }
    return tasks.length
  }
  return batchDepth > 0 ? run() : withTransaction(run)
}

/**
 * 列出全部片段。
 *
 * 顺序：不同批次之间最近的在前（`created_at desc`），
 * 而**同一批加入的片段保持插入顺序**（`id asc` 兜底）。
 *
 * 兜底为什么必须是 `asc` 而不是 `desc`：一次操作里加的多个片段
 * `created_at` 往往是**同一毫秒**，此时 `id desc` 会把它们的顺序整个倒过来 ——
 * 于是「高光片段_1」排到「高光片段_2」后面，导出 CSV 的行序也跟着错位（实测踩到过）。
 */
export function listClips(): ClipTask[] {
  const rows = requireDb()
    .prepare('select * from clips order by created_at desc, id asc')
    .all() as unknown as ClipRow[]
  return rows.map(toClip)
}

export function deleteClip(id: number): void {
  requireDb().prepare('delete from clips where id = ?').run(id)
}

/** 清空**片段库**（不影响导出任务与历史 —— 这是拆表的主要收益） */
export function clearClips(): void {
  requireDb().prepare('delete from clips').run()
}

/** 重命名片段的备注（即输出文件名） */
export function updateClipNote(id: number, note: string): void {
  requireDb()
    .prepare('update clips set note = ? where id = ?')
    .run(String(note ?? '').slice(0, 120), id)
}

/** 重命名片段（库里找它用的名字，不影响输出文件名） */
export function updateClipName(id: number, name: string): void {
  requireDb()
    .prepare('update clips set name = ? where id = ?')
    .run(String(name ?? '').slice(0, 120), id)
}

/** 收藏 / 取消收藏片段（第三阶段：首页「收藏片段」） */
export function toggleClipFavorite(id: number): boolean {
  const handle = requireDb()
  const row = handle.prepare('select favorite from clips where id = ?').get(id) as
    | { favorite: number }
    | undefined
  const next = row?.favorite ? 0 : 1
  handle.prepare('update clips set favorite = ? where id = ?').run(next, id)
  return next === 1
}

/* ------------------------------- 导出任务 -------------------------------- */

export interface ExportJob {
  id: number
  clipId: number | null
  bvid: string
  page: number
  start: number
  end: number
  segments?: Array<{ page: number; start: number; end: number }>
  note: string
  /** pending / running / done / failed / canceled */
  state: 'pending' | 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  output: string
  message: string
  sortOrder: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface ExportJobRow {
  id: number
  clip_id: number | null
  bvid: string
  page: number
  start: number
  end: number
  segments: string | null
  note: string
  state: string
  progress: number
  output: string | null
  message: string | null
  sort_order: number
  created_at: number
  started_at: number | null
  finished_at: number | null
}

function toExportJob(r: ExportJobRow): ExportJob {
  let segments: ExportJob['segments']
  if (r.segments) {
    try {
      const parsed = JSON.parse(r.segments)
      if (Array.isArray(parsed) && parsed.length > 1) segments = parsed
    } catch {
      /* 坏 JSON 忽略，按单段处理 */
    }
  }
  return {
    id: r.id,
    clipId: r.clip_id,
    bvid: r.bvid,
    page: r.page,
    start: r.start,
    end: r.end,
    segments,
    note: r.note,
    state: (r.state as ExportJob['state']) ?? 'pending',
    progress: r.progress ?? 0,
    output: r.output ?? '',
    message: r.message ?? '',
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  }
}

/** 按 id 把片段排进导出队列（已被排过的片段不会重复排队） */
export function enqueueExportJobsFromClips(clipIds: number[]): number {
  const handle = requireDb()
  const all = handle
    .prepare('select * from clips where id in (' + clipIds.map(() => '?').join(',') + ')')
    .all(...clipIds) as unknown as ClipRow[]
  if (!all.length) return 0
  const next =
    Number(
      (
        handle.prepare('select coalesce(max(sort_order), -1) + 1 as n from export_jobs').get() as {
          n: number
        }
      ).n
    ) || 0
  const ins = handle.prepare(
    `insert into export_jobs
       (clip_id, bvid, page, start, end, segments, note, state, progress, sort_order, created_at)
     values (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  )
  const now = Date.now()
  return withTransaction(() => {
    all.forEach((c, i) => {
      ins.run(
        c.id,
        c.bvid,
        c.page,
        c.start,
        c.end,
        c.segments,
        c.note,
        next + i,
        now
      )
    })
    return all.length
  })
}

export function listExportJobs(state?: ExportJob['state']): ExportJob[] {
  const rows = state
    ? (requireDb()
        .prepare('select * from export_jobs where state = ? order by sort_order asc, id asc')
        .all(state) as unknown as ExportJobRow[])
    : (requireDb()
        .prepare('select * from export_jobs order by created_at desc, id asc')
        .all() as unknown as ExportJobRow[])
  return rows.map(toExportJob)
}

export function deleteExportJob(id: number): void {
  requireDb().prepare('delete from export_jobs where id = ?').run(id)
}

/** 清空**待处理队列**（已完成/失败的历史留着 —— 那是给人看的记录） */
export function clearPendingExportJobs(): void {
  requireDb().prepare("delete from export_jobs where state = 'pending'").run()
}

/** 清空全部任务记录（含历史） */
export function clearExportJobs(): void {
  requireDb().prepare('delete from export_jobs').run()
}

/** 更新任务状态（执行过程中由引擎调用） */
export function updateExportJobState(
  id: number,
  patch: {
    state?: ExportJob['state']
    progress?: number
    output?: string | null
    message?: string | null
  }
): void {
  const handle = requireDb()
  const sets: string[] = []
  const params: Array<string | number | null> = []
  if (patch.state) {
    sets.push('state = ?')
    params.push(patch.state)
    // 状态推进时顺手记时间戳：失败重试与耗时统计都要用
    if (patch.state === 'running') {
      sets.push('started_at = ?')
      params.push(Date.now())
    } else if (patch.state !== 'pending') {
      sets.push('finished_at = ?')
      params.push(Date.now())
    }
  }
  if (typeof patch.progress === 'number') {
    sets.push('progress = ?')
    params.push(Math.max(0, Math.min(100, Math.round(patch.progress))))
  }
  if (patch.output !== undefined) {
    sets.push('output = ?')
    params.push(patch.output)
  }
  if (patch.message !== undefined) {
    sets.push('message = ?')
    params.push(patch.message)
  }
  if (!sets.length) return
  params.push(id)
  handle.prepare(`update export_jobs set ${sets.join(', ')} where id = ?`).run(...params)
}

/**
 * 队列内上移 / 下移一条**待处理**任务。
 *
 * 只对 pending 生效：已完成的任务顺序没有意义（列表按时间排），
 * 让它们参与排序只会把队列搅乱。
 */
export function moveExportJob(id: number, dir: -1 | 1): void {
  const handle = requireDb()
  const rows = handle
    .prepare("select id from export_jobs where state = 'pending' order by sort_order asc, id asc")
    .all() as unknown as Array<{ id: number }>
  const at = rows.findIndex((r) => r.id === id)
  if (at < 0) return
  const to = at + dir
  if (to < 0 || to >= rows.length) return

  const ids = rows.map((r) => r.id)
  ;[ids[at], ids[to]] = [ids[to], ids[at]]
  const upd = handle.prepare('update export_jobs set sort_order = ? where id = ?')
  withTransaction(() => ids.forEach((jid, i) => upd.run(i, jid)))
}

/** 把失败/取消的任务重新排回队列（保留原时间与错误信息，便于对比重试结果） */
export function retryExportJobs(ids: number[]): number {
  if (!ids.length) return 0
  const handle = requireDb()
  const upd = handle.prepare(
    "update export_jobs set state = 'pending', progress = 0, message = null, started_at = null, finished_at = null, output = null where id = ? and state in ('failed', 'canceled')"
  )
  return withTransaction(() => ids.reduce((n, id) => n + Number(upd.run(id).changes || 0), 0))
}


/* ------------------------------ 字幕合并 / 拆分 ----------------------------- */

/** 合并若干条字幕（索引是文档内的原始序号）。返回实际合并掉的条数。 */
export function mergeDocCues(docId: number, indexes: number[]): number {
  const cues = loadCues(docId)
  if (cues.length < 2) return 0
  const res = mergeCues(cues, indexes)
  if (res.merged < 2) return 0
  updateDocCues(docId, res.cues)
  return res.merged
}

/** 在 atSecond 处拆分某一条。返回是否真的切了。 */
export function splitDocCue(docId: number, index: number, atSecond: number): boolean {
  const cues = loadCues(docId)
  const res = splitCue(cues, index, atSecond)
  if (!res.ok) return false
  updateDocCues(docId, res.cues)
  return true
}

/* -------------------------------- 切片历史 -------------------------------- */

/*
 * 3.6.0：`slice_history` 表已被 `export_jobs` 取代（见文件顶部说明），
 * 这里的 `SliceHistoryRow` / 三个函数保留为**兼容转发**，指向新表。
 *
 * 为什么转发而不是直接删掉调用点：调用点在 ipc 与渲染层多处，
 * 一次改完容易漏；先让语义对齐（历史 = 终态任务），再逐处切换到
 * `listExportJobs()`，最后删掉这层壳。
 */

/** @deprecated 用 `ExportJob` —— 状态名映射为旧的三态 */
export interface SliceHistoryRow {
  id: number
  clipId: number | null
  note: string
  bvid: string
  page: number
  start: number
  end: number
  segments?: Array<{ page: number; start: number; end: number }>
  status: 'ok' | 'error' | 'canceled'
  output: string
  message: string
  createdAt: number
}

/** 新状态 → 旧三态（done→ok、failed→error，其余取消） */
function toLegacyStatus(state: ExportJob['state']): SliceHistoryRow['status'] {
  return state === 'done' ? 'ok' : state === 'failed' ? 'error' : 'canceled'
}

/**
 * 记录一批切片结果。
 *
 * @deprecated 新代码应该用 `enqueueExportJobsFromClips()` +
 * `updateExportJobState()` 成对操作：任务在排队时就存在，
 * 而不是跑完才补一条历史。
 */
export function recordSliceHistory(
  entries: Array<Omit<SliceHistoryRow, 'id' | 'createdAt'>>
): number {
  if (!entries.length) return 0
  const handle = requireDb()
  const now = Date.now()
  const ins = handle.prepare(
    `insert into export_jobs
       (clip_id, note, bvid, page, start, end, segments, state, progress, output, message,
        sort_order, created_at, started_at, finished_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
  withTransaction(() => {
    for (const e of entries) {
      const state = e.status === 'ok' ? 'done' : e.status === 'canceled' ? 'canceled' : 'failed'
      ins.run(
        e.clipId ?? null,
        e.note ?? '',
        e.bvid ?? '',
        e.page ?? 1,
        e.start ?? 0,
        e.end ?? 0,
        e.segments && e.segments.length > 1 ? JSON.stringify(e.segments) : null,
        state,
        state === 'done' ? 100 : 0,
        e.output ?? null,
        e.message ?? null,
        now,
        now,
        now
      )
    }
  })
  return entries.length
}

/** @deprecated 用 `listExportJobs()`；这里只返回**终态**任务（历史语义） */
export function listSliceHistory(limit = 200): SliceHistoryRow[] {
  const rows = requireDb()
    .prepare(
      "select * from export_jobs where state <> 'pending' order by created_at desc, id desc limit ?"
    )
    .all(Math.max(1, Math.min(2000, Math.trunc(limit)))) as unknown as ExportJobRow[]
  return rows.map((r) => {
    const job = toExportJob(r)
    return {
      id: job.id,
      clipId: job.clipId,
      note: job.note,
      bvid: job.bvid,
      page: job.page,
      start: job.start,
      end: job.end,
      segments: job.segments,
      status: toLegacyStatus(job.state),
      output: job.output,
      message: job.message,
      createdAt: job.createdAt
    }
  })
}

/** @deprecated 用 `clearExportJobs()`（它清全部；这里只清终态，语义上更安全） */
export function clearSliceHistory(): void {
  requireDb().prepare("delete from export_jobs where state <> 'pending'").run()
}

/* -------------------------------- 首页 Dashboard ------------------------------- */

/**
 * 首页一次性拉回所有卡片数据（第二阶段）。
 *
 * 刻意**基于 `buildTree()` 的结果**而不是另写一套 SQL：
 * 资源树已经处理完「UP主 / 合集 / 空分组 / 文档归属」的全部规则，
 * 首页再写一份很容易和树里显示的内容对不上（这正是本项目历史上踩过的坑）。
 * 代价是要遍历树，但树里只有元数据，几千个视频也只是毫秒级。
 */
export function dashboardOverview(limit = 12): DashboardOverview {
  const tree = buildTree()

  const videos: DashboardVideo[] = []
  const collections: DashboardCollection[] = []
  const favorites: DashboardFavorite[] = []

  for (const uploader of tree) {
    for (const collection of uploader.children ?? []) {
      const isRealCollection = collection.type === 'collection'
      let latest = 0
      let videoCount = 0

      for (const video of collection.children ?? []) {
        if (video.type !== 'video') continue
        videoCount++
        const docs = (video.children ?? []).filter((n) => n.type === 'doc')
        const docCount = docs.length
        // 视频节点自身没有时间字段，用子文档的时间兜底；都没有则算 0（沉到列表底部）
        const created = docs.reduce((min, d) => {
          const at = (d.payload as { createdAt?: number } | undefined)?.createdAt ?? 0
          return at && (!min || at < min) ? at : min
        }, 0)
        if (created > latest) latest = created

        videos.push({
          videoId: video.videoId ?? 0,
          bvid: (video.payload as { bvid?: string } | undefined)?.bvid ?? '',
          title: video.label,
          uploaderName: uploader.label,
          collectionId: isRealCollection ? ((collection.payload as { id?: number })?.id ?? null) : null,
          collectionTitle: isRealCollection ? collection.label : null,
          docCount,
          firstDocId: (docs[0]?.payload as { id?: number } | undefined)?.id ?? null,
          createdAt: created
        })

        if (video.favorite) {
          favorites.push({
            key: video.key,
            type: 'video',
            label: video.label,
            bvid: (video.payload as { bvid?: string } | undefined)?.bvid ?? null,
            docId: (docs[0]?.payload as { id?: number } | undefined)?.id ?? null,
            videoId: video.videoId ?? null
          })
        }
        for (const doc of docs) {
          if (doc.favorite) {
            favorites.push({
              key: doc.key,
              type: 'doc',
              label: `${video.label} · ${doc.label}`,
              bvid: (video.payload as { bvid?: string } | undefined)?.bvid ?? null,
              docId: (doc.payload as { id?: number } | undefined)?.id ?? null,
              videoId: video.videoId ?? null
            })
          }
        }
      }

      if (isRealCollection && videoCount) {
        collections.push({
          collectionId: (collection.payload as { id?: number })?.id ?? 0,
          title: collection.label,
          uploaderName: uploader.label,
          videoCount,
          updatedAt: latest
        })
      }
    }

    if (uploader.favorite) {
      favorites.push({
        key: uploader.key,
        type: 'uploader',
        label: uploader.label,
        bvid: null,
        docId: null,
        videoId: null
      })
    }
  }

  const byTimeDesc = <T extends { createdAt?: number; updatedAt?: number }>(a: T, b: T): number =>
    (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)

  const s = stats()

  return {
    recentVideos: videos.filter((v) => v.createdAt > 0).sort(byTimeDesc).slice(0, limit),
    recentCollections: collections.sort(byTimeDesc).slice(0, limit),
    favorites: favorites.slice(0, limit),
    // 收藏的片段（第三阶段）：片段本身就是「带名字与标签的时间范围」
    favoriteClips: listClips()
      .filter((c) => c.favorite)
      .slice(0, limit),
    videosWithoutDocs: videos.filter((v) => v.docCount === 0).length,
    clipCount: s.clips
  }
}

/* -------------------------- 剪辑文案模板（第八阶段） -------------------------- */

export interface CopyTemplateRow {
  id: string
  name: string
  description: string
  body: string
  builtin: number
}

export function listCopyTemplates(): CopyTemplateRow[] {
  return requireDb()
    .prepare(
      `select id, name, description, body, builtin
       from copy_templates order by builtin desc, created_at asc`
    )
    .all() as unknown as CopyTemplateRow[]
}

export function getCopyTemplate(id: string): CopyTemplateRow | null {
  const row = requireDb()
    .prepare('select id, name, description, body, builtin from copy_templates where id = ?')
    .get(id) as CopyTemplateRow | undefined
  return row ?? null
}

/** 新增或更新模板；内置模板的 `builtin` 标记不会被覆盖掉 */
export function saveCopyTemplate(row: {
  id: string
  name: string
  description: string
  body: string
  builtin?: number
}): void {
  const handle = requireDb()
  handle
    .prepare(
      `insert into copy_templates (id, name, description, body, builtin, created_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         name = excluded.name,
         description = excluded.description,
         body = excluded.body`
    )
    .run(row.id, row.name, row.description ?? '', row.body, row.builtin ?? 0, Date.now())
}

export function deleteCopyTemplate(id: string): void {
  requireDb().prepare('delete from copy_templates where id = ?').run(id)
}

/** 首次运行时把内置模板灌进去（只在表为空时做，避免覆盖用户的修改） */
export function seedCopyTemplatesIfEmpty(
  seeds: Array<{ id: string; name: string; description: string; body: string }>
): boolean {
  const handle = requireDb()
  const count = handle.prepare('select count(*) as n from copy_templates').get() as { n: number }
  if (count.n > 0) return false
  withTransaction(() => {
    const stmt = handle.prepare(
      'insert into copy_templates (id, name, description, body, builtin, created_at) values (?, ?, ?, ?, 1, ?)'
    )
    for (const s of seeds) stmt.run(s.id, s.name, s.description, s.body, Date.now())
  })
  return true
}

/* ---------------------------- 知识图谱（第八阶段） ---------------------------- */

export interface TopicRow {
  id: number
  term: string
  videoCount: number
  totalCount: number
}

export interface ViewpointRow {
  id: number
  videoId: number
  docId: number
  page: number
  index: number
  start: number
  end: number
  text: string
  score: number
}

/** 图谱规模（界面显示「N 个主题 / M 条观点」） */
export function graphCounts(): { topics: number; viewpoints: number; videos: number } {
  const handle = requireDb()
  const t = handle.prepare('select count(*) as n from topics').get() as { n: number }
  const v = handle.prepare('select count(*) as n from viewpoints').get() as { n: number }
  const vd = handle
    .prepare('select count(distinct video_id) as n from video_topics')
    .get() as { n: number }
  return { topics: t.n, viewpoints: v.n, videos: vd.n }
}

/** 某个文档的全部字幕（建图时按序处理） */
export function listDocTexts(
  docId: number
): Array<{ index: number; start: number; end: number; text: string }> {
  return requireDb()
    .prepare(
      `select idx as "index", start as start, end as end, text as text
       from cues where doc_id = ? order by idx asc`
    )
    .all(docId) as unknown as Array<{ index: number; start: number; end: number; text: string }>
}

/** 全部文档（建图要逐个处理） */
export function listDocsForGraph(): Array<{ id: number; videoId: number; page: number }> {
  return requireDb()
    .prepare('select id as id, video_id as videoId, page as page from docs order by id asc')
    .all() as unknown as Array<{ id: number; videoId: number; page: number }>
}

/** 「文档 → 全部字幕文本」，一次取回用于统计全局词频 */
export function allCueTextsByDoc(): Map<number, string[]> {
  const rows = requireDb()
    .prepare('select doc_id as docId, text as text from cues order by doc_id, idx')
    .all() as unknown as Array<{ docId: number; text: string }>
  const perDoc = new Map<number, string[]>()
  for (const r of rows) {
    const list = perDoc.get(r.docId)
    if (list) list.push(r.text)
    else perDoc.set(r.docId, [r.text])
  }
  return perDoc
}

/** 建图前清空旧结果（重建要幂等） */
export function clearGraph(): void {
  const handle = requireDb()
  withTransaction(() => {
    handle.prepare('delete from video_topics').run()
    handle.prepare('delete from viewpoints').run()
    handle.prepare('delete from topics').run()
  })
}

/** 清某个文档相关的图谱数据（字幕变了要重建；观点按 doc 定位） */
export function clearDocGraph(docId: number, videoId: number): void {
  const handle = requireDb()
  withTransaction(() => {
    handle.prepare('delete from viewpoints where doc_id = ?').run(docId)
    // 主题是视频级的（多个分P 共同贡献），单删一个文档无法精确回退，
    // 所以只在该视频不再有任何观点时清掉它的主题关联，避免留下空壳
    const left = handle
      .prepare('select count(*) as n from viewpoints where video_id = ?')
      .get(videoId) as { n: number }
    if (!left.n) handle.prepare('delete from video_topics where video_id = ?').run(videoId)
  })
}

/** 写入一个视频的主题关联（同一次调用内先清后写，保证幂等） */
export function saveVideoTopics(
  videoId: number,
  items: Array<{ term: string; count: number; score: number }>
): void {
  const handle = requireDb()
  const upsertTopic = handle.prepare(
    'insert into topics (term, video_count, total_count) values (?, 0, 0) on conflict(term) do nothing'
  )
  const findTopic = handle.prepare('select id from topics where term = ?')
  const link = handle.prepare(
    `insert into video_topics (video_id, topic_id, count, score) values (?, ?, ?, ?)
     on conflict(video_id, topic_id) do update set count = excluded.count, score = excluded.score`
  )
  withTransaction(() => {
    handle.prepare('delete from video_topics where video_id = ?').run(videoId)
    for (const item of items) {
      upsertTopic.run(item.term)
      const row = findTopic.get(item.term) as { id: number } | undefined
      if (!row) continue
      link.run(videoId, row.id, item.count, item.score)
    }
  })
}

/** 替换某个视频某个文档的观点（先清后写） */
export function saveVideoViewpoints(
  videoId: number,
  docId: number,
  page: number,
  items: Array<{ index: number; start: number; end: number; text: string; score: number }>
): void {
  const handle = requireDb()
  const insert = handle.prepare(
    `insert into viewpoints (video_id, doc_id, page, first_idx, start, end, text, score)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  withTransaction(() => {
    handle.prepare('delete from viewpoints where video_id = ? and doc_id = ?').run(videoId, docId)
    for (const it of items) {
      insert.run(videoId, docId, page, it.index, it.start, it.end, it.text, it.score)
    }
  })
}

/** 建图最后一步：汇总每个主题覆盖多少视频、总命中多少次；清掉孤立主题 */
export function refreshTopicStats(): void {
  const handle = requireDb()
  withTransaction(() => {
    handle
      .prepare(
        `update topics set
           video_count = (select count(*) from video_topics vt where vt.topic_id = topics.id),
           total_count = coalesce((select sum(count) from video_topics vt where vt.topic_id = topics.id), 0)`
      )
      .run()
    handle
      .prepare(
        'delete from topics where not exists (select 1 from video_topics vt where vt.topic_id = topics.id)'
      )
      .run()
  })
}

/** 主题列表（按影响力排序：覆盖视频数 → 总命中次数） */
export function listTopics(keyword = '', limit = 200): TopicRow[] {
  const trimmed = keyword.trim()
  const like = `%${trimmed}%`
  return requireDb()
    .prepare(
      `select id, term, video_count as videoCount, total_count as totalCount
       from topics
       where (? = 0 or term like ?)
       order by video_count desc, total_count desc, term asc
       limit ?`
    )
    .all(trimmed ? 1 : 0, like, limit) as unknown as TopicRow[]
}

export interface TopicVideoRow {
  videoId: number
  title: string
  bvid: string
  uploaderName: string
  count: number
  score: number
  viewpoints: number
}

/** 某个主题下的视频（图谱的「主题 → 视频」这一层） */
export function listTopicVideos(topicId: number, limit = 100): TopicVideoRow[] {
  const rows = requireDb()
    .prepare(
      `select v.id as videoId, v.title as title, v.bvid as bvid,
              coalesce(u.name, '') as uploaderName,
              vt.count as count, vt.score as score,
              (select count(*) from viewpoints vp where vp.video_id = v.id) as viewpoints
       from video_topics vt
       join videos v on v.id = vt.video_id
       left join collections col on col.id = v.collection_id
       left join uploaders u on u.id = col.uploader_id
       where vt.topic_id = ?
       order by vt.score desc
       limit ?`
    )
    .all(topicId, limit) as unknown as TopicVideoRow[]
  // 标题同样要规范化：图谱里列出的视频名必须和其它地方一致
  return rows.map((r) => ({
    ...r,
    title: normalizeVideoTitle(r.title, { uploaderName: r.uploaderName })
  }))
}

/** 某个视频的主题（图谱的「视频 → 主题」） */
export function listVideoTopics(videoId: number, limit = 20): TopicRow[] {
  return requireDb()
    .prepare(
      `select t.id as id, t.term as term, t.video_count as videoCount, t.total_count as totalCount
       from video_topics vt join topics t on t.id = vt.topic_id
       where vt.video_id = ?
       order by vt.score desc
       limit ?`
    )
    .all(videoId, limit) as unknown as TopicRow[]
}

/** 某个视频的观点句（图谱的「视频 → 观点」） */
export function listViewpoints(videoId: number, limit = 30): ViewpointRow[] {
  return requireDb()
    .prepare(
      `select id, video_id as videoId, doc_id as docId, page, first_idx as "index",
              start, end, text, score
       from viewpoints where video_id = ?
       order by score desc limit ?`
    )
    .all(videoId, limit) as unknown as ViewpointRow[]
}

/** 图谱元信息（记录建图时间与规模，界面据此提示「是否需要重建」） */
export function setGraphMeta(key: string, value: string): void {
  requireDb()
    .prepare(
      `insert into graph_meta (key, value) values (?, ?)
       on conflict(key) do update set value = excluded.value`
    )
    .run(key, value)
}

export function getGraphMeta(key: string): string | null {
  const row = requireDb().prepare('select value from graph_meta where key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/* ------------------------------ 语义检索（第四阶段下半） ----------------------------- */

/** 段落元信息（检索命中后要展示 / 跳转所需的一切） */
export interface ChunkMeta {
  id: number
  docId: number
  videoId: number
  page: number
  firstIdx: number
  start: number
  end: number
  text: string
  docLabel: string
  uploaderId: number | null
}

/**
 * 切分段落：把**还没有段落**的文档按时间窗口合并成段。
 *
 * 幂等：已有段落的文档直接跳过（所以可以反复调用）。
 * 合并规则：同一分P 内，相邻字幕间隔不超过 3 秒且总时长不超过窗口（默认 45 秒）就并入同一段。
 */
export function buildSemanticChunks(windowSeconds = 45): number {
  const handle = requireDb()
  const docs = handle
    .prepare(
      `select d.id as id, d.video_id as videoId, d.page as page
       from docs d
       where not exists (select 1 from semantic_chunks c where c.doc_id = d.id)`
    )
    .all() as unknown as Array<{ id: number; videoId: number; page: number }>
  if (!docs.length) return 0

  const ins = handle.prepare(
    `insert into semantic_chunks (doc_id, page, first_idx, start, end, text, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`
  )
  let created = 0
  const now = Date.now()

  const run = (): void => {
    for (const doc of docs) {
      const cues = loadCues(doc.id)
      if (!cues.length) continue
      let bucket: Cue[] = []
      const flush = (): void => {
        if (!bucket.length) return
        // 段落文本：单条就原样，多条用换行拼接（模型能理解多句）
        const text = bucket.map((c) => c.text.trim()).filter(Boolean).join('\n')
        if (text) {
          ins.run(
            doc.id,
            doc.page,
            bucket[0].index,
            bucket[0].start,
            bucket[bucket.length - 1].end,
            text.slice(0, 2000),
            now
          )
          created++
        }
        bucket = []
      }
      for (const cue of cues) {
        if (!bucket.length) {
          bucket.push(cue)
          continue
        }
        const prev = bucket[bucket.length - 1]
        const span = cue.end - bucket[0].start
        const gap = cue.start - prev.end
        // 间隔太大（换话题）或超过窗口就另起一段
        if (gap > 3 || span > windowSeconds) flush()
        bucket.push(cue)
      }
      flush()
    }
  }

  if (batchDepth > 0) run()
  else withTransaction(run)
  return created
}

/** 段落总数 / 已索引（有向量）数 */
export function semanticCounts(): { total: number; indexed: number } {
  const handle = requireDb()
  const total = (
    handle.prepare('select count(*) as n from semantic_chunks').get() as { n: number }
  ).n
  const indexed = (
    handle
      .prepare(
        'select count(*) as n from semantic_vectors v join semantic_chunks c on c.id = v.chunk_id'
      )
      .get() as { n: number }
  ).n
  return { total, indexed }
}

/** 取下一批还没算向量的段落（按 id 稳定顺序，便于断点续跑） */
export function nextUnindexedChunks(limit: number): Array<{ id: number; text: string }> {
  return requireDb()
    .prepare(
      `select c.id as id, c.text as text from semantic_chunks c
       where not exists (select 1 from semantic_vectors v where v.chunk_id = c.id)
       order by c.id asc limit ?`
    )
    .all(Math.max(1, Math.trunc(limit))) as unknown as Array<{ id: number; text: string }>
}

/**
 * 某个文档的段落（按时间顺序）。
 *
 * 两个用途：改完字幕只重建这一篇（`clearDocChunks` 之后再 `buildSemanticChunks`），
 * 以及「这篇字幕切成了几段」这类展示。
 */
export function listChunksByDoc(docId: number): ChunkMeta[] {
  const rows = requireDb()
    .prepare(
      `select c.id as id, c.doc_id as docId, d.video_id as videoId, c.page as page,
              c.first_idx as firstIdx, c.start as start, c.end as end, c.text as text,
              d.label as docLabel, col.uploader_id as uploaderId
       from semantic_chunks c
       join docs d on d.id = c.doc_id
       join videos v on v.id = d.video_id
       left join collections col on col.id = v.collection_id
       where c.doc_id = ?
       order by c.start asc, c.id asc`
    )
    .all(docId) as unknown as ChunkMeta[]
  return rows.map((r) => ({ ...r, uploaderId: r.uploaderId == null ? null : Number(r.uploaderId) }))
}

/** 批量写入向量 */
export function saveChunkVectors(
  items: Array<{ chunkId: number; vector: Buffer }>,
  dim: number,
  model = ''
): void {
  const handle = requireDb()
  const ins = handle.prepare(
    `insert into semantic_vectors (chunk_id, dim, vector, model, created_at)
     values (?, ?, ?, ?, ?)
     on conflict(chunk_id) do update set dim = excluded.dim, vector = excluded.vector,
       model = excluded.model, created_at = excluded.created_at`
  )
  const now = Date.now()
  const run = (): void => {
    for (const it of items) ins.run(it.chunkId, dim, it.vector, model, now)
  }
  if (batchDepth > 0) run()
  else withTransaction(run)
}

/** 取全部向量（暴力检索用；段数量级在万级以内，无需向量数据库） */
export function allChunkVectors(): Array<{ chunkId: number; vector: Buffer; dim: number }> {
  const rows = requireDb()
    .prepare('select chunk_id as chunkId, vector as vector, dim as dim from semantic_vectors')
    .all() as unknown as Array<{ chunkId: number; vector: Buffer; dim: number }>
  return rows
}

/**
 * 全部段落的**轻量索引**（只取判重/分组需要的三个字段）。
 *
 * 为什么不复用 `chunkMeta()`：那是一条 join 三张表的查询，
 * 而推荐要在十万条向量上判重 —— 每条都查一次 join 会慢到不可用。
 * 一次性把索引读进内存再算，才是这个量级该有的做法。
 */
export function chunkIndexMap(): Map<number, { docId: number; videoId: number; start: number }> {
  const rows = requireDb()
    .prepare(
      `select c.id as id, c.doc_id as docId, d.video_id as videoId, c.start as start
       from semantic_chunks c join docs d on d.id = c.doc_id`
    )
    .all() as unknown as Array<{ id: number; docId: number; videoId: number; start: number }>
  const out = new Map<number, { docId: number; videoId: number; start: number }>()
  for (const r of rows) out.set(r.id, { docId: r.docId, videoId: r.videoId, start: r.start })
  return out
}

/** 按 chunkId 批量取向量（比 `allChunkVectors()` 更省，用于「只要参照那一条」） */
export function chunkVectorsByIds(ids: number[]): Map<number, { vector: Buffer; dim: number }> {
  const out = new Map<number, { vector: Buffer; dim: number }>()
  if (!ids.length) return out
  const handle = requireDb()
  // 逐条查而不是 `in (...)`：调用方传的 id 很少（通常 1 条），参数拼接反而更容易出错
  const stmt = handle.prepare('select vector, dim from semantic_vectors where chunk_id = ?')
  for (const id of ids) {
    const row = stmt.get(id) as { vector: Buffer; dim: number } | undefined
    if (row) out.set(id, { vector: Buffer.from(row.vector), dim: row.dim })
  }
  return out
}

/** 某个视频的全部段落向量（求语义中心 / 找代表段落用） */
export function listVideoChunkVectors(
  videoId: number
): Array<{ chunkId: number; vector: Buffer }> {
  return requireDb()
    .prepare(
      `select v.chunk_id as chunkId, v.vector as vector
       from semantic_vectors v
       join semantic_chunks c on c.id = v.chunk_id
       join docs d on d.id = c.doc_id
       where d.video_id = ?`
    )
    .all(videoId) as unknown as Array<{ chunkId: number; vector: Buffer }>
}

/** 某文档里覆盖指定时刻的段落（推荐「以这段为参照」时用） */
export function chunkAt(docId: number, second: number): { id: number } | null {
  const row = requireDb()
    .prepare(
      `select id from semantic_chunks
       where doc_id = ? and start <= ? and end >= ?
       order by start asc limit 1`
    )
    .get(docId, second, second) as { id: number } | undefined
  return row ?? null
}

/** 读取缓存的视频语义中心 */
export function getVideoCentroid(videoId: number): Buffer | null {
  const row = requireDb()
    .prepare('select centroid from videos where id = ?')
    .get(videoId) as { centroid: Buffer | null } | undefined
  const value = row?.centroid
  return value && value.length ? Buffer.from(value) : null
}

/** 写入视频语义中心（`videos.centroid`，全库重建索引时需要清掉） */
export function saveVideoCentroid(videoId: number, centroid: Buffer): void {
  requireDb()
    .prepare('update videos set centroid = ? where id = ?')
    .run(centroid, videoId)
}

/** 清空全部视频的语义中心（段落清空后它们就过期了） */
export function clearVideoCentroids(): void {
  requireDb().prepare('update videos set centroid = null').run()
}

/** 段落元信息（检索命中后展示与跳转都要） */
export function chunkMeta(chunkId: number): ChunkMeta | null {
  const row = requireDb()
    .prepare(
      `select c.id as id, c.doc_id as docId, d.video_id as videoId, c.page as page,
              c.first_idx as firstIdx, c.start as start, c.end as end, c.text as text,
              d.label as docLabel, col.uploader_id as uploaderId
       from semantic_chunks c
       join docs d on d.id = c.doc_id
       join videos v on v.id = d.video_id
       left join collections col on col.id = v.collection_id
       where c.id = ?`
    )
    .get(chunkId) as
    | {
        id: number
        docId: number
        videoId: number
        page: number
        firstIdx: number
        start: number
        end: number
        text: string
        docLabel: string
        uploaderId: number | null
      }
    | undefined
  if (!row) return null
  return { ...row, uploaderId: row.uploaderId == null ? null : Number(row.uploaderId) }
}

/** 删除某个文档的段落与向量（字幕改过之后需要重建） */
export function clearDocChunks(docId: number): void {
  const handle = requireDb()
  withTransaction(() => {
    handle
      .prepare('delete from semantic_vectors where chunk_id in (select id from semantic_chunks where doc_id = ?)')
      .run(docId)
    handle.prepare('delete from semantic_chunks where doc_id = ?').run(docId)
    // 该文档所属视频的语义中心也随之过期（第八阶段：宁可下次重算，也不要用旧中心推荐）
    handle
      .prepare('update videos set centroid = null where id = (select video_id from docs where id = ?)')
      .run(docId)
  })
}

/** 清空全部语义索引（设置页「重建索引」用） */
export function clearAllChunks(): void {
  const handle = requireDb()
  withTransaction(() => {
    handle.prepare('delete from semantic_vectors').run()
    handle.prepare('delete from semantic_chunks').run()
    // 段落没了，缓存的视频语义中心也就过期了
    handle.prepare('update videos set centroid = null').run()
  })
}

/* --------------------------------- 统计 ---------------------------------- */

/** 全库统计，用于设置页展示 */
export function stats(): {
  uploaders: number
  collections: number
  videos: number
  docs: number
  clips: number
  /** 元数据还在、但一条正文都没有的文档数（数据异常时 > 0） */
  missingCues: number
  /** 数据文件所在目录 */
  dataDir: string
} {
  const handle = requireDb()
  const count = (table: string): number =>
    (handle.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n

  const missingCues = (
    handle
      .prepare(
        'select count(*) as n from docs d where not exists (select 1 from cues c where c.doc_id = d.id)'
      )
      .get() as { n: number }
  ).n

  return {
    uploaders: count('uploaders'),
    collections: count('collections'),
    videos: count('videos'),
    docs: count('docs'),
    clips: count('clips'),
    missingCues,
    dataDir: dbFile ? dirname(dbFile) : ''
  }
}

/** 数据文件是否需要重建（启动时自检用） */
export function isDataHealthy(): boolean {
  return stats().missingCues === 0
}
