const { ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', 'env', 'dist', 'out', 'build', 'release',
]);

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.py', '.js', '.ts', '.jsx', '.tsx',
  '.html', '.htm', '.css', '.scss', '.xml', '.yaml', '.yml', '.ini', '.cfg',
  '.conf', '.log', '.csv', '.toml', '.sh', '.bat', '.cmd', '.ps1', '.c', '.h',
  '.cpp', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.vue', '.svelte',
]);

const MAX_SEARCH_FILE_MB = 10; // 全局搜索跳过超大文件

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function registerSearchIpc() {
  ipcMain.handle('search:global', async (_e, payload) => {
    const { dir, query, maxResults = 3000 } = payload || {};
    if (!dir || !query) return [];
    const q = String(query).toLowerCase();
    const results = [];
    for await (const file of walk(dir)) {
      const ext = path.extname(file).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      if (st.size === 0 || st.size > MAX_SEARCH_FILE_MB * 1024 * 1024) continue;
      let content;
      try {
        content = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(q);
        if (idx >= 0) {
          results.push({ file, line: i + 1, text: lines[i], matchIndex: idx });
          if (results.length >= maxResults) return results;
        }
      }
    }
    return results;
  });
}

module.exports = { registerSearchIpc };
