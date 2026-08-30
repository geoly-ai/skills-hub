// pack / vendor 库层错误 → 09-cli.md §6 的退出码。
//
// 🔴 **为什么需要这一层。** `pack.mjs` 抛的是 `WireError`（内核里写死 `code = 1`），
//    `packer.mjs` / `vendor.mjs` 抛的是 `PackError`（`code` 是 `E_…` 字符串、
//    **没有** `exitCode`）。两者进 `classify()` 的下场分别是：
//      · WireError → 一律 1（解析失败）；
//      · PackError → 认不出来 → `UNCLASSIFIED`（2）且 `unclassified: true`，
//        于是人类输出会以「内部错误（CLI 自身的 bug，不是制品有问题）」开头。
//    可是 `--layout xyz` 是**用法错误**、成员摘要不符是**完整性事件**、
//    `degraded` 是**冲突**、上一次 vendor 没收尾是**需要 recover** ——
//    四件事被压进两个格子，脚本按退出码分不出来，人类看到的还是错的归因。
//
// 🔴 做法与 `commands/install.mjs` 把内核 `Corrupt` 包成 `ConflictError` 同源：
//    **在命令面把库层的错标注上退出码**，而不是在 `exit-codes.mjs` 里对文案做正则
//    （那正是本仓库反复在消灭的形状），也不是让库层去 import 命令面的错误类
//    （会绕成环：命令面 → 库 → 退出码 → 库）。
//
// 🔴 **只标注，不重新包装。** 包装成 `ConflictError` 会把 `err.name`（`PackError`）
//    与 `err.code`（`E_PACK_MEMBER_DIGEST`）这两个**机器可读**的字段丢掉，
//    而 `--json` 的 `error.name` 正是脚本用来分辨具体哪一条的依据。
//    这里只往对象上加 `exitCode` / `telemetryReason`，`classify()` 的第 ① 档就会认它。

import { EXIT } from '../exit-codes.mjs';

/**
 * `E_…` → `[退出码, 埋点 reason]`。
 *
 * 🔴 `reason` 必须来自 `telemetry.REASONS` 的有限代码表；挑不出就用 `'unknown'`
 *    （它也在表里），**绝不**把错误文案塞进 reason。
 */
export const PACK_ERROR_EXIT = Object.freeze({
  // 🔴 `__proto__: null`：否则 `PACK_ERROR_EXIT['constructor']` 会命中 Object.prototype
  //    并返回一个真值。与 `telemetry.mjs` 的 FIELDS 表同一条理由。
  __proto__: null,

  // ── 冲突未解决（3）────────────────────────────────────────────────────────
  // degraded / yanked 都是「这个东西现在不该装」，用户的出路是换版本或按成员逐个装，
  // 不是改命令行 —— 那正是 §6 第 3 条的语义。报 1 会让脚本以为是自己拼错了。
  E_PACK_DEGRADED: [EXIT.CONFLICT, 'version-conflict'],
  E_PACK_YANKED: [EXIT.CONFLICT, 'yanked'],
  E_PACK_MEMBER_YANKED: [EXIT.CONFLICT, 'yanked'],
  E_PACK_MEMBER_DEGRADED: [EXIT.CONFLICT, 'version-conflict'],
  // 🔴 成员不在快照里 —— 归 3，**不是 2**。
  //    Codex 2026-08-30 建议归 2（「pack.json 锁定的东西与快照对不上，与 MEMBER_DIGEST 同类」）。
  //    不采纳，两条理由：
  //    ① §6 第 2 条列举的是**验签失败 / 摘要不符 / 算法不认识 / 资产 sha256 不符 /
  //       签名身份不对** —— 成员缺席一样都不占，没有任何东西「校验失败」了；
  //    ② 更要紧的是**库层已经定了性**：`pack.computePackStatus()` 明写「成员缺失
  //       （不在快照里）**按 degraded 记**」。degraded 在本表里是 3；把缺席判成 2
  //       会让同一条规则的两半落在两个退出码上 —— 那正是本仓库反复在消灭的分叉。
  //    要改就两处一起改，别只动这一张表。
  E_PACK_MEMBER_MISSING: [EXIT.CONFLICT, 'version-conflict'],
  // 与 `install.mjs` 对「未声明支持该 client」的处理保持一致（那里抛的就是 ConflictError）
  E_CLIENT_UNSUPPORTED: [EXIT.CONFLICT, 'unsupported-client'],

  // ── 完整性失败（2）──────────────────────────────────────────────────────
  // 🔴 这四条都是「pack.json 锁定的东西与实际交付的字节对不上」，
  //    03-packs.md §2 明说「两处不一致 → 终止并**报告为完整性事件**」。
  E_PACK_MEMBER_DIGEST: [EXIT.INTEGRITY, 'digest-mismatch'],
  E_VENDOR_MEMBER_DIGEST: [EXIT.INTEGRITY, 'digest-mismatch'],
  E_VENDOR_MEMBER_MISSING: [EXIT.INTEGRITY, 'digest-mismatch'],
  E_VENDOR_MEMBER_EXTRA: [EXIT.INTEGRITY, 'digest-mismatch'],

  // ── 需要 recover（5）────────────────────────────────────────────────────
  // 上一次 vendor 没收尾 / 意图文件坏了 / 状态收敛不了 —— 都要先把残留处理掉。
  // §6 第 5 条「残留事务需 recover」正是这一格。
  E_VENDOR_INTENT_PENDING: [EXIT.NEEDS_RECOVER, 'unknown'],
  E_VENDOR_INTENT: [EXIT.NEEDS_RECOVER, 'unknown'],
  E_VENDOR_RECOVER: [EXIT.NEEDS_RECOVER, 'unknown'],

  // ── 平台 / 文件系统不受支持（9）────────────────────────────────────────
  // 与 `target.mjs` 的 `fs.cross-device` / `target.not-plain-dir` 同格。
  E_VENDOR_XDEV: [EXIT.UNSUPPORTED, 'unknown'],
  E_VENDOR_TARGET: [EXIT.UNSUPPORTED, 'unknown'],

  // ── 用法 / 解析（1）────────────────────────────────────────────────────
  E_VENDOR_INPUT: [EXIT.USAGE, 'unknown'],
  // 🔴 目录撞名（两个成员物化到同一个目录、或 pack 载荷压到成员目录上）归 **1**。
  //    第一版归 3（「它字面上就是个 conflict」），Codex 2026-08-30 指出这会误导自动化：
  //    §6 的 3 在别处都意味着「点名 --replace 就能过」，而这一条**用户无解**，
  //    命令行怎么改都不行，只能等 pack 作者修。
  //    归 1 的正当性不是「凑一个格子」：§6 第 1 条含 **解析失败**，而这就是
  //    「这份 pack 的内容不合法」—— 与 `validatePackManifest()` 的 WireError
  //    （同样落 1）是同一类，只是发现得晚一点。同类同码，才不会分叉。
  E_VENDOR_DIR_COLLIDE: [EXIT.USAGE, 'unknown'],
  E_VENDOR_LAYOUT: [EXIT.USAGE, 'unknown'],
  // flat 布局对嵌套 pack 没有定义（vendor.mjs 拒绝，不给「合理默认」）
  E_VENDOR_NESTED_PACK: [EXIT.USAGE, 'unknown'],
});

