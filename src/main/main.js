const { app, BrowserWindow, clipboard, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerFileIpc } = require('./ipc');
const { registerLineIndexIpc } = require('./lineindex');
const { registerSearchIpc } = require('./search');
const { registerPythonIpc } = require('./python');
const { registerSettingsIpc, loadSettings, DARK_THEMES } = require('./settings');
const { registerWatchIpc, markSelfWrite, stopAllWatches } = require('./filewatch');

let mainWindow = null;        // 首窗口（smoke/测试钩子绑定；多窗口下仅作其中之一）
const allWindows = new Set(); // v0.1.51：窗口集合（window-all-closed 以其清空为准）

// ---------- 测试隔离（v0.3.0） ----------
// 背景：--smoke/--mmtest/--exttest 过去直接使用真实 userData，测试会写脏用户配置
// （实测被改：theme、lastSession、lastDirectory、sidebarRoots、maxFileSizeMB、favoriteDirs）。
// 现在测试模式改用独立 profile；MH_USERDATA 环境变量让测试派生的子进程（模拟二次启动）共用同一 profile。
const TEST_FLAGS = ['--smoke', '--mmtest', '--exttest', '--bigprobe', '--bigperf'];
const testFlag = TEST_FLAGS.find((f) => process.argv.includes(f));
const envProfile = process.env.MH_USERDATA;
if (envProfile || testFlag) {
  const dir = envProfile || path.join(app.getPath('temp'), 'markhunter-test' + String(testFlag).replace('--', '-'));
  if (!envProfile) {
    // 每次运行从干净 profile 开始（残留文件被占用时忽略失败，复用即可）
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  app.setPath('userData', dir);
  process.env.MH_USERDATA = dir; // 子进程继承（second-instance 测试需要同一 profile 才走单实例锁）
  console.log('[test-isolation] userData =', dir);
}

function getWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// 右键菜单传入的目录参数：`MarkHunter.exe --dir <path>`（second-instance 会带上 argv）。
// 解析逻辑抽到 args.js（独立模块便于冒烟直接测）：Electron 在 second-instance 里会重排 argv，
// 只取「--dir 的下一个元素」会拿到 Chromium 注入的开关 → 右键目录被静默忽略。
const { extractDirArg } = require('./args');
const dirArg = extractDirArg(process.argv);

function createWindow(opts = {}) {
  // 防闪白第一层：暗色主题（DARK_THEMES 25 个，含 fx 暗色特效款）设深色窗口底色
  const themeName = loadSettings().theme;
  const isDarkTheme = DARK_THEMES.includes(themeName);
  // 右键「用 MarkHunter 打开」/二次启动 --dir：该窗口的工作目录。必须在 new BrowserWindow 之前算好 ——
  // 目标目录还要经 webPreferences.additionalArguments 同步交给 preload（见下）。
  // v0.3.0 补漏：过去只有 did-finish-load 的 open-dir 事件这一条通路，而渲染端 boot 在页面加载完成前
  // 就已跑过 takeOpenDir()（`app.js`「恢复上次目录与会话」段），事件沦为"事后事件"：
  // 实测冷启动 `--dir <目标>` 时侧栏同时出现上次的根与目标目录（roots=[上次根, 目标]，上次会话也照常恢复），
  // 坏路径更没有任何可见提示（静默失败）。preload 能同步取到目标后，boot 必然走「指定目录启动」分支。
  const winDir = opts.dir || (mainWindow ? null : dirArg);
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
      // 见 winDir 注释：preload 读 process.argv 还原。值须编码（F:\VibeCode\md工具 这类非 ASCII 路径直接传会乱码）
      additionalArguments: winDir ? ['--mh-open-dir=' + encodeURIComponent(winDir)] : [],
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
  // 双通道之一（另一通道 = additionalArguments 同步投递，见 createWindow 开头）；保留此事件以兼容
  // 「preload 已就绪但渲染端尚未 boot 完」以外的时序，两条通路都幂等（重复投递同一目录不产生副作用）
  if (winDir) {
    win.webContents.on('did-finish-load', () => {
      try {
        win.webContents.send('open-dir', winDir);
      } catch { /* 窗口已销毁 */ }
    });
  }

  // 冒烟/扩展测试模式：仅首窗口绑定（scripts/smoke.js 在 src 内随 asar 打包但打包版不启用）
  if (win === mainWindow && !opts.noTestHooks) {
    for (const flag of ['--smoke', '--mmtest', '--exttest', '--bigprobe', '--bigperf']) {
      if (process.argv.includes(flag)) {
        const mod = { '--smoke': 'smoke', '--mmtest': 'mm-test', '--exttest': 'ext-test', '--bigprobe': 'bigfile-probe', '--bigperf': 'bigperf' }[flag];
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
  registerLineIndexIpc(); // v0.4.0 大文件行索引（虚拟滚动/秒搜的定位基础）
  require('./overlay-ipc').registerOverlayIpc(); // v0.4.0 大文件 overlay 编辑通道（Phase D 第二步；须在行索引之后）
  registerSearchIpc();
  registerPythonIpc(getWindow);
  registerWatchIpc();

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
