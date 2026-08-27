// 多文档对比（v0.2.0 阶段三）：行级 + 词级双栏 diff 视图
// 依赖 jsdiff（diffLines 行级 / diffWords 词级内联高亮）。
// 设计：只读对比标签（kind='diff'）——左右双栏在单一滚动容器内（天然同步滚动）、
// 变更块 ↑↓ 导航、+N/−M 统计、交换左右、导出 Markdown 报告；
// 限制：单侧 ≤20MB；渲染行数分批（首批 2 万行 + 加载更多）；词级高亮仅对 <2000 字符的行。
import { diffLines, diffWords } from 'diff';
import { escapeHtml, formatSize } from './ui.js';

export const DIFF_MAX_BYTES = 20 * 1024 * 1024; // 单侧输入上限（jsdiff O(ND)，超出拒绝）
const RENDER_BATCH = 20000;                     // 首批渲染行数（后续「加载更多」每次追加）
const WORD_DIFF_MAX_CHARS = 2000;               // 超长行跳过词级高亮（只显示行级）

/** 计算对齐的行级 diff 模型。
 *  jsdiff 输出 equal/removed/added 三类片段 → 连续的 removed+added 配对为「修改」行
 *  （行内词级高亮），剩余分别为删除/新增行。返回 { rows, stats:{add,del,mod}, blocks }：
 *  rows[i] = { type:'eq'|'del'|'add'|'mod', ln, rn, lt, rt, hl? }
 *  hl = { l:[{t,hl}], r:[{t,hl}] } 词级片段（hl=true 标记差异）。 */
