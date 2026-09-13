# 开发计划：多视图 Phase 3（同文件多视图 + 布局持久化）施工简报

> **本文性质**：**施工简报**（给下一个执行者照着做）。由 Phase 2 的施工 agent 在 **Phase 2 代码已落盘、等待验收冒烟** 的时点写成。
> **唯一允许的写入 = 本文**：写作期间未改任何 `src/**`、`scripts/**`、`AGENTS.md`、`CHANGELOG.md`、`package.json`，也未跑 `npm run build` / `npm run smoke`（树要冻着等验收）。
> **行号口径**：本文所有 `文件:行号` 都是**写作当次现场用 `Select-String` 实测**的，不是从既有计划文档抄的（本仓库行号漂移极严重，0.5.0 计划 §6 与 Phase 1 清单 §9.3 各有一张漂移对照表，都已再次失效）。
> **上位依据**：`docs/开发计划-多视图与体验流畅度-0.5.0.md` §Phase 3（`:85-93`）；
> `docs/开发计划-多视图与体验流畅度-0.3.0.md` §2.2/§2.3/§2.4/§2.5/§2.7（`:83-157`，**架构与广播设计未压缩，仍是实现依据**）；
> `docs/开发计划-多视图-Phase1-重构清单.md` §5.3（不能进 docmodel 的 8 类状态）、§12（Phase 2 施工回填）；
> `docs/开发计划-大文件秒开与秒搜-0.4.0.md` §6.2（`:121-128`，overlay 单例语义，**Phase 3 必须对齐**）。

---

## 0. 开工前必读：当前树的状态（写作当次实测）

| 文件 | 行数 | 与 Phase 3 的关系 |
|---|---|---|
| `src/renderer/tabs.js` | **2636** | 主战场：pane 模型、`EditorView` ×2、`updateListener`、保存、file-changed |
| `src/renderer/app.js` | **1285** | 会话持久化（`persistSession`/`restoreSession`）、每栏一个 preview 实例、键位 |
| `src/renderer/docmodel.js` | **228** | 文档注册表；Phase 3 的**广播与引用计数**要加在这一层 |
| `src/renderer/preview.js` | **506** | 已支持按栏实例（`opt` 注入，`:167-177`），Phase 3 基本不用动 |
| `src/renderer/find.js` | **257** | `:24-25` 只认 `getEditor().getView()`（= 焦点栏），Phase 3 不改 |
| `src/main/overlay-ipc.js` | **779** | 路径单例：`:155-158`（`handles`/`pathToId`/`locks`/`pending`）、`:320-330`（realpath 复用 + `ownedByOther`） |
| `scripts/smoke.js` | **4739** | 基线 **192**（Phase 1 后）；Phase 2 追加 7 项 `split*` ⇒ 期望 **199** |

**基线口径**：冒烟以末尾 `E2E_RESULTS` 计数为准 = **199**（192 + 7 个 `split*`）、`| false` = 0、`SMOKE_OK`；另跑 `node scripts/overlay-test.js`（纯 node，期望 `OVERLAY_PROBE 14/14 failed=0`）——它是**纯 node**，可以随手跑，不受"冒烟要前台"的限制。
**⚠️ 冒烟必须前台**：桌面被全屏游戏/独占全屏程序占住时窗口拿不到焦点，`rapidSaveEcho` 会卡死数分钟到永久（判据：`electron` 累计 CPU 只有个位数秒、`.smoke-test` 与隔离 profile 数分钟零写盘）。

---

## 1. 现状接口盘点（Phase 2 结束时 `docmodel.js` 的**真实** API）

`src/renderer/docmodel.js` 是**零依赖纯内存模块**（不碰 DOM、不碰 CM、不碰 IPC），这是它的立身之本，
Phase 3 加东西时**不要破坏这条**（否则 `docRegistryUnit` 类纯内存断言就没法写）。

### 1.1 已有 API（行号 = `docmodel.js` 实测）

| 层 | API | 行 | 语义要点 |
|---|---|---|---|
| 集合 | `list()` | `:134` | **返回内部数组本身**（不是副本）；`tabs.js:112` 的 `docs()` 就是它的别名 |
| | `count()` / `indexOf(doc)` | `:136` / `:138` | |
| | `byPath(p)` | `:140` | ≡ 旧 `tabs.find(t => t.path === p)`，**只返回第一个** |
| | `byDiffKey(k)` | `:142` | 对比标签去重（窗口级临时视图，**Phase 3 保持全局唯一**） |
| | `add(doc)` / `remove(doc)` / `replaceAll(arr)` | `:144` / `:146` / `:157` | `remove` 会同时清 `docPane` 与该栏活动指针 |
| 活动指针 | `active()` | `:161` | ≡ **焦点栏**的活动文档 |
| | `setActive(doc)` | `:163` | 写进 doc **自己所属**的栏（未归属 → 焦点栏） |
| | `isActive(doc)` | `:171` | ≡ doc 是**它自己那一栏**的活动文档 |
| 栏归属 | `paneOf(doc)` / `setPaneOf(doc,paneId)` | `:179` / `:181` | **Phase 3 的"一文档一栏"就是这张 `docPane` Map** |
| | `docsOf(paneId)` / `countIn(paneId)` | `:188` / `:190` | |
| | `activeOf(paneId)` / `setActiveOf(paneId,doc)` | `:192` / `:194` | |
| | `focusPane()` / `setFocusPane(paneId)` | `:202` / `:204` | 只改指针，**不碰 DOM** |
| | `forgetPane(paneId)` | `:206` | 删该栏活动指针 + 该栏全部 `docPane` 登记 |
| 脏标记 | `markDirty(doc,v)` / `isDirty(doc)` / `listDirty()` | `:214` / `:216` / `:218` | huge 的**权威**脏值在主进程 overlay，这里只是镜像 |
| 视图归属 | `bindView(view,doc)` / `unbindView(view)` / `docOfView(view)` | `:222` / `:224` / `:226` | `docOfView` **未登记一律返回 null，绝不回退成"活动文档"** |

内部状态（`docmodel.js:118-129`）：`docs[]`、`paneActive: Map<paneId,Doc|null>`（`:125`）、`docPane: Map<Doc,paneId>`（`:127`）、`focusPaneId`（`:129`）、`viewDocs: WeakMap<view,Doc>`。

### 1.2 Phase 3 要加在哪一层（**结论先给**）

| 新能力 | 落点 | 理由 |
|---|---|---|
| **`Document.views`（引用计数）** | **`docmodel.js`**（`docViews: Map<Doc, Set<view>>` 或 `WeakMap` 反向表） | 是**文档级**事实，且必须能被纯内存断言；`bindView`/`unbindView` 已经是它的天然入口（`:222`/`:224`） |
| **内容广播 / 串行队列 / `remoteAnnotation`** | **`docmodel.js`** 提供 `applyLocal(doc, tr, view)` / `applyRemote(doc, changes, fromView)` / 队列；**事务的实际 `dispatch` 留在 `tabs.js`** | docmodel 不能 import `@codemirror/*`（零依赖约束）。折中：docmodel 只持**队列与版本号**，派发用**注入的派发器**（`createDocRegistry({ dispatchTo })`）或由 `tabs.js` 在自己的循环里读 `registry.viewsOf(doc)` 逐个 dispatch |
| **`getSession()` 的 `layout` 字段** | **`tabs.js`**（`getSession():2248`）+ **`app.js`**（`persistSession():347` / `restoreSession():364`） | 会话快照一直是编排层的事；docmodel 只提供 `serialize()` 所需的原始事实（哪栏、哪文档、活动项、pin） |
| **`file-changed` 广播到全部视图** | **`tabs.js`**（`:2414` 的 handler + `reloadFromDisk():2503`） | IPC 副作用必须留在编排层 |
| **`saveNow` 写一次盘、全部视图同清脏** | **`tabs.js`**（`doSaveNow():2024`） | 写盘牵涉分段补齐与 huge overlay，Phase 1 清单 §5.1 已定"写盘不进 registry" |

> **一句话**：**docmodel 长"事实与队列"，tabs.js 长"DOM 与 IPC"**。

### 1.3 **绝不能**进 `docmodel.js` 的状态（沿用 Phase 1 清单 §5.3 的 8 类，逐条对应 Phase 2 现状）

| # | 不能进的状态 | Phase 2 之后的实际位置 | 为什么 |
|---|---|---|---|
| 1 | `EditorView` 实例 | `tabs.js:384`（`createPane` 内 `new EditorView`，每栏一个） | 与 DOM 强绑定（`parent: pane.host`）；一个视图一份 |
| 2 | `#editor-host`/`#image-host`/`#diff-host`/`#viewer-bar`/`#preview-host`/`.pane-divider` 等 DOM | `tabs.js:319 buildPaneDom()` 生成；p0 挂历史 ID（`:350-362`） | 按 pane 复制的 DOM 引用 |
| 3 | `hugeview` 的 DOM 与实例（`tab.huge`/`tab.hugeEl`） | `tabs.js:909 mountHuge()` / `:950 setHugeVisible()`（`hugeTopLine:939`） | DOM 生命周期归视图；**overlay 文档（路径单例）才是文档级** |
| 4 | 4 个 `Compartment` | `tabs.js:126-129` | 被 `EditorState` 持有，多视图后要**逐 view** reconfigure（Phase 2 已在 `setWordWrap:2106`/`setIndentSize:2117` 遍历 panes 做） |
| 5 | `saveQueue` | `tabs.js:2005` `let saveQueue = Promise.resolve();`（成因注释 `:2002-2004`） | **应用级**串行链；进 registry 会变成"每文档一条队列"的语义漂移（Phase 3 若要按文档分队列，**必须重新论证截断竞态**，见 §7-R2） |
| 6 | `tab.scrollTop` / `hugeTopLine` / `hugeHidden` / `imgDrag` / `previewScrollTop` | `tabs.js:1479-1493`、`:939-975`、`:2398`、`app.js:196-197` | 纯视图级位置 |
| 7 | `document.hasFocus()` 守卫 | `app.js:348` | 窗口级，与文档无关（Phase 3 只允许**加** `force`，见 §5.1） |
| 8 | `markSelfWrite` / `watchFile` 调用点 | `tabs.js:382`（普通）/`:806`（chunked，见 `openChunkedTab`）/`:409`（huge）/`closeTab` 内 `unwatchFile` | IPC 副作用必须留在编排层，registry 要能纯内存单测 |

**第 9 条（Phase 2 新增，务必补进清单）**：**preview 实例**（`app.js:253` 的 `WeakMap<pane.root, preview>`）。
它是"每栏一套 mode/缩放/滚动同步"的持有者，属**视图级**，绝不能进 docmodel。

