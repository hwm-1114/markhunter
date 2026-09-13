// 命令行参数解析（独立模块：便于冒烟直接 require 测试，不必触碰 main.js 的副作用）
const fs = require('fs');
const path = require('path');

/**
 * 解析右键菜单 / 二次启动传入的目标目录：`MarkHunter.exe --dir <path>`。
 *
 * v0.3.0 加固背景：Electron 在 second-instance 事件里会**重排 argv** —— 实测 dev 下 `--dir`
 * 与它的值被拆开：["electron.exe","--dir","--allow-file-access-from-files","<appPath>","<目标>"]，
 * 只取「--dir 的下一个元素」会拿到 Chromium 注入的开关，导致右键打开的目录被静默忽略。
 *
 * 取值顺序：
 *   ① `--dir=<path>`；
 *   ② `--dir <path>`（值不以 '-' 开头）；
 *   ③ 从后往前找第一个「确实存在的目录」（排除可执行文件与应用目录本身）；
 *   ④ 兜底：最后一个「看起来像路径」的非开关参数（目标不存在时也交给渲染端报错）。
 *      **仅在 argv 里确实出现过 `--dir`/`--dir=` 时才启用** —— 否则 process.argv[0]（可执行文件绝对
 *      路径，如 `...\node_modules\electron\dist\electron.exe` 或 `C:\Program Files\MarkHunter\MarkHunter.exe`）
 *      会被当成目标目录：实测 `npm start` / `electron . --smoke` / 打包版双击启动都会命中，
 *      渲染端于是拿到一个"目录"做 readTree（ENOTDIR）、弹「无法打开指定目录」并跳过上次会话恢复。
 *      安装包的右键菜单与「我的电脑」盘符项固定传 `--dir "%V"`（build/installer.nsh），故该收紧无副作用。
 * 均不匹配时返回 null。
 */
function extractDirArg(argv, opts = {}) {
  const list = Array.isArray(argv) ? argv : [];
  const selfPath = opts.appPath
    || (() => { try { return require('electron').app.getAppPath(); } catch { return ''; } })();
  const self = (() => { try { return path.resolve(selfPath); } catch { return ''; } })();
  const exe = (() => {
    try { return path.resolve(opts.execPath || process.execPath); } catch { return ''; }
  })();
  const hasDirFlag = list.some((a) => typeof a === 'string' && (a === '--dir' || a.startsWith('--dir=')));

  const candidates = [];
  for (const a of list) {
    if (typeof a === 'string' && a.startsWith('--dir=')) candidates.push(a.slice('--dir='.length));
  }
  const i = list.indexOf('--dir');
  if (i >= 0 && typeof list[i + 1] === 'string' && list[i + 1] && !list[i + 1].startsWith('-')) {
    candidates.push(list[i + 1]);
  }
  for (const p of candidates) {
    try {
      if (p && fs.statSync(p).isDirectory()) return p;
    } catch { /* 试下一个 */ }
  }
  for (let k = list.length - 1; k >= 0; k--) {
    const a = list[k];
    if (typeof a !== 'string' || !a || a.startsWith('-')) continue;
    try {
      if (fs.statSync(a).isDirectory() && path.resolve(a) !== self) return a;
    } catch { /* 忽略 */ }
  }
  if (!hasDirFlag) return null; // 见文档 ④：没有 --dir 时不得把可执行文件/位置参数当成目标目录
  for (let k = list.length - 1; k >= 0; k--) {
    const a = list[k];
    if (typeof a !== 'string' || !a || a.startsWith('-')) continue;
    const looksLikePath = /^[A-Za-z]:[\\/]/.test(a) || a.startsWith('\\\\') || a.includes('/') || a.includes('\\');
    if (looksLikePath && path.resolve(a) !== self && path.resolve(a) !== exe) return a;
  }
  return candidates.length ? candidates[0] : null;
}

module.exports = { extractDirArg };
