// 加锁 —— 04-install.md §5.1「加锁顺序（全序，防死锁）」。
//
//     metadata 锁（仅验证与推进 trust floor，用完立即释放）
//       → repo 锁（仅项目级；保护 lockfile 重算与写入）
//         → target 锁（多个时按 (st_dev, st_ino) 字节序升序）
//
// 🔴 **不得存在任何「先 target 后 repo」的路径。**
//
// 🔴 metadata 锁**不由本模块取**。`trust.advanceTrustFloor()` 自己 acquire/release
//    （src/trust.mjs），而 `src/lock.mjs` **禁止重入** —— 命令面再包一层就会在
//    第二次 acquire 时直接抛「本进程已持有」。因此正确的形状是：
//      ① 先跑完解析阶段（`snapshot.resolveCurrent()`，metadata 锁在它内部起落）；
//      ② 解析返回之后，再按 repo → target 取事务锁。
//    全序仍然成立：metadata 的持有区间整个位于 repo/target 之前。
//
// 🔴 后续取锁失败时，对已持有的锁**逐一 ROLLBACK + close 再退出**，
//    不得带着半套锁做任何事。

import { statSync, lstatSync } from 'node:fs';
import { join, sep } from 'node:path';
import { acquire } from '../lock.mjs';
import { mkdirChainFsync } from '../atomic-fs.mjs';
import { STATE_DIR } from '../adapters/index.mjs';
import { assertNoSymlinkInChain } from '../safe-fs.mjs';
import { EXIT, UnsupportedError } from '../exit-codes.mjs';

/** repo 锁的位置（§8.1）。 */
export const repoLockPath = (projectRoot) => join(projectRoot, '.geoly-skills.lock.db');

/** target 锁的位置（§5.1.1）：**target 自身的一部分**，别名路径打开同一个 inode。 */
export const targetLockPath = (target) => join(target, STATE_DIR, 'lock.db');

/**
 * (st_dev, st_ino) 的定宽排序键。
 *
 * 🔴 **不是按 realpath 排序**：bind alias 下 realpath 不稳定，
 *    两个进程可能算出相反顺序而互相卡死（§5.1 明确禁止）。
 * 🔴 定宽 hex 才等价于「字节序」：`String(dev)` 会让 9 排在 10 后面。
 */
function physicalKey(dev, ino) {
  const h = (n) => BigInt(n).toString(16).padStart(20, '0');
  return `${h(dev)}:${h(ino)}`;
}

/**
 * 按 §5.1 对 target 集合**去重 + 排序**。
 *
 * @param {string[]} targets  绝对路径。**必须已经存在** —— `--create-missing` 的建目录
 *        动作发生在这之前（见 `install.mjs` 的注释：它是本次运行的第一个磁盘写入，
 *        失败时留下的是一个空的客户端目录，而不是半个事务）。
 * @returns {{path:string, key:string, dev:number, ino:number, aliases:string[]}[]}
 */
export function orderTargets(targets) {
  const byKey = new Map();
  for (const t of targets) {
    const st = statSync(t);   // target 用 stat：它可以是被 realpath 过的正常目录
    const key = physicalKey(st.dev, st.ino);
    const cur = byKey.get(key);
    if (cur) { cur.aliases.push(t); continue; }   // 🔴 bind-alias 去重
    byKey.set(key, { path: t, key, dev: st.dev, ino: st.ino, aliases: [] });
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 🔴 **取锁之前**的窄门：`.geoly/` 与三个锁文件都不许是 symlink。
 *
 * 为什么不能等到 §5.2 第 3 步的预检：锁**就在 `.geoly/` 里面**（§5.1.1），
 * 而取锁是第 1 步。`new DatabaseSync(path)` 会**跟随** symlink ——
 * 把 `.geoly` 或 `lock.db` 换成指向别处的软链，我们就会在 target 之外
 * 创建并写入 holder 表，而内核那道 `assertStatePathsNoSymlink()` 要到第 2 步才跑。
 * 那不只是「错误码落错格」，是一个**写入路径穿越**。
 *
 * ⚠️ **这是窄门，不是完整的 §3.4 检查**：它只覆盖取锁这一步真正会打开的那几个路径，
 * 而且与 R-1 / R-2 同样是 TOCTOU 的（Node 不暴露 `openat`）。
 * 完整的路径链检查仍然在第 3 步的 `precheckTarget()` 里。
 */
function assertLockPathsNotSymlink(target, base = null) {
  const reject = (msg) => {
    // 🔴 这是 §3.4 那一类（路径安全），按 §6 第 9 条落 **9**，不是 5。
    //    早先它被命名成 Corrupt 因而落 5 —— 那会把「路径穿越」报成「需要 recover」。
    throw new UnsupportedError(msg, { telemetryReason: 'unknown' });
  };
  // ① 整条路径链：从可信 base 一路查到 target 自己。
  //    只查最后一个节点是不够的 —— 父级被换成软链同样能把状态写到 target 之外。
  if (base) {
    const rel = target.startsWith(base + sep) ? target.slice(base.length + 1) : null;
    if (rel === null) reject(`target 不在可信 base 之下：${target} 不在 ${base} 里`);
    try { assertNoSymlinkInChain(base, rel); } catch (e) { reject(`取锁前的路径链检查不通过：${e.message}`); }
  }
  // ② 取锁这一步真正会 open 的那几个路径，逐个 lstat 无跟随
  const state = join(target, STATE_DIR);
  for (const p of [state, join(state, 'lock.db'), join(state, 'lock.db-wal'), join(state, 'lock.db-shm')]) {
    let st;
    try { st = lstatSync(p); } catch (e) {
      if (e?.code === 'ENOENT') continue;      // 还没有 —— 稍后由我们自己建
      reject(`取锁前无法 lstat ${p}（${e.code}）—— 看不见就不能声称它是安全的`);
    }
    if (st.isSymbolicLink()) {
      reject(`拒绝取锁：${p} 是 symlink（04-install.md §3.4）。`
        + '锁文件由 SQLite 直接打开，会跟随软链把状态写到 target 之外。');
    }
  }
  const st = lstatSync(target);
  if (!st.isDirectory()) reject(`拒绝取锁：${target} 不是普通目录（lstat 无跟随判定）`);
}

/** repo 锁也要过同一道门 —— 它同样是被 SQLite 直接 open 的。 */
function assertRepoLockNotSymlink(projectRoot) {
  const base = repoLockPath(projectRoot);
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    let st;
    try { st = lstatSync(p); } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw new UnsupportedError(`取 repo 锁前无法 lstat ${p}（${e.code}）`, { telemetryReason: 'unknown' });
    }
    if (st.isSymbolicLink()) {
      throw new UnsupportedError(
        `拒绝取 repo 锁：${p} 是 symlink（04-install.md §3.4）`, { telemetryReason: 'unknown' },
      );
    }
  }
}

