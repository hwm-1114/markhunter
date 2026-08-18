// 端到端冒烟测试：在真实窗口中通过 window.api 验证核心链路
// 由主进程在 --smoke 模式下加载
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, clipboard } = require('electron');

const TEST_ROOT = path.join(__dirname, '..', '.smoke-test');

// 需求1：外部目录（与 TEST_ROOT 无前缀包含关系）。
// 注意：不能用 os.tmpdir() 直接拼 —— 本机 os.tmpdir() 返回 8.3 短名
// （如 C:\Users\ADMINI~1\...），而 readTree/readdir 返回长名（Administrator），
// 会导致外部链按短名逐级展开时 findNode 失配、树定位中断。
// 用 os.homedir()（长名）+ AppData/Local/Temp 得到同目录的长拼写。
const EXT_ROOT = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'mh-smoke-ext-' + Date.now());

function cleanTestRoot() {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
  if (EXT_ROOT && fs.existsSync(EXT_ROOT)) {
    fs.rmSync(EXT_ROOT, { recursive: true, force: true });
  }
}

const RENDERER_TEST = `
(async () => {
  const api = window.api;
  const root = ${JSON.stringify(TEST_ROOT.replace(/\\\\/g, '/'))};
  const extRoot = ${JSON.stringify(EXT_ROOT.replace(/\\\\/g, '/'))};
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
  // 会话隔离：清空 boot 可能恢复的历史会话标签（.smoke-test 之外的路径也可能被恢复），
  // 保证后续 .tab 数量等断言不受用户历史会话干扰
  await step('sessionClean', async () => {
    app.editor.closeAll();
    return true;
  });
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

  // ---- 会话保持：切换工作目录不丢标签（回归保障） ----
  await step('tabPersist', async () => {
    await app.editor.closeAll(); // 隔离：保证活动标签断言确定
    const p = root + '/persist.md';
    await api.writeFile(p, '# 会话保持\\n内容');
    await app.editor.openFile(p);
    await api.create(root, 'persist-sub', 'dir');
    // 切换到另一个子目录：已打开标签不应消失
    await app.openDirFromPath(root + '/persist-sub');
    const act = app.editor.getActiveTab();
    const ok1 = !!act && act.path === p;
    // 再切回 root：标签仍在
    await app.openDirFromPath(root);
    const ok2 = !!app.editor.findTabByPath(p);
    return ok1 && ok2 ? true : 'ok1=' + ok1 + ',ok2=' + ok2 + ',act=' + (act && act.path);
  });

  // ---- 会话保持：持久化到设置 + 清空后恢复（路径与活动标签正确） ----
  await step('sessionRestore', async () => {
    await app.editor.closeAll(); // 隔离：保证会话内容确定
    const p1 = root + '/sess1.md';
    const p2 = root + '/sess2.md';
    await api.writeFile(p1, '# 会话一\\n内容');
    await api.writeFile(p2, '# 会话二\\n内容');
    await app.editor.openFile(p1);
    await app.editor.openFile(p2);
    await window.__app.session.save(); // 强制落盘（跳过 600ms 防抖）
    app.state.settings = await api.getSettings(); // 同步渲染进程设置视图（save 只更新主进程缓存）
    const s = await api.getSettings();
    const ls = s.lastSession || {};
    const pathsOk = Array.isArray(ls.paths) && ls.paths.length === 2 && ls.paths[0] === p1 && ls.paths[1] === p2;
    const activeOk = ls.active === 1; // 当前活动标签为 sess2
    await app.editor.closeAll();
    const closedOk = app.editor.getActiveTab() === null;
    await window.__app.session.restore();
    const t1 = app.editor.findTabByPath(p1);
    const t2 = app.editor.findTabByPath(p2);
    const act = app.editor.getActiveTab();
    return pathsOk && activeOk && closedOk && !!t1 && !!t2 && !!act && act.path === p2
      ? true
      : 'paths=' + JSON.stringify(ls) + ',closed=' + closedOk + ',t1=' + !!t1 + ',t2=' + !!t2 + ',act=' + (act && act.path);
  });

  // ---- 树自动定位：打开深层文件时左侧树展开各级目录并选中该文件 ----
  await step('revealTree', async () => {
    await app.openDirFromPath(root);
    // 逐级创建深层目录结构（S1：父目录须在工作目录内，create 会校验）
    await api.create(root, 'reveal-a', 'dir');
    await api.create(root + '/reveal-a', 'reveal-b', 'dir');
    const p = await api.create(root + '/reveal-a/reveal-b', 'c.md', 'file');
    await api.writeFile(p, '# 深层文件\\n内容');
    await app.tree.setRoot(root); // api.create 不经 UI，手动刷新树让新节点可见
    await app.editor.openFile(p);
    await window.__app.tree.reveal(p); // 等待 reveal 完成
    const rows = Array.from(document.querySelectorAll('#file-tree .tree-node'));
    const node = rows.find((n) => n.dataset.path === p);
    if (!node) return 'no node';
    const selected = node.classList.contains('selected');
    // 中间各级目录应为展开态（caret.open）
    const dirsOk = ['reveal-a', 'reveal-b'].every((d) => {
      const r = rows.find((n) => n.querySelector('.name').textContent === d);
      return !!r && r.querySelector('.caret').classList.contains('open');
    });
    return selected && dirsOk ? true : 'selected=' + selected + ',dirs=' + dirsOk;
  });

  // ---- 需求2：侧栏分隔条位于侧栏与工作区之间（不再被 flex 排到窗口右缘） ----
  await step('dividerPos', async () => {
    const div = document.querySelector('#sidebar-divider');
    const sidebar = document.querySelector('#sidebar');
    const wb = document.querySelector('#workbench');
    if (!div || !sidebar || !wb) return 'no els';
    const dr = div.getBoundingClientRect();
    const sr = sidebar.getBoundingClientRect();
    const wr = wb.getBoundingClientRect();
    const between = dr.left >= sr.right - 10 && dr.right <= wr.left + 10;
    const notRightEdge = dr.right < window.innerWidth - 30;
    return between && notRightEdge
      ? true
      : 'div=' + Math.round(dr.left) + '-' + Math.round(dr.right) + ',side=' + Math.round(sr.left) + '-' + Math.round(sr.right) + ',wb=' + Math.round(wr.left) + ',win=' + window.innerWidth;
  });

  // ---- 需求2：拖拽分隔条（+80px）调整侧栏宽度，随后拖回恢复 ----
  await step('dividerDrag', async () => {
    const div = document.querySelector('#sidebar-divider');
    const sidebar = document.querySelector('#sidebar');
    const dr = div.getBoundingClientRect();
    const cx = dr.left + dr.width / 2;
    const cy = dr.top + dr.height / 2;
    const before = sidebar.offsetWidth;
    div.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 80, clientY: cy, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: cx + 80, clientY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const after = sidebar.offsetWidth;
    const grew = after - before;
    // 拖回原位恢复现场
    div.dispatchEvent(new MouseEvent('mousedown', { clientX: cx + 80, clientY: cy, bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const restored = sidebar.offsetWidth;
    return grew >= 70 && grew <= 90 && after >= 200 && after <= 520 && Math.abs(restored - before) <= 6
      ? true
      : 'grew=' + grew + ',after=' + after + ',restored=' + restored;
  });

  // ---- 需求2：双击分隔条恢复默认宽度（style.width 清空） ----
  await step('dividerDblclick', async () => {
    const div = document.querySelector('#sidebar-divider');
    const sidebar = document.querySelector('#sidebar');
    const dr = div.getBoundingClientRect();
    const cx = dr.left + dr.width / 2;
    const cy = dr.top + dr.height / 2;
    div.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 80, clientY: cy, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: cx + 80, clientY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const wide = sidebar.offsetWidth;
    div.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const reset = sidebar.style.width === '';
    return wide > 320 && reset ? true : 'wide=' + wide + ',reset=' + reset + ',style=' + sidebar.style.width;
  });

  // ---- 需求3：编辑器右键菜单显示（含「粘贴为纯文本」项） ----
  await step('menuShow', async () => {
    app.preview.setMode('edit');
    await api.writeFile(root + '/ctx.md', '# 右键菜单测试\\n内容');
    await app.editor.openFile(root + '/ctx.md');
    await new Promise((r) => setTimeout(r, 150));
    const cm = document.querySelector('.cm-content');
    if (!cm) return 'no cm';
    cm.dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    const menu = document.querySelector('#ctx-menu');
    const visible = !menu.classList.contains('hidden');
    const items = Array.from(menu.querySelectorAll('.ctx-item')).map((el) => el.textContent);
    const hasItem = items.some((t) => t.includes('粘贴为纯文本'));
    return visible && hasItem ? true : 'vis=' + visible + ',items=' + items.join('|');
  });

  // ---- 需求3：菜单点击其它区域 / Esc 自动隐藏 ----
  await step('menuHide', async () => {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const h1 = document.querySelector('#ctx-menu').classList.contains('hidden');
    // 重新打开 → Esc 隐藏
    const cm = document.querySelector('.cm-content');
    cm.dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const h2 = document.querySelector('#ctx-menu').classList.contains('hidden');
    return h1 && h2 ? true : 'h1=' + h1 + ',h2=' + h2;
  });

  // ---- 需求3：树节点右键菜单无回归（打开/重命名/删除项仍存在） ----
  await step('ctxTreeRegress', async () => {
    app.state.rootDir = root;
    app.tree.setRoot(root);
    await new Promise((r) => setTimeout(r, 300));
    const fileNode = Array.from(document.querySelectorAll('#file-tree .tree-node')).find(
      (n) => n.querySelector('.name').textContent === 'ctx.md'
    );
    if (!fileNode) return 'no node';
    fileNode.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    const items = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((el) => el.textContent);
    const vis = !document.querySelector('#ctx-menu').classList.contains('hidden');
    const hasOpen = items.some((t) => t.includes('打开'));
    const hasRename = items.some((t) => t.includes('重命名'));
    const hasDelete = items.some((t) => t.includes('删除文件'));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); // 关闭菜单，避免干扰后续用例
    return vis && hasOpen && hasRename && hasDelete ? true : 'vis=' + vis + ',items=' + items.join('|');
  });

  // ---- 需求5：Tab 键缩进（默认 4 空格） ----
  // 注意：必须派发在 view.contentDOM（.cm-content）上——CM6 的 keydown 监听器挂在 contentDOM，
  // 且 eventBelongsToEditor 要求事件 target 位于 contentDOM 内部（沿父链上溯须到达 contentDOM）。
  // 派发在 view.dom（.cm-editor 外层，contentDOM 的祖先）上事件不会下行到 contentDOM，keymap 不会执行。
  const pressTab = (view, shift) =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true })
    );

  await step('tabIndentDefault', async () => {
    await api.writeFile(root + '/indent.md', 'hello\\nworld');
    await app.editor.openFile(root + '/indent.md');
    await new Promise((r) => setTimeout(r, 120));
    const view = app.editor.getView();
    view.dispatch({ selection: { anchor: 0 } }); // 光标置行首
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view, false);
    await new Promise((r) => setTimeout(r, 60));
    const doc = view.state.doc.toString();
    return doc.startsWith('    ') ? true : 'doc=' + JSON.stringify(doc.slice(0, 10));
  });

  await step('tabIndentMidLine', async () => {
    const view = app.editor.getView();
    const before = view.state.doc.toString().split('\\n')[0];
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } }); // 第一行行尾（行中）
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view, false);
    await new Promise((r) => setTimeout(r, 60));
    const line1 = view.state.doc.toString().split('\\n')[0];
    const cur = view.state.selection.main.head;
    return line1 === before + '    ' && cur === line1.length
      ? true
      : 'line1=' + JSON.stringify(line1) + ',cur=' + cur;
  });

  await step('shiftTabDedent', async () => {
    const view = app.editor.getView();
    // 构造 4 空格前导，光标置于空格之后
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '    abc\\nnext' }, selection: { anchor: 4 } });
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view, true);
    await new Promise((r) => setTimeout(r, 60));
    const doc = view.state.doc.toString();
    const dedented = doc.startsWith('abc\\n');
    // 无空格可删（行首）时不动作
    view.dispatch({ selection: { anchor: 0 } });
    const before2 = view.state.doc.toString();
    pressTab(view, true);
    await new Promise((r) => setTimeout(r, 40));
    const after2 = view.state.doc.toString();
    return dedented && before2 === after2
      ? true
      : 'doc=' + JSON.stringify(doc.slice(0, 10)) + ',noop=' + (before2 === after2);
  });

  await step('tabMultiLine', async () => {
    const view = app.editor.getView();
    // selection 是「新文档」坐标：head 用新内容长度（11 字符），不能取旧 doc.length（12）否则越界
    const newDoc = 'aa\\nbb\\ncc';
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newDoc },
      selection: { anchor: 0, head: newDoc.length },
    });
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view, false);
    await new Promise((r) => setTimeout(r, 60));
    const lines = view.state.doc.toString().split('\\n');
    const ok = lines[0].startsWith('    aa') && lines[1].startsWith('    bb') && lines[2].startsWith('    cc');
    return ok ? true : 'lines=' + JSON.stringify(lines);
  });

  await step('indentSizeApply', async () => {
    // 改设置为 2：主进程设置 + 渲染进程状态 + 编辑器立即生效
    await api.setSettings({ indentSize: 2 });
    app.state.settings = await api.getSettings();
    app.editor.setIndentSize(2);
    // 新开标签：Tab 插 2 空格
    await api.writeFile(root + '/indent2.md', 'x\\ny');
    await app.editor.openFile(root + '/indent2.md');
    await new Promise((r) => setTimeout(r, 120));
    const view = app.editor.getView();
    view.dispatch({ selection: { anchor: 0 } });
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view, false);
    await new Promise((r) => setTimeout(r, 60));
    const docNew = view.state.doc.toString();
    const newOk = docNew.startsWith('  x');
    // 已开标签（indent.md）切换回来立即生效：Tab 也插 2 空格
    await app.editor.openFile(root + '/indent.md');
    await new Promise((r) => setTimeout(r, 120));
    const view2 = app.editor.getView();
    const beforeOld = view2.state.doc.toString();
    view2.dispatch({ selection: { anchor: 0 } });
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view2, false);
    await new Promise((r) => setTimeout(r, 60));
    const afterOld = view2.state.doc.toString();
    const oldOk = afterOld === '  ' + beforeOld;
    // 收尾恢复 indentSize 4（settings 与编辑器状态都恢复）
    await api.setSettings({ indentSize: 4 });
    app.state.settings = await api.getSettings();
    app.editor.setIndentSize(4);
    return newOk && oldOk
      ? true
      : 'new=' + newOk + ',old=' + oldOk + ',newDoc=' + JSON.stringify(docNew.slice(0, 8)) + ',oldAfter=' + JSON.stringify(afterOld.slice(0, 8));
  });

  await step('cycleTabRegress', async () => {
    // Ctrl+Tab 切换标签不受 Tab 缩进 keymap 影响
    await app.editor.openFile(root + '/indent.md');
    await app.editor.openFile(root + '/indent2.md');
    await new Promise((r) => setTimeout(r, 80));
    const before = app.editor.getActiveTab();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const t1 = app.editor.getActiveTab();
    return !!before && !!t1 && t1 !== before
      ? true
      : 'before=' + (before && before.name) + ',t1=' + (t1 && t1.name);
  });

  await step('indentSizeWhitelist', async () => {
    // 越界值 99：编辑器 clamp 到 8（Tab 插 8 空格），随后恢复
    await api.setSettings({ indentSize: 99 });
    app.state.settings = await api.getSettings();
    app.editor.setIndentSize(99);
    const view = app.editor.getView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'zz' }, selection: { anchor: 0 } });
    await new Promise((r) => setTimeout(r, 40));
    pressTab(view, false);
    await new Promise((r) => setTimeout(r, 60));
    const doc = view.state.doc.toString();
    const clamped8 = doc.startsWith('        zz');
    await api.setSettings({ indentSize: 4 });
    app.state.settings = await api.getSettings();
    app.editor.setIndentSize(4);
    return clamped8 ? true : 'doc=' + JSON.stringify(doc.slice(0, 12));
  });

  // ================= 需求4：标签 Pin（固定）与批量关闭 =================
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    const limit = ms || 6000;
    while (Date.now() - t0 < limit) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  };
  // 路径归一化比较（readTree 返回反斜杠真实路径，extRoot 注入为正斜杠）
  // 注意：此处位于模板字符串内，正则须用 \\\\ 才能在注入代码中得到 /\\/g（匹配单个反斜杠）
  const normP = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
  const pinA = root + '/pin-a.md';
  const pinB = root + '/pin-b.md';
  const pinC = root + '/pin-c.md';
  const pinD = root + '/pin-d.md';
  const pin1 = root + '/pin-s1.md';
  const pin2 = root + '/pin-s2.md';
  const lastSessionOrig = (await api.getSettings()).lastSession; // 收尾恢复现场

  await step('pinToggle', async () => {
    await app.editor.closeAll();
    await api.writeFile(pinA, 'a');
    await api.writeFile(pinB, 'b');
    await api.writeFile(pinC, 'c');
    await app.editor.openFile(pinA);
    await app.editor.openFile(pinB);
    await app.editor.openFile(pinC);
    app.editor.setPinned(app.editor.findTabByPath(pinB), true);
    await new Promise((r) => setTimeout(r, 80));
    const pinnedCount = document.querySelectorAll('.tab.pinned').length;
    const bEl = Array.from(document.querySelectorAll('.tab')).find((t) => t.querySelector('.tab-name').textContent === 'pin-b.md');
    return pinnedCount === 1 && !!bEl && !!bEl.querySelector('.tab-pin')
      ? true
      : 'pinned=' + pinnedCount + ',pin=' + (bEl ? !!bEl.querySelector('.tab-pin') : 'no-el');
  });

  await step('pinMenuUI', async () => {
    const bEl = Array.from(document.querySelectorAll('.tab')).find((t) => t.querySelector('.tab-name').textContent === 'pin-b.md');
    if (!bEl) return 'no pin-b tab';
    bEl.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const items1 = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((el) => el.textContent);
    const vis1 = !document.querySelector('#ctx-menu').classList.contains('hidden');
    const hasUnpin = items1.some((t) => t.indexOf('取消固定') >= 0);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const aEl = Array.from(document.querySelectorAll('.tab')).find((t) => t.querySelector('.tab-name').textContent === 'pin-a.md');
    if (!aEl) return 'no pin-a tab';
    aEl.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const items2 = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((el) => el.textContent);
    const hasPin = items2.some((t) => t.indexOf('固定标签') >= 0);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return vis1 && hasUnpin && hasPin
      ? true
      : 'vis=' + vis1 + ',unpin=' + hasUnpin + ',pin=' + hasPin + ',i1=' + items1.join('|') + ',i2=' + items2.join('|');
  });

  await step('pinCloseOthers', async () => {
    await app.editor.closeAll();
    await app.editor.openFile(pinA);
    await app.editor.openFile(pinB);
    await app.editor.openFile(pinC);
    app.editor.setPinned(app.editor.findTabByPath(pinB), true);
    await new Promise((r) => setTimeout(r, 60));
    app.editor.closeOthers(app.editor.findTabByPath(pinC));
    await new Promise((r) => setTimeout(r, 100));
    const names = Array.from(document.querySelectorAll('.tab .tab-name')).map((n) => n.textContent);
    const act = app.editor.getActiveTab();
    // 需求4：closeOthers(锚) 关闭「其它」标签 —— 锚定标签 C 与 pinned 的 B 均保留，活动切到锚 C
    return names.indexOf('pin-b.md') >= 0 && names.indexOf('pin-a.md') < 0 && names.indexOf('pin-c.md') >= 0 && !!act && act.path === pinC
      ? true
      : 'names=' + names.join(',') + ',act=' + (act && act.path);
  });

  await step('pinCloseLeft', async () => {
    await app.editor.closeAll();
    await app.editor.openFile(pinA);
    await app.editor.openFile(pinB);
    await app.editor.openFile(pinC);
    const tb = app.editor.findTabByPath(pinB);
    app.editor.setPinned(tb, true);
    await new Promise((r) => setTimeout(r, 60));
    app.editor.closeLeft(app.editor.findTabByPath(pinC));
    await new Promise((r) => setTimeout(r, 100));
    const names1 = Array.from(document.querySelectorAll('.tab .tab-name')).map((n) => n.textContent);
    const ok1 = names1.indexOf('pin-b.md') >= 0 && names1.indexOf('pin-a.md') < 0;
    app.editor.setPinned(tb, false);
    await new Promise((r) => setTimeout(r, 60));
    app.editor.closeLeft(app.editor.findTabByPath(pinC));
    await new Promise((r) => setTimeout(r, 100));
    const names2 = Array.from(document.querySelectorAll('.tab .tab-name')).map((n) => n.textContent);
    const ok2 = names2.indexOf('pin-b.md') < 0;
    return ok1 && ok2
      ? true
      : 'ok1=' + ok1 + '(' + names1.join(',') + '),ok2=' + ok2 + '(' + names2.join(',') + ')';
  });

  await step('pinCloseRight', async () => {
    await app.editor.closeAll();
    await api.writeFile(pinD, 'd');
    await app.editor.openFile(pinA);
    await app.editor.openFile(pinB);
    await app.editor.openFile(pinC);
    await app.editor.openFile(pinD);
    app.editor.setPinned(app.editor.findTabByPath(pinB), true);
    await new Promise((r) => setTimeout(r, 60));
    app.editor.closeRight(app.editor.findTabByPath(pinB));
    await new Promise((r) => setTimeout(r, 100));
    const names = Array.from(document.querySelectorAll('.tab .tab-name')).map((n) => n.textContent);
    const act = app.editor.getActiveTab();
    return names.indexOf('pin-a.md') >= 0 && names.indexOf('pin-b.md') >= 0 && names.indexOf('pin-c.md') < 0 && names.indexOf('pin-d.md') < 0 && !!act && act.path === pinB
      ? true
      : 'names=' + names.join(',') + ',act=' + (act && act.path);
  });

  await step('pinCtrlW', async () => {
    await app.editor.closeAll();
    await app.editor.openFile(pinA);
    app.editor.setPinned(app.editor.findTabByPath(pinA), true);
    await new Promise((r) => setTimeout(r, 60));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return !app.editor.findTabByPath(pinA) ? true : 'still open';
  });

  await step('pinDeletePath', async () => {
    await app.editor.closeAll();
    await app.editor.openFile(pinA);
    app.editor.setPinned(app.editor.findTabByPath(pinA), true);
    await new Promise((r) => setTimeout(r, 60));
    app.editor.closeByPath(pinA, false);
    await new Promise((r) => setTimeout(r, 100));
    return !app.editor.findTabByPath(pinA) ? true : 'still open';
  });

  await step('pinSessionPersist', async () => {
    await app.editor.closeAll();
    await api.writeFile(pin1, '1');
    await api.writeFile(pin2, '2');
    await app.editor.openFile(pin1);
    await app.editor.openFile(pin2);
    app.editor.setPinned(app.editor.findTabByPath(pin2), true);
    await new Promise((r) => setTimeout(r, 80));
    await window.__app.session.save();
    app.state.settings = await api.getSettings();
    const ls = (await api.getSettings()).lastSession;
    const pinnedOk = !!ls && Array.isArray(ls.pinned) && ls.pinned.length === 1 && ls.pinned[0] === 1;
    await app.editor.closeAll();
    await window.__app.session.restore();
    await new Promise((r) => setTimeout(r, 300));
    const pinnedCount = document.querySelectorAll('.tab.pinned').length;
    const act = app.editor.getActiveTab();
    return pinnedOk && pinnedCount === 1 && !!act && act.path === pin2
      ? true
      : 'saved=' + JSON.stringify(ls) + ',count=' + pinnedCount + ',act=' + (act && act.path);
  });

  await step('pinSessionBackCompat', async () => {
    // 旧数据无 pinned 字段 → 视为 []：restore 不崩溃、无 pin
    await app.editor.closeAll();
    await api.setSettings({ lastSession: { paths: [pin1, pin2], active: 0 } });
    app.state.settings = await api.getSettings();
    await window.__app.session.restore();
    await new Promise((r) => setTimeout(r, 300));
    const pinnedCount = document.querySelectorAll('.tab.pinned').length;
    const tabCount = document.querySelectorAll('.tab').length;
    const act = app.editor.getActiveTab();
    return pinnedCount === 0 && tabCount === 2 && !!act && act.path === pin1
      ? true
      : 'pinned=' + pinnedCount + ',tabs=' + tabCount + ',act=' + (act && act.path);
  });

  // ================= 需求1：跨目录树定位（外部文件虚拟分支） =================
  await step('extReveal', async () => {
    await app.editor.closeAll();
    await app.openDirFromPath(root);
    const extFile = extRoot + '/note.md';
    await app.editor.openFile(extFile);
    const nodeFound = await waitFor(() =>
      !!Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => normP(n.dataset.path) === normP(extFile))
    );
    const rows = Array.from(document.querySelectorAll('#file-tree .tree-node'));
    const extRow = rows.find((n) => n.querySelector('.name').textContent === '外部文件');
    const node = rows.find((n) => normP(n.dataset.path) === normP(extFile));
    const selected = !!node && node.classList.contains('selected');
    const dirName = extRoot.split(/[\\\\/]/).pop();
    const dirRow = rows.find((n) => n.querySelector('.name').textContent === dirName);
    const dirOpen = !!dirRow && dirRow.querySelector('.caret').classList.contains('open');
    return nodeFound && !!extRow && !!node && selected && dirOpen
      ? true
      : 'found=' + nodeFound + ',ext=' + !!extRow + ',sel=' + selected + ',dirOpen=' + dirOpen;
  });

  await step('extRootUnchanged', async () => {
    const rootDirBefore = app.state.rootDir;
    const labelBefore = document.querySelector('#dir-label').textContent;
    const favBefore = document.querySelector('#btn-toggle-fav').textContent;
    await app.editor.openFile(extRoot + '/note.md');
    await new Promise((r) => setTimeout(r, 300));
    return app.state.rootDir === rootDirBefore && document.querySelector('#dir-label').textContent === labelBefore && document.querySelector('#btn-toggle-fav').textContent === favBefore
      ? true
      : 'root=' + app.state.rootDir + ',label=' + document.querySelector('#dir-label').textContent + ',fav=' + document.querySelector('#btn-toggle-fav').textContent;
  });

  await step('extPrune', async () => {
    const t = app.editor.findTabByPath(extRoot + '/note.md');
    if (t) app.editor.closeTab(t);
    const gone = await waitFor(() =>
      !Array.from(document.querySelectorAll('#file-tree .tree-node')).some((n) => n.querySelector('.name').textContent === '外部文件')
    );
    return gone ? true : 'ext area still visible';
  });

  await step('extWriteRun', async () => {
    const extPy = extRoot + '/run.py';
    await app.editor.openFile(extPy); // readFile 成功 → approvedSet（保存/运行仍可用）
    await api.writeFile(extPy, 'print("EXT_RUN_OK")\\n');
    const rb = await api.readFile(extPy);
    const writeOk = rb.content.indexOf('EXT_RUN_OK') >= 0;
    const pys = await api.detectPython();
    let runOk = false;
    if (pys.length > 0) {
      const pyExe = pys.find((p) => /\.exe$/i.test(p)) || pys[0];
      const r = await new Promise((resolve) => {
        let out = '';
        let done = false;
        const onOut = (d) => { out += d.data; };
        const onExit = (d) => {
          if (done) return;
          done = true;
          resolve({ ok: out.indexOf('EXT_RUN_OK') >= 0, code: d.code });
        };
        api.onPythonOutput(onOut);
        api.onPythonExit(onExit);
        api.runPython(extPy, pyExe);
        setTimeout(() => { if (!done) { done = true; resolve({ ok: false, code: null, timeout: true }); } }, 15000);
      });
      runOk = r.ok;
    }
    return writeOk && runOk ? true : 'write=' + writeOk + ',run=' + runOk;
  });

  await step('extCreateRejected', async () => {
    // 外部目录从未被 approve → 新建被拒（S1 保持）
    let rejected = false;
    try {
      await api.create(extRoot, 'x.md', 'file');
    } catch (e) {
      rejected = String(e.message).indexOf('不在当前工作目录内') >= 0;
    }
    return rejected;
  });

  await step('extSwitchRoot', async () => {
    await app.editor.openFile(extRoot + '/note.md');
    await new Promise((r) => setTimeout(r, 300));
    await app.openDirFromPath(extRoot); // 外部变内部
    await new Promise((r) => setTimeout(r, 600));
    const label = document.querySelector('#dir-label').textContent;
    const tabOk = !!app.editor.findTabByPath(extRoot + '/note.md');
    const node = Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => normP(n.dataset.path) === normP(extRoot + '/note.md'));
    const selected = !!node && node.classList.contains('selected');
    const extGone = !Array.from(document.querySelectorAll('#file-tree .tree-node')).some((n) => n.querySelector('.name').textContent === '外部文件');
    await app.openDirFromPath(root); // 切回：外部区恢复
    await new Promise((r) => setTimeout(r, 600));
    const tabStill = !!app.editor.findTabByPath(extRoot + '/note.md');
    const extBack = Array.from(document.querySelectorAll('#file-tree .tree-node')).some((n) => n.querySelector('.name').textContent === '外部文件');
    return label === extRoot && tabOk && selected && extGone && tabStill && extBack
      ? true
      : 'label=' + label + ',tab=' + tabOk + ',sel=' + selected + ',gone=' + extGone + ',still=' + tabStill + ',back=' + extBack;
  });

  await step('extSessionRestore', async () => {
    await app.editor.closeAll();
    await app.openDirFromPath(root);
    await app.editor.openFile(extRoot + '/note.md');
    await new Promise((r) => setTimeout(r, 300));
    await window.__app.session.save();
    app.state.settings = await api.getSettings();
    await app.editor.closeAll();
    await window.__app.session.restore();
    const extShown = await waitFor(() =>
      Array.from(document.querySelectorAll('#file-tree .tree-node')).some((n) => n.querySelector('.name').textContent === '外部文件')
    );
    const tabOk = !!app.editor.findTabByPath(extRoot + '/note.md');
    return extShown && tabOk ? true : 'ext=' + extShown + ',tab=' + tabOk;
  });

  await step('extCtxMenu', async () => {
    await app.editor.openFile(extRoot + '/note.md');
    await new Promise((r) => setTimeout(r, 400));
    const fileNode = Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => normP(n.dataset.path) === normP(extRoot + '/note.md'));
    if (!fileNode) return 'no file node';
    fileNode.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const items1 = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((el) => el.textContent);
    const fOk = items1.some((t) => t.indexOf('打开') >= 0) && items1.some((t) => t.indexOf('重命名') >= 0) && items1.some((t) => t.indexOf('删除') >= 0) && !items1.some((t) => t.indexOf('新建') >= 0);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const dirName = extRoot.split(/[\\\\/]/).pop();
    const dirNode = Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => n.querySelector('.name').textContent === dirName);
    if (!dirNode) return 'no dir node';
    dirNode.dispatchEvent(new MouseEvent('contextmenu', { clientX: 120, clientY: 120, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const items2 = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((el) => el.textContent);
    const dOk = items2.some((t) => t.indexOf('切换工作目录') >= 0) && items2.some((t) => t.indexOf('刷新') >= 0) && !items2.some((t) => t.indexOf('新建') >= 0);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await api.setSettings({ lastSession: lastSessionOrig }); // 收尾恢复现场
    app.state.settings = await api.getSettings();
    return fOk && dOk ? true : 'f=' + items1.join('|') + ',d=' + items2.join('|');
  });

  // ================= 多主题皮肤（阶段2：主题下拉 / 持久化 / 白名单 / 防闪白 / 明暗适配） =================
  // 本地助手：落盘 + 同步渲染层 state.settings（openSettings 读它）+ 应用。
  // 缺 state.settings 同步会导致后续用例的下拉初值与 data-theme 失真（api.setSettings 不更新渲染层状态）
  const setTheme = async (name) => {
    await api.setSettings({ theme: name });
    app.state.settings = await api.getSettings();
    app.applyTheme(name);
  };

  // themeDefault：默认主题 = markhunter-classic（重置后 getSettings 往返 + applyTheme 应用一致）
  await step('themeDefault', async () => {
    await setTheme('markhunter-classic');
    const s = await api.getSettings();
    const attr = document.documentElement.getAttribute('data-theme');
    return s.theme === 'markhunter-classic' && attr === 'markhunter-classic'
      ? true
      : 'saved=' + s.theme + ',attr=' + attr;
  });

  // themeCatalog：主题全集 36 个合法名（含 markhunter-classic、无重复）+ 暗色 14 个
  await step('themeCatalog', async () => {
    const names = app.THEME_NAMES || [];
    const dark = app.DARK_THEMES || [];
    const uniq = new Set(names).size === names.length;
    return names.length === 36 && names.includes('markhunter-classic') && dark.length === 14 && uniq
      ? true
      : 'names=' + names.length + ',dark=' + dark.length + ',uniq=' + uniq;
  });

  // themeApplyDirect：applyTheme('night') → data-theme 变化 + 页面背景实际变色（暗色生效）
  await step('themeApplyDirect', async () => {
    const bgBefore = getComputedStyle(document.body).backgroundColor;
    app.applyTheme('night');
    const attr = document.documentElement.getAttribute('data-theme');
    const bgAfter = getComputedStyle(document.body).backgroundColor;
    const changed = bgAfter !== bgBefore;
    app.applyTheme('markhunter-classic');
    return attr === 'night' && changed
      ? true
      : 'attr=' + attr + ',bg=' + bgBefore + '->' + bgAfter;
  });

  // themePersist：setSettings 后 getSettings 往返保持
  await step('themePersist', async () => {
    await setTheme('dracula');
    const s = await api.getSettings();
    await setTheme('markhunter-classic');
    return s.theme === 'dracula' ? true : 'saved=' + s.theme;
  });

  // themeWhitelist：非法主题名被静默丢弃（保持原值，不回退崩坏）
  await step('themeWhitelist', async () => {
    await setTheme('markhunter-classic');
    await api.setSettings({ theme: '不存在的主题名' });
    const s = await api.getSettings();
    return s.theme === 'markhunter-classic' ? true : 'saved=' + s.theme;
  });

  // themeRoundTrip：白名单 + 持久化往返（仿 scrollbarSetting 模式；非法值 12345 被丢弃）
  await step('themeRoundTrip', async () => {
    await setTheme('nord');
    const s1 = await api.getSettings();
    await api.setSettings({ theme: 12345 });
    const s2 = await api.getSettings();
    await setTheme('markhunter-classic');
    return s1.theme === 'nord' && s2.theme === 'nord' ? true : 's1=' + s1.theme + ',s2=' + s2.theme;
  });

  // themeApplyViaUI：设置面板主题下拉改值 → data-theme 即时变化；取消后还原
  await step('themeApplyViaUI', async () => {
    document.querySelector('#btn-settings').click();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.querySelector('#theme-select');
    if (!sel) {
      document.querySelector('#modal-actions .tbtn').click();
      return 'no theme-select';
    }
    sel.value = 'synthwave';
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 50));
    const changed = document.documentElement.getAttribute('data-theme') === 'synthwave';
    document.querySelector('#modal-actions .tbtn').click(); // 取消
    await new Promise((r) => setTimeout(r, 50));
    const restored = document.documentElement.getAttribute('data-theme') === 'markhunter-classic';
    return changed && restored ? true : 'changed=' + changed + ',restored=' + restored;
  });

  // themeRestore：打开设置时下拉值 = 当前主题；改值预览后取消 → 还原打开时的主题
  await step('themeRestore', async () => {
    await setTheme('corporate');
    document.querySelector('#btn-settings').click();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.querySelector('#theme-select');
    const openedVal = sel ? sel.value : '';
    sel.value = 'black';
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 50));
    const changed = document.documentElement.getAttribute('data-theme') === 'black';
    document.querySelector('#modal-actions .tbtn').click(); // 取消
    await new Promise((r) => setTimeout(r, 50));
    const restored = document.documentElement.getAttribute('data-theme') === 'corporate';
    await setTheme('markhunter-classic');
    return changed && restored && openedVal === 'corporate'
      ? true
      : 'changed=' + changed + ',restored=' + restored + ',opened=' + openedVal;
  });

  // previewListStyle：预览 ul/ol 有 list-style（Preflight 视觉盲区防回归：disc/decimal）
  await step('previewListStyle', async () => {
    await api.writeFile(root + '/liststyle.md', '- 甲\\n- 乙\\n\\n1. 一\\n2. 二');
    await app.editor.openFile(root + '/liststyle.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 400));
    const uls = document.querySelectorAll('.markdown-body ul');
    const ols = document.querySelectorAll('.markdown-body ol');
    const ulOk = uls.length > 0 && getComputedStyle(uls[0]).listStyleType === 'disc';
    const olOk = ols.length > 0 && getComputedStyle(ols[0]).listStyleType === 'decimal';
    return ulOk && olOk
      ? true
      : 'ul=' + (uls[0] ? getComputedStyle(uls[0]).listStyleType : 'none') + ',ol=' + (ols[0] ? getComputedStyle(ols[0]).listStyleType : 'none');
  });

  return results;
})()
`;

