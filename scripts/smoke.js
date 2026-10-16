// 端到端冒烟测试：在真实窗口中通过 window.api 验证核心链路
// 由主进程在 --smoke 模式下加载
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { app, clipboard } = require('electron');

const TEST_ROOT = path.join(__dirname, '..', '.smoke-test');

// 需求1：外部目录（与 TEST_ROOT 无前缀包含关系）。
// 注意：不能用 os.tmpdir() 直接拼 —— 本机 os.tmpdir() 返回 8.3 短名
// （如 C:\Users\ADMINI~1\...），而 readTree/readdir 返回长名（Administrator），
// 会导致外部链按短名逐级展开时 findNode 失配、树定位中断。
// v0.6.0：挂在 homedir 直下而非 AppData\Local\Temp —— 外部链 reveal 需要 readTree
// 盘符→目标 的每一级目录，而开发机的 Temp 常积累数千条目（fs:read-tree 逐条 statSync），
// 一次 readTree(Temp) 可达数秒，extCtxMenu 等用例的等待窗口内链展开不完（2026-10-13
// 实测连续 6 轮假红、产品代码回退到基线仍红，确诊环境敏感）；homedir 一级浅、条目少，
// 链路长拼写与 8.3 问题同样不受影响。
const EXT_ROOT = path.join(os.homedir(), 'mh-smoke-ext-' + Date.now());

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

  // 5. 全局搜索（v0.6.0 起文件名/目录名也参与匹配：hello.md 内容 2 处 + 文件名 1 处 = 3）
  const gs = await api.globalSearch(root, 'hello');
  results.push(['globalSearch', gs.length === 3 && gs.some((r) => r.kind === 'name' && String(r.file).endsWith('hello.md'))]);

  // 6. 设置读写
  const s0 = await api.getSettings();
  results.push(['getSettings', !!s0 && typeof s0.maxFileSizeMB === 'number']);
  // v0.3.0：AI 功能已整体移除 —— 设置里不应再出现任何 ai* 字段（含历史遗留的加密 API Key）
  results.push(['noAiSettings', !!s0 && Object.keys(s0).every((k) => !/^ai[A-Z]/.test(k))]);

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

  // 8. 删除（v0.1.49 起主进程 setup 会在 build/ 预置大文件材料 → 断言"目标项已删除"而非"目录为空"）
  await api.remove(f1, false);
  await api.remove(root + '/sub', true);
  await api.remove(root + '/hello.py', false);
  tree = await api.readTree(root);
  const names = tree.map((e) => e.name);
  results.push(['remove', !names.includes('hello.py') && !names.includes('sub') && !names.some((n) => n === f1.split('/').pop())]);

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
    // v0.2.3 多目录：清掉 TEST_ROOT 之外的侧栏目录残留（冒烟共用真实 userData），
    // 但必须保留 TEST_ROOT 为唯一根 —— 全部关闭会把主进程根集合清空，
    // 后续所有写操作（S1 路径校验）都会被拒，造成全链路连锁失败
    const nk = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
    for (let i = 0; i < 15 && app.state.sidebarRoots.some((r) => nk(r) !== nk(root)); i++) {
      const target = app.state.sidebarRoots.find((r) => nk(r) !== nk(root));
      await app.closeSidebarRoot(target);
    }
    if (app.state.sidebarRoots.length === 0) {
      await app.openDirFromPath(root);
    }
    return app.state.sidebarRoots.length === 1 ? true : 'roots=' + app.state.sidebarRoots.length;
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
    // P5：首次渲染需动态加载 mermaid chunk（file:// 本地 + 解析），放宽等待；后续用例已命中缓存
    await new Promise((r) => setTimeout(r, 3000));
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

  // ---- v0.2.4 预览图片右键菜单：复制原图（不压缩）/ 在文件夹中显示 / 打开查看器 ----
  await step('previewImgCtx', async () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const bsRoot = root.replace(/\\//g, '\\\\');
    await api.writeBinary(bsRoot + '\\\\ctxpic.png', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await api.writeFile(bsRoot + '\\\\ctxmd.md', '# 右键复制\\n\\n![ctx](./ctxpic.png)\\n');
    await app.editor.openFile(bsRoot + '\\\\ctxmd.md');
    await new Promise((r) => setTimeout(r, 600));
    const img = document.querySelector('#preview-content img.preview-img');
    if (!img) return 'no img';
    img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 120));
    const els = Array.from(document.querySelectorAll('#ctx-menu .ctx-item'));
    const labels = els.map((el) => el.textContent);
    const hasCopy = labels.some((t) => t.includes('复制图片'));
    const hasFolder = labels.some((t) => t.includes('在文件夹中显示'));
    const hasViewer = labels.some((t) => t.includes('打开图片查看器'));
    const copyItem = els.find((el) => el.textContent.includes('复制图片'));
    if (copyItem) copyItem.click();
    await new Promise((r) => setTimeout(r, 500));
    // 剪贴板内容由主进程侧断言（clipboard 模块不进渲染进程）：此处仅验证菜单项与点击链路
    return hasCopy && hasFolder && hasViewer
      ? true
      : 'items=' + labels.join('|');
  });

  await step('showInFolderIpc', async () => {
    // 不存在的路径：shell.showItemInFolder 静默无操作（冒烟中不弹资源管理器窗口），仅验证 IPC 通道
    const r = await api.showInFolder(root + '/__no_such__.png');
    return r === true ? true : 'r=' + r;
  });

  // ---- v0.2.4 查看器操作条位于图片下方（类名冲突修复）+ 1:1 原始尺寸 + Esc 关闭 ----
  await step('viewerBarBelow', async () => {
    const img = document.querySelector('#preview-content img.preview-img');
    if (!img) return 'no img';
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const open = !document.querySelector('#modal-mask').classList.contains('hidden');
    const stage = document.querySelector('#modal-body .viewer-stage');
    const bar = document.querySelector('#modal-body .viewer-bar');
    if (!stage || !bar) return 'open=' + open + ',stage=' + !!stage + ',bar=' + !!bar;
    // DOM 顺序：stage 在 bar 之前（操作条在图片下方）；且不再被绝对定位钉到顶部
    const below = !!(bar.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_PRECEDING);
    const pos = getComputedStyle(bar).position;
    const btns = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent);
    const idx11 = btns.indexOf('1:1');
    let naturalOk = false;
    if (idx11 >= 0) {
      bar.querySelectorAll('button')[idx11].click();
      await new Promise((r) => setTimeout(r, 120));
      const vi = stage.querySelector('.viewer-img');
      naturalOk = !!vi && vi.style.maxWidth === 'none';
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const closed = document.querySelector('#modal-mask').classList.contains('hidden');
    return open && below && pos !== 'absolute' && idx11 >= 0 && naturalOk && closed
      ? true
      : 'open=' + open + ',below=' + below + ',pos=' + pos + ',1:1=' + idx11 + ',nat=' + naturalOk + ',closed=' + closed;
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
    // P6（v0.1.45）：结果改为「按文件分组表头（.gs-file）+ 匹配行」扁平结构，断言跟随新 DOM 契约
    const groups = document.querySelectorAll('#gs-results .gs-file').length;
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

  // ================= v0.6.0 新增功能冒烟 =================
  // 注意本段在 RENDERER_TEST 模板字符串内：写 LaTeX/换行时反斜杠翻倍（\\\\( 展开后为 \\(，
  // 渲染端字符串求值才是 \(；\\n 同理），且不得出现裸反引号（坑①）。

  // ---- 功能1：批处理脚本运行（cmd.exe /d /s /c，输出与退出码与 Python 同一面板/事件） ----
  await step('runBat', async () => {
    const bat = root + '/run-bat.bat';
    await api.writeFile(bat, '@echo off\\r\\necho BAT_E2E_OK');
    const r = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const onOut = (d) => { out += d.data; };
      const onExit = (d) => {
        if (done) return;
        done = true;
        resolve({ ok: out.includes('BAT_E2E_OK'), code: d.code, out });
      };
      api.onPythonOutput(onOut);
      api.onPythonExit(onExit);
      api.runPython(bat);
      setTimeout(() => { if (!done) { done = true; resolve({ ok: false, code: null, out, timeout: true }); } }, 15000);
    });
    // UI 面：打开 .bat 标签 → ▶ 运行按钮应可用（.py/.bat/.cmd 同口径）
    const batTab = await app.editor.openFile(bat);
    const btnEnabled = !document.getElementById('btn-run-py').disabled;
    if (batTab) app.editor.closeTab(batTab); // 对象引用关闭（路径形态差异会让 findTabByPath 失配）
    await api.remove(bat, false);
    return r.ok && r.code === 0 && btnEnabled
      ? true
      : 'ok=' + r.ok + ',code=' + r.code + ',btn=' + btnEnabled + ',out=' + r.out.slice(-80);
  });

  // ---- 功能3：重命名改变扩展名 → 语言模式/预览按新扩展名生效（.txt→.md） ----
  await step('renameExtSwitch', async () => {
    const old = root + '/ext-sw.txt';
    const now = root + '/ext-sw.md';
    await api.writeFile(old, '# 扩展名切换\\n\\n行内公式 $E=mc^2$ 测试\\n\\n$$a^2 + b^2 = c^2$$');
    const tab = await app.editor.openFile(old);
    const langBefore = tab.lang;
    // 真实入口：树右键「重命名」的同一个函数（内部走 showPrompt 弹窗，手动填写并确认；
    // renameEntry 本身不返回 Promise —— 交互由弹窗回调驱动，这里按节奏等待）
    app.tree.renameEntry(old, 'ext-sw.txt');
    await new Promise((r) => setTimeout(r, 150));
    const input = document.querySelector('#modal-body input');
    if (!input) return 'no prompt';
    input.value = 'ext-sw.md';
    const btns = Array.from(document.querySelectorAll('#modal-actions .tbtn'));
    btns[btns.length - 1].click();
    await new Promise((r) => setTimeout(r, 600)); // api.rename + onClosePath（语言热切换/预览刷新）+ 树刷新
    const langAfter = tab.lang;
    // 主进程 rename 返回反斜杠路径（path.join），用例里的 now 是正斜杠 —— 归一化后比较
    const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
    const nameOk = tab.name === 'ext-sw.md' && norm(tab.path) === norm(now);
    // 预览按新扩展名启用：分屏模式下 #preview-host 可见且含 KaTeX 输出
    app.preview.setMode('split');
    app.preview.applyMode();
    await new Promise((r) => setTimeout(r, 150));
    const previewVisible = !document.querySelector('#preview-host').classList.contains('hidden');
    const katexCount = document.querySelectorAll('#preview-content .katex').length;
    app.editor.closeTab(tab); // 直接用对象引用（tab.path 为主进程反斜杠形态，findTabByPath 传正斜杠会失配残留）
    await api.remove(now, false);
    return langBefore === 'text' && langAfter === 'markdown' && nameOk && previewVisible && katexCount >= 2
      ? true
      : 'lang=' + langBefore + '->' + langAfter + ',name=' + nameOk + ',pv=' + previewVisible + ',katex=' + katexCount;
  });

  // ---- 功能2：文件树与系统剪贴板互通（Ctrl+C 复制目录 → CF_HDROP 往返 → 粘贴/冲突/树级入口） ----
  await step('treeClipboard', async () => {
    await api.create(root, 'clip-src', 'dir');
    await api.writeFile(root + '/clip-src/a.txt', 'CLIP_DATA');
    await api.create(root, 'clip-sub', 'dir');
    // 夹具是动态创建的：先刷新树（nodeMap 里要有 clip-src 行，复制入口按 nodeMap 校验）
    await app.tree.refreshNode(root, true);
    await new Promise((r) => setTimeout(r, 250));
    const src = root + '/clip-src';
    // 1) Ctrl+C 键盘路径：容器聚焦 + 合成 keydown → copyEntryToClipboard → CF_HDROP 写入
    const treeEl = document.getElementById('file-tree');
    app.tree.select(src);
    treeEl.focus();
    treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    const rd = await api.clipboardReadFiles();
    const normP2 = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
    const copied = rd && rd.ok === true && rd.count === 1 &&
      normP2(rd.files[0] || '') === normP2(src);
    // 2) ask 冲突 → conflict:true（一个都不先粘）；dedupe → clip-src (2)
    const p1 = await api.pasteFiles(root, { conflict: 'ask' });
    const conflictOk = p1 && p1.conflict === true;
    const p2 = await api.pasteFiles(root, { conflict: 'dedupe' });
    const pastedOk = p2 && p2.ok === true && Array.isArray(p2.pasted) && p2.pasted.length === 1;
    let dataOk = false;
    try { dataOk = (await api.readFile(root + '/clip-src (2)/a.txt')).content === 'CLIP_DATA'; } catch { dataOk = false; }
    // 3) 树级粘贴入口（pasteEntryFromClipboard：粘贴进 clip-sub + 刷新 + 选中）
    await app.tree.pasteEntryFromClipboard(root + '/clip-sub');
    await new Promise((r) => setTimeout(r, 600));
    let subOk = false;
    try { subOk = (await api.readFile(root + '/clip-sub/clip-src/a.txt')).content === 'CLIP_DATA'; } catch { subOk = false; }
    await api.remove(src, true);
    await api.remove(root + '/clip-src (2)', true);
    await api.remove(root + '/clip-sub', true);
    // v0.7.0 权限口径：**未批准但存在**的路径也可复制（用户决策：树内可见即可操作，
    // 外部文件分支/目录链不再被「路径不在已打开目录内」拒绝）—— 用系统里必然存在的
    // 未批准文件（hosts）验证（api.writeFile 未批准路径仍会被拒，不能用它造探针）
    let unappOk = false;
    try {
      const r3 = await window.api.clipboardCopyFiles(['C:/Windows/System32/drivers/etc/hosts']);
      const rd3 = await api.clipboardReadFiles();
      unappOk = !!(r3 && r3.ok === true) && rd3.count === 1;
    } catch { unappOk = false; }
    // 收尾恢复剪贴板为 1×1 图片：previewImgCtx（本用例之前跑过）写入的图片剪贴板被本用例的
    // CF_HDROP 写入替换（writeBuffer 是整剪贴板替换语义，与 Explorer 一致）—— 主进程段稍后的
    // previewImgClip 断言依赖那份图片，这里用同一字节恢复，保持既有用例的隐式前提成立。
    // （必须放最后：上面的探针也会替换剪贴板）
    try {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const png = root.replace(/\\//g, '\\\\') + '\\\\clip-restore.png';
      await api.writeBinary(png, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await window.api.copyImage(png);
      await api.remove(png, false);
    } catch { /* 恢复失败不判红（剪贴板终态不属于本用例的断言面） */ }
    return copied && conflictOk && pastedOk && dataOk && subOk && unappOk
      ? true
      : 'copied=' + copied + ',conflict=' + conflictOk + ',pasted=' + pastedOk + ',data=' + dataOk + ',sub=' + subOk + ',unapp=' + unappOk;
  });

  // ---- 功能4：数学公式渲染（KaTeX：块级/行内/定界符变体/货币误判防御/代码块不解析） ----
  await step('mathRender', async () => {
    const f = root + '/math-katex.md';
    // 源码里的 \\\\(.…经模板展开与渲染端求值后是 \(；\\\\sum → \sum；\\\\[ → \[
    // 行内代码反引号不能用字面量（坑①：会截断 RENDERER_TEST 模板），以 96 号字符动态构造
    const BT = String.fromCharCode(96);
    await api.writeFile(f,
      '# 数学\\n\\n行内 $a+b$ 与 \\\\(c+d\\\\) 混排\\n\\n' +
      '$$\\\\sum_{i=1}^{n} i = \\\\frac{n(n+1)}{2}$$\\n\\n' +
      '\\\\[E = mc^2\\\\]\\n\\n' +
      '价格 $5 和 $10 的文本\\n\\n' +
      '代码 ' + BT + '$not_math$' + BT + ' 不解析\\n');
    const mathTab = await app.editor.openFile(f);
    app.preview.setMode('split');
    app.preview.applyMode();
    await new Promise((r) => setTimeout(r, 200));
    const all = document.querySelectorAll('#preview-content .katex').length;
    const disp = document.querySelectorAll('#preview-content .katex-display').length;
    const txt = (document.querySelector('#preview-content') || { textContent: '' }).textContent || '';
    const moneyOk = txt.includes('$5 和 $10'); // 货币写法不得被当公式（原样文本）
    const codeOk = txt.includes('$not_math$'); // 行内代码里的 $ 不解析
    if (mathTab) app.editor.closeTab(mathTab); // 对象引用关闭（路径形态差异会让 findTabByPath 失配）
    await api.remove(f, false);
    return all === 4 && disp === 2 && moneyOk && codeOk
      ? true
      : 'katex=' + all + ',display=' + disp + ',money=' + moneyOk + ',code=' + codeOk;
  });

  // ---- 功能5：全局搜索的文件名/目录名匹配 + 点击结果在文件树定位 ----
  await step('gsNameDir', async () => {
    await api.create(root, 'zzd-probe', 'dir');
    await api.writeFile(root + '/zzd-probe/zzn-target.md', '正文不含关键词');
    // 夹具动态创建：先刷新树（reveal 沿已加载的目录行逐级展开，目录行必须在 nodeMap 里）
    await app.tree.refreshNode(root, true);
    await new Promise((r) => setTimeout(r, 250));
    app.state.rootDir = root;
    const byName = await api.globalSearch(root, 'zzn-target');
    const nameHit = byName.some((r) => r.kind === 'name' && String(r.file).endsWith('zzn-target.md'));
    const byDir = await api.globalSearch(root, 'zzd-probe');
    const dirHit = byDir.some((r) => r.kind === 'dir' && String(r.file).endsWith('zzd-probe'));
    // UI：搜索 → 点击名字行（.gs-name-row）→ 树展开并选中该文件
    const gi = document.querySelector('#gs-input');
    gi.value = 'zzn-target';
    await app.globalSearch.run();
    await new Promise((r) => setTimeout(r, 300));
    const row = document.querySelector('#gs-results .gs-name-row');
    let revealed = false;
    if (row) {
      row.click();
      await new Promise((r) => setTimeout(r, 700)); // reveal 逐级懒加载展开
      const sel = document.querySelector('#file-tree .tree-node.selected .name');
      revealed = !!sel && sel.textContent === 'zzn-target.md';
    }
    gi.value = '';
    await api.remove(root + '/zzd-probe', true);
    return nameHit && dirHit && revealed
      ? true
      : 'name=' + nameHit + ',dir=' + dirHit + ',reveal=' + revealed;
  });

  // ---- v0.6.1：预览中的图片与流程图默认按原始尺寸显示（不压缩、无需双击放大） ----
  await step('mediaNaturalSize', async () => {
    // 2000×900 的 SVG 图（声明宽高 = naturalSize；矢量无损）
    await api.writeFile(root + '/nat-big.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="900" viewBox="0 0 2000 900"><rect width="2000" height="900" fill="#4f8cff"/></svg>');
    const BT = String.fromCharCode(96);
    const fence = BT + BT + BT;
    let nodes = '';
    for (let i = 0; i < 10; i++) nodes += '  N' + i + ' --> N' + (i + 1) + '\\n';
    await api.writeFile(root + '/nat.md',
      '# 原始尺寸\\n\\n![big](./nat-big.svg)\\n\\n' + fence + 'mermaid\\ngraph LR\\n' + nodes + fence + '\\n');
    const tabNat = await app.editor.openFile(root + '/nat.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 2500)); // mermaid chunk 动态加载 + 异步渲染
    const img = document.querySelector('#preview-content img.preview-img');
    if (!img) return 'no img';
    const imgW = img.getBoundingClientRect().width;
    const natW = img.naturalWidth || 2000;
    const imgOk = Math.abs(imgW - natW) <= 2; // 图片按原始像素 1:1 渲染（未被 max-width 压缩）
    const svg = document.querySelector('#preview-content .mermaid-wrap svg');
    if (!svg) return 'no mermaid svg';
    // useMaxWidth:false 后 mermaid 输出固定像素宽（width 属性或 style.width），且渲染宽=该值
    const wAttr = parseFloat(svg.getAttribute('width') || '') || parseFloat(svg.style.width || '') || 0;
    const svgW = svg.getBoundingClientRect().width;
    const svgOk = wAttr > 400 && Math.abs(svgW - wAttr) <= 2;
    const wrapEl = svg.closest('.mermaid-wrap');
    const wrapScrollable = !!wrapEl && wrapEl.scrollWidth >= Math.round(svgW); // 超宽时 wrap 滚动区容纳全图
    if (tabNat) app.editor.closeTab(tabNat); // 对象引用关闭
    await api.remove(root + '/nat.md', false);
    await api.remove(root + '/nat-big.svg', false);
    return imgOk && svgOk && wrapScrollable
      ? true
      : 'img=' + imgOk + '(' + Math.round(imgW) + '/' + natW + '),svg=' + svgOk + '(' + Math.round(svgW) + '/' + wAttr + '),scroll=' + wrapScrollable;
  });

  // ---- v0.7.0：代码块一键复制（常驻按钮，点击整块进剪贴板） ----
  await step('codeCopyBtn', async () => {
    const BT = String.fromCharCode(96);
    const fence = BT + BT + BT;
    await api.writeFile(root + '/code-copy.md',
      '# 复制\\n\\n' + fence + 'js\\nconsole.log("CODE_COPY_OK_9527");\\n' + fence + '\\n\\n正文段落\\n');
    const ccTab = await app.editor.openFile(root + '/code-copy.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 400));
    const pre = document.querySelector('#preview-content pre');
    if (!pre) { if (ccTab) app.editor.closeTab(ccTab); return 'no pre'; }
    const btn = pre.querySelector('.code-copy-btn');
    if (!btn) { if (ccTab) app.editor.closeTab(ccTab); return 'no copy btn'; }
    // 常驻可见：不依赖 hover（computed opacity 恒 1，无 opacity:0 隐藏）
    const cs = getComputedStyle(btn);
    const alwaysVisible = cs.opacity === '1' && cs.visibility !== 'hidden';
    // 尺寸够大：min-width ≥ 50px、padding ≥ 4px（「复制键大一点」的量化口径）
    const rect = btn.getBoundingClientRect();
    const bigEnough = rect.width >= 50 && rect.height >= 22;
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const clip = await api.readClipboardText();
    const copiedOk = clip.includes('CODE_COPY_OK_9527');
    const labelAfter = btn.textContent;
    if (ccTab) app.editor.closeTab(ccTab);
    await api.remove(root + '/code-copy.md', false);
    // 收尾恢复图片剪贴板（previewImgClip 的隐式前提；本用例的文本写入替换了它）
    try {
      const b64c = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const pngc = root.replace(/\\//g, '\\\\') + '\\\\code-copy-restore.png';
      await api.writeBinary(pngc, Uint8Array.from(atob(b64c), (c) => c.charCodeAt(0)));
      await window.api.copyImage(pngc);
      await api.remove(pngc, false);
    } catch { /* 恢复失败不判红 */ }
    return alwaysVisible && bigEnough && copiedOk && labelAfter.includes('已复制')
      ? true
      : 'visible=' + alwaysVisible + ',big=' + bigEnough + '(' + Math.round(rect.width) + 'x' + Math.round(rect.height) + '),copied=' + copiedOk + ',label=' + labelAfter;
  });

  // ---- v0.7.0：仅预览模式下点大纲 → 预览区滚动到对应标题（不再跳回编辑器） ----
  await step('outlinePreviewJump', async () => {
    let md = '# 首标题 A\\n\\n' + '占位段落\\n\\n'.repeat(3);
    for (let i = 1; i <= 6; i++) md += '## 章节标题' + i + '\\n\\n' + '内容行\\n\\n'.repeat(40);
    await api.writeFile(root + '/outline-jump.md', md);
    const ojTab = await app.editor.openFile(root + '/outline-jump.md');
    app.preview.setMode('preview'); // 仅预览
    app.preview.applyMode();
    await new Promise((r) => setTimeout(r, 400));
    await window.__app.outline.refresh();
    const rowsEls = Array.from(document.querySelectorAll('#outline-list .outline-item'));
    if (rowsEls.length < 6) { if (ojTab) app.editor.closeTab(ojTab); return 'outline rows=' + rowsEls.length; }
    const ph = document.querySelector('#preview-host');
    const before = ph.scrollTop;
    rowsEls[5].click(); // 点「章节标题5」→ 预览滚到对应 h2
    await new Promise((r) => setTimeout(r, 400));
    const after = ph.scrollTop;
    const heads = document.querySelectorAll('#preview-content h1, #preview-content h2');
    const target = heads[5]; // 大纲第 6 项（idx=5：h1 占 idx0，章节5 是 h2 列表的第 5 个）
    const inView = !!target && target.getBoundingClientRect().top >= 0
      && target.getBoundingClientRect().top < ph.clientHeight;
    // 高亮反馈类
    const flash = target && target.classList.contains('ol-jump-flash');
    app.preview.setMode('split');
    if (ojTab) app.editor.closeTab(ojTab);
    await api.remove(root + '/outline-jump.md', false);
    return after > before && inView && flash !== false
      ? true
      : 'scroll=' + before + '->' + after + ',inView=' + inView + ',flash=' + !!flash;
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
    // 范围提示应显示大文件上限最大值（v0.7.0 起 5120 = 5GB）与滚动条宽度最大值
    const hints = Array.from(document.querySelectorAll('#modal-body .hint'))
      .map((h) => h.textContent)
      .join('|');
    const rangeOk = hints.includes('5120') && hints.includes('40');
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

  // scrollbarWidthVisual（SB 三层视觉断言，计划 §4.2）：
  // ① 劫持守卫：:root 标准 scrollbar-color 必须为 auto（daisyUI 注入 non-auto 会劫持 webkit 路径）
  // ② ::-webkit-scrollbar 伪元素计算宽度 === 设置值
  // ③ 真实渲染宽度 offsetWidth-clientWidth === 设置值（overlay 自动隐藏滚动条机器自适应跳过）
  await step('scrollbarWidthVisual', async () => {
    await api.setSettings({ scrollbarWidth: 30 });
    // ① 劫持守卫（本次 bug 的直接断言：daisyUI scrollbar-color 注入后 Chromium 忽略 webkit 宽度）
    const sc = getComputedStyle(document.documentElement).scrollbarColor;
    const el = document.querySelector('#file-tree');
    // 变量按 applyScrollbarWidth 同路径注入，保证本次设置即时生效（API 直改不触发 UI 应用）；
    // 必须先注入再读伪元素宽，否则读到的是 boot/上次持久化的旧值（v0.1.44 修正测试时序）
    document.documentElement.style.setProperty('--scrollbar-width', '30px');
    await new Promise((r) => setTimeout(r, 100));
    // ② 规则计算值：伪元素宽度应等于设置值
    const pw = el ? getComputedStyle(el, '::-webkit-scrollbar').width : '';
    // ③ 真实渲染宽度：仅经典滚动条机器断言（overlay 下 offsetWidth-clientWidth 恒 0，跳过）
    const det = document.createElement('div');
    det.style.cssText = 'position:absolute;width:50px;height:50px;overflow:scroll;visibility:hidden';
    document.body.appendChild(det);
    const overlay = det.offsetWidth - det.clientWidth === 0;
    det.remove();
    const layoutW = el ? el.offsetWidth - el.clientWidth : -1;
    const layoutOk = overlay || !el ? true : layoutW === 30;
    return sc === 'auto' && pw === '30px' && layoutOk
      ? true
      : 'sc=' + sc + ',pw=' + pw + ',layout=' + layoutW + ',overlay=' + overlay;
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

  // ---- 右键菜单打开目录（openDirFromPath，v0.2.3 多目录语义） ----
  await step('openDirFromPath', async () => {
    // v0.2.3：嵌套目录（tree-sub 在 root 内）被拒 —— 根间嵌套会让树归属判定歧义
    const nestRejected = (await window.__app.openDirFromPath(root + '/tree-sub')) === false;
    await window.__app.openDirFromPath(root); // 确保侧栏含 root（sessionClean 可能已清空）
    // 通过非嵌套目录打开（模拟右键菜单 --dir 传入）：加入侧栏并激活
    const ok = await window.__app.openDirFromPath(extRoot);
    const label = document.querySelector('#dir-label').textContent;
    const treeHas = Array.from(document.querySelectorAll('#file-tree .tree-node .name')).some(
      (n) => n.textContent === 'note.md'
    );
    // S1：关闭 ext 根收回单目录侧栏（后续用例仍以 root 为唯一工作目录）
    await window.__app.closeSidebarRoot(extRoot);
    await new Promise((r) => setTimeout(r, 400));
    const labelAfter = document.querySelector('#dir-label').textContent;
    return nestRejected && ok && label === extRoot && treeHas && labelAfter === root
      ? true
      : 'nest=' + nestRejected + ',ok=' + ok + ',label=' + label + ',tree=' + treeHas + ',after=' + labelAfter;
  });

  // ---- 外部修改自动同步（其他编辑器改文件 → MarkHunter 刷新，光标位置不变） ----
  await step('externalChange', async () => {
    await api.writeFile(root + '/ext.md', '第一行\\n第二行\\n第三行\\n第四行\\n第五行');
    await app.editor.openFile(root + '/ext.md');
    // 等待须超过自写宽限窗口（filewatch SELF_WRITE_GRACE_MS=2000ms）：上面的 api.writeFile
    // 建文件会记录一次自写宽限，立即外部写会被当作自身回声吸收（rapidSaveEcho 用例的对称面）
    await new Promise((r) => setTimeout(r, 2300));
    const view = app.editor.getView();
    const before = view.state.doc.toString();
    // 把光标放到第三行开头
    const selPos = view.state.doc.line(3).from;
    view.dispatch({ selection: { anchor: selPos } });
    const selBefore = view.state.selection.main.head;
    // 模拟外部修改（内容变长）。等待须超过自写宽限窗口（filewatch SELF_WRITE_GRACE_MS=2000ms）：
    // 上面的 api.writeFile 建文件会记录一次自写宽限，立即外部写会被当作自身回声吸收
    await api.writeExternal(root + '/ext.md', '第一行\\n第二行\\n第三行\\n第四行\\n第五行\\n第六行\\n第七行\\n第八行');
    await new Promise((r) => setTimeout(r, 1500)); // watchFile 轮询 + 防抖 + 重载
    const after = view.state.doc.toString();
    const selAfter = view.state.selection.main.head;
    return before.includes('第五行') && after.includes('第八行') && selAfter === selBefore
      ? true
      : 'before=' + before.slice(0, 10) + ',after=' + after.slice(0, 10) + ',sel=' + selBefore + '->' + selAfter;
  });

  // rapidSaveEcho（v0.1.47）：高频编辑 + 连续保存不得误报「外部修改」——
  // Windows fs.watch 事件延迟/合并会让自写 mtime 精确匹配失败（打字快时反复弹确认框）。
  // 连续 5 轮「编辑→保存」（间隔 ~120ms，远小于 300ms 防抖），静置 2.6s（超过宽限窗口）
  // 期间轮询检测：不得出现「已从外部重新加载」toast；文档与磁盘内容一致
  await step('rapidSaveEcho', async () => {
    await api.writeFile(root + '/echo.md', 'echo-0\\n');
    const tab = await app.editor.openFile(root + '/echo.md');
    if (!tab) return 'open failed';
    await new Promise((r) => setTimeout(r, 400));
    const view = app.editor.getView();
    for (let i = 1; i <= 5; i++) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'echo-' + i + '\\n' } });
      await app.editor.saveNow(); // 立即保存（不等自动保存），写间隔远小于防抖窗口，制造事件错位条件
      await new Promise((r) => setTimeout(r, 120));
    }
    let reloaded = false;
    for (let i = 0; i < 13 && !reloaded; i++) {
      await new Promise((r) => setTimeout(r, 200));
      reloaded = Array.from(document.querySelectorAll('.toast')).some((t) => t.textContent.includes('已从外部重新加载'));
    }
    const disk = await api.readFile(root + '/echo.md');
    const expect = 'echo-0\\necho-1\\necho-2\\necho-3\\necho-4\\necho-5\\n';
    const docOk = view.state.doc.toString() === expect;
    const diskOk = disk.content === expect;
    const t2 = app.editor.findTabByPath(root + '/echo.md');
    if (t2) app.editor.closeTab(t2);
    await api.remove(root + '/echo.md', false);
    return !reloaded && docOk && diskOk
      ? true
      : 'reloaded=' + reloaded + ',doc=' + docOk + ',disk=' + diskOk;
  });

  // tabScrollMemory（v0.1.48）：标签切换记住滚动位置 —— A 滚到 800 → 切 B（应为顶部）→ B 滚到 400
  // → 切回 A（≈800）→ 切回 B（≈400）
  await step('tabScrollMemory', async () => {
    const long = Array.from({ length: 400 }, (_, i) => '第' + (i + 1) + '行内容').join('\\n');
    await api.writeFile(root + '/scroll-a.md', long);
    await api.writeFile(root + '/scroll-b.md', long);
    await app.editor.openFile(root + '/scroll-a.md');
    await new Promise((r) => setTimeout(r, 300));
    const view = app.editor.getView();
    view.scrollDOM.scrollTop = 800;
    await new Promise((r) => setTimeout(r, 120));
    const aPos = view.scrollDOM.scrollTop;
    await app.editor.openFile(root + '/scroll-b.md');
    await new Promise((r) => setTimeout(r, 500));
    const bTop = view.scrollDOM.scrollTop; // 新标签无记录 → 应在顶部
    view.scrollDOM.scrollTop = 400;
    await new Promise((r) => setTimeout(r, 120));
    await app.editor.openFile(root + '/scroll-a.md'); // 切回 A
    await new Promise((r) => setTimeout(r, 500));
    const backA = view.scrollDOM.scrollTop;
    await app.editor.openFile(root + '/scroll-b.md'); // 切回 B
    await new Promise((r) => setTimeout(r, 500));
    const backB = view.scrollDOM.scrollTop;
    for (const p of ['/scroll-a.md', '/scroll-b.md']) {
      const t = app.editor.findTabByPath(root + p);
      if (t) app.editor.closeTab(t);
      await api.remove(root + p, false);
    }
    const okA = Math.abs(aPos - 800) < 80 && bTop < 60 && Math.abs(backA - aPos) < 120 && Math.abs(backB - 400) < 120;
    return okA ? true : 'a=' + aPos + ',bTop=' + bTop + ',backA=' + backA + ',backB=' + backB;
  });

  // scrollButtons（v0.1.48）：状态栏「到底部/回顶部」按钮 —— 底部接近最大滚动、顶部归零
  await step('scrollButtons', async () => {
    const long = Array.from({ length: 400 }, (_, i) => '第' + (i + 1) + '行内容').join('\\n');
    await api.writeFile(root + '/scroll-btn.md', long);
    await app.editor.openFile(root + '/scroll-btn.md');
    await new Promise((r) => setTimeout(r, 300));
    const view = app.editor.getView();
    document.getElementById('btn-scroll-bottom').click();
    let okBottom = false;
    let cur = -1;
    let maxSeen = 0;
    for (let i = 0; i < 20 && !okBottom; i++) {
      await new Promise((r) => setTimeout(r, 100));
      cur = view.scrollDOM.scrollTop;
      maxSeen = Math.max(maxSeen, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
      okBottom = maxSeen > 1000 && Math.abs(cur - maxSeen) < 120;
    }
    document.getElementById('btn-scroll-top').click();
    await new Promise((r) => setTimeout(r, 300));
    const top = view.scrollDOM.scrollTop;
    const t = app.editor.findTabByPath(root + '/scroll-btn.md');
    if (t) app.editor.closeTab(t);
    await api.remove(root + '/scroll-btn.md', false);
    return okBottom && top < 5 ? true : 'bottom=' + okBottom + '/' + cur + '/' + maxSeen + ',top=' + top;
  });

  // createInSelectedDir（v0.1.48）：点击目录行后「新建文件」落在该目录内 ——
  // 修复前目录点击不更新选中，新建落到最后点击文件所在目录/根目录，在用户浏览的位置"看似没创建"
  await step('createInSelectedDir', async () => {
    await api.create(root, 'cisd-sub', 'dir');
    await app.tree.refreshNode(root, true); // api.create 不自动刷树
    await new Promise((r) => setTimeout(r, 400));
    const rows = () => Array.from(document.querySelectorAll('#file-tree .tree-node'));
    const row = rows().find((n) => String(n.dataset.path).replace(/\\\\/g, '/').endsWith('/cisd-sub'));
    if (!row) {
      await api.remove(root + '/cisd-sub', true);
      return 'row missing';
    }
    row.click(); // 点击目录行 → 应更新选中（新建目标跟随）
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#btn-new-file').click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.querySelector('#modal-body input');
    if (!input) {
      await api.remove(root + '/cisd-sub', true);
      return 'no prompt';
    }
    input.value = 'in-cisd.md';
    const btns = Array.from(document.querySelectorAll('#modal-actions .tbtn'));
    btns[btns.length - 1].click();
    await new Promise((r) => setTimeout(r, 700));
    const inSub = await api.stat(root + '/cisd-sub/in-cisd.md').catch(() => null);
    const atRoot = await api.stat(root + '/in-cisd.md').catch(() => null);
    const t = app.editor.findTabByPath(root + '/cisd-sub/in-cisd.md'); // 新建文件会自动打开
    if (t) app.editor.closeTab(t);
    await api.remove(root + '/cisd-sub', true);
    return inSub && !atRoot ? true : 'inSub=' + !!inSub + ',atRoot=' + !!atRoot;
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

  // dropPathResolver：preload 必须暴露 webUtils.getPathForFile（Electron 32+ 移除 File.path，
  // 真实拖拽依赖它解析路径；dragOpenFile 的假对象只覆盖回退分支）
  await step('dropPathResolver', async () => {
    return typeof api.getPathForFile === 'function' ? true : 'typeof=' + typeof api.getPathForFile;
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

  await step('extCreateAllowed', async () => {
    // v0.5.1：新建全部放开 —— 外部（未批准）目录创建成功，且「创建即批准」使随后的内容写入/读取可用
    const p = await api.create(extRoot, 'x.md', 'file');
    await api.writeFile(p, '外部创建内容');
    const rb = await api.readFile(p);
    const st = await api.stat(p);
    const cleanup = await api.remove(p, false).then(() => true).catch(() => false);
    return !!p && rb.content === '外部创建内容' && st.isFile && cleanup
      ? true
      : 'p=' + p + ',content=' + rb.content + ',cleanup=' + cleanup;
  });

  await step('createAnywhereDeep', async () => {
    // 任意位置深层创建：父链不存在 → recursive 重建；目录创建同样放开；随后的写入不被拒
    const deep = await api.create(extRoot + '/anywhere/deep', 'newdir', 'dir');
    const f = await api.create(extRoot + '/anywhere/deep', 'a.txt', 'file');
    await api.writeFile(f, 'deep create ok');
    const rb = await api.readFile(f);
    const cleanup = await api.remove(extRoot + '/anywhere', true).then(() => true).catch(() => false);
    return !!deep && rb.content === 'deep create ok' && cleanup
      ? true
      : 'deep=' + deep + ',content=' + rb.content + ',cleanup=' + cleanup;
  });

  // extDirFullOps（v0.7.1）：外部链目录上的**全套写操作**直接放行（不再分活动/外部）——
  // 创建文件/目录（含内容写入）、复制到剪贴板、粘贴、重命名、删除，全程零权限拒绝。
  await step('extDirFullOps', async () => {
    await api.create(extRoot, 'full-ops', 'dir');
    await api.create(extRoot + '/full-ops', 'inner', 'dir');
    await api.writeFile(extRoot + '/full-ops/src.md', 'EXT_FULL_OPS_DATA');
    // 复制 src.md → 粘贴到 inner/（树级剪贴板通道；写盘白名单已移除，全程不拒）
    await window.api.clipboardCopyFiles([extRoot + '/full-ops/src.md']);
    const pasted = await api.pasteFiles(extRoot + '/full-ops/inner', { conflict: 'ask' });
    const pastedOk = !!(pasted && pasted.ok === true && Array.isArray(pasted.pasted) && pasted.pasted.length === 1);
    let dataOk = false;
    try { dataOk = (await api.readFile(extRoot + '/full-ops/inner/src.md')).content === 'EXT_FULL_OPS_DATA'; } catch { dataOk = false; }
    // 重命名（外部目录内的写路径）+ 改名后写入
    const rn = await api.rename(extRoot + '/full-ops/src.md', 'src-renamed.md');
    let writeAfterRename = false;
    try { writeAfterRename = (await api.writeFile(rn, 'EXT_FULL_OPS_DATA_V2')) === true; } catch { writeAfterRename = false; }
    // 在外部目录里再建一层深层目录 + 删除
    const deep = await api.create(extRoot + '/full-ops/inner', 'deep', 'dir');
    const cleanup = await api.remove(extRoot + '/full-ops', true).then(() => true).catch(() => false);
    // 收尾恢复图片剪贴板（本用例的 CF_HDROP 写入替换了 previewImgCtx 留下的图片，previewImgClip 依赖它）
    try {
      const b64f = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const pngf = root.replace(/\\//g, '\\\\') + '\\\\ext-fullops-restore.png';
      await api.writeBinary(pngf, Uint8Array.from(atob(b64f), (c) => c.charCodeAt(0)));
      await window.api.copyImage(pngf);
      await api.remove(pngf, false);
    } catch { /* 恢复失败不判红 */ }
    return pastedOk && dataOk && writeAfterRename && !!deep && cleanup
      ? true
      : 'paste=' + pastedOk + ',data=' + dataOk + ',write=' + writeAfterRename + ',deep=' + !!deep + ',clean=' + cleanup;
  });

  await step('extSwitchRoot', async () => {
    await app.editor.openFile(extRoot + '/note.md');
    await new Promise((r) => setTimeout(r, 300));
    await app.openDirFromPath(extRoot); // 外部变内部（v0.2.3：ext 根加入侧栏并激活）
    await new Promise((r) => setTimeout(r, 600));
    const label = document.querySelector('#dir-label').textContent;
    const tabOk = !!app.editor.findTabByPath(extRoot + '/note.md');
    const node = Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => normP(n.dataset.path) === normP(extRoot + '/note.md'));
    const selected = !!node && node.classList.contains('selected');
    const extGone = !Array.from(document.querySelectorAll('#file-tree .tree-node')).some((n) => n.querySelector('.name').textContent === '外部文件');
    await app.closeSidebarRoot(extRoot); // v0.2.3：关闭 ext 根（活动转回 root），外部区恢复
    await new Promise((r) => setTimeout(r, 600));
    const tabStill = !!app.editor.findTabByPath(extRoot + '/note.md');
    const extBack = Array.from(document.querySelectorAll('#file-tree .tree-node')).some((n) => n.querySelector('.name').textContent === '外部文件');
    const rootBack = app.state.rootDir && normP(app.state.rootDir) === normP(root);
    return label === extRoot && tabOk && selected && extGone && tabStill && extBack && rootBack
      ? true
      : 'label=' + label + ',tab=' + tabOk + ',sel=' + selected + ',gone=' + extGone + ',still=' + tabStill + ',back=' + extBack + ',rootBack=' + rootBack;
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
    // 外部链 reveal 是逐级懒加载的异步链（readTree 盘符→目标 的每一级），与 extReveal
    // 同款轮询等待（waitFor 只回布尔，元素在闭包里取）
    let fileNode = null;
    await waitFor(() => {
      fileNode = Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => normP(n.dataset.path) === normP(extRoot + '/note.md'));
      return !!fileNode;
    });
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
    // v0.7.1：外部目录行菜单与内部一致（新建/复制/粘贴/重命名/删除）+ 外部链特有的切换工作目录
    const dOk = items2.some((t) => t.indexOf('新建文件') >= 0) && items2.some((t) => t.indexOf('新建目录') >= 0) &&
      items2.some((t) => t.indexOf('重命名') >= 0) && items2.some((t) => t.indexOf('删除目录') >= 0) &&
      items2.some((t) => t.indexOf('复制') >= 0) && items2.some((t) => t.indexOf('粘贴') >= 0) &&
      items2.some((t) => t.indexOf('切换工作目录') >= 0) && items2.some((t) => t.indexOf('刷新') >= 0);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await api.setSettings({ lastSession: lastSessionOrig }); // 收尾恢复现场
    app.state.settings = await api.getSettings();
    return fOk && dOk ? true : 'f=' + items1.join('|') + ',d=' + items2.join('|');
  });

  // ================= v0.2.3 多目录侧栏 + 跨目录拖拽传输 =================
  // 拖拽模拟：DragEvent + DataTransfer 合成事件（Chromium 支持 dataTransfer 注入）；
  // drop 走 tree.js attachDrag 的行级处理器，传输经主进程 fs:transfer 真实落盘
  const mdRow = (p) => Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => normP(n.dataset.path) === normP(p));
  const rootRowOf = (dir) => Array.from(document.querySelectorAll('#file-tree > .tree-node')).find((n) => normP(n.dataset.path) === normP(dir) && n.querySelector('.root-close'));
  const fireDrag = async (srcPath, destPath, ctrl) => {
    const s = mdRow(srcPath);
    const d = mdRow(destPath);
    if (!s || !d) return 'no row: src=' + !!s + ',dst=' + !!d;
    const dt = new DataTransfer();
    s.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    d.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
    s.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 700)); // fs:transfer + 双侧树刷新
    return true;
  };

  await step('multiRootOpen', async () => {
    await app.editor.closeAll();
    await app.openDirFromPath(root);
    const n0 = app.state.sidebarRoots.length;
    const ok = await app.openDirFromPath(extRoot); // 第二根：加入侧栏并激活
    await new Promise((r) => setTimeout(r, 500));
    const rows = Array.from(document.querySelectorAll('#file-tree > .tree-node')).filter((n) => n.querySelector('.root-close'));
    const label = document.querySelector('#dir-label').textContent;
    const badge = !!document.querySelector('#file-tree .root-badge');
    const saved = (await api.getSettings()).sidebarRoots || [];
    return ok && n0 === 1 && app.state.sidebarRoots.length === 2 && rows.length === 2 && label === extRoot && badge && saved.length === 2
      ? true
      : 'n0=' + n0 + ',ok=' + ok + ',roots=' + app.state.sidebarRoots.length + ',rows=' + rows.length + ',label=' + label + ',badge=' + badge + ',saved=' + saved.length;
  });

  await step('multiRootNestRejected', async () => {
    await api.create(extRoot, 'nested', 'dir'); // extRoot 已是根 → 建目录放行
    const before = app.state.sidebarRoots.length;
    const ok = await app.openDirFromPath(extRoot + '/nested');
    return ok === false && app.state.sidebarRoots.length === before
      ? true
      : 'ok=' + ok + ',roots=' + app.state.sidebarRoots.length;
  });

  await step('multiRootDropCopy', async () => {
    await api.writeFile(extRoot + '/drag-cp.md', '# 复制测试\\n');
    await app.tree.refreshNode(extRoot, true);
    await new Promise((r) => setTimeout(r, 300));
    const r1 = await fireDrag(extRoot + '/drag-cp.md', root, true); // Ctrl+拖 = 复制
    if (r1 !== true) return r1;
    const inRoot = (await api.readTree(root)).some((e) => e.name === 'drag-cp.md');
    const inExt = (await api.readTree(extRoot)).some((e) => e.name === 'drag-cp.md');
    return inRoot && inExt ? true : 'inRoot=' + inRoot + ',inExt=' + inExt;
  });

  await step('multiRootDropDir', async () => {
    await api.create(extRoot, 'drag-dir', 'dir');
    await api.writeFile(extRoot + '/drag-dir/inner.md', '递归内容\\n');
    await app.tree.refreshNode(extRoot, true);
    await new Promise((r) => setTimeout(r, 300));
    const r1 = await fireDrag(extRoot + '/drag-dir', root, true); // Ctrl+拖目录 = 递归复制
    if (r1 !== true) return r1;
    const copied = await api.readFile(root + '/drag-dir/inner.md');
    const srcSt = await api.stat(extRoot + '/drag-dir/inner.md'); // 源仍在（复制）
    return copied.content.includes('递归内容') && srcSt.isFile ? true : 'content=' + copied.content.slice(0, 20);
  });

  await step('multiRootDropMove', async () => {
    // 打开文件 → 移动 → 标签路径应跟随（onClosePath 重挂监听）
    await api.writeFile(extRoot + '/drag-mv.md', '移动测试\\n');
    await app.editor.openFile(extRoot + '/drag-mv.md');
    await app.tree.refreshNode(extRoot, true);
    await new Promise((r) => setTimeout(r, 300));
    const r1 = await fireDrag(extRoot + '/drag-mv.md', root, false); // 拖 = 移动
    if (r1 !== true) return r1;
    let srcGone = false;
    try { await api.stat(extRoot + '/drag-mv.md'); } catch { srcGone = true; }
    const dst = await api.readFile(root + '/drag-mv.md');
    // 主进程返回的目标路径为反斜杠真实路径，标签查找须两种分隔符都试（findTabByPath 精确匹配）
    const movedFwd = root + '/drag-mv.md';
    const tabFollowed = !!(app.editor.findTabByPath(movedFwd) || app.editor.findTabByPath(movedFwd.replace(/\\//g, '\\\\')));
    return srcGone && dst.content.includes('移动测试') && tabFollowed
      ? true
      : 'srcGone=' + srcGone + ',tab=' + tabFollowed;
  });

  await step('multiRootConflictDedupe', async () => {
    // root 已有 drag-cp.md（复制用例产物）→ 再拖同名 → 冲突弹窗 → 「保留两者」→ 自动改名 (2)
    await app.tree.refreshNode(root, true);
    await new Promise((r) => setTimeout(r, 300));
    const s = mdRow(extRoot + '/drag-cp.md');
    const d = mdRow(root);
    if (!s || !d) return 'no row';
    const dt = new DataTransfer();
    s.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    d.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 600)); // 等冲突弹窗出现
    const keepBtn = Array.from(document.querySelectorAll('#modal-actions .tbtn')).find((b) => b.textContent === '保留两者');
    if (!keepBtn) return 'no conflict dialog';
    keepBtn.click();
    await new Promise((r) => setTimeout(r, 700));
    const dedup = (await api.readTree(root)).some((e) => e.name === 'drag-cp (2).md');
    const orig = (await api.readTree(root)).some((e) => e.name === 'drag-cp.md');
    return dedup && orig ? true : 'dedup=' + dedup + ',orig=' + orig;
  });

  await step('multiRootDeleteProtected', async () => {
    let rejected = false;
    try {
      await api.remove(extRoot, true);
    } catch (e) {
      rejected = String(e.message).indexOf('不能删除') >= 0;
    }
    return rejected;
  });

  await step('multiRootClose', async () => {
    // 根行 ✕ 关闭 ext 根：侧栏回到单根、活动转回 root、主进程根集合同步（收尾恢复外部语义现场）
    const row = rootRowOf(extRoot);
    if (!row) return 'no ext root row';
    row.querySelector('.root-close').click();
    await new Promise((r) => setTimeout(r, 500));
    const rows = Array.from(document.querySelectorAll('#file-tree > .tree-node')).filter((n) => n.querySelector('.root-close'));
    const label = document.querySelector('#dir-label').textContent;
    const saved = (await api.getSettings()).sidebarRoots || [];
    return app.state.sidebarRoots.length === 1 && rows.length === 1 && label === root && saved.length === 1
      ? true
      : 'roots=' + app.state.sidebarRoots.length + ',rows=' + rows.length + ',label=' + label + ',saved=' + saved.length;
  });

  await step('multiRootTransferReject', async () => {
    // v0.7.0 权限口径变更（用户决策）：树内可达的拖拽传输不再做白名单 —— 外部未批准目录
    // 作为传输目标**放行**（extRoot 已不再是根也能拖过去）；语义与 fs:create/剪贴板一致。
    await app.editor.closeAll();
    let copied = null;
    try {
      const r = await api.transferFiles(root + '/drag-cp.md', extRoot, 'copy', { conflict: 'dedupe' });
      copied = !!(r && r.dest);
    } catch (e) {
      copied = false;
    }
    // 清理刚拖过去的副本（不留垃圾影响后续目录断言）
    if (copied) await api.remove(extRoot + '/drag-cp.md', false).catch(() => {});
    return copied;
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

  // themeCatalog：主题全集 56 个合法名（v0.1.50 起 = 36 + 20 特效款，含 markhunter-classic、无重复）+ 暗色 25 个
  await step('themeCatalog', async () => {
    const names = app.THEME_NAMES || [];
    const dark = app.DARK_THEMES || [];
    const uniq = new Set(names).size === names.length;
    return names.length === 56 && names.includes('markhunter-classic') && dark.length === 25 && uniq
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

  // ================= v0.1.44 立即批次冒烟（H1/P3/M1/M2/M4） =================
  // 局部助手：读当前 mermaid 首图 node 的填充色（default 浅色 ≈ rgb(236,236,255)，dark ≈ rgb(31,32,32)）
  const nodeFill = () => {
    const node = document.querySelector('#preview-content .mermaid-wrap svg .node');
    if (!node) return '';
    const sh = node.querySelector('rect, polygon, circle, path') || node;
    return getComputedStyle(sh).fill;
  };
  const mmFence = () => {
    const BT = String.fromCharCode(96); // 反引号（避免与外层模板字符串冲突）
    return BT + BT + BT;
  };

  // themeMermaidColdStart（H1）：浅色渲染 → 切暗色 → 节点应重渲为暗色（fill 变化即主题联动生效）
  await step('themeMermaidColdStart', async () => {
    await setTheme('markhunter-classic'); // 浅色基线
    const fence = mmFence();
    await api.writeFile(root + '/mm-theme.md', '# MT\\n\\n' + fence + 'mermaid\\ngraph TD\\n  A-->B\\n' + fence + '\\n');
    await app.editor.openFile(root + '/mm-theme.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 1200)); // 等 mermaid 异步渲染
    const lightFill = nodeFill();
    app.applyTheme('night'); // 暗色 → refreshMermaid 重渲（H1 链路：渲染前已按明暗初始化）
    await new Promise((r) => setTimeout(r, 1200));
    const darkFill = nodeFill();
    await setTheme('markhunter-classic');
    return lightFill && darkFill && lightFill !== darkFill
      ? true
      : 'light=' + lightFill + ',dark=' + darkFill;
  });

  // themeMermaidIdempotent（P3）：同明暗重复 applyTheme 不重渲；明暗跨界恰好 1 次重渲
  await step('themeMermaidIdempotent', async () => {
    const before = app.preview.mermaidRenderCount;
    app.applyTheme('light');               // 浅色 → 浅色：不重渲
    app.applyTheme('markhunter-classic');  // 浅色 → 浅色：不重渲
    await new Promise((r) => setTimeout(r, 400));
    const mid = app.preview.mermaidRenderCount;
    app.applyTheme('dark');                // 浅色 → 暗色：应恰好 1 次重渲（跨界）
    await new Promise((r) => setTimeout(r, 1200));
    const after = app.preview.mermaidRenderCount;
    await setTheme('markhunter-classic');  // 恢复（暗 → 浅，会再重渲，无妨）
    const sameOk = mid === before;
    const crossOk = after === mid + 1;
    return sameOk && crossOk
      ? true
      : 'before=' + before + ',mid=' + mid + ',after=' + after;
  });

  // mermaidPartialReRender（M4）：存在未渲染 pre>code.language-mermaid 残留时 refreshMermaid 能补渲
  await step('mermaidPartialReRender', async () => {
    await setTheme('markhunter-classic'); // 浅色（同明暗，验证补渲不依赖明暗变化）
    const content = document.querySelector('#preview-content');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = 'graph TD\\n  X-->Y';
    pre.appendChild(code);
    content.appendChild(pre); // 手工制造 M4 竞态残留（未渲染 pre>code）
    const before = content.querySelectorAll('pre > code.language-mermaid').length;
    app.preview.refreshMermaid(); // 明暗未变但存在残留 → 应补渲
    await new Promise((r) => setTimeout(r, 1200));
    const leftover = content.querySelectorAll('pre > code.language-mermaid').length;
    const wraps = content.querySelectorAll('#preview-content .mermaid-wrap').length;
    const err = content.querySelector('.mermaid-error');
    return before === 1 && leftover === 0 && wraps >= 2 && !err
      ? true
      : 'before=' + before + ',leftover=' + leftover + ',wraps=' + wraps + ',err=' + (err ? err.textContent : 'none');
  });

  // modalWidthReset（M2）：查看器打开（modal-box 加宽 860）→ 遮罩关闭 → 内联宽应清空（无残留）
  await step('modalWidthReset', async () => {
    const wrap = document.querySelector('#preview-content .mermaid-wrap');
    if (!wrap) return 'no wrap';
    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); // 打开 mermaid 查看器
    await new Promise((r) => setTimeout(r, 300));
    const boxEl = document.querySelector('#modal-box');
    const widened = boxEl && boxEl.style.width !== '';
    // 遮罩关闭（不走「关闭」按钮的 restore 路径，验证 closeModal 统一清理）
    document.querySelector('#modal-mask').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const w = boxEl ? boxEl.style.width : 'n/a';
    return widened && w === ''
      ? true
      : 'widened=' + widened + ',w=' + JSON.stringify(w);
  });

  // modalMaskRestore（M1）：设置弹窗改主题（即时预览）→ 点遮罩关闭 → data-theme 还原打开时主题
  await step('modalMaskRestore', async () => {
    await setTheme('markhunter-classic');
    document.querySelector('#btn-settings').click();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.querySelector('#theme-select');
    if (!sel) {
      document.querySelector('#modal-actions .tbtn').click();
      return 'no theme-select';
    }
    sel.value = 'night';
    sel.dispatchEvent(new Event('change')); // 即时预览 → data-theme=night
    await new Promise((r) => setTimeout(r, 100));
    const previewed = document.documentElement.getAttribute('data-theme') === 'night';
    // 点遮罩（mask）关闭 → onClose 钩子还原主题
    document.querySelector('#modal-mask').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const closed = document.querySelector('#modal-mask').classList.contains('hidden');
    const restored = document.documentElement.getAttribute('data-theme') === 'markhunter-classic';
    return previewed && closed && restored
      ? true
      : 'previewed=' + previewed + ',closed=' + closed + ',restored=' + restored;
  });

  // ================= v0.1.44 短期批次冒烟（P1+P2/M3/L1/L6/L7/L9/P5） =================

  // debounceTyping（P1）：快速三次输入 → 250ms 防抖窗口内 preview.render 只合并为 1 次
  await step('debounceTyping', async () => {
    await api.writeFile(root + '/debounce.md', '# 防抖\\n初始内容\\n');
    await app.editor.openFile(root + '/debounce.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 400));
    const r0 = app.preview.renderCount;
    const view = app.editor.getView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'b' } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'c' } });
    await new Promise((r) => setTimeout(r, 900)); // 超过 250ms 防抖窗口
    const r1 = app.preview.renderCount;
    return r1 === r0 + 1 ? true : 'r0=' + r0 + ',r1=' + r1;
  });

  // mermaidCache（P2）：同内容（源码 + 明暗）重复整篇渲染 → 实际 mermaid.render 计数不增；改内容 → +1
  await step('mermaidCache', async () => {
    const fence = mmFence();
    await api.writeFile(root + '/mm-cache.md', '# C\\n\\n' + fence + 'mermaid\\ngraph TD\\n  C1-->C2\\n' + fence + '\\n');
    await app.editor.openFile(root + '/mm-cache.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 1300)); // 首次渲染：缓存未命中，+1
    const c0 = app.preview.mermaidRenderCount;
    app.preview.render(); // 同内容重渲染（防抖合并后的整篇路径）→ 缓存命中，不再调 mermaid.render
    await new Promise((r) => setTimeout(r, 500));
    const c1 = app.preview.mermaidRenderCount;
    const view = app.editor.getView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# C2\\n\\n' + fence + 'mermaid\\ngraph TD\\n  C1-->C3\\n' + fence + '\\n' } });
    await new Promise((r) => setTimeout(r, 1300)); // 防抖(250ms) + mermaid 异步：新源码 → 缓存未命中 +1
    const c2 = app.preview.mermaidRenderCount;
    return c1 === c0 && c2 === c0 + 1 ? true : 'c0=' + c0 + ',c1=' + c1 + ',c2=' + c2;
  });

  // pasteExternalImage（M3）：外部（工作目录外）md 粘贴图片 → write-binary 对「已批准文件所在目录」放行，图片成功生成
  await step('pasteExternalImage', async () => {
    await app.editor.openFile(extRoot + '/note.md'); // readFile 成功 → 文件进入批准面（dirHasApprovedFile 据此放行同级写）
    await new Promise((r) => setTimeout(r, 300));
    const view = app.editor.getView();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'pic.png', { type: 'image/png' }));
    view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 800));
    const doc = view.state.doc.toString();
    const files = await api.readTree(extRoot);
    const saved = files.some((f) => f.name.startsWith('image-') && f.name.endsWith('.png'));
    const toasts = Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent);
    const rejected = toasts.some((t) => t.includes('不在当前工作目录内'));
    return doc.includes('![image-') && saved && !rejected
      ? true
      : 'doc=' + doc.replace(/\\n/g, '|') + ',saved=' + saved + ',rej=' + rejected;
  });

  // themeGrouping（L1）：aqua/forest 归深色组，浅色组不再含二者；四组共 36 个主题
  await step('themeGrouping', async () => {
    document.querySelector('#btn-settings').click();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.querySelector('#theme-select');
    if (!sel) {
      const cancelBtn = document.querySelector('#modal-actions .tbtn');
      if (cancelBtn) cancelBtn.click();
      return 'no theme-select';
    }
    const groups = {};
    document.querySelectorAll('#theme-select optgroup').forEach((g) => {
      groups[g.label] = Array.from(g.querySelectorAll('option')).map((o) => o.value);
    });
    document.querySelector('#modal-actions .tbtn').click(); // 取消（onClose 钩子还原主题）
    await new Promise((r) => setTimeout(r, 100));
    const light = groups['浅色'] || [];
    const dark = groups['深色'] || [];
    const total = Object.keys(groups).reduce((n, k) => n + groups[k].length, 0);
    const fxGroup = groups['特效'] || [];
    const fxOk = fxGroup.length === 20 && fxGroup[0] === 'fx-aurora' && fxGroup.includes('fx-eclipse');
    return !light.includes('aqua') && !light.includes('forest') && dark.includes('aqua') && dark.includes('forest') && total === 56 && fxOk
      ? true
      : 'light=' + light.join(',') + ',dark=' + dark.join(',') + ',fx=' + fxGroup.length + ',total=' + total;
  });

  // fxTheme（v0.1.50）：特效皮肤 —— 20 款全部可应用、fx-layer 显示且动画运行、
  // 暗色款防闪白清单生效、settings 白名单持久化往返、切回经典后 fx-layer 隐藏零残留
  await step('fxTheme', async () => {
    const fx = app.THEME_NAMES.filter((n) => n.startsWith('fx-'));
    if (fx.length !== 20) return 'fx count=' + fx.length;
    const layer = document.getElementById('fx-layer');
    // 逐款应用：data-theme 正确 + 层可见 + 伪元素动画名非 none（reduced-motion 环境下跳过动画断言）
    let animOk = true;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const name of fx) {
      app.applyTheme(name);
      if (document.documentElement.getAttribute('data-theme') !== name) return 'attr mismatch ' + name;
      if (getComputedStyle(layer).display === 'none') return 'layer hidden ' + name;
      const anim = getComputedStyle(layer, '::before').animationName;
      const anim2 = getComputedStyle(layer, '::after').animationName;
      const selfAnim = getComputedStyle(layer).animationName;
      if (!reduce && anim === 'none' && anim2 === 'none' && selfAnim === 'none') {
        return 'no animation on ' + name + ' (before=' + anim + ',after=' + anim2 + ')';
      }
      animOk = animOk && true;
    }
    // 暗色特效款：DARK_THEMES 生效（mermaid 明暗判断源）
    const darkOk = app.DARK_THEMES.includes('fx-matrix') && app.DARK_THEMES.includes('fx-eclipse') && !app.DARK_THEMES.includes('fx-aurora');
    // 设置白名单往返：fx-neon 持久化 + 回读
    await api.setSettings({ theme: 'fx-neon' });
    const s = await api.getSettings();
    const persisted = s.theme === 'fx-neon';
    await api.setSettings({ theme: 'markhunter-classic' });
    app.applyTheme('markhunter-classic');
    // 切回经典：fx-layer 恢复隐藏（display:none）
    const layerHidden = getComputedStyle(layer).display === 'none';
    const darkBg = getComputedStyle(document.body).backgroundColor;
    return fx.length === 20 && darkOk && persisted && layerHidden
      ? true
      : 'dark=' + darkOk + ',persist=' + persisted + ',hidden=' + layerHidden + ',bg=' + darkBg;
  });

  // silentRestore（L6）：lastSession 含不存在文件 → 恢复不弹 alertBox（modal-mask 保持隐藏），其余文件正常恢复并激活
  await step('silentRestore', async () => {
    await app.editor.closeAll();
    const okPath = root + '/sess-ok.md';
    await api.writeFile(okPath, '# 会话 OK\\n内容');
    await api.setSettings({ lastSession: { paths: [root + '/sess-missing1.md', okPath, root + '/sess-missing2.md'], active: 1, pinned: [] } });
    app.state.settings = await api.getSettings();
    const mask = document.querySelector('#modal-mask');
    await window.__app.session.restore();
    await new Promise((r) => setTimeout(r, 200));
    const modalGone = mask.classList.contains('hidden');
    const okTab = !!app.editor.findTabByPath(okPath);
    const miss1 = !!app.editor.findTabByPath(root + '/sess-missing1.md');
    const miss2 = !!app.editor.findTabByPath(root + '/sess-missing2.md');
    const act = app.editor.getActiveTab();
    // 清理：恢复结束会重写 lastSession 为实际打开的标签，这里还原干净会话状态
    await app.editor.closeAll();
    await api.setSettings({ lastSession: null });
    app.state.settings = await api.getSettings();
    return modalGone && okTab && !miss1 && !miss2 && !!act && act.path === okPath
      ? true
      : 'modal=' + modalGone + ',ok=' + okTab + ',m1=' + miss1 + ',m2=' + miss2 + ',act=' + (act && act.path);
  });

  // svgPasteExt（L7）：剪贴板 image/svg+xml 粘贴 → 扩展名归一化为 svg（而非 svg+xml），文件成功生成且引用正确
  await step('svgPasteExt', async () => {
    await api.writeFile(root + '/svg-paste.md', '# SVG 粘贴\\n');
    await app.editor.openFile(root + '/svg-paste.md');
    await new Promise((r) => setTimeout(r, 200));
    const view = app.editor.getView();
    const dt = new DataTransfer();
    dt.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'pic.svg', { type: 'image/svg+xml' }));
    view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 800));
    const doc = view.state.doc.toString();
    const files = await api.readTree(root);
    const svgFile = files.find((f) => f.name.startsWith('image-') && f.name.endsWith('.svg'));
    const badExt = files.some((f) => f.name.includes('svg+xml'));
    return doc.includes('![image-') && !!svgFile && !badExt
      ? true
      : 'doc=' + doc.replace(/\\n/g, '|') + ',svg=' + !!svgFile + ',bad=' + badExt;
  });

  // writeExternalPackaged（L9）：dev 模式 writeExternal 仍可用（无条件注册；打包版抛明确错误由打包环境验证）
  await step('writeExternalPackaged', async () => {
    const packed = await api.isPackaged();
    const p = extRoot + '/we-dev.txt';
    let ok = false;
    try {
      await api.writeExternal(p, 'WRITE_EXT_OK');
      const rb = await api.readFile(p);
      ok = rb.content.includes('WRITE_EXT_OK');
    } catch (err) {
      ok = false;
    }
    return !packed && ok ? true : 'packed=' + packed + ',ok=' + ok;
  });

  // renameExternalSave：外部已打开文件重命名后，新路径保存仍放行（修复前：批准集合仍指向旧路径，
  // fs:write-file 以「路径不在当前工作目录内」拒绝，自动保存持续失败）
  await step('renameExternalSave', async () => {
    const old = extRoot + '/note.md';
    const renamed = extRoot + '/note-renamed.md';
    const tab = app.editor.findTabByPath(old);
    if (tab) app.editor.closeTab(tab); // 关掉旧标签，避免悬空引用干扰
    await api.rename(old, 'note-renamed.md');
    let saved = false;
    let errMsg = '';
    try {
      saved = (await api.writeFile(renamed, '# 外部笔记（重命名后保存）\\n')) === true;
    } catch (err) {
      errMsg = String(err && err.message ? err.message : err);
    }
    await api.rename(renamed, 'note.md'); // 还原文件名，保证重复运行
    return saved ? true : 'saved=' + saved + ',err=' + errMsg;
  });

  // minifySanity（P5）：bundle 可加载、window.__app 与核心接口存在（esbuild minify 不改属性名，接口面应完好）
  await step('minifySanity', async () => {
    const a = window.__app;
    return !!a && typeof a.editor.openFile === 'function' && typeof a.preview.render === 'function' && typeof a.preview.refreshMermaid === 'function' && typeof a.applyTheme === 'function' && !!document.querySelector('#preview-content')
      ? true
      : 'app=' + !!a;
  });

  // ================= v0.1.45 中期批次冒烟（P4/P8/P9/P10/小项） =================

  // pythonBatch（P4）：2000 行输出经主进程聚合（~60ms/4KB）+ 渲染端批渲染 →
  // 输出完整（B1999 与结束标记均在）、退出码 0、DOM span 数不超 3000 上限
  await step('pythonBatch', async () => {
    const pyFile = root + '/py-batch.py';
    await api.writeFile(pyFile, 'for i in range(2000):\\n    print("B" + str(i))\\nprint("BATCH_END")\\n');
    const pys = await api.detectPython();
    const pyExe = pys.find((p) => /\.exe$/i.test(p)) || pys[0];
    await app.editor.openFile(pyFile);
    document.querySelector('#py-output').innerHTML = '';
    const exitInfo = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const onOut = (d) => { out += d.data; };
      const onExit = (d) => {
        if (done) return;
        done = true;
        resolve({ out, code: d.code });
      };
      window.api.onPythonOutput(onOut);
      window.api.onPythonExit(onExit);
      window.api.runPython(pyFile, pyExe);
      setTimeout(() => { if (!done) { done = true; resolve({ out, code: null, timeout: true }); } }, 20000);
    });
    const domOut = document.querySelector('#py-output').textContent;
    const spanCount = document.querySelector('#py-output').childElementCount;
    const full = exitInfo.out.includes('B1999') && exitInfo.out.includes('BATCH_END') && exitInfo.code === 0;
    const domFull = domOut.includes('B1999') && domOut.includes('BATCH_END');
    return full && domFull && spanCount <= 3000
      ? true
      : 'code=' + exitInfo.code + ',len=' + exitInfo.out.length + ',spans=' + spanCount + ',dom=' + domFull;
  });

  // restoreParallel（P9）：6 标签并发 3 路恢复 → 标签顺序 = 会话顺序（reorderTabs 保持）、
  // 活动标签 = active 下标、pinned 生效
  await step('restoreParallel', async () => {
    await app.editor.closeAll();
    const ps = [];
    for (let i = 1; i <= 6; i++) {
      const p = root + '/rp' + i + '.md';
      await api.writeFile(p, '# RP' + i + '\\n内容' + i);
      ps.push(p);
    }
    await api.setSettings({ lastSession: { paths: ps, active: 4, pinned: [1] } });
    app.state.settings = await api.getSettings();
    await window.__app.session.restore();
    await new Promise((r) => setTimeout(r, 300));
    const sess = app.editor.getSession();
    const act = app.editor.getActiveTab();
    const orderOk = sess.paths.length === 6 && sess.paths.every((p, i) => p === ps[i]);
    const actOk = !!act && act.path === ps[4];
    const pinTab = app.editor.findTabByPath(ps[1]);
    const pinOk = !!pinTab && pinTab.pinned;
    await app.editor.closeAll();
    await api.setSettings({ lastSession: null });
    app.state.settings = await api.getSettings();
    return orderOk && actOk && pinOk
      ? true
      : 'order=' + orderOk + ',act=' + (act && act.path) + ',pin=' + pinOk;
  });

  // findDomReuse（P10）：同查询重复触发（文档未变）→ 结果行数与首行内容一致；
  // Enter 跳转路径只切 current 高亮不重建列表（行数不变）
  await step('findDomReuse', async () => {
    let content = '';
    for (let i = 0; i < 50; i++) content += '第' + i + '行 needle 内容\\n';
    await api.writeFile(root + '/find-dom.md', content);
    await app.editor.openFile(root + '/find-dom.md');
    const input = document.querySelector('#find-input');
    input.value = 'needle';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    const rows1 = Array.from(document.querySelectorAll('#find-results .find-result'));
    const first1 = rows1[0] ? rows1[0].textContent : '';
    const cnt1 = document.querySelector('#find-count').textContent;
    input.dispatchEvent(new Event('input')); // 同查询再触发（无文档变更）
    await new Promise((r) => setTimeout(r, 150));
    const rows2 = Array.from(document.querySelectorAll('#find-results .find-result'));
    const first2 = rows2[0] ? rows2[0].textContent : '';
    // Enter 导航 → jumpTo 只切 current 高亮，不应全量重建列表
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const rows3 = Array.from(document.querySelectorAll('#find-results .find-result'));
    return rows1.length === 50 && rows2.length === 50 && rows3.length === 50 && first1 === first2 && cnt1.includes('50')
      ? true
      : 'r1=' + rows1.length + ',r2=' + rows2.length + ',r3=' + rows3.length + ',f=' + (first1 === first2) + ',cnt=' + cnt1;
  });

  // computedStyleTab（小项/L2 补断言）：.tab 计算值 —— height 非 daisyUI 泄漏的 40px 固定值、
  // justify-content flex-start、text-align left（宽松：接受 auto/normal/start 等价写法）
  await step('computedStyleTab', async () => {
    await api.writeFile(root + '/cs-tab.md', '# 标签样式\\n内容');
    await app.editor.openFile(root + '/cs-tab.md');
    await new Promise((r) => setTimeout(r, 200));
    const tab = document.querySelector('#tabs .tab');
    if (!tab) return 'no .tab';
    const cs = getComputedStyle(tab);
    const h = cs.height;
    const jc = cs.justifyContent;
    const ta = cs.textAlign;
    // height：auto 语义下 Chromium 可能返回已使用 px —— 断言「非 daisyUI 固定 40px」即可捕获 L2 回归
    const hOk = h === 'auto' || h === 'normal' || (parseFloat(h) > 0 && parseFloat(h) < 40);
    const jcOk = jc === 'flex-start' || jc === 'normal' || jc === 'start';
    const taOk = ta === 'left' || ta === 'start';
    return hOk && jcOk && taOk ? true : 'h=' + h + ',jc=' + jc + ',ta=' + ta;
  });

  // computedStyleTheme（小项/L4+L5 补断言）：滚动条 thumb 色非硬编码 #cbd5e1；
  // 暗色主题下 blockquote 背景非浅色硬编码 #f0fbf9（宽松）
  await step('computedStyleTheme', async () => {
    const thumb = getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb').backgroundColor;
    const thumbOk = thumb !== 'rgb(203, 213, 225)'; // #cbd5e1 已改 color-mix(in oklab, var(--mh-text) 35%, transparent)
    await api.writeFile(root + '/cs-theme.md', '# CT\\n\\n> 引用块内容\\n');
    await app.editor.openFile(root + '/cs-theme.md');
    app.preview.setMode('split');
    app.applyTheme('night');
    await new Promise((r) => setTimeout(r, 600));
    const bq = document.querySelector('#preview-content .markdown-body blockquote');
    const bg = bq ? getComputedStyle(bq).backgroundColor : '';
    const bgOk = bg !== 'rgb(240, 251, 249)'; // #f0fbf9 已改 color-mix 主题令牌（L5）
    await setTheme('markhunter-classic');
    return thumbOk && bgOk ? true : 'thumb=' + thumb + ',bg=' + bg;
  });

  // mermaidCacheId（P2 补强）：同图两次出现（第二次为缓存命中复用 SVG）→ 两实例内部
  // id（defs/marker/gradient）无冲突（宽松：无 id 可冲突即视为通过）
  await step('mermaidCacheId', async () => {
    const fence = mmFence();
    await api.writeFile(root + '/mm-id.md', '# ID\\n\\n' + fence + 'mermaid\\ngraph TD\\n  I1-->I2\\n' + fence + '\\n\\n' + fence + 'mermaid\\ngraph TD\\n  I1-->I2\\n' + fence + '\\n');
    await app.editor.openFile(root + '/mm-id.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 1400));
    const wraps = document.querySelectorAll('#preview-content .mermaid-wrap');
    if (wraps.length < 2) return 'wraps=' + wraps.length;
    const ids1 = Array.from(wraps[0].querySelectorAll('[id]')).map((el) => el.id);
    const ids2 = Array.from(wraps[1].querySelectorAll('[id]')).map((el) => el.id);
    if (ids1.length === 0 && ids2.length === 0) return true; // 无内部 id，无从冲突
    const dup = ids1.filter((id) => ids2.includes(id));
    return dup.length === 0 ? true : 'dup=' + dup.slice(0, 6).join(',') + ',total=' + dup.length;
  });

  // ================= v0.1.45 中期批次冒烟（P6/P7/P5 拆包） =================

  // searchCancel（P6）：立即取消可能先于/后于完成到达，两种结果都接受（宽松）；
  // 关键断言：取消后 worker 仍可用，下一次搜索正常返回结果（进程未被打死）。
  // 用独立夹具文件 + 唯一词元（cancelprobe）保证匹配数确定（root 中 'hello' 的匹配源
  // hello.md 已在前面步骤删除，现存仅 indent.md 1 处，不能作为固定断言基准）
  await step('searchCancel', async () => {
    await api.writeFile(root + '/search-cancel.md', 'cancelprobe alpha\\ncancelprobe beta');
    const p = window.api.globalSearch(root, 'cancelprobe');
    window.api.globalSearchCancel();
    let first = 'ok';
    try {
      const r = await p;
      first = Array.isArray(r) ? 'ok' : 'bad';
    } catch (e) {
      first = 'cancelled';
    }
    const r2 = await window.api.globalSearch(root, 'cancelprobe');
    const second = Array.isArray(r2) && r2.length === 2;
    return second && (first === 'ok' || first === 'cancelled')
      ? true
      : 'first=' + first + ',second=' + second + ',len=' + (Array.isArray(r2) ? r2.length : 'n/a');
  });

  // largeFileChunk（P7）：>4MB 文件分段打开 —— 初始 doc 长度 < 文件大小（仅首段 2MB + 占位标记），
  // 滚动到底部触发预读后 doc 长度增长（可滚动加载后续段）；超上限仍拒绝由 tooLarge 用例覆盖
  await step('largeFileChunk', async () => {
    const bigPath = root + '/large-chunk.md';
    const SIZE = 6 * 1024 * 1024; // 6MB > 4MB 阈值
    await api.writeFile(bigPath, '# 大文件分段\\n' + 'x'.repeat(SIZE));
    const st = await api.stat(bigPath);
    const tab = await app.editor.openFile(bigPath);
    await new Promise((r) => setTimeout(r, 600));
    const view = app.editor.getView();
    const initialLen = view.state.doc.length;
    const chunked = !!tab && tab.kind === 'chunked' && initialLen < st.size;
    // 模拟滚动到底部：设置 scrollTop 后派发 scroll 事件触发预读监听。
    // 轮询等待增长（最长 ~13s，增长即停）：全量冒烟高负载下，2MB 单行换行文档的首次
    // 追加分发（CM 高度重算）可能远超固定等待；每轮重设 scrollTop 并重发 scroll，
    // 模拟用户停在底部（追加完成后链式触发下一段预读）
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    let afterLen = view.state.doc.length;
    for (let i = 0; i < 26 && afterLen === initialLen; i++) {
      await new Promise((r) => setTimeout(r, 500));
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      afterLen = view.state.doc.length;
    }
    const grew = afterLen > initialLen;
    const tabStill = !!app.editor.findTabByPath(bigPath);
    if (tabStill) app.editor.closeTab(app.editor.findTabByPath(bigPath));
    await api.remove(bigPath, false);
    return chunked && grew
      ? true
      : 'chunked=' + chunked + ',init=' + initialLen + ',after=' + afterLen + ',size=' + st.size;
  });

  // chunkedSaveClean（Python 运行前置保存路径）：分段标签编辑后经 saveNow 保存 ——
  // 补齐剩余分段、剥离 MH-CHUNKED 占位标记、内容无截断（修复前 python.run 直接写 doc.toString()
  // 会把标记写进 .py 且截断未加载部分）
  await step('chunkedSaveClean', async () => {
    const bigPath = root + '/large-save.md';
    const TAIL = '\\nTAIL_MARKER_9X';
    await api.writeFile(bigPath, '# 分段保存\\n' + 'y'.repeat(5 * 1024 * 1024));
    const before = await api.readFile(bigPath);
    const tab = await app.editor.openFile(bigPath);
    await new Promise((r) => setTimeout(r, 600));
    if (!tab || tab.kind !== 'chunked') {
      if (tab) app.editor.closeTab(tab);
      await api.remove(bigPath, false);
      return 'not-chunked';
    }
    const view = app.editor.getView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: TAIL } });
    await new Promise((r) => setTimeout(r, 100));
    const ok = (await app.editor.saveNow()) === true; // 返回 true/false（写盘成败）
    const after = await api.readFile(bigPath);
    const noMarker = !after.content.includes('MH-CHUNKED');
    const hasTail = after.content.includes('TAIL_MARKER_9X');
    const noTrunc = after.content.length === before.content.length + TAIL.length;
    const t2 = app.editor.findTabByPath(bigPath);
    if (t2) app.editor.closeTab(t2);
    await api.remove(bigPath, false);
    return ok && noMarker && hasTail && noTrunc
      ? true
      : 'ok=' + ok + ',noMarker=' + noMarker + ',hasTail=' + hasTail + ',len=' + after.content.length + '/' + (before.content.length + TAIL.length);
  });

  // ================= v0.3.0 Phase 0：高危缺陷回归 =================

  // chunkUndoNoTruncate：分段预读/程序化重载不进撤销历史 —— Ctrl+Z 不得缩短文档。
  // 修复前：撤销会撤掉刚预读的一整段，而 chunk.complete 仍为 true（不会补读）→
  // 800ms 后自动保存把文件截断（实测 5.39MB → 2.10MB）。
  await step('chunkUndoNoTruncate', async () => {
    const p = root + '/undo-chunk.txt';
    const lines = [];
    for (let i = 0; i < 100000; i++) lines.push('row-' + i + '-padding-padding-padding-padding-padding-pad');
    await api.writeFile(p, lines.join('\\n'));
    const st0 = await api.stat(p);
    const tab = await app.editor.openFile(p);
    await app.editor.scrollToBottom(); // 触发 ensureFullyLoaded（补读全部段）
    await new Promise((r) => setTimeout(r, 700));
    const view = app.editor.getView();
    const before = view.state.doc.length;
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, keyCode: 90, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
    const after = view.state.doc.length;
    await new Promise((r) => setTimeout(r, 1800)); // 等自动保存落盘
    const st1 = await api.stat(p);
    const t2 = app.editor.findTabByPath(p);
    if (t2) app.editor.closeTab(t2);
    await api.remove(p, false);
    const okKind = !!tab && tab.kind === 'chunked';
    return okKind && after >= before && st1.size >= st0.size
      ? true
      : 'kind=' + (tab && tab.kind) + ',doc=' + before + '→' + after + ',size=' + st0.size + '→' + st1.size;
  });

  // crlfPreserve：CRLF 文件保存后行尾保持 CRLF；LF 文件不得被写成 CRLF。
  // 修复前：CM6 把 CRLF 归一化为 LF，任何一次保存都会把整个文件的行尾改掉。
  await step('crlfPreserve', async () => {
    const crlfPath = root + '/crlf.txt';
    await api.writeFile(crlfPath, 'line1\\r\\nline2\\r\\nline3\\r\\n');
    await app.editor.openFile(crlfPath);
    await new Promise((r) => setTimeout(r, 200));
    const v1 = app.editor.getView();
    v1.dispatch({ changes: { from: 0, insert: 'X' } });
    await new Promise((r) => setTimeout(r, 1600));
    const c1 = (await api.readFile(crlfPath)).content;

    const lfPath = root + '/lf.txt';
    await api.writeFile(lfPath, 'a\\nb\\nc\\n');
    await app.editor.openFile(lfPath);
    await new Promise((r) => setTimeout(r, 200));
    const v2 = app.editor.getView();
    v2.dispatch({ changes: { from: 0, insert: 'Y' } });
    await new Promise((r) => setTimeout(r, 1600));
    const c2 = (await api.readFile(lfPath)).content;

    const t1 = app.editor.findTabByPath(crlfPath);
    if (t1) app.editor.closeTab(t1);
    const t2 = app.editor.findTabByPath(lfPath);
    if (t2) app.editor.closeTab(t2);
    await api.remove(crlfPath, false);
    await api.remove(lfPath, false);
    return c1.includes('\\r\\n') && c1.includes('Xline1') && !c2.includes('\\r')
      ? true
      : 'crlf=' + JSON.stringify(c1) + ',lf=' + JSON.stringify(c2);
  });

  // deleteNoResurrect：文件被删除后关闭标签不得把文件写回（save:false）；
  // 普通关闭仍必须保存（回归保护）。修复前删除会"复活"（dirty 标签被自动保存写回）。
  await step('deleteNoResurrect', async () => {
    const p = root + '/resurrect.txt';
    await api.writeFile(p, 'v1\\n');
    await app.editor.openFile(p);
    await new Promise((r) => setTimeout(r, 200));
    const v = app.editor.getView();
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'DIRTY\\n' } });
    await api.remove(p, false); // 主进程删除
    app.editor.closeByPath(p, false, { save: false });
    await new Promise((r) => setTimeout(r, 1600));
    const stillGone = await api.stat(p).then(() => false, () => true);

    const q = root + '/normal-close.txt';
    await api.writeFile(q, 'n1\\n');
    await app.editor.openFile(q);
    await new Promise((r) => setTimeout(r, 200));
    const v2 = app.editor.getView();
    v2.dispatch({ changes: { from: v2.state.doc.length, insert: 'N2\\n' } });
    await app.editor.closeByPath(q, false); // 普通关闭：应保存
    await new Promise((r) => setTimeout(r, 1600));
    const c = (await api.readFile(q)).content;
    await api.remove(q, false);
    return stillGone && c.includes('N2') ? true : 'gone=' + stillGone + ',normalClose=' + JSON.stringify(c);
  });

  // pyOutputBigBatch：单批超过 3000 行的输出不再整批丢失。
  // 修复前 removeChild(null) 抛 TypeError → 面板只剩命令回显/退出两行（实测 6000 行 → 22 字符）。
  await step('pyOutputBigBatch', async () => {
    const pyFile = root + '/py-big-batch.py';
    await api.writeFile(pyFile, 'for i in range(6000):\\n    print(i)\\n');
    const pys = await api.detectPython();
    const pyExe = pys.find((p) => /\\.exe$/i.test(p)) || pys[0];
    await app.editor.openFile(pyFile);
    document.querySelector('#py-output').innerHTML = '';
    await new Promise((resolve) => {
      let done = false;
      window.api.onPythonExit(() => { if (!done) { done = true; resolve(); } });
      window.api.runPython(pyFile, pyExe);
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 25000);
    });
    await new Promise((r) => setTimeout(r, 500));
    const el = document.querySelector('#py-output');
    const spans = el.childElementCount;
    const txt = el.textContent || '';
    await api.remove(pyFile, false);
    return spans > 1000 && txt.includes('5999') ? true : 'spans=' + spans + ',len=' + txt.length + ',tail=' + txt.slice(-20);
  });

  // pyOutputUtf8：管道分块边界不得切出替换符（StringDecoder 流式解码）。
  await step('pyOutputUtf8', async () => {
    const pyFile = root + '/py-cn-big.py';
    await api.writeFile(pyFile, 'import sys\\nsys.stdout.write("中" * 100000)\\nsys.stdout.write("\\\\n")\\n');
    const pys = await api.detectPython();
    const pyExe = pys.find((p) => /\\.exe$/i.test(p)) || pys[0];
    await app.editor.openFile(pyFile);
    document.querySelector('#py-output').innerHTML = '';
    await new Promise((resolve) => {
      let done = false;
      window.api.onPythonExit(() => { if (!done) { done = true; resolve(); } });
      window.api.runPython(pyFile, pyExe);
      setTimeout(() => { if (!done) { done = true; resolve(); } }, 25000);
    });
    await new Promise((r) => setTimeout(r, 500));
    const txt = document.querySelector('#py-output').textContent || '';
    await api.remove(pyFile, false);
    const fffd = (txt.match(/\\uFFFD/g) || []).length;
    return fffd === 0 && txt.includes('中') ? true : 'fffd=' + fffd + ',len=' + txt.length;
  });

  // pyKillAfterRestart：连续启动两次后仍能终止新进程。
  // 修复前旧进程 close 回调无条件清空 currentProc → python:kill 返回 false（终止按钮无效）、
  // 面板状态被旧进程退出事件覆盖（显示"已退出"但实际仍在跑）。
  await step('pyKillAfterRestart', async () => {
    const a = root + '/kill-a.py';
    const b = root + '/kill-b.py';
    await api.writeFile(a, 'import time\\ntime.sleep(2)\\n');
    await api.writeFile(b, 'import time\\ntime.sleep(8)\\n');
    const pys = await api.detectPython();
    const pyExe = pys.find((p) => /\\.exe$/i.test(p)) || pys[0];
    await app.editor.openFile(a);
    await api.runPython(a, pyExe);
    await new Promise((r) => setTimeout(r, 400));
    await app.editor.openFile(b);
    await api.runPython(b, pyExe);
    await new Promise((r) => setTimeout(r, 1300));
    const running = (document.getElementById('py-status').textContent || '').includes('运行中');
    const killed = await api.killPython();
    await new Promise((r) => setTimeout(r, 800));
    await api.remove(a, false);
    await api.remove(b, false);
    return killed === true && running ? true : 'killed=' + killed + ',running=' + running;
  });

  // diffHugeInsert：超大块新增不再抛 RangeError（旧实现 push(...15 万行) 触发 V8 参数上限 →
  // 对比区空白且标签栏不刷新，activeTab 已切到该 diff 标签）。
  await step('diffHugeInsert', async () => {
    const lines = [];
    for (let i = 0; i < 150000; i++) lines.push('line ' + i);
    let thrown = null;
    let tab = null;
    try {
      tab = app.editor.openDiffTab({ leftLabel: 'empty', leftContent: '', rightLabel: 'big', rightContent: lines.join('\\n') });
    } catch (e) {
      thrown = String((e && e.message) || e);
    }
    await new Promise((r) => setTimeout(r, 700));
    const hostLen = (document.getElementById('diff-host').innerHTML || '').length;
    const rows = tab && tab._model ? tab._model.rows.length : 0;
    app.editor.closeAll();
    return !thrown && hostLen > 1000 && rows === 150000 ? true : 'thrown=' + thrown + ',host=' + hostLen + ',rows=' + rows;
  });

  // rcNestedReplace：右键/启动指定目录（fromLaunch）与已打开根存在包含关系时不再直接拒绝 ——
  // 目标落在已打开根内 → 激活该根并在树中定位；非 fromLaunch（手动添加）仍保持"嵌套拒绝"语义。
  await step('rcNestedReplace', async () => {
    await api.create(root, 'rc-nested', 'dir'); // 测试根内的子目录（已有根 = 测试根）
    const sub = root + '/rc-nested';
    const before = app.state.sidebarRoots.length;
    const ok = await app.openDirFromPath(sub, { fromLaunch: true });
    const after = app.state.sidebarRoots.length;
    const activeOk = !!app.state.rootDir && app.state.rootDir.toLowerCase() === root.toLowerCase();
    const rejected = await app.openDirFromPath(sub); // 手动路径：仍应拒绝（既有语义不变）
    const sameRoot = !!app.state.rootDir && app.state.rootDir.toLowerCase() === root.toLowerCase();
    await app.openDirFromPath(root);
    await api.remove(sub, true);
    return ok === true && after === before && activeOk && rejected === false && sameRoot
      ? true
      : 'ok=' + ok + ',roots=' + before + '→' + after + ',active=' + activeOk + ',rejected=' + rejected + ',same=' + sameRoot;
  });

  // findReplace（v0.1.47）：底部查找替换 —— 大小写不敏感；替换当前（选中处）+ 全部替换
  await step('findReplace', async () => {
    await api.writeFile(root + '/replace-me.md', 'foo abc foo\\nnope\\nFOO tail foo');
    const tab = await app.editor.openFile(root + '/replace-me.md');
    if (!tab) return 'open failed';
    app.find.setQuery('foo'); // 跳到第一处（current=0）
    const cntOk = (document.getElementById('find-count').textContent || '').includes('4'); // foo/FOO 共 4 处（大小写不敏感）
    document.getElementById('replace-input').value = 'BAR';
    const one = app.find.replaceCurrent(); // 替换第一处
    const doc1 = app.editor.getView().state.doc.toString();
    const afterOne = doc1 === 'BAR abc foo\\nnope\\nFOO tail foo';
    const n = app.find.replaceAll(); // 剩余 3 处全替换
    const doc2 = app.editor.getView().state.doc.toString();
    const afterAll = doc2 === 'BAR abc BAR\\nnope\\nBAR tail BAR';
    app.find.clearSearch();
    const t = app.editor.findTabByPath(root + '/replace-me.md');
    if (t) app.editor.closeTab(t);
    await api.remove(root + '/replace-me.md', false);
    return cntOk && afterOne && one === 1 && n === 3 && afterAll
      ? true
      : 'cnt=' + cntOk + ',one=' + one + '/' + afterOne + ',n=' + n + '/' + afterAll + ',doc=' + doc2;
  });

  // globalReplace（v0.1.47）：全局搜索「全部替换」—— 结果文件整文大小写不敏感替换 + 自动重搜
  await step('globalReplace', async () => {
    await api.writeFile(root + '/gr-a.md', 'alpha ZZFOOZZ beta\\nZZFOOZZ2');
    await api.writeFile(root + '/gr-b.txt', 'ZZFOOZZ ZZFOOZZ ZZFOOZZ');
    document.getElementById('gs-input').value = 'ZZFOOZZ';
    await app.globalSearch.run();
    const cntTxt = (document.getElementById('gs-count').textContent || '');
    // 搜索语义为每行仅计首处匹配：gr-a 2 行各 1 处 + gr-b 1 行 1 处 = 3（替换是整文全量，比列表多）
    const found = cntTxt.includes('3');
    document.getElementById('gs-replace-input').value = 'QUX';
    const ok = await app.globalSearch.replaceAll(true); // force：跳过原生确认框
    const a = await api.readFile(root + '/gr-a.md');
    const b = await api.readFile(root + '/gr-b.txt');
    const okA = a.content === 'alpha QUX beta\\nQUX2';
    const okB = b.content === 'QUX QUX QUX';
    const none = (document.getElementById('gs-results').textContent || '').includes('没有找到'); // 替换后自动重搜应无匹配
    document.getElementById('gs-input').value = '';
    await api.remove(root + '/gr-a.md', false);
    await api.remove(root + '/gr-b.txt', false);
    return ok && found && okA && okB && none
      ? true
      : 'ok=' + ok + ',cnt=' + cntTxt + ',a=' + okA + ',b=' + okB + ',none=' + none;
  });

  // mermaidChunkLoaded（P5）：mermaid 拆包后，含 mermaid 的文档触发 chunk 动态加载 →
  // window.__mermaid 已就绪且 SVG 正常渲染（chunk 链路可用）
  await step('mermaidChunkLoaded', async () => {
    const fence = mmFence();
    await api.writeFile(root + '/mm-chunk.md', '# MC\\n\\n' + fence + 'mermaid\\ngraph TD\\n  C1-->C2\\n' + fence + '\\n');
    await app.editor.openFile(root + '/mm-chunk.md');
    app.preview.setMode('split');
    await new Promise((r) => setTimeout(r, 2500)); // 等 chunk 动态加载 + 异步渲染
    const svg = document.querySelector('#preview-content .mermaid-wrap svg');
    const err = document.querySelector('#preview-content .mermaid-error');
    return typeof window.__mermaid === 'object' && !!svg && !err
      ? true
      : 'mermaid=' + (typeof window.__mermaid) + ',svg=' + !!svg + ',err=' + (err ? err.textContent : 'none');
  });

  // ============ v0.1.49 阶段一：可靠性压测 + 大文件分层（材料由主进程预置在 build/ 下） ============

  // bigFileSetup：大文件上限 50MB → 4096MB（块内用例共用；Teardown 恢复）
  await step('bigFileSetup', async () => {
    await api.setSettings({ maxFileSizeMB: 4096 });
    app.state.settings = await api.getSettings();
    return app.state.settings.maxFileSizeMB === 4096 ? true : 'set failed';
  });

  // stressTabs100：100 标签打开耗时 / 切换 / 键入延迟 / 堆内存（信息型 + 软断言；上限报告数据源）
  await step('stressTabs100', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      await api.writeFile(root + '/stress-f' + i + '.txt', 'stress file ' + i + ' ' + 'x'.repeat(200));
    }
    const tFiles = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) await app.editor.openFile(root + '/stress-f' + i + '.txt');
    const tOpen = performance.now() - t1;
    await app.editor.openFile(root + '/stress-f0.txt'); // 切回首标签
    await new Promise((r) => setTimeout(r, 300));
    const view = app.editor.getView();
    const t2 = performance.now();
    for (let k = 0; k < 20; k++) view.dispatch({ changes: { from: view.state.doc.length, insert: 'y' } });
    const avgInput = (performance.now() - t2) / 20;
    const heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
    await app.editor.closeAll();
    console.log('[stress-tabs] create100=' + Math.round(tFiles) + 'ms open100=' + Math.round(tOpen) + 'ms avgInput=' + avgInput.toFixed(1) + 'ms heap=' + heapMB + 'MB');
    const ok = tOpen < 60000 && avgInput < 400;
    return ok ? true : 'open=' + Math.round(tOpen) + 'ms,avgInput=' + avgInput.toFixed(1) + 'ms（超阈值）';
  });

  // stressSessionFull：200 标签会话满档恢复（顺序/数量正确；上限 200、并发 6 的验证，v0.2.1 满档实测）
  await step('stressSessionFull', async () => {
    const paths = [];
    for (let i = 0; i < 200; i++) {
      const p = root + '/stress-s' + i + '.txt';
      await api.writeFile(p, 'session stress ' + i);
      paths.push(p);
    }
    await api.setSettings({ lastSession: { paths, active: 0, pinned: [] } });
    app.state.settings = await api.getSettings();
    const t0 = performance.now();
    await app.session.restore();
    const tRestore = performance.now() - t0;
    const s = app.editor.getSession();
    const countOk = s.paths.length === 200;
    const orderOk = s.paths[0] === paths[0] && s.paths[199] === paths[199];
    console.log('[stress-session] restore200=' + Math.round(tRestore) + 'ms count=' + s.paths.length);
    await app.editor.closeAll();
    await api.setSettings({ lastSession: null });
    app.state.settings = await api.getSettings();
    for (let i = 0; i < 200; i++) await api.remove(root + '/stress-s' + i + '.txt', false);
    return countOk && orderOk ? true : 'count=' + s.paths.length + ',order=' + orderOk;
  });

  // stressLarge3：两个 60MB 分段大文件同开 + 切换 + 滚动预读（内存信息型）
  await step('stressLarge3', async () => {
    const a = await app.editor.openFile(root + '/build/big-a.bin');
    const b = await app.editor.openFile(root + '/build/big-b.bin');
    const kinds = a && a.kind === 'chunked' && b && b.kind === 'chunked';
    await app.editor.openFile(root + '/build/big-a.bin'); // 切回 a
    await new Promise((r) => setTimeout(r, 400));
    const view = app.editor.getView();
    const initLen = view.state.doc.length;
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    let grew = false;
    for (let i = 0; i < 16 && !grew; i++) {
      await new Promise((r) => setTimeout(r, 500));
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      grew = view.state.doc.length > initLen;
    }
    const heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1;
    await app.editor.closeAll();
    console.log('[stress-large3] 2x60MB heap=' + heapMB + 'MB');
    return kinds && grew ? true : 'kinds=' + kinds + ',grew=' + grew;
  });

  // boundaryViewer（v0.7.0 口径）：3.9GB 走「虚拟滚动查看器」（连续滚动 + 任意位置定位）、
  // 512MB 同档（门槛降至 256MB，分页查看器退役）、4.1GB 超上限拒绝。
  await step('boundaryViewer', async () => {
    const tab = await app.editor.openFile(root + '/build/bd-3g9.bin');
    if (tab && tab.kind === 'huge') {
      const hv = tab.huge;
      let st0 = hv ? hv.getState() : null;
      for (let i = 0; i < 25 && !(st0 && st0.renderedRows > 0); i++) { await new Promise((r) => setTimeout(r, 400)); st0 = hv ? hv.getState() : null; }
      const half = hv ? await hv.scrollToPercent(50) : 0;
      const st1 = hv ? hv.getState() : null;
      const linesOk = !!st0 && st0.lines > 0;
      // 行数极少（全 NUL 稀疏夹具只有 1~2 行）时没有"中点"可校验 → 放行
      const midOk = !!st0 && linesOk && (st0.lines <= 2 || Math.abs(half - st0.lines / 2) < st0.lines * 0.05);
      const rowsOk = !!st1 && st1.renderedRows > 0 && st1.renderedRows < 400;
      const jumpOk = hv ? (await hv.gotoLine(Math.max(1, Math.round((st0 ? st0.lines : 1) * 0.9)))) > 0 : false;
      const t512 = await app.editor.openFile(root + '/build/bd-512mb.bin');
      const ok512 = t512 && t512.kind === 'huge'; // v0.7.0：>256MB 全走虚拟滚动（不再分页）
      // 4.1GB 超上限拒绝（alertBox 弹窗需关闭）
      const t41 = await app.editor.openFile(root + '/build/bd-4g1.bin');
      const rejected = t41 === null;
      const mask = document.getElementById('modal-mask');
      const modalShown = !mask.classList.contains('hidden');
      const btn = document.querySelector('#modal-actions .tbtn');
      if (btn) btn.click();
      await app.editor.closeAll();
      return linesOk && midOk && rowsOk && jumpOk && ok512 && rejected && modalShown
        ? true
        : 'huge lines=' + (st0 && st0.lines) + ',mid=' + half + ',rows=' + (st1 && st1.renderedRows) + ',jump=' + jumpOk + ',512=' + ok512 + ',rej=' + rejected + '/' + modalShown;
    }
    await app.editor.closeAll();
    return 'kind=' + (tab && tab.kind);
  });

  // viewerRegionEdit → hugeEditDefaultOn（v0.7.0 语义改写）：280MB 文本文件走虚拟滚动查看器，
  // **首次键入自动进入编辑**（无需点「✎ 启用编辑」；本键被消费用于开启，下一次键入落字）。
  // 视口内编辑 + 保存的写盘校验由 hugeEditChunkCoW / hugeEditSaveAtomic 覆盖（同夹具副本）。
  await step('viewerRegionEdit', async () => {
    const path = root + '/build/bd-280mb.bin';
    const tab = await app.editor.openFile(path);
    if (!tab || tab.kind !== 'huge') {
      await app.editor.closeAll();
      return 'kind=' + (tab && tab.kind);
    }
    const hv = tab.huge;
    let st = null;
    for (let i = 0; i < 20 && !(st && st.indexed); i++) {
      await new Promise((r) => setTimeout(r, 300));
      st = hv ? hv.getState() : null;
    }
    const initiallyOff = !!st && st.editable === false; // 打开时未进入编辑（等首次键入）
    // 真实键盘路径：第一次键入触发自动开启（被消费），第二次键入落字
    const rootEl = hv ? document.querySelector('.huge-view') : null;
    if (!rootEl) { await app.editor.closeAll(); return 'no root'; }
    rootEl.focus();
    rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    let st2 = null;
    for (let i = 0; i < 20 && !(st2 && st2.editable === true); i++) {
      await new Promise((r) => setTimeout(r, 300));
      st2 = hv ? hv.getState() : null;
    }
    const autoOn = !!st2 && st2.editable === true && st2.docEditable === true;
    rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 600));
    const st3 = hv ? hv.getState() : null;
    const typed = !!st3 && st3.dirty === true;
    // 保存落盘再继续（脏着的 huge 标签直接关闭会把块表留在崩溃恢复区，污染下游
    // hugeRecover* 用例的条目数/清场断言；280MB 原子重写几秒，可接受）
    if (typed) await hv.save();
    const off = hv ? await hv.setEditable(false) : false;
    const stOff = hv ? hv.getState() : null;
    const backOn = hv ? await hv.setEditable(true) : true;
    await app.editor.closeAll();
    return initiallyOff && autoOn && typed && off === false && stOff && stOff.editable === false && backOn === true
      ? true
      : 'initOff=' + initiallyOff + ',auto=' + autoOn + ',typed=' + typed + ',off=' + off + ',editableOff=' + (stOff && stOff.editable) + ',back=' + backOn;
  });

  // viewerReadOnly → hugeReadOnlyBinary（v0.7.0 语义改写）：二进制大文件（全 NUL 的 3.9GB 稀疏
  // 夹具）即使**键入触发自动开启编辑**也必须保持只读（主进程 editable=false），且给出原因。
  await step('viewerReadOnly', async () => {
    const path = root + '/build/bd-3g9.bin';
    const tab = await app.editor.openFile(path);
    if (!tab || tab.kind !== 'huge') {
      await app.editor.closeAll();
      return 'kind=' + (tab && tab.kind);
    }
    const hv = tab.huge;
    let st = null;
    for (let i = 0; i < 20 && !(st && st.indexed); i++) {
      await new Promise((r) => setTimeout(r, 300));
      st = hv ? hv.getState() : null;
    }
    const before = !!st && st.editable === false;
    // 键入尝试自动开启：二进制文件必须保持只读
    const rootEl = document.querySelector('.huge-view');
    if (rootEl) {
      rootEl.focus();
      rootEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 800));
    const st2 = hv ? hv.getState() : null;
    const stayOff = !!st2 && st2.editable === false;
    const on = hv ? await hv.setEditable(true) : true; // 显式尝试同样被拒 + 有原因
    const st3 = hv ? hv.getState() : null;
    await app.editor.closeAll();
    return before && stayOff && on === false && !!st3 && !!st3.editableReason
      ? true
      : 'before=' + before + ',stay=' + stayOff + ',on=' + on + ',reason=' + (st3 && st3.editableReason);
  });

  // bigSearchStream：15MB 文件流式搜索（原 >10MB 整档跳过；行号全局精确）
  // v0.4.0 大文件线：行索引 / 索引缓存 / 虚拟滚动查看器（连续滚动 + CodeMirror 让位）/ 大文件搜索原生字节快路径
  await step('hugeIndexCold', async () => {
    const p = root + '/build/search15.txt';
    const st = await api.stat(p);
    const t0 = performance.now();
    const idx = await api.hugeIndex(p);
    const ms = Math.round(performance.now() - t0);
    const ok = !!idx && idx.lines > 0 && !!idx.encoding && idx.sparse > 0 && idx.bytes === st.size;
    return ok ? 'cold=' + ms + 'ms,lines=' + idx.lines : 'idx=' + JSON.stringify(idx) + ',size=' + st.size;
  });

  await step('hugeIndexCache', async () => {
    const p = root + '/build/search15.txt';
    const t0 = performance.now();
    const idx = await api.hugeIndex(p);
    const ms = Math.round(performance.now() - t0);
    return idx && idx.cached === true ? 'hot=' + ms + 'ms' : 'cached=' + (idx && idx.cached);
  });

  // 3.9GB 稀疏夹具：只断言「渲染 + CM 让位 + 切回恢复」（该文件几乎全 NUL，行数可能只有 1~2 行，不做位置数值断言）
  await step('hugeScrollAnywhere', async () => {
    const p = root + '/build/bd-3g9.bin';
    const tab = await app.editor.openFile(p);
    const kindOk = !!tab && tab.kind === 'huge';
    let rows = 0;
    for (let i = 0; i < 30 && rows === 0; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const st = tab && tab.huge ? tab.huge.getState() : null;
      rows = st ? st.renderedRows : 0;
    }
    const hv = document.querySelector('.huge-view');
    const hvH = hv ? hv.getBoundingClientRect().height : 0;
    const cm = document.querySelector('#editor-host .cm-editor');
    const cmDisp = cm ? getComputedStyle(cm).display : '(no-cm)';
    const yielded = cmDisp === 'none' && hvH > 200;
    if (tab && tab.huge) await tab.huge.scrollToPercent(90);
    await new Promise((r) => setTimeout(r, 300));
    const st2 = tab && tab.huge ? tab.huge.getState() : null;
    const rowsOk = !!st2 && st2.renderedRows > 0 && st2.renderedRows < 400;
    const q = root + '/huge-plain.txt';
    await api.writeFile(q, 'plain text');
    await app.editor.openFile(q);
    await new Promise((r) => setTimeout(r, 300));
    const cm2 = document.querySelector('#editor-host .cm-editor');
    const cmBack = !!cm2 && getComputedStyle(cm2).display !== 'none' && cm2.getBoundingClientRect().height > 0;
    await app.editor.closeAll();
    await api.remove(q, false);
    return kindOk && yielded && rowsOk && cmBack
      ? true
      : 'kind=' + kindOk + ',hvH=' + Math.round(hvH) + ',cm=' + cmDisp + ',rows=' + rows + '/' + (st2 && st2.renderedRows) + ',cmBack=' + cmBack;
  });

  await step('hugeSearchFast', async () => {
    const t0 = performance.now();
    const res = await api.globalSearch(root + '/build', 'ZZSTREAM_MARKER_ZZ');
    const ms = Math.round(performance.now() - t0);
    const hit = res.length >= 1 && res[0].line > 100000;
    return hit ? 'search=' + ms + 'ms,hits=' + res.length : 'hits=' + res.length + ',line=' + (res[0] && res[0].line);
  });

  await step('bigSearchStream', async () => {
    const t0 = performance.now();
    const results = await api.globalSearch(root + '/build', 'ZZSTREAM_MARKER_ZZ');
    const ms = Math.round(performance.now() - t0);
    const hit = results.length >= 1 && String(results[0].file).includes('search15.txt') && (results[0].text || '').includes('ZZSTREAM_MARKER_ZZ');
    const lineOk = results.length >= 1 && results[0].line > 100000;
    return hit && lineOk ? true : 'hit=' + hit + ',line=' + (results[0] && results[0].line) + ',n=' + results.length;
  });

  // saveStreamBig：65MB 多行文件编辑 → 分块流式保存（>64M 字符路径）→ 大小与尾部内容校验
  await step('saveStreamBig', async () => {
    const path = root + '/build/big-w.txt';
    const st0 = await api.stat(path);
    const tab = await app.editor.openFile(path);
    if (!tab || tab.kind !== 'chunked') {
      await app.editor.closeAll();
      return 'kind=' + (tab && tab.kind);
    }
    await new Promise((r) => setTimeout(r, 400));
    const view = app.editor.getView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'EOT' } });
    await new Promise((r) => setTimeout(r, 150));
    const t0 = performance.now();
    const saved = await app.editor.saveNow(tab);
    const ms = Math.round(performance.now() - t0);
    const st1 = await api.stat(path);
    const sizeOk = st1.size === st0.size + 3;
    const tail = await api.readFileRange(path, 2097150, 16);
    const tailText = new TextDecoder('utf-8').decode(tail.bytes);
    // EOT 插在打开时的文档末尾（= 首段 2MB 处；后续分段追加会移除占位标记接在其后）
    const tailOk = tailText.includes('EOT');
    await app.editor.closeAll();
    console.log('[stress-savestream] 65MB save=' + ms + 'ms size=' + st1.size);
    return saved && sizeOk && tailOk ? true : 'saved=' + saved + ',size=' + sizeOk + '(' + st1.size + '/' + (st0.size + 3) + '),tail=' + tailOk;
  });

  // ============ v0.4.0 Phase D 第三步：huge 虚拟滚动查看器「视口内编辑」 ============
  // 夹具口径：build/ 下唯一 >1GB 的文件是 3.9GB 稀疏 NUL（二进制 → 不可编辑），能编辑的真实文本
  // 大文件只有 280MB 的 bd-280mb.bin，而它按默认阈值分档到 viewer-lg。因此三个用例各自：
  //   setHugeThresholdMB(200) → 打开 → 断言 → finally { closeAll + setHugeThresholdMB(1024) }
  // 阈值是模块级运行时值（tabs.js 的 hugeScrollThreshold），**必须恢复**，否则后续分档用例
  // （viewer-lg / huge）的预期会被打乱。夹具本体只读保护：每个用例把 bd-280mb.bin 复制到
  // build/huge-<tag>/ 下再编辑，用例末尾删除副本，并断言夹具本体 size + mtime 一字未动。
  const HUGE_FIXTURE = root + '/build/bd-280mb.bin';
  const hugeFixtureStat = () => api.stat(HUGE_FIXTURE);
  const hugeCopyFixture = async (tag) => {
    const dir = root + '/build/huge-' + tag;
    await api.create(root + '/build', 'huge-' + tag, 'dir');
    const r = await api.transferFiles(HUGE_FIXTURE, dir, 'copy'); // 同 rootDir 内副本（requireApproved 覆盖）
    return { dir: dir, file: dir + '/bd-280mb.bin', dest: r && r.dest };
  };
  const hugeWaitReady = async (hv, ms) => {
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = hv ? hv.getState() : null;
      if (st && st.indexed && st.renderedRows > 0) return st;
      await new Promise((r) => setTimeout(r, ms || 250));
    }
    return st;
  };
  const hugeWaitFor = async (fn, ms) => {
    for (let i = 0; i < 40; i++) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, ms || 180));
    }
    return fn();
  };
  const hugeKey = (el, k, opts) => {
    const o = { key: k, bubbles: true, cancelable: true };
    if (opts) for (const kk of Object.keys(opts)) o[kk] = opts[kk];
    el.dispatchEvent(new KeyboardEvent('keydown', o));
  };

  // hugeEditChunkCoW：视口内编辑走 overlay 块级 CoW —— 中部插入 3 行后行数 +3（渲染端 getState
  // 与主进程 huge:doc-state 双口径一致）、isDirty 为真、undoDepth≥1，且**磁盘字节未变**
  // （内存 vs 磁盘对照）；随后用真实 Ctrl+Z 键盘事件复原（键路由挂在 .huge-view 根节点上）。
  await step('hugeEditChunkCoW', async () => {
    const fix0 = await hugeFixtureStat();
    const ctx = await hugeCopyFixture('cow');
    app.editor.setHugeThresholdMB(200);
    try {
      const tab = await app.editor.openFile(ctx.file);
      const hv = tab ? tab.huge : null;
      const kindOk = !!tab && tab.kind === 'huge';
      const st0 = await hugeWaitReady(hv);
      if (!kindOk || !hv || !st0) return 'kind=' + (tab && tab.kind) + ',hv=' + !!hv + ',st=' + JSON.stringify(st0);
      const on = await hv.setEditable(true);
      const docId = hv.getState().docId;
      const before = hv.getState().lines;
      const mid = Math.max(2, Math.floor(before / 2));
      const origMid = (await api.hugeDocLine({ docId: docId, line: mid })).text;
      const r1 = await hv.applyEditForTest({ type: 'insert', line: mid, col: 0, text: 'MH_COW_A\\nMH_COW_B\\nMH_COW_C\\n' });
      const st1 = hv.getState();
      const ds1 = await api.hugeDocState({ docId: docId });
      const linesOk = !!r1 && st1.lines === before + 3 && ds1.lines === before + 3;
      const dirtyOk = hv.isDirty() === true && ds1.dirty === true;
      const undoOk = st1.undoDepth >= 1 && ds1.undoDepth >= 1;
      const midText = (await api.hugeDocLine({ docId: docId, line: mid })).text;
      const contentOk = midText === 'MH_COW_A';
      const diskSt = await api.stat(ctx.file);
      const offMid = await api.hugeLineOffset(ctx.file, mid);
      const rr = await api.readFileRange(ctx.file, Math.max(0, offMid - 8), 128);
      const diskMid = new TextDecoder('utf-8').decode(rr.bytes);
      const diskOk = diskSt.size === fix0.size && diskMid.indexOf('MH_COW_') < 0;
      // 真实键盘事件：一次编辑 = 一个撤销项 → 一条 Ctrl+Z 即复原
      const rootEl = tab.hugeEl || document.querySelector('.huge-view');
      hugeKey(rootEl, 'z', { ctrlKey: true });
      const backOk = await hugeWaitFor(() => hv.getState().lines === before && hv.isDirty() === false);
      const midBack = (await api.hugeDocLine({ docId: docId, line: mid })).text;
      const ds2 = await api.hugeDocState({ docId: docId });
      const fix1 = await hugeFixtureStat();
      const fixOk = fix1.size === fix0.size && fix1.mtime === fix0.mtime;
      const ok = kindOk && on === true && linesOk && dirtyOk && undoOk && contentOk && diskOk &&
        backOk && midBack === origMid && ds2.redoDepth >= 1 && fixOk;
      return ok ? true
        : 'kind=' + kindOk + ',on=' + on + ',lines=' + linesOk + '(' + st1.lines + '/' + ds1.lines + '/' + (before + 3) +
          '),dirty=' + dirtyOk + ',undo=' + undoOk + '(' + st1.undoDepth + '),content=' + contentOk +
          ',disk=' + diskOk + ',back=' + backOk + ',midBack=' + (midBack === origMid) + ',redo=' + ds2.redoDepth + ',fix=' + fixOk;
    } finally {
      await app.editor.closeAll();
      app.editor.setHugeThresholdMB(1024);
      // 关标签可能在后台保存（huge 关闭=先保存再关会话）→ 删除副本要重试，避免撞上临时文件/句柄
      for (let i = 0; i < 10; i++) {
        try { await api.remove(ctx.dir, true); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
      }
    }
  });

  // hugeEditSaveAtomic：保存走 huge:doc-save（干净块原字节拷贝 + overlay 分片 → 临时文件 → fsync →
  // 校验字节数 → rename）。断言全落在**磁盘事实**：字节数 = 原大小 + 插入串长度、按行索引定位后读回
  // 标记内容（同时证明保存后行索引重建可用、跳转仍准）、目标目录无 .mh-ovl-*.tmp 残留、
  // 进度事件序列 copy→verify→rename→done（渲染端自订阅收集）。
  await step('hugeEditSaveAtomic', async () => {
    const fix0 = await hugeFixtureStat();
    const ctx = await hugeCopyFixture('save');
    app.editor.setHugeThresholdMB(200);
    let offProg = null;
    try {
      const copy0 = await api.stat(ctx.file);
      const tab = await app.editor.openFile(ctx.file);
      const hv = tab ? tab.huge : null;
      const st0 = await hugeWaitReady(hv);
      if (!tab || tab.kind !== 'huge' || !hv || !st0) return 'kind=' + (tab && tab.kind) + ',hv=' + !!hv;
      const on = await hv.setEditable(true);
      const before = hv.getState().lines;
      const mid = Math.max(2, Math.floor(before / 2));
      const MARK = 'MH_SAVE_ATOMIC_9f3c\\n';
      const phases = [];
      offProg = api.onHugeDocSaveProgress((d) => { if (d && d.phase) phases.push(d.phase); });
      const r1 = await hv.applyEditForTest({ type: 'insert', line: mid, col: 0, text: MARK });
      const dirtyBefore = hv.isDirty();
      const saved = await hv.save();
      // 进度事件（sender.send）与 invoke 回执同管但顺序不作保证 → 等一拍再退订，避免漏掉 'done'
      await new Promise((r) => setTimeout(r, 400));
      if (typeof offProg === 'function') { offProg(); offProg = null; }
      const st1 = await api.stat(ctx.file);
      const sizeOk = st1.size === copy0.size + MARK.length;
      const dirtyOk = dirtyBefore === true && hv.isDirty() === false;
      const docId = hv.getState().docId;
      const ds = await api.hugeDocState({ docId: docId });
      const linesOk = ds.lines === before + 1 && hv.getState().lines === before + 1;
      const offMid = await api.hugeLineOffset(ctx.file, mid); // 保存后索引重建 → 行号定位必须仍然准
      const rr = await api.readFileRange(ctx.file, Math.max(0, offMid - 4), 64);
      const diskText = new TextDecoder('utf-8').decode(rr.bytes);
      const diskOk = diskText.indexOf('MH_SAVE_ATOMIC_9f3c') >= 0;
      const idx = await api.hugeIndex(ctx.file);
      const idxOk = !!idx && idx.lines === ds.lines && idx.bytes === st1.size;
      const entries = await api.readTree(ctx.dir);
      const tmpLeft = entries.filter((e) => String(e.name).indexOf('.mh-ovl-') >= 0).length;
      const order = ['copy', 'verify', 'rename', 'done'];
      let seqOk = phases.indexOf('copy') >= 0;
      for (let i = 1; i < order.length; i++) seqOk = seqOk && phases.indexOf(order[i]) > phases.indexOf(order[i - 1]);
      const fix1 = await hugeFixtureStat();
      const fixOk = fix1.size === fix0.size && fix1.mtime === fix0.mtime;
      const ok = !!r1 && on === true && saved === true && sizeOk && dirtyOk && linesOk && diskOk && idxOk && tmpLeft === 0 && seqOk && fixOk;
      return ok ? true
        : 'on=' + on + ',saved=' + saved + ',size=' + sizeOk + '(' + st1.size + '/' + (copy0.size + MARK.length) + ')' +
          ',dirty=' + dirtyOk + ',lines=' + linesOk + '(' + ds.lines + '/' + (before + 1) + '),disk=' + diskOk +
          ',idx=' + idxOk + ',tmp=' + tmpLeft + ',seq=' + seqOk + '(' + phases.join('>') + '),fix=' + fixOk;
    } finally {
      if (typeof offProg === 'function') { offProg(); offProg = null; }
      await app.editor.closeAll();
      app.editor.setHugeThresholdMB(1024);
      // 关标签可能在后台保存（huge 关闭=先保存再关会话）→ 删除副本要重试，避免撞上临时文件/句柄
      for (let i = 0; i < 10; i++) {
        try { await api.remove(ctx.dir, true); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
      }
    }
  });

  // hugeEditUndo：真实键盘事件驱动的多次编辑（输入字符 / Home / Enter）+ undo/redo 往返一致 ——
  // 反复 Ctrl+Z 回到原文（行数/内容/脏标记/canRedo 同步），再反复 Ctrl+Y 前进到编辑后状态
  // （行数/内容/undoDepth/canUndo 同步）。
  await step('hugeEditUndo', async () => {
    const fix0 = await hugeFixtureStat();
    const ctx = await hugeCopyFixture('undo');
    app.editor.setHugeThresholdMB(200);
    try {
      const tab = await app.editor.openFile(ctx.file);
      const hv = tab ? tab.huge : null;
      const st0 = await hugeWaitReady(hv);
      if (!tab || tab.kind !== 'huge' || !hv || !st0) return 'kind=' + (tab && tab.kind) + ',hv=' + !!hv;
      const on = await hv.setEditable(true);
      const rootEl = tab.hugeEl || document.querySelector('.huge-view');
      const before = hv.getState().lines;
      // ① 真实鼠标路径落光标：点视口内第一行（x 落在行号栏 → 列按行尾处理）
      const rowEl = rootEl.querySelector('.huge-line');
      if (!rowEl) return 'no row';
      const ln = parseInt(rowEl.dataset.line, 10);
      const rect = rowEl.getBoundingClientRect();
      rowEl.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0, clientX: rect.left + 30, clientY: rect.top + 8,
      }));
      const caretOk = await hugeWaitFor(() => {
        const c = hv.getState().caret;
        return !!c && c.line === ln;
      });
      const origLine = (await api.hugeDocLine({ docId: hv.getState().docId, line: ln })).text;
      // ② 输入 / 换行（每步等 undoDepth 增长 → 时序确定，不靠固定 sleep）
      const depth = () => hv.getState().undoDepth;
      hugeKey(rootEl, 'M');
      const d1 = await hugeWaitFor(() => depth() >= 1);
      hugeKey(rootEl, 'H');
      const d2 = await hugeWaitFor(() => depth() >= 2);
      hugeKey(rootEl, 'Home');
      const homeOk = await hugeWaitFor(() => { const c = hv.getState().caret; return !!c && c.col === 0; });
      hugeKey(rootEl, 'Z');
      const d3 = await hugeWaitFor(() => depth() >= 3);
      hugeKey(rootEl, 'Enter'); // 光标在 'Z' 之后 → 行裂成两行（行数 +1）
      const grew = await hugeWaitFor(() => hv.getState().lines === before + 1);
      hugeKey(rootEl, 'Y');
      const d4 = await hugeWaitFor(() => depth() >= 4);
      hugeKey(rootEl, 'Y');
      const d5 = await hugeWaitFor(() => depth() >= 5);
      const docId = hv.getState().docId;
      const editedLine = (await api.hugeDocLine({ docId: docId, line: ln })).text;
      const editedNext = (await api.hugeDocLine({ docId: docId, line: ln + 1 })).text;
      const editedState = hv.getState();
      // 期望：'Z' 插到行首 → 回车把它切成两行 → 'YY' 落在新行行首
      const editOk = editedState.lines === before + 1 && hv.isDirty() === true && editedState.canUndo === true &&
        editedLine === 'Z' && editedNext === 'YY' + origLine + 'MH' && editedState.undoDepth >= 5;
      // ③ 全部撤销 → 与原文逐字一致
      let undone = 0;
      while (hv.getState().canUndo && undone < 12) {
        const d = hv.getState().undoDepth;
        hugeKey(rootEl, 'z', { ctrlKey: true });
        await hugeWaitFor(() => hv.getState().undoDepth < d, 120);
        undone++;
      }
      const backState = hv.getState();
      const backLine = (await api.hugeDocLine({ docId: docId, line: ln })).text;
      const undoOk = backState.lines === before && hv.isDirty() === false && backLine === origLine &&
        backState.canRedo === true && backState.undoDepth === 0 && backState.redoDepth === editedState.undoDepth;
      // ④ 全部重做 → 回到编辑后状态
      const redoTarget = editedState.undoDepth;
      let redone = 0;
      while (hv.getState().canRedo && redone < 12) {
        const d = hv.getState().redoDepth;
        hugeKey(rootEl, 'y', { ctrlKey: true });
        await hugeWaitFor(() => hv.getState().redoDepth < d, 120);
        redone++;
      }
      const fwdState = hv.getState();
      const fwdLine = (await api.hugeDocLine({ docId: docId, line: ln })).text;
      const fwdNext = (await api.hugeDocLine({ docId: docId, line: ln + 1 })).text;
      const redoOk = fwdState.lines === before + 1 && fwdState.undoDepth === redoTarget &&
        fwdState.canUndo === true && fwdState.canRedo === false && fwdLine === 'Z' &&
        fwdNext === 'YY' + origLine + 'MH' && hv.isDirty() === true;
      const fix1 = await hugeFixtureStat();
      const fixOk = fix1.size === fix0.size && fix1.mtime === fix0.mtime;
      // ⑤ 收尾：再全部撤销回干净状态（第三次往返一致性校验；同时避免 closeAll 又写一次 280MB）
      let undone2 = 0;
      while (hv.getState().canUndo && undone2 < 12) {
        const d = hv.getState().undoDepth;
        hugeKey(rootEl, 'z', { ctrlKey: true });
        await hugeWaitFor(() => hv.getState().undoDepth < d, 120);
        undone2++;
      }
      const cleanOk = hv.getState().lines === before && hv.isDirty() === false && redone === redoTarget;
      const ok = on === true && caretOk && d1 && d2 && homeOk && d3 && grew && d4 && d5 && editOk && undoOk && redoOk && cleanOk && fixOk;
      return ok ? true
        : 'on=' + on + ',caret=' + caretOk + ',keys=' + [d1, d2, homeOk, d3, grew, d4, d5].join('/') +
          ',edit=' + editOk + '(ln=' + editedState.lines + '/' + (before + 1) + ',l=' + JSON.stringify(editedLine.slice(0, 16)) +
          ',n=' + JSON.stringify(editedNext.slice(0, 20)) + ',depth=' + editedState.undoDepth + ')' +
          ',undo=' + undoOk + '(n=' + undone + ',ln=' + backState.lines + ',line=' + (backLine === origLine) + ',redo=' + backState.redoDepth + ')' +
          ',redo=' + redoOk + '(n=' + redone + ',ln=' + fwdState.lines + ',depth=' + fwdState.undoDepth + '/' + redoTarget + ',canRedo=' + fwdState.canRedo + ')' +
          ',clean=' + cleanOk + '(n=' + undone2 + '),fix=' + fixOk;
    } finally {
      await app.editor.closeAll();
      app.editor.setHugeThresholdMB(1024);
      // 关标签可能在后台保存（huge 关闭=先保存再关会话）→ 删除副本要重试，避免撞上临时文件/句柄
      for (let i = 0; i < 10; i++) {
        try { await api.remove(ctx.dir, true); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
      }
    }
  });

  // hugeEditReadOnly（v0.5.0 挂账项）：editable === false 的**只读路径**此前只有代码、没有自动断言。
  // 夹具：build/bd-3g9.bin = 3.9GB **稀疏 NUL** 文件 —— 正文含 NUL → src/main/overlay.js 的
  // checkEditable（overlay.js:240-244）判「二进制内容（含 NUL 字节，按文本近似显示），暂不支持编辑」；
  // 且 3.9GB > 1GB 默认阈值 → 天然落 huge 档，**不需要 setHugeThresholdMB**，
  // 因此与 hugeEditChunkCoW/SaveAtomic/Undo 三条「临时降档到 200MB」的用例**不交叉**。
  // 双口径（都不看内部 flag，只读两条真实契约）：
  //   ① 主进程契约：直接 api.hugeDocOpen({file}) 读回 editable/reason（不经过渲染端封装）；
  //   ② 渲染端事实：huge 视图 hv.setEditable(true) 必须被拒（返回 false），且 getState() 里
  //      editable === false（视图没进编辑态）/ docEditable === false（主进程判定）/
  //      editableReason 非空且与 ① 的 reason **逐字一致**；根节点上没有 huge-editable 类；
  //      状态条文案含「只读」（hugeview.js:650-654 的落点）；且没有产生任何未保存修改。
  await step('hugeEditReadOnly', async () => {
    const FILE = root + '/build/bd-3g9.bin';
    let directId = null;
    let direct = null;
    let directErr = '';
    try {
      // ① 主进程契约（此刻该 realpath 还没有任何编辑会话 → 走「新建」分支，返回必带 editable/reason）。
      //    单独 try：即便 open 本身抛错，也要把渲染端的只读口径跑完并把错误原样带进证据串，
      //    而不是整条用例只留一个裸 ERR（那样无法判断是契约不符还是打开失败）。
      try {
        direct = await api.hugeDocOpen({ file: FILE });
      } catch (e) {
        directErr = String((e && e.message) || e);
      }
      directId = direct && direct.docId != null ? direct.docId : null;
      const directOk = !!direct && direct.editable === false &&
        typeof direct.reason === 'string' && direct.reason.length > 0;
      if (directId != null) { await api.hugeDocClose({ docId: directId }); directId = null; } // 立刻还回去，不留句柄
      // ② 渲染端事实
      const tab = await app.editor.openFile(FILE);
      const hv = tab ? tab.huge : null;
      const st0 = await hugeWaitReady(hv, 400);
      if (!tab || tab.kind !== 'huge' || !hv || !st0) {
        return 'kind=' + (tab && tab.kind) + ',hv=' + !!hv + ',st=' + JSON.stringify(st0);
      }
      const on = await hv.setEditable(true); // 必须被拒（hugeview.js:650）
      const st1 = hv.getState();
      const rootEl = tab.hugeEl || document.querySelector('.huge-view');
      const viewOk = on === false && st1.editable === false && st1.docEditable === false;
      const reasonOk = typeof st1.editableReason === 'string' && st1.editableReason.length > 0 &&
        st1.editableReason === direct.reason;
      const clsOk = !!rootEl && !rootEl.classList.contains('huge-editable');
      const statusText = rootEl ? ((rootEl.querySelector('.huge-status-text') || {}).textContent || '') : '';
      const statusOk = statusText.indexOf('只读') >= 0;
      const cleanOk = st1.dirty === false && st1.undoDepth === 0 && hv.isDirty() === false;
      const ok = directOk && viewOk && reasonOk && clsOk && statusOk && cleanOk;
      return ok ? true
        : 'direct=' + directOk + '(editable=' + (direct && direct.editable) + ',reason=' + JSON.stringify(direct && direct.reason) + (directErr ? ',ERR=' + directErr : '') + ')' +
          ',view=' + viewOk + '(on=' + on + ',editable=' + st1.editable + ',docEditable=' + st1.docEditable + ')' +
          ',reason=' + reasonOk + ',cls=' + clsOk + ',status=' + statusOk + '(' + JSON.stringify(String(statusText).slice(0, 48)) + ')' +
          ',clean=' + cleanOk + '(dirty=' + st1.dirty + ',undo=' + st1.undoDepth + ',isDirty=' + hv.isDirty() + ')';
    } finally {
      if (directId != null) { try { await api.hugeDocClose({ docId: directId }); } catch { /* 已关闭 */ } }
      await app.editor.closeAll();
    }
  });

  // bigFileTeardown：恢复默认上限与干净会话
  await step('bigFileTeardown', async () => {
    await app.editor.closeAll();
    await api.setSettings({ maxFileSizeMB: 50, lastSession: null });
    app.state.settings = await api.getSettings();
    return true;
  });

  // ============ v0.2.0 阶段三：多文档对比 ============

  // diffBasic：双栏行级 diff —— 修改/新增/删除行数与统计正确，diff-host 独占编辑区
  await step('diffBasic', async () => {
    const left = 'l1\\nl2\\nl3\\nl4\\nl5\\n';
    const right = 'l1\\nL2-mod\\nl3\\nn4a\\nn4b\\nl5\\n';
    const tab = app.editor.openDiffTab({ leftLabel: 'a.md', leftContent: left, rightLabel: 'b.md', rightContent: right });
    await new Promise((r) => setTimeout(r, 300));
    const host = document.getElementById('diff-host');
    const visible = !host.classList.contains('hidden');
    const modN = host.querySelectorAll('.diff-row.mod').length;
    const addN = host.querySelectorAll('.diff-row.add').length;
    const delN = host.querySelectorAll('.diff-row.del').length;
    const stats = (host.querySelector('.diff-stats') || {}).textContent || '';
    const model = tab._model;
    // 语义：l2→L2-mod（改）；l4→n4a（改）+ n4b（增）—— jsdiff LCS 分块
    const okStats = stats.includes('+1') && stats.includes('−0') && stats.includes('~2') && stats.includes('2 处');
    return tab.kind === 'diff' && visible && modN === 2 && addN === 1 && delN === 0 && okStats && model.blocks.length === 2
      ? true
      : 'kind=' + tab.kind + ',vis=' + visible + ',mod=' + modN + ',add=' + addN + ',del=' + delN + ',stats=' + stats;
  });

  // diffWords：修改行词级高亮 —— 左右单元格各有 .dw-hl 差异片段
  await step('diffWords', async () => {
    const tab = app.editor.findTabByPath ? app.editor.getActiveTab() : null;
    const host = document.getElementById('diff-host');
    const modRow = host.querySelector('.diff-row.mod');
    if (!modRow) {
      app.editor.closeAll();
      return 'no mod row';
    }
    const lHl = modRow.querySelector('.diff-l .dw-hl');
    const rHl = modRow.querySelector('.diff-r .dw-hl');
    const lTxt = lHl ? lHl.textContent : '';
    const rTxt = rHl ? rHl.textContent : '';
    app.editor.closeAll();
    return lHl && rHl && lTxt === 'l2' && rTxt === 'L2-mod' ? true : 'l=' + lTxt + ',r=' + rTxt;
  });

  // diffNav：变更块导航 —— 下一处/上一处循环高亮当前块，序号徽标正确
  await step('diffNav', async () => {
    app.editor.openDiffTab({ leftLabel: 'a.md', leftContent: 'x\\ny\\nz\\n', rightLabel: 'b.md', rightContent: 'X\\ny\\nZ\\n' });
    await new Promise((r) => setTimeout(r, 300));
    const host = document.getElementById('diff-host');
    const btnNext = Array.from(host.querySelectorAll('.diff-bar .tbtn')).find((b) => b.textContent.includes('下一处'));
    const btnPrev = Array.from(host.querySelectorAll('.diff-bar .tbtn')).find((b) => b.textContent.includes('上一处'));
    if (!btnNext || !btnPrev) {
      app.editor.closeAll();
      return 'no nav buttons';
    }
    btnNext.click();
    await new Promise((r) => setTimeout(r, 150));
    const cur1 = host.querySelectorAll('.diff-row.current').length;
    const badge1 = (host.querySelector('.diff-cur') || {}).textContent || '';
    btnNext.click();
    await new Promise((r) => setTimeout(r, 150));
    const badge2 = (host.querySelector('.diff-cur') || {}).textContent || '';
    btnPrev.click();
    await new Promise((r) => setTimeout(r, 150));
    const badge3 = (host.querySelector('.diff-cur') || {}).textContent || '';
    app.editor.closeAll();
    return cur1 === 1 && badge1 === '1/2' && badge2 === '2/2' && badge3 === '1/2'
      ? true
      : 'cur=' + cur1 + ',b1=' + badge1 + ',b2=' + badge2 + ',b3=' + badge3;
  });

  // diffUnsaved：工具栏「对比」对话框 + 磁盘版本 —— 未保存改动在 diff 中可见
  // （临时调大自动保存延迟至 10s：消除 dispatch→readFile 期间 autosave 抢先写盘的竞态）
  await step('diffUnsaved', async () => {
    await api.setSettings({ autoSaveDelay: 10000 });
    app.state.settings = await api.getSettings();
    await api.writeFile(root + '/dv.md', 'original line 1\\noriginal line 2\\n');
    await app.editor.openFile(root + '/dv.md');
    await new Promise((r) => setTimeout(r, 300));
    const view = app.editor.getView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'original line 1\\nEDITED line 2\\nextra line 3\\n' } });
    await new Promise((r) => setTimeout(r, 150));
    document.getElementById('btn-diff').click();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.querySelector('#modal-body select');
    if (!sel) {
      app.editor.closeAll();
      await api.setSettings({ autoSaveDelay: 800 });
      app.state.settings = await api.getSettings();
      return 'no dialog';
    }
    sel.value = '__disk__';
    const btns = Array.from(document.querySelectorAll('#modal-actions .tbtn'));
    btns[btns.length - 1].click(); // 开始对比
    await new Promise((r) => setTimeout(r, 400));
    const host = document.getElementById('diff-host');
    const modN = host.querySelectorAll('.diff-row.mod').length;
    const addN = host.querySelectorAll('.diff-row.add').length;
    const t = app.editor.getActiveTab();
    const isDiff = t && t.kind === 'diff';
    app.editor.closeAll();
    await api.remove(root + '/dv.md', false);
    await api.setSettings({ autoSaveDelay: 800 });
    app.state.settings = await api.getSettings();
    return isDiff && modN === 1 && addN === 1 ? true : 'diff=' + isDiff + ',mod=' + modN + ',add=' + addN;
  });

  // diffLimits（v0.2.1）：单侧超 20MB → 截断对比（醒目横幅 + 前 20MB 正常渲染），不再硬拒绝
  await step('diffLimits', async () => {
    const big = 'x'.repeat(21 * 1024 * 1024);
    app.editor.openDiffTab({ leftLabel: 'big-l', leftContent: big, rightLabel: 'big-r', rightContent: 'small' });
    await new Promise((r) => setTimeout(r, 600));
    const host = document.getElementById('diff-host');
    const banner = host.querySelector('.diff-trunc-banner');
    const msgOk = banner && banner.textContent.includes('已截断');
    // 20MB 单行 vs 'small'：jsdiff 相邻 removed+added → 配对为 1 个 mod 行（非 del+add）
    const hasMod = host.querySelectorAll('.diff-row.mod').length > 0;
    app.editor.closeAll();
    return banner && msgOk && hasMod ? true : 'banner=' + !!banner + ',msg=' + msgOk + ',mod=' + hasMod;
  });

  // diffThree（v0.2.1）：三方对比 —— 基准/本方/对方三栏、双方改同行 both 高亮、统计
  await step('diffThree', async () => {
    const base = 'a\\nb\\nc\\nd\\ne\\n';
    const ours = 'a\\nB-ours\\nc\\nd\\ne\\nours-extra\\n';   // 本方改 b
    const theirs = 'a\\nB-theirs\\nc\\nd\\ne\\n';             // 对方也改 b（不同）→ both 行
    app.editor.openDiffTab({
      three: true,
      leftLabel: 'base.md', leftContent: base,
      midLabel: 'ours.md', midContent: ours,
      rightLabel: 'theirs.md', rightContent: theirs,
    });
    await new Promise((r) => setTimeout(r, 400));
    const host = document.getElementById('diff-host');
    const t = app.editor.getActiveTab();
    const isThree = t && t.kind === 'diff' && t.three === true;
    const rows3 = host.querySelectorAll('.diff3-row:not(.diff-head)').length;
    const bothN = host.querySelectorAll('.diff3-row.both').length;
    const stats = (host.querySelector('.diff-stats') || {}).textContent || '';
    const bothOk = stats.includes('双方改同行 1');
    app.editor.closeAll();
    return isThree && rows3 >= 6 && bothN === 1 && bothOk
      ? true
      : 'three=' + isThree + ',rows=' + rows3 + ',both=' + bothN + ',stats=' + stats;
  });

  // treeCompare（v0.2.1）：树右键对比 —— 设为基准 → 另一文件「与基准对比」开对比标签
  await step('treeCompare', async () => {
    await api.writeFile(root + '/tc-base.md', 'same\\nbase-line\\n');
    await api.writeFile(root + '/tc-target.md', 'same\\ntarget-line\\nnew-line\\n');
    await app.tree.refreshNode(root, true);
    await new Promise((r) => setTimeout(r, 400));
    const rows = () => Array.from(document.querySelectorAll('#file-tree .tree-node'));
    const norm = (p) => String(p).replace(/\\\\/g, '/');
    const rowB = rows().find((n) => norm(n.dataset.path).endsWith('/tc-base.md'));
    if (!rowB) return 'no base row';
    // 右键基准文件 → 设为对比基准
    rowB.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 200, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const itemBase = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).find((el) => el.textContent.includes('设为对比基准'));
    if (!itemBase) return 'no set-base item';
    itemBase.click();
    await new Promise((r) => setTimeout(r, 200));
    // 右键目标文件 → 与基准对比
    const rowT = rows().find((n) => norm(n.dataset.path).endsWith('/tc-target.md'));
    rowT.dispatchEvent(new MouseEvent('contextmenu', { clientX: 200, clientY: 260, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const itemCmp = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).find((el) => el.textContent.includes('与基准对比'));
    if (!itemCmp) return 'no compare item';
    itemCmp.click();
    await new Promise((r) => setTimeout(r, 500));
    const t = app.editor.getActiveTab();
    const isDiff = t && t.kind === 'diff';
    const host = document.getElementById('diff-host');
    const modN = host.querySelectorAll('.diff-row.mod').length;
    const addN = host.querySelectorAll('.diff-row.add').length;
    app.editor.closeAll();
    await api.remove(root + '/tc-base.md', false);
    await api.remove(root + '/tc-target.md', false);
    return isDiff && modN === 1 && addN === 1 ? true : 'diff=' + isDiff + ',mod=' + modN + ',add=' + addN;
  });

  // diffSessionExcluded：对比标签不入会话（重启不恢复临时视图）
  await step('diffSessionExcluded', async () => {
    await api.writeFile(root + '/dv-keep.md', 'keep');
    await app.editor.openFile(root + '/dv-keep.md');
    app.editor.openDiffTab({ leftLabel: 'l', leftContent: 'a\\n', rightLabel: 'r', rightContent: 'b\\n' });
    await new Promise((r) => setTimeout(r, 200));
    const s = app.editor.getSession();
    const noNull = s.paths.every((p) => !!p);
    const onlyFile = s.paths.length === 1 && s.paths[0] === root + '/dv-keep.md';
    app.editor.closeAll();
    await api.remove(root + '/dv-keep.md', false);
    return noNull && onlyFile ? true : 'paths=' + JSON.stringify(s.paths);
  });

  // ============ 0.5.0 挂账收尾：huge:doc-recover-list 的渲染端消费方（崩溃恢复） ============
  // 夹具口径：**自造 24MB 文本**（30000 行 × 769B）——
  //   · < 复位后的 50MB 打开上限（tabs.js:1042）⇒ **不动 settings.maxFileSizeMB**；
  //   · > minOpenBytes(16MB) ⇒ 「huge:doc-open」**不带 force** 的那条路（hugeview.ensureDoc）也能开；
  //   · 配 「setHugeThresholdMB(1)」 ⇒ tabs.js:1047 的 huge 判据在 viewer(>256MB)/chunked(>4MB) 之前命中。
  // 「崩溃」= closeByPath(file, false, {save:false})：huge 关标签时 closeDoc(false) 会先 flushMeta
  // 把块表 + 字节仓库留在 <userData>/overlay 下，源文件字节一个都不动。
  // 断言全部落在产品事实：主进程行数（huge:doc-state）/ 抽行内容（huge:doc-line）/ 源文件 stat 与
  // 内容 / 恢复区文件是否还在 / chip 文案 / 弹窗 DOM 结构 —— 无时序性判据（等待一律轮询到事实出现），
  // 无长度等价性判据（等价性用内容标记）。
  const recSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const recExists = async (p) => { try { await api.stat(p); return true; } catch (e) { return false; } };
  // 等"恢复区条目能被列出"：关标签后的 persistMeta 是**异步强刷**（overlay.js:1221），
  // 因此轮询到条目出现为止，而不是写一个固定 sleep 赌时序（本批 G1 就是这么踩的坑）。
  const recWaitListed = async (file, tries) => {
    for (let i = 0; i < (tries || 24); i++) {
      const items = await app.recover.list();
      const hit = items.filter((x) => x.file === file)[0];
      if (hit) return hit;
      await recSleep(250);
    }
    return null;
  };
  // 等主进程侧的编辑会话真的释放（「huge:doc-state」对已释放句柄会抛「DOC_GONE」，overlay-ipc.js:181）。
  // 为什么需要它：「closeByPath(..., {save:false})」→「hv.closeDoc(false)」是 fire-and-forget，而 overlay 的
  // 「close」是**先 await persistMeta（写 <key>.json）再 detachHandle**（overlay-ipc.js:416-417）——
  // 所以「句柄已释放」恰好等价于「这次强刷已落盘」，此后删恢复区文件才是无竞态的（有界轮询，不赌固定延时）。
  const recWaitSessionGone = async (docId) => {
    for (let i = 0; i < 20; i++) {
      let alive = true;
      try {
        const st = await api.hugeDocState({ docId: docId });
        alive = !!(st && st.ok !== false && st.lines != null);
      } catch (e) { alive = false; } // DOC_GONE：句柄已释放
      if (!alive) return true;
      await recSleep(150);
    }
    return false;
  };
  // 清场：把指向某文件的恢复区条目全部丢弃 → 删后 stat 复核 overlay 两文件都不在 → 返回 chip 显隐。
  const recCleanup = async (file, dirPrefix) => {
    const keys = [];
    const first = await recWaitListed(file, 6);
    if (first) keys.push(first.key);
    for (const it of await app.recover.list()) {
      if (it && dirPrefix && String(it.file).indexOf(dirPrefix) === 0) keys.push(it.key);
    }
    let removed = 0;
    for (const k of keys) {
      const r = await app.recover.discard({ key: k, file: file });
      if (r && r.ok) removed++;
    }
    const dir = app.recover.getState().dir;
    const left = [];
    for (const k of keys) {
      for (const ext of ['.json', '.tmp']) {
        try { await api.stat(dir + '/' + k + ext); left.push(k + ext); } catch (e) { /* 已删除 */ }
      }
    }
    const gs = app.recover.getState();
    return { removed: removed, keys: keys.length, left: left, chipHidden: gs.chipVisible === false, count: gs.count };
  };
  // 自造夹具（24MB 文本；返回 dir/file，供 recCrashAt 与会话清理共用）
  const recMakeFixture = async (tag) => {
    const dir = root + '/build/recover-' + tag;
    const file = dir + '/rec-' + tag + '.txt';
    // 先清残留：fs:create 对已存在同名项直接抛错（ipc.js:219「已存在同名项」），
    // 上一轮被中断的运行若留下 build/recover-<tag>/，本用例会在夹具阶段就以 ERR 红。
    try { await api.remove(dir, true); } catch (e) { /* 不存在或残留不可删：下一步 create 会给出真实原因 */ }
    await api.create(root + '/build', 'recover-' + tag, 'dir');
    const lines = [];
    for (let i = 0; i < 30000; i++) lines.push('R' + String(i).padStart(6, '0') + '|' + 'y'.repeat(760));
    const text = lines.join('\\n') + '\\n';
    await api.writeFile(file, text);
    return { dir: dir, file: file, lines: lines.length };
  };
  // 造一条"崩溃现场"：开 huge 标签 → 启用编辑 → 中间插一行标记 → **不保存关闭**（块表保留）
  const recCrashAt = async (ctx, marker) => {
    const tab = await app.editor.openFile(ctx.file);
    const hv = tab ? tab.huge : null;
    const st0 = await hugeWaitReady(hv);
    if (!tab || tab.kind !== 'huge' || !hv || !st0) {
      return { err: 'kind=' + (tab && tab.kind) + ',hv=' + !!hv + ',st=' + JSON.stringify(st0) };
    }
    const on = await hv.setEditable(true);
    if (on !== true) return { err: 'editable=' + on };
    const docId = hv.getState().docId;
    const before = hv.getState().lines;
    const mid = Math.max(2, Math.floor(before / 2));
    const origMid = (await api.hugeDocLine({ docId: docId, line: mid })).text;
    const r = await hv.applyEditForTest({ type: 'insert', line: mid, col: 0, text: marker + '\\n' });
    const ds = await api.hugeDocState({ docId: docId });
    const fixStat = await api.stat(ctx.file);
    app.editor.closeByPath(ctx.file, false, { save: false }); // 不保存关闭 = 崩溃现场（overlay 保留）
    const listed = await recWaitListed(ctx.file);              // 轮询等 persistMeta 落盘（不赌固定时序）
    return { ctx: ctx, dir: ctx.dir, file: ctx.file, marker: marker, mid: mid, origMid: origMid,
      before: before, docLines: ds.lines, dirty: ds.dirty, inserted: !!r, fixStat: fixStat, listed: !!listed };
  };

  // hugeRecoverPrompt：入口（chip + 弹窗）→ 恢复 → 内容/行数/源文件零改动全绿 → 清场归隐
  await step('hugeRecoverPrompt', async () => {
    app.editor.setHugeThresholdMB(1);
    let ctxA = null;
    try {
      ctxA = await recMakeFixture('a');
      const fx = await recCrashAt(ctxA, 'MH_REC_A');
      if (fx.err) return 'fixture=' + fx.err;
      const crashOk = fx.dirty === true && fx.inserted === true && fx.docLines === fx.before + 1 && fx.listed === true;
      // 入口：走 boot 同一条路（recover.init = 刷新 + 点亮状态栏 chip + 非模态提示）
      await app.recover.init();
      const s1 = app.recover.getState();
      const it = s1.items.filter((x) => x.file === fx.file)[0];
      const listOk = !!it && it.lines === fx.docLines && it.dirtyBlocks >= 1 && it.sourceExists === true;
      const chipOk = s1.chipVisible === true && s1.chipText.indexOf('可恢复') >= 0;
      app.recover.openDialog();
      const s2 = app.recover.getState();
      const row = it ? document.querySelector('.recover-item[data-key="' + it.key + '"]') : null;
      const rowText = row ? row.textContent : '';
      const dialogOk = s2.dialogOpen === true && !!row && !!row.querySelector('.recover-ok') &&
        !!row.querySelector('.recover-drop') && rowText.indexOf('未保存修改') >= 0;
      // 恢复：内容断言用**内容标记**（插入行 = 标记串；被插入行下移一位后应与编辑前逐字相同）
      const rr = await app.recover.recover({ key: it.key, file: fx.file });
      const s3 = app.recover.getState();
      const callOk = !!rr && rr.ok === true && rr.lines === fx.docLines && rr.attached === true;
      const midText = callOk ? (await api.hugeDocLine({ docId: rr.docId, line: fx.mid })).text : null;
      const nextText = callOk ? (await api.hugeDocLine({ docId: rr.docId, line: fx.mid + 1 })).text : null;
      const contentOk = midText === fx.marker && nextText === fx.origMid;
      const dsAfter = callOk ? await api.hugeDocState({ docId: rr.docId }) : null;
      const linesOk = !!dsAfter && dsAfter.lines === fx.docLines && dsAfter.dirty === true;
      const tab2 = app.editor.findTabByPath(fx.file);
      const tabOk = !!tab2 && tab2.kind === 'huge' && !!tab2.huge && tab2.huge.getState().docId === rr.docId;
      const diskStat = await api.stat(fx.file);
      const diskOk = diskStat.size === fx.fixStat.size && diskStat.mtime === fx.fixStat.mtime;
      const msgOk = s3.msg.indexOf('已恢复') >= 0 && s3.lastError === '';
      // 清场 + 归隐断言：恢复成功后 <key>.json/.tmp 仍在恢复区（产品语义），用例必须自己删净，
      // 否则后续窗口 boot（mw* 的 win2、rcDir 子进程）会点亮 chip 并多一条提示。
      //
      // ⚠️ 清场前必须先关掉刚被恢复打开的那个标签（否则 removed=0，用例必红）——两个独立机制：
      //   ① recover.js 的「refresh()」会用「isOpenHere(file)」**过滤掉本窗口已打开的文件**（:140）
      //      ⇒ 恢复后该条目**根本不在列表里**，recCleanup 的 keys 为空；
      //   ② 即便拿得到 key，「doDiscard」的守卫①是「本窗口 huge 标签且 docId 非空 ⇒ 拒绝」（:493-496）。
      //   真实用户流程也正是「恢复 → 看过内容 → 关掉标签 → 再丢弃」。
      // 关闭用「{save:false}」：**不写源文件**（与 closeTab 的 save:false 语义一致，tabs.js:2370/2379）；
      // 随后必须**等到主进程句柄真的释放**再删 —— closeTab 里的「closeDoc(false)」是 fire-and-forget，
      // 其 persistMeta 是异步 rename；不等就可能出现「先删掉 <key>.json、随后这次 flush 又把它写回来」
      // （残留复核会抓到，但那时用例已经红了，且残留会污染后续 boot）。
      app.editor.closeByPath(fx.file, false, { save: false });
      const closedOk = !app.editor.findTabByPath(fx.file);
      const goneOk = (rr && rr.docId != null) ? await recWaitSessionGone(rr.docId) : true;
      const cl = await recCleanup(fx.file, ctxA.dir);
      const gs4 = app.recover.getState();
      const cleanOk = cl.removed >= 1 && cl.left.length === 0 && cl.chipHidden === true
        && gs4.items.every((x) => x.file !== fx.file);
      const ok = crashOk && listOk && chipOk && dialogOk && callOk && contentOk && linesOk && tabOk && diskOk && msgOk
        && closedOk && goneOk && cleanOk;
      return ok ? true
        : 'crash=' + crashOk + ',list=' + listOk + '(n=' + s1.count + '),chip=' + chipOk + '[' + s1.chipText + ']' +
          ',dialog=' + dialogOk + '(open=' + s2.dialogOpen + ',row=' + !!row + ')' +
          ',call=' + callOk + '(' + JSON.stringify(rr) + '),content=' + contentOk +
          '(mid=' + JSON.stringify(midText) + ',next=' + JSON.stringify(nextText) + ',want=' + JSON.stringify(fx.origMid) + ')' +
          ',lines=' + linesOk + '(' + (dsAfter && dsAfter.lines) + '/' + fx.docLines + ',dirty=' + (dsAfter && dsAfter.dirty) + ')' +
          ',tab=' + tabOk + ',disk=' + diskOk + '(' + diskStat.size + '/' + fx.fixStat.size + ')' +
          ',msg=' + msgOk + '[' + s3.msg + ']' +
          ',closed=' + closedOk + ',gone=' + goneOk +
          ',clean=' + cleanOk + '(removed=' + cl.removed + '/keys=' + cl.keys + ',left=' + JSON.stringify(cl.left) +
          ',chipHidden=' + cl.chipHidden + ',count=' + cl.count + ')';
    } finally {
      try { document.getElementById('modal-mask').classList.add('hidden'); } catch (e) {}
      try { await app.editor.closeAll(); } catch (e) {}
      // 阈值恢复必须无条件执行：recMakeFixture 内的 api.create/api.writeFile 会抛，抛时 ctxA 仍是 null
      // —— 若把恢复写在 if (ctxA) 里，阈值会停在 1MB 不复位，后续所有 open 都被判成 huge 档，
      // 把一次异常放大成一串莫名其妙的红。
      app.editor.setHugeThresholdMB(1024);
      if (ctxA) {
        try { await recCleanup(ctxA.file, ctxA.dir); } catch (e) {}
        for (let i = 0; i < 10; i++) {
          try { await api.remove(ctxA.dir, true); break; } catch (e) { await recSleep(400); }
        }
      }
    }
  });

  // hugeRecoverReject：两段拒绝路径 —— ①源文件真的变了（闸①）；②块表被贴到错误的 key 上，
  // **即便 huge:doc-open 带 force:true 也必须由 docKey 闸拒绝**（force 只跳大小下限，不是免死金牌）。
  // 每段都顺带验证：被拒时源文件零改动、恢复区不被误删、句柄不留悬挂、随后丢弃能清干净。
  await step('hugeRecoverReject', async () => {
    app.editor.setHugeThresholdMB(1);
    let ctxB = null;
    try {
      ctxB = await recMakeFixture('b');
      // ── 阶段 1：源文件真的变了（size + mtime 都变）→ 闸① 必须拒绝 ──
      const fx = await recCrashAt(ctxB, 'MH_REC_B');
      if (fx.err) return 'fixture=' + fx.err;
      // fs:splice-file 在文件末尾追加 MH_EXT_CHANGE + 换行（整文件原子覆盖 → size/mtime 都变）。
      // 说明：这是写盘 IPC（会 markSelfWrite），但本用例断言的是 recover.js 的身份闸
      // 「api.stat(size/mtime) vs 块表 meta」，与 filewatch 的回声守卫无关。
      // 长度**由串本身推导**（14 字节），不写死 15 —— 2026-09-13 实证：写死 15 会让 1.changed 恒假。
      const extAppend = 'MH_EXT_CHANGE\\n';
      await api.spliceFile(fx.file, fx.fixStat.size, 0, extAppend);
      const st1 = await api.stat(fx.file);
      const changed = st1.size === fx.fixStat.size + extAppend.length && st1.mtime !== fx.fixStat.mtime;
      await app.recover.init();
      const s1 = app.recover.getState();
      const it1 = s1.items.filter((x) => x.file === fx.file)[0];
      const listed1 = !!it1 && it1.lines === fx.docLines && it1.dirtyBlocks >= 1;
      const meta1 = s1.dir + '/' + (it1 ? it1.key : '') + '.json';
      const tmp1 = s1.dir + '/' + (it1 ? it1.key : '') + '.tmp';
      app.recover.openDialog();
      const rr1 = await app.recover.recover({ key: it1.key, file: fx.file });
      const msgEl = document.getElementById('recover-msg');
      const rej1 = !!rr1 && rr1.ok === false && String(rr1.reason).indexOf('恢复被拒绝：源文件已变化') === 0;
      const red1 = !!msgEl && msgEl.classList.contains('recover-error') && msgEl.textContent.indexOf('恢复被拒绝') >= 0;
      const kept1 = (await recExists(meta1)) && (await recExists(tmp1)); // 恢复区未被误删
      const tail1 = new TextDecoder('utf-8').decode((await api.readFileRange(fx.file, st1.size - 64, 64)).bytes);
      const disk1 = tail1.indexOf('MH_EXT_CHANGE') >= 0 && tail1.indexOf('MH_REC_B') < 0;
      const rd1 = await app.recover.discard({ key: it1.key, file: fx.file });
      const drop1 = !!rd1 && rd1.ok === true && !(await recExists(meta1)) && !(await recExists(tmp1));

      // ── 阶段 2：身份闸当主角 —— 同一个文件上再造崩溃现场，再把块表改造为"身份已漂移" ──
      // 真机里这种状态来自 realpath/版本漂移，或闸①通过后、open 之前的竞态；这里用「改 JSON 里的 key
      // + 两个恢复区文件改名」伪造它，size/mtime 与当前文件保持一致 ⇒ 闸①必过，只有 docKey 闸能拦。
      const fx2 = await recCrashAt(ctxB, 'MH_REC_B2');
      if (fx2.err) return 'stage1-ok,fixture2=' + fx2.err;
      const crash2 = fx2.dirty === true && fx2.listed === true && fx2.docLines === fx2.before + 1;
      const s2 = app.recover.getState();
      const it2 = s2.items.filter((x) => x.file === fx2.file)[0];
      const listed2 = !!it2 && it2.lines === fx2.docLines && it2.dirtyBlocks >= 1;
      const realKey = it2 ? it2.key : '';
      const meta2 = s2.dir + '/' + realKey + '.json';
      const tmp2 = s2.dir + '/' + realKey + '.tmp';
      const rawMeta = await api.readFile(meta2);   // 读成功即 approve，同时拿到 JSON 内容
      await api.readFileRange(tmp2, 0, 1);          // 给 .tmp 也拿 approve
      const metaObj = JSON.parse(typeof rawMeta === 'string' ? rawMeta : rawMeta.content);
      const fakeKey = 'ffffffffffffffffffffffffffffffffffffffff'; // 40 位 hex（recover-list 只认这个形状）
      metaObj.key = fakeKey;                        // 只改"身份"，块表/分片表/源文件身份字段一字不动
      await api.writeFile(meta2, JSON.stringify(metaObj));
      await api.rename(tmp2, fakeKey + '.tmp');
      await api.rename(meta2, fakeKey + '.json');
      const fakeMeta = s2.dir + '/' + fakeKey + '.json';
      const fakeTmp = s2.dir + '/' + fakeKey + '.tmp';
      const forgedOk = (await recExists(fakeMeta)) && (await recExists(fakeTmp)) &&
        !(await recExists(meta2)) && !(await recExists(tmp2));
      await app.recover.list();
      const s3 = app.recover.getState();
      const it3 = s3.items.filter((x) => x.key === fakeKey)[0];
      const listed3 = !!it3 && it3.lines === fx2.docLines && it3.dirtyBlocks >= 1;
      const rr2 = await app.recover.recover({ key: fakeKey, file: fx2.file });
      const msgEl2 = document.getElementById('recover-msg');
      // 该前缀只可能在 huge:doc-open(force:true) **成功返回之后**才产生 → 它本身就是"open 到了、key 闸拦下"的证据
      const rej2 = !!rr2 && rr2.ok === false && String(rr2.reason).indexOf('恢复被拒绝：文件身份校验未通过') === 0;
      const red2 = !!msgEl2 && msgEl2.classList.contains('recover-error') && msgEl2.textContent.indexOf('文件身份校验未通过') >= 0;
      const kept2 = (await recExists(fakeMeta)) && (await recExists(fakeTmp));
      // 闸②失败路径必须关掉刚开的句柄（不留悬挂会话）：再开一次应当 reuse=false
      const probe = await api.hugeDocOpen({ file: fx2.file, force: true });
      const handleOk = !!probe && probe.reused === false;
      if (probe && probe.docId != null) { try { await api.hugeDocClose({ docId: probe.docId, discard: true }); } catch (e) {} }
      const st2b = await api.stat(fx2.file);
      const tail2 = new TextDecoder('utf-8').decode((await api.readFileRange(fx2.file, st2b.size - 64, 64)).bytes);
      const disk2 = st2b.size === fx2.fixStat.size && tail2.indexOf('MH_REC_B2') < 0;
      // 清场（含阶段 2 伪造的 fakeKey 条目）：删除夹具前把指向本夹具的条目都丢弃
      const cl2 = await recCleanup(fx2.file, ctxB.dir);
      // removed ≥ 1：证明**伪造 key 的那对文件真的经产品路径被丢弃了**（否则 clean2 会退化成「空 keys ⇒
      // left 也是空」的恒真断言，伪造的 <fakeKey>.json/.tmp 会永远留在用户的恢复区里）。
      const clean2 = cl2.removed >= 1 && cl2.left.length === 0;
      const ok = changed && listed1 && rej1 && red1 && kept1 && disk1 && drop1 &&
        crash2 && listed2 && forgedOk && listed3 && rej2 && red2 && kept2 && handleOk && disk2 && clean2;
      return ok ? true
        : '1.changed=' + changed + '(' + st1.size + '/' + (fx.fixStat.size + extAppend.length) + ')' +
          ',1.listed=' + listed1 + ',1.rej=' + rej1 + '[' + (rr1 && rr1.reason) + ']' +
          ',1.red=' + red1 + ',1.kept=' + kept1 + ',1.disk=' + disk1 + '(' + JSON.stringify(tail1.slice(-24)) + ')' +
          ',1.drop=' + drop1 + '(' + JSON.stringify(rd1) + ')' +
          ';2.crash=' + crash2 + ',2.listed=' + listed2 + '(n=' + s2.count + ')' +
          ',2.forged=' + forgedOk + ',2.listed3=' + listed3 + '(n=' + s3.count + ')' +
          ',2.rej=' + rej2 + '[' + (rr2 && rr2.reason) + ']' +
          ',2.red=' + red2 + ',2.kept=' + kept2 + ',2.handle=' + handleOk +
          ',2.disk=' + disk2 + '(' + st2b.size + '/' + fx2.fixStat.size + ')' +
          ',2.clean=' + clean2 + '(removed=' + cl2.removed + ',left=' + JSON.stringify(cl2.left) + ')';
    } finally {
      try { document.getElementById('modal-mask').classList.add('hidden'); } catch (e) {}
      try { await app.editor.closeAll(); } catch (e) {}
      // 阈值恢复必须无条件执行（与 hugeRecoverPrompt 同一条理由）：recMakeFixture 内的 api.create/
      // api.writeFile 会抛，抛时 ctxB 仍是 null —— 写在 if (ctxB) 里就会让阈值停在 1MB 不复位。
      app.editor.setHugeThresholdMB(1024);
      if (ctxB) {
        try { await recCleanup(ctxB.file, ctxB.dir); } catch (e) {}
        for (let i = 0; i < 10; i++) {
          try { await api.remove(ctxB.dir, true); break; } catch (e) { await recSleep(400); }
        }
      }
    }
  });

  return results;
})()
`;

// 需求3：右键菜单「粘贴为纯文本」—— 剪贴板由主进程控制（smoke 在 main 进程直接读写 clipboard）
// phase: 'text'（剪贴板含文本 → 断言插入） / 'empty'（剪贴板为空 → 断言 toast 且文档不变）
function menuClipboardSnippet(phase) {
  const pasteLabel = phase === 'text' ? 'menuPaste' : 'menuPasteEmpty';
  // 点击后的异步链路（readClipboardText IPC → 插入/toast）在高负载下可能超过固定等待：
  // done 为「本阶段预期结果已出现」的轮询条件
  const done =
    phase === 'text'
      ? `doc.startsWith('纯文本测试 123') && cur === '纯文本测试 123'.length`
      : `toastText.includes('剪贴板为空') && doc === '第一行内容\\n第二行内容'`;
  const assertBody =
    phase === 'text'
      ? `const ok = visible && !!item && doc.startsWith('纯文本测试 123') && cur === '纯文本测试 123'.length;
         return ok ? true : 'vis=' + visible + ',item=' + !!item + ',doc=' + JSON.stringify(doc.slice(0, 24)) + ',cur=' + cur;`
      : `const ok = visible && !!item && toastText.includes('剪贴板为空') && doc === '第一行内容\\n第二行内容';
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
    const menu = document.querySelector('#ctx-menu');
    // 抗抖动重试：测试窗口运行在真实桌面上，期间一次真实鼠标点击即会关闭菜单（全局 click 隐藏），
    // 派发后最多重试 5 次（每次 100ms），菜单可见即继续
    let visible = false;
    for (let i = 0; i < 5 && !visible; i++) {
      cm.dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
      for (let j = 0; j < 5 && !visible; j++) {
        await new Promise((r) => setTimeout(r, 20));
        visible = !menu.classList.contains('hidden');
      }
    }
    const item = Array.from(menu.querySelectorAll('.ctx-item')).find((el) => el.textContent.includes('粘贴为纯文本'));
    if (item) item.click();
    // 点击后轮询（最长 3s，预期结果出现即停）：IPC 链路在高负载下可能超过固定等待
    let doc = view.state.doc.toString();
    let cur = view.state.selection.main.head;
    let toastText = '';
    const isDone = () => ${done};
    for (let i = 0; i < 30 && !isDone(); i++) {
      await new Promise((r) => setTimeout(r, 100));
      doc = view.state.doc.toString();
      cur = view.state.selection.main.head;
      const toastEl = Array.from(document.querySelectorAll('.toast')).pop();
      toastText = toastEl ? toastEl.textContent : '';
    }
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
      // 1A/1B：大文件与边界测试材料 —— 放 build/ 子目录（全局搜索 walk 跳过 SKIP_DIRS 中的 build，
      // 避免边界大文件拖慢其它搜索用例）。查看器边界档用稀疏文件（ftruncate 秒建不占盘，内容为 NUL，
      // 查看器按二进制窗口只读显示）；编辑/分段档用真实多行内容（NUL 单行会触发 CM 超长行测量失控）。
      {
        const bigDir = path.join(TEST_ROOT, 'build');
        fs.mkdirSync(bigDir, { recursive: true });
        const mkSparse = (p, size) => {
          const fd = fs.openSync(p, 'w');
          fs.ftruncateSync(fd, size);
          fs.closeSync(fd);
        };
        const writeLines = (p, totalBytes) => {
          const line = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ,.!?- \n';
          const parts = new Array(Math.ceil(totalBytes / line.length)).fill(line);
          fs.writeFileSync(p, parts.join(''));
        };
        mkSparse(path.join(bigDir, 'bd-512mb.bin'), 512 * 1024 * 1024); // 查看器边界内（二进制只读档）
        writeLines(path.join(bigDir, 'bd-280mb.bin'), 280 * 1024 * 1024); // 区域编辑用（真实文本）
        mkSparse(path.join(bigDir, 'bd-3g9.bin'), Math.floor(3.9 * 1024 * 1024 * 1024)); // 4GB 内最大档
        mkSparse(path.join(bigDir, 'bd-4g1.bin'), Math.floor(4.1 * 1024 * 1024 * 1024)); // 超限拒绝档
        writeLines(path.join(bigDir, 'big-a.bin'), 60 * 1024 * 1024); // chunked 多大文件同开
        writeLines(path.join(bigDir, 'big-b.bin'), 60 * 1024 * 1024);
        // 流式写用：真实多行内容 65MB（>64M 字符触发 write-stream 路径）
        writeLines(path.join(bigDir, 'big-w.txt'), 65 * 1024 * 1024);
        // 流式搜索用：真实内容 15MB（>10MB 原跳过档），中部埋标记行
        {
          const line = Buffer.from('the quick brown fox jumps over the lazy dog 0123456789\n');
          const total = 15 * 1024 * 1024;
          const buf = Buffer.alloc(total);
          for (let off = 0; off + line.length <= total; off += line.length) buf.fill(line, off, off + line.length);
          Buffer.from('ZZSTREAM_MARKER_ZZ\n').copy(buf, Math.floor(total / 2));
          fs.writeFileSync(path.join(bigDir, 'search15.txt'), buf);
        }
      }
      const results = await win.webContents.executeJavaScript(RENDERER_TEST);
      // v0.3.0 rcDirArgParse：资源管理器右键 --dir 的 argv 解析（主进程侧）。
      // 背景：Electron 在 second-instance 里会重排 argv，`--dir` 与它的值被拆开
      // （实测 ["electron.exe","--dir","--allow-file-access-from-files","<app>","<目标>"]），
      // 旧实现只取「--dir 的下一个元素」→ 拿到 Chromium 开关 → 右键目录被静默忽略。
      {
        const { extractDirArg } = require('../src/main/args');
        const app2 = 'C:\\some\\app-dir';
        const reordered = ['electron.exe', '--dir', '--allow-file-access-from-files', app2, TEST_ROOT];
        const paired = ['MarkHunter.exe', '--dir', TEST_ROOT];
        const eqForm = ['MarkHunter.exe', '--dir=' + TEST_ROOT];
        const missing = ['electron.exe', '--dir', '--allow-file-access-from-files', app2, 'Z:\\not-exist-xyz'];
        const okParse =
          extractDirArg(reordered, { appPath: app2 }) === TEST_ROOT &&
          extractDirArg(paired) === TEST_ROOT &&
          extractDirArg(eqForm) === TEST_ROOT &&
          extractDirArg(missing, { appPath: app2 }) === 'Z:\\not-exist-xyz' &&
          extractDirArg(['electron.exe', '--smoke', app2], { appPath: app2 }) === null;
        results.push(['rcDirArgParse', okParse,
          'reordered=' + extractDirArg(reordered, { appPath: app2 }) +
          ',paired=' + extractDirArg(paired) +
          ',missing=' + extractDirArg(missing, { appPath: app2 })]);
      }
      // v0.2.4 previewImgClip：剪贴板断言须在主进程侧（clipboard 模块不进渲染上下文）。
      // RENDERER_TEST 中 previewImgCtx 已点击「复制图片（原图）」，期间无其它用例改写剪贴板 ——
      // 此处读取应得到 1×1 原图（原图字节直写，不压缩不缩放）
      {
        const sz = clipboard.readImage().getSize();
        results.push(['previewImgClip', sz.width === 1 && sz.height === 1, 'clip=' + sz.width + 'x' + sz.height]);
      }
      // 需求3：剪贴板读写由主进程控制（渲染进程仅经 window.api.readClipboardText 读取）
      clipboard.writeText('纯文本测试 123');
      const r1 = await win.webContents.executeJavaScript(menuClipboardSnippet('text'));
      clipboard.writeText(''); // 清空剪贴板
      const r2 = await win.webContents.executeJavaScript(menuClipboardSnippet('empty'));
      results.push(...r1, ...r2);
      // bundleSplit（P5）：主 bundle 显著小于拆包前（4.34MB 基准 → 应 < 2.5MB），mermaid chunk 产物存在。
      // 主进程侧断言构建产物体积（渲染进程无文件系统访问）。
      const bundlePath = path.join(__dirname, '..', 'src', 'renderer', 'dist', 'bundle.js');
      const chunkPath = path.join(__dirname, '..', 'src', 'renderer', 'dist', 'mermaid-chunk.js');
      let bundleSize = -1;
      let chunkSize = -1;
      try { bundleSize = fs.statSync(bundlePath).size; } catch { /* 缺失 */ }
      try { chunkSize = fs.statSync(chunkPath).size; } catch { /* 缺失 */ }
      results.push([
        'bundleSplit',
        bundleSize > 0 && bundleSize < 2.5 * 1024 * 1024 && chunkSize > 0,
        'bundle=' + (bundleSize >= 0 ? (bundleSize / 1024 / 1024).toFixed(2) + 'MB' : 'missing') +
          ',chunk=' + (chunkSize >= 0 ? (chunkSize / 1024 / 1024).toFixed(2) + 'MB' : 'missing'),
      ]);

      // ============ v0.5.0 挂账项：huge 保存后「外部修改仍能触发 file-changed」的**运行时**断言 ============
      // 已有证据只到文件系统层：scripts/watch-rename-probe.js（纯 node，5/5）证明 overlay 保存的
      // rename 覆盖**不会**让 fs.watch(文件) 失效。这里补**运行时层**——保存之后由用例侧真·外部写入，
      // 断言渲染端确实收到 file-changed 并走了 huge 的「外部修改重载」分支（tabs.js 的 onFileChanged
      // → tab.huge.reloadExternal() + toast「已从外部重新加载 …」）。
      // 为什么必须放主进程侧：
      //   ① 需要 fs 直写副本模拟外部编辑器 —— 走 api.writeFile / api.writeExternal 都会被
      //      filewatch 的 markSelfWrite（ipc.js 的写盘路径都调）当成自写回声吸收，测不出东西；
      //   ② 追加一个 280MB 文件不可能用整串 IPC 传内容。
      // 夹具：bd-280mb.bin 的**同 rootDir 副本**（照抄 hugeEditSaveAtomic 的复制/清理口径，
      // 源夹具只读保护 → 末尾断言 size+mtime 一字未动）。副本目录用 build/huge-watch/。
      {
        const W_SRC = path.join(TEST_ROOT, 'build', 'bd-280mb.bin');
        const W_DIR = path.join(TEST_ROOT, 'build', 'huge-watch');
        const W_COPY = path.join(W_DIR, 'bd-280mb.bin');
        const W_APPEND = '\nMH_EXT_AFTER_SAVE\n'; // 20 字节；追加到以 \n 结尾的文件 → 行数 +2
        const sleepW = (ms) => new Promise((r) => setTimeout(r, ms));
        const Wr = (code) => win.webContents.executeJavaScript(code);
        const Wrv = (expr) => win.webContents.executeJavaScript(`(async () => { await (${expr}); })()`);
        // 用例前的「打开上限」：必须在 try 之外声明 —— finally 里要用它逐字复原。
        // （首跑这里写成 try 内的 const，导致 finally 抛 ReferenceError: prevMaxMB is not defined，
        //   主进程段整体 E2E_ERROR、E2E_RESULTS 一行都没打印，而 SMOKE_OK 仍被无条件打印。）
        let prevMaxMB = null;
        try {
          const src0 = fs.statSync(W_SRC);
          fs.rmSync(W_DIR, { recursive: true, force: true });
          fs.mkdirSync(W_DIR, { recursive: true });
          fs.copyFileSync(W_SRC, W_COPY);
          // 打开上限：本用例跑在**主进程段**，此时 RENDERER_TEST 末尾的 bigFileTeardown
          // （renderer 段 :3363-3368）已把 maxFileSizeMB 复位成 50 —— 280MB 的副本会被
          // tabs.js:822 的守卫拒绝（openFile 直接 return null，并弹出「文件过大，未打开」模态框），
          // 表现为 kind=null,hv=false,st=null（首跑就是这样失败的）。按既有 4096 口径临时抬高，
          // finally 逐字复原（rcDir* 段随后跑，必须回到 50）。
          prevMaxMB = await Wr('window.api.getSettings().then((s) => s.maxFileSizeMB)').catch(() => null);
          // 渲染端：装 toast 记录器（提示寿命 ~1.9s，轮询会漏）→ 抬上限 → 降档 → 开副本 → 编辑一行 → 保存
          const r = await Wr(`(async () => {
            const api = window.api, app = window.__app;
            window.__mhWatchToasts = [];
            const push = (el) => { try { if (el && el.classList && el.classList.contains('toast')) window.__mhWatchToasts.push(el.textContent); } catch (e) {} };
            const mo = new MutationObserver((ms) => {
              for (const m of ms) for (const n of m.addedNodes) { push(n); if (n && n.querySelectorAll) n.querySelectorAll('.toast').forEach(push); }
            });
            mo.observe(document, { childList: true, subtree: true });
            document.querySelectorAll('.toast').forEach(push);
            await api.setSettings({ maxFileSizeMB: 4096 });
            app.state.settings = await api.getSettings();
            const maxMB = app.state.settings.maxFileSizeMB;
            app.editor.setHugeThresholdMB(200);
            const thMB = app.editor.getHugeThresholdMB ? app.editor.getHugeThresholdMB() : null;
            let openErr = '';
            let tab = null;
            try { tab = await app.editor.openFile(${JSON.stringify(W_COPY)}); }
            catch (e) { openErr = String((e && e.message) || e); }
            // openFile 失败路径会弹 alertBox（自定义模态，非原生对话框）→ 关掉，别留给后续用例
            const mask = document.getElementById('modal-mask');
            const modalShown = !!mask && !mask.classList.contains('hidden');
            const modalBody = modalShown ? String(((document.getElementById('modal-body') || {}).textContent) || '').slice(0, 80) : '';
            if (modalShown) { const b = document.querySelector('#modal-actions .tbtn'); if (b) b.click(); }
            const hv = tab ? tab.huge : null;
            let st = null;
            for (let i = 0; i < 40; i++) {
              st = hv ? hv.getState() : null;
              if (st && st.indexed && st.renderedRows > 0) break;
              await new Promise((res) => setTimeout(res, 250));
            }
            if (!tab || tab.kind !== 'huge' || !hv || !st) {
              return { ok: false, why: 'kind=' + (tab && tab.kind) + ',hv=' + !!hv + ',st=' + JSON.stringify(st) +
                ',openErr=' + JSON.stringify(openErr) + ',modal=' + modalShown + ':' + JSON.stringify(modalBody) +
                ',maxMB=' + maxMB + ',thMB=' + thMB };
            }
            const on = await hv.setEditable(true);
            const lines0 = hv.getState().lines;
            const mid = Math.max(2, Math.floor(lines0 / 2));
            const edit = await hv.applyEditForTest({ type: 'insert', line: mid, col: 0, text: 'MH_WATCH_MARK_1a2b\\n' });
            const saved = await hv.save();
            const st1 = hv.getState();
            return { ok: true, on: on === true, edit: !!edit, saved: saved === true, lines0: lines0, lines1: st1.lines, dirty: st1.dirty === true, maxMB: maxMB, thMB: thMB };
          })()`);
          if (!r || r.ok !== true) {
            results.push(['hugeWatchAfterSave', 'ERR: ' + JSON.stringify(r)]);
          } else {
            const sizeAfterSave = fs.statSync(W_COPY).size;
            // 跨过三道自写回声守卫：filewatch SELF_WRITE_GRACE_MS=2000（主进程 mtime+size 匹配）、
            // tabs.js 的 tab.lastSavedAt 1200ms（普通分支）、huge 分支的 hvSt.savedAt 3000ms。
            // 取 3600ms 一次性越过三者，避免"等待不足 → 事件被吸收 → 假阴性"。
            await sleepW(3600);
            fs.appendFileSync(W_COPY, W_APPEND, 'utf8'); // ← 真·外部写：不经过 app 的写盘 IPC，不打 markSelfWrite
            const sizeAfterAppend = fs.statSync(W_COPY).size;
            let seen = null;
            for (let i = 0; i < 60; i++) {
              await sleepW(400);
              const s = await Wr(`(() => {
                const t = window.__app.editor.findTabByPath(${JSON.stringify(W_COPY)});
                const hv = t ? t.huge : null;
                const g = hv ? hv.getState() : null;
                return { toasts: (window.__mhWatchToasts || []).slice(), lines: g ? g.lines : null, indexed: g ? g.indexed : false };
              })()`).catch(() => null);
              if (!s) continue;
              seen = s;
              const hit = (s.toasts || []).some((x) => String(x).indexOf('已从外部重新加载') >= 0);
              if (hit && typeof s.lines === 'number' && s.lines > r.lines1) break;
            }
            const toastOk = !!seen && (seen.toasts || []).some((x) => String(x).indexOf('已从外部重新加载') >= 0);
            // 追加串以 '\n' 开头又以 '\n' 结尾、且原文件以 '\n' 结尾 → 行数精确 +2
            const linesOk = !!seen && seen.lines === r.lines1 + 2;
            const sizeOk = sizeAfterAppend === sizeAfterSave + Buffer.byteLength(W_APPEND, 'utf8');
            const src1 = fs.statSync(W_SRC);
            const fixOk = src1.size === src0.size && src1.mtimeMs === src0.mtimeMs;
            const ok = r.on && r.edit && r.saved && r.dirty === false && toastOk && linesOk && sizeOk && fixOk;
            results.push(['hugeWatchAfterSave', ok,
              'on=' + r.on + ',edit=' + r.edit + ',saved=' + r.saved + ',dirtyAfterSave=' + r.dirty +
              ',maxMB=' + r.maxMB + ',thMB=' + r.thMB +
              ',lines=' + r.lines0 + '→' + r.lines1 + '→' + (seen && seen.lines) + '(期望 +2)=' + linesOk +
              ',toast=' + toastOk + ',size=' + sizeOk + '(' + sizeAfterSave + '+' + Buffer.byteLength(W_APPEND, 'utf8') + '=' + sizeAfterAppend + ')' +
              ',fixUntouched=' + fixOk + ',toasts=' + JSON.stringify(((seen && seen.toasts) || []).slice(-3))]);
          }
        } catch (err) {
          results.push(['hugeWatchAfterSave', 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err))]);
        } finally {
          // 收尾：先关掉可能残留的 alertBox 模态 → 关标签（huge 关标签=先保存再关会话）→
          // 复原「打开上限」与「huge 阈值」→ 删副本（重试：关标签可能在后台写盘）
          await Wr(`(() => { const m = document.getElementById('modal-mask'); if (m && !m.classList.contains('hidden')) { const b = document.querySelector('#modal-actions .tbtn'); if (b) b.click(); } return true; })()`).catch(() => {});
          await Wrv('window.__app.editor.closeAll()').catch(() => {});
          await Wr('window.__app.editor.setHugeThresholdMB(1024)').catch(() => {});
          // maxFileSizeMB 逐字复原（首跑前它是 bigFileTeardown 复位后的 50；拿不到就回落 50）
          const restoreMB = Number.isFinite(Number(prevMaxMB)) && Number(prevMaxMB) > 0 ? Math.floor(Number(prevMaxMB)) : 50;
          await Wr(`(async () => { await window.api.setSettings({ maxFileSizeMB: ${restoreMB} }); window.__app.state.settings = await window.api.getSettings(); return true; })()`).catch(() => {});
          for (let i = 0; i < 10; i++) {
            try { fs.rmSync(W_DIR, { recursive: true, force: true }); break; } catch { await sleepW(400); }
          }
        }
      }

      // ============ v0.1.51 多窗口：主进程编排第二窗口（show:false 后台运行，不干扰桌面） ============
      {
        const { BrowserWindow } = require('electron');
        const win2 = new BrowserWindow({
          width: 1200,
          height: 800,
          show: false,
          webPreferences: {
            preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
          },
        });
        const W2 = (code) => win2.webContents.executeJavaScript(code);
        const W1 = (code) => win.webContents.executeJavaScript(code);
        const root2 = TEST_ROOT.replace(/\\/g, '/');
        try {
          await win2.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
          // 等第二窗口 boot（后台窗口 rAF 可能节流 —— 用足够长的轮询等待 __app）
          await W2(`(async () => {
            for (let i = 0; i < 100 && !window.__app; i++) await new Promise(r => setTimeout(r, 100));
            return !!window.__app;
          })()`).then((ok) => {
            results.push(['mwBoot', ok === true ? true : 'w2 app not ready']);
          });
          if (await W2(`!!window.__app`)) {
            // 基础：独立目录上下文 + 打开文件
            await W2(`(async () => {
              await window.__app.openDirFromPath(${JSON.stringify(root2)});
              await window.api.writeFile(${JSON.stringify(root2)} + '/mw-own.md', 'win2 own');
              await window.__app.editor.openFile(${JSON.stringify(root2)} + '/mw-own.md');
              const t = window.__app.editor.getActiveTab();
              return t && t.name === 'mw-own.md';
            })()`).then((ok) => {
              results.push(['mwIndependent', ok === true ? true : 'w2 tab=' + ok]);
            });
            // 主题广播：主窗口改主题 → 第二窗口即时换肤
            await W1(`window.__app.applyTheme('fx-starry'); window.api.setSettings({ theme: 'fx-starry' }); null`);
            await new Promise((r) => setTimeout(r, 600));
            await W2(`document.documentElement.getAttribute('data-theme')`).then((th) => {
              results.push(['mwThemeSync', th === 'fx-starry' ? true : 'w2 theme=' + th]);
            });
            await W1(`window.__app.applyTheme('markhunter-classic'); window.api.setSettings({ theme: 'markhunter-classic' }); null`);
            await new Promise((r) => setTimeout(r, 400));
            // 事件路由：win1 打开 mw-route.md（watcher 归 win1），外部写 → 只有 win1 重载
            // （等待须超过自写宽限窗口 2000ms —— 前面 writeFile 建文件记录了自写宽限，与 externalChange 用例同理）
            await W1(`(async () => {
              await window.api.writeFile(${JSON.stringify(root2)} + '/mw-route.md', 'v1');
              await window.__app.editor.openFile(${JSON.stringify(root2)} + '/mw-route.md');
              return true;
            })()`);
            await new Promise((r) => setTimeout(r, 2300));
            await W1(`window.api.writeExternal(${JSON.stringify(root2)} + '/mw-route.md', 'v2-external')`);
            await new Promise((r) => setTimeout(r, 2000)); // watch + 防抖 + 重载
            await W1(`window.__app.editor.findTabByPath(${JSON.stringify(root2)} + '/mw-route.md').state.doc.toString()`).then((doc1) => {
              results.push(['mwFileChangedRouting', doc1 === 'v2-external' ? true : 'w1 doc=' + doc1]);
            });
            // D2 共享文件：win1 已开 mw-shared.md → win2 打开同文件 → 自动只读 + win1 编辑保存后静默同步
            await W1(`(async () => {
              await window.api.writeFile(${JSON.stringify(root2)} + '/mw-shared.md', 'shared-v1');
              await window.__app.editor.openFile(${JSON.stringify(root2)} + '/mw-shared.md');
              return true;
            })()`);
            await new Promise((r) => setTimeout(r, 400));
            await W2(`(async () => {
              const t = await window.__app.editor.openFile(${JSON.stringify(root2)} + '/mw-shared.md');
              await new Promise(r => setTimeout(r, 500));
              return !!(t && t.readOnly === true);
            })()`).then((ro) => {
              results.push(['mwSharedReadOnly', ro === true ? true : 'w2 readOnly=' + ro]);
            });
            // win1 编辑并保存 → win2 只读窗静默同步（内容一致 + 不弹重载 toast 由 silent 保证）
            await W1(`(async () => {
              const t = window.__app.editor.findTabByPath(${JSON.stringify(root2)} + '/mw-shared.md');
              const v = window.__app.editor.getView();
              v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'shared-v2-edited' } });
              return await window.__app.editor.saveNow(t);
            })()`);
            await new Promise((r) => setTimeout(r, 2000));
            await W2(`window.__app.editor.findTabByPath(${JSON.stringify(root2)} + '/mw-shared.md').state.doc.toString()`).then((doc2) => {
              results.push(['mwSharedSync', doc2 === 'shared-v2-edited' ? true : 'w2 doc=' + doc2]);
            });
            // Python 输出路由：从 win2 运行 → 输出事件到 win2（状态文本变化）
            await W2(`(async () => {
              await window.api.writeFile(${JSON.stringify(root2)} + '/mw-run.py', 'print("MW2_PY_OK")');
              const t = await window.__app.editor.openFile(${JSON.stringify(root2)} + '/mw-run.py');
              await window.__app.python.run();
              for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 200));
                const s = (document.getElementById('py-status').textContent || '');
                if (s.includes('已完成') || s.includes('退出码')) return s;
              }
              return 'timeout:' + (document.getElementById('py-status').textContent || '');
            })()`).then((st) => {
              const ok = typeof st === 'string' && st.includes('已完成');
              results.push(['mwPythonRouting', ok ? true : 'w2 py=' + st]);
            });
            // 关窗存活：关掉 win2 前 win1 保持功能；关闭后 win1 再开文件正常
            await W1(`(async () => {
              await window.api.writeFile(${JSON.stringify(root2)} + '/mw-after.md', 'after close');
              const t = await window.__app.editor.openFile(${JSON.stringify(root2)} + '/mw-after.md');
              return !!t;
            })()`).then((ok) => {
              results.push(['mwCloseSurvive', ok === true ? true : 'w1 before close=' + ok]);
            });
          }
        } catch (err) {
          results.push(['mwError', 'ERR: ' + String(err && err.message ? err.message : err)]);
        } finally {
          try { win2.destroy(); } catch { /* 已销毁 */ }
          // 清理多窗口测试文件 + 会话污染（win2 关闭时可能写入其会话）
          await win.webContents.executeJavaScript(`(async () => {
            window.__app.editor.closeAll();
            await window.api.setSettings({ lastSession: null });
            window.__app.state.settings = await window.api.getSettings();
            return true;
          })()`).catch(() => {});
        }
      }
      // ================= v0.5.0 多视图 Phase 2「左右双栏分屏」：7 项端到端回归 =================
      // 位置：mw* 多窗口段之后、rcDir* 段之前。rcDir* 会起子进程 / 改写侧栏根并断言 `.tab` 总数，
      // 因此分屏用例必须排在它前面，且**每条用例收尾都把栏数收回 1**（不把双栏状态留给后面的用例）。
      // 断言口径：全部落在**渲染事实**（#editor-panes 的栏数 / 两栏各自 .pane-tabs 的 .tab 数量 /
      // 两个 .cm-editor 的几何尺寸与 scrollTop / .active-pane 去饱和类 / 分隔条拖动后的真实宽度）
      // 或**磁盘事实**（window.api.getSettings() 读回的 lastSession 结构）上 —— 不断言内部 flag。
      {
        const SP_A = path.join(TEST_ROOT, 'split-a.md');
        const SP_B = path.join(TEST_ROOT, 'split-b.md');
        const SP_C = path.join(TEST_ROOT, 'split-c.md');
        const SP_FILES = [SP_A, SP_B, SP_C];
        // 夹具：220 行足以让两栏各自产生可滚动的高度（独立滚动断言需要 scrollHeight > clientHeight）
        for (let i = 0; i < SP_FILES.length; i++) {
          const body = Array.from({ length: 220 }, (_, n) => `分屏夹具 ${i + 1} · 第 ${n + 1} 行 内容 content`).join('\n') + '\n';
          fs.writeFileSync(SP_FILES[i], body, 'utf8');
        }
        const sleepS = (ms) => new Promise((r) => setTimeout(r, ms));
        /** 取值型求值：表达式结果会被**结构化克隆**回主进程 —— 只能返回原始值/纯对象/纯数组 */
        const W = (code) => win.webContents.executeJavaScript(code);
        /** 副作用型求值：只改渲染端状态、**不取回值**。
         *  ⚠️ 必须走这个包装：`openFile()` 返回的是 tab 文档对象（内含 `EditorView`/DOM 引用），
         *  裸调 `W('window.__app.editor.openFile(p)')` 会让 executeJavaScript 去克隆它并抛
         *  `An object could not be cloned.`（Phase 2 首轮验收里 6 个 split* 用例全 ERR 的根因）。
         *  这里包成 async IIFE：**await 表达式**后再返回 undefined，既不克隆文档对象、又不丢等待语义。 */
        const Wv = (expr) => win.webContents.executeJavaScript(`(async () => { await (${expr}); })()`);
        const splitCase = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        // 每条用例前/后的统一收尾：先合栏再关标签（顺序反了会把「关最后一个标签自动撤栏」的路径也走一遍，
        // 那样测的就不是本条用例的语义了）。返回收尾后的栏数，便于在证据里记录。
        const resetPanes = async () => {
          const n = await W(`(() => {
            const e = window.__app.editor;
            if (e.getPaneCount() > 1) e.mergePanes();
            e.closeAll();
            return e.getPaneCount();
          })()`).catch(() => -1);
          await sleepS(120);
          return n;
        };
        // 双栏布局快照（全部来自真实 DOM 几何）
        const LAYOUT = `(() => {
          const e = window.__app.editor;
          const panesRoot = document.getElementById('editor-panes');
          const kids = Array.from(panesRoot.children);
          const roots = kids.filter((el) => el.classList.contains('pane'));
          const div = kids.find((el) => el.classList.contains('pane-divider')) || null;
          const cms = roots.map((r) => r.querySelector('.editor-host > .cm-editor'));
          const hosts = roots.map((r) => r.querySelector('.editor-host'));
          const bars = roots.map((r) => r.querySelector('.pane-tabs'));
          const bodies = roots.map((r) => r.querySelector('.pane-body'));
          return {
            layout: e.getPaneLayout(),
            rootCount: roots.length,
            divider: !!div,
            dividerW: div ? Math.round(div.getBoundingClientRect().width) : 0,
            paneW: roots.map((r) => Math.round(r.getBoundingClientRect().width)),
            cmCount: cms.filter(Boolean).length,
            cmH: cms.map((c) => (c ? Math.round(c.getBoundingClientRect().height) : 0)),
            cmHidden: cms.map((c) => (c ? getComputedStyle(c).display === 'none' : true)),
            hostHuge: hosts.map((h) => (h ? h.classList.contains('huge-active') : false)),
            tabCounts: bars.map((b) => (b ? b.querySelectorAll('.tab').length : -1)),
            tabNames: bars.map((b) => Array.from(b ? b.querySelectorAll('.tab') : []).map((t) => (t.querySelector('.tab-name') || {}).textContent || '')),
            activeInBar: bars.map((b) => {
              const a = b ? b.querySelector('.tab.active') : null;
              return a ? ((a.querySelector('.tab-name') || {}).textContent || '') : null;
            }),
            activePaneCount: roots.filter((r) => r.classList.contains('active-pane')).length,
            activePaneIdx: roots.findIndex((r) => r.classList.contains('active-pane')),
            focusInPane: roots.findIndex((r) => r.contains(document.activeElement)),
            scrollTops: bodies.map((b) => {
              const sc = b ? b.querySelector('.cm-scroller') : null;
              return sc ? Math.round(sc.scrollTop) : -1;
            }),
            scrollable: bodies.map((b) => {
              const sc = b ? b.querySelector('.cm-scroller') : null;
              return sc ? sc.scrollHeight - sc.clientHeight : -1;
            }),
            p0HostId: hosts[0] ? hosts[0].id : null,
            p1HostId: hosts[1] ? hosts[1].id : null,
            tabsIdP0: bars[0] ? bars[0].id : null,
          };
        })()`;
        // 文档 → 栏（渲染端真实归属，不是内部 flag 的镜像）
        const DOC_PANE = (p) => `(() => { const t = window.__app.editor.findTabByPath(${JSON.stringify(p)}); return t ? window.__app.editor.paneIdOf(t) : null; })()`;

        try {
          // ---------- 1. splitBasic：两栏渲染 + 两栏各自一个 CM + 滚动互不影响 ----------
          await splitCase('splitBasic', async () => {
            await resetPanes();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_A)})`);
            await sleepS(250);
            const one = await W(LAYOUT);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleepS(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_B)})`);
            await sleepS(350);
            const s = await W(LAYOUT);
            // 独立滚动：只滚左栏，右栏 scrollTop 不动
            const scrolled = await W(`(() => {
              const e = window.__app.editor;
              const a = e.getPaneEls(0).view.scrollDOM;
              const b = e.getPaneEls(1).view.scrollDOM;
              const before = b.scrollTop;
              a.scrollTop = 260;
              return { a: Math.round(a.scrollTop), bBefore: Math.round(before), bAfter: Math.round(b.scrollTop) };
            })()`);
            await sleepS(150);
            const after = await W(LAYOUT);
            const twoCm = s.cmCount === 2 && s.cmH.every((h) => h > 100) && s.cmHidden.every((v) => v === false);
            const twoPanes = s.rootCount === 2 && s.divider === true;
            const bVisible = s.paneW.length === 2 && s.paneW.every((w) => w > 200);
            const indepTabs = s.tabCounts[0] === 1 && s.tabCounts[1] === 1 && s.tabNames[0][0] !== s.tabNames[1][0];
            const indepScroll = scrolled.a > 0 && scrolled.bAfter === scrolled.bBefore && after.scrollTops[1] === scrolled.bAfter;
            const ok = one.rootCount === 1 && twoPanes && twoCm && bVisible && indepTabs && indepScroll;
            return {
              ok,
              detail: 'onePane=' + one.rootCount + ',twoPanes=' + twoPanes + ',twoCm=' + twoCm + ',paneW=' + JSON.stringify(s.paneW) +
                ',tabs=' + JSON.stringify(s.tabNames) + ',indepScroll=' + indepScroll + '(' + JSON.stringify(scrolled) + ')',
              evidence: 'cmH=' + JSON.stringify(s.cmH) + ' cmHidden=' + JSON.stringify(s.cmHidden) +
                ' scrollTops=' + JSON.stringify(after.scrollTops) + ' scrollable=' + JSON.stringify(s.scrollable) +
                ' dividerW=' + s.dividerW + ' layout=' + JSON.stringify(s.layout.panes),
            };
          });

          // ---------- 2. splitIndependentTabs：两栏各自标签栏（数量/高亮/点击不互相影响） ----------
          await splitCase('splitIndependentTabs', async () => {
            await resetPanes();
            await W(`(async () => { const e = window.__app.editor; await e.openFile(${JSON.stringify(SP_A)}); await e.openFile(${JSON.stringify(SP_C)}); })()`);
            await sleepS(350);
            const before = await W(LAYOUT);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleepS(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_B)})`);
            await sleepS(300);
            const s = await W(LAYOUT);
            // 点左栏的第一个标签（切换左栏活动项）→ 右栏高亮必须原样不动
            const afterClick = await W(`(() => {
              const e = window.__app.editor;
              const bar0 = e.getPaneEls(0).tabsEl;
              const p1Before = e.getPaneLayout().panes[1].active;
              bar0.querySelectorAll('.tab')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
              const p1After = e.getPaneLayout().panes[1].active;
              return { p1Before, p1After, p0: e.getPaneLayout().panes[0].active };
            })()`);
            await sleepS(200);
            const s2 = await W(LAYOUT);
            const barsSeparate = s.tabCounts[0] === 2 && s.tabCounts[1] === 1;
            const highlightPerPane = s.activeInBar[0] !== null && s.activeInBar[1] !== null && s.activeInBar[0] !== s.activeInBar[1];
            const clickIsolated = afterClick.p1Before === afterClick.p1After;
            const docHome = (await W(DOC_PANE(SP_A))) === 'p0' && (await W(DOC_PANE(SP_C))) === 'p0' && (await W(DOC_PANE(SP_B))) === 'p1';
            const p0DomKeepsId = s.p0HostId === 'editor-host' && s.tabsIdP0 === 'tabs' && !s.p1HostId;
            const ok = before.rootCount === 1 && barsSeparate && highlightPerPane && clickIsolated && docHome && p0DomKeepsId;
            return {
              ok,
              detail: 'bars=' + JSON.stringify(s.tabCounts) + ',highlight=' + JSON.stringify(s.activeInBar) +
                ',clickIsolated=' + clickIsolated + ' (' + afterClick.p1Before + '→' + afterClick.p1After + ')' +
                ',docHome=' + docHome + ',p0DomKeepsId=' + p0DomKeepsId,
              evidence: 'names=' + JSON.stringify(s.tabNames) + ' p0HostId=' + s.p0HostId + ' p1HostId=' + s.p1HostId +
                ' tabsIdP0=' + s.tabsIdP0 + ' p0Active=' + afterClick.p0 + ' tabCountsAfter=' + JSON.stringify(s2.tabCounts),
            };
          });

          // ---------- 3. splitDragDrop：拖标签到编辑区右边缘 → 该侧开栏 ----------
          await splitCase('splitDragDrop', async () => {
            await resetPanes();
            await W(`(async () => { const e = window.__app.editor; await e.openFile(${JSON.stringify(SP_A)}); await e.openFile(${JSON.stringify(SP_C)}); })()`);
            await sleepS(350);
            const dropped = await W(`(() => {
              const e = window.__app.editor;
              const body = e.getPaneEls(0).body;
              const tabs = e.getPaneEls(0).tabsEl.querySelectorAll('.tab');
              const target = tabs[tabs.length - 1]; // 拖第 2 个标签（split-c.md）
              const name = (target.querySelector('.tab-name') || {}).textContent;
              const r = body.getBoundingClientRect();
              const x = r.left + r.width * 0.88; // 右侧 30% 区间内 → 「该侧开栏」
              const y = r.top + r.height * 0.4;
              const dt = new DataTransfer();
              target.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
              const hintRight = body.classList.contains('pane-drop-right');
              body.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
              const hintAfterOver = body.classList.contains('pane-drop-right');
              body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
              target.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
              return { name, hintRight, hintAfterOver, panes: e.getPaneCount(), layout: e.getPaneLayout() };
            })()`);
            await sleepS(300);
            const s = await W(LAYOUT);
            const bPane = await W(DOC_PANE(SP_C));
            const aPane = await W(DOC_PANE(SP_A));
            const opened = dropped.panes === 2 && s.rootCount === 2 && s.divider === true;
            const moved = bPane === 'p1' && aPane === 'p0';
            const hint = dropped.hintAfterOver === true;
            const focusedNew = dropped.layout.focused === 'p1';
            const ok = opened && moved && hint && focusedNew && s.tabCounts[0] === 1 && s.tabCounts[1] === 1;
            return {
              ok,
              detail: 'panes=' + dropped.panes + ',moved=' + moved + '(A=' + aPane + ',C=' + bPane + '),hint=' + hint +
                ',focusedNew=' + focusedNew + ',tabs=' + JSON.stringify(s.tabCounts),
              evidence: 'dragged=' + dropped.name + ' hintBeforeOver=' + dropped.hintRight + ' hintAfterOver=' + dropped.hintAfterOver +
                ' names=' + JSON.stringify(s.tabNames) + ' paneW=' + JSON.stringify(s.paneW) + ' cmCount=' + s.cmCount,
            };
          });

          // ---------- 4. splitResize：拖分隔条改比例 + 最小宽度夹取 + 双击等分 ----------
          await splitCase('splitResize', async () => {
            await resetPanes();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_A)})`);
            await sleepS(250);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleepS(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_B)})`);
            await sleepS(300);
            const drag = async (dx) => W(`(() => {
              const div = document.querySelector('.pane-divider');
              const r = div.getBoundingClientRect();
              const x0 = r.left + r.width / 2;
              const y0 = r.top + r.height / 2;
              div.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x0, clientY: y0 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x0 + (${dx}), clientY: y0 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x0 + (${dx}), clientY: y0 }));
              const L = window.__app.editor.getPaneLayout();
              return { w: L.panes.map((p) => p.width), ratio: +L.ratio.toFixed(4), dragging: div.classList.contains('dragging') };
            })()`);
            const base = await W(LAYOUT);
            const widened = await drag(140);
            const clampedLeft = await drag(-4000);
            const clampedRight = await drag(8000);
            const equalized = await W(`(() => {
              document.querySelector('.pane-divider').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
              const L = window.__app.editor.getPaneLayout();
              return { w: L.panes.map((p) => p.width), ratio: +L.ratio.toFixed(4) };
            })()`);
            const usable = base.paneW[0] + base.paneW[1];
            const grew = widened.w[0] > base.paneW[0] + 100;
            // 最小宽度：夹取后两栏都 ≥ 200px（MIN_PANE_PX），且没有某一栏被压成 0
            const minHeld = clampedLeft.w[0] >= 199 && clampedLeft.w[1] >= 199 && clampedRight.w[0] >= 199 && clampedRight.w[1] >= 199;
            const noOverflow = Math.abs((clampedLeft.w[0] + clampedLeft.w[1]) - usable) <= 2;
            const equal = equalized.ratio > 0.42 && equalized.ratio < 0.58;
            const ok = base.rootCount === 2 && grew && minHeld && noOverflow && equal && widened.dragging === false;
            return {
              ok,
              detail: 'base=' + JSON.stringify(base.paneW) + ',widen+140=' + JSON.stringify(widened.w) + ' (grew=' + grew + ')' +
                ',clampLeft=' + JSON.stringify(clampedLeft.w) + ',clampRight=' + JSON.stringify(clampedRight.w) + ' (minHeld=' + minHeld + ')' +
                ',equalize=' + JSON.stringify(equalized.w) + ' ratio=' + equalized.ratio + ' (equal=' + equal + ') noOverflow=' + noOverflow,
              evidence: 'usable=' + usable + ' dividerW=' + base.dividerW + ' ratios=' + JSON.stringify([widened.ratio, clampedLeft.ratio, clampedRight.ratio]) +
                ' draggingClassLeaked=' + widened.dragging,
            };
          });

          // ---------- 5. splitFocusKeys：Ctrl+2 / Ctrl+1 聚焦栏、Ctrl+\ 分屏与合屏 ----------
          await splitCase('splitFocusKeys', async () => {
            await resetPanes();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_A)})`);
            await sleepS(250);
            const key = (k, extra) => `(() => {
              document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, code: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(extra || {})})));
              const e = window.__app.editor;
              const roots = Array.from(document.getElementById('editor-panes').children).filter((el) => el.classList.contains('pane'));
              return { panes: e.getPaneCount(), focus: e.getFocusPaneId(), activePaneIdx: roots.findIndex((r) => r.classList.contains('active-pane')),
                focusInPane: roots.findIndex((r) => r.contains(document.activeElement)) };
            })()`;
            const beforeKey = await W(LAYOUT);
            const splitByKey = await W(key('\\', { ctrlKey: true }));
            await sleepS(250);
            const opened = splitByKey.panes === 2 && splitByKey.focus === 'p1';
            // 右栏开个文件后，Ctrl+1 回左栏、Ctrl+2 再回右栏；焦点 DOM 元素要跟着走
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_B)})`);
            await sleepS(300);
            const toP0 = await W(key('1', { ctrlKey: true }));
            await sleepS(120);
            const toP1 = await W(key('2', { ctrlKey: true }));
            await sleepS(120);
            const s = await W(LAYOUT);
            const merged = await W(key('\\', { ctrlKey: true }));
            await sleepS(250);
            const sAfter = await W(LAYOUT);
            const focusWorks = toP0.focus === 'p0' && toP0.activePaneIdx === 0 && toP0.focusInPane === 0 &&
              toP1.focus === 'p1' && toP1.activePaneIdx === 1 && toP1.focusInPane === 1;
            const oneActivePane = s.activePaneCount === 1 && s.activePaneIdx === 1;
            const mergeOk = merged.panes === 1 && sAfter.rootCount === 1 && sAfter.divider === false && sAfter.activePaneIdx === 0;
            // 合栏后文档不丢：两个文件仍在（标签全部并回 p0）
            const kept = sAfter.tabCounts[0] === 2 && (await W(DOC_PANE(SP_A))) === 'p0' && (await W(DOC_PANE(SP_B))) === 'p0';
            const ok = beforeKey.rootCount === 1 && opened && focusWorks && oneActivePane && mergeOk && kept;
            return {
              ok,
              detail: 'splitKey=' + opened + '(focus=' + splitByKey.focus + '),focusWorks=' + focusWorks +
                ',oneActivePane=' + oneActivePane + ',merge=' + mergeOk + ',docsKept=' + kept,
              evidence: 'toP0=' + JSON.stringify(toP0) + ' toP1=' + JSON.stringify(toP1) + ' merged=' + JSON.stringify(merged) +
                ' afterTabs=' + JSON.stringify(sAfter.tabCounts) + ' afterNames=' + JSON.stringify(sAfter.tabNames),
            };
          });

          // ---------- 6. splitCloseLast：关掉右栏最后一个标签 → 该栏撤掉，回落单栏 ----------
          await splitCase('splitCloseLast', async () => {
            await resetPanes();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_A)})`);
            await sleepS(250);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleepS(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_B)})`);
            await sleepS(300);
            const before = await W(LAYOUT);
            // 点右栏那个标签的 ✕（真实用户动作，而不是直接调 closeTab）
            const closed = await W(`(() => {
              const e = window.__app.editor;
              const tabs = e.getPaneEls(1).tabsEl.querySelectorAll('.tab');
              const name = (tabs[0].querySelector('.tab-name') || {}).textContent;
              tabs[0].querySelector('.tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { name, panes: e.getPaneCount(), focus: e.getFocusPaneId() };
            })()`);
            await sleepS(300);
            const s = await W(LAYOUT);
            // 只取回字符串（不裸返回 tab 对象 —— 那会被结构化克隆拒收，见 Wv 的说明）
            const survivor = await W(`(() => { const t = window.__app.editor.getActiveTab(); return t ? t.name : null; })()`);
            const collapsed = s.rootCount === 1 && s.divider === false;
            const survivorOk = survivor === 'split-a.md';
            const hostIdOk = s.p0HostId === 'editor-host' && s.tabsIdP0 === 'tabs';
            const singleCm = s.cmCount === 1;
            const ok = before.rootCount === 2 && closed.panes === 1 && collapsed && survivorOk && hostIdOk && singleCm;
            return {
              ok,
              detail: 'before=' + before.rootCount + ',closedPanes=' + closed.panes + ',collapsed=' + collapsed +
                ',survivor=' + survivor + ',hostIdOk=' + hostIdOk + ',singleCm=' + singleCm,
              evidence: 'closedTab=' + closed.name + ' focusAfter=' + s.focus + ' afterNames=' + JSON.stringify(s.tabNames) +
                ' afterTabs=' + JSON.stringify(s.tabCounts) + ' cmH=' + JSON.stringify(s.cmH),
            };
          });

          // ---------- 7. splitSessionShape：会话结构（内存 + 磁盘）—— 双栏文件都在 + Phase 3 起有 layout ----------
          // Phase 3 变更（施工简报 §7-R7 预警）：会话 schema 从三键扩成"三键 + layout"。
          // 三键**一个都没删**（旧版本仍读得懂），layout 是新增的布局快照；这里同步把断言改成
          // 「三键仍在**且** layout 出现**且** layout 形状与当前两栏一致」。
          await splitCase('splitSessionShape', async () => {
            await resetPanes();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_A)})`);
            await sleepS(250);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleepS(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SP_B)})`);
            await sleepS(300);
            const mem = await W(`(() => { const s = window.__app.editor.getSession(); return { keys: Object.keys(s).sort(), paths: s.paths, active: s.active, pinned: s.pinned, focused: window.__app.editor.getFocusPaneId(), layout: s.layout }; })()`);
            const disk = await W(`(async () => {
              window.__app.session.save();
              await new Promise((r) => setTimeout(r, 500));
              const st = await window.api.getSettings();
              const ls = st.lastSession;
              return { hasFocus: document.hasFocus(), ls: ls ? { keys: Object.keys(ls).sort(), paths: ls.paths, active: ls.active, pinned: ls.pinned, layout: ls.layout || null } : null };
            })()`);
            const expectKeys = JSON.stringify(['active', 'layout', 'paths', 'pinned']);
            const memShape = JSON.stringify(mem.keys) === expectKeys;
            const memHasBoth = mem.paths.length === 2 && mem.paths.includes(SP_A) && mem.paths.includes(SP_B);
            // active 下标指向**焦点栏**的活动文档（Phase 2 口径未变）
            const memActive = mem.paths[mem.active] === SP_B && mem.focused === 'p1';
            // layout（Phase 3 新增）：两栏 + 每栏各一个文档 + 焦点栏下标 = 1 + 比例归一化
            const L = mem.layout;
            const memLayout = !!L && L.orientation === 'h' && Array.isArray(L.panes) && L.panes.length === 2 &&
              L.panes[0].docs.includes(SP_A) && L.panes[1].docs.includes(SP_B) && L.focus === 1 &&
              Array.isArray(L.sizes) && L.sizes.length === 2 && Math.abs(L.sizes[0] + L.sizes[1] - 1) < 0.01;
            // paths 是**文档级去重**：同一文件不会因多栏而重复
            const memDedupe = new Set(mem.paths).size === mem.paths.length;
            const diskShape = !!disk.ls && JSON.stringify(disk.ls.keys) === expectKeys;
            const diskHasBoth = !!disk.ls && disk.ls.paths.length === 2 && disk.ls.paths.includes(SP_A) && disk.ls.paths.includes(SP_B);
            const hasLayout = !!disk.ls && !!disk.ls.layout && Array.isArray(disk.ls.layout.panes) && disk.ls.layout.panes.length === 2;
            const ok = memShape && memHasBoth && memActive && memLayout && memDedupe && diskShape && diskHasBoth && hasLayout;
            return {
              ok,
              detail: 'mem.keys=' + JSON.stringify(mem.keys) + ',mem.paths=' + mem.paths.length + ',mem.active=' + mem.active +
                '(=' + mem.paths[mem.active] + '),memLayout=' + memLayout + ',dedupe=' + memDedupe +
                ',disk.keys=' + JSON.stringify(disk.ls && disk.ls.keys) + ',disk.paths=' + (disk.ls ? disk.ls.paths.length : 'null') +
                ',diskLayout=' + hasLayout,
              evidence: 'memPaths=' + JSON.stringify(mem.paths) + ' diskPaths=' + JSON.stringify(disk.ls && disk.ls.paths) +
                ' layout=' + JSON.stringify(L) + ' diskActive=' + (disk.ls && disk.ls.active) + ' hasFocus=' + disk.hasFocus,
            };
          });
        } finally {
          // 收尾：合栏 + 清标签 + 删夹具（rcDir* 段随后会断言 `.tab` 总数并起子进程，必须看到干净的单栏窗口）
          await resetPanes().catch(() => {});
          for (const f of SP_FILES) {
            try { fs.rmSync(f, { force: true }); } catch { /* 已被删则忽略 */ }
          }
        }
      }

      // ================= v0.5.0 多视图 Phase 3「同文件多视图 + 布局持久化」：7 项端到端回归 =================
      // 位置：Phase 2 split* 段之后、rcDir* 段之前（同样的位置约束：rcDir* 会断言 .tab 总数并起子进程）。
      // 断言口径全部落在**渲染事实**（#editor-panes 的栏数 / 两栏 .pane-tabs 的 .tab 与名称 /
      // 两个 .cm-editor 的几何与 textContent / 两个 EditorView 的 state.doc 逐字符相等 / 两个 view
      // 对象的身份 / .cm-scroller 的 scrollTop / 选区 head / #modal-mask 显隐）与**磁盘事实**
      // （fs 直读夹具文件、window.api.getSettings().lastSession 的 layout）上。
      // 每条用例首尾都收尾（合栏 + closeAll），不把双栏/多视图状态留给后续用例。
      {
        const SF_A = path.join(TEST_ROOT, 'same-a.md');
        const SF_B = path.join(TEST_ROOT, 'same-b.md');
        // huge 负向断言用夹具：60MB 真实文本（>16MB 的 overlay 下限；见上方建仓的 big-a.bin），
        // 用例内临时把 huge 阈值降到 10MB 并抬高打开上限，finally 逐字复原。
        const SF_HUGE = path.join(TEST_ROOT, 'build', 'big-a.bin');
        const SF_FILES = [SF_A, SF_B];
        for (let i = 0; i < SF_FILES.length; i++) {
          const body = Array.from({ length: 220 }, (_, n) => '同文件夹具 ' + (i + 1) + ' · 第 ' + (n + 1) + ' 行 content').join('\n') + '\n';
          fs.writeFileSync(SF_FILES[i], body, 'utf8');
        }
        const SF_ORIG_A = fs.readFileSync(SF_A, 'utf8');
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        /** 取值型求值：只返回原始值/纯对象（裸返回 tab/DOM/EditorView 会被结构化克隆拒收） */
        const W = (code) => win.webContents.executeJavaScript(code);
        /** 副作用型求值：只改渲染端状态、不取回值（openFile/attach 返回的是文档对象） */
        const Wv = (expr) => win.webContents.executeJavaScript(`(async () => { await (${expr}); })()`);
        const mvCase = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        // 收尾：先合栏再清标签（顺序反了会把「关最后一个标签自动撤栏」的路径也走一遍）
        const resetAll = async () => {
          const n = await W(`(() => {
            const e = window.__app.editor;
            if (e.getPaneCount() > 1) e.mergePanes();
            e.closeAll();
            return e.getPaneCount();
          })()`).catch(() => -1);
          await sleep(140);
          return n;
        };
        // 两栏渲染快照（栏数/几何/CM 文本/两个文档内容/滚动/空态/模态显隐，全部来自真实 DOM 或 view.state）
        const SNAP = `(() => {
          const e = window.__app.editor;
          const root = document.getElementById('editor-panes');
          const kids = Array.from(root.children);
          const paneEls = kids.filter((el) => el.classList.contains('pane'));
          const div = kids.find((el) => el.classList.contains('pane-divider')) || null;
          const cms = paneEls.map((p) => p.querySelector('.editor-host > .cm-editor'));
          const scs = paneEls.map((p) => p.querySelector('.cm-scroller'));
          const n = e.getPaneCount();
          const docs = [];
          const views = [];
          for (let i = 0; i < n; i++) {
            const pe = e.getPaneEls(i);
            const v = pe && pe.view ? pe.view : null;
            views.push(v);
            docs.push(v ? v.state.doc.toString() : null);
          }
          return {
            rootCount: paneEls.length,
            paneCount: n,
            divider: !!div,
            paneW: paneEls.map((p) => Math.round(p.getBoundingClientRect().width)),
            cmCount: cms.filter(Boolean).length,
            cmH: cms.map((c) => (c ? Math.round(c.getBoundingClientRect().height) : 0)),
            cmTextLen: cms.map((c) => (c ? c.textContent.length : -1)),
            docLens: docs.map((t) => (t === null ? -1 : t.length)),
            docSame: n === 2 && docs[0] !== null && docs[0] === docs[1],
            viewSame: n === 2 && views[0] === views[1],
            scrollTops: scs.map((s) => (s ? Math.round(s.scrollTop) : -1)),
            scrollable: scs.map((s) => (s ? s.scrollHeight - s.clientHeight : -1)),
            layout: e.getPaneLayout(),
            emptyVisible: paneEls.map((p) => { const em = p.querySelector('.editor-empty'); return !!em && !em.classList.contains('hidden'); }),
            modalHidden: document.getElementById('modal-mask').classList.contains('hidden'),
            focus: e.getFocusPaneId(),
          };
        })()`;
        // 建立「同一文件两栏各一个视图」：p0 开 → 分屏 → 新栏用 forceNew 再开同一文件（同一 Document）
        const openTwoViews = async (p) => {
          await Wv(`window.__app.editor.openFile(${JSON.stringify(p)})`);
          await sleep(260);
          await Wv(`window.__app.editor.toggleSplit()`);
          await sleep(200);
          await Wv(`window.__app.editor.openFile(${JSON.stringify(p)}, { forceNew: true })`);
          await sleep(360);
        };
        // toast 记录器（提示只活 ~1.9s，靠 MutationObserver 才拿得稳；本段内多个用例读它）
        const HINT = '撤销按栏独立';
        const TOAST_REC = `(() => {
          if (window.__mhToastRec) { window.__mhToastRec.length = 0; return 'reset'; }
          window.__mhToastRec = [];
          const push = (el) => { try { if (el && el.classList && el.classList.contains('toast')) window.__mhToastRec.push(el.textContent); } catch (e) {} };
          const mo = new MutationObserver((ms) => {
            for (const m of ms) for (const n of m.addedNodes) { push(n); if (n && n.querySelectorAll) n.querySelectorAll('.toast').forEach(push); }
          });
          mo.observe(document, { childList: true, subtree: true });
          document.querySelectorAll('.toast').forEach(push);
          return 'ok';
        })()`;
        // 自动保存延迟临时调大：本段的断言依赖「编辑后磁盘未变」，不能被 800ms 的自动保存抢跑
        let prevAutoSave = null;
        try {
          prevAutoSave = await W('window.api.getSettings().then((s) => s.autoSaveDelay)').catch(() => null);
          await W(`(async () => { await window.api.setSettings({ autoSaveDelay: 30000 }); window.__app.state.settings = await window.api.getSettings(); return true; })()`);
          await W(TOAST_REC);

          // ---------- 1. sameFileTwoPanes：同一文件在两栏各一个视图（独立 state + 独立滚动/光标） ----------
          await mvCase('sameFileTwoPanes', async () => {
            await resetAll();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SF_A)})`);
            await sleep(260);
            const one = await W(SNAP);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleep(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SF_A)}, { forceNew: true })`);
            await sleep(360);
            const s = await W(SNAP);
            // 独立滚动：只滚左栏
            const sc = await W(`(() => {
              const e = window.__app.editor;
              const a = e.getPaneEls(0).view.scrollDOM;
              const b = e.getPaneEls(1).view.scrollDOM;
              const b0 = Math.round(b.scrollTop);
              a.scrollTop = 300;
              return { a: Math.round(a.scrollTop), b0: b0 };
            })()`);
            await sleep(200);
            const s2 = await W(SNAP);
            // 独立光标：只动左栏（右栏 head 必须还是 0）
            const sel = await W(`(() => {
              const e = window.__app.editor;
              e.getPaneEls(0).view.dispatch({ selection: { anchor: 100 } });
              return { left: e.getPaneEls(0).view.state.selection.main.head, right: e.getPaneEls(1).view.state.selection.main.head };
            })()`);
            // ---- 负向断言（硬口径 ①）：**禁止两个 huge 视图看同一文件** ----
            // overlay 编辑会话是路径单例（overlay-ipc 的 handles/pathToId/locks）：第二次同文件打开
            // 必须被拒绝并回落「聚焦已有栏 + toast」，绝不新开第二个 huge 视图。
            let neg = null;
            let prevMaxMB = null;
            try {
              prevMaxMB = await W('window.api.getSettings().then((s) => s.maxFileSizeMB)').catch(() => null);
              await resetAll();
              await W(`(async () => {
                await window.api.setSettings({ maxFileSizeMB: 4096 });
                window.__app.state.settings = await window.api.getSettings();
                window.__app.editor.setHugeThresholdMB(10);
                return true;
              })()`);
              await Wv(`window.__app.editor.openFile(${JSON.stringify(SF_HUGE)})`);
              await sleep(1200);
              await Wv(`window.__app.editor.toggleSplit()`);
              await sleep(200);
              neg = await W(`(async () => {
                const e = window.__app.editor;
                const before = (window.__mhToastRec || []).length;
                await e.openFile(${JSON.stringify(SF_HUGE)}, { forceNew: true });
                await new Promise((r) => setTimeout(r, 300));
                const t = e.findTabByPath(${JSON.stringify(SF_HUGE)});
                const L = e.getPaneLayout();
                return {
                  kind: t ? t.kind : null,
                  homes: t ? e.panesOfDoc(t).length : -1,
                  views: t ? e.viewCountOf(t) : -1,
                  p1Docs: L.panes[1] ? L.panes[1].docs : -1,
                  paneCount: e.getPaneCount(),
                  focus: e.getFocusPaneId(),
                  toasts: (window.__mhToastRec || []).slice(before)
                };
              })()`);
            } catch (err) {
              neg = { err: String(err && err.message ? err.message : err) };
            } finally {
              await resetAll().catch(() => {});
              const restoreMB = Number.isFinite(Number(prevMaxMB)) && Number(prevMaxMB) > 0 ? Math.floor(Number(prevMaxMB)) : 50;
              await W(`(async () => {
                await window.api.setSettings({ maxFileSizeMB: ${restoreMB} });
                window.__app.state.settings = await window.api.getSettings();
                window.__app.editor.setHugeThresholdMB(1024);
                return true;
              })()`).catch(() => {});
            }
            const refused = !!neg && !neg.err && (neg.toasts || []).some((x) => String(x).indexOf('大文件视图不支持同文件多视图') >= 0);
            const hugeNeg = refused && neg.kind === 'huge' && neg.homes === 1 && neg.views === 1 && neg.p1Docs === 0 && neg.paneCount === 2 && neg.focus === 'p0';
            const twoPanes = one.rootCount === 1 && s.rootCount === 2 && s.divider === true;
            const twoCm = s.cmCount === 2 && s.cmH.every((h) => h > 100) && s.cmTextLen.every((n) => n > 0) && s.cmTextLen[0] === s.cmTextLen[1];
            const sameFile = s.layout.panes.length === 2 && s.layout.panes[0].path === SF_A && s.layout.panes[1].path === SF_A && s.docSame === true;
            const diffViews = s.viewSame === false;
            const indepScroll = sc.a > 0 && sc.b0 === 0 && s2.scrollTops[0] > 100 && Math.abs(s2.scrollTops[1]) <= 2;
            const indepCaret = sel.left === 100 && sel.right === 0;
            const wide = s.paneW.length === 2 && s.paneW.every((w) => w >= 199);
            const ok = twoPanes && twoCm && sameFile && diffViews && indepScroll && indepCaret && wide && hugeNeg;
            return {
              ok,
              detail: 'onePane=' + one.rootCount + ',twoPanes=' + twoPanes + '(rootCount=' + s.rootCount + ',divider=' + s.divider + ')' +
                ',twoCm=' + twoCm + ',sameFile=' + sameFile + ',diffViews=' + diffViews +
                ',indepScroll=' + indepScroll + '(' + JSON.stringify(sc) + '→' + JSON.stringify(s2.scrollTops) + ')' +
                ',indepCaret=' + indepCaret + '(' + JSON.stringify(sel) + '),wide=' + wide + '(' + JSON.stringify(s.paneW) + ')' +
                ',hugeNeg=' + hugeNeg + (neg ? '(' + JSON.stringify(neg) + ')' : ''),
              evidence: 'cmH=' + JSON.stringify(s.cmH) + ' cmTextLen=' + JSON.stringify(s.cmTextLen) +
                ' docLens=' + JSON.stringify(s.docLens) + ' scrollable=' + JSON.stringify(s.scrollable) +
                ' layoutPanes=' + JSON.stringify(s.layout.panes) + ' focus=' + s.focus,
            };
          });

          // ---------- 2. sameFileEditSync：左改右看（内容实时一致、磁盘不动、脏标记只标一次） ----------
          await mvCase('sameFileEditSync', async () => {
            await resetAll();
            await openTwoViews(SF_A);
            // 广播是**异步**的（按文档串行的 Promise 队列，回调在微任务里跑）→ 派发后同一同步块里
            // 右栏必然还没追上（这是设计口径，不是缺陷）。这里只记录"左栏已变"，追平由下面的
            // 180ms 等待 + 内容断言负责；另测一次真实传播延迟（证据项）。
            const edit = await W(`(() => {
              const e = window.__app.editor;
              e.getPaneEls(0).view.dispatch({ changes: { from: 0, insert: 'X' } });
              return { leftHead: e.getPaneEls(0).view.state.doc.sliceString(0, 2), rightHead: e.getPaneEls(1).view.state.doc.sliceString(0, 2) };
            })()`);
            const lag = await W(`(async () => {
              const e = window.__app.editor;
              const t0 = Date.now();
              const L = e.getPaneEls(0).view.state.doc.toString();
              while (Date.now() - t0 < 800) {
                if (e.getPaneEls(1).view.state.doc.toString() === L) return Date.now() - t0;
                await new Promise((r) => setTimeout(r, 10));
              }
              return -1;
            })()`);
            await sleep(180);
            const sync = await W(`(() => {
              const e = window.__app.editor;
              const L = e.getPaneEls(0).view.state.doc.toString();
              const R = e.getPaneEls(1).view.state.doc.toString();
              const t = e.findTabByPath(${JSON.stringify(SF_A)});
              const s = e.getSession();
              return {
                same: L === R, len: L.length,
                bothX: L.charAt(0) === 'X' && R.charAt(0) === 'X',
                dirty: !!t && t.dirty === true,
                pathOnce: s.paths.filter((p) => p === ${JSON.stringify(SF_A)}).length,
                pathsTotal: s.paths.length
              };
            })()`);
            const diskAfter = fs.readFileSync(SF_A, 'utf8');
            // 反向：右栏输入 → 左栏跟着变
            const rev = await W(`(async () => {
              const e = window.__app.editor;
              const v = e.getPaneEls(1).view;
              v.dispatch({ changes: { from: v.state.doc.length, insert: 'Y' } });
              await new Promise((r) => setTimeout(r, 200));
              const L = e.getPaneEls(0).view.state.doc.toString();
              const R = e.getPaneEls(1).view.state.doc.toString();
              return { same: L === R, bothY: L.slice(-1) === 'Y' && R.slice(-1) === 'Y', len: L.length };
            })()`);
            // 连打 20 次（广播队列串行）：不得回环、不得丢/重字符
            const burst = await W(`(async () => {
              const e = window.__app.editor;
              const v = e.getPaneEls(0).view;
              for (let i = 0; i < 20; i++) v.dispatch({ changes: { from: v.state.doc.length, insert: 'q' } });
              await new Promise((r) => setTimeout(r, 320));
              const L = e.getPaneEls(0).view.state.doc.toString();
              const R = e.getPaneEls(1).view.state.doc.toString();
              return { same: L === R, diff: L.length - R.length, len: L.length };
            })()`);
            const noWrite = diskAfter === SF_ORIG_A;
            // 判定不含「同一同步块里右栏已追平」（那与异步广播的设计相悖，见上面的 edit 注释）；
            // 追平由 sync.same/bothX 断言，传播延迟只作证据
            const lenOk = sync.len === SF_ORIG_A.length + 1;
            const lagOk = lag >= 0 && lag <= 800;
            const burstLenOk = burst.len === sync.len + 21;
            const ok = sync.same && sync.bothX && lenOk && sync.dirty &&
              sync.pathOnce === 1 && sync.pathsTotal === 1 && lagOk &&
              noWrite && rev.same && rev.bothY && burst.same && burst.diff === 0 && burstLenOk;
            return {
              ok,
              detail: 'same=' + sync.same + '(len=' + sync.len + ',lenOk=' + lenOk + '),bothX=' + sync.bothX + ',dirty=' + sync.dirty +
                ',pathOnce=' + sync.pathOnce + '/' + sync.pathsTotal + ',syncLagMs=' + lag + '(lagOk=' + lagOk + ')' +
                ',noWrite=' + noWrite + ',rev=' + rev.same + '/' + rev.bothY + ',burst=' + burst.same + '(diff=' + burst.diff + ',len=' + burst.len + ',lenOk=' + burstLenOk + ')',
              evidence: 'headsSync=' + JSON.stringify(edit) + '（右栏落后是异步广播的预期：同一同步块内必然未追平）' +
                ' revLen=' + rev.len + ' diskBytes=' + diskAfter.length + '/' + SF_ORIG_A.length,
            };
          });

          // ---------- 3. sameFileUndo：**记录并断言当前语义**（撤销按栏独立，可能撤掉对方刚输入的内容） ----------
          await mvCase('sameFileUndo', async () => {
            await resetAll();
            await openTwoViews(SF_A);
            const rec = await W(`(async () => {
              const e = window.__app.editor;
              const L = e.getPaneEls(0).view, R = e.getPaneEls(1).view;
              L.dispatch({ changes: { from: L.state.doc.length, insert: 'A' } });
              await new Promise((r) => setTimeout(r, 160));
              R.dispatch({ changes: { from: R.state.doc.length, insert: 'B' } });
              await new Promise((r) => setTimeout(r, 220));
              const l0 = L.state.doc.toString(), r0 = R.state.doc.toString();
              const before = { same: l0 === r0, tail: l0.slice(-2), len: l0.length };
              // 左栏真实 Ctrl+Z（与 chunkUndoNoTruncate 同一手法：contentDOM 上的 KeyboardEvent）
              L.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, keyCode: 90, bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 300));
              const l1 = L.state.doc.toString(), r1 = R.state.doc.toString();
              const hints = (window.__mhToastRec || []).filter((x) => String(x).indexOf(${JSON.stringify(HINT)}) >= 0);
              return {
                before: before,
                afterSame: l1 === r1,
                afterLen: l1.length,
                leftTail: l1.slice(-1),
                rightTail: r1.slice(-1),
                rightLost: r1.slice(-1) !== 'B',
                leftShrank: l1.length < l0.length,
                hints: hints.length,
                hintText: hints.length ? hints[0] : '',
                modalHidden: document.getElementById('modal-mask').classList.contains('hidden')
              };
            })()`);
            // 「第二次分屏不再弹」：再完整走一遍"两栏同文件"的挂载
            await resetAll();
            await openTwoViews(SF_A);
            const hintsAfter = await W(`(window.__mhToastRec || []).filter((x) => String(x).indexOf(${JSON.stringify(HINT)}) >= 0).length`);
            // 当前语义（实测）：左栏 undo 把**右栏刚输入的 B** 一并撤掉，两栏内容仍然一致
            const u1_beforeSame = rec.before.same === true;
            const u2_beforeAB = rec.before.tail === 'AB';
            const u3_afterSame = rec.afterSame === true;
            const u4_rightLost = rec.rightLost === true;
            const u5_leftShrank = rec.leftShrank === true;
            const u6_noModal = rec.modalHidden === true;
            const undoSemantics = u1_beforeSame && u2_beforeAB && u3_afterSame && u4_rightLost && u5_leftShrank && u6_noModal;
            const h1_once = rec.hints === 1;
            const h2_text = rec.hintText.indexOf(HINT) >= 0;
            const h3_stillOnce = hintsAfter === 1;
            const hintOk = h1_once && h2_text && h3_stillOnce;
            const ok = undoSemantics && hintOk;
            return {
              ok,
              detail: 'undoSemantics=' + undoSemantics +
                '[beforeSame=' + u1_beforeSame + ',beforeTailAB=' + u2_beforeAB + '(' + JSON.stringify(rec.before.tail) + ')' +
                ',afterSame=' + u3_afterSame + ',rightLostB=' + u4_rightLost + '(' + rec.rightTail + ')' +
                ',leftShrank=' + u5_leftShrank + '(' + rec.before.len + '→' + rec.afterLen + '),noModal=' + u6_noModal + ']' +
                ',hintOnce=' + hintOk + '[first=' + rec.hints + '(once=' + h1_once + '),textHasHint=' + h2_text +
                ',after2ndMount=' + hintsAfter + '(stillOnce=' + h3_stillOnce + ')]',
              evidence: 'hintText=' + JSON.stringify(rec.hintText),
            };
          });

          // ---------- 4. sameFileCloseOne：关一个视图 ≠ 关文件（不落盘/不清脏/文档仍在）；关最后一个才走文档级 ----------
          await mvCase('sameFileCloseOne', async () => {
            await resetAll();
            await openTwoViews(SF_A);
            // 磁盘基线在**编辑之前**取：此时上一用例的 `saveNow` 早已落盘（closeTab 里的保存是排队异步的），
            // 取在编辑之后会与"排队中的旧保存"竞态，把无关抖动误判成"关视图时写盘"。
            const diskBeforeClose = fs.readFileSync(SF_A, 'utf8');
            const typed = await W(`(async () => {
              const e = window.__app.editor;
              const v = e.getPaneEls(0).view;
              v.dispatch({ changes: { from: 0, insert: 'ZZ' } });
              await new Promise((r) => setTimeout(r, 200));
              const t = e.findTabByPath(${JSON.stringify(SF_A)});
              return { dirty: !!t && t.dirty === true, rightHead: e.getPaneEls(1).view.state.doc.sliceString(0, 2), rightLen: e.getPaneEls(1).view.state.doc.length };
            })()`);
            // 点右栏那条 .tab 的 ✕（真实用户动作）。
            // 注意：栏的收缩是**同步**的 —— closeViewInPane → detachViewFromPane → removeEmptyPane
            // → mergePanes 全在点击派发的同一个同步块里跑完，所以点完读到的栏数已经是 1。
            const closed = await W(`(() => {
              const e = window.__app.editor;
              const panesBefore = e.getPaneCount();
              const tabs = e.getPaneEls(1).tabsEl.querySelectorAll('.tab');
              const name = (tabs[0].querySelector('.tab-name') || {}).textContent;
              tabs[0].querySelector('.tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { name: name, panesBefore: panesBefore, panes: e.getPaneCount(), modalHidden: document.getElementById('modal-mask').classList.contains('hidden') };
            })()`);
            await sleep(320);
            const s = await W(SNAP);
            const afterOne = await W(`(() => {
              const e = window.__app.editor;
              const t = e.findTabByPath(${JSON.stringify(SF_A)});
              return {
                exists: !!t, dirty: !!t && t.dirty === true,
                path: e.getPaneLayout().panes[0].path,
                panes: e.getPaneCount(),
                docHead: e.getPaneEls(0).view.state.doc.sliceString(0, 2),
                home: t ? e.paneIdOf(t) : null
              };
            })()`);
            const diskAfterOne = fs.readFileSync(SF_A, 'utf8');
            // 再关最后一个视图 → 文档级关闭（脏内容落盘、文档被移除、空态出现）
            const closed2 = await W(`(() => {
              const e = window.__app.editor;
              const tabs = e.getPaneEls(0).tabsEl.querySelectorAll('.tab');
              if (!tabs.length) return { clicked: false, panes: e.getPaneCount() };
              tabs[0].querySelector('.tab-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return { clicked: true, panes: e.getPaneCount() };
            })()`);
            await sleep(450);
            const final = await W(`(() => {
              const e = window.__app.editor;
              const t = e.findTabByPath(${JSON.stringify(SF_A)});
              const act = e.getActiveTab();
              return {
                exists: !!t, active: act ? act.name : null, panes: e.getPaneCount(),
                emptyVisible: !document.getElementById('editor-empty').classList.contains('hidden'),
                docLen: e.getPaneEls(0).view.state.doc.length,
                modalHidden: document.getElementById('modal-mask').classList.contains('hidden')
              };
            })()`);
            const diskFinal = fs.readFileSync(SF_A, 'utf8');
            // G3 的判据（不许把「关一个视图」变成一次写盘）用**内容**判定，不用跨时间窗口的逐字节相等：
            // 同一文件上可能还有排队中的旧保存落地（saveQueue 是应用级串行链，关标签时的保存不 await），
            // 那与本用例无关，但会让逐字节比较变红。这里断言「磁盘长度未变」+「刚输入的 ZZ 没被写进去」。
            const diskNoEdit = diskAfterOne.indexOf('ZZ') !== 0;
            const diskLenSame = diskAfterOne.length === diskBeforeClose.length;
            // 每个合取项都单独算成布尔并**全部**进 detail（首轮红就是"失败的是没打进 detail 的那一项"）：
            const c1_panesBefore = closed.panesBefore === 2;   // 点击前确实是双栏
            const c2_panesAfterClick = closed.panes === 1;     // 收缩是同步的（见上面的注释）
            const c3_noModal = closed.modalHidden === true;
            const c4_exists = afterOne.exists === true;
            const c5_dirty = afterOne.dirty === true;
            const c6_panes = afterOne.panes === 1;
            const c7_path = afterOne.path === SF_A;
            const c8_headZZ = afterOne.docHead === 'ZZ';
            const c9_rootCount = s.rootCount === 1;
            const c10_noDivider = s.divider === false;
            const viewCloseClean = c1_panesBefore && c2_panesAfterClick && c3_noModal && c4_exists && c5_dirty &&
              c6_panes && c7_path && c8_headZZ && diskNoEdit && diskLenSame && c9_rootCount && c10_noDivider;
            const docCloseWorked = closed2.clicked === true && final.exists === false && final.active === null &&
              final.panes === 1 && final.emptyVisible === true && final.docLen === 0 &&
              diskFinal.indexOf('ZZ') === 0;
            // 共同点：全程没有弹过模态框（当前实现关标签是"脏则静默保存"，从不弹确认框 —— 见交付说明的诚实清单）
            const noModal = closed.modalHidden === true && final.modalHidden === true;
            const ok = viewCloseClean && docCloseWorked && noModal && typed.dirty && typed.rightHead === 'ZZ';
            return {
              ok,
              detail: 'viewClose=' + viewCloseClean +
                '[panesBefore2=' + c1_panesBefore + '(' + closed.panesBefore + '),panesAfterClick1=' + c2_panesAfterClick + '(' + closed.panes + ')' +
                ',modalHidden=' + c3_noModal + ',exists=' + c4_exists + ',dirty=' + c5_dirty + ',panes=' + c6_panes + '(' + afterOne.panes + ')' +
                ',path=' + c7_path + ',headZZ=' + c8_headZZ + '(' + JSON.stringify(afterOne.docHead) + ')' +
                ',rootCount1=' + c9_rootCount + '(' + s.rootCount + '),noDivider=' + c10_noDivider +
                ',diskNoEdit=' + diskNoEdit + ',diskLenSame=' + diskLenSame + '(' + diskAfterOne.length + ')' +
                ',diskByteIdentical=' + (diskAfterOne === diskBeforeClose) + ']' +
                ',docClose=' + docCloseWorked + '(exists=' + final.exists + ',active=' + final.active + ',empty=' + final.emptyVisible +
                ',diskHasZZ=' + (diskFinal.indexOf('ZZ') === 0) + ')' + ',noModal=' + noModal,
              evidence: 'closedTab=' + closed.name + ' rightLenBefore=' + typed.rightLen + ' docLenAfter=' + final.docLen +
                ' diskLen=before/afterOne/final ' + diskBeforeClose.length + '/' + diskAfterOne.length + '/' + diskFinal.length,
            };
          });

          // ---------- 5. multiViewExternalChange：外部修改广播到**全部**视图（一次 toast、重载后清脏） ----------
          await mvCase('multiViewExternalChange', async () => {
            await resetAll();
            await openTwoViews(SF_A);
            // 外部内容刻意与"上一用例留下的长度"错开：只比长度会被**长度巧合**骗过
            // （实测：上一用例的文档 5636 == 旧 ext1 的 5636，导致轮询第一轮就误判"已追平"、
            //  从不等待事件到达 —— 这是本用例首轮红的真因，不是产品缺陷）。
            const MARK = '外部追加行 EXT-1\n外部追加行 EXT-2\n外部追加行 EXT-3\n';
            const ext1 = SF_ORIG_A + MARK;
            const ext2 = ext1 + '外部追加行 EXT-4（重试）\n';
            // 自写回声宽限：前面的用例保存过同一夹具（filewatch SELF_WRITE_GRACE_MS=2000 + 300ms 防抖），
            // 不等过窗口就外部写会被当成自身回声吸收 → 假阴性（实测：等待 ~1.2s 时确实被吸收）。
            await sleep(2400);
            // 真正的外部写：主进程 fs（不经 app 的写盘 IPC，不打 markSelfWrite）
            fs.writeFileSync(SF_A, ext1, 'utf8');
            let seen = null;
            let expect = ext1.length;
            let wrote = 1;
            for (let round = 0; round < 3; round++) {
              for (let i = 0; i < 10; i++) {
                await sleep(300);
                const snap = await W(`(() => {
                  const e = window.__app.editor;
                  const L = e.getPaneEls(0).view.state.doc.toString();
                  const R = e.getPaneEls(1).view.state.doc.toString();
                  const t = e.findTabByPath(${JSON.stringify(SF_A)});
                  return {
                    len: L.length, same: L === R,
                    hasMark: L.indexOf('EXT-1') >= 0 && L.indexOf('EXT-3') >= 0,
                    dirty: !!t && t.dirty === true,
                    toasts: (window.__mhToastRec || []).filter((x) => String(x).indexOf('已从外部重新加载') >= 0).length,
                    modalHidden: document.getElementById('modal-mask').classList.contains('hidden')
                  };
                })()`).catch(() => null);
                if (!snap) continue;
                seen = snap;
                // 必须**按内容**判定追平（长度相同不代表内容已换）；hasMark 为真才可能 break
                if (snap.hasMark && snap.same && snap.len === expect) break;
              }
              if (seen && seen.hasMark && seen.same && seen.len === expect) break;
              // 兜底重试：内容再变一次（长度与上一次差 16 字节，杜绝长度巧合）
              if (round < 2) {
                expect = ext1.length + 16 * (round + 1);
                fs.writeFileSync(SF_A, ext1 + '外部追加行 EXT-4（重试）\n'.repeat(round + 1), 'utf8');
                wrote++;
              }
            }
            const bothReloaded = !!seen && seen.len === expect && seen.same === true && seen.hasMark === true;
            const oneToast = !!seen && seen.toasts === 1;
            const cleanAfterReload = !!seen && seen.dirty === false;
            const ok = bothReloaded && oneToast && cleanAfterReload && seen.modalHidden === true;
            return {
              ok,
              detail: 'bothReloaded=' + bothReloaded + '(len=' + (seen ? seen.len : -1) + '/' + expect +
                ',same=' + (seen ? seen.same : '?') + ',hasMark=' + (seen ? seen.hasMark : '?') + ')' +
                ',oneToast=' + oneToast + '(n=' + (seen ? seen.toasts : -1) + '),clean=' + cleanAfterReload +
                ',modalHidden=' + (seen ? seen.modalHidden : '?'),
              evidence: 'writes=' + wrote + ' dirty=' + (seen ? seen.dirty : '?') +
                ' 外部写=主进程 fs.writeFileSync（无 markSelfWrite）；等待 2400ms 跨过自写宽限',
            };
          });

          // ---------- 6. layoutPersist：布局落盘（比例用区间断言 —— 拖拽有像素取整） ----------
          await mvCase('layoutPersist', async () => {
            await resetAll();
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SF_A)})`);
            await sleep(280);
            await Wv(`window.__app.editor.toggleSplit()`);
            await sleep(200);
            await Wv(`window.__app.editor.openFile(${JSON.stringify(SF_B)})`);
            await sleep(320);
            const dragged = await W(`(() => {
              const e = window.__app.editor;
              const root = document.getElementById('editor-panes');
              const div = document.querySelector('.pane-divider');
              const rr = root.getBoundingClientRect();
              const dw = div.getBoundingClientRect().width;
              const usable = Math.max(1, rr.width - dw);
              const x0 = div.getBoundingClientRect().left + dw / 2;
              const y0 = div.getBoundingClientRect().top + 20;
              const x1 = rr.left + usable * 0.35;
              div.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x0, clientY: y0 }));
              document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1, clientY: y0 }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x1, clientY: y0 }));
              e.focusPaneIndex(1); // 焦点放右栏
              const L = e.getPaneLayout();
              return { ratio: +L.ratio.toFixed(4), sizes: e.getPaneSizes(), focus: e.getFocusPaneId(), panes: L.panes.map((p) => p.path) };
            })()`);
            const disk = await W(`(async () => {
              window.__app.session.save();
              await new Promise((r) => setTimeout(r, 500));
              window.__app.state.settings = await window.api.getSettings();
              const st = await window.api.getSettings();
              const ls = st.lastSession;
              if (!ls) return { ls: null, hasFocus: document.hasFocus() };
              const ly = ls.layout || null;
              return {
                hasFocus: document.hasFocus(),
                keys: Object.keys(ls).sort(),
                paths: ls.paths, active: ls.active, pinned: ls.pinned,
                layout: ly ? { orientation: ly.orientation, sizes: ly.sizes, focus: ly.focus, panes: ly.panes } : null
              };
            })()`);
            const ly = disk.layout;
            const shape = !!ly && ly.panes.length === 2 && ly.orientation === 'h';
            const leftHasA = !!ly && ly.panes[0].docs.indexOf(SF_A) >= 0;
            const rightHasB = !!ly && ly.panes[1].docs.indexOf(SF_B) >= 0;
            const focusOk = !!ly && ly.focus === 1;
            const sizeOk = !!ly && Array.isArray(ly.sizes) && ly.sizes[0] > 0.3 && ly.sizes[0] < 0.42 && Math.abs(ly.sizes[0] + ly.sizes[1] - 1) < 0.01;
            // 三键仍在 + paths 是**文档级去重**（同一文件在两栏也只出现一次）
            const keysOk = !!disk.paths && disk.keys.join(',') === 'active,layout,paths,pinned';
            const dedupe = Array.isArray(disk.paths) && new Set(disk.paths).size === disk.paths.length &&
              disk.paths.indexOf(SF_A) >= 0 && disk.paths.indexOf(SF_B) >= 0;
            const inPathsOnce = !!disk.paths && disk.paths.filter((p) => p === SF_A).length === 1;
            const ok = shape && leftHasA && rightHasB && focusOk && sizeOk && keysOk && dedupe && inPathsOnce &&
              dragged.focus === 'p1' && disk.hasFocus === true;
            return {
              ok,
              detail: 'layout=' + shape + '(panes=' + (ly ? ly.panes.length : -1) + ',focus=' + (ly ? ly.focus : '?') +
                ',sizes=' + JSON.stringify(ly ? ly.sizes : null) + ' sizeOk=' + sizeOk + ')' +
                ',leftHasA=' + leftHasA + ',rightHasB=' + rightHasB + ',focusOk=' + focusOk + '(layout.focus=' + (ly ? ly.focus : '?') + ')' +
                ',docs=' + (ly ? JSON.stringify(ly.panes.map((p) => p.docs.map((d) => d.split(/[\\\\/]/).pop()))) : 'null') +
                ',keys=' + JSON.stringify(disk.keys) + ' keysOk=' + keysOk + ',dedupe=' + dedupe + ',inPathsOnce=' + inPathsOnce +
                ',draggedFocus=' + dragged.focus + ',hasFocus=' + disk.hasFocus,
              evidence: 'dragged=' + JSON.stringify(dragged) + ' paths=' + JSON.stringify((disk.paths || []).map((p) => p.split(/[\\\\/]/).pop())),
            };
          });

          // ---------- 7. layoutBackCompat：旧会话（无 layout）回落单栏，三键逐位还原 ----------
          await mvCase('layoutBackCompat', async () => {
            const preReset = await resetAll();
            // 诊断项：恢复前的栏数（上一用例 layoutPersist 留的是双栏；resetAll 合并失败会让本用例
            // 的 singlePane 变红，但看不出是谁的问题 → 把它记进 detail/evidence）
            const preSnap = await W(`(() => {
              const e = window.__app.editor;
              return { panes: e.getPaneCount(), dom: document.querySelectorAll('#editor-panes > .pane').length, divider: !!document.querySelector('.pane-divider') };
            })()`);
            const setOld = await W(`(async () => {
              await window.api.setSettings({ lastSession: { paths: [${JSON.stringify(SF_A)}, ${JSON.stringify(SF_B)}], active: 1, pinned: [0] } });
              window.__app.state.settings = await window.api.getSettings();
              return true;
            })()`);
            await Wv(`window.__app.session.restore()`);
            await sleep(420);
            const s = await W(SNAP);
            const st = await W(`(() => {
              const e = window.__app.editor;
              const sess = e.getSession();
              const act = e.getActiveTab();
              const tA = e.findTabByPath(${JSON.stringify(SF_A)});
              return {
                paths: sess.paths, active: act ? act.path : null,
                pinnedA: !!tA && tA.pinned === true,
                tabsInP0: e.getPaneLayout().panes[0].docs,
                paneCount: e.getPaneCount(),
                modalHidden: document.getElementById('modal-mask').classList.contains('hidden')
              };
            })()`);
            const keysOk = st.paths.length === 2 && st.paths[0] === SF_A && st.paths[1] === SF_B;
            // ⚠️ 首轮红的真因：这里曾读 `s.paneCount`，而 SNAP 当时**没有**这个字段 ⇒ undefined === 1 恒假，
            // 与真实栏数无关（其余子项全 true 却整体判红）。现已给 SNAP 补上 paneCount，并与
            // `st.paneCount`（渲染端 e.getPaneCount()）双口径同时断言。
            const sp1_rootCount = s.rootCount === 1;
            const sp2_divider = s.divider === false;
            const sp3_snapPanes = s.paneCount === 1;
            const sp4_apiPanes = st.paneCount === 1;
            const singlePane = sp1_rootCount && sp2_divider && sp3_snapPanes && sp4_apiPanes;
            const activeOk = st.active === SF_B;
            const pinOk = st.pinnedA === true;
            const silentOk = st.modalHidden === true;
            // 再存一次 → 写出 layout（升级路径），paths 与恢复前一致
            const disk = await W(`(async () => {
              window.__app.session.save();
              await new Promise((r) => setTimeout(r, 500));
              window.__app.state.settings = await window.api.getSettings();
              const st2 = await window.api.getSettings();
              const ls = st2.lastSession || {};
              return {
                hasFocus: document.hasFocus(),
                keys: Object.keys(ls).sort(),
                paths: ls.paths || [],
                layout: ls.layout ? { panes: ls.layout.panes, focus: ls.layout.focus, sizes: ls.layout.sizes } : null
              };
            })()`);
            const upgradeOk = !!disk.layout && disk.layout.panes.length === 1 && disk.layout.panes[0].docs.length === 2 &&
              disk.paths.length === 2 && disk.paths[0] === SF_A && disk.paths[1] === SF_B;
            // 旧格式 + 缺失文件：静默跳过、只开 1 个标签、不弹 alertBox
            await resetAll();
            const missing = path.join(TEST_ROOT, 'same-missing-xyz.md');
            await W(`(async () => {
              await window.api.setSettings({ lastSession: { paths: [${JSON.stringify(missing)}, ${JSON.stringify(SF_B)}], active: 1, pinned: [] } });
              window.__app.state.settings = await window.api.getSettings();
              return true;
            })()`);
            await Wv(`window.__app.session.restore()`);
            await sleep(420);
            const st2 = await W(`(() => {
              const e = window.__app.editor;
              const act = e.getActiveTab();
              return {
                tabs: e.getSession().paths.length,
                hasMissing: !!e.findTabByPath(${JSON.stringify(missing)}),
                active: act ? act.path : null,
                modalHidden: document.getElementById('modal-mask').classList.contains('hidden')
              };
            })()`);
            const missingOk = st2.tabs === 1 && st2.hasMissing === false && st2.active === SF_B && st2.modalHidden === true;
            // 有 layout 的恢复（G4 的正向路径）：两栏 + **同一文件在两栏各一个视图且两栏都显示它** →
            // 读盘只发生一次（paths 里该文件只出现 1 次）、比例/焦点/各栏活动项按快照还原。
            // 焦点刻意取 **0**（不是 1）：逐栏激活时最后一栏正好是第 2 栏，用 focus=1 会掩盖
            // "激活过程把焦点冲掉"的排序缺陷（focus=0 才能把它钉住）。
            await resetAll();
            await W(`(async () => {
              await window.api.setSettings({ lastSession: {
                paths: [${JSON.stringify(SF_A)}, ${JSON.stringify(SF_B)}], active: 0, pinned: [],
                layout: { orientation: 'h', sizes: [0.35, 0.65], focus: 0, panes: [
                  { docs: [${JSON.stringify(SF_A)}, ${JSON.stringify(SF_B)}], active: 0, pinned: [] },
                  { docs: [${JSON.stringify(SF_A)}], active: 0, pinned: [] }
                ] }
              } });
              window.__app.state.settings = await window.api.getSettings();
              return true;
            })()`);
            await Wv(`window.__app.session.restore()`);
            await sleep(700);
            const lay = await W(`(() => {
              const e = window.__app.editor;
              const sess = e.getSession();
              const t = e.findTabByPath(${JSON.stringify(SF_A)});
              const L = e.getPaneLayout();
              const v0 = e.getPaneEls(0).view, v1 = e.getPaneEls(1).view;
              return {
                panes: e.getPaneCount(), divider: !!document.querySelector('.pane-divider'),
                paths: sess.paths.length, aOnce: sess.paths.filter((p) => p === ${JSON.stringify(SF_A)}).length,
                homesA: t ? e.panesOfDoc(t).length : -1, viewsA: t ? e.viewCountOf(t) : -1,
                p0Docs: L.panes[0].docs, p1Docs: L.panes[1].docs,
                focus: e.getFocusPaneId(), sizes: e.getPaneSizes(),
                p0ActiveIsA: L.panes[0].path === ${JSON.stringify(SF_A)},
                p1ActiveIsA: L.panes[1].path === ${JSON.stringify(SF_A)},
                same: v0.state.doc.toString() === v1.state.doc.toString(),
                views: v0 !== v1, modalHidden: document.getElementById('modal-mask').classList.contains('hidden')
              };
            })()`);
            const layoutRestoreOk = lay.panes === 2 && lay.divider === true && lay.paths === 2 && lay.aOnce === 1 &&
              lay.homesA === 2 && lay.viewsA === 2 && lay.p0Docs === 2 && lay.p1Docs === 1 &&
              lay.focus === 'p0' && Math.abs(lay.sizes[0] - 0.35) < 0.08 &&
              lay.p0ActiveIsA === true && lay.p1ActiveIsA === true && lay.same === true && lay.views === true && lay.modalHidden === true;
            // 只读是**文档级**决定（C5）：多视图下必须两个视图都转只读
            const ro = await W(`(() => {
              const e = window.__app.editor;
              const t = e.findTabByPath(${JSON.stringify(SF_A)});
              return e.setTabReadOnly(t, true).then(() => {
                const v0 = e.getPaneEls(0).view, v1 = e.getPaneEls(1).view;
                return { t0: v0.state.readOnly === true, t1: v1.state.readOnly === true };
              });
            })()`);
            const readOnlyBoth = ro && ro.t0 === true && ro.t1 === true;
            const ok = singlePane && keysOk && activeOk && pinOk && silentOk && upgradeOk && missingOk &&
              layoutRestoreOk && readOnlyBoth && disk.hasFocus === true;
            return {
              ok,
              detail: 'singlePane=' + singlePane +
                '[rootCount1=' + sp1_rootCount + '(' + s.rootCount + '),noDivider=' + sp2_divider +
                ',snapPanes1=' + sp3_snapPanes + '(' + s.paneCount + '),apiPanes1=' + sp4_apiPanes + '(' + st.paneCount + ')' +
                ',preReset=' + preReset + ',preSnap=' + JSON.stringify(preSnap) + ']' +
                ',paths=' + JSON.stringify(st.paths.map((p) => p.split(/[\\\\/]/).pop())) + ' keysOk=' + keysOk +
                ',active=' + (st.active || '').split(/[\\\\/]/).pop() + ' activeOk=' + activeOk + ',pin=' + pinOk + ',silent=' + silentOk +
                ',upgrade=' + upgradeOk + '(keys=' + JSON.stringify(disk.keys) + ')' +
                ',layoutRestore=' + layoutRestoreOk + '(' + JSON.stringify(lay) + '),readOnlyBoth=' + readOnlyBoth,
              evidence: 'missing=' + missingOk + ' tabs=' + st2.tabs + ' missingTab=' + st2.hasMissing +
                ' upgradedLayout=' + JSON.stringify(disk.layout) + ' modal=' + st2.modalHidden +
                ' layoutRestore=' + JSON.stringify(lay),
            };
          });
        } finally {
          // 收尾：还原自动保存延迟与设置、合栏清标签、删夹具（rcDir* 段随后会断言 .tab 总数并起子进程）
          const restoreDelay = Number.isFinite(Number(prevAutoSave)) && Number(prevAutoSave) > 0 ? Math.floor(Number(prevAutoSave)) : 800;
          await W(`(async () => {
            await window.api.setSettings({ autoSaveDelay: ${restoreDelay}, lastSession: null });
            window.__app.state.settings = await window.api.getSettings();
            return true;
          })()`).catch(() => {});
          await resetAll().catch(() => {});
          for (const f of SF_FILES) {
            try { fs.rmSync(f, { force: true }); } catch { /* 已被删则忽略 */ }
          }
        }
      }

      // ================= v0.3.0「右键 --dir 打开 + 测试 profile 隔离」：6 项端到端回归（v0.4.0 追加） =================
      // 位置：mw* 多窗口段之后、E2E_RESULTS 之前。理由：后 3 项会在首实例里新开窗口、改写侧栏根与主进程
      // 「侧栏根集合」（fs:set-roots），只有在全部既有用例跑完之后做，才不会污染它们对启动/根状态的假设。
      // 断言口径（不只断言函数返回值）：冷启动与第二实例都起**真实子进程**，用 CDP（--remote-debugging-port）
      // 读子进程渲染端真实 DOM/__app 状态；坏路径额外断言可见 toast 文本、渲染进程未崩、窗口仍可继续干活。
      {
        const { spawn, execFileSync } = require('child_process');
        const { BrowserWindow } = require('electron'); // 本块自用（mw* 段里的 BrowserWindow 只在它自己的块作用域）
        const crypto = require('crypto');
        const REPO = path.join(__dirname, '..');
        const TMP = app.getPath('temp');
        const DRIVE = path.parse(REPO).root; // 本机 = F:\（按实际盘符取，不写死）
        const STAMP = String(process.pid) + '-' + String(Date.now());
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const nk = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); // 'F:\' → 'f:'
        const under = (child, parent) => nk(child) !== nk(parent) && nk(child).startsWith(nk(parent) + '\\');
        const RENDERER_HTML = path.join(REPO, 'src', 'renderer', 'index.html');
        const PRELOAD = path.join(REPO, 'src', 'preload', 'preload.js');
        const { extractDirArg } = require('../src/main/args');

        // 用例包装：单个用例异常不影响其它用例，也不影响 E2E_RESULTS 的输出
        const runCase = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };

        // ---- 空闲端口（子进程 DevTools 端点；避免与其它进程抢占固定端口） ----
        const freePort = () => new Promise((resolve) => {
          const srv = require('net').createServer();
          srv.on('error', () => resolve(0));
          srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
          });
        });

        // ---- 子进程 CDP 取证小工具 ----
        const cdpList = (port) => new Promise((resolve) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 700 }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        const cdpEval = (wsUrl, expression, timeoutMs = 10000) => new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timer = setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } reject(new Error('CDP 求值超时')); }, timeoutMs);
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
          });
          ws.addEventListener('message', (ev) => {
            let m = null;
            try { m = JSON.parse(String(ev.data)); } catch { /* 非 JSON 帧忽略 */ }
            if (!m || m.id !== 1) return;
            clearTimeout(timer);
            try { ws.close(); } catch { /* 忽略 */ }
            const r = m.result || {};
            if (r.exceptionDetails) reject(new Error('渲染端异常：' + JSON.stringify(r.exceptionDetails).slice(0, 200)));
            else resolve(r.result ? r.result.value : undefined);
          });
          ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); });
        });
        // toast 记录器：子进程 boot 的提示只活 ~1.9s，装上 MutationObserver 才拿得稳
        const TOAST_REC = `(() => {
          if (window.__mhToastRec) return 'ok';
          window.__mhToastRec = [];
          const push = (el) => { try { if (el && el.classList && el.classList.contains('toast')) window.__mhToastRec.push(el.textContent); } catch (e) {} };
          const mo = new MutationObserver((ms) => {
            for (const m of ms) for (const n of m.addedNodes) { push(n); if (n && n.querySelectorAll) n.querySelectorAll('.toast').forEach(push); }
          });
          mo.observe(document, { childList: true, subtree: true });
          document.querySelectorAll('.toast').forEach(push);
          return 'ok';
        })()`;
        // 子进程窗口的真实 DOM/状态快照（注意树根行是 #file-tree 的直接子节点，子节点在 .tree-children 里）
        const CHILD_SNAP = `(() => ({
          hasApp: !!window.__app,
          roots: window.__app ? window.__app.state.sidebarRoots.slice() : null,
          rootDir: window.__app ? window.__app.state.rootDir : null,
          dirLabel: (document.getElementById('dir-label') || {}).textContent || null,
          tabs: document.querySelectorAll('.tab').length,
          emptyTree: !!document.querySelector('.tree-empty'),
          rootRows: Array.from(document.querySelectorAll('#file-tree > .tree-node')).map((el) => el.dataset.path || null),
          toasts: (window.__mhToastRec || []).slice(),
        }))()`;
        // 等子进程页面目标（DevTools）出现，并尽早在渲染端装 toast 记录器
        const childPage = async (port, budgetMs) => {
          const t0 = Date.now();
          let pages = [];
          while (Date.now() - t0 < budgetMs) {
            const list = await cdpList(port);
            if (Array.isArray(list)) {
              pages = list.filter((t) => t.type === 'page');
              const ready = pages.filter((t) => String(t.url).includes('src/renderer/index.html'));
              if (ready.length) {
                for (let i = 0; i < 20; i++) {
                  const r = await cdpEval(ready[0].webSocketDebuggerUrl, TOAST_REC, 3000).catch(() => null);
                  if (r === 'ok') break;
                  await sleep(60);
                }
                return { pages, page: ready[0] };
              }
            }
            await sleep(120);
          }
          return { pages, page: null };
        };
        // 轮询子进程状态直到条件满足（返回最后一次快照）
        const waitSnap = async (page, cond, budgetMs) => {
          const t0 = Date.now();
          let snap = null;
          while (Date.now() - t0 < budgetMs) {
            snap = await cdpEval(page.webSocketDebuggerUrl, CHILD_SNAP, 6000).catch(() => null);
            if (snap && cond(snap)) return snap;
            await sleep(150);
          }
          return snap;
        };

        // ---- 真实子进程（继承主进程环境；MH_USERDATA 决定 profile 与单实例锁归属） ----
        const spawnChild = (args, profile) => {
          const env = { ...process.env, MH_USERDATA: profile };
          delete env.ELECTRON_RUN_AS_NODE; // 若从 ELECTRON_RUN_AS_NODE 环境派生出子进程，必须清掉（否则子进程不是 app）
          const child = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
          const st = { out: '', err: '', exited: false, code: null };
          child.stdout.on('data', (d) => { st.out += d; });
          child.stderr.on('data', (d) => { st.err += d; });
          child.on('exit', (code) => { st.exited = true; st.code = code; });
          return { child, st };
        };
        // 结束子进程：taskkill 整棵进程树并等它真的退出（不留孤儿）
        const killChild = async (h) => {
          if (!h || !h.child || h.st.exited) return 'exited';
          try { execFileSync('taskkill', ['/PID', String(h.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
          for (let i = 0; i < 60 && !h.st.exited; i++) await sleep(100);
          return h.st.exited ? 'killed' : 'STILL-RUNNING';
        };
        const electronProcs = () => {
          try {
            const img = path.basename(process.execPath);
            const csv = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + img, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
            return csv.split(/\r?\n/).filter((l) => l.toLowerCase().includes(img.toLowerCase())).length;
          } catch { return -1; }
        };

        // ---- 夹具：临时目录 / 预置脏 profile（均放 %TEMP%，与 .smoke-test 无关） ----
        const mkDir = (name, files) => {
          const p = path.join(TMP, name);
          fs.rmSync(p, { recursive: true, force: true });
          fs.mkdirSync(p, { recursive: true });
          for (const f of files || []) {
            fs.mkdirSync(path.dirname(path.join(p, f)), { recursive: true });
            fs.writeFileSync(path.join(p, f), '# ' + f + '\n', 'utf8');
          }
          return p;
        };
        const mkProfile = (name, settings) => {
          const p = path.join(TMP, name);
          fs.rmSync(p, { recursive: true, force: true });
          fs.mkdirSync(p, { recursive: true });
          if (settings) fs.writeFileSync(path.join(p, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
          return p;
        };
        const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
        const childDirs = []; // 结束时统一清理
        const TEMP_DIRS = [];

        try {
          // ---------- 1. testIsolation：--smoke 必须跑在隔离 profile，且真实 userData 没被本次运行写入 ----------
          await runCase('testIsolation', async () => {
            const isolated = app.getPath('userData');
            const expected = path.join(TMP, 'markhunter-test-smoke'); // main.js: temp + 'markhunter-test' + '-smoke'
            const real = path.join(app.getPath('appData'), app.getName()); // 未隔离时的真实 profile：%APPDATA%\MarkHunter
            const snapFile = (p) => {
              try {
                const st = fs.statSync(p);
                const buf = fs.readFileSync(p);
                return { mtime: st.mtimeMs, sha: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10), text: buf.toString('utf8') };
              } catch { return null; }
            };
            const realSettings = path.join(real, 'settings.json');
            const isoSettings = path.join(isolated, 'settings.json');
            const realBefore = snapFile(realSettings);
            const isoBefore = snapFile(isoSettings);
            // 正向对照：经隔离 profile 的设置 IPC 真写一次（值写回原值，不影响后续用例）
            const cur = await win.webContents.executeJavaScript('window.api.getSettings().then((s) => s.autoSaveDelay)');
            await win.webContents.executeJavaScript(`window.api.setSettings({ autoSaveDelay: ${Number(cur) || 800} })`);
            await sleep(400);
            const realAfter = snapFile(realSettings);
            const isoAfter = snapFile(isoSettings);
            // 真实 profile「没被写」：原本不存在 → 现在也不能被创建；存在 → 内容与 mtime 都不许变
            const realUntouched = realBefore === null
              ? !fs.existsSync(realSettings)
              : (!!realAfter && realBefore.text === realAfter.text && realBefore.mtime === realAfter.mtime);
            const isoWritten = !!isoAfter && (!isoBefore || isoBefore.text !== isoAfter.text || isoBefore.mtime !== isoAfter.mtime);
            const flag = process.argv.includes('--smoke');
            const isoOk = nk(isolated) === nk(expected) && fs.existsSync(isolated);
            const disjoint = nk(isolated) !== nk(real) && !under(isolated, real) && !under(real, isolated);
            const ok = flag && isoOk && disjoint && isoWritten && realUntouched;
            return {
              ok,
              detail: 'smokeFlag=' + flag + ',userData=' + isoOk + ',disjoint=' + disjoint + ',isoWritten=' + isoWritten + ',realUntouched=' + realUntouched,
              evidence: 'iso=' + isolated + ' real=' + real +
                ' realSettings=' + (realBefore ? (realUntouched ? 'untouched' : 'CHANGED') + '(sha ' + realBefore.sha + ' mtime ' + Math.round(realBefore.mtime) + '→' + (realAfter ? realAfter.sha + ' ' + Math.round(realAfter.mtime) : 'gone') + ')' : (realAfter ? 'CREATED!' : 'absent-both')) +
                ' isoSettings=' + (isoBefore ? isoBefore.sha + ' mtime ' + Math.round(isoBefore.mtime) : 'absent') + '→' + (isoAfter ? isoAfter.sha + ' mtime ' + Math.round(isoAfter.mtime) : 'missing'),
            };
          });

          // ---------- 2. rcDirColdStart：冷启动 --dir <目标> → 首个窗口直接把该目录开成根 ----------
          // 场景刻意做「脏」：profile 预置上次侧栏根 + 上次会话标签（真实用户升级后的状态），
          // 断言目标目录胜出（既不是空白，也不是上次会话）。
          const STALE_A = mkDir('mh-smoke-stale-a-' + STAMP, ['prev.md', 'prev2.md']);
          const TARGET_A = mkDir('mh-smoke-dir-a-' + STAMP, ['note.md', 'sub/x.md']);
          const PROF_A = mkProfile('mh-smoke-cold-a-' + STAMP, {
            lastDirectory: STALE_A,
            sidebarRoots: [STALE_A],
            // 会话快照的真实结构见 app.js persistSession：{ paths, active, pinned }（不是 tabs）
            lastSession: { paths: [path.join(STALE_A, 'prev.md'), path.join(STALE_A, 'prev2.md')], active: 1, pinned: [] },
          });
          TEMP_DIRS.push(STALE_A, TARGET_A, PROF_A);
          await runCase('rcDirColdStart', async () => {
            const port = await freePort();
            const h = spawnChild(['.', '--dir', TARGET_A, '--remote-debugging-port=' + port], PROF_A);
            childDirs.push(h);
            try {
              const { pages, page } = await childPage(port, 25000);
              if (!page) {
                return { ok: false, detail: '子进程 DevTools 目标未就绪 pages=' + pages.length, evidence: 'pid=' + h.child.pid + ' stdout=' + JSON.stringify(h.st.out.slice(0, 150)) + ' err=' + JSON.stringify(h.st.err.slice(0, 150)) };
              }
              const snap = await waitSnap(page, (s) => s.hasApp && (s.roots || []).length > 0 && s.rootRows.length > 0, 25000);
              const roots = (snap && snap.roots) || [];
              const persisted = readJson(path.join(PROF_A, 'settings.json'));
              const okRoot = roots.length === 1 && nk(roots[0]) === nk(TARGET_A);
              const okLabel = !!snap && snap.dirLabel === TARGET_A && nk(snap.rootDir) === nk(TARGET_A);
              const okTree = !!snap && !snap.emptyTree && snap.rootRows.length === 1 && nk(snap.rootRows[0]) === nk(TARGET_A);
              const staleGone = !roots.some((r) => nk(r) === nk(STALE_A));
              const okPersist = !!persisted && Array.isArray(persisted.sidebarRoots) && persisted.sidebarRoots.length === 1 && nk(persisted.sidebarRoots[0]) === nk(TARGET_A);
              const alive = !h.st.exited;
              const ok = okRoot && okLabel && okTree && staleGone && okPersist && alive;
              return {
                ok,
                detail: 'roots=' + JSON.stringify(roots) + ',label=' + (snap && snap.dirLabel) + ',treeRows=' + (snap && snap.rootRows.length) + ',staleGone=' + staleGone + ',persisted=' + okPersist + ',alive=' + alive,
                evidence: 'pid=' + h.child.pid + ' port=' + port + ' target=' + TARGET_A + ' roots=' + JSON.stringify(roots) +
                  ' label=' + (snap && snap.dirLabel) + ' treeRows=' + (snap && snap.rootRows.length) + ' tabs=' + (snap && snap.tabs) + ' stale=' + STALE_A,
              };
            } finally {
              await killChild(h);
            }
          });

          // ---------- 3. rcDirCleanWindow：干净的单一窗口（rcDirColdStart 的「无副作用」对照） ----------
          const STALE_B = mkDir('mh-smoke-stale-b-' + STAMP, ['old1.md', 'old2.md']);
          const TARGET_B = mkDir('mh-smoke-dir-b-' + STAMP, ['clean.md']);
          const PROF_B = mkProfile('mh-smoke-clean-b-' + STAMP, {
            lastDirectory: STALE_B,
            sidebarRoots: [STALE_B],
            // 会话快照的真实结构见 app.js persistSession：{ paths, active, pinned }
            lastSession: { paths: [path.join(STALE_B, 'old1.md'), path.join(STALE_B, 'old2.md')], active: 0, pinned: [] },
          });
          TEMP_DIRS.push(STALE_B, TARGET_B, PROF_B);
          await runCase('rcDirCleanWindow', async () => {
            const port = await freePort();
            const h = spawnChild(['.', '--dir', TARGET_B, '--remote-debugging-port=' + port], PROF_B);
            childDirs.push(h);
            try {
              const { pages, page } = await childPage(port, 25000);
              if (!page) {
                return { ok: false, detail: '子进程 DevTools 目标未就绪 pages=' + pages.length, evidence: 'pid=' + h.child.pid + ' stdout=' + JSON.stringify(h.st.out.slice(0, 150)) };
              }
              const snap = await waitSnap(page, (s) => s.hasApp && (s.roots || []).length > 0 && s.rootRows.length > 0, 25000);
              const roots = (snap && snap.roots) || [];
              const pageTargets = (await cdpList(port) || []).filter((t) => t.type === 'page' && String(t.url).includes('src/renderer/index.html')).length;
              const oneWindow = pageTargets === 1;
              const uniqueRoots = roots.length === 1 && new Set(roots.map(nk)).size === 1; // 无重复根
              const rootOk = uniqueRoots && nk(roots[0]) === nk(TARGET_B);
              const noNest = !roots.some((r) => roots.some((s) => under(r, s)));
              const noTabs = !!snap && snap.tabs === 0; // 预置的 2 个会话标签一个都没被恢复
              const opened = !!snap && snap.dirLabel === TARGET_B && !snap.emptyTree && snap.rootRows.length === 1 && nk(snap.rootRows[0]) === nk(TARGET_B);
              const alive = !h.st.exited;
              const ok = oneWindow && rootOk && noNest && noTabs && opened && alive;
              return {
                ok,
                detail: 'pageTargets=' + pageTargets + ',roots=' + JSON.stringify(roots) + ',noNest=' + noNest + ',tabs=' + (snap && snap.tabs) + ',opened=' + opened + ',alive=' + alive,
                evidence: 'pid=' + h.child.pid + ' port=' + port + ' pageTargets=' + pageTargets + ' target=' + TARGET_B + ' roots=' + JSON.stringify(roots) +
                  ' label=' + (snap && snap.dirLabel) + ' treeRows=' + (snap && snap.rootRows.length) + ' tabs=' + (snap && snap.tabs),
              };
            } finally {
              await killChild(h);
            }
          });

          // ---------- 4. rcDirBadPath：--dir 指向不存在路径 / 文件路径 → 不崩 + 可见提示 + 仍可用 ----------
          // 开窗方式与 main.js createWindow 完全一致（additionalArguments 同步投递 + did-finish-load 的
          // open-dir 事件双通道）；argv 段用真实「Electron 重排」形态并过 args.js，链路与右键启动一致。
          await runCase('rcDirBadPath', async () => {
            const launchWin = async (dir) => {
              const w = new BrowserWindow({
                width: 900,
                height: 600,
                show: false,
                webPreferences: {
                  preload: PRELOAD,
                  contextIsolation: true,
                  nodeIntegration: false,
                  sandbox: true,
                  spellcheck: false,
                  additionalArguments: dir ? ['--mh-open-dir=' + encodeURIComponent(dir)] : [],
                },
              });
              let gone = null;
              w.webContents.on('render-process-gone', (_e, d) => { gone = d.reason; });
              await w.loadFile(RENDERER_HTML);
              if (dir && !w.isDestroyed()) w.webContents.send('open-dir', dir);
              return { w, goneReason: () => gone };
            };
            const pollToast = async (w, expected, budgetMs) => {
              const seen = [];
              const t0 = Date.now();
              // 双保险：boot 的提示可能在我开始轮询前就出现（提示寿命 ~1.9s），故先装 MutationObserver
              // 记录器，轮询时把「实时 .toast」与「记录器捕获」取并集。
              await w.webContents.executeJavaScript(TOAST_REC).catch(() => null);
              while (Date.now() - t0 < budgetMs) {
                const list = await w.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.toast')).map((e) => e.textContent).concat(window.__mhToastRec || [])`).catch(() => null);
                if (Array.isArray(list)) for (const t of list) if (!seen.includes(t)) seen.push(t);
                if (seen.includes(expected)) return { ok: true, seen };
                await sleep(120);
              }
              return { ok: false, seen };
            };
            // 等渲染端 boot 收尾（`window.__app` 是 boot **最后一行**才挂上的）。
            // 2026-08-30 实测：toast 已经出现、但紧接其后的一次性读取拿到 `app:false`（boot 尚未收尾）
            // → noCrash/notOpened 双红。提示出现的时机早于 `__app` 赋值，故必须轮询等待而不是单次读取。
            const waitApp = async (w, budgetMs) => {
              const t0 = Date.now();
              while (Date.now() - t0 < budgetMs) {
                const ok = await w.webContents.executeJavaScript('!!window.__app').catch(() => false);
                if (ok === true) return true;
                await sleep(120);
              }
              return false;
            };
            const badMissing = 'Z:\\not-exist-xyz';
            // Electron 在 second-instance 里会把 --dir 与它的值拆开（实测形态），故解析结果才是真实入参
            const parsedMissing = extractDirArg(['electron.exe', '--dir', '--allow-file-access-from-files', REPO, badMissing], { appPath: REPO });
            const badFile = path.join(TEST_ROOT, 'rc-bad-file-' + STAMP + '.md');
            fs.writeFileSync(badFile, 'x', 'utf8');
            const parsedFile = extractDirArg(['electron.exe', '--dir', '--allow-file-access-from-files', REPO, badFile], { appPath: REPO });
            const recoverFile = path.join(TEST_ROOT, 'rc-bad-recover-' + STAMP + '.md');
            let w1 = null;
            let w2 = null;
            try {
              // ① 不存在的盘符路径
              const a = await launchWin(parsedMissing);
              w1 = a.w;
              const t1 = await pollToast(w1, '无法打开指定目录：' + badMissing, 10000);
              await waitApp(w1, 6000); // boot 收尾（__app 是最后一行才挂上）
              await sleep(400);
              const s1 = await w1.webContents.executeJavaScript(`({
                app: !!window.__app,
                roots: window.__app ? window.__app.state.sidebarRoots.length : -1,
                emptyTree: !!document.querySelector('.tree-empty'),
                tabs: document.querySelectorAll('.tab').length,
              })`).catch(() => null);
              const noCrash1 = !!s1 && s1.app === true && a.goneReason() === null && !w1.isDestroyed();
              const notOpened1 = !!s1 && s1.roots === 0;
              // 仍可用：写文件 + 打开正常目录 + 打开文件
              const rec = await w1.webContents.executeJavaScript(`(async () => {
                const ok = await window.__app.openDirFromPath(${JSON.stringify(TEST_ROOT)});
                await window.api.writeFile(${JSON.stringify(recoverFile)}, '恢复写入 ok');
                await window.__app.editor.openFile(${JSON.stringify(recoverFile)});
                await new Promise((r) => setTimeout(r, 400));
                return {
                  ok,
                  roots: window.__app.state.sidebarRoots.slice(),
                  tabs: document.querySelectorAll('.tab').length,
                  rows: Array.from(document.querySelectorAll('#file-tree > .tree-node')).map((el) => el.dataset.path),
                };
              })()`).catch((e) => ({ err: String(e && e.message) }));
              const usable = !!rec && rec.ok === true && Array.isArray(rec.roots) && rec.roots.length === 1 &&
                nk(rec.roots[0]) === nk(TEST_ROOT) && rec.tabs === 1 && rec.rows.length === 1 && nk(rec.rows[0]) === nk(TEST_ROOT);
              // ② --dir 指向一个真实文件（args.js 兜底分支）
              const b = await launchWin(parsedFile);
              w2 = b.w;
              const t2 = await pollToast(w2, '无法打开指定目录：' + badFile, 10000);
              await waitApp(w2, 6000); // 同上：toast 早于 __app 赋值，单次读取会偶发 app:false
              const s2 = await w2.webContents.executeJavaScript(`({
                app: !!window.__app,
                roots: window.__app ? window.__app.state.sidebarRoots.length : -1,
              })`).catch(() => null);
              const noCrash2 = !!s2 && s2.app === true && b.goneReason() === null && !w2.isDestroyed();
              const notOpened2 = !!s2 && s2.roots === 0;
              const ok = parsedMissing === badMissing && parsedFile === badFile &&
                t1.ok && noCrash1 && notOpened1 && usable && t2.ok && noCrash2 && notOpened2;
              return {
                ok,
                detail: 'parsedMissing=' + JSON.stringify(parsedMissing) + ',parsedFile=' + JSON.stringify(parsedFile) +
                  ',toastMissing=' + t1.ok + ',noCrash1=' + noCrash1 + ',notOpened1=' + notOpened1 + ',usable=' + usable +
                  ',toastFile=' + t2.ok + ',noCrash2=' + noCrash2 + ',notOpened2=' + notOpened2,
                evidence: 'toasts1=' + JSON.stringify(t1.seen) + ' toasts2=' + JSON.stringify(t2.seen) + ' recover=' + JSON.stringify(rec && rec.roots) +
                  ' s1=' + JSON.stringify(s1) + ' s2=' + JSON.stringify(s2),
              };
            } finally {
              for (const w of [w1, w2]) {
                try { if (w && !w.isDestroyed()) w.destroy(); } catch { /* 已销毁 */ }
              }
              await sleep(300);
            }
          });

          // ---------- 5. rcDirDriveRoot：--dir 为盘符根 → 不产生「盘符根 + 其子目录」两个嵌套根 ----------
          // ① 真实冷启动 --dir <盘符根>：唯一根 = 盘符根；② 同窗口 fromLaunch 语义：已有被盘符根包含的
          // 根时，用盘符根**替换**它们（而不是嵌套共存），并断言提示文案、根条数与根路径集合。
          const PROF_C = mkProfile('mh-smoke-drive-' + STAMP, { lastDirectory: TEST_ROOT, sidebarRoots: [TEST_ROOT], lastSession: null });
          TEMP_DIRS.push(PROF_C);
          await runCase('rcDirDriveRoot', async () => {
            const port = await freePort();
            const h = spawnChild(['.', '--dir', DRIVE, '--remote-debugging-port=' + port], PROF_C);
            childDirs.push(h);
            try {
              const { page } = await childPage(port, 25000);
              if (!page) {
                return { ok: false, detail: '子进程 DevTools 目标未就绪', evidence: 'pid=' + h.child.pid + ' stdout=' + JSON.stringify(h.st.out.slice(0, 150)) };
              }
              const snap = await waitSnap(page, (s) => s.hasApp && (s.roots || []).length > 0 && s.rootRows.length > 0, 25000);
              const roots = (snap && snap.roots) || [];
              const persisted = readJson(path.join(PROF_C, 'settings.json'));
              const driveOnly = roots.length === 1 && nk(roots[0]) === nk(DRIVE);
              const noContained = !roots.some((r) => under(r, DRIVE)); // 不含 F:\VibeCode 这类被包含根
              const noNest1 = !roots.some((r) => roots.some((s) => under(r, s)));
              const treeOk = !!snap && !snap.emptyTree && snap.rootRows.length === 1 && nk(snap.rootRows[0]) === nk(DRIVE);
              const persistOk = !!persisted && Array.isArray(persisted.sidebarRoots) && persisted.sidebarRoots.length === 1 && nk(persisted.sidebarRoots[0]) === nk(DRIVE);
              const coldOk = driveOnly && noContained && noNest1 && treeOk && persistOk && !h.st.exited;

              // ② 同窗口 fromLaunch 替换语义（主窗口；先保证侧栏里至少有一个位于盘符根内的根）
              const W = (code) => win.webContents.executeJavaScript(code);
              await W(`window.__app.openDirFromPath(${JSON.stringify(TEST_ROOT)})`);
              await sleep(300);
              const before = await W('window.__app.state.sidebarRoots.slice()');
              const contained = before.filter((r) => under(r, DRIVE));
              const keep = before.filter((r) => !under(r, DRIVE) && nk(r) !== nk(DRIVE));
              const expected = keep.concat([DRIVE]);
              const expectedToast = `已用「${DRIVE}」替换侧栏中 ${contained.length} 个被包含的目录`;
              const toastWatch = (async () => {
                const seen = [];
                const t0 = Date.now();
                while (Date.now() - t0 < 10000) {
                  const list = await W(`Array.from(document.querySelectorAll('.toast')).map((e) => e.textContent)`).catch(() => null);
                  if (Array.isArray(list)) for (const t of list) if (!seen.includes(t)) seen.push(t);
                  if (seen.includes(expectedToast)) return { ok: true, seen };
                  await sleep(120);
                }
                return { ok: false, seen };
              })();
              const applied = await W(`window.__app.openDirFromPath(${JSON.stringify(DRIVE)}, { fromLaunch: true })`);
              const toast = await toastWatch;
              await sleep(500);
              const st = await W(`({
                roots: window.__app.state.sidebarRoots.slice(),
                rows: Array.from(document.querySelectorAll('#file-tree > .tree-node')).map((el) => el.dataset.path),
                empty: !!document.querySelector('.tree-empty'),
              })`);
              const setOk = st.roots.length === expected.length && expected.every((e) => st.roots.some((r) => nk(r) === nk(e)));
              const rowsOk = st.rows.length === expected.length && expected.every((e) => st.rows.some((r) => nk(r) === nk(e)));
              const noDup = !st.roots.some((r) => st.roots.some((s) => under(r, s))); // 无嵌套重复
              const noChildRoot = !st.roots.some((r) => nk(r) !== nk(DRIVE) && under(r, DRIVE)); // 不出现「F:\ 与 F:\VibeCode 两个根」
              const replaceOk = contained.length >= 1 && applied === true && toast.ok && setOk && rowsOk && noDup && noChildRoot && !st.empty;
              // 还原侧栏（不影响后续用例）
              await W(`window.__app.closeSidebarRoot(${JSON.stringify(DRIVE)})`);
              const restored = await W(`window.__app.openDirFromPath(${JSON.stringify(TEST_ROOT)})`);
              const back = await W('window.__app.state.sidebarRoots.slice()');
              const restoredOk = restored === true && back.some((r) => nk(r) === nk(TEST_ROOT));
              const ok = coldOk && replaceOk && restoredOk;
              return {
                ok,
                detail: 'cold[driveOnly=' + driveOnly + ',noContained=' + noContained + ',noNest=' + noNest1 + ',tree=' + treeOk + ',persisted=' + persistOk + ',alive=' + !h.st.exited + ']' +
                  ' replace[contained=' + contained.length + ',applied=' + applied + ',toast=' + toast.ok + ',setOk=' + setOk + ',rowsOk=' + rowsOk + ',noDup=' + noDup + ',noChildRoot=' + noChildRoot + ']' +
                  ' restore=' + restoredOk,
                evidence: 'drive=' + DRIVE + ' coldRoots=' + JSON.stringify(roots) + ' afterRoots=' + JSON.stringify(st.roots) + ' expect=' + JSON.stringify(expected) + ' toasts=' + JSON.stringify(toast.seen),
              };
            } finally {
              await killChild(h);
            }
          });

          // ---------- 6. rcDirSecondInstance：真·第二进程 → 单实例分支 → 首实例打开目标目录 ----------
          // 必须与首实例同 profile（MH_USERDATA），否则第二进程会另起一个 app、根本走不到 single-instance。
          const TARGET_SI = mkDir('mh-smoke-si-target-' + STAMP, ['si.md']);
          TEMP_DIRS.push(TARGET_SI);
          await runCase('rcDirSecondInstance', async () => {
            const profile = process.env.MH_USERDATA || app.getPath('userData');
            const procsBefore = electronProcs();
            const winsBefore = BrowserWindow.getAllWindows().slice();
            const captured = [];
            const onSecond = (_e, argv) => { captured.push(argv); };
            app.on('second-instance', onSecond);
            const h = spawnChild(['.', '--dir', TARGET_SI], profile);
            let fresh = [];
            try {
              const t0 = Date.now();
              while (Date.now() - t0 < 25000 && (!captured.length || !h.st.exited)) await sleep(200);
              const argv = captured[0] || null;
              const parsed = argv ? extractDirArg(argv) : null;
              const exitedOk = h.st.exited && h.st.code === 0; // 第二进程自行退出 = 走了单实例分支
              await sleep(1500); // 等首实例把 second-instance 新窗口 boot 起来
              const winsAfter = BrowserWindow.getAllWindows();
              fresh = winsAfter.filter((w) => !winsBefore.includes(w));
              let shot = null;
              if (fresh.length === 1) {
                shot = await fresh[0].webContents.executeJavaScript(`(async () => {
                  for (let i = 0; i < 150 && !window.__app; i++) await new Promise((r) => setTimeout(r, 100));
                  for (let i = 0; i < 100; i++) {
                    if (window.__app && window.__app.state.sidebarRoots.length) break;
                    await new Promise((r) => setTimeout(r, 100));
                  }
                  return {
                    roots: window.__app.state.sidebarRoots.slice(),
                    label: (document.getElementById('dir-label') || {}).textContent,
                    tabs: document.querySelectorAll('.tab').length,
                    rows: Array.from(document.querySelectorAll('#file-tree > .tree-node')).map((el) => el.dataset.path),
                  };
                })()`).catch((e) => ({ err: String(e && e.message) }));
              }
              const mainWinAlive = !win.isDestroyed() && (await win.webContents.executeJavaScript('!!window.__app').catch(() => false)) === true;
              const oneMore = winsAfter.length === winsBefore.length + 1;
              const opened = !!shot && Array.isArray(shot.roots) && shot.roots.length === 1 && nk(shot.roots[0]) === nk(TARGET_SI) &&
                shot.label === TARGET_SI && shot.tabs === 0 && shot.rows.length === 1 && nk(shot.rows[0]) === nk(TARGET_SI);
              // 收尾放在断言之前：既证明没留孤儿进程/残留窗口，也让证据里的进程数可读
              for (const w of fresh) {
                try { if (!w.isDestroyed()) w.destroy(); } catch { /* 已销毁 */ }
              }
              const killState = await killChild(h);
              await sleep(600);
              const procsAfter = electronProcs();
              const winsCleaned = BrowserWindow.getAllWindows().length === winsBefore.length;
              const noOrphan = h.st.exited;
              const ok = captured.length >= 1 && parsed === TARGET_SI && exitedOk && oneMore && opened && mainWinAlive && winsCleaned && noOrphan;
              return {
                ok,
                detail: 'secondInstanceEvents=' + captured.length + ',parsed=' + JSON.stringify(parsed) + ',childExit=' + (h.st.exited ? h.st.code : 'still-running') +
                  ',windows=' + winsBefore.length + '→' + winsAfter.length + ',openedInFirstInstance=' + opened + ',mainWinAlive=' + mainWinAlive +
                  ',winsCleaned=' + winsCleaned + ',noOrphan=' + noOrphan,
                evidence: 'argv=' + JSON.stringify(argv) + ' newWin=' + JSON.stringify(shot) + ' stdout=' + JSON.stringify(h.st.out.slice(0, 120)) +
                  ' kill=' + killState + ' procs=' + procsBefore + '→' + procsAfter + ' windows=' + winsBefore.length + '→' + BrowserWindow.getAllWindows().length,
              };
            } finally {
              app.removeListener('second-instance', onSecond);
              for (const w of fresh) {
                try { if (!w.isDestroyed()) w.destroy(); } catch { /* 已销毁 */ }
              }
              await killChild(h); // 幂等：已退出则直接返回
            }
          });
        } finally {
          // 6 项自身的残留清理：子进程（含未走完的）、临时夹具、脏 profile
          for (const h of childDirs) await killChild(h);
          for (const d of TEMP_DIRS) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
          }
        }
      }

      // ================= v0.5.0 多视图 Phase 4「跨窗口接管编辑」：4 项端到端回归 =================
      // 位置：全部既有用例（含 rcDir* 子进程段）之后、E2E_RESULTS 之前 —— 真·append。理由：
      //   ① rcDir* 段会断言首实例的 `.tab` 总数与窗口数，本段排在它之后，任何标签/窗口残留都波及不到它；
      //   ② 本段自带第二窗口（照抄 v0.1.51 mw* 段的 BrowserWindow 口径），结束时 destroy + 清会话。
      // 断言口径：渲染事实（横幅/按钮存在性、tab.readOnly、toast 文本、DOM 冲突横幅、文档内容）+
      //   主进程可观测事实（filewatch 锁表快照、fs.unwatchFile 是否带 listener）。
      // **逐合取项 detail**：每个合取项单独命名打印（"失败的是没进 detail 的那一项"是本会话踩过的坑）。
      // 夹具文件都在 TEST_ROOT 内（不是 build/，不参与分档）。
      {
        const { BrowserWindow } = require('electron');
        const fwatch = require('../src/main/filewatch'); // 与主进程同一模块实例（锁表/B3 探针）
        const P4_A = path.join(TEST_ROOT, 'mw-claim-a.md');
        const P4_B = path.join(TEST_ROOT, 'mw-claim-b.md');
        // 故意**不存在**的路径：fs.watch 对不存在的文件同步抛 ENOENT（node 实测）→ filewatch 必然
        // 走 fallbackToPoll 的 1000ms 轮询兜底 —— 这是让 B3 可复现的唯一确定性手段
        // （真实文件在 Windows 上 fs.watch 恒成功，无法从外部强制降级）。
        const P4_GHOST = path.join(TEST_ROOT, 'mw-poll-ghost.md');
        const p4J = (v) => JSON.stringify(v);
        const p4Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        /** 取值型求值：返回值会被**结构化克隆**回主进程 —— 只返回原始值/纯对象/纯数组 */
        const p4Eval = (w, code) => w.webContents.executeJavaScript(code);
        /** 副作用型求值：只改渲染端状态、不取回值（裸返回 tab/DOM/EditorView 会抛 could not be cloned） */
        const p4Effect = (w, expr) => w.webContents.executeJavaScript(`(async () => { await (${expr}); })()`);
        const p4Case = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        /** 合取项汇总：逐项命名 → detail 串每项独立可见（全真才算 true） */
        const p4Fail = (conj, evidence) => ({
          ok: Object.keys(conj).every((k) => conj[k] === true),
          detail: Object.keys(conj).map((k) => k + '=' + conj[k]).join(','),
          evidence: evidence || '',
        });
        // toast 记录器：toast 寿命 ~1.9s（ui.js），轮询必漏 —— MutationObserver 记录（口径同 hugeWatchAfterSave）
        const P4_TOAST_REC = `(() => {
          window.__mhLockToasts = [];
          const push = (el) => { try { if (el && el.classList && el.classList.contains('toast')) window.__mhLockToasts.push(el.textContent); } catch (e) {} };
          const mo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { push(n); if (n && n.querySelectorAll) n.querySelectorAll('.toast').forEach(push); } });
          mo.observe(document, { childList: true, subtree: true });
          document.querySelectorAll('.toast').forEach(push);
          return true;
        })()`;
        const p4ClearToasts = (w) => p4Eval(w, 'window.__mhLockToasts = []; true');
        // 只读横幅快照（p0 的横幅 = #lock-banner；每栏各一份 .lock-banner）
        const P4_BANNER = `(() => {
          const b = document.getElementById('lock-banner');
          const btn = b ? b.querySelector('.lock-claim') : null;
          return {
            shown: !!b && !b.classList.contains('hidden'),
            text: b ? ((b.querySelector('.lock-text') || {}).textContent || '') : '',
            path: b ? (b.dataset.path || '') : '',
            hasBtn: !!btn,
            btnHidden: !!(btn && btn.classList.contains('hidden')),
          };
        })()`;
        const p4Tab = (p) => `window.__app.editor.findTabByPath(${p4J(p)})`;
        const p4DocOf = (p) => `(() => { const ed = window.__app.editor; const t = ed.findTabByPath(${p4J(p)}); if (!t) return null; const els = ed.getPaneElsById(ed.paneIdOf(t)); return els && els.view ? els.view.state.doc.toString() : null; })()`;
        /** 点击某窗口横幅上的「✏️ 接管编辑」（真·DOM 点击，不调内部 API） */
        const p4ClickClaim = (w) => p4Eval(w, `(() => {
          const b = document.getElementById('lock-banner');
          const btn = b ? b.querySelector('.lock-claim') : null;
          if (!b || b.classList.contains('hidden') || !btn || btn.classList.contains('hidden')) return { clicked: false };
          btn.click();
          return { clicked: true };
        })()`);
        /** 轮询等待条件成立（返回值给 evidence）；超时返回最后一次取值 */
        const p4Wait = async (w, code, pred, ms = 6000, step = 300) => {
          const t0 = Date.now();
          let v = null;
          for (;;) {
            v = await p4Eval(w, code).catch(() => null);
            if (v && pred(v)) return v;
            if (Date.now() - t0 > ms) return v;
            await p4Sleep(step);
          }
        };
        const win2 = new BrowserWindow({
          width: 1200,
          height: 800,
          show: false,
          webPreferences: {
            preload: path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
          },
        });
        const p4Eval2 = (code) => p4Eval(win2, code);
        const p4Effect2 = (expr) => p4Effect(win2, expr);
        // 用例前的设置快照：必须在 try 之外声明 —— finally 里要逐字复原（首跑踩过 ReferenceError 的坑）
        let p4PrevDelay = null;
        try {
          await win2.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
          await p4Eval2(`(async () => { for (let i = 0; i < 120 && !window.__app; i++) await new Promise((r) => setTimeout(r, 100)); return !!window.__app; })()`);
          if (!(await p4Eval2('!!window.__app'))) throw new Error('第二窗口未 boot（__app 未就绪）');
          // 第二窗口：目录上下文（写盘/读盘走 security.js 的 rootDir 白名单）+ 清掉可能恢复的会话标签
          await p4Effect2(`window.__app.openDirFromPath(${p4J(TEST_ROOT)})`);
          await p4Effect2('window.__app.editor.closeAll()');
          await p4Sleep(600); // 等第二窗口的会话恢复彻底收尾（恢复是异步的，别让它的激活动作插进用例中间）
          await p4Eval(win, P4_TOAST_REC);
          await p4Eval2(P4_TOAST_REC);
          // 自动保存延迟抬到 60s：本段要在"有未保存修改"的瞬间做断言，800ms 自动保存会把脏状态抹掉
          // （settings:set 是既有键，广播到两个窗口；finally 逐字复原）
          p4PrevDelay = await p4Eval(win, 'window.api.getSettings().then((s) => s.autoSaveDelay)').catch(() => null);
          await p4Effect(win, 'window.api.setSettings({ autoSaveDelay: 60000 })');
          await p4Sleep(300);

          // ---------- 1. mwClaimEdit：B 接管 → A 转只读 + toast（横幅/按钮/锁表三面证据） ----------
          await p4Case('mwClaimEdit', async () => {
            fs.writeFileSync(P4_A, 'claim-a-v1\n', 'utf8');
            // win1 先开 = 编辑权持有者
            const o1 = await p4Eval(win, `(async () => {
              const ed = window.__app.editor;
              ed.closeByPath(${p4J(P4_A)});
              const t = await ed.openFile(${p4J(P4_A)});
              await new Promise((r) => setTimeout(r, 300));
              return { opened: !!(t && t.path), readOnly: !!(t && t.readOnly) };
            })()`);
            await p4Sleep(600);
            // win2 后开 = 只读观察窗（主进程发 file-shared-open → app.js 转只读；语义与 v0.1.51 相同）
            const o2 = await p4Eval2(`(async () => {
              const ed = window.__app.editor;
              const t = await ed.openFile(${p4J(P4_A)});
              await new Promise((r) => setTimeout(r, 800));
              return { opened: !!(t && t.path), readOnly: !!(t && t.readOnly) };
            })()`);
            const b0 = await p4Eval2(P4_BANNER);
            await p4ClearToasts(win);
            await p4ClearToasts(win2);
            const click = await p4ClickClaim(win2);
            // 主进程降级 win1 → file-lock-changed → 转只读 + toast（等事件落地）
            const a1 = await p4Wait(win, `(async () => {
              const t = ${p4Tab(P4_A)};
              const st = await window.api.docLockState(${p4J(P4_A)});
              return { readOnly: !!(t && t.readOnly), mode: st.mode, editCount: st.editCount, multiEdit: st.multiEdit, toasts: (window.__mhLockToasts || []).slice() };
            })()`, (v) => v.readOnly === true && v.toasts.some((s) => String(s).includes('接管')));
            const a1b = await p4Eval(win, P4_BANNER);
            const b1 = await p4Eval2(`(async () => {
              const t = ${p4Tab(P4_A)};
              const st = await window.api.docLockState(${p4J(P4_A)});
              return { readOnly: !!(t && t.readOnly), mode: st.mode, owner: st.owner, self: st.self, editCount: st.editCount };
            })()`);
            const b1b = await p4Eval2(P4_BANNER);
            const conj = {
              'win1-edit-first': o1.opened === true && o1.readOnly === false,
              'win2-readonly-shared': o2.opened === true && o2.readOnly === true,
              'win2-banner+claimBtn': b0.shown === true && b0.hasBtn === true && b0.btnHidden === false && b0.path === P4_A,
              'claim-clicked': click.clicked === true,
              'win2-editable-after': b1.readOnly === false,
              'win2-banner-hidden-after': b1b.shown === false,
              'win1-readonly-after': a1.readOnly === true,
              'win1-banner-after': a1b.shown === true && a1b.hasBtn === true && a1b.path === P4_A,
              'win1-toast-接管': a1.toasts.some((s) => String(s).includes('接管')),
              'lock-table-single-owner': b1.mode === 'edit' && b1.self === b1.owner && b1.editCount === 1 && a1.mode === 'read' && a1.editCount === 1 && a1.multiEdit === false,
            };
            return p4Fail(conj, 'o1=' + p4J(o1) + ' o2=' + p4J(o2) + ' b0=' + p4J(b0) + ' click=' + p4J(click) +
              ' win1=' + p4J({ readOnly: a1.readOnly, mode: a1.mode, editCount: a1.editCount, toasts: a1.toasts }) +
              ' win1Banner=' + p4J(a1b) + ' win2=' + p4J(b1) + ' win2Banner=' + p4J(b1b));
          });

          // ---------- 2. mwClaimBack：A 再接管回来（反向路径 + 双向 toast） ----------
          await p4Case('mwClaimBack', async () => {
            await p4ClearToasts(win);
            await p4ClearToasts(win2);
            const clickA = await p4ClickClaim(win);
            const a2 = await p4Wait(win, `(async () => {
              const t = ${p4Tab(P4_A)};
              const st = await window.api.docLockState(${p4J(P4_A)});
              return { readOnly: !!(t && t.readOnly), mode: st.mode, editCount: st.editCount, toasts: (window.__mhLockToasts || []).slice() };
            })()`, (v) => v.readOnly === false && v.toasts.some((s) => String(s).includes('接管')));
            const a2b = await p4Eval(win, P4_BANNER);
            const b2 = await p4Wait(win2, `(async () => {
              const t = ${p4Tab(P4_A)};
              const st = await window.api.docLockState(${p4J(P4_A)});
              return { readOnly: !!(t && t.readOnly), mode: st.mode, editCount: st.editCount, toasts: (window.__mhLockToasts || []).slice() };
            })()`, (v) => v.readOnly === true && v.toasts.some((s) => String(s).includes('接管')));
            const b2b = await p4Eval2(P4_BANNER);
            const conj = {
              'win1-claimBack-clicked': clickA.clicked === true,
              'win1-editable': a2.readOnly === false && a2.mode === 'edit',
              'win1-banner-hidden': a2b.shown === false,
              'win1-toast-接管': a2.toasts.some((s) => String(s).includes('接管')),
              'win2-readonly': b2.readOnly === true && b2.mode === 'read',
              'win2-banner+claimBtn': b2b.shown === true && b2b.hasBtn === true && b2b.path === P4_A,
              'win2-toast-接管': b2.toasts.some((s) => String(s).includes('接管')),
              'lock-table-single-owner': a2.editCount === 1 && b2.editCount === 1,
            };
            return p4Fail(conj, 'clickA=' + p4J(clickA) + ' win1=' + p4J(a2) + ' win1Banner=' + p4J(a2b) +
              ' win2=' + p4J(b2) + ' win2Banner=' + p4J(b2b));
          });

          // ---------- 3. mwConflictPrompt：L3 开关打开才提示；默认关不提示 ----------
          // 三段证据：① 默认关 + 只读观察窗 → 保存后静默同步、无冲突横幅；
          //           ② 开关打开 + 双窗口 claim → 两边都可编辑（不降级）→ 本窗口脏 + 对方保存 → DOM 冲突横幅；
          //           ③ 双方仍在 edit 态下把开关关掉 → 同样场景**不提示**（证明"提示"确实由开关门控，
          //              而不是"没有冲突场景"）。
          await p4Case('mwConflictPrompt', async () => {
            fs.writeFileSync(P4_B, 'conflict-v1\n', 'utf8');
            const o1 = await p4Eval(win, `(async () => {
              const ed = window.__app.editor;
              ed.closeByPath(${p4J(P4_B)});
              const t = await ed.openFile(${p4J(P4_B)});
              await new Promise((r) => setTimeout(r, 300));
              return { opened: !!(t && t.path), readOnly: !!(t && t.readOnly) };
            })()`);
            await p4Sleep(600);
            const o2 = await p4Eval2(`(async () => {
              const ed = window.__app.editor;
              const t = await ed.openFile(${p4J(P4_B)});
              await new Promise((r) => setTimeout(r, 800));
              return { opened: !!(t && t.path), readOnly: !!(t && t.readOnly) };
            })()`);
            // ---- ① 默认关 ----
            const l3off = await p4Eval(win, 'window.api.getConflictPrompt()');
            await p4ClearToasts(win2);
            await p4Effect(win, `(async () => {
              const ed = window.__app.editor;
              ed.activateByPath(${p4J(P4_B)});
              const t = ed.findTabByPath(${p4J(P4_B)});
              const v = ed.getView();
              v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'win1-stage1' } });
              clearTimeout(t.saveTimer);
              await ed.saveNow(t);
            })()`);
            const s1 = await p4Wait(win2, `(() => ({
              doc: ${p4DocOf(P4_B)},
              readOnly: !!((${p4Tab(P4_B)}) || {}).readOnly,
              conflict: (() => { const b = document.getElementById('conflict-banner'); return !!b && !b.classList.contains('hidden'); })(),
              toasts: (window.__mhLockToasts || []).slice(),
            }))()`, (v) => v.doc === 'win1-stage1');
            // ---- ② 开关打开 + 双窗口编辑 ----
            const on = await p4Eval(win, 'window.api.setConflictPrompt(true)');
            await p4Sleep(200);
            const clickOn = await p4ClickClaim(win2);
            const both = await p4Wait(win, `(async () => {
              const t = ${p4Tab(P4_B)};
              const st = await window.api.docLockState(${p4J(P4_B)});
              return { readOnly: !!(t && t.readOnly), editCount: st.editCount, multiEdit: st.multiEdit, conflictPrompt: st.conflictPrompt };
            })()`, (v) => v.editCount === 2);
            const both2 = await p4Eval2(`(async () => {
              const t = ${p4Tab(P4_B)};
              const st = await window.api.docLockState(${p4J(P4_B)});
              const b = document.getElementById('lock-banner');
              return {
                readOnly: !!(t && t.readOnly),
                editCount: st.editCount,
                multiEdit: st.multiEdit,
                bannerShown: !!b && !b.classList.contains('hidden'),
                bannerText: b ? ((b.querySelector('.lock-text') || {}).textContent || '') : '',
                claimBtnHidden: !!(b && b.querySelector('.lock-claim').classList.contains('hidden')),
              };
            })()`);
            const dirty2 = await p4Eval2(`(async () => {
              const ed = window.__app.editor;
              ed.activateByPath(${p4J(P4_B)});
              const t = ed.findTabByPath(${p4J(P4_B)});
              const v = ed.getView();
              v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'win2-local-dirty' } });
              clearTimeout(t.saveTimer);
              return { dirty: t.dirty === true, doc: v.state.doc.toString() };
            })()`);
            await p4Effect(win, `(async () => {
              const ed = window.__app.editor;
              ed.activateByPath(${p4J(P4_B)});
              const t = ed.findTabByPath(${p4J(P4_B)});
              const v = ed.getView();
              v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'win1-stage2' } });
              clearTimeout(t.saveTimer);
              await ed.saveNow(t);
            })()`);
            const conf = await p4Wait(win2, `(() => {
              const b = document.getElementById('conflict-banner');
              const t = ${p4Tab(P4_B)};
              return {
                shown: !!b && !b.classList.contains('hidden'),
                text: b ? ((b.querySelector('.conflict-text') || {}).textContent || '') : '',
                path: b ? (b.dataset.path || '') : '',
                doc: ${p4DocOf(P4_B)},
                dirty: !!(t && t.dirty),
              };
            })()`, (v) => v.shown === true);
            // ---- ③ 双方仍在 edit 态，把开关关掉 → 不提示 ----
            const off = await p4Eval(win, 'window.api.setConflictPrompt(false)');
            const keep = await p4Eval2(`(() => {
              const b = document.getElementById('conflict-banner');
              const btn = b ? b.querySelector('.conflict-keep') : null;
              if (!btn) return { clicked: false, shown: !!(b && !b.classList.contains('hidden')) };
              btn.click();
              return { clicked: true, shown: !!(b && !b.classList.contains('hidden')) };
            })()`);
            const dirty3 = await p4Eval2(`(async () => {
              const ed = window.__app.editor;
              const t = ed.findTabByPath(${p4J(P4_B)});
              const v = ed.getView();
              v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'win2-local-dirty-2' } });
              clearTimeout(t.saveTimer);
              return { dirty: t.dirty === true, doc: v.state.doc.toString() };
            })()`);
            await p4Effect(win, `(async () => {
              const ed = window.__app.editor;
              const t = ed.findTabByPath(${p4J(P4_B)});
              const v = ed.getView();
              v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'win1-stage3' } });
              clearTimeout(t.saveTimer);
              await ed.saveNow(t);
            })()`);
            await p4Sleep(2600); // 越过 SELF_WRITE_GRACE_MS(2000) + 通知防抖(300)
            const conf3 = await p4Eval2(`(() => {
              const b = document.getElementById('conflict-banner');
              const t = ${p4Tab(P4_B)};
              return {
                shown: !!b && !b.classList.contains('hidden'),
                doc: ${p4DocOf(P4_B)},
                dirty: !!(t && t.dirty),
              };
            })()`);
            const st3 = await p4Eval(win, `window.api.docLockState(${p4J(P4_B)})`);
            const conj = {
              'default-off': l3off === false,
              'stage1-sharedReadonly-silentSync': o1.readOnly === false && o2.readOnly === true && s1.doc === 'win1-stage1',
              'stage1-no-conflict-banner': s1.conflict === false,
              'stage1-no-conflict-toast': !s1.toasts.some((s) => String(s).includes('冲突')),
              'l3-on': on === true,
              'l3-claim-not-exclusive': clickOn.clicked === true && both.editCount === 2 && both.multiEdit === true && both.conflictPrompt === true,
              'l3-both-editable': both.readOnly === false && both2.readOnly === false,
              'l3-banner-sharedEdit-hint': both2.bannerShown === true && both2.claimBtnHidden === true && String(both2.bannerText).includes('另一窗口'),
              'win2-dirty-before-conflict': dirty2.dirty === true && dirty2.doc === 'win2-local-dirty',
              'conflict-banner-on': conf.shown === true && conf.path === P4_B && String(conf.text).includes('跨窗口') && String(conf.text).includes('未保存'),
              'conflict-keeps-local': conf.doc === 'win2-local-dirty' && conf.dirty === true,
              'l3-off-again': off === false,
              'conflict-banner-dismissed': keep.clicked === true && keep.shown === false,
              'stage3-still-multiEdit': st3.multiEdit === true && st3.editCount === 2,
              'stage3-no-conflict-banner': conf3.shown === false,
              'stage3-local-preserved': conf3.doc === 'win2-local-dirty-2' && conf3.dirty === true && dirty3.dirty === true,
            };
            return p4Fail(conj, 'o1=' + p4J(o1) + ' o2=' + p4J(o2) + ' l3off=' + l3off + ' s1=' + p4J(s1) +
              ' both=' + p4J(both) + ' both2=' + p4J(both2) + ' dirty2=' + p4J(dirty2) + ' conf=' + p4J(conf) +
              ' keep=' + p4J(keep) + ' conf3=' + p4J(conf3) + ' st3=' + p4J(st3));
          });

          // ---------- 4. mwNoPollBreak：一个窗口取消监听不影响另一个的轮询兜底（B3 修复） ----------
          await p4Case('mwNoPollBreak', async () => {
            try { fs.rmSync(P4_GHOST, { force: true }); } catch { /* 不存在则忽略 */ }
            // 两个窗口各自登记监听（路径不存在 → fs.watch 抛 ENOENT → 两侧都进轮询兜底）；
            // 同时装 file-changed 探针：事件**确实到达了哪个窗口**是渲染端事实，不靠内部 flag
            const arm = `(async () => {
              try { await window.api.unwatchFile(${p4J(P4_GHOST)}); } catch (e) { /* 未登记 */ }
              window.__mhPollHits = [];
              window.api.onFileChanged((d) => { if (d && d.path === ${p4J(P4_GHOST)}) window.__mhPollHits.push(d.path); });
              await window.api.watchFile(${p4J(P4_GHOST)}, 0);
              return true;
            })()`;
            await p4Eval(win, arm);
            await p4Eval2(arm);
            await p4Sleep(400);
            const w0 = fwatch.__debugWatchers(P4_GHOST); // 主进程实况：两条登记 + 都进了轮询兜底
            // win1 取消监听 —— B3 的触发点：修复前 `fs.unwatchFile(path)` 不带 listener 会把
            // win2 的 StatWatcher 监听一起摘掉（entry.poller 已置 true → 永不重建 → 此后静默漏事件）
            const origUnwatch = fs.unwatchFile;
            const unwatchCalls = [];
            fs.unwatchFile = function (p, listener) {
              unwatchCalls.push({ path: p, hasListener: typeof listener === 'function' });
              return origUnwatch.apply(this, arguments);
            };
            try {
              await p4Eval(win, `window.api.unwatchFile(${p4J(P4_GHOST)})`);
            } finally {
              fs.unwatchFile = origUnwatch;
            }
            await p4Sleep(300);
            const w1 = fwatch.__debugWatchers(P4_GHOST);
            const call = unwatchCalls.find((c) => c.path === P4_GHOST) || null;
            // 真·外部写：主进程 fs 直写（不经写盘 IPC → 不 markSelfWrite → 不会被自写回声吸收）
            fs.writeFileSync(P4_GHOST, 'poll-alive-1', 'utf8');
            const hit2v = await p4Wait(win2, '(window.__mhPollHits || []).length', (v) => Number(v) >= 1, 6000, 400);
            const hit2 = Number(hit2v) >= 1;
            const hit1 = Number(await p4Eval(win, '(window.__mhPollHits || []).length').catch(() => 0)) >= 1;
            const w2 = fwatch.__debugWatchers(P4_GHOST);
            const owners1 = w1.map((x) => x.winId);
            const conj = {
              'both-pollers-engaged': w0.length === 2 && w0.some((x) => x.winId === win.id) && w0.some((x) => x.winId === win2.id) &&
                w0.every((x) => x.poller === true && x.hasPollFn === true && x.fsw === false),
              'unwatch-passed-listener': !!(call && call.hasListener === true),
              'win1-entry-removed': owners1.length === 1 && owners1[0] === win2.id && !owners1.includes(win.id),
              'win2-poller-survived': !!(w1[0] && w1[0].poller === true && w1[0].hasPollFn === true),
              'win2-got-file-changed': hit2 === true,
              'win1-silent-after-unwatch': hit1 === false,
            };
            return p4Fail(conj, 'w0=' + p4J(w0) + ' unwatchCalls=' + p4J(unwatchCalls) + ' w1=' + p4J(w1) +
              ' w2=' + p4J(w2) + ' hits2=' + Number(hit2v) + ' hits1=' + (hit1 ? 1 : 0));
          });
        } finally {
          // 清场：关掉本段开的所有标签（脏标签会先落盘，随后夹具一起删）、复位会话与开关、销毁第二窗口
          try { await p4Eval(win, `(async () => { window.__app.editor.closeAll(); return true; })()`); } catch { /* 忽略 */ }
          try { await p4Eval2('window.__app.editor.closeAll()'); } catch { /* 忽略 */ }
          try { await p4Eval(win, 'window.api.setConflictPrompt(false)'); } catch { /* 忽略 */ }
          try { await p4Eval(win2, `(async () => { try { await window.api.unwatchFile(${p4J(P4_GHOST)}); } catch (e) {} return true; })()`); } catch { /* 忽略 */ }
          if (p4PrevDelay !== null) {
            try { await p4Eval(win, `window.api.setSettings({ autoSaveDelay: ${Number(p4PrevDelay) || 800} })`); } catch { /* 忽略 */ }
          }
          try { await p4Sleep(300); } catch { /* 忽略 */ }
          try { await p4Eval(win, `(async () => { await window.api.setSettings({ lastSession: null }); window.__app.state.settings = await window.api.getSettings(); return true; })()`); } catch { /* 忽略 */ }
          try { win2.destroy(); } catch { /* 已销毁 */ }
          for (const f of [P4_A, P4_B, P4_GHOST]) {
            try { fs.rmSync(f, { force: true }); } catch { /* 占用则忽略 */ }
          }
        }
      }

      // ============ v0.5.0 Phase 5a「体验 7 条」：7 项端到端回归 ============
      // 位置：全部既有用例（含 Phase 4 的 mw* 段）之后、E2E_RESULTS 之前 —— 真·append。
      // 断言口径：**渲染端可观测事实**（DOM 几何/类名/文本、CM 计算样式、设置回读、编辑器活动文档）
      //   + **主进程事实**（worker 清单缓存命中标志）。逐合取项单独命名打印（本会话踩过的坑）。
      // 夹具全部在 TEST_ROOT 下自建自清；结束时合栏 + closeAll + 复位面板/侧栏/字号。
      {
        const P5_OUTLINE = path.join(TEST_ROOT, 'p5-outline.md');
        const P5_OUTLINE2 = path.join(TEST_ROOT, 'p5-outline2.md');
        const P5_TXT = path.join(TEST_ROOT, 'p5-plain.txt');
        const P5_QO = path.join(TEST_ROOT, 'p5-qo-alpha-target.md');
        const P5_QO2 = path.join(TEST_ROOT, 'p5-qo-beta.md');
        const P5_QO3 = path.join(TEST_ROOT, 'p5-qo-gamma.md');
        const P5_TREE_DIR = path.join(TEST_ROOT, 'p5-tree');
        const P5_TREE_FILES = [path.join(P5_TREE_DIR, 'tree-a.md'), path.join(P5_TREE_DIR, 'tree-b.md')];
        // 标签溢出夹具：名字够长 + 数量够多（分栏后每栏 ~530px，单标签最小 ~60px → 必然溢出）
        const P5_TABS = Array.from({ length: 14 }, (_, i) => path.join(TEST_ROOT, 'p5-tab-' + String(i + 1).padStart(2, '0') + '-长名字标签夹具.md'));
        const P5_ALL_FILES = [P5_OUTLINE, P5_OUTLINE2, P5_TXT, P5_QO, P5_QO2, P5_QO3].concat(P5_TREE_FILES, P5_TABS);
        // 大纲夹具：4 个 ATX 标题 + 1 个围栏代码块内的伪标题（必须被跳过）+ 1 个四空格缩进的伪标题
        fs.writeFileSync(P5_OUTLINE, [
          '# 一级标题',
          '',
          '正文一',
          '',
          '## 二级 A',
          '',
          '正文二',
          '',
          '### 三级 A1',
          '',
          '正文三',
          '',
          '```',
          '# 不是标题（在代码块里）',
          '```',
          '',
          '## 二级 B',
          '',
          '正文四',
          '',
        ].join('\n'), 'utf8');
        fs.writeFileSync(P5_OUTLINE2, '# P2 标题\n\n## P2 二级\n\n内容\n', 'utf8');
        fs.writeFileSync(P5_TXT, '# 这行在 txt 里不算标题\n普通文本\n', 'utf8');
        for (const f of [P5_QO, P5_QO2, P5_QO3]) fs.writeFileSync(f, '# ' + path.basename(f) + '\n内容\n', 'utf8');
        fs.mkdirSync(P5_TREE_DIR, { recursive: true });
        for (const f of P5_TREE_FILES) fs.writeFileSync(f, '# ' + path.basename(f) + '\n', 'utf8');
        for (const f of P5_TABS) fs.writeFileSync(f, '# ' + path.basename(f) + '\n内容\n', 'utf8');

        const p5Eval = (code) => win.webContents.executeJavaScript(code);
        const p5Effect = (expr) => win.webContents.executeJavaScript(`(async () => { await (${expr}); })()`);
        const p5Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const p5J = (v) => JSON.stringify(v === undefined ? null : v);
        const p5Case = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        const p5Fail = (conj, evidence) => ({
          ok: Object.keys(conj).every((k) => conj[k] === true),
          detail: Object.keys(conj).map((k) => k + '=' + conj[k]).join(','),
          evidence: evidence || '',
        });
        /** 轮询等待条件成立（返回最后一次取值） */
        const p5Wait = async (code, pred, ms = 10000, step = 200) => {
          const t0 = Date.now();
          let v = null;
          for (;;) {
            v = await p5Eval(code).catch(() => null);
            if (v !== null && pred(v)) return v;
            if (Date.now() - t0 > ms) return v;
            await p5Sleep(step);
          }
        };
        /** 真·DOM 键盘事件（走 app.js 的 document keydown → help.js 的键位表分派） */
        const p5Key = (k, extra) => `(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${p5J(k)}, code: ${p5J(k)}, bubbles: true, cancelable: true }, ${p5J(extra || {})})));
          return true;
        })()`;
        /** 单栏收尾：先合栏再关标签（顺带清掉可能开着的浮层/菜单）。
         *  另外**重申工作目录 = TEST_ROOT**（幂等）：rcDir* 段与多窗口用例都可能动过首实例的
         *  侧栏根/活动目录，A1 的文件清单必须扫在夹具目录上，否则断言会莫名其妙地空。 */
        const p5Reset = async () => {
          await p5Effect(`window.__app.openDirFromPath(${p5J(TEST_ROOT)})`).catch(() => {});
          await p5Sleep(120);
          await p5Eval(`(() => {
            const e = window.__app.editor;
            if (window.__app.quickOpen) window.__app.quickOpen.close();
            document.querySelectorAll('.tabs-menu').forEach((m) => m.classList.add('hidden'));
            window.__app.editor.hideTabsHud();
            if (e.getPaneCount() > 1) e.mergePanes();
            e.closeAll();
            return e.getPaneCount();
          })()`).catch(() => -1);
          await p5Sleep(200);
        };
        const P5_PANEL = `(() => { const s = window.__app.bottomPanel.getState(); return s; })()`;

        try {
          // ---------------- 1. quickOpenBasic：Ctrl+P 快速打开（文件清单 + 模糊匹配 + 缓存） ----------------
          await p5Case('quickOpenBasic', async () => {
            await p5Reset();
            const beforePanel = await p5Eval(P5_PANEL);
            // ① 真·Ctrl+P 键盘事件打开浮层
            await p5Eval(p5Key('p', { ctrlKey: true }));
            const opened = await p5Wait(`window.__app.quickOpen.getState()`, (v) => v && v.open === true, 3000, 100);
            const inputFocusedV = await p5Wait(`(() => { const i = document.getElementById('qo-input'); return !!i && document.activeElement === i; })()`, (v) => v === true, 1500, 50);
            const inputFocused = inputFocusedV === true;
            // ② 等文件清单就绪（首扫流式；TEST_ROOT 里 build/ 已被 SKIP_DIRS 跳过）
            const ready = await p5Wait(`window.__app.quickOpen.getState()`, (v) => v && v.ready === true && v.total > 0, 20000, 250);
            const hasFixture = await p5Eval(`(() => { const s = window.__app.quickOpen.getState(); return { total: s.total, meta: s.meta }; })()`);
            // ③ 精确子串：query=alpha-target 的第一行必须就是目标文件（前缀/子串档优先于子序列档）
            const exact = await p5Eval(`(() => {
              const i = document.getElementById('qo-input');
              i.value = 'alpha-target';
              i.dispatchEvent(new Event('input'));
              const rows = Array.from(document.querySelectorAll('#qo-list .qo-row .qo-name')).map((n) => n.textContent);
              return { rows: rows.slice(0, 3), state: window.__app.quickOpen.getState() };
            })()`);
            // ④ 模糊（子序列）：'qta' 应能命中 p5-qo-alpha-target.md
            const fuzzy = await p5Eval(`(() => {
              const i = document.getElementById('qo-input');
              i.value = 'qta';
              i.dispatchEvent(new Event('input'));
              const rows = Array.from(document.querySelectorAll('#qo-list .qo-row .qo-name')).map((n) => n.textContent);
              return { rows: rows, matched: window.__app.quickOpen.getState().matched };
            })()`);
            // ⑤ 上下键移动选中项
            const nav = await p5Eval(`(() => {
              const i = document.getElementById('qo-input');
              i.value = 'p5-qo';
              i.dispatchEvent(new Event('input'));
              const s0 = window.__app.quickOpen.getState();
              i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
              const s1 = window.__app.quickOpen.getState();
              i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
              const s2 = window.__app.quickOpen.getState();
              return { sel0: s0.selected, sel1: s1.selected, sel2: s2.selected, rows: s0.rendered };
            })()`);
            // ⑥ Enter 打开选中文件（真正落到编辑器）。
            //    ⚠️ openFile 是异步的：派发 Enter 之后必须等一下再读活动标签，否则读到的是旧值。
            const enterSel = await p5Eval(`(() => {
              const i = document.getElementById('qo-input');
              i.value = 'alpha-target';
              i.dispatchEvent(new Event('input'));
              const sel = window.__app.quickOpen.getState().selectedPath;
              i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
              return { sel: sel, open: window.__app.quickOpen.getState().open };
            })()`);
            const enterPath = await p5Wait(`(() => { const t = window.__app.editor.getActiveTab(); return t ? t.path : null; })()`, (v) => v === P5_QO, 6000, 200);
            const enter = { sel: enterSel.sel, open: enterSel.open, path: enterPath };
            // ⑦ Esc 关浮层，且**不得**连带收起底部面板（app.js 对 .quick-open 内的按键不做全局分派）
            //    先把面板显式展开，否则"两边都是折叠"会让这条断言退化成恒真
            await p5Effect(`window.__app.bottomPanel.expand()`);
            await p5Sleep(150);
            await p5Eval(p5Key('p', { ctrlKey: true }));
            await p5Wait(`window.__app.quickOpen.getState()`, (v) => v && v.open === true, 3000, 100);
            const esc = await p5Eval(`(() => {
              const i = document.getElementById('qo-input');
              const before = window.__app.bottomPanel.getState().collapsed;
              i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
              return { open: window.__app.quickOpen.getState().open, panelBefore: before, panelAfter: window.__app.bottomPanel.getState().collapsed };
            })()`);
            // ⑧ 复用 search-worker 清单：第二次请求同一目录必须命中 worker 缓存（cached=true）
            const cache = await p5Eval(`window.api.searchFiles(${p5J(TEST_ROOT)}).then((r) => ({ total: r.total, cached: r.cached, hasFixture: r.files.indexOf(${p5J(P5_QO)}) >= 0 }))`).catch((e) => ({ err: String(e && e.message || e) }));
            const conj = {
              'ctrl-p-opens': !!(opened && opened.open === true),
              'input-focused': inputFocused === true,
              'list-ready': !!(ready && ready.ready === true && ready.total > 0),
              'list-from-worker-has-fixture': !!(hasFixture && hasFixture.total > 0),
              'exact-first-row': !!(exact && exact.rows[0] === 'p5-qo-alpha-target.md'),
              'fuzzy-subsequence': !!(fuzzy && fuzzy.rows.indexOf('p5-qo-alpha-target.md') >= 0),
              'arrow-moves-selection': !!(nav && nav.rows >= 3 && nav.sel1 === nav.sel0 + 1 && nav.sel2 === nav.sel0),
              'enter-opens-file': !!(enter && enter.sel === P5_QO && enter.path === P5_QO && enter.open === false),
              'esc-closes': !!(esc && esc.open === false),
              'esc-panel-was-expanded': !!(esc && esc.panelBefore === false),
              'esc-does-not-collapse-panel': !!(esc && esc.panelAfter === esc.panelBefore),
              'worker-cache-hit': !!(cache && cache.cached === true && cache.total > 0 && cache.hasFixture === true),
            };
            return p5Fail(conj, 'opened=' + p5J(opened) + ' ready=' + p5J(hasFixture) + ' exact=' + p5J(exact && exact.rows) +
              ' fuzzy=' + p5J(fuzzy && fuzzy.rows.slice(0, 4)) + ' nav=' + p5J(nav) + ' enter=' + p5J(enter) + ' esc=' + p5J(esc) +
              ' cache=' + p5J(cache) + ' panelBeforeCase=' + p5J(beforePanel && beforePanel.collapsed));
          });

          // ---------------- 2. tabOverflowUI：标签栏溢出（滚轮横滚 / ▾ 下拉 / Ctrl+Tab 浮层，按 pane） ----------------
          await p5Case('tabOverflowUI', async () => {
            await p5Reset();
            // p0 开 14 个长名标签；分栏；p1 只开 1 个 → 两栏溢出判据必须**各自**成立/不成立
            await p5Effect(`(async () => { const e = window.__app.editor; for (const p of ${p5J(P5_TABS)}) { await e.openFile(p); } })()`);
            await p5Sleep(600);
            await p5Effect(`window.__app.editor.toggleSplit()`);
            await p5Sleep(300);
            await p5Effect(`window.__app.editor.openFile(${p5J(P5_QO2)})`);
            await p5Sleep(500);
            const ov = await p5Eval(`(() => ({ p0: window.__app.editor.tabsOverflowOf('p0'), p1: window.__app.editor.tabsOverflowOf('p1'), layout: window.__app.editor.getPaneLayout() }))()`);
            // ① 滚轮横滚：真 wheel 事件（deltaY → scrollLeft），并确认事件被消费（defaultPrevented）
            const wheel = await p5Eval(`(() => {
              const el = window.__app.editor.getPaneEls(0).tabsEl;
              const before = Math.round(el.scrollLeft);
              const ev = new WheelEvent('wheel', { deltaY: 150, bubbles: true, cancelable: true });
              el.dispatchEvent(ev);
              return { before: before, after: Math.round(el.scrollLeft), prevented: ev.defaultPrevented };
            })()`);
            // ② 「▾ 全部标签」下拉：真点击 #tabs-more（p0 的按钮）→ 菜单只列**本栏**标签
            const menu = await p5Eval(`(() => {
              const btn = document.getElementById('tabs-more');
              const visible = !!btn && btn.offsetParent !== null;
              if (btn) btn.click();
              const s = window.__app.editor.tabsOverflowOf('p0');
              const p1names = Array.from(window.__app.editor.getPaneEls(1).tabsEl.querySelectorAll('.tab-name')).map((n) => n.textContent);
              return { btnVisible: visible, open: s.menuOpen, items: s.menuItems, names: s.menuNames, current: s.menuCurrent, p1names: p1names };
            })()`);
            // ③ 点菜单项 → 该文档在 p0 变成活动项（且 p1 的活动项不受影响）
            const clickItem = await p5Eval(`(() => {
              const items = document.querySelectorAll('#tabs-menu .tabs-menu-item');
              const target = items[3];
              const wantName = target ? (target.querySelector('.tm-name') || {}).textContent : null;
              if (target) target.click();
              const e = window.__app.editor;
              const a0 = e.paneActiveOf('p0');
              const a1 = e.paneActiveOf('p1');
              return { wantName: wantName, p0Active: a0 ? a0.name : null, p1Active: a1 ? a1.name : null, menuOpen: e.tabsOverflowOf('p0').menuOpen };
            })()`);
            await p5Sleep(200);
            // ④ Ctrl+Tab 切换浮层：真键盘事件（焦点栏 = p0），浮层内容 = 该栏标签
            await p5Effect(`window.__app.editor.focusPaneIndex(0)`);
            await p5Sleep(150);
            const hud = await p5Eval(`(() => {
              const e = window.__app.editor;
              const before = e.paneActiveOf('p0') ? e.paneActiveOf('p0').name : null;
              ${'document.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'Tab\', ctrlKey: true, bubbles: true, cancelable: true }));'}
              const s = e.tabsHudOf();
              const after = e.paneActiveOf('p0') ? e.paneActiveOf('p0').name : null;
              const p1names = Array.from(e.getPaneEls(1).tabsEl.querySelectorAll('.tab-name')).map((n) => n.textContent);
              return { visible: s.visible, items: s.items.length, current: s.current, before: before, after: after, leaked: s.items.filter((x) => p1names.some((n) => x.indexOf(n) >= 0)).length };
            })()`);
            const hudHide = await p5Wait(`window.__app.editor.tabsHudOf().visible`, (v) => v === false, 4000, 200);
            const conj = {
              'p0-overflows': !!(ov && ov.p0 && ov.p0.overflow === true && ov.p0.tabCount === 14),
              'p1-not-overflow': !!(ov && ov.p1 && ov.p1.overflow === false && ov.p1.tabCount === 1),
              'p0-btn-visible': !!(ov && ov.p0 && ov.p0.btnVisible === true),
              'p1-btn-hidden': !!(ov && ov.p1 && ov.p1.btnVisible === false),
              'wheel-scrolls-horizontally': !!(wheel && wheel.after > wheel.before && wheel.prevented === true),
              'menu-lists-own-pane-only': !!(menu && menu.btnVisible === true && menu.open === true && menu.items === 14 && menu.p1names.length === 1 && menu.names.indexOf(menu.p1names[0]) < 0),
              'menu-click-switches-active': !!(clickItem && clickItem.wantName === clickItem.p0Active && clickItem.menuOpen === false),
              'menu-click-keeps-other-pane': !!(clickItem && clickItem.p1Active === 'p5-qo-beta.md'),
              'ctrl-tab-hud-own-pane': !!(hud && hud.visible === true && hud.items === 14 && hud.leaked === 0 && !!hud.current),
              'ctrl-tab-switched': !!(hud && hud.before !== hud.after),
              'hud-auto-hides': hudHide === false,
            };
            await p5Eval(`window.__app.editor.hideTabsHud()`);
            return p5Fail(conj, 'ov=' + p5J(ov && { p0: ov.p0 && { o: ov.p0.overflow, n: ov.p0.tabCount, sw: ov.p0.scrollWidth, cw: ov.p0.clientWidth, btn: ov.p0.btnVisible }, p1: ov.p1 && { o: ov.p1.overflow, n: ov.p1.tabCount } }) +
              ' wheel=' + p5J(wheel) + ' menu=' + p5J(menu && { items: menu.items, current: menu.current, first3: menu.names.slice(0, 3), p1: menu.p1names }) +
              ' click=' + p5J(clickItem) + ' hud=' + p5J(hud && { visible: hud.visible, items: hud.items, current: hud.current, before: hud.before, after: hud.after, leaked: hud.leaked }));
          });

          // ---------------- 3. outlinePanel：大纲（markdown 标题树 / 点击跳转 / 随光标高亮 / 类型门控） ----------------
          await p5Case('outlinePanel', async () => {
            await p5Reset();
            await p5Effect(`window.__app.editor.openFile(${p5J(P5_OUTLINE)})`);
            await p5Sleep(500);
            const md = await p5Eval(`(() => {
              const s = window.__app.outline.getState();
              const names = Array.from(document.querySelectorAll('#outline-list .outline-item .ol-text')).map((n) => n.textContent);
              const lines = Array.from(document.querySelectorAll('#outline-list .outline-item')).map((n) => Number(n.dataset.line));
              return { state: s, names: names, lines: lines, blockHidden: document.getElementById('outline-block').classList.contains('hidden') };
            })()`);
            // 点击「二级 B」→ 光标跳到第 17 行（真 DOM 点击）
            const click = await p5Eval(`(() => {
              const rows = Array.from(document.querySelectorAll('#outline-list .outline-item'));
              const row = rows.find((r) => (r.querySelector('.ol-text') || {}).textContent === '二级 B');
              if (row) row.click();
              const v = window.__app.editor.getView();
              return { clicked: !!row, line: v.state.doc.lineAt(v.state.selection.main.head).number, state: window.__app.outline.getState() };
            })()`);
            // 光标跟随：把选区移到第 6 行（属「二级 A」章节）→ current 必须变成「二级 A」
            const follow = await p5Eval(`(() => {
              const e = window.__app.editor;
              const v = e.getView();
              const pos = v.state.doc.line(6).from;
              v.dispatch({ selection: { anchor: pos } });
              return window.__app.outline.getState();
            })()`);
            const followB = await p5Eval(`(() => {
              const v = window.__app.editor.getView();
              v.dispatch({ selection: { anchor: v.state.doc.line(18).from } });
              return window.__app.outline.getState();
            })()`);
            // 非 markdown：整体隐藏（连列表都要清空）
            const txt = await p5Eval(`(async () => {
              await window.__app.editor.openFile(${p5J(P5_TXT)});
              return { state: window.__app.outline.getState(), hiddenClass: document.getElementById('outline-block').classList.contains('hidden'), rows: document.querySelectorAll('#outline-list .outline-item').length };
            })()`);
            // 类型门控（与 UI 同源的纯函数）：huge / viewer-lg / image / diff / 非 md 一律 false
            const rules = await p5Eval(`(() => { const o = window.__app.outline; return {
              md: o.supports('a.md', undefined), mdChunked: o.supports('a.md', 'chunked'),
              mdHuge: o.supports('a.md', 'huge'), mdViewer: o.supports('a.md', 'viewer-lg'),
              mdImage: o.supports('a.md', 'image'), mdDiff: o.supports('a.md', 'diff'), txt: o.supports('a.txt', undefined),
              fence: o.parse('${'```'}\\n# 假标题\\n${'```'}\\n# 真标题\\n').map((h) => h.text),
            }; })()`);
            // 双栏跟随焦点栏：p0 开 outline.md、p1 开 outline2.md，切焦点栏 → 大纲跟着换
            const twoPane = await p5Eval(`(async () => {
              const e = window.__app.editor;
              await e.openFile(${p5J(P5_OUTLINE)});
              e.toggleSplit();
              await e.openFile(${p5J(P5_OUTLINE2)});
              await new Promise((r) => setTimeout(r, 300));
              const a = window.__app.outline.getState();
              e.focusPaneIndex(0);
              await new Promise((r) => setTimeout(r, 200));
              const b = window.__app.outline.getState();
              e.focusPaneIndex(1);
              await new Promise((r) => setTimeout(r, 200));
              const c = window.__app.outline.getState();
              return { inP1: { tab: a.tabName, first: a.current, title: a.title }, backP0: { tab: b.tabName, count: b.count }, againP1: { tab: c.tabName, count: c.count } };
            })()`);
            const conj = {
              'md-visible': !!(md && md.state.hidden === false && md.blockHidden === false),
              'four-headings': !!(md && md.state.rendered === 4 && md.names.length === 4),
              'fence-and-indent-skipped': !!(md && md.names.indexOf('不是标题（在代码块里）') < 0 && rules && Array.isArray(rules.fence) && rules.fence.length === 1 && rules.fence[0] === '真标题'),
              'line-numbers-correct': !!(md && md.lines.join(',') === '1,5,9,17'),
              'click-jumps': !!(click && click.clicked === true && click.line === 17 && click.state.current === '二级 B'),
              'cursor-follows': !!(follow && follow.current === '二级 A' && follow.currentLine === 5),
              'cursor-follows-second': !!(followB && followB.current === '二级 B' && followB.currentLine === 17),
              'txt-hidden': !!(txt && txt.state.hidden === true && txt.hiddenClass === true && txt.rows === 0),
              'type-rules': !!(rules && rules.md === true && rules.mdChunked === true && rules.mdHuge === false && rules.mdViewer === false && rules.mdImage === false && rules.mdDiff === false && rules.txt === false),
              'two-pane-follows-focus': !!(twoPane && twoPane.inP1.tab === 'p5-outline2.md' && twoPane.backP0.tab === 'p5-outline.md' && twoPane.againP1.tab === 'p5-outline2.md' && twoPane.backP0.count === 4),
            };
            return p5Fail(conj, 'md=' + p5J(md && { hidden: md.state.hidden, rendered: md.state.rendered, names: md.names, lines: md.lines }) +
              ' click=' + p5J(click && { line: click.line, current: click.state.current }) +
              ' follow=' + p5J({ a: follow && follow.current, b: followB && followB.current }) +
              ' txt=' + p5J(txt && { hidden: txt.state.hidden, rows: txt.rows }) + ' rules=' + p5J(rules) + ' twoPane=' + p5J(twoPane));
          });

          // ---------------- 4. fontSizeSetting：字号/行高设置 + Ctrl+= / Ctrl+- / Ctrl+0 ----------------
          await p5Case('fontSizeSetting', async () => {
            await p5Reset();
            await p5Effect(`window.__app.editor.openFile(${p5J(P5_OUTLINE)})`);
            await p5Sleep(400);
            /** 走**真实设置弹窗**改字号/行高/预览字号（顺带验证弹窗接线与白名单；
             *  输入框顺序：number 型依次为 大文件上限 / 自动保存 / 滚动条 / 缩进 / 编辑器字号 / 行高 / 预览字号）。 */
            const setViaDialog = (f, l, p) => `(async () => {
              document.getElementById('btn-settings').click();
              await new Promise((r) => setTimeout(r, 200));
              const nums = document.querySelectorAll('#modal-body input[type="number"]');
              const count = nums.length;
              nums[4].value = ${p5J(String(f))};
              nums[5].value = ${p5J(String(l))};
              nums[6].value = ${p5J(String(p))};
              document.querySelector('#modal-actions .tbtn.primary').click();
              await new Promise((r) => setTimeout(r, 350));
              const s = await window.api.getSettings();
              const cs = getComputedStyle(document.documentElement);
              return { count: count, saved: { f: s.editorFontSize, l: s.editorLineHeight, p: s.previewFontSize },
                v: { f: cs.getPropertyValue('--mh-editor-font-size').trim(), l: cs.getPropertyValue('--mh-editor-line-height').trim(), p: cs.getPropertyValue('--mh-preview-font-size').trim() },
                modalHidden: document.getElementById('modal-mask').classList.contains('hidden') };
            })()`;
            // ① 弹窗保存 18px / 行高 2 / 预览 20px → 白名单 + 落盘 + CSS 变量 + 计算样式
            const set1 = await p5Eval(setViaDialog(18, 2, 20));
            const computed = await p5Eval(`(() => {
              const cm = document.querySelector('#editor-host .cm-editor');
              const sc = document.querySelector('#editor-host .cm-scroller');
              const pv = document.getElementById('preview-content');
              return { cmFont: cm ? getComputedStyle(cm).fontSize : null, cmLine: sc ? getComputedStyle(sc).lineHeight : null, pvFont: pv ? getComputedStyle(pv).fontSize : null };
            })()`);
            const reread = await p5Eval(`window.api.getSettings().then((s) => ({ f: s.editorFontSize, l: s.editorLineHeight, p: s.previewFontSize }))`);
            // ② 双栏：另一栏的 CM 必须同时跟随（CSS 变量挂在 :root ⇒ 所有栏/所有预览一起变）
            const two = await p5Eval(`(async () => {
              const e = window.__app.editor;
              e.toggleSplit();
              await e.openFile(${p5J(P5_OUTLINE2)});
              await new Promise((r) => setTimeout(r, 300));
              const cm0 = document.querySelector('#editor-host .cm-editor');
              const cm1 = e.getPaneEls(1).root.querySelector('.cm-editor');
              return { cm0: cm0 ? getComputedStyle(cm0).fontSize : null, cm1: cm1 ? getComputedStyle(cm1).fontSize : null,
                varNow: getComputedStyle(document.documentElement).getPropertyValue('--mh-editor-font-size').trim() };
            })()`);
            // ③ Ctrl+= / Ctrl+- 真键盘事件（走 help.js 键表 → app.js 动作，当前值从主进程现读）
            await p5Eval(p5Key('=', { ctrlKey: true }));
            await p5Sleep(300);
            const up = await p5Eval(`window.api.getSettings().then((s) => ({ v: s.editorFontSize, varNow: getComputedStyle(document.documentElement).getPropertyValue('--mh-editor-font-size').trim() }))`);
            await p5Eval(p5Key('-', { ctrlKey: true }));
            await p5Sleep(300);
            const down = await p5Eval(`window.api.getSettings().then((s) => s.editorFontSize)`);
            // ③b **真·输入事件**（webContents.sendInputEvent 走浏览器进程输入管线，会经过菜单快捷键）：
            //     Electron 默认菜单带 View → Zoom In/Out/Reset（Ctrl+Plus / Ctrl+- / Ctrl+0），
            //     若被菜单吃掉，渲染端根本收不到 keydown，而**整个界面会被缩放**（webContents.zoomLevel 变化）。
            //     判据只认"菜单是否真的把界面缩放了"：zoomLevel 变化 = 键位被菜单截胡（真红）；
            //     若窗口未获焦点（sendInputEvent 空转）则两者都不变，不冤判。用完把 zoomLevel 复位。
            const realKey = await (async () => {
              const zl0 = win.webContents.getZoomLevel();
              const f0 = await p5Eval(`window.api.getSettings().then((s) => s.editorFontSize)`);
              const attempt = async (keyCode) => {
                try {
                  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: keyCode, modifiers: ['control'] });
                  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: keyCode, modifiers: ['control'] });
                } catch { /* 非法 keyCode：忽略 */ }
                await p5Sleep(350);
                return { font: await p5Eval(`window.api.getSettings().then((s) => s.editorFontSize)`), zoom: win.webContents.getZoomLevel() };
              };
              const withEq = await attempt('=');
              const withPlus = await attempt('Plus');
              const zl1 = win.webContents.getZoomLevel();
              if (zl1 !== zl0) { try { win.webContents.setZoomLevel(zl0); } catch { /* 忽略 */ } }
              return { zl0: zl0, zl1: zl1, f0: f0, eq: withEq, plus: withPlus, zoomReset: win.webContents.getZoomLevel() };
            })();
            // ④ 上下限：弹窗输入 40 / 5 被夹到 32 / 10，再按方向键保持不动（命中"已是上限/下限"分支）。
            //    setHi 顺带把行高设成 **1.65**（默认值同款两位小数）：专门守"两位小数被归整成 1.7"
            //    这条**静默漂移**——首轮验收唯一那条红就是它（落盘 1.65、CSS 变量却成了 1.7）。
            const setHi = await p5Eval(setViaDialog(40, 1.65, 20));
            await p5Eval(p5Key('=', { ctrlKey: true }));
            await p5Sleep(300);
            const hiHold = await p5Eval(`window.api.getSettings().then((s) => s.editorFontSize)`);
            const setLo = await p5Eval(setViaDialog(5, 2, 20));
            await p5Eval(p5Key('-', { ctrlKey: true }));
            await p5Sleep(300);
            const loHold = await p5Eval(`window.api.getSettings().then((s) => s.editorFontSize)`);
            // ⑤ Ctrl+0 语义：编辑器/预览字号 + 行高复位，且预览缩放回 100%（后者是 Ctrl+0 的原有行为）
            //    ⚠️ preview 实例跟着**焦点栏**走：上面双栏步骤把焦点留在了 p1，这里必须先聚焦 p0，
            //    否则 resetZoom 作用在 p1 的预览宿主上，而断言的 #preview-host 是 p0 的（恒不变）。
            await p5Effect(`window.__app.editor.focusPaneIndex(0)`);
            await p5Sleep(200);
            const zero = await p5Eval(`(() => {
              const host = document.querySelector('#preview-host');
              host.style.zoom = '';
              host.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
              const zoomBefore = host.style.zoom;
              const fontBefore = getComputedStyle(document.documentElement).getPropertyValue('--mh-editor-font-size').trim();
              ${'document.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'0\', ctrlKey: true, bubbles: true }));'}
              const cs = getComputedStyle(document.documentElement);
              return { zoomBefore: zoomBefore, zoomAfter: host.style.zoom, fontBefore: fontBefore,
                vf: cs.getPropertyValue('--mh-editor-font-size').trim(), vl: cs.getPropertyValue('--mh-editor-line-height').trim(), vp: cs.getPropertyValue('--mh-preview-font-size').trim() };
            })()`);
            await p5Sleep(350);
            const zeroSaved = await p5Eval(`window.api.getSettings().then((s) => ({ f: s.editorFontSize, l: s.editorLineHeight, p: s.previewFontSize }))`);
            const conj = {
              'dialog-has-new-fields': !!(set1 && set1.count === 7 && set1.modalHidden === true),
              'whitelist-accepts': !!(set1 && set1.saved.f === 18 && set1.saved.l === 2 && set1.saved.p === 20),
              'persisted': !!(reread && reread.f === 18 && reread.l === 2 && reread.p === 20),
              'css-vars-applied': !!(set1 && set1.v.f === '18px' && set1.v.l === '2' && set1.v.p === '20px'),
              'cm-font-size': !!(computed && computed.cmFont === '18px'),
              'cm-line-height': !!(computed && computed.cmLine === '36px'),
              'preview-font-size': !!(computed && computed.pvFont === '20px'),
              'both-panes-follow': !!(two && two.cm0 === '18px' && two.cm1 === '18px' && two.varNow === '18px'),
              'ctrl-equals-increases': !!(up && up.v === 19 && up.varNow === '19px'),
              'ctrl-minus-decreases': down === 18,
              'real-key-not-eaten-by-menu': !!(realKey && realKey.zl1 === realKey.zl0),
              'clamp-high-via-dialog': !!(setHi && setHi.saved.f === 32 && setHi.v.f === '32px'),
              // 两位小数（0.05 步长域）必须原样落到 CSS 变量，不得被归整成 1.7
              'fractional-line-height-preserved': !!(setHi && setHi.saved.l === 1.65 && setHi.v.l === '1.65'),
              'ctrl-equals-holds-at-max': hiHold === 32,
              'clamp-low-via-dialog': !!(setLo && setLo.saved.f === 10 && setLo.v.f === '10px'),
              'ctrl-minus-holds-at-min': loHold === 10,
              'ctrl-0-resets-fonts': !!(zero && zero.fontBefore === '10px' && zero.vf === '13.5px' && zero.vl === '1.65' && zero.vp === '14.5px'),
              'ctrl-0-resets-preview-zoom': !!(zero && zero.zoomBefore === '1.1' && zero.zoomAfter === '1'),
              'ctrl-0-persisted': !!(zeroSaved && zeroSaved.f === 13.5 && zeroSaved.l === 1.65 && zeroSaved.p === 14.5),
            };
            return p5Fail(conj, 'set1=' + p5J(set1) + ' computed=' + p5J(computed) + ' reread=' + p5J(reread) + ' two=' + p5J(two) +
              ' up=' + p5J(up) + ' down=' + p5J(down) + ' realKey=' + p5J(realKey) +
              ' setHi=' + p5J(setHi && { s: setHi.saved.f, l: setHi.saved.l, v: setHi.v.f, vl: setHi.v.l }) + ' hiHold=' + p5J(hiHold) +
              ' setLo=' + p5J(setLo && { s: setLo.saved.f, v: setLo.v.f }) + ' loHold=' + p5J(loHold) + ' zero=' + p5J(zero) + ' zeroSaved=' + p5J(zeroSaved) +
              // want/got 并排（首轮就是靠"落盘=1.65 而变量=1.7"这类对照才定位到夹取精度 bug 的）
              ' ctrl0-want=13.5px/1.65/14.5px got=' + (zero ? zero.vf + '/' + zero.vl + '/' + zero.vp : '-') + '(before=' + (zero ? zero.fontBefore : '-') + ')');
          });

          // ---------------- 5. bottomPanelCollapse：底部面板默认折叠 + 按需展开 + 最大化/还原 ----------------
          await p5Case('bottomPanelCollapse', async () => {
            await p5Reset();
            await p5Effect(`window.__app.editor.openFile(${p5J(P5_OUTLINE)})`);
            await p5Sleep(300);
            const boot = await p5Eval(`window.__app.bottomPanel.getState()`);
            const DEF = await p5Eval(`window.__app.bottomPanel.DEFAULT_COLLAPSED`);
            // ① 折叠态：面板体不可见（等价于旧用例读 DOM 文本时"看不到但还在"）
            const collapsed = await p5Eval(`(() => {
              window.__app.bottomPanel.collapse();
              const panel = document.getElementById('bottom-panel');
              const body = document.getElementById('panel-find');
              return { cls: panel.classList.contains('collapsed'), h: Math.round(panel.getBoundingClientRect().height),
                bodyH: body.offsetHeight, bodyDisplay: getComputedStyle(body).display,
                pyInDom: !!document.getElementById('panel-python') };
            })()`);
            // ② 点击面板标题页签 → 按需展开
            const expanded = await p5Eval(`(() => {
              document.querySelector('.ptab[data-panel="find"]').click();
              const panel = document.getElementById('bottom-panel');
              const body = document.getElementById('panel-find');
              return { cls: panel.classList.contains('collapsed'), h: Math.round(panel.getBoundingClientRect().height), bodyH: body.offsetHeight };
            })()`);
            // ③ 最大化 / 还原（点标题栏 ⛶）
            const max = await p5Eval(`(() => {
              const panel = document.getElementById('bottom-panel');
              const before = Math.round(panel.getBoundingClientRect().height);
              document.getElementById('btn-max-panel').click();
              const maxed = { cls: panel.classList.contains('maximized'), h: Math.round(panel.getBoundingClientRect().height) };
              document.getElementById('btn-max-panel').click();
              const after = { cls: panel.classList.contains('maximized'), h: Math.round(panel.getBoundingClientRect().height) };
              return { before: before, maxed: maxed, after: after };
            })()`);
            // ④ ✕ 收起 与 Esc 收起
            const closeBtn = await p5Eval(`(() => {
              document.getElementById('btn-close-panel').click();
              return window.__app.bottomPanel.getState();
            })()`);
            await p5Eval(`window.__app.bottomPanel.expand()`);
            await p5Sleep(120);
            await p5Eval(p5Key('Escape', {}));
            await p5Sleep(150);
            const escState = await p5Eval(`window.__app.bottomPanel.getState()`);
            // ⑤ **既有用例依赖什么**：折叠态下面板体的 DOM 与写值路径必须照样可用
            //    （findAll 读 #find-results .find-result；pyUI 读 #py-output —— 折叠只是 CSS display:none）
            const legacy = await p5Eval(`(async () => {
              window.__app.bottomPanel.collapse();
              const fi = document.getElementById('find-input');
              fi.value = '正文';
              fi.dispatchEvent(new Event('input'));
              await new Promise((r) => setTimeout(r, 300));
              const rows = document.querySelectorAll('#find-results .find-result').length;
              const count = document.getElementById('find-count').textContent;
              const pyOut = document.getElementById('py-output');
              pyOut.textContent = 'PY_PROBE';
              return { rows: rows, count: count, pyText: pyOut.textContent,
                collapsed: document.getElementById('bottom-panel').classList.contains('collapsed'),
                pyVisible: pyOut.offsetHeight > 0 };
            })()`);
            await p5Eval(`window.__app.find.clearSearch()`);
            // ⑥ 恢复默认（折叠）交给后续用例
            await p5Eval(`window.__app.bottomPanel.collapse()`);
            const conj = {
              'boot-default-collapsed': !!(boot && boot.bootCollapsed === true && boot.maximized === false && DEF === true),
              'collapse-hides-body': !!(collapsed && collapsed.cls === true && collapsed.bodyH === 0 && collapsed.bodyDisplay === 'none'),
              'collapsed-keeps-dom': !!(collapsed && collapsed.pyInDom === true),
              'ptab-click-expands': !!(expanded && expanded.cls === false && expanded.bodyH > 100),
              'maximize-grows': !!(max && max.maxed.cls === true && max.maxed.h > max.before + 100),
              'restore-shrinks': !!(max && max.after.cls === false && Math.abs(max.after.h - max.before) <= 8),
              'close-button-collapses': !!(closeBtn && closeBtn.collapsed === true),
              'esc-collapses': !!(escState && escState.collapsed === true),
              'legacy-find-rows-while-collapsed': !!(legacy && legacy.collapsed === true && legacy.rows > 0),
              'legacy-py-output-while-collapsed': !!(legacy && legacy.pyText === 'PY_PROBE'),
            };
            return p5Fail(conj, 'boot=' + p5J(boot) + ' DEF=' + p5J(DEF) + ' collapsed=' + p5J(collapsed) + ' expanded=' + p5J(expanded) +
              ' max=' + p5J(max) + ' closeBtn=' + p5J(closeBtn && { collapsed: closeBtn.collapsed }) + ' esc=' + p5J(escState && { collapsed: escState.collapsed }) +
              ' legacy=' + p5J(legacy && { rows: legacy.rows, count: legacy.count, collapsed: legacy.collapsed }));
          });

          // ---------------- 6. sidebarCollapse：侧栏三分区折叠 + 记忆（不破坏树的展开态） ----------------
          await p5Case('sidebarCollapse', async () => {
            await p5Reset();
            // 先让树里出现一个可展开的目录（p5-tree），并保证它是收起的
            await p5Eval(`(async () => { await window.__app.tree.refreshNode(${p5J(TEST_ROOT)}, true); return true; })()`);
            await p5Sleep(400);
            const heads = await p5Eval(`(() => ({
              fav: !!document.getElementById('fav-header'), tree: !!document.getElementById('tree-header'),
              search: !!document.getElementById('search-header'), caretTree: (document.getElementById('tree-caret') || {}).textContent,
            }))()`);
            // 展开 p5-tree 目录（真点击树节点）→ 记下子行数。
            // ⚠️ 树的行与它的子容器是**兄弟节点**（makeRow 返回 {row, children}，render/loadChildren
            //    都把两者依次 append 到同一父容器），所以子行要经 row.nextElementSibling 取。
            const expandDir = await p5Eval(`(async () => {
              const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
              const dir = ${p5J(P5_TREE_DIR)};
              const all = () => Array.from(document.querySelectorAll('#file-tree .tree-node'));
              const kidsOf = (row) => {
                const box = row && row.nextElementSibling;
                return box && box.classList && box.classList.contains('tree-children') ? box.querySelectorAll('.tree-node').length : -1;
              };
              let row = all().find((n) => norm(n.dataset.path) === norm(dir));
              if (!row) { await window.__app.tree.refreshNode(${p5J(TEST_ROOT)}, true); await new Promise((r) => setTimeout(r, 400)); row = all().find((n) => norm(n.dataset.path) === norm(dir)); }
              if (row) row.click();
              await new Promise((r) => setTimeout(r, 600));
              row = all().find((n) => norm(n.dataset.path) === norm(dir));
              return { found: !!row, kids: kidsOf(row), icon: row ? (row.querySelector('.icon') || {}).textContent : null };
            })()`);
            // ① 折叠树分区 → 容器不可见 + 记忆进 settings
            const treeOff = await p5Eval(`(() => {
              document.getElementById('tree-header').click();
              const t = document.getElementById('file-tree');
              return { cls: t.classList.contains('collapsed'), h: t.offsetHeight, state: window.__app.sidebarSections.getState() };
            })()`);
            await p5Sleep(250);
            const treeSaved = await p5Eval(`window.api.getSettings().then((s) => s.sidebarCollapsed)`);
            // ② 再展开 → 树的展开态必须原样保留（J4 的展开态恢复未被破坏）
            const treeOn = await p5Eval(`(() => {
              document.getElementById('tree-header').click();
              const t = document.getElementById('file-tree');
              const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
              const row = Array.from(document.querySelectorAll('#file-tree .tree-node')).find((n) => norm(n.dataset.path) === norm(${p5J(P5_TREE_DIR)}));
              const box = row && row.nextElementSibling;
              const kids = box && box.classList && box.classList.contains('tree-children') ? box.querySelectorAll('.tree-node').length : -1;
              return { cls: t.classList.contains('collapsed'), h: t.offsetHeight, kids: kids,
                icon: row ? (row.querySelector('.icon') || {}).textContent : null, state: window.__app.sidebarSections.getState() };
            })()`);
            // ③ 收藏分区折叠（走 favorites.js 的标题行 → 回调落盘）
            const favOff = await p5Eval(`(() => {
              document.getElementById('fav-header').click();
              return { cls: document.getElementById('fav-block').classList.contains('collapsed'), listH: document.getElementById('fav-list').offsetHeight, state: window.__app.sidebarSections.getState() };
            })()`);
            await p5Sleep(250);
            const favSaved = await p5Eval(`window.api.getSettings().then((s) => s.sidebarCollapsed)`);
            // ④ 搜索分区折叠：标题行仍在，输入区与结果区隐藏。
            //    **折叠前先取一次快照** —— "各分区互不影响"只能靠前后差集证明（此刻 fav 仍是
            //    第③步折叠后的 true，早先写成"期望 fav=false"是把用例自身的步骤记错了）。
            const searchOff = await p5Eval(`(() => {
              const before = window.__app.sidebarSections.getState();
              document.getElementById('search-header').click();
              const s = document.getElementById('sidebar-search');
              const bar = s.querySelector('.gs-bar');
              return { before: before, cls: s.classList.contains('collapsed'), barH: bar.offsetHeight, headDisplay: getComputedStyle(document.getElementById('search-header')).display,
                state: window.__app.sidebarSections.getState() };
            })()`);
            // ⑤ 三分区互不影响：折叠 search 只翻 search 一位，fav/tree 的**折叠态与其 DOM 类原样不动**
            const indep = await p5Eval(`(() => {
              const s = window.__app.sidebarSections.getState();
              return { s: s,
                treeCls: document.getElementById('file-tree').classList.contains('collapsed'),
                favCls: document.getElementById('fav-block').classList.contains('collapsed'),
                searchCls: document.getElementById('sidebar-search').classList.contains('collapsed') };
            })()`);
            // 收尾：三分区复位为全展开（settings 也复位）
            await p5Eval(`window.__app.sidebarSections.set({ fav: false, tree: false, search: false })`);
            await p5Sleep(250);
            const reset = await p5Eval(`(async () => {
              const s = await window.api.getSettings();
              return { mem: s.sidebarCollapsed, treeCls: document.getElementById('file-tree').classList.contains('collapsed'), searchCls: document.getElementById('sidebar-search').classList.contains('collapsed'), favCls: document.getElementById('fav-block').classList.contains('collapsed') };
            })()`);
            const conj = {
              'three-headers': !!(heads && heads.fav && heads.tree && heads.search),
              'dir-expanded-fixture': !!(expandDir && expandDir.found === true && expandDir.kids === 2),
              'tree-collapse-hides': !!(treeOff && treeOff.cls === true && treeOff.h === 0 && treeOff.state.tree === true),
              'tree-collapse-persisted': !!(treeSaved && treeSaved.tree === true),
              'tree-expand-restores': !!(treeOn && treeOn.cls === false && treeOn.h > 0 && treeOn.state.tree === false),
              'tree-expand-state-kept': !!(treeOn && treeOn.kids === 2 && treeOn.icon === '📂'),
              'fav-collapse': !!(favOff && favOff.cls === true && favOff.listH === 0 && favOff.state.fav === true),
              'fav-collapse-persisted': !!(favSaved && favSaved.fav === true),
              'search-collapse': !!(searchOff && searchOff.cls === true && searchOff.barH === 0 && searchOff.headDisplay !== 'none'),
              // 独立性判据（差集口径）：折叠前后**只有 search 一位翻转**，
              // fav（第③步已折叠）/tree（第②步已展开）的折叠态与 DOM 类都不变。
              'sections-independent': !!(searchOff && searchOff.before && indep
                && searchOff.before.search === false && searchOff.before.fav === true && searchOff.before.tree === false
                && indep.s.search === true && indep.s.fav === searchOff.before.fav && indep.s.tree === searchOff.before.tree
                && indep.favCls === true && indep.treeCls === false && indep.searchCls === true),
              'reset-all-expanded': !!(reset && reset.mem && reset.mem.tree === false && reset.mem.fav === false && reset.mem.search === false && reset.treeCls === false && reset.searchCls === false && reset.favCls === false),
            };
            return p5Fail(conj, 'heads=' + p5J(heads) + ' expandDir=' + p5J(expandDir) + ' treeOff=' + p5J(treeOff && { cls: treeOff.cls, h: treeOff.h, st: treeOff.state }) +
              ' treeSaved=' + p5J(treeSaved) + ' treeOn=' + p5J(treeOn && { cls: treeOn.cls, h: treeOn.h, kids: treeOn.kids, icon: treeOn.icon }) +
              ' favOff=' + p5J(favOff && { cls: favOff.cls, listH: favOff.listH }) + ' favSaved=' + p5J(favSaved) +
              ' searchOff=' + p5J(searchOff && { cls: searchOff.cls, barH: searchOff.barH, head: searchOff.headDisplay }) +
              ' indep=' + p5J(indep) + ' reset=' + p5J(reset));
          });

          // ---------------- 7. helpPanel：F1 / Ctrl+/ 快捷键面板 + 键位单一数据源 ----------------
          await p5Case('helpPanel', async () => {
            await p5Reset();
            // ① F1 打开（真键盘事件 → help.js 键表 → app.js 动作）
            await p5Eval(p5Key('F1', {}));
            await p5Sleep(400);
            const f1 = await p5Eval(`(() => {
              const s = window.__app.help.panel.getState();
              return { open: s.open, modalOpen: s.modalOpen, title: s.title, rows: s.shownRows.length, groups: document.querySelectorAll('#help-groups .help-group').length,
                tableRows: window.__app.help.rows.length, count: s.countText, unwired: window.__app.help.unwired };
            })()`);
            // ② 面板内容必须就是键位表本身（**同一集合**：逐 id 比 keys/label）——"单一数据源"的直接证据。
            //    ⚠️ 不能按**下标**逐行对齐：面板是按 SHORTCUT_GROUPS 分组渲染的，组序 ≠ 表序
            //    （表序按功能排，组序把"视图与布局"放在"搜索与查找"之后）→ 首跑就是这样误报的。
            //    这里改成按 id 建索引比集合，并把**差集直接打进 detail**（表里有面板无 / 面板有表里无 / 字段不一致）。
            const same = await p5Eval(`(() => {
              const shown = window.__app.help.panel.getState().shownRows;
              const table = window.__app.help.rows;
              const byId = Object.create(null);
              for (const r of shown) byId[r.id] = r;
              const seen = Object.create(null);
              for (const r of table) seen[r.id] = true;
              const missing = table.filter((r) => !byId[r.id]).map((r) => r.id);
              const extra = shown.filter((r) => !seen[r.id]).map((r) => r.id);
              const mismatched = table.filter((r) => byId[r.id] && (byId[r.id].keys !== r.keys || String(byId[r.id].label).indexOf(r.label) !== 0))
                .map((r) => r.id + '(keys:' + (byId[r.id] ? byId[r.id].keys : '-') + '≠' + r.keys + ')');
              return { shownN: shown.length, tableN: table.length, missing: missing, extra: extra, mismatched: mismatched,
                sameSet: missing.length === 0 && extra.length === 0 && mismatched.length === 0 };
            })()`);
            // ③ 新增 7 条体验项的键位都在表里（F1 面板必须能查到本阶段新增的键）
            const covers = await p5Eval(`(() => {
              const ids = window.__app.help.rows.map((r) => r.id);
              return { quick: ids.indexOf('quick-open') >= 0, outline: ids.indexOf('outline-toggle') >= 0, fInc: ids.indexOf('font-inc') >= 0,
                fDec: ids.indexOf('font-dec') >= 0, zero: ids.indexOf('zoom-reset') >= 0, esc: ids.indexOf('panel-collapse') >= 0, help: ids.indexOf('help') >= 0 };
            })()`);
            // ④ 筛选（真实 input 事件）
            const filter = await p5Eval(`(() => { const n = window.__app.help.panel.typeFilter('ctrl+p'); const s = window.__app.help.panel.getState();
              const back = window.__app.help.panel.typeFilter(''); return { n: n, first: s.shownRows[0] ? s.shownRows[0].id : null, count: s.countText, back: back }; })()`);
            // ⑤ 键位分派（表 → 事件）：几个代表键位必须命中预期 id
            const dispatch = await p5Eval(`(() => {
              const m = (o) => window.__app.help.match(Object.assign({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, o));
              return { p: m({ key: 'p', ctrlKey: true }), f1: m({ key: 'F1' }), slash: m({ key: '/', ctrlKey: true }),
                eq: m({ key: '=', ctrlKey: true }), minus: m({ key: '-', ctrlKey: true }), zero: m({ key: '0', ctrlKey: true }),
                split: m({ key: '\\\\', code: 'Backslash', ctrlKey: true }), shiftO: m({ key: 'O', ctrlKey: true, shiftKey: true }),
                plainO: m({ key: 'o', ctrlKey: true }), none: m({ key: 'z', ctrlKey: true }) };
            })()`);
            // ⑥ 再按 F1 关闭；Ctrl+/ 也能打开，并用「关闭」按钮关掉
            await p5Eval(p5Key('F1', {}));
            await p5Sleep(300);
            const closed = await p5Eval(`(() => ({ open: window.__app.help.panel.isOpen(), modalHidden: document.getElementById('modal-mask').classList.contains('hidden') }))()`);
            await p5Eval(p5Key('/', { ctrlKey: true }));
            await p5Sleep(350);
            const slashOpen = await p5Eval(`(() => ({ open: window.__app.help.panel.isOpen(), title: document.getElementById('modal-title').textContent }))()`);
            const btnClose = await p5Eval(`(() => {
              const btns = document.querySelectorAll('#modal-actions .tbtn');
              const b = btns[btns.length - 1];
              if (b) b.click();
              return { clicked: !!b, open: window.__app.help.panel.isOpen(), modalHidden: document.getElementById('modal-mask').classList.contains('hidden') };
            })()`);
            const conj = {
              'f1-opens': !!(f1 && f1.open === true && f1.modalOpen === true && f1.title === '快捷键'),
              'renders-all-rows': !!(f1 && f1.rows === f1.tableRows && f1.rows >= 18),
              'grouped': !!(f1 && f1.groups >= 4),
              'no-unwired': !!(f1 && Array.isArray(f1.unwired) && f1.unwired.length === 0),
              'single-source': !!(same && same.sameSet === true && same.shownN === same.tableN && same.shownN >= 18),
              'covers-new-keys': !!(covers && covers.quick && covers.outline && covers.fInc && covers.fDec && covers.zero && covers.esc && covers.help),
              'filter-works': !!(filter && filter.n === 1 && filter.first === 'quick-open' && filter.back === f1.tableRows),
              'dispatch-matches-table': !!(dispatch && dispatch.p === 'quick-open' && dispatch.f1 === 'help' && dispatch.slash === 'help' && dispatch.eq === 'font-inc' &&
                dispatch.minus === 'font-dec' && dispatch.zero === 'zoom-reset' && dispatch.split === 'split-toggle' && dispatch.shiftO === 'outline-toggle' &&
                dispatch.plainO === 'open-dir' && dispatch.none === null),
              'f1-toggles-closed': !!(closed && closed.open === false && closed.modalHidden === true),
              'ctrl-slash-opens': !!(slashOpen && slashOpen.open === true && slashOpen.title === '快捷键'),
              'close-button-works': !!(btnClose && btnClose.clicked === true && btnClose.open === false && btnClose.modalHidden === true),
            };
            return p5Fail(conj, 'f1=' + p5J(f1) + ' same=' + p5J(same) + ' covers=' + p5J(covers) + ' filter=' + p5J(filter) +
              ' dispatch=' + p5J(dispatch) + ' closed=' + p5J(closed) + ' slashOpen=' + p5J(slashOpen) + ' btnClose=' + p5J(btnClose));
          });
        } finally {
          // 清场：关浮层/弹窗、合栏、关标签、复位面板与侧栏与字号、删夹具
          try { await p5Eval(`(async () => {
            try { window.__app.quickOpen.close(); } catch (e) {}
            try { window.__app.editor.hideTabsHud(); } catch (e) {}
            try { document.getElementById('modal-mask').classList.add('hidden'); } catch (e) {}
            try { window.__app.bottomPanel.collapse(); } catch (e) {}
            try { window.__app.sidebarSections.set({ fav: false, tree: false, search: false }); } catch (e) {}
            try { await window.api.setSettings({ editorFontSize: 13.5, editorLineHeight: 1.65, previewFontSize: 14.5 }); } catch (e) {}
            try { const e2 = window.__app.editor; if (e2.getPaneCount() > 1) e2.mergePanes(); e2.closeAll(); } catch (e) {}
            return true;
          })()`); } catch { /* 忽略 */ }
          try { await p5Sleep(300); } catch { /* 忽略 */ }
          for (const f of P5_ALL_FILES) {
            try { fs.rmSync(f, { force: true }); } catch { /* 占用则忽略 */ }
          }
          try { fs.rmSync(P5_TREE_DIR, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
        }
      }

      // ==========================================================================
      // 0.5.0 Phase 5a 第 2 批（4 条）：A2 reopenClosedTab / F2 ctxMenuCommonItems /
      //                                 G1 findCaseWordRegex / G2 findMatchLimit
      // --------------------------------------------------------------------------
      // 位置：Phase 5a 第 1 批的 7 条之后、E2E_RESULTS 之前 —— 真·append（未改动任何既有用例一行）。
      // 断言口径：**渲染端可观测事实**（DOM/面板文本/编辑器 state/测试面快照）
      //   + **主进程事实**（fs 真读磁盘内容、IPC 的审批拒绝返回值）。
      // 每条用例的**每个合取项单独命名**打进 detail（本仓库踩过的坑④）；夹具自建自清；
      // 大文件用例临时降阈值，finally 必恢复 1024。
      // 注意（坑①）：所有 p6Eval 的模板串内部**只用单引号**，绝不出现裸反引号。
      // ==========================================================================
      {
        const P6_REOPEN = path.join(TEST_ROOT, 'p6b-reopen-长文.md');
        const P6_RO = path.join(TEST_ROOT, 'p6b-reopen-只读.md');       // 用只读属性逼出"保存失败"路径
        const P6_STACK = Array.from({ length: 25 }, (_, i) => path.join(TEST_ROOT, 'p6b-stack-' + String(i + 1).padStart(2, '0') + '.md'));
        const P6_PANE_A = path.join(TEST_ROOT, 'p6b-pane-a.md');
        const P6_PANE_B = path.join(TEST_ROOT, 'p6b-pane-b.md');
        const P6_FIND = path.join(TEST_ROOT, 'p6b-find.md');
        const P6_FIND2 = path.join(TEST_ROOT, 'p6b-find-p1.md');
        const P6_LIMIT = path.join(TEST_ROOT, 'p6b-limit.md');
        const P6_HUGE = path.join(TEST_ROOT, 'p6b-huge-21mb.txt');
        const P6_SMALLHUGE = path.join(TEST_ROOT, 'p6b-small-huge-2mb.txt');
        const P6_CTX_DIR = path.join(TEST_ROOT, 'p6b-ctx-amp&caret^dir');
        const P6_CTX_FILE = path.join(P6_CTX_DIR, 'p6b-ctx&file.md');
        const P6_NOTAPPROVED = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
        const P6_MISSING = path.join(TEST_ROOT, 'p6b-不存在的文件-用于断言存在性校验.md');
        // 光标夹具：300 行，保证一定可滚动（滚动位置的断言需要真实可滚高度）
        const P6_LINES = Array.from({ length: 300 }, (_, i) => 'p6 行 ' + (i + 1) + ' 内容内容内容');
        const P6_REOPEN_LINE = 120;                       // 关闭前把光标放在第 120 行
        const P6_REOPEN_HEAD = P6_LINES.slice(0, P6_REOPEN_LINE - 1).join('\n').length + 1; // 该行行首 offset
        const P6_RO_ORIG = 'p6 只读夹具第一行\np6 第二行\np6 第三行';
        // ⚠️ 编辑标记必须**只出现在编辑后的文本里**：首版把标记写进了原始内容，于是
        // "磁盘未被写"的判据（indexOf(标记)）恒真 —— 用例自证不足（真窗口探针抓到的）。
        const P6_RO_EDIT_MARK = 'MH-REOPEN-EDIT-ONLY-MARK';
        const P6_RO_EDITED = 'p6 ' + P6_RO_EDIT_MARK + ' 用户新增的一行\n' + P6_RO_ORIG;
        // G1 夹具：alpha 的大小写/整词/正则口径都能区分开
        const P6_FIND_BODY = 'Alpha\nalpha\nALPHA\nalphax\n';
        fs.writeFileSync(P6_REOPEN, P6_LINES.join('\n') + '\n', 'utf8');
        fs.writeFileSync(P6_RO, P6_RO_ORIG, 'utf8');
        fs.writeFileSync(P6_PANE_A, 'p6 pane A\nalpha\nAlpha\nALPHA\nalphax\n', 'utf8');
        fs.writeFileSync(P6_PANE_B, 'p6 pane B\nalpha\n', 'utf8');
        fs.writeFileSync(P6_FIND, P6_FIND_BODY, 'utf8');
        fs.writeFileSync(P6_FIND2, 'p6 p1 alpha\n', 'utf8'); // 只 1 处 alpha（焦点栏判据用）
        fs.writeFileSync(P6_LIMIT, Array.from({ length: 20000 }, (_, i) => 'needle 行 ' + (i + 1)).join('\n') + '\n', 'utf8');
        for (const f of P6_STACK) fs.writeFileSync(f, '# ' + path.basename(f) + '\n', 'utf8');
        fs.mkdirSync(P6_CTX_DIR, { recursive: true });
        fs.writeFileSync(P6_CTX_FILE, '# p6 ctx\n', 'utf8');
        // 大文件夹具：**必须 > 16MB（UTF-8 字节，overlay-ipc.js 的 minOpenBytes）** ——
        // `hugeview.js:357` 调 `huge:doc-open` **不带 force**，低于 16MB 会抛 TOO_SMALL ⇒ editable 恒 false
        // ⇒「编辑 → 关闭保存 → 重开」三连断言全部恒假（首版这里只生成 ≈6.7MB，已被复核抓出）。
        // 单块实测 **53,890 字节** → 400 块 = **21,556,000 字节 ≈ 20.56 MiB**（> 16,777,216）。
        // 下面用 fs.statSync 复核并把真实字节数写进断言/证据，防再次算错（`huge-fixture-big-enough`）。
        {
          const block = Array.from({ length: 1000 }, (_, i) => 'p6 huge line ' + i + ' 内容内容内容内容内容内容').join('\n') + '\n';
          const parts = [];
          for (let i = 0; i < 400; i++) parts.push(block); // = 21,556,000 B
          fs.writeFileSync(P6_HUGE, parts.join(''), 'utf8');
        }
        // 小大文件夹具（G1 的「huge 视图内 Ctrl+F」用）：只需 > 用例内临时降到的分档阈值 1MB。
        // 单块实测 **36,890 字节** → 60 块 = **2,213,400 字节 ≈ 2.11 MiB**（> 1,048,576；首版 14 块只有
        // 516,460 B = 0.49MB ⇒ 该文件永远不会分档成 huge，两条守卫断言恒假）。
        // **不**需要满足 overlay 的 16MB 下限（这条路径只读视口，不进编辑态）。
        {
          const block = Array.from({ length: 1000 }, (_, i) => 'p6 small line ' + i + ' 内容内容内容').join('\n') + '\n';
          const parts = [];
          for (let i = 0; i < 60; i++) parts.push(block); // = 2,213,400 B
          fs.writeFileSync(P6_SMALLHUGE, parts.join(''), 'utf8');
        }
        const P6_HUGE_BYTES = fs.statSync(P6_HUGE).size;
        const P6_SMALL_BYTES = fs.statSync(P6_SMALLHUGE).size;
        const P6_OVERLAY_MIN_OPEN = 16 * 1024 * 1024; // overlay-ipc.js DEFAULT_OPTIONS.minOpenBytes

        const p6Eval = (code) => win.webContents.executeJavaScript(code);
        const p6Effect = (expr) => win.webContents.executeJavaScript(`(async () => { await (${expr}); })()`);
        const p6Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const p6J = (v) => JSON.stringify(v === undefined ? null : v);
        const p6Case = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        const p6Fail = (conj, evidence) => ({
          ok: Object.keys(conj).every((k) => conj[k] === true),
          detail: Object.keys(conj).map((k) => k + '=' + conj[k]).join(','),
          evidence: evidence || '',
        });
        const p6Wait = async (code, pred, ms = 10000, step = 200) => {
          const t0 = Date.now();
          let v = null;
          for (;;) {
            v = await p6Eval(code).catch(() => null);
            if (v !== null && pred(v)) return v;
            if (Date.now() - t0 > ms) return v;
            await p6Sleep(step);
          }
        };
        const p6Key = (k, extra) => `(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${p6J(k)}, code: ${p6J(k)}, bubbles: true, cancelable: true }, ${p6J(extra || {})})));
          return true;
        })()`;
        /** 单栏收尾：合栏 + 关标签 + 关浮层 + 清空重开栈 + 重申工作目录 */
        const p6Reset = async () => {
          await p6Effect(`window.__app.openDirFromPath(${p6J(TEST_ROOT)})`).catch(() => {});
          await p6Sleep(120);
          await p6Eval(`(() => {
            const e = window.__app.editor;
            if (window.__app.quickOpen) window.__app.quickOpen.close();
            document.querySelectorAll('.tabs-menu').forEach((m) => m.classList.add('hidden'));
            const hm = document.getElementById('ctx-menu'); if (hm) hm.classList.add('hidden');
            e.hideTabsHud();
            if (e.getPaneCount() > 1) e.mergePanes();
            e.closeAll();
            e.clearClosedStack();
            try { window.__app.find.setQuery(''); window.__app.find.setOptions({ caseSensitive: false, wholeWord: false, regex: false }); } catch (err) {}
            return e.getPaneCount();
          })()`).catch(() => -1);
          await p6Sleep(200);
        };
        const P6_FIND_STATE = `JSON.stringify(window.__app.find.getState())`;
        const p6ToastText = `Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent).join(' | ')`;

        try {
          // ==================== 1. reopenClosedTab：Ctrl+Shift+T 重开关闭的标签 ====================
          await p6Case('reopenClosedTab', async () => {
            await p6Reset();
            // ① 开普通标签 → 移动光标到第 120 行 + 滚动 → 关（真 Ctrl+W）→ 栈里必须有完整快照
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_REOPEN)})`);
            await p6Sleep(500);
            const before = await p6Eval(`(() => {
              const e = window.__app.editor;
              const t = e.getActiveTab();
              const v = e.getView();
              v.dispatch({ selection: { anchor: ${P6_REOPEN_HEAD} } });
              t.state = v.state;
              v.scrollDOM.scrollTop = 480;
              t.scrollTop = 480;
              return { path: t.path, head: v.state.selection.main.head, scrollTop: Math.round(v.scrollDOM.scrollTop), kind: t.kind || null };
            })()`);
            await p6Eval(p6Key('w', { ctrlKey: true })); // 真 Ctrl+W → app.js close-tab → editor.closeTab
            await p6Sleep(400);
            const stack = await p6Eval(`(() => { const s = window.__app.editor.closedTabs(); return { n: s.length, top: s[0] || null }; })()`);
            // ② 真 Ctrl+Shift+T → 重开（回到原栏 = 唯一那栏）
            await p6Eval(p6Key('T', { ctrlKey: true, shiftKey: true }));
            const reopened = await p6Wait(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t) return null; const v = e.getView();
              return { path: t.path, kind: t.kind || null, head: v.state.selection.main.head, tabScrollTop: t.scrollTop, domScrollTop: Math.round(v.scrollDOM.scrollTop), info: t.reopenInfo || null, stackN: e.closedStackSize() }; })()`,
            (v) => v && v.path === P6_REOPEN && !!v.info, 6000, 200);
            await p6Sleep(400); // 等 restoreTabScroll 的多帧校正（6 帧 ≈ 100ms）+ reopenClosedTab 收尾
            const after = await p6Eval(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); const v = e.getView();
              return { path: t.path, kind: t.kind || null, head: v.state.selection.main.head, tabScrollTop: t.scrollTop, domScrollTop: Math.round(v.scrollDOM.scrollTop) }; })()`);

            // ③ 未保存内容：只读属性 → 关闭时的保存**必然失败** → 文本快照必须被写回
            fs.chmodSync(P6_RO, 0o444);
            let roState = null;
            try {
              await p6Effect(`window.__app.editor.openFile(${p6J(P6_RO)})`);
              await p6Sleep(400);
              const edited = await p6Eval(`(() => {
                const e = window.__app.editor;
                const t = e.getActiveTab();
                const v = e.getView();
                v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${p6J(P6_RO_EDITED)} } });
                t.state = v.state;
                return { dirty: t.dirty === true, len: v.state.doc.length };
              })()`);
              await p6Sleep(200);
              await p6Eval(p6Key('w', { ctrlKey: true }));
              await p6Sleep(900); // 等关闭时那次 saveNow 落定（失败也要落定，否则 savedOnClose 还是 null）
              const roStack = await p6Eval(`(() => { const s = window.__app.editor.closedTabs(); const e = s[0] || null;
                return { n: s.length, top: e, diskHasMark: null }; })()`);
              // 真·外部事实：磁盘上**没有**编辑后的标记（= 关闭时那次保存确实失败了，未保存内容靠快照回写）
              const disk = fs.readFileSync(P6_RO, 'utf8');
              await p6Eval(p6Key('T', { ctrlKey: true, shiftKey: true }));
              await p6Wait(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t) return null;
                const v = e.getView(); return { path: t.path, doc: v.state.doc.toString(), dirty: t.dirty === true, info: t.reopenInfo || null }; })()`,
              (v) => v && v.path === P6_RO && !!v.info, 6000, 200);
              await p6Sleep(400); // 等内容回写 / 光标恢复 / reopenInfo 收尾
              const roBack = await p6Eval(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t) return null;
                const v = e.getView(); return { path: t.path, doc: v.state.doc.toString(), dirty: t.dirty === true, info: t.reopenInfo || null }; })()`);
              roState = {
                edited: edited, stack: roStack, back: roBack,
                diskEqualsOrig: disk === P6_RO_ORIG,          // 磁盘原封不动（真·主进程事实）
                diskHasEditMark: disk.indexOf(P6_RO_EDIT_MARK) >= 0,
              };
            } finally {
              try { fs.chmodSync(P6_RO, 0o666); } catch { /* 忽略 */ }
            }
            await p6Reset();

            // ④ 落栏语义（多视图一致性）。⭐ 两条前置事实（真窗口探针抓到的用例缺陷）：
            //    ① closeTab 末尾的"撤空栏"循环会清掉**空的**栏：只要有一栏是空的，关任意标签就会
            //       触发 `removeEmptyPane` → `mergePanes`（恒保留 p0）→ 栏结构被改写；
            //    ② 因此"重开回原栏"这条**只有在 p0 与 p1 都非空**时才有意义。
            //    本条布局：p0 = [P6_PANE_A]（锚点，不被关）；p1 = [P6_FIND（锚点）, P6_PANE_B（待关）]。
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_PANE_A)})`); // 先让 p0 非空
            await p6Sleep(300);
            await p6Effect(`window.__app.editor.toggleSplit()`);                // 焦点栏 = p1
            await p6Sleep(300);
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_FIND)})`);    // p1 锚点（关闭后 p1 不被撤）
            await p6Sleep(300);
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_PANE_B)})`);  // p1：待关闭的那一条
            await p6Sleep(400);
            const paneBefore = await p6Eval(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); const els1 = e.getPaneEls(1); const els0 = e.getPaneEls(0);
              return { path: t.path, pane: e.paneIdOf(t), focus: e.getFocusPaneId(), count: e.getPaneCount(),
                p0tabs: els0 ? els0.tabsEl.querySelectorAll('.tab').length : -1,
                p1tabs: els1 ? els1.tabsEl.querySelectorAll('.tab').length : -1 }; })()`);
            await p6Eval(p6Key('w', { ctrlKey: true }));
            await p6Sleep(500);
            const paneSurvived = await p6Eval(`(() => { const e = window.__app.editor; const els1 = e.getPaneEls(1); const els0 = e.getPaneEls(0);
              return { count: e.getPaneCount(), focus: e.getFocusPaneId(), hasB: !!e.findTabByPath(${p6J(P6_PANE_B)}),
                p0tabs: els0 ? els0.tabsEl.querySelectorAll('.tab').length : -1,
                p1tabs: els1 ? els1.tabsEl.querySelectorAll('.tab').length : -1 }; })()`);
            await p6Effect(`window.__app.editor.focusPaneIndex(0)`); // 焦点切到 p0：重开若"跟焦点栏"就会落错栏
            await p6Sleep(250);
            await p6Eval(p6Key('T', { ctrlKey: true, shiftKey: true }));
            const paneBack = await p6Wait(`(() => { const e = window.__app.editor; const t = e.findTabByPath(${p6J(P6_PANE_B)}); if (!t) return null;
              const els0 = e.getPaneEls(0); const els1 = e.getPaneEls(1);
              const cnt = (el) => el ? el.tabsEl.querySelectorAll('.tab[data-path=' + JSON.stringify(${p6J(P6_PANE_B)}) + ']').length : -1;
              return { pane: e.paneIdOf(t), focus: e.getFocusPaneId(), inP0: cnt(els0), inP1: cnt(els1) }; })()`,
            (v) => v && v.pane === 'p1', 8000, 200);

            // ④b 文档化语义②：**原栏已不存在 → 落焦点栏**。把 p1 的两个标签都关掉 → p1 撤栏（保留 p0）
            await p6Effect(`(() => { const e = window.__app.editor; for (const p of [${p6J(P6_PANE_B)}, ${p6J(P6_FIND)}]) { const t = e.findTabByPath(p); if (t) e.closeTab(t, { all: true }); } })()`);
            await p6Sleep(800);
            await p6Effect(`window.__app.editor.focusPaneIndex(0)`);
            await p6Sleep(250);
            const fallbackBefore = await p6Eval(`(() => { const e = window.__app.editor; return { count: e.getPaneCount(), focus: e.getFocusPaneId(), stack: e.closedTabs()[0] ? e.closedTabs()[0].path : null }; })()`);
            await p6Eval(p6Key('T', { ctrlKey: true, shiftKey: true })); // 栈顶 = 最后关的 P6_FIND
            const fallbackBack = await p6Wait(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t || !t.path) return null;
              return { path: t.path, pane: e.paneIdOf(t), focus: e.getFocusPaneId(), count: e.getPaneCount() }; })()`,
            (v) => v && v.path === P6_FIND, 8000, 200);
            await p6Reset();

            // ⑤ 栈上限 20：连关 25 个 → 只留最近 20（最旧的 5 个必须已被挤出）
            await p6Effect(`(async () => { const e = window.__app.editor; for (const p of ${p6J(P6_STACK)}) { await e.openFile(p); } })()`);
            await p6Sleep(900);
            await p6Effect(`(() => { const e = window.__app.editor; for (const p of ${p6J(P6_STACK)}) { const t = e.findTabByPath(p); if (t) e.closeTab(t, { all: true }); } })()`);
            await p6Sleep(600);
            const cap = await p6Eval(`(() => { const e = window.__app.editor; const s = e.closedTabs();
              return { n: s.length, newest: s[0] ? s[0].path : null, oldest: s[s.length - 1] ? s[s.length - 1].path : null,
                hasFirst: s.some((x) => x.path === ${p6J(P6_STACK[0])}), hasLast: s.some((x) => x.path === ${p6J(P6_STACK[24])}) }; })()`);
            // 重开（栈顶 = 最后关闭的那个）
            await p6Eval(p6Key('T', { ctrlKey: true, shiftKey: true }));
            const capBack = await p6Wait(`(() => { const t = window.__app.editor.getActiveTab(); return t ? { path: t.path } : null; })()`,
              (v) => v && v.path === P6_STACK[24], 6000, 200);
            await p6Reset();

            // ⑥ huge：真·overlay 脏内容关闭后重开 —— 内容必须在（**主进程 fs 真读**），且降级路径必须显式
            let huge = null;
            try {
              await p6Eval(`window.__app.editor.setHugeThresholdMB(1)`);
              await p6Effect(`window.__app.editor.openFile(${p6J(P6_HUGE)})`);
              const hOpen = await p6Wait(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t || t.kind !== 'huge' || !t.huge) return null;
                return { path: t.path, kind: t.kind, sizeOk: null }; })()`, (v) => !!v, 30000, 250);
              // 等行索引就绪（40 万行）→ 把视口滚到第 15000 行：这条用于验证**滚动位置也被恢复**
              // （A2 第 6 条：huge 的滚动位置是"视口首行"，不是像素 scrollTop）
              const hReady = await p6Wait(`(() => { const t = window.__app.editor.getActiveTab(); if (!t || !t.huge) return null;
                const st = t.huge.getState(); return { indexed: st.indexed, lines: st.lines, renderedFrom: st.rendered ? st.rendered.from : null }; })()`,
              (v) => v && v.indexed === true && v.lines > 20000, 60000, 250);
              const hScroll = await p6Eval(`(async () => { const t = window.__app.editor.getActiveTab();
                const n = await t.huge.gotoLine(15000);
                await new Promise((r) => setTimeout(r, 400));
                const st = t.huge.getState();
                return { want: 15000, clamped: n, lines: st.lines, renderedFrom: st.rendered ? st.rendered.from : null }; })()`);
              await p6Sleep(400);
              const hEd = await p6Eval(`(async () => { const e = window.__app.editor; const t = e.getActiveTab();
                if (!t || !t.huge) return { err: 'no huge view' };
                const ok = await t.huge.setEditable(true);
                const st = t.huge.getState();
                return { ok: ok === true, editable: st.editable, docEditable: st.docEditable, reason: st.editableReason || null, lines: st.lines }; })()`);
              const hEdit = await p6Eval(`(async () => { const e = window.__app.editor; const t = e.getActiveTab();
                const r = await t.huge.applyEditForTest({ type: 'insert', line: 1, col: 0, text: 'MH-REOPEN-HUGE-MARK ' });
                const st = t.huge.getState();
                return { ok: !!r, dirty: st.dirty, dirtyCount: st.dirtyCount, tabDirty: t.dirty === true }; })()`);
              await p6Sleep(200);
              // 关闭前先记下磁盘快照（用于断言"关闭这条路径**没有**写源文件"）
              const hugeSizeBefore = fs.statSync(P6_HUGE).size;
              await p6Eval(p6Key('w', { ctrlKey: true })); // 关闭：huge 分支会先 saveNow（21.5MB 原子重写）
              // 轮询等这次"保存"**落定**（savedOnClose 从 null 变成 true/false）——固定 sleep 会与写盘赛跑
              const hStack = await p6Wait(`(() => { const s = window.__app.editor.closedTabs(); const e = s[0] || null;
                return e ? { n: s.length, top: e } : null; })()`, (v) => v && v.top && v.top.savedOnClose !== null, 30000, 250);
              await p6Sleep(600); // 再等会话释放（closeDoc 挂在保存 promise 之后）
              // 真·主进程事实①：源文件没被写（字节数不变 + 前 512 字节里没有插入标记）。
              // 这条断言同时是**回归守卫**：若将来有人把 closeTab 的 huge 路径改成"真的先保存再关"，
              // 这里会立刻变红，并提示把下面几条降级断言改成"内容已随磁盘恢复"。详见 tabs.js 的 trackClosedSave 注释。
              const hugeSizeAfter = fs.statSync(P6_HUGE).size;
              let diskTop = '';
              {
                const fd = fs.openSync(P6_HUGE, 'r');
                try {
                  const buf = Buffer.alloc(512);
                  const n = fs.readSync(fd, buf, 0, 512, 0);
                  diskTop = buf.subarray(0, n).toString('utf8');
                } finally { fs.closeSync(fd); }
              }
              // 真·主进程事实②：未保存的 overlay 分片**确实留在恢复区**（huge:doc-recover-list）——
              // 这是"内容没丢、只是没能随标签恢复"的证据（不靠渲染端自述）。
              const recov = await p6Eval(`window.api.hugeDocRecoverList({ limit: 100 })`).catch((e) => ({ err: String(e && e.message || e) }));
              const recovMine = (recov && Array.isArray(recov.items) ? recov.items : []).filter((it) => String(it.file || '').toLowerCase().indexOf('p6b-huge-21mb.txt') >= 0);
              await p6Eval(p6Key('T', { ctrlKey: true, shiftKey: true }));
              await p6Wait(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t) return null;
                return { path: t.path, kind: t.kind || null, info: t.reopenInfo || null }; })()`,
              (v) => v && v.path === P6_HUGE && !!v.info, 30000, 250);
              // toast 在 reopenInfo 之后才创建 → 等一会儿再读，避免读到空串（首版就是在这里读空的）
              await p6Sleep(700);
              const hBack = await p6Eval(`(() => { const e = window.__app.editor; const t = e.getActiveTab(); if (!t) return null;
                return { path: t.path, kind: t.kind || null, info: t.reopenInfo || null, toasts: ${p6ToastText} }; })()`);
              const hBackScroll = await p6Eval(`(() => { const t = window.__app.editor.getActiveTab(); if (!t || !t.huge) return null;
                const st = t.huge.getState(); return { renderedFrom: st.rendered ? st.rendered.from : null, lines: st.lines, info: t.reopenInfo || null }; })()`);
              huge = {
                sizeBytes: P6_HUGE_BYTES, minOpenBytes: P6_OVERLAY_MIN_OPEN, open: hOpen, ready: hReady, scroll: hScroll,
                ed: hEd, edit: hEdit, stack: hStack,
                savedBytesUnchanged: hugeSizeBefore === hugeSizeAfter, sizeBefore: hugeSizeBefore, sizeAfter: hugeSizeAfter,
                diskTopHasMark: diskTop.indexOf('MH-REOPEN-HUGE-MARK') >= 0,
                recoverItems: recovMine, recoverErr: recov && recov.err ? recov.err : null,
                back: hBack, backScroll: hBackScroll,
              };
            } finally {
              await p6Eval(`window.__app.editor.setHugeThresholdMB(null)`).catch(() => {});
              await p6Reset();
            }

            const conj = {
              'cursor-scroll-recorded': !!(before && before.head === P6_REOPEN_HEAD && before.scrollTop > 0),
              'close-pushed-snapshot': !!(stack && stack.n === 1 && stack.top && stack.top.path === P6_REOPEN && stack.top.cursor && stack.top.cursor.head === P6_REOPEN_HEAD && stack.top.scrollTop > 0),
              'ctrl-shift-t-reopens': !!(after && after.path === P6_REOPEN && after.kind === null),
              'cursor-restored': !!(after && after.head === P6_REOPEN_HEAD),
              'scroll-restored': !!(after && after.tabScrollTop === 480 && after.domScrollTop > 0),
              'unsaved-dirty-snapshot': !!(roState && roState.edited && roState.edited.dirty === true && roState.stack && roState.stack.top && roState.stack.top.dirtyAtClose === true && roState.stack.top.hasText === true),
              'unsaved-save-failed': !!(roState && roState.stack && roState.stack.top && roState.stack.top.savedOnClose === false && roState.diskEqualsOrig === true && roState.diskHasEditMark === false),
              'unsaved-content-restored': !!(roState && roState.back && roState.back.doc === P6_RO_EDITED && roState.back.dirty === true && roState.back.info && roState.back.info.contentRestored === true),
              'pane-of-close-recorded': !!(paneBefore && paneBefore.pane === 'p1' && paneBefore.focus === 'p1' && paneBefore.count === 2 && paneBefore.p0tabs === 1 && paneBefore.p1tabs === 2),
              'pane-survives-close': !!(paneSurvived && paneSurvived.count === 2 && paneSurvived.hasB === false && paneSurvived.p0tabs === 1 && paneSurvived.p1tabs === 1),
              'reopen-lands-in-original-pane': !!(paneBack && paneBack.pane === 'p1' && paneBack.inP1 === 1 && paneBack.inP0 === 0),
              'pane-gone-falls-back-to-focus-pane': !!(fallbackBefore && fallbackBefore.count === 1 && fallbackBefore.stack === P6_FIND && fallbackBack && fallbackBack.pane === 'p0' && fallbackBack.count === 1 && fallbackBack.focus === 'p0'),
              'stack-cap-20': !!(cap && cap.n === 20 && cap.hasFirst === false && cap.hasLast === true && cap.newest === P6_STACK[24]),
              'stack-top-reopens': !!(capBack && capBack.path === P6_STACK[24]),
              'huge-fixture-big-enough': !!(P6_HUGE_BYTES > P6_OVERLAY_MIN_OPEN && P6_SMALL_BYTES > 1024 * 1024),
              'huge-opened-as-huge': !!(huge && huge.open && huge.open.kind === 'huge'),
              'huge-editable-and-dirty': !!(huge && huge.ed && huge.ed.editable === true && huge.edit && huge.edit.dirty === true && huge.edit.tabDirty === true),
              // 关闭这条路径**不写源文件**（0.4.0 既定语义；见 tabs.js 的 trackClosedSave 实测说明）
              'huge-close-does-not-write-disk': !!(huge && huge.stack && huge.stack.top && huge.stack.top.dirtyAtClose === true && huge.stack.top.savedOnClose === false && huge.savedBytesUnchanged === true && huge.diskTopHasMark === false),
              // 内容没丢：未保存的 overlay 分片在恢复区（主进程事实，不靠渲染端自述）
              'huge-unsaved-kept-in-recovery': !!(huge && !huge.recoverErr && Array.isArray(huge.recoverItems) && huge.recoverItems.length >= 1 && huge.recoverItems.some((it) => it.dirtyBlocks >= 1)),
              // A2 第 6 条：滚动位置（视口首行）也必须被采集并真的恢复 —— 采集了却丢掉就是静默降级
              'huge-scroll-recorded': !!(huge && huge.scroll && huge.scroll.renderedFrom > 1000 && huge.stack && huge.stack.top && huge.stack.top.hugeTopLine > 1000),
              'huge-scroll-restored': !!(huge && huge.backScroll && huge.backScroll.info && huge.backScroll.info.hugeScrollRestored === true && huge.backScroll.renderedFrom > 1000),
              // 重开同类标签 + **显式降级**（内容未随标签恢复，说清原因与去处）
              'huge-reopen-same-kind': !!(huge && huge.back && huge.back.kind === 'huge' && huge.back.info && huge.back.info.savedOnClose === false && huge.back.info.degraded === true && huge.back.info.reason === 'HUGE_OVERLAY_NOT_REATTACHED'),
              'huge-degrade-explicit': !!(huge && huge.back && /恢复区/.test(huge.back.toasts || '')),
            };
            return p6Fail(conj, 'before=' + p6J(before) + ' stack=' + p6J(stack) + ' after=' + p6J(after) +
              ' roStack=' + p6J(roState && roState.stack && roState.stack.top) + ' roBack=' + p6J(roState && roState.back && { path: roState.back.path, dirty: roState.back.dirty, info: roState.back.info, docHead: String(roState.back.doc || '').slice(0, 60) }) + ' diskEqualsOrig=' + p6J(roState && roState.diskEqualsOrig) + ' diskHasEditMark=' + p6J(roState && roState.diskHasEditMark) +
              ' paneBefore=' + p6J(paneBefore) + ' paneSurvived=' + p6J(paneSurvived) + ' paneBack=' + p6J(paneBack) +
              ' fallback=' + p6J(fallbackBefore) + '→' + p6J(fallbackBack) + ' cap=' + p6J(cap) + ' capBack=' + p6J(capBack) +
              ' fixtureBytes=' + p6J({ huge: P6_HUGE_BYTES, small: P6_SMALL_BYTES }) +
              ' huge=' + p6J(huge && { open: huge.open, ready: huge.ready, scroll: huge.scroll, ed: huge.ed, edit: huge.edit, stackTop: huge.stack && huge.stack.top, sizes: [huge.sizeBefore, huge.sizeAfter], diskTopHasMark: huge.diskTopHasMark, recovery: huge.recoverItems, recoverErr: huge.recoverErr, back: huge.back, backScroll: huge.backScroll }));
          });

          // ==================== 2. ctxMenuCommonItems：树/标签右键常用项 + 安全面 ====================
          await p6Case('ctxMenuCommonItems', async () => {
            await p6Reset();
            const LABELS = ['📁 在资源管理器中显示', '📋 复制路径', '📋 复制文件名', '⌨ 在终端打开（此目录）', '🚀 用默认程序打开'];
            // ① 树（根目录行）右键：五个常用项 + 既有项仍在
            await p6Sleep(400);
            const treeMenu = await p6Eval(`(() => {
              const rows = document.querySelectorAll('#file-tree .tree-node');
              const row = rows[0] || null;
              if (!row) return { err: 'no tree row', rows: rows.length };
              const r = row.getBoundingClientRect();
              row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left) + 10, clientY: Math.round(r.top) + 5 }));
              const items = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((n) => n.textContent);
              return { rows: rows.length, items: items, visible: !document.getElementById('ctx-menu').classList.contains('hidden') };
            })()`);
            // ② 点「复制路径」→ 剪贴板真的是该路径（主进程读回）
            const copyPath = await p6Eval(`(async () => {
              const el = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).find((n) => n.textContent === '📋 复制路径');
              if (el) el.click();
              await new Promise((r) => setTimeout(r, 300));
              return { clicked: !!el, clip: await window.api.readClipboardText() };
            })()`);
            // ③ 标签右键（文件）：五个常用项 + 点「复制文件名」
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_CTX_FILE)})`);
            await p6Sleep(400);
            const tabMenu = await p6Eval(`(async () => {
              const tab = document.querySelector('#tabs .tab[data-path=' + JSON.stringify(${p6J(P6_CTX_FILE)}) + ']');
              if (!tab) return { err: 'no tab' };
              const r = tab.getBoundingClientRect();
              tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left) + 5, clientY: Math.round(r.top) + 5 }));
              const items = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).map((n) => n.textContent);
              const el = Array.from(document.querySelectorAll('#ctx-menu .ctx-item')).find((n) => n.textContent === '📋 复制文件名');
              if (el) el.click();
              await new Promise((r2) => setTimeout(r2, 300));
              return { items: items, clicked: !!el, clip: await window.api.readClipboardText() };
            })()`);
            // ④ 安全面：终端 dryRun —— 路径只作 cwd、argv 恒空、shell:false（含 & ^ 元字符的目录也一样）
            const term = await p6Eval(`window.api.openTerminal(${p6J(P6_CTX_DIR)}, { dryRun: true })`).catch((e) => ({ err: String(e && e.message || e) }));
            // ⑤ 未批准路径：终端 / 默认程序 / 写剪贴板三条通道必须一律拒绝
            const termNo = await p6Eval(`window.api.openTerminal(${p6J(P6_NOTAPPROVED)}, { dryRun: true })`).catch((e) => ({ err: String(e && e.message || e) }));
            const openNo = await p6Eval(`window.api.openPath(${p6J(P6_NOTAPPROVED)})`).catch((e) => ({ err: String(e && e.message || e) }));
            const clipNo = await p6Eval(`window.api.copyText({ path: ${p6J(P6_NOTAPPROVED)}, kind: 'path' })`).catch((e) => ({ err: String(e && e.message || e) }));
            // ⑤b 通道收窄（低危瑕疵修正后的口径）：剪贴板正文由**主进程自拼**，渲染端传 text 也不生效
            const clipForge = await p6Eval(`(async () => { const r = await window.api.copyText({ path: ${p6J(P6_CTX_FILE)}, kind: 'path', text: 'MH-FORGED-CLIPBOARD-TEXT' });
              await new Promise((r2) => setTimeout(r2, 200));
              return { res: r, clip: await window.api.readClipboardText() }; })()`).catch((e) => ({ err: String(e && e.message || e) }));
            // ⑥ 已批准但不存在 → 存在性校验拦下（证明审批与存在性两道闸都在，且不会误开系统程序）
            const openMissing = await p6Eval(`window.api.openPath(${p6J(P6_MISSING)})`).catch((e) => ({ err: String(e && e.message || e) }));
            const termFile = await p6Eval(`window.api.openTerminal(${p6J(P6_CTX_FILE)}, { dryRun: true })`).catch((e) => ({ err: String(e && e.message || e) }));
            await p6Reset();
            const hasAll = (arr) => Array.isArray(arr) && LABELS.every((l) => arr.indexOf(l) >= 0);
            const conj = {
              'tree-menu-has-5-items': !!(treeMenu && treeMenu.visible === true && hasAll(treeMenu.items)),
              'tree-menu-keeps-existing': !!(treeMenu && treeMenu.items.indexOf('🔄 刷新') >= 0 && treeMenu.items.indexOf('📝 新建文件') >= 0),
              'copy-path-writes-clipboard': !!(copyPath && copyPath.clicked === true && copyPath.clip === TEST_ROOT),
              'tab-menu-has-5-items': !!(tabMenu && hasAll(tabMenu.items)),
              'tab-menu-keeps-existing': !!(tabMenu && tabMenu.items.indexOf('✕ 关闭标签') >= 0 && tabMenu.items.indexOf('📌 固定标签') >= 0),
              'copy-name-writes-clipboard': !!(tabMenu && tabMenu.clicked === true && tabMenu.clip === path.basename(P6_CTX_FILE)),
              'terminal-cwd-only-no-argv': !!(term && term.ok === true && term.cwd === P6_CTX_DIR && Array.isArray(term.argv) && term.argv.length === 0 && term.shell === false && term.mode === 'cwd'),
              'terminal-file-uses-its-dir': !!(termFile && termFile.ok === true && termFile.cwd === P6_CTX_DIR && termFile.argv.length === 0),
              // v0.7.0 权限口径变更（用户决策）：树内可达操作不再做白名单 —— 终端（cwd 口径不变）与
              // 剪贴板对未批准但存在的路径放行；openPath 因可启动任意默认程序（外向性最强）保留白名单
              'terminal-unapproved-now-allowed': !!(termNo && termNo.ok === true && termNo.mode === 'cwd' && termNo.argv.length === 0),
              'openpath-unapproved-still-rejected': !!(openNo && openNo.ok === false && openNo.reason === 'NOT_APPROVED'),
              'clipboard-unapproved-now-allowed': !!(clipNo && clipNo.ok === true && clipNo.text === P6_NOTAPPROVED),
              'clipboard-text-built-by-main': !!(clipForge && clipForge.res && clipForge.res.ok === true && clipForge.res.kind === 'path'
                && clipForge.res.text === P6_CTX_FILE && clipForge.clip === P6_CTX_FILE && clipForge.clip.indexOf('MH-FORGED') < 0),
              'openpath-missing-rejected': !!(openMissing && openMissing.ok === false && openMissing.reason === 'ENOENT'),
            };
            return p6Fail(conj, 'tree=' + p6J(treeMenu && { rows: treeMenu.rows, items: treeMenu.items }) + ' copyPath=' + p6J(copyPath) +
              ' tabMenu=' + p6J(tabMenu) + ' term=' + p6J(term) + ' termFile=' + p6J(termFile) + ' termNo=' + p6J(termNo) +
              ' openNo=' + p6J(openNo) + ' clipNo=' + p6J(clipNo) + ' clipForge=' + p6J(clipForge) + ' openMissing=' + p6J(openMissing) + ' expectRoot=' + p6J(TEST_ROOT));
          });

          // ==================== 3. findCaseWordRegex：三开关 + huge 守卫 + ReDoS 防护 ====================
          await p6Case('findCaseWordRegex', async () => {
            await p6Reset();
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_FIND)})`);
            await p6Sleep(400);
            const S = `window.__app.find`;
            // ① 默认（不区分大小写）：Alpha/alpha/ALPHA/alphax = 4 处
            const def = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: false, wholeWord: false, regex: false }); ${S}.setQuery('alpha'); const s = ${S}.getState();
              return { shown: s.shown, opts: s.options, count: s.countText, rows: s.rows }; })()`);
            // ② Aa（区分大小写）：只剩 alpha / alphax 两处
            const cs = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: true }); const s = ${S}.getState(); return { shown: s.shown, opts: s.options, count: s.countText }; })()`);
            // ③ 整词（不区分大小写）：Alpha/alpha/ALPHA 三处（alphax 不算）
            const ww = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: false, wholeWord: true }); const s = ${S}.getState(); return { shown: s.shown, opts: s.options }; })()`);
            // ④ 正则 '^a.*a$'（i）：Alpha/alpha/ALPHA 三处；叠加 Aa 后只剩 alpha 一处
            const re1 = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: false, wholeWord: false, regex: true }); ${S}.setQuery('^a.*a$'); const s = ${S}.getState();
              return { shown: s.shown, error: s.patternError, lines: s.matchLines }; })()`);
            const re2 = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: true }); const s = ${S}.getState(); return { shown: s.shown, error: s.patternError }; })()`);
            // ⑤ 非法正则：显式报错（不静默 0 命中）
            const bad = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: false }); ${S}.setQuery('('); const s = ${S}.getState();
              return { err: s.patternError, count: s.countText, text: s.resultsText }; })()`);
            // ⑥ 模式过长（>200）：拒绝
            const tooLong = await p6Eval(`(() => { ${S}.setQuery('a'.repeat(250)); const s = ${S}.getState(); return { err: s.patternError, count: s.countText, max: s.limits.maxPattern }; })()`);
            // ⑦ 嵌套量词（(a+)+）：静态拒绝
            const nested = await p6Eval(`(() => { ${S}.setQuery('(a+)+b'); const s = ${S}.getState(); return { err: s.patternError, count: s.countText }; })()`);
            // ⑧ 执行预算：**必须在大文档上测**（首版在 5 行夹具上把预算压到 1ms，实测单次扫描 0.38µs，
            //    永远进不到预算分支 → 恒定假）。这里改用 20000 行的 P6_LIMIT：临时把预算压到 1ms，
            //    扫描 2 万行必然超过 1ms（数量级差 ~10⁴），中止分支**非时序赌**而是确定性可达。
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_LIMIT)})`);
            await p6Sleep(700);
            const budget = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: false, wholeWord: false, regex: true }); ${S}.setLimitsForTest({ budgetMs: 1 });
              ${S}.setQuery('zzz-无此匹配'); const s = ${S}.getState();
              const r = { timedOut: s.timedOut, truncated: s.truncated, shown: s.shown, count: s.countText, more: s.moreText, budget: s.limits.budgetMs, docLines: window.__app.editor.getView().state.doc.lines };
              ${S}.setLimitsForTest({ budgetMs: null }); return r; })()`);
            // ⑨ 默认预算下**不误报**超时：同一条 2 万行文档上用**能命中每一行**的正则跑一次
            //    （命中多到先撞 limit=500 截断，仍必须 timedOut=false；首版这里用了 '^.*a.*$'，
            //     而该文档的行文本是 'needle 行 N' —— 一个 'a' 都没有，0 命中，断言恒假）
            const noFalseBig = await p6Eval(`(() => { ${S}.setOptions({ regex: true }); ${S}.setQuery('^needle 行'); const s = ${S}.getState();
              return { timedOut: s.timedOut, truncated: s.truncated, shown: s.shown, budget: s.limits.budgetMs, limit: s.limits.limit, docLines: window.__app.editor.getView().state.doc.lines }; })()`);
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_FIND)})`);
            await p6Sleep(400);
            const noFalse = await p6Eval(`(() => { ${S}.setOptions({ caseSensitive: false, wholeWord: false, regex: false }); ${S}.setQuery('alpha'); const s = ${S}.getState();
              return { timedOut: s.timedOut, shown: s.shown, budget: s.limits.budgetMs, limit: s.limits.limit }; })()`);
            // ⑩ huge 视图守卫：显式提示（不是静默 0 命中）—— Ctrl+F 一进面板就要看到
            let hugeGuard = null;
            try {
              await p6Eval(`window.__app.editor.setHugeThresholdMB(1)`);
              await p6Effect(`window.__app.editor.openFile(${p6J(P6_SMALLHUGE)})`);
              const hOpen = await p6Wait(`(() => { const t = window.__app.editor.getActiveTab(); return t && t.kind ? { path: t.path, kind: t.kind } : null; })()`, (v) => !!v && v.kind === 'huge', 20000, 250);
              const typed = await p6Eval(`(() => { ${S}.setQuery('p6'); const s = ${S}.getState();
                return { kind: ${p6J('')} + (window.__app.editor.getActiveTab().kind || ''), unsupported: s.unsupported, count: s.countText, text: s.resultsText, shown: s.shown }; })()`);
              // Ctrl+F 一进面板（未输入任何字）也必须已经给出提示
              const onFocus = await p6Eval(`(() => { ${S}.setQuery(''); ${S}.focus(); const s = ${S}.getState();
                return { unsupported: s.unsupported, count: s.countText, text: s.resultsText }; })()`);
              hugeGuard = { open: hOpen, typed: typed, focus: onFocus };
            } finally {
              await p6Eval(`window.__app.editor.setHugeThresholdMB(null)`).catch(() => {});
            }
            await p6Reset();
            // ⑪ 多视图一致性：查找跟随**焦点栏**。
            //    布局：p1 = P6_FIND（4 处 alpha）、p0 = P6_FIND2（1 处 alpha）—— 断言必须与之一致
            //    （首版把两个期望值写反、还把 p0.focus 与 p1.focus 比相等，两条恒假）。
            await p6Effect(`window.__app.editor.toggleSplit()`);
            await p6Sleep(300);
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_FIND)})`);  // 焦点栏 = p1（4 处 alpha）
            await p6Sleep(300);
            await p6Effect(`window.__app.editor.focusPaneIndex(0)`);
            await p6Sleep(200);
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_FIND2)})`); // p0（1 处 alpha）
            await p6Sleep(400);
            const focusPane = await p6Eval(`(async () => {
              const e = window.__app.editor;
              e.focusPaneIndex(0);
              await new Promise((r) => setTimeout(r, 200));
              ${S}.setOptions({ caseSensitive: false, wholeWord: false, regex: false });
              ${S}.setQuery('alpha');
              const s0 = ${S}.getState();
              const p0 = { focus: e.getFocusPaneId(), shown: s0.shown, file: e.getActiveTab().name, pane: e.paneIdOf(e.getActiveTab()) };
              e.focusPaneIndex(1);
              await new Promise((r) => setTimeout(r, 200));
              ${S}.setQuery('alpha');
              const s1 = ${S}.getState();
              const p1 = { focus: e.getFocusPaneId(), shown: s1.shown, file: e.getActiveTab().name, pane: e.paneIdOf(e.getActiveTab()) };
              return { p0: p0, p1: p1, findP1Name: ${p6J(path.basename(P6_FIND))}, findP0Name: ${p6J(path.basename(P6_FIND2))} };
            })()`);
            await p6Reset();
            const conj = {
              'default-case-insensitive-4': !!(def && def.shown === 4 && def.opts.caseSensitive === false),
              'case-toggle-2': !!(cs && cs.shown === 2 && cs.opts.caseSensitive === true),
              'whole-word-3': !!(ww && ww.shown === 3 && ww.opts.wholeWord === true),
              'regex-3': !!(re1 && re1.shown === 3 && !re1.error),
              'regex-plus-case-1': !!(re2 && re2.shown === 1),
              'invalid-regex-explicit': !!(bad && /正则表达式无效/.test(bad.err || '') && /查找未执行/.test(bad.count || '') && /正则表达式无效/.test(bad.text || '')),
              'pattern-too-long-rejected': !!(tooLong && tooLong.max === 200 && /正则模式过长/.test(tooLong.err || '') && /查找未执行/.test(tooLong.count || '')),
              'nested-quantifier-rejected': !!(nested && /嵌套量词/.test(nested.err || '')),
              'budget-timeout-explicit': !!(budget && budget.timedOut === true && budget.budget === 1 && budget.docLines >= 20000 && /执行预算/.test(budget.count || '') && /执行预算/.test(budget.more || '') && budget.shown === 0),
              'budget-no-false-positive': !!(noFalse && noFalse.timedOut === false && noFalse.budget === 120 && noFalse.limit === 500 && noFalse.shown === 4
                && noFalseBig && noFalseBig.timedOut === false && noFalseBig.truncated === true && noFalseBig.shown === 500 && noFalseBig.docLines >= 20000),
              'huge-guard-explicit-on-type': !!(hugeGuard && hugeGuard.open && hugeGuard.open.kind === 'huge' && P6_SMALL_BYTES > 1024 * 1024 && hugeGuard.typed.unsupported === 'huge' && /当前视图不支持文件内查找/.test(hugeGuard.typed.count || '') && /当前视图不支持文件内查找/.test(hugeGuard.typed.text || '') && hugeGuard.typed.shown === 0),
              'huge-guard-explicit-on-ctrl-f': !!(hugeGuard && hugeGuard.focus.unsupported === 'huge' && /当前视图不支持文件内查找/.test(hugeGuard.focus.count || '')),
              // 布局：p1 = P6_FIND（4 处）、p0 = P6_FIND2（1 处）→ 期望值与栏一一对应
              'find-follows-focus-pane': !!(focusPane && focusPane.p0.shown === 1 && focusPane.p1.shown === 4
                && focusPane.p0.focus === 'p0' && focusPane.p1.focus === 'p1'
                && focusPane.p0.pane === 'p0' && focusPane.p1.pane === 'p1'
                && focusPane.p0.file === focusPane.findP0Name && focusPane.p1.file === focusPane.findP1Name),
            };
            return p6Fail(conj, 'def=' + p6J(def) + ' cs=' + p6J(cs) + ' ww=' + p6J(ww) + ' re1=' + p6J(re1) + ' re2=' + p6J(re2) +
              ' bad=' + p6J(bad) + ' tooLong=' + p6J(tooLong) + ' nested=' + p6J(nested) + ' budget=' + p6J(budget) + ' noFalseBig=' + p6J(noFalseBig) + ' noFalse=' + p6J(noFalse) +
              ' smallBytes=' + p6J(P6_SMALL_BYTES) + ' hugeGuard=' + p6J(hugeGuard) + ' focusPane=' + p6J(focusPane));
          });

          // ==================== 4. findMatchLimit：匹配上限 + 显式截断提示 + 输入防抖 ====================
          await p6Case('findMatchLimit', async () => {
            await p6Reset();
            await p6Effect(`window.__app.editor.openFile(${p6J(P6_LIMIT)})`);   // 20000 行，每行一个 needle
            await p6Sleep(900);
            const S = `window.__app.find`;
            // ① 上限截断：只展示前 500 处，且**计数行与结果区都要显式提示**
            const lim = await p6Eval(`(() => {
              ${S}.setOptions({ caseSensitive: false, wholeWord: false, regex: false });
              const t0 = performance.now();
              ${S}.setQuery('needle');
              const ms = Math.round(performance.now() - t0);
              const s = ${S}.getState();
              const note = document.querySelector('#find-results .find-more');
              return { shown: s.shown, rows: s.rows, truncated: s.truncated, limit: s.limits.limit, count: s.countText, more: s.moreText,
                noteText: note ? note.textContent : null, noteIsNotResultRow: !!note && !note.classList.contains('find-result'), ms: ms };
            })()`);
            // ② 输入防抖：连发 6 次 input → 只跑一次搜索（searchRuns 只 +1）
            const deb = await p6Eval(`(() => {
              const i = document.getElementById('find-input');
              const s0 = ${S}.getState();
              for (let k = 0; k < 6; k++) { i.value = 'needle 行 ' + k; i.dispatchEvent(new Event('input')); }
              const s1 = ${S}.getState();   // 同步读：防抖尚未到点
              return { runs0: s0.searchRuns, runsSync: s1.searchRuns, pending: s1.pendingDebounce, value: i.value };
            })()`);
            // 有界轮询到防抖真正触发（替代固定 300ms 硬等待）：find.js 的输入防抖只有 80ms，
            // 但窗口被遮挡时 Electron 默认的 backgroundThrottling 会把定时器节流到 ~1s 级 ——
            // 固定 sleep 会得到"防抖未触发"的假红（2026-09-13 实证：debAfter.pending 仍为 true）。
            // 上限 ~3000ms；超时也照常往下走，由下面的四元判定给出带 runs/pending/shown/truncated 的 detail。
            for (let pollI = 0; pollI < 30; pollI++) {
              const stNow = await p6Eval(`(() => { const s = ${S}.getState(); return { pending: s.pendingDebounce }; })()`);
              if (!stNow || stNow.pending === false) break;
              await p6Sleep(100);
            }
            const debAfter = await p6Eval(`(() => { const s = ${S}.getState(); const i = document.getElementById('find-input');
              return { runs: s.searchRuns, pending: s.pendingDebounce, shown: s.shown, query: s.query, value: i.value, truncated: s.truncated }; })()`);
            // ③ 程序化 setQuery 不受防抖影响（同步生效）
            const immediate = await p6Eval(`(() => { const s0 = ${S}.getState(); ${S}.setQuery('needle'); const s1 = ${S}.getState();
              return { before: s0.searchRuns, after: s1.searchRuns, shown: s1.shown }; })()`);
            // ④ 上限只约束**展示**：「全部替换」必须换掉全部 20000 处（不能只换前 500）
            const rep = await p6Eval(`(() => {
              document.getElementById('replace-input').value = 'MH-X';
              const n = ${S}.replaceAll();
              const doc = window.__app.editor.getView().state.doc.toString();
              return { n: n, leftNeedle: doc.indexOf('needle') >= 0, count: doc.split('MH-X').length - 1 };
            })()`);
            await p6Reset();
            const conj = {
              'limit-truncates-to-500': !!(lim && lim.shown === 500 && lim.limit === 500 && lim.truncated === true),
              'limit-row-dom-capped': !!(lim && lim.rows === 500),
              'limit-count-notice': !!(lim && /仅显示前 500 处/.test(lim.count || '')),
              'limit-result-notice-row': !!(lim && /仅显示前 500 处/.test(lim.more || '') && /仅显示前 500 处/.test(lim.noteText || '') && lim.noteIsNotResultRow === true),
              'limit-fast-under-1500ms': !!(lim && typeof lim.ms === 'number' && lim.ms < 1500),
              'debounce-coalesces-input': !!(deb && deb.runsSync === deb.runs0 && deb.pending === true),
              'debounce-runs-once-after': !!(debAfter && debAfter.runs === deb.runs0 + 1 && debAfter.pending === false && debAfter.shown === 500 && debAfter.truncated === true),
              'setquery-not-debounced': !!(immediate && immediate.after === immediate.before + 1 && immediate.shown === 500),
              'replace-all-not-limited-to-displayed': !!(rep && rep.n === 20000 && rep.leftNeedle === false && rep.count === 20000),
            };
            return p6Fail(conj, 'lim=' + p6J(lim) + ' deb=' + p6J(deb) + ' debAfter=' + p6J(debAfter) + ' immediate=' + p6J(immediate) + ' rep=' + p6J(rep));
          });
        } finally {
          // 清场：关浮层/菜单/弹窗、合栏、关标签、清重开栈、恢复阈值与查找开关、删夹具
          try { await p6Eval(`(async () => {
            try { window.__app.quickOpen.close(); } catch (e) {}
            try { window.__app.editor.hideTabsHud(); } catch (e) {}
            try { const m = document.getElementById('ctx-menu'); if (m) m.classList.add('hidden'); } catch (e) {}
            try { document.getElementById('modal-mask').classList.add('hidden'); } catch (e) {}
            try { window.__app.editor.setHugeThresholdMB(null); } catch (e) {}
            try { window.__app.find.setLimitsForTest({ budgetMs: null, limit: null }); } catch (e) {}
            try { window.__app.find.setQuery(''); window.__app.find.setOptions({ caseSensitive: false, wholeWord: false, regex: false }); } catch (e) {}
            try { const e2 = window.__app.editor; if (e2.getPaneCount() > 1) e2.mergePanes(); e2.closeAll(); e2.clearClosedStack(); } catch (e) {}
            return true;
          })()`); } catch { /* 忽略 */ }
          try { await p6Sleep(400); } catch { /* 忽略 */ }
          try { fs.chmodSync(P6_RO, 0o666); } catch { /* 忽略 */ }
          for (const f of [P6_REOPEN, P6_RO, P6_PANE_A, P6_PANE_B, P6_FIND, P6_FIND2, P6_LIMIT, P6_HUGE, P6_SMALLHUGE].concat(P6_STACK)) {
            try { fs.rmSync(f, { force: true }); } catch { /* 占用则忽略 */ }
          }
          try { fs.rmSync(P6_CTX_DIR, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
        }
      }

      // ==========================================================================
      // v0.7.2 修复回归批（5 条）—— 位置：Phase 5a 批之后、E2E_RESULTS 之前，真·append（未改动任何既有用例）。
      //   对应修复：① search-worker 字节快路径大小写折叠（全小写/全大写/混合查询都要命中全部大小写形态内容）
      //   ② 回退路径无换行巨文件 strBuf 有界 + 块级可取消 ③ 全局替换变长小写映射下标错位（数据损坏类）
      //   ④ 树全量 render 后嵌套已展开目录异步补载 ⑤ 大文档预览自动重渲闸门（>8MB 不随击键整渲，手动刷新）。
      // 口径同前批：渲染端可观测事实 + 主进程 fs 真读；每个合取项单独命名进 detail；夹具自建自清。
      // 坑①：所有 p7Eval 模板串内部只用单引号，绝不出现裸反引号与意外模板占位符。
      // ==========================================================================
      {
        const P7_MIXED = path.join(TEST_ROOT, 'p7-huge-mixed.txt');      // >10MB：三种大小写形态各占一行
        const P7_ONELINE = path.join(TEST_ROOT, 'p7-huge-oneline.txt');  // >10MB 无换行单行，关键词在尾部
        const P7_REPLACE = path.join(TEST_ROOT, 'p7-replace.md');
        const P7_TREE = path.join(TEST_ROOT, 'p7-tree');
        const P7_TREE_A = path.join(P7_TREE, 'a');
        const P7_TREE_B = path.join(P7_TREE_A, 'b');
        const P7_TREE_C = path.join(P7_TREE_B, 'c');
        const P7_TREE_DEEP = path.join(P7_TREE_C, 'deep.md');
        const P7_PREV = path.join(TEST_ROOT, 'p7-preview-big.md');       // >8MB：触发预览闸门
        // 混合大小写夹具：20 万行 ≈ 10.6MB（> search-worker.js 的 MAX_SEARCH_FILE_MB=10 流式门槛）
        const P7_MIXED_LINES = [1234, 100000, 199999];
        {
          const filler = 'p7 filler line abcdefghijklmnopqrstuvwxyz 0123456789';
          const lines = new Array(200000).fill(filler);
          lines[P7_MIXED_LINES[0] - 1] = 'p7mix readme tail';
          lines[P7_MIXED_LINES[1] - 1] = 'p7mix Readme tail';
          lines[P7_MIXED_LINES[2] - 1] = 'p7mix README tail';
          fs.writeFileSync(P7_MIXED, lines.join('\n') + '\n', 'utf8');
        }
        // 无换行单行夹具：11MB + 尾部中文关键词（非 ASCII 查询强制走回退路径）
        const P7_KW = '关键词p7';
        fs.writeFileSync(P7_ONELINE, 'x'.repeat(11 * 1024 * 1024) + P7_KW + 'y'.repeat(1024), 'utf8');
        // 全局替换夹具：İ（U+0130，小写映射成 2 字符）站在匹配点前面 —— 旧实现下标错位会写坏文件
        const P7_REP_ORIG = 'xİy p7rep z p7rep İw\n第二行 p7rep\n';
        const P7_REP_WANT = 'xİy MH z MH İw\n第二行 MH\n';
        fs.writeFileSync(P7_REPLACE, P7_REP_ORIG, 'utf8');
        // 树夹具：p7-tree/a/b/c/deep.md 三层嵌套
        fs.mkdirSync(P7_TREE_C, { recursive: true });
        fs.writeFileSync(P7_TREE_DEEP, '# p7 deep\n', 'utf8');
        // 预览闸门夹具：>8MB markdown（preview.js PREVIEW_AUTO_MAX_BYTES = 8MB）
        {
          const block = 'p7 preview filler line abcdefghijklmnopqrstuvwxyz 0123456789 abcdefghij\n';
          const parts = ['# p7previewhead\n\n'];
          for (let i = 0; i < 120000; i++) parts.push(block); // ≈ 9.5MB
          fs.writeFileSync(P7_PREV, parts.join(''), 'utf8');
        }
        const P7_MIXED_BYTES = fs.statSync(P7_MIXED).size;
        const P7_ONELINE_BYTES = fs.statSync(P7_ONELINE).size;
        const P7_PREV_BYTES = fs.statSync(P7_PREV).size;
        const P7_STREAM_MIN = 10 * 1024 * 1024;   // search-worker.js MAX_SEARCH_FILE_MB
        const P7_GATE_MIN = 8 * 1024 * 1024;      // preview.js PREVIEW_AUTO_MAX_BYTES

        const p7Eval = (code) => win.webContents.executeJavaScript(code);
        const p7Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const p7J = (v) => JSON.stringify(v === undefined ? null : v);
        const p7Case = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        const p7Fail = (conj, evidence) => ({
          ok: Object.keys(conj).every((k) => conj[k] === true),
          detail: Object.keys(conj).map((k) => k + '=' + conj[k]).join(','),
          evidence: evidence || '',
        });
        const p7Wait = async (code, pred, ms = 10000, step = 200) => {
          const t0 = Date.now();
          let v = null;
          for (;;) {
            v = await p7Eval(code).catch(() => null);
            if (v !== null && pred(v)) return v;
            if (Date.now() - t0 > ms) return v;
            await p7Sleep(step);
          }
        };
        const p7Reset = async () => {
          await p7Eval(`(async () => { await window.__app.openDirFromPath(${p7J(TEST_ROOT)}); })()`).catch(() => {});
          await p7Sleep(120);
          await p7Eval(`(() => {
            const e = window.__app.editor;
            if (window.__app.quickOpen) window.__app.quickOpen.close();
            document.querySelectorAll('.tabs-menu').forEach((m) => m.classList.add('hidden'));
            const hm = document.getElementById('ctx-menu'); if (hm) hm.classList.add('hidden');
            e.hideTabsHud();
            if (e.getPaneCount() > 1) e.mergePanes();
            e.closeAll();
            e.clearClosedStack();
            return e.getPaneCount();
          })()`).catch(() => -1);
          await p7Sleep(200);
        };
        // 树行定位/展开的注入助手（行与其子容器是兄弟节点，子容器经 nextElementSibling 取）
        const P7_TREE_HELPERS = `
          const norm7 = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
          const all7 = () => Array.from(document.querySelectorAll('#file-tree .tree-node'));
          const rowOf7 = (p) => all7().find((n) => norm7(n.dataset.path) === norm7(p));
          const kids7 = (row) => { const box = row && row.nextElementSibling; return box && box.classList && box.classList.contains('tree-children') ? box : null; };
          const open7 = async (p) => {
            let row = rowOf7(p);
            if (!row) return { ok: false, p: p, missing: true };
            let box = kids7(row);
            if (!(box && box.style.display !== 'none' && box.querySelectorAll('.tree-node').length > 0)) row.click();
            for (let i = 0; i < 40; i++) {
              await new Promise((r2) => setTimeout(r2, 150));
              row = rowOf7(p);
              box = kids7(row);
              if (box && box.style.display !== 'none' && box.querySelectorAll('.tree-node').length > 0) return { ok: true };
            }
            return { ok: false, p: p, timeout: true };
          };
        `;

        try {
          // ==================== 1. gsMixedCaseHuge：>10MB 文件大小写折叠搜索（快路径回归） ====================
          await p7Case('gsMixedCaseHuge', async () => {
            const perQ = {};
            for (const q of ['readme', 'README', 'Readme']) {
              const hits = await p7Eval(`(async () => {
                const rs = await window.api.globalSearch(${p7J(TEST_ROOT)}, ${p7J(q)});
                const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
                return rs.filter((x) => norm(x.file).endsWith('p7-huge-mixed.txt')).map((x) => ({ line: x.line, kind: x.kind || '' }));
              })()`);
              const lines = (hits || []).map((h) => h.line).sort((a, b) => a - b);
              perQ[q] = { n: lines.length, lines: lines.join(','), contentKind: (hits || []).every((h) => h.kind === '') };
            }
            const wantLines = P7_MIXED_LINES.slice().sort((a, b) => a - b).join(',');
            const okQ = (q) => perQ[q] && perQ[q].n === 3 && perQ[q].lines === wantLines && perQ[q].contentKind;
            const conj = {
              'fixture-over-10mb-stream-path': P7_MIXED_BYTES > P7_STREAM_MIN,
              'query-lowercase-hits-all-case-forms': okQ('readme'),
              'query-uppercase-hits-all-case-forms': okQ('README'),
              'query-mixedcase-hits-all-case-forms': okQ('Readme'),
            };
            return p7Fail(conj, 'bytes=' + P7_MIXED_BYTES + ' want=' + wantLines + ' perQ=' + p7J(perQ));
          });

          // ==================== 2. gsNoNewlineHuge：回退路径无换行巨文件有界且命中 ====================
          await p7Case('gsNoNewlineHuge', async () => {
            const t0 = Date.now();
            const hits = await p7Eval(`(async () => {
              const rs = await window.api.globalSearch(${p7J(TEST_ROOT)}, ${p7J(P7_KW)});
              const norm = (p) => String(p).replace(/\\\\/g, '/').toLowerCase();
              return rs.filter((x) => norm(x.file).endsWith('p7-huge-oneline.txt')).map((x) => ({ line: x.line, len: x.text ? x.text.length : -1 }));
            })()`);
            const ms = Date.now() - t0;
            const hit = hits && hits[0];
            const conj = {
              'fixture-over-10mb-stream-path': P7_ONELINE_BYTES > P7_STREAM_MIN,
              'exactly-one-hit': !!(hits && hits.length === 1),
              'line-is-1': !!(hit && hit.line === 1),
              'text-truncated-le-1000': !!(hit && hit.len >= 0 && hit.len <= 1000),
            };
            return p7Fail(conj, 'bytes=' + P7_ONELINE_BYTES + ' ms=' + ms + ' hits=' + p7J(hits));
          });

          // ==================== 3. gsReplaceCaseFold：全局替换遇变长小写映射不写坏文件 ====================
          await p7Case('gsReplaceCaseFold', async () => {
            const r = await p7Eval(`(async () => {
              const gs = window.__app.globalSearch;
              document.getElementById('gs-input').value = 'p7rep';
              await gs.run();
              document.getElementById('gs-replace-input').value = 'MH';
              const ok = await gs.replaceAll(true);
              const back = await window.api.readFile(${p7J(P7_REPLACE)});
              return { ok: ok === true, content: back.content };
            })()`);
            const conj = {
              'replace-returns-true': !!(r && r.ok === true),
              'content-exact-after-replace': !!(r && r.content === P7_REP_WANT),
              'replaced-3-sites': !!(r && typeof r.content === 'string' && r.content.split('MH').length - 1 === 3),
              'no-residual-query': !!(r && typeof r.content === 'string' && r.content.indexOf('p7rep') < 0),
            };
            return p7Fail(conj, 'want=' + p7J(P7_REP_WANT) + ' got=' + p7J(r));
          });

          // ==================== 4. treeNestedExpand：全量 render 后嵌套已展开目录自动补载 ====================
          await p7Case('treeNestedExpand', async () => {
            await p7Eval(`(async () => { await window.__app.tree.setRoot(${p7J(TEST_ROOT)}); return true; })()`);
            await p7Sleep(500);
            const opened = await p7Eval(`(async () => {
              ${P7_TREE_HELPERS}
              const out = {};
              const chain = ${p7J([P7_TREE, P7_TREE_A, P7_TREE_B, P7_TREE_C])};
              for (const p of chain) {
                const r = await open7(p);
                out[p] = r.ok === true;
                if (!r.ok) return out;
              }
              out.deepVisible = !!rowOf7(${p7J(P7_TREE_DEEP)});
              return out;
            })()`);
            // 全量 render（根刷新路径）：expanded 集合保留但节点全部重建 —— 修复前嵌套目录「展开却为空」
            await p7Eval(`(async () => { await window.__app.tree.refreshNode(${p7J(TEST_ROOT)}, true); return true; })()`);
            const after = await p7Wait(`(() => {
              ${P7_TREE_HELPERS}
              const chain = ${p7J([P7_TREE_A, P7_TREE_B, P7_TREE_C])}.map((p) => {
                const row = rowOf7(p);
                const box = kids7(row);
                return !!(row && box && box.style.display !== 'none' && box.querySelectorAll('.tree-node').length > 0);
              });
              return { deep: !!rowOf7(${p7J(P7_TREE_DEEP)}), chain: chain };
            })()`, (v) => v && v.deep === true && v.chain.every((x) => x === true), 9000, 250);
            const conj = {
              'expand-chain-before-render': !!(opened && opened[P7_TREE] === true && opened[P7_TREE_A] === true && opened[P7_TREE_B] === true && opened[P7_TREE_C] === true),
              'deep-visible-before-render': !!(opened && opened.deepVisible === true),
              'deep-reloaded-after-full-render': !!(after && after.deep === true),
              'nested-dirs-still-expanded-loaded': !!(after && Array.isArray(after.chain) && after.chain.every((x) => x === true)),
            };
            return p7Fail(conj, 'opened=' + p7J(opened) + ' after=' + p7J(after));
          });

          // ==================== 5. previewGateLargeDoc：>8MB 文档击键不整渲，手动刷新恢复 ====================
          await p7Case('previewGateLargeDoc', async () => {
            await p7Reset();
            await p7Eval(`(async () => { await window.__app.editor.openFile(${p7J(P7_PREV)}); return true; })()`);
            await p7Sleep(1500);
            // 分段标签懒加载：先 ensureFullyLoaded 再读 doc.length（否则闸门阈值拿到的是部分长度，
            // 且首轮 auto 渲染会整渲未加载文档 —— 实测 len 仅 ~2MB 导致用例语义跑偏）
            const st0 = await p7Eval(`(async () => { const e = window.__app.editor; const t = e.getActiveTab();
              if (t) await e.ensureFullyLoaded(t);
              return { kind: t && (t.kind || 'normal'), len: t && t.state ? t.state.doc.length : 0 }; })()`);
            // 初始整渲（applyMode 走非 auto 路径，不受闸门限制）
            await p7Eval(`(() => { window.__app.preview.setMode('split'); window.__app.preview.applyMode(); return true; })()`);
            const initial = await p7Wait(`(() => { const c = document.querySelector('#preview-content');
              return { has: !!(c && c.textContent.indexOf('p7previewhead') >= 0) }; })()`, (v) => v && v.has === true, 20000, 300);
            // 编辑 → onDocChanged → 250ms 防抖 → render({auto:true}) → 闸门拦下
            await p7Eval(`(() => { const e = window.__app.editor; const v = e.getView();
              v.dispatch({ changes: { from: 0, insert: 'P7EDITMARK ' } }); return true; })()`);
            const gated = await p7Wait(`(() => { const b = document.querySelector('.preview-gate-banner'); const c = document.querySelector('#preview-content');
              return { banner: !!b, marker: !!(c && c.textContent.indexOf('P7EDITMARK') >= 0) }; })()`, (v) => v && v.banner === true, 6000, 200);
            // 手动刷新 → 非 auto → 整渲恢复，横幅移除
            await p7Eval(`(() => { const b = document.querySelector('.preview-gate-banner button'); if (b) b.click(); return !!b; })()`);
            const refreshed = await p7Wait(`(() => { const b = document.querySelector('.preview-gate-banner'); const c = document.querySelector('#preview-content');
              return { banner: !!b, marker: !!(c && c.textContent.indexOf('P7EDITMARK') >= 0) }; })()`, (v) => v && v.marker === true, 20000, 300);
            const conj = {
              'fixture-over-8mb-gate-threshold': P7_PREV_BYTES > P7_GATE_MIN && !!(st0 && st0.len > P7_GATE_MIN),
              'initial-full-render': !!(initial && initial.has === true),
              'auto-render-gated-banner-shown': !!(gated && gated.banner === true),
              'auto-render-gated-content-stale': !!(gated && gated.marker === false),
              'manual-refresh-renders-marker': !!(refreshed && refreshed.marker === true),
              'banner-removed-after-manual': !!(refreshed && refreshed.banner === false),
            };
            return p7Fail(conj, 'bytes=' + P7_PREV_BYTES + ' st0=' + p7J(st0) + ' gated=' + p7J(gated) + ' refreshed=' + p7J(refreshed));
          });
        } finally {
          // 清场：恢复编辑模式、关标签、清重开栈、清全局搜索框、重申工作目录、删夹具
          try { await p7Eval(`(async () => {
            try { window.__app.preview.setMode('edit'); window.__app.preview.applyMode(); } catch (e) {}
            try { const e2 = window.__app.editor; if (e2.getPaneCount() > 1) e2.mergePanes(); e2.closeAll(); e2.clearClosedStack(); } catch (e) {}
            try { document.getElementById('gs-input').value = ''; document.getElementById('gs-replace-input').value = ''; } catch (e) {}
            try { await window.__app.openDirFromPath(${p7J(TEST_ROOT)}); } catch (e) {}
            return true;
          })()`); } catch { /* 忽略 */ }
          try { await p7Sleep(300); } catch { /* 忽略 */ }
          for (const f of [P7_MIXED, P7_ONELINE, P7_REPLACE, P7_PREV]) {
            try { fs.rmSync(f, { force: true }); } catch { /* 占用则忽略 */ }
          }
          try { fs.rmSync(P7_TREE, { recursive: true, force: true }); } catch { /* 占用则忽略 */ }
        }
      }

      // ==========================================================================
      // v0.8.0 新功能回归批（4 条）—— 位置：v0.7.2 批之后、E2E_RESULTS 之前，真·append。
      //   ① tabDragReorder：标签栏合成 DragEvent 拖拽重排（DOM 序 + 会话序一致）
      //   ② favRailToggle：收藏右栏 隐藏→覆盖式打开→pin 常驻→再点关闭 状态机 + 设置落盘
      //   ③ hugeSelectCopy：大文件视图文本可选中、Ctrl+C 写系统剪贴板（主进程读回）+ 无选区复制当前行
      //   ④ hugeTypeFocus：点击视口即聚焦、键入即编辑（首键开会话、次键落字）
      // 坑①：p8Eval 模板串内部只用单引号，绝不出现裸反引号。
      // ==========================================================================
      {
        const P8_DND = [1, 2, 3].map((i) => path.join(TEST_ROOT, 'p8-dnd-' + i + '.md'));
        const P8_HUGE_TXT = path.join(TEST_ROOT, 'p8-huge-2mb.txt');
        const P8_HUGE_TYPE = path.join(TEST_ROOT, 'p8-type.bin');
        const P8_HUGE_SRC = path.join(TEST_ROOT, 'build', 'bd-280mb.bin'); // 主进程 setup 预置的大文件材料
        for (const f of P8_DND) fs.writeFileSync(f, '# p8 dnd ' + path.basename(f) + '\n', 'utf8');
        {
          const line = 'p8 huge line 00000000 abcdefghijklmnopqrstuvwxyz\n'; // 51B
          const parts = [];
          for (let i = 0; i < 42000; i++) parts.push(line); // ≈ 2.1MB
          fs.writeFileSync(P8_HUGE_TXT, parts.join(''), 'utf8');
        }
        fs.copyFileSync(P8_HUGE_SRC, P8_HUGE_TYPE);

        const p8Eval = (code) => win.webContents.executeJavaScript(code);
        const p8Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const p8J = (v) => JSON.stringify(v === undefined ? null : v);
        const p8Case = async (name, fn) => {
          let r;
          try {
            r = await fn();
          } catch (err) {
            r = { ok: false, detail: 'ERR: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' // ') : String(err)), evidence: '' };
          }
          results.push([name, r && r.ok === true ? true : ((r && r.detail) || 'false'), (r && r.evidence) || '']);
        };
        const p8Fail = (conj, evidence) => ({
          ok: Object.keys(conj).every((k) => conj[k] === true),
          detail: Object.keys(conj).map((k) => k + '=' + conj[k]).join(','),
          evidence: evidence || '',
        });
        const p8Wait = async (code, pred, ms = 10000, step = 200) => {
          const t0 = Date.now();
          let v = null;
          for (;;) {
            v = await p8Eval(code).catch(() => null);
            if (v !== null && pred(v)) return v;
            if (Date.now() - t0 > ms) return v;
            await p8Sleep(step);
          }
        };
        const p8Reset = async () => {
          await p8Eval(`(async () => { await window.__app.openDirFromPath(${p8J(TEST_ROOT)}); })()`).catch(() => {});
          await p8Sleep(120);
          await p8Eval(`(() => {
            const e = window.__app.editor;
            if (window.__app.quickOpen) window.__app.quickOpen.close();
            document.querySelectorAll('.tabs-menu').forEach((m) => m.classList.add('hidden'));
            const hm = document.getElementById('ctx-menu'); if (hm) hm.classList.add('hidden');
            e.hideTabsHud();
            if (e.getPaneCount() > 1) e.mergePanes();
            e.closeAll();
            e.clearClosedStack();
            return e.getPaneCount();
          })()`).catch(() => -1);
          await p8Sleep(200);
        };

        try {
          // ==================== 1. tabDragReorder：标签拖拽重排 ====================
          await p8Case('tabDragReorder', async () => {
            await p8Reset();
            for (const f of P8_DND) {
              await p8Eval(`(async () => { await window.__app.editor.openFile(${p8J(f)}); return true; })()`);
              await p8Sleep(200);
            }
            const before = await p8Eval(`(() => Array.from(document.querySelectorAll('.tab .tab-name')).map((n) => n.textContent))()`);
            // 合成 DnD：拖第 1 个标签到第 3 个标签的右半（= 插到它后面）
            const drag = await p8Eval(`(() => {
              const tabs = Array.from(document.querySelectorAll('.tab'));
              if (tabs.length !== 3) return { err: 'tabs=' + tabs.length };
              const dt = new DataTransfer();
              const target = tabs[2];
              const r = target.getBoundingClientRect();
              const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.right - 2, clientY: r.top + 2 };
              tabs[0].dispatchEvent(new DragEvent('dragstart', opts));
              target.dispatchEvent(new DragEvent('dragover', opts));
              target.dispatchEvent(new DragEvent('drop', opts));
              tabs[0].dispatchEvent(new DragEvent('dragend', opts));
              return { err: null };
            })()`);
            await p8Sleep(400);
            const after = await p8Eval(`(() => Array.from(document.querySelectorAll('.tab .tab-name')).map((n) => n.textContent))()`);
            const sessionOrder = await p8Eval(`(() => window.__app.editor.getSession().paths.map((p) => p.split(/[\\\\/]/).pop()))()`);
            const want = ['p8-dnd-2.md', 'p8-dnd-3.md', 'p8-dnd-1.md'];
            const conj = {
              'before-order-123': !!(before && before.join(',') === 'p8-dnd-1.md,p8-dnd-2.md,p8-dnd-3.md'),
              'drag-no-error': !!(drag && drag.err === null),
              'dom-order-231': !!(after && after.join(',') === want.join(',')),
              'session-order-231': !!(sessionOrder && sessionOrder.join(',') === want.join(',')),
            };
            return p8Fail(conj, 'before=' + p8J(before) + ' after=' + p8J(after) + ' session=' + p8J(sessionOrder) + ' drag=' + p8J(drag));
          });

          // ==================== 2. favRailToggle：收藏右栏状态机 ====================
          await p8Case('favRailToggle', async () => {
            const st0 = await p8Eval(`(() => window.__app.favRail.getState())()`);
            // 点工具栏「🗂 收藏栏」→ 覆盖式打开
            await p8Eval(`(() => { document.getElementById('btn-fav-rail').click(); return true; })()`);
            await p8Sleep(300);
            const st1 = await p8Eval(`(() => window.__app.favRail.getState())()`);
            // 点 pin → 挤压式常驻（分隔条可见）
            await p8Eval(`(() => { document.getElementById('btn-fav-pin').click(); return true; })()`);
            await p8Sleep(300);
            const st2 = await p8Eval(`(() => window.__app.favRail.getState())()`);
            const saved2 = await p8Eval(`window.api.getSettings().then((s) => ({ open: s.favRailOpen, pinned: s.favRailPinned }))`);
            // pin 态再点「🗂 收藏栏」→ 取消 pin 并关闭
            await p8Eval(`(() => { document.getElementById('btn-fav-rail').click(); return true; })()`);
            await p8Sleep(300);
            const st3 = await p8Eval(`(() => window.__app.favRail.getState())()`);
            const saved3 = await p8Eval(`window.api.getSettings().then((s) => ({ open: s.favRailOpen, pinned: s.favRailPinned }))`);
            const conj = {
              'initial-hidden': !!(st0 && st0.visible === false && st0.pinned === false),
              'toggle-opens-overlay': !!(st1 && st1.open === true && st1.overlay === true && st1.visible === true && st1.pinned === false),
              'pin-docks-with-divider': !!(st2 && st2.pinned === true && st2.visible === true && st2.dividerVisible === true),
              'settings-persist-pinned': !!(saved2 && saved2.pinned === true),
              'toggle-in-pinned-closes': !!(st3 && st3.visible === false && st3.pinned === false),
              'settings-persist-closed': !!(saved3 && saved3.open === false && saved3.pinned === false),
            };
            return p8Fail(conj, 'st0=' + p8J(st0) + ' st1=' + p8J(st1) + ' st2=' + p8J(st2) + ' saved2=' + p8J(saved2) + ' st3=' + p8J(st3) + ' saved3=' + p8J(saved3));
          });

          // ==================== 3. hugeSelectCopy：大文件视图选中 + Ctrl+C ====================
          await p8Case('hugeSelectCopy', async () => {
            await p8Reset();
            await p8Eval(`(() => { window.__app.editor.setHugeThresholdMB(1); return true; })()`);
            await p8Eval(`(async () => { await window.__app.editor.openFile(${p8J(P8_HUGE_TXT)}); return true; })()`);
            const hvReady = await p8Wait(`(() => { const t = window.__app.editor.getActiveTab();
              return t && t.kind === 'huge' && t.huge && t.huge.getState().indexed && t.huge.getState().renderedRows > 0 ? true : null; })()`, (v) => v === true, 15000, 300);
            const sel = await p8Eval(`(() => {
              const texts = Array.from(document.querySelectorAll('.huge-view .huge-rows .huge-text'));
              if (texts.length < 2) return { rows: texts.length };
              const cs = getComputedStyle(texts[0]).userSelect;
              const r = document.createRange();
              const n0 = texts[0].firstChild || texts[0];
              const n1 = texts[1].firstChild || texts[1];
              r.setStart(n0, 0);
              r.setEnd(n1, n1.length || 0);
              const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
              return { cs: cs, len: s.toString().length, head: s.toString().slice(0, 20), rows: texts.length };
            })()`);
            await p8Eval(`(() => { const root = document.querySelector('.huge-view'); root.focus();
              root.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
            await p8Sleep(500);
            const clip1 = clipboard.readText();
            // 无选区 → 复制当前行（视口首行）
            const line1 = await p8Eval(`(() => {
              window.getSelection().removeAllRanges();
              const root = document.querySelector('.huge-view'); root.focus();
              root.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
              const st = window.__app.editor.getActiveTab().huge.getState();
              return { firstLine: st.firstLine };
            })()`);
            await p8Sleep(500);
            const clip2 = clipboard.readText();
            const conj = {
              'huge-tab-ready': hvReady === true,
              'user-select-text': !!(sel && sel.cs === 'text'),
              'selection-nonempty': !!(sel && sel.len > 20),
              'ctrlc-writes-clipboard': !!(clip1 && sel && sel.head && clip1.indexOf(sel.head) >= 0),
              'no-selection-copies-line': !!(clip2 && clip2.indexOf('p8 huge line') >= 0),
            };
            return p8Fail(conj, 'sel=' + p8J(sel) + ' clip1=' + p8J(clip1.slice(0, 40)) + ' clip2=' + p8J(clip2.slice(0, 60)) + ' line1=' + p8J(line1));
          });

          // ==================== 4. hugeTypeFocus：点击聚焦 + 键入即编辑 ====================
          await p8Case('hugeTypeFocus', async () => {
            await p8Reset();
            // 280MB 夹具超默认 50MB 上限：先提上限并显式刷新渲染端缓存（sameFileTwoPanes 同款姿势）
            await p8Eval(`(async () => { await window.api.setSettings({ maxFileSizeMB: 512 });
              window.__app.state.settings = await window.api.getSettings();
              window.__app.editor.setHugeThresholdMB(200); return true; })()`);
            await p8Eval(`(async () => { await window.__app.editor.openFile(${p8J(P8_HUGE_TYPE)}); return true; })()`);
            const ready = await p8Wait(`(() => { const t = window.__app.editor.getActiveTab();
              return t && t.kind === 'huge' && t.huge && t.huge.getState().indexed && t.huge.getState().renderedRows > 0 ? true : null; })()`, (v) => v === true, 20000, 400);
            const focused = await p8Eval(`(() => {
              const root = document.querySelector('.huge-view');
              const row = document.querySelector('.huge-view .huge-rows .huge-line');
              if (!root || !row) return { err: 'no root/row' };
              row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              return { active: document.activeElement === root || root.contains(document.activeElement) };
            })()`);
            // 首键开会话
            await p8Eval(`(() => { const root = document.querySelector('.huge-view');
              root.dispatchEvent(new KeyboardEvent('keydown', { key: '5', code: 'Digit5', bubbles: true, cancelable: true })); return true; })()`);
            const editOn = await p8Wait(`(() => { const st = window.__app.editor.getActiveTab().huge.getState();
              return st.editable === true ? { editable: true, docEditable: st.docEditable } : null; })()`, (v) => !!v, 15000, 300);
            // 次键落字
            await p8Eval(`(() => { const root = document.querySelector('.huge-view');
              root.dispatchEvent(new KeyboardEvent('keydown', { key: '5', code: 'Digit5', bubbles: true, cancelable: true })); return true; })()`);
            const dirty = await p8Wait(`(() => { const st = window.__app.editor.getActiveTab().huge.getState();
              return st.dirty === true && st.caret ? { caretLine: st.caret.line, dirtyCount: st.dirtyCount } : null; })()`, (v) => !!v, 15000, 300);
            // 收尾：保存后关闭（脏关闭会留恢复区块表污染下游用例）
            if (dirty) {
              await p8Eval(`(async () => { const hv = window.__app.editor.getActiveTab().huge; await hv.save(); await hv.setEditable(false); return true; })()`);
            }
            const conj = {
              'huge-tab-ready': ready === true,
              'mousedown-focuses-root': !!(focused && focused.active === true),
              'first-key-opens-edit': !!(editOn && editOn.editable === true && editOn.docEditable === true),
              'second-key-types-dirty': !!dirty,
            };
            return p8Fail(conj, 'focused=' + p8J(focused) + ' editOn=' + p8J(editOn) + ' dirty=' + p8J(dirty));
          });
        } finally {
          try { await p8Eval(`(async () => {
            try { window.__app.editor.setHugeThresholdMB(null); } catch (e) {}
            try { await window.api.setSettings({ maxFileSizeMB: 50 }); window.__app.state.settings = await window.api.getSettings(); } catch (e) {}
            try { if (window.__app.favRail) { window.__app.favRail.setPinned(false); window.__app.favRail.close(); } } catch (e) {}
            try { const e2 = window.__app.editor; if (e2.getPaneCount() > 1) e2.mergePanes(); e2.closeAll(); e2.clearClosedStack(); } catch (e) {}
            try { await window.__app.openDirFromPath(${p8J(TEST_ROOT)}); } catch (e) {}
            return true;
          })()`); } catch { /* 忽略 */ }
          try { await p8Sleep(300); } catch { /* 忽略 */ }
          for (const f of P8_DND.concat([P8_HUGE_TXT, P8_HUGE_TYPE])) {
            try { fs.rmSync(f, { force: true }); } catch { /* 占用则忽略 */ }
          }
        }
      }

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
