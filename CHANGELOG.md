# Changelog

## 3.18.2 — 浏览器字幕联动与文件定位修复（2026-10-27）

### 修复与改进

- 浏览器脚本把「同步该视频」和「拉取全部分P」合为「同步视频及字幕（全部分P）」：一次点击先同步视频元数据，再让桌面端获取全部分P字幕；桌面端读取失败的分P会定向交给发起操作的浏览器标签补抓，不再要求事先同步 Cookie 才能尝试拉取。
- 桌面端与浏览器端的字幕轨发现均补齐 WBI/v2 空结果回退、`aid+cid` 参数变体、分P列表回退及异常区分；不能确认字幕列表时显示接口错误，而非直接误判「无字幕」。
- 修复设置页「打开用户脚本所在文件夹」被 `.js` 文件安全校验拦截：改为不接收外部路径的专用 IPC，仅定位应用自带脚本，仍禁止任意执行 JS。
- 桥接协议升至 v5：声明能力表，新增大字幕有序分块传输与整份组装、入库结果回执、登录状态保存回执、拉取进度及浏览器补抓状态；单帧仍限制 512KB，上传总量与分块数量均有限制。
- 修复原有拉取/本地导入在等待网络或文件 IO 时长期占用 SQLite 异步事务的问题；旧版仅有文档元数据、没有字幕正文的轨道可重新拉取。
- 同端口重启桥接服务不再立即重新绑定未释放的监听套接字；重复拉取请求不再产生多份浏览器补抓，状态会通知等待的标签。
- Cookie 同步优先保留 www 域名的有效值，并在桌面端实际保存成功后才显示「已同步」；字幕下载校验受信任的 HTTPS 域名，避免将登录 Cookie 发送到 CDN/陌生域名。

### 兼容性与说明

- 应用和用户脚本版本均为 3.18.2，通信协议 v5；**请同时更新桌面端与篡改猴脚本**。旧版协议客户端仍可按兼容路径连接，但新合并按钮及分块功能需要新版桌面端。
- 不新增 npm 依赖、不修改 SQLite 表结构。

### 验证（2026-10-28 本机）

- `npm run typecheck` 通过；`npm test` 7 套件全部通过：core 181、refactor 6、wbi 20、slice 14、danmaku、smoke 45、bridge 38（0 失败）。bridge 套件的「无登录态」用例改为离线 stub，明确断言「不因缺 Cookie 拒绝、失败分P 回到发起标签补抓」，不再依赖真实 B 站网络。
- `npm run build` 与 `npm run dist` 通过：`dist/SubClip-3.18.2-setup.exe` 161,046,726 B、`dist/SubClip-3.18.2-x64.zip` 217,940,495 B；`dist/SHA256SUMS.txt` 已生成。
- 从 NSIS 安装包解包核对：`resources/userscript/SubClip.user.js` 与仓库脚本 md5 一致（`d567c016…`，80,668 B），`resources/ffmpeg/` 含内置 `ffmpeg.exe`、`app.asar` 内 `package.json` 版本为 3.18.2。
- 打包版冒烟（临时 `userData`，CDP 检查）：窗口正常创建，渲染页从 `app.asar` 加载、标题「字幕剪 SubClip」，preload 暴露 140 个 API；桥接在空闲端口启动成功（`protocol:5`），同端口重启后仍为 `running:true`（对应第 7 条修复）。
- **未覆盖**：真实 B 站账号登录与受限字幕、浏览器脚本按钮的真实点击链路、文件管理器打开脚本目录的人工确认、NSIS 向导交互流程、代码签名/SmartScreen。

## 3.18.1 — 直播回放弹幕说明与内置 FFmpeg（2026-10-24）

### 修正

- 直播回放的视频弹幕池本来就是空的（直播期间的聊天弹幕不会迁移进来，B站也没有公开的回放弹幕存档接口），面板却显示「没有可用弹幕，可能是该视频未开放弹幕或接口暂不可用」，被当成获取失败。现在视频信息里的弹幕总数为 0 时直接返回空结果并带上原因：直播回放显示「这是直播回放，直播期间的弹幕不会保存到视频弹幕池里，B站也没有可读取的回放弹幕。」，普通视频显示「该视频在 B 站没有弹幕。」
- 弹幕总数为 0 时不再发分段请求。以 14,098 秒的直播回放为例，原来要发约 40 个 `seg.so` 请求才能确认没有弹幕，现在只发 1 个视频信息请求。
- `BiliVideoInfo` 增加可选的 `danmakuCount`（`stat.danmaku`）与 `desc`，`DanmakuResult` 增加可选的 `emptyReason`；不涉及 SQLite 表结构、桥接协议（仍 v4）和既有 IPC。

### 新增

