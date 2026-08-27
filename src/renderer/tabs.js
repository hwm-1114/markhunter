// 多标签 + CodeMirror 编辑器核心
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Compartment, StateEffect, StateField, Prec } from '@codemirror/state';
import { Decoration, keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { langFor, baseName, escapeHtml, showContextMenu, hideContextMenu, formatSize, stripChunkMarkers, CHUNK_MARKER_RE, showPrompt, toast } from './ui.js';
import { pathToFileUrl } from './viewer.js';
import { renderDiffTab, buildDiffReport } from './diffview.js';

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
const VIEWER_THRESHOLD = 256 * 1024 * 1024;   // >256MB → 查看器
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
  const host = document.getElementById('editor-host');
  const tabsEl = document.getElementById('tabs');
  const { onDocChanged, onTabSwitch, onTabLeave, onRequestClose, getWordWrap, onSaveStatus, onSessionChange, getIndentSize } = callbacks;

  const tabs = []; // { id, path, name, lang, state, dirty, saveTimer, savedContent, scrollTop }
  let activeTab = null;
  let idSeq = 0;
  let wordWrapOn = getWordWrap();

  // ---------- 缩进设置（Tab 键插入的空格数，1~8） ----------
  function clampIndent(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return 4;
    return Math.min(8, Math.max(1, v));
  }

  let indentSize = clampIndent(getIndentSize ? getIndentSize() : 4);
  let composing = false; // 输入法组合期间 Tab 不触发缩进

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
    if (composing) return false;
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
    if (composing) return false;
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
          if (u.docChanged && activeTab) {
            try {
              activeTab.state = u.state;
              activeTab.dirty = true;
              updateTabBadges(); // O1：只更新圆点/激活态，不重建标签栏
              updateStatusBar();
              onDocChanged(activeTab);
            } catch (err) {
              console.error('[doc-change]', err && err.stack ? err.stack : err);
              throw err;
            }
          }
          if (u.selectionSet && activeTab && !activeTab.kind) updateStatusBar();
        }),
      ],
    });
  }

  const view = new EditorView({
    parent: host,
    state: makeState('', 'text'),
  });

  // 输入法组合开始/结束：期间 Tab 不触发缩进插入
  view.dom.addEventListener('compositionstart', () => { composing = true; });
  view.dom.addEventListener('compositionend', () => { composing = false; });

  // 等宽字体加载完成后强制重新测量：防止字体未就绪导致字符宽度缓存错误
  // （会造成同一行内鼠标选择的坐标映射异常，而跨行选择不受影响）
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      view.requestMeasure();
    });
  }

  // P7：分段模式预读 —— 活动标签滚动接近底部时自动加载下一段（dispatch 追加，保持光标/滚动）；
  // viewer-lg：滚动到窗口边缘自动翻页
  view.scrollDOM.addEventListener(
    'scroll',
    () => {
      if (!activeTab) return;
      if (activeTab.kind === 'chunked') maybeAutoLoad(activeTab);
      else if (activeTab.kind === 'viewer-lg') maybeSlideViewer(activeTab);
    },
    { passive: true }
  );

  const imageHost = document.getElementById('image-host');
  const diffHost = document.getElementById('diff-host'); // v0.2.0 对比标签内容区
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'pdf'];

  // ---------- 打开 / 切换 / 关闭 ----------
  /** 打开文件。opts.silent=true 时（会话恢复等批量路径）失败不弹 alertBox，仅 console.warn（L6）。 */
  async function openFile(path, opts = {}) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      switchTab(existing);
      return existing;
    }
    // 图片文件：以图片标签页打开（在编辑区查看，非详情弹窗）
    const ext = (String(path).split('.').pop() || '').toLowerCase();
    if (IMAGE_EXTS.includes(ext)) {
      return openImageTab(path);
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
    };
    tab.state = makeState(data.content, tab.lang);
    tabs.push(tab);
    switchTab(tab);
    window.api.watchFile(path, data.mtime); // 监听外部修改
    if (onSessionChange) onSessionChange();
    return tab;
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
    tabs.push(tab);
    switchTab(tab);
    tab.dirty = false; // 加载窗口不是用户编辑
    clearTimeout(tab.saveTimer);
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 加载指定字节偏移的窗口内容到 tab（活动标签直接替换 view 文档，非活动标签重建 state）。
   *  各窗口独立解码：窗口边界可能截断多字节字符（显示为替换符），查看语义可接受。 */
  async function loadViewerWindow(tab, offset) {
    const c = tab.vwin;
    if (c.inflight) return;
    c.inflight = true;
    try {
      const len = Math.min(VIEWER_WINDOW, c.size - offset);
      const r = await window.api.readFileRange(tab.path, offset, len);
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
      let text;
      try {
        text = new TextDecoder(c.encoding).decode(r.bytes);
      } catch {
        c.encoding = 'latin1';
        text = new TextDecoder('latin1').decode(r.bytes);
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
      c.byteLen = r.end - r.start;
      const isActive = activeTab === tab;
      if (isActive) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
        tab.state = view.state;
      } else {
        tab.state = makeState(text, tab.lang, true, false); // viewer：只读 + 强制不换行
      }
      tab.dirty = false;
      clearTimeout(tab.saveTimer);
      if (isActive) {
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
    const el = view.scrollDOM;
    const to = dir > 0 ? 24 : Math.max(0, el.scrollHeight - el.clientHeight - 24);
    const set = (n) => {
      if (activeTab !== tab) return;
      el.scrollTop = to;
      if (n > 0) requestAnimationFrame(() => set(n - 1));
    };
    set(3);
  }

  /** 活动查看器标签的滚动边缘检测（编辑态禁止翻页，窗口即编辑边界） */
  function maybeSlideViewer(tab) {
    if (!tab || tab.kind !== 'viewer-lg' || tab.editing || tab.vwin.inflight) return;
    if (activeTab !== tab) return;
    const el = view.scrollDOM;
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
      if (activeTab === tab) {
        view.scrollDOM.scrollTop = 0;
        if (n > 0) requestAnimationFrame(() => set(n - 1));
      }
    };
    set(3);
    return true;
  }

  /** 区域编辑开关：开启后当前窗口可编辑（≤40MB）；关闭时若有未保存修改先保存 */
  async function setViewerEditing(tab, on) {
    if (!tab || tab.kind !== 'viewer-lg' || activeTab !== tab) return false;
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
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(false)) });
      tab.editing = true;
      toast('区域编辑已启用：编辑当前窗口内容，保存（Ctrl+S）将写回文件原位置');
    } else {
      if (tab.dirty) {
        const ok = await saveNow(tab);
        if (!ok) return false; // 保存失败留在编辑态
      }
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(true)) });
      tab.editing = false;
    }
    updateViewerBar(tab);
    return true;
  }

  /** 查看器区域保存：当前窗口内容替换文件 [offset, offset+byteLen) 字节（流式拼接写回） */
  async function saveViewerRegion(t) {
    if (!t.dirty) return true;
    if (!t.editing) return true;
    const content = t.state.doc.toString();
    try {
      const r = await window.api.spliceFile(t.path, t.vwin.offset, t.vwin.byteLen, content);
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
    const bar = document.getElementById('viewer-bar');
    const pos = document.getElementById('viewer-pos');
    const btnEdit = document.getElementById('btn-viewer-edit');
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
    tab.state = makeState(text0 + chunkMarker(tab), tab.lang);
    tabs.push(tab);
    switchTab(tab);
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
    const isActive = activeTab === tab;
    const state = isActive ? view.state : tab.state;
    const docStr = state.doc.toString();
    const changes = [];
    const re = new RegExp(CHUNK_MARKER_RE.source, 'g');
    let m;
    while ((m = re.exec(docStr))) changes.push({ from: m.index, to: m.index + m[0].length, insert: '' });
    changes.push({ from: docStr.length, to: docStr.length, insert: text + (marker || '') });
    if (isActive) {
      view.dispatch({ changes });
      tab.state = view.state;
    } else {
      // 非活动标签：EditorState.update（selection 自动经 changes 映射，光标语义保持）
      tab.state = state.update({ changes });
    }
    // 分段追加不是用户编辑：不触发自动保存 / 脏标记（updateListener 已标脏，这里复位）
    tab.dirty = false;
    clearTimeout(tab.saveTimer);
    if (isActive) {
      const ss = document.getElementById('save-status');
      if (ss && !tab.dirty) ss.textContent = '';
    }
    if (onSessionChange) onSessionChange();
  }

  /** 活动标签滚动接近底部时触发预读（scroll 监听 + 加载完成后链式调用） */
  function maybeAutoLoad(tab) {
    if (!tab || tab.kind !== 'chunked' || !tab.chunk || tab.chunk.complete || tab.chunk.inflight) return;
    if (activeTab !== tab) return; // 仅活动标签按滚动预读
    const el = view.scrollDOM;
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
    while (!tab.chunk.complete && view.state.doc.lines < line && guard < CHUNK_MAX_BLOCKS) {
      await loadNextChunk(tab);
      guard++;
    }
  }

  /** 外部修改后重载分段标签：重置解码器并重读首段（保留 kind/chunk 结构） */
  async function reloadChunked(tab) {
    const c0 = await window.api.readFileRange(tab.path, 0, CHUNK_SIZE);
    tab.chunk = { size: c0.size, loaded: c0.end, complete: c0.end >= c0.size, inflight: false, decoder: null, encoding: null };
    const text0 = decodeFirstChunk(c0.bytes, tab);
    const insert = text0 + chunkMarker(tab);
    if (activeTab === tab) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
      tab.state = view.state;
    } else {
      tab.state = tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert } });
    }
    tab.dirty = false;
    clearTimeout(tab.saveTimer);
    if (!tab.chunk.complete) loadNextChunk(tab); // 续读后续段
  }

  /** 以图片标签页打开图片文件 */
  function openImageTab(path) {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      switchTab(existing);
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
    tabs.push(tab);
    switchTab(tab);
    if (onSessionChange) onSessionChange();
    return tab;
  }

  function switchTab(tab) {
    // 记住离开标签的滚动位置（编辑器 / 图片视图 / 对比视图），切回时恢复；
    // onTabLeave 供上层同步保存预览区滚动等视图级状态
    if (activeTab && activeTab !== tab) {
      const leaving = activeTab;
      if (leaving.kind === 'image') {
        leaving.scrollTop = imageHost.scrollTop;
      } else if (leaving.kind === 'diff') {
        const sc = diffHost.querySelector('.diff-scroller');
        leaving.scrollTop = sc ? sc.scrollTop : 0;
      } else {
        leaving.scrollTop = view.scrollDOM.scrollTop;
      }
      if (onTabLeave) onTabLeave(leaving);
    }
    activeTab = tab;
    if (tab.kind === 'image') {
      // 图片标签：编辑区显示图片视图
      view.setState(makeState('', 'text'));
      renderImageTab(tab);
    } else if (tab.kind === 'diff') {
      // 对比标签：编辑器让位，渲染双栏 diff（applyMode 负责显隐）
      view.setState(makeState('', 'text'));
      renderDiff(tab);
    } else {
      view.setState(tab.state);
      // 对齐换行设置（viewer-lg 例外：强制不换行——超长单行 wrap 测量复杂度失控）
      wordWrapOn = getWordWrap();
      const wrapOn = tab.kind === 'viewer-lg' ? false : wordWrapOn;
      view.dispatch({ effects: wrapCompartment.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
      // 对齐缩进设置（设置变更后，已开标签切换时也按当前 indentSize 生效）
      view.dispatch({ effects: indentCompartment.reconfigure(indentExtensions(indentSize)) });
      // 对齐只读态（跨窗口共享文件自动只读 / 用户手动切换）
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!tab.readOnly)) });
      tab.state = view.state;
    }
    // 恢复进入标签的滚动位置：setState 重建视口后位置丢失，CM 高度测量异步 → 多帧校正；
    // 若期间位置被其它力量移动（用户滚动/测量修正超出容差）则停止校正，不与用户抢滚动条。
    // 新标签 / 无记录 → 顶部。
    restoreTabScroll(tab);
    renderTabs(); // 切换可能伴随新增标签（openFile→switchTab）：结构渲染（低频路径；高频 docChanged 才走 updateTabBadges）
    if (tab.kind === 'viewer-lg') updateViewerBar(tab);
    updateStatusBar();
    onTabSwitch(tab);
    if (onSessionChange) onSessionChange();
  }

  /** 多帧恢复 tab 滚动位置（编辑器或图片视图；diff 由 renderDiff 内部恢复）。
   *  setState 重建视口后 CM 的高度测量会异步修正 scrollTop，单次赋值会被"弹回"，
   *  需连续多帧压回目标值（~100ms，测量完成后即稳定）；期间切换标签则放弃。
   *  无记录 → 顶部。 */
  function restoreTabScroll(tab) {
    if (tab.kind === 'diff') return; // renderDiff 已恢复
    const el = tab.kind === 'image' ? imageHost : view.scrollDOM;
    const target = typeof tab.scrollTop === 'number' ? tab.scrollTop : 0;
    const step = (n) => {
      if (activeTab !== tab || !el) return;
      el.scrollTop = target;
      if (n <= 0) return;
      requestAnimationFrame(() => step(n - 1));
    };
    step(6);
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab 循环切换标签 */
  function cycleTab(dir) {
    if (tabs.length < 2) return;
    const i = tabs.indexOf(activeTab);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    switchTab(next);
  }

  /** 状态栏：文件名 / 行:列 / 字数 */
  function updateStatusBar() {
    const sbFile = document.getElementById('sb-file');
    const sbPos = document.getElementById('sb-pos');
    const sbLen = document.getElementById('sb-len');
    if (!sbPos) return;
    if (!activeTab || activeTab.kind === 'image' || activeTab.kind === 'diff') {
      sbFile.textContent = activeTab ? activeTab.name : '未打开文件';
      if (activeTab && activeTab.kind === 'diff') {
        sbPos.textContent = '对比视图（只读）';
        const m = activeTab._model;
        sbLen.textContent = m ? `+${m.stats.add} −${m.stats.del} ~${m.stats.mod}` : '';
      } else {
        sbPos.textContent = activeTab ? (activeTab.lang === 'image' ? '图片预览' : '') : '';
        sbLen.textContent = '';
      }
      return;
    }
    if (activeTab.kind === 'viewer-lg') {
      const c = activeTab.vwin;
      sbFile.textContent = activeTab.name;
      sbPos.textContent = `窗口偏移 ${formatSize(c.offset)} / ${formatSize(c.size)}（${c.size > 0 ? Math.floor((c.offset / c.size) * 100) : 0}%）`;
      sbLen.textContent = `${formatSize(activeTab.state.doc.length)} 已加载`;
      return;
    }
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const col = pos - line.from + 1;
    const sel = view.state.selection.main;
    const selLen = sel.from === sel.to ? 0 : sel.to - sel.from;
    sbFile.textContent = activeTab.name;
    sbPos.textContent = `${activeTab.readOnly ? '🔒 只读 · ' : ''}行 ${line.number}, 列 ${col}${selLen ? `（选中 ${selLen} 字）` : ''}`;;
    sbLen.textContent = `${view.state.doc.length} 字符`;
  }

  function renderImageTab(tab) {
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

  function closeTab(tab) {
    if (tab.dirty) {
      // 未保存：先触发一次立即保存
      saveNow(tab);
    }
    const idx = tabs.indexOf(tab);
    if (idx < 0) return;
    tabs.splice(idx, 1);
    window.api.unwatchFile(tab.path); // 停止监听
    if (activeTab === tab) {
      const next = tabs[Math.max(0, idx - 1)] || null;
      if (next) switchTab(next);
      else {
        activeTab = null;
        imageHost.classList.add('hidden');
        view.setState(makeState('', 'text'));
        renderTabs();
        updateStatusBar();
        onTabSwitch(null);
      }
    } else {
      renderTabs();
    }
    if (onSessionChange) onSessionChange();
  }

  function closeAll() {
    for (const t of [...tabs]) closeTab(t);
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

  /** 标签右键菜单：固定/取消固定 → 只读切换（跨窗口共享文件）→ 批量关闭 → 关闭当前 */
  function showTabCtx(x, y, tab) {
    const items = [
      { label: tab.pinned ? '📌 取消固定' : '📌 固定标签', onClick: () => togglePinned(tab) },
    ];
    if (!tab.kind) {
      items.push({ label: tab.readOnly ? '🔓 允许编辑' : '🔒 设为只读', onClick: () => toggleReadOnly(tab) });
    }
    items.push(
      { sep: true },
      { label: '关闭其它标签', onClick: () => closeOthers(tab) },
      { label: '关闭右侧标签', onClick: () => closeRight(tab) },
      { label: '关闭左侧标签', onClick: () => closeLeft(tab) },
      { sep: true },
      { label: '✕ 关闭标签', onClick: () => onRequestClose(tab) }
    );
    showContextMenu(x, y, items);
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
    if (activeTab === tab) {
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!!v)) });
      tab.state = view.state;
      updateStatusBar();
    }
    renderTabs();
    return true;
  }

  /** 批量关闭：对快照迭代，保留「锚定标签 + 范围内 pinned 标签」，末尾激活锚定标签 */
  function closeOthers(anchor) {
    if (!anchor || tabs.length < 2) return;
    for (const t of [...tabs]) {
      if (t === anchor || t.pinned) continue;
      closeTab(t);
    }
    switchTab(anchor);
  }

  function closeLeft(anchor) {
    if (!anchor) return;
    const ai = tabs.indexOf(anchor);
    if (ai < 0) return;
    for (const t of [...tabs].slice(0, ai)) {
      if (t.pinned) continue;
      closeTab(t);
    }
    switchTab(anchor);
  }

  function closeRight(anchor) {
    if (!anchor) return;
    const ai = tabs.indexOf(anchor);
    if (ai < 0) return;
    for (const t of [...tabs].slice(ai + 1)) {
      if (t.pinned) continue;
      closeTab(t);
    }
    switchTab(anchor);
  }

  function renderTabs() {
    hideContextMenu(); // 高频重建时避免悬空菜单
    tabsEl.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `tab ${tab === activeTab ? 'active' : ''} ${tab.pinned ? 'pinned' : ''}`;
      el.title = tab.path;
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
        onRequestClose(tab);
      });
      el.appendChild(close);
      el.addEventListener('click', () => switchTab(tab));
      // 标签右键菜单：preventDefault + stopPropagation（与树菜单共用单例 #ctx-menu）
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabCtx(e.clientX, e.clientY, tab);
      });
      tabsEl.appendChild(el);
      tabBadges.set(tab, el); // O1：结构渲染时登记元素，供徽标级增量更新
    }
    updateEmpty();
  }

  // ---------- O1：标签徽标增量更新 ----------
  // docChanged / 保存 / 切换等高频路径只改 active 类与 dirty 圆点，不再全量重建标签 DOM ——
  // 100+ 标签时每击键的 O(N) DOM 重建是键入延迟的主要来源
  const tabBadges = new Map(); // tab -> 元素
  function updateTabBadges() {
    for (const [tab, el] of tabBadges) {
      if (!el.isConnected) {
        tabBadges.delete(tab);
        continue;
      }
      el.classList.toggle('active', tab === activeTab);
      const dot = el.querySelector('.tab-dot');
      if (dot) dot.classList.toggle('hidden', !tab.dirty);
    }
  }

  function updateEmpty() {
    const empty = document.getElementById('editor-empty');
    empty.classList.toggle('hidden', !!activeTab);
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

  async function doSaveNow(tab) {
    const t = tab || activeTab;
    if (!t || !t.dirty) return true;
    if (t.kind === 'viewer-lg') {
      return saveViewerRegion(t); // 区域编辑内容按字节偏移拼接写回
    }
    if (t.kind === 'chunked' && !t.chunk.complete) {
      await ensureFullyLoaded(t); // P7：先补齐剩余分段再写盘，防止只写已加载部分造成截断
    }
    const content = stripChunkMarkers(t.state.doc.toString()); // 剥离占位标记，不污染文件内容
    try {
      if (t.state.doc.length > 64_000_000) {
        await saveStreamed(t); // 超大文档：分块流式写（避免单串 IPC 的内存/长度悬崖）
      } else {
        await window.api.writeFile(t.path, content);
      }
      t.dirty = false;
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
   *  （V8 单字符串上限 ≈ 5.36 亿字符）与结构化克隆的整串内存峰值。 */
  async function saveStreamed(t) {
    const total = t.state.doc.length;
    const id = await window.api.writeStreamOpen(t.path);
    try {
      const CHUNK = 16_000_000;
      for (let pos = 0; pos < total; pos += CHUNK) {
        const piece = t.state.doc.sliceString(pos, Math.min(pos + CHUNK, total));
        await window.api.writeStreamAppend(id, piece);
      }
      await window.api.writeStreamClose(id);
    } catch (err) {
      try { await window.api.writeStreamClose(id); } catch { /* fd 已失效 */ }
      throw err;
    }
  }

  function setWordWrap(on) {
    wordWrapOn = on;
    if (activeTab) {
      view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
      activeTab.state = view.state;
    }
  }

  /** 设置缩进宽度（空格数，clamp 1~8）：新开标签（makeState）与活动标签（reconfigure）立即生效 */
  function setIndentSize(n) {
    indentSize = clampIndent(n);
    if (activeTab && !activeTab.kind) {
      view.dispatch({ effects: indentCompartment.reconfigure(indentExtensions(indentSize)) });
      activeTab.state = view.state;
    }
  }

  /** 滚动到顶部（状态栏按钮）：编辑器 / 图片视图 / 对比视图通用，不改光标 */
  function scrollToTop() {
    const t = activeTab;
    if (!t) return;
    if (t.kind === 'image') {
      imageHost.scrollTop = 0;
      return;
    }
    if (t.kind === 'diff') {
      const sc = diffHost && diffHost.querySelector('.diff-scroller');
      if (sc) sc.scrollTop = 0;
      return;
    }
    view.scrollDOM.scrollTop = 0;
  }

  /** 滚动到底部（状态栏按钮）：chunked 标签先补齐剩余分段（显式到底部 = 与保存同语义），
   *  追加后高度测量异步 → 多帧校正；图片视图直接滚到底。 */
  async function scrollToBottom() {
    const t = activeTab;
    if (!t) return;
    if (t.kind === 'image') {
      imageHost.scrollTop = imageHost.scrollHeight;
      return;
    }
    if (t.kind === 'chunked' && !t.chunk.complete) {
      await ensureFullyLoaded(t);
    }
    const el = view.scrollDOM;
    const set = (n) => {
      if (activeTab !== t || !el) return;
      el.scrollTop = el.scrollHeight;
      if (n > 0) requestAnimationFrame(() => set(n - 1));
    };
    set(4);
  }

  // ---------- v0.2.0：对比标签 ----------
  /** 打开（或激活）一个对比标签：左右内容只读双栏 diff。
   *  opts: { leftLabel, leftContent, rightLabel, rightContent }；同参数组合已开则激活。 */
  function openDiffTab(opts) {
    const key = 'diff://' + opts.leftLabel + '⟷' + opts.rightLabel;
    const existing = tabs.find((t) => t.kind === 'diff' && t.diffKey === key);
    if (existing) {
      existing.leftContent = opts.leftContent;
      existing.rightContent = opts.rightContent;
      switchTab(existing);
      renderDiff(existing); // 内容可能已变，重渲染
      return existing;
    }
    const tab = {
      id: ++idSeq,
      path: null, // 不参与会话持久化与文件监听
      name: '🔀 ' + opts.leftLabel + ' ↔ ' + opts.rightLabel,
      diffKey: key,
      kind: 'diff',
      leftLabel: opts.leftLabel,
      rightLabel: opts.rightLabel,
      leftContent: opts.leftContent,
      rightContent: opts.rightContent,
      exportDir: opts.exportDir || '', // 报告导出目录（app.js 传入当前工作目录）
      state: null,
      dirty: false,
      saveTimer: null,
      pinned: false,
      scrollTop: 0,
    };
    tabs.push(tab);
    switchTab(tab);
    if (onSessionChange) onSessionChange();
    return tab;
  }

  /** 渲染对比标签内容（交换/导出回调闭环在此） */
  function renderDiff(tab) {
    if (!diffHost) return;
    renderDiffTab(tab, diffHost, {
      onSwap: () => {
        const l = tab.leftContent, ll = tab.leftLabel;
        tab.leftContent = tab.rightContent;
        tab.leftLabel = tab.rightLabel;
        tab.rightContent = l;
        tab.rightLabel = ll;
        tab.scrollTop = 0;
        renderDiff(tab);
        updateStatusBar();
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
    return activeTab;
  }

  /** 会话快照：所有标签路径（含图片/PDF，保持顺序）+ 活动标签下标 + pinned 下标数组 */
  function getSession() {
    // 对比标签（kind='diff'）为临时视图：不入会话（path 为 null，重启不恢复）；
    // active/pinned 下标按过滤后的列表语义计算
    const persist = tabs.filter((t) => !!t.path);
    const activePersisted = persist.indexOf(activeTab);
    return {
      paths: persist.map((t) => t.path),
      active: activePersisted,
      pinned: persist.map((t, i) => (t.pinned ? i : -1)).filter((i) => i >= 0),
    };
  }

  /** 若该路径标签已存在则激活并返回 true（会话恢复用），否则 false */
  function activateByPath(path) {
    const tab = tabs.find((t) => t.path === path);
    if (tab) {
      switchTab(tab);
      return true;
    }
    return false;
  }

  function getView() {
    return view;
  }

  /** 定位到指定行（从 1 开始），用于搜索结果跳转 */
  function jumpToLine(tab, line) {
    switchTab(tab);
    const doJump = () => {
      const maxLine = view.state.doc.lines;
      const l = Math.max(1, Math.min(line || 1, maxLine));
      const pos = view.state.doc.line(l).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
    };
    // P7：分段模式下行号超出已加载范围 → 先续读到该行再定位
    if (tab.kind === 'chunked' && !tab.chunk.complete && line > view.state.doc.lines) {
      ensureLineLoaded(tab, line).then(doJump);
    } else {
      doJump();
    }
  }

  function findTabByPath(p) {
    return tabs.find((t) => t.path === p) || null;
  }

  /** P9（v0.1.45）：按给定路径顺序重排标签数组（会话恢复并行打开完成后调用，
   *  保证标签栏顺序 = 会话顺序，pinned/active 下标语义不变）；
   *  不在 orderPaths 中的标签保持原相对顺序追加到末尾；随后重绘一次。 */
  function reorderTabs(orderPaths) {
    const indexOf = new Map(orderPaths.map((p, i) => [p, i]));
    const orig = new Map(tabs.map((t, i) => [t, i]));
    tabs.sort((a, b) => {
      const ia = indexOf.has(a.path) ? indexOf.get(a.path) : orig.size + orig.get(a);
      const ib = indexOf.has(b.path) ? indexOf.get(b.path) : orig.size + orig.get(b);
      return ia - ib;
    });
    renderTabs();
  }

  /** 关闭路径匹配（自身或在目录内）的所有标签 */
  function closeByPath(p, isDir) {
    for (const t of [...tabs]) {
      if (isDir ? t.path.startsWith(p.replace(/[\\/]$/, '') + '\\') || t.path.startsWith(p.replace(/[\\/]$/, '') + '/') : t.path === p) {
        closeTab(t);
      }
    }
  }

  // ---------- 粘贴图片：保存到当前文件同目录并插入 markdown 引用 ----------
  view.dom.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || !activeTab) return;
    const images = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) images.push(item);
    }
    if (images.length === 0) return;
    e.preventDefault();
    pasteImages(images);
  });

  // ---------- 编辑器右键菜单：粘贴为纯文本（v1 不剥离 Markdown 符号，原样插入系统 text/plain） ----------
  view.dom.addEventListener('contextmenu', (e) => {
    // 仅文本编辑区生效：图片标签页（编辑区隐藏）不弹该菜单
    if (!activeTab || activeTab.kind === 'image') return;
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
          insertAtCursor(t);
        },
      },
    ]);
  });

  function dirOf(p) {
    return String(p).replace(/[\\/][^\\/]*$/, '');
  }

  let imgSeq = 0; // 粘贴图片序号：防止同毫秒文件名冲突

  async function pasteImages(items) {
    const tab = activeTab;
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
        insertAtCursor(`![${name}](./${name})`);
        const { toast } = await import('./ui.js');
        toast(`图片已插入：${name}`);
      } catch (err) {
        const { toast } = await import('./ui.js');
        toast('图片保存失败：' + (err.message || err));
      }
    }
  }

  function insertAtCursor(text) {
    if (view.state.readOnly) {
      toast('只读内容不可编辑（大文件查看器请先启用区域编辑）');
      return;
    }
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    view.focus();
  }

  /** AI 内容写入文档：mode = replace(替换选中) / insert(插入光标) / full(替换全文) */
  async function applySnippet(text, mode, from, to) {
    const tab = activeTab;
    if (!tab || tab.kind === 'image') return false;
    if (mode === 'full' && tab.kind === 'chunked' && !tab.chunk.complete) {
      // P7：全文替换前补齐剩余分段，避免只替换已加载部分造成内容丢失
      await ensureFullyLoaded(tab);
    }
    let change;
    if (mode === 'replace') change = { from, to, insert: text };
    else if (mode === 'insert') change = { from, insert: text };
    else change = { from: 0, to: view.state.doc.length, insert: text };
    view.dispatch({ changes: change });
    tab.state = view.state;
    view.focus();
    return true;
  }

  // ---------- 图片标签页：左键拖拽平移查看（放大后） ----------
  let imgDrag = null;
  imageHost.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return; // 不干扰工具栏按钮
    e.preventDefault();
    imgDrag = { x: e.clientX, y: e.clientY, sl: imageHost.scrollLeft, st: imageHost.scrollTop };
    imageHost.classList.add('dragging');
  });
  document.addEventListener('mousemove', (e) => {
    if (!imgDrag) return;
    imageHost.scrollLeft = imgDrag.sl - (e.clientX - imgDrag.x);
    imageHost.scrollTop = imgDrag.st - (e.clientY - imgDrag.y);
  });
  document.addEventListener('mouseup', () => {
    if (!imgDrag) return;
    imgDrag = null;
    imageHost.classList.remove('dragging');
  });

  // ---------- 外部修改检测：自动重载（有未保存修改时询问） ----------
  window.api.onFileChanged(async ({ path: changedPath }) => {
    // 普通文本标签（kind 未定义）+ 分段标签（kind='chunked'）参与外部修改同步；图片标签（kind='image'）不参与
    const tab = tabs.find((t) => t.path === changedPath && (!t.kind || t.kind === 'chunked'));
    if (!tab) return;
    // 自写回声双保险：刚保存后短时间内的变更通知视为自身写入的延迟回声，静默忽略
    // （主进程 markSelfWrite 宽限窗口已吸收绝大多数；此处兜底高频编辑下的残余竞态，
    //  避免打字中弹出「已在外部被修改」确认框打断输入）
    if (tab.lastSavedAt && Date.now() - tab.lastSavedAt < 1200) return;
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

  /** 从磁盘重载标签内容（外部修改同步 / 跨窗口只读同步共用）。
   *  silent=true（只读观察窗）：不弹 toast —— 编辑窗口连续自动保存时观察窗静默跟随、不闪不抖。
   *  活动标签用 dispatch 整文替换（保持 state 连续性 + 光标/滚动位置），非活动标签重建 state。 */
  async function reloadFromDisk(tab, silent) {
    // P7：分段标签走分段重载（重置解码器重读首段 + 续读），避免全量 readFile 触碰大文件上限
    if (tab.kind === 'chunked') {
      try {
        await reloadChunked(tab);
      } catch (err) {
        console.warn('[chunked] 外部修改重载失败:', tab.path, err && err.message ? err.message : err);
        return;
      }
      tab.dirty = false;
      if (activeTab === tab) onTabSwitch(tab); // 刷新预览等
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
    // 记录重载前的光标与滚动位置，重载后恢复（避免跳回顶部）
    const selPos = activeTab === tab ? view.state.selection.main.head : null;
    const scrollTop = activeTab === tab ? view.scrollDOM.scrollTop : null;
    if (activeTab === tab) {
      // 用 dispatch 替换整个文档（保留 state 连续性与滚动位置），而非重建 state
      const anchor = Math.min(selPos, data.content.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: data.content },
        selection: { anchor },
      });
      tab.state = view.state;
      // 多帧校正滚动位置（CM 的异步测量可能覆盖 scrollTop）
      if (scrollTop !== null) {
        const restoreScroll = (n) => {
          if (n <= 0) return;
          view.scrollDOM.scrollTop = scrollTop;
          requestAnimationFrame(() => restoreScroll(n - 1));
        };
        restoreScroll(3);
      }
    } else {
      tab.state = makeState(data.content, tab.lang);
    }
    tab.dirty = false;
    if (activeTab === tab) onTabSwitch(tab); // 刷新预览等
    renderTabs();
    if (!silent) {
      const { toast } = await import('./ui.js');
      toast(`已从外部重新加载 ${tab.name}`);
    }
  }

  // ---------- 查看器横幅按钮（DOM 在 index.html，逻辑归编辑器模块） ----------
  const viewerBar = document.getElementById('viewer-bar');
  const btnViewerJump = document.getElementById('btn-viewer-jump');
  const btnViewerEdit = document.getElementById('btn-viewer-edit');
  const btnViewerPrev = document.getElementById('btn-viewer-prev');
  const btnViewerNext = document.getElementById('btn-viewer-next');
  if (btnViewerJump) {
    btnViewerJump.addEventListener('click', () => {
      const t = activeTab;
      if (!t || t.kind !== 'viewer-lg') return;
      showPrompt(
        '跳转位置',
        '百分比（如 50%）或字节偏移（如 1.5G / 500M / 1600000000）',
        '',
        (v) => viewerJump(t, v)
      );
    });
  }
  if (btnViewerEdit) {
    btnViewerEdit.addEventListener('click', () => {
      const t = activeTab;
      if (!t || t.kind !== 'viewer-lg') return;
      setViewerEditing(t, !t.editing);
    });
  }
  if (btnViewerPrev) btnViewerPrev.addEventListener('click', () => {
    if (activeTab && activeTab.kind === 'viewer-lg') slideViewer(activeTab, -1);
  });
  if (btnViewerNext) btnViewerNext.addEventListener('click', () => {
    if (activeTab && activeTab.kind === 'viewer-lg') slideViewer(activeTab, +1);
  });

  return { openFile, openDiffTab, closeTab, closeAll, saveNow, setWordWrap, setIndentSize, getActiveTab, getView, renderTabs, jumpToLine, findTabByPath, closeByPath, applySnippet, cycleTab, getSession, activateByPath, togglePinned, setPinned, closeOthers, closeLeft, closeRight, reorderTabs, scrollToTop, scrollToBottom, viewerJump, setViewerEditing, revealViewerAt, slideViewerWindow: slideViewer, setTabReadOnly, toggleReadOnly };
}
