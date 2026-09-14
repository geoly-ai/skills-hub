// 聚合查询：按 artifact 汇总 install / update / remove / check… 的次数与 result 分布，
// 外加 dashboard 需要的各维度计数、去重装机数与安装耗时分位数。
//
// 🔴 枚举**从 src/telemetry.mjs 取**，不在这里重抄一份：
//    抄一份就等于多一个会漂移的采集面定义（同 validate.mjs 那条理由）。
// 🔴 维度取值的判据**从 dashboard/lib/whitelist.mjs 取**：dashboard 会拿同一张表把
//    取值再校验一遍，两边判据只要差一个字，dashboard 那侧就会「丢行」并判成
//    「一行都不认得」。那张表与 src/telemetry.mjs 的对账由 dashboard 的
//    whitelist-drift 测试负责；形状对账由 test/aggregate-summary.test.mjs 的契约测试负责。
import { KINDS, RESULTS } from '../src/telemetry.mjs';
import { DIMENSIONS } from '../dashboard/lib/whitelist.mjs';

export const ROLLUP_SCHEMA = 'geoly.skills.telemetry-rollup/1';
export const SUMMARY_SCHEMA = 'geoly.skills.telemetry-summary/1';

/**
 * 分位数门槛：一组安装事件少于它时，服务端**不给** p50 / p95（给 null）。
 *
 * 分位数是顺序统计量，样本少时 p95 就等于某一条原始耗时。dashboard 的
 * `lib/publish.mjs`（MIN_EVENTS_FOR_QUANTILE）在发布层同样挡一道；这里再挡一道，
 * 是为了让**原始响应本身**也不带小样本的顺序统计量 —— 响应会经过 dashboard 的
 * 服务端、日志与任何拿到 summary token 的人，不只是那张页面。
 * ⚠️ 与 dashboard 那个常量同值。改一边要改另一边。
 */
export const MIN_EVENTS_FOR_QUANTILE = 20;

/** 分位数向上取整的粒度（毫秒）。闭合顺序统计量的披露面：发布的是桶边界，不是某条原始耗时。 */
export const QUANTILE_ROUND_MS = 50;

/** 耗时的合法区间，与 src/telemetry.mjs 的 `ms` 校验器一致。 */
const MAX_MS = 86_400_000;

// 与 §2 的制品坐标同一个形状。rollup 文件可被改，键也要验。
const RE_ARTIFACT_KEY = /^(skill|pack):[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9A-Za-z.+-]{1,32}$/;

/** 输出的维度顺序。键名 = dashboard 读的 `by<Dim>`，每行的取值挂在 `<dim>` 键上。 */
const DIMS = Object.freeze(Object.keys(DIMENSIONS));
const dimKey = (dim) => `by${dim.charAt(0).toUpperCase()}${dim.slice(1)}`;

const zeroed = (set) => {
  const o = {};
  for (const k of [...set].sort()) o[k] = 0;
  return o;
};

/** 空聚合。`cutoff` 是「已经折算进来的事件的时间水位」，见 store 的 prune()。 */
export function emptyRollup() {
  return { schema: ROLLUP_SCHEMA, cutoff: 0, total: 0, byArtifact: {} };
}

