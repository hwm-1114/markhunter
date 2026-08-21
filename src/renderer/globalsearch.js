// 全局搜索：跨文件搜索，结果按文件分组展示
// P6（v0.1.45）：① 搜索逻辑在主进程 utilityProcess worker 执行（不阻塞主进程事件循环）；
//   ② 结果分批渲染（首 200 条 + 「加载更多」按钮），不再一次性建 3000 行 DOM；
//   ③ 搜索中按钮变为「取消」，可随时中止（search:cancel）。
import { $, escapeHtml, dirName, baseName } from './ui.js';

const RENDER_BATCH = 200; // 每批渲染的结果行数（P6：分批注入 DOM）

export function createGlobalSearch(getRootDir, onOpenFileAt) {
  const input = $('#gs-input');
  const count = $('#gs-count');
  const resultsEl = $('#gs-results');
  const btn = $('#btn-gs-go');

  let running = false;
  let offProgress = null;
  // 分批渲染状态（P6）
  let groupsArr = [];  // [{ file, rows }] 按文件分组的有序数组
  let gi = 0;          // 当前批次起始组下标
  let ri = 0;          // 当前组内起始行下标
  let renderedTotal = 0;

  async function run() {
    const query = input.value.trim();
    const root = getRootDir();
    count.textContent = '';
    if (!query) {
      resultsEl.innerHTML = '<div class="find-empty">输入关键词，在打开目录的所有文件中搜索</div>';
      return;
    }
    if (!root) {
      resultsEl.innerHTML = '<div class="find-empty">请先选择工作目录</div>';
      return;
    }
    if (running) {
      // 搜索进行中再次点击 = 取消（P6）
      window.api.globalSearchCancel().catch(() => {});
      return;
    }
    running = true;
    lastQuery = query; // 供分批渲染高亮/跳转使用
    btn.textContent = '取消';
    resultsEl.innerHTML = '<div class="find-empty">搜索中…</div>';
    offProgress = window.api.onGlobalSearchProgress((d) => {
      if (running && d && typeof d.scanned === 'number') {
        count.textContent = `已扫描 ${d.scanned} 个文件，${d.matches || 0} 处匹配…`;
      }
    });
    try {
      const results = await window.api.globalSearch(root, query);
      renderResults(results, query);
      count.textContent = results.length >= 3000 ? '结果过多，已截断' : `${results.length} 处匹配`;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      resultsEl.innerHTML = `<div class="find-empty">${msg.includes('已取消') ? '搜索已取消' : '搜索失败：' + escapeHtml(msg)}</div>`;
      count.textContent = '';
    } finally {
      if (offProgress) { offProgress(); offProgress = null; }
      running = false;
      btn.textContent = '搜索';
    }
  }

  // ---------- P6：分批渲染 ----------
  function renderResults(results, query) {
    resultsEl.innerHTML = '';
    if (results.length === 0) {
      resultsEl.innerHTML = '<div class="find-empty">没有找到匹配项</div>';
      return;
    }
    const groups = new Map(); // file -> [{line,text}]
    for (const r of results) {
      if (!groups.has(r.file)) groups.set(r.file, []);
      groups.get(r.file).push(r);
    }
    groupsArr = [];
    for (const [file, rows] of groups) groupsArr.push({ file, rows });
    gi = 0;
    ri = 0;
    renderedTotal = 0;
    renderNextBatch(query);
  }

  function renderNextBatch(query) {
    const old = resultsEl.querySelector('.gs-more-btn');
    if (old) old.remove();
    const frag = document.createDocumentFragment();
    let count = 0;
    while (gi < groupsArr.length && count < RENDER_BATCH) {
      const g = groupsArr[gi];
      if (ri === 0) frag.appendChild(buildHeader(g));
      for (; ri < g.rows.length && count < RENDER_BATCH; ri++, count++) {
        frag.appendChild(buildRow(g, g.rows[ri]));
        renderedTotal++;
      }
      if (ri >= g.rows.length) { gi++; ri = 0; }
    }
    resultsEl.appendChild(frag);
    if (gi < groupsArr.length || ri > 0) {
      const btnMore = document.createElement('button');
      btnMore.className = 'gs-more-btn tbtn small';
      btnMore.textContent = `加载更多（剩余 ${resultsTotal() - renderedTotal} 条）`;
      btnMore.addEventListener('click', () => renderNextBatch(query));
      resultsEl.appendChild(btnMore);
    }
  }

  function resultsTotal() {
    return groupsArr.reduce((n, g) => n + g.rows.length, 0);
  }

  function buildHeader(g) {
    const header = document.createElement('div');
    header.className = 'gs-file';
    header.title = g.file;
    const name = document.createElement('span');
    name.textContent = baseName(g.file);
    const dir = document.createElement('span');
    dir.style.cssText = 'color:var(--mh-text-2);font-weight:400;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    dir.textContent = dirName(g.file);
    const badge = document.createElement('span');
    badge.className = 'gs-count-badge';
    badge.textContent = `${g.rows.length}`;
    header.append(name, dir, badge);
    header.addEventListener('click', () => onOpenFileAt(g.file, null, currentQuery()));
    return header;
  }

  function buildRow(g, r) {
    const row = document.createElement('div');
    row.className = 'find-result';
    const lineNo = document.createElement('span');
    lineNo.className = 'r-line';
    lineNo.textContent = r.line;
    const text = document.createElement('span');
    text.className = 'r-text';
    text.innerHTML = highlight(r.text, currentQuery());
    row.append(lineNo, text);
    row.addEventListener('click', () => onOpenFileAt(g.file, r.line, currentQuery()));
    return row;
  }

  let lastQuery = '';
  function currentQuery() {
    return lastQuery;
  }

  function highlight(text, q) {
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

  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) run();
  });

  return {
    run,
    focus: () => { input.focus(); input.select(); },
  };
}
