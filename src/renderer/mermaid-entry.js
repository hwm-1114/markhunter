// mermaid 独立 chunk 入口（P5，v0.1.45）
// 由 scripts/build.js 单独打包为 src/renderer/dist/mermaid-chunk.js（iife + minify）。
// preview.js 首次需要渲染 mermaid 时动态注入同源 <script> 加载本 chunk；
// iife 将 mermaid 实例暴露到 window.__mermaid（preview 惰性获取），并预注册默认初始化
// （明暗主题由渲染路径在渲染前按需调整 initialize，见 preview.js ensureMermaidTheme）。
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
});

window.__mermaid = mermaid;
