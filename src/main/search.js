// 全局搜索 IPC（P6，v0.1.45）：搜索逻辑已迁至 utilityProcess worker（search-worker.js），
// 主进程只做任务转发 / 取消 / 超时兜底 / 进度透传 —— 1GB 工程扫描不再阻塞主进程事件循环
// （搜索期间保存文件 / 改设置等 IPC 即时响应）。
// 对外契约保持不变：search:global 返回 [{ file, line, text, matchIndex }]（上限 maxResults=3000），
// 渲染层调用方（globalsearch.js / AI search_documents / 冒烟）零改动。
const { ipcMain, utilityProcess, app } = require('electron');
const path = require('path');

const SEARCH_TIMEOUT_MS = 120000; // 超时兜底：单任务最长 120s（1GB 工程 ≈ 4s 量级，留足余量）
let worker = null;
let nextId = 1;
let activeId = null;              // 当前活动任务 id（同一时刻至多一个，新任务先取消旧任务）
const pending = new Map();        // id -> { resolve, reject, timer }

function getWindow() {
  const { BrowserWindow } = require('electron');
  const wins = BrowserWindow.getAllWindows();
  return wins.length > 0 ? wins[0] : null;
}

function handleWorkerMessage(msg) {
  if (!msg || typeof msg !== 'object' || !msg.id) return;
  const p = pending.get(msg.id);
  if (msg.type === 'progress') {
    // 进度事件：透传渲染进程（globalsearch.js 用于「已扫描 N 个文件」提示；无订阅方则忽略）
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('search:progress', { id: msg.id, scanned: msg.scanned, matches: msg.matches });
    }
    return;
  }
  if (p) {
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.type === 'done') p.resolve(msg.results || []);
    else if (msg.type === 'error') p.reject(new Error(msg.message || '搜索失败'));
    else if (msg.type === 'cancelled') p.reject(new Error('搜索已取消'));
  }
  if (activeId === msg.id) activeId = null;
}

function spawnWorker() {
  const w = utilityProcess.fork(path.join(__dirname, 'search-worker.js'));
  w.on('message', handleWorkerMessage);
  w.on('exit', () => {
    // worker 意外退出：进行中的任务全部失败（下次调用自动重建）
    worker = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('搜索进程意外退出'));
    }
    pending.clear();
    activeId = null;
  });
  return w;
}

function getWorker() {
  if (worker) return worker;
  worker = spawnWorker();
  return worker;
}

function registerSearchIpc() {
  ipcMain.handle('search:global', async (_e, payload) => {
    const { dir, query, maxResults = 3000 } = payload || {};
    if (!dir || !query) return [];
    // 新任务到来：取消进行中的旧任务（串行保证 worker 单任务；旧调用方收到「搜索已取消」）
    if (activeId && pending.has(activeId)) {
      const old = pending.get(activeId);
      clearTimeout(old.timer);
      pending.delete(activeId);
      try { getWorker().postMessage({ id: activeId, type: 'cancel' }); } catch { /* 忽略 */ }
      old.reject(new Error('搜索已取消'));
    }
    const id = nextId++;
    activeId = id;
    const w = getWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        try { w.postMessage({ id, type: 'cancel' }); } catch { /* 忽略 */ }
        reject(new Error('搜索超时，已终止'));
      }, SEARCH_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        w.postMessage({ id, type: 'search', dir, query, maxResults });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('搜索进程不可用：' + (err && err.message ? err.message : err)));
      }
    });
  });

  // 取消当前搜索（渲染层「取消」按钮 / 冒烟 searchCancel 用）
  ipcMain.handle('search:cancel', () => {
    if (activeId && pending.has(activeId)) {
      const p = pending.get(activeId);
      clearTimeout(p.timer);
      pending.delete(activeId);
      try { getWorker().postMessage({ id: activeId, type: 'cancel' }); } catch { /* 忽略 */ }
      p.reject(new Error('搜索已取消'));
    }
    activeId = null;
    return true;
  });

  // 应用退出时回收 worker 进程
  app.on('will-quit', () => {
    if (worker) {
      try { worker.kill(); } catch { /* 已退出 */ }
      worker = null;
    }
  });
}

module.exports = { registerSearchIpc };
