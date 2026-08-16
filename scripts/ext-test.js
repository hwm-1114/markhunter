// 最小外部修改测试：打开文件 → 外部写 → 检查编辑器内容刷新
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const TEST_ROOT = path.join(__dirname, '..', '.ext-test');

const RENDERER = `
(async () => {
  const api = window.api;
  const root = ${JSON.stringify(TEST_ROOT.replace(/\\\\/g, '/'))};
  const results = {};
  const log = (s) => { console.log('EXT-STEP ' + s); };
  try {
    // 等待应用 boot 完成
    for (let i = 0; i < 50 && !window.__app; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!window.__app) { results.fatal = 'app not ready'; return results; }
    // S1：以 .ext-test 为工作目录（主进程 currentRoot 路径校验依赖它）
    await window.__app.openDirFromPath(root);
    // 长文档：验证外部修改后滚动位置保持
    const longDoc = Array.from({ length: 300 }, (_, i) => '第' + (i + 1) + '行内容').join('\\n');
    log('write-long');
    await api.writeFile(root + '/long.md', longDoc);
    log('open');
    await window.__app.editor.openFile(root + '/long.md');
    const view = window.__app.editor.getView();
    // 滚动到中部并放置光标
    view.scrollDOM.scrollTop = 2000;
    const midPos = view.state.doc.line(150).from;
    view.dispatch({ selection: { anchor: midPos } });
    await new Promise((r) => setTimeout(r, 300));
    results.scrollBefore = view.scrollDOM.scrollTop;
    results.selBefore = view.state.selection.main.head;
    log('write-external');
    await api.writeExternal(root + '/long.md', longDoc + '\\n新增尾部行');
    log('wait');
    await new Promise((r) => setTimeout(r, 2000));
    results.scrollAfter = view.scrollDOM.scrollTop;
    results.selAfter = view.state.selection.main.head;
    results.docLen = view.state.doc.length;
    log('done');
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
      console.log('EXT_RESULT ' + JSON.stringify(r));
    } catch (err) {
      console.error('EXT_ERROR', err && err.stack ? err.stack : String(err));
    } finally {
      if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
      setTimeout(() => { console.log('EXT_DONE'); app.quit(); }, 200);
    }
  });
}

module.exports = { run };
