// AI 大模型接口：OpenAI 兼容 /chat/completions（function calling 工具循环）
const { ipcMain } = require('electron');
const { getSettings } = require('./settings');

let abortController = null;
let pendingToolResolve = null;

// 工具定义（OpenAI function schema）
const TOOLS = [
  { type: 'function', function: { name: 'read_document', description: '读取当前打开的文档全文', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'replace_selection', description: '替换当前文档选中的文字', parameters: { type: 'object', properties: { text: { type: 'string', description: '新文本' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'insert_text', description: '在光标处插入文字', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'replace_document', description: '替换整个文档内容', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'search_documents', description: '在当前工作目录全局搜索关键词', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'create_file', description: '在工作目录新建文件', parameters: { type: 'object', properties: { name: { type: 'string', description: '文件名（含扩展名）' }, content: { type: 'string', description: '文件内容' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'create_dir', description: '在工作目录新建目录', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'open_file', description: '打开工作目录中的文件（支持所有可显示类型）', parameters: { type: 'object', properties: { name: { type: 'string', description: '文件名或相对路径' } }, required: ['name'] } } },
];

function registerAiIpc(getWindow) {
  ipcMain.handle('ai:chat', async (_e, payload) => {
    const { messages, baseUrl, model } = payload || {};
    // S5：API Key 一律从主进程设置（safeStorage 解密）读取，忽略渲染进程传入值
    const s = getSettings();
    const apiKey = s._aiKeyPlain || '';
    if (!apiKey) throw new Error('未配置 API Key，请在「设置 → AI 模型」中填写');
    if (!messages || !messages.length) throw new Error('消息为空');

    // S5：校验服务地址：仅允许 https:// 或 http 回环地址（localhost / 127.0.0.1），防止 SSRF
    // 回环前缀必须紧跟端口或路径边界，避免 http://localhost.evil.com 之类绕过
    const url = (baseUrl || s.aiBaseUrl || '').trim().replace(/\/+$/, '');
    const isLoopbackHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(url);
    if (!/^https:\/\//i.test(url) && !isLoopbackHttp) {
      throw new Error('服务地址不合法：仅允许 https:// 或 http://localhost / http://127.0.0.1 开头的地址');
    }
    const apiUrl = url + '/chat/completions';
    abortController = new AbortController();
    const win = getWindow();
    const current = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      let totalUsage = null;
      for (let round = 0; round < 12; round++) {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ model: model || 'deepseek-chat', messages: current, tools: TOOLS, tool_choice: 'auto' }),
          signal: abortController.signal,
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`API 错误 ${resp.status}：${text.slice(0, 300)}`);
        }
        const data = await resp.json();
        if (data.usage) {
          totalUsage = totalUsage
            ? {
                prompt_tokens: totalUsage.prompt_tokens + data.usage.prompt_tokens,
                completion_tokens: totalUsage.completion_tokens + data.usage.completion_tokens,
                total_tokens: totalUsage.total_tokens + data.usage.total_tokens,
              }
            : data.usage;
        }
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        if (!msg) throw new Error('AI 返回为空');

        if (msg.tool_calls && msg.tool_calls.length) {
          // 记录 assistant 的 tool_calls，交给渲染进程执行
          current.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
          const results = await new Promise((resolve) => {
            pendingToolResolve = resolve;
            win.webContents.send('ai:tool-call', { calls: msg.tool_calls });
          });
          for (const r of results || []) {
            current.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result !== undefined ? r.result : r.error) });
          }
        } else {
          return { content: msg.content || '', usage: totalUsage };
        }
      }
      return { content: '（工具调用轮次过多，已停止）', usage: totalUsage };
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      throw aborted ? new Error('已终止') : err;
    } finally {
      abortController = null;
      pendingToolResolve = null;
    }
  });

  ipcMain.handle('ai:abort', async () => {
    if (abortController) {
      abortController.abort();
      // 若有挂起的工具等待，立即解除
      if (pendingToolResolve) {
        pendingToolResolve([]);
        pendingToolResolve = null;
      }
      return true;
    }
    return false;
  });

  // 渲染进程执行完工具后回传结果
  ipcMain.handle('ai:tool-result', async (_e, results) => {
    if (pendingToolResolve) {
      pendingToolResolve(results);
      pendingToolResolve = null;
    }
    return true;
  });
}

module.exports = { registerAiIpc };
