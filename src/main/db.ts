/**
 * 数据层：单文件 JSON 存储（零原生依赖）。
 *
 * 层级：uploaders → collections → videos → docs → clips
 *
 * 说明：本机缺少 MSVC C++ 工具链，better-sqlite3 无法编译，
 * 因此改用「内存索引 + 原子落盘」的 JSON 实现。接口与关系库版本保持一致，
 * 数据量在数万条以内时性能完全够用。
 *
 * 字幕正文（cues）不落进主文件，按 docId 单独存成缓存 JSON，避免主文件膨胀。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ClipTask, Cue, SubtitleDoc, TreeNode, VideoItem } from '@shared/types'
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

interface UploaderRow {
  id: number
  /** B站 UID（接口里的 owner.mid），拿不到时为 null */
  uid: number | null
  name: string
  avatar: string | null
  favorite: number
  createdAt: number
}
interface CollectionRow {
  id: number
  uploaderId: number | null
  sid: string | null
  title: string
  url: string | null
  favorite: number
  createdAt: number
}
interface VideoRow {
  id: number
  collectionId: number | null
  bvid: string
  title: string
  url: string
  cover: string | null
  duration: number | null
  pageCount: number | null
  favorite: number
  createdAt: number
}
interface DocRow {
  id: number
  videoId: number
  page: number
  lang: string
  label: string
  filename: string
  source: 'local' | 'bilibili'
  favorite: number
  createdAt: number
}
interface ClipRow {
  id: number
  docId: number
  bvid: string
  page: number
  start: number
  end: number
  note: string
  createdAt: number
  /** 跨分P 切片的各段 */
  segments?: Array<{ page: number; start: number; end: number }>
}

interface Store {
  seq: { uploaders: number; collections: number; videos: number; docs: number; clips: number }
  uploaders: UploaderRow[]
  collections: CollectionRow[]
  videos: VideoRow[]
  docs: DocRow[]
  clips: ClipRow[]
}

function emptyStore(): Store {
  return {
    seq: { uploaders: 0, collections: 0, videos: 0, docs: 0, clips: 0 },
    uploaders: [],
    collections: [],
    videos: [],
    docs: [],
    clips: []
  }
}

let store: Store = emptyStore()
let dataFile = ''
let cacheDir = ''
let dirty = false

/**
 * 批量写入深度。
 * 批量拉字幕时会产生成百上千次写库，逐次重写整个 JSON 既慢又费磁盘。
 * `transaction()` / `transactionAsync()` 把区间内的落盘合并成一次。
 */
let batchDepth = 0

/**
 * 迁移老数据。
 * 早期版本把 UP主 的 B站 UID 存成 `mid`，现在统一成 `uid`。
 */
function migrateStore(): void {
  for (const row of store.uploaders as Array<UploaderRow & { mid?: number | null }>) {
    if (row.uid === undefined) row.uid = row.mid ?? null
    delete row.mid
  }
}

/**
 * 初始化数据层。
 * @param userDataDir Electron 的 userData 目录
 * @param customCacheDir 设置里指定的字幕缓存目录（可选，留空则用默认位置）
 */
export function initDb(userDataDir: string, customCacheDir?: string): void {
  const dataDir = join(userDataDir, APP_DATA_DIR)
  cacheDir = customCacheDir?.trim() ? customCacheDir.trim() : join(dataDir, 'docs')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })
  dataFile = join(dataDir, 'srt-tool.json')

  // 从历史遗留位置抢救字幕正文：旧版本存在 <userData>/cache/docs，
  // 那个目录会被 Chromium 的磁盘缓存接管，能救回多少算多少。
  try {
    const legacy = join(userDataDir, 'cache', 'docs')
    if (existsSync(legacy) && legacy !== cacheDir) {
      for (const name of readdirSync(legacy)) {
        const src = join(legacy, name)
        const dest = join(cacheDir, name)
        if (!existsSync(dest)) copyFileSync(src, dest)
      }
    }
  } catch {
    /* 抢救失败不影响启动 */
  }

  if (existsSync(dataFile)) {
    try {
      const parsed = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<Store>
      store = { ...emptyStore(), ...parsed, seq: { ...emptyStore().seq, ...(parsed.seq ?? {}) } }
      migrateStore()
    } catch {
      // 文件损坏时保留现场并重新开始
      try {
        renameSync(dataFile, `${dataFile}.broken`)
      } catch {
        /* ignore */
      }
      store = emptyStore()
    }
  } else {
    store = emptyStore()
  }
}

