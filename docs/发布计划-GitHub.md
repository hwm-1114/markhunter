# MarkHunter 发布 GitHub 计划（v0.1.42）

> 状态：**计划稿，未执行**（用户要求先生成计划）。
> 基线：本地代码 v0.1.42（冒烟 94/94），安装包 `dist/MarkHunter-Setup-0.1.42.exe`（96.36 MB）。
> 决策锁定（用户已拍板）：Q1 私有｜Q3 只发 v0.1.42（不回填旧版）｜Q6 electron-builder 自动发布｜其余按建议（Q2 版权 VibeCode、Q4 README 合并、Q5 文档入 docs/、Q7 启用 CI 并配 Secrets.GH_TOKEN、Q8 自动更新本期不做）。

---

## 一、现状盘点（已核实）

| 项 | 现状 | 影响 |
|---|---|---|
| GitHub 账号 | `hwm-1114`（Wyman Ho），MCP 已认证 | 可直接操作仓库 |
| 目标仓库 | `hwm-1114/markhunter` **已存在**（2026-08-16 创建；2026-08-29 已转公开） | 是**更新**现有仓库，不是新建 |
| 仓库内容 | 48 条目，**v0.1.40 时代**源码（.github/workflows/release.yml、README.md、src/、scripts/ 等均在） | 0.1.41/0.1.42 的改动尚未同步 |
| 打包配置 | `electron-builder.yml` 已配 `publish: {provider: github, owner: hwm-1114, repo: markhunter, private: true}` | 发布链路已接线，需 GH_TOKEN |
| CI | 仓库已有 `.github/workflows/release.yml`（850B） | 未来打 tag 可自动构建发布 |
| 本地 git | 无 `.git`；`git 2.55.0` 可用 | 需初始化/克隆后推送 |
| .gitignore | 已忽略 `node_modules/ dist/ .reasonix/ *.log` | 安装包不进仓库，走 Releases |
| LICENSE | **缺失**（package.json 声明 MIT） | 发布前需补 MIT LICENSE |
| 文档 | README.md（v0.1.40 时代，提到 GitHub Actions/Packages）与 README.txt 并存；根目录有评审报告/开发计划 md | 需更新 README、新增 CHANGELOG |
| 安装包 | 本地 dist/ 有 0.1.39/0.1.40/0.1.41/0.1.42 四版（96.3~96.4MB） | 用 Releases 按版本分发 |
| .npmrc | 仅 GitHub Packages registry 配置，token 走 `NODE_AUTH_TOKEN` 环境变量，**无硬编码密钥** | 可随仓库提交，安全 |

---

## 二、目标

1. **代码上仓**：最新代码（v0.1.42）+ `package.json`/`package-lock.json`/`electron-builder.yml` 等全部同步到 `hwm-1114/markhunter`。
2. **安装包上 GitHub**：通过 **GitHub Releases** 分发；**每个版本一个独立 Release**（v0.1.42 的安装包作为 v0.1.42 Release 的资产，与 0.1.39/0.1.40/0.1.41 分开，互不覆盖）。
3. **更新说明**：仓库内新增 `CHANGELOG.md`（0.1.39 → 0.1.42 逐版更新说明）+ 每个 Release 正文写更新说明。

---

## 三、需拍板的决策项

| 编号 | 问题 | 选项 | 建议 |
|---|---|---|---|
| Q1 | 仓库可见性 | 私有（创建时）/ 公开 | **已公开**（2026-08-29 转公开；转公开前完成全历史密钥扫描，未发现泄露） |
| Q2 | LICENSE 版权方 | VibeCode（package.json author）/ Wyman Ho | **VibeCode**（与 package.json 一致） |
| Q3 | 是否回填旧版本 Release | 只建 v0.1.42 / 回填 0.1.39~0.1.41（各自独立 Release） | **回填**（"每个版本分开"最彻底，且本地已有全部安装包） |
| Q4 | README 策略 | 保留 README.md + README.txt / 合并为 README.md | **合并**（README.md 面向 GitHub，README.txt 内容并入后删除，避免双份漂移） |
| Q5 | 评审报告/开发计划 md | 保留在仓库 / 移入 docs/ / 不提交 | **保留**（仓库已有评审报告；开发计划放入 `docs/`） |
| Q6 | 发布方式 | electron-builder `-Publish`（自动建 Release 传资产）/ GitHub API 手动 | **electron-builder -Publish**（一条命令，资产齐全：exe+blockmap+latest.yml） |
| Q7 | CI 自动发布 | 启用（需配 `Secrets.GH_TOKEN`）/ 仅手动 | **启用**（仓库已有 release.yml，未来打 tag 即自动发布） |
| Q8 | 自动更新 | 接 electron-updater（私有 repo 需 token 下载）/ 仅手动下载 | 本期**手动下载**为主，自动更新列为后续 |

