const { contextBridge, ipcRenderer, webUtils } = require('electron');

// v0.3.0：open-dir（右键「用 MarkHunter 打开」/ 二次启动 --dir）改为「缓冲 + 拉取」双通道。
// 背景：主进程在 did-finish-load 推送，而渲染端 boot 要到若干次 await 之后才注册监听；
// 更糟的是 boot 的目录恢复分支一旦先跑起来，事件会在恢复期间到达并被静默吞掉
// （实测：只要用户有 lastDirectory/侧栏根/上次会话，右键目录 100% 打不开）。
// 这里在 preload 立刻登记监听并缓存最后一次目标目录，渲染端随时可 takeOpenDir() 取走。
//
// v0.3.0 补漏：仅靠上面的 ipc 事件仍不稳定 —— boot 的 takeOpenDir() 早于 did-finish-load 时
// 拿到 null，于是先恢复上次侧栏根/上次会话，再把 --dir 目标当"事后事件"追加（实测
// roots=[上次根, 目标]，坏路径则完全没有可见提示）。主进程改用 additionalArguments 把本次启动的
// 目标目录带进渲染进程 argv，preload 阶段（文档开始、任何页面脚本之前）即可同步取到 → 作为
// pendingOpenDir 的初值，boot 的 takeOpenDir() 必然命中它。编码经 decodeURIComponent 还原。
const launchDir = (() => {
  try {
    const hit = process.argv.find((s) => typeof s === 'string' && s.startsWith('--mh-open-dir='));
    return hit ? decodeURIComponent(hit.slice('--mh-open-dir='.length)) : null;
  } catch { return null; }
})();
let pendingOpenDir = launchDir || null;
let openDirCb = null;
const openDirQueue = [];
ipcRenderer.on('open-dir', (_e, dir) => {
  if (!dir) return;
  pendingOpenDir = dir;
  if (openDirCb) openDirCb(dir);
  else openDirQueue.push(dir);
});

