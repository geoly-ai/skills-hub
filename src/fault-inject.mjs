// 故障注入内核 —— M0 §6 P0 第 3 项。
//
// 规格依据：docs/m0/00-decisions.md §6、04-install.md §5.2/5.2.1/5.3/5.4/5.6/5.8/5.10、
//           11-wire-contract.md §5。
//
// 设计三条：
//   1. **注入点有名字，不按序号。** 「第 N 次 write」在代码改动后会静默错位，
//      指到完全不同的操作上，测试照样绿。名字改了则 CATALOG 交叉核对会失败（可发现）。
//   2. **框架能枚举注入点。** 无故障跑一趟拿到 trace，再对 trace 里的每一项各崩一次；
//      测试不是手写几十个 case，而是「对这个事务的每一个注入点各跑一遍」。
//   3. **未武装时零开销。** ACTIVE 为 false 时 fp() 第一行就 return。
//
// 🔴 各模式**能证明什么、不能证明什么**，见本文件末尾的 MODES 表与 README 段。
//    特别是：**SIGKILL 不证明持久性**。

import {
  appendFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// ── 模式 ─────────────────────────────────────────────────────────────────────

/**
 * 每种崩溃模式**证明什么 / 不证明什么**。测试报告直接引用这张表，
 * 免得「跑了 200 个注入点」被当成「持久性已证明」。
 */
export const MODES = {
  throw: {
    proves: '调用栈在这一点中断，后续步骤没跑；catch/finally 路径不会把状态改坏。',
    disproves_not:
      '不证明进程真死时的行为 —— finally、进程退出钩子、SQLite 的 close 都仍会跑。',
  },
  exit: {
    proves: 'process.exit()：finally 与 catch 都不跑，只有 exit 钩子跑。',
    disproves_not: '不证明信号/内核级中止；exit 钩子仍有机会写盘。',
  },
  kill: {
    proves:
      'SIGKILL：进程内**任何**收尾代码都不可能跑（无 finally、无 atexit、无信号处理器）。' +
      '证明的是「时序」—— 恢复逻辑必须能从「第 k 步之后、第 k+1 步之前」接上。',
    disproves_not:
      '🔴 **不证明持久性。** POSIX 下 write() 的数据在内核页缓存里，进程被杀不会丢；' +
      '只有掉电/内核崩溃才会丢。因此「SIGKILL 后恢复正常」**不能**推出「fsync 用对了」。' +
      '想证明 fsync 用对了，用 powerfail 模式（近似）或块设备层工具（dm-log-writes，非本框架范围）。',
  },
  errno: {
    proves:
      '以 EIO/ENOSPC 失败并把控制权交回调用方 —— 证明 §5.4「I/O 失败统一规则」的 ' +
      'fail-closed：不推进 journal、不当成功、不吞错。\n' +
      '🔴 **两种失败语义靠注入点位置区分，不靠模式**：\n' +
      '  · 打在 `…:pre-X` 上  = 「syscall 失败且没有副作用」；\n' +
      '  · 打在 `…:post-X` 上 = 「syscall 已生效但随后报错」—— 这正是 §11 §5 说的\n' +
      '    「rename 已经生效、而随后的父目录 fsync 报错时，目标文件**可能已经存在**」，\n' +
      '    规范据此禁止任何「写失败 → 磁盘未变」的说法。',
    disproves_not: '不证明真实设备上的错误传播（EIO 之后 fd 状态、page 是否已回写）。',
  },
  powerfail: {
    proves:
      '掉电近似：把「已发生但其所在目录/文件尚未 fsync」的效果**撤销**，再 SIGKILL。' +
      '这是唯一能打到 §5.2.1「两棵都丢」那个反例的模式 —— ' +
      '只 fsync 叶子时，上层目录项没落盘，断电后新建的 tx 根连同两棵树一起消失。',
    disproves_not:
      '🔴 这是 **API 边界上的仿真**，不是块设备层的。不建模：写入乱序、页内撕裂（部分写）、' +
      '文件系统自身的日志语义、以及**任何绕过 atomic-fs 的裸 fs 调用**（那些效果对它不可见）。',
  },
};

export class FaultInjected extends Error {
  constructor(name, nth, mode) {
    super(`fault-inject: ${name} #${nth} (mode=${mode})`);
    this.name = 'FaultInjected';
    this.faultPoint = name;
    this.nth = nth;
    this.mode = mode;
  }
}

// ── 状态 ─────────────────────────────────────────────────────────────────────

let ACTIVE = false; // ARMED || TRACING —— fp() 的快速守卫
let ARMED = false;
let LOCKED = false; // lockdown() 之后永久不可武装（生产入口调用）
let TARGET = null;
let NTH = 1;
let MODE = 'throw';
let ERRNO = 'EIO';
let TRACE_PATH = null;
const counts = new Map();
const hits = []; // 本进程命中过的 (name, nth)，供进程内测试断言

function recompute() {
  ACTIVE = ARMED || TRACE_PATH !== null;
}

// ── 注入点探针 ───────────────────────────────────────────────────────────────

/**
 * 具名注入点。埋在**每一个写操作的前后**，名字形如 `atomic-write:pre-rename`。
 * @param {string} name  必须出现在 test/harness/fault-points.mjs 的 CATALOG 里
 *                       （test/fault-matrix.test.mjs 做三向交叉核对）
 * @param {object} [ctx] 诊断上下文，只进 trace，不参与判定
 */
export function fp(name, ctx) {
  if (!ACTIVE) return;
  const n = (counts.get(name) ?? 0) + 1;
  counts.set(name, n);
  // 🔴 trace 本身绝不能改变被测操作的语义：写 trace 失败、ctx 不可序列化，
  //    都只能被吞掉，不能变成被测代码看到的异常。
  if (TRACE_PATH !== null) {
    let extra = '';
    try { extra = ctx ? JSON.stringify(ctx) : ''; } catch { extra = '<unserializable>'; }
    try { appendFileSync(TRACE_PATH, `${name}\t${n}\t${extra}\n`); } catch { /* 见上 */ }
  }
  if (!ARMED || name !== TARGET || n !== NTH) return;
  hits.push({ name, nth: n });
  return detonate(name, n, ctx);
}

function detonate(name, nth, ctx) {
  switch (MODE) {
    case 'throw':
      throw new FaultInjected(name, nth, MODE);
    case 'errno': {
      const e = new FaultInjected(name, nth, MODE);
      e.code = ERRNO;
      e.errno = -5;
      e.syscall = ctx?.syscall ?? 'write';
      throw e;
    }
    case 'exit':
      // 97 = 「这是注入的崩溃」，与任何真实退出码区分开
      process.exit(97);
      break;
    case 'powerfail':
      applyPowerFailure();
      process.kill(process.pid, 'SIGKILL');
      break;
    case 'kill':
      process.kill(process.pid, 'SIGKILL');
      break;
    default:
      throw new Error(`fault-inject: 未知模式 ${MODE}`);
  }
  // SIGKILL 在返回用户态时投递，实践上是同步的；但不挡一下的话，
  // 万一没落地，被注入的那一步会**继续执行**，注入点就错位了。
  // 有界忙等（2s）之后退而求其次用 exit，避免测试套件真的悬挂。
  if (MODE === 'kill' || MODE === 'powerfail') {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      /* 等信号落地 */
    }
    process.exit(97);
  }
}

