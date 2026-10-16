// ============================================================================
// docmodel.js —— 文档层注册表（0.5.0 多视图 Phase 1：行为中性重构的落点）
// ============================================================================
//
// ── 这个模块是什么 ────────────────────────────────────────────────────────────
// 只做一件事：把「一个窗口里有哪些文档」「哪个文档是活动的」「文档脏不脏」这三件事
// 从 `tabs.js` 的闭包变量里搬到一个**纯内存注册表**里，让 Phase 2/3 的「多栏 + 一文件
// 多视图」有地方长出第二份状态。
//
// ── 三条硬约束（违反即破坏冒烟，见 docs/开发计划-多视图-Phase1-重构清单.md §3.3/§5）──
//  1. **`doc === 原 tab 对象`（同一引用）**：冒烟直读 `tab.kind` / `tab.huge` / `tab.vwin` /
//     `tab.chunk`（约 40 处）以及 `tab.huge.getState()`。因此注册表**不做对象搬家、不做代理**，
//     只持有标签对象本身的引用。字段名一律不改。
//  2. **`list()` 返回的是注册表内部那个数组本身**（不是副本）：`tabs.js` 里 `for (const t of tabs)`、
//     `tabs.indexOf(...)`、`tabs.sort(...)` 等原地操作必须继续看到同一份顺序。
//  3. **不碰 DOM、不碰 IPC、不 import 任何渲染模块**（零依赖 ⇒ 可纯内存单测）。
//
// ── 明显**不**属于这里的状态（硬清单，逐条对应清单文档 §5.3）────────────────────────
//  · `EditorView` 实例（tabs.js:257）—— 与 DOM 强绑定，一个视图一份；注册表的键是**文档**不是视图
//  · `#editor-host` / `#image-host` / `#diff-host` / `#viewer-bar` 等 DOM 引用 —— Phase 2 要按 pane 复制
//  · hugeview 的 DOM 与实例（`tab.huge` / `tab.hugeEl`）—— DOM 生命周期归视图；overlay 文档才是文档级
//  · 4 个 `Compartment`（tabs.js:121-124）—— 被 `EditorState` 持有，多视图后要逐 view reconfigure
//  · `saveQueue`（tabs.js:1410）—— **应用级**串行链，跨文档共享；进注册表会变成"每文档一条队列"
//  · `tab.scrollTop` / `hugeTopLine` / `hugeHidden` / `imgDrag` / `previewScrollTop` —— 纯视图级位置
//  · `document.hasFocus()` 守卫（app.js:273）—— 窗口级，与文档无关
//  · `markSelfWrite` / `watchFile` 调用点 —— IPC 副作用，留在编排层；注册表要能纯内存单测
//
// ── 活动指针：Phase 1 一份 → Phase 2 每栏一份 ──────────────────────────────────
// Phase 1 的 `setActive()/active()` 是**全窗口唯一**的活动文档指针（= 原 `tabs.js` 的 `let activeTab`）。
// 0.5.0 Phase 2 引入第二个 pane 后，指针变成「每栏一份」（`activeOf(paneId)`），并新增一个**焦点栏**
// 指针 `focusPane()`。**兼容口径（单栏逐位等价）**：无参的 `active()` ≡ 焦点栏的活动文档，
// `isActive(doc)` ≡ 「doc 是**它自己那一栏**的活动文档」—— 单栏下这两条与 Phase 1 一字不差，
// 双栏下则自动变成「跟焦点栏」「按栏判定」，因此 Phase 1 落地的 22 处 `active()` / 22 处 `isActive()`
// 调用点**不需要逐个加 paneId 参数**。
//
// **Phase 2 的硬不变量**：一个 `Doc` 只归属一个 pane，「同一文件开在两栏」由 `tabs.js` 的
// `openFile` 在入口处拦掉（切到已有那一栏并提示）。
//
// ── Phase 3：一个文档可以在多个栏各有一个视图（同一 `Doc`，各自独立 `EditorState`）──────
// `docPanes: Map<Doc, Set<paneId>>` 取代了 Phase 2 的单值 `docPane`。两条语义必须分清：
//  · **`setPaneOf(doc, paneId)` = 搬家**：成员集合被**整个替换**成 `{paneId}`。Phase 2 的 6 处
//    建标签点、`mergePanes`、`moveTabToPane` 全靠这个语义（搬家后源栏不再持有该文档）。
//  · **`ensurePaneOf(doc, paneId)` = 登记**：只往集合里**加**，不动其它栏 —— 只有"同一文件在
//    第二栏开一个视图"（`tabs.js` 的 `attachViewToPane`）走这条；`switchTab` 的兜底登记也走它，
//    否则切一次标签就会把另一栏的视图归属抹掉。
// `paneOf(doc)` 仍是**单值**（返回集合里第一个栏 = 该文档的"主栏"），因此 Phase 1/2 的 30+ 个
// `paneOf(...)` 调用点一个字都不用改；需要"全部栏"的新代码用 `panesOf(doc)`。
//
// ── `viewsOf` 为什么在 Phase 1 就存在 ──────────────────────────────────────────
// `EditorView.updateListener` 现在闭包捕获的是**全局活动文档**：多视图下 B 栏打字会把内容写进
// A 栏文档（清单文档 §4.2-C1「最致命」）。Phase 1 把该回写改成「由派发事务的视图反查所属文档」，
// 反查需要一张 `view → doc` 表。**Phase 2 已把 `tabs.js` 的判据换成 `registry.docOfView(u.view)`**
// 并按栏各自 `bindView` / 关栏时 `unbindView` —— 这是双栏下「B 栏打字不会写进 A 栏文件」的唯一保证。
//
// **Phase 3 补上反向的引用计数 `viewSet: Map<Doc, Set<view>>`（= `viewsOf` / `viewCount` / `hasViews`）**：
// 变更广播要"发给同一文档的其它视图"，关闭语义要判"这是不是该文档的最后一个视图"。
// 两个方向必须**同时**维护，且 `bindView` 换绑前**必须先摘旧登记** —— `tabs.js` 的 `switchTab`
// 是"同一个 view 换绑不同文档"（切标签），不摘的话 `viewsOf(旧文档)` 永远归不了零，
// 于是「关最后一个视图」的判定永远不成立（Phase 3 的关闭语义直接失效）。
// ── 附录：原 `tabs.js` 的 `activeTab` 83 处引用全量分类表（施工前实测：83 处 / 67 行）──────
// 行号是**重构前**的行号（重构后 `activeTab` 这个变量已整体删除，只剩 `getActiveTab()` 函数名）。
// 这张表是 Phase 2 把「全局唯一 activeTab」拆成「每 pane 一个 activeDoc」的分工清单，
// 也是 0.5.0 计划 §2「开工动作 1」要求的产物。
//
// | # | 用途类 | 处数 | 重构前行号 | Phase 2+ 的语义变化 |
// |---|---|---|---|---|
// | A | 声明与赋值 | 3 | :107 声明；:964 `= tab`；:1208 `= null` | 「全局唯一」→「每 pane 一个 activeDoc」；`:1208` 的"关完变 null"按 pane；`:1210-1214` 空态 UI 也按 pane |
// | B | CM updateListener 归属判定 | 6 | :239、:241、:242、:245、:251(×2) | **最危险**：多视图下必须由 `u.view` 反查（docmodel 的 `docOfView`） |
// | C | 滚动预读/翻页触发 | 5 | :279、:280(×2)、:281(×2) | 每 pane 一份 scroll 监听；kind 判定取"该 pane 的活动文档" |
// | D | huge 脏标记回调 | 1 | :421 | 多视图下"任一面板活动即刷"或按 pane 刷 |
// | E | viewer-lg 区域查看/编辑 | 16 | :585、:597、:616、:626、:668、:679、:1275、:1981、:1993、:1999(×3)、:2002(×3)、:2008 | 窗口级语义要改成"该标签所属 pane 的活动文档"；`:679` 的硬拒绝必须放宽 |
// | F | chunked 分段追加 | 3 | :841、:872、:906 | `isActive ? view.state : tab.state` 的二选一失效 → 对**每个视图**各派发一次 |
// | G | 标签切换与滚动恢复 | 5 | :950(×2)、:951、:1021、:1032 | 滚动记忆按 pane；`cycleTab` 变「栏内循环」（G6 已锁定） |
// | H | 状态栏 | 20 | :1043(×3)、:1044(×2)、:1045(×2)、:1047、:1050(×2)、:1055、:1056(×2)、:1057、:1069、:1070、:1071、:1073、:1081、:1082 | 状态栏是全局单例：显示**焦点栏**的文档（Phase 2 最小改动） |
// | I | 标签栏渲染/徽标/空态 | 3 | :1333、:1395、:1403 | 每栏各自标签栏，判据变"该 pane 的 activeDoc" |
// | J | 设置热更新与保存入口 | 6 | :1430（`doSaveNow` 缺省参数）、:1511、:1513、:1520(×2)、:1522 | `saveNow()` 无参（app.js:1062）的"哪个栏"要定义 |
// | K | 滚动到底/顶部按钮 | 3 | :1528、:1545、:1556 | 同 H：取焦点栏 |
// | L | 会话快照 | 2 | :1636（`getActiveTab` 返回）、:1644（`persist.indexOf(activeTab)`） | 单栏 `{paths,active,pinned}` → `layout.panes[].active`（格式变更属 Phase 3） |
// | M | 事件绑定（粘贴/右键/图片粘贴） | 4 | :1720、:1733(×2)、:1758 | 每 pane 一份监听；`pasteImages` 要取"发起粘贴的那个视图"所属文档 |
// | N | 外部修改重载 | 5 | :1924、:1939、:1940、:1941、:1965 | "活动用 dispatch、非活动重建 state"的二选一失效 → 按文档的**全部视图**逐个应用 |
// | O | 关闭标签 | 1 | :1204 | `if (activeTab === tab)` 按 pane 判定；「关最后一个视图才确认」见 G3 |
//
// 校验：3+6+5+1+16+3+5+20+3+6+3+2+4+5+1 = **83** ✅
'use strict';

