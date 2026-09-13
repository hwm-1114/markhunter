# 开发计划：多视图 Phase 1（抽出 `src/renderer/docmodel.js`）重构清单

> **本文性质**：**只读侦察产物**。由独立 agent 在**不修改任何产品代码**、**不运行 `npm run build` / `npm run smoke`**（另一 agent 独占构建与冒烟通道）的前提下，逐行核对当前工作区代码后写成。
> **唯一允许的写入**：本文件。其余所有 `文件:行号` 均为**实测**，不是从既有计划文档抄来的。
> **基线**：`git rev-parse --abbrev-ref HEAD` = `main`，`HEAD` = `8161f7d`（v0.2.5 提交）；工作区含**未提交**改动（大文件线 A–D 与 AI 移除等，见 §9.4 `git status --short`）。
> **校对时间**：侦察当次工作区的文件内容；`scripts/smoke.js` **在侦察期间被另一 agent 改动过**（3815 行 → 4353 行，用例 186 → 192），两次数值都记在 §6.4。
> **上位依据**：`docs/开发计划-多视图与体验流畅度-0.5.0.md`（Phase 1 定义）、`docs/开发计划-多视图与体验流畅度-0.3.0.md` §2（架构方案，未压缩，仍是实现依据）、`docs/开发计划-大文件秒开与秒搜-0.4.0.md` §6/§13（大文件现状）。

---

## 0. 先看这里：与既有计划文档的**数字冲突**（以本文实测为准）

| 项 | 既有计划写的 | 本文实测 | 口径 / 命令 |
|---|---|---|---|
| `tabs.js` 行数 | 1950（0.5.0 §2）、「1950 行」（0.5.0 §8） | **2040** | `[System.IO.File]::ReadAllLines(path).Count` = 2040；`read` 工具亦报 `of 2040` |
| `activeTab` 引用数 | 84（0.5.0:41；0.3.0:372 写「60+ 处」） | **83**（分布在 **67 行**） | 见 §2.1 命令；注意 85 是**大小写不敏感**计数，多出的 2 处是 `getActiveTab` 里的 `ActiveTab` 子串 |
| `tabs.js` 对外 API | 36（0.5.0:40 / 0.5.0 §8） | **33** = 31 个功能 API + 2 个测试面 | 从 `tabs.js:2029-2039` 的 `return {...}` 逐键解析，见 §3 |
| `tabs.find` 处数 | 6（0.5.0:41） | **6** ✅ 一致 | `regex 'tabs\.find'` 全文计数 = 6（`:293`/`:925`/`:1568`/`:1654`/`:1688`/`:1830`） |
| 冒烟用例静态枚举 | 183（0.5.0 §1.1/§5/§8；0.4.0 §7 E 行） | 快照 A（侦察主体）= **186**（与任务口径一致）；快照 B（收尾复查，另一 agent 的 6 项已落地）= **192** | §6.4 有完整推导；**运行时以 `E2E_RESULTS` 计数为准** |
| `scripts/smoke.js` 行数 | — | **3815**（侦察主体）→ **4353**（收尾复查） | 该文件被另一 agent 追加了 6 个 `runCase` 用例，见 §6.4 快照 B |
| `src/renderer/docmodel.js` | 「当前不存在」 | **不存在** ✅ | `Test-Path` = `False` |

**结论**：`tabs.js` 自 0.5.0 计划写作后又长了 90 行，**所有既有文档里的 `tabs.js:NNN` 行号都已漂移**，§9.3 给出漂移对照表，施工时**一律以本文行号为准**。

---

## 1. 现状结构图

### 1.1 模块边界（渲染端）

| 文件 | 行数 | 与 `tabs.js` 的关系 |
|---|---|---|
| `src/renderer/tabs.js` | 2040 | **本文主角**：标签集合 + 唯一 `EditorView` + 大文件四档 + 文件监听 + 会话快照 + 状态栏 + 只读切换 |
| `src/renderer/app.js` | 1188 | 组装入口：给 `createEditor` 注入 9 个回调（`app.js:167-228`），持有 `persistSession`/`restoreSession`，`Ctrl+W/Tab` 键位，`window.__app` 暴露（`app.js:1184`） |
| `src/renderer/hugeview.js` | 896 | `kind='huge'` 的视图实现，被 `tabs.js:405` 创建、`tabs.js:1184-1192` 销毁；**自带 DOM 根节点**（`hugeview.js:48-50` 挂到 `#editor-host`） |
| `src/renderer/diffview.js` | 475 | `kind='diff'` 的渲染，写 `tab._model`（`diffview.js:182`、`:378`），`tabs.js:1047` 读 |
| `src/renderer/preview.js` | 488 | 经 `getEditor().getView()` 直接拿 CM 实例（`preview.js:412`）；`applyMode` 控制 `#editor-host` 显隐（`preview.js:353-384`） |
| `src/renderer/find.js` | 257 | 同 `preview.js`：`getView()` 硬绑唯一 CM（`find.js:24-26`），**无 `kind` 守卫** |
| `src/renderer/python.js` | 146 | 运行前经注入的 `onSave(tab)` 落盘（`python.js:106-107`）；真正的实现在 `app.js:238` `(tab) => editor.saveNow(tab)` |
| `src/main/filewatch.js` | 195 | `file-changed` / `file-shared-open` 的来源，`markSelfWrite` 自写识别 |

### 1.2 `tabs.js` 的**闭包级状态**（`createEditor` 内部，即"一个窗口一份"）

| 行号 | 名字 | 类型 | 生命周期 | 谁读写 | **归属** |
|---|---|---|---|---|---|
| `:106` | `tabs` | `Tab[]` | 随标签增删 | 几乎每个函数 | **文档级集合（现状是唯一容器）** |
| `:107` | `activeTab` | `Tab \| null` | 切换/关闭时改写（`:964`、`:1208`） | 全局 | **视图级（焦点视图的活动文档）** |
| `:108` | `idSeq` | `number` | 单调递增 | `openFile`/`openHugeTab`/`openViewerTab`/`openChunkedTab`/`openImageTab`/`openDiffTab` | **应用级**（ID 分配器） |
| `:109` | `wordWrapOn` | `boolean` | 设置变更 / `switchTab` 时刷新（`:984`） | `makeState`、`setWordWrap`、`switchTab` | **应用级**（全局设置镜像） |
| `:118` | `indentSize` | `number` | 同上（`clampIndent`） | `makeState`、`setIndentSize`、`switchTab` | **应用级** |
| `:119` | `composing` | `boolean` | IME 组合期间（`:263-264`） | `indentMore`/`indentLess` | **视图级（输入法状态）** |
| `:121-124` | `langCompartment` / `wrapCompartment` / `indentCompartment` / `readOnlyCompartment` | `Compartment` ×4 | 与闭包同生共死 | `makeState`（`:230-233`）、`switchTab`（`:986-992`）、`setViewerEditing`（`:690`、`:698`）、`setTabReadOnly`（`:1276`）、`setWordWrap`（`:1512`）、`setIndentSize`（`:1521`） | **视图级**（每个 `EditorView` 各需一套；见 §4.2-C4） |
| `:257` | `view` | `EditorView`（**全窗口唯一**） | 创建即终身 | 全局 | **视图级（当前是"唯一视图"）** |
| `:286`/`:287` | `imageHost` / `diffHost` | `HTMLElement` | 与闭包同生共死 | 图片标签、对比标签 | **视图级（DOM 宿主）** |
| `:288` | `IMAGE_EXTS` | `string[]` | 常量 | `openFile` | 应用级 |
| `:1388` | `tabBadges` | `Map<Tab, HTMLElement>` | `renderTabs` 重建时登记、`updateTabBadges` 清理失效项 | 标签徽标增量更新 | **视图级（标签栏 DOM 映射）** |
| `:1410` | `saveQueue` | `Promise` | 长期串行链 | `saveNow` | **应用级**（全局串行合并；多文档后仍是全局队列，见 §7-R9） |
| `:1755` | `imgSeq` | `number` | 单调递增 | `pasteImages` | 应用级 |
| `:1807` | `imgDrag` | `object \| null` | 拖拽期间 | 图片平移 | **视图级** |
| `:1974-1978`、`:2005` | `viewerBar` / `btnViewerJump` / `btnViewerEdit` / `btnViewerPrev` / `btnViewerNext` / `btnViewerExtract` | `HTMLElement` | 常量引用 | 查看器横幅 | **视图级（单例 DOM）** |
| 模块级 `:35` | `hugeScrollThreshold` | `number` | `setHugeThresholdMB` 可改（测试面） | `openFile` 分流 | 应用级 |
| 模块级 `:17/:18/:26/:29/:36/:37/:38` | `CHUNK_THRESHOLD` / `CHUNK_SIZE` / `VIEWER_THRESHOLD` / `HUGE_SCROLL_THRESHOLD` / `VIEWER_WINDOW` / `VIEWER_STEP` / `VIEWER_EDIT_MAX` | 常量 | 编译期 | `openFile` 分流与各档读写窗口 | 应用级 |
| 模块级 `:70-81` | `matchEffect` / `matchField` | `StateEffect` / `StateField` | 常量 | `find.js:4` 导入、`:52` dispatch | **视图级**（挂进每个 `EditorState`） |
| 模块级 `:91` | `lightTheme` | `Extension` | 常量 | `makeState` | 视图级 |

### 1.3 `tab` 对象字段（**Phase 1 的核心判据**）

**类型注释已过期**：`tabs.js:106` 仍写 `{ id, path, name, lang, state, dirty, saveTimer, savedContent, scrollTop }`，其中 **`savedContent` 全仓库只此一处出现（`grep` 命中数 = 1）**，是死字段名；实际字段远多于此。

| 字段 | 首次写入 | 类型 | 读方 | 归属 | 备注 |
|---|---|---|---|---|---|
| `id` | `:355`、`:379`、`:484`、`:756`、`:931`、`:1578` | number | 无外部读者（未核实是否有冒烟依赖） | 应用级 | 目前**没有任何地方读 `tab.id`**（`grep 'tab.id'` 未核实，见 §10-U1） |
| `path` | 同上 | string\|null | 全局（监听/会话/预览/树/查找） | **文档级** | `diff` 标签为 `null`（`:1579`）；`app.js:373` 在树重命名时**直接改写 `tab.path`** |
| `name` | 同上 | string | 状态栏/标签栏/预览判定 | **文档级（派生自 path）** | `app.js:374` 同步改写 |
| `lang` | 同上 | string | `makeState`、状态栏、运行按钮 | **文档级（派生自 path）** | |
| `kind` | `:383` / `:488` / `:760` / `:935` / `:1582` | `undefined \| 'image' \| 'diff' \| 'chunked' \| 'viewer-lg' \| 'huge'` | 全流程分流 | **文档级** | 0.5.0 §2 已锁定的三类语义见 §1.4 |
| `state` | `:365`、`:786`、`:1277`、`:854`、`:911`、`:915`、`:950`、`:994`、`:1277`、`:1513`、`:1522`、`:1950`、`:1961` | `EditorState \| null` | `switchTab`、`doSaveNow`、`getSession` 无关 | **视图级**（Phase 3 必须一视图一份；现状是"活动视图 = `view.state`、非活动视图 = 存的 state"） | `image`/`diff`/`huge` 恒为 `null`（`:936`、`:1591`、`:385`） |
| `dirty` | `:360`、`:762`、`:490`、`:387`、`:419`（huge 由 `onDirty` 回写） | boolean | 徽标/状态栏/保存/关闭确认 | **文档级** | huge 的权威脏值在主进程 overlay（`tabs.js:386` 注释、`:417-423`） |
| `saveTimer` | `:361`、`:763`、`:491`、`:938`、`:1593` | `Timeout \| null` | `app.js:176-177` 设置、`closeTab:1178` 清除 | **文档级** | 自动保存防抖句柄 |
| `pinned` | `:362`、`:764`、`:492`、`:939`、`:1594` | boolean | 标签栏、批量关闭、会话 | **视图级（标签栏位置概念）** | `setPinned`（`:1232`） |
| `crlf` | `:363`、`:785`、`:904`、`:1963` | boolean | `applyEol`（`:1425`） | **文档级** | 行尾风格 |
| `readOnly` | `:390`（huge=true）、`:993`/`:1274`（普通/viewer） | boolean | 状态栏、标签栏 🔒、保存 | **文档级（跨窗口共享语义）** | 与 `view.state.readOnly` **不等价**，见 §4.2-C5 |
| `chunk` | `:765`、`:902` | `{size,loaded,complete,inflight,loadPromise,decoder,encoding}` | 分段预读、保存、状态栏 | **文档级** | 红线：`stripChunkMarkers`（§7-R4） |
| `vwin` | `:495` | `{size,offset,byteLen,encoding,inflight,binary?,regionStart?}` | `viewer-lg` 全部逻辑 | **视图级（窗口级文档，不广播）** | 0.5.0 §2 表已锁定 |
| `editing` | `:493` | boolean | `viewer-lg` 区域编辑 | 视图级 | `:679` `activeTab !== tab` 直接拒绝 |
| `huge` / `hugeEl` | `:389`/`:427` | `HugeView \| null` / `HTMLElement \| null` | `mountHuge`/`closeTab`/`doSaveNow` | **视图级（DOM 与实例）** | 见 §4.1 |
| `hugeSize` | `:384` | number | `mountHuge` | 文档级 | |
| `hugeStatus` / `hugeDirtyCount` | `:409` / `:419` | string / number | 状态栏 | 视图级 | |
| `hugeTopLine` / `hugeHidden` | `:446-447` | number / boolean | `setHugeVisible` | **视图级（滚动位置）** | |
| `scrollTop` | `:953`/`:956`/`:960`（离开时记）、`:1595`（diff 初始化） | number | `restoreTabScroll`（`:1013-1027`） | **视图级（滚动位置）** | huge 不走这里（`:1017`） |
| `previewScrollTop` | `app.js:189` | number | `app.js:207` | **视图级（预览区滚动，写在 app.js 不在 tabs.js）** | Phase 1 refactor 时**不要**把它收进 docmodel |
| `lastSavedAt` | `:494`、`:718`、`:1480`、`:1442` | number | `:1835` 自写回声守卫 1200ms | 文档级 | huge 另有 3s 窗口（`:1843`，读的是 `huge.getState().savedAt`） |
| `lastSyncAt` / `syncTimer` | `:1895` / `:1891` | number / Timeout | 只读观察窗 800ms 节流（`:1888-1898`） | 文档级（跨窗口同步节流） | |
| `_model` | `diffview.js:182`/`:378` | object | `tabs.js:1047` 状态栏 | 视图级（diff 专用） | |
| `diffKey`/`leftContent`/`rightContent`/`midContent`/`leftLabel`/`rightLabel`/`midLabel`/`three`/`exportDir` | `:1580-1590` | — | `renderDiff`/导出 | 视图级（diff 专用） | |

