/**
 * B站视频弹幕读取（主进程）。
 *
 * 设计原则：
 * - 弹幕只是字幕定位的辅助信息，任何失败都只影响辅助面板，不能影响字幕；
 * - 网络请求全部在主进程完成，渲染进程只拿到结构化结果；
 * - 分段串行改为**有限并发**，并设置总时间预算，避免长视频一次打开就发几十个请求；
 * - 解析逻辑在 `@shared/danmaku`，这里只负责抓取、回退、缓存与数量限制。
 */
import type { BiliPageInfo, DanmakuItem, DanmakuResult } from '@shared/types'
import {
  classifyEmptyDanmaku,
  DANMAKU_MAX_ITEMS,
  parseDanmakuSegment,
  parseDanmakuXml
} from '@shared/danmaku'
import { getVideoInfo, UA } from './bilibili'
import { loadSettings } from './settings'

/** 弹幕缓存时长：只放内存，不落盘 */
const CACHE_TTL_MS = 10 * 60_000
/** 最多缓存几个视频，避免一次浏览大量视频后内存不释放 */
const CACHE_MAX = 8
/** 一次最多读取多少个 6 分钟分段（跨分P 合计） */
const MAX_SEGMENTS = 80
/** B站分段弹幕每段覆盖 6 分钟 */
const SEGMENT_SECONDS = 360
/** 并行抓取数：兼顾速度与接口压力 */
const FETCH_CONCURRENCY = 4
/** 单个请求超时 */
const FETCH_TIMEOUT_MS = 15_000
/** 一次读取的总时间预算；超时返回已拿到的部分 */
const TOTAL_BUDGET_MS = 60_000
/** 剩余时间少于这个值就不再发起新请求 */
const MIN_FETCH_WINDOW_MS = 800
/** 单个响应的大小上限，防止异常数据 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const decoder = new TextDecoder()
const cache = new Map<string, { expires: number; result: DanmakuResult }>()
const inflight = new Map<string, Promise<DanmakuResult>>()

interface PagePlan {
  page: BiliPageInfo
  items: DanmakuItem[]
  attempted: number
  succeeded: number
  failedSegments: number[]
}

interface SegmentTask {
  plan: PagePlan
  index: number
}

/**
 * 读取一个 BV 号下所有分P 的弹幕。
 *
 * @param force 跳过缓存（面板的「重新获取」用），成功后仍会刷新缓存
 */
export function fetchDanmaku(bvid: string, force = false): Promise<DanmakuResult> {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return Promise.reject(new Error('BV号格式不正确'))
  if (!force) {
    const hit = cache.get(bvid)
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.result)
    const running = inflight.get(bvid)
    if (running) return running
  }
  const promise = loadDanmaku(bvid)
  inflight.set(bvid, promise)
  const clear = (): void => {
    if (inflight.get(bvid) === promise) inflight.delete(bvid)
  }
  void promise.then(clear, clear)
  return promise
}

