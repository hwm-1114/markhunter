// 全局搜索 IPC（P6，v0.1.45）：搜索逻辑已迁至 utilityProcess worker（search-worker.js），
// 主进程只做任务转发 / 取消 / 超时兜底 / 进度透传 —— 1GB 工程扫描不再阻塞主进程事件循环
// （搜索期间保存文件 / 改设置等 IPC 即时响应）。
// 对外契约保持不变：search:global 返回 [{ file, line, text, matchIndex }]（上限 maxResults=3000），
// 渲染层调用方（globalsearch.js / 冒烟）零改动。
const { ipcMain, utilityProcess, app, BrowserWindow } = require('electron');
const path = require('path');

const SEARCH_TIMEOUT_MS = 120000; // 超时兜底：单任务最长 120s（1GB 工程 ≈ 4s 量级，留足余量）
const FILES_TIMEOUT_MS = 90000;   // 清单任务超时（A1：大目录首扫；缓存命中时是毫秒级）
let worker = null;
let nextId = 1;
let activeId = null;              // 当前活动任务 id（同一时刻至多一个，新任务先取消旧任务）
const pending = new Map();        // id -> { resolve, reject, timer, win }
// ---------- 0.5.0 Phase 5a A1：文件清单（Ctrl+P 快速打开的数据源） ----------
// 与搜索任务**并行独立**记账（worker 内部也是两套 id），因此"搜索跑着的时候按 Ctrl+P"照样能用。
// 安全面：只读目录清单，不新增任何读文件内容的通道（口径与既有的 search:global 一致：
// 目录参数由渲染端给出，主进程只做遍历与转发，不落盘、不返回文件内容）。
const filesPending = new Map();   // id -> { resolve, reject, timer, win, files: [] }
let filesActiveId = null;
// ---------- v0.10.0：单文件查找（大文件视图内 Ctrl+F） ----------
// 与目录搜索/清单并行独立记账，互不取消；同一时刻至多一个文件查找任务（新任务取代旧任务）。
const FILE_SEARCH_TIMEOUT_MS = 120000;
let fileActiveId = null;

function winOf(e) {
  try {
    return BrowserWindow.fromWebContents(e.sender);
  } catch {
    return null;
  }
}

