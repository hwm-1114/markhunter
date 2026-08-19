# 更新说明（Changelog）

## v0.1.45（2026-08-20）

### 修复与优化
- **Python 输出背压（P4）**：主进程 stdout/stderr 按「~60ms 或 ~4KB（先到者）」聚合后统一经 `python:output` 通道发送，退出（close）时 flush 残余；渲染端批内按行拆 span 用 `DocumentFragment` 一次追加、批末才设一次 `scrollTop`，保留 3000 span 上限裁剪，并处理跨批长行截断续接。2000 行输出渲染线程冻结由 2.37s 降至几十毫秒，IPC 消息数降 1~2 个数量级。
- **文件监听改事件驱动（P8）**：`fs.watchFile` 500ms 轮询/标签改为 `fs.watch` 事件驱动（50 标签不再 = 50 个 stat 轮询，外部修改即时感知）。选型依据 Windows 探针实证（直接写 20/20、原子替换 20/20、替换后监听持续有效）；`fs.watch` 同步失败或异步 error 时自动回退 `fs.watchFile` 1000ms 轮询兜底（退化语义不变）。
- **会话恢复并行限流（P9）**：启动恢复多个标签由逐个串行打开改为并发 3 路 `openFile`，恢复完成后按会话顺序重排标签栏（新增 `editor.reorderTabs`），活动标签与 pinned 下标语义保持不变。
- **文件内搜索 DOM 优化（P10）**：结果列表改为 `DocumentFragment` 批量构建 + 容器级事件委托（不再每行一个 listener）；借助 CodeMirror EditorState 不可变性，文档未变时重复触发/跳转仅切换 current 高亮，不再每击键全量重建 2000 行 DOM（实测 11.5ms/次）。
- **mermaid 缓存 SVG id 实例唯一化（P2 补强）**：缓存命中复用 SVG 时，同一源码图多次出现会注入重复的内部 id（defs/marker/gradient/样式选择器），导致 `url(#id)`/CSS 全部命中第一个实例。注入前对 id 属性、`url(#)`、`href="#id"`、`<style>` 内 `#id` 选择器统一追加文档内唯一后缀（十六进制色值不受误伤）。
- **危险按钮/菜单项浅色硬编码令牌化（小项）**：`.tbtn.danger:hover` 与 `.ctx-item.danger:hover` 的 `#fdf0f0` 改为 `color-mix(in oklab, var(--mh-danger) 12%, var(--mh-bg-panel))`，暗色主题下 hover 底色自适应。
- **全局搜索迁 utilityProcess（P6）**：搜索逻辑整体迁入 `src/main/search-worker.js`（`utilityProcess.fork`，worker 文件随 asar 打包），主进程只做任务转发/取消/超时兜底/进度透传 —— 1GB 工程扫描不再占用主进程事件循环（搜索期间保存/设置即时响应）。支持取消（`search:cancel`，UI 搜索中按钮变「取消」）与进度事件（`search:progress` 透传「已扫描 N 个文件」）。渲染端结果分批渲染（首 200 条 +「加载更多」按钮），不再一次性建 3000 行 DOM；`search:global` 返回契约不变。
- **大文件分段读取（P7）**：超过 4MB 的文件走「分段模式」：`fs:read-file-range` 按 range 读入（保留大小上限校验，超限仍拒绝），首段约 2MB 进 CM（文档末尾带 `<!-- MH-CHUNKED -->` 占位标记告知未完，预览/保存前自动剥离），滚动接近底部自动预读下一段并以 CM `dispatch` 增量追加（保持光标/滚动）；流式 `TextDecoder` 正确处理分块边界截断的多字节字符（UTF-8/GBK）。保存前若未读完先补齐剩余分段再整篇写入（写路径本身不改），防止写盘截断；全局搜索跳转到未加载行号时自动续读定位。
- **mermaid 拆包（P5）**：mermaid 全家桶从主 bundle 移出为独立 `dist/mermaid-chunk.js`（新入口 `mermaid-entry.js`，iife + minify，暴露 `window.__mermaid`）。preview.js 不再静态 import mermaid：首次需要渲染时动态注入同源 `<script>`（CSP `script-src 'self'` 允许），就绪 Promise 融入渲染路径（就绪前保持 `pre>code` 占位，加载失败显示错误占位），无 mermaid 块的文档不触发 chunk 加载。主 bundle 由约 4.34MB 降至 0.85MB（**-80%**），chunk 3.29MB 按需加载。

