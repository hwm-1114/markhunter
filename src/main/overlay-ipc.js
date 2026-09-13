// 大文件 overlay 编辑通道层（Phase D 第二步，v0.4.0）
//
// 定位：把第一步的纯逻辑文档模型（src/main/overlay.js —— 该模块**零 electron 依赖**，
// overlay.js:27 注释「本模块不 require electron」）接到 IPC 上。本文件是 overlay 线里
// **唯一** require electron 的模块（main.js 在 registerLineIndexIpc() 之后一行注册）。
//
// 三项硬约束（每条对应一次取证，见 docs/开发计划-大文件秒开与秒搜-0.4.0.md §6）：
//  1) **并发正确性**：overlay.js 的 putChunks 对同一 key 是**追加写**（overlay.js:816
//     io.appendRecord；overlay.js:313 注释「同一 key 串行调用，见 Doc 的单例约束」）。
//     若 insert/delete/splice/edit 不共用一把串行锁，两个请求会交错：后一次编辑读到前一次的
//     半成品块文本、appendRecord 偏移互相覆盖 → 用户数据损坏且不报错。因此**所有读写编辑保存
//     通道共用 registry.locks 的同一条 Promise 链**（withDocLock），save 全程持锁。
//  2) **保存必须过路径批准**：saveTo 内部调 io.requireApproved（overlay.js:1025），本模块注入
//     security.requireApproved（security.js:82-86，中文拒绝文案「路径不在当前工作目录内，操作已拒绝」）。
//  3) **打开即批准源文件**：lineindex 的冷扫走 fs.createReadStream（不用 ipc.js:48 readRangeBytes，
//     因此不会顺手 approve，见 ipc.js:67）→ 若不显式 approve，外部大文件会「能读能编辑但保存被拒」。
//
// 通道（统一**单对象入参**，风格对齐 lineindex.js:449 的 huge:lines；行号 1 基）：
//   invoke : huge:doc-open / close / state / lines / line / line-offset / offset-line /
//            edit / insert / delete / splice / undo / redo / save / save-cancel / recover-list
//   事件   : huge:doc-save-progress（进度+终态，主→渲染，preload 侧返回退订函数）
//            huge:doc-saved（保存成功后的单向通知：渲染端据此重建索引/重挂 watch）
//
// 与侦察结论的三处**有意偏离**（均已在返回值/注释里体现，便于第三步对接）：
//   a) 除侦察列出的 11 个 invoke 外，另注册 line-offset / offset-line / save-cancel /
//      recover-list 四个（任务书 ① 点名要求），通道总数 16 个 invoke + 2 个事件。
//   b) 保存成功后除重建 lineindex 侧车外，还把新稀疏表**挂回当前文档**（doc.base.starts = ...）：
//      overlay.js:1104-1106 的注释本就要求「保存后应由第二步立刻后台重建索引并把 doc 重新
//      挂到新索引上」，而 doc.base（overlay.js:1236 的 getter）返回的是活对象，赋值即可生效；
//      inBlockOffset 对不符合块的条目有守卫（overlay.js:635 `v >= blk.start && v <= blk.start+blk.bytes`），
//      挂错也只是退化为顺序扫，不会读错字节。这样「保存后块内定位静默退化」不必等第三步改 overlay.js。
//   c) 不再维护 registry.savedIndex：保存后 getIndex(target) 已把新索引放进 lineindex 的进程内缓存
//      （lineindex.js:213/236 memPut），再开同一文件本就命中 cached:true，单独存一份是冗余状态。
const { ipcMain, app } = require('electron');
const fsp = require('fs').promises;
const path = require('path');
const security = require('./security');
const lineindex = require('./lineindex');
const overlay = require('./overlay');
const filewatch = require('./filewatch');

// ---------- 通道表（与 src/preload/preload.js 的镜像一一对应） ----------
const CHANNELS = {
  open: 'huge:doc-open',
  close: 'huge:doc-close',
  state: 'huge:doc-state',
  lines: 'huge:doc-lines',
  line: 'huge:doc-line',
  lineOffset: 'huge:doc-line-offset',
  offsetLine: 'huge:doc-offset-line',
  edit: 'huge:doc-edit',
  insert: 'huge:doc-insert',
  del: 'huge:doc-delete',
  splice: 'huge:doc-splice',
  undo: 'huge:doc-undo',
  redo: 'huge:doc-redo',
  save: 'huge:doc-save',
  saveCancel: 'huge:doc-save-cancel',
  recoverList: 'huge:doc-recover-list',
};
const EVENTS = {
  saveProgress: 'huge:doc-save-progress',
  saved: 'huge:doc-saved',
};

