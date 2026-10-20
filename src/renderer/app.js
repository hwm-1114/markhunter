// 应用入口：组装各模块
import { $, $$, showPrompt, toast, closeModal, openModal, initDragResize, escapeHtml, debounce, baseName } from './ui.js';
import { createTree } from './tree.js';
import { createEditor } from './tabs.js';
import { createFind } from './find.js';
import { createPreview } from './preview.js';
import { createGlobalSearch } from './globalsearch.js';
import { createPythonPanel } from './python.js';
import { createFavorites } from './favorites.js';
import { createOutline } from './outline.js';
import { createQuickOpen } from './quickopen.js';
import { createHelp, matchShortcut, shortcutRows } from './help.js';
import { createRecover } from './recover.js';
import { isMarkdown, isRunnableScript, langFor } from './ui.js';

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
    rootDir: null,       // 活动工作目录（全局搜索/新建的默认目标）
    sidebarRoots: [],    // v0.2.3 侧栏多目录根列表（首目录即活动目录的来源，须非嵌套）
    settings: await window.api.getSettings(),
  };

  let tree, editor, preview, find, globalSearch, python, outline, quickOpen, help;

  // 应用滚动条宽度
  const applyScrollbarWidth = (w) => {
    document.documentElement.style.setProperty('--scrollbar-width', (w || 10) + 'px');
  };
  applyScrollbarWidth(state.settings.scrollbarWidth);

  // ---------- 0.5.0 Phase 5a B8：编辑器 / 预览字号与行高 ----------
  // 落地方式 = **根元素 CSS 变量**（styles.css 的 :root 给默认值）：
  //   · 所有栏的 .cm-editor / .markdown-body 同时跟随 ⇒ 「作用于所有视图的 CM 与预览」天然满足，
  //     不需要给每个 pane 的 EditorView / preview 实例逐个派发（多视图一致性最省事的正确解）；
  //   · 范围夹取 / 脏值兜底都在渲染端做（settings.js 只负责白名单与默认值）；
  //   · 字号变化后必须 requestMeasure（CM 的字符宽度缓存与滚动高度按旧字号算的）。
  const FONT_LIMITS = { editorFontSize: [10, 32], editorLineHeight: [1, 2.6], previewFontSize: [10, 32] };
  const FONT_DEFAULTS = { editorFontSize: 13.5, editorLineHeight: 1.65, previewFontSize: 14.5 };
  function clampFont(key, v) {
    const [lo, hi] = FONT_LIMITS[key];
    const n = Number(v);
    if (!Number.isFinite(n)) return FONT_DEFAULTS[key];
    // ⚠️ 必须按 **2 位小数**归整，不能按 1 位：行高是倍数域且默认值/输入步长都是 2 位
    //    （默认 1.65、设置项 step 0.05），`Math.round(1.65 * 10) / 10` 会把它变成 **1.7**
    //    —— 落盘仍写 1.65、CSS 变量却是 1.7，settings.json 与界面出现静默漂移
    //    （2026-09 首轮验收就是被这条卡住的：ctrl-0-persisted=true 但字号复位断言为 false）。
    return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
  }
  function applyFonts(s) {
    const t = document.documentElement.style;
    t.setProperty('--mh-editor-font-size', clampFont('editorFontSize', s.editorFontSize) + 'px');
    t.setProperty('--mh-editor-line-height', String(clampFont('editorLineHeight', s.editorLineHeight)));
    t.setProperty('--mh-preview-font-size', clampFont('previewFontSize', s.previewFontSize) + 'px');
    if (editor) editor.refreshMeasure(); // boot 早期 editor 尚未创建（CSS 变量已就位，无需测量）
  }
  applyFonts(state.settings);

  // ---------- 0.5.0 Phase 5a E2：侧栏分区折叠并记忆（v0.11.0：左栏只剩文件树一个分区） ----------
  // ⚠️ 位置必须在 `createFavorites(...)` **之前**：收藏分区的初始折叠态要从这里取
  // （const/let 的 TDZ 会让"放到后面"直接抛 Cannot access before initialization）。
  // 折叠态写进 settings.sidebarCollapsed（键已加进 src/main/settings.js 白名单，否则会被静默丢弃）。
  // 只加/去容器上的 .collapsed 类：树内部的 expanded 集合、loadChildren 补载（J4）与可见性无关，
  // 折叠再展开后展开态原样保留。
  // v0.11.0：搜索分区随全局搜索一起迁出左侧栏（底部面板页签），大纲迁入正文区左栏 ——
  //   这里只保留 fav（右栏收藏分区，历史键名不变）与 tree 两键；旧 settings 里残留的 search 键
  //   会被 normalizeCollapsed 静默忽略（不写回、不报错）。
  const SIDEBAR_SECTIONS = ['fav', 'tree'];
  const normalizeCollapsed = (v) => {
    const o = {};
    for (const k of SIDEBAR_SECTIONS) o[k] = !!(v && typeof v === 'object' && v[k]);
    return o;
  };
  let sidebarCollapsed = normalizeCollapsed(state.settings.sidebarCollapsed);
  function applySidebarCollapsed(v, persist) {
    sidebarCollapsed = normalizeCollapsed(v);
    const bind = (blockSel, caretSel, on) => {
      const b = $(blockSel);
      if (b) b.classList.toggle('collapsed', on);
      const c = $(caretSel);
      if (c) c.textContent = on ? '▶' : '▼';
    };
    bind('#fav-block', '#fav-caret', sidebarCollapsed.fav);
    bind('#file-tree', '#tree-caret', sidebarCollapsed.tree);
    if (persist) window.api.setSettings({ sidebarCollapsed });
  }
  function toggleSidebarSection(key) {
    if (SIDEBAR_SECTIONS.indexOf(key) < 0) return sidebarCollapsed;
    applySidebarCollapsed({ ...sidebarCollapsed, [key]: !sidebarCollapsed[key] }, true);
    return sidebarCollapsed;
  }
  applySidebarCollapsed(sidebarCollapsed, false);
  $('#tree-header').addEventListener('click', () => toggleSidebarSection('tree'));

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
  // 0.5.0 Phase 2：判据与实例都**按该标签所属栏** —— 双栏下 `getActiveTab()` 只是「焦点栏的活动标签」，
  // 拿它做判据会漏掉**非焦点栏**的即时渲染（该栏的程序化变更 / 自己敲字），也会把 A 栏的 preview
  // 实例当成 B 栏的去渲染（mode/缩放/滚动都是实例级状态）。
  const debouncedPreviewRender = debounce((tab) => {
    // 触发时重新校验：期间可能已切标签 / 换栏 / 改模式 / 变文件类型
    const pid = editor.paneIdOf(tab) || editor.getFocusPaneId();
    const pv = previewFor(pid);
    if (editor.paneActiveOf(pid) === tab && isMarkdown(tab.name) && pv.getMode() !== 'edit') {
      // auto 标记：大文档（超过 preview.js 的 PREVIEW_AUTO_MAX_BYTES）不随编辑自动重渲（闸门在 preview.js 内）
      pv.render({ auto: true });
    }
  }, 250);
  const debouncedFindSearch = debounce(() => {
    if (findQuery()) find.runSearch(true);
  }, 250);
  // B1：大纲重建同样走防抖（解析全文标题是 O(文档) 成本；光标移动路径只切高亮，不重建）
  const debouncedOutlineRefresh = debounce(() => { if (outline) outline.refresh(); }, 250);

  // ---------- 初始化各模块 ----------
  editor = createEditor({
    getWordWrap: () => state.settings.wordWrap,
    getTabWrap: () => state.settings.tabWrap !== false, // v0.11.0：标签多行换行（像 VSCode Wrap Tabs）
    getIndentSize: () => state.settings.indentSize,
    getMaxFileSizeMB: () => state.settings.maxFileSizeMB, // v0.4.0：打开上限在 openFile 统一把关
    // v0.9.0：大文件状态条的「↵ 自动换行」= 应用级 wordWrap —— 与设置面板同一份状态：
    //  ① 立即更新 state（下次开 huge 标签按新值初始化）；② 同步 CM 与其它已开的大文件视图
    //  （editor.setWordWrap 内部会回推 huge，故这里只写状态 + 落盘）；③ 落盘（失败仅告警不打断）。
    onWordWrapChange: (on) => {
      const v = on === true;
      if (state.settings.wordWrap === v) return;
      state.settings.wordWrap = v;
      editor.setWordWrap(v);
      window.api.setSettings({ wordWrap: v }).then((s) => {
        if (s && typeof s === 'object') state.settings = s;
      }).catch(() => { /* 落盘失败：本次会话内仍按 v 生效，下次启动回旧值 */ });
    },
    onSaveStatus: (msg) => {
      $('#save-status').textContent = msg;
    },
    onDocChanged: (tab) => {
      // 自动保存（防抖）
      clearTimeout(tab.saveTimer);
      tab.saveTimer = setTimeout(() => editor.saveNow(tab), state.settings.autoSaveDelay);
      $('#save-status').textContent = '未保存…';
      // 实时更新预览（P1：250ms trailing 防抖合并击键；onTabSwitch/外部重载等仍即时渲染）
      // Phase 2：按**该标签所属栏**判定并取实例（见 debouncedPreviewRender 上方的说明）
      const pid = editor.paneIdOf(tab) || editor.getFocusPaneId();
      const pv = previewFor(pid);
      if (editor.paneActiveOf(pid) === tab && isMarkdown(tab.name) && pv.getMode() !== 'edit') {
        debouncedPreviewRender(tab);
      }
      // 文件内搜索实时刷新（P1：同样防抖，不抢占光标，避免打字时光标被拽走）
      if (findQuery()) debouncedFindSearch();
      // B1：大纲跟随文档内容（防抖重建；光标移动另有 onCursorMove 的轻量高亮路径）
      debouncedOutlineRefresh();
    },
    /** B1：光标/选区变化的统一出口（tabs.js 由派发事务的视图反查所属文档后回调）。
     *  只有**焦点栏**的文档才驱动大纲（大纲跟的就是焦点栏）；内容变了走防抖重建，
     *  纯移动光标只切 .current 高亮（零解析成本）。 */
    onCursorMove: (tab, line, docChanged) => {
      if (!outline || !tab) return;
      if (tab !== getActiveTab()) return;
      if (docChanged) debouncedOutlineRefresh();
      else outline.markLine(line);
    },
    onTabLeave: (oldTab) => {
      // 预览区滚动位置随标签记忆（编辑器滚动由 tabs.js switchTab 内部保存）
      const ph = previewHostOf(editor.paneIdOf(oldTab));
      if (ph && oldTab) oldTab.previewScrollTop = ph.scrollTop;
    },
    /** 标签/焦点栏切换的统一出口。
     *  focused=false 表示这是**非焦点栏**内部的切换（Phase 2）：只更新那一栏自己的图层显隐
     *  （编辑器 / 图片 / 对比 / 预览模式），**不碰**状态栏、树跟随、查找与运行按钮 ——
     *  那些是「全局单例 + 焦点栏」语义。 */
    onTabSwitch: (tab, focused = true) => {
      syncPreviewToFocus(); // 焦点栏可能刚变（Ctrl+1/2、点另一栏）→ preview 实例跟着走
      // 该标签所属栏的预览实例负责它自己那一栏的图层显隐（栏内预览模式按栏独立）
      const pid = tab ? editor.paneIdOf(tab) : editor.getFocusPaneId();
      try { previewFor(pid).applyMode(); } catch (err) { console.warn('[preview]', err && err.message ? err.message : err); }
      if (!focused) return;
      updateRunButton();
      if (outline) outline.refresh(); // B1：切标签 → 大纲按新文档重建/隐藏（非 markdown 整体隐藏）
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
        // 无记录 → 顶部（避免残留上一标签的滚动偏移）。Phase 2：取该标签所属栏的预览区。
        const paneId = editor.paneIdOf(tab);
        const ph = previewHostOf(paneId);
        if (ph) {
          const target = typeof tab.previewScrollTop === 'number' ? tab.previewScrollTop : 0;
          const restorePv = (n) => {
            if (editor.paneActiveOf(paneId) !== tab) return;
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
    onRequestClose: (tab, paneId) => {
      // Phase 3：**不再无条件预保存** —— 关的是哪一条视图由 tabs.js 的 closeTab 判定：
      // 同一文件在别的栏还有视图时是**视图级关闭**（不落盘、不清脏），只有关掉最后一个视图
      // 才走文档级路径（先保存脏内容再移除文档）。原来的 `if (tab.dirty) saveNow(tab)` 会把
      // 视图级关闭也变成一次写盘，直接违反 G3。
      editor.closeTab(tab, paneId ? { paneId } : {});
    },
    onSessionChange: () => {
      persistSession();
      syncExternalTree(); // 需求1：标签增删/切换后同步外部文件分支
    },
  });

  // ---------- 0.5.0 多视图 Phase 2：每栏一个 preview 实例 ----------
  // 「栏内预览模式（edit/split/preview）必须按栏独立」是 0.3.0 §4-E5 的 P0：mode / 缩放 /
  // 滚动同步都是 createPreview 的实例闭包变量，**按栏各建一个实例**即天然独立。
  // `preview` 这个变量恒指向**焦点栏**的实例（由 syncPreviewToFocus 维护），
  // 因此既有调用点 `preview.getMode()/render()/applyMode()/cycleMode()/resetZoom()` 一个字都不用改。
  // 缓存键是栏的宿主根节点（WeakMap）：合栏/重新分栏会换 DOM，旧实例自然失效，不串栏也不泄漏。
  const previews = new WeakMap(); // pane.root -> preview 实例
  function previewFor(paneId) {
    const p = editor.getPaneElsById(paneId);
    if (!p) return preview;
    let pv = previews.get(p.root);
    if (pv) return pv;
    pv = createPreview(
      () => editor,
      () => editor.paneActiveOf(paneId), // 本栏的活动标签（不是全局 getActiveTab）
      () => DARK_THEMES.includes(document.documentElement.getAttribute('data-theme')),
      {
        paneId,
        els: () => {
          const q = editor.getPaneElsById(paneId);
          return q
            ? {
                previewHost: q.previewHost,
                contentEl: q.previewContent,
                editorHost: q.editorHost,
                divider: q.divider,
                imageHost: q.imageHost,
                diffHost: q.diffHost,
                viewerBar: null, // v0.9.0：大文件查看器悬浮操作条已删除（保留键位兼容 preview 实例签名）
                zoomBadge: q.zoomBadge,
              }
            : null;
        },
        getView: () => {
          const q = editor.getPaneElsById(paneId);
          return q ? q.view : null;
        },
      }
    );
    previews.set(p.root, pv);
    return pv;
  }
  /** 把 `preview` 指到焦点栏的实例（切换焦点栏 / 分栏 / 合栏后必须调一次） */
  function syncPreviewToFocus() {
    const pv = previewFor(editor.getFocusPaneId());
    if (pv) preview = pv;
    return preview;
  }
  /** 某栏的预览滚动容器（预览滚动位置记忆 / 状态栏「顶部、底部」按钮用） */
  function previewHostOf(paneId) {
    const p = editor.getPaneElsById(paneId);
    return p ? p.previewHost : $('#preview-host');
  }

  preview = previewFor(editor.getFocusPaneId());
  // H1：boot 时 applyTheme（上方 L114 附近）先于 preview 创建，mermaid 仍停留在模块级 default（浅色）。
  // 此处补一次 refreshMermaid，按当前持久化主题的明暗初始化 mermaid（明暗守卫去重，无图零成本）。
  preview.refreshMermaid();
  // 启动时若恢复了多栏（Phase 3 的 layout；本阶段恒单栏）→ 每栏的预览也各初始化一次（去重幂等）
  for (let i = 0; i < editor.getPaneCount(); i++) {
    const p = editor.getPaneEls(i);
    if (p) previewFor(p.id).refreshMermaid();
  }
  find = createFind(() => editor, getActiveTab);
  // v0.6.0：第三参 onReveal —— 文件名/目录名命中结果点击时在左侧文件树定位（不打开文件）
  globalSearch = createGlobalSearch(
    () => state.rootDir,
    openFileAt,
    (p) => { tree.reveal(p).catch(() => {}); }
  );
  python = createPythonPanel(getActiveTab, () => state.settings, (tab) => editor.saveNow(tab));
  tree = createTree();
  // B1：大纲 / TOC 侧栏（数据源 = 焦点栏的活动文档；见 outline.js 顶部三条硬口径）
  // v0.11.0：增加用户显隐偏好（#btn-outline → settings.outlineVisible），用户可整体隐藏大纲栏。
  outline = createOutline({
    getEditor: () => editor,
    getActiveDoc: () => getActiveTab(),
    getVisible: () => state.settings.outlineVisible !== false,
  });
  outline.refresh();
  // A1：Ctrl+P 快速打开（数据源 = search-worker 的文件清单，见 quickopen.js）
  quickOpen = createQuickOpen({
    getRootDir: () => state.rootDir,
    onOpen: (p) => {
      editor.openFile(p);
      tree.reveal(p).catch(() => {}); // 与树双击打开同口径：打开并定位
    },
  });
  // F1：快捷键帮助面板在下方「快捷键」段创建（它的 actions 表就是那一段的 SHORTCUT_ACTIONS，
  // 面板会据此标注"未接线"的键位，避免表里加了键却忘了接动作）。
  // ---------- 崩溃恢复（0.5.0 挂账收尾）：huge:doc-recover-list 的渲染端消费方 ----------
  // 主进程只给"可恢复块表列表"，重挂会话的通道不存在（overlay*.js 属禁区）⇒ 恢复在本模块内
  // 完成：读恢复区 → 两道身份闸（stat + docKey）→ 按 run 倒序回放 huge:doc-edit。
  const recover = createRecover({ api: window.api, editor });

  function updateRunButton() {
    // v0.6.0：▶ 运行可用口径扩为 .py / .bat / .cmd（主进程 python:run 同步支持批处理）
    const tab = getActiveTab();
    $('#btn-run-py').disabled = !(tab && !tab.kind && isRunnableScript(tab.name));
  }

  // ---------- B8：字号步进（Ctrl+= / Ctrl+-）与「视图缩放复位」（Ctrl+0） ----------
  /** 步进编辑器字号并落盘（设置项与快捷键同一个出口：单测/冒烟只需覆盖这一条路径）。
   *  **当前值从主进程现读**（而不是 state.settings 缓存）：settings.json 是唯一真值，
   *  另一个窗口刚改过 / 本窗口刚被外部改过时，缓存可能是旧的 —— 差值算错就会出现
   *  "按一下 +1 却跳了两格"。读一次设置的 IPC 成本远低于一次键击的感知阈值。 */
  async function stepEditorFont(delta) {
    const fresh = await window.api.getSettings();
    state.settings = fresh;
    const cur = clampFont('editorFontSize', fresh.editorFontSize);
    const next = clampFont('editorFontSize', Math.round((cur + delta) * 100) / 100);
    if (next === cur) {
      applyFonts(fresh); // 极端情况：落库值是越界脏数据 → 顺手把显示拉回夹取后的值
      toast(delta > 0 ? `编辑器字号已是上限（${cur}px）` : `编辑器字号已是下限（${cur}px）`);
      return next;
    }
    state.settings = await window.api.setSettings({ editorFontSize: next });
    applyFonts(state.settings);
    toast(`编辑器字号 ${next}px`);
    return next;
  }
  /** Ctrl+0 的语义（0.5.0 Phase 5a 定义）：**视图缩放复位** ——
   *  编辑器字号 / 行高 / 预览字号回到默认值，**并且**预览缩放回到 100%（后者是 Ctrl+0 的原有行为，
   *  见冒烟 zoomPreview：Ctrl+滚轮放大后 Ctrl+0 → #preview-host 的 style.zoom === '1'）。
   *  两者合一是「一键把视图还原成默认观感」，不再只复位预览缩放。 */
  async function resetViewScale() {
    // 预览缩放**同步**复位：这是 Ctrl+0 的原有行为，既有冒烟用例 zoomPreview 在派发按键后
    // 只等 100ms 就断言 `#preview-host` 的 style.zoom === '1' —— 放到 IPC 之后会被拖慢而变红。
    preview.resetZoom(); // 焦点栏的预览实例（既有语义不变）
    // 字号/行高**也同步先刷一次 DOM**（乐观）：落盘是异步 IPC，若等它返回再改 CSS 变量，
    // 「按下 Ctrl+0」到「界面真的变回默认」之间会多出一个往返的可见延迟 —— 冒烟实测在派发
    // 按键的同一 tick 里读 CSS 变量仍是旧值。先按默认值应用一次，再用主进程返回的真值应用
    // 一次（幂等；若落盘被拒/被夹取，最终以真值为准）。
    applyFonts({ ...state.settings, ...FONT_DEFAULTS });
    state.settings = await window.api.setSettings({
      editorFontSize: FONT_DEFAULTS.editorFontSize,
      editorLineHeight: FONT_DEFAULTS.editorLineHeight,
      previewFontSize: FONT_DEFAULTS.previewFontSize,
    });
    applyFonts(state.settings);
    toast('视图缩放已复位（字号与预览缩放回默认）');
  }

  // ---------- 状态栏滚动快捷按钮：回顶部 / 到底部 ----------
  // 仅预览模式下主面板是预览区（滚预览）；其余滚编辑器（tabs.js 内处理图片/分段标签）
  // Phase 2：预览区取**焦点栏**的那一个（preview 实例已经跟着焦点栏走）
  $('#btn-scroll-top').addEventListener('click', () => {
    const tab = getActiveTab();
    if (tab && tab.kind !== 'image' && preview.getMode() === 'preview') {
      previewHostOf(editor.paneIdOf(tab)).scrollTop = 0;
      return;
    }
    editor.scrollToTop();
  });
  $('#btn-scroll-bottom').addEventListener('click', () => {
    const tab = getActiveTab();
    if (tab && tab.kind !== 'image' && preview.getMode() === 'preview') {
      const ph = previewHostOf(editor.paneIdOf(tab));
      ph.scrollTop = ph.scrollHeight;
      return;
    }
    editor.scrollToBottom();
  });

  // ---------- 会话保持：标签快照持久化（防抖 600ms） + 跨重启恢复 ----------
  let sessionTimer = null;
  let lastExtToastPath = null; // 需求1：外部文件 toast 去重（同一路径只提示一次）

  /** 将当前打开标签快照写入设置；force=true 立即落盘，否则 600ms 防抖合并。
   *  多窗口（v0.2.1）：仅焦点窗口写入 —— 后台窗口的标签变化不再覆盖最后活动窗口的会话。
   *
   *  **`opts.final`（0.5.0 Phase 3 新增）**：关窗/卸载路径（`beforeunload`）专用 —— 它是**唯一**
   *  允许在无焦点时写盘的入口。窗口焦点守卫本身**语义不变**（后台窗口依然不写会话，
   *  `sessionRestore`/`pinSessionPersist`/`extSessionRestore` 三项用例依赖它）。
   *  `window.__app.session.save()` 仍走 `persistSession(true)`（**不带 final**），口径不变。 */
  function persistSession(force = false, opts = {}) {
    if (!document.hasFocus() && !opts.final) return;
    if (!force) {
      clearTimeout(sessionTimer);
      sessionTimer = setTimeout(() => persistSession(true), 600);
      return;
    }
    const s = editor.getSession();
    if (!s.paths.length) {
      window.api.setSettings({ lastSession: null });
    } else {
      // Phase 3：三键（paths/active/pinned）保持不变 + 新增 layout（每栏文档/活动项/pin + 比例 + 焦点栏）
      window.api.setSettings({ lastSession: { paths: s.paths, active: s.active, pinned: s.pinned, layout: s.layout } });
    }
  }

  // 关窗/刷新前的最后一次落盘：**只有这里**允许用 opts.final（无焦点也写，否则后台窗口被关闭时
  // 最后一次布局调整会丢）。setSettings 是异步 IPC，但消息在 beforeunload 期间已同步投递给主进程，
  // 主进程侧照常处理（实测有效）；渲染端不等待返回，失败也不阻断关窗。
  window.addEventListener('beforeunload', () => {
    try { persistSession(true, { final: true }); } catch { /* 关窗不因会话写入失败中断 */ }
  });

  /** 会话布局归一化（Phase 3 的向后兼容入口）。返回 `{ panes: [{docs, active, pinned}], sizes, focus }`。
   *   · 无 `layout`（旧版本写出的 `{paths,active,pinned}`）→ 映射成**单栏**，顺序逐位不变；
   *   · `layout.panes` 多于 2 栏 / `sizes` 长度不匹配 → 回落单栏并 console.warn（L6 的静默口径）；
   *   · 上限：总视图数 ≤ **240**、单栏 ≤ **200**（0.3.0 §2.5），超出的部分截断丢弃。 */
  function normalizeSessionLayout(ls) {
    const MAX_TOTAL = 240;
    const MAX_PER_PANE = 200;
    const paths = Array.isArray(ls.paths) ? ls.paths.slice() : [];
    const single = (why) => {
      if (why) console.warn('[session] layout 不可用（' + why + '），回落单栏');
      return { panes: [{ docs: paths.slice(0, MAX_PER_PANE), active: ls.active, pinned: ls.pinned }], sizes: null, focus: 0 };
    };
    const ly = ls.layout;
    if (!ly || !Array.isArray(ly.panes) || ly.panes.length === 0) return single('旧格式无 layout');
    if (ly.panes.length > 2) return single('栏数 ' + ly.panes.length + ' > 2');
    if (ly.sizes != null && (!Array.isArray(ly.sizes) || ly.sizes.length < ly.panes.length)) return single('sizes 长度不匹配');
    let budget = MAX_TOTAL;
    const panesPlan = ly.panes.map((p) => {
      const raw = (p && Array.isArray(p.docs)) ? p.docs.filter((d) => typeof d === 'string' && d) : [];
      const uniq = [];
      for (const d of raw) if (uniq.indexOf(d) < 0) uniq.push(d); // 栏内去重（防御手写/损坏的会话）
      const docs = uniq.slice(0, Math.max(0, Math.min(MAX_PER_PANE, budget)));
      budget -= docs.length;
      return { docs, active: p && p.active, pinned: (p && Array.isArray(p.pinned)) ? p.pinned : [] };
    });
    if (!panesPlan.some((p) => p.docs.length)) return single('layout 内没有任何文档');
    return { panes: panesPlan, sizes: ly.sizes, focus: ly.focus };
  }

  /** 启动时恢复上次会话：并行恢复标签（P9：并发 6 个 openFile，串行逐个打开在大会话下拖慢启动），
   *  失败静默跳过（仅 console.warn）。
   *
   *  **Phase 3（G4）**：按 `layout` 恢复多栏 —— 顺序不可改（理由见每步注释）：
   *   ① 归一化 layout（无 layout 的旧会话 → 单栏，逐位兼容）；
   *   ② 先建栏（第 2 栏要在往里放文档之前就存在）；
   *   ③ 逐栏恢复：同一路径第二次出现时**复用已有 Document**（`attachViewToPane`），
   *      **读盘只发生一次**（否则大文件读两遍、分段标签会建两份 chunk 状态，保存时互相截断）；
   *   ④ 恢复全局标签顺序（每栏相对顺序 = 会话顺序）；
   *   ⑤ 应用比例 → 应用焦点栏 → 最后激活各栏的活动项；
   *   ⑥ 上限：总视图数 ≤ 240、单栏 ≤ 200（在 normalizeSessionLayout 里截断）。 */
  async function restoreSession() {
    const ls = state.settings.lastSession;
    if (!ls || !Array.isArray(ls.paths) || ls.paths.length === 0) return;
    const plan = normalizeSessionLayout(ls);
    // ① 建栏：layout 里多于 2 栏已在 normalize 阶段回落单栏（硬上限 2 不变）。
    //    **反向也要归一**：快照是单栏而当前窗口已是双栏（同一窗口内再次 restore、或恢复前
    //    用户自己分过屏）→ 先合并回单栏，否则"恢复结果 ≠ 快照"，界面会留下快照里没有的第二栏。
    if (plan.panes.length <= 1 && editor.getPaneCount() > 1) editor.mergePanes();
    if (plan.panes.length > 1 && editor.getPaneCount() < 2) editor.openSecondPane('right');
    // ② 逐栏并行打开（外层按栏串行：第 2 栏要复用第 1 栏已经建好的 Document）；
    //    内层保持既有的固定并发 6 限流池（主进程 IPC 压力已在 v0.4.0 标定过）
    const CONCURRENCY = 6;
    for (let i = 0; i < plan.panes.length && i < 2; i++) {
      const list = plan.panes[i].docs;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
        while (cursor < list.length) {
          const p = list[cursor++];
          try {
            const doc = editor.findTabByPath(p);
            if (doc) editor.attachViewToPane(doc, i); // 同一 Document 的第二/多个视图：不重新读盘
            else await editor.openFile(p, { silent: true, paneIndex: i }); // L6：恢复失败静默（不弹 alertBox）
          } catch (err) {
            console.warn('[session] 恢复标签失败（已跳过）:', p, err && err.message ? err.message : err);
          }
        }
      });
      await Promise.all(workers);
    }
    // ③ 全局标签顺序 = 各栏文档按栏顺序拼接去重（每栏的相对顺序因此与会话一致，
    //    标签栏按栏过滤后就是会话里的顺序）
    const ordered = [];
    for (const p of plan.panes) for (const d of p.docs) if (ordered.indexOf(d) < 0) ordered.push(d);
    if (ordered.length > 1) editor.reorderTabs(ordered);
    // ④ 比例 → 焦点栏 → 各栏的活动项与 pin
    if (plan.sizes) editor.setPaneSizes(plan.sizes);
    if (plan.panes.length > 1 && Number.isInteger(plan.focus) && plan.focus >= 0 && plan.focus < plan.panes.length) {
      // 必须显式应用（含 focus=0）：建第 2 栏时焦点被挪到了新栏，不还原就与快照不符
      editor.focusPaneIndex(plan.focus);
    }
    let anyPinned = false;
    for (let i = 0; i < plan.panes.length && i < 2; i++) {
      const docs = plan.panes[i].docs;
      const ai = plan.panes[i].active;
      if (Number.isInteger(ai) && ai >= 0 && ai < docs.length) {
        try {
          // 已存在 → 在该栏激活（不重新读盘）；不存在（文件打不开）→ 回落它实际所在的栏
          await editor.openFile(docs[ai], { silent: true, paneIndex: i });
        } catch (err) {
          console.warn('[session] 激活标签失败:', docs[ai], err && err.message ? err.message : err);
        }
      }
      const pinSet = new Set((plan.panes[i].pinned || []).filter((n) => Number.isInteger(n) && n >= 0 && n < docs.length));
      for (const idx of pinSet) {
        const t = editor.findTabByPath(docs[idx]);
        if (t) { editor.setPinned(t, true); anyPinned = true; }
      }
    }
    if (anyPinned) editor.renderTabs(); // 一次重绘，保证 pin 标记同步
    // 焦点栏**最后再钉一次**：上面逐栏激活的过程里，任何"把焦点带到该栏"的路径都可能改写它
    // （openFile 的批量路径已不再改焦点，这里再兜一次，保证与快照一致）
    if (plan.panes.length > 1 && Number.isInteger(plan.focus) && plan.focus >= 0 && plan.focus < plan.panes.length) {
      editor.focusPaneIndex(plan.focus);
    }
    // 兜底：旧格式（无 layout）的 active 下标必须继续生效（既有的 sessionRestore/restoreParallel 口径）
    if (!plan.panes.some((p) => Number.isInteger(p.active) && p.active >= 0)) {
      const a = typeof ls.active === 'number' && ls.active >= 0 && ls.active < ls.paths.length ? ls.active : -1;
      if (a >= 0) {
        try {
          await editor.openFile(ls.paths[a], { silent: true });
        } catch (err) {
          console.warn('[session] 激活标签失败:', ls.paths[a], err && err.message ? err.message : err);
        }
      }
    }
    syncExternalTree(); // 需求1：外部文件虚拟分支重渲染（幂等）
    persistSession(true); // 强制落盘：确保最终快照包含 pinned 与 layout
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
    // v0.2.1：树右键「与基准对比」—— 读取两文件开对比标签（超限走截断对比）
    // v0.11.0：带上 leftPath/rightPath，对比视图可「跳回原文」对应行
    onCompareFiles: async (base, target) => {
      try {
        const [a, b] = await Promise.all([window.api.readFile(base), window.api.readFile(target)]);
        editor.openDiffTab({
          leftLabel: baseName(base),
          leftContent: a.content,
          leftPath: base,
          rightLabel: baseName(target),
          rightContent: b.content,
          rightPath: target,
          exportDir: state.rootDir || '',
        });
      } catch (err) {
        toast('读取对比文件失败：' + (err.message || err));
      }
    },
    // v0.11.0：树右键「与当前文档对比」—— 当前编辑器文档（含未保存内容）↔ 树中任意文件
    onCompareWithActive: async (targetPath) => {
      const cur = getActiveTab();
      if (!cur || cur.kind || !cur.state) {
        toast('请先在编辑器中打开一个可编辑的文本文档再对比');
        return;
      }
      try {
        const data = await window.api.readFile(targetPath);
        editor.openDiffTab({
          leftLabel: baseName(targetPath),
          leftContent: data.content,
          leftPath: targetPath,
          rightLabel: cur.name,
          rightContent: cur.state.doc.toString(),
          rightPath: cur.path || null,
          exportDir: state.rootDir || '',
        });
      } catch (err) {
        toast('读取对比文件失败：' + (err.message || err));
      }
    },
    onSwitchRoot: (dir) => openDirFromPath(dir), // 需求1：外部区目录行「切换工作目录到此目录」
    // v0.2.3 多目录：根行关闭 / 设为活动；拖拽移动后同步已打开标签路径
    onRootClose: (dir) => closeSidebarRoot(dir),
    onActivateRoot: (dir) => openDirFromPath(dir), // 已在根列表 → 仅切换活动目录
    getOpenPaths: () => editor.getSession().paths,
    onClosePath: (p, newPath) => {
      const tab = editor.findTabByPath(p);
      if (tab) {
        if (newPath) {
          tab.path = newPath;
          tab.name = newPath.split(/[\\/]/).pop();
          // v0.6.0：扩展名随重命名改变时，语言模式按新扩展名热切换 —— 此前只改
          // path/name，tab.lang 与编辑器语法高亮停留在旧扩展名（.txt 改 .md 后
          // 预览/高亮双双不生效的根因之一）。多视图下对每个绑定视图 reconfigure。
          editor.reconfigureTabLang(tab, langFor(newPath));
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
          // 依赖扩展名的 UI 全部跟随刷新：预览图层显隐（md 才有）、预览按钮、
          // 大纲显隐（非 md 整体隐藏）、▶ 运行按钮（.py/.bat/.cmd）
          const pid = editor.paneIdOf(tab) || editor.getFocusPaneId();
          try { previewFor(pid).applyMode(); } catch (err) { console.warn('[rename]', err && err.message ? err.message : err); }
          setPreviewLabel();
          updateRunButton();
          if (outline) outline.refresh();
        } else {
          // 删除路径：不保存（save:false）—— 否则 dirty 标签的保存会把已删除的文件写回磁盘
          editor.closeByPath(p, false, { save: false });
        }
      } else {
        // 可能是目录删除
        editor.closeByPath(p, true, { save: false });
      }
    },
  });

  // ---------- 打开目录（v0.2.3 多目录侧栏） ----------
  const normKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

  /** v0.11.0：窗口标题 = 当前打开的目录（任务栏可分辨不同窗口打开的是哪个目录）。
   *  v0.12.0（用户反馈）：**只显示最后一级目录名**（完整路径太长，任务栏标签看不完整）；
   *  多窗口时通常最后一级目录名足以分辨，未打开目录时回退「MarkHunter」。
   *  渲染端改 document.title，Electron 默认把页面标题同步到窗口标题（任务栏悬停缩略图可见）。 */
  function applyWindowTitle() {
    const dir = state.rootDir ? String(state.rootDir) : '';
    const leaf = dir ? (dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || dir) : '';
    document.title = leaf || 'MarkHunter';
  }

  /** 激活某根为活动目录：重渲染侧栏 + 同步主进程根集合 + 刷新收藏/外部分支（openDirFromPath 公共尾段） */
  function activateSidebarRoot(dir) {
    state.rootDir = dir;
    applyWindowTitle(); // v0.11.0：任务栏标题跟随活动目录
    $('#dir-label').textContent = dir;
    $('#dir-label').title =
      state.sidebarRoots.length > 1
        ? state.sidebarRoots.map((r) => (normKey(r) === normKey(dir) ? '★ ' : '') + r).join('\n')
        : dir;
    return tree
      .setRoots(state.sidebarRoots, dir)
      .then(async () => {
        window.api.setSettings({ lastDirectory: dir, sidebarRoots: state.sidebarRoots });
        window.api.setRootDirs(state.sidebarRoots, dir); // S1：主进程路径校验基准 = 全部侧栏根
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

  /** 按路径直接打开目录（选择对话框 / 右键菜单 / 启动恢复 / 点击收藏项共用）。
   *  v0.2.3 多目录：目录加入侧栏根列表（去重、禁嵌套、上限 12）并设为活动目录；
   *  已在列表中的目录 → 仅切换活动。
   *  opts.fromLaunch：来自「右键 --dir / 二次启动」等外部指定目录的场景 —— 与已打开根目录
   *  存在包含关系时不再直接拒绝（那样右键盘符/父目录会像"没反应"），改为：
   *  目标在某根内 → 激活该根并在树里定位；目标是若干根的祖先 → 用目标替换这些子根。 */
  function openDirFromPath(dir, opts = {}) {
    if (!dir) return Promise.resolve(false);
    return window.api
      .readTree(dir) // 可读性预检（无效目录直接失败，不进侧栏）
      .then(() => {
        const nd = normKey(dir);
        const existed = state.sidebarRoots.find((r) => normKey(r) === nd);
        if (existed) {
          if (state.rootDir && normKey(state.rootDir) === nd) return true; // 已是活动目录
          return activateSidebarRoot(existed);
        }
        if (opts.fromLaunch) {
          const inside = state.sidebarRoots.find((r) => nd.startsWith(normKey(r) + '/'));
          if (inside) {
            // 目标落在某个已打开根内：不新增根，直接激活该根并把树定位到目标目录
            return activateSidebarRoot(inside).then(() => {
              tree.reveal(dir).catch(() => {});
              return true;
            });
          }
          const contained = state.sidebarRoots.filter((r) => normKey(r).startsWith(nd + '/'));
          if (contained.length) {
            state.sidebarRoots = state.sidebarRoots.filter((r) => !contained.includes(r));
            toast(`已用「${dir}」替换侧栏中 ${contained.length} 个被包含的目录`);
          }
        }
        // 嵌套防御：根间嵌套会让 isInsideRoot「任根判定」产生歧义（外部/内部归属不定）
        for (const r of state.sidebarRoots) {
          const nr = normKey(r);
          if (nd.startsWith(nr + '/') || nr.startsWith(nd + '/')) {
            toast('该目录与侧栏已打开的目录存在嵌套关系，无法同时打开');
            return false;
          }
        }
        if (state.sidebarRoots.length >= 12) {
          toast('侧栏目录已达上限（12 个），请先关闭部分目录');
          return false;
        }
        state.sidebarRoots.push(dir);
        return activateSidebarRoot(dir);
      })
      .catch(() => false);
  }

  /** 关闭侧栏某根（根行 ✕ / 右键菜单）：仅从侧栏移除，不删磁盘文件；关闭活动根时活动转给剩余第一个根 */
  function closeSidebarRoot(dir) {
    const i = state.sidebarRoots.findIndex((r) => normKey(r) === normKey(dir));
    if (i < 0) return Promise.resolve(false);
    state.sidebarRoots.splice(i, 1);
    const wasActive = state.rootDir && normKey(state.rootDir) === normKey(dir);
    if (!wasActive) return activateSidebarRoot(state.rootDir); // 非活动根：重渲染 + 重同步即可
    const next = state.sidebarRoots[0] || null;
    if (next) return activateSidebarRoot(next);
    // 全部关闭：回到空侧栏
    state.rootDir = null;
    applyWindowTitle(); // v0.11.0：无目录 → 标题回退 MarkHunter
    $('#dir-label').textContent = '未打开目录';
    $('#dir-label').title = '';
    window.api.setSettings({ lastDirectory: '', sidebarRoots: [] });
    window.api.setRootDirs([], null);
    favorites.syncState();
    return tree
      .setRoots([], null)
      .then(() => syncExternalTree())
      .then(() => true);
  }

  // ---------- 目录收藏 ----------
  const favorites = createFavorites({
    onOpenDir: openDirFromPath,
    getRootDir: () => state.rootDir,
    // E2：收藏分区折叠态与另外两个分区同源（settings.sidebarCollapsed），避免两处 caret 打架
    initialCollapsed: sidebarCollapsed.fav,
    onCollapseChange: (v) => applySidebarCollapsed({ ...sidebarCollapsed, fav: !!v }, true),
  });
  $('#btn-toggle-fav').addEventListener('click', () => favorites.toggle());

  // ---------- 右侧收藏栏（可隐藏 / 可 pin 常显；#fav-block 已从左栏原样搬入 #fav-rail） ----------
  // 状态机（设置键 favRailOpen / favRailPinned / favRailWidth，均在 settings.js 白名单）：
  //   · favRailPinned=true                  → 挤压式常驻（参与 #main 的 flex 布局，分隔条拖宽并持久化）；
  //   · !pinned && favRailOpen=true         → 覆盖式（.overlay 浮在编辑区右侧，不占布局），
  //                                           点栏外 / Esc / ✕ 关闭按钮 → favRailOpen=false；
  //   · !pinned && !open                    → 隐藏。
  // 顶栏「🗂 收藏栏」（#btn-fav-rail）= 开合入口：pin 态下点它 = 取消 pin 并关闭 —— 语义恒为「切换收藏栏」。
  // ⚠️ 既有「☆ 收藏」（#btn-toggle-fav）保持「收藏/取消当前目录」语义不动：
  //    smoke.js 的 favAdd/favRemove/favPersist 点击它断言星标行为（smoke.js:1301-1360），
  //    因此右栏开合没有复用那个按钮，而是新增独立入口。
  const FAVRAIL_WIDTH_DEFAULT = 260;
  const FAVRAIL_WIDTH_MIN = 200; // initDragResize 的 min；CSS 另有 min-width:180 保底（极端小窗夹取）
  const FAVRAIL_WIDTH_MAX = 480;
  const clampFavRailWidth = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return FAVRAIL_WIDTH_DEFAULT;
    return Math.min(FAVRAIL_WIDTH_MAX, Math.max(FAVRAIL_WIDTH_MIN, Math.round(n)));
  };
  let favRailOpen = state.settings.favRailOpen === true;
  let favRailPinned = state.settings.favRailPinned === true;
  let favRailWidth = clampFavRailWidth(state.settings.favRailWidth);
  const favRailEl = $('#fav-rail');
  const favRailDivider = $('#favrail-divider');
  const btnFavPin = $('#btn-fav-pin');
  /** 按当前三态刷 DOM（.open/.pinned/.overlay/.hidden 类即测试断言钩子） */
  function applyFavRail() {
    const visible = favRailPinned || favRailOpen;
    favRailEl.classList.toggle('hidden', !visible);
    favRailEl.classList.toggle('open', visible);
    favRailEl.classList.toggle('pinned', favRailPinned);
    favRailEl.classList.toggle('overlay', visible && !favRailPinned);
    favRailDivider.classList.toggle('hidden', !(visible && favRailPinned)); // 分隔条只在挤压式常驻时出现
    favRailEl.style.width = clampFavRailWidth(favRailWidth) + 'px';
    btnFavPin.classList.toggle('on', favRailPinned);
    btnFavPin.title = favRailPinned ? '取消固定（回到浮层模式）' : '固定为常驻栏（挤压布局）';
  }
  function persistFavRail() {
    // 本地缓存同步（state.settings 是 __app.state.settings 的真源）+ 落盘（settings:changed 不回环本窗口）
    state.settings.favRailOpen = favRailOpen;
    state.settings.favRailPinned = favRailPinned;
    state.settings.favRailWidth = favRailWidth;
    window.api.setSettings({ favRailOpen, favRailPinned, favRailWidth });
  }
  /** 开合（pin 态下 = 取消 pin 并关闭；非 pin = open 取反）。返回操作后的可见性 */
  function toggleFavRail() {
    if (favRailPinned) {
      favRailPinned = false;
      favRailOpen = false;
    } else {
      favRailOpen = !favRailOpen;
    }
    persistFavRail();
    applyFavRail();
    return favRailPinned || favRailOpen;
  }
  /** pin 开关：pin 上即常显（隐含 open=true）；取消 pin 保持 open → 退为覆盖式浮层 */
  function setFavRailPinned(on) {
    favRailPinned = !!on;
    if (favRailPinned) favRailOpen = true;
    persistFavRail();
    applyFavRail();
    return favRailPinned;
  }
  /** 关闭：覆盖式 → open=false；pin 态 → 取消 pin 并关闭（与 toggle 的 pin 分支同语义） */
  function closeFavRail() {
    if (!favRailPinned && !favRailOpen) return false;
    favRailOpen = false;
    favRailPinned = false;
    persistFavRail();
    applyFavRail();
    return true;
  }
  applyFavRail(); // 启动即应用（默认 open=false/pinned=false → hidden，观感与旧版左栏折叠态无关）
  $('#btn-fav-rail').addEventListener('click', () => toggleFavRail());
  btnFavPin.addEventListener('click', () => setFavRailPinned(!favRailPinned));
  $('#btn-favrail-close').addEventListener('click', () => closeFavRail());
  // 覆盖式的「点栏外收起」（挤压式常驻不收）；mousedown 先于 click，栏内点击与 toggle 按钮自身除外
  document.addEventListener('mousedown', (e) => {
    if (!favRailOpen || favRailPinned) return;
    if (e.target.closest('#fav-rail') || e.target.closest('#btn-fav-rail')) return;
    closeFavRail(); // 此分支 pinned 必为 false → 只清 open
  });
  // 覆盖式 Esc 收起：右键菜单 / 弹窗开着时让位（ui.js 的全局 Esc 处理器负责它们，不重复关两层）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !favRailOpen || favRailPinned) return;
    if (!$('#ctx-menu').classList.contains('hidden')) return;
    if (!$('#modal-mask').classList.contains('hidden')) return;
    closeFavRail();
  });

  async function openDirectory() {
    const dir = await window.api.selectDirectory();
    if (!dir) return;
    await openDirFromPath(dir);
  }

  // 右键「用 MarkHunter 打开」：以指定目录启动。
  // 竞态修复：did-finish-load 发来的 open-dir 事件可能早于 boot 的「上次目录恢复」到达，
  // 直接调用会被随后的 lastDirectory 恢复覆盖（侧栏停在旧目录）—— 先登记 externalDir，
  // 由 boot 的恢复段优先采用；boot 完成后再收到的事件（second-instance 新窗口/运行中重开）直通执行。
  let bootDirSettled = false;
  let externalDir = null;
  let openDirFromArg = false; // 本次启动是否由「右键 --dir / 二次启动」指定了目录
  window.api.onOpenDir((dir) => {
    externalDir = dir;
    openDirFromArg = true;
    if (bootDirSettled) openDirFromPath(dir);
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
      toast((type === 'dir' ? '📁 已创建目录 ' : '📝 已创建文件 ') + val);
      tree.refreshNode(parent, true);
      if (type === 'file') editor.openFile(p);
    });
  }

  // ---------- 打开文件并定位行（全局搜索结果点击） ----------
  /** 等待 huge 视图可定位：行数估算就绪（lines>1）后最多再等 budgetMs 等行索引。
   *  新建实例的 totalLines() 先是 1（行数估算异步、索引未建）→ 此时 gotoLine 会被 clamp 到第 1 行；
   *  索引就绪后行号才精确（估算值在行长不均的文件上可能偏差很大）。返回最终 getState()（可能为 null）。 */
  async function waitHugeReady(hv, budgetMs) {
    const t0 = performance.now();
    let st = null;
    for (;;) {
      try { st = hv.getState(); } catch { return null; }
      if (st && st.indexed) return st;
      const el = performance.now() - t0;
      if (st && st.lines > 1 && el > budgetMs) return st; // 索引太慢：先按估算行数定位，别让用户干等
      if (el > budgetMs * 3) return st;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function openFileAt(file, line, query) {
    const tab = await editor.openFile(file);
    tree.reveal(file).catch(() => {}); // 全局搜索跳转：树跟随定位
    if (!tab) return;
    // 大文件查看器：行号 → 字节偏移（主进程流式统计换行）→ 居中开窗
    if (tab.kind === 'viewer-lg') {
      if (line) {
        try {
          // v0.4.0：优先用行索引（O(log n)，侧车缓存），失败回退旧的流式数换行
          let off = 0;
          try {
            off = await window.api.hugeLineOffset(file, line);
          } catch {
            off = await window.api.findLineOffset(file, line);
          }
          await editor.revealViewerAt(tab, off);
        } catch (err) {
          console.warn('[gs-jump] 大文件定位失败:', file, err && err.message ? err.message : err);
        }
      }
    } else if (tab.kind === 'huge') {
      // 缺陷 2 修复：虚拟滚动查看器的正文不在 CodeMirror 里（CM 文档是空的），
      // editor.jumpToLine 只会把空文档 clamp 到第 1 行 —— 必须走 hugeview 的 gotoLine
      //（行号 → 字节偏移由主进程稀疏行索引 O(log n) 完成，不再全量重扫）。
      if (line) {
        // tab.huge 只在标签活动时挂载：标签不活动（或尚未渲染）先用公开 API 激活它
        //（openFile 命中已开标签 → 内部 switchTab → 挂载 huge 视图），再跳转
        if (!tab.huge && editor.getActiveTab() !== tab) await editor.openFile(file);
        if (tab.huge) {
          try {
            const sb = $('#sb-len');
            if (sb) sb.textContent = '大文件索引建立中，正在定位…';
            await waitHugeReady(tab.huge, 12000); // 等估算/索引就绪：否则跳转被 clamp 到第 1 行
            const n = await tab.huge.gotoLine(line);
            if (sb) sb.textContent = `已跳转第 ${n} 行`; // 状态栏即时反馈
            toast(`已定位到《${tab.name}》第 ${n} 行`);
          } catch (err) {
            console.warn('[gs-jump] 大文件定位失败:', file, err && err.message ? err.message : err);
            toast('大文件定位失败：' + (err && err.message ? err.message : err));
          }
        } else {
          toast('大文件视图尚未就绪，已打开文件');
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

  // ---------- 底部面板（0.5.0 Phase 5a E1：默认折叠、按需展开、最大化/还原） ----------
  /** 启动默认折叠（0.3.0 §4-E1 的用户痛点：开机就占 1/4 高、无文件时纯占位）。
   *  **为什么不回归既有用例**：折叠只是给 #bottom-panel 加 .collapsed（CSS 高度 34px +
   *  .panel-body{display:none}），面板体与结果 DOM 一字未动 —— findAll / pyUI 等读的是
   *  `#find-results .find-result` / `#py-output`.textContent，照样有值；而所有"要用面板"的
   *  入口（Ctrl+F / Ctrl+H / ▶ 运行 / 全局搜索跳转 setQuery）都先经 switchPanel() 展开。 */
  const BOTTOM_DEFAULT_COLLAPSED = true;
  const panelEl = $('#bottom-panel');
  const btnMaxPanel = $('#btn-max-panel');
  /** boot 时"默认折叠"这一事实的现场快照（用例在末尾跑，届时面板早被前面的用例展开过，
   *  所以默认态只能在 boot 当下记录 —— 这是对真实 DOM 的观测，不是常量回读）。 */
  let bottomBootCollapsed = null;
  const isPanelCollapsed = () => panelEl.classList.contains('collapsed');
  const isPanelMaximized = () => panelEl.classList.contains('maximized');
  function syncPanelMaxBtn() {
    if (!btnMaxPanel) return;
    const max = isPanelMaximized();
    btnMaxPanel.textContent = max ? '⤡' : '⛶';
    btnMaxPanel.title = max ? '还原面板高度' : '最大化面板';
    btnMaxPanel.setAttribute('aria-pressed', max ? 'true' : 'false');
  }
  function setPanelCollapsed(v) {
    panelEl.classList.toggle('collapsed', !!v);
    if (v) panelEl.classList.remove('maximized'); // 折叠与最大化互斥（否则"折叠着却占 72vh"）
    syncPanelMaxBtn();
  }
  /** 最大化/还原：折叠态下点击 = 先展开再最大化（一次点击就有可见效果，不要求用户点两次）。 */
  function togglePanelMax() {
    if (isPanelCollapsed()) {
      panelEl.classList.remove('collapsed');
      panelEl.classList.add('maximized');
    } else {
      panelEl.classList.toggle('maximized');
    }
    syncPanelMaxBtn();
    return isPanelMaximized();
  }
  // 启动即应用默认折叠（放在这里而不是 index.html 的 class：便于 __app 暴露/用例断言"启动态"）
  setPanelCollapsed(BOTTOM_DEFAULT_COLLAPSED);
  bottomBootCollapsed = isPanelCollapsed();

  function switchPanel(name) {
    $$('.ptab').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    $$('.panel-body').forEach((p) => p.classList.toggle('hidden', p.id !== `panel-${name}`));
    setPanelCollapsed(false); // E1：按需展开（触发搜索 / 运行 Python / 打开文件定位都走这里）
  }

  $$('.ptab').forEach((b) => b.addEventListener('click', () => switchPanel(b.dataset.panel)));
  $('#btn-close-panel').addEventListener('click', () => setPanelCollapsed(true));
  if (btnMaxPanel) btnMaxPanel.addEventListener('click', () => togglePanelMax());
  syncPanelMaxBtn();

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

    // 大文件上限（1 ~ 20480 MB = 20GB；v0.9.0 起 5GB → 20GB：10GB 级文件也能打开/编辑/搜索）
    const MAX_SIZE_MB = 20480;
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
      sizeHint.textContent = `可调整范围 1 ~ ${MAX_SIZE_MB} MB（默认 10240 = 10GB；超过上限拒绝打开）。≤4MB 普通编辑器；>4MB 分段加载；>256MB 虚拟滚动查看器（连续滚动直达任意位置，打开即编辑、Ctrl+G 跳行号、Ctrl+S 保存；首屏不等全量行索引、支持自动换行）`;
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

    // 自动换行
    const wrapRow = document.createElement('label');
    wrapRow.className = 'check-row';
    const wrapInput = document.createElement('input');
    wrapInput.type = 'checkbox';
    wrapInput.checked = !!s.wordWrap;
    const wrapText = document.createElement('span');
    wrapText.textContent = '自动换行';
    wrapRow.append(wrapInput, wrapText);

    // v0.11.0：标签多行换行（像 VSCode 的 Wrap Tabs）—— 打开很多标签时折行显示，而不是单行横向滚动
    const tabWrapRow = document.createElement('label');
    tabWrapRow.className = 'check-row';
    const tabWrapInput = document.createElement('input');
    tabWrapInput.type = 'checkbox';
    tabWrapInput.id = 'tab-wrap-setting';
    tabWrapInput.checked = s.tabWrap !== false;
    const tabWrapText = document.createElement('span');
    tabWrapText.textContent = '标签多行换行（标签很多时像 VSCode 一样折行显示；关闭 = 单行横向滚动）';
    tabWrapRow.append(tabWrapInput, tabWrapText);

    // ---------- 0.5.0 Phase 5a B8：字号 / 行高（编辑器 + 预览；快捷键 Ctrl+= / Ctrl+- / Ctrl+0） ----------
    const mkNumField = (label, value, min, max, step) => {
      const f = document.createElement('div');
      f.className = 'field';
      const l = document.createElement('label');
      l.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = min;
      inp.max = max;
      inp.step = step;
      inp.value = value;
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = `可调整范围 ${min} ~ ${max}`;
      f.append(l, inp, hint);
      return { field: f, input: inp, hint };
    };
    const fsEditor = mkNumField('编辑器字号（像素，10~32）', clampFont('editorFontSize', s.editorFontSize), 10, 32, 0.5);
    fsEditor.hint.textContent = '快捷键：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 复位（含预览缩放）';
    const fsLine = mkNumField('编辑器行高（倍数，1~2.6）', clampFont('editorLineHeight', s.editorLineHeight), 1, 2.6, 0.05);
    fsLine.hint.textContent = '行距倍数，1.65 = 改造前默认值';
    const fsPreview = mkNumField('预览字号（像素，10~32）', clampFont('previewFontSize', s.previewFontSize), 10, 32, 0.5);
    fsPreview.hint.textContent = 'Markdown 预览区字号（标题/代码等按比例缩放）';

    body.append(themeField, pyField, sizeField, saveField, sbField, indentField, fsEditor.field, fsLine.field, fsPreview.field, wrapRow, tabWrapRow);

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
              maxFileSizeMB: Math.min(20480, Math.max(1, parseInt(sizeInput.value, 10) || 50)),
              autoSaveDelay: Math.max(100, parseInt(saveInput.value, 10) || 800),
              scrollbarWidth: Math.min(40, Math.max(6, parseInt(sbInput.value, 10) || 10)),
              indentSize: Math.min(8, Math.max(1, parseInt(indentInput.value, 10) || 4)),
              wordWrap: wrapInput.checked,
              // v0.11.0：标签多行换行（settings.tabWrap，白名单键）
              tabWrap: tabWrapInput.checked,
              // B8：字号 / 行高（三个键必须都在 settings.js 白名单里，否则 settings:set 会静默丢弃）
              editorFontSize: clampFont('editorFontSize', parseFloat(fsEditor.input.value)),
              editorLineHeight: clampFont('editorLineHeight', parseFloat(fsLine.input.value)),
              previewFontSize: clampFont('previewFontSize', parseFloat(fsPreview.input.value)),
            };
            state.settings = await window.api.setSettings(patch);
            applyTheme(state.settings.theme); // 兜底：保证 data-theme 与落盘值一致（change 已即时预览，此处幂等）
            editor.setWordWrap(patch.wordWrap);
            editor.setTabWrap(patch.tabWrap);
            editor.setIndentSize(patch.indentSize);
            applyScrollbarWidth(patch.scrollbarWidth);
            applyFonts(state.settings); // B8：设置弹窗与快捷键走同一个落地函数
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
  // v0.11.0：全局搜索是底部面板的一个页签（不再是左侧栏分区）—— 入口统一走
  // `openGlobalSearchPanel()`：切页签 + 展开面板 + 聚焦输入框（Ctrl+Shift+F / 工具栏按钮共用）。
  function openGlobalSearchPanel() {
    switchPanel('globalsearch');
    globalSearch.focus();
  }
  $('#btn-global-search').addEventListener('click', () => {
    openGlobalSearchPanel();
  });
  // ---------- v0.11.0：大纲栏显隐（正文区左栏；偏好落盘，跨窗口同步） ----------
  const btnOutline = $('#btn-outline');
  function applyOutlineVisibleUI() {
    const on = state.settings.outlineVisible !== false;
    btnOutline.classList.toggle('on', on);
    btnOutline.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnOutline.title = on ? '隐藏大纲栏（Markdown 文件）' : '显示大纲栏（Markdown 文件）';
  }
  btnOutline.addEventListener('click', async () => {
    const next = state.settings.outlineVisible === false; // 当前隐藏 → 改为显示
    state.settings = await window.api.setSettings({ outlineVisible: next });
    applyOutlineVisibleUI();
    if (outline) outline.refresh();
    const t = getActiveTab();
    if (t && isMarkdown(t.name)) toast(next ? '大纲栏已显示' : '大纲栏已隐藏');
    else toast(next ? '大纲栏偏好已设为显示（Markdown 文件生效）' : '大纲栏偏好已设为隐藏（Markdown 文件生效）');
  });
  applyOutlineVisibleUI();
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
    // v0.11.0：任意两个文件直接对比 —— 选择一个磁盘文件与当前文档对比（不要求它已打开）
    const optPick = document.createElement('option');
    optPick.value = '__pick__';
    optPick.textContent = '📁 选择磁盘文件…（任意文件 ↔ 当前文档）';
    sel.appendChild(optPick);
    for (const t of others) {
      if (t.state.doc.length > 20 * 1024 * 1024) continue;
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = '📑 ' + t.name;
      sel.appendChild(o);
    }
    field.append(lbl, sel);
    body.appendChild(field);

    // v0.2.1 三方对比（基准 / 本方=当前 / 对方）：需要至少两个其它文本标签
    const threeField = document.createElement('div');
    threeField.className = 'field';
    const threeRow = document.createElement('label');
    threeRow.className = 'check-row';
    const threeChk = document.createElement('input');
    threeChk.type = 'checkbox';
    const threeTxt = document.createElement('span');
    threeTxt.textContent = '三方对比（基准 · 本方=当前 · 对方）';
    threeRow.append(threeChk, threeTxt);
    const baseSel = document.createElement('select');
    baseSel.className = 'field-select';
    baseSel.style.marginTop = '6px';
    const baseLbl = document.createElement('label');
    baseLbl.textContent = '基准文件（共同原始版本）：';
    baseLbl.style.display = 'none';
    baseSel.style.display = 'none';
    for (const t of others) {
      if (t === cur || t.state.doc.length > 20 * 1024 * 1024) continue;
      if (String(t.id) === sel.options[sel.selectedIndex]?.value) continue;
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = '▣ ' + t.name;
      baseSel.appendChild(o);
    }
    threeChk.addEventListener('change', () => {
      const on = threeChk.checked && baseSel.options.length > 0;
      baseLbl.style.display = on ? '' : 'none';
      baseSel.style.display = on ? '' : 'none';
      if (threeChk.checked && baseSel.options.length === 0) {
        threeChk.checked = false;
        toast('三方对比需要至少两个其它打开的文本标签（基准 + 对方）');
      }
    });
    threeField.append(threeRow, baseLbl, baseSel);
    body.appendChild(threeField);
    openModal({
      title: '文档对比',
      body,
      actions: [
        { label: '取消', onClick: () => closeModal() },
        {
          // v0.11.0：任意两个文件直接对比（两次磁盘文件选择，都不要求已打开）
          label: '两个文件…',
          onClick: async () => {
            closeModal();
            try {
              const a = await window.api.selectFile({ title: '对比：选择左侧文件' });
              if (!a) return;
              const b = await window.api.selectFile({ title: '对比：选择右侧文件' });
              if (!b) return;
              const [ra, rb] = await Promise.all([window.api.readFile(a), window.api.readFile(b)]);
              editor.openDiffTab({
                leftLabel: baseName(a),
                leftContent: ra.content,
                leftPath: a,
                rightLabel: baseName(b),
                rightContent: rb.content,
                rightPath: b,
                exportDir: state.rootDir || '',
              });
            } catch (err) {
              toast('读取对比文件失败：' + (err && err.message ? err.message : err));
            }
          },
        },
        {
          label: '开始对比',
          primary: true,
          onClick: async () => {
            closeModal();
            const v = sel.value;
            const rightContent = cur.state.doc.toString();
            const rightLabel = cur.name + '（当前）';
            const rightPath = cur.path || null;
            let leftContent = null;
            let leftLabel = '';
            let leftPath = null;
            try {
              if (v === '__disk__') {
                const data = await window.api.readFile(cur.path);
                leftContent = data.content;
                leftLabel = cur.name + '（磁盘）';
                leftPath = cur.path || null;
              } else if (v === '__clip__') {
                leftContent = await window.api.readClipboardText();
                leftLabel = '剪贴板';
                if (!leftContent) {
                  toast('剪贴板为空或不是文本');
                  return;
                }
              } else if (v === '__pick__') {
                const p = await window.api.selectFile({ title: '对比：选择磁盘文件' });
                if (!p) return;
                const data = await window.api.readFile(p);
                leftContent = data.content;
                leftLabel = baseName(p);
                leftPath = p;
              } else {
                const t = tabsById(String(v));
                if (!t) return;
                leftContent = t.state.doc.toString();
                leftLabel = t.name;
                leftPath = t.path || null;
              }
            } catch (err) {
              toast('读取对比内容失败：' + (err.message || err));
              return;
            }
            // 三方模式：基准=baseSel 所选标签；本方=当前；对方=sel 所选标签（标签模式）
            if (threeChk.checked && baseSel.style.display !== 'none' && v !== '__disk__' && v !== '__clip__' && v !== '__pick__') {
              const baseTab = tabsById(baseSel.value);
              if (!baseTab) return;
              editor.openDiffTab({
                three: true,
                leftLabel: baseTab.name,
                leftContent: baseTab.state.doc.toString(),
                leftPath: baseTab.path || null,
                midLabel: cur.name + '（本方）',
                midContent: rightContent,
                midPath: cur.path || null,
                rightLabel: leftLabel,
                rightContent: leftContent,
                rightPath: leftPath,
                exportDir: state.rootDir || '',
              });
              return;
            }
            editor.openDiffTab({
              leftLabel,
              leftContent,
              leftPath,
              rightLabel,
              rightContent,
              rightPath,
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
  // ---------- 各分界线拖拽调整尺寸（分隔条在目标右侧/下侧时用 reverse） ----------
  initDragResize($('#sidebar-divider'), { target: '#sidebar', dir: 'x', min: 200, max: 520 });
  initDragResize($('#bottom-divider'), { target: '#bottom-panel', dir: 'y', min: 120, max: 640, reverse: true });
  // v0.11.0：`#tree-search-divider` 随侧栏搜索分区一起移除（左栏只剩文件树，无需再分配高度）。
  // 右侧收藏栏：分隔条在栏**左侧**，向左拖 = 加宽 → reverse:true（同 bottom-panel 的方向关系）
  initDragResize(favRailDivider, { target: '#fav-rail', dir: 'x', min: FAVRAIL_WIDTH_MIN, max: FAVRAIL_WIDTH_MAX, reverse: true });
  // 右栏宽度持久化（initDragResize 无回调且 ui.js 不在改动面）：拖完（mouseup）/ 双击复位后量真实宽度落盘
  favRailDivider.addEventListener('mousedown', () => {
    const onUp = () => {
      document.removeEventListener('mouseup', onUp);
      const w = Math.round(favRailEl.getBoundingClientRect().width);
      if (w > 0 && w !== favRailWidth) {
        favRailWidth = clampFavRailWidth(w);
        persistFavRail();
      }
    };
    document.addEventListener('mouseup', onUp);
  });
  favRailDivider.addEventListener('dblclick', () => {
    // initDragResize 的 dblclick 先清内联宽度（注册顺序在前），下一个宏任务再量复位后的真实宽度
    setTimeout(() => {
      const w = Math.round(favRailEl.getBoundingClientRect().width);
      if (w > 0 && w !== favRailWidth) {
        favRailWidth = clampFavRailWidth(w);
        persistFavRail();
      }
    }, 0);
  });

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
  new MutationObserver(setPreviewLabel).observe($('#editor-panes'), { childList: true, subtree: true });

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

  // ---------- 快捷键（0.5.0 Phase 5a F1：单一数据源 = help.js 的 SHORTCUTS） ----------
  // 这里**只提供 id → 动作**，键位判定与面板显示都来自 help.js 的同一张表 ——
  // 「代码里真正生效的键位」与「面板显示的键位」在结构上不可能漂移（新增键位只改 help.js）。
  // 动作体逐条保持 0.5.0 之前 if/else 链里的原样逻辑（含各自的分支差异，见注释）。
  const SHORTCUT_ACTIONS = {
    'quick-open': () => quickOpen.toggle(),
    'open-dir': () => openDirectory(),
    save: () => editor.saveNow(),
    find: () => { switchPanel('find'); find.focus(); },
    replace: () => { switchPanel('find'); find.focusReplace(); },
    'global-search': () => openGlobalSearchPanel(),
    'preview-cycle': () => {
      const mode = preview.cycleMode();
      if (mode) btnPreview.textContent = previewModeNames[mode];
    },
    'huge-goto': () => {
      // v0.4.0：大文件查看器行号跳转（Ctrl+G）
      const ht = getActiveTab();
      if (ht && ht.kind === 'huge' && ht.huge) {
        showPrompt('跳转行号', '输入行号（1 ~ 总行数）', '', (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) ht.huge.gotoLine(n);
        });
      } else {
        toast('当前标签不是大文件查看器（Ctrl+G 仅在大文件视图可用）');
      }
    },
    'zoom-reset': () => { resetViewScale(); }, // B8：Ctrl+0 = 视图缩放复位（含预览缩放，见 resetViewScale）
    'font-inc': () => { stepEditorFont(1); },
    'font-dec': () => { stepEditorFont(-1); },
    'new-window': () => { window.api.openNewWindow(); }, // 多窗口：每窗口独立标签/目录，共享设置与主题
    'close-tab': () => {
      const tab = getActiveTab();
      if (tab) editor.closeTab(tab);
    },
    // A2（0.5.0 Phase 5a 第 2 批）：Ctrl+Shift+T 重开刚关闭的标签（栈 20 条；落栏语义见 tabs.js）
    'reopen-closed': () => { void editor.reopenClosedTab(); },
    'cycle-tab': (e) => { editor.cycleTab(e.shiftKey ? -1 : 1); },
    'split-toggle': () => {
      // 0.5.0 多视图 Phase 2（G6）：Ctrl+\ = 分屏/合屏（硬上限 2 栏；已有两栏时合并回单栏）
      const n = editor.toggleSplit();
      toast(n > 1 ? '已分屏（Ctrl+1 / Ctrl+2 切换栏，Ctrl+\\ 合屏）' : '已合并为单栏');
      syncPreviewToFocus();
      preview.applyMode();
      setPreviewLabel();
    },
    'focus-pane-1': () => focusPaneByKey(0),
    'focus-pane-2': () => focusPaneByKey(1),
    'outline-toggle': () => { if (outline) outline.setCollapsed(!outline.getState().collapsed); },
    'panel-collapse': () => {
      tree.hideCtx(); // 旧行为：Esc 先收右键菜单
      // v0.2.4：弹窗打开时 Esc 只关弹窗（ui.js 统一处理），不收起底部面板
      const modalOpen = !$('#modal-mask').classList.contains('hidden');
      if (!modalOpen && !isPanelCollapsed()) {
        setPanelCollapsed(true); // E1：Esc 收起面板（同时退出最大化，见 setPanelCollapsed）
      }
    },
    help: () => { help.toggle(); },
  };
  /** Ctrl+1 / Ctrl+2：聚焦第 idx 栏（不存在第 2 栏时提示，不自动分屏） */
  function focusPaneByKey(idx) {
    if (idx === 0 || editor.getPaneCount() > 1) {
      if (editor.focusPaneIndex(idx)) {
        syncPreviewToFocus();
        preview.applyMode();
        setPreviewLabel();
        updateRunButton();
      }
    } else {
      toast('当前只有一栏（Ctrl+\\ 可分屏）');
    }
  }
  /** 未接线/建议补线的 id → true（面板上会标「未接线」，用例可据此断言没有漏接线） */
  const isShortcutWired = (id) => typeof SHORTCUT_ACTIONS[id] === 'function';
  // F1：帮助面板用**同一张动作表**（面板据此把没接线的键位标出来 —— 表与分派不可能漂移）
  help = createHelp({ actions: SHORTCUT_ACTIONS });

  document.addEventListener('keydown', (e) => {
    // A1：快速打开浮层内的按键不参与全局分派（否则 Esc 关浮层时会连带收起底部面板）
    if (e.target && e.target.closest && e.target.closest('.quick-open')) return;
    const id = matchShortcut(e);
    if (!id) return;
    const act = SHORTCUT_ACTIONS[id];
    if (!act) return; // 表里有、动作没接：不吞键（保持旧行为：该组合键交回系统）
    if (id !== 'panel-collapse') e.preventDefault();
    try {
      act(e);
    } catch (err) {
      console.error('[shortcut:' + id + ']', err && err.stack ? err.stack : err);
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
    // B8：其它窗口改了字号/行高 → 本窗口即时跟随（CSS 变量挂在 :root，本窗口全部栏一起变）
    if (s.editorFontSize !== prev.editorFontSize || s.editorLineHeight !== prev.editorLineHeight || s.previewFontSize !== prev.previewFontSize) {
      applyFonts(s);
    }
    // E2：其它窗口改了侧栏折叠态 → 本窗口跟随（窗口级 UI，不写回，避免两个窗口互相覆盖）
    if (s.sidebarCollapsed && JSON.stringify(s.sidebarCollapsed) !== JSON.stringify(prev.sidebarCollapsed)) {
      applySidebarCollapsed(s.sidebarCollapsed);
    }
    // v0.11.0：大纲栏显隐 / 标签多行换行 是应用级偏好 → 其它窗口改了即时跟随
    if (s.outlineVisible !== prev.outlineVisible) {
      applyOutlineVisibleUI();
      if (outline) outline.refresh();
    }
    if (s.tabWrap !== prev.tabWrap) {
      editor.setTabWrap(s.tabWrap !== false);
    }
    // 右侧收藏栏：其它窗口改了开合/pin/宽度 → 本窗口跟随（同为窗口级 UI，不写回）
    if (s.favRailOpen !== prev.favRailOpen || s.favRailPinned !== prev.favRailPinned || s.favRailWidth !== prev.favRailWidth) {
      favRailOpen = s.favRailOpen === true;
      favRailPinned = s.favRailPinned === true;
      favRailWidth = clampFavRailWidth(s.favRailWidth);
      applyFavRail();
    }
  });
  // 同文件已在另一窗口打开（本窗口为后来者）→ 自动转只读，编辑仍可在标签右键解除；
  // 编辑窗口保存后经 file-changed 静默同步到本窗口（tabs.js 只读节流，不弹提示不抖动）
  // v0.5.0 Phase 4：只读横幅 + 「✏️ 接管编辑」按钮由 tabs.js 按主进程锁表渲染（本订阅的
  // 只读转换语义**一个字未改** —— scripts/smoke.js 的 mwSharedReadOnly 断言的就是这条通道）。
  window.api.onFileSharedOpen(({ path: sharedPath }) => {
    const tab = editor.findTabByPath(sharedPath);
    if (tab && !tab.kind) {
      editor.setTabReadOnly(tab, true);
      toast(`「${tab.name}」已在另一窗口打开，本窗口以只读打开（顶部横幅可一键接管编辑）`);
    }
  });

  // ---------- 恢复上次目录与会话 ----------
  await favorites.load(); // 启动时渲染收藏列表 + 同步按钮状态
  // 右键「用 MarkHunter 打开」/ 二次启动 --dir：优先采用指定目录。
  // 双通道取目标：preload 缓冲（takeOpenDir，覆盖"监听注册前到达"）+ 事件回调（externalDir）；
  // boot 收尾还会再判一次，覆盖"事件落在恢复分支 await 期间"的情况（v0.2.2 修复漏掉的那一段）。
  externalDir = externalDir || (await window.api.takeOpenDir());
  if (externalDir) {
    openDirFromArg = true;
    const opened = await openDirFromPath(externalDir, { fromLaunch: true });
    if (!opened) toast(`无法打开指定目录：${externalDir}`);
  } else {
    // v0.2.3 多目录：恢复上次侧栏根列表（失效目录被 readTree 预检静默跳过），
    // 活动目录取 lastDirectory（不在列表时回退第一个）；无列表时退回单目录恢复
    const savedRoots = Array.isArray(state.settings.sidebarRoots) ? state.settings.sidebarRoots.slice() : [];
    const last = state.settings.lastDirectory;
    if (savedRoots.length > 1 || (savedRoots.length === 1 && last && normKey(savedRoots[0]) !== normKey(last))) {
      const activeSaved = savedRoots.find((r) => normKey(r) === normKey(last)) || savedRoots[0];
      for (const d of savedRoots) await openDirFromPath(d); // 逐个加入（每次加入即激活，末尾统一校正活动根）
      if (!(state.rootDir && normKey(state.rootDir) === normKey(activeSaved))) {
        await openDirFromPath(activeSaved); // 已在列表 → 仅切换活动
      }
    } else if (savedRoots.length === 1) {
      await openDirFromPath(savedRoots[0]);
    } else if (last) {
      await openDirFromPath(last);
    }
  }
  bootDirSettled = true; // 此后到达的 open-dir（second-instance 新窗口等）直接执行
  // 收尾补判：事件若落在「上面 if 判定之后、bootDirSettled 置位之前」会被旧逻辑静默吞掉
  const lateDir = externalDir || (await window.api.takeOpenDir());
  if (lateDir && normKey(state.rootDir || '') !== normKey(lateDir)) {
    openDirFromArg = true;
    const okLate = await openDirFromPath(lateDir, { fromLaunch: true });
    if (!okLate) toast(`无法打开指定目录：${lateDir}`);
  }
  if (openDirFromArg) {
    // 右键打开指定目录 = 干净窗口：不恢复上次会话（会话仍是持久化的，可在无 --dir 启动时恢复）
    console.info('[open-dir] 指定目录启动：跳过上次会话恢复');
  } else {
    await restoreSession(); // 恢复上次会话（先恢复目录，再恢复标签，保证树定位可用）
  }
  syncExternalTree(); // 需求1：启动后同步一次外部文件分支（幂等，兜底 restoreSession 提前返回的场景）

  // 崩溃恢复：启动即查一次恢复区（有可恢复项才点亮状态栏入口 + 非模态 toast；失败静默）
  await recover.init();

  updateRunButton();
  // S10：window.__app 仅开发环境暴露（冒烟/扩展测试在 dev 下运行，不受影响；打包版无此接口）
  if (!(await window.api.isPackaged())) {
    window.__app = { state, editor, tree, preview, find, globalSearch, python, openDirFromPath, closeSidebarRoot, favorites, syncExternalTree, session: { save: () => persistSession(true), restore: restoreSession }, applyTheme, THEME_NAMES, DARK_THEMES,
      // ---------- 0.5.0 Phase 5a 测试面（dev 独有） ----------
      // E1：底部面板折叠 / 最大化（getState 里的 bootCollapsed = boot 当下对真实 DOM 的观测快照）
      // v0.11.0：`active` = 当前激活页签（find / globalsearch / python），布局迁移用例据此断言
      //   Ctrl+Shift+F 切到了「全局搜索」页签。
      bottomPanel: {
        DEFAULT_COLLAPSED: BOTTOM_DEFAULT_COLLAPSED,
        getState: () => {
          const act = document.querySelector('.ptab.active');
          return {
            collapsed: isPanelCollapsed(),
            maximized: isPanelMaximized(),
            bootCollapsed: bottomBootCollapsed,
            height: Math.round(panelEl.getBoundingClientRect().height),
            bodyVisible: Array.from(document.querySelectorAll('.panel-body')).some((p) => !p.classList.contains('hidden') && p.offsetHeight > 0),
            active: act ? act.dataset.panel : null,
          };
        },
        collapse: () => { setPanelCollapsed(true); return isPanelCollapsed(); },
        expand: () => { setPanelCollapsed(false); return isPanelCollapsed(); },
        toggleMax: () => togglePanelMax(),
        switchTo: (name) => { switchPanel(name); return name; },
      },
      // E2：侧栏分区折叠（v0.11.0 起两分区 fav/tree；getState 返回落盘同源的展开/折叠真值）
      sidebarSections: {
        SECTIONS: SIDEBAR_SECTIONS.slice(),
        getState: () => ({ ...sidebarCollapsed }),
        toggle: (k) => toggleSidebarSection(k),
        set: (v) => { applySidebarCollapsed(v, true); return { ...sidebarCollapsed }; },
      },
      // 右侧收藏栏（需求2）：getState 全是原始值 + DOM 类名（.open/.pinned/.overlay），可结构化克隆；
      // 状态判读也可直接断言 `#fav-rail.open` / `#fav-rail.pinned` / `#fav-rail.hidden` 与 settings 三键
      favRail: {
        getState: () => ({
          open: favRailOpen,
          pinned: favRailPinned,
          width: favRailWidth,
          visible: !favRailEl.classList.contains('hidden'),
          overlay: favRailEl.classList.contains('overlay'),
          cls: favRailEl.className,
          dividerVisible: !favRailDivider.classList.contains('hidden'),
          items: document.querySelectorAll('#fav-list .fav-item').length,
        }),
        toggle: () => toggleFavRail(),
        open: () => {
          if (!favRailOpen || favRailPinned) { favRailOpen = true; persistFavRail(); applyFavRail(); }
          return favRailOpen;
        },
        close: () => closeFavRail(),
        setPinned: (v) => setFavRailPinned(v),
        setWidth: (w) => { favRailWidth = clampFavRailWidth(w); persistFavRail(); applyFavRail(); return favRailWidth; },
      },
      // B8：字号 / 行高（设置弹窗与 Ctrl+=/-/0 的共同出口）
      fonts: {        DEFAULTS: { ...FONT_DEFAULTS },
        step: (delta) => stepEditorFont(delta),
        reset: () => resetViewScale(),
        getVars: () => {
          const cs = getComputedStyle(document.documentElement);
          return {
            editorFontSize: cs.getPropertyValue('--mh-editor-font-size').trim(),
            editorLineHeight: cs.getPropertyValue('--mh-editor-line-height').trim(),
            previewFontSize: cs.getPropertyValue('--mh-preview-font-size').trim(),
          };
        },
      },
      // B1：大纲 / TOC（getState 里的判据与 UI 同源；supports 是纯函数，便于断言类型规则）
      outline,
      // A1：Ctrl+P 快速打开（getState / match 是纯数据，可结构化克隆回主进程）
      quickOpen,
      // 崩溃恢复（huge:doc-recover-list 的消费方）：getState 全是原始值，可结构化克隆
      recover: {
        getState: () => recover.getState(),
        init: () => recover.init(), // 与 boot 同一条路（刷新 + 点亮 chip + 非模态 toast）
        list: () => recover.refresh(),
        openDialog: () => recover.openDialog(),
        first: () => {
          const it = recover.getState().items[0];
          return it ? { key: it.key, file: it.file } : null;
        },
        recover: (arg) => recover.recoverItem(arg),
        discard: (arg) => recover.discardItem(arg),
        sampleLines: (file, picks) => recover.sampleLines(file, picks),
      },
      // F1：快捷键帮助面板 + 键位表（rows 不含函数，可克隆；wired 标记漏接线的 id）
      help: {
        panel: help,
        rows: shortcutRows(),
        groups: (() => {
          const g = [];
          for (const r of shortcutRows()) if (g.indexOf(r.group) < 0) g.push(r.group);
          return g;
        })(),
        unwired: shortcutRows().map((r) => r.id).filter((id) => !isShortcutWired(id)),
        match: (ev) => matchShortcut(ev),
      },
    };
  }
}

boot();
