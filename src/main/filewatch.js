// 文件变更监听：外部编辑器修改磁盘文件时通知渲染进程
// P8（v0.1.45）：主监听改为 fs.watch（事件驱动，50 标签不再 = 50 个 500ms stat 轮询）。
// v0.1.51 多窗口：watcher 按窗口隔离（path → winId → entry）——变更只通知监听该文件的各窗口；
// 同一文件被第二个窗口打开时向新窗口发 'file-shared-open'（渲染端自动以只读打开，D2）。
//
// ============================================================================
// 0.5.0 多视图 Phase 4：跨窗口「接管编辑」锁表（就长在上面这张 watchers 表上）
// ----------------------------------------------------------------------------
// 数据结构：`watchers: Map<path, Map<winId, entry>>`，entry 新增 `mode: 'edit' | 'read'`。
//   · 每个 (文件路径, 窗口) 一条 entry —— 一个窗口打开一个文件 = 一条登记，登记即"在看这个文件"。
//   · **谁在 edit / 谁在 read**：
//       ① 首个打开该文件的窗口 → mode='edit'（编辑权持有者）；
//       ② 之后打开的窗口 → mode='read'（只读观察窗），并收到 file-shared-open（**既有语义一字未改**，
//          脚本 scripts/smoke.js 的 mwSharedReadOnly 断言的就是这条）；
//       ③ 同窗口重挂监听（保存后重挂/重新打开）沿用原有 mode —— 既不抢别人的编辑权，也不自降；
//       ④ 观察窗可经 `doc:claim-edit` 抢走编辑权：抢方 → 'edit'，其余窗口 → 'read' 并收到
//          file-lock-changed（渲染端转只读 + toast + 横幅「✏️ 接管编辑」按钮）。
//   · `doc:release-edit`：显式交回编辑权（渲染端关掉正在编辑的标签时调用）；交回后其余窗口收到
//     file-lock-changed {mode:'read', owner:null, freed:true}（渲染端提示「编辑权已空闲」，
//     **不自动把自己变成可编辑**：第二窗口默认只读观察窗的既定语义不因他人退出而改）。
//   · 窗口 `closed`：主进程自动释放该窗口在**所有**路径上的登记（watcher + 轮询 + 锁），
//     并在其持有编辑权的路径上广播「编辑权已空闲」（见 releaseWindow）。
//   · **L3 开关**（`doc:set-conflict-prompt`，**默认关**）：打开后 claim 不再降级其它窗口 ——
//     多窗口同时可编辑，冲突由渲染端的 DOM 横幅提示（见 renderer/tabs.js 的 showConflictBanner）。
//     关闭时维持 L2 独占接管语义（本版默认路径）。
//   · **与大文件的边界**：`huge:*` 编辑会话的所有权完全由 overlay-ipc.js 的路径单例规则管
//     （docId 单例 + ownerWebContentsId + WINDOW_NOT_OWNER），**本锁表不参与**、也不改变其语义。
//     即：普通标签走「本锁表」，大文件标签走「overlay 所有者」这两条并行规则。
// ============================================================================
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;

const watchers = new Map(); // path -> Map<winId, { mtime, timer, fsw, poller, pollFn, mode, win }>
const selfWrites = new Map(); // path -> { mtime, size, until } 最近一次自写的 mtime/大小与宽限截止时刻

/** L3「多窗口同时可编辑 + 冲突提示」开关（Phase 4 默认**关**）。
 *  存在理由：无 CRDT 时双编辑会 last-write-wins 丢内容，所以默认只做 L2 独占接管。
 *  只存主进程运行时（不落 settings.json：settings:set 是键白名单，未见新键会被拒），
 *  经 `doc:set-conflict-prompt` / `doc:get-conflict-prompt` 读写（preload 镜像 window.api）。 */
let conflictPrompt = false;