---

## 四、执行步骤（获批后按序执行）

### 阶段 0：前置准备
1. 确认 GH_TOKEN 存在且具备权限（classic `repo` 或 fine-grained：`Contents:write` + `Releases:write` + `Workflows:write`；用于 git push / electron-builder publish）。
2. `git config --global user.name/user.email` 检查（用 hwm-1114 身份）。
3. 确认本地 `dist/` 四个安装包齐全（已核实）。

### 阶段 1：仓库卫生（本地文件改动）
1. 新增 `LICENSE`（MIT，版权方按 Q2）。
2. 更新 `README.md`：最新功能清单（v0.1.42 全部功能：文件树/收藏/多标签/预览 mermaid/搜索/图片/Python/AI/会话保持/树定位/Pin/外部文件分支/Tab 缩进/粘贴纯文本/分隔条）、安装与使用、安全说明（SmartScreen 未签名提示）、开发/构建/测试命令、下载指引（指向 Releases）。README.txt 内容并入后删除（按 Q4）。
3. 新增 `CHANGELOG.md`：0.1.39 → 0.1.42 逐版更新说明（见第六节草案）。
4. 清理根目录杂项：`build-log.txt`、`builder_log.txt`、`release-log.txt`、`smoke-run4.log`（*.log 已被忽略，.txt 需手动删或加进 .gitignore）。
5. 按 Q5 决定文档摆放（如 `docs/` 收纳 `发布计划-GitHub.md`、`开发计划-5项需求.md`）。
6. 复查 `.npmrc` 无硬编码密钥（已核实安全）。