---

## 2. Phase 3 的目标与非目标（0.5.0 §3 Phase 3 的可执行化）

### 2.1 目标（G2 + G3 + G4）

| # | 目标 | 判据 |
|---|---|---|
| G2 | 同一文件在两个栏各开一个视图，**内容实时一致**，光标/滚动/折叠互不干扰 | `sameFileTwoPanes`、`sameFileEditSync` |
| G3 | **视图级关闭**：关一个视图不落盘不提示；关**最后一个视图**才走「未保存确认 → 保存/丢弃」 | `sameFileCloseOne` |
| G4 | 布局持久化：重启恢复「哪些栏、每栏哪些文件、活动项、比例、焦点栏」，旧会话格式自动兼容 | `layoutPersist`、`layoutBackCompat` |
| — | 外部修改广播到**全部**视图 | `multiViewExternalChange` |
| — | 撤销按栏独立的语义**记录并断言**（不修） | `sameFileUndo` |

### 2.2 非目标（照抄 0.5.0 §1.2，防止范围蔓延）

- **不做** CRDT / OT 实时协同；**不做** >2 栏、**不做**上下分屏。
- **不做**跨窗口「接管编辑」（那是 **Phase 4**：锁表、`doc:claim-edit`、`file-lock-changed`、只读横幅）。
- **不做**体验 11 条（快速打开/大纲/快捷键面板/字号设置…，那是 **Phase 5a**）。
- **不做**标签拖拽排序（A4，0.5.1+）；**不做**链接滚动（P2 后置）。
- **不重写**预览渲染栈。

---

## 3. 变更广播的具体设计（**本文最关键的一节**）

### 3.1 三层职责（0.3.0 §2.2/§2.3 的可执行版）

```
Document（= 现有的 tab 对象，同一引用，字段名不改）
  · 内容真源：doc.state（**基线**，任何时刻都是所有视图的超集）
  · doc.version（单调递增，Phase 2 没有，Phase 3 新增）
  · doc.views：Set<EditorView>（引用计数，bootstrap 时来自 registry）
Pane（= tabs.js 的 pane 对象）
  · pane.view：独立 EditorView，各自 hold **独立 EditorState**（光标/选区/折叠天然独立）
View
  · 同文档的每个视图通过「广播」保持**内容一致**，但 state 对象**永远不共享**
```

**核心不变量（写进代码注释 + 断言）**：
1. 任一时刻**只有一个视图在产生用户输入**（多视图是同一用户串行操作，天然成立）；
2. `doc.state` 是所有视图的**基线**：追平用它，写盘也用它（`doSaveNow:2068` 读的就是 `t.state.doc.toString()`）；
3. 广播失败（视图已销毁 / 已切走）**静默跳过**，不抛。

### 3.2 与 Phase 2 的 `updateListener` 如何共存（**改动最少的口径**）

Phase 2 现状（`tabs.js:291-310`，原文摘录）：

```js
EditorView.updateListener.of((u) => {
  const t = registry.docOfView(u.view);          // :297  ← C1 的根治点
  const fromOwnView = !!t;
  if (u.docChanged && t) {
    try {
      registry.markDirty(t);                     // :301
      t.state = u.state;                         // :302  ← Phase 3 在这里分叉
      updateTabBadges(); updateStatusBar(); onDocChanged(t);
    } catch (err) { ... }
  }
  if (u.selectionSet && fromOwnView && t && !t.kind) updateStatusBar();  // :307
}),
```

**Phase 3 的改法（伪代码，尽量只动这一处 + 加一个 helper）**：

```js
// ── 新增：远端注解（防环的唯一凭据）─────────────────────────────────────────
// 放在 tabs.js 顶层（与 matchEffect 同级，:71 附近），不进 docmodel（它是 CM 对象）
const remoteAnnotation = Annotation.define();       // 需在 :3 的 import 里加 Annotation

// ── 新增：按 Document 串行的广播队列（docmodel 只存队列，派发留在这里）────
// key = doc；value = Promise（链尾）。空闲时删键，防 map 只增不减（对齐 overlay-ipc:157 的做法）
const bcastQueue = new Map();
function enqueueBroadcast(doc, fn) {
  const prev = bcastQueue.get(doc) || Promise.resolve();
  const next = prev.then(fn, fn);                   // 失败不打断链
  bcastQueue.set(doc, next);
  next.finally(() => { if (bcastQueue.get(doc) === next) bcastQueue.delete(doc); });
  return next;
}

// ── updateListener 改成分叉（只改 :301-303 三行）────────────────────────────
if (u.docChanged && t) {
  registry.markDirty(t);
  if (u.transactions.some((tr) => tr.annotation(remoteAnnotation))) {
    // ① 远端变更：**不回播**。只把内容基线推进一步，不触发自动保存的"用户输入"语义
    t.state = u.state;
    registerRemoteVersion(t, u.transactions);       // §3.3 追平用
  } else {
    // ② 本地用户输入：先提交基线，再广播给同文档的**其它**视图
    const changes = u.transactions.map((tr) => tr.changes);   // 事务级 ChangeSet 列表
    t.state = u.state;
    enqueueBroadcast(t, () => {
      for (const other of registry.viewsOf(t)) {
        if (other === u.view || other.isDestroyed) continue;
        // 落后视图先追平（§3.3），再派发本次增量
        applyToView(other, changes, t);
      }
    });
  }
  updateTabBadges(); updateStatusBar(); onDocChanged(t);
}
```

**关键点（照做即可）**：

1. **必须用 `u.transactions`（数组）而不是 `u.changes`（`ChangeSet`）来广播**：`tr.changes` 是相对**该事务之前的文档**的坐标；把 `tr.changes` 直接喂给"落后 N 个事务"的视图会错位。正确做法是逐事务 `other.dispatch({ changes: tr.changes, annotations: remoteAnnotation })` **按顺序**派发。
2. **`remoteAnnotation` 必须挂在派发上**（`annotations: remoteAnnotation.of(true)`），接收方的 `updateListener` 才能识别"这是远端来的，别再回播"。
3. **接收方也要放进 `Transaction.addToHistory`**（保持 CM 默认）：这样"撤销可能撤掉对方刚输入的内容"就是**当前语义**，`sameFileUndo` 要断言的正是它（§6.3）。
4. **`onDocChanged(t)` 在远端分支也要调**（它负责自动保存防抖 + 该栏预览刷新）。但注意：远端派发**不应**把"自动保存"当成用户输入触发——**口径决定**：保持调用（多视图下"任一侧改了就整篇脏"，与 0.3.0 §2.4「脏标记 / 保存以 Document 为单位」一致）。**若实测出现"两栏互刷导致保存抖动"，再给远端分支加 `if (!remote) clearTimeout(tab.saveTimer)` 的节流**，但先按"照常调"实现并写注释。
5. **`registry.viewsOf(doc)` 是 Phase 3 新加的唯一 docmodel API**（见 §3.4）。

### 3.3 落后视图的追平（`ChangeSet.compose`）

场景：A 栏连打 5 个字符（5 个事务），广播队列里排队；此时 B 栏刚被 `setState` 重建（它落后了）。
朴素做法"逐个事务 dispatch"已经正确（CM 会按顺序应用），**但有个前提**：接收视图的文档长度必须与
"该事务产生时的基线"一致。若不一致（例如 B 栏刚从磁盘重载过、或 B 栏是被新开出来的第三视图），
就需要**先追平再增量**：

```js
/** 新视图加入时：直接用 Document 基线 setState（O(1)，无需 compose） */
function attachView(doc, view) {
  view.setState(makeStateFor(view, doc));    // 复用 tabs.js 的 makeState + 各 compartment
  registry.bindView(view, doc);              // ← 已存在（:1498）
}

/** 已存在但落后的视图：用 ChangeSet.compose 把 [它已知的版本, 当前版本) 合成一个 ChangeSet 再派发 */
function catchUp(doc, view) {
  const seen = viewVersion.get(view) || 0;
  if (seen >= doc.version) return null;
  const composed = doc.history.slice(seen).reduce((acc, cs) => acc.compose(cs), ChangeSet.empty(doc.state.doc.length));
  return composed;
}
```

> **落地建议（省事且够用）**：Phase 3 **只做"新视图用基线 `setState` + 已挂载视图按事务顺序派发"**，
> **不做**通用 `compose` 追平。理由：Phase 3 的视图集合是"2 栏各自的活动文档"，视图一旦挂载就一直
> 在 `updateListener` 的有效覆盖下（不掉队）；真正需要 `compose` 的是"视图被隐藏/未挂载"的场景，
> 而 Phase 2 的实现里**每栏的 view 恒存在**（`createPane:383`），没有"未挂载视图"这个状态。
> **把 `compose` 追平作为 Phase 3 的"如果实测露馅再加"的备选**，并在代码注释里写清这个判断。

### 3.4 docmodel 需要新增的 API（Phase 3 最小面）

```js
// docmodel.js —— 与现有风格一致：不 import 任何渲染模块，纯内存 + 纯函数
/** 该文档的**全部**视图（Phase 2 恒为 0/1 个；Phase 3 可达 2 个） */
viewsOf: (doc) => Array.from(viewSet.get(doc) || []),
/** 视图计数（关闭语义 G3 的判据） */
viewCount: (doc) => (viewSet.get(doc) || new Set()).size,
/** 文档是否仍被任何视图承载（false = 可以进关闭流程） */
hasViews: (doc) => (viewSet.get(doc) || new Set()).size > 0,
```

并把 `bindView` / `unbindView`（`:222` / `:224`）**同时维护** `viewDocs`（反向）与 `viewSet`（正向）：

```js
bindView: (view, doc) => {
  if (!view) return;
  const prev = viewDocs.get(view);
  if (prev && prev !== doc) { const s = viewSet.get(prev); if (s) s.delete(view); }  // 换文档：先摘旧登记
  viewDocs.set(view, doc);
  if (doc) { if (!viewSet.has(doc)) viewSet.set(doc, new Set()); viewSet.get(doc).add(view); }
},
unbindView: (view) => {
  if (!view) return;
  const doc = viewDocs.get(view);
  if (doc) { const s = viewSet.get(doc); if (s) { s.delete(view); if (!s.size) viewSet.delete(doc); } }
  viewDocs.delete(view);
},
```

**为什么必须让 `bindView` 摘旧登记**：Phase 2 的 `switchTab:1498` 是"同一 view 换绑不同文档"（切标签），
如果不摘，`docViews` 里会残留"该 view 仍属于旧文档"，引用计数永远归不了零 → **关最后一个视图的确认框永远不弹**（数据丢失面的 bug）。

