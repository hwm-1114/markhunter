// 全局搜索：跨文件搜索（结果按文件分组展示）+ 批量替换
// P6（v0.1.45）：① 搜索逻辑在主进程 utilityProcess worker 执行（不阻塞主进程事件循环）；
//   ② 结果分批渲染（首 200 条 + 「加载更多」按钮），不再一次性建 3000 行 DOM；
//   ③ 搜索中按钮变为「取消」，可随时中止（search:cancel）。
// v0.1.47：新增「全部替换」—— 对当前搜索结果涉及的文件整文大小写不敏感替换（带确认，替换后自动重搜）。
import { $, escapeHtml, dirName, baseName, confirmDialog, toast } from './ui.js';

const RENDER_BATCH = 200; // 每批渲染的结果行数（P6：分批注入 DOM）

export function createGlobalSearch(getRootDir, onOpenFileAt) {
  const input = $('#gs-input');
  const replaceInput = $('#gs-replace-input');
  const count = $('#gs-count');
  const resultsEl = $('#gs-results');
  const btn = $('#btn-gs-go');
  const btnRepAll = $('#btn-gs-replace-all');

  let running = false;
  let replacing = false;
  let offProgress = null;
  // 分批渲染状态（P6）
  let groupsArr = [];  // [{ file, rows }] 按文件分组的有序数组
  let lastResults = []; // 最近一次搜索的原始结果（全局替换取文件清单用；受 3000 上限约束）
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
    lastResults = results;
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

  // ---------- 全局批量替换（v0.1.47） ----------
  /** 大小写不敏感整文替换：返回 [新文本, 替换处数] */
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

  /** 对当前搜索结果涉及的文件批量替换（每文件替换全部匹配，不限于结果列表行数）。
   *  force=true 跳过确认（冒烟用）。注意：结果列表受 3000 条上限约束，超限时被截断
   *  排序在后的文件不在本次替换范围（提示语已注明）。 */
  async function replaceAll(force = false) {
    const q = currentQuery();
    if (replacing || running) return false;
    if (!q || lastResults.length === 0) {
      toast('请先搜索得到结果，再执行全部替换');
      return false;
    }
    const rep = replaceInput.value;
    const files = [];
    for (const r of lastResults) {
      if (!files.includes(r.file)) files.push(r.file);
    }
    const shown = resultsTotal();
    if (!force) {
      const ok = await confirmDialog(
        `将把「${q}」替换为「${rep}」\n\n涉及 ${files.length} 个文件、当前结果 ${shown} 处匹配` +
          `（每个文件内的全部匹配都会替换，非仅列表所示行）。\n文件将以 UTF-8 编码保存，此操作不可撤销。`,
        '全局替换确认'
      );
      if (!ok) return false;
    }
    replacing = true;
    if (btnRepAll) btnRepAll.disabled = true;
    let okFiles = 0;
    let total = 0;
    let failed = 0;
    try {
      for (const f of files) {
        try {
          const data = await window.api.readFile(f);
          const [out, n] = replaceAllInText(data.content, q, rep);
          if (n > 0 && out !== data.content) {
            await window.api.writeFile(f, out);
            okFiles++;
            total += n;
          }
        } catch (err) {
          failed++;
          console.warn('[gs-replace] 替换失败:', f, err && err.message ? err.message : err);
        }
      }
    } finally {
      replacing = false;
      if (btnRepAll) btnRepAll.disabled = false;
    }
    if (failed > 0) toast(`已替换 ${okFiles} 个文件（${total} 处），${failed} 个文件替换失败`);
    else toast(`已替换 ${okFiles} 个文件，共 ${total} 处`);
    await run(); // 重新搜索刷新结果（替换后通常 0 匹配）
    return true;
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
  if (btnRepAll) btnRepAll.addEventListener('click', () => replaceAll());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) run();
  });
  if (replaceInput) {
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) replaceAll();
    });
  }

  return {
    run,
    replaceAll,
    focus: () => { input.focus(); input.select(); },
  };
}
