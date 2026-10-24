# 开源到 GitHub 与发布 Release

本文以产品源码仓库 `D:\srttool\app` 和目标仓库 `Badj0ey/SubClip` 为例。外层 `D:\srttool` 是工作区，含备份、临时文件和其他文档，**不要**把外层目录当成产品仓库推送。

## 1. 推送前检查

先确认要提交的内容、版本和测试状态：

```bash
cd /d/srttool/app
git status --short
git log --oneline -5

npm ci
npm run typecheck
npm test
npm run build
```

再检查是否误跟踪了本地配置、数据库或密钥：

```bash
git ls-files | grep -Ei '\.(env|pem|p12|pfx|key)$|settings\.json|\.db$' || true
git grep -n -I -E 'sk-[A-Za-z0-9]{20,}|SESSDATA=[A-Za-z0-9%]{10,}|ghp_[A-Za-z0-9]{20,}' || true
```

`SESSDATA` 出现在输入框占位符和测试夹具里是正常的；如果出现真实 Cookie、API Key 或令牌，先删除并轮换，再提交。仓库根目录应有 `LICENSE`、`README.md`、`SECURITY.md`、`CONTRIBUTING.md` 和 `.github/workflows/ci.yml`。

确认提交身份：

```bash
git config user.name
git config user.email
```

## 2. 首次推送到空仓库

GitHub 上的 `Badj0ey/SubClip` 目前是空仓库。产品仓库还没有 remote 时：

```bash
cd /d/srttool/app
gh auth status
git remote add origin https://github.com/Badj0ey/SubClip.git
git branch -M main
git push -u origin main
```

如果已经有 remote，只改地址：

```bash
git remote set-url origin https://github.com/Badj0ey/SubClip.git
git push -u origin main
```

如果网页端初始化仓库时勾选了 README 或 LICENSE，远端会先有一个提交，直接 push 会被拒绝。先拉取并变基，再推送：

```bash
git pull --rebase origin main
git push -u origin main
```

推送成功后打开仓库的 **Actions** 页，确认 `CI` 工作流通过。首次发布前还要设置一次工作流权限：

**Settings → Actions → General → Workflow permissions → Read and write permissions → Save**

否则 `GITHUB_TOKEN` 只能读仓库，打标签时无法创建 Release。工作流里已经声明了 `permissions: contents: write`，但仓库级设置不能低于这个权限。

## 3. 打标签，自动创建草稿 Release

版本号必须先同步到 `package.json`、`package-lock.json` 和 `userscript/SubClip.user.js` 的 `@version`。`tests/wbi.test.ts` 会检查应用与用户脚本版本一致，不一致时 CI 直接失败。

```bash
git tag -a v3.18.0 -m "SubClip 3.18.0"
git push origin v3.18.0
```

推送 `v*` 标签后，`CI` 会依次执行：

1. Windows runner 上的类型检查、构建和全部测试；
2. 生成 NSIS 安装包、免安装 ZIP 和 `dist/SHA256SUMS.txt`；
3. 用 `softprops/action-gh-release` 创建**草稿** Release，并上传三个文件。

在 **Releases** 页打开该草稿，检查安装包、ZIP 和校验文件是否都在，补充发布说明，确认无误后点 **Publish release**。草稿在发布前对普通访客不可见。

从 3.18.1 起安装包内置 FFmpeg（约 80 MB），安装包体积会到 180 MB 左右，属预期；CI 打包时会自动下载并校验 ffmpeg，runner 访问 `registry.npmmirror.com` 失败时可用 `FFMPEG_DOWNLOAD_BASE` 指向其它镜像。发布说明里请一并注明 FFmpeg 的 GPLv3 许可与源码链接（见 `THIRD-PARTY.md`）。

也可以手动触发 `CI`（Actions → CI → Run workflow）：它只构建并上传 Actions artifact，不创建 Release，适合先在仓库里验收打包结果。

## 4. 本地打包与手工发布

```bash
cd /d/srttool/app
npm run dist
npm run dist:checksums
```

产物：

- `dist/SubClip-3.18.0-setup.exe`：NSIS 安装包；
- `dist/SubClip-3.18.0-x64.zip`：免安装版；
- `dist/SHA256SUMS.txt`：两个产物的 SHA-256。

先推送标签，再用 GitHub CLI 创建草稿 Release：

```bash
git tag -a v3.18.0 -m "SubClip 3.18.0"
git push origin v3.18.0

gh release create v3.18.0 --draft --title "SubClip 3.18.0" --generate-notes \
  dist/SubClip-3.18.0-setup.exe \
  dist/SubClip-3.18.0-x64.zip \
  dist/SHA256SUMS.txt
```

然后在网页端编辑说明并发布。完全手工上传也可以：**Releases → Draft a new release**，选择已有标签，填写标题和说明，把三个文件拖到附件区，最后点 **Publish release**。GitHub 单个附件上限为 2 GB，当前安装包远低于该限制。

## 5. Release 说明模板

```markdown
## 安装

- 支持 Windows 10/11 x64。
- 安装版：`SubClip-3.18.0-setup.exe`；免安装版：`SubClip-3.18.0-x64.zip`。
- 校验：下载后核对 `SHA256SUMS.txt` 中的 SHA-256。

## 本版变化

- ……

## 已知限制

- 安装包未做代码签名，Windows SmartScreen 可能提示“未知发布者”；请先核对哈希，再决定是否运行。
- 安装包已内置 FFmpeg，切片无需另装；B 站拉取、预览、模型下载和云端 AI 仍需要联网。
- 升级前建议在「设置」中备份数据库。
```

不要写“已签名”“绝对安全”或无法复现的兼容性结论。未签名的安装包被 SmartScreen 拦截是正常现象，应说明校验方法，而不是让用户关闭系统安全功能。

## 6. 发布后检查

```bash
# 重新下载后核对哈希（PowerShell）
Get-FileHash .\SubClip-3.18.0-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

- Release 已从 Draft 变为 Published，附件可匿名下载；
- 安装包、ZIP 与 `SHA256SUMS.txt` 三者版本号一致；
- README 中的版本号和 Release 链接指向本次发布；
- `git status` 干净，标签已推送，CI 为绿色。

## 7. 常见问题

**push 提示用户名密码错误**：GitHub 已不支持账户密码推送。用 `gh auth login` 登录，或创建带 `repo` 权限的 Personal Access Token 作为密码。

**push 被拒绝（non-fast-forward）**：远端已有提交。确认远端内容可以保留后执行 `git pull --rebase origin main`，解决冲突再推送；不要把本地历史强推覆盖别人的提交。

**标签推送后没有 Release**：检查标签是否以 `v` 开头、`package` job 是否成功、仓库是否给了 Actions 读写权限。手动触发 `workflow_dispatch` 不会创建 Release，这是刻意设计。

**Release 里缺少某个文件**：在本地 `dist/` 确认文件存在，检查工作流的 `files` 路径；也可以在草稿 Release 页面手动补传。

**安装包被 SmartScreen 拦截**：当前没有代码签名证书。正式分发前可购买代码签名证书并配置 `CSC_LINK` / `CSC_KEY_PASSWORD`；在此之前保持“未签名”的说明，不要建议用户关闭 SmartScreen。
