// 统一查看器：图片 / mermaid 图的详情查看、Ctrl+滚轮或 Ctrl+左键缩放、复制
import { formatSize, openModal, closeModal, toast } from './ui.js';

/** 本地路径转 file:// URL（支持 Windows 反斜杠路径） */
export function pathToFileUrl(p) {
  const parts = [];
  for (const seg of String(p).split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  if (parts.length === 0) return '';
  const isDrive = /^[A-Za-z]:$/.test(parts[0]);
  return 'file:///' + parts.map((s, i) => (i === 0 && isDrive ? s : encodeURIComponent(s))).join('/');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 打开查看器
 * @param {object} opts
 * @param {'image'|'svg'} opts.kind 内容类型
 * @param {string} [opts.src] 图片 file:// 或 http(s) URL（kind=image）
 * @param {string} [opts.svgHtml] SVG HTML（kind=svg）
 * @param {string} [opts.filePath] 本地文件路径（提供后可显示大小并可复制）
 * @param {string} [opts.title] 标题
 */
export function openViewer({ kind, src, svgHtml, filePath, title }) {
  const body = document.createElement('div');
  body.className = 'viewer';

  // 显示区（可滚动）
  const stage = document.createElement('div');
  stage.className = 'viewer-stage';

  const el = document.createElement(kind === 'image' ? 'img' : 'div');
  if (kind === 'image') {
    el.src = src;
    el.alt = title || '图片';
    el.className = 'viewer-img';
  } else {
    el.className = 'mermaid-wrap';
    el.innerHTML = svgHtml;
    // mermaid 生成的 SVG width="100%" 且带内联 max-width，会被容器压缩：
    // 查看器内按 viewBox 的实际像素尺寸显示（可滚动 + 滚轮缩放）
    el.querySelectorAll('svg').forEach((svg) => {
      svg.style.maxWidth = 'none';
      const vb = svg.getAttribute('viewBox');
      const w = svg.getAttribute('width');
      const h = svg.getAttribute('height');
      if (vb) {
        const p = vb.split(/[\s,]+/).map(Number);
        if (p.length === 4 && p[2] > 0) {
          svg.style.width = p[2] + 'px';
          svg.style.height = p[3] > 0 ? p[3] + 'px' : 'auto';
          return;
        }
      }
      if (w && /px$/.test(w)) svg.style.width = w;
      if (h && /px$/.test(h)) svg.style.height = h;
    });
  }
  stage.appendChild(el);

  // 详情信息
  const info = document.createElement('div');
  info.className = 'viewer-info';
  let sizeText = '—';
  let w = '—';
  let h = '—';
  const infoHtml = () => {
    info.innerHTML = `
      <div><span>内容</span>${kind === 'image' ? '图片' : 'mermaid 图'}</div>
      ${filePath ? `<div><span>文件名</span>${esc(filePath.split(/[\\/]/).pop())}</div>` : ''}
      <div><span>尺寸</span>${w} × ${h} ${kind === 'image' ? 'px' : ''}</div>
      ${filePath ? `<div><span>文件大小</span>${esc(sizeText)}</div>` : ''}
      ${filePath ? `<div><span>位置</span>${esc(filePath)}</div>` : '<div><span>操作</span>双击预览中的图可再次打开本窗口</div>'}
    `;
  };
  infoHtml();
  if (kind === 'image' && filePath) {
    window.api
      .stat(filePath)
      .then((st) => {
        sizeText = formatSize(st.size);
        infoHtml();
      })
      .catch(() => {});
    el.addEventListener('load', () => {
      w = el.naturalWidth || '—';
      h = el.naturalHeight || '—';
      infoHtml();
    });
  }

  // 缩放（直接滚轮 / Ctrl+滚轮 / 按钮；滚轮以光标为锚点，放大对准鼠标位置）
  let zoom = 1;
  let natural = false; // 1:1 原始尺寸（zoom=1 但解除 max-width/height 限制，大图可滚动查看）
  const MIN = 0.5;
  const MAX = 5;
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'viewer-zoom';
  const applyZoom = () => {
    el.style.zoom = zoom;
    // 图片放大时移除 max-width 限制（否则缩放被容器宽度抵消，无法溢出/平移）
    if (el.classList.contains('viewer-img')) {
      if (zoom > 1 || natural) {
        el.style.maxWidth = 'none';
        el.style.maxHeight = 'none';
      } else {
        el.style.maxWidth = '100%';
        el.style.maxHeight = '54vh';
      }
    }
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  };
  /** 缩放并保持 (cx, cy)（stage 内坐标）下的内容点不动（CSS zoom 后滚动区随之缩放） */
  const zoomKeep = (before, cx, cy) => {
    applyZoom();
    const ratio = zoom / before;
    if (ratio !== 1) {
      stage.scrollLeft = Math.max(0, (stage.scrollLeft + cx) * ratio - cx);
      stage.scrollTop = Math.max(0, (stage.scrollTop + cy) * ratio - cy);
    }
  };
  /** 步进缩放（delta>0 放大）；anchor='cursor' 须配 clientX/clientY，否则锚定 stage 中心 */
  const stepZoom = (delta, anchor, e) => {
    const before = zoom;
    const next = Math.min(MAX, Math.max(MIN, +(zoom + delta).toFixed(2)));
    if (next === zoom) return;
    zoom = next;
    natural = false; // 任意步进缩放退出 1:1 模式（仅双击/1:1 按钮进入）
    const rect = stage.getBoundingClientRect();
    const cx = anchor === 'cursor' ? e.clientX - rect.left : rect.width / 2;
    const cy = anchor === 'cursor' ? e.clientY - rect.top : rect.height / 2;
    zoomKeep(before, cx, cy);
  };
  stage.addEventListener(
    'wheel',
    (e) => {
      // 详情内直接滚轮缩放（无需 Ctrl），以光标为锚点
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 0.1 : -0.1, 'cursor', e);
    },
    { passive: false }
  );
  /** 1:1 原始尺寸 ↔ 适应窗口（双击图片或按钮触发） */
  const toggleNatural = () => {
    natural = !natural;
    zoom = 1;
    applyZoom();
    if (natural) {
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
      stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
    }
  };
  if (kind === 'image') {
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      toggleNatural();
    });
  }

  // 鼠标左键按住拖拽平移查看（放大后查看不同部位）
  // 监听器按需挂载：mousedown 时挂到 document，mouseup 时摘除 —— 多次打开查看器不再累积泄漏
  let dragState = null;
  const onDragMove = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.x;
    const dy = e.clientY - dragState.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
    stage.scrollLeft = dragState.sl - dx;
    stage.scrollTop = dragState.st - dy;
  };
  const onDragUp = () => {
    if (!dragState) return;
    dragState = null;
    stage.classList.remove('dragging');
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragUp);
  };
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragState = {
      x: e.clientX,
      y: e.clientY,
      sl: stage.scrollLeft,
      st: stage.scrollTop,
      moved: false,
    };
    stage.classList.add('dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
  });

  // 操作条（.viewer-bar：普通文档流，排在图片下方 —— v0.2.4 修复被大文件横幅样式误定位到弹窗顶部）
  const bar = document.createElement('div');
  bar.className = 'viewer-bar';
  const mkBtn = (text, fn) => {
    const b = document.createElement('button');
    b.className = 'tbtn small';
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  };
  const barItems = [
    mkBtn('放大', () => stepZoom(0.2, 'center')),
    mkBtn('缩小', () => stepZoom(-0.2, 'center')),
    mkBtn('适应', () => { zoom = 1; natural = false; applyZoom(); }),
  ];
  if (kind === 'image') {
    barItems.push(mkBtn('1:1', () => { if (!natural) toggleNatural(); })); // 原始尺寸（大图可滚动）
  }
  barItems.push(zoomLabel);
  if (kind === 'image' && filePath) {
    barItems.push(
      mkBtn('📋 复制', async () => {
        try {
          const r = await window.api.copyImage(filePath);
          toast(`图片已复制（${r.width}×${r.height}）`);
          restore();
        } catch (err) {
          toast('复制失败：' + (err && err.message ? err.message : err));
        }
      })
    );
  }
  bar.append(...barItems);

  body.append(stage, info, bar);

  // 弹窗加宽（M2：关闭时的宽度清理统一由 ui.js closeModal 负责 —— 清空 #modal-box 内联宽，
  // 遮罩/「关闭」按钮两条路径均收敛到 closeModal，不再残留 860px 撑宽后续弹窗）
  const modalBox = document.getElementById('modal-box');
  modalBox.style.width = 'min(860px, calc(100vw - 48px))';
  const restore = () => closeModal();

  openModal({
    title: title || (kind === 'image' ? '图片查看' : 'mermaid 图查看'),
    body,
    actions: [{ label: '关闭', primary: true, onClick: restore }],
  });
  applyZoom();
}
