// 大文件行索引（Phase A，v0.4.0）：稀疏行首偏移表 + 磁盘缓存 + 进程内缓存 + 进度事件
//
// 目的：让 GB 级文件也能「任意位置 O(1) 定位」—— 虚拟滚动查看器要按行号直接 seek，
// 搜索命中要行号 ↔ 字节偏移互转；现状靠 fs:find-line-offset 每次全量重扫（O(文件大小)）。
//
// 设计要点：
//  - 稀疏：每 SPARSE 行记一次行首字节偏移（默认 1000）→ 4000 万行也只存 4 万条（约几百 KB）
//  - 原生扫描：Buffer.indexOf(0x0A) 走原生实现，比 JS 逐字符快一个数量级
//  - 缓存：userData/lineidx/<sha1(path|size|mtime)>.idx（JSON），文件被外部修改自动失效
//  - v0.4.0 进程内缓存：侧车只读一次 —— line-offset / offset-line / lines 全部复用同一份索引。
//    此前每次 IPC 都 stat + readFileSync + JSON.parse 整个侧车（4000 万行 ≈ 4 万条 starts），
//    逐行取数的场景被侧车解析淹没（实测一屏 170~215ms）。key 内含 size|mtime，文件一变即换 key；
//    取出时再核对一次 size/mtimeMs 兜底，force 则强制重扫并覆盖内存与磁盘两份缓存。
//  - 批量取数：huge:lines 一次定位起始偏移 + 一次读盘返回整个视口（见 readLines），
//    取代渲染端「每行一次 IPC」的串行往返；单次读取上限 4MB（沿用 fs:read-file-range 的限流风格）。
//  - 进度：每 ~64MB 向请求窗口发一次 huge:index-progress（首次建索引可提示"索引建立中 xx%"）
//  - 编码：仅用首块做严格 UTF-8 → GBK 探测（与 ipc.js detectEncoding 同口径），不影响偏移计算
//  - 二进制：顺带检测首 8MB 是否含 0x00，结果落侧车 + huge:index 返回值（binary），
//    渲染端据此提示"二进制内容：按文本近似显示"（稀疏文件/可执行文件不必先解码才知道）
//  - GC：huge:index 成功后异步回收侧车目录（mtime > 30 天 或 数量 > 200 的最旧条目）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, ipcMain, BrowserWindow } = require('electron');
// 复用 fs:read-file-range 的区间读取实现（单次限流 + 成功读取即 approve，避免第二套读盘口径）
const { readRangeBytes } = require('./ipc');

const SPARSE = 1000;                    // 稀疏度：每 N 行记录一次行首偏移
const READ_CHUNK = 8 * 1024 * 1024;     // 扫描读块（8MB）
const PROGRESS_EVERY = 64 * 1024 * 1024; // 进度上报间隔
const BINARY_PROBE_BYTES = 8 * 1024 * 1024; // 二进制（NUL）检测只做首 8MB
// v2：侧车新增 binary 字段。旧侧车（v1）无此字段 → 版本号变化使缓存 key 与 readCache 校验同时失效并重建。
const CACHE_VERSION = 2;
const NL = 0x0a;

// 批量取数（huge:lines）
const BATCH_MAX_LINES = 1000;           // 单次请求行数上限（视口含 overscan 一般 < 300 行）
const BATCH_MAX_BYTES = 4 * 1024 * 1024; // 单次读取字节上限（沿用 64MB 限流风格，按视口需求收紧到 4MB）
const BATCH_MIN_BYTES = 64 * 1024;      // 单次读取字节下限（避免超短行文件反复扩窗）
const LINE_MAX_CHARS = 40000;           // 单行文本截断（与渲染端现有截断一致）

// 进程内索引缓存（避免每次 IPC 都解析侧车）
const memIndex = new Map();             // cacheKey -> { file, size, mtimeMs, index, at }
const MEM_MAX = 4;                      // 同时驻留的索引份数（每份仅存稀疏表，几百 KB 量级）

// 侧车 GC
const GC_MAX_FILES = 200;               // 保留的最大侧车数量
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天未访问即回收
const GC_MIN_INTERVAL_MS = 5 * 60 * 1000;       // 同一进程内最多 5 分钟扫一次目录
let gcLastAt = 0;
let gcRunning = false;

