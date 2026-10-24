/**
 * 开发调试用：模拟用户脚本连接桌面端，发送页面信息与字幕。
 * 用法：node tests/fake-plugin.mjs [port]
 *
 * 第七阶段（协议 v5）后，模拟插件按**统一信封**发消息：带 `v` 与 `caps`，
 * 否则桌面端会把它当成 v4 老客户端（走宽限期放行，但设置页会显示「未声明能力」）。
 * 环境变量 `LEGACY=1` 可以强制模拟老插件（不带信封），用来验证宽限期行为。
 */
import WebSocket from 'ws'

const port = Number(process.argv[2] || 8765)
const LEGACY = process.env.LEGACY === '1'
const PROTOCOL = LEGACY ? 1 : 5

/** v4 老插件不带信封；新插件每条消息都带 v + caps */
const envelope = LEGACY
  ? {}
  : {
      v: PROTOCOL,
      caps: { pageInfo: true, subtitle: true, cookies: true, pullRequest: true, requestSubtitles: true }
    }

const ws = new WebSocket(`ws://127.0.0.1:${port}`)

const PAGE = {
  pageType: 'video',
  bvid: 'BV1GJ411x7h7',
  title: '【模拟用户脚本】测试视频标题',
  url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  page: 1,
  cid: 120000001,
  uploader: { uid: 703007996, name: '模拟UP主', avatar: null },
  seasonId: 8888,
  seasonTitle: '模拟合集'
}

const CUES = [
  { from: 1, to: 4.2, content: '这是用户脚本推送的第一句字幕' },
  { from: 4.3, to: 8.1, content: '第二句：这里是高光片段' },
  { from: 8.2, to: 12, content: '第三句：需要单独剪出来' },
  { from: 80, to: 84.5, content: '第四句：另一段高光' },
  { from: 84.6, to: 88, content: '第五句：结束' }
]

ws.on('open', () => {
  console.log(LEGACY ? '✓ 已连接（模拟 v4 老插件，不带信封）' : '✓ 已连接（协议 v5）')
  ws.send(JSON.stringify({ type: 'hello', ...envelope, version: '2.4.0', browser: 'Edge' }))
  setTimeout(() => {
    console.log('→ 发送页面信息')
    ws.send(JSON.stringify({ type: 'page-info', ...envelope, payload: PAGE }))
  }, 200)
  setTimeout(() => {
    console.log('→ 发送字幕（5 条）')
    ws.send(
      JSON.stringify({
        type: 'subtitle',
        ...envelope,
        payload: { bvid: PAGE.bvid, page: 1, lang: 'zh-CN', label: '简体中文（AI）', cues: CUES }
      })
    )
  }, 700)
  setTimeout(() => {
    ws.close()
  }, Number(process.env.HOLD_MS || 2200))
})

ws.on('message', (raw) => {
  console.log('← ' + raw.toString().slice(0, 150))
})

ws.on('error', (err) => {
  console.error('✗ 连接失败：', err.message)
  process.exit(1)
})

ws.on('close', () => {
  console.log('连接已关闭')
  process.exit(0)
})