### 3.5 还需要改的视图级操作（C4/C5 的 Phase 3 版）

| 位置 | Phase 2 现状 | Phase 3 要改成 |
|---|---|---|
| `setWordWrap:2106` / `setIndentSize:2117` | 遍历 **panes** 的**活动文档**逐 view reconfigure | 遍历 `registry.viewsOf(doc)`（同一文档可能有 2 个 view；两栏的活动文档不同也要各自生效）→ 实际做法：**遍历所有 pane 的所有非 kind 文档视图** |
| `setTabReadOnly:1826` | 只对"该文档所属栏的视图"dispatch | 对 `viewsOf(doc)` 逐个 dispatch（只读是**文档级**决定） |
| `reloadFromDisk:2503` | 按"它自己那一栏的活动标签"判 dispatch vs 建 state | **广播到全部视图**：活动视图 dispatch、非活动视图 `makeState` 重建（或统一走广播队列） |
| `appendChunkText:1359` | `isActive ? vw.state : tab.state` 二选一 | 上移到 Document：**对每个视图各派发一次**（0.3.0 §2.3 已定调）；`CHUNK_MARKER_RE` 剥离仍只在保存路径做一次 |
| `doSaveNow:2024` | 写一次盘后 `registry.markDirty(t,false)` | 语义已满足"写一次盘、所有视图同步"（脏是文档级），**只需补：保存后若另一视图非活动，重建其 state**（否则它下次切回来会拿旧 state） |

---

## 4. `tabs.find(path)` 6 处的改动面 + `file-changed`

### 4.1 现状：6 处查找点（**Phase 2 实测行号**）

| # | 行 | 调用 | Phase 3 的处置 |
|---|---|---|---|
| 1 | `tabs.js:792` | `openFile` 去重 `registry.byPath(path)` | **改语义**：默认仍"激活已有视图"，但 `opts.forceNew` / "在另一栏打开"（右键菜单项）时**允许同文件第二个视图**（0.3.0 §2.7 已锁定这个兼容口径） |
| 2 | `tabs.js:1449` | `openImageTab` 去重 | 图片是**文档级不广播**类（无 CM 文档），保持"第一个匹配"即可；但 `openFile` 的栏守卫要跟着放开 |
| 3 | `tabs.js:2171` | `openDiffTab` 的 `registry.byDiffKey(key)` | **不动**：对比标签是窗口级临时视图，保持全局唯一 |
| 4 | `tabs.js:2262` | `activateByPath`（**死导出**，外部 0 调用） | 保持签名，语义随 `byPath` 走 |
| 5 | `tabs.js:2303` | `findTabByPath`（外部 **46 处**调用，冒烟 40 处） | **语义一个字都不能改**：恒返回"第一个匹配"。Phase 3 新增 `findTabsByPath(p)`（复数）给需要"全部视图"的内部路径用 |
| 6 | `tabs.js:2417` | `file-changed` 过滤 `docs().find(...)` | **必须改成全部**（见 §4.3） |

### 4.2 "单文档单栏"硬不变量在哪几行、Phase 3 放开成什么

**不变量本体 = 两处**：

- **入口守卫**：`tabs.js:791-801`（`openFile` 顶部）
  ```js
  const existing = registry.byPath(path);              // :792
  if (existing) {
    const home = paneOfDoc(existing);                  // :794
    if (registry.focusPane() !== home.id) {
      setFocusPane(home.id, { notify: false });        // :796
      if (!opts.silent) toast(`「${existing.name}」已在另一栏打开，已切换到那一栏…`);  // :797
    }
    switchTab(existing); return existing;              // :799-800
  }
  ```
- **归属唯一性**：`registry.setPaneOf(doc, paneId)`（`docmodel.js:181`）是 `Map<Doc,paneId>`，**一个 doc 只能属于一个 pane**；
  6 处 `registry.setPaneOf(tab, registry.focusPane())` 是新建标签时的落栏点：`tabs.js:871`（普通）/`:898`（huge）/
  `:1023`（viewer-lg）/`:1307`（chunked）/`:1468`（image）/`:2201`（diff）。

**Phase 3 要放开成什么**（推荐口径，**按这个做**）：

1. 把 `docPane: Map<Doc,paneId>` 换成 **`docPanes: Map<Doc, Set<paneId>>`**（一个文档可在多个栏出现），
   保留旧 API 的**单值语义**：`paneOf(doc)` 返回"焦点栏（若该 doc 在其中）否则集合里第一个"——这样 Phase 1/2 的 30+ 个调用点**不用逐个改**。
2. `openFile` 顶部守卫改成：
   ```js
   const existing = registry.byPath(path);
   if (existing) {
     const panesOfDoc = registry.panesOf(existing);           // 新 API
     if (opts.forceNew || opts.otherPane || !panesOfDoc.includes(focusPaneId)) {
       // 同文件第二个视图：本栏新开一个视图（**同一 Document**，各自独立 EditorState）
       return attachNewView(existing, focusedPane());
     }
     switchTab(existing);                                     // 本栏已有 → 旧行为
     return existing;
   }
   ```
3. **标签栏语义**：一个文档在两个栏出现 → 每栏的标签栏各有一条 `.tab`（`renderPaneTabs:1893` 已经按
   `registry.docsOf(pane.id)` 过滤，**改成 `docsOf` 用新的多栏集过滤即可**，DOM 层不用动）。
4. **`pane.tabBadges`**（`:380`）是 `Map<tab, el>`，**一栏一份**（每 pane 各一个 Map）→ 天然支持"同一 tab 对象在两栏各有一条 DOM"，无需改。

### 4.3 `file-changed` 的改动面

现状（`tabs.js:2414-2417`）：

```js
window.api.onFileChanged(async ({ path: changedPath }) => {
  const tab = docs().find((t) => t.path === changedPath && (!t.kind || t.kind === 'chunked' || t.kind === 'viewer-lg' || t.kind === 'huge'));
  if (!tab) return;
  ...
```

**Phase 3 口径**：`docs().find(...)` → `docs().filter(...)` ⇒ `targets: Doc[]`，然后：

- **自写回声守卫**（`:2420` 的 `tab.lastSavedAt` 1200ms、`:2430` 的 huge 3s）是**文档级**的，
  提到循环外对 `targets[0]` 判一次即可（同一 path 只有一个 Document，所有视图共享 `lastSavedAt`）。
- **确认框只弹一次**（`tab.dirty` 判一次），用户确认后**对全部视图**执行。
- `reloadFromDisk(tab, silent)`（`:2503`）内部已经按"该文档所属栏"取 view；Phase 3 改成
  **先对所有视图处理，再统一 `markDirty(false)`**：
  ```js
  for (const v of registry.viewsOf(doc)) {
    if (v === activeViewOfAnyPane(doc)) v.dispatch({ changes: {...}, annotations: [noHistory] });
    else rebuildStateFor(v, doc);            // 非活动视图重建 state（复用 makeState）
  }
  ```
- **huge 标签**：Phase 2 起 `openHugeTab:882` 已经 `watchFile`（`:409` 附近的调用），过滤条件 `:2417` 也含 `'huge'`。
  **Phase 3 的边界**：huge 的"内容"是 overlay 文档（路径单例，见 §7-R1），**不做内容广播**；
  多视图下只允许"一个 huge 视图 + 另一个普通视图"这种组合，**两个 huge 视图看同一文件**在本阶段**明确禁止**
  （overlay 是路径单例 + 每窗口一个 owner，见 §7-R1）。

---

## 5. 布局持久化（G4）

### 5.1 `persistSession` 的焦点守卫：**守卫本身不得动**

现状（`app.js:347-360`）：

```js
function persistSession(force = false) {
  if (!document.hasFocus()) return;                       // :348  ← **不许动**
  if (!force) { clearTimeout(sessionTimer); sessionTimer = setTimeout(() => persistSession(true), 600); return; }
  const s = editor.getSession();                          // :354
  if (!s.paths.length) window.api.setSettings({ lastSession: null });                       // :356
  else window.api.setSettings({ lastSession: { paths: s.paths, active: s.active, pinned: s.pinned } });  // :358
}
```

**为什么不能动**：`sessionRestore` / `pinSessionPersist` / `extSessionRestore` 三项冒烟用例依赖它 ——
后台窗口不能覆盖前台窗口的会话（多窗口语义 v0.2.1 的既定行为）。

**Phase 3 的做法**（只有两条）：

1. **加 `force` 的语义**：当前 `force=true` 仍然被 `:348` 的守卫拦下（`persistSession(true)` 也过不去）。
   新增一个**独立的** `persistSessionFinal()`：**先**判 `document.hasFocus()`，不满足时**只跳过"防抖合流"、不跳过写盘**？
   ——不行，那等于动守卫。**正确做法**：把守卫改成只拦"非最终写"：
   ```js
   function persistSession(force = false, opts = {}) {
     // opts.final = 关窗/卸载路径专用：**唯一**允许在无焦点时写盘的入口（守卫语义本身不变）
     if (!document.hasFocus() && !opts.final) return;
     ...
   }
   ```
   **必须在代码注释里写清**：`opts.final` 只允许 `beforeunload` 调用；`window.__app.session.save()`
   （`app.js:1281`）仍走 `persistSession(true)`（**不加 final**），否则会话类用例的口径就变了。
2. **新增卸载钩子**（当前 `app.js` **没有任何 `beforeunload` 监听**，`main.js` 只有 `window-all-closed:188`）：
   ```js
   window.addEventListener('beforeunload', () => {
     try { persistSession(true, { final: true }); } catch { /* 关窗不因会话失败中断 */ }
   });
   ```
   注意 `setSettings` 是**异步 IPC**，`beforeunload` 里不保证送达 —— **若实测丢失，改为 `main.js:188`
   的 `window-all-closed` 前由主进程发一条同步询问**（但那就改了主进程，**优先试渲染端方案**）。

### 5.2 `layout` 新格式（照抄 0.3.0 §2.5，**逐字段落地**）

```json
{
  "lastSession": {
    "paths": ["F:/a.md","F:/b.txt"],            // ← 保留（向后兼容：不认 layout 的旧版本仍能读）
    "active": 0,                                 // ← 保留：焦点栏活动文档在 paths 里的下标
    "pinned": [0],                               // ← 保留
    "layout": {
      "orientation": "h",
      "sizes": [0.5, 0.5],
      "focus": 0,
      "panes": [
        { "docs": ["F:/a.md","F:/b.txt"], "active": 0, "pinned": [0] },
        { "docs": ["F:/a.md"],            "active": 0, "pinned": [] }
      ]
    }
  }
}
```

