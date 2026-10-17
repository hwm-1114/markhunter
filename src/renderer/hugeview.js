// 大文件虚拟滚动视图（Phase B，v0.4.0；Phase D 第三步加编辑）
//
// 目标：把 >256MB 文件的「8MB 翻页」换成 EmEditor 式**连续滚动** ——
// 滚动条跨度 = 整个文件，渲染只做视口内的几十行，任意位置 O(1) 定位取数。
//
// 取数链路（v0.4.0 改批量）：视口行区间 → **一次** hugeLines（主进程内命中进程内行索引 +
//          单次范围读）→ 直接切片成行 → 放进 DOM。
//          旧实现是「每行一次 hugeLineOffset + 每块一次 hugeOffsetLine + 每块一次 8MB 读」：
//          4000 万行文件上逐行串行 IPC × 每行 stat/解析侧车，一屏实测 170~215ms；
//          批量后一屏只有 1 次 IPC、1 次读盘。
//
// 关键点：
//  - 索引未就绪时先用「估算行数」撑起滚动条（首 4MB 平均行长），就绪后校正，用户不必等索引；
//    v0.8.0 起未就绪期间**不再发取数 IPC**（此前每屏一次 huge:lines 都会在主进程顺带全量建索引、
//    互相踩踏），改画居中占位行，滚动位置由 sizer + scrollTop 照常记录，就绪后一次落位
//  - v0.8.0 焦点/复制/滚轮：root 挂载即 tabIndex=0（只读选中、Ctrl+C、键入即编辑都依赖 keydown
//    到达 root）；Ctrl+C 走 clipboard:write-any-text（有选区复制选区，无选区复制当前行整行原文）；
//    比例模式（scaled）下滚轮按 ±3 行/notch 折算，避免 1px≈2~3 行时一格滚轮跳几百行
//  - 行高由实际渲染测量（等宽字体/皮肤可能不同），保证滚动位置与行号严格对应
//  - 超长行按 CSS 截断显示（不换行），避免 4GB 单行把布局拖垮（主进程已截断到 40000 字符）
//  - 缺行（超长行跨读窗口 / 读到文件末尾）显示为空行，不影响行号与滚动
//
// Phase D 第三步（编辑）：**渲染端不持有文档状态机** —— 编辑/撤销/保存全部经
// `huge:doc-*` 通道打到主进程 overlay（块级 CoW，见 src/main/overlay.js）。
// 这里只做三件事：
//   1) 打开编辑会话（`huge:doc-open`）并按其返回的 `editable` 决定能否进入编辑态
//      （GBK / 二进制 / 超大单块返回 false → 保持只读并把 reason 显示在状态栏）；
//   2) 视口内**光标 + 键盘**最朴素编辑 UI：可打印字符 / Backspace / Delete / Enter /
//      Ctrl+Z / Ctrl+Y / 方向键 + Home/End；光标移动要取当前行**完整**文本（`huge:doc-line`
//      不受 40000 字符截断），因此超长行（> LINE_TEXT_LIMIT）直接拒绝编辑；
//   3) 打开编辑会话后，视口取数从 `huge:lines`（原文件 + 行索引）切到 `huge:doc-lines`
//      （overlay 视角：看得见未保存修改与新行数）—— 这是「编辑后行数 +3」能成立的前提。
import { toast } from './ui.js'; // v0.8.0：复制反馈（与预览代码块复制同一通道/同一提示口径）

const OVERSCAN = 2;                 // 视口上下各多取的屏数（v0.7.0：1→2，快速滚动时视口边缘更少闪白）
const BATCH_MAX_LINES = 1000;       // 单次批量取行上限（与主进程 lineindex.BATCH_MAX_LINES 对齐）
const LINE_TEXT_LIMIT = 40000;      // 超长行入 DOM 前的截断（与主进程 LINE_MAX_CHARS 一致）
const WRAP_MAX_ROWS = 40;           // 自动换行下单个逻辑行最多折成多少个视觉行（40×20px=800px，防布局被单个超长行拖垮）
// Chromium 的布局/滚动高度上限约 33.5M px（超过即被静默截断，表现为"滚不到后面"）。
// 因此：总高 = 行数×行高 超过 MAX_SCROLL_PX 时改用**比例映射**——滚动条只作导航，
// 像素位置 ↔ 行号按比例换算（4GB/4000 万行时 1px ≈ 2~3 行，仍可精确落到目标行）。
const MAX_SCROLL_PX = 16 * 1024 * 1024;

const msgOf = (e) => (e && e.message ? e.message : String(e));

