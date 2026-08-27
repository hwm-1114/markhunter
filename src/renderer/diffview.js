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
  ltx.innerHTML = row.hl ? segHtml(row.hl.l) : escapeHtml(row.lt);
  const rno = document.createElement('span');
  rno.className = 'diff-no';
  rno.textContent = row.rn || '';
  const rtx = document.createElement('span');
  rtx.className = 'diff-cell diff-r';
  rtx.innerHTML = row.hl ? segHtml(row.hl.r) : escapeHtml(row.rt);
  el.append(lno, ltx, rno, rtx);
  return el;
}

/** 把 diff 标签渲染进 host：工具栏（标签/统计/导航/交换/导出）+ 双栏滚动区。
 *  tab: { kind:'diff', leftLabel, rightLabel, leftContent, rightContent, scrollTop } */
export function renderDiffTab(tab, host, callbacks = {}) {
  host.innerHTML = '';
  if (tab.leftContent.length > DIFF_MAX_BYTES || tab.rightContent.length > DIFF_MAX_BYTES) {
    const err = document.createElement('div');
    err.className = 'diff-truncated';
    err.textContent = `对比内容超出上限（单侧 ${formatSize(DIFF_MAX_BYTES)}）：左 ${formatSize(tab.leftContent.length)} / 右 ${formatSize(tab.rightContent.length)}。jsdiff 为 O(ND) 复杂度，超大内容不适用。`;
    host.appendChild(err);
    return;
  }

  const model = computeDiffModel(tab.leftContent, tab.rightContent);
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
  const model = tab._model || computeDiffModel(tab.leftContent, tab.rightContent);
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
