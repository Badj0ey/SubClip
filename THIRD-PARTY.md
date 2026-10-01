# 第三方组件与代码归属

本项目的**自有代码**以根目录 [`LICENSE`](LICENSE)（MIT）授权。
下面列出随程序分发或在本项目中移植/参考的第三方内容及其授权要求。

---

## 一、随程序分发的依赖

这些依赖会被打包进安装包，因此必须在本文档中保留其授权声明。

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 33.x | MIT | 桌面应用运行时 |
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

### 3.2 bilibili-slice-downloader（⚠️ 授权状态待确认）

`src/main/slice/`（`playurl.ts`、`sidx.ts`、`downloader.ts`、`ffmpeg.ts`、`engine.ts`）与
`src/main/exporter.ts` 中的表格列定义，是本项目对 **原作者自己的 Edge 扩展
`bilibili-slice-downloader`** 的 TypeScript 重写。

该上游项目**没有 LICENSE 文件**，其 `package.json` 也只是一句 `{ "type": "module" }`，
即默认「保留所有权利」。因此：

- ✅ 如果它同样是本项目的作者所写 —— 请把该上游项目一并按 MIT 授权（或在本仓库中明确声明
  其代码已由作者本人以 MIT 重新授权），并在此处补一句说明，即可消除歧义。
- ❌ 如果它由**他人**编写 —— 在取得授权之前，这部分代码不应随 MIT 项目公开发布。

> **行动项（发布前必须完成）**：确认该上游项目的作者归属，并把结论写进本节。

### 3.3 其他

`src/main/slice/sidx.ts` 的注释提到分片索引思路「仿 A-SOUL 切片插件」。此处仅指接口/格式层面的
行为参考（SIDX box 解析是公开的 ISO BMFF 规范），未复制其代码，因此不构成衍生作品。
若后续确有计划直接复用其代码，请在此登记。
