// ============================================================================
// 崩溃恢复：消费主进程的 huge:doc-recover-list（0.4.0 挂账项的渲染端实现）
// ----------------------------------------------------------------------------
// 背景：大文件（kind='huge'）的未保存编辑只存在于主进程 overlay 文档的块表里；崩溃/强杀后
//   块表留在 <userData>/overlay/<sha1>.json（块表）+ <sha1>.tmp（overlay 字节仓库），
//   主进程只提供 huge:doc-recover-list（列表）——**没有**「把块表重挂回文档」的通道
//   （0.4.0 计划表里的 huge:doc-recover 从未实现，且 src/main/overlay*.js 属禁区），
//   所以恢复在这里完成：读恢复区 → 两道身份闸 → 按 run **倒序**回放 huge:doc-edit。
//
// 【身份校验是硬要求】绝不用过期块表覆盖用户文件：
//   闸① `api.stat(file)` 的 size / floor(mtime) 必须等于 meta.size / meta.mtimeMs
//        （meta.mtimeMs 与 docKey 同口径，都是 Math.floor）——不匹配立刻拒绝，**连文件都不打开**；
//   闸② `huge:doc-open` 返回的 key（= sha1(realpath|size|floor(mtime)|version)，overlay.js:121-126）
//        必须等于 item.key —— 拦住 realpath 漂移，以及「闸①通过后、打开前文件又变了」的竞态。
//   两道闸任一不过 ⇒ 拒绝 + 红字文案，且**不写源文件**（恢复只进主进程内存与 overlay 分片）。
//
// 【字节保真为什么成立】恢复区的 overlay 块正文就是 <sha1>.tmp 的原字节；回放走
//   huge:doc-edit（= overlay.spliceLines）：文本 = lines.join('\n') + trailingNewline
//   （overlay.js:854-858），正是 splitBlockText/joinBlockText（overlay.js:225-238）的逆运算，
//   且 \r 保留在行文本里 ⇒ CRLF、末尾无换行都能原样还原（%TEMP% 探针 17/17，含跨块/整篇/EOF 追加）。
//
// 【为什么倒序】目标行号在**干净文档**上一次算完；从后往前应用，前面的行号不会被后续编辑的
//   增删行污染（升序应用得自己维护行号偏移，易错）。
//
// 【可测性】window.__app.recover 暴露 getState/list/refresh/openDialog/recover/discard
//   （dev 独有，见 app.js 的 __app 段）；冒烟用例据此断言 DOM 文案 + 主进程行数 + 磁盘事实。
// ============================================================================
import { openModal, closeModal, note } from './ui.js';

const OVL_VERSION = 1; // 与 src/main/overlay.js 的 OVL_VERSION 对齐（进 docKey：版本不符即失效）

/** Windows 路径拼接（overlay 目录来自主进程 path.join；两种分隔符都兜住） */
function joinPath(dir, name) {
  const d = String(dir || '');
  if (!d) return String(name || '');
  if (d.endsWith('\\') || d.endsWith('/')) return d + name;
  return d + (d.indexOf('/') >= 0 && d.indexOf('\\') < 0 ? '/' : '\\') + name;
}

/** 把 IPC 回来的二进制统一成 Uint8Array（Electron 传 Buffer 时渲染端拿到 Uint8Array；也可能是 ArrayBuffer） */
function toBytes(v) {
  if (!v) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v.buffer && typeof v.byteLength === 'number') return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
  return null;
}

/** 行数组拆分：与 overlay.js splitBlockText（225-232）逐字对齐（\r 留在行文本里） */
function splitBlockText(text, endsNL) {
  const t = text == null ? '' : String(text);
  if (t === '') return [];
  const segs = t.split('\n');
  if (endsNL === true) segs.pop(); // 末尾换行是「行终止符」，不产生额外空行
  return segs;
}

/** 读文本文件：`fs:read-file` 的真实返回面是 `{ content, size, mtime, encoding }`（ipc.js:166），
 *  探针/旧 preload 也可能给字符串或字节 → 三种形状都兜住（返回面差异不能让恢复直接失败）。 */
