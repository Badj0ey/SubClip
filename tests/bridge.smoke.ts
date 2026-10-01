/**
 * 浏览器插件通信的端到端测试。
 * 用 Node 端的 ws 客户端模拟插件，验证：握手、页面信息落库、字幕落库、
 * 异常消息容错、反向下发、连接统计、端口占用处理。
 * 运行：npm run test:bridge
 */
import { app } from 'electron'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { TreeNode } from '../src/shared/types'
import { bridge } from '../src/main/bridge'
import * as db from '../src/main/db'
import { wireBridge } from '../src/main/wire'

const PORT = 18765
const workDir = mkdtempSync(join(tmpdir(), 'srt-tool-bridge-'))
app.setPath('userData', workDir)

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

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 轮询等待条件成立（字幕入库可能要先查一次 B站接口，耗时不确定） */
async function waitFor(fn: () => boolean, timeout = 8000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return true
    await wait(100)
  }
  return false
}

/** 摊平资源树，便于按 key 查找节点 */
function walk(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children) walk(n.children, out)
  }
  return out
}

/** 从资源树里找某个视频节点所属的顶层分组名 */
function groupOf(videoId: number): string | null {
  for (const root of db.buildTree()) {
    if (walk([root]).some((n) => n.key === `video:${videoId}`)) return root.label
  }
  return null
}

