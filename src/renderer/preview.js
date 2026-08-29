// Markdown 预览（含 mermaid 渲染、图片路径解析与双击详情）
// P5（v0.1.45）：mermaid 拆包 —— 主 bundle 不再静态引入 mermaid（原占 ~74%）。
// 首次需要渲染时动态注入同源 <script src="dist/mermaid-chunk.js">（CSP script-src 'self' 允许；
// file:// 下同源经典 script 注入可行，跨文件 ESM import 有 CORS 限制故不用 import()）。
// chunk 内 iife 将 mermaid 实例暴露到 window.__mermaid；就绪前 mermaid 块保持 pre>code 占位，
// 失败时显示错误占位。异步就绪已融入渲染路径（renderMermaid 内部 await），冒烟用例等待即可。
import MarkdownIt from 'markdown-it';
import { $, isMarkdown, stripChunkMarkers, showContextMenu, toast } from './ui.js';
import { openViewer } from './viewer.js';

const md = new MarkdownIt({
  html: false,      // 不渲染原始 HTML，防注入
  linkify: true,
  breaks: true,
  typographer: true,
});

md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => '</table></div>';

// ---------- P5：mermaid 惰性加载（chunk 就绪 Promise） ----------
let mermaidChunkPromise = null;
function loadMermaid() {
  if (window.__mermaid) return Promise.resolve(window.__mermaid);
  if (mermaidChunkPromise) return mermaidChunkPromise;
  mermaidChunkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'dist/mermaid-chunk.js';
    s.onload = () => {
      if (window.__mermaid) resolve(window.__mermaid);
      else reject(new Error('mermaid chunk 加载完成但未暴露 window.__mermaid'));
    };
    s.onerror = () => reject(new Error('mermaid 组件加载失败（dist/mermaid-chunk.js 缺失）'));
    document.head.appendChild(s);
  });
  return mermaidChunkPromise;
}

/** chunk 加载失败兜底：所有 mermaid 块替换为错误占位（防止无限等待/空白） */
function failAllMermaidBlocks(contentEl, err) {
  const blocks = contentEl ? contentEl.querySelectorAll('pre > code.language-mermaid') : [];
  for (const code of Array.from(blocks)) {
    const div = document.createElement('div');
    div.className = 'mermaid-error';
    div.textContent = 'mermaid 渲染失败：' + (err && err.message ? err.message : err);
    code.parentElement.replaceWith(div);
  }
}

let mermaidSeq = 0;
let renderToken = 0;

// P2（v0.1.44）：mermaid SVG 内容哈希缓存 —— key = 明暗 + 源码。
// 同一（源码 src + 明暗主题）重复渲染直接复用 SVG，跳过 mermaid.render（击键防抖合并后的整篇重渲染不再重画图）。
// 仅 renderMermaid（打字/文档重渲染路径）使用；reRenderMermaid（主题切换路径）不缓存，
// 由 P3 明暗守卫 + renderToken 协议保证「明暗跨界恰好重渲一次」的既有语义。
const mermaidSvgCache = new Map();
const MERMAID_CACHE_MAX = 64;
function mermaidCacheKey(dark, src) {
  return (dark ? 'dark:' : 'light:') + src;
}
function mermaidCacheGet(key) {
  return mermaidSvgCache.get(key) || null;
}
function mermaidCacheSet(key, svg) {
  if (mermaidSvgCache.size >= MERMAID_CACHE_MAX) {
    mermaidSvgCache.delete(mermaidSvgCache.keys().next().value); // 简单 FIFO 淘汰，防止无界增长
  }
  mermaidSvgCache.set(key, svg);
}

/** P2 补强（v0.1.45）：SVG 实例内 id 唯一化 —— 缓存命中等场景下同一源码的 SVG 会以多实例
 *  注入同一文档（同图多次出现），内部 id（defs/marker/gradient/样式选择器）重复会让浏览器
 *  url(#id)/CSS 选择器全部命中第一个实例，产生渲染错乱。注入前对 id 属性与引用统一追加
 *  文档内唯一后缀（缓存里仍存原始 SVG，后缀只加在注入实例上，重复渲染幂等）。 */
