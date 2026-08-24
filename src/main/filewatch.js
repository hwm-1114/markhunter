// 文件变更监听：外部编辑器修改磁盘文件时通知渲染进程
// P8（v0.1.45）：主监听改为 fs.watch（事件驱动，50 标签不再 = 50 个 500ms stat 轮询）。
// 选型依据（探针实证，见 .probe-watch.js）：Windows 上 fs.watch 单文件直接写 20/20 送达、
// 原子替换（temp+rename 覆盖）20/20 送达、且替换后监听持续有效 —— 现代 libuv 已解决历史
// 「单文件偶发不触发」问题。残余风险（极端情况下监听失效）用 error/同步失败 → fs.watchFile
// 1000ms 轮询兜底（退化为原方案，语义不变）。通知后仍按 mtime 比对，语义与旧实现一致。
const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;

const watchers = new Map();  // path -> { mtime, timer, fsw, poller }
const selfWrites = new Map(); // path -> { mtime, size, until } 最近一次自写的 mtime/大小与宽限截止时刻

// 通知防抖：聚合 fs.watch 一次变更可能触发的多条事件（Windows 实测 ~2 事件/次写），
// 也覆盖「写入 → markSelfWrite 记录 mtime」的毫秒级竞态（T3），300ms 后统一 stat 比对。
const NOTIFY_DEBOUNCE = 300;
const POLL_INTERVAL = 1000; // 兜底轮询间隔（原 500ms 减半轮询频率，externalChange 冒烟 1500ms 等待仍覆盖 1300ms 最坏时延）
// 自写宽限窗口：写盘后短时间内的变更一律视为自身写入的延迟回声（吸收，不通知）。
// 背景：Windows fs.watch 事件在高频写入下会延迟/合并，且 markSelfWrite 的 stat 在高 IO 负载
// （杀毒/索引）下也可能滞后 —— 检查拿到新状态而记录还是旧值时，精确匹配失败就会误报
// 「已在外部被修改」，打字快、自动保存频繁时反复弹确认框（用户可感知的严重误报）。
// 代价：宽限窗口内紧随自写发生的真实外部修改会被吸收一次（entry.mtime 同步刷新，
// 后续外部修改恢复正常通知）；停止编辑 2s 后检测完全恢复。
const SELF_WRITE_GRACE_MS = 2000;

function getWin() {
  const { BrowserWindow } = require('electron');
  return BrowserWindow.getAllWindows()[0] || null;
}

function stopWatch(filePath) {
  const entry = watchers.get(filePath);
  if (entry) {
    clearTimeout(entry.timer);
    if (entry.fsw) {
      try { entry.fsw.close(); } catch { /* 已停止 */ }
    }
    if (entry.poller) {
      try { fs.unwatchFile(filePath); } catch { /* 已停止 */ }
    }
    watchers.delete(filePath);
  }
}

async function checkAndNotify(filePath) {
  const entry = watchers.get(filePath);
  if (!entry) return;
  try {
    const st = await fsp.stat(filePath);
    const rec = selfWrites.get(filePath);
    if (rec) {
      if (st.mtimeMs === rec.mtime && st.size === rec.size) {
        selfWrites.delete(filePath);
        entry.mtime = st.mtimeMs;
        return;
      }
      if (Date.now() < rec.until) {
        // 自写宽限内：事件延迟/stat 滞后导致的记录错位回声，吸收本次变化
        // （rec 同步为当前状态，窗口内后续回声同样吸收；宽限过期后恢复正常外部修改检测）
        rec.mtime = st.mtimeMs;
        rec.size = st.size;
        entry.mtime = st.mtimeMs;
        return;
      }
      // 宽限外且与记录不符：本地写入之后又被外部修改过，继续走通知逻辑
    }
    if (st.mtimeMs !== entry.mtime) {
      entry.mtime = st.mtimeMs;
      const win = getWin();
      if (win) win.webContents.send('file-changed', { path: filePath, mtime: st.mtimeMs });
    }
  } catch {
    /* 文件可能被删除/不可读，忽略 */
  }
}

/** 事件到达后的统一入口：防抖合并 → 一次 stat 比对（fs.watch 与轮询兜底共用） */
function scheduleCheck(filePath) {
  const entry = watchers.get(filePath);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => checkAndNotify(filePath), NOTIFY_DEBOUNCE);
}

/** 兜底：fs.watch 不可用/失效时退回 fs.watchFile 1000ms 轮询（原方案语义） */
function fallbackToPoll(filePath) {
  const entry = watchers.get(filePath);
  if (!entry || entry.poller) return;
  if (entry.fsw) {
    try { entry.fsw.close(); } catch { /* 忽略 */ }
    entry.fsw = null;
  }
  try {
    fs.watchFile(filePath, { interval: POLL_INTERVAL }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return; // 内容未变
      scheduleCheck(filePath);
    });
    entry.poller = true;
  } catch {
    /* 文件不可监视则忽略 */
  }
}

function startWatch(filePath, mtime) {
  stopWatch(filePath);
  const entry = { mtime, timer: null, fsw: null, poller: false };
  watchers.set(filePath, entry);
  try {
    // 事件驱动监听（Windows 单文件实测可靠，探针见 .probe-watch.js）
    const fsw = fs.watch(filePath, { persistent: true }, (eventType) => {
      scheduleCheck(filePath); // 不直接用 eventType/name：以 stat+mtime 比对为准（过滤自写、重复事件）
    });
    fsw.on('error', () => fallbackToPoll(filePath)); // 监听器异步失效 → 轮询兜底
    entry.fsw = fsw;
  } catch {
    fallbackToPoll(filePath); // 同步失败（路径不可监视）→ 轮询兜底
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
  ipcMain.handle('fs:watch-file', (_e, filePath, mtime) => {
    startWatch(filePath, mtime);
    return true;
  });
  ipcMain.handle('fs:unwatch-file', (_e, filePath) => {
    stopWatch(filePath);
    return true;
  });
}

function stopAllWatches() {
  for (const p of [...watchers.keys()]) stopWatch(p);
}

module.exports = { registerWatchIpc, markSelfWrite, stopAllWatches };
