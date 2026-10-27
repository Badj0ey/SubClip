# 字幕剪 · SubClip Studio

[![CI](https://github.com/Badj0ey/SubClip/actions/workflows/ci.yml/badge.svg)](https://github.com/Badj0ey/SubClip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4e5cd3.svg)](LICENSE)

**从字幕找到片段，把视频素材变成作品。**

SubClip 是基于 Electron、Vue 3、TypeScript 和 SQLite 的本地桌面工作台。它将 B 站字幕拉取、字幕阅读编辑、弹幕辅助定位、全文/语义检索、片段收藏、FFmpeg 切片和发布素材整理连接成一条工作流。基础功能无需云端 AI 服务。

> 本仓库从原项目 **3.16.0** 整理而来，当前源码版本 **3.18.2**，保留现有数据库结构、迁移流程和核心功能；用户脚本与桌面端通信协议已同步升级到 v5。它是**源码工程**；安装包、免安装包与 SHA-256 校验值见 [GitHub Releases](https://github.com/Badj0ey/SubClip/releases)。

## 快速开始

**使用安装包**：下载 Windows 安装包或免安装 ZIP 即可。Node.js、npm、FFmpeg 都不需要单独安装——打包版自带 Electron 运行时，安装包里也内置了 FFmpeg；语义检索模型在应用内按需下载。

**从源码开发**：需要 **Node.js 22+** 与 npm。源码开发态不内置 FFmpeg，本机 PATH 里需要有 `ffmpeg`（或在「设置 → 本地切片」里指定），只有 `npm run dist` 打包时才会自动下载并放进安装包。

```bash
npm ci
npm run dev
```

生产构建及 Windows 打包：

```bash
npm run typecheck
npm test
npm run build
npm run dist
```

Windows 已安装依赖并完成构建后，可运行 `SubClip.bat`。中国大陆网络环境可按需将 `.npmrc.example` 复制为 `.npmrc` 使用镜像；请不要提交个人 `.npmrc`。

## 从零开始的使用流程

1. **准备字幕**：在顶部选择「拉取字幕」输入 B 站视频/合集/收藏夹链接，或通过「导入」选择 SRT、VTT、TXT 文件。也可直接将字幕文件拖入窗口。
2. **阅读与选段**：打开「素材库」中的字幕，按行选择或在时间轴上拖选；可合并、拆分、校正时间和编辑正文。B 站视频字幕可在右侧「剪辑助手」展开「弹幕参考」，点击弹幕快速定位到对应字幕。
3. **检索与整理**：到「字幕检索」跨视频搜索台词；把有价值的时间范围保存为片段，在「片段库」中命名、收藏、打标签。
4. **导出视频**：将片段加入「剪辑任务」，设置 FFmpeg 路径与输出目录后执行；可查看进度、失败重试和历史记录。
5. **继续创作**：按需使用本地语义检索、AI 摘要/标签、素材发现、知识图谱、文案模板和发布素材包。

首次打开默认进入「工作台」。顶部 **Ctrl+K** 可快速跳转页面、导入字幕、切换主题或重置布局。工作区左右分隔线可拖动，也可用方向键调整，双击恢复默认尺寸。

## 功能总览

| 模块 | 能做什么 | 依赖 |
| --- | --- | --- |
| 工作台 | 全库统计、最近视频/合集、收藏、待办与快捷入口 | 本地 SQLite |
| 素材库 | UP主 → 合集 → 视频 → 字幕资源树、收藏、标签、预览与正文编辑 | 本地 SQLite；预览需网络 |
| 弹幕参考 | 读取 B 站视频弹幕，按分 P、关键词或当前时间附近筛选，点击定位字幕 | B 站网络；不落库、不参与剪辑 |
| 字幕检索 | FTS5 全文检索、范围/标签/时间筛选、分页、批量选段 | 本地 SQLite |
| 语义检索 | 本地向量模型下载、索引、按语义搜索 | 可选模型下载 |
| 片段库 | 片段命名、标签、收藏、来源定位、发现、图谱、模板、素材包 | 本地 SQLite |
| 剪辑任务 | 排队、调整顺序、FFmpeg 输出、取消/重试、历史 | 安装包已内置 FFmpeg；B 站流需网络 |
| AI 辅助 | 摘要、标签建议、字幕解释、标题等 | 可选 Ollama 或 OpenAI 兼容接口 |
| 浏览器联动 | B 站页面用户脚本推送字幕与页面信息 | 可选 Tampermonkey 脚本 |

浏览器端安装 `userscript/SubClip.user.js` 后，在 B 站视频页面点击「同步视频及字幕（全部分P）」即可一并同步视频信息和字幕。桌面端会优先拉取可访问的字幕，失败分P交由当前浏览器补抓。**3.18.2 用户脚本必须配合 3.18.2 桌面端使用**；如设置页提示连接失败，请检查端口及配对令牌。

## 项目结构

```text
src/
  main/               Electron 主进程：IPC、SQLite、B 站、弹幕、FFmpeg、AI、桥接
    ai/               AI 服务与提示词
    slice/            DASH/SIDX 下载、裁剪、合成
  preload/            类型化 window.api，隔离主/渲染进程
  renderer/
    src/
      components/     页面和复用 UI（含命令面板与图标）
      composables/    虚拟列表、分隔线布局等
      stores/         Pinia 领域状态
      styles/         主题变量、基础布局、工作区与视觉规范
  shared/             共享类型、时间/字幕/弹幕解析、命令与安全校验
tests/                回归测试与字幕样本
scripts/              调试脚本和本地模拟服务
userscript/            B 站用户脚本（与桥接协议配套）
build/                 打包图标
```

主要模块和版本改动见本文件与 [CHANGELOG.md](CHANGELOG.md)。原工程部分 `docs/` 文档已在上游整理时移除，源码包不包含这些失效链接对应的文件。

## 数据与隐私

字幕、片段、标签和任务数据保存在应用的 Electron `userData` 目录内（`subclip-data/srt-tool.db`）。旧版 JSON/SQLite 数据由原有迁移逻辑处理，**升级前仍建议先在「设置」中备份数据库**。

B 站 Cookie、浏览器桥接配对令牌以及可选的云端 AI API Key 优先使用 Electron `safeStorage`（Windows DPAPI / macOS Keychain / Linux 密钥环）加密后写入设置文件，旧版明文配置会在下次保存时自动迁移；系统加密不可用时回退为明文。密文与当前系统用户绑定，换机或换系统账号后需要重新填写。共享电脑上仍请注意本机账号权限，不要上传包含这些数据的设置文件。浏览器桥接仅监听本机并进行来源/协议校验，建议启用配对令牌。更多内容见 [SECURITY.md](SECURITY.md)。

## 测试状态与限制

3.18.2 已在本机完成 TypeScript 检查、全量测试（7 个套件）、生产构建及 NSIS 安装包 / ZIP 构建，并对打包版做了启动冒烟与桥接端口/重启检查。**真实 B 站账号登录与受限字幕、浏览器脚本按钮的真实点击链路、NSIS 向导交互、正式代码签名和完整剪辑导出仍未覆盖**。

- [版本变更](CHANGELOG.md)
- [贡献说明](CONTRIBUTING.md)
- [安全说明](SECURITY.md)
- [第三方许可](THIRD-PARTY.md)

许可证：MIT，见 [LICENSE](LICENSE)。
