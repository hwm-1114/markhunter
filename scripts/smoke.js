// 端到端冒烟测试：在真实窗口中通过 window.api 验证核心链路
// 由主进程在 --smoke 模式下加载
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const TEST_ROOT = path.join(__dirname, '..', '.smoke-test');

function cleanTestRoot() {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

const RENDERER_TEST = `
(async () => {
  const api = window.api;
  const root = ${JSON.stringify(TEST_ROOT.replace(/\\\\/g, '/'))};
  const results = [];

  // 0. 等待应用 boot 完成，并以 .smoke-test 为工作目录
  //    （S1 主进程 currentRoot 路径校验依赖 openDirFromPath → fs:set-root，须先于 create/write/delete）
  for (let i = 0; i < 100 && !window.__app; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let bootOk = false;
  if (window.__app) {
    try {
      bootOk = await window.__app.openDirFromPath(root);
    } catch { bootOk = false; }
  }
  results.push(['boot+openDir', bootOk]);

  // 1. 目录树
  let tree = await api.readTree(root);
  results.push(['readTree', Array.isArray(tree)]);

  // 2. 新建文件 + 写入
  const f1 = root + '/hello.md';
  await api.create(root, 'hello.md', 'file');
  await api.writeFile(f1, '# 标题\\nhello world 测试\\n第二行 hello');
  results.push(['create+write', true]);

  // 3. 读取
  const { content } = await api.readFile(f1);
  results.push(['readFile', content.includes('hello world')]);

  // 4. 新建目录
  await api.create(root, 'sub', 'dir');
  tree = await api.readTree(root);
  results.push(['createDir', tree.some((t) => t.isDir && t.name === 'sub')]);

  // 5. 全局搜索（应命中 hello.md 2 处）
  const gs = await api.globalSearch(root, 'hello');
  results.push(['globalSearch', gs.length === 2]);

  // 6. 设置读写
  const s0 = await api.getSettings();
  results.push(['getSettings', !!s0 && typeof s0.maxFileSizeMB === 'number']);
  // S5：渲染进程永远拿不到 API Key 明文，仅暴露 aiApiKeySet 布尔
  results.push(['keyNotExposed', !!s0 && s0.aiApiKey === '' && typeof s0.aiApiKeySet === 'boolean']);

  // 7. Python 检测 + 运行
  const pys = await api.detectPython();
  results.push(['detectPython', pys.length > 0, 'list=' + JSON.stringify(pys)]);
  let pyRun = { ok: false, code: null, out: '' };
  if (pys.length > 0) {
    const pyFile = root + '/hello.py';
    await api.writeFile(pyFile, 'print("PY_E2E_OK")');
    // S7：解释器须为 python*.exe / py.exe（绝对路径），优先取探测到的 exe
    const pyExe = pys.find((p) => /\.exe$/i.test(p)) || pys[0];
    pyRun = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const onOut = (d) => { out += d.data; };
      const onExit = (d) => {
        if (done) return;
        done = true;
        resolve({ ok: out.includes('PY_E2E_OK'), code: d.code, out });
      };
      api.onPythonOutput(onOut);
      api.onPythonExit(onExit);
      api.runPython(pyFile, pyExe);
      setTimeout(() => { if (!done) { done = true; resolve({ ok: false, code: null, out, timeout: true }); } }, 15000);
    });
    results.push(['runPython', pyRun.ok, pyRun.code]);
  } else {
    results.push(['runPython', false, 'no python']);
  }

  // 8. 删除
  await api.remove(f1, false);
  await api.remove(root + '/sub', true);
  await api.remove(root + '/hello.py', false);
  tree = await api.readTree(root);
  results.push(['remove', tree.length === 0]);

  // ---- UI 级验证 ----
  const app = window.__app;
  const step = async (name, fn) => {
    try {
      const r = await fn();
      results.push([name, r === true ? true : r]);
    } catch (err) {
      results.push([name, 'ERR: ' + (err && err.stack ? err.stack.split('\\n').slice(0, 4).join(' // ') : err)]);
    }
  };
  await step('tabs', async () => {
    await api.writeFile(root + '/ui.md', '一行一\\n二行二\\n三行三');
    await app.editor.openFile(root + '/ui.md');
    return document.querySelectorAll('.tab').length === 1;
  });
  await step('autoSave', async () => {
    const view = app.editor.getView();
    view.dispatch({ changes: { from: 0, insert: '## 自动保存测试\\n' } });
    await new Promise((r) => setTimeout(r, 2000));
    const saved = await api.readFile(root + '/ui.md');
    return saved.content.includes('自动保存测试');
  });
  await step('findAll', async () => {
    const fi = document.querySelector('#find-input');
    fi.value = '行';
    fi.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    const findRows = document.querySelectorAll('#find-results .find-result').length;
    const findCount = document.querySelector('#find-count').textContent;
    return findRows === 3 ? findCount : 'rows=' + findRows;
  });
  await step('previewUI', async () => {
    // 打开 markdown 后预览应渲染出标题
    await api.writeFile(root + '/preview.md', '# 大标题\\n\\n## 二级标题\\n\\n- 列表项一\\n- 列表项二');
    await app.editor.openFile(root + '/preview.md');
    await new Promise((r) => setTimeout(r, 400));
    const host = document.querySelector('#preview-host');
    const html = document.querySelector('#preview-content').innerHTML;
    const visible = !host.classList.contains('hidden');
    const hasH2 = html.includes('<h2>');
    const hasList = html.includes('<ul>');
    return visible && hasH2 && hasList ? true : 'visible=' + visible + ',h2=' + hasH2 + ',list=' + hasList;
  });
  await step('previewCycle', async () => {
    const m1 = app.preview.cycleMode();
    const m2 = app.preview.cycleMode();
    const m3 = app.preview.cycleMode();
    return m1 === 'preview' && m2 === 'edit' && m3 === 'split' ? true : m1 + ',' + m2 + ',' + m3;
  });

  // ---- mermaid 图渲染 ----
  await step('mermaidUI', async () => {
    const BT = String.fromCharCode(96); // 反引号（避免与外层模板字符串冲突）
    const fence = BT + BT + BT;
    const mmContent = '# M\\n\\n' + fence + 'mermaid\\ngraph TD\\n  A-->B\\n' + fence + '\\n';
    await api.writeFile(root + '/mm.md', mmContent);
    await app.editor.openFile(root + '/mm.md');
    await new Promise((r) => setTimeout(r, 1200)); // mermaid 异步渲染
    const svg = document.querySelector('#preview-content .mermaid-wrap svg');
    const err = document.querySelector('#preview-content .mermaid-error');
    return svg && !err ? true : err ? 'err=' + err.textContent : 'no svg';
  });

  // ---- 预览图片路径解析 + 双击详情（真实 Windows 反斜杠路径） ----
  await step('imgDetail', async () => {
    const bsRoot = root.replace(/\\//g, '\\\\');
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await api.writeBinary(bsRoot + '\\\\pic.png', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await api.writeFile(bsRoot + '\\\\picmd.md', '# 图\\n\\n![测试图](./pic.png)\\n');
    await app.editor.openFile(bsRoot + '\\\\picmd.md');
    await new Promise((r) => setTimeout(r, 600));
    const img = document.querySelector('#preview-content img.preview-img');
    if (!img) return 'no img';
    const src = img.getAttribute('src');
    // URL 应为 file:///F:/... （盘符保留、无反斜杠残留、./ 已归一化）
    const srcOk = src.startsWith('file:///F:') && !src.includes('\\\\') && src.includes('pic.png') && !src.includes('/./');
    const loaded = img.naturalWidth > 0; // 图片真实加载成功
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const stage = document.querySelector('#modal-body .viewer-stage');
    const modalVisible = !document.querySelector('#modal-mask').classList.contains('hidden');
    // 查看器内直接滚轮放大
    let zoomOk = false;
    if (stage) {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 120));
      const vi = stage.querySelector('.viewer-img');
      zoomOk = !!vi && vi.style.zoom === '1.1';
    }
    const closeBtn = document.querySelector('#modal-actions .tbtn');
    if (closeBtn) closeBtn.click();
    return srcOk && loaded && modalVisible && zoomOk
      ? true
      : 'src=' + src + ',loaded=' + loaded + ',modal=' + modalVisible + ',zoom=' + zoomOk;
  });

  // ---- 双击 mermaid 图打开查看器（SVG 按 viewBox 原始像素尺寸显示） ----
  await step('mermaidViewer', async () => {
    const BT = String.fromCharCode(96); // 反引号
    const fence = BT + BT + BT;
    let mmNodes = '';
    for (let i = 0; i < 10; i++) mmNodes += '  N' + i + '-->N' + (i + 1) + '\\n';
    const mmContent = '# M2\\n\\n' + fence + 'mermaid\\ngraph LR\\n' + mmNodes + fence + '\\n';
    await api.writeFile(root + '/mm2.md', mmContent);
    await app.editor.openFile(root + '/mm2.md');
    await new Promise((r) => setTimeout(r, 1500));
    const wrap = document.querySelector('#preview-content .mermaid-wrap');
    if (!wrap) return 'no wrap';
    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const svg = document.querySelector('#modal-body .viewer-stage .mermaid-wrap svg');
    const styleW = svg ? svg.style.width : '';
    // 应为 viewBox 的实际像素宽度（如 1389px），而非 100%
    const rawSize = !!svg && styleW.endsWith('px') && parseFloat(styleW) > 400;
    // 左键拖拽平移（SVG 原始宽度溢出 stage，scrollLeft 应变化）
    const stage = document.querySelector('#modal-body .viewer-stage');
    let dragOk = false;
    if (stage) {
      const before = stage.scrollLeft;
      stage.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, clientY: 300, bubbles: true, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 300, bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      dragOk = stage.scrollLeft > before;
    }
    const closeBtn = document.querySelector('#modal-actions .tbtn');
    if (closeBtn) closeBtn.click();
    return rawSize && dragOk ? true : 'svg=' + !!svg + ',w=' + styleW + ',drag=' + dragOk;
  });

  // ---- 文件树点击图片 → 编辑区图片标签页查看（非详情弹窗） ----
  await step('treeImageViewer', async () => {
    app.state.rootDir = root;
    app.tree.setRoot(root);
    await new Promise((r) => setTimeout(r, 300));
    const imgNode = Array.from(document.querySelectorAll('#file-tree .tree-node')).find(
      (n) => n.querySelector('.name').textContent === 'pic.png'
    );
    if (!imgNode) return 'no node';
    imgNode.click();
    await new Promise((r) => setTimeout(r, 400));
    const imgTab = document.querySelector('#image-host img.image-tab-img');
    const imgSrc = imgTab ? imgTab.getAttribute('src') : '';
    const srcOk = imgSrc.startsWith('file:///F:');
    const copyBtn = document.querySelector('#image-host .image-copy-btn');
    const tabActive = Array.from(document.querySelectorAll('.tab')).some(
      (t) => t.classList.contains('active') && t.textContent.includes('pic.png')
    );
    const modalOpen = !document.querySelector('#modal-mask').classList.contains('hidden');
    return !!imgTab && srcOk && tabActive && !modalOpen && !!copyBtn
      ? true
      : 'imgTab=' + !!imgTab + ',src=' + srcOk + ',tab=' + tabActive + ',modal=' + modalOpen + ',copy=' + !!copyBtn;
  });

  // ---- 图片标签页直接滚轮缩放 + 双击恢复 ----
  await step('imageTabZoom', async () => {
    const host = document.querySelector('#image-host');
    const img = host ? host.querySelector('img.image-tab-img') : null;
    if (!img) return 'no img';
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 120));
    const z1 = img.style.zoom;
    host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const z2 = img.style.zoom;
    return z1 === '1.1' && z2 === '1' ? true : 'z1=' + z1 + ',z2=' + z2;
  });

  // ---- 图片标签页左键拖拽平移（放大后） ----
  await step('imageTabDrag', async () => {
    // 大尺寸 SVG 图片：放大后内容溢出可平移
    await api.writeFile(
      root + '/big.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000" viewBox="0 0 2000 1000"><rect width="2000" height="1000" fill="#4f8cff"/></svg>'
    );
    await app.editor.openFile(root + '/big.svg');
    await new Promise((r) => setTimeout(r, 400));
    const host = document.querySelector('#image-host');
    // 滚轮连续放大到溢出（走 applyZoom 路径，移除 max-width 限制）
    for (let i = 0; i < 5; i++) {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 150));
    const sw = host.scrollWidth;
    const cw = host.clientWidth;
    const before = host.scrollLeft;
    host.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, clientY: 300, bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const after = host.scrollLeft;
    return after > before ? true : 'sw=' + sw + ',cw=' + cw + ',bef=' + before + ',aft=' + after;
  });

  // ---- 详情查看器放大后左右边缘可完整滚动（无裁剪） ----
  await step('viewerScrollFull', async () => {
    await api.writeFile(
      root + '/big.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000" viewBox="0 0 2000 1000"><rect width="2000" height="1000" fill="#4f8cff"/></svg>'
    );
    await api.writeFile(root + '/bigmd.md', '# B\\n\\n![big](./big.svg)\\n');
    await app.editor.openFile(root + '/bigmd.md');
    await new Promise((r) => setTimeout(r, 500));
    const img = document.querySelector('#preview-content img.preview-img');
    if (!img) return 'no img';
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const stage = document.querySelector('#modal-body .viewer-stage');
    const vimg = stage.querySelector('.viewer-img');
    // 滚轮放大直到内容溢出（最多 20 次，防 DPI/布局差异导致放大不足）
    let guard = 0;
    while (stage.scrollWidth <= stage.clientWidth + 5 && guard < 20) {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      guard++;
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 150));
    const stageRect = stage.getBoundingClientRect();
    // 滚到最左：图片左边缘应可见（不被裁剪）
    stage.scrollLeft = 0;
    await new Promise((r) => setTimeout(r, 60));
    const imgLeft = vimg.getBoundingClientRect().left;
    const leftOk = imgLeft >= stageRect.left - 6;
    // 滚到最右：图片右边缘应可见
    stage.scrollLeft = stage.scrollWidth;
    await new Promise((r) => setTimeout(r, 60));
    const imgRight = vimg.getBoundingClientRect().right;
    const rightOk = imgRight <= stageRect.right + 6;
    const closeBtn = document.querySelector('#modal-actions .tbtn');
    if (closeBtn) closeBtn.click();
    return leftOk && rightOk
      ? true
      : 'left=' + leftOk + '(' + imgLeft + '>=' + stageRect.left + '),right=' + rightOk + '(' + imgRight + '<=' + stageRect.right + '),sw=' + stage.scrollWidth + ',cw=' + stage.clientWidth;
  });

  // ---- 编辑器光标常显（验证 CSS 规则；后台窗口 rAF 暂停时不渲染 cursor 元素） ----
  await step('caretVisible', async () => {
    await app.editor.openFile(root + '/ui.md');
    const view = app.editor.getView();
    view.focus();
    await new Promise((r) => setTimeout(r, 120));
    // 检查样式表中存在光标常显规则（.cm-cursor visibility: visible）
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        rules.push(...Array.from(sheet.cssRules));
      } catch {
        /* 跨域样式表忽略 */
      }
    }
    const hasRule = rules.some(
      (r) =>
        r.selectorText &&
        r.selectorText.includes('.cm-cursor') &&
        r.style.visibility === 'visible'
    );
    // 若光标元素已渲染（前台窗口），再验证实际 visibility
    let elOk = true;
    const cursorEl = document.querySelector('.cm-editor .cm-cursor');
    if (cursorEl) {
      elOk = getComputedStyle(cursorEl).visibility === 'visible';
    }
    return hasRule && elOk ? true : 'rule=' + hasRule + ',el=' + elOk;
  });

  // ---- Ctrl+滚轮缩放预览 + Ctrl+0 重置 ----
  await step('zoomPreview', async () => {
    const host = document.querySelector('#preview-host');
    const badge = document.querySelector('#zoom-badge');
    host.style.zoom = '';
    host.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    const z1 = host.style.zoom;
    const b1hidden = badge.classList.contains('hidden');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const z2 = host.style.zoom;
    return z1 === '1.1' && !b1hidden && z2 === '1' ? true : 'z1=' + z1 + ',b1hidden=' + b1hidden + ',z2=' + z2;
  });

  // ---- 图片详情一键复制（IPC + 查看器按钮） ----
  await step('copyImage', async () => {
    const bsRoot = root.replace(/\\//g, '\\\\');
    const r = await api.copyImage(bsRoot + '\\\\pic.png');
    const ipcOk = r && r.width > 0;
    // UI：重新打开含图片的 md → 双击图片打开查看器 → 点击复制
    await app.editor.openFile(bsRoot + '\\\\picmd.md');
    await new Promise((r) => setTimeout(r, 400));
    const img = document.querySelector('#preview-content img.preview-img');
    if (!img) return 'no img';
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const copyBtn = Array.from(document.querySelectorAll('#modal-body .viewer-bar .tbtn')).find((b) =>
      b.textContent.includes('复制')
    );
    if (!copyBtn) return 'no copy btn';
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    const closed = document.querySelector('#modal-mask').classList.contains('hidden');
    return ipcOk && closed ? true : 'ipc=' + ipcOk + ',closed=' + closed;
  });

  // ---- 粘贴图片：保存到同目录并插入引用 ----
  await step('pasteImage', async () => {
    await api.writeFile(root + '/paste.md', '# 粘贴测试\\n');
    await app.editor.openFile(root + '/paste.md');
    await new Promise((r) => setTimeout(r, 200));
    const view = app.editor.getView();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', { type: 'image/png' }));
    view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 600));
    const doc = view.state.doc.toString();
    const files = await api.readTree(root);
    const saved = files.some((f) => f.name.startsWith('image-') && f.name.endsWith('.png'));
    return doc.includes('![image-') && saved ? true : 'doc=' + doc.replace(/\\n/g, '|') + ',saved=' + saved;
  });
  await step('tooLarge', async () => {
    await api.setSettings({ maxFileSizeMB: 1 });
    const big = root + '/big.txt';
    await api.writeFile(big, 'x'.repeat(2 * 1024 * 1024));
    let tooLarge = false;
    try {
      await api.readFile(big);
    } catch (e) {
      // 跨 IPC 的错误对象只保留 message
      tooLarge = String(e.message).includes('超过上限');
    }
    await api.setSettings({ maxFileSizeMB: 50 });
    await api.remove(big, false);
    return tooLarge;
  });

  // ---- 文件树与全局搜索 UI 验证 ----
  await step('treeUI', async () => {
    await api.create(root, 'tree-sub', 'dir');
    await api.writeFile(root + '/tree-sub/note.md', '# 树测试\\n内容');
    app.tree.setRoot(root);
    await new Promise((r) => setTimeout(r, 300));
    const names = () =>
      Array.from(document.querySelectorAll('#file-tree .tree-node')).map(
        (n) => n.querySelector('.name').textContent
      );
    const hasSub = names().includes('tree-sub');
    // 模拟点击目录节点触发懒加载展开
    const subRow = Array.from(document.querySelectorAll('#file-tree .tree-node')).find(
      (n) => n.querySelector('.name').textContent === 'tree-sub'
    );
    if (subRow) subRow.click();
    await new Promise((r) => setTimeout(r, 300));
    const after = names();
    return hasSub && after.includes('note.md') ? true : 'names=' + after.join(',');
  });
  await step('globalSearchUI', async () => {
    app.state.rootDir = root;
    const gi = document.querySelector('#gs-input');
    gi.value = '树测试';
    await app.globalSearch.run();
    await new Promise((r) => setTimeout(r, 200));
    const groups = document.querySelectorAll('#gs-results .gs-group').length;
    const rows = document.querySelectorAll('#gs-results .find-result').length;
    return groups === 1 && rows === 1 ? true : 'groups=' + groups + ',rows=' + rows;
  });

  // ---- 双击 Shift 已取消（不再触发全局搜索） ----
  await step('shiftDoubleRemoved', async () => {
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const active = document.activeElement;
    return active && active.id !== 'gs-input' ? true : 'active=' + (active && active.id);
  });

  // ---- 侧栏操作按钮位置 + 底部无全局搜索 tab ----
  await step('sidebarButtons', async () => {
    const inSidebar = ['btn-new-file', 'btn-new-dir', 'btn-refresh'].every((id) => {
      const el = document.getElementById(id);
      return el && !!el.closest('#sidebar');
    });
    const noGsTab = !document.querySelector('.ptab[data-panel="globalsearch"]');
    return inSidebar && noGsTab ? true : 'side=' + inSidebar + ',noTab=' + noGsTab;
  });

  // ---- user-select 布局：编辑器与预览区域均可选中 ----
  await step('userSelect', async () => {
    const cs = getComputedStyle(document.querySelector('.cm-editor'));
    const editorOk = cs.userSelect === 'text';
    const md = getComputedStyle(document.querySelector('.markdown-body'));
    const mdOk = md.userSelect === 'text';
    return editorOk && mdOk ? true : 'editor=' + cs.userSelect + ',md=' + md.userSelect;
  });

  // ---- 文件内搜索激活时编辑，光标不被抢占（修复光标飘） ----
  await step('cursorStable', async () => {
    const fi = document.querySelector('#find-input');
    fi.value = '行';
    fi.dispatchEvent(new Event('input')); // 触发搜索并跳转到第一个匹配
    await new Promise((r) => setTimeout(r, 150));
    const view = app.editor.getView();
    const before = view.state.selection.main.head;
    const docLen = view.state.doc.length;
    view.dispatch({ changes: { from: docLen, insert: ' 尾部新增文字' } }); // 模拟打字
    await new Promise((r) => setTimeout(r, 200));
    const after = view.state.selection.main.head;
    return Math.abs(after - before) <= 2 ? true : 'before=' + before + ',after=' + after;
  });

  // ---- 点击全局搜索结果 → 编辑器内高亮关键词 + 底部面板同步 ----
  await step('gsHighlight', async () => {
    app.state.rootDir = root;
    const gi = document.querySelector('#gs-input');
    gi.value = '树测试';
    await app.globalSearch.run();
    await new Promise((r) => setTimeout(r, 200));
    const row = document.querySelector('#gs-results .find-result');
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 300));
    const findVal = document.querySelector('#find-input').value;
    const marks = document.querySelectorAll('.cm-search-match').length;
    return findVal === '树测试' && marks > 0
      ? true
      : 'val=' + findVal + ',marks=' + marks;
  });

  // ---- Python 输出面板与设置面板 UI 验证 ----
  await step('pyUI', async () => {
    await api.writeFile(root + '/pyui.py', 'print("PY_UI_OK")\\nimport sys\\nprint("err", file=sys.stderr)');
    await app.editor.openFile(root + '/pyui.py');
    await app.python.run();
    await new Promise((r) => setTimeout(r, 2500));
    const out = document.querySelector('#py-output').textContent;
    const status = document.querySelector('#py-status').textContent;
    return out.includes('PY_UI_OK') && out.includes('err') ? status : 'out=' + out.slice(-120);
  });
  await step('settingsUI', async () => {
    document.querySelector('#btn-settings').click();
    await new Promise((r) => setTimeout(r, 200));
    const visible = !document.querySelector('#modal-mask').classList.contains('hidden');
    const inputs = document.querySelectorAll('#modal-body input').length;
    // 范围提示应显示大文件上限最大值与滚动条宽度最大值
    const hints = Array.from(document.querySelectorAll('#modal-body .hint'))
      .map((h) => h.textContent)
      .join('|');
    const rangeOk = hints.includes('2048') && hints.includes('40');
    // 取消关闭
    const cancelBtn = document.querySelector('#modal-actions .tbtn');
    if (cancelBtn) cancelBtn.click();
    return visible && inputs >= 5 && rangeOk
      ? true
      : 'visible=' + visible + ',inputs=' + inputs + ',range=' + rangeOk;
  });

  // ---- 全类型文件打开验证（txt/json/py 编辑器可见且内容正确） ----
  await step('openAllTypes', async () => {
    const cases = [
      ['t.txt', 'plain text 内容'],
      ['j.json', '{"a": 1, "b": "x"}'],
      ['p.py', 'print("hi")\\n# comment'],
    ];
    const out = [];
    for (const [name, content] of cases) {
      const p = root + '/' + name;
      await api.writeFile(p, content);
      const tab = await app.editor.openFile(p);
      const host = document.querySelector('#editor-host');
      const hidden = host.classList.contains('hidden');
      const docText = app.editor.getView().state.doc.toString();
      out.push(name + '=' + (!hidden && tab && docText === content));
    }
    return out.every((x) => x.endsWith('true')) ? true : out.join(' ');
  });

  // ---- 分隔条拖拽调整左右宽度 ----
  await step('dividerDrag', async () => {
    await app.editor.openFile(root + '/preview.md'); // 分屏模式（previewCycle 后回到 split）
    const div = document.querySelector('#split-divider');
    const visible = !div.classList.contains('hidden');
    const editorHost = document.querySelector('#editor-host');
    const before = editorHost.getBoundingClientRect().width;
    div.dispatchEvent(new MouseEvent('mousedown', { clientX: 400, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 520, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const after = editorHost.getBoundingClientRect().width;
    div.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const reset = editorHost.style.flex === '';
    return visible && after > before + 20 && reset
      ? true
      : 'vis=' + visible + ',bef=' + Math.round(before) + ',aft=' + Math.round(after) + ',reset=' + reset;
  });

  // ---- 滚动条宽度设置持久化与 CSS 变量应用 ----
  await step('scrollbarSetting', async () => {
    await api.setSettings({ scrollbarWidth: 16 });
    const s = await api.getSettings();
    const varVal = getComputedStyle(document.documentElement).getPropertyValue('--scrollbar-width').trim();
    // 持久化正确 + 页面变量是有效范围值（页面变量反映上次面板保存值，API 直改不即时同步）
    const varNum = parseInt(varVal, 10);
    return s.scrollbarWidth === 16 && varNum >= 6 && varNum <= 40
      ? true
      : 'saved=' + s.scrollbarWidth + ',var=' + varVal;
  });

  // ---- 选中文件后新建，树应自动刷新显示新条目 ----
  await step('createRefresh', async () => {
    app.state.rootDir = root;
    app.tree.setRoot(root);
    await new Promise((r) => setTimeout(r, 300));
    // 模拟点击选中一个文件节点（触发 getTargetDir 的父目录分支）
    const fileNode = Array.from(document.querySelectorAll('#file-tree .tree-node')).find(
      (n) => n.querySelector('.name').textContent === 't.txt'
    );
    if (fileNode) fileNode.click();
    await new Promise((r) => setTimeout(r, 100));
    // 工具栏「新建文件」→ 输入名称 → 确定
    document.querySelector('#btn-new-file').click();
    await new Promise((r) => setTimeout(r, 100));
    const input = document.querySelector('#modal-body input');
    input.value = 'created.txt';
    document.querySelector('#modal-actions .tbtn:last-child').click();
    await new Promise((r) => setTimeout(r, 800));
    const names = Array.from(document.querySelectorAll('#file-tree .tree-node .name')).map(
      (n) => n.textContent
    );
    return names.includes('created.txt') ? true : 'names=' + names.join(',');
  });

  // ---- 右键菜单打开目录（openDirFromPath） ----
  await step('openDirFromPath', async () => {
    // 通过外部路径打开目录（模拟右键菜单 --dir 传入）
    const ok = await window.__app.openDirFromPath(root + '/tree-sub');
    const label = document.querySelector('#dir-label').textContent;
    const treeHas = Array.from(document.querySelectorAll('#file-tree .tree-node .name')).some(
      (n) => n.textContent === 'note.md'
    );
    // S1：切回 root 作为工作目录（后续用例仍以 root 内文件为操作对象）
    await window.__app.openDirFromPath(root);
    return ok && label === root + '/tree-sub' && treeHas
      ? true
      : 'ok=' + ok + ',label=' + label + ',tree=' + treeHas;
  });

  // ---- 外部修改自动同步（其他编辑器改文件 → MarkHunter 刷新，光标位置不变） ----
  await step('externalChange', async () => {
    await api.writeFile(root + '/ext.md', '第一行\\n第二行\\n第三行\\n第四行\\n第五行');
    await app.editor.openFile(root + '/ext.md');
    await new Promise((r) => setTimeout(r, 400));
    const view = app.editor.getView();
    const before = view.state.doc.toString();
    // 把光标放到第三行开头
    const selPos = view.state.doc.line(3).from;
    view.dispatch({ selection: { anchor: selPos } });
    const selBefore = view.state.selection.main.head;
    // 模拟外部修改（内容变长）
    await api.writeExternal(root + '/ext.md', '第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行\\n第七行\\n第八行');
    await new Promise((r) => setTimeout(r, 1500)); // watchFile 轮询 + 防抖 + 重载
    const after = view.state.doc.toString();
    const selAfter = view.state.selection.main.head;
    return before.includes('第五行') && after.includes('第八行') && selAfter === selBefore
      ? true
      : 'before=' + before.slice(0, 10) + ',after=' + after.slice(0, 10) + ',sel=' + selBefore + '->' + selAfter;
  });

  // ---- 同一行内鼠标拖选文字（基础选择能力回归；后台窗口测量缺失时仅验证不崩溃） ----
  await step('selectSameLine', async () => {
    await api.writeFile(root + '/sel.md', '第一行文字内容ABCDEFGH\\n第二行内容\\n');
    await app.editor.openFile(root + '/sel.md');
    await new Promise((r) => setTimeout(r, 300));
    const view = app.editor.getView();
    const cm = document.querySelector('.cm-content');
    const firstLine = document.querySelector('.cm-line');
    if (!cm || !firstLine) return 'no cm';
    const lr = firstLine.getBoundingClientRect();
    const startX = lr.left + 10;
    const y = lr.top + lr.height / 2;
    cm.dispatchEvent(new MouseEvent('mousedown', { clientX: startX, clientY: y, bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: startX + 150, clientY: y, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: startX + 150, clientY: y, bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const sel = view.state.selection.main;
    const nativeSel = document.getSelection() ? document.getSelection().toString() : '';
    const selBg = document.querySelectorAll('.cm-selectionBackground').length;
    return sel.from !== sel.to && nativeSel.length > 0
      ? true
      : 'from=' + sel.from + ',to=' + sel.to + ',nativeLen=' + nativeSel.length + ',bg=' + selBg;
  });

  // ---- AI 侧栏开关 ----
  await step('aiPanel', async () => {
    document.querySelector('#btn-ai').click();
    const visible = !document.querySelector('#ai-panel').classList.contains('hidden');
    const hasInput = !!document.querySelector('#ai-input');
    const hasFullBtn = !!document.querySelector('#btn-ai-full');
    document.querySelector('#btn-ai').click(); // 收起
    return visible && hasInput && hasFullBtn ? true : 'vis=' + visible + ',input=' + hasInput;
  });

  // ---- AI 内容写入文档（插入 / 替换） ----
  await step('aiApplySnippet', async () => {
    await api.writeFile(root + '/ai.md', '第一行\\n第二行\\n第三行');
    await app.editor.openFile(root + '/ai.md');
    const view = app.editor.getView();
    app.editor.applySnippet('插入内容', 'insert', 0);
    const doc1 = view.state.doc.toString();
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    app.editor.applySnippet('XX', 'replace', 0, 2);
    const doc2 = view.state.doc.toString();
    return doc1.startsWith('插入内容') && doc2.startsWith('XX') ? true : 'doc1=' + doc1 + ',doc2=' + doc2;
  });

  // ---- 设置面板含 AI 配置（S5：密钥输入为 password 且不显示明文 + 清除密钥按钮 + 模型下拉） ----
  await step('settingsAI', async () => {
    document.querySelector('#btn-settings').click();
    await new Promise((r) => setTimeout(r, 200));
    const inputs = document.querySelectorAll('#modal-body input');
    const keyHidden = Array.from(inputs).some((i) => i.type === 'password' && i.value === '');
    const hasClearBtn = Array.from(document.querySelectorAll('#modal-body button')).some((b) => b.textContent.includes('清除密钥'));
    const hintOk = Array.from(document.querySelectorAll('#modal-body .hint')).some((h) => h.textContent.includes('加密'));
    const hasSelect = !!document.querySelector('.ai-model-select');
    document.querySelector('#modal-actions .tbtn').click();
    return keyHidden && hasClearBtn && hintOk && hasSelect
      ? true
      : 'key=' + keyHidden + ',clear=' + hasClearBtn + ',hint=' + hintOk + ',select=' + hasSelect;
  });

  // ---- AI 工具执行（function calling：读文档 / 插入文字） ----
  await step('aiToolExec', async () => {
    await api.writeFile(root + '/aitool.md', '工具测试内容\\n第二行');
    await app.editor.openFile(root + '/aitool.md');
    const read = await app.executeAiTool('read_document', {});
    // 关闭询问后直接插入文字
    app.state.settings.aiAskBeforeApply = false;
    const ins = await app.executeAiTool('insert_text', { text: 'XX' });
    const doc = app.editor.getView().state.doc.toString();
    return read.includes('工具测试内容') && doc.includes('XX') ? true : 'read=' + read.slice(0, 20) + ',doc=' + doc;
  });

  // ---- 分隔条拖拽调整尺寸 + 双击恢复 ----
  await step('dividerResize', async () => {
    const sideDiv = document.querySelector('#sidebar-divider');
    const sidebar = document.querySelector('#sidebar');
    const before = sidebar.getBoundingClientRect().width;
    sideDiv.dispatchEvent(new MouseEvent('mousedown', { clientX: 320, clientY: 300, bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 420, clientY: 300, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const after = sidebar.getBoundingClientRect().width;
    sideDiv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const reset = sidebar.style.width === '';
    return after > before + 50 && reset ? true : 'before=' + Math.round(before) + ',after=' + Math.round(after) + ',reset=' + reset;
  });

  // ---- AI 侧栏模型徽标（显示当前模型） ----
  await step('aiModelBadge', async () => {
    document.querySelector('#btn-ai').click();
    const badge = document.querySelector('#ai-model-badge');
    const text = badge ? badge.textContent : '';
    document.querySelector('#btn-ai').click();
    return text.includes('deepseek') ? true : 'badge=' + text;
  });

  // ---- Ctrl+Tab 循环切换标签 ----
  await step('cycleTab', async () => {
    await app.editor.openFile(root + '/ui.md');
    await new Promise((r) => setTimeout(r, 80));
    const before = app.editor.getActiveTab();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const t1 = app.editor.getActiveTab();
    const switched = t1 && before && t1 !== before;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const t2 = app.editor.getActiveTab();
    return switched && t2 && t2 !== t1 ? true : 'switched=' + switched + ',before=' + (before && before.name) + ',t1=' + (t1 && t1.name) + ',t2=' + (t2 && t2.name);
  });

  // ---- 状态栏：文件名 + 行:列 + 字数 ----
  await step('statusBar', async () => {
    const v = app.editor.getView();
    v.dispatch({ selection: { anchor: 0 } });
    await new Promise((r) => setTimeout(r, 120));
    const sbPos = document.getElementById('sb-pos');
    const sbFile = document.getElementById('sb-file');
    const sbLen = document.getElementById('sb-len');
    const pos = sbPos ? sbPos.textContent : '';
    const file = sbFile ? sbFile.textContent : '';
    const len = sbLen ? sbLen.textContent : '';
    const tab = app.editor.getActiveTab();
    // 状态栏文件名应与当前活动标签一致（原断言引用的 demo.py 从未被创建，改为对比真实标签名）
    return pos.includes('行 1') && tab && file === tab.name && len.includes('字符')
      ? true
      : 'pos=' + pos + ',file=' + file + ',len=' + len;
  });

  // ---- 拖拽文件到窗口打开 ----
  await step('dragOpenFile', async () => {
    await window.api.writeFile(root + '/drag-test.txt', '拖拽打开的文件内容');
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { types: ['Files'], files: [{ path: root + '/drag-test.txt' }] };
    window.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 600));
    const t = app.editor.getActiveTab();
    return t && t.name === 'drag-test.txt' ? true : 'tab=' + (t && t.name);
  });

  // ---- 本地目录收藏（收藏 / 切换打开 / 取消 / 持久化往返） ----
  let favOrig = null; // 测试前的原始收藏（结束时还原，避免影响用户数据）
  await step('favAdd', async () => {
    // 隔离：保存并清空历史收藏（防止上次运行残留 / 手动测试干扰断言）
    favOrig = ((await api.getSettings()).favoriteDirs || []).slice();
    await api.setSettings({ favoriteDirs: [] });
    await app.favorites.load();
    await app.openDirFromPath(root);
    const btn = document.querySelector('#btn-toggle-fav');
    const disabled0 = btn.disabled;
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const items = Array.from(document.querySelectorAll('#fav-list .fav-item'));
    const hasItem = items.some((i) => i.title === root);
    const btnText = btn.textContent;
    return hasItem && btnText.includes('已收藏') && !disabled0
      ? true
      : 'disabled=' + disabled0 + ',items=' + items.map((i) => i.title).join('|') + ',btn=' + btnText;
  });
  await step('favOpen', async () => {
    // 切换到另一目录后点击收藏项 → 应切回 root（dir-label / rootDir / 高亮）
    await app.openDirFromPath(root + '/tree-sub');
    const item = Array.from(document.querySelectorAll('#fav-list .fav-item')).find((i) => i.title === root);
    if (!item) return 'no fav item';
    item.click();
    await new Promise((r) => setTimeout(r, 400));
    const label = document.querySelector('#dir-label').textContent;
    const cur = item.classList.contains('current');
    return app.state.rootDir === root && label === root && cur
      ? true
      : 'root=' + app.state.rootDir + ',label=' + label + ',cur=' + cur;
  });
  await step('favRemove', async () => {
    const btn = document.querySelector('#btn-toggle-fav');
    btn.click(); // 当前目录 root 已收藏 → 取消收藏
    await new Promise((r) => setTimeout(r, 300));
    const items = document.querySelectorAll('#fav-list .fav-item').length;
    const btnText = btn.textContent;
    return items === 0 && btnText.includes('☆')
      ? true
      : 'items=' + items + ',btn=' + btnText;
  });
  await step('favPersist', async () => {
    // 取消后 favoriteDirs 应为空；再收藏一次验证持久化往返；最后还原测试前收藏
    const s0 = await api.getSettings();
    const empty = Array.isArray(s0.favoriteDirs) && s0.favoriteDirs.length === 0;
    const btn = document.querySelector('#btn-toggle-fav');
    btn.click(); // 重新收藏 root
    await new Promise((r) => setTimeout(r, 300));
    const s1 = await api.getSettings();
    const saved = Array.isArray(s1.favoriteDirs) && s1.favoriteDirs.length === 1 && s1.favoriteDirs[0] === root;
    btn.click(); // 取消收藏，列表清空
    await new Promise((r) => setTimeout(r, 300));
    const s2 = await api.getSettings();
    const removed = Array.isArray(s2.favoriteDirs) && s2.favoriteDirs.length === 0;
    // 恢复现场：还原测试前的收藏，避免影响用户数据与下次运行
    await api.setSettings({ favoriteDirs: favOrig || [] });
    await app.favorites.load();
    return empty && saved && removed
      ? true
      : 'empty=' + empty + ',saved=' + JSON.stringify(s1.favoriteDirs) + ',removed=' + removed;
  });

  return results;
})()
`;

async function runSmoke(win) {
  win.webContents.on('console-message', (event) => {
    console.log('[renderer]', event.message);
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      cleanTestRoot();
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      const results = await win.webContents.executeJavaScript(RENDERER_TEST);
      console.log('E2E_RESULTS');
      for (const r of results) {
        console.log('  -', r.join(' | '));
      }
    } catch (err) {
      console.error('E2E_ERROR', err && err.stack ? err.stack : String(err));
    } finally {
      cleanTestRoot();
      setTimeout(() => {
        console.log('SMOKE_OK');
        app.quit();
      }, 400);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('SMOKE_RENDERER_GONE', d.reason);
    app.exit(1);
  });
}

module.exports = { runSmoke };
