// Python 运行面板
import { $, escapeHtml, toast } from './ui.js';

export function createPythonPanel(getTab, getSettings) {
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
    let excess = output.childElementCount + frag.childElementCount - 3000;
    while (excess > 0) {
      output.removeChild(output.firstChild);
      excess--;
    }
    output.appendChild(frag);
    output.scrollTop = output.scrollHeight; // 批末一次（整批内仅一次强制 layout）
  }

  window.api.onPythonStart(({ interpreter, file }) => {
    running = true;
    killBtn.disabled = false;
    append(`\n$ ${interpreter} ${file}\n`, 'sys');
    setStatus('运行中…', 'running');
  });

  window.api.onPythonOutput(({ stream, data }) => {
    append(data, stream === 'stderr' ? 'stderr' : '');
  });

  window.api.onPythonExit(({ code, duration, error }) => {
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
      toast('请先打开一个 Python 文件');
      return;
    }
    const name = tab.name.toLowerCase();
    if (!name.endsWith('.py')) {
      toast('当前文件不是 .py，无法运行');
      return;
    }
    if (running) {
      toast('已有程序在运行，请先终止');
      return;
    }
    // 先保存当前内容再运行
    try {
      await window.api.writeFile(tab.path, tab.state.doc.toString());
      tab.dirty = false;
    } catch (err) {
      toast(`保存失败：${err.message || err}`);
      return;
    }
    const settings = getSettings();
    const pythonPath = (settings.pythonPath || '').trim();
    setStatus('启动中…', 'running');
    try {
      await window.api.runPython(tab.path, pythonPath || undefined);
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
