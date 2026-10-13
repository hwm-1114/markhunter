# AGENTS.md — MarkHunter 工作区指引

MarkHunter（马克猎手）是 Windows 桌面 Markdown/文本编辑器，Electron 43 + CodeMirror 6 + markdown-it + mermaid + **KaTeX**（v0.6.0 数学公式）+ Tailwind v4/daisyUI 5 主题引擎。中文注释与文档，无独立 lint/typecheck，靠 `npm run smoke`（真实窗口端到端，**232 项**：2026-10-13 起；沿革 **192 → 201 → 208 → 212 → 219 → 223 → 225 → 226 → 231 → 232**，明细见 `CHANGELOG.md`）回归；**判定一律用 `node scripts/smoke-verify.js`**，口径见「历史缺陷归档」首条告警。

## 常用命令

```bash
npm install          # 依赖（electron 走 npmmirror 镜像，见 electron-builder.yml）
npm start            # 启动应用（加载的是 src/renderer/dist/bundle.js，不是源码！）
npm run build        # esbuild 打包渲染进程 + mermaid chunk + tailwind.css（改渲染端源码后必须执行）
npm run dev:css      # tailwind watch（调主题样式时用）
npm run smoke        # 冒烟测试（--smoke 模式，仅开发环境；window.__app 测试接口 dev 独有）
                     # ⚠️ **必须前台跑**，且桌面前台不得被全屏游戏/独占全屏程序占住（否则 rapidSaveEcho 会卡死数分钟到永久）
node scripts/smoke-verify.js %TEMP%\mh-smoke.log --expect 232 --require reopenClosedTab,ctxMenuCommonItems,findCaseWordRegex,findMatchLimit,hugeRecoverPrompt,hugeRecoverReject
                     # 冒烟日志**唯一判定依据**（容忍 UTF-16 与 ANSI）：结果行数 = --expect N、`| false` 0、`| ERR:` 0、非白名单非-true 值 0
                     # ⚠️ 不要用 `SMOKE_OK` 判定（finally 里无条件打印）；detail 串（无 ERR: 前缀）同样是失败
node scripts/overlay-test.js        # 大文件 overlay 模型探针（纯 node，期望 OVERLAY_PROBE 14/14 failed=0）
node scripts/watch-rename-probe.js  # fs.watch × rename 覆盖探针（纯 node，期望 5/5，含 libuv 目录+文件同 watch 崩溃复现）
npm run release      # 本地打 NSIS 安装包（scripts/release.ps1）；加 -Publish 发 GitHub Releases
```

发布：改 `package.json` 版本 + `CHANGELOG.md` → 打 tag `vX.Y.Z` 推送 → `.github/workflows/release.yml` 自动构建发布。

## 目录结构与构建链路

- `src/main/` — 主进程（CJS）：`main.js`（窗口/CSP/导航防护/测试 profile 隔离）、`ipc.js`（文件 IPC + 编码检测）、`security.js`（路径白名单）、`settings.js`（白名单 + 主题清单；v0.3.0 起不再持有密钥）、`filewatch.js`（fs.watch + 轮询兜底）、`search.js`/`search-worker.js`（utilityProcess 全局搜索；大文件走原生字节快路径）、`lineindex.js`（大文件稀疏行索引 + 侧车缓存 + `huge:*` IPC）、`python.js`、`args.js`（右键 `--dir` 参数解析）。
- `src/preload/preload.js` — contextBridge，只暴露 `window.api.*`（IPC 通道白名单即此文件的镜像，加通道须两端同步）。
- `src/renderer/` — 渲染端（ESM 源码 → esbuild IIFE bundle）：`app.js`（组装入口）、`tabs.js`（标签/CM/大文件分段与分档）、`tree.js`、`preview.js`（markdown/mermaid）、`find.js`/`globalsearch.js`、`python.js`、`viewer.js`、`hugeview.js`（>1GB 虚拟滚动查看器）、`recover.js`（崩溃恢复 UI：`huge:doc-recover-list` 的渲染端消费方）、`favorites.js`、`ui.js`（弹窗/菜单/防抖/CHUNK 标记；`note()` = 应用级提示，类名 `mh-note`，与 `toast()` 视觉同源但**不落 `.toast`**）。
- 两个 `dist` 勿混淆：`src/renderer/dist/`（构建产物 bundle.js/mermaid-chunk.js/tailwind.css，随 asar 打包）与根目录 `dist/`（electron-builder 安装包输出）。
- 改渲染端源码不重建 = 运行无变化；`npm start` 不自动构建。

