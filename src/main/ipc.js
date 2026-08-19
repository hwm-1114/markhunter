const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getSettings } = require('./settings');
const { markSelfWrite } = require('./filewatch');
const { isInside, setRoot, getRoot, approve, isApproved, requireApproved, realpath, dirHasApprovedFile } = require('./security');

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

  // P7（v0.1.45）：按 range 分段读取大文件 —— 渲染进程分段注入 CM，避免大文件全量进出内存 + IPC 全量拷贝。
  // 保留大小上限校验（超限抛 TOO_LARGE，语义与 fs:read-file 一致：tooLarge 冒烟仍过）。
  // 返回原始字节（ArrayBuffer，结构化克隆）+ 文件元信息；编码检测与流式解码在渲染端完成
  // （TextDecoder stream:true 可正确处理分块边界截断的多字节字符，如 GBK/UTF-8 尾字节）。
  ipcMain.handle('fs:read-file-range', async (_e, filePath, start, length) => {
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
    const s = Math.max(0, Math.floor(Number(start) || 0));
    const len = Math.max(0, Math.min(Math.floor(Number(length) || 0), st.size - s));
    const buf = Buffer.alloc(len);
    let fh = null;
    try {
      fh = await fsp.open(filePath, 'r');
      await fh.read(buf, 0, len, s);
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    // Buffer 底层 ArrayBuffer 视图（精确截取，避免把整个大缓冲传过去）
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    approve(filePath); // P7：记录已成功读取的路径（与 fs:read-file 一致 —— 外部大文件打开后保存/运行仍可用）
    return { bytes: ab, start: s, end: s + len, size: st.size, mtime: st.mtimeMs };
  });

  // 写二进制文件（粘贴图片用；必须先通过路径校验）
  ipcMain.handle('fs:write-binary', async (_e, filePath, buffer) => {
    // M3（v0.1.44）：外部文件粘贴图片放行 —— 目标为「已批准文件所在目录」内即可。
    // write-binary 仅粘贴图片使用，权限面最窄：不放开 create/delete/rename 等其它写操作；
    // rootDir 内目录仍由 isInside 覆盖，不放开无关目录（S1 语义保持）。
    const dir = path.dirname(String(filePath));
    const ok = isApproved(filePath) || isApproved(dir) || dirHasApprovedFile(dir);
    if (!ok) throw new Error('路径不在当前工作目录内，操作已拒绝');
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

  // 模拟外部修改（测试用）：L9（v0.1.44）收敛 —— 无条件注册（preload 保留 API，冒烟 dev 下仍可用），
  // 打包模式（app.isPackaged）抛明确错误：测试接口在正式版不可用（收敛为明确行为，而非调用即 404 类异常）
  ipcMain.handle('fs:write-external', async (_e, filePath, content) => {
    if (app.isPackaged) {
      throw new Error('测试接口在正式版不可用（fs:write-external 仅限开发环境）');
    }
    await fsp.writeFile(filePath, content, 'utf8');
    return true;
  });
}

module.exports = { registerFileIpc, isInside };
