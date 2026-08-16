// 文件变更监听：外部编辑器修改磁盘文件时通知渲染进程
// 使用 fs.watchFile（轮询 stat）：Windows 上 fs.watch 单文件偶发不触发/不稳定
const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;

const watchers = new Map();  // path -> { mtime, timer }
const selfWrites = new Map(); // path -> 最近一次自写的 mtime（按 mtime 精确匹配，一次性消费）

function getWin() {
  const { BrowserWindow } = require('electron');
  return BrowserWindow.getAllWindows()[0] || null;
}

function stopWatch(filePath) {
  const entry = watchers.get(filePath);
  if (entry) {
    clearTimeout(entry.timer);
    try {
      fs.unwatchFile(filePath);
    } catch {
      /* 已停止 */
    }
    watchers.delete(filePath);
  }
}

async function checkAndNotify(filePath) {
  const entry = watchers.get(filePath);
  if (!entry) return;
  try {
    const st = await fsp.stat(filePath);
    // 若与本应用最近一次写入的 mtime 一致，视为本地保存，跳过通知
    const selfMtime = selfWrites.get(filePath);
    if (selfMtime !== undefined) {
      selfWrites.delete(filePath);
      if (st.mtimeMs === selfMtime) {
        entry.mtime = st.mtimeMs;
        return;
      }
      // mtime 不同：本地写入之后又被外部修改过，继续走通知逻辑
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

function startWatch(filePath, mtime) {
  stopWatch(filePath);
  try {
    fs.watchFile(filePath, { interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return; // 内容未变
      const entry = watchers.get(filePath);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => checkAndNotify(filePath), 300);
    });
    watchers.set(filePath, { mtime, timer: null });
  } catch {
    /* 文件不可监视则忽略 */
  }
}

/** 标记一次本应用写入（写文件 IPC 调用后调用），按写入后的 mtime 精确匹配避免误报 */
async function markSelfWrite(filePath) {
  try {
    const st = await fsp.stat(filePath);
    selfWrites.set(filePath, st.mtimeMs);
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

