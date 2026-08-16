// 使用 esbuild 将渲染进程打包为单个 IIFE bundle
const { build } = require('esbuild');
const path = require('path');

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
