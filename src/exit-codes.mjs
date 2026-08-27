// 退出码 —— 规格见 09-cli.md §6。
//
// 🔴 本模块**不 import 任何内核模块**。
//    理由：它要给 `recover.mjs` / `trust.mjs` / `lock.mjs` / `journal.mjs` 抛出来的错分类，
//    真去 import 它们会立刻绕成环（命令面 → 内核 → 退出码 → 内核）。
//    因此分类**只按错误对象自身可观测的属性**：`exitCode` → `name` → 鸭子类型字段。
//
// 🔴 分类是**白名单式**的：认不出来的错**不给 0**（见下面 `UNCLASSIFIED` 的说明），
//    绝不静默变成成功。

/** 09-cli.md §6 的那张表，一个不多一个不少。 */
export const EXIT = Object.freeze({
  /** 全部成功（`skipped: 目录不存在` / `skipped: unsupported` 算成功） */
  OK: 0,
  /** 用法错误 / 解析失败 / 候选歧义 */
  USAGE: 1,
  /** 完整性失败：验签失败、摘要不符、算法不认识、资产 sha256 不符、签名身份不对 */
  INTEGRITY: 2,
  /** 冲突未解决 */
  CONFLICT: 3,
  /** 部分 target 失败 */
  PARTIAL: 4,
  /** 残留事务需 recover；或锁被占用 */
  NEEDS_RECOVER: 5,
  /** 网络 / 缓存未命中 */
  NETWORK: 6,
  /** 需要认证或权限不足 */
  AUTH: 7,
  /** 陈旧：timestamp 过期且未给 --allow-stale */
  STALE: 8,
  /** 平台 / 文件系统不受支持；或 .geoly 是挂载点、检出嵌套 target */
  UNSUPPORTED: 9,
  /** target 不可写（无法创建 <target>/.geoly/） */
  NOT_WRITABLE: 10,
  /** CLI 版本低于 timestamp 的 min_cli_version */
  MIN_CLI: 11,
});

/**
 * 🔴 §6 **没有**为「CLI 自身出了 bug」开一格，而我们也不发明第 12 个码。
 *
 * 认不出来的错必须有一个去处，且那个去处**绝不能是 0**。这里落到 2，
 * 并且**只在退出码这一层**与「制品有问题」同格 —— 两者的区分放在别处：
 *   · 人类输出以「内部错误（CLI 自身的 bug，不是制品有问题）：」开头；
 *   · `--json` 的 `error.unclassified` 为 `true`。
 *
 * ⚠️ **诚实边界**：只看退出码是分不出这两者的。要分就得读 JSON 或文案。
 */
export const UNCLASSIFIED = EXIT.INTEGRITY;

// ── 命令面自己的错误类型 ────────────────────────────────────────────────────
//
// 🔴 每一个都带 `exitCode`，这样 `classify()` 的第一档就能定死，
//    不必靠 `instanceof`（跨 ESM 实例的 instanceof 不可靠）也不必靠文案匹配。

class CliError extends Error {
  constructor(message, exitCode, extra = {}) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    Object.assign(this, extra);
  }
}

/** 用法错误：未知 flag、缺参数、被明令删除的开关（--no-verify 等）。 */
export class UsageError extends CliError {
  constructor(message, extra) { super(message, EXIT.USAGE, extra); }
}

/** §5 解析规则：多 namespace 同名、skill 与 pack 同名 —— **报错列候选，不猜**。 */
export class AmbiguousError extends CliError {
  constructor(message, candidates) {
    super(message, EXIT.USAGE, { candidates: Object.freeze([...candidates]) });
  }
}

/** 冲突未解决：未认领同名目录未给 --replace、§8.2 遮蔽未给 --shadow-global。 */
export class ConflictError extends CliError {
  constructor(message, extra) { super(message, EXIT.CONFLICT, extra); }
}

/**
 * 部分 target 失败。🔴 只在「至少一个成功、至少一个失败」时用 ——
 * 全失败不是「部分失败」，那应当照最严重的那条单项错误报。
 */
export class PartialFailure extends CliError {
  constructor(message, results) { super(message, EXIT.PARTIAL, { results }); }
}

/** 网络 / 缓存未命中（含 `--offline` 下缓存没命中）。 */
export class NetworkError extends CliError {
  constructor(message, extra) { super(message, EXIT.NETWORK, extra); }
}

/** 需要认证或权限不足。 */
export class AuthError extends CliError {
  constructor(message, extra) { super(message, EXIT.AUTH, extra); }
}

