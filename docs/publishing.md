# 发布清单

仓库本身已经可以构建、测试、打包。上传到 GitHub 之后，只有**几处占位**需要替换成你自己的信息。
本文档列出全部位置，照着走一遍即可。

## 一、创建仓库后需要替换的地方

假设你的仓库是 `https://github.com/<用户名>/<仓库名>`：

### 1. `package.json`

补上这三个字段（`npm` 不强制要求，但发布后便于别人反馈问题）：

```jsonc
{
  "repository": { "type": "git", "url": "https://github.com/<用户名>/<仓库名>.git" },
  "bugs": { "url": "https://github.com/<用户名>/<仓库名>/issues" },
  "homepage": "https://github.com/<用户名>/<仓库名>#readme"
}
```

### 2. `CHANGELOG.md`

版本号按 2.0 重构路线图的里程碑走（`0.1.0` → `1.5.0` → `2.0.0` → `3.0.0`），
每完成一个阶段就新增一节，字段用「新增 / 变更 / 修复 / 安全 / 说明 / 验证」。
文件末尾有一段 HTML 注释，写着怎么给最新版本补对比链接。

注意：`package.json` 与 `extension/manifest.json` 的版本号**必须同步改**
（`npm run test:wbi` 会断言两者一致）；README 的「重构升级进度」表也要跟着更新状态与版本。

### 3. `README.md` / `README.en.md`

需要的话在标题下加徽章：

```markdown
[![CI](https://github.com/<用户名>/<仓库名>/actions/workflows/ci.yml/badge.svg)](https://github.com/<用户名>/<仓库名>/actions/workflows/ci.yml)
```

### 4. `docs/requirements.md`

这是**由原始 `.docx` 转换**而来的需求文档，里面保留了原文档提到的本机路径
（`D:\subtitle2clip\...`、`D:\bili_subtitle_extension_native_v1.2.8`）。
这些是历史记录的一部分，**通常不需要改**；如果你不希望公开这类本机路径，删掉对应行即可。

同样地，`src/main/slice/*.ts` 与 `src/main/bilibili.ts` 的文件头注释里也写了移植来源的原始路径。
留着有助于解释「这段代码从哪来」，删掉也不影响任何功能。

## 二、打第一个版本

```bash
git tag v1.5.0
git push origin v1.5.0
```

推 tag 会触发 `.github/workflows/ci.yml`：

1. `test` job：类型检查 → 构建 → 跑全部测试（Windows runner）
2. `package` job（仅在 tag 或手动触发时）：打出 NSIS 安装包与免安装 zip，作为 artifact 上传

也可以在 Actions 页面手动 `workflow_dispatch` 只跑打包。

> **不要**在仓库里保留 `.npmrc`。国内镜像配置请本地复制 `.npmrc.example` 使用 ——
> CI 跑在境外 runner 上，走国内镜像会更慢甚至拉不到包。

## 三、发布前已经确认过的事项

| 事项 | 结论 |
| --- | --- |
| 自有代码授权 | MIT（见 `LICENSE`） |
| 随包分发的依赖 | Electron / Vue / ws / xlsx，见 `THIRD-PARTY.md` 第一节 |
| 移植代码的权属 | `bilibili-slice-downloader` 与 `bili_subtitle_extension_native` 均为本项目作者委托产出，不存在第三方权利人，已一并按 MIT 授权（见 `THIRD-PARTY.md` 第三节） |
| 本地服务安全 | Origin 白名单 + 配对令牌 + 消息校验 + maxPayload/限流，见 `SECURITY.md` |
| CI 可跑通 | 已在本地逐步验证 `npm ci`（lockfile 一致）、`typecheck`、`build`、`test`，以及完整的 `npm run dist` 打包 |

## 四、已知但**未**处理的问题

这些不在本次范围内，发布时请在 release notes 里如实说明，或先修掉再发：

- **B站 Cookie 是明文存储**的（`settings.json`），没有走 Electron 的 `safeStorage`。
  任何以当前用户身份运行的程序都能读到。见 `SECURITY.md`。
- **`xlsx@0.18.5` 有已知安全问题**，且 SheetJS 社区版的授权方式特殊。
  计划替换为自研的最小 XLSX 写出器；在此之前建议优先用 CSV 导出。
- **无障碍只做了结构性改造**（ARIA 角色、键盘操作、焦点样式），**没有用屏幕阅读器实测过**。
