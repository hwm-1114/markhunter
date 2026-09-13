const { app, ipcMain, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');
const { isApproved } = require('./security');

let currentProc = null;
let currentStartTime = 0;
let runSeq = 0; // 运行序号：旧进程迟到的 exit 事件据此被渲染端忽略（避免覆盖新进程的运行状态）

/** 发起窗口（v0.1.51 多窗口：输出/退出事件只发给启动 Python 的窗口） */
function winOf(e) {
  try {
    return BrowserWindow.fromWebContents(e.sender);
  } catch {
    return null;
  }
}

/** 按进程树终止（win32 用 taskkill /T /F，防遗留子进程；其余平台 kill 直杀）。
 *  done 为可选回调（等待 taskkill 退出后触发）；同步失败静默忽略。 */
function killTree(child, done) {
  if (!child) {
    if (typeof done === 'function') done();
    return;
  }
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('exit', () => done && done());
      killer.on('error', () => done && done());
    } else {
      child.kill();
      if (typeof done === 'function') done();
    }
  } catch {
    if (typeof done === 'function') done();
  }
}

/** 换新进程前处置旧进程：摘掉输出监听（防残余输出窜入新批次）后树杀（不等待）。
 *  注意：close 回调保留（用于给发起窗口补发 python:exit），因此不能在这里清 currentProc ——
 *  由 sendExit 里的 `currentProc === child` 判定负责。 */
function disposeCurrentProc() {
  const old = currentProc;
  currentProc = null;
  if (!old) return;
  try {
    if (old.stdout) old.stdout.removeAllListeners('data');
    if (old.stderr) old.stderr.removeAllListeners('data');
  } catch { /* 忽略 */ }
  killTree(old);
}

// P4（v0.1.45）：输出背压 —— stdout/stderr 按「~60ms 或 ~4KB（先到者）」聚合后统一经
// 'python:output' 通道发送，避免每 chunk 一条 IPC（实测 2000 行 ≈ 数千条 IPC 拖垮渲染线程）。
// 退出时 flush 残余；wire 格式保持 { stream, data } 不变（渲染端与冒烟监听兼容）。
const BATCH_INTERVAL_MS = 60; // ~50-100ms 窗口内取 60ms（D7：4KB 或 50ms 先到者，此处 60ms 量级一致）
const BATCH_MAX_BYTES = 4096;

/** 输出聚合器：事件只发发起窗口（getWin 闭包持有该窗口引用，销毁即丢弃残余） */
function createOutputBatcher(getWin) {
  const buf = { stdout: '', stderr: '' };
  let total = 0;       // 当前批累计字节数（utf8 近似按字符数计，量级足够）
  let timer = null;

  function flush() {
    timer = null;
    if (total === 0) return;
    // 注意：必须先取走字符串再清空缓冲 —— out 若直接引用 buf，清空会把待发送内容一并清掉
    const outStdout = buf.stdout;
    const outStderr = buf.stderr;
    buf.stdout = '';
    buf.stderr = '';
    total = 0;
    let win = null;
    try { win = getWin(); } catch { /* 窗口查询失败视为不可用 */ }
    if (!win || win.isDestroyed()) return; // 窗口已销毁：丢弃残余（进程退出中，无接收方）
    // 按流各发一条（≤2 条/批）：保持 { stream, data } 协议不变，渲染端逐流追加
    if (outStdout) win.webContents.send('python:output', { stream: 'stdout', data: outStdout });
    if (outStderr) win.webContents.send('python:output', { stream: 'stderr', data: outStderr });
  }

  function push(stream, data) {
    buf[stream] += data;
    total += data.length;
    if (total >= BATCH_MAX_BYTES) { // 字节阈值先到：立即发
      flush();
      return;
    }
    if (!timer) timer = setTimeout(flush, BATCH_INTERVAL_MS); // 时间阈值先到：定时发
  }

  return { push, flush };
}

