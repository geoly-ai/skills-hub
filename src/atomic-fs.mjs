// 原子写与目录链 fsync —— 规范见 11-wire-contract.md §5、04-install.md §5.2.1
import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** fsync 一个目录（POSIX：需以只读方式打开目录 fd） */
export function fsyncDir(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * 原子写：临时文件 → fsync → rename → fsync 父目录。
 * 🔴 §11 §5：禁止原地覆写。
 * 🔴 失败即停机；**不得声称「磁盘未变」** —— rename 之后、父目录 fsync 报错时文件可能已存在。
 */
export function writeAtomic(path, data) {
  const dir = dirname(path);
  const tmp = join(dir, `.${Date.now().toString(36)}-${process.pid}.tmp`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeFileSync(fd, buf);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/**
 * 逐层创建目录并 fsync 到已存在的祖先为止（§5.2.1）。
 * 反例：只 fsync 叶子时，断电可能「叶子里的文件在、而叶子本身的目录项不在」。
 */
export function mkdirChainFsync(target) {
  const missing = [];
  let cur = target;
  while (!existsSync(cur)) { missing.unshift(cur); cur = dirname(cur); }
  if (missing.length === 0) return;
  for (const d of missing) mkdirSync(d, 0o755);
  // 从最深处往上 fsync：每个新建目录 + 其父
  for (let i = missing.length - 1; i >= 0; i--) fsyncDir(missing[i]);
  fsyncDir(cur); // 已存在的最近祖先
}

/** rmtree 之后 fsync 父目录（§5.4 幂等规则） */
export function fsyncParentAfter(path) {
  const p = dirname(path);
  if (existsSync(p)) fsyncDir(p);
}

/** 判断两个路径是否同设备（stage 与 target 必须同设备，否则 rename 会 EXDEV） */
export function sameDevice(a, b) {
  return statSync(a).dev === statSync(b).dev;
}
