// target 预检 —— 规范见 04-install.md §2.2 / §3.3 / §3.4 / §3.5 / §3.6
//
// 这个模块只做**编排**：底层的每一条判据都在 `src/safe-fs.mjs` 里，这里负责
//   ① 按规格把它们凑齐，一条不漏；
//   ② 🔴 **一次报出全部违规项**，而不是遇到第一个就退出 ——
//      用户不该修一个跑一次，尤其预检里有好几条是「改环境」而不是「改命令」。
//
// 🔴 **预检不能保证「世界不会变」**（§5.10 明文）。
// target 锁只约束遵守该锁的 CLI，不约束用户与其它进程。
// `precheckTarget()` 返回的是一个**带时间戳的快照结论**：它保证的是
// 「`checkedAt` 那一刻不存在已知的死路」，**不保证之后仍然成立**。
// 每一次真正的 rename、以及任何会毁掉恢复源的动作，都必须**在动作点复验并 fail-closed**。
// 因此本模块**故意不提供** `precheckAndLock` / `precheckAndInstall` 这类
// 会暗示原子性的组合 API —— 那种 API 形状本身就在骗人。
import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, relative, isAbsolute, resolve, sep, parse } from 'node:path';
import {
  assertSupportedFilesystem,
  assertNotMountPoint,
  assertNoMountPointsUnder,
  assertNoSymlinkInChain,
  assertPlainFileOrDir,
  assertWritableDir,
  _resetMountCache,
} from './safe-fs.mjs';
import {
  STATE_DIR,
  CLIENTS,
  getAdapter,
  gitignorePatternsFor,
  GIT_CLEAN_WARNING,
} from './adapters/index.mjs';

/** 违规码。每一条都对应规格里的一条明文规则，测试逐条断言**报出了哪一项**。 */
export const V = Object.freeze({
  UNSUPPORTED_FSTYPE: 'fs.unsupported-fstype', // §2.2
  CROSS_DEVICE: 'fs.cross-device', // §2.2
  OUTSIDE_BASE: 'target.outside-base', // 配置错误：target 不在可信 base 之下
  SYMLINK_IN_CHAIN: 'target.symlink-in-chain', // §3.4
  NOT_PLAIN_DIR: 'target.not-plain-dir', // §3.4 / 01-artifacts §5
  STATE_SYMLINK: 'geoly.symlink-state-path', // §3.4
  STATE_NOT_PLAIN: 'geoly.not-plain', // §3.4
  GEOLY_IS_MOUNT: 'geoly.is-mount-point', // §3.4
  GEOLY_MOUNT_UNDER: 'geoly.mount-point-under', // §3.4
  NESTED_TARGET: 'target.nested', // §3.5
  SCAN_INCOMPLETE: 'target.nested-scan-incomplete', // §3.5：扫不完就不能宣称没有嵌套
  STATE_SCAN_INCOMPLETE: 'geoly.state-scan-incomplete', // §3.4：同理，扫不完就不能宣称没有 symlink
  NOT_WRITABLE: 'target.not-writable', // §3.6
  BASE_MISSING: 'target.base-missing', // 可信 base 本身不存在，symlink 链无从查起
});

/**
 * 🔴 底层判据的**测试注入缝**，故意用 Symbol 做 key。
 *
 * 有些拒绝规则（NFS/sshfs 挂载、只读挂载、bind mount、跨设备）在 CI 里造不出真实形状，
 * 不注入就只能断言「抛了错」，而验收标准要的是「断言报出了哪一项违规」。
 *
 * 用 Symbol 而不是普通字符串 key，是为了让这个缝**不可能被顺手透传**：
 * 普通调用方从 CLI 参数、JSON 配置、`{...opts}` 里拼出来的对象带不上一个
 * 只在本模块导出的 Symbol。要用它必须显式 import，那就是一个有意的动作。
 * 再加两道：结果里带 `depsOverridden`，且 `assertPrecheckOk` **拒绝**放行被注入过的结果。
 */
export const TEST_DEPS = Symbol('target.precheck.testDeps');

