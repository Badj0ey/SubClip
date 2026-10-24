# 发布检查单（Windows）

## 准备

1. 确认 `package.json` 与 `userscript/SubClip.user.js` 的版本一致；桥接协议版本单独维护。
2. 先备份真实用户数据库；升级测试在**临时**用户数据目录完成。
3. 使用 Node.js 22+ 和稳定网络执行 `npm ci`。`npm run dist` 会先运行 `npm run vendor:ffmpeg`，从镜像下载 ffmpeg 6.1.1 并校验 SHA-256 后放进 `vendor/ffmpeg`；镜像不可用时可用 `FFMPEG_DOWNLOAD_BASE` 指向其它镜像，或手工放好 `vendor/ffmpeg/ffmpeg.exe` 与许可文件。
4. 确认 `THIRD-PARTY.md` 与实际分发依赖及许可证一致。

## 构建与验证

```bash
npm run typecheck
npm test
npm run build
npm run dist
npm run dist:checksums
```

`electron-builder.yml` 生成 Windows x64 NSIS 安装包和 ZIP 免安装包，产物在 `dist/`；安装包 extraResources 会带上 `resources/ffmpeg/`（含许可与 README），因此体积约 180 MB 量级，属预期；`npm run dist:checksums` 额外生成 `dist/SHA256SUMS.txt`。安装向导包含 MIT 许可证页、产品图标和侧边图，控制面板卸载项显示「字幕剪 SubClip」；卸载默认保留用户数据。未配置代码签名时不要宣称已签名，Windows SmartScreen 可能提示未知发布者。

## 安装包手工验收

- 安装向导的许可证页、安装目录选择、桌面/开始菜单快捷方式；控制面板卸载项名称。
- 安装/卸载、首次启动、启动时数据迁移、重启后数据保持；卸载后确认 `userData` 数据仍在。
- 素材库/字幕阅读、Ctrl+K、深浅主题、三栏布局、最近统计。
- FFmpeg 被识别为「已就绪」（安装包 `resources/ffmpeg/ffmpeg.exe`）；跑一次真实切片确认输出目录、字幕拉取/导入、CSV/XLSX 导出。
- 用户脚本在打包后的 `resources/userscript/` 可读取，WebSocket 连接状态正常。
- 模型下载与本地语义索引、Ollama/OpenAI 兼容接口（可选）。
- 安全检查：外链协议限制、诊断信息脱敏、备份恢复。

## 发布内容

发布说明至少包含：版本、变化、已验证的平台、已知限制、数据迁移提醒、第三方依赖许可和安装包哈希。不要将 `node_modules/`、`.npmrc`、用户 Cookie、API Key、调试数据库或测试中间产物放入源码 ZIP。

全程在 GitHub 网页操作（不安装 Git、不用命令行、不依赖 Actions）的开源与手工发布步骤见 [纯手动开源与发布](GITHUB.md)。`npm run dist` 已带 `--publish never`，打包只产出本地文件，不会尝试向 GitHub 发布。
