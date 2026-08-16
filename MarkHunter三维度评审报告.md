# MarkHunter 三维度评审报告（性能 / 安全 / 产品）

**评审对象**：MarkHunter v0.1.38（Electron 43.3.0，Chromium 150 / Node 24.17），代码位于 `F:\VibeCode\md工具`
**评审范围**：主进程 6 模块、preload、渲染进程 10 模块、构建/发布脚本、electron-builder 配置、package-lock、打包产物（app.asar、NSIS 安装包）
**评审方法**：纯静态代码审查 + 构建产物实测（bundle.js 行级统计、asar/安装包体积）+ `npm audit` 实测 + 公开安全信息核对；未做运行时 Profile（启动耗时实测、typing 性能火焰图可另行补充）

---

## 一、执行摘要

**一句话总评**：MarkHunter 是一款工程纪律与产品细节出色、差异化定位（Python 内嵌运行 + AI function calling）真实存在的本地 Markdown 工作台，但性能上的量级性短板与安全上的结构性缺陷，使其目前处于「好用但未打磨到可放心交付」的阶段。

**三维度得分**：

| 维度 | 得分 | 一句话理由 |
|---|---|---|
| 性能 | **5/10** | 架构有性能意识（文件树懒加载、自动保存防抖、大文件上限、Python 单进程、监听随标签清理），但 9MB 未压缩 bundle、击键三重全量重算、主进程阻塞式全局搜索、大文件全量进出内存 4 个量级性问题拖累整体体验 |
| 安全 | **6/10** | 基础安全项做对（contextIsolation、nodeIntegration:false、CSP、markdown-it `html:false`、mermaid `strict`、npm audit 0 漏洞），但无沙箱、文件 IPC 零路径校验、无导航防护 3 项结构性缺陷，使渲染层一旦被攻破即可直达任意文件读写删 |
| 产品 | **7/10** | 工程纪律出色（51 项真实窗口 E2E）、图片/预览等细节打磨到位、Python+AI 差异化真实成立，但缺导出、定位叙事滞后于能力、文档-代码漂移与编码数据风险在用户首次信任时造成损耗 |

**最需优先处理的 Top 5 问题**（跨维度合并，按严重度×影响排序）：

1. **【安全·高】文件 IPC 无任何路径校验**——`ipc.js` 中写好的 `isInside()` 校验函数从未被调用（死代码），任意路径可读/写/递归删除，`fs:delete` 可 `rm -rf` 任意目录（`ipc.js:13-16,176`、`ipc.js:97-120,159-163`）。
2. **【安全·高】渲染进程未开沙箱 + preload 暴露 14 个裸文件 API**（含测试用 `writeExternal`），XSS 后全盘读写删无阻碍（`main.js:33-38`、`preload.js:3-49`）。
3. **【性能·严重】击键链路三重同步全量重算**：标签栏全量重建 + 预览整篇重渲染（含全部 mermaid）+ 文件内搜索全量重扫，均无防抖（`app.js:44-55`、`tabs.js:308-335`、`preview.js:98-127`、`find.js:104-122`）。
4. **【性能·严重】9.08MB 未压缩单文件 bundle**，mermaid 生态占 67.9%，启动解析慢、常驻内存高，且 mermaid 还冗余打进安装包（`scripts/build.js:5-13`、`preview.js:2-3`、`package.json:27`）。
5. **【安全·高】无任何导航防护**（无 `will-navigate`/`setWindowOpenHandler`），点击恶意链接可将应用窗口导航至本地 HTML、携 preload 权限执行（经典 Electron RCE 链）；`//host` 形式还可触发 UNC/NTLM 凭据泄露尝试（`preview.js:107-113`）。

---

## 二、性能维度评审（5/10）

### 2.1 总体评价

架构层面有不错的性能意识：文件树懒加载、自动保存防抖、大文件上限保护、搜索结果截断、Python 单进程限制、文件监听随标签关闭清理——这些设计是加分的。但代码级核查发现 **4 个量级性性能问题**，集中在三处：

1. **9.08MB 未压缩单文件 bundle**（`minify:false`、无分包），mermaid 生态占 67.9%，且 mermaid 的 node_modules 还会被 electron-builder 冗余打包进安装包；
2. **击键链路无防抖的全量重算**：每次输入触发「标签栏全量重建 + 预览整篇重渲染（含全部 mermaid）+ 文件内搜索全量重扫」，三者同步执行；
3. **全局搜索跑在主进程**，CPU 密集部分（split + 逐行 indexOf）阻塞主进程事件循环，大目录搜索时窗口的保存/树刷新等 IPC 全部排队；
4. **大文件全量进出内存与 IPC**：50MB 上限内文件整体 readFile → TextDecoder → IPC 字符串 → CodeMirror 全量构建，保存时再整篇 `toString()` 走 IPC 写回。

### 2.2 启动性能

- **主进程链路**（`src/main/main.js:90-112`）：`app.whenReady` 后同步注册 7 组轻量 IPC handler → `createWindow` → `loadFile`，本身无性能问题；`loadSettings` 同步读小 JSON（`src/main/settings.js:26-35`）可忽略。
- **瓶颈在 renderer bundle**，实测数据：

| 项目 | 数据 |
|---|---|
| bundle.js 大小 | **9.08 MB**（9,517,909 字节，224,116 行） |
| gzip 后 | 1.73 MB（但 `file://` 加载**不自动解压**，解析成本按原始 9MB 算） |
| mermaid 生态占比 | **67.9%**（152,114 行：mermaid 32.6% + @mermaid-js 14.4% + cytoscape 13.5% + katex 6.5% + cytoscape-fcose 3.4% + d3 系列 3.6% + lodash-es/dagre/dompurify/roughjs 等） |
| codemirror + lezer | 14.2%（31,741 行） |
| markdown-it | 1.8% |
| 应用自身代码 | 约 16%（含 loader 包装） |

- **根因**：`scripts/build.js:5-13` 单入口、`bundle:true`、**`minify:false`**、无分包、无 tree-shaking 目标；`src/renderer/preview.js:2-3` 顶层全量 `import mermaid`（11.16 主入口自动注册 20+ 种 diagram，连带 katex/cytoscape/d3/dompurify 全部依赖）；`app.js` 启动即静态 import 所有模块，`preview.js:17-21` 的 `mermaid.initialize` 在模块求值时执行。
- **影响**：V8 解析约 9MB 未压缩 JS（粗估 300ms–1s+），叠加模块初始化，启动白屏明显；渲染进程常驻多份大字符串。
- **附带发现**：`package.json:27` 把 mermaid 放 `dependencies`，electron-builder 默认打包 production deps（`electron-builder.yml:11-15` 只排除 map），`node_modules/mermaid/dist`（37MB）被**整目录冗余打进 app.asar**——mermaid 已进 bundle.js、运行时根本不需要，这是 111MB 安装包的重要纯浪费。

### 2.3 编辑性能

- **自动保存防抖实现正确**：`app.js:44-48` 每次 `onDocChanged` 先 `clearTimeout` 再 `setTimeout`，默认 800ms（`settings.js:8`，可调 100–10000ms）。✅
- **但同一回调内三重同步全量工作**（`app.js:44-55`）：
  1. `renderTabs()`（`tabs.js:70` 必调）→ `tabs.js:308-335` `innerHTML=''` 后逐 tab 重建 DOM，即使只有 2 个标签，每次击键都销毁重建；
  2. `preview.render()`（`app.js:50-52`，分屏模式每次击键同步调用）→ 见 2.4；
  3. `find.runSearch(true)`（`app.js:54`，有搜索词时每次击键）→ 见 2.4。
- **大文件保护上限正确**：主进程 `ipc.js:97-113` 先 `stat`，超 `maxFileSizeMB`（默认 50，可调 1–2048，`settings.js:7`、`app.js:364-378`）抛 `TOO_LARGE`，前端弹窗提示（`tabs.js:116-119`）。**但上限内是「一次性全量读入」**：`ipc.js:19-30` readFile 全量 Buffer → TextDecoder → IPC 全串 → `tabs.js:134` CM6 全量构建。50MB 文本全部进渲染进程 + IPC 序列化副本 + CM6 文档结构；CM6 对 >10MB 文档已明显掉帧，50MB 时自动保存 `doc.toString()`（`tabs.js:346`）每次生成 50MB 字符串再走 IPC 写盘，GC 与序列化叠加，保存瞬间卡顿不可避免。
- **标签切换**：`tabs.js:163-179` 每次 `switchTab` 都 `view.setState` 重建整个编辑器视图（含 decoration、折叠、测量），大文档切换是 O(文档规模) 的重建。

### 2.4 渲染性能

- **Markdown 预览无防抖/节流，且是整篇重渲染**（`preview.js:98-127`）：每次击键 `md.render` 全文（`preview.js:104-105`）+ `innerHTML` 重建整棵 DOM + 全部 img 重新赋值 src/重新绑定 dblclick（即使 URL 未变）+ `renderMermaid()`。
- **`renderMermaid` 对全部 mermaid 块串行 await 渲染**（`preview.js:69-96`，`for...of` + `await mermaid.render`）；`renderToken` 只能丢弃过期结果防错乱（`preview.js:70,77`），**防不了重复计算**——文档 10 张图时每次击键重算 10 张。
- **文件树懒加载实现正确**：`tree.js:124-142` 展开时才读当前目录一层（`ipc.js:71-94` `readdir withFileTypes`）。小问题：`tree.js:149-154` 的 `select()` 每次点击全量遍历 nodeMap，展开节点多时 O(n)。
- **图片查看器**：CSS `zoom` 属性缩放（`viewer.js:103-131`，GPU 合成代价低），滚轮步进 0.1、范围 50%–500%，实现合理；但**无缩略图**，直接 `file://` 加载原图（`tabs.js:223-228`），超大图（几十 MB PNG）解码内存峰值高。

