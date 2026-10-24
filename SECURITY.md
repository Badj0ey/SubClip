# 安全与隐私

SubClip 是本地优先的 Electron 应用，但仍会处理**登录凭证、用户字幕、外部视频链接和可选 AI 接口密钥**。以下是当前代码的安全边界和仍存在的风险，不应理解为绝对安全保证。

## 漏洞报告

请优先使用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)。不要把 Cookie、API Key、数据库或可复现利用代码直接贴到公开 issue。报告时附上影响版本、复现步骤、影响范围与日志脱敏情况。

## 本地保存了什么

| 数据 | 位置 | 风险与建议 |
| --- | --- | --- |
| 字幕、视频、片段、标签、任务 | `<Electron userData>/subclip-data/srt-tool.db` | 本地 SQLite；建议定期备份、保护系统用户账号 |
| B 站 Cookie | `<Electron userData>/settings.json` | 系统支持时由 `safeStorage` 加密（`safeStorage:v1:` 前缀）；加密不可用时回退明文，不要共享设置文件 |
| 桥接配对令牌 | 同上 | 同上；共享电脑建议启用 |
| 可选云端 AI API Key | 同上 | 同上；不要将设置文件或未脱敏日志上传 |
| 本地语义模型 | 应用数据目录内的模型缓存 | 可能占用较多磁盘空间；首次下载需要网络 |

**加密范围与限制：** 设置文件先写入同目录临时文件再原子替换，降低保存中断写坏配置的概率。`safeStorage` 可用时（Windows DPAPI、macOS Keychain、带密钥环的 Linux）上述秘密以 `safeStorage:v1:` 前缀密文保存；旧版明文设置在升级后第一次保存时自动迁移。部分 Linux 环境缺少可用密钥环时会回退明文，此时仍应按“可被本机程序读取”对待。密文与当前系统用户绑定，换机、换系统账号或恢复他人备份后无法解密，需要重新填写；回退到旧版本程序也会把密文当成普通字符串，请先备份并准备重新登录。`diagnostics.ts` 只对诊断包做脱敏，不改变设置文件的加密状态。

## Electron 渲染进程边界

- `nodeIntegration: false`、`contextIsolation: true`；渲染进程只通过 preload 中明确声明的 `window.api` 调用主进程。
- CSP 禁止内联脚本和 `unsafe-eval`；样式保留必要的内联能力，预览媒体可访问 HTTPS CDN。
- 外部链接通过 `safeExternalUrl` 限定为有效的 HTTP(S) URL，拒绝 `file:`、`javascript:`、含账号密码或控制字符的 URL。
- 主窗口拦截非应用导航，外部 HTTP(S) 地址交给系统浏览器，不允许远程网页替换特权渲染文档。
- 通过系统对话框选择的文件/目录会登记为本会话批准路径。`shell.openPath` 只允许特定目录并拒绝可执行扩展名；`showItemInFolder` 仅允许批准路径或配置目录。
- 拖入的字幕文件由主进程检查扩展名、存在性和文件类型后再登记；不是任意文件读取入口。

## 浏览器用户脚本桥接

本机 WebSocket 服务默认监听 `127.0.0.1:8765`。**仅绑定 loopback 不足以防止恶意网页连接**：WebSocket 不受普通 CORS 同源限制。因此主进程额外执行：

1. 握手 `Origin` 白名单（B 站页面来源），拒绝其他网页。
2. 逐消息协议版本/字段/大小校验，限制消息频率与最大负载。
3. 可选配对令牌；建议在共享电脑、多人账号环境中开启。

`Origin` 可被本机程序伪造，因此它不能代替系统账户隔离或配对令牌。用户脚本、主进程与 `src/shared/bridge.ts` 的协议必须同步维护。

## 网络与第三方服务

B 站字幕拉取、DASH 视频预览、切片下载会访问 B 站接口/CDN；本地语义模型下载会访问配置的模型镜像。启用云端 OpenAI 兼容 AI 后端时，发送给该后端的字幕/提示词受该服务的隐私条款约束。若需要本地处理，请选择本地 Ollama 并自行管理模型和服务权限。

## 用户建议

- 升级、清空或恢复数据前先备份数据库；不要用唯一一份真实数据库进行测试。
- 不要把 `settings.json`、用户脚本配对令牌、诊断前的原始日志或用户数据目录提交到 Git。
- 从可信渠道获取 FFmpeg、Electron 安装包与浏览器用户脚本；不要随意安装来源不明的脚本。
- 对敏感素材优先使用本地处理，并确认第三方模型/接口是否符合你的隐私要求。
