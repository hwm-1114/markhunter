// Python 运行面板
import { $, escapeHtml, toast } from './ui.js';

/** @param {(tab: object) => Promise<boolean>} [onSave] 运行前保存当前文件的回调（复用 editor.saveNow：
 *  正确处理大文件分段补读与占位标记剥离）；缺省时退回直接 writeFile（仅小文件安全）。 */
export function createPythonPanel(getTab, getSettings, onSave) {
  const output = $('#py-output');
  const status = $('#py-status');
  const panel = $('#panel-python');
  const killBtn = $('#btn-py-kill');
  const clearBtn = $('#btn-py-clear');

  let running = false;

  function setStatus(text, cls = '') {
    status.textContent = text;
    status.className = `py-status ${cls}`;
  }

  // P4（v0.1.45）：批渲染 —— 主进程已按 ~60ms/4KB 聚合输出（每条 IPC 含多行），
  // 渲染端批内按行拆 span 用 DocumentFragment 一次追加，批末才设一次 scrollTop
  // （避免旧逻辑每 chunk 一次强制回流，实测 2000 chunk ≈ 2.37s 渲染线程冻结）；
  // 保留 3000 span 上限裁剪（先裁旧再追加）。
  let lastLineOpen = false; // 上一批以不完整行（无 \n 结尾）结束 → 本批首行需续接

  function append(text, cls = '') {
    if (!text) return;
    const frag = document.createDocumentFragment();
    const lines = String(text).split('\n');
    // Python stdout 是块缓冲：跨批可能截断长行 —— 上一批未完结时首行并入最后一个 span，保持渲染与逐 chunk 追加一致
    if (lastLineOpen && output.lastChild) {
      output.lastChild.textContent += lines[0];
      lines.shift();
    }
    lastLineOpen = !String(text).endsWith('\n');
    // span 为内联元素，行间需显式 \n 文本节点（.py-output 为 pre-wrap，渲染为换行）
    for (let i = 0; i < lines.length; i++) {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = lines[i];
      frag.appendChild(span);
      if (i < lines.length - 1) frag.appendChild(document.createTextNode('\n'));
    }
    if (frag.childElementCount === 0) return; // 纯续接、无新行
    // v0.3.0 上限裁剪修正：旧实现 `excess = 现有 + 本批 - 3000` 在本批行数 > 3000 时
    // 循环次数超过现有子节点数，removeChild(null) 抛 TypeError → 整批输出丢失
    // （实测 print 6000 行 → 面板只剩 3 个 span / 22 字符，看起来像"程序没输出"）。
    const MAX_SPANS = 3000;
    while (frag.childElementCount > MAX_SPANS) frag.removeChild(frag.firstChild); // 本批自身超限：只留最后 3000 行
    const excess = Math.min(
      output.childElementCount + frag.childElementCount - MAX_SPANS,
      output.childElementCount
    );
    for (let i = 0; i < excess; i++) output.removeChild(output.firstChild);
    output.appendChild(frag);
    output.scrollTop = output.scrollHeight; // 批末一次（整批内仅一次强制 layout）
  }

  let runToken = 0; // 最近一次运行序号（主进程 python:start 下发）：旧进程迟到的退出事件据此忽略

  window.api.onPythonStart(({ interpreter, file, token }) => {
    runToken = token === undefined ? runToken : token;
    running = true;
    killBtn.disabled = false;
    append(`\n$ ${interpreter} ${file}\n`, 'sys');
    setStatus('运行中…', 'running');
  });

  window.api.onPythonOutput(({ stream, data }) => {
    append(data, stream === 'stderr' ? 'stderr' : '');
  });

  window.api.onPythonExit(({ code, duration, error, token }) => {
    // 旧进程（被新一次运行 taskkill）的迟到退出：不要把新进程的"运行中"状态覆盖掉
    if (token !== undefined && token !== runToken) return;
    running = false;
    killBtn.disabled = true;
    if (error) {
      append(`\n[错误] ${error}\n`, 'stderr');
      setStatus('启动失败');
      return;
    }
    const secs = (duration / 1000).toFixed(2);
    const line = `\n[进程退出] 代码 ${code}　耗时 ${secs}s\n`;
    append(line, code === 0 ? 'ok' : 'stderr');
    setStatus(code === 0 ? `已完成（${secs}s）` : `退出码 ${code}（${secs}s）`, code === 0 ? 'running' : '');
  });

  async function run() {
    const tab = getTab();
    if (!tab) {
      toast('请先打开一个可运行文件（.py / .bat / .cmd）');
      return;
    }
    const name = tab.name.toLowerCase();
    const isBat = name.endsWith('.bat') || name.endsWith('.cmd');
    if (!name.endsWith('.py') && !isBat) {
      toast('当前文件不是 .py / .bat / .cmd，无法运行');
      return;
    }
    if (running) {
      toast('已有程序在运行，请先终止');
      return;
    }
    // 先保存当前内容再运行（经 editor.saveNow：chunked 标签先补齐分段并剥离 MH-CHUNKED 占位标记，
    // 防止标记写入 .py 造成语法错误 / 未加载部分被截断）
    if (onSave) {
      const ok = await onSave(tab);
      if (!ok) {
        toast('保存失败，已取消运行');
        return;
      }
    } else {
      try {
        await window.api.writeFile(tab.path, tab.state.doc.toString());
        tab.dirty = false;
      } catch (err) {
        toast(`保存失败：${err.message || err}`);
        return;
      }
    }
    // pythonPath 只对 .py 有意义（批处理由主进程交给 cmd.exe 执行）
    let pythonPath;
    if (!isBat) {
      const settings = getSettings();
      pythonPath = (settings.pythonPath || '').trim() || undefined;
    }
    setStatus('启动中…', 'running');
    try {
      await window.api.runPython(tab.path, pythonPath);
    } catch (err) {
      setStatus('启动失败');
      append(`\n[错误] ${err.message || err}\n`, 'stderr');
    }
  }

  killBtn.addEventListener('click', () => {
    window.api.killPython();
    append('\n[已请求终止]\n', 'sys');
  });

  clearBtn.addEventListener('click', () => {
    output.innerHTML = '';
  });

  return {
    run,
    focus: () => { panel.classList.remove('hidden'); },
    isRunning: () => running,
  };
}