### 1.4 `kind` 三类语义（0.5.0 §2 已锁定，本文核对为**现状属实**）

| 类别 | `kind` | 内容是否跨视图广播 | 证据 |
|---|---|---|---|
| 文档级 | `undefined`（普通文本）、`'chunked'`、`'image'` | **广播** | 普通标签 `:354-364`；分段 `:754-766`；图片 `:930-940` |
| 窗口级 | `'viewer-lg'` | **不广播**（各视图各看各的字节窗口） | `vwin.offset` 是每个标签自己的窗口（`:495`、`:520-604`） |
| 窗口级（新） | `'huge'` | 视口行不广播；**但 overlay 脏状态与保存是文档级** | overlay 是**路径单例**（`0.4.0 §6.2`：`src/main/overlay.js` 自身无 path→doc 表，单例语义由 `src/main/overlay-ipc.js` 提供） |

### 1.5 DOM 宿主（Phase 1 **不改**，但必须知道谁是谁）

`src/renderer/index.html:78-104`：

```
#workbench
├─ #tabs                      (:79)   标签栏（renderTabs 全量重建，:1330）
└─ #editor-wrap               (:80)
   ├─ #editor-host            (:81)   ★ 唯一 CM 的父节点（tabs.js:102）；hugeview 根节点也挂这里（hugeview.js:50）
   ├─ #image-host             (:82)
   ├─ #diff-host              (:84)
   ├─ #viewer-bar             (:86-93) 查看器横幅（分段/大文件标签显示，preview.js:379）
   ├─ #split-divider          (:94)
   ├─ #preview-host           (:95)
   └─ #editor-empty           (:99)
```

样式红线：`src/renderer/styles.css:1572` `#editor-host.huge-active > .cm-editor { display: none !important; }`（让位规则本体，`:1566-1571` 是成因注释）。

---

## 2. `activeTab` 引用**全量分类表**

### 2.1 计数口径与命令（原始输出）

```powershell
# 精确（区分大小写）计数
$all = [System.IO.File]::ReadAllLines((Resolve-Path 'src\renderer\tabs.js').Path)
$hits = 0; $lines = 0
for ($i=0; $i -lt $all.Count; $i++) { $c = ([regex]::Matches($all[$i],'activeTab')).Count; if ($c -gt 0) { $hits += $c; $lines++ } }
"activeTab total occurrences = $hits"   # → 83
"activeTab matching lines     = $lines" # → 67
```

```
activeTab total occurrences = 83
activeTab matching lines     = 67
tabs.find occurrences        = 6
--- Select-String cross-check (matching lines) ---
85                      ← 大小写不敏感，多出 getActiveTab() 的 2 处（:1635、:2029）
in comment lines = 0 ; in code lines = 83
```

> **差异说明**：0.5.0 计划记的 84 与实测 83 差 1。既然该计划未给逐处枚举，无法唯一归因；最可能是写作后又增删过一处（例如 huge 分支重构时合并了 `activeTab` 判断）。**以 83 为准**。另：**没有任何一处 `activeTab` 出现在注释行**，"83 处"与"83 处代码"是同一个数。

### 2.2 按用途分类（**每一类都列全行号**，共 83 处）

| # | 用途类 | 处数 | 行号（`tabs.js`） | 双栏下的语义变化 |
|---|---|---|---|---|
| A | **声明与赋值** | 3 | `:107` 声明；`:964` `= tab`；`:1208` `= null` | 「全局唯一 activeTab」→「**每个 pane 一个 activeTab**」。`:1208` 的"关完变 null"要变成"**该 pane** 关完变 null"，`:1210-1214` 的空态 UI 也按 pane |
| B | **CM updateListener 归属判定**（每次事务） | 6 | `:239`、`:241`、`:242`、`:245`、`:251`(×2) | **最危险的一类**。现在回调闭包直接写 `activeTab.state/dirty`。多视图后必须改成"**由派发该事务的视图自己**（`u.view`）回写自己的文档"，否则 B 栏打字会标脏 A 栏（§4.2-C1） |
| C | **滚动预读/翻页触发** | 5 | `:279`、`:280`(×2)、`:281`(×2) | `view.scrollDOM` 的 scroll 监听 → 每 pane 一份；`activeTab.kind` 判定要变成"**该 pane 的活动文档**的 kind" |
| D | **huge 脏标记回调** | 1 | `:421` | `onDirty` 回写后只在"该视图仍活动"时刷状态栏 → 多视图下要改成"**任一面板活动**即刷"或按 pane 刷 |
| E | **`viewer-lg` 区域查看/编辑** | 16 | `:585`、`:597`、`:616`、`:626`、`:668`、`:679`、`:1275`、`:1981`、`:1993`、`:1999`(×3)、`:2002`(×3)、`:2008` | 「只有活动标签能翻页/进编辑」是**窗口级语义**，多栏后应改为「**该标签所属 pane 的活动文档**」；`setViewerEditing` 的 `activeTab !== tab` 硬拒绝（`:679`）在多栏下必须放宽到"该 pane 活动"，否则右栏永远进不了区域编辑 |
| F | **`chunked` 分段追加** | 3 | `:841`、`:872`、`:906` | `isActive = activeTab === tab`（`:841`）决定"用 `view.state` dispatch 还是 `tab.state.update`"。多视图后**同一文档可能有 2 个视图**，这个二选一直接失效 → 必须变成"**对每个视图各派发一次**"（Phase 3 核心改动，Phase 1 先把它收敛成 `isActiveIn(doc, pane)`） |
| G | **标签切换与滚动恢复** | 5 | `:950`(×2)、`:951`、`:1021`、`:1032` | 离开时的滚动记忆（`:950-961`）→ 每 pane 独立；`cycleTab`（`:1030-1035`）→「**栏内循环**」（0.5.0 G6 已锁定 `Ctrl+Tab` 栏内循环） |
| H | **状态栏** | 20 | `:1043`(×3)、`:1044`(×2)、`:1045`(×2)、`:1047`、`:1050`(×2)、`:1055`、`:1056`(×2)、`:1057`、`:1069`、`:1070`、`:1071`、`:1073`、`:1081`、`:1082` | 状态栏是**全局单例**。双栏后要么"显示**焦点栏**的文档"（推荐，Phase 2 最小改动），要么双份。Phase 1 只需保证 `updateStatusBar()` 语义不变 |
| I | **标签栏渲染/徽标/空态** | 3 | `:1333`、`:1395`、`:1403` | 每栏各自标签栏 → `el.classList.toggle('active', …)` 的判据变成"**该 pane 的 activeDoc**"（Phase 2 改；Phase 1 不动 DOM） |
| J | **设置热更新与保存入口** | 6 | `:1430`（`doSaveNow` 缺省参数）、`:1511`、`:1513`、`:1520`(×2)、`:1522` | `doSaveNow(tab)` 的 `tab || activeTab` 缺省（`:1430`）在双栏下含义退化 → Phase 1 保留；**调用方现状**：`app.js:177`、`app.js:221`、`app.js:238` 都显式传了 tab，**只有 `app.js:1062` 的 `editor.saveNow()` 无参**，需要 Phase 2 定义"哪个栏" |
| K | **滚动到底/顶部按钮** | 3 | `:1528`、`:1545`、`:1556` | 同 H：取**焦点栏** |
| L | **会话快照** | 2 | `:1636`（`getActiveTab` 返回）、`:1644`（`persist.indexOf(activeTab)`） | 单栏 `{paths, active, pinned}` → Phase 3 `layout.panes[].active`；Phase 1 **格式不许变**（§7-R7） |
| M | **事件绑定（粘贴 / 右键 / 图片粘贴）** | 4 | `:1720`、`:1733`(×2)、`:1758` | `view.dom` 上的 paste/contextmenu 监听 → 每 pane 一份；`pasteImages` 的 `const tab = activeTab`（`:1758`）要变成"**发起粘贴的那个视图**所属文档" |
| N | **外部修改重载** | 5 | `:1924`、`:1939`、`:1940`、`:1941`、`:1965` | "活动标签用 dispatch、非活动标签重建 state" 的二选一（`:1939-1962`）同样被多视图打破 → 必须**按文档的全部视图逐个应用**（0.5.0 §2.3 已定调；`:1830` 的 `tabs.find` 只找第一个，**多视图下必然漏**） |
| O | **关闭标签** | 1 | `:1204` | `if (activeTab === tab)` 决定"关的是活动标签 → 切到邻居"（`:1204-1215`）→ 按 pane 判定；「关最后一个视图才走未保存确认」（G3）在 Phase 3 |

**校验**：3+6+5+1+16+3+5+20+3+6+3+2+4+5+1 = **83** ✅

### 2.3 `tabs.find` 6 处（0.5.0 §3 Phase 3 明确要全改成"全部视图"）

| 行号 | 代码 | 用途 | 多视图下 |
|---|---|---|---|
| `:293` | `tabs.find((t) => t.path === path)` | `openFile` 去重 | **Phase 3 要变语义**：同文件在**另一栏**已开 → 是"激活另一栏的视图"还是"本栏新开一个视图"？（0.5.0 §2.7 定：默认激活已有视图，`opts.forceNew` 才新开）。**Phase 1 保持现状** |
| `:925` | 同上 | `openImageTab` 去重 | 同 `:293` |
| `:1568` | `t.kind === 'diff' && t.diffKey === key` | 对比标签去重 | 对比标签是窗口级临时视图 → 保持全局唯一 |
| `:1654` | `activateByPath` | 会话恢复 | **当前外部零调用**（§3 死导出） |
| `:1688` | `findTabByPath` | 外部高频（app.js 6 处 + smoke 40 处） | Phase 1 **必须保持"返回第一个匹配 tab"**，否则冒烟大面积挂 |
| `:1830` | `file-changed` 过滤（含 4 个 kind 白名单） | 外部修改路由 | **Phase 3 必须改成"该 path 的全部视图"**（0.5.0 §2.3 已点名） |

---

## 3. 公开 API 清单（33 个）

### 3.1 清单（签名 / 外部调用方 / 冒烟是否用 / Phase 1 处置）

**外部调用方统计口径**：正则 `(editor|__app\.editor)\.<API>\b`，扫描 `src/**/*.js`（排除 `dist/`）与 `scripts/*.js`（排除 `tabs.js` 自身）。`smoke.js` 行号会随另一 agent 的改动漂移，**以数量级为准**。