// ── 武装 / 解除 ──────────────────────────────────────────────────────────────

export function arm({ name, nth = 1, mode = 'throw', errno = 'EIO' } = {}) {
  if (LOCKED) throw new Error('fault-inject: 已 lockdown，不可武装');
  if (!name) throw new Error('fault-inject: arm 需要 name');
  if (!(mode in MODES)) throw new Error(`fault-inject: 未知模式 ${mode}`);
  ARMED = true;
  TARGET = name;
  NTH = Number(nth);
  MODE = mode;
  ERRNO = errno;
  recompute();
}

export function disarm() {
  ARMED = false;
  TARGET = null;
  recompute();
}

/** 生产入口（bin/）应调用它：此后 env 与 arm() 都无法再打开注入。 */
export function lockdown() {
  LOCKED = true;
  ARMED = false;
  TARGET = null;
  TRACE_PATH = null;
  pending.length = 0;
  recompute();
}

export function setTrace(path) {
  if (LOCKED) throw new Error('fault-inject: 已 lockdown');
  TRACE_PATH = path;
  recompute();
}

export function reset() {
  counts.clear();
  hits.length = 0;
  pending.length = 0;
}

export function observed() {
  return hits.slice();
}

export function hitCount(name) {
  return counts.get(name) ?? 0;
}