const DEFAULT_OPTIONS = {
  minOpenBytes: 16 * 1024 * 1024,  // 下限护栏：只防「把 4MB 文件塞进 overlay 编辑」的误用；**不设上限门槛**
  progressThrottleMs: 50,          // 进度事件最小间隔（见 makeSaveRunner 的节流口径）
  progressEveryBytes: 4 * 1024 * 1024, // 进度事件字节步长下限（总字节/100 会取更大值）
  allowUnapproved: false,          // 仅在没有注入 requireApproved 时有意义（overlay.js:1026）
  gcMinIntervalMs: 10 * 60 * 1000, // overlay 目录 GC 的最小间隔（不引定时器，只在 open 时触发）
};

// ---------- 错误码 ----------
// 中文 message 是用户可见文案，必须原样保留；code 只作机器可读补充。
// 注意：Electron 的 ipcMain.handle 抛错过 IPC 后**只保留 message**（自定义属性丢失），
// 渲染端只能按 message 匹配；code 在主进程/探针内有效。
function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const ERR_RULES = [
  [/越界/, 'RANGE_OUT_OF_BOUNDS'],
  [/插入行不得内含换行/, 'INVALID_LINE'],
  [/超过物化上限|物化会占满内存|超出编辑上限/, 'MATERIALIZE_TOO_LARGE'],
  [/单行 .* 超过/, 'READLINE_TOO_LONG'],
  [/GBK 编码|编码为 .* 暂不支持/, 'NOT_EDITABLE'],
  [/二进制内容/, 'NOT_EDITABLE'],
  [/已被外部修改/, 'BASE_CHANGED'],
  [/源文件已不存在/, 'BASE_CHANGED'],
  [/路径不在当前工作目录内/, 'PATH_NOT_APPROVED'],
  [/保存缺少路径批准钩子/, 'SAVE_MISSING_APPROVAL_HOOK'],
  [/目标不是文件/, 'NOT_A_FILE'],
  [/行索引缺少 starts/, 'INDEX_STARTS_MISSING'],
  [/保存校验失败/, 'SAVE_VERIFY_FAILED'],
  [/原子替换失败/, 'SAVE_RENAME_FAILED'],
  [/保存已取消/, 'SAVE_CANCELED'],
  [/文档已关闭/, 'DOC_GONE'],
  [/块表已损坏|内部错误|自检失败/, 'INTERNAL'],
];
/** 给 overlay.js/lineindex.js 抛出的中文错误补一个 code（不覆盖已有 code，不改 message） */
function tagError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!e.code) {
    for (const [re, code] of ERR_RULES) {
      if (re.test(e.message)) { e.code = code; break; }
    }
  }
  return e;
}

// ---------- 小工具 ----------
function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
/** 取整数入参（缺失 → null；非有限数 → EINVAL） */
function intOf(v, name) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw codeError('EINVAL', `${name} 必须是数字`);
  return Math.floor(n);
}
function docIdOf(arg) {
  const n = intOf(arg && arg.docId, 'docId');
  if (n == null) throw codeError('EINVAL', '缺少 docId（overlay 文档句柄）');
  return n;
}
/** 把 webContents 包成 handlers 需要的 ctx（探针可用假 sender 直接构造同形对象） */
function makeCtx(e) {
  const sender = e && e.sender ? e.sender : null;
  return {
    senderId: sender && sender.id != null ? sender.id : null,
    sender,
    send: (name, payload) => {
      try {
        if (!sender) return;
        if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
        sender.send(name, payload);
      } catch { /* 窗口已销毁 / 通道已关：进度事件丢了不影响保存结果 */ }
    },
  };
}

// ---------- 句柄表 + 每句柄串行锁 ----------
function createRegistry(io, opts) {
  return {
    io,
    opts,
    seq: 0,                 // docId 自增（进程内单调、**永不复用**：复用会让迟到的渲染端请求命中新文档）
    handles: new Map(),     // docId -> handle
    pathToId: new Map(),    // realpath(file) -> docId（同一 realpath 复用句柄）
    locks: new Map(),       // docId -> Promise（串行链尾；空闲时删除键，防 map 只增不减）
    pending: new Map(),     // docId -> { controller, startedAt, target }（进行中的保存）
    senders: new Set(),     // 已挂过生命周期事件的 webContents.id
    gcRunning: false,
    gcLastAt: 0,
  };
}

/** 每句柄串行锁：prev 永不 reject（存进锁表的永远是 catch 过的尾巴），因此链不会断。 */
function withDocLock(reg, docId, fn) {
  const prev = reg.locks.get(docId) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  reg.locks.set(docId, tail);
  tail.then(() => {
    if (reg.locks.get(docId) === tail) reg.locks.delete(docId);
  });
  return run;
}

/** 取句柄 + 所有权校验（跨窗口一律拒绝：多窗口同文件的编辑会话互相覆盖是已知风险） */
function requireHandle(reg, ctx, arg) {
  const id = docIdOf(arg);
  const h = reg.handles.get(id);
  if (!h) throw codeError('DOC_GONE', `文档句柄不存在或已释放（docId=${id}）`);
  const owner = h.ownerWebContentsId == null ? null : h.ownerWebContentsId;
  const sid = ctx && ctx.senderId != null ? ctx.senderId : null;
  if (owner !== sid) throw codeError('WINDOW_NOT_OWNER', '该文档由其它窗口打开，当前窗口无权操作');
  return h;
}