## 架构约定与红线

- **安全模型**（v0.1.39 加固，改动前读 docs/MarkHunter三维度评审报告.md）：渲染进程 sandbox + contextIsolation；主进程文件写/删/改名经 `security.js` 的 `requireApproved`（rootDir 内 or 曾成功 read 过的 approvedSet 路径；**v0.5.1 例外：`fs:create` 新建文件/目录全部放开、不再校验，且「创建即批准」—— 新建的文件/目录与递归新建的祖先自动进批准面，随后的写入/删除/改名可用；其余写路径口径不变**）；`settings:set` 键白名单 + theme 名单校验；CSP `script-src 'self'`（新增脚本只能同源注入，参考 preview.js 动态加载 mermaid chunk 的做法）；`fs:write-external` 仅 dev。
- **IPC 契约**：主→渲染事件（`file-changed`（含 `multiEdit` 字段）、`python:*`、`search:progress`、`settings:changed`、`file-shared-open`、`open-dir`、`huge:index-progress`、`huge:doc-save-progress`、`huge:doc-saved`、**`file-lock-changed`**）与 invoke 通道名都在 preload.js 集中声明；search:global 返回 `[{file,line,text,matchIndex}]` 上限 1 万（**v0.6.0 起文件名/目录名命中条目带 `kind:'name'|'dir'`（line=0）；内容命中缺省无 kind，替换等旧消费方零改动兼容**）；v0.4.0 大文件线新增 `huge:index`/`huge:line-offset`/`huge:offset-line`/`huge:lines`/`huge:index-drop`（`huge:index-progress` 订阅须退订）；**v0.5.0 Phase 4 跨窗口锁新增 `doc:claim-edit`/`doc:release-edit`/`doc:lock-state`/`doc:set-conflict-prompt`/`doc:get-conflict-prompt`**（锁表长在 `filewatch.js` 的 `watchers` 上，`entry.mode='edit'|'read'`；`file-shared-open` 的只读语义**未变**，接管走独立通道；大文件仍归 `overlay-ipc.js` 的 `WINDOW_NOT_OWNER`，两套规则并行）；**v0.5.0 Phase 5a 系统集成新增 3 条 `shell:open-path` / `shell:open-terminal` / `clipboard:write-text`**（都在 `ipc.js` 的 `registerFileIpc()` 内注册，统一先过 `guardApprovedExisting` = `security.requireApproved` + `statSync` 存在性校验；「在终端打开」的路径**只作 `cwd`**、`argv` 恒 `[]`、`shell:false`、`detached:true`、`stdio:'ignore'`，支持 `opts.dryRun` 只回执「将要怎么做」；剪贴板正文由**主进程按已批准路径自拼**，渲染端只传 `{path,kind}`，传 `text` 不生效）；**v0.6.0 文件树⇄系统剪贴板互通新增 3 条 `clipboard:copy-files` / `clipboard:read-files` / `fs:paste-files`**（也在 `registerFileIpc()` 内）：复制 = CF_HDROP（DROPFILES 结构 + **双 null 终止**）写系统剪贴板（Explorer 可直接 Ctrl+V），源逐条过 `guardApprovedExisting`；粘贴 = 读回 CF_HDROP 逐个 `fs.cp` 进目标目录，**源来自用户在资源管理器的复制动作、不要求白名单（语义同拖拽外部文件），目标目录必须 `requireApproved` + 存在**，ask 冲突模式整单预检（任一冲突即不落盘）；粘贴成功 `markSelfWrite` + `approve`。**崩溃恢复 UI（v0.5.0 挂账项）未新增任何通道**，完全复用既有 `huge:doc-recover-list` + `huge:doc-open`/`edit`/`close` + `fs:*`。
- **跨窗口「接管编辑」（v0.5.0 Phase 4）**：只读横幅 + 「✏️ 接管编辑」按钮**只在 `tab.readOnly===true` 时出现**（手动只读不会冒按钮）；接管成功 → 原窗口转只读 + toast，**不关窗、不弹原生对话框**；L3 冲突提示**默认关**（打开才不降级并显示 DOM 横幅；关掉时静默保留本窗口内容）。**B3 已修**：`fs.unwatchFile(path, entry.pollFn)` 只摘本窗口的 StatWatcher（不带 listener 会摘掉该路径全部监听 → 被打断的窗口永不重建轮询兜底）。
- **大文件编辑通道（v0.4.0 Phase D，实现在 `src/main/overlay-ipc.js`；其 `CHANNELS`/`EVENTS` 与 preload 的 `hugeDoc*`/`onHugeDoc*` 一一对应）**：16 个 invoke —— `huge:doc-open`/`close`/`state`/`lines`/`line`/`line-offset`/`offset-line`/`edit`/`insert`/`delete`/`splice`/`undo`/`redo`/`save`/`save-cancel`/`recover-list`；2 个事件 —— `huge:doc-save-progress`（进度 + 终态 `done`/`failed`，失败也必须发，否则进度条永久转圈）与 `huge:doc-saved`（保存成功后通知渲染端重建索引/重挂监听）。约定：**统一单对象入参**、行号 1 基、写通道必须带 `docId`（`huge:doc-open` 返回，同 realpath 复用、跨窗口拒绝），能否编辑取 `huge:doc-open` 的 `editable`/`reason`（GBK/二进制/超大单块 → 只读）。**两个事件订阅都返回退订函数，`hugeview.js` 的 `destroy()` 必须调用**（否则监听器随标签累积泄漏；保存进度订阅在 `save()` 的 finally 退订）；`huge:doc-save` 全程持该 doc 的串行锁，`save-cancel` 是唯一不取锁的通道。渲染端只经这些通道编辑/撤销/保存，**不在渲染端建文档状态机**。
- **崩溃恢复 UI（v0.5.0 挂账项，实现在 `src/renderer/recover.js`）**：`huge:doc-recover-list` 的**唯一渲染端消费方**（启动扫描恢复区 → 状态栏 chip + 应用级提示 → DOM 弹窗逐条「恢复 / 丢弃」）。**四条硬红线**：① **恢复前必须过两道身份闸** —— 当前源文件 `stat` 的 `size` 与 `floor(mtime)` 必须等于块表 `meta`，再用 `huge:doc-open` 返回的 `key` 对条目 key（拦 realpath 漂移，以及"闸①过了、打开前文件又变了"的竞态）；任一不符即**拒绝 + 红字可断言文案**（`.recover-error`）。② **绝不拿过期块表覆盖用户文件**；恢复与丢弃**都不写源文件**（恢复只进 overlay 会话与内存）。③ **失败收尾一律 `huge:doc-close({discard:false})`** —— 用 `discard:true` 会走主进程 `dropKey` **删掉用户唯一一份恢复数据**（踩过）。④ 丢弃 = **`others > 0` 一律拒绝、零 probe**（`recover.js:515-518`，可行动文案在 `:516`：「另一个窗口正在打开该文件：请先关闭那个窗口里的该文件标签…」）；`others === 0` 才直删（`readFileRange` 拿 approve → 删 `<key>.json` + `<key>.tmp`，`recover.js:528-529` → **删后 `api.stat` 残留复核**，`:534`）。**为什么不做 probe**（否决「身份相符才 probe」变体的理由逐条写在 `recover.js:498-509`）：probe 的收尾 `hugeDocClose({discard:false})` 在 overlay 侧是**无条件** `persistMeta()`（`overlay.js:1220-1221 → :1164-1171 → writeMeta :351-358`），会**覆盖 `<doc.key>.json`**；当 `doc.key !== item.key`（过期条目的典型场景）时把用户**更新的**未保存内容写成 `dirtyBlocks=0`（随后被 `overlay-ipc.js:670` 滤掉）= **数据丢失**。**身份校验块已删除**：去掉 probe 后它不再决定任何分支，且「身份不符 ≠ 无人使用」（活会话的 key 是它打开那一刻算的）。代价 = 别的窗口**只打开**该文件时不能丢弃 ⇒ **已顺延 0.5.1**（给 `huge:doc-close` 加 `persist:false` 后即可放宽）。提示统一走 `ui.js` 的 `note()`（`mh-note`，**不落 `.toast`**，以免污染既有按 `.toast` 收集文案的断言）。
- **`doSaveNow` 的返回值约定（v0.5.0 起）**：`kind==='huge'` 且 `!hv`（关闭标签时视图已被销毁）返回 **`false` = 本次没有发生写盘**（**不等于"写失败"**），调用方**不得**据此认为内容已落盘；`trackClosedSave` 对 huge 与普通标签走**同一条"按返回值推导 `savedOnClose`"**的路径（不再硬编码）。将来若把关闭路径改成"真的先保存再关"，用例 `huge-close-does-not-write-disk` 会立刻变红 —— 那正是需要同步改降级断言的地方。
- **大文件分段（P7）**：>4MB 文件走 chunked 标签（kind='chunked'），文档尾部有 `<!-- MH-CHUNKED … -->` 占位标记——**任何写盘/预览/读取文档路径都必须先 `stripChunkMarkers`（且必要时 `ensureFullyLoaded`）**，否则污染文件。tabs.js `saveNow` 是正确范例（v0.3.0 起消费方只剩预览与保存：AI 功能已整体移除）。
- **主题**：56 皮肤清单在 settings.js（主进程）与 app.js（渲染端分组）两处维护，需同步；暗色 25 款 = `DARK_THEMES`（特效 fx-* 20 款调色板在 tailwind-input.css、动画在 styles.css「特效皮肤」节）。滚动条宽度修复依赖 `styles.css` 的 `:root{scrollbar-color:auto}`，勿删。
- **mermaid**：lazy 动态加载 `window.__mermaid`，SVG 按 src+明暗 缓存（64 条 FIFO），注入前 `uniquifySvg` 唯一化 id；`renderToken` 协议丢弃过期渲染。
- **文件监听**：`fs.watch` 失败自动回退 `fs.watchFile` 1000ms 轮询；自写识别靠 `markSelfWrite`（写后 stat mtime 一次性匹配）。**实测（`node scripts/watch-rename-probe.js`）**：① overlay 保存的 `rename` 覆盖**不会**让 `fs.watch(文件)` 失效（保存后外部修改照常触发，无需重挂），但 rename 本身会在 watcher 上产生 `rename` 事件——这正是自写回声守卫存在的原因；② 同一目录下同时 watch 多个文件正常（多标签日常形态）；③ **同进程里同时 watch 一个目录和它内部的文件会让 Node/libuv fail-fast 崩溃**（`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`，退出码 0xC0000409）——当前应用只 watch 文件所以不踩，**将来给文件树加目录监听时必须避开这个组合**（改轮询或分进程）。

