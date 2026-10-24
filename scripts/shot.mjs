/**
 * 开发辅助脚本：通过 Chrome DevTools Protocol 操作运行中的应用（评估 JS / 截图）。
 * 用法：
 *   node scripts/shot.mjs eval "window.api.getStats()"
 *   node scripts/shot.mjs shot out.png
 *   node scripts/shot.mjs click "导入 SRT"
 */
import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT || 9222)

async function connect() {
  let list
  for (let i = 0; i < 40; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (list?.length) break
    } catch {
      /* 等待应用启动 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!list?.length) throw new Error('无法连接到调试端口，应用可能未启动')

  const page =
    list.find((t) => t.type === 'page' && !t.url.startsWith('devtools')) ??
    list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有找到页面目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('WebSocket 连接失败'))
  })

  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { send, close: () => ws.close() }
}

const [cmd, ...rest] = process.argv.slice(2)
const { send, close } = await connect()

if (cmd === 'eval') {
  const res = await send('Runtime.evaluate', {
    expression: rest.join(' '),
    awaitPromise: true,
    returnByValue: true
  })
  const r = res.result
  if (r?.exceptionDetails) {
    console.error('执行异常：', JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
    process.exitCode = 1
  } else {
    console.log(JSON.stringify(r?.result?.value ?? null, null, 2))
  }
} else if (cmd === 'click') {
  const text = rest.join(' ')
  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = [...document.querySelectorAll('button, .tnode, .btn')]
        .find(e => e.textContent.trim().includes(${JSON.stringify(text)}));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'CLICKED: ' + el.textContent.trim().slice(0, 40);
    })()`,
    returnByValue: true
  })
  console.log(res.result?.result?.value)
} else if (cmd === 'errors') {
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify(window.__errors || [])`,
    returnByValue: true
  })
  console.log(res.result?.result?.value)
} else if (cmd === 'shot') {
  const file = rest[0] || 'shot.png'
  await send('Page.enable')
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = res.result?.data
  if (!data) {
    console.error('截图失败：', JSON.stringify(res).slice(0, 300))
    process.exitCode = 1
  } else {
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`已保存截图：${file}`)
  }
} else {
  console.error('用法：node scripts/shot.mjs <eval|click|shot|errors> [参数]')
  process.exitCode = 1
}

close()
process.exit(process.exitCode ?? 0)
