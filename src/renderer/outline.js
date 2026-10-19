// ============================================================================
// outline.js —— 大纲 / TOC（0.5.0 Phase 5a B1；v0.11.0 起从左侧栏迁入**正文区左栏**）
// ============================================================================
// 位置：`#outline-rail` 是 `#workbench`（正文区）的第一个 flex 子项 ⇒ 布局 = 文件树 | 大纲 | 编辑区。
//   **不再和文件树同一栏**（v0.11.0 用户需求）；左栏只剩文件树，右栏是正文。
//   可见性由本模块统一驱动：`#outline-rail` 与 `#outline-block` 的 `.hidden` 同步切换；
//   折叠 = rail 收成 34px 细条（`.collapsed`，列表隐藏），Ctrl+Shift+O / 点标题行切换。
//
// 数据源 = **当前承载该文档的栏**（app.js 传进来的 getActiveDoc 就是焦点栏的活动文档：
//   Phase 2 起「焦点栏」= 用户正在操作的那一栏，`registry.active()` 的无参口径即它）。
//   因此双栏下大纲永远跟着"你正在看的那一栏"，不会张冠李戴到另一栏的文件。
//
// 三条硬口径（对应 0.5.0 计划 §4-B1 的"风险"列）：
//   1. **非 Markdown 不显示大纲**（txt/json/py… 标题语法无意义）；
//   2. **huge（>1GB 虚拟滚动查看器）/ viewer-lg（256MB–1GB 分页查看器）/ image / diff 一律不显示** ——
//      这些标签的正文档体不在渲染端（CM 是空文档占位），扫描它们只会得到空大纲；
//   3. chunked（>4MB 分段）**显示**：它是真正的 markdown 文本，只是尚未加载全文 —— 因此大纲
//      只覆盖"已加载部分"，标题里标注了这一点（不假装完整）。
//
// 与多视图的一致性：本模块**只读** editor 的按栏 API（paneIdOf / paneActiveOf / registry 口径的
//   active doc），跳转复用 `editor.jumpToLine(tab, line)`（它内部会 switchTab + 聚焦该标签所属栏），
//   自身不持有任何"全局活动文档"的状态。
//
// 缓存策略（性能）：CodeMirror 的 EditorState 不可变 ⇒ `tab.state` 引用恒等 = 文档内容未变。
//   因此解析结果按 (tab, tab.state) 缓存，光标移动/滚动等高频路径零解析成本（口径同 find.js 的 P10）。
import { $, isMarkdown } from './ui.js';

/** 一行最多算多少字符（极端长行防御；标题行本身不可能这么长） */
const MAX_HEADINGS = 2000;

/**
 * 扫描 markdown 文本里的 ATX 标题（# ~ ######）。
 * · 跳过围栏代码块（``` / ~~~）内部的 `#` 注释（否则 shell/python 注释会被当成标题）；
 * · 去掉标题文本里的行内标记（**粗体**、`代码`、[链接]() 的括号部分保留文字）。
 * 返回 [{ level, text, line }]（line 为 1 基行号 = 跳转目标）。
 */
export function parseHeadings(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  let fence = null; // 当前围栏标记（``` 或 ~~~），null = 不在代码块内
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      const mark = f[1][0];
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence) continue;
    const m = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[2]
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    out.push({ level: m[1].length, text: text || m[2], line: i + 1 });
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

/** 「这个文档该不该有大纲」的**唯一判据**（测试面直接断言本函数，UI 与它同源） */
export function outlineSupported(name, kind) {
  if (kind === 'huge' || kind === 'viewer-lg' || kind === 'image' || kind === 'diff') return false;
  return isMarkdown(name || '');
}

/**
 * @param {Object} opts
 * @param {() => any} opts.getEditor        editor 模块（tabs.js 的 API 面）
 * @param {() => any} opts.getActiveDoc     焦点栏的活动文档（app.js 传 `() => editor.getActiveTab()`）
 */
