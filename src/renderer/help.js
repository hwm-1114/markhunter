// ============================================================================
// help.js —— 快捷键帮助面板（0.5.0 Phase 5a F1）+ **键位表的唯一数据源**
// ============================================================================
// 单一数据源口径：`SHORTCUTS` 既是**面板显示的内容**，也是**键盘分派的依据**
//   （app.js 只提供 id → 动作的映射，不再自己写一遍 if/else 键位判断）。
//   于是「README 写的键位」「代码里真正生效的键位」「面板显示的键位」三者不可能再漂移 ——
//   前两者由 `match` 保证一致，面板直接渲染同一张表（新增键位只需在本文件加一行）。
//
// 本模块**顶层不碰 DOM**（$ / ui.js 都是函数内按需取）：既方便纯 node 校验键位匹配表
//   （把本文件复制成 .mjs 直接 import 即可跑断言），也避免启动期多做无谓的 DOM 查询。
//
// 键位说明：
//   · `keys` = 面板上显示的字样（人读）；
//   · `match(e, mod)` = 真实判定（mod = ctrlKey || metaKey）；
//   · 表**顺序即优先级**（先匹配者胜），与 0.5.0 之前 app.js 里那条 if/else 链逐条对应。
'use strict';

export const SHORTCUT_GROUPS = ['打开与切换', '编辑与保存', '搜索与查找', '视图与布局', '帮助'];

/**
 * 键位表。字段：
 *   id      动作标识（app.js 的 ACTIONS 表按 id 取处理函数）
 *   group   分组（面板按此分组显示，顺序同 SHORTCUT_GROUPS）
 *   keys    面板显示字样
 *   label   功能说明
 *   spec    给用例/自检读的**结构化**键位（不做判定，判定看 match）
 *   match   (e, mod) => boolean
 */
