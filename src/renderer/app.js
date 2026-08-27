// 应用入口：组装各模块
import { $, $$, showPrompt, alertBox, toast, closeModal, openModal, confirmDialog, initDragResize, escapeHtml, debounce } from './ui.js';
import { createTree } from './tree.js';
import { createEditor } from './tabs.js';
import { createFind } from './find.js';
import { createPreview } from './preview.js';
import { createGlobalSearch } from './globalsearch.js';
import { createPythonPanel } from './python.js';
import { createAiPanel } from './ai-panel.js';
import { createFavorites } from './favorites.js';
import { isMarkdown, isPython } from './ui.js';

async function boot() {
  // 全局错误捕获（辅助排查，console 输出会被主进程 --smoke 转发）
  window.addEventListener('error', (e) => {
    console.error('[app-error]', e.error ? e.error.stack || e.error : e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[app-reject]', e.reason && e.reason.stack ? e.reason.stack : e.reason);
  });

  // ---------- 全局状态 ----------
  const state = {
    rootDir: null,
    settings: await window.api.getSettings(),
  };

  let tree, editor, preview, find, globalSearch, python;

  // 应用滚动条宽度
  const applyScrollbarWidth = (w) => {
    document.documentElement.style.setProperty('--scrollbar-width', (w || 10) + 'px');
  };
  applyScrollbarWidth(state.settings.scrollbarWidth);

  // ---------- 主题引擎（36 皮肤 = daisyUI 内置 35 + 自研经典） ----------
  // 清单/分组与 docs/开发计划-多主题皮肤.md §3.3.2 一致；暗色清单 = 实证 14 个 color-scheme: dark
  const THEME_NAMES = [
    'markhunter-classic', 'light', 'cupcake', 'bumblebee', 'emerald', 'corporate',
    'retro', 'cyberpunk', 'valentine', 'garden', 'lofi', 'pastel', 'fantasy',
    'wireframe', 'cmyk', 'autumn', 'acid', 'lemonade', 'winter', 'nord',
    'caramellatte', 'silk', 'dark', 'synthwave', 'halloween', 'forest', 'aqua',
    'black', 'luxury', 'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss',
    // v0.1.50 特效皮肤 20 款（调色板 tailwind-input.css，动画 styles.css「特效皮肤」节）
    'fx-aurora', 'fx-sakura', 'fx-ocean', 'fx-ice', 'fx-rainbow', 'fx-glass',
    'fx-forest', 'fx-lavender', 'fx-gold',
    'fx-neon', 'fx-matrix', 'fx-starry', 'fx-fire', 'fx-crt', 'fx-vapor',
    'fx-deep', 'fx-ink', 'fx-cyber', 'fx-quantum', 'fx-eclipse',
  ];
  const DARK_THEMES = [
    'dark', 'synthwave', 'halloween', 'forest', 'aqua', 'black', 'luxury',
    'dracula', 'business', 'night', 'coffee', 'dim', 'sunset', 'abyss',
    // 特效暗色 11 款（防闪白底色 + mermaid dark 同步）
    'fx-neon', 'fx-matrix', 'fx-starry', 'fx-fire', 'fx-crt', 'fx-vapor',
    'fx-deep', 'fx-ink', 'fx-cyber', 'fx-quantum', 'fx-eclipse',
  ];
  // 设置下拉分组（label = 下拉显示文案，格式「名 · 中文」）
  const THEME_GROUPS = [
    { label: '经典', items: [{ name: 'markhunter-classic', label: 'markhunter-classic · 经典' }] },
    {
      label: '推荐',
      items: [
        { name: 'light', label: 'light · 亮白' },
        { name: 'dark', label: 'dark · 曜黑' },
        { name: 'night', label: 'night · 深蓝夜' },
        { name: 'dracula', label: 'dracula · 德古拉' },
        { name: 'nord', label: 'nord · 北欧极光' },
        { name: 'synthwave', label: 'synthwave · 合成波' },
        { name: 'corporate', label: 'corporate · 商务' },
        { name: 'business', label: 'business · 商务暗' },
      ],
    },
    {
      label: '浅色',
      items: [
        { name: 'cupcake', label: 'cupcake · 马卡龙' },
        { name: 'bumblebee', label: 'bumblebee · 大黄蜂' },
        { name: 'emerald', label: 'emerald · 祖母绿' },
        { name: 'retro', label: 'retro · 复古' },
        { name: 'cyberpunk', label: 'cyberpunk · 赛博朋克' },
        { name: 'valentine', label: 'valentine · 情人节' },
        { name: 'garden', label: 'garden · 花园' },
        { name: 'lofi', label: 'lofi · 低保真' },
        { name: 'pastel', label: 'pastel · 粉彩' },
        { name: 'fantasy', label: 'fantasy · 奇幻' },
        { name: 'wireframe', label: 'wireframe · 线框' },
        { name: 'cmyk', label: 'cmyk · 印刷四色' },
        { name: 'autumn', label: 'autumn · 秋日' },
        { name: 'acid', label: 'acid · 酸性' },
        { name: 'lemonade', label: 'lemonade · 柠檬水' },
        { name: 'winter', label: 'winter · 冬日' },
        { name: 'caramellatte', label: 'caramellatte · 焦糖拿铁' },
        { name: 'silk', label: 'silk · 丝绸' },
      ],
    },
    {
      label: '深色',
      items: [
        { name: 'halloween', label: 'halloween · 万圣节' },
        { name: 'black', label: 'black · 纯黑' },
        { name: 'luxury', label: 'luxury · 奢华' },
        { name: 'coffee', label: 'coffee · 咖啡' },
        { name: 'dim', label: 'dim · 朦胧' },
        { name: 'sunset', label: 'sunset · 落日' },
        { name: 'abyss', label: 'abyss · 深渊' },
        // L1（v0.1.44）：aqua/forest 实为 color-scheme:dark（DARK_THEMES 已含），自浅色组移入深色组
        { name: 'aqua', label: 'aqua · 水蓝' },
        { name: 'forest', label: 'forest · 森林' },
      ],
    },
    {
      label: '特效',
      items: [
        { name: 'fx-aurora', label: '🟣 极光 · 三色漂移' },
        { name: 'fx-sakura', label: '🌸 樱花 · 花瓣飘落' },
        { name: 'fx-ocean', label: '🌊 海洋 · 波光流动' },
        { name: 'fx-ice', label: '❄️ 冰晶 · 冷光斜掠' },
        { name: 'fx-rainbow', label: '🌈 彩虹 · 流光变色' },
        { name: 'fx-glass', label: '🪟 玻璃 · 毛玻璃光斑' },
        { name: 'fx-forest', label: '🌿 晨雾 · 绿雾横漂' },
        { name: 'fx-lavender', label: '💜 薰衣草 · 紫晕呼吸' },
        { name: 'fx-gold', label: '✨ 鎏金 · 金辉扫掠' },
        { name: 'fx-neon', label: '💫 霓虹 · 双色辉光' },
        { name: 'fx-matrix', label: '🟩 黑客帝国 · 字符雨' },
        { name: 'fx-starry', label: '⭐ 星空 · 星点闪烁' },
        { name: 'fx-fire', label: '🔥 熔岩 · 余烬呼吸' },
        { name: 'fx-crt', label: '📺 复古CRT · 扫描线' },
        { name: 'fx-vapor', label: '🌴 蒸汽波 · 日落渐变' },
        { name: 'fx-deep', label: '🫧 深海 · 气泡上升' },
        { name: 'fx-ink', label: '🖌️ 水墨 · 墨晕缓渗' },
        { name: 'fx-cyber', label: '⚡ 赛博 · 故障闪条' },
        { name: 'fx-quantum', label: '🌀 量子 · 光谱旋转' },
        { name: 'fx-eclipse', label: '🌘 日蚀 · 金环呼吸' },
      ],
    },
  ];

  /** 全局主题应用：设 data-theme + mermaid 明暗重渲染。
   *  boot / 设置保存 / 下拉即时预览统一走这里；非法名回退经典 */
  function applyTheme(name) {
    const v = THEME_NAMES.includes(name) ? name : 'markhunter-classic';
    document.documentElement.setAttribute('data-theme', v);
    if (preview) preview.refreshMermaid(); // 按当前明暗重渲染 mermaid（预览模块未创建时跳过）
    return v;
  }
  // 防闪白第二层：boot 最早阶段（创建编辑器/树之前）应用持久化主题；
  // 与 index.html 静态 data-theme="markhunter-classic" 组成双层保障（阶段2 裁定：无需 preload sendSync）
  applyTheme(state.settings.theme);

  const getActiveTab = () => editor.getActiveTab();
  const findQuery = () => $('#find-input').value.trim();

  // P1（v0.1.44）：击键防抖 —— 打字突发只触发一次整篇 md.render + find 全扫。
  // trailing 250ms，与自动保存 800ms 节奏协调（互不干扰）；
  // onTabSwitch / 外部重载 / 主题切换等路径不走 onDocChanged，仍即时渲染，不受本防抖影响。
  const debouncedPreviewRender = debounce((tab) => {
    // 触发时重新校验：期间可能已切换标签 / 改模式 / 变文件类型
    if (getActiveTab() === tab && isMarkdown(tab.name) && preview.getMode() !== 'edit') {
      preview.render();
    }
  }, 250);
  const debouncedFindSearch = debounce(() => {
    if (findQuery()) find.runSearch(true);
  }, 250);

  // ---------- 初始化各模块 ----------
  editor = createEditor({
    getWordWrap: () => state.settings.wordWrap,
    getIndentSize: () => state.settings.indentSize,
    onSaveStatus: (msg) => {
      $('#save-status').textContent = msg;
    },
    onDocChanged: (tab) => {
      // 自动保存（防抖）
      clearTimeout(tab.saveTimer);
      tab.saveTimer = setTimeout(() => editor.saveNow(tab), state.settings.autoSaveDelay);
      $('#save-status').textContent = '未保存…';
      // 实时更新预览（P1：250ms trailing 防抖合并击键；onTabSwitch/外部重载等仍即时渲染）
      if (getActiveTab() === tab && isMarkdown(tab.name) && preview.getMode() !== 'edit') {
        debouncedPreviewRender(tab);
      }
      // 文件内搜索实时刷新（P1：同样防抖，不抢占光标，避免打字时光标被拽走）
      if (findQuery()) debouncedFindSearch();
    },
    onTabLeave: (oldTab) => {
      // 预览区滚动位置随标签记忆（编辑器滚动由 tabs.js switchTab 内部保存）
      const ph = $('#preview-host');
      if (ph && oldTab) oldTab.previewScrollTop = ph.scrollTop;
    },
    onTabSwitch: (tab) => {
      preview.applyMode();
      updateRunButton();
      if (tab) {
        $('#save-status').textContent = tab.dirty ? '未保存…' : '';
        if (findQuery()) find.runSearch();
        tree.reveal(tab.path).catch(() => {}); // 树跟随定位（工作目录内走真实树；外部文件走「外部文件」分支）
        // 需求1：外部文件被定位到「外部文件」分支时提示（同一路径去重，不刷屏）
        if (tab.path && !tree.isInsideRoot(tab.path) && tab.path !== lastExtToastPath) {
          lastExtToastPath = tab.path;
          toast('文件不在当前工作目录，已在「外部文件」分支定位');
        }
        // 预览区滚动位置恢复：render 同步完成，mermaid 异步渲染可能再改高度 → 多帧校正；
        // 无记录 → 顶部（避免残留上一标签的滚动偏移）
        const ph = $('#preview-host');
        if (ph) {
          const target = typeof tab.previewScrollTop === 'number' ? tab.previewScrollTop : 0;
          const restorePv = (n) => {
            if (getActiveTab() !== tab) return;
            ph.scrollTop = target;
            if (n > 0) requestAnimationFrame(() => restorePv(n - 1));
          };
          restorePv(4);
        }
      } else {
        $('#save-status').textContent = '';
        find.clearSearch();
      }
    },
    onRequestClose: (tab) => {
      if (tab.dirty) editor.saveNow(tab);
      editor.closeTab(tab);
    },
    onSessionChange: () => {
      persistSession();
      syncExternalTree(); // 需求1：标签增删/切换后同步外部文件分支
    },
  });

  preview = createPreview(() => editor, getActiveTab, () =>
    DARK_THEMES.includes(document.documentElement.getAttribute('data-theme'))
  );
  // H1：boot 时 applyTheme（上方 L114 附近）先于 preview 创建，mermaid 仍停留在模块级 default（浅色）。
  // 此处补一次 refreshMermaid，按当前持久化主题的明暗初始化 mermaid（明暗守卫去重，无图零成本）。
  preview.refreshMermaid();
  find = createFind(() => editor, getActiveTab);
  globalSearch = createGlobalSearch(() => state.rootDir, openFileAt);
  python = createPythonPanel(getActiveTab, () => state.settings, (tab) => editor.saveNow(tab));
  tree = createTree();

  // ---------- AI 助手 ----------
  const aiPanel = createAiPanel(() => editor, () => state.settings, applyAiSnippet, executeAiTool);

  /** AI 工具执行器（function calling） */
  async function executeAiTool(name, args) {
    const tab = getActiveTab();
    const view = editor.getView();
    const isViewer = tab && tab.kind === 'viewer-lg';
    switch (name) {
      case 'read_document': {
        if (!tab) return '（当前无打开的文档）';
        if (!tab.state) return '（当前为图片/PDF 等非文本文件，无法读取文字内容）';
        if (isViewer) {
          // 大文件查看器：只提供当前窗口内容（截断 20 万字符），避免整窗放大与全文误读
          return `（当前为大文件查看器，仅加载了窗口内容；全文 ${Math.round(tab.vwin.size / 1048576)} MB）\n\n[窗口内容（截断）]\n` + tab.state.doc.toString().slice(0, 200000);
        }
        return tab.state.doc.toString();
      }
      case 'replace_selection': {
        if (isViewer) throw new Error('大文件查看器不支持该操作（可在查看器横幅开启区域编辑）');
        if (!tab || !tab.state) throw new Error('当前无可编辑的文本文档');
        const sel = view.state.selection.main;
        if (sel.from === sel.to) throw new Error('未选中文字');
        await maybeConfirm(`替换选中的 ${sel.to - sel.from} 个字符？`, args.text);
        await editor.applySnippet(String(args.text || ''), 'replace', sel.from, sel.to);
        return '已替换选中文字';
      }
      case 'insert_text': {
        if (isViewer) throw new Error('大文件查看器不支持该操作（可在查看器横幅开启区域编辑）');
        if (!tab || !tab.state) throw new Error('当前无可编辑的文本文档');
        await maybeConfirm('在光标处插入文字？', args.text);
        await editor.applySnippet(String(args.text || ''), 'insert', view.state.selection.main.head);
        return '已插入文字';
      }
      case 'replace_document': {
        if (isViewer) throw new Error('大文件查看器不支持该操作（可在查看器横幅开启区域编辑）');
        if (!tab || !tab.state) throw new Error('当前无可编辑的文本文档');
        await maybeConfirm('替换整个文档内容？', args.text);
        await editor.applySnippet(String(args.text || ''), 'full');
        return '已替换全文';
      }
      case 'search_documents': {
        if (!state.rootDir) throw new Error('未打开工作目录');
        const results = await window.api.globalSearch(state.rootDir, String(args.query || ''));
        if (!results.length) return '（无匹配结果）';
        return results.slice(0, 30).map((r) => `${r.file}:${r.line}: ${r.text}`).join('\n');
      }
      case 'create_file': {
        if (!state.rootDir) throw new Error('未打开工作目录');
        const parent = tree.getTargetDir();
        await maybeConfirm(`新建文件 ${args.name}？`, '');
        const p = await window.api.create(parent, String(args.name || ''), 'file');
        if (args.content) await window.api.writeFile(p, String(args.content));
        tree.refreshNode(parent, true);
        return `已新建文件 ${p}`;
      }
      case 'create_dir': {
        if (!state.rootDir) throw new Error('未打开工作目录');
        const parent = tree.getTargetDir();
        await maybeConfirm(`新建目录 ${args.name}？`, '');
        await window.api.create(parent, String(args.name || ''), 'dir');
        tree.refreshNode(parent, true);
        return '已新建目录';
      }
      case 'open_file': {
        if (!state.rootDir) throw new Error('未打开工作目录');
        // S8：拒绝路径穿越 —— 仅允许工作目录内的相对路径
        const name = String(args.name || '');
        const segs = name.split(/[\\/]/);
        if (
          segs.some((s) => s === '..') ||   // 含 '..' 段
          /^[\\/]/.test(name) ||            // 以 / 或 \ 开头（绝对路径）
          /^[a-zA-Z]:/.test(name)           // 盘符开头（如 C:\）
        ) {
          throw new Error('非法路径');
        }
        const p = (state.rootDir + '\\' + name).replace(/\//g, '\\');
        const opened = await editor.openFile(p);
        tree.reveal(p).catch(() => {}); // 树跟随定位
        return opened ? `已打开 ${p}` : '打开失败（文件不存在或过大）';
      }
      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  /** 根据「修改前询问」设置决定是否弹确认框 */
  async function maybeConfirm(desc, preview) {
    if (state.settings.aiAskBeforeApply === false) return;
    const pv = preview ? String(preview).slice(0, 200) : '';
    const ok = await confirmDialog(`${desc}${pv ? '\n\n内容预览：' + pv : ''}`, 'AI 修改文档');
    if (!ok) throw new Error('用户取消了操作');
  }

  /** AI 内容写入文档：选择替换选中 / 插入光标 / 替换全文 */
  function applyAiSnippet(text) {
    const tab = getActiveTab();
    const view = editor.getView();
    if (!tab || !tab.state) {
      toast('请先打开一个文档');
      return;
    }
    const sel = view.state.selection.main;
    const hasSel = sel.from !== sel.to;
    const selLen = hasSel ? sel.to - sel.from : 0;

    const body = document.createElement('div');
    body.className = 'ai-apply-body';
    const p = document.createElement('p');
    p.textContent = '选择 AI 内容的写入方式：';
    body.appendChild(p);

    const actions = [];
    if (hasSel) {
      actions.push({
        label: `替换选中文字（${selLen} 字）`,
        primary: true,
        onClick: () => {
          editor.applySnippet(text, 'replace', sel.from, sel.to);
          closeModal();
          toast('已替换选中内容');
        },
      });
    }
    actions.push({
      label: '插入到光标处',
      primary: !hasSel,
      onClick: () => {
        editor.applySnippet(text, 'insert', view.state.selection.main.head);
        closeModal();
        toast('已插入到光标处');
      },
    });
    actions.push({
      label: '替换全文',
      onClick: () => {
        editor.applySnippet(text, 'full');
        closeModal();
        toast('已替换全文');
      },
    });
    actions.push({ label: '取消', onClick: closeModal });
    openModal({ title: 'AI 内容写入文档', body, actions });
  }

  function updateRunButton() {
    const tab = getActiveTab();
    $('#btn-run-py').disabled = !(tab && isPython(tab.name));
  }

  // ---------- 状态栏滚动快捷按钮：回顶部 / 到底部 ----------
  // 仅预览模式下主面板是预览区（滚预览）；其余滚编辑器（tabs.js 内处理图片/分段标签）
  $('#btn-scroll-top').addEventListener('click', () => {
    const tab = getActiveTab();
    if (tab && tab.kind !== 'image' && preview.getMode() === 'preview') {
      $('#preview-host').scrollTop = 0;
      return;
    }
    editor.scrollToTop();
  });
  $('#btn-scroll-bottom').addEventListener('click', () => {
    const tab = getActiveTab();
    if (tab && tab.kind !== 'image' && preview.getMode() === 'preview') {
      const ph = $('#preview-host');
      ph.scrollTop = ph.scrollHeight;
      return;
    }
    editor.scrollToBottom();
  });

  // ---------- 会话保持：标签快照持久化（防抖 600ms） + 跨重启恢复 ----------
  let sessionTimer = null;
  let lastExtToastPath = null; // 需求1：外部文件 toast 去重（同一路径只提示一次）

  /** 将当前打开标签快照写入设置；force=true 立即落盘，否则 600ms 防抖合并 */
  function persistSession(force = false) {
    if (!force) {
      clearTimeout(sessionTimer);
      sessionTimer = setTimeout(() => persistSession(true), 600);
      return;
    }
    const s = editor.getSession();
    if (!s.paths.length) {
      window.api.setSettings({ lastSession: null });
    } else {
      window.api.setSettings({ lastSession: { paths: s.paths, active: s.active, pinned: s.pinned } });
    }
  }

  /** 启动时恢复上次会话：并行恢复标签（P9：并发 3 个 openFile，串行逐个打开在大会话下拖慢启动），
   *  失败静默跳过（仅 console.warn），最多 50 个；恢复完成后按会话顺序重排标签栏，最后激活活动标签 */
  async function restoreSession() {
    const ls = state.settings.lastSession;
    if (!ls || !Array.isArray(ls.paths) || ls.paths.length === 0) return;
    // O2：会话上限 50 → 200（配合标签徽标增量化，100+ 标签的打开与恢复均可接受）
    const paths = ls.paths.slice(0, 200);
    // P9/O2：固定并发 6 的限流池（原 3；大标签数会话下恢复时间减半，主进程 IPC 仍可控）
    const CONCURRENCY = 6;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, paths.length) }, async () => {
      while (cursor < paths.length) {
        const p = paths[cursor++];
        try {
          await editor.openFile(p, { silent: true }); // L6：恢复失败静默（不弹 alertBox）
        } catch (err) {
          console.warn('[session] 恢复标签失败（已跳过）:', p, err && err.message ? err.message : err);
        }
      }
    });
    await Promise.all(workers);
    // 并行打开完成顺序 ≠ 会话顺序：按 paths 顺序重排标签栏，保证 pinned/active 下标语义一致
    if (paths.length > 1) editor.reorderTabs(paths);
    const active = typeof ls.active === 'number' && ls.active >= 0 && ls.active < paths.length ? ls.active : -1;
    if (active >= 0) {
      try {
        await editor.openFile(paths[active], { silent: true }); // openFile 对已存在标签会 switchTab 激活
      } catch (err) {
        console.warn('[session] 激活标签失败:', paths[active], err && err.message ? err.message : err);
      }
    }
    // 恢复 pinned：按下标 Set 还原（越界下标忽略；旧数据无 pinned → 视为 []）
    if (Array.isArray(ls.pinned)) {
      const pinSet = new Set(ls.pinned.filter((i) => Number.isInteger(i) && i >= 0 && i < paths.length));
      for (const idx of pinSet) {
        const t = editor.findTabByPath(paths[idx]);
        if (t) editor.setPinned(t, true);
      }
      editor.renderTabs(); // 一次重绘，保证 pin 标记同步
    }
    syncExternalTree(); // 需求1：外部文件虚拟分支重渲染（幂等）
    persistSession(true); // 强制落盘：确保最终快照包含 pinned
  }

  /** 需求1：同步「外部文件」虚拟分支 —— 取所有打开标签中 rootDir 外的文件路径。
   *  返回 setExternalFiles 的 Promise（可能触发全量 render），供 openDirFromPath 等调用方 await。 */
  function syncExternalTree() {
    const paths = editor.getSession().paths || [];
    if (!state.rootDir) {
      return tree.setExternalFiles([]);
    }
    return tree.setExternalFiles(paths.filter((p) => !tree.isInsideRoot(p)));
  }

  // ---------- 树回调 ----------
  tree.setCallbacks({
    // 图片文件由 tabs.js 内部分发为图片标签页（编辑区查看）
    onOpenFile: (p) => {
      editor.openFile(p);
      tree.reveal(p).catch(() => {}); // 树定位到该文件
    },
    onOpenDir: () => {},
    onSwitchRoot: (dir) => openDirFromPath(dir), // 需求1：外部区目录行「切换工作目录到此目录」
    onClosePath: (p, newPath) => {
      const tab = editor.findTabByPath(p);
      if (tab) {
        if (newPath) {
          tab.path = newPath;
          tab.name = newPath.split(/[\\/]/).pop();
          editor.renderTabs();
          // 重命名后旧路径已不存在：停止旧监听，为新路径重建文件监听
          window.api.unwatchFile(p);
          window.api
            .stat(newPath)
            .then((st) => {
              if (st && st.isFile) window.api.watchFile(newPath, st.mtime);
            })
            .catch(() => {});
          syncExternalTree(); // 外部文件重命名后同步外部区（原路径移除、新路径加入）
        } else {
          editor.closeByPath(p, false);
        }
      } else {
        // 可能是目录删除
        editor.closeByPath(p, true);
      }
    },
  });

  // ---------- 打开目录 ----------
  /** 按路径直接打开目录（选择对话框 / 右键菜单 / 启动恢复 / 点击收藏项共用） */
  function openDirFromPath(dir) {
    if (!dir) return Promise.resolve(false);
    return window.api
      .readTree(dir)
      .then(() => {
        state.rootDir = dir;
        $('#dir-label').textContent = dir;
        $('#dir-label').title = dir;
        return tree.setRoot(dir);
      })
      .then(async () => {
        window.api.setSettings({ lastDirectory: dir });
        window.api.setRootDir(dir); // S1：通知主进程当前工作目录（路径校验基准）
        favorites.syncState(); // 收藏按钮文案 / 列表高亮跟随当前工作目录
        // 需求1：目录切换后外部文件集合变化 → 重建外部分支（幂等）。
        // 必须 await：setExternalFiles 可能触发全量 render()，未等待会导致
        // 调用方在 render 中途检查 DOM（树被清空重建）得到不一致结果。
        await syncExternalTree();
        const act = editor.getActiveTab();
        if (act) await tree.reveal(act.path).catch(() => {}); // 切换目录后树定位活动标签（外部变内部/内部变外部）
        return true;
      })
      .catch(() => false);
  }

  // ---------- 目录收藏 ----------
  const favorites = createFavorites({
    onOpenDir: openDirFromPath,
    getRootDir: () => state.rootDir,
  });
  $('#btn-toggle-fav').addEventListener('click', () => favorites.toggle());

  async function openDirectory() {
    const dir = await window.api.selectDirectory();
    if (!dir) return;
    await openDirFromPath(dir);
  }

  // 右键「用 MarkHunter 打开」：以指定目录启动
  window.api.onOpenDir((dir) => {
    openDirFromPath(dir);
  });

  // ---------- 新建 ----------
  function newEntry(type) {
    if (!state.rootDir) {
      toast('请先选择工作目录');
      return;
    }
    const parent = tree.getTargetDir();
    const label = type === 'dir' ? '目录名称' : '文件名称（含扩展名）';
    showPrompt(type === 'dir' ? '新建目录' : '新建文件', label, '', async (val) => {
      const p = await window.api.create(parent, val, type);
      toast(`已创建 ${val}`);
      tree.refreshNode(parent, true);
      if (type === 'file') editor.openFile(p);
    });
  }

  // ---------- 打开文件并定位行（全局搜索结果点击） ----------
  async function openFileAt(file, line, query) {
    const tab = await editor.openFile(file);
    tree.reveal(file).catch(() => {}); // 全局搜索跳转：树跟随定位
    if (!tab) return;
    // 大文件查看器：行号 → 字节偏移（主进程流式统计换行）→ 居中开窗
    if (tab.kind === 'viewer-lg') {
      if (line) {
        try {
          const off = await window.api.findLineOffset(file, line);
          await editor.revealViewerAt(tab, off);
        } catch (err) {
          console.warn('[gs-jump] 大文件定位失败:', file, err && err.message ? err.message : err);
        }
      }
    } else if (line) {
      // 先定位（switchTab 激活视图），再高亮关键词，避免视图重建丢失高亮
      editor.jumpToLine(tab, line);
    }
    if (query) {
      switchPanel('find');
      find.setQuery(query, true);
    }
  }

  // ---------- 底部面板 ----------
  function switchPanel(name) {
    $$('.ptab').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    $$('.panel-body').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${name}`));
    $('#bottom-panel').classList.remove('collapsed');
  }

  $$('.ptab').forEach((b) => b.addEventListener('click', () => switchPanel(b.dataset.panel)));
  $('#btn-close-panel').addEventListener('click', () => {
    $('#bottom-panel').classList.add('collapsed');
  });

  // ---------- 设置弹窗 ----------
  function openSettings() {
    const s = state.settings;
    const body = document.createElement('div');

    // 主题（56 款皮肤，按「经典 / 推荐 / 浅色 / 深色 / 特效」五组；切换即整窗即时预览，取消/关闭还原）
    const themeField = document.createElement('div');
    themeField.className = 'field';
    const themeLabel = document.createElement('label');
    themeLabel.textContent = '主题（56 款皮肤，切换即时预览；特效组含动态背景）';
    const themeSelect = document.createElement('select');
    themeSelect.className = 'field-select';
    themeSelect.id = 'theme-select';
    for (const g of THEME_GROUPS) {
      const og = document.createElement('optgroup');
      og.label = g.label;
      for (const t of g.items) {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.label;
        og.appendChild(opt);
      }
      themeSelect.appendChild(og);
    }
    themeSelect.value = THEME_NAMES.includes(s.theme) ? s.theme : 'markhunter-classic';
    const openedTheme = themeSelect.value; // 打开时的主题：取消时还原到它
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value)); // Q9：下拉即色板
    themeField.append(themeLabel, themeSelect);

    // Python 解释器
    const pyField = document.createElement('div');
    pyField.className = 'field';
    const pyLabel = document.createElement('label');
    pyLabel.textContent = 'Python 解释器路径（留空 = 自动检测）';
    const pyRow = document.createElement('div');
    pyRow.className = 'field-row';
    const pyInput = document.createElement('input');
    pyInput.type = 'text';
    pyInput.value = s.pythonPath || '';
    pyInput.placeholder = '例如 C:\\Python312\\python.exe';
    const pyBrowse = document.createElement('button');
    pyBrowse.className = 'tbtn small';
    pyBrowse.textContent = '浏览…';
    pyBrowse.addEventListener('click', async () => {
      const p = await window.api.selectFile({
        title: '选择 Python 解释器',
        filters: [{ name: 'Python 可执行文件', extensions: ['exe'] }],
      });
      if (p) pyInput.value = p;
    });
    const pyDetect = document.createElement('button');
    pyDetect.className = 'tbtn small';
    pyDetect.textContent = '自动检测';
    pyRow.append(pyInput, pyBrowse, pyDetect);
    const pyHint = document.createElement('div');
    pyHint.className = 'hint';
    pyHint.id = 'py-hint';
    pyHint.textContent = '点击「自动检测」查找本机安装的 Python';
    pyDetect.addEventListener('click', async () => {
      pyDetect.disabled = true;
      pyHint.textContent = '检测中…';
      try {
        const found = await window.api.detectPython();
        if (found.length === 0) {
          pyHint.textContent = '未检测到 Python，请手动浏览选择解释器';
        } else {
          pyHint.innerHTML =
            '检测到：' +
            found
              .map((p) => `<a href="#" data-p="${escapeHtml(p)}" class="py-cand">${escapeHtml(p)}</a>`)
              .join('　');
          pyHint.querySelectorAll('.py-cand').forEach((a) => {
            a.addEventListener('click', (e) => {
              e.preventDefault();
              pyInput.value = a.dataset.p;
            });
          });
        }
      } catch (err) {
        pyHint.textContent = `检测失败：${err.message || err}`;
      } finally {
        pyDetect.disabled = false;
      }
    });
    pyField.append(pyLabel, pyRow, pyHint);

    // 大文件上限（1 ~ 4096 MB；v0.1.49 起支持 4GB 以下分层：>256MB 进只读查看器+区域编辑）
    const MAX_SIZE_MB = 4096;
    const sizeField = document.createElement('div');
    sizeField.className = 'field';
    const sizeLabel = document.createElement('label');
    sizeLabel.textContent = '大文件打开上限（MB）';
    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.min = 1;
    sizeInput.max = MAX_SIZE_MB;
    sizeInput.value = s.maxFileSizeMB;
    const sizeHint = document.createElement('div');
    sizeHint.className = 'hint';
    sizeHint.textContent = `可调整范围 1 ~ ${MAX_SIZE_MB} MB（超过上限拒绝打开）。≤256MB 直接编辑（>64MB 保存走流式写）；>256MB 以只读查看器打开（可切换区域编辑）`;
    sizeField.append(sizeLabel, sizeInput, sizeHint);

    // 自动保存间隔
    const saveField = document.createElement('div');
    saveField.className = 'field';
    const saveLabel = document.createElement('label');
    saveLabel.textContent = '自动保存延迟（毫秒）';
    const saveInput = document.createElement('input');
    saveInput.type = 'number';
    saveInput.min = 100;
    saveInput.max = 10000;
    saveInput.value = s.autoSaveDelay;
    saveField.append(saveLabel, saveInput);

    // 滚动条宽度（6 ~ 40）
    const MAX_SB_WIDTH = 40;
    const sbField = document.createElement('div');
    sbField.className = 'field';
    const sbLabel = document.createElement('label');
    sbLabel.textContent = '滚动条滑块宽度（像素，6~40）';
    const sbInput = document.createElement('input');
    sbInput.type = 'number';
    sbInput.min = 6;
    sbInput.max = MAX_SB_WIDTH;
    sbInput.value = s.scrollbarWidth || 10;
    const sbHint = document.createElement('div');
    sbHint.className = 'hint';
    // D10（v0.1.44）：注明平台限制 —— Win11「设置→辅助功能→视觉效果→自动隐藏滚动条」开启时
    // Chromium 使用 overlay 滚动条，任何 CSS 都无法改变其宽度（冒烟 scrollbarWidthVisual 自动跳过该层断言）
    sbHint.textContent = `调整横向/纵向滚动条滑块的粗细（可调整范围 6 ~ ${MAX_SB_WIDTH} 像素）；系统开启「自动隐藏滚动条」时宽度不可自定义`;
    sbField.append(sbLabel, sbInput, sbHint);

    // 缩进宽度（1 ~ 8 个空格）
    const MAX_INDENT = 8;
    const indentField = document.createElement('div');
    indentField.className = 'field';
    const indentLabel = document.createElement('label');
    indentLabel.textContent = '缩进宽度（空格，1~8）';
    const indentInput = document.createElement('input');
    indentInput.type = 'number';
    indentInput.min = 1;
    indentInput.max = MAX_INDENT;
    indentInput.value = s.indentSize || 4;
    const indentHint = document.createElement('div');
    indentHint.className = 'hint';
    indentHint.textContent = `Tab 键插入的空格数，Shift+Tab 反向缩进（可调整范围 1 ~ ${MAX_INDENT} 个空格）`;
    indentField.append(indentLabel, indentInput, indentHint);

    // AI 大模型配置
    const aiField = document.createElement('div');
    aiField.className = 'field';
    const aiTitle = document.createElement('label');
    aiTitle.textContent = 'AI 大模型（OpenAI 兼容接口）';
    const aiKeyInput = document.createElement('input');
    aiKeyInput.type = 'password'; // S5：密钥不显示明文（经 DPAPI 加密保存）
    aiKeyInput.placeholder = s.aiApiKeySet ? '已加密保存（留空保持不变）' : 'API Key（DeepSeek 等）';
    aiKeyInput.value = '';
    // S5：清除密钥按钮（保存时提交 aiApiKeyClear:true）
    let aiKeyClear = false;
    const aiKeyClearBtn = document.createElement('button');
    aiKeyClearBtn.className = 'tbtn small danger';
    aiKeyClearBtn.textContent = '清除密钥';
    aiKeyClearBtn.disabled = !s.aiApiKeySet;
    aiKeyClearBtn.addEventListener('click', () => {
      aiKeyClear = true;
      aiKeyInput.value = '';
      aiKeyClearBtn.disabled = true;
      toast('将清除已保存的 API Key（点击保存后生效）');
    });
    const aiKeyRow = document.createElement('div');
    aiKeyRow.className = 'field-row';
    aiKeyRow.append(aiKeyInput, aiKeyClearBtn);
    const aiBaseInput = document.createElement('input');
    aiBaseInput.type = 'text';
    aiBaseInput.placeholder = '服务地址';
    aiBaseInput.value = s.aiBaseUrl || 'https://api.deepseek.com';
    // 模型：中文类型下拉 + 模型名（可自定义具体版本）
    const aiModelRow = document.createElement('div');
    aiModelRow.className = 'field-row';
    const aiTypeSelect = document.createElement('select');
    aiTypeSelect.className = 'ai-model-select';
    const AI_TYPES = [
      { v: 'latest', label: '最新版' },
      { v: 'reasoner', label: '推理版' },
      { v: 'custom', label: '自定义' },
    ];
    for (const t of AI_TYPES) {
      const opt = document.createElement('option');
      opt.value = t.v;
      opt.textContent = t.label;
      aiTypeSelect.appendChild(opt);
    }
    aiTypeSelect.value = s.aiModelType || 'latest';
    const aiModelInput = document.createElement('input');
    aiModelInput.type = 'text';
    aiModelInput.placeholder = '模型名（如 deepseek-v4）';
    aiModelInput.value = s.aiModel || 'deepseek-chat';
    aiTypeSelect.addEventListener('change', () => {
      if (aiTypeSelect.value === 'latest') aiModelInput.value = 'deepseek-chat';
      else if (aiTypeSelect.value === 'reasoner') aiModelInput.value = 'deepseek-reasoner';
      // 自定义：保留当前值手动修改
    });
    aiModelRow.append(aiTypeSelect, aiModelInput);
    const aiHint = document.createElement('div');
    aiHint.className = 'hint';
    aiHint.textContent = 'API Key 经 Windows DPAPI（safeStorage）加密后保存在本机 settings.json，界面不显示明文；留空表示保持当前密钥不变。默认预置 DeepSeek，可改服务地址接入其它 OpenAI 兼容模型';
    const aiAskRow = document.createElement('label');
    aiAskRow.className = 'check-row';
    const aiAskInput = document.createElement('input');
    aiAskInput.type = 'checkbox';
    aiAskInput.checked = s.aiAskBeforeApply !== false;
    const aiAskText = document.createElement('span');
    aiAskText.textContent = 'AI 修改文档前询问确认';
    aiAskRow.append(aiAskInput, aiAskText);
    aiField.append(aiTitle, aiKeyRow, aiBaseInput, aiModelRow, aiHint, aiAskRow);

    // 自动换行
    const wrapRow = document.createElement('label');
    wrapRow.className = 'check-row';
    const wrapInput = document.createElement('input');
    wrapInput.type = 'checkbox';
    wrapInput.checked = !!s.wordWrap;
    const wrapText = document.createElement('span');
    wrapText.textContent = '自动换行';
    wrapRow.append(wrapInput, wrapText);

    body.append(themeField, pyField, sizeField, saveField, sbField, indentField, aiField, wrapRow);

    openModal({
      title: '设置',
      body,
      // M1：遮罩 / 取消 / 关闭 都还原打开时的主题预览（保存路径用 closeModal(true) 跳过本钩子）
      onClose: () => applyTheme(openedTheme),
      actions: [
        {
          label: '取消',
          onClick: () => closeModal(), // 还原由 onClose 钩子统一处理
        },
        {
          label: '保存',
          primary: true,
          onClick: async (btn) => {
            const patch = {
              theme: themeSelect.value,
              pythonPath: pyInput.value.trim(),
              maxFileSizeMB: Math.min(4096, Math.max(1, parseInt(sizeInput.value, 10) || 50)),
              autoSaveDelay: Math.max(100, parseInt(saveInput.value, 10) || 800),
              scrollbarWidth: Math.min(40, Math.max(6, parseInt(sbInput.value, 10) || 10)),
              indentSize: Math.min(8, Math.max(1, parseInt(indentInput.value, 10) || 4)),
              wordWrap: wrapInput.checked,
              aiApiKey: aiKeyInput.value.trim(),
              ...(aiKeyClear ? { aiApiKeyClear: true } : {}),
              aiBaseUrl: aiBaseInput.value.trim() || 'https://api.deepseek.com',
              aiModel: aiModelInput.value.trim() || 'deepseek-chat',
              aiModelType: aiTypeSelect.value,
              aiAskBeforeApply: aiAskInput.checked,
            };
            state.settings = await window.api.setSettings(patch);
            applyTheme(state.settings.theme); // 兜底：保证 data-theme 与落盘值一致（change 已即时预览，此处幂等）
            editor.setWordWrap(patch.wordWrap);
            editor.setIndentSize(patch.indentSize);
            applyScrollbarWidth(patch.scrollbarWidth);
            closeModal(true); // 已保存：跳过 onClose 的「还原打开时主题」钩子
            toast('设置已保存');
          },
        },
      ],
    });
  }

  // ---------- 工具栏事件 ----------
  $('#btn-open-dir').addEventListener('click', openDirectory);
  $('#btn-new-file').addEventListener('click', () => newEntry('file'));
  $('#btn-new-dir').addEventListener('click', () => newEntry('dir'));
  $('#btn-refresh').addEventListener('click', () => {
    if (!state.rootDir) {
      toast('请先选择工作目录');
      return;
    }
    tree.refreshSelected();
  });
  $('#btn-global-search').addEventListener('click', () => {
    globalSearch.focus();
  });
  const btnPreview = $('#btn-preview-mode');
  const previewModeNames = { edit: '👁 预览', split: '👁 分屏', preview: '✍ 编辑' };
  btnPreview.addEventListener('click', () => {
    const mode = preview.cycleMode();
    if (!mode) toast('当前文件不是 Markdown，无法预览');
    else btnPreview.textContent = previewModeNames[mode];
  });
  $('#btn-diff').addEventListener('click', () => openCompareDialog());

  /** 对比入口：选择对比目标（其它打开的标签 / 剪贴板 / 磁盘版本）→ 打开对比标签 */
  function openCompareDialog() {
    const cur = getActiveTab();
    if (!cur || cur.kind || !cur.state) {
      toast('请先打开一个可编辑的文本文档再对比');
      return;
    }
    if (cur.state.doc.length > 20 * 1024 * 1024) {
      toast('当前文档超过对比上限（单侧 20MB）');
      return;
    }
    const body = document.createElement('div');
    const field = document.createElement('div');
    field.className = 'field';
    const lbl = document.createElement('label');
    lbl.textContent = `将「${cur.name}」与以下内容对比：`;
    const sel = document.createElement('select');
    sel.className = 'field-select';
    // 候选：其它文本标签 / 磁盘版本（未保存改动） / 剪贴板
    const others = editor.getSession().paths
      .map((p) => editor.findTabByPath(p))
      .filter((t) => t && t !== cur && (!t.kind || t.kind === 'chunked') && t.state);
    const optDisk = document.createElement('option');
    optDisk.value = '__disk__';
    optDisk.textContent = '💾 磁盘版本（查看未保存的改动）';
    sel.appendChild(optDisk);
    const optClip = document.createElement('option');
    optClip.value = '__clip__';
    optClip.textContent = '📋 剪贴板内容';
    sel.appendChild(optClip);
    for (const t of others) {
      if (t.state.doc.length > 20 * 1024 * 1024) continue;
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = '📑 ' + t.name;
      sel.appendChild(o);
    }
    field.append(lbl, sel);
    body.appendChild(field);
    openModal({
      title: '文档对比',
      body,
      actions: [
        { label: '取消', onClick: () => closeModal() },
        {
          label: '开始对比',
          primary: true,
          onClick: async () => {
            closeModal();
            const v = sel.value;
            const rightContent = cur.state.doc.toString();
            const rightLabel = cur.name + '（当前）';
            let leftContent = null;
            let leftLabel = '';
            try {
              if (v === '__disk__') {
                const data = await window.api.readFile(cur.path);
                leftContent = data.content;
                leftLabel = cur.name + '（磁盘）';
              } else if (v === '__clip__') {
                leftContent = await window.api.readClipboardText();
                leftLabel = '剪贴板';
                if (!leftContent) {
                  toast('剪贴板为空或不是文本');
                  return;
                }
              } else {
                const t = tabsById(String(v));
                if (!t) return;
                leftContent = t.state.doc.toString();
                leftLabel = t.name;
              }
            } catch (err) {
              toast('读取对比内容失败：' + (err.message || err));
              return;
            }
            editor.openDiffTab({
              leftLabel,
              leftContent,
              rightLabel,
              rightContent,
              exportDir: state.rootDir || '',
            });
          },
        },
      ],
    });
  }

  /** 按 id 找已打开标签（对话框选项值用 id 字符串） */
  function tabsById(idStr) {
    for (const p of editor.getSession().paths) {
      const t = editor.findTabByPath(p);
      if (t && String(t.id) === idStr) return t;
    }
    return null;
  }

  $('#btn-run-py').addEventListener('click', () => {
    switchPanel('python');
    python.run();
  });
  $('#btn-settings').addEventListener('click', openSettings);
  // AI 侧栏「自定义模型名」跳转设置
  window.addEventListener('markhunter:open-settings', openSettings);
  $('#btn-ai').addEventListener('click', () => {
    aiPanel.toggle();
    $('#ai-divider').classList.toggle('hidden', !aiPanel.isOpen());
  });
  $('#btn-ai-close').addEventListener('click', () => {
    aiPanel.toggle();
    $('#ai-divider').classList.toggle('hidden', !aiPanel.isOpen());
  });

  // ---------- 各分界线拖拽调整尺寸（分隔条在目标右侧/下侧时用 reverse） ----------
  initDragResize($('#sidebar-divider'), { target: '#sidebar', dir: 'x', min: 200, max: 520 });
  initDragResize($('#ai-divider'), { target: '#ai-panel', dir: 'x', min: 260, max: 560, reverse: true });
  initDragResize($('#bottom-divider'), { target: '#bottom-panel', dir: 'y', min: 120, max: 640, reverse: true });
  initDragResize($('#tree-search-divider'), { target: '#sidebar-search', dir: 'y', min: 80, max: 400, reverse: true });

  // 预览按钮可用性随标签变化
  const setPreviewLabel = () => {
    const tab = getActiveTab();
    if (!tab || !isMarkdown(tab.name)) {
      btnPreview.textContent = '👁 预览';
      btnPreview.disabled = true;
    } else {
      btnPreview.disabled = false;
      btnPreview.textContent = previewModeNames[preview.getMode()] || '👁 分屏';
    }
  };
  new MutationObserver(setPreviewLabel).observe($('#tabs'), { childList: true, subtree: true });

  // ---------- 拖拽文件到窗口直接打开 ----------
  window.addEventListener(
    'dragover',
    (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    },
    true
  );
  window.addEventListener(
    'drop',
    (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      for (const f of files) {
        try {
          // Electron 32+ 移除 File.path：优先 webUtils 解析真实路径（preload 暴露）；
          // 解析失败（如冒烟伪造对象/异常 File）回退 f.path，保持旧路径可用
          let p;
          try {
            p = window.api.getPathForFile ? window.api.getPathForFile(f) : f.path;
          } catch {
            p = f.path;
          }
          if (!p) continue;
          editor.openFile(p);
          tree.reveal(p).catch(() => {}); // 拖拽打开：树跟随定位
        } catch {
          /* 忽略无法打开的文件 */
        }
      }
    },
    true
  );

  // ---------- 快捷键 ----------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openDirectory();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      editor.saveNow();
    } else if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      e.preventDefault();
      switchPanel('find');
      find.focus();
    } else if (mod && e.key.toLowerCase() === 'h' && !e.shiftKey) {
      e.preventDefault();
      switchPanel('find');
      find.focusReplace();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      globalSearch.focus();
    } else if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      const mode = preview.cycleMode();
      if (mode) btnPreview.textContent = previewModeNames[mode];
    } else if (mod && e.key === '0') {
      e.preventDefault();
      preview.resetZoom();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      window.api.openNewWindow(); // 多窗口：每窗口独立标签/目录，共享设置与主题
    } else if (mod && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      const tab = getActiveTab();
      if (tab) editor.closeTab(tab);
    } else if (mod && e.key === 'Tab') {
      e.preventDefault();
      editor.cycleTab(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      tree.hideCtx();
      if (!$('#bottom-panel').classList.contains('collapsed')) {
        $('#bottom-panel').classList.add('collapsed');
      }
    }
  });

  // ---------- 多窗口（v0.1.51） ----------
  // 其它窗口改设置/主题 → 本窗口即时应用（state 缓存同步；不重开已打开的设置弹窗）
  window.api.onSettingsChanged((s) => {
    if (!s || typeof s !== 'object') return;
    const prev = state.settings;
    state.settings = s;
    if (s.theme && s.theme !== document.documentElement.getAttribute('data-theme')) {
      applyTheme(s.theme);
    }
    if (s.scrollbarWidth && s.scrollbarWidth !== prev.scrollbarWidth) {
      applyScrollbarWidth(s.scrollbarWidth);
    }
    if (s.wordWrap !== prev.wordWrap) editor.setWordWrap(s.wordWrap);
    if (s.indentSize !== prev.indentSize) editor.setIndentSize(s.indentSize);
  });
  // 同文件已在另一窗口打开（本窗口为后来者）→ 自动转只读，编辑仍可在标签右键解除；
  // 编辑窗口保存后经 file-changed 静默同步到本窗口（tabs.js 只读节流，不弹提示不抖动）
  window.api.onFileSharedOpen(({ path: sharedPath }) => {
    const tab = editor.findTabByPath(sharedPath);
    if (tab && !tab.kind) {
      editor.setTabReadOnly(tab, true);
      toast(`「${tab.name}」已在另一窗口打开，本窗口以只读打开（右键标签可解除）`);
    }
  });

  // ---------- 恢复上次目录与会话 ----------
  await favorites.load(); // 启动时渲染收藏列表 + 同步按钮状态
  if (state.settings.lastDirectory) {
    await openDirFromPath(state.settings.lastDirectory);
  }
  await restoreSession(); // 恢复上次会话（先恢复目录，再恢复标签，保证树定位可用）
  syncExternalTree(); // 需求1：启动后同步一次外部文件分支（幂等，兜底 restoreSession 提前返回的场景）

  updateRunButton();
  // S10：window.__app 仅开发环境暴露（冒烟/扩展测试在 dev 下运行，不受影响；打包版无此接口）
  if (!(await window.api.isPackaged())) {
    window.__app = { state, editor, tree, preview, find, globalSearch, python, openDirFromPath, aiPanel, executeAiTool, favorites, syncExternalTree, session: { save: () => persistSession(true), restore: restoreSession }, applyTheme, THEME_NAMES, DARK_THEMES };
  }
}

boot();
