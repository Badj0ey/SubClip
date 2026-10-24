/**
 * 开发辅助：一个最小的 OpenAI 兼容假服务。
 *
 * 用途：**在没有真实模型的情况下验证 AI 链路**（设置 → 探测 → 生成 → 落库 → 读缓存）。
 * 它不是 mock 掉被测代码，而是站在真实 HTTP 对面按协议应答 —— 所以
 * 请求体构造、超时、响应解析、JSON 容错、错误处理这些都会真的被执行到。
 *
 * 用法：
 *   node scripts/fake-openai.mjs 8877
 *   然后把「设置 → AI 能力层」的后端设成 OpenAI 兼容、Base URL 填 http://127.0.0.1:8877/v1、Key 随便填。
 *   > 别用 8765：那是本应用自己的插件 WebSocket 端口，会撞上（对方回 426 Upgrade Required）。
 *
 * 它按提示词的**输出格式要求**决定回什么（而不是猜关键词 —— 「标题」两个字在摘要提示里
 * 也会出现，按关键词会串味）：
 *   - 要求 JSON（标签建议）→ 返回 {"tags":[...]}，故意包一层代码围栏来测容错
 *   - 要求「只输出一个标题」→ 返回带引号的标题，测清理逻辑
 *   - 提到「解释」→ 返回一句解释
 *   - 其余（摘要）→ 返回一段摘要
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || 8877)

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model-1' }, { id: 'fake-model-2' }] }))
    return
  }

  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const body = JSON.parse((await readBody(req)) || '{}')
    const messages = body.messages ?? []
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    const joined = `${system}\n${user}`
    // 看服务端实际收到的是不是带 json 格式要求（这样也能验证请求构造正确）
    const wantsJson = Boolean(body.response_format) || /JSON/i.test(system)

    let content
    // 判据用「提示词里独有的格式要求」，避免互相串味：
    //   - 标签提示独有 `{"tags":[{"name"`
    //   - 标题提示独有「只输出一个标题」
    //   - 解释提示独有「解释」
    if (/只输出一个标题/.test(system) && !wantsJson) {
      content = '「AI改变软件开发」'
    } else if (/打分器/.test(system)) {
      // 云端语义打分（ai:rank）
      content = '{"scores":[{"i":1,"score":82},{"i":2,"score":35},{"i":3,"score":7}]}'
    } else if (wantsJson && /\{"tags"/.test(user)) {
      content = '```json\n{"tags":[{"name":"人工智能","reason":"提到了大模型"},{"name":"剪辑","why":"讲了切片"}]}\n```'
    } else if (/解释/.test(system)) {
      content = '这句话在讲把长视频切成短视频的做法：先找高光段落，再按段落导出。'
    } else {
      content = '这段直播围绕 AI 与短视频剪辑展开：讲了模型能力边界，也演示了把长视频切成短视频的流程。'
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'fake-1',
        object: 'chat.completion',
        model: body.model ?? 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        // 把收到的关键信息回显一部分，便于人工核对请求构造
        _echo: { wantsJson, model: body.model ?? '', temperature: body.temperature ?? null }
      })
    )
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url.pathname}` } }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`假 OpenAI 兼容服务已启动：http://127.0.0.1:${port}/v1`)
})
