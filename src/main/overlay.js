// 大文件 overlay 数据模型（Phase D 第一步，v0.4.0）：按行分块的写时复制（CoW）文档
//
// 目标：GB 级文件也能「就地编辑」而不把整篇读进内存 —— 未改动的块**始终留在原文件里**，
// 只有被编辑触及的块才物化到 userData/overlay/<sha1(path|size|mtime|ver)>.tmp；保存时
// 按块顺序把「原文件区间 + overlay 内容」流式写到同目录临时文件，校验字节数后 rename 原子替换。
//
// 关键设计（每条都对应一次取证，见 docs/开发计划-大文件秒开与秒搜-0.4.0.md §6）：
//  1) 块划分零额外 IO：只吃 lineindex 的稀疏行首表（每 1000 行一个偏移，lineindex.js:150）。
//     块 = 10 万行 = 100 个稀疏条目 → 块首字节 = starts[b*100 - 1]（b>0），
//     块字节跨度 = 相邻块首之差（末块到文件末尾）。因此建立块表不需要再扫一遍文件。
//  2) 行号 ↔ 位置：Float64Array 前缀和（行数 + 字节各一份，4000 万行也只有 ~6.4KB）+ 二分；
//     块内定位复用 lineindex 同口径（稀疏表取 1000 行子块起点 → 向前扫 ≤1000 个换行），
//     因此干净文档下 doc.lineOffset(line) 必须与 lineindex.lineToOffset(file, line) 逐字节一致。
//  3) 字节保真：块文本 ↔ 行数组只由 splitBlockText/joinBlockText 定义，**不做任何 EOL 归一化**
//     （CRLF 的 \r 留在行文本里；末尾无换行由块的 endsNL 标记）。未编辑块按原字节拷贝，
//     所以「打开 → 不改 → 保存」必须与源文件 Buffer.compare === 0。
//  4) 行数口径与 lineindex 一致：行数 = 换行数 + (末尾无换行的最后一行为真则 +1)。
//     即「a\n」是 1 行、空文件 0 行；由此保存后重新打开得到同样的行数（save → reopen 是不动点）。
//  5) 编辑：spliceLines 只物化首尾受影响块（中间块整块丢弃），新文本追加写 overlay 后按
//     1000 行 / 4MB 切成新块（视口读取只碰一个小分片）；撤销 = 块级操作栈（默认 200 步，
//     只存块引用，内存与编辑量成正比）。
//  6) 硬前置 checkEditable：UTF-8 + 非二进制（无 NUL）+ 每个块 ≤ 32MB，否则一律拒绝编辑。
//     理由：Node 只有 GBK 解码器没有编码器（混编码输出会毁文件）；单块过大物化会 OOM
//     （典型退化场景是「几行却 3.9GB」的稀疏文件，按行分块时它就是单块）。
//  7) 崩溃恢复：overlay 字节 + <key>.json 块表（file/overlay 块 + 分片表）落盘，进程崩溃后
//     可按 key 复读块表重建。
//  8) 本模块**不 require electron**（只 fs / path / crypto），因此可在纯 node 下直跑逻辑探针；
//     行索引由调用方注入（第二步 overlay-ipc.js 用 require('./lineindex').getIndex(file) 取
//     **含 starts** 的进程内索引 —— 注意 huge:index 的 IPC 返回值已剥离 starts，不能直接用）。
//  9) 保存路径的「是否允许写」「是否自写回声」由调用方以钩子注入（io.requireApproved /
//     io.markSelfWrite），保持本模块零 electron 依赖。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const OVL_VERSION = 1;                          // overlay 模型版本（进 docKey：模型变更即失效旧 overlay）
const LINES_PER_SPARSE = 1000;                  // 与 lineindex.SPARSE 对齐：每 1000 行一个行首偏移
const SUB_PER_BLOCK = 100;                      // 每块 = 100 个稀疏条目 = 10 万行
const LINES_PER_BLOCK = LINES_PER_SPARSE * SUB_PER_BLOCK;
const BLOCK_SOFT_MAX_BYTES = 32 * 1024 * 1024;  // 单块字节软上限（超过即禁止编辑：物化会爆内存）
const CHUNK_LINES = 1000;                       // 物化文本切分片：行数上限
const CHUNK_BYTES = 4 * 1024 * 1024;            // 物化文本切分片：字节上限（沿用 lineindex 单次读窗口口径）
const LINE_MAX_CHARS = 40000;                   // 单行截断（与 lineindex.js:41 LINE_MAX_CHARS 一致）
const BATCH_MAX_LINES = 1000;                   // readLines 单次行数上限（与 lineindex BATCH_MAX_LINES 一致）
const READ_MAX_BYTES = 4 * 1024 * 1024;         // readLines 单次读窗口上限
const READ_MIN_BYTES = 64 * 1024;               // readLines 单次读窗口下限（避免超短行反复扩窗）
const READLINE_MAX_BYTES = 64 * 1024 * 1024;    // readLineText 单行上限（防 GB 级单行把内存打爆）
const MATERIALIZE_MAX_BYTES = 64 * 1024 * 1024; // 单次编辑物化文本上限
const UNDO_LIMIT = 200;                         // 撤销栈上限（计划文档 §6 口径）
const CACHE_MAX_CHUNKS = 8;                     // overlay 分片读缓存：条数
const CACHE_MAX_BYTES = 16 * 1024 * 1024;       // overlay 分片读缓存：字节数
const OVL_GC_MAX_FILES = 200;                   // overlay 目录 GC：保留条数（照抄 lineindex GC 口径）
const OVL_GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // overlay 目录 GC：30 天未访问
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;       // 保存时的拷贝缓冲（复用同一块，避免大块进内存）
const META_DEBOUNCE_MS = 200;                   // 块表落盘去抖（一次编辑可物化上百个分片，逐键写盘太重）
const NL = 0x0a;

const DEFAULT_LIMITS = {
  batchMaxLines: BATCH_MAX_LINES,
  readMaxBytes: READ_MAX_BYTES,
  readMinBytes: READ_MIN_BYTES,
  chunkLines: CHUNK_LINES,
  chunkBytes: CHUNK_BYTES,
  materializeMaxBytes: MATERIALIZE_MAX_BYTES,
  readLineMaxBytes: READLINE_MAX_BYTES,
  undoLimit: UNDO_LIMIT,
  lineMaxChars: LINE_MAX_CHARS,
  cacheMaxChunks: CACHE_MAX_CHUNKS,
  cacheMaxBytes: CACHE_MAX_BYTES,
  copyChunkBytes: COPY_CHUNK_BYTES,
};

// ---------- 小工具 ----------
function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
/** 判定路径相等（Windows 大小写不敏感） */
function samePath(a, b) {
  const x = path.resolve(String(a || ''));
  const y = path.resolve(String(b || ''));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/** 真实路径（跟随符号链接；失败回退规范化绝对路径）——与 security.realpath 同口径 */
function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(String(p || ''));
    }
  }
}
function safeCall(fn, arg) {
  try { fn(arg); } catch { /* 回调（进度上报等）异常不影响主流程 */ }
}
function canceledError() {
  const e = new Error('保存已取消');
  e.canceled = true;
  return e;
}

// ===================== 键与目录 =====================
/** overlay 根目录：<userData>/overlay（与 lineindex.js:54 indexDir() 的 <userData>/lineidx 平级） */
function overlayDir(userData) {
  const root = userData || process.env.MH_USERDATA || defaultUserData();
  if (!root) throw new Error('overlayDir 需要 userData 目录（主进程传 app.getPath("userData")）');
  return path.join(root, 'overlay');
}
/** 兜底 userData（不引 os 模块：用环境变量） */
function defaultUserData() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.env.TEMP || process.env.TMP;
  return base ? path.join(base, 'MarkHunter') : null;
}
/** 文档键：sha1(realpath|size|floor(mtimeMs)|version) —— 口径对齐 lineindex.js:56-60 cacheKey */
function docKey(filePath, stat, version = OVL_VERSION) {
  const st = stat || {};
  const size = num(st.size, 0);
  const mtime = Math.floor(num(st.mtimeMs, 0));
  return crypto.createHash('sha1')
    .update(`${realpath(filePath)}|${size}|${mtime}|${version}`)
    .digest('hex');
}

