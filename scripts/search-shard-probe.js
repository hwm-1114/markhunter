// 大文件搜索分片探针（纯 node，不需要 electron）
// 目的：直测 search-worker 的「多线程分片扫描」与串行快路径**结果完全一致**，包括
//   ① 大小写混合命中 ② 分片边界跨越的命中（needle 起点在片尾） ③ 行号/行文本/matchIndex
//   ④ 无换行巨文件（分片对齐边界） ⑤ 非 ASCII 查询走串行回退（不参与分片）
// 运行：node scripts/search-shard-probe.js        判定：末尾 SEARCH_SHARD_PROBE n/n failed=0，退出码 0
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('../src/main/search-worker.js');

let pass = 0;
let fail = 0;
const rows = [];
const tmpDir = path.join(os.tmpdir(), 'mh-shard-probe-' + process.pid + '-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

function ok(name, cond, evidence) {
  if (cond) { pass++; rows.push(['ok', name, evidence]); }
  else { fail++; rows.push(['FAIL', name, evidence]); }
}

/** 串行参考实现：整文件读入、逐行小写子串匹配（与 worker 小文件路径同口径） */
function referenceLines(file, q) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].toLowerCase().indexOf(q);
    if (idx >= 0) out.push({ line: i + 1, text: lines[i], matchIndex: idx });
  }
  return out;
}

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

async function serialScan(file, query, maxResults = 10000) {
  const results = [];
  const q = String(query).toLowerCase();
  const full = await sw.scanStream(file, query, q, results, maxResults, () => false);
  return { results, full };
}

async function parallelScan(file, query) {
  const results = [];
  const q = String(query).toLowerCase();
  const r = await sw.scanStreamParallel(file, query, q, results, 10000, () => false);
  return { results, r };
}

