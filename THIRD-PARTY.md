# 第三方组件与许可声明

本项目自有源码按根目录 [LICENSE](LICENSE) 的 MIT 许可证分发。下表是主要依赖的用途概览；实际发行前应以 `package-lock.json` 的锁定版本及分发产物附带的许可证文件为准。

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 桌面运行时 |
| [Vue 3](https://github.com/vuejs/core) | MIT | UI 框架 |
| [Pinia](https://github.com/vuejs/pinia) | MIT | 前端状态管理 |
| [mitt](https://github.com/developit/mitt) | MIT | 事件总线 |
| [ws](https://github.com/websockets/ws) | MIT | 本地 WebSocket 通信 |
| [SheetJS Community Edition / xlsx](https://git.sheetjs.com/sheetjs/sheetjs) | Apache-2.0（本项目锁定版本） | XLSX 导出 |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | 本地语义嵌入模型运行 |
| [FFmpeg](https://ffmpeg.org/) 6.1.1（gyan.dev essentials 静态构建） | GPL-3.0 | 本地视频切片；随安装包分发，位于 `resources/ffmpeg/ffmpeg.exe` |
| TypeScript、Vite、electron-vite、esbuild、electron-builder | 各自开源许可 | 开发与打包工具 |

**注意：**

- FFmpeg 以独立可执行文件形式随安装包分发（应用通过命令行调用，不与自有代码链接），安装目录的 `resources/ffmpeg/` 下附有 `ffmpeg.LICENSE`（GPLv3）与 `ffmpeg.README`（构建信息）。对应源码为 [FFmpeg commit e38092ef93](https://github.com/FFmpeg/FFmpeg/tree/e38092ef93)，构建来源见 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)。
- 本项目不随源码包提供模型权重；语义检索模型由应用按需下载，使用时需遵守相应第三方许可和使用条款。
- Electron 安装包保留 Electron/Chromium 自带的许可证文件。

## 参考/移植来源

### bili_subtitle_extension_native（MIT）

`src/main/bilibili.ts` 中部分 B 站接口和 WBI 签名处理参考了 `bili_subtitle_extension_native` 的实现。为保留原始 MIT 许可义务，附上其随原项目记录的版权与许可文本：

```text
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

### bilibili-slice-downloader（项目来源说明）

`src/main/slice/` 和 `src/main/exporter.ts` 的部分工作流来自项目作者原有的 `bilibili-slice-downloader` 需求与实现，当前已重写为 TypeScript。若后续引入独立第三方代码，应在本文件中补充实际权利人、许可和必要的版权声明。

### SIDX / ISO BMFF

`src/main/slice/sidx.ts` 按公开媒体容器格式解析索引数据。参考公开格式本身不等于复制第三方源代码。