// 通知防抖：聚合 fs.watch 一次变更可能触发的多条事件（Windows 实测 ~2 事件/次写），
// 也覆盖「写入 → markSelfWrite 记录 mtime」的毫秒级竞态（T3），300ms 后统一 stat 比对。
const NOTIFY_DEBOUNCE = 300;
const POLL_INTERVAL = 1000; // 兜底轮询间隔
// 自写宽限窗口：写盘后短时间内的变更一律视为自身写入的延迟回声（吸收，不通知）。
// 背景：Windows fs.watch 事件在高频写入下会延迟/合并，且 markSelfWrite 的 stat 在高 IO 负载
// （杀毒/索引）下也可能滞后 —— 检查拿到新状态而记录还是旧值时，精确匹配失败就会误报
// 「已在外部被修改」，在编辑器中打字快、自动保存频繁时反复弹确认框（用户可感知的严重误报）。
// 代价：宽限窗口内紧随自写发生的真实外部修改会被吸收一次；停止编辑 2s 后恢复正常检测。
const SELF_WRITE_GRACE_MS = 2000;

function winOf(e) {
  try {
    return BrowserWindow.fromWebContents(e.sender);
  } catch {
    return null;
  }
}

/** 该路径当前的编辑权持有者 winId（无人持有 → null） */
function editOwnerOf(filePath) {
  const byWin = watchers.get(filePath);
  if (!byWin) return null;
  for (const [wid, entry] of byWin) if (entry.mode === 'edit') return wid;
  return null;
}

/** 该路径上处于可编辑态的窗口数（>1 = 多窗口同时可编辑 = L3 开关打开的形态） */
function editCountOf(filePath) {
  const byWin = watchers.get(filePath);
  if (!byWin) return 0;
  let n = 0;
  for (const [, entry] of byWin) if (entry.mode === 'edit') n++;
  return n;
}

/** 向该路径上的活动窗口发 file-lock-changed；excludeWinId 用于"不通知发起方"。
 *  载荷固定含 `self`（收件窗口自己的 winId）—— 渲染端据此区分"我抢到了"与"我被降级了"。
 *  返回实际送达的窗口数。 */
function notifyLock(filePath, payload, excludeWinId) {
  const byWin = watchers.get(filePath);
  if (!byWin) return 0;
  let n = 0;
  for (const [wid, entry] of [...byWin]) {
    if (wid === excludeWinId) continue;
    const w = entry.win;
    if (!w || w.isDestroyed()) continue;
    try {
      w.webContents.send('file-lock-changed', { path: filePath, self: wid, ...payload });
      n++;
    } catch { /* 窗口销毁竞态：忽略 */ }
  }
  return n;
}

/** 停止监听。`win` 为窗口对象时只清该窗口的 entry（null = 全部）。
 *  opts.notify === false：摘除时**不**广播「编辑权已空闲」（startWatch 的同窗口重挂用它，
 *  否则每次重挂都会让观察窗闪一次"编辑权空闲"）。 */
function stopWatch(filePath, win, opts = {}) {
  const byWin = watchers.get(filePath);
  if (!byWin) return;
  const id = win ? win.id : null;
  let releasedEdit = false;
  for (const [wid, entry] of [...byWin]) {
    if (id !== null && wid !== id) continue; // 只清理指定窗口的 watcher
    clearTimeout(entry.timer);
    if (entry.fsw) {
      try { entry.fsw.close(); } catch { /* 已停止 */ }
    }
    if (entry.poller) {
      // B3 修复（0.2.5 审计 :119）：**必须带 listener** 精准摘除本窗口的 StatWatcher 监听。
      // `fs.unwatchFile(path)` 不带 listener 会移除该路径上**全部**监听（Node 实测：两个监听器
      // 全部失效），于是任一窗口取消监听都会顺带打断其它窗口的轮询兜底 —— 且 entry.poller 已置
      // true，该窗口的兜底**永不重建**（此后外部修改静默丢失）。
      try { if (entry.pollFn) fs.unwatchFile(filePath, entry.pollFn); } catch { /* 已停止 */ }
    }
    if (entry.mode === 'edit') releasedEdit = true;
    byWin.delete(wid);
  }
  if (byWin.size === 0) watchers.delete(filePath);
  // 编辑权持有者退出（关标签 / 关窗口）→ 通知仍在看同一文件的窗口「编辑权已空闲」
  if (releasedEdit && opts.notify !== false && byWin.size > 0) {
    notifyLock(filePath, { mode: 'read', owner: null, freed: true });
  }
}

function aliveWinsOf(filePath) {
  const byWin = watchers.get(filePath);
  if (!byWin) return [];
  const wins = [];
  for (const [wid, entry] of [...byWin]) {
    if (!entry.win || entry.win.isDestroyed()) {
      byWin.delete(wid); // 窗口已销毁：清理孤儿 watcher
      continue;
    }
    wins.push(entry.win);
  }
  if (byWin.size === 0) watchers.delete(filePath);
  return wins;
}

