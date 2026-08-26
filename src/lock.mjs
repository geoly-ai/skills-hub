// 锁 —— 规范见 04-install.md §5.1
// 🔴 用 node:sqlite 的 BEGIN EXCLUSIVE：进程退出由内核释放，协议里**没有任何 unlink**。
// 🔴 本模块**独占**这些 db 路径；禁止任何其它代码用 fs.open/close 打开它们
//    （POSIX 的「关闭任一 fd 释放该进程全部锁」对绕过 SQLite 的 fd 仍然成立）。
import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';

const held = new Map();   // path -> { db }

export class LockBusyError extends Error {
  constructor(path, holder) {
    const who = holder
      ? `上一次持锁的是 pid ${holder.pid}@${holder.host}（可能已不是当前持有者）`
      : '无法读取持有者信息';
    super(`锁被占用：${path}\n  ${who}`);
    this.name = 'LockBusyError';
    this.code = 5;
    this.holder = holder;
  }
}

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=0');          // 🔴 不等待，冲突即失败
  db.exec('CREATE TABLE IF NOT EXISTS holder(k INTEGER PRIMARY KEY, pid INT, host TEXT, cli TEXT, at TEXT)');
  return db;
}

/** 只读地看一眼上一次已提交的持有者信息 —— 🔴 必然陈旧，仅供人阅读 */
export function readHolder(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare('SELECT pid, host, cli, at FROM holder WHERE k=1').get() ?? null;
  } catch { return null; }
  finally { try { db?.close(); } catch {} }   // 🔴 读完立即关闭，避免 checkpoint starvation
}

/**
 * 取锁。成功返回一个 release 函数。
 * 🔴 holder 在**外层事务内**写、**不中途提交** —— COMMIT 会提交外层事务并释放锁。
 */
export function acquire(path, { cli = 'skills-hub' } = {}) {
  if (held.has(path)) throw new Error(`lock: 本进程已持有 ${path}（禁止重入）`);
  const db = openDb(path);
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    const holder = readHolder(path);
    try { db.close(); } catch {}
    throw new LockBusyError(path, holder);
  }
  // 在外层事务内写 holder，最终 COMMIT 时才对别人可见
  db.prepare('INSERT OR REPLACE INTO holder(k,pid,host,cli,at) VALUES (1,?,?,?,?)')
    .run(process.pid, hostname(), cli, new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
  held.set(path, { db });
  let released = false;
  return function release({ commit = true } = {}) {
    if (released) return;
    released = true;
    try { db.exec(commit ? 'COMMIT' : 'ROLLBACK'); } finally { db.close(); held.delete(path); }
  };
}

/** 按 (st_dev, st_ino) 去重后取多把锁；失败时对已持有的逐一 ROLLBACK + close */
export function acquireAll(paths) {
  const releases = [];
  try {
    for (const p of paths) releases.push(acquire(p));
    return () => { for (const r of releases.reverse()) r(); };
  } catch (e) {
    for (const r of releases.reverse()) { try { r({ commit: false }); } catch {} }
    throw e;
  }
}
