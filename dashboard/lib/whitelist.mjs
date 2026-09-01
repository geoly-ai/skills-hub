/*
 * 采集面白名单 —— dashboard 这一侧的**唯一**定义处。
 *
 * 🔴 这张表是 docs/telemetry/00-spec.md §2 的抄件，它是**硬边界**：
 *    页面上能出现的每一个指标，都必须能追回到这里的某一个字段。
 *    没有用户名、没有路径、没有项目名、没有地理位置、没有 referrer ——
 *    这些字段**根本没有被采集**，所以任何展示它们的想法都不是「加个维度」，
 *    而是「先去改采集面」。
 *
 * ⚠️ 为什么要抄一份，而不是 `import { FIELD_NAMES } from '../../src/telemetry.mjs'`：
 *    dashboard 是**独立的 Vercel 项目**（Root Directory = dashboard/），
 *    构建机上不保证仓库根的 `src/` 在场。跨项目根 import 会让部署在某天悄悄挂掉。
 *    代价是「两份表会漂移」—— 那一条由 `test/whitelist-drift.test.mjs` 挡住：
 *    它在仓库里跑，能同时 import 两边，断言两张表逐字相等。
 *    **加字段时先改 src/telemetry.mjs，再改这里，测试会告诉你漏了哪边。**
 */

/** §2 表格里穷举的全部事件字段。顺序与规格表一致，方便逐行对读。 */
export const EVENT_FIELDS = Object.freeze([
  'schema', 'eid', 'at', 'install_id', 'cli', 'os', 'arch', 'node',
  'kind', 'result', 'artifact', 'version', 'client', 'scope', 'ms', 'reason',
]);

/**
 * 🔴 **可以出现在界面上的字段**（EVENT_FIELDS 减去三个）：
 *
 *   · `schema` —— 常量，对读者零信息量
 *   · `eid`    —— 事件唯一 ID。它把「同一条事件」钉死，是再识别的抓手
 *   · `install_id` —— 🔴 **本平台最要紧的一条**，见下面的长注释
 */
export const DISPLAYABLE_FIELDS = Object.freeze(
  EVENT_FIELDS.filter((f) => f !== 'schema' && f !== 'eid' && f !== 'install_id'),
);

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴🔴 为什么这个平台永远不提供「按 install_id 下钻」—— 给下一个来加功能的人
 *
 * `install_id` 是本机随机 UUIDv4，与账号、机器名、用户名、MAC 都没有映射
 * （规格 §3）。**单看它确实不指向人。**
 *
 * 但一个**能按 install_id 把时间线拉出来的界面，本身就是再识别工具**：
 * 把某一个 install_id 的事件按 `at` 排开，你得到的是
 * 「这台机器在哪天装了什么、什么时候卸的、跑的是哪个 OS/arch/Node/CLI 版本」
 * 的完整轨迹。规格 §6 的 **T-11** 说的正是这件事：
 * 源 IP + 稳定 install_id + 时间线 = 机器级追踪。
 * 端点侧已经用「不记 IP、不记 UA」把 IP 那一半掐掉了；
 * **时间线那一半是由这个平台决定的**，掐不掐在我们手里。
 *
 * 所以本平台的做法是**结构性**的，不是靠自觉：
 *   ① install_id 只在服务端用于「去重计数」，聚合值以外的形态一律不出现在 viewmodel 里；
 *   ② `stripIdentifiers()` 在归一化时**递归**丢弃任何 install_id / eid 形态的键，
 *      服务端将来就算回了，也到不了页面；
 *   ③ 小样本抑制（suppress.mjs）挡住「某维度组合下只有 1 台机器」这种
 *      「聚合值本身就是识别信息」的形态。
 *
 * ⚠️ **想加下钻之前，先去改规格。** 这不是一个 UI 取舍，是 T-11 的缓解措施本身。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * 识别符形态的键名 —— 递归丢弃用。
 *
 * 🔴 **匹配的是形态，不是那两个确切的字面量。** 规格 §2.2 收紧 `reason` 时吃过一次亏：
 *    「扫坏东西」的黑名单永远漏。这里同样不指望穷举，所以把大小写、连字符、
 *    驼峰、`by...` 前缀一并归一后再比：`installId` / `by_install_id` / `byInstallIds`
 *    / `INSTALL-ID` / `eids` 全部命中。
 */
const IDENTIFIER_STEMS = Object.freeze(['installid', 'eid', 'uuid', 'machineid', 'deviceid', 'clientid', 'userid']);

/** 键名归一：去掉大小写、下划线、连字符、`by` 前缀、复数 `s`。 */
function stemOf(key) {
  let s = String(key).toLowerCase().replace(/[^a-z]/g, '');
  if (s.startsWith('by')) s = s.slice(2);
  if (s.endsWith('s')) s = s.slice(0, -1);
  return s;
}

/** 这个键名是不是识别符形态？ */
export function isIdentifierKey(key) {
  const s = stemOf(key);
  return IDENTIFIER_STEMS.includes(s);
}

/**
 * 递归剥掉识别符形态的键。
 *
 * ⚠️ 这是**第二道**，不是唯一一道：normalize.mjs 用逐字段显式构造（不 spread），
 *    本函数只是给「服务端形状变了、我们还没跟上」那一段时间兜底。
 *    两道都在，是因为第一道靠的是「写代码的人记得不要 spread」。
 */
