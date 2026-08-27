const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  writeFile: (p, c) => ipcRenderer.invoke('fs:write-file', p, c),
  writeExternal: (p, c) => ipcRenderer.invoke('fs:write-external', p, c), // 测试用
  writeBinary: (p, buf) => ipcRenderer.invoke('fs:write-binary', p, buf),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  copyImage: (p) => ipcRenderer.invoke('clipboard:write-image', p),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
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

  // 右键菜单打开目录
  onOpenDir: (cb) => ipcRenderer.on('open-dir', (_e, dir) => cb(dir)),

  // AI 大模型
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiAbort: () => ipcRenderer.invoke('ai:abort'),
  aiToolResult: (results) => ipcRenderer.invoke('ai:tool-result', results),
  onAiToolCall: (cb) => ipcRenderer.on('ai:tool-call', (_e, d) => cb(d)),
  onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (_e, d) => cb(d)),
  onAiDone: (cb) => ipcRenderer.on('ai:done', (_e, d) => cb(d)),
});
