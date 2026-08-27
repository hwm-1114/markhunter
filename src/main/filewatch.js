// 文件变更监听：外部编辑器修改磁盘文件时通知渲染进程
// P8（v0.1.45）：主监听改为 fs.watch（事件驱动，50 标签不再 = 50 个 500ms stat 轮询）。
// v0.1.51 多窗口：watcher 按窗口隔离（path → winId → entry）——变更只通知监听该文件的各窗口；
// 同一文件被第二个窗口打开时向新窗口发 'file-shared-open'（渲染端自动以只读打开，D2）。
const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;

const watchers = new Map(); // path -> Map<winId, { mtime, timer, fsw, poller, win }>
const selfWrites = new Map(); // path -> { mtime, size, until } 最近一次自写的 mtime/大小与宽限截止时刻

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

function stopWatch(filePath, win) {
  const byWin = watchers.get(filePath);
  if (!byWin) return;
  const id = win ? win.id : null;
  for (const [wid, entry] of byWin) {
    if (id !== null && wid !== id) continue; // 只清理指定窗口的 watcher
    clearTimeout(entry.timer);
    if (entry.fsw) {
      try { entry.fsw.close(); } catch { /* 已停止 */ }
    }
    if (entry.poller) {
      try { fs.unwatchFile(filePath); } catch { /* 已停止 */ }
    }
    byWin.delete(wid);
  }
  if (byWin.size === 0) watchers.delete(filePath);
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
  for (const w of wins) {
    const entry = watchers.get(filePath)?.get(w.id);
    if (!entry) continue;
    if (st.mtimeMs !== entry.mtime) {
      entry.mtime = st.mtimeMs;
      try {
        w.webContents.send('file-changed', { path: filePath, mtime: st.mtimeMs });
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
    fs.watchFile(filePath, { interval: POLL_INTERVAL }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return; // 内容未变
      scheduleCheck(filePath, winId);
    });
    entry.poller = true;
  } catch {
    /* 文件不可监视则忽略 */
  }
}

function startWatch(filePath, mtime, win) {
  if (!win || win.isDestroyed()) return;
  // 共享判断须在清理前做：除本窗口外是否已有其它窗口在监听同一文件（D2 跨窗口通知依据）
  const old = watchers.get(filePath);
  const sharedBefore = !!old && [...old.keys()].some((wid) => wid !== win.id);
  stopWatch(filePath, win); // 同窗口重复监听：先清旧（可能连带删除空 Map，须在重新获取引用前）
  let byWin = watchers.get(filePath);
  if (!byWin) {
    byWin = new Map();
    watchers.set(filePath, byWin);
  }
  const entry = { mtime, timer: null, fsw: null, poller: false, win };
  byWin.set(win.id, entry);
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

function registerWatchIpc() {
  ipcMain.handle('fs:watch-file', (e, filePath, mtime) => {
    startWatch(filePath, mtime, winOf(e));
    return true;
  });
  ipcMain.handle('fs:unwatch-file', (e, filePath) => {
    stopWatch(filePath, winOf(e));
    return true;
  });
}

function stopAllWatches() {
  for (const p of [...watchers.keys()]) {
    for (const [, entry] of watchers.get(p)) {
      clearTimeout(entry.timer);
      if (entry.fsw) {
        try { entry.fsw.close(); } catch { /* 已停止 */ }
      }
      if (entry.poller) {
        try { fs.unwatchFile(p); } catch { /* 已停止 */ }
      }
    }
    watchers.delete(p);
  }
}

module.exports = { registerWatchIpc, markSelfWrite, stopAllWatches };
