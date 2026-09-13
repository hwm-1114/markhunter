// 多标签 + CodeMirror 编辑器核心
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Compartment, StateEffect, StateField, Prec, Transaction, Annotation } from '@codemirror/state';
import { Decoration, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { langFor, baseName, escapeHtml, showContextMenu, hideContextMenu, formatSize, stripChunkMarkers, CHUNK_MARKER_RE, showPrompt, toast } from './ui.js';
import { pathToFileUrl } from './viewer.js';
import { createHugeView } from './hugeview.js';
import { renderDiffTab, buildDiffReport } from './diffview.js';
import { createDocRegistry } from './docmodel.js';

// ---------- P7：大文件分段模式 ----------
// 超过 CHUNK_THRESHOLD 的文件走「分段模式」：先读首段（CHUNK_SIZE）进 CM，
// 文档末尾以占位标记告知未完；滚动接近底部时自动预读下一段并追加（dispatch 增量，不整体重建）；
// 保存前若未读完先补齐剩余分段，再整篇 toString 写（写路径本身不改，仍全量写）。
export const CHUNK_THRESHOLD = 4 * 1024 * 1024;      // 超过 4MB 走分段模式
const CHUNK_SIZE = 2 * 1024 * 1024;                  // 每段 2MB
const CHUNK_PREFETCH_MARGIN = 256 * 1024;            // 距底部 <256px 触发预读
const CHUNK_MAX_BLOCKS = 4096;                       // 单文件最多分段数兜底（4096×2MB = 8GB）

// ---------- 1B-2：大文件查看器（viewer-lg） ----------
// >256MB 文件进入：只读滑窗查看（默认 ~8MB/窗，滚动到边缘自动翻页、百分比/字节偏移跳转）；
// 「启用区域编辑」把当前窗口转为可编辑（≤40MB），保存时按字节偏移拼接写回原文件（fs:splice-file）。
// 理由：CM6 全量驻留内存 + V8 单字符串上限，>256MB 全文编辑不可行（见开发计划 C1/C2）。
const VIEWER_THRESHOLD = 256 * 1024 * 1024;   // >256MB → 查看器（分页式，可区域编辑）
// v0.4.0 Phase B：>1GB 走「虚拟滚动查看器」（连续滚动 + 任意位置 O(1) 定位）。
// 阈值先取 1GB 做灰度：256MB~1GB 仍走原分页查看器，避免一次性替换影响现有冒烟口径。
const HUGE_SCROLL_THRESHOLD = 1024 * 1024 * 1024;
// 该阈值的**可变运行时值**：默认恒等于上面的常量（无调用方时行为与硬编码完全一致）。
// 存在的唯一理由是测试面：冒烟夹具里唯一 >1GB 的文件是 3.9GB 稀疏 NUL（二进制、不可编辑），
// 而 280MB 真实文本夹具按默认阈值会分档到 viewer-lg —— 想覆盖「huge 视口内编辑」只能在
// 用例内部临时降阈值（见 editor.setHugeThresholdMB，dev 测试面）。**每个用例必须 set→断言→恢复**，
// 否则后续边界用例的档位预期会被打乱。
let hugeScrollThreshold = HUGE_SCROLL_THRESHOLD;
const VIEWER_WINDOW = 8 * 1024 * 1024;        // 窗口大小（字节）
const VIEWER_STEP = 6 * 1024 * 1024;          // 翻页步进（字节，2MB 重叠）
const VIEWER_EDIT_MAX = 40 * 1024 * 1024;     // 区域编辑窗口上限（字节）

function chunkMarker(tab) {
  const c = tab && tab.chunk;
  if (!c || c.complete) return '';
  return `\n<!-- MH-CHUNKED 已加载 ${formatSize(c.loaded)} / ${formatSize(c.size)}，滚动到底部自动加载更多 -->\n`;
}

/** 字节编码检测（与主进程 detectEncoding 同序：UTF-8 → GBK → windows-1252） */
function detectEncodingBytes(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    try {
      new TextDecoder('gbk').decode(bytes);
      return 'gbk';
    } catch {
      return 'windows-1252';
    }
  }
}

/** 首段解码：检测编码并建立流式解码器（后续段用同一 decoder，正确处理分块边界截断的多字节字符） */
function decodeFirstChunk(bytes, tab) {
  const enc = detectEncodingBytes(bytes);
  tab.chunk.encoding = enc;
  tab.chunk.decoder = new TextDecoder(enc, { stream: true });
  return tab.chunk.decoder.decode(bytes, { stream: true });
}

// ---------- 匹配高亮（文件内搜索用） ----------
export const matchEffect = StateEffect.define();
export const matchField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(matchEffect)) v = e.value;
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ============================================================================
// 0.5.0 多视图 Phase 3：同一文档多视图的**变更广播**（G2）
// ----------------------------------------------------------------------------
// 三层职责（0.3.0 §2.2/§2.3）：
//   Document（= tab 对象本身）· 内容真源 = tab.state（基线）；tab.dirty 是**文档级**
//   Pane     · 每栏一个 EditorView，各自持**独立 EditorState**（光标/选区/折叠天然独立）
//   View     · 靠广播保持一致；state 对象**永不共享**
//
// 三条不可动摇的口径（写死在代码里，改动前先读施工简报 §3）：
//  ① **逐事务派发**：用 `u.transactions`（数组）而不是 `u.changes`。`tr.changes` 的坐标是
//     相对**该事务之前的文档**的；把它直接喂给"落后 N 个事务"的视图会坐标错位。按顺序
//     逐个 `dispatch({ changes: tr.changes })` 才是正确等价。
//  ② **接收方不回播**：远端注解 `remoteAnnotation` 挂在派发上，接收方的 updateListener 靠它
//     识别"这是远端来的"，只推进基线、不再广播 —— 这是**唯一的防环凭据**。
//  ③ **接收方保持 CM 默认历史**（不加 addToHistory:false）：因此"某一栏的撤销可能撤掉另一栏
//     刚输入的内容"是**当前语义**（0.3.0 §2.4 已判死刑：不做自研历史合并），
//     由冒烟 sameFileUndo 明确断言 + 首次分屏给一次性提示。
// ============================================================================
/** 远端变更注解（防环凭据；只在本文件内使用，不进 docmodel） */
const remoteAnnotation = Annotation.define();

/** 按 Document 串行的广播队列：key = doc，value = 链尾 Promise（空闲时删键，防 map 只增不减） */
const bcastQueue = new Map();
function enqueueBroadcast(doc, fn) {
  const prev = bcastQueue.get(doc) || Promise.resolve();
  const next = prev.then(fn, fn); // 失败不打断链（fn 内部自带 try/catch）
  bcastQueue.set(doc, next);
  next.then(
    () => { if (bcastQueue.get(doc) === next) bcastQueue.delete(doc); },
    () => { if (bcastQueue.get(doc) === next) bcastQueue.delete(doc); }
  );
  return next;
}

/** 把「本地视图刚发生的一批事务」逐个派发到另一个视图上（坐标空间见 §①） */
function applyTransactionsToView(view, trs) {
  if (!view || view.isDestroyed) return false;
  try {
    for (const tr of trs) {
      const anns = [remoteAnnotation.of(true)];
      // 程序化变更（分段预读 / 外部重载）本就不进历史：远端也要保持同一口径，
      // 否则接收侧会多出一条可撤销记录（撤销后两栏内容不再一致）
      if (tr.annotation(Transaction.addToHistory) === false) anns.push(Transaction.addToHistory.of(false));
      view.dispatch({ changes: tr.changes, annotations: anns });
    }
    return true;
  } catch (err) {
    // 广播失败（视图已销毁 / 已切走）静默跳过，绝不向上抛
    console.warn('[broadcast]', err && err.message ? err.message : err);
    return false;
  }
}

function langExt(lang) {
  if (lang === 'markdown') return markdown();
  if (lang === 'python') return python();
  if (lang === 'json') return json();
  return [];
}

// 简约清新浅色主题（表层 var() 化：data-theme 一变即整体换肤，无需 JS 重配）
const lightTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--mh-bg-panel)', color: 'var(--mh-text)' },
  '.cm-content': { caretColor: 'var(--mh-accent)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-search-match': { backgroundColor: 'var(--mh-accent-soft)', borderRadius: '2px' },
  '.cm-search-current': { backgroundColor: 'var(--mh-accent)', color: 'var(--mh-accent-content)', borderRadius: '2px', outline: '1px solid var(--mh-accent)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--mh-accent-soft)', outline: '1px solid color-mix(in oklab, var(--mh-accent) 60%, var(--mh-bg-panel))' },
  '.cm-tooltip': { border: '1px solid var(--mh-border)', borderRadius: '8px', boxShadow: '0 6px 20px rgba(16,42,84,.12)' },
});

