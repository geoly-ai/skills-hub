/*
 * 把 `/v1/summary` 的返回归一成一个 viewmodel。
 *
 * 🔴 **本文件是「服务端会变形」这件事的唯一缓冲层。**
 *    `server/` 正在被改成 Postgres + Vercel 形态，它的返回形状会变。
 *    页面组件一律只读 viewmodel，**不许**直接摸原始 body ——
 *    这样服务端换形状时要改的只有这一个文件。
 *
 * 🔴 **只做搬运和过滤，绝不做聚合。**
 *    不许在这里算 P50、不许把 byArtifact 反过来推 byClient、不许补差值。
 *    自己算一份就会和 `server/aggregate.mjs` 分叉，两边对同一个问题给出两个答案，
 *    而分叉是**不会变红**的那类错 —— 只会让人某天发现两张表对不上，
 *    然后不知道该信哪一张。缺维度就如实说「服务端还没算」（state.mjs 的
 *    VIEW.DIMENSION_MISSING），并把需要的聚合列到页面上。
 *
 * 🔴 **逐字段显式构造，一次 spread 都不许有。**
 *    `{...row}` 会把服务端将来加的任何字段原样带进 viewmodel，
 *    于是「服务端加了个字段」= 「dashboard 悄悄展示了它」。
 *    白名单要正向才闭合（这条教训规格 §2 已经吃过一次）。
 */
import { DIMENSIONS, isAllowedDimension, stripIdentifiers } from './whitelist.mjs';

/** 服务端 summary 的 schema 常量。⚠️ 只用来判「像不像」，不用来判版本兼容。 */
export const SUMMARY_SCHEMA = 'geoly.skills.telemetry-summary/1';

const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

/** 容器形状不对时抛这个，让整份汇总判成 INVALID —— 见 readDimension 的长注释。 */
class BadShape extends Error {}

/**
 * 服务端把一个维度的聚合放在哪个键上。
 *
 * 支持两种命名（服务端形状未定，两边都认）：`byArtifact` 与 `by_artifact`。
 * 🔴 **不做模糊匹配**：不接受 `artifacts` / `artifactBreakdown` 之类。
 *    模糊匹配会让「服务端加了个我们没设计过的东西」自动出现在页面上。
 */
function dimensionKeys(dim) {
  const cap = dim.charAt(0).toUpperCase() + dim.slice(1);
  return [`by${cap}`, `by_${dim}`];
}

/**
 * 读一个维度的行。接受两种形状：
 *   · 数组：`[{ artifact|key, n|events, installs }, …]`
 *   · 对象映射：`{ "<值>": { n|events, installs }, … }`
 *
 * 取值本身要过 `DIMENSIONS[dim].valueOk`（见 whitelist.mjs 的理由：摄入面无鉴权）。
 *
 * 🔴 **容器形状不对（`byArtifact: "x"` / `byArtifact: 3`）要判 INVALID，不能当成空表。**
 *    初稿把它读成 `{ available: true, rows: [] }`，于是页面会说
 *    「当前筛选条件下没有行」—— **把一次故障说成了一个结论**
 *    （Codex 2026-09-01 指出）。这正是本平台最要防的那件事，只不过发生在更里面一层。
 *
 * 🔴 **不读 `kinds` / `results` 这类嵌套分布，连读都不读。**
 *    父行 `installs >= 5` **不代表** `artifact × result` 这个交叉子组也达标：
 *    `installs=5, results={ failed: 1, ok: 4 }` 会直接披露「有 1 次失败」，
 *    而那 1 次背后可能只有 1 台机器（Codex 2026-09-01 判为 P0）。
 *    交叉子组要发布，就得**每一格自己带 distinct installs** —— 服务端目前给不了。
 *    ⚠️ 不读进 viewmodel 是有意的：读进来就迟早会有人把它渲染出来，
 *    而那时抑制器根本不知道该拿什么去判它。
 */
function readDimension(body, dim) {
  if (!isAllowedDimension(dim)) return { available: false, rows: [] };
  const spec = DIMENSIONS[dim];
  let raw;
  for (const k of dimensionKeys(dim)) {
    if (body[k] !== undefined && body[k] !== null) { raw = body[k]; break; }
  }
  if (raw === undefined) return { available: false, rows: [] };
  if (typeof raw !== 'object') throw new BadShape(`${dimensionKeys(dim)[0]} 不是数组也不是对象`);

  const entries = Array.isArray(raw)
    ? raw.map((r) => [r?.[dim] ?? r?.key, r])
    : Object.entries(raw);

  const rows = [];
  // 🔴 **数一下丢了几行。** 丢掉脏行是对的（摄入面无鉴权），但「丢完之后剩 0 行」
  //    与「服务端本来就返回 0 行」是两件事：前者是「回来的东西我们一行都不认得」，
  //    后者是「这个维度本来就是空的」。不区分的话，前者会被说成后者 ——
  //    又一次把故障说成结论（Codex 2026-09-01 指出这条旁路）。
  let dropped = 0;
  for (const [key, r] of entries) {
    if (typeof key !== 'string' || !spec.valueOk(key)) { dropped++; continue; }
    if (r === null || typeof r !== 'object') { dropped++; continue; }
    const events = int(r.n) ?? int(r.events);
    if (events === null) { dropped++; continue; }
    rows.push({
      key,
      label: spec.label,
      events,
      // 🔴 去重装机数。**服务端必须把它命名成 `installs`（一个计数）**，
      //    因为任何 `install_id` / `installIds` 形态的键都会在
      //    stripIdentifiers() 那一步被剥掉 —— 那是故意的：
      //    「我们只要数，不要 ID」这件事由键名本身兑现，不靠自觉。
      installs: int(r.installs),
    });
  }
  // 事件数降序；同数按键名稳定排序，免得两次刷新顺序乱跳
  rows.sort((a, b) => b.events - a.events || a.key.localeCompare(b.key));
  return { available: true, rows, dropped };
}

