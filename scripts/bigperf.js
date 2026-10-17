// 大文件性能实测探针（--bigperf 模式，仅开发环境）
//
// 目的：把用户感知的「打开 / 连续下拉 / 搜索 / 选中复制 / 编辑 / 保存」逐段量化，
// 用于 5GB / 10GB 真实夹具的前后对比（对标 EmEditor 的流畅度）。
//
// 夹具（scripts/mkbigfile.js 生成，缺失则跳过该档）：
//   F:\mh-bigtest\perf5\mh-5gb.txt    5368709120 B / 41943040 行 / 128 B 定长行
//   F:\mh-bigtest\perf10\mh-10gb.txt 10737418240 B / 83886080 行
//   每 1000000 行有 `##### SECTION <n> ##### NEEDLE-5G` 标记（跳转/搜索哨兵），倒数第 1000 行有 TAIL。
//
// 运行：npm run bigperf（独立 userData profile，不污染真实配置）
// 判定：进程退出码 0 = 全部关键项跑通；明细见末尾 BIGPERF_RESULTS（每行 name | value | 证据）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, clipboard } = require('electron');

const BIG_DIR = process.env.MH_BIGTEST_DIR || 'F:\\mh-bigtest';
const OUT_JSON = path.join(BIG_DIR, 'bigperf-latest.json');
const MAX_MB = 20480; // 20GB：覆盖 10GB 夹具（产品侧默认上限另算）

