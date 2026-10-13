// ============================================================================
// katex-math.js —— markdown-it 数学公式插件（v0.6.0，KaTeX）
// ----------------------------------------------------------------------------
// 支持的写法（与 Typora / VS Code / GitHub 数学扩展一致）：
//   块级（display）：$$ ... $$（可跨行）与 \[ ... \]
//   行内（inline）：$...$（首尾不得是空白，防「$5 和 $10」货币误判）与 \( ... \)
//
// 注册位置（都经过实测核对，勿随意调整）：
//   · block：before('paragraph') —— fence（```mermaid 等）在其之前消费，
//     代码块内的 $$ 不会被误吃；
//   · inline：before('escape') —— `\(` 中的 `\` 若先被 escape 规则吃掉，
//     \(...\) 形态就永远到不了本规则；`$`（0x24）是 text 规则的终止字符，
//     text 不会吞掉它，两种行内定界符都能被本规则看到。
//   · 行内代码（`code`）内的 $：backticks 规则命中时一次性消费整个 span，
//     不会进入本规则 —— 天然安全。
//
// 渲染失败（KaTeX 不认识的宏等）：throwOnError:false 让 KaTeX 内联红字原码；
// 仅在 KaTeX 本身抛异常（如空公式）时回退为 .mh-math-error 原文展示，不中断整篇渲染。
// ============================================================================
import katex from 'katex';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** KaTeX 渲染（失败回退为可读错误占位，绝不抛出 —— 单条公式坏了不能毁整篇预览） */
function renderMath(tex, displayMode) {
  const src = String(tex || '').trim();
  if (!src) return '';
  try {
    return katex.renderToString(src, {
      displayMode,
      throwOnError: false, // 未知命令渲染为红色原码（KaTeX 内置行为）
      strict: false,       // 接受 Unicode 文本（公式内中文/全角符号不报警告）
      trust: false,        // 不允许 \href 等需要信任的命令（预览安全面）
      output: 'htmlAndMathml',
    });
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 200);
    return `<span class="mh-math-error" title="${escapeHtml(msg)}">${escapeHtml(src)}</span>`;
  }
}

// ---------- block：$$ ... $$（含单行 $$E=mc^2$$）与 \[ ... \] ----------
function mathBlock(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const endPos = state.eMarks[startLine];
  const first = state.src.slice(startPos, endPos);

  let open = null;
  let close = null;
  if (/^\s{0,3}\$\$/.test(first)) {
    open = '$$';
    close = '$$';
  } else if (/^\s{0,3}\\\[/.test(first)) {
    open = '\\[';
    close = '\\]';
  }
  if (!open) return false;

  // 起始行 open 之后的内容（单行闭合 \[ x \] 与 $$ x $$ 的快路径也走同一份代码）
  let content = first.slice(first.indexOf(open) + open.length);
  const singleEnd = content.indexOf(close);
  if (singleEnd >= 0) {
    // 同行闭合：闭合符之后必须只剩空白（「$$x$$ 后记」不是纯数学块，交回段落规则）
    if (content.slice(singleEnd + close.length).trim() !== '') return false;
    content = content.slice(0, singleEnd);
    if (silent) return true;
    pushBlock(state, content);
    state.line = startLine + 1;
    return true;
  }

  // 跨行收集到闭合行（$$ 或 \] 独占/近独占一行）
  let nextLine = startLine + 1;
  for (; nextLine < endLine; nextLine++) {
    const p = state.bMarks[nextLine] + state.tShift[nextLine];
    const mx = state.eMarks[nextLine];
    const line = state.src.slice(p, mx);
    const idx = line.indexOf(close);
    if (idx >= 0) {
      if (line.slice(idx + close.length).trim() !== '') return false; // 闭合符后还有内容：不是数学块
      content += '\n' + line.slice(0, idx);
      if (silent) return true;
      pushBlock(state, content);
      state.line = nextLine + 1;
      return true;
    }
    content += '\n' + line;
  }
  return false; // 未闭合：按普通段落渲染（不吞内容）
}

function pushBlock(state, content) {
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content.replace(/^\n+|\n+$/g, '');
  token.map = [state.line, state.line + 1];
}

// ---------- inline：$...$ 与 \( ... \) ----------
function mathInline(state, silent) {
  const src = state.src;
  const start = state.pos;
  let open = null;
  let close = null;
  if (src.charCodeAt(start) === 0x24 /* $ */) {
    if (src.charCodeAt(start + 1) === 0x24 /* $$ */) return false; // 连续 $$：交给 block 规则
    // 「$ 后不能是空白」：$ 5.00 / $ x 这类货币/文字场景不当公式
    const next = src[start + 1];
    if (next === undefined || /\s/.test(next)) return false;
    open = '$';
    close = '$';
  } else if (src.startsWith('\\(', start)) {
    open = '\\(';
    close = '\\)';
  }
  if (!open) return false;

  const end = src.indexOf(close, start + open.length);
  if (end < 0 || end >= state.posMax) return false;
  const content = src.slice(start + open.length, end);
  // 空内容 / 首尾空白：不是公式（「价格 $ 5 $」类文本原样保留）
  if (!content.trim() || /^\s|\s$/.test(content)) return false;
  // 内容里出现换行：$...$ 不跨行（跨行请用 $$）；\(...\) 同理保持简单
  if (/[\r\n]/.test(content)) return false;

  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
  }
  state.pos = end + close.length;
  return true;
}

export default function mathPlugin(md) {
  md.block.ruler.before('paragraph', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.renderer.rules.math_block = (tokens, idx) => renderMath(tokens[idx].content, true);
  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
}