// ===================== 纯函数：块划分 =====================
/** 第 b 块的首字节偏移：b===0 → 0，否则 = starts[b*SUB_PER_BLOCK - 1]（推导：块 b 首行 = b*10万+1，
 *  恰是稀疏表第 b*100-1 项记录的行首）。零额外 IO —— 这就是「按行数分块」的唯一理由。 */
function blockStartByte(base, b) {
  const starts = (base && base.starts) || [];
  if (b <= 0) return 0;
  const idx = b * SUB_PER_BLOCK - 1;
  const v = starts[idx];
  if (!Number.isFinite(v)) throw new Error(`行索引稀疏表不完整：缺少 starts[${idx}]（无法建立第 ${b} 块边界）`);
  return v;
}
/** 由行索引建立初始块表（全部是 file 块）。base 需含 { lines, bytes/size, starts, endsNL } */
function buildBlocks(base) {
  const b0 = base || {};
  const size = Math.max(0, Math.floor(num(b0.size != null ? b0.size : b0.bytes, 0)));
  const lines = Math.max(0, Math.floor(num(b0.lines, 0)));
  const starts = Array.isArray(b0.starts) ? b0.starts : [];
  const endsNL = b0.endsNL === true;
  if (lines > 0 && size === 0) throw new Error('行索引与文件大小不一致（lines>0 但 size=0），请重建索引');
  if (lines <= 0) {
    // 空文件：保留一个 0 字节块，保证块表始终非空（否则 splice 无处落笔）
    return [{ kind: 'file', start: 0, bytes: 0, lines: 0, endsNL: false }];
  }
  const full = Math.floor(lines / LINES_PER_BLOCK);
  const rest = lines % LINES_PER_BLOCK;
  const count = full + (rest > 0 ? 1 : 0);
  const out = [];
  for (let b = 0; b < count; b++) {
    const start = blockStartByte(b0, b);
    out.push({
      kind: 'file',
      start,
      bytes: 0, // 下面按相邻块首之差补齐
      lines: Math.min(LINES_PER_BLOCK, lines - b * LINES_PER_BLOCK),
      endsNL: true, // 中间块一律以换行结束（块边界即行首）；末块在下面修正
    });
  }
  for (let b = 0; b < out.length; b++) {
    const nextStart = b + 1 < out.length ? out[b + 1].start : size;
    out[b].bytes = Math.max(0, nextStart - out[b].start);
  }
  out[out.length - 1].endsNL = endsNL; // 只有末块可能「末尾无换行」
  return out;
}
/** 前缀和：行数与字节各一份（Float64Array；4000 万行 / 4GB 均在 2^53 内精确表示） */
function rebuildPrefix(blocks) {
  const n = Array.isArray(blocks) ? blocks.length : 0;
  const cums = new Float64Array(n + 1);
  const cumBytes = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cums[i + 1] = cums[i] + num(blocks[i].lines, 0);
    cumBytes[i + 1] = cumBytes[i] + num(blocks[i].bytes, 0);
  }
  return { cums, cumBytes };
}
/** 行号（1 基）→ 块下标：找最小的 b 使 cums[b+1] >= line */
function findBlock(cums, line) {
  const n = cums.length - 1;
  if (n <= 0) return 0;
  const L = Math.floor(num(line, 1));
  if (L <= 1) return 0;
  if (L > cums[n]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cums[mid + 1] >= L) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
/** 字节偏移 → 块下标（找最大的 b 使 cumBytes[b] <= off） */
function blockAtByte(cumBytes, off) {
  const n = cumBytes.length - 1;
  if (n <= 0) return 0;
  const o = Math.max(0, Math.floor(num(off, 0)));
  if (o <= 0) return 0;
  if (o >= cumBytes[n]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumBytes[mid + 1] > o) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
/** 块首行号（1 基） */
function blockToLine(cums, b) {
  const n = cums.length - 1;
  if (n <= 0) return 1;
  const i = clamp(Math.floor(num(b, 0)), 0, n - 1);
  return cums[i] + 1;
}
/** 块文本 → 行数组（唯一规范；不做 EOL 归一化，\r 留在行尾） */
function splitBlockText(text, endsNL) {
  const t = text == null ? '' : String(text);
  if (t === '') return [];
  const segs = t.split('\n');
  if (endsNL === true) segs.pop(); // 末尾换行是「行终止符」，不产生额外空行（与 lineindex 行数口径一致）
  return segs;
}
/** 行数组 → 块文本（唯一规范；split 的逆运算，byte 级往返必须一致） */
function joinBlockText(lines, endsNL) {
  const arr = Array.isArray(lines) ? lines.map((s) => (s == null ? '' : String(s))) : [];
  if (arr.length === 0) return '';
  return arr.join('\n') + (endsNL === true ? '\n' : '');
}
/** 可编辑前置检查（硬门槛：spliceLines 不可编辑一律拒绝） */
function checkEditable(base, blocks) {
  const b = base || {};
  const bs = Array.isArray(blocks) ? blocks : [];
  if (b.binary === true) {
    return { editable: false, reason: '二进制内容（含 NUL 字节，按文本近似显示），暂不支持编辑' };
  }
  const enc = String(b.encoding || 'utf-8').toLowerCase();
  if (enc !== 'utf-8') {
    return {
      editable: false,
      reason: enc === 'gbk'
        ? '该文件为 GBK 编码，暂不支持大文件编辑（Node 无 GBK 编码器，保存会产生混合编码）'
        : `该文件编码为 ${enc}，暂不支持大文件编辑（仅有 UTF-8 编码器）`,
    };
  }
  if (bs.length === 0) return { editable: false, reason: '块表为空，无法编辑' };
  let worst = 0;
  let worstIdx = -1;
  for (let i = 0; i < bs.length; i++) {
    const v = num(bs[i].bytes, 0);
    if (v > worst) { worst = v; worstIdx = i; }
  }
  if (worst > BLOCK_SOFT_MAX_BYTES) {
    return {
      editable: false,
      reason: `单块 ${(worst / 1048576).toFixed(1)}MB 超出编辑上限 ${BLOCK_SOFT_MAX_BYTES / 1048576}MB`
        + '（行长过大或行数过少，物化会占满内存），暂不支持编辑',
      block: worstIdx,
      bytes: worst,
    };
  }
  return { editable: true };
}

// ===================== overlay 文件 I/O =====================
/** overlay 目录 GC（口径照抄 lineindex.js:385-431：mtime>30 天 或 数量>200 的最旧条目） */
async function gcOverlayDir(dir, protectKey, opts = {}) {
  const maxFiles = num(opts.maxFiles, OVL_GC_MAX_FILES);
  const maxAgeMs = num(opts.maxAgeMs, OVL_GC_MAX_AGE_MS);
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
    if (!/\.(tmp|json)$/.test(name) && !/\.(tmp|json)\.tmp\d+$/.test(name)) continue;
    if (protectKey && (name === protectKey + '.tmp' || name === protectKey + '.json')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > maxAgeMs) expired.push({ name, mtimeMs: st.mtimeMs });
      else live.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* 已被其它进程清理 */ }
  }
  live.sort((a, b) => b.mtimeMs - a.mtimeMs); // 最新在前
  const victims = expired.concat(live.slice(maxFiles));
  let removed = 0;
  for (const v of victims) {
    try { await fsp.unlink(path.join(dir, v.name)); removed++; } catch { /* 占用/已删除：忽略 */ }
  }
  return { scanned: names.length, removed };
}