| # | API | 签名 | 定义 | 外部调用点数 | 主要调用方 | 冒烟用途 | Phase 1 |
|---|---|---|---|---|---|---|---|
| 1 | `openFile` | `(path, opts={silent?})` | `:292` | **117** | app.js 7、smoke.js 108、ext-test/mm-test 各 1 | **最高频入口**（冒烟几乎每个用例的第一步） | **签名不变** |
| 2 | `openDiffTab` | `(opts)` | `:1566` | 9 | app.js 3、smoke 6 | `diff*` 系列 6 项 | 不变 |
| 3 | `closeTab` | `(tab, opts={save?})` | `:1177` | 15 | app.js 2、smoke 13 | 关标签/批量/pin 系列 | 不变 |
| 4 | `closeAll` | `()` | `:1222` | **50** | 仅 smoke（含每次清理） | `sessionClean` 等 | 不变 |
| 5 | `saveNow` | `(tab?)` | `:1414` | 11（+1 间接） | app.js 4、smoke 5、python.js **间接**（`python.js:106-107` 调注入的 `onSave`，实现在 `app.js:238`）、`python.js:4`/`:104` 是注释引用 | 保存/自动保存/分段 | 不变（无参语义待 Phase 2 定义） |
| 6 | `setWordWrap` | `(on)` | `:1509` | 2 | app.js 2 | — | 不变 |
| 7 | `setIndentSize` | `(n)` | `:1518` | 6 | app.js 2、smoke 4 | `indent*` | 不变 |
| 8 | `getActiveTab` | `()` | `:1635` | 24 | app.js 3、smoke 21 | **大量**（几乎所有断言） | **返回焦点 pane 的 activeDoc（Phase 1 = 现状）** |
| 9 | `getView` | `()` | `:1662` | **41** | find.js 1、preview.js 1、smoke 40、ext-test 1 | **大量**；40 处里 36 处直接用 `view.state`/`view.dispatch`/`view.scrollDOM` | **必须继续返回焦点 pane 的 `EditorView`**（0.5.0 §2 开工动作 3） |
| 10 | `renderTabs` | `()` | `:1328` | 2 | app.js 2 | — | 不变 |
| 11 | `jumpToLine` | `(tab, line)` | `:1667` | 2 | app.js 2 | — | 不变 |
| 12 | `findTabByPath` | `(p)` | `:1687` | **46** | app.js 6、smoke 40 | **大量**（pin/diff/关闭断言） | **语义不变**（返回第一个） |
| 13 | `closeByPath` | `(p, isDir, opts)` | `:1708` | 5 | app.js 2、smoke 3 | 删除/移走场景 | 不变 |
| 14 | `cycleTab` | `(dir)` | `:1030` | 1 | app.js 1（`Ctrl+Tab`） | — | 不变（Phase 2 改"栏内循环"） |
| 15 | `getSession` | `()` | `:1640` | 8 | app.js 5、smoke 3 | `sessionRestore`/`stressSession`/`diffSessionExcluded` | **返回结构不允许变**（§7-R7） |
| 16 | `activateByPath` | `(path)` | `:1653` | **0** | — | — | **死导出**，Phase 1 保留签名但可加注释 |
| 17 | `togglePinned` | `(tab)` | `:1227` | **0**（仅 `tabs.js` 内部 `:1242`/`:1347` 调） | — | — | 死导出（内部仍在用） |
| 18 | `setPinned` | `(tab, v)` | `:1232` | 9 | app.js 1、smoke 8 | `pin*` 系列 | 不变 |
| 19 | `closeOthers` | `(anchor)` | `:1290` | 1 | smoke 1 | `closeOthers` | 不变 |
| 20 | `closeLeft` | `(anchor)` | `:1302` | 2 | smoke 2 | 批量关闭 | 不变 |
| 21 | `closeRight` | `(anchor)` | `:1315` | 1 | smoke 1 | 批量关闭 | 不变 |
| 22 | `reorderTabs` | `(orderPaths)` | `:1694` | 1 | app.js 1（`:309`） | 会话顺序 | 不变 |
| 23 | `scrollToTop` | `()` | `:1527` | 1 | app.js 1 | — | 不变 |
| 24 | `scrollToBottom` | `()` | `:1544` | 2 | app.js 1、smoke 1 | 分段到底 | 不变 |
| 25 | `viewerJump` | `(tab, input)` | `:638` | 1 | smoke 1 | `viewer*` | 不变 |
| 26 | `setViewerEditing` | `(tab, on)` | `:678` | 5 | smoke 5 | `viewerEdit*` | 不变 |
| 27 | `revealViewerAt` | `(tab, byteOffset)` | `:746` | 1 | app.js 1（`:570`） | — | 不变 |
| 28 | `slideViewerWindow` | `(tab, dir)`（映射到内部 `slideViewer`） | `:607` / 导出 `:2029` | 1 | smoke 1 | `viewer*` | **名字与内部名不同**（`slideViewerWindow: slideViewer`），改内部名时别把导出键改了 |
| 29 | `setTabReadOnly` | `(tab, v)` | `:1268` | 1 | app.js 1（`:1133` 跨窗口共享） | 间接 | 不变（跨窗口只读语义见 §7-R8） |
| 30 | `toggleReadOnly` | `(tab)` | `:1263` | **0**（仅 `:1245` 标签右键调） | — | — | 死导出 |
| 31 | `ensureFullyLoaded` | `(tab)` | `:880` | 1 | smoke 1（`:2519`） | 分段保存前补齐 | 不变 |
| 32 | `setHugeThresholdMB` | `(mb)` → MB | `:2034` | 6 | 仅 smoke | `hugeEdit*` 3 项 + 边界用例 | **测试面，签名与返回值不许变**（`:2030-2033` 注释明确要求 set→断言→恢复 1024） |
| 33 | `getHugeThresholdMB` | `()` → MB | `:2039` | **0** | — | — | 死导出（保留） |

**计数命令与原始输出**：

```powershell
$line = $all[2028]   # tabs.js:2029
$inner = $line.Substring($line.IndexOf('return {') + 8).TrimEnd().TrimEnd(',')
$keys = ($inner -split ',') | ForEach-Object { ($_ -split ':')[0].Trim() } | Where-Object { $_ -ne '' }
"shorthand keys = " + $keys.Count          # → 31
"total incl 2 test-surface = " + ($keys.Count + 2)   # → 33
```

```
shorthand keys = 31
total incl 2 test-surface = 33
```

> **与「36 个」的差异**：0.5.0 §2/§8 只写数字、未给枚举，无法逐项对齐。实测返回对象（`tabs.js:2029` 的 31 个简写键 + `:2034` `setHugeThresholdMB` + `:2039` `getHugeThresholdMB`）就是 **33**。另注：0.3.0 §2.7 兼容层表里点名的 **`applySnippet` 在当前代码里完全不存在**（全仓库 `grep 'applySnippet'` 命中 0），该表已过期。**以 33 为准。**

### 3.2 Phase 1「必须保持签名不变」的收敛结论

- **全部 33 个键都必须保留**（包括 4 个死导出：`activateByPath`/`togglePinned`/`toggleReadOnly`/`getHugeThresholdMB` + 内部仍在用的 `togglePinned`）。理由：`window.__app.editor` 是 dev 测试面（`app.js:1184`），删键的收益为 0、破坏面不可枚举。
- **重点保护 5 个**（冒烟调用点 ≥ 40）：`openFile`(117)、`closeAll`(50)、`findTabByPath`(46)、`getView`(41)、`getActiveTab`(24)。
- **Phase 2/3 才改语义的 3 个**：`getActiveTab`（→ 焦点 pane）、`getView`（→ 焦点 pane 的 view）、`getSession`（→ 追加 `layout`）。

### 3.3 **冒烟对 `tab` 对象形状的隐式依赖**（Phase 1 不能改字段名）

`scripts/smoke.js` 直接读 `tab.*`（非 API）的位置（节选，均实测）：

| 冒烟行 | 读的字段 |
|---|---|
| `2453`、`2486`、`2531`、`3021` | `tab.kind === 'chunked'` |
| `2848-2849` | `tab.kind === 'huge'`、`tab.huge` |
| `2866`、`2904`、`2929` | `tab.kind === 'viewer-lg'` |
| `2869`、`2875`、`2882` | `tab.vwin.size` / `.offset` |
| `2970`、`2974`、`2982`、`2984` | `tab.huge.getState()` / `tab.huge.scrollToPercent(90)` |
| `983`、`996` | `tab.name` |
| `2328-2329` | `findTabByPath(p).pinned` |

> **含义**：Phase 1 若把 `tab` 换成 `Document` 对象，**必须保证这些字段仍在返回对象上同名可读**（或同步改冒烟——但本阶段不允许改 `scripts/smoke.js`）。**最稳的 Phase 1 做法：`Document` 就是原 `tab` 对象的**同一个引用**（`doc === tab`），只把"全局 activeTab"换成"registry 的 activeDoc 指针"，不做对象搬家。**

---

## 4. CodeMirror ×「一个文件多视图」的冲突点

### 4.1 单例清单（现状：一窗口一个 CM + 一窗口一个 huge 视图层）

| # | 单例 | 位置 | 说明 |
|---|---|---|---|
| S1 | `const view = new EditorView({...})` | `tabs.js:257-260` | 全渲染端**唯一** CM 实例（`grep 'new EditorView'` 在 `src/renderer/*.js` 只命中这一处） |
| S2 | `makeState(doc, lang, readOnly, wrap)` | `tabs.js:221-255` | 每次 `switchTab` 重建 `EditorState`；`:239-252` 的 `updateListener` **闭包捕获 `activeTab`** |
| S3 | 4 个 `Compartment` | `tabs.js:121-124` | 与 S1 一一对应；`readOnlyCompartment` 是「viewer-lg 只读↔区域编辑」的开关（`:690`/`:698`） |
| S4 | `view.scrollDOM` 的 scroll 监听 | `tabs.js:276-284` | 只服务"当前活动标签"的分段预读/查看器翻页 |
| S5 | `view.dom` 的 paste / contextmenu 监听 | `tabs.js:1718-1728`（paste）、`:1731-1749`（contextmenu） | 守卫都是 `activeTab`（`:1720`、`:1733`） |
| S6 | `#editor-host` 本身 | `tabs.js:102`、`index.html:81` | CM 与 hugeview 根节点的**共同父节点** |
| S7 | `#image-host` / `#diff-host` / `#viewer-bar` | `tabs.js:286-287`、`index.html:82/84/86` | 图片/对比/查看器横幅各一份 |
| S8 | `saveQueue` | `tabs.js:1410` | 全局串行保存链 |
| S9 | `tabBadges` | `tabs.js:1388` | 标签元素映射（一栏一份） |
| S10 | `viewerBar` 按钮监听 | `tabs.js:1979-2027` | 点击时取 `activeTab` 判 kind |

### 4.2 逐项冲突（**同一文件两个视图**下会出问题的具体位置）

| # | 位置 | 现状代码 | 多视图下的具体故障 |
|---|---|---|---|
| **C1** | `tabs.js:238-252` | `EditorView.updateListener.of((u) => { if (u.docChanged && activeTab) { activeTab.state = u.state; activeTab.dirty = true; … onDocChanged(activeTab); } })` | **最致命**。`updateListener` 闭包里的 `activeTab` 是**全局**的。B 栏的 `dispatch` 若在 A 栏为 activeTab 时同步触发，会把 B 的文档内容写到 A 的 `tab.state` → **A 的文件被 B 的内容覆盖**；反向亦然。Phase 3 必须改成 `u.view` 反查所属视图（或每视图独立 listener 闭包） |
| **C2** | `tabs.js:982` `view.setState(tab.state)` / `:994` `tab.state = view.state` | 切标签时把 state **搬进/搬出**唯一 view | `EditorState` 里含**选区/折叠/滚动锚**。多视图共享同一个 `EditorState` 会导致**两栏光标同步**（0.3.0 §2.3 已判死刑）；反过来"切标签才 setState"的搬运模式在"两个视图同时活着"时不成立 —— 两个视图必须**同时各自持有一份 state**，不能再靠 `setState` 搬运 |
| **C3** | `tabs.js:241` `activeTab.state = u.state` | 每次事务后把 `view.state` 拷回 tab | 与 C1 同源。多视图后这行必须变成"**只有派发者自己的视图**才回写"，且要区分 `remoteAnnotation`（广播来的变更不回播，防环） |
| **C4** | `tabs.js:986`、`:988`、`:992`、`:690`、`:698`、`:1276`、`:1512`、`:1521` | 对**唯一 view** `dispatch({effects: compartment.reconfigure(...)})` | 换行/缩进/只读是**每视图**的（`EditorState` 的一部分）。多视图后"改换行设置"必须对**每个视图**各 reconfigure 一次，否则另一个视图的设置与实际不符。注意 `Compartment` 实例本身可以复用（CM6 允许同一 Compartment 出现在多个 state 中），但**reconfigure 必须逐 view 派发** |
| **C5** | `tabs.js:991-993`、`:1274-1278` | `tab.readOnly`（文档级）↔ `view.state.readOnly`（视图级）同步 | `readOnly` 现在是**文档级**字段（跨窗口共享文件自动只读，`app.js:1133`），却靠"改唯一 view 的 compartment"落地。多视图后：**只读是文档级决定 → 必须对每个视图生效**；而 `viewer-lg` 的 `tab.editing` 是**窗口级** → 同文件两个 `viewer-lg` 视图的只读态**可以不同**（各看各的字节窗口）。这两条语义混在 `:991-993` 一行三目里，**Phase 1 应把它拆成显式函数并写注释**，否则 Phase 3 必踩 |
| **C6** | `tabs.js:1432-1457` | `doSaveNow` 的 `huge` 分支：`tab.state` 是空文档，**绝不能走整篇写盘**（`:1435` 注释：「一旦写盘会把 GB 级文件截成 0 字节」） | 多视图下若 `Document` 与 `tab` 解耦，**这里是最容易出人命的红线**：新模型必须有"**huge 的正文真源在 overlay，不在 `doc.state`**"的硬编码守卫 |
| **C7** | `tabs.js:1472`、`:1499` | `stripChunkMarkers(...)` 只在保存路径调用 | 多视图 + 分段：`appendChunkText`（`:839-867`）现在"只对活动视图 dispatch，非活动重建 state"。两个视图同时持同一分段文档 → **占位标记会被追加两次**的风险（每次追加都先删旧标记再追加，`Re` 全量扫描，但两条追加链交错会乱序）。0.5.0 §2.3 已定：**追加逻辑上移到 Document，对所有视图广播** |
| **C8** | `tabs.js:1459-1461`、`:706-728` | `viewer-lg` 保存按 `vwin.regionStart/byteLen` 写回 | 两个 `viewer-lg` 视图看同一文件的不同窗口 → **区域编辑必须窗口级串行**（否则两次 splice 会互相错位）。现状靠 `activeTab` 唯一性天然串行（`:679` 硬拒绝非活动标签），多视图后这条隐式保护消失 |
| **C9** | `tabs.js:1939-1962` | `reloadFromDisk`：活动标签 `dispatch` 整文替换、非活动标签 `makeState` 重建 | 二选一在多视图下漏掉"另一个视图"，导致**两栏内容不一致**（外部修改只进了一栏） |
| **C10** | `find.js:24-26`、`preview.js:412` | `getEditor().getView()` 硬取唯一 CM | 多视图下必须明确"查找/预览跟随**焦点栏**"（Phase 2 起）；huge 焦点时 CM 是空文档（`tabs.js:975`），`find.js` **无 kind 守卫** → 现状 `Ctrl+F` 在大文件视图静默 0 命中（0.5.0 §6 待决项 1） |
| **C11** | `tabs.js:1021`、`:1556`、`:618`、`:670` | 多帧 `requestAnimationFrame` 滚动校正，守卫都是 `activeTab !== tab` | 多视图后"该视图是否仍应被校正"的判据从"是否活动"变成"**是否仍挂载在该 pane 上**"，否则切换标签时的校正循环会在错误视图上执行 |
| **C12** | `tabs.js:276-284` + `:278-282` | `view.scrollDOM` scroll → `maybeAutoLoad(activeTab)` / `maybeSlideViewer(activeTab)` | 一栏滚动会驱动"全局活动标签"的预读。多视图后必须是"**这个 view 自己的文档**" |