contextBridge.exposeInMainWorld('api', {
  // 拖拽 File → 真实路径：Electron 32 起 File.path 已移除，须经 webUtils 解析（drop 处理用）
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // 对话框
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  selectFile: (opts) => ipcRenderer.invoke('dialog:select-file', opts),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),

  // 文件系统
  readTree: (dir) => ipcRenderer.invoke('fs:read-tree', dir),
  readFile: (p) => ipcRenderer.invoke('fs:read-file', p),
  // P7：按 range 分段读取大文件（返回 { bytes: ArrayBuffer, start, end, size, mtime }，渲染端流式解码）
  readFileRange: (p, start, length) => ipcRenderer.invoke('fs:read-file-range', p, start, length),
  // 1B-7：超大文档分块流式写（open → append×N → close；close 时主进程统一标记自写）
  writeStreamOpen: (p) => ipcRenderer.invoke('fs:write-stream-open', p),
  writeStreamAppend: (id, content) => ipcRenderer.invoke('fs:write-stream-append', id, content),
  writeStreamClose: (id) => ipcRenderer.invoke('fs:write-stream-close', id),
  // 1B-2：大文件查看器区域写回（[offset, offset+oldLength) 替换为 content，流式拼接后原子覆盖）
  spliceFile: (p, offset, oldLength, content) => ipcRenderer.invoke('fs:splice-file', p, offset, oldLength, content),
  // 1B-5：行号 → 字节偏移（流式统计换行；全局搜索命中大文件定位用）
  findLineOffset: (p, line) => ipcRenderer.invoke('fs:find-line-offset', p, line),
  setRootDir: (dir) => ipcRenderer.invoke('fs:set-root', dir),
  // v0.2.3 多目录：整表同步侧栏根集合 + 活动目录；跨目录拖拽传输（复制/移动）
  setRootDirs: (dirs, active) => ipcRenderer.invoke('fs:set-roots', dirs, active),
  transferFiles: (src, destDir, mode, opts) => ipcRenderer.invoke('fs:transfer', src, destDir, mode, opts),
  writeFile: (p, c) => ipcRenderer.invoke('fs:write-file', p, c),
  writeExternal: (p, c) => ipcRenderer.invoke('fs:write-external', p, c), // 测试用
  writeBinary: (p, buf) => ipcRenderer.invoke('fs:write-binary', p, buf),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  copyImage: (p) => ipcRenderer.invoke('clipboard:write-image', p),
  // 在资源管理器中显示文件（预览图片/图片标签页右键菜单用）
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  // 0.5.0 Phase 5a F2：右键「常用项」三条通道（主进程侧一律过 security.requireApproved）
  //   openPath     → shell.openPath（用默认程序打开；未批准/不存在时返回 {ok:false,reason}）
  //   openTerminal → 路径**只作为 cwd** 传给子进程（argv 恒空、shell:false，不做任何字符串拼接）
  //   copyText     → 写剪贴板，必须带来源路径（{ path, text, kind }）并过白名单
  openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
  openTerminal: (p, opts) => ipcRenderer.invoke('shell:open-terminal', p, opts),
  copyText: (payload) => ipcRenderer.invoke('clipboard:write-text', payload),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  // v0.6.0：文件树与系统剪贴板互通（复制 = CF_HDROP 写入，Explorer 可直接 Ctrl+V；
  // 粘贴 = 读回 CF_HDROP 复制进目标目录；readFiles 为只读探测面）
  clipboardCopyFiles: (paths) => ipcRenderer.invoke('clipboard:copy-files', paths),
  clipboardReadFiles: () => ipcRenderer.invoke('clipboard:read-files'),
  pasteFiles: (destDir, opts) => ipcRenderer.invoke('fs:paste-files', destDir, opts),
  watchFile: (p, mtime) => ipcRenderer.invoke('fs:watch-file', p, mtime),
  unwatchFile: (p) => ipcRenderer.invoke('fs:unwatch-file', p),
  onFileChanged: (cb) => ipcRenderer.on('file-changed', (_e, d) => cb(d)),
  create: (parent, name, type) => ipcRenderer.invoke('fs:create', parent, name, type),
  remove: (p, isDir) => ipcRenderer.invoke('fs:delete', p, isDir),
  rename: (oldPath, newName) => ipcRenderer.invoke('fs:rename', oldPath, newName),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 运行环境（打包版不暴露 window.__app 测试接口）
  isPackaged: () => ipcRenderer.invoke('app:is-packaged'),

  // 全局搜索（P6：主进程转发 utilityProcess worker；支持取消与进度订阅）
  globalSearch: (dir, query) => ipcRenderer.invoke('search:global', { dir, query }),
  globalSearchCancel: () => ipcRenderer.invoke('search:cancel'),
  // 0.5.0 Phase 5a A1：工作目录文件清单（Ctrl+P 快速打开）——**只读清单**，不读文件内容。
  // 解析值 { files, total, cached, truncated }；分批进度见 onSearchFilesProgress。
  searchFiles: (dir) => ipcRenderer.invoke('search:files', { dir }),
  searchFilesCancel: () => ipcRenderer.invoke('search:files-cancel'),
  onSearchFilesProgress: (cb) => {
    const wrapped = (_e, d) => cb(d);
    ipcRenderer.on('search:files-progress', wrapped);
    return () => ipcRenderer.removeListener('search:files-progress', wrapped); // 返回退订函数
  },
  onGlobalSearchProgress: (cb) => {
    const wrapped = (_e, d) => cb(d);
    ipcRenderer.on('search:progress', wrapped);
    return () => ipcRenderer.removeListener('search:progress', wrapped); // 返回退订函数
  },

  // Python
  detectPython: () => ipcRenderer.invoke('python:detect'),
  runPython: (filePath, pythonPath) => ipcRenderer.invoke('python:run', { filePath, pythonPath }),
  killPython: () => ipcRenderer.invoke('python:kill'),
  onPythonStart: (cb) => ipcRenderer.on('python:start', (_e, d) => cb(d)),
  onPythonOutput: (cb) => ipcRenderer.on('python:output', (_e, d) => cb(d)),
  onPythonExit: (cb) => ipcRenderer.on('python:exit', (_e, d) => cb(d)),

  // 右键菜单打开目录：注册回调时会把「注册前已到达」的目标目录立刻补发一次（不丢事件）
  onOpenDir: (cb) => {
    openDirCb = cb;
    while (openDirQueue.length) {
      const d = openDirQueue.shift();
      try { cb(d); } catch { /* 渲染端异常不影响后续 */ }
    }
  },
  // 主动拉取待应用的目标目录（boot 结束前调用一次，双保险）
  takeOpenDir: () => {
    const d = pendingOpenDir;
    pendingOpenDir = null;
    openDirQueue.length = 0;
    return d;
  },

  // v0.1.51 多窗口
  openNewWindow: () => ipcRenderer.invoke('win:new'),
  // 设置/主题跨窗口广播（其它窗口改设置时本窗口即时应用）
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  // 同文件被另一窗口打开（本窗口为后来者 → 自动转只读；标签右键可解除）
  onFileSharedOpen: (cb) => ipcRenderer.on('file-shared-open', (_e, d) => cb(d)),

  // ---------- v0.5.0 多视图 Phase 4：跨窗口「接管编辑」锁表（实现在 src/main/filewatch.js） ----------
  // 语义：普通标签的编辑权由主进程锁表按 (path, 窗口) 记账 —— 首个打开者 = 编辑权持有者，
  // 后来的窗口只读观察窗；观察窗可经 claimEdit 抢走编辑权（原窗口转只读 + toast）。
  // **大文件例外**：`huge:*` 编辑会话的所有权走 overlay-ipc 的路径单例规则（WINDOW_NOT_OWNER），
  // 与这套通道无关（两条并行规则，见 filewatch.js 顶部说明）。
  claimEdit: (p) => ipcRenderer.invoke('doc:claim-edit', p),     // → { ok, mode:'edit', owner, exclusive, demoted } | { ok:false, reason }
  releaseEdit: (p) => ipcRenderer.invoke('doc:release-edit', p), // → { ok, mode:'read', wasEdit, notified }
  docLockState: (p) => ipcRenderer.invoke('doc:lock-state', p),  // → { path, self, mode, watching, owner, others, editCount, multiEdit, conflictPrompt }
  // L3 开关（默认关）：打开后 claim 不再降级其它窗口（多窗口同时可编辑），冲突由渲染端横幅提示
  setConflictPrompt: (on) => ipcRenderer.invoke('doc:set-conflict-prompt', on),
  getConflictPrompt: () => ipcRenderer.invoke('doc:get-conflict-prompt'),
  // 锁变更订阅：**返回退订函数**（契约同 onHugeIndexProgress）
  onFileLockChanged: (cb) => {
    const wrapped = (_e, d) => cb(d);
    ipcRenderer.on('file-lock-changed', wrapped);
    return () => ipcRenderer.removeListener('file-lock-changed', wrapped);
  },

  // v0.4.0 大文件行索引（虚拟滚动查看器 / 快速搜索的定位基础）
  hugeIndex: (p, opts) => ipcRenderer.invoke('huge:index', p, opts), // opts.force=true 跳过缓存强制重扫
  hugeLineOffset: (p, line) => ipcRenderer.invoke('huge:line-offset', p, line),
  hugeOffsetLine: (p, offset) => ipcRenderer.invoke('huge:offset-line', p, offset),
  // v0.4.0 批量取行：一次 IPC 取整个视口（from 为 1 基行号）
  // 返回 { lines: [{ line, text, truncated?, chars? }], endLine, start, bytes, eof, encoding }
  hugeLines: (p, from, count) => ipcRenderer.invoke('huge:lines', { file: p, from, count }),
  hugeIndexDrop: (p) => ipcRenderer.invoke('huge:index-drop', p),
  // 索引进度订阅：返回退订函数（查看器 destroy 时必须调用，否则监听器随标签累积泄漏）
  onHugeIndexProgress: (cb) => {
    const wrapped = (_e, d) => cb(d);
    ipcRenderer.on('huge:index-progress', wrapped);
    return () => ipcRenderer.removeListener('huge:index-progress', wrapped); // 返回退订函数
  },

  // v0.4.0 大文件 overlay 编辑（Phase D 第二步；通道实现在 src/main/overlay-ipc.js）
  // 约定：**统一单对象入参**（风格同 hugeLines），行号 1 基；所有写通道要带 docId（open 返回的句柄）
  hugeDocOpen: (arg) => ipcRenderer.invoke('huge:doc-open', arg), // { file, force?, opts? } → { docId, lines, blocks, editable, ... }
  hugeDocClose: (arg) => ipcRenderer.invoke('huge:doc-close', arg), // { docId, discard? } → { discarded, kept }
  hugeDocState: (arg) => ipcRenderer.invoke('huge:doc-state', arg), // { docId } → 脏标记/底纹区间/undo 深度/baseChanged
  // { docId, from, count } → { lines:[{line,text,truncated?,chars?}], endLine, start, bytes, eof, encoding, block, ... }
  hugeDocLines: (arg) => ipcRenderer.invoke('huge:doc-lines', arg),
  hugeDocLine: (arg) => ipcRenderer.invoke('huge:doc-line', arg), // { docId, line } → 单行**完整**文本（不受 40000 截断）
  hugeDocLineOffset: (arg) => ipcRenderer.invoke('huge:doc-line-offset', arg), // { docId, line } → { offset, block, inBlock }
  hugeDocOffsetLine: (arg) => ipcRenderer.invoke('huge:doc-offset-line', arg), // { docId, offset } → { line, block, inBlock, eof }
  hugeDocEdit: (arg) => ipcRenderer.invoke('huge:doc-edit', arg), // { docId, from, deleteCount, lines, trailingNewline? }
  hugeDocInsert: (arg) => ipcRenderer.invoke('huge:doc-insert', arg), // { docId, line, col, text }
  hugeDocDelete: (arg) => ipcRenderer.invoke('huge:doc-delete', arg), // { docId, fromLine, fromCol, toLine, toCol }
  hugeDocSplice: (arg) => ipcRenderer.invoke('huge:doc-splice', arg), // { docId, fromLine, fromCol, toLine, toCol, text }
  hugeDocUndo: (arg) => ipcRenderer.invoke('huge:doc-undo', arg), // { docId } → { undone, lines, bytes, undoDepth, redoDepth }
  hugeDocRedo: (arg) => ipcRenderer.invoke('huge:doc-redo', arg),
  hugeDocSave: (arg) => ipcRenderer.invoke('huge:doc-save', arg), // { docId, target? }（target 缺省=源文件，给出即另存为）
  hugeDocSaveCancel: (arg) => ipcRenderer.invoke('huge:doc-save-cancel', arg), // { docId } → 打断进行中的保存
  hugeDocRecoverList: (arg) => ipcRenderer.invoke('huge:doc-recover-list', arg), // { limit? } → 崩溃恢复候选
  // 保存进度订阅：返回退订函数（契约同 onHugeIndexProgress；终态 phase 为 done / failed，必须据此收尾）
  onHugeDocSaveProgress: (cb) => {
    const wrapped = (_e, d) => cb(d);
    ipcRenderer.on('huge:doc-save-progress', wrapped);
    return () => ipcRenderer.removeListener('huge:doc-save-progress', wrapped); // 返回退订函数
  },
  // 保存成功通知（单向）：渲染端据此重建索引 / 重挂文件监听 / 清空脏标记
  onHugeDocSaved: (cb) => {
    const wrapped = (_e, d) => cb(d);
    ipcRenderer.on('huge:doc-saved', wrapped);
    return () => ipcRenderer.removeListener('huge:doc-saved', wrapped); // 返回退订函数
  },

});
