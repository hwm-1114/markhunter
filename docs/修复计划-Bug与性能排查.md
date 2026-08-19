# MarkHunter Bug 与性能修复计划（v0.1.44）

> 面向版本：MarkHunter v0.1.43 → v0.1.44（Electron 43.3.0 / Chromium 150.0.7871.212，Windows 桌面）
> 编制依据：3 份只读排查报告（滑块宽度设置专项 / 功能维度全面排查 / 性能维度排查），全部为**只读分析**，探针位于 `%TEMP%\mh-scrollbar-probe`、`%TEMP%\mh-probe`、`%TEMP%\mh-app`，未触碰仓库任何文件。
> 方法：静态阅读 22 个源码文件（renderer 10 + main 8 + preload + build/smoke 相关）+ Electron 运行时探针实证（真实 `dist/tailwind.css + styles.css` 级联、真实应用端到端运行）。
> 版本节奏：修复面向 v0.1.44；v0.1.43 新增的回归（daisyUI 滚动条劫持、mermaid 冷启动主题、主题切换全量重渲）优先闭环。

---

## 1. 执行摘要

### 1.1 问题统计

| 维度 | 数量 | 明细 |
|---|---|---|
| **功能** | **14 项** | 高 1（H1）、中 4（M1~M4）、低 9（L1~L9） |
| **性能** | **12 项** | 🔴 高 4（P1~P4）、🟠 中 3（P5~P7）、🟡 低 5（P8~P12） |
| **专项（滑块宽度）** | **1 项（SB）** | 根因已实锤（daisyUI `scrollbar-color` 劫持渲染路径）；其相关线索 L3/L4/P12/T1 并入 SB 闭环，不重复计费 |
| v0.1.43 新增性能项 | 2 项 | P3（主题切换 mermaid 全量重渲，**实证为真风险**）、P11（data-theme CSS 重算，**实证排除为主因**） |
| 开放待确认 | 4 项 | T1~T4（多依赖用户机器环境，见 §6.1） |
| 已验证无问题（负向结论） | 9 项 | 见 §6.3（防误报） |

### 1.2 最严重 Top 5（功能 × 性能混排）

| 排名 | 编号 | 维度 | 问题 | 核心证据 |
|---|---|---|---|---|
| 1 | **SB** | 功能（回归） | **滚动条滑块宽度设置失效**（用户报告核心回归）——变量、规则、计算值全部正确，但宽度不参与绘制 | 探针场景 2：声明 30px → 实际渲染 15px；`dist/tailwind.css` 注入 `:root{scrollbar-color:...}` |
| 2 | **H1** | 功能 | 暗色主题**冷启动后首次**渲染的 mermaid 图为浅色 default 主题，需切换一次主题才变暗（每次冷启动必现） | `preview.js:17-21` 模块级 `initialize({theme:'default'})` + `app.js:114 vs 165` boot 时序；探针实测 node 填充 `rgb(236,236,255)`→refresh 后 `rgb(31,32,32)` |
| 3 | **P1+P2** | 性能 | 击键**无防抖**三重全量重算（整篇 md.render + renderTabs 全量重建 + find 全扫）+ mermaid 每击键整篇串行重渲 | 实测 200KB 文档 ≈21ms/键、994KB ≈153ms/键；5 图文档每键额外 ≥100ms（`app.js:126-137`、`preview.js:67-95,130-159`） |
| 4 | **P3** | 性能（**v0.1.43 新增**） | 主题切换 `refreshMermaid()` **全量重渲染所有已渲染图**（含隐藏预览），多图文档切主题冻结 0.2~4s | 实测 10 图 216ms（`app.js:106-111`、`preview.js:99-128`） |
| 5 | **P4** | 性能 | Python 输出无背压 + 每 chunk 强制回流（scrollTop 强制 layout） | 实测 2000 行输出 = **2.37s** 渲染线程冻结（`main/python.js:182-187`、`renderer/python.js:18-27`） |

### 1.3 滑块宽度设置失败——根因一句话结论

> **不是「变量没生效」**（`--scrollbar-width` 变量、`::-webkit-scrollbar` 规则、计算值三者全部正确），而是 **v0.1.43 引入的 daisyUI 在 `tailwind.css` 的 `:root` 注入了标准属性 `scrollbar-color`（非 auto、可继承），Chromium 121+ 据此放弃 `::-webkit-scrollbar` 伪元素渲染路径，导致滚动条宽度走标准渲染路径（OS 默认 15px）**。
> **最小修复**：`styles.css` 滚动条块追加 `:root { scrollbar-color: auto; }`，并清除 `styles.css:366` `.tabs` 遗留的 `scrollbar-width: thin`（两处合计 **0.5h，免 rebuild**；探针实证：修复后声明 30px → 渲染 30px，随设置联动）。

---

## 2. 修复计划（按优先级：立即 / 短期 / 中期）

> 编号列沿用三份报告的原始编号（SB=滑块专项，H1/M1~M4/L1~L9=功能，P1~P12=性能），保持证据可追溯。
> 维度：功能 / 性能 / 功能（回归）。

### 2.1 立即（P0：回归闭环，阻断发布，约 1~1.5 人日）

