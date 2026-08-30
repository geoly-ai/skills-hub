// 命令分发与顶层错误处理 —— 09-cli.md §1 / §2 / §6 / §7。
//
// 🔴 §7 的输出契约在这里兜底，不在各命令里各写一遍：
//    `--json` 时 stdout **只有一个 JSON 对象** —— 成功、用法错误、解析失败、
//    锁被占用、内部错误，**每一条路径都是**。只在成功路径上给对象，等于让脚本
//    在失败时读到空 stdout 然后自己去猜。
//
// 🔴 `--offline` 在 `makeContext()` 里就置位（它要早于任何可能出网的代码求值），
//    埋点上报继承这条边界（`telemetry.offline()` 读的是同一个变量）。

import { acquire } from './lock.mjs';
import { parseGlobals, makeContext } from './commands/context.mjs';
import { Output } from './commands/output.mjs';
import { createCacheRegistry } from './commands/registry.mjs';
import { EXIT, classify, UsageError } from './exit-codes.mjs';

const HELP = `skills-hub —— geoly skill 分发（M1 + M2 的 vendor / install pack:）

命令：
  install <spec>…                    装制品（skill 与 pack:；--all 仍在做）
  list [--packs|--installed|--outdated]
  search <kw>…
  check                              两阶段校验（字节 / 现在还该不该用）
  why <name>                         谁请求装的
  sync-lock                          在 repo 锁下重算 geoly-skills.lock.json
  recover [--continue|--rollback|--reinstall] [--from-generation N [--only x]…]
          [--reset-generation N] [--resume-cleanup]
  vendor <pack-spec> --out <dir> [--layout flat]
                                     把 pack 与全部成员物化成一棵目录树（不走安装账本）

  stats [--json] [--export <file>]   本地埋点报表
  telemetry <status|flush>           埋点/上报开关与队列

全局 flag（09-cli.md §2）：
  --clients <list>            默认 = 本机已存在的全部；含未安装 client 是硬错误
  --create-missing <client|all>
  --project [path]            装到仓库内，维护 geoly-skills.lock.json
  --shadow-global             全局已有同名时，项目级安装才允许继续
  --snapshot <N>              钉快照复现
  --offline                   只用缓存；未命中即失败。禁止一切网络出口
  --allow-stale               timestamp 过期时才允许继续，输出持续标注 stale
  --allow-yanked              仅取证；大声告警并写进账本（不放行 degraded）
  --replace <name>            点名替换未被账本认领的同名目录
  --no-bundled / --pre / --json / --yes
  --keep-generations <N>      attic 保留代数，默认 3

🔴 没有 --no-verify、--insecure、--force、--force-unlock、--assume-idle。
   验签与摘要校验不可关闭；替换必须点名；陈旧/yank/全量各有独立开关。

退出码（§6）：0 成功 · 1 用法 · 2 完整性 · 3 冲突 · 4 部分失败 · 5 需 recover/锁忙
              6 网络 · 7 认证 · 8 陈旧 · 9 平台/文件系统 · 10 不可写 · 11 CLI 版本过低
`;

/** 需要完整运行时上下文（快照、锁、target）的命令。 */
const COMMANDS = {
  install: () => import('./commands/install.mjs').then((m) => m.cmdInstall),
  list: () => import('./commands/query.mjs').then((m) => m.cmdList),
  search: () => import('./commands/query.mjs').then((m) => m.cmdSearch),
  why: () => import('./commands/query.mjs').then((m) => m.cmdWhy),
  check: () => import('./commands/check.mjs').then((m) => m.cmdCheck),
  'sync-lock': () => import('./commands/sync-lock.mjs').then((m) => m.cmdSyncLock),
  recover: () => import('./commands/recover.mjs').then((m) => m.cmdRecover),
  vendor: () => import('./commands/vendor.mjs').then((m) => m.cmdVendor),
};

