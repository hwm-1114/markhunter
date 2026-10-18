// 文件内查找与替换：底部面板展示全部匹配 + 编辑器高亮 + 替换当前/全部
//
// ============================================================================
// 0.5.0 Phase 5a 第 2 批（#10 G1 / #11 G2）—— 本文件本轮的改动面与硬口径
// ============================================================================
// G1（三开关 + huge 守卫 + ReDoS 防护）：
//   · `Aa` 区分大小写 / 「整词」/ `.*` 正则 三个开关（默认全部关闭 = 旧口径：不区分大小写的子串查找）；
//   · **无文档视图（huge / viewer-lg / image / diff）不再静默 0 命中** —— 明确提示
//     「当前视图不支持文件内查找」。0.5.0 只做「显式提示 + 禁止」（0.5.0 计划 §6 待决项 1 的倾向），
//     大文件区间查找留给后续版本；huge 视图的跳行仍有 Ctrl+G、跨文件查找仍有 Ctrl+Shift+F。
//   · 正则防 ReDoS 三层：① 模式长度上限 FIND_MAX_PATTERN；② 嵌套量词（形如 `(a+)+`）静态拒绝；
//     ③ **执行预算** FIND_BUDGET_MS —— 先在 FIND_PROBE_LINES 行上预检（FIND_PROBE_MS），超预算即中止，
//     全量扫描每 64 行/每处匹配也查一次预算，超时**显式提示**并保留已找到的部分。
// G2（上限 + 防抖，修 A14：2 万处 161ms 阻塞、外推 50 万处秒级卡死）：
//   · 展示上限 FIND_LIMIT：**截断必须显式提示**「仅显示前 N 处」（计数行 + 结果区尾部提示行）；
//   · CM 装饰数 = 展示匹配数 ⇒ 装饰同样被上限约束；
//   · 输入防抖 FIND_INPUT_DEBOUNCE_MS（只挂在 input 事件上；程序化 setQuery 与文档变化路径仍同步执行）。
//
// ── 兼容口径（既有用例 findAll / findDomReuse / findReplace / findUI / findNav 依赖）──────────
//   · `#find-count` 文本仍以「N 处匹配」开头；`#find-results .find-result` 行数仍 = 展示的匹配数
//     （截断提示行用 `.find-more`，不占 `.find-result` 计数）；
//   · runSearch / setQuery / clearSearch / replaceCurrent / replaceAll / focus / focusReplace 签名与语义不变；
//   · 大小写不敏感口径不变（默认关 Aa）；「全部替换」的替换处数与匹配口径不变。
//
// ── 顺带修正（审计「低级别清单」第 3 条）────────────────────────────────────────────────────
//   旧实现用 `text.toLowerCase().indexOf(...)` 取下标再回原串切片，遇到变长小写映射（如 `İ` U+0130）
//   会**错位**。本轮统一改走 RegExp 的 `exec`（`m.index` 是原串上的真实下标），
//   高亮与替换位置因此天然一致。默认口径（不区分大小写子串）的匹配结果与旧实现相同。
'use strict';
import { Decoration, EditorView } from '@codemirror/view';
import { $, escapeHtml, toast } from './ui.js';
import { matchEffect } from './tabs.js';