/** 平台 / 文件系统不受支持（win32 非 WSL、拒绝的 fstype、挂载点、嵌套 target）。 */
export class UnsupportedError extends CliError {
  constructor(message, extra) { super(message, EXIT.UNSUPPORTED, extra); }
}

// ── 预检违规码 → 退出码 ─────────────────────────────────────────────────────
//
// 键取自 `target.mjs` 的 `V`。🔴 这里**写死字符串而不是 import V**：
// 本模块不 import 内核（见文件头）。两边漂了会被 `test/cli-exit-codes.test.mjs`
// 的「V 的每一个取值都在这张表里」那条断言抓住。

const VIOLATION_EXIT = Object.freeze({
  'fs.unsupported-fstype': EXIT.UNSUPPORTED,        // §2.2
  'fs.cross-device': EXIT.UNSUPPORTED,              // §2.2
  'geoly.is-mount-point': EXIT.UNSUPPORTED,         // §3.4 → §6 第 9 条点名
  'geoly.mount-point-under': EXIT.UNSUPPORTED,      // §3.4
  'target.nested': EXIT.UNSUPPORTED,                // §3.5 → §6 第 9 条点名
  'target.symlink-in-chain': EXIT.UNSUPPORTED,      // §3.4
  'target.not-plain-dir': EXIT.UNSUPPORTED,         // §3.4
  'geoly.symlink-state-path': EXIT.UNSUPPORTED,     // §3.4
  'geoly.not-plain': EXIT.UNSUPPORTED,              // §3.4
  // 🔴 「扫不完就不能宣称没有」——它是 fail-closed 的拒绝，不是「不支持」，
  //    但 §6 里没有第二个能装它的格子。归 9 并在文案里说清是扫描超预算。
  'target.nested-scan-incomplete': EXIT.UNSUPPORTED,
  'geoly.state-scan-incomplete': EXIT.UNSUPPORTED,
  'target.not-writable': EXIT.NOT_WRITABLE,         // §3.6 → §6 第 10 条点名
  // 🔴 可信 base 缺失是**我们自己**没把 adapter 的 base 传进去 —— 用户改不了它。
  //    报 9（「不支持」）会把用户送去查文件系统。归 1（用法/内部）并点名。
  'target.base-missing': EXIT.USAGE,
  'target.outside-base': EXIT.USAGE,
});

/**
 * 🔴 一次预检会报**全部**违规项，可能同时命中不同档。取哪一个？
 *
 * 取**最根本的死路**，不是「第一条」也不是「码最大的那条」：
 * `.geoly` 在 NFS 上（9）与「目录不可写」（10）同时命中时，报 10 会让用户去 `chmod`，
 * 而 chmod 完照样装不上 —— fstype 是他改不掉的那一条。
 *
 * 顺序即优先级；表里没有的码排在最后。
 */
const VIOLATION_PRIORITY = Object.freeze([
  'fs.unsupported-fstype',
  'fs.cross-device',
  'geoly.is-mount-point',
  'geoly.mount-point-under',
  'target.nested',
  'target.symlink-in-chain',
  'geoly.symlink-state-path',
  'target.not-plain-dir',
  'geoly.not-plain',
  'target.nested-scan-incomplete',
  'geoly.state-scan-incomplete',
  'target.base-missing',
  'target.outside-base',
  'target.not-writable',
]);

/** 一组预检违规 → 一个退出码。空数组返回 `null`（调用方自己决定）。 */
export function exitForViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return null;
  const codes = new Set(violations.map((v) => v?.code));
  for (const c of VIOLATION_PRIORITY) if (codes.has(c)) return VIOLATION_EXIT[c];
  // 认不出来的违规码：fail-closed 到 9，并让 classify 的调用方看得见 unclassified
  return EXIT.UNSUPPORTED;
}

export { VIOLATION_EXIT, VIOLATION_PRIORITY };

// ── 分类 ────────────────────────────────────────────────────────────────────

/**
 * 内核错误的 `name` → 退出码。
 *
 * 🔴 `Corrupt` 落 **5**，不落 2 —— 判据不是我们的猜测，是**内核自己写死的**：
 *    `journal.mjs` 的 `Corrupt` 构造器里就是 `this.code = 5`，
 *    而 11-wire-contract.md §5 对 journal CRC 失败要求「停机，报告为需要人工介入」。
 *    §6 第 2 条（完整性失败）说的是验签 / 摘要 / 资产 sha256 / 签名身份 ——
 *    那些来自 `trust.mjs` 与 `untar.mjs`，不来自 `Corrupt`。
 *
 * 🔴 但 `Corrupt` 被 journal / ledger / plan / lockfile **共用**，
 *    单凭错误类分不出来源。因此凡是「这里抛的 Corrupt 其实是另一档」的地方，
 *    都在**调用点**显式包装成 `ConflictError` / integrity 错，
 *    **绝不**靠对错误文案做正则。已经这么做的两处：
 *      · `commands/install.mjs`：未认领同名目录 → `ConflictError`（3）；
 *      · lockfile 的结构 / 闭包校验 → 由调用点包成完整性失败（2）。
 */