async function checkAndNotify(filePath) {
  const wins = aliveWinsOf(filePath);
  if (wins.length === 0) return;
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    /* 文件可能被删除/不可读，忽略 */
    return;
  }
  const rec = selfWrites.get(filePath);
  if (rec) {
    if (st.mtimeMs === rec.mtime && st.size === rec.size) {
      selfWrites.delete(filePath);
      return;
    }
    if (Date.now() < rec.until) {
      // 自写宽限内：事件延迟/stat 滞后导致的记录错位回声，吸收本次变化
      rec.mtime = st.mtimeMs;
      rec.size = st.size;
      return;
    }
    // 宽限外且与记录不符：本地写入之后又被外部修改过，继续走通知逻辑
  }
  const multiEdit = editCountOf(filePath) > 1; // Phase 4 L3：多窗口同时可编辑（渲染端的冲突提示门控）
  for (const w of wins) {
    const entry = watchers.get(filePath)?.get(w.id);
    if (!entry) continue;
    if (st.mtimeMs !== entry.mtime) {
      entry.mtime = st.mtimeMs;
      try {
        // multiEdit 是**新增字段**（既有消费方只读 path/mtime，语义不变）；渲染端用它区分
        // "跨窗口双编辑的保存" 与 "真正的外部修改"，前者在 L3 开关打开时走 DOM 冲突横幅。
        w.webContents.send('file-changed', { path: filePath, mtime: st.mtimeMs, multiEdit });
      } catch { /* 窗口销毁竞态 */ }
    }
  }
}

/** 事件到达后的统一入口：防抖合并 → 一次 stat 比对（fs.watch 与轮询兜底共用） */
function scheduleCheck(filePath, winId) {
  const entry = watchers.get(filePath)?.get(winId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => checkAndNotify(filePath), NOTIFY_DEBOUNCE);
}

/** 兜底：fs.watch 不可用/失效时退回 fs.watchFile 1000ms 轮询（原方案语义） */
function fallbackToPoll(filePath, winId) {
  const entry = watchers.get(filePath)?.get(winId);
  if (!entry || entry.poller) return;
  if (entry.fsw) {
    try { entry.fsw.close(); } catch { /* 忽略 */ }
    entry.fsw = null;
  }
  try {
    // B3 修复的另一半：listener 必须**存进 entry**，stopWatch 才能按窗口精准摘除
    // （fs.unwatchFile 不带 listener = 全量摘除，见 stopWatch 内的说明）
    const pollFn = (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return; // 内容未变
      scheduleCheck(filePath, winId);
    };
    fs.watchFile(filePath, { interval: POLL_INTERVAL }, pollFn);
    entry.pollFn = pollFn;
    entry.poller = true;
  } catch {
    /* 文件不可监视则忽略 */
  }
}

/** 窗口关闭钩子：只挂一次。窗口销毁时释放它在所有路径上的登记（watcher + 轮询 + 锁），
 *  否则 (a) 已销毁窗口的轮询监听会一直挂在 fs 上，(b) 它的编辑权无人释放。 */
const closeHooked = new Set(); // winId
function hookWindowClose(win) {
  if (!win || closeHooked.has(win.id)) return;
  closeHooked.add(win.id);
  try {
    win.once('closed', () => {
      closeHooked.delete(win.id);
      releaseWindow(win.id);
    });
  } catch {
    closeHooked.delete(win.id);
  }
}

/** 释放某窗口的全部登记（窗口 closed 时调用；stopWatch 只认窗口对象，故传 { id } 伪对象） */
function releaseWindow(winId) {
  for (const p of [...watchers.keys()]) {
    stopWatch(p, { id: winId }); // 持有编辑权的路径会在这里广播「编辑权已空闲」
  }
}