export function state() {
  return { ACTIVE, ARMED, LOCKED, TARGET, NTH, MODE, TRACE_PATH };
}

/** 生产热路径用它跳过只为掉电模型服务的额外 I/O */
export function shadowActive() {
  return ACTIVE;
}

/**
 * 从环境读配置。🔴 **必须由调用方显式调用** —— 本模块**不在 import 时自动调用**。
 *    子进程崩溃测试在 test/harness/child.mjs 里显式调它。
 *
 * 🔴 **双钥匙**：还必须有 `GEOLY_FAULT_ENABLE=1`。
 *    单一变量太容易被误设/继承，而它能让生产 CLI 在真实 target 上崩溃。
 *
 *   GEOLY_FAULT_ENABLE 必须是 "1"，否则以下全部忽略
 *   GEOLY_FAULT        注入点名
 *   GEOLY_FAULT_NTH    第几次命中（默认 1）
 *   GEOLY_FAULT_MODE   throw|exit|kill|errno|powerfail（默认 throw）
 *   GEOLY_FAULT_ERRNO  errno 模式用的 code（默认 EIO）
 *   GEOLY_FAULT_TRACE  trace 落点文件
 * 🔴 名字里有冒号，所以**不做 `name:mode` 拼接**，各占一个变量。
 */
export function armFromEnv(env = process.env) {
  if (LOCKED) return;
  if (env.GEOLY_FAULT_ENABLE !== '1') return;
  if (env.GEOLY_FAULT_TRACE) setTrace(env.GEOLY_FAULT_TRACE);
  if (env.GEOLY_FAULT) {
    arm({
      name: env.GEOLY_FAULT,
      nth: env.GEOLY_FAULT_NTH ? Number(env.GEOLY_FAULT_NTH) : 1,
      mode: env.GEOLY_FAULT_MODE ?? 'throw',
      errno: env.GEOLY_FAULT_ERRNO ?? 'EIO',
    });
  }
}

// ── 持久性影子（powerfail 模式）─────────────────────────────────────────────
//
// atomic-fs 每做一次「尚未持久」的改动就登记一条 undo；对应的 fsync 一旦成功
// 就把它划掉。powerfail = 逆序执行还没划掉的 undo，然后 SIGKILL。
//
// 🔴 只覆盖走 atomic-fs 的改动。裸 fs 调用对它不可见 —— 这是仿真的边界，不是 bug。

// 每条 pending：{ dirs: Set<string>, files: Set<string>, tag, undo() }
// 「dirs 与 files 都被 fsync 过」才算持久，才从表里划掉。
const pending = [];

let POWERFAIL_STYLE = process.env.GEOLY_FAULT_POWERFAIL_STYLE ?? 'drop';

export function setPowerfailStyle(s) {
  POWERFAIL_STYLE = s;
}

/** 登记「`path` 这个目录项刚出现，但 `dirname(path)` 还没 fsync」 */
export function pendingCreate(path) {
  if (!ACTIVE) return;
  pending.push({
    dirs: new Set([dirname(path)]),
    files: new Set(),
    tag: `create ${path}`,
    undo: () => rmSync(path, { recursive: true, force: true }),
  });
}

