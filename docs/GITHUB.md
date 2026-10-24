# 纯手动开源到 GitHub 并发布 Release

本手册**全程在 github.com 网页上完成**：不安装 Git、不打开命令行、不配置 Actions，也不要求你会写代码。适合把已经打好的安装包和源码一次性放到 GitHub 上。

> 本手册只负责「传到 GitHub 并发布」。安装包怎么构建、版本号怎么改，见 [发布检查单](RELEASE.md)；仓库里保留了 `.github/workflows/ci.yml`，但**本手册不使用它**，有没有工作流都不影响下面的步骤。

## 0. 先备齐这几样东西

在资源管理器里确认：

- 源码目录：`D:\srttool\app`（只上传这个目录里的内容，不要上传外层的 `D:\srttool`）。
- 发布资产（都在 `D:\srttool\app\dist` 下）：
  - `SubClip-3.18.1-setup.exe`（安装版，推荐）
  - `SubClip-3.18.1-x64.zip`（免安装版）
  - `SHA256SUMS.txt`（两个文件的校验值）
- 第 6 节的 Release 说明模板（复制到剪贴板备用）。
- 一个浏览器，已登录 GitHub 账号 `Badj0ey`。

上传前**不要**把这些带进仓库：`node_modules`、`dist`、`out`、`vendor`、`.probe`、`settings.json`、任何 `.db` 数据库、日志和备份。安装包本身也不进仓库——它只作为 Release 附件上传。

## 1. 新建仓库

1. 打开 <https://github.com>，点右上角 **+**，选 **New repository**。
2. **Owner** 选 `Badj0ey`，**Repository name** 填 `SubClip`。
3. 可见性选 **Public**（想先私密就选 Private，后面随时能在 Settings 里改）。
4. **不要**勾选 “Add a README file”“Add .gitignore”“Choose a license”——源码里都已经有了。
5. 点 **Create repository**。

## 2. 把源码传上去（网页上传，不需要 Git）

1. 在新仓库首页点 **Add file → Upload files**。
2. 打开资源管理器进入 `D:\srttool\app`，把下面这些**文件和文件夹**一起拖进网页的上传区域：
   - 文件夹：`src`、`tests`、`scripts`、`userscript`、`docs`、`build`
   - 文件：`package.json`、`package-lock.json`、`electron-builder.yml`、`electron.vite.config.ts`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`README.md`、`README.en.md`、`LICENSE`、`CHANGELOG.md`、`THIRD-PARTY.md`、`SECURITY.md`、`CONTRIBUTING.md`、`.gitignore`、`.npmrc.example`、`.gitattributes`、`SubClip.bat`、`开发模式.bat`
   - 可选：`AGENTS.md`（给 AI 协作者的说明）、`.github` 文件夹（里面只有 CI 工作流；不想用自动化就别传）。
3. 拖拽会上传子目录并保留结构；如果浏览器对隐藏文件（如 `.gitignore`）不显示，先在资源管理器里打开「显示隐藏的项目」，或之后用 **Add file → Create new file** 手动补一个同名文件。
4. 页面下方 **Commit changes** 区域填提交说明，例如：`初始提交：SubClip 3.18.1 源码`，然后点 **Commit changes**。
5. 传完后刷新仓库首页，确认能看到 `src`、`docs`、`package.json`，并且**没有** `node_modules`、`dist`、`vendor`。

网页上传的限制：单个文件最大 25 MB，一次拖太多文件可能失败。我们的源码文件都很小；安装包远超 25 MB，所以只放 Release，不进仓库。如果上传中断，刷新页面重新拖剩下的文件即可。

## 3. 创建 Release 并上传安装包

1. 在仓库首页右侧点 **Releases**（或直接打开 `https://github.com/Badj0ey/SubClip/releases`）。
2. 点 **Draft a new release**。
3. **Choose a tag** → 输入 `v3.18.1` → 点 **Create new tag: v3.18.1 on publish**。目标分支保持 `main`。
4. **Release title** 填 `SubClip 3.18.1`。
5. 在说明框里粘贴第 6 节的模板，把校验值换成 `SHA256SUMS.txt` 里的实际内容（这次模板里已填好）。
6. 找到 **Attach binaries by dropping them here or selecting them**，把三个文件逐个拖进去或点选：
   - `SubClip-3.18.1-setup.exe`
   - `SubClip-3.18.1-x64.zip`
   - `SHA256SUMS.txt`
7. 确认勾选 **Set as the latest release**。
8. 建议先点 **Save draft**，在草稿状态检查标题、标签、三个附件和说明是否齐全；确认无误后回到草稿点 **Publish release**。

草稿在发布前普通访客看不到；发布后标签 `v3.18.1` 会出现在仓库的 Tags 里，Release 页面也会出现在右侧栏。

## 4. 发布后检查（还是网页操作）