async function readTextFile(api, p) {
  const r = await api.readFile(p);
  if (typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  const buf = toBytes(r && (r.bytes || r));
  if (!buf) return '';
  return new TextDecoder('utf-8').decode(buf);
}

/**
 * 把 meta.blocks 里**连续的 overlay 块**合成「run」。
 * srcFrom/srcTo 是**源文件字节区间**（不是行号）：块表按顺序铺满源文件，file 块自带
 * start/bytes，因此一个 overlay 段的源区间 = 「上一块源区间末尾 .. 下一个 file 块的 start」
 * （没有后续 file 块时取 meta.size）——这段区间正是当初那次编辑替换掉的原文范围。
 */
function buildRuns(meta) {
  const blocks = Array.isArray(meta && meta.blocks) ? meta.blocks : [];
  const runs = [];
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] || {};
    if (b.kind === 'file') { cursor = Number(b.start) + Number(b.bytes); continue; }
    let end = i;
    while (end + 1 < blocks.length && (blocks[end + 1] || {}).kind === 'overlay') end++;
    let srcTo = Number(meta.size) || 0;
    for (let j = end + 1; j < blocks.length; j++) {
      if ((blocks[j] || {}).kind === 'file') { srcTo = Number(blocks[j].start); break; }
    }
    runs.push({ srcFrom: cursor, srcTo, parts: blocks.slice(i, end + 1) });
    cursor = srcTo;
    i = end;
  }
  return runs;
}

/**
 * @param {{api:object, editor:{openFile:Function, findTabByPath?:Function}}} deps
 */
