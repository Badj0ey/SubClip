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
import type { ClipTask, Cue, CueSearchHit, SubtitleDoc, TreeNode, VideoItem } from '@shared/types'
import { APP_DATA_DIR } from '@shared/constants'

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
  segments: string | null
  created_at: number
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
`

/* ---------------------------------- 状态 ---------------------------------- */

let db: DatabaseSync | null = null
let dbFile = ''
/** 老版本正文 JSON 所在目录（**只用于迁移**，新版本正文已入库） */
let legacyCacheDir = ''
/** 批量写入深度：>0 时复用外层事务 */
let batchDepth = 0

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
  const dataDir = join(userDataDir, APP_DATA_DIR)
  mkdirSync(dataDir, { recursive: true })
  dbFile = join(dataDir, 'srt-tool.db')
  legacyCacheDir = customCacheDir?.trim() ? customCacheDir.trim() : join(dataDir, 'docs')

  db = new DatabaseSync(dbFile)
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma synchronous = NORMAL')
  db.exec('pragma foreign_keys = ON')
  db.exec(SCHEMA)

  migrateFromJson(dataDir, userDataDir)
  rescueLegacyCacheDocs(userDataDir)
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

export interface CueSearchOptions {
  /** 最多返回多少条（默认 300，上限 2000） */
  limit?: number
  /** 只搜某个 UP主 */
  uploaderId?: number
  /** 只搜某个合集 */
  collectionId?: number
  /** 只搜某个视频 */
  videoId?: number
}

/**
 * 跨文档全文检索。
 *
 * 走 FTS5 的 trigram 索引，因此**查询串至少 3 个字符**；更短的查询（中文里很常见，
 * 比如「高光」）退回 LIKE 扫描 —— 索引用不上，但语义正确，几万条字幕量级也就几十毫秒。
 * FTS 查询若因任何原因失败（例如查询串里有特殊语法），也会自动回退到 LIKE。
 */
export function searchCues(keyword: string, options: CueSearchOptions = {}): CueSearchHit[] {
  const kw = (keyword ?? '').trim()
  if (!kw) return []
  const handle = requireDb()
  const capped = Math.max(1, Math.min(2000, Math.trunc(options.limit ?? 300)))

  const base = `
    select c.doc_id as docId, d.video_id as videoId, v.bvid as bvid, d.page as page, c.idx as idx,
           c.start as start, c.end as end, c.text as text,
           v.title as videoTitle, d.label as docLabel,
           col.uploader_id as uploaderId, v.collection_id as collectionId
    from cues c
    join docs d on d.id = c.doc_id
    join videos v on v.id = d.video_id
    left join collections col on col.id = v.collection_id`

  // 范围过滤：参数顺序与下面 SQL 里 ? 的出现顺序保持一致
  const scopeSql: string[] = []
  const scopeParams: number[] = []
  if (options.videoId) {
    scopeSql.push('and d.video_id = ?')
    scopeParams.push(options.videoId)
  }
  if (options.collectionId) {
    scopeSql.push('and v.collection_id = ?')
    scopeParams.push(options.collectionId)
  }
  if (options.uploaderId) {
    scopeSql.push('and col.uploader_id = ?')
    scopeParams.push(options.uploaderId)
  }
  const scope = scopeSql.join(' ')
  const order = 'order by c.doc_id asc, c.idx asc limit ?'

  const likePattern = `%${kw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  let rows: Array<Record<string, unknown>> = []

  if (kw.length >= 3) {
    try {
      // FTS5 的 MATCH 语法里双引号表示短语，内部引号要转义
      const phrase = `"${kw.replace(/"/g, '""')}"`
      rows = handle
        .prepare(
          `${base} where c.doc_id in (select doc_id from cue_search where cue_search match ?)
           ${scope} ${order}`
        )
        .all(phrase, ...scopeParams, capped) as Array<Record<string, unknown>>
    } catch {
      rows = [] // 落到下面的 LIKE 兜底
    }
    // 再过一遍精确匹配：trigram 是子串匹配，边界情况下可能多召回
    rows = rows.filter((r) => String(r.text).includes(kw))
  }
  if (!rows.length) {
    rows = handle
      .prepare(`${base} where c.text like ? escape '\\' ${scope} ${order}`)
      .all(likePattern, ...scopeParams, capped) as Array<Record<string, unknown>>
  }

  const uploaderName = handle.prepare('select name from uploaders where id = ?')
  const uploaderCache = new Map<number, string>()

  return rows.map((r) => {
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
      videoTitle: String(r.videoTitle ?? ''),
      docLabel: String(r.docLabel ?? ''),
      uploaderName: name,
      uploaderId,
      collectionId: r.collectionId == null ? null : Number(r.collectionId)
    }
  })
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

function toVideo(r: VideoRow): VideoItem {
  return {
    id: r.id,
    collectionId: r.collection_id,
    bvid: r.bvid,
    title: r.title,
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
      `select v.*, u.name as uploaderName
       from videos v
       left join collections c on c.id = v.collection_id
       left join uploaders u on u.id = c.uploader_id
       where v.id = ?`
    )
    .get(videoId) as (VideoRow & { uploaderName: string | null }) | undefined
  if (!row) return null
  return { ...toVideo(row), uploaderName: row.uploaderName ?? undefined }
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

  const videoNode = (v: VideoRow): TreeNode => {
    const list = docsByVideo.get(v.id) ?? []
    const where = v.bvid || '本地'
    return {
      key: `video:${v.id}`,
      type: 'video',
      label: v.title || v.bvid || '未命名字幕',
      subtitle: list.length ? `${where} · ${list.length} 条字幕` : where,
      favorite: Boolean(v.favorite),
      children: list.map(docNode)
    }
  }

  const nodes: TreeNode[] = []

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
    clips: []
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
  return {
    id: r.id,
    docId: r.doc_id,
    bvid: r.bvid,
    page: r.page,
    start: r.start,
    end: r.end,
    note: r.note,
    createdAt: r.created_at,
    ...(segments ? { segments } : {})
  }
}

export function addClipTasks(tasks: Omit<ClipTask, 'id' | 'createdAt'>[]): number {
  const handle = requireDb()
  const now = Date.now()
  const ins = handle.prepare(
    `insert into clips (doc_id, bvid, page, start, end, note, segments, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const run = (): number => {
    for (const t of tasks) {
      ins.run(
        t.docId,
        t.bvid,
        t.page,
        t.start,
        t.end,
        t.note,
        t.segments && t.segments.length > 1 ? JSON.stringify(t.segments) : null,
        now
      )
    }
    return tasks.length
  }
  return batchDepth > 0 ? run() : withTransaction(run)
}

export function listClipTasks(): ClipTask[] {
  const rows = requireDb()
    .prepare('select * from clips order by created_at desc, id asc')
    .all() as unknown as ClipRow[]
  return rows.map(toClip)
}

export function deleteClipTask(id: number): void {
  requireDb().prepare('delete from clips where id = ?').run(id)
}

export function clearClipTasks(): void {
  requireDb().prepare('delete from clips').run()
}

/* ---------------------------------- 统计 ---------------------------------- */

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
