// 原子写与目录链 fsync —— 规范见 11-wire-contract.md §5、04-install.md §5.2.1
//
// 🔴 本模块是**全部**状态写入的唯一出口。故障注入框架（src/fault-inject.mjs）
//    在这里埋具名注入点并维护「持久性影子」，因此**绕过本模块的裸 fs 写入
//    对崩溃测试不可见**。事务内核必须只走这里。
import {
  openSync, closeSync, fsyncSync, writeFileSync, renameSync, mkdirSync,
  existsSync, statSync, lstatSync, readdirSync, unlinkSync, rmdirSync, readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  fp, durableDir, durableFile, pendingCreate, pendingData, pendingRename, pendingUnlink,
  shadowActive,
} from './fault-inject.mjs';

/** fsync 一个目录（POSIX：需以只读方式打开目录 fd） */
export function fsyncDir(dir) {
  fp('fsync-dir:pre', { dir });
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  durableDir(dir);
  fp('fsync-dir:post', { dir });
}

/**
 * 原子写：临时文件 → fsync → rename → fsync 父目录。
 * 🔴 §11 §5：禁止原地覆写。
 * 🔴 失败即停机；**不得声称「磁盘未变」** —— rename 之后、父目录 fsync 报错时文件可能已存在。
 */
// 🔴 `.${Date.now()}-${pid}.tmp` 在同一毫秒内会撞名，`wx` 直接 EEXIST。
//    事务的 journal 每个段都要重写一次，一毫秒里写两次是常态 —— 故障注入
//    框架第一次跑就打出来了。加进程内单调计数器，同进程必不重复。
let tmpSeq = 0;

export function writeAtomic(path, data) {
  const dir = dirname(path);
  const tmp = join(dir, `.${Date.now().toString(36)}-${process.pid}-${(tmpSeq++).toString(36)}.tmp`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    // 🔴 探针必须在 try 里：放在 try 之前时，throw 模式会漏掉这个 fd。
    pendingCreate(tmp);
    fp('atomic-write:post-open-tmp', { path });
    fp('atomic-write:pre-write', { path, syscall: 'write' });
    writeFileSync(fd, buf);
    pendingData(tmp);
    fp('atomic-write:post-write', { path });
    fp('atomic-write:pre-fsync-file', { path, syscall: 'fsync' });
    fsyncSync(fd);
    durableFile(tmp);
    fp('atomic-write:post-fsync-file', { path });
  } finally { closeSync(fd); }
  fp('atomic-write:pre-rename', { path, syscall: 'rename' });
  // 掉电模型需要「这次 rename 没发生」时把被覆盖的旧目标写回去。
  // 🔴 只在影子激活时读 —— 否则生产热路径每写一次状态文件就多读一遍旧文件。
  const overwritten = shadowActive() && existsSync(path) ? readFileSync(path) : undefined;
  renameSync(tmp, path);
  pendingRename(tmp, path, overwritten);
  fp('atomic-write:post-rename', { path });
  fsyncDir(dir);
  fp('atomic-write:post-fsync-dir', { path });
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
  for (const d of missing) { mkdirSync(d, 0o755); pendingCreate(d); }
  fp('mkdir-chain:post-mkdir', { target, created: missing.length });
  // 从最深处往上 fsync：每个新建目录 + 其父
  for (let i = missing.length - 1; i >= 0; i--) {
    fsyncDir(missing[i]);
    fp('mkdir-chain:mid-fsync', { dir: missing[i] });
  }
  fsyncDir(cur); // 已存在的最近祖先
  fp('mkdir-chain:post-fsync', { target });
}

/** rmtree 之后 fsync 父目录（§5.4 幂等规则） */
export function fsyncParentAfter(path) {
  const p = dirname(path);
  if (existsSync(p)) fsyncDir(p);
}

/**
 * 整棵目录的 rename + 两侧父目录 fsync —— §5.3 的 ② 与 ④。
 * 🔴 两侧都要 fsync：只 fsync 目标侧时，断电可能留下「源与目标都在」，
 *    正是 §5.4 幂等表里判 corrupt 的分支 ②。
 */
export function renameDirFsync(from, to) {
  fp('rename-dir:pre', { from, to, syscall: 'rename' });
  renameSync(from, to);
  pendingRename(from, to);
  fp('rename-dir:post-rename', { from, to });
  fsyncDir(dirname(to));
  fp('rename-dir:post-fsync-dst', { from, to });
  const src = dirname(from);
  if (src !== dirname(to)) {
    // 🔴 源父目录不见了不是「跳过」的理由 —— 那说明有第三方在动我们的状态目录。
    //    fail-closed（§5.4 的 I/O 统一规则）。
    if (!existsSync(src)) throw new Error(`rename-dir：源父目录 ${src} 已不存在，无法 fsync`);
    fsyncDir(src);
  }
  fp('rename-dir:post-fsync-src', { from, to });
}

/**
 * 递归删除 + fsync 父目录。
 * §5.4：`rmtree` 天然幂等（不存在就跳过），但 🔴 **成功后必须 fsync 父目录**。
 *
 * 🔴 **自己写递归，不用 `rmSync({recursive:true})`** —— 后者是一次调用，
 *    「删到一半崩」根本注入不进去。而 §5.4 明说「`retired/<name>` 的递归删除
 *    本身是**多次**操作」，那正是要打的窗口。`rmtree:mid` 就埋在每删掉一项之后。
 */
export function rmtreeFsync(path) {
  fp('rmtree:pre', { path });
  // 🔴 `existsSync` 是 fail-open 的：broken symlink、EACCES 都返回 false，
  // 于是「看不见」被当成「不存在」，清理被标记完成而目标其实还在。
  // 判据必须是 lstat 的 errno：只有 ENOENT/ENOTDIR 才是真的没有。
  try {
    lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      fp('rmtree:post', { path, skipped: true });
      return;
    }
    throw err;   // EACCES 之类：看不见就不能声称删干净了
  }
  rmtreeStepwise(path);
  fp('rmtree:post', { path });
  const p = dirname(path);
  if (existsSync(p)) fsyncDir(p);
  fp('rmtree:post-fsync-parent', { path });
}

/**
 * 🔴 **逐项**登记删除效果（Codex 第二轮 #10）。
 * 以前是整棵删完才登记一次、且 undo 是空函数，于是「删到一半掉电」这个窗口
 * 在 powerfail 模型里等于没建模 —— 那正是 §5.6 阶段 C 最危险的一格。
 * 现在每删掉一个条目就存下它的前像，undo 逆序把它放回去。
 */
function rmtreeStepwise(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) {
    const preimage = shadowActive() ? readFileSync(path) : null;
    const mode = st.mode & 0o777;
    unlinkSync(path);
    pendingUnlink(path, preimage, mode);
    fp('rmtree:mid', { removed: path });
    return;
  }
  for (const name of readdirSync(path).sort()) rmtreeStepwise(join(path, name));
  rmdirSync(path);
  pendingUnlink(path, null, 0o755, true);
  fp('rmtree:mid', { removed: path });
}

/** 判断两个路径是否同设备（stage 与 target 必须同设备，否则 rename 会 EXDEV） */
export function sameDevice(a, b) {
  return statSync(a).dev === statSync(b).dev;
}
