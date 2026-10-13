// search-worker.js —— 全局搜索 worker（P6，v0.1.45）
// 由主进程 utilityProcess.fork 启动（Electron 内置，worker 文件在 src/** 内随 asar 打包）。
// 搜索逻辑整体迁移自原 search.js（遍历/过滤/匹配口径完全一致），主进程只负责转发与取消，
// 1GB 工程扫描不再占用主进程事件循环（保存/设置等 IPC 不再排队）。
//
// 通信协议（MessagePort，process.parentPort）：
//   主 → worker: { id, type:'search', dir, query, maxResults } | { id, type:'cancel' }
//                { id, type:'files', dir }                    （0.5.0 A1：快速打开的文件清单）
//                { id, type:'files-cancel' }
//   worker → 主: { id, type:'progress', scanned, matches }   （每扫描 PROGRESS_EVERY 个文件）
//                 { id, type:'done', results }               （正常完成）
//                 { id, type:'cancelled' }                   （被取消）
//                 { id, type:'error', message }              （失败）
//                 { id, type:'files-progress', dir, files, scanned, cached }（清单分批下发）
//                 { id, type:'files-done', dir, total, cached }（清单完成）
// worker 同一时刻只跑一个搜索任务：新 search 消息会替换 currentId（主进程已保证串行）。
// **文件清单任务（A1）与搜索任务互相独立**（filesId 单独记账）：快速打开可以在搜索进行中并行取清单，
// 两者共用同一套 walk()/SKIP_DIRS 过滤口径，因此"清单里有 = 搜得到"，不会出现两套目录规则。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

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
const MAX_STREAM_FILE_MB = 5120;    // 1B-4：大文件流式扫描上限（v0.7.0：4GB→5GB，与打开上限同步）
const PROGRESS_EVERY = 25;          // 每扫描 25 个文件回传一次进度（1GB 工程 ≈ 数千文件 → 数百条进度）

const ASCII_ONLY = /^[\x20-\x7e]+$/; // 纯可打印 ASCII 查询 → 走原生字节匹配快路径

/** 大小写不敏感的原生字节匹配：返回 chunk 内命中偏移（升序），每个 needle 最多收集 cap 个。
 *  cap 的意义：只需全局前 maxResults 条结果，密集查询（如单空格）若全量收集会吃满内存与排序时间。
 *  ASCII 查询在 UTF-8 与 GBK 下字节表示一致，故两种编码共用同一快路径。 */
