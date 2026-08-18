// 全局搜索：跨文件搜索，结果按文件分组展示
import { $, escapeHtml, dirName, baseName } from './ui.js';

export function createGlobalSearch(getRootDir, onOpenFileAt) {
  const input = $('#gs-input');
  const count = $('#gs-count');
  const resultsEl = $('#gs-results');
  const btn = $('#btn-gs-go');

  let running = false;

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
    if (running) return;
    running = true;
    btn.disabled = true;
    btn.textContent = '搜索中…';
    resultsEl.innerHTML = '<div class="find-empty">搜索中…</div>';
    try {
      const results = await window.api.globalSearch(root, query);
      renderResults(results, query);
      count.textContent = results.length >= 3000 ? '结果过多，已截断' : `${results.length} 处匹配`;
    } catch (err) {
      resultsEl.innerHTML = `<div class="find-empty">搜索失败：${escapeHtml(err.message || err)}</div>`;
    } finally {
      running = false;
      btn.disabled = false;
      btn.textContent = '搜索';
    }
  }

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
    const frag = document.createDocumentFragment();
    for (const [file, rows] of groups) {
      const group = document.createElement('div');
      group.className = 'gs-group';

      const header = document.createElement('div');
      header.className = 'gs-file';
      header.title = file;
      const name = document.createElement('span');
      name.textContent = baseName(file);
      const dir = document.createElement('span');
      dir.style.cssText = 'color:var(--mh-text-2);font-weight:400;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      dir.textContent = dirName(file);
      const badge = document.createElement('span');
      badge.className = 'gs-count-badge';
      badge.textContent = `${rows.length}`;
      header.append(name, dir, badge);
      header.addEventListener('click', () => onOpenFileAt(file, null, query));
      group.appendChild(header);

      for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'find-result';
        const lineNo = document.createElement('span');
        lineNo.className = 'r-line';
        lineNo.textContent = r.line;
        const text = document.createElement('span');
        text.className = 'r-text';
        text.innerHTML = highlight(r.text, query);
        row.append(lineNo, text);
        row.addEventListener('click', () => onOpenFileAt(file, r.line, query));
        group.appendChild(row);
      }
      frag.appendChild(group);
    }
    resultsEl.appendChild(frag);
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
    if (e.key === 'Enter') run();
  });

  return {
    run,
    focus: () => { input.focus(); input.select(); },
  };
}