/** 原子落盘：先写临时文件，再 rename 覆盖 */
function flushNow(): void {
  if (!dataFile) return
  mkdirSync(dirname(dataFile), { recursive: true })
  const tmp = `${dataFile}.tmp`
  writeFileSync(tmp, JSON.stringify(store), 'utf8')
  renameSync(tmp, dataFile)
  dirty = false
}

/**
 * 落盘。
 * 数据量很小（几十 KB），默认直接同步写入，避免进程被强制结束或机器异常时丢数据。
 * 处于批量区间（batchDepth > 0）时只打脏标记，等区间结束再统一写一次。
 * 写失败时保留 dirty 标记，下次变更或退出时再试。
 */
function markDirty(): void {
  dirty = true
  if (batchDepth > 0) return
  try {
    flushNow()
  } catch {
    /* 写失败（例如磁盘临时不可用）时保留 dirty，退出前还会再试一次 */
  }
}

/** 结束一层批量区间；最外层结束时补一次落盘 */
function endBatch(): void {
  batchDepth--
  if (batchDepth > 0) return
  batchDepth = 0
  if (!dirty) return
  try {
    flushNow()
  } catch {
    /* 保留 dirty，退出前还会再试一次 */
  }
}

/**
 * 把一段连续的写操作合并成一次落盘。
 * 批量拉字幕时落盘次数从「每条字幕一次」降到「每批一次」。
 */
export function transaction<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    endBatch()
  }
}

/** `transaction` 的异步版本（批量拉取要等网络，必须 await） */
export async function transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
  batchDepth++
  try {
    return await fn()
  } finally {
    endBatch()
  }
}

export function closeDb(): void {
  batchDepth = 0
  if (dirty) flushNow()
}

/* ---------------------------------- 缓存 ---------------------------------- */

function cuePath(docId: number): string {
  return join(cacheDir, `${docId}.json`)
}

export function saveCues(docId: number, cues: Cue[]): void {
  // 防御：目录可能被外部清理，写入前确保存在
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cuePath(docId), JSON.stringify(cues), 'utf8')
}

export function loadCues(docId: number): Cue[] {
  const p = cuePath(docId)
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Cue[]
  } catch {
    return []
  }
}

/* --------------------------------- 资源写入 -------------------------------- */

/**
 * 写入 / 复用 UP主。
 *
 * **身份只认 UID**：只要 UID 相同，不管这次数据来自桌面端拉取、插件推送还是本地导入，
 * 都会复用同一个 UP主 节点，不会因为来源不同而分裂成多个分组。
 * 只有确实拿不到 UID 时（纯本地文件、接口查询失败），才退化成按名字区分。
 */
export function upsertUploader(uid: number | null, name: string, avatar?: string): number {
  if (uid) {
    const hit = store.uploaders.find((u) => u.uid === uid)
    if (hit) {
      if (hit.name !== name) hit.name = name
      if (avatar && hit.avatar !== avatar) hit.avatar = avatar
      markDirty()
      return hit.id
    }
  } else {
    const hit = store.uploaders.find((u) => u.uid === null && u.name === name)
    if (hit) return hit.id
  }
  const row: UploaderRow = {
    id: ++store.seq.uploaders,
    uid: uid ?? null,
    name,
    avatar: avatar ?? null,
    favorite: 0,
    createdAt: Date.now()
  }
  store.uploaders.push(row)
  markDirty()
  return row.id
}

export function upsertCollection(
  uploaderId: number | null,
  sid: string | null,
  title: string,
  url?: string
): number {
  // 有 sid（B站合集 / 系列）时按「UP主 + sid」定位，否则按「UP主 + 标题」定位。
  // 带上 uploaderId 是为了避免不同 UP主 之间互相串组。
  const hit = sid
    ? store.collections.find((c) => c.sid === sid && c.uploaderId === uploaderId)
    : store.collections.find(
        (c) => c.sid === null && c.title === title && c.uploaderId === uploaderId
      )
  if (hit) {
    let changed = false
    if (title && hit.title !== title) {
      hit.title = title
      changed = true
    }
    if (url && hit.url !== url) {
      hit.url = url
      changed = true
    }
    if (changed) markDirty()
    return hit.id
  }

  const row: CollectionRow = {
    id: ++store.seq.collections,
    uploaderId: uploaderId ?? null,
    sid: sid ?? null,
    title,
    url: url ?? null,
    favorite: 0,
    createdAt: Date.now()
  }
  store.collections.push(row)
  markDirty()
  return row.id
}

