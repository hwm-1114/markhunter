// 多文档对比（v0.2.0 阶段三）：行级 + 词级双栏 diff 视图
// 依赖 jsdiff（diffLines 行级 / diffWords 词级内联高亮）。
// 设计：只读对比标签（kind='diff'）——左右双栏在单一滚动容器内（天然同步滚动）、
// 变更块 ↑↓ 导航、+N/−M 统计、交换左右、导出 Markdown 报告；
// 限制：单侧 ≤20MB；渲染行数分批（首批 2 万行 + 加载更多）；词级高亮仅对 <2000 字符的行。
//
// v0.11.0 完善（用户需求）：
//   ① 忽略空白 / 忽略大小写 两个对比选项（默认关；打开后按行规范化再 diff，显示仍是原文）；
//   ② 折叠未改动的大段内容（变更前后各留 3 行上下文，中间「⋯ 展开 N 行未改动内容 ⋯」按钮）；
//   ③ 键盘导航：n / Shift+N 上下变更块、Enter 跳回右侧原文对应行（Shift+Enter 跳左侧）、Esc 关闭对比；
//   ④ 跳回原文：diff 标签携带 leftPath/rightPath（app.js 传入），可跳到对应源标签的对应行；
//   ⑤ 阅读体验：自动换行开关（默认开；关闭 = 长行横向滚动、不折行）。
import { diffLines, diffWords } from 'diff';
import { escapeHtml, formatSize } from './ui.js';

export const DIFF_MAX_BYTES = 20 * 1024 * 1024; // 单侧输入上限（jsdiff O(ND)，超出拒绝）
const RENDER_BATCH = 20000;                     // 首批渲染行数（后续「加载更多」每次追加）
const WORD_DIFF_MAX_CHARS = 2000;               // 超长行跳过词级高亮（只显示行级）
const DIFF_CONTEXT = 3;                         // v0.11.0：折叠未改动内容时，变更前后各保留的上下文行数

/** 对比用的行规范化（显示仍用原文）：忽略空白 / 忽略大小写。
 *  逐行规范化后按**原换行结构**拼回 ⇒ 行数不变，diff 的行号与原始文本一一对应。
 *  · ignoreWhitespace：行内连续空格/Tab 折叠为一个空格 + 去行首尾空白（缩进/对齐差异不算变更）
 *  · ignoreCase：统一小写（大小写差异不算变更） */
function normalizeForCompare(text, opts) {
  const ignoreWs = !!(opts && opts.ignoreWhitespace);
  const ignoreCase = !!(opts && opts.ignoreCase);
  if (!ignoreWs && !ignoreCase) return String(text);
  const parts = String(text).split('\n');
  const trailing = parts.length > 0 && parts[parts.length - 1] === '';
  if (trailing) parts.pop();
  const norm = (line) => {
    let t = line;
    if (ignoreWs) t = t.replace(/[ \t]+/g, ' ').trim();
    if (ignoreCase) t = t.toLowerCase();
    return t;
  };
  return parts.map(norm).join('\n') + (trailing ? '\n' : '');
}