const indexDir = () => path.join(app.getPath('userData'), 'lineidx');

function cacheKey(st, file) {
  return crypto.createHash('sha1')
    .update(`${path.resolve(file)}|${st.size}|${Math.floor(st.mtimeMs)}|${CACHE_VERSION}`)
    .digest('hex');
}

/** 路径判等（Windows 大小写不敏感；仅用于内存缓存失效，不必跟随符号链接） */
function samePath(a, b) {
  const x = path.resolve(String(a || ''));
  const y = path.resolve(String(b || ''));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---------- 进程内缓存 ----------
/** 取内存索引：key 已含 size|mtime，这里再核对一次（防 hash/时钟精度异常导致口径不符） */
function memGet(key, st) {
  const e = memIndex.get(key);
  if (!e) return null;
  if (e.size !== st.size || e.mtimeMs !== st.mtimeMs) {
    memIndex.delete(key); // 文件已变：立即失效
    return null;
  }
  memIndex.delete(key); // LRU：命中后置尾
  memIndex.set(key, e);
  return e.index;
}

function memPut(key, index, st, file) {
  memIndex.delete(key);
  memIndex.set(key, { file, size: st.size, mtimeMs: st.mtimeMs, index, at: Date.now() });
  while (memIndex.size > MEM_MAX) memIndex.delete(memIndex.keys().next().value);
}

/** 按 key 失效（huge:index-drop / force 重建用） */
function memDropKey(key) {
  memIndex.delete(key);
}

/** 按文件路径失效（文件已删除、算不出 key 时兜底） */
function memDropFile(file) {
  for (const [k, e] of [...memIndex]) {
    if (samePath(e.file, file)) memIndex.delete(k);
  }
}

function memStats() {
  return { entries: memIndex.size, keys: [...memIndex.keys()] };
}

function detectEncoding(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'gbk';
  }
}

/** 按索引记录的编码解码（失败回退 utf-8） */
function decodeBuffer(buf, encoding) {
  try {
    return new TextDecoder(encoding || 'utf-8').decode(buf);
  } catch {
    try { return new TextDecoder('utf-8').decode(buf); } catch { return buf.toString('latin1'); }
  }
}

/** 流式扫描：返回 { lines, longest, starts:number[], encoding, binary, elapsedMs }
 *  onPartial(starts, lines, bytesScanned, encoding, binary)：每读完一个块回调一次（v0.9.0 渐进索引）。
 *  调用方拿到的 starts 是**同一份数组引用**（只读使用）：扫描进行中就能服务「已扫描前缀」的取行，
 *  让 5GB/10GB 冷开不再「等整份索引才出字」。 */
async function scan(file, size, onProgress, onPartial) {
  const t0 = Date.now();
  const starts = [];
  let lines = 0;
  let longest = 0;
  let lineStart = 0;      // 当前行行首（全局字节偏移）
  let base = 0;           // 当前块起始偏移
  let nextProgress = PROGRESS_EVERY;
  let encoding = null;
  let binary = false;     // 首 BINARY_PROBE_BYTES 内是否出现 0x00（二进制内容标记）
  let probed = 0;
  const rs = fs.createReadStream(file, { highWaterMark: READ_CHUNK });
  try {
    for await (const chunk of rs) {
      if (encoding === null) encoding = detectEncoding(chunk.subarray(0, Math.min(chunk.length, 1 << 20)));
      if (!binary && probed < BINARY_PROBE_BYTES) {
        // 顺带检测 NUL：只覆盖首 8MB（GB 级文件不必为标记多读一遍）
        const probe = chunk.subarray(0, Math.min(chunk.length, BINARY_PROBE_BYTES - probed));
        if (probe.includes(0)) binary = true; // Buffer.includes 走原生实现
        probed += probe.length;
      }
      let from = 0;
      for (;;) {
        const i = chunk.indexOf(NL, from); // 原生扫描换行
        if (i < 0) break;
        lines++;
        if (lines % SPARSE === 0) starts.push(base + i + 1);
        const len = base + i - lineStart;
        if (len > longest) longest = len;
        lineStart = base + i + 1;
        from = i + 1;
      }
      base += chunk.length;
      // 渐进发布（每块一次，纯数值更新，代价可忽略）：readLines 立刻就能按行号读已扫描前缀
      if (onPartial) {
        try { onPartial(starts, lines, base, encoding, binary); } catch { /* 调用方异常不影响扫描 */ }
      }
      if (onProgress && base >= nextProgress) {
        nextProgress = base + PROGRESS_EVERY;
        try { onProgress(base, size); } catch { /* 窗口已销毁等 */ }
      }
    }
  } finally {
    rs.destroy();
  }
  // 末尾无换行的最后一行
  if (lineStart < size) {
    lines++;
    const len = size - lineStart;
    if (len > longest) longest = len;
  }
  return { lines, longest, starts, encoding: encoding || 'utf-8', binary, elapsedMs: Date.now() - t0 };
}

