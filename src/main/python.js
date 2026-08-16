const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isApproved } = require('./security');

let currentProc = null;
let currentStartTime = 0;

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

function registerPythonIpc(getWindow) {
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
      try { currentProc.kill(); } catch {}
      currentProc = null;
    }
    const win = getWindow();
    currentStartTime = Date.now();
    // 使用 ['--', filePath]：避免以 '-' 开头的文件名被解释为解释器选项
    const child = spawn(interpreter, ['--', filePath], {
      cwd: path.dirname(filePath),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    currentProc = child;
    win.webContents.send('python:start', { interpreter, file: filePath });

    child.stdout.on('data', (d) => {
      win.webContents.send('python:output', { stream: 'stdout', data: d.toString('utf8') });
    });
    child.stderr.on('data', (d) => {
      win.webContents.send('python:output', { stream: 'stderr', data: d.toString('utf8') });
    });
    child.on('error', (err) => {
      win.webContents.send('python:exit', {
        code: null,
        duration: Date.now() - currentStartTime,
        error: `无法启动解释器 ${interpreter}: ${err.message}`,
      });
      currentProc = null;
    });
    child.on('exit', (code, signal) => {
      win.webContents.send('python:exit', {
        code,
        signal,
        duration: Date.now() - currentStartTime,
      });
      currentProc = null;
    });
    return true;
  });

  // 终止当前运行（S7：win32 用 taskkill 杀整个进程树，防止遗留子进程）
  ipcMain.handle('python:kill', async () => {
    const child = currentProc;
    if (!child) return false;
    currentProc = null;
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      });
    } else {
      try { child.kill(); } catch {}
    }
    return true;
  });
}

module.exports = { registerPythonIpc };