const BY_NAME = Object.freeze({
  // trust.mjs
  // 🔴 `WireError` 落 **1**，不落 2 —— 内核构造器里写死的就是 `this.code = 1`
  //    并注明「解析失败」，而 §6 第 1 条正是「用法错误 / **解析失败** / 候选歧义」。
  //    §6 第 2 条列举的是验签失败 / 摘要不符 / 算法不认识 / 资产 sha256 不符 /
  //    签名身份不对 —— 那些是 `IntegrityError` 与 `TarViolation`。
  WireError: EXIT.USAGE,
  IntegrityError: EXIT.INTEGRITY,
  StaleError: EXIT.STALE,
  MinCliVersionError: EXIT.MIN_CLI,
  // untar.mjs / artifact.mjs
  TarViolation: EXIT.INTEGRITY,
  // journal.mjs（ledger / plan / lockfile / install / recover 共用）
  Corrupt: EXIT.NEEDS_RECOVER,
  // lock.mjs
  LockBusyError: EXIT.NEEDS_RECOVER,
  // recover.mjs
  NeedsRecover: EXIT.NEEDS_RECOVER,
});

/**
 * 把任意异常映射成退出码。
 *
 * @param {unknown} err
 * @param {object} [o]
 * @param {number} [o.preferCode]
 *        调用方已经知道这个错该落哪一档时给它（例如 recover 的分流拒绝 → 5）。
 *        🔴 只在**认得出**这个错的前提下用；它压不过 `err.exitCode`。
 * @returns {{code:number, unclassified:boolean, reason:string}}
 *        `reason` 是给埋点用的 `REASONS` 代码，`null` 表示没有合适的代码。
 */
export function classify(err, o = {}) {
  // ① 我们自己抛的：码写在对象上，最权威
  if (err && Number.isInteger(err.exitCode)) {
    return { code: err.exitCode, unclassified: false, reason: reasonFor(err, err.exitCode) };
  }
  // ② 预检聚合错：带 violations 数组
  if (err && Array.isArray(err.violations) && err.violations.length) {
    const code = exitForViolations(err.violations);
    return { code, unclassified: false, reason: reasonFor(err, code) };
  }
  // ③ 内核错误按 name
  const named = err && BY_NAME[err.name];
  if (named !== undefined) {
    const code = o.preferCode !== undefined && named === EXIT.INTEGRITY ? o.preferCode : named;
    return { code, unclassified: false, reason: reasonFor(err, code) };
  }
  // ④ lock.mjs 的 LockBusyError 万一被跨实例包装过：它带 code === 5 与 holder
  if (err && err.code === 5 && Object.hasOwn(err, 'holder')) {
    return { code: EXIT.NEEDS_RECOVER, unclassified: false, reason: 'lock-busy' };
  }
  // ⑤ 认不出来 —— 绝不给 0
  return { code: UNCLASSIFIED, unclassified: true, reason: 'unknown' };
}

/**
 * 埋点的 `reason`：🔴 必须来自 `telemetry.REASONS` 那张**有限代码表**。
 * 这里只挑得出代码，挑不出就返回 `'unknown'`（它也在表里）——
 * **绝不**把错误文案塞进 reason（那正是 REASONS 存在的理由）。
 */
function reasonFor(err, code) {
  const name = err?.name;
  if (name === 'LockBusyError') return 'lock-busy';
  if (name === 'StaleError') return 'unknown';          // REASONS 里没有 stale 这一条
  if (name === 'MinCliVersionError') return 'unknown';  // 同上
  if (name === 'NeedsRecover') return 'journal-corrupt';
  if (name === 'TarViolation') return 'digest-mismatch';
  if (err?.telemetryReason) return err.telemetryReason;  // 调用方点名的代码（自己保证在表里）
  switch (code) {
    case EXIT.INTEGRITY: return 'digest-mismatch';
    case EXIT.NETWORK: return 'network-error';
    case EXIT.AUTH: return 'unknown';
    case EXIT.NOT_WRITABLE: return 'target-not-writable';
    case EXIT.UNSUPPORTED: return 'unsupported-client';
    case EXIT.CONFLICT: return 'version-conflict';
    case EXIT.USAGE: return 'unknown';
    default: return 'unknown';
  }
}
