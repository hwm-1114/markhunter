// 本地目录收藏：工具栏「☆ 收藏」开关 + 左栏收藏列表（点击一键切换工作目录）
// 持久化复用 settings.favoriteDirs（string[]，去重、保序、最多 50 个），不新增 IPC
import { $, toast } from './ui.js';

const MAX_FAVORITES = 50;

/** 路径规范化（Windows 大小写不敏感：统一小写 + 正斜杠 + 去尾部斜杠） */
function normKey(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 两个路径是否指向同一目录 */
function samePath(a, b) {
  return !!a && !!b && normKey(a) === normKey(b);
}

function baseName(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** 去重 + 保持添加顺序 + 上限 50 */
function normalizeList(list) {
  const seen = new Set();
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || typeof d !== 'string') continue;
    const key = normKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

/**
 * @param {Object} opts
 * @param {(dir: string) => Promise<boolean>} opts.onOpenDir  打开目录（app.js 传入 openDirFromPath，成功返回 true）
 * @param {() => string|null} opts.getRootDir                 当前工作目录
 * @param {() => void} [opts.onStateChange]                   收藏列表变化后的可选回调
 */
export function createFavorites({ onOpenDir, getRootDir, onStateChange }) {
  const block = $('#fav-block');
  const header = $('#fav-header');
  const caret = $('#fav-caret');
  const listEl = $('#fav-list');
  const btn = $('#btn-toggle-fav');

  let list = [];
  let collapsed = false;

  function render() {
    listEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'fav-empty';
      empty.textContent = '打开目录后点工具栏 ☆ 收藏';
      listEl.appendChild(empty);
      return;
    }
    const dir = getRootDir();
    for (const d of list) listEl.appendChild(makeItem(d, dir));
  }

  function makeItem(d, currentDir) {
    const row = document.createElement('div');
    row.className = 'fav-item' + (samePath(d, currentDir) ? ' current' : '');
    row.dataset.path = d;
    row.title = d;

    const icon = document.createElement('span');
    icon.className = 'fav-icon';
    icon.textContent = '📁';

    const name = document.createElement('span');
    name.className = 'fav-name';
    name.textContent = baseName(d);
    name.title = d;

    const rm = document.createElement('span');
    rm.className = 'fav-remove';
    rm.textContent = '✕';
    rm.title = '取消收藏';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      remove(d);
    });

    row.append(icon, name, rm);
    row.addEventListener('click', () => openFav(d));
    return row;
  }

  /** 点击收藏项：复用 openDirFromPath 打开为工作目录（失败不崩溃、不移除该项） */
  async function openFav(dir) {
    const ok = await onOpenDir(dir);
    if (!ok) {
      toast(`无法打开：${dir}（目录可能已被移动或删除）`);
    }
    // 成功时 openDirFromPath 内部已调用 syncState()（按钮/高亮同步）
  }

  function isFavorite(dir) {
    return list.some((d) => samePath(d, dir));
  }

  function persist() {
    list = normalizeList(list);
    return window.api.setSettings({ favoriteDirs: list });
  }

  /** 工具栏收藏开关：无工作目录时不动作（按钮 disabled） */
  function toggle() {
    const dir = getRootDir();
    if (!dir) return;
    if (isFavorite(dir)) {
      list = list.filter((d) => !samePath(d, dir));
      toast('已取消收藏');
    } else {
      list = normalizeList([...list, dir]);
      toast(`已收藏 ${baseName(dir)}`);
    }
    persist();
    render();
    syncState();
    if (onStateChange) onStateChange();
  }

  /** 从收藏中移除（hover ✕） */
  function remove(dir) {
    list = list.filter((d) => !samePath(d, dir));
    persist();
    render();
    syncState(); // 若移除的是当前目录，按钮文案同步复位
    if (onStateChange) onStateChange();
  }

  /** 同步工具栏按钮状态 + 列表当前项高亮（openDirFromPath 成功后由 app.js 调用） */
  function syncState() {
    const dir = getRootDir();
    btn.disabled = !dir;
    btn.textContent = dir && isFavorite(dir) ? '★ 已收藏' : '☆ 收藏';
    for (const el of listEl.querySelectorAll('.fav-item')) {
      el.classList.toggle('current', samePath(el.dataset.path, dir));
    }
  }

  /** 启动时加载收藏列表并同步状态 */
  async function load() {
    const s = await window.api.getSettings();
    list = normalizeList(s.favoriteDirs);
    render();
    syncState();
  }

  // 标题行可折叠
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    block.classList.toggle('collapsed', collapsed);
    caret.textContent = collapsed ? '▶' : '▼';
  });

  return { load, toggle, syncState, isFavorite, getList: () => list.slice() };
}