async function loadDanmaku(bvid: string): Promise<DanmakuResult> {
  const cookie = loadSettings().biliCookie || ''
  const info = await getVideoInfo(bvid, cookie)
  const result: DanmakuResult = {
    bvid,
    pages: info.pages.length,
    items: [],
    truncated: false,
    warnings: []
  }

  // 视频弹幕总数就是 0：分段接口只会返回空响应，不必白跑几十个请求；
  // 同时把「为什么没有弹幕」告诉面板，避免把直播回放的空弹幕池说成接口故障。
  if (info.danmakuCount === 0) {
    result.emptyReason = classifyEmptyDanmaku(info.desc ?? '', info.title)
    return remember(bvid, result)
  }

  const plans: PagePlan[] = info.pages.map((page) => ({
    page,
    items: [],
    attempted: 0,
    succeeded: 0,
    failedSegments: []
  }))
  const tasks: SegmentTask[] = []
  let totalSegments = 0
  for (const plan of plans) {
    const count = Math.max(1, Math.ceil(Math.max(0, plan.page.duration) / SEGMENT_SECONDS))
    totalSegments += count
    for (let index = 1; index <= count && tasks.length < MAX_SEGMENTS; index++) {
      tasks.push({ plan, index })
    }
  }
  if (totalSegments > tasks.length) result.truncated = true

  const deadline = Date.now() + TOTAL_BUDGET_MS
  let cursor = 0
  let stopped = false
  let budgetExceeded = false
  let itemCapReached = false
  let totalItems = 0

  const takeTask = (): SegmentTask | null => {
    if (stopped) return null
    const task = tasks[cursor++]
    if (!task) return null
    if (deadline - Date.now() < MIN_FETCH_WINDOW_MS) {
      budgetExceeded = true
      stopped = true
      return null
    }
    return task
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const task = takeTask()
      if (!task) return
      task.plan.attempted++
      const remaining = Math.max(1, deadline - Date.now())
      try {
        const bytes = await fetchBytes(
          `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${task.plan.page.cid}&segment_index=${task.index}`,
          cookie,
          Math.min(FETCH_TIMEOUT_MS, remaining)
        )
        const parsed = parseDanmakuSegment(bytes, task.plan.page.page)
        task.plan.items.push(...parsed)
        task.plan.succeeded++
        totalItems += parsed.length
        if (totalItems >= DANMAKU_MAX_ITEMS) {
          itemCapReached = true
          stopped = true
          return
        }
      } catch {
        task.plan.failedSegments.push(task.index)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, tasks.length) }, () => worker())
  )

  // 整页都失败时才回退 XML；已经拿到部分分段就不再用旧接口重复读整页。
  for (const plan of plans) {
    if (plan.attempted === 0 || plan.succeeded > 0) continue
    if (budgetExceeded || deadline - Date.now() < MIN_FETCH_WINDOW_MS) {
      budgetExceeded = true
      break
    }
    try {
      const xml = decoder.decode(
        await fetchBytes(
          `https://comment.bilibili.com/${plan.page.cid}.xml`,
          cookie,
          Math.min(FETCH_TIMEOUT_MS, Math.max(1, deadline - Date.now()))
        )
      )
      plan.items.push(...parseDanmakuXml(xml, plan.page.page))
    } catch {
      pushWarning(result.warnings, `P${plan.page.page} 暂时无法获取弹幕`)
    }
  }

  if (itemCapReached) result.truncated = true
  if (budgetExceeded) {
    result.truncated = true
    pushWarning(result.warnings, '读取超时，只返回已获取的弹幕')
  }
  for (const plan of plans) {
    if (plan.succeeded > 0 && plan.failedSegments.length) {
      pushWarning(
        result.warnings,
        `P${plan.page.page} 有 ${plan.failedSegments.length} 个分段读取失败，弹幕可能不全`
      )
    }
  }

  for (const plan of plans) result.items.push(...plan.items)
  result.items.sort((a, b) => a.page - b.page || a.time - b.time)
  if (result.items.length > DANMAKU_MAX_ITEMS) {
    result.items = result.items.slice(0, DANMAKU_MAX_ITEMS)
    result.truncated = true
  }

  remember(bvid, result)
  return result
}

/** 写入 10 分钟内存缓存，并限制缓存条数 */
function remember(bvid: string, result: DanmakuResult): DanmakuResult {
  cache.set(bvid, { expires: Date.now() + CACHE_TTL_MS, result })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return result
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length < 6 && !warnings.includes(message)) warnings.push(message)
}

async function fetchBytes(url: string, cookie: string, timeoutMs: number): Promise<Uint8Array> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Accept: '*/*'
  }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(Math.max(1, timeoutMs))
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length') || 0)
  if (length > MAX_RESPONSE_BYTES) throw new Error('弹幕响应过大')
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.length > MAX_RESPONSE_BYTES) throw new Error('弹幕响应过大')
  return data
}