function detachHandle(reg, h) {
  reg.handles.delete(h.docId);
  if (h.rp && reg.pathToId.get(h.rp) === h.docId) reg.pathToId.delete(h.rp);
  reg.pending.delete(h.docId);
}

/** webContents 生命周期：destroyed（窗口关）/ render-process-gone（渲染进程崩）都要释放句柄，
 *  否则 overlay 关联状态与 pathToId 永久残留（同文件再也开不出来）。每个 sender 只挂一次。 */
function attachLifecycle(reg, ctx) {
  const s = ctx && ctx.sender;
  if (!s || s.id == null) return; // 探针的假 sender 可以自己 emit
  if (reg.senders.has(s.id)) return;
  reg.senders.add(s.id);
  const onGone = () => { releaseByWebContents(reg, s.id).catch(() => { /* 释放失败不影响退出 */ }); };
  try { s.once('destroyed', onGone); } catch { /* 非 WebContents（探针）忽略 */ }
  try { s.on('render-process-gone', onGone); } catch { /* 同上 */ }
}

/** 释放某窗口的全部句柄：保存中的先 abort（避免 rename 到一半），再按默认语义 close
 *  （干净 → 丢弃 overlay；有未保存修改 → persistMeta 保留，供崩溃恢复）。 */
async function releaseByWebContents(reg, wid) {
  reg.senders.delete(wid);
  const ids = [...reg.handles.values()]
    .filter((h) => h.ownerWebContentsId === wid)
    .map((h) => h.docId);
  for (const id of ids) {
    const p = reg.pending.get(id);
    if (p) { try { p.controller.abort(); } catch { /* 已结束 */ } }
    await withDocLock(reg, id, async () => {
      const h = reg.handles.get(id);
      if (!h) return;
      detachHandle(reg, h);
      await h.doc.close({}).catch(() => { /* 关窗路径不允许抛 */ });
    }).catch(() => { /* 同上 */ });
  }
  return ids.length;
}

/** overlay 目录 GC：只在 open 成功后触发，进程内最小间隔 gcMinIntervalMs（照抄 lineindex.js:420-431
 *  的「触发式 GC」口径 —— 不引定时器，避免 app.quit 被句柄拖住）。 */
function scheduleGc(reg, protectKey) {
  const now = Date.now();
  if (reg.gcRunning || now - reg.gcLastAt < reg.opts.gcMinIntervalMs) return;
  reg.gcLastAt = now;
  reg.gcRunning = true;
  Promise.resolve()
    .then(() => reg.io.gcOverlayDir(protectKey))
    .catch(() => { /* 回收失败不影响编辑 */ })
    .finally(() => { reg.gcRunning = false; });
}

// ---------- 保存执行体（含进度节流与取消） ----------
/**
 * 保存执行体：doc.saveTo 的薄包装，负责
 *   - 进度节流（saveTo 每拷贝 4MiB 回调一次：overlay.js:1054 + COPY_CHUNK_BYTES，4GB 文件 ≈ 1000 次）
 *   - 终态事件（成功 done / 失败 failed —— **失败也必须发**，否则渲染端进度条永久转圈）
 *   - 取消语义（signal.aborted → saveTo 抛 e.canceled，overlay.js:1043/1053/1095-1097 已删临时文件）
 * @param {object} io 注入的 overlay io（签名对齐注册链路的注入口径；保存路径全在 saveTo 内，暂未直接使用）
 * @param {object} opts 见 DEFAULT_OPTIONS
 * @returns {(doc:object, args:{target?:string, signal?:object, onEvent?:Function}) => Promise<object>}
 */
