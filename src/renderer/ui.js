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

// ---------- 弹窗 ----------
const mask = $('#modal-mask');
const box = $('#modal-box');

export function openModal({ title, body, actions }) {
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
  mask.classList.remove('hidden');
  const firstInput = bodyEl.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
}

export function closeModal() {
  mask.classList.add('hidden');
}

mask.addEventListener('mousedown', (e) => {
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
  p.style.cssText = 'color:#52606d;line-height:1.7;white-space:pre-wrap;word-break:break-all;';
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
