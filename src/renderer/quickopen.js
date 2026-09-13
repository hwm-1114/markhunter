// ============================================================================
// quickopen.js —— Ctrl+P 快速打开（0.5.0 Phase 5a A1）
// ============================================================================
// 数据源 = **search-worker 的文件清单**（`window.api.searchFiles(dir)`，与全局搜索共用同一套
//   walk()/SKIP_DIRS 过滤口径 ⇒ "清单里有 = 搜得到"，不会出现两套目录规则）。三件事保证
//   "大目录首扫不卡顿"：
//     ① **流式**：worker 每 200 个文件回一批（'search:files-progress'），本模块收到即增量匹配
//        （用户按下 Ctrl+P 后第一批通常已经在路上，不必等整目录扫完）；
//     ② **缓存**：worker 按目录缓存整份清单（LRU 8 个目录），第二次呼出是毫秒级命中；
//     ③ **渲染上限**：结果只渲染前 RENDER_MAX 行（匹配与排序是纯内存操作，不做全量 DOM）。
//
// 安全面：只读**目录清单**（文件名），不新增任何读文件内容的通道 —— 打不开的文件由
//   editor.openFile 自己按既有规则拒绝。
import { $ } from './ui.js';

const RENDER_MAX = 200; // 结果列表最多渲染多少行

/** 模糊匹配打分：命中越靠前、越连续、名字越短 → 分越高；不匹配返回 -1。
 *  a) 前缀命中 1000 分档；b) 子串命中 700 分档（越靠后越低）；
 *  c) 子序列命中（如 "qta" → "qo-target-alpha.md"）400 分档，间隔（gap）越多越低。 */
export function fuzzyScore(name, q) {
  const n = String(name).toLowerCase();
  const query = String(q).toLowerCase();
  if (!query) return 0;
  const idx = n.indexOf(query);
  if (idx === 0) return 1000 - n.length * 0.1;
  if (idx > 0) return 700 - idx * 2 - n.length * 0.1;
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of query) {
    const p = n.indexOf(ch, i);
    if (p < 0) return -1;
    if (last >= 0) gaps += p - last - 1;
    last = p;
    i = p + 1;
  }
  return 400 - gaps - n.length * 0.1;
}

/** 文件路径排序打分：先看文件名，未命中再看整条路径（路径档整体降权 200） */
export function pathScore(file, q) {
  const base = String(file).replace(/\\/g, '/').split('/').pop() || String(file);
  const s = fuzzyScore(base, q);
  if (s >= 0) return s;
  const p = fuzzyScore(file, q);
  return p < 0 ? -1 : p - 200;
}

/** 纯函数：在文件清单里做模糊匹配 + 排序（可单测；UI 与用例共用同一条路径） */
export function matchFiles(files, query, limit = RENDER_MAX) {
  const q = String(query || '').trim();
  if (!q) {
    const head = files.slice(0, limit);
    return { rows: head, total: files.length, matched: files.length };
  }
  const scored = [];
  for (const f of files) {
    const s = pathScore(f, q);
    if (s >= 0) scored.push({ f, s });
  }
  scored.sort((a, b) => (b.s - a.s) || (a.f.length - b.f.length) || (a.f < b.f ? -1 : 1));
  return { rows: scored.slice(0, limit).map((x) => x.f), total: files.length, matched: scored.length };
}

/**
 * @param {Object} opts
 * @param {() => string|null} opts.getRootDir  当前工作目录（快速打开只在该目录内匹配）
 * @param {(path: string) => void} opts.onOpen 打开选中的文件
 */
