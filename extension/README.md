# SRT 字幕助手 · B站桥接（浏览器插件）

把 B 站页面的视频信息与字幕，桥接给本地桌面端「SRT 字幕检索与视频切片辅助工具」。

适用于 Chrome / Edge 等 Chromium 内核浏览器（Manifest V3，要求 116+）。

---

## 一、安装

1. 先启动桌面端（`npm run dev` 或已打包的 exe），确认右下角/顶栏显示 **🔌 插件未连接**。
   在桌面端「设置 → 浏览器插件通信」里可以点 **打开** 直接定位到本目录。
2. 浏览器地址栏输入：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
3. 打开右上角 **开发人员模式**。
4. 点 **加载解压缩的扩展**，选择本目录（`app/extension`）。
5. 加载完成后，点击扩展图标即可打开面板。建议「固定」到工具栏便于使用。

---

## 二、使用

> **同步是手动的**：插件会实时识别当前页面、实时读取登录状态，但**不会自动**把这些
> 发给桌面端 —— 只有你在弹窗里点按钮时才会同步。这样可以避免浏览网页时不停往桌面端塞数据。

1. **同步登录状态**（首次使用点一次即可）：点扩展图标 → 在「桌面端登录状态」一栏点
   **同步登录状态到桌面端**。插件会把浏览器里的 B 站登录凭证交给桌面端，
   之后桌面端就能自己调用 B 站接口拉取字幕，**你不需要手动去开发者工具里找 Cookie**。
   面板上的「浏览器登录状态」是**实时**读取的，但同样不会自动外发。
2. 打开任意 B 站页面（视频页 / 合集页 / 收藏夹 / UP主投稿页）。
3. 点扩展图标，面板会显示：
   - **连接状态**：是否已连上桌面端（绿色圆点）
   - **浏览器登录状态**：实时检测结果（只显示，不同步）
   - **桌面端登录状态**：上次同步的结果
   - **当前页面**：页面类型、BV 号、标题、UP主（自动识别，但不自动同步）
   - **字幕轨**：该分P 检测到的字幕语言
4. 需要时点按钮同步：
   - **同步该视频到桌面端**：把当前视频信息（含 cid、合集、UP主）推给桌面端，资源树里出现该视频。
   - **同时拉取字幕**：先同步视频，再抓取该分P 的字幕并入库。
     （一次只处理当前分P；要批量，用桌面端的「拉取字幕」按视频粒度抓全部分P。）
5. 切分P / 切视频后，面板会自动重新识别（B 站是单页应用，不刷新页面也能感知），
   但依旧需要你点按钮才会同步。

> **关于登录凭证**：插件用 `chrome.cookies` 读取当前浏览器登录态的 Cookie，通过本机回环
> WebSocket（`127.0.0.1`）交给桌面端保存，用于桌面端自行调用 B 站接口。
> 凭证只走本机、不外发；桌面端设置页不会明文回显，日志里也不会记录内容。

> 桌面端也可反向发起：在桌面端的「BV 号拉取字幕」里操作，或由桌面端下发 `request-subtitles`，插件会自动抓取并回传。

---

## 三、工作原理

```
B站页面
  └─ content.js        ① 识别页面类型，提取 BV号 / 标题 / UP主 / 分P
                       ② 在本页面上下文调用 B 站接口拿字幕轨列表
        ↓ chrome.runtime.sendMessage / chrome.tabs.sendMessage
  └─ background.js     service worker
        ├─ 调度：找一个 bilibili.com 标签页，把接口调用交给它执行
        ├─ 下载字幕 JSON（hdslb.com CDN，不需要登录态）
        └─ WebSocket 客户端 → ws://127.0.0.1:8765（桌面端）
```

### 为什么接口调用必须放在页面里，而不是 service worker

这是本项目踩过的最大一个坑：

B 站的登录凭证 `SESSDATA` 通常是 `SameSite=Lax`。而 service worker 发起的请求，对 `bilibili.com` 而言属于**跨站请求**（发起方是 `chrome-extension://`），浏览器会拒绝携带该 Cookie —— 于是接口以「未登录」身份返回，**字幕列表永远是空的**。

而内容脚本运行在页面里，`www.bilibili.com → api.bilibili.com` 属于**同站**（SameSite 看的是可注册域），Cookie 与 Referer 都天然正确。

所以现在的分工是：

| 环节 | 执行位置 | 原因 |
| --- | --- | --- |
| `x/player/wbi/v2`（取字幕轨） | **页面上下文** | 需要登录态 Cookie |
| `x/web-interface/view`（取 cid/分P） | **页面上下文** | 同上 |
| 字幕 JSON 下载 | 扩展 service worker | 公开 CDN，不需 Cookie；扩展请求不受 CORS 限制 |

