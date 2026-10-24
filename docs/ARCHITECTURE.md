# 架构与代码导航

## 总览

```text
                  Vue 3 Renderer (untrusted)
               App.vue / views / Pinia stores
                          |
                 window.api (typed)
                          |
                preload/index.ts (IPC)
                          |
               main/ipc.ts (validation)
                     /     |      \
               services  db.ts   slice/ / ai/
                  |       |          |
               Bilibili SQLite    FFmpeg / HTTP
                          |
             Local data: subclip-data/

Browser userscript ── WebSocket (origin + protocol + optional token) ── bridge.ts
```

渲染进程不直接获得 Node.js 文件系统、`shell` 或数据库句柄。用户输入经 preload 暴露的白名单 API 传入主进程；敏感文件操作、B 站网络请求、数据库和 FFmpeg 在主进程处理。

## 目录职责

| 目录/文件 | 责任 | 修改注意事项 |
| --- | --- | --- |
| `src/main/index.ts` | Electron 生命周期、窗口、安全策略、数据目录迁移、IPC 初始化 | 不要开启 `nodeIntegration`，不要绕过 URL 校验 |
| `src/main/ipc.ts` | IPC 通道与输入校验 | 新增接口须同步 preload 类型与测试 |
| `src/main/db.ts` | SQLite 表、迁移、查询、事务 | 旧用户数据库兼容性优先；迁移必须幂等 |
| `src/main/services.ts` / `bilibili.ts` | 字幕拉取/导入编排、B 站 API | 网络失败应有明确错误，不破坏已入库数据 |
| `src/main/slice/` | DASH/SIDX 下载、范围拆分、FFmpeg 裁剪和合成 | 保持分 P/时间单位一致，支持取消 |
| `src/main/ai/` / `semantic.ts` | AI 供应商适配、本地语义模型和索引 | 基础功能不能依赖 AI 可用性 |
| `src/main/bridge.ts` | 本机 WebSocket 与用户脚本通信 | 与 `src/shared/bridge.ts`、`userscript/` 协议同步 |
| `src/preload/index.ts` | 唯一渲染端 IPC 入口 | 保留明确类型，不暴露任意 invoke |
| `src/renderer/src/stores/` | Pinia 领域状态（字幕、资源、片段、任务、设置等） | 跨页共享状态归 store，不复制到组件 |
| `src/renderer/src/components/` | 页面、列表、弹窗、图标、快捷操作面板 | 业务 IO 走 store/API，避免组件直接依赖主进程实现 |
| `src/renderer/src/composables/` | 虚拟列表、分隔线等可复用交互 | 指针事件必须清理，兼顾键盘/触屏 |
| `src/renderer/src/styles/` | 主题变量、全局布局、共享控件、外观细节 | 色值优先使用 `tokens.css` 中变量 |
| `src/shared/` | 类型、时间/字幕/范围纯函数、命令、布局与外链校验 | 纯逻辑写回归测试，避免 Electron 依赖 |

## 核心数据关系

```text
uploaders ── collections ── videos ── docs ── cues
                           |           |
                           |           └── clips (可复用片段)
                           ├── creators (署名，多对多)
                           └── tags (视频标签)
clips ── clip_tags
clips ── export_jobs (任务可引用片段，但独立持久化)
```

字幕全文索引由 FTS5 维护；语义段落/向量、AI 分析缓存、切片历史、文案模板和素材包有各自的数据表。`initDb()` 会在打开旧数据库时执行迁移，旧 JSON 数据迁移后会保留备份文件。

**重要语义：** 片段是资产，导出任务是执行请求。清空任务不应清空片段；修改字幕后依赖旧正文的语义段落索引需要失效并重建。

## 一次典型操作的数据流

1. UI 触发「拉取字幕」→ `window.api` → IPC → `services.ts` / `bilibili.ts` 获取字幕轨。
2. `db.ts` 根据视频、分 P、语言去重写入 `docs/cues` 并维护全文索引。
3. 资源 store 更新树，字幕 store 加载文档，阅读区用虚拟列表渲染字幕。
4. 用户选择时间范围→共享 `ranges` 逻辑合并时间段→片段 store 保存到 `clips`。
5. 用户排入队列→`export_jobs`→`slice/engine.ts` 下载媒体流并调用 FFmpeg→更新任务/历史。

## 本次重构的边界与改进

- `DashboardOverview` 新增 `totalVideos` / `totalDocs`：总量由数据库统计提供，最近列表只负责展示。
- `clips:details` 提供**批量片段详情**：每批最多 200 个 ID，合并查询视频、作者和标签，替代逐条 IPC + 全表扫描；旧单条接口保留兼容。
- 片段详情在 store 加载后异步获取，按批次渐进渲染；新旧请求使用版本号防止覆盖。
- 资源树字幕检索使用防抖和请求序号，旧响应不再污染当前搜索结果。
- `usePaneLayout` 管理三栏尺寸、指针与键盘拖动、持久化和清理；纯函数可单测。
- `safeExternalUrl` 校验外部链接协议/凭据；窗口跳转被拦截，不允许渲染进程导航到任意网页。
- CSS 拆为 `tokens`、`foundation`、`workspace`、`polish`，统一明暗主题与组件层级。

为了降低对旧数据和 IPC 的风险，本次**没有机械拆分**已有大型 `db.ts` / `ipc.ts`；后续如按领域拆文件，应先覆盖数据库迁移和桥接协议测试，再逐步迁移。