function nativeMatches(chunk, needles, cap) {
  const out = [];
  for (const nd of needles) {
    let from = 0;
    let taken = 0;
    for (;;) {
      const i = chunk.indexOf(nd, from);
      if (i < 0) break;
      out.push(i);
      taken++;
      if (taken >= cap) break;
      from = i + 1; // 允许重叠命中（与逐行 indexOf 语义一致）
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 大文件流式扫描（>10MB，v0.4.0 快路径）：原生 Buffer.indexOf 直接匹配原始字节。
 *  - 快路径（查询串为纯 ASCII）：8MB 块上原生匹配，行号由块内换行位置二分得到，
 *    兼容 UTF-8 / GBK（ASCII 字节两者一致）；大小写不敏感 = 小写/大写两个 needle 各扫一遍再归并。
 *  - 回退路径（含非 ASCII，如中文关键词）：仍走增量解码 + 逐行匹配（语义与 v0.2.1 一致）。
 *  返回是否达到 maxResults。 */
async function scanStream(file, rawQuery, q, results, maxResults, isCancelled) {
  const needles = ASCII_ONLY.test(String(rawQuery || ''))
    ? [...new Set([rawQuery.toLowerCase(), rawQuery.toUpperCase()])].filter(Boolean).map((s) => Buffer.from(s, 'latin1'))
    : null;

  let enc = null;
  let dec = null;
  let strBuf = '';        // 回退路径：解码后的字符串缓冲
  let ln = 0;             // 已消费的完整行数（全局）
  let check = 0;
  const CHUNK = 8 * 1024 * 1024;
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK });
  let tail = Buffer.alloc(0); // 跨块命中：保留上一块尾部 needle.length-1 字节
  const maxNeedle = needles ? Math.max(...needles.map((b) => b.length)) : 0;
  try {
    for await (const chunk of stream) {
      if (!enc) {
        // 首块探测：截去尾部 4 字节（避免块边界截断多字节字符导致误判）
        const probe = chunk.subarray(0, Math.max(0, chunk.length - 4));
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(probe);
          enc = 'utf-8';
        } catch {
          enc = 'gbk'; // Windows 环境大文件中文编码次选
        }
        dec = new TextDecoder(enc, { stream: true });
      }

      if (needles) {
        // ---------- 快路径：字节匹配 ----------
        const stitched = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        const newStart = tail.length; // 只报告「起点落在本块」的命中，避免与上一块重复
        const hits = nativeMatches(stitched, needles, Math.max(1, maxResults - results.length));
        if (hits.length) {
          // 块内换行位置（仅本块新增部分参与行号累加，tail 的换行已在上一块计入 ln）
          const nlPos = [];
          let p = stitched.indexOf(0x0a, newStart);
          while (p >= 0) { nlPos.push(p); p = stitched.indexOf(0x0a, p + 1); }
          for (const hit of hits) {
            if (hit < newStart) continue; // 起点在 tail 内：上一块已报告
            // 行号 = 已消费行数 + 本块内该命中之前的换行数 + 1
            let lo = 0;
            let hi = nlPos.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (nlPos[mid] < hit) lo = mid + 1; else hi = mid; }
            const lineNo = ln + lo + 1;
            // 行首/行尾（行首可能在 tail 内，行尾可能超出本块 → 文本截断显示）
            let ls = stitched.lastIndexOf(0x0a, hit - 1);
            ls = ls < 0 ? 0 : ls + 1;
            let le = stitched.indexOf(0x0a, hit);
            if (le < 0) le = stitched.length;
            const rawLine = stitched.subarray(ls, le);
            let text;
            try { text = new TextDecoder(enc).decode(rawLine); } catch { text = rawLine.toString('latin1'); }
            text = text.replace(/\r$/, '');
            const mi = text.toLowerCase().indexOf(q);
            results.push({ file, line: lineNo, text: text.length > 1000 ? text.slice(0, 1000) : text, matchIndex: mi < 0 ? 0 : mi });
            if (results.length >= maxResults) return true;
          }
        }
        ln += (() => { let c = 0; let p = chunk.indexOf(0x0a); while (p >= 0) { c++; p = chunk.indexOf(0x0a, p + 1); } return c; })();
        tail = chunk.subarray(Math.max(0, chunk.length - Math.max(0, maxNeedle - 1)));
        if (++check >= 8) {
          check = 0;
          if (isCancelled()) return true;
        }
        continue;
      }

      // ---------- 回退路径：增量解码 + 逐行匹配（语义同 v0.2.1） ----------
      strBuf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = strBuf.indexOf('\n')) >= 0) {
        const line = strBuf.slice(0, idx).replace(/\r$/, '');
        strBuf = strBuf.slice(idx + 1);
        ln++;
        if (++check >= 50000) {
          check = 0;
          if (isCancelled()) return true;
        }
        const hit = line.toLowerCase().indexOf(q);
        if (hit >= 0) {
          results.push({ file, line: ln, text: line.length > 1000 ? line.slice(0, 1000) : line, matchIndex: hit });
          if (results.length >= maxResults) return true;
        }
      }
    }
    if (strBuf.length) {
      ln++;
      const hit = strBuf.toLowerCase().indexOf(q);
      if (hit >= 0) {
        results.push({ file, line: ln, text: strBuf.length > 1000 ? strBuf.slice(0, 1000) : strBuf, matchIndex: hit });
      }
    }
  } finally {
    stream.destroy();
  }
  return false;
}

let currentId = null;   // 当前任务 id（新 search 覆盖旧任务，旧任务在下次迭代点自行退出）
let cancelled = false;  // 取消标记（cancel 消息置位，walk/行扫描间隙检查）

// ---------- 0.5.0 Phase 5a A1：快速打开的文件清单（缓存 + 增量下发） ----------
// 目标：Ctrl+P 首次呼出**不等整目录扫完**（冒烟/真实工程里 node_modules 级别的目录首扫可达数秒），
// 因此清单按 200 个/批流式回传，渲染端拿到一批就能先匹配；同时按目录缓存整份清单，
// 第二次呼出（含搜索期间再按）零扫描直接命中。
const FILE_CACHE_MAX = 8;      // 最多缓存 8 个目录（FIFO 淘汰；一个窗口的侧栏根上限是 12）
const FILE_CHUNK = 200;        // 每批下发的文件数
const FILE_LIST_MAX = 20000;   // 单目录清单上限（防病态目录把内存/消息撑爆）
const fileCache = new Map();   // dir → string[]（值即最终清单本身，命中时整份下发）
let filesId = null;
let filesCancelled = false;