/**
 * 按全序取 repo → target 锁，跑 `fn`，然后**逆序**释放。
 *
 * @param {object} o
 * @param {string|null} o.projectRoot  非 null 时取 repo 锁
 * @param {string[]}    o.targets      物理 target 目录（已存在）
 * @param {(held:{targets:object[], repo:string|null}) => any} fn
 *
 * 🔴 `fn` 抛错时锁按 `commit: true` 释放。理由：holder 行是**诊断信息**，
 *    不是事务数据；ROLLBACK 掉它只会让下一个人看到更旧的 pid。
 *    真正需要 ROLLBACK 的是**取锁过程中途失败**那条路径（见下面的 catch）——
 *    那时半套锁一个都不该留下痕迹。
 */
export function withOrderedLocks({ projectRoot = null, targets = [], baseFor = () => null }, fn) {
  const ordered = orderTargets(targets);
  const held = [];
  try {
    // ① repo 锁（仅项目级）
    if (projectRoot !== null) {
      assertRepoLockNotSymlink(projectRoot);
      held.push(acquire(repoLockPath(projectRoot)));
    }
    // ② target 锁，去重后按 (st_dev, st_ino) 升序
    for (const t of ordered) {
      // 🔴 `<target>/.geoly/` 由取锁这一步建出来（锁就在它里面，§5.1.1）。
      //    这是**规范自身的形状**，不是我们多建的：崩在这里会留下一个空的
      //    `.geoly/lock.db`，下一次运行照常取锁、照常继续 —— 幂等，不是半截事务。
      // 🔴 建不出 `.geoly/` 就是 §6 第 10 条那一格（「target 不可写（无法创建
      //    `<target>/.geoly/`）」）—— 那正是这条退出码的字面定义。
      //    不映射的话它会以一条裸 EACCES 的身份落到「认不出来的错」里去。
      //    ⚠️ 这道判定发生在**第 1 步**（取锁），比 §5.2 第 3 步的预检更早 ——
      //    因为锁就在 `.geoly/` 里面，建不出来就根本进不到预检。
      assertLockPathsNotSymlink(t.path, baseFor(t.path));
      try {
        mkdirChainFsync(join(t.path, STATE_DIR));
      } catch (e) {
        // 🔴 并发建目录：`mkdirChainFsync` 是 existsSync → mkdirSync，不是原子的。
        //    两个进程同时启动时输家会拿到裸 EEXIST —— 那不是错误，目录已经在了。
        if (e?.code === 'EEXIST') {
          // 🔴 EEXIST 只说明「那个名字被占了」，**不说明占它的是一个普通目录**。
          //    一律放行的话，一个抢在我们前面建出来的 symlink / 普通文件就穿过了窄门。
          const st = lstatSync(join(t.path, STATE_DIR));
          if (st.isSymbolicLink() || !st.isDirectory()) {
            throw new UnsupportedError(
              `${join(t.path, STATE_DIR)} 被一个非普通目录占用（并发竞态或有人塞了东西）`,
              { telemetryReason: 'unknown' },
            );
          }
        }
        else if (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') {
          const err = new Error(
            `target 不可写：建不出 ${join(t.path, STATE_DIR)}（${e.code}）。`
            + '锁与全部事务状态都在这个目录里，建不出来就无从开始（04-install.md §3.6 / §5.1.1）。',
          );
          err.name = 'TargetNotWritable';
          err.exitCode = EXIT.NOT_WRITABLE;
          err.telemetryReason = 'target-not-writable';
          throw err;
        } else throw e;
      }
      held.push(acquire(targetLockPath(t.path)));
    }
  } catch (e) {
    // 🔴 半套锁：逐一 ROLLBACK + close 再把错抛出去
    for (const r of held.reverse()) { try { r({ commit: false }); } catch { /* 已经坏了 */ } }
    throw e;
  }
  try {
    return fn({ targets: ordered, repo: projectRoot === null ? null : repoLockPath(projectRoot) });
  } finally {
    for (const r of held.reverse()) { try { r(); } catch { /* 释放尽力而为 */ } }
  }
}