/** 拆成「行数组」（与 computeDiffModel 原有的结尾换行语义一致：结尾 \n 产生的空尾不算一行） */
function splitAllLines(text) {
  const arr = String(text).split('\n');
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/** jsdiff 片段拆行（保留结尾换行语义，去掉行尾 \n） */
function splitLines(s) {
  const arr = s.length ? s.split('\n') : [];
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

/** 计算对齐的行级 diff 模型。
 *  jsdiff 输出 equal/removed/added 三类片段 → 连续的 removed+added 配对为「修改」行
 *  （行内词级高亮），剩余分别为删除/新增行。返回 { rows, stats:{add,del,mod}, blocks }：
 *  rows[i] = { type:'eq'|'del'|'add'|'mod', ln, rn, lt, rt, hl? }
 *  hl = { l:[{t,hl}], r:[{t,hl}] } 词级片段（hl=true 标记差异）。
 *  opts.ignoreWhitespace / opts.ignoreCase：v0.11.0 对比选项 —— **diff 用规范化文本，
 *  rows 里的 lt/rt 仍是原文**（行数/行号与原文完全一致）。忽略模式下不做词级高亮，
 *  避免把"本应忽略的空格/大小写差异"逐词标红（行级底色已经足够）。 */
export function computeDiffModel(left, right, opts = {}) {
  const parts = diffLines(normalizeForCompare(left, opts), normalizeForCompare(right, opts));
  const lAll = splitAllLines(left);
  const rAll = splitAllLines(right);
  const rows = [];
  let ln = 0; // 左侧行号
  let rn = 0; // 右侧行号
  const stats = { add: 0, del: 0, mod: 0 };
  const blocks = []; // 变更块起始行下标（导航用）
  const wordDiffs = !opts.ignoreWhitespace && !opts.ignoreCase;

  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const _ of splitLines(p.value)) {
        ln++; rn++;
        // 行号取自原文：忽略模式下两侧某行可能规范化后相等但原文不同（大小写/空白）——
        // 仍然显示各自的原文（equality 行不标红），用户能看清"对比时视为相同"的两行。
        rows.push({ type: 'eq', ln, rn, lt: lAll[ln - 1] ?? '', rt: rAll[rn - 1] ?? '' });
      }
      i++;
      continue;
    }
    // 变更块：连续 removed 组 + added 组
    blocks.push(rows.length);
    const ln0 = ln;
    const rn0 = rn;
    const dels = [];
    const adds = [];
    // v0.3.0：不能用 push(...spread) —— 单块超过 ~12.5 万行时 V8 参数上限触发
    // RangeError: Maximum call stack size exceeded（实测「空 ↔ 15 万行」直接抛错、
    // 对比区一片空白且标签栏不刷新）。逐行 push 无上限问题。
    while (i < parts.length && parts[i].removed) {
      for (const _ of splitLines(parts[i++].value)) { dels.push(lAll[ln] ?? ''); ln++; }
    }
    while (i < parts.length && parts[i].added) {
      for (const _ of splitLines(parts[i++].value)) { adds.push(rAll[rn] ?? ''); rn++; }
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      stats.mod++;
      const lt = dels[k];
      const rt = adds[k];
      let hl = null;
      if (wordDiffs && lt.length < WORD_DIFF_MAX_CHARS && rt.length < WORD_DIFF_MAX_CHARS && lt !== rt) {
        try {
          const wparts = diffWords(lt, rt);
          // 左侧显示被删词，右侧显示新增词（各自的 equal 部分共享）
          const lseg = wparts
            .filter((w) => !w.added)
            .map((w) => ({ t: w.value, hl: !!w.removed }));
          const rseg = wparts
            .filter((w) => !w.removed)
            .map((w) => ({ t: w.value, hl: !!w.added }));
          hl = { l: lseg, r: rseg };
        } catch {
          hl = null; // 词级失败退化为行级
        }
      }
      rows.push({ type: 'mod', ln: ln0 + k + 1, rn: rn0 + k + 1, lt, rt, hl });
    }
    for (let k = pairs; k < dels.length; k++) {
      stats.del++;
      rows.push({ type: 'del', ln: ln0 + k + 1, rn: adds.length ? rn0 + pairs : null, lt: dels[k], rt: '' });
    }
    for (let k = pairs; k < adds.length; k++) {
      stats.add++;
      rows.push({ type: 'add', ln: dels.length ? ln0 + pairs : null, rn: rn0 + k + 1, lt: '', rt: adds[k] });
    }
  }
  return { rows, stats, blocks };
}

/** 单元格文本显示截断：超长行只渲染前段 + 长度提示（防 20MB 级单行卡死渲染线程） */
const CELL_MAX_CHARS = 4000;
function cellText(t) {
  if (t.length <= CELL_MAX_CHARS) return t;
  return t.slice(0, CELL_MAX_CHARS) + ` …（该行共 ${t.length.toLocaleString('zh-CN')} 字符，已截断显示）`;
}

/** 词级片段转 HTML（hl=true 的片段加高亮 span） */
function segHtml(segs) {
  if (!segs) return null;
  return segs.map((s) => (s.hl ? `<span class="dw-hl">${escapeHtml(s.t)}</span>` : escapeHtml(s.t))).join('');
}

/** 渲染一个 diff 行（左右两个单元格 + 行号列） */
function rowEl(row) {
  const el = document.createElement('div');
  el.className = 'diff-row ' + row.type;
  const lno = document.createElement('span');
  lno.className = 'diff-no';
  lno.textContent = row.ln || '';
  const ltx = document.createElement('span');
  ltx.className = 'diff-cell diff-l';
  ltx.innerHTML = row.hl ? segHtml(row.hl.l) : escapeHtml(cellText(row.lt));
  const rno = document.createElement('span');
  rno.className = 'diff-no';
  rno.textContent = row.rn || '';
  const rtx = document.createElement('span');
  rtx.className = 'diff-cell diff-r';
  rtx.innerHTML = row.hl ? segHtml(row.hl.r) : escapeHtml(cellText(row.rt));
  el.append(lno, ltx, rno, rtx);
  return el;
}

/** 对比计算失败兜底：显示可读错误而不是留一片空白 */
function renderDiffError(host, err) {
  const div = document.createElement('div');
  div.className = 'diff-truncated diff-error';
  div.textContent = '对比失败：' + (err && err.message ? err.message : String(err));
  host.appendChild(div);
  console.error('[diff] 计算失败:', err);
}