| 编号 | 维度 | 严重度 | 问题 | 证据（文件:行号） | 修复方案 | 涉及文件 | 工作量 |
|---|---|---|---|---|---|---|---|
| SB | 功能（回归） | 高 | 滚动条滑块宽度设置失败：变量/规则/计算值均正确，但 daisyUI 注入的标准属性劫持 webkit 渲染路径；`.tabs` 的 thin 二次劫持 | `tailwind-input.css:12-15`（`@plugin "daisyui"` 编译注入）；`dist/tailwind.css`：`:root{scrollbar-color:currentColor #0000}` + `@supports` 变体（2 处命中）；`styles.css:722-726`（规则存在但失效）、`styles.css:366`（`.tabs{scrollbar-width:thin}`）；`smoke.js:608-617`（只断言变量往返，不验证视觉）；探针场景 2：声明 30px → 渲染 15px | ① `styles.css` 滚动条块追加 `:root{scrollbar-color:auto}`；② `styles.css:366` thin → auto；③ 可选：thumb 色改 `color-mix(in oklab, var(--mh-text) 35%, transparent)`。详见 §2.4 | `styles.css` | 0.5h（免 rebuild） |
| H1 | 功能 | 高 | 暗色主题冷启动首次渲染 mermaid 为浅色 default 主题，需切一次主题才变暗 | `preview.js:17-21`（模块级 `mermaid.initialize({theme:'default'})`）；`app.js:114 vs 165`（boot 时 `applyTheme` 先于 `preview` 创建，`if(preview)` 跳过 refreshMermaid）；探针实测 night 冷启动 node 填充 `rgb(236,236,255)` → 手动 refresh 后 `rgb(31,32,32)` | ① `createPreview(...)` 之后补 `preview.refreshMermaid();`；② 防御：`renderMermaid()` 开头按 `getIsDark()` 初始化 mermaid（两者都做） | `app.js` / `preview.js` | 0.5~1h |
| P3 | 性能（**v0.1.43 新增**） | 高 | 主题切换 `refreshMermaid()` 无条件重渲全部 `.mermaid-wrap`（含隐藏预览、含 edit 模式、每档 change 即触发，无去抖） | `app.js:106-111`（applyTheme 内 refreshMermaid）、`app.js:524`（change 即 applyTheme）；`preview.js:99-128`（reRenderMermaid 串行 + 每次 mermaid.initialize）；实测 10 图 216ms，多图文档切主题 0.2~4s 冻结 | 仅当明暗状态**实际变化**（记录 `lastMermaidTheme`）才 initialize + 重渲；下拉连点节流 ~200ms（沿用已有 renderToken 协议丢弃过期结果）；无图直接跳过 | `preview.js` / `app.js` | 0.25 人日 |
| M1 | 功能 | 中 | 设置弹窗选主题（即时预览）后**点遮罩关闭**，`data-theme` 保持预览值，与已存设置不一致，重启才复原 | `ui.js:78-80`（mask mousedown → closeModal，无还原钩子）；`app.js:729-733`（仅「取消」按钮 `applyTheme(openedTheme)`） | `openModal` 支持 `{ onClose }` 选项；mask 关闭分支调用 `opts.onClose`；`openSettings` 传 `onClose: () => applyTheme(openedTheme)` | `ui.js` / `app.js` | 与 M2 合并 1~1.5h |
| M2 | 功能 | 中 | 图片/mermaid 查看器被遮罩关闭后，`#modal-box` 内联宽 860px 残留，此后**所有弹窗（含设置）都变 860px 宽** | `viewer.js:194-199`（宽 860px，仅「关闭」按钮 restore()）；`ui.js:78-80`（mask 关闭不 restore） | 把 `restore()`（清空 `#modal-box` 内联宽）注册进 `openModal` 的 onClose；或 `closeModal()` 统一 `modalBox.style.width=''` | `ui.js` / `viewer.js` | 与 M1 合并 |
| M4 | 功能 | 中 | 主题切换恰逢 mermaid 首次渲染进行中 → 部分图永久停留 `pre>code` 未渲染状态，直到文档再编辑/重渲染 | `preview.js:67-95`（renderToken 只丢弃过期结果，CPU 照花、无补渲）；`preview.js:99-116`（reRenderMermaid 只扫 `.mermaid-wrap`，不扫残留 `pre>code`） | `reRenderMermaid()` 除 `.mermaid-wrap` 外，另收集 `pre > code.language-mermaid`，复用同一渲染函数（传入容器）补渲 | `preview.js` | 1~1.5h |

### 2.2 短期（v0.1.44 内，约 2~3 人日）

