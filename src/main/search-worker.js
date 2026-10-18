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
const os = require('os');
const { Worker } = require('worker_threads');

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
const MAX_STREAM_FILE_MB = 20480;   // 大文件流式扫描上限（v0.9.0：5GB→20GB，与打开上限 20GB 同步；
                                    // 旧值 5GB 会让 10GB 文件被**静默跳过** → 搜索 0 命中）
const PROGRESS_EVERY = 25;          // 每扫描 25 个文件回传一次进度（1GB 工程 ≈ 数千文件 → 数百条进度）
const SHARD_MIN_BYTES = 128 * 1024 * 1024; // >128MB 的单文件才走多线程分片（分片启动约 50ms）
const SHARD_MAX = 8;

const ASCII_ONLY = /^[\x20-\x7e]+$/; // 纯可打印 ASCII 查询 → 走原生字节匹配快路径
const FALLBACK_BUF_MAX = 1024 * 1024;  // 回退路径 strBuf 截断消费阈值（无换行巨文件防无界增长）
const FALLBACK_BUF_KEEP = 256 * 1024;  // 截断后保留的尾部：远大于 1000 字符显示截断与查询长度，跨段命中不丢

/** ASCII 字母字节判定（大小写折叠只对字母生效，符号/数字必须精确匹配） */
function isAsciiLetter(b) {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

// 字节频率表（‰，近似 English/日志文本；数值越低越适合作锚点）—— v0.9.0 重写。
// 旧实现用「LETTER_FREQ，非字母记 0」，把空格/数字当成"最稀有"：实测查询 "SECTION 2000000"
// 的锚点落在空格上（文本里 ~18%），5GB 文件产生约 6 亿次 indexOf 候选 → 搜索 20s。
// 现在给 0x20-0x7e 全部可见字符填真实频率（空格 180‰、字母按语料、数字/标点 0.2~9‰），
// 锚点必然落在真正稀疏的字节上（"SECTION 2000000" → 数字 '2' 7‰，候选量降 25 倍）。
const BYTE_FREQ = (() => {
  const f = new Float32Array(256);
  for (let i = 0; i < 256; i++) f[i] = 0.05;  // 控制符/高位字节：文本里几乎不出现（比任何可见字符稀有）
  f[0x20] = 180;                              // 空格 ~18%
  const lower = [82, 15, 28, 43, 127, 22, 20, 61, 70, 1.5, 8, 40, 24, 67, 75, 19, 1,
    60, 63, 91, 28, 10, 24, 1.5, 20, 0.7];    // a-z（‰，为常见百分比表的 10 倍）
  for (let i = 0; i < 26; i++) { f[0x61 + i] = lower[i]; f[0x41 + i] = lower[i]; } // 大小写共用同一频度（两变体都扫）
  const digit = [9, 9, 7, 4, 4, 4, 4, 4, 4, 4]; // 0-9（日志里时间戳/序号占比高，仍远低于空格）
  for (let i = 0; i < 10; i++) f[0x30 + i] = digit[i];
  const punct = {
    0x2e: 25, 0x2c: 10, 0x2d: 15, 0x3a: 5, 0x3b: 1, 0x2f: 4, 0x3d: 3, 0x5f: 4,
    0x22: 3, 0x27: 2, 0x28: 1.5, 0x29: 1.5, 0x5b: 1, 0x5d: 1, 0x7b: 1, 0x7d: 1,
    0x3c: 1, 0x3e: 1, 0x21: 0.5, 0x3f: 0.5, 0x40: 0.4, 0x23: 0.4, 0x24: 0.3,
    0x25: 1, 0x26: 0.5, 0x2a: 0.5, 0x2b: 0.5, 0x7c: 0.5, 0x5c: 0.5,
    0x7e: 0.2, 0x5e: 0.2, 0x60: 0.2,
  };
  for (const k of Object.keys(punct)) f[Number(k)] = punct[k];
  return f;
})();

/** 大小写不敏感的原生字节匹配：返回 chunk 内命中偏移（升序），最多收集 cap 个。
 *  needle 中的字母字节同时接受两种大小写（历史教训：小写+大写两个 needle 各扫一遍的方案
 *  漏配内容里的一切混合形态，如查询 readme 漏 Readme/ReAdMe），非字母字节精确匹配。
 *  锚点 = needle 中最低频的字节（BYTE_FREQ，v0.9.0 起含空格/数字/标点的真实频率）：
 *  字母则小写/大写两个变体各持一个游标，单调前进、整块只扫一遍，每次取更近候选
 *  （逐候选各扫一遍会在锚点变体稀疏时退化成 O(n²)），候选位置逐字节折叠校验
 *  （isLetterPos 预标记，无函数调用）；
 *  needle 全为非字母时退化为精确匹配；长度 1 时锚点即命中。
 *  cap 的意义：只需全局前 maxResults 条结果，密集查询（如单空格）若全量收集会吃满内存与排序时间。
 *  ASCII 查询在 UTF-8 与 GBK 下字节表示一致，故两种编码共用同一快路径。 */
function nativeMatchesCI(chunk, needle, cap) {
  const out = [];
  const len = needle.length;
  // 预计算：字母位置标记（折叠校验用）+ 锚点位置（最低频字节）
  const isLetterPos = new Uint8Array(len);
  let anchor = 0;
  let best = Infinity;
  for (let j = 0; j < len; j++) {
    const n = needle[j];
    if (isAsciiLetter(n)) isLetterPos[j] = 1;
    const f = BYTE_FREQ[n] != null ? BYTE_FREQ[n] : 1;
    if (f < best) { best = f; anchor = j; }
  }
  const n0 = needle[anchor];
  const letter0 = isLetterPos[anchor] === 1;
  const a0 = letter0 ? n0 | 0x20 : n0;          // 锚点小写形态
  const a1 = letter0 ? (n0 | 0x20) ^ 0x20 : n0; // 锚点大写形态（锚点非字母时不启用）
  // 候选锚点位置 p 的合法区间：匹配起点 p-anchor ≥ 0 且 needle 完整落在 chunk 内
  // （块尾不完整候选由调用方的 tail 拼接负责）
  const pMax = chunk.length - len + anchor;
  let i0 = chunk.indexOf(a0, anchor);
  let i1 = letter0 ? chunk.indexOf(a1, anchor) : -1;
  let taken = 0;
  for (;;) {
    const p = i0 < 0 ? i1 : (i1 < 0 ? i0 : Math.min(i0, i1));
    if (p < 0 || p > pMax) break;
    // 推进被消费一侧的游标（a0 ≠ a1，同一位置不可能同时命中两侧；步进 1 = 允许重叠命中）
    if (p === i0) i0 = chunk.indexOf(a0, p + 1);
    if (letter0 && p === i1) i1 = chunk.indexOf(a1, p + 1);
    const s = p - anchor;
    let ok = true;
    for (let j = 0; j < len; j++) {
      const c = chunk[s + j];
      const n = needle[j];
      if (c === n) continue;
      if (!isLetterPos[j] || (c ^ 0x20) !== n) { ok = false; break; } // 字母接受另一种大小写
    }
    if (ok) {
      out.push(s);
      taken++;
      if (taken >= cap) break;
    }
  }
  return out;
}

/** 编码探测：以「块内最后一个换行」为界做严格 UTF-8 校验（多字节字符不会跨换行，天然安全）。
 *  旧写法固定截掉尾部 4 字节：若截点正好落在文件末尾/块边界的多字节字符中间，会把 UTF-8 误判成
 *  GBK（实测：中文 + CRLF + 末尾无换行的文件整份搜索 0 命中）。无换行时回退「截 4 字节」老策略。 */
function probeEncoding(buf) {
  const nl = buf.lastIndexOf(10);
  const end = nl > 0 ? nl : Math.max(0, buf.length - 4);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end));
    return 'utf-8';
  } catch {
    return 'gbk'; // Windows 环境大文件中文编码次选
  }
}