### 2.5 搜索性能

- **全局搜索在主进程执行，I/O 异步但 CPU 密集部分阻塞主进程**（`src/main/search.js:40-71`）：遍历是异步的（async generator `walk` + await 让步），但每个文件的 `content.split(/\r?\n/)` + 逐行 `indexOf`（`search.js:61-68`）是**同步 CPU 密集代码**，在一个事件循环 tick 内执行；数万文件（含 10MB 上限内大文件）搜索期间主进程事件循环被反复长时间占用，窗口的保存、树刷新、Python 输出转发等**所有 IPC 排队**。
- **无进度事件、无取消机制**（无 AbortController），`maxResults=3000` 截断（`search.js:41,66`）；结果一次性返回，`globalsearch.js:42-89` 一次性创建全部结果 DOM（最多 3000 行），无分页/虚拟滚动。
- **跳过规则是主要性能护栏且合理**：SKIP_DIRS（`search.js:6-9`）、隐藏项跳过（:28）、>10MB 跳过（:18,54）、仅文本扩展名（:11-16）；问题在于**缺文件数/深度的硬上限与取消能力**。
- **文件内搜索**：每次击键触发（`app.js:54`），`find.js:104-122` 的 `collect` 遍历全文档做 `toLowerCase+indexOf`（`find.js:21-35`），然后 `applyHighlights` 重建整个 Decoration 集（:37-45）+ `renderResults` 重建全部结果 DOM（:47-73）——大文件 + 有查询词时每次击键 O(n) 三连，是编辑卡顿的组成部分。

### 2.6 内存与资源

- **文件监听**：`fs.watchFile` 500ms 轮询（`filewatch.js:56`），**每打开一个标签一个轮询**（`tabs.js:137`），关闭标签 `unwatchFile` 清理（`tabs.js:287`），`will-quit` 全停（`main.js:118-120`）——生命周期完整无泄漏；`selfWrites` 每次写入标记 mtime、通知时一次性消费（`filewatch.js:34-42,70-77`）无累积。Windows 上 20+ 标签 = 20 个 500ms stat 定时器，常态开销小但没必要这么频繁。
- **Python 子进程**：`currentProc` 单例——同时最多 1 个，新运行先 kill 旧的（`python.js:151-154`），退出/错误置 null（:171-186）无泄漏；`python:detect` 每次 spawn 3 个探测进程 + 2 个 reg query（:130-144），秒级开销但仅按需。**风险点**：`python.js:165-170` stdout/stderr 每块数据立即 `webContents.send`，无背压无节流——无限 `print` 的脚本形成 IPC 消息洪峰；渲染端逐块建 span + 每次 `scrollTop` 赋值（`renderer/python.js:18-27`，虽有 3000 span 上限防 DOM 无限增长，但防不了 IPC 洪峰与高频 DOM 写）。
- **IPC 数据量与频率**：读文件整串（上限 50MB）经结构化克隆回渲染（`ipc.js:111-112`）；写文件/自动保存整篇 `toString()`（`tabs.js:346-348`→`ipc.js:116-120`）；粘贴图片 ArrayBuffer 经 IPC + `Buffer.from` 再复制一份写盘（`ipc.js:129-136`）；全局搜索最多 3000 条结果一次性返回。
- **AI 对话**（`src/main/ai.js:33-43`）：非流式（一次性 `await resp.json()`），长回复期间 UI 无增量；TOOLS 8 个工具定义每轮重发（`ai.js:8-17,36`）；`history.slice(-10)` 有界（`ai-panel.js:93`）；`search_documents` 工具会触发主进程全局搜索（回到 2.5 的阻塞问题）。性能影响中等偏下。

### 2.7 问题清单

| 严重度 | 问题 | 证据 | 建议 |
|---|---|---|---|
| 🔴 严重 | bundle.js 9.08MB 未压缩未分包，mermaid 生态占 67.9% | `scripts/build.js:5-13`（`minify:false`、单入口）；`preview.js:2-3`（顶层全量 import）；实测 9,517,909 B / 224,116 行 | ① `minify:true`（省约 50%）；② mermaid 改动态 `import()` 拆独立 chunk，首屏只加载 codemirror+app；③ 按 diagram 注册精简入口 |
| 🔴 严重 | 每次击键同步触发：标签栏全量重建 + 预览整篇重渲染 + 文件内搜索全量重扫，均无防抖 | `app.js:44-55`；`tabs.js:70,308-335`；`preview.js:98-127`；`find.js:104-122` | 预览/文件内搜索补 300ms 防抖或 rAF 节流；`renderTabs` 改增量更新 |
| 🔴 严重 | 预览每次击键全文重渲染 + 串行重渲染全部 mermaid（token 只防过期不防重复计算） | `preview.js:98-127,69-96` | 防抖渲染；缓存已渲染 mermaid SVG 按块复用；图多时 `requestIdleCallback` 分批 |
| 🔴 严重 | 全局搜索 CPU 密集段在主进程同步执行，阻塞全部 IPC；无进度/取消；3000 条结果一次性建 DOM | `search.js:40-71,61-68`；`globalsearch.js:42-89` | 移 `utilityProcess`/worker；或每 N 文件 `await` 让出事件循环；加 AbortController；结果分页/虚拟滚动 |
| 🟠 高 | 50MB 上限内文件全量进内存（readFile 全量 → IPC 全串 → CM6 全量构建），大文件编辑+保存重度卡顿 | `ipc.js:19-30,97-113`；`tabs.js:134` | 默认上限降到 10MB 并提示；大文件只读模式；>5MB 自动关闭实时预览/实时搜索 |
| 🟠 高 | 自动保存每次整篇 `toString()` + IPC + 写盘 | `tabs.js:346-348`；`ipc.js:116-120` | 大文件提高防抖间隔或改手动保存确认 |
| 🟠 高 | Python 输出无背压/无节流，无限 print → IPC 洪峰 + 高频 DOM 写入 | `python.js:165-170`；renderer `python.js:18-27` | 主进程按 ~50ms 合并输出块；渲染端批量 append + rAF 后统一滚动 |
| 🟠 中 | electron-builder 把 `node_modules/mermaid`（~37MB）冗余打进安装包 | `package.json:27`；`electron-builder.yml:11-15` | mermaid 移入 devDependencies，安装包可减约 40MB |
| 🟡 中 | 切换标签 `view.setState` 全量重建编辑器视图 | `tabs.js:163-179` | 保持多 EditorView 实例常驻或延迟重建 |
| 🟡 中 | 每标签一个 500ms `fs.watchFile` 轮询（Windows 为 libuv 轮询） | `filewatch.js:56-62`；`tabs.js:137,287` | 改 `fs.watch` 或轮询间隔提到 1-2s |
| 🟡 中 | 大图粘贴/查看：ArrayBuffer 走 IPC + Buffer 复制；原图直载无缩略图 | `ipc.js:129-136`；`tabs.js:223-228` | 粘贴大图先压缩；查看器超大图降采样预览 |
| 🟡 低 | `select()` 全量遍历 nodeMap 切 class；滚动同步每 scroll 事件写对侧 scrollTop | `tree.js:149-154`；`preview.js:171-179` | 缓存上次选中节点；滚动同步 rAF 节流 |
| 🟡 低 | AI 非流式等待、工具定义每轮全量重发 | `ai.js:33-43,36` | 流式（SSE）返回；工具定义静态缓存 |
| ⚪ 低 | 启动即初始化全部模块与 mermaid（无按需）；`sandbox` 未开启 | `app.js:39-80`；`main.js:33-39`；`preview.js:17-21` | 按面板打开时机初始化；`sandbox:true`（安全为主） |

### 2.8 优化优先级

- **短期可做（1–2 天，改动小收益最大）**：① `scripts/build.js` 开 `minify:true`（一行，9.08→~4.5MB，启动解析约减半；gzip 对 `file://` 无效，压缩只能靠 minify）；② 预览渲染 + 文件内搜索加 300ms 防抖（`preview.js:98`、`find.js:104` 入口各包一层 timer，约 20 行）；③ mermaid 移入 devDependencies（一行，安装包减约 40MB）；④ 全局搜索每处理 N 个文件 `setImmediate` 让出事件循环 + 增加取消（`search.js:45` 的 `for await` 内计数让步，`maxResults` 默认降 1000，约 5 行）。
- **中期（1–2 周）**：⑤ mermaid 动态分包（顶层 import 改 `await import('mermaid')`，首屏不再解析 6MB+ mermaid，启动再降 30–50%）；⑥ 增量渲染（mermaid SVG 缓存按块复用、`renderTabs` 增量更新、Decoration 增量合并）；⑦ 全局搜索移 `utilityProcess`，主进程只做 IPC 转发与流式推送；⑧ Python 输出节流（主进程合并 50ms 输出块一次 send，渲染端 DocumentFragment 批量追加）。
- **长期（结构级）**：⑨ 大文件策略重构（默认上限降 10MB；>5MB 只读 + 关闭实时预览/实时搜索；自动保存改手动；保存用 CM6 事务增量 diff 或临时文件+原子替换）；⑩ CodeMirror 精简装配（`tabs.js:60` 的 `basicSetup` 含 26 个扩展，foldGutter/autocompletion/lintKeymap 等大部分用不到，手写精简集可再省 30–50% codemirror 体积）；⑪ AI 流式（SSE）+ 图片查看缩略图/降采样、粘贴图片先压缩。
- **性价比排序（投入/收益）**：minify（1 行）＞ 预览/搜索防抖（20 行）＞ mermaid 移 devDependencies（1 行）＞ 搜索让步事件循环（5 行）＞ mermaid 动态分包（半天）＞ 增量渲染（1–2 天）＞ utilityProcess 搜索（2 天）＞ 大文件策略（3–5 天）＞ codemirror 精简（1 天，需回归测试编辑器行为）。

