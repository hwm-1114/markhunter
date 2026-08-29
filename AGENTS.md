# AGENTS.md — MarkHunter 工作区指引

MarkHunter（马克猎手）是 Windows 桌面 Markdown/文本编辑器，Electron 43 + CodeMirror 6 + markdown-it + mermaid + Tailwind v4/daisyUI 5 主题引擎。中文注释与文档，无独立 lint/typecheck，靠 `npm run smoke`（真实窗口端到端，179 项）回归。

## 常用命令

```bash
npm install          # 依赖（electron 走 npmmirror 镜像，见 electron-builder.yml）
npm start            # 启动应用（加载的是 src/renderer/dist/bundle.js，不是源码！）
npm run build        # esbuild 打包渲染进程 + mermaid chunk + tailwind.css（改渲染端源码后必须执行）
npm run dev:css      # tailwind watch（调主题样式时用）
npm run smoke        # 冒烟测试（--smoke 模式，仅开发环境；window.__app 测试接口 dev 独有）
npm run release      # 本地打 NSIS 安装包（scripts/release.ps1）；加 -Publish 发 GitHub Releases
```

发布：改 `package.json` 版本 + `CHANGELOG.md` → 打 tag `vX.Y.Z` 推送 → `.github/workflows/release.yml` 自动构建发布。

## 目录结构与构建链路

- `src/main/` — 主进程（CJS）：`main.js`（窗口/CSP/导航防护）、`ipc.js`（文件 IPC + 编码检测）、`security.js`（路径白名单）、`settings.js`（白名单 + DPAPI 加密 + 36 主题清单）、`filewatch.js`（fs.watch + 轮询兜底）、`search.js`/`search-worker.js`（utilityProcess 全局搜索）、`python.js`、`ai.js`（OpenAI 兼容 function calling）。
- `src/preload/preload.js` — contextBridge，只暴露 `window.api.*`（IPC 通道白名单即此文件的镜像，加通道须两端同步）。
- `src/renderer/` — 渲染端（ESM 源码 → esbuild IIFE bundle）：`app.js`（组装入口）、`tabs.js`（标签/CM/大文件分段）、`tree.js`、`preview.js`（markdown/mermaid）、`find.js`/`globalsearch.js`、`python.js`、`ai-panel.js`、`viewer.js`、`favorites.js`、`ui.js`（弹窗/菜单/防抖/CHUNK 标记）。
- 两个 `dist` 勿混淆：`src/renderer/dist/`（构建产物 bundle.js/mermaid-chunk.js/tailwind.css，随 asar 打包）与根目录 `dist/`（electron-builder 安装包输出）。
- 改渲染端源码不重建 = 运行无变化；`npm start` 不自动构建。

## 架构约定与红线

- **安全模型**（v0.1.39 加固，改动前读 docs/MarkHunter三维度评审报告.md）：渲染进程 sandbox + contextIsolation；主进程文件写/删/改名经 `security.js` 的 `requireApproved`（rootDir 内 or 曾成功 read 过的 approvedSet 路径）；`settings:set` 键白名单 + theme 名单校验；AI baseUrl 仅 https 或 http 回环；CSP `script-src 'self'`（新增脚本只能同源注入，参考 preview.js 动态加载 mermaid chunk 的做法）；`fs:write-external` 仅 dev。
- **IPC 契约**：主→渲染事件（`file-changed`、`python:*`、`ai:*`、`search:progress`）与 invoke 通道名都在 preload.js 集中声明；search:global 返回 `[{file,line,text,matchIndex}]` 上限 3000。
- **大文件分段（P7）**：>4MB 文件走 chunked 标签（kind='chunked'），文档尾部有 `<!-- MH-CHUNKED … -->` 占位标记——**任何写盘/预览/AI 读文档路径都必须先 `stripChunkMarkers`（且必要时 `ensureFullyLoaded`）**，否则污染文件。tabs.js `saveNow` 是正确范例。
- **主题**：56 皮肤清单在 settings.js（主进程）与 app.js（渲染端分组）两处维护，需同步；暗色 25 款 = `DARK_THEMES`（特效 fx-* 20 款调色板在 tailwind-input.css、动画在 styles.css「特效皮肤」节）。滚动条宽度修复依赖 `styles.css` 的 `:root{scrollbar-color:auto}`，勿删。
- **mermaid**：lazy 动态加载 `window.__mermaid`，SVG 按 src+明暗 缓存（64 条 FIFO），注入前 `uniquifySvg` 唯一化 id；`renderToken` 协议丢弃过期渲染。
- **文件监听**：`fs.watch` 失败自动回退 `fs.watchFile` 1000ms 轮询；自写识别靠 `markSelfWrite`（写后 stat mtime 一次性匹配）。

## 已知未修问题（2026-08-22 审计，修复后请删条目）

（空 —— 2026-08-22 审计的 5 项 + 验证期新发现的分段保存竞态已在 v0.1.46 全部修复，高频编辑误报外部修改已在 v0.1.47 修复，新建落错位置/树不刷新已在 v0.1.48 修复，明细见 CHANGELOG；修复验证口径：`npm run smoke` 全部通过（v0.2.5 起 179 项），其中 5 项为信息型结果（`detectPython`/`runPython`/`findAll`/`pyUI`/`bundleSplit` 返回携带信息的真值串，非失败）。冒烟窗口运行在真实桌面：偶发外部鼠标点击/负载抖动可能误报 UI 类用例，重跑即可；后台（run_in_background）运行时窗口拿不到焦点，`persistSession` 的 `document.hasFocus()` 守卫会让会话类用例（sessionRestore/pinSessionPersist/extSessionRestore）必然失败 —— 冒烟须前台运行；`largeFileChunk`/`menuPaste*` 已内置自适应轮询与重试。）

## 文档索引（改敏感区前先读）

- `docs/修复计划-Bug与性能排查.md` — 历史编号体系（SB/H/M/L/P/T）与根因证据，CHANGELOG 与代码注释均引用这些编号。
- `docs/多主题改造回归风险与控制-0.1.43.md`、`docs/开发计划-主题引擎映射方案-0.1.43.md` — 主题引擎口径。
- `CHANGELOG.md` — 每版修复清单（搜编号可定位代码注释）。
