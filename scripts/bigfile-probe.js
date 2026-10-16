// 大文件实测探针（--bigprobe 模式，仅开发环境）：用真实 GB 级文件验证
//   ① 冷打开不假死（索引未就绪有占位、滚动条可动）② 索引就绪后可直达文件尾
//   ③ 连续下拖不卡 ④ 文本可选中 ⑤ Ctrl+C 复制闭环（读回系统剪贴板）
//   ⑥ 键入即编辑（首键开会话、次键落字）⑦ 4.5GB 编辑保存落盘
//   ⑧ 长行大文件（旧 32MB 单块上限会拒编）在新 128MB 上限下可编辑+保存
// 夹具：F:\mh-bigtest\mh-4.5gb.txt（~70B/行）与 mh-longline-1gb.txt（~1KB/行），缺失则跳过。
// 运行：npm run bigprobe；判定：进程退出码（0=全过）+ PROBE_RESULTS 明细。
const fs = require('fs');
const path = require('path');
const { app, clipboard } = require('electron');

const BIG_DIR = process.env.MH_BIGTEST_DIR || 'F:\\mh-bigtest';
const BIG = path.join(BIG_DIR, 'mh-4.5gb.txt');
const LONGLINE = path.join(BIG_DIR, 'mh-longline-1gb.txt');

function readLastLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(4096, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((x) => x.length > 0);
    return lines[lines.length - 1];
  } finally {
    fs.closeSync(fd);
  }
}

/** 流式统计 needle 出现次数（跨块安全） */
function countOccurrences(file, needle) {
  return new Promise((resolve, reject) => {
    const nb = Buffer.from(needle, 'utf8');
    let count = 0;
    let tail = Buffer.alloc(0);
    const rs = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let idx = 0;
      while ((idx = buf.indexOf(nb, idx)) !== -1) { count++; idx += nb.length; }
      tail = buf.slice(Math.max(0, buf.length - nb.length + 1));
    });
    rs.on('end', () => resolve(count));
    rs.on('error', reject);
  });
}