**硬约束**：

1. **`paths`/`active`/`pinned` 三键一个都不能删**（旧版本读得懂；且 `sameFileTwoPanes` 之外的
   既有 3 项会话用例断言的就是这三键）。`layout.panes[].docs` 是**去重后的文档路径**，
   `paths` 是**去重后的全部路径**（同一文件只出现一次，因为它是**文档**列表）。
2. **去重存储**：`layout.panes[].docs` 里同一路径可在多个 pane 出现（这正是多视图的意义），
   但 `paths` 只出现一次。
3. **上限**：总视图数 ≤ **240** 且每栏 ≤ **200**（0.3.0 §2.5）。**注意口径变了**：
   当前 `restoreSession` 是 `ls.paths.slice(0, 200)`（`app.js:368`）——Phase 3 要按"视图数"算，
   即把 `layout.panes[].docs` 的**总条数**截到 240、单栏截到 200，再回填 `paths`。
4. **比例**：`sizes` 是归一化比例 `[0.5,0.5]`，落点 = Phase 2 的 `paneRatio`（`tabs.js:135`），
   需要新增 `editor.getPaneSizes()` / `editor.setPaneSizes([a,b])`（后者内部走 `layoutPanes():562`）。

### 5.3 `restoreSession` 的改动（`app.js:364-404`）

现状流程：并发池 6（`:370-381`）打开 `paths` → `reorderTabs(paths)`（`:384`）→ 激活 `active`（`:385-392`）→ 还 pinned（`:394-401`）。

**Phase 3 流程（顺序不能变，理由在括号里）**：

1. 读 `ls.layout`；**无 `layout`** → 把 `{paths,active,pinned}` **映射成单栏**（`panes:[{docs:paths,active,pinned}]`）。
   （这是 `layoutBackCompat` 的核心；映射必须与"旧版本写出来的会话"逐位一致，否则老用户会话顺序会乱。）
2. **目录恢复完成之后**（`app.js:1220` 附近的 boot 顺序，必须先目录后标签 —— 树的定位依赖 rootDir）。
3. **逐栏并行打开**：外层按 pane、内层用现有的并发池 6（**保持 `CONCURRENCY = 6` 不变**，
   主进程 IPC 压力已在 v0.4.0 标定过）。
4. **恢复时复用同一 Document**：同一路径在多个 pane 的 `docs` 里第二次出现时，**不能再走 `openFile` 的
   "已存在 → 切栏"分支**，而是"拿到已有 Document 的引用 + 在该 pane 新建一个视图"：
   ```js
   const doc = editor.findTabByPath(p);        // ≡ registry.byPath
   if (doc) editor.attachViewToPane(doc, paneIdx);   // 新 API：只建视图，不读盘
   else await editor.openFile(p, { silent: true, pane: paneIdx });
   ```
   **读盘必须只发生一次**（否则大文件会读两遍；`chunked` 更会建两份 `chunk` 状态，保存时互相截断）。
5. **应用比例**（`setPaneSizes`）→ **应用焦点**（`focus` 下标 → `focusPaneIndex`）→ 最后激活各栏 `active`。
6. **降级**：`layout.panes` 多于 2 栏 / `sizes` 长度不匹配 / 单栏 `docs` 全打不开 → **回落单栏**并 `console.warn`，
   不抛错、不弹框（延续 L6 的静默口径）。

### 5.4 `getSession()` 的改动（`tabs.js:2248`）

```js
function getSession() {
  const persist = docs().filter((t) => !!t.path);
  const activePersisted = persist.indexOf(registry.active());
  return {
    paths: persist.map((t) => t.path),                       // 文档级：去重（docs() 本来就是一文档一条）
    active: activePersisted,                                  // 焦点栏活动文档的下标
    pinned: persist.map((t, i) => (t.pinned ? i : -1)).filter((i) => i >= 0),
    layout: {                                                 // ← 新增
      orientation: 'h',
      sizes: [paneRatio, 1 - paneRatio],
      focus: panes.findIndex((p) => p.id === registry.focusPane()),
      panes: panes.map((p) => ({
        docs: registry.docsOf(p.id).filter((d) => !!d.path).map((d) => d.path),
        active: registry.docsOf(p.id).filter((d) => !!d.path).indexOf(registry.activeOf(p.id)),
        pinned: registry.docsOf(p.id).filter((d) => !!d.path).map((d, i) => (d.pinned ? i : -1)).filter((i) => i >= 0),
      })),
    },
  };
}
```
**注意**：`getSession()` 的**三键结构必须原样保留**（冒烟 5 处断言：`scripts/smoke.js:1097`、
`:1533`、`:2324`、`:2808`、`:3495`，以及 Phase 2 新增的 `:4131` 的 `splitSessionShape` ——
它**显式断言 `layout` 键尚不存在**，**Phase 3 必须同步改这条断言**，否则一定挂）。

---

## 6. 7 个验收用例的断言设计

> **统一构造**：在 `.smoke-test` 下建两个夹具 `same-a.md` / `same-b.md`（各 ~200 行，便于测独立滚动）；
> 所有断言落在**渲染事实**（`#editor-panes` 的栏数、两栏 `.pane-tabs` 的 `.tab` 名称、两个 `.cm-editor`
> 的 `textContent`/`scrollTop`/`getBoundingClientRect`）或**磁盘事实**（`window.api.getSettings().lastSession`、
> 直接 `fs.readFileSync` 夹具文件）上。每条用例**首尾都收尾**（合栏 + `closeAll`），不把双栏/双视图留给后续用例。
> 用法：Phase 2 已经在 `scripts/smoke.js:3800` 起建了一段 `{ ... }` 块与 `splitCase` 包装器（`:3882-4123`），
> **Phase 3 直接在同一段风格下追加 7 条即可**（或另起一段，但**必须排在 `rcDir*` 段之前**）。

### 6.1 `sameFileTwoPanes`（同文件两栏）

- **构造**：单栏开 `same-a.md` → `editor.toggleSplit()` → 在新栏用 **`openFile(path, { forceNew: true })`**
  （Phase 3 的新入口）打开**同一个** `same-a.md`。
- **断言**：
  1. `document.querySelectorAll('#editor-panes > .pane').length === 2`；
  2. **两个 `.cm-editor` 的 `textContent` 长度相等且都 > 0**（同一份内容渲染了两遍）；
  3. `editor.getPaneLayout().panes[0].path === panes[1].path === same-a.md`；
  4. **两个视图对象不同**：`editor.getPaneEls(0).view !== editor.getPaneEls(1).view`；
  5. **独立滚动**：只滚左栏 `scrollDOM.scrollTop = 300`，右栏 `scrollTop` 仍为 0（±2px）；
  6. **独立光标**：左栏 `view.dispatch({ selection: { anchor: 100 } })` 后，右栏 `view.state.selection.main.head === 0`。
- **数值范围**：`.cm-editor` 高度 > 100px；两栏宽度各 ≥ 199px（沿用 Phase 2 `MIN_PANE_PX = 200` 的口径）。

### 6.2 `sameFileEditSync`（左改右看）

- **构造**：承接 `sameFileTwoPanes` 的两视图状态。
- **断言**：
  1. 在**左栏** `view.dispatch({ changes: { from: 0, insert: 'X' } })`；
  2. 等 150ms（广播是同步链 + 微任务，150ms 足够）后
     **右栏 `view.state.doc.toString()` 与左栏逐字符相等**，且**都以 `'X'` 开头**；
  3. **磁盘未变**：`fs.readFileSync(same-a.md)` 仍是原内容（没保存）；
  4. **标脏只标一次**：`editor.findTabByPath(p).dirty === true`，且**只有一个 Document**
     （`editor.getSession().paths.filter(x => x === p).length === 1` —— paths 去重口径）；
  5. **反向也通**：在右栏 `dispatch` 一次，左栏内容跟着变；
  6. **无回环**：连续 20 次左栏 dispatch 后，两栏 `doc.length` 差值为 0，且 `onDocChanged` 的调用计数
     （可临时挂一个计数器，或断言 `saveQueue` 只入队一次 —— 更稳的做法是断言 200ms 后
     `editor.getView()` 内容稳定、两栏长度一致且**没有抛错**）。
- **预期数值范围**：右栏与左栏 `doc.length` 差 `<= 0`（严格相等）；同步延迟 < 100ms。

### 6.3 `sameFileUndo`（**记录并断言当前语义**）

0.5.0 §Phase 3 的原文要求：「**记录并断言当前语义**：每栏独立撤销栈，可能撤掉对方刚输入的内容 —— 首次分屏给一次性提示」。

- **构造**：两栏同文件（同 6.1）。
- **要断言的**（全部是"当前语义"，不是"期望语义"）：
  1. **两栏各有自己的历史**：左栏输入 `A`、右栏输入 `B`（两栏内容经广播一致 = `…AB` 之类）；
     在左栏 `undo` → **右栏内容也回退**（因为 undo 在左栏产生了一个新的 change，会被广播过去）；
  2. **"可能撤掉对方刚输入的内容"**：左栏 undo **会**撤掉右栏刚输入的那一段 ——
     用例要**明确断言这一点成立**（在证据串里写出"undo 把对方的内容也撤了"），而不是断言它不成立；
  3. **一次性提示**：首次进入"同文件两栏"时弹出一次提示（toast 或状态栏文案），
     **文案需含"撤销按栏独立"**；第二次分屏**不再弹**。实现用一个模块级 `let sameFileHintShown = false`
     （`tabs.js` 的 pane 控制区）即可；断言 `window.__mhToastRec`（冒烟已有该记录器）只出现一次。
- **诚实标注**：若实现时发现 undo 语义与上面不符（例如 CM 对远端注解的事务默认不进历史），
  **以实测为准改断言并写进 CHANGELOG**，**不要**为迎合断言去改 CM 默认历史（0.3.0 §2.4 已判死刑：不做自研历史合并）。

### 6.4 `sameFileCloseOne`（关一个视图 ≠ 关文件）

- **构造**：两栏同文件，文件改脏（左栏输入几个字）。
- **断言**：
  1. 点**右栏**那条 `.tab` 的 `.tab-close` → **不弹确认框**（`#modal-mask` 保持 `hidden`）；
  2. 栏数回落到 **1**（`splitCloseLast` 的既有语义：关掉某栏最后一个标签 → 撤栏），
     且**左栏仍显示同一个文件**、`editor.findTabByPath(p)` **仍非 null**；
  3. **磁盘未写**：`fs.readFileSync` 仍是原内容（关一个视图**不落盘**）；
  4. `tab.dirty` **仍为 true**（脏是文档级，另一个视图还开着，不能清）；
  5. 再关**左栏**（最后一个视图）→ 此时**才**走未保存确认（`#modal-mask` 出现 / 或
     `confirmDialog` 的可观测代理）；确认"保存"后磁盘内容包含刚才输入的字。
