// 输出契约 —— 09-cli.md §7。
//
//   · 人类输出 stdout；进度与告警 stderr。
//   · `--json` 时 stdout **只有**一个 JSON 对象 —— 🔴 **成功、用法错误、解析失败、
//     锁被占用、内部错误，每一条路径都是**。只在成功路径上给一个 JSON 对象，
//     等于让脚本在失败时读到空 stdout 然后自己去猜。
//   · 每次 `install` 结尾必须打印逐 target 结果表，即使全部成功。**不允许只打一句 done。**
//   · stale / offline / yanked / degraded / shadowed 必须在**每一次**相关输出里重复标注。
//     🔴 因此这些标注挂在**每一个** target / artifact 结果对象上，不是只挂顶层一份 ——
//     顶层一份的话，一份逐行表格里没有一行看得出自己是 stale 的。
//
// 🔴 **JSON 的 schema 名不是 wire contract 的一部分。**
//    11-wire-contract.md §1 的适用对象清单里**没有** CLI 的 `--json` 输出。
//    这里复用 §3 的 canonical 生成规则（同一个 `stringify`，schema 首位、字节序、
//    2 空格、结尾一个 \n、非 ASCII 小写 hex 转义），但 `geoly.skills.cli.<cmd>/1`
//    这个名字与它的字段表**尚未登记进规范**。这条写进交付汇报，由规格侧决定是否收编。

import { stringify } from '../canonical-json.mjs';

/** 每个命令一个 schema 名。🔴 见上：**未登记**，不得对外宣称是 wire contract。 */
export const CLI_SCHEMA = (cmd) => `geoly.skills.cli.${cmd}/1`;

/** 🔴 canonical JSON 不接受 `undefined`（`enc` 会抛「不支持的类型」）。递归剔除。 */
export function pruneUndefined(v) {
  if (Array.isArray(v)) return v.map(pruneUndefined);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = pruneUndefined(val);
    return out;
  }
  return v;
}

/**
 * 标注集合。🔴 挂在**每一个**结果对象上，不是只挂顶层。
 * 值一律是布尔，`false` 也写出来 —— 「字段缺席」在这里会被误读成「查过了，没事」。
 */
export function annotations({ stale = false, offline = false, yanked = false, degraded = false, shadowed = false } = {}) {
  return { degraded, offline, shadowed, stale, yanked };
}

/** 人类可读的标注后缀，例如 ` [stale] [offline] [yanked]`。空则返回空串。 */
export function annotationSuffix(a) {
  const on = [];
  if (a.stale) on.push('stale');
  if (a.offline) on.push('offline');
  if (a.yanked) on.push('yanked');
  if (a.degraded) on.push('degraded');
  if (a.shadowed) on.push('shadowed');
  return on.length ? ` ${on.map((s) => `[${s}]`).join(' ')}` : '';
}

export class Output {
  constructor({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    this.json = json;
    this._out = stdout;
    this._err = stderr;
    this._warnings = [];
    this._emitted = false;
  }

  /** 进度 —— 永远 stderr。`--json` 下也照常输出（stdout 才是被要求干净的那个）。 */
  note(msg) { this._err.write(`${msg}\n`); }

  /**
   * 告警 —— stderr，**并且**进 JSON 的 `warnings`。
   * `planTargets()` 的 `duplicate-catalog` 走这条：09-cli.md 要求展示给用户，不得吞掉。
   */
  warn(obj) {
    const w = typeof obj === 'string' ? { kind: 'general', message: obj } : obj;
    this._warnings.push(w);
    this._err.write(`⚠️ ${w.message}\n`);
    return w;
  }

  warnings() { return this._warnings.slice(); }

  /** 人类行 —— stdout。`--json` 下**一个字节都不写**（stdout 只能有那一个对象）。 */
  line(msg = '') { if (!this.json) this._out.write(`${msg}\n`); }

  /**
   * 收尾。`--json` 时写出**唯一**那个对象；否则什么都不写（人类输出已经逐行打过了）。
   * 🔴 只允许调一次 —— 调两次就破了「stdout 只有一个 JSON 对象」。
   */
  emit(cmd, body, exitCode) {
    if (this._emitted) throw new Error('输出契约：一次运行只能 emit 一个 JSON 对象');
    this._emitted = true;
    if (!this.json) return exitCode;
    const doc = pruneUndefined({
      schema: CLI_SCHEMA(cmd),
      command: cmd,
      exit_code: exitCode,
      ok: exitCode === 0,
      warnings: this._warnings,
      ...body,
    });
    this._out.write(stringify(doc));
    return exitCode;
  }

  /**
   * 失败收尾。`--json` 下同样只有一个对象。
   * @param {string} cmd
   * @param {{code:number, unclassified:boolean}} cls  `exit-codes.classify()` 的产物
   */
  emitError(cmd, cls, err, extra = {}) {
    const message = err?.message ?? String(err);
    if (!this.json) {
      this._err.write(`${cls.unclassified ? '内部错误（CLI 自身的 bug，不是制品有问题）：' : ''}${message}\n`);
    }
    return this.emit(cmd, {
      error: pruneUndefined({
        exit_code: cls.code,
        // 机器可读的错误名：内核错误用它自己的 name，我们自己的用类名
        name: err?.name ?? 'Error',
        message,
        unclassified: cls.unclassified,
        // 预检聚合错带全部违规项 —— 🔴 JSON 里**始终保留全部**，不只报优先级最高那条
        // 🔴 `detail` 必须一起出：它是**给机器读的那一半**（嵌套 target 的 relation/via、
        //    扫描没跑完时撞的是哪个上限、实际值、样例路径）。只留 message 等于逼
        //    调用方去正则解析中文文案 —— 那正是 `detail` 存在的理由。
        //    ⚠️ 白名单式挑字段是对的，别改成整个 `...v` 透传。
        violations: Array.isArray(err?.violations)
          ? err.violations.map((v) => pruneUndefined({
            code: v.code, message: v.message, path: v.path, detail: v.detail,
          }))
          : undefined,
        candidates: Array.isArray(err?.candidates) ? err.candidates : undefined,
      }),
      ...extra,
    }, cls.code);
  }
}