function startWatch(filePath, mtime, win) {
  if (!win || win.isDestroyed()) return;
  // 共享判断须在清理前做：除本窗口外是否已有其它窗口在监听同一文件（D2 跨窗口通知依据）
  const old = watchers.get(filePath);
  const sharedBefore = !!old && [...old.keys()].some((wid) => wid !== win.id);
  // 编辑权判定也须在清理前做（stopWatch 会把本窗口的旧登记一起摘掉）
  const prev = old ? old.get(win.id) : null;
  const editTakenByOther = !!old && [...old.entries()].some(([wid, e]) => wid !== win.id && e.mode === 'edit');
  stopWatch(filePath, win, { notify: false }); // 同窗口重复监听：先清旧（可能连带删除空 Map，须在重新获取引用前）
  let byWin = watchers.get(filePath);
  if (!byWin) {
    byWin = new Map();
    watchers.set(filePath, byWin);
  }
  // Phase 4 编辑权：本窗口原有登记优先（重挂/重开不抢不让）；否则"别人正在编辑 → 本窗口只读"
  const mode = prev ? prev.mode : (editTakenByOther ? 'read' : 'edit');
  const entry = { mtime, timer: null, fsw: null, poller: false, pollFn: null, mode, win };
  byWin.set(win.id, entry);
  hookWindowClose(win); // 窗口关闭 → 自动释放编辑权（Phase 4）
  try {
    // 事件驱动监听（Windows 单文件实测可靠）
    const fsw = fs.watch(filePath, { persistent: true }, () => {
      scheduleCheck(filePath, win.id); // 以 stat+mtime 比对为准（过滤自写、重复事件）
    });
    fsw.on('error', () => fallbackToPoll(filePath, win.id)); // 监听器异步失效 → 轮询兜底
    entry.fsw = fsw;
  } catch {
    fallbackToPoll(filePath, win.id); // 同步失败（路径不可监视）→ 轮询兜底
  }
  // D2：同文件跨窗口 —— 通知新窗口（渲染端自动转只读 + toast；用户可在标签右键解除）
  // Phase 4：该通道**语义不变**（仍是"你是后来者、请以只读打开"）；接管能力另走 doc:claim-edit，
  // 渲染端把这条消息记进锁态表 → 显示只读横幅 + 「✏️ 接管编辑」按钮。
  if (sharedBefore) {
    try {
      win.webContents.send('file-shared-open', { path: filePath });
    } catch { /* 忽略 */ }
  }
}

/** 标记一次本应用写入（写文件 IPC 调用后调用）：按 mtime+size 匹配避免误报；
 *  同时记录宽限窗口（SELF_WRITE_GRACE_MS），吸收事件延迟/合并导致的 mtime 错位回声。 */