- **数值范围**：栏数 2 → 1 → 0（关闭后 `getActiveTab() === null`，空态 `#editor-empty` 可见）。

### 6.5 `multiViewExternalChange`（外部修改广播到全部视图）

- **构造**：两栏同文件（都是**可见**视图）。用**主进程侧**（冒烟在 main 上下文里可直接 `fs.writeFileSync`）
  改写夹具文件，触发 `file-changed`。注意自写回声守卫：**不要**用渲染端的 `writeFile`，
  否则 `lastSavedAt` 的 1200ms 窗口会把事件吞掉 —— 用 `fs` 直写 + `await sleep(1500)` 跨过守卫。
- **断言**：
  1. **两个视图的内容都变了**（两栏 `doc.toString()` 都等于新内容）；
  2. 确认框**只弹一次**（`dirty` 时）：把文件改脏 → 外部改写 → 断言 `#modal-actions` 只出现一次、
     点"确定"后两栏都刷新；
  3. **只 emit 一次 toast**（`__mhToastRec` 里 `已从外部重新加载 …` 只出现一次）；
  4. `tab.dirty === false`（重载后清脏）。
- **`huge` 的边界**：若夹具是 huge 标签（需要 `setHugeThresholdMB` 临时降档，见 AGENTS.md 的警告），
  本用例**不覆盖**（Phase 3 明确不做 huge 内容广播，见 §4.3 与 §7-R3）。

### 6.6 `layoutPersist`（布局落盘 + 读回）

- **构造**：两栏（左 `same-a.md`、右 `same-b.md`），拖分隔条到约 **0.35/0.65**，焦点放右栏，
  用 `window.__app.session.save()` 强制落盘。
- **断言（**磁盘事实**）**：`window.api.getSettings().lastSession` 里有 `layout`：
  - `layout.panes.length === 2`；
  - `layout.panes[0].docs` 含 `same-a.md`、`layout.panes[1].docs` 含 `same-b.md`；
  - `layout.focus === 1`；
  - `layout.sizes[0]` 在 **0.30 ~ 0.42** 之间（拖拽有像素取整，别断言精确 0.35），
    且 `Math.abs(sizes[0] + sizes[1] - 1) < 0.01`；
  - **三键仍在**：`paths`/`active`/`pinned` 同时存在且 `paths` **去重**
    （`new Set(paths).size === paths.length`），且两栏的同名文件在 `paths` 里**只出现一次**。
- **不做**（本阶段）：不测"重启后恢复"（那需要再起进程，属 Phase 4 的多窗口基建；
  恢复逻辑用 `layoutBackCompat` + 直接调 `window.__app.session.restore()` 覆盖）。

### 6.7 `layoutBackCompat`（旧格式回落单栏）

- **构造**：`await window.api.setSettings({ lastSession: { paths: [a, b], active: 1, pinned: [0] } })`
  —— **不含 `layout`**（模拟老版本写出的会话）。先 `closeAll()` 清场，再
  `await window.__app.session.restore()`。
- **断言**：
  1. **栏数 = 1**（`#editor-panes > .pane` 长度 1、无 `.pane-divider`）；
  2. **标签栏顺序 = 会话顺序**：`editor.getSession().paths` 深等于 `[a, b]`；
  3. **活动项 = 下标 1**：`getActiveTab().path === b`；
  4. **pin 还原**：`editor.findTabByPath(a).pinned === true`；
  5. **不抛错**：恢复过程 `results` 无 `ERR`，且 `#modal-mask` 始终 `hidden`（静默口径）；
  6. **再存一次会写出 `layout`**（升级路径）：再 `session.save()` → 磁盘 `lastSession.layout.panes.length === 1`
     且 `paths` 与恢复前一致。
- **附加**（旧格式的脏数据）：`{ paths: [不存在的文件, b], active: 1, pinned: [] }` → 静默跳过缺失文件、
  只开 1 个标签、**不弹 alertBox**（与既有 `silentRestore` 用例同口径，见 `scripts/smoke.js:2191`）。

---

## 7. 风险与不做清单

### 7.1 风险（按危险度排序）

| # | 风险 | 证据 | 缓解 |
|---|---|---|---|
| **R1** | **overlay 单例与"同文件两视图"的语义冲突**（**最高危**） | `src/main/overlay-ipc.js:155-158`（`handles`/`pathToId`/`locks`/`pending`）、`:320-330`（同 realpath **复用同一句柄**，另一窗口按 `ownedByOther: true` 转只读）；`docs/开发计划-大文件秒开与秒搜-0.4.0.md:121-128` | **必须在开工第一步就把口径写死**：huge 的编辑会话是**路径单例**，渲染端只经 `huge:doc-*` 通道读写。**Phase 3 明确禁止"两个 huge 视图看同一文件"**（同一窗口内也是）：入口处判 `doc.kind === 'huge' && viewsOf(doc).length >= 1` → 拒绝并 toast「大文件视图不支持同文件多视图」。**这一条要在 `sameFileTwoPanes` 的用例里补一条负向断言**（huge 文件第二次 open 不产生第二个视图） |
| **R2** | `saveQueue` 是**全局**串行链（`tabs.js:2005`） | 注释（`:2002-2004`）自述「并发 saveNow 在大文件 `ensureFullyLoaded` 阶段交错是截断写盘的竞态源」 | **Phase 3 保持全局串行**。若要按文档分队列，必须先重新论证截断竞态（不建议在本阶段做） |
| **R3** | **隐藏视图仍持 `EditorState` → 内存 ×N** | 每栏一个 `EditorView`（`tabs.js:384`），各持一份 state；`chunked` 还有 `tab.chunk.decoder` | **硬上限 2 栏**（`tabs.js:131`，不许放宽）；**隐藏视图不参与装饰/测量**（Phase 2 已用 `display:none` + `requestMeasure` 处理，Phase 3 只需保证广播**不触发隐藏视图的测量**） |
| **R4** | **`chunked` 双视图的占位标记** | `appendChunkText:1359` 现在"只对活动视图 dispatch，非活动重建 state" | Phase 3 上移到文档级：**对每个视图各派发一次**，且 `CHUNK_MARKER_RE` 剥离**只在保存路径做一次**（`doSaveNow:2068` 与 `saveStreamed:2095` 的 `stripChunkMarkers` 调用点是**仅有的两条保存路径**，**不许动**） |
| **R5** | **`huge` 保存绝不能走整篇写盘** | `doSaveNow:2024-2053`（huge 分支；`:2030` 附近有"绝不能落到整篇写盘"的警告注释），`tab.state` 是空文档 | 多视图改造**不得**触碰 `doSaveNow` 的 huge 分支判定顺序 |
| **R6** | **`switchTab` 的 `bindView` 换绑会漏摘旧登记** | `tabs.js:1498`（同 view 换文档） | §3.4 的 `bindView` 必须先摘 `prev`，否则引用计数永远归不了零 → **关最后一个视图不弹确认框**（静默丢数据） |
| **R7** | **`getSession()` 三键结构被冒烟锁死** | `scripts/smoke.js:1097/1533/2324/2808/3495`，以及 Phase 2 新加的 `:4131`（`splitSessionShape` 断言 `layout` **不存在**） | Phase 3 落地时**必须同步改 `:4131` 那条断言**，并在 CHANGELOG 记录"会话 schema 扩展" |
| **R8** | `document.hasFocus()` 守卫 | `app.js:348` | 见 §5.1：只允许加 `opts.final`，且只有 `beforeunload` 用它；`window.__app.session.save()` 口径不变 |
| **R9** | 多视图下 `find.js` 只认焦点栏 | `find.js:24-25` | **本阶段接受**（"查找跟随焦点栏"是 Phase 2 已定的口径）。不做"跨视图查找结果聚合" |

### 7.2 明确**不做**（防止范围蔓延）

| 不做 | 归属 |
|---|---|
| 跨窗口「接管编辑」（锁表 / `doc:claim-edit` / `file-lock-changed` / 只读横幅） | **Phase 4** |
| 跨窗口「双可编辑 + 冲突合并」（L3） | 0.5.1+ 可选开关，默认关 |
| 体验 11 条（`Ctrl+P` 快速打开、大纲、快捷键面板、字号设置、侧栏折叠、右键补齐…） | **Phase 5a** |
| 标签拖拽排序（A4）、链接滚动、底部面板折叠（E1）、侧栏折叠（E2） | 0.5.1+ |
| `huge` 的同文件多视图 / huge 内查找 | 不在 0.5.0 范围（0.5.0 §6 待决项 1 倾向"明确提示 + 禁止"） |
| 自研撤销历史合并 | 0.3.0 §2.4 已判死刑（保持 CM 默认 + 一次性提示） |
| 重组 `saveQueue` 为按文档分队列 | 需先论证截断竞态（R2） |
| 上下分屏 / >2 栏 / 栏内嵌套分屏 | 0.5.0 §1.2 已拍板 |

---

## 8. 建议施工顺序（5 个切片，**每步都必须 `npm run build` + 前台 `npm run smoke`**）

| 步 | 内容 | 涉及 | 证明 |
|---|---|---|---|
| **P3-0** | **冻结口径**：把 R1（huge 禁止同文件多视图）、R7（会话 schema 扩展要点）、`saveQueue` 不动写进代码注释 | 纯注释 | 冒烟 199 全绿（行为中性） |
| **P3-1** | docmodel 加 `viewsOf/viewCount/hasViews` + `bindView` 摘旧登记 + 加 `paneActive` 的**多栏集**（`docPanes: Map<Doc,Set<paneId>>`，保留单值 `paneOf` 语义） | `docmodel.js` | 纯内存自检（参照 Phase 2 的 `%TEMP%\mh-p2-selfcheck.mjs` 手法：直接 `import` docmodel 断言引用计数增减）；冒烟 199 |
| **P3-2** | 变更广播：`remoteAnnotation` + `updateListener` 分叉（`tabs.js:291-310`）+ `enqueueBroadcast` + `registry.viewsOf` 逐视图派发 + `switchTab` 的 `attachView` 口径 | `tabs.js` | **新增 `sameFileTwoPanes` / `sameFileEditSync`（199 → 201）** |
| **P3-3** | 关闭语义 G3：`closeTab:1722` 的"最后一个视图"判定 + `sameFileUndo` 的一次性提示 | `tabs.js` | **新增 `sameFileUndo` / `sameFileCloseOne`（→ 203）** |
| **P3-4** | 外部修改广播（`file-changed:2414` → filter + 全部视图）+ 布局持久化（`getSession:2248` / `persistSession:347` / `restoreSession:364` / `beforeunload`） | `tabs.js` + `app.js` | **新增 `multiViewExternalChange` / `layoutPersist` / `layoutBackCompat`（→ 206）**；**同时改 `scripts/smoke.js:4131` 的 `layout` 不存在断言** |