### 4.3 `huge` 与 CM 的「让位」链路（现状，**Phase 1 不许动**；Phase 2 必须按 pane 重算）

```
switchTab(tab)                                    tabs.js:947
  ├─ syncEditorLayer(tab)                         :967 → 定义 :466-478
  │    ├─ isHuge → view.dom.style.display='none'  :472   （内联只是兜底，真正生效的是样式表）
  │    ├─ host.classList.toggle('huge-active',…)  :474
  │    └─ for (const t of tabs) if (t.kind==='huge') setHugeVisible(t, isHuge && t===tab)  :475-477
  │         └─ setHugeVisible(tab, visible)       :443-457
  │              ├─ 隐藏：hugeTopLine = hugeTopLine(tab) ; hugeEl.style.display='none'  :446-448
  │              └─ 显示：display='' ; 若曾隐藏 → gotoLine(hugeTopLine)  :451-456
  ├─ image  → view.setState(makeState('','text')) ; renderImageTab   :970-971
  ├─ huge   → view.setState(makeState('','text')) ; mountHuge(tab)   :975-976
  ├─ diff   → view.setState(makeState('','text')) ; renderDiff(tab)  :979-980
  └─ 其它   → view.setState(tab.state) + 三个 compartment reconfigure + requestMeasure  :982-996
```

配套 CSS：`styles.css:1572` `#editor-host.huge-active > .cm-editor { display: none !important; }`（成因见 `:1566-1571`：两者都是 `height:100%` 的流内同级子元素，同时可见 = 总高 200%）。

**多栏下的问题（Phase 2 必修，Phase 1 只记录）**：
1. `view.dom.style.display = 'none'`（`:472`）是**全局单例 CM** 的显隐。左栏开 huge 会把**右栏的 CM 也隐藏**。
2. `host.classList.toggle('huge-active')`（`:474`）是**整个 `#editor-host` 一个类**。双栏后每栏一个宿主，类必须按 pane 加。
3. `mountHuge` 把 `.huge-view` 根节点 append 到 `#editor-host`（`hugeview.js:50`），并用"新增子节点"diff 出 `tab.hugeEl`（`tabs.js:404`、`:427`）。**同一个 `#editor-host` 里挂两个 pane 的 huge 根节点，diff 逻辑会串**。
4. `hugeview.js:826` `ro.observe(host)`（ResizeObserver 观察宿主）→ 宿主若变成 pane 内层容器，观察目标要跟着换。
5. `syncEditorLayer` 遍历**全局 `tabs`** 隐藏所有非活动 huge 视图（`:475-477`）→ 多栏下必须改成"**只隐藏本 pane 非活动的**"，否则左栏切标签会把右栏正在看的 huge 视图一起 `display:none`。

---

## 5. 建议的 `docmodel.js` 接口草案

### 5.1 边界（谁持有什么）—— **这一节是 Phase 1 的验收核心**

| 关注点 | 现状持有者 | Phase 1 之后 | 理由 / 证据 |
|---|---|---|---|
| **文本内容** | `tab.state`（`EditorState`） | **不变**：`Document.state` 就是 `tab.state`（同一引用） | 换容器 = 行为不中性。Phase 1 只换"**谁被称作活动**" |
| **光标 / 选区 / 折叠** | `EditorState` 内部 | **视图级**：Phase 1 仍是"活动视图 = `view.state`" | `view.setState(tab.state)`（`:982`） |
| **滚动位置** | `tab.scrollTop`（`:953-960`） | **视图级**：留在 `tab` 上（字段名不变） | `restoreTabScroll`（`:1013-1027`） |
| **脏标记** | `tab.dirty`（文档级） | **文档级**，由 registry 提供 `markDirty(doc, v)` | huge 的权威脏值在主进程 overlay（`tabs.js:386`、`hugeview.js:452`） |
| **写盘** | `saveQueue`(全局) → `doSaveNow`(`:1429`) | **仍在 `tabs.js`**；registry 只暴露 `listDirty()`/`docOf(path)` | 写盘牵涉分段补齐（`:1462-1471`）、huge overlay（`:1432`）、viewer 区域写（`:1459`）——**Phase 1 一行都不动** |
| **文件监听** | `window.api.watchFile/unwatchFile` 直接在 `openFile:368`/`openChunkedTab:792`/`openHugeTab:395`/`closeTab:1203` 调用 | **仍在 `tabs.js`**；registry 记录 `doc.watching` 供断言 | watch 是路径级 + 窗口级（`filewatch.js:9`），与"文档"不是一一对应（huge 与 viewer 都注册了） |
| **会话快照** | `getSession()`（`:1640-1650`） | **仍在 `tabs.js`**，registry 只提供 `allDocs()` | 格式锁定（§7-R7） |
| **DOM** | `tabs.js` + `hugeview.js` + `diffview.js` | **不进 registry** | 见 §5.3 |

### 5.2 接口草案（**Phase 1 最小面**；Phase 3 才扩广播）

```js
// src/renderer/docmodel.js —— Phase 1 只做「注册表 + 活动指针」，不做广播
// 设计约束：doc === 原 tab 对象（同一引用），字段名一律不改（冒烟直读 tab.*，见 §3.3）

/** @typedef {{id:number,path:string|null,name:string,lang:string,kind?:string,state:object|null,
 *   dirty:boolean,scrollTop?:number,pinned:boolean}} Doc */

export function createDocRegistry() {
  /** @type {Doc[]} */ const docs = [];        // 顺序 = 标签栏顺序（替代原 tabs[]）
  let activeDoc = null;                        // 替代原 activeTab（Phase 1 只有 1 个 pane）

  return {
    // ---- 集合（对应原 tabs[] 的全部 6 个 tabs.find 使用点，见 §2.3）----
    list: () => docs,                          // 只读视图；调用方不得原地 sort（reorderTabs 走 replaceAll）
    byPath: (p) => docs.find((d) => d.path === p) || null,       // ≡ findTabByPath :1687
    byDiffKey: (k) => docs.find((d) => d.kind === 'diff' && d.diffKey === k) || null, // ≡ :1568
    add: (doc) => { docs.push(doc); return doc; },               // 替代 6 处 tabs.push
    remove: (doc) => { const i = docs.indexOf(doc); if (i >= 0) docs.splice(i, 1); return i; }, // ≡ :1200-1202
    replaceAll: (arr) => { docs.length = 0; docs.push(...arr); },// ≡ reorderTabs :1697-1701
    count: () => docs.length,

    // ---- 活动指针（Phase 1：全局唯一；Phase 2：按 paneId）----
    active: () => activeDoc,                                     // ≡ getActiveTab :1635
    setActive: (doc) => { activeDoc = doc || null; return activeDoc; }, // ≡ :964 / :1208
    isActive: (doc) => doc != null && doc === activeDoc,         // 收敛 :585/:597/:616/:626/…

    // ---- 文档级标记（不碰 DOM、不碰 CM）----
    markDirty: (doc, v) => { doc.dirty = v === true; },          // ≡ :242 / :860 / :1479 …
    isDirty: (doc) => !!doc && doc.dirty === true,
    listDirty: () => docs.filter((d) => d.dirty),

    // ---- 只有 Phase 3 才会长出真身的部分：Phase 1 先留空壳并抛错，禁止被调用 ----
    // applyLocal(doc, tr, viewId)   → Phase 3：写 doc.version 并广播
    // applyRemote(doc, changes, fromViewId) → Phase 3：带 remoteAnnotation 派发，不回播
    // views(doc) → Phase 3：doc 的全部视图（Phase 1 恒为 0/1 个）
    // serialize(doc) → Phase 3：layout 快照
  };
}

/** Phase 1 的另一半：把"活动视图"从 docmodel 里隔离出去。
 *  这是 tabs.js 内部函数，不导出：
 *  - activeViewOf(doc)  → doc === registry.active() ? view : null
 *  - forEachViewOf(doc, fn) → Phase 1 恒为「至多调用一次 fn(view)」
 */
```

### 5.3 **不能**放进 `docmodel.js` 的状态（硬清单）

| 不能进的状态 | 位置 | 为什么 |
|---|---|---|
| `EditorView` 实例 | `tabs.js:257` | 是与 DOM 强绑定的对象（`parent: host`）；一个视图一份，registry 的键是**文档**不是视图 |
| `#editor-host` / `#image-host` / `#diff-host` / `#viewer-bar` 等 DOM 引用 | `tabs.js:102`、`:286`、`:287`、`:1974-1978`、`:2005` | Phase 2 要按 pane 复制这些宿主；registry 一旦持有就锁死了"单例 DOM"假设 |
| `hugeview.js` 的 DOM 与实例（`tab.huge` / `tab.hugeEl`） | `tabs.js:389`、`:427`；`hugeview.js:48-50` | `.huge-view` 根节点由 `createHugeView` append 到宿主（`hugeview.js:50`），`destroy()` 里 `root.remove()`（`hugeview.js:893`）。**DOM 生命周期归视图**；overlay 文档（路径单例）才是文档级 |
| `Compartment` 实例 | `tabs.js:121-124` | 它们被 `EditorState` 持有（`:230-233`）；多视图后要逐 view 派发（§4.2-C4） |
| `saveQueue` | `tabs.js:1410` | 是**应用级**串行链，跨文档共享；放进文档级 registry 会造成"每个文档一条队列"的语义漂移 |
| `tab.scrollTop` / `hugeTopLine` / `hugeHidden` / `imgDrag` / `previewScrollTop` | `:953-960`、`:446-447`、`:1807`、`app.js:189` | 纯视图级位置信息 |
| `document.hasFocus()` 守卫 | `app.js:273` | 窗口级，与文档无关（§7-R7） |
| `markSelfWrite` / `watchFile` 调用 | `tabs.js:368`、`:792`、`:395`、`:1203` | IPC 副作用必须留在编排层，registry 要能纯内存单测（0.5.0 Phase 1 唯一新用例 `docRegistryUnit` 就靠这个） |

---

## 6. Phase 1 的最小切片与施工顺序（5 步）

> **全局纪律**：每步都要求 `npm run build` 后跑回归；**同一时刻只允许一条线构建/跑冒烟**（0.5.0 §5）。每步的正向证明只有一条：**行为中性**。

### 6.1 回归口径（每步都跑，不得省略）

| 口径 | 命令 | 通过标准 | 备注 |
|---|---|---|---|
| 冒烟 | `npm run build` 后 **前台** `npm run smoke` | 末尾 `E2E_RESULTS` 计数 **≥ 现场基线**（侦察收尾实测静态 192；**不要引用任何文档里的数字，现场取**）且无 `false`/`ERR` 行（5 项信息型真值串除外） | 静态枚举推导见 §6.4。**必须前台**：`app.js:273` 的 `document.hasFocus()` 守卫会让 `sessionRestore`/`pinSessionPersist`/`extSessionRestore` 在后台必挂（AGENTS.md 亦记载） |
| 大文件编辑探针 | `node scripts/overlay-test.js` | `OVERLAY_PROBE 14/14 failed=0` | 用例数实测 = 14（`await check(` 计数，见 §9.1） |
| 手工 3 项 | ①开 >4MB 文件滚到底部再保存，文件尾部无 `MH-CHUNKED` 残留；②开 280MB 文件入区域编辑改一行保存，`git status`/字节数无异常；③CRLF 文件改一行保存，行尾不变 | — | 分段红线（§7-R4）与行尾红线 |