/**
 * 🔴 「这份结果是用真判据算出来的」这个事实**不能存在结果对象里**。
 *
 * 存成一个 `depsOverridden: false` 字段是不够的：拿到结果的人写一句
 * `r.depsOverridden = false`（甚至 `r.ok = true`）就把边界拆了。
 * 公开的布尔字段只是**给人看的**，不能拿来做放行判据。
 *
 * 判据放在模块私有的 WeakSet 里：外面拿不到这个引用，就伪造不出成员资格。
 * 结果对象本身也冻结，省得有人改 `violations` 再拿去放行。
 */
const CLEAN_PRECHECKS = new WeakSet();

/** 递归冻结。`detail` 以后放进嵌套对象时，浅冻结会漏掉内层。 */
function deepFreeze(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const v of Object.values(o)) deepFreeze(v);
  return o;
}

/**
 * 🔴 「有效 `.geoly` 状态」的判据（§3.5 收窄识别范围用）。
 *
 * 为什么不能「有个叫 `.geoly` 的目录就算」：那等于按名字扫后代，
 * 规格明确点名这会**误伤普通目录**（有人手工建了个空 `.geoly`、或者某个 skill
 * 自己带了同名目录）。判据必须是**实际存在的状态标记**。
 *
 * ⚠️ `audit-seq` 必须在清单里：§4 规定「没有 ledger 但 seq 存在」是**合法状态**
 * （pre-commit 清理只删骨架、不删 seq）。漏掉它会把一个真 target 判成普通目录。
 */
const STATE_MARKER_FILES = [
  'ledger.json',
  'lock.db',
  'lock.db-wal',
  'lock.db-shm',
  'generation',
  'audit-seq',
  'repair-intent.json',
  'audit-archive-intent.json',
];
const STATE_MARKER_DIRS = ['journal', 'attic', 'quarantine', 'audit-archive'];

/** `.geoly` 之下会出现的状态路径，全部要以 lstat 无跟随方式检查（§3.4）。 */
const SCAN_DEFAULTS = Object.freeze({ maxDepth: 8, maxDirs: 5000 });

/**
 * 🔴 扫描上限必须校验。`NaN` 参与 `>=` 永远是 false ——
 * 传进来一个 `NaN`（或 `'8'` 之类）会让 `visited >= maxDirs` 恒不成立，
 * 有界遍历悄悄变成无界遍历。这不是「参数写错了自己负责」，
 * 因为它不报错、看起来还更"彻底"，只是会把整棵盘扫一遍。
 */
function normalizeScan(scan = {}) {
  const pick = (v, dflt, name) => {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`scan.${name} 必须是有限的非负数，收到 ${JSON.stringify(v)}`);
    }
    return Math.floor(v);
  };
  return {
    maxDepth: pick(scan.maxDepth, SCAN_DEFAULTS.maxDepth, 'maxDepth'),
    maxDirs: pick(scan.maxDirs, SCAN_DEFAULTS.maxDirs, 'maxDirs'),
  };
}

// ── 有效状态判定 ─────────────────────────────────────────────────────────────

/**
 * `dir` 是不是一个**带有效 `.geoly` 状态**的 target。
 * 全程 `lstat` 无跟随：`.geoly` 是 symlink 时**不算**有效状态（它另有一条违规码），
 * 也绝不跟过去看对面有什么。
 */
export function hasGeolyState(dir) {
  const state = join(dir, STATE_DIR);
  let st;
  try {
    st = lstatSync(state);
  } catch (err) {
    // 🔴 fail-closed 同上：ENOENT 是「真没有」，其余（EACCES 等）是「看不了」。
    // 把「看不了」判成「没有」会让一个真 target 被当成普通目录去替换。
    return !isAbsent(err);
  }
  if (!st.isDirectory()) return false; // symlink / 普通文件都不算
  let names;
  try {
    names = readdirSync(state);
  } catch (err) {
    if (isAbsent(err)) return false; // 刚被删掉，确实没有
    // 🔴 fail-closed：读不进去（EACCES/EPERM）**不等于**没有状态。
    // 判成「普通目录」会让一个真 target 被当成可以随便替换的 skill 目录 ——
    // 那正是 §3.5 要防的事故。读不了就当它有。
    return true;
  }
  const set = new Set(names);
  for (const f of STATE_MARKER_FILES) if (set.has(f)) return true;
  for (const d of STATE_MARKER_DIRS) if (set.has(d)) return true;
  for (const n of names) if (n.startsWith('tx-')) return true;
  return false;
}

