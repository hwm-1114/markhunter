// AI 大模型接口：OpenAI 兼容 /chat/completions（function calling 工具循环）
// v0.2.5：流式 SSE 输出（ai:chunk 事件打字机）+ 推理模型思考过程（reasoning_content）
// + 服务地址通用化（裸域名自动补 /v1；放行局域网 http，便于 Ollama/LM Studio/中转站）
// + ai:list-models（拉取 /models 列表，任意 OpenAI 兼容服务商可用）
const { ipcMain, BrowserWindow } = require('electron');
const { getSettings } = require('./settings');

let abortController = null;
let pendingToolResolve = null;
let pendingToolCalls = null; // 挂起等待执行的工具调用（abort 时合成「已终止」tool 消息，保持消息序列合法）

function winOf(e) {
  try {
    return BrowserWindow.fromWebContents(e.sender);
  } catch {
    return null;
  }
}

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

/** 服务地址规范化：去尾斜杠；裸域名（无路径）自动补 /v1 —— 兼容「用户直接粘贴 https://api.xx.com」的中转站用法。
 *  DeepSeek/OpenAI/硅基流动/Ollama/LM Studio 等均支持 /v1/chat/completions；用户自带的路径（如 /v1、/api/paas/v4）原样保留。 */
function deriveApiBase(rawUrl) {
  let u = String(rawUrl || '').trim().replace(/\/+$/, '');
  let pathname = '';
  try {
    pathname = new URL(u).pathname.replace(/\/+$/, '');
  } catch {
    throw new Error(`服务地址不合法：${u}`);
  }
  if (!pathname) u += '/v1';
  return u;
}

/** v0.2.5：http 放行范围从「仅本机回环」放宽到「本机 + 局域网私网 IP」——
 *  支持局域网 Ollama / LM Studio / 内网中转站（桌面应用自行配置自己的服务地址，SSRF 面无实质扩大）。 */
function isPrivateHttp(rawUrl) {
  try {
    const p = new URL(rawUrl);
    if (p.protocol !== 'http:') return false;
    const h = p.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const oct = m.slice(1).map(Number);
    if (oct.some((n) => n > 255)) return false;
    const [a, b] = oct;
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 127);
  } catch {
    return false;
  }
}

function assertAllowedUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (/^https:\/\//i.test(url)) return;
  if (isPrivateHttp(url)) return;
  throw new Error('服务地址不合法：仅允许 https:// 或本机/局域网 http 地址（localhost、127.x、10.x、192.168.x、172.16~31.x）');
}

/** 友好错误提示：把常见 HTTP 状态翻译成用户能直接行动的中文 */
function friendlyHttpError(status, text) {
  const brief = String(text || '').slice(0, 300);
  if (status === 401 || status === 403) return `API Key 无效或无权限（${status}）：请到「⚙ 设置」检查 Key 是否正确${brief ? '\n' + brief : ''}`;
  if (status === 404) return `接口不存在（404）：请检查服务地址是否需要以 /v1 结尾、模型名是否正确${brief ? '\n' + brief : ''}`;
  if (status === 429) return `请求过于频繁或额度不足（429）${brief ? '：' + brief : ''}`;
  return `API 错误 ${status}：${brief}`;
}

/** 解析一轮流式响应：SSE 逐块解析（兼容忽略 stream:true 直接回整体 JSON 的中转站）。
 *  回传 ai:chunk 事件（{text} 正文增量 / {reasoning} 思考增量），返回累积结果。 */
async function consumeStream(resp, win, acc) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let sseMode = null; // null=未判定 true=SSE false=整体 JSON
  let done = false;
  const handleChunk = (j) => {
    if (!j || typeof j !== 'object') return;
    if (j.usage) acc.usage = j.usage;
    const choice = j.choices && j.choices[0];
    if (!choice) return;
    const d = choice.delta || choice.message || {};
    if (d.reasoning_content) {
      acc.reasoning += d.reasoning_content;
      try { win.webContents.send('ai:chunk', { reasoning: d.reasoning_content }); } catch { /* 忽略 */ }
    }
    if (d.content) {
      acc.content += d.content;
      try { win.webContents.send('ai:chunk', { text: d.content }); } catch { /* 忽略 */ }
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index || 0;
        if (!acc.toolCalls[i]) acc.toolCalls[i] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc.toolCalls[i].id = tc.id;
        if (tc.function && tc.function.name) acc.toolCalls[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) acc.toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  };
  while (!done) {
    const { done: rdDone, value } = await reader.read();
    if (rdDone) break;
    raw += decoder.decode(value, { stream: true });
    if (sseMode === null) {
      const t = raw.replace(/^\uFEFF/, '').trimStart();
      if (!t) { raw = ''; continue; }
      sseMode = t.startsWith('data:') || t.startsWith(':') || t.startsWith('event:');
    }
    if (sseMode) {
      let idx;
      while ((idx = raw.indexOf('\n')) >= 0) {
        const line = raw.slice(0, idx).trim();
        raw = raw.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') { if (payload === '[DONE]') done = true; continue; }
        try { handleChunk(JSON.parse(payload)); } catch { /* 心跳/非 JSON 行忽略 */ }
      }
    }
    // 整体 JSON 模式：循环结束后统一解析（下方）
  }
  if (sseMode === null || sseMode === false) {
    const t = raw.trim();
    if (t) {
      try { handleChunk(JSON.parse(t)); } catch { /* 非 JSON 响应体忽略 */ }
    }
  }
}

