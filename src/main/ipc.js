const { app, ipcMain, dialog, BrowserWindow, shell, clipboard, webContents } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { getSettings } = require('./settings');
const { markSelfWrite } = require('./filewatch');
const { isInside, setRoot, setRoots, getRoot, getRoots, approve, isApproved, requireApproved, realpath, dirHasApprovedFile, remapApproved, revokeUnder, samePath, isUnderDir } = require('./security');

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

// P7（v0.4.0）：按 range 读取大文件的可复用实现 —— fs:read-file-range 与行索引批量取数（huge:lines）共用。
// 统一在这里处理「单次读取长度限流 + 读满为止 + 成功读取即 approve（与 fs:read-file 一致）」，
// 避免大文件取数出现第二套读盘口径（调用方只关心 Buffer，不跨进程拷贝）。
const MAX_RANGE_BYTES = 64 * 1024 * 1024;
async function readRangeBytes(filePath, start, length, maxBytes = MAX_RANGE_BYTES) {
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('目标不是文件');
  const s = Math.max(0, Math.floor(Number(start) || 0));
  const lim = Math.min(maxBytes, Math.max(0, Math.floor(Number(length) || 0)), Math.max(0, st.size - s));
  const buf = Buffer.alloc(lim);
  let read = 0;
  let fh = null;
  try {
    fh = await fsp.open(filePath, 'r');
    // 常规文件也可能部分读：读满为止，返回值按实际读取量（调用方以 end 作下一段起点，可自愈续读）
    while (read < lim) {
      const { bytesRead } = await fh.read(buf, read, lim - read, s + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  approve(filePath); // P7：记录已成功读取的路径（与 fs:read-file 一致 —— 外部大文件打开后保存/运行仍可用）
  return { buf: buf.subarray(0, read), start: s, end: s + read, size: st.size, mtime: st.mtimeMs };
}

function registerFileIpc(_getWindow) {
  // 设置当前工作目录（渲染进程 openDirFromPath 成功后调用；主进程路径校验基准）
  ipcMain.handle('fs:set-root', (_e, dir) => {
    setRoot(dir || null);
    return true;
  });

  // v0.2.3 多目录：整表同步侧栏根集合 + 活动目录（写操作在任一根内放行，见 security.setRoots）。
  // v0.5.1 多窗口修复：security.roots 是进程级单例，而每个窗口都会整表同步自己的目录 ——
  // 后同步的窗口会把先开目录窗口的根集合整个覆盖掉（「写文件有时没权限」的根因）。
  // 改为按调用窗口记账并取**并集**同步；已销毁窗口的记账随时清理；活动目录以调用方为准（缺席时回退任一窗口的）。
  const rootsBySender = new Map(); // webContents.id -> { dirs: string[], active: string | null }
  ipcMain.handle('fs:set-roots', (e, dirs, active) => {
    const list = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d) : [];
    rootsBySender.set(e.sender.id, { dirs: list, active: typeof active === 'string' ? active : null });
    for (const sid of [...rootsBySender.keys()]) {
      const wc = webContents.fromId(sid);
      if (!wc || wc.isDestroyed()) rootsBySender.delete(sid);
    }
    const union = [];
    const seen = new Set();
    let fallbackActive = null;
    for (const rec of rootsBySender.values()) {
      for (const d of rec.dirs) {
        const k = String(d).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        union.push(d);
      }
      if (!fallbackActive && rec.active) fallbackActive = rec.active;
    }
    setRoots(union, typeof active === 'string' && active ? active : fallbackActive);
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
    // v0.4.0：分段读**不再受"文件总大小上限"约束** —— GB 级查看器/行索引都是按 8MB 窗口 seek，
    // 内存有界，"打开上限"只在渲染端 openFile 统一把关（见 tabs.js）。
    // 限流（单次 64MB）与 approve 语义都在 readRangeBytes 内（行索引的 huge:lines 复用同一实现）。
    const r = await readRangeBytes(filePath, start, length);
    // Buffer 底层 ArrayBuffer 视图（精确截取，避免把整个大缓冲传过去）
    const ab = r.buf.buffer.slice(r.buf.byteOffset, r.buf.byteOffset + r.buf.length);
    return { bytes: ab, start: r.start, end: r.end, size: r.size, mtime: r.mtime };
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

  // 新建文件/目录（v0.5.1 全部放开：不再限制在已打开目录内 —— 无论活动目录是哪个，任意位置创建都能成功，
  // 父目录缺失时 recursive 重建父链。创建成功即批准该路径：新建文件随后的内容写入/保存不再被拒；
  // 写入已有文件/删除/改名仍维持原白名单口径不变）
  ipcMain.handle('fs:create', async (_e, parentDir, name, type) => {
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!safe) throw new Error('名称不合法');
    if (!parentDir || typeof parentDir !== 'string') throw new Error('缺少创建位置（请先打开一个目录）');
    const target = path.join(parentDir, safe);
    if (fs.existsSync(target)) throw new Error(`已存在同名项：${safe}`);
    // 父目录可能已失效（树缓存陈旧：目录被外部移动/删除后行仍在树上）→
    // recursive 重建父链，避免 ENOENT 裸错误让「新建」表现为无声失败。
    // 记录本次新造的祖先目录（创建即批准用）：删除/改名刚创建的整条链不再被拒
    const madeParents = [];
    let anc = path.dirname(target);
    while (!fs.existsSync(anc)) {
      madeParents.push(anc);
      const up = path.dirname(anc);
      if (up === anc) break;
      anc = up;
    }
    if (type === 'dir') {
      await fsp.mkdir(target, { recursive: true });
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, '', 'utf8');
    }
    for (const m of madeParents) approve(m);
    approve(target); // 创建即批准（v0.5.1）：新建文件/目录本身及其后续内容写入均可用
    return target;
  });

  // 删除（前端已确认；禁止删除任何侧栏根目录本身）
  ipcMain.handle('fs:delete', async (_e, target, isDir) => {
    requireApproved(target, '路径不在当前工作目录内，操作已拒绝');
    const samePath = (a, b) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    const rp = realpath(target);
    if (getRoot() && samePath(rp, getRoot())) {
      throw new Error('不能删除当前工作目录');
    }
    for (const r of getRoots()) {
      if (samePath(rp, r)) throw new Error('不能删除侧栏已打开的目录（请先关闭该目录）');
    }
    if (isDir) await fsp.rm(target, { recursive: true, force: true });
    else await fsp.unlink(target);
    revokeUnder(target); // 清理批准集合：已删除路径不再保留写权限
    return true;
  });

  // ---------- v0.2.3 多目录：跨目录拖拽传输（复制/移动） ----------
  /** 冲突时目标名的「保留两者」去重：name.ext → "name (2).ext"（目录无 ext，直接追加）。
   *  从 2 起找第一个不存在的序号，与 Explorer 命名习惯一致。 */
  function dedupeName(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 2; ; i++) {
      const cand = `${stem} (${i})${ext}`;
      if (!fs.existsSync(path.join(dir, cand))) return cand;
    }
  }

  /** 递归复制（目录合并语义：目标已存在时按文件覆盖合并，与 Explorer 一致） */
  async function copyInto(src, dest) {
    await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
  }

  // src（文件或目录）传输到目录 destDir 下：mode='copy'|'move'。
  // conflict='ask'（默认）→ 目标已存在时返回 { conflict: true }，渲染层确认后带
  // overwrite=true 重调；conflict='dedupe' → 自动改名为「name (2).ext」。
  // v0.7.0（用户决策口径）：源与目标只校验**存在**，不再要求白名单 —— 树内可见即可拖
  // （外部文件分支的文件/目录链之间互传不再被拒）。移动成功后 remapApproved、跨盘回退
  // 删除源后 revokeUnder 的既有语义保持。
  ipcMain.handle('fs:transfer', async (_e, srcPath, destDir, mode, opts = {}) => {
    const src = normalize(srcPath);
    const dst = normalize(destDir);
    const srcSt = await fsp.stat(src);
    if (!srcSt.isDirectory() && !srcSt.isFile()) throw new Error('源既不是文件也不是目录');
    if (samePath(src, dst)) throw new Error('目标目录与源相同');
    if (isUnderDir(dst, src)) throw new Error('不能把目录移动/复制到其自身内部');
    let name = path.basename(src);
    let dest = path.join(dst, name);
    if (fs.existsSync(dest)) {
      // 目标已存在（Windows 下存在性检查天然大小写不敏感）
      if (samePath(src, dest)) throw new Error('源与目标为同一位置，无需传输');
      const strategy = opts.conflict || 'ask';
      if (strategy === 'dedupe') {
        name = dedupeName(dst, name);
        dest = path.join(dst, name);
      } else if (!opts.overwrite) {
        return { conflict: true, name };
      }
      // overwrite=true：文件直接覆盖；目录走合并（cp force / rename 失败回退合并复制）
      // 目录覆盖文件（或反向）：类型不一致无法合并，先移除目标再传输
      const destSt = await fsp.stat(dest).catch(() => null);
      if (destSt && srcSt.isDirectory() !== destSt.isDirectory()) {
        await fsp.rm(dest, { recursive: true, force: true });
      }
    }
    const isMove = mode === 'move';
    if (isMove) {
      try {
        await fsp.rename(src, dest);
      } catch (err) {
        // EXDEV（跨盘）/ EPERM+目录已存在（Windows rename 不覆盖已存在目录）→ 合并复制后删源
        const crossDevice = err.code === 'EXDEV';
        const destExistsDir = srcSt.isDirectory() && fs.existsSync(dest);
        if (!crossDevice && !destExistsDir && !samePath(src, dest)) throw err;
        await copyInto(src, dest);
        await fsp.rm(src, { recursive: true, force: true });
        revokeUnder(src);
      }
      remapApproved(src, dest); // 移动后批准集合映射到新路径（外部文件标签保存仍可用）
    } else {
      await copyInto(src, dest);
    }
    // 目标可能在另一窗口打开过/被监听：标记自写吸收监听回声（源侧移动后监听由渲染端重建）
    await markSelfWrite(dest);
    return { dest, name };
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

  // ==========================================================================
  // 0.5.0 Phase 5a 第 2 批 F2：树/标签右键「常用项」的三条通道
  // --------------------------------------------------------------------------
  // 安全面（v0.7.0 用户决策口径变更，与 v0.5.1 的 fs:create 放开同源）：
  //   ① 「用默认程序打开」「在终端打开」「复制路径/文件名」「复制文件到剪贴板」这些
  //      **树内可达的读侧操作不再做白名单校验，只校验路径存在** —— 用户口径：
  //      左侧栏打开的所有目录/文件（含外部文件分支与目录链）都不能再出现
  //      「路径不在已打开目录内，操作已拒绝」。渲染进程本就能通过系统对话框/
  //      拖拽拿到任意路径，这几条通道不构成新的信息面；
  //   ② 「在终端打开」仍保持 **路径只作 cwd**（argv 恒空、shell:false）的既有硬约束；
  //   ③ 「用默认程序打开」仍只走 shell.openPath（绝不用 shell.openExternal）。
  //   fs:write / fs:delete / fs:rename / fs:write-binary 的写盘白名单口径**不变**
  //   （侧栏根内 + 已打开文件的面已覆盖「左侧栏打开的目录与文件」）。
  // ==========================================================================

  /** F2 公共守卫（v0.7.0 起只校验存在性）：返回 {ok:true,path,stat} 或 {ok:false,reason,message} */
  function guardApprovedExisting(target) {
    const p = String(target || '');
    if (!p) return { ok: false, reason: 'EMPTY', message: '缺少路径参数' };
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {
      return { ok: false, reason: 'ENOENT', message: `路径不存在或不可访问：${p}` };
    }
    return { ok: true, path: p, stat };
  }

  // 「用默认程序打开」（文件或目录）：只走 shell.openPath，绝不 openExternal。
  // **唯一保留白名单的通道**（v0.7.0 口径评审）：它能以系统默认关联启动任意程序
  // （.bat/.exe/任意扩展名），是"树内可达操作"里外向性最强的一条 —— 未批准路径仍拒绝；
  // 侧栏根内与已打开过的文件（含外部文件分支）不受影响。其余通道（终端 cwd/剪贴板/
  // 复制粘贴/拖拽）见上方 v0.7.0 说明，均为存在性校验。
  ipcMain.handle('shell:open-path', async (_e, target) => {
    const p = String(target || '');
    if (!p) return { ok: false, reason: 'EMPTY', message: '缺少路径参数' };
    try {
      requireApproved(p, '路径不在已打开目录内，操作已拒绝');
    } catch (err) {
      return { ok: false, reason: 'NOT_APPROVED', message: String((err && err.message) || err) };
    }
    const g = guardApprovedExisting(p);
    if (!g.ok) return g;
    try {
      const errMsg = await shell.openPath(g.path); // 成功返回空串；失败返回错误描述
      if (errMsg) return { ok: false, reason: 'OPEN_FAILED', message: errMsg, path: g.path };
      return { ok: true, path: g.path, mode: g.stat.isDirectory() ? 'dir' : 'file' };
    } catch (err) {
      return { ok: false, reason: 'OPEN_FAILED', message: String((err && err.message) || err), path: g.path };
    }
  });

  // 「在终端打开」：路径**只作为 cwd**（不进 argv、不过 shell）；文件取其所在目录。
  // opts.dryRun=true 时只回执"将要怎么做"（冒烟用：既能断言安全口径，又不在真实桌面弹出控制台窗口）。
  ipcMain.handle('shell:open-terminal', async (_e, target, opts) => {
    const g = guardApprovedExisting(target);
    if (!g.ok) return g;
    const cwd = g.stat.isDirectory() ? g.path : path.dirname(g.path);
    let st = null;
    try {
      st = fs.statSync(cwd);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) {
      return { ok: false, reason: 'NOT_A_DIR', message: `目标目录不存在：${cwd}`, path: g.path };
    }
    const isWin = process.platform === 'win32';
    const cmd = isWin ? (process.env.COMSPEC || 'cmd.exe') : 'x-terminal-emulator';
    // 非 Windows 的终端接受 --working-directory=…（仍是 argv，不是 shell 串）；Windows 直接空 argv + cwd
    const argv = isWin ? [] : ['--working-directory=' + cwd];
    if (opts && opts.dryRun === true) {
      return { ok: true, dryRun: true, cwd, cmd: path.basename(cmd), argv: argv.slice(), shell: false, mode: 'cwd', from: g.path };
    }
    try {
      const child = spawn(cmd, argv, {
        cwd,                 // ★ 路径的唯一传递通道（绝不拼进命令行）
        detached: true,      // 独立控制台：应用退出不影响已打开的终端
        stdio: 'ignore',     // 不捕获输出（也不占用父进程 stdio）
        windowsHide: false,
        shell: false,        // ★ 显式关掉 shell 解析
      });
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true, cwd, cmd: path.basename(cmd), argv: argv.slice(), shell: false, mode: 'cwd', pid: child ? child.pid : null };
    } catch (err) {
      return { ok: false, reason: 'SPAWN_FAILED', message: String((err && err.message) || err), cwd };
    }
  });

  // 「复制路径 / 复制文件名」：写入系统剪贴板。
  // v0.7.0 起只校验路径存在（见上方守卫说明）：正文仍由主进程按来源路径自拼
  // （渲染端只给 { path, kind }，没有 text 入参 —— 这条通道依旧写不了任意内容）。
  ipcMain.handle('clipboard:write-text', (_e, payload) => {
    const arg = payload && typeof payload === 'object' ? payload : {};
    const g = guardApprovedExisting(arg.path);
    if (!g.ok) return g;
    const kind = arg.kind === 'name' ? 'name' : 'path';
    const base = path.basename(g.path);
    const text = kind === 'name' ? (base || g.path) : g.path;
    clipboard.writeText(text);
    return { ok: true, path: g.path, kind, text, length: text.length };
  });

  // 任意文本写入系统剪贴板（v0.7.0 新增）：预览代码块「一键复制」用。
  // 口径说明：这是用户决策的功能放开 —— 能力等价于浏览器网页的 navigator.clipboard.writeText
  // （file:// 下该 API 不可用，故走 IPC）。写盘零接触，风险面 = 往剪贴板放文本。
  ipcMain.handle('clipboard:write-any-text', (_e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  // ==========================================================================
  // v0.6.0：文件/文件夹经系统剪贴板复制粘贴（文件树 Ctrl+C / Ctrl+V，与资源管理器互通）
  // --------------------------------------------------------------------------
  // 复制 = 把选中项路径以 Windows **CF_HDROP**（DROPFILES 结构 + 双 \0 结尾的 UTF-16 路径
  //   列表）写入系统剪贴板 —— 资源管理器 / 桌面等一切接受"文件粘贴"的目标都能直接 Ctrl+V。
  //   Chromium 的 Windows 剪贴板层把 "CF_HDROP" 字符串映射为标准剪贴板格式 CF_HDROP
  //   （非 RegisterClipboardFormat 的自造格式），因此 Explorer 认得出。
  // 粘贴 = 读回 CF_HDROP 列表，逐个复制进目标目录。**源路径来自系统剪贴板**（用户在资源
  //   管理器里 Ctrl+C 的任意路径，应用外）—— 语义等同"把外部文件拖进窗口"，源不要求白名单；
  //   目标目录必须过 requireApproved + 真实存在（写盘面与 create/rename/transfer 一致）。
  //   自包含防御：源等于目标、目标是源的子目录时跳过该项（与 fs:transfer 同口径）。
  // ==========================================================================

  /** 构造 CF_HDROP 载荷：20 字节 DROPFILES 头（pFiles=20, pt=(0,0), fNC=0, fWide=1）+ UTF-16 路径列表。
   *  列表按规范以**双 null**（连续两个 UTF-16 0x0000）终止 —— HDROP 结构没有计数字段，
   *  消费方（Explorer/DragQueryFile）靠双终止判断列表结束，单终止会读越界。 */
  function buildHDROP(paths) {
    const listBuf = Buffer.from(paths.join('\0') + '\0\0', 'utf16le'); // 每条路径一个 \0 分隔 + 整体一个 \0 终止
    const buf = Buffer.alloc(20 + listBuf.length);
    buf.writeUInt32LE(20, 0);  // pFiles：文件列表相对结构体起点的偏移
    buf.writeInt32LE(0, 4);    // pt.x（粘贴位置无关，置 0）
    buf.writeInt32LE(0, 8);    // pt.y
    buf.writeUInt32LE(0, 12);  // fNC（非客户区标志，无关）
    buf.writeUInt32LE(1, 16);  // fWide=1：路径列表为 UTF-16
    listBuf.copy(buf, 20);
    return buf;
  }

  /** 解析 CF_HDROP 载荷 → 路径数组（fWide=0 的 ANSI 形态一并兼容；结构异常返回 []） */
  function parseHDROP(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 20) return [];
    const pFiles = buf.readUInt32LE(0);
    const fWide = buf.readUInt32LE(16);
    if (pFiles <= 0 || pFiles >= buf.length) return [];
    const raw = fWide
      ? buf.toString('utf16le', pFiles)
      : buf.toString('latin1', pFiles);
    return raw.split('\0').map((s) => s.trim()).filter(Boolean);
  }

  // 复制文件/文件夹到系统剪贴板（v0.7.0 起只校验存在 —— 外部文件分支的目录链行也可复制）
  ipcMain.handle('clipboard:copy-files', (_e, paths) => {
    const list = (Array.isArray(paths) ? paths : [paths])
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    if (list.length === 0) return { ok: false, reason: 'EMPTY', message: '没有可复制的路径' };
    for (const p of list) {
      const g = guardApprovedExisting(p);
      if (!g.ok) return g;
    }
    clipboard.writeBuffer('CF_HDROP', buildHDROP(list));
    return { ok: true, count: list.length };
  });

  // 读剪贴板文件列表（paste 的探测面 / 冒烟用：只读，不写盘）
  ipcMain.handle('clipboard:read-files', () => {
    const files = parseHDROP(clipboard.readBuffer('CF_HDROP')).filter((p) => fs.existsSync(p));
    return { ok: true, count: files.length, files };
  });

  // 把剪贴板里的文件/文件夹复制进目标目录。
  // v0.7.0（用户决策口径）：目标目录只校验**存在且是目录**，不再要求白名单 —— 用户口径
  // 「左侧栏打开的所有目录都能操作，不能出现权限拒绝」（外部文件分支的目录链同样是
  // 粘贴目标）。源来自系统剪贴板（用户自己的复制动作）的既有语义不变。
  // opts.conflict：'ask'（默认，冲突即整单返回由渲染端弹窗确认，**一个都不先粘**，避免半截状态）
  //   | 'dedupe'（自动改名 name (2).ext）| { overwrite: true }（覆盖/合并，与 fs:transfer 语义一致）
  ipcMain.handle('fs:paste-files', async (_e, destDir, opts = {}) => {
    const dst = normalize(destDir);
    let dstSt;
    try {
      dstSt = fs.statSync(dst);
    } catch {
      return { ok: false, reason: 'ENOENT', message: `目标目录不存在：${dst}` };
    }
    if (!dstSt.isDirectory()) return { ok: false, reason: 'NOT_A_DIR', message: `目标不是目录：${dst}` };
    const files = parseHDROP(clipboard.readBuffer('CF_HDROP'))
      .filter((p) => { try { return fs.statSync(p).isFile() || fs.statSync(p).isDirectory(); } catch { return false; } });
    if (files.length === 0) return { ok: false, reason: 'EMPTY', message: '剪贴板里没有可粘贴的文件' };

    // 先做整单冲突预检（ask 模式）：任一目标名已存在 → 返回冲突，由渲染端确认后重调
    const overwrite = opts.overwrite === true;
    const strategy = opts.conflict || 'ask';
    const pending = []; // { src, name, dest }
    for (const src of files) {
      const name = path.basename(src);
      const dest = path.join(dst, name);
      if (samePath(src, dst) || isUnderDir(dst, src)) continue; // 源==目标 / 目标在源内部：跳过
      if (fs.existsSync(dest)) {
        if (!overwrite && strategy === 'ask') {
          return { ok: false, conflict: true, name, count: files.length };
        }
        if (!overwrite && strategy === 'dedupe') {
          const deduped = path.join(dst, dedupeName(dst, name));
          pending.push({ src, name: path.basename(deduped), dest: deduped });
          continue;
        }
        // overwrite（或 dedupe 之外的既有路径）：类型不一致先清目标（目录 vs 文件无法合并）
        const srcIsDir = fs.statSync(src).isDirectory();
        const destIsDir = fs.statSync(dest).isDirectory();
        if (srcIsDir !== destIsDir) await fsp.rm(dest, { recursive: true, force: true });
      }
      pending.push({ src, name, dest });
    }
    const pasted = [];
    for (const it of pending) {
      await fsp.cp(it.src, it.dest, { recursive: true, force: true, errorOnExist: false });
      await markSelfWrite(it.dest); // 目标可能被本窗口监听：吸收自写回声
      approve(it.dest);             // 粘贴进来的文件立即可编辑（等同拖拽打开后的 approve 语义）
      pasted.push(it.dest);
    }
    return { ok: true, pasted, skipped: files.length - pasted.length };
  });
}

module.exports = { registerFileIpc, isInside, readRangeBytes };