async function run(): Promise<void> {
  console.log('\n【浏览器插件通信 · 端到端测试】')

  db.initDb(workDir)

  const pushes: Array<{ channel: string; payload: any }> = []
  wireBridge((channel, payload) => pushes.push({ channel, payload }))

  bridge.start(PORT)
  await wait(500)

  check('服务端启动并监听指定端口', () => {
    const s = bridge.status()
    assert.strictEqual(s.running, true)
    assert.strictEqual(s.port, PORT)
    assert.strictEqual(s.error, null)
  })

  /* ------------------------------ 连接与握手 ------------------------------ */
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const inbox: any[] = []
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  await wait(250)

  check('连接后收到服务端主动握手', () => {
    const hello = inbox.find((m) => m.type === 'hello-ack')
    assert.ok(hello, '没有收到 hello-ack')
    assert.strictEqual(hello.server, 'srt-clip-helper')
    assert.strictEqual(typeof hello.protocol, 'number')
  })

  check('连接数统计为 1', () => {
    assert.strictEqual(bridge.status().clients.length, 1)
  })

  ws.send(JSON.stringify({ type: 'hello', version: '1.0.0', browser: 'Edge' }))
  await wait(250)

  check('握手后记录插件版本与浏览器', () => {
    const c = bridge.status().clients[0]
    assert.strictEqual(c.browser, 'Edge')
    assert.strictEqual(c.version, '1.0.0')
  })

  /* ------------------------------ 页面信息同步 ----------------------------- */
  ws.send(
    JSON.stringify({
      type: 'page-info',
      payload: {
        pageType: 'video',
        bvid: 'BV1GJ411x7h7',
        title: '测试视频标题',
        url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
        page: 2,
        cid: 123456,
        uploader: { uid: 12345, name: '测试UP主', avatar: null },
        seasonId: 999,
        seasonTitle: '测试合集'
      }
    })
  )
  await wait(350)

  check('页面信息落库为 UP主 → 合集 → 视频', () => {
    const s = db.stats()
    assert.strictEqual(s.uploaders, 1)
    assert.strictEqual(s.collections, 1)
    assert.strictEqual(s.videos, 1)
    const tree = db.buildTree()
    assert.strictEqual(tree[0].label, '测试UP主')
    assert.strictEqual(tree[0].children?.[0].label, '测试合集')
    assert.strictEqual(tree[0].children?.[0].children?.[0].label, '测试视频标题')
  })

  check('服务端回 ack 并向上层推送事件', () => {
    assert.ok(inbox.some((m) => m.type === 'ack' && m.ok === true))
    assert.ok(pushes.some((p) => p.channel === 'bridge:page-info'))
  })

  /* -------------------------------- 字幕同步 ------------------------------- */
  ws.send(
    JSON.stringify({
      type: 'subtitle',
      payload: {
        bvid: 'BV1GJ411x7h7',
        page: 2,
        lang: 'zh-CN',
        label: '简体中文（AI）',
        cues: [
          { from: 1.5, to: 3.2, content: '第一句字幕' },
          { from: 3.3, to: 5.0, content: '第二句字幕' },
          { from: 5.1, to: 6.0, content: '   ' }
        ]
      }
    })
  )
  await wait(350)

  check('字幕落库并跳过空白条目', () => {
    const tree = db.buildTree()
    const docs = tree[0].children?.[0].children?.[0].children ?? []
    assert.strictEqual(docs.length, 1, '字幕文档数量不对')
    const docId = (docs[0].payload as { id: number }).id
    const cues = db.loadCues(docId)
    assert.strictEqual(cues.length, 2)
    assert.strictEqual(cues[0].text, '第一句字幕')
    assert.strictEqual(cues[0].start, 1.5)
  })

  check('字幕推送事件携带条数与状态', () => {
    const ev = pushes.find((p) => p.channel === 'bridge:subtitle')
    assert.ok(ev, '没有收到 bridge:subtitle')
    assert.strictEqual(ev!.payload.count, 2)
    assert.strictEqual(ev!.payload.ok, true)
    assert.strictEqual(ev!.payload.page, 2)
    assert.strictEqual(ev!.payload.created, true, '首次推送应标记为新建')
  })

  /* --------------------------- 同一语言重复推送去重 -------------------------- */
  ws.send(
    JSON.stringify({
      type: 'subtitle',
      payload: {
        bvid: 'BV1GJ411x7h7',
        page: 2,
        lang: 'zh-CN',
        label: '简体中文（AI）',
        cues: [
          { from: 1.5, to: 3.2, content: '第一句字幕（已修正）' },
          { from: 3.3, to: 5.0, content: '第二句字幕' }
        ]
      }
    })
  )
  await wait(400)

  check('同一分P 同一语言重复推送时原地覆盖，不再堆出重复字幕', () => {
    const tree = db.buildTree()
    const docs = tree[0].children?.[0].children?.[0].children ?? []
    assert.strictEqual(docs.length, 1, `字幕文档数应仍为 1，实际 ${docs.length}`)
    const docId = (docs[0].payload as { id: number }).id
    const cues = db.loadCues(docId)
    assert.strictEqual(cues.length, 2)
    assert.strictEqual(cues[0].text, '第一句字幕（已修正）', '内容应被覆盖更新')
    const ev = [...pushes].reverse().find((p) => p.channel === 'bridge:subtitle')
    assert.strictEqual(ev!.payload.created, false, '覆盖更新时应标记为非新建')
  })

  /* ---------------------------- 没有 BV 号的推送 ---------------------------- */
  const videosBefore = db.stats().videos
  ws.send(
    JSON.stringify({
      type: 'subtitle',
      payload: { bvid: '', page: 1, lang: 'zh', label: '无主字幕', cues: [{ from: 0, to: 1, content: 'x' }] }
    })
  )
  ws.send(
    JSON.stringify({
      type: 'subtitle',
      payload: { bvid: '不是BV号', page: 1, lang: 'zh', label: '伪BV', cues: [{ from: 0, to: 1, content: 'y' }] }
    })
  )
  await wait(400)

  check('缺少 BV 号的推送被丢弃，不会建出 bvid 为空的垃圾条目', () => {
    assert.strictEqual(db.stats().videos, videosBefore, '视频数不应变化')
    assert.strictEqual(db.findVideoByBvid(''), null)
  })

  /* ------------------------ 无具体视频的页面信息不落库 ----------------------- */
  const beforeSeason = db.stats()
  ws.send(
    JSON.stringify({
      type: 'page-info',
      payload: {
        pageType: 'season',
        bvid: '',
        title: '某个合集页',
        url: 'https://space.bilibili.com/12345/lists/999',
        page: 1,
        uploader: { uid: 12345, name: '测试UP主', avatar: null }
      }
    })
  )
  await wait(400)

  check('合集页 / 收藏夹等没有具体视频的页面不再建空条目', () => {
    const after = db.stats()
    assert.strictEqual(after.videos, beforeSeason.videos, '不应新建视频')
    assert.strictEqual(after.collections, beforeSeason.collections, '不应新建空合集')
    const ev = [...pushes].reverse().find((p) => p.channel === 'bridge:page-info')
    assert.strictEqual(ev!.payload.videoId, null)
    assert.ok(ev!.payload.message, '应给出说明文案')
  })

  /* -------------------- 查不到视频信息时落到「未关联」占位 -------------------- */
  // 特意用一个格式合法但不存在的 BV 号：接口一定查不到，走到占位分支
  ws.send(
    JSON.stringify({
      type: 'subtitle',
      payload: {
        bvid: 'BV1INVALID00',
        page: 1,
        lang: 'zh',
        label: '测试轨',
        cues: [{ from: 0, to: 1, content: '孤立字幕' }]
      }
    })
  )
  await waitFor(() => Boolean(db.findVideoByBvid('BV1INVALID00')))
  await wait(200)

  check('查不到视频信息时字幕先落到「未关联」占位分组', () => {
    const v = db.findVideoByBvid('BV1INVALID00')
    assert.ok(v, '占位视频不存在')
    assert.strictEqual(groupOf(v!.id), db.UNKNOWN_UPLOADER_NAME)
    assert.strictEqual(v!.title, 'BV1INVALID00')
  })

  /* ------------------------- 页面信息补上后自动归位 ------------------------- */
  ws.send(
    JSON.stringify({
      type: 'page-info',
      payload: {
        pageType: 'video',
        bvid: 'BV1INVALID00',
        title: '后来才知道标题的视频',
        url: 'https://www.bilibili.com/video/BV1INVALID00',
        page: 1,
        uploader: { uid: 555001, name: '真实UP主', avatar: null }
      }
    })
  )
  await wait(400)

  check('页面信息补上后视频自动归位，占位分组被清理', () => {
    const v = db.findVideoByBvid('BV1INVALID00')
    assert.ok(v)
    assert.strictEqual(groupOf(v!.id), '真实UP主', '应归到真实 UP主 下')
    const labels = db.buildTree().map((n) => n.label)
    assert.ok(!labels.includes(db.UNKNOWN_UPLOADER_NAME), '「未关联」占位分组应已消失')
    assert.strictEqual(v!.title, '后来才知道标题的视频', '标题应被补全')
  })

  /* -------------------------- UP主 身份只认 UID --------------------------- */
  const uploadersBefore = db.stats().uploaders
  ws.send(
    JSON.stringify({
      type: 'page-info',
      payload: {
        pageType: 'video',
        bvid: 'BV1INVALID01',
        title: '同一个 UP主 的另一个视频',
        url: 'https://www.bilibili.com/video/BV1INVALID01',
        page: 1,
        // UID 相同、昵称改了：应按 UID 复用同一个 UP主，而不是新建一个
        uploader: { uid: 555001, name: '真实UP主（改过名）', avatar: null }
      }
    })
  )
  await wait(400)

  check('UID 相同即视为同一个 UP主（昵称变化不会分裂成两个分组）', () => {
    assert.strictEqual(db.stats().uploaders, uploadersBefore, 'UP主 数量不应增加')
    const tree = db.buildTree()
    const same = tree.filter((n) => n.label === '真实UP主' || n.label === '真实UP主（改过名）')
    assert.strictEqual(same.length, 1, '应只有一个分组')
    assert.strictEqual(same[0].label, '真实UP主（改过名）', '昵称应更新为最新')
    assert.strictEqual(same[0].subtitle, 'UID 555001')
  })

  /* -------------------------------- 容错处理 ------------------------------- */
  ws.send('这不是合法的 JSON')
  ws.send(JSON.stringify({ type: 'no-such-type' }))
  ws.send(JSON.stringify({ payload: {} }))
  await wait(300)

  check('非法 / 未知消息不影响服务运行', () => {
    const s = bridge.status()
    assert.strictEqual(s.running, true)
    assert.strictEqual(s.clients.length, 1)
  })

  /* ------------------------------ 反向请求下发 ----------------------------- */
  check('可向插件下发字幕抓取请求', () => {
    const ok = bridge.requestSubtitles('BV1GJ411x7h7', 2, 999)
    assert.strictEqual(ok, true)
  })
  await wait(250)

  check('插件侧收到 request-subtitles', () => {
    const msg = inbox.find((m) => m.type === 'request-subtitles')
    assert.ok(msg, '没有收到 request-subtitles')
    assert.strictEqual(msg.bvid, 'BV1GJ411x7h7')
    assert.strictEqual(msg.page, 2)
    assert.strictEqual(msg.cid, 999)
  })

  /* -------------------------------- 连接断开 ------------------------------- */
  ws.close()
  await wait(400)

  check('断开后连接数归零', () => {
    assert.strictEqual(bridge.status().clients.length, 0)
  })

  check('无插件时下发请求返回 false', () => {
    assert.strictEqual(bridge.requestSubtitles('BV1', 1), false)
  })

  /* -------------------------------- 端口占用 ------------------------------- */
  const blocker = new WebSocketServer({ host: '127.0.0.1', port: PORT + 1 })
  await new Promise<void>((r) => blocker.on('listening', () => r()))
  bridge.start(PORT + 1)
  await wait(500)

  check('端口被占用时给出可读错误', () => {
    const s = bridge.status()
    assert.strictEqual(s.running, false)
    assert.ok(s.error && s.error.includes('占用'), `实际错误：${s.error}`)
  })

  await new Promise<void>((r) => blocker.close(() => r()))

  /* -------------------------------- 停止服务 ------------------------------- */
  bridge.start(PORT)
  await wait(400)
  bridge.stop()

  check('停止后状态为未运行', () => {
    assert.strictEqual(bridge.status().running, false)
  })

  db.closeDb()
  console.log(`\n通过 ${passed}，失败 ${failed}\n`)

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  app.exit(failed > 0 ? 1 : 0)
}

app.whenReady().then(run).catch((err) => {
  console.error('桥接测试异常：', err)
  app.exit(1)
})
