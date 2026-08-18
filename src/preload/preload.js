const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 对话框
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  selectFile: (opts) => ipcRenderer.invoke('dialog:select-file', opts),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),

  // 文件系统
  readTree: (dir) => ipcRenderer.invoke('fs:read-tree', dir),
  readFile: (p) => ipcRenderer.invoke('fs:read-file', p),
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

  // 全局搜索
  globalSearch: (dir, query) => ipcRenderer.invoke('search:global', { dir, query }),

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
