const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// S6：settings:set 白名单（未知键一律丢弃）
const ALLOWED_KEYS = new Set([
  'pythonPath',
  'maxFileSizeMB',
  'autoSaveDelay',
  'wordWrap',
  'scrollbarWidth',
  'indentSize',
  'theme',
  'lastDirectory',
  'favoriteDirs',
  'lastSession',
  'sidebarRoots',
  // 0.5.0 Phase 5a B8：编辑器 / 预览字号与行高（渲染端以 CSS 变量落地）
  'editorFontSize',
  'editorLineHeight',
  'previewFontSize',
  // 0.5.0 Phase 5a E2：侧栏分区折叠态（{ fav, tree, search } 三个布尔）
  'sidebarCollapsed',
  // 右侧收藏栏（fav 从左侧栏搬到右栏）：开合 / pin 常显 / 宽度
  'favRailOpen',
  'favRailPinned',
  'favRailWidth',
]);

// 主题引擎：56 个合法主题名（daisyUI 内置 35 + 自研经典 markhunter-classic + 特效皮肤 20）
// 清单与 docs/开发计划-多主题皮肤.md §3.3.2 分组表一致；非法主题名在 settings:set 静默丢弃（延续 S6 风格）
const THEME_NAMES = [
  'markhunter-classic', // 自研经典（应用默认，与 0.1.42 浅色视觉一致）
  // 浅色 21（内置 color-scheme: light）
  'light', 'cupcake', 'bumblebee', 'emerald', 'corporate', 'retro', 'cyberpunk',
  'valentine', 'garden', 'lofi', 'pastel', 'fantasy', 'wireframe', 'cmyk',
  'autumn', 'acid', 'lemonade', 'winter', 'nord', 'caramellatte', 'silk',
  // 暗色 14（内置 color-scheme: dark，实证清单 §3.2.7）
  'dark', 'synthwave', 'halloween', 'forest', 'aqua', 'black', 'luxury',
  'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss',
  // 特效皮肤 20（v0.1.50：9 浅 + 11 深；调色板 tailwind-input.css，动画 styles.css）
  'fx-aurora', 'fx-sakura', 'fx-ocean', 'fx-ice', 'fx-rainbow', 'fx-glass',
  'fx-forest', 'fx-lavender', 'fx-gold',
  'fx-neon', 'fx-matrix', 'fx-starry', 'fx-fire', 'fx-crt', 'fx-vapor',
  'fx-deep', 'fx-ink', 'fx-cyber', 'fx-quantum', 'fx-eclipse',
];

// 暗色主题清单：供主进程窗口底色（防闪白第一层）与 mermaid 明暗切换
const DARK_THEMES = [
  'dark', 'synthwave', 'halloween', 'forest', 'aqua', 'black', 'luxury',
  'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss',
  // 特效暗色 11 款
  'fx-neon', 'fx-matrix', 'fx-starry', 'fx-fire', 'fx-crt', 'fx-vapor',
  'fx-deep', 'fx-ink', 'fx-cyber', 'fx-quantum', 'fx-eclipse',
];

const DEFAULTS = {
  pythonPath: '',        // 自定义 Python 解释器路径，空 = 自动检测
  maxFileSizeMB: 50,     // 大文件上限（MB）
  autoSaveDelay: 800,    // 自动保存防抖（ms）
  wordWrap: true,        // 自动换行
  scrollbarWidth: 10,    // 滚动条滑块宽度（px）
  indentSize: 4,         // Tab 键插入的空格数（1~8，Shift+Tab 反向缩进）
  theme: 'markhunter-classic', // 主题（56 款皮肤，见 THEME_NAMES；默认经典，老用户观感零变化）
  lastDirectory: '',     // 上次打开的工作目录
  lastSession: null,     // 上次会话快照（打开过的标签路径 + 活动标签下标；跨重启恢复）
  favoriteDirs: [],      // 收藏的本地目录（最多 50 个，保持添加顺序）
  sidebarRoots: [],      // v0.2.3 侧栏多目录根列表（最多 12 个；活动目录由 lastDirectory 记录）
  // 0.5.0 Phase 5a B8：字号 / 行高（默认值 = 改造前的硬编码值，老用户观感零变化）。
  // 范围夹取在渲染端做（settings.js 只负责白名单与默认值，保持"脏数据不落库"的既有风格）。
  editorFontSize: 13.5,  // 编辑器字号（px，10~32）
  editorLineHeight: 1.65, // 编辑器行高（倍数，1~2.6）
  previewFontSize: 14.5, // 预览字号（px，10~32）
  // 0.5.0 Phase 5a E2：侧栏三分区折叠态 { fav, tree, search }（缺省 = 全展开，老用户观感零变化）
  sidebarCollapsed: {},
  // 右侧收藏栏（渲染端夹取/归一化，与字号等键同口径：本文件只管白名单与默认值）：
  //   pinned=true → 挤压式常驻；!pinned && open → 覆盖式浮层；!pinned && !open → 隐藏。
  favRailOpen: false,   // 收藏栏开合（bool）
  favRailPinned: false, // 收藏栏 pin 常显（bool；true 时隐含可见，open 键不参与其中判定）
  favRailWidth: 260,    // 收藏栏宽度（px，渲染端夹取 200~480）
};