async function run(win) {
  const results = [];
  const push = (name, ok, evidence) => {
    results.push([name, ok === true ? 'true' : String(ok), evidence || '']);
    console.log('[probe]', name, ok === true ? 'OK' : 'FAIL', evidence || '');
  };
  const ev = (code) => win.webContents.executeJavaScript(code);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const J = (v) => JSON.stringify(v === undefined ? null : v);
  const waitFor = async (code, pred, ms = 30000, step = 400) => {
    const t0 = Date.now();
    let v = null;
    for (;;) {
      v = await ev(code).catch(() => null);
      if (v !== null && pred(v)) return v;
      if (Date.now() - t0 > ms) return v;
      await sleep(step);
    }
  };
  const HV = `window.__app.editor.getActiveTab() && window.__app.editor.getActiveTab().huge`;
  const ST = `((${HV}) ? ${HV}.getState() : null)`;

  win.webContents.on('did-finish-load', async () => {
    try {
      if (!fs.existsSync(BIG) || !fs.existsSync(LONGLINE)) {
        push('fixtures', 'SKIP: 缺少 ' + BIG + ' 或 ' + LONGLINE + '（先生成夹具）');
      } else {
        const bigSize = fs.statSync(BIG).size;
        const tailLine = readLastLine(BIG);
        const tailToken = tailLine.split(' ')[1]; // 行号 token，如 067108863

        // 0. boot + 上限放开（默认 50MB 打不开 4.5GB）。
        //    注意渲染端 state.settings 是缓存：setSettings 落盘后**显式回读刷新**（smoke.js:4509 同款），
        //    否则 settings:changed 事件与 openFile 竞态 → 上限仍 50 → 静默拒开（首跑踩过）。
        const boot = await ev(`(async () => {
          for (let i = 0; i < 100 && !window.__app; i++) await new Promise((r) => setTimeout(r, 100));
          if (!window.__app) return false;
          await window.api.setSettings({ maxFileSizeMB: 5120 });
          window.__app.state.settings = await window.api.getSettings();
          return await window.__app.openDirFromPath(${J(BIG_DIR)});
        })()`);
        push('boot', boot === true);

        // 1. 打开 4.5GB → huge 标签（证据带 openFile 返回值与渲染端实际上限，便于一次性定位）
        const t0 = Date.now();
        const openRet = await ev(`(async () => {
          const t = await window.__app.editor.openFile(${J(BIG)});
          const alert = document.querySelector('#modal-mask:not(.hidden) .modal-body, #modal-mask:not(.hidden) .modal');
          return { kind: t && t.kind ? t.kind : null, maxMB: window.__app.state.settings.maxFileSizeMB,
            alert: alert ? alert.textContent.slice(0, 80) : null };
        })()`);
        const opened = await waitFor(`(() => { const t = window.__app.editor.getActiveTab(); return t && t.kind === 'huge' ? t.kind : null; })()`, (v) => v === 'huge', 30000);
        push('openHuge', opened === 'huge', 'ms=' + (Date.now() - t0) + ' size=' + bigSize + ' ret=' + J(openRet));

        if (opened !== 'huge') {
          // 打开失败时后续 huge 步骤全部跳过（不浪费各自的长超时），直接跑长行用例
          for (const n of ['coldOpenPlaceholder', 'indexBuilt', 'scrollToBottom', 'dragSweep', 'selectText', 'copySelection', 'typeToEdit', 'saveHuge4g5']) {
            push(n, 'SKIP: openHuge 未通过');
          }
        } else {

        // 2. 冷打开不假死：索引未就绪时有占位行、滚动条可拖动（隔离 profile → 侧车冷，必走全量扫）
        const cold = await ev(`(() => {
          const root = document.querySelector('.huge-view');
          if (!root) return { root: false };
          const rows = root.querySelector('.huge-rows');
          const sizer = root.querySelector('.huge-sizer');
          const st = ${ST};
          root.scrollTop = 1234567;
          return { placeholder: !!(rows && rows.querySelector('.huge-placeholder')), indexed: !!(st && st.indexed),
            sizerH: sizer ? sizer.offsetHeight : 0, scrollLive: root.scrollTop > 0 };
        })()`);
        push('coldOpenPlaceholder', !!(cold && (cold.placeholder || cold.indexed) && cold.sizerH > 0 && cold.scrollLive), J(cold));

        // 3. 索引就绪（冷扫 4.5GB，宽限 240s）
        const idxT0 = Date.now();
        const idx = await waitFor(`(() => { const st = ${ST}; return st && st.indexed ? { indexed: true, lines: st.lines } : null; })()`, (v) => !!v, 240000, 1000);
        const idxMs = Date.now() - idxT0;
        push('indexBuilt', !!(idx && idx.lines > 1000000), 'ms=' + idxMs + ' lines=' + (idx && idx.lines));
        const totalLines = idx && idx.lines ? idx.lines : 1;

        // 4. 直达文件尾：末行内容出现在视口
        await ev(`(async () => { const hv = ${HV}; if (hv) await hv.gotoLine(${totalLines}); return true; })()`);
        const atTail = await waitFor(`(() => { const rows = document.querySelector('.huge-view .huge-rows'); return rows ? rows.innerText : ''; })()`,
          (t) => typeof t === 'string' && t.indexOf(tailToken) >= 0, 30000, 500);
        push('scrollToBottom', typeof atTail === 'string' && atTail.indexOf(tailToken) >= 0, 'tailToken=' + tailToken);

        // 5. 连续下拖不卡：80%→100% 每步 2%，全部落定后统计墙钟与末批耗时
        const sweepT0 = Date.now();
        for (let p = 80; p <= 100; p += 2) {
          await ev(`(async () => { const hv = ${HV}; if (hv) await hv.scrollToPercent(${p}); return true; })()`);
        }
        const sweepEnd = await waitFor(`(() => { const st = ${ST}; return st && st.firstLine ? { first: st.firstLine, lines: st.lines, batchMs: st.lastBatch.ms } : null; })()`,
          (v) => v && v.first >= v.lines * 0.97, 30000, 300);
        push('dragSweep', !!(sweepEnd && sweepEnd.first >= sweepEnd.lines * 0.97),
          'sweepMs=' + (Date.now() - sweepT0) + ' lastBatchMs=' + (sweepEnd && sweepEnd.batchMs) + ' first=' + (sweepEnd && sweepEnd.first) + '/' + (sweepEnd && sweepEnd.lines));

        // 6. 文本可选中：user-select 放行 + Range 跨两行选出文本
        const sel = await ev(`(() => {
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
        push('selectText', !!(sel && sel.cs === 'text' && sel.len > 20), J(sel));

        // 7. Ctrl+C 复制闭环：渲染端 handler → api.writeClipboardText → 主进程读回剪贴板
        await ev(`(() => { const root = document.querySelector('.huge-view'); root.focus();
          root.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
        await sleep(800);
        const clip = clipboard.readText();
        push('copySelection', !!(clip && sel && sel.head && clip.indexOf(sel.head) >= 0), 'clipHead=' + J(clip.slice(0, 40)));

        // 8. 键入即编辑：首键开会话、次键落字（v0.7.0 口径），光标落在视口首行
        await ev(`(async () => { const hv = ${HV}; if (hv) await hv.gotoLine(1000); return true; })()`);
        await sleep(600);
        await ev(`(() => { const root = document.querySelector('.huge-view'); root.focus();
          root.dispatchEvent(new KeyboardEvent('keydown', { key: '7', code: 'Digit7', bubbles: true, cancelable: true })); return true; })()`);
        const editOn = await waitFor(`(() => { const st = ${ST}; return st && st.editable === true ? { editable: true, docEditable: st.docEditable, reason: st.editableReason } : null; })()`, (v) => !!v, 15000, 300);
        await ev(`(() => { const root = document.querySelector('.huge-view');
          root.dispatchEvent(new KeyboardEvent('keydown', { key: '7', code: 'Digit7', bubbles: true, cancelable: true })); return true; })()`);
        const typed = await waitFor(`(() => { const st = ${ST};
          return st && st.dirty === true && st.caret && Math.abs(st.caret.line - 1000) <= 5
            ? { caretLine: st.caret.line, dirtyCount: st.dirtyCount } : null; })()`, (v) => !!v, 15000, 300);
        push('typeToEdit', !!(editOn && typed), 'editOn=' + J(editOn) + ' typed=' + J(typed));

        // 9. 保存 4.5GB 落盘 + 主进程流式复核标记唯一
        const saveT0 = Date.now();
        await ev(`(async () => { const hv = ${HV}; if (hv) await hv.save(); return true; })()`);
        const savedState = await waitFor(`(() => { const st = ${ST}; return st && st.saving === false && st.dirty === false ? true : null; })()`, (v) => v === true, 300000, 1000);
        const saveMs = Date.now() - saveT0;
        const markCount = savedState === true ? await countOccurrences(BIG, '7line ') : -1;
        push('saveHuge4g5', savedState === true && markCount === 1, 'saveMs=' + saveMs + ' markCount=' + markCount);

        } // end if (opened === 'huge')

        // 10. 长行 1GB（旧 32MB 单块上限拒编）：新 128MB 上限下可编辑 + 保存往返
        await ev(`(async () => { await window.__app.editor.openFile(${J(LONGLINE)}); return true; })()`);
        await waitFor(`(() => { const t = window.__app.editor.getActiveTab(); return t && t.kind === 'huge' && t.huge && t.huge.getState().indexed ? true : null; })()`, (v) => v === true, 120000, 800);
        const onLong = await ev(`(async () => { const hv = ${HV}; if (!hv) return false; return await hv.setEditable(true); })()`);
        let longRoundtrip = false;
        let longSaveMs = -1;
        if (onLong === true) {
          await ev(`(async () => { const hv = ${HV}; if (hv) await hv.gotoLine(500); return true; })()`);
          await sleep(500);
          // 注意：此时 4.5GB 标签也开着，DOM 里有两个 .huge-view —— 必须取**可见**的那个
          // （非活动标签宿主 display:none，querySelector 单选会拿到 4.5GB 的隐藏视图，首跑踩过）
          await ev(`(() => { const root = Array.from(document.querySelectorAll('.huge-view')).find((el) => el.offsetParent !== null);
            if (!root) return false; root.focus();
            root.dispatchEvent(new KeyboardEvent('keydown', { key: '8', code: 'Digit8', bubbles: true, cancelable: true })); return true; })()`);
          const dirty8 = await waitFor(`(() => { const st = ${ST}; return st && st.dirty === true ? true : null; })()`, (v) => v === true, 15000, 300);
          if (dirty8 === true) {
            const t8 = Date.now();
            await ev(`(async () => { const hv = ${HV}; if (hv) await hv.save(); return true; })()`);
            longSaveMs = Date.now() - t8;
            longRoundtrip = (await countOccurrences(LONGLINE, '8longline ')) === 1;
          }
        }
        push('longlineEditable', onLong === true && longRoundtrip, 'setEditable=' + J(onLong) + ' saveMs=' + longSaveMs);

        // 11. 内存证据（信息）
        const heap = await ev(`(performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`);
        push('heapMB', heap > 0 && heap < 2048, 'heapMB=' + heap);
      }
    } catch (err) {
      console.error('PROBE_ERROR', err && err.stack ? err.stack : String(err));
      results.push(['PROBE_ERROR', 'ERR', String(err && err.message || err)]);
    } finally {
      console.log('PROBE_RESULTS');
      for (const r of results) console.log('  -', r.join(' | '));
      const fails = results.filter((r) => r[1] !== 'true' && r[1].indexOf('SKIP') !== 0).length;
      process.exitCode = fails > 0 ? 1 : 0;
      setTimeout(() => { console.log('BIGPROBE_DONE fails=' + fails); app.quit(); }, 400);
    }
  });
}

module.exports = { run };