export function createEditor(callbacks) {
  /** 栏容器（0.5.0 Phase 2 起，index.html 里只剩这一个挂载点，各栏 DOM 由 buildPaneDom 模板生成） */
  const panesRoot = document.getElementById('editor-panes');
  const { onDocChanged, onTabSwitch, onTabLeave, onRequestClose, getWordWrap, onSaveStatus, onSessionChange, getIndentSize, getMaxFileSizeMB, onCursorMove } = callbacks;

  // 文档集合与活动指针由 docmodel.js 的注册表持有（0.5.0 多视图 Phase 1；Phase 2 扩为「每栏一份活动指针」）。
  // 行为中性要点：注册表里装的就是下面这些 tab 对象**本身**（同一引用），没有对象搬家、没有代理；
  // 字段名（kind/huge/vwin/chunk/dirty/…）与读写语义一个字都没改。
  const registry = createDocRegistry();
  /** 标签顺序数组（= 注册表内部那个数组本身；原地写会立刻被全窗口看到） */
  const docs = () => registry.list();
  let idSeq = 0;
  let wordWrapOn = getWordWrap();

  // ---------- 0.5.0 Phase 4：跨窗口编辑权（L2 接管 / L3 冲突提示）的渲染端状态 ----------
  /** path → { mode:'edit'|'read', owner:winId|null, sharedEdit:boolean, freed:boolean }
   *  **只记"主进程锁表告诉过我的事实"**，不猜：来源有三条 ——
   *    ① file-shared-open（本窗口是后来者 → read）；
   *    ② file-lock-changed（claim 抢权/被降级/编辑权空闲）；
   *    ③ claimEdit/releaseEdit 的 invoke 返回值（本窗口主动动作）。
   *  没有登记 = 本窗口是编辑权持有者（首个打开者，主进程侧 mode='edit'）。 */
  const lockStates = new Map();
  /** L3 开关的渲染端缓存（真值在**主进程** filewatch.js；默认关）。变更前会重新问主进程。 */
  let conflictPromptOn = false;

  // ==========================================================================
  // 0.5.0 Phase 2：左右双栏编辑区（硬上限 2 栏）
  // --------------------------------------------------------------------------
  // 每栏 = 一套完整的编辑视图：自己的标签栏 + 自己的 EditorView + 自己的
  // image/diff/viewer/preview 宿主（见 buildPaneDom）。关键不变量：
  //   · **单文档单栏**：一个 tab 只属于一个 pane（registry.setPaneOf），openFile 命中已开文件时
  //     直接聚焦到它所在的栏并提示 —— 因此「同一文件同时开在两栏」这种组合在本阶段**不会出现**
  //     （真·同文件多视图同步是 Phase 3 的 G2，本阶段刻意不做）。
  //   · **p0 沿用历史 ID**（#tabs / #editor-host / #image-host / #diff-host / #viewer-bar /
  //     #split-divider / #preview-host / #preview-content / #zoom-badge / #editor-empty）：
  //     find.js / preview.js / globalsearch.js / 冒烟里所有按 ID 取值的地方在单栏下一字不用改；
  //     p1 只用 class 定位，DOM 结构与 p0 完全对称。
  //   · **焦点栏** focusPaneId 决定：状态栏显示谁、Ctrl+S 保存谁、onTabSwitch（→ 预览/树跟随）为谁触发、
  //     新打开的文件进哪一栏、`getView()` 返回哪个 EditorView。
  // ==========================================================================
  const MAX_PANES = 2;
  /** @type {Array<object>} 栏数组（panes[0] 恒存在；顺序 = 屏幕从左到右） */
  const panes = [];
  /** 双栏宽度比例（拖分隔条时更新；Phase 2 只在内存里，持久化属 Phase 3 的 layout） */
  let paneRatio = 0.5;
  /** 粘在鼠标上的拖拽标签（拖到编辑区左/右边缘 → 该侧开栏） */
  let dragTab = null;

  /** 栏查找：按 id；找不到回退焦点栏 / 首栏（永不返回 undefined，避免调用点到处判空） */
  function paneById(id) {
    return panes.find((p) => p.id === id) || null;
  }
  function focusedPane() {
    return paneById(registry.focusPane()) || panes[0];
  }
  /** 文档所属栏（未登记时回退焦点栏） */
  function paneOfDoc(doc) {
    return paneById(registry.paneOf(doc)) || focusedPane();
  }
  /** 文档所在栏的 EditorView（huge/图片/对比标签下它是空文档占位，语义同 Phase 1） */
  function viewOfDoc(doc) {
    return paneOfDoc(doc).view;
  }
  /** 焦点栏的 EditorView —— `getView()` / 状态栏 / 粘贴等「跟着焦点走」的路径用它 */
  function focusedView() {
    return focusedPane().view;
  }
  /** 该栏是否就是焦点栏 */
  function isFocusedPane(pane) {
    return !!pane && pane === focusedPane();
  }
  /** 栏引用解析：数字按屏幕顺序（0/1），字符串按栏 id（'p0'/'p1'）；非法返回 null */
  function paneByRef(ref) {
    if (typeof ref === 'number') return panes[ref] || null;
    if (typeof ref === 'string' && ref) return paneById(ref);
    return null;
  }
  /** 承载该文档的全部栏（Phase 3：同一文件两栏时为 2 个；顺序 = 屏幕从左到右） */
  function panesOfDoc(doc) {
    if (!doc) return [];
    const ids = registry.panesOf(doc);
    return panes.filter((p) => ids.indexOf(p.id) >= 0);
  }
  /** 「主视图」= 当前**真正承载**该文档的那个视图：优先焦点栏，其次第一个承载它的栏。
   *  用途：文档级的视图操作（只读热切换 / 分段追加 / 指针判据）要落到"用户正在看的那个视图"。
   *  注意与 `viewOfDoc(doc)` 的区别：后者恒取**主栏**（`paneOf`），多视图下可能不是焦点栏。 */
  function primaryViewOf(doc) {
    if (!doc) return null;
    const fp = focusedPane();
    if (fp && !fp.view.isDestroyed && registry.docOfView(fp.view) === doc) return fp.view;
    for (const p of panesOfDoc(doc)) {
      if (p.view && !p.view.isDestroyed && registry.docOfView(p.view) === doc) return p.view;
    }
    return null;
  }

  // ---------- 缩进设置（Tab 键插入的空格数，1~8） ----------
  function clampIndent(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return 4;
    return Math.min(8, Math.max(1, v));
  }

  let indentSize = clampIndent(getIndentSize ? getIndentSize() : 4);
  // 输入法组合期间 Tab 不触发缩进（Phase 2：组合状态是**每视图**的，用 WeakSet 按 view 记）
  const composingViews = new WeakSet();

  const langCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const indentCompartment = new Compartment();
  const readOnlyCompartment = new Compartment(); // viewer-lg 只读 ↔ 区域编辑切换

  function trailingSpaces(text, max) {
    let n = 0;
    for (let i = text.length - 1; n < max && i >= 0 && text[i] === ' '; i--) n++;
    return n;
  }

  function leadingSpaces(text, max) {
    let n = 0;
    while (n < max && n < text.length && text[n] === ' ') n++;
    return n;
  }

  /** Tab：光标处插入 indentSize 个空格（行首/行中一致）；有选区时对选区每行行首插入。
   *  用 changeByRange 逐范围处理：光标/选区经 mapPos(assoc=1) 映射到插入内容之后（与 CM 自带 indentMore 一致）。 */
  function indentMore(view) {
    if (composingViews.has(view)) return false;
    const size = indentSize;
    const { state } = view;
    if (state.readOnly) return false;
    const spec = state.changeByRange((range) => {
      const changes = [];
      if (range.empty) {
        changes.push({ from: range.head, insert: ' '.repeat(size) });
      } else {
        let pos = range.from;
        while (pos <= range.to) {
          const line = state.doc.lineAt(pos);
          changes.push({ from: line.from, insert: ' '.repeat(size) });
          pos = line.to + 1;
        }
      }
      const cs = state.changes(changes);
      return {
        changes,
        range: EditorSelection.range(cs.mapPos(range.anchor, 1), cs.mapPos(range.head, 1)),
      };
    });
    view.dispatch(spec);
    return true;
  }

  /** Shift+Tab：删除光标前（或选中行行首）最多 indentSize 个连续空格；无空格可删时不动作 */
  function indentLess(view) {
    if (composingViews.has(view)) return false;
    const size = indentSize;
    const { state } = view;
    if (state.readOnly) return false;
    let updated = false;
    const spec = state.changeByRange((range) => {
      const changes = [];
      if (range.empty) {
        const line = state.doc.lineAt(range.head);
        const before = state.doc.sliceString(Math.max(line.from, range.head - size), range.head);
        const n = trailingSpaces(before, size);
        if (n > 0) {
          changes.push({ from: range.head - n, to: range.head, insert: '' });
          updated = true;
        }
      } else {
        let pos = range.from;
        while (pos <= range.to) {
          const line = state.doc.lineAt(pos);
          const head = state.doc.sliceString(line.from, Math.min(line.to + 1, line.from + size));
          const n = leadingSpaces(head, size);
          if (n > 0) {
            changes.push({ from: line.from, to: line.from + n, insert: '' });
            updated = true;
          }
          pos = line.to + 1;
        }
      }
      const cs = state.changes(changes);
      return {
        changes,
        range: EditorSelection.range(cs.mapPos(range.anchor, 1), cs.mapPos(range.head, 1)),
      };
    });
    if (!updated) return false;
    view.dispatch(spec);
    return true;
  }

  /** 缩进相关扩展：tabSize 同步 + 高优先级 Tab/Shift+Tab keymap（覆盖默认 keymap） */
  function indentExtensions(size) {
    return [
      EditorState.tabSize.of(size),
      Prec.highest(
        keymap.of([
          { key: 'Tab', run: indentMore },
          { key: 'Shift-Tab', run: indentLess },
        ])
      ),
    ];
  }

  function makeState(doc, lang, readOnly = false, wrap = null) {
    // wrap：null=跟随全局设置；false=强制不换行（viewer-lg —— 超长单行在 wrap 模式下
    // CM 视口测量复杂度爆炸，8MB 单行曾致渲染进程内存失控）
    const wrapOn = wrap === null ? wordWrapOn : wrap;
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        lightTheme,
        langCompartment.of(langExt(lang)),
        wrapCompartment.of(wrapOn ? EditorView.lineWrapping : []),
        indentCompartment.of(indentExtensions(indentSize)),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        // 查找替换统一走底部大面板（find.js）：拦截 CM 内置搜索小窗（Mod-f 默认弹右上角小框，
        // 返回 true 仅阻止默认行为、不拦截冒泡 → app.js 的 document 级 Ctrl+F 处理仍会打开底部面板）
        Prec.highest(keymap.of([{ key: 'Mod-f', run: () => true }])),
        matchField,
        EditorView.updateListener.of((u) => {
          // 归属判定（0.5.0 多视图 Phase 2 的 C1 根治）：**由派发该事务的视图反查所属文档**。
          // Phase 1 之前这里闭包捕获全局 activeTab —— 双栏下 B 栏打字会把 B 的内容写进 A 栏文档
          // （清单文档 §4.2-C1「最致命」）。现在每个 pane 的 EditorView 在 switchTab 时
          // registry.bindView(pane.view, 该栏活动文档)，关栏时 unbindView，因此 `u.view` 是谁
          // 就只回写谁 —— 双栏互不串写。
          const t = registry.docOfView(u.view);
          const fromOwnView = !!t;
          if (u.docChanged && t) {
            try {
              // Phase 3 分叉（施工简报 §3.2）：远端变更 → 只推进基线、**不回播**；
              // 本地输入 → 先提交基线，再按文档串行队列广播给**同一文档的其它视图**。
              const isRemote = u.transactions.some((tr) => tr.annotation(remoteAnnotation));
              // 程序化变更（分段预读 / 外部重载 / viewer 换窗）带 addToHistory:false，广播时
              // 一并传给接收侧；这类变更**不是用户编辑**，接收侧不能把文档重新标脏
              // （否则发起侧刚 markDirty(false)，远端分支又点亮 → 无谓的自动保存，甚至把
              //  只加载了一半的分段标签写盘）。
              const programmatic = u.transactions.every((tr) => tr.annotation(Transaction.addToHistory) === false);
              if (!(isRemote && programmatic)) registry.markDirty(t);
              if (isRemote) {
                // ① 远端：内容基线推进一步，**不回播**（防环）；也不做"用户输入"语义的动作。
                t.state = u.state;
              } else {
                // ② 本地用户输入：提交基线 + 广播。事务数组必须**在入队前**取好（u.transactions
                //    是本次 update 的数组，闭包持有到队列执行时）
                const trs = u.transactions.slice();
                t.state = u.state;
                enqueueBroadcast(t, () => {
                  for (const other of registry.viewsOf(t)) {
                    if (other === u.view || other.isDestroyed) continue;
                    // 逐事务派发（坐标空间见本文件顶部的 §①）
                    applyTransactionsToView(other, trs);
                  }
                });
              }
              updateTabBadges(); // O1：只更新圆点/激活态，不重建标签栏
              updateStatusBar();
              onDocChanged(t);
            } catch (err) {
              console.error('[doc-change]', err && err.stack ? err.stack : err);
              throw err;
            }
          }
          if (u.selectionSet && fromOwnView && t && !t.kind) updateStatusBar();
          // 0.5.0 Phase 5a B1：光标/内容变化的统一出口（大纲随光标高亮用）。
          // 判据同上：**由派发事务的视图反查所属文档**，多视图下不会拿错文档。
          if (fromOwnView && t && (u.docChanged || u.selectionSet)) {
            try {
              let line = 0;
              try { line = u.state.doc.lineAt(u.state.selection.main.head).number; } catch { line = 0; }
              if (onCursorMove) onCursorMove(t, line, u.docChanged === true);
            } catch { /* 大纲等旁路异常绝不影响编辑主链路 */ }
          }
        }),
      ],
    });
  }

  // ---------- 栏 DOM 模板（模板函数化：p0 挂历史 ID，p1 只用 class） ----------
  /** 跨窗口编辑权横幅（Phase 4）：只读观察窗的**显性**入口 —— 按钮在横幅上，不藏在标签右键。
   *  两种形态（见 updateLockBanner）：① 本窗口只读（另一窗口持编辑权）→ 文案 + 「✏️ 接管编辑」；
   *  ② 多窗口同时可编辑（L3 开关打开）→ 只提示冲突风险，不显示接管按钮。 */
  function buildLockBar() {
    const bar = document.createElement('div');
    bar.className = 'lock-banner hidden';
    bar.innerHTML =
      '<span class="lock-text"></span>' +
      '<button class="tbtn small lock-claim" type="button" title="把编辑权移到本窗口（原窗口转为只读）">✏️ 接管编辑</button>';
    return bar;
  }

  /** 跨窗口编辑冲突横幅（Phase 4 L3，**默认关**）：用 DOM 横幅而不是原生对话框 ——
   *  原生 showMessageBox 会阻塞窗口（冒烟也会被挂住），0.3.0 §2.6 亦要求"不弹原生对话框"。 */
  function buildConflictBar() {
    const bar = document.createElement('div');
    bar.className = 'conflict-banner hidden';
    bar.innerHTML =
      '<span class="conflict-text"></span>' +
      '<button class="tbtn small conflict-keep" type="button" title="保留本窗口未保存的内容">保留本窗口</button>' +
      '<button class="tbtn small conflict-load" type="button" title="丢弃本窗口改动，载入对方保存的版本">载入对方</button>';
    return bar;
  }

  /** 建一栏的 DOM 骨架。first=true 时给宿主挂上历史 ID（冒烟与既有模块按 ID 取值的地方零改动）。 */
  function buildPaneDom(first) {
    const root = document.createElement('div');
    root.className = 'pane';
    const tabsEl = document.createElement('div');
    tabsEl.className = 'tabs pane-tabs';
    const body = document.createElement('div');
    body.className = 'editor-wrap pane-body';
    const el = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
    const lockBar = buildLockBar();
    const conflictBar = buildConflictBar();
    const host = el('editor-host');
    const imageHost = el('image-host hidden');
    const diffHost = el('diff-host hidden');
    const viewerBar = el('viewer-bar hidden');
    viewerBar.innerHTML =
      '<button class="tbtn small" data-vb="prev" title="上一窗口">⏪</button>' +
      '<span class="viewer-pos"></span>' +
      '<button class="tbtn small" data-vb="next" title="下一窗口">⏩</button>' +
      '<button class="tbtn small" data-vb="jump" title="跳转到百分比或字节偏移">📍 跳转</button>' +
      '<button class="tbtn small" data-vb="edit" title="编辑当前窗口内容（保存时写回原位置）">✏️ 启用区域编辑</button>' +
      '<button class="tbtn small" data-vb="extract" title="把当前窗口内容另存为新文件（可正常编辑）">📤 提取为新文件</button>';
    const divider = el('split-divider hidden');
    const previewHost = el('preview-host hidden');
    const zoomBadge = el('zoom-badge hidden');
    zoomBadge.textContent = '100%';
    const previewContent = el('markdown-body');
    previewHost.append(zoomBadge, previewContent);
    const empty = el('editor-empty');
    empty.innerHTML = '<div class="empty-icon">✍</div><p>从左侧打开一个文件开始编辑</p><p class="empty-sub">支持 .md / .txt / .json / .py</p>';
    body.append(host, imageHost, diffHost, viewerBar, divider, previewHost, empty);
    // ---------- 0.5.0 Phase 5a A3：标签栏溢出处理（▾ 全部标签下拉） ----------
    // 挂在 .pane 上（.pane 已是 position:relative）而不是 .tabs 内：renderPaneTabs 每次都
    // 清空 .tabs 的 innerHTML，放里面会被反复重建；挂外面还能躲开标签栏的横向滚动（不会被卷走）。
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'tabs-more';
    moreBtn.textContent = '▾';
    moreBtn.title = '全部标签（此栏）';
    const tabsMenu = el('tabs-menu hidden');
    // 横幅在标签栏之下、编辑体之上（两栏各一份：每栏的活动文档可能来自不同文件、锁态不同）
    root.append(tabsEl, moreBtn, tabsMenu, lockBar, conflictBar, body);
    if (first) {
      // p0 = 历史单栏形态：ID 一字不改（find.js/preview.js/globalsearch.js/冒烟全部按 ID 取值）
      tabsEl.id = 'tabs';
      lockBar.id = 'lock-banner';
      conflictBar.id = 'conflict-banner';
      host.id = 'editor-host';
      imageHost.id = 'image-host';
      diffHost.id = 'diff-host';
      viewerBar.id = 'viewer-bar';
      divider.id = 'split-divider';
      previewHost.id = 'preview-host';
      zoomBadge.id = 'zoom-badge';
      previewContent.id = 'preview-content';
      empty.id = 'editor-empty';
      moreBtn.id = 'tabs-more';
      tabsMenu.id = 'tabs-menu';
      viewerBar.querySelector('.viewer-pos').id = 'viewer-pos';
      const vbid = { prev: 'btn-viewer-prev', next: 'btn-viewer-next', jump: 'btn-viewer-jump', edit: 'btn-viewer-edit', extract: 'btn-viewer-extract' };
      for (const [k, id] of Object.entries(vbid)) viewerBar.querySelector(`[data-vb="${k}"]`).id = id;
    }
    return { root, tabsEl, moreBtn, tabsMenu, lockBar, conflictBar, body, host, imageHost, diffHost, viewerBar, divider, previewHost, previewContent, zoomBadge, empty };
  }

  /** 建一栏：DOM + 独立的 EditorView + 该栏的宿主级事件绑定 */
  function createPane() {
    const isFirst = panes.length === 0;
    const dom = buildPaneDom(isFirst);
    /** @type {any} */
    const pane = {
      // 栏 id 由**当前栏数**决定：单栏恒 'p0'，第二栏恒 'p1'（合并后再分栏仍是同一套 id，
      // 便于 Ctrl+1/2 与冒烟断言稳定；宿主 DOM 每次新建，引用不会串）
      id: 'p' + panes.length,
      ...dom,
      view: null,
      viewerPos: dom.viewerBar.querySelector('.viewer-pos'),
      btnViewerEdit: dom.viewerBar.querySelector('[data-vb="edit"]'),
      tabBadges: new Map(), // 该栏的 tab → 元素（O1 徽标增量更新按栏各一份）
      ratio: 0.5,
      conflictTab: null,    // 冲突横幅当前指向的文档（Phase 4 L3）
    };
    // A3：本栏的溢出下拉按钮与菜单（DOM 在 buildPaneDom 里建好，事件在这里绑 —— 每栏各一份）
    pane.moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTabsMenu(pane);
    });
    pane.moreBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    // A3：滚轮横滚 —— 竖向滚轮换算成横向滚动（原生要 Shift+滚轮，用户不知道；触控板横滚照旧）。
    // 只在真的溢出时拦截，未溢出时把事件让回给页面（不改变既有行为）。
    pane.tabsEl.addEventListener('wheel', (e) => {
      const el = pane.tabsEl;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!dx) return;
      e.preventDefault();
      el.scrollLeft += dx;
    }, { passive: false });
    // 视图归属靠 updateListener 里的 registry.docOfView(u.view) —— 每个 pane 一个 EditorView
    pane.view = new EditorView({ parent: dom.host, state: makeState('', 'text') });
    // 输入法组合开始/结束：期间 Tab 不触发缩进插入（每视图一份状态）
    pane.view.dom.addEventListener('compositionstart', () => { composingViews.add(pane.view); });
    pane.view.dom.addEventListener('compositionend', () => { composingViews.delete(pane.view); });
    // 等宽字体加载完成后强制重新测量：防止字体未就绪导致字符宽度缓存错误
    // （会造成同一行内鼠标选择的坐标映射异常，而跨行选择不受影响）
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { try { pane.view.requestMeasure(); } catch { /* 已销毁 */ } });
    }
    // P7：分段模式预读 —— 该栏活动标签滚动接近底部时自动加载下一段（dispatch 追加，保持光标/滚动）；
    // viewer-lg：滚动到窗口边缘自动翻页。C12：判据从「全局活动标签」改为「**这个 view 自己的文档**」。
    pane.view.scrollDOM.addEventListener('scroll', () => {
      const cur = registry.docOfView(pane.view);
      if (!cur) return;
      if (cur.kind === 'chunked') maybeAutoLoad(cur);
      else if (cur.kind === 'viewer-lg') maybeSlideViewer(cur);
    }, { passive: true });
    // 图片标签页：左键拖拽平移查看（放大后）—— 每栏一份宿主，监听也每栏一份
    pane.imageHost.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return; // 不干扰工具栏按钮
      e.preventDefault();
      imgDrag = { x: e.clientX, y: e.clientY, sl: pane.imageHost.scrollLeft, st: pane.imageHost.scrollTop, pane };
      pane.imageHost.classList.add('dragging');
      setFocusPane(pane.id, { silent: true });
    });
    // 粘贴图片：保存到该栏当前文件同目录并插入 markdown 引用（M 类：发起粘贴的那个视图所属文档）
    pane.view.dom.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      const cur = registry.docOfView(pane.view);
      if (!items || !cur) return;
      const images = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) images.push(item);
      }
      if (images.length === 0) return;
      e.preventDefault();
      pasteImages(images, pane);
    });
    // 编辑器右键菜单：粘贴为纯文本（仅文本编辑区生效：图片标签页不弹该菜单）
    pane.view.dom.addEventListener('contextmenu', (e) => {
      const cur = registry.docOfView(pane.view);
      if (!cur || cur.kind === 'image') return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: '📋 粘贴为纯文本',
          onClick: async () => {
            const t = await window.api.readClipboardText();
            if (!t) {
              const { toast } = await import('./ui.js');
              toast('剪贴板为空或不是文本');
              return;
            }
            insertAtCursor(t, pane);
          },
        },
      ]);
    });
    // 查看器横幅按钮（DOM 在本栏，逻辑归编辑器模块）
    pane.lockBar.querySelector('.lock-claim').addEventListener('click', () => {
      const t = registry.activeOf(pane.id);
      if (t) claimEdit(t);
    });
    pane.conflictBar.querySelector('.conflict-keep').addEventListener('click', () => hideConflictBanner(pane));
    pane.conflictBar.querySelector('.conflict-load').addEventListener('click', async () => {
      const t = pane.conflictTab || registry.activeOf(pane.id);
      hideConflictBanner(pane);
      if (t) await reloadFromDisk(t, false); // 丢弃本地改动、载入对方版本（显式动作，绝不自动做）
    });
    pane.viewerBar.querySelector('[data-vb="jump"]').addEventListener('click', () => {
      const t = registry.activeOf(pane.id);
      if (!t || t.kind !== 'viewer-lg') return;
      showPrompt('跳转位置', '百分比（如 50%）或字节偏移（如 1.5G / 500M / 1600000000）', '', (v) => viewerJump(t, v));
    });
    pane.btnViewerEdit.addEventListener('click', () => {
      const t = registry.activeOf(pane.id);
      if (!t || t.kind !== 'viewer-lg') return;
      setViewerEditing(t, !t.editing);
    });
    pane.viewerBar.querySelector('[data-vb="prev"]').addEventListener('click', () => {
      const t = registry.activeOf(pane.id);
      if (t && t.kind === 'viewer-lg') slideViewer(t, -1);
    });
    pane.viewerBar.querySelector('[data-vb="next"]').addEventListener('click', () => {
      const t = registry.activeOf(pane.id);
      if (t && t.kind === 'viewer-lg') slideViewer(t, +1);
    });
    // ②e：提取当前窗口内容为新文件（同目录另存 → 正常打开编辑；二进制窗口禁用）
    pane.viewerBar.querySelector('[data-vb="extract"]').addEventListener('click', () => {
      const t = registry.activeOf(pane.id);
      if (!t || t.kind !== 'viewer-lg') return;
      if (t.vwin.binary) {
        toast('二进制窗口内容不含可提取的文本（控制字符已替换显示）');
        return;
      }
      const stem = t.name.replace(/\.[^.]+$/, '') || 'extract';
      showPrompt(
        '提取为新文件',
        '文件名（保存到当前文件所在目录）',
        `extract-${stem}-${Math.floor(t.vwin.offset / 1048576)}MB.txt`,
        async (val) => {
          const p = dirOf(t.path) + '\\' + val;
          await window.api.writeFile(p, t.state.doc.toString());
          toast('已提取：' + val);
          openFile(p);
        }
      );
    });
    // 焦点栏判定：栏内任意 mousedown / focusin 都把焦点栏切到本栏（capture 阶段，先于 CM 的默认处理）
    pane.root.addEventListener('mousedown', () => setFocusPane(pane.id, { silent: true }), true);
    pane.root.addEventListener('focusin', () => setFocusPane(pane.id, { silent: true }));
    // 拖标签到编辑区左/右边缘 → 该侧开栏（dragTab 由 renderTabs 的 dragstart 设置）
    pane.body.addEventListener('dragover', (e) => {
      if (!dragTab) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const side = dropSideOf(pane, e.clientX);
      pane.body.classList.toggle('pane-drop-left', side === 'left');
      pane.body.classList.toggle('pane-drop-right', side === 'right');
    });
    pane.body.addEventListener('dragleave', () => {
      pane.body.classList.remove('pane-drop-left', 'pane-drop-right');
    });
    pane.body.addEventListener('drop', (e) => {
      const side = dropSideOf(pane, e.clientX);
      pane.body.classList.remove('pane-drop-left', 'pane-drop-right');
      if (!dragTab) return;
      e.preventDefault();
      e.stopPropagation();
      const t = dragTab;
      dragTab = null;
      moveTabToSide(t, pane, side);
    });
    panesRoot.appendChild(pane.root);
    panes.push(pane);
    return pane;
  }

  /** 拖放落点：编辑区左 30% / 右 30% 为「该侧开栏」，中间为「不改变布局」 */
  function dropSideOf(pane, clientX) {
    const r = pane.body.getBoundingClientRect();
    if (!r.width) return null;
    const x = clientX - r.left;
    if (x < r.width * 0.3) return 'left';
    if (x > r.width * 0.7) return 'right';
    return null;
  }

  // 首栏（p0）：与 Phase 1 的单栏形态逐位对应
  createPane();
  panes[0].root.classList.add('active-pane'); // 焦点栏去饱和类（单栏下 CSS 不生效，双栏时才有视觉差异）
  registry.setFocusPane(panes[0].id);
  // Phase 4：L3 冲突提示开关的真值在主进程（默认关）→ 启动时同步一次本地缓存
  // （决策路径不依赖缓存：file-changed 的 multiEdit 分支每次都重新问主进程）
  window.api.getConflictPrompt().then((on) => { conflictPromptOn = on === true; }).catch(() => { /* 忽略 */ });
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'pdf'];

  // ==========================================================================
  // 分栏控制：焦点栏 / 开栏 / 合栏 / 拖标签换栏 / 分隔条
  // ==========================================================================
  /** 每栏最小宽度（px）：拖分隔条时的夹取下限（容器过窄时退化为等分，见 initPaneDivider） */
  const MIN_PANE_PX = 200;
  /** 两栏之间的分隔条（栏数回到 1 时移除） */
  let paneDividerEl = null;

  /** 把焦点指针移到某栏：切 .active-pane 去饱和、通知状态栏/预览/树跟随（只对焦栏触发 onTabSwitch）。
   *  opts.focusView=false 用于 mousedown/focusin 路径（DOM 焦点由用户点击自然产生，避免抢焦点）。
   *  返回是否真的换了栏。 */
  function setFocusPane(paneId, opts = {}) {
    const pane = paneById(paneId);
    if (!pane) return false;
    const changed = registry.focusPane() !== pane.id;
    registry.setFocusPane(pane.id);
    for (const p of panes) p.root.classList.toggle('active-pane', p === pane);
    if (changed) {
      updateStatusBar();
      updateTabBadges();
      if (opts.notify !== false) {
        try { onTabSwitch(registry.activeOf(pane.id)); } catch (err) { console.warn('[pane-focus]', err && err.message ? err.message : err); }
      }
    }
    if (opts.focusView !== false) {
      try { pane.view.focus(); } catch { /* 视图已销毁 */ }
    }
    return changed;
  }

  /** 两栏宽度：paneRatio 作用在屏幕左侧那一栏（panes 数组顺序 = 屏幕从左到右）。
   *  左栏用 `flex: 0 0 <px>` 固定、右栏 `flex: 1 1 0` 吃掉剩余 —— 这样**分隔条的 6px 不会被算进 100%**
   *  （两边都写百分比会因 `flex-shrink:0` 溢出容器 6px，右栏被裁）。 */
  function layoutPanes() {
    // .split 类只服务「非焦点栏去饱和」的 CSS（单栏不留任何额外外观差异）
    panesRoot.classList.toggle('split', panes.length > 1);
    if (panes.length < 2) {
      if (panes[0]) panes[0].root.style.flex = '';
      updateAllTabsOverflow(); // A3：栏宽变了 → 溢出判据要跟着重算
      return;
    }
    const W = panesRoot.getBoundingClientRect().width;
    const divW = paneDividerEl ? paneDividerEl.getBoundingClientRect().width : 0;
    const usable = Math.max(0, W - divW);
    const r = Math.min(0.8, Math.max(0.2, paneRatio));
    panes[0].root.style.flex = `0 0 ${(r * usable).toFixed(2)}px`;
    panes[1].root.style.flex = '1 1 0';
    // A3：分栏/拖分隔条都会改栏宽 → 两栏各自的溢出判据都要重算（**按 pane** 是硬要求）
    updateAllTabsOverflow();
  }

  /** 两栏之间可用的净宽度（扣掉分隔条） */
  function paneUsableWidth() {
    const W = panesRoot.getBoundingClientRect().width;
    const divW = paneDividerEl ? paneDividerEl.getBoundingClientRect().width : 0;
    return Math.max(0, W - divW);
  }

  /** 建/复位两栏之间的分隔条（拖动改比例；双击等分） */
  function initPaneDivider() {
    if (paneDividerEl) return;
    const d = document.createElement('div');
    d.className = 'pane-divider';
    d.title = '拖动调整两栏宽度（双击等分）';
    panesRoot.insertBefore(d, panes[1].root);
    paneDividerEl = d;
    let dragging = false;
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      d.classList.add('dragging');
      const onMove = (ev) => {
        if (!dragging) return;
        const usable = paneUsableWidth();
        const r = panesRoot.getBoundingClientRect();
        if (!usable || !r.width) return;
        let ratio = (ev.clientX - r.left) / usable;
        // 最小宽度：两侧都不得窄于 MIN_PANE_PX（容器宽不到 2×MIN_PANE_PX 时退化为 [0.45,0.55] 的等分夹取）
        const lo = Math.min(0.45, MIN_PANE_PX / usable);
        const hi = Math.max(0.55, 1 - MIN_PANE_PX / usable);
        ratio = Math.min(hi, Math.max(lo, ratio));
        paneRatio = ratio;
        layoutPanes();
      };
      const onUp = () => {
        dragging = false;
        d.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    d.addEventListener('dblclick', () => { paneRatio = 0.5; layoutPanes(); });
  }

  /** 开第二栏并返回它（硬上限 2 栏）。side='left' 时新栏插在左侧（panes 顺序跟着变成屏幕顺序） */
  function createSidePane(side) {
    if (panes.length >= MAX_PANES) return null;
    const np = createPane();
    if (side === 'left') {
      panesRoot.insertBefore(np.root, panes[0].root);
      panes.unshift(panes.pop()); // 数组顺序 = 屏幕从左到右
    }
    initPaneDivider();
    layoutPanes();
    renderTabsAll();
    updateEmpty();
    return np;
  }

  /** 拆分/合并的键盘开关（Ctrl+\）：单栏 → 在右侧开一个空栏并聚焦；两栏 → 合并回单栏 */
  function toggleSplit() {
    if (panes.length >= MAX_PANES) return mergePanes();
    return !!openSecondPane('right');
  }

  /** 开第二栏（left/right）并聚焦它；单栏时 Ctrl+\ 与拖标签共用 */
  function openSecondPane(side) {
    const np = createSidePane(side || 'right');
    if (!np) return null;
    setFocusPane(np.id, { notify: true });
    return np;
  }

  /** 合并回单栏。**保留栏恒为 p0**（不按屏幕位置取）—— p0 是唯一挂历史 ID
   *  （#tabs / #editor-host / #image-host / #diff-host / #viewer-bar / #split-divider / #preview-host /
   *  #editor-empty）的那一栏，若在左分屏后被销毁，find.js / preview.js / 冒烟里所有按 ID 取值的
   *  地方会集体失联。另一栏的文档按顺序并回 p0，焦点与活动项落到「被合并栏的原活动文档」。 */
  function mergePanes() {
    if (panes.length < 2) return false;
    const keep = panes.find((p) => p.id === 'p0') || panes[0];
    const gone = panes.find((p) => p !== keep);
    if (!gone) return false;
    const keepActive = registry.activeOf(gone.id);
    for (const t of registry.docsOf(gone.id)) {
      // huge 视图的 DOM 根节点挂在被合并栏的宿主里，必须销毁后在保留栏重建
      if (t.kind === 'huge' && t.huge) {
        try { t.huge.destroy(); } catch { /* 已销毁 */ }
        t.huge = null;
        t.hugeEl = null;
      }
      registry.setPaneOf(t, keep.id);
    }
    registry.setActiveOf(keep.id, keepActive || registry.activeOf(keep.id));
    registry.setFocusPane(keep.id);
    if (paneDividerEl) { paneDividerEl.remove(); paneDividerEl = null; }
    registry.unbindView(gone.view);
    try { gone.view.destroy(); } catch { /* 忽略 */ }
    gone.root.remove();
    panes.splice(panes.indexOf(gone), 1);
    registry.forgetPane(gone.id);
    registry.setFocusPane(keep.id); // forgetPane 会清焦点指针，必须在其后重设
    paneRatio = 0.5;
    layoutPanes(); // 单栏：清掉内联 flex 与 .editor-panes 的 .split 类
    for (const p of panes) p.root.classList.toggle('active-pane', p === keep);
    renderTabsAll();
    const cur = registry.activeOf(keep.id);
    if (cur) {
      switchTab(cur);
    } else {
      registry.unbindView(keep.view);
      keep.view.setState(makeState('', 'text'));
      syncEditorLayer(keep, null);
      updateEmpty();
      updateStatusBar();
      onTabSwitch(null);
    }
    if (onSessionChange) onSessionChange();
    return true;
  }

  /** 撤掉一个**已空**的栏（关掉栏内最后一个标签 / 拖走最后一个标签时调用）→ 回落单栏。
   *  实现上直接复用 mergePanes（它保证保留 p0 的 DOM）：当空的是 p0 时，另一栏的文档会被并回 p0，
   *  净效果同样是「只剩一栏、内容不丢」。 */
  function removeEmptyPane(pane) {
    if (!pane || panes.length < 2) return false;
    if (registry.countIn(pane.id) > 0) return false; // 只撤空栏，避免误吞文档
    return mergePanes();
  }

  /** 拖标签落点处理。
   *  · 单栏：在落点那一侧开栏，把标签搬过去（**落在自己那一栏的边缘 = 分屏**，这是 G1 的主路径）；
   *  · 已有两栏：只有「拖到**另一栏**」才有意义（拖回自己那一栏不动作）；
   *  · 落在编辑区中间区域：本阶段不做标签排序（A4 属 0.5.1+），不动作。 */
  function moveTabToSide(tab, targetPane, side) {
    if (!tab || !targetPane) return false;
    const from = paneOfDoc(tab);
    if (panes.length < MAX_PANES) {
      if (!side) return false;
      const np = createSidePane(side);
      if (!np) return false;
      return moveTabToPane(tab, np);
    }
    if (from === targetPane) return false;
    return moveTabToPane(tab, targetPane);
  }

  /** 把标签搬到另一栏（单文档单栏：搬走后源栏不再持有它） */
  function moveTabToPane(tab, pane) {
    const from = paneOfDoc(tab);
    if (from === pane) return false;
    if (tab.kind === 'huge' && tab.huge) {
      // huge 根节点在被搬离那一栏的宿主里 → 销毁，等目标栏 switchTab 时按新宿主重建
      try { tab.huge.destroy(); } catch { /* 忽略 */ }
      tab.huge = null;
      tab.hugeEl = null;
    }
    // 源栏的活动指针若指向这个标签，必须先清掉：它已经不在这栏了，
    // 否则源栏的视图会继续显示它（双栏同时显示同一个文档），标签栏也会「没有任何高亮」
    const fromWasActive = registry.activeOf(from.id) === tab;
    registry.setPaneOf(tab, pane.id);
    if (fromWasActive) registry.setActiveOf(from.id, null);
    registry.setActiveOf(pane.id, tab);
    switchTab(tab);           // 目标栏渲染新活动文档
    // 焦点随后搬到目标栏：notify 必须开着，否则状态栏/预览/树跟随不会跟着这次拖拽更新
    setFocusPane(pane.id);
    // 源栏：空了就撤栏（回落单栏），否则把它的活动指针落到栏内剩余文档上
    const rest = registry.docsOf(from.id);
    if (rest.length === 0) {
      removeEmptyPane(from);
    } else if (!registry.activeOf(from.id)) {
      switchTab(rest[rest.length - 1]);
    } else {
      renderTabsAll();
    }
    updateEmpty();
    if (onSessionChange) onSessionChange();
    return true;
  }

  /** 公开的分栏测试面/键盘入口：Ctrl+\（分屏/合屏）、Ctrl+1/2（聚焦栏）、拖标签分屏共用 */
  function focusPaneByIndex(i) {
    const pane = panes[i];
    if (!pane) return false;
    return setFocusPane(pane.id, { notify: true }) || true; // 已是焦点栏也算成功
  }

  function paneLayoutInfo() {
    const w0 = panes[0] ? panes[0].root.getBoundingClientRect().width : 0;
    const w1 = panes.length > 1 ? panes[1].root.getBoundingClientRect().width : 0;
    return {
      count: panes.length,
      focused: registry.focusPane(),
      ratio: panes.length > 1 && w0 + w1 > 0 ? w0 / (w0 + w1) : 1,
      panes: panes.map((p) => ({
        id: p.id,
        active: (registry.activeOf(p.id) || {}).name || null,
        path: (registry.activeOf(p.id) || {}).path || null,
        docs: registry.countIn(p.id),
        width: Math.round(p.root.getBoundingClientRect().width),
        focused: registry.focusPane() === p.id,
      })),
    };
  }

  // ---------- 打开 / 切换 / 关闭 ----------
  /** 打开文件。opts.silent=true 时（会话恢复等批量路径）失败不弹 alertBox，仅 console.warn（L6）。
   *
   *  **「同一文件多视图」的入口（0.5.0 Phase 3 的 G2）**：
   *   · 默认（旧行为，Phase 2 起）：同一文件已在**另一栏**打开时**不新开视图**，把焦点切到
   *     它所在的栏并 toast —— 单文档单视图，不会出现"两份 state 互相打架"的半成品。
   *   · `opts.newView` / `opts.forceNew`：显式要求"本栏也开一个视图"→ 走 `attachViewToPane`，
   *     复用**同一个 Document**（同一份内容真源），在该栏新建一份独立 `EditorState`；
   *     标签栏的右键「⧉ 在另一栏打开」就是这个入口。
   *   · `opts.paneIndex`：把新文档放进指定栏（会话恢复用；已存在文档在该栏时只是激活它）。
   *  opts.silent（会话恢复）不弹 toast。 */
  async function openFile(path, opts = {}) {
    const existing = registry.byPath(path);
    if (existing) {
      const targetPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
      const homes = registry.panesOf(existing);
      if (homes.indexOf(targetPane.id) >= 0) {
        // 本栏已经有它的视图：纯激活（旧行为）。
        // `opts.paneIndex` 是**批量放置**路径（会话恢复）：逐个文档抢焦点会把 layout 的
        // focus 冲掉（最后一栏恒赢），因此批量路径只切标签、不动焦点指针。
        if (opts.paneIndex == null && registry.focusPane() !== targetPane.id) setFocusPane(targetPane.id, { notify: false });
        switchTab(existing, { pane: targetPane });
        return existing;
      }
      if (opts.newView || opts.forceNew) {
        const ok = attachViewToPane(existing, targetPane);
        if (ok) {
          if (registry.focusPane() !== targetPane.id) setFocusPane(targetPane.id, { notify: false });
        } else {
          // 拒绝（huge/viewer-lg 等「路径单例」文档）：回落"聚焦已有栏"，绝不产生第二个视图
          const home = paneOfDoc(existing);
          if (home && registry.focusPane() !== home.id) setFocusPane(home.id, { notify: false });
          switchTab(existing, { pane: home });
        }
        return existing;
      }
      // 默认：聚焦已有栏 + 提示，不新开视图（Phase 2 口径，冒烟 split* 依赖它）
      const home = paneOfDoc(existing);
      if (registry.focusPane() !== home.id) {
        setFocusPane(home.id, { notify: false });
        if (!opts.silent) toast(`「${existing.name}」已在另一栏打开，已切换到那一栏（同一文件不会同时占两栏）`);
      }
      switchTab(existing, { pane: home });
      return existing;
    }
    // 图片文件：以图片标签页打开（在编辑区查看，非详情弹窗）
    const ext = (String(path).split('.').pop() || '').toLowerCase();
    if (IMAGE_EXTS.includes(ext)) {
      return openImageTab(path, opts);
    }
    // P7：先 stat 判断大小 —— 超过阈值走分段模式；小文件路径与原先完全一致（readFile 全量）
    let st;
    try {
      st = await window.api.stat(path);
    } catch (err) {
      if (opts.silent) {
        console.warn('[openFile] 打开失败（已静默跳过）:', path, err && err.message ? err.message : err);
      } else {
        const { alertBox } = await import('./ui.js');
        alertBox('打开文件失败', String(err.message || err));
      }
      return null;
    }
    // v0.4.0：打开上限（设置里的 maxFileSizeMB）统一在这里把关 —— 分段读本身已不受总大小限制
    // （ipc.js 只按单次 ≤64MB 限流），所以拒绝逻辑必须前置，否则超大文件会被静默放行。
    const maxMB = (getMaxFileSizeMB && getMaxFileSizeMB()) || 50;
    if (st.size > maxMB * 1024 * 1024) {
      const { alertBox } = await import('./ui.js');
      alertBox('文件过大，未打开', `文件大小 ${(st.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${maxMB} MB，已拒绝打开（可在设置中调整上限）`);
      return null;
    }
    if (st.size > hugeScrollThreshold) {
      return openHugeTab(path, st, opts); // v0.4.0：>1GB 虚拟滚动查看器（连续滚动）
    }
    if (st.size > VIEWER_THRESHOLD) {
      return openViewerTab(path, st, opts); // 1B-2：>256MB 只读查看器（可区域编辑）
    }
    if (st.size > CHUNK_THRESHOLD) {
      return openChunkedTab(path, st, opts);
    }
    let data;
    try {
      data = await window.api.readFile(path);
    } catch (err) {
      if (opts.silent) {
        // L6：静默跳过（恢复流程不被逐个弹窗打断），保留 console.warn 供排查
        console.warn('[openFile] 打开失败（已静默跳过）:', path, err && err.message ? err.message : err);
      } else if (err && err.code === 'TOO_LARGE') {
        const { alertBox } = await import('./ui.js');
        alertBox('文件过大，未打开', err.message);
      } else {
        const { alertBox } = await import('./ui.js');
        alertBox('打开文件失败', String(err.message || err));
      }
      return null;
    }
    // 非 UTF-8 编码：提示保存后将转码为 UTF-8（仅首次打开提示一次）
    if (data.encoding && data.encoding !== 'utf-8') {
      const { toast } = await import('./ui.js');
      toast(`该文件为 ${data.encoding.toUpperCase()} 编码，保存后将转为 UTF-8`);
    }
    const tab = {
      id: ++idSeq,
      path,
      name: baseName(path),
      lang: langFor(path),
      state: null,
      dirty: false,
      saveTimer: null,
      pinned: false,
      crlf: /\r\n/.test(data.content), // 原文件行尾风格（CM6 会归一化为 LF，保存时按此还原）
    };
    tab.state = makeState(data.content, tab.lang);
    registry.add(tab);
    // 新文档进**目标栏**（缺省 = 焦点栏；Phase 3 的会话恢复会显式指定栏号）
    const newPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
    registry.setPaneOf(tab, newPane.id);
    switchTab(tab, { pane: newPane });
    window.api.watchFile(path, data.mtime); // 监听外部修改
    if (onSessionChange) onSessionChange();
    return tab;
  }

  // ---------- v0.4.0 Phase B：虚拟滚动查看器（>1GB） ----------
  /** 打开超大文件的连续滚动视图：只渲染视口行，滚动条跨度 = 整个文件。
   *  Phase D 第三步起：视图内可进入编辑态（overlay 块级 CoW，见 hugeview.js），
   *  能否编辑由主进程 huge:doc-open 的 editable 决定（GBK/二进制/超大单块 → 只读 + 原因）。 */
  async function openHugeTab(path, st, opts) {
    const tab = {
      id: ++idSeq,
      path,
      name: baseName(path),
      lang: langFor(path),
      kind: 'huge',
      hugeSize: st.size,   // 真实大小（虚拟滚动条跨度依赖它，避免挂载后再重建一次）
      state: null,
      dirty: false,         // 由 hugeview 的 onDirty 回调同步（脏标记的主进程权威值在 overlay 文档里）
      saveTimer: null,
      pinned: false,
      huge: null,           // createHugeView 实例（挂载时创建）
      readOnly: true,       // 未启用编辑前只读（编辑态由 huge.setEditable 切换）
    };
    registry.add(tab);
    // 新文档进**目标栏**（缺省 = 焦点栏；Phase 3 的会话恢复会显式指定栏号 —— 图片/分段/查看器/大文件
    // 标签同样要落在 layout 指定的那一栏，否则多栏会话恢复一次就漂移一次）
    const newPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
    registry.setPaneOf(tab, newPane.id);
    switchTab(tab, { pane: newPane });
    // 外部修改监听（与 viewer-lg / chunked 同口径；file-changed 过滤里已纳入 huge）
    try { await window.api.watchFile(path, st.mtimeMs || st.mtime); } catch { /* 监听失败不影响打开 */ }
    if (onSessionChange) onSessionChange();
    void opts;
    return tab;
  }

  /** 挂载/复用虚拟滚动视图（该栏活动标签为 huge 时调用）；单个实例，不再重建。
   *  Phase 2：宿主是该标签**所属栏**的 .editor-host —— 双栏下 A 栏开 huge 只让 A 栏的 CM 让位。 */
  function mountHuge(tab, pane) {
    if (tab.huge) return tab.huge;
    const before = new Set(pane.host.children);
    tab.huge = createHugeView(pane.host, {
      path: tab.path,
      size: tab.hugeSize || 0,
      onStatus: (msg) => {
        tab.hugeStatus = msg;
        if (msg) {
          const sb = document.getElementById('sb-len');
          if (sb) sb.textContent = msg;
        }
      },
      // Phase D 第三步：脏标记由 hugeview（主进程 overlay 文档）同步过来 —— 标签徽标/关闭确认
      // 依赖 tab.dirty，因此这里必须回写；同时刷新状态栏（脏计数文案）。
      onDirty: (d, count) => {
        registry.markDirty(tab, d === true);
        tab.hugeDirtyCount = count || 0;
        updateTabBadges();
        if (registry.isActive(tab)) updateStatusBar();
        if (onSessionChange) onSessionChange();
      },
    });
    // createHugeView 会同步把 .huge-view 根节点 append 到本栏的 .editor-host：取出本次新增的节点，
    // 供 CM ↔ huge 互斥显隐使用（多开 huge 标签时各自的根节点必须能单独控制）
    tab.hugeEl = Array.from(pane.host.children).find((el) => !before.has(el)) || null;
    return tab.huge;
  }

  /** 估算 huge 视图当前视口首行：hugeview 只暴露渲染窗起点（含上屏 overscan），减去一屏即视口首行 */
  function hugeTopLine(tab) {
    if (!tab || !tab.huge) return 1;
    let st = null;
    try { st = tab.huge.getState(); } catch { return 1; }
    if (!st || !st.rendered) return 1;
    const h = tab.hugeEl ? tab.hugeEl.clientHeight : 0;
    const per = Math.max(8, Math.ceil((h || 0) / (st.lineHeight || 20)) || 30); // 与 hugeview.render 同口径
    return Math.max(1, st.rendered.from + per);
  }

  /** 显示/隐藏某个 huge 标签的视图根节点；隐藏前记下视口首行（display:none 会清空 scrollTop） */
  function setHugeVisible(tab, visible) {
    if (!tab || !tab.hugeEl) return;
    if (!visible) {
      tab.hugeTopLine = hugeTopLine(tab);
      tab.hugeHidden = true;
      tab.hugeEl.style.display = 'none';
      return;
    }
    tab.hugeEl.style.display = '';
    if (tab.hugeHidden) {
      tab.hugeHidden = false;
      const line = tab.hugeTopLine; // 复位到离开时的视口首行（行号经主进程稀疏索引换算，精度足够）
      if (tab.huge && line > 1) Promise.resolve(tab.huge.gotoLine(line)).catch(() => { /* 已销毁 */ });
    }
  }

  /** 缺陷 1 修复：CM 的 .cm-editor（styles.css:576 height:100%）与 .huge-view（styles.css:1565
   *  height:100%）是 .editor-host（block + overflow:hidden）的**流内同级子元素** —— 两者同时可见时
   *  总高 200%，huge 视图被挤出可视区（表现为「打开大文件后编辑区一片空白」，逻辑上却能滚动、
   *  渲染行数也正常，所以单看 getState 发现不了）。这里按**该栏的**活动标签维护互斥显隐：
   *    huge 标签      → 隐藏本栏 CM（DOM 保留，只置 display），只显示该标签自己的 .huge-view
   *    其它标签       → 恢复本栏 CM（image/diff 由 preview.applyMode 另行隐藏整个 .editor-host）
   *  不用 host.innerHTML='' 这类破坏性做法：CM 的 DOM 必须留着，切回普通标签要立即复原。
   *
   *  **Phase 2 关键改动（让位按 pane 计算）**：三处单例假设全部拆掉 ——
   *    ① `pane.view.dom` 取代「全窗口唯一 CM 的 display」；
   *    ② `pane.host` 取代「整个 #editor-host 一个类」；
   *    ③ 只隐藏**本栏**非活动的 huge 视图（原来遍历全局 tabs，会把另一栏正在看的 huge 一起 display:none）。
   *  配套样式从 `#editor-host.huge-active > .cm-editor` 改为 `#editor-panes .editor-host.huge-active > .cm-editor`
   *  （ID 选择器只能命中 p0，双栏下 p1 的让位会失效）。 */
  function syncEditorLayer(pane, tab) {
    if (!pane) return;
    const isHuge = !!(tab && tab.kind === 'huge');
    // 注意：CM 基线主题给编辑器根节点写了 `display:flex !important`（@codemirror/view），
    // 内联 display 会被它压过 —— 真正生效的是 styles.css 的 .huge-active 让位规则。
    // 内联样式保留：一是语义标注，二是万一皮肤/样式表被替换时的退路。
    if (isHuge) pane.view.dom.style.display = 'none';
    else pane.view.dom.style.removeProperty('display');
    if (pane.host.classList) pane.host.classList.toggle('huge-active', isHuge); // styles.css 的让位规则
    for (const t of registry.docsOf(pane.id)) {
      if (t.kind === 'huge') setHugeVisible(t, isHuge && t === tab);
    }
  }

  // ---------- 1B-2：大文件查看器 ----------
  /** 打开超大文件（>256MB）：只读滑窗查看；「启用区域编辑」后在窗口内编辑并按偏移写回 */
  async function openViewerTab(path, st, opts) {
    const tab = {
      id: ++idSeq,
      path,
      name: baseName(path),
      lang: langFor(path),
      kind: 'viewer-lg',
      state: null,
      dirty: false,
      saveTimer: null,
      pinned: false,
      editing: false,
      lastSavedAt: 0,
      vwin: { size: st.size, offset: 0, byteLen: 0, encoding: null, inflight: false },
    };
    try {
      await loadViewerWindow(tab, 0);
    } catch (err) {
      if (opts.silent) {
        console.warn('[openFile] 打开失败（已静默跳过）:', path, err && err.message ? err.message : err);
      } else {
        const { alertBox } = await import('./ui.js');
        alertBox('打开文件失败', String(err.message || err));
      }
      return null;
    }
    registry.add(tab);
    // 新文档进**目标栏**（缺省 = 焦点栏；Phase 3 的会话恢复会显式指定栏号 —— 图片/分段/查看器/大文件
    // 标签同样要落在 layout 指定的那一栏，否则多栏会话恢复一次就漂移一次）
    const newPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
    registry.setPaneOf(tab, newPane.id);
    switchTab(tab, { pane: newPane });
    tab.dirty = false; // 加载窗口不是用户编辑
    clearTimeout(tab.saveTimer);
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 加载指定字节偏移的窗口内容到 tab（活动标签直接替换 view 文档，非活动标签重建 state）。
   *  UTF-8 窗口边界处理（v0.2.1）：多读 4 字节，剥离窗口起始处的前半字符连续字节与结尾处的
   *  不完整序列头部 —— 边界字符完整归属一侧窗口，不再显示替换符；区域编辑的写回区间
   *  同步按剥离量校正（regionStart/byteLen）。GBK 窗口维持原独立解码语义（边界偶有替换符）。 */
  async function loadViewerWindow(tab, offset) {
    const c = tab.vwin;
    if (c.inflight) return;
    c.inflight = true;
    try {
      const len = Math.min(VIEWER_WINDOW, c.size - offset);
      // 尾部多读 4 字节（非文件末尾时），用于补全跨窗口边界的多字节字符
      const readLen = offset + len < c.size ? len + 4 : len;
      const r = await window.api.readFileRange(tab.path, offset, readLen);
      if (!c.encoding) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(r.bytes);
          c.encoding = 'utf-8';
        } catch {
          try {
            new TextDecoder('gbk').decode(r.bytes);
            c.encoding = 'gbk';
          } catch {
            c.encoding = 'latin1';
          }
        }
      }
      const u8 = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
      const bufLen = r.end - r.start;
      let lead = 0;
      let tail = 0;
      if (c.encoding === 'utf-8') {
        if (r.start > 0) {
          // 起始处的 UTF-8 连续字节（0b10xxxxxx）属于上一窗口末尾字符的前半 → 归上一窗口（其尾部多读已补全）
          while (lead < 4 && lead < bufLen && (u8[lead] & 0xc0) === 0x80) lead++;
        }
        if (r.end < c.size) {
          // 结尾处的 UTF-8 不完整序列头部 → 连同其前导字节归下一窗口（其起始剥离配合）
          let i = bufLen - 1 - lead;
          let cont = 0;
          while (i >= 0 && (u8[i] & 0xc0) === 0x80 && cont < 3) {
            i--;
            cont++;
          }
          if (i >= 0) {
            const b = u8[i];
            const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
            if (need > cont + 1) tail = cont + 1; // 序列被截断：前导 + 已有连续字节归下窗
          }
        }
      }
      const viewBytes = u8.subarray(lead, Math.max(lead, len - tail));
      let text;
      try {
        text = new TextDecoder(c.encoding).decode(viewBytes);
      } catch {
        c.encoding = 'latin1';
        text = new TextDecoder('latin1').decode(viewBytes);
      }
      // 二进制内容防护：控制字符（NUL 等）替换为 '·' 显示；窗口标记 binary → 禁止区域编辑
      // （写回会失真）。真实文本大文件（日志等）不含控制字符，不受影响。
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text.slice(0, 1 << 20))) {
        text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '·');
        c.binary = true;
      } else {
        c.binary = false;
      }
      c.offset = r.start;
      c.regionStart = r.start + lead; // 区域编辑写回区间（经边界剥离校正）
      c.byteLen = Math.max(0, len - lead - tail);
      // Phase 2：本栏活动文档才 dispatch 进视图；否则重建 state（语义同 Phase 1，只是「活动」按栏判定）
      const vw = viewOfDoc(tab);
      if (registry.isActive(tab)) {
        // 程序化换窗不是用户编辑：不进撤销历史（撤销会把上一窗内容当编辑内容写回）
        vw.dispatch({
          changes: { from: 0, to: vw.state.doc.length, insert: text },
          annotations: Transaction.addToHistory.of(false),
        });
        tab.state = vw.state;
      } else {
        tab.state = makeState(text, tab.lang, true, false); // viewer：只读 + 强制不换行
      }
      registry.markDirty(tab, false);
      clearTimeout(tab.saveTimer);
      if (registry.isActive(tab)) {
        updateViewerBar(tab);
        updateStatusBar();
      }
    } finally {
      c.inflight = false;
    }
  }

  /** 滚动到窗口边缘时自动翻页（前进到顶 24px / 后退到底-24px，留边防止误触发反向翻页） */
  async function slideViewer(tab, dir) {
    const c = tab.vwin;
    const maxOff = Math.max(0, c.size - VIEWER_WINDOW);
    const target = Math.max(0, Math.min(c.offset + dir * VIEWER_STEP, maxOff));
    if (target === c.offset || c.inflight) return;
    await loadViewerWindow(tab, target);
    const el = viewOfDoc(tab).scrollDOM;
    const to = dir > 0 ? 24 : Math.max(0, el.scrollHeight - el.clientHeight - 24);
    const set = (n) => {
      if (!registry.isActive(tab)) return;
      el.scrollTop = to;
      if (n > 0) requestAnimationFrame(() => set(n - 1));
    };
    set(3);
  }

  /** 活动查看器标签的滚动边缘检测（编辑态禁止翻页，窗口即编辑边界） */
  function maybeSlideViewer(tab) {
    if (!tab || tab.kind !== 'viewer-lg' || tab.editing || tab.vwin.inflight) return;
    if (!registry.isActive(tab)) return;
    const el = viewOfDoc(tab).scrollDOM;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 8 && tab.vwin.offset < tab.vwin.size - VIEWER_WINDOW) {
      slideViewer(tab, +1);
    } else if (el.scrollTop <= 0 && tab.vwin.offset > 0) {
      slideViewer(tab, -1);
    }
  }

  /** 跳转：接受 百分比（42% / 42）或字节偏移（1.5G / 500M / 1600000000），窗口居中定位 */
  async function viewerJump(tab, input) {
    if (!tab || tab.kind !== 'viewer-lg') return false;
    if (tab.editing && tab.dirty) {
      toast('正在区域编辑且有未保存修改，请先保存或退出编辑');
      return false;
    }
    const s = String(input || '').trim();
    if (!s) return false;
    let target = -1;
    const m = s.match(/^([\d.]+)\s*%$/);
    const g = s.match(/^([\d.]+)\s*([KMG]B?)$/i);
    try {
      if (/^[0-9]+$/.test(s)) target = parseInt(s, 10); // 纯数字 = 字节偏移
      else if (g) {
        const unit = g[2].toUpperCase().startsWith('G') ? 1024 ** 3 : g[2].toUpperCase().startsWith('M') ? 1024 ** 2 : 1024;
        target = Math.round(parseFloat(g[1]) * unit);
      } else if (m) {
        target = Math.round((parseFloat(m[1]) / 100) * tab.vwin.size);
      }
    } catch {
      target = -1;
    }
    if (target < 0 || target > tab.vwin.size) {
      toast('无法识别的跳转位置（示例：50%、1.5G、500M、1600000000 字节）');
      return false;
    }
    if (tab.editing) await setViewerEditing(tab, false); // 跳转前退出区域编辑
    const center = Math.max(0, Math.min(target - Math.floor(VIEWER_WINDOW / 2), Math.max(0, tab.vwin.size - VIEWER_WINDOW)));
    await loadViewerWindow(tab, center);
    const set = (n) => {
      if (registry.isActive(tab)) {
        viewOfDoc(tab).scrollDOM.scrollTop = 0;
        if (n > 0) requestAnimationFrame(() => set(n - 1));
      }
    };
    set(3);
    return true;
  }

  /** 区域编辑开关：开启后当前窗口可编辑（≤40MB）；关闭时若有未保存修改先保存 */
  async function setViewerEditing(tab, on) {
    if (!tab || tab.kind !== 'viewer-lg' || !registry.isActive(tab)) return false;
    if (on === tab.editing) return true;
    if (on) {
      if (tab.vwin.binary) {
        toast('当前窗口含二进制/控制字符，不支持区域编辑（写回会失真）');
        return false;
      }
      if (tab.vwin.byteLen > VIEWER_EDIT_MAX) {
        toast(`当前窗口 ${formatSize(tab.vwin.byteLen)} 超过区域编辑上限（40MB），请先跳转到文件其它位置`);
        return false;
      }
      viewOfDoc(tab).dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(false)) });
      tab.editing = true;
      toast('区域编辑已启用：编辑当前窗口内容，保存（Ctrl+S）将写回文件原位置');
    } else {
      if (tab.dirty) {
        const ok = await saveNow(tab);
        if (!ok) return false; // 保存失败留在编辑态
      }
      viewOfDoc(tab).dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(true)) });
      tab.editing = false;
    }
    updateViewerBar(tab);
    return true;
  }

  /** 查看器区域保存：当前窗口内容替换文件 [offset, offset+byteLen) 字节（流式拼接写回） */
  async function saveViewerRegion(t) {
    if (!t.dirty) return true;
    if (!t.editing) {
      // 只读查看器：程序化改动不能静默"保存成功"，必须明确失败
      if (onSaveStatus) onSaveStatus('保存失败：大文件查看器未启用区域编辑');
      return false;
    }
    const content = t.state.doc.toString();
    try {
      const r = await window.api.spliceFile(t.path, t.vwin.regionStart !== undefined ? t.vwin.regionStart : t.vwin.offset, t.vwin.byteLen, content);
      t.vwin.size = r.size;
      t.vwin.byteLen = r.bytes;
      t.dirty = false;
      t.lastSavedAt = Date.now();
      if (onSaveStatus) onSaveStatus(`已保存区域 ${t.name}`);
      updateTabBadges();
      updateViewerBar(t);
      return true;
    } catch (err) {
      if (onSaveStatus) onSaveStatus(`保存失败：${err.message || err}`);
      return false;
    }
  }

  /** 更新查看器横幅（位置/百分比 + 编辑按钮文案） */
  function updateViewerBar(tab) {
    // Phase 2：横幅是**每栏一份**的 DOM，取该标签所属栏的那一份（p0 仍挂着历史 ID #viewer-bar）
    const pane = paneOfDoc(tab);
    const bar = pane.viewerBar;
    const pos = pane.viewerPos;
    const btnEdit = pane.btnViewerEdit;
    if (!bar || !tab || tab.kind !== 'viewer-lg') return;
    const c = tab.vwin;
    const pct = c.size > 0 ? Math.floor((c.offset / c.size) * 100) : 0;
    if (pos) pos.textContent = `${formatSize(c.offset)} ~ ${formatSize(c.offset + c.byteLen)} / ${formatSize(c.size)}（${pct}%${tab.editing ? ' · 区域编辑中' : ' · 只读'}）`;
    if (btnEdit) {
      btnEdit.textContent = tab.editing ? '✅ 退出区域编辑' : '✏️ 启用区域编辑';
      btnEdit.classList.toggle('danger', !!tab.editing);
    }
  }

  // 全局搜索命中大文件：按字节偏移居中开窗（globalsearch → findLineOffset 后调用）
  async function revealViewerAt(tab, byteOffset) {
    if (!tab || tab.kind !== 'viewer-lg') return;
    const center = Math.max(0, Math.min(byteOffset - Math.floor(VIEWER_WINDOW / 2), Math.max(0, tab.vwin.size - VIEWER_WINDOW)));
    await loadViewerWindow(tab, center);
  }

  // ---------- P7：大文件分段模式 ----------
  /** 分段打开：先读首段（约 2MB）进 CM（文档末尾带占位标记告知未完），滚动接近底部自动续读 */
  async function openChunkedTab(path, st, opts) {
    const tab = {
      id: ++idSeq,
      path,
      name: baseName(path),
      lang: langFor(path),
      kind: 'chunked',
      state: null,
      dirty: false,
      saveTimer: null,
      pinned: false,
      chunk: { size: st.size, loaded: 0, complete: false, inflight: false, loadPromise: null, decoder: null, encoding: null },
    };
    let c0;
    try {
      c0 = await window.api.readFileRange(path, 0, CHUNK_SIZE);
    } catch (err) {
      if (opts.silent) {
        console.warn('[openFile] 打开失败（已静默跳过）:', path, err && err.message ? err.message : err);
      } else if (err && err.code === 'TOO_LARGE') {
        const { alertBox } = await import('./ui.js');
        alertBox('文件过大，未打开', err.message);
      } else {
        const { alertBox } = await import('./ui.js');
        alertBox('打开文件失败', String(err.message || err));
      }
      return null;
    }
    const text0 = decodeFirstChunk(c0.bytes, tab);
    tab.chunk.loaded = c0.end;
    tab.chunk.complete = c0.end >= c0.size;
    tab.crlf = /\r\n/.test(text0); // 分段大文件同样记住行尾风格
    tab.state = makeState(text0 + chunkMarker(tab), tab.lang);
    registry.add(tab);
    // 新文档进**目标栏**（缺省 = 焦点栏；Phase 3 的会话恢复会显式指定栏号 —— 图片/分段/查看器/大文件
    // 标签同样要落在 layout 指定的那一栏，否则多栏会话恢复一次就漂移一次）
    const newPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
    registry.setPaneOf(tab, newPane.id);
    switchTab(tab, { pane: newPane });
    // 打开路径的 setState 不视为用户编辑：清脏标记与自动保存定时器（避免刚打开就被自动保存截断内容）
    tab.dirty = false;
    clearTimeout(tab.saveTimer);
    window.api.watchFile(path, c0.mtime);
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 加载下一段并追加到文档（dispatch 增量，不整体重建；非活动标签用 state.update 保持光标）。
   *  并发调用共享同一次加载（c.loadPromise）：ensureFullyLoaded 的 while 循环 await 到真实进度，
   *  不再因 inflight 立即返回而空转守卫提前退出 —— 否则并发保存（自动保存 + 手动/Python）会
   *  在未加载完时写盘，造成截断。 */
  function loadNextChunk(tab) {
    const c = tab && tab.chunk;
    if (!c || c.complete || !tab.state) return Promise.resolve();
    if (c.loadPromise) return c.loadPromise;
    const p = (async () => {
      c.inflight = true;
      try {
        const start = c.loaded;
        const len = Math.min(CHUNK_SIZE, c.size - start);
        if (len <= 0) {
          c.complete = true; // 无剩余内容：仅移除占位标记
          appendChunkText(tab, '');
          return;
        }
        const r = await window.api.readFileRange(tab.path, start, len);
        let text = '';
        if (c.decoder) {
          text = c.decoder.decode(r.bytes, { stream: true });
          if (r.end >= c.size) text += c.decoder.decode(); // 末段 flush 残余多字节序列
        } else {
          text = new TextDecoder(c.encoding || detectEncodingBytes(r.bytes)).decode(r.bytes);
        }
        c.loaded = r.end;
        if (r.end >= c.size) c.complete = true;
        appendChunkText(tab, text);
      } catch (err) {
        console.warn('[chunked] 分段读取失败:', tab.path, err && err.message ? err.message : err);
      } finally {
        c.inflight = false;
        c.loadPromise = null;
        maybeAutoLoad(tab); // 若用户仍停在底部附近，继续预读
      }
    })();
    c.loadPromise = p;
    return p;
  }

  /** 追加分段文本：先移除已有占位标记（可能在末尾，也可能因用户编辑漂移），再在文末追加内容 + 新标记 */
  function appendChunkText(tab, text) {
    const marker = chunkMarker(tab); // complete 后返回 ''（即移除占位）
    // Phase 3（R4）：追加是**文档级**动作，但 change 必须从一个真实视图的文档算出来。
    // 「活动视图 dispatch / 非活动 state.update」的二选一在多视图下失效 → 统一取**主视图**
    // （优先焦点栏），派发后由广播把同一批事务复制到该文档的其它视图；一个视图都没有时
    // 才退化成纯 state.update（标签从未被切到过）。
    const pv = primaryViewOf(tab);
    const state = pv ? pv.state : tab.state;
    const docStr = state.doc.toString();
    const changes = [];
    const re = new RegExp(CHUNK_MARKER_RE.source, 'g');
    let m;
    while ((m = re.exec(docStr))) changes.push({ from: m.index, to: m.index + m[0].length, insert: '' });
    changes.push({ from: docStr.length, to: docStr.length, insert: text + (marker || '') });
    // 分段预读不是用户编辑：不进撤销历史。否则 Ctrl+Z 会把刚追加的一整段撤掉，
    // 而 chunk.complete 仍为 true（不会重新补读）→ 800ms 后自动保存把文件截断。
    const noHistory = Transaction.addToHistory.of(false);
    if (pv) {
      pv.dispatch({ changes, annotations: noHistory });
      tab.state = pv.state;
    } else {
      // 无视图：EditorState.update（selection 自动经 changes 映射，光标语义保持）
      tab.state = state.update({ changes, annotations: noHistory });
    }
    // 分段追加不是用户编辑：不触发自动保存 / 脏标记（updateListener 已标脏，这里复位）
    registry.markDirty(tab, false);
    clearTimeout(tab.saveTimer);
    const pane = paneOfDoc(tab);
    if (pv && pane && isFocusedPane(pane)) {
      const ss = document.getElementById('save-status');
      if (ss && !tab.dirty) ss.textContent = '';
    }
    if (onSessionChange) onSessionChange();
  }

  /** 活动标签滚动接近底部时触发预读（scroll 监听 + 加载完成后链式调用） */
  function maybeAutoLoad(tab) {
    if (!tab || tab.kind !== 'chunked' || !tab.chunk || tab.chunk.complete || tab.chunk.inflight) return;
    if (!registry.isActive(tab)) return; // 仅活动标签按滚动预读
    const el = viewOfDoc(tab).scrollDOM;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < CHUNK_PREFETCH_MARGIN) loadNextChunk(tab);
  }

  /** 补齐剩余分段（保存前调用，防止写盘截断） */
  async function ensureFullyLoaded(tab) {
    const c = tab && tab.chunk;
    if (!c || c.complete) return;
    let guard = 0;
    while (!c.complete && guard < CHUNK_MAX_BLOCKS) {
      await loadNextChunk(tab);
      guard++;
    }
  }

  /** 补齐到指定行号（全局搜索跳转定位用；行号超出已加载范围时先续读） */
  async function ensureLineLoaded(tab, line) {
    let guard = 0;
    while (!tab.chunk.complete && viewOfDoc(tab).state.doc.lines < line && guard < CHUNK_MAX_BLOCKS) {
      await loadNextChunk(tab);
      guard++;
    }
  }

  /** 外部修改后重载分段标签：重置解码器并重读首段（保留 kind/chunk 结构） */
  async function reloadChunked(tab) {
    const c0 = await window.api.readFileRange(tab.path, 0, CHUNK_SIZE);
    tab.chunk = { size: c0.size, loaded: c0.end, complete: c0.end >= c0.size, inflight: false, decoder: null, encoding: null };
    const text0 = decodeFirstChunk(c0.bytes, tab);
    tab.crlf = /\r\n/.test(text0);
    const insert = text0 + chunkMarker(tab);
    // Phase 3：外部重载是**文档级**事件 → 该文档的每个视图都要换上同一份新内容
    const views = registry.viewsOf(tab);
    if (views.length) {
      for (const vw of views) {
        try {
          vw.dispatch({
            changes: { from: 0, to: vw.state.doc.length, insert },
            // 外部重载不是用户编辑：不进历史 + 标记为远端（接收视图不再回播）
            annotations: [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
          });
        } catch { /* 视图已销毁 */ }
      }
      tab.state = views[0].state;
    } else {
      tab.state = tab.state.update({
        changes: { from: 0, to: tab.state.doc.length, insert },
        annotations: Transaction.addToHistory.of(false),
      });
    }
    registry.markDirty(tab, false);
    clearTimeout(tab.saveTimer);
    if (!tab.chunk.complete) loadNextChunk(tab); // 续读后续段
  }

  /** 以图片标签页打开图片文件（opts 透传自 openFile：paneIndex 决定落在哪一栏） */
  function openImageTab(path, opts = {}) {
    const existing = registry.byPath(path);
    if (existing) {
      const home = paneOfDoc(existing);
      if (registry.focusPane() !== home.id) setFocusPane(home.id, { notify: false });
      switchTab(existing, { pane: home });
      return existing;
    }
    const tab = {
      id: ++idSeq,
      path,
      name: baseName(path),
      lang: 'image',
      kind: 'image',
      state: null,
      dirty: false,
      saveTimer: null,
      pinned: false,
    };
    registry.add(tab);
    // 新文档进**目标栏**（缺省 = 焦点栏；Phase 3 的会话恢复会显式指定栏号 —— 图片/分段/查看器/大文件
    // 标签同样要落在 layout 指定的那一栏，否则多栏会话恢复一次就漂移一次）
    const newPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
    registry.setPaneOf(tab, newPane.id);
    switchTab(tab, { pane: newPane });
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 切到某个标签（在该标签**所属栏**里）。Phase 2：所有视图操作都落到 `pane.view`，
   *  并且**只有焦点栏**才向上层发 onTabSwitch（= 预览 / 树跟随 / 运行按钮只对焦点栏生效）。
   *  Phase 3：`opts.pane` 可显式指定渲染到哪一栏（同文件多视图时，同一文档要在两个栏各渲染一份）。 */
  function switchTab(tab, opts = {}) {
    const pane = opts.pane || paneOfDoc(tab);
    // 归属兜底：未登记的文档（早期路径）归到解析出来的栏。**只登记、不搬家** ——
    // Phase 2 这里曾是 setPaneOf（搬家语义），多视图下会把该文档在另一栏的归属一并抹掉。
    registry.ensurePaneOf(tab, pane.id);
    // 记住离开标签的滚动位置（编辑器 / 图片视图 / 对比视图），切回时恢复；
    // onTabLeave 供上层同步保存预览区滚动等视图级状态
    const leaving = registry.activeOf(pane.id);
    if (leaving && leaving !== tab) {
      if (leaving.kind === 'image') {
        leaving.scrollTop = pane.imageHost.scrollTop;
      } else if (leaving.kind === 'diff') {
        const sc = pane.diffHost.querySelector('.diff-scroller');
        leaving.scrollTop = sc ? sc.scrollTop : 0;
      } else if (leaving.kind === 'huge') {
        // huge 视图的滚动位置由 syncEditorLayer → setHugeVisible 记录（CM 是空文档，view.scrollDOM 无意义）
      } else {
        leaving.scrollTop = pane.view.scrollDOM.scrollTop;
      }
      if (isFocusedPane(pane) && onTabLeave) onTabLeave(leaving);
    }
    // 活动指针（按栏）+ 视图归属一起登记：C1 的反查靠 registry.docOfView(u.view)，
    // 因此这里必须把**本栏的 view** 绑定到本栏的活动文档（双栏互不串写的唯一保证）。
    registry.setActiveOf(pane.id, tab);
    registry.bindView(pane.view, tab);
    // 缺陷 1 修复：先按新活动标签互斥 CM / huge 视图（必须在 setState 之前 —— CM 刚从
    // display:none 恢复时要按真实尺寸重建视口），后续各分支只负责填内容。
    // Phase 2：让位按**本栏**计算（另一栏的 CM/huge 完全不受影响）。
    syncEditorLayer(pane, tab);
    if (tab.kind === 'image') {
      // 图片标签：编辑区显示图片视图
      pane.view.setState(makeState('', 'text'));
      renderImageTab(tab, pane);
    } else if (tab.kind === 'huge') {
      // 虚拟滚动查看器：CM 已在 syncEditorLayer 里让位（display:none，DOM 保留），
      // huge 视图挂载/复用到本栏的 .editor-host，自行渲染视口行
      pane.view.setState(makeState('', 'text'));
      mountHuge(tab, pane);
    } else if (tab.kind === 'diff') {
      // 对比标签：编辑器让位，渲染双栏 diff（applyMode 负责显隐）
      pane.view.setState(makeState('', 'text'));
      renderDiff(tab, pane);
    } else {
      pane.view.setState(tab.state);
      // 对齐换行设置（viewer-lg 例外：强制不换行——超长单行 wrap 测量复杂度失控）
      wordWrapOn = getWordWrap();
      const wrapOn = tab.kind === 'viewer-lg' ? false : wordWrapOn;
      pane.view.dispatch({ effects: wrapCompartment.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
      // 对齐缩进设置（设置变更后，已开标签切换时也按当前 indentSize 生效）
      pane.view.dispatch({ effects: indentCompartment.reconfigure(indentExtensions(indentSize)) });
      // 对齐只读态：viewer-lg 只有「启用区域编辑」后才可写；普通标签看 tab.readOnly
      // （跨窗口共享自动只读 / 用户手动切换）
      const ro = tab.kind === 'viewer-lg' ? !tab.editing : !!tab.readOnly;
      pane.view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)) });
      if (tab.kind === 'viewer-lg') tab.readOnly = !tab.editing;
      tab.state = pane.view.state;
      // CM 可能刚从 display:none（上个标签是 huge）恢复：显式请一次测量，避免视口按 0 高度算
      pane.view.requestMeasure();
    }
    // 恢复进入标签的滚动位置：setState 重建视口后位置丢失，CM 高度测量异步 → 多帧校正；
    // 期间位置被其它力量移动（用户滚动/测量修正超出容差）则停止校正，不与用户抢滚动条。
    // 新标签 / 无记录 → 顶部。Phase 3：滚动位置是**视图级**的，必须按本次渲染的那一栏恢复
    // （同一文档在两栏各有一份滚动位置，取主栏会串）。
    restoreTabScroll(tab, pane);
    renderTabsAll(); // 切换可能伴随新增标签（openFile→switchTab）：结构渲染（低频路径；高频 docChanged 才走 updateTabBadges）
    updateLockBanner(pane); // Phase 4：本栏活动文档的跨窗口锁态横幅
    if (tab.kind === 'viewer-lg') updateViewerBar(tab);
    updateEmpty();
    // 状态栏 / 预览 / 树跟随只认**焦点栏**：非焦点栏内部切标签不能把状态栏拽过去。
    // 但**非焦点栏也要通知一次**（focused=false）：图片/对比/预览三层的显隐归 app.js 的 preview
    // 实例管，不通知的话非焦点栏切到图片标签会一直显示编辑器直到它被聚焦。
    const focused = isFocusedPane(pane);
    if (focused) updateStatusBar();
    try { onTabSwitch(tab, focused); } catch (err) { console.warn('[tab-switch]', err && err.message ? err.message : err); }
    if (onSessionChange) onSessionChange();
  }

  // ==========================================================================
  // Phase 3：同文件多视图的挂载 / 摘除 / 视图级关闭（G2 + G3）
  // --------------------------------------------------------------------------
  //  · **一个文档可以在两个栏各有一个视图**（同一 Document 引用、两份独立 EditorState），
  //    内容由 updateListener 的广播保持一致（见文件顶部的广播说明）。
  //  · **视图级关闭**：关掉一个栏的视图 → 不落盘、不清脏、不删文档；只有关掉**最后一个**视图
  //    才走文档级关闭路径（先保存脏内容再移除文档）。
  //  · **路径单例类文档禁止多视图**（SINGLE_VIEW_KINDS）：huge 的 overlay 编辑会话是路径单例
  //    （overlay-ipc 的 handles/pathToId/locks，跨窗口按 ownedByOther 转只读），两个 huge 视图
  //    看同一文件会让两套视口抢同一个编辑会话；viewer-lg 的内容真源是 vwin 字节窗口（窗口级语义）；
  //    image/diff 本就是窗口级临时视图（各自去重）。这些类别在入口直接拒绝并提示。
  // ==========================================================================
  /** 「同文件两视图」的一次性提示开关（0.3.0 §2.4：不修 CM 撤销语义，改为首次分屏说明一次） */
  let sameFileHintShown = false;
  /** 不允许同文件多视图的 kind（见上面的理由） */
  const SINGLE_VIEW_KINDS = { huge: 1, 'viewer-lg': 1, image: 1, diff: 1 };

  /** 在指定栏为**已有文档**挂一个视图：复用同一 Document（读盘只发生一次），
   *  在本栏新建一份独立 EditorState（光标/选区/折叠/滚动天然独立）。返回是否挂成功。 */
  function attachViewToPane(doc, paneRef) {
    const pane = (paneRef && paneRef.view) ? paneRef : paneByRef(paneRef);
    if (!doc || !pane) return false;
    if (registry.panesOf(doc).indexOf(pane.id) >= 0) { // 该栏已有它的视图 → 只激活
      switchTab(doc, { pane });
      return true;
    }
    if (SINGLE_VIEW_KINDS[doc.kind]) {
      toast(doc.kind === 'huge'
        ? '大文件视图不支持同文件多视图（编辑会话是路径单例）'
        : '该类型的标签不支持同文件多视图');
      return false;
    }
    registry.ensurePaneOf(doc, pane.id);
    switchTab(doc, { pane }); // 内部 bindView(pane.view, doc) + setState(doc.state)（内容基线）
    if (!sameFileHintShown) {
      sameFileHintShown = true;
      toast('同一文件已在两栏各开一个视图：内容实时同步、光标与滚动各自独立；撤销按栏独立（在一栏撤销可能撤掉另一栏刚输入的内容）');
    }
    renderTabsAll(); // 两栏标签栏各多/改一条
    if (onSessionChange) onSessionChange();
    return true;
  }

  /** 摘掉某栏承载的某个视图（视图级关闭的底层动作）：只摘**这一栏**的成员关系与视图绑定，
   *  不落盘、不清脏、不删文档 —— 文档在别的栏的视图原样保留。 */
  function detachViewFromPane(doc, pane) {
    if (!doc || !pane) return false;
    if (registry.panesOf(doc).indexOf(pane.id) < 0) return false;
    if (registry.activeOf(pane.id) === doc) registry.setActiveOf(pane.id, null);
    if (registry.docOfView(pane.view) === doc) {
      registry.unbindView(pane.view);              // 引用计数 -1（必须先摘，否则 viewsOf 永不归零）
      pane.view.setState(makeState('', 'text'));   // 该栏视图回到空文档
    }
    registry.dropPaneOf(doc, pane.id);
    return true;
  }

  /** 关闭动作发生在哪一栏：显式传入优先；否则**焦点栏优先**（Ctrl+W / ✕ 都是"关我正在看的那个视图"），
   *  焦点栏不承载它时回落到它的主栏。 */
  function paneForDocAction(doc, opts = {}) {
    if (opts.pane && opts.pane.view) return opts.pane;
    if (opts.paneId) return paneById(opts.paneId) || null;
    const fp = focusedPane();
    if (fp && registry.panesOf(doc).indexOf(fp.id) >= 0) return fp;
    return paneOfDoc(doc);
  }

  /** 视图级关闭（G3）：只关掉这一栏的视图。该栏清空时按既有语义撤栏（回落单栏）。 */
  function closeViewInPane(tab, pane, opts = {}) {
    if (!tab || !pane) return;
    const wasActive = registry.activeOf(pane.id) === tab;
    detachViewFromPane(tab, pane);
    if (wasActive) {
      const rest = registry.docsOf(pane.id);
      const next = rest.length ? rest[rest.length - 1] : null;
      if (next) {
        switchTab(next, { pane });
      } else {
        // 栏内没标签了：与该栏关掉最后一个标签的既有路径逐位一致（清图层 + 空态）
        pane.imageHost.classList.add('hidden');
        pane.view.setState(makeState('', 'text'));
        syncEditorLayer(pane, null);
        renderTabsAll();
        updateEmpty();
        if (isFocusedPane(pane)) {
          updateStatusBar();
          onTabSwitch(null);
        }
      }
    } else {
      renderTabsAll();
      updateEmpty();
    }
    if (panes.length > 1) removeEmptyPane(pane);
    if (onSessionChange) onSessionChange();
    void opts;
  }

  /** 多帧恢复 tab 滚动位置（编辑器或图片视图；diff 由 renderDiff 内部恢复）。
   *  setState 重建视口后 CM 的高度测量会异步修正 scrollTop，单次赋值会被"弹回"，
   *  需连续多帧压回目标值（~100ms，测量完成后即稳定）；期间切换标签则放弃。
   *  无记录 → 顶部。 */
  function restoreTabScroll(tab, paneOpt) {
    if (tab.kind === 'diff') return; // renderDiff 已恢复
    // huge：滚动容器是 .huge-view 自身（不是 CM），且其 DOM 跨标签切换常驻 →
    // 位置由 setHugeVisible 在重新显示时按行号复位，这里不碰 view.scrollDOM
    if (tab.kind === 'huge') return;
    const pane = paneOpt || paneOfDoc(tab);
    const el = tab.kind === 'image' ? pane.imageHost : pane.view.scrollDOM;
    const target = typeof tab.scrollTop === 'number' ? tab.scrollTop : 0;
    const step = (n) => {
      // 判据用**本栏**的活动文档（多视图下 registry.isActive 会优先看焦点栏，可能给出与
      // 本次渲染的栏不一致的答案 → 非焦点栏的滚动恢复会被误判为"已切走"而放弃）
      if (registry.activeOf(pane.id) !== tab || !el) return;
      el.scrollTop = target;
      if (n <= 0) return;
      requestAnimationFrame(() => step(n - 1));
    };
    step(6);
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab 循环切换标签 —— **栏内循环**（0.5.0 G6：不跨栏抢标签） */
  function cycleTab(dir) {
    const pane = focusedPane();
    const list = registry.docsOf(pane.id);
    // A3：无论是否能切换都先弹一次浮层 —— 只有一个标签时也告诉用户"这栏就一个"，
    // 否则 Ctrl+Tab 看起来像"没反应"（0.3.0 §4-A3 的"切换提示浮层"）。
    showTabHud(pane);
    if (list.length < 2) return;
    const i = list.indexOf(registry.activeOf(pane.id));
    const next = list[(i + dir + list.length) % list.length];
    switchTab(next);
    showTabHud(pane); // 切换后刷新高亮项（内容随活动标签变）
  }

  /** 状态栏：文件名 / 行:列 / 字数 */
  function updateStatusBar() {
    const sbFile = document.getElementById('sb-file');
    const sbPos = document.getElementById('sb-pos');
    const sbLen = document.getElementById('sb-len');
    if (!sbPos) return;
    const cur = registry.active(); // 状态栏是全局单例：Phase 1 显示活动文档，Phase 2 起显示焦点栏的
    if (!cur || cur.kind === 'image' || cur.kind === 'diff') {
      sbFile.textContent = cur ? cur.name : '未打开文件';
      if (cur && cur.kind === 'diff') {
        sbPos.textContent = '对比视图（只读）';
        const m = cur._model;
        sbLen.textContent = m ? `+${m.stats.add} −${m.stats.del} ~${m.stats.mod}` : '';
      } else {
        sbPos.textContent = cur ? (cur.lang === 'image' ? '图片预览' : '') : '';
        sbLen.textContent = '';
      }
      return;
    }
    if (cur.kind === 'huge') {
      const st2 = cur.huge ? cur.huge.getState() : null;
      sbFile.textContent = cur.name;
      // Phase D：编辑态显示光标位置 + 脏计数（未启用编辑时为纯查看口径；hugeview 的 onStatus
      // 会把更细的提示（只读原因/保存进度）写到 sbLen，因此这里只在无提示时兜底）
      const caretPos = st2 && st2.editable && st2.caret ? ` · 光标 行 ${st2.caret.line} 列 ${st2.caret.col + 1}` : '';
      sbPos.textContent = st2
        ? `${st2.editable ? '✎ 编辑中' : '只读'} · 行 ${st2.rendered ? st2.rendered.from : 1} / 共 ${st2.lines} 行（${st2.indexed ? '索引就绪' : '索引建立中'}）${caretPos}`
        : '加载中…';
      sbLen.textContent = st2 && st2.dirty
        ? `未保存修改 ${st2.dirtyCount || 1} 处`
        : (st2 && st2.encoding ? st2.encoding.toUpperCase() : '');
      return;
    }
    if (cur.kind === 'viewer-lg') {
      const c = cur.vwin;
      sbFile.textContent = cur.name;
      sbPos.textContent = `窗口偏移 ${formatSize(c.offset)} / ${formatSize(c.size)}（${c.size > 0 ? Math.floor((c.offset / c.size) * 100) : 0}%）`;
      sbLen.textContent = `${formatSize(cur.state.doc.length)} 已加载`;
      return;
    }
    const pos = focusedView().state.selection.main.head;
    const line = focusedView().state.doc.lineAt(pos);
    const col = pos - line.from + 1;
    const sel = focusedView().state.selection.main;
    const selLen = sel.from === sel.to ? 0 : sel.to - sel.from;
    sbFile.textContent = cur.name;
    sbPos.textContent = `${cur.readOnly ? '🔒 只读 · ' : ''}行 ${line.number}, 列 ${col}${selLen ? `（选中 ${selLen} 字）` : ''}`;;
    sbLen.textContent = `${focusedView().state.doc.length} 字符`;
  }

  function renderImageTab(tab, pane) {
    const imageHost = (pane || paneOfDoc(tab)).imageHost;
    imageHost.innerHTML = '';
    const isPdf = tab.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      // PDF：Chromium 内置查看器
      const embed = document.createElement('embed');
      embed.src = pathToFileUrl(tab.path);
      embed.type = 'application/pdf';
      embed.className = 'pdf-embed';
      imageHost.appendChild(embed);
      return;
    }
    const img = document.createElement('img');
    img.src = pathToFileUrl(tab.path);
    img.alt = tab.name;
    img.title = tab.path;
    img.className = 'image-tab-img';
    // v0.2.4：右键菜单 —— 复制原图 / 在文件夹中显示（与预览右键一致）
    img.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      import('./ui.js').then(({ showContextMenu }) => {
        showContextMenu(e.clientX, e.clientY, [
          {
            label: '📋 复制图片（原图）',
            onClick: async () => {
              try {
                const r = await window.api.copyImage(tab.path);
                const { toast } = await import('./ui.js');
                toast(`图片已复制（${r.width}×${r.height}）`);
              } catch (err) {
                const { toast } = await import('./ui.js');
                toast('复制失败：' + (err && err.message ? err.message : err));
              }
            },
          },
          { label: '📁 在文件夹中显示', onClick: () => window.api.showInFolder(tab.path) },
        ]);
      });
    });
    imageHost.appendChild(img);

    // 右上角工具栏：复制按钮 + 缩放指示
    const tools = document.createElement('div');
    tools.className = 'image-tools';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'tbtn small image-copy-btn';
    copyBtn.textContent = '📋 复制';
    copyBtn.addEventListener('click', async () => {
      try {
        const r = await window.api.copyImage(tab.path);
        const { toast } = await import('./ui.js');
        toast(`图片已复制（${r.width}×${r.height}）`);
      } catch (err) {
        const { toast } = await import('./ui.js');
        toast('复制失败：' + (err && err.message ? err.message : err));
      }
    });
    const badge = document.createElement('div');
    badge.className = 'zoom-badge hidden';
    tools.append(copyBtn, badge);
    imageHost.appendChild(tools);

    // 直接滚轮缩放图片（50%~500%），双击恢复 100%
    let imgZoom = 1;
    const applyZoom = () => {
      img.style.zoom = imgZoom;
      // 放大时移除 max-width 限制，否则缩放被容器宽度抵消（无法溢出/平移）
      if (imgZoom > 1) {
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
      } else {
        img.style.maxWidth = '100%';
        img.style.maxHeight = '100%';
      }
      badge.textContent = Math.round(imgZoom * 100) + '%';
      badge.classList.remove('hidden');
      clearTimeout(badge._t);
      badge._t = setTimeout(() => badge.classList.add('hidden'), 1500);
    };
    imageHost.onwheel = (e) => {
      e.preventDefault();
      imgZoom = Math.min(5, Math.max(0.5, +(imgZoom + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)));
      applyZoom();
    };
    imageHost.ondblclick = () => {
      imgZoom = 1;
      applyZoom();
    };
  }

  // ==========================================================================
  // 0.5.0 Phase 5a 第 2 批 A2：Ctrl+Shift+T 重开刚关闭的标签（栈 20 条）
  // --------------------------------------------------------------------------
  // **数据结构**：`closedStack`（数组，**新→旧**：下标 0 = 最近关闭），上限 CLOSED_STACK_MAX = 20，
  // 超出丢最旧（下标末尾）。每条快照含重开所需的全部状态：
  //   { path, name, paneId, kind, pinned, readOnly, dirtyAtClose, savedOnClose, text, textOmitted,
  //     cursor:{anchor,head}, scrollTop, hugeTopLine, at }
  //
  // **落栏语义（确定语义，用例断言它）**：
  //   ① 重开回到**关闭时所在的那一栏**（快照 paneId）；
  //   ② 该栏已不存在（合栏 / 关栏）→ 落到**当前焦点栏**；
  //   ③ 该文件已被重新打开（文档还在）→ 只激活它，**不动内容与光标**（不覆盖用户的新输入）。
  //
  // **未保存内容（硬要求：不许只恢复路径就宣称"内容还在"）**：
  //   · 关标签时 tabs.js 本来就会先 `saveNow`（普通 / 分段 / 查看器三条路径写盘）——
  //     快照记录这次保存的**真实结果** savedOnClose；
  //   · savedOnClose === true ⇒ 磁盘上就是关闭那一刻的内容 ⇒ 重开读盘即等价恢复（不是"假装还在"）；
  //   · savedOnClose === false（写盘失败，或调用方显式 save:false）时：普通文本标签会把手里的文本快照
  //     **写回**重开的文档并重新标脏（内容不丢）；超出 TEXT_SNAPSHOT_MAX 或非普通文本标签则**显式降级**；
  //   · **huge（overlay 脏内容）恒为降级路径**：关闭 huge 标签**不写源文件**（见 trackClosedSave 的
  //     实测说明），改动只留在主进程 overlay 恢复区（`huge:doc-recover-list`）。而主进程
  //     `huge:doc-open` 恒从磁盘重建块表 —— 0.5.0 **没有"把恢复区的分片重挂到新句柄"的入口**，
  //     所以重开只能按磁盘内容显示 ⇒ 只要关闭前是脏的，一律**显式降级**：
  //     toast 说明 + `tab.reopenInfo.degraded = true`（reason = HUGE_OVERLAY_NOT_REATTACHED），
  //     绝不假装内容还在；内容本身仍在恢复区（用例用 hugeDocRecoverList 断言这一点）。
  //
  // **滚动位置（A2 的第 6 条补齐）**：
  //   · 普通/图片标签用 `tab.scrollTop`（像素，本文件既有的 restoreTabScroll）；
  //   · **huge 标签的滚动位置不是 `tab.scrollTop`**，而是视口首行 `hugeTopLine`（CM 是空文档）——
  //     关闭时用与 `setHugeVisible` 同一个估算器采集（`hugeTopLine(tab)`），重开时交给
  //     `restoreHugeTopLine` 在**索引就绪后** `gotoLine` 复位；索引未就绪就拿不到真实总行数，
  //     `scrollToLine` 会被 clamp 到估算值，因此必须先等 `getState().indexed`（口径同 app.js 的
  //     waitHugeReady：轮询 + 超时，不硬等固定 sleep）。恢复失败**不静默**：
  //     `reopenInfo.hugeScrollRestored = false` + toast 说明（用户至少知道"位置没回来"）。
  // ==========================================================================
  const CLOSED_STACK_MAX = 20;
  const TEXT_SNAPSHOT_MAX = 2000000; // 字符：只有 ≤2M 字符的普通文本标签才做内容快照（内存可控）
  const HUGE_RESTORE_WAIT_MS = 12000; // 等 huge 行索引就绪的上限（超过即按"未能恢复"如实登记）
  /** @type {Array<object>} 最近关闭的标签快照（新→旧） */
  const closedStack = [];

  /** 关闭时压栈（返回快照条目；无路径的标签——对比视图——不入栈） */
  function pushClosedTab(tab, pane, opts) {
    if (!tab || !tab.path) return null;
    const entry = {
      path: tab.path,
      name: tab.name,
      paneId: pane ? pane.id : null,
      kind: tab.kind || null,
      pinned: !!tab.pinned,
      readOnly: !!tab.readOnly,
      dirtyAtClose: tab.dirty === true,
      // null = 尚在保存中；true = 磁盘已是关闭时内容；false = 未保存成功（降级路径）
      savedOnClose: (opts && opts.save === false) ? false : null,
      text: null,
      textOmitted: false,
      cursor: null,
      scrollTop: typeof tab.scrollTop === 'number' ? tab.scrollTop : null,
      // huge 的滚动位置是**视口首行**（不是像素 scrollTop）：关闭当下就用与 setHugeVisible
      // 同一个估算器采集（hugeTopLine(tab)），否则"关掉正在看的 huge 标签"这条最常见路径
      // 根本拿不到位置（tab.hugeTopLine 只在切换标签离开时才写）。
      hugeTopLine: (tab.kind === 'huge' && tab.huge)
        ? hugeTopLine(tab)
        : (typeof tab.hugeTopLine === 'number' ? tab.hugeTopLine : null),
      at: Date.now(),
    };
    // 视图级状态：光标/选区取**该栏视图**的当前 state（多视图下这是用户正在看的那一份）
    try {
      const vw = pane ? pane.view : null;
      if (vw && registry.docOfView(vw) === tab) {
        const sel = vw.state.selection.main;
        entry.cursor = { anchor: sel.anchor, head: sel.head };
        if (entry.scrollTop == null) entry.scrollTop = Math.round(vw.scrollDOM.scrollTop);
      }
    } catch { /* 视图已销毁：只留文档级状态 */ }
    // 未保存内容快照：只对**普通文本标签**做（huge/viewer-lg 的 state 是空文档，天然跳过；
    // 分段标签的 state 带 MH-CHUNKED 占位标记且语义特殊，不做内容回写 —— 见上面第 3 条）
    if (entry.dirtyAtClose && !tab.kind && tab.state && typeof tab.state.doc.length === 'number') {
      if (tab.state.doc.length <= TEXT_SNAPSHOT_MAX) {
        try { entry.text = tab.state.doc.toString(); } catch { entry.text = null; }
      } else {
        entry.textOmitted = true;
      }
    }
    closedStack.unshift(entry);
    if (closedStack.length > CLOSED_STACK_MAX) closedStack.length = CLOSED_STACK_MAX;
    return entry;
  }

  /**
   * A2 第 6 条：把 huge 标签的**视口首行**恢复到关闭时的位置。
   * 为什么不能直接 `gotoLine`：`hugeview.scrollToLine` 会把行号 clamp 到**当前已知总行数**
   * （索引未就绪时是"读首 4MB 估算"的值，400k 行的文件可能差出几个数量级）—— 必须先等
   * `getState().indexed` 就绪。等待口径同 app.js 的 waitHugeReady：轮询 + 超时，
   * **不硬等固定 sleep**（索引命中侧车缓存时是毫秒级，冷扫时是秒级）。
   * @returns {Promise<boolean>} 是否真的恢复（超时/视图销毁 → false，调用方据此显式提示）
   */
  async function restoreHugeTopLine(tab, line) {
    if (!tab || tab.kind !== 'huge' || !tab.huge) return false;
    const target = Math.max(1, Math.floor(Number(line) || 1));
    if (target <= 1) return false;
    const t0 = Date.now();
    for (;;) {
      let st = null;
      try { st = tab.huge.getState(); } catch { return false; }
      if (!st) return false;
      if (st.indexed === true) break;
      if (Date.now() - t0 > HUGE_RESTORE_WAIT_MS) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      await tab.huge.gotoLine(target); // = scrollToLine：复位 + 重画视口
      return true;
    } catch {
      return false;
    }
  }

  /** 把"关闭时那次保存"的真实结果写进快照（p 为 null 且关之前不脏 ⇒ 磁盘即内容）。
   *
   *  ⚠️ **huge 与普通标签走同一条路径**（2026-09-13 修正；此前是 `kind === 'huge'` 硬编码 false）：
   *  `closeTab` 里的 `saveNow(tab)` 走 `saveQueue.then(() => doSaveNow(tab))` —— `doSaveNow` 要到
   *  **微任务**才执行，而同一段同步代码紧接着就 `tab.huge = null` + `hv.destroy()`；于是 `doSaveNow`
   *  的 huge 分支命中 `if (!hv)`。那个分支**原先 `return true`**（没写盘却报成功，Promise 也 resolve
   *  true），所以这里当时只能硬编码 `savedOnClose = false` 来兜。**现在 `if (!hv)` 返回 `false`**
   *  （= 本次没有发生写盘，见 :3073 的调用方约定）⇒ 硬编码分支已删除，huge 也**按返回值推导**：
   *    · 关闭 dirty huge 标签 → 得到 `savedOnClose === false` ⇒ A2 重开仍走显式降级
   *      （:2312 `dirtyAtClose && savedOnClose !== true` → reason `HUGE_OVERLAY_NOT_REATTACHED`）；
   *    · 将来若"关前真的写盘"了，`savedOnClose` 会自动变 true，不再有硬编码替它撒谎。
   *  `savedOnClose === null` = 保存 promise 尚未 settle；重开路径把它当"未确认保存"→ 同样进降级分支，
   *  方向是安全的（`e.savePending` + `SAVE_STILL_RUNNING` 只对非 huge 生效，见 :2312-2318）。 */
  function trackClosedSave(entry, p) {
    if (!entry) return;
    if (p && typeof p.then === 'function') {
      entry.savePending = true;
      p.then(
        (ok) => { entry.savePending = false; entry.savedOnClose = ok === true; },
        () => { entry.savePending = false; entry.savedOnClose = false; }
      );
      return;
    }
    if (entry.savePending) return;              // 已有保存 promise 在跟踪，别提前判"成功"
    if (entry.savedOnClose === null) entry.savedOnClose = true;
  }

  /**
   * 重开最近关闭的标签（Ctrl+Shift+T）。
   * @returns {Promise<object|null>} 重开后的文档（失败/栈空为 null）
   */
  async function reopenClosedTab() {
    if (!closedStack.length) {
      toast('没有可重开的标签（最近关闭栈为空）');
      return null;
    }
    const e = closedStack.shift();
    // ③ 文档还在：只激活（不动内容/光标 —— 用户可能已经改过它）
    const already = registry.byPath(e.path);
    if (already) {
      const home = paneOfDoc(already);
      if (home) {
        setFocusPane(home.id, { notify: true });
        switchTab(already, { pane: home });
      }
      toast(`「${e.name}」已经打开，已切换到它`);
      return already;
    }
    // ①② 回到原栏；原栏没了 → 焦点栏
    const idx = panes.findIndex((p) => p.id === e.paneId);
    const paneIndex = idx >= 0 ? idx : panes.indexOf(focusedPane());
    const tab = await openFile(e.path, {
      silent: true,
      paneIndex: paneIndex >= 0 ? paneIndex : undefined,
    });
    if (!tab) {
      toast(`无法重开「${e.name}」：文件不存在或无法读取`);
      return null;
    }
    // ── 未保存内容：保存失败时的内容回写（仅普通文本标签有文本快照）──
    let contentRestored = false;
    if (e.dirtyAtClose && e.savedOnClose === false) {
      if (typeof e.text === 'string' && !tab.kind) {
        try {
          const view = primaryViewOf(tab);
          if (view && !view.isDestroyed) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: e.text },
              annotations: Transaction.addToHistory.of(false), // 恢复不是用户编辑，不进撤销栈
            });
            tab.state = view.state;
            registry.markDirty(tab, true);
            contentRestored = true;
          }
        } catch (err) {
          console.warn('[reopen] 内容回写失败:', err && err.message ? err.message : err);
        }
      }
    }
    // ── 光标/选区（普通文本标签；huge/viewer 没有 CM 文档，光标由各自视图恢复）──
    let cursorRestored = false;
    if (e.cursor) {
      try {
        const view = primaryViewOf(tab);
        if (view && !view.isDestroyed && !tab.kind) {
          const len = view.state.doc.length;
          const clamp = (n) => Math.max(0, Math.min(Number(n) || 0, len));
          view.dispatch({ selection: { anchor: clamp(e.cursor.anchor), head: clamp(e.cursor.head) } });
          tab.state = view.state; // 选区变化不走 updateListener 的 state 回写，必须显式同步
          cursorRestored = true;
        }
      } catch { /* 视图已销毁：光标不可恢复，下面如实登记 */ }
    }
    // ── 滚动位置（像素口径，与 switchTab 的 restoreTabScroll 同源）──
    let scrollRestored = false;
    if (typeof e.scrollTop === 'number') {
      tab.scrollTop = e.scrollTop;
      try { restoreTabScroll(tab, paneOfDoc(tab)); scrollRestored = true; } catch { /* 忽略 */ }
    }
    // ── A2 第 6 条：huge 的**视口首行**恢复（huge 的滚动位置不是 tab.scrollTop，见本节顶部说明）──
    let hugeScrollRestored = null;
    if (tab.kind === 'huge' && typeof e.hugeTopLine === 'number' && e.hugeTopLine > 1) {
      hugeScrollRestored = await restoreHugeTopLine(tab, e.hugeTopLine);
    }
    // ── pin / 只读 ──
    if (e.pinned) { tab.pinned = true; renderTabs(); }
    if (e.readOnly && !tab.kind) { void setTabReadOnly(tab, true).catch(() => { /* 忽略 */ }); }
    // ── 降级判定与**显式说明**（硬要求：做不到就明说，不许静默）──
    let degraded = false;
    let reason = '';
    if (e.dirtyAtClose && e.savedOnClose !== true && !contentRestored) {
      degraded = true;
      reason = tab.kind === 'huge' ? 'HUGE_OVERLAY_NOT_REATTACHED'
        : e.textOmitted ? 'TEXT_TOO_LARGE'
          : tab.kind ? 'KIND_NOT_RESTORABLE'
            : e.savePending ? 'SAVE_STILL_RUNNING'
              : 'SAVE_FAILED';
    }
    tab.reopenInfo = {
      from: 'closed-stack',
      kindAtClose: e.kind,
      kindNow: tab.kind || null,
      dirtyAtClose: e.dirtyAtClose,
      // verifier(t7) SAVEDONCLOSE-NULL-NOT-NORMALIZED / captain 裁决「一行归一到布尔」：
      // `null`（= 关闭时那次保存的 promise 尚未 settle）**不再透传给调用方**。`reopenInfo.savedOnClose`
      // 是产品可见字段，"关完立刻 Ctrl+Shift+T"读到 null 就是第三种静默态；归一成 false 与降级判定
      // 方向一致——`degraded` 判据本来就是 `e.savedOnClose !== true`（:2312），null 一直按"未确认保存"处理。
      // 注意：测试面快照 `closedTabs()`（:3836）**刻意保留 null**（它是既有用例
      // `p6Wait(top.savedOnClose !== null)` 的"已落定"信号），不随这一行归一。
      savedOnClose: e.savedOnClose === true,
      contentRestored,
      cursorRestored,
      scrollRestored,
      hugeScrollRestored, // null = 无需恢复（非 huge / 关闭时就在顶部）；true/false = 结果
      degraded,
      reason,
    };
    if (degraded) {
      const detail = reason === 'HUGE_OVERLAY_NOT_REATTACHED'
        ? '大文件（overlay）的未保存修改未随标签恢复：主进程侧编辑会话已在关闭时释放，保留的分片只在恢复区（本版没有一键重挂入口）'
        : reason === 'TEXT_TOO_LARGE'
          ? `未保存内容超过 ${TEXT_SNAPSHOT_MAX} 字符，未做本地快照，已按磁盘内容重开`
          : reason === 'KIND_NOT_RESTORABLE'
            ? '该类型标签的未保存内容不支持恢复，已按磁盘内容重开'
            : '关闭时保存未成功，已按磁盘内容重开';
      toast(`「${e.name}」已重开，但${detail}`);
    }
    // 滚动位置没恢复也要说（不静默）：huge 的索引在 12s 内没就绪，或视图已被销毁
    if (hugeScrollRestored === false) {
      toast(`「${e.name}」的大文件视图滚动位置未能恢复（行索引未就绪），已从头显示`);
    }
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 关标签。Phase 3 起有**两种粒度**（G3）：
   *   · **视图级**（默认，同一文档在别的栏还有视图时）：只关掉这一栏的视图，不落盘、不清脏、不删文档；
   *   · **文档级**（`opts.all === true`，或这是该文档的最后一个视图）：先保存脏内容再移除文档。
   *  `opts.paneId` / `opts.pane` 指定"用户在关哪一栏的视图"（✕ 按钮传入；缺省焦点栏优先）。 */
  function closeTab(tab, opts = {}) {
    if (!tab) return;
    const pane = paneForDocAction(tab, opts) || paneOfDoc(tab);
    // ── G3：文档在**多于一个栏**有视图，且调用方没要求"整篇关闭" → 视图级关闭（零副作用） ──
    if (!opts.all && registry.panesOf(tab).length > 1) {
      closeViewInPane(tab, pane, opts);
      return;
    }
    clearTimeout(tab.saveTimer); // 取消挂起的自动保存：否则关标签后 800ms 仍会把内容写盘
    // ── A2：入「最近关闭」栈（**在保存之前**取快照 —— 保存会清脏标记，之后就拿不到"关之前是脏的"）──
    // 视图级关闭（上面那条分支）不入栈：文档还在，重开无意义（语义与落栏规则见 §11 施工记录）。
    const closedEntry = pushClosedTab(tab, pane, opts);
    const hv = tab.kind === 'huge' ? tab.huge : null;
    // Phase D 第三步排序（**huge 只关会话、不写源文件**）：
    //   ① 调用一次 saveNow 收口（对本路径是**空操作**：doSaveNow 跑到时视图已销毁 ⇒ 返回 false，
    //      见 :3058 的调用方约定；普通/分段标签才是真的先写盘）→
    //   ② 关闭主进程侧编辑会话（discard:false：有未保存改动时 persistMeta 强刷块表到 <userData>/overlay，
    //      供 huge:doc-recover-list 恢复 —— **dirty huge 标签的改动只走这条路**，由渲染端恢复 UI 消费）→
    //   ③ 销毁视图 DOM。
    // 顺序缘由：关闭会话是异步的，而 closeTab 同步；把 ② 挂到 ① 返回的 promise 之后（destroy 只影响 DOM，可立即执行）。
    if (hv) {
      const saveP = opts.save !== false && tab.dirty ? saveNow(tab) : null;
      trackClosedSave(closedEntry, saveP);
      const closeSession = () => { try { hv.closeDoc(false); } catch { /* 会话已失效：忽略 */ } };
      if (saveP) saveP.then(closeSession, closeSession);
      else closeSession();
      try { hv.destroy(); } catch { /* 忽略 */ } // destroy 会移除 .huge-view 根节点
      tab.huge = null;
      tab.hugeEl = null;
    }
    if (opts.save === false) {
      // 删除/移走场景：丢弃未保存改动，禁止任何后续写盘（否则会把已删除的文件写回磁盘）
      registry.markDirty(tab, false);
    } else if (tab.dirty && tab.kind !== 'huge') {
      // 未保存：先触发一次立即保存（huge 已在上面按序处理，避免重复入队）
      trackClosedSave(closedEntry, saveNow(tab));
    } else if (tab.kind !== 'huge') {
      // 关之前就不脏：磁盘上已经是关闭时的内容，等价于"保存成功"
      trackClosedSave(closedEntry, null);
    }
    const list = registry.docsOf(pane.id);
    const idx = list.indexOf(tab);
    if (idx < 0 && registry.indexOf(tab) < 0) return;
    // 必须在 registry.remove 之前取：remove 会把该栏的活动指针清成 null
    const wasPaneActive = registry.activeOf(pane.id) === tab;
    // Phase 3 兜底：**其它栏**若也在渲染这个文档（opts.all 的整篇关闭），必须一并摘掉视图绑定，
    // 否则会留下"标签没了、CM 还在显示该文档"的僵尸视图，且 docOfView 会反查到一个已移除的文档。
    for (const p of panes) {
      if (p === pane) continue;
      if (registry.docOfView(p.view) === tab) {
        registry.unbindView(p.view);
        p.view.setState(makeState('', 'text'));
        registry.setActiveOf(p.id, null);
      }
    }
    registry.remove(tab);
    window.api.unwatchFile(tab.path); // 停止监听
    // Phase 4：本窗口关掉正在编辑的文件 → 显式交回编辑权（其余窗口收到「编辑权已空闲」，不自动变可编辑）。
    // 只在**本窗口确实持有编辑权**时调用：lockStates 里没有登记 = 首个打开者（主进程侧 mode='edit'），
    // 那种情况由 stopWatch 的摘除路径自动广播，不必多打一次 IPC。
    if (tab.path) {
      const lk = lockStates.get(tab.path);
      if (lk && lk.mode === 'edit') {
        lockStates.delete(tab.path);
        Promise.resolve(window.api.releaseEdit(tab.path)).catch(() => { /* 窗口/文档已失效：忽略 */ });
      } else if (lk && lk.mode === 'read') {
        lockStates.delete(tab.path);
      }
    }
    if (wasPaneActive) {
      // 关的是**本栏**的活动标签 → 切到栏内邻居（Phase 2：不再跨栏取邻居）
      const next = list[Math.max(0, idx - 1)] || null;
      if (next && next !== tab) {
        switchTab(next);
      } else {
        registry.setActiveOf(pane.id, null);
        registry.unbindView(pane.view); // 无活动文档 ⇒ 视图归属一并解除（避免反查拿到已关闭文档）
        pane.imageHost.classList.add('hidden');
        pane.view.setState(makeState('', 'text'));
        syncEditorLayer(pane, null); // 本栏无活动标签：恢复本栏 CM（隐藏本栏所有 huge 视图根节点）
        renderTabsAll();
        updateEmpty();
        if (isFocusedPane(pane)) {
          updateStatusBar();
          onTabSwitch(null);
        }
      }
    } else {
      renderTabsAll();
      updateEmpty();
    }
    // 关掉栏内最后一个标签 → 该栏撤掉，回落单栏（splitCloseLast 的语义）。
    // Phase 3：整篇关闭时另一栏也可能因此变空，所以遍历一次而不是只判本栏。
    if (panes.length > 1) {
      for (const p of [...panes]) {
        if (panes.length < 2) break;
        if (registry.countIn(p.id) === 0) removeEmptyPane(p);
      }
    }
    if (onSessionChange) onSessionChange();
  }

  /** 关闭全部标签（**整篇关闭**：同一文件的两个视图一起关 —— 会话清空/换目录等调用方要的是这个） */
  function closeAll() {
    for (const t of [...docs()]) closeTab(t, { all: true });
  }

  // ---------- 标签 Pin（固定）与批量关闭 ----------
  function togglePinned(tab) {
    setPinned(tab, !tab.pinned);
  }

  /** 设置固定状态：改 pinned → 重绘标签栏 + 会话持久化（pin 随 lastSession.pinned 持久化） */
  function setPinned(tab, v) {
    if (!tab) return;
    tab.pinned = !!v;
    renderTabs();
    if (onSessionChange) onSessionChange();
  }

  // ==========================================================================
  // 0.5.0 Phase 5a F2：标签右键的「常用项」（与 tree.js 的 commonCtxItems **同源副本**）
  // --------------------------------------------------------------------------
  // 安全面：三条新 IPC（shell:open-path / shell:open-terminal / clipboard:write-text）在主进程侧
  // 一律先过 security.requireApproved（路径白名单）；「在终端打开」路径**只作 cwd**、argv 恒空、
  // shell:false —— 渲染端不做任何命令字符串拼接。tree.js 里有一份逐字相同的实现（两文件互相不
  // import，避免循环依赖），改动必须两处同步（施工文档 §11）。
  // ==========================================================================
  async function copyTabPathOrName(p, kind) {
    const name = baseName(p);
    try {
      // **只传 { path, kind }**：剪贴板正文由主进程自拼（渲染进程无法写任意内容，见 ipc.js 的通道注释）
      const r = await window.api.copyText({ path: p, kind: kind === 'name' ? 'name' : 'path' });
      if (!r || r.ok !== true) {
        toast(`复制失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
        return false;
      }
      toast(kind === 'name' ? `已复制文件名：${name}` : '已复制路径');
      return true;
    } catch (err) {
      toast('复制失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }
  async function openTabInTerminal(p, opts) {
    try {
      const r = await window.api.openTerminal(p, opts);
      if (!r || r.ok !== true) {
        toast(`在终端打开失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
        return r || { ok: false, reason: 'UNKNOWN' };
      }
      if (!r.dryRun) toast(`已在终端打开：${r.cwd}`);
      return r;
    } catch (err) {
      toast('在终端打开失败：' + (err && err.message ? err.message : err));
      return { ok: false, reason: 'ERR', message: String(err && err.message ? err.message : err) };
    }
  }
  async function openTabWithDefault(p) {
    try {
      const r = await window.api.openPath(p);
      if (!r || r.ok !== true) {
        toast(`打开失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
        return r || { ok: false, reason: 'UNKNOWN' };
      }
      return r;
    } catch (err) {
      toast('打开失败：' + (err && err.message ? err.message : err));
      return { ok: false, reason: 'ERR', message: String(err && err.message ? err.message : err) };
    }
  }
  /** F2：标签右键的五个常用项（无路径的标签——对比视图——返回空数组） */
  function tabCommonCtxItems(p) {
    if (!p) return [];
    return [
      { sep: true },
      { label: '📁 在资源管理器中显示', onClick: () => window.api.showInFolder(p) },
      { label: '📋 复制路径', onClick: () => { void copyTabPathOrName(p, 'path'); } },
      { label: '📋 复制文件名', onClick: () => { void copyTabPathOrName(p, 'name'); } },
      { label: '⌨ 在终端打开（此目录）', onClick: () => { void openTabInTerminal(p); } },
      { label: '🚀 用默认程序打开', onClick: () => { void openTabWithDefault(p); } },
    ];
  }

  /** 标签右键菜单：固定/取消固定 → 只读切换（跨窗口共享文件）→ 同文件多视图 → 批量关闭 → 关闭当前 */
  function showTabCtx(x, y, tab) {
    const items = [
      { label: tab.pinned ? '📌 取消固定' : '📌 固定标签', onClick: () => togglePinned(tab) },
    ];    if (!tab.kind) {
      items.push({ label: tab.readOnly ? '🔓 允许编辑' : '🔒 设为只读', onClick: () => toggleReadOnly(tab) });
    }
    // Phase 3（G2 的用户入口）：把标签在**另一栏**再开一个视图（同一文件、同一内容真源）。
    // 只对普通文本/分段文档提供（huge/viewer-lg/image/diff 是路径单例或窗口级语义，见 attachViewToPane）。
    if (tab.path && !SINGLE_VIEW_KINDS[tab.kind]) {
      items.push({ label: '⧉ 在另一栏打开（同文件多视图）', onClick: () => openInOtherPane(tab) });
    }
    items.push(
      { sep: true },
      { label: '关闭其它标签', onClick: () => closeOthers(tab) },
      { label: '关闭右侧标签', onClick: () => closeRight(tab) },
      { label: '关闭左侧标签', onClick: () => closeLeft(tab) },
      { sep: true },
      // v0.4.0：固定标签会拦住上述批量关闭，这里给一个"真能关干净"的入口
      // （关闭全部含固定标签；未保存内容仍会先落盘；会话随后清空）
      { label: '✕ 关闭全部标签（含固定）', danger: true, onClick: () => { closeAll(); toast('已关闭全部标签'); } },
      { label: '✕ 关闭标签', onClick: () => onRequestClose(tab) }
    );
    // F2：常用项（在资源管理器中显示 / 复制路径 / 复制文件名 / 在终端打开 / 用默认程序打开）
    items.push(...tabCommonCtxItems(tab.path));
    showContextMenu(x, y, items);
  }

  /** 标签右键「⧉ 在另一栏打开」：把该文档在另一栏再开一个视图（栏不存在时先开栏）。
   *  同一文件 → 同一 Document（读盘不重复）→ 两份独立 EditorState + 变更广播。 */
  function openInOtherPane(tab) {
    if (!tab || !tab.path) return false;
    const homes = registry.panesOf(tab);
    let target = panes.find((p) => homes.indexOf(p.id) < 0) || null;
    if (!target) {
      if (panes.length >= MAX_PANES) {
        toast('该文件已在两个栏各有一个视图');
        return false;
      }
      target = createSidePane('right'); // 单栏 → 右侧开空栏
      if (!target) return false;
    }
    const ok = attachViewToPane(tab, target);
    if (ok) setFocusPane(target.id, { notify: true });
    return ok;
  }

  /** 只读切换（D2 跨窗口同文件协调 + 通用）：开启只读前若有未保存修改先保存；
   *  视图在线热切换 readOnly compartment，不重建 DOM（无闪烁）。 */
  async function toggleReadOnly(tab) {
    if (!tab || tab.kind) return;
    await setTabReadOnly(tab, !tab.readOnly);
  }

  async function setTabReadOnly(tab, v) {
    if (!tab || tab.kind || tab.readOnly === !!v) return true;
    if (v && tab.dirty) {
      const ok = await saveNow(tab); // 转只读前落盘，避免脏内容被只读态锁住
      if (!ok) return false;
    }
    tab.readOnly = !!v;
    // C5（Phase 3 版）：只读是**文档级**决定 → 必须落到该文档的**每一个视图**上
    // （同一文件两栏时两个 view 各持一份 EditorState，只改一个会让另一栏仍可写）
    const roViews = registry.viewsOf(tab);
    for (const vw of roViews) {
      try { vw.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!v)) }); } catch { /* 视图已销毁 */ }
    }
    const pv = primaryViewOf(tab);
    if (pv) tab.state = pv.state;
    if (registry.isActive(tab) && isFocusedPane(paneForDocAction(tab))) updateStatusBar();
    renderTabs();
    // Phase 4：只读态与"跨窗口锁"联动 —— 横幅随之出现/收起（手动右键只读不受影响：
    // 横幅只看 lockStates，不看 tab.readOnly）
    updateAllLockBanners();
    return true;
  }

  // ==========================================================================
  // 0.5.0 Phase 4：跨窗口「接管编辑」（L2）+ 冲突提示（L3，默认关）
  // --------------------------------------------------------------------------
  //  主进程锁表见 src/main/filewatch.js 顶部说明（watchers 表上的 entry.mode）。渲染端只做三件事：
  //   ① 把主进程告知的锁态记进 lockStates（不猜状态）；
  //   ② 只读观察窗显示**显性横幅 + 「✏️ 接管编辑」按钮**（不藏在标签右键里）；
  //   ③ 被降级时转只读 + toast（**不自动关窗、不弹原生对话框**）。
  //  边界（写死在代码里，别越界）：huge 的所有权走 overlay-ipc 的 WINDOW_NOT_OWNER（路径单例），
  //  本横幅**只对普通文本标签生效**（tab.kind 存在即跳过）—— 在大文件标签上显示"接管编辑"会误导用户
  //  （那条通道不是抢锁，而是另开/复用 overlay 会话）。
  // ==========================================================================

  /** 更新某一栏的锁横幅（该栏**活动文档**决定内容） */
  function updateLockBanner(pane) {
    if (!pane || !pane.lockBar) return;
    const tab = registry.activeOf(pane.id);
    const claimBtn = pane.lockBar.querySelector('.lock-claim');
    const text = pane.lockBar.querySelector('.lock-text');
    // 只对普通文本标签显示（kind 存在 → overlay/viewer/图片/对比 另有规则，见上方边界说明）
    const st = tab && tab.path && !tab.kind ? lockStates.get(tab.path) : null;
    if (!st || (st.mode !== 'read' && !st.sharedEdit)) {
      pane.lockBar.classList.add('hidden');
      pane.lockBar.dataset.path = '';
      return;
    }
    if (st.mode === 'read') {
      // 只读横幅只在本窗口**确实只读**时显示：锁态是主进程事实，但"能不能打字"由 tab.readOnly 决定
      // （用户可在标签右键手动解除只读 —— 那条既有逃生口不受本阶段影响；两者不一致时宁可不出横幅，
      //  也不能出现"编辑器明明能输入、横幅却说本窗口只读"的误导）。
      if (tab.readOnly !== true) {
        pane.lockBar.classList.add('hidden');
        pane.lockBar.dataset.path = '';
        return;
      }
      text.textContent = st.freed
        ? `🔓 「${tab.name}」的编辑权已空闲（本窗口只读，可一键接管）`
        : `🔒 「${tab.name}」正由另一窗口编辑 —— 本窗口只读`;
      claimBtn.classList.remove('hidden');
    } else {
      // L3：多窗口同时可编辑 —— 只提示风险，不给"接管"按钮（没有独占权可抢）
      text.textContent = `⚠ 「${tab.name}」另一窗口也在编辑（冲突提示已开启，保存前请留意覆盖）`;
      claimBtn.classList.add('hidden');
    }
    pane.lockBar.dataset.path = tab.path;
    pane.lockBar.classList.remove('hidden');
  }

  function updateAllLockBanners() {
    for (const p of panes) updateLockBanner(p);
  }

  /** 接管编辑（横幅按钮 / 测试面 API）：把编辑权移到本窗口。
   *  成功 → 本窗口转可编辑、横幅收起、toast；原窗口由主进程通知后自行转只读 + toast。 */
  async function claimEdit(tab) {
    if (!tab || !tab.path || tab.kind) return false;
    const res = await window.api.claimEdit(tab.path).catch(() => null);
    if (!res || res.ok !== true) {
      toast(`接管编辑失败：${(res && res.reason) || '未知原因'}`);
      return false;
    }
    lockStates.set(tab.path, { mode: 'edit', owner: res.owner, sharedEdit: res.exclusive !== true, freed: false });
    await setTabReadOnly(tab, false);
    updateAllLockBanners();
    toast(res.exclusive === true
      ? `已接管「${tab.name}」的编辑权：原窗口已转为只读`
      : `已接管「${tab.name}」的编辑权（冲突提示已开启，另一窗口仍可编辑）`);
    return true;
  }

  /** 交回编辑权（关掉正在编辑的标签时调用；其余窗口收到「编辑权已空闲」提示，不自动变可编辑） */
  async function releaseEdit(tab) {
    if (!tab || !tab.path) return false;
    const res = await window.api.releaseEdit(tab.path).catch(() => null);
    if (!res || res.ok !== true) return false;
    lockStates.set(tab.path, { mode: 'read', owner: null, sharedEdit: false, freed: true });
    updateAllLockBanners();
    return true;
  }

  /** 主进程锁变更事件的落地（file-lock-changed） */
  async function onLockChanged(d) {
    if (!d || !d.path) return;
    const tab = docs().find((t) => t.path === d.path);
    if (d.mode === 'edit' && d.sharedEdit) {
      // L3：另一窗口也拿到了编辑权（主进程未降级任何一方）
      lockStates.set(d.path, { mode: 'edit', owner: d.owner, sharedEdit: true, freed: false });
      if (tab && d.owner !== d.self) toast(`「${tab.name}」另一窗口也处于编辑态（冲突提示已开启）`);
      updateAllLockBanners();
      return;
    }
    if (d.mode === 'read') {
      lockStates.set(d.path, { mode: 'read', owner: d.owner || null, sharedEdit: false, freed: !!d.freed });
      if (tab) {
        if (d.freed) {
          toast(`「${tab.name}」的编辑权已空闲，可在横幅点「✏️ 接管编辑」`);
        } else {
          await setTabReadOnly(tab, true); // 转只读（脏内容先落盘，见 setTabReadOnly）
          toast(`「${tab.name}」已被另一窗口接管编辑，本窗口转为只读（可在横幅一键接管）`);
        }
      }
      updateAllLockBanners();
    }
  }

  /** 显示跨窗口编辑冲突横幅（L3；只在"多窗口同时可编辑 + 本窗口有未保存修改"时出现） */
  function showConflictBanner(tab, pane) {
    const p = pane || paneOfDoc(tab) || focusedPane();
    if (!p || !p.conflictBar) return false;
    p.conflictTab = tab;
    p.conflictBar.dataset.path = tab.path || '';
    p.conflictBar.querySelector('.conflict-text').textContent =
      `⚠ 跨窗口编辑冲突：「${tab.name}」已在另一窗口保存，本窗口有未保存修改`;
    p.conflictBar.classList.remove('hidden');
    return true;
  }

  function hideConflictBanner(pane) {
    if (!pane || !pane.conflictBar) return;
    pane.conflictBar.classList.add('hidden');
    p.conflictBar.dataset.path = '';
    pane.conflictTab = null;
  }

  /** 渲染端锁态快照（测试面 / 调试）：主进程事实的本地镜像 */
  function lockStateOfPath(p) {
    const st = lockStates.get(p);
    return st ? { mode: st.mode, owner: st.owner, sharedEdit: !!st.sharedEdit, freed: !!st.freed } : null;
  }

  /** 批量关闭：对快照迭代，保留「锚定标签 + 范围内 pinned 标签」，末尾激活锚定标签。
   *  Phase 2：范围限定在**锚定标签所属栏**内（批量关闭不再跨栏误伤另一栏的文件）。 */
  function notifySkippedPinned(skipped) {
    if (skipped > 0) toast(`已跳过 ${skipped} 个固定标签（可在标签右键取消固定，或用「关闭全部标签」）`);
  }

  function closeOthers(anchor) {
    if (!anchor) return;
    const scope = registry.docsOf(paneOfDoc(anchor).id);
    if (scope.length < 2) return;
    let skipped = 0;
    for (const t of [...scope]) {
      if (t === anchor) continue;
      if (t.pinned) { skipped++; continue; }
      closeTab(t);
    }
    switchTab(anchor);
    notifySkippedPinned(skipped);
  }

  function closeLeft(anchor) {
    if (!anchor) return;
    const scope = registry.docsOf(paneOfDoc(anchor).id);
    const ai = scope.indexOf(anchor);
    if (ai < 0) return;
    let skipped = 0;
    for (const t of scope.slice(0, ai)) {
      if (t.pinned) { skipped++; continue; }
      closeTab(t);
    }
    switchTab(anchor);
    notifySkippedPinned(skipped);
  }

  function closeRight(anchor) {
    if (!anchor) return;
    const scope = registry.docsOf(paneOfDoc(anchor).id);
    const ai = scope.indexOf(anchor);
    if (ai < 0) return;
    let skipped = 0;
    for (const t of scope.slice(ai + 1)) {
      if (t.pinned) { skipped++; continue; }
      closeTab(t);
    }
    switchTab(anchor);
    notifySkippedPinned(skipped);
  }

  /** 渲染**某一栏**的标签栏（Phase 2：每栏各有一条标签栏，p0 的仍挂 #tabs） */
  function renderPaneTabs(pane) {
    pane.tabsEl.innerHTML = '';
    for (const tab of registry.docsOf(pane.id)) {      const el = document.createElement('div');
      el.className = `tab ${registry.activeOf(pane.id) === tab ? 'active' : ''} ${tab.pinned ? 'pinned' : ''}`;
      el.title = tab.path || tab.name;
      el.dataset.path = tab.path || '';
      // 拖标签到编辑区左/右边缘 → 该侧开栏（HTML5 DnD；中间区域本阶段不做排序）
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        dragTab = tab;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', tab.name); } catch { /* 某些环境禁用自定义数据 */ }
        }
      });
      el.addEventListener('dragend', () => {
        dragTab = null;
        for (const p of panes) p.body.classList.remove('pane-drop-left', 'pane-drop-right');
      });
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.name;
      el.appendChild(name);
      if (tab.pinned) {
        // 📌 固定标记：点击切换 pin 状态（stopPropagation 防误触发 switchTab）
        const pin = document.createElement('span');
        pin.className = 'tab-pin';
        pin.textContent = '📌';
        pin.title = '取消固定';
        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePinned(tab);
        });
        el.appendChild(pin);
      }
      if (tab.readOnly) {
        // 🔒 只读标记（跨窗口共享文件自动只读 / 手动切换）
        const ro = document.createElement('span');
        ro.className = 'tab-pin';
        ro.textContent = '🔒';
        ro.title = '只读（右键标签可解除）';
        el.appendChild(ro);
      }
      // 未保存圆点：常驻元素 + hidden 切换（增量化更新用，见 updateTabBadges）
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      if (!tab.dirty) dot.classList.add('hidden');
      el.appendChild(dot);
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        // Phase 3：把「关的是哪一栏的这条标签」传上去 —— 同一文件在两栏各有一条 .tab，
        // 不传栏号就无法区分"关这个视图"和"关那个视图"（G3 的视图级关闭）
        onRequestClose(tab, pane.id);
      });
      el.appendChild(close);
      // 点标签 = 「聚焦本栏 + 切到该标签」：先移焦点指针，switchTab 才只对焦点栏触发预览/树跟随
      el.addEventListener('click', () => {
        setFocusPane(pane.id, { notify: false });
        switchTab(tab);
      });
      // 标签右键菜单：preventDefault + stopPropagation（与树菜单共用单例 #ctx-menu）
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabCtx(e.clientX, e.clientY, tab);
      });
      pane.tabsEl.appendChild(el);
      pane.tabBadges.set(tab, el); // O1：结构渲染时登记元素，供徽标级增量更新
    }
    updateTabsOverflow(pane); // A3：每次结构重建后重算溢出（该栏自己的 scrollWidth/clientWidth）
    if (pane.tabsMenu && !pane.tabsMenu.classList.contains('hidden')) buildTabsMenu(pane); // 菜单开着时同步内容
  }

  // ==========================================================================
  // 0.5.0 Phase 5a A3：标签栏溢出处理（**按栏各自计算**）
  // --------------------------------------------------------------------------
  // 三件事：① 滚轮横滚（绑在该栏 .tabs 上）② 「▾ 全部标签」下拉（只列**本栏**的文档）
  // ③ Ctrl+Tab 切换浮层（HUD，只显示焦点栏）。判据与数据源全部走 registry 的按栏 API
  // （docsOf / activeOf），没有任何"全窗口唯一活动标签"的假设 —— 双栏下两栏各自独立。
  // ==========================================================================
  /** 该栏标签栏是否溢出（1px 容差：亚像素布局下 scrollWidth 可能比 clientWidth 大 0.x） */
  function tabsOverflowing(pane) {
    const el = pane.tabsEl;
    return el.scrollWidth > el.clientWidth + 1;
  }
  function updateTabsOverflow(pane, keepMenu) {
    const over = tabsOverflowing(pane);
    pane.root.classList.toggle('has-tab-overflow', over);
    // 不溢出时收起下拉（标签少了/栏变宽了）；keepMenu=true 用于"菜单是刚刚被主动打开"的场景，
    // 否则 openTabsMenu 会把自己刚打开的菜单立刻关掉
    if (!over && !keepMenu) closeTabsMenu(pane);
    return over;
  }
  function updateAllTabsOverflow() {
    for (const p of panes) updateTabsOverflow(p);
  }
  function closeTabsMenu(pane) {
    const menu = pane.tabsMenu;
    if (!menu || menu.classList.contains('hidden')) return false;
    menu.classList.add('hidden');
    menu.innerHTML = '';
    return true;
  }
  function closeAllTabsMenus() {
    let any = false;
    for (const p of panes) if (closeTabsMenu(p)) any = true;
    return any;
  }
  /** 构建「全部标签」下拉内容（数据源 = 该栏的 docsOf，高亮 = 该栏的 activeOf） */
  function buildTabsMenu(pane) {
    const menu = pane.tabsMenu;
    if (!menu) return 0;
    const docsInPane = registry.docsOf(pane.id);
    const act = registry.activeOf(pane.id);
    menu.innerHTML = '';
    for (const tab of docsInPane) {
      const item = document.createElement('div');
      item.className = 'tabs-menu-item' + (tab === act ? ' current' : '');
      item.title = tab.path || tab.name;
      item.dataset.path = tab.path || '';
      const name = document.createElement('span');
      name.className = 'tm-name';
      name.textContent = tab.name;
      item.appendChild(name);
      if (tab.pinned) {
        const pin = document.createElement('span');
        pin.className = 'tm-pin';
        pin.textContent = '📌';
        item.appendChild(pin);
      }
      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tm-dot';
        item.appendChild(dot);
      }
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTabsMenu(pane);
        setFocusPane(pane.id, { notify: false }); // 先移焦点指针：switchTab 只对焦点栏触发预览/树跟随
        switchTab(tab);
      });
      menu.appendChild(item);
    }
    return docsInPane.length;
  }
  function openTabsMenu(pane) {
    closeAllTabsMenus();
    buildTabsMenu(pane);
    pane.tabsMenu.classList.remove('hidden');
    updateTabsOverflow(pane, true); // keepMenu：不因"此刻不溢出"把自己刚打开的菜单关掉
    return pane.tabsMenu.querySelectorAll('.tabs-menu-item').length;
  }
  function toggleTabsMenu(pane) {
    if (pane.tabsMenu.classList.contains('hidden')) {
      openTabsMenu(pane);
      return true;
    }
    closeTabsMenu(pane);
    return false;
  }
  // 点空白处关菜单（capture=false：项目自身的 stopPropagation 已先处理点击切换）
  document.addEventListener('click', () => closeAllTabsMenus());

  // ---------- Ctrl+Tab 切换浮层（HUD） ----------
  /** 浮层是**窗口级单例**（同一时刻只有焦点栏在循环），但内容恒取当前焦点栏 —— 双栏下
   *  Ctrl+Tab 只在该栏内循环（G6 已锁定的口径），浮层因此不会串栏。 */
  let tabHudEl = null;
  let tabHudTimer = null;
  function ensureTabHud() {
    if (tabHudEl && tabHudEl.isConnected) return tabHudEl;
    tabHudEl = document.createElement('div');
    tabHudEl.className = 'tab-hud hidden';
    document.body.appendChild(tabHudEl);
    return tabHudEl;
  }
  function showTabHud(pane) {
    const el = ensureTabHud();
    const docsInPane = registry.docsOf(pane.id);
    const act = registry.activeOf(pane.id);
    const title = document.createElement('div');
    title.className = 'tab-hud-title';
    title.textContent = docsInPane.length > 1 ? `切换标签（此栏 ${docsInPane.length} 个，${docsInPane.indexOf(act) + 1}/${docsInPane.length}）` : '此栏只有 1 个标签';
    el.innerHTML = '';
    el.appendChild(title);
    for (const tab of docsInPane) {
      const row = document.createElement('div');
      row.className = 'tab-hud-item' + (tab === act ? ' current' : '');
      row.textContent = (tab.dirty ? '● ' : '') + tab.name;
      el.appendChild(row);
    }
    el.classList.remove('hidden');
    clearTimeout(tabHudTimer);
    tabHudTimer = setTimeout(() => { if (tabHudEl) tabHudEl.classList.add('hidden'); }, 1200);
    return { paneId: pane.id, count: docsInPane.length, current: act ? docsInPane.indexOf(act) : -1 };
  }
  function hideTabHud() {
    clearTimeout(tabHudTimer);
    if (tabHudEl) tabHudEl.classList.add('hidden');
    return true;
  }
  // 窗口尺寸 / 栏容器尺寸变化 → 每栏重算溢出（底部面板折叠/最大化会改编辑区高度，
  // 但 A3 只关心横向宽度；ResizeObserver 覆盖分栏、侧栏拖宽、窗口缩放全部路径）。
  window.addEventListener('resize', () => updateAllTabsOverflow());
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(() => updateAllTabsOverflow()).observe(panesRoot); } catch { /* 环境不支持则退化为 resize 事件 */ }
  }

  /** 全量重绘所有栏的标签栏（公开 API `renderTabs` 仍是这个名字，语义扩为「每栏各绘一次」） */
  function renderTabsAll() {
    hideContextMenu(); // 高频重建时避免悬空菜单
    for (const pane of panes) renderPaneTabs(pane);
    updateEmpty();
    updateAllLockBanners(); // Phase 4：锁横幅跟随活动标签（标签增减/切换都会经过这里）
  }

  function renderTabs() {
    renderTabsAll();
  }

  // ---------- O1：标签徽标增量更新 ----------
  // docChanged / 保存 / 切换等高频路径只改 active 类与 dirty 圆点，不再全量重建标签 DOM ——
  // 100+ 标签时每击键的 O(N) DOM 重建是键入延迟的主要来源
  function updateTabBadges() {
    for (const pane of panes) {
      const act = registry.activeOf(pane.id);
      for (const [tab, el] of pane.tabBadges) {
        if (!el.isConnected) {
          pane.tabBadges.delete(tab);
          continue;
        }
        el.classList.toggle('active', act === tab); // 判据 = **该栏**的活动文档（不再是全窗口唯一活动指针）
        const dot = el.querySelector('.tab-dot');
        if (dot) dot.classList.toggle('hidden', !tab.dirty);
      }
    }
  }

  function updateEmpty() {
    for (const pane of panes) {
      pane.empty.classList.toggle('hidden', !!registry.activeOf(pane.id) || registry.countIn(pane.id) > 0);
    }
  }

  // ---------- 保存 ----------
  /** 保存队列：所有保存（自动保存防抖 / Ctrl+S / 关标签 / Python 运行前置）全局串行合并 ——
   *  并发 saveNow 在大文件 ensureFullyLoaded 阶段交错是截断写盘的竞态源；排队后后来者
   *  看到干净标签直接返回，不重复写。 */
  let saveQueue = Promise.resolve();

  /** 保存标签内容。返回 true（已保存 / 本就无改动）或 false（写盘失败）——
   *  Python 运行等调用方据此中止后续动作。 */
  function saveNow(tab) {
    const run = saveQueue.then(() => doSaveNow(tab));
    saveQueue = run.then(
      () => undefined,
      () => undefined
    ); // 队列不因单次失败断裂
    return run;
  }

  /** 按原文件行尾风格还原文本：CM6 把 CRLF 归一化为 LF，直接写回会把整个文件的行尾改掉
   *  （Windows 下 .bat/.ps1/.csv 等会因此行为异常，git 也会出现整文件 diff）。 */
  function applyEol(text, crlf) {
    return crlf ? String(text).replace(/\r?\n/g, '\r\n') : String(text);
  }

  async function doSaveNow(tab) {
    // 无参调用（app.js:1062 的 Ctrl+S 面板入口）取活动文档；Phase 2 要定义"取哪个 pane"
    const t = tab || registry.active();
    if (!t) return true;
    if (t.kind === 'huge') {
      // v0.4.0 Phase D 第三步：大文件走 overlay 保存（huge:doc-save —— 原子全量重写：
      // 干净块按原字节拷贝 + overlay 分片 → 临时文件 → fsync → 校验 → rename）。
      // **绝不能落到下面的整篇写盘分支**：tab.state 是空文档，一旦写盘会把 GB 级文件截成 0 字节。
      // 未挂载的 huge 标签没有视图 = 没有编辑会话（huge 实例跨标签切换常驻，只在 closeTab 销毁）。
      const hv = t.huge;
      if (!hv) {
        // 视图/会话已销毁 —— 典型来源是 closeTab：它把 saveNow(tab) 排进 saveQueue（微任务才跑），
        // 紧接着同步 hv.destroy() + tab.huge=null，于是轮到这里时已经没有会话可保存了。
        // **绝不能报 true**：那会让调用方以为"已保存"（A2 重开会据此把"静默丢内容"当成恢复成功）。
        // 调用方约定：返回 false = **本次没有发生写盘**（不等于"写失败"），不得据此认为内容已落盘；
        // 大文件关标签路径本就"从不写源文件"（改动留在 overlay 恢复区，由 huge:doc-recover-list 兜底），
        // 记账方 trackClosedSave 依据本返回值推导 savedOnClose（见 :2199）。
        return false;
      }
      if (!hv.isDirty()) return true; // 与普通标签「无改动直接返回」同语义
      // 自写回声双保险：大文件保存耗时可达数秒（拷贝 + fsync + rename），主进程在 rename 之后
      // 才 markSelfWrite —— 事件可能抢在标记之前到达；这里在**保存起点**就打点，窗口取 3s。
      t.lastSavedAt = Date.now();
      try {
        const ok = await hv.save();
        if (ok) {
          registry.markDirty(t, false);
          updateTabBadges();
          if (onSaveStatus) onSaveStatus(`已保存 ${t.name}`);
        } else if (onSaveStatus) {
          onSaveStatus(`保存失败：${t.name}（详见状态栏）`);
        }
        return ok === true;
      } catch (err) {
        if (onSaveStatus) onSaveStatus(`保存失败：${err.message || err}`);
        return false;
      }
    }
    if (!t.dirty) return true;
    if (t.kind === 'viewer-lg') {
      return saveViewerRegion(t); // 区域编辑内容按字节偏移拼接写回
    }
    if (t.kind === 'chunked' && !t.chunk.complete) {
      await ensureFullyLoaded(t); // P7：先补齐剩余分段再写盘，防止只写已加载部分造成截断
      if (!t.chunk.complete) {
        // 补读失败（文件被删/被锁/超出上限）：绝不写盘，否则会把用户文件截断
        if (onSaveStatus) {
          onSaveStatus(`保存失败：分段未加载完整（${formatSize(t.chunk.loaded)} / ${formatSize(t.chunk.size)}）`);
        }
        return false;
      }
    }
    const content = applyEol(stripChunkMarkers(t.state.doc.toString()), t.crlf); // 剥离占位标记 + 还原行尾
    try {
      if (t.state.doc.length > 64_000_000) {
        await saveStreamed(t); // 超大文档：分块流式写（避免单串 IPC 的内存/长度悬崖）
      } else {
        await window.api.writeFile(t.path, content);
      }
      registry.markDirty(t, false);
      t.lastSavedAt = Date.now(); // 自写回声双保险：file-changed 通知到达时据此忽略刚保存后的回声
      if (onSaveStatus) onSaveStatus(`已保存 ${t.name}`);
      updateTabBadges();
      return true;
    } catch (err) {
      if (onSaveStatus) onSaveStatus(`保存失败：${err.message || err}`);
      return false;
    }
  }

  /** 超大文档分块流式写：16M 字符一块经 write-stream 通道落盘，避免 doc.toString() 单串
   *  （V8 单字符串上限 ≈ 5.36 亿字符）与结构化克隆的整串内存峰值。
   *  逐块同样要剥离分段占位标记并还原行尾（占位标记总在文末，落在最后一块）。 */
  async function saveStreamed(t) {
    const total = t.state.doc.length;
    const id = await window.api.writeStreamOpen(t.path);
    try {
      const CHUNK = 16_000_000;
      for (let pos = 0; pos < total; pos += CHUNK) {
        const piece = applyEol(stripChunkMarkers(t.state.doc.sliceString(pos, Math.min(pos + CHUNK, total))), t.crlf);
        await window.api.writeStreamAppend(id, piece);
      }
      await window.api.writeStreamClose(id);
    } catch (err) {
      try { await window.api.writeStreamClose(id); } catch { /* fd 已失效 */ }
      throw err;
    }
  }

  /** 换行设置是**应用级**开关，但要落到**每个栏**的视图上（C4：Compartment 可复用，reconfigure 必须逐 view 派发） */
  function setWordWrap(on) {
    wordWrapOn = on;
    for (const pane of panes) {
      const cur = registry.activeOf(pane.id);
      if (!cur || cur.kind) continue;
      pane.view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
      cur.state = pane.view.state;
    }
  }

  /** 设置缩进宽度（空格数，clamp 1~8）：新开标签（makeState）与各栏活动标签（reconfigure）立即生效 */
  function setIndentSize(n) {
    indentSize = clampIndent(n);
    for (const pane of panes) {
      const cur = registry.activeOf(pane.id);
      if (!cur || cur.kind) continue;
      pane.view.dispatch({ effects: indentCompartment.reconfigure(indentExtensions(indentSize)) });
      cur.state = pane.view.state;
    }
  }

  /** 滚动到顶部（状态栏按钮）：编辑器 / 图片视图 / 对比视图通用，不改光标。取**焦点栏**的文档。 */
  function scrollToTop() {
    const pane = focusedPane();
    const t = registry.activeOf(pane.id);
    if (!t) return;
    if (t.kind === 'image') {
      pane.imageHost.scrollTop = 0;
      return;
    }
    if (t.kind === 'diff') {
      const sc = pane.diffHost && pane.diffHost.querySelector('.diff-scroller');
      if (sc) sc.scrollTop = 0;
      return;
    }
    pane.view.scrollDOM.scrollTop = 0;
  }

  /** 滚动到底部（状态栏按钮）：chunked 标签先补齐剩余分段（显式到底部 = 与保存同语义），
   *  追加后高度测量异步 → 多帧校正；图片视图直接滚到底。 */
  async function scrollToBottom() {
    const pane = focusedPane();
    const t = registry.activeOf(pane.id);
    if (!t) return;
    if (t.kind === 'image') {
      pane.imageHost.scrollTop = pane.imageHost.scrollHeight;
      return;
    }
    if (t.kind === 'chunked' && !t.chunk.complete) {
      await ensureFullyLoaded(t);
    }
    // Phase 3：滚动目标是**焦点栏**这个视图（同文件两栏时 viewOfDoc 会取主栏，可能滚错栏）
    const el = pane.view.scrollDOM;
    const set = (n) => {
      if (registry.activeOf(pane.id) !== t || !el) return;
      el.scrollTop = el.scrollHeight;
      if (n > 0) requestAnimationFrame(() => set(n - 1));
    };
    set(4);
  }

  // ---------- v0.2.0：对比标签 ----------
  /** 打开（或激活）一个对比标签：左右内容只读双栏 diff。
   *  opts: { leftLabel, leftContent, rightLabel, rightContent }；同参数组合已开则激活。 */
  function openDiffTab(opts) {
    const key = 'diff://' + (opts.three ? '3:' : '') + opts.leftLabel + '⟷' + (opts.three ? opts.midLabel + '⟷' : '') + opts.rightLabel;
    const existing = registry.byDiffKey(key);
    if (existing) {
      existing.leftContent = opts.leftContent;
      existing.rightContent = opts.rightContent;
      if (opts.three) existing.midContent = opts.midContent;
      switchTab(existing);
      renderDiff(existing); // 内容可能已变，重渲染
      return existing;
    }
    const tab = {
      id: ++idSeq,
      path: null, // 不参与会话持久化与文件监听
      name: '🔀 ' + (opts.three ? opts.midLabel + ' ↔ ' + opts.rightLabel + '（基准 ' + opts.leftLabel + '）' : opts.leftLabel + ' ↔ ' + opts.rightLabel),
      diffKey: key,
      kind: 'diff',
      three: !!opts.three,
      leftLabel: opts.leftLabel,
      rightLabel: opts.rightLabel,
      midLabel: opts.midLabel || '',
      midContent: opts.midContent || '',
      leftContent: opts.leftContent,
      rightContent: opts.rightContent,
      exportDir: opts.exportDir || '', // 报告导出目录（app.js 传入当前工作目录）
      state: null,
      dirty: false,
      saveTimer: null,
      pinned: false,
      scrollTop: 0,
    };
    registry.add(tab);
    // 新文档进**目标栏**（缺省 = 焦点栏；Phase 3 的会话恢复会显式指定栏号 —— 图片/分段/查看器/大文件
    // 标签同样要落在 layout 指定的那一栏，否则多栏会话恢复一次就漂移一次）
    const newPane = (opts.paneIndex != null && panes[opts.paneIndex]) ? panes[opts.paneIndex] : focusedPane();
    registry.setPaneOf(tab, newPane.id);
    switchTab(tab, { pane: newPane });
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 渲染对比标签内容（交换/导出回调闭环在此）。Phase 2：渲染到**该标签所属栏**的 diff 宿主。 */
  function renderDiff(tab, paneOpt) {
    const diffHost = (paneOpt || paneOfDoc(tab)).diffHost;
    if (!diffHost) return;
    renderDiffTab(tab, diffHost, {
      onSwap: () => {
        const l = tab.leftContent, ll = tab.leftLabel;
        tab.leftContent = tab.rightContent;
        tab.leftLabel = tab.rightLabel;
        tab.rightContent = l;
        tab.rightLabel = ll;
        tab.scrollTop = 0;
        renderDiff(tab, paneOpt);
        if (isFocusedPane(paneOfDoc(tab))) updateStatusBar();
      },
      onExport: async () => {
        // 导出 Markdown 报告（有工作目录则保存并打开，无目录仅提示）
        const dir = tab.exportDir;
        const suggested = 'diff-report-' + Date.now() + '.md';
        showPrompt('导出对比报告', '文件名（保存到当前工作目录）', suggested, async (val) => {
          const report = buildDiffReport(tab);
          try {
            await window.api.writeFile((dir ? dir + '\\' : '') + val, report);
            toast('报告已导出：' + val);
            if (dir) openFile(dir + '\\' + val);
          } catch (err) {
            toast('导出失败：' + (err.message || err));
          }
        });
      },
    });
  }

  function getActiveTab() {
    return registry.active();
  }

  /** 会话快照：所有标签路径（含图片/PDF，保持顺序）+ 活动标签下标 + pinned 下标数组 + **布局**。
   *   · `paths`/`active`/`pinned` **三键一个都没删**（旧版本读得懂；既有会话用例断言的就是这三键）：
   *     paths 是**文档级去重**列表（同一文件只出现一次，即使它在两栏各有一个视图）。
   *   · `layout`（Phase 3 新增）：每栏的文档列表/活动项/pin + 比例 + 焦点栏。
   *     同一路径可以在多个 `panes[].docs` 里出现（这正是同文件多视图的意义）。
   *   · 上限口径：总视图数 ≤ 240、单栏 ≤ 200（0.3.0 §2.5），由 app.js 的恢复侧截断。 */
  function getSession() {
    // 对比标签（kind='diff'）为临时视图：不入会话（path 为 null，重启不恢复）；
    // active/pinned 下标按过滤后的列表语义计算
    const persist = docs().filter((t) => !!t.path);
    const activePersisted = persist.indexOf(registry.active());
    const paneDocs = (paneId) => registry.docsOf(paneId).filter((d) => !!d.path);
    const focusIdx = panes.findIndex((p) => p.id === registry.focusPane());
    return {
      paths: persist.map((t) => t.path),
      active: activePersisted,
      pinned: persist.map((t, i) => (t.pinned ? i : -1)).filter((i) => i >= 0),
      layout: {
        orientation: 'h',
        sizes: [+paneRatio.toFixed(4), +(1 - paneRatio).toFixed(4)],
        focus: focusIdx < 0 ? 0 : focusIdx,
        panes: panes.map((p) => {
          const ds = paneDocs(p.id);
          return {
            docs: ds.map((d) => d.path),
            active: ds.indexOf(registry.activeOf(p.id)),
            pinned: ds.map((d, i) => (d.pinned ? i : -1)).filter((i) => i >= 0),
          };
        }),
      },
    };
  }

  /** 两栏宽度比例（归一化；Phase 3 的 layout.sizes 落点）——单栏时返回 [1, 0] 之外仍给 [r, 1-r] 以保证和恒为 1 */
  function getPaneSizes() {
    return [+paneRatio.toFixed(4), +(1 - paneRatio).toFixed(4)];
  }

  /** 应用两栏宽度比例（会话恢复用）：夹取到与拖分隔条同一区间 [0.2, 0.8]，随后重排一次 */
  function setPaneSizes(sizes) {
    if (!Array.isArray(sizes) || !sizes.length) return getPaneSizes();
    const a = Number(sizes[0]);
    if (!Number.isFinite(a)) return getPaneSizes();
    paneRatio = Math.min(0.8, Math.max(0.2, a));
    layoutPanes();
    return getPaneSizes();
  }

  /** 若该路径标签已存在则激活并返回 true（会话恢复用），否则 false */
  function activateByPath(path) {
    const tab = registry.byPath(path);
    if (tab) {
      switchTab(tab);
      return true;
    }
    return false;
  }

  /** 焦点栏的 `EditorView`（Phase 2；Phase 1 语义 = 全窗口唯一那个 view）。
   *  冒烟 40 处、find.js、preview.js 都经它拿 CM —— 双栏下必须是**焦点栏**，否则查找/预览会跟错栏。 */
  function getView() {
    return focusedView();
  }

  /** 定位到指定行（从 1 开始），用于搜索结果跳转 */
  function jumpToLine(tab, line) {
    switchTab(tab);
    const pane = paneOfDoc(tab);
    const doJump = () => {
      const vw = pane.view;
      const maxLine = vw.state.doc.lines;
      const l = Math.max(1, Math.min(line || 1, maxLine));
      const pos = vw.state.doc.line(l).from;
      vw.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      // 跳转 = 用户显式动作：把焦点栏切到该标签所在栏，键盘输入跟着过去
      setFocusPane(pane.id, { notify: false });
      try { vw.focus(); } catch { /* 忽略 */ }
      if (isFocusedPane(pane)) updateStatusBar();
    };
    // P7：分段模式下行号超出已加载范围 → 先续读到该行再定位
    if (tab.kind === 'chunked' && !tab.chunk.complete && line > pane.view.state.doc.lines) {
      ensureLineLoaded(tab, line).then(doJump);
    } else {
      doJump();
    }
  }

  function findTabByPath(p) {
    return registry.byPath(p);
  }

  /** P9（v0.1.45）：按给定路径顺序重排标签数组（会话恢复并行打开完成后调用，
   *  保证标签栏顺序 = 会话顺序，pinned/active 下标语义不变）；
   *  不在 orderPaths 中的标签保持原相对顺序追加到末尾；随后重绘一次。 */
  function reorderTabs(orderPaths) {
    const indexOf = new Map(orderPaths.map((p, i) => [p, i]));
    const orig = new Map(docs().map((t, i) => [t, i]));
    // 排序在副本上做，再整体回填（注册表内部数组本身不换引用，顺序对所有读点立即生效）
    const sorted = docs().slice().sort((a, b) => {
      const ia = indexOf.has(a.path) ? indexOf.get(a.path) : orig.size + orig.get(a);
      const ib = indexOf.has(b.path) ? indexOf.get(b.path) : orig.size + orig.get(b);
      return ia - ib;
    });
    registry.replaceAll(sorted);
    renderTabs();
  }

  /** 关闭路径匹配（自身或在目录内）的所有标签。
   *  opts.save === false 用于「文件/目录已被删除或已移走」场景：dirty 标签若照常保存，
   *  会把刚删掉的文件重新写回磁盘（删除静默失效）。 */
  function closeByPath(p, isDir, opts) {
    const ns = String(p).replace(/[\\/]$/, '');
    for (const t of [...docs()]) {
      if (isDir ? t.path.startsWith(ns + '\\') || t.path.startsWith(ns + '/') : t.path === p) {
        // Phase 3：文件被删/移走时必须把**全部视图**一起关（all:true），否则另一栏会留下
        // 一个指向已删除文件的视图（既不能保存也不能重载）
        closeTab(t, Object.assign({}, opts, { all: true }));
      }
    }
  }

  // ---------- 粘贴图片 / 右键菜单 / 图片平移的视图级监听 ----------
  // Phase 2：这三组监听原本挂在「全窗口唯一 view.dom / imageHost」上，现在**每栏一份**，
  // 已在 createPane() 里按 pane 绑定（M 类冲突点：发起粘贴的那个视图所属文档才是落点）。
  function dirOf(p) {
    return String(p).replace(/[\\/][^\\/]*$/, '');
  }

  let imgSeq = 0; // 粘贴图片序号：防止同毫秒文件名冲突

  async function pasteImages(items, pane) {
    const p = pane || focusedPane();
    const tab = registry.activeOf(p.id);
    if (!tab) return;
    if (tab.lang !== 'markdown') {
      const { toast } = await import('./ui.js');
      toast('仅在 Markdown 文件中支持粘贴图片');
      return;
    }
    const dir = dirOf(tab.path);
    // L7（v0.1.44）：剪贴板 MIME → 扩展名白名单归一化（image/svg+xml → svg；image/jpeg → jpg；
    // 未知 MIME 回退 png，由主进程 write-binary 扩展名校验兜底）
    const IMAGE_EXT_MAP = {
      png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp',
      bmp: 'bmp', 'svg+xml': 'svg', svg: 'svg', ico: 'ico',
    };
    for (const item of items) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const buf = await file.arrayBuffer();
        const mime = (file.type || '').split(';')[0].trim().toLowerCase();
        const sub = (mime.split('/')[1] || '').toLowerCase();
        const ext = IMAGE_EXT_MAP[sub] || 'png';
        const name = `image-${Date.now()}-${++imgSeq}.${ext}`;
        const fullPath = (dir ? dir + '\\' : '') + name;
        await window.api.writeBinary(fullPath, buf);
        insertAtCursor(`![${name}](./${name})`, p);
        const { toast } = await import('./ui.js');
        toast(`图片已插入：${name}`);
      } catch (err) {
        const { toast } = await import('./ui.js');
        toast('图片保存失败：' + (err.message || err));
      }
    }
  }

  /** 在指定栏（缺省焦点栏）的视图光标处插入文本 */
  function insertAtCursor(text, pane) {
    const p = pane || focusedPane();
    const vw = p.view;
    if (vw.state.readOnly) {
      toast('只读内容不可编辑（大文件查看器请先启用区域编辑）');
      return;
    }
    const pos = vw.state.selection.main.head;
    vw.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    vw.focus();
  }

  // ---------- 图片标签页：左键拖拽平移查看（放大后） ----------
  // 每栏的 mousedown 在 createPane 里绑定；mousemove/mouseup 是窗口级的，只绑一次。
  let imgDrag = null;
  document.addEventListener('mousemove', (e) => {
    if (!imgDrag) return;
    const ih = (imgDrag.pane && imgDrag.pane.imageHost) || null;
    if (!ih) return;
    ih.scrollLeft = imgDrag.sl - (e.clientX - imgDrag.x);
    ih.scrollTop = imgDrag.st - (e.clientY - imgDrag.y);
  });
  document.addEventListener('mouseup', () => {
    if (!imgDrag) return;
    const ih = (imgDrag.pane && imgDrag.pane.imageHost) || null;
    if (ih) ih.classList.remove('dragging');
    imgDrag = null;
  });

  // ---------- 外部修改检测：自动重载（有未保存修改时询问） ----------
  window.api.onFileChanged(async (d) => {
    const changedPath = d && d.path;
    // 普通文本标签（kind 未定义）+ 分段标签（chunked）+ 大文件查看器（viewer-lg）+
    // 虚拟滚动查看器（huge）参与外部修改同步；图片标签不参与。
    // Phase 3：从 `find` 改成 `filter` —— **同一路径恒只有一个 Document**（openFile/openImageTab
    // 都按 path 去重），"多视图"是多**个视图**共享这一个文档，因此重载要落到 `registry.viewsOf(tab)`
    // 的全部视图上（见 reloadFromDisk），而不是只看"活动的那一个视图"。
    const targets = docs().filter((t) => t.path === changedPath && (!t.kind || t.kind === 'chunked' || t.kind === 'viewer-lg' || t.kind === 'huge'));
    const tab = targets[0];
    if (!tab) return;
    // 自写回声双保险：刚保存后短时间内的变更通知视为自身写入的延迟回声，静默忽略
    // （主进程 markSelfWrite 宽限窗口已吸收绝大多数；此处兜底高频编辑下的残余竞态，
    //  避免打字中弹出「已在外部被修改」确认框打断输入）
    if (tab.lastSavedAt && Date.now() - tab.lastSavedAt < 1200) return;
    // huge（v0.4.0 Phase D）：外部修改 → 丢弃本地编辑会话 + 行索引缓存后重载（语义同 viewer-lg：
    // 有未保存编辑先确认；确认后丢弃本地更改，绝不写盘）
    if (tab.kind === 'huge') {
      // 自写回声守卫（比上面的 1200ms 更宽）：大文件保存是「临时文件 → rename」，主进程在 rename
      // **之后**才 markSelfWrite，事件可能先到；不挡住的话每次保存都会触发一次「外部修改重载」
      // （丢掉刚保存的编辑会话，有未保存改动时还会弹确认框）。savedAt 由 hugeview 在保存起点打点。
      const hvSt = tab.huge && tab.huge.getState ? tab.huge.getState() : null;
      if (hvSt && hvSt.savedAt && Date.now() - hvSt.savedAt < 3000) return;
      if (tab.huge && tab.huge.isDirty()) {
        const { confirmDialog } = await import('./ui.js');
        const ok = await confirmDialog(
          `「${tab.name}」已在外部被修改，且当前有未保存的大文件编辑。\n确定要重新加载（丢弃本地更改）吗？`,
          '文件已在外部更改'
        );
        if (!ok) return;
      }
      if (!tab.huge) return; // 标签未挂载（非活动标签没有视图实例）→ 切回时按新文件重建
      try {
        await tab.huge.reloadExternal();
        const { toast } = await import('./ui.js');
        toast(`已从外部重新加载 ${tab.name}`);
      } catch (err) {
        console.warn('[huge] 外部修改重载失败:', changedPath, err && err.message ? err.message : err);
      }
      return;
    }
    // viewer-lg（v0.2.1）：外部修改 → 刷新文件大小并重读当前窗口（区域编辑中且有修改先确认）
    if (tab.kind === 'viewer-lg') {
      if (tab.editing && tab.dirty) {
        const { confirmDialog } = await import('./ui.js');
        const ok = await confirmDialog(
          `「${tab.name}」已在外部被修改，且当前有未保存的区域编辑。\n确定要重新加载窗口（丢弃本地更改）吗？`,
          '文件已在外部更改'
        );
        if (!ok) return;
      }
      try {
        const st = await window.api.stat(tab.path);
        tab.vwin.size = st.size;
        const off = Math.max(0, Math.min(tab.vwin.offset, Math.max(0, st.size - VIEWER_WINDOW)));
        await loadViewerWindow(tab, off);
        updateViewerBar(tab);
        updateStatusBar();
        const { toast } = await import('./ui.js');
        toast(`已从外部重新加载 ${tab.name}（当前窗口）`);
      } catch (err) {
        console.warn('[viewer-lg] 外部修改重载失败:', changedPath, err && err.message ? err.message : err);
      }
      return;
    }
    // 只读标签（跨窗口共享文件的观察窗）静默同步：不弹确认/toast + 节流（800ms trailing），
    // 编辑窗口连续自动保存时不闪不抖
    if (tab.readOnly && !tab.dirty) {
      const now = Date.now();
      if (now - (tab.lastSyncAt || 0) < 800) {
        clearTimeout(tab.syncTimer);
        tab.syncTimer = setTimeout(() => reloadFromDisk(tab, true), 800);
        return;
      }
      tab.lastSyncAt = now;
      await reloadFromDisk(tab, true);
      return;
    }
    if (tab.dirty) {
      // ---- 0.5.0 Phase 4 L3（默认关）：跨窗口双编辑的冲突提示 ----
      // 判据 = 主进程给的 multiEdit（该路径上"可编辑窗口数 > 1"）—— 只有 L3 开关打开时才可能出现，
      // 因此这里天然是"多窗口同时可编辑"的场景。开关**真实门控**提示：
      //   开 → DOM 冲突横幅（保留本窗口 / 载入对方；**不用原生对话框**：showMessageBox 会阻塞窗口）；
      //   关 → 不提示、不改动本地内容（静默保留本窗口，绝不悄悄丢用户的未保存修改）。
      if (d && d.multiEdit) {
        conflictPromptOn = (await window.api.getConflictPrompt().catch(() => false)) === true;
        if (conflictPromptOn) {
          showConflictBanner(tab, paneOfDoc(tab));
        } else {
          hideConflictBanner(paneOfDoc(tab));
        }
        return;
      }
      // 有未保存的本地修改：询问是否丢弃并重新加载
      const { confirmDialog } = await import('./ui.js');
      const ok = await confirmDialog(
        `「${tab.name}」已在外部被修改，且当前有未保存的更改。\n确定要重新加载文件（丢弃本地更改）吗？`,
        '文件已在外部更改'
      );
      if (!ok) return;
    }
    await reloadFromDisk(tab, false);
  });

  // ---------- Phase 4：主进程锁表事件的落地 ----------
  // ① 同文件被另一窗口打开（file-shared-open，D2 既有通道）→ 记锁态、显示只读横幅 + 接管按钮。
  //    **只读转换与 toast 仍由 app.js 的同名订阅负责**（那条通道的语义一个字没改，
  //    scripts/smoke.js:3936 的 mwSharedReadOnly 断言的就是它）。
  window.api.onFileSharedOpen(({ path: sharedPath }) => {
    if (!sharedPath) return;
    lockStates.set(sharedPath, { mode: 'read', owner: null, sharedEdit: false, freed: false });
    updateAllLockBanners();
  });
  // ② 编辑权变更（接管/被降级/编辑权空闲）→ 本窗口据此转只读或恢复可编辑
  window.api.onFileLockChanged((d) => { onLockChanged(d); });

  /** 从磁盘重载标签内容（外部修改同步 / 跨窗口只读同步共用）。
   *  silent=true（只读观察窗）：不弹 toast —— 编辑窗口连续自动保存时观察窗静默跟随、不闪不抖。
   *  Phase 3（C9 的收口）：**广播到该文档的全部视图** —— 正看着的那个视图用 dispatch 整文替换
   *  （保持 state 连续性 + 光标/滚动位置），其余视图用带远端注解的 dispatch 同步换文
   *  （既不进历史、也不回播）；一个视图都没有时退回重建 `tab.state`。 */
  async function reloadFromDisk(tab, silent) {
    // P7：分段标签走分段重载（重置解码器重读首段 + 续读），避免全量 readFile 触碰大文件上限
    if (tab.kind === 'chunked') {
      try {
        await reloadChunked(tab);
      } catch (err) {
        console.warn('[chunked] 外部修改重载失败:', tab.path, err && err.message ? err.message : err);
        return;
      }
      registry.markDirty(tab, false);
      for (const p of panesOfDoc(tab)) {
        if (registry.activeOf(p.id) === tab) { try { onTabSwitch(tab, isFocusedPane(p)); } catch { /* 忽略 */ } }
      }
      renderTabs();
      if (!silent) {
        const { toast } = await import('./ui.js');
        toast(`已从外部重新加载 ${tab.name}`);
      }
      return;
    }
    let data;
    try {
      data = await window.api.readFile(tab.path);
    } catch {
      return; // 文件不可读，忽略
    }
    // 承载该文档的全部视图；主视图（焦点栏优先）保留光标与滚动位置，其余视图整文替换
    const views = registry.viewsOf(tab);
    const main = primaryViewOf(tab) || (views.length ? views[0] : null);
    const selPos = main ? main.state.selection.main.head : null;
    const scrollTop = main ? main.scrollDOM.scrollTop : null;
    if (main) {
      // 用 dispatch 替换整个文档（保留 state 连续性与滚动位置），而非重建 state
      const anchor = Math.min(selPos, data.content.length);
      main.dispatch({
        changes: { from: 0, to: main.state.doc.length, insert: data.content },
        selection: { anchor },
        // 外部修改重载不是用户编辑：不进撤销历史（撤销会把外部修改覆盖回去）+ 远端注解（不回播）
        annotations: [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
      });
      for (const v of views) {
        if (v === main || v.isDestroyed) continue;
        try {
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: data.content },
            annotations: [remoteAnnotation.of(true), Transaction.addToHistory.of(false)],
          });
        } catch { /* 视图已销毁 */ }
      }
      tab.state = main.state;
      // 多帧校正滚动位置（CM 的异步测量可能覆盖 scrollTop）
      if (scrollTop !== null) {
        const restoreScroll = (n) => {
          if (n <= 0) return;
          main.scrollDOM.scrollTop = scrollTop;
          requestAnimationFrame(() => restoreScroll(n - 1));
        };
        restoreScroll(3);
      }
    } else {
      tab.state = makeState(data.content, tab.lang);
    }
    tab.crlf = /\r\n/.test(data.content); // 记住原行尾风格（保存时还原，见 applyEol）
    registry.markDirty(tab, false);
    // 每个正在显示它的栏都刷新一次预览/图层（焦点栏传 focused=true）
    for (const p of panesOfDoc(tab)) {
      if (registry.activeOf(p.id) !== tab) continue;
      try { onTabSwitch(tab, isFocusedPane(p)); } catch { /* 忽略 */ }
    }
    renderTabs();
    if (!silent) {
      const { toast } = await import('./ui.js');
      toast(`已从外部重新加载 ${tab.name}`);
    }
  }

  return { openFile, openDiffTab, closeTab, closeAll, saveNow, setWordWrap, setIndentSize, getActiveTab, getView, renderTabs, jumpToLine, findTabByPath, closeByPath, cycleTab, getSession, activateByPath, togglePinned, setPinned, closeOthers, closeLeft, closeRight, reorderTabs, scrollToTop, scrollToBottom, viewerJump, setViewerEditing, revealViewerAt, slideViewerWindow: slideViewer, setTabReadOnly, toggleReadOnly, ensureFullyLoaded,
    // ---------- 0.5.0 Phase 2：分栏 API（app.js 的 Ctrl+\ / Ctrl+1/2 与冒烟 split* 用例使用） ----------
    /** 分屏/合屏开关：单栏 → 右侧开一个空栏并聚焦；两栏 → 合并回单栏。返回合栏后的栏数 */
    toggleSplit: () => { toggleSplit(); return panes.length; },
    /** 在当前栏右侧/左侧开第二个空栏并聚焦（已有两栏时返回 false） */
    openSecondPane,
    /** 合并回单栏（已有单栏时返回 false） */
    mergePanes,
    /** 聚焦第 i 栏（0 基，屏幕从左到右）：Ctrl+1 = 0、Ctrl+2 = 1。返回是否成功 */
    focusPaneIndex: (i) => focusPaneByIndex(i),
    /** 焦点栏 id（'p0' / 'p1'） */
    getFocusPaneId: () => registry.focusPane(),
    /** 布局只读快照（测试面：栏数 / 焦点栏 / 比例 / 每栏活动文件与宽度，全部来自真实 DOM 几何） */
    getPaneLayout: paneLayoutInfo,
    /** 栏数（1 或 2） */
    getPaneCount: () => panes.length,
    /** 按栏 id（'p0' / 'p1'）取该栏的 DOM/视图引用集合；不存在返回 null */
    getPaneElsById: (paneId) => {
      const p = paneById(paneId);
      if (!p) return null;
      return {
        id: p.id,
        root: p.root,
        tabsEl: p.tabsEl,
        body: p.body,
        editorHost: p.host,
        imageHost: p.imageHost,
        diffHost: p.diffHost,
        viewerBar: p.viewerBar,
        divider: p.divider,
        previewHost: p.previewHost,
        previewContent: p.previewContent,
        zoomBadge: p.zoomBadge,
        view: p.view,
      };
    },
    /** 某栏当前的活动文档（app.js 给每栏建 preview 实例时用作 getTab） */
    paneActiveOf: (paneId) => registry.activeOf(paneId),
    /** 第 i 栏（0 基，屏幕从左到右）的 DOM/视图引用集合；越界返回 null。
     *  用途：app.js 给每一栏建一个 preview 实例（栏内预览模式按栏独立）、冒烟断言两栏各自的标签栏与 CM。 */
    getPaneEls: (i) => {
      const p = panes[i];
      if (!p) return null;
      return {
        id: p.id,
        root: p.root,
        tabsEl: p.tabsEl,
        body: p.body,
        editorHost: p.host,
        imageHost: p.imageHost,
        diffHost: p.diffHost,
        viewerBar: p.viewerBar,
        divider: p.divider,
        previewHost: p.previewHost,
        previewContent: p.previewContent,
        zoomBadge: p.zoomBadge,
        view: p.view,
      };
    },
    /** 文档 → 栏 id（测试面：断言某标签落在哪一栏） */
    paneIdOf: (tab) => registry.paneOf(tab),
    // ---------- 0.5.0 Phase 4：跨窗口「接管编辑」 ----------
    /** 接管编辑（等价于点只读横幅上的「✏️ 接管编辑」）：成功 → 本窗口可编辑、原窗口转只读 + toast */
    claimEdit: (tab) => claimEdit(tab),
    /** 交回编辑权：其余窗口收到「编辑权已空闲」（不自动变可编辑）。关标签时自动调用 */
    releaseEdit: (tab) => releaseEdit(tab),
    /** 渲染端锁态镜像（测试面）：{ mode, owner, sharedEdit, freed } | null（null = 本窗口是首个打开者） */
    lockStateOf: (path) => lockStateOfPath(path),
    /** L3 冲突提示开关（真值在主进程 filewatch.js；**默认关**）。返回当前生效值 */
    setConflictPrompt: async (on) => {
      conflictPromptOn = (await window.api.setConflictPrompt(!!on)) === true;
      return conflictPromptOn;
    },
    getConflictPrompt: () => conflictPromptOn,
    // ---------- 0.5.0 Phase 3：同文件多视图 + 布局（app.js 的会话恢复与冒烟 sameFile*/layout* 用例使用） ----------
    /** 在指定栏（栏号 0/1 或栏 id 'p0'/'p1'）为**已有文档**挂一个视图（复用同一 Document，
     *  读盘只发生一次）。huge/viewer-lg/image/diff 会被拒绝并提示。返回是否挂成功。 */
    attachViewToPane: (doc, paneRef) => attachViewToPane(doc, paneRef),
    /** 在另一栏打开该标签的同文件第二视图（右键菜单入口；栏不存在时先开栏）。返回是否成功 */
    openInOtherPane: (tab) => openInOtherPane(tab),
    /** 承载该文档的全部栏 id（测试面：断言"同一文件确实在两栏各有一个视图"） */
    panesOfDoc: (tab) => registry.panesOf(tab),
    /** 该文档当前的视图数（测试面：0/1/2；关闭语义的判据同源） */
    viewCountOf: (tab) => registry.viewCount(tab),
    /** 两栏宽度比例 [a, 1-a]（会话 layout.sizes 的来源） */
    getPaneSizes: () => getPaneSizes(),
    /** 应用两栏宽度比例（会话恢复用；夹取到 [0.2, 0.8] 后立即重排） */
    setPaneSizes: (sizes) => setPaneSizes(sizes),
    /** 测试面（dev 独有，只被 window.__app 暴露）：临时改「虚拟滚动查看器」大小阈值。
     *  冒烟夹具里唯一 >1GB 的文件是 3.9GB 稀疏 NUL（二进制、不可编辑），而 huge 编辑链路需要
     *  真实文本大文件 → 只允许用例内部临时降阈值，**用完必须恢复**（传 null/undefined 或
     *  HUGE_SCROLL_THRESHOLD 即回默认 1024MB）。返回值恒为当前生效的 MB 值。 */
    setHugeThresholdMB(mb) {
      const n = Number(mb);
      hugeScrollThreshold = Number.isFinite(n) && n > 0 ? Math.floor(n) * 1024 * 1024 : HUGE_SCROLL_THRESHOLD;
      return Math.round(hugeScrollThreshold / 1024 / 1024);
    },
    getHugeThresholdMB: () => Math.round(hugeScrollThreshold / 1024 / 1024),
    // ---------- 0.5.0 Phase 5a A3：标签栏溢出（测试面） ----------
    /** 某栏标签栏的溢出快照：判据是**该栏自己的** scrollWidth/clientWidth（多栏后必须按 pane 算） */
    tabsOverflowOf: (paneRef) => {
      const p = paneById(paneRef) || panes[paneRef] || focusedPane();
      if (!p) return null;
      return {
        paneId: p.id,
        overflow: tabsOverflowing(p),
        scrollWidth: p.tabsEl.scrollWidth,
        clientWidth: p.tabsEl.clientWidth,
        scrollLeft: Math.round(p.tabsEl.scrollLeft),
        tabCount: registry.docsOf(p.id).length,
        btnVisible: !!(p.moreBtn && p.moreBtn.offsetParent !== null && p.root.classList.contains('has-tab-overflow')),
        menuOpen: !!(p.tabsMenu && !p.tabsMenu.classList.contains('hidden')),
        menuItems: p.tabsMenu ? p.tabsMenu.querySelectorAll('.tabs-menu-item').length : 0,
        menuNames: p.tabsMenu ? Array.from(p.tabsMenu.querySelectorAll('.tabs-menu-item .tm-name')).map((n) => n.textContent) : [],
        menuCurrent: (() => {
          const c = p.tabsMenu ? p.tabsMenu.querySelector('.tabs-menu-item.current .tm-name') : null;
          return c ? c.textContent : null;
        })(),
      };
    },
    /** 打开/关闭某栏的「▾ 全部标签」下拉（返回菜单项数；用例也可直接点 DOM 按钮） */
    toggleTabsMenuFor: (paneRef) => {
      const p = paneById(paneRef) || panes[paneRef] || focusedPane();
      if (!p) return -1;
      if (p.tabsMenu.classList.contains('hidden')) { openTabsMenu(p); return p.tabsMenu.querySelectorAll('.tabs-menu-item').length; }
      closeTabsMenu(p);
      return 0;
    },
    /** Ctrl+Tab 浮层快照（测试面） */
    tabsHudOf: () => ({
      exists: !!tabHudEl,
      visible: !!(tabHudEl && !tabHudEl.classList.contains('hidden')),
      items: tabHudEl ? Array.from(tabHudEl.querySelectorAll('.tab-hud-item')).map((n) => n.textContent) : [],
      current: (() => {
        const c = tabHudEl ? tabHudEl.querySelector('.tab-hud-item.current') : null;
        return c ? c.textContent : null;
      })(),
    }),
    hideTabsHud: () => hideTabHud(),
    /** 横滚（滚轮路径的纯函数替身：用例可断言 scrollLeft 真的动了，不依赖合成 wheel 的默认行为） */
    scrollTabsBy: (paneRef, dx) => {
      const p = paneById(paneRef) || panes[paneRef] || focusedPane();
      if (!p) return -1;
      p.tabsEl.scrollLeft += Number(dx) || 0;
      return Math.round(p.tabsEl.scrollLeft);
    },
    // ---------- 0.5.0 Phase 5a 第 2 批 A2：重开刚关闭的标签（测试面） ----------
    /** 重开最近关闭的标签（= Ctrl+Shift+T 的动作体）：返回重开后的文档（栈空/失败为 null） */
    reopenClosedTab: () => reopenClosedTab(),
    /** 最近关闭栈的快照（测试面：纯数据，可结构化克隆；新→旧） */
    closedTabs: () => closedStack.map((e) => ({
      path: e.path, name: e.name, paneId: e.paneId, kind: e.kind, pinned: e.pinned,
      readOnly: e.readOnly, dirtyAtClose: e.dirtyAtClose,
      // **刻意保留三态**（null = 关闭时那次保存的 promise 尚未 settle）：既有冒烟用例靠
      // `p6Wait(top.savedOnClose !== null)` 判断"保存已落定"（smoke.js:7386-7387 有注释），
      // 归一化会让该轮询立即返回，使 unsaved-save-failed / huge-close-does-not-write-disk
      // 两条合取项在保存仍进行时就被求值（断言会变弱）。产品可见的 `reopenInfo.savedOnClose`
      // 已在 :2313 归一为布尔；这里是 dev 测试面快照，保留 null 才能继续充当"落定信号"。
      savedOnClose: e.savedOnClose === true ? true : (e.savedOnClose === false ? false : null),
      savePending: e.savePending === true,
      hasText: typeof e.text === 'string',
      textLength: typeof e.text === 'string' ? e.text.length : 0,
      textOmitted: e.textOmitted === true,
      cursor: e.cursor, scrollTop: e.scrollTop, hugeTopLine: e.hugeTopLine,
    })),
    closedStackSize: () => closedStack.length,
    clearClosedStack: () => { closedStack.length = 0; return 0; },
    // ---------- 0.5.0 Phase 5a B8：字号/行高变更后重新测量 ----------
    /** 编辑器字号由根元素 CSS 变量驱动（所有栏一起变），但 CM 的字符宽度缓存与滚动高度
     *  是按旧字号算出来的 —— 改字号后必须让**每个** EditorView 重新测量，否则光标坐标映射
     *  与滚动位置会滞后一档（多视图下尤其明显：隐藏栏恢复显示时才会自愈）。 */
    refreshMeasure: () => {
      for (const p of panes) {
        try { p.view.requestMeasure(); } catch { /* 视图已销毁 */ }
      }
      return panes.length;
    } };
}