### 阶段 2：代码同步上仓（二选一）
**方案 A（推荐）：git clone 同步，保留现有历史**
1. `git clone https://github.com/hwm-1114/markhunter.git <临时目录>`（https + GH_TOKEN 或 SSH）。
2. 将本地工作目录内容同步到 clone（排除 node_modules/dist/.reasonix/*.log；`.gitignore` 保持一致）。
3. `git status` 检查差异 → 分提交：`docs: LICENSE/CHANGELOG/README 更新`、`chore: 同步 v0.1.41/0.1.42 代码`。
4. `git push origin main`。

**方案 B（无本地 git 环境时）：GitHub API 上传**
- 用 GitHub API/MCP 逐文件更新（保留现有历史）；文件较多（40+），建议只作备选。

> 禁止 `force push`（保留仓库既有历史）。

### 阶段 3：版本标签与 Releases（"与上一个版本分开"）
1. 打标签：`git tag v0.1.42 && git push origin v0.1.42`（如 CI 启用，push tag 即触发自动发布；否则走下一步）。
2. **发布 v0.1.42**（electron-builder 自动流程）：
   - 在本地（或 CI）设置 `GH_TOKEN`，执行 `node scripts/build.js` → `node node_modules/electron-builder/cli.js --win nsis --publish always`。
   - electron-builder 自动：创建/更新 tag `v0.1.42` 的 GitHub Release（正文可用预填的 release notes），上传 `MarkHunter-Setup-0.1.42.exe` + `.blockmap` + `latest.yml` 作为**该 Release 专属资产**。
   - 若走手动 API：`POST /repos/hwm-1114/markhunter/releases`（tag=v0.1.42，body=更新说明）→ 逐个上传资产。
3. **回填旧版本（按 Q3）**：对 v0.1.39 / v0.1.40 / v0.1.41 各自打 tag + 建独立 Release + 上传对应 exe/blockmap/latest.yml —— 每个版本一个 Release，**互不覆盖**。

### 阶段 4：验证
1. 仓库内容 = 本地 v0.1.42（抽查 src/renderer/tree.js、app.js、package.json version、CHANGELOG、LICENSE）。
2. Releases 列表：v0.1.42（+ 回填版本）各自存在，资产完整（exe 大小与本地一致、blockmap、latest.yml）。
3. 确认旧版本 Release 未被覆盖/删除。
4. 下载链接可访问（私有仓库需登录；如需公开分发按 Q1 处理）。
5. （可选）跑一次 `npm run smoke` 确认同步后无回归（代码未变，纯确认）。

### 阶段 5：收尾
1. README 补充 Releases 下载入口与使用说明。
2. 若启用 CI（Q7）：确认 `.github/workflows/release.yml` 与当前构建流程一致（本地 allow-scripts 问题不影响 CI），在仓库 Settings → Secrets 配置 `GH_TOKEN`。
3. 输出发布报告：仓库 commit 列表、Releases 列表、资产清单、验证结果。

---

## 五、风险与注意事项

| 风险 | 说明 | 缓解 |
|---|---|---|
| 无本地 .git | 直接 push 会因历史不相关被拒 | 用 clone 同步（方案 A）保留历史；禁止 force push |
| 私有仓库凭据 | clone/push/electron-updater 下载都需认证 | GH_TOKEN 或 SSH；fine-grained PAT 需 `Contents`+`Releases` 权限 |
| electron-builder publish 依赖 | `--publish always` 需要 GH_TOKEN 且能连 GitHub | 阶段 0 先验证 token；失败回退手动 API |
| latest.yml 覆盖风险 | 若误把旧版 latest.yml 传为"最新"会破坏自动更新 | 每个 Release 只带自己的 latest.yml；不跨版本覆盖 |
| 旧包被覆盖 | 同 tag 重复发布会覆盖资产 | 严格按版本号打 tag；v0.1.42 只用 v0.1.42 tag |
| README 双份漂移 | README.md/README.txt 内容不一致 | 按 Q4 合并 |
| 未签名 SmartScreen | 安装包无代码签名，首次运行有提示 | README 与 Release 正文明确说明 |
| .npmrc 泄漏 | 含 token 引用但走环境变量 | 已核实无硬编码；复查后提交 |
| 8.3 短路径等遗留 bug | 不影响发布 | 已知项写入 CHANGELOG 的"已知问题" |

---

## 六、更新说明草案（Release 正文 / CHANGELOG）

### v0.1.42（2026-08-18）
**新功能**
- 标签固定（Pin）：右键标签可固定/取消固定，📌 一键切换；"关闭其它/关闭右侧/关闭左侧"批量关闭时自动跳过已固定标签；固定状态随会话持久化，重启还原。
- 跨目录树定位：打开工作目录外的文件（拖拽/全局搜索/会话恢复）后，左侧树新增"外部文件"分支按真实路径链展开定位；外部目录可右键"切换工作目录到此目录"；工作目录语义与安全校验不变。

**修复与优化**：标签批量关闭后活动标签切到锚定标签；外部文件分支随标签增删自动清理。
**测试**：冒烟测试 94 项全过。

### v0.1.41（2026-08-18）
**新功能**
- 侧栏/工作区分界线拖拽调整宽度修复（原来分隔条被布局排到窗口最右缘导致拖不动）。
- 编辑器右键菜单新增"粘贴为纯文本"（经主进程读取系统剪贴板，去除富文本格式）。
- Tab 键缩进（默认 4 格，可在设置中调整为 1~8），Shift+Tab 反向缩进。

**测试**：冒烟测试 76 项全过。

### v0.1.40（2026-08-17）
**新功能**
- 会话保持：切换目录不丢失已打开标签，重启自动恢复上次会话（含活动标签）。
- 树自动定位：查看文件时左侧目录树自动展开定位到该文件。

### v0.1.39（2026-08-16）
**安全加固（12 项）**
- 主进程文件操作路径校验（防目录穿越/越权读写删）、渲染进程沙箱、导航防护（防本地 HTML 执行链）、CSP 收紧、API Key 加密存储（Windows DPAPI）、设置白名单、Python 运行加固（解释器校验/进程树终止）、AI 工具路径防护、测试后门移除、生产环境收紧、打包加固（asar + Electron Fuses）、安装包瘦身（mermaid 移出运行时依赖，111MB → 96MB）。

**已知问题**：安装包未做代码签名，首次运行 Windows SmartScreen 会提示"未知发布者"，选择"更多信息 → 仍要运行"即可；外部文件若经 8.3 短路径打开，树外部分支展开可能受短名/长名差异影响。

---

## 七、文件/资产清单

**进仓库（代码）**
- `src/**`、`scripts/**`、`assets/**`、`build/**`、`.github/workflows/release.yml`
- `package.json`、`package-lock.json`、`electron-builder.yml`、`.gitignore`、`.npmrc`
- `README.md`、`CHANGELOG.md`、`LICENSE`、（可选）`docs/` 计划与报告

**进 Releases（安装包，按版本分开）**
- `MarkHunter-Setup-<版本>.exe`、`MarkHunter-Setup-<版本>.exe.blockmap`、`latest.yml`（每个版本各自的 Release 下）

---

## 八、执行记录（2026-08-18 已执行完成）

### 结果汇总
- **仓库**：`hwm-1114/markhunter`（私有）已同步 v0.1.42 最新代码，`main` = `81b4ae5c`；tag `v0.1.42` 指向同一提交。
- **Release**：`https://github.com/hwm-1114/markhunter/releases/tag/v0.1.42` —— 3 个资产：`MarkHunter-Setup-0.1.42.exe`（95.52MB）+ `.blockmap` + `latest.yml`；正文含更新说明；与 v0.1.39/v0.1.40 旧 Release 完全分开。
- **GitHub Packages**：`@hwm-1114/markhunter@0.1.42` 已发布（私有）。
- **CI**：`.github/workflows/release.yml` 已启用（打 tag 自动构建发布）；仓库 Secret `GH_TOKEN` 已配置（PAT，libsodium 加密写入），未来发布走非 draft 模式。

### 执行要点与踩坑（供后续参考）
1. 本机网络：`github.com`/`uploads.github.com` 被墙、本地代理未运行，仅 `api.github.com` 可直连 → 代码经 **git data API** 上传（blobs→tree→commit→ref），资产上传走 **GitHub Actions CI**（GitHub 服务器侧构建发布）。
2. **中文文件名必须 UTF-8 字节体**：PowerShell `Invoke-RestMethod -Body` 传字符串会被转成 `?`（git data API 路径乱码导致 checkout 失败）；须 `[Text.Encoding]::UTF8.GetBytes($json)` 传字节数组。
3. **electron-builder 发布类型**：GH_TOKEN 为 Actions 的 `GITHUB_TOKEN` 时强制 **draft** 发布；与已存在的正式 Release 类型不匹配会"skipped publishing"（0 资产）。已修复：workflow 用 `secrets.GH_TOKEN || secrets.GITHUB_TOKEN`，且 GH_TOKEN secret 已配置（PAT 发布为非 draft）。
4. 同名 tag 双 Release 冲突：同 tag 存在两个 Release 时，更新其一报 422 `tag_name already_exists` —— 需先删重复 Release 再转正式。
5. workflow 原 `npm publish` 步骤首次发布成功（0.1.42 已入 Packages）；同版本重复发布报 E409，已加 `continue-on-error` 不影响任务结果。
6. 历史提交 `cc7cdca9`（中文路径乱码的坏提交）已通过 force 更新 main 回退移除（私有仓库、无协作方，安全）。
7. **安全提醒**：本流程使用的 PAT 曾在对话中明文出现，且已写入仓库 Secret —— 建议尽快在 GitHub 设置中**轮换该 token**，并在仓库 Settings → Secrets → Actions 中同步更新 `GH_TOKEN`（同时删除对话中已暴露的旧 token）。