/** 把 diff 标签渲染进 host：工具栏（标签/统计/导航/交换/导出）+ 双栏滚动区。
 *  tab: { kind:'diff', leftLabel, rightLabel, leftContent, rightContent, scrollTop } */
export function renderDiffTab(tab, host, callbacks = {}) {
  host.innerHTML = '';
  // v0.2.1：超限截断对比（替换硬拒绝）—— 左右各保留前 DIFF_MAX_BYTES，醒目横幅提示
  let lc = tab.leftContent;
  let rc = tab.rightContent;
  let truncated = false;
  if (lc.length > DIFF_MAX_BYTES) {
    lc = lc.slice(0, DIFF_MAX_BYTES);
    truncated = true;
  }
  if (rc.length > DIFF_MAX_BYTES) {
    rc = rc.slice(0, DIFF_MAX_BYTES);
    truncated = true;
  }
  tab._leftUsed = lc;
  tab._rightUsed = rc;
  if (truncated) {
    const banner = document.createElement('div');
    banner.className = 'diff-truncated diff-trunc-banner';
    banner.textContent = `⚠ 内容超出 ${formatSize(DIFF_MAX_BYTES)}（左 ${formatSize(tab.leftContent.length)} / 右 ${formatSize(tab.rightContent.length)}），已截断仅对比前 ${formatSize(DIFF_MAX_BYTES)} —— 截断点之后的差异不在本视图中`;
    host.appendChild(banner);
  }
  if (tab.three) {
    try {
      renderThreeDiff(tab, host, callbacks);
    } catch (err) {
      renderDiffError(host, err);
    }
    return;
  }

  // v0.11.0：对比选项挂在 tab 上（重渲染/切标签后保留）：忽略空白 / 忽略大小写 / 自动换行
  const opts = tab.diffOpts && typeof tab.diffOpts === 'object' ? tab.diffOpts : (tab.diffOpts = {});
  if (typeof opts.ignoreWhitespace !== 'boolean') opts.ignoreWhitespace = false;
  if (typeof opts.ignoreCase !== 'boolean') opts.ignoreCase = false;
  if (typeof opts.wrap !== 'boolean') opts.wrap = true;

  let model;
  try {
    // v0.11.0：忽略空白/大小写在此生效（diff 用规范化文本，显示仍是原文，行号不变）
    model = computeDiffModel(lc, rc, opts);
  } catch (err) {
    // 计算失败（超大块、内存不足等）：给出可读提示，避免对比区空白 + switchTab 后续流程被异常打断
    renderDiffError(host, err);
    return;
  }
  tab._model = model; // 冒烟断言用

  // —— 工具栏（v0.11.0 增加：忽略空白 / 忽略大小写 / 自动换行 / 跳回原文）——
  const bar = document.createElement('div');
  bar.className = 'diff-bar';
  let scroller = null; // 先声明：选项开关的 rerender 需要读当前滚动位置（闭包捕获同一变量）
  const rerender = () => {
    tab.scrollTop = scroller ? scroller.scrollTop : 0;
    renderDiffTab(tab, host, callbacks);
  };
  const llabel = document.createElement('span');
  llabel.className = 'diff-label';
  llabel.textContent = '◀ ' + tab.leftLabel;
  llabel.title = tab.leftLabel;
  const stats = document.createElement('span');
  stats.className = 'diff-stats';
  stats.innerHTML = `<span class="ds-add">+${model.stats.add}</span> <span class="ds-del">−${model.stats.del}</span> <span class="ds-mod">~${model.stats.mod}</span> 行（共 ${model.blocks.length} 处变更）`;
  const mkBtn = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbtn small';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const curBadge = document.createElement('span');
  curBadge.className = 'diff-cur';
  let blockIdx = -1;
  let selectedIndex = -1; // 当前选中的行下标（键盘 Enter 跳回原文的锚点；点行/导航都会更新）
  const showCur = () => {
    curBadge.textContent = model.blocks.length ? `${blockIdx < 0 ? 0 : blockIdx + 1}/${model.blocks.length}` : '0/0';
  };
  const gotoBlock = (dir) => {
    if (!model.blocks.length) return;
    blockIdx = ((blockIdx + dir) % model.blocks.length + model.blocks.length) % model.blocks.length;
    showCur();
    const target = model.blocks[blockIdx];
    const row = revealRow(target);
    if (row) {
      scroller.querySelectorAll('.diff-row.current').forEach((r) => r.classList.remove('current'));
      row.classList.add('current');
      selectedIndex = target;
      row.scrollIntoView({ block: 'center' });
      try { scroller.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    }
  };
  /** 选项开关（active 类 = 当前开启；点击后按需重渲染） */
  const mkToggle = (label, title, isOn, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbtn small diff-toggle' + (isOn() ? ' active' : '');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      onClick();
      b.classList.toggle('active', isOn());
    });
    return b;
  };
  const ignoreWsBtn = mkToggle('空白', '忽略空白差异（连续空格/Tab、行首尾空白不算变更）',
    () => opts.ignoreWhitespace, () => { opts.ignoreWhitespace = !opts.ignoreWhitespace; rerender(); });
  const ignoreCaseBtn = mkToggle('大小写', '忽略大小写差异',
    () => opts.ignoreCase, () => { opts.ignoreCase = !opts.ignoreCase; rerender(); });
  const wrapBtn = mkToggle('自动换行', '自动换行（关闭后长行横向滚动，不折行）',
    () => opts.wrap, () => {
      opts.wrap = !opts.wrap;
      if (scroller) scroller.classList.toggle('diff-nowrap', opts.wrap === false);
    });
  /** 跳回原文按钮：diff 标签只有携带了对应侧路径才可用（剪贴板/手输内容不可跳） */
  const jumpBtn = (side) => {
    const has = !!(side === 'left' ? tab.leftPath : tab.rightPath);
    const b = mkBtn(side === 'left' ? '↩ 左原文' : '右原文 ↪',
      `跳到${side === 'left' ? '左' : '右'}侧原文对应行（键盘：Shift+Enter / Enter）`,
      () => jumpTo(side));
    if (!has) b.disabled = true;
    return b;
  };
  bar.append(
    llabel,
    mkBtn('↑ 上一处', '跳到上一处变更', () => gotoBlock(-1)),
    curBadge,
    mkBtn('↓ 下一处', '跳到下一处变更', () => gotoBlock(+1)),
    stats,
    ignoreWsBtn,
    ignoreCaseBtn,
    wrapBtn,
    jumpBtn('left'),
    jumpBtn('right'),
    mkBtn('⇄ 交换左右', '交换两侧内容重新对比', () => callbacks.onSwap && callbacks.onSwap()),
    mkBtn('📤 导出报告', '把对比结果导出为 Markdown 文件', () => callbacks.onExport && callbacks.onExport())
  );
  const rlabel = document.createElement('span');
  rlabel.className = 'diff-label';
  rlabel.textContent = tab.rightLabel + ' ▶';
  rlabel.title = tab.rightLabel;
  rlabel.style.marginLeft = 'auto';
  bar.appendChild(rlabel);
  showCur();
  host.appendChild(bar);

  // —— 双栏滚动区（单容器 = 天然同步滚动）——
  scroller = document.createElement('div');
  scroller.className = 'diff-scroller' + (opts.wrap === false ? ' diff-nowrap' : '');
  scroller.tabIndex = 0; // 键盘导航（n / Shift+N / Enter / Esc）需要可聚焦容器
  scroller.title = '快捷键：n / Shift+N 上下变更 · Enter 跳回右侧原文 · Shift+Enter 左侧 · Esc 关闭对比';
  const head = document.createElement('div');
  head.className = 'diff-row diff-head';
  head.innerHTML = `<span class="diff-no"></span><span class="diff-cell">左侧（${escapeHtml(tab.leftLabel)}）</span><span class="diff-no"></span><span class="diff-cell">右侧（${escapeHtml(tab.rightLabel)}）</span>`;
  scroller.appendChild(head);
  host.appendChild(scroller);

  // ==== v0.11.0：未改动内容折叠（变更前后各留 DIFF_CONTEXT 行上下文） ====
  // items = 渲染单元序列：{k:'row',i} 逐行 / {k:'fold',from,to} 折叠段。
  // 折叠只影响 DOM 渲染，不改变 model（导航/导出/统计用的仍是完整 rows）。
  const items = [];
  for (let i = 0; i < model.rows.length;) {
    if (model.rows[i].type !== 'eq') {
      items.push({ k: 'row', i });
      i++;
      continue;
    }
    let j = i;
    while (j < model.rows.length && model.rows[j].type === 'eq') j++;
    const run = j - i;
    if (run <= DIFF_CONTEXT * 2 + 1) {
      for (let k = i; k < j; k++) items.push({ k: 'row', i: k });
    } else {
      for (let k = i; k < i + DIFF_CONTEXT; k++) items.push({ k: 'row', i: k });
      items.push({ k: 'fold', from: i + DIFF_CONTEXT, to: j - DIFF_CONTEXT });
      for (let k = j - DIFF_CONTEXT; k < j; k++) items.push({ k: 'row', i: k });
    }
    i = j;
  }
  let itemCursor = 0;
  let moreBtn = null;
  const makeRow = (idx) => {
    const el = rowEl(model.rows[idx]);
    el.dataset.i = String(idx);
    return el;
  };
  /** 展开一个折叠段：把它的行就地插回 DOM（替换折叠按钮） */
  const expandFold = (foldEl) => {
    const from = Number(foldEl.dataset.from);
    const to = Number(foldEl.dataset.to);
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.appendChild(makeRow(i));
    foldEl.replaceWith(frag);
  };
  const makeFold = (from, to) => {
    const el = document.createElement('div');
    el.className = 'diff-fold';
    el.dataset.from = String(from);
    el.dataset.to = String(to);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tbtn small';
    btn.textContent = `⋯ 展开 ${to - from} 行未改动内容 ⋯`;
    btn.addEventListener('click', () => expandFold(el));
    el.appendChild(btn);
    return el;
  };
  /** 分批渲染渲染单元（首批 RENDER_BATCH 个）；返回是否还有剩余 */
  const renderItems = (budget) => {
    const frag = document.createDocumentFragment();
    let n = 0;
    while (itemCursor < items.length && n < budget) {
      const it = items[itemCursor++];
      frag.appendChild(it.k === 'row' ? makeRow(it.i) : makeFold(it.from, it.to));
      n++;
    }
    if (moreBtn) scroller.insertBefore(frag, moreBtn);
    else scroller.appendChild(frag);
    if (itemCursor >= items.length && moreBtn) {
      moreBtn.remove();
      moreBtn = null;
    }
    if (moreBtn) moreBtn.textContent = `加载更多（已渲染 ${itemCursor} / ${items.length} 段）`;
    return itemCursor < items.length;
  };
  if (renderItems(RENDER_BATCH)) {
    moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'tbtn small diff-more';
    moreBtn.textContent = `加载更多（已渲染 ${itemCursor} / ${items.length} 段）`;
    moreBtn.addEventListener('click', () => renderItems(RENDER_BATCH));
    scroller.appendChild(moreBtn);
  }

  /** 取到某 model 行对应的 DOM：已渲染 → 直接返回；在折叠段里 → 先展开；还没渲染（分批）→ 继续渲染 */
  const revealRow = (i) => {
    let el = scroller.querySelector(`[data-i="${i}"]`);
    let guard = 0;
    while (!el && itemCursor < items.length && guard++ < 5000) {
      renderItems(RENDER_BATCH);
      el = scroller.querySelector(`[data-i="${i}"]`);
    }
    if (el) return el;
    const fold = Array.from(scroller.querySelectorAll('.diff-fold')).find((f) => i >= Number(f.dataset.from) && i < Number(f.dataset.to));
    if (!fold) return null;
    expandFold(fold);
    return scroller.querySelector(`[data-i="${i}"]`);
  };

  /** 跳回某侧原文对应行（需要 openDiffTab 调用方提供 leftPath/rightPath） */
  const jumpTo = (side) => {
    if (typeof callbacks.onJumpSource !== 'function') return false;
    const i = selectedIndex >= 0 ? selectedIndex : (model.blocks.length ? model.blocks[0] : -1);
    if (i < 0) return false;
    const row = model.rows[i];
    if (!row) return false;
    const path = side === 'left' ? tab.leftPath : tab.rightPath;
    const line = side === 'left' ? row.ln : row.rn;
    if (!path || !line) return false;
    callbacks.onJumpSource({ side, line, path, label: side === 'left' ? tab.leftLabel : tab.rightLabel });
    return true;
  };

  // 点行 = 选中（键盘 Enter 的锚点）；点/导航时把焦点收到滚动区，键盘快捷键才生效
  scroller.addEventListener('mousedown', () => { try { scroller.focus({ preventScroll: true }); } catch { /* 忽略 */ } });
  scroller.addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.diff-row[data-i]') : null;
    if (!row) return;
    selectedIndex = Number(row.dataset.i);
    scroller.querySelectorAll('.diff-row.current').forEach((r) => r.classList.remove('current'));
    row.classList.add('current');
  });
  // v0.11.0 键盘导航：n / Shift+N 上下变更块；Enter 跳回右侧原文、Shift+Enter 左侧；Esc 关闭对比标签。
  // 事件在滚动区内消费并 stopPropagation —— 不会触发应用级快捷键（Esc 收起底部面板等）。
  scroller.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'n' || k === 'N') {
      e.preventDefault();
      e.stopPropagation();
      gotoBlock(e.shiftKey ? -1 : 1);
      try { scroller.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    } else if (k === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      jumpTo(e.shiftKey ? 'left' : 'right');
    } else if (k === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (typeof callbacks.onClose === 'function') callbacks.onClose();
    }
  });

  // 恢复滚动位置（多帧，与标签滚动记忆一致）
  const target = typeof tab.scrollTop === 'number' ? tab.scrollTop : 0;
  const restore = (n) => {
    scroller.scrollTop = target;
    if (n > 0) requestAnimationFrame(() => restore(n - 1));
  };
  restore(4);
}