// 需求3：右键菜单「粘贴为纯文本」—— 剪贴板由主进程控制（smoke 在 main 进程直接读写 clipboard）
// phase: 'text'（剪贴板含文本 → 断言插入） / 'empty'（剪贴板为空 → 断言 toast 且文档不变）
function menuClipboardSnippet(phase) {
  const pasteLabel = phase === 'text' ? 'menuPaste' : 'menuPasteEmpty';
  const assertBody =
    phase === 'text'
      ? `const doc = view.state.doc.toString();
         const cur = view.state.selection.main.head;
         const ok = visible && !!item && doc.startsWith('纯文本测试 123') && cur === '纯文本测试 123'.length;
         return ok ? true : 'vis=' + visible + ',item=' + !!item + ',doc=' + JSON.stringify(doc.slice(0, 24)) + ',cur=' + cur;`
      : `const doc = view.state.doc.toString();
         const toastEl = Array.from(document.querySelectorAll('.toast')).pop();
         const toastText = toastEl ? toastEl.textContent : '';
         const ok = visible && !!item && toastText.includes('剪贴板为空') && doc === '第一行内容\\n第二行内容';
         return ok ? true : 'vis=' + visible + ',item=' + !!item + ',toast=' + toastText + ',doc=' + JSON.stringify(doc);`;
  return `(async () => {
  const api = window.api;
  const app = window.__app;
  const root = ${JSON.stringify(TEST_ROOT.replace(/\\\\/g, '/'))};
  const results = [];
  const step = async (name, fn) => {
    try {
      const r = await fn();
      results.push([name, r === true ? true : r]);
    } catch (err) {
      results.push([name, 'ERR: ' + (err && err.stack ? err.stack.split('\\n').slice(0, 4).join(' // ') : err)]);
    }
  };
  await step('${pasteLabel}', async () => {
    app.preview.setMode('edit');
    const f = root + '/menu-clip.md';
    await api.writeFile(f, '第一行内容\\n第二行内容');
    await app.editor.openFile(f);
    await new Promise((r) => setTimeout(r, 150));
    const view = app.editor.getView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '第一行内容\\n第二行内容' }, selection: { anchor: 0 } });
    await new Promise((r) => setTimeout(r, 50));
    const cm = document.querySelector('.cm-content');
    cm.dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    const menu = document.querySelector('#ctx-menu');
    const visible = !menu.classList.contains('hidden');
    const item = Array.from(menu.querySelectorAll('.ctx-item')).find((el) => el.textContent.includes('粘贴为纯文本'));
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 200));
    ${assertBody}
  });
  return results;
})()`;
}

async function runSmoke(win) {
  win.webContents.on('console-message', (event) => {
    console.log('[renderer]', event.message);
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      cleanTestRoot();
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      // 需求1：预建外部目录（与 TEST_ROOT 无前缀包含关系）及文件，供外部区用例使用
      fs.mkdirSync(EXT_ROOT, { recursive: true });
      fs.writeFileSync(path.join(EXT_ROOT, 'note.md'), '# 外部笔记\n内容', 'utf8');
      fs.writeFileSync(path.join(EXT_ROOT, 'run.py'), 'print("EXT_RUN_OK")', 'utf8');
      const results = await win.webContents.executeJavaScript(RENDERER_TEST);
      // 需求3：剪贴板读写由主进程控制（渲染进程仅经 window.api.readClipboardText 读取）
      clipboard.writeText('纯文本测试 123');
      const r1 = await win.webContents.executeJavaScript(menuClipboardSnippet('text'));
      clipboard.writeText(''); // 清空剪贴板
      const r2 = await win.webContents.executeJavaScript(menuClipboardSnippet('empty'));
      results.push(...r1, ...r2);
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
