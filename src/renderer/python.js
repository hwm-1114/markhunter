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

  function append(text, cls = '') {
    if (output.childElementCount > 3000) {
      output.removeChild(output.firstChild);
    }
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    output.appendChild(span);
    output.scrollTop = output.scrollHeight;
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