async function markSelfWrite(filePath) {
  try {
    const st = await fsp.stat(filePath);
    selfWrites.set(filePath, { mtime: st.mtimeMs, size: st.size, until: Date.now() + SELF_WRITE_GRACE_MS });
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 0.5.0 Phase 4：编辑权接管通道（普通标签；大文件见文件顶部的"两条并行规则"）
// ---------------------------------------------------------------------------

/** 接管编辑（渲染端横幅「✏️ 接管编辑」按钮 → window.api.claimEdit(path)）。
 *  入参：filePath（字符串；该窗口必须已经在监听它，否则说明本窗口没打开这个文件）。
 *  返回：{ ok:true, path, mode:'edit', owner:<本窗口 winId>, exclusive:<是否独占>, demoted:[被降级的 winId] }
 *        失败：{ ok:false, reason:'NOT_WATCHING' | 'NO_WINDOW' }
 *  副作用：非 L3（默认）→ 其余持有者降为 'read' 并收到 file-lock-changed（转只读 + toast）；
 *          L3 打开 → 不降级，改为通知其余窗口 {mode:'edit', sharedEdit:true}（渲染端提示冲突风险）。 */
function claimEdit(filePath, win) {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'NO_WINDOW' };
  const byWin = watchers.get(filePath);
  const entry = byWin ? byWin.get(win.id) : null;
  if (!entry) return { ok: false, reason: 'NOT_WATCHING' };
  entry.mode = 'edit';
  const demoted = [];
  if (conflictPrompt) {
    notifyLock(filePath, { mode: 'edit', owner: win.id, sharedEdit: true }, win.id);
  } else {
    for (const [wid, e] of [...byWin]) {
      if (wid === win.id || e.mode !== 'edit') continue;
      e.mode = 'read';
      demoted.push(wid);
      try {
        e.win.webContents.send('file-lock-changed', { path: filePath, mode: 'read', owner: win.id, self: wid });
      } catch { /* 窗口销毁竞态 */ }
    }
  }
  return { ok: true, path: filePath, mode: 'edit', owner: win.id, exclusive: !conflictPrompt, demoted };
}

/** 交回编辑权（渲染端关掉正在编辑的标签时调用；窗口 closed 由 releaseWindow 自动走同一语义）。
 *  返回 { ok:true, path, mode:'read', wasEdit, notified } 或 { ok:false, reason }。 */
function releaseEdit(filePath, win) {
  if (!win || win.isDestroyed()) return { ok: false, reason: 'NO_WINDOW' };
  const byWin = watchers.get(filePath);
  const entry = byWin ? byWin.get(win.id) : null;
  if (!entry) return { ok: false, reason: 'NOT_WATCHING' };
  const wasEdit = entry.mode === 'edit';
  entry.mode = 'read';
  const notified = wasEdit ? notifyLock(filePath, { mode: 'read', owner: null, freed: true }, win.id) : 0;
  return { ok: true, path: filePath, mode: 'read', owner: null, wasEdit, notified };
}

/** 锁表快照（渲染端/冒烟可观测事实）：本窗口的 mode + 编辑权持有者 + 其它窗口 + 是否多窗口可编辑 */
function lockStateOf(filePath, win) {
  const byWin = watchers.get(filePath);
  const others = [];
  let mine = null;
  let editCount = 0;
  if (byWin) {
    for (const [wid, e] of byWin) {
      if (e.mode === 'edit') editCount++;
      if (win && wid === win.id) mine = e.mode;
      else others.push({ winId: wid, mode: e.mode });
    }
  }
  return {
    path: filePath,
    self: win ? win.id : null,
    mode: mine,
    watching: !!mine,
    owner: editOwnerOf(filePath),
    others,
    editCount,
    multiEdit: editCount > 1,
    conflictPrompt,
  };
}

function registerWatchIpc() {
  ipcMain.handle('fs:watch-file', (e, filePath, mtime) => {
    startWatch(filePath, mtime, winOf(e));
    return true;
  });
  ipcMain.handle('fs:unwatch-file', (e, filePath) => {
    stopWatch(filePath, winOf(e));
    return true;
  });
  // ---------- Phase 4 锁表通道（preload.js 里 window.api.claimEdit/releaseEdit/docLockState/
  //            setConflictPrompt/getConflictPrompt/onFileLockChanged 一一对应） ----------
  ipcMain.handle('doc:claim-edit', (e, filePath) => claimEdit(filePath, winOf(e)));
  ipcMain.handle('doc:release-edit', (e, filePath) => releaseEdit(filePath, winOf(e)));
  ipcMain.handle('doc:lock-state', (e, filePath) => lockStateOf(filePath, winOf(e)));
  ipcMain.handle('doc:set-conflict-prompt', (_e, on) => { conflictPrompt = !!on; return conflictPrompt; });
  ipcMain.handle('doc:get-conflict-prompt', () => conflictPrompt);
}

function stopAllWatches() {
  for (const p of [...watchers.keys()]) {
    for (const [, entry] of watchers.get(p)) {
      clearTimeout(entry.timer);
      if (entry.fsw) {
        try { entry.fsw.close(); } catch { /* 已停止 */ }
      }
      if (entry.poller) {
        // B3 修复（同 stopWatch）：带 listener 精准摘除，别把同路径其它进程内监听一起干掉
        try { if (entry.pollFn) fs.unwatchFile(p, entry.pollFn); } catch { /* 已停止 */ }
      }
    }
    watchers.delete(p);
  }
  closeHooked.clear();
}

module.exports = {
  registerWatchIpc,
  markSelfWrite,
  stopAllWatches,
  /** 冒烟探针专用（不暴露给渲染进程）：读某路径的 watcher 表实况 ——
   *  B3 的 mwNoPollBreak 用它断言「两个窗口都进了轮询兜底」「win1 取消后 win2 的 poller 仍在」。
   *  返回 [{ winId, mode, fsw: !!entry.fsw, poller: !!entry.poller, hasPollFn: !!entry.pollFn, mtime }] */
  __debugWatchers(filePath) {
    const byWin = watchers.get(filePath);
    if (!byWin) return [];
    const out = [];
    for (const [wid, e] of byWin) {
      out.push({ winId: wid, mode: e.mode, fsw: !!e.fsw, poller: !!e.poller, hasPollFn: !!e.pollFn, mtime: e.mtime });
    }
    return out;
  },
};