(async () => {
  // ---------- 1. 混合大小写 + 跨行命中，串行 vs 分片 vs 参考实现 ----------
  {
    const lines = [];
    for (let i = 1; i <= 300000; i++) {
      if (i % 70000 === 0) lines.push('line ' + i + ' has ReadMe and README and readme');
      else if (i % 33333 === 0) lines.push('line ' + i + ' contains ReAdMe mixed');
      else lines.push('line ' + i + ' filler aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    }
    const file = path.join(tmpDir, 'mixed.txt');
    writeLines(file, lines);
    const ser = await serialScan(file, 'readme');
    const par = await parallelScan(file, 'readme');
    const norm = (arr) => arr.map((r) => r.line + ':' + r.text + ':' + r.matchIndex).sort().join('|');
    // 口径：一条结果 = 一处命中（同一行 3 个大小写形态 → 3 条），与既有串行快路径一致
    ok('mixed.serial-occurrences', ser.results.length === 21, 'serial=' + ser.results.length);
    ok('mixed.parallel-eq-serial', norm(par.results) === norm(ser.results), 'parallel=' + par.results.length + ' shard=' + JSON.stringify(par.r));
    ok('mixed.parallel-full', par.r && par.r.ok === true, JSON.stringify(par.r));
  }

  // ---------- 2. 分片边界跨越：把命中精确摆在每片边界附近 ----------
  {
    const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
    const n = Math.max(2, Math.min(8, Math.max(2, cores - 1)));
    const LINE = 64; // 固定行长，便于用字节偏移算边界
    const targetSize = 12 * 1024 * 1024; // 12MB → 每片约 12MB/n
    const totalLines = Math.floor(targetSize / LINE);
    const per = Math.ceil(targetSize / n);
    // 片边界所在的字节 → 行号；在该行写入 needle，使其起点落在边界前 3 字节（跨片）
    const lines = new Array(totalLines).fill('x'.repeat(LINE - 1));
    const marks = [];
    for (let k = 1; k < n; k++) {
      const boundary = k * per;
      const lineIdx = Math.floor(boundary / LINE); // 0 基行号
      lines[lineIdx] = ('B' + k + 'NEEDLEMARK').padEnd(LINE - 1, 'z');
      marks.push(lineIdx + 1);
    }
    const file = path.join(tmpDir, 'boundary.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    const ref = referenceLines(file, 'needlemark');
    const par = await parallelScan(file, 'needlemark');
    const refLines = ref.map((r) => r.line).sort((a, b) => a - b).join(',');
    const parLines = par.results.map((r) => r.line).sort((a, b) => a - b).join(',');
    ok('boundary.hits-all-shards', ref.length === n - 1 && parLines === refLines,
      'want=' + refLines + ' got=' + parLines + ' marks=' + marks.join(',') + ' shards=' + n);
  }

  // ---------- 3. 无换行巨文件（对齐边界上无任何换行） ----------
  {
    const file = path.join(tmpDir, 'oneline.txt');
    const head = 'A'.repeat(2 * 1024 * 1024);
    fs.writeFileSync(file, head + 'NEEDLEONLINE' + 'B'.repeat(2 * 1024 * 1024), 'utf8');
    const par = await parallelScan(file, 'needleonline');
    ok('oneline.single-hit-line1', par.results.length === 1 && par.results[0].line === 1,
      'hits=' + par.results.length + ' line=' + (par.results[0] && par.results[0].line) + ' text=' + (par.results[0] && par.results[0].text.length));
  }

  // ---------- 4. 非 ASCII 查询：分片解码路径（v0.9.1）与串行逐行结果一致 ----------
  {
    const lines = [];
    for (let i = 1; i <= 200000; i++) lines.push(i === 123457 ? 'line ' + i + ' 中文关键词 here' : 'line ' + i + ' filler');
    const file = path.join(tmpDir, 'cjk.txt');
    writeLines(file, lines);
    const ser = await serialScan(file, '中文关键词');
    ok('cjk.serial-hit', ser.results.length === 1 && ser.results[0].line === 123457,
      'hits=' + ser.results.length + ' line=' + (ser.results[0] && ser.results[0].line));
    // 分片解码（该文件 < SHARD_MIN_BYTES，但函数本身不设阈值，可直接测）
    const dec = [];
    const dr = await sw.scanStreamParallelDecoded(file, '中文关键词', '中文关键词', dec, 10000, () => false);
    ok('cjk.shard-eq-serial', dr.ok === true && JSON.stringify(dec) === JSON.stringify(ser.results),
      'shard=' + JSON.stringify(dec) + ' serial=' + JSON.stringify(ser.results));
  }

  // ---------- 4b. UTF-8 中文 + 行边界跨越 + 混合大小写 + CRLF + 无尾换行 ----------
  {
    const lines = [];
    for (let i = 1; i <= 90000; i++) {
      if (i % 30000 === 0) lines.push('第 ' + i + ' 行 ReadMe中文出现一次');
      else lines.push('第 ' + i + ' 行 填充内容 füllüre');
    }
    const file = path.join(tmpDir, 'cjk-mixed.txt');
    fs.writeFileSync(file, lines.join('\r\n')); // CRLF + 末尾无换行
    for (const q of ['中文', 'readme中文', '填充内容']) {
      const ser = await serialScan(file, q);
      const dec = [];
      const dr = await sw.scanStreamParallelDecoded(file, q, String(q).toLowerCase(), dec, 10000, () => false);
      const norm = (arr) => arr.map((r) => r.line + ':' + r.text + ':' + r.matchIndex).join('|');
      ok('cjkMixed.' + q + '.eq', dr.ok === true && norm(dec) === norm(ser.results),
        'shard=' + dec.length + ' serial=' + ser.results.length);
    }
  }

  // ---------- 4c. GBK 中文 + 分片解码（编码由协调方探测） ----------
  {
    // “中文测试” 的 GBK 字节
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    const parts = [];
    for (let i = 1; i <= 80000; i++) {
      if (i === 45678) parts.push(Buffer.concat([Buffer.from('line ' + i + ' '), gbk, Buffer.from(' key')]));
      else parts.push(Buffer.from('line ' + i + ' filler ascii only'));
    }
    const file = path.join(tmpDir, 'cjk-gbk.txt');
    fs.writeFileSync(file, Buffer.concat(parts.flatMap((b, i) => (i === parts.length - 1 ? [b] : [b, Buffer.from('\n')]))));
    const ser = await serialScan(file, '中文测试');
    const dec = [];
    const dr = await sw.scanStreamParallelDecoded(file, '中文测试', '中文测试', dec, 10000, () => false);
    ok('cjkGbk.shard-eq-serial', dr.ok === true && JSON.stringify(dec) === JSON.stringify(ser.results) && dec.length === 1 && dec[0].line === 45678,
      'shard=' + JSON.stringify(dec) + ' serial=' + JSON.stringify(ser.results));
  }

  // ---------- 4d. 分片边界恰好落在超长行内部：行归属与行号必须一致 ----------
  {
    const n = Math.max(2, Math.min(8, Math.max(2, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1)));
    const LINE = 300; // 长行，保证片边界落在行中
    const totalLines = 60000;
    const per = Math.ceil(totalLines * (LINE + 1) / n);
    const lines = [];
    for (let i = 1; i <= totalLines; i++) {
      // 让每一行都含 needle，便于验证"每行最多一条 + 行号连续不重不漏"
      lines.push(('行' + i + ' 关键词').padEnd(LINE - 1, 'x'));
    }
    const file = path.join(tmpDir, 'cjk-boundary.txt');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    const ser = await serialScan(file, '关键词', 1000000);
    const dec = [];
    const dr = await sw.scanStreamParallelDecoded(file, '关键词', '关键词', dec, 1000000, () => false);
    const serLines = ser.results.map((r) => r.line).join(',');
    const decLines = dec.map((r) => r.line).join(',');
    ok('cjkBoundary.eq', dr.ok === true && decLines === serLines && dec.length === totalLines,
      'shard=' + dec.length + ' serial=' + ser.results.length + ' per=' + per + ' shards=' + n);
  }

  // ---------- 5. 非 ASCII 查询：分片不参与，串行回退路径命中 ----------
  {
    const lines = [];
    for (let i = 1; i <= 200000; i++) lines.push(i === 123457 ? 'line ' + i + ' 中文关键词 here' : 'line ' + i + ' filler');
    const file = path.join(tmpDir, 'cjk.txt');
    writeLines(file, lines);
    const ser = await serialScan(file, '中文关键词');
    ok('cjk.serial-hit', ser.results.length === 1 && ser.results[0].line === 123457,
      'hits=' + ser.results.length + ' line=' + (ser.results[0] && ser.results[0].line));
  }

  // ---------- 5. GBK 大文件：ASCII 查询分片后行号/文本口径与串行一致 ----------
  {
    // 手工构造 GBK 字节（中文用 GBK 双字节），ASCII 部分按 UTF-8 同字节
    const parts = [];
    const gbkLine = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // “中文” GBK
    for (let i = 1; i <= 120000; i++) {
      if (i === 60000) parts.push(Buffer.concat([Buffer.from('line ' + i + ' '), gbkLine, Buffer.from(' ReadMe key')]));
      else parts.push(Buffer.from('line ' + i + ' filler ascii only'));
    }
    const file = path.join(tmpDir, 'gbk.txt');
    fs.writeFileSync(file, Buffer.concat(parts.flatMap((b, i) => (i === parts.length - 1 ? [b] : [b, Buffer.from('\n')]))));
    const ser = await serialScan(file, 'readme');
    const par = await parallelScan(file, 'readme');
    const norm = (arr) => arr.map((r) => r.line + ':' + r.text + ':' + r.matchIndex).join('|');
    ok('gbk.parallel-eq-serial', norm(par.results) === norm(ser.results),
      'serial=' + JSON.stringify(ser.results) + ' parallel=' + JSON.stringify(par.results));
  }

  // ---------- 6. maxResults 截断：分片路径同样按偏移升序截断 ----------
  {
    const lines = [];
    for (let i = 1; i <= 100000; i++) lines.push('hit hit hit line ' + i);
    const file = path.join(tmpDir, 'dense.txt');
    writeLines(file, lines);
    const results = [];
    const q = 'hit';
    const r = await sw.scanStreamParallel(file, 'hit', q, results, 5, () => false);
    const ascending = results.every((x, i) => i === 0 || x.line >= results[i - 1].line);
    ok('dense.cap-and-order', r.ok === true && results.length === 5 && ascending, JSON.stringify(results.map((x) => x.line)));
  }

  for (const [st, name, ev] of rows) console.log('[' + st + ']', name, ev ? '(' + ev + ')' : '');
  console.log('SEARCH_SHARD_PROBE ' + pass + '/' + (pass + fail) + ' failed=' + fail);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error('SEARCH_SHARD_PROBE_ERROR', e && e.stack ? e.stack : e);
  console.log('SEARCH_SHARD_PROBE ' + pass + '/' + (pass + fail) + ' failed=' + (fail + 1));
  process.exitCode = 1;
});
