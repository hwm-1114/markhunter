const { app, BrowserWindow, clipboard, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const { registerFileIpc } = require('./ipc');
const { registerSearchIpc } = require('./search');
const { registerPythonIpc } = require('./python');
const { registerSettingsIpc } = require('./settings');
const { registerWatchIpc, markSelfWrite, stopAllWatches } = require('./filewatch');
const { registerAiIpc } = require('./ai');

let mainWindow = null;

function getWindow() {
  return mainWindow;
}

// 右键菜单传入的目录参数：MarkHunter.exe --dir <path>
const dirArg = (() => {
  const i = process.argv.indexOf('--dir');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return null;
})();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'MarkHunter',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // 渲染进程沙箱：preload 仅用 contextBridge/ipcRenderer，兼容
      spellcheck: false,
    },
  });

  // 导航防护：新窗口只允许系统浏览器打开 http/https，其余一律拒绝
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 导航防护：仅允许停留在应用自身 index.html，其余导航一律拦截
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const ok = /^file:.*index\.html/i.test(String(url || ''));
    if (!ok) event.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // 右键「用 MarkHunter 打开」：以指定目录作为工作目录
  mainWindow.webContents.on('did-finish-load', () => {
    if (dirArg) {
      console.log('[markhunter-open-dir]', dirArg);
      mainWindow.webContents.send('open-dir', dirArg);
    }
  });

  // 冒烟测试模式：npm run smoke 用（加载完成后打印结果并退出；仅开发环境有该脚本）
  if (process.argv.includes('--smoke')) {
    try {
      const { runSmoke } = require('../../scripts/smoke');
      runSmoke(mainWindow);
    } catch {
      /* 打包后的应用不包含 smoke 脚本，忽略 */
    }
  }
  if (process.argv.includes('--mmtest')) {
    try {
      const { run } = require('../../scripts/mm-test');
      run(mainWindow);
    } catch {
      /* 打包后的应用不包含测试脚本，忽略 */
    }
  }
  if (process.argv.includes('--exttest')) {
    try {
      const { run } = require('../../scripts/ext-test');
      run(mainWindow);
    } catch {
      /* 打包后的应用不包含测试脚本，忽略 */
    }
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
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