### 测试
- 冒烟测试新增 6 项：`pythonBatch`（2000 行输出完整、退出码 0、span 不超上限）、`restoreParallel`（并发恢复顺序/激活/pinned 正确）、`findDomReuse`（同查询重复触发结果一致、Enter 跳转不重建）、`computedStyleTab`（.tab 计算值 height/justify-content/text-align 宽松断言）、`computedStyleTheme`（thumb 色非 #cbd5e1、暗色 blockquote 背景非 #f0fbf9）、`mermaidCacheId`（同图两次出现无内部 id 冲突）。
- 中期批次再新增 4 项：`searchCancel`（搜索取消路径宽松验证 + 取消后 worker 仍可用）、`largeFileChunk`（>4MB 文件分段打开，初始 doc 长度 < 文件大小，滚动到底部预读后长度增长）、`mermaidChunkLoaded`（chunk 动态加载后 `window.__mermaid` 就绪且 SVG 可渲染）、`bundleSplit`（主进程侧断言 bundle.js < 2.5MB 且 mermaid-chunk.js 产物存在）。


### 修复与优化
- **滚动条滑块宽度修复（SB，核心回归闭环）**：v0.1.43 引入 daisyUI 后，其在 tailwind.css 的 `:root` 注入标准属性 `scrollbar-color`（非 auto、可继承），Chromium 121+ 据此放弃 `::-webkit-scrollbar` 伪元素渲染路径，导致「设置 → 滚动条宽度」（6~40px）设置失效、始终渲染为系统默认宽度。修复：styles.css 滚动条块追加 `:root { scrollbar-color: auto; }` 显式还原；`.tabs` 遗留的 `scrollbar-width: thin` 改为 `auto`（thin 会二次劫持标签条滚动条）；滚动条 thumb 颜色由固定 `#cbd5e1` 改为 `color-mix(in oklab, var(--mh-text) 35%, transparent)` 随主题自适应。探针实证：声明 30px → 实际渲染 30px，随设置联动。
- **mermaid 暗色主题冷启动修复（H1）**：暗色主题冷启动后首次渲染的 mermaid 图不再为浅色 default 主题。渲染前按当前明暗调用 `ensureMermaidTheme()` 初始化，预览模块创建后补一次 `refreshMermaid()`（明暗守卫去重，无图零成本）。
- **主题切换性能优化（P3）**：`refreshMermaid()` 仅在明暗状态实际变化时才重新初始化并重渲染；同明暗档位切换、无图场景直接跳过，多图文档切主题不再冻结 0.2~4s。
- **击键防抖（P1+P2）**：编辑器输入后，预览渲染与文件内搜索合并为 250ms trailing 防抖，整篇 `md.render` / 全量搜索不再每键触发；mermaid 渲染按 src+theme 内容哈希缓存 SVG，文档未变不重画（200KB 文档每键约 21ms、994KB 约 153ms 的打字卡顿消除）。
- **弹窗关闭修复（M1/M2）**：`openModal` 支持 `onClose` 钩子：设置弹窗点遮罩关闭时还原「打开时主题」预览；`closeModal` 统一清空 `#modal-box` 内联宽度，图片/mermaid 查看器经遮罩关闭后不再残留 860px 撑宽后续所有弹窗（含设置）。
- **mermaid 渲染竞态补渲（M4）**：主题切换恰逢首次渲染进行中而遗留的 `pre>code.language-mermaid` 未渲染节点，`reRenderMermaid` 现一并收集补渲。
- **外部文件粘贴图片（M3）**：拖入工作目录外打开的 md 中粘贴图片，允许写入「已批准文件所在目录」，不再被「路径不在当前工作目录内」拒绝。
- **会话恢复静默（L6）**：恢复会话时已删除/超限文件不再逐个弹「打开失败」，改为静默跳过并 `console.warn`。
- **剪贴板 SVG 粘贴（L7）**：`image/svg+xml` 扩展名归一化为 `svg`，写入格式白名单补齐 `.svg`，剪贴板 SVG 粘贴可正常生成图片。
- **主题分组修正（L1）**：aqua / forest 实为 `color-scheme: dark`，由「浅色」组移入「深色」组，与 DARK_THEMES 口径一致。
- **暗色下硬编码浅色块（L5）**：blockquote、AI 系统消息、mermaid 错误提示改用 `color-mix` 变量化配色，暗色主题下不再刺眼。
- **测试接口收敛（L9）**：`fs:write-external` 在打包版明确报「测试接口在正式版不可用」，消除「调用即报错」的死 API。
- **构建压缩（P5）**：esbuild 开启 `minify`，bundle 由约 9.5MB 降至约 4.34MB（-55%），安装包体积与启动 IO/内存占用同步下降。