/** v0.2.3 sidebarRoots 规范化：仅保留字符串项、去重（Windows 大小写不敏感）、上限 12 */
function normalizeSidebarRoots(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const d of list) {
    if (typeof d !== 'string' || !d) continue;
    const key = process.platform === 'win32' ? d.toLowerCase() : d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= 12) break;
  }
  return out;
}

let cache = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function persist(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ ...s }, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

function loadSettings() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const data = JSON.parse(raw);
    cache = { ...DEFAULTS, ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}) };
  } catch {
    cache = { ...DEFAULTS };
  }
  // 主题名校验（S6 延续）：非法/旧值静默回退默认，防止脏数据进入渲染层
  if (!THEME_NAMES.includes(cache.theme)) cache.theme = DEFAULTS.theme;
  // sidebarRoots 规范化（旧版无此键 → 默认 []；脏数据防御）
  cache.sidebarRoots = normalizeSidebarRoots(cache.sidebarRoots);
  // v0.3.0：AI 功能整体移除 —— 清掉旧版本遗留的 AI 配置键（含经 DPAPI 加密的 API Key），
  // 避免无用字段（尤其密钥）长期留在 settings.json；一次性迁移，写回后不再出现。
  const staleAiKeys = Object.keys(cache).filter((k) => /^ai[A-Z]/.test(k) || k === '_aiKeyPlain');
  if (staleAiKeys.length) {
    for (const k of staleAiKeys) delete cache[k];
    persist(cache);
  }
  return cache;
}

/** S6：只保留白名单键，构建新对象后合并（防 __proto__ 污染） */
function sanitizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const out = {};
  for (const k of Object.keys(patch)) {
    if (ALLOWED_KEYS.has(k)) out[k] = patch[k];
  }
  return out;
}

function saveSettings(patch) {
  const s = loadSettings();
  const clean = sanitizePatch(patch);
  Object.assign(s, clean);
  s.sidebarRoots = normalizeSidebarRoots(s.sidebarRoots); // v0.2.3：多目录列表落盘前规范化
  cache = s;
  persist(s);
  return s;
}

function getSettings() {
  return loadSettings();
}

/** 渲染进程视图：浅拷贝（不再有需要屏蔽的密钥字段） */
function toRendererSettings(s) {
  return { ...s };
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get', () => toRendererSettings(loadSettings()));
  ipcMain.handle('settings:set', (e, patch) => {
    const p = sanitizePatch(patch);
    // S6 延续：theme 值须在合法主题名内（非字符串/非法名一律静默丢弃，回退默认）
    if ('theme' in p && (typeof p.theme !== 'string' || !THEME_NAMES.includes(p.theme))) {
      delete p.theme;
    }
    const result = toRendererSettings(saveSettings(p));
    // v0.1.51 多窗口：设置/主题变更广播到其它窗口（排除发起窗口），各窗口即时换肤/更新缓存
    try {
      const { BrowserWindow } = require('electron');
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed() || w.webContents === e.sender) continue;
        w.webContents.send('settings:changed', result);
      }
    } catch { /* 忽略广播失败 */ }
    return result;
  });
}

module.exports = { DEFAULTS, THEME_NAMES, DARK_THEMES, loadSettings, saveSettings, getSettings, registerSettingsIpc };