export function createHugeView(host, opts) {
  const api = window.api;
  const filePath = opts.path;
  const size = opts.size;
  const onStatus = opts.onStatus || (() => {});
  const onDirty = opts.onDirty || (() => {}); // 脏标记变化 → 上层（tabs）同步 tab.dirty / 标签徽标

  // v0.4.0：独立容器 —— 只清理/移除自己的 DOM，绝不去动 #editor-host 里的 CodeMirror
  // （此前直接 host.innerHTML='' 会把编辑器 DOM 一并抹掉，属严重隐患）
  const root = document.createElement('div');
  root.className = 'huge-view';
  root.tabIndex = 0; // v0.8.0：挂载即可获焦（此前只在进编辑态才设）——只读选中、Ctrl+C、键入即编辑都靠 keydown 到达 root
  root.innerHTML = '';
  host.appendChild(root);
  // 状态条放最后（在 sizer 之后 → 不占行几何）：sticky bottom 让它在滚动时钉在视口底部，
  // 同时充当编辑 UI 的工具条（启用编辑 / 保存按钮）。
  const status = document.createElement('div');
  status.className = 'huge-status';
  const statusText = document.createElement('span');
  statusText.className = 'huge-status-text';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'huge-btn';
  editBtn.textContent = '✎ 启用编辑';
  // v0.9.0：自动换行开关（状态条里；默认跟随设置 wordWrap，首次读取设置后校正）
  const wrapBtn = document.createElement('button');
  wrapBtn.type = 'button';
  wrapBtn.className = 'huge-btn';
  wrapBtn.textContent = '↵ 自动换行';
  wrapBtn.title = '长行自动折行显示（不改文件内容）';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'huge-btn';
  saveBtn.textContent = '💾 保存';
  saveBtn.disabled = true;
  status.append(statusText, wrapBtn, editBtn, saveBtn);
  const sizer = document.createElement('div');
  sizer.className = 'huge-sizer';
  const rows = document.createElement('div');
  rows.className = 'huge-rows';
  sizer.appendChild(rows);
  root.appendChild(sizer);
  root.appendChild(status);

  let index = null;              // { lines, longest, encoding, binary, cached }
  let indexReady = false;        // v0.9.0：索引**已画出**（= render 用的是整份索引）。供 getState().indexed
                                 //  —— 只置 index 而不等渲染完成会让「indexed=true 但 DOM 还是半屏/占位」成为可观测竞态
  let estLines = 0;              // 索引就绪前的估算行数
  // v0.9.0 自动换行：初值由调用方（tabs.js）按应用级设置 wordWrap 传入；状态条按钮改动时
  // 经 opts.onWordWrapChange 回写设置（app.js 负责落盘并同步 CM 与其它大文件视图）。
  // 只影响显示，不改文件内容。
  let wrap = opts.wordWrap !== false;
  let lastRowH = 0;              // 上次换行渲染的实测平均行高（0 = 还没量过）；用于自适应渲染窗大小
  let lineHeight = 20;           // 由首屏实测校正
  let lineHeightFixed = false;
  let destroyed = false;
  let inflight = false;
  let renderToken = 0;
  let renderedRange = null;      // [first, last] 当前已渲染行
  let pendingScrollTop = null;
  let binarySeen = false;        // 二进制提示只提示一次（索引 binary / 首块探测 / 批量文本三者任一）
  let estBinary = false;         // 首 4MB 探测结果（索引未就绪时的兜底）
  let progressBound = false;     // 进度监听只注册一次
  let offIndexProgress = null;   // 进度监听退订句柄（destroy 时调用，防监听器泄漏）
  let offSaved = null;           // huge:doc-saved 退订句柄（同上）
  let indexRequested = false;    // 索引只请求一次（防重复 loadIndex 重复建索引）
  let indexPct = null;           // 索引建立进度 0~99（占位行文案复用；null=尚未收到进度）
  let indexError = null;         // 索引失败原因（占位行改画错误文案，不永远转圈）
  let placeholderEl = null;      // 当前占位行（进度回调就地更新文案；就绪后随 rows 清空）
  const lastBatch = { lines: 0, bytes: 0, ms: 0 }; // 最近一次批量取数（诊断用，getState 暴露）
  // v0.9.0 实测埋点（纯诊断，零行为影响）：bigperf 探针据此算首屏/滚动/重画耗时与帧稳定性
  const perf = {
    createdAt: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    renders: 0,          // 成功的视口重画次数
    lastRenderMs: 0,     // 最近一次取数 + DOM 落盘的总耗时
    maxRenderMs: 0,
    lastRenderAt: 0,     // 最近一次重画完成时刻（page performance.now 口径）
    firstContentAt: 0,   // 首次画出**真实内容行**（非占位）的时刻
    readMsTotal: 0,      // 累计取数（IPC）耗时
    placeholderRenders: 0,
  };


  // ---------- Phase D：编辑态（渲染端只保存「光标 + 最近一次主进程回执」，不保存文档内容） ----------
  let editable = false;          // 当前是否处于编辑态（视口内可输入）
  let docInfo = null;            // huge:doc-open 的返回（{ docId, editable, reason, lines, ... }）
  let docEditable = false;       // 主进程判定该文件能否编辑（GBK/二进制/超大单块 → false）
  let docEditableKnown = false;  // v0.7.0：docEditable 是否已经主进程判定过（false=还没查，不能当"不可编辑"用）
  let docReason = '';            // 不可编辑原因（原样显示给用户）
  let docLines = 0;              // overlay 视角的总行数（编辑后与 lineindex 的原文件行数不同）
  let dirty = false;
  let dirtyCount = 0;
  let undoDepth = 0;
  let redoDepth = 0;
  let canUndo = false;
  let canRedo = false;
  let caret = null;              // { line, col, text, oversize }：光标行 + 该行**完整**文本（col 为字符下标）
  let editChain = Promise.resolve(); // 编辑串行链：连续按键按顺序落到主进程（主进程同 doc 也已串行锁）
  let saving = false;            // 保存进行中（防重入；同时挡住编辑按钮的语义混乱）
  let savedAt = 0;               // 最近一次保存的起点时刻（自写回声守卫：file-changed 据此忽略自家写入）

  /** 总行数：打开编辑会话后以 overlay 视角为准（否则编辑后行数不会变） */
  const totalLines = () => (docInfo != null && docLines > 0 ? docLines : (index ? index.lines : estLines)) || 1;
  const isScaled = () => totalLines() * lineHeight > MAX_SCROLL_PX;
  const maxScroll = () => Math.max(1, sizerHeight() - (root.clientHeight || 0));

  /** 二进制提示（常驻状态栏，只提示一次） */
  function markBinary() {
    if (binarySeen || destroyed) return;
    binarySeen = true;
    baseStatus();
  }

  /** 状态文案：本地状态条 + 外部回调（tabs 把它同步到应用状态栏 #sb-len） */
  function setStatus(msg) {
    if (destroyed) return;
    statusText.textContent = msg || '';
    onStatus(msg || '');
  }

  /** 状态栏基准文案：脏标记优先，其次索引失败/二进制提示，再次「索引建立中…」 */
  function baseStatus() {
    if (destroyed) return;
    if (dirty) { setStatus(`未保存修改 ${dirtyCount || 1} 处 —— Ctrl+S 保存（Ctrl+Z 撤销）`); return; }
    if (indexError != null) { setStatus('索引失败：' + indexError); return; }
    if (binarySeen) { setStatus('二进制内容：按文本近似显示'); return; }
    setStatus(index || docInfo ? '' : '索引建立中…');
  }

  // ---------- 索引 ----------
  /** 占位行文案：索引失败优先，其次带进度百分比的「建立中」 */
  function placeholderText(scannedLines, scannedBytes, totalBytes) {
    if (indexError != null) return `索引失败：${indexError} —— 可关闭标签后重开重试`;
    // v0.9.0：渐进索引建立中——已扫描前缀可读，告诉用户「能滚到哪一行」
    const pct = indexPct != null ? indexPct + '%' : (scannedBytes && totalBytes ? Math.min(99, Math.round((scannedBytes / totalBytes) * 100)) + '%' : '…');
    const hint = scannedLines > 0
      ? ` —— 已扫 ${scannedLines.toLocaleString()} 行（可先滚到该行以内）`
      : '';
    return `索引建立中 ${pct} —— 可拖动滚动条定位，就绪后自动落位${hint}`;
  }

  /** 索引未就绪时的占位渲染：**不发任何取数 IPC**，只画一行居中提示（钉在视口中央，随滚动跟随） */
  function renderPlaceholder(info) {
    if (destroyed) return;
    renderedRange = null; // 就绪后必须走真渲染，别被「位置未变」短路
    perf.placeholderRenders++;
    rows.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'huge-line huge-placeholder';
    el.style.top = Math.max(0, Math.floor(((root.clientHeight || 0) - lineHeight) / 2)) + 'px';
    el.style.justifyContent = 'center';
    if (indexError != null) el.style.color = 'var(--mh-err, #d64545)';
    else el.style.color = 'var(--mh-text-2)';
    el.textContent = placeholderText(info && info.scannedLines, info && info.scannedBytes, info && info.totalBytes);
    rows.appendChild(el);
    rows.style.height = ''; // 回到 inset:0 的满高（真渲染可能把高度改成块高，占位沿用满高才居中）
    rows.style.transform = 'translateY(' + root.scrollTop + 'px)'; // 与真渲染同口径：跟随视口
    placeholderEl = el;
  }

  // v0.9.0：渐进索引期间的占位重试（扫描推进 → 已扫描前缀变长 → 尽快把真实内容换上来）。
  // 80ms 合并，避免每次进度事件都触发一次 IPC。
  let provisionalTimer = null;
  function scheduleProvisionalRender() {
    if (destroyed || provisionalTimer || index || docInfo) return;
    provisionalTimer = setTimeout(() => {
      provisionalTimer = null;
      if (!destroyed && !index && !docInfo) render();
    }, 80);
  }

  async function loadIndex() {
    indexError = null; // 重载（reloadExternal）时清掉上一次的失败/进度残留
    indexPct = null;
    // 先估算：读首 4MB 求平均行长，立即撑起滚动条；这次读取同时充当二进制探测的兜底样本
    try {
      const r = await api.readFileRange(filePath, 0, Math.min(4 * 1024 * 1024, size));
      const bytes = (r && r.bytes) || new ArrayBuffer(0);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const nl = (text.match(/\n/g) || []).length;
      const avg = nl > 0 ? text.length / nl : 120;
      estLines = Math.max(1, Math.round(size / Math.max(8, avg)));
      try { estBinary = new Uint8Array(bytes).includes(0); } catch { estBinary = false; }
      if (estBinary) markBinary();
      applySizer();
    } catch { estLines = Math.max(1, Math.round(size / 120)); applySizer(); }
    // v0.9.0：估算行数一就位就补一帧真渲染（挂载时首次 render 只知道 totalLines=1，只画 1 行）。
    // 这里读的是「已扫描前缀 / 文件头」，不等 huge:index 全量扫完 → 首屏是满屏内容而不是一行。
    void render();

    // 进度订阅：只注册一次并保存退订句柄（此前每次 loadIndex 都注册、destroy 不摘 → 监听器泄漏）
    if (!progressBound) {
      progressBound = true;
      try {
        const off = api.onHugeIndexProgress((d) => {
          if (destroyed || !d || d.file !== filePath) return;
          indexPct = Math.min(99, Math.round((d.done / Math.max(1, d.total)) * 100));
          if (!binarySeen && !dirty) setStatus(`索引建立中 ${indexPct}%`); // 二进制/脏标记优先，不被进度文案覆盖
          if (placeholderEl && placeholderEl.isConnected) placeholderEl.textContent = placeholderText();
          scheduleProvisionalRender(); // 扫描推进 → 已扫描前缀变长，尽快换成真实内容
        });
        offIndexProgress = typeof off === 'function' ? off : null; // 旧 preload 不返回退订函数
      } catch { /* 订阅失败不影响查看 */ }
    }

    if (indexRequested) return;
    indexRequested = true;
    try {
      index = await api.hugeIndex(filePath);
      if (destroyed) return;
      if (index && index.binary) markBinary();
      else baseStatus();
      applySizer();
      await render();               // 行号口径变了，重画当前视口（此刻起走真渲染，落位当前 scrollTop）
      indexReady = !destroyed;      // 只有「整份索引已画出」才算就绪（避免 indexed/DOM 不一致的竞态）
      baseStatus();                 // 刷一次状态栏：否则「共 N 行（索引建立中）」会停在渲染那一刻的快照
    } catch (err) {
      indexError = msgOf(err);
      setStatus('索引失败：' + indexError);
      renderPlaceholder();          // 占位换成错误文案，不永远转圈
    }
  }

  /** 滚动条总高：自动换行时在末尾补一屏空白 —— 直映模式下 maxScroll = n*lh - clientH 只能滚到
   *  倒数第 N 行；换行后每行可能占好几行高，末尾那几行会永远落在视口外（够不着）。补一屏后
   *  滚到底时 firstVisibleLine 能到 n，最后一行可以被顶到视口顶部完整阅读。 */
  function sizerHeight() {
    const base = isScaled() ? MAX_SCROLL_PX : totalLines() * lineHeight;
    return base + (wrap && !isScaled() ? (root.clientHeight || 0) : 0);
  }

  function applySizer() {
    sizer.style.height = sizerHeight() + 'px';
  }

  // ---------- 渲染 ----------
  /** 视口首行：比例模式按滚动比例换算，直映模式按行高换算（末尾补白时可能算术越界，夹到 n） */
  function firstVisibleLine() {
    const n = totalLines();
    if (isScaled()) return Math.max(1, Math.min(n, 1 + Math.round((root.scrollTop / maxScroll()) * (n - 1))));
    return Math.max(1, Math.min(n, Math.floor(root.scrollTop / lineHeight) + 1));
  }

  function measureLineHeight() {
    if (lineHeightFixed) return;
    const probe = rows.querySelector('.huge-line');
    if (!probe) return;
    // 换行模式下 probe 可能是多行高，不能拿来当行高；行高取 CSS 的 line-height（固定 20px）
    const h = wrap ? (parseFloat(getComputedStyle(probe).lineHeight) || lineHeight) : probe.getBoundingClientRect().height;
    if (h > 4 && Math.abs(h - lineHeight) > 0.5) {
      lineHeight = h;
      lineHeightFixed = true;
      applySizer();
    }
  }

  /** 取视口行：打开编辑会话后必须走 huge:doc-lines（overlay 视角，看得见未保存修改） */
  async function readWindow(from, count) {
    if (docInfo != null && docInfo.docId != null) {
      const r = await api.hugeDocLines({ docId: docInfo.docId, from, count });
      if (r) {
        if (typeof r.totalLines === 'number' && r.totalLines > 0) docLines = r.totalLines;
        if (typeof r.dirty === 'boolean') setDirty(r.dirty, r.dirtyCount);
      }
      return r;
    }
    return await api.hugeLines(filePath, from, count);
  }

  async function render() {
    if (destroyed) return;
    // v0.9.0：**不再**「索引未就绪就不取数」。huge:lines 现在能服务「已扫描前缀」，
    // 首行甚至不用等索引（主进程直接从文件头读），所以索引建立期间就能出字并跟随滚动。
    // 目标行尚未扫到时主进程返回 pending（不阻塞），这里画进度占位，进度事件驱动重试。
    const token = ++renderToken;
    const lh = lineHeight;
    // 宿主可能瞬时高度为 0（标签切换/布局未完成）→ 保底 8 行，避免 to < from 算出空视图
    const perScreen = Math.max(8, Math.ceil((root.clientHeight || 0) / lh) || 30);
    const first = firstVisibleLine();
    // v0.9.0：总行数未知（挂载瞬间 estLines=0）时也要画满一屏 —— 旧实现 totalLines() 兜底 1，
    // 首帧只画 1 行；大文件冷开时「1 行 → 满屏」之间会被外部读到（冒烟 hugeSelectCopy 曾因此拿不到选区）。
    const totalKnown = !!(index || docInfo || estLines > 0);
    // 渲染窗大小：换行模式下每行可能占好几个视觉行，5 屏逻辑行会变成几十屏 DOM（长行文件里
    // 实测 180 行 × 180px = 32,000px），既拖慢布局又浪费；按「平均行长 / 上次实测行高」折算
    // 真正需要的逻辑行数（上 1~2 屏、下 2 屏），未换行或短行文件保持原窗口。
    let above = perScreen * OVERSCAN;
    let count = Math.max(1, Math.min(BATCH_MAX_LINES, perScreen * (1 + OVERSCAN * 2)));
    if (wrap) {
      const availW = Math.max(120, (root.clientWidth || 800) - 90);
      const charsPerRow = Math.max(16, Math.floor(availW / 7.8));
      const avgChars = totalKnown ? Math.max(1, (size || 0) / Math.max(1, totalLines())) : 0;
      const estRowH = lastRowH > 0 ? lastRowH : (avgChars > charsPerRow ? lh * Math.ceil(avgChars / charsPerRow) : lh);
      if (estRowH > lh * 1.5) {
        const need = Math.max(4, Math.ceil(((root.clientHeight || 600) * 2) / estRowH) + 6);
        count = Math.max(4, Math.min(count, need * 2));
        above = Math.max(1, Math.min(perScreen * OVERSCAN, need));
      }
    }
    const from = Math.max(1, first - above);
    const to = totalKnown ? Math.min(totalLines(), from + count - 1) : from + count - 1;
    if (renderedRange && renderedRange[0] === from && renderedRange[1] === to && pendingScrollTop === null) {
      // 位置未变（例如索引校正后行数变化不大）→ 跳过重画
      return;
    }
    inflight = true;
    try {
      // 一次 IPC 取整个视口（含上下各一屏 overscan）：彻底去掉逐行 await 的串行往返
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const res = await readWindow(from, to - from + 1);
      if (destroyed || token !== renderToken) return; // 已有更新请求：放弃本次
      if (res && res.pending) {
        // 索引建立中且目标行还没扫到：画进度占位（progress 事件会让本函数重跑）
        renderPlaceholder(res);
        return;
      }
      const got = new Map();
      let batchBinary = false;
      if (res && Array.isArray(res.lines)) {
        for (const it of res.lines) {
          if (!it || typeof it.line !== 'number' || it.line < from || it.line > to) continue;
          got.set(it.line, it);
          // 兜底：本批文本里出现 NUL 也按二进制处理（索引未就绪 / 侧车为旧版本时）
          if (!binarySeen && typeof it.text === 'string' && it.text.indexOf('\u0000') >= 0) batchBinary = true;
        }
      }
      if (batchBinary || estBinary || (index && index.binary)) markBinary();
      lastBatch.lines = got.size;
      lastBatch.bytes = (res && res.bytes) || 0;
      lastBatch.ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 10) / 10;

      const caretLine = editable && caret ? caret.line : -1;
      const caretCol = editable && caret ? caret.col : 0;
      const frag = document.createDocumentFragment();
      // 换行模式下每行可能折成很多个视觉行：按「可用宽度 / 单字符宽」估算每行字符数，
      // 单行最多画 WRAP_MAX_ROWS 个视觉行（40 × 20px = 800px），超出部分截断并提示。
      // 不设上限的话，40000 字符的单行会折成 5 万多像素高的一个绝对定位元素，直接拖垮布局。
      const wrapMaxChars = wrap
        ? Math.min(LINE_TEXT_LIMIT, Math.max(64, Math.floor(Math.max(120, (root.clientWidth || 800) - 90) / 7.8)) * WRAP_MAX_ROWS)
        : LINE_TEXT_LIMIT;
      for (let ln = from; ln <= to; ln++) {
        const it = got.get(ln) || { text: '', line: ln }; // 缺行占位（读到末尾/超长行跨窗口）
        const el = document.createElement('div');
        el.className = 'huge-line';
        el.style.top = (ln - from) * lh + 'px'; // 视口内相对定位（换行模式下由下方按实测高度重排）
        el.dataset.line = String(ln);
        const no = document.createElement('span');
        no.className = 'huge-no';
        no.textContent = String(ln);
        const tx = document.createElement('span');
        tx.className = 'huge-text';
        // 超长行（含"无换行的 GB 级单行文件"）：入 DOM 前截断，否则单行文本节点可达数 MB
        // （主进程已按 LINE_MAX_CHARS 截断并给出 truncated/chars，这里再兜一层，防旧 preload 直连）
        const raw = it.text == null ? '' : String(it.text);
        const cut = it.truncated || raw.length > wrapMaxChars;
        const shown = cut
          ? raw.slice(0, wrapMaxChars) + (it.chars ? ` …（本行共 ${it.chars} 字符，已截断显示）` : ' …（超长行，已截断显示）')
          : raw;
        if (ln === caretLine && !cut) {
          // 光标行：文本按光标列切成 前/光标/后 三段（光标用零宽 span 画，不做 DOM 选择）
          el.classList.add('huge-line-active');
          const c = Math.max(0, Math.min(shown.length, caretCol));
          tx.appendChild(document.createTextNode(shown.slice(0, c)));
          const cur = document.createElement('span');
          cur.className = 'huge-caret';
          tx.appendChild(cur);
          tx.appendChild(document.createTextNode(shown.slice(c)));
        } else {
          tx.textContent = shown;
        }
        el.append(no, tx);
        frag.appendChild(el);
      }
      rows.innerHTML = '';
      rows.appendChild(frag);
      // v0.9.0：锚点修正 —— 把「视口首行 first」钉在视口顶部。
      // 旧实现 translateY(scrollTop) 等价于把渲染窗**整体上移 (first - from) 行 = 2 屏**：
      // 实测跳转到第 2000 万行时，DOM 视口顶部是第 19,999,930 行（差 72 行），
      // 文件末尾那几十行永远滚不到、所见即所编辑也落错行。这里统一按「块内偏移」定位：
      //   translateY = scrollTop - (first 在块内的偏移) - 行内小数偏移
      // 非换行直映模式下它恒等于 (from-1)*lineHeight（即绝对文档位置），行为与视觉一致。
      const firstIdx = Math.max(0, Math.min(rows.children.length - 1, first - from));
      let offsetFirst = firstIdx * lh;
      if (wrap) {
        const kids = rows.children;
        // 两趟：先只读高度（一次布局），再只写 top（一次样式重算），避免读写交错触发 N 次重排
        const hs = new Array(kids.length);
        for (let i = 0; i < kids.length; i++) hs[i] = Math.max(lh, kids[i].offsetHeight || lh);
        let y = 0;
        for (let i = 0; i < kids.length; i++) {
          kids[i].style.top = y + 'px';
          if (i === firstIdx) offsetFirst = y;
          y += hs[i];
        }
        rows.style.height = y + 'px';
        lastRowH = kids.length ? y / kids.length : 0;
      } else {
        rows.style.height = (to - from + 1) * lh + 'px';
        lastRowH = lh;
      }
      const frac = isScaled() ? 0 : Math.max(0, Math.min(lh - 1, root.scrollTop - (first - 1) * lh));
      rows.style.transform = 'translateY(' + (root.scrollTop - offsetFirst - frac) + 'px)';
      renderedRange = [from, to];
      measureLineHeight();
      baseStatus();
      // 诊断埋点：一次成功重画的耗时（取数 IPC + DOM 重建）与首屏真实内容时刻
      try {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        perf.renders++;
        perf.readMsTotal += lastBatch.ms;
        perf.lastRenderMs = Math.round(t0 ? (now - t0) : 0);
        if (perf.lastRenderMs > perf.maxRenderMs) perf.maxRenderMs = perf.lastRenderMs;
        perf.lastRenderAt = now;
        if (!perf.firstContentAt && got.size > 0 && rows.childElementCount > 0) perf.firstContentAt = now;
      } catch { /* 诊断失败不影响渲染 */ }
    } catch (err) {
      // 编辑会话已被主进程释放（保存后关窗/被外部关闭）→ 退回只读读法，别把视图卡死
      if (docInfo && /文档句柄不存在|文档已关闭|DOC_GONE/.test(msgOf(err))) {
        docInfo = null; docLines = 0; editable = false;
        try { root.classList.remove('huge-editable'); } catch { /* 忽略 */ }
      }
      setStatus('读取失败：' + msgOf(err));
    } finally {
      inflight = false;
      if (pendingScrollTop !== null && !destroyed) {
        const target = pendingScrollTop;
        pendingScrollTop = null;
        root.scrollTop = target;
        render();
      }
    }
  }

  let scrollTimer = null;
  function onScroll() {
    if (destroyed) return;
    if (inflight) { pendingScrollTop = root.scrollTop; return; }
    renderedRange = null; // 比例模式下同一像素区间可能对应不同行，滚动即重算
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(render, 16); // 合并高频滚动事件
  }
  root.addEventListener('scroll', onScroll, { passive: true });

  // v0.8.0：scaled（比例映射）模式下滚轮按行滚动。该模式 1px ≈ 2~3 行，原生像素滚动一格
  // 滚轮（deltaY≈120 → 一百多 px）会一跳几百行，完全没法逐行细读；拦下来换算成
  // ±3 行/notch（Shift=±1 屏），走既有 scrollToLine 定位链路。非 scaled 保持原生像素滚动。
  // passive:false 才能 preventDefault；触控板小步长累加到满 1 行再动，避免高频小位移空转渲染。
  let wheelCarry = 0;
  function onWheel(e) {
    if (destroyed || !isScaled()) return;
    if (e.ctrlKey || e.metaKey) return; // Ctrl+滚轮（缩放类手势）不拦
    e.preventDefault();
    const perScreen = Math.max(8, Math.ceil((root.clientHeight || 0) / lineHeight) || 30);
    if (e.shiftKey) {
      wheelCarry = 0;
      const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (dir) void scrollToLine(firstVisibleLine() + dir * perScreen);
      return;
    }
    // deltaMode：0=像素（Chromium，1 notch≈120）、1=行（1 notch≈3 行）——统一折算成 notch 数
    const notches = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 120;
    wheelCarry += notches * 3;
    const lines = Math.trunc(wheelCarry); // 向零取整，余量留进累加器
    if (!lines) return;
    wheelCarry -= lines;
    void scrollToLine(firstVisibleLine() + lines);
  }
  root.addEventListener('wheel', onWheel, { passive: false });

  // ---------- 对外 API ----------
  async function scrollToLine(line) {
    const n = totalLines();
    const l = Math.max(1, Math.min(n, Math.floor(line) || 1));
    root.scrollTop = isScaled() ? ((l - 1) / Math.max(1, n - 1)) * maxScroll() : (l - 1) * lineHeight;
    renderedRange = null; // 强制重画（比例模式下位置变化不一定改变首行号）
    await render();
    return l;
  }
  async function scrollToPercent(p) {
    const pct = Math.max(0, Math.min(100, Number(p) || 0));
    return scrollToLine(Math.round((totalLines() * pct) / 100) || 1);
  }

  // ---------- Phase D：编辑原语（全部经 huge:doc-* 通道；渲染端只做位置翻译） ----------
  /** 串行链：连续按键按顺序落到主进程（链尾永不 reject，单次失败不断链） */
  function queue(fn) {
    const run = editChain.then(fn);
    editChain = run.then(() => {}, () => {});
    return run;
  }

  function setDirty(d, count) {
    const was = dirty;
    dirty = d === true;
    dirtyCount = Math.max(0, Number(count) || 0);
    if (!destroyed) {
      saveBtn.disabled = !dirty || saving;
      editBtn.textContent = editable ? '✎ 退出编辑' : '✎ 启用编辑';
      editBtn.classList.toggle('on', editable);
      editBtn.disabled = saving;
    }
    if (was !== dirty) { try { onDirty(dirty, dirtyCount); } catch { /* 上层异常不影响编辑 */ } }
  }

  /** 打开主进程侧编辑会话（幂等：同 realpath 主进程复用句柄）；只在用户要编辑时才开 */
  async function ensureDoc() {
    if (docInfo) return docInfo;
    const r = await api.hugeDocOpen({ file: filePath });
    if (destroyed) return null;
    docInfo = r || null;
    if (docInfo) {
      docEditable = docInfo.editable === true;
      docEditableKnown = true;
      docReason = docInfo.reason || '';
      if (typeof docInfo.lines === 'number' && docInfo.lines > 0) docLines = docInfo.lines;
      setDirty(false, 0);
      applySizer(); // 行数口径换成 overlay 的（与行索引一致时无变化）
      // 保存成功通知：主进程已 force 重建行索引 → 这里刷新行数/滚动高度
      if (!offSaved) {
        try {
          const off = api.onHugeDocSaved((d) => {
            if (destroyed || !d || !docInfo) return;
            if (d.docId != null && d.docId !== docInfo.docId) return; // 只认本文档
            if (typeof d.lines === 'number' && d.lines > 0) docLines = d.lines;
            setDirty(false, 0);
            applySizer();
            renderedRange = null;
            refreshIndexAfterSave();
          });
          offSaved = typeof off === 'function' ? off : null;
        } catch { /* 旧 preload 不返回退订函数/无该事件：保存仍可用 */ }
      }
    }
    return docInfo;
  }

  /** 保存后刷新行索引（主进程已 force 重建，这里命中其进程内缓存）→ 校正行数与滚动高度 */
  async function refreshIndexAfterSave() {
    try {
      const idx = await api.hugeIndex(filePath);
      if (!destroyed && idx && typeof idx.lines === 'number') index = idx;
    } catch { /* 索引刷新失败不影响保存结果 */ }
    if (destroyed) return;
    applySizer();
    renderedRange = null;
    await render();
  }

  /** 主进程权威状态（行数/脏计数/撤销栈深度）—— 撤销栈只在主进程，渲染端不重建 */
  async function syncDocState() {
    if (!docInfo || destroyed) return null;
    try {
      const s = await api.hugeDocState({ docId: docInfo.docId });
      if (!s || destroyed) return null;
      if (typeof s.lines === 'number' && s.lines > 0) docLines = s.lines;
      undoDepth = Number(s.undoDepth) || 0;
      redoDepth = Number(s.redoDepth) || 0;
      canUndo = s.canUndo === true;
      canRedo = s.canRedo === true;
      if (typeof s.editable === 'boolean') { docEditable = s.editable; docEditableKnown = true; }
      setDirty(s.dirty === true, s.dirtyCount);
      return s;
    } catch (err) {
      setStatus('读取编辑状态失败：' + msgOf(err));
      return null;
    }
  }

  /** 取某行**完整**文本（huge:doc-line 不受 40000 字符截断；超长行标记 oversize 拒绝编辑） */
  async function loadLineText(ln) {
    const r = await api.hugeDocLine({ docId: docInfo.docId, line: ln });
    const text = r && r.text != null ? String(r.text) : '';
    return { text, oversize: text.length > LINE_TEXT_LIMIT };
  }

  /** 落光标并重画（**不排链**：供已在链内的编辑原语复用，避免自锁） */
  async function placeCaret(line, col) {
    if (destroyed || !docInfo) return null;
    const n = totalLines();
    const ln = Math.max(1, Math.min(n, Math.floor(line) || 1));
    let got;
    try {
      got = await loadLineText(ln);
    } catch (err) {
      setStatus('读取行失败：' + msgOf(err));
      return null;
    }
    const c = col == null ? got.text.length : Math.max(0, Math.min(got.text.length, Math.floor(col)));
    caret = { line: ln, col: c, text: got.text, oversize: got.oversize };
    if (renderedRange && (ln < renderedRange[0] || ln > renderedRange[1])) await scrollToLine(ln);
    else { renderedRange = null; await render(); }
    return caret;
  }

  /** 公开的光标定位（排队执行） */
  function moveCaret(line, col) {
    return queue(() => placeCaret(line, col));
  }

  /** 编辑回执统一收尾：行数/脏标记/撤销深度 + 光标复位 + 重画 */
  async function afterEdit(r, nextLine, nextCol) {
    if (destroyed) return;
    if (r && typeof r.lines === 'number' && r.lines > 0) docLines = r.lines;
    if (r && typeof r.dirty === 'boolean') setDirty(r.dirty, r.dirtyCount);
    applySizer();
    await syncDocState();
    await placeCaret(nextLine, nextCol);
  }

  /** v0.9.0 单行编辑快路径收尾：**不再**每次按键都 syncDocState + loadLineText（串行 3 个 IPC）。
   *  行文本在本地按 IPC 回执的前提推出来（主进程执行的正是同一处替换），只重画一次视口；
   *  下一次按键用的是同一份文本，列号不会漂。跨行编辑/未知文本仍走 afterEdit 的权威路径。 */
  async function afterEditFast(r, nextLine, nextCol, nextText) {
    if (destroyed) return;
    if (r && typeof r.lines === 'number' && r.lines > 0) docLines = r.lines;
    if (r && typeof r.dirty === 'boolean') setDirty(r.dirty, r.dirtyCount);
    // 撤销栈深度由主进程随编辑回执一起给（省掉每键一次 huge:doc-state 的串行 IPC）
    if (r && typeof r.undoDepth === 'number') {
      undoDepth = r.undoDepth;
      redoDepth = Number(r.redoDepth) || 0;
      canUndo = r.canUndo === true || undoDepth > 0;
      canRedo = r.canRedo === true;
    }
    applySizer();
    if (nextText == null) { await afterEdit(r, nextLine, nextCol); return; }
    caret = { line: nextLine, col: nextCol, text: nextText, oversize: nextText.length > LINE_TEXT_LIMIT };
    baseStatus();
    renderedRange = null;
    await render();
  }

  function editReady() {
    if (destroyed) return false;
    if (!editable || !docInfo || !caret) return false;
    if (caret.oversize) { setStatus('当前行超过 40000 字符（已截断显示），暂不支持编辑'); return false; }
    return true;
  }

  /** 光标处插入文本（含 \n 即裂成多行）；返回是否成功 */
  function opInsertText(text) {
    if (!editReady()) return Promise.resolve(false);
    const s = String(text == null ? '' : text);
    if (!s) return Promise.resolve(false);
    const line = caret.line;
    const col = caret.col;
    const cur = caret.text;
    const nlCount = (s.match(/\n/g) || []).length;
    const nextLine = line + nlCount;
    const nextCol = nlCount > 0 ? s.length - s.lastIndexOf('\n') - 1 : col + s.length;
    // 单行内插入：结果文本本地可推（与主进程执行的替换逐字一致）→ 走快路径
    const nextText = nlCount === 0 ? (cur.slice(0, col) + s + cur.slice(col)) : null;
    return queue(async () => {
      try {
        const r = await api.hugeDocInsert({ docId: docInfo.docId, line, col, text: s });
        await afterEditFast(r, nextLine, nextCol, nextText);
        return true;
      } catch (err) { setStatus('编辑失败：' + msgOf(err)); return false; }
    });
  }

  /** 区间删除（跨行自动合并首尾行）；next* 为删除后的光标落点 */
  function opDeleteRange(fromLine, fromCol, toLine, toCol, nextLine, nextCol) {
    if (!editReady()) return Promise.resolve(false);
    // 同一行内的删除：结果文本本地可推 → 快路径
    const nextText = (fromLine === toLine && caret && caret.line === fromLine)
      ? (caret.text.slice(0, fromCol) + caret.text.slice(toCol))
      : null;
    return queue(async () => {
      try {
        const r = await api.hugeDocDelete({ docId: docInfo.docId, fromLine, fromCol, toLine, toCol });
        await afterEditFast(r, nextLine, nextCol, nextText);
        return true;
      } catch (err) { setStatus('编辑失败：' + msgOf(err)); return false; }
    });
  }

  function opBackspace() {
    if (!editReady()) return Promise.resolve(false);
    const { line, col, text } = caret;
    if (col > 0) return opDeleteRange(line, col - 1, line, col, line, col - 1);
    if (line <= 1) return Promise.resolve(false);
    // 行首退格 = 并入上一行（先取上一行完整长度）
    return queue(async () => {
      let prev;
      try { prev = await loadLineText(line - 1); } catch (err) { setStatus('编辑失败：' + msgOf(err)); return false; }
      try {
        const r = await api.hugeDocDelete({
          docId: docInfo.docId, fromLine: line - 1, fromCol: prev.text.length, toLine: line, toCol: 0,
        });
        await afterEdit(r, line - 1, prev.text.length);
        return true;
      } catch (err) { setStatus('编辑失败：' + msgOf(err)); return false; }
    });
  }

  function opDeleteForward() {
    if (!editReady()) return Promise.resolve(false);
    const { line, col, text } = caret;
    if (col < text.length) return opDeleteRange(line, col, line, col + 1, line, col);
    if (line >= totalLines()) return Promise.resolve(false);
    return opDeleteRange(line, text.length, line + 1, 0, line, text.length);
  }

  function opUndo() {
    if (!editable || !docInfo) return Promise.resolve(false);
    return queue(async () => {
      try {
        const r = await api.hugeDocUndo({ docId: docInfo.docId });
        if (r && typeof r.lines === 'number' && r.lines > 0) docLines = r.lines;
        undoDepth = Number(r && r.undoDepth) || 0;
        redoDepth = Number(r && r.redoDepth) || 0;
        canUndo = !!(r && r.canUndo);
        canRedo = !!(r && r.canRedo);
        setDirty(!!(r && r.dirty), r && r.dirtyCount);
        applySizer();
        const ln = caret ? Math.min(caret.line, totalLines()) : Math.max(1, firstVisibleLine());
        await placeCaret(ln, caret ? caret.col : 0);
        return !!(r && r.undone);
      } catch (err) { setStatus('撤销失败：' + msgOf(err)); return false; }
    });
  }

  function opRedo() {
    if (!editable || !docInfo) return Promise.resolve(false);
    return queue(async () => {
      try {
        const r = await api.hugeDocRedo({ docId: docInfo.docId });
        if (r && typeof r.lines === 'number' && r.lines > 0) docLines = r.lines;
        undoDepth = Number(r && r.undoDepth) || 0;
        redoDepth = Number(r && r.redoDepth) || 0;
        canUndo = !!(r && r.canUndo);
        canRedo = !!(r && r.canRedo);
        setDirty(!!(r && r.dirty), r && r.dirtyCount);
        applySizer();
        const ln = caret ? Math.min(caret.line, totalLines()) : Math.max(1, firstVisibleLine());
        await placeCaret(ln, caret ? caret.col : 0);
        return !!(r && r.redone);
      } catch (err) { setStatus('重做失败：' + msgOf(err)); return false; }
    });
  }

  /**
   * Ctrl+C 复制闭环（v0.8.0，只读/编辑两态都拦）：
   *  - 有 DOM 选区 → 复制选中文本；
   *  - 无选区 → 复制当前行（编辑态=光标行、只读态=视口首行）。
   *  整行一律经 huge:doc-line / hugeLines / hugeDocLines 取**原文**（**不读 DOM** —— DOM 有
   *  40000 字符截断）；主进程仍可能截断超长行（LINE_MAX_CHARS）→ 截断复制并在提示里说明。
   *  通道与预览代码块复制相同（clipboard:write-any-text；file:// 下 navigator.clipboard 不可用）。
   */
  async function copySelectionOrLine() {
    if (destroyed) return;
    try {
      const sel = window.getSelection ? String(window.getSelection()) : '';
      if (sel) {
        await api.writeClipboardText(sel);
        if (!destroyed) toast(`已复制选中内容（${sel.length} 字符）`);
        return;
      }
      if (editable && caret && docInfo && docInfo.docId != null) {
        // 编辑态：光标行完整原文（huge:doc-line 不受 40000 截断）
        const got = await loadLineText(caret.line);
        if (destroyed) return;
        await api.writeClipboardText(got.text);
        toast(`已复制第 ${caret.line} 行（${got.text.length} 字符）`);
        return;
      }
      // 只读态：视口首行；readWindow 按会话状态自动走 hugeDocLines/hugeLines（所见即所得）
      const ln = firstVisibleLine();
      const r = await readWindow(ln, 1);
      if (destroyed) return;
      const it = r && Array.isArray(r.lines)
        ? r.lines.find((x) => x && x.line === ln) || r.lines[0]
        : null;
      const text = it && it.text != null ? String(it.text) : '';
      if (!text) { setStatus(`第 ${ln} 行无内容可复制`); return; }
      await api.writeClipboardText(text);
      const total = it && typeof it.chars === 'number' && it.chars > text.length ? it.chars : 0;
      if ((it && it.truncated) || total) {
        toast(`已复制第 ${ln} 行（超长行被截断：复制前 ${text.length} 字符${total ? ` / 共 ${total}` : ''}）`);
      } else {
        toast(`已复制第 ${ln} 行（${text.length} 字符）`);
      }
    } catch (err) {
      setStatus('复制失败：' + msgOf(err));
      toast('复制失败：' + msgOf(err));
    }
  }

  /** 视口内键盘：可打印字符 / Backspace / Delete / Enter / Ctrl+Z / Ctrl+Y / 方向键 / Home / End。
   *  其余组合键（Ctrl+S、Ctrl+G 等）不拦截 —— 冒泡给 app.js 的全局快捷键。 */
  function onKeyDown(e) {
    if (destroyed) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod && (key === 'z' || key === 'Z')) { e.preventDefault(); void (e.shiftKey ? opRedo() : opUndo()); return; }
    if (mod && (key === 'y' || key === 'Y')) { e.preventDefault(); void opRedo(); return; }
    // v0.8.0：Ctrl+C 复制（选区优先，无选区复制当前行）；file:// 下系统默认复制不可靠，走 IPC 通道
    if (mod && (key === 'c' || key === 'C')) { e.preventDefault(); void copySelectionOrLine(); return; }
    if (mod || e.altKey) return; // 组合键交给全局（Ctrl+S / Ctrl+G / Ctrl+F…）
    // v0.7.0：**首次键入自动进入编辑**（打开即可改，无需先点「✎ 启用编辑」）。本键消费掉
    //（开启是异步 IPC），下一次键入即正常落字；能否编辑仍由主进程 editable 决定（二进制/
    // GBK → 保持只读并显示原因）。光标落在当前视口首行 —— 「所见即所编辑」。
    if (!editable) {
      if (key.length === 1 || key === 'Enter' || key === 'Backspace' || key === 'Delete') {
        e.preventDefault();
        if (!docEditableKnown || docEditable) void setEditable(true);
      }
      return;
    }
    if (!editReady()) { if (key.length === 1 || key === 'Enter' || key === 'Backspace') e.preventDefault(); return; }
    // v0.7.0：「所见即所编辑」—— 滚到别处后直接打字落在**当前视口**而不是把视口拽回旧光标行。
    const fv = firstVisibleLine();
    const perScr = Math.max(8, Math.ceil((root.clientHeight || 0) / (lineHeight || 20)) || 30);
    const caretOffscreen = caret.line < fv || caret.line > fv + perScr + OVERSCAN * 2;
    const reCaret = caretOffscreen
      ? queue(() => placeCaret(fv, 0))
      : Promise.resolve();
    const { line, col, text } = caret;
    switch (key) {
      case 'Enter': e.preventDefault(); void reCaret.then(() => opInsertText('\n')); return;
      case 'Backspace': e.preventDefault(); void reCaret.then(() => opBackspace()); return;
      case 'Delete': e.preventDefault(); void reCaret.then(() => opDeleteForward()); return;
      case 'ArrowLeft':
        e.preventDefault();
        if (col > 0) void moveCaret(line, col - 1);
        else if (line > 1) void moveCaret(line - 1, null);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (col < text.length) void moveCaret(line, col + 1);
        else if (line < totalLines()) void moveCaret(line + 1, 0);
        return;
      case 'ArrowUp': e.preventDefault(); void moveCaret(line - 1, col); return;
      case 'ArrowDown': e.preventDefault(); void moveCaret(line + 1, col); return;
      case 'Home': e.preventDefault(); void moveCaret(line, 0); return;
      case 'End': e.preventDefault(); void moveCaret(line, null); return;
      case 'PageUp': case 'PageDown': return; // 让浏览器滚屏（光标不动）
      default: break;
    }
    if (key.length === 1) { e.preventDefault(); void reCaret.then(() => opInsertText(key)); }
  }
  root.addEventListener('keydown', onKeyDown);

  /** 视口内点击 → 只读态交焦点（建选区靠浏览器默认行为）；编辑态落光标（真实点击列优先，否则行尾） */
  function onRowsMouseDown(e) {
    if (destroyed || e.button !== 0) return;
    if (!editable) {
      // v0.8.0：只读态点击把焦点交给 root（Ctrl+C / 键入即编辑都靠 keydown 到达 root）。
      // 刻意**不** preventDefault —— 默认行为是从按下点开始建立文本选区，拦掉它
      // 「选中文字」就没了（与 Ctrl+C 复制闭环直接冲突）。
      try { root.focus({ preventScroll: true }); } catch { /* 忽略 */ }
      return;
    }
    const rowEl = e.target && e.target.closest ? e.target.closest('.huge-line') : null;
    if (!rowEl) return;
    const ln = parseInt(rowEl.dataset.line, 10);
    if (!Number.isFinite(ln)) return;
    e.preventDefault(); // 编辑态自绘光标：不让浏览器拖出 DOM 选区
    try { root.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    let col = null;
    try {
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      const node = r && r.startContainer;
      if (node && node.nodeType === 3 && node.parentElement && node.parentElement.classList.contains('huge-text')) {
        const prev = node.previousSibling;
        // 光标行被切成 前/光标/后 三段：落在「后」段时真实列 = 光标列 + 段内偏移
        col = prev && prev.classList && prev.classList.contains('huge-caret') && caret && caret.line === ln
          ? caret.col + r.startOffset
          : r.startOffset;
      }
    } catch { col = null; }
    void moveCaret(ln, col);
  }
  root.addEventListener('mousedown', onRowsMouseDown);

  editBtn.addEventListener('click', () => { void setEditable(!editable); });
  saveBtn.addEventListener('click', () => { void save(); });

  /** 应用换行样式（root 上加类，CSS 负责 white-space/高度自适应） */
  function applyWrapClass() {
    if (destroyed) return;
    try { root.classList.toggle('huge-wrap', wrap); } catch { /* 忽略 */ }
    try { wrapBtn.classList.toggle('on', wrap); } catch { /* 忽略 */ }
  }

  /** 切换自动换行：重算滚动条（末尾补一屏）+ 重画视口。
   *  @param {boolean} on
   *  @param {boolean} [notify] true（默认）= 用户点的、回写应用级设置；false = 外部同步（不再回调，避免环） */
  function setWrap(on, notify) {
    const next = on === true;
    if (next === wrap) return;
    wrap = next;
    applyWrapClass();
    lastRowH = 0; // 换行口径变了：行高估计作废，按新口径重新量
    applySizer();
    renderedRange = null;
    if (!destroyed) { try { root.focus({ preventScroll: true }); } catch { /* 忽略 */ } }
    void render();
    if (notify !== false && typeof opts.onWordWrapChange === 'function') {
      try { opts.onWordWrapChange(next); } catch { /* 上层失败不影响本视图 */ }
    }
  }
  wrapBtn.addEventListener('click', () => { setWrap(!wrap); });

  applyWrapClass();

  /**
   * 进入/退出编辑态。
   * 进入时打开 overlay 编辑会话（huge:doc-open），**能否编辑由主进程返回的 editable 决定**：
   * GBK / 二进制 / 超大单块等返回 false → 保持只读并把 reason 显示在状态栏。
   * @returns {Promise<boolean>} 是否处于编辑态
   */
  async function setEditable(on) {
    if (destroyed) return false;
    if (on !== true) {
      editable = false;
      caret = null;
      if (!destroyed) {
        root.classList.remove('huge-editable');
        renderedRange = null;
        await render();
        if (dirty) setStatus(`未保存修改 ${dirtyCount || 1} 处（已退出编辑，Ctrl+S 仍可保存）`);
        else baseStatus();
      }
      return false;
    }
    if (!docInfo) {
      setStatus('正在打开编辑会话…');
      try { await ensureDoc(); } catch (err) { setStatus('进入编辑失败：' + msgOf(err)); return false; }
    }
    if (!docInfo) { setStatus('进入编辑失败：主进程未返回文档句柄'); return false; }
    if (docInfo.editable !== true) {
      editable = false;
      root.classList.remove('huge-editable');
      setStatus('只读：' + (docReason || '该文件不支持大文件编辑'));
      return false;
    }
    editable = true;
    root.classList.add('huge-editable');
    // tabIndex 挂载时已设（v0.8.0），这里只需夺回焦点（用户可能刚点过状态栏按钮）
    try { root.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    try { await syncDocState(); } catch { /* 状态取不到不影响编辑 */ }
    if (!caret) {
      const start = renderedRange ? renderedRange[0] : firstVisibleLine();
      await placeCaret(Math.max(1, Math.min(totalLines(), start)), null);
    } else {
      renderedRange = null;
      await render();
    }
    setStatus(`编辑已启用（第 ${caret ? caret.line : 1} 行）—— 直接输入即可，Ctrl+S 保存，Ctrl+Z 撤销`);
    return true;
  }

  /** 是否有未保存修改（**权威来源是主进程**：这里返回最近一次回执/状态查询的值） */
  function isDirty() {
    return dirty;
  }

  /**
   * 保存：`huge:doc-save`（主进程原子全量重写：拷贝干净块 + overlay 分片 → 临时文件 → fsync →
   * 校验字节数 → rename）。保存期间订阅 `huge:doc-save-progress` 显示进度并**在 finally 退订**；
   * 成功后主进程会重建行索引并发 `huge:doc-saved`（本视图据此刷新行数与滚动高度）。
   * @returns {Promise<boolean>} true = 已保存（或无改动），false = 失败
   */
  async function save() {
    if (destroyed) return false;
    if (!editable && dirty) setStatus('未保存修改需在编辑态保存（点击「✎ 启用编辑」）');
    if (!docInfo || docInfo.docId == null) {
      if (dirty) { setStatus('保存失败：编辑会话已失效，请重新打开编辑'); return false; }
      return true; // 只读且无改动：等价于「无需保存」
    }
    if (saving) { setStatus('正在保存中…'); return false; }
    if (!dirty) { setStatus('没有未保存的修改'); return true; }
    saving = true;
    savedAt = Date.now(); // 保存起点即打点：rename 到 markSelfWrite 之间的 fs.watch 事件可能先到（见 tabs 的守卫）
    saveBtn.disabled = true;
    editBtn.disabled = true;
    let off = null;
    try {
      try {
        const sub = api.onHugeDocSaveProgress((d) => {
          if (destroyed || !d || !docInfo) return;
          if (d.docId != null && d.docId !== docInfo.docId) return;
          if (d.phase === 'failed') { setStatus('保存失败：' + (d.error || '未知错误')); return; }
          if (d.phase === 'done') return; // 终态由 huge:doc-saved / save 返回值统一收尾
          const pct = d.total ? Math.floor((Number(d.done) || 0) / d.total * 100) : 0;
          const label = d.phase === 'copy' ? '写入' : d.phase === 'verify' ? '校验' : '替换';
          setStatus(`保存中 ${pct}%（${label}）…`);
        });
        off = typeof sub === 'function' ? sub : null;
      } catch { /* 旧 preload 无该订阅：保存结果不受影响 */ }
      const r = await api.hugeDocSave({ docId: docInfo.docId });
      if (destroyed) return false;
      if (r && typeof r.lines === 'number' && r.lines > 0) docLines = r.lines;
      else if (r && r.rebased && typeof r.rebased.lines === 'number' && r.rebased.lines > 0) docLines = r.rebased.lines;
      setDirty(false, 0);
      undoDepth = 0;
      redoDepth = 0;
      canUndo = false;
      canRedo = false;
      await refreshIndexAfterSave(); // 行数/滚动高度按新索引校正
      setStatus(r && r.skipped === true ? '磁盘无变化（无未保存修改）' : '已保存');
      return true;
    } catch (err) {
      setStatus('保存失败：' + msgOf(err));
      return false;
    } finally {
      // 退订进度监听（无论成功/失败/取消；否则监听器随保存次数累积泄漏）
      if (typeof off === 'function') { try { off(); } catch { /* 忽略 */ } }
      saving = false;
      if (!destroyed) { saveBtn.disabled = !dirty; editBtn.disabled = false; }
    }
  }

  /**
   * 关闭主进程侧编辑会话（tabs.closeTab 在 destroy 之前调用）。
   * discard=false → 有未保存修改时主进程保留 overlay 块表（供崩溃恢复）；
   * **两种情况都不会写源文件**（删除/移走场景因此不会「复活」文件）。
   */
  async function closeDoc(discard) {
    if (!docInfo || docInfo.docId == null) return null;
    const id = docInfo.docId;
    docInfo = null;
    docLines = 0;
    editable = false;
    const p = (async () => {
      try { return await api.hugeDocClose({ docId: id, discard: discard === true }); }
      catch { return null; }
    })();
    // 保存中关闭：先打断，避免 rename 之后句柄已释放
    if (saving) { try { await api.hugeDocSaveCancel({ docId: id }); } catch { /* 忽略 */ } }
    return await p;
  }

  /**
   * 测试友好薄封装（**仅供冒烟脚本**，注释即用途声明）：
   * 把一次编辑意图按与键盘处理**完全相同**的路径交给主进程（huge:doc-insert / delete / edit /
   * undo / redo），免去在真实窗口里合成逐字符键盘事件的时序不确定性；真实键盘路径另由
   * Ctrl+Z / 输入字符用例覆盖（同一套 opXxx 原语）。
   * @param {object} op {type:'insert'|'delete'|'edit'|'undo'|'redo', line?, col?, text?,
   *                      fromLine?, fromCol?, toLine?, toCol?, from?, deleteCount?, lines?}
   * @returns {Promise<object|null>} 主进程编辑摘要（含 lines/dirty/undoDepth…），失败为 null
   */
  async function applyEditForTest(op = {}) {
    if (!docInfo || docInfo.docId == null || !editable) return null;
    const docId = docInfo.docId;
    return await queue(async () => {
      try {
        let r;
        if (op.type === 'insert') {
          r = await api.hugeDocInsert({ docId, line: op.line, col: op.col == null ? 0 : op.col, text: String(op.text == null ? '' : op.text) });
        } else if (op.type === 'delete') {
          r = await api.hugeDocDelete({
            docId, fromLine: op.fromLine, fromCol: op.fromCol == null ? 0 : op.fromCol,
            toLine: op.toLine == null ? op.fromLine : op.toLine, toCol: op.toCol == null ? 0 : op.toCol,
          });
        } else if (op.type === 'edit') {
          r = await api.hugeDocEdit({
            docId, from: op.from, deleteCount: op.deleteCount == null ? 0 : op.deleteCount,
            lines: Array.isArray(op.lines) ? op.lines : [],
          });
        } else if (op.type === 'undo') {
          r = await api.hugeDocUndo({ docId });
        } else if (op.type === 'redo') {
          r = await api.hugeDocRedo({ docId });
        } else {
          return null;
        }
        if (r && typeof r.lines === 'number' && r.lines > 0) docLines = r.lines;
        if (r && typeof r.dirty === 'boolean') setDirty(r.dirty, r.dirtyCount);
        applySizer();
        await syncDocState();
        const ln = caret ? Math.min(caret.line, totalLines()) : Math.max(1, firstVisibleLine());
        await placeCaret(ln, caret ? caret.col : 0);
        return r || null;
      } catch (err) { setStatus('编辑失败：' + msgOf(err)); return null; }
    });
  }

  /**
   * 外部修改后的重载（tabs 的 file-changed 处理调用；语义对齐 viewer-lg 的「丢弃本地更改后重载」）：
   * 丢弃本地编辑会话（discard:true 让主进程删掉 overlay 分片，**绝不写盘**）→ 丢弃行索引缓存 →
   * 按新文件重建估算/索引并重画。base 已变（size/mtime）时主进程本来也会拒绝保存，
   * 因此这里是「把视图拉回磁盘现状」的唯一正确做法。
   */
  async function reloadExternal() {
    if (destroyed) return false;
    try { await closeDoc(true); } catch { /* 无会话/已失效：忽略 */ }
    docInfo = null;
    docLines = 0;
    editable = false;
    caret = null;
    setDirty(false, 0);
    try { root.classList.remove('huge-editable'); } catch { /* 忽略 */ }
    try { await api.hugeIndexDrop(filePath); } catch { /* 主进程无缓存：忽略 */ }
    index = null;
    indexReady = false;
    indexRequested = false;
    estLines = 0;
    renderedRange = null;
    await loadIndex(); // 重新估算 + 重建索引（内部完成后再重画一次）
    return true;
  }

  // 尺寸变化走与滚动同口径的 16ms 合并：拖窗口边框期间逐帧触发，逐帧 render 就是逐帧 IPC
  // （批量取行）。applySizer 是廉价同步操作（只改 sizer 高度）保持即时，render 合并到帧末。
  const onResize = () => {
    if (destroyed) return;
    applySizer();
    renderedRange = null;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(render, 16);
  };
  window.addEventListener('resize', onResize);
  // 宿主尺寸变化（切换标签/面板开合/窗口缩放）后重算视口行数
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(host);

  applySizer();
  render();
  loadIndex();
  // v0.7.0：**首次键入自动进入编辑**（onKeyDown 里触发，见 hugeview 的键处理）—— 体验上
  // 等同「打开即可编辑」：直接打字就行，不需要先点「✎ 启用编辑」。刻意**不在挂载时**自动
  // 开会话：打开→跳转→编辑的快速序列里，挂载即开的编辑链与滚动/光标放置存在时序纠缠
  //（实测会把视口拽回文件头），而「键入时开启」天然把光标落在用户所见的位置。

  return {
    path: filePath,
    scrollToLine,
    scrollToPercent,
    async gotoLine(n) { return scrollToLine(n); },
    refresh: () => { renderedRange = null; return render(); },
    // ---- Phase D 编辑（对外方法）----
    setEditable,
    isDirty,
    save,
    closeDoc,
    moveCaret,
    reloadExternal,
    /** v0.9.0：外部同步应用级 wordWrap（设置页/其它窗口改动 → 本视图跟随；不回调，避免环） */
    setWrapPreference(on) { setWrap(on === true, false); },
    /** 测试友好薄封装（仅冒烟用；见函数注释） */
    applyEditForTest,
    getState: () => ({
      lines: totalLines(),
      // 真实视口首行（比例/直映两模式统一换算）：tabs.js 的 hugeTopLine 采集器用它 ——
      // 不能用 rendered.from 反推（v0.7.0 OVERSCAN 1→2 后渲染窗起点语义变了，反推会偏一屏）
      firstLine: firstVisibleLine(),
      indexed: (!!index && indexReady) || !!docInfo,
      indexedLines: index ? index.lines : null,
      encoding: index ? index.encoding : (docInfo ? docInfo.encoding : null),
      binary: binarySeen || !!(index && index.binary),
      lineHeight,
      wrap, // v0.9.0：自动换行开关（状态条按钮；探针/冒烟可断言）
      lastBatch: { lines: lastBatch.lines, bytes: lastBatch.bytes, ms: lastBatch.ms },
      // v0.9.0 实测埋点（bigperf 探针消费；对产品行为零影响）
      perf: { ...perf, now: (typeof performance !== 'undefined' ? performance.now() : Date.now()) },
      rendered: renderedRange ? { from: renderedRange[0], to: renderedRange[1] } : null,
      renderedRows: rows.childElementCount,
      scrollTop: root.scrollTop,
      // 编辑态（冒烟与状态栏共用）
      docId: docInfo ? docInfo.docId : null,
      editable,
      docEditable,
      editableReason: docReason,
      dirty,
      dirtyCount,
      undoDepth,
      redoDepth,
      canUndo,
      canRedo,
      saving,
      savedAt,
      caret: caret ? { line: caret.line, col: caret.col, textLength: caret.text.length, oversize: caret.oversize } : null,
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(scrollTimer);
      // 退订索引进度监听（preload 返回退订函数；旧 preload 返回 undefined 时跳过）
      if (typeof offIndexProgress === 'function') {
        try { offIndexProgress(); } catch { /* 忽略 */ }
      }
      if (typeof offSaved === 'function') {
        try { offSaved(); } catch { /* 忽略 */ }
      }
      offIndexProgress = null;
      offSaved = null;
      if (ro) { try { ro.disconnect(); } catch { /* 忽略 */ } }
      window.removeEventListener('resize', onResize);
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('mousedown', onRowsMouseDown);
      placeholderEl = null;
      rows.innerHTML = '';
      root.innerHTML = '';
      try { root.remove(); } catch { /* 已移除 */ }
    },
  };
}