export function createRecover({ api, editor } = {}) {
  const state = { dir: '', items: [], lastError: '', lastOk: '', busy: false };
  const chipText = (n) => `⏱ 可恢复 ${n} 项`;

  function chipEl() {
    return document.getElementById('sb-recover');
  }

  function renderChip() {
    const el = chipEl();
    if (!el) return;
    const n = state.items.length;
    el.classList.toggle('hidden', n === 0);
    el.textContent = n > 0 ? chipText(n) : '';
    el.title = n > 0 ? `发现 ${n} 项未保存的大文件编辑（崩溃恢复）—— 点击查看` : '';
  }

  /** 本窗口是否已经打开该文件（同 realpath 的活会话自己也会写块表，不该列成"待恢复"） */
  function isOpenHere(file) {
    try {
      if (!editor || typeof editor.findTabByPath !== 'function') return false;
      return !!editor.findTabByPath(file);
    } catch {
      return false;
    }
  }

  /** 拉一次恢复区列表（主进程扫 <userData>/overlay/*.json，只留含 overlay 块的表） */
  async function refresh(opts = {}) {
    const announce = opts.announce === true;
    let r = null;
    try {
      r = await api.hugeDocRecoverList({ limit: 50 });
    } catch (err) {
      state.dir = state.dir || '';
      state.items = [];
      renderChip();
      if (announce) state.lastError = '读取恢复区失败：' + msgOf(err);
      return state.items;
    }
    state.dir = (r && r.dir) || '';
    const all = r && Array.isArray(r.items) ? r.items : [];
    state.items = all.filter((it) => it && it.file && !isOpenHere(it.file));
    renderChip();
    if (announce && state.items.length) {
      // 非模态提示：不阻塞输入、不抢焦点（冒烟里也不会拦住既有用例）
      note(`发现 ${state.items.length} 项未保存的大文件编辑，点状态栏「${chipText(state.items.length)}」查看`);
    }
    return state.items;
  }

  function msgOf(err) {
    if (err && err.message) return String(err.message);
    return String(err == null ? '未知错误' : err);
  }

  /** 弹窗内的红字/说明行（用例据此断言拒绝文案） */
  function setMsg(text, kind) {
    const el = document.getElementById('recover-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.toggle('recover-error', kind === 'error');
  }

  function fail(text) {
    state.lastError = text;
    setMsg(text, 'error');
    return { ok: false, reason: text };
  }

  function itemTime(it) {
    const t = Number(it && it.savedAt) || 0;
    if (!t) return '时间未知';
    try {
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch {
      return '时间未知';
    }
  }

  function baseName(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** 打开恢复弹窗（DOM 弹窗；**不用原生 confirm** —— 原生对话框会挂住自动化冒烟） */
  function openDialog() {
    const body = document.createElement('div');
    body.className = 'recover-wrap';

    const head = document.createElement('div');
    head.className = 'recover-head';
    head.textContent = state.items.length
      ? `${state.items.length} 项未保存的大文件编辑（恢复区：${state.dir || '未知'}）`
      : '没有待恢复的大文件编辑。';
    body.appendChild(head);

    const msg = document.createElement('div');
    msg.id = 'recover-msg';
    msg.className = 'recover-msg hidden';
    msg.textContent = state.lastError || '';
    body.appendChild(msg);

    const list = document.createElement('div');
    list.className = 'recover-list';
    for (const it of state.items) {
      const row = document.createElement('div');
      row.className = 'recover-item';
      row.dataset.key = String(it.key || '');
      row.dataset.file = String(it.file || '');

      const name = document.createElement('div');
      name.className = 'recover-name';
      name.textContent = baseName(it.file);
      const path = document.createElement('div');
      path.className = 'recover-path';
      path.title = String(it.file || '');
      path.textContent = String(it.file || '');
      const meta = document.createElement('div');
      meta.className = 'recover-meta';
      meta.textContent = `${Number(it.lines) || 0} 行 · ${Number(it.dirtyBlocks) || 0} 处未保存修改 · ${itemTime(it)}`
        + (it.sourceExists === false ? ' · 源文件已不存在' : '');
      const acts = document.createElement('div');
      acts.className = 'recover-acts';

      const okBtn = document.createElement('button');
      okBtn.className = 'tbtn primary recover-ok';
      okBtn.textContent = '恢复';
      okBtn.addEventListener('click', () => { void recoverItem(it); });

      const noBtn = document.createElement('button');
      noBtn.className = 'tbtn danger recover-drop';
      noBtn.textContent = '丢弃';
      noBtn.addEventListener('click', () => { void discardItem(it); });

      acts.append(okBtn, noBtn);
      row.append(name, path, meta, acts);
      list.appendChild(row);
    }
    body.appendChild(list);

    openModal({
      title: '恢复未保存的大文件编辑',
      body,
      actions: [
        // 刷新：运行期间别的窗口崩溃也会往同一个恢复区写块表 —— 给一个不重启也能重扫的入口
        { label: '刷新', onClick: () => { void (async () => { await refresh(); openDialog(); })(); } },
        { label: '关闭', onClick: () => closeModal() },
      ],
    });
    return true;
  }

  /** 读一段 overlay 分片正文（分片 ≤4MB；readFileRange 单次上限 64MB，短读续读兜住） */
  async function readChunkText(tmpPath, off, bytes) {
    const want = Math.max(0, Math.floor(Number(bytes) || 0));
    if (want === 0) return '';
    const out = [];
    let got = 0;
    for (let guard = 0; guard < 64 && got < want; guard++) {
      const r = await api.readFileRange(tmpPath, Math.floor(Number(off) || 0) + got, want - got);
      const buf = toBytes(r && r.bytes);
      if (!buf || !buf.length) break;
      out.push(buf);
      got += buf.length;
    }
    if (got !== want) throw new Error(`恢复区分片不完整（期望 ${want} 字节，实读 ${got}）`);
    const total = new Uint8Array(got);
    let at = 0;
    for (const b of out) { total.set(b, at); at += b.length; }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(total);
    } catch {
      throw new Error('恢复区分片不是合法 UTF-8（无法按行还原）');
    }
  }

  /** 用例/UI 都可以只传 {key,file}；缺省取列表第一条（__app 测试面用）。
   *
   *  **key 一律白名单校验**（40 位小写 hex —— 主进程 `huge:doc-recover-list` 只放这个形状的文件名，
   *  overlay-ipc.js:664）。`metaPath`/`tmpPath` 都是由 key 拼出来的：dev 测试面若传 `..\\..` 之类
   *  会拼出 userData/overlay 之外的路径。这条白名单同时是「`requireApproved` 也接受父目录已批准」
   *  （security.js:83）那条的缓解措施：路径只能落在 overlay 目录下的 40 位 hex 文件名上。 */
  function pickItem(arg) {
    const raw = arg && arg.key ? arg.key : (state.items[0] ? state.items[0].key : null);
    const file = arg && arg.file ? arg.file : (state.items[0] ? state.items[0].file : '');
    const key = raw == null ? '' : String(raw);
    if (!/^[0-9a-f]{40}$/.test(key)) return null;
    return { key: key, file: String(file || '') };
  }

  /** 恢复一条：两道身份闸 → 收集 run 数据 → 倒序回放 → 复核行数 → 打开标签 */
  async function recoverItem(arg) {
    if (state.busy) return { ok: false, reason: '有恢复操作正在进行' };
    const item = pickItem(arg);
    if (!item) return fail('没有待恢复的条目（或条目 key 不合法，已拒绝）。');
    state.busy = true;
    state.lastError = '';
    try {
      return await doRecover(item);
    } finally {
      state.busy = false;
    }
  }

  async function doRecover(item) {
    setMsg('正在校验并恢复…');
    const metaPath = joinPath(state.dir, String(item.key || '') + '.json');
    const tmpPath = joinPath(state.dir, String(item.key || '') + '.tmp');

    // ── 读恢复区块表（不写盘；读成功同时给 overlay 目录下的路径拿到 approve 资格）──
    let meta = null;
    try {
      meta = JSON.parse(await readTextFile(api, metaPath));
    } catch {
      return fail('恢复被拒绝：恢复区块表不可读或已损坏。');
    }
    if (!meta || Number(meta.version) !== OVL_VERSION || !Array.isArray(meta.blocks) || !Array.isArray(meta.chunks)) {
      return fail('恢复被拒绝：恢复区块表版本不符（overlay 模型已升级）。');
    }
    if (String(meta.key || '') !== String(item.key || '')) {
      return fail('恢复被拒绝：恢复区块表与条目不对应。');
    }

    // ── 闸①：当前源文件身份（size + floor(mtime)，与 docKey 同口径）──
    let st = null;
    try {
      st = await api.stat(item.file);
    } catch {
      return fail('恢复被拒绝：源文件不存在或不可读。');
    }
    if (!st || st.isFile !== true) return fail('恢复被拒绝：源文件不存在或不是文件。');
    if (Number(st.size) !== Number(meta.size) || Math.floor(Number(st.mtime)) !== Math.floor(Number(meta.mtimeMs))) {
      return fail(`恢复被拒绝：源文件已变化（大小 ${Number(meta.size)} → ${Number(st.size)} 字节），不会用过期块表覆盖文件。`);
    }

    // ── 先把「要写什么」全部读齐（分片正文也在这一步读），再打开/改动任何东西：
    //     读失败时**一个字节都没动**，恢复区原封不动可以重试 ──
    const runs = buildRuns(meta);
    if (!runs.length) return fail('恢复被拒绝：恢复区没有可回放的 overlay 块。');
    const plan = [];
    try {
      for (const run of runs) {
        const texts = [];
        for (const p of run.parts) {
          const rec = meta.chunks.find((c) => c && c.id === p.chunk) || null;
          if (!rec) throw new Error('恢复区缺少块引用的分片表项');
          texts.push(await readChunkText(tmpPath, rec.off, rec.bytes));
        }
        const last = run.parts[run.parts.length - 1] || {};
        plan.push({
          srcFrom: run.srcFrom,
          srcTo: run.srcTo,
          lines: splitBlockText(texts.join(''), last.endsNL === true),
          trailingNewline: last.endsNL === true,
        });
      }
    } catch (err) {
      return fail('恢复被拒绝：恢复区数据不完整 —— ' + msgOf(err));
    }

    // ── 打开编辑会话（force：文件可能已低于大文件下限；紧接着用 key 复核，故不放松安全性）──
    let doc = null;
    try {
      doc = await api.hugeDocOpen({ file: item.file, force: true });
    } catch (err) {
      return fail('恢复被拒绝：无法打开编辑会话 —— ' + msgOf(err));
    }
    if (!doc || doc.docId == null) return fail('恢复被拒绝：主进程未返回文档句柄。');
    if (doc.reused === true) {
      // 句柄是别人/别处开的（路径单例），本函数没有创建它 ⇒ 绝不 close
      return fail(doc.ownedByOther === true
        ? '该文件的大文件编辑会话已被另一个窗口持有（路径单例），本窗口未恢复。'
        : '该文件的编辑会话已在当前窗口打开（若标签未开，可先打开该文件），未重复恢复。');
    }
    // **失败收尾一律 close({discard:false})**：本会话的 key 与恢复区 key 相同，
    // discard:true 会走 dropKey 把用户**唯一**的恢复数据删掉；discard:false 只落一份块表，
    // 已回放的部分反而变成新的恢复区（可重试），恢复区不会凭空消失。
    const keepAndFail = async (text) => {
      try { await api.hugeDocClose({ docId: doc.docId, discard: false }); } catch { /* 忽略 */ }
      return fail(text);
    };
    // ── 闸②：docKey（realpath|size|floor(mtime)|version 的 sha1）──
    if (String(doc.key || '') !== String(item.key || '')) {
      // 竞态：闸①之后文件又变了。这个句柄属于"新 key"，与条目无关；只关句柄，不丢弃
      return await keepAndFail('恢复被拒绝：文件身份校验未通过（docKey 不一致），未用过期块表覆盖文件。');
    }
    if (doc.editable !== true) {
      return await keepAndFail('恢复被拒绝：该文件当前不可编辑（' + String(doc.reason || '未知原因') + '）。');
    }

    // ── 行号在**干净文档**上一次算完（用文档自己的坐标系，与 huge:doc-edit 同源）──
    const total0 = Number(doc.lines) || 0;
    const lineAt = async (off) => {
      const r = await api.hugeDocOffsetLine({ docId: doc.docId, offset: Math.max(0, Math.floor(Number(off) || 0)) });
      if (r && r.eof === true) return total0 + 1; // 文件末尾 → 追加落笔位置（total+1）
      return Math.max(1, Number(r && r.line) || 1);
    };
    try {
      for (const step of plan) {
        const from = await lineAt(step.srcFrom);
        const to = await lineAt(step.srcTo);
        if (to < from) throw new Error('源区间不连续');
        step.from = from;
        step.deleteCount = to - from;
      }
    } catch (err) {
      return await keepAndFail('恢复被拒绝：无法把恢复区区间映射到行号 —— ' + msgOf(err));
    }

    // ── 倒序回放（行号已在干净文档上算完，从后往前应用互不影响）──
    plan.sort((a, b) => b.from - a.from);
    let applied = 0;
    try {
      for (const step of plan) {
        await api.hugeDocEdit({
          docId: doc.docId,
          from: step.from,
          deleteCount: step.deleteCount,
          lines: step.lines,
          trailingNewline: step.trailingNewline,
        });
        applied++;
      }
    } catch (err) {
      return await keepAndFail(`恢复中断：已回放 ${applied}/${plan.length} 段 —— ${msgOf(err)}（恢复区未删除，可重试）`);
    }

    // ── 复核：主进程行数必须等于块表行数（不符则明确报错，不假装成功）──
    let st2 = null;
    try {
      st2 = await api.hugeDocState({ docId: doc.docId });
    } catch { /* 取不到状态不影响"已回放"事实，下面按未知处理 */ }
    if (st2 && Number(st2.lines) !== Number(meta.lines)) {
      return await keepAndFail(`恢复校验失败：行数 ${Number(st2.lines)} ≠ 块表 ${Number(meta.lines)}（恢复区已保留，未删除）`);
    }

    // ── 打开标签并把会话接回（huge 视图走 huge:doc-lines → 立刻看得见恢复后的内容）──
    let tab = null;
    try {
      tab = await editor.openFile(item.file);
    } catch (err) {
      note('恢复已完成，但打开标签失败：' + msgOf(err));
    }
    // attached = 真的把恢复后的会话挂进了**大文件视图**（视图渲染走 huge:doc-lines 才看得见 overlay）
    let attached = false;
    if (tab && tab.huge && typeof tab.huge.setEditable === 'function') {
      try { attached = (await tab.huge.setEditable(true)) === true; } catch { attached = false; }
    }

    state.lastOk = `已恢复 ${plan.length} 处未保存修改，共 ${Number(meta.lines)} 行`;
    state.items = state.items.filter((it) => it !== item && String(it.key) !== String(item.key));
    renderChip();
    if (attached) {
      setMsg(`✅ ${state.lastOk}（未写源文件；Ctrl+S 才落盘）`);
      note(`${state.lastOk}，按 Ctrl+S 保存`);
    } else {
      // 内容确实已进主进程会话（行数刚复核过），但该文件**当前不在大文件档**（例如用户改过大文件阈值，
      // 或视图未就绪）⇒ 视图里显示的还是磁盘内容。必须说清，不能让用户以为"看得见的就是恢复后的"。
      const warn = `${state.lastOk}，但该文件当前未按大文件档打开（请检查设置里的大文件阈值），`
        + '视图里看到的仍是磁盘内容；请用大文件视图打开该文件后确认并保存。';
      setMsg('⚠ ' + warn);
      note('恢复完成，但未能挂进大文件视图（见恢复面板提示）');
    }
    return { ok: true, runs: plan.length, lines: Number(meta.lines), docId: doc.docId, file: item.file, attached: attached };
  }

  /** 丢弃一条：① 本窗口活会话（huge 标签且会话已建立）⇒ 拒绝；
   *  ② 别的窗口 watch 该文件（`others > 0`）⇒ **一律拒绝、零 probe**（captain 裁决 (ii)）；
   *  ③ 否则直删该条目自己的两件 overlay 文件，并做独立 `api.stat` 残留复核。
   *  （为什么不用主进程 `dropKey` 正门、为什么不 probe：见函数体 ②/直删 两段的机制说明，此处不重复。） */
  async function discardItem(arg) {
    if (state.busy) return { ok: false, reason: '有恢复操作正在进行' };
    const item = pickItem(arg);
    if (!item) return fail('没有可丢弃的条目（或条目 key 不合法，已拒绝）。');
    state.busy = true;
    state.lastError = '';
    try {
      return await doDiscard(item);
    } finally {
      state.busy = false;
    }
  }

  async function doDiscard(item) {
    const metaPath = joinPath(state.dir, String(item.key || '') + '.json');
    const tmpPath = joinPath(state.dir, String(item.key || '') + '.tmp');
    // ── 活会话守卫（两级，命中即拒绝；**全程不做 probe**）──
    // ① 本窗口：该文件正开着大文件标签且**会话已建立**（docId 非空）⇒ 这是活会话自己的块表，不许丢。
    let localLive = false;
    try {
      const t = editor.findTabByPath ? editor.findTabByPath(item.file) : null;
      localLive = !!(t && t.kind === 'huge' && t.huge && t.huge.getState && t.huge.getState().docId != null);
    } catch { localLive = false; }
    if (localLive) return fail('该文件的编辑会话正在当前窗口打开，未丢弃（请先关闭该标签）。');
    // ② 别的窗口：huge 标签开窗必 `api.watchFile`（tabs.js:1125）⇒ 锁表能看到别人在盯这个文件。
    //    **captain 最终裁决 (ii)：`others > 0` 一律拒绝、零 probe。** 它一次消灭两条路径：
    //    (a) **F1 的 persistMeta 覆盖**：probe 收尾的 `hugeDocClose({discard:false})` 在 overlay 侧是
    //        **无条件** `persistMeta()`（overlay.js:1220-1221 → :1164-1171 → io.writeMeta :351-358，
    //        临时文件 + rename），会**覆盖 `<doc.key>.json`**；当 `doc.key !== item.key`（文件已变）
    //        而新 key 本有自己的待恢复块表时，会把用户**更新的**未保存内容写成 `dirtyBlocks=0`
    //        （随后被 overlay-ipc.js:670 滤掉、列表里静默消失）⇒ 数据丢失类；
    //    (b) **TOCTOU 竞态**：本函数这次 `api.stat` 与 `huge:doc-open` 内部那次 stat（overlay-ipc.js:315）
    //        之间的**毫秒级**外部改写会让 `doc.key !== item.key`，probe 收尾同样写错 key 的 meta
    //        （需「毫秒级外部写 + 同路径另一条新 key 条目 + 另一窗口 watch」三者同时成立）。
    //    附带收益：不做 probe ⇒ 不付 `lineindex.getIndex()` 的代价（冷启动是整文件冷扫，GB 级几十秒）。
    //    **代价（照实记）**：另一窗口只是「打开」该文件、并无活会话时也不能丢弃（有可行动文案指路）；
    //    已是 0.5.1 顺延项 —— 给 `huge:doc-close` 加 `persist:false` 后即可放宽到"身份相符才 probe"。
    let others = 0;
    try {
      const ls = await api.docLockState(item.file);
      others = ls && Array.isArray(ls.others) ? ls.others.length : 0;
    } catch { others = 0; }
    if (others > 0) {
      return fail('另一个窗口正在打开该文件：请先关闭那个窗口里的该文件标签，再回到这里丢弃。'
        + '（该文件的未保存内容可能正被那个窗口持有，直接清理会毁掉它的恢复数据。）');
    }
    // ── 直删：**不再走 `huge:doc-open` + `hugeDocClose({discard:true})` 的主进程 dropKey 正门** ──
    // 等价性：删的就是 item.key 派生出的这两个 app 自有文件（<key>.json / <key>.tmp），
    //         与 overlay.js:366-374 的 dropKey 删的完全是同一对；
    // 代价：dropKey 前必须 open，而 open 会过一次 `lineindex.getIndex()` —— 侧车命中还好，
    //       冷启动是**整文件冷扫**（GB 级几十秒 + 写一份新侧车），只为删两个文件明显不成比例
    //       （%TEMP% 探针量化：直删 0 次 getIndex，dropKey 路线 1 次）；
    // 安全：`fs:delete` 同样过 `security.requireApproved`（ipc.js:233），而「读成功即 approve」
    //       （ipc.js:68/164）—— 先读一次拿批准，再删；key 形状已由 pickItem 白名单钉住。
    for (const p of [metaPath, tmpPath]) {
      try { await api.readFileRange(p, 0, 1); } catch { /* 不存在/不可读：删除自然失败或无必要 */ }
      try { await api.remove(p, false); } catch { /* 已不存在 */ }
    }
    // 独立复核（保留）：不看前面任何返回值，直接问磁盘"还在不在"
    const left = [];
    for (const p of [metaPath, tmpPath]) {
      try { await api.stat(p); left.push(baseName(p)); } catch { /* 已删除 */ }
    }
    if (left.length) return fail('丢弃未完成，仍有残留：' + left.join('、'));
    state.lastOk = `已丢弃「${baseName(item.file)}」的未保存编辑`;
    state.items = state.items.filter((it) => String(it.key) !== String(item.key));
    renderChip();
    setMsg('✅ ' + state.lastOk + '（恢复区块表与字节仓库均已删除）');
    note(state.lastOk);
    return { ok: true, removed: [baseName(metaPath), baseName(tmpPath)], file: item.file };
  }

  /** 启动即查一次（异步、失败静默：恢复区读不出来不能影响启动） */
  async function init() {
    const el = chipEl();
    if (el && !el.dataset.wired) {
      el.dataset.wired = '1';
      el.addEventListener('click', () => { openDialog(); });
    }
    try {
      await refresh({ announce: true });
    } catch { /* 忽略 */ }
  }

  function getState() {
    const el = chipEl();
    const mask = document.getElementById('modal-mask');
    return {
      dir: state.dir,
      count: state.items.length,
      items: state.items.map((it) => ({
        key: String(it.key || ''),
        file: String(it.file || ''),
        name: baseName(it.file),
        lines: Number(it.lines) || 0,
        dirtyBlocks: Number(it.dirtyBlocks) || 0,
        sourceExists: it.sourceExists !== false,
      })),
      chipVisible: !!(el && !el.classList.contains('hidden')),
      chipText: el ? String(el.textContent || '') : '',
      dialogOpen: !!(mask && !mask.classList.contains('hidden')),
      msg: (() => { const m = document.getElementById('recover-msg'); return m ? String(m.textContent || '') : ''; })(),
      lastError: state.lastError,
      lastOk: state.lastOk,
      busy: state.busy,
    };
  }

  /** 供用例断言"恢复后主进程文档内容"：抽样若干行（含首末行） */
  async function sampleLines(file, picks) {
    const tab = editor.findTabByPath ? editor.findTabByPath(file) : null;
    const docId = tab && tab.huge && typeof tab.huge.getState === 'function' ? (tab.huge.getState().docId) : null;
    if (docId == null) return { ok: false, reason: '没有打开中的编辑会话' };
    const st = await api.hugeDocState({ docId });
    const out = {};
    for (const ln of picks) {
      const r = await api.hugeDocLine({ docId, line: ln });
      out[ln] = r && r.text != null ? String(r.text) : null;
    }
    return { ok: true, docId, lines: Number(st && st.lines) || 0, dirty: !!(st && st.dirty), samples: out };
  }

  return { init, refresh, openDialog, recoverItem, discardItem, getState, sampleLines, state };
}