## 历史缺陷归档（修复后请删条目）

> ⚠️ **`SMOKE_OK` 不等于全绿**（2026-08-30 实证）：`scripts/smoke.js` 的 `SMOKE_OK` 是在主流程 `finally` 里**无条件**打印的，只代表「套件跑完、没有顶层 `E2E_ERROR` 异常」。用例抛异常时结果行是 `- 名字 | ERR: ...`，**既不是 `true` 也不是 `false`**。**更隐蔽的一种失败**：`step()`/`runCase()`/`mvCase()` 的约定是「判定通过打印 `true`，否则打印 **detail 字符串**」——detail 串**没有 `ERR:` 前缀**，只看 `false`/`ERR:` 会把它当"信息型真值串"而误报全绿（2026-08-30 父 agent 就这么误报过一次「208 全绿」，实际有 5 条红）。所以验收必须用 `node scripts/smoke-verify.js <日志> --expect N --require a,b,c`：它只把**第二列**当值（`- 名 | 值 | 证据`），并要求「值必须 `true`，除非用例名在信息型白名单里」（白名单可用 `--info` 追加）。**判定四元组缺一不可**：`结果行数 == --expect N`、`| false` = 0、`| ERR:` = 0、「非白名单的非-`true` 值」= 0。**冒烟只能前台跑**，且**桌面前台不得被全屏游戏/独占全屏程序占住**（卡死判据：electron 累计 CPU 仍是个位数秒 + `.smoke-test` 停在 `echo.md`（= 卡在 `rapidSaveEcho`，`smoke.js:796-822`）+ 测试目录数分钟零写盘；处置见 `docs/交接-会话纪要.md` §7）。**窗口必须在前台且未被遮挡**：① 会话保持类用例依赖 `persistSession` 的 `document.hasFocus()` 守卫，失焦即必然假红（`layoutPersist`/`layoutBackCompat` 的 detail 串会带 `hasFocus=false`）；② 依赖定时器的用例（如 `findMatchLimit` 的防抖，`find.js:40` 只有 80ms）在窗口被遮挡时会撞上 Electron 默认的 **`backgroundThrottling`**（定时器被节流到 ~1s 级）。**这两类是"假红"，不是产品缺陷**；判据是同一版在窗口前台时重跑转绿。另：运行期间**源码/脚本/产物写手必须停笔**（`src/**`、`scripts/**`、`package.json`）—— 判定有效性的清单只有这些；`AGENTS.md`/`CHANGELOG.md`/`README.md`/`docs/**` 的写入**不影响判定**（不进 bundle、不参与 `smoke-verify`），但**必须在验收记录里单列登记**（哪几个文件、什么时刻）。本轮验收约定更严：captain 广播 `SMOKE STARTING` → `SMOKE DONE` 之间**全体停笔**（含文档），以免证据链需要额外解释。
> ⚠️ **改 `smoke.js` 的三个坑**（2026-08-30 实证，写新用例前必读）：
> ① **内嵌渲染端测试体里不能出现裸反引号**：`RENDERER_TEST` 是一整个模板字符串，注释/字符串里写 `` `editable` `` 会**截断模板**，而 `node --check` 只看外层文件、**不校验字符串里的代码**（报错会以 `Unexpected identifier` 的形式出现，容易误判）。改动后要么做「取出展开后的字符串再 `new Function` 校验」的专项检查，要么注释里用「」代替反引号。
> ② **想测「外部修改」不能用写盘 IPC**：`api.writeFile`/写盘通道**都会 `markSelfWrite`**（`ipc.js:172/202/316/369/419`），事件会被 `filewatch.js:74-87` 的 mtime+size 匹配吸收；`fs:write-external` 虽不 mark，但它是**整串覆盖写**（大文件经 IPC 传字符串不可行）。真·外部写只能在**主进程段**用 `fs.appendFileSync` 之类直接写盘。
> ③ **等够三道自写回声守卫再断言**：`filewatch.SELF_WRITE_GRACE_MS = 2000` + `tabs.js` 普通分支 `lastSavedAt` 1200ms + **huge 分支 `hvSt.savedAt` 3000ms** → 现有 `hugeWatchAfterSave` 等 **3600ms**；等待不足会得到「假阴性」（事件被当回声吞掉）。