function handleWorkerMessage(msg) {
  if (!msg || typeof msg !== 'object' || !msg.id) return;
  // ---------- A1：文件清单任务的消息（与搜索消息同一条 MessagePort，按 type 分流） ----------
  if (msg.type === 'files-progress' || msg.type === 'files-done' || (msg.type === 'error' && filesPending.has(msg.id))) {
    const fp = filesPending.get(msg.id);
    if (!fp) return;
    if (msg.type === 'files-progress') {
      if (Array.isArray(msg.files) && msg.files.length) {
        for (const f of msg.files) fp.files.push(f);
      }
      if (fp.win && !fp.win.isDestroyed()) {
        try {
          fp.win.webContents.send('search:files-progress', {
            dir: msg.dir, files: msg.files || [], scanned: msg.scanned, cached: msg.cached === true,
          });
        } catch { /* 窗口销毁竞态 */ }
      }
      return;
    }
    clearTimeout(fp.timer);
    filesPending.delete(msg.id);
    if (filesActiveId === msg.id) filesActiveId = null;
    if (msg.type === 'files-done') fp.resolve({ files: fp.files, total: msg.total, cached: msg.cached === true, truncated: msg.truncated === true });
    else fp.reject(new Error(msg.message || '清单读取失败'));
    return;
  }
  const p = pending.get(msg.id);
  if (msg.type === 'progress') {
    // 进度事件：只发发起任务的窗口（v0.1.51 多窗口路由）
    if (p && p.win && !p.win.isDestroyed()) {
      try {
        p.win.webContents.send('search:progress', { id: msg.id, scanned: msg.scanned, matches: msg.matches });
      } catch { /* 窗口销毁竞态 */ }
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
    for (const [, p] of filesPending) {
      clearTimeout(p.timer);
      p.reject(new Error('搜索进程意外退出'));
    }
    filesPending.clear();
    activeId = null;
    filesActiveId = null;
    fileActiveId = null;
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
    const { dir, query, maxResults = 10000 } = payload || {};
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
    const reqWin = winOf(_e); // 进度事件的目的窗口
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        try { w.postMessage({ id, type: 'cancel' }); } catch { /* 忽略 */ }
        reject(new Error('搜索超时，已终止'));
      }, SEARCH_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, win: reqWin });
      try {
        w.postMessage({ id, type: 'search', dir, query, maxResults });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('搜索进程不可用：' + (err && err.message ? err.message : err)));
      }
    });
  });

  // ---------- v0.10.0：单文件查找（大文件视图内 Ctrl+F） ----------
  // 返回 [{ file, line, text, matchIndex }]（与 search:global 的内容命中同形状），上限 maxResults。
  // 扫描与目录搜索共用 worker 的 scanFileInto：>128MB 走分片、编码探测、每行最多一条，口径完全一致。
  ipcMain.handle('search:file', (_e, payload) => {
    const { file, query, maxResults = 500 } = payload || {};
    if (!file || !query) return [];
    if (fileActiveId && pending.has(fileActiveId)) {
      const old = pending.get(fileActiveId);
      clearTimeout(old.timer);
      pending.delete(fileActiveId);
      try { getWorker().postMessage({ id: fileActiveId, type: 'cancel' }); } catch { /* 忽略 */ }
      old.reject(new Error('查找已被新的请求取代'));
    }
    const id = nextId++;
    fileActiveId = id;
    const w = getWorker();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        if (fileActiveId === id) fileActiveId = null;
        try { w.postMessage({ id, type: 'cancel' }); } catch { /* 忽略 */ }
        reject(new Error('文件查找超时，已终止'));
      }, FILE_SEARCH_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, win: winOf(_e) });
      try {
        w.postMessage({ id, type: 'search-file', file, query, maxResults });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('搜索进程不可用：' + (err && err.message ? err.message : err)));
      }
    });
  });

  ipcMain.handle('search:file-cancel', () => {
    if (fileActiveId && pending.has(fileActiveId)) {
      const p = pending.get(fileActiveId);
      clearTimeout(p.timer);
      pending.delete(fileActiveId);
      try { getWorker().postMessage({ id: fileActiveId, type: 'cancel' }); } catch { /* 忽略 */ }
      p.reject(new Error('文件查找已取消'));
    }
    fileActiveId = null;
    return true;
  });

  // ---------- 0.5.0 Phase 5a A1：工作目录文件清单（Ctrl+P 快速打开） ----------
  // 返回 { files, total, cached, truncated }；进度经 'search:files-progress' 事件流式下发
  // （只发发起窗口 —— 与 search:progress 的多窗口路由口径一致）。
  ipcMain.handle('search:files', (_e, payload) => {
    const dir = payload && payload.dir;
    if (!dir) return { files: [], total: 0, cached: false, truncated: false };
    // 新清单任务到来：立即使旧任务失败（worker 内部同一时刻只跑一个清单任务，
    // 不 reject 的话旧调用方会一直挂到超时）
    if (filesActiveId && filesPending.has(filesActiveId)) {
      const old = filesPending.get(filesActiveId);
      clearTimeout(old.timer);
      filesPending.delete(filesActiveId);
      try { getWorker().postMessage({ id: filesActiveId, type: 'files-cancel' }); } catch { /* 忽略 */ }
      old.reject(new Error('清单请求已被新的请求取代'));
    }
    const id = nextId++;
    filesActiveId = id;
    const w = getWorker();
    const reqWin = winOf(_e);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!filesPending.has(id)) return;
        filesPending.delete(id);
        try { w.postMessage({ id, type: 'files-cancel' }); } catch { /* 忽略 */ }
        reject(new Error('目录清单读取超时'));
      }, FILES_TIMEOUT_MS);
      filesPending.set(id, { resolve, reject, timer, win: reqWin, files: [] });
      try {
        w.postMessage({ id, type: 'files', dir });
      } catch (err) {
        clearTimeout(timer);
        filesPending.delete(id);
        reject(new Error('搜索进程不可用：' + (err && err.message ? err.message : err)));
      }
    });
  });

  // 取消当前清单任务（窗口关闭/切换目录时用；渲染端 also 可只靠"新任务取代旧任务"）
  ipcMain.handle('search:files-cancel', () => {
    if (filesActiveId && filesPending.has(filesActiveId)) {
      const p = filesPending.get(filesActiveId);
      clearTimeout(p.timer);
      filesPending.delete(filesActiveId);
      try { getWorker().postMessage({ id: filesActiveId, type: 'files-cancel' }); } catch { /* 忽略 */ }
      p.reject(new Error('清单请求已取消'));
    }
    filesActiveId = null;
    return true;
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