### 6.2 五个切片

#### 步 0：冻结基线（0.5 人日，**不改任何代码**）

- **动作**：①确认 `scripts/smoke.js` 的另一 agent 改动**已收工**（侦察收尾复查：6 项 `rcDir*`/`testIsolation` **已全部落地**，`smoke.js:3970/4020/4058/4091/4196/4270`，helper `runCase` 在 `:3815`；**但仍须现场确认文件 mtime 已静止**）；②跑一次 `npm run build` + 前台 `npm run smoke`，**记下 `E2E_RESULTS` 的实际条目数与逐条列表**，作为后续每步的比对基准；③跑 `node scripts/overlay-test.js` 记 `14/14`。
- **证明行为中性**：不适用（基线本身）。
- **回滚**：不适用。
- **风险**：若在另一 agent 未收工时就跑冒烟，基线会含"半成品用例"，后续无法判断回归来源。

#### 步 1：新建 `docmodel.js`（纯新增，零接线）

- **改哪些文件**：仅新增 `src/renderer/docmodel.js`。
- **内容**：§5.2 的 `createDocRegistry()`（集合 + 活动指针 + 脏标记），**不 import 任何其他渲染模块**（尤其不 import `tabs.js`/`ui.js`/`hugeview.js`），不碰 DOM，不碰 `window.api`。
- **证明行为中性**：`tabs.js` 未 import 它 ⇒ 构建产物行为不可能改变。可执行验证：`npm run build` 后 grep `dist/bundle.js` 中是否含 `createDocRegistry`——**若含则说明被误接线**（esbuild 只打包被引用的模块）。
- **回滚**：删文件。
- **回归口径**：跑完整 §6.1（确认无副作用）。

#### 步 2：`tabs.js` 内把 `tabs[]` 的**读写**改走 registry（**DOM 与 activeTab 逻辑一行不改**）

- **改哪些文件**：`src/renderer/tabs.js`（仅 `:106` 的 `const tabs = []` 与 6 处 `tabs.find`/6 处 `tabs.push`/1 处 `tabs.splice`/1 处 `tabs.sort`/2 处 `tabs.indexOf`）。
- **具体映射**：`tabs.push(tab)`(×6：`:366`/`:392`/`:508`/`:787`/`:941`/`:1597`) → `registry.add(tab)`；`tabs.find(...)`(×6，见 §2.3) → `registry.byPath/byDiffKey`；`tabs.splice(idx,1)`(`:1202`) → `registry.remove(tab)`；`tabs.sort(...)`(`:1697`) → `registry.replaceAll(sorted)`；`tabs.indexOf(activeTab)`(`:1032`)/`tabs.indexOf(tab)`(`:1200`)/`tabs.indexOf(anchor)`(`:1304`/`:1317`) → 保留数组语义（registry 的 `list()` 返回同一数组）。
- **为什么这一步安全**：`list()` 返回**同一个数组引用**，`for (const t of tabs)`（`:475`/`:1223`/`:1293`/`:1307`/`:1320`/`:1710`）全部零改动。
- **证明行为中性**：**diff 只有 15 处左右的机械替换**，且 `tabs` 变量仍以别名形式存在（建议保留 `const tabs = registry.list()` 的别名，把 diff 压到最小）；跑 §6.1 全绿 + 目视 `git diff` 无逻辑分支变化。
- **回滚**：`git checkout -- src/renderer/tabs.js`（docmodel.js 保留，不影响）。
- **回归口径**：§6.1 全绿。

#### 步 3：`activeTab` → `registry.active()/setActive()`（**机械替换 3 处写 + 80 处读**）

- **改哪些文件**：`src/renderer/tabs.js`（83 处，`tabs.js:107` 起）。
- **替换规则**（按 §2.2 分类逐类做，**不要一次性全局替换**）：
  1. 先做 **A 类**（`:107`/`:964`/`:1208`）→ `registry.setActive(...)`；
  2. 再做 **纯读判定类**（B/C/D/E/F/G/O 中的 `=== tab`、`!== tab`）→ `registry.isActive(tab)`；
  3. 最后做 **取当前文档类**（H/J/K/L/M/N 中的 `activeTab.xxx`）→ 引入局部 `const cur = registry.active()`。
- **证明行为中性**：保留一个**只读断言**（仅 dev）在 `createEditor` 顶部：
  ```js
  const assertActiveInSync = () => { /* dev 断言：registry.active() === 旧的闭包变量 */ };
  ```
  —— 更稳的做法：**不引入第二份状态**。即彻底删掉 `let activeTab`，所有读点都走 `registry.active()`（多一层函数调用，V8 内联后无性能风险）。
- **验证**：`grep -c 'activeTab' src/renderer/tabs.js` 应从 **83 降到 ≤ 3**（仅剩 `getActiveTab` 函数名与注释）。
- **回滚**：`git checkout -- src/renderer/tabs.js`。
- **回归口径**：§6.1 全绿。**这一步是本阶段最大的一步，建议按 §2.2 的 A→O 分成 4~5 次提交**（分类表就是提交清单）。

#### 步 4：补 `docRegistryUnit` 冒烟用例（**唯一新增用例**）+ 收尾

- **改哪些文件**：`scripts/smoke.js`（**另一 agent 已收工，但每次改前先确认 mtime 静止**）。
- **用例内容**（0.5.0 §3 Phase 1 验收）：
  - 同文件重复 `openFile` → 返回**同一 tab 引用**（`tabs.js:293-297` 现状即为去重）；
  - `registry.active()` 与 `getActiveTab()` 恒等；
  - `closeTab` 后 `byPath(p) === null` 且 `count()` 减 1；
  - `setActive(null)` 后 `getActiveTab() === null`（对应 `:1208`）。
- **证明行为中性**：用例本身只读 registry；不改任何现有断言。
- **回滚**：删用例。
- **回归口径**：§6.1 全绿，且计数从基线 +1。

#### 步 5（可选，建议做）：把 §2.2 分类表写进 `docmodel.js` 头注释

- **理由**：0.5.0 §2「开工动作 1」明确要求「把 `activeTab` 的 84 处按读/写/路由分类成清单，落在 `docmodel.js` 的重构注释里」。**本文件的 §2.2 就是那份清单**（数字修正为 83），直接粘进注释即可。
- **回归口径**：注释不改行为，跑一次 §6.1 确认无手误。

### 6.3 步骤依赖图

```
步0 冻结基线 ──► 步1 新建 docmodel.js ──► 步2 tabs[] → registry ──► 步3 activeTab → registry ──► 步4 docRegistryUnit ──► 步5 注释归档
                                  (纯新增, 零风险)      (15 处机械替换)        (83 处, 分 4~5 提交)      (改 smoke.js 前先确认 mtime 静止)
```

### 6.4 冒烟用例数的静态推导（**原始计数**，含**侦察期间的变化**）

**⚠️ 本文侦察期间 `scripts/smoke.js` 被另一 agent 改动过**。精确时间线（均为实测）：侦察主体读到的版本 = **3815 行 / 186 项**；收尾复查时该文件已被写入（`mtime = 2026/9/12 10:26:47`）→ **4353 行 / 192 项**；截至本次核对（`10:28:11`）该 mtime 已静止 **85 s**。**以下两张表要按"两次快照"读**。

**快照 A（侦察主体，3815 行）**：

```powershell
# step('name') 用例
$steps = ...regex "step\(\s*'([^']+)'"  →  163 处（其中 :3536 一处是模板串里的 `${pasteLabel}`，
                                              运行期展开为 menuPaste / menuPasteEmpty 两个名字）
# 顶层字面量 results.push(['X'
→ 23 处，其中 runPython 在 if/else 两支互斥（:99/:101）只算 1、mwError 只在异常分支（:3783）
# 多行 results.push([ (bundleSplit)
→ 1 处（:3667）
```

| 来源 | 行号（快照 A） | 运行期条目数 |
|---|---|---|
| `step('…')` 命名的 UI 用例 | `smoke.js:124` … `:3490` | **162** |
| `menuClipboardSnippet` 内的 `step(\`${pasteLabel}\`)` | `:3536`（定义 `:3509`） | **2**（`menuPaste` / `menuPasteEmpty`，经 `:3658` `results.push(...r1, ...r2)`） |
| 早期 IPC 字面量 | `:45/:49/:55/:59/:64/:68/:72/:74/:78/:99/:110` | **11**（`:99`/`:101` 互斥算 1） |
| 主进程侧字面量 | `:3641` rcDirArgParse、`:3651` previewImgClip | **2** |
| bundleSplit | `:3667-3672` | **1** |
| 多窗口 `mw*` | `:3699/:3710/:3716/:3731/:3745/:3756/:3771/:3779`（`:3783` 仅异常） | **8** |
| **快照 A 合计** | | **186** ✅（与任务口径一致） |

**快照 B（侦察收尾复查，4353 行）—— 另一 agent 的 6 项已全部落地**：

```powershell
runCase('...') count = 6
testIsolation  rcDirColdStart  rcDirCleanWindow  rcDirBadPath  rcDirDriveRoot  rcDirSecondInstance
smoke.js lines NOW = 4353   (was 3815 at recon)
step('...') count NOW = 163          # ← 老用例一个没动
literal push names = 23              # ← 老字面量一个没动
```

| 来源 | 行号（快照 B） | 条目数 |
|---|---|---|
| 快照 A 的全部 | — | **186** |
| 新增 `runCase('…')` 用例（新 helper，定义在 `smoke.js:3815`） | `:3970` testIsolation、`:4020` rcDirColdStart、`:4058` rcDirCleanWindow、`:4091` rcDirBadPath、`:4196` rcDirDriveRoot、`:4270` rcDirSecondInstance | **6** |
| **快照 B 合计** | | **192** |

> **与 0.5.0/0.4.0 的「183」差异**：那两份文档都写"静态枚举 183"，而快照 A 就是 **186**、快照 B 是 **192**。差额无法从既有文档归因（它未附枚举），**一律以运行时 `E2E_RESULTS` 输出为准**。
> **对 Phase 1 的影响**：步 0/步 4 的回归基线**必须现场取数**，不能引用任何文档里的数字；新增的 `docRegistryUnit` 会使基线 **+1**。另注意新用例用 `runCase` 而非 `step`，**统计命令要同时匹配两个 helper**：
> ```powershell
> Select-String -Path scripts\smoke.js -Pattern "step\(\s*'|runCase\(\s*'"
> ```

---

## 7. 风险清单