// ---------- G1/G2 的数值口径（改这里必须同步冒烟用例与施工文档） ----------
export const FIND_MAX_PATTERN = 200;        // 正则模式长度上限（字符）
export const FIND_BUDGET_MS = 120;          // 单次全量扫描的总执行预算（毫秒）
export const FIND_PROBE_MS = 30;            // 正则预检预算（毫秒）
export const FIND_PROBE_LINES = 200;        // 正则预检行数
export const FIND_LIMIT = 500;              // 匹配展示上限（超出显式提示「仅显示前 N 处」）
export const FIND_INPUT_DEBOUNCE_MS = 80;   // 输入防抖（A14）
const REPLACE_ALL_MAX = 50000;              // 「全部替换」的硬上限（超出中止并提示，绝不半替换）
const REPLACE_ALL_BUDGET_MS = 2000;         // 「全部替换」的全量扫描预算（显式动作，预算比输入路径宽）
const HIGHLIGHT_GUARD = 2000;               // 单行高亮的匹配数守卫（防病态模式在单行上打转）
/** 「整词」的词字符类（Unicode 属性：字母 / 数字 / 下划线）——中文按字算词字符 */
const WORD_CHAR = '\\p{L}\\p{N}_';
/** 嵌套量词启发式：`( … +/* … )` 后紧跟量词 —— 灾难性回溯的典型形状，直接拒绝（低误报） */
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*[*+{]/;
/** 无文档视图的显式提示文案（G1 的硬要求：不许静默 0 命中） */
const UNSUPPORTED_MSG = {
  huge: '当前视图不支持文件内查找（大文件视图）—— 可用 Ctrl+G 跳行、Ctrl+Shift+F 跨文件搜索',
  'viewer-lg': '当前视图不支持文件内查找（大文件查看器窗口）—— 可用 Ctrl+Shift+F 跨文件搜索',
  image: '当前视图不支持文件内查找（图片视图）',
  diff: '当前视图不支持文件内查找（对比视图）',
};

export function createFind(getEditor, getTab) {
  const input = $('#find-input');
  const replaceInput = $('#replace-input');
  const count = $('#find-count');
  const resultsEl = $('#find-results');
  const panel = $('#panel-find');
  const btnCase = $('#find-case');
  const btnWord = $('#find-word');
  const btnRegex = $('#find-regex');

  let matches = [];      // **展示的**匹配 {line, from, to, text, index, len}
  let current = -1;      // 当前选中匹配下标
  let query = '';
  // G1：三开关（默认全关 = 旧口径）
  let caseSensitive = false;
  let wholeWord = false;
  let regexMode = false;
  // G1/G2：本轮搜索的诊断事实（全部进测试面，供冒用例逐项断言）
  let truncated = false;      // 命中数达到 FIND_LIMIT 被截断
  let timedOut = false;       // 达到执行预算被中止
  let patternError = '';      // 模式被拒（过长 / 嵌套量词 / 语法错误）
  let unsupported = '';       // 非空 = 当前视图不支持（值为 kind）
  // v0.10.0：大文件视图内查找（>256MB 的 huge 标签没有 CM 文档，走单文件搜索 IPC）
  let hugeMode = false;       // 当前结果来自 huge 单文件搜索
  let hugeToken = 0;          // 请求令牌：切标签/改词后旧结果必须丢弃
  let hugeMs = 0;             // 上次单文件搜索耗时（显示 + 冒烟断言）
  let searchRuns = 0;         // 真正执行的搜索次数（防抖用例的判据）
  let debounceTimer = null;
  // P10（v0.1.45）：结果 DOM 优化 —— 行元素数组 + 上次渲染快照（state/query/开关 三者恒等 → 跳过重建）。
  // CodeMirror EditorState 不可变：tab.state 引用不变 ⇒ 文档内容未变 ⇒ 同 query 下 matches 必然一致，
  // 因此 jumpTo / 重复触发等路径可只切 current 高亮，避免 2000 行每击键全量重建（实测 11.5ms/次）。
  let rowEls = [];
  let lastState = null;
  let lastQuery = '';
  let lastLen = -1;
  let lastSig = '';
  // 仅在冒烟里用：临时收紧执行预算 / 展示上限（`setLimitsForTest`）。
  // 为什么需要它：真正的灾难性回溯是**不可中断**的单次 exec（自动用例里跑它就等于挂死渲染进程），
  // 因此"预算到点即中止"这条分支只能靠临时把预算压到 1ms 来确定性触发；正常路径恒用上面的常量。
  let budgetOverride = null;
  let limitOverride = null;
  const effBudget = () => (budgetOverride == null ? FIND_BUDGET_MS : budgetOverride);
  const effLimit = () => (limitOverride == null ? FIND_LIMIT : limitOverride);
  const effProbe = () => Math.min(FIND_PROBE_MS, effBudget());

  function getView() {
    return getEditor().getView();
  }

  /** 开关签名：任一开关变化都必须重建结果列表（否则缓存命中会显示旧口径的结果） */
  function optSig() {
    return `${caseSensitive ? 1 : 0}${wholeWord ? 1 : 0}${regexMode ? 1 : 0}`;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 构造匹配器。返回 { re } 或 { error }（**错误必须显式呈现给用户，不许静默**） */
  function buildMatcher(q) {
    if (regexMode) {
      if (q.length > FIND_MAX_PATTERN) {
        return { error: `正则模式过长（${q.length} 字符 > 上限 ${FIND_MAX_PATTERN}），已拒绝执行` };
      }
      if (NESTED_QUANTIFIER_RE.test(q)) {
        return { error: '正则含嵌套量词（形如 (a+)+ ），可能造成灾难性回溯，已拒绝执行' };
      }
      try {
        return { re: new RegExp(q, caseSensitive ? 'g' : 'gi') };
      } catch (err) {
        return { error: '正则表达式无效：' + (err && err.message ? err.message : err) };
      }
    }
    const body = escapeRe(q);
    const src = wholeWord ? `(?<![${WORD_CHAR}])(?:${body})(?![${WORD_CHAR}])` : body;
    try {
      // u 标志：让 \p{...} 词字符类生效（同时也让转义后的字面量与旧口径一致）
      return { re: new RegExp(src, caseSensitive ? 'gu' : 'giu') };
    } catch (err) {
      return { error: '匹配规则构造失败：' + (err && err.message ? err.message : err) };
    }
  }

  /**
   * 收集匹配（逐行扫描，一行多处）。
   * @param {object} doc CM 的 Text
   * @param {RegExp} re 匹配器（g 标志；本函数负责逐行重置 lastIndex）
   * @param {number} limit 上限（0 = 不限制）；达到即返回 truncated=true
   * @param {number} toLine 扫描到的最后一行（含）
   * @param {number} budgetMs 执行预算（毫秒）
   */
  function collect(doc, re, limit, toLine, budgetMs) {
    const out = [];
    const t0 = Date.now();
    const last = Math.min(toLine || doc.lines, doc.lines);
    for (let i = 1; i <= last; i++) {
      const line = doc.line(i);
      const text = line.text;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex += 1; continue; } // 零宽匹配：手动推进，防死循环
        out.push({ line: i, from: line.from + m.index, to: line.from + m.index + m[0].length, text, index: m.index, len: m[0].length });
        if (limit > 0 && out.length >= limit) return { out, truncated: true, timedOut: false };
        if (Date.now() - t0 > budgetMs) return { out, truncated: false, timedOut: true };
      }
      // 每 64 行查一次预算：空行/不匹配的行也要能被预算截住（纯 regex.test 也可能很贵）
      if ((i & 63) === 0 && Date.now() - t0 > budgetMs) return { out, truncated: false, timedOut: true };
    }
    return { out, truncated: false, timedOut: false };
  }

  function applyHighlights() {
    if (hugeMode) return; // huge 视图没有 CM 文档，高亮由结果列表承担
    try {
      const view = getView();
      if (!view || view.isDestroyed) return;
      const ranges = [];
      matches.forEach((m, i) => {
        const cls = i === current ? 'cm-search-current' : 'cm-search-match';
        ranges.push(Decoration.mark({ class: cls }).range(m.from, m.to));
      });
      view.dispatch({ effects: matchEffect.of(Decoration.set(ranges, true)) });
    } catch (err) {
      console.warn('[find] 高亮失败:', err && err.message ? err.message : err);
    }
  }

  /** 仅同步 current 高亮与滚动（跳转/Enter 导航路径，不重建列表） */
  function syncCurrentClass() {
    rowEls.forEach((row, i) => row.classList.toggle('current', i === current));
    const cur = resultsEl.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /** 结果区尾部的截断提示行（G2 硬要求：截断必须显式提示，否则用户以为没有更多） */
  function moreText() {
    if (truncated) return `匹配过多，仅显示前 ${effLimit()} 处（已截断）—— 请细化关键词`;
    if (timedOut) {
      // 一处都没扫出来时不说"仅显示前 0 处"（会让人以为"没有匹配"）—— 直接说中止、结果可能不完整
      return matches.length
        ? `已达 ${effBudget()}ms 执行预算，仅显示前 ${matches.length} 处（已中止）—— 请细化关键词或简化正则`
        : `已达 ${effBudget()}ms 执行预算，查找已中止（结果可能不完整）—— 请细化关键词或简化正则`;
    }
    return '';
  }

  function renderResults() {
    const tab = getTab();
    // P10：文档内容未变（state 引用恒等）且 query/开关/匹配数与诊断位都一致 → 结果必然一致，跳过全量重建。
    // 诊断位（不支持/模式被拒/截断/超时）必须进签名：它们变化时 matches 可能都是 0，不加就会显示旧提示。
    // v0.10.0：huge 单文件搜索走异步 IPC，结果集不由 tab.state 决定 → 不进这条缓存捷径。
    const sig = `${optSig()}|${unsupported}|${patternError}|${truncated ? 't' : ''}${timedOut ? 'T' : ''}${hugeMode ? 'H' : ''}`;
    const unchanged = !hugeMode && query === lastQuery && lastLen === matches.length && sig === lastSig && !!tab && tab.state === lastState;
    if (unchanged) {
      syncCurrentClass();
      return;
    }
    resultsEl.textContent = '';
    rowEls = [];
    lastState = null;
    lastQuery = '';
    lastLen = -1;
    lastSig = '';
    if (unsupported) {
      resultsEl.innerHTML = `<div class="find-empty">${escapeHtml(UNSUPPORTED_MSG[unsupported] || '当前视图不支持文件内查找')}</div>`;
      return;
    }
    if (patternError) {
      resultsEl.innerHTML = `<div class="find-empty">查找未执行：${escapeHtml(patternError)}</div>`;
      return;
    }
    if (!query) {
      resultsEl.innerHTML = hugeMode
        ? '<div class="find-empty">大文件视图内查找：输入关键词开始搜索（不区分大小写；每行最多显示一条命中）</div>'
        : '<div class="find-empty">输入关键词开始搜索（默认不区分大小写；Aa 区分大小写 / 整词 / .* 正则，展示前 500 处）</div>';
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
      text.innerHTML = highlightText(m.text);
      row.append(lineNo, text);
      frag.appendChild(row);
      rowEls.push(row);
    });
    const more = moreText();
    if (more) {
      const note = document.createElement('div');
      note.className = 'find-more';
      note.textContent = more;
      frag.appendChild(note);
    }
    if (hugeMode) {
      // 口径提示（有意不做成 .toast）：大文件查找走磁盘内容 + 固定大小写不敏感子串，
      // 三个开关（Aa/整词/正则）在 huge 视图不生效 —— 必须显式告知，不能静默忽略。
      const parts = ['大文件视图：按磁盘内容搜索（未保存的修改不在结果中）' + (hugeMs ? ` · 耗时 ${hugeMs}ms` : '')];
      if (caseSensitive || wholeWord || regexMode) parts.push('Aa / 整词 / 正则 在大文件视图不生效');
      const tip = document.createElement('div');
      tip.className = 'find-more';
      tip.textContent = parts.join(' · ');
      frag.appendChild(tip);
    }
    resultsEl.appendChild(frag);
    lastState = tab ? tab.state : null;
    lastQuery = query;
    lastLen = matches.length;
    lastSig = sig;
    // 当前项滚入视野
    const cur = resultsEl.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /** 单行高亮：**与收集同源**的匹配器（下标取原串位置，修掉旧的 toLowerCase 错位） */
  function highlightText(text) {
    if (hugeMode) return highlightLiteral(text, query);
    const matcher = buildMatcher(query);
    if (!matcher.re) return escapeHtml(text);
    const re = matcher.re;
    re.lastIndex = 0;
    let html = '';
    let i = 0;
    let guard = 0;
    let m;
    while ((m = re.exec(text)) !== null && guard++ < HIGHLIGHT_GUARD) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      html += escapeHtml(text.slice(i, m.index));
      html += `<mark>${escapeHtml(m[0])}</mark>`;
      i = m.index + m[0].length;
    }
    html += escapeHtml(text.slice(i));
    return html;
  }

  /** 字面量高亮（大小写不敏感，与 worker 的单文件搜索口径一致）。
   *  小写映射变长（如 İ）时下标会错位 —— 直接放弃高亮，只做转义输出。 */
  function highlightLiteral(text, q) {
    if (!q) return escapeHtml(text);
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    if (lower.length !== text.length || !needle) return escapeHtml(text);
    let i = 0;
    let guard = 0;
    let out = '';
    for (;;) {
      const k = lower.indexOf(needle, i);
      if (k < 0 || guard++ > HIGHLIGHT_GUARD) break;
      out += escapeHtml(text.slice(i, k)) + `<mark>${escapeHtml(text.slice(k, k + needle.length))}</mark>`;
      i = k + needle.length;
    }
    return out + escapeHtml(text.slice(i));
  }

  function jumpTo(i) {
    if (i < 0 || i >= matches.length) return;
    current = i;
    const m = matches[i];
    if (hugeMode) {
      // huge 没有 CM 文档：直接跳到命中行（视口首行 = 该行），高亮交给结果列表
      const tab = getTab();
      if (tab && tab.huge) {
        try { Promise.resolve(tab.huge.gotoLine(m.line)).catch(() => { /* 视图销毁竞态 */ }); } catch { /* 忽略 */ }
      }
      syncCurrentClass();
      return;
    }
    const view = getView();
    view.dispatch({
      selection: { anchor: m.from },
      effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
    });
    applyHighlights();
    syncCurrentClass(); // P10：仅切 current 高亮 + 滚入视野，不重建结果列表
  }

  /** v0.10.0：huge 视图的异步单文件查找（结果形状 { line, text, index }） */
  function startHugeSearch(tab, noJump) {
    const token = ++hugeToken;
    const t0 = Date.now();
    count.textContent = '搜索中…';
    resultsEl.textContent = '';
    resultsEl.innerHTML = '<div class="find-empty">大文件视图内查找：正在扫描文件…</div>';
    matches = [];
    const api = (typeof window !== 'undefined' && window.api) || null;
    if (!api || typeof api.searchFile !== 'function') {
      count.textContent = '查找失败：当前版本缺少 search:file 通道';
      resultsEl.innerHTML = '<div class="find-empty">查找失败：当前版本缺少 search:file 通道</div>';
      return;
    }
    Promise.resolve(api.searchFile(tab.path, query, effLimit()))
      .then((list) => {
        if (token !== hugeToken) return; // 词已改/切了标签：丢弃过期结果
        hugeMs = Date.now() - t0;
        matches = (Array.isArray(list) ? list : []).map((r) => ({
          line: r.line, text: r.text || '', index: r.matchIndex || 0, from: -1, to: -1,
        }));
        truncated = matches.length >= effLimit();
        count.textContent = `${matches.length} 处匹配（${hugeMs}ms）`;
        renderResults();
        if (matches.length > 0 && !noJump) jumpTo(0);
      })
      .catch((err) => {
        if (token !== hugeToken) return;
        const msg = (err && err.message) || String(err);
        matches = [];
        truncated = false;
        count.textContent = '查找失败：' + msg;
        resultsEl.textContent = '';
        resultsEl.innerHTML = `<div class="find-empty">查找失败：${escapeHtml(msg)}</div>`;
      });
  }

  /** 执行一次查找（同步；程序化入口 setQuery / 内部重算走它，**不经防抖**） */
  function runSearch(noJump = false) {
    const tab = getTab();
    query = input.value.trim();
    current = -1;
    truncated = false;
    timedOut = false;
    patternError = '';
    unsupported = '';
    searchRuns++;
    // v0.10.0：huge 视图 = 单文件搜索（异步 IPC），不再走「当前视图不支持」守卫。
    // 空 query 时也给出 huge 专属提示（不是"输入关键词"的通用文案）。
    if (tab && !tab.state && tab.kind === 'huge') {
      hugeMode = true;
      if (!query) {
        hugeToken++; // 作废在途请求
        matches = [];
        truncated = false;
        count.textContent = '大文件视图内查找：输入关键词开始搜索（不区分大小写）';
        renderResults();
        return;
      }
      startHugeSearch(tab, noJump);
      return;
    }
    // 普通标签（或其它无文档视图）：huge 的在途结果一律作废，避免串台
    const wasHuge = hugeMode;
    hugeMode = false;
    if (wasHuge) hugeToken++;
    // G1：无文档视图（viewer-lg / image / diff）→ **必须在"空 query 提前返回"之前判**。
    // 顺序曾经写反：空 query 先 return，于是「在 huge 视图里按 Ctrl+F」看到的是一句
    // "输入关键词开始搜索"，敲了字才发现 0 命中 —— 正是挂账的那条静默项（真窗口探针抓到的）。
    if (tab && !tab.state) {
      unsupported = tab.kind || 'none';
      matches = [];
      count.textContent = UNSUPPORTED_MSG[unsupported] || '当前视图不支持文件内查找';
      applyHighlights();
      renderResults();
      return;
    }
    // 无 query：清空（既有语义）
    if (!query) {
      matches = [];
      count.textContent = '';
      applyHighlights();
      renderResults();
      return;
    }
    if (!tab) {
      unsupported = 'none';
      matches = [];
      count.textContent = '没有打开的文档（先打开一个文件）';
      applyHighlights();
      renderResults();
      return;
    }
    const matcher = buildMatcher(query);
    if (!matcher.re) {
      patternError = matcher.error || '匹配规则无效';
      matches = [];
      count.textContent = '查找未执行：' + patternError;
      applyHighlights();
      renderResults();
      return;
    }
    // 正则：先在少量行上预检（灾难性回溯在小样本上通常立刻暴露），超预算直接中止全量扫描
    let probe = null;
    if (regexMode) {
      probe = collect(tab.state.doc, matcher.re, 0, FIND_PROBE_LINES, effProbe());
      if (probe.timedOut) timedOut = true;
    }
    if (!timedOut) {
      const r = collect(tab.state.doc, matcher.re, effLimit(), tab.state.doc.lines, effBudget());
      matches = r.out;
      truncated = r.truncated;
      timedOut = timedOut || r.timedOut;
    } else {
      matches = probe.out;
    }
    if (truncated) count.textContent = `匹配过多：仅显示前 ${effLimit()} 处（已截断）`;
    else if (timedOut) {
      count.textContent = matches.length
        ? `匹配过多：仅显示前 ${matches.length} 处（已达 ${effBudget()}ms 执行预算，已中止）`
        : `查找已中止：已达 ${effBudget()}ms 执行预算（结果可能不完整，请细化关键词）`;
    } else count.textContent = `${matches.length} 处匹配`;
    applyHighlights();
    renderResults();
    // noJump=true 时不抢占光标（编辑文档触发时用），只更新高亮与列表
    if (matches.length > 0 && !noJump) jumpTo(0);
  }

  /** G2：输入防抖（只挂 input 事件；A14 的输入路径卡顿在这里被削掉） */
  function scheduleSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch();
    }, FIND_INPUT_DEBOUNCE_MS);
  }

  function clearSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    input.value = '';
    runSearch();
  }

  /** 外部设置搜索词（如点击全局搜索结果），noJump 时不抢占当前光标 */
  function setQuery(q, noJump = false) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    input.value = q;
    runSearch(noJump);
  }

  // ---------- G1：三开关 ----------
  function syncToggleButtons() {
    if (btnCase) {
      btnCase.classList.toggle('active', caseSensitive);
      btnCase.setAttribute('aria-pressed', caseSensitive ? 'true' : 'false');
    }
    if (btnWord) {
      btnWord.classList.toggle('active', wholeWord);
      btnWord.setAttribute('aria-pressed', wholeWord ? 'true' : 'false');
    }
    if (btnRegex) {
      btnRegex.classList.toggle('active', regexMode);
      btnRegex.setAttribute('aria-pressed', regexMode ? 'true' : 'false');
    }
  }
  /** 设置开关（按钮与测试面共用出口）：立即重跑一次查找（开关是显式动作，不走防抖） */
  function setOptions(patch = {}) {
    if ('caseSensitive' in patch) caseSensitive = patch.caseSensitive === true;
    if ('wholeWord' in patch) wholeWord = patch.wholeWord === true;
    if ('regex' in patch) regexMode = patch.regex === true;
    syncToggleButtons();
    runSearch();
    return { caseSensitive, wholeWord, regex: regexMode };
  }
  if (btnCase) btnCase.addEventListener('click', () => { setOptions({ caseSensitive: !caseSensitive }); input.focus(); });
  if (btnWord) btnWord.addEventListener('click', () => { setOptions({ wholeWord: !wholeWord }); input.focus(); });
  if (btnRegex) btnRegex.addEventListener('click', () => { setOptions({ regex: !regexMode }); input.focus(); });
  syncToggleButtons();

  // ---------- 替换（与查找**同口径**：走同一个匹配器；替换文本原样插入，不做分组引用） ----------
  /** 替换当前选中匹配（无选中时替换第一处），替换后跳到下一处 */
  function replaceCurrent() {
    if (hugeMode) { toast('大文件视图内不支持替换（只读磁盘内容，请用全局替换或先切回普通视图）'); return 0; }
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

  /** 替换当前文件中全部匹配（一次 dispatch，多处原子生效），返回替换处数。
   *  **注意**：展示列表可能被 FIND_LIMIT 截断，因此这里**必须重新全量扫描**，
   *  绝不能拿 matches 当全集（否则"全部替换"只换前 500 处，是静默的错误结果）。 */
  function replaceAll() {
    if (hugeMode) { toast('大文件视图内不支持替换（只读磁盘内容，请用全局替换或先切回普通视图）'); return 0; }
    if (getView().state.readOnly) {
      toast('只读内容不可替换');
      return 0;
    }
    const tab = getTab();
    if (!query || !tab || !tab.state) return 0;
    const matcher = buildMatcher(query);
    if (!matcher.re) {
      toast('查找未执行：' + (matcher.error || '匹配规则无效'));
      return 0;
    }
    const full = collect(tab.state.doc, matcher.re, REPLACE_ALL_MAX + 1, tab.state.doc.lines, REPLACE_ALL_BUDGET_MS);
    if (full.timedOut) {
      toast(`全部替换已中止：匹配超出 ${REPLACE_ALL_BUDGET_MS}ms 预算，请细化关键词或简化正则`);
      return 0;
    }
    if (full.out.length > REPLACE_ALL_MAX) {
      toast(`匹配过多（>${REPLACE_ALL_MAX} 处），已中止全部替换 —— 请细化关键词`);
      return 0;
    }
    if (full.out.length === 0) return 0;
    const rep = replaceInput.value;
    const changes = full.out.map((mm) => ({ from: mm.from, to: mm.to, insert: rep }));
    getView().dispatch({ changes });
    const n = full.out.length;
    runSearch(true);
    toast(`已替换 ${n} 处${matches.length ? `，剩余 ${matches.length} 处匹配` : ''}`);
    return n;
  }

  input.addEventListener('input', () => scheduleSearch());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; runSearch(); }
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

  /** 当前焦点栏的活动文档没有 CM 文档（viewer-lg / image / diff）→ 需要立刻给出显式提示 */
  function unsupportedNow() {
    const t = getTab();
    return !!(t && !t.state && t.kind !== 'huge'); // v0.10.0：huge 已支持文件内查找
  }

  return {
    runSearch, setQuery, clearSearch, replaceCurrent, replaceAll, setOptions,
    // G1：Ctrl+F / Ctrl+H 进入面板时，若当前视图根本不支持文件内查找（huge 等），**立刻**把提示显示出来
    // （否则用户看到的是一句"输入关键词开始搜索"，敲了字才发现 0 命中 —— 这正是挂账的"静默 0 命中"）。
    focus: () => { panel.classList.remove('hidden'); input.focus(); input.select(); if (unsupportedNow()) runSearch(true); },
    focusReplace: () => { panel.classList.remove('hidden'); replaceInput.focus(); replaceInput.select(); if (unsupportedNow()) runSearch(true); },
    /** 测试面（dev 独有）：纯数据快照，可结构化克隆回主进程 */
    getState: () => ({
      query,
      options: { caseSensitive, wholeWord, regex: regexMode },
      limits: {
        maxPattern: FIND_MAX_PATTERN,
        budgetMs: effBudget(),
        probeMs: effProbe(),
        probeLines: FIND_PROBE_LINES,
        limit: effLimit(),
        debounceMs: FIND_INPUT_DEBOUNCE_MS,
      },
      shown: matches.length,
      rows: resultsEl.querySelectorAll('.find-result').length,
      truncated,
      timedOut,
      patternError,
      unsupported,
      moreText: moreText(),
      countText: count.textContent,
      resultsText: resultsEl.textContent,
      searchRuns,
      current,
      matchLines: matches.slice(0, 5).map((m) => m.line),
      pendingDebounce: !!debounceTimer,
      huge: hugeMode,     // v0.10.0：结果来自 huge 单文件搜索
      hugeMs,             // 上次单文件搜索耗时（0 = 未跑过/无 CM 文档）
    }),
    /** 测试面（dev 独有）：临时收紧执行预算 / 展示上限（传 null 恢复默认；返回生效值）。
     *  只影响后续搜索，不改任何常量；正常使用不会走到这里。 */
    setLimitsForTest: (patch = {}) => {
      budgetOverride = patch && patch.budgetMs != null ? Math.max(0, Number(patch.budgetMs) || 0) : null;
      limitOverride = patch && patch.limit != null ? Math.max(1, Math.floor(Number(patch.limit) || 0)) : null;
      return { budgetMs: effBudget(), limit: effLimit() };
    },
  };
}
