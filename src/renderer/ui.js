// 通用工具与弹窗

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 通用 trailing 防抖（P1：击键等高频事件合并为一次执行）。
 *  delay 毫秒内连续调用只执行最后一次；返回的包装函数自带 cancel() 可取消未触发的调用。 */
export function debounce(fn, delay = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function formatSize(n) {
  if (n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 根据文件名判断语言 */
export function langFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'md': case 'markdown': return 'markdown';
    case 'json': return 'json';
    case 'py': return 'python';
    default: return 'text';
  }
}

export function isMarkdown(name) {
  return langFor(name) === 'markdown';
}

export function isPython(name) {
  return langFor(name) === 'python';
}

export function baseName(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

export function dirName(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

// ---------- P7：大文件分段模式占位标记 ----------
// 分段打开（>4MB）时文档末尾追加该占位标记告知「未完」，滚动/保存前按需续读；
// 标记是 HTML 注释形态（markdown 预览剥离后不可见），保存与预览前统一剥离，防止污染文件内容。
export const CHUNK_MARKER_RE = /\n?<!-- MH-CHUNKED[^\n]*-->\n?/g;
export function stripChunkMarkers(text) {
  return String(text).replace(CHUNK_MARKER_RE, '');
}

// ---------- 弹窗 ----------
const mask = $('#modal-mask');
const box = $('#modal-box');
let modalOnClose = null; // M1：当前弹窗的关闭钩子（遮罩 / 取消 / 按钮关闭统一在 closeModal 触发，一次性）

export function openModal({ title, body, actions, onClose }) {
  $('#modal-title').textContent = title;
  const bodyEl = $('#modal-body');
  bodyEl.innerHTML = '';
  bodyEl.appendChild(body);
  const actEl = $('#modal-actions');
  actEl.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = `tbtn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`;
    btn.textContent = a.label;
    btn.onclick = () => a.onClick(btn);
    actEl.appendChild(btn);
  }
  // M1：登记关闭钩子（如设置弹窗的「还原打开时主题预览」）；closeModal 统一触发
  modalOnClose = typeof onClose === 'function' ? onClose : null;
  mask.classList.remove('hidden');
  const firstInput = bodyEl.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
}

/** 关闭弹窗。skipOnClose=true 时跳过关闭钩子（如设置「保存」路径——已落盘并应用新值，不应还原预览）。 */
export function closeModal(skipOnClose) {
  // M2：统一清空 #modal-box 内联宽度 —— 查看器等加宽弹窗经遮罩关闭后不再残留 860px，
  // 避免此后所有弹窗（含设置）被撑宽（viewer.js 的 restore 亦依赖此处统一清理）
  if (box) box.style.width = '';
  mask.classList.add('hidden');
  if (skipOnClose) {
    modalOnClose = null;
    return;
  }
  const cb = modalOnClose;
  modalOnClose = null;
  if (typeof cb === 'function') cb();
}

mask.addEventListener('mousedown', (e) => {
  // M1：点遮罩关闭也走 closeModal → 触发 onClose 钩子（还原主题预览等）
  if (e.target === mask) closeModal();
});

/** 单行输入弹窗（新建文件/目录、重命名） */
export function showPrompt(title, label, initial, onOk) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial || '';
  input.placeholder = label;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
  });
  wrap.append(lbl, input);
  let okBtn;
  openModal({
    title,
    body: wrap,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '确定', primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          const val = input.value.trim();
          if (!val) { btn.disabled = false; return; }
          try {
            await onOk(val);
            closeModal();
          } catch (err) {
            alertBox('操作失败', String(err.message || err));
            btn.disabled = false;
          }
        },
      },
    ],
  });
  okBtn = box.querySelector('.modal-actions .tbtn:last-child');
}

/** 提示信息弹窗 */
export function alertBox(title, message) {
  const p = document.createElement('p');
  p.style.cssText = 'color:var(--mh-text-2);line-height:1.7;white-space:pre-wrap;word-break:break-all;';
  p.textContent = message;
  openModal({
    title,
    body: p,
    actions: [{ label: '知道了', primary: true, onClick: closeModal }],
  });
}

/** 确认弹窗（原生） */
export async function confirmDialog(message, title = '确认操作') {
  const res = await window.api.confirm({ title, message });
  return res === 1;
}

export function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('show');
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 1600);
  }, 10);
}

/** 通用分隔条拖拽调整尺寸
 * opts: { target: 选择器或元素, dir: 'x'(宽)|'y'(高), min, max, reverse }
 * reverse: 反向（分隔条在目标右侧/下侧时，向分隔条方向拖 = 加大） */
export function initDragResize(divider, opts) {
  const getTarget = () =>
    typeof opts.target === 'string' ? document.querySelector(opts.target) : opts.target;
  let dragging = false;
  divider.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    divider.classList.add('dragging');
    const target = getTarget();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize =
      opts.dir === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;
    const onMove = (ev) => {
      if (!dragging) return;
      const rawDelta = opts.dir === 'x' ? ev.clientX - startX : ev.clientY - startY;
      const delta = opts.reverse ? -rawDelta : rawDelta;
      const size = Math.min(opts.max, Math.max(opts.min, startSize + delta));
      if (opts.dir === 'x') {
        target.style.width = size + 'px';
        target.style.maxWidth = 'none';
      } else {
        target.style.height = size + 'px';
        target.style.maxHeight = 'none';
      }
    };
    const onUp = () => {
      dragging = false;
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  divider.addEventListener('dblclick', () => {
    const target = getTarget();
    if (opts.dir === 'x') {
      target.style.width = '';
      target.style.maxWidth = '';
    } else {
      target.style.height = '';
      target.style.maxHeight = '';
    }
  });
}

// ---------- 通用右键菜单 ----------
// items 结构与 tree.js 原 renderCtxMenu 相同：
//   { label, onClick }  普通项（点击后自动隐藏菜单并调用 onClick）
//   { label, danger, onClick }  危险项（红色样式）
//   { sep: true }  分隔线
// 点击页面其它位置 / 按 Esc / 再次右键空白处 都会自动隐藏。
const ctxMenu = $('#ctx-menu');

let suppressCtxHide = false; // 本次 contextmenu 冒泡到 document 时刚渲染了新菜单 → 不隐藏

/** 在 (x, y) 显示右键菜单（坐标越界时 clamp 到窗口内） */
export function showContextMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  for (const it of items || []) {
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
      hideContextMenu();
      if (typeof it.onClick === 'function') it.onClick();
    });
    ctxMenu.appendChild(el);
  }
  ctxMenu.classList.remove('hidden');
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
  suppressCtxHide = true;
  // 若调用方（如树节点）对 contextmenu 做了 stopPropagation，document 监听器不会消费该标记，
  // 用下一个宏任务自动复位，避免残留导致后续右键空白处无法隐藏菜单
  setTimeout(() => { suppressCtxHide = false; }, 0);
}

export function hideContextMenu() {
  ctxMenu.classList.add('hidden');
  ctxMenu.innerHTML = '';
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('contextmenu', () => {
  if (suppressCtxHide) {
    suppressCtxHide = false;
    return;
  }
  hideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});