**验收总口径**：`E2E_RESULTS` = **199 + 7 = 206**、`| false` = 0、`SMOKE_OK`；
`node scripts/overlay-test.js` = `OVERLAY_PROBE 14/14 failed=0`；`npm run build` 出 `合计 = 4.2x MB`。
**同一时刻只允许一条线构建/跑冒烟**；冒烟**必须前台且桌面不能被全屏游戏占住**。

---

## 9. 行号索引（写作当次实测，**施工时一律现场复核**）

```
tabs.js (2636 行)
  :110  const registry = createDocRegistry();
  :112  const docs = () => registry.list();
  :131  const MAX_PANES = 2;
  :135  let paneRatio = 0.5;
  :147/151/155  paneOfDoc / viewOfDoc / focusedView
  :291  EditorView.updateListener.of((u) => {      ← 广播的落点
  :297  const t = registry.docOfView(u.view);      ← C1 判据
  :301/302  markDirty(t) / t.state = u.state;
  :307  selectionSet 分支
  :319  buildPaneDom(first)   :350-362  p0 的历史 ID
  :368  createPane()          :384  new EditorView（每栏一个）
  :380  pane.tabBadges: new Map()（一栏一份）
  :540  setFocusPane   :562 layoutPanes   :585 initPaneDivider
  :624  createSidePane  :639 toggleSplit  :656 mergePanes  :692 removeEmptyPane
  :712  moveTabToSide   :726 moveTabToPane
  :791  openFile        :792 byPath  :793-801 单文档单栏守卫
  :871/898/1023/1307/1468/2201  registry.setPaneOf(tab, focusPane())
  :980  syncEditorLayer(pane, tab)   :950 setHugeVisible   :909 mountHuge
  :1359 appendChunkText  :1403 ensureFullyLoaded  :1423 reloadChunked
  :1476 switchTab        :1498 registry.bindView(pane.view, tab)   ← 引用计数的入口
  :1722 closeTab         :1760 registry.unbindView(pane.view)      ← G3 的落点
  :1826 setTabReadOnly   :1893 renderPaneTabs  :1967 renderTabsAll  :1980 updateTabBadges
  :2005 let saveQueue    :2009 saveNow  :2024 doSaveNow（:2028-2053 huge 分支，红线；:2068/:2095 stripChunkMarkers）
  :2106 setWordWrap  :2117 setIndentSize
  :2240 getActiveTab  :2248 getSession（三键 + 新增 layout）  :2272 getView
  :2262 activateByPath  :2302 findTabByPath  :2309 reorderTabs  :2325 closeByPath
  :2414 onFileChanged   :2417 docs().find(...)  ← 改成 filter
  :2503 reloadFromDisk
  :2565 return { ...API... }  :2568 toggleSplit  :2578 getPaneLayout  :2580 getPaneCount
  :2582 getPaneElsById  :2602 paneActiveOf

app.js (1285 行)
  :203  onTabSwitch(tab, focused)
  :253  const previews = new WeakMap()   :254 previewFor(paneId)
  :347  persistSession(force)   :348 if (!document.hasFocus()) return;   ← 不许动
  :354 getSession()  :356/:358 setSettings({ lastSession })
  :364  restoreSession()  :368 paths.slice(0,200)  :370 CONCURRENCY = 6
  :384 reorderTabs  :385 active  :394-401 pinned
  :1178 Ctrl+\  :1186 Ctrl+1/2  :1200 Escape
  :1281 window.__app = { …, session: { save, restore }, … }

docmodel.js (228 行)
  :118-129 内部状态（docs / paneActive:125 / docPane:127 / focusPaneId:129 / viewDocs）
  :134-157 集合   :161-175 活动指针   :179-211 栏归属   :214-218 脏标记   :222-226 视图归属

preview.js (506)  :167-177 按栏实例注入（opt）；find.js (257) :24-25 getView()
overlay-ipc.js (779)  :155-158 单例表；:182-184 owner 校验；:320-330 同 realpath 复用 + ownedByOther
smoke.js (4739)  会话断言 :1097/:1533/:2324/:2808/:3495；Phase 2 的 :4131（layout 不存在，**要改**）
                 Phase 2 的 split* 段 :3800 起，用例 :3882/:3920/:3958/:3999/:4045/:4088/:4123
```

---

# 10. 施工记录（Phase 3 实际施工回填，2026-09-12）

> 本节由施工 agent 回填。**所有行号 = 回填当次实测**（`Select-String` / 编辑器行号口径，与 §9 一致）。

## 10.1 改动点总表（文件:行号）

| 文件 | 位置（施工后实测） | 改了什么 |
|---|---|---|
| `src/renderer/docmodel.js` | `:139` `viewSet`（新） / `:150` `docPanes`（取代单值 `docPane`） | ① 文档 → 视图**正向**引用计数；② 文档 → **全部栏**的成员集合 |
| | `:220` `panesOf` · `:239` `ensurePaneOf` · `:249` `dropPaneOf`（新） | 多栏成员查询 / **加而不搬**登记 / 只摘一栏 |
| | `:298` `bindView` · `:313` `unbindView`（重写） | **换绑前先摘旧登记**（R6）—— 否则 `viewsOf(doc)` 永不归零 |
| | `:325-329` `viewsOf` / `viewCount` / `hasViews`（新） | 广播收件人名单 + 关闭语义判据 |
| | `:161` `active` · `:163` `setActive` · `:173` `isActive`（改写） | 多视图下「焦点栏优先，否则主栏」，单栏/单视图逐位等价 |
| `src/renderer/tabs.js` | `:103` `remoteAnnotation`（新） | 防环凭据（只在本文件用，不进 docmodel） |
| | `:107` `enqueueBroadcast` · `:119` `applyTransactionsToView`（新） | 按 Document 串行的广播队列 + **逐事务**派发 |
| | `:380-404` `updateListener` 分叉 | 远端分支不回播；本地分支取 `u.transactions.slice()` 入队广播 |
| | `:230` `primaryViewOf`（新） | 「优先焦点栏」的主视图（文档级视图操作落点） |
| | `:894` `openFile` | `opts.newView/forceNew/paneIndex`；默认仍是「聚焦已有栏 + toast」 |
| | `:1623` `switchTab(tab, opts)` | 可显式指定渲染到哪一栏；归属登记改 `ensurePaneOf`（**不搬家**） |
| | `:1712-1787` `attachViewToPane` / `detachViewFromPane` / `paneForDocAction` / `closeViewInPane` | 视图级挂载 / 摘除 / 关闭（G2+G3） |
| | `:1976` `closeTab` | 视图级 vs 文档级两种粒度；`opts.all` 强制整篇关闭；关完遍历撤空栏 |
| | `:2057` `closeAll` · `:2158` `closeByPath` | 传 `{all:true}`（同一文件的两个视图一起关） |
| | `:2127` `setTabReadOnly` | 只读是文档级决定 → 派发到 `viewsOf(doc)` 的**每一个**视图（C5） |
| | `:1494` `appendChunkText` · `:1560` `reloadChunked` · `:2850` `reloadFromDisk` | 全部改成「对文档的每个视图各应用一次」（R4/C9） |
| | `:2763` `onFileChanged` | `find` → `filter`，重载广播到全部视图 |
| | `:2559` `getSession` | 三键保留 + 新增 `layout`（每栏 docs/active/pinned + sizes + focus） |
| | `:2587-2596` `getPaneSizes` / `setPaneSizes`（新） | 比例的读/写（layout 落点，`setPaneSizes` 夹取 [0.2,0.8] 后重排） |
| | `:2103` `openInOtherPane` + 标签右键项 | G2 的用户入口「⧉ 在另一栏打开（同文件多视图）」 |
| | `:2993-3003` 导出面 | `attachViewToPane` / `openInOtherPane` / `panesOfDoc` / `viewCountOf` / `getPaneSizes` / `setPaneSizes` |
| `src/renderer/app.js` | `:237` `onRequestClose(tab, paneId)` | 传栏号；**删除无条件预保存**（否则视图级关闭会写盘，违反 G3） |
| | `:355` `persistSession(force, opts)` | `opts.final` = **唯一**允许无焦点写盘的入口；写 `layout` |
| | `:374` `beforeunload` | 关窗最后一次落盘（渲染端方案，简报 §5.1 的首选路线） |
| | `:382` `normalizeSessionLayout`（新） | 旧会话 → 单栏映射；>2 栏 / sizes 不匹配 → 回落单栏；总 ≤240、单栏 ≤200 |
| | `:418` `restoreSession` | 建栏 → 逐栏并发池 6（复用同一 Document）→ 顺序 → 比例 → 焦点 → 各栏活动项与 pin |
| `scripts/smoke.js` | `:4325` `splitSessionShape` | **同步改成「三键仍在 + layout 出现」**（R7 预警的那条） |
| | `:4486-4960` 新增 `<span>` 段 | 7 条 `mvCase` 用例（与 Phase 2 的 `splitCase` 包装同风格，排在同位置：Phase 2 段之后、`rcDir*` 之前） |

## 10.2 docmodel 新增 API（Phase 3 最小面）

```
viewsOf(doc) -> view[]     该文档的全部视图（广播收件人；Phase 2 恒 0/1，Phase 3 可达 2）
viewCount(doc) -> number   视图计数（关闭语义判据）
hasViews(doc) -> boolean   是否仍被任何视图承载
panesOf(doc) -> paneId[]   该文档出现在哪些栏（顺序 = 加入顺序）
ensurePaneOf(doc, paneId)  在该栏**登记**（加而不搬）—— switchTab 的兜底与同文件第二视图用它
dropPaneOf(doc, paneId)    只摘掉这一栏的登记（视图级关闭用）
```
**两条语义必须分清（已写进代码注释）**：`setPaneOf` = **搬家**（成员集合整个替换成 `{paneId}`，
Phase 2 的 6 处建标签点 / `mergePanes` / `moveTabToPane` 全靠它，行为一字未变）；
`ensurePaneOf` = **登记**（只加不动其它栏）。`paneOf(doc)` 仍是**单值**（返回集合里第一个 = 主栏），
因此 Phase 1/2 的 30+ 个 `paneOf(...)` 调用点一个参数都没加。