/** overlay 文件层：<dir>/<key>.tmp（追加写的字节仓库）+ <dir>/<key>.json（块表，崩溃恢复用） */
function createOverlayIo(opts = {}) {
  const dir = opts.dir || overlayDir(opts.userData);
  const ovlPath = (key) => path.join(dir, key + '.tmp');
  const metaPath = (key) => path.join(dir, key + '.json');

  /** 追加一条记录 → 返回它在 overlay 文件中的起始偏移（同一 key 串行调用，见 Doc 的单例约束） */
  async function appendRecord(key, buf) {
    if (!key) throw new Error('appendRecord 需要 key');
    const file = ovlPath(key);
    await fsp.mkdir(dir, { recursive: true });
    const fh = await fsp.open(file, 'a');
    try {
      const st = await fh.stat();
      const off = st.size;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf == null ? '' : buf), 'utf8');
      if (b.length) await fh.write(b, 0, b.length, null); // 'a' 模式：顺序追加，position 参数会被忽略
      return off;
    } finally {
      await fh.close().catch(() => {});
    }
  }
  /** 读回记录：**必须整段读满**，短读即抛（崩溃截断的尾巴不能被当成正常内容） */
  async function readRecord(key, off, len) {
    const n = Math.floor(num(len, 0));
    if (n <= 0) return Buffer.alloc(0);
    const fh = await fsp.open(ovlPath(key), 'r');
    try {
      const buf = Buffer.alloc(n);
      let read = 0;
      while (read < n) {
        const r = await fh.read(buf, read, n - read, Math.floor(num(off, 0)) + read);
        if (!r.bytesRead) break;
        read += r.bytesRead;
      }
      if (read !== n) {
        throw new Error(`overlay 记录不完整（期望 ${n} 字节，实读 ${read}）—— 上次写入可能被中断`);
      }
      return buf;
    } finally {
      await fh.close().catch(() => {});
    }
  }
  /** 写块表（先写临时文件再 rename：避免半截 JSON 被下次读到，口径同 lineindex writeCache） */
  async function writeMeta(key, meta) {
    await fsp.mkdir(dir, { recursive: true });
    const target = metaPath(key);
    const tmp = target + '.tmp' + process.pid;
    await fsp.writeFile(tmp, JSON.stringify(meta), 'utf8');
    await fsp.rename(tmp, target);
    return target;
  }
  async function readMeta(key) {
    try {
      return JSON.parse(await fsp.readFile(metaPath(key), 'utf8'));
    } catch {
      return null;
    }
  }
  /** 删除某文档的 overlay 字节与块表（保存成功 / 放弃编辑时调用） */
  async function dropKey(key) {
    if (!key) return false;
    let ok = false;
    for (const p of [ovlPath(key), metaPath(key)]) {
      try { await fsp.unlink(p); ok = true; } catch { /* 不存在 */ }
    }
    return ok;
  }
  /** 目录用量（overlayBytes 的物理口径） */
  async function usage(key) {
    try {
      const st = await fsp.stat(ovlPath(key));
      return { exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { exists: false, bytes: 0, mtimeMs: 0 };
    }
  }
  async function list() {
    try {
      return await fsp.readdir(dir);
    } catch {
      return [];
    }
  }
  return {
    dir,
    ovlPath,
    metaPath,
    appendRecord,
    readRecord,
    writeMeta,
    readMeta,
    dropKey,
    usage,
    list,
    gcOverlayDir: (protectKey) => gcOverlayDir(dir, protectKey, opts),
    // 保存路径的钩子必须原样透传（第二步 overlay-ipc 注入 security.requireApproved / filewatch.markSelfWrite）
    requireApproved: typeof opts.requireApproved === 'function' ? opts.requireApproved : null,
    markSelfWrite: typeof opts.markSelfWrite === 'function' ? opts.markSelfWrite : null,
    allowUnapproved: opts.allowUnapproved === true, // 仅测试/探针可放行
    getIndex: typeof opts.getIndex === 'function' ? opts.getIndex : null, // 行索引提供者（openDoc 可省 index 参数）
  };
}

// ===================== 源文件按偏移读（纯 fs，不 require ipc.js） =====================
/** 从已打开的只读 fd 按绝对偏移读满 len（保存过程中用它钉住 inode） */
async function readFdRange(fh, start, len) {
  const n = Math.max(0, Math.floor(num(len, 0)));
  if (n <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(n);
  let read = 0;
  while (read < n) {
    const r = await fh.read(buf, read, n - read, Math.floor(num(start, 0)) + read);
    if (!r.bytesRead) break;
    read += r.bytesRead;
  }
  return buf.subarray(0, read);
}
/** 打开源文件读一段（越界自动截断） */
async function readFileRange(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    return await readFdRange(fh, start, len);
  } finally {
    await fh.close().catch(() => {});
  }
}
/** 把整个 Buffer 写入 fd（顺序写，position=null） */
async function writeAll(fh, buf) {
  let done = 0;
  while (done < buf.length) {
    const r = await fh.write(buf, done, buf.length - done, null);
    if (!r.bytesWritten) throw new Error('写入临时文件失败（磁盘已满？）');
    done += r.bytesWritten;
  }
}

// ===================== base 规范化 =====================
/** 组装模型需要的 base：{ file, key, size/bytes, mtimeMs, lines, starts, encoding, binary, sparse, endsNL } */
function makeBase(arg = {}) {
  const file = String(arg.file || '');
  if (!file) throw new Error('makeBase 需要 file');
  const idx = arg.index || arg;
  const stat = arg.stat || {};
  const size = Math.max(0, Math.floor(num(stat.size != null ? stat.size : (idx.bytes != null ? idx.bytes : idx.size), 0)));
  const lines = Math.max(0, Math.floor(num(idx.lines, 0)));
  const starts = Array.isArray(idx.starts) ? idx.starts : [];
  // 只有行数超过一个块（10 万行）时才必须用 starts 推块边界；小文件的稀疏表本来就是空的，不该拦
  if (lines > LINES_PER_BLOCK && starts.length === 0) {
    throw new Error('行索引缺少 starts（huge:index 的 IPC 返回值已剥离 starts，请传 require("./lineindex").getIndex(file) 的进程内结果）');
  }
  if (lines > 0 && size === 0) throw new Error('行索引与文件大小不一致（lines>0 但 size=0），请重建索引');
  return {
    file,
    key: null,
    size,
    bytes: size,
    mtimeMs: Math.floor(num(stat.mtimeMs != null ? stat.mtimeMs : idx.mtimeMs, 0)),
    lines,
    starts,
    encoding: String(idx.encoding || 'utf-8'),
    binary: idx.binary === true,
    sparse: num(idx.sparse, LINES_PER_SPARSE),
    endsNL: arg.endsNL === true,
  };
}
/** 校验 base 字段完整性（createDoc 入口把关） */
function normalizeBase(base) {
  if (!base || !base.file) throw new Error('createDoc 需要 base.file（请用 openDoc 或 makeBase 组装）');
  const b = Object.assign({}, base);
  b.size = Math.max(0, Math.floor(num(b.size != null ? b.size : b.bytes, 0)));
  b.bytes = b.size;
  b.lines = Math.max(0, Math.floor(num(b.lines, 0)));
  b.starts = Array.isArray(b.starts) ? b.starts : [];
  b.mtimeMs = Math.floor(num(b.mtimeMs, 0));
  if (typeof b.endsNL !== 'boolean') {
    throw new Error('base.endsNL 缺失（末尾是否以换行结束）：请用 openDoc 打开，或显式给出该标志');
  }
  if (b.lines > LINES_PER_BLOCK && b.starts.length === 0) {
    throw new Error('行索引缺少 starts（huge:index 的 IPC 返回值已剥离 starts，请传 require("./lineindex").getIndex(file) 的进程内结果）');
  }
  return b;
}

// ===================== 文档实例 =====================
/**
 * 创建文档（同步；base 需已含 endsNL —— 异步读取末尾字节请用 openDoc）
 * @param {{base:object, io?:object, dir?:string, userData?:string, limits?:object, id?:number, ownerWebContentsId?:number}} opts
 */
