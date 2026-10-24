# 发布检查单（Windows）

## 准备

1. 确认 `package.json` 与 `userscript/SubClip.user.js` 的版本一致；桥接协议版本单独维护。
2. 先备份真实用户数据库；升级测试在**临时**用户数据目录完成。
3. 使用 Node.js 22+ 和稳定网络执行 `npm ci`，确认 Electron 与 FFmpeg 环境。
4. 确认 `THIRD-PARTY.md` 与实际分发依赖及许可证一致。

## 构建与验证

```bash
npm run typecheck
npm test
npm run build
npm run dist
```

`electron-builder.yml` 目前生成 Windows x64 NSIS 安装包和 ZIP 免安装包，产物在 `dist/`。未配置代码签名时不要宣称已签名；Windows SmartScreen 可能提示未知发布者。

## 安装包手工验收

- 安装/卸载、首次启动、启动时数据迁移、重启后数据保持。
- 素材库/字幕阅读、Ctrl+K、深浅主题、三栏布局、最近统计。
- FFmpeg 路径与输出目录、字幕拉取/导入、CSV/XLSX 导出。
- 用户脚本在打包后的 `resources/userscript/` 可读取，WebSocket 连接状态正常。
- 模型下载与本地语义索引、Ollama/OpenAI 兼容接口（可选）。
- 安全检查：外链协议限制、诊断信息脱敏、备份恢复。

## 发布内容

发布说明至少包含：版本、变化、已验证的平台、已知限制、数据迁移提醒、第三方依赖许可和安装包哈希。不要将 `node_modules/`、`.npmrc`、用户 Cookie、API Key、调试数据库或测试中间产物放入源码 ZIP。