export function createQuickOpen({ getRootDir, onOpen }) {
  // ---------- DOM（懒建：首次 Ctrl+P 才插入，启动路径零成本） ----------
  let rootEl = null;
  let inputEl = null;
  let metaEl = null;
  let listEl = null;

  function ensureDom() {
    if (rootEl && rootEl.isConnected) return;
    rootEl = document.createElement('div');
    rootEl.className = 'quick-open hidden';
    rootEl.id = 'quick-open';
    const box = document.createElement('div');
    box.className = 'qo-box';
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = 'qo-input';
    inputEl.placeholder = '快速打开：输入文件名（支持模糊匹配，↑↓ 选择，Enter 打开，Esc 关闭）';
    metaEl = document.createElement('div');
    metaEl.className = 'qo-meta';
    metaEl.id = 'qo-meta';
    listEl = document.createElement('div');
    listEl.className = 'qo-list';
    listEl.id = 'qo-list';
    box.append(inputEl, metaEl, listEl);
    rootEl.appendChild(box);
    document.body.appendChild(rootEl);
    // 点遮罩关闭（点 box 内部不关）
    rootEl.addEventListener('mousedown', (e) => { if (e.target === rootEl) close(); });
    inputEl.addEventListener('input', () => { selected = 0; render(); });
    inputEl.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 中文输入法选字期间不拦截
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  // ---------- 状态 ----------
  let files = [];          // 当前目录的清单（增量累积）
  let seen = new Set();
  let root = null;         // 清单对应的目录
  let loading = false;
  let ready = false;       // 该目录的清单已完整（缓存/扫完）
  let truncated = false;
  let errMsg = '';
  let rows = [];           // 当前匹配结果（路径数组）
  let matched = 0;
  let selected = 0;
  let offProgress = null;
  let seq = 0;
  let lastScan = 0;

  const isOpen = () => !!rootEl && !rootEl.classList.contains('hidden');

  async function loadFiles(force) {
    const dir = getRootDir();
    if (!dir) { files = []; seen = new Set(); ready = true; root = null; errMsg = '请先打开一个工作目录'; render(); return; }
    if (!force && dir === root && ready) return; // 本次会话已就绪（worker 侧也有缓存，重复请求是毫秒级）
    if (dir !== root) { root = dir; files = []; seen = new Set(); ready = false; truncated = false; errMsg = ''; }
    if (loading) return;
    loading = true;
    renderMeta();
    const mySeq = ++seq;
    if (offProgress) { offProgress(); offProgress = null; }
    offProgress = window.api.onSearchFilesProgress((d) => {
      if (mySeq !== seq || !d || !Array.isArray(d.files) || !d.files.length) return;
      let added = 0;
      for (const f of d.files) if (!seen.has(f)) { seen.add(f); files.push(f); added++; }
      if (typeof d.scanned === 'number') lastScan = d.scanned;
      if (added) render(); else renderMeta();
    });
    try {
      const r = await window.api.searchFiles(dir);
      if (mySeq !== seq) return;
      if (r && Array.isArray(r.files) && r.files.length) {
        files = r.files.slice(); // 完成态以 worker 的整份清单为准（覆盖增量累积的结果）
        seen = new Set(files);
      }
      truncated = !!(r && r.truncated);
      ready = true;
    } catch (err) {
      if (mySeq === seq) errMsg = String((err && err.message) || err);
    } finally {
      if (mySeq === seq) {
        loading = false;
        if (offProgress) { offProgress(); offProgress = null; }
        render();
      }
    }
  }

  function move(delta) {
    if (!rows.length) return;
    selected = (selected + delta + rows.length) % rows.length;
    paintSelection(true);
  }

  function choose() {
    const p = rows[selected];
    if (!p) return;
    close();
    try { onOpen(p); } catch (err) { console.warn('[quickopen]', err && err.message ? err.message : err); }
  }

  function baseName(p) {
    return String(p).replace(/\\/g, '/').split('/').pop() || p;
  }
  function dirName(p) {
    const parts = String(p).replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.join('/');
  }

  /** 只更新选中行（键盘上下移动走这里，避免整表重建） */
  function paintSelection(scroll) {
    if (!listEl) return;
    const els = listEl.querySelectorAll('.qo-row');
    els.forEach((el, i) => el.classList.toggle('current', i === selected));
    const cur = els[selected];
    if (cur && scroll) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderMeta() {
    if (!metaEl) return;
    const dirText = root ? root : '（未打开目录）';
    if (errMsg) { metaEl.textContent = errMsg; return; }
    const parts = [`${files.length} 个文件`];
    if (matched !== files.length) parts.push(`匹配 ${matched}`);
    if (loading) parts.push(`扫描中…（已发现 ${files.length}）`);
    else if (truncated) parts.push('已截断（前 20000 个）');
    parts.push(dirText);
    metaEl.textContent = parts.join(' · ');
  }

  function render() {
    if (!listEl) return;
    const res = matchFiles(files, inputEl ? inputEl.value : '');
    rows = res.rows;
    matched = res.matched;
    if (selected >= rows.length) selected = rows.length ? 0 : -1;
    listEl.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'qo-empty';
      empty.textContent = errMsg ? errMsg : (loading ? '正在扫描目录…' : '没有匹配的文件');
      listEl.appendChild(empty);
      renderMeta();
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'qo-row' + (i === selected ? ' current' : '');
      row.dataset.path = p;
      row.title = p;
      const name = document.createElement('span');
      name.className = 'qo-name';
      name.textContent = baseName(p);
      const dir = document.createElement('span');
      dir.className = 'qo-dir';
      dir.textContent = dirName(p);
      row.append(name, dir);
      row.addEventListener('mouseenter', () => { selected = i; paintSelection(false); });
      row.addEventListener('click', () => { selected = i; choose(); });
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
    renderMeta();
  }

  /** 让浮层输入框拿到焦点。**同步先做一次**：浮层 DOM 在本次按键处理内就已挂载且可聚焦，
   *  用户（与用例）在"按完 Ctrl+P 的下一帧"就该能直接打字 —— 只挂 setTimeout(20ms) 会让
   *  「打开之后立刻查 document.activeElement」看到旧焦点（冒烟实测就是这个）。
   *  定时器只作兜底（极少数环境下按键默认行为会把焦点夺回去），且仅在焦点不在输入框时补一次
   *  （不反复 select 打断用户已经开始的输入）。 */
  function focusInput() {
    try {
      inputEl.focus({ preventScroll: true });
      inputEl.select();
    } catch { /* 环境不支持 preventScroll 等：忽略 */ }
  }

  function open() {
    ensureDom();
    rootEl.classList.remove('hidden');
    inputEl.value = '';
    selected = 0;
    render();
    loadFiles(false); // 有缓存即时出结果；首次则流式增量出现
    focusInput();
    setTimeout(() => { if (document.activeElement !== inputEl) focusInput(); }, 20);
    return true;
  }

  function close() {
    if (!rootEl) return false;
    rootEl.classList.add('hidden');
    seq++;                    // 让在途的清单回调失效（不清 worker 缓存，下次呼出仍可命中）
    if (offProgress) { offProgress(); offProgress = null; }
    loading = false;
    return true;
  }

  function toggle() {
    return isOpen() ? (close(), false) : open();
  }

  return {
    open,
    close,
    toggle,
    isOpen,
    /** 测试面：不依赖 DOM 也能断言匹配口径 */
    match: (q) => matchFiles(files, q),
    /** 测试面：强制重扫（走 worker 的缓存判定；第二轮应 cached=true） */
    reload: () => loadFiles(true),
    /** 测试面：当前清单条数（判断"复用 search-worker 清单"是否命中缓存） */
    fileCount: () => files.length,
    getState: () => ({
      open: isOpen(),
      query: inputEl ? inputEl.value : '',
      total: files.length,
      matched,
      rendered: listEl ? listEl.querySelectorAll('.qo-row').length : 0,
      selected,
      selectedPath: rows[selected] || null,
      loading,
      ready,
      root,
      error: errMsg,
      meta: metaEl ? metaEl.textContent : '',
    }),
  };
}