| # | 风险 | 证据（实测） | 缓解 |
|---|---|---|---|
| **R1** | **CM 实例复用 vs 多实例**：现在 1 个 `EditorView`（`tabs.js:257`），切标签靠 `setState` 搬运（`:982`/`:994`）。Phase 2 若改成"每 pane 一个 view"，内存/测量 ×2，且隐藏栏不参与测量会导致视口算错 | `tabs.js:257`、`:982`、`:996`（`requestMeasure` 注释已自认"刚从 display:none 恢复时要请一次测量"）、`styles.css:576` | Phase 1 **不引入第二个 view**；Phase 2 硬上限 2 栏 + 隐藏栏显式 `requestMeasure`；把 `stressTabs100` 类压测纳入分屏 |
| **R2** | **huge 让位与 CM 互斥**：`syncEditorLayer`（`:466-478`）写死"单 host + 单 CM"，靠 `#editor-host.huge-active` 类（`styles.css:1572`）落地 | `:472`（全局 `view.dom.style.display`）、`:474`（整宿主一个类）、`:475-477`（遍历全局 tabs）、`hugeview.js:50`（根节点挂宿主）、`hugeview.js:826`（ResizeObserver 观察宿主） | Phase 1 不改（记录在案）；Phase 2 让位按 pane 计算（§4.3 五条） |
| **R3** | **CM `updateListener` 闭包捕获全局 `activeTab`**：B 栏打字可能标脏/覆盖 A 栏 | `tabs.js:238-252`（尤其 `:239`/`:241`/`:242`/`:245`） | Phase 1 只把 `activeTab` 换成 `registry.active()`（行为等价，因为 Phase 1 只有一个 view）；**Phase 2 一引入第二个 view 就必须先改成 `u.view` 反查**，否则数据损坏 |
| **R4** | **`chunked` 分段与 `stripChunkMarkers` 红线**：占位标记一旦写进用户文件即为数据污染 | `tabs.js:43`（标记文本）、`:845`（追加前删旧标记）、`:1472`/`:1499`（保存前剥离，**仅此两条保存路径**）、`ui.js:72-74`（`CHUNK_MARKER_RE`/`stripChunkMarkers`）；消费方只剩 `preview.js:321`（预览）与 `tabs.js:1472`/`:1499`（保存） | Phase 1 **禁止触碰** `appendChunkText`/`saveStreamed`/`doSaveNow` 的分段分支；`docmodel.js` **不得**持有 `stripChunkMarkers` 逻辑 |
| **R5** | **`huge` 保存绝不能走整篇写盘**：`tab.state` 是空文档，写盘 = 把 GB 文件截成 0 字节 | `tabs.js:1432-1437`（含 `:1435` 的明确警告注释）、`:1444`（走 `hv.save()`） | 新模型里保留"huge 正文真源在 overlay"的守卫（§4.2-C6） |
| **R6** | **文件监听与自写识别**：`markSelfWrite` 靠 mtime+size 一次性匹配（`filewatch.js:160-167`）+ 2s 宽限（`:21`）；渲染端还有 1.2s（`tabs.js:1835`）与 3s（`:1843`）两道回声守卫 | `filewatch.js:74-87`、`tabs.js:1835`、`:1843`、`ipc.js:172/202/316/369/419`、`overlay.js:1076-1077` | Phase 1 不动写盘与监听调用点；若 `Document` 化后 `lastSavedAt` 换了持有者，**三处守卫窗口必须一起搬**，否则高频编辑会开始误报「外部修改」 |
| **R7** | **会话持久化格式兼容**：`persistSession` 写死 `{paths, active, pinned}`（`app.js:283`），并有 `document.hasFocus()` 守卫（`app.js:273`）；恢复端按 `paths.slice(0,200)` + 并发 6 + `reorderTabs` + pinned 下标还原（`app.js:293-326`），冒烟有 3 项断言结构（`:2324`/`:2808`/`:3495`） | `app.js:272-285`、`:289-329`、`smoke.js:2326`、`:2809`、`:3497` | **旧 session 不能炸**：Phase 1 **不改格式**；Phase 3 加 `layout` 时按 0.3.0 §2.5「无 `layout` 则映射为单栏」 |
| **R8** | **跨窗口 `file-shared-open` 只读语义**：第二个窗口打开同文件 → `file-shared-open` → 渲染端 `setTabReadOnly(tab, true)` + toast | 主进程 `filewatch.js:129-131`（`sharedBefore` 判断）、`:151-155`（发事件）；渲染端 `app.js:1130-1136`；只读观察窗静默节流同步 `tabs.js:1888-1898`；冒烟断言 `smoke.js:3745`（`mwSharedReadOnly`） | Phase 1 **一行不改**（`setTabReadOnly` 保持"只对 `!tab.kind` 生效"，`:1269`）。Phase 4 改锁表时**必须同步核对 `smoke.js:3745`**（0.5.0 §3 Phase 4 已挂账） |
| **R9** | **`saveQueue` 全局串行**（`tabs.js:1410`）：多文档后大文件保存会阻塞其它标签的保存 | `:1407-1421` 注释自述「并发 saveNow 在大文件 ensureFullyLoaded 阶段交错是截断写盘的竞态源」 | Phase 1 保持全局队列（正确性优先）；Phase 3 若要按文档分队列，必须重新论证截断竞态 |
| **R10** | **`tabs.js` 与 0.4.0 大文件线的文件冲突**：两条线改同一个文件 | 0.5.0 §2 表 / §8 首行 | 0.4.0 Phase D 已落地（本文侦察确认 huge 全链路在位），**串行条件已满足**；但施工期间仍需"同一时刻一条线" |
| **R11** | **冒烟窗口需前台**：`document.hasFocus()` 守卫（`app.js:273`） | `app.js:273`；AGENTS.md 明确记载 | 每步回归必须前台跑 |
| **R12** | **`scripts/smoke.js` 被另一 agent 改动**（实测：侦察主体 3815 行 → 收尾复查 4353 行，该次写入 `mtime = 2026/9/12 10:26:47`） | 侦察主体：含 `rcDirArgParse`（`:3641`）、3815 行；收尾复查：6 项全部落地（`:3970/4020/4058/4091/4196/4270`，helper `runCase` 在 `:3815`）、4353 行 | 步 0/步 4 改 `smoke.js` 前**再确认一次 mtime 静止**（本次检查已静止 85 s，但不等于对方收工）；构建/冒烟不得并行（0.5.0 §5 同款纪律） |
| **R13** | **`window.__app.editor` 是 dev 测试面**（`app.js:1184`），`smoke.js` 有 108 处 `app.editor.openFile` 等直接调用 | `app.js:1183-1185` | 步 3 改 `activeTab` 时**不能顺手改任何 API 名字/参数**（§3.2） |

---

## 8. 「不做」清单（Phase 1 明确不做，防止范围蔓延）

| 不做的事 | 为什么现在不做 | 归属阶段 |
|---|---|---|
| **任何 UI 分栏**（`#editor-panes`、`.pane`、分隔条拖拽、栏内标签栏） | Phase 1 的硬指标是"行为中性"；动 DOM 就等于换了一套渲染路径，冒烟 186 项无法证明等价 | **Phase 2** |
| **多视图同步滚动 / 链接滚动** | 需要 `Document.views` 与逐视图 scroll 广播；Phase 1 连"多视图"都不存在 | Phase 3 / 0.5.1 |
| **布局持久化**（`layout` 字段、比例、焦点栏、`layoutBackCompat`） | 会改会话格式（`app.js:283`），与 R7 冲突 | **Phase 3** |
| **跨窗口接管编辑**（锁表、`doc:claim-edit`、`file-lock-changed`、只读横幅按钮） | 牵涉主进程 `filewatch.js` 与 `preload.js` 镜像，与 Phase 1 无交集 | **Phase 4** |
| **改 `find.js` / `preview.js` 的 `getView()` 取法** | 0.5.0 §2 开工动作 3 明确：「不要在 Phase 1 顺手改 `find.js`」；`getView()` 在 huge 焦点下返回空文档 CM 是**既有行为**，必须保留 | Phase 2+ |
| **huge 语义调整**（让位按 pane 计算、huge 内查找、huge 纳管 `file-changed` 广播到全部视图） | 0.5.0 §3 Phase 1 风险行：「禁止在本阶段顺手改 huge 语义」 | Phase 2/3 |
| **改 `stripChunkMarkers` / 分段追加逻辑 / `saveStreamed`** | 数据安全红线（R4），且 Phase 1 无收益 | Phase 3（广播化时） |
| **新建 `quickopen.js` / `outline.js` / `help.js`**（体验 11 条） | 与文档模型无关 | **Phase 5a** |
| **删除 4 个死导出**（`activateByPath`/`togglePinned`/`toggleReadOnly`/`getHugeThresholdMB`） | `window.__app` 是测试面，删键收益 0、破坏面不可枚举 | 0.5.1+ |
| **`tab` 对象换成全新 `Document` 类** | 冒烟直读 `tab.kind/huge/vwin/chunk`（§3.3），换对象=大面积挂 | Phase 3（配 7 项新用例一起） |
| **给 `persistSession` 加 `force` / 动 `hasFocus` 守卫** | 会破坏 `sessionRestore` 系列（R7/R11） | Phase 3 |

---

## 9. 附录：复核命令与原始输出

### 9.1 执行过的**只读**命令清单

> 全部为只读（`Get-Content`/`Select-String`/`[System.IO.File]::ReadAllLines`/`Test-Path`/`git status`/`git log`）。**未执行** `npm run build`、`npm run smoke`、`node scripts/overlay-test.js`（后者是"跑测试"而非只读，且与另一 agent 的通道冲突，本次仅**静态计数**其 14 个用例）。

| # | 命令（PowerShell） | 用途 |
|---|---|---|
| 1 | `pwd; git status --short; git rev-parse --abbrev-ref HEAD; git log --oneline -5` | 基线 |
| 2 | `[System.IO.File]::ReadAllLines('src\renderer\tabs.js').Count` | tabs.js = 2040 行 |
| 3 | `for(...){ ([regex]::Matches($all[$i],'activeTab')).Count }` | activeTab = **83** 处 / 67 行 |
| 4 | `Select-String -LiteralPath ... -Pattern 'activeTab' -CaseSensitive` | 交叉校验 = 83（不区分大小写 = 85，多 `getActiveTab`×2） |
| 5 | `regex 'tabs\.find'` 全文计数 | = 6 |
| 6 | 解析 `tabs.js:2029` 的 `return {...}` + `:2034`/`:2039` | API = **33**（31+2） |
| 7 | `(editor\|__app\.editor)\.<API>\b` 遍历 `src/**/*.js`+`scripts/*.js` | §3.1 调用点数 |
| 8 | `Select-String 'new EditorView\|EditorState\.create\|new Compartment'` | 唯一 CM 实例 = `tabs.js:257` |
| 9 | `Select-String '#editor-host\|huge-active\|\.cm-editor'` on `styles.css` | 让位规则 = `styles.css:1572` |
| 10 | `Select-String 'editor-host\|image-host\|diff-host\|viewer-bar\|preview-host'` on `index.html` | DOM 宿主行号 |
| 11 | `regex "step\(\s*'([^']+)'"` + `results\.push\(\['` on `smoke.js` | 冒烟 = **186** 项（快照 A）；收尾复查加 `runCase` = **192** 项（快照 B） |
| 12 | `regex "await check\(\s*(\d+)\s*,"` on `overlay-test.js` | 探针 = **14** 项 |
| 13 | `Test-Path src\renderer\docmodel.js` / `quickopen.js` / `outline.js` / `help.js` | 全部 `False` |
| 14 | `regex '\bapplySnippet\b'` 全仓库 | 0 命中（0.3.0 §2.7 该行已过期） |
| 15 | `regex 'savedContent'` | 仅 `tabs.js:106` 注释（死字段名） |

### 9.2 关键原始输出片段

```
activeTab total occurrences = 83
activeTab matching lines     = 67
tabs.find occurrences        = 6
--- Select-String cross-check (matching lines) ---
85
in comment lines = 0 ; in code lines = 83

shorthand keys = 31
total incl 2 test-surface = 33

ReadAllLines count = 2040        (tabs.js)
smoke.js lines = 3815            (快照 A；收尾复查 = 4353)
overlay-test.js: await check(no, ...) count = 14
```

**收尾复查（同一命令重跑）**：

```
smoke.js lines NOW = 4353   (was 3815 at recon)
step('...') count NOW = 163
runCase('...') count = 6
literal push names = 23
```

### 9.3 行号漂移对照表（**既有文档 → 实测**，施工时一律用右列）

| 既有文档引用 | 实际位置 | 内容 |
|---|---|---|
| 0.5.0 §2「`tabs.js:1949` 的 `return {}`」 | `tabs.js:2029` | API 返回块 |
| 0.5.0 §2「`tabs.js:318-320` 分流」 | `tabs.js:324-326` | `st.size > hugeScrollThreshold → openHugeTab` |
| 0.5.0 §2 / 0.4.0 §13「`:375` 建标签」「`:382` `readOnly:true`」 | `tabs.js:378-391`、`:390` | `openHugeTab` 的 tab 字面量与 `readOnly: true` |
| 0.5.0 §2「`syncEditorLayer` 定义 `:447`，调用 `:948`/`:954`/`:1178`」 | 定义 `tabs.js:466`；调用 `:967`/`:475-477`；`closeTab` 里 `:1211` | 让位函数 |
| 0.5.0 §6「`tabs.js:963` `view.setState(tab.state)`」 | `tabs.js:982` | 重建视图 |
| 0.5.0 §6「`tabs.js:251` `new EditorView({`」 | `tabs.js:257` | 唯一 CM 实例 |
| 0.5.0 §6「`tabs.js:287` `tabs.find` 去重」 | `tabs.js:293` | openFile 去重 |
| 0.5.0 §6「`tabs.js:951/956/960/1177` 四处 `setState(makeState('','text'))`」 | `tabs.js:970`/`975`/`979`/`1210` | 空文档占位 |
| 0.5.0 §3 Phase 3「`tabs.js:1774-1776` file-changed」 | `tabs.js:1827-1830`（过滤条件在 `:1830`） | 外部修改路由 |
| 0.5.0 §3 Phase 3「`app.js:272-284`」「`app.js:283`」「`app.js:289-329`」 | `app.js:272-285` / `:283` / `:289-329` ✅ **仍准确** | 会话持久化 |
| 0.5.0 §4 Phase 4「`scripts/smoke.js:3484` 的 `mwSharedReadOnly`」 | `scripts/smoke.js:3745` | 只读语义断言 |
| 0.5.0 §6「`app.js:1129` file-shared-open」 | `app.js:1130` | 跨窗口只读 |
| 0.4.0 §13「`tabs.js:956`」 | `tabs.js:975` | huge 下 CM 置空文档 |
| 0.4.0 §13「`tabs.js:1402-1408` `doSaveNow` huge 分支」 | `tabs.js:1432-1457` | overlay 保存分支 |
| 0.4.0 §13「`tabs.js:1587-1597` `getSession`」 | `tabs.js:1640-1650` | 会话快照 |
| 0.4.0 §13「`tabs.js:362` / `:773` `watchFile`」 | `tabs.js:368` / `:792`；huge 在 `:395` | 文件监听注册 |
| 0.4.0 §13「`scripts/smoke.js:2848` 按 kind 分叉」 | `scripts/smoke.js:2848` ✅ **仍准确** | 大文件冒烟分叉 |
| 0.4.0 §13「`scripts/smoke.js:3413-3532` 第二窗口 `mw*` 块」 | `scripts/smoke.js:3674-3793` | 多窗口块 |
| 0.4.0 §13「`find.js:24-25`」 | `find.js:24-26` ✅ **基本准确** | `getView()` 取法 |
| 0.3.0 §2.7「保留 `applySnippet`」 | **该 API 不存在** | 兼容层表已过期 |
| 0.5.0 §8「B3：`filewatch.js:42`/`:188` `fs.unwatchFile` 不带 listener」 | `filewatch.js:42`/`:188` ✅ **仍准确** | 待修缺陷 |