export function upsertVideo(
  collectionId: number | null,
  bvid: string,
  title: string,
  extra: Partial<Pick<VideoItem, 'url' | 'cover' | 'duration' | 'pageCount'>> = {}
): number {
  if (bvid) {
    const hit = store.videos.find((v) => v.bvid === bvid)
    if (hit) {
      const moved = collectionId != null && hit.collectionId !== collectionId
      if (title) hit.title = title
      if (extra.url) hit.url = extra.url
      if (extra.cover) hit.cover = extra.cover
      if (extra.duration != null) hit.duration = extra.duration
      if (extra.pageCount != null) hit.pageCount = extra.pageCount
      if (collectionId != null) hit.collectionId = collectionId
      markDirty()
      // 视频换了归属分组（例如插件先占位、随后补上了真实 UP主/合集）时，
      // 顺手清掉空掉的旧分组，避免资源树里留下空壳节点。
      if (moved) pruneEmptyGroups()
      return hit.id
    }
  }
  const row: VideoRow = {
    id: ++store.seq.videos,
    collectionId: collectionId ?? null,
    bvid,
    title,
    url: extra.url ?? '',
    cover: extra.cover ?? null,
    duration: extra.duration ?? null,
    pageCount: extra.pageCount ?? null,
    favorite: 0,
    createdAt: Date.now()
  }
  store.videos.push(row)
  markDirty()
  return row.id
}

/** 定位「同一视频 + 同一分P + 同一语言」的字幕文档（去重用） */
export function findDoc(videoId: number, page: number, lang: string): DocRow | undefined {
  return store.docs.find((d) => d.videoId === videoId && d.page === page && d.lang === lang)
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
 *
 * **去重键是「视频 + 分P + 语言」**：同一条字幕轨重复拉取 / 重复推送时**原地覆盖**，
 * 而不是再堆一份（早期版本每点一次「同步该视频」就多一份重复字幕）。
 * 不同语言仍然各自保留，所以补拉缺失语言不受影响。
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
  const hit = findDoc(videoId, page, lang)
  if (hit) {
    const previousCount = loadCues(hit.id).length
    if (label) hit.label = label
    if (filename) hit.filename = filename
    hit.source = source
    saveCues(hit.id, cues)
    markDirty()
    return { docId: hit.id, created: false, previousCount }
  }

  const row: DocRow = {
    id: ++store.seq.docs,
    videoId,
    page,
    lang,
    label,
    filename,
    source,
    favorite: 0,
    createdAt: Date.now()
  }
  store.docs.push(row)
  saveCues(row.id, cues)
  markDirty()
  return { docId: row.id, created: true, previousCount: 0 }
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
    videoId: r.videoId,
    page: r.page,
    lang: r.lang,
    label: r.label,
    filename: r.filename,
    source: r.source,
    createdAt: r.createdAt
  }
}

function toVideo(r: VideoRow): VideoItem {
  return {
    id: r.id,
    collectionId: r.collectionId,
    bvid: r.bvid,
    title: r.title,
    url: r.url,
    cover: r.cover,
    duration: r.duration,
    pageCount: r.pageCount,
    createdAt: r.createdAt
  }
}

export function getDoc(docId: number): SubtitleDoc | null {
  const row = store.docs.find((d) => d.id === docId)
  return row ? toDoc(row) : null
}

/** 同一视频下的全部字幕文档，按分P 排序 */
export function listDocsByVideo(videoId: number): SubtitleDoc[] {
  return store.docs
    .filter((d) => d.videoId === videoId)
    .sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
    .map(toDoc)
}

/** 按 BV 号查找视频（插件推送字幕时用） */
export function findVideoByBvid(bvid: string): VideoItem | null {
  const row = store.videos.find((v) => v.bvid === bvid)
  return row ? toVideo(row) : null
}

/**
 * 按标题查找「本地导入」的视频条目（也就是没有 BV 号的那些）。
 * 重复导入同一个文件时会复用它，不会每次都新建一个视频节点。
 */
export function findLocalVideo(title: string): VideoItem | null {
  const row = store.videos.find((v) => !v.bvid && v.title === title)
  return row ? toVideo(row) : null
}

