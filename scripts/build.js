// 使用 esbuild 将渲染进程打包为单个 IIFE bundle
// 前置 Tailwind CSS v4 + daisyUI 5 主题引擎编译（产物缺失会让 <link> 404，失败立即退出）
const { build } = require('esbuild');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
const input = path.join(root, 'src/renderer/tailwind-input.css');
const output = path.join(root, 'src/renderer/dist/tailwind.css');

// 1) Tailwind：直接 node 执行 CLI（禁用 npx 防联网）；stdio:inherit 避免管道捕获
const tw = spawnSync(process.execPath, [cli, '-i', input, '-o', output, '--minify', '--silent'], {
  stdio: 'inherit',
  cwd: root,
});
if (tw.status !== 0) process.exit(1);

// 2) esbuild 原样
build({
  entryPoints: [path.join(__dirname, '../src/renderer/app.js')],
  bundle: true,
  outfile: path.join(__dirname, '../src/renderer/dist/bundle.js'),
  format: 'iife',
  target: ['chrome120'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
}).catch(() => process.exit(1));