### 9.4 `git status --short`（侦察开始时）

```
 M AGENTS.md
 M CHANGELOG.md
 M README.md
 M build/installer.nsh
 M package.json
 M scripts/smoke.js
 D src/main/ai.js
 M src/main/ipc.js
 M src/main/main.js
 M src/main/python.js
 M src/main/search-worker.js
 M src/main/search.js
 M src/main/settings.js
 M src/preload/preload.js
 D src/renderer/ai-panel.js
 M src/renderer/app.js
 M src/renderer/diffview.js
 M src/renderer/globalsearch.js
 M src/renderer/index.html
 M src/renderer/preview.js
 M src/renderer/python.js
 M src/renderer/styles.css
 M src/renderer/tabs.js
 M src/renderer/tree.js
?? .smoke-test/
?? asar_list.txt
?? docs/交接-会话纪要.md
?? docs/开发计划-多视图与体验流畅度-0.3.0.md
?? docs/开发计划-多视图与体验流畅度-0.5.0.md
?? docs/开发计划-大文件秒开与秒搜-0.4.0.md
?? docs/缺陷清单-0.2.5-审计.md
?? scripts/overlay-test.js
?? src/main/args.js
?? src/main/lineindex.js
?? src/main/overlay-ipc.js
?? src/main/overlay.js
?? src/renderer/hugeview.js
```

> **说明**：上述 `M`/`D`/`??` **全部是侦察开始前就存在的**（大文件线 A–D、AI 移除、计划文档等未提交内容），**不是本次产生**。
>
> **本次侦察的净变化 = 恰好 1 个新文件**。收尾 `git status --short` 与上表的唯一差别就是多出这一行：
>
> ```
> ?? "docs/开发计划-多视图-Phase1-重构清单.md"
> ```
>
> 未修改任何既有文件，未触碰 `src/**`、`scripts/smoke.js`、`AGENTS.md`、`CHANGELOG.md`、既有 `docs/*.md`。
> **但必须记录一个环境事实**：侦察期间 `scripts/smoke.js` 被**另一个 agent** 写入过（该次写入 `mtime = 2026/9/12 10:26:47`，行数 3815 → 4353）。这是**别人**的改动，与本次侦察无关，但它是 §6.4 两张快照与 R12 的成因。

---

## 10. 未核实项（**明确标注，不要当结论用**）

| # | 未核实内容 | 为什么没核实 | 建议核实方式 |
|---|---|---|---|
| U1 | `tab.id` 是否有任何读者 | 未逐文件 grep `\.id\b`（噪声太大） | `grep 'tab\.id\|\.id ===' src scripts`（施工步 3 顺手做） |
| U2 | 冒烟 `E2E_RESULTS` 的**运行时**条目数（静态：快照 A 186 / 快照 B 192） | 不允许跑 `npm run smoke`（另一 agent 独占通道 + 后台跑必挂） | 步 0 前台跑一次，以输出为准 |
| U3 | 另一 agent 的 6 个 `rcDir*`/`testIsolation` 用例**运行时**是否全绿 | 只做了静态计数（6 个 `runCase` 已落地），未运行 | 步 0 的基线跑会给答案 |
| U4 | `huge` 视图内 `Ctrl+F` 是否真的"静默 0 命中" | 需要真实窗口操作 | 0.5.0 §6 待决项 1 已列为待决；本阶段不改 |
| U5 | `editor.saveNow()` **无参**调用点（`app.js:1062`）在双栏下的期望语义 | 属 Phase 2 决策 | Phase 2 开工时定义 |
| U6 | `reorderTabs` 的 `tabs.sort` 在原地排序后，是否与 `tabBadges`(Map) 的插入顺序假设冲突 | 需运行期验证 | 步 2 改 `replaceAll` 时加一次目视核对（冒烟 `sessionRestore`/`stressSession` 会覆盖） |

---

## 11. 施工记录（Phase 1 实际施工回填，2026-09-12）

> **本节由施工 agent 回填**（其余章节保持侦察原文不动）。全部数字为施工当次实测。

### 11.1 环境事实：本机 `npm run smoke` 需要 9 分钟，且**不能前台跑**

| 项 | 实测 |
|---|---|
| 本机单次 `npm run smoke` 墙钟 | **约 9 分钟**（基线跑 17:56:15 → 18:05:0x；另一份早于本次的交接记录写的是 142～151 s） |
| 前台跑 | **不可行**：agent 的命令通道有 **600 s 硬上限**，前台跑到上限被强杀（实测一次：日志停在 rcDir 夹具阶段，无 `E2E_RESULTS`）。被强杀的那次**没有**产生错误结果行，只是没跑完 |
| 实际采用的跑法 | `run_in_background: true` + `job_output(wait)` 收集；**`document.hasFocus()` 守卫在本次全部 4 次跑里都没成为问题**——`sessionRestore`/`pinSessionPersist`/`extSessionRestore` 三项**全程 `true`**（该机器上后台窗口仍拿到焦点） |
| 结论（对后续读者） | 契约里的「必须前台」在这台机器上**不是必要条件**；真正的硬约束是「单次 ≥ 9 分钟，别用 600 s 上限的命令通道」。但**能前台就前台**：焦点语义毕竟依赖窗口状态，换了机器/有人抢占焦点时后台跑会假失败 |

### 11.2 §0/§2.1 的静态口径**全部复核通过**（施工前重跑）

```
activeTab total occurrences = 83        （分布在 67 行，与 §2.1 一字不差）
activeTab by category A..O  = 3+6+5+1+16+3+5+20+3+6+3+2+4+5+1 = 83  ✅
tabs.js lines               = 2040      （与 §0 一致）
smoke.js lines              = 4368 / mtime 2026-09-12 10:35:37（侦察收尾后再无写入 ⇒ R12 的"另一 agent"确已收工）
静态 step/runCase 计数       = 169（+字面量 23 ⇒ 运行时 192，与实测 E2E_RESULTS 192 行一致）
```

### 11.3 基线（步 0）

- `npm run build` → `[build] bundle.js = 0.91 MB | mermaid-chunk.js = 3.29 MB | 合计 = 4.20 MB`
- `npm run smoke` → **192 个结果行、`| false` 0 行、`SMOKE_OK`、exit 0**
- `node scripts/overlay-test.js` → `OVERLAY_PROBE 14/14 failed=0 skipped=7`、exit 0

### 11.4 步 1 的"零接线"证明（比 §6.2 步 1 的建议更强）

`git show`/`dist` 对照：新增 `docmodel.js`、`tabs.js` 尚未 import 它时，**`bundle.js` 仍是 930.6 kb、`合计` 仍是 4.20 MB（与基线逐字节同尺寸）**，且 `dist/bundle.js` 里 `grep createDocRegistry` **零命中**（esbuild 只打包被引用的模块 ⇒ 反向证明没被误接线）。接线后同一命令变为 931.8 kb。

### 11.5 ⚠️ 本次踩到的**唯一真回归**：`closeByPath` 里漏改一处 `[...tabs]`

- **现象**：步 2+3 合并验证跑出 **2 个 `ERR`**：`pinDeletePath`、`deleteNoResurrect` 均 `TypeError: tabs is not iterable`（栈指向 `bundle.js` 的 `closeByPath`）。
- **根因**：`tabs.js:1734`（重构后行号）的 `for (const t of [...tabs])` 漏改 —— 我用正则 `(?<![A-Za-z0-9_$.])tabs(?![A-Za-z0-9_$])` 做普查，**`[...tabs]` 这种"被 `[` 包裹"的写法没被这条正则的负向后顾排除掉，但那一轮普查跑在后续若干次编辑之前**，于是漏网。改成 `[...docs()]` 后重跑全绿。
- **教训（写给后续 Phase）**：`activeTab`/`tabs` 这类变量改名，**收尾必须用"包含子串"的宽口径普查**（`-match 'tabs'`，再人工剔 `tabsEl`/`renderTabs`/`onTabSwitch`），不要只靠带边界的正则；并且**改动之后要重跑一次普查**（边界正则的结果会随编辑失效）。

### 11.6 步 3 的"83 处"归宿（逐个来源可查）

删除 `let activeTab` 后，`tabs.js` 里 `activeTab` 只剩 **1 行**（第 245 行的说明注释）＋ `getActiveTab()` 这个**对外 API 函数名**（:1657 定义、:2056 导出）——即 §6.2 步 3 要求的「降到 ≤ 3」。83 处按 §2.2 分类逐类落到：`registry.active()`（22）、`registry.isActive()`（22）、`registry.setActive()`（2）、`registry.markDirty()`（10）。

### 11.7 步 4 的变通执行（**未改 `scripts/smoke.js`**）

本次施工的任务书**禁止改动 `scripts/smoke.js`**（该文件刚验收完），因此 §6.2 步 4 的 `docRegistryUnit` **没有落进冒烟**。变通做法：用 `--exttest` 通道（临时替换 `scripts/ext-test.js`，跑完 `git checkout -- scripts/ext-test.js` 还原、`git diff --stat` 为空）在真实窗口里跑了同批断言：

```
DOCREG ok   dedupeSameRef              （同文件重复 openFile 返回同一 tab 引用）
DOCREG ok   twoDocsListed
DOCREG ok   activeIsOpened             （registry.active() === 刚打开的 tab）
DOCREG ok   sessionActiveIndex         （会话 active 下标 = 0）
DOCREG ok   activeFollowsSwitch        （切标签后活动指针跟随）
DOCREG ok   docFieldsIntact            （kind/dirty/path/name 仍直读在 tab 上）
DOCREG ok   typingHitsActiveDoc        （dispatch 后只有当前承载文档变脏：t2.dirty=true, t1.dirty=false）★ C1 的回归锚点
DOCREG ok   stateBackwritten           （tab.state === view.state 同一引用）
DOCREG ok   closeRemovesFromRegistry   （closeTab 后 findTabByPath → null 且 count 减 1）
DOCREG ok   activeMovedToNeighbor
DOCREG ok   closeAllActiveNull         （关完最后一个 → getActiveTab() === null）
DOCREG ok   emptyStateShown
DOCREG ok   noThrowWithNoActiveDoc     （空表下 scrollToTop/scrollToBottom/getSession/renderTabs/cycleTab/dispatch/closeTab(表外对象) 全不抛）
DOCREG ok   sessionShapeUnchanged      （getSession() 仍是 {paths,active,pinned} 三键）
DOCREG_SUMMARY 14/14 failed=0
```

`typingHitsActiveDoc` 是这条探针里最有价值的一条：它断言"打字只脏**当前承载的文档**"——这正是 Phase 2 双栏下最容易坏、也最难在出事前发现的性质。**结论：`docRegistryUnit` 仍应作为一条正式冒烟用例补进去**（属于 0.5.0 Phase 1 的验收项 1，建议由允许改 `smoke.js` 的那条线做）。

### 11.8 施工顺序的实际取舍

§6.2 的步 1 / 步 2 / 步 3 是**分别验证**的（步 1 单独跑绿：192 行 / false 0 / `SMOKE_OK` / exit 0）。**步 2 与步 3 合并成一次验证**：原因是本机单次冒烟 9 分钟，而步 2 的改动（`tabs[]` 走注册表）与步 3（`activeTab` 走注册表）都属"机械搬运"、且步 3 依赖步 2 的 `registry` 实例；合并后靠"回滚粒度 = 单文件 + 语义分组"保住可回滚性（`git checkout -- src/renderer/tabs.js` 即可整体回退到步 1 的绿状态）。步 5（把 §2.2 分类表写进 `docmodel.js` 头注释）随步 1 一并落地（纯注释，不参与行为）。

### 11.9 Phase 2 的接线点（本次已备好、尚未启用）

`docmodel.js` 导出的 `bindView(view, doc)` / `unbindView(view)` / `docOfView(view)`：`tabs.js` 现在只在 `switchTab`（绑定）与"关完最后一个标签"（解绑）调用前两者；`docOfView` **目前零调用**（只有注释提到它），`CM updateListener` 里现在是 `u.view === view` 的等价判据。Phase 2 引入第二个 `EditorView` 的那一步，把 `tabs.js:250-252` 那两处的 `registry.active()` 换成 `registry.docOfView(u.view)` 即完成逐视图回写。

---

## 12. 施工记录（Phase 2「左右双栏分屏」实际施工回填，2026-09-12）

> **本节同样由施工 agent 回填**。数字与 `文件:行号` 均为 Phase 2 施工当次实测。**验证口径的例外见 §12.8**。

### 12.1 最终 DOM / 焦点模型

