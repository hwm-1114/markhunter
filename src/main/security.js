// 主进程路径安全模块：跟踪当前工作目录（currentRoot）、侧栏多根集合（roots）与已批准路径（approvedSet）
// isApproved(path) = 任一根内（currentRoot 或 roots 各项） || approvedSet.has(realpath(path))
const fs = require('fs');
const path = require('path');

let currentRoot = null;        // 当前活动工作目录的 realpath（经 IPC fs:set-root / fs:set-roots 设置）
const roots = new Set();       // 侧栏打开的全部目录（v0.2.3 多目录：写操作在任一根内均放行）
const approvedSet = new Set(); // 成功 read 过的路径的 realpath 集合

function normalize(p) {
  return path.resolve(String(p || ''));
}

/** target 是否在 root 之内（root 为空时恒为 false） */
function isInside(root, target) {
  if (!root) return false;
  const rel = path.relative(normalize(root), normalize(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 解析真实路径（跟随符号链接；失败时回退为规范化绝对路径） */
function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return normalize(p);
    }
  }
}

/** 设置当前工作目录（openDirFromPath 成功后调用） */
function setRoot(dir) {
  currentRoot = dir ? realpath(dir) : null;
}

/** v0.2.3 多目录：整表同步侧栏根集合 + 活动目录（活动目录必须含于集合）。
 *  openDirFromPath / 关闭根 / boot 恢复统一走这里；空集合时活动目录一并清空。 */
function setRoots(dirs, active) {
  roots.clear();
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (typeof d === 'string' && d) roots.add(realpath(d));
  }
  const act = active && typeof active === 'string' ? realpath(active) : null;
  if (act && roots.has(act)) currentRoot = act;
  else if (roots.size > 0) currentRoot = null; // 活动不在集合内：宁缺毋滥（写操作仍有 roots 各项兜底）
  else currentRoot = null;
}

function getRoot() {
  return currentRoot;
}

/** 侧栏根集合快照（fs:delete 的「不能删除根目录」保护用） */
function getRoots() {
  return [...roots];
}

/** 记录一次成功读取的路径（拖拽打开的外部文件，保存/运行仍可用） */
function approve(p) {
  try {
    approvedSet.add(realpath(p));
  } catch {
    approvedSet.add(normalize(p));
  }
}

/** 判断路径是否允许写入/删除/重命名/运行（v0.2.3 多目录：任一侧栏根内均放行） */
function isApproved(p) {
  if (!p) return false;
  const rp = realpath(p);
  if (currentRoot && isInside(currentRoot, rp)) return true;
  for (const r of roots) {
    if (isInside(r, rp)) return true;
  }
  return approvedSet.has(rp);
}

/** 校验并抛出中文错误（写/建/删/改名操作入口） */
function requireApproved(p, message) {
  const ok = isApproved(p) || (p && isApproved(path.dirname(String(p))));
  if (!ok) throw new Error(message || '路径不在当前工作目录内，操作已拒绝');
  return true;
}

/** 目录内是否存在已批准的文件（M3：粘贴图片允许写入「已打开外部文件」的同级目录）。
 *  S1 语义保持：rootDir 内目录仍由 isInside 覆盖；本函数只放行「确实打开过其中文件」的目录，
 *  不放开无关目录（create/delete/rename 等其它写操作仍要求目标本身或父目录已批准）。 */
function dirHasApprovedFile(dir) {
  let targetDir;
  try {
    targetDir = realpath(dir);
  } catch {
    targetDir = normalize(dir);
  }
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const p of approvedSet) {
    if (same(path.dirname(p), targetDir)) return true;
  }
  return false;
}

/** 同一路径判等（Windows 大小写不敏感）与「p 在 dir 内」前缀判定（含分隔符边界，防 F:\ab 误匹配 F:\a） */
const samePath = (a, b) =>
  process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b);
function isUnderDir(p, dir) {
  if (samePath(p, dir)) return true;
  const sep = path.sep;
  return String(p).startsWith(String(dir) + sep) ||
    (process.platform === 'win32' && String(p).toLowerCase().startsWith(String(dir).toLowerCase() + sep));
}

/** 批准集合中加入路径（优先 realpath，失败回退规范化路径） */
function approvePath(p) {
  try {
    approvedSet.add(realpath(p));
  } catch {
    approvedSet.add(normalize(p));
  }
}

/** 重命名后同步批准集合：旧路径（及其子路径，目录重命名场景）映射到新路径，
 *  避免「外部文件重命名后自动保存被拒」（旧 realpath 失效、新路径未批准）。
 *  旧路径已不存在，此处统一用规范化路径比对（realpath 对已消失路径本来也回退规范化）。 */
function remapApproved(oldPath, newPath) {
  const from = normalize(String(oldPath || ''));
  const to = normalize(String(newPath || ''));
  if (!from || !to) return;
  const moved = [];
  for (const p of approvedSet) {
    if (isUnderDir(p, from)) moved.push(p);
  }
  for (const p of moved) {
    approvedSet.delete(p);
    const rel = samePath(p, from) ? '' : String(p).slice(from.length).replace(/^[\\/]+/, '');
    approvePath(rel ? path.join(to, rel) : to);
  }
  // 旧路径本身不在集合中（如目录重命名但目录内无已批准文件）也补批准新路径：
  // 重命名的前提是旧路径已批准，新路径理应继承该批准
  if (moved.length === 0) approvePath(to);
}

/** 删除后清理批准集合：移除目标本身及其子路径（防止对已删除路径残留写权限） */
function revokeUnder(targetPath) {
  const from = normalize(String(targetPath || ''));
  if (!from) return;
  for (const p of [...approvedSet]) {
    if (isUnderDir(p, from)) approvedSet.delete(p);
  }
}

module.exports = { isInside, setRoot, setRoots, getRoot, getRoots, approve, isApproved, requireApproved, realpath, dirHasApprovedFile, remapApproved, revokeUnder, samePath, isUnderDir };
