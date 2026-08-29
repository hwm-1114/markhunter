const { app, BrowserWindow, clipboard, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const { registerFileIpc } = require('./ipc');
const { registerSearchIpc } = require('./search');
const { registerPythonIpc } = require('./python');
const { registerSettingsIpc, loadSettings, DARK_THEMES } = require('./settings');
const { registerWatchIpc, markSelfWrite, stopAllWatches } = require('./filewatch');
const { registerAiIpc } = require('./ai');

let mainWindow = null;        // 首窗口（smoke/测试钩子绑定；多窗口下仅作其中之一）
const allWindows = new Set(); // v0.1.51：窗口集合（window-all-closed 以其清空为准）

function getWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// 右键菜单传入的目录参数：MarkHunter.exe --dir <path>（second-instance 携带 argv）
function extractDirArg(argv) {
  const i = argv.indexOf('--dir');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return null;
}
const dirArg = extractDirArg(process.argv);

function createWindow(opts = {}) {
  // 防闪白第一层：暗色主题（DARK_THEMES 25 个，含 fx 暗色特效款）设深色窗口底色
  const themeName = loadSettings().theme;
  const isDarkTheme = DARK_THEMES.includes(themeName);
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'MarkHunter',
    autoHideMenuBar: true,
    backgroundColor: isDarkTheme ? '#1d232a' : '#f5f7fa',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  allWindows.add(win);
  if (!mainWindow) mainWindow = win;

  // 导航防护：新窗口只允许系统浏览器打开 http/https，其余一律拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 导航防护：仅允许停留在应用自身 index.html，其余导航一律拦截
  win.webContents.on('will-navigate', (event, url) => {
    const ok = /^file:.*index\.html/i.test(String(url || ''));
    if (!ok) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 右键「用 MarkHunter 打开」/二次启动 --dir：以指定目录作为该窗口工作目录
  const winDir = opts.dir || (win === mainWindow ? dirArg : null);
  if (winDir) {
    win.webContents.on('did-finish-load', () => {
      try {
        win.webContents.send('open-dir', winDir);
      } catch { /* 窗口已销毁 */ }
    });
  }

  // 冒烟/扩展测试模式：仅首窗口绑定（scripts/smoke.js 在 src 内随 asar 打包但打包版不启用）
  if (win === mainWindow && !opts.noTestHooks) {
    for (const flag of ['--smoke', '--mmtest', '--exttest']) {
      if (process.argv.includes(flag)) {
        const mod = { '--smoke': 'smoke', '--mmtest': 'mm-test', '--exttest': 'ext-test' }[flag];
        try {
          const m = require('../../scripts/' + mod);
          if (m.runSmoke) m.runSmoke(win);
          else if (m.run) m.run(win);
        } catch {
          /* 打包后的应用不包含测试脚本，忽略 */
        }
      }
    }
  }

  win.on('closed', () => {
    allWindows.delete(win);
    if (mainWindow === win) mainWindow = allWindows.values().next().value || null;
  });
  return win;
}

// ---------- v0.1.51：多窗口 ----------
// 新建窗口（Ctrl+Shift+N）：每窗口独立渲染上下文（各自标签/目录/面板），主进程共享设置与安全状态
ipcMain.handle('win:new', () => {
  createWindow();
  return true;
});

// 单实例：二次启动不再开新进程，而是在本实例开新窗口（携带 --dir 时以该目录开窗）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const d = extractDirArg(argv);
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    createWindow(d ? { dir: d } : {});
  });
}

app.whenReady().then(() => {
  registerSettingsIpc();
  registerFileIpc(getWindow);
  registerSearchIpc();
  registerPythonIpc(getWindow);
  registerWatchIpc();
  registerAiIpc(getWindow);

  // 运行环境查询（渲染进程据此决定是否暴露 window.__app 测试接口）
  ipcMain.handle('app:is-packaged', () => app.isPackaged);

  // 新建窗口快捷指令（preload 暴露 window.api.openNewWindow）
  // —— 已在上方注册 win:new

  // 复制图片到剪贴板（图片详情弹窗用）
  ipcMain.handle('clipboard:write-image', async (_e, filePath) => {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) throw new Error('无法读取图片文件');
    clipboard.writeImage(img);
    const size = img.getSize();
    return { width: size.width, height: size.height };
  });

  // 读取剪贴板纯文本（编辑器右键「粘贴为纯文本」用）
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());

  // 在资源管理器中显示文件（预览图片/图片标签页右键菜单用；只读操作不涉路径校验）
  ipcMain.handle('shell:show-in-folder', (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopAllWatches();
});
