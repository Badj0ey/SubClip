# 安全策略

## 报告漏洞

请**不要**用公开 issue 报告安全问题。优先用 GitHub 的
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 → Security → Advisories → Report a vulnerability）。

如果不方便使用，也可以开一个只写「我想报告一个安全问题，请给我联系方式」的 issue，我们换私密渠道沟通。

请在报告里尽量包含：影响版本、复现步骤、影响范围、以及你建议的修复方向。

## 这个工具会碰到你的哪些敏感数据

为了让报告有据可依，这里说明清楚：

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| B站登录凭证（Cookie） | `<用户目录>\srt-clip-helper\settings.json` | **明文**存储。用于以你的身份调用 B站接口拉字幕 |
| 字幕与资源库 | `<用户目录>\srt-clip-helper\srt-tool-data\srt-tool.db` | SQLite，含视频标题、UP主、字幕正文 |
| 本地服务端口 | 默认 `127.0.0.1:8765` | 桌面端作 WebSocket 服务端，浏览器用户脚本作客户端 |

**已知的取舍**：Cookie 目前是明文存的（没有用 Electron 的 `safeStorage` 走系统加密）。
也就是说，任何以你的用户身份运行的程序都能读到它。这一点记在待办里，尚未修。

## 本地服务的安全模型

WebSocket 握手**不受 CORS 约束**，所以「只绑 127.0.0.1」并不足以挡住本机网页 ——
你访问的任何一个页面都能向 `ws://127.0.0.1:8765` 发起连接。因此服务端自己带三道闸门：

1. **Origin 白名单**：只放行 B 站页面来源（`https://*.bilibili.com`）。用户脚本的 WebSocket Origin
   就是页面来源，没有固定扩展 ID；来源不符时回一条说明并立即断开，不发送任何数据。
2. **逐类型消息校验**（`parseClientMessage`）：BV 号格式、时间必须是有限数、字幕条数与字符串长度都有上限。
3. **`maxPayload` 512 KB + 每连接每秒消息数上限**：`ws` 默认 `maxPayload` 高达 100 MiB，必须显式收窄。

另有一个**可选的配对令牌**（设置 → 浏览器用户脚本通信）：开启后用户脚本必须在握手时带上同样的值。
默认关闭 —— 因为来历不明的网页已经过不了 Origin 白名单，令牌主要防「本机其它程序伪造 Origin」这种更边缘的情况。
由于 Origin 只能按域名放行，强烈建议在多人/共享机器上启用令牌。

渲染进程同样不被无条件信任：主进程只读写「用户本人在系统对话框里选过的路径」，
「打开」动作限制在应用自己的目录内，并拒绝可执行扩展名。

**拖拽导入是一个例外，但它自己把关**：拖进窗口的文件没经过「选择文件」对话框，
所以主进程会先校验「扩展名在白名单内（`.srt` / `.vtt` / `.txt`）、路径真实存在、且是普通文件」，
通过后才登记为已批准。也就是说，即便渲染进程被注入，也无法借这个入口去读任意本地文件。
这条边界有实测覆盖：拖入 `.exe` 与不存在的路径都会被拒。

## 历史上的一个真实漏洞（已修复）

早期版本的本地服务不校验 Origin、也没有任何鉴权，于是**任意网页**都能连上并发送 `cookies` 消息，
把桌面端存的 B站凭证改掉；还能借用户账号去调 B站接口、往库里灌数据、用一条畸形帧打爆主进程内存。

- 修复前 PoC：`origin: https://evil.example` 被接受，`biliCookie` 变成 `SESSDATA=attacker-controlled`。
- 修复后同一条 PoC：握手被标记 `rejected`、连接关闭、凭证不变。

对应的回归测试在 `tests/bridge.smoke.ts`（来源校验 / 配对令牌）与 `tests/core.test.ts`（消息校验）。

## 支持范围

只维护默认分支上的最新版本。安全修复会随下一个小版本发布，并在
[CHANGELOG](CHANGELOG.md)（若存在）或 release notes 里说明。
