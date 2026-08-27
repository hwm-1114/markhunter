# 更新说明（Changelog）

## v0.1.49（2026-08-24）

> 三阶段计划之一（docs/开发计划-可靠性大文件多窗口对比-0.2.0.md）：可靠性压测体系 + 打开上限 + 大文件 4GB 分层。

### 新功能：大文件 4GB 分层支持
- **>256MB 只读查看器（viewer-lg）**：8MB 滑动窗口秒开（仅读当前窗口）；⏪⏩ 翻页按钮 + 滚动到边缘自动翻页；「📍 跳转」支持百分比（50%）与字节偏移（1.5G / 500M / 1600000000）；状态栏显示窗口偏移与百分比。
- **区域编辑开关（D1）**：查看器横幅一键开启，当前窗口（≤40MB）转可编辑，保存（Ctrl+S/自动保存）经主进程流式拼接（前段+新内容+后段 → 临时文件 → 校验大小 → 原子覆盖）写回原位置；退出编辑时自动保存。
- **二进制窗口防护**：含控制字符（NUL 等）的窗口替换为 `·` 显示并禁编（写回会失真）；查看器强制不换行 —— 修复超长单行在换行模式下 CM 视口测量失控（实测曾致渲染进程内存涨至 13GB）。
- **>64M 字符保存走分块流式写**（write-stream open/append/close 三通道，16M 字符/块）：规避 V8 单字符串上限（≈5.36 亿字符）与整串结构化克隆内存峰值；close 时统一自写标记。
- **全局搜索大文件流式扫描**：>10MB 文本文件不再整档跳过，readline 流式逐行匹配（≤4GB，行号全局精确，结果行截断 1000 字符）；命中大文件经「行号→字节偏移」（fs:find-line-offset 流式统计换行）在查看器中定位开窗。
- 大文件上限设置 1~2048MB → **1~4096MB**，设置页文案分层说明。

### 性能优化（压测前置）
- **标签徽标增量化（O1）**：文档变更（每次击键）只更新未保存圆点与激活态，不再全量重建标签栏 DOM —— 100 标签下键入延迟从 O(N) DOM 重建降至 **0.1~0.2ms**（与单标签无差异）。
- **会话扩容（O2）**：持久化上限 50 → 200 标签，恢复并发 3 → 6（120 标签恢复实测 0.5s 内）。

### 可靠性用例与实测（新增 9 项）
`stressTabs100`（100 标签打开 0.3~0.6s / 每键 0.1ms / 堆 78MB）、`stressSession120`（120 标签恢复与顺序）、`stressLarge3`（2×60MB 同开切换预读）、`boundaryViewer`（3.9GB 查看器翻页/跳转/二进制禁编 + 512MB 同档 + 4.1GB 拒绝）、`viewerRegionEdit`（280MB 区域编辑拼接写回校验）、`bigSearchStream`（15MB 流式搜索行号）、`saveStreamBig`（65MB 流式保存往返）、`bigFileSetup/Teardown`（上限设置切换）。**上限实测报告见 docs/上限实测报告-0.1.49.md**：标签数硬上限无、软上限 200（会话配置）；4GB 以下全档位可用。

### 修复
- `settingsUI` 等冒烟断言随上限 4096 同步；`remove` 断言兼容测试材料目录。

## v0.1.48（2026-08-24）

### 新功能
- **标签滚动位置记忆**：切换标签时记住离开时的滚动位置（编辑器 / 图片视图 / 分屏预览区分别记忆），切回即恢复；新标签从顶部开始。恢复采用多帧校正（CM 视口高度测量异步，单次赋值会被"弹回"），约 100ms 内稳定到位。
- **状态栏滚动快捷按钮**：右下角新增「↑ 顶部」「↓ 底部」——一键回到文档最上方/最下方（编辑器与图片标签通用；仅预览模式下作用于预览区；分段大文件跳底部前自动补齐剩余分段，与保存同语义）。

