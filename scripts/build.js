// 使用 esbuild 将渲染进程打包为单个 IIFE bundle + mermaid 独立 chunk
// 前置 Tailwind CSS v4 + daisyUI 5 主题引擎编译（产物缺失会让 <link> 404，失败立即退出）
const { build } = require('esbuild');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
const input = path.join(root, 'src/renderer/tailwind-input.css');
const output = path.join(root, 'src/renderer/dist/tailwind.css');

const appEntry = path.join(root, 'src/renderer/app.js');
const bundleOut = path.join(root, 'src/renderer/dist/bundle.js');
const mermaidEntry = path.join(root, 'src/renderer/mermaid-entry.js');
const mermaidOut = path.join(root, 'src/renderer/dist/mermaid-chunk.js');

async function main() {
  // 1) Tailwind：直接 node 执行 CLI（禁用 npx 防联网）；stdio:inherit 避免管道捕获
  const tw = spawnSync(process.execPath, [cli, '-i', input, '-o', output, '--minify', '--silent'], {
    stdio: 'inherit',
    cwd: root,
  });
  if (tw.status !== 0) process.exit(1);

  // 2) esbuild 主 bundle（app.js → bundle.js）
  //    P5（v0.1.45 拆包）：preview.js 不再静态 import mermaid，主 bundle 显著缩小；
  //    esbuild 不改属性名，window.__app 等接口不受影响
  await build({
    entryPoints: [appEntry],
    bundle: true,
    outfile: bundleOut,
    format: 'iife',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
    logLevel: 'info',
  });

  // 3) esbuild mermaid 独立 chunk（mermaid-entry.js → mermaid-chunk.js）
  //    由 preview.js 首次需要渲染时动态注入 <script>（CSP script-src 'self' 同源允许）；
  //    electron-builder files: src/**/* 已覆盖 src/renderer/dist/mermaid-chunk.js
  await build({
    entryPoints: [mermaidEntry],
    bundle: true,
    outfile: mermaidOut,
    format: 'iife',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
    logLevel: 'info',
  });

  // 4) 体积对比（P5 收益记录）
  const fmt = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
  const bundleSize = fs.statSync(bundleOut).size;
  const chunkSize = fs.existsSync(mermaidOut) ? fs.statSync(mermaidOut).size : -1;
  console.log('[build] bundle.js =', fmt(bundleSize), '| mermaid-chunk.js =', fmt(chunkSize), '| 合计 =', fmt(bundleSize + Math.max(0, chunkSize)));
}

main().catch((err) => {
  console.error('[build] 失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
