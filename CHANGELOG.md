# 更新说明（Changelog）

## v0.10.0（2026-10-18）

主题：**大文件视图补齐最后两项能力 —— 视图内 Ctrl+F、索引未覆盖区域的真实内容预览**。

### 视图内 Ctrl+F（大文件视图）
- huge 视图不再提示「当前视图不支持文件内查找」：Ctrl+F 打开查找面板即可搜**当前文件**，结果列表显示行号 + 命中文本（点击跳转，`Enter` / `Shift+Enter` 上下条），跳转把命中行顶到视口并高亮当前项。
- 新增单文件搜索通道 `search:file`（worker 的 `runFileSearch` 与目录搜索**共用** `scanFileInto`）：>128MB 走多线程分片、编码探测、每行最多一条，口径与全局搜索一致；5GB 首次搜索 ≈0.8–1.0s，2.2MB 夹具 60 处命中 11ms。
- 明确的口径提示（不静默）：结果区标注「按磁盘内容搜索（未保存的修改不在结果中）」；`Aa / 整词 / 正则` 在 huge 视图不生效时显式提示；替换被拒绝（`replaceCurrent/replaceAll` 返回 0 + toast），避免把只读磁盘内容当 CM 文档改。
- 切标签/改词/连续输入用请求令牌丢弃过期结果；异步搜索期间显示「搜索中…」。

### 索引未覆盖区域：按字节偏移直读预览
- 索引建立中跳到尚未扫描的区域，不再只画进度占位：按滚动比例把目标行换算成字节偏移，直接从文件读一片真实内容显示（4MB 上限、行首对齐、UTF-8/GBK 探测）。**行号是估算值**（行号列带 `~`、斜体弱化），状态栏写明「行号为估算（内容直读，可浏览/选中复制；编辑需等索引就绪）」。
- 预览态的安全边界：禁止落光标/进入编辑（估算行号会改错行）；无选区 Ctrl+C 复制的是**预览文本**（不再报「无内容可复制」）；选中复制照常走原生选区。
- 进度推进**不逐个事件重画**（每个事件重读 4MB 会把顺序扫描拖慢 —— 10GB 实测索引从 5.4s 拖到 156s）：只在扫描真正越过视口字节位置时重画一次，换回真实行号与精确落位。
- 实测（bigperf）：跳转未扫描区域 **5GB 92ms / 10GB 78ms** 出真实内容（此前要等扫描到位 0.23–1.37s）；索引期间 5 个落点 5GB **54–68ms**、10GB **72–144ms**；索引耗时不受影响（5GB 2051ms、10GB 5443ms）。
- 新增 IPC `huge:lines-by-offset`（只读、不建索引、不写侧车）。

## v0.9.1（2026-10-18）

收尾轮（v0.9.0 未发版，本版为首次发布）：**默认上限 10GB + 保存期间视口不冻结 + 中文关键词分片**。

### 默认上限 10GB（用户决策）
- `maxFileSizeMB` 默认值 50MB → **10240MB**：5GB/10GB 文件**开箱即开**，不需要先去设置里调整；可调范围仍是 1~20480MB，超过上限照旧拒绝并弹「文件过大，未打开」（`boundaryViewer` 用例显式把上限降到 4096 验证拒绝路径，不依赖默认值）。

### 保存：5GB 5.0s / 10GB 9.7s；**保存期间不再冻结视口**
- `huge:doc-lines`（只读视口取行）在保存进行中不再排到文档串行锁后面：保存只读文档状态、不写块表，读路径自身只读；写通道仍全程串行。`bigperf.saveScroll`：5GB 保存 5.3s 期间 8 次跳转 **avg 9ms / max 11ms**，10GB 保存 10.4s 期间同样 avg 9ms（旧实现要等保存结束才返回）。

### 搜索：中文 / 非 ASCII 也分片（5GB 4.4s → 0.91s，10GB ≈1.9s）
- **按行边界切片**：每片起点/终点都用「pos 之后第一个换行」对齐 → 不存在跨片命中与行号歧义、不需要重叠；编码由协调方读文件头 8MB 统一探测（严格 UTF-8 → GBK）；语义与串行一致（每行最多一条、文本截断 1000 字符）。非 ASCII 查询 >128MB 即走分片，任一分片异常自动回退串行。
- **串行回退本身也提速一倍**（4.4–5.1s → 2.2s）：逐行 `slice` 改一次 `split('\n')`；查询串不含大小写映射字符（纯中文/数字/符号）时跳过每行 `toLowerCase`。
- **修复编码误判（真缺陷）**：首块探测原先固定截掉尾部 4 字节，若截点落在多字节字符中间，会把合法 UTF-8 文件误判成 GBK（实测：中文 + CRLF + 末尾无换行的文件整份搜索 **0 命中**）。改为以「块内最后一个换行」为界做严格 UTF-8 校验，无换行时才回退截 4 字节。
- 探针：`node scripts/search-shard-probe.js` 8 → **15 项**（新增 UTF-8 中文、GBK、CRLF、行边界归属、编码探测等价用例，全部与串行结果逐字段比对）；`npm run bigperf` 新增 `searchCJK` / `saveScroll`。

## v0.9.0（2026-10-17）

主题：**5GB / 10GB 大文件「秒开 + 连续滚动不卡 + 秒搜 + 打字跟手」**（对标 EmEditor；`npm run bigperf` 真实夹具实测）。

### 打开：首屏不再等整份行索引（5GB 1952ms → 38ms，10GB 4484ms → 24ms）
- **渐进行索引取数**：`huge:lines` 不再 `await` 整份行索引 —— 主进程扫描时每读完一个 8MB 块即发布「已扫描前缀」行首表，视口取行直接吃这份前缀（行号仍精确）；目标行尚未扫到时立即返回 `{ pending:true, scannedLines, scannedBytes }`（不阻塞），渲染端画带进度的占位并由进度事件驱动重试。
- **第 1 行永远不等索引**：没有任何前缀时直接从文件头按字节读一屏（`readLines` 的 head 快路径），首屏因此与索引大小无关。
- 索引进度改为向**所有窗口**广播（此前只发给发起 `huge:index` 的窗口；首个视口取数也会拉起扫描，先渲染后索引的窗口此前看不到进度）。
- 挂载首帧不再只画 1 行：估算行数一就位就补一帧满屏渲染；`getState().indexed` 语义修正为「整份索引已**画出**」（消除「indexed=true 但 DOM 还是半屏/占位」的竞态，冒烟 `hugeSelectCopy` 曾因此偶发拿不到选区）。
- **索引建立期间下拉不假死**：5GB 在 10%/25%/50%/75%/90% 五个落点分别 0.23 / 0.40 / 0.48 / 0.53 / 0.31s 出字（等扫描推进到该位置，期间可继续滚）；10GB 为 0.56–1.37s。索引就绪后任意跳转 6–8ms。

### 连续滚动：拖动/滚轮全程无长帧
- 实测（5GB / 10GB，各跑两轮）：40 步拖滚动条（10%→95%）1.04–1.07s 内落定、最大帧间隔 8.3–9.5ms（p95 ≤ 6.8ms）；60 格滚轮最大帧间隔 8.2–9.9ms；单次视口重画（IPC+DOM）≤ 3ms（首帧含文件头读取约 25–43ms）。
- 索引建立期间滚动到已扫描范围即时出字，未扫描区域显示「已扫 N 行」的进度占位（不再是整屏空白等索引）。

### 搜索：5GB 20.2s → 0.72–0.99s；10GB 从「0 命中」到 0.72–1.04s
- **根因：锚点选错**。`nativeMatchesCI` 的字节频率表把非字母一律记 0，`"SECTION 2000000"` 的锚点落在**空格**上（英文文本约 18%）→ 5GB 产生约 6 亿次候选 `indexOf` 调用。改为全可见字符真实频率表（空格 180‰、字母按语料、数字/标点 0.2–9‰），锚点必然选到真正稀疏的字节（该查询锚点变数字 `2` = 7‰）。
- **多线程分片**：>128MB 的纯 ASCII 查询按字节切成 N 段（核数-1，上限 8），每段一个 `worker_threads` 线程跑同一套大小写折叠匹配；行号 = 各分片换行数的前缀和 + 片内偏移（不依赖行索引）；跨片命中用 needle-1 字节重叠兜住；任一分片异常自动回退串行扫描（非 ASCII 查询的分片见 v0.9.1）。
- **零分配读循环**（关键实测）：分片线程原先每 8MB 块 `Buffer.allocUnsafe` + `Buffer.concat`，在 Electron 的 worker_threads 里 640MB/片要 2.5s+（同样代码在 node 24 只要 0.6s）；改成「一片一个复用缓冲 + 尾部 needle-1 字节搬移」后单片 0.63s（5GB 全量 0.76s）。
- 大文件流式扫描上限 5GB → **20GB**（旧上限让 10GB 文件被**静默跳过** → 搜索 0 命中）。
- 回归探针 `node scripts/search-shard-probe.js`（**15/15**）：混合大小写、分片边界跨越、无换行巨文件、GBK 字节、maxResults 截断与顺序，以及新增的中文/UTF-8+CRLF/GBK/行边界归属/编码探测用例。

### 大文件视图：自动换行 + 删除悬浮操作条 + 滚动锚点修正
- **自动换行**（状态条「↵ 自动换行」按钮）：长行按视口宽度折行显示，行号只出现在逻辑行的第一个视觉行；行高按实测自适应、逐行累计定位（绝对定位 + 累计 top），滚动条仍按逻辑行映射。换行开启时滚动条末尾**补一屏空白**，保证最后一行能被顶到视口顶部完整阅读（否则直映模式下 maxScroll 只能到「总高 - 一屏」，末尾几行永远够不着）。单逻辑行最多折 `WRAP_MAX_ROWS=40` 个视觉行（约 800px），超出截断并提示（防 40000 字符单行把布局拖垮）；渲染窗按「上次实测平均行高」自适应收缩（1MB/行的长行文件：180 行/屏 → 28 行/屏，DOM 高度从 3.2 万 px 降到 5 千 px）。**开关是应用级 `wordWrap`**：改动即回写设置（`app.js` 统一落盘并同步 CodeMirror 与所有已开的大文件视图；设置面板与状态条共享同一份状态），新增 `huge.setWrapPreference()` 供外部同步（不回调，避免环）。
- **删除大文件查看器悬浮操作条**：`#viewer-bar`（⏪ / 位置 / ⏩ / 📍跳转 / ✏️启用区域编辑 / 📤提取为新文件）是分页查看器（viewer-lg，v0.7.0 起生产路径已不可达）的遗留 UI，却一直被 `preview.applyMode` 显示在 huge 标签上方。整条 DOM、按钮事件、`#viewer-bar`/`#viewer-pos`/`btn-viewer-*` ID 与对应 CSS 全部删除；图片查看弹窗内的 `.viewer-bar`（放大/缩小/1:1）不受影响（`viewerBarBelow` 用例仍绿）。
- **修正滚动锚点（重要，影响所有大文件滚动/跳转/复制/恢复）**：旧实现 `translateY(scrollTop)` 把「视口首行 − 2 屏」的渲染块钉在视口顶部，导致**屏幕内容恒定比滚动位置落后 2 屏** —— 实测 `gotoLine(20000000)` 后 `getState().firstLine=20000002`，而 DOM 视口顶部是第 19,999,930 行（差 72 行）。后果：跳转落点偏 2 屏、文件末尾几十行永远滚不到、无选区 Ctrl+C 复制的是屏幕外那一行、「所见即所编辑」的键入落点偏 2 屏、会话恢复的滚动位置也偏 2 屏。改为按块内偏移定位：`translateY = scrollTop − offsetFirst − frac`（直映模式等价于把渲染块放到绝对文档位置 `(from−1)×行高`；比例模式把 `first` 钉在视口顶部）；`.huge-sizer` 加 `overflow:hidden` 保证 scrollHeight 恒等于 sizer 高度（换行后渲染块可能更高）。`npm run bigperf` 的 jump 用例新增 DOM 断言：视口顶部行号必须等于 `firstLine`（±容差）。
- 状态栏「行 X / 共 N 行（索引建立中）」不再停在索引就绪前的快照（索引画出后刷新一次；每次渲染也会跟随刷新）。