/**
 * @typedef {object} Doc
 * 现有的 `tab` 对象（**同一个引用**）。字段含义与归属见清单文档 §1.3：
 *  `id, path, name, lang, kind?, state, dirty, saveTimer, pinned, crlf?, readOnly?,
 *   chunk?, vwin?, huge?, hugeEl?, scrollTop?, …`
 */

/**
 * 建一个文档注册表。
 *
 * 「一个窗口一份」——`tabs.js` 的 `createEditor()` 里调用一次，此后全窗口共用。
 *
 * @returns {{
 *   list: () => Doc[],
 *   count: () => number,
 *   indexOf: (doc: Doc) => number,
 *   byPath: (p: string|null) => Doc|null,
 *   byDiffKey: (k: string) => Doc|null,
 *   add: (doc: Doc) => Doc,
 *   remove: (doc: Doc) => number,
 *   replaceAll: (arr: Doc[]) => void,
 *   active: () => Doc|null,
 *   setActive: (doc: Doc|null) => Doc|null,
 *   isActive: (doc: Doc|null) => boolean,
 *   markDirty: (doc: Doc|null, v?: boolean) => Doc|null,
 *   isDirty: (doc: Doc|null) => boolean,
 *   listDirty: () => Doc[],
 *   bindView: (view: object, doc: Doc) => void,
 *   unbindView: (view: object) => void,
 *   docOfView: (view: object) => Doc|null,
 *   viewsOf: (doc: Doc) => object[],
 *   viewCount: (doc: Doc) => number,
 *   hasViews: (doc: Doc) => boolean,
 *   paneOf: (doc: Doc) => string|null,
 *   panesOf: (doc: Doc) => string[],
 *   setPaneOf: (doc: Doc, paneId: string) => Doc|null,
 *   ensurePaneOf: (doc: Doc, paneId: string) => Doc|null,
 *   dropPaneOf: (doc: Doc, paneId: string) => Doc|null,
 *   docsOf: (paneId: string) => Doc[],
 *   countIn: (paneId: string) => number,
 *   activeOf: (paneId: string) => Doc|null,
 *   setActiveOf: (paneId: string, doc: Doc|null) => Doc|null,
 *   focusPane: () => string|null,
 *   setFocusPane: (paneId: string) => string,
 *   forgetPane: (paneId: string) => void,
 * }}
 */