const FILES = [
  {
    name: '5GB',
    file: path.join(BIG_DIR, 'perf5', 'mh-5gb.txt'),
    dir: path.join(BIG_DIR, 'perf5'),
    needle: 'SECTION 2000000',
    needleLine: 2000000,
    sections: [1000000, 2000000, 10000000, 20000000, 40000000],
  },
  {
    name: '10GB',
    file: path.join(BIG_DIR, 'perf10', 'mh-10gb.txt'),
    dir: path.join(BIG_DIR, 'perf10'),
    needle: 'SECTION 40000000',
    needleLine: 40000000,
    sections: [1000000, 2000000, 40000000, 80000000],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v === undefined ? null : v);

async function run(win) {
  const results = [];
  const push = (name, value, evidence) => {
    results.push({ name, value: String(value), evidence: evidence || '' });
    console.log('[bigperf]', name, '=', value, evidence ? '  ' + evidence : '');
  };

  const ev = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code, pred, ms = 60000, step = 100) => {
    const t0 = Date.now();
    let v = null;
    for (;;) {
      v = await ev(code).catch(() => null);
      if (v !== null && pred(v)) return v;
      if (Date.now() - t0 > ms) return v;
      await sleep(step);
    }
  };

  // 页面侧公共工具（每次注入都自带，避免跨调用状态）
  const PAGE_UTILS = `
    const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const __root = () => Array.from(document.querySelectorAll('.huge-view')).find((el) => el.offsetParent !== null) || document.querySelector('.huge-view');
    const __hv = () => { const t = window.__app.editor.getActiveTab(); return t && t.huge ? t.huge : null; };
    const __st = () => { const h = __hv(); return h ? h.getState() : null; };
    const __rowText = () => { const r = __root(); return r ? Array.from(r.querySelectorAll('.huge-rows .huge-line:not(.huge-placeholder) .huge-text')).map((x) => x.textContent) : []; };
    const __frameMeter = () => { const gaps = []; let last = performance.now(); let stop = false;
      const tick = () => { const n = performance.now(); gaps.push(n - last); last = n; if (!stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return { gaps, stop: () => { stop = true; } }; };
    const __pct = (arr, p) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] * 10) / 10; };
  `;

  win.webContents.on('did-finish-load', async () => {
    try {
      const existing = FILES.filter((f) => fs.existsSync(f.file));
      push('fixtures', existing.length ? existing.map((f) => f.name).join(',') : 'SKIP: 缺少夹具（node scripts/mkbigfile.js）');
      if (!existing.length) throw new Error('无夹具');

      // ---------- boot：放开上限（10GB 需要 > 5120MB）+ 把两个夹具目录设为侧栏根 ----------
      // （保存通道走 security.requireApproved：目标必须在某个侧栏根内，否则「路径不在当前工作目录内」）
      const boot = await ev(`(async () => {
        for (let i = 0; i < 100 && !window.__app; i++) await new Promise((r) => setTimeout(r, 100));
        if (!window.__app) return false;
        await window.api.setSettings({ maxFileSizeMB: ${MAX_MB} });
        window.__app.state.settings = await window.api.getSettings();
        ${PAGE_UTILS}
        for (const d of ${J(FILES.map((f) => f.dir))}) {
          try { await window.__app.openDirFromPath(d); } catch (e) { /* 目录不存在时忽略 */ }
        }
        return window.__app.state.settings.maxFileSizeMB;
      })()`);
      push('boot', boot === MAX_MB ? 'true' : String(boot), 'maxFileSizeMB=' + J(boot));

      for (const F of existing) {
        const gb = Math.round(fs.statSync(F.file).size / 1024 / 1024 / 1024);
        console.log('\n===== ' + F.name + ' (' + gb + ' GB) =====');

        // ---------- 1. 打开 → 首屏真实内容 → **索引建立期间连续下拉** → 索引就绪 ----------
        const opened = await ev(`(async () => {
          ${PAGE_UTILS}
          const t0 = performance.now();
          const tab = await window.__app.editor.openFile(${J(F.file)});
          const tOpen = performance.now() - t0;
          let tFirst = null, firstText = null, placeholderSeen = false;
          for (let i = 0; i < 6000; i++) {
            const r = __root();
            if (r && r.querySelector('.huge-placeholder')) placeholderSeen = true;
            const tx = r && r.querySelector('.huge-rows .huge-line:not(.huge-placeholder) .huge-text');
            if (tx && tx.textContent) { tFirst = performance.now() - t0; firstText = tx.textContent.slice(0, 48); break; }
            await __sleep(10);
          }
          // ---- 1b. 此刻索引一定还没就绪：连拖 5 个位置，量「滚到哪、多久出字」----
          for (let i = 0; i < 200 && (__st() ? __st().lines : 1) <= 1; i++) await __sleep(10); // 等估算行数撑起滚动条
          const rr = __root();
          const base = __st();
          const isScaled = base.lines * base.lineHeight > 16 * 1024 * 1024;
          const maxScroll = Math.max(1, (isScaled ? 16 * 1024 * 1024 : base.lines * base.lineHeight) - rr.clientHeight);
          const expectLine = (top) => isScaled ? Math.max(1, 1 + Math.round((top / maxScroll) * (base.lines - 1))) : Math.max(1, Math.floor(top / base.lineHeight) + 1);
          const tol = Math.max(2, Math.ceil(base.lines / (16 * 1024 * 1024)) + 1);
          const during = [];
          for (const pct of [10, 25, 50, 75, 90]) {
            rr.scrollTop = Math.floor(maxScroll * pct / 100);
            const tp = performance.now();
            const want = expectLine(rr.scrollTop);
            let ms = -1;
            for (let i = 0; i < 900; i++) {
              const s2 = __st();
              const rows = rr.querySelectorAll('.huge-rows .huge-line:not(.huge-placeholder) .huge-text');
              // 必须「DOM 已按目标位置重画」（rendered 落在目标附近）才算数 —— 只比 firstLine 会撞上
              // 滚动事件防抖 16ms 内的旧 DOM（首版实测全部 0ms 的假阳性）
              if (s2 && s2.rendered && want >= s2.rendered.from && want <= s2.rendered.to && rows.length > 3) {
                ms = Math.round(performance.now() - tp); break;
              }
              await __sleep(10);
            }
            const s3 = __st();
            during.push({ pct, ms, indexed: s3.indexed, firstLine: s3.firstLine, want });
          }
          rr.scrollTop = 0;
          await __sleep(120);
          let tIdx = null, lines = 0;
          for (let i = 0; i < 12000; i++) {
            const st = __st();
            if (st && st.indexed) { tIdx = performance.now() - t0; lines = st.lines; break; }
            await __sleep(10);
          }
          await __sleep(200);
          const st = __st();
          return { tOpen: Math.round(tOpen), tFirst: tFirst == null ? -1 : Math.round(tFirst), tIdx: tIdx == null ? -1 : Math.round(tIdx),
            during, firstText, placeholderSeen, lines, kind: tab && tab.kind, st, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1 };
        })()`);
        const st0 = opened && opened.st;
        push(F.name + '.openCall', opened && opened.kind === 'huge' ? (opened.tOpen + 'ms') : 'FAIL ' + J(opened && opened.kind));
        push(F.name + '.firstContent', opened && opened.tFirst >= 0 ? (opened.tFirst + 'ms') : 'FAIL', 'text=' + J(opened && opened.firstText) + ' placeholder=' + !!(opened && opened.placeholderSeen));
        push(F.name + '.indexReady', opened && opened.tIdx >= 0 ? (opened.tIdx + 'ms') : 'FAIL', 'lines=' + (opened && opened.lines));
        push(F.name + '.duringIndex', opened && opened.during && opened.during.every((x) => x.ms >= 0) ? 'true' : 'FAIL',
          ((opened && opened.during) || []).map((x) => x.pct + '%:' + x.ms + 'ms(first ' + x.firstLine + '/' + x.want + (x.indexed ? ',idx' : '') + ')').join(' '));
        push(F.name + '.renderStats', st0 ? ('renders=' + st0.perf.renders + ' max=' + st0.perf.maxRenderMs + 'ms') : 'FAIL',
          'batchMs=' + J(st0 && st0.lastBatch && st0.lastBatch.ms) + ' readTotal=' + (st0 && st0.perf && st0.perf.readMsTotal) + 'ms heapMB=' + (opened && opened.heapMB));

        if (!opened || opened.kind !== 'huge') {
          push(F.name + '.skipped', 'SKIP: 打开失败');
          continue;
        }

        // ---------- 2. 跳转（比例定位） ----------
        const jumps = await ev(`(async () => {
          ${PAGE_UTILS}
          const out = [];
          for (const line of ${J(F.sections)}) {
            const t0 = performance.now();
            await __hv().gotoLine(line);
            const ms = Math.round(performance.now() - t0);
            const st = __st();
            const text = __rowText().join('\\n');
            // v0.9.0 锚点断言：视口顶部那一行必须就是 getState().firstLine（旧实现恒定落后 2 屏）
            const r = __root();
            const vp = r.getBoundingClientRect();
            let domTop = null;
            for (const el of r.querySelectorAll('.huge-rows .huge-line')) {
              const b = el.getBoundingClientRect();
              if (b.top <= vp.top + 1 && b.bottom > vp.top + 1) { domTop = Number(el.dataset.line); break; }
            }
            out.push({ line, ms, firstLine: st && st.firstLine, domTop, hit: text.indexOf('SECTION ' + line) >= 0, batchMs: st && st.lastBatch && st.lastBatch.ms });
            await __sleep(50);
          }
          return out;
        })()`);
        // 比例映射（scaled）1px ≈ N 行：跳转落点允许 ±该量级的取整误差（目标行仍在视口内）
        const tol = Math.max(2, Math.ceil((opened.lines || 1) / (16 * 1024 * 1024)) + 1);
        const jumpFails = (jumps || []).filter((j) => !j.hit || Math.abs((j.firstLine || 0) - j.line) > tol ||
          (j.domTop != null && Math.abs(j.domTop - j.line) > tol));
        push(F.name + '.jump', jumpFails.length === 0 ? 'true' : 'FAIL',
          'tol=±' + tol + ' ' + (jumps || []).map((j) => j.line + ':' + j.ms + 'ms(ipc ' + j.batchMs + ',first ' + j.firstLine + ',dom ' + j.domTop + (j.hit ? ',hit' : ',MISS') + ')').join(' '));

        // ---------- 3. 连续拖动（模拟拖滚动条：10% → 95%，40 步 / 25ms） ----------
        const drag = await ev(`(async () => {
          ${PAGE_UTILS}
          const r = __root();
          const st = __st();
          const isScaled = st.lines * st.lineHeight > 16 * 1024 * 1024;
          const maxScroll = Math.max(1, (isScaled ? 16 * 1024 * 1024 : st.lines * st.lineHeight) - r.clientHeight);
          const expectLine = (top) => isScaled ? Math.max(1, 1 + Math.round((top / maxScroll) * (st.lines - 1))) : Math.max(1, Math.floor(top / st.lineHeight) + 1);
          const fm = __frameMeter();
          const t0 = performance.now();
          const steps = 40;
          for (let i = 1; i <= steps; i++) {
            const frac = 0.10 + (0.85 * i) / steps;
            r.scrollTop = Math.floor(maxScroll * frac);
            await __sleep(25);
          }
          const dragMs = performance.now() - t0;
          const target = expectLine(r.scrollTop);
          let settleMs = -1;
          for (let i = 0; i < 400; i++) {
            const s2 = __st();
            const rows = __rowText();
            if (s2 && Math.abs(s2.firstLine - target) <= 2 && rows.length && rows[0]) { settleMs = performance.now() - t0; break; }
            await __sleep(10);
          }
          fm.stop();
          await __sleep(100);
          const stEnd = __st();
          return { dragMs: Math.round(dragMs), settleMs: Math.round(settleMs), target, firstLine: stEnd && stEnd.firstLine,
            frames: fm.gaps.length, maxGap: __pct(fm.gaps, 0.999), p95Gap: __pct(fm.gaps, 0.95), renders: stEnd && stEnd.perf.renders,
            maxRenderMs: stEnd && stEnd.perf.maxRenderMs, sample: __rowText()[0] ? __rowText()[0].slice(0, 40) : null };
        })()`);
        const dragOk = drag && drag.settleMs >= 0 && Math.abs((drag.firstLine || 0) - drag.target) <= 2;
        push(F.name + '.dragSweep', dragOk ? 'true' : 'FAIL',
          'drag=' + (drag && drag.dragMs) + 'ms settle=' + (drag && drag.settleMs) + 'ms first=' + (drag && drag.firstLine) + '/' + (drag && drag.target) +
          ' frames=' + (drag && drag.frames) + ' maxGap=' + (drag && drag.maxGap) + ' p95=' + (drag && drag.p95Gap) + ' maxRender=' + (drag && drag.maxRenderMs) + 'ms');

        // ---------- 4. 滚轮连续下拽（60 notch / 16ms 间隔） ----------
        const wheel = await ev(`(async () => {
          ${PAGE_UTILS}
          const r = __root();
          const before = __st();
          const fm = __frameMeter();
          const t0 = performance.now();
          for (let i = 0; i < 60; i++) {
            r.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }));
            await __sleep(16);
          }
          const wheelMs = performance.now() - t0;
          await __sleep(400);
          fm.stop();
          const after = __st();
          return { wheelMs: Math.round(wheelMs), linesMoved: (after && after.firstLine) - (before && before.firstLine),
            frames: fm.gaps.length, maxGap: __pct(fm.gaps, 0.999), p95Gap: __pct(fm.gaps, 0.95),
            renders: (after && after.perf.renders) - (before && before.perf.renders), maxRenderMs: after && after.perf.maxRenderMs };
        })()`);
        push(F.name + '.wheel60', wheel ? 'true' : 'FAIL',
          'lines=' + (wheel && wheel.linesMoved) + ' frames=' + (wheel && wheel.frames) + ' maxGap=' + (wheel && wheel.maxGap) +
          ' p95=' + (wheel && wheel.p95Gap) + ' renders=' + (wheel && wheel.renders) + ' maxRender=' + (wheel && wheel.maxRenderMs) + 'ms');

        // ---------- 5. 大文件搜索（主进程 worker 全量扫） ----------
        const secLine = F.sections[1] || 1000000;
        const search = await ev(`(async () => {
          const t0 = performance.now();
          const res = await window.api.globalSearch(${J(F.dir)}, ${J(F.needle)});
          const ms = Math.round(performance.now() - t0);
          return { ms, n: res ? res.length : 0, first: res && res[0] ? { line: res[0].line, text: String(res[0].text).slice(0, 40) } : null };
        })()`);
        const searchOk = search && search.n > 0 && search.first && Math.abs(search.first.line - F.needleLine) <= 1;
        push(F.name + '.search', searchOk ? search.ms + 'ms' : 'FAIL',
          'hits=' + (search && search.n) + ' firstLine=' + (search && search.first && search.first.line) + '/' + F.needleLine);

        // ---------- 5b. 中文关键词（非 ASCII → 解码分片路径，v0.9.1） ----------
        const cjk = await ev(`(async () => {
          const t0 = performance.now();
          const res = await window.api.globalSearch(${J(F.dir)}, '不存在的关键词');
          return { ms: Math.round(performance.now() - t0), n: res ? res.length : -1 };
        })()`);
        push(F.name + '.searchCJK', cjk && cjk.ms > 0 && cjk.ms < 8000 ? cjk.ms + 'ms' : 'FAIL', 'hits=' + (cjk && cjk.n) + '（0 命中为预期，夹具为纯 ASCII；只计时解码扫描）');

        // ---------- 6. 选中 + Ctrl+C（主进程读回剪贴板；选中 SECTION 行，内容唯一可断言） ----------
        const sel = await ev(`(async () => {
          ${PAGE_UTILS}
          const hv = __hv();
          await hv.gotoLine(${secLine});
          await __sleep(200);
          const r = __root();
          const texts = Array.from(r.querySelectorAll('.huge-rows .huge-line .huge-text'));
          const idx = texts.findIndex((x) => x.textContent.indexOf('SECTION ${secLine}') >= 0);
          if (idx < 0) return { ok: false, rows: texts.length, sample: texts[0] ? texts[0].textContent.slice(0, 30) : null };
          const pick = texts.slice(Math.max(0, idx - 1), Math.min(texts.length, idx + 2));
          const range = document.createRange();
          const first = pick[0].firstChild || pick[0];
          const last = pick[pick.length - 1].firstChild || pick[pick.length - 1];
          range.setStart(first, 0);
          range.setEnd(last, last.length || 0);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
          const expect = String(s.toString());
          r.focus();
          r.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true }));
          return { ok: true, expect: expect.slice(0, 80), full: expect.length, hasSection: expect.indexOf('SECTION ${secLine}') >= 0 };
        })()`);
        const copyT0 = Date.now();
        let clipMs = -1;
        let clip = '';
        for (let i = 0; i < 500; i++) {
          clip = clipboard.readText();
          if (sel && sel.expect && clip.indexOf(sel.expect) >= 0) { clipMs = Date.now() - copyT0; break; }
          await sleep(2);
        }
        push(F.name + '.selectCopy', sel && sel.ok && sel.hasSection && clipMs >= 0 ? clipMs + 'ms' : 'FAIL',
          'chars=' + (sel && sel.full) + ' clipHead=' + J(clip.slice(0, 32)));

        // ---------- 7. 编辑：进入编辑态 + 10 次真实按键（键盘 → IPC → 视口回显）+ 10 次撤销 ----------
        const edit = await ev(`(async () => {
          ${PAGE_UTILS}
          const hv = __hv();
          const t0 = performance.now();
          const ok = await hv.setEditable(true);
          const openMs = Math.round(performance.now() - t0);
          if (!ok) return { ok: false, openMs, reason: __st() && __st().editableReason };
          // 跳到 SECTION 行：该行文本唯一，便于确认"回显的就是这一行"
          await hv.gotoLine(${secLine});
          await __sleep(250);
          const r = __root();
          r.focus();
          const keys = [];
          for (let i = 0; i < 10; i++) {
            const c0 = __st().caret;
            const before = c0 ? c0.textLength : -1;
            const tk = performance.now();
            r.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', bubbles: true, cancelable: true }));
            let ms = -1;
            for (let k = 0; k < 600; k++) {
              const c = __st().caret;
              if (c && before >= 0 && c.textLength === before + 1) { ms = performance.now() - tk; break; }
              if (c && before < 0 && c.line === ${secLine}) { ms = performance.now() - tk; break; }
              await __sleep(2);
            }
            keys.push(Math.round(ms));
          }
          const undo = [];
          for (let i = 0; i < 10; i++) {
            const t = performance.now();
            const rr = await hv.applyEditForTest({ type: 'undo' });
            undo.push({ ms: Math.round(performance.now() - t), ok: !!rr });
          }
          // 保存前留一处脏修改（否则 saveTo 走 skipped 分支，测不到真实写盘）
          const line = Math.max(1, (__st().firstLine || 1) + 1);
          const tDirty = performance.now();
          const rd = await hv.applyEditForTest({ type: 'insert', line, col: 0, text: 'S' });
          const dirtyMs = Math.round(performance.now() - tDirty);
          const s2 = __st();
          return { ok: true, openMs, keys, undo, dirtyMs, dirty: s2 && s2.dirty, docId: s2 && s2.docId, lines: s2 && s2.lines };
        })()`);
        const keyOk = edit && edit.keys && edit.keys.every((x) => x >= 0);
        const keyAvg = edit && edit.keys ? Math.round(edit.keys.reduce((a, b) => a + b, 0) / edit.keys.length) : -1;
        const keyMax = edit && edit.keys ? Math.max(...edit.keys) : -1;
        const undoAvg = edit && edit.undo ? Math.round(edit.undo.reduce((a, b) => a + b.ms, 0) / edit.undo.length) : -1;
        push(F.name + '.edit', edit && edit.ok && keyOk ? 'true' : 'FAIL',
          'docOpen=' + (edit && edit.openMs) + 'ms keyAvg=' + keyAvg + 'ms keyMax=' + keyMax + 'ms undoAvg=' + undoAvg + 'ms dirty=' + (edit && edit.dirty) + (edit && edit.reason ? ' reason=' + edit.reason : ''));

        // ---------- 8. 保存（另存为临时文件，夹具零改动）+ **保存期间仍可滚动**（v0.9.1） ----------
        const tmp = path.join(F.dir, '.perf-save-' + Date.now() + '.tmp');
        const baseSize = fs.statSync(F.file).size;
        const save = await ev(`(async () => {
          ${PAGE_UTILS}
          const st = __st();
          if (!st || st.docId == null) return { ok: false, why: 'no doc' };
          const hv = __hv();
          const r = __root();
          const t0 = performance.now();
          // 不 await：保存照样在跑，期间做 8 次跳转/滚动，量「视口取行是否被保存锁排队」
          const p = window.api.hugeDocSave({ docId: st.docId, target: ${J(tmp)} })
            .then((x) => ({ ok: !!(x && x.ok), r: x }))
            .catch((e) => ({ ok: false, err: String((e && e.message) || e) }));
          const jumps = [];
          const n = (st.lines || 1);
          for (let i = 0; i < 8; i++) {
            const line = Math.max(1, Math.round(n * (0.2 + (i % 4) * 0.15)));
            const tj = performance.now();
            await hv.gotoLine(line);
            jumps.push(Math.round(performance.now() - tj));
            await __sleep(40);
          }
          const out = await p;
          return {
            ok: out.ok, err: out.err, size: out.r && out.r.size, skipped: out.r && out.r.skipped,
            ms: Math.round(performance.now() - t0), jumps,
            jumpAvg: Math.round(jumps.reduce((a, b) => a + b, 0) / jumps.length),
            jumpMax: Math.max.apply(null, jumps),
            renders: __st().perf.renders, maxRender: __st().perf.maxRenderMs,
          };
        })()`);
        const tmpSize = fs.existsSync(tmp) ? fs.statSync(tmp).size : -1;
        push(F.name + '.save', save && save.ok && save.skipped !== true && tmpSize > baseSize ? save.ms + 'ms' : 'FAIL',
          'tmpSize=' + tmpSize + ' base=' + baseSize + ' (+1 行内字符) skipped=' + J(save && save.skipped) + ' err=' + J(save && save.err) +
          ' | 保存期间跳转 avg=' + (save && save.jumpAvg) + 'ms max=' + (save && save.jumpMax) + 'ms renders=' + (save && save.renders));
        // 保存期间视口读取不再排队：单次跳转必须远小于保存总耗时（旧实现会等到保存结束才返回）
        const saveScrollOk = !!(save && save.ok && save.jumpMax != null && save.jumpMax < Math.max(400, save.ms / 3));
        push(F.name + '.saveScroll', saveScrollOk ? 'true' : 'FAIL',
          'jumpAvg=' + (save && save.jumpAvg) + 'ms jumpMax=' + (save && save.jumpMax) + 'ms saveMs=' + (save && save.ms) + 'ms');

        // ---------- 9. 关标签（清场；先关再删另存文件，避免视图仍指向已删除目标） ----------
        await ev(`(async () => { ${PAGE_UTILS} window.__app.editor.closeAll(); await __sleep(600); return true; })()`);
        await sleep(300);
        try { if (tmpSize > 0) fs.unlinkSync(tmp); } catch { /* 忽略 */ }
        const heap = await ev(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`);
        push(F.name + '.heapMB', heap > 0 ? heap : 'n/a', 'mainRssMB=' + Math.round(process.memoryUsage().rss / 1048576));
      }

      // ---------- 11. 自动换行 + 滚动锚点（1GB 长行夹具；缺失自动 SKIP） ----------
      const LONGLINE = path.join(BIG_DIR, 'mh-longline-1gb.txt');
      if (fs.existsSync(LONGLINE)) {
        const wr = await ev(`(async () => {
          ${PAGE_UTILS}
          await window.__app.editor.openFile(${J(LONGLINE)});
          const t = window.__app.editor.getActiveTab();
          for (let i = 0; i < 6000; i++) { const st = t.huge && t.huge.getState(); if (st && st.indexed) break; await __sleep(20); }
          await __sleep(350);
          const r = __root();
          const rowH = () => { const el = r.querySelector('.huge-rows .huge-line'); return el ? Math.round(el.getBoundingClientRect().height) : -1; };
          const lh = __st().lineHeight;
          const onH = rowH();
          const btn = Array.from(r.querySelectorAll('.huge-status .huge-btn')).find((x) => x.textContent.indexOf('自动换行') >= 0);
          if (!btn) return { ok: false, why: 'no wrap button' };
          const waitSetting = async (v) => {
            for (let i = 0; i < 60; i++) { const s = await window.api.getSettings(); if ((s.wordWrap !== false) === v) return true; await __sleep(20); }
            return false;
          };
          btn.click();
          await __sleep(450);
          const offH = rowH(), offWrap = __st().wrap;
          const persistedOff = await waitSetting(false); // 开关要回写应用级设置（wordWrap=false 落盘）
          btn.click();
          await __sleep(450);
          const onH2 = rowH(), onWrap = __st().wrap;
          const persistedOn = await waitSetting(true);
          const vp = r.getBoundingClientRect();
          let domTop = null;
          for (const el of r.querySelectorAll('.huge-rows .huge-line')) {
            const b = el.getBoundingClientRect();
            if (b.top <= vp.top + 1 && b.bottom > vp.top + 1) { domTop = Number(el.dataset.line); break; }
          }
          const st = __st();
          return { ok: true, lh, onH, offH, offWrap, onH2, onWrap, persistedOff, persistedOn, domTop, stateFirst: st.firstLine, rendered: st.rendered, lines: st.lines };
        })()`);
        const wrapOk = !!(wr && wr.ok && wr.onH > wr.lh * 1.5 && wr.offH === wr.lh && wr.offWrap === false && wr.onWrap === true &&
          wr.persistedOff === true && wr.persistedOn === true &&
          wr.domTop != null && Math.abs(wr.domTop - wr.stateFirst) <= 1);
        push('wrapToggle', wrapOk ? 'true' : 'FAIL', JSON.stringify(wr));
        await ev(`(async () => { ${PAGE_UTILS} window.__app.editor.closeAll(); await __sleep(500); return true; })()`);
        await sleep(200);
      } else {
        push('wrapToggle', 'SKIP: 缺少 mh-longline-1gb.txt（node scripts/mkbigfile.js 不生成该夹具）');
      }

      // ---------- 10. 二次打开（侧车缓存命中） ----------
      const first = existing[0];
      const reopen = await ev(`(async () => {
        ${PAGE_UTILS}
        const t0 = performance.now();
        await window.__app.editor.openFile(${J(first.file)});
        let tFirst = -1;
        for (let i = 0; i < 3000; i++) {
          const tx = __root() && __root().querySelector('.huge-rows .huge-line:not(.huge-placeholder) .huge-text');
          if (tx && tx.textContent) { tFirst = Math.round(performance.now() - t0); break; }
          await __sleep(5);
        }
        let tIdx = -1;
        for (let i = 0; i < 3000; i++) { const st = __st(); if (st && st.indexed) { tIdx = Math.round(performance.now() - t0); break; } await __sleep(5); }
        return { tFirst, tIdx, cached: __st() && __st().indexed };
      })()`);
      push('reopen.' + first.name, reopen && reopen.tIdx >= 0 ? 'true' : 'FAIL', 'first=' + (reopen && reopen.tFirst) + 'ms indexed=' + (reopen && reopen.tIdx) + 'ms');
    } catch (err) {
      console.error('BIGPERF_ERROR', err && err.stack ? err.stack : String(err));
      push('PROBE_ERROR', 'ERR', String(err && err.message || err));
    } finally {
      const fails = results.filter((r) => r.value === 'FAIL' || r.value === 'ERR' || r.value.indexOf('FAIL') === 0).length;
      console.log('\nBIGPERF_RESULTS');
      for (const r of results) console.log('  - ' + r.name + ' | ' + r.value + ' | ' + r.evidence);
      try {
        fs.writeFileSync(OUT_JSON, JSON.stringify({ at: new Date().toISOString(), files: FILES.map((f) => f.name), results }, null, 2), 'utf8');
        console.log('JSON ->', OUT_JSON);
      } catch { /* 忽略 */ }
      console.log('BIGPERF_DONE fails=' + fails);
      process.exitCode = fails > 0 ? 1 : 0;
      setTimeout(() => app.quit(), 500);
    }
  });
}

module.exports = { run };