- 安装包内置 FFmpeg 6.1.1（gyan.dev essentials 静态构建，GPLv3）。`npm run dist` 会先运行 `npm run vendor:ffmpeg`，从镜像下载并校验 SHA-256 后放进 `vendor/ffmpeg`，再由 electron-builder 复制到 `resources/ffmpeg/`；主进程按「设置指定 → 用户自备副本（userData/bin）→ 安装包内置 → PATH」查找。装完即可切片，不再要求用户单独安装 FFmpeg。
- 源码开发态仍然不内置：`npm run dev` 需要本机 PATH 里有 `ffmpeg`，或在「设置 → 本地切片」里指定；`npm run dist`（含 CI）才会下载并打包。
- `vendor/` 加入 `.gitignore`，80 MB 的二进制不进 Git；下载脚本 `scripts/fetch-ffmpeg.mjs` 支持 `FFMPEG_DOWNLOAD_BASE` 换镜像、`FFMPEG_SKIP=1` 跳过。

### 兼容性

- `package.json`、`package-lock.json` 与用户脚本 `@version` 同步为 3.18.1；`tests/wbi.test.ts` 的版本一致性检查仍通过。
- 不新增 npm 依赖；弹幕仍然不落库、不参与检索、切片或导出。
- 安装包体积增加约 21 MB（NSIS setup 从 139,314,109 B 到 161,041,436 B；ZIP 从 189,337,411 B 到 217,934,446 B）；Windows Defender 可能延长首次扫描时间。
- FFmpeg 以独立可执行文件分发（命令行调用，不与自有代码链接），安装目录附 `ffmpeg.LICENSE`（GPLv3）与 `ffmpeg.README`；`THIRD-PARTY.md`、`docs/FEATURES.md`、`docs/RELEASE.md` 已同步。

### 验证

- 2026-10-24：`npm run typecheck`、`npm test`（7 套件：core 181、refactor 6、wbi 20、slice 14、danmaku、smoke 45、bridge 38，均 0 失败）、`npm run build` 通过；`tests/danmaku.test.ts` 新增直播回放分类断言。
- `npm run dist` 构建通过：`dist/SubClip-3.18.1-setup.exe` 161,041,436 B、`dist/SubClip-3.18.1-x64.zip` 217,934,446 B；`win-unpacked/resources/ffmpeg/` 含 `ffmpeg.exe`（82,797,568 B，SHA-256 与下载脚本锁定值一致）、`ffmpeg.LICENSE`、`ffmpeg.README`。
- 打包版 GUI 实测（临时 `userData`）：`window.api.sliceCheck()` 返回 `{available:true, ffmpeg:"<安装目录>/resources/ffmpeg/ffmpeg.exe"}`；桥接注入 BV1o9J96eESU 字幕后展开「弹幕参考」，仍显示直播回放说明与「显示 0 条」。
- 真实接口（复用本机配置与 Cookie）：BV1o9J96eESU（直播回放，14,098 秒）返回 `items=0`、`emptyReason=live-replay`，只发 1 个请求；BV1GJ411x7h7（普通视频）仍读到 1,402 条弹幕。
- 渲染进程实测：临时 `userData` 启动构建产物，桥接注入 BV1o9J96eESU 字幕，展开「弹幕参考」后显示上述直播回放说明；`window.api.getDanmaku('BV1o9J96eESU', true)` 返回 `{ok:true, data:{items:[], emptyReason:'live-replay'}}`。
- 未覆盖：真实安装向导流程（安装/卸载/SmartScreen）、真实切片导出；安装包本体只做了 `win-unpacked` 直接启动验证。

## 3.18.0 — 界面文案整理与安装体验（2026-10-24）

### 改进

- 首页、导入、B 站拉取、推荐、检索与 AI 面板统一空态、错误提示和操作反馈；未打开字幕、未连接 AI 时直接说明原因，忙碌时禁用会冲突的按钮。
- B 站链接重新解析时清空旧列表；获取失败给出可见提示；筛选/全选/反选在拉取中禁用；全选只加入当前筛选结果，并显示已选/总数。
- 设置页将「AI 能力层」统一为「AI 助手」，明确本地/云端服务、模型下载证书校验和备份恢复的风险与边界；AI 连接状态改为「尚未开启 / 已连接 · 模型（耗时）」。
- 导入、拉取弹窗补充 dialog 语义；全局补齐键盘焦点、禁用态、窄窗口和减少动画适配，并合并重复样式。
- NSIS 安装向导加入 MIT 许可证页、产品图标与侧边图；控制面板卸载项显示「字幕剪 SubClip 3.18.0」；卸载默认保留用户数据。
- 新增 `npm run dist:checksums`，生成 `dist/SHA256SUMS.txt`；CI 在推送 `v*` 标签时构建安装包/ZIP、生成校验文件并创建草稿 Release。
- 补充 `docs/GITHUB.md`，记录首次推送与标签发布步骤（3.18.1 起改写为全程网页、不依赖命令行与 Actions 的纯手动流程）；README 增加 CI/许可证徽章、Release 入口和文档索引。

