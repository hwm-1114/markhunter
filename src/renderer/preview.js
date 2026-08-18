// Markdown 预览（含 mermaid 渲染、图片路径解析与双击详情）
import MarkdownIt from 'markdown-it';
import mermaid from 'mermaid';
import { $, isMarkdown } from './ui.js';
import { openViewer } from './viewer.js';

const md = new MarkdownIt({
  html: false,      // 不渲染原始 HTML，防注入
  linkify: true,
  breaks: true,
  typographer: true,
});

md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => '</table></div>';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
});

let mermaidSeq = 0;
let renderToken = 0;/** 解析 markdown 图片引用为绝对 file:// URL（支持 Windows 反斜杠路径与 ./ ../） */
function resolveImgSrc(src, mdPath) {
  const s = String(src).trim();
  if (/^(https?:|data:|file:)/i.test(s)) return s;
  const base = String(mdPath).replace(/[\\/][^\\/]*$/, '');
  // 统一为反斜杠后拼接并归一化 . / .. 段
  const joined = (base ? base + '\\' : '') + s.replace(/\//g, '\\');
  const parts = [];
  for (const seg of joined.split('\\')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  if (parts.length === 0) return '';
  // Windows 盘符（F:）保留冒号，其余段逐段编码
  const isDrive = /^[A-Za-z]:$/.test(parts[0]);
  const encoded = parts.map((seg, i) => (i === 0 && isDrive ? seg : encodeURIComponent(seg)));
  return 'file:///' + encoded.join('/');
}

/** 双击图片 → 打开查看器 */
function showImageDetail(img, tab) {
  const src = img.getAttribute('src') || '';
  let filePath = null;
  if (src.startsWith('file:///')) {
    filePath = decodeURIComponent(src.slice('file:///'.length));
  }
  openViewer({
    kind: 'image',
    src,
    filePath: filePath || undefined,
    title: filePath ? filePath.split(/[\\/]/).pop() : img.alt || '图片',
  });
}

export function createPreview(getEditor, getTab, getIsDark) {
  const previewHost = $('#preview-host');
  const contentEl = $('#preview-content');
  const editorHost = $('#editor-host');
  const divider = $('#split-divider');

  let mode = 'split'; // edit | split | preview

  async function renderMermaid() {
    const token = ++renderToken;
    const blocks = contentEl.querySelectorAll('pre > code.language-mermaid');
    for (const code of Array.from(blocks)) {
      const pre = code.parentElement;
      const id = 'mermaid-' + Date.now() + '-' + ++mermaidSeq;
      try {
        const { svg } = await mermaid.render(id, code.textContent);
        if (token !== renderToken) continue; // 已有更新的渲染，丢弃过期结果
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-wrap';
        wrap.dataset.mermaidSrc = code.textContent; // 保留源码，主题切换后可按明暗重渲染
        wrap.innerHTML = svg;
        wrap.title = '双击放大查看';
        // 双击 mermaid 图 → 打开查看器
        wrap.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          openViewer({ kind: 'svg', svgHtml: wrap.innerHTML, title: 'mermaid 图' });
        });
        pre.replaceWith(wrap);
      } catch (err) {
        if (token !== renderToken) continue;
        const div = document.createElement('div');
        div.className = 'mermaid-error';
        div.textContent = 'mermaid 渲染失败：' + (err && err.message ? err.message : err);
        pre.replaceWith(div);
      }
    }
  }

  /** 主题切换后重渲染已渲染的 mermaid 块：仅刷新 .mermaid-wrap 的 SVG 内容（保留滚动位置），
   *  失败或过期结果由 renderToken 守卫丢弃（与 renderMermaid 同一令牌协议） */
  async function reRenderMermaid() {
    const token = ++renderToken;
    const wraps = contentEl.querySelectorAll('.mermaid-wrap');
    for (const wrap of Array.from(wraps)) {
      const src = wrap.dataset.mermaidSrc;
      if (!src) continue;
      const id = 'mermaid-' + Date.now() + '-' + ++mermaidSeq;
      try {
        const { svg } = await mermaid.render(id, src);
        if (token !== renderToken) continue;
        wrap.innerHTML = svg;
        wrap.title = '双击放大查看';
      } catch (err) {
        if (token !== renderToken) continue;
        wrap.textContent = 'mermaid 渲染失败：' + (err && err.message ? err.message : err);
      }
    }
  }

  /** 按当前主题明暗切换 mermaid 主题（dark → 'dark'，浅色 → 'default'）并重渲染已渲染的图。
   *  securityLevel:'strict' 保持不变；由 app.js applyTheme 在 boot/设置保存/即时预览时统一调用 */
  function refreshMermaid() {
    const dark = getIsDark ? !!getIsDark() : false;
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'default',
      securityLevel: 'strict',
    });
    reRenderMermaid();
  }

  function render() {
    const tab = getTab();
    if (!tab || !isMarkdown(tab.name)) {
      contentEl.innerHTML = '';
      return;
    }
    const html = md.render(tab.state.doc.toString());
    contentEl.innerHTML = html;
    // 外链新窗口打开
    contentEl.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (/^https?:\/\//i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
    // 图片：解析为绝对路径 + 双击查看详情
    contentEl.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      img.src = resolveImgSrc(src, tab.path);
      img.classList.add('preview-img');
      img.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        showImageDetail(img, tab);
      });
    });
    // mermaid 图
    renderMermaid();
  }

  function applyMode() {
    const tab = getTab();
    const imageHost = $('#image-host');
    if (tab && tab.kind === 'image') {
      // 图片标签页：编辑区显示图片，隐藏编辑器/预览/分隔条
      editorHost.classList.add('hidden');
      previewHost.classList.add('hidden');
      divider.classList.add('hidden');
      imageHost.classList.remove('hidden');
      return;
    }
    imageHost.classList.add('hidden');
    const canPreview = tab && isMarkdown(tab.name);
    // 非 Markdown 文件（txt/json/py 等）编辑器始终显示，仅 Markdown 参与分屏/仅预览切换
    previewHost.classList.toggle('hidden', !canPreview || mode === 'edit');
    previewHost.classList.toggle('full', canPreview && mode === 'preview');
    editorHost.classList.toggle('hidden', canPreview && mode === 'preview');
    editorHost.classList.toggle('half', canPreview && mode !== 'edit');
    divider.classList.toggle('hidden', !(canPreview && mode === 'split'));
    if (canPreview && mode !== 'edit') render();
  }

  function cycleMode() {
    const tab = getTab();
    if (!tab || !isMarkdown(tab.name)) return;
    const order = ['edit', 'split', 'preview'];
    mode = order[(order.indexOf(mode) + 1) % order.length];
    applyMode();
    return mode;
  }

  function setMode(m) {
    mode = m;
    applyMode();
  }

  function getMode() {
    return mode;
  }

  // 滚动跟随：预览滚动 → 编辑区按比例滚动
  let scrollSync = true;
  previewHost.addEventListener('scroll', () => {
    if (!scrollSync) return;
    const editor = getEditor().getView();
    const sp = previewHost;
    const maxP = sp.scrollHeight - sp.clientHeight;
    const maxE = editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight;
    if (maxP <= 0 || maxE <= 0) return;
    editor.scrollDOM.scrollTop = (sp.scrollTop / maxP) * maxE;
  });

  // 双击预览区空白处可临时暂停/恢复同步（图片/mermaid 上的双击会 stopPropagation）
  previewHost.addEventListener('dblclick', () => {
    scrollSync = !scrollSync;
    previewHost.style.outline = scrollSync ? '' : '2px dashed color-mix(in oklab, var(--mh-accent) 60%, var(--mh-bg-panel))';
    setTimeout(() => { previewHost.style.outline = ''; }, 1200);
  });

  // ---------- Ctrl + 滚轮缩放预览（放大查看 mermaid 图等） ----------
  const zoomBadge = $('#zoom-badge');
  let previewZoom = 1;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3;

  function setZoom(z) {
    previewZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    previewHost.style.zoom = previewZoom;
    zoomBadge.textContent = Math.round(previewZoom * 100) + '%';
    zoomBadge.classList.remove('hidden');
    clearTimeout(zoomBadge._t);
    zoomBadge._t = setTimeout(() => zoomBadge.classList.add('hidden'), 1500);
  }

  previewHost.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(previewZoom + (e.deltaY < 0 ? 0.1 : -0.1));
    },
    { passive: false }
  );

  // ---------- 分隔条拖拽调整左右宽度 ----------
  let dragging = false;
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    divider.classList.add('dragging');
    const wrap = divider.parentElement;
    const startX = e.clientX;
    const startW = editorHost.getBoundingClientRect().width;
    const onMove = (ev) => {
      if (!dragging) return;
      const delta = ev.clientX - startX;
      const w = Math.min(Math.max(startW + delta, 120), wrap.clientWidth - 160);
      editorHost.style.flex = `0 0 ${w}px`;
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
  // 双击分隔条恢复默认等分
  divider.addEventListener('dblclick', () => {
    editorHost.style.flex = '';
  });

  return { render, applyMode, cycleMode, setMode, getMode, refreshMermaid, resetZoom: () => setZoom(1) };
}
