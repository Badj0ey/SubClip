# 开发、测试与验收

## 环境

- Node.js **22+**（SQLite 回归测试使用 `node:sqlite`）；npm。
- Windows 是当前配置的正式打包目标；Linux/macOS 可以用于部分源码测试，但不是本仓库的发布承诺。
- 开发/冒烟测试需要 Electron 运行时。Windows 发行包使用 `electron-builder`。
- 真正输出视频时需要 FFmpeg；B 站接口、预览和模型下载需要网络。

```bash
npm ci
npm run dev
```

如果本机无法访问 npm 默认仓库，可自行配置 npm 镜像；`.npmrc.example` 是可选示例，不要将私有镜像或凭证提交到仓库。

## 命令表

| 命令 | 内容 | 需要 GUI / 网络？ |
| --- | --- | --- |
| `npm run typecheck` | 渲染端 Vue/TS 与主进程/测试 TS 检查 | 否（需依赖） |
| `npm run test:core` | SRT、时间范围、快捷键、导出等纯逻辑 | 否 |
| `npm run test:refactor` | 外链校验、布局边界、命令搜索、SQLite 批量详情与首页统计 | 否；Node 22+ |
| `npm run test:wbi` | 用户脚本 WBI 算法与桥接协议一致性 | 否 |
| `npm run test:slice` | SIDX 与区间拆分逻辑 | 否 |
| `npm run test:danmaku` | protobuf/XML 弹幕解析、字段与边界 | 否 |
| `npm run test:smoke` | Electron/SQLite 导入、迁移、检索、导出、任务等 | **是** |
| `npm run test:bridge` | 本地 WebSocket/Origin/配对协议 | **是** |
| `npm test` | 上述测试全部运行 | **是** |
| `npm run build` | Electron/Vite 生产构建 | 否（需依赖） |
| `npm run dist` | Windows NSIS 安装包和免安装 ZIP | Windows |

测试 runner 用 esbuild 将 `tests/*.ts` 临时打成 `.cjs`，这些文件属于构建产物、已被 `.gitignore` 排除，不应放进源码交付包。

## 推荐验证顺序

```bash
npm ci
npm run typecheck
npm run test:core
npm run test:refactor
npm run test:wbi
npm run test:slice
npm run test:danmaku
npm run build
npm run test:smoke
npm run test:bridge
```

### UI 手工验收

1. 浅色、深色、系统主题：文字、选中态、弹窗与提示对比度正常。
2. Ctrl+K：空关键词、中文、英文、多词、无结果、↑/↓/Enter/Esc；输入框获得焦点，关闭后焦点恢复。
3. 素材库：打开/切换视频、拖动三栏分隔线、键盘方向键调整、双击重置；快速切换搜索关键词不会显示旧结果。
4. 片段库：首次加载即显示视频标题/作者/标签；大量片段逐批补齐；删除和重新命名后显示正常。
5. 工作台：最近视频列表少于总视频数时，统计卡片仍显示真实全库数量；空库有可操作的空状态。
6. 字幕导入：UTF-8/GBK、空字幕、非法文件、重复导入、拖拽多个文件。
7. 弹幕参考：打开一条 B 站字幕，折叠状态不应发起请求；展开后加载，筛选分 P/关键词/附近 90 秒，点击弹幕定位字幕且不改变勾选；接口失败时只显示提示。该面板需要网络，未登录/无弹幕/直播回放应给出可理解的空状态。
8. FFmpeg：成功、失败、取消、重试、跨分 P 合成、输出目录和历史。
9. 安全：`javascript:`、`file:`、含凭据的外链不会由 Electron 打开；WebSocket 来源/令牌校验仍生效。
10. 备份与恢复：在临时用户目录上验证；不要拿唯一一份真实用户数据做破坏性测试。

## 调试脚本

```bash
node scripts/fake-openai.mjs 8877  # 模拟 OpenAI 兼容 HTTP 接口
node scripts/fake-plugin.mjs 8765 # 模拟用户脚本（需 ws 依赖）
node scripts/gen-large-srt.mjs 10000
node scripts/embed-probe.mjs      # 会下载模型，请留意磁盘和网络
node scripts/shot.mjs shot out.png # 需启用 Electron CDP 9222
```

这些脚本仅用于开发，**不是**生产环境的外部服务。调试时不要把真实 Cookie/API Key 发送到模拟服务器。

## 代码变更原则

- 主进程的 IPC 参数先验证，再做文件/网络/数据库操作；不要在渲染进程开启 Node 权限。
- 纯算法写在 `src/shared/` 或无 Electron 依赖的模块中，配套边界测试。弹幕解析即按此拆分：`shared/danmaku.ts` 只解析，`main/danmaku.ts` 负责网络与缓存。
- 新增 preload API 时同步 `src/main/ipc.ts`、类型定义和测试。弹幕接口的契约是 `getDanmaku(bvid, force?) → OpResult<DanmakuResult>`。
- 数据库迁移必须兼容旧数据，事务和全文索引需要回归测试。
- 用户脚本协议变更要同步 `src/shared/bridge.ts` 和 `userscript/SubClip.user.js`，再跑 `test:wbi` / `test:bridge`。
- CSS 色值优先使用 `styles/tokens.css`，界面必须有键盘焦点态与减少动画选项。

## 3.17.0 本机验证范围

2026-10-24 在具备完整依赖的本机执行并通过：

- `npm run typecheck`
- 全量 `npm test`：core 181、refactor 6、wbi 20、slice 14、danmaku 解析断言、smoke 45、bridge 38，均 0 失败
- `npm run build`
- 源码构建 GUI 冒烟：用 `npx electron .` 启动 `out/`，通过桥接注入测试字幕，展开弹幕面板后真实读到 1,404 条；点击弹幕验证字幕光标定位、播放器 seek 与选区不变。未测试安装包内的同一流程。

弹幕另做了真实接口抽样：`oid=1176840&segment_index=1` 返回 HTTP 200、1,239,109 字节，解析出 5,867 条，颜色 250 种、非白色 4,503 条、无空 id，mode 覆盖 1/5/4/7。未覆盖真实账号登录后的受限弹幕、直播回放全量、超长多 P 视频的分段上限和安装包内 GUI。

隔离环境只能验证 TypeScript 源码语法、Vue SFC 标签结构、纯逻辑测试和 `node:sqlite` 数据库测试，**不能替代** `vue-tsc`、真实构建、Electron GUI 与 Windows 安装包验收；发布前仍应运行上方全套命令。