/**
 * @param {string[]} argv
 * @param {object} [deps]  🔴 **只有进程内的调用方给得了** —— argv 与环境变量都到不了这里。
 *        生产入口 `bin/skills-hub.mjs` 一个 dep 都不传，所以生产路径上
 *        验签器一定是真的、registry 一定是缓存适配器。
 */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // ── 内部探针（测试用；不进 --help） ──────────────────────────────────────
  if (argv[0] === '--warn-probe') return warnProbe(stdout);
  if (argv[0] === '--fault-probe') return faultProbe(stdout);

  // 🔴 全局 flag 要**先**解析：`--json` 决定失败时怎么输出。
  //    解析本身失败时只能按非 JSON 报 —— 那时我们还不知道用户要不要 JSON。
  //    🔴 解析**本身**失败时也必须给 JSON —— 那时 `parseGlobals` 还没跑完，
  //    所以先做一次廉价预扫。少了这一步，`--json` 下的用法错误会让 stdout 全空，
  //    脚本读到 0 字节只能去猜。
  let parsed;
  const preJson = argv.includes('--json') || argv.includes('--json=true');
  try {
    parsed = parseGlobals(argv);
  } catch (err) {
    const plain = new Output({ json: preJson, stdout, stderr });
    return plain.emitError(argv[0] ?? 'skills-hub', classify(err), err);
  }
  const { globals, rest } = parsed;
  // 🔴 `--offline` 必须在**任何**可能出网的分流之前置位。
  //    早先它只在 `makeContext()` 里置位，而 `telemetry flush` 走的是下面那条
  //    不经过 makeContext 的捷径 —— 于是 `skills-hub --offline telemetry flush`
  //    会照常 POST 出去（upload.flush 的一票否决读的正是这个变量）。
  //    这是 §2「离线模式禁止任何网络出口」的**直接违反**，不是边角情况。
  if (globals.offline) {
    // 🔴 两个都要设，缺一不可：
    //   · `deps.env`  —— ctx 与 adapter 读的是它；
    //   · `process.env` —— **telemetry / upload 读的是它**（telemetry.offline()）。
    //     只设注入的那个，`--offline` 就管不住上报 —— 而 `--offline` 承诺的是
    //     「整个 CLI 不得有任何网络出口」，那是一条**进程级**保证。
    // ⚠️ 这是**进程级且粘住**的：一个 CLI 进程只跑一条命令，
    //    「置位之后不再撤销」正是「整个 CLI 不得有任何网络出口」该有的形状。
    process.env.GEOLY_OFFLINE = '1';
    if (deps.env && deps.env !== process.env) deps.env.GEOLY_OFFLINE = '1';
  }
  const out = new Output({ json: globals.json, stdout, stderr });
  const cmd = rest[0];

  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    if (globals.json) return out.emit('help', { help: HELP }, EXIT.OK);
    stdout.write(HELP);
    return EXIT.OK;
  }

  // 埋点两个子命令是纯本地的，不需要快照/锁/target
  if (cmd === 'stats') return cmdStats(rest.slice(1), globals, stdout, stderr);
  if (cmd === 'telemetry') return cmdTelemetry(rest.slice(1), stdout, stderr);

  const load = COMMANDS[cmd];
  if (!load) {
    const err = new UsageError(`未知命令：${cmd}\n可用：${Object.keys(COMMANDS).sort().join(' / ')}`);
    return out.emitError(cmd, classify(err), err);
  }

  try {
    const base = makeContext(globals, deps);
    const registry = base.registryFactory
      ? base.registryFactory({ cacheDir: base.cacheDir, offline: base.offline })
      : createCacheRegistry({ cacheDir: base.cacheDir, offline: base.offline });
    const record = base.record ?? (await import('./telemetry.mjs')).record;
    const ctx = Object.freeze({ ...base, record, registry });
    const run = await load();
    return await run(ctx, rest.slice(1), out);
  } catch (err) {
    const cls = classify(err);
    return out.emitError(cmd, cls, err);
  }
}

// ── 内部探针 ─────────────────────────────────────────────────────────────────

async function warnProbe(stdout) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  acquire(join(mkdtempSync(join(tmpdir(), 'probe-')), 'l.db'))();
  stdout.write('PROBE_OK\n');
  return EXIT.OK;
}

async function faultProbe(stdout) {
  const fi = await import('./fault-inject.mjs');
  const leaked = Object.keys(process.env).filter((k) => k.startsWith('GEOLY_FAULT'));
  const s = fi.state();
  stdout.write(`leaked=${leaked.join(',')} locked=${s.LOCKED} armed=${s.ARMED} active=${s.ACTIVE}\n`);
  return EXIT.OK;
}

// ── 埋点子命令（M0 命令面之外，保留原有行为） ───────────────────────────────

async function cmdStats(args, globals, stdout, stderr) {
  const { stats, textReport } = await import('./stats.mjs');
  const { exportJson } = await import('./telemetry.mjs');
  const { agg, events } = stats();

  const exportIdx = args.indexOf('--export');
  if (exportIdx !== -1) {
    const dest = args[exportIdx + 1];
    if (!dest) { stderr.write('--export 需要一个文件路径\n'); return EXIT.USAGE; }
    const { writeAtomic } = await import('./atomic-fs.mjs');
    writeAtomic(dest, exportJson(events));
    stderr.write(`已导出 ${events.length} 条事件到 ${dest}\n`);
    return EXIT.OK;
  }
  if (globals.json) { stdout.write(`${JSON.stringify(agg, null, 2)}\n`); return EXIT.OK; }
  stdout.write(textReport(agg));
  return EXIT.OK;
}

async function cmdTelemetry(args, stdout, stderr) {
  const tm = await import('./telemetry.mjs');
  const up = await import('./upload.mjs');
  switch (args[0]) {
    case 'status': {
      let ep;
      try { ep = up.endpoint(); } catch (e) { ep = `无效（${e.message}）`; }
      const uploadOff = !tm.enabled() ? '关（埋点整体已关）'
        : tm.offline() ? '关（--offline）'
          : '关（GEOLY_TELEMETRY_UPLOAD=0）';
      stdout.write(`埋点      ${tm.enabled() ? '开' : '关（GEOLY_TELEMETRY=0）'}\n`);
      stdout.write(`上报      ${tm.uploadEnabled() ? '开' : uploadOff}\n`);
      stdout.write(`端点      ${ep ?? '未配置 —— 纯本地'}\n`);
      stdout.write(`待上报    ${tm.readAll().length} 条\n`);
      stdout.write(`报表历史  ${tm.readHistory().length} 条（上报不消费它）\n`);
      stdout.write(`状态目录  ${tm.stateDir()}\n`);
      return EXIT.OK;
    }
    case 'flush': {
      const r = await up.flush();
      stdout.write(r.skipped ? `未上报：${r.reason}\n` : `已上报 ${r.sent} 条\n`);
      return r.skipped && r.reason?.startsWith('error:') ? EXIT.USAGE : EXIT.OK;
    }
    default:
      stderr.write('用法：skills-hub telemetry <status|flush>\n');
      return EXIT.USAGE;
  }
}