/** 大文件流式扫描（>10MB，v0.4.0 快路径）：原生 Buffer.indexOf 直接匹配原始字节。
 *  - 快路径（查询串为纯 ASCII）：8MB 块上大小写不敏感字节匹配（nativeMatchesCI），
 *    行号由块内换行位置二分得到，兼容 UTF-8 / GBK（ASCII 字节两者一致）。
 *  - 回退路径（含非 ASCII，如中文关键词）：仍走增量解码 + 逐行匹配（语义与 v0.2.1 一致）。
 *  返回是否达到 maxResults。 */
async function scanStream(file, rawQuery, q, results, maxResults, isCancelled) {
  const rq = String(rawQuery || '');
  const needle = ASCII_ONLY.test(rq) ? Buffer.from(rq, 'latin1') : null;
  // 回退路径是否需要每行大小写折叠：q 已小写；若 q 不含「有大小写映射」的字符（纯中文/数字/符号），
  // toUpperCase 不变 → 折叠不影响匹配，可直接 indexOf（省掉每行 toLowerCase 的整串分配）。
  const needFold = q !== q.toUpperCase();

  let enc = null;
  let dec = null;
  let lineDec = null;     // 快路径命中行解码复用（非 stream 模式无状态；stream 解码器 dec 不可复用）
  let strBuf = '';        // 回退路径：解码后的字符串缓冲
  let ln = 0;             // 已消费的完整行数（全局）
  let check = 0;
  const CHUNK = 8 * 1024 * 1024;
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK });
  let tail = Buffer.alloc(0); // 跨块命中：保留上一块尾部 needle.length-1 字节
  const maxNeedle = needle ? needle.length : 0;
  try {
    for await (const chunk of stream) {
      if (isCancelled()) return true; // 块级取消：无换行巨文件（回退路径不进行循环）也能随时退出
      if (!enc) {
        // 首块探测：以最后一个换行为界（见 probeEncoding 注释）
        enc = probeEncoding(chunk);
        dec = new TextDecoder(enc, { stream: true });
        lineDec = new TextDecoder(enc);
      }

      if (needle) {
        // ---------- 快路径：字节匹配（大小写不敏感） ----------
        const stitched = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        const newStart = tail.length; // 去重口径：整体落在 tail 内的命中上一块已报告（跨块命中见下方过滤）
        const hits = nativeMatchesCI(stitched, needle, Math.max(1, maxResults - results.length));
        if (hits.length) {
          // 块内换行位置（仅本块新增部分参与行号累加，tail 的换行已在上一块计入 ln）
          const nlPos = [];
          let p = stitched.indexOf(0x0a, newStart);
          while (p >= 0) { nlPos.push(p); p = stitched.indexOf(0x0a, p + 1); }
          for (const hit of hits) {
            if (hit + needle.length <= newStart) continue; // 整体落在 tail 内：上一块已报告；起点在 tail 但越过块尾的跨块命中上一块看不到，必须在本块报告
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
            try { text = lineDec.decode(rawLine); } catch { text = rawLine.toString('latin1'); }
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
      // v0.9.1 提速：① 逐行 `slice` 改成一次 `split('\n')`（旧写法每行把剩余串整体切片，
      // 长行文件上产生大量中间字符串）；② 查询串不含**有大小写映射**的字符时（纯中文/数字/符号）
      // 跳过每行 toLowerCase —— `line.toLowerCase().indexOf(q)` 在 q 无大小写时等价于 `line.indexOf(q)`。
      const segs = strBuf.split('\n');
      strBuf = segs.pop() || ''; // 末段可能是不完整行，留到下一块
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        const line = seg.endsWith('\r') ? seg.slice(0, -1) : seg;
        ln++;
        if (++check >= 50000) {
          check = 0;
          if (isCancelled()) return true;
        }
        const hit = (needFold ? line.toLowerCase() : line).indexOf(q);
        if (hit >= 0) {
          results.push({ file, line: ln, text: line.length > 1000 ? line.slice(0, 1000) : line, matchIndex: hit });
          if (results.length >= maxResults) return true;
        }
      }
      // 无换行巨文件：strBuf 无界增长会撞 V8 字符串上限。超阈值时把头部按「截断行」照常
      // 匹配一次后丢弃，只保留尾部继续拼接（多带 q.length-1 字符：跨切点的命中完整可见，
      // 起点落在切点之后的留给保留段，避免重复报告）
      if (strBuf.length > FALLBACK_BUF_MAX) {
        const cut = strBuf.length - FALLBACK_BUF_KEEP;
        const head = strBuf.slice(0, cut + q.length - 1);
        strBuf = strBuf.slice(cut);
        const hit = (needFold ? head.toLowerCase() : head).indexOf(q);
        if (hit >= 0 && hit < cut) {
          const text = head.length > 1000 ? head.slice(0, 1000) : head;
          const mi = (needFold ? text.toLowerCase() : text).indexOf(q);
          results.push({ file, line: ln + 1, text, matchIndex: mi < 0 ? 0 : mi });
          if (results.length >= maxResults) return true;
        }
      }
    }
    if (strBuf.length) {
      ln++;
      const hit = (needFold ? strBuf.toLowerCase() : strBuf).indexOf(q);
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

// ===================== v0.9.0：GB 级单文件多线程分片扫描 =====================
// 背景：5GB 文件单线程字节扫描实测 20s（锚点选错时）；锚点修正后仍受「候选数 × 单核」限制。
// 做法：按字节把文件切成 N 段（N = 核数-1，上限 8），每段一个 worker_threads 线程跑同一套
//       nativeMatchesCI；行号由「各分片换行数前缀和 + 片内偏移」还原（不依赖行索引）。
// 语义与串行 fast path 完全一致：ASCII 大小写不敏感、行首行尾剪裁、matchIndex 小写口径、
//       跨块/跨片命中用 needle.length-1 字节重叠兜住、结果上限 maxResults。
// 任何分片异常 → 自动回退串行 scanStream（正确性优先，功能不受影响）。
const SHARD_SRC = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    cached = [
      'const { parentPort, workerData } = require("worker_threads");',
      'const fs = require("fs");',
      'const BYTE_FREQ = new Float32Array(' + JSON.stringify(Array.from(BYTE_FREQ)) + ');',
      'function isAsciiLetter(b) { return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a); }',
      nativeMatchesCI.toString(),
      shardMain.toString(),
      'shardMain();',
    ].join('\n');
    return cached;
  };
})();

/** 单个分片的扫描主体（自包含：不能被闭包捕获任何东西，会被 toString 注入 worker）。
 *  **不做「对齐到行首」**：分片从 start 原样读起，行号一律用「[start, hit) 之间的换行数」，
 *  再加协调方的换行前缀和 → 与串行结果逐条一致（实测教训：早期版本跳过 start 处的半行，
 *  既漏掉正好落在片首的命中，又漏计那条换行，导致后续分片行号整体漂移）。
 *  **零分配读循环**（v0.9.0 实测关键）：早期版本每块 `Buffer.allocUnsafe(8MB)` + `Buffer.concat`，
 *  在 Electron 的 worker_threads 里 640MB/片能吃掉 2.5s+（node 24 同样代码只要 0.6s）——
 *  改成「一片一个复用缓冲 + 尾部 needle-1 字节搬移」，分配次数从 80 次降到 1 次。 */
function shardMain() {
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs');
  const wd = workerData;
  const needle = Buffer.from(wd.needle);
  const len = needle.length;
  const CHUNK = 8 * 1024 * 1024;
  const overlap = Math.max(0, len - 1); // 块尾/片尾重叠字节（跨块命中兜底）
  const { file, size, start, end } = wd;
  const scanEnd = Math.min(size, end + overlap); // 片尾多读 needle-1 字节，跨片命中不漏
  const hits = [];
  let nlScanned = 0;      // 本片已扫描字节里的换行总数（[start, 已扫位置)）
  let lastOff = -1;
  let pos = start;
  let tailLen = 0;
  let dec = null;
  let fd = null;
  const t0 = Date.now();
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK + overlap); // 唯一一次分配（整个分片复用）
    while (pos < scanEnd && hits.length < wd.cap) {
      const want = Math.min(CHUNK, scanEnd - pos);
      const got = fs.readSync(fd, buf, tailLen, want, pos);
      if (!got) break;
      const viewLen = tailLen + got;
      const view = buf.subarray(0, viewLen);
      const viewStart = pos - tailLen; // view[0] 的绝对偏移
      if (!dec) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(view.subarray(0, Math.max(0, Math.min(viewLen, 1 << 20) - 4)));
          dec = new TextDecoder('utf-8');
        } catch { dec = new TextDecoder('gbk'); }
      }
      const found = needle.length ? nativeMatchesCI(view, needle, wd.cap) : [];
      for (let i = 0; i < found.length; i++) {
        const h = found[i];
        const abs = viewStart + h;
        // 去重口径：**整体**落在上一块（含重叠区）里的命中上一块已报告；起点在重叠区、尾部越过
        // 块尾的跨块命中上一块看不到（needle 不完整），必须在本块报告。
        if (abs + len <= pos) continue;
        if (abs < start || abs >= end) continue; // 归属别的分片
        if (abs <= lastOff) continue;   // 去重（命中升序）
        lastOff = abs;
        // 片内行号 = 已扫换行数 + 本块内该命中之前的换行数
        let nlBefore = nlScanned;
        for (let p = view.indexOf(10, tailLen); p >= 0 && p < h; p = view.indexOf(10, p + 1)) nlBefore++;
        let ls = view.lastIndexOf(10, h - 1);
        ls = ls < 0 ? 0 : ls + 1;
        let le = view.indexOf(10, h);
        if (le < 0) le = viewLen;
        let text;
        try { text = dec.decode(view.subarray(ls, le)); } catch { text = view.subarray(ls, le).toString('latin1'); }
        text = text.replace(/\r$/, '');
        const mi = text.toLowerCase().indexOf(wd.q);
        hits.push({ o: abs, line0: nlBefore, text: text.length > 1000 ? text.slice(0, 1000) : text, matchIndex: mi < 0 ? 0 : mi });
        if (hits.length >= wd.cap) break;
      }
      // 换行统计：只统计归属本片的 [pos, min(pos+got, end))，重叠区不计（下一片自己数）
      const ownLen = Math.max(0, Math.min(got, end - pos));
      for (let p = view.indexOf(10, tailLen); p >= 0 && p < tailLen + ownLen; p = view.indexOf(10, p + 1)) nlScanned++;
      // 尾部 needle-1 字节搬回缓冲开头，供下一块跨块匹配
      tailLen = Math.max(0, Math.min(overlap, viewLen));
      if (tailLen > 0) buf.copy(buf, 0, viewLen - tailLen, viewLen);
      pos += got;
    }
    parentPort.postMessage({ ok: true, hits, nl: nlScanned, start, ms: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

/** 分片并行扫描。返回 { ok:true, full } 或 { ok:false, reason }（ok:false 时调用方回退串行） */
async function scanStreamParallel(file, rawQuery, q, results, maxResults, isCancelled) {
  const st = await fsp.stat(file);
  const size = st.size;
  const cap = Math.max(1, maxResults - results.length);
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  // MH_SEARCH_SHARDS：调试/低配机可强制分片数（不设则按核数-1，上限 8）
  const want = parseInt(process.env.MH_SEARCH_SHARDS, 10);
  const n = Number.isFinite(want) && want > 0
    ? Math.min(want, SHARD_MAX)
    : Math.max(2, Math.min(SHARD_MAX, Math.max(2, cores - 1)));
  const per = Math.ceil(size / n);
  const ranges = [];
  for (let i = 0; i < n; i++) {
    const s = i * per;
    const e = Math.min(size, s + per);
    if (s < e) ranges.push({ start: s, end: e });
  }
  const needle = Array.from(Buffer.from(String(rawQuery), 'latin1'));
  const workers = [];
  let cancelledNow = false;
  const runShard = (payload) => new Promise((resolve) => {
    let w = null;
    try {
      w = new Worker(SHARD_SRC(), { eval: true, workerData: payload });
    } catch (e) {
      resolve({ ok: false, error: 'worker 启动失败：' + ((e && e.message) || e) });
      return;
    }
    workers.push(w);
    let settled = false;
    const fin = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      try { w.terminate(); } catch { /* 已退出 */ }
    };
    w.once('message', (m) => fin(m && typeof m === 'object' ? m : { ok: false, error: '分片无响应' }));
    w.once('error', (e) => fin({ ok: false, error: String((e && e.message) || e) }));
    w.once('exit', (c) => fin({ ok: false, error: '分片线程退出码 ' + c }));
  });
  const timer = setInterval(() => {
    if (!isCancelled()) return;
    cancelledNow = true;
    for (const w of workers) { try { w.terminate(); } catch { /* 忽略 */ } }
  }, 100);
  try {
    const parts = await Promise.all(ranges.map((r) => runShard({
      file, size, start: r.start, end: r.end, needle, q, cap,
    })));
    if (process.env.MH_SEARCH_DEBUG) {
      console.error('[search] 分片总耗时(ms)=', parts.map((p) => (p && p.ms) || -1).join(','));
    }
    if (cancelledNow || isCancelled()) return { ok: false, reason: 'cancelled' };
    for (const p of parts) {
      if (!p || p.ok !== true) return { ok: false, reason: (p && p.error) || '分片失败' };
    }
    // 分片顺序 = ranges 顺序（起始偏移升序）：换行数前缀和还原每片首行号
    let base = 1;
    const all = [];
    for (const p of parts) {
      for (const h of p.hits) all.push({ o: h.o, line: base + h.line0, text: h.text, matchIndex: h.matchIndex });
      base += p.nl;
    }
    all.sort((a, b) => a.o - b.o);
    for (const h of all) {
      results.push({ file, line: h.line, text: h.text, matchIndex: h.matchIndex });
      if (results.length >= maxResults) return { ok: true, full: true };
    }
    return { ok: true, full: false };
  } finally {
    clearInterval(timer);
    for (const w of workers) { try { w.terminate(); } catch { /* 忽略 */ } }
  }
}

// ===================== v0.9.1：非 ASCII（中文）查询同样多线程分片 =====================
// 与上面的字节分片不同：这里按**行边界**切片（每片起点/终点都用「start 之后第一个换行」对齐），
// 因此不存在跨片命中/跨片行号歧义，也不需要 needle-1 重叠；代价是每片先做一次 ≤64KB 的对齐探测。
// 编码统一由协调方读文件头探测（与串行回退同口径：严格 UTF-8 → GBK），避免各片各自猜出不同编码。
// 语义与串行回退一致：**每行最多一条命中**（首个出现位置），行文本截断 1000 字符，行号 1 基。
function shardDecodeMain() {
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs');
  const wd = workerData; // { file, size, start, end, q, fold, cap, enc }
  const CHUNK = 8 * 1024 * 1024;
  const ALIGN = 64 * 1024;
  const MAX_LINE_BUF = 64 * 1024 * 1024; // 单行超长保护（保护阈值 + 保留尾部续拼，与串行回退同思路）
  const KEEP = 1024 * 1024;
  const t0 = Date.now();
  const probe = Buffer.allocUnsafe(ALIGN);
  let fd = null;
  /** 返回 pos 之后第一个换行符的下一个字节（行首）；pos<=0 → 0；找不到 → size */
  const alignFrom = (pos) => {
    if (pos <= 0) return 0;
    let p = pos;
    while (p < wd.size) {
      const got = fs.readSync(fd, probe, 0, probe.length, p);
      if (!got) return wd.size;
      const i = probe.subarray(0, got).indexOf(10);
      if (i >= 0) return p + i + 1;
      p += got;
    }
    return wd.size;
  };
  try {
    fd = fs.openSync(wd.file, 'r');
    const A = alignFrom(wd.start);
    const B = wd.end >= wd.size ? wd.size : alignFrom(wd.end);
    const hits = [];
    let nl = 0;
    if (A < B) {
      const dec = new TextDecoder(wd.enc, { stream: true });
      const buf = Buffer.allocUnsafe(CHUNK);
      let carry = '';
      let pos = A;
      while (pos < B && hits.length < wd.cap) {
        const want = Math.min(CHUNK, B - pos);
        const got = fs.readSync(fd, buf, 0, want, pos);
        if (!got) break;
        pos += got;
        carry += dec.decode(buf.subarray(0, got), { stream: true });
        const segs = carry.split('\n');
        carry = segs.pop() || '';
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          const line = seg.endsWith('\r') ? seg.slice(0, -1) : seg;
          nl++;
          const hit = (wd.fold ? line.toLowerCase() : line).indexOf(wd.q);
          if (hit >= 0) {
            hits.push({ line0: nl - 1, text: line.length > 1000 ? line.slice(0, 1000) : line, matchIndex: hit });
            if (hits.length >= wd.cap) break;
          }
        }
        // 无换行超长行：与串行回退同口径，把头部当「截断行」报一次（行号不前进），只保留尾部续拼
        if (carry.length > MAX_LINE_BUF) {
          const cut = carry.length - KEEP;
          const head = carry.slice(0, cut + wd.q.length - 1);
          carry = carry.slice(cut);
          const hit = (wd.fold ? head.toLowerCase() : head).indexOf(wd.q);
          if (hit >= 0) {
            hits.push({ line0: nl, text: head.length > 1000 ? head.slice(0, 1000) : head, matchIndex: hit });
            if (hits.length >= wd.cap) break;
          }
        }
      }
      carry += dec.decode(); // 冲掉流式解码器里可能残留的多字节
      if (carry.length) {    // 仅最后一片走到这里（无换行结尾的尾行）
        nl++;
        const hit = (wd.fold ? carry.toLowerCase() : carry).indexOf(wd.q);
        if (hit >= 0) hits.push({ line0: nl - 1, text: carry.length > 1000 ? carry.slice(0, 1000) : carry, matchIndex: hit });
      }
    }
    parentPort.postMessage({ ok: true, hits, nl, start: wd.start, a: A, b: B, ms: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  } finally {
    try { if (fd != null) fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

const SHARD_DECODE_SRC = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    cached = [
      'const { parentPort, workerData } = require("worker_threads");',
      'const fs = require("fs");',
      shardDecodeMain.toString(),
      'shardDecodeMain();',
    ].join('\n');
    return cached;
  };
})();

/** 非 ASCII 查询的分片扫描。返回 { ok:true, full } 或 { ok:false, reason } */
async function scanStreamParallelDecoded(file, rawQuery, q, results, maxResults, isCancelled) {
  const st = await fsp.stat(file);
  const size = st.size;
  const cap = Math.max(1, maxResults - results.length);
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const want = parseInt(process.env.MH_SEARCH_SHARDS, 10);
  const n = Number.isFinite(want) && want > 0 ? Math.min(want, SHARD_MAX) : Math.max(2, Math.min(SHARD_MAX, Math.max(2, cores - 1)));
  // 统一编码探测（与串行回退同口径：取文件头 8MB，以最后一个换行为界做严格 UTF-8 校验）
  let enc = 'utf-8';
  try {
    const fh = await fsp.open(file, 'r');
    let head;
    try {
      head = Buffer.allocUnsafe(Math.min(size, 8 * 1024 * 1024));
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      head = head.subarray(0, bytesRead);
    } finally { await fh.close(); }
    enc = probeEncoding(head);
  } catch { /* 读不到头就按 utf-8 试 */ }
  const fold = q !== q.toUpperCase();
  const per = Math.ceil(size / n);
  const ranges = [];
  for (let i = 0; i < n; i++) {
    const s = i * per;
    const e = Math.min(size, s + per);
    if (s < e) ranges.push({ start: s, end: e });
  }
  const workers = [];
  let cancelledNow = false;
  const runShard = (payload) => new Promise((resolve) => {
    let w = null;
    try { w = new Worker(SHARD_DECODE_SRC(), { eval: true, workerData: payload }); }
    catch (e) { resolve({ ok: false, error: 'worker 启动失败：' + ((e && e.message) || e) }); return; }
    workers.push(w);
    let settled = false;
    const fin = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      try { w.terminate(); } catch { /* 已退出 */ }
    };
    w.once('message', (m) => fin(m && typeof m === 'object' ? m : { ok: false, error: '分片无响应' }));
    w.once('error', (e) => fin({ ok: false, error: String((e && e.message) || e) }));
    w.once('exit', (c) => fin({ ok: false, error: '分片线程退出码 ' + c }));
  });
  const timer = setInterval(() => {
    if (!isCancelled()) return;
    cancelledNow = true;
    for (const w of workers) { try { w.terminate(); } catch { /* 忽略 */ } }
  }, 100);
  try {
    const parts = await Promise.all(ranges.map((r) => runShard({
      file, size, start: r.start, end: r.end, q, fold, cap, enc,
    })));
    if (process.env.MH_SEARCH_DEBUG) {
      console.error('[search] 解码分片耗时(ms)=', parts.map((p) => (p && p.ms) || -1).join(','), 'enc=' + enc);
    }
    if (cancelledNow || isCancelled()) return { ok: false, reason: 'cancelled' };
    for (const p of parts) {
      if (!p || p.ok !== true) return { ok: false, reason: (p && p.error) || '分片失败' };
    }
    // 分片区间按行边界首尾相接：行数前缀和直接还原全局行号（无需按偏移排序）
    let base = 1;
    for (const p of parts) {
      for (const h of p.hits) {
        results.push({ file, line: base + h.line0, text: h.text, matchIndex: h.matchIndex });
        if (results.length >= maxResults) return { ok: true, full: true };
      }
      base += p.nl;
    }
    return { ok: true, full: false };
  } finally {
    clearInterval(timer);
    for (const w of workers) { try { w.terminate(); } catch { /* 忽略 */ } }
  }
}

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
/** 扫描单个文本文件（目录搜索与「大文件视图内查找」共用同一条路径，保证两者命中口径一致）。
 *  返回 { skip }（不可扫/空/超限）、{ cancelled }、{ full }（达到 maxResults）、{ ok }。 */
async function scanFileInto(file, query, q, results, maxResults, isCancelled) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { skip: true };
  }
  if (st.size === 0) return { skip: true };
  if (st.size > MAX_SEARCH_FILE_MB * 1024 * 1024) {
    // 1B-4：大文件走流式扫描（v0.9.0 上限 20GB），不再整体跳过
    if (st.size > MAX_STREAM_FILE_MB * 1024 * 1024) return { skip: true };
    // v0.9.0：GB 级查询优先多线程分片（5GB 单线程 20s → 多核 ~1s 量级）。
    // v0.9.1：非 ASCII（中文关键词）也走分片 —— 按行边界切片 + 解码后逐行匹配，语义与串行回退一致。
    // 分片任何异常都自动回退串行扫描。
    if (st.size > SHARD_MIN_BYTES) {
      const pr = ASCII_ONLY.test(String(query))
        ? await scanStreamParallel(file, query, q, results, maxResults, isCancelled)
        : await scanStreamParallelDecoded(file, query, q, results, maxResults, isCancelled);
      if (isCancelled()) return { cancelled: true };
      if (pr.ok) return pr.full ? { full: true } : { ok: true };
      if (pr.reason === 'cancelled') return { cancelled: true };
      // 分片失败：回退串行扫描（功能不受影响，只是慢）
      if (process.env.MH_SEARCH_DEBUG) console.error('[search] 分片回退串行:', pr.reason || 'unknown');
    }
    const full = await scanStream(file, query, q, results, maxResults, isCancelled);
    if (isCancelled()) return { cancelled: true };
    return full ? { full: true } : { ok: true };
  }
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch {
    return { skip: true };
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].toLowerCase().indexOf(q);
    if (idx >= 0) {
      results.push({ file, line: i + 1, text: lines[i], matchIndex: idx });
      if (results.length >= maxResults) return { full: true }; // 截断（与原逻辑一致）
    }
  }
  return { ok: true };
}

