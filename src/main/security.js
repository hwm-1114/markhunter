// 主进程路径安全模块：跟踪当前工作目录（currentRoot）与已批准路径（approvedSet）
// isApproved(path) = isInside(root, path) || approvedSet.has(realpath(path))
const fs = require('fs');
const path = require('path');

let currentRoot = null;        // 当前工作目录的 realpath（经 IPC fs:set-root 设置）
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

function getRoot() {
  return currentRoot;
}

/** 记录一次成功读取的路径（拖拽打开的外部文件，保存/运行仍可用） */
function approve(p) {
  try {
    approvedSet.add(realpath(p));
  } catch {
    approvedSet.add(normalize(p));
  }
}

/** 判断路径是否允许写入/删除/重命名/运行 */
function isApproved(p) {
  if (!p) return false;
  const rp = realpath(p);
  if (currentRoot && isInside(currentRoot, rp)) return true;
  return approvedSet.has(rp);
}

/** 校验并抛出中文错误（写/建/删/改名操作入口） */
function requireApproved(p, message) {
  const ok = isApproved(p) || (p && isApproved(path.dirname(String(p))));
  if (!ok) throw new Error(message || '路径不在当前工作目录内，操作已拒绝');
  return true;
}

module.exports = { isInside, setRoot, getRoot, approve, isApproved, requireApproved, realpath };