function makeSaveRunner(io, opts = {}) {
  const o = Object.assign({}, DEFAULT_OPTIONS, opts);
  return async function runSave(doc, args = {}) {
    const target = path.resolve(String(args.target || doc.file));
    const onEvent = typeof args.onEvent === 'function' ? args.onEvent : () => {};
    const docId = doc.id == null ? null : doc.id;
    const totalBytes = doc.bytes();
    const everyBytes = Math.max(num(o.progressEveryBytes, DEFAULT_OPTIONS.progressEveryBytes), Math.floor(totalBytes / 100));
    const throttleMs = num(o.progressThrottleMs, DEFAULT_OPTIONS.progressThrottleMs);
    const t0 = Date.now();
    let last = { done: 0, total: totalBytes, phase: 'copy' };
    let lastAt = 0;
    let lastBytes = 0;
    let lastPhase = null;
    const report = (p) => {
      last = { done: p.done, total: p.total, phase: p.phase };
      const now = Date.now();
      const phaseChanged = p.phase !== lastPhase;
      // 阶段变化与终态永不丢弃；字节步长与时间下限**同时**满足才发（两条上界都成立：
      // 条数 ≤ ceil(total/everyBytes) + 2，也 ≤ 耗时/throttleMs + 2）
      const due = phaseChanged || p.done >= p.total || (p.done - lastBytes >= everyBytes && now - lastAt >= throttleMs);
      if (!due) return;
      lastAt = now;
      lastBytes = p.done;
      lastPhase = p.phase;
      try { onEvent({ docId, target, done: p.done, total: p.total, phase: p.phase, ms: now - t0 }); } catch { /* 渲染端异常不影响保存 */ }
    };
    try {
      const r = await doc.saveTo(target, {
        onProgress: (p) => report({ done: p.done, total: p.total, phase: p.phase }),
        signal: args.signal,
      });
      lastPhase = 'done';
      try {
        onEvent({ docId, target, size: r.size, ms: r.ms, phase: 'done', skipped: r.skipped === true });
      } catch { /* 同上 */ }
      return r;
    } catch (err) {
      const e = tagError(err);
      const code = e.canceled ? 'SAVE_CANCELED' : (e.code || 'SAVE_FAILED');
      if (e.canceled && !e.code) e.code = 'SAVE_CANCELED';
      try {
        onEvent({ docId, target, phase: 'failed', error: e.message, code, done: last.done, total: last.total, ms: Date.now() - t0 });
      } catch { /* 同上 */ }
      throw e;
    }
  };
}

// ---------- 通道实现（纯逻辑：只吃 io + ctx，不 require electron） ----------
/**
 * @param {object} io createOverlayIo 的返回值（dir/getIndex/requireApproved/markSelfWrite）
 * @param {object} opts 见 DEFAULT_OPTIONS
 * @returns 16 个 handler + registry（registry 仅供探针读取内部状态，渲染端不可达）
 */