/**
 * 给库层的错标注退出码。默认**原地改、返回同一个对象**（保住 `name` / `code` / `cause`）；
 * 对象冻结/不可扩展时退回「复制一份带上码」，见下面的注释。
 *
 * 🔴 认不出来的 `E_…` **不给默认值**：留着不动，`classify()` 会按 fail-closed
 *    落到 2 且 `unclassified: true`。给个「合理默认」等于让下一个新增的错误码
 *    悄悄穿上一件不属于它的退出码 —— 而那种错是不会有人来报的。
 *
 * @param {unknown} err
 * @returns {unknown} 同一个 err（冻结时是等价的复制品）
 */
export function annotatePackError(err) {
  if (err === null || typeof err !== 'object') return err;
  // 已经有整数 exitCode 的（我们自己的 CliError）不碰
  if (Number.isInteger(err.exitCode)) return err;
  // `PackError.code` 与 `WireError.violation` 是同一个命名空间的两种载体
  const code = typeof err.code === 'string' ? err.code : err.violation;
  if (typeof code !== 'string') return err;
  if (!Object.hasOwn(PACK_ERROR_EXIT, code)) return err;
  const hit = PACK_ERROR_EXIT[code];
  // 🔴 ESM 是 strict mode：往**冻结/不可扩展**的错误对象上写属性会抛 `TypeError`，
  //    于是原始的 `PackError` 被一个毫不相干的 TypeError 顶掉 —— 调用方看到的是
  //    「内部错误」，真正的原因（比如成员摘要不符）连文案都没了。
  //    **补偿动作比不补偿更糟**，所以这里不硬写：写不进去就原样复制一份带上码，
  //    `name` / `code` / `message` / `cause` 全部保留（`--json` 的 error.name
  //    与 error.message 正是脚本用来分辨具体哪一条的依据）。
  //    ⚠️ 现实里没人冻结 Error，这条是**防御**不是修 bug；但它的失败模式是
  //    「把真错误吃掉」，代价不对称，所以值得这三行。
  if (Object.isExtensible(err) && !Object.isFrozen(err)) {
    try {
      err.exitCode = hit[0];
      err.telemetryReason = hit[1];
      return err;
    } catch { /* 落到下面的复制路径 */ }
  }
  const copy = new Error(err.message, err.cause === undefined ? undefined : { cause: err.cause });
  copy.name = err.name;
  copy.code = code;
  copy.exitCode = hit[0];
  copy.telemetryReason = hit[1];
  return copy;
}

/** `fn()` 抛出的库层错在离开命令之前统一标注一次。 */
export function withPackErrors(fn) {
  try {
    return fn();
  } catch (err) {
    throw annotatePackError(err);
  }
}