---

## 三、安全维度评审（6/10）

### 3.1 总体评价

**整体「能用但不够安全」，属于典型的个人/小团队 Electron 工具型应用。** 已做对的基础项：contextIsolation、nodeIntegration:false、CSP meta、markdown-it `html:false` + 默认协议校验、mermaid `securityLevel:'strict'`、无 `shell:true`、npm audit 0 漏洞。但存在 **3 项高危结构性缺陷**：

1. **渲染进程无沙箱**（`sandbox` 未开启），而 preload 暴露了**不带任何路径校验的裸文件系统 API**（读/写/删/改名/建目录/读目录树全部任意路径）；
2. **文件 IPC 完全没有根目录限制**——代码里写好的 `isInside()` 校验函数从未被调用（死代码），任何能调用 `window.api` 的代码（XSS、恶意本地 HTML 在应用窗口内导航）即可**读取、覆写、递归删除用户磁盘上任意文件**；
3. **无任何导航防护**（无 `will-navigate`、无 `setWindowOpenHandler`），且 `writeExternal` 这个「测试用」写文件 API 被原样暴露在生产 preload 里。

叠加 AI 工具 `open_file` 的 `../` 路径穿越（`app.js:137`）、API Key 明文存储、Python 解释器路径不受校验、安装包未签名等中危项——**一旦用户用本应用打开一个恶意 Markdown 文档并触发渲染层代码执行，攻击链可直达「任意文件读写删 + 任意可执行文件运行」**。

### 3.2 渲染进程隔离（webPreferences / CSP / preload 暴露面）

| 检查项 | 状态 | 证据 |
|---|---|---|
| contextIsolation | ✅ 已开启 | `src/main/main.js:35` |
| nodeIntegration | ✅ 已关闭 | `src/main/main.js:36` |
| sandbox | ❌ **未开启**（默认 false，未调 `app.enableSandbox()`） | `src/main/main.js:33-38`（webPreferences 仅 preload/contextIsolation/nodeIntegration/spellcheck 四项） |
| webSecurity | ⚠️ 依赖默认 true，未显式设置 | `main.js:33-38` |
| webviewTag | ✅ 默认 false，未启用 | 全局无 webview |
| CSP | ⚠️ 有 meta CSP 但偏松 | `index.html:5`：`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; script-src 'self'` |
| 导航/弹窗防护 | ❌ **缺失**：无 `will-navigate`、无 `setWindowOpenHandler` | 全局 grep 无匹配；`main.js:44-49` 仅 `did-finish-load` |
| preload 暴露面 | ❌ **过大** | `preload.js:3-49` 暴露约 25 个 API，其中文件操作类 14 个 |

**CSP 分析**：`default-src 'self'` 使 `connect-src` 默认为 'self'——渲染进程无法直接发外部请求（全源码确认渲染进程无 fetch/XMLHttpRequest/WebSocket，唯一 fetch 在主进程 `ai.js:33`），**显著压缩 XSS 横向面，是亮点**。但缺 `object-src 'none'`、`base-uri 'none'`、`frame-ancestors`；`img-src` 含 `file:`（允许加载任意本地文件为图片）；`style-src` 带 `unsafe-inline`（mermaid/CodeMirror 需要，可接受）；`img-src` 不含 `https:`（外链图被拦截——隐私友好，功能上是取舍）。

**preload 暴露面逐一评估**（`src/preload/preload.js`）：

| API | 风险 |
|---|---|
| `readFile`(:11) / `writeFile`(:12) / `remove`(:21) / `rename`(:22) / `create`(:20) / `readTree`(:10) / `stat`(:15) | **高危**：参数为任意路径字符串，主进程 handler 完全不校验（见 3.3） |
| `writeExternal`(:13) | **高危且冗余**：标注「测试用」（`ipc.js:123-126`），是 `writeFile` 的无标记版本，纯属多余攻击面 |
| `writeBinary`(:14) | 中：有扩展名白名单（`ipc.js:131`），但路径任意，白名单外扩展名可被 `writeFile` 绕过 |
| `watchFile`/`unwatchFile`(:17-18) | 低：对任意路径轮询 stat，可被用于探测文件存在性 |
| `copyImage`(:16) | 低：任意路径以图片读入剪贴板 |
| `runPython`(:33) / `detectPython`(:32) | 高（配合渲染进程被攻破）：解释器路径来自渲染进程，未校验 |
| `aiChat`(:43) | 中：透传 apiKey/baseUrl，密钥进入渲染进程内存 |
| 事件订阅(:19,35-37,40,46-48) | 低：只读事件 |

### 3.3 文件系统安全（ipc.js / settings.js / filewatch.js）

**核心问题：所有文件 IPC 均无路径约束。**

- `ipc.js:8-10` 定义 `normalize()`，`ipc.js:13-16` 定义 `isInside(root, target)`（防目录穿越），`ipc.js:176` 导出——**但全项目没有任何调用点**（grep 确认仅定义处出现），是明显的「写了校验但没接上」。
- `fs:read-file`（`ipc.js:97-113`）：任意路径 + 仅大小上限（默认 50、设置可放宽到 2048MB），**无根目录/扩展名/符号链接限制**。
- `fs:write-file`（`ipc.js:116-120`）：**任意路径任意内容覆写**，无白名单。
- `fs:delete`（`ipc.js:159-163`）：`fsp.rm(target,{recursive:true,force:true})`——**可递归删除任意目录**（含用户主目录级），前端仅有一个 confirm 弹窗。
- `fs:rename`（:166-173）、`fs:create`（:145-156，parentDir 任意）、`fs:stat`（:139-142）、`fs:read-tree`（:71-94）、`fs:watch-file`（`filewatch.js:80-87`）：路径全部任意。
- **路径穿越 `../`**：主进程不校验，`path.resolve` 后任何 `..` 都能跳出工作目录；符号链接/目录 junction 未被 `realpath` 解析。
- `fs:create`/`fs:rename` 对文件名做了字符清洗（`ipc.js:146,167`），但那是防非法文件名字符，不是路径安全。
- `settings:set` 接受任意 patch 且 `Object.assign(s, patch)`（`settings.js:39,56`）——无 key 白名单；`__proto__` 键可改变 settings 对象原型（影响有限，低危）。
- **正面项**：`fs:read-file` 有大小上限（`ipc.js:100-110`）；`fs:write-binary` 有扩展名白名单（`ipc.js:131`）；写入后 `markSelfWrite` 防监听误报（`ipc.js:118`）。

**settings.json**（`settings.js:22-24` → `%APPDATA%\markhunter\settings.json`）：含 `pythonPath`、`maxFileSizeMB`、`aiApiKey`（**明文**，`settings.js:13,43`；`app.js:450` 设置界面自述「API Key 明文保存在本机 settings.json」）、`aiBaseUrl`、`aiModel`、`lastDirectory`——任何能读 `%APPDATA%` 的本地进程/恶意软件可直接拿走 API Key。

### 3.4 外部内容安全（Markdown 预览 / 链接 / 图片 / mermaid / HTML 注入点）

- **markdown-it `html:false`**（`preview.js:8`）——原始 HTML 被转义，`<script>` 注入被阻断；默认 `validateLink` 拦截 `vbscript:/javascript:/file:/data:`（`markdown-it/lib/index.mjs:31-39`）；渲染结果经 `contentEl.innerHTML = html`（`preview.js:105`）插入——两层防护之下当前**无直接 XSS 路径**。
- **外链处理**：仅对 `http(s)` 链接设 `target="_blank"` + `rel="noopener noreferrer"`（`preview.js:107-113`）。**没有 `shell.openExternal`**（全项目无此调用），也没有 `setWindowOpenHandler` → `target=_blank` 由 Electron 默认行为创建新窗口（webPreferences 继承自父窗口），**不受控**。
- **相对链接/协议相对链接**：点击后在**应用主窗口内导航**（无 `will-navigate` 拦截）。markdown-it 虽拦 `file:`，但 `//evil.com/x.html`（协议相对）与 `../x.html`（解析到 app 自身目录）能通过校验；`//host` 形式在 file: 页面上被解析为 UNC 路径 `\\host\...`，可触发 SMB/NTLM 凭据泄露尝试。**若应用窗口被导航到任意本地 HTML，该页面将携带与主页面相同的 preload 权限执行——经典 Electron RCE 链，目前完全无防护。**
- **图片**：`resolveImgSrc`（`preview.js:27-44`）对相对路径做 `..` 段钳制（`parts.pop()`，无法逃出 md 所在目录），但 `http(s)/data:/file:` 前缀原样返回；CSP `img-src` 无 `https:` 使外链图实际被拦。远程资源加载被 CSP 限制，主进程 AI fetch 不受 CSP 管辖（见 3.6）。
- **mermaid**：`securityLevel:'strict'`（`preview.js:20`）+ 版本 11.16.1（已含 CVE-2025-54880/54881 XSS 修复，修复版 11.8.0）；`wrap.innerHTML = svg`（`preview.js:80`）与查看器 `el.innerHTML = svgHtml`（`viewer.js:49`）由 DOMPurify 兜底，当前可控。
- **其它 innerHTML 注入点全查**：tree.js 文件名全部 `textContent`（`tree.js:67-76`）；全局/文件内搜索高亮均先 `escapeHtml` 再拼 `<mark>`（`globalsearch.js:91-105`、`find.js:75-89`）；`viewer.js:78-84` 信息栏路径 `esc()`；`app.js:344-348` 的 `pyHint.innerHTML` 对解释器路径 `escapeHtml`——**均无注入**。AI 面板消息用 `md.render`（`ai-panel.js:60`），`html:false` 且链接无 target 处理（点击会导航主窗口，与上文同源问题）。
- **PDF**：`<embed type="application/pdf">` 加载任意本地 PDF（`tabs.js:98,214-221`），PDF 内嵌 JS 在 PDFium 沙箱中执行（低危，建议关注）。