function createDoc(opts = {}) {
  const base = normalizeBase(opts.base);
  const io = opts.io || createOverlayIo({ dir: opts.dir || overlayDir(opts.userData) });
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const st = {
    id: opts.id == null ? null : opts.id,
    ownerWebContentsId: opts.ownerWebContentsId == null ? null : opts.ownerWebContentsId,
    key: docKey(base.file, base),
    base,
    blocks: buildBlocks(base),
    prefix: null,
    chunks: new Map(), // chunkId -> { id, off, bytes, lines, endsNL }
    cache: new Map(),  // chunkId -> { buf, at }
    cacheBytes: 0,
    undo: [],
    redo: [],
    chunkSeq: 0,
    opSeq: 0,
    closed: false,
    metaTimer: null,
    metaDirty: false,
  };
  st.base.key = st.key;
  st.editableInfo = checkEditable(st.base, st.blocks);

  function assertOpen() {
    if (st.closed) throw new Error('文档已关闭');
  }
  function assertEditable() {
    const r = checkEditable(st.base, st.blocks);
    st.editableInfo = r;
    if (!r.editable) throw new Error(r.reason || '该文件不支持大文件编辑');
    return r;
  }
  function prefixNow() {
    if (!st.prefix) st.prefix = rebuildPrefix(st.blocks);
    return st.prefix;
  }
  function totalLines() {
    const p = prefixNow();
    return p.cums[p.cums.length - 1];
  }
  function totalBytes() {
    const p = prefixNow();
    return p.cumBytes[p.cumBytes.length - 1];
  }
  function locate(line) {
    const p = prefixNow();
    const total = p.cums[p.cums.length - 1];
    const L = clamp(Math.floor(num(line, 1)), 1, Math.max(1, total));
    const b = findBlock(p.cums, L);
    return { b, lineInBlock: L - p.cums[b], line: L, total, blockLine: p.cums[b] + 1 };
  }
  /** 文档当前是否以换行结束（= 末块 endsNL） */
  function endsWithNL() {
    const last = st.blocks[st.blocks.length - 1];
    return !!last && last.endsNL === true;
  }

  // ---------- 分片读写 ----------
  function cacheGet(id) {
    const e = st.cache.get(id);
    if (!e) return null;
    st.cache.delete(id); // LRU：命中后置尾
    st.cache.set(id, e);
    return e.buf;
  }
  function cachePut(id, buf) {
    if (st.cache.has(id)) st.cacheBytes -= st.cache.get(id).buf.length;
    st.cache.delete(id);
    st.cache.set(id, { buf, at: Date.now() });
    st.cacheBytes += buf.length;
    while (st.cache.size > limits.cacheMaxChunks || (st.cacheBytes > limits.cacheMaxBytes && st.cache.size > 1)) {
      const k = st.cache.keys().next().value;
      st.cacheBytes -= st.cache.get(k).buf.length;
      st.cache.delete(k);
    }
  }
  /** 读分片（分片不可变：整片读入 + LRU 缓存，视口读取只碰一个小分片） */
  async function readChunkRange(rec, skip, len) {
    const n = Math.max(0, Math.min(len, rec.bytes - skip));
    if (n <= 0) return Buffer.alloc(0);
    let full = cacheGet(rec.id);
    if (!full) {
      full = await io.readRecord(st.key, rec.off, rec.bytes);
      cachePut(rec.id, full);
    }
    return full.subarray(skip, skip + n);
  }
  /** 读「块内 [skip, skip+len)」字节（file 块走原文件，overlay 块走 overlay 文件） */
  async function readBlockBytes(b, skip, len, fh) {
    const blk = st.blocks[b];
    if (!blk) return Buffer.alloc(0);
    const n = Math.max(0, Math.min(len, blk.bytes - skip));
    if (n <= 0) return Buffer.alloc(0);
    if (blk.kind === 'overlay') {
      const rec = st.chunks.get(blk.chunk);
      if (!rec) throw new Error('overlay 块引用的分片不存在（块表已损坏）');
      return await readChunkRange(rec, skip, n);
    }
    const abs = blk.start + skip;
    if (fh) return await readFdRange(fh, abs, n);
    return await readFileRange(st.base.file, abs, n);
  }
  /** 读虚拟字节区间（跨块拼接；虚拟偏移 = 块字节顺序拼接后的位置） */
  async function readVirtual(offset, len, fh) {
    const p = prefixNow();
    const out = [];
    let pos = Math.max(0, Math.floor(num(offset, 0)));
    let remain = Math.max(0, Math.floor(num(len, 0)));
    let b = blockAtByte(p.cumBytes, pos);
    while (remain > 0 && b < st.blocks.length) {
      const blk = st.blocks[b];
      const skip = pos - p.cumBytes[b];
      if (skip >= blk.bytes) { b++; continue; }
      const want = Math.min(remain, blk.bytes - skip);
      const buf = await readBlockBytes(b, skip, want, fh);
      if (!buf.length) break;
      out.push(buf);
      pos += buf.length;
      remain -= buf.length;
      if (buf.length < want) break; // 短读（文件被外部截断）→ 按实际返回
      b++;
    }
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }
  /** 块内「第 k 行行首」的字节偏移（k 为块内 0 基行号；k>=块行数时返回块尾） */
  async function inBlockOffset(b, k, fh) {
    const blk = st.blocks[b];
    if (k <= 0) return 0;
    if (k >= blk.lines) return blk.bytes;
    let from = 0;   // 块内扫描起点
    let need = k;   // 还需越过的换行数
    if (blk.kind === 'file') {
      // 稀疏表定位到 1000 行子块（与 lineindex.lineToOffset 同口径）
      const sub = Math.floor(k / LINES_PER_SPARSE);
      if (sub > 0) {
        const idx = b * SUB_PER_BLOCK + sub - 1;
        const v = st.base.starts[idx];
        if (Number.isFinite(v) && v >= blk.start && v <= blk.start + blk.bytes) {
          from = v - blk.start;
          need = k - sub * LINES_PER_SPARSE;
        }
      }
    }
    let pos = from;
    let remain = need;
    while (remain > 0 && pos < blk.bytes) {
      const win = Math.min(limits.readMaxBytes, blk.bytes - pos);
      const buf = await readBlockBytes(b, pos, win, fh);
      if (!buf.length) break;
      let f = 0;
      for (;;) {
        const i = buf.indexOf(NL, f);
        if (i < 0) break;
        remain--;
        f = i + 1;
        if (remain === 0) return pos + i + 1;
      }
      pos += buf.length;
      if (buf.length < win) break; // 短读
    }
    return Math.min(pos, blk.bytes);
  }
  /** 块文本（字节 → UTF-8 文本；含两项自检：合法 UTF-8、行数与块表一致） */
  async function blockText(b, fh) {
    const blk = st.blocks[b];
    const buf = await readBlockBytes(b, 0, blk.bytes, fh);
    // fatal 解码一次完成合法性自检（替代 toString 后整块重编码比对）；
    // ignoreBOM:true 不可省：缺省会吃掉文件头 BOM，破坏字节往返保真
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw new Error(`第 ${b} 块含非 UTF-8 字节（文件可能不是 UTF-8），暂不支持编辑`);
    }
    const n = splitBlockText(text, blk.endsNL).length;
    if (n !== blk.lines) {
      throw new Error(`第 ${b} 块行数不一致（索引 ${blk.lines} ≠ 实际 ${n}）—— 文件可能已被外部修改，请重开`);
    }
    return { buf, text };
  }

  // ---------- 行号定位 ----------
  /** 行号 → 虚拟字节偏移（编辑/跳转用；干净文档下应与 lineindex.lineToOffset 完全一致） */
  async function lineOffset(line) {
    assertOpen();
    const p = prefixNow();
    const total = p.cums[p.cums.length - 1];
    const want = Math.floor(num(line, 1));
    if (want > total) {
      // 越界：返回文档末尾（与 lineindex.js:245 lineToOffset 的越界口径一致）
      const b = Math.max(0, st.blocks.length - 1);
      return { offset: p.cumBytes[p.cumBytes.length - 1], block: b, line: total, inBlock: st.blocks[b] ? st.blocks[b].bytes : 0 };
    }
    const loc = locate(want);
    const rel = await inBlockOffset(loc.b, want - p.cums[loc.b] - 1); // 块内 0 基行号
    return { offset: p.cumBytes[loc.b] + rel, block: loc.b, line: loc.line, inBlock: rel };
  }
  /** 虚拟字节偏移 → 行号（二分块 + 块内计数换行） */
  async function offsetLine(offset) {
    assertOpen();
    const p = prefixNow();
    const total = totalBytes();
    const off = clamp(Math.floor(num(offset, 0)), 0, total);
    const b = blockAtByte(p.cumBytes, off);
    const blk = st.blocks[b];
    const inBlock = off - p.cumBytes[b];
    let count = 0;
    let pos = 0;
    while (pos < inBlock) {
      const win = Math.min(limits.readMaxBytes, inBlock - pos);
      const buf = await readBlockBytes(b, pos, win);
      if (!buf.length) break;
      let i = buf.indexOf(NL);
      while (i >= 0) {
        count++;
        i = buf.indexOf(NL, i + 1);
      }
      pos += buf.length;
      if (buf.length < win) break;
    }
    const line = clamp(p.cums[b] + count + 1, 1, Math.max(1, totalLines()));
    return { line, block: b, inBlock, eof: off >= total };
  }
  /** 单行完整文本（不含行尾换行；绕开 40000 字符截断，编辑超长行前必须先取全量） */
  async function readLineText(line) {
    assertOpen();
    const total = totalLines();
    if (total <= 0) return '';
    const ln = clamp(Math.floor(num(line, 1)), 1, total);
    const a = (await lineOffset(ln)).offset;
    const b = ln < total ? (await lineOffset(ln + 1)).offset : totalBytes();
    const len = b - a;
    if (len > limits.readLineMaxBytes) {
      throw new Error(`单行 ${(len / 1048576).toFixed(1)}MB 超过 ${limits.readLineMaxBytes / 1048576}MB 上限，暂不支持编辑`);
    }
    const buf = await readVirtual(a, len);
    // 行尾换行不属于行文本（与 splitBlockText 口径一致）
    const end = buf.length > 0 && buf[buf.length - 1] === NL ? buf.length - 1 : buf.length;
    return buf.subarray(0, end).toString('utf8');
  }
  /** 批量取行：与 lineindex.readLines 同形（{lines:[{line,text,truncated?,chars?}], endLine, start, bytes, eof, encoding}） */
  async function readLines(from, count) {
    assertOpen();
    const total = totalLines();
    const size = totalBytes();
    const line = clamp(Math.floor(num(from, 1)), 1, Math.max(1, total));
    const want = clamp(Math.floor(num(count, 1)), 1, limits.batchMaxLines);
    const start = (await lineOffset(line)).offset;
    const pack = (items, eofFlag, got) => ({
      lines: items,
      endLine: items.length ? items[items.length - 1].line : line - 1,
      start,
      bytes: got,
      eof: eofFlag,
      encoding: st.base.encoding,
      docId: st.id,
      block: (locate(line)).b,
    });
    if (total <= 0 || start >= size) return pack([], true, 0);
    const avg = Math.max(16, Math.ceil(size / Math.max(1, total)));
    let len = Math.min(limits.readMaxBytes, Math.max(limits.readMinBytes, want * avg + 1024));
    for (;;) {
      const buf = await readVirtual(start, len);
      if (!buf.length) return pack([], true, 0);
      const eof = start + buf.length >= size;
      const text = buf.toString('utf8');
      const segs = text.split('\n');
      const endsNL = buf[buf.length - 1] === NL;
      // 完整行数：末尾不以换行结束时，未到文件末尾的那一段是「半截行」，不能当整行返回
      const complete = endsNL ? segs.length - 1 : (eof ? segs.length : segs.length - 1);
      if (complete >= want || eof || buf.length >= limits.readMaxBytes || buf.length < len) {
        const n = Math.min(want, complete);
        const items = [];
        for (let i = 0; i < n; i++) items.push(makeLineItem(line + i, segs[i]));
        if (n === 0) {
          const frag = segs[0] || '';
          if (frag) items.push({ line, text: frag.slice(0, limits.lineMaxChars), truncated: true, chars: 0 });
        }
        return pack(items, eof, buf.length);
      }
      len = Math.min(limits.readMaxBytes, len * 2); // 行长估算不足 → 扩窗重读
    }
  }
  /** 单行成项：超长行截断到 LINE_MAX_CHARS（同 lineindex.makeLineItem） */
  function makeLineItem(line, text) {
    const s = text == null ? '' : String(text);
    if (s.length > limits.lineMaxChars) {
      return { line, text: s.slice(0, limits.lineMaxChars), truncated: true, chars: s.length };
    }
    return { line, text: s };
  }

  // ---------- 编辑（块级 CoW） ----------
  /** 把一段文本切成 ≤1000 行 / ≤4MB 的分片，写入 overlay 并生成 overlay 块 */
  async function putChunks(newBuf, regionEndsNL) {
    const text = newBuf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(newBuf)) {
      throw new Error('编辑结果含非法 UTF-8 字节，已中止（未改动 overlay）');
    }
    const lines = splitBlockText(text, regionEndsNL);
    const parts = [];
    let cur = [];
    let bytes = 0;
    const flush = (last) => {
      const e = last ? regionEndsNL : true; // 非末分片一律以换行结束（后面还有内容）
      const t = joinBlockText(cur, e);
      parts.push({ text: t, endsNL: e, lines: cur.length, bytes: Buffer.byteLength(t, 'utf8') });
      cur = [];
      bytes = 0;
    };
    for (const ln of lines) {
      const need = Buffer.byteLength(ln, 'utf8') + 1;
      if (cur.length && (cur.length >= limits.chunkLines || bytes + need > limits.chunkBytes)) flush(false);
      cur.push(ln);
      bytes += need;
    }
    flush(true);
    // 自检：分片拼回必须与输入字节完全一致（字节保真的最后一道闸）
    const back = Buffer.concat(parts.map((p) => Buffer.from(p.text, 'utf8')));
    if (!back.equals(newBuf)) throw new Error('分片拼接自检失败（内部错误），已中止编辑');
    const blocks = [];
    for (const p of parts) {
      const off = await io.appendRecord(st.key, Buffer.from(p.text, 'utf8'));
      const id = 'c' + (++st.chunkSeq);
      st.chunks.set(id, { id, off, bytes: p.bytes, lines: p.lines, endsNL: p.endsNL });
      blocks.push({ kind: 'overlay', chunk: id, off, bytes: p.bytes, lines: p.lines, endsNL: p.endsNL });
    }
    return blocks;
  }
  /**
   * 块级 CoW 编辑核心：把 [from, from+deleteCount-1] 行替换为 insertLines
   * @param {number} from 1 基行号（= totalLines+1 表示在末尾追加）
   * @param {number} deleteCount 删除行数（0 = 纯插入）
   * @param {string[]} insertLines 插入的行文本（不含换行；元素内含 \n 会报错）
   * @param {{trailingNewline?:boolean}} [opts] 仅当编辑触及文档末尾时有效：插入段之后是否补换行
   * @returns {Promise<object>} 操作摘要（含 opId / 新的 lines / bytes）
   */
  async function spliceLines(from, deleteCount, insertLines, opts = {}) {
    assertOpen();
    assertEditable();
    const total = totalLines();
    const f0 = Math.floor(num(from, 1));
    const del = Math.max(0, Math.floor(num(deleteCount, 0)));
    const ins = Array.isArray(insertLines) ? insertLines.map((s) => (s == null ? '' : String(s))) : [];
    for (const s of ins) {
      if (s.includes('\n')) throw new Error('插入行不得内含换行（多行文本请先按 \\n 拆分）');
    }
    if (f0 < 1 || f0 > total + 1) throw new Error(`起始行 ${f0} 越界（文档共 ${total} 行，可落笔位置 1..${total + 1}）`);
    const lastDel = f0 + del - 1;
    if (lastDel > total) throw new Error(`删除范围越界（第 ${f0} 行起删 ${del} 行，文档共 ${total} 行）`);
    const atEnd = lastDel >= total; // 触及文档末尾 → 末行的换行状态由本次编辑决定
    const p = prefixNow();
    const fb = findBlock(p.cums, Math.min(f0, Math.max(1, total)));
    const lb = del > 0 ? findBlock(p.cums, Math.max(1, lastDel)) : fb;
    const bufA = (await blockText(fb)).buf;
    const bufB = lb === fb ? bufA : (await blockText(lb)).buf;
    const kA = f0 - p.cums[fb] - 1; // 块内 0 基行号（f0 = 块行数+1 时即块尾 → inBlockOffset 返回块字节长度）
    const startOff = await inBlockOffset(fb, kA);
    // 删除区间的结束字节 = 第 (lastDel+1) 行行首 = 块内 0 基行号 lastDel 的行首；lastDel 为块末行时即块尾
    const endOff = del > 0 ? await inBlockOffset(lb, lastDel - p.cums[lb]) : startOff;
    // 插入文本：非末尾插入的行一律以换行结束；末尾插入时由 trailingNewline 决定（默认保持文档原状）
    let text;
    if (ins.length === 0) text = '';
    else if (atEnd) text = ins.join('\n') + ((opts.trailingNewline === undefined ? endsWithNL() : opts.trailingNewline === true) ? '\n' : '');
    else text = ins.join('\n') + '\n';
    const head = bufA.subarray(0, startOff);
    const tail = bufB.subarray(endOff);
    const newBuf = Buffer.concat([head, Buffer.from(text, 'utf8'), tail]);
    if (newBuf.length > limits.materializeMaxBytes) {
      throw new Error(`编辑后单块文本 ${(newBuf.length / 1048576).toFixed(1)}MB 超过物化上限 ${limits.materializeMaxBytes / 1048576}MB，暂不支持该编辑`);
    }
    const wholeDoc = fb === 0 && lb === st.blocks.length - 1;
    const regionEndsNL = newBuf.length > 0 && newBuf[newBuf.length - 1] === NL;
    if (newBuf.length > 0 && lb + 1 < st.blocks.length && !regionEndsNL) {
      throw new Error('编辑区间之后仍有内容，但结果不以换行结束（内部错误）');
    }
    // 空区间且后面还有块 → 不放空块（只是白占块表）
    const inserted = (newBuf.length === 0 && !wholeDoc) ? [] : await putChunks(newBuf, regionEndsNL);
    const removed = st.blocks.slice(fb, lb + 1);
    st.blocks.splice(fb, removed.length, ...inserted);
    st.prefix = null;
    const op = {
      id: ++st.opSeq,
      at: fb, // 块表里的落点（撤销/重做据此换回块引用）—— 注意别与 t（时间戳）混用
      removed,
      inserted,
      from: f0,
      deleteCount: del,
      insertedLines: ins.length,
      t: Date.now(),
    };
    // 撤销栈：块级引用（分片不可变，所以撤销/重做零拷贝、内存与编辑量成正比）
    st.undo.push(op);
    while (st.undo.length > limits.undoLimit) st.undo.shift();
    st.redo.length = 0;
    scheduleMeta(); // 块表落盘（去抖）：崩溃恢复据此重建「源文件块 + overlay 分片」表
    return {
      ok: true,
      opId: op.id,
      from: f0,
      deleteCount: del,
      inserted: ins.length,
      blockFrom: fb,
      blockTo: fb + Math.max(0, inserted.length - 1),
      lines: totalLines(),
      bytes: totalBytes(),
      dirty: isDirty(),
      dirtyCount: dirtyCount(),
    };
  }
  /** 便捷：在某行某列插入文本（含换行则裂成多行；列 = 行文本内的 0 基字符下标） */
  async function insertText(line, col, text) {
    const cur = await readLineText(line);
    const c = clamp(Math.floor(num(col, 0)), 0, cur.length);
    const next = cur.slice(0, c) + String(text == null ? '' : text) + cur.slice(c);
    return await spliceLineText(line, next);
  }
  /** 用一段新文本替换某一行（新文本含换行则裂成多行；清空则保留一个空行） */
  async function spliceLineText(line, next) {
    const t = String(next == null ? '' : next);
    const endsNL = t.endsWith('\n');
    let segs = t.split('\n');
    if (endsNL) segs.pop();
    if (segs.length === 0) segs = ['']; // 整行文本被清空 → 仍是 1 个空行（不是删行）
    return await spliceLines(line, 1, segs, { trailingNewline: endsNL });
  }
  /** 便捷：[fromLine,fromCol] → [toLine,toCol] 区间删除（跨行则合并首尾行） */
  async function deleteRange(fromLine, fromCol, toLine, toCol) {
    let f = Math.floor(num(fromLine, 1));
    let t = Math.floor(num(toLine, f));
    let c1 = Math.floor(num(fromCol, 0));
    let c2 = Math.floor(num(toCol, 0));
    if (f > t || (f === t && c1 > c2)) { // 允许调用方传反
      const tf = f; const tc = c1;
      f = t; c1 = c2; t = tf; c2 = tc;
    }
    const total = totalLines();
    if (f < 1 || t > total) throw new Error(`删除范围越界（${f}..${t}，文档共 ${total} 行）`);
    if (f === t) {
      const cur = await readLineText(f);
      const a = clamp(c1, 0, cur.length);
      const b = clamp(c2, 0, cur.length);
      return await spliceLineText(f, cur.slice(0, Math.min(a, b)) + cur.slice(Math.max(a, b)));
    }
    const head = await readLineText(f);
    const tail = await readLineText(t);
    const merged = head.slice(0, clamp(c1, 0, head.length)) + tail.slice(clamp(c2, 0, tail.length));
    return await spliceLines(f, t - f + 1, [merged], { trailingNewline: t >= total ? endsWithNL() : true });
  }
  /** 撤销（同步；块引用直接换回，块表落盘异步补写） */
  function undo() {
    assertOpen();
    const op = st.undo.pop();
    if (!op) return false;
    st.blocks.splice(op.at, op.inserted.length, ...op.removed);
    st.redo.push(op);
    st.prefix = null;
    scheduleMeta();
    return true;
  }
  /** 重做 */
  function redo() {
    assertOpen();
    const op = st.redo.pop();
    if (!op) return false;
    st.blocks.splice(op.at, op.removed.length, ...op.inserted);
    st.undo.push(op);
    st.prefix = null;
    scheduleMeta();
    return true;
  }
  function isDirty() {
    for (const b of st.blocks) if (b.kind === 'overlay') return true;
    return false;
  }
  /** 脏块「区域」数（块表中连续的 overlay 块算一处修改）—— UI 的「N 处未保存修改」 */
  function regions() {
    const out = [];
    let start = -1;
    for (let i = 0; i < st.blocks.length; i++) {
      const ov = st.blocks[i].kind === 'overlay';
      if (ov && start < 0) start = i;
      if (!ov && start >= 0) { out.push({ from: start, to: i - 1 }); start = -1; }
    }
    if (start >= 0) out.push({ from: start, to: st.blocks.length - 1 });
    return out;
  }
  /** 未保存修改的处数（分片会被切成多个 overlay 块，所以按「连续区域」计数，不按块数） */
  function dirtyCount() {
    return regions().length;
  }
  /** overlay 逻辑字节数（当前块表引用的分片字节和） */
  function overlayBytes() {
    let n = 0;
    for (const b of st.blocks) if (b.kind === 'overlay') n += b.bytes;
    return n;
  }
  /** overlay 物理文件字节数（含撤销/重做仍在引用的历史分片） */
  async function overlayFileBytes() {
    const u = await io.usage(st.key);
    return u.bytes;
  }
  /** 前置校验：源文件与打开时一致（size/floor(mtimeMs)，口径同 lineindex.js:71-81 memGet 的再核对） */
  async function assertBaseUnchanged() {
    let s;
    try {
      s = await fsp.stat(st.base.file);
    } catch {
      throw new Error('源文件已不存在，无法保存');
    }
    if (s.size !== st.base.size || Math.floor(s.mtimeMs) !== st.base.mtimeMs) {
      throw new Error('文件已被外部修改，请重开标签后再保存');
    }
  }
  /**
   * 原子全量保存：干净块按原字节拷贝 + overlay 块按分片写 → 同目录临时文件 → fsync → 校验字节数 → rename
   * （**禁止就地增量改写**；rename 失败保留临时文件供重试，绝不 unlink 原文件）
   * @param {string} [targetPath] 目标路径（缺省 = 源文件；不同路径即「另存为」）
   * @param {{onProgress?:Function, signal?:{aborted:boolean}}} [opts]
   */
  async function saveTo(targetPath, opts = {}) {
    assertOpen();
    const target = path.resolve(String(targetPath || st.base.file));
    const total = totalBytes();
    const inPlace = samePath(target, st.base.file);
    const t0 = Date.now();
    if (!isDirty()) {
      return { ok: true, skipped: true, reason: '无未保存修改', target, size: total, bytes: total, ms: 0 };
    }
    await assertBaseUnchanged(); // 保存前必须确认源文件仍是打开时的那一份（外部改写一律拒绝，别覆盖别人的修改）
    // 写路径必须过 security.requireApproved（第二步 overlay-ipc 注入）；探针/单测需显式声明 io.allowUnapproved
    if (io.requireApproved) io.requireApproved(target, '路径不在当前工作目录内，操作已拒绝');
    else if (!io.allowUnapproved) {
      throw new Error('保存缺少路径批准钩子：请注入 io.requireApproved（security.requireApproved）；仅测试可显式设 io.allowUnapproved=true');
    }
    const tmp = path.join(
      path.dirname(target),
      '.' + path.basename(target) + '.mh-ovl-' + process.pid + '-' + Date.now() + '.tmp',
    );
    const progress = (phase, done) => { if (opts.onProgress) safeCall(opts.onProgress, { docId: st.id, done, total, phase }); };
    let srcFh = null;  // 源文件只读 fd：钉住 inode，保存中途被外部替换也不会读到混合内容
    let out = null;
    try {
      if (inPlace || st.blocks.some((b) => b.kind === 'file')) srcFh = await fsp.open(st.base.file, 'r');
      out = await fsp.open(tmp, 'w');
      const buf = Buffer.allocUnsafe(limits.copyChunkBytes);
      let done = 0;
      progress('copy', 0);
      for (let i = 0; i < st.blocks.length; i++) {
        if (opts.signal && opts.signal.aborted) throw canceledError();
        const blk = st.blocks[i];
        let skip = 0;
        while (skip < blk.bytes) {
          const want = Math.min(buf.length, blk.bytes - skip);
          const got = await readBlockBytes(i, skip, want, srcFh);
          if (!got.length) throw new Error(`读取第 ${i} 块时提前结束（文件可能已被外部修改）`);
          await writeAll(out, got);
          skip += got.length;
          done += got.length;
          if (opts.signal && opts.signal.aborted) throw canceledError();
          progress('copy', done);
        }
      }
      progress('verify', done);
      await out.sync(); // 先落盘再 rename（fs:splice-file 没做，这里做得更稳）
      await out.close();
      out = null;
      const stTmp = await fsp.stat(tmp);
      if (stTmp.size !== total) {
        try { await fsp.unlink(tmp); } catch { /* 清理失败忽略 */ }
        throw new Error(`保存校验失败：临时文件 ${stTmp.size} 字节 ≠ 预期 ${total} 字节`);
      }
      if (srcFh) { await srcFh.close(); srcFh = null; }
      progress('rename', done);
      try {
        await fsp.rename(tmp, target); // 同卷原子替换（临时文件建在目标同目录，跨卷 rename 会退化为拷贝）
      } catch (err) {
        const e = new Error(`原子替换失败（${err.code || err.message}）：临时文件已保留在 ${tmp}，请关闭占用该文件的程序后重试`);
        e.tmp = tmp;
        e.code = err.code;
        throw e;
      }
      if (io.markSelfWrite) {
        try { await io.markSelfWrite(target); } catch { /* 自写回声守卫失败不影响保存结果 */ }
      }
      const oldKey = st.key;
      const s2 = await fsp.stat(target);
      rebase({ size: s2.size, mtimeMs: Math.floor(s2.mtimeMs), file: target }); // 固化为干净文档（另存为同时改指新路径）
      const dropped = await io.dropKey(oldKey).catch(() => false); // overlay 临时文件已完成使命
      return {
        ok: true,
        target,
        size: total,
        bytes: total,
        ms: Date.now() - t0,
        dirty: false,
        droppedOverlay: dropped === true,
      };
    } catch (err) {
      if (out) await out.close().catch(() => {});
      if (srcFh) await srcFh.close().catch(() => {});
      if (!err.tmp) { // rename 之前的任何失败：删临时文件，原文件零改动（本设计从不就地写）
        try { await fsp.unlink(tmp); } catch { /* 未创建/已删除 */ }
      }
      throw err;
    }
  }
  /**
   * 保存成功后把块表「固化」到新文件：所有块按当前虚拟偏移变成 file 块。
   * （保存写出的字节顺序 = 块顺序，所以这一步零 IO 且行数/字节口径完全保持）
   * 注意：新文件的稀疏行首表这里拿不到（lineindex 归它管），故 starts 置空 →
   * 块内定位退化为「从块首顺序扫换行」（块 ≤32MB，正确但慢），保存后应由第二步
   * 立刻后台重建索引（huge:index）并把 doc 重新挂到新索引上。
   * @param {{size?:number, mtimeMs?:number, file?:string}} stat 新的文件状态
   */
  function rebase(stat = {}) {
    const p = prefixNow();
    const blocks = st.blocks.map((b, i) => ({
      kind: 'file',
      start: p.cumBytes[i],
      bytes: b.bytes,
      lines: b.lines,
      endsNL: b.endsNL === true,
    }));
    if (blocks.length === 0) blocks.push({ kind: 'file', start: 0, bytes: 0, lines: 0, endsNL: false });
    st.blocks = blocks;
    st.base = Object.assign({}, st.base, {
      file: stat.file ? String(stat.file) : st.base.file, // 另存为：文档从此指向新路径
      size: Math.floor(num(stat.size, totalBytes())),
      bytes: Math.floor(num(stat.size, totalBytes())),
      mtimeMs: Math.floor(num(stat.mtimeMs, st.base.mtimeMs)),
      endsNL: blocks[blocks.length - 1].endsNL === true,
      starts: [], // 新文件的稀疏表由 lineindex 重建（第二步保存后台重建索引）
    });
    st.key = docKey(st.base.file, st.base);
    st.base.key = st.key;
    st.prefix = null;
    st.chunks.clear();
    st.cache.clear();
    st.cacheBytes = 0;
    st.undo.length = 0;
    st.redo.length = 0;
    if (st.metaTimer) { clearTimeout(st.metaTimer); st.metaTimer = null; } // 旧 key 的块表不该再写（saveTo 已删除它）
    st.metaDirty = false;
  }
  /** 另存为后把文件路径换成新路径（保持干净状态；块表偏移已由 rebase 固化） */
  async function retargetTo(file) {
    const s = await fsp.stat(file);
    st.base = Object.assign({}, st.base, { file: String(file) });
    rebase({ size: s.size, mtimeMs: Math.floor(s.mtimeMs) });
    return st.base.file;
  }
  /** 崩溃恢复元数据：块表最小集（file/overlay 块 + 分片表 + 源文件身份） */
  function meta() {
    return {
      version: OVL_VERSION,
      key: st.key,
      file: st.base.file,
      size: st.base.size,
      mtimeMs: st.base.mtimeMs,
      encoding: st.base.encoding,
      savedAt: Date.now(),
      lines: totalLines(),
      bytes: totalBytes(),
      blocks: st.blocks.map((b) => (b.kind === 'file'
        ? { kind: 'file', start: b.start, bytes: b.bytes, lines: b.lines, endsNL: b.endsNL === true }
        : { kind: 'overlay', chunk: b.chunk, off: b.off, bytes: b.bytes, lines: b.lines, endsNL: b.endsNL === true })),
      chunks: [...st.chunks.values()].map((c) => ({ id: c.id, off: c.off, bytes: c.bytes, lines: c.lines, endsNL: c.endsNL === true })),
    };
  }
  async function persistMeta() {
    if (!io.writeMeta) return null;
    if (st.metaTimer) { clearTimeout(st.metaTimer); st.metaTimer = null; }
    st.metaDirty = false;
    const m = meta();
    await io.writeMeta(st.key, m);
    return m;
  }
  /** 块表落盘去抖：一次编辑会物化出上百个分片，块表可达几百 KB —— 逐键写盘太重。
   *  崩溃恢复只要求「最近一次」块表，200ms 合并足够；close/save 前用 persistMeta 强刷。 */
  function scheduleMeta() {
    if (!io.writeMeta || st.closed) return;
    st.metaDirty = true;
    if (st.metaTimer) return;
    st.metaTimer = setTimeout(() => {
      st.metaTimer = null;
      if (!st.metaDirty) return;
      persistMeta().catch(() => { /* 落盘失败不影响内存编辑（崩溃恢复会退化） */ });
    }, META_DEBOUNCE_MS);
    if (st.metaTimer.unref) st.metaTimer.unref(); // 纯 node 探针下不阻塞退出
  }
  /** 同步状态快照（IPC huge:doc-state 用；baseChanged 需要 stat，见 inspect） */
  function snapshot() {
    const p = prefixNow();
    return {
      docId: st.id,
      file: st.base.file,
      key: st.key,
      lines: p.cums[p.cums.length - 1],
      bytes: p.cumBytes[p.cumBytes.length - 1],
      blocks: st.blocks.length,
      dirty: isDirty(),
      dirtyCount: dirtyCount(),
      overlayBytes: overlayBytes(),
      undoDepth: st.undo.length,
      redoDepth: st.redo.length,
      editable: checkEditable(st.base, st.blocks).editable,
      reason: checkEditable(st.base, st.blocks).reason,
      endsNL: endsWithNL(),
      ownerWebContentsId: st.ownerWebContentsId,
    };
  }
  /** 含一次 stat 的状态快照（baseChanged = 源文件已被外部修改） */
  async function inspect() {
    const s = snapshot();
    try {
      const fsSt = await fsp.stat(st.base.file);
      s.baseChanged = fsSt.size !== st.base.size || Math.floor(fsSt.mtimeMs) !== st.base.mtimeMs;
    } catch {
      s.baseChanged = true;
    }
    return s;
  }
  /** 关闭：默认丢弃干净文档的 overlay；有未保存修改时保留（供崩溃恢复/确认弹窗） */
  async function close(opts = {}) {
    if (st.closed) return { ok: true, alreadyClosed: true };
    const discard = opts.discard === undefined ? !isDirty() : opts.discard === true;
    if (!discard) await persistMeta().catch(() => {}); // 保留场景：先把块表强刷落盘，恢复才有依据
    st.closed = true;
    if (st.metaTimer) { clearTimeout(st.metaTimer); st.metaTimer = null; }
    const dropped = discard ? await io.dropKey(st.key).catch(() => false) : false;
    st.cache.clear();
    st.cacheBytes = 0;
    return { ok: true, discarded: dropped === true, kept: !discard };
  }

  const doc = {
    // 只读视图
    get id() { return st.id; },
    get ownerWebContentsId() { return st.ownerWebContentsId; },
    get key() { return st.key; },
    get file() { return st.base.file; },
    get base() { return st.base; },
    get dirty() { return st.chunks; }, // 分片表（Map<chunkId, {off,bytes,lines,endsNL}>）
    get editable() { return checkEditable(st.base, st.blocks); },
    limits,
    io,
    // 行/字节
    lines: totalLines,
    totalLines,
    bytes: totalBytes,
    totalBytes,
    isDirty,
    dirtyCount,
    regions,
    dirtyBlocks: () => st.blocks.reduce((n, b) => n + (b.kind === 'overlay' ? 1 : 0), 0), // overlay 块（分片）数
    overlayBytes,
    overlayFileBytes,
    chunkCount: () => st.chunks.size,
    blocks: () => st.blocks.slice(),
    table: () => {
      const p = prefixNow();
      return { blocks: st.blocks.slice(), cums: p.cums, cumBytes: p.cumBytes, lines: totalLines(), bytes: totalBytes() };
    },
    locate,
    blockAtByte: (off) => blockAtByte(prefixNow().cumBytes, off),
    endsWithNL,
    // 读写
    lineOffset,
    offsetLine,
    readLineText,
    lineText: readLineText, // 别名（API 草案里的 lineText(line)）：返回**完整**行文本，不受 40000 字符截断
    readLines,
    // 编辑
    spliceLines,
    insertText,
    spliceLineText,
    deleteRange,
    undo,
    redo,
    undoDepth: () => st.undo.length,
    redoDepth: () => st.redo.length,
    canUndo: () => st.undo.length > 0,
    canRedo: () => st.redo.length > 0,
    // 落盘 / 生命周期
    saveTo,
    rebase,
    retargetTo,
    meta,
    persistMeta,
    flushMeta: persistMeta,
    snapshot,
    inspect,
    close,
    assertBaseUnchanged,
  };
  return doc;
}

