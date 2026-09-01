// 聚合查询：按 artifact 汇总 install / update / remove / check… 的次数与 result 分布。
//
// 🔴 枚举**从 src/telemetry.mjs 取**，不在这里重抄一份：
//    抄一份就等于多一个会漂移的采集面定义（同 validate.mjs 那条理由）。
import { KINDS, RESULTS } from '../src/telemetry.mjs';

export const ROLLUP_SCHEMA = 'geoly.skills.telemetry-rollup/1';

// 与 §2 的制品坐标同一个形状。rollup 文件可被改，键也要验。
const RE_ARTIFACT_KEY = /^(skill|pack):[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9A-Za-z.+-]{1,32}$/;

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

/**
 * 查询用的聚合：live 事件 + rollup 里那些原始事件已被丢弃的历史计数。
 *
 * ⚠️ **这是趋势信号，不是精确指标**（规格 §5.2.2 / T-13）：上报是 at-least-once，
 * 端点无鉴权任何人都能灌数据。**禁止把它用于计费或任何信任判定。**
 */
export function summarize(events, rollup = emptyRollup()) {
  const acc = foldInto(rollup, events);
  const byArtifact = Object.entries(acc.byArtifact)
    .map(([artifact, r]) => ({ artifact, ...r }))
    .sort((a, b) => b.n - a.n || a.artifact.localeCompare(b.artifact));
  return {
    schema: 'geoly.skills.telemetry-summary/1',
    total: acc.total,
    // 折算水位之前的事件只剩计数，明说出来，免得有人拿它当「全量原始数据」用
    rolled_up_before: acc.cutoff,
    byArtifact,
  };
}