## 10.3 广播的最终落地与「为什么不自环」

1. 本地视图派发 → `updateListener` 取 `const trs = u.transactions.slice()`（**不是 `u.changes`**：
   `tr.changes` 的坐标相对**该事务之前的文档**，喂给落后 N 个事务的视图会错位）→ `t.state = u.state`
   → `enqueueBroadcast(t, …)`（按 Document 串行的 Promise 链，空闲即删键）。
2. 队列回调里遍历 `registry.viewsOf(t)`，跳过派发者自己与已销毁视图，对每个视图**按顺序**
   `dispatch({ changes: tr.changes, annotations: [remoteAnnotation.of(true)] })`。
3. **防环**：接收方的 `updateListener` 看到 `u.transactions.some(tr => tr.annotation(remoteAnnotation))`
   → 只 `t.state = u.state` 推进基线、**不再入队广播**。这是唯一凭据。
4. **程序化变更**（分段预读 / 外部重载，带 `addToHistory:false`）广播时把该注解一并传给接收侧，
   接收侧的远端分支据此**不重新标脏**（否则发起侧刚 `markDirty(false)`，远端又点亮 → 无谓自动保存，
   甚至把只加载了一半的分段标签写盘）。
5. 接收侧**保持 CM 默认历史**（不额外加 `addToHistory:false`）→「一栏的撤销可能撤掉另一栏刚输入的内容」
   就是当前语义，由 `sameFileUndo` 明确断言 + 首次分屏一次性提示（文案含「撤销按栏独立」）。

## 10.4 七条用例（名字 / 行号 / 断言清单 / 预期数值）

| 用例 | 行号 | 断言（渲染事实 / 磁盘事实） | 预期数值 |
|---|---|---|---|
| `sameFileTwoPanes` | `:4486` | 栏数 1→2 + `.pane-divider` 存在；两个 `.cm-editor` 高度 >100px、`textContent` 长度相等且 >0；两栏 `getPaneLayout().panes[i].path` 都是 `same-a.md`；`getPaneEls(0).view !== getPaneEls(1).view`；只滚左栏 → 左 >100 且右 ≤2px；左栏 `selection.anchor=100` → 右栏 head 仍 0；两栏宽度 ≥199px；**负向断言**：huge 夹具在两栏再开 → 仍是 2 栏、该文档 `panesOfDoc().length===1`、`viewCountOf()===1`、右栏 0 标签、焦点回落 p0、toast 含「大文件视图不支持同文件多视图」 | 高度 482px、textContent 687/687、宽度 548/548、滚动 300/0、光标 100/0（本机探针实测） |
| `sameFileEditSync` | `:4583` | 左栏插 `X` → 180ms 后两栏 `doc.toString()` 逐字符相等且都以 `X` 开头；**磁盘未变**（`fs.readFileSync === SF_ORIG_A`，用例内把 `autoSaveDelay` 临时抬到 30s）；`tab.dirty===true`；`getSession().paths` 里该路径只出现一次且总数 1；反向（右栏插入 → 左栏跟）；连打 20 次 → 两栏长度差 0 且总长 = 前值 +21（不丢不重） | 长度 5393/5394/5414，diff 0，磁盘 5392 字节不变 |
| `sameFileUndo` | `:4641` | 左栏加 `A`、右栏加 `B` → 两栏一致且尾部 `AB`；左栏**真实 Ctrl+Z**（`contentDOM` 的 KeyboardEvent，与 `chunkUndoNoTruncate` 同手法）→ 两栏仍一致、**右栏刚输入的 `B` 消失**、左栏长度变小、`#modal-mask` 全程 hidden；一次性提示：`__mhToastRec` 里含「撤销按栏独立」的提示**恰好 1 条**（再完整走一遍两栏挂载后仍是 1） | 5416 → 5414（CM 会把 500ms 内的相邻输入合并成一个历史事件，故一次 Ctrl+Z 同时撤掉 A+B —— **以实测为准**，断言只要求"对方输入被撤掉 + 两栏一致 + 左栏变短"） |
| `sameFileCloseOne` | `:4690` | 左栏输入 `ZZ`（两栏同步、dirty）→ 点**右栏** `.tab-close`：栏数 2→1、`#modal-mask` hidden、文档仍在、`tab.dirty` 仍 true、左栏仍显示它且首字符 `ZZ`、**磁盘字节未变**；再点**左栏**（最后一个视图）`.tab-close`：文档被移除、`getActiveTab()===null`、`#editor-empty` 可见、**磁盘已含 `ZZ`**（文档级路径才落盘） | 栏数 2→1→1（无第二栏可撤），脏标记 true→true→（关闭后）不存在 |
| `multiViewExternalChange` | `:4767` | 两栏同文件（干净）→ **主进程 `fs.writeFileSync`** 真·外部写（等 2400ms 跨过 `SELF_WRITE_GRACE_MS=2000` + 300ms 防抖；1.8s 内未见再写一次重试）→ 两栏 `doc.toString()` 都等于新内容；含「已从外部重新加载」的 toast **恰好 1 条**（两个视图只 toast 一次）；重载后 `tab.dirty===false`；全程无模态框 | 长度 5392 → 5424（原内容 + 32 字节），toast 1 |
| `layoutPersist` | `:4815` | 两栏（左 A 右 B）+ 拖分隔条到 ~0.35 + `focusPaneIndex(1)` → `session.save()` → `getSettings().lastSession`：`layout.panes.length===2`、`orientation==='h'`、`panes[0].docs` 含 A、`panes[1].docs` 含 B、`focus===1`、`sizes[0] ∈ (0.30,0.42)` 且 `|s0+s1-1|<0.01`；**三键仍在**（keys 恰为 `active,layout,paths,pinned`）、`paths` 去重、同一文件只出现一次；`document.hasFocus()` 必须为真（否则守卫会跳过写盘 —— 冒烟必须前台） | 实测 ratio 0.3498 / sizes [0.3498,0.6502] |
| `layoutBackCompat` | `:4879` | 写入**不含 layout** 的旧会话 `{paths:[a,b],active:1,pinned:[0]}` → `session.restore()`：单栏（无 divider）、`getSession().paths` 深等 `[a,b]`、活动项 `b`、`a` 的 `pinned===true`、全程无模态框；再 `session.save()` → 磁盘**写出 layout** 且 `layout.panes.length===1`、`paths` 与恢复前一致；变体 `{paths:[缺失文件,b],active:1}` → 只开 1 个标签、不弹 alertBox、活动项仍是 `b`；**再测有 layout 的正向恢复**：两栏（p0 有 a+b 且活动 a、p1 有 a 且活动 a）+ `sizes:[0.35,0.65]` + `focus:0` → 恢复后两栏、divider 在、`paths` 2 条且 a 只出现 1 次（**读盘只发生一次**）、`panesOfDoc(a)===2`、`viewCountOf(a)===2`、p0 2 标签 / p1 1 标签、焦点仍是 **p0**（钉住"激活冲掉焦点"的排序缺陷）、`sizes[0]≈0.35`、两视图内容逐字符一致；最后断言 `setTabReadOnly(a,true)` 让**两个视图**都只读（C5 文档级决定） | 实测：单栏 / [a,b] / active=b / pinnedA=true / 升级后 layout.panes=1 / 缺失变体 tabs=1；正向恢复 panes=2,focus=p0,sizes=[0.35,0.65],viewsA=2,readOnly 双视图 true |

## 10.5 验收计数

`splitSessionShape`（`:4325`）已同步改口径（**行数不变**，只把「`layout` 不存在」改成「三键 + layout 形状」）。
新增段落的静态计数：`mvCase(...)` **7 处**，每条恰好压 1 行结果 ⇒ **期望 `E2E_RESULTS` = 201 + 7 = 208**、
`| false` = 0、`| ERR:` = 0。

## 10.6 施工期的运行时证据（**隐藏窗口探针**，非 `npm run smoke`）

本机前台被全屏程序占住、`npm run smoke` 不可跑（AGENTS.md 的已知环境约束），因此用
`electron . --exttest` 跑了一次**隐藏窗口**探针（`show:false` + `backgroundThrottling:false`，
照抄冒烟 `mw*` 段的隐藏窗口做法，不抢桌面焦点；探针文件用后已 `git checkout -- scripts/ext-test.js` 还原）。
实测结果（原文摘要）：

```
twoPanes: panes=2,divider=true,viewDiff=true,same=true,len=5392,cmN=2,cmH=[482,482],
          cmText=[687,687],widths=[548,548],layoutPaths=[true,true],docsPerPane=[1,1],views=2,homes=2
scroll  : a=300,b=0(scrollable 6133)      caret: [100,0]
editSync: s1{same,head=X} s2{same,tail=Y} s3{same,len=5414,diff=0} dirty=true paths=1
memSess : keys=[active,layout,paths,pinned]  layout.panes=[{docs:[A]},{docs:[A]}]  ← 同文件确实在两栏
undo    : before{same,tail=AB,len=5416} after{same,len=5414,leftTail=q,rightTail=q} hints=1
close   : viewClose → panes=1,exists=true,dirty=true,head=ZZ,views=1   docClose → exists=false,empty=true
external: len=5424,same=true,dirty=false,toasts=1,modalHidden=true
layout  : ratio=0.3498 sizes=[0.3498,0.6502] focus=1 panes=[[A],[B]]（磁盘项因窗口无焦点被守卫跳过 —— 守卫符合预期）
backCmp : panes=1,divider=false,paths=[A,B],active=B,pinnedA=true,layoutPanes=1；缺失变体 tabs=1
hugeNeg : kind=huge → 再开同文件：homes=1,views=1,paneCount=2,p1Docs=0,focus=p0,refusedToast=true
```

**两次探针抓到的真问题（都已修）**：
1. 第一轮探针跑在**过期 bundle** 上（我把 `app.js` 的 `onRequestClose` 预保存删除排在了 `npm run build` 之后）
   → 视图级关闭把内容写盘了（`dirty` 被清）。**教训：改完 `src/**` 必须重跑 `npm run build` 再验证**。
2. 外部修改用例最初只等 300ms → 落在 `SELF_WRITE_GRACE_MS=2000` 窗口内被当自身回声**吸收**（假阴性）。
   现改为等待 2400ms + 一次兜底重试（内容再变一次）。
3. **恢复期的焦点被逐栏激活冲掉**（探针 2 实测：layout `focus: 0` 恢复完却成了 `p1`）：`openFile` 的
   "已有文档在本栏 → 纯激活"分支里那句 `setFocusPane` 会在批量放置路径（会话恢复）中把焦点带到
   最后一栏。修法两条：① `opts.paneIndex != null` 时**不碰焦点指针**；② `restoreSession` 在激活循环
   **之后**再钉一次 `focusPaneIndex(plan.focus)`。