```
#workbench
└─ #editor-panes  (.editor-panes，flex row；分栏时额外挂 .split 类)
   ├─ .pane[data?]  (panes[0]，**恒为 p0**：唯一挂历史 ID 的那一栏)
   │  ├─ .tabs.pane-tabs   ← p0 上 id="tabs"
   │  └─ .editor-wrap.pane-body
   │     ├─ .editor-host   ← p0 上 id="editor-host"（本栏唯一的 EditorView 宿主）
   │     ├─ .image-host / .diff-host / .viewer-bar / .split-divider / .preview-host / .editor-empty
   ├─ .pane-divider        ← 只在两栏时存在（tabs.js 动态插入）
   └─ .pane                (panes[1]，只用 class，无任何 id)
      └─ … 与 p0 完全对称
```

- **`focusPaneId` 语义**：全窗口唯一一个「焦点栏」指针（`registry.focusPane()`）。它决定：状态栏显示谁、`Ctrl+S`（`saveNow()` 无参）保存谁、`onTabSwitch`（→ 预览/树跟随/运行按钮）为谁触发、新打开的文件进哪栏、`getView()` 返回哪个 `EditorView`。
- **每栏一份的活动指针**：`registry.activeOf(paneId)`；无参的 `registry.active()` ≡ **焦点栏**的活动文档，`registry.isActive(doc)` ≡ 「doc 是**它自己那一栏**的活动文档」—— 单栏下与 Phase 1 逐位等价，因此 Phase 1 落地的 22 处 `active()` / 22 处 `isActive()` **一个参数都没加**。
- **硬不变量「单文档单栏」**：一个 tab 只属于一个 pane（`registry.setPaneOf`）。`openFile` 命中已在**另一栏**打开的文件时，不新开视图，而是把焦点切到那一栏并 toast（`tabs.js` 的 `openFile` 顶部守卫）→ **"同一文件同时占两栏"这个组合在 Phase 2 不会出现**，因此不需要降级只读，也不存在半成品的"两份 state 互相打架"。真·同文件多视图同步是 Phase 3 的 G2。
- **分栏入口**：`Ctrl+\`（单栏→右侧开空栏并聚焦；两栏→合并回单栏）、拖标签到编辑区左/右 30% 边缘（单栏时该侧开栏；两栏时拖到另一栏）、`Ctrl+1`/`Ctrl+2` 聚焦第 1/2 栏。硬上限 `MAX_PANES = 2`。
- **回落单栏**：关掉某栏最后一个标签（`closeTab` → `removeEmptyPane`）或合并（`mergePanes`）时，**保留栏恒为 p0**（按 id 取，不按屏幕位置）—— p0 是唯一挂历史 ID 的栏，左分屏后若按位置取会把 `#editor-host` 一起销毁，`find.js` / `preview.js` / 冒烟里所有按 ID 取值的地方会集体失联（这是施工中自查发现并修掉的一个真缺陷）。
- **分隔条**：`flex: 0 0 <px>` 固定左栏 + `flex: 1 1 0` 右栏（两边都写百分比会因 `flex-shrink:0` 溢出容器 6px）；最小宽度 `MIN_PANE_PX = 200`，按 `usable = 容器宽 − 分隔条宽` 夹取比例。

### 12.2 C1 的最终落点（本阶段最重要的一行）

- `tabs.js` 的 `makeState()` 里：`const t = registry.docOfView(u.view);`（原为 `u.view === view` + `registry.active()`）。
- 绑定点：`switchTab()` 内 `registry.bindView(pane.view, tab)`（每次切换活动文档都重绑）。
- 解绑点：`switchTab` 的空栏分支、`closeTab` 的空栏分支 `registry.unbindView(pane.view)`；`mergePanes()` 里 `registry.unbindView(gone.view)`。
- **效果**：B 栏打字只会回写 B 栏所属文档 —— `docOfView` 未登记时返回 `null`，**绝不回退成"活动文档"**（docmodel.js 的既有约定）。

### 12.3 C2–C12 逐项归宿

| # | 本阶段处置 | 说明 |
|---|---|---|
| C2 | **已解决** | 不再有"切标签靠 `setState` 搬运"的共享问题：**每栏一个 `EditorView`**，两栏各自 `setState(自己活动文档的 state)`，光标/选区/折叠天然互不干扰。同一文档不会被两栏同时承载（单文档单栏），所以暂时不需要"一视图一份 EditorState" |
| C3 | **已解决** | 同 C1：`activeTab.state = u.state` 变成「回写 `docOfView(u.view)` 的 state」。`remoteAnnotation` 防环属 Phase 3（本阶段没有广播） |
| C4 | **已解决** | `setWordWrap`/`setIndentSize` 从"只 dispatch 唯一 view"改成**遍历 panes 逐 view reconfigure**（Compartment 实例仍复用） |
| C5 | **部分解决** | `setTabReadOnly` 改成落到「该文档所属栏的视图」并只在焦点栏时刷状态栏；`viewer-lg` 的 `tab.editing` 与文档级 `readOnly` 仍是同一处三目（当初计划的"拆成显式函数"未做，见 §12.5） |
| C6 / C7 | **未触碰**（守住红线） | `doSaveNow` 的 huge 分支与 `stripChunkMarkers` 消费路径一行未改；分段追加 `appendChunkText` 只把 `view.state` 换成 `viewOfDoc(tab).state`（单文档单栏下语义不变） |
| C8 | **未处理**（留 Phase 3） | `viewer-lg` 区域编辑的"窗口级串行"保护当初靠 `activeTab` 唯一性；本阶段每栏仍只有一个 `viewer-lg` 活动标签，且同一文件不会开在两栏 → 隐式保护**仍然成立**（不是"消失了"） |
| C9 | **已解决** | `reloadFromDisk` 的判据与 dispatch 目标都改成「该文档所属栏的视图」（N 类冲突点全部按栏判定） |
| C10 | **按规格保持现状** | `find.js` 一行未改：它经 `getEditor().getView()` 拿到的现在是**焦点栏**的 CM —— 这正是 Phase 2 期望的"查找/预览跟随焦点栏"。huge 视图内 `Ctrl+F` 静默 0 命中的既有行为保持不变（0.5.0 §6 待决项 1，属 Phase 5a） |
| C11 | **已解决** | `restoreTabScroll`、`scrollToBottom`、`slideViewer`、`viewerJump`、`maybeSlideViewer` 的多帧 `requestAnimationFrame` 校正守卫全部保留 `registry.isActive(tab)`（= 按栏判定），另加 `isFocusedPane` 判断避免非焦点栏抢状态栏 |
| C12 | **已解决** | `view.scrollDOM` 的 scroll 监听改成**每栏一份**，用 `registry.docOfView(pane.view)` 反查"这个 view 自己的文档"，不再驱动全局活动标签 |

### 12.4 新增/扩大的对外 API（测试面）

`toggleSplit()`（返回合屏后的栏数）、`openSecondPane(side)`、`mergePanes()`、`focusPaneIndex(i)`、`getFocusPaneId()`、`getPaneCount()`、`getPaneLayout()`（栏数/焦点栏/比例/每栏活动文件名与**真实 DOM 宽度**）、`getPaneEls(i)`、`getPaneElsById(id)`、`paneActiveOf(paneId)`、`paneIdOf(tab)`。全部是**追加**，33 个既有键一个都没改名/删除。

### 12.5 已知弱项与主动放弃（Phase 2）

1. **非焦点栏的"即时渲染"路径已按栏判定**（`onDocChanged` / `debouncedPreviewRender` 都用 `editor.paneIdOf(tab)` + **该栏的** preview 实例），且 `onTabSwitch` 增加了 `focused` 第二参：非焦点栏内部切标签时**只**刷新它自己的图层显隐（编辑器/图片/对比/预览），不碰状态栏/树跟随/查找/运行按钮。仍存的弱项：非焦点栏的预览**滚动位置多帧校正**只对焦点栏做（避免两栏抢滚动条）。
2. **不做标签排序**：拖到编辑区**中间**区域不动作（A4 属 0.5.1+）。
3. **把"该栏唯一的标签"拖到边缘** = 开栏后源栏立即变空 → 触发回落单栏（净效果近似"不动作"）。取舍理由：Phase 2 采用"空栏不保留"的单一口径（与 `splitCloseLast` 一致），不额外引入"允许空栏常驻"这个新状态，减少不可验证的分支。
4. **布局不持久化**：重启回落单栏；`getSession()` 仍是 `{paths, active, pinned}` 三键（这是**故意不变**，格式变更属 Phase 3 的 `layout`）。`splitSessionShape` 用例同时断言了"`layout` 键尚不存在"。
5. **同文件双栏被禁止**（见 §12.1 的硬不变量）——选了"禁止 + 提示"而不是"第二栏只读降级"，理由：降级只读仍要处理"两栏各一份 EditorState、保存一次两边都要清脏"的半同步语义，属于 Phase 3 的活；禁止则一行守卫即可，且不会给用户一个"看起来能编辑其实是只读"的陷阱。
6. **`C5` 的"只读三目拆成显式函数"没做**：`switchTab` 里 `tab.kind === 'viewer-lg' ? !tab.editing : !!tab.readOnly` 仍是原来那一行（语义未变，只是加了注释）。

### 12.6 `preview.js` 的必要改动（**超出任务书列的允许文件清单，规格要求**）

0.5.0 §Phase 2 明确要求「`#image-host`/`#diff-host`/`#viewer-bar`/**`#preview-host`** 按 pane 生成」，
而 `preview.js` 原本在模块创建时用 `$('#preview-host')` 等**硬取全窗口唯一 ID** —— 不注入上下文就
无法做到"栏内预览模式按栏独立"（0.3.0 §4-E5 的 P0）。改动**只有 4 处、全部是可选注入 + 旧路径兜底**：

| 位置 | 改动 | 不传 opt 时的行为 |
|---|---|---|
| `createPreview(getEditor, getTab, getIsDark, opt)` 签名 | 追加可选第 4 参 `{ paneId, els(), getView }` | 与改前逐位一致 |
| `previewHost`/`contentEl`/`editorHost`/`divider`/`zoomBadge` 五处取值 | `(E && E.x) || $('#x')` | 走 `$('#x')` 兜底 |
| `applyMode()` 里 `imageHost`/`diffHostEl`/`viewerBar` 三处 | `(E && E.x) || $('#x')` | 同上 |
| 滚动同步 `getEditor().getView()` | `viewOf()`（注入则用该栏 view） | 同上 |

`mode` / `previewZoom` / `scrollSync` / `renderCount` 本来就是 `createPreview` 的**实例闭包变量**，
因此"每栏一个实例"（`app.js` 用 `WeakMap<pane.root, preview>`）就自动得到**按栏独立的预览模式**，
没有改任何既有语义。

### 12.7 冒烟新增 7 项（Phase 2 验收）

`scripts/smoke.js` 中新增一段（位于 `mw*` 多窗口段之后、`rcDir*` 段之前，理由：`rcDir*` 会断言
`.tab` 总数并起子进程，必须看到干净的单栏窗口），用例名与规格完全一致：
`splitBasic`、`splitIndependentTabs`、`splitDragDrop`、`splitResize`、`splitFocusKeys`、
`splitCloseLast`、`splitSessionShape`。断言全部落在**渲染事实**（`#editor-panes` 的栏数 /
两栏各自 `.pane-tabs` 里的 `.tab` 名称与数量 / 两个 `.cm-editor` 的高度与显隐 / `.cm-scroller`
的 `scrollTop` 独立性 / `.active-pane` 类与 `document.activeElement` 所在栏 / 分隔条拖动后的
真实像素宽度）或**磁盘事实**（`window.api.getSettings()` 读回的 `lastSession`）上。
每条用例首尾都收尾（合栏 + `closeAll`），不把双栏状态留给后续用例。

### 12.8 ⚠️ 验证口径的例外（必须记录）

**本次施工的机器上 `npm run smoke` 无法跑完**：两次尝试（一次经 agent 命令通道前台跑、一次分离
进程 + 重定向日志）都在 boot 后停住 —— `electron` 进程存活且 `Responding=True`，但进程级 CPU
累计仅 ~5 秒、`%TEMP%\markhunter-test-smoke` 与 `.smoke-test` 数分钟零写入、stdout 只有
`[test-isolation] userData = …` 一行。父 agent 在同一棵树上以前台方式跑同一份代码 3 次全绿
（142s / 151s / 233s；另一次 9 分钟），因此**属于环境/焦点问题而不是代码问题**。

本次施工因此采用的替代口径（全部实测通过）：

| 口径 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | `bundle.js = 0.92 MB \| mermaid-chunk.js = 3.29 MB \| 合计 = 4.22 MB`（bundle 943.7 kb） |
| 纯 node 自检 | `node %TEMP%\mh-p2-selfcheck.mjs <repo>` | `SELFCHECK PASS failed=0`（18 条 docmodel 按栏契约 + 未声明标识符扫描 + 15 条接线点 grep 断言） |
| 冒烟语法 | `node --check scripts/smoke.js` | exit 0 |
| 静态用例计数 | `step(` = 163、`runCase(` = 6、`splitCase(` = **7** | 运行时预期 **192 + 7 = 199** |

**基线引用**：192 项基线取自父 agent 在本棵树上以前台方式跑出的完整绿日志
（`%TEMP%\mh-smoke-phase1.log`：192 行 / `| false` 0 / `SMOKE_OK` / exit 0）。
**Phase 2 的 `E2E_RESULTS` 计数（199）/ `| false` 0 / `SMOKE_OK` 由父 agent 复跑确认。**
