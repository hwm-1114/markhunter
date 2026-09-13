// 大文件 overlay 编辑模型 · 纯 node 逻辑探针（v0.4.0 Phase D 第一步）
//
// ── 这个脚本只做一件事 ────────────────────────────────────────────────────────────
// 把 docs/开发计划-大文件秒开与秒搜-0.4.0.md §6 那套「块级 CoW 临时缓冲编辑」的**核心不变量**
// 固化成可复跑的字节级证据：A 段是纯函数（无 I/O、毫秒级），B 段用自造的真实大文件走完整
// 打开 → 编辑 → 撤销/重做 → 保存 → 崩溃恢复 → GC 链路。
//
// ── 为什么纯 node 能测 ──────────────────────────────────────────────────────────
// overlay.js:27 注释「本模块不 require electron（只 fs / path / crypto）」——本脚本据此
// **只 require ../src/main/overlay.js**，不 require electron、不起窗口、不碰渲染端。
// 行索引由本脚本自己扫：lineindex.js:25 自己 require('electron')，且侧车写在
// app.getPath('userData')/lineidx 下——为了「临时文件只写 os.tmpdir()、不往仓库写数据文件」
// 这条硬约束，B 段索引用自造实现 buildIndexLikeLineindex()，其返回形状严格对齐
// lineindex.js:228-237 的 getIndex（{lines,longest,starts,encoding,binary,bytes}），
// 扫描口径照抄 lineindex.js:124-172（每 1000 行落一个行首 / 末尾无换行补 1 行）。
// 因此本探针**不产生**任何 lineindex 侧车，也不依赖真实 userData 目录。
//
// ── 运行 ───────────────────────────────────────────────────────────────────────
//   node scripts/overlay-test.js
// 输出：[ok] NN 标题 / [FAIL] NN 标题；末行 OVERLAY_PROBE <通过>/<总数> failed=<n> [skipped=<n>]
// 有失败项或任何「锚点/签名与预期不符」→ process.exit(1)（绝不静默跳过）。
// 临时文件全部建在 os.tmpdir()/mh-overlay-probe-<pid>-<ts>/，结束时整目录删除（失败会重试 5 次）。
//
// ── 实测到的真实语义（断言据此写，不是照抄任务书的假设）────────────────────────────
//  a) spliceLines(from, 0, lines) 是「替换 from 行」：插 3 行 → 行数 **+3**（不是 +2），
//     原 from 行的内容被顶到 from+3（overlay.js:906-919 spliceLineText 走的是 deleteCount=1）。
//  b) spliceLines(总行数+1, 0, X) 在「文档末尾无换行」时把 X **拼到末行尾部**（行数不变、字节增加），
//     因为 overlay.js:855-858 只在 atEnd 时用 trailingNewline（缺省 = 保持文档原状）；
//     传 {trailingNewline:true} 才会补换行。
//  c) deleteRange 是行区间**合并**：删 N 行 → 行数 -(N-1)（首尾两行拼成一行），不是 -N。
//  d) 一次 splice 会把「首尾受影响块」之间的内容整块重切分成 ≤1000 行 / ≤4MB 的分片
//     （本夹具 10 万行块 → 100 个 overlay 分片 + 未触及的尾块仍是 file 块）。
//  e) dirtyCount = **连续 overlay 区域数**，不是分片数（overlay.js:970-984 regions）。
//  f) close() 有未保存修改时走 persistMeta() 强刷（overlay.js:1221）→ 不必等 200ms 去抖。
//  g) saveTo 成功后 rebase() 让 isDirty()=false、undoDepth=0、starts 清空（overlay.js:1109-1138）。
//  h) meta.chunks 含「撤销/重做遗留但已不被块表引用」的历史分片 → 物理字节 ≥ 被引用分片之和。
//
// ── 覆盖不到的（诚实清单：脚本内 skipItem 会打印，且不计入总数）─────────────────────
// >1GB 稀疏文件 / 真实 32MiB 单块、并发保存、跨窗口所有权（overlay-ipc.js 层，需 electron 桩）、
// 保存中断与 rename 失败注入、渲染端消费口径（hugeview/tabs）、真实 lineindex.getIndex 全链路、
// overlay 目录 30 天老化默认值——逐条理由见运行时输出的 [SKIP] 行。
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const overlay = require(path.join(REPO, 'src', 'main', 'overlay.js'));

// ---------- 结果账本 ----------
const results = [];
const skipped = [];
let passed = 0;
let failed = 0;

const pad2 = (n) => String(n).padStart(2, '0');

async function check(no, title, fn) {
  const tag = `[${pad2(no)}] ${title}`;
  try {
    const info = await fn();
    passed++;
    results.push({ no, ok: true, tag, info });
    console.log(`[ok] ${tag}${info ? '  (' + info + ')' : ''}`);
  } catch (err) {
    failed++;
    const msg = String((err && err.message) || err);
    results.push({ no, ok: false, tag, msg });
    console.log(`[FAIL] ${tag}`);
    console.log(`        ${msg}`);
    if (err && err.stack) {
      const frames = String(err.stack).split('\n').slice(1, 4).map((s) => '        ' + s.trim());
      for (const f of frames) console.log(f);
    }
  }
}

/** 明确记账的跳过项：必须给出可复核的理由，且不计入总数 */
function skipItem(no, title, reason) {
  skipped.push(`[${pad2(no)}] ${title} —— ${reason}`);
}