export const SHORTCUTS = [
  // ---------- 打开与切换 ----------
  {
    id: 'quick-open', group: '打开与切换', keys: 'Ctrl+P', label: '快速打开（当前工作目录内文件名模糊匹配）',
    spec: { ctrl: true, key: 'p' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 'p',
  },
  {
    // ⚠️ 顺序敏感：Ctrl+Shift+O 必须排在 Ctrl+O（open-dir，不判 shift）**之前**，
    //    否则会被 open-dir 先吃掉（表顺序即优先级）。新增键位时务必核对这一条。
    id: 'outline-toggle', group: '视图与布局', keys: 'Ctrl+Shift+O', label: '折叠 / 展开大纲（Markdown 文档）',
    spec: { ctrl: true, shift: true, key: 'o' },
    match: (e, mod) => mod && e.shiftKey && String(e.key).toLowerCase() === 'o',
  },
  {
    id: 'open-dir', group: '打开与切换', keys: 'Ctrl+O', label: '选择工作目录（多目录侧栏时追加目录）',
    spec: { ctrl: true, key: 'o' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 'o',
  },
  {
    id: 'new-window', group: '打开与切换', keys: 'Ctrl+Shift+N', label: '新建窗口（每窗口独立标签与目录）',
    spec: { ctrl: true, shift: true, key: 'n' },
    match: (e, mod) => mod && e.shiftKey && String(e.key).toLowerCase() === 'n',
  },
  {
    id: 'close-tab', group: '打开与切换', keys: 'Ctrl+W', label: '关闭当前标签（关最后一个视图才提示保存）',
    spec: { ctrl: true, key: 'w' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 'w',
  },
  {
    // 0.5.0 Phase 5a 第 2 批 A2：重开刚关闭的标签（栈 20 条，恢复光标/滚动/未保存内容）
    id: 'reopen-closed', group: '打开与切换', keys: 'Ctrl+Shift+T', label: '重开刚关闭的标签（最近 20 条，恢复落栏/光标/滚动/未保存内容）',
    spec: { ctrl: true, shift: true, key: 't' },
    match: (e, mod) => mod && e.shiftKey && String(e.key).toLowerCase() === 't',
  },
  {
    id: 'cycle-tab', group: '打开与切换', keys: 'Ctrl+Tab / Ctrl+Shift+Tab', label: '栏内循环切换标签（含切换浮层）',
    spec: { ctrl: true, key: 'Tab' },
    match: (e, mod) => mod && e.key === 'Tab',
  },
  // ---------- 编辑与保存 ----------
  {
    id: 'save', group: '编辑与保存', keys: 'Ctrl+S', label: '保存当前文件',
    spec: { ctrl: true, key: 's' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 's',
  },
  // ---------- 搜索与查找 ----------
  {
    id: 'find', group: '搜索与查找', keys: 'Ctrl+F', label: '文件内查找',
    spec: { ctrl: true, shift: false, key: 'f' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 'f' && !e.shiftKey,
  },
  {
    id: 'replace', group: '搜索与查找', keys: 'Ctrl+H', label: '文件内替换（聚焦替换输入框）',
    spec: { ctrl: true, shift: false, key: 'h' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 'h' && !e.shiftKey,
  },
  {
    id: 'global-search', group: '搜索与查找', keys: 'Ctrl+Shift+F', label: '全局搜索（跨文件）',
    spec: { ctrl: true, shift: true, key: 'f' },
    match: (e, mod) => mod && e.shiftKey && String(e.key).toLowerCase() === 'f',
  },
  {
    id: 'huge-goto', group: '搜索与查找', keys: 'Ctrl+G', label: '大文件查看器：跳转到指定行号',
    spec: { ctrl: true, shift: false, key: 'g' },
    match: (e, mod) => mod && !e.shiftKey && String(e.key).toLowerCase() === 'g',
  },
  // ---------- 视图与布局 ----------
  {
    id: 'preview-cycle', group: '视图与布局', keys: 'Ctrl+B', label: '预览模式切换（编辑 / 分屏 / 仅预览）',
    spec: { ctrl: true, key: 'b' },
    match: (e, mod) => mod && String(e.key).toLowerCase() === 'b',
  },
  {
    id: 'split-toggle', group: '视图与布局', keys: 'Ctrl+\\', label: '左右分屏 / 合并回单栏（最多 2 栏）',
    spec: { ctrl: true, keys: ['\\'], codes: ['Backslash'] },
    match: (e, mod) => mod && (e.key === '\\' || e.code === 'Backslash'),
  },
  {
    id: 'focus-pane-1', group: '视图与布局', keys: 'Ctrl+1', label: '聚焦第 1 栏',
    spec: { ctrl: true, key: '1' },
    match: (e, mod) => mod && e.key === '1',
  },
  {
    id: 'focus-pane-2', group: '视图与布局', keys: 'Ctrl+2', label: '聚焦第 2 栏（未分屏时提示）',
    spec: { ctrl: true, key: '2' },
    match: (e, mod) => mod && e.key === '2',
  },
  {
    id: 'font-inc', group: '视图与布局', keys: 'Ctrl+=', label: '编辑器字号 +1px',
    spec: { ctrl: true, keys: ['=', '+'] },
    match: (e, mod) => mod && (e.key === '=' || e.key === '+'),
  },
  {
    id: 'font-dec', group: '视图与布局', keys: 'Ctrl+-', label: '编辑器字号 −1px',
    spec: { ctrl: true, keys: ['-', '_'] },
    match: (e, mod) => mod && (e.key === '-' || e.key === '_'),
  },
  {
    id: 'zoom-reset', group: '视图与布局', keys: 'Ctrl+0', label: '视图缩放复位（字号与预览缩放回默认）',
    spec: { ctrl: true, key: '0' },
    match: (e, mod) => mod && e.key === '0',
  },
  {
    id: 'panel-collapse', group: '视图与布局', keys: 'Esc', label: '收起底部面板 / 关闭右键菜单与弹窗',
    spec: { key: 'Escape' },
    match: (e) => e.key === 'Escape',
  },
  // ---------- 帮助 ----------
  {
    id: 'help', group: '帮助', keys: 'F1 / Ctrl+/', label: '快捷键帮助面板（本面板）',
    spec: { key: 'F1', alt: 'Ctrl+/' },
    match: (e, mod) => e.key === 'F1' || (mod && e.key === '/'),
  },
];

/** 键位分派：返回命中的 id（未命中返回 null）。表顺序即优先级。 */
export function matchShortcut(e, table = SHORTCUTS) {
  const mod = !!(e.ctrlKey || e.metaKey);
  for (const s of table) {
    if (typeof s.match !== 'function') continue;
    try {
      if (s.match(e, mod)) return s.id;
    } catch { /* 单条匹配异常不影响其它键位 */ }
  }
  return null;
}

/** 面板显示用的纯数据（**不含函数** —— 结构化克隆要能把它传回主进程做断言） */
export function shortcutRows(table = SHORTCUTS) {
  return table.map((s) => ({ id: s.id, group: s.group, keys: s.keys, label: s.label }));
}

/**
 * @param {Object} opts
 * @param {Record<string, Function>} opts.actions  id → 动作（app.js 提供；缺失的 id 在面板里标注未接线）
 */
export function createHelp({ actions = {} } = {}) {
  let opened = false;
  let query = '';
  let modalApi = null; // ui.js 的 { openModal, closeModal }（动态 import，顶层不碰 DOM）

  function filtered(q = query) {
    const k = String(q || '').trim().toLowerCase();
    if (!k) return SHORTCUTS.slice();
    return SHORTCUTS.filter((s) =>
      String(s.keys).toLowerCase().includes(k) ||
      String(s.label).toLowerCase().includes(k) ||
      String(s.group).toLowerCase().includes(k) ||
      String(s.id).toLowerCase().includes(k));
  }

  function renderBody(body, listEl, emptyEl, q) {
    const rows = filtered(q);
    listEl.innerHTML = '';
    if (!rows.length) {
      emptyEl.classList.remove('hidden');
      return rows.length;
    }
    emptyEl.classList.add('hidden');
    for (const g of SHORTCUT_GROUPS) {
      const inGroup = rows.filter((r) => r.group === g);
      if (!inGroup.length) continue;
      const box = document.createElement('div');
      box.className = 'help-group';
      const title = document.createElement('div');
      title.className = 'help-group-title';
      title.textContent = g;
      box.appendChild(title);
      for (const r of inGroup) {
        const row = document.createElement('div');
        row.className = 'help-row';
        row.dataset.id = r.id;
        const keys = document.createElement('span');
        keys.className = 'help-keys';
        keys.textContent = r.keys;
        const label = document.createElement('span');
        label.className = 'help-label';
        label.textContent = r.label + (typeof actions[r.id] === 'function' ? '' : '（未接线）');
        row.append(keys, label);
        box.appendChild(row);
      }
      listEl.appendChild(box);
    }
    // 不在 SHORTCUT_GROUPS 里的分组（新增键位时忘了归组）也要显示出来，不能静默丢
    const extra = rows.filter((r) => SHORTCUT_GROUPS.indexOf(r.group) < 0);
    if (extra.length) {
      const box = document.createElement('div');
      box.className = 'help-group';
      const title = document.createElement('div');
      title.className = 'help-group-title';
      title.textContent = '其它';
      box.appendChild(title);
      for (const r of extra) {
        const row = document.createElement('div');
        row.className = 'help-row';
        row.dataset.id = r.id;
        const keys = document.createElement('span');
        keys.className = 'help-keys';
        keys.textContent = r.keys;
        const label = document.createElement('span');
        label.className = 'help-label';
        label.textContent = r.label;
        row.append(keys, label);
        box.appendChild(row);
      }
      listEl.appendChild(box);
    }
    return rows.length;
  }

  /** 打开面板（F1 / Ctrl+/）。已打开时再按 = 关闭（可预期的一次按键一次效果）。 */
  async function open() {
    if (opened) { await close(); return false; }
    if (!modalApi) modalApi = await import('./ui.js');
    const body = document.createElement('div');
    body.className = 'help-panel';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'help-search';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'help-search-input';
    input.placeholder = '筛选：输入键位或功能关键词…';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.id = 'help-count';
    searchWrap.append(input, hint);
    const groups = document.createElement('div');
    groups.className = 'help-groups';
    groups.id = 'help-groups';
    const empty = document.createElement('div');
    empty.className = 'help-empty hidden';
    empty.textContent = '没有匹配的快捷键';
    body.append(searchWrap, groups, empty);
    const paint = () => {
      const n = renderBody(body, groups, empty, input.value);
      hint.textContent = `${n} 条`;
    };
    paint();
    input.addEventListener('input', paint);
    opened = true;
    modalApi.openModal({
      title: '快捷键',
      body,
      onClose: () => { opened = false; },
      actions: [
        { label: '关闭', primary: true, onClick: () => modalApi.closeModal() },
      ],
    });
    setTimeout(() => { try { input.focus(); } catch { /* 忽略 */ } }, 30);
    return true;
  }

  async function close() {
    if (!modalApi) modalApi = await import('./ui.js');
    modalApi.closeModal();
    opened = false;
    return false;
  }

  return {
    open,
    close,
    toggle: () => (opened ? close() : open()),
    isOpen: () => opened,
    setQuery: (q) => { query = q; return q; },
    /** 测试面：面板/键位表的可克隆快照（**不含函数**） */
    getState: () => ({
      open: opened,
      rows: shortcutRows(),
      groups: SHORTCUT_GROUPS.slice(),
      modalOpen: (() => {
        const m = document.getElementById('modal-mask');
        return !!m && !m.classList.contains('hidden');
      })(),
      title: (() => {
        const t = document.getElementById('modal-title');
        return t ? t.textContent : '';
      })(),
      shownRows: Array.from(document.querySelectorAll('#help-groups .help-row')).map((el) => ({
        id: el.dataset.id,
        keys: (el.querySelector('.help-keys') || {}).textContent || '',
        label: (el.querySelector('.help-label') || {}).textContent || '',
      })),
      countText: (() => {
        const c = document.getElementById('help-count');
        return c ? c.textContent : '';
      })(),
      filter: (() => {
        const i = document.getElementById('help-search-input');
        return i ? i.value : '';
      })(),
    }),
    /** 测试面：在当前面板里输入筛选词（真实派发 input 事件） */
    typeFilter: (q) => {
      const i = document.getElementById('help-search-input');
      if (!i) return -1;
      i.value = q;
      i.dispatchEvent(new Event('input'));
      return document.querySelectorAll('#help-groups .help-row').length;
    },
  };
}
