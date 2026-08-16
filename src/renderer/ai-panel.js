// AI 助手侧栏：OpenAI 兼容大模型对话 + function calling 工具操控
import MarkdownIt from 'markdown-it';
import { $, openModal, closeModal } from './ui.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const SYSTEM_PROMPT =
  '你是一个文档助手，可以阅读、总结、解释和修改文档，也可以通过工具操作 MarkHunter 编辑器（读文档、替换选中、插入文字、替换全文、搜索、新建文件/目录、打开文件）。修改文档前按用户设置决定是否询问。回答用中文。';

export function createAiPanel(getEditor, getSettings, onApplySnippet, executeTool) {
  const panel = $('#ai-panel');
  const messagesEl = $('#ai-messages');
  const input = $('#ai-input');
  const btnSend = $('#btn-ai-send');
  const btnStop = $('#btn-ai-stop');
  const btnFull = $('#btn-ai-full');
  const btnSel = $('#btn-ai-sel');

  const history = [];       // { role, content }
  let streaming = false;
  let pendingContext = '';
  let pendingLabel = '';

  function fmtTokens(n) {
    if (!n && n !== 0) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  const TYPE_LABELS = { latest: '最新版', reasoner: '推理版', custom: '自定义' };

  function render() {
    const s = getSettings();
    // 模型（中文类型 + 具体模型名）+ 会话累计用量徽标
    const badge = $('#ai-model-badge');
    let totP = 0;
    let totC = 0;
    for (const m of history) {
      if (m.usage) {
        totP += m.usage.prompt_tokens || 0;
        totC += m.usage.completion_tokens || 0;
      }
    }
    const typeLabel = TYPE_LABELS[s.aiModelType] || '最新版';
    badge.textContent = `${typeLabel} · ${s.aiModel || 'deepseek-chat'} · ↑${fmtTokens(totP)} ↓${fmtTokens(totC)}`;
    badge.title = `点击切换模型；会话累计 tokens：输入 ${totP}，输出 ${totC}`;
    badge.classList.add('clickable');

    messagesEl.innerHTML = '';
    for (const m of history) {
      const row = document.createElement('div');
      row.className = `ai-msg ${m.role}`;
      const head = document.createElement('div');
      head.className = 'ai-msg-head';
      head.textContent = m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'AI';
      row.appendChild(head);
      const body = document.createElement('div');
      body.className = 'ai-msg-body';
      if (m.role === 'ai') {
        body.innerHTML = md.render(m.content || '（思考中…）');
      } else {
        body.textContent = m.content;
      }
      row.appendChild(body);
      if (m.role === 'ai' && m.usage) {
        const usage = document.createElement('div');
        usage.className = 'ai-msg-usage';
        usage.textContent = `本次 ↑${fmtTokens(m.usage.prompt_tokens)} ↓${fmtTokens(m.usage.completion_tokens)} tokens`;
        row.appendChild(usage);
      }
      if (m.role === 'ai' && m.content) {
        const apply = document.createElement('button');
        apply.className = 'tbtn small ai-apply';
        apply.textContent = '📥 写入文档';
        apply.addEventListener('click', () => onApplySnippet(m.content));
        row.appendChild(apply);
      }
      messagesEl.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, content) {
    const m = { role, content };
    history.push(m);
    render();
    return m;
  }

  function buildMessages(ctx, label, userText) {
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (ctx) msgs.push({ role: 'user', content: `以下是当前文档${label}的内容：\n\n${ctx}` });
    for (const h of history.slice(-10)) {
      msgs.push({ role: h.role === 'ai' ? 'assistant' : h.role, content: h.content });
    }
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }

  async function send(text) {
    const t = (text || input.value).trim();
    if (!t || streaming) return;
    const s = getSettings();
    if (!s.aiApiKeySet) { // S5：渲染进程拿不到明文，用 aiApiKeySet 判断是否已配置
      addMessage('system', '⚠ 未配置 API Key：请点击「⚙ 设置」，在「AI 模型」区填写 DeepSeek 或其他服务的 API Key。');
      return;
    }
    input.value = '';
    const ctx = pendingContext;
    const label = pendingLabel;
    const msgs = buildMessages(ctx, label, t);
    pendingContext = '';
    pendingLabel = '';
    addMessage('user', ctx ? `[附加${label}] ${t}` : t);
    const aiMsg = addMessage('ai', '');
    streaming = true;
    btnSend.disabled = true;
    btnStop.disabled = false;

    try {
      // S5：apiKey 不再由渲染进程传入，主进程从加密设置中读取
      const res = await window.api.aiChat({
        messages: msgs,
        baseUrl: s.aiBaseUrl,
        model: s.aiModel,
      });
      aiMsg.content = res.content || '（无回复）';
      aiMsg.usage = res.usage || null;
    } catch (err) {
      aiMsg.content = '⚠ 请求失败：' + (err.message || err);
    } finally {
      streaming = false;
      btnSend.disabled = false;
      btnStop.disabled = true;
      render();
    }
  }

  // 工具调用：AI 要求执行工具 → 执行 → 回传结果
  window.api.onAiToolCall(async ({ calls }) => {
    const results = [];
    for (const call of calls || []) {
      const name = call.function && call.function.name;
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* 参数解析失败按空对象 */
      }
      try {
        const result = await executeTool(name, args);
        results.push({ id: call.id, result });
      } catch (err) {
        results.push({ id: call.id, error: String(err && err.message ? err.message : err) });
      }
    }
    await window.api.aiToolResult(results);
  });

  // ---------- 事件 ----------
  // 徽标点击：切换模型（中文选项，垂直菜单排版）
  $('#ai-model-badge').addEventListener('click', () => {
    const s = getSettings();
    const body = document.createElement('div');
    body.className = 'ai-model-menu';
    const pick = async (type, model) => {
      const cur = getSettings();
      cur.aiModelType = type;
      cur.aiModel = model;
      await window.api.setSettings({ aiModelType: type, aiModel: model });
      closeModal();
      render();
    };
    const mkItem = (label, desc, type, model, isCur) => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'ai-model-item' + (isCur ? ' current' : '');
      const t = document.createElement('span');
      t.className = 'ai-model-item-name';
      t.textContent = label + (isCur ? '（当前）' : '');
      const d = document.createElement('span');
      d.className = 'ai-model-item-desc';
      d.textContent = desc;
      it.append(t, d);
      it.addEventListener('click', () => {
        if (type === 'custom') {
          closeModal();
          window.dispatchEvent(new CustomEvent('markhunter:open-settings'));
        } else {
          pick(type, model);
        }
      });
      return it;
    };
    body.append(
      mkItem('最新版', '官方最新对话模型 · deepseek-chat（可在设置改具体版本）', 'latest', 'deepseek-chat', s.aiModelType === 'latest'),
      mkItem('推理版', '深度推理模型 · deepseek-reasoner', 'reasoner', 'deepseek-reasoner', s.aiModelType === 'reasoner'),
      mkItem('自定义…', '去设置填写具体模型名（如 deepseek-v4）', 'custom', null, s.aiModelType === 'custom')
    );
    openModal({
      title: '选择 AI 模型',
      body,
      actions: [{ label: '取消', onClick: closeModal }],
    });
  });

  btnSend.addEventListener('click', () => send());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  btnStop.addEventListener('click', () => window.api.aiAbort());
  btnFull.addEventListener('click', () => {
    const tab = getEditor().getActiveTab();
    if (!tab || !tab.state) {
      input.placeholder = '⚠ 当前无文档';
      return;
    }
    pendingContext = tab.state.doc.toString();
    pendingLabel = `（${tab.name} 全文）`;
    input.placeholder = `已附加 ${tab.name} 全文，可直接提问`;
  });
  btnSel.addEventListener('click', () => {
    const view = getEditor().getView();
    const sel = view.state.selection.main;
    const text = view.state.doc.sliceString(sel.from, sel.to);
    if (!text) {
      input.placeholder = '⚠ 未选中文字';
      return;
    }
    pendingContext = text;
    pendingLabel = '（选中内容）';
    input.placeholder = '已附加选中内容，可直接提问';
  });

  btnStop.disabled = true;
  render();

  return {
    toggle: () => panel.classList.toggle('hidden'),
    isOpen: () => !panel.classList.contains('hidden'),
    focus: () => {
      panel.classList.remove('hidden');
      input.focus();
    },
  };
}