/** 探测某个命令是否可用（如 python / py） */
function probeExecutable(cmd) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, ['--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          try { child.kill(); } catch {}
          resolve(false);
        }
      }, 5000);
      child.on('error', () => {
        if (!done) { done = true; clearTimeout(timer); resolve(false); }
      });
      child.on('exit', (code) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(code === 0);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

/** 用 where/which 解析命令的真实绝对路径（PATH 第一个命中） */
function resolveCommandPath(cmd) {
  return new Promise((resolve) => {
    const where = process.platform === 'win32' ? 'where.exe' : 'which';
    try {
      const child = spawn(where, [cmd], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('error', () => resolve(null));
      child.on('exit', (code) => {
        if (code !== 0) return resolve(null);
        const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
        resolve(line || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** 探测命令，返回绝对路径（如 D:\python\python.exe）或 null */
async function probeCommand(cmd) {
  const ok = await probeExecutable(cmd);
  if (!ok) return null;
  const resolved = await resolveCommandPath(cmd);
  return resolved || cmd;
}

/** 从 Windows 注册表读取 Python 安装路径（覆盖未加入 PATH 的安装） */
function probeRegistry() {
  return new Promise((resolve) => {
    const found = [];
    const roots = [
      'HKCU\\Software\\Python\\PythonCore',
      'HKLM\\SOFTWARE\\Python\\PythonCore',
    ];
    let pending = roots.length;
    const done = () => {
      if (pending === 0) resolve(found);
    };
    for (const root of roots) {
      try {
        const child = spawn('reg.exe', ['query', root, '/s', '/f', 'InstallPath', '/t', 'REG_SZ'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('error', () => { pending--; done(); });
        child.on('exit', () => {
          const re = /InstallPath\s+REG_SZ\s+(.+)/gi;
          let m;
          while ((m = re.exec(out))) {
            const p = path.join(m[1].trim(), 'python.exe');
            if (fs.existsSync(p) && !found.includes(p)) found.push(p);
          }
          pending--;
          done();
        });
      } catch {
        pending--;
        done();
      }
    }
  });
}

/** 常见安装位置兜底 */
function probeCommonPaths() {
  const candidates = [];
  const add = (p) => { if (fs.existsSync(p)) candidates.push(p); };
  const local = process.env.LOCALAPPDATA || '';
  add(path.join(local, 'Programs', 'Python', 'python.exe'));
  add(path.join(local, 'Programs', 'Python', 'Python311', 'python.exe'));
  add(path.join(local, 'Programs', 'Python', 'Python312', 'python.exe'));
  add(path.join(local, 'Programs', 'Python', 'Python313', 'python.exe'));
  add(path.join(local, 'Programs', 'Python', 'Python314', 'python.exe'));
  add('C:\\Python311\\python.exe');
  add('C:\\Python312\\python.exe');
  add('C:\\Python313\\python.exe');
  add('C:\\Python314\\python.exe');
  return candidates;
}

function registerPythonIpc(_getWindow) {
  // 自动检测可用解释器（PATH 命令 + 注册表 + 常见安装位置，返回绝对路径）
  ipcMain.handle('python:detect', async () => {
    const found = [];
    for (const cmd of ['python', 'py', 'python3']) {
      const p = await probeCommand(cmd);
      if (p && !found.includes(p)) found.push(p);
    }
    const reg = await probeRegistry();
    for (const p of reg) {
      if (!found.includes(p)) found.push(p);
    }
    for (const p of probeCommonPaths()) {
      if (!found.includes(p)) found.push(p);
    }
    return found;
  });

  // 运行 Python 脚本（S7：扩展名 + 路径校验；pythonPath 必须为合法解释器）
  ipcMain.handle('python:run', async (_e, payload) => {
    const { filePath, pythonPath } = payload || {};
    if (!filePath) throw new Error('缺少脚本文件路径');
    if (!/\.py$/i.test(String(filePath))) throw new Error('只能运行 .py 脚本文件');
    if (!isApproved(filePath)) throw new Error('脚本文件不在当前工作目录内，操作已拒绝');
    if (!fs.existsSync(filePath)) throw new Error('脚本文件不存在');
    let interpreter = 'python';
    if (pythonPath) {
      const pp = String(pythonPath).trim();
      if (!pp) throw new Error('Python 解释器路径为空');
      if (!fs.existsSync(pp) || !fs.statSync(pp).isFile()) {
        throw new Error(`Python 解释器路径不存在或不是文件：${pp}`);
      }
      const base = path.basename(pp);
      if (!/^python([0-9.]*)?.exe$/i.test(base) && !/^py\.exe$/i.test(base)) {
        throw new Error(`Python 解释器路径不合法（需为 python*.exe 或 py.exe）：${pp}`);
      }
      interpreter = pp;
    }
    if (currentProc) {
      disposeCurrentProc(); // 旧进程：摘监听 + 进程树终止（普通 kill 会遗留子进程）
    }
    const win = winOf(_e); // v0.1.51：输出/退出只发发起窗口
    if (!win || win.isDestroyed()) throw new Error('窗口不可用');
    currentStartTime = Date.now();
    // P4：输出聚合器（stdout/stderr 合批发送，退出时 flush 残余）
    const batcher = createOutputBatcher(() => win);
    // v0.3.0：按流增量解码 —— 直接 d.toString('utf8') 会在管道分块边界切断多字节字符，
    // 输出里出现 U+FFFD（实测 sys.stdout.write("中"*100000) 出现 8 个替换符）。
    const decStdout = new StringDecoder('utf8');
    const decStderr = new StringDecoder('utf8');
    // 使用 ['--', filePath]：避免以 '-' 开头的文件名被解释为解释器选项
    const child = spawn(interpreter, ['--', filePath], {
      cwd: path.dirname(filePath),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    currentProc = child;
    const token = ++runSeq;
    win.webContents.send('python:start', { interpreter, file: filePath, token });

    child.stdout.on('data', (d) => {
      const s = decStdout.write(d);
      if (s) batcher.push('stdout', s);
    });
    child.stderr.on('data', (d) => {
      const s = decStderr.write(d);
      if (s) batcher.push('stderr', s);
    });
    let settled = false; // 防双发：spawn 失败时 error 与 close 都会触发
    const sendExit = (payload) => {
      if (settled) return;
      settled = true;
      // 解码器余量先入批（末尾不完整序列/最后一段），再 flush，保证输出完整
      try {
        const tailOut = decStdout.end();
        if (tailOut) batcher.push('stdout', tailOut);
        const tailErr = decStderr.end();
        if (tailErr) batcher.push('stderr', tailErr);
      } catch { /* 忽略 */ }
      batcher.flush(); // P4：退出时 flush 残余，保证输出完整、退出码后到
      // 窗口可能已销毁（应用退出中）：flush 已做同样检查，此处防 webContents.send 抛错
      try {
        if (win && !win.isDestroyed()) win.webContents.send('python:exit', Object.assign({ token }, payload));
      } catch { /* 忽略 */ }
      // v0.3.0：只在「当前进程仍是本进程」时清引用 —— 旧进程被 taskkill 后的 close 回调
      // 晚到时若无条件置空，会把刚启动的新进程引用抹掉（终止按钮失效、退出应用也回收不了）
      if (currentProc === child) currentProc = null;
    };
    child.on('error', (err) => {
      sendExit({
        code: null,
        duration: Date.now() - currentStartTime,
        error: `无法启动解释器 ${interpreter}: ${err.message}`,
      });
    });
    // 用 close 而非 exit：close 保证 stdio 全部排空后才触发，此时 flush 残余不会遗漏晚到的 data 事件
    child.on('close', (code, signal) => {
      sendExit({ code, signal, duration: Date.now() - currentStartTime });
    });
    return true;
  });

  // 终止当前运行（S7：win32 用 taskkill 杀整个进程树，防止遗留子进程）
  ipcMain.handle('python:kill', async () => {
    const child = currentProc;
    if (!child) return false;
    currentProc = null;
    await new Promise((resolve) => killTree(child, resolve));
    return true;
  });

  // 应用退出时回收正在运行的 Python 进程（taskkill 已 spawn 即独立执行，不阻塞退出）
  app.on('will-quit', () => {
    disposeCurrentProc();
  });
}

module.exports = { registerPythonIpc };