/**
 * 登记「`from` → `to` 的 rename 刚发生」。
 * 🔴 rename 动两个目录项：源目录里少一个、目标目录里多一个。
 *    **两侧父目录都 fsync 过**才算持久。
 * 掉电后的两种合法结果，本模型二选一（GEOLY_FAULT_POWERFAIL_STYLE）：
 *   · `drop`      —— 当作 rename 没发生（把 `to` 搬回 `from`）；
 *   · `duplicate` —— 目标侧目录项落盘、源侧删除未落盘 ⇒ **两边都在**。
 *                    这正是 §5.4 幂等表里判 corrupt 的分支 ②，值得单独打。
 */
export function pendingRename(from, to, overwrittenBytes) {
  if (!ACTIVE) return;
  pending.push({
    dirs: new Set([dirname(to), dirname(from)]),
    files: new Set(),
    tag: `rename ${from} -> ${to}`,
    undo: () => {
      if (!existsSync(to) || existsSync(from)) return;
      if (POWERFAIL_STYLE === 'duplicate') { cpSync(to, from, { recursive: true }); return; }
      renameSync(to, from);
      // 🔴 rename **覆盖**了一个已存在的目标时，「这次 rename 没发生」意味着
      //    旧目标还在。不把它写回去，撤销结果就不是一个合法的掉电分支。
      if (overwrittenBytes !== undefined) writeFileSync(to, overwrittenBytes);
    },
  });
}

/**
 * 登记「`path` 刚被删，父目录还没 fsync」。
 * 🔴 undo 会把它**放回去** —— 删除未落盘时掉电，目录项还在。
 *    这一条是 §5.6 阶段 C「删到一半」那个窗口的唯一建模途径；
 *    以前写成空函数时，powerfail 在这一格是**假绿**（Codex 第二轮 #10）。
 * @param {Buffer|null} preimage 文件内容前像；目录传 null
 * @param {number} mode
 * @param {boolean} [isDir]
 */
export function pendingUnlink(path, preimage = null, mode = 0o644, isDir = false) {
  if (!ACTIVE) return;
  pending.push({
    dirs: new Set([dirname(path)]),
    files: new Set(),
    tag: `unlink ${path}`,
    undo: () => {
      if (existsSync(path)) return;
      if (isDir) { mkdirSync(path, mode); return; }
      if (preimage !== null) writeFileSync(path, preimage, { mode });
    },
  });
}

/** 登记「`path` 的数据已 write，但文件自身与父目录都还没 fsync」 */
export function pendingData(path) {
  if (!ACTIVE) return;
  pending.push({
    dirs: new Set([dirname(path)]),
    files: new Set([path]),
    tag: `data ${path}`,
    undo: () => {
      try {
        if (existsSync(path) && statSync(path).isFile()) unlinkSync(path);
      } catch {
        /* 掉电模型下这一步失败无所谓 */
      }
    },
  });
}

function sweep() {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].dirs.size === 0 && pending[i].files.size === 0) pending.splice(i, 1);
  }
}

/** 某个目录 fsync 成功 */
export function durableDir(dir) {
  if (!ACTIVE) return;
  for (const p of pending) p.dirs.delete(dir);
  sweep();
}

/** 某个文件 fsync 成功（它的目录项可能仍未持久 —— 那部分靠 durableDir 划） */
export function durableFile(file) {
  if (!ACTIVE) return;
  for (const p of pending) p.files.delete(file);
  sweep();
}

export function pendingEffects() {
  return pending.map((p) => p.tag);
}

/** 逆序撤销全部未持久效果 */
export function applyPowerFailure() {
  for (let i = pending.length - 1; i >= 0; i--) {
    try {
      pending[i].undo();
    } catch {
      /* 掉电不会报错 */
    }
  }
  pending.length = 0;
}

// 🔴 **刻意不在 import 时自动调用 armFromEnv()**（Codex 第二轮 P0-1）。
//    生产入口 bin/skills-hub.mjs 在 import 之后才有机会 lockdown()，ESM 下已经太晚 ——
//    只要模块一加载就读 env，用户环境里的 GEOLY_FAULT_ENABLE=1 就能让生产 CLI
//    在真实 target 上 SIGKILL，GEOLY_FAULT_TRACE 还能让它往任意路径追加内容。
//    改为**必须显式初始化**：测试 harness（test/harness/child.mjs）自己调 armFromEnv()。