> 参考项目 `bili_subtitle_extension_native` 采用的是不同但等价的思路：用 `chrome.cookies.getAll()` 把 Cookie 显式读出来，交给本地 Python 进程去请求。本质上都是**绕开扩展自身的跨站 Cookie 限制**。

### 其他要点

- **WBI 签名**：新接口需要 `w_rid` 签名。Web Crypto 不提供 MD5，插件的 `content.js` 内置了一份纯 JS MD5（已用 Node `crypto` 逐位比对验证），并按 B 站的 `mixinKeyEncTab` 做密钥重排。
- **请求头注入**：`declarativeNetRequest` 动态规则给 `hdslb.com` 的请求补上 `Referer` / `Origin`（浏览器禁止脚本直接设置这两个头）。
- **没有 B 站标签页时**：会自动开一个后台标签页完成接口调用，用完即关。
- **保活**：MV3 的 service worker 会被浏览器回收，插件用 `chrome.alarms` 每分钟唤醒一次并重连；连接断开时按 1s → 1.6 倍退避重连（上限 30s）。

---

## 四、协议

与桌面端共享，定义见 `shared/protocol.js`（桌面端对应 `src/shared/bridge.ts`）：

- **当前协议版本：3**（`hello-ack` 回包里带 `protocol` 字段，可据此确认两端一致）
- v2 的改动：UP主 字段由 `uploader.mid` 改为 `uploader.uid`（B站接口里仍叫 `owner.mid`）。
  桌面端读取时会兼容旧字段名，所以插件没更新也不会立刻坏掉。
- v3 的改动：桌面端会**校验握手来源**，只放行本扩展；`hello` 里新增可选 `token`（配对令牌）。
  扩展 ID 由 `manifest.json` 的 `key` 字段钉死为 `lmchilpnlhdfbpjklnfpfgkbddcdekpl`，
  桌面端的白名单与它一一对应（`npm run test:wbi` 会校验两者一致）。

> **为什么必须校验来源**：WebSocket 握手不受 CORS 约束，任何网页都能连 `ws://127.0.0.1:端口`。
> 只绑回环地址挡不住本机网页，所以来源校验是这里的关键一道闸门。

如果要启用配对令牌：在桌面端「设置 → 浏览器插件通信 → 配对令牌」点「生成」，
把生成的值粘贴到插件弹窗的「配对令牌」里保存即可（留空表示不校验）。

| 方向 | 消息 |
| --- | --- |
| 插件 → 桌面端 | `hello`、`page-info`、`subtitle`、`cookies`、`log`、`ping` |
| 桌面端 → 插件 | `hello-ack`、`request-subtitles`、`ack`、`pong` |

`page-info` 载荷：

```json
{
  "pageType": "video",
  "bvid": "BV1GJ411x7h7",
  "title": "视频标题",
  "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
  "page": 1,
  "cid": 123456,
  "uploader": { "uid": 703007996, "name": "UP主", "avatar": null },
  "seasonId": 8888,
  "seasonTitle": "合集名",
  "tracks": [{ "lang": "zh-CN", "label": "简体中文（AI）" }]
}
```

`subtitle` 载荷：

```json
{
  "bvid": "BV1GJ411x7h7",
  "page": 1,
  "lang": "zh-CN",
  "label": "简体中文（AI）",
  "cues": [{ "from": 1.5, "to": 3.2, "content": "字幕正文" }]
}
```

---

## 五、故障排查

| 现象 | 处理 |
| --- | --- |
| 面板显示「未连接桌面端」 | 确认桌面端已启动；在面板里点 ⟳ 重连；确认端口与桌面端设置一致（默认 8765） |
| 桌面端提示端口被占用 | 在桌面端设置里换一个端口，插件面板里同步改 |
| 抓取字幕提示「没有可用字幕」 | 该分P 确实无 CC 字幕，或未登录 B 站，或为付费/受限内容 |
| 抓取字幕提示 403 / 412 | B 站风控。稍等片刻再试，避免短时间大量请求 |
| 面板信息不更新 | B 站页面结构改版可能导致选择器失效，需要更新 `content.js` 里的选择器 |

---

## 六、目录

```
extension/
├── manifest.json        # MV3 清单
├── background.js        # service worker：WebSocket 客户端 + 字幕抓取
├── content.js           # 页面检测与信息提取
├── popup.html/.css/.js  # 弹出面板
└── shared/
    ├── protocol.js      # 通信协议（与桌面端 bridge.ts 对应）
    └── bilibili.js      # B站接口封装
```