### 3.5 Python 执行（python.js + renderer/python.js）

- **正面**：`spawn(interpreter, [filePath])`（`python.js:157`）参数为数组、无 `shell:true`，文件名中的特殊字符不会被 shell 解释。
- **但存在 4 个问题**：
  1. **解释器路径完全由渲染进程提供**（`python.js:150` `const interpreter = pythonPath || 'python'`），`pythonPath` 来自设置（`settings.js:6`），而 `settings:set` 不校验 → 可被设为**任意可执行文件**（如 powershell.exe），配合 `filePath` 传入任意文件即任意代码执行；渲染进程 `runPython`（`renderer/python.js:81`）只透传。
  2. **filePath 无扩展名校验**：主进程只检查文件存在（`python.js:149`），`.py` 判断仅在前端（`renderer/python.js:61`）——纵深防御缺失。
  3. **无 `--` 结束选项符**：若脚本文件名以 `-` 开头（如 `-i`、`-c`），会被 Python 当作选项解析（`python.js:157`）。
  4. **kill 只杀直接子进程**（`python.js:191-197` `currentProc.kill()`）：Windows 上脚本再派生的子进程（os.system、multiprocessing 等）会**成为孤儿进程继续运行**，无 `taskkill /T` 或进程树清理。
- 运行任意 `.py` = 任意代码执行是该功能**设计使然**（用户主动点击「运行」），缓解措施只能是：主进程校验解释器为 `python*.exe`、限制脚本在 rootDir 内、提供进程树终止、运行前再次确认。

### 3.6 AI 功能（ai.js + ai-panel.js + app.js 工具执行）

- **请求路径**：渲染进程 `aiChat` → IPC → 主进程 `fetch`（`ai.js:33`）→ 远端。请求确实走主进程，但 `apiKey`、`baseUrl`、`model` 全部由渲染进程在 payload 中传入（`ai-panel.js:121-126`），即**密钥存在于渲染进程内存**，且渲染进程持有明文（从 `settings:get` 取回）。
- **密钥存储**：明文 `settings.json`（见 3.3），未用 `safeStorage` 加密。
- **baseUrl 无校验**：`ai.js:25` 仅做尾部 `/` 去除后拼接 `/chat/completions`，**未强制 https、未校验主机**——密钥经 `Authorization: Bearer`（`ai.js:35`）发往任意 baseUrl；若用户被诱导填入恶意「服务地址」或 settings.json 被篡改，密钥+文档内容直送攻击者；`http://` 明文传输同样可能。
- **数据出网**：文档全文（「全文」按钮 `ai-panel.js:221`、`read_document` 工具）、选中文字、全局搜索命中片段（`search_documents` 工具 `app.js:112-117` 把 `file:line:text` 回传给模型）都会发送到 AI 服务商——**功能设计使然，但界面无显著隐私提示**。
- **工具执行与确认**：修改类工具（replace/insert/create_file/create_dir）受 `aiAskBeforeApply`（默认 true）门控（`app.js:147-152`）；但**只读工具 `open_file`、`search_documents` 无确认**，且 `open_file` 存在**路径穿越**：`state.rootDir + '\\' + args.name`（`app.js:137`）不清理 `..`，AI 可打开 rootDir 之外的任意文件（如 `%APPDATA%`、`.ssh`）——配合 prompt injection（恶意文档内容诱导模型）→ `read_document` 读取 → 经 AI 接口出网，构成**数据泄露链**。
- **正面项**：`ai:chat` 有 12 轮工具循环上限（`ai.js:32`）、`AbortController` 可中止（`ai.js:26,37`）、工具 schema 固定由主进程声明（`ai.js:8-17`）。

### 3.7 数据与隐私 / 供应链与发布

