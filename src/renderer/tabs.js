// 多标签 + CodeMirror 编辑器核心
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { langFor, baseName, escapeHtml } from './ui.js';
import { pathToFileUrl } from './viewer.js';

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

// 简约清新浅色主题
const lightTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#26303e' },
  '.cm-content': { caretColor: '#3b82f6' },
  '.cm-line': { padding: '0 12px' },
  '.cm-search-match': { backgroundColor: '#ffe08a', borderRadius: '2px' },
  '.cm-search-current': { backgroundColor: '#ffb84d', borderRadius: '2px', outline: '1px solid #f59e0b' },
  '.cm-matchingBracket': { backgroundColor: '#dbeafe', outline: '1px solid #93c5fd' },
  '.cm-tooltip': { border: '1px solid #e3e8ef', borderRadius: '8px', boxShadow: '0 6px 20px rgba(16,42,84,.12)' },
});

export function createEditor(callbacks) {
  const host = document.getElementById('editor-host');
  const tabsEl = document.getElementById('tabs');
  const { onDocChanged, onTabSwitch, onRequestClose, getWordWrap, onSaveStatus, onSessionChange } = callbacks;

  const tabs = []; // { id, path, name, lang, state, dirty, saveTimer, savedContent }
  let activeTab = null;
  let idSeq = 0;
  let wordWrapOn = getWordWrap();

  const langCompartment = new Compartment();
  const wrapCompartment = new Compartment();

  function makeState(doc, lang) {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        lightTheme,
        langCompartment.of(langExt(lang)),
        wrapCompartment.of(wordWrapOn ? EditorView.lineWrapping : []),
        matchField,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && activeTab) {
            try {
              activeTab.state = u.state;
              activeTab.dirty = true;
              renderTabs();
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

  // 等宽字体加载完成后强制重新测量：防止字体未就绪导致字符宽度缓存错误
  // （会造成同一行内鼠标选择的坐标映射异常，而跨行选择不受影响）
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      view.requestMeasure();
    });
  }

  const imageHost = document.getElementById('image-host');
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'pdf'];

  // ---------- 打开 / 切换 / 关闭 ----------
  async function openFile(path) {
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
    let data;
    try {
      data = await window.api.readFile(path);
    } catch (err) {
      if (err && err.code === 'TOO_LARGE') {
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
    };
    tab.state = makeState(data.content, tab.lang);
    tabs.push(tab);
    switchTab(tab);
    window.api.watchFile(path, data.mtime); // 监听外部修改
    if (onSessionChange) onSessionChange();
    return tab;
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
    };
    tabs.push(tab);
    switchTab(tab);
    if (onSessionChange) onSessionChange();
    return tab;
  }

  function switchTab(tab) {
    activeTab = tab;
    if (tab.kind === 'image') {
      // 图片标签：编辑区显示图片视图
      view.setState(makeState('', 'text'));
      renderImageTab(tab);
    } else {
      view.setState(tab.state);
      // 对齐换行设置
      wordWrapOn = getWordWrap();
      view.dispatch({ effects: wrapCompartment.reconfigure(wordWrapOn ? EditorView.lineWrapping : []) });
      tab.state = view.state;
    }
    renderTabs();
    updateStatusBar();
    onTabSwitch(tab);
    if (onSessionChange) onSessionChange();
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
    if (!activeTab || activeTab.kind === 'image') {
      sbFile.textContent = activeTab ? activeTab.name : '未打开文件';
      sbPos.textContent = activeTab ? (activeTab.lang === 'image' ? '图片预览' : '') : '';
      sbLen.textContent = '';
      return;
    }
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const col = pos - line.from + 1;
    const sel = view.state.selection.main;
    const selLen = sel.from === sel.to ? 0 : sel.to - sel.from;
    sbFile.textContent = activeTab.name;
    sbPos.textContent = `行 ${line.number}, 列 ${col}${selLen ? `（选中 ${selLen} 字）` : ''}`;
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

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `tab ${tab === activeTab ? 'active' : ''}`;
      el.title = tab.path;
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.name;
      el.appendChild(name);
      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        el.appendChild(dot);
      }
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        onRequestClose(tab);
      });
      el.appendChild(close);
      el.addEventListener('click', () => switchTab(tab));
      tabsEl.appendChild(el);
    }
    updateEmpty();
  }

  function updateEmpty() {
    const empty = document.getElementById('editor-empty');
    empty.classList.toggle('hidden', !!activeTab);
  }

  // ---------- 保存 ----------
  async function saveNow(tab) {
    const t = tab || activeTab;
    if (!t || !t.dirty) return;
    const content = t.state.doc.toString();
    try {
      await window.api.writeFile(t.path, content);
      t.dirty = false;
      if (onSaveStatus) onSaveStatus(`已保存 ${t.name}`);
      renderTabs();
    } catch (err) {
      if (onSaveStatus) onSaveStatus(`保存失败：${err.message || err}`);
    }
  }

  function setWordWrap(on) {
    wordWrapOn = on;
    if (activeTab) {
      view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
      activeTab.state = view.state;
    }
  }

  function getActiveTab() {
    return activeTab;
  }

  /** 会话快照：所有标签路径（含图片/PDF，保持顺序）+ 活动标签下标 */
  function getSession() {
    return { paths: tabs.map((t) => t.path), active: tabs.indexOf(activeTab) };
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
    const maxLine = view.state.doc.lines;
    const l = Math.max(1, Math.min(line || 1, maxLine));
    const pos = view.state.doc.line(l).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  }

  function findTabByPath(p) {
    return tabs.find((t) => t.path === p) || null;
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
    for (const item of items) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const buf = await file.arrayBuffer();
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
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
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
    view.focus();
  }

  /** AI 内容写入文档：mode = replace(替换选中) / insert(插入光标) / full(替换全文) */
  function applySnippet(text, mode, from, to) {
    const tab = activeTab;
    if (!tab || tab.kind === 'image') return false;
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
    const tab = tabs.find((t) => t.path === changedPath && !t.kind);
    if (!tab) return;
    let data;
    try {
      data = await window.api.readFile(changedPath);
    } catch {
      return; // 文件不可读，忽略
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
    const { toast } = await import('./ui.js');
    toast(`已从外部重新加载 ${tab.name}`);
  });

  return { openFile, closeTab, closeAll, saveNow, setWordWrap, getActiveTab, getView, renderTabs, jumpToLine, findTabByPath, closeByPath, applySnippet, cycleTab, getSession, activateByPath };
}
