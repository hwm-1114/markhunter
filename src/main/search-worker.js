// search-worker.js —— 全局搜索 worker（P6，v0.1.45）
// 由主进程 utilityProcess.fork 启动（Electron 内置，worker 文件在 src/** 内随 asar 打包）。
// 搜索逻辑整体迁移自原 search.js（遍历/过滤/匹配口径完全一致），主进程只负责转发与取消，
// 1GB 工程扫描不再占用主进程事件循环（保存/设置等 IPC 不再排队）。
//
// 通信协议（MessagePort，process.parentPort）：
//   主 → worker: { id, type:'search', dir, query, maxResults } | { id, type:'cancel' }
//   worker → 主: { id, type:'progress', scanned, matches }   （每扫描 PROGRESS_EVERY 个文件）
//                 { id, type:'done', results }               （正常完成）
//                 { id, type:'cancelled' }                   （被取消）
//                 { id, type:'error', message }              （失败）
// worker 同一时刻只跑一个任务：新 search 消息会替换 currentId（主进程已保证串行）。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', 'env', 'dist', 'out', 'build', 'release',
]);

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.py', '.js', '.ts', '.jsx', '.tsx',
  '.html', '.htm', '.css', '.scss', '.xml', '.yaml', '.yml', '.ini', '.cfg',
  '.conf', '.log', '.csv', '.toml', '.sh', '.bat', '.cmd', '.ps1', '.c', '.h',
  '.cpp', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.vue', '.svelte',
]);

const MAX_SEARCH_FILE_MB = 10;      // 小文件路径上限：整读进内存逐行匹配
const MAX_STREAM_FILE_MB = 4096;    // 1B-4：大文件流式扫描上限（readline 流式逐行，内存有界）
const PROGRESS_EVERY = 25;          // 每扫描 25 个文件回传一次进度（1GB 工程 ≈ 数千文件 → 数百条进度）

/** 大文件流式行扫描（>10MB）：readline 逐行（8MB 高水位），行号全局精确；
 *  结果行文本截断 1000 字符防超长行撑爆结果集。返回是否达到 maxResults。 */
async function scanStream(file, q, results, maxResults, isCancelled) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 8 * 1024 * 1024 }),
    crlfDelay: Infinity,
  });
  let ln = 0;
  let check = 0;
  try {
    for await (const line of rl) {
      ln++;
      if (++check >= 50000) {
        check = 0;
        if (isCancelled()) return true; // 任务被替换/取消：停止扫描本文件
      }
      const idx = line.toLowerCase().indexOf(q);
      if (idx >= 0) {
        results.push({ file, line: ln, text: line.length > 1000 ? line.slice(0, 1000) : line, matchIndex: idx });
        if (results.length >= maxResults) return true;
      }
    }
  } finally {
    rl.close();
  }
  return false;
}

let currentId = null;   // 当前任务 id（新 search 覆盖旧任务，旧任务在下次迭代点自行退出）
let cancelled = false;  // 取消标记（cancel 消息置位，walk/行扫描间隙检查）

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue; // 隐藏项跳过（与原逻辑一致）
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

/** 单任务执行：返回 { results } 或 { cancelled: true }（任务被替换/取消时提前退出） */
async function runSearch(id, dir, query, maxResults) {
  const q = String(query).toLowerCase();
  const isCancelled = () => cancelled || currentId !== id;
  const results = [];
  let scanned = 0;
  for await (const file of walk(dir)) {
    if (isCancelled()) return { cancelled: true };
    scanned++;
    if (scanned % PROGRESS_EVERY === 0) {
      process.parentPort.postMessage({ id, type: 'progress', scanned, matches: results.length });
    }
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    if (st.size === 0) continue;
    if (st.size > MAX_SEARCH_FILE_MB * 1024 * 1024) {
      // 1B-4：大文件走流式扫描（≤4GB），不再整体跳过
      if (st.size > MAX_STREAM_FILE_MB * 1024 * 1024) continue;
      const full = await scanStream(file, q, results, maxResults, isCancelled);
      if (isCancelled()) return { cancelled: true };
      if (full) return { results };
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toLowerCase().indexOf(q);
      if (idx >= 0) {
        results.push({ file, line: i + 1, text: lines[i], matchIndex: idx });
        if (results.length >= maxResults) return { results }; // 截断（与原逻辑一致）
      }
    }
  }
  return { results };
}

process.parentPort.on('message', (e) => {
  const msg = e && e.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'search') {
    currentId = msg.id;
    cancelled = false;
    const { id, dir, query } = msg;
    const maxResults = Number.isFinite(msg.maxResults) ? msg.maxResults : 3000;
    if (!dir || !query) {
      process.parentPort.postMessage({ id, type: 'done', results: [] });
      return;
    }
    runSearch(id, dir, query, maxResults)
      .then((r) => {
        if (r.cancelled) process.parentPort.postMessage({ id, type: 'cancelled' });
        else process.parentPort.postMessage({ id, type: 'done', results: r.results });
      })
      .catch((err) => {
        process.parentPort.postMessage({
          id,
          type: 'error',
          message: (err && err.message) || String(err),
        });
      });
  } else if (msg.type === 'cancel') {
    if (msg.id === currentId) cancelled = true;
  }
});