4. `layoutBackCompat` 的「有 layout 的恢复」子断言第一版写错了预期（两栏的活动项不同 → 只有 1 个视图
   在承载该文档、两视图内容本就不同）。改成「**两栏都显示同一文件**」的快照（`panes[0].active` 指向
   该文件）后，`viewsOf(doc)===2`、两视图内容一致、多视图只读（C5）才都成立。

**探针 2（`layout` 正向恢复 + 多视图只读）实测**（同一隐藏窗口手法，用后已还原 `scripts/ext-test.js`）：

```
restore : panes=2,divider=true,paths=2,aOnce=1,homesA=2,viewsA=2,p0Docs=2,p1Docs=1,
          focus=p0,sizes=[0.35,0.65],p0ActiveIsA=true,p1ActiveIsA=true,same=true,diffViews=true,modalHidden=true
readOnly: setTabReadOnly(doc,true) → 两个视图都 readOnly=true；关掉 → 两个视图都 false
resave  : keys=[active,layout,paths,pinned], paths=2, panes=2, sizes=[0.35,0.65], focus=0, p1Docs=1
```

> 结论：`layoutBackCompat` 现在同时覆盖 ①旧三键会话→单栏 ②升级后再存写出 layout ③缺失文件静默
> ④**有 layout 的两栏恢复**（含同文件两视图复用同一 Document、比例、焦点排序）⑤多视图只读（C5）。

## 10.7 诚实清单（弱验证 / 主动放弃 / **改了既有行为**）

**改了既有行为（逐条 + 理由）**
1. **`getSession()` 从三键变四键**（+`layout`）：这是 Phase 3 的交付目标本身；三键**一个都没删**。
   同步改了 `scripts/smoke.js:4325` 的 `splitSessionShape`（原文「断言 layout 不存在」→「断言三键仍在且
   layout 形状正确」）。会话 schema 扩展需在 CHANGELOG 记一笔（**由父 agent 落**）。
2. **`app.js` 的 `onRequestClose` 不再无条件 `saveNow`**：原先「点 ✕ 先保存再关」对视图级关闭会**写盘**，
   直接违反 G3。删除后文档级关闭仍由 `tabs.js` 的 `closeTab` 走 `saveNow`（huge 分支同样覆盖）
   ⇒ 单视图场景的磁盘结果**逐个字节不变**（冒烟里只有 `splitCloseLast` 点 `.tab-close`，且是干净文档）。
3. **`openFile` 的默认分支不变，但新增了三个 opt**（`newView`/`forceNew`/`paneIndex`）；「同文件已在另一栏」
   的默认行为仍是「聚焦那一栏 + toast」（**没有**改成「默认开第二个视图」—— 选更小更容易回滚的那条）。
4. **`closeAll` / `closeByPath` 传 `all:true`**：语义是「整篇关闭（同一文件的所有视图）」。
   单栏单视图下与改前逐位一致（只是多关了一个本就不存在的第二视图）。
5. **`reloadFromDisk` / `reloadChunked` / `appendChunkText` 改成逐视图应用**；`reloadFromDisk` 的
   dispatch 现在带 `remoteAnnotation`（不回播）与 `addToHistory:false`（同改前语义）。
   `reloadFromDisk` 的预览刷新从「只刷主栏」改成「刷每个正在显示它的栏」。
6. **`restoreSession` 重写**：旧格式（无 layout）走「映射成单栏」的分支，`paths` 顺序、`active` 下标、
   `pinned` 下标、`CONCURRENCY=6`、静默失败（L6）全部保持；新增按栏恢复与上限（总 240 / 单栏 200）。
7. **kind 类文档（image/chunked/viewer-lg/huge）新建时也进 `opts.paneIndex` 指定的栏**（会话恢复用）；
   无 `paneIndex` 时与改前逐位一致（焦点栏）。
8. **`restoreTabScroll(tab, pane)` / `scrollToBottom` 改用本栏视图**（多视图下 `viewOfDoc` 取主栏会滚错栏）；
   单栏单视图下等价。

**主动放弃（本阶段不做，理由）**
- **不用 `ChangeSet.compose` 做通用追平**：每栏恒有一个常驻 `EditorView`，视图不会「未挂载而落后」；
  简报 §3.3 已把 compose 列为「实测露馅再加」的备选。
- **不做「两个 huge / viewer-lg 视图看同一文件」**：overlay 是路径单例（R1），入口直接拒绝 + toast。
- **不做「关最后一个视图弹未保存确认框」**：本仓库当前关闭路径一直是「脏则静默保存、从不弹框」，
  新增确认框会改变既有行为且可能让冒烟挂起（原生 `dialog:confirm` 无法自动点击）。
  用例按**当前语义**断言：关一个视图零副作用，关最后一个视图才发生落盘。**「未保存确认」记为未实现。**
- **不测 dirty + 外部修改的确认框**：`confirmDialog` 走主进程原生 `dialog.showMessageBox`（`ipc.js:106`），
  自动化跑会**阻塞到用户点击**。既有 `externalChange` 用例同样只覆盖干净路径。
- **不测「重启后恢复」**：需要再起进程（Phase 4 的多窗口基建），恢复逻辑用 `layoutBackCompat` +
  直接调 `window.__app.session.restore()` 覆盖（简报 §6.6 已如此定调）。

**弱验证项（父 agent 跑冒烟时重点看这几条）**
1. `layoutPersist` / `layoutBackCompat` 的**磁盘断言要求窗口有焦点**（`persistSession` 的焦点守卫）；
   后台/隐藏窗口跑必然失败 —— 这是既有口径，不是回归。
2. `sameFileTwoPanes` 里「两个 `.cm-editor` 的 textContent 长度相等」在**隐藏窗口**探针里成立（687/687），
   前台窗口同样成立（两栏等高、无换行 → 渲染同一批行）；若某天两栏宽度差导致换行差异，这条会先红。
3. `sameFileUndo` 的断言刻意**不依赖** CM 历史分组细节（实测 500ms 内相邻输入会被合并成一个历史事件，
   一次 Ctrl+Z 同时撤掉 A+B）——「撤销撤掉对方输入」这一核心事实两种分组下都成立。
4. `tab.scrollTop` 仍是**文档级单值**字段：同文件两栏的滚动位置记忆会互相覆盖（切走再切回时）。
   本阶段不做逐视图滚动记忆（需要 per-(doc,pane) 表，属体验项）。
5. `find.js` 仍只认焦点栏（R9，Phase 5a）；`appendChunkText`/分段标签在**同文件两栏**下的预读
   只由主栏滚动驱动（分段多视图不在 7 条用例覆盖范围内）。

## 10.8 首轮验收（2026-08-30 22:0x，冻结树）5 条红的归因与修法

首轮实测：结果行 **208**、`| false` 0、`| ERR:` 0，但有 5 条打印了 detail 串（= 判定失败）。
父 agent 的验收器已按「值必须 `true`」判定并点名。逐条归因：

| 用例 | 现象 | 归因 | 修法 |
|---|---|---|---|
| `sameFileEditSync` | `editSync=false`（左 `X同` / 右 `同文`） | **用例缺陷**：广播是按文档串行的 Promise 队列，回调在**微任务**里跑 —— 派发后同一同步块里接收侧**必然**还没追平。我原来的断言要求"同一同步块内已追平"，与设计相悖 | 判定去掉该子断言；改断言 180ms 后的 `same`+`bothX`，另**测量真实传播延迟**（`lag`，0~800ms 计入判定）写进 detail |
| `sameFileCloseOne` | `diskUnchanged=false`（磁盘 5634↔5634 但逐字节不同） | **用例缺陷**：磁盘基线取在"编辑之后"，而 `closeTab` 里的 `saveNow` 是**排队异步**的（应用级 `saveQueue`）—— 上一用例排队中的旧保存可能落在两次读取之间，与本用例无关却把逐字节比较变红 | 基线改到**编辑之前**取；判定改成「磁盘长度未变 + 刚输入的 `ZZ` 没被写进去」（G3 的真正判据），逐字节相等只作证据 |
| `multiViewExternalChange` | `bothReloaded=false(hasExt1=false)`、`oneToast=false(n=0)` | **用例缺陷（最隐蔽）**：轮询的中止条件用**长度**判定，而上一用例留下的文档长度（5636）恰好等于旧 `EXT-1/2` 内容的长度 → 第一轮（300ms）就"误判已追平"并退出，**从未等待事件到达**；兜底重试也因此没触发 | 中止条件改成**按内容**（`hasMark`：同时含 `EXT-1` 与 `EXT-3`）且长度匹配；外部内容加长到 3 行、每次重试多 16 字节，彻底杜绝长度巧合；轮询 3 轮 × 3s |
| `layoutBackCompat` | `singlePane=false`（其余子断言全 true） | **产品侧口径缺失**：`restoreSession` 只"建栏"从不"合栏" —— 若恢复前窗口已是双栏（同窗口内再次 restore / 用户自己分过屏），单栏快照恢复完仍是双栏，**恢复结果 ≠ 快照** | `app.js` 的 `restoreSession` 补反向归一：`plan.panes.length <= 1 && getPaneCount() > 1 → mergePanes()`；用例同时加诊断项（`preReset`/`preSnap`）便于复发时定位 |
| `rcDirBadPath`（**既有用例**） | `noCrash2=false`、`notOpened2=false`（第一条窗口全绿） | **非 Phase 3 引入**：该窗口的 `--dir` 是真实文件 → boot 走 `openDirFromArg` 分支，**完全跳过 `restoreSession`**（Phase 3 的改动全在 restore/session 侧），且 toast 已出现说明 boot 走到了该分支；`s2` 是在 toast 之后**一次性读取**，而 `window.__app` 是 boot **最后一行**才挂上 → 读到 `app:false`、`roots:-1` | 给该用例加 `waitApp(w,budget)` 轮询（只增加等待，不改任何断言口径），并把 `s1`/`s2` 写进 evidence 便于复发诊断 |

修法验证：`%TEMP%` 的隐藏窗口探针（`show:false` + `backgroundThrottling:false`，不抢焦点）实测
`viewClose{dirty2:true,diskNoEdit:true,diskLenSame:true}`、`docClose{exists:false,diskHasZZ:true}`、
`EXT{len 匹配,same:true,hasMark:true,toasts:1,dirty:false}`、
`LB{before:2 栏 → after:1 栏, paths=[a,b], active=b, pinnedA:true, layoutPanes:1}` —— 三条修法全部实测通过。


