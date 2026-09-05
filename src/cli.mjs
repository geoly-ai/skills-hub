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

const HELP = `skills-hub —— geoly skill 分发（M1 + M2 的命令面）

命令：
  install <spec>… | install --all    装制品（skill / pack:；--all 见 09-cli.md §3）
  list [--packs|--installed|--outdated]
  search <kw>…
  check                              两阶段校验（字节 / 现在还该不该用）
  why <name>                         谁请求装的
  sync-lock                          在 repo 锁下重算 geoly-skills.lock.json
  recover [--continue|--rollback|--reinstall] [--from-generation N [--only x]…]
          [--reset-generation N] [--resume-cleanup]
  vendor <pack-spec> --out <dir> [--layout flat]
                                     把 pack 与全部成员物化成一棵目录树（不走安装账本）
  update [<spec>…] | --all           重解析账本里的 root：展示 diff、确认后在一个事务里应用
  remove <name>                      减引用；🔴 **引用归零才删目录**（why <name> 看谁在要它）
  publish [path] [--dry-run]         投稿：本地过一遍服务端那批门 → 建 fork → 开 PR
                                     🔴 用你**已有**的 GitHub token（GEOLY_GITHUB_TOKEN /
                                     GH_TOKEN / GITHUB_TOKEN / \`gh auth token\`），CLI
                                     **不持有、不存储**它，也没有 login / logout。
                                     动手前会把 token 的权限面摆给你看并要求确认 ——
                                     \`--yes\` 只表示**确认了那个风险**，不跳过任何校验。

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
  --yes-i-really-want-everything  仅 --all 在非交互下使用（--yes 不够）
  --keep-generations <N>      attic 保留代数，默认 3
  --scan-max-depth <N>        嵌套 target 预检的扫描深度预算，默认 64（硬顶 1024）
  --scan-max-dirs <N>         同上，目录数预算，默认 100000（硬顶 5000000）
     报 target.nested-scan-incomplete 时，错误里会点名撞的是**哪一个**上限；
     只有那一条说「深度上限到顶」/「目录数上限用尽」时抬这里才有用。
     说「读不进去」的那种是权限问题，抬预算没有用。

🔴 没有 --no-verify、--insecure、--force、--force-unlock、--assume-idle、
   --skip-nested-scan。验签与摘要校验不可关闭；替换必须点名；
   陈旧/yank/全量各有独立开关；扫描预算只能**抬高**，不能关掉 ——
   关掉它就是把「无法证明没有嵌套 target」改写成「假设没有」（04-install.md §3.5）。

埋点（docs/telemetry/00-spec.md）：
  🔴 上报**默认开**（有内置默认端点）。**install 成功收尾后**会静默发一次
     （24 小时最多一次，超时 1 秒，失败不影响安装）；别的命令只写本地，
     也可以随时 \`telemetry flush\` 手动发。
     采集面是穷举白名单 —— 不含路径、目录清单、文件内容、用户名。
  GEOLY_TELEMETRY=0           完全关闭：本地一个字节都不写
  GEOLY_TELEMETRY_UPLOAD=0    只留本地统计，不上报
  GEOLY_TELEMETRY_ENDPOINT    改上报端点（必须 https；空值视为配置错误）
  --offline                   单次命令禁止一切网络出口，埋点上报同样被否决

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
  remove: () => import('./commands/remove.mjs').then((m) => m.cmdRemove),
  update: () => import('./commands/update.mjs').then((m) => m.cmdUpdate),
  vendor: () => import('./commands/vendor.mjs').then((m) => m.cmdVendor),
  publish: () => import('./commands/publish.mjs').then((m) => m.cmdPublish),
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

  // 🔴 首次运行的埋点告知。上报默认开（2026-09-01 拍板），所以**必须**在用户的
  //    第一条命令上把「收什么 / 发到哪 / 怎么关」说清楚，且只说一次。
  //    · 走 stderr：`--json` 下 stdout 只能有一个 JSON 对象（§7 输出契约）。
  //    · 放在这里而不是各命令里：它要覆盖**所有**命令，漏一条就有人被绕过告知。
  //    · 整个过程不许影响主命令（T-5），所以异常一律吞掉。
  //    🔴 **它必须先于任何一次自动上报**（§5.1.1）——「先发了再告诉你」比不告知
  //      更糟。这里的位置（命令分发之前）是第一道保证；第二道在 maybeAutoUpload
  //      里：告知的标记文件不存在就不发。两道都在，是因为第一道只是**调用顺序**，
  //      挪一行代码就能悄悄反过来而不会有任何东西变红。
  await noticeOnce(stderr);

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
    const code = await run(ctx, rest.slice(1), out);
    // 🔴 自动上报的**唯一**触发点（规格 §5.1.1，2026-09-01 拍板）。
    //
    // 判据两条，缺一不可：
    //   · `cmd === 'install'` —— 只有安装，别的命令一律不出网；
    //   · `code === EXIT.OK` —— 而且必须是**完全成功**。
    //     ⚠️ `EXIT.PARTIAL`（4，部分 target 失败）**不算**：一次没装干净的
    //        安装不该再替用户付一次网络代价。那批事件不会丢，留在本地等下一次
    //        成功的 install 或用户手动 flush（§5.2.2）。
    //     ⚠️ 抛错的路径根本走不到这里（下面的 catch 接住了），所以「失败不发」
    //        不是靠记得写 if，而是靠控制流。
    //
    // 🔴 这里 `await`，不是发了就不管：进程一退，在途的 POST 就没了。
    //    ⚠️ 代价是**这一次 install 会等它**。网络那一段有 1 秒上界
    //    （AUTO_UPLOAD_TIMEOUT_MS），但**整段没有**：认领戳的 fsync、上报锁、
    //    stage/reap 都是超时之外的同步 I/O。别把「最多多 1 秒」说成整体保证
    //    （规格 §5.1.1 已按实话改写）。
    //
    // 🔴 返回值**故意丢弃**：不打印、不改退出码。一次成功的 install 绝不能
    //    因为埋点失败而看起来像失败了。
    // 🔴 走 `autoUploadQuietly` 而不是在这里直接 `await import(...)`：
    //    这一段在 try 里，一个失败的动态 import 会被下面的 catch 接住、
    //    走 emitError —— 于是**一次成功的 install 会被埋点变成一次失败的输出**。
    //    正是本次拍板里那条硬要求要防的事。所以吞错要在调用点里面，不在外面。
    if (cmd === 'install' && code === EXIT.OK) await autoUploadQuietly();
    return code;
  } catch (err) {
    const cls = classify(err);
    return out.emitError(cmd, cls, err);
  }
}

/**
 * install 成功收尾后的自动上报（规格 §5.1.1）。**整段完全静默。**
 *
 * 🔴 连 `import` 都包在 try 里：`maybeAutoUpload` 自己不抛，但把它取进来这一步
 *    会（模块求值失败、文件被删）。差别不是理论上的 —— 调用点在 `main` 的 try 里，
 *    漏出去的异常会被顶层 catch 变成 `emitError`，用户看到的是一次**失败的 install**，
 *    而磁盘上其实一切正常。
 */
async function autoUploadQuietly() {
  try {
    const { maybeAutoUpload } = await import('./upload.mjs');
    await maybeAutoUpload();   // 返回值故意不看：不打印、不改退出码
  } catch { /* 埋点的任何问题都不许冒泡到主命令（T-5） */ }
}

/**
 * 首次运行时打印埋点告知（只打一次）。任何失败都不得影响主命令。
 *
 * ⚠️ 端点在这里解析而不是在 telemetry.mjs 里：upload.mjs 依赖 telemetry.mjs，
 *    反过来 import 会成环。
 */
async function noticeOnce(stderr) {
  try {
    const tm = await import('./telemetry.mjs');
    if (!tm.enabled() || !tm.uploadEnabled()) return;   // 没有出网就没什么可告知的
    const { endpoint } = await import('./upload.mjs');
    let url = null;
    try { url = endpoint(); } catch { return; }         // 端点配坏了 = 不会出网
    tm.maybeNoticeUpload((s) => stderr.write(s), url);
  } catch { /* 告知不是主命令的一部分（T-5） */ }
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
      // 🔴 端点默认开（2026-09-01 拍板），所以「这是内置默认值」必须写在脸上：
      //    用户有权知道数据默认发去哪，而不是去翻源码才发现有个默认端点。
      stdout.write(`端点      ${ep ?? '无'}${ep && up.isDefaultEndpoint() ? '（内置默认值 —— 未配 GEOLY_TELEMETRY_ENDPOINT）' : ''}\n`);
      stdout.write(`待上报    ${tm.readAll().length} 条\n`);
      stdout.write(`报表历史  ${tm.readHistory().length} 条（上报不消费它）\n`);
      stdout.write(`状态目录  ${tm.stateDir()}\n`);
      return EXIT.OK;
    }
    case 'flush': {
      const r = await up.flush();
      stdout.write(r.skipped
        ? `未上报：${r.reason}${r.detail ? `（${r.detail}）` : ''}\n`
        : `已上报 ${r.sent} 条\n`);
      // 🔴 `bad-endpoint` 也要非零退出：它是**配置错误**，不是「这次没什么可发的」。
      //    退 0 意味着脚本永远发现不了「端点变量填空了、这台机器从此不上报」。
      //    ⚠️ `offline` / `upload-disabled` / `empty` / `busy` 都是正常状态，退 0。
      const bad = r.skipped && (r.reason === 'bad-endpoint' || r.reason?.startsWith('error:'));
      return bad ? EXIT.USAGE : EXIT.OK;
    }
    default:
      stderr.write('用法：skills-hub telemetry <status|flush>\n');
      return EXIT.USAGE;
  }
}