| 编号 | 维度 | 严重度 | 问题 | 证据（文件:行号） | 修复方案 | 涉及文件 | 工作量 |
|---|---|---|---|---|---|---|---|
| P1+P2 | 性能 | 高 | 击键无防抖三重全量重算（整篇 md.render + renderTabs 全量重建 + find 全扫）+ mermaid 每击键整篇串行重渲 | `app.js:126-137`（onDocChanged → `preview.render()`、`find.runSearch(true)` 直接调用）；`preview.js:130-159`（render 整篇 innerHTML 替换）、`:67-95`（for…of + await 串行）、`:158`（尾部无条件 renderMermaid）；`tabs.js:172-186`；`find.js:104-122`；实测 200KB≈21ms/键、994KB≈153ms/键、5 图每键 ≥100ms | ① `onDocChanged` 中 `preview.render()` 与 `find.runSearch(true)` 加 ~250ms trailing 防抖（与自动保存 800ms 节奏协调）；② `renderMermaid/reRenderMermaid` 按 `src+theme` 内容哈希缓存 SVG 跳过重渲；③ 防抖窗口内只算一次、mermaid 图不变不重画 | `app.js` / `preview.js`（新增 debounce 工具函数） | 0.5~1 人日 |
| M3 | 功能 | 中 | 拖入窗口的外部（工作目录外）md 文件中**粘贴图片失败**：toast「图片保存失败：路径不在当前工作目录内，操作已拒绝」 | `tabs.js:685-686`（writeBinary 到外部目录）；`ipc.js:135-143`（write-binary 走 requireApproved）；`security.js:52-64`（仅文件本身 approved，目录未放行） | 粘贴前对 `dirname(tab.path)` 所在目录放行（最简：外部文件打开时对目录补一次 approve；或 ipc 侧 `write-binary` 允许「已 approve 文件的同级目录」） | `tabs.js` / `ipc.js` / `security.js` | 1~2h |
| L1~L5 | 功能 | 低 | ① 主题分组漂移：aqua/forest 归「浅色」组实为暗色（color-scheme:dark）；② `.tab` 被 daisyUI 泄漏样式污染（height 40px、居中、text-align:center、position:relative）；③ `.tabs` 遗留 `scrollbar-width:thin`（SB 组成部分）；④ thumb 硬编码 `#cbd5e1` 暗色刺眼；⑤ 暗色下三处浅色硬编码块：blockquote（#f0fbf9/#3d4a5c）、ai-msg.system（#fef7e0/#8a6d1a）、mermaid-error（#fdf0f0 + dark 主题 `--mh-danger` 浅红字，对比度≈2:1） | `app.js:86-88`（浅色组）vs `app.js:45-48`（DARK_THEMES 含二者）；`styles.css:366`、`:724-725`、`:779-786`、`:1066-1070`、`:847-855`；探针 computed 实测（.tab height 40px 等） | ① aqua/forest 移入深色组（或加明暗徽标，见 D14）；② styles.css `.tab` 补 `height:auto;justify-content:flex-start;text-align:left;flex-wrap:nowrap`；③ 随 SB 一并处理；④ thumb 改 `color-mix(in oklab, var(--mh-text) 35%, transparent)`；⑤ 浅色块改 `color-mix(in oklab, var(--mh-bg-hover) …)` + 文字用 `var(--mh-text-2)` | `app.js` / `styles.css` | 3~4h |
| L6 | 功能 | 低 | 恢复会话时已删除/超限文件逐个弹「打开失败」alertBox（openModal 互相覆盖，恢复流程被打断感） | `tabs.js:226-235`（openFile 失败即 alertBox）；`app.js:335-345`（restoreSession 逐个 openFile） | `openFile` 支持静默模式；`restoreSession` 传静默参数，失败仅 `console.warn`（现有 warn 保留） | `tabs.js` / `app.js` | 0.5h |
| L7 | 功能 | 低 | 剪贴板 SVG 粘贴生成 `image-xxx.svg+xml`，`writeBinary` 拒绝「不支持的图片格式」 | `tabs.js:683`（ext 取自 `file.type.split('/')[1]`）；`ipc.js:138`（白名单无 svg+xml） | ext 归一化取 `svg` 段（或白名单加 svg） | `tabs.js` / `ipc.js` | 0.5h |
| L9 | 功能 | 低 | `writeExternal` 在生产包暴露但无对应 handler（调用即报错，死 API） | `preload.js:14` vs `ipc.js:192-197`（仅 dev 注册） | 打包版裁剪该 API，或注册空实现（推荐裁剪，收敛攻击面，见 D11） | `preload.js` / `build.js` | 0.5h |
| P5（minify 先行） | 性能 | 中 | bundle 9.5MB 未压缩、mermaid 全家桶占 ~74%、无分包、同步 script 阻塞首帧 | `scripts/build.js:20-29`（无 minify、无 splitting）；`index.html:162`（同步 `<script>`）；实测 minify 后 4.34MB（**-55%**）；2167 个输入文件 | `build.js` 开 `minify:true`（一行）；mermaid 动态 `import()` 拆包放中期（见 P5-拆包行） | `scripts/build.js` | 0.1 人日 |

### 2.3 中期（v0.1.45+，约 3.5~6.5 人日）

| 编号 | 维度 | 严重度 | 问题 | 证据（文件:行号） | 修复方案 | 涉及文件 | 工作量 |
|---|---|---|---|---|---|---|---|
| P4 | 性能 | 高 | Python 输出无背压 + 每 chunk 强制回流：每个 data 事件单独 send，渲染端每 chunk 一个 span + `scrollTop=scrollHeight`（强制 layout） | `main/python.js:182-187`；`renderer/python.js:18-27`；实测 2000 行 = 2.37s + 数千条 IPC | 主进程按 ~50-100ms 或 4KB 聚合 stdout/stderr 再 send（先到者）；渲染端批内一次 `DocumentFragment` append、批末才设 scrollTop | `main/python.js` / `renderer/python.js` | 0.5~1 人日 |
| P6 | 性能 | 中 | 全局搜索串行单线程：逐文件顺序 stat+readFile+全行 toLowerCase；无 Worker/进度/取消；3000 条结果一次性 DOM | `search.js:40-71`（顺序 for await）、`:61-67`；`globalsearch.js:30-32`、`:42-89`；实测 30MB/300 文件 ≈120ms、1GB 工程 ≈4s（期间主进程事件循环被占）、3000 行 DOM 22.4ms | 搜索逻辑迁 `utilityProcess`/`worker_threads`（主进程只转发），支持取消与进度；渲染端结果分批渲染（先 200 条 +「加载更多」/虚拟滚动） | 新增 worker 文件 / `preload` / `globalsearch.js` / `search.js` | 1.5~2.5 人日 |
| P7 | 性能 | 中 | 大文件全量进出内存 + IPC 全量拷贝：readFile 整读、doc.toString() 整写、上限可配 2048MB | `ipc.js:106-124`（读）、`:127-132`（写）；`settings.js:44-61`（maxFileSizeMB 默认 50）；`app.js:584-598`（可调至 2048） | Range 分段读 + CM 分段注入（改动大，建议 v0.1.45+） | `ipc.js` / `tabs.js` | 1~2 人日 |
| P8+P9+P10 | 性能 | 低 | ① `fs.watchFile` 每标签一个 500ms 轮询（50 标签 = 50 轮询）；② 启动串行恢复会话（逐标签 openFile）；③ 文件内搜索每次全量重建结果 DOM + 每匹配行 toLowerCase×2 | `filewatch.js:53-67`；`tabs.js:254`、`:741-787`；`app.js:892-897`、`:335-365`；`find.js:21-35`、`:47-73`、`:135`；实测 2000 匹配 11.5ms/次 | ① 评估换 `fs.watch`（Windows 稳定性风险，见 D 附录）；② 会话恢复并行限流；③ 结果 DOM 复用/仅更新计数 | `filewatch.js` / `app.js` / `find.js` | 0.5~1 人日 |
| P5（拆包） | 性能 | 中 | mermaid 全家桶（mermaid 29.4% + parser 14.3% + cytoscape 11.6% + fcose 3.4% + katex 6.3% + d3 系 ~12% + dompurify/iconify/roughjs/stylis 等）≈ bundle 74% | `preview.js:1-3`（mermaid 静态 import）；`scripts/build.js:20-29` | mermaid 改动态 `import()`（esbuild splitting 或独立 entry），预览遇图才加载 | `preview.js` / `scripts/build.js` / 打包 asar 验证 | 1~2 人日 |

