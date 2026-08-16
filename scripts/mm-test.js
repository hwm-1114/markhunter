// 最小 mermaid 诊断：打印渲染出的 SVG 属性与查看器中的缩放行为
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const TEST_ROOT = path.join(__dirname, '..', '.mm-test');

const RENDERER = `
(async () => {
  const t0 = Date.now();
  const api = window.api;
  const root = ${JSON.stringify(TEST_ROOT.replace(/\\\\/g, '/'))};
  const results = {};
  try {
    const BT = String.fromCharCode(96);
    const fence = BT + BT + BT;
    // S1：等待应用就绪并以 .mm-test 为工作目录（主进程 currentRoot 路径校验依赖它）
    for (let i = 0; i < 50 && !window.__app; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (window.__app) await window.__app.openDirFromPath(root);
    // 构造一个宽图（10 个节点的 flowchart）
    let nodes = '';
    for (let i = 0; i < 10; i++) nodes += '  N' + i + '-->N' + (i + 1) + '\\n';
    const mm = '# M\\n\\n' + fence + 'mermaid\\ngraph LR\\n' + nodes + fence + '\\n';
    await api.writeFile(root + '/mm.md', mm);
    await window.__app.editor.openFile(root + '/mm.md');
    await new Promise((r) => setTimeout(r, 2000));
    const svg = document.querySelector('#preview-content .mermaid-wrap svg');
    if (svg) {
      results.previewWidth = svg.getAttribute('width');
      results.previewHeight = svg.getAttribute('height');
      results.previewViewBox = svg.getAttribute('viewBox');
      results.previewStyle = svg.getAttribute('style');
      results.previewClientW = svg.getBoundingClientRect().width;
    }
    // 打开查看器
    const wrap = document.querySelector('#preview-content .mermaid-wrap');
    if (wrap) wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const vsvg = document.querySelector('#modal-body .viewer-stage .mermaid-wrap svg');
    if (vsvg) {
      results.viewerWidth = vsvg.getAttribute('width');
      results.viewerStyle = vsvg.getAttribute('style');
      results.viewerCssMaxW = vsvg.style.maxWidth;
      results.viewerRectW = vsvg.getBoundingClientRect().width;
      results.stageRectW = document.querySelector('#modal-body .viewer-stage').getBoundingClientRect().width;
    } else {
      results.viewerSvg = false;
    }
    // 滚轮放大后
    const stage = document.querySelector('#modal-body .viewer-stage');
    if (stage) {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 150));
      results.afterZoomWrapZoom = document.querySelector('#modal-body .viewer-stage .mermaid-wrap').style.zoom;
      const vs2 = document.querySelector('#modal-body .viewer-stage .mermaid-wrap svg');
      results.afterZoomRectW = vs2.getBoundingClientRect().width;
      results.afterZoomViewerWidth = vs2.getAttribute('width');
    }
    results.elapsed = Date.now() - t0;
  } catch (e) {
    results.fatal = String(e && e.stack ? e.stack : e);
  }
  return results;
})()
`;

async function run(win) {
  win.webContents.on('console-message', (event) => {
    console.log('[renderer]', event.message);
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      const r = await win.webContents.executeJavaScript(RENDERER);
      console.log('MM_RESULT ' + JSON.stringify(r));
    } catch (err) {
      console.error('MM_ERROR', err && err.stack ? err.stack : String(err));
    } finally {
      if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      setTimeout(() => { console.log('MM_DONE'); app.quit(); }, 200);
    }
  });
}

module.exports = { run };
