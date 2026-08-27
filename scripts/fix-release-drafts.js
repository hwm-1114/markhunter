// Release 双草稿自动合并（CI 步骤用；v0.1.46 起连续 5 版 electron-builder 偶发把资产拆进两个 draft）
// 行为：找同名 tag 的多个 draft → 把残缺 draft 的资产搬到「资产最全」的 draft → 发布（draft:false,
// make_latest）→ 删除残缺 draft。资产齐全的单 draft 也会被转正（省去手动 publish）。
// 认证：GH_TOKEN 环境变量（CI 中由 secrets 注入）；本地可用 `GH_TOKEN=xxx node scripts/fix-release-drafts.js vX.Y.Z`
const https = require('https');
const { execSync } = require('child_process');

const REPO = 'hwm-1114/markhunter';
const TAG = process.argv[2] || require(process.cwd() + '/package.json').version.replace(/^/, 'v');
const TOKEN = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('[fix-drafts] 缺少 GH_TOKEN');
  process.exit(1);
}

function req(host, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { host, method, path, headers: { Authorization: 'token ' + TOKEN, 'User-Agent': 'mh-fix-drafts', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const api = (m, p, b, h) => req('api.github.com', m, p, b ? JSON.stringify(b) : null, { 'Content-Type': 'application/json', ...h });

// 两跳下载资产（api 带 octet-stream → 302 → 签名 URL 不带认证）
function downloadAsset(id) {
  return req('api.github.com', 'GET', `/repos/${REPO}/releases/assets/${id}`, null, { Accept: 'application/octet-stream' }).then((res) => {
    if (res.status !== 302 || !res.headers.location) throw new Error('asset api ' + res.status);
    const u = new URL(res.headers.location);
    return req(u.host, 'GET', u.pathname + u.search, null, {});
  }).then((res) => {
    if (res.status !== 200) throw new Error('signed url ' + res.status);
    return res.body;
  });
}

function uploadAsset(releaseId, name, buf) {
  return req('uploads.github.com', 'POST', `/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, buf, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buf.length,
  });
}

(async () => {
  const list = JSON.parse((await api('GET', `/repos/${REPO}/releases?per_page=20`)).body.toString());
  const drafts = list.filter((r) => r.draft && r.tag_name === TAG);
  console.log(`[fix-drafts] tag=${TAG} drafts=${drafts.length}`);
  if (drafts.length === 0) {
    console.log('[fix-drafts] 无草稿（可能已发布），跳过');
    return;
  }
  // 完整草稿 = 资产最多者；其余为残缺
  drafts.sort((a, b) => b.assets.length - a.assets.length);
  const full = drafts[0];
  const parts = drafts.slice(1);
  for (const part of parts) {
    for (const a of part.assets) {
      if (full.assets.some((x) => x.name === a.name)) continue;
      console.log(`[fix-drafts] 搬运 ${a.name} (${a.size}B) ${part.id} → ${full.id}`);
      const buf = await downloadAsset(a.id);
      const up = await uploadAsset(full.id, a.name, buf);
      if (up.status !== 201) throw new Error('上传失败 ' + up.status + ' ' + up.body.toString().slice(0, 200));
    }
    const del = await api('DELETE', `/repos/${REPO}/releases/${part.id}`);
    console.log(`[fix-drafts] 删除残缺草稿 ${part.id}: ${del.status === 204 ? 'OK' : del.status}`);
  }
  // 转正发布（已发布过的单草稿幂等）
  const pub = await api('PATCH', `/repos/${REPO}/releases/${full.id}`, { draft: false, make_latest: 'true' });
  if (pub.status !== 200) throw new Error('发布失败 ' + pub.status + ' ' + pub.body.toString().slice(0, 200));
  console.log('[fix-drafts] 已发布:', JSON.parse(pub.body.toString()).html_url);
})().catch((e) => {
  console.error('[fix-drafts] ERR', e.message);
  process.exit(1);
});
