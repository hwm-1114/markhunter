#!/usr/bin/env node
/**
 * 冒烟日志验收器：把「E2E_RESULTS 计数 / false 数 / SMOKE_OK / 指定用例必须为真」变成一条命令。
 *
 * 背景：0.5.0 每个阶段收尾都要跑一次真实窗口冒烟，人工数行容易看错（本会话就出现过
 * 「以为跑了 9 分钟」与「用 Get-Content 数行数少算 5–15%」两次误判）。验收口径统一为：
 *   - 结果行数 = 期望值（Phase 2 起 199；2026-08-30 的基线是 192）
 *   - 值为 `false` 的结果行 = 0
 *   - 日志里恰好出现 1 次 `SMOKE_OK`
 *   - `--require` 列出的用例必须存在且其值不是 `false`（信息型真值串如 `findAll | 3 处匹配` 也算通过）
 *
 * 用法：
 *   node scripts/smoke-verify.js <日志路径> [--expect 199] [--require splitBasic,splitResize]
 *   node scripts/smoke-verify.js <日志路径> --list          # 只列用例名与值
 * 退出码：0 = 全部满足；1 = 有未满足项。
 *
 * 注意：本脚本只读日志、不跑冒烟（`npm run smoke` 必须前台跑，且同一时刻只允许一条线跑构建/冒烟）。
 */

const fs = require('fs');

function parseArgs(argv) {
  const out = { file: null, expect: null, require: [], info: [], list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--expect') out.expect = Number(argv[++i]);
    else if (a === '--require') out.require = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--info') out.info = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--list') out.list = true;
    else if (!out.file) out.file = a;
  }
  return out;
}

/**
 * 读日志：容忍 PowerShell 重定向/Tee-Object 产生的 UTF-16LE 与 ANSI 颜色转义
 * （实测：`npm run smoke *>&1 | Tee-Object -FilePath x.log` 在 Windows PowerShell 下写出 UTF-16，
 *  直接按 utf8 读会得到 NUL 交错文本 → 结果行一条都匹配不到）
 */
function readLogText(file) {
  const buf = fs.readFileSync(file);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else {
    const sample = buf.slice(0, Math.min(buf.length, 4096));
    let nul = 0;
    for (const b of sample) if (b === 0) nul++;
    text = nul > sample.length / 4 ? buf.toString('utf16le') : buf.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); // 去掉 ANSI 颜色
}

/**
 * 已知的「信息型真值串」用例白名单：这些用例的**值列**故意不是 `true`（返回携带信息的字符串，代表通过）。
 * 其余任何不是 `true` 的值都视为失败 —— 因为 step()/runCase()/mvCase() 的约定是
 * 「`ok === true` 打印 `true`，否则打印 detail 字符串」，而 detail 字符串**不带 ERR: 前缀**，
 * 所以只看 `false`/`ERR:` 会漏判（2026-08-30 实证：4 个用例返回 detail 串被判成"信息型"，导致误报全绿）。
 * 新增信息型用例时用 `--info 名字` 追加。
 */
const DEFAULT_INFO = [
  'detectPython', 'runPython', 'findAll', 'pyUI', 'hugeIndexCold', 'hugeIndexCache',
  'hugeSearchFast', 'rcDirArgParse', 'previewImgClip', 'bundleSplit',
];