### 兼容性

- 不更改 SQLite 表结构、数据迁移、用户脚本桥接协议（v4）和既有 IPC；不新增 npm 依赖。
- `package.json`、`package-lock.json` 与用户脚本 `@version` 同步为 3.18.0；`tests/wbi.test.ts` 仍会校验两者一致。
- 安装包未做代码签名；Windows SmartScreen 可能提示未知发布者，分发时需提供 SHA-256 校验值。

### 验证

- 2026-10-24 本机通过 `npm run typecheck`、全量 `npm test`（7 个套件：core 181、refactor 6、wbi 20、slice 14、danmaku 解析断言、smoke 45、bridge 38，均 0 失败）、`npm run build`、`npm run dist`。
- 产物：`SubClip-3.18.0-setup.exe`（约 133 MB）、`SubClip-3.18.0-x64.zip`（约 181 MB），`dist/SHA256SUMS.txt` 已生成。
- 静默安装到临时目录后核对：`SubClip.exe` 文件版本 3.18.0，安装包内用户脚本 `@version` 3.18.0，卸载项显示「字幕剪 SubClip 3.18.0」、发布者 Badj0ey，开始菜单快捷方式存在；卸载后卸载项和快捷方式清除，用户数据目录文件数与字节数保持不变。
- 打包版以临时 `userData` 启动，工作台正常渲染；安装向导许可证页显示 MIT 文本，安装包内嵌的向导侧边图与 `build/installerSidebar.bmp` 一致。
- 未覆盖：代码签名、真实 B 站账号登录、FFmpeg 安装与完整剪辑导出；这些沿用 3.17.0 的已知限制，正式发布前仍建议人工验收。

## 3.17.0 — 弹幕参考（2026-10-24）

### 新增

- 剪辑助手新增「弹幕参考」折叠面板，仅对关联了 B 站 BV 号的字幕显示。展开后读取当前视频各分 P 弹幕，支持关键词、分 P、当前分 P 前后 90 秒筛选（附近结果按时间距离排序）；点击弹幕定位到同分 P 最近的字幕，并在同分 P 预览已打开时同步播放时间。
- 弹幕只用于定位：默认折叠、展开才加载，不写入 SQLite，不改变字幕勾选集合，也不参与切片、导出或发布素材包。
- 主进程新增 `bili:danmaku`，preload 暴露类型化的 `getDanmaku(bvid, force?)`。读取分 P 信息后按 6 分钟分段请求 B 站 `seg.so`，单个分 P 全部分段失败时回退旧 XML 接口；结果在内存缓存 10 分钟，最多缓存 8 个视频。
- 解析逻辑放在 `src/shared/danmaku.ts`，主进程只负责抓取、回退、并发与预算。新增 `tests/danmaku.test.ts` 并接入 `npm test`。

### 修正与收紧

- 按真实 protobuf 协议解析：`progress=2`、`mode=3`、`color=5`、`content=7`、`idStr=12`。整合包原实现把颜色读成 field 4、id 读成 field 8，会得到错误的颜色和 id。
- 弹幕类型统一从 `src/shared/types.ts` 导入，删除整合包在主进程里重复定义的一份。
- 分段抓取改为最多 4 路并发，单请求 15 秒超时，一次读取总预算约 60 秒；响应上限 8MB，单条正文最多 500 字，一次最多 80 个分段 / 15,000 条。
- 面板只在用户展开后加载，避免打开任意字幕就在后台发起几十个请求；「重新获取」通过 `force` 跳过 10 分钟缓存。
- 面板挂载条件改为「有字幕且字幕关联 BV 号」，`aria-label` 从「直播回放弹幕」改为「弹幕参考」。
- 面板放在右侧「剪辑助手」，展开时只占右栏，不挤压中间的字幕阅读列表；「附近 ±90 秒」结果按时间距离由近到远排序，避免 350 条渲染上限先塞满 0 秒附近的内容。

### 兼容性

- 不更改 SQLite 表结构、数据迁移、用户脚本桥接协议（仍为 v4）和既有 IPC；不新增 npm 依赖。
- `package.json`、`package-lock.json` 与用户脚本 `@version` 同步为 3.17.0；`tests/wbi.test.ts` 会校验应用与用户脚本版本一致。
- 弹幕读取需要网络；接口、账号权限、地区和视频设置都可能影响结果。直播回放不保证完整，失败时只显示提示，不影响字幕功能。

### 验证

