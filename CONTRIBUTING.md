# 参与贡献

感谢你有兴趣改进这个项目。下面是让改动能顺利合入的几条约定。

## 开发环境

需要 **Node.js 20 或以上**。

```bash
git clone <仓库地址>
cd <仓库>
npm install
npm run dev        # 开发模式（热更新）
```

> **npm 镜像（可选）**：中国大陆网络下，把 `.npmrc.example` 复制成 `.npmrc` 可显著加快安装
> （registry 与 Electron 二进制都走 npmmirror）。**默认不要提交 `.npmrc`** ——
> CI 跑在境外 runner 上，国内镜像会让它更慢甚至失败。

## 提交之前必须全部通过

```bash
npm run typecheck  # 渲染进程 + 主进程 + tests/ + extension/*.js
npm test           # 五组测试
npm run build      # 构建产物必须能出来
```

`test:smoke` 与 `test:bridge` 会真的启动 Electron 并创建窗口，需要图形化桌面会话；
纯 SSH 环境下请只跑 `test:core`、`test:wbi`、`test:slice`。

## 代码约定

- **TypeScript strict 全开**，不要用 `@ts-ignore` 绕过（现有代码里一个都没有，请保持）。
- **注释写「为什么」，不写「做了什么」**。尤其是踩过的坑，把现象和原因写清楚，比改代码本身更有价值。
- **纯逻辑尽量抽成零依赖模块**，方便单测。例如：
  - `src/main/slice/filename.ts`（文件名净化）
  - `src/shared/ranges.ts`（时间坐标生成）
  - `src/main/srt.ts` 里的 `shiftCues` / `replaceInCues`
- **新增行为要配测试**。测试是手写 runner，直接 `assert`，不引入测试框架：
  - 纯函数 → `tests/core.test.ts`
  - 数据层 / 迁移 → `tests/smoke.ts`
  - 插件通信 / 协议 → `tests/bridge.smoke.ts`
- **改协议要同时改两边**：`src/shared/bridge.ts` ↔ `extension/shared/protocol.js`，
  并且 `npm run test:wbi` 会校验版本号与扩展 ID 一致。

## 两处容易踩的坑

1. **不要给工作区里的可执行文件加「低完整性」标签**（Windows）。
   在低标签目录下新建的文件会继承该标签，而 Electron/Chromium 在低完整性下会直接崩溃
   （退出码 `-2147483645`，且打包产物双击无任何输出）。
2. **数据层的事务必须可重入**。`db.withTransaction()` 用 `batchDepth` 判重 ——
   否则嵌套的 `saveCues` 会再开一次 `BEGIN`，SQLite 报
   「cannot start a transaction within a transaction」，异常还会被上层的 `catch` 吞掉。

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀，正文用中文写清「为什么」：

```
feat(search): 全库跨文档检索
fix(bridge): 本地服务缺少来源校验
chore(deps): Electron 33 → 36
docs: 补上导出功能说明
```

## 提交 Pull Request

- 一个 PR 只做一件事；顺带的重构请拆开。
- 描述里写清楚：**解决了什么问题、怎么验证的**（贴测试输出或截图）。
- 如果改了界面，附一张截图。
- CI 必须绿。

## 报告问题

- Bug 请用 issue 模板，附上：版本、系统、复现步骤、预期与实际结果。
- **安全问题请不要开公开 issue** —— 见 [SECURITY.md](SECURITY.md)。