function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('用法：node scripts/smoke-verify.js <日志路径> [--expect 208] [--require a,b,c] [--info x,y] [--list]');
    process.exit(1);
  }
  if (!fs.existsSync(args.file)) {
    console.error(`日志不存在：${args.file}`);
    process.exit(1);
  }
  const infoSet = new Set([...DEFAULT_INFO, ...args.info]);
  const lines = readLogText(args.file).split(/\r?\n/);
  // 结果行有三种形态：`- 名 | 值`、`- 名 | 值 | 证据`、以及信息型的 `- 名 | 说明串`。
  // 必须只把**第二列**当值（早期版本用贪婪 `(.*)` 把 `true | 证据…` 整段当值，导致全判成失败）。
  const caseRe = /^\s*-\s+([^|]+?)\s*\|\s*([^|]*?)\s*(?:\|\s*(.*))?$/;
  const cases = [];
  for (const line of lines) {
    const m = line.match(caseRe);
    if (m) cases.push({ name: m[1].trim(), value: m[2].trim(), evidence: (m[3] || '').trim() });
  }
  const falsy = cases.filter((c) => c.value === 'false');
  // 重要：`ERR:` 开头的值是**用例抛异常**的标记，不是通过。
  // 血的教训（2026-08-30 20:49）：`SMOKE_OK` 是 smoke.js 在 `finally` 里**无条件**打印的，
  // 它只代表「套件跑完、没有顶层 E2E_ERROR 异常」，**不代表所有用例通过** ——
  // 那次 6 个 split 用例全是 `| ERR: Error: Uncaught Error: An object could not be cloned.`，
  // 而 SMOKE_OK 照样打印，我第一版验收器只看 `false` 于是误报「199 项全绿」。
  const errored = cases.filter((c) => /^ERR:/.test(c.value));
  // 非 true 且不在信息型白名单里 ⇒ 失败（detail 字符串代表 ok===false）
  const softFailed = cases.filter((c) => c.value !== 'true' && !/^ERR:/.test(c.value) && !infoSet.has(c.name));
  const smokeOk = lines.filter((l) => /^SMOKE_OK\s*$/.test(l)).length;
  const errLines = lines.filter((l) => /^ERR:|^E2E_ERROR/.test(l)).length;

  if (args.list) {
    for (const c of cases) console.log(`${c.name} | ${c.value}`);
    console.log(`（共 ${cases.length} 行）`);
    process.exit(0);
  }

  const problems = [];
  if (cases.length === 0) problems.push('日志里没有任何结果行（是不是把 stdout 重定向丢了？注意 smoke 的输出可能被缓冲到结束才刷盘）');
  if (args.expect !== null && cases.length !== args.expect) problems.push(`结果行数 = ${cases.length}，期望 ${args.expect}`);
  if (falsy.length) problems.push(`有 ${falsy.length} 行为 false：${falsy.map((c) => c.name).join(', ')}`);
  if (errored.length) problems.push(`有 ${errored.length} 行为 ERR（用例抛异常）：${errored.map((c) => c.name).join(', ')}`);
  if (softFailed.length) problems.push(`有 ${softFailed.length} 行返回 detail 串（= 用例判定失败，但没有 ERR 前缀）：${softFailed.map((c) => c.name + '[' + String(c.value).slice(0, 60) + ']').join(' ; ')}`);
  if (smokeOk !== 1) problems.push(`SMOKE_OK 出现 ${smokeOk} 次（应为 1；注意它是 finally 无条件打印，别把它当全绿证据）`);
  if (errLines) problems.push(`有 ${errLines} 行以 ERR:/E2E_ERROR 开头（顶层异常）`);
  const missing = [];
  for (const name of args.require) {
    const hit = cases.find((c) => c.name === name);
    if (!hit) missing.push(`${name}(缺失)`);
    else if (hit.value === 'false') missing.push(`${name}(false)`);
    else if (/^ERR:/.test(hit.value)) missing.push(`${name}(ERR)`);
    else if (hit.value !== 'true' && !infoSet.has(name)) missing.push(`${name}(未通过: ${String(hit.value).slice(0, 50)})`);
  }
  if (missing.length) problems.push(`必需用例未通过：${missing.join(', ')}`);

  console.log(`日志：${args.file}`);
  console.log(`结果行 = ${cases.length}（期望 ${args.expect === null ? '未指定' : args.expect}）· false = ${falsy.length} · ERR = ${errored.length} · 非 true 非信息型 = ${softFailed.length} · SMOKE_OK = ${smokeOk} · 顶层异常行 = ${errLines}`);
  console.log('非 true 的结果行（信息型真值串属正常，detail 串 = 失败，ERR 不是）：');
  for (const c of cases.filter((x) => x.value !== 'true')) console.log(`  - ${c.name} | ${c.value}`);
  if (problems.length) {
    console.log('');
    console.log(`SMOKE_VERIFY FAIL（${problems.length} 项）`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('');
  console.log(`SMOKE_VERIFY OK（${cases.length} 项全绿：true ${cases.length - infoSet.size >= 0 ? cases.filter((c) => c.value === 'true').length : 0} 项 + 信息型 ${cases.filter((c) => c.value !== 'true').length} 项，false 0，ERR 0，SMOKE_OK 1）`);
  process.exit(0);
}

main();