/** 导出 Markdown 对比报告（unified diff 风格代码块） */
export function buildDiffReport(tab) {
  const model = tab._model || computeDiffModel(tab._leftUsed ?? tab.leftContent, tab._rightUsed ?? tab.rightContent, tab.diffOpts || {});
  const do_ = tab.diffOpts || {};
  const optText = [];
  if (do_.ignoreWhitespace) optText.push('忽略空白');
  if (do_.ignoreCase) optText.push('忽略大小写');
  const lines = [
    `# 对比报告：${tab.leftLabel} ↔ ${tab.rightLabel}`,
    '',
    `- 统计：+${model.stats.add} 行新增，−${model.stats.del} 行删除，~${model.stats.mod} 行修改（${model.blocks.length} 处变更）`,
    `- 对比选项：${optText.length ? optText.join(' / ') : '无（逐字符严格对比）'}`,
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '```diff',
  ];
  for (const r of model.rows) {
    if (r.type === 'eq') lines.push('  ' + r.lt);
    else if (r.type === 'del') lines.push('- ' + r.lt);
    else if (r.type === 'add') lines.push('+ ' + r.rt);
    else lines.push('~ ' + r.rt + '    （原：' + r.lt + '）');
  }
  lines.push('```');
  return lines.join('\n');
}

