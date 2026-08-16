const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getSettings } = require('./settings');
const { markSelfWrite } = require('./filewatch');
const { isInside, setRoot, getRoot, approve, requireApproved, realpath } = require('./security');

function normalize(p) {
  return path.resolve(p);
}

/** 检测文本编码（判定顺序：UTF-8 → GBK → latin1）：'utf-8' | 'gbk' | 'latin1' */
function detectEncoding(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    try {
      new TextDecoder('gbk').decode(buf);
      return 'gbk';
    } catch {
      return 'latin1';
    }
  }
}

/** 按编码解码文本（encoding 缺省时自动检测，顺序与 detectEncoding 一致） */
function decodeText(buf, encoding = detectEncoding(buf)) {
  if (encoding === 'utf-8') return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  if (encoding === 'gbk') return new TextDecoder('gbk').decode(buf);
  return buf.toString('latin1');
}

function registerFileIpc(getWindow) {
  // 设置当前工作目录（渲染进程 openDirFromPath 成功后调用；主进程路径校验基准）
  ipcMain.handle('fs:set-root', (_e, dir) => {
    setRoot(dir || null);
    return true;
  });

  // 选择工作目录
  ipcMain.handle('dialog:select-directory', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // 浏览选择可执行文件（如 python.exe）
  ipcMain.handle('dialog:select-file', async (_e, opts = {}) => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: opts.filters || [],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // 原生确认对话框
  ipcMain.handle('dialog:confirm', async (_e, opts) => {
    const win = getWindow();
    const res = await dialog.showMessageBox(win, {
      type: opts.type || 'warning',
      title: opts.title || '确认',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['取消', '确定'],
      defaultId: (opts.buttons || ['取消', '确定']).length - 1,
      cancelId: 0,
      noLink: true,
    });
    return res.response;
  });

  // 读取目录直接子项（懒加载；不受路径校验限制，目录树需可自由浏览）
  ipcMain.handle('fs:read-tree', async (_e, dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // 隐藏项
      const full = path.join(dir, ent.name);
      try {
        const st = await fsp.stat(full);
        out.push({
          name: ent.name,
          path: full,
          isDir: ent.isDirectory(),
          size: ent.isDirectory() ? -1 : st.size,
          mtime: st.mtimeMs,
        });
      } catch {
        /* 忽略无权限项 */
      }
    }
    out.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1
    );
    return out;
  });

  // 读取文件（带大小上限；成功后记入 approvedSet，拖拽打开的外部文件保存/运行仍可用）
  ipcMain.handle('fs:read-file', async (_e, filePath) => {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('目标不是文件');
    const maxMB = getSettings().maxFileSizeMB || 50;
    const maxBytes = maxMB * 1024 * 1024;
    if (st.size > maxBytes) {
      const err = new Error(
        `文件大小 ${(st.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${maxMB} MB，已拒绝打开（可在设置中调整上限）`
      );
      err.code = 'TOO_LARGE';
      err.size = st.size;
      err.maxBytes = maxBytes;
      throw err;
    }
    const buf = await fsp.readFile(filePath);
    approve(filePath); // 记录已成功读取的路径
    const encoding = detectEncoding(buf);
    return { content: decodeText(buf, encoding), size: st.size, mtime: st.mtimeMs, encoding };
  });

  // 写文件（必须先通过路径校验）
  ipcMain.handle('fs:write-file', async (_e, filePath, content) => {
    requireApproved(filePath, '路径不在当前工作目录内，操作已拒绝');
    await fsp.writeFile(filePath, content, 'utf8');
    await markSelfWrite(filePath); // 记录本次写入的 mtime，避免文件监听误报为外部修改
    return true;
  });

  // 写二进制文件（粘贴图片用；必须先通过路径校验）
  ipcMain.handle('fs:write-binary', async (_e, filePath, buffer) => {
    requireApproved(filePath, '路径不在当前工作目录内，操作已拒绝');
    const ext = path.extname(filePath).toLowerCase();
    const okExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];
    if (!okExt.includes(ext)) throw new Error('不支持的图片格式：' + ext);
    await fsp.writeFile(filePath, Buffer.from(buffer));
    await markSelfWrite(filePath);
    return true;
  });

  // 文件信息（图片详情用；不受限）
  ipcMain.handle('fs:stat', async (_e, target) => {
    const st = await fsp.stat(target);
    return { size: st.size, isFile: st.isFile(), isDir: st.isDirectory(), mtime: st.mtimeMs };
  });

  // 新建文件/目录（父目录必须已批准）
  ipcMain.handle('fs:create', async (_e, parentDir, name, type) => {
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!safe) throw new Error('名称不合法');
    const target = path.join(parentDir, safe);
    requireApproved(target, '路径不在当前工作目录内，操作已拒绝');
    if (fs.existsSync(target)) throw new Error(`已存在同名项：${safe}`);
    if (type === 'dir') {
      await fsp.mkdir(target);
    } else {
      await fsp.writeFile(target, '', 'utf8');
    }
    return target;
  });

  // 删除（前端已确认；禁止删除当前工作目录本身）
  ipcMain.handle('fs:delete', async (_e, target, isDir) => {
    requireApproved(target, '路径不在当前工作目录内，操作已拒绝');
    const root = getRoot();
    const samePath = (a, b) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (root && samePath(realpath(target), root)) {
      throw new Error('不能删除当前工作目录');
    }
    if (isDir) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.unlink(target);
    return true;
  });

  // 重命名（旧路径必须已批准）
  ipcMain.handle('fs:rename', async (_e, oldPath, newName) => {
    requireApproved(oldPath, '路径不在当前工作目录内，操作已拒绝');
    const safe = String(newName).replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!safe) throw new Error('名称不合法');
    const target = path.join(path.dirname(oldPath), safe);
    if (fs.existsSync(target)) throw new Error(`已存在同名项：${safe}`);
    await fsp.rename(oldPath, target);
    return target;
  });

  // 模拟外部修改（测试用）：仅开发环境注册；打包版无此能力（preload 保留但无 handler）
  if (!app.isPackaged) {
    ipcMain.handle('fs:write-external', async (_e, filePath, content) => {
      await fsp.writeFile(filePath, content, 'utf8');
      return true;
    });
  }
}

module.exports = { registerFileIpc, isInside };