/**
 * 异步打开：stat + 行索引（调用方注入，需含 starts）+ 末尾字节 → 建块表。
 * @param {{file?:string, stat?:object, index:object, io?:object, dir?:string, userData?:string, limits?:object, id?:number, ownerWebContentsId?:number}} opts
 */
async function openDoc(opts = {}) {
  const file = opts.file || (opts.base && opts.base.file);
  if (!file) throw new Error('openDoc 需要 file');
  const stat = opts.stat || await fsp.stat(file);
  if (!stat.isFile()) throw new Error('目标不是文件');
  // 行索引：优先显式传入；否则用注入的提供者（第二步 overlay-ipc 传 require('./lineindex').getIndex）
  const provider = opts.getIndex || (opts.io && opts.io.getIndex) || null;
  const index = opts.index || (opts.base && opts.base.starts ? opts.base : null) || (provider ? await provider(file) : null);
  if (!index) throw new Error('openDoc 需要行索引 index（可传 index，或注入 io.getIndex = require("./lineindex").getIndex）');
  // 末尾字节：lineindex 不暴露「是否以换行结束」，这里补一次 1 字节读（行数口径与末块 endsNL 都依赖它）
  let endsNL = false;
  if (stat.size > 0) {
    const fh = await fsp.open(file, 'r');
    try {
      const b = Buffer.alloc(1);
      const r = await fh.read(b, 0, 1, stat.size - 1);
      endsNL = r.bytesRead === 1 && b[0] === NL;
    } finally {
      await fh.close().catch(() => {});
    }
  }
  const base = makeBase({ file, stat, index, endsNL });
  return createDoc(Object.assign({}, opts, { base, file }));
}

/** 崩溃恢复：按 key 读回块表（第三步 overlay-ipc 的 huge:doc-recover-list 用） */
async function readRecovery(io, key) {
  if (!io || !io.readMeta || !key) return null;
  const m = await io.readMeta(key);
  if (!m || m.version !== OVL_VERSION || !Array.isArray(m.blocks)) return null;
  return m;
}

module.exports = {
  // 常量
  OVL_VERSION,
  LINES_PER_SPARSE,
  SUB_PER_BLOCK,
  LINES_PER_BLOCK,
  BLOCK_SOFT_MAX_BYTES,
  CHUNK_LINES,
  CHUNK_BYTES,
  LINE_MAX_CHARS,
  UNDO_LIMIT,
  DEFAULT_LIMITS,
  // 键与目录
  overlayDir,
  docKey,
  // 纯函数（探针可直接单测）
  buildBlocks,
  blockStartByte,
  rebuildPrefix,
  findBlock,
  blockAtByte,
  blockToLine,
  splitBlockText,
  joinBlockText,
  checkEditable,
  makeBase,
  normalizeBase,
  // overlay I/O
  createOverlayIo,
  gcOverlayDir,
  // 文档
  createDoc,
  openDoc,
  readRecovery,
  readFileRange,
};