export function createOutline({ getEditor, getActiveDoc }) {
  const block = $('#outline-block');
  const rail = $('#outline-rail'); // v0.11.0：正文区左栏容器（可见性与折叠类同步到它）
  const header = $('#outline-header');
  const caret = $('#outline-caret');
  const titleEl = $('#outline-title');
  const listEl = $('#outline-list');

  let items = [];       // [{ level, text, line, el }]
  let collapsed = false;
  let lastTab = null;
  let lastState = null;
  let lastCurrent = -1;

  /** 该文档是否支持大纲（非 markdown / huge / 查看器等一律 false） */
  function supported(tab) {
    return !!tab && outlineSupported(tab.name, tab.kind);
  }

  /** 显隐：类型门控的唯一落地口 —— `#outline-block`（既有断言口径）与 `#outline-rail`
   *  （布局容器）必须同步；只藏其中一个会留下 34/240px 的空栏或留下可见的大纲。 */
  function setVisible(on) {
    block.classList.toggle('hidden', !on);
    if (rail) rail.classList.toggle('hidden', !on);
  }

  /** 重建列表（只在"文档内容变了"或"换了标签"时执行） */
  function rebuild(tab) {
    listEl.innerHTML = '';
    items = [];
    lastTab = tab;
    lastState = tab ? tab.state : null;
    if (!tab || !tab.state) {
      listEl.innerHTML = '<div class="outline-empty">当前文档没有可解析的正文</div>';
      return 0;
    }
    // 分段（chunked）标签正文含 <!-- MH-CHUNKED … --> 占位标记，标题解析不受影响（正则不匹配）
    const hs = parseHeadings(tab.state.doc.toString());
    if (!hs.length) {
      listEl.innerHTML = '<div class="outline-empty">没有找到标题（用 # / ## / ### 写标题）</div>';
      return 0;
    }
    const frag = document.createDocumentFragment();
    for (const h of hs) {
      const row = document.createElement('div');
      row.className = 'outline-item';
      row.dataset.line = String(h.line);
      row.dataset.level = String(h.level);
      row.dataset.idx = String(items.length); // 预览跳转用：与预览 DOM 里的 heading 序号对齐
      row.style.paddingLeft = 4 + (h.level - 1) * 12 + 'px';
      row.title = `第 ${h.line} 行 · ${'#'.repeat(h.level)} ${h.text}`;
      const txt = document.createElement('span');
      txt.className = 'ol-text';
      txt.textContent = h.text;
      row.appendChild(txt);
      // 点击跳转（v0.7.0 起分两种模式）：
      //  · 仅预览模式（编辑器隐藏、预览独占）→ 滚动**预览区**到对应标题 —— 用户在预览
      //    模式下点大纲是为了在渲染结果里定位，跳回编辑器反而打断阅读；
      //  · 其余（编辑/分屏）→ 走 editor.jumpToLine（内部 switchTab + 聚焦该标签所属栏
      //    + 居中滚动），预览若有滚动同步照旧。
      row.addEventListener('click', () => {
        const t = lastTab;
        if (!t) return;
        try {
          if (jumpPreviewIfPreviewMode(t, Number(row.dataset.idx))) return;
          getEditor().jumpToLine(t, h.line);
        } catch (err) { console.warn('[outline]', err && err.message ? err.message : err); }
        markCurrent(h.line); // 立即反馈（jumpToLine 会触发 selectionSet → 也会走到 markCurrent，幂等）
      });
      frag.appendChild(row);
      items.push({ ...h, el: row });
    }
    listEl.appendChild(frag);
    return items.length;
  }

  /** 仅预览模式下滚动预览区到第 idx 个标题（返回 true 表示已处理）。
   *  判据：该栏的编辑器层隐藏且预览层可见 = preview 实例的 mode==='preview'（applyMode
   *  的显隐口径同源）；heading 序号与 parseHeadings 的输出一一对齐（两边都跳过围栏
   *  代码块内的 #）。 */
  function jumpPreviewIfPreviewMode(tab, idx) {
    try {
      const ed = getEditor();
      const pid = ed.paneIdOf(tab);
      const pe = ed.getPaneElsById(pid);
      if (!pe || !pe.previewContent) return false;
      const previewOnly = pe.editorHost.classList.contains('hidden')
        && !pe.previewHost.classList.contains('hidden');
      if (!previewOnly) return false;
      const heads = pe.previewContent.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const target = heads[idx];
      if (!target) return false;
      target.scrollIntoView({ block: 'start' });
      // 短暂高亮反馈（与编辑器跳转的光标反馈对等）
      target.classList.add('ol-jump-flash');
      setTimeout(() => target.classList.remove('ol-jump-flash'), 900);
      return true;
    } catch {
      return false;
    }
  }

  function headingIndexOfLine(line) {
    let lo = 0;
    let hi = items.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].line <= line) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** 随光标高亮：光标所在章节 = 行号 ≤ 光标行的最后一个标题 */
  function markCurrent(line) {
    const idx = items.length ? headingIndexOfLine(line) : -1;
    if (idx === lastCurrent) return idx;
    if (lastCurrent >= 0 && items[lastCurrent]) items[lastCurrent].el.classList.remove('current');
    lastCurrent = idx;
    if (idx >= 0 && items[idx]) {
      items[idx].el.classList.add('current');
      const el = items[idx].el;
      const box = listEl;
      // 只在超出可视区时滚动（避免每次光标移动都抖动列表）
      if (el.offsetTop < box.scrollTop || el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
    return idx;
  }

  /** 主刷新：显隐（按文档类型）+ 列表（按文档内容缓存）+ 当前项（按光标） */
  function refresh(cursorLine) {
    const tab = getActiveDoc();
    const ok = supported(tab);
    setVisible(ok);
    if (!ok) {
      // 非 markdown / huge / 查看器：整体隐藏并清空（不残留上一个文档的大纲）
      if (items.length || listEl.childNodes.length) { listEl.innerHTML = ''; items = []; }
      lastTab = null;
      lastState = null;
      lastCurrent = -1;
      titleEl.textContent = '🧭 大纲';
      return { hidden: true, count: 0, reason: tab ? (tab.kind ? 'kind:' + tab.kind : 'non-markdown') : 'no-doc' };
    }
    const isChunked = tab.kind === 'chunked';
    titleEl.textContent = isChunked ? '🧭 大纲（仅已加载部分）' : '🧭 大纲';
    if (tab !== lastTab || tab.state !== lastState) rebuild(tab);
    const doc = tab.state ? tab.state.doc : null;
    if (doc) {
      let line = cursorLine;
      if (!line) {
        try {
          const view = getEditor().getPaneElsById(getEditor().paneIdOf(tab));
          line = view && view.view ? view.view.state.doc.lineAt(view.view.state.selection.main.head).number : 1;
        } catch { line = 1; }
      }
      markCurrent(line);
    }
    return { hidden: false, count: items.length, reason: 'ok' };
  }

  /** 折叠/展开（用户动作，纯 UI 状态；不影响"是否显示大纲"的类型判据）。
   *  v0.11.0：折叠类同时落到 rail 与 block —— rail 负责收窄成 34px 细条，block 负责隐藏列表。 */
  function setCollapsed(v) {
    collapsed = !!v;
    block.classList.toggle('collapsed', collapsed);
    if (rail) rail.classList.toggle('collapsed', collapsed);
    caret.textContent = collapsed ? '▶' : '▼';
    return collapsed;
  }
  header.addEventListener('click', () => setCollapsed(!collapsed));
  setCollapsed(false);

  return {
    refresh,
    setCollapsed,
    /** 测试面：可见性 / 条数 / 当前高亮 / 折叠态 + 判据同源的纯函数引用
     *  （v0.11.0 增加 rail* 三项：布局容器 #outline-rail 的显隐/折叠/实测宽度 —— 布局迁移的几何证据） */
    getState: () => ({
      hidden: block.classList.contains('hidden'),
      collapsed,
      count: items.length,
      current: lastCurrent >= 0 && items[lastCurrent] ? items[lastCurrent].text : null,
      currentLine: lastCurrent >= 0 && items[lastCurrent] ? items[lastCurrent].line : -1,
      title: titleEl.textContent,
      rendered: listEl.querySelectorAll('.outline-item').length,
      tabName: lastTab ? lastTab.name : null,
      tabKind: lastTab ? (lastTab.kind || null) : null,
      railHidden: rail ? rail.classList.contains('hidden') : null,
      railCollapsed: rail ? rail.classList.contains('collapsed') : null,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
    }),
    supports: (name, kind) => outlineSupported(name, kind),
    parse: (text) => parseHeadings(text),
    /** 用例可直接驱动"跟随光标"（不必真的按键）：传 1 基行号 */
    markLine: (line) => markCurrent(line),
  };
}