// ============================================================
// v0.2.1 三方对比（基准 base / 本方 ours / 对方 theirs）：三栏只读视图
// 左右两栏各自与基准做行级 diff，按基准行号对齐合并成三栏行；
// 「双方均改动且不同」的行以 both 高亮（潜在冲突行）。合并/冲突解决编辑不在本视图范围。
// ============================================================

/** 把一侧与基准的 diff 模型折叠为按基准行号的映射（附加行挂在上一基准行） */
function foldByBase(model) {
  const map = new Map(); // baseLine -> { text, type }（type: same|mod|del|add）
  let lastBase = 0;
  for (const r of model.rows) {
    if (r.type === 'eq') {
      map.set(r.ln, { text: r.rt, type: 'same' });
      lastBase = r.ln;
    } else if (r.type === 'mod') {
      map.set(r.ln, { text: r.rt, type: 'mod' });
      lastBase = r.ln;
    } else if (r.type === 'del') {
      map.set(r.ln, { text: '', type: 'del' });
      lastBase = r.ln;
    } else {
      // add：无基准行号 → 挂到上一基准行（附加段）
      const prev = map.get(lastBase) || { text: '', type: lastBase === 0 ? 'add' : 'same' };
      const arr = prev.extra || (prev.extra = []);
      arr.push(r.rt);
      map.set(lastBase, prev);
    }
  }
  return map;
}