### 2.4 滑块宽度专项（SB）：确定的根因与最小修复

#### 2.4.1 根因（证据链闭环）

| 链路环节 | 代码位置 | 状态 |
|---|---|---|
| 设置定义 | `src/main/settings.js:11`（ALLOWED_KEYS 含 scrollbarWidth）、`:49`（DEFAULTS=10） | ✅ 正常 |
| 面板取值/clamp | `src/renderer/app.js:618-626`（6~40 输入框）、`:744`（`Math.min(40, Math.max(6, parseInt(...)\|\|10))`） | ✅ 正常 |
| 保存后应用 | `app.js:758` `applyScrollbarWidth(patch.scrollbarWidth)` | ✅ 正常 |
| 变量注入 | `app.js:31-34` `document.documentElement.style.setProperty('--scrollbar-width', w+'px')` | ✅ 正常 |
| CSS 变量定义 | `styles.css:722` `:root { --scrollbar-width: 10px; }` | ✅ 正常 |
| CSS 规则引用 | `styles.css:723` `::-webkit-scrollbar { width: var(--scrollbar-width); ... }`（全仓库唯一 webkit 规则） | ✅ 规则存在 |
| **实际渲染** | **设置后界面滚动条宽度无任何变化（用户报告）** | ❌ **故障点** |

**罪魁祸首**：`src/renderer/tailwind-input.css:12-15` 的 `@plugin "daisyui"` 编译产物 `src/renderer/dist/tailwind.css` 中，daisyUI 5 基础层注入了：

```css
:root { scrollbar-color: currentColor #0000; }
@supports (color:color-mix(in lab, red, red)) {
  :root { scrollbar-color: color-mix(in oklch, currentColor 35%, #0000) #0000; }
}
```