let mermaidInstanceSeq = 0;
function uniquifySvg(svg, suffix) {
  if (typeof svg !== 'string' || svg.indexOf('id=') < 0) return svg;
  const sfx = '-' + String(suffix);
  // 1) id="..." 属性（负向后顾排除 data-id= 等「-id」结尾属性名；Chromium 62+ 支持后顾断言）
  svg = svg.replace(/(?<![\w-])(id\s*=\s*["'])([^"']+)(["'])/g, (m, a, id, b) => a + id + sfx + b);
  // 2) url(#id) 引用（含 url("#id") 引号变体）
  svg = svg.replace(/(url\(\s*["']?#)([^"')]+)(["']?\))/g, (m, a, id, b) => a + id + sfx + b);
  // 3) href="#id" / xlink:href="#id"
  svg = svg.replace(/((?:xlink:)?href\s*=\s*["']#)([^"']+)(["'])/g, (m, a, id, b) => a + id + sfx + b);
  // 4) <style> 内 #id 选择器（mermaid 以 #生成的id .class{...} 定位节点样式）。
  //    仅当 #id 后跟空白、{ 或 ,（逗号分组选择器）才改写，避免误伤十六进制色值（fill:#ECECFF; 等）
  svg = svg.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (m, open, css, close) =>
    open + css.replace(/#([A-Za-z_][\w.-]*)(?=[\s{,:])/g, (mm, id) => '#' + id + sfx) + close
  );
  return svg;
}
/** 解析 markdown 图片引用为绝对 file:// URL（支持 Windows 反斜杠路径与 ./ ../） */
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

/** 预览图片 file:// URL → 本地磁盘路径（外链 http(s)/data: 返回 null） */
function imgLocalPath(img) {
  const src = img.getAttribute('src') || '';
  return src.startsWith('file:///') ? decodeURIComponent(src.slice('file:///'.length)) : null;
}

/** 预览图片右键菜单：复制原图（不压缩）/ 在文件夹中显示 / 打开查看器（v0.2.4） */
function showPreviewImgMenu(e, img, tab) {
  const filePath = imgLocalPath(img);
  const items = [];
  if (filePath) {
    items.push({
      label: '📋 复制图片（原图）',
      onClick: async () => {
        try {
          const r = await window.api.copyImage(filePath);
          toast(`图片已复制（${r.width}×${r.height}）`);
        } catch (err) {
          toast('复制失败：' + (err && err.message ? err.message : err));
        }
      },
    });
    items.push({ label: '📁 在文件夹中显示', onClick: () => { window.api.showInFolder(filePath); } });
    items.push({ sep: true });
  }
  items.push({ label: '🔍 打开图片查看器', onClick: () => showImageDetail(img, tab) });
  showContextMenu(e.clientX, e.clientY, items);
}