function renderThreeDiff(tab, host, callbacks) {
  const opts = tab.diffOpts && typeof tab.diffOpts === 'object' ? tab.diffOpts : (tab.diffOpts = {});
  if (typeof opts.ignoreWhitespace !== 'boolean') opts.ignoreWhitespace = false;
  if (typeof opts.ignoreCase !== 'boolean') opts.ignoreCase = false;
  if (typeof opts.wrap !== 'boolean') opts.wrap = true;
  const base = tab._leftUsed ?? tab.leftContent; // 复用截断变量：三方模式下 base 存于 leftContent
  const ours = tab._midUsed ?? tab.midContent;
  const theirs = tab._rightUsed ?? tab.rightContent;
  // 三方各自截断
  let b = base, o = ours, t = theirs;
  if (b.length > DIFF_MAX_BYTES) b = b.slice(0, DIFF_MAX_BYTES);
  if (o.length > DIFF_MAX_BYTES) o = o.slice(0, DIFF_MAX_BYTES);
  if (t.length > DIFF_MAX_BYTES) t = t.slice(0, DIFF_MAX_BYTES);
  tab._midUsed = o;

  const m1 = computeDiffModel(b, o, opts); // 基准 ↔ 本方（v0.11.0：忽略选项同样生效）
  const m2 = computeDiffModel(b, t, opts); // 基准 ↔ 对方
  const f1 = foldByBase(m1);
  const f2 = foldByBase(m2);
  const baseLines = b.length ? b.split('\n') : [];
  if (baseLines.length && baseLines[baseLines.length - 1] === '') baseLines.pop();

  const stats = { oursAdd: m1.stats.add, oursMod: m1.stats.mod + m1.stats.del, theirsAdd: m2.stats.add, theirsMod: m2.stats.mod + m2.stats.del, both: 0 };
  const rows = [];
  const blocks = [];
  for (let i = 1; i <= baseLines.length; i++) {
    const s1 = f1.get(i);
    const s2 = f2.get(i);
    const t1 = s1 ? s1.type : 'same';
    const t2 = s2 ? s2.type : 'same';
    const both = (t1 === 'mod' || t1 === 'del') && (t2 === 'mod' || t2 === 'del') &&
      ((s1.text || '') !== (s2.text || ''));
    if (both) stats.both++;
    const changed = t1 !== 'same' || t2 !== 'same' || !!(s1 && s1.extra) || !!(s2 && s2.extra);
    if (changed) blocks.push(rows.length);
    rows.push({
      bn: i,
      bt: baseLines[i - 1],
      o: { text: s1 ? s1.text : baseLines[i - 1], type: t1, extra: s1 && s1.extra },
      t: { text: s2 ? s2.text : baseLines[i - 1], type: t2, extra: s2 && s2.extra },
      both,
    });
  }
  tab._model = { rows, stats, blocks }; // 导出/状态栏复用（结构兼容：rows/stats/blocks）

  // —— 工具栏 ——
  const bar = document.createElement('div');
  bar.className = 'diff-bar';
  const lblB = document.createElement('span');
  lblB.className = 'diff-label';
  lblB.textContent = '▣ 基准：' + tab.leftLabel;
  lblB.title = tab.leftLabel;
  const st = document.createElement('span');
  st.className = 'diff-stats';
  st.innerHTML = `本方 <span class="ds-add">+${stats.oursAdd}</span>/<span class="ds-mod">~${stats.oursMod}</span>` +
    ` · 对方 <span class="ds-add">+${stats.theirsAdd}</span>/<span class="ds-mod">~${stats.theirsMod}</span>` +
    ` · <span class="ds-del">⚠ 双方改同行 ${stats.both}</span>`;
  const curBadge = document.createElement('span');
  curBadge.className = 'diff-cur';
  let blockIdx = -1;
  const showCur = () => {
    curBadge.textContent = blocks.length ? `${blockIdx < 0 ? 0 : blockIdx + 1}/${blocks.length}` : '0/0';
  };
  const mkBtn = (text, title, fn) => {
    const b2 = document.createElement('button');
    b2.className = 'tbtn small';
    b2.textContent = text;
    b2.title = title;
    b2.addEventListener('click', fn);
    return b2;
  };
  const scroller = document.createElement('div');
  scroller.className = 'diff-scroller' + (opts.wrap === false ? ' diff-nowrap' : '');
  scroller.tabIndex = 0;
  scroller.title = '快捷键：n / Shift+N 上下变更块 · Esc 关闭对比';
  scroller.addEventListener('keydown', (e) => {
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault(); e.stopPropagation(); gotoBlock(e.shiftKey ? -1 : 1); try { scroller.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (typeof callbacks.onClose === 'function') callbacks.onClose();
    }
  });
  // v0.11.0：三方对比同样支持「忽略空白 / 忽略大小写 / 自动换行」（重渲染走同一个渲染入口）
  const rerender3 = () => {
    tab.scrollTop = scroller.scrollTop;
    renderDiffTab(tab, host, callbacks);
  };
  const mkToggle3 = (label, title, isOn, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tbtn small diff-toggle' + (isOn() ? ' active' : '');
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', () => { onClick(); btn.classList.toggle('active', isOn()); });
    return btn;
  };
  const ignoreWsBtn3 = mkToggle3('空白', '忽略空白差异（三方对比同样生效）',
    () => opts.ignoreWhitespace, () => { opts.ignoreWhitespace = !opts.ignoreWhitespace; rerender3(); });
  const ignoreCaseBtn3 = mkToggle3('大小写', '忽略大小写差异（三方对比同样生效）',
    () => opts.ignoreCase, () => { opts.ignoreCase = !opts.ignoreCase; rerender3(); });
  const wrapBtn3 = mkToggle3('自动换行', '自动换行（关闭后长行横向滚动）',
    () => opts.wrap, () => { opts.wrap = !opts.wrap; scroller.classList.toggle('diff-nowrap', opts.wrap === false); });
  const gotoBlock = (dir) => {
    if (!blocks.length) return;
    blockIdx = ((blockIdx + dir) % blocks.length + blocks.length) % blocks.length;
    showCur();
    const row = scroller.querySelector(`[data-i="${blocks[blockIdx]}"]`);
    if (row) {
      scroller.querySelectorAll('.diff3-row.current').forEach((r) => r.classList.remove('current'));
      row.classList.add('current');
      row.scrollIntoView({ block: 'center' });
    }
  };
  bar.append(
    lblB,
    mkBtn('↑ 上一处', '跳到上一处变更', () => gotoBlock(-1)),
    curBadge,
    mkBtn('↓ 下一处', '跳到下一处变更', () => gotoBlock(+1)),
    st,
    ignoreWsBtn3,
    ignoreCaseBtn3,
    wrapBtn3,
    mkBtn('⇄ 交换本方/对方', '交换左右两侧重新对比', () => {
      const m = tab.midContent, ml = tab.midLabel;
      tab.midContent = tab.rightContent;
      tab.midLabel = tab.rightLabel;
      tab.rightContent = m;
      tab.rightLabel = ml;
      tab.scrollTop = 0;
      renderDiffTab(tab, host, callbacks);
    }),
    mkBtn('📤 导出报告', '导出三方对比 Markdown 报告', () => callbacks.onExport && callbacks.onExport())
  );
  const lblO = document.createElement('span');
  lblO.className = 'diff-label';
  lblO.textContent = '◀ 本方：' + tab.midLabel;
  const lblT = document.createElement('span');
  lblT.className = 'diff-label';
  lblT.textContent = '对方：' + tab.rightLabel + ' ▶';
  lblT.style.marginLeft = 'auto';
  bar.append(lblO, lblT);
  showCur();
  host.appendChild(bar);

  // —— 三栏滚动区 ——
  const head = document.createElement('div');
  head.className = 'diff3-row diff-head';
  head.innerHTML = `<span class="diff-no"></span><span class="diff-cell">基准（${escapeHtml(tab.leftLabel)}）</span>` +
    `<span class="diff-no"></span><span class="diff-cell">本方（${escapeHtml(tab.midLabel)}）</span>` +
    `<span class="diff-no"></span><span class="diff-cell">对方（${escapeHtml(tab.rightLabel)}）</span>`;
  scroller.appendChild(head);
  host.appendChild(scroller);

  const RENDER3_BATCH = RENDER_BATCH;
  const renderRange = (from, to) => {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to && i < rows.length; i++) {
      const r = rows[i];
      const el = document.createElement('div');
      el.className = 'diff3-row ' + (r.both ? 'both' : '');
      el.dataset.i = i;
      const mk = (no, text, cls) => {
        const n = document.createElement('span');
        n.className = 'diff-no';
        n.textContent = no || '';
        const c = document.createElement('span');
        c.className = 'diff-cell ' + cls;
        c.textContent = cellText(text);
        el.append(n, c);
      };
      mk(r.bn, r.bt, 'diff-b');
      mk(r.bn, r.o.text, 'diff-l ' + r.o.type);
      mk(r.bn, r.t.text, 'diff-r ' + r.t.type);
      frag.appendChild(el);
      // 附加行（两侧新增且无基准行号）：紧跟锚点行的独立行
      const oEx = (r.o && r.o.extra) || [];
      const tEx = (r.t && r.t.extra) || [];
      const n = Math.max(oEx.length, tEx.length);
      for (let k = 0; k < n; k++) {
        const er = document.createElement('div');
        er.className = 'diff3-row add';
        const mk2 = (text, cls) => {
          const sn = document.createElement('span');
          sn.className = 'diff-no';
          const sc = document.createElement('span');
          sc.className = 'diff-cell ' + cls;
          sc.textContent = cellText(text);
          er.append(sn, sc);
        };
        mk2('', 'diff-b');
        mk2(oEx[k] !== undefined ? oEx[k] : '', 'diff-l' + (oEx[k] !== undefined ? ' add' : ''));
        mk2(tEx[k] !== undefined ? tEx[k] : '', 'diff-r' + (tEx[k] !== undefined ? ' add' : ''));
        frag.appendChild(er);
      }
    }
    return frag;
  };
  let rendered = Math.min(RENDER3_BATCH, rows.length);
  scroller.appendChild(renderRange(0, rendered));
  if (rendered < rows.length) {
    const more = document.createElement('button');
    more.className = 'tbtn small diff-more';
    more.textContent = `加载更多（已渲染 ${rendered} / ${rows.length} 行）`;
    more.addEventListener('click', () => {
      const next = Math.min(rendered + RENDER3_BATCH, rows.length);
      scroller.insertBefore(renderRange(rendered, next), more);
      rendered = next;
      if (rendered >= rows.length) more.remove();
      else more.textContent = `加载更多（已渲染 ${rendered} / ${rows.length} 行）`;
    });
    scroller.appendChild(more);
  }

  const target = typeof tab.scrollTop === 'number' ? tab.scrollTop : 0;
  const restore = (n) => {
    scroller.scrollTop = target;
    if (n > 0) requestAnimationFrame(() => restore(n - 1));
  };
  restore(4);
}