### 编辑：单键不再物化 10 万行
- **按稀疏档惰性切块**：编辑前把触及的整块按 1000 行切分（块边界直接取自既有行索引的稀疏导表，**零 IO**），只物化 ≤1000 行（GB 级日志约 128KB），而不是整块 10 万行 / 12.8MB。块新增 `baseLine`（块首行在原始文件中的 0 基行号），切分后块内稀疏定位仍精确、撤销/重做语义不变。
- 编辑回执带 `undoDepth / redoDepth / canUndo / canRedo`；渲染端「键入即回显」快路径不再每键多打一次 `huge:doc-state`、单行插入/删除本地推文本并只重画一次视口（跨行编辑仍走权威路径）。
- 实测（5GB / 10GB）：进入编辑会话 10–14ms；单键平均 10ms、最差 16–19ms（此前 18ms 均值 / 99ms 峰值）；撤销 9–10ms。

### 保存：5GB 5.0s / 10GB 9.7s
- 原子全量重写链路不变（拷贝干净块 + overlay 分片 → fsync → 校验字节数 → rename）；实测 **5GB 4.6–5.0s、10GB 9.7–10.4s**（约 1.0–1.1GB/s）。保存期间视口可继续滚动见 v0.9.1。

### 上限与工程化
- 大文件打开上限 5120MB → **20480MB（20GB）**（设置项范围与提示文案同步；`settingsUI` 断言 20480）；默认值 10240MB（10GB，见 v0.9.1）。
- 新增 `npm run bigperf`（`--bigperf` 模式）：5GB/10GB 真实夹具的全链路计时（打开/首屏/索引/索引期间下拉/跳转/拖动/滚轮/搜索/中文搜索/选中复制/键入/保存/**保存期间滚动**），缺失夹具自动跳过；夹具由 `node scripts/mkbigfile.js` 生成（128B 定长行、每 100 万行一个 SECTION 哨兵）。
- 验收：`npm run smoke` **244 项全绿**；`node scripts/overlay-test.js` 14/14；`node scripts/search-shard-probe.js` **15/15**；`npm run bigprobe`（4.5GB）**BIGPROBE_DONE fails=0**；`npm run bigperf` **BIGPERF_DONE fails=0**。

### 已知边界（本轮未做）
- 索引**建立中**跳到尚未扫描的区域仍显示进度占位（渐进前缀只覆盖已扫部分，实测 0.2–1.4s 后出字）；SSD 上 5GB 索引约 2.0–2.1s、10GB 约 4.5–5.4s（侧车缓存命中后再次打开为毫秒级，实测二次打开首屏 22–25ms）。
- 自动换行开关只作用于**显示**（不改文件内容）；换行模式下滚动条仍按逻辑行映射（不是按视觉行），所以开启换行后滚动的「视觉步长」比关闭时大。开关写入应用级 `wordWrap`（设置页同源、跨窗口广播），下次启动保持。
- **大文件视图内 Ctrl+F 仍只给提示**（「当前视图不支持文件内查找 —— 可用 Ctrl+G / Ctrl+Shift+F」）；按文件查找大文件需走侧栏全局搜索（已分片，5GB ≈1s）。

## v0.8.0（2026-10-16）

主题：**标签自由拖拽 + 收藏栏右移 + 大文件「打开即滚、可选可改」**（4~5GB 实测）。

### 标签页：随意拖动
- 标签栏内**拖拽重排**：拖到目标标签左半/右半即插入其前/后（插入指示线），拖到标签栏空白 = 移到末尾；跨栏拖放支持落到另一栏的指定位置（先搬栏再调位）。重排基于文档对象引用（同文件两栏视图同路径不受影响），完成即写入会话快照（下次启动顺序保留）。栏体边缘 30% 落点开新栏的既有行为不变。
- 测试钩子：`__app.editor.moveTabToIndex(tab, pane, index)`（栏内重排/跨栏/越界夹取，返回是否有效移动）。

### 收藏栏：移到右侧栏，可隐藏、可 pin 常显
- 收藏从左侧栏分区迁移到**右侧栏**，三态状态机：**隐藏**（默认）→ 工具栏「🗂 收藏栏」点开为**覆盖式**浮层（不占布局，点栏外/Esc/关闭按钮收起）→ 点 pin 为**挤压式常驻**（参与布局、宽度 200~480 可拖、双击分隔条复位）；pin 态再点「🗂 收藏栏」= 取消 pin 并关闭。
- 新增设置键 `favRailOpen` / `favRailPinned` / `favRailWidth`（settings 白名单收口，跨窗口同步）。`#fav-block` 及收藏相关 ID 全部保留，左栏 fav 折叠态语义不变（作用于右栏内）。
- 测试钩子：`__app.favRail.getState()` / `toggle()` / `setPinned(v)` / `close()`。

### 大文件查看器：4~5GB「打开即滚、可选可改」（对标 EmEditor/DmEditor）
- **冷打开不再假死**：`getIndex` in-flight 合并（同文件并发只扫一遍，首屏 IO 减半）；索引未就绪时渲染**占位行 + 进度百分比**（不再发取数 IPC 互相踩踏），滚动条由估算行数撑着、可拖动定位，就绪后自动落位；索引失败显示错误文案不转圈。
- **可选中、可复制**：`user-select` 白名单放行 `.huge-text`（视口内原生拖选）；Ctrl+C 复制闭环——有选区复制选中内容，无选区复制当前行（编辑态=光标行、只读态=视口首行，**整行取原文**不受 DOM 截断影响，超长行截断复制并提示），经 `clipboard:write-any-text` 写系统剪贴板。
- **键入即编辑真正生效**：huge 视图挂载即可获焦（此前只读态焦点根本到不了视口，打字无声无息）；只读态点击即聚焦。首键开编辑会话、次键落字（v0.7.0 口径），光标落在当前视口首行。
- **滚轮按行滚**（scaled 模式，16M px 比例映射下原先滚一屏≈跳 4000 行）：±3 行/格、Shift=±1 屏，触控板小步长累计；Ctrl+滚轮缩放不拦。
- **可编辑范围扩大**：overlay 单块上限 32MB → **128MB**（物化上限同步 64→256MB；长行日志类 GB 级文件——如 1KB/行 × 百万行——从「拒绝编辑」变为可编辑）。二进制/GBK/单行 >64MB 仍拒编（设计口径不变）。
- **实测数据**（`npm run bigprobe`，F:\mh-bigtest 真实文件，探针脚本 scripts/bigfile-probe.js 入库）：**4.5GB / 6902 万行**——打开 44ms、冷建索引 3.0s、80%→100% 连续 11 跳共 92ms（单批取数 0.7ms）、直达文件尾内容正确、选中+剪贴板读回一致、键入落字、**保存落盘 6.1s**（主进程流式复核标记唯一）、渲染端堆 10MB；**1GB 长行文件**（旧上限拒编）编辑+保存往返通过。

### 测试
- 冒烟 **240 → 244 项**：新增 `tabDragReorder`（合成 DragEvent 重排 + DOM 序/会话序一致）、`favRailToggle`（三态状态机 + 设置落盘往返）、`hugeSelectCopy`（选中/剪贴板读回/无选区复制当前行）、`hugeTypeFocus`（点击聚焦 + 首键开会话 + 次键落字）。
- 新增 `npm run bigprobe`：真实 GB 级文件实测探针（夹具 F:\mh-bigtest\，缺失自动 SKIP），进程退出码即判定。
- 验收：`npm run smoke` **244 项全绿** + `node scripts/bigfile-probe.js` 探针全过（以 BIGPROBE_DONE fails=0 为准）。

## v0.7.2（2026-10-16）

主题：**大文件搜索/编辑链路缺陷集中修复**（代码评审驱动，对标 EmEditor 级大文件正确性）。

### 修复：全局搜索（大文件流式路径）
- **大小写折叠漏配（高）**：>10MB 文件的字节快路径原先只按「全小写 + 全大写」两个字节 needle 匹配，内容里的混合形态（`Readme`/`ReAdMe` 等）整体漏配，且与小文件（≤10MB）解码路径结果不一致。改为**字节级大小写不敏感扫描**（needle 中 ASCII 字母字节双形态锚点 + 逐字节折叠校验），任意大小写形态的查询都能命中全部大小写形态的内容；非 ASCII 查询仍走解码路径。
- **无换行巨文件内存无界 + 取消失灵（高）**：回退路径只在遇到换行时消费缓冲，GB 级单行文件会把整个文件累积进内存直至撞 V8 上限，且取消检查永不触发。改为块级取消检查 + 缓冲超 1MB 时按「截断行」消费头部、仅保留尾部 256KB 续拼（跨段命中不丢）。
- 命中循环内不再逐条新建 `TextDecoder`（循环外复用）。

### 修复：全局替换写坏文件（高·数据损坏）
- `globalsearch.replaceAllInText` 原先用 `toLowerCase().indexOf()` 取下标再回原串切片，遇变长小写映射字符（如 `İ` U+0130 小写后变 2 字符）下标错位，**批量替换会把错位内容写回多个文件**。改走 `RegExp.exec`（`m.index` 为原串下标），与 find.js 既有修复同口径。

### 修复：大文档体验
- **预览冻结（高）**：文档超过 8MB（`PREVIEW_AUTO_MAX_BYTES`）后，击键防抖的自动整篇重渲（toString + md.render + innerHTML 全换）被闸门拦下，预览区顶部显示一次性横幅（「刷新」按钮手动整渲）；手动刷新/切标签/模式切换不受限。≤8MB 文档行为零变化。
- **大文件查看器 resize 逐帧 IPC**：拖窗口边框期间 `render()`（一次批量取行 IPC）改走既有 16ms scrollTimer 合并，`applySizer()` 保持即时（滚动条即时正确）。
- **`fs:find-line-offset` 逐字节 JS 循环** → 原生 `Buffer.indexOf` 循环（GB 级文件行定位快一个数量级，与 lineindex 的 scan 同写法，行为等价经 3000 组随机缓冲比对）。
- **行索引侧车临时文件并发冲突**：tmp 名加进程内自增序号 + 时间戳，GC 正则同步兼容新旧命名。

### 修复：文件树与其它
- **全量 render 后嵌套已展开目录显示为空（高）**：render 完成后对 expanded 集合里「已渲染 + 已展开 + 子节点为空」的目录逐层异步补载（并发去重、失败静默、不阻塞首层、render 令牌作废旧补载）。
- **同一文件可双开双写**：`docmodel.byPath` 改按与 tree.js 同式的归一化键（小写+正斜杠）比较。
- quickopen 扫描中切换目录的竞态（旧目录结果覆盖新目录清单）；`isInsideRoot` 把根目录自身误判为外部；外部修改+脏标签时确认弹窗可叠加（加 `_extConfirming` 去重）；两处 `watchFile` 未捕获 rejection；「提取为新文件」输入名合法化（拒绝分隔符与 `..`，与主进程 `fs:create` 同口径）。

### 测试
- 冒烟 **235 → 240 项**：新增 `gsMixedCaseHuge`（10.6MB 文件三种大小写形态内容 × 小写/大写/混合三种查询全部命中）、`gsNoNewlineHuge`（11MB 无换行单行尾部中文关键词，回退路径有界命中）、`gsReplaceCaseFold`（`İ` 夹具全局替换后逐字节断言文件内容）、`treeNestedExpand`（三层嵌套展开 → 全量 render → 深层文件自动重现）、`previewGateLargeDoc`（9.5MB 文档击键出横幅且内容不更新、手动刷新恢复且横幅移除）。
- 判定口径不变：`node scripts/smoke-verify.js <日志> --expect 240 --require …`。

## v0.7.1（2026-10-15）

### 权限：不再区分活动目录与外部文件——文件树里的一切直接可操作（用户决策，安全口径最终收口）
- **写盘白名单整体移除**：`fs:write-file` / `fs:write-stream-*` / `fs:splice-file` / `fs:delete` / `fs:rename` / `fs:write-binary` 全部不再做「路径在侧栏根内 or 曾打开过」校验——**任何在文件树里打开的文件夹内都能直接创建、写入、改名、删除**。各通道的业务校验保留（存在性 / 禁删侧栏根 / 文件名合法化 / 图片扩展名限制 / 区域越界检查）。`security.js` 的批准面仅剩 `shell:open-path` 一条通道使用。
- **外部文件分支的目录/文件菜单升级为完整操作面**（与侧栏根完全一致）：目录行右键 = 新建文件 / 新建目录 / 复制（Ctrl+C）/ 粘贴到此处（Ctrl+V）/ 刷新 / 切换工作目录 / 重命名 / 删除 + 五个常用项；文件行右键 = 打开 / 对比基准 / 重命名 / 删除 / 复制 / 粘贴到所在目录 + 常用项。此前外部链目录只有「刷新/切换工作目录」、文件只有「打开/重命名/删除」。
- **外部链目录可拖拽**：与根内目录一致（拖动 = 移动、Ctrl+拖 = 复制、可作放置目标）；仅「外部文件」虚拟根与盘符行（合成行）保持只读展示。

### 测试
- 冒烟 **234 → 235 项**：新增 `extDirFullOps`（外部目录上的全套写操作：创建目录/文件+写入、复制到剪贴板、粘贴、重命名、改名后写入、深层创建、整树删除，零权限拒绝）；`extCtxMenu` 的外部目录菜单断言反转（原「不得有新建」→「必须有 新建/重命名/删除/复制/粘贴 + 切换工作目录」）。
- 既有写类用例（`pasteExternalImage` / `renameExternalSave` / `extCreateAllowed` 等）本就断言放行方向，零改动兼容。
- 验收：`npm run smoke` **235 项全绿**（`SMOKE_VERIFY OK`；期间两轮会话类用例因窗口失焦假红，前台重跑转绿——AGENTS 记录的已知假红形态，非回归）。

## v0.7.0（2026-10-13）

主题：**权限零打扰 + 大文件 5GB 丝滑线 + 预览提纲跳转 + 代码块一键复制**。

### 权限：树内操作不再出现「路径不在已打开目录内，操作已拒绝」（用户决策口径变更）
- **放开**（改为存在性校验，树内可见即可操作）：`clipboard:copy-files`（复制文件/文件夹到剪贴板 —— 外部文件分支的**目录链行**也可复制，此前是「复制失败」的高频源头）、`fs:paste-files`（粘贴目标目录）、`fs:transfer`（拖拽移动/复制的源与目标 —— 外部文件与外部目录链互传不再被拒）、`shell:open-terminal`（cwd 口径不变）、`clipboard:write-text`（正文仍由主进程按来源路径自拼）。
- **唯一保留白名单**：`shell:open-path`（用默认程序打开）—— 它能以系统关联启动任意程序，是树内可达操作里外向性最强的一条；侧栏根内与已打开过的文件不受影响。
- `fs:write` / `fs:delete` / `fs:rename` / `fs:write-binary` 的写盘口径**不变**（侧栏根内 + 已打开文件的面已覆盖「左侧栏打开的目录与文件」）。

### 大文件：5GB 上限 + 全量连续滚动 + 打开即可编辑（丝滑线对齐 VS Code）
- **上限 4GB → 5GB**：设置项与打开上限 5120MB；全局搜索流式扫描上限同步 5120MB。
- **256MB 起全部走「虚拟滚动查看器」**（原 >1GB）：连续滚动、任意位置 O(1) 定位、全量索引——**原分页查看器（viewer-lg）退役**（256MB–1GB 不再翻页，代码路径保留兼容）。技术口径：5GB 无法塞进单个 JS 字符串（V8 上限约 5 亿字符）也无法全量入 DOM（Chromium 元素高度上限 33.5M px），**虚拟滚动是唯一可行的"丝滑"路径**（VS Code 同款：piece-tree 缓冲 + 只渲染可见行）；本档配稀疏行索引 + 侧车缓存，任意行 O(log n) 直达。
- **首次键入自动进入编辑**：大文件视图里**直接打字**即自动开启编辑会话（无需先点「✎ 启用编辑」；首键用于开启、次键落字），能否编辑仍由主进程判定（GBK/二进制/超大单块 → 只读并显示原因）。刻意不在挂载时自动开会话——实测与「打开→跳转→编辑」快速序列存在时序纠缠（视口被拽回文件头），键入时开启则天然把光标落在所见位置。
- **「所见即所编辑」**：滚到别处后直接打字，光标自动移到当前视口首行再落字（旧行为会把视口拽回旧光标行，观感是"打字乱跳"）。
- **滚动更顺滑**：视口上下预取各 1 屏 → 2 屏（快速滚动边缘闪白显著减少）；`getState()` 新增 `firstLine`（真实视口首行），标签关闭/重开的滚动位置采集改用它（不再从渲染窗起点反推——预取窗语义变化后反推会偏一屏）。

### 预览：仅预览模式下大纲点击跳转到预览位置
- 大纲（左侧 🧭）点击行为分模式：**仅预览模式** → 滚动预览区到对应标题（短暂高亮反馈，不打断阅读流）；编辑/分屏模式 → 照旧跳编辑器对应行。标题序号与预览 DOM 的 heading 一一对齐（两边都跳过围栏代码块内的 `#`）。

### 预览：代码块一键复制（常驻大按钮）
- 每个围栏代码块右上角**常驻**「复制」按钮（不 hover 也可见，min-width 58px），点击把整块代码原样写入系统剪贴板（新增 `clipboard:write-any-text` 通道——file:// 下 `navigator.clipboard` 不可用；能力等价于浏览器网页的剪贴板写入）。复制成功显示「已复制 ✓」1.6 秒。mermaid 块随图替换无残留。

### 测试
- 冒烟 **232 → 234 项**：新增 `codeCopyBtn`（按钮常驻可见性/尺寸下限/点击后剪贴板内容/成功文案）、`outlinePreviewJump`（仅预览模式点大纲第 6 项 → 预览滚动 + 目标标题入视口 + 高亮类）；`treeClipboard` 扩展「未批准但存在的路径（系统 hosts）复制放行」断言。
- **既有用例口径更新**（权限语义反转，同 v0.5.1 的 `extCreateRejected→extCreateAllowed` 先例）：`multiRootTransferReject` → 外部目录作为传输目标放行；`ctxMenuCommonItems` 的 `terminal/clipboard-unapproved-rejected` → `now-allowed`（`openpath` 保留拒绝——见上）；`settingsUI` 上限断言 4096 → 5120。
- **大文件语义改写**：`boundaryViewer`（512MB 断言 viewer-lg → huge + 4.1GB 拒绝合并入 huge 分支）、`viewerRegionEdit` → 首次键入自动开启编辑 + 落字 + 退出/恢复（编辑后保存落盘再关——脏关闭会在崩溃恢复区留块表污染下游）、`viewerReadOnly` → 二进制文件键入尝试与显式开启均保持只读且带原因。
- 验收：`npm run smoke` **234 项全绿**（`SMOKE_VERIFY OK`：true 229 + 信息型 5，false 0，ERR 0）。排障记录：挂载即自动编辑与 p6b 重开滚动恢复存在时序竞态（视口被 `placeCaret(旧光标行)` 拽回文件头），定为方案级问题改为「首次键入自动开启」后消解。

## v0.6.1（2026-10-13）

### 预览的图片与流程图默认原始尺寸（无需双击放大）
- **图片**：预览中的图片不再被 `max-width:100%` 压缩到预览栏宽度 —— 按**原始像素 1:1 渲染**（零画质损失，位图不放大不缩小），超宽部分由预览区横向滚动查看。配套 `.markdown-body { min-width:0 }`：防止大图把 flex 子项的 min-content 推高、把正文 860px 排版整段拉宽（文本排版不受大图影响）。
- **流程图（mermaid）**：全部 15 种图类型初始化 `useMaxWidth:false`（flowchart / sequence / class / state / er / journey / gantt / pie / timeline / gitGraph / mindmap / quadrantChart / xychart / block / sankey），SVG 输出**固定像素宽度**（节点文字按可读字号排布）而非 `max-width:100%` 自适应压缩 —— 大流程图不再被压到预览栏宽度、节点文字小到看不清；`.mermaid-wrap svg { max-width:none }` 同步放开，超宽由 wrap 横向滚动，矢量缩放无损。主题切换缓存/双击放大查看器等既有行为不变（查看器宽度由 viewBox 独立计算）。

### 测试
- 冒烟新增 `mediaNaturalSize`（**231 → 232**）：2000×900 SVG 图在预览中渲染宽度 === naturalWidth（未被压缩），10 节点 LR 流程图 SVG 渲染宽度 === 其固定像素宽（>400 且未缩到容器宽）、`.mermaid-wrap` 滚动区容纳全图。
- 既有 mermaid/图片用例（`mermaidRender`/`mermaidCacheId`/`imgDetail`/`mermaidViewer`/`viewerScrollFull` 等）只断言存在性/查看器行为，与预览端尺寸解耦，零改动兼容。

## v0.6.0（2026-10-13）

主题：**五项生产力优化**——批处理运行、文件树与系统剪贴板互通、重命名改扩展名即时生效、Markdown 数学公式（KaTeX）、全局搜索文件名/目录名。

### 新功能：批处理脚本运行（.bat / .cmd）
- `▶ 运行` 按钮与底部运行面板不再只认 `.py`：`.bat` / `.cmd` 批处理由主进程以 `cmd.exe /d /s /c <脚本>` 执行（**路径只作为单个 argv 传给 cmd，不 `shell:true`、不做字符串拼接**，含空格路径由 Node 自动加引号），cwd 为脚本所在目录；与 Python 共用同一套进程管理（进程树终止 / 输出 60ms·4KB 合批 / runSeq 迟到退出守卫）与 `python:*` 事件协议，渲染端面板零协议改动。批处理输出按系统代码页解码（中文 Windows = GBK；ASCII 两种编码字节一致不受影响），`StringDecoder` 不认 GBK，主进程以 WHATWG `TextDecoder('gbk', {stream:true})` 包成同形解码器。
- 面板 tab 文案改为「运行（Python / 批处理）」，运行按钮可用口径 = `.py / .bat / .cmd`（`ui.isRunnableScript`），`pythonPath` 设置只对 `.py` 生效。

### 新功能：文件树 ⇄ 系统剪贴板互通（Ctrl+C / Ctrl+V 复制粘贴文件与文件夹）
- **复制**：树中选中文件或目录后 `Ctrl+C`（或树右键「📋 复制（Ctrl+C）」）→ 路径以 Windows **CF_HDROP**（DROPFILES 结构，`pFiles=20`、`fWide=1`、**双 null 终止**——HDROP 无计数字段，消费方靠双终止判界）写入系统剪贴板：资源管理器、桌面等一切接受文件粘贴的目标都能直接 `Ctrl+V`。源路径须过 `requireApproved` 且真实存在（与「复制路径」同口径）。
- **粘贴**：树中 `Ctrl+V`（或右键「📥 粘贴到此处」）→ 读回 CF_HDROP 文件列表逐个复制进当前选中目录（`fs.cp` 递归，目录合并语义）。**源来自系统剪贴板**（用户在资源管理器 `Ctrl+C` 的任意路径），语义等同"把外部文件拖进窗口"，源不要求白名单；目标目录必须已批准且存在。冲突三选（应用内弹窗）：覆盖 / 保留两者（`name (2)` 自动改名，与拖拽传输同款）/ 取消；ask 模式**先整单预检**（任一冲突即整体不落盘，杜绝半截粘贴）。
- 新增 IPC：`clipboard:copy-files`（写，源过白名单）、`clipboard:read-files`（只读探测）、`fs:paste-files`（粘贴落地，目标过白名单）；粘贴成功 `markSelfWrite` 吸收监听回声 + `approve` 新文件（立即可编辑）。
- 树容器 `tabIndex=0` 可聚焦：**真实点击/右键树行把焦点收进树**（此后 `Ctrl+C/V` 作用于树；`e.isTrusted` 区分合成事件，冒烟/自动化不受影响），树不画焦点轮廓；焦点在编辑器时行为完全不变。

### 修复：重命名改变扩展名后不生效（如 .txt 改 .md 无预览/无高亮）
- 根因：树重命名回调只更新 `tab.path/name`，`tab.lang` 与 CodeMirror 语言模式停留在旧扩展名，且无任何依赖扩展名的 UI 刷新。现在 `onClosePath` 重命名分支调用新增的 `editor.reconfigureTabLang(tab, langFor(newPath))`（`langCompartment` 在线热切换，**同文档多视图逐个 reconfigure**，与只读热切换同款做法，不重建 DOM 不丢光标），并统一刷新预览图层显隐（`applyMode`）、预览按钮、大纲显隐、运行按钮四类依赖扩展名的 UI。

### 新功能：Markdown 数学公式（KaTeX）全面支持
- 新增 `src/renderer/katex-math.js` markdown-it 插件（+ `katex` 依赖，静态打进主 bundle）：**块级** `$$ ... $$`（单行/跨行）与 `\[ ... \]`，**行内** `$...$` 与 `\( ... \)`；渲染失败不中断整篇（`throwOnError:false` 红字原码 + 插件层兜底占位 `.mh-math-error`）。
- 误判防御（全部有真实样例覆盖）：`$5 和 $10` 货币写法不进公式（`$` 后/闭合 `$` 前不得是空白、内容不得跨行、空内容不算）；行内代码与围栏代码块/mermaid 块内的 `$` 天然不解析（注册位次：block 在 `paragraph` 前、fence 之后；inline 在 `escape` 前，backticks 一次性消费 code span）；`$$` 未闭合时按普通段落原样渲染不吞内容；`\$` 转义保留字面量。
- 资源链路：构建时 `katex.min.css` → `dist/katex.css`、`fonts/*.woff2` → `dist/fonts/`（css 内 `url(fonts/...)` 相对引用天然成立，CSP `default-src 'self'` 同源兼容）；样式补块级公式横向滚动（长公式不撑破分栏）、行内字号微调；KaTeX 字色继承 `currentColor`，56 套明暗主题自动适配。
- 流程图（mermaid）适配顺带加固：既有横向滚动/主题缓存/错误占位口径不变，公式与流程图可在同一文档混排互不干扰（冒烟覆盖）。

### 新功能：全局搜索支持文件名与目录名（点击在文件树定位）
- `search-worker.js` 遍历改为 `walk(dir, {withDirs:true})`（目录也作为条目产出；`Ctrl+P` 文件清单口径不变），**文件名与目录名参与匹配**（大小写不敏感子串，与内容同口径；名字匹配对任意扩展名文件生效——找二进制文件的名字也算），结果条目新增 `kind` 字段：`'name'`（文件名命中，line=0）/ `'dir'`（目录名命中，line=0）/ 缺省=内容命中（既有形态，替换等消费方零改动兼容）；名字命中与内容命中可并存。
- 渲染端：名字行显示图标 + 高亮文件名 + 相对活动目录的路径（目录行加「（目录）」标记）；**点击名字/目录结果行 = 左侧文件树直接跳转定位**（展开父级链 + 选中滚动到可见，不打开文件——找位置意图优先）；文件头行点击仍打开文件；「全部替换」自动跳过目录结果（readFile 目录必失败）。

### 测试
- 冒烟新增 5 项（**226 → 231**）：`runBat`（cmd 批处理运行输出/退出码 + 运行按钮对 .bat 可用）、`renameExtSwitch`（走真实树重命名弹窗：.txt→.md 后 `tab.lang` 切换、预览出现且含 KaTeX）、`treeClipboard`（Ctrl+C 合成键路径 → CF_HDROP 剪贴板往返 → ask 冲突拒粘/dedupe 落地 `name (2)`/树级粘贴入口全链）、`mathRender`（块级/行内/`\(``\[`/货币防御/代码内不解析，katex=4 display=2）、`gsNameDir`（文件名/目录名命中 kind 断言 + 点击名字行后树 `.selected` 定位）。
- 既有用例口径更新：主流程 `globalSearch` 的 hello 匹配数 2 → 3（v0.6.0 起文件名也计 1 处）；`searchCancel`/`hugeSearchFast`/`bigSearchStream`/`globalSearchUI`/`gsHighlight`/`globalReplace` 的关键词均不在任何文件名/目录名中，断言不变。
- **extCtxMenu 假红排障记录（2026-10-13，非产品缺陷）**：v0.6.0 开发中 `extCtxMenu` 连续 6 轮红（`no file node`），产品代码整体 stash 回基线后**仍红**，确诊为**环境敏感**而非回归——外部链 reveal 需 `readTree` 盘符→目标的每一级目录，夹具 EXT_ROOT 原挂在 `AppData\Local\Temp` 下，开发机 Temp 积累数千条目（`fs:read-tree` 逐条 `statSync`）导致单次 readTree(Temp) 达数秒，链展开在等待窗口内完不成。处置：EXT_ROOT 改挂 `os.homedir()` 直下（链更短、条目少；长拼写与 8.3 短名规避不变），`extCtxMenu` 的文件行查找从固定 400ms 改为与 `extReveal` 同款 `waitFor` 轮询。**教训已注在 smoke.js 的 EXT_ROOT 定义处**：今后外部链用例变慢先查夹具父链的目录体量。
- 插件层单测：markdown-it + KaTeX 11 种形态全过（含 mermaid fence 不被 `$$` 误吃、未闭合回退、`\$` 转义）；CF_HDROP 结构单测（双 null 终止、UTF-16 往返、单/多路径）+ Electron 真机探针（writeBuffer/readBuffer('CF_HDROP') 往返、writeBuffer 替换整个剪贴板的语义确认——树复制会清掉旧剪贴板内容，与 Explorer 行为一致）。
- 验收：`npm run smoke` **231 项全绿**（`SMOKE_VERIFY OK`：true 226 + 信息型 5（`findAll`/`pyUI`/`hugeIndexCold`/`hugeIndexCache`/`hugeSearchFast`），false 0，ERR 0）。

## v0.5.1（2026-09-22）

### 新建文件/目录：权限全部放开 + 多窗口权限根因修复
- **新建全部放开（用户决策的安全口径变更）**：`fs:create` 不再要求目标在已打开目录内 —— 无论活动目录是哪个、目标在哪里（含外部目录、深层新链），工具栏/树右键新建文件与新建目录都能成功（父目录缺失时 recursive 重建父链）。**创建即批准**：本次新建的文件/目录与递归新建的祖先目录自动进入批准面，随后的内容写入、删除、改名不再被拒；写入已有文件 / 删除既有路径 / 改名 / 跨目录传输仍维持原白名单口径不变。
- **多窗口「写文件有时没权限」根因修复**：`security.roots` 是进程级单例，而 v0.2.3 起每个窗口都会整表同步自己的侧栏目录 —— 后同步的窗口会把先开目录窗口的根集合整个覆盖（A 窗口开的目录在 B 窗口同步后失去写权限，时现时不现）。`fs:set-roots` 改为**按调用窗口记账 + 全窗口并集**同步（销毁窗口的记账即时清理；活动目录以调用方为准，缺席时回退）。
- **新建文件图标与「新建目录」区分**：树右键菜单「📁 新建文件 / 📂 新建目录」两个几乎一样的图标改为「**📝 新建文件** / 📁 新建目录」，侧栏工具栏「📄 新建文件」同步改为「📝」；创建成功 toast 区分「📝 已创建文件 X / 📁 已创建目录 X」。

### 测试
- 冒烟 226 项全绿（`SMOKE_VERIFY OK`：225 → 226）：`extCreateRejected` 改为 `extCreateAllowed`（外部目录创建成功 + 「创建即批准」使随后的写入/读取/删除可用）、新增 `createAnywhereDeep`（不存在的深层父链 recursive 重建 + 目录放开 + 链上删除可用）；`ctxMenuCommonItems` 的树菜单保留项断言同步新图标。

## v0.5.0（2026-09-13）

> **本版合并了未发布的 0.4.0 大文件线**（计划与实测见 `docs/开发计划-大文件秒开与秒搜-0.4.0.md`）与 0.5.0 的多视图 / 跨窗口「接管编辑」/ 体验项两批 / 崩溃恢复 UI；`package.json` 版本 `0.4.0 → 0.5.0`（0.4.0 从未单独发布）。验收：`npm run smoke` **225 项全绿**（带"运行期间关键文件零改动"哈希守卫，原文与两列哈希见本文档「0.5.0 验收记录」一节）。

主题：**大文件「秒开 + 连续滚动 + 秒搜」**（计划与实测明细见 `docs/开发计划-大文件秒开与秒搜-0.4.0.md`）。分档不变：≤256MB 走原路径；0.3.0 顺延的多视图分屏与体验项已随本版交付（见 `docs/开发计划-多视图与体验流畅度-0.5.0.md`）。

### 新功能：大文件行索引（基础设施）
- **`src/main/lineindex.js`**：稀疏行首偏移表（默认每 1000 行一条）+ **侧车磁盘缓存** `userData/lineidx/<sha1(path|size|mtimeMs)>.idx`（文件被外部修改自动失效）+ **内存缓存**（命中即回、按需 GC）+ **binary 标志**（含 NUL 判定），流式扫描用原生 `Buffer.indexOf` 数换行、增量解码只为定编码。
- 新增 IPC `huge:index`（`opts.force` 跳过缓存强制重扫）、`huge:line-offset`、`huge:offset-line`、`huge:lines`（一次取整个视口）、`huge:index-drop`，以及进度事件 `huge:index-progress`（订阅返回退订函数，查看器销毁时必须调用，否则监听器随标签累积泄漏）；preload 已全部暴露。
- 实测：**15MB 冷索引 16ms、缓存命中 0ms**；**600 万行冷 262ms / 内存命中 0ms**；行↔字节偏移在稀疏边界与首尾行均精确、往返一致。

### 新功能：虚拟滚动查看器（>1GB）
- 新增 **`src/renderer/hugeview.js`**：只渲染视口行（按需 seek + 解码），滚动条可连续拖到任意位置 —— 2GB 文件不再需要一页页翻。
- **比例映射绕开 Chromium 33.5M px 元素高度上限**：超长文档按比例换算滚动位置，而非按行高堆真实高度。
- **CodeMirror 真让位**：huge 标签激活时 `.cm-editor` 置 `display:none`，切回普通文件自动恢复（冒烟 `hugeScrollAnywhere` 同时断言两者）。
- **`Ctrl+G` 行号跳转**；全局搜索命中直达该行（行号→字节偏移走行索引，失败回退旧实现）。
- 实测：**1.13GB 打开 13ms**、**任意位置跳转 170–215ms**、视口 78 行。
- 安全前置：`tabs.js` `doSaveNow` 对 `kind==='huge'` 曾**直接拒绝整篇写盘**（避免 GB 文件被截成 0 字节）；Phase D 第三步起该分支改走 `huge:doc-save`（原子全量重写），整篇写盘分支对 huge 永久不可达。

### 新功能：大文件编辑接线（Phase D 第三步：渲染端 + 保存/关闭/监听）
- **`hugeview.js` 视口内编辑**：新增对外方法 `setEditable(on)`（进入时打开 overlay 编辑会话，**能否编辑取 `huge:doc-open` 返回的 `editable`**，GBK/二进制/超大单块返回 false 时保持只读并在状态栏显示 `reason`）、`isDirty()`、`save()`、`closeDoc(discard)`、`reloadExternal()`；**编辑/撤销/保存全部走既有 `huge:doc-*` 通道**（insert/delete/undo/redo/save），渲染端不建文档状态机，只维护「光标 + 最近一次主进程回执」。编辑 UI = 行内光标 + 键盘：可打印字符 / Backspace / Delete / Enter（含行首退格并上一行）/ Ctrl+Z / Ctrl+Y / 方向键 / Home / End，点击行内落光标；打开编辑会话后视口取数从 `huge:lines` 切到 `huge:doc-lines`（否则看不见未保存修改、行数也不会变）。超长行（>40000 字符，已截断显示）拒绝编辑。
- **保存**：`huge:doc-save` 期间订阅 `huge:doc-save-progress` 显示百分比并在 `finally` **退订**；主进程 `huge:doc-saved` 到达后重取行索引（保留退订句柄，`destroy()` 一并摘除）→ 刷新行数与滚动高度。
- **`tabs.js` 三处接线**：① `doSaveNow` 的 huge 分支 → `hugeview.save()`（`tab.state` 是空文档，绝不能再落到整篇写盘）；② `closeTab` 对 huge 在 `destroy` 前调 `hugeDocClose({discard:false})`（有未保存改动时主进程保留 overlay 块表供 `huge:doc-recover-list` 恢复，**任何情况都不写源文件**，`closeByPath(..., {save:false})` 的「删除不复活」语义不变）；③ huge 标签也 `watchFile` 并纳入 `file-changed` 过滤（外部修改 → 有未保存编辑先确认，确认后丢弃会话 + 丢行索引缓存重载，语义对齐 viewer-lg），并加**保存自写回声守卫**（`rename` 到 `markSelfWrite` 之间的事件可能抢跑，3s 窗口内忽略）。
- `app.js`：设置里大文件上限 hint 补第三档（>1GB 虚拟滚动查看器 + 底部「✎ 启用编辑」+ `Ctrl+G` 跳行号 + `Ctrl+S` 保存）；`Ctrl+S` 经 `doSaveNow` 自动走新保存路径。
- 测试面：`tabs.js` 的虚拟滚动阈值改为模块级可变值（默认仍是 1024MB，无调用方时行为完全一致），仅经 `window.__app.editor.setHugeThresholdMB()` 暴露给冒烟临时降档。

### 新功能：大文件搜索原生字节快路径
- `search-worker.js` 大文件扫描改**原生 `Buffer.indexOf`**：纯 ASCII 查询直接用原始字节匹配（**UTF-8 与 GBK 共用**，ASCII 字节一致），大小写不敏感用小写/大写两个 needle 归并；**跨 8MB 块**命中用「上一块尾部 needle-1 字节」拼接处理；行号由块内换行位置二分得到，行文本按命中区间解码（GBK 亦正确）；非 ASCII 查询自动回退原增量解码逐行路径。
- **结果上限 3000 → 1 万**（`search-worker.js` 兜底默认 10000），密集查询按 `maxResults` 截断收集，避免全量收集 + 排序。
- 实测：**大文件搜索 89ms**（含 worker 启动 + 目录遍历 + IPC），命中行号与 `matchIndex` 正确。

### 修复：右键「用 MarkHunter 打开」的冷启动时序、坏路径静默与「幽灵目标目录」
- **冷启动 `--dir <目标>` 不再"先恢复上次目录/会话、再把目标当事后事件追加"**：过去目标目录只有 `did-finish-load` 的 `open-dir` 事件这一条通路，而渲染端 boot 早于它跑完 `takeOpenDir()`（只要用户有上次目录/侧栏根/会话就必然踩中）——实测侧栏同时出现上次的根与目标（`roots=[上次根, 目标]`），上次会话照常恢复。现在主进程把本次启动目标经 `webPreferences.additionalArguments`（`--mh-open-dir=<encodeURIComponent(路径)>`，非 ASCII 路径必须编码）同步交给 preload，preload 在任何页面脚本之前即可取到并作为 `pendingOpenDir` 初值 → boot 必然走「指定目录启动」分支；`did-finish-load` 事件保留为第二通路（重复投递幂等）。
- **坏路径不再静默失败**：`--dir` 指向不存在路径或一个文件时，现在会提示「无法打开指定目录：<路径>」并保留可用窗口（此前该路径下**没有任何提示**，用户只看到目标没被打开）。
- **修掉一个"幽灵目标目录"**：`args.js` 的兜底分支会把 `process.argv[0]`（开发期的 `electron.exe`、安装后的 `MarkHunter.exe` 绝对路径）当成目标目录 → `npm start`、`electron . --smoke`、打包版双击启动都带一个假目标（表现为 `ENOTDIR` 读树失败 + 静默跳过上次会话恢复）。现在只有显式带 `--dir` 时才接受「看起来像路径但不存在」的参数，并额外排除可执行文件自身；安装包的右键菜单与盘符项固定传 `--dir "%V"`，收紧无副作用。

### 新功能：资源管理器「盘符」右键菜单（安装包）与真机实测
- 安装包右键菜单补上**盘符项**（「此电脑」里的 C: / D: … 右键 →「用 MarkHunter 打开」）：`HKCU\Software\Classes\Drive\shell\MarkHunter` → `"<安装目录>\MarkHunter.exe" --dir "%1"`；原有的「目录空白处右键」（`Directory\Background`，`--dir "%V"`）与「目录本身右键」（`Directory`，`--dir "%1"`）保持不变。
- **真机实测（0.4.0 安装包静默安装覆盖到 `F:\MarkHunter`）**：三条注册表项的 label / Icon / 命令逐条核对通过；按注册表命令启动已安装版本 → `settings.json` 的 `lastDirectory` 与 `sidebarRoots` **恰为目标目录 1 项**（无旧根残留）；`--dir "F:\"` → `sidebarRoots` 恰为 `F:\` 1 项；应用运行中再次右键另一个目录 → 第二个进程被单实例锁接管并自行退出，运行中的窗口打开新目录。测试以 `MH_USERDATA` 指向临时 profile，**未改动真实用户配置**（前后 sha 一致）。

### 测试
- 冒烟新增 4 项：`hugeIndexCold`（断言冷索引并回报耗时，实测 cold=13ms）/`hugeIndexCache`（断言 `cached===true`，实测 hot=0ms）/`hugeScrollAnywhere`（huge 渲染 + CM `display:none` 让位 + 切回普通文件恢复）/`hugeSearchFast`（断言命中行 > 100000，实测 94ms）；`boundaryViewer` 的 huge 分支由 rows=0 → true。
- Phase D 第三步再新增 3 项（用 `bd-280mb.bin` 的**同 rootDir 副本**做编辑，末尾断言夹具本体 size+mtime 未变；每例 `setHugeThresholdMB(200)` → 打开/断言 → `finally` 恢复 1024）：
  - `hugeEditChunkCoW`：中部插入 3 行 → 行数 +3（渲染端 `getState` 与主进程 `huge:doc-state` 双口径）、`isDirty` 为真、`undoDepth≥1`、中部行内容正确、**磁盘字节未变**（内存 vs 磁盘对照），再用真实 `Ctrl+Z` 键盘事件复原（行数/内容/`redoDepth` 一致）。
  - `hugeEditSaveAtomic`：编辑后保存 → 磁盘字节数 = 原大小 + 插入串长度、按行索引定位读回标记内容（同时证明保存后索引重建可用、跳转仍准）、目标目录无 `.mh-ovl-*.tmp` 残留、进度事件序列 `copy→verify→rename→done`、保存后行数与索引一致。
  - `hugeEditUndo`：真实鼠标点击落光标 + 逐键输入/Home/Enter（每步等 `undoDepth` 增长，不靠固定 sleep）→ 全部 `Ctrl+Z` 回原文（行数/内容/脏标记/`canRedo`）、全部 `Ctrl+Y` 前进到编辑后状态（`undoDepth`/`canUndo`/`canRedo` 同步），末尾再撤回干净。
- 用例总数 **219 项**（公式 `162+11+2+3+8+6+7+2+7+4+7=219`：`scripts/smoke.js` 里 `await step(` **164** 处（其中 1 处不产生 result → 有效 **163**）+ `runCase` 6 + `splitCase` 7 + `mvCase` 7 + `p5Case` 7；前段直推 11 项 + `menuClipboardSnippet` 运行 2 次 + `rcDirArgParse`/`previewImgClip`/`bundleSplit` 各 1 + 多窗口 8 项 + 右键 `--dir`/测试 profile 隔离 6 项 + **Phase 2 分屏 7 项** + **大文件挂账 2 项** + **Phase 3 多视图与布局 7 项** + **Phase 4 跨窗口接管 4 项** + **Phase 5a 体验第 1 批 7 项**（`quickOpenBasic`/`tabOverflowUI`/`outlinePanel`/`fontSizeSetting`/`bottomPanelCollapse`/`sidebarCollapse`/`helpPanel`）；`mwError` 仅异常时追加）。**本版已整套重跑 `npm run smoke`（父 agent 亲跑、带"运行期间 14 个关键文件零改动"哈希守卫，225 秒）：219 项、`| false` 0 个、`| ERR:` 0 个、无 detail 串失败、末尾 `SMOKE_OK`**（信息型真值串 5 项：`findAll`/`pyUI`/`hugeIndexCold`/`hugeIndexCache`/`hugeSearchFast`）。

### 新功能：跨窗口「接管编辑」（0.5.0 Phase 4）
- **主进程锁表**长在 `filewatch.js` 既有的 `watchers: Map<path, Map<winId, entry>>` 上，`entry` 新增 `mode: 'edit' | 'read'`：首个打开者 `edit`，后来的窗口 `read` **且照旧收 `file-shared-open`（D2 只读语义一字未改）**；`doc:claim-edit` 接管时把其余 `edit` 降为 `read` 并逐窗口广播，`doc:release-edit` 交回但**不自动**让观察窗变为可编辑；窗口 `closed` 时释放全部登记。
- **渲染端**：标签上方出现「🔒 正由另一窗口编辑 —— 本窗口只读」横幅 + 显性「✏️ 接管编辑」按钮（**不藏在标签右键**，且仅当 `readOnly===true` 时出现），接管成功后原窗口**转只读 + toast，不关窗、不弹原生对话框**。
- **L3 冲突提示默认关**：开关打开后不降级并显示冲突横幅（DOM 横幅而非原生 `confirmDialog`——后者会挂住自动化）；关掉时**静默保留本窗口内容**，不丢未保存修改。
- **顺带修掉 B3**（`docs/缺陷清单-0.2.5-审计.md` 的老账）：`fallbackToPoll` 把轮询回调存进 `entry.pollFn`，`stopWatch`/`stopAllWatches` 改为 `fs.unwatchFile(path, entry.pollFn)` —— **不带 listener 会摘掉该路径全部监听**，导致被"顺手"打断的那个窗口再也不会重建轮询兜底（`mwNoPollBreak` 覆盖）。
### 新功能：体验项第一批（0.5.0 Phase 5a · 7 条）
- **A1 `Ctrl+P` 快速打开**：新建 `src/renderer/quickopen.js`；文件名模糊匹配走 `search-worker` 的**只读清单任务**（200/批流式下发 + LRU8 缓存 + 独立记账，可与搜索并行），↑↓ 选择 / Enter 打开 / Esc 关闭；打开即**同步聚焦输入框**（`setTimeout` 只作兜底）。新 IPC：`search:files`/`search:files-cancel`/`search:files-progress`。
- **A3 标签栏溢出**：每栏各自判溢出（按该栏 `.tabs` 的 `scrollWidth/clientWidth`）→ 滚轮横滚、右侧「▾ 全部标签」下拉（**只列本栏**）、`Ctrl+Tab` 浮层（**本栏内循环**）；重算点 = 渲染后 / 分栏 / 拖分隔条 / resize / ResizeObserver。`#tabs`/`.pane-tabs`/`.tab` 结构与 ID 未改。
- **B1 大纲 / TOC**：新建 `src/renderer/outline.js`；markdown 标题树、点击跳转、**随光标高亮**（`tabs.js` 的 CM `updateListener` 新增 `onCursorMove`，归属沿用 `registry.docOfView`）；**类型门控**：非 markdown、`huge`、`viewer-lg` 视图不显示；数据源 = 焦点栏活动文档。
- **B8 字号 / 行高设置**：新增 3 个设置键（字号 / 行高 / 预览字号，默认 `13.5`/`1.65`/`14.5`，与改造前硬编码逐字相同，已进 `settings.js` 白名单）；根元素 CSS 变量 ⇒ **所有栏的 CM 与预览同时生效**；`Ctrl+=` / `Ctrl+-` 步进、`Ctrl+0` 复位（**语义已定义 = 视图缩放复位**：字号+行高+预览字号回默认 **且** 预览缩放回 100%，后者是原有行为）；设置弹窗三项可调。
- **E1 底部面板默认折叠**：启动即折叠（只加 `.collapsed`，面板体 DOM 与写值路径一字未动），点面板页签 / `Ctrl+F` / `Ctrl+H` / ▶运行 / 全局搜索跳转都会先展开；新增 ⛶ 最大化/还原；Esc 收起并**同时退出最大化**（修掉"折叠却保留 maximized、下次展开直接 72vh"的隐性 bug）。已核对：**无既有用例依赖面板可见**。
- **E2 侧栏分区折叠**：树 / 收藏 / 搜索三个分区可各自折叠并记忆（`sidebarCollapsed` 落盘）；**`tree.js` 零改动**，J4 修好的展开态恢复逻辑未被破坏（用例 `tree-expand-state-kept` 覆盖）。
- **F1 快捷键帮助面板**：新建 `src/renderer/help.js`；`F1` / `Ctrl+/` 打开，分组过滤；**键位表 = 面板显示与键位分派同一张表**（`SHORTCUTS` + `SHORTCUT_ACTIONS`，键位分派改表驱动，96 组 `key×ctrl×shift` 差分与旧 if/else 链逐条等价）。
- **顺带修掉的真缺陷**：① `clampFont` **按 1 位小数归整**导致 `1.65` 被写成 `1.7`、`1.05`→`1.1` ⇒ **settings 与界面静默漂移**（凡走 `applyFonts` 的路径：启动/弹窗保存/Ctrl+=、Ctrl+-/Ctrl+0/跨窗口同步都会显示错值）；改成 2 位小数并加回归守卫 `fractional-line-height-preserved`。② `Ctrl+Shift+O` 被 `Ctrl+O` 吃掉（键位差分探针发现）。③ `openTabsMenu` 在未溢出时会立刻关掉自己刚打开的菜单。④ `sidebarCollapsed` 的 TDZ（声明晚于 `createFavorites` → 启动即崩）。⑤ 底部面板 Esc/Esc 与最大化的状态残留。

### 新功能：体验项第二批（0.5.0 Phase 5a · 4 条：A2 / F2 / G1 / G2）
- **A2 `Ctrl+Shift+T` 重开刚关闭的标签**（`tabs.js` + `help.js:60` + `app.js:1467`）：新增最近关闭栈（**新→旧、上限 20**），快照含 路径 / 栏位 / 固定 / 只读 / 光标 / 滚动 / `dirtyAtClose` / `savedOnClose` / ≤2M 字符文本。**落栏语义**：原栏还在 → 回原栏；原栏已撤空 → 落焦点栏；文件已被重新打开 → 只激活、不动内容与光标。**未保存内容的四条路径都以"是否真的写盘"（`savedOnClose`）为准**；**huge 标签走显式降级**：`reopenInfo.degraded=true` + `reason='HUGE_OVERLAY_NOT_REATTACHED'` + toast 说明「改动只在恢复区」，并如实登记 `hugeScrollRestored`（行索引未就绪时不静默）。
- **F2 树 / 标签右键常用项**（在资源管理器中显示 / 复制路径 / 复制文件名 / 在终端打开 / 用默认程序打开）：新增 3 条 IPC —— `shell:open-path`（`src/main/ipc.js:486`）、`shell:open-terminal`（`:500`）、`clipboard:write-text`（`:540`），**全部先过 `guardApprovedExisting`**（`:468`：`security.requireApproved` + `statSync` 存在性校验），拒绝时返回 `{ok:false, reason:'NOT_APPROVED'|'ENOENT'}` 而非抛异常。**「在终端打开」路径只经 `cwd` 传给子进程**（`argv` 对 Windows 恒 `[]`、`shell:false`、`detached:true`、`stdio:'ignore'`，渲染端不做命令拼接 ⇒ `& | ^ %` 进不了命令行），并支持 `opts.dryRun` 只回执口径（冒烟据此断言，不真弹控制台）。**剪贴板正文由主进程按已批准路径自拼**（渲染端只传 `{path,kind}`，传了 `text` 也不生效）。树与标签菜单是**同源副本**（`tree.js:87-90` / `tabs.js:2527-2528`），改动必须两处同步。
- **G1 文件内查找三开关（Aa / 整词 / 正则）**（`find.js`）：匹配与高亮统一改走 RegExp `exec`（修掉变长小写映射 `İ` 的下标错位，高亮与替换位置天然一致；默认口径结果与旧实现逐位相同）。正则开启后**三层防 ReDoS**：模式长度上限 **200 字符**（`find.js:35`）、嵌套量词（形如 `(a+)+`）静态拒绝（`:47`）、**120ms 执行预算**（`:36`，先在前 200 行做 30ms 预检）。**huge / 查看器 / 图片 / 对比视图内 `Ctrl+F` 给出显式提示**（`UNSUPPORTED_MSG`，`:49`；计数行与结果区同时显示），不再静默 0 命中。
- **G2 匹配上限 + 输入防抖**（`find.js`）：展示上限 **500 处**（`:39`），计数行与结果区尾部行**双处显式提示**「仅显示前 500 处（已截断）」（截断提示行走 `.find-more`，不占结果行计数）；输入防抖 **80ms**（`:40`，只挂 `input` 事件，`setQuery` 与文档变化路径仍同步）；**「全部替换」不受展示上限约束**（重新全量扫描，上限 5 万处 + 2s 预算，绝不"只换前 500 处"）。

### 新功能：崩溃恢复 UI（0.5.0 挂账项：渲染端消费 `huge:doc-recover-list`）
- 新增 `src/renderer/recover.js`（`createRecover`，`:98`）：启动扫描 `<userData>/overlay` 的恢复区 → 状态栏 chip（`index.html:159`，`app.js` 接线）→ DOM 弹窗逐条目「恢复 / 丢弃」；应用级提示走 `ui.js` 的 `note()`（`:207`，类名 `mh-note`）。**恢复前先把整个计划读齐**（块表 / 分片 / 身份），读失败时一个字节都没动、恢复区原封不动可重试。
- **两道身份闸（硬要求：绝不用过期块表覆盖用户文件）**：闸① 当前源文件 `stat` 的 `size` 与 `floor(mtime)` 必须等于块表 `meta`（`recover.js:329` 一带）；闸② `huge:doc-open` 返回的 `key` 必须等于条目 key（拦 realpath 漂移，以及"闸①过了、打开前文件又变了"的竞态）。任一不符 → **拒绝 + 红字可断言文案**（`.recover-error`，`styles.css:1159`），且**不写源文件**。
- **回放**：按 run **倒序**调 `huge:doc-edit`（目标行号在干净文档上一次算完，从后往前应用不会被前面的行数增删污染）；恢复只进 overlay 会话与内存，**不写源文件**。
- **丢弃**：**`others > 0` 一律拒绝、零 probe**（`recover.js:515-518`：可行动文案在 `:516`「另一个窗口正在打开该文件：请先关闭那个窗口里的该文件标签，再回到这里丢弃」）—— 两条理由：① probe 的收尾 `hugeDocClose({discard:false})` 在 overlay 侧是**无条件** `persistMeta()`，当 `doc.key !== item.key` 时会把用户**更新的**未保存内容覆盖成 `dirtyBlocks=0`（数据丢失）；② 即使身份相符，probe 也要走一次 `huge:doc-open` → `lineindex.getIndex()`，GB 级文件冷启动是**整文件冷扫** —— 不能让"清理过期条目"这种动作付这个代价。逐条否决记录见 `recover.js:498-509`。`others === 0` 才走直删 ⇒ **不再经主进程 `dropKey`**（`getIndex` 调用 1→0），删 `<key>.json` + `<key>.tmp`（`recover.js:528-529`）后**做删后残留复核**（`:534`，用例 `recCleanup`）。**代价**：别的窗口只打开该文件时不能丢弃（有可行动文案）⇒ 顺延 0.5.1（给 `huge:doc-close` 加 `persist:false` 即可放宽到"身份相符才 probe"）。

### 顺带修掉的真缺陷（0.5.0 Phase 5a 第 2 批）
- **huge 视图里按 `Ctrl+F` 不给提示（挂账的"静默 0 命中"）**：`runSearch` 里"空 query 提前返回"排在"无文档视图判定"**之前** ⇒ 现在把无文档视图分支提到最前（`find.js:305-327`；分支前的显式注释在 `:307`），`focus()/focusReplace()` 一进面板即可看到「当前视图不支持文件内查找（大文件视图）」；覆盖 `huge` / `viewer-lg` / `image` / `diff` 四类。
- **关闭脏 huge 标签"没写盘却报保存成功"（0.4.0 遗留）**：`closeTab` 把 `saveNow(tab)` 排进写队列（**微任务**才跑），而同步段已经 `tab.huge = null` + `destroy()` → `doSaveNow` 命中 `if (!hv)` 并**返回 `true`**。现在该分支返回 **`false`**（`tabs.js:3067`，约定：**本次没有发生写盘**，不等于"写失败"，调用方不得据此认为已落盘），`trackClosedSave` 对 huge 与普通标签改为**同一条"按返回值推导 `savedOnClose`"**的路径（`:2208`），重开的降级口径与磁盘事实一致；用例 `huge-close-does-not-write-disk` 兼作回归守卫（将来若真改成"先保存再关"，它会立刻变红）。

### 测试（0.5.0 Phase 5a 第 2 批 + 崩溃恢复 UI）
- 用例总数 **225 项**（公式 **`219 + 4 + 2 = 225`**，其中 219 见上一条公式；**差分口径实测**：`await step(` 调用点 **164 → 166**（+2 = 恢复 UI 两条）、`p6Case` **0 → 4**（Phase 5a 第 2 批四条），`runCase` 6 / `splitCase` 7 / `mvCase` 7 / `p5Case` 7 与直推项**一字未变**。**冒烟脚本随本版更新（225 项）**；**脚本指纹不写死在文档里**（脚本还会随修复微调），最终指纹见 `docs/开发计划-多视图与体验流畅度-0.5.0.md` §12.6 所引的**带守卫运行 before/after 两列**。223 本身 = 219 + Phase 5a 第 2 批 4 条）。
- 新增 6 条用例：`reopenClosedTab`（23 合取项）/ `ctxMenuCommonItems`（13）/ `findCaseWordRegex`（13）/ `findMatchLimit`（9）/ `hugeRecoverPrompt`（11）/ `hugeRecoverReject`（18）—— **逐合取项命名进失败串**；`hugeRecoverPrompt` 的 `cleanOk` 断言"丢弃后 `stat` 无残留 + chip 收起 + 列表无该条目"。
- 计数口径提醒：**223 只对 11:14:44 那次产物成立**，且那次修订版同时含本节的恢复 UI WIP ⇒ **批次隔离性未达成**（验证局限，详见 `docs/开发计划-多视图与体验流畅度-0.5.0.md` §12）。
- **本版已整套重跑 `npm run smoke`**（父 agent 亲跑，12:27:28→12:31:28，日志 `%TEMP%\mh-smoke-225-v3-122728.log`；**带哈希守卫：`before`/`after` 两列 changed = 0 ⇒ GUARD PASS**）：`node scripts/smoke-verify.js <日志> --expect 225 --require reopenClosedTab,ctxMenuCommonItems,findCaseWordRegex,findMatchLimit,hugeRecoverPrompt,hugeRecoverReject` → **结果行 225 · `| false` 0 · `| ERR:` 0 · 非 true 非信息型 0 · `SMOKE_OK` 1 ⇒ `SMOKE_VERIFY OK`（true 220 项 + 信息型 5 项）**。
- **同批另两次运行不作数**（如实登记）：`…-120625` 因运行期间 `scripts/smoke.js` 被写 ⇒ **哈希守卫 FAIL、判废**（另有 4 条会话/布局类用例在运行期机器负载下转红，整轮 10 分钟 vs 基线 4 分钟）；`…-121726`（v2，**守卫 PASS**）有 5 条**焦点依赖**用例因窗口失焦转红（`disk.keys=null` + `hasFocus=false`）。**运行期间本文档的写入 = 零**（详见 0.5.0 计划 §12.6）。
- **两条恢复用例此前从未在任何运行中跑绿**（11:39 那次卡在夹具被打开上限拦下；`120625` 那次只差 `clean` 与 `1.changed` 两点），**本次 v3 是它们首次全绿** —— 因此 0.5.0 的恢复 UI 端到端覆盖以这次运行结论为准。

### 新功能：同一文件多视图 + 布局持久化（0.5.0 Phase 3）
- **同一文件可在两栏各开一个视图**：每视图独立 `EditorState`（光标/滚动/撤销栈各自独立），内容变更按**文档**串行广播 —— `tabs.js` 的 `updateListener` 分出「本地 vs 远端」两条路：本地把 `u.transactions.slice()` 入队，队列回调对同一文档的**其它视图**按顺序逐个 `dispatch({changes: tr.changes, annotations:[remoteAnnotation.of(true)]})`；远端分支只推进基线、**不回播**（防环的唯一凭据）。程序化变更（分段预读/外部重载）的 `addToHistory:false` 一并透传，避免接收侧被重新标脏。
- **引用计数与关闭语义**：`docmodel.js` 新增 `viewsOf/viewCount/hasViews/panesOf/ensurePaneOf/dropPaneOf`；`bindView` 换绑**先摘旧登记**（否则 `viewsOf` 归不了零 → 关最后一个视图不弹确认框 = 静默丢数据）。`closeTab` 分**视图级 / 文档级**两个粒度（`opts.all`）：关一个视图**不落盘、不清脏、文档仍在**，关最后一个才走文档级保存；`closeAll`/`closeByPath` 传 `all:true`。
- **标签右键「⧉ 在另一栏打开」**（`openInOtherPane`）；`Ctrl+Tab` 仍是栏内循环；同一文件已在另一栏时 `openFile` 仍只聚焦并 toast，**第二视图只在显式要求时创建**。
- **布局持久化**：会话快照从 `{paths,active,pinned}` 扩展为 **四键（+`layout`：`orientation`/`sizes`/`focus`/`panes[].{docs,active,pinned}`）**，三键一个都没删；`persistSession(force,{final})` 的**焦点守卫语义不变**（仅关窗前用 `final`），新增 `beforeunload`；旧会话（无 `layout`）走「映射成单栏」分支逐位兼容，恢复上限总视图 ≤240 / 每栏 ≤200。修复一个恢复期口径缺口：**`restoreSession` 过去只"建栏"从不"合栏"** → 单栏快照在已是双栏的窗口里恢复完仍是双栏；现在先反向归一（`plan.panes.length<=1 && 当前栏数>1 → mergePanes()`），保证**恢复结果 = 快照**。
- **限制**：禁止 huge / viewer-lg 同一文件多视图（overlay 路径单例）；两栏硬上限仍为 2；`tab.scrollTop` 目前仍是文档级单值（同文件两栏的滚动记忆会互相覆盖，未做逐视图记忆，留待后续）。

## v0.3.0（2026-08-30）

### 移除
- **AI 助手整块移除**（明确不需要，投入产出比低）：删除渲染端 AI 侧栏（`ai-panel.js` 与全部 DOM/样式）、主进程 `ai.js`（OpenAI 兼容对话 / SSE 流式 / function calling / 模型列表）与 6 个 IPC 通道（`ai:chat`、`ai:abort`、`ai:tool-result`、`ai:list-models`、`ai:tool-call`、`ai:chunk`）；设置弹窗去掉 AI 区块；`settings.js` 不再持有与加解密 API Key，并在加载时**一次性清理旧版本遗留的 `ai*` 配置键**（含 DPAPI 加密的 Key）。主 bundle 0.91 MB → 0.89 MB。

### 修复（Phase 0：静默数据丢失与功能失效，均经真实窗口复现 → 修复 → 回归）
- **分段大文件撤销截断**：分段预读 / 程序化重载（外部修改重载、查看器换窗）不再进入撤销历史；`chunked` 未加载完整时拒绝写盘（补读失败宁可报错也不截断文件）。修复前 Ctrl+Z 一次即撤掉 2MB 段，800ms 后自动保存把 5.39MB 文件写成 2.10MB。
- **CRLF 保真**：记住原文件行尾风格，保存（含 >64MB 流式写）按原样还原 —— 不再因为一次保存就把整个文件的行尾改成 LF。
- **大文件查看器真只读**：`viewer-lg` 在「启用区域编辑」之前 `state.readOnly === true`（此前可直接输入，且未启用编辑时的保存会"假装成功"，输入内容随翻页丢失）。
- **删除不再复活**：删除 / 移走导致的关标签走 `save:false`，并清理挂起的自动保存定时器（此前 dirty 标签的保存会把刚删除的文件写回磁盘）。
- **Python**：① 单批 >3000 行不再整批丢失（`removeChild(null)` 抛 TypeError）；② 输出改 `StringDecoder` 流式解码，中文不再出现 `�`；③ 连续运行后「■ 终止」仍有效（旧进程 close 回调不再清空新进程引用），面板状态不再被旧进程退出事件覆盖。
- **文档对比**：超大块新增不再抛 `RangeError`（`push(...15万行)` 改逐行 push，V8 参数上限 ≈12.5 万），计算异常给出可读提示而不是空白。
- **右键「用 MarkHunter 打开」**：① 有历史状态（上次目录 / 侧栏多根 / 上次会话）时 `--dir` 不再被 boot 的目录恢复分支吞掉（preload 缓冲 + 启动收尾补判）；② `second-instance` 会重排 argv（`--dir` 与值被拆开）导致取到 Chromium 开关 —— 解析逻辑抽到 `src/main/args.js` 并加固（三种取值 + 存在性校验）；③ 坏路径给出「无法打开指定目录」提示；④ `--dir` 启动为干净窗口（不恢复上次会话）；⑤ 目标目录与已打开根存在包含关系时不再直接拒绝：目标在某根内 → 激活该根并定位，目标是若干根的祖先 → 用目标替换这些子根。
- **测试隔离**：`--smoke/--exttest/--mmtest` 改用独立 userData profile，不再改写真实用户配置（本次审计实测被改：主题、上次会话、上次目录、侧栏根、大文件上限、AI 模型）。

### 测试
- 冒烟 **179 项全通过**：移除 AI 相关 10 项，新增 Phase 0 回归 11 项（`chunkUndoNoTruncate`、`crlfPreserve`、`deleteNoResurrect`、`pyOutputBigBatch`、`pyOutputUtf8`、`pyKillAfterRestart`、`diffHugeInsert`、`rcNestedReplace`、`viewerReadOnly`、`rcDirArgParse`、`noAiSettings`）。

## v0.2.5（2026-08-29）

### AI 助手通用化 + 体验升级
- **任意服务商 / 中转站 / 本地模型**：设置新增**服务商预设**一键填入（DeepSeek / OpenAI / 硅基流动 / Kimi / 智谱 GLM / 通义 Qwen / Ollama / LM Studio / 自定义中转），服务地址与模型名均可自由修改；新增**「📋 拉取模型列表」**按钮（GET /models，OpenAI 兼容端点通用，点击模型输入框即可下拉选择）；移除 DeepSeek 专属的「最新版 / 推理版」类型下拉（模型徽标菜单保留 DeepSeek 快捷项 + 「打开设置」自由配置入口）。
- **服务地址更宽容**：裸域名自动补 `/v1`（如 `https://your-relay.com` 直接可用）；http 放行范围从仅本机回环放宽到**局域网私网 IP**（192.168.x / 10.x / 172.16~31.x），支持局域网 Ollama / LM Studio / 内网中转；本地服务无需 Key 时可填任意非空占位。
- **流式输出（打字机）**：回复逐字实时渲染（SSE 增量经 ai:chunk 推送），不再干等「思考中…」；兼容忽略 stream 参数直接回整体 JSON 的中转站；请求头尽量携带 stream_options 统计用量。
- **推理模型思考过程**：deepseek-reasoner 等返回的 `reasoning_content` 以「💭 思考过程」可折叠块显示（流式实时展开，此后跟随手动开合，不再静默丢弃）。
- **对话可清空**：AI 侧栏新增「🧹 清空对话」（上下文与 tokens 统计同步复位），修复 history 无限增长无法重置。
- **失败恢复上下文**：请求失败时自动保留本次「📄 全文 / ✂ 选中」附加的上下文，直接重试仍携带，不必重新点。
- **友好错误提示**：401/403 → 提示检查 API Key；404 → 提示检查 /v1 与模型名；429 → 提示限流或额度；其余保留服务端原文（截断 300 字符）。
- **稳定性修复**：终止时若正等待工具执行，合成「（用户已终止）」tool 消息再中断，保证消息序列在任意 OpenAI 兼容端点合法；工具轮 assistant 消息保留 reasoning_content（推理模型多轮上下文完整）。

### 测试
- 冒烟新增 5 项（共 **179 项** 全部通过）：新增**本地 mock OpenAI 兼容服务**（127.0.0.1:18432，SSE 流式 + 两轮工具调用 + /models，无需真实 API 与外网）——`aiMockChat`（流式增量/思考块/工具循环/用量累计 27）、`aiMockModels`（列表拉取排序）、`aiSettingsUI`（预设下拉/拉取按钮/datalist 填充/旧下拉移除）、`aiClearButton`、`aiSettingsRestore`（现场还原）；既有 `settingsAI` 同步新 UI 断言。

## v0.2.4（2026-08-29）

### 图片体验完善（预览 / 查看器 / 图片标签页）
- **预览图片右键菜单**：右键任意预览图片 → **📋 复制图片（原图）**（原图字节直写剪贴板，不压缩不缩放）/ **📁 在文件夹中显示**（新增 `shell:show-in-folder` IPC）/ **🔍 打开图片查看器**；外链图片仅提供打开查看器。图片标签页同样支持右键复制原图与在文件夹中显示。
- **查看器操作条位置修复（根因修复）**：`#viewer-bar`（大文件横幅）的悬浮样式曾被 `.viewer-bar` 类名共享，把双击弹窗里的「放大/缩小/重置」操作条绝对定位到弹窗顶部（远离图片）。横幅样式收敛为 `#viewer-bar` 专属，操作条回归图片下方文档流位置。
- **滚轮缩放增强**：查看器内直接滚轮缩放（原有）升级为**以光标为锚点**——放大时对准鼠标位置，不再跳向左上角；「放大/缩小」按钮锚定画布中心。
- **1:1 原始尺寸**：查看器新增「1:1」按钮（解除缩放限制按原始像素显示，大图可拖拽/滚动查看各部位），原「重置」更名为「适应」；**双击图片在「适应 ↔ 1:1」间切换**。
- **Esc 关闭弹窗**：图片/mermaid 查看器等所有应用内弹窗支持 Esc 关闭（优先级：右键菜单 > 弹窗；Esc 不再顺带收起底部面板）。
- 光标反馈：预览图片 `zoom-in`（已有）、查看器画布 `grab`（拖拽中 `grabbing`）。

### 测试
- 冒烟新增 4 项（共 **174 项** 全部通过）：`previewImgCtx`（右键菜单三项+复制链路）、`previewImgClip`（主进程侧断言剪贴板 = 1×1 原图字节）、`showInFolderIpc`（IPC 通道）、`viewerBarBelow`（操作条在图片下方且非绝对定位 + 1:1 原始尺寸 + Esc 关闭）。

## v0.2.3（2026-08-28）

### 新功能：多目录侧栏 + 跨目录拖拽传输
- **侧栏多目录**：左侧栏可同时打开多个目录（「📂 选择目录」= 追加目录并设为活动；根间嵌套拒绝、上限 12 个），每个目录一个独立树分支；**活动目录**带「活动」徽标（全局搜索 / 新建等操作的默认目标），可在根行右键「📌 设为活动目录」切换。目录列表持久化（`sidebarRoots`），重启恢复全部目录与活动目录。
- **根行管理**：根行悬停显示「✕」（仅从侧栏关闭，不删磁盘文件）；右键菜单提供「设为活动目录 / 关闭此目录」（根目录本体不再提供「删除目录」——主进程对任何侧栏根目录的删除一律拒绝并提示）。
- **跨目录拖拽传输**：目录树行可拖拽，拖到任意目录行（含另一目录的根）释放 = **移动**，**Ctrl+拖拽 = 复制**（Windows 资源管理器习惯）；支持递归目录传输；同盘 rename 直移，跨盘自动回退「复制 + 删除源」。
- **冲突处理**：目标已存在同名项时弹出应用内确认 —— **覆盖**（文件替换 / 目录合并）/ **保留两者**（自动改名「名 (2).扩展名」）/ 取消。
- **打开标签跟随**：移动文件/目录后，其中已打开的标签自动切换到新路径并重挂文件监听（复用重命名同步链路）。
- **权限口径保持（S1）**：传输的源与目标都必须在侧栏根集合内（或外部已打开过的文件），`fs:transfer` 主进程二次校验；「外部文件」分支的文件行也可拖入目录收编，未批准路径传输明确报错。
- **「外部文件」分支随多目录自适应**：任一侧栏根内的路径不再进入外部分支；关闭目录后其中已打开文件自动回落到外部分支。

### 测试
- 冒烟更新/新增（共 **170 项**）：`openDirFromPath` 改为嵌套拒绝 + 非嵌套打开 + 关闭回收链路，`extSwitchRoot` 改用关闭根回切；新增 `multiRootOpen`（双根渲染/徽标/持久化）、`multiRootNestRejected`（嵌套拒绝）、`multiRootDropCopy`（Ctrl 拖复制）、`multiRootDropDir`（目录递归复制）、`multiRootDropMove`（拖动移动 + 标签路径跟随）、`multiRootConflictDedupe`（冲突弹窗保留两者改名 (2)）、`multiRootDeleteProtected`（根目录删除保护）、`multiRootClose`（✕ 关闭 + 活动转移）、`multiRootTransferReject`（未批准目标拒绝）。

## v0.2.2（2026-08-27）

### 修复
- **右键「用 MarkHunter 打开」侧栏目录错误**：资源管理器右键以 `--dir` 指定目录打开时，`open-dir` 事件与渲染端 boot 的「上次目录恢复」存在竞态 —— lastDirectory 恢复在后执行，把指定目录覆盖（侧栏停留在旧目录）。修复：指定目录登记为 `externalDir` 并在 boot 恢复段**优先采用**；boot 完成后到达的 open-dir（second-instance 新窗口等）仍直通执行。实测验证：lastDirectory 预置为干扰目录后带 `--dir` 冷启动，侧栏根目录与目录标签均为指定目录。

## v0.2.1（2026-08-27）

> 未完成清单清零批次：对比增强（三方/树右键/大文件截断）、查看器补强（外部重载/UTF-8 边界/提取另存）、可靠性收尾（会话焦点写入/200 满档/GBK 流式搜索）。

### 多文档对比增强
- **三方对比**：对比对话框勾选「三方对比」→ 基准 · 本方(当前) · 对方三栏视图；两侧各自与基准行级 diff 按基准行号对齐；**「双方改同行且不同」高亮为潜在冲突行**（⚠ 统计徽标），导航/分批渲染/交换本对方齐备（合并/冲突解决编辑仍为后置项）。
- **文件树右键对比**：任一文件右键「🔖 设为对比基准」→ 另一文件右键「🔀 与基准对比」直接打开双栏 diff（免对话框）。
- **大文件对比**：单侧 >20MB 由硬拒绝改为**截断对比**（醒目横幅注明截断点后差异不可见）；**超长行截断显示**（>4000 字符显示前段 + 长度提示，修复 20MB 级单行卡死渲染线程）。

### 大文件查看器补强
- **外部修改自动重载**：viewer-lg 标签现在参与 file-changed 同步（区域编辑中且有修改先确认），刷新文件大小并重读当前窗口。
- **UTF-8 窗口边界修复**：跨窗口边界的多字节字符不再显示替换符（尾部多读 4 字节 + 首尾部分序列剥离，区域写回区间同步校正；GBK 窗口维持原语义）。
- **📤 提取为新文件**：把当前窗口内容另存到同目录新文件并正常打开编辑（二进制窗口禁用）。

### 可靠性收尾
- **多窗口会话**：仅焦点窗口写入 lastSession（后台窗口的标签变化不再覆盖最后活动窗口的会话）。
- **会话 200 满档实测**：压测用例升至 200 标签（恢复 1.1s，顺序/数量正确）。
- **全局搜索 GBK 流式**：大文件（>10MB）流式扫描增加编码探测（首块 UTF-8 严格失败 → GBK 增量解码，正确处理分块边界多字节字符），GBK 大日志可搜索。

### 文档
- README 补「多窗口同时编辑」「多文档对比」功能章节与 Ctrl+Shift+N 快捷键。

### 测试
- 冒烟更新/新增（共 **161 项** 全部通过）：`diffThree`（三栏/both 行/统计）、`treeCompare`（基准右键全链路）、`diffLimits`（截断横幅+渲染）、`stressSessionFull`（200 满档）；`diffUnsaved` 加 autosave 竞态隔离。过程中修复一处边界剥离重构引入的 `isActive` 引用错误（viewer 打开失败，两用例抓住）。

## v0.2.0（2026-08-24）

> 三阶段计划收官（docs/开发计划-可靠性大文件多窗口对比-0.2.0.md 全部完成）：
> v0.1.49 可靠性/上限/大文件 4GB → v0.1.50 特效皮肤（插入需求）→ v0.1.51 多窗口 → **v0.2.0 多文档对比**。

### 新功能：多文档对比
- **工具栏「🔀 对比」**：当前文档与 **其它打开的标签 / 剪贴板内容 / 磁盘版本（查看未保存改动）** 一键对比。
- **双栏 diff 标签**（独立内容区，可同时开多个对比）：
  - 行级 增/删/改 三色底 + **词级内联高亮**（修改行内精确标出变化的词）；
  - 左右双栏在同一滚动容器内（天然同步滚动），行号对齐、等宽字体；
  - **变更块导航**（↑ 上一处 / ↓ 下一处，循环跳转并高亮当前块，序号徽标 N/M）；
  - 统计徽标：`+N −M ~K 行（共 X 处变更）`；
  - **⇄ 交换左右** 一键重对比；**📤 导出报告** 生成 Markdown 对比报告（unified diff 风格）并保存到工作目录。
- **限制与保护**：单侧 ≤20MB（jsdiff O(ND) 超限明确拒绝）；行数分批渲染（首批 2 万行 + 加载更多）；超长行（>2000 字符）退化为行级高亮；对比标签只读、不参与会话持久化（重启不恢复临时视图）。

### 依赖
- 新增 `diff`（jsdiff，纯 JS）——esbuild 打进主 bundle（0.86→0.88MB）。

### 测试
- 冒烟新增 6 项（共 **159 项** 全部通过）：`diffBasic`（行级统计/LCS 分块语义）、`diffWords`（词级高亮内容）、`diffNav`（导航循环与序号）、`diffUnsaved`（工具栏对话框 + 磁盘版本全链路）、`diffLimits`（超限拒绝）、`diffSessionExcluded`（会话排除）。

## v0.1.51（2026-08-24）

> 三阶段计划之二（docs/开发计划-可靠性大文件多窗口对比-0.2.0.md）：多窗口同时编辑。

### 新功能：多窗口
- **新建窗口（Ctrl+Shift+N / 二次启动程序）**：每窗口独立渲染上下文（各自的目录/标签/面板/查找），主进程统一持有安全状态与设置；关闭其一不影响其它窗口。
- **单实例锁**：再次启动 MarkHunter（如双击 exe、右键"用 MarkHunter 打开"）不再开新进程，而是在已运行实例中开新窗口；携带 `--dir` 时以指定目录开窗。
- **事件按窗口路由**：文件变更通知发给监听该文件的各窗口；Python 输出/退出、AI 工具调用事件发给发起窗口；搜索进度发给请求窗口；原生对话框挂在调用方窗口上（此前全部固定发给首窗口）。
- **设置/主题跨窗口同步**：任一窗口修改设置（主题/换行/缩进/滚动条宽度）即时广播到其它窗口换肤生效。

### 同文件跨窗口协调（D2 决策实现）
- 第二个窗口打开已在其它窗口打开的文件时**自动以只读打开**（toast 提示，标签带 🔒 徽标，状态栏显示"🔒 只读"）——哪个窗口编辑由你在标签右键「🔒 设为只读 / 🔓 允许编辑」随时切换（切换在线热切，无闪烁）。
- **编辑窗口保存后，只读观察窗静默同步**：不弹任何确认/toast、800ms 节流合流连续自动保存、光标与滚动位置保持——"不闪不抖"。
- 两窗口都编辑同一文件时沿用既有冲突语义（外部修改确认框）。

### 工程细节
- filewatch 重构为按窗口隔离的 watcher 表（path → winId → entry），窗口销毁自动清理孤儿监听；`stopWatch` 作用域限定到请求窗口。
- 会话策略：多窗口下 lastSession 为"最后写入者"（约等于最后活动窗口），冷启动恢复单窗口会话。

### 测试
- 冒烟新增 8 项（共 **153 项** 全部通过）：主进程编排第二后台窗口验证 `mwBoot`（独立上下文）、`mwThemeSync`（主题广播）、`mwFileChangedRouting`（变更通知按窗口路由）、`mwSharedReadOnly`/`mwSharedSync`（同文件自动只读 + 编辑保存静默同步）、`mwPythonRouting`（Python 输出路由）、`mwCloseSurvive`（关窗存活）。

## v0.1.50（2026-08-24）

### 新功能：20 款动态特效皮肤（皮肤总数 36 → 56）
设置 → 主题新增「特效」分组，20 款含动态背景动画的皮肤（9 浅色 + 11 暗色）：

- **浅色 9 款**：极光（三色漂移）、樱花（花瓣飘落）、海洋（波光流动）、冰晶（冷光斜掠）、彩虹（流光变色）、玻璃（毛玻璃光斑）、晨雾（绿雾横漂）、薰衣草（紫晕呼吸）、鎏金（金辉扫掠）
- **暗色 11 款**：霓虹（品红/青双色辉光）、黑客帝国（绿色字符雨+扫描线）、星空（星点闪烁）、熔岩（余烬呼吸）、复古CRT（扫描线滚动+微闪）、蒸汽波（日落渐变+色相缓旋）、深海（气泡上升）、水墨（墨晕缓渗）、赛博（红青故障条）、量子（锥形光谱旋转）、日蚀（金环呼吸）

工程实现与安全约束（不影响功能）：
- 全部特效规则限定在 `[data-theme^="fx-"]` 选择器下 —— **既有 36 款主题与全部功能零影响**（冒烟 145 项全绿证明）；
- 背景层 `#fx-layer` 默认隐藏、`pointer-events:none`、`z-index:-1`，不拦截任何点击/编辑/滚动；
- 主框架（工具栏/侧栏/底部面板）特效下呈半透明毛玻璃，编辑区保持 93% 不透明底、预览 88% —— 文本可读性优先；工具栏底部有强调色流光条；
- 动画仅用 transform/opacity/filter（GPU 合成）；系统开启「减少动态效果」时自动停用全部动画（铺面保留）；
- 调色板经 daisyUI 主题块注册自动桥接 `--mh-*` 令牌（与内置主题同机制）；暗色特效 11 款纳入 DARK_THEMES（防闪白底色 + mermaid dark 同步）。

### 工程改进
- **CI 双草稿自动合并**：v0.1.46 起 electron-builder 连续 5 版把 Release 资产拆进两个草稿（此前每版手动 API 合并），新增 `scripts/fix-release-drafts.js` 并入 release.yml —— 自动搬运资产、转正发布、清理残缺草稿。

### 测试
- 冒烟新增 `fxTheme`（20 款逐一应用 + fx-layer 显示与动画运行 + 暗色清单 + 设置白名单持久化往返 + 切回经典零残留），`themeCatalog`/`themeGrouping` 更新至 56 皮肤/25 暗色/特效分组断言。共 **145 项**全部通过。

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
