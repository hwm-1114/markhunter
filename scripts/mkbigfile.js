// 生成 GB 级实测夹具（纯 node，不依赖 electron；供 bigperf/bigprobe 复跑）
//
// 用法：
//   node scripts/mkbigfile.js                      # 默认生成 5GB + 10GB 到 F:\mh-bigtest
//   node scripts/mkbigfile.js --dir F:\\mh-bigtest --sizes 5,10
//   node scripts/mkbigfile.js --sizes 1 --check    # 只校验已有夹具
//
// 夹具格式（关键：**定长 128 字节/行**，行数 = size/128 可精确预测，便于断言）：
//   L000000001 [2026-10-17T21:00:00Z] INFO  worker-07 event=heartbeat seq=0000001 payload=...\n
// 每 1000000 行有一个 SECTION 标记行（搜索/跳转哨兵）：
//   ##### SECTION 000042 ##### ... NEEDLE5G ...（5GB 夹具）/ NEEDLE10G（10GB 夹具）
// 末尾倒数第 1000 行有 TAIL 标记，用于验证"直达文件尾"。
//
// 生成速度：先填一行再按 2 的幂自我拷贝（memcpy 带宽），5GB 约 2~4s。
const fs = require('fs');
const path = require('path');

const LINE = 128;                 // 每行字节数（含 \n）
const SECTION_EVERY = 1000000;    // 段标记间隔（行）
const MB = 1024 * 1024;

function parseArgs(argv) {
  const o = { dir: process.env.MH_BIGTEST_DIR || 'F:\\mh-bigtest', sizes: [5, 10], check: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--sizes') o.sizes = String(argv[++i] || '').split(',').map((x) => Number(x)).filter((x) => x > 0);
    else if (a === '--check') o.check = true;
  }
  return o;
}

/** 定长一行（127 字符 + \n）；不足补空格，超出截断 */
function padLine(s) {
  const t = String(s).replace(/[\r\n]/g, ' ');
  if (t.length >= LINE - 1) return t.slice(0, LINE - 1) + '\n';
  return t + ' '.repeat(LINE - 1 - t.length) + '\n';
}

/** 段标记行：唯一 token（SECTION n / NEEDLE），供搜索与"跳到该位置"断言使用 */
function markerLine(n, name) {
  return padLine(`##### SECTION ${String(n).padStart(6, '0')} ##### NEEDLE-${name} marker=${n} #####`);
}

function tailLine(totalLines, name) {
  return padLine(`##### TAIL ${String(totalLines).padStart(10, '0')} ##### NEEDLE-${name}-TAIL #####`);
}

function plainLine(i) {
  // 注意：定长；行号只占前 10 位，其余内容恒定（生成走 memcpy，快）
  return padLine(`L${String(i).padStart(9, '0')} [2026-10-17T21:00:00Z] INFO  worker-07 event=heartbeat payload=abcdefghijklmnopqrstuvwxyz0123456789`);
}

/** 生成一个文件：sizeBytes 必须是 LINE 的整数倍 */
function generate(file, sizeBytes, name, onProgress) {
  const totalLines = Math.floor(sizeBytes / LINE);
  const fd = fs.openSync(file, 'w');
  const CHUNK = 8 * MB;
  const linesPerChunk = Math.floor(CHUNK / LINE);
  const buf = Buffer.allocUnsafe(linesPerChunk * LINE);
  // 首行 → 按 2 的幂自我拷贝填满（16 次 memcpy，等价 memcpy 带宽）
  const first = Buffer.from(plainLine(1), 'utf8');
  first.copy(buf, 0);
  let filled = LINE;
  while (filled < buf.length) {
    const n = Math.min(filled, buf.length - filled);
    buf.copy(buf, filled, 0, n);
    filled += n;
  }
  let lineNo = 0;
  let written = 0;
  const t0 = Date.now();
  const plain = Buffer.from(plainLine(1), 'utf8');
  const patched = []; // 本块被改写的行（写盘后必须还原，否则标记会随复用缓冲复制到后面的块）
  try {
    while (lineNo < totalLines) {
      const n = Math.min(linesPerChunk, totalLines - lineNo);
      // 覆盖本块内的段标记 / TAIL 标记（行号 1 基：lineNo+1 .. lineNo+n）
      const firstNo = lineNo + 1;
      const lastNo = lineNo + n;
      for (let m = Math.ceil(firstNo / SECTION_EVERY) * SECTION_EVERY; m <= lastNo; m += SECTION_EVERY) {
        const off = (m - firstNo) * LINE;
        Buffer.from(markerLine(m, name), 'utf8').copy(buf, off);
        patched.push(off);
      }
      const tailAt = totalLines - 999;
      if (tailAt >= firstNo && tailAt <= lastNo) {
        const off = (tailAt - firstNo) * LINE;
        Buffer.from(tailLine(totalLines, name), 'utf8').copy(buf, off);
        patched.push(off);
      }
      const bytes = n * LINE;
      fs.writeSync(fd, buf, 0, bytes);
      for (const off of patched) plain.copy(buf, off);
      patched.length = 0;
      written += bytes;
      lineNo += n;
      if (onProgress && (lineNo % (linesPerChunk * 32) === 0)) onProgress(written, totalLines * LINE);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { totalLines, bytes: written, ms: Date.now() - t0 };
}

/** 校验：size、行数、首行/段标记/尾标记 */
function check(file, name) {
  const st = fs.statSync(file);
  const totalLines = Math.floor(st.size / LINE);
  const read = (off, len) => {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(len);
      const n = fs.readSync(fd, b, 0, len, off);
      return b.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  };
  const firstOk = /^L000000001 /.test(read(0, LINE));
  const sec = 1000000;
  const secLine = read((sec - 1) * LINE, LINE);
  const secOk = secLine.indexOf('SECTION 1000000') >= 0;
  const tailOk = read((totalLines - 999 - 1) * LINE, LINE).indexOf(`TAIL`) >= 0;
  const lastByte = read(st.size - 1, 1) === '\n';
  return { file, size: st.size, totalLines, firstOk, secOk, tailOk, lastByte, secLine: secLine.trim() };
}

function main() {
  const o = parseArgs(process.argv);
  fs.mkdirSync(o.dir, { recursive: true });
  for (const gb of o.sizes) {
    const name = gb >= 10 ? '10G' : `${gb}G`;
    const file = path.join(o.dir, `mh-${gb}gb.txt`);
    const sizeBytes = Math.floor(gb * 1024 * MB / LINE) * LINE;
    if (o.check) {
      if (!fs.existsSync(file)) { console.log('[check] MISSING', file); continue; }
      const c = check(file, name);
      console.log('[check]', JSON.stringify(c));
      continue;
    }
    if (fs.existsSync(file) && fs.statSync(file).size === sizeBytes) {
      console.log('[skip] 已存在且大小一致:', file);
      continue;
    }
    console.log(`[gen] ${file} 目标 ${(sizeBytes / 1024 / MB).toFixed(0)} MB ...`);
    const r = generate(file, sizeBytes, name, (done, total) => {
      console.log(`[gen] ${(done / 1024 / MB).toFixed(0)} / ${(total / 1024 / MB).toFixed(0)} MB`);
    });
    console.log(`[gen] done ${file} size=${fs.statSync(file).size} lines=${r.totalLines} ms=${r.ms}`);
    console.log('[check]', JSON.stringify(check(file, name)));
  }
}

if (require.main === module) main();

module.exports = { generate, check, LINE };