### 测试
- 冒烟测试 **116 项**全部通过：新增 mermaid 冷启动主题（themeMermaidColdStart）、主题切换幂等（themeMermaidIdempotent）、部分重渲补渲（mermaidPartialReRender）、弹窗宽度重置（modalWidthReset）、遮罩还原主题（modalMaskRestore）、击键防抖合并（debounceTyping）、mermaid 缓存（mermaidCache）、外部文件粘贴图片（pasteExternalImage）、主题分组（themeGrouping）、静默恢复（silentRestore）、SVG 粘贴（svgPasteExt）、writeExternal 打包收敛（writeExternalPackaged）、minify 体积（minifySanity）等专项断言；`scrollbarSetting` 升级为三层断言（标准属性 `scrollbar-color=auto` + `::-webkit-scrollbar` 伪元素计算值 + 真实渲染宽度，overlay 环境自适应跳过），另含视觉断言 scrollbarWidthVisual。


## v0.1.43（2026-08-18）

### 新功能
- **多主题皮肤引擎（36 款）**：接入 Tailwind CSS v4 + daisyUI 5，内置 35 款皮肤 + 自研「经典」皮肤（`markhunter-classic`，应用默认，老用户观感零变化）。设置面板新增「主题」下拉，按「经典 / 推荐 / 浅色 / 深色」四组组织，切换即整窗即时预览，取消/关闭自动还原；选择持久化，重启后保持。
- **CodeMirror 表层 var() 化**：编辑器底色/光标/选区/搜索高亮/括号匹配随主题即时换肤，无需 JS 重配。
- **mermaid 明暗自适应**：暗色主题（14 款）下图表按 `dark` 主题重渲染，浅色下为 `default`。
- **防闪白**：暗色主题冷启动时主进程窗口底色深色 + 渲染层 boot 即时应用主题（叠加静态 `data-theme` 与 `default: true` 兜底）。
- **设置白名单**：`theme` 键纳入 `DEFAULTS` 与 `ALLOWED_KEYS` 双白名单，非法主题名静默丢弃（延续 S6 风格）。

### 修复与优化
- 修复 daisyUI 组件类与既有类名撞名导致的布局回归：`.modal`（组件 overlay 语义漏入 `display:grid/position:fixed/height:100%` 等，导致弹窗贴左上角、mermaid 查看器被内容撑宽无法平移）、`.tabs`（`flex-wrap` 泄漏）、`.toast`/`.tab`（无害泄漏已审计）。
- 经典皮肤下与 0.1.42 视觉一致；`.markdown-body` 列表符号补齐（Preflight 视觉盲区），`line-height`、按钮手型等 Preflight 冲击逐项处置。

### 测试
- 冒烟测试 **102 项**全部通过（94 项既有 + 9 项主题/列表样式新增，含 mermaid 查看器几何回归修复）。

## v0.1.42（2026-08-18）