/** 单文件查找（「大文件视图内 Ctrl+F」的 IPC 后端；与目录搜索共用 scanFileInto，口径一致） */
async function runFileSearch(id, file, query, maxResults) {
  const q = String(query).toLowerCase();
  const isCancelled = () => cancelled || currentId !== id;
  const results = [];
  const r = await scanFileInto(file, query, q, results, maxResults, isCancelled);
  if (r.cancelled) return { cancelled: true };
  return { results };
}

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
    const r = await scanFileInto(file, query, q, results, maxResults, isCancelled);
    if (r.cancelled) return { cancelled: true };
    if (r.full) return { results };
  }
  return { results };
}

// 只有作为 utilityProcess 运行（process.parentPort 存在）时才注册消息口；
// 纯 node 里 require 本文件可用于探针直测（scripts/search-shard-probe.js）。
if (process.parentPort && typeof process.parentPort.on === 'function') {
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
  } else if (msg.type === 'search-file') {
    // v0.10.0：大文件视图内查找（单文件；与目录搜索共用 scanFileInto）
    currentId = msg.id;
    cancelled = false;
    const { id, file, query } = msg;
    const maxResults = Number.isFinite(msg.maxResults) ? msg.maxResults : 500;
    if (!file || !query) {
      process.parentPort.postMessage({ id, type: 'done', results: [] });
      return;
    }
    runFileSearch(id, file, query, maxResults)
      .then((r) => {
        if (r.cancelled) process.parentPort.postMessage({ id, type: 'cancelled' });
        else process.parentPort.postMessage({ id, type: 'done', results: r.results });
      })
      .catch((err) => {
        process.parentPort.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
      });
  } else if (msg.type === 'cancel') {
    if (msg.id === currentId) cancelled = true;
  }
  });
}

// 供纯 node 探针直测（scripts/search-shard-probe.js）；utilityProcess 运行时同样导出但不被使用。
module.exports = {
  scanStream,
  scanStreamParallel,
  scanStreamParallelDecoded,
  runFileSearch,
  nativeMatchesCI,
  runSearch,
  MAX_STREAM_FILE_MB,
  SHARD_MIN_BYTES,
};
