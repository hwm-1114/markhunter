// AI 助手侧栏：OpenAI 兼容大模型对话 + function calling 工具操控
// v0.2.5：流式输出（打字机）、推理模型思考过程折叠显示、清空对话、
//          请求失败自动恢复附加上下文、模型徽标菜单通用化（任意服务商/中转站）
import MarkdownIt from 'markdown-it';
import { $, openModal, closeModal, toast } from './ui.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const SYSTEM_PROMPT =
  '你是一个文档助手，可以阅读、总结、解释和修改文档，也可以通过工具操作 MarkHunter 编辑器（读文档、替换选中、插入文字、替换全文、搜索、新建文件/目录、打开文件）。修改文档前按用户设置决定是否询问。回答用中文。';

// badge 菜单的 DeepSeek 快捷项（任意其它服务商/中转站走「打开设置」自由配置）
const DEEPSEEK_QUICK = [
  { label: 'DeepSeek 最新版', model: 'deepseek-chat' },
  { label: 'DeepSeek 推理版', model: 'deepseek-reasoner' },
];

export function createAiPanel(getEditor, getSettings, onApplySnippet, executeTool) {
  const panel = $('#ai-panel');
  const messagesEl = $('#ai-messages');
  const input = $('#ai-input');
  const btnSend = $('#btn-ai-send');
  const btnStop = $('#btn-ai-stop');
  const btnFull = $('#btn-ai-full');
  const btnSel = $('#btn-ai-sel');
  const btnClear = $('#btn-ai-clear');

  const history = [];       // { role, content, usage?, reasoning? }
  let streaming = false;
  let streamMsg = null;     // 当前流式输出的消息对象（ai:chunk 增量写入它）
  let pendingContext = '';
  let pendingLabel = '';

  function fmtTokens(n) {
    if (!n && n !== 0) return '0';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /** 构造单条消息行（render 全量重建与流式增量更新共用；live=true 加流式光标并跳过「写入文档」按钮） */
  function renderMessageInto(row, m, live) {
    const prevReasoning = row.querySelector('details.ai-reasoning');
    const wasOpen = prevReasoning ? prevReasoning.open : false;
    row.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ai-msg-head';
    head.textContent = m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'AI';
    row.appendChild(head);
    // 推理模型思考过程（可折叠；重渲染保持展开状态）
    if (m.reasoning) {
      const det = document.createElement('details');
      det.className = 'ai-reasoning';
      det.open = wasOpen || (!!live && !prevReasoning); // 流式首轮自动展开，之后跟随用户操作
      const sum = document.createElement('summary');
      sum.textContent = '💭 思考过程';
      const pre = document.createElement('div');
      pre.className = 'ai-reasoning-body';
      pre.textContent = m.reasoning;
      det.append(sum, pre);
      row.appendChild(det);
    }
    const body = document.createElement('div');
    body.className = 'ai-msg-body' + (live ? ' streaming' : '');
    if (m.role === 'ai') {
      body.innerHTML = md.render(m.content || (live ? '' : '（思考中…）'));
    } else {
      body.textContent = m.content;
    }
    row.appendChild(body);
    if (!live && m.role === 'ai' && m.usage) {
      const usage = document.createElement('div');
      usage.className = 'ai-msg-usage';
      usage.textContent = `本次 ↑${fmtTokens(m.usage.prompt_tokens)} ↓${fmtTokens(m.usage.completion_tokens)} tokens`;
      row.appendChild(usage);
    }
    if (!live && m.role === 'ai' && m.content) {
      const apply = document.createElement('button');
      apply.className = 'tbtn small ai-apply';
      apply.textContent = '📥 写入文档';
      apply.addEventListener('click', () => onApplySnippet(m.content));
      row.appendChild(apply);
    }
  }

  function render() {
    const s = getSettings();
    // 模型徽标（模型名 + 会话累计用量）—— 任意服务商/中转站，类型标签不再区分
    const badge = $('#ai-model-badge');
    let totP = 0;
    let totC = 0;
    for (const m of history) {
      if (m.usage) {
        totP += m.usage.prompt_tokens || 0;
        totC += m.usage.completion_tokens || 0;
      }
    }
    badge.textContent = `${s.aiModel || '未配置模型'} · ↑${fmtTokens(totP)} ↓${fmtTokens(totC)}`;
    badge.title = `服务：${s.aiBaseUrl || '未配置'}\n点击更换模型 / 服务商；会话累计 tokens：输入 ${totP}，输出 ${totC}`;
    badge.classList.add('clickable');

    messagesEl.innerHTML = '';
    for (const m of history) {
      const row = document.createElement('div');
      row.className = `ai-msg ${m.role}`;
      renderMessageInto(row, m, false);
      messagesEl.appendChild(row);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // 流式增量：只重绘最后一行（节流 60ms），不整面板重建
  let liveTimer = null;
  function scheduleLiveRender() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      if (!streamMsg) return;
      const row = messagesEl.lastElementChild;
      if (!row) return;
      renderMessageInto(row, streamMsg, true);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 60);
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
      // system 为界面提示（如「未配置 API Key」），不参与 API 请求：
      // 部分 OpenAI 兼容端点拒绝对话中段出现多条 system 消息
      if (h.role === 'system') continue;
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
      addMessage('system', '⚠ 未配置 API Key：请点击「⚙ 设置」，在「AI 大模型」区选择服务商并填写 API Key（本地 Ollama / LM Studio 也需任意非空占位 Key）。');
      return;
    }
    if (!s.aiBaseUrl) {
      addMessage('system', '⚠ 未配置服务地址：请点击「⚙ 设置」，在「AI 大模型」区选择服务商预设或填写中转站地址。');
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
    streamMsg = aiMsg;
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
      if (res.reasoning) aiMsg.reasoning = res.reasoning;
      aiMsg.usage = res.usage || null;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg !== '已终止') {
        // 请求失败：恢复本次附加的上下文，重试仍带（点击「全文/选中」后不必重新点）
        pendingContext = ctx;
        pendingLabel = label;
        if (ctx) input.placeholder = `已附加${label}（重试仍生效），输入问题重试`;
      }
      aiMsg.content = (aiMsg.content ? aiMsg.content + '\n\n' : '') + '⚠ ' + msg;
    } finally {
      streaming = false;
      streamMsg = null;
      btnSend.disabled = false;
      btnStop.disabled = true;
      render();
    }
  }

  // 流式增量：主进程 ai:chunk → 追加到当前流式消息并节流重绘
  window.api.onAiChunk((d) => {
    if (!streamMsg || !d) return;
    if (d.reasoning) streamMsg.reasoning = (streamMsg.reasoning || '') + d.reasoning;
    if (d.text) streamMsg.content = (streamMsg.content || '') + d.text;
    scheduleLiveRender();
  });

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
  // 徽标点击：快捷切换（DeepSeek 快捷项 + 打开设置自由配置任意服务商/中转站）
  $('#ai-model-badge').addEventListener('click', () => {
    const s = getSettings();
    const body = document.createElement('div');
    body.className = 'ai-model-menu';
    const pick = async (model) => {
      await window.api.setSettings({ aiModel: model });
      closeModal();
      render();
    };
    const mkItem = (label, desc, onClick, isCur) => {
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
      it.addEventListener('click', onClick);
      return it;
    };
    for (const q of DEEPSEEK_QUICK) {
      body.appendChild(mkItem(q.label, q.model, () => pick(q.model), s.aiModel === q.model));
    }
    body.appendChild(mkItem('⚙ 打开设置…', '任意服务商 / 中转站 / 本地模型（OpenAI 兼容）', () => {
      closeModal();
      window.dispatchEvent(new CustomEvent('markhunter:open-settings'));
    }, false));
    openModal({
      title: '切换模型',
      body,
      actions: [{ label: '取消', onClick: closeModal }],
    });
  });

  // 清空对话：history 复位（tokens 徽标同步归零）
  btnClear.addEventListener('click', () => {
    if (streaming) {
      toast('请先等待回复完成或点击 ■ 终止');
      return;
    }
    if (!history.length) return;
    history.length = 0;
    pendingContext = '';
    pendingLabel = '';
    input.placeholder = '向 AI 提问，或让它读取/修改当前文档…（Shift+Enter 换行）';
    render();
  });

  btnSend.addEventListener('click', () => send());
  input.addEventListener('keydown', (e) => {
    // 输入法组合确认键（isComposing）不触发发送：中文 IME 按 Enter 选字时不应提前发出消息
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
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