function makeHandlers(io, opts = {}) {
  const o = Object.assign({}, DEFAULT_OPTIONS, opts);
  const reg = createRegistry(io, o);
  const runSave = makeSaveRunner(io, o);

  // (1) huge:doc-open —— 打开（同一 realpath 复用句柄）
  async function open(ctx, arg = {}) {
    const raw = String((arg && arg.file) || '');
    if (!raw) throw codeError('EINVAL', '缺少文件路径');
    let st;
    try {
      st = await fsp.stat(raw);
    } catch {
      throw codeError('ENOENT', `文件不存在或不可访问：${raw}`);
    }
    if (!st.isFile()) throw codeError('NOT_A_FILE', '目标不是文件');
    const rp = security.realpath(raw);
    const reuseId = reg.pathToId.get(rp);
    if (reuseId != null && reg.handles.has(reuseId)) {
      const h = reg.handles.get(reuseId);
      const owner = h.ownerWebContentsId == null ? null : h.ownerWebContentsId;
      const sid = ctx && ctx.senderId != null ? ctx.senderId : null;
      // 同 realpath 复用：多窗口同文件只保留一个编辑会话，另一窗口按 ownedByOther=true 转只读
      return {
        ok: true,
        reused: true,
        ownedByOther: owner !== sid,
        docId: h.docId,
        file: h.doc.file,
        key: h.doc.key,
        size: h.doc.bytes(),
        lines: h.doc.lines(),
        blocks: h.doc.blocks().length,
        editable: h.doc.editable.editable === true,
        reason: h.doc.editable.reason,
        encoding: h.doc.base.encoding,
        binary: h.doc.base.binary === true,
        endsNL: h.doc.endsWithNL(),
        index: h.lastIndex,
      };
    }
    if (st.size < num(o.minOpenBytes, 0) && arg.force !== true) {
      throw codeError('TOO_SMALL', `文件仅 ${(st.size / 1048576).toFixed(2)}MB，低于大文件编辑下限 ${(num(o.minOpenBytes, 0) / 1048576)}MB（确需编辑请传 force:true）`);
    }
    // **打开即批准**：lineindex 冷扫走 fs.createReadStream（不经 ipc.js 的 readRangeBytes），
    // 不会自动 approve → 漏掉这一步会「能读能编辑但保存被拒」。
    security.approve(raw);
    let idx;
    try {
      idx = await lineindex.getIndex(raw); // **必须含 starts**：huge:index 的 IPC 返回值已剥离（lineindex.js:445）
    } catch (e) {
      const err = tagError(e);
      if (!err.code) err.code = 'INDEX_FAILED';
      throw err;
    }
    const docId = ++reg.seq; // 进程内单调、永不复用
    const ownerWebContentsId = ctx && ctx.senderId != null ? ctx.senderId : null;
    const doc = await overlay.openDoc({
      file: raw,
      stat: st,
      index: idx,
      io: reg.io,
      id: docId,
      ownerWebContentsId,
      limits: arg.opts && arg.opts.limits ? arg.opts.limits : undefined,
    }).catch((e) => { throw tagError(e); });
    const h = {
      docId,
      doc,
      rp,
      ownerWebContentsId,
      saveState: 'idle',
      createdAt: Date.now(),
      lastIndex: {
        cached: idx.cached === true,
        elapsedMs: Math.floor(num(idx.elapsedMs, 0)),
        starts: Array.isArray(idx.starts) ? idx.starts.length : 0,
        sparse: num(idx.sparse, lineindex.SPARSE),
      },
    };
    reg.handles.set(docId, h);
    reg.pathToId.set(rp, docId);
    attachLifecycle(reg, ctx);
    scheduleGc(reg, doc.key);
    return {
      ok: true,
      reused: false,
      docId,
      file: doc.file,
      key: doc.key,
      size: doc.bytes(),
      lines: doc.lines(),
      blocks: doc.blocks().length,
      editable: doc.editable.editable === true,
      reason: doc.editable.reason,
      encoding: doc.base.encoding,
      binary: doc.base.binary === true,
      endsNL: doc.endsWithNL(),
      index: h.lastIndex,
    };
  }

  // (2) huge:doc-close —— discard 缺省时由 overlay 决定（干净丢弃 / 有改动保留 + 强刷块表）
  async function close(ctx, arg = {}) {
    const h0 = requireHandle(reg, ctx, arg);
    const docId = h0.docId;
    return await withDocLock(reg, docId, async () => {
      const h = reg.handles.get(docId);
      if (!h) return { ok: true, docId, discarded: false, kept: false, alreadyClosed: true };
      const p = reg.pending.get(docId);
      if (p) { try { p.controller.abort(); } catch { /* 已结束 */ } }
      const opts = arg.discard === undefined ? {} : { discard: arg.discard === true };
      const r = await h.doc.close(opts); // 保留场景内部先 await persistMeta（overlay.js:1221）
      detachHandle(reg, h);
      return { ok: true, docId, discarded: r.discarded === true, kept: r.kept === true };
    });
  }

  // (3) huge:doc-state —— inspect（含一次 stat 求 baseChanged）+ 底纹区间 + overlay 物理字节
  async function state(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    return await withDocLock(reg, h.docId, async () => {
      const s = await h.doc.inspect();
      return Object.assign({ ok: true }, s, {
        regions: h.doc.regions(),
        overlayFileBytes: await h.doc.overlayFileBytes(),
        canUndo: h.doc.canUndo(),
        canRedo: h.doc.canRedo(),
      });
    });
  }

  // (4) huge:doc-lines —— huge:lines 的 overlay 版（形状超集；**不得**改走 lineindex.readLines：
  //     那条路读的是原文件、看不见 overlay 覆盖，行号也是原文件的）
  async function lines(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    return await withDocLock(reg, h.docId, async () => {
      const r = await h.doc.readLines(arg.from, arg.count);
      return Object.assign({ ok: true }, r, {
        dirty: h.doc.isDirty(),
        dirtyCount: h.doc.dirtyCount(),
        totalLines: h.doc.lines(),
        totalBytes: h.doc.bytes(),
      });
    });
  }

  // (5) huge:doc-line —— 单行**完整**文本（不受 40000 字符截断；不含行尾换行，\r 保留）
  async function line(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const want = intOf(arg.line, 'line');
    if (want == null) throw codeError('EINVAL', '缺少 line');
    return await withDocLock(reg, h.docId, async () => {
      const total = h.doc.lines();
      const ln = clamp(want, 1, Math.max(1, total));
      const text = await h.doc.readLineText(ln).catch((e) => { throw tagError(e); });
      return { ok: true, docId: h.docId, line: ln, text, bytes: Buffer.byteLength(text, 'utf8') };
    });
  }

  // (6) huge:doc-line-offset / (7) huge:doc-offset-line —— 行↔字节定位（与 huge:line-offset/offset-line 同用）
  async function lineOffset(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const ln = intOf(arg.line, 'line');
    if (ln == null) throw codeError('EINVAL', '缺少 line');
    return await withDocLock(reg, h.docId, async () => {
      const r = await h.doc.lineOffset(ln).catch((e) => { throw tagError(e); });
      return Object.assign({ ok: true, docId: h.docId }, r);
    });
  }
  async function offsetLine(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const off = intOf(arg.offset, 'offset');
    if (off == null) throw codeError('EINVAL', '缺少 offset');
    return await withDocLock(reg, h.docId, async () => {
      const r = await h.doc.offsetLine(off).catch((e) => { throw tagError(e); });
      return Object.assign({ ok: true, docId: h.docId }, r);
    });
  }

  // (8) huge:doc-edit —— 块级 CoW 主入口（from = 行数+1 表示末尾追加）
  async function edit(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const from = intOf(arg.from, 'from');
    if (from == null) throw codeError('EINVAL', '缺少 from');
    const del = arg.deleteCount == null ? 0 : Math.max(0, num(intOf(arg.deleteCount, 'deleteCount'), 0));
    let ins = [];
    if (arg.lines != null) {
      if (!Array.isArray(arg.lines)) throw codeError('EINVAL', 'lines 必须是字符串数组');
      ins = arg.lines.map((s) => (s == null ? '' : String(s)));
    }
    const opts = {};
    if (arg.trailingNewline !== undefined) opts.trailingNewline = arg.trailingNewline === true;
    return await withDocLock(reg, h.docId, async () => {
      const r = await h.doc.spliceLines(from, del, ins, opts).catch((e) => { throw tagError(e); });
      return Object.assign({ docId: h.docId }, r);
    });
  }

  // (9) huge:doc-insert —— 行内插入（col = 行内 0 基字符下标；text 含 \n 会裂成多行）
  async function insert(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const ln = intOf(arg.line, 'line');
    if (ln == null) throw codeError('EINVAL', '缺少 line');
    const col = arg.col == null ? 0 : Math.max(0, num(intOf(arg.col, 'col'), 0));
    const text = String(arg.text == null ? '' : arg.text);
    return await withDocLock(reg, h.docId, async () => {
      const r = await h.doc.insertText(ln, col, text).catch((e) => { throw tagError(e); });
      return Object.assign({ docId: h.docId }, r);
    });
  }

  // (10) huge:doc-delete —— 区间删除（允许传反，overlay.js:926 内部会交换）
  async function del(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const f = intOf(arg.fromLine, 'fromLine');
    if (f == null) throw codeError('EINVAL', '缺少 fromLine');
    const t = arg.toLine == null ? f : num(intOf(arg.toLine, 'toLine'), f);
    const c1 = arg.fromCol == null ? 0 : Math.max(0, num(intOf(arg.fromCol, 'fromCol'), 0));
    const c2 = arg.toCol == null ? 0 : Math.max(0, num(intOf(arg.toCol, 'toCol'), 0));
    return await withDocLock(reg, h.docId, async () => {
      const r = await h.doc.deleteRange(f, c1, t, c2).catch((e) => { throw tagError(e); });
      return Object.assign({ docId: h.docId }, r);
    });
  }

  // (11) huge:doc-splice —— 通用区间替换（渲染端一次选区替换 = 一次 IPC）
  // 首尾行全文必须在**主进程**取（readLineText 不受 40000 截断）；渲染端只看得到截断后的文本，
  // 自行拼接会丢内容，因此拼接只在这里做。
  async function splice(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const f = intOf(arg.fromLine, 'fromLine');
    if (f == null) throw codeError('EINVAL', '缺少 fromLine');
    const t = arg.toLine == null ? f : num(intOf(arg.toLine, 'toLine'), f);
    const c1 = Math.max(0, num(intOf(arg.fromCol, 'fromCol'), 0));
    const c2 = Math.max(0, num(intOf(arg.toCol, 'toCol'), 0));
    const text = String(arg.text == null ? '' : arg.text);
    return await withDocLock(reg, h.docId, async () => {
      const total = h.doc.lines();
      if (total <= 0) throw codeError('RANGE_OUT_OF_BOUNDS', '空文档没有可替换的区间');
      const fL = clamp(f, 1, total);
      const tL = clamp(t, fL, total);
      const head = await h.doc.readLineText(fL).catch((e) => { throw tagError(e); });
      const tail = tL === fL ? head : await h.doc.readLineText(tL).catch((e) => { throw tagError(e); });
      const merged = head.slice(0, clamp(c1, 0, head.length)) + text + tail.slice(clamp(c2, 0, tail.length));
      const endsNL = merged.endsWith('\n');
      let segs = merged.split('\n');
      if (endsNL) segs.pop();
      if (segs.length === 0) segs = ['']; // 整段被清空 → 保留一个空行（与 spliceLineText 同口径）
      // 行尾规则：区间之后仍有内容 → 必须以换行结束；触及文档末尾 → 由新文本/原文现状决定
      const trailingNewline = tL >= total ? (endsNL ? true : h.doc.endsWithNL()) : true;
      const r = await h.doc.spliceLines(fL, tL - fL + 1, segs, { trailingNewline }).catch((e) => { throw tagError(e); });
      return Object.assign({ docId: h.docId }, r);
    });
  }

  // (12)(13) huge:doc-undo / huge:doc-redo —— 块引用换回（零拷贝）
  async function undo(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    return await withDocLock(reg, h.docId, async () => {
      const changed = h.doc.undo();
      return {
        ok: true, docId: h.docId, undone: changed === true,
        lines: h.doc.lines(), bytes: h.doc.bytes(),
        dirty: h.doc.isDirty(), dirtyCount: h.doc.dirtyCount(),
        undoDepth: h.doc.undoDepth(), redoDepth: h.doc.redoDepth(),
        canUndo: h.doc.canUndo(), canRedo: h.doc.canRedo(), // 渲染端按钮态不必再补一次 state
      };
    });
  }
  async function redo(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    return await withDocLock(reg, h.docId, async () => {
      const changed = h.doc.redo();
      return {
        ok: true, docId: h.docId, redone: changed === true,
        lines: h.doc.lines(), bytes: h.doc.bytes(),
        dirty: h.doc.isDirty(), dirtyCount: h.doc.dirtyCount(),
        undoDepth: h.doc.undoDepth(), redoDepth: h.doc.redoDepth(),
        canUndo: h.doc.canUndo(), canRedo: h.doc.canRedo(),
      };
    });
  }

  // (14) huge:doc-save —— 唯一会跑很久的通道；全程持 doc 锁（保存期间同 doc 的编辑排队）
  async function save(ctx, arg = {}) {
    const h0 = requireHandle(reg, ctx, arg);
    const docId = h0.docId;
    if (reg.pending.has(docId)) throw codeError('BUSY', '该文档正在保存中，请稍候再试');
    const target = arg.target ? path.resolve(String(arg.target)) : null;
    return await withDocLock(reg, docId, async () => {
      const h = reg.handles.get(docId);
      if (!h) throw codeError('DOC_GONE', `文档句柄不存在或已释放（docId=${docId}）`);
      if (reg.pending.has(docId)) throw codeError('BUSY', '该文档正在保存中，请稍候再试');
      const controller = new AbortController();
      reg.pending.set(docId, { controller, startedAt: Date.now(), target: target || h.doc.file });
      h.saveState = 'saving';
      const onEvent = (payload) => ctx.send(EVENTS.saveProgress, payload);
      try {
        const res = await runSave(h.doc, { target, signal: controller.signal, onEvent });
        h.saveState = 'idle';
        if (res.skipped === true) {
          // 无未保存修改：不重建索引、不发 huge:doc-saved（磁盘零变化）
          return {
            ok: true, docId, skipped: true, reason: res.reason, target: res.target,
            size: res.size, bytes: res.bytes, ms: res.ms, dirty: false,
            droppedOverlay: false, rebased: null, index: null,
          };
        }
        // 另存为后文档已指向新路径 → 句柄的 realpath 索引同步（同文件再 open 才复用得到）
        const newRp = security.realpath(h.doc.file);
        if (newRp !== h.rp) {
          if (reg.pathToId.get(h.rp) === docId) reg.pathToId.delete(h.rp);
          h.rp = newRp;
          reg.pathToId.set(newRp, docId);
        }
        const after = await rebuildIndex(h);
        try {
          ctx.send(EVENTS.saved, {
            docId, file: h.doc.file, target: res.target, size: res.size, ms: res.ms,
            lines: h.doc.lines(), bytes: h.doc.bytes(), index: after.index, reattached: after.reattached,
          });
        } catch { /* 通知失败不影响保存结果 */ }
        return {
          ok: true, docId, skipped: false, target: res.target, size: res.size, bytes: res.bytes,
          ms: res.ms, dirty: false, droppedOverlay: res.droppedOverlay === true,
          rebased: {
            size: h.doc.base.size, mtimeMs: h.doc.base.mtimeMs,
            lines: h.doc.lines(), bytes: h.doc.bytes(),
            starts: after.index ? after.index.starts : 0, reattached: after.reattached,
          },
          index: after.index,
        };
      } catch (e) {
        h.saveState = 'failed';
        throw tagError(e);
      } finally {
        reg.pending.delete(docId);
      }
    });
  }

  // (15) huge:doc-save-cancel —— 不取锁（必须能打断正在跑的保存）
  async function saveCancel(ctx, arg = {}) {
    const h = requireHandle(reg, ctx, arg);
    const p = reg.pending.get(h.docId);
    if (!p) return { ok: true, docId: h.docId, canceled: false, reason: '当前没有进行中的保存' };
    try { p.controller.abort(); } catch { /* 已结束 */ }
    return { ok: true, docId: h.docId, canceled: true, target: p.target };
  }

  // (16) huge:doc-recover-list —— 崩溃恢复候选（<key>.json 块表里含 overlay 块的才算“可恢复”）
  async function recoverList(ctx, arg = {}) {
    const limit = clamp(num(intOf(arg && arg.limit, 'limit'), 100), 1, 500);
    let names = [];
    try {
      names = await reg.io.list();
    } catch { names = []; }
    const items = [];
    for (const name of names) {
      const m = /^([0-9a-f]{40})\.json$/.exec(String(name));
      if (!m) continue;
      let meta = null;
      try { meta = await overlay.readRecovery(reg.io, m[1]); } catch { meta = null; }
      if (!meta || !Array.isArray(meta.blocks)) continue;
      const dirtyBlocks = meta.blocks.filter((b) => b && b.kind === 'overlay').length;
      if (dirtyBlocks === 0) continue; // 干净文档的块表没有可恢复内容
      let exists = false;
      try { exists = (await fsp.stat(meta.file)).isFile(); } catch { exists = false; }
      items.push({
        key: m[1], file: meta.file, size: num(meta.size, 0), lines: num(meta.lines, 0),
        bytes: num(meta.bytes, 0), savedAt: num(meta.savedAt, 0), dirtyBlocks, sourceExists: exists,
      });
    }
    items.sort((a, b) => b.savedAt - a.savedAt);
    return { ok: true, dir: reg.io.dir, items: items.slice(0, limit) };
  }

  /** 保存成功后重建行索引，并把新稀疏表挂回当前文档（见文件头偏离说明 b） */
  async function rebuildIndex(h) {
    // 让 fs.watch 先消化 rename 事件（读侧与 rename 的竞态；口径同 ipc.js 的自写标记时机）
    await new Promise((r) => setImmediate(r));
    let index = null;
    let reattached = false;
    try {
      const idx = await lineindex.getIndex(h.doc.file, { force: true }); // force：同 size/mtime 的旧侧车不可信
      index = {
        cached: idx.cached === true,
        elapsedMs: Math.floor(num(idx.elapsedMs, 0)),
        starts: Array.isArray(idx.starts) ? idx.starts.length : 0,
        sparse: num(idx.sparse, lineindex.SPARSE),
      };
      if (Array.isArray(idx.starts) && idx.starts.length) {
        h.doc.base.starts = idx.starts;
        reattached = true;
      }
      h.lastIndex = index;
    } catch (e) {
      index = { error: tagError(e).message };
    }
    return { index, reattached };
  }

  const handlers = {
    open, close, state, lines, line, lineOffset, offsetLine,
    edit, insert, del, splice, undo, redo, save, saveCancel, recoverList,
  };
  handlers.registry = reg; // 仅供探针读取内部状态（句柄表/锁/待保存）；渲染端不可达
  return handlers;
}