### 修复
- **侧栏「新建文件/新建目录」落到错误位置（看似没创建）**：三处协同修复 —— ① 树中**点击目录行不更新选中状态**（仅文件点击会选中），「新建」的目标目录跟随的是最后点击文件所在目录而非用户正在浏览的目录，文件创建到了别处；现在目录点击同样更新选中。② `fs:create` 改用 recursive mkdir —— 目标父目录已被外部移动/删除（树缓存陈旧）时自动重建父链，不再抛 ENOENT 裸错误。③ `tree.refreshNode` 找不到目标行时向上回退到最近已渲染祖先刷新、兜底整树重建 —— 修复「创建成功但树不刷新」。
- **标签切换后滚动位置丢失**：`view.setState` 重建视口导致位置重置（见新功能第 1 条）。

### 测试
- 冒烟新增 3 项（共 **135 项** 全部通过）：`tabScrollMemory`（A/B 标签往返滚动位置保持）、`scrollButtons`（到底部/回顶部）、`createInSelectedDir`（点击目录行后新建文件落在该目录内）。

## v0.1.47（2026-08-22）

### 新功能：查找与替换全面升级
- **文件内查找替换（Ctrl+F / Ctrl+H）**：底部「文件内搜索」面板升级为完整「查找与替换」双行布局 —— 查找/替换输入框大幅加宽（min 240px / max 640px）、字号与内边距加大；新增「替换」（替换当前选中处，替换后自动跳到下一处，Enter 触发）与「全部替换」（一次原子 dispatch 多处生效）按钮，与查找同口径不区分大小写，替换文本原样插入。Shift+Enter 在替换框触发全部替换。
- **拦截 CodeMirror 内置搜索小窗**：编辑器内 Mod-f 不再弹出 CM 右上角迷你搜索框（此前 Ctrl+F 会同时弹出小窗与底部面板），统一收敛到底部大面板；新增 Ctrl+H 快捷键直达替换输入框。
- **全局搜索批量替换（Ctrl+Shift+F）**：全局搜索栏新增「替换为」输入行与「全部替换」按钮 —— 对当前搜索结果涉及的每个文件做整文大小写不敏感替换（文件内全部匹配，非仅列表所示行），原生确认弹窗注明涉及文件数与匹配数、UTF-8 保存提示；替换完成自动重搜刷新结果并 toast 汇总（含失败文件数）。注意：文件清单取自当前结果列表（受 3000 条上限约束）。

### 修复
- **高频编辑误报「已在外部被修改」（体验级修复）**：快速打字、连续自动保存时反复弹出「确定要重新加载文件（丢弃本地更改）吗？」。根因：Windows `fs.watch` 事件在高频写入下延迟/合并，`markSelfWrite` 的 stat 在高 IO 负载（杀毒/索引）下也可能滞后 —— 文件变更检查时磁盘已是新状态而自写记录还是旧值，mtime 精确匹配失败即误判外部修改。修复（双层）：① 主进程 `filewatch.js` 自写记录由「一次性 mtime 精确匹配」升级为「mtime+size 精确匹配 + 写后 2s 宽限窗口吸收回声」（宽限内变化一律视为自身回声，记录同步刷新；停止编辑 2s 后外部修改检测完全恢复，代价为宽限内紧随自写的外部修改被吸收一次）；② 渲染端 `tabs.js` 保存成功记录 `lastSavedAt`，保存后 1.2s 内到达的 `file-changed` 通知直接忽略（兜底残余竞态）。

### 测试与加固
- 冒烟新增 3 项（共 **132 项** 全部通过）：`findReplace`（替换当前 + 全部替换 + 大小写不敏感）、`globalReplace`（跨文件批量替换 + 自动重搜）、`rapidSaveEcho`（5 轮高频「编辑→保存」不得出现外部重载误报；`externalChange` 用例等待同步加长以隔离自写宽限窗口，验证真实外部修改仍即时通知）。
- 抗高负载抖动：`largeFileChunk` 改为「模拟停在底部」自适应轮询（最长 ~13s，增长即停）；`menuPaste`/`menuPasteEmpty` 菜单派发加抗真实点击干扰重试、点击后改为条件轮询（最长 3s）—— 消除三处固定等待在全量负载下的偶发误报。