// ---------- 断言（全部精确值；不用真值断言） ----------
function raw(v) {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s === undefined ? String(v) : s;
}
function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}\n          期望: ${raw(expected)}\n          实际: ${raw(actual)}`);
  }
}
function assertDeep(actual, expected, what) {
  const a = raw(actual);
  const e = raw(expected);
  if (a !== e) {
    throw new Error(`${what}\n          期望: ${e}\n          实际: ${a}`);
  }
}
function assertTrue(cond, what) {
  if (cond !== true) throw new Error(`${what}（实际 ${raw(cond)}）`);
}
function assertBufEq(actual, expected, what) {
  const a = Buffer.isBuffer(actual) ? actual : Buffer.from(String(actual), 'utf8');
  const e = Buffer.isBuffer(expected) ? expected : Buffer.from(String(expected), 'utf8');
  if (!a.equals(e)) {
    throw new Error(`${what}（Buffer.equals=false：实际 ${a.length} 字节 ≠ 期望 ${e.length} 字节）`
      + `\n          实际前 80 字节: ${raw(a.subarray(0, 80).toString('utf8'))}`
      + `\n          期望前 80 字节: ${raw(e.subarray(0, 80).toString('utf8'))}`);
  }
}
async function assertThrows(fn, re, what) {
  let got = null;
  try { await fn(); } catch (e) { got = e; }
  if (!got) throw new Error(`${what}：预期抛错，实际正常返回`);
  const msg = String(got.message || got);
  // 注意：调用方若用正则，必须自己转义中文全角括号「（）」—— 正则里的 () 是分组不是括号字面量
  if (re && !re.test(msg)) {
    throw new Error(`${what}：抛错文案与预期正则不符\n          正则: ${re}\n          实际: ${raw(msg)}`);
  }
  return msg;
}

// ---------- 小工具 ----------
async function fileSha1(file) {
  const h = crypto.createHash('sha1');
  const rs = fs.createReadStream(file);
  for await (const c of rs) h.update(c);
  return h.digest('hex');
}
async function readRange(file, start, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(len);
    const r = await fh.read(b, 0, len, start);
    return b.subarray(0, r.bytesRead);
  } finally { await fh.close().catch(() => {}); }
}
async function listNames(dir) {
  try { return (await fsp.readdir(dir)).sort(); } catch { return []; }
}
const utc = (ms) => new Date(ms).toISOString();

// ============================================================================
// 测试数据：确定性大文件
//   行 i（1 基）= 'L' + i 补零 6 位 + '|' + (i 奇 ? 'x' : 'y') × 108，定长 116 字符，全 ASCII
//   → 字符数 == 字节数（B 段的列偏移断言才可能是字节级精确的）；
//   → 116 字节/行 × 105000 行 ≈ 11.7MB（8–20MB 区间，远低于 32MiB 单块软上限）。
// ============================================================================
const LINE_COUNT = 105000;             // 105000 = 1×10万 + 5000 → 2 块（覆盖跨块与块边界编辑）
const SPARSE_EVERY = 1000;             // 与 lineindex.SPARSE / overlay.LINES_PER_SPARSE 同口径
const LINE_LEN = 116;                  // 行长（字节 == 字符）
const FILL = 'x'.repeat(200);          // 批量建行用：先拼长串再定长 slice

/** 第 i 行（1 基）的文本；i<1000000 时行长恒为 LINE_LEN */
function mkLine(i) {
  const tail = (i % 2 === 1) ? 'x' : 'y';
  return ('L' + String(i).padStart(6, '0') + '|' + tail.repeat(LINE_LEN)).slice(0, LINE_LEN);
}

/** 行文本数组 + 每行行首字节偏移（offsets[N] = 文档总字节数，末尾无换行） */
function makeLines() {
  const lines = new Array(LINE_COUNT);
  const offsets = new Float64Array(LINE_COUNT + 1);
  let off = 0;
  for (let i = 1; i <= LINE_COUNT; i++) {
    const s = mkLine(i);
    if (s.length !== LINE_LEN) throw new Error(`夹具行长错：第 ${i} 行 ${s.length} ≠ ${LINE_LEN}`);
    lines[i - 1] = s;
    offsets[i - 1] = off;
    off += LINE_LEN + 1; // 行长 116 + 换行 1（末行下面再减）
  }
  off -= 1; // 末行无换行
  offsets[LINE_COUNT] = off;
  return { lines, offsets, size: off };
}

/** 流式写大文件（不 require electron，不落仓库） */
async function writeLinesFile(file, lines) {
  const fh = await fsp.open(file, 'w');
  const CHUNK = 1000; // 每次 concat 1000 行
  try {
    for (let i = 0; i < lines.length; i += CHUNK) {
      const slice = lines.slice(i, i + CHUNK);
      const last = i + slice.length >= lines.length;
      const text = slice.join('\n') + (last ? '' : '\n');
      await fh.write(Buffer.from(text, 'utf8'));
    }
    await fh.sync();
  } finally { await fh.close(); }
}

/**
 * 自造行索引：返回形状严格对齐 lineindex.getIndex（lineindex.js:228-237）
 * { lines, longest, starts, encoding, binary, bytes }
 * starts[j] = 第 (j+1)*1000 行（1 基）的行首字节偏移（lineindex.js:150 口径）。
 * 实现口径照抄 lineindex.js:124-172 scan（换行计数 + 每 1000 行落一个行首 + 末尾无换行补 1 行）。
 */
async function buildIndexLikeLineindex(file) {
  const st = await fsp.stat(file);
  const starts = [];
  let lines = 0;
  let longest = 0;
  let lineStart = 0;
  let base = 0;
  let binary = false;
  let probed = 0;
  const BINARY_PROBE_BYTES = 8 * 1024 * 1024;
  const rs = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
  const t0 = Date.now();
  for await (const chunk of rs) {
    if (!binary && probed < BINARY_PROBE_BYTES) {
      const probe = chunk.subarray(0, Math.min(chunk.length, BINARY_PROBE_BYTES - probed));
      if (probe.includes(0)) binary = true;
      probed += probe.length;
    }
    let from = 0;
    for (;;) {
      const i = chunk.indexOf(0x0a, from);
      if (i < 0) break;
      lines++;
      if (lines % SPARSE_EVERY === 0) starts.push(base + i + 1);
      const len = base + i - lineStart;
      if (len > longest) longest = len;
      lineStart = base + i + 1;
      from = i + 1;
    }
    base += chunk.length;
  }
  if (lineStart < st.size) {
    lines++;
    const len = st.size - lineStart;
    if (len > longest) longest = len;
  }
  return {
    lines, longest, starts, encoding: 'utf-8', binary, bytes: st.size,
    _scanMs: Date.now() - t0,
  };
}

// ============================================================================
async function main() {
  const t0 = Date.now();
  console.log('=== MarkHunter overlay 探针（scripts/overlay-test.js）===');
  console.log(`node ${process.version} · overlay OVL_VERSION=${overlay.OVL_VERSION}`
    + ` · LINES_PER_BLOCK=${overlay.LINES_PER_BLOCK} · BLOCK_SOFT_MAX_BYTES=${overlay.BLOCK_SOFT_MAX_BYTES}`);
  console.log('');

  // 导出面锚点：签名与预期不符一律抛错并非 0 退出（硬约束 5）
  const F = {};
  for (const n of ['docKey', 'buildBlocks', 'blockStartByte', 'rebuildPrefix', 'findBlock',
    'blockAtByte', 'blockToLine', 'splitBlockText', 'joinBlockText', 'checkEditable',
    'makeBase', 'normalizeBase', 'overlayDir', 'createOverlayIo', 'gcOverlayDir',
    'createDoc', 'openDoc', 'readRecovery', 'readFileRange']) {
    const v = overlay[n];
    if (typeof v !== 'function') {
      throw new Error(`overlay 导出面锚点失配：overlay.${n} 不是函数（实际 ${typeof v}）`
        + ` —— 探针拒绝在签名不符的情况下继续（会得到假绿）`);
    }
    F[n] = v;
  }
  for (const [n, v] of Object.entries({
    OVL_VERSION: 1,
    LINES_PER_SPARSE: 1000,
    SUB_PER_BLOCK: 100,
    LINES_PER_BLOCK: 100000,
    BLOCK_SOFT_MAX_BYTES: 32 * 1024 * 1024,
  })) {
    if (overlay[n] !== v) {
      throw new Error(`overlay 常量锚点失配：${n} 期望 ${v}，实际 ${raw(overlay[n])}`);
    }
  }
  for (const n of ['DEFAULT_LIMITS', 'CHUNK_LINES', 'CHUNK_BYTES', 'LINE_MAX_CHARS', 'UNDO_LIMIT']) {
    if (overlay[n] === undefined) throw new Error(`overlay 常量锚点缺失：${n} undefined`);
  }
  console.log(`[anchor] 导出面 ${Object.keys(F).length} 个函数 + 常量表齐全，签名核对通过`);
  console.log('');

  const root = path.join(os.tmpdir(), 'mh-overlay-probe-' + process.pid + '-' + Date.now());
  const gcDir = path.join(root, 'gc');
  await fsp.mkdir(gcDir, { recursive: true });
  const mainFile = path.join(root, 'big.txt');
  const outFile = path.join(root, 'big-out.txt');
  const io = F.createOverlayIo({ dir: path.join(root, 'ovl'), allowUnapproved: true });

  const cleanup = async () => {
    // overlay 句柄异步落盘可能晚一拍（去抖 200ms）；重试删除
    for (let i = 0; i < 5; i++) {
      try { await fsp.rm(root, { recursive: true, force: true }); return; } catch { await sleep(120); }
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 本探针明确**没有**覆盖的面（不计入总数，也不假装通过）——列在输出里便于复核
  skipItem('B-1', '>1GB 稀疏文件 / 单块 >32MiB 的真实文件',
    '需要 GB 级磁盘与数十秒 IO；单块超限分支已由第 6 项（纯函数 checkEditable）精确覆盖，'
    + '但「真去物化一个 3.9GB 单块」没有实测（预期被 checkEditable 拒绝，故不会走到物化）');
  skipItem('B-2', '并发保存 / 同一 key 的并发编辑',
    '串行化由 overlay-ipc.js 的 withDocLock 保证（overlay.js 自身不锁），'
    + '纯 node 探针无法构造 IPC 层的并发语义；本探针只验证单文档串行路径');
  skipItem('B-3', '跨窗口所有权（ownerWebContentsId / 单例约束）',
    '属 overlay-ipc.js 的 registry 层，需要 electron 桩（ipcMain / BrowserWindow），违反「不 require electron」');
  skipItem('B-4', '保存中断（opts.signal.aborted）与 rename 失败（目标被占用）',
    '需要可控的失败注入；本探针只验证成功路径与「无 tmp 残留」');
  skipItem('B-5', '渲染端消费口径（hugeview.js 视口 / tabs.js 分档切换）',
    '需真实窗口；`npm run smoke` 的真实窗口用例覆盖（结果行数以末尾 E2E_RESULTS 为准），本探针不碰 src/renderer');
  skipItem('B-6', '真实 lineindex.getIndex 作为索引提供者走完整链路',
    'lineindex.js require electron（lineindex.js:25），需窗口才能拿 userData 目录；'
    + '本探针用「形状严格对齐 lineindex.js:228-237」的自造索引（见 buildIndexLikeLineindex 注释）');
  skipItem('B-7', 'overlay 目录 30 天老化（maxAgeMs 默认真实值）',
    '按任务要求只做小规模；第 14c 项用 maxAgeMs:0 覆盖「超龄即回收」分支');

  let G = null; // 大文件夹具（B 段共享）

  try {
    // ======================= A. 块数学（纯函数，无 I/O） =======================
    console.log('--- A. 块数学（纯函数，无 I/O）---');

    await check(1, 'LINES_PER_BLOCK === LINES_PER_SPARSE * SUB_PER_BLOCK', () => {
      assertEq(overlay.LINES_PER_BLOCK, overlay.LINES_PER_SPARSE * overlay.SUB_PER_BLOCK,
        'LINES_PER_BLOCK 必须等于 LINES_PER_SPARSE*SUB_PER_BLOCK');
      assertEq(overlay.LINES_PER_BLOCK, 100000, 'LINES_PER_BLOCK 应为 10 万行/块');
      assertEq(overlay.LINES_PER_SPARSE, 1000, 'LINES_PER_SPARSE 必须与 lineindex.SPARSE 一致');
      assertEq(overlay.SUB_PER_BLOCK, 100, 'SUB_PER_BLOCK 应为 100');
      return '1000 × 100 = 100000';
    });

    await check(2, 'buildBlocks：块数 = ceil(lines/LINES_PER_BLOCK)，块行数之和 = 总行数，首块 start=0', () => {
      // 自造确定性 starts：starts[i] = (i+1) * 3000（第 i+1 个 1000 行子块的行首）
      const mkStarts = (n) => Array.from({ length: n }, (_, i) => (i + 1) * 3000);
      const cases = [
        { lines: 0, size: 0, endsNL: false, wantBlocks: 1, wantStarts: [], note: '空文件：保留 1 个 0 字节块' },
        { lines: 1, size: 12, endsNL: false, wantBlocks: 1, wantStarts: [], note: '1 行' },
        { lines: 99999, size: 3000 * 99, endsNL: true, wantBlocks: 1, wantStarts: mkStarts(99), note: '差 1 行不满块' },
        { lines: 100000, size: 3000 * 100, endsNL: true, wantBlocks: 1, wantStarts: mkStarts(100), note: '恰好 1 块' },
        { lines: 100001, size: 3000 * 100 + 7, endsNL: true, wantBlocks: 2, wantStarts: mkStarts(100), note: '1 块 + 1 行' },
        { lines: 250000, size: 3000 * 250, endsNL: false, wantBlocks: 3, wantStarts: mkStarts(250), note: '2 满块 + 半块' },
      ];
      const summary = [];
      for (const c of cases) {
        const b = F.buildBlocks({ lines: c.lines, size: c.size, starts: c.wantStarts, endsNL: c.endsNL });
        assertEq(b.length, c.wantBlocks, `buildBlocks(${c.note}, lines=${c.lines}) 块数`);
        // 块数公式（lines>0 时成立）
        if (c.lines > 0) {
          assertEq(Math.ceil(c.lines / overlay.LINES_PER_BLOCK), c.wantBlocks,
            `用例自身口径错：ceil(${c.lines}/100000) 应等于 ${c.wantBlocks}`);
        } else {
          // lines=0 是公式唯一的例外：块表始终非空（否则 splice 无处落笔）
          assertEq(Math.ceil(0 / overlay.LINES_PER_BLOCK), 0, '空文件按公式是 0 块');
          assertEq(b.length, 1, '空文件仍保留 1 个 0 字节块（overlay.js:150-153 的显式例外）');
          assertEq(b[0].bytes, 0, '空块 0 字节');
          assertEq(b[0].lines, 0, '空块 0 行');
          assertEq(b[0].endsNL, false, '空块 endsNL=false');
        }
        let sum = 0;
        for (let i = 0; i < b.length; i++) {
          sum += b[i].lines;
          assertEq(b[i].kind, 'file', `第 ${i} 块 kind（未编辑的块必须留在原文件里）`);
          assertEq(b[i].lines, Math.min(100000, c.lines - i * 100000), `第 ${i} 块行数`);
        }
        assertEq(sum, c.lines, `块行数之和（${c.note}）`);
        assertEq(b[0].start, 0, `首块起始字节（${c.note}）`);
        let bsum = 0;
        for (let i = 0; i < b.length; i++) bsum += b[i].bytes;
        assertEq(bsum, Math.max(0, c.size), `块字节之和（${c.note}）必须等于文件大小`);
        if (b.length > 1) {
          assertEq(b[1].start, c.wantStarts[99], `第 1 块 start 必须取 starts[99]（${c.note}）`);
        }
        // endsNL：只有末块可能「末尾无换行」
        assertEq(b[b.length - 1].endsNL, c.endsNL, `末块 endsNL（${c.note}）`);
        for (let i = 0; i + 1 < b.length; i++) {
          assertEq(b[i].endsNL, true, `非末块 endsNL 必须为 true（第 ${i} 块，${c.note}）`);
        }
        summary.push(`${c.lines}行→${b.length}块`);
      }
      return summary.join(' / ');
    });

    await check(3, 'blockStartByte：b=0 → 0；b>0 取 starts[b*SUB_PER_BLOCK-1]（自造确定性 starts，不依赖真实文件）', () => {
      // starts[i] = (i+1)*1000 → 条目值与下标一对一可校验（不靠猜）
      const starts = Array.from({ length: 300 }, (_, i) => (i + 1) * 1000);
      const base = { starts };
      assertEq(F.blockStartByte(base, 0), 0, 'b=0 必须返回 0（块 0 首行即文件首字节）');
      assertEq(F.blockStartByte(base, -1), 0, 'b<0 退化为 0');
      assertEq(F.blockStartByte(base, 1), starts[1 * 100 - 1], 'b=1 → starts[99]（第 100 个稀疏条目）');
      assertEq(F.blockStartByte(base, 1), 100 * 1000, 'starts[99] 的值 = 100000（显式核对下标 99）');
      assertEq(F.blockStartByte(base, 2), starts[199], 'b=2 → starts[199]');
      assertEq(F.blockStartByte(base, 2), 200 * 1000, 'starts[199] 的值 = 200000');
      assertEq(F.blockStartByte(base, 3), starts[299], 'b=3 → starts[299]');
      assertEq(F.blockStartByte(base, 3), 300 * 1000, 'starts[299] 的值 = 300000');
      assertEq(F.blockStartByte({}, 0), 0, '空 base 的 b=0 仍返回 0');
      // starts 不完整必须抛错（不许静默给 0 / NaN）
      let thrown = null;
      try { F.blockStartByte({ starts }, 4); } catch (e) { thrown = String(e.message); }
      assertEq(thrown, '行索引稀疏表不完整：缺少 starts[399]（无法建立第 4 块边界）',
        'starts[399] 缺失时必须抛错，且文案逐字核对');
      assertEq(F.blockStartByte({ starts: [7] }, 0), 0, '只有 1 个条目的 base，b=0 仍返回 0');
      return 'starts[99]/[199]/[299] 精确命中 + 缺项抛错（文案逐字核对）';
    });

    await check(4, 'findBlock / blockAtByte / blockToLine：边界与退化输入逐个核对（不返回 NaN）', () => {
      // 3 块：10 万 / 10 万 / 5 万行；字节 1000 / 1000 / 500
      const blocks = [
        { kind: 'file', start: 0, bytes: 1000, lines: 100000, endsNL: true },
        { kind: 'file', start: 1000, bytes: 1000, lines: 100000, endsNL: true },
        { kind: 'file', start: 2000, bytes: 500, lines: 50000, endsNL: false },
      ];
      const { cums, cumBytes } = F.rebuildPrefix(blocks);
      assertEq(cums.length, 4, 'cums 长度 = 块数 + 1');
      assertDeep([...cums], [0, 100000, 200000, 250000], '行前缀和');
      assertDeep([...cumBytes], [0, 1000, 2000, 2500], '字节前缀和');
      assertTrue(cums instanceof Float64Array, 'cums 必须是 Float64Array');
      assertTrue(cumBytes instanceof Float64Array, 'cumBytes 必须是 Float64Array');

      // findBlock：cums 下标即块；行号 1 基
      const fb = [
        [1, 0, 'line=1（文档首行）'],
        [100000, 0, 'line=100000（块 0 末行）'],
        [100001, 1, 'line=100001（块 1 首行）'],
        [200000, 1, 'line=200000（块 1 末行）'],
        [200001, 2, 'line=200001（块 2 首行）'],
        [250000, 2, 'line=250000（文档末行）'],
        [250001, 2, 'line 超出总量 → 末块'],
        [99999999, 2, 'line 远超总量 → 末块'],
        [0, 0, 'line=0（退化）→ 块 0'],
        [-5, 0, 'line=-5（退化）→ 块 0'],
      ];
      for (const [line, want, note] of fb) {
        assertEq(F.findBlock(cums, line), want, `findBlock(${note})`);
      }
      assertEq(F.findBlock(new Float64Array(0), 1), 0, '空 cums → 0（不 NaN）');
      assertEq(F.findBlock(new Float64Array(1), 7), 0, '仅 1 项 cums → 0');

      // blockAtByte：cumBytes 前缀，off 语义 = 虚拟字节偏移
      const ba = [
        [0, 0, 'off=0（文档首字节）'],
        [1, 0, 'off=1'],
        [999, 0, '块 0 末字节'],
        [1000, 1, '恰好在块 1 首字节（cumBytes[1]）'],
        [1001, 1, 'off=1001'],
        [1999, 1, '块 1 末字节'],
        [2000, 2, '恰好在块 2 首字节'],
        [2499, 2, '文档末字节'],
        [2500, 2, 'off == 总字节 → 末块'],
        [2501, 2, 'off 超界 → 末块'],
        [1e12, 2, 'off 极大 → 末块'],
        [-1, 0, 'off=-1（退化）→ 块 0'],
      ];
      for (const [off, want, note] of ba) {
        assertEq(F.blockAtByte(cumBytes, off), want, `blockAtByte(${note})`);
      }
      assertEq(F.blockAtByte(new Float64Array(0), 5), 0, '空 cumBytes → 0（不 NaN）');
      assertEq(F.blockAtByte(new Float64Array(1), 5), 0, '仅 1 项 cumBytes → 0');

      // blockToLine：块首行号（1 基）
      assertEq(F.blockToLine(cums, 0), 1, '块 0 首行 = 1');
      assertEq(F.blockToLine(cums, 1), 100001, '块 1 首行 = 100001');
      assertEq(F.blockToLine(cums, 2), 200001, '块 2 首行 = 200001');
      assertEq(F.blockToLine(cums, 3), 200001, '块号越界 → clamp 到末块');
      assertEq(F.blockToLine(cums, -1), 1, '块号 -1 → clamp 到 0');
      assertEq(F.blockToLine(cums, NaN), 1, '块号 NaN → 0（num 兜底 0）');
      assertEq(F.blockToLine(new Float64Array(0), 0), 1, '空 cums → 1（不 NaN）');
      // 互逆性：块首行 → 块号
      for (let b = 0; b < 3; b++) {
        assertEq(F.findBlock(cums, F.blockToLine(cums, b)), b, `findBlock(blockToLine(${b})) 互逆`);
      }
      return `findBlock ${fb.length} 例 / blockAtByte ${ba.length} 例 / blockToLine 8 例`;
    });

    await check(5, "splitBlockText + joinBlockText 往返一致（'a\\nb\\nc\\n' / 无尾换行 / 单行 / 空串）", () => {
      const cases = [
        { text: 'a\nb\nc\n', endsNL: true, want: ['a', 'b', 'c'], note: '尾换行是行终止符，不产生额外空行' },
        { text: 'a\nb\nc', endsNL: false, want: ['a', 'b', 'c'], note: '无尾换行' },
        { text: 'one', endsNL: false, want: ['one'], note: '单行无尾换行' },
        { text: 'one\n', endsNL: true, want: ['one'], note: '单行带尾换行' },
        { text: '', endsNL: false, want: [], note: '空串' },
        { text: '\n', endsNL: true, want: [''], note: '仅一个换行 = 1 个空行' },
        { text: 'a\r\nb\r\n', endsNL: true, want: ['a\r', 'b\r'], note: 'CRLF 不做 EOL 归一化（\\r 留在行尾）' },
        { text: 'x\n\ny\n', endsNL: true, want: ['x', '', 'y'], note: '中间空行保留' },
      ];
      const got = [];
      for (const c of cases) {
        const segs = F.splitBlockText(c.text, c.endsNL);
        assertDeep(segs, c.want, `splitBlockText(${raw(c.text)}, ${c.endsNL}) —— ${c.note}`);
        assertEq(segs.length, c.want.length, `行数（${c.note}）`);
        const back = F.joinBlockText(segs, c.endsNL);
        assertEq(back, c.text, `往返 joinBlockText(splitBlockText(...)) 必须逐字符相同（${c.note}）`);
        got.push(`${raw(c.text)}→${segs.length}行`);
      }
      // 退化输入
      assertDeep(F.splitBlockText(null, false), [], 'splitBlockText(null) → []');
      assertDeep(F.splitBlockText(undefined, true), [], 'splitBlockText(undefined) → []');
      assertEq(F.joinBlockText([], true), '', 'joinBlockText([], true) → 空串（空数组不产生换行）');
      assertEq(F.joinBlockText([], false), '', 'joinBlockText([], false) → 空串');
      assertEq(F.joinBlockText(['a', 'b'], false), 'a\nb', 'joinBlockText 无尾换行');
      assertEq(F.joinBlockText(['a', 'b'], true), 'a\nb\n', 'joinBlockText 带尾换行');
      assertEq(F.joinBlockText([''], false), '', 'joinBlockText([""]) → 空串（1 个空行 = 0 字节）');
      assertEq(F.joinBlockText([''], true), '\n', 'joinBlockText([""], true) → "\\n"（1 个空行有换行）');
      assertEq(F.joinBlockText(['a', null, 'b'], false), 'a\n\nb', 'null 元素按空行处理');
      assertEq(F.joinBlockText('nope', false), '', '非数组 → 空串');
      assertEq(F.splitBlockText('a\nb', false).length, 2, '无尾换行 2 行');
      return `${cases.length} 组往返一致 + 10 例退化输入`;
    });

    await check(6, 'checkEditable：正常 / binary / 非 UTF-8 / 单块超 32MiB / 空块表 五种判定', () => {
      const ok = [{ kind: 'file', start: 0, bytes: 1024, lines: 10, endsNL: true }];
      const r1 = F.checkEditable({ encoding: 'utf-8' }, ok);
      assertDeep(r1, { editable: true }, '正常 UTF-8 非二进制 → {editable:true}（形状逐字核对）');

      const r2 = F.checkEditable({ encoding: 'utf-8', binary: true }, ok);
      assertEq(r2.editable, false, 'binary → editable:false');
      assertTrue(typeof r2.reason === 'string' && r2.reason.length > 0, 'binary → reason 必须是非空字符串');
      assertDeep(r2, {
        editable: false,
        reason: '二进制内容（含 NUL 字节，按文本近似显示），暂不支持编辑',
      }, 'binary 分支形状逐字核对');

      const r3 = F.checkEditable({ encoding: 'GBK' }, ok); // 大小写混合：内部 toLowerCase 后判 gbk
      assertEq(r3.editable, false, 'encoding=GBK → editable:false');
      assertDeep(r3, {
        editable: false,
        reason: '该文件为 GBK 编码，暂不支持大文件编辑（Node 无 GBK 编码器，保存会产生混合编码）',
      }, 'GBK 分支形状逐字核对（Node 无 GBK 编码器）');
      const r3b = F.checkEditable({ encoding: 'utf-16le' }, ok);
      assertDeep(r3b, {
        editable: false,
        reason: '该文件编码为 utf-16le，暂不支持大文件编辑（仅有 UTF-8 编码器）',
      }, '其它编码分支形状逐字核对');
      const r3c = F.checkEditable({}, ok);
      assertDeep(r3c, { editable: true }, 'encoding 缺省按 utf-8 → 可编辑');

      // 32MiB 上限：正常大块临界（=上限，放行）/ 超 1 字节（拒绝）
      const atLimit = [{ kind: 'file', start: 0, bytes: overlay.BLOCK_SOFT_MAX_BYTES, lines: 1, endsNL: false }];
      assertDeep(F.checkEditable({ encoding: 'utf-8' }, atLimit), { editable: true },
        '恰好在 32MiB 上限（不 > ）→ 放行');
      const over = 32 * 1024 * 1024 + 1;
      const r4 = F.checkEditable({ encoding: 'utf-8' }, [
        { kind: 'file', start: 0, bytes: 1024, lines: 10, endsNL: true },
        { kind: 'file', start: 1024, bytes: over, lines: 10, endsNL: true },
      ]);
      assertEq(r4.editable, false, `单块 ${over} 字节（>32MiB）→ editable:false`);
      assertEq(r4.block, 1, '超限块下标必须是 1（取最大块）');
      assertEq(r4.bytes, over, '超限字节数原样回传');
      assertDeep(r4.reason, '单块 32.0MB 超出编辑上限 32MB（行长过大或行数过少，物化会占满内存），暂不支持编辑',
        '超限 reason 逐字核对（这就是「40000 字符超长行 / 稀疏单块」被禁编辑的原因）');

      // 空块表
      assertDeep(F.checkEditable({ encoding: 'utf-8' }, []), { editable: false, reason: '块表为空，无法编辑' },
        '空块表 → editable:false（形状逐字核对）');
      assertDeep(F.checkEditable({ encoding: 'utf-8' }, null), { editable: false, reason: '块表为空，无法编辑' },
        '块表 null → 同空块表');
      assertDeep(F.checkEditable(null, []), { editable: false, reason: '块表为空，无法编辑' },
        'base=null 时仍走块表分支（encoding 兜底 utf-8）');
      return '5 种判定 + 32MiB 临界 + 3 例退化输入，形状逐字核对';
    });

    await check(7, 'docKey：同 size+mtime → 同 key；size / mtime / version 任一变化 → 不同 key', () => {
      const f = path.join(root, 'k.txt');
      const stat = { size: 12345, mtimeMs: 1700000000123 };
      const k0 = F.docKey(f, stat);
      assertEq(k0.length, 40, 'sha1 十六进制 40 字符');
      assertTrue(/^[0-9a-f]{40}$/.test(k0), 'docKey 必须是 40 位小写 hex');
      assertEq(F.docKey(f, stat), k0, '同参数 → 同 key');
      assertEq(F.docKey(f, { size: 12345, mtimeMs: 1700000000123 }), k0, '同参数（新对象）→ 同 key');
      assertEq(F.docKey(f, { size: 12345, mtimeMs: 1700000000123.7 }), k0,
        'mtime 取 floor → 小数部分不影响 key');
      const kSize = F.docKey(f, { size: 12346, mtimeMs: 1700000000123 });
      const kMtime = F.docKey(f, { size: 12345, mtimeMs: 1700000000124 });
      const kVer = F.docKey(f, stat, overlay.OVL_VERSION + 1);
      const kPath = F.docKey(path.join(root, 'k2.txt'), stat);
      for (const [label, k] of [['size+1', kSize], ['mtime+1ms', kMtime],
        ['version+1', kVer], ['路径不同', kPath]]) {
        assertTrue(k !== k0, `${label} 必须产生不同 key（实际与基准相同：${k}）`);
      }
      assertEq(F.docKey(f, {}), F.docKey(f, { size: 0, mtimeMs: 0 }), 'stat 缺省 → 0/0');
      // 真实文件：stat 直接喂进去（生产口径）
      fs.writeFileSync(f, 'hello');
      const st = fs.statSync(f);
      const kReal = F.docKey(f, st);
      assertEq(kReal, F.docKey(f, { size: st.size, mtimeMs: st.mtimeMs }), '真实 stat 与手工 stat 同 key');
      assertEq(F.docKey(f, st).length, 40, '真实文件 key 长度');
      return `k0=${k0.slice(0, 12)}… 4 种扰动全部换 key`;
    });

    await check(8, 'makeBase / normalizeBase 错误面：索引不完整就不许编辑（守门）', async () => {
      const f = path.join(root, 'base.txt');
      // 8a：lines > 0 但 size === 0
      const m1 = await assertThrows(() => F.makeBase({ file: f, index: { lines: 5, starts: [], bytes: 0 } }),
        null, 'makeBase(lines=5, size=0) 必须抛错');
      assertEq(m1, '行索引与文件大小不一致（lines>0 但 size=0），请重建索引', '抛错文案逐字核对');
      // 8b：lines > LINES_PER_BLOCK 但 starts 为空（huge:index 的 IPC 返回值已剥离 starts）
      const m2 = await assertThrows(() => F.makeBase({
        file: f, stat: { size: 1e6, mtimeMs: 1 }, index: { lines: 100001, starts: [], bytes: 1e6 },
      }), null, 'makeBase(lines=100001, starts=[]) 必须抛错');
      assertEq(m2, '行索引缺少 starts（huge:index 的 IPC 返回值已剥离 starts，请传 require("./lineindex").getIndex(file) 的进程内结果）',
        '抛错文案逐字核对');
      // 恰好 10 万行（=1 块）不拦：小文件稀疏表本来就是空的
      const b1 = F.makeBase({ file: f, stat: { size: 1e6, mtimeMs: 7 }, index: { lines: 100000, starts: [], bytes: 1e6 }, endsNL: true });
      assertEq(b1.lines, 100000, '恰好 1 块行数不因缺 starts 被拦');
      assertDeep(b1.starts, [], '确无 starts');
      assertEq(b1.key, null, 'makeBase 不设 key（createDoc 才落 key）');
      assertEq(F.makeBase({ file: f, stat: { size: 12, mtimeMs: 3 }, index: { lines: 1, starts: [], bytes: 12 }, endsNL: false }).size, 12, 'size 取自 stat');
      // 其它守门
      assertEq(await assertThrows(() => F.makeBase({}), null, 'makeBase 缺 file 必须抛错'),
        'makeBase 需要 file', '抛错文案逐字核对');
      assertEq(await assertThrows(() => F.normalizeBase(null), null, 'normalizeBase(null) 必须抛错'),
        'createDoc 需要 base.file（请用 openDoc 或 makeBase 组装）', '抛错文案逐字核对');
      assertEq(await assertThrows(() => F.normalizeBase({ file: f, lines: 3, size: 30 }), null,
        'normalizeBase 缺 endsNL 必须抛错（行数口径依赖它）'),
      'base.endsNL 缺失（末尾是否以换行结束）：请用 openDoc 打开，或显式给出该标志', '抛错文案逐字核对');
      const nb = F.normalizeBase({ file: f, lines: 3, size: 30, endsNL: true });
      assertEq(nb.bytes, 30, 'normalizeBase 让 bytes = size');
      assertDeep(nb.starts, [], 'normalizeBase starts 兜底空数组');
      assertEq(nb.encoding, undefined, 'normalizeBase 不改写 encoding（undefined 原样）');
      assertEq(await assertThrows(() => F.normalizeBase({ file: f, lines: 100001, size: 1e6, starts: [], endsNL: true }),
        null, 'normalizeBase 对缺 starts 的大文件同样守门'),
      '行索引缺少 starts（huge:index 的 IPC 返回值已剥离 starts，请传 require("./lineindex").getIndex(file) 的进程内结果）',
      '抛错文案逐字核对');
      return '5 例必须抛错（文案逐字核对）+ 3 例边界放行';
    });

    // ======================= B. 真实文件往返 =======================
    console.log('');
    console.log('--- B. 真实文件往返（自造确定性大文件）---');

    // 造文件 + 自造索引（B 段全部共享）
    const fx = makeLines();
    const tGen = Date.now();
    await writeLinesFile(mainFile, fx.lines);
    const idxSelf = await buildIndexLikeLineindex(mainFile);
    const srcSha0 = await fileSha1(mainFile);
    G = {
      lines: fx.lines, offsets: fx.offsets, size: fx.size,
      idxSelf, srcSha0, genMs: Date.now() - tGen, io, mainFile, outFile, root,
      doc: null,
    };
    const MB = (n) => (n / 1048576).toFixed(2) + 'MB';
    console.log(`[fixture] ${mainFile}`);
    console.log(`[fixture] ${LINE_COUNT} 行 × ${LINE_LEN} 字节 · ${MB(fx.size)} · sha1=${srcSha0.slice(0, 12)}…`
      + ` · starts=${idxSelf.starts.length} · 造文件+索引 ${G.genMs}ms`);
    assertEq(fs.statSync(mainFile).size, fx.size, '夹具文件字节数必须等于自算期望值');
    assertEq(fx.size, LINE_COUNT * (LINE_LEN + 1) - 1, '夹具大小 = 行数×(行长+换行) - 末行换行');
    assertEq(idxSelf.lines, LINE_COUNT, '自造索引行数必须等于生成行数');
    assertEq(idxSelf.starts.length, 104,
      '自造索引稀疏条目数 = floor(105000/1000) - 1 = 104（第 105000 行之后没有「下一行行首」可记）');
    assertEq(idxSelf.starts[99], 100000 * (LINE_LEN + 1), 'starts[99] = 第 100001 行行首 = 块 1 首字节');
    assertEq(idxSelf.starts[99], fx.offsets[100000], 'starts[99] 与生成时记录的行首一致');
    assertEq(idxSelf.binary, false, '夹具非二进制');
    assertTrue(fx.size < 32 * 1024 * 1024, '夹具必须 <32MiB（单块软上限内）');
    // 行号换算：插入段占第 2..4 行 → 「插入后文档第 n 行」= 源文件第 (n-3) 行（n ≥ 5 时）
    // 1 基源行号 r ↔ fx.lines[r-1]（0 基）→ INSROW(n) = fx.lines[n-4]
    const OLDROW = (i) => fx.lines[i - 1];
    const INSROW = (n) => fx.lines[n - 4];

    await check(9, 'openDoc：行数一致 + readLineText 逐字节等于源文件（含跨块行/首行/末行）', async () => {
      const doc = await F.openDoc({ file: mainFile, index: idxSelf, io, id: 1 });
      G.doc = doc;
      assertEq(doc.lines(), LINE_COUNT, 'doc.lines() 必须等于生成行数');
      assertEq(doc.bytes(), fx.size, 'doc.bytes() 必须等于文件字节数');
      assertEq(doc.endsWithNL(), false, '夹具末尾无换行 → endsWithNL()=false');
      const bs = doc.blocks();
      assertEq(bs.length, 2, '105000 行 → 2 块');
      assertEq(bs[0].lines, 100000, '块 0 = 10 万行');
      assertEq(bs[1].lines, 5000, '块 1 = 5000 行');
      assertEq(bs[0].start, 0, '块 0 start=0');
      assertEq(bs[1].start, idxSelf.starts[99], '块 1 start = starts[99]（块首字节推导，零额外 IO）');
      assertEq(bs[0].bytes, 100000 * (LINE_LEN + 1), '块 0 字节 = 相邻块首之差');
      assertEq(bs[1].bytes, fx.size - bs[0].bytes, '块 1 字节 = 文件末尾 - 块 1 首字节');
      assertEq(bs[0].bytes + bs[1].bytes, fx.size, '块字节之和 = 文件大小');
      assertEq(bs[0].endsNL, true, '非末块 endsNL=true（块边界即行首）');
      assertEq(bs[1].endsNL, false, '末块 endsNL=false（末尾无换行）');
      assertDeep(doc.editable, { editable: true }, '干净大文件可编辑');
      assertEq(doc.dirtyCount(), 0, '初始 dirtyCount=0');
      assertEq(doc.undoDepth(), 0, '初始 undoDepth=0');
      assertEq(doc.canUndo(), false, '初始 canUndo=false');
      assertEq(doc.canRedo(), false, '初始 canRedo=false');
      assertEq(await doc.overlayFileBytes(), 0, '未编辑时 overlay 物理文件不存在（0 字节）');

      // 抽行：首行/次行/块内中部/块 0 末行/块 1 首行/末行 —— 与源文件对应字节逐字节比对
      const probes = [1, 2, 50000, 100000, 100001, LINE_COUNT];
      for (const n of probes) {
        const got = await doc.readLineText(n);
        const want = await readRange(mainFile, fx.offsets[n - 1], LINE_LEN);
        assertBufEq(Buffer.from(got, 'utf8'), want, `第 ${n} 行 readLineText 与源文件字节级一致`);
        assertEq(got, fx.lines[n - 1], `第 ${n} 行文本精确相等`);
        assertEq(got.length, LINE_LEN, `第 ${n} 行长度 = ${LINE_LEN}`);
      }
      assertEq(await doc.readLineText(LINE_COUNT + 5), fx.lines[LINE_COUNT - 1],
        '越界行号 clamp 到末行（与 lineindex 口径一致）');
      assertEq(await doc.readLineText(0), fx.lines[0], '行号 0 clamp 到首行');

      // 行号 ↔ 偏移互转（lineindex.lineToOffset 同口径）
      for (const n of [1, 999, 100000, 100001, LINE_COUNT]) {
        const lo = await doc.lineOffset(n);
        assertEq(lo.offset, fx.offsets[n - 1], `第 ${n} 行 lineOffset 与生成时记录的行首一致`);
        assertEq(lo.line, n, `lineOffset(${n}).line 回显`);
        const back = await doc.offsetLine(lo.offset);
        assertEq(back.line, n, `offsetLine(lineOffset(${n})) 行号互逆`);
      }
      const loB = await doc.lineOffset(100001);
      assertEq(loB.block, 1, 'lineOffset(100001).block = 1（跨块首行）');
      assertEq(loB.offset, idxSelf.starts[99], 'lineOffset(100001).offset = starts[99]');
      assertEq((await doc.offsetLine(idxSelf.starts[99])).block, 1, 'offsetLine(starts[99]).block = 1');
      assertEq((await doc.offsetLine(0)).line, 1, 'offsetLine(0).line = 1');
      assertEq((await doc.offsetLine(fx.size)).eof, true, 'offsetLine(文件末尾).eof = true');

      // readLines 批量（跨块一批 + 块边界两行各自成批）
      const batch = await doc.readLines(100001, 3);
      assertEq(batch.lines.length, 3, 'readLines(100001,3) 返回 3 行');
      assertEq(batch.lines[0].line, 100001, 'readLines 首项行号');
      assertEq(batch.lines[0].text, fx.lines[100000], 'readLines 跨块首行文本');
      assertEq(batch.lines[2].text, fx.lines[100002], 'readLines 第三行文本');
      assertEq(batch.encoding, 'utf-8', 'readLines.encoding 回传 base.encoding');
      assertEq(batch.docId, 1, 'readLines.docId 回传注入的 id');
      assertEq((await doc.readLines(100000, 2)).lines[1].text, fx.lines[100000],
        'readLines 一次跨块边界（块 0 末行 + 块 1 首行）');
      assertEq(batch.truncated, undefined, '返回值不含意外字段');
      // 乱序抽行（缓存与读窗口切换）
      for (const n of [LINE_COUNT, 1, 100000, 3, 100001, 50000]) {
        assertEq(await doc.readLineText(n), fx.lines[n - 1], `乱序读取第 ${n} 行仍精确`);
      }
      return `2 块 / ${LINE_COUNT} 行 / ${MB(fx.size)} / 抽行 ${probes.length + 6} 次字节级一致`;
    });

    await check(10, 'spliceLines 插 3 行：行数+3 / isDirty / dirtyCount / undoDepth=1 / 磁盘文件字节完全未变', async () => {
      const doc = G.doc;
      const before = doc.lines();
      const r = await doc.spliceLines(2, 0, ['INS-a', 'INS-b', 'INS-c']);
      // 先固化状态供后续项使用（断言抛错时不至于让下一项读到 undefined）
      G.nAfterInsert = doc.lines();
      G.snapBytesAfterInsert = doc.bytes();
      G.dirtyBlocksAfterInsert = doc.dirtyBlocks();
      G.insertSummary = { from: r.from, deleteCount: r.deleteCount, inserted: r.inserted };
      assertEq(r.deleteCount, 0, 'splice 摘要 deleteCount=0（纯插入）');
      assertEq(r.inserted, 3, 'splice 摘要 inserted=3');
      assertEq(r.from, 2, 'splice 摘要 from=2');
      assertEq(r.lines, before + 3, '摘要 lines = 原行数 + 3');
      assertEq(doc.lines(), before + 3, 'doc.lines() = 原行数 + 3');
      assertEq(r.bytes, G.size + Buffer.byteLength('INS-a\nINS-b\nINS-c\n', 'utf8'),
        '摘要 bytes = 原字节 + 插入段字节');
      assertEq(r.dirty, true, '摘要 dirty=true');
      assertEq(r.dirtyCount, 1, '摘要 dirtyCount=1');
      assertEq(doc.isDirty(), true, 'isDirty()=true（块表里出现 overlay 块）');
      assertEq(doc.dirtyCount(), 1, 'dirtyCount=1（1 处未保存修改）');
      assertEq(doc.undoDepth(), 1, 'undoDepth=1');
      assertEq(doc.redoDepth(), 0, 'redoDepth=0（新编辑清空重做栈）');
      assertEq(doc.canUndo(), true, 'canUndo=true');
      assertEq(doc.canRedo(), false, 'canRedo=false');
      assertEq(doc.chunkCount(), doc.dirtyBlocks(), '分片数 = overlay 块数（每分片一块）');
      assertEq(doc.dirtyBlocks() >= 1, true, '至少 1 个 overlay 块');
      const regions = doc.regions();
      assertEq(regions.length, 1, '脏区域数 1（连续 overlay 块算一处）');
      assertEq(regions[0].from, 0, '脏区域从块 0 起（编辑落在块 0）');
      // 区域跨度 = 脏块总数（分片数随「1000 行 / 4MB」切分口径变化，故按不变量断言而非硬编码块号）
      assertEq(regions[0].to - regions[0].from + 1, doc.dirtyBlocks(),
        '脏区域跨度覆盖全部 overlay 块（区域计数口径：连续脏块 = 1 处）');
      assertEq(doc.blocks()[regions[0].to].kind, 'overlay', '脏区域末块确为 overlay 块');
      // 编辑只落在块 0，但实现按「1000 行 / 4MB」把整块重新切片 → 块 0 被替换成 100 个 overlay 分片，
      // 文档尾部不足一块的残余仍是 file 块（未触及的区域继续留在原文件里）
      assertEq(doc.blocks()[doc.blocks().length - 1].kind, 'file',
        '文档末尾未触及的尾块仍是 file 块（CoW：未改动内容不被物化）');
      assertEq(doc.blocks().reduce((n, b) => n + b.bytes, 0), doc.bytes(), '块字节之和 = 文档虚拟字节数');

      // 内容核对：插入段就位（第 1 行未受影响）、原行整体后移 3
      assertEq(await doc.readLineText(1), OLDROW(1), '第 1 行未受影响');
      assertEq(await doc.readLineText(2), 'INS-a', '插入段第 1 行');
      assertEq(await doc.readLineText(3), 'INS-b', '插入段第 2 行');
      assertEq(await doc.readLineText(4), 'INS-c', '插入段第 3 行');
      assertEq(await doc.readLineText(5), OLDROW(2), '原第 2 行 → 第 5 行');
      assertEq(await doc.readLineText(100003), OLDROW(100000), '原行 100000 → 100003（块 0 末行）');
      assertEq(await doc.readLineText(100004), OLDROW(100001), '原行 100001（块 1 首行）→ 100004');
      assertEq(await doc.readLineText(before + 3), OLDROW(LINE_COUNT), '末行仍是源文件末行');

      // 磁盘文件字节完全未变（sha1 + 大小 + 逐段抽样三重比对）
      assertEq(await fileSha1(G.mainFile), G.srcSha0, '编辑后源文件 sha1 必须完全未变');
      assertEq(fs.statSync(G.mainFile).size, G.size, '编辑后源文件大小必须完全未变');
      assertBufEq(await readRange(G.mainFile, 0, LINE_LEN), Buffer.from(G.lines[0], 'utf8'),
        '编辑后源文件首行字节未变');
      assertBufEq(await readRange(G.mainFile, G.offsets[100000], LINE_LEN), Buffer.from(G.lines[100000], 'utf8'),
        '编辑后源文件块 1 首行字节未变');

      const insp = await doc.inspect();
      assertEq(insp.baseChanged, false, 'inspect().baseChanged=false（源文件未被外部修改）');
      assertEq(insp.dirty, true, 'inspect().dirty=true');
      assertEq(insp.lines, before + 3, 'inspect().lines');
      assertEq(insp.blocks, doc.blocks().length, 'inspect().blocks 与块表一致');
      assertEq(insp.editable, true, 'inspect().editable');
      assertEq(insp.undoDepth, 1, 'inspect().undoDepth=1');
      assertEq(insp.endsNL, false, 'inspect().endsNL 保持 false（未触及文档末尾）');

      // 撤销/重做往返
      assertEq(doc.undo(), true, 'undo() 返回 true');
      assertEq(doc.lines(), before, 'undo 后行数复原');
      assertEq(await doc.readLineText(1), OLDROW(1), 'undo 后第 1 行复原');
      assertEq(await doc.readLineText(2), OLDROW(2), 'undo 后第 2 行复原');
      assertEq(await doc.readLineText(100003), OLDROW(100003), 'undo 后行号重新对齐（第 100003 行 = 源行 100003）');
      assertEq(await doc.readLineText(100001), OLDROW(100001), 'undo 后块 1 首行回到 100001');
      assertEq(doc.isDirty(), false, 'undo 后 isDirty()=false');
      assertEq(doc.dirtyCount(), 0, 'undo 后 dirtyCount=0');
      assertEq(doc.canRedo(), true, 'undo 后 canRedo=true');
      assertEq(doc.redo(), true, 'redo() 返回 true');
      assertEq(doc.lines(), before + 3, 'redo 后回到插入后行数');
      assertEq(await doc.readLineText(2), 'INS-a', 'redo 后插入段仍在原位');
      assertEq(await fileSha1(G.mainFile), G.srcSha0, '全程源文件 sha1 未变');
      G.nAfterInsert = doc.lines();
      G.snapBytesAfterInsert = doc.bytes();
      return `+3 行 → ${doc.lines()} 行；overlay 分片 ${doc.dirtyBlocks()} 个；源文件 sha1 未变`;
    });

    await check(11, 'deleteRange 删 5 行（行区间合并）：内容符合预期；undo 完全复原 + canRedo；redo 回到删除后状态', async () => {
      const doc = G.doc;
      const before = doc.lines();
      // 先取「删除前」的头尾行文本，用它算出可预期的合并结果（只依赖文档自身视图，不猜行号映射）
      const head = await doc.readLineText(9);
      assertEq(head, INSROW(9), '删前第 9 行 = 源文件第 7 行（文档行号 = 源行号 + 2）');
      const tail = await doc.readLineText(13);
      assertEq(tail, INSROW(13), '删前第 13 行 = 源文件第 11 行');
      const expectMerged = head.slice(0, 5) + tail.slice(5);
      assertEq(expectMerged.length, LINE_LEN, '合并行长度 = 头前缀 5 + 尾后缀 111 = 116');
      const rowBefore8 = await doc.readLineText(8);
      const rowBefore14 = await doc.readLineText(14);
      const insLine1 = await doc.readLineText(1);
      const insLine2 = await doc.readLineText(2);
      assertEq(insLine1, OLDROW(1), '删前第 1 行 = 源文件第 1 行');
      assertEq(insLine2, 'INS-a', '删前第 2 行 = 插入段（第 10 项插入的 3 行仍在）');

      const r = await doc.deleteRange(9, 5, 13, 5);
      G.expectMerged = expectMerged;
      G.nAfterDelete = doc.lines();
      G.bytesAfterDelete = doc.bytes();
      assertEq(r.from, 9, 'deleteRange 摘要 from=9');
      assertEq(r.deleteCount, 5, 'deleteRange 摘要 deleteCount=5（行区间 9..13）');
      assertEq(r.inserted, 1, 'deleteRange 摘要 inserted=1（首尾行合并成一行）');
      assertEq(r.lines, before - 4, '摘要 lines = 原行数 - 4（删 5 行合并为 1 行 = 净减 4）');
      assertEq(doc.lines(), before - 4, 'doc.lines() 净减 4：删除 N 行合并成 1 行 → 行数 -(N-1)');
      assertEq(doc.lines(), G.nAfterDelete, '先固化的 G.nAfterDelete 与实测一致');
      assertEq(await doc.readLineText(9), expectMerged, '合并行 = 头行前 5 字符 + 尾行第 5 字符起');
      assertEq((await doc.readLineText(9)).length, LINE_LEN, '合并行行长保持 116');
      assertEq(await doc.readLineText(8), rowBefore8, '合并行前一行未受影响');
      assertEq(await doc.readLineText(10), rowBefore14, '被删区间之后的行前移 4 位');
      assertEq(await doc.readLineText(1), insLine1, '第 1 行（源文件首行）不受影响');
      assertEq(await doc.readLineText(2), insLine2, '第 10 项的插入段仍在（块级撤销栈互不干扰）');
      assertEq(await doc.readLineText(doc.lines()), OLDROW(LINE_COUNT), '末行仍是源文件末行');
      assertEq(doc.dirtyCount(), 1, '两次编辑落在同一区域 → dirtyCount 仍为 1');
      assertEq(doc.undoDepth(), 2, 'undoDepth=2（两次编辑两步）');
      assertEq(await fileSha1(G.mainFile), G.srcSha0, '删除后源文件 sha1 仍未变');

      // undo：完全复原到插入后状态
      assertEq(doc.undo(), true, 'undo() 返回 true');
      assertEq(doc.lines(), before, 'undo 后行数复原');
      assertEq(await doc.readLineText(9), head, 'undo 后第 9 行逐字复原（= 删前头行）');
      assertEq(await doc.readLineText(13), tail, 'undo 后第 13 行逐字复原（= 删前尾行）');
      assertEq(await doc.readLineText(14), rowBefore14, 'undo 后第 14 行逐字复原');
      assertEq(await doc.readLineText(2), insLine2, 'undo 后插入段仍在');
      assertEq(doc.bytes(), G.snapBytesAfterInsert, 'undo 后虚拟字节数复原');
      assertEq(doc.canRedo(), true, 'undo 后 canRedo=true');
      assertEq(doc.redoDepth(), 1, 'redoDepth=1');
      assertEq(doc.undoDepth(), 1, 'undoDepth 回到 1');

      // redo：回到删除后状态
      assertEq(doc.redo(), true, 'redo() 返回 true');
      assertEq(doc.lines(), before - 4, 'redo 后回到删除后行数');
      assertEq(await doc.readLineText(9), expectMerged, 'redo 后合并行恢复');
      assertEq(doc.canRedo(), false, 'redo 后 canRedo=false');
      assertEq(doc.undoDepth(), 2, 'redo 后 undoDepth=2');

      // 多步栈：再撤销两次回到干净文档，再重做两次回来
      assertEq(doc.undo(), true, '再 undo 一次（撤销删除）');
      assertEq(doc.undo(), true, 'undo 到干净状态（撤销插入）');
      assertEq(doc.isDirty(), false, '全部撤销后 isDirty()=false');
      assertEq(doc.dirtyCount(), 0, '全部撤销后 dirtyCount=0');
      assertEq(doc.lines(), LINE_COUNT, '回到原始行数');
      assertEq(doc.bytes(), G.size, '回到原始字节数');
      assertEq(doc.canUndo(), false, 'canUndo=false');
      assertEq(await doc.readLineText(9), OLDROW(9), '干净状态下第 9 行 = 源文件第 9 行');
      assertEq(await fileSha1(G.mainFile), G.srcSha0, '多次编辑/撤销后源文件 sha1 仍未变');
      assertEq(doc.redo(), true, 'redo 第 1 步（插入）');
      assertEq(doc.redo(), true, 'redo 第 2 步（删除）');
      assertEq(doc.lines(), before - 4, '重做到删除后状态');
      assertEq(await doc.readLineText(9), expectMerged, '重做后合并行内容一致');
      return `删 5 行 → 净减 4（合并）→ ${doc.lines()} 行；undo/redo 各 2 步逐字往返一致`;
    });

    await check(12, 'saveTo(第 2 个路径)：目标字节级等于期望内容 / isDirty()=false / 无 .mh-ovl-*.tmp 残留', async () => {
      const doc = G.doc;
      // 期望内容 = 源行数组按 0 基下标施加两次编辑（与文档自身的两步编辑同序）
      const expectLines = G.lines.slice();
      expectLines.splice(1, 0, 'INS-a', 'INS-b', 'INS-c');      // 文档行 2 起插入 3 行（0 基下标 1）
      expectLines.splice(8, 5, G.expectMerged);                 // 插入后文档行 9..13 → 合并为 1 行（0 基下标 8..12）
      assertEq(expectLines.length, G.nAfterDelete, '期望行数 = 第 11 项删除后行数');
      const expectBuf = Buffer.from(expectLines.join('\n'), 'utf8');
      assertEq(expectBuf.length, G.bytesAfterDelete, '期望字节数 = 第 11 项删除后虚拟字节数');
      // 期望文本的关键锚点：直接以「文档视图」为准（比手写下标更可靠）。执行顺序：
      //   ① 文档行 2 起插入 3 行 → 源行 r 落到文档行 r+3（r ≥ 2）
      //   ② 文档行 9..13 区间合并 → 源行 7..10 被吞成 1 行，之后 源行 r 回到文档行 r
      assertEq(expectLines[0], OLDROW(1), '期望首行 = 源文件首行');
      assertEq(expectLines[1], 'INS-a', '期望第 2 行 = 插入段首行');
      assertEq(expectLines[2], 'INS-b', '期望第 3 行 = 插入段第 2 行');
      assertEq(expectLines[3], 'INS-c', '期望第 4 行 = 插入段第 3 行');
      for (const n of [5, 6, 7, 8]) { // 插入后、合并前：文档行 n = 源行 n-3
        assertEq(expectLines[n - 1], INSROW(n), `期望第 ${n} 行 = 源文件第 ${n - 3} 行`);
      }
      assertEq(expectLines[8], G.expectMerged, '期望第 9 行 = 合并行（第 11 项实测 head 前 5 + tail 后 111）');
      // 合并吞掉 5 行 → 1 行 → 之后「文档行 n」= 源文件第 (n+1) 行
      // （实测：doc[10]=src11、doc[11]=src12、doc[12]=src13、doc[13]=src14）
      for (const n of [10, 11, 12, 13]) {
        assertEq(expectLines[n - 1], OLDROW(n + 1), `期望第 ${n} 行 = 源文件第 ${n + 1} 行（合并后行号重新对齐）`);
      }
      for (const n of [1, 2, 5, 9, 10, 12, 13]) {
        assertEq(await doc.readLineText(n), expectLines[n - 1], `第 ${n} 行：期望数组与文档视图逐字一致`);
      }

      const t0 = Date.now();
      const res = await doc.saveTo(G.outFile);
      const ms = Date.now() - t0;
      assertEq(res.ok, true, 'saveTo().ok=true');
      assertEq(res.dirty, false, 'saveTo().dirty=false');
      assertEq(res.target, path.resolve(G.outFile), 'saveTo().target 为解析后的绝对路径');
      assertEq(res.droppedOverlay, true, '保存成功即丢弃旧 overlay（dropKey 命中）');
      assertEq(res.skipped, undefined, '有改动时不得走 skipped 快路径');
      assertEq(res.size, expectBuf.length, 'saveTo().size = 期望字节数');
      assertEq(res.bytes, expectBuf.length, 'saveTo().bytes = 期望字节数');
      assertEq(doc.lines(), expectLines.length, '保存后 doc.lines()');
      assertEq(doc.bytes(), expectBuf.length, '保存后 doc.bytes()');

      assertEq(fs.statSync(G.outFile).size, expectBuf.length, '目标文件大小 = 期望字节数');
      const actual = await fsp.readFile(G.outFile);
      assertBufEq(actual, expectBuf, '目标文件字节级等于期望内容（Buffer.equals，12284549 字节全量比对）');
      assertEq(actual.toString('utf8'), expectLines.join('\n'), '目标文件内容逐字符等于期望文本');
      assertEq(crypto.createHash('sha1').update(actual).digest('hex'),
        crypto.createHash('sha1').update(expectBuf).digest('hex'), '目标文件 sha1 = 期望 sha1');

      // 独立字节证据：按「各行真实长度」累出行首偏移，从保存后的文件里直接读，与文档视图逐字节对照
      // （插入段 5~6 字节、其余 116 字节 → 必须用实际长度累加，不能假设等长）
      const sampleRows = [1, 2, 4, 5, 6, 9, 10, 11, 100, 50000, 100000, 100004, expectLines.length - 1, expectLines.length];
      const rowOffsets = new Map();
      let acc = 0;
      for (let n = 1; n <= expectLines.length; n++) {
        if (sampleRows.includes(n)) rowOffsets.set(n, acc);
        acc += Buffer.byteLength(expectLines[n - 1], 'utf8') + 1;
      }
      assertEq(acc - 1, expectBuf.length, '按行长度累加出的总字节数 = 期望文件字节数');
      for (const n of sampleRows) {
        const docText = await doc.readLineText(n);
        const want = Buffer.from(expectLines[n - 1], 'utf8');
        assertEq(docText, expectLines[n - 1], `保存后第 ${n} 行：文档视图 = 期望文本`);
        const fileBytes = await readRange(G.outFile, rowOffsets.get(n), want.length);
        assertBufEq(fileBytes, want, `保存后第 ${n} 行：文件字节 = 期望字节（偏移 ${rowOffsets.get(n)}）`);
      }

      // 保存后的真实语义（照实断言）
      assertEq(doc.isDirty(), false, '保存后 isDirty()=false（rebase 把块表全部固化为 file 块）');
      assertEq(doc.dirtyCount(), 0, '保存后 dirtyCount=0');
      assertEq(doc.overlayBytes(), 0, '保存后 overlay 逻辑字节 = 0');
      assertEq(await doc.overlayFileBytes(), 0, '保存后 overlay 物理文件字节 = 0（dropKey 已删旧 overlay）');
      assertEq(doc.undoDepth(), 0, '保存后 undoDepth=0（撤销栈随 rebase 清空）');
      assertEq(doc.canUndo(), false, '保存后 canUndo=false');
      assertEq(doc.canRedo(), false, '保存后 canRedo=false');
      assertEq(doc.file, path.resolve(G.outFile), '保存后 doc.file 指向目标（保存路径 = 文档路径）');
      assertEq(doc.base.size, expectBuf.length, 'rebase 后 base.size = 新文件大小');
      assertDeep(doc.base.starts, [], 'rebase 后 starts 清空（新稀疏表由 lineindex 后台重建）');
      assertTrue(doc.blocks().length >= 1 && doc.blocks().every((b) => b.kind === 'file'),
        'rebase 后块表全部是 file 块（保存后即干净文档）');
      assertEq(doc.blocks().reduce((n, b) => n + b.bytes, 0), expectBuf.length, 'rebase 后块字节之和 = 新文件大小');
      assertEq(doc.endsWithNL(), false, '另存为后末块仍无尾换行');
      assertTrue(typeof doc.key === 'string' && /^[0-9a-f]{40}$/.test(doc.key), '保存后 key 仍是 40 位 hex');
      assertEq((await io.usage(doc.key)).exists, false, '新 key 在 overlay 目录没有残留（未编辑即无 overlay）');
      // 保存后的读口径仍正确（块表已固化到新文件，块内定位退化为顺序扫）
      assertEq(await doc.readLineText(1), OLDROW(1), '保存后第 1 行');
      assertEq(await doc.readLineText(2), 'INS-a', '保存后第 2 行 = 插入行');
      assertEq(await doc.readLineText(6), OLDROW(3), '保存后第 6 行 = 源文件第 3 行');
      assertEq(await doc.readLineText(9), G.expectMerged, '保存后第 9 行 = 合并行（保存不改变行号）');
      assertEq(await doc.readLineText(10), OLDROW(11), '保存后第 10 行 = 源文件第 11 行');
      assertEq(await doc.readLineText(doc.lines()), OLDROW(LINE_COUNT), '保存后末行 = 源文件末行');
      assertEq(await doc.readLineText(doc.lines() - 1), OLDROW(LINE_COUNT - 1), '保存后倒数第 2 行 = 源文件倒数第 2 行');

      // 目录内无 .mh-ovl-*.tmp 残留
      const names = await listNames(G.root);
      assertDeep(names.filter((n) => n.includes('.mh-ovl-')), [], '目标目录内不得有 .mh-ovl-*.tmp 残留');
      assertEq(names.includes('big-out.txt'), true, '目标文件存在');
      assertEq(names.includes('big.txt'), true, '源文件仍在');
      assertEq(names.filter((n) => n.endsWith('.tmp')).length, 0, '目录内无任何 .tmp 残留');
      assertEq(await fileSha1(G.mainFile), G.srcSha0, '另存为不得改动源文件');
      assertEq(await fileSha1(G.mainFile), G.srcSha0, '源文件 sha1 二次核对');

      // 保存结果重开：行数/字节/内容不动点（save → reopen 是不动点）
      const doc2 = await F.openDoc({ file: G.outFile, index: await buildIndexLikeLineindex(G.outFile), io, id: 2 });
      assertEq(doc2.lines(), expectLines.length, '重开保存结果：行数不动点');
      assertEq(doc2.bytes(), expectBuf.length, '重开保存结果：字节不动点');
      assertEq(doc2.isDirty(), false, '重开保存结果：干净文档');
      assertEq(doc2.endsWithNL(), false, '重开保存结果：endsNL 不动点');
      assertEq(await doc2.readLineText(1), OLDROW(1), '重开：第 1 行');
      assertEq(await doc2.readLineText(2), 'INS-a', '重开：第 2 行是插入行');
      assertEq(await doc2.readLineText(9), G.expectMerged, '重开：第 9 行是合并行');
      assertEq(await doc2.readLineText(10), OLDROW(11), '重开：第 10 行 = 源文件第 11 行');
      assertEq(await doc2.readLineText(doc2.lines()), OLDROW(LINE_COUNT), '重开：末行');
      const idxOut = await buildIndexLikeLineindex(G.outFile);
      assertEq(idxOut.lines, expectLines.length, '重开索引行数与文档行数一致');
      await doc2.close({ discard: true });
      G.expectLineCount = expectLines.length;
      G.expectBytes = expectBuf.length;
      return `${expectLines.length} 行 / ${MB(expectBuf.length)} / 保存 ${ms}ms / 全量字节比对一致 / 无 tmp 残留`;
    });

    await check(13, '崩溃恢复：编辑后 close()（保留 overlay）→ readRecovery(io,key) 拿回块表且 overlay 字节可读', async () => {
      const doc = G.doc;
      // 保存后 doc 指向新文件且干净；制造两处编辑（文档头部 + 文档末尾）
      await doc.spliceLines(1, 0, ['REC-a', 'REC-b']);
      const afterA = doc.lines();
      assertEq(await doc.readLineText(1), 'REC-a', '编辑 A：第 1 行');
      assertEq(await doc.readLineText(2), 'REC-b', '编辑 A：第 2 行');
      assertEq(await doc.readLineText(3), OLDROW(1), '编辑 A：原第 1 行 → 第 3 行（头部插入 2 行）');
      const beforeB = doc.lines();
      const bytesBeforeB = doc.bytes();
      assertEq(beforeB, afterA, '编辑 A 后行数 = 插入 2 行后的行数');
      // 文档末尾无换行且不传 trailingNewline 时，末尾「追加」是拼到末行尾部（不新开一行）——spliceLines 的既定语义
      // （overlay.js:855-858：atEnd 时 text = ins.join('\n') + (trailingNewline ?? endsWithNL() ? '\n' : '')）
      const lastBefore = await doc.readLineText(beforeB);
      assertEq(lastBefore, OLDROW(LINE_COUNT), '追加前末行 = 保存结果末行');
      const rB = await doc.spliceLines(beforeB + 1, 0, ['REC-z']);
      assertEq(rB.deleteCount, 0, '编辑 B 摘要 deleteCount=0（from = 行数+1 即末尾追加）');
      assertEq(rB.inserted, 1, '编辑 B 摘要 inserted=1');
      assertEq(doc.lines() - beforeB, 0, '末尾无换行时追加：行数不变（新文本并入末行）');
      assertEq(doc.bytes() - bytesBeforeB, Buffer.byteLength('REC-z', 'utf8'), '追加的字节数 = 文本字节数');
      assertEq(await doc.readLineText(doc.lines()), OLDROW(LINE_COUNT) + 'REC-z', '末行 = 保存结果末行 + 追加文本');
      assertEq(doc.endsWithNL(), false, '末尾仍无换行（trailingNewline 缺省 = 保持文档原状）');
      // 对照组：替换末行为 REC-z 且带尾换行 → 末行变短、文档以换行结束
      const lastLen = lastBefore.length;
      const bytesAfterAppend = doc.bytes();
      const rB2 = await doc.spliceLines(beforeB, 1, ['REC-z'], { trailingNewline: true });
      assertEq(rB2.inserted, 1, '对照：插入 1 行');
      assertEq(rB2.deleteCount, 1, '对照：替换末行（deleteCount=1）');
      assertEq(doc.bytes(), bytesAfterAppend + 1 - lastLen,
        '对照：字节数 = 追加后字节 + 换行 - 旧末行长度（新末行 REC-z = 5 字节）');
      assertEq(await doc.readLineText(doc.lines()), 'REC-z', '对照：末行 = REC-z');
      assertEq(doc.endsWithNL(), true, '对照：文档现在以换行结束（endsNL 由触及末尾的编辑决定）');
      assertEq(doc.isDirty(), true, '两处编辑后 isDirty=true');
      const chunkCount = doc.chunkCount();
      assertEq(doc.undoDepth(), 3, 'undoDepth=3（A / B / B 对照 三步）');
      // 分区计数口径：连续 overlay 块算一处（本夹具两处编辑相距很远，底层块是否相邻由实现决定）
      const regs = doc.regions();
      assertEq(doc.dirtyCount(), regs.length, 'dirtyCount = 连续 overlay 区域数');
      assertEq(regs.length >= 1, true, '至少 1 个脏区域');
      assertEq(regs.reduce((n, r2) => n + (r2.to - r2.from + 1), 0), doc.dirtyBlocks(),
        '脏区域覆盖的块数之和 = overlay 块总数');

      // 去抖口径：META_DEBOUNCE_MS = 200ms（overlay.js:56）；close() 内部 persistMeta() 强刷，无需等待
      const t0 = Date.now();
      const cres = await doc.close();
      const closeMs = Date.now() - t0;
      assertEq(cres.kept, true, 'close() 有未保存修改 → kept=true（保留 overlay 供崩溃恢复）');
      assertEq(cres.discarded, false, 'kept 场景不得丢弃 overlay');
      assertEq(doc.isDirty(), true, 'close() 后（同一实例）仍可见未保存修改');

      // close() 前重取一次行数/字节数（对照编辑 B 之后的状态）
      const finalLines = doc.lines();
      const finalBytes = doc.bytes();
      const key = doc.key;
      const meta = await F.readRecovery(io, key);
      assertTrue(meta !== null, `readRecovery(io, ${key.slice(0, 12)}…) 必须返回块表（不能是 null）`);
      assertEq(meta.version, overlay.OVL_VERSION, 'meta.version = OVL_VERSION');
      assertEq(meta.key, key, 'meta.key 自洽');
      assertEq(meta.file, doc.file, 'meta.file = 目标路径');
      assertEq(meta.lines, finalLines, 'meta.lines = 关闭时行数（编辑内容仍在）');
      assertEq(meta.bytes, finalBytes, 'meta.bytes = 关闭时虚拟字节数');
      assertEq(meta.encoding, 'utf-8', 'meta.encoding');
      assertEq(Array.isArray(meta.blocks), true, 'meta.blocks 是数组');
      assertEq(meta.blocks.length, doc.blocks().length, 'meta.blocks 条数 = 块表条数');
      assertDeep(meta.blocks, doc.blocks().map((b) => (b.kind === 'file'
        ? { kind: 'file', start: b.start, bytes: b.bytes, lines: b.lines, endsNL: b.endsNL === true }
        : { kind: 'overlay', chunk: b.chunk, off: b.off, bytes: b.bytes, lines: b.lines, endsNL: b.endsNL === true })),
      'meta.blocks 与内存块表逐字段一致（副本口径）');
      assertEq(Array.isArray(meta.chunks), true, 'meta.chunks 是数组');
      const ovlBlocks = meta.blocks.filter((b) => b.kind === 'overlay');
      // 分片表含「撤销/重做仍引用的历史分片」（overlay.js:991 注释的物理口径），
      // 因此断言「块表引用的分片都存在于分片表」+「条数 ≤ 分片数」，而不是两者相等
      const refIds = new Set(ovlBlocks.map((b) => b.chunk));
      assertEq(refIds.size, ovlBlocks.length, '每个 overlay 块引用一个唯一分片');
      assertTrue(meta.chunks.length >= refIds.size, `分片表(${meta.chunks.length}) ⊇ 被引用分片(${refIds.size})`);
      for (const id of refIds) {
        assertEq(meta.chunks.some((c) => c.id === id), true, `被引用分片 ${id} 在分片表里`);
      }
      for (const c of meta.chunks) {
        assertEq(typeof c.off, 'number', 'chunk.off 是数字');
        assertEq(typeof c.bytes, 'number', 'chunk.bytes 是数字');
        assertEq(typeof c.id, 'string', 'chunk.id 是字符串');
      }

      // 用块表 + overlay 文件把编辑内容读回来（证明 overlay 字节真的落盘且可读）
      // 只读被块表引用的分片（未引用的历史分片属于中途撤销产生的垃圾，保存/丢弃时由 dropKey 一并清掉）
      const referenced = meta.chunks.filter((c) => refIds.has(c.id));
      assertEq(referenced.length, refIds.size, '被引用分片都能在分片表里定位');
      let totalRead = 0;
      const texts = [];
      for (const c of referenced) {
        const buf = await io.readRecord(key, c.off, c.bytes);
        assertEq(buf.length, c.bytes, `分片 ${c.id} 可整段读满（短读即抛口径）`);
        totalRead += buf.length;
        texts.push(buf.toString('utf8'));
      }
      const joined = texts.join('');
      assertEq(joined.startsWith('REC-a\nREC-b\n'), true, '恢复出的 overlay 内容以编辑 A 开头');
      assertEq(joined.endsWith('REC-z\n'), true, '恢复出的 overlay 内容以编辑 B（末行 REC-z + 换行）结尾');
      // 分片整体拼回 = 恢复后的块文本（含首尾，逐字节可核）
      assertEq(joined.includes('REC-a\nREC-b\n'), true, '编辑 A 的两次插入都在 overlay 里');
      assertEq(joined.length, totalRead, '拼接长度 = 被引用分片字节之和');
      const usage = await io.usage(key);
      assertEq(usage.exists, true, 'overlay 字节文件存在');
      // 分片表含「撤销/重做遗留但已不被块表引用」的历史分片（overlay.js:991 物理口径），
      // 因此物理文件字节 ≥ 被引用分片之和，且每个分片都必须落在物理文件范围内
      assertTrue(usage.bytes >= totalRead, `物理字节(${usage.bytes}) ≥ 被引用分片之和(${totalRead})`);
      for (const c of meta.chunks) {
        assertTrue(c.off + c.bytes <= usage.bytes, `分片 ${c.id} 落在 overlay 文件范围内`);
      }
      assertEq((await io.readMeta(key)).lines, finalLines, 'io.readMeta 与 readRecovery 同源同值');
      assertEq((await io.readMeta(key)).savedAt <= Date.now(), true, 'meta.savedAt 不超过当前时间');

      // 关闭幂等 + 已关闭文档拒绝编辑
      assertEq((await doc.close()).alreadyClosed, true, '重复 close() 返回 alreadyClosed=true');
      await assertThrows(() => doc.insertText(1, 0, 'x'), /^文档已关闭$/, '已关闭文档编辑必须抛错');
      await assertThrows(() => doc.lineOffset(1), /^文档已关闭$/, '已关闭文档定位必须抛错');

      // 干净文档 close()：discard 缺省 → 不保留。
      // 注意：同一个路径+size+mtime 派生出同一个 key（docKey 口径），所以未编辑的干净文档
      // 与上面那个「已保存的 doc」共用 key；这里用一个独立小文件验证干净路径的 close 语义
      const cleanFile = path.join(root, 'clean.txt');
      await fsp.writeFile(cleanFile, 'a\nb\nc\n', 'utf8');
      const cleanIdx = await buildIndexLikeLineindex(cleanFile);
      assertEq(cleanIdx.lines, 3, '干净小夹具 3 行');
      const d2 = await F.openDoc({ file: cleanFile, index: cleanIdx, io, id: 3 });
      const cleanKey = d2.key;
      assertEq(d2.isDirty(), false, '重开的干净文档 isDirty=false');
      assertEq(cleanKey !== key, true, '不同文件的 key 不同');
      assertEq((await io.usage(cleanKey)).exists, false, '干净文档从未编辑 → 没有 overlay 字节文件');
      const dres = await d2.close();
      assertEq(dres.discarded, false, '干净文档的 key 没有 overlay 文件可删 → discarded=false');
      assertEq(dres.kept, false, '干净文档 close() 不保留（kept=false）');
      assertEq(cleanKey !== key, true, 'close 不改动 key');
      assertEq(fs.statSync(cleanFile).size, 6, '干净文档的源文件未被改动');
      // 脏文档 key 侧：dropKey 只删 overlay，不动用户文件
      assertEq((await io.usage(key)).exists, true, 'dropKey 前脏文档的 overlay 仍在');
      assertEq(await io.dropKey(key), true, 'dropKey 返回 true（确实删到了文件）');
      assertEq((await io.usage(key)).exists, false, 'dropKey 后 overlay 字节文件消失');
      assertEq(await io.readMeta(key), null, 'dropKey 后块表读回 null');
      assertEq(await F.readRecovery(io, key), null, 'dropKey 后 readRecovery 返回 null');
      assertEq(await F.readRecovery(io, 'no-such-key'), null, '未知 key → readRecovery 返回 null（不抛）');
      assertEq(await F.readRecovery(null, key), null, 'io=null → readRecovery 返回 null（不抛）');
      assertEq(fs.existsSync(G.outFile), true, 'dropKey 只删 overlay，不动用户文件');
      assertEq(fs.statSync(G.outFile).size, G.expectBytes, 'dropKey 后用户文件大小未变');
      return `close() ${closeMs}ms 强刷落盘（去抖 200ms 被 close 覆盖，无需等待）；${chunkCount} 分片 ${totalRead}B 可读回`;
    });

    await check(14, 'gcOverlayDir(dir, protectKey)：受保护者不删 / 可回收条数符合 opts.maxFiles 口径', async () => {
      const now = Date.now();
      const mk = async (dir, name, ageMs) => {
        const p = path.join(dir, name);
        await fsp.writeFile(p, 'x');
        const t = (now - ageMs) / 1000;
        await fsp.utimes(p, t, t);
      };
      // 14a：maxFiles=2，三个新鲜文件 → 只删最旧的 1 个
      const a = path.join(root, 'gc-a');
      await fsp.mkdir(a, { recursive: true });
      await mk(a, 'a-old.tmp', 3000);
      await mk(a, 'b-mid.json', 2000);
      await mk(a, 'c-new.tmp', 1000);
      assertDeep(await listNames(a), ['a-old.tmp', 'b-mid.json', 'c-new.tmp'], '造好的 3 个假 overlay 文件');
      const r1 = await F.gcOverlayDir(a, null, { maxFiles: 2 });
      assertEq(r1.scanned, 3, 'gc scanned = 目录条目数');
      assertEq(r1.removed, 1, 'maxFiles=2 + 3 个新鲜文件 → 只删 1 个（最旧）');
      assertDeep(await listNames(a), ['b-mid.json', 'c-new.tmp'], '被删的是最旧的 a-old.tmp');
      assertEq(fs.existsSync(path.join(a, 'a-old.tmp')), false, 'a-old.tmp 必须已删除');
      // 14b：同一个目录，maxFiles=1 → 再删 1 个（b-mid 比 c-new 旧）
      const r2 = await F.gcOverlayDir(a, null, { maxFiles: 1 });
      assertEq(r2.removed, 1, 'maxFiles=1 → 再删 1 个');
      assertDeep(await listNames(a), ['c-new.tmp'], '剩下最新的 c-new.tmp');
      // 14c：受保护 key 即便超龄也不删
      const p1 = path.join(root, 'gc-p');
      await fsp.mkdir(p1, { recursive: true });
      for (const n of ['p1.tmp', 'p1.json', 'other.tmp', 'other.json', 'third.tmp']) {
        await fsp.writeFile(path.join(p1, n), 'x');
      }
      const r3 = await F.gcOverlayDir(p1, 'p1', { maxAgeMs: 0, maxFiles: 0 });
      assertEq(r3.removed, 3, 'maxAgeMs=0 + maxFiles=0 → 删掉非保护的 3 个');
      assertDeep(await listNames(p1), ['p1.json', 'p1.tmp'], 'protectKey 的 .tmp 与 .json 都留下');
      assertEq(fs.existsSync(path.join(p1, 'p1.tmp')), true, '受保护 .tmp 未删');
      assertEq(fs.existsSync(path.join(p1, 'p1.json')), true, '受保护 .json 未删');
      // 14d：目录不存在 → 不抛，返回 {0,0}
      const r4 = await F.gcOverlayDir(path.join(root, 'gc-nope'), 'k', { maxFiles: 0 });
      assertDeep(r4, { scanned: 0, removed: 0 }, '目录不存在 → {scanned:0,removed:0}');
      // 14e：io.gcOverlayDir 闭包绑定到 io.dir（生产入口口径）
      const usageDir = path.join(root, 'gc-io');
      await fsp.mkdir(usageDir, { recursive: true });
      await fsp.writeFile(path.join(usageDir, 'k.tmp'), 'x');
      await fsp.writeFile(path.join(usageDir, 'j.json'), 'x');
      const io2 = F.createOverlayIo({ dir: usageDir, allowUnapproved: true });
      assertEq(io2.dir, usageDir, 'createOverlayIo({dir}).dir 原样回传');
      assertEq(typeof io2.gcOverlayDir, 'function', 'io.gcOverlayDir 是函数');
      // 默认口径（OVL_GC_MAX_FILES=200）：2 个条目远低于保留数 → 一个都不删
      const r5a = await io2.gcOverlayDir('k');
      assertEq(r5a.scanned, 2, 'io.gcOverlayDir 扫到 2 条');
      assertEq(r5a.removed, 0, '默认 maxFiles=200 → 2 条全部保留（都没超龄）');
      assertDeep(await listNames(usageDir), ['j.json', 'k.tmp'], '默认口径下什么都不删');
      // 显式收紧（createOverlayIo 把整个 opts 透传给 gcOverlayDir → 可用 maxFiles 注入）
      const io3 = F.createOverlayIo({ dir: usageDir, allowUnapproved: true, maxFiles: 0 });
      const r5 = await io3.gcOverlayDir('k');
      assertEq(r5.scanned, 2, 'io(maxFiles=0).gcOverlayDir 扫到 2 条');
      assertEq(r5.removed, 1, 'io(maxFiles=0).gcOverlayDir 保护 k → 只删 j.json');
      assertDeep(await listNames(usageDir), ['k.tmp'], 'io.gcOverlayDir 生效且受保护者留下');
      // 14f：overlayDir() 口径（<userData>/overlay）+ 无 userData 时的守门
      assertEq(F.overlayDir('C:\\ud'), path.join('C:\\ud', 'overlay'), 'overlayDir(userData) = <userData>/overlay');
      const savedEnv = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP };
      try {
        for (const k of Object.keys(savedEnv)) delete process.env[k];
        assertEq(await assertThrows(() => F.overlayDir(''), null,
          'overlayDir("") 且无 APPDATA/LOCALAPPDATA/TEMP 时必须抛错'),
        'overlayDir 需要 userData 目录（主进程传 app.getPath("userData")）', '抛错文案逐字核对');
      } finally {
        for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
      }
      assertEq(F.overlayDir(path.join(root, 'ud')), path.join(root, 'ud', 'overlay'), '恢复环境后 overlayDir 正常');
      return 'maxFiles 口径 3 例 / protectKey 1 例 / 目录不存在 1 例 / io 闭包 1 例 / overlayDir 守门 1 例';
    });

    // ── 报告 ──
    console.log('');
    const total = passed + failed;
    console.log(`用时 ${Date.now() - t0}ms · 夹具 ${LINE_COUNT} 行 / ${MB(fx.size)}`);
    if (skipped.length) {
      console.log(`skipped=${skipped.length}（本探针明确未覆盖的面；不计入 ${total} 项总数）`);
      for (const s of skipped) console.log('  [SKIP] ' + s);
    }
    console.log(`OVERLAY_PROBE ${passed}/${total} failed=${failed}${skipped.length ? ' skipped=' + skipped.length : ''}`);
    if (failed > 0) {
      console.log('');
      console.log('失败项：');
      for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.tag}\n    ${r.msg.split('\n')[0]}`);
    }
  } finally {
    await cleanup();
    if (fs.existsSync(root)) console.log(`[warn] 临时目录未能清理：${root}`);
  }

  if (failed > 0) process.exit(1);
}

function round1(n) { return Math.round(n * 10) / 10; }

main().catch(async (err) => {
  // 锚点/夹具级致命错误：照实打印并非 0 退出（绝不静默）
  console.log('');
  console.log('[FATAL] 探针无法继续（锚点或夹具失配，不是断言失败）：');
  console.log('  ' + String((err && err.stack) || err).split('\n').join('\n  '));
  console.log('');
  console.log(`OVERLAY_PROBE ${passed}/${passed + failed + 1} failed=${failed + 1}`);
  process.exit(1);
});