/**
 * 耗时分布（§1 的问题 3）。
 *
 * 🔴 **P50/P95 由服务端算，这里只搬运。** 客户端拿不到原始 `ms`，
 *    也**不该**拿到 —— 一串原始耗时按时间排开同样是一条机器轨迹。
 *
 * 期望形状：`durations: [{ <groupBy>: "<值>", n, installs, p50, p95 }, …]`，
 * `groupBy` 目前设想是 `version`（看性能回归）或 `cli`。
 */
function readDurations(body) {
  const raw = body.durations ?? body.byDuration ?? body.by_duration;
  if (raw === undefined || raw === null) return { available: false, groups: [] };
  // 与 readDimension 同一条理由：形状不对是故障，不是「还没算」
  if (!Array.isArray(raw)) throw new BadShape('durations 不是数组');

  const groups = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue;
    // 分组维度只能是白名单里的那几个
    const dim = ['version', 'cli', 'client', 'os', 'arch', 'node'].find(
      (d) => typeof r[d] === 'string' && DIMENSIONS[d].valueOk(r[d]),
    );
    if (!dim) continue;
    const events = int(r.n) ?? int(r.events);
    if (events === null) continue;
    groups.push({
      dim,
      key: r[dim],
      label: DIMENSIONS[dim].label,
      events,
      installs: int(r.installs),
      p50: num(r.p50),
      p95: num(r.p95),
    });
  }
  groups.sort((a, b) => b.events - a.events || a.key.localeCompare(b.key));
  // ⚠️ available 只取决于「服务端有没有回这个键」，不取决于「解析出几行」。
  return { available: true, groups };
}

/**
 * 折算水位：早于它的原始事件已按保留期丢弃、只剩计数（server/aggregate.mjs 的 cutoff）。
 *
 * 🔴 **只留一个布尔，不留那个时间戳。** 它是服务端的 `received_at` 水位，
 *    既不在 §2 的采集字段表里，也不回答 §1 的三个问题 —— 属于多余的运行元数据
 *    （Codex 2026-09-01 指出）。页面要说的只有一句「有一段历史只剩计数、没有细分」，
 *    那句话不需要精确到毫秒。顺带也堵掉了「一个合法但极大的整数让
 *    `new Date(x).toISOString()` 抛错」那一格。
 *
 * 🔴 **但「有值且非法」要判 INVALID，不能静默当成 false**（Codex 2026-09-01 指出）：
 *    那会让页面断言「原始事件都还在」—— 又是一次把故障说成结论。
 */
function readRolledUp(body) {
  const raw = body.rolled_up_before;
  if (raw === undefined || raw === null) return false;
  const v = int(raw);
  if (v === null) throw new BadShape('rolled_up_before 不是非负整数');
  return v > 0;
}

/**
 * 主入口。
 * @returns {{ok:true, …}|{ok:false, why:string}}
 *
 * `ok:false` 对应 state.mjs 的 SOURCE.INVALID：**HTTP 200 也可能是一张代理错误页**
 * （规格 T-19 在客户端上报那一侧吃过同一个亏）。判据是「body 长得像不像一份汇总」，
 * 不是「HTTP 没报错」。
 */
export function normalizeSummary(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, why: 'body 不是一个 JSON 对象' };
  }
  // 第二道：递归剥掉识别符形态的键（第一道是下面的逐字段构造）
  const body = stripIdentifiers(raw);
  if (body.schema !== SUMMARY_SCHEMA) {
    return { ok: false, why: `schema 不是 ${SUMMARY_SCHEMA}` };
  }
  const total = int(body.total);
  if (total === null) return { ok: false, why: 'total 不是非负整数' };

  const dimensions = Object.create(null);
  let durations;
  let hasRolledUp;
  try {
    for (const dim of Object.keys(DIMENSIONS)) dimensions[dim] = readDimension(body, dim);
    durations = readDurations(body);
    hasRolledUp = readRolledUp(body);
  } catch (e) {
    if (e instanceof BadShape) return { ok: false, why: e.message };
    throw e;
  }

  return {
    ok: true,
    total,
    hasRolledUp,
    /**
     * 全局去重装机数。`null` = 服务端没给。
     * 🔴 `null` **不等于 0**，页面上要说「未提供」，见 suppress.formatInstalls()。
     */
    installs: int(body.installs),
    dimensions,
    durations,
  };
}
