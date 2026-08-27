const { app, ipcMain, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// S6：settings:set 白名单（未知键一律丢弃；aiApiKeyClear 为一次性命令键，不落盘）
const ALLOWED_KEYS = new Set([
  'pythonPath',
  'maxFileSizeMB',
  'autoSaveDelay',
  'wordWrap',
  'scrollbarWidth',
  'indentSize',
  'theme',
  'lastDirectory',
  'aiBaseUrl',
  'aiModel',
  'aiModelType',
  'aiAskBeforeApply',
  'aiApiKey',
  'aiApiKeyClear',
  'favoriteDirs',
  'lastSession',
]);

// 主题引擎：36 个合法主题名（daisyUI 5.7.18 内置 35 + 自研经典 markhunter-classic；实证 theme/*.css = 35）
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
  theme: 'markhunter-classic', // 主题（36 款皮肤，见 THEME_NAMES；默认经典，老用户观感零变化）
  lastDirectory: '',     // 上次打开的工作目录
  lastSession: null,     // 上次会话快照（打开过的标签路径 + 活动标签下标；跨重启恢复）
  favoriteDirs: [],      // 收藏的本地目录（最多 50 个，保持添加顺序）
  // AI 大模型配置（OpenAI 兼容接口，DeepSeek 预置）
  aiApiKey: '',          // API Key（S5：存盘前经 safeStorage/DPAPI 加密，形如 enc:v1:<base64>）
  aiBaseUrl: 'https://api.deepseek.com', // 服务地址
  aiModel: 'deepseek-chat',              // 模型名（可自定义具体版本，如 deepseek-v4）
  aiModelType: 'latest', // 模型类型：latest(最新版)/reasoner(推理版)/custom(自定义)
  aiAskBeforeApply: true, // 修改文档前是否询问用户
};

const AI_KEY_PREFIX = 'enc:v1:';

let cache = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function persist(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const out = { ...s };
    delete out._aiKeyPlain; // 内部解密缓存不落盘
    fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败:', err);
  }
}

/** 加密 API Key；safeStorage 不可用时回退明文并告警 */
function encryptKey(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return AI_KEY_PREFIX + safeStorage.encryptString(String(plain)).toString('base64');
  }
  console.warn('[settings] safeStorage 不可用，API Key 将以明文保存在 settings.json');
  return String(plain);
}

/** 解密 API Key（仅供主进程内部使用，永不返回给渲染进程） */
function decryptKey(stored) {
  if (!stored) return '';
  if (stored.startsWith(AI_KEY_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(AI_KEY_PREFIX.length), 'base64'));
    } catch (err) {
      console.error('[settings] 解密 API Key 失败：', err && err.message);
      return '';
    }
  }
  return stored; // 旧明文（迁移场景）
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
  // API Key 处理：解密供主进程内部使用；检测到旧明文自动迁移为加密并重写文件
  if (cache.aiApiKey) {
    if (cache.aiApiKey.startsWith(AI_KEY_PREFIX)) {
      cache._aiKeyPlain = decryptKey(cache.aiApiKey);
    } else {
      const plain = cache.aiApiKey;
      cache.aiApiKey = encryptKey(plain);
      cache._aiKeyPlain = plain;
      persist(cache); // 迁移后立即重写为加密存储
    }
  } else {
    cache.aiApiKey = '';
    cache._aiKeyPlain = '';
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
  if (patch && '_aiKeyPlain' in patch) s._aiKeyPlain = patch._aiKeyPlain; // 内部解密缓存（不落盘）
  cache = s;
  persist(s);
  return s;
}

function getSettings() {
  return loadSettings();
}

/** 渲染进程安全视图：aiApiKey 一律返回 ''，仅暴露 aiApiKeySet 布尔 */
function toRendererSettings(s) {
  const out = { ...s };
  delete out._aiKeyPlain;
  out.aiApiKey = '';
  out.aiApiKeySet = !!s.aiApiKey;
  return out;
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get', () => toRendererSettings(loadSettings()));
  ipcMain.handle('settings:set', (_e, patch) => {
    const p = sanitizePatch(patch);
    if (p.aiApiKeyClear === true) {
      // 清除密钥
      p.aiApiKey = '';
      p._aiKeyPlain = '';
      delete p.aiApiKeyClear;
    } else if ('aiApiKey' in p) {
      if (p.aiApiKey) {
        // 非空 → 加密存储
        const plain = String(p.aiApiKey);
        p.aiApiKey = encryptKey(plain);
        p._aiKeyPlain = plain;
      } else {
        // 空字符串且已配置 → 保持不变（不清除）
        delete p.aiApiKey;
      }
    }
    // S6 延续：theme 值须在 36 个合法主题名内（非字符串/非法名一律静默丢弃，回退默认）
    if ('theme' in p && (typeof p.theme !== 'string' || !THEME_NAMES.includes(p.theme))) {
      delete p.theme;
    }
    delete p.aiApiKeyClear; // 保险：命令键不落盘
    return toRendererSettings(saveSettings(p));
  });
}

module.exports = { DEFAULTS, THEME_NAMES, DARK_THEMES, loadSettings, saveSettings, getSettings, registerSettingsIpc };
