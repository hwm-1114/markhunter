const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getSettings } = require('./settings');
const { markSelfWrite } = require('./filewatch');
const { isInside, setRoot, getRoot, approve, isApproved, requireApproved, realpath, dirHasApprovedFile, remapApproved, revokeUnder } = require('./security');

function normalize(p) {
  return path.resolve(p);
}

/** 发起窗口（v0.1.51 多窗口：原生对话框挂在调用方窗口上） */
function winOf(e) {
  try {
    return BrowserWindow.fromWebContents(e.sender);
  } catch {
    return null;
  }
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

function registerFileIpc(_getWindow) {
  // 设置当前工作目录（渲染进程 openDirFromPath 成功后调用；主进程路径校验基准）
  ipcMain.handle('fs:set-root', (_e, dir) => {
    setRoot(dir || null);
    return true;
  });

  // 选择工作目录
  ipcMain.handle('dialog:select-directory', async (e) => {
    const win = winOf(e);
    const res = await dialog.showOpenDialog(win, {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // 浏览选择可执行文件（如 python.exe）
  ipcMain.handle('dialog:select-file', async (e, opts = {}) => {
    const win = winOf(e);
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: opts.filters || [],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // 原生确认对话框
  ipcMain.handle('dialog:confirm', async (e, opts) => {
    const win = winOf(e);
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
    let read = 0;
    let fh = null;
    try {
      fh = await fsp.open(filePath, 'r');
      // 常规文件也可能部分读：读满为止，返回值按实际读取量（渲染端以 end 作下一段起点，可自愈续读）
      while (read < len) {
        const { bytesRead } = await fh.read(buf, read, len - read, s + read);
        if (!bytesRead) break;
        read += bytesRead;
      }
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    // Buffer 底层 ArrayBuffer 视图（精确截取，避免把整个大缓冲传过去）
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + read);
    approve(filePath); // P7：记录已成功读取的路径（与 fs:read-file 一致 —— 外部大文件打开后保存/运行仍可用）
    return { bytes: ab, start: s, end: s + read, size: st.size, mtime: st.mtimeMs };
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
    // 父目录可能已失效（树缓存陈旧：目录被外部移动/删除后行仍在树上）→
    // recursive 重建父链，避免 ENOENT 裸错误让「新建」表现为无声失败
    if (type === 'dir') {
      await fsp.mkdir(target, { recursive: true });
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
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
    revokeUnder(target); // 清理批准集合：已删除路径不再保留写权限
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
    remapApproved(oldPath, target); // 批准集合映射到新路径：重命名后（外部文件）保存/运行仍可用
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

  // ---------- 1B-7：超大文档分块流式写（write-stream 三通道） ----------
  // 动机：单串 IPC 受 V8 字符串上限（≈5.36 亿字符）与结构化克隆内存峰值约束；
  // >64M 字符的保存改走 open → append×N（16M 字符/块）→ close，close 时统一 markSelfWrite。
  const writeStreams = new Map(); // id -> { fh, path }
  let writeStreamSeq = 0;

  ipcMain.handle('fs:write-stream-open', async (_e, filePath) => {
    requireApproved(filePath, '路径不在当前工作目录内，操作已拒绝');
    const fh = await fsp.open(filePath, 'w');
    const id = ++writeStreamSeq;
    writeStreams.set(id, { fh, path: filePath });
    return id;
  });

  ipcMain.handle('fs:write-stream-append', async (_e, id, content) => {
    const ws = writeStreams.get(Number(id));
    if (!ws) throw new Error('写入流不存在或已关闭');
    const buf = Buffer.from(String(content), 'utf8');
    await ws.fh.write(buf, null); // position=null：从当前位置顺序追加
    return true;
  });

  ipcMain.handle('fs:write-stream-close', async (_e, id) => {
    const ws = writeStreams.get(Number(id));
    if (!ws) return false;
    writeStreams.delete(Number(id));
    await ws.fh.close();
    await markSelfWrite(ws.path); // close 时统一标记自写（宽限窗口吸收期间的事件回声）
    return true;
  });

  // ---------- 1B-2：大文件查看器区域写回（splice） ----------
  // 把 [offset, offset+oldLength) 字节替换为新内容：临时文件流式拷贝 前段+新内容+后段 →
  // 校验大小 → rename 原子覆盖。区域内容单串传输（≤48MB 上限），头尾拷贝在主进程流式进行。
  ipcMain.handle('fs:splice-file', async (_e, filePath, offset, oldLength, content) => {
    requireApproved(filePath, '路径不在当前工作目录内，操作已拒绝');
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('目标不是文件');
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const oldLen = Math.max(0, Math.floor(Number(oldLength) || 0));
    if (off + oldLen > st.size) throw new Error('区域越界（文件可能已被外部修改）');
    const buf = Buffer.from(String(content), 'utf8');
    if (buf.length > 48 * 1024 * 1024) throw new Error('区域内容过大（上限 48MB）');
    const tmp = filePath + '.mh-splice-' + Date.now() + '.tmp';
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      out.on('error', reject);
      const copyRange = (start, end) =>
        new Promise((res, rej) => {
          if (end <= start) return res();
          const src = fs.createReadStream(filePath, { start, end: end - 1 });
          src.on('error', rej);
          src.on('end', res);
          src.pipe(out, { end: false });
        });
      (async () => {
        try {
          await copyRange(0, off);
          await new Promise((res, rej) => out.write(buf, (e) => (e ? rej(e) : res())));
          await copyRange(off + oldLen, st.size);
          out.end(resolve);
        } catch (e) {
          try { out.destroy(); } catch { /* 已销毁 */ }
          reject(e);
        }
      })().catch(reject);
    }).catch(async (err) => {
      try { await fsp.unlink(tmp); } catch { /* 清理失败忽略 */ }
      throw err;
    });
    const newSize = st.size - oldLen + buf.length;
    const tmpSt = await fsp.stat(tmp);
    if (tmpSt.size !== newSize) {
      await fsp.unlink(tmp);
      throw new Error(`拼接校验失败：${tmpSt.size} ≠ ${newSize}`);
    }
    await fsp.rename(tmp, filePath);
    await markSelfWrite(filePath);
    return { size: newSize, bytes: buf.length };
  });

  // ---------- 1B-5：行号 → 字节偏移（全局搜索命中大文件定位用） ----------
  // 流式统计换行：返回第 line 行行首的字节偏移（utf-8 语义近似：按字节扫描 \n，行号对
  // ASCII/UTF-8 均准确——多字节字符不含 0x0A 字节；GBK 理论含 0x0A 的尾字节概率极低，可接受）
  ipcMain.handle('fs:find-line-offset', async (_e, filePath, line) => {
    const target = Math.max(1, Math.floor(Number(line) || 1)) - 1; // 需要越过 target 个换行
    if (target === 0) return 0;
    return await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
      let passed = 0; // 已越过的换行数
      let offset = 0;
      rs.on('data', (chunk) => {
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 0x0a) {
            passed++;
            if (passed >= target) {
              rs.destroy();
              resolve(offset + i + 1);
              return;
            }
          }
        }
        offset += chunk.length;
      });
      rs.on('end', () => resolve(offset));
      rs.on('error', reject);
    });
  });
}

module.exports = { registerFileIpc, isInside };