export function getVideo(videoId: number): (VideoItem & { uploaderName?: string }) | null {
  const row = store.videos.find((v) => v.id === videoId)
  if (!row) return null
  const col = store.collections.find((c) => c.id === row.collectionId)
  const up = col ? store.uploaders.find((u) => u.id === col.uploaderId) : undefined
  return { ...toVideo(row), uploaderName: up?.name }
}

/** 语言代码 → 展示名（资源树上的小标签用；有 B站 返回的 label 时优先用 label） */
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
 */
export function buildTree(): TreeNode[] {
  // 先各建一次索引，避免在循环里反复整表扫描（原实现是 O(n²)）
  const docsByVideo = new Map<number, DocRow[]>()
  for (const d of store.docs) {
    const list = docsByVideo.get(d.videoId)
    if (list) list.push(d)
    else docsByVideo.set(d.videoId, [d])
  }

  const videosByCollection = new Map<number, VideoRow[]>()
  const orphanVideos: VideoRow[] = []
  for (const v of store.videos) {
    if (v.collectionId == null) {
      orphanVideos.push(v)
      continue
    }
    const list = videosByCollection.get(v.collectionId)
    if (list) list.push(v)
    else videosByCollection.set(v.collectionId, [v])
  }

  const collectionsByUploader = new Map<number, CollectionRow[]>()
  for (const c of store.collections) {
    if (c.uploaderId == null) continue
    const list = collectionsByUploader.get(c.uploaderId)
    if (list) list.push(c)
    else collectionsByUploader.set(c.uploaderId, [c])
  }

  const byCreated = <T extends { createdAt: number }>(a: T, b: T): number => a.createdAt - b.createdAt

  const videoNode = (v: VideoRow): TreeNode => {
    const docs = [...(docsByVideo.get(v.id) ?? [])].sort(
      (a, b) => a.page - b.page || a.createdAt - b.createdAt
    )
    const where = v.bvid || '本地'
    return {
      key: `video:${v.id}`,
      type: 'video',
      label: v.title || v.bvid || '未命名字幕',
      subtitle: docs.length ? `${where} · ${docs.length} 条字幕` : where,
      favorite: Boolean(v.favorite),
      children: docs.map(docNode)
    }
  }

  const nodes: TreeNode[] = []

  for (const up of [...store.uploaders].sort(byCreated)) {
    const colNodes: TreeNode[] = []
    for (const c of [...(collectionsByUploader.get(up.id) ?? [])].sort(byCreated)) {
      const vids = [...(videosByCollection.get(c.id) ?? [])].sort(byCreated)
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

  // 没有任何分组的孤立视频
  if (orphanVideos.length) {
    nodes.push({
      key: 'orphan',
      type: 'collection',
      label: '未分类视频',
      subtitle: `未分类 · ${orphanVideos.length}`,
      children: [...orphanVideos].sort(byCreated).map(videoNode)
    })
  }

  return nodes
}

/**
 * 清理空分组：没有任何视频的合集，以及没有任何合集的 UP主。
 *
 * 插件推送在拿不到视频信息时会先建占位分组，等真实 UP主/合集信息补上、
 * 视频归位之后，这些空壳就会被这里清掉，资源树不会越用越乱。
 * 资源树本身也会隐藏空分组，这里额外清数据是为了统计数字保持准确。
 *
 * @returns 被清掉的节点数
 */
export function pruneEmptyGroups(): number {
  const usedCollections = new Set<number>()
  for (const v of store.videos) {
    if (v.collectionId != null) usedCollections.add(v.collectionId)
  }

  const keptCollections = store.collections.filter((c) => usedCollections.has(c.id))
  const usedUploaders = new Set<number>()
  for (const c of keptCollections) {
    if (c.uploaderId != null) usedUploaders.add(c.uploaderId)
  }
  const keptUploaders = store.uploaders.filter((u) => usedUploaders.has(u.id))

  const removed =
    store.collections.length - keptCollections.length + (store.uploaders.length - keptUploaders.length)
  if (removed > 0) {
    store.collections = keptCollections
    store.uploaders = keptUploaders
    markDirty()
  }
  return removed
}

/* ---------------------------------- 删除 ---------------------------------- */

export function deleteDoc(docId: number): void {
  store.clips = store.clips.filter((c) => c.docId !== docId)
  store.docs = store.docs.filter((d) => d.id !== docId)
  const p = cuePath(docId)
  if (existsSync(p)) rmSync(p, { force: true })
  markDirty()
}

export function deleteVideo(videoId: number): void {
  for (const d of store.docs.filter((x) => x.videoId === videoId)) deleteDoc(d.id)
  store.videos = store.videos.filter((v) => v.id !== videoId)
  markDirty()
  pruneEmptyGroups()
}

export function deleteCollection(collectionId: number): void {
  for (const v of store.videos.filter((x) => x.collectionId === collectionId)) deleteVideo(v.id)
  store.collections = store.collections.filter((c) => c.id !== collectionId)
  markDirty()
  pruneEmptyGroups()
}

export function deleteUploader(uploaderId: number): void {
  for (const c of store.collections.filter((x) => x.uploaderId === uploaderId)) {
    deleteCollection(c.id)
  }
  store.uploaders = store.uploaders.filter((u) => u.id !== uploaderId)
  markDirty()
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

/* --------------------------------- 重命名 --------------------------------- */

/** 重命名资源（UP主 / 合集 / 视频 / 字幕文档） */
export function renameNode(key: string, name: string): void {
  const [type, idRaw] = key.split(':')
  const id = Number(idRaw)
  const value = (name ?? '').trim()
  if (!id || !value) return

  if (type === 'doc') {
    const row = store.docs.find((d) => d.id === id)
    if (row) row.label = value
  } else if (type === 'video') {
    const row = store.videos.find((v) => v.id === id)
    if (row) row.title = value
  } else if (type === 'collection') {
    const row = store.collections.find((c) => c.id === id)
    if (row) row.title = value
  } else if (type === 'uploader') {
    const row = store.uploaders.find((u) => u.id === id)
    if (row) row.name = value
  } else {
    return
  }
  markDirty()
}

/* ---------------------------------- 收藏 ---------------------------------- */

export function toggleFavorite(key: string): boolean {
  const [type, idRaw] = key.split(':')
  const id = Number(idRaw)
  const list =
    type === 'doc'
      ? store.docs
      : type === 'video'
        ? store.videos
        : type === 'collection'
          ? store.collections
          : store.uploaders
  const row = (list as Array<{ id: number; favorite: number }>).find((r) => r.id === id)
  if (!row) return false
  row.favorite = row.favorite ? 0 : 1
  markDirty()
  return Boolean(row.favorite)
}

/* --------------------------------- 切片任务 -------------------------------- */

export function addClipTasks(tasks: Omit<ClipTask, 'id' | 'createdAt'>[]): number {
  const now = Date.now()
  for (const t of tasks) {
    store.clips.push({
      id: ++store.seq.clips,
      docId: t.docId,
      bvid: t.bvid,
      page: t.page,
      start: t.start,
      end: t.end,
      note: t.note,
      createdAt: now,
      ...(t.segments && t.segments.length > 1 ? { segments: t.segments } : {})
    })
  }
  markDirty()
  return tasks.length
}

export function listClipTasks(): ClipTask[] {
  return [...store.clips]
    .sort((a, b) => b.createdAt - a.createdAt || a.id - b.id)
    .map((r) => ({ ...r }))
}

export function deleteClipTask(id: number): void {
  store.clips = store.clips.filter((c) => c.id !== id)
  markDirty()
}

export function clearClipTasks(): void {
  store.clips = []
  markDirty()
}

/** 全库统计，用于设置页展示 */
export function stats(): {
  uploaders: number
  collections: number
  videos: number
  docs: number
  clips: number
  /** 元数据还在、但字幕正文文件缺失的文档数（数据异常时 > 0） */
  missingCues: number
  /** 数据文件所在目录 */
  dataDir: string
} {
  // 列举一次目录，代替「每个文档一次 existsSync」——几万条字幕时差别很明显
  let present = new Set<string>()
  try {
    present = new Set(cacheDir ? readdirSync(cacheDir) : [])
  } catch {
    present = new Set()
  }

  let missingCues = 0
  for (const d of store.docs) {
    if (!present.has(`${d.id}.json`)) missingCues++
  }
  return {
    uploaders: store.uploaders.length,
    collections: store.collections.length,
    videos: store.videos.length,
    docs: store.docs.length,
    clips: store.clips.length,
    missingCues,
    dataDir: dataFile ? dirname(dataFile) : ''
  }
}

/** 数据文件是否需要重建（启动时自检用） */
export function isDataHealthy(): boolean {
  return stats().missingCues === 0
}
