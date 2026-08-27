// 文件内查找与替换：底部面板展示全部匹配 + 编辑器高亮 + 替换当前/全部
import { Decoration, EditorView } from '@codemirror/view';
import { $, escapeHtml, toast } from './ui.js';
import { matchEffect } from './tabs.js';

export function createFind(getEditor, getTab) {
  const input = $('#find-input');
  const replaceInput = $('#replace-input');
  const count = $('#find-count');
  const resultsEl = $('#find-results');
  const panel = $('#panel-find');

  let matches = [];      // 全部匹配 {line, from, to, text}
  let current = -1;      // 当前选中匹配下标
  let query = '';
  // P10（v0.1.45）：结果 DOM 优化 —— 行元素数组 + 上次渲染快照（state/query/len 三者恒等 → 跳过重建）。
  // CodeMirror EditorState 不可变：tab.state 引用不变 ⇒ 文档内容未变 ⇒ 同 query 下 matches 必然一致，
  // 因此 jumpTo / 重复触发等路径可只切 current 高亮，避免 2000 行每击键全量重建（实测 11.5ms/次）。
  let rowEls = [];
  let lastState = null;
  let lastQuery = '';
  let lastLen = -1;

  function getView() {
    return getEditor().getView();
  }

  /** 收集文档中全部匹配（不区分大小写，含一行多处） */
  function collect(state, q) {
    const out = [];
    const lower = q.toLowerCase();
    const doc = state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const text = line.text;
      let idx = text.toLowerCase().indexOf(lower);
      while (idx >= 0) {
        out.push({ line: i, from: line.from + idx, to: line.from + idx + q.length, text });
        idx = text.toLowerCase().indexOf(lower, idx + q.length);
      }
    }
    return out;
  }

  function applyHighlights() {
    const view = getView();
    const ranges = [];
    matches.forEach((m, i) => {
      const cls = i === current ? 'cm-search-current' : 'cm-search-match';
      ranges.push(Decoration.mark({ class: cls }).range(m.from, m.to));
    });
    view.dispatch({ effects: matchEffect.of(Decoration.set(ranges, true)) });
  }

  /** 仅同步 current 高亮与滚动（跳转/Enter 导航路径，不重建列表） */
  function syncCurrentClass() {
    rowEls.forEach((row, i) => row.classList.toggle('current', i === current));
    const cur = resultsEl.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderResults() {
    const tab = getTab();
    // P10：文档内容未变（state 引用恒等）且 query/匹配数一致 → 结果行必然一致，跳过全量重建
    const unchanged = query === lastQuery && lastLen === matches.length && !!tab && tab.state === lastState;
    if (unchanged) {
      syncCurrentClass();
      return;
    }
    resultsEl.textContent = '';
    rowEls = [];
    lastState = null;
    lastQuery = '';
    lastLen = -1;
    if (!query) {
      resultsEl.innerHTML = '<div class="find-empty">输入关键词开始搜索（不区分大小写，展示全部匹配）</div>';
      return;
    }
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="find-empty">没有找到匹配项</div>';
      return;
    }
    // P10：DocumentFragment 批量构建（一次 append，避免 2000 行逐行 append 触发布局）；
    // 行点击走容器级事件委托（dataset.index），不再每行一个 listener
    const frag = document.createDocumentFragment();
    matches.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'find-result' + (i === current ? ' current' : '');
      row.dataset.index = i;
      const lineNo = document.createElement('span');
      lineNo.className = 'r-line';
      lineNo.textContent = m.line;
      const text = document.createElement('span');
      text.className = 'r-text';
      text.innerHTML = highlightText(m.text, query);
      row.append(lineNo, text);
      frag.appendChild(row);
      rowEls.push(row);
    });
    resultsEl.appendChild(frag);
    lastState = tab ? tab.state : null;
    lastQuery = query;
    lastLen = matches.length;
    // 当前项滚入视野
    const cur = resultsEl.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function highlightText(text, q) {
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    let html = '';
    let i = 0;
    let idx = lower.indexOf(ql);
    while (idx >= 0) {
      html += escapeHtml(text.slice(i, idx));
      html += `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`;
      i = idx + q.length;
      idx = lower.indexOf(ql, i);
    }
    html += escapeHtml(text.slice(i));
    return html;
  }

  function jumpTo(i) {
    if (i < 0 || i >= matches.length) return;
    current = i;
    const m = matches[i];
    const view = getView();
    view.dispatch({
      selection: { anchor: m.from },
      effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
    });
    applyHighlights();
    syncCurrentClass(); // P10：仅切 current 高亮 + 滚入视野，不重建结果列表
  }

  function runSearch(noJump = false) {
    const tab = getTab();
    query = input.value.trim();
    current = -1;
    // 图片标签页没有文档（tab.state 为 null），清空匹配
    if (!query || !tab || !tab.state) {
      matches = [];
      count.textContent = '';
      applyHighlights();
      renderResults();
      return;
    }
    matches = collect(tab.state, query);
    count.textContent = `${matches.length} 处匹配`;
    applyHighlights();
    renderResults();
    // noJump=true 时不抢占光标（编辑文档触发时用），只更新高亮与列表
    if (matches.length > 0 && !noJump) jumpTo(0);
  }

  function clearSearch() {
    input.value = '';
    runSearch();
  }

  /** 外部设置搜索词（如点击全局搜索结果），noJump 时不抢占当前光标 */
  function setQuery(q, noJump = false) {
    input.value = q;
    runSearch(noJump);
  }

  // ---------- 替换（与查找同口径：不区分大小写；替换文本原样插入，不做分组引用） ----------
  /** 大小写不敏感全量替换辅助：返回 [新文本, 替换处数] */
  function replaceAllInText(text, q, rep) {
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    let out = '';
    let i = 0;
    let n = 0;
    let idx = lower.indexOf(ql);
    while (idx >= 0) {
      out += text.slice(i, idx) + rep;
      i = idx + q.length;
      n++;
      idx = lower.indexOf(ql, i);
    }
    out += text.slice(i);
    return [out, n];
  }

  /** 替换当前选中匹配（无选中时替换第一处），替换后跳到下一处 */
  function replaceCurrent() {
    if (getView().state.readOnly) {
      toast('只读内容不可替换');
      return 0;
    }
    if (current < 0 || current >= matches.length) {
      if (matches.length > 0) jumpTo(0);
      return 0;
    }
    const idx = current;
    const m = matches[idx];
    const rep = replaceInput.value;
    getView().dispatch({ changes: { from: m.from, to: m.to, insert: rep } });
    runSearch(true); // 位置已失效：按新文档重算（current 重置为 -1）
    if (matches.length > 0) jumpTo(Math.min(idx, matches.length - 1));
    return 1;
  }

  /** 替换当前文件中全部匹配（一次 dispatch，多处原子生效），返回替换处数 */
  function replaceAll() {
    if (getView().state.readOnly) {
      toast('只读内容不可替换');
      return 0;
    }
    const tab = getTab();
    if (!query || !tab || !tab.state || matches.length === 0) return 0;
    const rep = replaceInput.value;
    const changes = matches.map((m) => ({ from: m.from, to: m.to, insert: rep }));
    getView().dispatch({ changes });
    const n = matches.length;
    runSearch(true);
    toast(`已替换 ${n} 处${matches.length ? `，剩余 ${matches.length} 处匹配` : ''}`);
    return n;
  }

  input.addEventListener('input', () => runSearch());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (matches.length === 0) return;
      const step = e.shiftKey ? -1 : 1;
      jumpTo((current + step + matches.length) % matches.length);
    }
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (e.shiftKey) replaceAll();
      else replaceCurrent();
    }
  });
  const btnRep = $('#btn-replace');
  const btnRepAll = $('#btn-replace-all');
  if (btnRep) btnRep.addEventListener('click', replaceCurrent);
  if (btnRepAll) btnRepAll.addEventListener('click', replaceAll);
  // P10：结果行点击 → 容器级事件委托（行内不再挂 listener，2000 行也只有一个监听器）
  resultsEl.addEventListener('click', (e) => {
    const row = e.target.closest('.find-result');
    if (!row) return;
    const idx = parseInt(row.dataset.index, 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < matches.length) jumpTo(idx);
  });

  return {
    runSearch, setQuery, clearSearch, replaceCurrent, replaceAll,
    focus: () => { panel.classList.remove('hidden'); input.focus(); input.select(); },
    focusReplace: () => { panel.classList.remove('hidden'); replaceInput.focus(); replaceInput.select(); },
  };
}