function registerAiIpc(_getWindow) {
  ipcMain.handle('ai:chat', async (_e, payload) => {
    const { messages, baseUrl, model } = payload || {};
    // S5：API Key 一律从主进程设置（safeStorage 解密）读取，忽略渲染进程传入值
    const s = getSettings();
    const apiKey = s._aiKeyPlain || '';
    if (!apiKey) throw new Error('未配置 API Key，请在「设置 → AI 大模型」中填写');
    if (!messages || !messages.length) throw new Error('消息为空');

    // S5（v0.2.5 放宽）：https 任意地址；http 仅本机回环 + 局域网私网（Ollama/LM Studio/内网中转）
    const rawBase = (baseUrl || s.aiBaseUrl || '').trim();
    assertAllowedUrl(rawBase);
    const apiBase = deriveApiBase(rawBase);
    const apiUrl = apiBase + '/chat/completions';
    abortController = new AbortController();
    const win = winOf(_e); // v0.1.51：流式块与工具调用事件只发发起窗口
    const current = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      let totalUsage = null;
      for (let round = 0; round < 12; round++) {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          // stream_options 尽力请求用量统计：个别严格端点不认识该字段时由下方 400 提示兜底
          body: JSON.stringify({
            model: model || 'deepseek-chat',
            messages: current,
            tools: TOOLS,
            tool_choice: 'auto',
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: abortController.signal,
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(friendlyHttpError(resp.status, text));
        }
        const acc = { content: '', reasoning: '', toolCalls: [], usage: null };
        await consumeStream(resp, win, acc);
        if (acc.usage) {
          totalUsage = totalUsage
            ? {
                prompt_tokens: totalUsage.prompt_tokens + acc.usage.prompt_tokens,
                completion_tokens: totalUsage.completion_tokens + acc.usage.completion_tokens,
                total_tokens: totalUsage.total_tokens + acc.usage.total_tokens,
              }
            : acc.usage;
        }
        const toolCalls = acc.toolCalls.filter(Boolean);
        if (toolCalls.length) {
          // 记录 assistant 的 tool_calls（含思考过程，保持推理模型上下文完整），交给渲染进程执行
          const assistantMsg = { role: 'assistant', content: acc.content || '' };
          if (acc.reasoning) assistantMsg.reasoning_content = acc.reasoning;
          assistantMsg.tool_calls = toolCalls;
          current.push(assistantMsg);
          // abort 时合成「已终止」tool 消息而不是空数组：保证下一轮（若发生）消息序列合法
          const results = await new Promise((resolve) => {
            pendingToolResolve = resolve;
            pendingToolCalls = toolCalls;
            win.webContents.send('ai:tool-call', { calls: toolCalls });
          });
          pendingToolCalls = null;
          for (const call of toolCalls) {
            const r = (results || []).find((x) => x && x.id === call.id);
            current.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(r && r.result !== undefined ? r.result : (r && r.error) || '（无结果）'),
            });
          }
        } else {
          return { content: acc.content || '', reasoning: acc.reasoning || '', usage: totalUsage };
        }
      }
      return { content: '（工具调用轮次过多，已停止）', reasoning: '', usage: totalUsage };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /This operation was aborted/.test(String(err && err.message)));
      throw aborted ? new Error('已终止') : err;
    } finally {
      abortController = null;
      pendingToolResolve = null;
      pendingToolCalls = null;
    }
  });

  ipcMain.handle('ai:abort', async () => {
    if (abortController) {
      abortController.abort();
      // 若有挂起的工具等待，合成每个调用的「已终止」结果再解除（保持 tool 消息序列合法）
      if (pendingToolResolve) {
        const calls = pendingToolCalls || [];
        pendingToolResolve(calls.map((c) => ({ id: c.id, error: '（用户已终止）' })));
        pendingToolResolve = null;
        pendingToolCalls = null;
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
      pendingToolCalls = null;
    }
    return true;
  });

  // v0.2.5：拉取服务商模型列表（GET /models，任意 OpenAI 兼容端点；Ollama/LM Studio 无需 Key）
  ipcMain.handle('ai:list-models', async (_e, baseUrl) => {
    const s = getSettings();
    const apiKey = s._aiKeyPlain || '';
    const rawBase = (baseUrl || s.aiBaseUrl || '').trim();
    assertAllowedUrl(rawBase);
    const url = deriveApiBase(rawBase) + '/models';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(friendlyHttpError(resp.status, await resp.text()));
    const data = await resp.json();
    const ids = (Array.isArray(data) ? data : data.data || data.models || [])
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
      .filter((x) => typeof x === 'string' && x);
    ids.sort((a, b) => a.localeCompare(b));
    return ids;
  });
}

module.exports = { registerAiIpc };