（空 —— 2026-08-22 审计的 5 项 + 验证期新发现的分段保存竞态已在 v0.1.46 全部修复，高频编辑误报外部修改已在 v0.1.47 修复，新建落错位置/树不刷新已在 v0.1.48 修复，明细见 CHANGELOG；修复验证口径：`npm run smoke` 全部通过（v0.4.0 起 192 项：含 Phase 0 回归 11 项、大文件 7 项 —— Phase B 4 项 + Phase D 编辑 3 项、右键 `--dir` 打开 + 测试 profile 隔离 6 项；AI 相关 10 项已随功能移除），其中 5 项为信息型结果（返回携带信息的真值串，非失败；具体是哪 5 项随实现微调，以 `E2E_RESULTS` 里非 `true` 且非 `false` 的行为准，如 `findAll`/`pyUI`/`detectPython`/`runPython`/`hugeIndexCold`/`bundleSplit`）。冒烟窗口运行在真实桌面：偶发外部鼠标点击/负载抖动可能误报 UI 类用例，重跑即可；后台（run_in_background）运行时窗口拿不到焦点，`persistSession` 的 `document.hasFocus()` 守卫会让会话类用例（sessionRestore/pinSessionPersist/extSessionRestore）必然失败 —— 冒烟须前台运行；`largeFileChunk`/`menuPaste*` 已内置自适应轮询与重试。**冒烟期间桌面前台不能被「全屏游戏/独占全屏程序」占住**（2026-08-30 实测：League of Legends 全屏时冒烟窗口拿不到焦点，`rapidSaveEcho` 直接卡死数分钟到永久——表现为 `electron` 累计 CPU 个位数秒、`.smoke-test` 与隔离 profile 数分钟零写盘；判据与处置见 `docs/交接-会话纪要.md` §7）。大文件编辑用例（`hugeEdit*`）会用 `app.editor.setHugeThresholdMB(200)` 临时降档并在 `finally` 恢复 1024，且只编辑 `bd-280mb.bin` 的副本 —— 新增分档用例时勿与它们交叉。右键 `--dir` 6 项（`testIsolation`/`rcDirColdStart`/`rcDirCleanWindow`/`rcDirBadPath`/`rcDirDriveRoot`/`rcDirSecondInstance`）会在 `%TEMP%` 建临时夹具与脏 profile，并起真实子进程（`electron . --dir …` + `--remote-debugging-port` 经 CDP 读子进程 DOM）；用例排在全部既有用例之后，结束时 kill 子进程树并删夹具 —— 改动 `rcDir*`/`testIsolation` 时勿把它们的窗口留在运行中。）

## 文档索引（改敏感区前先读）

- `docs/修复计划-Bug与性能排查.md` — 历史编号体系（SB/H/M/L/P/T）与根因证据，CHANGELOG 与代码注释均引用这些编号。
- `docs/多主题改造回归风险与控制-0.1.43.md`、`docs/开发计划-主题引擎映射方案-0.1.43.md` — 主题引擎口径。
- `CHANGELOG.md` — 每版修复清单（搜编号可定位代码注释）。
- `docs/缺陷清单-0.2.5-审计.md` — A/B 编号缺陷与右键盘符场景证据（Phase 0 的输入）。
- `docs/开发计划-多视图与体验流畅度-0.3.0.md` — 多视图方案（Phase 1–4 已顺延 0.5.0）与体验 11 条。
- `docs/开发计划-大文件秒开与秒搜-0.4.0.md` — 大文件线 A–E 状态、实测指标、Phase D 切片。
- `docs/交接-会话纪要.md` — 上下文压缩后的续接锚点（状态 / 下一步 / 验证口径）。