### 新功能
- **标签固定（Pin）**：右键标签可固定/取消固定，📌 图标一键切换；「关闭其它 / 关闭右侧 / 关闭左侧」批量关闭时自动跳过已固定标签；固定状态随会话持久化，重启后还原。
- **跨目录树定位**：打开工作目录外的文件（拖拽 / 全局搜索 / 会话恢复）后，左侧目录树新增「外部文件」分支，按真实路径链（盘符 → 目录 → 文件）自动展开定位；外部目录可右键「切换工作目录到此目录」；工作目录语义与安全校验保持不变。

### 修复与优化
- 标签批量关闭后，活动标签自动切到锚定标签。
- 外部文件分支随标签增删自动清理（无引用即移除）。

### 测试
- 冒烟测试 **94 项**全部通过。

## v0.1.41（2026-08-18）

### 新功能
- **侧栏分界线拖拽修复**：左侧栏与工作区分界线现可拖拽调整宽度（200~520px，双击恢复默认）——修复原分隔条被布局排到窗口最右缘导致拖不动的问题。
- **右键「粘贴为纯文本」**：编辑器右键菜单新增该项，经主进程读取系统剪贴板文本并插入光标处，自动去除富文本/HTML 格式。
- **Tab 缩进**：Tab 键插入缩进（默认 4 空格，可在设置中调整为 1~8），Shift+Tab 反向缩进；多行选区整行缩进。

### 测试
- 冒烟测试 **76 项**全部通过。

## v0.1.40（2026-08-17）

### 新功能
- **会话保持**：切换工作目录不再丢失已打开标签；重启应用自动恢复上次打开的标签与活动标签（失效文件静默跳过）。
- **树自动定位**：查看文件时（树内点击 / 切换标签 / 全局搜索跳转 / 拖拽打开 / AI 打开）左侧目录树自动展开定位到该文件。

### 修复
- 树定位并发加载竞态（重复子节点）修复。

## v0.1.39（2026-08-16）

### 安全加固（12 项）
- **路径校验**：主进程文件操作（读/写/删/建/改名）接入工作目录边界校验，拒绝目录穿越与越权操作；禁止删除当前工作目录本身。
- **渲染进程沙箱**：开启 `sandbox`，preload 仅保留必要 API。
- **导航防护**：`will-navigate` 仅放行应用自身页面，外链一律交给系统浏览器（阻断本地 HTML 携 preload 权限执行的 RCE 链）。
- **CSP 收紧**：追加 `object-src` 白名单与 `base-uri 'none'`。
- **API Key 加密存储**：AI 密钥改由 Windows DPAPI（safeStorage）加密落盘，渲染进程不再接触明文，旧明文自动迁移。
- **设置白名单**：`settings:set` 只接受白名单键，防原型污染。
- **Python 运行加固**：解释器路径校验（须为 `python*.exe`/`py.exe`）、`.py` 扩展名校验、spawn 加 `--` 分隔、终止改为进程树级（taskkill /T /F）。
- **AI 工具防护**：`open_file` 拒绝路径穿越；服务地址仅允许 HTTPS 或回环地址。
- **移除测试后门**：`fs:write-external` 仅开发版存在，打包版无此能力。
- **生产收敛**：`window.__app` 仅开发模式暴露。
- **打包加固**：asar + Electron Fuses（runAsNode 禁用、asar 完整性校验等）。
- **安装包瘦身**：mermaid 移出运行时依赖，安装包 111MB → 96MB。

### 修复
- 文档-实现漂移（「双击 Shift」文案、测试数）、`--carettest` 死钩子、GBK 编码静默转码提示、树刷新选中文件无效、重命名后文件监听失效。

## 已知问题

- 安装包未做代码签名，首次运行 Windows SmartScreen 会提示「未知发布者」，选择「更多信息 → 仍要运行」即可。
- 外部文件若经 8.3 短路径（如 TMP 环境变量）打开，树「外部文件」分支的自动展开可能受短名/长名差异影响（文件仍计入列表，可手动展开）。