- **settings.json 明文**（见 3.3）；`clipboard:write-image`（`main.js:99-105`）读取任意路径图片写入剪贴板——低危（需先有代码执行）。
- **文件监听**：`fs.watchFile` 轮询（500ms，`filewatch.js:56`）+ mtime 精确匹配自写标记（`filewatch.js:33-42`）机制合理；`onFileChanged` 自动重载或询问（`tabs.js:490-536`），dirty 时先确认，无安全风险。
- **全局搜索**（`search.js:40-71`）递归读任意文本文件内容（含 `.ps1/.bat/.sh/.py`），10MB 上限、目录黑名单（`search.js:6-9`）——只读无执行，低危。
- **npm audit（官方 registry）**：**0 漏洞**（455 个依赖，prod 111 / dev 344）✅。
- **Electron 43.3.0**（Chromium 150 / Node 24.17）：当前受支持的最新稳定线，43.3.0 为补丁版本，未见未修复高危 CVE；需持续跟进 [Electron Releases](https://releases.electronjs.org/schedule)。
- **mermaid 11.16.1**：已高于 XSS 修复版 11.8.0（[CVE-2025-54880](https://advisories.gitlab.com/pkg/npm/mermaid/CVE-2025-54880/)、[CVE-2025-54881](https://advisories.gitlab.com/pkg/npm/mermaid/CVE-2025-54881/) 均已在 11.8.0 修复），且应用启用 `securityLevel:'strict'`——**不受上述两个已知 XSS 影响**。
- **NSIS 安装包未签名**：electron-builder.yml 全文无 `win.sign`/certificate 配置 → 无 Authenticode 签名 → 安装时 SmartScreen 红色警告、发布物无法验证完整性（篡改检测/供应链投毒防护缺失）。
- **打包体积与攻击面**：`app.asar` 65.84MB，内含**完整 node_modules（6869 个文件）**——尽管渲染代码已被 esbuild 打包进 `dist/bundle.js`（9.5MB、`minify:false`，`build.js:12`），生产包仍冗余携带整个 mermaid 依赖树（d3/marked/katex 等），放大供应链审计面与体积；`files`（`electron-builder.yml:11-15`）未排除 node_modules。
- **发布脚本**（release.ps1）从 npmmirror 拉取 Electron 二进制（`release.ps1:54-55`），与 package-lock 的 resolved 一致（均指向 npmmirror）——镜像被投毒则供应链受影响，属通用风险。
- `asar` 完整性：Windows 下 electron-builder 默认无 asar integrity 校验配置。

### 3.8 风险清单

| 严重度 | 风险 | 证据（文件:行号） | 影响 | 修复建议 |
|---|---|---|---|---|
| **高** | 渲染进程未开沙箱，XSS 后 preload 全 API 可用 | `main.js:33-38`（无 `sandbox`、无 `app.enableSandbox()`） | 渲染层任意代码执行可直接调用裸路径文件 API → 全盘读写删 | 开启 `sandbox:true`（或 `app.enableSandbox()`）；preload 只保留最小 API；Node 侧能力全部收口到主进程 |
| **高** | 文件 IPC 无根目录/路径校验，`isInside()` 写了但从未使用 | `ipc.js:13-16,176`（定义导出）；`ipc.js:97-120`（read/write 无校验）；`ipc.js:159-163`（`rm recursive` 删任意目录） | 任意路径读取/覆写/递归删除；`../`、符号链接、UNC 路径全不设防 | 主进程强制「当前工作目录」白名单：`path.resolve`+`realpath` 后 `isInside(root,target)`，拒绝逃逸；`fs:delete` 限 rootDir 内并二次确认 |
| **高** | preload 暴露面过大，且测试 API `writeExternal` 进入生产 | `preload.js:13`；`ipc.js:123-126` | 多余的高权限写文件入口，放大一切渲染层漏洞后果 | 删除 `writeExternal`；preload 文件 API 改「相对 rootDir 的路径参数」或 token 化设计 |
| **中** | 无 `will-navigate` / `setWindowOpenHandler` 导航防护 | 全项目无匹配；`preview.js:107-113`（仅设 target=_blank）；`ai-panel.js:60`（AI 消息链接无处理） | 点击恶意/诱导链接可在应用窗口内导航至本地 HTML（携 preload 权限执行，RCE 链）或外部站点；`//host` 触发 UNC/NTLM 泄露 | `setWindowOpenHandler`：http/https 用 `shell.openExternal`，其余 `deny`；`will-navigate`：仅允许 `file://...index.html`，其余 `preventDefault` |
| **中** | AI API Key 明文存储 + 回传渲染进程 | `settings.js:13,43`；`app.js:450`（自述明文）；`ai-panel.js:121-126` | 本机恶意进程可读 settings.json 窃取密钥；渲染层 XSS 直接拿到密钥 | 主进程 `safeStorage` 加密存储；`settings:get` 只回掩码，密钥仅存主进程，`ai:chat` 主进程注入 |
| **中** | AI baseUrl 不校验协议/主机，密钥随请求发出 | `ai.js:25`（URL 拼接无校验）；`ai.js:33-38`（Bearer 头） | 密钥+文档内容发往任意（含 http 明文）端点 | 强制 `https://`；非白名单主机弹确认；至少拒绝 `http://` |
| **中** | AI 工具 `open_file` 路径穿越 + 只读工具无确认 | `app.js:135-140`（`rootDir + '\\' + name` 无清洗）；`app.js:147-152`（确认仅覆盖修改类工具） | prompt injection → 读取 rootDir 外任意文件 → `read_document` → 出网 | 拒绝 `..` 段；`open_file` 限 rootDir；只读工具也纳入确认或显式白名单 |
| **中** | Python 解释器路径不受校验（settings:set 可写任意 exe）+ 无 `--` 分隔 + 无 .py 校验 | `python.js:150,157`；`settings.js:56`；`python.js:149`（仅查存在） | 渲染层被攻破后直接任意代码执行；文件名以 `-` 开头被当作 Python 选项 | 主进程校验解释器为 `python*.exe`（名称+存在性）；加 `--`；校验 `.py` 扩展名与 rootDir 归属 |
| **中** | Python kill 只杀直接子进程，进程树残留 | `python.js:191-197`（`currentProc.kill()`） | 脚本派生的子进程成孤儿继续运行（僵尸/资源占用） | Windows 用 `taskkill /pid <pid> /T /F` 或 tree-kill 库 |
| **中** | NSIS 安装包未签名 | electron-builder.yml（全文无 sign 配置）；`dist/MarkHunter-Setup-0.1.38.exe` | SmartScreen 红屏警告、发布物可被篡改、供应链信任缺失 | 配置 OV/EV 代码签名证书；未签名期间在 README 显著说明并附 SHA256 校验值 |
| **中** | 生产包冗余携带完整 node_modules（6869 文件，asar 65.8MB） | `dist/win-unpacked/resources/app.asar`；`electron-builder.yml:11-15` | 供应链审计面扩大、体积膨胀（bundle.js 本身 9.5MB 且未压缩） | `files` 排除 node_modules（运行时不 require 外部包）；esbuild 开 `minify:true` |
| **低** | CSP 偏松：`img-src` 含 `file:`、缺 `object-src 'none'`/`base-uri 'none'` | `index.html:5` | 本地文件可被当作图片加载探测；base 标签（当前无注入面） | `img-src 'self' data:`（需要外链图再加 `https:`）；加 `object-src 'none'; base-uri 'none'` |
| **低** | PDF 以内嵌 viewer 打开任意本地 PDF | `tabs.js:98,214-221` | PDF 内嵌 JS 在 PDFium 沙箱内执行（当前低危，历史上偶有漏洞） | 保持 Electron 升级；对来源不可信 PDF 提示风险 |
| **低** | `settings:set` 无 key 白名单 + `Object.assign` 可改原型 | `settings.js:39,56` | 可写入任意设置键；`__proto__` 改 settings 对象原型（影响有限） | patch 按键白名单过滤 |
| **低** | `window.__app` 暴露全部内部模块 | `app.js:634` | 扩大 XSS 后的可利用面 | 生产构建移除或仅暴露只读接口 |
| **低** | 开发测试启动开关（--smoke/--mmtest/--exttest/--carettest） | `main.js:52-83` | 打包后 require 失败被 catch（scripts 未入包），仅开发环境风险 | 保持 scripts 不入包即可；必要时 gated by `!app.isPackaged` |
| **信息** | 文档内容经 AI 功能默认出网（全文/搜索片段回传） | `ai-panel.js:221`；`app.js:112-117` | 隐私：用户文档发送至 DeepSeek 等服务商 | 首次启用 AI 时显著告知数据出网范围；提供「文档内容不随 AI 发送」开关 |

**正面项（已做对的）**：contextIsolation + nodeIntegration:false ✅；CSP meta + 渲染进程无网络出口（connect-src 默认 'self'，唯一 fetch 在主进程）✅；markdown-it `html:false` + 默认协议校验（javascript:/vbscript:/file:/data: 拦截）✅；mermaid `securityLevel:'strict'` + 版本已修复已知 XSS ✅；搜索高亮/文件名渲染全部 `escapeHtml`/`textContent` ✅；spawn 无 `shell:true`、参数数组 ✅；`fs:read-file` 大小上限、`write-binary` 扩展名白名单 ✅；`fs:create/rename` 文件名清洗 ✅；npm audit 0 漏洞、Electron 43.3.0 为当前受支持最新线 ✅。

### 3.9 加固优先级

- **🔴 必须立即做（下个版本内，0 成本高收益）**：
  1. **文件 IPC 根目录白名单**——把 `ipc.js` 里现成的 `isInside()` 接上用：所有 `fs:*` handler 在 `path.resolve`+`fs.realpath` 之后校验目标在「当前工作目录」内，拒绝 `..`/符号链接逃逸；`fs:delete` 额外限制为 rootDir 子树。
  2. **删除 `writeExternal`**（`preload.js:13` / `ipc.js:123-126`），整体收窄 preload——文件操作只暴露「基于当前 rootDir 的相对路径」接口。
  3. **开启 `sandbox:true`**（`main.js:33-38`）+ 验证 preload 在沙箱下正常（本项目 preload 恰好只用 contextBridge/ipcRenderer，**改动成本极低**）。
  4. **补导航防护**：`setWindowOpenHandler`（http/https → `shell.openExternal`，其余 deny）+ `will-navigate` 拦截非 index.html 的导航。
  5. **AI Key 移出渲染进程**：settings.json 用 `safeStorage` 加密存 key，`settings:get` 只回掩码，`ai:chat` 主进程注入 key；`ai.js:25` 强制 `https://`。
- **🟡 短期（1-2 个版本）**：⑥ AI 工具加固（`open_file` 拒绝 `..`、限 rootDir（`app.js:137`）；只读工具加确认/白名单；prompt injection 系统提示防御与工具参数校验）；⑦ Python 运行加固（主进程校验解释器名 `python*.exe` 与脚本 `.py` 扩展名、rootDir 归属；spawn 加 `--`；kill 改 `taskkill /T /F` 进程树终止）；⑧ CSP 收紧（`img-src` 去 `file:`，加 `object-src 'none'; base-uri 'none'`）；⑨ `settings:set` 按键白名单；生产构建移除 `window.__app`。
- **🟢 中期（发布策略/工程化）**：⑩ 代码签名（OV 起步，EV 更好），未签名前发布说明附 SHA256 并提供校验脚本；⑪ 瘦身供应链（`files` 排除 node_modules、bundle 开 `minify`，缩小 asar 与审计面）；⑫ 持续更新基线（订阅 Electron 安全公告、mermaid 等渲染库保持最新、每次发版跑官方 registry 的 `npm audit`——当前镜像 npmmirror 不支持 audit 接口）；⑬ 隐私透明化（AI 首次使用弹窗说明「文档全文/搜索片段将发送至 {baseUrl}」并提供关闭项）。

---

## 四、产品维度评审（7/10）

### 4.1 产品总览与定位

**一句话定位**：一款「简约清新」的 Windows 桌面本地 Markdown/文本编辑器，主打 文件夹工作区 + 多标签 + 自动保存 + Markdown/mermaid 预览，叠加 Python 运行与 AI 对话两个差异化能力（`README.txt:6-8`、`package.json:5`）。

**目标用户**（从功能反推）：中文个人知识工作者、轻量脚本调试者、写作/笔记用户——需要「打开一个文件夹就能干活、不用配置、所见即所得、写完即存」的人群，而不是要完整 IDE 或知识库体系的深度用户。

**品牌与调性**：品牌语「执笔即江湖，所写皆锋芒」（`package.json:5`）有辨识度；界面是统一的浅色清新风格（`styles.css:2-17` 单一 `:root` 浅色变量体系），视觉完成度高，明显优于大多数自研 Electron 工具。UI 细节诚意足：空状态插画（`index.html:70-74`）、拖拽式分隔条（`ui.js:157-203`）、预览缩放徽标（`preview.js:194-201`）、品牌渐变按钮（`styles.css:99-105`）。

**差异化定位是否成立**：
- **成立的部分**：「Python 一键运行（自动探测解释器 + 内嵌分色输出 + 可终止）」（`src/main/python.js:130-197`、`src/renderer/python.js`）在 Markdown 编辑器品类里几乎没有对手（VSCode 太重、Notepad++ 需配置）；「AI 助手 + function calling 直接读写文档/建文件/搜索」（`src/main/ai.js:8-17`、`app.js:83-144`）也是开箱即用级（Obsidian/VSCode 需装插件配密钥）；图片「粘贴即存同目录并插入引用」（`tabs.js:418-444`）对齐 Typora 体验。
- **不成立/模糊的部分**：与 Typora 相比缺「所见即所得」与导出；与 Obsidian 相比缺知识库、双向链接、插件、同步；与 VSCode 相比功能面不在一个量级。它在「文件夹型文本工作台（写作 + 脚本 + AI 辅助）」这个细分位上站得住，但 README 只把它描述成「简约清新文本编辑工具」，**定位叙事没有把 Python/AI 这两个真正差异点讲出来——产品有差异化，定位表述没跟上**。

**关键工程事实**：Electron ^43.3.0 + esbuild + CodeMirror 6 + markdown-it + mermaid（`package.json:16-28`）；前端 bundle.js 9.08MB（**未压缩**，`build.js:11-12 minify:false`）；安装包 111.4MB（`dist/MarkHunter-Setup-0.1.38.exe`）；MIT 协议（`package.json:15`，**但根目录无 LICENSE 文件**）；无 repository/homepage/bugs 字段（package.json 全文），即**没有任何对外主页/仓库入口**。

### 4.2 功能亮点与缺口

| 能力 | 现状（证据） | 评价 |
|---|---|---|
| 文件树浏览 | 懒加载、图标、大小显示、新建/重命名/删除/刷新（`tree.js:14-282`；`ipc.js:71-94`） | ✅ 亮点：删除有原生确认（`tree.js:235-250`）、重命名后联动已开标签（`app.js:215-229`） |
| 多标签编辑 | CM6，未保存圆点、Ctrl+Tab 循环、关闭即保存（`tabs.js:163-333`） | ✅ 亮点：每标签独立状态与撤销历史；⚠️ 关闭标签**静默保存**而非询问（`tabs.js:279-283`），与「点 ✕=丢弃」直觉相反，需产品上明确 |
| 自动保存 | 防抖 800ms 默认、间隔可调（`app.js:44-55`；`settings.js:8`） | ✅ 亮点 |
| Markdown 预览 | 编辑/分屏/仅预览三态、Ctrl+B 切换、滚动跟随、Ctrl+滚轮缩放、mermaid 渲染（`preview.js:61-242`） | ✅ 亮点：mermaid 双击进查看器、渲染失败有错误块（`preview.js:88-94`）；⚠️ 每键实时全量重渲染无防抖（`app.js:50-52`） |
| 文件内搜索 | 底部面板一次列全部匹配、点击跳转、编辑器高亮（`find.js:20-145`） | ✅ 好用；❌ **无「替换」功能**——编辑器没有 Find&Replace 是明显缺口 |
| 全局搜索 | 按文件分组、点击打开定位并联动文件内搜索高亮（`globalsearch.js:12-116`；`app.js:279-288`） | ✅ 亮点：交互闭环完整；⚠️ 串行扫描无进度/取消（`search.js:6-16` 跳过隐藏与构建目录） |
| 图片能力 | 文件树查看、标签页缩放/平移/复制、详情查看器、粘贴即存（`tabs.js:98-277`；`viewer.js:34-207`） | ✅ 突出亮点：细节打磨到「放大后左右边缘可完整滚动」（`smoke.js:276-314`） |
| Python 运行 | 探测（PATH/注册表/常见路径）、内嵌输出分色、退出码/耗时、可终止（`python.js:130-197`） | ✅ **最强差异化**；⚠️ kill 只杀直接子进程（`python.js:192-194`） |
| AI 对话 | OpenAI 兼容、DeepSeek 预置、function calling 8 工具、写入前确认（`ai.js:8-101`；`app.js:83-152`） | ✅ 差异化亮点：读全文/改文档/建文件/搜索闭环；❌ **非流式**——生成期间只有「（思考中…）」，「■停止」形同虚设（`ai-panel.js:100-137`；`preload.js:47-48` 的 onAiChunk/onAiDone 是死 API） |
| 设置面板 | 解释器/大文件上限/保存间隔/换行/滚动条宽度/AI 配置（`app.js:303-503`） | ✅ 合理；❌ 无字体/字号/主题设置 |
| 大文件保护 | 默认 50MB、上限可调 1~2048（`ipc.js:97-113`；`settings.js:7`） | ⚠️ 默认值合理，但上限 2048MB 是**内存陷阱**：整文件读入内存 + TextDecoder + 结构化克隆，2GB 文本必然 OOM（`ipc.js:111-112`） |
| 发布流水线 | release.ps1 一键 版本递增→安装→构建→打包，国内镜像加速（`release.ps1:23-57`） | ✅ 工程化亮点；❌ 无签名、无自动更新渠道 |
| 安全基线 | contextIsolation:true、nodeIntegration:false（`main.js:33-38`）、CSP（`index.html:5`）、markdown-it `html:false`（`preview.js:8`）、mermaid `securityLevel:'strict'`（`preview.js:20`） | ✅ 达标；⚠️ **未开 sandbox**；⚠️ `ipc.js:13-16` 的 `isInside()` 路径校验**定义后从未被任何 handler 调用**，防目录穿越是纸面防线 |

**明显缺失**（按用户价值排序）：导出 PDF/HTML（❌ 写作类工具无导出=无法交付）、Find&Replace、目录大纲/TOC、字数统计（仅有总字符数，`tabs.js:208`）、多主题/深色、Markdown 语法提示与工具栏、任务列表 checkbox（`styles.css:1022` 有 `.task-list-item` 样式但 markdown-it 未启用 task-lists 插件，属于死样式）、预览代码高亮（无 highlight.js）、数学公式 KaTeX、会话/标签恢复（重启只恢复目录，`app.js:628-631`）、文件关联（双击 .md 不打开 MarkHunter，installer.nsh 只注册了目录右键菜单）、插件体系、云同步、加密、跨平台。

### 4.3 竞品对比

| 维度 | MarkHunter | Typora | Obsidian | VS Code | Notepad++ / Joplin |
|---|---|---|---|---|---|
| 定位 | 文件夹型轻量文本工作台 | 所见即所得写作 | 知识库/双链笔记 | 通用 IDE | 纯文本工具 / 同步笔记 |
| Markdown 预览 | ✅ 分屏+仅预览+mermaid | ✅ WYSIWYG | ✅ | ⚠️ 需插件 | ❌ / ✅ |
| 图片粘贴即存 | ✅（`tabs.js:418-444`） | ✅ | ⚠️ 需配置附件方式 | ⚠️ 需插件 | ❌ |
| Python 内嵌运行 | ✅ 开箱即用（python.js） | ❌ | ❌ | ✅ 但重 | ⚠️ Notepad++ 可配 |
| AI 集成 | ✅ 内置 function calling 改文档 | ❌ | ⚠️ 插件 | ⚠️ 插件 | ❌ |
| 导出 | ❌ | ✅ PDF/HTML/Word | ✅ PDF | ✅ | ❌ / ✅ |
| 插件体系 | ❌ | ⚠️ 有限 | ✅ 强大 | ✅ 强大 | ✅ / ✅ |
| 跨平台 | ❌ Windows only | ✅ | ✅ | ✅ | ✅ |
| 同步/加密 | ❌ | ✅ iCloud | ⚠️ 插件 | ❌ | ❌ / ✅ E2E |
| 免费/协议 | ✅ MIT 免费 | ❌ ¥89 | ✅ 个人免费 | ✅ 免费 | ✅ / ✅ |
| 安装包 | 111MB 未签名 | ~100MB | ~100MB | ~150MB | 数 MB |

**结论**：MarkHunter 不与任何主流产品正面竞争，而是占据「**本地文件夹 + 写作/脚本 + AI 辅助**」的交叉空位，这个位子在中文个人开发者/知识工作者群体里真实存在（Typora 付费、Obsidian 重体系、VSCode 重配置）。但**出口缺失（无导出）与入口缺失（无文件关联、无主页）**让它既难交付内容，也难被找到。

### 4.4 用户体验与可用性评价

**做得好（值得肯定）**：
- 交互闭环完整：全局搜索点击→打开文件定位行→联动文件内搜索高亮（`app.js:279-288`；`smoke.js:490-504`）；外部修改自动重载且**保留光标与滚动位置**（`tabs.js:508-527`；`filewatch.js:56-61` 轮询 + self-write mtime 去误报，`ipc.js:118`）。
- 细节党：光标失焦半透明常显（`styles.css:429-435`）、预览滚动跟随可双击暂停（`preview.js:169-186`）、分隔条双击恢复等分（`ui.js:193-202`）、拖文件进窗口即开（`app.js:561-588`）、Python 输出超 3000 节点自动裁剪（`python.js:19-21`）。
- 错误处理有基本盘：打开失败/过大有弹窗（`tabs.js:113-124`）、写失败状态栏提示（`tabs.js:352-354`）、Python 启动失败/异常分色展示（`python.js:40-52, 82-85`）、AI 未配置 Key 有引导（`ai-panel.js:104-107`）。

**可发现性 / 学习成本问题（重要）**：
1. **「双击 Shift 全局搜索」已删除但文案没删**：代码里只有 Ctrl+Shift+F（`app.js:591-626`），`smoke.js:446-453` 专门断言「双击 Shift 不再触发」，但 `README.txt:59`、`index.html:24`、`index.html:52` 仍写着「双击 Shift」——**用户照 README 操作会发现功能不存在**，最典型的文档-实现漂移。
2. **README 声称 39 项冒烟测试，实际 51 项**（smoke.js 中 9 个 `results.push` + 42 个 `await step`），README 滞后。
3. 无菜单栏定制（`main.js:30` 仅 `autoHideMenuBar`，Alt 会弹出**默认 Electron 菜单**，含 Reload/DevTools 等面向开发者的项）；无首次启动引导；快捷键只有 9 个且无一处界面内可见的快捷键列表页（`README.txt:53-69` 是唯一来源）。

**快捷键体系**：核心键（Ctrl+O/S/F/W/B/0、Ctrl+Shift+F、Ctrl+Tab、Esc）齐全无冲突，但缺失常见肌肉记忆键：无 F3/Enter 循环跳下一个匹配（`find.js:136-143` 仅 Enter 可跳，无 F3）、无 Ctrl+Shift+P 命令面板、无 Ctrl+H 替换。Ctrl+B 被用作「预览模式切换」，与用户「Ctrl+B=加粗」的普遍预期冲突（CodeMirror 里也没绑定加粗，等于这个键做了两件用户想不到的事）。

**稳定性与数据安全风险（需在 1.0 前处理）**：
1. **编码静默转换**：读取优先 UTF-8、失败回退 GBK（`ipc.js:19-30`），但**写入永远 UTF-8**（`ipc.js:117`）——打开一个 GBK 编码的中文 .txt，任何一次自动保存都会把它静默转成 UTF-8，若有混合编码会直接乱码。对中文用户这是**真实的数据保真隐患**。
2. **大文件上限 2048MB 的内存陷阱**（见 4.2）。
3. **AI 无流式**：长回复期间界面冻结感强，「停止生成」只能中断整次请求，无法保留已生成内容（`ai.js:26-41` 一次性 fetch 完整 JSON）。
4. **未签名安装**：`README.txt:91` 如实告知 SmartScreen 流程，但无签名计划——111MB 未签名安装包在 Windows 上的首次转化率会打折扣，这是增长硬伤而非文档问题。
5. 死代码/死钩子：`--carettest` 引用不存在的 scripts/caret-test.js（`main.js:76-83`，被 try/catch 静默吞掉）；preload 的 onAiChunk/onAiDone 从未被使用（`preload.js:47-48`）。

**冒烟测试覆盖度评价**：51 项真实窗口 E2E 断言，覆盖 FS 核心（9 项）、编辑器/预览/搜索 UI、mermaid、图片查看器全链路（缩放/平移/复制/滚动边界）、Python、AI 面板（UI 层）、设置持久化、外部修改同步、拖拽打开——**在同类个人项目中属于极高水平**。未覆盖：AI 真实 API 往返（有意避开网络，合理）、GBK 编码回退、重命名失败路径、打包后安装包的运行验证、卸载行为、大文档性能。

### 4.5 迭代建议

**短期（1–2 个迭代，0.2.x）**：

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | **导出 PDF/HTML**：markdown-it 渲染管线已就绪（`preview.js:7-12`），套用样式表用 Electron 的 `webContents.printToPDF` 即可，**成本极低、价值极高** | 写作工具无导出=无法交付，这是与 Typora 对位时最扎眼的缺口 |
| P0 | **修复文档-实现漂移**：删「双击 Shift」文案（`README.txt:59`、`index.html:24/52`）、README 测试数改 51、删 caret-test 死钩子（`main.js:76-83`） | 用户照文档操作发现功能不存在，直接消耗信任 |
| P1 | **AI 流式输出**：ai.js 改 SSE/fetch stream，复用 preload 预留的 onAiChunk/onAiDone（`preload.js:47-48`）；顺带让「■停止」能保留已生成内容 | AI 是差异化卖点，当前无流式的体验会劝退 |
| P1 | **编码安全**：写入前若原文件非 UTF-8 且无 BOM，提示用户或按原编码保存（`ipc.js:19-30,117`） | 中文用户数据保真，一次性改动小 |
| P1 | **Find&Replace**：在 find.js 底部面板加替换输入与逐条/全部替换（复用 matchField 高亮与 collect()） | 编辑器标配，实现路径清晰 |

**中期（0.3.x–0.5.x）**：① 目录大纲 + 真·字数统计（按标题解析 h1-h6 侧边栏，成本低、写作类高频需求；当前仅总字符数 `tabs.js:208`）；② 多主题（深色）：styles.css 已是 CSS 变量体系（`:root` 集中定义），换肤成本低，能显著扩大用户群；③ 文件关联 + 双击 .md 打开（installer.nsh 扩展 file association，与现有目录右键菜单同套路）——补上「入口」；④ 自动更新（electron-updater + GitHub Releases 或自建源），解决 111MB 安装包的迭代分发；⑤ 会话恢复（重启恢复标签与未保存草稿，`app.js:628-631` 已有 lastDirectory 先例）、标签页关闭询问策略改进（`tabs.js:279-283`）。

**长期（0.6+）**：① 插件体系（沿 AI function calling 的工具边界抽象成插件 API，是现成的天然切点）；② 跨平台（Electron 已跨平台，主要工作量在 python 探测的 platform 分支与路径处理，`python.js:42-126` 已留 which 分支）；③ 云同步/加密（面向知识库场景，或直接对接第三方同步盘，保持本地优先）；④ 内容资产化：建主页/仓库、MIT 开源运营、发布日志（CHANGELOG），把 release.ps1 的一键发版能力变成「社区能看见的迭代」。

### 4.6 最值得打磨的 3 个点

1. **导出 PDF/HTML**（成本最低、价值最高）。渲染链路完全现成（`preview.js` 的 markdown-it + `styles.css` 的排版样式），`printToPDF` 一个 IPC 就能打通。没有导出，MarkHunter 的产出被困在本地；补上它，「写作工具」的定位才闭环。建议与深色主题、大纲一起构成 0.2 版本主题。
2. **AI 体验的最后一公里**（差异化卖点的兑现）。function calling 改文档这套工具链（`ai.js:8-17`）在同类产品里独一份，但非流式 + 无会话记忆 + API Key 明文 + 未配置时无处了解，让卖点打七折。流式输出 + 会话持久化 + 首次配置引导，是最能放大「这个工具有别于其他编辑器」印象的一组改动。
3. **首次体验与信任**（增长转化的现实瓶颈）。三件事一次做：① 修掉「双击 Shift」等文档-实现矛盾；② 启动时的快捷键/能力引导（或帮助页），替代当前只能翻 README 的现状；③ 用代码签名证书解决 SmartScreen 红屏——对一个 111MB 的免费工具，用户首次双击的信任门槛就是这最后一步。

---

## 五、综合行动清单（三维度优先级矩阵）

**排序规则**：按严重度×影响排序；同一时间框内先列严重/高，再列中/低。时间框定义：**立即** = 下个版本内（1–2 天）；**短期** = 1–2 个版本（1–2 周）；**中期** = 结构级改造（1–3 个月）。

### 🔴 立即

| 编号 | 问题 | 维度 | 严重度 | 建议动作 | 时间框 |
|---|---|---|---|---|---|
| 1 | 文件 IPC 无任何路径校验（`isInside()` 死代码） | 安全 | 高 | 接入 `isInside()`：所有 `fs:*` handler 先 `path.resolve`+`realpath` 再校验在 rootDir 内，拒绝 `..`/符号链接逃逸；`fs:delete` 限 rootDir 子树并二次确认 | 立即 |
| 2 | 渲染进程未开沙箱 + preload 暴露面过大（含测试 API `writeExternal`） | 安全 | 高 | webPreferences 加 `sandbox:true`（本项目 preload 仅用 contextBridge/ipcRenderer，兼容成本极低）；删除 `writeExternal`；文件 API 收窄为相对 rootDir 接口 | 立即 |
| 3 | 无导航防护（无 `will-navigate`/`setWindowOpenHandler`），存在本地 HTML 携 preload 权限执行的 RCE 链 | 安全 | 高 | `setWindowOpenHandler`：http/https → `shell.openExternal`，其余 deny；`will-navigate` 仅放行 index.html | 立即 |
| 4 | 击键三重同步全量重算（标签重建 + 预览整篇重渲染 + 文件内搜索全扫）无防抖 | 性能 | 严重 | 预览与文件内搜索入口加 300ms 防抖（与自动保存同模式）；`renderTabs` 改增量更新 | 立即 |
| 5 | bundle 9.08MB 未压缩未分包（mermaid 生态占 67.9%） | 性能 | 严重 | `build.js` 开 `minify:true`（9.08→~4.5MB，启动解析约减半） | 立即 |
| 6 | 全局搜索 CPU 密集段阻塞主进程事件循环，无进度无取消 | 性能 | 严重 | 每处理 N 个文件 `setImmediate` 让出事件循环；加 AbortController 取消；`maxResults` 默认降 1000 | 立即 |
| 7 | mermaid 冗余打进安装包（~37MB，运行时不需要） | 性能 | 中 | mermaid 移入 devDependencies；`files` 排除 node_modules | 立即 |
| 8 | AI API Key 明文存储并回传渲染进程 | 安全 | 中 | `safeStorage` 加密；`settings:get` 只回掩码；`ai:chat` 由主进程注入 key | 立即 |
| 9 | 文档-实现漂移（「双击 Shift」文案、测试数 39→51、caret-test 死钩子） | 产品 | 中 | 删 `README.txt:59`/`index.html:24,52` 文案；README 测试数改 51；删 `main.js:76-83` 死钩子 | 立即 |

### 🟡 短期

| 编号 | 问题 | 维度 | 严重度 | 建议动作 | 时间框 |
|---|---|---|---|---|---|
| 10 | 大文件（≤50MB）全量进出内存与 IPC；2048MB 上限是内存陷阱 | 性能/产品 | 高 | 默认上限降至 10MB 并提示；>5MB 打开即只读 + 关闭实时预览/实时搜索 | 短期 |
| 11 | 自动保存每次整篇 `toString()` + IPC + 写盘，大文件保存开销大 | 性能 | 高 | 大文件提高防抖间隔或改手动保存确认 | 短期 |
| 12 | Python 输出无背压/无节流，无限 print 触发 IPC 洪峰 + 高频 DOM 写入 | 性能 | 高 | 主进程按 ~50ms 合并输出块一次 send；渲染端批量 append + rAF 后统一滚动 | 短期 |
| 13 | 无导出 PDF/HTML | 产品 | 高 | 复用 markdown-it 渲染管线 + `webContents.printToPDF`，一个 IPC 打通 | 短期 |
| 14 | GBK→UTF-8 静默编码转换（读取回退 GBK、写入永远 UTF-8） | 产品 | 高 | 写前检测原编码：非 UTF-8 提示用户或按原编码保存 | 短期 |
| 15 | Python 解释器路径不受校验（可设任意 exe）+ 无 `--` 分隔 + 无 .py 校验 | 安全 | 中 | 主进程校验 `python*.exe` 名称与存在性；spawn 加 `--`；校验 `.py` 扩展名与 rootDir 归属 | 短期 |
| 16 | Python kill 只杀直接子进程，进程树残留 | 安全 | 中 | Windows 用 `taskkill /pid <pid> /T /F` 或 tree-kill 库 | 短期 |
| 17 | AI 工具 `open_file` 路径穿越 + 只读工具无确认 | 安全 | 中 | 拒绝 `..` 段；`open_file` 限 rootDir；只读工具纳入确认/白名单；加 prompt injection 防御 | 短期 |
| 18 | AI baseUrl 不校验协议/主机，密钥随请求发出 | 安全 | 中 | 强制 `https://`；非白名单主机弹确认 | 短期 |
| 19 | AI 非流式（长回复冻结、「停止」无法保留内容） | 产品/性能 | 中 | SSE 流式，复用 preload 预留 `onAiChunk`/`onAiDone`；停止时保留已生成内容 | 短期 |
| 20 | 缺 Find&Replace | 产品 | 中 | find.js 底部面板加替换输入与逐条/全部替换（复用 collect() 与高亮） | 短期 |
| 21 | NSIS 安装包未签名（SmartScreen 红屏、发布物无法验完整性） | 安全/产品 | 中 | 配置代码签名证书（OV 起步）；未签名期间发布 SHA256 校验值 | 短期 |
| 22 | 生产包冗余携带完整 node_modules（asar 65.8MB、6869 文件） | 安全/性能 | 中 | electron-builder `files` 排除 node_modules；bundle 开 minify | 短期 |
| 23 | CSP 偏松（`img-src` 含 `file:`、缺 `object-src 'none'`/`base-uri 'none'`） | 安全 | 低 | `img-src 'self' data:`；加 `object-src 'none'; base-uri 'none'` | 短期 |
| 24 | `settings:set` 无 key 白名单（`Object.assign` 可改原型） | 安全 | 低 | patch 按键白名单过滤 | 短期 |
| 25 | 快捷键体系问题（Ctrl+B 与「加粗」冲突、缺 F3/Ctrl+H/Ctrl+Shift+P；界面内无快捷键列表） | 产品 | 低 | 重排快捷键；首启引导或帮助页替代翻 README | 短期 |
| 26 | `window.__app` 暴露全部内部模块 | 安全 | 低 | 生产构建移除或仅暴露只读接口 | 短期 |
| 27 | AI 数据出网（全文/搜索片段回传）无显著隐私提示 | 安全 | 信息 | 首次启用 AI 显著告知数据出网范围，提供关闭项 | 短期 |
| 28 | 定位叙事滞后于能力（README 未突出 Python/AI 差异化） | 产品 | 中 | 重写 README 定位与卖点排序 | 短期 |

### 🟢 中期

| 编号 | 问题 | 维度 | 严重度 | 建议动作 | 时间框 |
|---|---|---|---|---|---|
| 29 | mermaid 6MB+ 代码随首屏解析（顶层静态 import） | 性能 | 严重 | `preview.js` 顶层 import 改 `await import('mermaid')`（首次渲染到 mermaid 块才加载），esbuild 多 chunk；启动再降 30–50% | 中期 |
| 30 | 全局搜索仍占用主进程（当前已让出事件循环后的根治方案） | 性能 | 严重 | 移入 `utilityProcess`（Electron worker 进程），主进程仅 IPC 转发 + 结果流式推送 | 中期 |
| 31 | 预览整篇重渲染 + mermaid 全量重算 | 性能 | 高 | 增量渲染：mermaid SVG 按块缓存复用；Decoration 增量合并；图多时 `requestIdleCallback` 分批 | 中期 |
| 32 | 大文件编辑/保存策略（50MB 全量读入、整篇写回） | 性能/产品 | 高 | 增量保存（CM6 事务 diff）/ 临时文件 + 原子替换；>5MB 打开即只读 | 中期 |
| 33 | 标签切换 `view.setState` 全量重建编辑器视图 | 性能 | 中 | 保持多 EditorView 实例常驻或延迟重建 | 中期 |
| 34 | 每标签一个 500ms `fs.watchFile` 轮询 | 性能 | 中 | 改 `fs.watch`（Windows 单文件场景已基本稳定）或轮询间隔提到 1-2s | 中期 |
| 35 | 大图粘贴/查看内存峰值（ArrayBuffer 双份复制、原图直载无缩略图） | 性能 | 中 | 粘贴大图先压缩；查看器超大图降采样预览 | 中期 |
| 36 | CodeMirror 装配过重（`basicSetup` 26 个扩展大部分用不到） | 性能 | 中 | 手写精简扩展集（需回归测试编辑器行为） | 中期 |
| 37 | 缺目录大纲/TOC、真字数统计、深色主题 | 产品 | 中 | h1-h6 侧边栏大纲 + 字数统计（低成本高频）；styles.css 已是 CSS 变量体系，换肤成本低 | 中期 |
| 38 | 无文件关联（双击 .md 不打开）+ 无主页/仓库/LICENSE | 产品 | 中 | installer.nsh 扩展 .md 文件关联；建主页/仓库、补 LICENSE、CHANGELOG | 中期 |
| 39 | 无自动更新渠道 + 无会话恢复 + 标签关闭静默保存 | 产品 | 中 | electron-updater；重启恢复标签与草稿；标签关闭改询问策略 | 中期 |
| 40 | tree `select()` 全量遍历 + 滚动同步无节流 | 性能 | 低 | 缓存上次选中节点；滚动同步 rAF 节流 | 中期 |
| 41 | PDF 内嵌查看器加载任意本地 PDF | 安全 | 低 | 保持 Electron 升级；来源不可信 PDF 提示风险 | 中期 |

---

## 六、总体评价与展望

**总体评价**：三份维度评审的结论高度收敛——MarkHunter 的工程底子在个人项目中属于罕见水准（51 项真实窗口 E2E、CSP/contextIsolation 安全基线、路径归一化与外部修改同步、预览/图片/搜索的交互闭环都做得认真），Python 内嵌运行 + AI function calling 的差异化组合真实存在且同类少有，图片查看器、预览缩放、光标常显等细节打磨明显优于大多数自研 Electron 工具。它不是「做得不好」，而是「还没收尾」：性能上有 4 个量级性拖累（9MB bundle、击键三重全量重算、主进程阻塞式全局搜索、大文件全量进出内存），安全上有 3 项结构性缺陷（无沙箱、文件 IPC 零路径校验、无导航防护），产品上缺出口（导出）、入口（文件关联/主页）与信任（签名、文档漂移、编码数据风险）。三份报告共同指向一个判断：**当前状态适合作者自用或小圈子分发，距离「可放心推荐给公众下载」还有一版加固的距离**。

**最快路径**：好消息是最高优先级的修复几乎全部是低成本——接入现成的 `isInside()`、`sandbox:true`（preload 恰好只依赖 contextBridge/ipcRenderer）、`minify:true` 一行、预览/搜索 300ms 防抖约 20 行、mermaid 移 devDependencies 一行、搜索让步事件循环约 5 行、文档漂移删除几处文案。这些「0 成本高收益」项集中在 0.2.x 一个版本内即可完成。建议 0.2.x 聚焦：安全五项加固（IPC 白名单、删 writeExternal、沙箱、导航防护、AI Key 移出渲染进程）+ 性能四件套（minify、防抖、mermaid 移依赖、搜索让步）+ 导出 PDF + 编码安全 + AI 流式；0.3+ 再进入增量渲染、utilityProcess 搜索、大纲/深色主题、文件关联与签名等中期项。

**展望**：按上述路线走完，MarkHunter 完全有资格从一个「好用的自用工具」升级为「值得推荐给中文知识工作者的产品」——它的差异化空位（本地文件夹 + 写作/脚本 + AI 辅助）真实存在，且没有任何主流产品正面占据。长期看，插件体系（沿 AI function calling 的工具边界抽象）、跨平台与内容资产化（主页/开源运营/CHANGELOG）是放大这一差异化的自然路径。同时需正视评审边界：本报告为纯静态审查（体积/依赖/代码路径实测 + audit），未做运行时 Profile，建议在实施上述优化后补充启动耗时实测与 typing 场景性能火焰图，并针对「XSS → 任意文件读写删」攻击链做一次渗透验证，以实证确认加固效果。

---

**评审依据**：性能报告基于对 `src/renderer/dist/bundle.js` 的实际行级统计（9,517,909 B、67.9% mermaid 生态）；安全报告基于对 `src/main/*.js`、`src/preload/preload.js`、`src/renderer/*.js`、`scripts/*`、`electron-builder.yml`、`package-lock.json`、`dist/win-unpacked/resources/app.asar` 的源码级核查与 grep 验证（`isInside` 无调用点、无 `openExternal`/`setWindowOpenHandler`/`will-navigate`、渲染进程无 fetch）、`npm audit` 实测（0 漏洞）及 Electron 43.3.0 / mermaid 11.16.1 公开安全信息核对；产品报告基于 README.txt、package.json、全部渲染/主进程模块、构建脚本与 dist 产物。三份报告均含若干处 README 与实际代码不一致、死代码、安全隐患的记录。
