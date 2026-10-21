# 第三方组件与代码归属

本项目的**自有代码**以根目录 [`LICENSE`](LICENSE)（MIT）授权。
下面列出随程序分发或在本项目中移植/参考的第三方内容及其授权要求。

---

## 一、随程序分发的依赖

这些依赖会被打包进安装包，因此必须在本文档中保留其授权声明。

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 36.x | MIT | 桌面应用运行时 |
| [Vue](https://github.com/vuejs/core) | 3.x | MIT | 渲染进程 UI 框架 |
| [ws](https://github.com/websockets/ws) | 8.x | MIT | 本地 WebSocket 服务端（插件通信） |
| [SheetJS Community Edition (xlsx)](https://git.sheetjs.com/sheetjs/sheetjs) | 0.18.5 | Apache-2.0 | 导出 XLSX 切片表 |

> Electron 打包产物中会另外附带 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`
> （由 electron-builder 自动放入），涵盖 Electron 与 Chromium 本体。

### 关于 xlsx 的提醒

`xlsx@0.18.5` 是发布到 npm 的最后一版 SheetJS 社区版，其 Apache-2.0 许可证正文之外，
README 还附有「未明确授予的权利由原作者保留」的说明，且该版本存在已公开的安全问题。
**后续计划**：替换为自研的最小 XLSX 写出器或改用其他维护中的库，彻底去掉这个依赖。
在替换之前，普通用户建议优先使用 CSV（本工具导出的 CSV 带 UTF-8 BOM，Excel 直接打开不乱码）。

## 二、仅在开发/构建期使用（不随程序分发）

`typescript`、`vite`、`electron-vite`、`electron-builder`、`esbuild`、`vue-tsc`、
`@vitejs/plugin-vue`、`@types/*`。均为 MIT 或 Apache-2.0，且不出现在发布产物中。

---

## 三、移植 / 参考的第三方代码

### 3.1 bili_subtitle_extension_native（MIT）

`src/main/bilibili.ts` 中的 B 站接口逻辑（WBI 签名、`player/wbi/v2` 字幕轨获取等）
参考并移植自该项目。按 MIT 要求，其版权声明与许可证全文如下：

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

### 3.2 bilibili-slice-downloader（本项目作者委托产出，按 MIT 授权）

`src/main/slice/`（`playurl.ts`、`sidx.ts`、`downloader.ts`、`ffmpeg.ts`、`engine.ts`）与
`src/main/exporter.ts` 中的表格列定义，是本项目对**本项目作者委托产出的 Edge 扩展
`bilibili-slice-downloader`** 的 TypeScript 重写。

**权属说明**：该上游项目由本项目作者提出需求、交由 AI 编码工具产出，**不存在第三方权利人**。
它不是一个由他人独立创作、作者无权处分的作品。因此本项目作者将其一并按 MIT 授权，
本节即为此项声明。

> 说明：AI 生成内容的著作权归属在不同法域仍有不确定性，这是所有 AI 辅助项目共同面对的问题。
> 但就本项目的合规风险而言，关键点在于「没有人被侵权」—— 该上游项目没有、也不会有
> 一个主张权利的第三方作者。
>
> 仓库中早先的文件里若留有「待确认授权」之类的措辞，均以此节为准。

### 3.3 mpegts.js（Apache-2.0，内包在插件里）

`extension/vendor/mpegts.js`（1.8.2 版，275 KB）+ `extension/vendor/mpegts.LICENSE.txt`。

用途：直播间的「只放音频」模式拿到的是 **FLV 纯音频流**（`only_audio=1`），
浏览器原生 `<audio>` 放不了 FLV，必须用 mpegts.js 把它转成 MSE 可播的分片。

为什么**内包**而不是从 CDN 动态加载：参考过的同类插件是在页面里插一段 CDN 的 script，
CDN 被墙 / 超时 / 被扩展拦掉时整个功能静默失效，用户只看到「点了没反应」。
内包后只要插件加载成功，这条路径就不会因为网络原因挂掉。

许可证：Apache-2.0，允许随作品分发，需保留 LICENSE 与 NOTICE。本项目保留了原 `mpegts.LICENSE.txt`，
未修改其源码（文件为官方构建产物原样拷贝）。

### 3.4 其他

`src/main/slice/sidx.ts` 的注释提到分片索引思路「仿 A-SOUL 切片插件」。此处仅指接口/格式层面的
行为参考（SIDX box 解析是公开的 ISO BMFF 规范），未复制其代码，因此不构成衍生作品。
若后续确有计划直接复用其代码，请在此登记。
