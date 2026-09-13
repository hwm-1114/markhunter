#!/usr/bin/env node
/**
 * 探针：`fs.watch(文件)` 在「同目录临时文件 + rename 覆盖」（overlay 保存的原子替换方式）之后是否失效，
 * 以及「同进程里同时 watch 目录与其内部文件」是否会触发 libuv 断言崩溃。
 *
 * 背景（0.4.0 计划 §9 风险，此前只有机制证据、无实测）：
 *   - `src/main/overlay.js` 的 saveTo = 同目录临时文件 → fsync → 字节校验 → `fs.renameSync(tmp, target)`；
 *   - `src/main/filewatch.js:132` 是 `fs.watch(filePath, { persistent: true }, ...)`，**watch 文件本身**，
 *     从不 watch 目录（我已 grep 全 `src/main/*.js` 复核：只有 `fs.watch(filePath)` 与 `fs.watchFile(filePath)`）。
 *   因此要回答三问：
 *     Q1 保存（rename 覆盖）之后，对该文件的后续外部修改还能不能触发事件？→ 决定「保存后是否必须重挂 watch」
 *     Q2 同一目录下同时 watch 多个文件（多标签的日常形态）是否正常？→ 会不会踩 libuv 的共享缓冲断言
 *     Q3 同进程里同时 watch 一个目录和它内部的文件，会怎样？→ 未来若给文件树加目录监听必须知道的雷
 *
 * 局限（诚实标注）：
 *   - 跑在**纯 node**（本机 v24.18.0），不是 Electron 43 内置的 Node（v22.x）；两者同用 libuv 的 Windows
 *     后端（ReadDirectoryChangesW），机制结论可迁移，但**不是**对 Electron 运行时的直接实测。
 *   - 只测本地磁盘（tmpdir）；不测网络盘 / OneDrive 占位文件；不测 `filewatch.js` 的 300ms 防抖与
 *     `markSelfWrite`（那需要 electron，见计划 §13.6 的挂账项）。
 *
 * 用法：node scripts/watch-rename-probe.js           # 主探针（含子进程复现 Q3）
 *      node scripts/watch-rename-probe.js --q3-child  # 内部使用：Q3 的崩溃复现子进程
 * 退出码：0 = 断言全部通过；1 = 有失败。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}

/** Q3 子进程：同进程里同时 watch 目录 + 目录内文件（已知会触发 libuv 断言） */
async function q3Child() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-watch-q3-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'x\n');
  const dw = fs.watch(dir, { persistent: true }, () => {});
  const fw = fs.watch(f, { persistent: true }, () => {});
  await sleep(200);
  fs.appendFileSync(f, 'y\n'); // 触碰被 watch 的文件：libuv 在解析事件文件名时断言
  await sleep(1200);
  console.log('Q3_CHILD_SURVIVED');
  fw.close();
  dw.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--q3-child')) return q3Child();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-watch-probe-'));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  const tmp = path.join(dir, '.mh-ovl-1234.tmp');
  fs.writeFileSync(a, 'line1\nline2\n', 'utf8');
  fs.writeFileSync(b, 'bee\n', 'utf8');

  // ---- Q2：同一目录下同时 watch 两个文件（= 多标签日常形态，不 watch 目录）----
  const evA = [];
  const evB = [];
  const wa = fs.watch(a, { persistent: true }, (type) => evA.push(type));
  const wb = fs.watch(b, { persistent: true }, (type) => evB.push(type));
  wa.on('error', (e) => evA.push('error:' + e.code));
  wb.on('error', (e) => evB.push('error:' + e.code));
  await sleep(200);

  fs.appendFileSync(a, 'external-a\n');
  fs.appendFileSync(b, 'external-b\n');
  await sleep(800);
  check('Q2 同目录同时 watch 两文件：各自收到事件且无 error', evA.some((t) => t === 'change') && evB.some((t) => t === 'change') && !evA.some((t) => String(t).startsWith('error:')) && !evB.some((t) => String(t).startsWith('error:')), `A=${evA.length} B=${evB.length}`);

  // ---- Q1：overlay 式原子替换（同目录临时文件 → fsync → rename 覆盖）之后，watcher 还能用吗 ----
  const beforeRename = evA.length;
  fs.writeFileSync(tmp, fs.readFileSync(a));
  const fd = fs.openSync(tmp, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, a); // ← overlay.saveTo 的收尾动作
  await sleep(800);
  const duringRename = evA.length - beforeRename;

  const marker1 = evA.length;
  fs.appendFileSync(a, 'external-after-rename\n');
  await sleep(800);
  const q1 = evA.length > marker1;

  // 连续第二次替换（模拟连续保存）
  const marker2 = evA.length;
  fs.writeFileSync(tmp, fs.readFileSync(a));
  fs.renameSync(tmp, a);
  await sleep(400);
  fs.appendFileSync(a, 'external-after-second-rename\n');
  await sleep(800);
  const q1b = evA.length > marker2;

  check('Q1 保存(rename 覆盖)之后，外部修改仍能触发 file watcher', q1, `rename 期间 events=${duringRename}，rename 之后外部改动新增 events=${evA.length - marker1}`);
  check('Q1b 连续第二次 rename 覆盖后仍能触发', q1b, `新增 events=${evA.length - marker2}`);
  check('Q1c rename 全程无 watcher error', !evA.some((t) => String(t).startsWith('error:')) && !evB.some((t) => String(t).startsWith('error:')), `A=${evA.join(',')}`);

  wa.close();
  wb.close();
  await sleep(150);

  // ---- Q3：同进程 watch 目录 + 目录内文件（子进程复现，避免把主探针带崩）----
  const child = spawnSync(process.execPath, [__filename, '--q3-child'], { encoding: 'utf8', timeout: 20000 });
  const crashed = child.status !== 0;
  const stderr = String(child.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ');
  check(
    'Q3 同进程同时 watch 目录与其内部文件 → libuv 断言崩溃（应用当前不会踩，因为只 watch 文件）',
    crashed,
    `child status=${child.status}${stderr ? ' stderr=' + stderr : ''}`
  );

  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`Q1_ANSWER=${q1 ? 'rename 后 fs.watch(文件) 仍有效' : 'rename 后 fs.watch(文件) 失效，必须重挂'}`);
  console.log(`WATCH_RENAME_PROBE 共 ${results.length} 项 failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('探针异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