## v0.1.46（2026-08-22）

### 修复（全量审计 13 项）

- **拖拽打开文件全坏（高）**：drop 处理读取 `f.path`，但 Electron 32 起该属性已移除（本项目 43.3.0），真实拖拽拿到 undefined 静默失败；冒烟用 `{path}` 假对象绕过了真实行为，从未发现。修复：preload 暴露 `webUtils.getPathForFile`（解析失败回退旧属性），drop 改用它取路径；新增冒烟断言 `dropPathResolver`。
- **中文输入法 Enter 误触发（高）**：AI 聊天、文件内搜索、全局搜索、新建/重命名弹窗的 Enter 处理未判 `e.isComposing` —— IME 组合确认键（keyCode 229）会提前发送消息/执行搜索/提交弹窗，对中文用户必现。四处统一加 `isComposing || keyCode === 229` 守卫。
- **重命名外部文件后自动保存被拒（中）**：`fs:rename` 不 approve 新路径，`fs:write-file` 无同级放行（M3 只加在 write-binary）→ 工作目录外已打开文件重命名后一编辑就报「路径不在当前工作目录内」。修复：`security.js` 新增 `remapApproved`（重命名把批准集合映射到新路径，含目录重命名的子路径）与 `revokeUnder`（删除清理批准集合），`ipc.js` 的 rename/delete 接入；新增冒烟断言 `renameExternalSave`。
- **运行 Python 污染 >4MB 脚本（中）**：运行面板前置保存直接 `writeFile(doc.toString())`，分段（chunked）文件会把 `MH-CHUNKED` 占位注释写进 .py（SyntaxError）且未加载分段被截断。修复：Python 面板经回调复用 `editor.saveNow`（补齐分段 + 剥离标记），`saveNow` 改为返回成功/失败，保存失败中止运行。
- **分段保存并发竞态截断（中，验证期新发现）**：`loadNextChunk` 遇 `inflight` 立即 return，`ensureFullyLoaded` 等待循环空转 4096 次守卫后带 `complete=false` 提前退出 —— 并发保存（800ms 自动保存 + 手动/Python 前置保存交错）会把未加载完的内容写盘且返回成功（真实数据截断，冒烟 `chunkedSaveClean` 在负载下复现实测少 1MB）。修复：`loadNextChunk` 并发调用共享进行中的 Promise（等待真实进度）；`saveNow` 全局串行队列合并并发保存。新增冒烟断言 `chunkedSaveClean`。
- **退出应用不杀 Python 进程（中）**：`will-quit` 经 `disposeCurrentProc` 用 taskkill 回收运行中的进程树；`python:run` 顶掉旧进程同样改进程树终止（原普通 kill 遗留子进程）并先摘旧输出监听防窜批；`python:exit` 发送前加窗口已销毁守卫。
- **低危 5 项**：① 图片/mermaid 查看器拖拽监听器改为按下挂载/抬起摘除（不再每次打开累积泄漏）；② `fs:read-file-range` 循环读满，按实际读取量返回 `end`（部分读不再补零污染，渲染端自愈续读）；③ `uniquifySvg` id 规则加负向后顾（不再误改 `data-id=`），style 选择器补逗号分组；④ AI 面板「⚠ 未配置」等界面提示不再以 system 角色混入 API 请求；⑤ find/globalsearch 之外的 Enter 一并核对无遗漏。

### 测试
- 冒烟新增 3 项（共 **129 项** 全部通过）：`dropPathResolver`（preload 暴露 getPathForFile）、`renameExternalSave`（外部重命名后保存放行）、`chunkedSaveClean`（分段标签编辑后保存无标记、无截断）；`largeFileChunk` 等待由固定 1500ms 改为轮询（最长 ~8s），兼容全量负载下首次分段追加延迟。

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