function fileCacheSet(dir, list) {
  if (fileCache.has(dir)) fileCache.delete(dir);
  fileCache.set(dir, list);
  while (fileCache.size > FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value);
}

/** 建立/复用某目录的文件清单（与搜索共用 walk()：隐藏项与 SKIP_DIRS 口径完全一致） */
async function runFileList(id, dir) {
  filesId = id;
  filesCancelled = false;
  if (!dir) {
    process.parentPort.postMessage({ id, type: 'files-done', dir: '', total: 0, cached: false });
    return;
  }
  const cached = fileCache.get(dir);
  if (cached) {
    // 缓存命中：一次性整份下发（前端仍是同一套"收批 → 匹配"逻辑，只是只有一批）
    process.parentPort.postMessage({ id, type: 'files-progress', dir, files: cached, scanned: cached.length, cached: true });
    process.parentPort.postMessage({ id, type: 'files-done', dir, total: cached.length, cached: true });
    return;
  }
  const out = [];
  let batch = [];
  let scanned = 0;
  try {
    for await (const file of walk(dir)) {
      if (filesCancelled || filesId !== id) return; // 被取消/被新任务替换：静默退出（主进程已 reject 旧任务）
      scanned++;
      out.push(file);
      batch.push(file);
      if (batch.length >= FILE_CHUNK) {
        process.parentPort.postMessage({ id, type: 'files-progress', dir, files: batch, scanned, cached: false });
        batch = [];
      }
      if (out.length >= FILE_LIST_MAX) break;
    }
    if (batch.length) process.parentPort.postMessage({ id, type: 'files-progress', dir, files: batch, scanned, cached: false });
    fileCacheSet(dir, out);
    process.parentPort.postMessage({ id, type: 'files-done', dir, total: out.length, cached: false, truncated: out.length >= FILE_LIST_MAX });
  } catch (err) {
    process.parentPort.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
}

/** 递归遍历目录。
 *  缺省只产出文件路径（string）—— runFileList（Ctrl+P 快速打开）沿用；
 *  opts.withDirs=true 时产出 { path, isDir }（目录也会作为条目产出）——
 *  全局搜索用它做**文件名/目录名匹配**（v0.6.0：全局搜索的匹配对象扩为
 *  文件内容 + 文件名 + 目录名，三者共用同一次遍历）。 */
async function* walk(dir, opts = {}) {
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
      if (opts.withDirs) yield { path: full, isDir: true };
      yield* walk(full, opts);
    } else {
      if (opts.withDirs) yield { path: full, isDir: false };
      else yield full;
    }
  }
}

/** 单任务执行：返回 { results } 或 { cancelled: true }（任务被替换/取消时提前退出）。
 *  v0.6.0：除文件内容外，**文件名与目录名**也参与匹配（大小写不敏感子串，与内容同口径）。
 *  结果条目的 kind 字段：'name'（文件名命中，line=0）/ 'dir'（目录名命中，line=0）/
 *  缺省 = 内容命中（既有形态，渲染端与替换逻辑零改动兼容）。名字命中与内容命中可并存
 *  （同一文件两条结果，渲染端按文件分组后行级区分展示）。 */
async function runSearch(id, dir, query, maxResults) {
  const q = String(query).toLowerCase();
  const isCancelled = () => cancelled || currentId !== id;
  const results = [];
  let scanned = 0;
  for await (const ent of walk(dir, { withDirs: true })) {
    if (isCancelled()) return { cancelled: true };
    // 名字匹配（文件名与目录名统一处理）
    if (path.basename(ent.path).toLowerCase().indexOf(q) >= 0) {
      results.push({
        file: ent.path,
        line: 0,
        text: '',
        matchIndex: 0,
        kind: ent.isDir ? 'dir' : 'name',
      });
      if (results.length >= maxResults) return { results };
    }
    if (ent.isDir) continue; // 目录无内容可扫
    const file = ent.path;
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
      const full = await scanStream(file, query, q, results, maxResults, isCancelled);
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
  if (msg.type === 'files') {
    runFileList(msg.id, msg.dir);
  } else if (msg.type === 'files-cancel') {
    if (msg.id === filesId) filesCancelled = true;
  } else if (msg.type === 'search') {
    currentId = msg.id;
    cancelled = false;
    const { id, dir, query } = msg;
    const maxResults = Number.isFinite(msg.maxResults) ? msg.maxResults : 10000;
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