// ---------- 注册 ----------
let registered = false;
let registrationResult = null;
let activeRegistry = null;

/** 生产入口（main.js 在 registerLineIndexIpc() 之后调用）。重复调用返回同一结果（不抛），
 *  避免冒烟/多窗口误注册触发 Electron 的 "Attempted to register a second handler"。 */
function registerOverlayIpc(opts = {}) {
  if (registered) return registrationResult;
  const io = opts.io || overlay.createOverlayIo({
    dir: opts.dir || overlay.overlayDir(opts.userData || app.getPath('userData')), // <userData>/overlay
    getIndex: (file) => lineindex.getIndex(file),   // 必须含 starts（lineindex.js:193-238）
    requireApproved: security.requireApproved,      // security.js:82-86（中文拒绝文案）
    markSelfWrite: (file) => filewatch.markSelfWrite(file), // filewatch.js:160-167（写后自写标记）
    allowUnapproved: opts.allowUnapproved === true || process.env.MH_OVERLAY_ALLOW_UNAPPROVED === '1',
  });
  const handlers = makeHandlers(io, opts);
  for (const [key, name] of Object.entries(CHANNELS)) {
    const fn = handlers[key];
    ipcMain.handle(name, async (e, arg) => fn(makeCtx(e), arg));
  }
  activeRegistry = handlers.registry;
  registered = true;
  registrationResult = {
    dir: io.dir,
    channels: Object.keys(CHANNELS).length,
    events: Object.keys(EVENTS).length,
    names: Object.values(CHANNELS),
    minOpenBytes: handlers.registry.opts.minOpenBytes,
  };
  return registrationResult;
}

/** 释放：摘掉全部 handler + 关闭全部句柄（测试/重启用；默认语义同 close —— 有改动即保留可恢复） */
function unregisterOverlayIpc() {
  for (const name of Object.values(CHANNELS)) {
    try { ipcMain.removeHandler(name); } catch { /* 未注册 */ }
  }
  const reg = activeRegistry;
  registered = false;
  registrationResult = null;
  activeRegistry = null;
  if (!reg) return Promise.resolve({ ok: true, released: 0 });
  const ids = [...reg.handles.keys()];
  return Promise.all(ids.map((id) => withDocLock(reg, id, async () => {
    const h = reg.handles.get(id);
    if (!h) return;
    detachHandle(reg, h);
    await h.doc.close({}).catch(() => { /* 释放路径不抛 */ });
  }).catch(() => { /* 同上 */ })))
    .then(() => ({ ok: true, released: ids.length }));
}

module.exports = {
  registerOverlayIpc,
  unregisterOverlayIpc,
  CHANNELS,
  EVENTS,
  DEFAULT_OPTIONS,
  makeHandlers,
  makeSaveRunner,
  // 供第三步/探针复用的纯函数
  tagError,
  codeError,
};