// ── 嵌套 target（§3.5） ──────────────────────────────────────────────────────

const isUnder = (child, parent) => {
  if (child === parent) return false;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(p);
};

/**
 * 找出与 `targetPath` 构成嵌套关系的其它 target。
 *
 * 🔴 识别范围**必须收窄**（§3.5）——只算两类：
 *   ① 本次命令**目标集合**里的其它 target（无论它有没有状态，我们这就要往里写）；
 *   ② **实际带有有效 `.geoly/` 状态**的目录（`hasGeolyState`）。
 * 绝不按名字扫任意后代的 `.claude/skills` —— 那会误伤普通目录。
 */
export function findNestedTargets(targetPath, { targetSet = [], scan = {} } = {}) {
  const { maxDepth, maxDirs } = normalizeScan(scan);
  const self = tryRealpath(targetPath);
  const hits = [];
  const seen = new Set();
  const add = (path, relation, via) => {
    const key = `${relation}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ path, relation, via });
  };

  // ① 目标集合
  for (const other of targetSet) {
    const o = tryRealpath(other);
    if (o === self) continue;
    if (isUnder(self, o)) add(o, 'ancestor', 'target-set');
    else if (isUnder(o, self)) add(o, 'descendant', 'target-set');
  }

  // ②a 向上：任一祖先带有效状态 → 我们在别人的 target 里面
  // 一路走到文件系统根：外层 target 完全可能在可信 base 之上
  // （例如整个仓库被 clone 进了某个 `<...>/skills/<name>/` 目录里）。
  // 代价只是几次 lstat，换的是不漏判。
  // 🔴 **包含文件系统根本身**：`cur !== parent` 当条件会在 `/` 上提前退出，
  // 于是根目录里的一个有效 `.geoly` 会漏判。
  for (let cur = parse(self).dir; ; cur = parse(cur).dir) {
    if (hasGeolyState(cur)) add(cur, 'ancestor', 'geoly-state');
    if (!cur || cur === parse(cur).dir) break; // 判完根再退出
  }

  // ②b 向下：有界遍历，找带有效状态的后代
  const scanResult = walkBounded(self, { maxDepth, maxDirs }, (dir) => {
    if (dir !== self && hasGeolyState(dir)) add(dir, 'descendant', 'geoly-state');
  });

  return { nested: hits, complete: scanResult.complete, visited: scanResult.visited };
}

/**
 * 有界遍历。不跟随 symlink（`readdirSync` 的 Dirent 判类型，不 stat）、
 * 跳过 `.geoly` 自身（它的内容由状态路径检查负责，不是嵌套候选）。
 *
 * 🔴 撞到上限**不静默放过**：调用方会因此记一条 `target.nested-scan-incomplete`。
 * 「扫不完」与「扫完了没有」是两件事，把前者说成后者就是在假装证明了一个否定命题。
 */
function walkBounded(root, { maxDepth, maxDirs }, visit) {
  let visited = 0;
  let complete = true;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (visited >= maxDirs) {
      complete = false;
      break;
    }
    visited += 1;
    visit(dir);
    if (depth >= maxDepth) {
      // 深度到顶但下面还有目录 → 同样是「没扫完」
      if (hasSubdir(dir)) complete = false;
      continue;
    }
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // 🔴 fail-closed：**读不进去**（EACCES/EPERM）的子树里可能藏着一个真 target，
      // 静默跳过等于宣称「这里没有」，而我们并没有看过。
      // ⚠️ 但 ENOENT/ENOTDIR 是「本来就没有东西」——目录还没建、或扫描途中被删 ——
      // 那不是盲区，不能因此把每一次「target 尚不存在」的预检都判成扫不完。
      if (!isAbsent(err)) complete = false;
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue; // Dirent 的 isDirectory 对 symlink 返回 false
      if (e.name === STATE_DIR) continue;
      stack.push([join(dir, e.name), depth + 1]);
    }
  }
  return { complete, visited };
}

function hasSubdir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && e.name !== STATE_DIR);
  } catch (err) {
    // 🔴 读不了 → 无法证明下面没有目录，按「还有」算；不存在则确实没有
    return !isAbsent(err);
  }
}

/** 「这里本来就没东西」而不是「有东西但我看不了」。两者的 fail-closed 处置相反。 */
const isAbsent = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

function tryRealpath(p) {
  const abs = isAbsolute(p) ? p : resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// ── 状态路径的 symlink 检查（§3.4） ──────────────────────────────────────────

/**
 * 🔴 `.geoly` 及其下**全部**状态路径必须以 lstat 无跟随方式检查，遇 symlink 即拒绝。
 * §10 泛称的「拒绝路径链 symlink」只覆盖 target 本身，不足以覆盖状态目录 ——
 * 有人把 `<target>/.geoly/ledger.json` 换成软链指到别处，锁和账本就分家了。
 *
 * 检查**整棵 `.geoly`**（含 `quarantine/`、`repair-intent.json`），不是只查枚举的几条：
 * 枚举清单会随 schema 演进而过时，整棵扫不会。
 *
 * ⚠️ **这不是 no-follow 保证，只是一次观察**：`readdirSync` 的 Dirent 说某一项当时
 * 不是 symlink，但在我们递归进去之前它可以被换成 symlink，那次 `readdirSync(path)`
 * 就会跟过去。真正的 no-follow 要 `openat(dirfd, …, O_NOFOLLOW)`，Node 没有暴露。
 * 所以这里的结论只是「扫描当时看到的目录项里没有 symlink」——
 * 动作点仍然必须复验并 fail-closed（见文件顶部）。
 */
export function scanStatePaths(stateDir, scanOpts = {}) {
  const { maxDepth, maxDirs } = normalizeScan(scanOpts);
  const bad = [];
  let st;
  try {
    st = lstatSync(stateDir);
  } catch (err) {
    if (isAbsent(err)) return { symlinks: [], notPlain: [], complete: true }; // 还不存在，后面才创建
    return { symlinks: [], notPlain: [], complete: false }; // 🔴 看不了 ≠ 没问题
  }
  if (st.isSymbolicLink()) return { symlinks: [stateDir], notPlain: [], complete: true };
  if (!st.isDirectory()) return { symlinks: [], notPlain: [stateDir], complete: true };

  const symlinks = [];
  let visited = 0;
  let complete = true;
  const stack = [[stateDir, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (visited >= maxDirs) {
      complete = false;
      break;
    }
    visited += 1;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (!isAbsent(err)) complete = false; // 🔴 看不了就不能宣称这下面没有 symlink
      continue;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        symlinks.push(p);
        continue;
      }
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push([p, depth + 1]);
        else complete = false;
        continue;
      }
      if (!e.isFile()) bad.push(p); // FIFO / socket / 设备节点
    }
  }
  return { symlinks, notPlain: bad, complete };
}

// ── 挂载点（§3.4） ───────────────────────────────────────────────────────────

/**
 * 🔴 `<target>/.geoly` 自身不得是挂载点，其下也不得含挂载点（§3.4）。
 * 判据以挂载表为准，不只比 `st_dev` —— bind mount 的 `st_dev` 可以相同。
 *
 * 🔴 **只在 `.geoly` 已存在时判**。`assertNotMountPoint` 内部会往上找第一个存在的
 * 祖先来 realpath，`.geoly` 不存在时那个祖先就是 target 自己 ——
 * 于是「target 恰好是个挂载点」会被误报成「.geoly 是挂载点」。
 * 不存在的目录不可能是挂载点，跳过才是对的。
 */
export function checkGeolyMountPoints(stateDir, deps = DEFAULT_DEPS) {
  const out = [];
  try {
    lstatSync(stateDir);
  } catch (err) {
    // 🔴 只有「真不存在」才跳过。EACCES 是「有但看不了」——
    // 直接返回空数组等于宣称「不是挂载点」，那是 fail-open。
    if (isAbsent(err)) return out;
    out.push({
      code: V.STATE_SCAN_INCOMPLETE,
      path: stateDir,
      message: `${stateDir} 读不了（${err.code}），无法判定它是不是挂载点、其下有没有挂载点`,
    });
    return out;
  }
  try {
    deps.assertNotMountPoint(stateDir);
  } catch (err) {
    out.push({ code: V.GEOLY_IS_MOUNT, path: stateDir, message: err.message });
  }
  try {
    deps.assertNoMountPointsUnder(stateDir);
  } catch (err) {
    out.push({ code: V.GEOLY_MOUNT_UNDER, path: stateDir, message: err.message });
  }
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

/**
 * 底层判据的默认接线。**生产路径一律用默认值**；
 * `deps` 参数只是测试用的注入缝 —— 有些拒绝规则（NFS/sshfs 挂载、只读挂载、
 * bind mount）在 CI 里造不出来，不注入就没法断言「报出了哪一项违规」，
 * 而「只断言抛了错」正是这次要避免的。
 */
export const DEFAULT_DEPS = Object.freeze({
  assertSupportedFilesystem,
  assertNotMountPoint,
  assertNoMountPointsUnder,
  assertNoSymlinkInChain,
  assertPlainFileOrDir,
  assertWritableDir,
  /** target 用 `stat`（它可以是被 realpath 过的正常目录），`.geoly` 用 `lstat`（绝不跟随）。 */
  targetDev: (p) => statSync(p).dev,
  stateDev: (p) => lstatSync(p).dev,
});

/**
 * 对一个 target 做全部预检，**收集**违规项而不是抛出。
 *
 * @param {string} targetPath  绝对路径（可以尚不存在 —— `--create-missing` 会建它）
 * @param {object} opts
 * @param {string} opts.base          可信 base（symlink 链只查它之下；见 safe-fs 的说明）
 * @param {string[]} opts.targetSet   本次命令的**全部** target（含自己），用于 §3.5 收窄
 * @param {boolean} opts.requireWritable  §3.6，默认开
 * @returns {{ok:boolean, targetPath:string, checkedAt:string, violations:Array}}
 *
 * 🔴 返回 `ok: true` **不代表安装一定成功** —— 见文件顶部关于 TOCTOU 的说明。
 */
export function precheckTarget(targetPath, opts = {}) {
  const {
    base,
    targetSet = [],
    requireWritable = true,
    scan = {},
    refreshMounts = true,
  } = opts;
  const deps = opts[TEST_DEPS] ?? DEFAULT_DEPS;
  const bounds = normalizeScan(scan); // 🔴 先校验上限，非法值直接抛，不静默变无界
  if (!isAbsolute(targetPath)) throw new Error(`targetPath 必须是绝对路径：${targetPath}`);

  // 🔴 挂载表在 safe-fs 里是**进程级缓存**的。预检必须拿最新的一份 ——
  // 一个长跑的 CLI 用几分钟前的挂载快照去判「.geoly 是不是挂载点」，
  // 等于没判。（`precheckTargets` 会关掉后续几次的刷新，同一批共用一张表。）
  if (refreshMounts) _resetMountCache();

  const violations = [];
  const add = (code, path, message, extra) =>
    // 🔴 `detail` 也要冻结：只冻外层挡不住 `violations[i].detail.relation = 'forged'`，
    // 而 `detail` 正是给机器读的那部分，被改了下游就照着假信息做决定。
    violations.push({ code, path, message, ...(extra ? { detail: deepFreeze(extra) } : {}) });
  const capture = (code, path, fn) => {
    try {
      return fn();
    } catch (err) {
      add(code, path, err.message);
      return undefined;
    }
  };

  const stateDir = join(targetPath, STATE_DIR);
  const targetExists = existsSync2(targetPath);

  // ── §2.2 文件系统类型（报出实际 fstype）
  capture(V.UNSUPPORTED_FSTYPE, targetPath, () => deps.assertSupportedFilesystem(targetPath));

  // ── §3.4 路径链 symlink（从可信 base 往下）
  if (!base) {
    // 🔴 没有可信 base 就**做不了**这一条检查。静默跳过等于让调用方以为查过了 ——
    // 这是最容易被忽略的一种 fail-open：少传一个参数，一整条规则就没了。
    add(V.BASE_MISSING, targetPath, '未提供可信 base，无法检查路径链上的符号链接（§3.4）');
  } else {
    if (!isAbsolute(base)) {
      add(V.OUTSIDE_BASE, targetPath, `base 必须是绝对路径：${base}`);
    } else {
      const rel = relative(base, targetPath);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        add(
          V.OUTSIDE_BASE,
          targetPath,
          `target 不在可信 base ${base} 之下，无法只检查我们管辖范围内的 symlink`,
        );
      } else {
        // 🔴 base 不存在时 `assertNoSymlinkInChain` 会在 `realpathSync(base)` 上吃 ENOENT，
        // 把「目录还没建」误报成「路径链上有 symlink」。那条消息会把人带偏，
        // 而且会让 `--create-missing` 这条路彻底走不通。分成一条自己的违规码。
        // ⚠️ 只有 ENOENT/ENOTDIR 算「不存在」。EACCES 是「有但看不了」——
        // 那不是 base-missing，它得原样报出来，否则诊断会把人指向错误的方向。
        let baseErr = null;
        try {
          lstatSync(base);
        } catch (err) {
          baseErr = err;
        }
        if (baseErr && isAbsent(baseErr)) {
          add(V.BASE_MISSING, base, `可信 base ${base} 不存在，无法检查路径链上的符号链接`);
        } else if (baseErr) {
          add(V.SYMLINK_IN_CHAIN, base, `可信 base ${base} 读不了（${baseErr.code}），无法检查路径链上的符号链接`);
        } else {
          capture(V.SYMLINK_IN_CHAIN, targetPath, () => deps.assertNoSymlinkInChain(base, rel));
        }
      }
    }
  }

  // ── §3.4 target 本身的类型
  if (targetExists) {
    const st = capture(V.NOT_PLAIN_DIR, targetPath, () => deps.assertPlainFileOrDir(targetPath));
    if (st && !st.isDirectory()) add(V.NOT_PLAIN_DIR, targetPath, `${targetPath} 不是目录`);
  }

  // ── §3.4 `.geoly` 不得是挂载点、其下不得含挂载点
  // 🔴 只在 `.geoly` **已存在**时判：`assertNotMountPoint` 内部会往上找第一个存在的祖先，
  // `.geoly` 不存在时那个祖先就是 target 自己 —— 于是 target 是挂载点会被误报成
  // 「.geoly 是挂载点」。不存在的目录不可能是挂载点，直接跳过才是对的。
  const stateExists = existsSync2(stateDir);
  violations.push(...checkGeolyMountPoints(stateDir, deps));
  if (stateExists) {
    // 🔴 §5.2 第 3 步要求 target **与 state** 都过文件系统预检。
    // 只查 target 会漏掉「.geoly 被单独挂到一个 NFS 上」——
    // 那正是锁与 journal 失效的那种情形。
    capture(V.UNSUPPORTED_FSTYPE, stateDir, () => deps.assertSupportedFilesystem(stateDir));

    // ── §2.2 同设备：stage/retired/attic 都在 `.geoly` 里，与 target 必须同设备，
    // 否则 rename 会 EXDEV。（v8 布局下天然同设备 —— 除非有人在中间挂了东西，
    // 那正是上面两条要抓的情形；这条是纵深防御。）
    try {
      const dTarget = deps.targetDev(targetPath);
      const dState = deps.stateDev(stateDir);
      if (dTarget !== dState) {
        add(
          V.CROSS_DEVICE,
          stateDir,
          `${stateDir} 与 ${targetPath} 不在同一设备上（${dState} vs ${dTarget}），rename 会 EXDEV`,
        );
      }
    } catch (err) {
      // 🔴 fail-closed：读不到设备号就是**判不了**同设备与否。
      // 吞掉它意味着「其它检查恰好都过」时会给出一份 clean 结果，
      // 而 rename 到底会不会 EXDEV 我们并不知道。
      add(
        V.CROSS_DEVICE,
        stateDir,
        `读不到 ${targetPath} 或 ${stateDir} 的设备号（${err.code ?? err.message}），` +
          '无法判定 stage 与 target 是否同设备（不同设备时 rename 会 EXDEV）',
      );
    }
  }

  // ── §3.4 状态路径逐个 lstat 无跟随
  const stateScan = scanStatePaths(stateDir, bounds);
  for (const p of stateScan.symlinks) {
    add(V.STATE_SYMLINK, p, `状态路径是符号链接，拒绝（.geoly 之下一律不跟随）：${p}`);
  }
  for (const p of stateScan.notPlain) {
    add(V.STATE_NOT_PLAIN, p, `状态路径既不是普通文件也不是目录，拒绝：${p}`);
  }
  if (!stateScan.complete) {
    add(
      V.STATE_SCAN_INCOMPLETE,
      stateDir,
      `${stateDir} 没扫完（深度上限/目录数上限，或某个子目录读不进去），` +
        '无法证明状态路径里没有符号链接',
    );
  }

  // ── §3.5 嵌套 target
  const { nested, complete } = findNestedTargets(targetPath, { targetSet, scan: bounds });
  for (const n of nested) {
    add(
      V.NESTED_TARGET,
      n.path,
      n.relation === 'ancestor'
        ? `${targetPath} 位于另一个 target ${n.path} 之内（识别依据：${n.via}），拒绝嵌套 target`
        : `${targetPath} 之内还有另一个 target ${n.path}（识别依据：${n.via}），拒绝嵌套 target`,
      { relation: n.relation, via: n.via },
    );
  }
  if (!complete) {
    add(
      V.SCAN_INCOMPLETE,
      targetPath,
      `嵌套 target 扫描未跑完（深度上限 ${bounds.maxDepth} / ` +
        `目录数上限 ${bounds.maxDirs}），无法证明其下没有嵌套 target`,
    );
  }

  // ── §3.6 只读 target
  if (requireWritable) {
    const probe = targetExists ? targetPath : nearestExistingAncestor(targetPath);
    if (probe) {
      try {
        deps.assertWritableDir(probe);
      } catch (err) {
        // 🔴 §3.6 要求报明「安装需要在 **`<target>`** 内创建 `.geoly/`」——
        // 重点是那个**具体路径**。`assertWritableDir` 只说「在其中」，
        // 而且它的只读挂载分支连这句都没有。所以一律自己补，不看它写了什么。
        add(
          V.NOT_WRITABLE,
          probe,
          `${err.message}；安装需要在 ${targetPath} 内创建 .geoly/ 状态目录` +
            (probe === targetPath ? '' : `（先要能写 ${probe}）`),
        );
      }
    }
  }

  const clean = deps === DEFAULT_DEPS;
  const result = Object.freeze({
    ok: violations.length === 0,
    targetPath,
    stateDir,
    base: base ?? null,
    checkedAt: new Date().toISOString(),
    // 🔴 提醒调用方：这是快照，不是保证。见文件顶部。
    snapshotOnly: true,
    // 供**人**阅读与断言。放行判据不是它（见 CLEAN_PRECHECKS）——
    // 一个公开的布尔字段随手就能被改回 false。
    depsOverridden: !clean,
    violations: Object.freeze(violations.map((v) => Object.freeze(v))),
  });
  if (clean) CLEAN_PRECHECKS.add(result);
  return result;
}

/** 把预检结果变成一条错误。🔴 报**全部**违规项，不是第一条。 */
export function assertPrecheckOk(result) {
  // 🔴 判据是模块私有的 WeakSet，不是结果里的字段：
  // 注入过 deps 的结果不在里面，被篡改过（重建）的对象也不在里面。
  // 一个被换成 no-op 的 deps 能让预检全绿而什么都没查过，所以这道边界不能可伪造。
  if (!CLEAN_PRECHECKS.has(result)) {
    throw new Error(
      '这份预检结果不是本模块用真实判据算出来的（注入了 TEST_DEPS，或对象被替换/篡改过），' +
        '不得用来放行安装',
    );
  }
  if (result.ok) return result;
  const lines = result.violations.map((v, i) => `  ${i + 1}. [${v.code}] ${v.message}`);
  const err = new Error(
    `target 预检不通过（${result.violations.length} 项）：${result.targetPath}\n${lines.join('\n')}`,
  );
  // 机器可读：调用方不必去 regex 解析错误文本
  err.violations = result.violations;
  err.targetPath = result.targetPath;
  throw err;
}

/**
 * 一次预检多个 target。
 * 🔴 `targetSet` 自动串起来，这样 §3.5 的第 ① 类（本次命令目标集合内的嵌套）
 * 才判得出来 —— 单独一个个预检是判不到的。
 */
export function precheckTargets(targetPaths, optsFor = () => ({})) {
  const set = targetPaths.slice();
  _resetMountCache(); // 整批共用同一张挂载表快照
  // 🔴 强制项放在展开**之后**：`optsFor` 覆盖掉 `targetSet` 就等于关掉了
  // §3.5 第 ① 类的判定，覆盖掉 `refreshMounts` 会让整批用不同的挂载快照。
  return targetPaths.map((t) =>
    precheckTarget(t, { ...optsFor(t), targetSet: set, refreshMounts: false }),
  );
}

function nearestExistingAncestor(p) {
  let cur = parse(p).dir;
  for (;;) {
    if (existsSync2(cur)) return cur;
    const up = parse(cur).dir;
    if (!up || up === cur) return null;
    cur = up;
  }
}

/** `existsSync` 会跟随 symlink；这里要的是「这个路径名存在与否」，用 lstat。 */
function existsSync2(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ── 项目级 .gitignore（§3.3 / Q12） ─────────────────────────────────────────

/**
 * 项目级安装必须让 git 忽略 🔴 **adapter 派生的实际路径**
 * （`/.claude/skills/.geoly/`、`/.cursor/skills/.geoly/` …），
 * **不是**根上的 `/.geoly/` —— M0 §3.3 注明 v8 在这里写错过。
 *
 * 只读：报缺哪几条，不写文件。写 `.gitignore` 是安装流程的动作，
 * 由调用方在拿到用户同意后落盘。
 */
export function missingGitignorePatterns(projectRoot, clients = CLIENTS) {
  const want = [...new Set(gitignorePatternsFor(clients))]; // 去重，顺序稳定
  let text = '';
  try {
    text = readFileSync(join(projectRoot, '.gitignore'), 'utf8');
  } catch {
    return want;
  }
  // 只看 `<projectRoot>/.gitignore`。父级 gitignore、`.git/info/exclude`、
  // 全局 core.excludesFile 都可能也覆盖，但那些**不随仓库走** ——
  // 换个 clone 就没了，而 `.geoly/` 被提交一次就再也收不回。
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const covered = new Set();
  for (const raw of lines) {
    const neg = raw.startsWith('!');
    const p = (neg ? raw.slice(1) : raw).replace(/\/$/, '');
    // 🔴 后面的否定规则会把前面的忽略取消掉，git 的语义是**最后一条匹配的赢**
    if (neg) covered.delete(p);
    else covered.add(p);
  }
  // 只认逐字相同的那一条。不做 glob 语义推导 —— 「看起来能覆盖」不等于覆盖，
  // 猜错的代价是把 `.geoly/`（含本地审计历史）提交进 git。
  return want.filter((p) => !covered.has(p.replace(/\/$/, '')));
}

/** 渲染一段可直接粘进 `.gitignore` 的块，附 `git clean -xfd` 警告。 */
export function renderGitignoreBlock(clients = CLIENTS) {
  const pats = gitignorePatternsFor(clients);
  return [
    '# geoly skills-hub —— per-target 状态目录（04-install.md §3.3）',
    '# 忽略的是 adapter 派生的实际路径，不是根上的 /.geoly/',
    ...pats,
    '',
  ].join('\n');
}

export function gitignoreHint(projectRoot, clients = CLIENTS) {
  const missing = missingGitignorePatterns(projectRoot, clients);
  return {
    missing,
    ok: missing.length === 0,
    warning: GIT_CLEAN_WARNING,
    block: renderGitignoreBlock(clients),
  };
}