- 2026-10-24 本机通过 `npm run typecheck`、全量 `npm test`（7 个套件：core 181、refactor 6、wbi 20、slice 14、danmaku 解析断言、smoke 45、bridge 38，均 0 失败）和 `npm run build`。
- 真实接口抽样：`oid=1176840&segment_index=1` 返回 HTTP 200、1,239,109 字节；解析出 5,867 条，颜色 250 种、非白色 4,503 条、无空 id，mode 覆盖 1/5/4/7，验证了颜色与 id 字段修正。
- Electron GUI 冒烟（生产构建的 `out/`，临时 `userData`）：桥接注入测试字幕后展开面板，真实读到 1,404 条；默认附近 ±90 秒匹配 820 条，首屏为 37–38 秒弹幕。点击 37 秒弹幕把光标定位到 38–41 秒字幕并跳到 37.978 秒，选区仍为 0 条；字幕列表高度未因面板变化。
- 未覆盖：真实账号登录后的受限弹幕、直播回放全量、超长多 P 视频的分段上限场景、安装包内 GUI 实测。详细说明见 [弹幕参考](docs/DANMAKU_GUIDE.md)。

## 3.16.1 — 可靠性与隐私优化（2026-10-24）

### 改进

- 设置保存改为同目录临时文件 + 原子替换；写入失败时清理临时文件并保留旧配置。
- 系统支持时使用 Electron `safeStorage` 加密 B 站 Cookie、浏览器桥接令牌与云端 AI Key；旧版明文在下次保存时自动迁移，密钥环不可用时回退明文。
- 字幕导入阻止重复提交；导入或选择文件期间禁用移除、取消与选择按钮；异常显示可见错误；部分文件失败时保留对话框。
- 精简顶部导航、命令面板与导入弹窗的中文文案；补充键盘焦点轮廓和系统减少动画偏好。
- 新增「品质优化整合记录」，保留整合包原始说明与本机验收结果。

### 兼容性

- 不更改 SQLite 表结构、用户脚本协议版本或桥接协议；命令 id、关键词和既有 IPC 保持不变。
- 密文以 `safeStorage:v1:` 前缀写入 `settings.json`，与当前系统用户绑定；换机或回滚到 3.16.0 前需要重新填写 Cookie / 令牌 / AI Key，回滚前先备份设置文件。
- 2026-10-24 验证：`npm run typecheck`、全量 `npm test`（SQLite 冒烟 45 项、桥接 38 项）、`npm run build`、真实 Electron GUI 冒烟与 safeStorage 端到端通过；未覆盖真实 B 站登录、FFmpeg 安装、完整剪辑导出和安装包签名。

## 3.16.0 — 结构与界面整理（源码重构版，尚未发布安装包）

### 改进

- 统一顶部导航、工作台首页、片段选择侧栏的视觉层级；加入 Ctrl+K 快捷操作面板与统一线性图标。
- 样式拆分为主题变量、基础布局、共享工作区样式与视觉细节；补充深色模式、焦点态和减少动画支持。
- 面板尺寸管理提取为 composable，支持指针与键盘调整、视口约束、重置和事件清理。
- 首页统计改用真实全库视频/字幕数量；最近视频排序使用最新字幕入库时间，收藏合集也能出现在首页。
- 片段详情改为批量 IPC + 数据库联合查询；片段加载后再补充视频标题、作者与标签。
- 素材树正文检索加入防抖与异步请求版本校验，避免过期结果覆盖当前关键词。
- 外部链接只允许合法 HTTP(S)，拦截非应用窗口导航；`showItem` 限制在允许目录或用户批准的路径。
- XLSX 依赖按需加载，避免纯 CSV 相关逻辑提前初始化 SheetJS。
- 精简右侧面板的无效代码和旧样式；整理开发脚本、清除生成测试文件、压平源码根目录。
- 统一 `package.json` / lockfile 元数据、Node.js 22+ 要求和 CI 配置；重写文档。

### 兼容性

- 不更改 SQLite 表结构、用户脚本协议版本和用户数据目录迁移逻辑。
- 保留原有 `clips:detail` 单条 IPC；新增 `clips:details` 批量接口。
- 2026-10-24 已完成开发环境集成验收：`npm run typecheck`、全量 `npm test`（6 个套件）、`npm run build`、`npm run dist:dir` 均通过；打包版 `dist/win-unpacked/SubClip.exe` 实测可启动并正常渲染工作台与命令面板（控制台无报错）。

## 历史能力里程碑（原项目）

- **1.x**：字幕导入、B 站拉取、资源树、选段和切片表。
- **2.x**：本地 SQLite、全文检索、浏览器用户脚本联动、视频预览与语义检索。
- **3.x**：AI 辅助、片段/任务分离、知识图谱、素材推荐、文案模板与发布素材包。

历史细粒度开发日志已从精简源码包中移除。需要逐版本追溯时应以原仓库 Git 历史和发布记录为准。
