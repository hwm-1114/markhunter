// 左侧文件树
import { $, formatSize, escapeHtml, showPrompt, confirmDialog, toast, showContextMenu, hideContextMenu, baseName } from './ui.js';

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

  let rootDir = null;
  let selectedPath = null;
  let expanded = new Set(); // 展开的目录集合
  let onOpenFile = null;
  let onOpenDir = null;
  let onClosePath = null; // 删除/重命名后关闭或更新已打开标签
  let onSwitchRoot = null; // 需求1：外部区目录行「切换工作目录到此目录」

  const nodeMap = new Map(); // path -> { row, children, isDir }

  // 需求1：外部文件集合 —— normalizeKey(dir) -> { path: 原始目录, files: Set<原始文件路径> }
  // （同目录多文件共享一条链；同盘多目录共享盘符/UNC 根）
  let externalOpen = new Map();

  function setCallbacks(cbs) {
    onOpenFile = cbs.onOpenFile;
    onOpenDir = cbs.onOpenDir;
    onClosePath = cbs.onClosePath;
    onSwitchRoot = cbs.onSwitchRoot;
  }

  function setRoot(dir) {
    rootDir = dir;
    expanded = new Set([dir]);
    selectedPath = null;
    return render(); // 返回渲染完成 Promise（供 await）
  }

  function render() {
    container.innerHTML = '';
    nodeMap.clear();
    if (!rootDir) {
      renderExternal();
      if (container.childElementCount === 0) {
        container.innerHTML = '<div class="tree-empty">点击「选择目录」打开一个本地文件夹</div>';
      }
      return Promise.resolve();
    }
    const rootRow = makeRow({ name: rootDir.split(/[\\/]/).pop(), path: rootDir, isDir: true, root: true });
    container.appendChild(rootRow.row);
    container.appendChild(rootRow.children);
    return expandNode(rootDir, rootRow).then(() => renderExternal());
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
      if (opts.onContext) {
        opts.onContext(e.clientX, e.clientY, node, row);
        return;
      }
      select(node.path);
      showCtx(e.clientX, e.clientY, node);
    });

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
            ? { onContext: (x, y, node) => (node.isDir ? showExternalDirCtx(x, y, node) : showExternalFileCtx(x, y, node)) }
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
        onContext: (x, y, node) => showExternalDirCtx(x, y, node),
      });
      childrenEl.appendChild(sub.row);
      childrenEl.appendChild(sub.children);
    }
    for (const f of topFiles) {
      const sub = makeRow({ name: baseName(f), path: f, isDir: false, size: -1 }, {
        onContext: (x, y, node) => showExternalFileCtx(x, y, node),
      });
      childrenEl.appendChild(sub.row);
      childrenEl.appendChild(sub.children);
    }
  }

  /** 外部区文件行菜单：仅 打开/重命名/删除（不提供新建；S1 会拒外部新建，避免暴露报错路径） */
  function showExternalFileCtx(x, y, node) {
    select(node.path);
    showContextMenu(x, y, [
      { label: '📄 打开', onClick: () => onOpenFile && onOpenFile(node.path) },
      { sep: true },
      { label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) },
      { label: '🗑 删除文件', danger: true, onClick: () => removeEntry(node.path, false) },
    ]);
  }

  /** 外部区目录行菜单：仅 刷新 + 切换工作目录到此目录（不提供新建文件/新建目录） */
  function showExternalDirCtx(x, y, node) {
    select(node.path);
    const items = [{ label: '🔄 刷新', onClick: () => refreshNode(node.path, true) }];
    if (typeof onSwitchRoot === 'function') {
      items.push({ label: '📂 切换工作目录到此目录', onClick: () => onSwitchRoot(node.path) });
    }
    showContextMenu(x, y, items);
  }

  // ---------- 右键菜单（委托 ui.js 通用菜单；items 结构与原 renderCtxMenu 一致） ----------
  function showCtx(x, y, node) {
    const items = [];
    if (node.isDir) {
      items.push({ label: '📁 新建文件', onClick: () => createEntry(node.path, 'file') });
      items.push({ label: '📂 新建目录', onClick: () => createEntry(node.path, 'dir') });
      items.push({ sep: true });
      items.push({ label: '🔄 刷新', onClick: () => refreshNode(node.path) });
      items.push({ label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) });
      items.push({ sep: true });
      items.push({ label: '🗑 删除目录', danger: true, onClick: () => removeEntry(node.path, true) });
    } else {
      items.push({ label: '📄 打开', onClick: () => onOpenFile && onOpenFile(node.path) });
      items.push({ sep: true });
      items.push({ label: '✏️ 重命名', onClick: () => renameEntry(node.path, node.name) });
      items.push({ label: '🗑 删除文件', danger: true, onClick: () => removeEntry(node.path, false) });
    }
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
      toast(`已创建 ${val}`);
      await refreshNode(parentDir, true);
      select(p);
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

  /** 刷新某个目录节点（root 特殊处理）。
   *  目标行不在当前 nodeMap（全量 render 后未重走的展开目录 / 外部移动删除导致的陈旧行）
   *  时，向上找最近已渲染祖先刷新，都没有则整树重建 —— 修复「新建成功但树不刷新、看似没创建」。 */
  async function refreshNode(dirPath, expand = false) {
    if (dirPath === rootDir) {
      render();
      return;
    }
    let entry = nodeMap.get(dirPath);
    if (!entry) {
      let cur = dirOf(dirPath);
      while (cur && cur !== rootDir && dirOf(cur) !== cur && !nodeMap.has(cur)) {
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

  /** 判断路径是否在当前工作目录内（复用 reveal 同款 normalizeKey + / 边界判定） */
  function isInsideRoot(p) {
    if (!rootDir || !p) return false;
    const target = String(p);
    const rootKey = normalizeKey(rootDir).replace(/\/+$/, '');
    const targetKey = normalizeKey(target).replace(/\/+$/, '');
    if (targetKey === rootKey || !targetKey.startsWith(rootKey)) return false;
    const rest = targetKey.slice(rootKey.length);
    return rest.startsWith('/'); // 仅接受根内子路径（防 F:/ab 前缀误匹配 F:/a）
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
    if (!rootDir || !path) return;
    if (isInsideRoot(path)) return revealInner(path);
    return revealExternal(path);
  }

  /** 内部路径定位：展开 path 所在各级目录并选中该节点（中间读取失败 / 节点不存在 → 静默返回） */
  async function revealInner(target) {
    const rootKey = normalizeKey(rootDir).replace(/\/+$/, '');
    const targetKey = normalizeKey(target).replace(/\/+$/, '');
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

  return { setRoot, setCallbacks, refreshNode, refreshSelected, getTargetDir, select, hideCtx, reveal, isInsideRoot, setExternalFiles, revealExternal };
}