export function createDocRegistry() {
  /** @type {Doc[]} 顺序 = 标签栏顺序（即原 `tabs.js` 的 `const tabs = []`） */
  const docs = [];
  /** @type {WeakMap<object, Doc>} view → doc（反向表；Phase 3 可达 2 条：同一文档两个栏各一个视图） */
  const viewDocs = new WeakMap();
  /** @type {Map<Doc, Set<object>>} doc → 它的全部视图（正向引用计数；空集合即删键，防只增不减） */
  const viewSet = new Map();

  // ---------------- 0.5.0 多视图 Phase 2：按 pane 的活动指针与归属 ----------------
  // Phase 1 的「全窗口唯一 activeDoc」在这里长成「每栏一份」：
  //  · `paneActive`：paneId → 该栏当前活动文档（标签栏高亮的那一个）
  //  · `docPanes`  ：Doc → 它出现在哪些栏（Phase 3 起可达 2 个：同一文件两栏各一个视图）
  //  · `focusPaneId`：焦点栏。`active()`（无参）恒等于「焦点栏的活动文档」，
  //    因此 Phase 1 的 22 处 `registry.active()` 调用在单栏下逐位等价，双栏下自动跟焦点栏走。
  /** @type {Map<string, Doc|null>} */
  const paneActive = new Map();
  /** @type {Map<Doc, Set<string>>} 成员集合（顺序 = 加入顺序，`paneOf` 取第一个） */
  const docPanes = new Map();
  /** @type {string|null} */
  let focusPaneId = null;
  /** 集合里第一个元素（`paneOf` 的"主栏"口径）；空/缺失返回 null */
  const firstOf = (s) => {
    if (!s || !s.size) return null;
    for (const v of s) return v;
    return null;
  };
  /** 空集合常量（`viewCount`/`hasViews` 查不到时避免每次 new Set） */
  const EMPTY_SET = new Set();
  /** 路径键规范化：与 tree.js 的 normalizeKey 完全同式（小写 + 正斜杠；两处改动须同步） */
  const normPathKey = (p) => String(p).replace(/\\/g, '/').toLowerCase();

  return {
    // ---------------- 集合（原 `tabs[]` 的全部读写点） ----------------
    /** 文档数组**本身**（不是副本）：调用方可以原地遍历/查找/排序，与旧 `tabs` 变量语义一致 */
    list: () => docs,
    /** 文档数（≡ 旧 `tabs.length`） */
    count: () => docs.length,
    /** 下标（≡ 旧 `tabs.indexOf`）；不存在返回 -1 */
    indexOf: (doc) => docs.indexOf(doc),
    /** 按路径找**第一个**匹配文档（≡ `findTabByPath`；多视图下"第一个"语义在 Phase 1 必须保持） */
    byPath: (p) => {
      // 与 tree.js 的 normalizeKey 同口径（小写 + 正斜杠）：同一文件的不同写法
      // （大小写 / 正反斜杠）必须命中同一文档，否则会双开双写。
      // 本模块保持零依赖硬约束，不复用 tree.js 的 import，这里收一份等价逻辑（两处改动须同步）。
      if (p == null || p === '') return null;
      const k = normPathKey(p);
      return docs.find((d) => d.path != null && normPathKey(d.path) === k) || null;
    },
    /** 对比标签按 diffKey 去重查找（≡ `openDiffTab` 的 `t.kind === 'diff' && t.diffKey === key`） */
    byDiffKey: (k) => docs.find((d) => d.kind === 'diff' && d.diffKey === k) || null,
    /** 追加（≡ 旧 `tabs.push`），返回该文档便于链式使用 */
    add: (doc) => { docs.push(doc); return doc; },
    /** 按引用移除（≡ 旧 `tabs.splice(idx,1)`），返回被移除文档的旧下标（-1 = 不在表内） */
    remove: (doc) => {
      const i = docs.indexOf(doc);
      if (i >= 0) docs.splice(i, 1);
      const s = docPanes.get(doc);
      if (s) {
        for (const pid of s) if ((paneActive.get(pid) || null) === doc) paneActive.set(pid, null);
        docPanes.delete(doc);
      }
      viewSet.delete(doc);
      return i;
    },
    /** 用给定顺序整体替换（≡ `reorderTabs` 的原地 `tabs.sort` 结果）；传空数组即清空 */
    replaceAll: (arr) => { docs.length = 0; docs.push(...arr); },

    // ---------------- 活动指针（Phase 2：每栏一份；无参 API 恒指「焦点栏」） ----------------
    /** 当前活动文档 = **焦点栏**的活动文档（≡ 旧 `getActiveTab()` 的闭包变量） */
    active: () => (focusPaneId != null ? paneActive.get(focusPaneId) || null : null),
    /** 置活动文档：写进**它自己所属的栏**（多视图时优先焦点栏；未归属时写焦点栏）。返回置入后的值 */
    setActive: (doc) => {
      const d = doc || null;
      const s = d ? docPanes.get(d) : null;
      const pid = s && s.size
        ? ((focusPaneId != null && s.has(focusPaneId)) ? focusPaneId : firstOf(s))
        : focusPaneId;
      if (pid == null) return null;
      paneActive.set(pid, d);
      return d;
    },
    /** 是否是**某个承载它的栏**的当前活动文档（单栏时 ≡ `activeTab === tab`） */
    isActive: (doc) => {
      if (doc == null) return false;
      const s = docPanes.get(doc);
      const pid = s && s.size
        ? ((focusPaneId != null && s.has(focusPaneId)) ? focusPaneId : firstOf(s))
        : focusPaneId;
      return pid != null && (paneActive.get(pid) || null) === doc;
    },

    // ---------------- Phase 2：栏（pane）归属（Phase 3：一个文档可在多个栏） ----------------
    /** 该文档的**主栏** id（成员集合里的第一个）；未归属返回 null。
     *  Phase 1/2 的单值语义在这里保留：单栏/单视图下与旧 `docPane.get(doc)` 逐位一致。 */
    paneOf: (doc) => (doc != null ? firstOf(docPanes.get(doc)) : null),
    /** 该文档出现的**全部**栏 id（Phase 3：同一文件两栏时为 2 个，顺序 = 加入顺序） */
    panesOf: (doc) => (doc != null ? Array.from(docPanes.get(doc) || []) : []),
    /** 把文档**搬到**某栏：成员集合整个替换成 `{paneId}`（换栏/合并栏语义，源栏不再持有它）。返回该文档 */
    setPaneOf: (doc, paneId) => {
      if (!doc || !paneId) return null;
      const s = docPanes.get(doc);
      if (s) {
        for (const pid of s) {
          if (pid === paneId) continue;
          if ((paneActive.get(pid) || null) === doc) paneActive.set(pid, null); // 搬走 → 源栏活动指针不能悬空
        }
        s.clear();
        s.add(paneId);
      } else {
        docPanes.set(doc, new Set([paneId]));
      }
      if (!paneActive.has(paneId)) paneActive.set(paneId, null);
      return doc;
    },
    /** 在该栏**登记**一个视图（不搬走其它栏的登记）—— 同文件多视图与 `switchTab` 的兜底登记用它 */
    ensurePaneOf: (doc, paneId) => {
      if (!doc || !paneId) return null;
      let s = docPanes.get(doc);
      if (!s) { s = new Set(); docPanes.set(doc, s); }
      s.add(paneId);
      if (!paneActive.has(paneId)) paneActive.set(paneId, null);
      return doc;
    },
    /** 只摘掉**某一栏**的登记（Phase 3 视图级关闭：关掉一个栏里的视图，文档本身仍在别的栏）。
     *  该栏活动指针若指向它则一并清空；成员集合空了即删键。返回该文档。 */
    dropPaneOf: (doc, paneId) => {
      if (!doc || !paneId) return null;
      const s = docPanes.get(doc);
      if (!s) return doc;
      s.delete(paneId);
      if ((paneActive.get(paneId) || null) === doc) paneActive.set(paneId, null);
      if (!s.size) docPanes.delete(doc);
      return doc;
    },
    /** 该栏的全部文档（按全局标签顺序过滤；栏内顺序 = 该栏标签栏顺序） */
    docsOf: (paneId) => docs.filter((d) => { const s = docPanes.get(d); return !!s && s.has(paneId); }),
    /** 该栏文档数（= 该栏标签栏的标签数） */
    countIn: (paneId) => docs.reduce((n, d) => { const s = docPanes.get(d); return n + (s && s.has(paneId) ? 1 : 0); }, 0),
    /** 该栏当前活动文档 */
    activeOf: (paneId) => paneActive.get(paneId) || null,
    /** 置某栏的活动文档 */
    setActiveOf: (paneId, doc) => {
      if (paneId == null) return null;
      const d = doc || null;
      if (!paneActive.has(paneId)) paneActive.set(paneId, null);
      paneActive.set(paneId, d);
      return d;
    },
    /** 焦点栏 id */
    focusPane: () => focusPaneId,
    /** 置焦点栏（只改指针，不碰 DOM —— DOM 显隐/去饱和由 tabs.js 的 setFocusPane 负责） */
    setFocusPane: (paneId) => { focusPaneId = paneId || null; return focusPaneId; },
    /** 移除某栏的登记（关栏时调用；该栏文档应先被移走或关闭）。
     *  Phase 3：只摘掉**这一栏**的成员关系，同一文档在另一栏的视图不受影响。 */
    forgetPane: (paneId) => {
      paneActive.delete(paneId);
      for (const [d, s] of Array.from(docPanes)) {
        s.delete(paneId);
        if (!s.size) docPanes.delete(d);
      }
      if (focusPaneId === paneId) focusPaneId = null;
    },

    // ---------------- 文档级标记（不碰 DOM、不碰 CM） ----------------
    /** 置/清脏标记（缺省 true）。注意 huge 的**权威**脏值在主进程 overlay，这里只是镜像 */
    markDirty: (doc, v) => { if (doc) doc.dirty = v !== false; return doc || null; },
    /** 脏判定（≡ `!!tab && tab.dirty === true` 的读法） */
    isDirty: (doc) => !!doc && doc.dirty === true,
    /** 全部脏文档（保存前批量检查/关闭确认用） */
    listDirty: () => docs.filter((d) => d.dirty),

    // ---------------- 视图归属（Phase 2 反查；Phase 3 正反双向计数，广播与关闭语义的判据） ----------------
    /** 登记「这个 EditorView 渲染的是哪个文档」。**换绑前必须先摘旧登记**（同一个 view 切标签时
     *  doc 会变），否则旧文档的引用计数永远归不了零 →「关最后一个视图」的确认/清理路径失效。 */
    bindView: (view, doc) => {
      if (!view) return;
      const prev = viewDocs.get(view);
      if (prev && prev !== doc) {
        const s0 = viewSet.get(prev);
        if (s0) { s0.delete(view); if (!s0.size) viewSet.delete(prev); }
      }
      viewDocs.set(view, doc);
      if (doc) {
        let s = viewSet.get(doc);
        if (!s) { s = new Set(); viewSet.set(doc, s); }
        s.add(view);
      }
    },
    /** 解除登记（视图销毁/切走时调用）。正向与反向一起摘，空集合即删键。 */
    unbindView: (view) => {
      if (!view) return;
      const doc = viewDocs.get(view);
      if (doc) {
        const s = viewSet.get(doc);
        if (s) { s.delete(view); if (!s.size) viewSet.delete(doc); }
      }
      viewDocs.delete(view);
    },
    /** 由派发事务的视图反查所属文档；未登记返回 null（**绝不**回退成"活动文档"） */
    docOfView: (view) => (view ? viewDocs.get(view) || null : null),
    /** 该文档的**全部**视图（Phase 2 恒为 0/1 个；Phase 3 同文件两栏时为 2 个）—— 变更广播的收件人名单 */
    viewsOf: (doc) => (doc != null ? Array.from(viewSet.get(doc) || []) : []),
    /** 视图计数（关闭语义 G3 的判据：0 = 该文档已无视图承载） */
    viewCount: (doc) => (doc != null ? (viewSet.get(doc) || EMPTY_SET).size : 0),
    /** 是否仍被至少一个视图承载 */
    hasViews: (doc) => (doc != null ? (viewSet.get(doc) || EMPTY_SET).size > 0 : false),
  };
}
