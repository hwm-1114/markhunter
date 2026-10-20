// 左侧文件树
// v0.2.3 多目录：侧栏可同时打开多个目录（roots 列表，每个根一个树分支），
// 目录树行可拖拽传输：拖到任意目录行 = 移动（Ctrl+拖 = 复制），跨目录/跨根均可。
import { $, formatSize, escapeHtml, showPrompt, confirmDialog, toast, showContextMenu, hideContextMenu, baseName, openModal, closeModal } from './ui.js';

const FILE_ICONS = {
  md: '📝', markdown: '📝', json: '🧾', py: '🐍', txt: '📄',
  js: '🟨', ts: '🟦', html: '🌐', css: '🎨', csv: '📊', log: '📋',
};

function iconFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return FILE_ICONS[ext] || '📄';
}

/** 规范化路径键：小写 + 正斜杠（Windows 下 Explorer 路径与 readdir 返回的大小写/分隔符可能不同） */
function normalizeKey(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

// ============================================================================
// 0.5.0 Phase 5a F2：树/标签右键的「常用项」（在资源管理器中显示 / 复制路径 / 复制文件名 /
// 在终端打开 / 用默认程序打开）
// ----------------------------------------------------------------------------
// **安全面**：五个入口只有「在资源管理器中显示」是既有通道（shell:show-in-folder），另外四个走本轮
// 新增的三条 IPC（shell:open-path / shell:open-terminal / clipboard:write-text），主进程侧一律先过
// `security.requireApproved`（路径白名单）；「在终端打开」由主进程把路径**只当 cwd** 传给子进程
// （argv 恒空 + shell:false），渲染端不做任何命令字符串拼接。
// 本函数在 tree.js 与 tabs.js 各有一份**同源副本**（两文件互相不 import，避免引入循环依赖）；
// 改动时两处必须同步（施工文档 §11 已登记）。
// ============================================================================
/** 复制路径 / 文件名。**渲染端只传 { path, kind }**：剪贴板正文由主进程按已批准路径自拼
 *  （渲染进程无法经这条通道往剪贴板写任意内容；见 ipc.js 的 clipboard:write-text 注释）。 */
export async function copyPathOrName(p, kind) {
  const name = String(p).split(/[\\/]/).pop() || String(p);
  try {
    const r = await window.api.copyText({ path: p, kind: kind === 'name' ? 'name' : 'path' });
    if (!r || r.ok !== true) {
      toast(`复制失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
      return false;
    }
    toast(kind === 'name' ? `已复制文件名：${name}` : '已复制路径');
    return true;
  } catch (err) {
    toast('复制失败：' + (err && err.message ? err.message : err));
    return false;
  }
}

/** 在终端打开：把路径交给主进程（路径只作 cwd，不进命令行）；opts 仅测试面用（dryRun） */
export async function openInTerminal(p, opts) {
  try {
    const r = await window.api.openTerminal(p, opts);
    if (!r || r.ok !== true) {
      toast(`在终端打开失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
      return r || { ok: false, reason: 'UNKNOWN' };
    }
    if (!r.dryRun) toast(`已在终端打开：${r.cwd}`);
    return r;
  } catch (err) {
    toast('在终端打开失败：' + (err && err.message ? err.message : err));
    return { ok: false, reason: 'ERR', message: String(err && err.message ? err.message : err) };
  }
}

/** 用默认程序打开（shell.openPath；未批准/不存在由主进程拒绝） */
export async function openWithDefault(p) {
  try {
    const r = await window.api.openPath(p);
    if (!r || r.ok !== true) {
      toast(`打开失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
      return r || { ok: false, reason: 'UNKNOWN' };
    }
    return r;
  } catch (err) {
    toast('打开失败：' + (err && err.message ? err.message : err));
    return { ok: false, reason: 'ERR', message: String(err && err.message ? err.message : err) };
  }
}

/** F2 的五个常用项（树与标签共用同一份定义；返回数组便于拼进各自的菜单） */
export function commonCtxItems(p) {
  if (!p) return [];
  return [
    { sep: true },
    { label: '📁 在资源管理器中显示', onClick: () => window.api.showInFolder(p) },
    { label: '📋 复制路径', onClick: () => { void copyPathOrName(p, 'path'); } },
    { label: '📋 复制文件名', onClick: () => { void copyPathOrName(p, 'name'); } },
    { label: '⌨ 在终端打开（此目录）', onClick: () => { void openInTerminal(p); } },
    { label: '🚀 用默认程序打开', onClick: () => { void openWithDefault(p); } },
  ];
}

// ---------- v0.6.0：文件树与系统剪贴板互通（Ctrl+C 复制 / Ctrl+V 粘贴） ----------
/** 合成行 key 判定（外部文件虚拟根/盘符行，key 含 \u0000）—— 不是真实路径，不可复制 */
function isSyntheticKey(p) {
  return !p || String(p).indexOf('\u0000') >= 0;
}

// ---------- 外部文件区（需求1：跨目录树定位） ----------
// 「外部文件」虚拟根行 key：含 \u0000 绝不可能是真实路径，与真实树无交集
const EXT_ROOT_KEY = '\u0000ext\u0000';
function synthDriveKey(drv) {
  return '\u0000ext\u0000' + drv + '\u0000';
}

/** 路径 → 盘符/UNC 根（规范化 key 形式）：'c:' 或 '//server/share' */
function driveRootOf(key) {
  const k = String(key);
  const m = k.match(/^[a-z]:/);
  if (m) return m[0];
  const m2 = k.match(/^\/\/[^/]+\/[^/]+/);
  if (m2) return m2[0];
  return null;
}

/** 盘符根显示名：'c:' → 'C:'；'//server/share' → '\\\\server\\share' */
function driveLabel(drv) {
  if (/^[a-z]:$/.test(drv)) return drv[0].toUpperCase() + ':';
  if (drv.startsWith('//')) {
    const parts = drv.replace(/^\/\//, '').split('/');
    return '\\\\' + parts[0] + '\\' + parts[1];
  }
  return drv;
}

/** 盘符根原始路径（拼接外部区目录链用）：'C:' / '\\\\server\\share' */
function driveRealPath(drv, sample) {
  const raw = String(sample).split(/[\\/]/).filter(Boolean);
  if (/^[a-z]:$/.test(drv)) return raw[0] || 'C:';
  const parts = drv.replace(/^\/\//, '').split('/');
  return '\\\\' + (raw[0] || parts[0]) + '\\' + (raw[1] || parts[1]);
}

/** 目录路径相对盘符根的段（保留原始大小写，用于拼接真实目录链路径） */
function realSegs(dirPath, drv) {
  const nk = normalizeKey(dirPath);
  const rel = nk.slice(drv.length).replace(/^\/+/, '');
  const count = rel.split('/').filter(Boolean).length;
  const raw = String(dirPath).split(/[\\/]/).filter(Boolean);
  return raw.slice(raw.length - count);
}

export function createTree() {
  const container = $('#file-tree');

  let roots = [];              // v0.2.3 多目录：侧栏打开的全部根（渲染顺序 = 列表顺序）
  let rootDir = null;          // 活动工作目录（须含于 roots；全局搜索/新建等默认目标）
  let selectedPath = null;
  let expanded = new Set(); // 展开的目录集合
  let onOpenFile = null;
  let onOpenDir = null;
  let onClosePath = null; // 删除/重命名后关闭或更新已打开标签
  let onSwitchRoot = null; // 需求1：外部区目录行「切换工作目录到此目录」
  let onRootClose = null;  // v0.2.3 多目录：关闭侧栏某个根
  let onActivateRoot = null; // v0.2.3 多目录：把某根设为活动目录
  let getOpenPaths = null;   // v0.2.3 拖拽移动后同步已打开标签（app.js 提供）
  let compareBase = null; // v0.2.1 对比基准（右键「设为对比基准」→ 另一文件右键「与基准对比」）

  const nodeMap = new Map(); // path -> { row, children, isDir }

  // 需求1：外部文件集合 —— normalizeKey(dir) -> { path: 原始目录, files: Set<原始文件路径> }
  // （同目录多文件共享一条链；同盘多目录共享盘符/UNC 根）
  let externalOpen = new Map();

  let onCompareFiles = null; // v0.2.1：与基准对比（app.js 传入，读取两文件开对比标签）
  let onCompareWithActive = null; // v0.11.0：与当前编辑器文档对比（树右键任意文件）

  function setCallbacks(cbs) {
    onOpenFile = cbs.onOpenFile;
    onOpenDir = cbs.onOpenDir;
    onClosePath = cbs.onClosePath;
    onSwitchRoot = cbs.onSwitchRoot;
    onCompareFiles = cbs.onCompareFiles;
    onCompareWithActive = cbs.onCompareWithActive;
    onRootClose = cbs.onRootClose;
    onActivateRoot = cbs.onActivateRoot;
    getOpenPaths = cbs.getOpenPaths;
  }

  /** 旧接口（单目录语义）：设唯一根并重置展开态（冒烟/简单场景仍使用） */
  function setRoot(dir) {
    roots = dir ? [dir] : [];
    rootDir = dir || null;
    expanded = new Set(dir ? [dir] : []);
    selectedPath = null;
    return render(); // 返回渲染完成 Promise（供 await）
  }

  /** v0.2.3 多目录：整表设置根列表 + 活动目录；已展开目录的展开态保留（新根默认展开） */
  function setRoots(dirs, activeDir) {
    roots = Array.isArray(dirs) ? dirs.slice() : [];
    rootDir = activeDir || roots[0] || null;
    for (const d of roots) expanded.add(d);
    selectedPath = null;
    return render();
  }

  function render() {
    container.innerHTML = '';
    nodeMap.clear();
    if (!roots.length) {
      renderExternal();
      if (container.childElementCount === 0) {
        container.innerHTML = '<div class="tree-empty">点击「选择目录」打开一个本地文件夹</div>';
      }
      return Promise.resolve();
    }
    const loads = [];
    for (const dir of roots) {
      const rootRow = makeRow({ name: dir.split(/[\\/]/).pop() || dir, path: dir, isDir: true, root: true });
      // 活动根标记（视觉高亮 + 「活动」徽标）
      if (rootDir && normalizeKey(rootDir) === normalizeKey(dir)) {
        rootRow.row.classList.add('active-root');
        const badge = document.createElement('span');
        badge.className = 'root-badge';
        badge.textContent = '活动';
        badge.title = '当前活动目录（全局搜索 / 新建等操作的默认目标）';
        rootRow.row.appendChild(badge);
      }
      // 根行关闭按钮（仅从侧栏移除，不删除磁盘文件）
      const close = document.createElement('span');
      close.className = 'root-close';
      close.textContent = '✕';
      close.title = '关闭此目录（不会删除磁盘文件）';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onRootClose) onRootClose(dir);
      });
      rootRow.row.appendChild(close);
      container.appendChild(rootRow.row);
      container.appendChild(rootRow.children);
      loads.push(expandNode(dir, rootRow));
    }
    // 首层渲染完成后异步补载 expanded 里的嵌套目录（不阻塞首层；失败静默）
    return Promise.all(loads).then(() => renderExternal()).then(() => { restoreExpandedDirs(); });
  }

  // 全量 render 只重建了根的一层子节点（expandNode 只 loadChildren 根目录）：expanded 集合里
  // 的嵌套目录在新 DOM 里会呈现「已展开但内容为空」。这里按 expanded 把已渲染的目录链逐级补载
  // —— loadChildren 自带并发去重（loadingDirs），读失败在其内部落错误行，这里整体再兜一层静默。
  let restoreSeq = 0;
  function restoreExpandedDirs() {
    const seq = ++restoreSeq;
    const expandedKeys = new Set();
    for (const p of expanded) expandedKeys.add(normalizeKey(p));
    const visited = new Set();
    for (const r of roots) visited.add(normalizeKey(r)); // 根目录在 render 里已强制加载，跳过
    (async () => {
      for (;;) {
        if (seq !== restoreSeq) return; // 已有更新的 render：放弃本次补载
        const pending = [];
        for (const [p, entry] of nodeMap) {
          if (!entry.isDir) continue;
          const key = normalizeKey(p);
          if (visited.has(key) || !expandedKeys.has(key)) continue;
          if (isSyntheticKey(p)) continue; // 「外部文件」合成行的链由 renderExternal 自己维护
          visited.add(key);
          if (entry.children.childElementCount > 0) continue; // 已加载
          pending.push(p);
        }
        if (!pending.length) return;
        // 并发补载一层；加载出来的更深层目录若也在 expanded，下一轮循环继续补
        await Promise.all(pending.map((p) => loadChildren(p, false).catch(() => { /* 失败静默 */ })));
      }
    })().catch(() => { /* 失败静默：树主体已渲染，补载失败不打扰用户 */ });
  }

  function makeRow(node, opts = {}) {
    const row = document.createElement('div');
    row.className = 'tree-node';
    row.dataset.path = node.path;

    const caret = document.createElement('span');
    caret.className = `caret ${node.isDir ? '' : 'leaf'}`;
    caret.textContent = '▶';
    caret.style.fontSize = '8px';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = node.isDir ? (expanded.has(node.path) ? '📂' : '📁') : iconFor(node.name);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = node.name;
    name.title = node.path;

    const size = document.createElement('span');
    size.className = 'node-size';
    if (!node.isDir) size.textContent = formatSize(node.size);

    row.append(caret, icon, name, size);

    const children = document.createElement('div');
    children.className = 'tree-children';
    children.style.display = expanded.has(node.path) ? '' : 'none';

    nodeMap.set(node.path, { row, children, isDir: node.isDir });

    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      // v0.6.0：真实点击把焦点收进树容器 —— 之后 Ctrl+C（复制选中项）/ Ctrl+V（粘贴进
      // 选中目录）作用于树（VS Code 同款行为）。合成事件（冒烟/自动化）不转移焦点，
      // 用例需要键盘路径时可显式 container.focus()。
      if (e.isTrusted) { try { container.focus({ preventScroll: true }); } catch { /* 忽略 */ } }
      if (opts.onClick) {
        await opts.onClick(node, row, children);
        return;
      }
      if (node.isDir) {
        // 目录点击也更新选中：「新建文件/目录」的目标跟随最后点击的目录
        // （此前仅文件点击 select —— 新建会落到别处，在用户浏览的位置看似"没创建出来"）
        select(node.path);
        await toggleExpand(node.path, row);
        if (onOpenDir) onOpenDir(node.path);
      } else {
        select(node.path);
        if (onOpenFile) onOpenFile(node.path);
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isTrusted) { try { container.focus({ preventScroll: true }); } catch { /* 忽略 */ } }
      if (opts.onContext) {
        opts.onContext(e.clientX, e.clientY, node, row);
        return;
      }
      select(node.path);
      showCtx(e.clientX, e.clientY, node);
    });

    attachDrag(row, node, opts);

    return { row, children };
  }

  async function toggleExpand(dirPath, row) {
    if (expanded.has(dirPath)) {
      expanded.delete(dirPath);
    } else {
      expanded.add(dirPath);
      await loadChildren(dirPath, true);
    }
    refreshIcon(row, dirPath);
  }

  function refreshIcon(row, dirPath) {
    const icon = row.querySelector('.icon');
    icon.textContent = expanded.has(dirPath) ? '📂' : '📁';
    const caret = row.querySelector('.caret');
    caret.classList.toggle('open', expanded.has(dirPath));
    const children = nodeMap.get(dirPath)?.children;
    if (children) children.style.display = expanded.has(dirPath) ? '' : 'none';
  }

  const loadingDirs = new Map(); // 规范键 -> 进行中的加载 Promise（并发去重，防止同一目录重复追加子节点）

  /** 加载某个目录的子节点（懒加载）；同一目录的并发调用共享同一次加载 */
  function loadChildren(dirPath, force = false) {
    const entry = nodeMap.get(dirPath);
    if (!entry || !entry.isDir) return Promise.resolve();
    if (!force && entry.children.childElementCount > 0) return Promise.resolve();
    const key = normalizeKey(dirPath);
    const inFlight = loadingDirs.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      entry.children.innerHTML = '';
      let items;
      try {
        items = await window.api.readTree(dirPath);
      } catch (err) {
        entry.children.innerHTML = `<div class="tree-empty">读取失败：${escapeHtml(err.message || err)}</div>`;
        return;
      }
      for (const it of items) {
        // 需求1：外部目录链中的行（rootDir 外）使用外部区菜单（目录行无新建；文件行仅打开/重命名/删除）
        const external = !isInsideRoot(it.path);
        const sub = makeRow(
          it,
          external
            ? { external: true, onContext: (x, y, node) => (node.isDir ? showExternalDirCtx(x, y, node) : showExternalFileCtx(x, y, node)) }
            : {}
        );
        entry.children.appendChild(sub.row);
        entry.children.appendChild(sub.children);
      }
    })();
    loadingDirs.set(key, p);
    const done = () => loadingDirs.delete(key);
    p.then(done, done);
    return p;
  }

  async function expandNode(dirPath, entry) {
    await loadChildren(dirPath, true);
    refreshIcon(entry.row, dirPath);
  }

  function select(path) {
    selectedPath = path;
    nodeMap.forEach((v, p) => {
      v.row.classList.toggle('selected', p === path);
    });
  }

  // ---------- 需求1：外部文件区（虚拟分支） ----------
  /** 设置外部文件集合（rootDir 外的打开文件路径）；无变化时不重渲染（幂等） */
  function setExternalFiles(paths) {
    const next = new Map();
    for (const p of paths || []) {
      if (!p || typeof p !== 'string') continue;
      if (isInsideRoot(p)) continue; // 工作目录内的文件不属于外部区
      const dir = dirOf(p);
      const dk = normalizeKey(dir);
      let e = next.get(dk);
      if (!e) {
        e = { path: dir, files: new Set() };
        next.set(dk, e);
      }
      const fk = normalizeKey(p);
      const dup = [...e.files].some((f) => normalizeKey(f) === fk);
      if (!dup) e.files.add(p);
    }
    if (sameExternal(next)) return Promise.resolve();
    externalOpen = next;
    return render();
  }

  function sameExternal(next) {
    if (externalOpen.size !== next.size) return false;
    for (const [dk, e] of next) {
      const old = externalOpen.get(dk);
      if (!old || old.path !== e.path || old.files.size !== e.files.size) return false;
      for (const f of e.files) {
        if (![...old.files].some((o) => normalizeKey(o) === normalizeKey(f))) return false;
      }
    }
    return true;
  }

  /** 合成行展开/折叠（虚拟根、盘符根行不涉及 IPC 加载） */
  function toggleSynth(key, row) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    refreshIcon(row, key);
  }

  /** 渲染「外部文件」虚拟分支：真实树之后追加 虚拟根行 → 盘符/UNC 根行（第一级链懒加载） */
  function renderExternal() {
    if (externalOpen.size === 0) return Promise.resolve();
    const extRootRow = makeRow({ name: '外部文件', path: EXT_ROOT_KEY, isDir: true, root: true }, {
      synthetic: true, // 合成行（非真实路径）：不参与拖拽
      onClick: () => toggleSynth(EXT_ROOT_KEY, extRootRow.row),
      onContext: () => {},
    });
    // 徽标：外部文件数
    let extCount = 0;
    for (const e of externalOpen.values()) extCount += e.files.size;
    const badge = document.createElement('span');
    badge.className = 'ext-badge';
    badge.textContent = extCount + '';
    badge.title = `${extCount} 个外部文件（不在当前工作目录内）`;
    extRootRow.row.appendChild(badge);
    container.appendChild(extRootRow.row);
    container.appendChild(extRootRow.children);

    const drvs = new Set();
    for (const dk of externalOpen.keys()) drvs.add(driveRootOf(dk) || dk);
    for (const drv of drvs) {
      const driveKey = synthDriveKey(drv);
      const driveRow = makeRow({ name: driveLabel(drv), path: driveKey, isDir: true }, {
        synthetic: true, // 合成行（非真实路径）：不参与拖拽
        onClick: () => {
          if (expanded.has(driveKey)) {
            expanded.delete(driveKey);
          } else {
            expanded.add(driveKey);
            ensureDriveBuilt(drv, driveRow.children);
          }
          refreshIcon(driveRow.row, driveKey);
        },
        onContext: () => {},
      });
      extRootRow.children.appendChild(driveRow.row);
      extRootRow.children.appendChild(driveRow.children);
      if (expanded.has(driveKey)) ensureDriveBuilt(drv, driveRow.children); // 已展开：render 后保持链可见
    }
    refreshIcon(extRootRow.row, EXT_ROOT_KEY);
    return Promise.resolve();
  }

  /** 构建某盘符下外部文件链的第一级目录/文件行（懒加载：仅点击/展开时构建一次） */
  function ensureDriveBuilt(drv, childrenEl) {
    if (childrenEl.childElementCount > 0) return; // 已构建
    const topDirs = new Map(); // topKey -> topPath
    const topFiles = [];
    for (const [dk, e] of externalOpen) {
      if ((driveRootOf(dk) || dk) !== drv) continue;
      const segs = realSegs(e.path, drv);
      if (segs.length === 0) {
        for (const f of e.files) topFiles.push(f);
        continue;
      }
      const topPath = driveRealPath(drv, e.path) + '/' + segs[0];
      topDirs.set(normalizeKey(topPath), topPath);
    }
    for (const topPath of topDirs.values()) {
      const sub = makeRow({ name: baseName(topPath), path: topPath, isDir: true }, {
        external: true,
        onContext: (x, y, node) => showExternalDirCtx(x, y, node),
      });
      childrenEl.appendChild(sub.row);
      childrenEl.appendChild(sub.children);
    }
    for (const f of topFiles) {
      const sub = makeRow({ name: baseName(f), path: f, isDir: false, size: -1 }, {
        external: true,
        onContext: (x, y, node) => showExternalFileCtx(x, y, node),
      });
      childrenEl.appendChild(sub.row);
      childrenEl.appendChild(sub.children);
    }
  }

  /** 外部区文件行菜单：v0.7.1 起与内部文件行同面（打开/对比基准/重命名/删除/复制/粘贴） */
  function showExternalFileCtx(x, y, node) {
    select(node.path);
    const items = [{ label: '📄 打开', onClick: () => onOpenFile && onOpenFile(node.path) }];
    // v0.11.0：任意两个文件直接对比 —— 当前编辑文档 ↔ 树中该文件（含未保存内容）
    if (typeof onCompareWithActive === 'function') {
      items.push({ label: '🔀 与当前文档对比', onClick: () => onCompareWithActive(node.path) });
    }
    // v0.2.1 对比：与内部文件行同款（无基准 → 设为基准；有基准且非自身 → 与基准对比）
    if (!compareBase) {
      items.push({ label: '🔖 设为对比基准', onClick: () => {
        compareBase = node.path;
        toast(`对比基准：${node.name}（在另一文件上右键「与基准对比」）`);
      } });
    } else if (compareBase !== node.path) {
      items.push({ label: `🔀 与基准对比（${(compareBase.split(/[\\/]/).pop() || '').slice(0, 18)}）`, onClick: () => {
        const base = compareBase;
        compareBase = null;
        onCompareFiles && onCompareFiles(base, node.path);
      } });
    }
    items.push({ sep: true });
    items.push({ label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) });
    items.push({ label: '🗑 删除文件', danger: true, onClick: () => removeEntry(node.path, false) });
    // v0.7.1：剪贴板互通与内部一致（复制 / 粘贴到所在目录）
    items.push({ sep: true });
    items.push({ label: '📋 复制（Ctrl+C）', onClick: () => { void copyEntryToClipboard(node.path); } });
    items.push({ label: '📥 粘贴到所在目录（Ctrl+V）', onClick: () => { void pasteEntryFromClipboard(dirOf(node.path)); } });
    items.push(...commonCtxItems(node.path));
    renderCtxMenu(x, y, items);
  }

  /** 外部区目录行菜单：v0.7.1 起与内部目录行同面（新建文件/目录/刷新/重命名/删除/复制/粘贴）
   *  + 外部链特有的「切换工作目录到此目录」；仅虚拟根/盘符行（合成 key）保持只读展示。 */
  function showExternalDirCtx(x, y, node) {
    select(node.path);
    const items = [
      { label: '📝 新建文件', onClick: () => createEntry(node.path, 'file') },
      { label: '📁 新建目录', onClick: () => createEntry(node.path, 'dir') },
      { sep: true },
      { label: '📋 复制（Ctrl+C）', onClick: () => { void copyEntryToClipboard(node.path); } },
      { label: '📥 粘贴到此处（Ctrl+V）', onClick: () => { void pasteEntryFromClipboard(node.path); } },
      { sep: true },
      { label: '🔄 刷新', onClick: () => refreshNode(node.path, true) },
    ];
    if (typeof onSwitchRoot === 'function') {
      items.push({ label: '📂 切换工作目录到此目录', onClick: () => onSwitchRoot(node.path) });
    }
    items.push({ sep: true });
    items.push({ label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) });
    items.push({ label: '🗑 删除目录', danger: true, onClick: () => removeEntry(node.path, true) });
    items.push(...commonCtxItems(node.path));
    renderCtxMenu(x, y, items);
  }

  // ---------- v0.2.3 跨目录拖拽传输 ----------
  // HTML5 DnD：行 draggable，目录行接收放置。拖拽 = 移动，Ctrl+拖拽 = 复制（Windows 资源管理器习惯）。
  // 权限：源与目标都必须在侧栏根集合内（或外部已打开过的文件），主进程 fs:transfer 再校验一次。
  let dragSrc = null; // { path, isDir } 当前拖拽源（单行；树无多选，与现有单选语义一致）

  /** 放置守卫：同位置 / 拖进自身子目录 / 原地拖放 均不可落 */
  function dropGuard(srcPath, destDir) {
    const sk = normalizeKey(srcPath);
    const dk = normalizeKey(destDir);
    if (!sk || !dk) return false;
    if (sk === dk) return false;
    if (dk.startsWith(sk + '/')) return false;
    if (normalizeKey(dirOf(srcPath)) === dk) return false;
    return true;
  }

  function clearDropMarks() {
    for (const el of container.querySelectorAll('.tree-node.drop-target')) {
      el.classList.remove('drop-target');
    }
  }

  /** 为行挂接拖拽：v0.7.1 起外部链的**真实目录行**与内部一致（可拖可收，传输通道已放开）；
   *  合成行（「外部文件」虚拟根 / 盘符行，opts.synthetic）不是真实路径，不拖不收；
   *  根行可作放置目标但不可被拖。 */
  function attachDrag(row, node, opts = {}) {
    if (opts.synthetic) return; // 合成行：不拖不收
    row.draggable = !node.root;
    row.addEventListener('dragstart', (e) => {
      if (node.root) {
        e.preventDefault();
        return;
      }
      dragSrc = { path: node.path, isDir: node.isDir };
      try {
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'copyMove';
      } catch { /* 冒烟合成事件可能无 dataTransfer */ }
    });
    row.addEventListener('dragend', () => {
      dragSrc = null;
      clearDropMarks();
    });
    if (!node.isDir) return; // 仅目录行（含根行）接收放置
    row.addEventListener('dragover', (e) => {
      if (!dragSrc || !dropGuard(dragSrc.path, node.path)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      } catch { /* 合成事件无 dataTransfer */ }
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !row.contains(e.relatedTarget)) row.classList.remove('drop-target');
    });
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-target');
      if (!dragSrc) return;
      const src = dragSrc.path;
      if (!dropGuard(src, node.path)) return;
      e.preventDefault();
      e.stopPropagation();
      let mode = 'move';
      try {
        mode = e.ctrlKey ? 'copy' : 'move';
      } catch { /* 合成事件无属性时取默认移动 */ }
      dragSrc = null;
      transferEntry(src, node.path, mode);
    });
  }

  /** 冲突弹窗（应用内 modal，不用原生对话框）：返回 'overwrite' | 'dedupe' | null（取消） */
  function overwriteDialog(src, mode) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      const p = document.createElement('p');
      p.style.cssText = 'line-height:1.7;word-break:break-all;';
      p.textContent = `目标位置已存在同名项「${baseName(src)}」。`;
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '覆盖：替换/合并目标；保留两者：自动改名为「名 (2).扩展名」';
      body.append(p, hint);
      openModal({
        title: mode === 'move' ? '移动冲突' : '复制冲突',
        body,
        actions: [
          { label: '取消', onClick: () => { closeModal(); resolve(null); } },
          { label: '保留两者', onClick: () => { closeModal(); resolve('dedupe'); } },
          { label: '覆盖', primary: true, danger: true, onClick: () => { closeModal(); resolve('overwrite'); } },
        ],
      });
    });
  }

  /** 传输后的树刷新：先刷源父目录（为根时全量重建），再刷目标目录 */
  async function refreshAfterTransfer(src, destDir) {
    const srcParent = dirOf(src);
    if (srcParent) await refreshNode(srcParent, true);
    await refreshNode(destDir, true);
  }

  /** 执行一次传输（drop 入口）：冲突走应用内弹窗；移动后同步已打开标签路径 */
  async function transferEntry(src, destDir, mode) {
    const label = mode === 'move' ? '移动' : '复制';
    try {
      let res = await window.api.transferFiles(src, destDir, mode, { conflict: 'ask' });
      if (res && res.conflict) {
        const choice = await overwriteDialog(src, mode);
        if (!choice) return;
        res = await window.api.transferFiles(src, destDir, mode, {
          overwrite: choice === 'overwrite',
          conflict: choice,
        });
      }
      const dest = res && res.dest;
      if (!dest) return;
      // 移动：已打开标签跟随（复用 onClosePath 的重命名路径——更新标签 + 重挂文件监听）
      if (mode === 'move' && typeof getOpenPaths === 'function' && onClosePath) {
        const sk = normalizeKey(src);
        for (const p of getOpenPaths() || []) {
          const pk = normalizeKey(p);
          if (pk === sk || pk.startsWith(sk + '/')) {
            onClosePath(p, dest + pk.slice(sk.length)); // 相对段按规范化 key 截取（大小写/分隔符差异安全）
          }
        }
      }
      toast(`${label}成功：${baseName(src)}`);
      await refreshAfterTransfer(src, destDir);
    } catch (err) {
      toast(`${label}失败：${err.message || err}`);
    }
  }

  // ---------- v0.6.0：文件树与系统剪贴板互通（Ctrl+C 复制 / Ctrl+V 粘贴） ----------
  /** 复制选中项（文件或目录）到系统剪贴板（CF_HDROP）：资源管理器/桌面可直接 Ctrl+V。
   *  合成行（外部文件虚拟根/盘符行）不是真实路径，拒绝。
   *  nodeMap 匹配走 normalizeKey（findNode 同款）—— selectedPath 可能与 readTree 返回的
   *  行键分隔符/大小写不同（正斜杠 vs 反斜杠），精确 has 会误拒。 */
  async function copyEntryToClipboard(path) {
    if (isSyntheticKey(path) || !findNode(normalizeKey(String(path)))) {
      toast('请先在文件树中选中一个文件或目录');
      return false;
    }
    try {
      const r = await window.api.clipboardCopyFiles([path]);
      if (!r || r.ok !== true) {
        toast(`复制失败：${(r && r.message) || (r && r.reason) || '未知错误'}`);
        return false;
      }
      toast(`已复制「${baseName(path)}」，可在资源管理器中 Ctrl+V`);
      return true;
    } catch (err) {
      toast('复制失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  /** 把系统剪贴板里的文件/文件夹粘贴进 destDir（冲突弹窗复用拖拽传输的同款） */
  async function pasteEntryFromClipboard(destDir) {
    if (!destDir) {
      toast('请先打开一个目录');
      return false;
    }
    try {
      let res = await window.api.pasteFiles(destDir, { conflict: 'ask' });
      if (res && res.conflict) {
        const choice = await overwriteDialog(destDir + '/' + res.name, 'copy');
        if (!choice) return false;
        res = await window.api.pasteFiles(
          destDir,
          choice === 'overwrite' ? { overwrite: true } : { conflict: 'dedupe' }
        );
      }
      if (!res || res.ok !== true) {
        toast(`粘贴失败：${(res && res.message) || '未知错误'}`);
        return false;
      }
      toast(`已粘贴 ${res.pasted.length} 项${res.skipped ? `（跳过 ${res.skipped} 项）` : ''}`);
      await refreshNode(destDir, true);
      if (res.pasted.length === 1) select(res.pasted[0]);
      return true;
    } catch (err) {
      toast('粘贴失败：' + (err && err.message ? err.message : err));
      return false;
    }
  }

  // 树容器可聚焦（接收 Ctrl+C / Ctrl+V 键事件）：
  // · 点击树行 / 右键时把焦点收到树（VS Code 同款行为——点了树，键盘就作用于树；
  //   编辑器不受影响：点击文件打开标签不会把焦点留在树之外的地方）；
  // · 不画焦点轮廓（树只需接收键事件，焦点环反而是视觉噪音）。
  container.tabIndex = 0;
  container.style.outline = 'none';
  container.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'c') {
      e.preventDefault();
      void copyEntryToClipboard(selectedPath);
    } else if (k === 'v') {
      e.preventDefault();
      void pasteEntryFromClipboard(getTargetDir());
    }
  });

  // ---------- 右键菜单（委托 ui.js 通用菜单；items 结构与原 renderCtxMenu 一致） ----------
  function showCtx(x, y, node) {
    const items = [];
    if (node.isDir) {
      items.push({ label: '📝 新建文件', onClick: () => createEntry(node.path, 'file') });
      items.push({ label: '📁 新建目录', onClick: () => createEntry(node.path, 'dir') });
      items.push({ sep: true });
      // v0.6.0：剪贴板互通（合成行的「目录」是外部链目录行，不是根内路径 —— 复制仍可用
      //（已批准），粘贴目标对它没有意义（getTargetDir 会回落活动目录），故只给复制）
      if (!isSyntheticKey(node.path)) {
        items.push({ label: '📋 复制（Ctrl+C）', onClick: () => { void copyEntryToClipboard(node.path); } });
        items.push({ label: '📥 粘贴到此处（Ctrl+V）', onClick: () => { void pasteEntryFromClipboard(node.path); } });
        items.push({ sep: true });
      }
      items.push({ label: '🔄 刷新', onClick: () => refreshNode(node.path) });
      if (node.root) {
        // v0.2.3 多目录：根行菜单 —— 活动切换 + 关闭（根目录本体不允许「删除」，改提供「关闭」）
        const isActive = rootDir && normalizeKey(rootDir) === normalizeKey(node.path);
        if (!isActive && typeof onActivateRoot === 'function') {
          items.push({ label: '📌 设为活动目录', onClick: () => onActivateRoot(node.path) });
        }
        items.push({ label: '✕ 关闭此目录', onClick: () => onRootClose && onRootClose(node.path) });
      } else {
        items.push({ label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) });
        items.push({ sep: true });
        items.push({ label: '🗑 删除目录', danger: true, onClick: () => removeEntry(node.path, true) });
      }
    } else {
      items.push({ label: '📄 打开', onClick: () => onOpenFile && onOpenFile(node.path) });
      // v0.11.0：任意两个文件直接对比 —— 当前编辑文档 ↔ 树中该文件（含未保存内容）
      if (typeof onCompareWithActive === 'function') {
        items.push({ label: '🔀 与当前文档对比', onClick: () => onCompareWithActive(node.path) });
      }
      items.push({ sep: true });
      // v0.2.1 对比：无基准 → 设为基准；有基准且非自身 → 与基准对比
      if (!compareBase) {
        items.push({ label: '🔖 设为对比基准', onClick: () => {
          compareBase = node.path;
          toast(`对比基准：${node.name}（在另一文件上右键「与基准对比」）`);
        } });
      } else if (compareBase !== node.path) {
        items.push({ label: `🔀 与基准对比（${(compareBase.split(/[\\/]/).pop() || '').slice(0, 18)}）`, onClick: () => {
          const base = compareBase;
          compareBase = null; // 一次性使用
          onCompareFiles && onCompareFiles(base, node.path);
        } });
        items.push({ label: '🔖 改设此文件为基准', onClick: () => {
          compareBase = node.path;
          toast(`对比基准已改为：${node.name}`);
        } });
      } else {
        items.push({ label: '🔖 取消对比基准', onClick: () => {
          compareBase = null;
          toast('已取消对比基准');
        } });
      }
      items.push({ sep: true });
      items.push({ label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) });
      items.push({ label: '🗑 删除文件', danger: true, onClick: () => removeEntry(node.path, false) });
      // v0.6.0：文件行也给「复制」+「粘贴」（粘贴目标 = 文件所在目录，与 getTargetDir 同推导）
      items.push({ sep: true });
      items.push({ label: '📋 复制（Ctrl+C）', onClick: () => { void copyEntryToClipboard(node.path); } });
      items.push({ label: '📥 粘贴到所在目录（Ctrl+V）', onClick: () => { void pasteEntryFromClipboard(dirOf(node.path)); } });
    }
    // F2：常用项（在资源管理器中显示 / 复制路径 / 复制文件名 / 在终端打开 / 用默认程序打开）
    // 目录行与文件行都给（终端打开时主进程会取目录本身；文件取其所在目录）
    items.push(...commonCtxItems(node.path));
    renderCtxMenu(x, y, items);
  }

  /** 渲染右键菜单（保留原函数名，内部委托 ui.showContextMenu） */
  function renderCtxMenu(x, y, items) {
    showContextMenu(x, y, items);
  }

  /** 隐藏右键菜单（保留原函数名，内部委托 ui.hideContextMenu） */
  function hideCtx() {
    hideContextMenu();
  }

  /** 取父目录（保留原始路径分隔符，避免与 nodeMap 的 key 不匹配） */
  function dirOf(p) {
    return String(p).replace(/[\\/][^\\/]*$/, '');
  }

  // ---------- 新建 / 重命名 / 删除 ----------
  function createEntry(parentDir, type) {
    const label = type === 'dir' ? '目录名称' : '文件名称（含扩展名）';
    showPrompt(type === 'dir' ? '新建目录' : '新建文件', label, '', async (val) => {
      const p = await window.api.create(parentDir, val, type);
      toast((type === 'dir' ? '📁 已创建目录 ' : '📝 已创建文件 ') + val);
      await refreshNode(parentDir, true);
      select(p);
      // 新建文件后直接打开（与工具栏「新建文件」一致；目录不打开）
      if (type === 'file' && onOpenFile) onOpenFile(p);
    });
  }

  function renameEntry(path, oldName) {
    showPrompt('重命名', '新名称', oldName, async (val) => {
      const np = await window.api.rename(path, val);
      if (onClosePath) onClosePath(path, np);
      const parent = dirOf(path);
      await refreshNode(parent || rootDir, true);
      toast(`已重命名为 ${val}`);
    });
  }

  async function removeEntry(path, isDir) {
    const ok = await confirmDialog(
      `确定要删除「${path.split(/[\\/]/).pop()}」吗？${isDir ? '\n目录内的所有内容将一并删除，此操作不可恢复。' : '此操作不可恢复。'}`,
      '删除确认'
    );
    if (!ok) return;
    try {
      await window.api.remove(path, isDir);
      if (onClosePath) onClosePath(path, null);
      const parent = dirOf(path);
      await refreshNode(parent || rootDir, true);
      toast('已删除');
    } catch (err) {
      toast(`删除失败：${err.message || err}`);
    }
  }

  /** 刷新某个目录节点（根节点特殊处理：任一侧栏根 → 全量重建）。
   *  目标行不在当前 nodeMap（全量 render 后未重走的展开目录 / 外部移动删除导致的陈旧行）
   *  时，向上找最近已渲染祖先刷新，都没有则整树重建 —— 修复「新建成功但树不刷新、看似没创建」。 */
  async function refreshNode(dirPath, expand = false) {
    if (roots.some((r) => normalizeKey(r) === normalizeKey(dirPath))) {
      render();
      return;
    }
    let entry = nodeMap.get(dirPath);
    if (!entry) {
      let cur = dirOf(dirPath);
      while (cur && !roots.some((r) => normalizeKey(r) === normalizeKey(cur)) && dirOf(cur) !== cur && !nodeMap.has(cur)) {
        cur = dirOf(cur);
      }
      if (nodeMap.has(cur)) {
        dirPath = cur;
        entry = nodeMap.get(cur);
      } else {
        render(); // 兜底：整树重建
        return;
      }
    }
    if (expand && !expanded.has(dirPath)) expanded.add(dirPath);
    await loadChildren(dirPath, true);
    refreshIcon(entry.row, dirPath);
  }

  async function refreshSelected() {
    if (!rootDir) return;
    // 选中文件时刷新其所在目录（文件节点本身无子项可刷新）
    let target = rootDir;
    if (selectedPath && nodeMap.has(selectedPath)) {
      const entry = nodeMap.get(selectedPath);
      target = entry.isDir ? selectedPath : dirOf(selectedPath);
    }
    if (target === rootDir) {
      render(); // 根目录整体刷新
      return;
    }
    await refreshNode(target, true);
  }

  // 返回当前选中的目录（用于"在选中目录下新建"）
  function getTargetDir() {
    if (selectedPath && nodeMap.has(selectedPath)) {
      // 需求1：选中外部区项（rootDir 外或合成 key）时返回 rootDir —— 新建文件等仍落在当前工作目录
      if (!isInsideRoot(selectedPath)) return rootDir;
      const entry = nodeMap.get(selectedPath);
      return entry.isDir ? selectedPath : dirOf(selectedPath);
    }
    return rootDir;
  }

  /** 判断路径是否在任一侧栏根内（复用 reveal 同款 normalizeKey + / 边界判定；
   *  v0.2.3 多目录：任一根内即算内部，外部文件分支仅收录所有根之外的路径） */
  function isInsideRoot(p) {
    if (!p || !roots.length) return false;
    const targetKey = normalizeKey(p).replace(/\/+$/, '');
    for (const r of roots) {
      const rootKey = normalizeKey(r).replace(/\/+$/, '');
      if (targetKey === rootKey) return true; // 根目录自身也算内部（此前 continue 误判为外部）
      if (!targetKey.startsWith(rootKey)) continue;
      if (targetKey.slice(rootKey.length).startsWith('/')) return true; // 仅接受根内子路径（防 F:/ab 前缀误匹配 F:/a）
    }
    return false;
  }

  /** 按规范化路径在 nodeMap 中查找（兼容大小写差异） */
  function findNode(key) {
    for (const [p, entry] of nodeMap) {
      if (normalizeKey(p) === key) return entry;
    }
    return null;
  }

  // ---------- 树定位：内部路径走真实树（原逻辑一字不改），外部路径走「外部文件」虚拟分支 ----------
  let revealSeq = 0;

  async function reveal(path) {
    if (!path) return;
    if (isInsideRoot(path)) return revealInner(path);
    return revealExternal(path);
  }

  /** 内部路径定位：展开 path 所在各级目录并选中该节点（中间读取失败 / 节点不存在 → 静默返回）。
   *  v0.2.3 多目录：先解析目标所属的宿主根（添加目录时已禁止根间嵌套，宿主唯一），再沿该根展开。 */
  async function revealInner(target) {
    const targetKey0 = normalizeKey(target).replace(/\/+$/, '');
    let hostKey = null;
    for (const r of roots) {
      const rk = normalizeKey(r).replace(/\/+$/, '');
      if (targetKey0.startsWith(rk + '/')) {
        hostKey = rk;
        break;
      }
    }
    if (!hostKey) return;
    const rootKey = hostKey;
    const targetKey = targetKey0;
    const rest = targetKey.slice(rootKey.length);
    const segs = rest.replace(/^\/+/, '').split('/').filter(Boolean);
    if (!segs.length) return;
    const seq = ++revealSeq;

    // 逐级展开目录（已展开的确保子节点已加载；中间任何一级缺失 → 静默返回）
    let curKey = rootKey;
    for (let i = 0; i < segs.length - 1; i++) {
      if (seq !== revealSeq) return; // 已有更新的 reveal，放弃本次
      curKey = curKey + '/' + segs[i];
      const entry = findNode(curKey);
      if (!entry || !entry.isDir) return;
      const dirPath = entry.row.dataset.path;
      if (seq !== revealSeq) return;
      if (expanded.has(dirPath)) {
        await loadChildren(dirPath, false); // 已展开：子节点未加载则补加载
        refreshIcon(entry.row, dirPath); // 防御：保证展开态图标/箭头与 expanded 集合一致
      } else {
        expanded.add(dirPath);
        await loadChildren(dirPath, true);
        refreshIcon(entry.row, dirPath);
      }
    }

    // 最后一级：选中并滚动到可见（不切换根、不展开其它无关目录、不影响编辑器焦点）
    const entry = findNode(targetKey);
    if (!entry || seq !== revealSeq) return;
    select(entry.row.dataset.path);
    entry.row.scrollIntoView({ block: 'nearest' });
  }

  /** 外部路径定位：注册进 externalOpen（缺失行即时创建）→ 展开虚拟根/盘符根 → 沿链逐级展开 → 选中 */
  async function revealExternal(target) {
    const tk = normalizeKey(target);
    const dir = dirOf(target);
    const dk = normalizeKey(dir);
    // 1. 注册进 externalOpen（同目录多文件一条链）
    let e = externalOpen.get(dk);
    if (!e) {
      e = { path: dir, files: new Set() };
      externalOpen.set(dk, e);
    }
    const has = [...e.files].some((f) => normalizeKey(f) === tk);
    if (!has) e.files.add(target);
    const seq = ++revealSeq;
    // 2. 目标行缺失（新外部文件）时重建树确保外部区渲染；已存在则跳过（避免每次切换标签全量刷新）
    if (!findNode(tk)) {
      await render();
      if (seq !== revealSeq) return;
    }
    // 3. 展开「外部文件」虚拟根行
    const extRootEntry = nodeMap.get(EXT_ROOT_KEY);
    if (extRootEntry) {
      expanded.add(EXT_ROOT_KEY);
      refreshIcon(extRootEntry.row, EXT_ROOT_KEY);
    }
    if (seq !== revealSeq) return;
    // 4. 展开盘符/UNC 根行 + 构建第一级链
    const drv = driveRootOf(dk) || dk;
    const driveKey = synthDriveKey(drv);
    const driveEntry = nodeMap.get(driveKey);
    if (driveEntry) {
      expanded.add(driveKey);
      ensureDriveBuilt(drv, driveEntry.children);
      refreshIcon(driveEntry.row, driveKey);
    }
    // 5. 沿目录链逐级展开（loadChildren 懒加载真实目录；已加载的幂等跳过）
    const segs = realSegs(dir, drv);
    let curPath = driveRealPath(drv, dir);
    for (let i = 0; i < segs.length; i++) {
      if (seq !== revealSeq) return;
      curPath = curPath + '/' + segs[i];
      const entry = findNode(normalizeKey(curPath));
      if (!entry || !entry.isDir) return;
      const dirPath = entry.row.dataset.path;
      if (seq !== revealSeq) return;
      expanded.add(dirPath);
      await loadChildren(dirPath, false);
      refreshIcon(entry.row, dirPath);
    }
    // 6. 最后一级：选中并滚动到可见
    if (seq !== revealSeq) return;
    const fileEntry = findNode(tk);
    if (!fileEntry) return;
    select(fileEntry.row.dataset.path);
    fileEntry.row.scrollIntoView({ block: 'nearest' });
  }

  return { setRoot, setRoots, setCallbacks, refreshNode, refreshSelected, getTargetDir, select, hideCtx, reveal, isInsideRoot, setExternalFiles, revealExternal, copyEntryToClipboard, pasteEntryFromClipboard, renameEntry };
}