export function computeDiffModel(left, right) {
  const parts = diffLines(left, right);
  const rows = [];
  let ln = 0; // 左侧行号
  let rn = 0; // 右侧行号
  const stats = { add: 0, del: 0, mod: 0 };
  const blocks = []; // 变更块起始行下标（导航用）

  const splitLines = (s) => {
    // 与 jsdiff 片段一致：保留结尾换行语义，去掉行尾 \n
    const arr = s.length ? s.split('\n') : [];
    if (arr.length && arr[arr.length - 1] === '') arr.pop(); // 结尾换行产生的空尾
    return arr;
  };

  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (const line of splitLines(p.value)) {
        ln++; rn++;
        rows.push({ type: 'eq', ln, rn, lt: line, rt: line });
      }
      i++;
      continue;
    }
    // 变更块：连续 removed 组 + added 组
    blocks.push(rows.length);
    const dels = [];
    const adds = [];
    while (i < parts.length && parts[i].removed) dels.push(...splitLines(parts[i++].value));
    while (i < parts.length && parts[i].added) adds.push(...splitLines(parts[i++].value));
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      ln++; rn++;
      stats.mod++;
      const lt = dels[k];
      const rt = adds[k];
      let hl = null;
      if (lt.length < WORD_DIFF_MAX_CHARS && rt.length < WORD_DIFF_MAX_CHARS && lt !== rt) {
        try {
          const wparts = diffWords(lt, rt);
          const seg = (flag) =>
            wparts
              .filter((w) => !flag || w.added === flag || w.removed === flag)
              .map((w) => ({ t: w.value, hl: !!(w.added || w.removed) }));
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
      rows.push({ type: 'mod', ln, rn, lt, rt, hl });
    }
    for (let k = pairs; k < dels.length; k++) {
      ln++;
      stats.del++;
      rows.push({ type: 'del', ln, rn: adds.length ? rn : null, lt: dels[k], rt: '' });
    }
    for (let k = pairs; k < adds.length; k++) {
      rn++;
      stats.add++;
      rows.push({ type: 'add', ln: dels.length ? ln : null, rn, lt: '', rt: adds[k] });
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
    renderThreeDiff(tab, host, callbacks);
    return;
  }

  const model = computeDiffModel(lc, rc);
  tab._model = model; // 冒烟断言用

  // —— 工具栏 ——
  const bar = document.createElement('div');
  bar.className = 'diff-bar';
  const llabel = document.createElement('span');
  llabel.className = 'diff-label';
  llabel.textContent = '◀ ' + tab.leftLabel;
  llabel.title = tab.leftLabel;
  const stats = document.createElement('span');
  stats.className = 'diff-stats';
  stats.innerHTML = `<span class="ds-add">+${model.stats.add}</span> <span class="ds-del">−${model.stats.del}</span> <span class="ds-mod">~${model.stats.mod}</span> 行（共 ${model.blocks.length} 处变更）`;
  const mkBtn = (text, title, fn) => {
    const b = document.createElement('button');
    b.className = 'tbtn small';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const curBadge = document.createElement('span');
  curBadge.className = 'diff-cur';
  let blockIdx = -1;
  const showCur = () => {
    curBadge.textContent = model.blocks.length ? `${blockIdx < 0 ? 0 : blockIdx + 1}/${model.blocks.length}` : '0/0';
  };
  const gotoBlock = (dir) => {
    if (!model.blocks.length) return;
    blockIdx = ((blockIdx + dir) % model.blocks.length + model.blocks.length) % model.blocks.length;
    showCur();
    const row = scroller.querySelector(`[data-i="${model.blocks[blockIdx]}"]`);
    if (row) {
      scroller.querySelectorAll('.diff-row.current').forEach((r) => r.classList.remove('current'));
      row.classList.add('current');
      row.scrollIntoView({ block: 'center' });
    }
  };
  bar.append(
    llabel,
    mkBtn('↑ 上一处', '跳到上一处变更', () => gotoBlock(-1)),
    curBadge,
    mkBtn('↓ 下一处', '跳到下一处变更', () => gotoBlock(+1)),
    stats,
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
  const scroller = document.createElement('div');
  scroller.className = 'diff-scroller';
  const head = document.createElement('div');
  head.className = 'diff-row diff-head';
  head.innerHTML = `<span class="diff-no"></span><span class="diff-cell">左侧（${escapeHtml(tab.leftLabel)}）</span><span class="diff-no"></span><span class="diff-cell">右侧（${escapeHtml(tab.rightLabel)}）</span>`;
  scroller.appendChild(head);
  host.appendChild(scroller);

  // 分批渲染（首批 RENDER_BATCH 行，加载更多按钮）
  const renderRows = (from, to) => {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to && i < model.rows.length; i++) {
      const el = rowEl(model.rows[i]);
      el.dataset.i = i;
      frag.appendChild(el);
    }
    return frag;
  };
  let rendered = Math.min(RENDER_BATCH, model.rows.length);
  scroller.appendChild(renderRows(0, rendered));
  if (rendered < model.rows.length) {
    const more = document.createElement('button');
    more.className = 'tbtn small diff-more';
    more.textContent = `加载更多（已渲染 ${rendered} / ${model.rows.length} 行）`;
    more.addEventListener('click', () => {
      const next = Math.min(rendered + RENDER_BATCH, model.rows.length);
      scroller.insertBefore(renderRows(rendered, next), more);
      rendered = next;
      if (rendered >= model.rows.length) more.remove();
      else more.textContent = `加载更多（已渲染 ${rendered} / ${model.rows.length} 行）`;
    });
    scroller.appendChild(more);
  }
  if (model.rows.length > rendered) {
    const tip = document.createElement('div');
    tip.className = 'diff-truncated';
    tip.textContent = `行数较多，先渲染前 ${rendered} 行（点击「加载更多」继续）`;
    scroller.insertBefore(tip, scroller.lastChild);
  }

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
  const model = tab._model || computeDiffModel(tab._leftUsed ?? tab.leftContent, tab._rightUsed ?? tab.rightContent);
  const lines = [
    `# 对比报告：${tab.leftLabel} ↔ ${tab.rightLabel}`,
    '',
    `- 统计：+${model.stats.add} 行新增，−${model.stats.del} 行删除，~${model.stats.mod} 行修改（${model.blocks.length} 处变更）`,
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
  const base = tab._leftUsed ?? tab.leftContent; // 复用截断变量：三方模式下 base 存于 leftContent
  const ours = tab._midUsed ?? tab.midContent;
  const theirs = tab._rightUsed ?? tab.rightContent;
  // 三方各自截断
  let b = base, o = ours, t = theirs;
  if (b.length > DIFF_MAX_BYTES) b = b.slice(0, DIFF_MAX_BYTES);
  if (o.length > DIFF_MAX_BYTES) o = o.slice(0, DIFF_MAX_BYTES);
  if (t.length > DIFF_MAX_BYTES) t = t.slice(0, DIFF_MAX_BYTES);
  tab._midUsed = o;

  const m1 = computeDiffModel(b, o); // 基准 ↔ 本方
  const m2 = computeDiffModel(b, t); // 基准 ↔ 对方
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
  scroller.className = 'diff-scroller';
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