function readCache(cachePath) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (j && j.version === CACHE_VERSION && Array.isArray(j.starts)) return j;
  } catch { /* 未命中/损坏 */ }
  return null;
}

let tmpSeq = 0; // 侧车临时文件自增后缀

function writeCache(cachePath, payload) {
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // 先写临时文件再 rename：避免半截缓存被下次读到；tmp 名带 pid+自增+时间戳，同进程并发写同一 key 不冲突
    tmp = `${cachePath}.tmp${process.pid}.${tmpSeq++}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, cachePath);
    tmp = null; // rename 成功，无需清理
  } catch {
    // 缓存失败不影响功能；rename 失败时清掉残留 tmp 后按原容忍语义吞掉
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ } }
  }
}

/** 获取（或构建）行索引。cached=true 表示命中缓存（内存或磁盘），未重新扫描 */
// v0.8.0 in-flight 合并：同 key 的并发调用共享同一次扫描/侧车读取（4~5GB 冷扫可达数十秒，
// 索引未就绪时 huge:lines / huge:index / line-offset 并发进来，此前每个调用都各自全量重扫一遍）。
const inflightBuilds = new Map(); // key -> Promise（构建中的扫描，含 force 另起的）

// v0.9.0 渐进索引：构建中的「已扫描前缀」表（同 key 单条；供 readLines 在索引就绪前服务视口）。
// 数组引用与扫描内部同一份（只读消费），每块更新一次数值，无需 IPC。
const partialIndexes = new Map(); // key -> { file, size, mtimeMs, lines, starts[], bytes, encoding, binary, done, error }
const PARTIAL_MAX = 8;

/** 向所有窗口广播索引进度（v0.9.0：进度不再绑定「谁发起 huge:index」——
 *  首个视口取数也会起扫描，若进度只发给发起方，先渲染后索引的窗口会一直看不到进度）。 */
function broadcastProgress(file, done, total) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.webContents.send('huge:index-progress', { file, done, total }); } catch { /* 忽略 */ }
  }
}

/** 发起一次真实扫描（调用方已确认缓存未命中）：登记 in-flight，结束后仅摘除自己那一份 */
function startBuild(key, cachePath, file, st, opts) {
  const part = {
    file, size: st.size, mtimeMs: st.mtimeMs,
    lines: 0, starts: [], bytes: 0, encoding: null, binary: false, done: false, error: null,
  };
  partialIndexes.set(key, part);
  while (partialIndexes.size > PARTIAL_MAX) partialIndexes.delete(partialIndexes.keys().next().value);
  const p = (async () => {
    const r = await scan(file, st.size, (done, total) => broadcastProgress(file, done, total), (starts, lines, bytes, enc, bin) => {
      part.lines = lines;
      part.bytes = bytes;
      if (enc) part.encoding = enc;
      if (bin) part.binary = true;
    });
    writeCache(cachePath, {
      version: CACHE_VERSION,
      size: st.size,
      lines: r.lines,
      longest: r.longest,
      starts: r.starts,
      encoding: r.encoding,
      binary: r.binary,
      builtAt: Date.now(),
    });
    const idx = {
      lines: r.lines,
      longest: r.longest,
      starts: r.starts,
      encoding: r.encoding,
      binary: r.binary === true,
      bytes: st.size,
    };
    memPut(key, idx, st, file); // force 重建同样覆盖内存缓存（旧 key 已被新 size/mtime 天然替换）
    // 渐进表收尾：标为完成（其 starts 与 idx.starts 同一份数组，读到也不浪费）
    part.lines = r.lines;
    part.bytes = st.size;
    part.encoding = r.encoding;
    part.binary = r.binary === true;
    part.done = true;
    return { ...idx, cached: false, elapsedMs: r.elapsedMs, key };
  })();
  inflightBuilds.set(key, p);
  const cleanup = () => { if (inflightBuilds.get(key) === p) inflightBuilds.delete(key); };
  p.then(cleanup, (err) => {
    part.error = (err && err.message) || String(err);
    cleanup();
  }); // 不 finally 返回新 promise：保持 p 本身可被多方 await
  return p;
}

/** 非阻塞索引解析（huge:lines / 视口取数专用）：
 *  内存/侧车命中 → 完整索引；正在构建 → 渐进前缀；都没有 → **后台起扫描并立刻返回**。
 *  返回 { index, partial, key, st }（index 与 partial 至少一个非空；两者都可为 null 表示刚起扫描）。 */
async function resolveIndex(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('目标不是文件');
  const key = cacheKey(st, file);
  const cachePath = path.join(indexDir(), key + '.idx');
  const mem = memGet(key, st);
  if (mem) return { index: mem, partial: null, key, st };
  const hit = readCache(cachePath);
  if (hit && hit.size === st.size) {
    const idx = {
      lines: hit.lines,
      longest: hit.longest,
      starts: hit.starts,
      encoding: hit.encoding,
      binary: hit.binary === true,
      bytes: st.size,
    };
    memPut(key, idx, st, file);
    return { index: idx, partial: null, key, st };
  }
  const part = partialIndexes.get(key);
  if (part) return { index: null, partial: part, key, st };
  if (!inflightBuilds.has(key)) {
    // 首次取数就把扫描拉起来（此前要等 huge:index 的 IPC 到达；冷开首屏因此白白晚一步）
    startBuild(key, cachePath, file, st, {}).catch(() => { /* 错误由 partial.error / 后续调用体现 */ });
  }
  return { index: null, partial: partialIndexes.get(key) || null, key, st };
}

async function getIndex(file, opts = {}) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('目标不是文件');
  const key = cacheKey(st, file);
  const cachePath = path.join(indexDir(), key + '.idx');
  if (!opts.force) {
    const mem = memGet(key, st); // 进程内命中：不再读盘、不再 JSON.parse 侧车
    if (mem) return { ...mem, cached: true, elapsedMs: 0, key };
    const hit = readCache(cachePath);
    if (hit && hit.size === st.size) {
      const idx = {
        lines: hit.lines,
        longest: hit.longest,
        starts: hit.starts,
        encoding: hit.encoding,
        binary: hit.binary === true,
        bytes: st.size,
      };
      memPut(key, idx, st, file);
      return { ...idx, cached: true, elapsedMs: 0, key };
    }
    // in-flight 合并：普通调用可搭 force 的车 —— force 的结果就是最新一次全量扫描，
    // 语义上满足普通调用（且在 key 相同 = size|mtime 相同的前提下，两次扫描结果本就一致）。
    const running = inflightBuilds.get(key);
    if (running) return await running;
    return await startBuild(key, cachePath, file, st, opts);
  }
  // force（保存后重建）：**不并入**普通 in-flight —— 它的语义就是「重扫并覆盖缓存」，搭旧车
  // 会拿到它正要淘汰的那份。做法：另起一次扫描并**替换**在途条目，后到的普通调用改搭 force 的车；
  // 已挂在旧构建上的调用仍拿到旧构建结果（同 key ⇒ 同 size|mtime ⇒ 内容等价，无正确性问题）。
  // 后进度的 onProgress 只属于发起方：搭车方收不到进度事件（可接受，结果正确即可）。
  return await startBuild(key, cachePath, file, st, opts);
}

/** 行号（1 基）→ 行首字节偏移：用稀疏表定位后再向前扫最多 SPARSE 个换行 */
async function lineToOffset(file, line, index) {
  const target = Math.max(1, Math.floor(Number(line) || 1));
  const idx = index || (await getIndex(file));
  if (target === 1) return 0;
  if (target > idx.lines) return idx.bytes; // 越界：返回文件末尾
  const bucket = Math.floor((target - 1) / SPARSE);
  let offset = bucket === 0 ? 0 : idx.starts[bucket - 1];
  if (bucket === 0) return await skipNewlines(file, 0, target - 1);
  return await skipNewlines(file, offset, (target - 1) - bucket * SPARSE);
}

/** 读文件指定区间的字节（越界自动截断；内部用，不做 stat/approve 以保热路径轻量） */
async function readRangeAt(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 从 start 起跳过 need 个换行，返回其后字节偏移（分块续读，保证正确性） */
async function skipNewlines(file, start, need) {
  let pos = start;
  let remaining = need;
  while (remaining > 0) {
    const len = Math.min(4 * 1024 * 1024, Math.max(64 * 1024, remaining * 1024));
    const buf = await readRangeAt(file, pos, len);
    if (!buf.length) return pos; // 到文件末尾
    let from = 0;
    for (;;) {
      const i = buf.indexOf(NL, from);
      if (i < 0) break;
      remaining--;
      from = i + 1;
      if (remaining === 0) return pos + i + 1;
    }
    pos += buf.length; // 本块不足：继续读下一块
  }
  return pos;
}

/** 统计 [from, to) 内的换行数（分块，原生 indexOf） */
async function countNewlines(file, from, to) {
  let pos = from;
  let count = 0;
  const MAX = 4 * 1024 * 1024;
  while (pos < to) {
    const len = Math.min(MAX, to - pos);
    const buf = await readRangeAt(file, pos, len);
    if (!buf.length) break;
    let i = buf.indexOf(NL);
    while (i >= 0) {
      count++;
      i = buf.indexOf(NL, i + 1);
    }
    pos += buf.length;
  }
  return count;
}

/** 字节偏移 → 行号（二分稀疏表 + 块内计数）：搜索命中定位用 */
async function offsetToLine(file, offset, index) {
  const idx = index || (await getIndex(file));
  const target = Math.max(0, Math.floor(Number(offset) || 0));
  let lo = 0;
  let hi = idx.starts.length;
  while (lo < hi) { // 找最后一个 starts[i] <= target
    const mid = (lo + hi) >> 1;
    if (idx.starts[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  const bucketLine = lo * SPARSE; // 该稀疏点对应「已跨过 bucketLine 行」
  const from = lo === 0 ? 0 : idx.starts[lo - 1];
  const count = await countNewlines(file, from, target);
  return bucketLine + count + 1;
}

/** 单行成项：超长行截断到 LINE_MAX_CHARS（附完整字符数，渲染端据此提示） */
function makeLineItem(line, text) {
  const s = text == null ? '' : String(text);
  if (s.length > LINE_MAX_CHARS) {
    return { line, text: s.slice(0, LINE_MAX_CHARS), truncated: true, chars: s.length };
  }
  return { line, text: s };
}

/** 批量取行（huge:lines 核心）：一次定位起始偏移 → 顺序读出整个视口 → 解码切行。
 *  语义：行号 1 基；跨块安全（不依赖 8MB 对齐，块边界对调用方不可见）；超长行安全；
 *  读到换行不足（单行超出读窗口 / 文件末尾）时按实际返回，调用方允许缺行显示为空。
 *
 *  v0.9.0 渐进取数（GB 级冷开的关键）：**不再 await 整份索引**——
 *    · 完整索引就绪 → 与旧实现完全一致；
 *    · 索引构建中 → 用「已扫描前缀」当索引，行号精确（前缀已被完整扫过），滚动可跟扫描推进；
 *    · 目标行还没扫到 → 立刻返回 { pending:true, scannedLines, scannedBytes }（调用方画占位/进度）；
 *    · 第 1 行永远可直接从文件头读（首屏零等待，不必等首个 8MB 块扫完）。
 *  返回 { lines:[{line,text,truncated?,chars?}], endLine, start, bytes, eof, encoding,
 *         pending?, scannedLines?, scannedBytes?, totalBytes? } */
async function readLines(file, from, count) {
  const line = Math.max(1, Math.floor(Number(from) || 1));
  const want = Math.max(1, Math.min(BATCH_MAX_LINES, Math.floor(Number(count) || 1)));
  const r = await resolveIndex(file);
  const size = r.st.size;
  let idx = r.index;
  let guessed = false;      // 索引不可用时的「无行号口径」读（只用于首屏第 1 行）
  let headOnly = false;
  if (!idx) {
    const p = r.partial;
    const avail = p ? p.lines : 0;
    if (line > avail) {
      if (line !== 1) {
        // 还没扫到目标行：不阻塞，交还进度让渲染端画占位（扫描中会持续重试）
        return {
          lines: [],
          endLine: line - 1,
          start: 0,
          bytes: 0,
          eof: false,
          encoding: (p && p.encoding) || null,
          pending: true,
          scannedLines: avail,
          scannedBytes: p ? p.bytes : 0,
          totalBytes: size,
          indexError: (p && p.error) || null,
        };
      }
      // 首屏：扫描可能刚起步（甚至 0 行）——直接从文件头按字节读，0 等待
      headOnly = true;
      guessed = true;
      idx = {
        lines: 0,
        starts: [],
        bytes: size,
        encoding: (p && p.encoding) || null,
        binary: !!(p && p.binary),
      };
    } else {
      // 渐进前缀当索引：行号精确（前缀内每个换行都已统计）
      idx = {
        lines: avail,
        starts: p.starts,
        bytes: size,
        encoding: p.encoding || null,
        binary: p.binary === true,
      };
    }
  }
  const done = (lines) => ({
    lines,
    endLine: lines.length ? lines[lines.length - 1].line : line - 1,
    start: 0,
    bytes: 0,
    eof: true,
    encoding: idx.encoding || 'utf-8',
    pending: false,
    scannedLines: idx.lines,
    totalBytes: size,
  });
  if (!idx.lines && !headOnly) return done([]);
  if (idx.lines && line > idx.lines) return done([]);
  // 按「平均行长（含换行）× 行数」估算读窗口：视口 100~300 行 → 通常几十 KB，远小于 4MB 上限
  const avg = guessed
    ? 128 // 无行数口径：按 128B/行估（GB 级日志的典型值；读不够会自动扩窗）
    : Math.max(16, Math.ceil(size / Math.max(1, idx.lines)));
  let len = Math.min(BATCH_MAX_BYTES, Math.max(BATCH_MIN_BYTES, want * avg + 1024));
  for (;;) {
    const rr = await readRangeBytes(file, headOnly ? 0 : await lineToOffset(file, line, idx), len, BATCH_MAX_BYTES);
    const buf = rr.buf;
    if (!buf.length) return done([]);
    // 编码未定时就近探测（首屏直读路径；与 scan 同口径：严格 UTF-8 → GBK）
    if (!idx.encoding) idx.encoding = detectEncoding(buf.subarray(0, Math.min(buf.length, 1 << 20)));
    const eof = rr.end >= size;
    const text = decodeBuffer(buf, idx.encoding);
    const segs = text.split('\n');
    const endsNL = buf[buf.length - 1] === NL;
    // 完整行数：末尾不以换行结束时，未到文件末尾的那一段是「半截行」，不能当整行返回
    const complete = endsNL ? segs.length - 1 : (eof ? segs.length : segs.length - 1);
    // 取够 / 已到文件末尾 / 读窗口已到上限 / 本次读不满（短读）→ 按实际返回
    if (complete >= want || eof || buf.length >= BATCH_MAX_BYTES || rr.end < rr.start + len) {
      const n = Math.min(want, complete);
      const lines = [];
      for (let i = 0; i < n; i++) lines.push(makeLineItem(line + i, segs[i]));
      if (n === 0) {
        // 单行超出读窗口（如 GB 级无换行单行文件）：返回该行的截断片段，避免整屏空白
        const frag = segs[0] || '';
        if (frag) lines.push({ line, text: frag.slice(0, LINE_MAX_CHARS), truncated: true, chars: 0 });
      }
      return {
        lines,
        endLine: lines.length ? lines[lines.length - 1].line : line - 1,
        start: rr.start,
        bytes: buf.length,
        eof,
        encoding: idx.encoding,
        pending: false,
        scannedLines: idx.lines,
        totalBytes: size,
      };
    }
    len = Math.min(BATCH_MAX_BYTES, len * 2); // 行长估算不足（有超长行）→ 扩窗重读，最多到 4MB
  }
}

// ---------- 侧车 GC（轻量回收：只增不减的 idx 目录） ----------
/** 扫描 idx 目录：mtime 超 30 天 或 数量超 GC_MAX_FILES 的最旧条目 → 删除。
 *  异步、非阻塞、失败静默；protectKey（刚写入的索引）永不回收。 */
async function gcIndexDir(protectKey) {
  const dir = indexDir();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { scanned: 0, removed: 0 }; // 目录尚不存在
  }
  const now = Date.now();
  const live = [];
  const expired = [];
  for (const name of names) {
    // 只处理侧车与崩溃残留的临时文件（.idx / .idx.tmp<pid>[.<seq>.<ts>]，兼容新旧两种命名）
    if (!/\.idx$/.test(name) && !/\.idx\.tmp[\d.]+$/.test(name)) continue;
    if (protectKey && name === protectKey + '.idx') continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      const e = { name, mtimeMs: st.mtimeMs };
      if (now - e.mtimeMs > GC_MAX_AGE_MS) expired.push(e);
      else live.push(e);
    } catch { /* 已被其它进程清理 */ }
  }
  live.sort((a, b) => b.mtimeMs - a.mtimeMs); // 最新在前
  const victims = expired.concat(live.slice(GC_MAX_FILES));
  let removed = 0;
  for (const v of victims) {
    try { await fsp.unlink(path.join(dir, v.name)); removed++; } catch { /* 占用/已删除：忽略 */ }
  }
  return { scanned: names.length, removed };
}

/** 触发式 GC：不阻塞调用方（微任务后异步跑），5 分钟内不重复扫目录 */
function scheduleIndexGc(protectKey) {
  if (gcRunning) return;
  const now = Date.now();
  if (now - gcLastAt < GC_MIN_INTERVAL_MS) return;
  gcLastAt = now;
  gcRunning = true;
  Promise.resolve()
    .then(() => gcIndexDir(protectKey))
    .catch(() => { /* 回收失败不影响索引功能 */ })
    .finally(() => { gcRunning = false; });
}

/** 偏移直读的编码探测：以「块内最后一个换行」为界做严格 UTF-8 校验（截点落在多字节字符中间时不误判） */
function detectEncodingProbe(buf) {
  const nl = buf.lastIndexOf(10);
  const end = nl > 0 ? nl : Math.max(0, buf.length - 4);
  return detectEncoding(buf.subarray(0, end));
}

/** v0.10.0：按**字节偏移**直读一片行（索引尚未覆盖的区域也能看到真实内容；行号由渲染端估算）。
 *  - offset 落在行中时向前最多回退 64KB 找行首，保证第一行完整；
 *  - 只读 ≤4MB，末尾半行丢掉（下一次读取会从行首重新给出）；
 *  - 返回的 line 恒为 0（调用方按估算行号覆盖），text 已按 LINE_MAX_CHARS 截断并带 chars/truncated。
 *  这是**只读**路径：不建索引、不写侧车，也不影响渐进扫描。 */
async function readLinesAtOffset(file, offset, count) {
  const want = Math.max(1, Math.min(BATCH_MAX_LINES, Math.floor(Number(count) || 1)));
  const st = await fsp.stat(file);
  const size = st.size;
  let start = Math.max(0, Math.min(size, Math.floor(Number(offset) || 0)));
  if (start > 0) {
    const back = Math.min(64 * 1024, start);
    const hb = Buffer.allocUnsafe(back);
    const fh0 = await fsp.open(file, 'r');
    let got0 = 0;
    try {
      const rr = await fh0.read(hb, 0, back, start - back);
      got0 = rr.bytesRead;
    } finally {
      await fh0.close();
    }
    if (got0 > 0) {
      const nl = hb.subarray(0, got0).lastIndexOf(10);
      if (nl >= 0) start = start - back + nl + 1; // 行首
    }
  }
  const MAX_READ = 4 * 1024 * 1024;
  const len = Math.min(MAX_READ, size - start);
  if (len <= 0) return { lines: [], startOffset: start, endOffset: start, eof: true, encoding: null };
  const buf = Buffer.allocUnsafe(len);
  const fh = await fsp.open(file, 'r');
  let got = 0;
  try {
    const rr = await fh.read(buf, 0, len, start);
    got = rr.bytesRead;
  } finally {
    await fh.close();
  }
  const chunk = buf.subarray(0, got);
  const encoding = detectEncodingProbe(chunk);
  const text = decodeBuffer(chunk, encoding);
  const parts = text.split('\n');
  const atEof = start + got >= size;
  // 末尾换行后不是新行（''），非 EOF 的末尾半行留给下一段 —— 两种都丢掉最后一段
  if (text.endsWith('\n') || !atEof) parts.pop();
  const lines = [];
  for (let i = 0; i < parts.length && lines.length < want; i++) {
    const s = parts[i].endsWith('\r') ? parts[i].slice(0, -1) : parts[i];
    lines.push(makeLineItem(0, s));
  }
  return { lines, startOffset: start, endOffset: start + got, eof: atEof, encoding };
}

function registerLineIndexIpc() {
  ipcMain.handle('huge:index', async (e, file, opts) => {
    if (!file) throw new Error('缺少文件路径');
    const force = !!(opts && typeof opts === 'object' && opts.force); // force：跳过内存/磁盘缓存强制重扫
    const win = (() => { try { return BrowserWindow.fromWebContents(e.sender); } catch { return null; } })();
    const idx = await getIndex(file, {
      force,
      onProgress: (done, total) => {
        try { if (win && !win.isDestroyed()) win.webContents.send('huge:index-progress', { file, done, total }); } catch { /* 忽略 */ }
      },
    });
    scheduleIndexGc(idx.key); // 成功返回后触发侧车回收（异步、非阻塞、失败忽略）
    const { starts, ...rest } = idx; // starts 不出主进程（可达数万条）
    return { ...rest, sparse: SPARSE };
  });
  // 批量取数：一次 IPC 返回整个视口（渲染端不再逐行 await）
  ipcMain.handle('huge:lines', async (_e, arg) => {
    const file = arg && arg.file;
    if (!file) throw new Error('缺少文件路径');
    return await readLines(file, arg.from, arg.count);
  });
  ipcMain.handle('huge:line-offset', async (_e, file, line) => lineToOffset(file, line));
  // v0.10.0：偏移直读（索引未覆盖区域的「真实内容 + 估算行号」预览）
  ipcMain.handle('huge:lines-by-offset', async (_e, arg) => {
    const file = arg && arg.file;
    if (!file) throw new Error('缺少文件路径');
    return await readLinesAtOffset(file, arg.offset, arg.count);
  });
  ipcMain.handle('huge:offset-line', async (_e, file, offset) => offsetToLine(file, offset));
  // 缓存维护：删除某文件的索引（文件已不存在时清理用）—— 内存与磁盘两份一起失效
  ipcMain.handle('huge:index-drop', async (_e, file) => {
    if (!file) return false;
    let dropped = false;
    try {
      const st = await fsp.stat(file);
      const key = cacheKey(st, file);
      memDropKey(key);
      await fsp.unlink(path.join(indexDir(), key + '.idx'));
      dropped = true;
    } catch { /* 文件已不存在 / 侧车不存在 */ }
    memDropFile(file); // 算不出 key 时按路径兜底（文件被删后 size/mtime 已变）
    return dropped;
  });
}

module.exports = {
  registerLineIndexIpc,
  getIndex,
  lineToOffset,
  offsetToLine,
  readLines,
  readLinesAtOffset,
  scan,
  gcIndexDir,
  memStats,
  SPARSE,
};