- `scrollbar-color` 是 **CSS Scrollbars 标准属性且可继承** → 从 `:root` 继承到应用内**每一个元素**；
- Chromium 121+ 行为：**标准 `scrollbar-color`/`scrollbar-width`（非 auto）优先于非标准 `::-webkit-scrollbar` 伪元素样式**，滚动条改走标准渲染路径，webkit 宽度被忽略（参考 [makandracards: Chrome 121 后标准属性覆盖 -webkit-scrollbar](https://makandracards.com/makandra/617528-chrome-121-supported-spec-compliant-scrollbar-properties)、[Stack Overflow: webkit-scrollbar 在 Chrome 121 失效](https://stackoverflow.com/questions/77901632)、[Chrome for Developers 滚动条样式文档](https://developer.chrome.com/docs/css-ui/scrollbar-styling)、[daisyUI Discussion #3113](https://github.com/saadeghi/daisyui/discussions/3113)、[henripar/scrollbar#17](https://github.com/henripar/scrollbar/issues/17)）；
- v0.1.42 及以前无 daisyUI → 无 `scrollbar-color` → webkit 规则正常生效。**v0.1.43 变量化重构「红线③保留」了变量与规则，却未察觉 daisyUI 注入的标准属性**，属版本回归（CHANGELOG v0.1.43 未提及滚动条）。

**冒烟为何漏检**：`scripts/smoke.js:608-617` `scrollbarSetting` 只断言 `getSettings` 往返 + `--scrollbar-width` 计算值在 6~40 内——**变量确实被设置了，所以测试全过；它从未验证「渲染宽度」**，与用户「变量改了、视觉没变」完全吻合。

#### 2.4.2 探针实证（Electron 43.3.0 / Chrome 150，加载真实 dist/tailwind.css + 复刻 styles.css 规则）

| 场景 | 规则声明宽度 | 实际渲染宽度（offsetWidth−clientWidth） | 判定 |
|---|---|---|---|
| 0 裸环境（无 webkit 规则，daisyUI 生效） | auto | 15px（OS 默认） | 基线 |
| 2 **应用真实条件**（daisyUI + webkit 规则 + var=30） | 30px | **15px** | 🎯 **复现 bug：规则在、渲染被劫持** |
| 3 **修复 A：`scrollbar-color: auto`** | 30px | **30px** | ✅ 修复生效 |
| 3b 修复 A：var=14 | 14px | **14px** | ✅ 随设置联动 |
| 4 修复 B：webkit `!important` | 30px | 15px | ❌ **!important 无效**（问题在渲染路径，不在层叠优先级） |
| 5 标准 `scrollbar-width: thin` | 30px | 15px | `.tabs` 的 thin 同样劫持 |
| 6 标准 `scrollbar-width: 30px` | 30px | 15px | 无效声明（标准属性不支持像素宽度） |

补充：修复 A 生效后，thumb 颜色（`#cbd5e1`）与宽度一并恢复；`scrollbar-width: thin` + 修复 A 时宽度被压成 10px，`auto` 时恢复 30px → **`.tabs` 的 thin 必须一并处理**。

#### 2.4.3 最小修复（v0.1.44，探针实证有效）

利用 styles.css 后加载且 unlayered（无 @layer）压过 tailwind.css 的层叠关系：

```css
/* styles.css —— 滚动条块（722-726 行）末尾追加 */
/* v0.1.44：daisyUI 在 tailwind.css 注入 :root{scrollbar-color:currentColor transparent}，
   标准属性(非 auto)使 Chromium 忽略 ::-webkit-scrollbar 宽度 → 设置失效。显式还原 auto。 */
:root { scrollbar-color: auto; }
```

```css
/* styles.css:366 —— 配套必改 */
.tabs { scrollbar-width: thin; }   /* 改前 */
.tabs { scrollbar-width: auto; }   /* 改后（或直接删除该行）*/
```

建议顺带（设计取舍，非必需）：`.styles.css:724-725` thumb 色由固定 `#cbd5e1` 改为 `color-mix(in oklab, var(--mh-text) 35%, transparent)`，暗色主题下随文字色自适应（即 L4）。

**备选方案为何不采用**：B（webkit `!important`）——探针证伪，渲染路径问题与层叠优先级无关；C（改 tailwind-input.css 源）——需重新编译，且 unlayered 的 styles.css 层叠更稳、免 rebuild；D（放弃 webkit 走标准属性）——标准 `scrollbar-width` 只接受 `auto|thin|none`，**无法表达 6~40px 像素宽度**，直接砍功能。

**环境因素（非代码缺陷，影响可观测性）**：Windows「设置→辅助功能→视觉效果→自动隐藏滚动条」开启时，Chromium 使用 overlay 滚动条，**任何 CSS（含修复 A）都无法改变其宽度**。建议设置面板 hint 注明，冒烟测试自适应跳过（见 §4.2 代码中 `overlay` 判定）。

#### 2.4.4 影响面（全应用所有内部滚动容器）

`html, body { overflow: hidden }`（styles.css:11），页面级滚动条不存在，**所有滚动均在内部容器**；`scrollbar-color` 可继承 → 全应用滚动条宽度锁死为 OS 默认、thumb 颜色被 daisyUI 的 `currentColor 35%` 接管。受影响容器：文件树 `.file-tree`（:225）、收藏 `.fav-list`（:182）、全局搜索 `.gs-results`（:259/:587）、**CM6 编辑器 `.cm-scroller`**、预览 `.markdown-body`（:800）、图片查看 `.image-host`（:425）、标签条 `#tabs`（:365，:366 thin 二次劫持）、文件内搜索 `.find-results`（:587）、Python 输出 `.py-output`（:618）、AI 面板 `.ai-messages`（:1042/:1077）、设置弹窗 `.modal-body`（:654）、mermaid 查看器 `.viewer-stage`/`.table-wrap`（:927/:838）。

---

## 3. 性能优化路线

### 3.1 Top 5 性价比排序（改动量 | 收益）

> 「性质」列标注：**存量** = v0.1.38 评审已知遗留；**v0.1.43 新增** = 本轮新增回归/风险（含已实测排除项）。

| 排名 | 优化 | 改动量 | 收益 | 性质 | 涉及文件 | 估时 |
|---|---|---|---|---|---|---|
| 1 | **击键防抖 + mermaid 按内容哈希缓存**（P1+P2）：`onDocChanged` 里 `preview.render()` 与 `find.runSearch(true)` 加 ~150-250ms trailing 防抖（与自动保存共用节奏）；`renderMermaid/reRenderMermaid` 对同一 `src`+`theme` 缓存 SVG 跳过重渲染 | 小（app.js + preview.js 各 ~20 行 + 一个 debounce 工具函数） | 消灭最痛的打字卡顿：200KB 文档每键 ~30ms+ → 防抖窗口内只算一次；1MB 文档每键 150ms+ → 可接受；mermaid 图不变不再重画 | 存量 | `app.js` / `preview.js` | 0.5~1 人日 |
| 2 | **主题切换 mermaid 重渲染瘦身**（P3）：`refreshMermaid` 仅在明暗状态**实际变化**时才 `mermaid.initialize`+重渲；下拉连点用 renderToken 协议（已有）加节流 ~200ms | 小（preview.js ~10 行） | 多图文档翻主题从每次 0.2~4s 冻结 → 仅明暗翻转时重渲一次 | **v0.1.43 新增回归，成本极低** | `preview.js` / `app.js` | 0.25 人日 |
| 3 | **build.js 开 minify + mermaid 拆包**（P5）：`minify:true` 一行即得 9.5MB→4.3MB；更进一步 mermaid 改动态 `import()`（splitting/独立 entry），预览遇图才加载 | 中（minify 零成本；拆包需动 preview.js import + build.js + asar 打包验证） | 启动磁盘/asar/内存占用减半；拆包后再砍 ~74% 加载量；首帧更快 | 存量 | `scripts/build.js` / `preview.js` / `index.html` | minify 0.1 人日；拆包 1~2 人日 |
| 4 | **Python 输出背压 + 批渲染**（P4）：主进程按 ~50-100ms 或 4KB 聚合 stdout/stderr 再 send；渲染端批内一次 `DocumentFragment` append、批末才设 scrollTop | 中（main/python.js + renderer/python.js ~30 行） | 2000 行输出从 2.37s 冻结 → 几十 ms；IPC 消息数降 1~2 个数量级 | 存量 | `main/python.js` / `renderer/python.js` | 0.5~1 人日 |
| 5 | **全局搜索 worker 化 + 渐进回传**（P6）：搜索逻辑迁 `utilityProcess`/`worker_threads`（主进程只转发），支持取消与进度；渲染端结果分批（先 200 条 +「加载更多」）/虚拟滚动 | 中~大（新增 worker 文件 + preload/IPC 改动 + globalsearch.js 分批） | 1GB 工程搜索不再占主进程事件循环（保存/设置不排队）、可取消、3000 行 DOM 不再一次性 22ms | 存量 | 新增 worker / `search.js` / `preload` / `globalsearch.js` | 1.5~2.5 人日 |

**v0.1.43 新增项说明**：真正新增的性能风险只有 **P3**（主题切换 mermaid 全量重渲染，已实测量化）与 **P11**（data-theme CSS 重算，已实测**排除**为主因：小 DOM 0.1ms / 3000 节点 7ms / 2 万节点 ~50ms，可保持现状；主题卡顿真正代价在 P3 的 mermaid 重渲）。其余 P1/P2/P4/P5/P6 均为 v0.1.38 评审遗留，至今未修复。

**候补（未进 Top5）**：P7 大文件按需读入（Range 读取 + CM 分段注入，改动大，建议 v0.1.45+）；P8 换 `fs.watch`（Windows 稳定性历史原因，风险中）；P9 会话恢复并行限流（小改、启动收益）；P10 结果 DOM 复用/仅更新计数（小改）。

### 3.2 实测数据（%TEMP% 探针，未触碰仓库）

| 探针 | 结果 |
|---|---|
| esbuild metafile（re-bundle） | 输入 9,555,224B；minify 后输出 4,338,117B（**-55%**）；2167 个输入文件；mermaid 生态（mermaid 29.4% + parser 14.3% + cytoscape 11.6% + fcose 3.4% + katex 6.3% + d3 系 ~12% + dompurify/iconify/roughjs/stylis 等）≈ **74%**（v0.1.38 记 68%，方向一致） |
| V8 parse+compile（vm.Script，Node 24） | 原始 9.1MB：72ms；minified 4.3MB：62ms——解析不是启动瓶颈，minify 收益在 IO/内存 |
| mermaid.render 单图 | 小流程图 25.4ms；40 状态 stateDiagram 191.7ms；串行 10 图 215.7ms（≈21.6ms/图） |
| data-theme 切换（真实级联，强制同步 layout） | 小 DOM 0.1ms；3000 节点 7ms；2 万节点 45-50ms——CSS 重算可忽略，主题卡顿主因是 mermaid 重渲染 |
| md.render 整篇（每击键成本） | 19KB：5.2ms；197KB：21.1ms；994KB：153.2ms |
| renderTabs 全量重建 | 50 标签 <0.5ms（比预期轻，非热点） |
| find.collect + 结果 DOM | 197KB 收集 0.8ms；2000 匹配结果 DOM 重建 11.5ms |
| 全局搜索结果 DOM | 3000 行一次性构建 22.4ms |
| Python 输出渲染（复制当前 append+scrollTop 逻辑） | 2000 chunk 2373.5ms（每 chunk 强制回流） |
| 全局搜索算法（复制 search.js 核心，30MB/300 文件） | ~120ms；量级 ≈3.5-4ms/MB，1GB 工程 ≈4s |
| 滚动条宽度（真实 tailwind.css+styles.css 级联） | 内联 `--scrollbar-width` 6/10/40px 在 html/.file-tree/通用容器生效；`.tabs` 的 thin 行为两探针结论不同（见 §6.2 证据冲突） |

---

## 4. 冒烟与回归

### 4.1 按修复类的冒烟用例建议

| 修复类 | 冒烟用例 | 断言要点 | 参考现状 |
|---|---|---|---|
| SB 滚动条（含 L3/L4） | `scrollbarSetting` 改造为三层断言（见 §4.2）：劫持守卫 + 伪元素计算值 + 真实渲染宽度（overlay 自适应跳过）；E2E 变体走真实用户路径（点 `#btn-settings` → 改 `#modal-body input[type=number]` → 保存） | ① `scrollbarColor === 'auto'`；② `::-webkit-scrollbar` 伪元素宽 === 设置值；③ 经典滚动条机器 `offsetWidth-clientWidth === 设置值` | smoke.js:608-617 现只断言变量往返 |
| H1 mermaid 冷启动主题 | `themeApplyDirect`（设为 night/dark）后打开含 mermaid 的 md，断言 `.mermaid-wrap svg .node` 填充为暗色系 | fill 非 `rgb(236,236,255)`（default 浅色） | 现无冷启动主题断言 |
| M1 遮罩还原主题 | 设置弹窗改主题 → 点遮罩关闭 → 断言 `data-theme` 还原为已存设置值；再点「取消」按钮路径回归 | `data-theme === getSettings().theme` | smoke themeApplyViaUI 只测按钮路径 |
| M2 弹窗宽度泄漏 | 打开图片查看器 → 遮罩关闭 → 打开设置弹窗 → 断言 `#modal-box` 宽度非 860px | 宽度还原 | 现无 |
| M3 外部文件粘贴图片 | 拖入工作目录外 md → 粘贴剪贴板图片 → 断言 toast 非「路径不在当前工作目录内」且图片文件生成 | 图片文件存在 | 现无 |
| M4 mermaid 补渲竞态 | 打开多图大 md 立即切主题 → 等待 → 断言无 `pre>code.language-mermaid` 残留（全部已渲染） | 残留计数 === 0 | 现无 |
| L 组 CSS/文案 | computed style 断言：`.tab` height===auto、justify-content===flex-start；aqua/forest `colorScheme==='dark'` 且归深色组；thumb 计算色非 `#cbd5e1`（若采纳 D3）；dark 下 blockquote 背景非 `#f0fbf9` | 各项 computed 值 | 现无 |
| L6 会话恢复 | 打开若干文件 → 外部删除 2 个 → 重启 → 断言无 alertBox 弹出、其余文件正常恢复 | alertBox 计数 === 0 | 现无 |
| L7 SVG 粘贴 | 复制 SVG → 粘贴 → 断言生成文件扩展名为 svg 且内容合法 | 文件存在 | 现无 |
| P1+P2 击键防抖 | 输入 5 个字符 → 断言 `preview.render` 调用计数为 1（防抖合并）；同内容二次渲染 mermaid → 断言无重渲（缓存命中） | render 计数 / 重渲计数 | 现无（性能探针可另立 bench 脚本） |
| P3 主题切换瘦身 | 多图文档主题下拉连点 5 档（同明暗）→ 断言 mermaid 重渲次数 ≤ 1（或 0）；明暗跨界 → 断言恰好 1 次 | 重渲计数 | 现无 |
| P5 minify | 构建后断言 `dist/bundle.js` 体积 < 5MB（minify 后 4.34MB 基准） | 构建产物尺寸 | 现为 build 脚本步骤，无断言 |
| P4 Python 背压 | 输出 2000 行 → 断言总渲染耗时预算（如 <500ms）且 UI 可交互（期间能响应 IPC） | 耗时/响应性 | 现无 |
| P6 搜索 worker | 大目录搜索 → 中途取消 → 断言立即生效；搜索期间保存文件 → 断言保存即时响应（主进程不阻塞） | 取消/响应性 | 现无 |

### 4.2 scrollbarSetting 用例改造（三层视觉断言，含 overlay 自适应）

```js
await step('scrollbarSetting', async () => {
  await api.setSettings({ scrollbarWidth: 16 });
  const s = await api.getSettings();
  const varVal = getComputedStyle(document.documentElement).getPropertyValue('--scrollbar-width').trim();
  // ① 劫持守卫：标准属性必须为 auto，否则 webkit 宽度不参与绘制（本次 bug 的直接断言）
  const sc = getComputedStyle(document.documentElement).scrollbarColor;
  // ② 规则计算值：伪元素宽度应等于设置值
  const el = document.querySelector('#file-tree');
  const pw = el ? getComputedStyle(el, '::-webkit-scrollbar').width : '';
  // ③ 真实渲染宽度：仅经典滚动条机器断言（overlay 下 offsetWidth-clientWidth 恒 0，跳过）
  const det = document.createElement('div');
  det.style.cssText = 'position:absolute;width:50px;height:50px;overflow:scroll;visibility:hidden';
  document.body.appendChild(det);
  const overlay = det.offsetWidth - det.clientWidth === 0;
  det.remove();
  // 变量直接按 applyScrollbarWidth 同路径注入，保证本次设置即时生效（API 直改不触发 UI 应用）
  document.documentElement.style.setProperty('--scrollbar-width', '16px');
  await new Promise(r => setTimeout(r, 100));
  const layoutOk = overlay || !el ? true : el.offsetWidth - el.clientWidth === 16;
  const varNum = parseInt(varVal, 10);
  return s.scrollbarWidth === 16 && varNum >= 6 && varNum <= 40
    && sc === 'auto' && pw === '16px' && layoutOk
    ? true
    : 'saved=' + s.scrollbarWidth + ',var=' + varVal + ',sc=' + sc + ',pw=' + pw
      + ',layout=' + (el ? el.offsetWidth - el.clientWidth : 'n/a') + ',overlay=' + overlay;
});
```

E2E 变体（可选，走真实用户路径）：模拟点 `#btn-settings` 打开设置弹窗 → 改 `#modal-body input[type=number]`（scrollbarWidth 字段）→ 点「保存」→ 再断言上述 ①~③（smoke 框架已有同类 DOM 交互先例，如 :631 行新建文件流程）。

### 4.3 回归范围

- 全量 smoke：现有 102 项必须全绿（含改造后的 scrollbarSetting）。
- 视觉抽查：36 主题换肤抽查 8 主题（含 aqua/forest 分组修正后），重点暗色主题（night/dark）下的 mermaid、blockquote、AI 面板、滚动条 thumb。
- 手动滚动容器清单（SB 修复后逐项目检）：`.file-tree`、`.fav-list`、`.gs-results`、`.cm-scroller`、`.markdown-body`、`#tabs`、`.find-results`、`.py-output`、`.ai-messages`、`.modal-body`、`.viewer-stage`、`.table-wrap`、`.image-host`。
- 环境适配：开启 Win11「自动隐藏滚动条」的机器上，冒烟 ③ 层自动跳过（overlay 判定），改由 ①② 层兜底；设置面板 hint 注明平台限制。
- 探针复验：`%TEMP%\mh-scrollbar-probe`（`electron probe-main.js`）在修复前后各跑一遍场景 2/3/3b，确认 15px→30px→14px 联动。
- 性能基准（可选，防回归）：`%TEMP%` 下保留 md.render/mermaid.render/Python 输出三支 bench，v0.1.44 首尾对比。

---

## 5. 待拍板问题

| 编号 | 问题 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 滚动条修复方案选型 | A：styles.css 追加 `:root{scrollbar-color:auto}`（探针实证有效）/ B：webkit `!important`（探针证伪）/ C：改 tailwind-input.css 源（需重编译）/ D：放弃 webkit 走标准属性（无法表达像素宽度，砍功能） | **A**（唯一探针实证路径，0.5h 免 rebuild） |
| D2 | `.tabs` 遗留 `scrollbar-width: thin` 处理 | 删除该行 / 改为 `auto` | **改 auto**（探针：thin+修复A→10px 仍劫持标签条横向滚动条；语义等价，保留可读性） |
| D3 | 滚动条 thumb 颜色是否随主题（L4） | 保留固定 `#cbd5e1` / 改 `color-mix(in oklab, var(--mh-text) 35%, transparent)` | **改 color-mix**（开发计划文档 §2.3 已明确要求随主题，属补落实） |
| D4 | 击键防抖窗口值 | 150ms / 250ms / 300ms trailing | **250ms**（与自动保存 800ms 节奏协调，消除输入法半字期抖动，感知延迟可接受） |
| D5 | mermaid 缓存策略 | 仅明暗跨界重渲（P3 最小解）/ 内容哈希+theme 缓存（覆盖 P2 击键重渲） | **两者结合**（防抖 + src+theme 哈希缓存，明暗跨界强制重渲） |
| D6 | minify 与 mermaid 拆包节奏 | minify 先行（0.1 人日）/ minify+拆包一次做完（1~2 人日） | **minify 先行**，拆包排 v0.1.45（拆包需动 preview import + asar 打包验证，不宜压进 0.1.44） |
| D7 | Python 输出背压聚合粒度 | 时间（50ms）/ 字节（4KB）/ 先到者 | **4KB 或 50ms 先到者**（大输出保吞吐、慢输出保延迟） |
| D8 | 全局搜索 worker 化排期 | v0.1.44 / v0.1.45 | **v0.1.45**（1.5~2.5 人日，占 0.1.44 预算过多；0.1.44 先保证「搜索期间保存不排队」的可接受度） |
| D9 | 大文件分段读（P7）排期 | v0.1.45+ / 搁置 | **v0.1.45+**（改动大，0.1.44 先不动，仅评估 maxFileSizeMB 上限合理性） |
| D10 | Win11 overlay 滚动条环境提示 | 设置面板加 hint / 仅文档注明 / 两者 | **两者**（平台限制非代码缺陷，hint 一句即可：「系统开启自动隐藏滚动条时宽度不可自定义」） |
| D11 | `writeExternal` 死 API 处理（L9） | 打包版裁剪 / 注册空实现 | **打包版裁剪**（收敛攻击面，配合 S1-S12 安全体系） |
| D12 | 会话恢复失败行为（L6） | 静默 + console.warn / 汇总一次 toast | **静默 + warn**（现已有 warn；alertBox 逐弹互相覆盖反而恶化体验） |
| D13 | 主题分组口径（aqua/forest，L1） | 移入深色组 / 保留浅色组加明暗徽标 | **移入深色组**（最小改动、口径与 DARK_THEMES 一致；徽标为增强项另议） |
| D14 | 用户环境复测（T1/T4，本机无法复现 overlay 场景） | 提供诊断包（一键导出 scrollbarColor/overlay/伪元素宽/OS 设置）/ 用户自查清单 | **诊断包**（复用 §4.2 断言逻辑产出一份 JSON 报告，用户跑一次即可定论） |

---

## 6. 附录

### 6.1 开放待确认项（T1~T4，多依赖用户机器环境）

| 编号 | 现象 | 已排除/已证实 | 未定根因 / 处置 |
|---|---|---|---|
| T1 | 「滚动条滑块宽度设置失败」用户报告 | 本机链路完全有效（真实应用 boot 应用 24px、真实文件树 webkit 宽 24px、setSettings 往返正常、applyScrollbarWidth 代码完整） | ① 标签栏 `thin`（L3，已并入 SB 闭环）；② 用户机器 Win11 overlay scrollbars（Chromium 忽略 webkit 规则，平台限制）；③ 可见滑块 = 设置值−4px 边框，6~10 区间变化不明显被误判。D14 诊断包定论 |
| T2 | `.tab` computed `display:flex`（styles.css 与 daisyUI 均声明 inline-flex） | 与功能无关（flex item 内部布局一致）；height/justify-content/text-align 泄漏（L2）已实锤 | `display:flex` 来源规则未定位（cssRules 枚举被 file:// 安全策略拦截）；不阻塞 |
| T3 | 保存后偶发「已从外部重新加载」toast | 未复现 | `markSelfWrite`（filewatch.js:70-77）与 500ms 轮询竞态：写入后轮询先于 mtime 记录触发一次误报；窗口毫秒级、dirty=false 时无感；观察记录即可 |
| T4 | 滚动条样式在 overlay 环境下整体失效 | 本机非 overlay（探针 thumb 生效） | 依赖用户 OS 设置，无法本地验证；D10 提示 + D14 诊断包 |

### 6.2 证据冲突与口径说明

1. **`.tabs` 的 `scrollbar-width: thin` 是否压制 webkit 宽度——两探针结论相反**：滑块专项探针（真实加载链）实测「thin + 修复A → 10px、auto → 30px」，结论 thin 会二次劫持；性能探针（同版本 Chromium）实测「thin 不压制 webkit 宽度」。两者测试环境细节（级联顺序、是否叠加 daisyUI scrollbar-color）存在差异。**处置**：以滑块专项探针为准（专测、复刻应用真实条件），保守起见 `thin` 一律清除（零风险），最终由 §4.2 冒烟 ①②③ 层断言一锤定音。
2. **L8 与 P3 是同一问题的功能/性能两侧表述**（主题下拉 change 全量重渲 mermaid），本计划按 P3 单列、L8 并入，避免重复计费。
3. **T2 `display:flex` 来源未定位**：file:// 安全策略拦截 cssRules 枚举；与功能无关，不阻塞发布。
4. **探针环境差异**：性能探针的 V8 parse 测试在 Node 24 下完成（Electron 43 内置 Node 版本不同），仅作量级参考；滚动条与 mermaid 探针均在 Electron 43.3.0 真实渲染环境完成，为结论依据。

### 6.3 已验证无问题（负向结论，防误报）

非法主题回退（探针 applyBogus → classic ✓）；主/渲染 36 主题清单一致 ✓；settings 白名单无漏键（theme/scrollbarWidth 均在）✓；设置保存链路完整（真实应用实测 boot 24px → 树滚动条 24px ✓）；「取消」按钮还原主题（smoke themeApplyViaUI ✓）；AI open_file 路径穿越校验（S8 ✓）；python 解释器校验 ✓；`.modal/.toast/.tabs` 撞名已显式覆盖 ✓；data-theme CSS 重算成本（P11）实测可忽略 ✓；`.tabs` flex-wrap 补丁已生效 ✓。

---

## 7. 工作量汇总（v0.1.44 口径）

| 范围 | 内容 | 估时 |
|---|---|---|
| 立即（P0 回归闭环） | SB + H1 + P3 + M1/M2 + M4 | 约 1~1.5 人日 |
| 短期（0.1.44 内） | P1+P2 防抖缓存 + M3 + L1~L5 + L6/L7/L9 + minify | 约 2~3 人日 |
| **v0.1.44 建议首发合计** | **立即 + 短期** | **约 3~4.5 人日**（与三份报告口径一致：专项 1.5~2h + 功能 0.9~1.6 人日 + 性能 Top3 ≈1~1.5 人日） |
| 中期（v0.1.45+） | P4 背压 + P6 搜索 worker + P7 分段读 + P8~P10 + mermaid 拆包 | 约 3.5~6.5 人日 |
| 全量 | 立即 + 短期 + 中期 | 约 7~10.5 人日 |

**执行建议**：v0.1.44 先发「立即 + 短期」；其中 P1+P2 与 P3 合计约 1 人日即可消除最痛的打字/切主题卡顿，建议与 H1（mermaid 主题体系）同批次实施，避免 mermaid 相关改动相互冲突。