export function createPreview(getEditor, getTab, getIsDark) {
  const previewHost = $('#preview-host');
  const contentEl = $('#preview-content');
  const editorHost = $('#editor-host');
  const divider = $('#split-divider');

  let mode = 'split'; // edit | split | preview

  // ---------- mermaid 主题状态（P3 瘦身守卫 + H1 冷启动防御 + M4 补渲；P5 改为实例就绪后按需初始化） ----------
  let lastMermaidDark = null;   // 上次 mermaid.initialize 时的明暗状态（null = 尚未初始化）
  let mermaidThemeDirty = false; // 明暗已变化但尚未执行 initialize（mermaid 未加载时先记录，渲染路径补做）
  let mermaidRenderCount = 0;   // 实际 mermaid.render 调用次数（冒烟断言用）
  let renderCount = 0;          // preview.render 调用次数（P1 防抖冒烟断言用）

  /** 按当前明暗初始化 mermaid（需要已加载的实例 m）。
   *  明暗未变化且已初始化时返回 false 并跳过（P3：避免每次 applyTheme 全量重初始化）；
   *  返回 true 表示本次发生了初始化。 */
  function ensureMermaidTheme(m) {
    const dark = !!(getIsDark && getIsDark());
    if (lastMermaidDark === dark && !mermaidThemeDirty) return false;
    lastMermaidDark = dark;
    mermaidThemeDirty = false;
    m.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'default',
      securityLevel: 'strict',
    });
    return true;
  }

  async function renderMermaid() {
    let m;
    try {
      m = await loadMermaid();
    } catch (err) {
      failAllMermaidBlocks(contentEl, err);
      return;
    }
    ensureMermaidTheme(m); // H1 防御：首次渲染前按当前明暗初始化（与 refreshMermaid 共用 lastMermaidDark 去重）
    const token = ++renderToken;
    const dark = !!(getIsDark && getIsDark());
    const blocks = contentEl.querySelectorAll('pre > code.language-mermaid');
    for (const code of Array.from(blocks)) {
      const pre = code.parentElement;
      const id = 'mermaid-' + Date.now() + '-' + ++mermaidSeq;
      const src = code.textContent;
      const key = mermaidCacheKey(dark, src);
      const cached = mermaidCacheGet(key); // P2：同内容（src + 明暗）缓存命中 → 复用 SVG，跳过 mermaid.render
      try {
        let svg = cached;
        if (svg === null) {
          mermaidRenderCount++; // 冒烟口径：mermaidRenderCount = 实际 mermaid.render 调用次数
          ({ svg } = await m.render(id, src));
          if (token !== renderToken) continue; // 已有更新的渲染，丢弃过期结果（不落缓存）
          mermaidCacheSet(key, svg);
        }
        if (token !== renderToken) continue;
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-wrap';
        wrap.dataset.mermaidSrc = src; // 保留源码，主题切换后可按明暗重渲染
        // P2 补强：实例内 id 唯一化（缓存命中复用 SVG 时，同图多实例的 defs/id/样式选择器不冲突）
        svg = uniquifySvg(svg, 'mh' + ++mermaidInstanceSeq);
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
   *  并补渲 M4 竞态残留的 pre > code.language-mermaid（主题切换恰逢首次渲染进行中时遗留）。
   *  失败或过期结果由 renderToken 守卫丢弃（与 renderMermaid 同一令牌协议） */
  async function reRenderMermaid() {
    let m;
    try {
      m = await loadMermaid();
    } catch (err) {
      failAllMermaidBlocks(contentEl, err);
      return;
    }
    ensureMermaidTheme(m); // P3：明暗跨界时按当前明暗重新初始化
    const token = ++renderToken;
    // M4：除已渲染的 .mermaid-wrap 外，另收集未渲染的 pre>code.language-mermaid 残留容器
    const items = [];
    contentEl.querySelectorAll('.mermaid-wrap').forEach((wrap) => {
      const src = wrap.dataset.mermaidSrc;
      if (src) items.push({ container: wrap, src, isWrap: true });
    });
    contentEl.querySelectorAll('pre > code.language-mermaid').forEach((code) => {
      items.push({ container: code.parentElement, src: code.textContent, isWrap: false });
    });
    if (items.length === 0) return;
    for (const it of items) {
      const id = 'mermaid-' + Date.now() + '-' + ++mermaidSeq;
      try {
        mermaidRenderCount++;
        const { svg } = await m.render(id, it.src);
        if (token !== renderToken) continue;
        const uniqueSvg = uniquifySvg(svg, 'mh' + ++mermaidInstanceSeq); // 实例 id 唯一化（同源多实例/主题往返）
        if (it.isWrap) {
          const wrap = it.container;
          wrap.innerHTML = uniqueSvg;
          wrap.title = '双击放大查看';
        } else {
          // 残留 pre 补渲 → 替换为 .mermaid-wrap（与 renderMermaid 同构）
          const wrap = document.createElement('div');
          wrap.className = 'mermaid-wrap';
          wrap.dataset.mermaidSrc = it.src;
          wrap.innerHTML = uniqueSvg;
          wrap.title = '双击放大查看';
          wrap.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            openViewer({ kind: 'svg', svgHtml: wrap.innerHTML, title: 'mermaid 图' });
          });
          it.container.replaceWith(wrap);
        }
      } catch (err) {
        if (token !== renderToken) continue;
        if (it.isWrap) {
          it.container.textContent = 'mermaid 渲染失败：' + (err && err.message ? err.message : err);
        } else {
          const div = document.createElement('div');
          div.className = 'mermaid-error';
          div.textContent = 'mermaid 渲染失败：' + (err && err.message ? err.message : err);
          it.container.replaceWith(div);
        }
      }
    }
  }

  /** 主题切换入口：由 app.js applyTheme 在 boot/设置保存/即时预览时统一调用。
   *  P3 瘦身：仅当明暗状态实际变化时才标记重渲（mermaidThemeDirty），渲染路径执行 initialize；
   *  无图（无 .mermaid-wrap 且无 pre>code.language-mermaid）直接跳过；
   *  M4：存在残留未渲染块时即使明暗未变也补渲。securityLevel:'strict' 保持不变。 */
  function refreshMermaid() {
    const dark = !!(getIsDark && getIsDark());
    if (lastMermaidDark !== dark) mermaidThemeDirty = true; // 明暗变化：记录，渲染路径按需 initialize
    const wraps = contentEl.querySelectorAll('.mermaid-wrap');
    const leftovers = contentEl.querySelectorAll('pre > code.language-mermaid');
    if (wraps.length === 0 && leftovers.length === 0) return; // 无图：跳过
    if (!mermaidThemeDirty && leftovers.length === 0) return; // 明暗未变且无残留：跳过重渲（P3，下拉连点同明暗不重画）
    reRenderMermaid(); // renderToken 协议自动丢弃过期结果（下拉连点竞态）
  }

  function render() {
    renderCount++;
    const tab = getTab();
    // viewer-lg（>256MB 大文件查看器）：窗口内容不做 markdown 渲染（整窗 toString 亦应避免放大）
    if (!tab || tab.kind === 'viewer-lg' || !isMarkdown(tab.name)) {
      contentEl.innerHTML = '';
      return;
    }
    // P7：分段模式文档含占位标记（HTML 注释形态），渲染前剥离，预览不可见
    const html = md.render(stripChunkMarkers(tab.state.doc.toString()));
    contentEl.innerHTML = html;
    // 外链新窗口打开
    contentEl.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (/^https?:\/\//i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
    // 图片：解析为绝对路径 + 双击查看详情 + 右键菜单（v0.2.4）
    contentEl.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      img.src = resolveImgSrc(src, tab.path);
      img.classList.add('preview-img');
      img.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        showImageDetail(img, tab);
      });
      img.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showPreviewImgMenu(e, img, tab);
      });
    });
    // mermaid 图（P5：仅当文档实际含 mermaid 块才触发惰性加载，避免无图文档白加载 3MB chunk）
    if (contentEl.querySelector('pre > code.language-mermaid')) {
      renderMermaid();
    }
  }

  function applyMode() {
    const tab = getTab();
    const imageHost = $('#image-host');
    const diffHostEl = $('#diff-host');
    const viewerBar = $('#viewer-bar');
    if (viewerBar) viewerBar.classList.add('hidden');
    if (tab && tab.kind === 'image') {
      // 图片标签页：编辑区显示图片，隐藏编辑器/预览/分隔条
      editorHost.classList.add('hidden');
      previewHost.classList.add('hidden');
      divider.classList.add('hidden');
      imageHost.classList.remove('hidden');
      if (diffHostEl) diffHostEl.classList.add('hidden');
      return;
    }
    imageHost.classList.add('hidden');
    if (tab && tab.kind === 'diff') {
      // 对比标签页：双栏 diff 独占编辑区（tabs.js renderDiff 已渲染内容）
      editorHost.classList.add('hidden');
      previewHost.classList.add('hidden');
      divider.classList.add('hidden');
      if (diffHostEl) diffHostEl.classList.remove('hidden');
      return;
    }
    if (diffHostEl) diffHostEl.classList.add('hidden');
    // viewer-lg：编辑区只读显示 + 查看器横幅；无 markdown 预览
    if (viewerBar) viewerBar.classList.toggle('hidden', !(tab && tab.kind === 'viewer-lg'));
    const canPreview = tab && tab.kind !== 'viewer-lg' && isMarkdown(tab.name);
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
    if (!tab || tab.kind === 'viewer-lg' || !isMarkdown(tab.name)) return;
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

  return {
    render, applyMode, cycleMode, setMode, getMode, refreshMermaid, resetZoom: () => setZoom(1),
    // 冒烟断言用：实际 mermaid.render 调用计数（P3 明暗守卫 / M4 补渲 / P2 缓存验证）
    get mermaidRenderCount() { return mermaidRenderCount; },
    // 冒烟断言用：preview.render 调用计数（P1 击键防抖验证）
    get renderCount() { return renderCount; },
  };
}