export function stripIdentifiers(value, depth = 0) {
  // 深度闸：服务端返回的是不可信输入，环状/超深结构不该让页面栈溢出
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((v) => stripIdentifiers(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  // 🔴 Object.create(null)：键来自网络，往带原型的对象上赋 `__proto__` 会**改原型**
  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) {
    if (isIdentifierKey(k)) continue;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = stripIdentifiers(v, depth + 1);
  }
  return out;
}

/*
 * 取值校验器。
 *
 * 🔴 **为什么读出面也要校验取值**：摄入面按规格 §5.3 是**无鉴权**的 ——
 *    任何人都能往端点里灌事件（T-6 明示接受）。服务端确实会跑
 *    `assertValidEvent()`，但那是「服务端在我们手里」这个前提下的保证，
 *    而 dashboard 的前提是「服务端的形状会变、而且正在被另一个人改」。
 *    校验在这里再跑一遍，代价是几个正则，换的是**页面上永远不会渲染
 *    一段攻击者控制的自由字符串**。
 */
const RE_ARTIFACT = /^(skill|pack):[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9A-Za-z.+-]{1,32}$/;
const RE_VERSIONISH = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const RE_NODE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const oneOf = (...vals) => (v) => vals.includes(v);

/**
 * 🔴 `reason` 是**有限代码表**，不是「符合某个形状的字符串」——
 *    与 `src/telemetry.mjs` 的 `REASONS` 逐字相同的一份抄件。
 *
 * ⚠️ 这一条被收紧过三次，第三次是在这里：本文件的初稿只做形状校验
 *    （`^[a-z][a-z0-9-]{0,39}$`），于是 `reason: "alice"` 形状完全合法、
 *    会被原样渲染到页面上（Codex 2026-09-01 指出）。摄入面按规格 §5.3 是
 *    **无鉴权**的，任何人都能灌一条这样的事件进来 —— 形状约束挡的是
 *    「看起来像路径的东西」，挡不住「看起来像代码的信息」。
 *    规格 §2.2 早就为同一个理由把它从正则收紧成枚举，这里必须跟上。
 *    🔴 **不要退回成正则**：正则允许的是一个无限集合，而我们要的恰恰是「有限」。
 *
 * 加新原因的顺序：先改 `src/telemetry.mjs`（过评审），再改这里。
 * `test/whitelist-drift.test.mjs` **双向**断言两张表相等，漏一边就会红。
 */
export const REASONS = Object.freeze([
  'signature-mismatch', 'digest-mismatch', 'trust-floor-violation', 'attestation-missing',
  'target-busy', 'target-missing', 'target-not-writable', 'unsupported-client',
  'not-found', 'already-installed', 'version-conflict', 'yanked',
  'network-error', 'timeout', 'offline', 'lock-busy',
  'journal-corrupt', 'ledger-corrupt', 'assertion-corrupt', 'user-abort',
  'unknown',
]);

/**
 * 维度定义。**页面上能有的分组维度只有这些**，每一个都指回 §2 的一个字段。
 *
 * `label` 是给人看的名字。⚠️ `version` 与 `cli` 都叫「版本」但不是一回事
 * （Codex 2026-09-01 指出），所以标签里写死「制品版本」/「CLI 版本」，
 * 页面上永远不出现一个孤零零的「version」。
 *
 */
export const DIMENSIONS = Object.freeze({
  artifact: { field: 'artifact', label: '制品坐标', hint: 'skill:ns/name@ver', valueOk: (v) => RE_ARTIFACT.test(v) },
  version: { field: 'version', label: '制品版本', hint: '制品自己的版本号，不是 CLI 的', valueOk: (v) => RE_VERSIONISH.test(v) },
  cli: { field: 'cli', label: 'CLI 版本', hint: 'skills-hub 自身的版本号', valueOk: (v) => RE_VERSIONISH.test(v) },
  client: { field: 'client', label: '客户端', hint: 'claude / cursor / codex / agents', valueOk: oneOf('claude', 'cursor', 'codex', 'agents') },
  os: { field: 'os', label: '操作系统', hint: 'darwin / linux', valueOk: oneOf('darwin', 'linux') },
  arch: { field: 'arch', label: '架构', hint: 'x64 / arm64', valueOk: oneOf('x64', 'arm64') },
  node: { field: 'node', label: 'Node 版本', hint: 'x.y.z', valueOk: (v) => RE_NODE.test(v) },
  kind: { field: 'kind', label: '动作', hint: 'install / update / remove / …', valueOk: oneOf('install', 'update', 'remove', 'check', 'rollback', 'recover', 'sync-lock', 'vendor') },
  result: { field: 'result', label: '结果', hint: 'ok / skipped / failed / corrupt', valueOk: oneOf('ok', 'skipped', 'failed', 'corrupt') },
  scope: { field: 'scope', label: '安装范围', hint: 'global / project', valueOk: oneOf('global', 'project') },
  reason: { field: 'reason', label: '原因码', hint: '有限代码表，不是自由文本', valueOk: oneOf(...REASONS) },
});

/** 维度键必须是上表里的一个。用于挡「服务端回了个我们没定义的分组」。 */
export function isAllowedDimension(key) {
  return Object.hasOwn(DIMENSIONS, key);
}