1. 开一个**无痕窗口**（不登录 GitHub），打开 `https://github.com/Badj0ey/SubClip/releases`，确认能看到 3.18.1、三个附件都能下载。
2. 下载 `SHA256SUMS.txt`，和 Release 说明里的校验值对一遍；再核对安装包大小是否为 161,041,436 字节、ZIP 是否为 217,934,446 字节。
3. 打开仓库首页，确认 README 里的 Releases 链接可点；若 CI 徽章显示失败可以忽略——本手册不依赖工作流。
4. 下载安装包试装一次：安装向导 → 启动 → 「设置 → 本地切片」应显示「✓ 已就绪」。Windows 可能弹出 SmartScreen「未知发布者」，这是未做代码签名的正常现象，说明里已注明。

可选：想在本机核对下载文件的哈希，可以右键文件 → 属性查看大小，或用系统自带的 `certutil -hashfile 文件名 SHA256`。这一步不是必须的。

## 5. 之后要改内容怎么办

- **只改文字**：在仓库里点开对应文件 → 右上角铅笔图标 → 修改 → **Commit changes**。
- **补传或替换安装包**：进入该 Release → **Edit release** → 删除旧附件（附件右侧的垃圾桶）→ 重新上传 → **Update release**。不要新建一个同版本号的 Release。
- **发新版本**：先把三处版本号在网页上改成新版本（`package.json`、`package-lock.json`、`userscript/SubClip.user.js`），在本机构建出新安装包，然后按第 3 节新建 `v3.18.2` 之类的标签和 Release。三处版本号必须一致，否则用户脚本和桌面端会对不上。
- **想换仓库可见性**：Settings → General → 最下方 Danger Zone → Change visibility。改成 Private 后，Release 也一并变为私有。

## 6. Release 说明模板（直接复制到说明框）

```markdown
## 下载

- 安装版（推荐）：`SubClip-3.18.1-setup.exe`
- 免安装版：`SubClip-3.18.1-x64.zip`
- 校验文件：`SHA256SUMS.txt`

## 3.18.1 更新

### 修复

- 直播回放的视频弹幕池本来就是空的（直播期间的聊天弹幕不会迁移进来，B 站也没有公开的回放弹幕接口），面板却提示「接口暂不可用」。现在会明确说明原因，并且不再为一个空弹幕池发几十个分段请求。

### 新增

- 安装包内置 FFmpeg 6.1.1（GPLv3），装好即可本地切片，不需要单独安装 Node.js、npm 或 FFmpeg。
- 安装包体积相应增加约 21 MB。

### 兼容性

- 数据库结构、迁移、桥接协议（v4）均未改变，可直接覆盖升级。
- 字幕、弹幕、设置和登录态仍保存在本机；升级前建议在「设置」里备份数据库。

## 安装说明

- 支持 Windows 10/11 x64。安装包已带 Electron 运行时和 FFmpeg；语义检索模型在应用内按需下载。
- 未做代码签名，Windows SmartScreen 可能提示「未知发布者」；请先核对下面的哈希再运行。
- 安装/卸载默认保留用户数据；卸载不会自动删除数据库。

## 已知限制

- 弹幕、字幕、播放地址受 B 站接口、账号权限、地区和视频设置影响；直播回放只有视频弹幕池，没有直播聊天弹幕。
- 长视频弹幕可能因 80 分段 / 15,000 条上限或接口失败只返回部分结果，面板会提示截断。
- 本次未做真实安装向导逐项验收，也未跑完整的剪辑导出；打包版已验证能识别内置 FFmpeg。

## 校验值（SHA-256）

```
c45169fb0b4708fc7a5613795d5ec1094f7e301a69efb8afb988fa11a1d57eb3  SubClip-3.18.1-setup.exe
1aec30c4b9f5b3c9d1c48651a906963fdfd3ebd097e7060125c8a0599d4eb869  SubClip-3.18.1-x64.zip
```

## 许可

自有代码 MIT；FFmpeg 以独立可执行文件分发，许可为 GPLv3，构建与源码信息见仓库的 `THIRD-PARTY.md`。
```

## 7. 常见问题

- **网页上看不到附件上传按钮**：确认是在 Draft/Edit release 页面，而不是仓库首页；草稿也能上传。
- **上传到一半失败**：刷新 Release 编辑页，已上传的附件通常还在，补传剩下的即可。
- **仓库里出现了 `node_modules` 或 `dist`**：在网页上点进该目录 → 右上角 **Delete directory** → 提交；同时确认 `.gitignore` 已上传，避免下次再传。
- **Release 链接对别人 404**：大概率还是草稿（Save draft 后没点 Publish），或者仓库是 Private。
- **误传了 Cookie、API Key 或数据库**：立即在网页删除该文件并提交，然后更换对应凭证；GitHub 的历史记录仍可能保留旧内容，敏感凭证务必当作已泄露处理。
- **想以后自动发布**：仓库里的 `.github/workflows/ci.yml` 可以启用，但那需要代码和权限配置；本手册刻意保持纯手动。
- **不想公开源码**：把仓库设为 Private 即可；如果只想发布安装包，仍建议保留 LICENSE 与源码，方便别人核对许可。
