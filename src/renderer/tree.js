// 左侧文件树
import { $, formatSize, escapeHtml, showPrompt, confirmDialog, toast } from './ui.js';

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

export function createTree() {
  const container = $('#file-tree');
  const ctxMenu = $('#ctx-menu');

  let rootDir = null;
  let selectedPath = null;
  let expanded = new Set(); // 展开的目录集合
  let onOpenFile = null;
  let onOpenDir = null;
  let onClosePath = null; // 删除/重命名后关闭或更新已打开标签

  const nodeMap = new Map(); // path -> { row, children, isDir }

  function setCallbacks(cbs) {
    onOpenFile = cbs.onOpenFile;
    onOpenDir = cbs.onOpenDir;
    onClosePath = cbs.onClosePath;
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
      container.innerHTML = '<div class="tree-empty">点击「选择目录」打开一个本地文件夹</div>';
      return Promise.resolve();
    }
    const rootRow = makeRow({ name: rootDir.split(/[\\/]/).pop(), path: rootDir, isDir: true, root: true });
    container.appendChild(rootRow.row);
    container.appendChild(rootRow.children);
    return expandNode(rootDir, rootRow);
  }

  function makeRow(node) {
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
      if (node.isDir) {
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
        const sub = makeRow(it);
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

  // ---------- 右键菜单 ----------
  function showCtx(x, y, node) {
    const items = [];
    if (node.isDir) {
      items.push({ label: '📁 新建文件', fn: () => createEntry(node.path, 'file') });
      items.push({ label: '📂 新建目录', fn: () => createEntry(node.path, 'dir') });
      items.push({ sep: true });
      items.push({ label: '🔄 刷新', fn: () => refreshNode(node.path) });
      items.push({ label: '✏️ 重命名', fn: () => renameEntry(node.path, node.name) });
      items.push({ sep: true });
      items.push({ label: '🗑 删除目录', danger: true, fn: () => removeEntry(node.path, true) });
    } else {
      items.push({ label: '📄 打开', fn: () => onOpenFile && onOpenFile(node.path) });
      items.push({ sep: true });
      items.push({ label: '✏️ 重命名', fn: () => renameEntry(node.path, node.name) });
      items.push({ label: '🗑 删除文件', danger: true, fn: () => removeEntry(node.path, false) });
    }
    renderCtxMenu(x, y, items);
  }

  function renderCtxMenu(x, y, items) {
    ctxMenu.innerHTML = '';
    for (const it of items) {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = `ctx-item ${it.danger ? 'danger' : ''}`;
      el.textContent = it.label;
      el.addEventListener('click', () => {
        hideCtx();
        it.fn();
      });
      ctxMenu.appendChild(el);
    }
    ctxMenu.classList.remove('hidden');
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }

  function hideCtx() {
    ctxMenu.classList.add('hidden');
  }

  /** 取父目录（保留原始路径分隔符，避免与 nodeMap 的 key 不匹配） */
  function dirOf(p) {
    return String(p).replace(/[\\/][^\\/]*$/, '');
  }

  document.addEventListener('click', hideCtx);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.tree-node')) hideCtx();
  });

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

  /** 刷新某个目录节点（root 特殊处理） */
  async function refreshNode(dirPath, expand = false) {
    if (dirPath === rootDir) {
      render();
      return;
    }
    const entry = nodeMap.get(dirPath);
    if (!entry) return;
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
      const entry = nodeMap.get(selectedPath);
      return entry.isDir ? selectedPath : dirOf(selectedPath);
    }
    return rootDir;
  }

  /** 树定位：展开 path 所在各级目录并选中该节点（不在工作目录内 / 中间读取失败 / 节点不存在 → 静默返回） */
  let revealSeq = 0;
  async function reveal(path) {
    if (!rootDir || !path) return;
    const target = String(path);
    const rootKey = normalizeKey(rootDir).replace(/\/+$/, '');
    const targetKey = normalizeKey(target).replace(/\/+$/, '');
    if (targetKey === rootKey || !targetKey.startsWith(rootKey)) return;
    const rest = targetKey.slice(rootKey.length);
    if (!rest.startsWith('/')) return; // 仅接受根内子路径（防 F:/ab 前缀误匹配 F:/a）
    const segs = rest.replace(/^\/+/, '').split('/').filter(Boolean);
    if (!segs.length) return;
    const seq = ++revealSeq;

    // 按规范化路径在 nodeMap 中查找（兼容大小写差异）
    const findNode = (key) => {
      for (const [p, entry] of nodeMap) {
        if (normalizeKey(p) === key) return entry;
      }
      return null;
    };

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

  return { setRoot, setCallbacks, refreshNode, refreshSelected, getTargetDir, select, hideCtx, reveal };
}