/** 计数表只收已知键，且值必须是有限非负整数 —— rollup 文件是可以被改的 */
function sanitizeCounts(set, raw) {
  const out = zeroed(set);
  for (const k of Object.keys(out)) {
    const v = raw?.[k];
    if (Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

function bump(target, ev) {
  target.total++;
  // 没有 artifact 的事件（rollback / recover / sync-lock 之类）也要进总数，
  // 但不进 byArtifact —— 否则得凭空造一个 "(none)" 的假坐标出来。
  if (!ev.artifact) return;
  const row = target.byArtifact[ev.artifact] ?? (target.byArtifact[ev.artifact] = {
    n: 0, kinds: zeroed(KINDS), results: zeroed(RESULTS),
  });
  row.n++;
  row.kinds[ev.kind]++;
  row.results[ev.result]++;
}

/**
 * 把一批事件折进一个 rollup，返回**新的**对象（不改入参）。
 * 用于保留期外的原始事件被丢弃前把计数留下来（§5.3「之后只留聚合计数」）。
 */
export function foldInto(rollup, events) {
  // 结构化克隆：入参可能是 store 里正在用的那一份，不能就地改
  const next = {
    schema: ROLLUP_SCHEMA,
    cutoff: Number.isFinite(rollup?.cutoff) ? rollup.cutoff : 0,
    total: Number.isFinite(rollup?.total) ? rollup.total : 0,
    // 🔴 `Object.create(null)`：键来自 rollup 文件，而那个文件是可以被改的。
    //    往一个带原型的对象上赋值 `__proto__` 会**改原型**，不是加一个字段。
    byArtifact: Object.create(null),
  };
  for (const [k, v] of Object.entries(rollup?.byArtifact ?? {})) {
    // 键必须是合法的制品坐标 —— 不是就丢掉，别让脏数据从聚合面爬出来
    if (!RE_ARTIFACT_KEY.test(k)) continue;
    next.byArtifact[k] = {
      n: Number.isInteger(v?.n) && v.n >= 0 ? v.n : 0,
      // 只收已知键：`{...zeroed(KINDS), ...v.kinds}` 会把 v.kinds 里的任意键原样带进来
      kinds: sanitizeCounts(KINDS, v?.kinds),
      results: sanitizeCounts(RESULTS, v?.results),
    };
  }
  for (const ev of events) bump(next, ev);
  return next;
}

/** 维度取值是否可以作为一行输出：必须是字符串且过 dashboard 同一张表的校验器。 */
function valueOk(dim, v) {
  return typeof v === 'string' && DIMENSIONS[dim].valueOk(v);
}

/**
 * 最近秩分位数（nearest-rank），结果按 QUANTILE_ROUND_MS 向上取整。
 * `sorted` 必须已升序、非空。
 */
function quantile(sorted, q) {
  const idx = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return Math.ceil(sorted[idx] / QUANTILE_ROUND_MS) * QUANTILE_ROUND_MS;
}

/** 行排序：事件数降序，同数按取值升序（与 dashboard 同一个规则，免得两次刷新顺序乱跳）。 */
const byCountThenKey = (key) => (a, b) => b.n - a.n || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/**
 * 查询用的聚合。
 *
 * ⚠️ **这是趋势信号，不是精确指标**（规格 §5.2.2 / T-13）：上报是 at-least-once，
 * 端点无鉴权任何人都能灌数据。**禁止把它用于计费或任何信任判定。**
 *
 * ── 口径（改之前先读这一段）─────────────────────────────────────────────────
 *
 * 🔴 **凡是和 `installs` 同处一行的计数，都只来自 live 事件。**
 *    rollup 是保留期外的历史，只剩按制品的计数、**没有 install_id**。
 *    把它的 `n` 混进一行、而 `installs` 只数得到 live 的那部分，
 *    这一行就会说「40 条事件、2 台机器」—— 抑制器（K=5 按 installs 判）会被一个
 *    不是同一批事件算出来的比值误导，读者也会以为「一台机器制造了几十条事件」。
 *    所以：`by<Dim>`、顶层 `installs`、`durations` 一律 live；
 *    rollup 的按制品历史单独放在 `rolled_up.byArtifact`（dashboard 不读它）。
 *
 * · 顶层 `total` 仍是「live + rollup」—— 沿用原有语义，`rolled_up_before > 0`
 *   就是在说「total 里有一段只剩计数的历史」（dashboard 那张「关于数据本身」卡的文案
 *   依赖这一点）。**不另出 live 总数或 rollup 总数**：多出来的那个精确数
 *   会成为跨表相减的锚点（dashboard/README.md「跨表相减」）。
 *
 * · `install_id` 已被剥掉的 live 事件（90 天到期线、删除通道，规格 §2.3 / §3）：
 *   计入 `n`，不计入 `installs`。于是 `installs` 是**下界**，
 *   偏差方向是「多抑制」，不是「少抑制」。
 *
 * · `durations`：只用 `kind=install` 且 `result=ok`、带合法 `ms` 与 `version` 的事件，
 *   按制品版本分组（规格 §1 问题 3「一次安装要多久（性能回归）」；
 *   失败安装的耗时量的是「失败得多快」，混进来会污染回归信号）。
 *   口径是「**单个制品装一次要多久**」：CLI 只在一个 target 这次只装了一个制品时才给事件带
 *   `ms`（src/commands/install.mjs 的 emitTelemetry，2026-09-14 起）。批量安装（--all、
 *   一条命令多个 spec）的耗时拆不到单个制品上，不带 ms、不进分位数；pack 只记 pack 自己
 *   一条事件，算一个制品，照常带 ms —— 早先批量安装的每个制品都记整批耗时，
 *   分位数因此按制品数加权。⚠️ 0.3.8 及更早的 CLI 上报的事件仍是旧口径，混在库里直到到期。
 *
 * 🔴 输出里**没有**任何 install_id / eid / 身份字段的值：install_id 只进 Set 用来数数，
 *    输出的只是 `.size`。
 */
export function summarize(events, rollup = emptyRollup()) {
  // 历史只折 rollup 本身（经过 foldInto 的清洗），**不**把 live 事件折进去
  const hist = foldInto(rollup, []);

  const allInstalls = new Set();
  // dim -> Map<取值, { n, ids:Set }>
  const dims = Object.create(null);
  for (const dim of DIMS) dims[dim] = new Map();
  // artifact -> { kinds, results }（byArtifact 的附加字段，同为 live 口径）
  const artifactExtra = new Map();
  // version -> { ms: number[], ids:Set }
  const dur = new Map();

  let liveTotal = 0;
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue;
    liveTotal++;
    const id = typeof ev.install_id === 'string' && ev.install_id !== '' ? ev.install_id : null;
    if (id !== null) allInstalls.add(id);

    for (const dim of DIMS) {
      const v = ev[DIMENSIONS[dim].field];
      if (!valueOk(dim, v)) continue;
      const m = dims[dim];
      let cell = m.get(v);
      if (!cell) { cell = { n: 0, ids: new Set() }; m.set(v, cell); }
      cell.n++;
      if (id !== null) cell.ids.add(id);
      if (dim === 'artifact') {
        let x = artifactExtra.get(v);
        if (!x) { x = { kinds: zeroed(KINDS), results: zeroed(RESULTS) }; artifactExtra.set(v, x); }
        if (KINDS.has(ev.kind)) x.kinds[ev.kind]++;
        if (RESULTS.has(ev.result)) x.results[ev.result]++;
      }
    }

    if (ev.kind === 'install' && ev.result === 'ok' && valueOk('version', ev.version)
      && Number.isInteger(ev.ms) && ev.ms >= 0 && ev.ms <= MAX_MS) {
      let g = dur.get(ev.version);
      if (!g) { g = { ms: [], ids: new Set() }; dur.set(ev.version, g); }
      g.ms.push(ev.ms);
      if (id !== null) g.ids.add(id);
    }
  }

  const out = {
    schema: SUMMARY_SCHEMA,
    total: hist.total + liveTotal,
    installs: allInstalls.size,
    // 折算水位之前的事件只剩计数，明说出来，免得有人拿它当「全量原始数据」用
    rolled_up_before: hist.cutoff,
  };

  for (const dim of DIMS) {
    const rows = [];
    for (const [v, cell] of dims[dim]) {
      const row = { [dim]: v, n: cell.n, installs: cell.ids.size };
      if (dim === 'artifact') {
        const x = artifactExtra.get(v);
        row.kinds = x.kinds;
        row.results = x.results;
      }
      rows.push(row);
    }
    out[dimKey(dim)] = rows.sort(byCountThenKey(dim));
  }

  const durations = [];
  for (const [version, g] of dur) {
    const n = g.ms.length;
    let p50 = null;
    let p95 = null;
    if (n >= MIN_EVENTS_FOR_QUANTILE) {
      const sorted = g.ms.sort((a, b) => a - b);
      p50 = quantile(sorted, 0.5);
      p95 = quantile(sorted, 0.95);
    }
    durations.push({ version, n, installs: g.ids.size, p50, p95 });
  }
  out.durations = durations.sort(byCountThenKey('version'));

  // 保留期外的历史：只有按制品的计数，没有 installs —— 所以**不和上面任何一行混在一起**
  out.rolled_up = {
    byArtifact: Object.entries(hist.byArtifact)
      .map(([artifact, r]) => ({ artifact, n: r.n, kinds: r.kinds, results: r.results }))
      .sort(byCountThenKey('artifact')),
  };

  return out;
}
