// 全局 flag 解析与运行时上下文 —— 09-cli.md §0 / §2。
//
// 🔴 三条硬约束在本文件落地：
//   · `--offline` 置位后**整个 CLI 不得有任何网络出口**（含埋点上报）；
//   · **没有** `--no-verify` / `--insecure` / `--force` / `--force-unlock` / `--assume-idle`
//     —— 不是「不实现」，是**显式拒绝并说明为什么没有**。默默当成未知 flag
//     会让人以为拼错了，然后去翻文档找正确写法；
//   · 平台契约（§0）：`win32` 且非 WSL → 直接拒绝并给 WSL 指引。
//
// 🔴 依赖注入走 `main(argv, deps)` 的**第二个形参**，不走 argv、不走环境变量。
//    这是结构性的：用户能控制的只有 argv 与 env，两者都到不了 `deps`。
//    （同 `target.mjs` 的 `TEST_DEPS` 与 `adapters` 的 `TEST_GATES` 的理由，
//     但这里连 Symbol 都不需要 —— 形参本身就够不着。）

import { homedir, platform } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { UsageError, UnsupportedError } from '../exit-codes.mjs';
import { SCAN_CEILINGS } from '../target.mjs';

/** §2 那张表。`arg: true` = 后面跟一个值。 */
const GLOBAL_FLAGS = Object.freeze({
  '--clients': { arg: true },
  '--create-missing': { arg: true },
  '--project': { arg: 'optional' },
  '--shadow-global': { arg: false },
  '--snapshot': { arg: true },
  '--offline': { arg: false },
  '--allow-stale': { arg: false },
  '--allow-yanked': { arg: false },
  '--replace': { arg: true, repeat: true },
  '--no-bundled': { arg: false },
  '--freeze-attic': { arg: true },
  '--keep-generations': { arg: true },
  '--scan-max-depth': { arg: true },
  '--scan-max-dirs': { arg: true },
  '--json': { arg: false },
  '--yes': { arg: false },
  '--yes-i-really-want-everything': { arg: false },
  '--pre': { arg: false },
});

/**
 * 🔴 明令不存在的开关。每一条都要说清**为什么没有**，否则用户只会觉得是拼写问题。
 * 文案取自 09-cli.md §2 末尾的四条理由。
 */
const REMOVED_FLAGS = Object.freeze({
  '--no-verify': '验签与摘要校验**不可关闭**（09-cli.md §2）。没有这个开关，也不会有。',
  '--insecure': '同 --no-verify：完整性校验没有逃生口（09-cli.md §2）。',
  '--force': '替换必须**点名**：用 `--replace <name>` 指定那一个目录，不提供泛化的大锤（§4.2）。',
  '--force-unlock':
    '锁是 node:sqlite 的排他事务，**进程退出由内核释放**——崩溃后下一次运行直接就能取到，'
    + '不需要任何人工干预（04-install.md §5.1）。',
  '--clear-lock': '同 --force-unlock：协议里没有任何 unlink，也就没有可清的东西（§5.1）。',
  '--assume-idle':
    '本工具**不检测也不阻断**正在运行的 agent（D5，04-install.md §9），所以没有可假设的东西。',
  '--skip-nested-scan':
    '嵌套 target 扫描**不能关闭**（04-install.md §3.5）。关掉它是把「无法证明没有嵌套」'
    + '改写成「假设没有嵌套」，而外层替换会连内层的 .geoly/ 一起搬走、两把锁互不相识。\n'
    + '扫描超预算时报错里会点名撞的是哪个上限：深度/目录数用 `--scan-max-depth <N>` / '
    + '`--scan-max-dirs <N>` 抬高（仍然是真扫描、仍然 fail-closed）；'
    + '说「读不进去」的那种是权限问题，抬预算没有用。',
  '--allow-pending':
    'Q12 是阻塞门，不是建议。要开某一格就补那一格的实测证据（docs/m1/01-residual-risks.md R-4）。',
});

/** §0 平台契约。WSL 的判据取 `/proc/version` 里的 microsoft 标记。 */
export function assertPlatformSupported(env = process.env, plat = platform()) {
  if (plat !== 'win32') return { platform: plat, wsl: isWsl() };
  throw new UnsupportedError(
    'Windows 原生不受支持（09-cli.md §0）。请在 WSL 里安装并运行：\n'
    + '  1. 在 PowerShell 里跑 `wsl --install`（或装一个已有发行版）\n'
    + '  2. 进入 WSL 后在**WSL 的文件系统里**（不是 /mnt/c）安装 Node ≥ 22.13\n'
    + '  3. 在 WSL 里重跑本命令\n'
    + '⚠️ 不要把 target 放在 /mnt/c 下 —— 那是 9p/drvfs，属于被拒绝的文件系统（§2.2）。',
  );
}

function isWsl() {
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

/**
 * 从 argv 里摘掉全局 flag，返回 `{ globals, rest }`。
 *
 * 🔴 **不**在这里给未知 flag 报错：命令自己还有子 flag（`--continue`、`--packs` …）。
 *    未知 flag 由各命令的解析器报，那里才知道自己认得哪些。
 *    但**被删除的开关**在这里就拦下 —— 它们对任何命令都不存在。
 */
export function parseGlobals(argv) {
  const globals = {
    clients: null,
    createMissing: null,
    project: undefined,          // undefined = 没给；string = 给了（可能是空串→cwd）
    shadowGlobal: false,
    snapshot: null,
    offline: false,
    allowStale: false,
    allowYanked: false,
    replace: [],
    noBundled: false,
    freezeAttic: null,
    keepGenerations: 3,
    json: false,
    yes: false,
    yesEverything: false,
    pre: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(REMOVED_FLAGS, a)) {
      throw new UsageError(`没有 \`${a}\` 这个开关。${REMOVED_FLAGS[a]}`);
    }
    // 🔴 `--flag=value` 与 `--flag value` 都要认：只认一种会让「照文档抄」的人踩空
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 2 ? a.slice(0, eq) : a;
    const inlineVal = a.startsWith('--') && eq > 2 ? a.slice(eq + 1) : undefined;
    const spec = GLOBAL_FLAGS[name];
    if (!spec) { rest.push(a); continue; }

    let val = inlineVal;
    if (spec.arg === true && val === undefined) {
      val = argv[++i];
      if (val === undefined || val.startsWith('-')) throw new UsageError(`${name} 需要一个值`);
    }
    if (spec.arg === 'optional' && val === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) val = argv[++i];
      else val = '';
    }
    applyGlobal(globals, name, val);
  }
  return { globals, rest };
}

function applyGlobal(g, name, val) {
  switch (name) {
    case '--clients': {
      // 🔴 空项要报错，不要静默丢：`--clients claude,` 多半是拼错了
      const list = val.split(',').map((s) => s.trim());
      if (list.some((s) => s === '')) throw new UsageError(`--clients 里有空项：${val}`);
      g.clients = (g.clients ?? []).concat(list);
      break;
    }
    case '--create-missing':
      if (val !== 'all' && !/^[a-z][a-z0-9-]*$/.test(val)) {
        throw new UsageError(`--create-missing 只接受 all 或一个 client 名，得到 ${val}`);
      }
      g.createMissing = g.createMissing === 'all' || val === 'all'
        ? 'all'
        : [...(Array.isArray(g.createMissing) ? g.createMissing : []), val];
      break;
    case '--project': g.project = val; break;
    case '--shadow-global': g.shadowGlobal = true; break;
    case '--snapshot': g.snapshot = uintArg(name, val); break;
    case '--offline': g.offline = true; break;
    case '--allow-stale': g.allowStale = true; break;
    case '--allow-yanked': g.allowYanked = true; break;
    case '--replace': g.replace.push(val); break;
    case '--no-bundled': g.noBundled = true; break;
    case '--freeze-attic': g.freezeAttic = val; break;
    case '--keep-generations': g.keepGenerations = uintArg(name, val); break;
    // 🔴 预检的**预算旋钮**，不是关闭开关。抬高它仍然是一次真扫描、仍然 fail-closed；
    //    抬到硬顶还不够就照旧拒绝。故意**不提供** `--skip-nested-scan`：
    //    那会把「无法证明没有嵌套」改成「假设没有嵌套」，正是 §3.5 要防的事
    //    （同 REMOVED_FLAGS 里 --force / --no-verify 的理由）。
    //    上界由 target.mjs 的 SCAN_CEILINGS 兜底，超了报错而不是静默截断。
    //    🔴 硬顶要在**解析期**就拒，不能等到预检里才抛：那时 install 已经
    //    建过 target/.geoly、取过锁，而 target.mjs 抛的是普通 Error ——
    //    会被 classify 判成 unclassified（退出码 2「完整性失败」），
    //    把一个「参数超上限」说成「制品坏了」。解析期拒 = 零磁盘副作用 + 退出码 1。
    //    （target.mjs 里那道保留为纵深防御：库调用方不经过本文件。）
    case '--scan-max-depth': g.scanMaxDepth = scanArg(name, val, 'maxDepth'); break;
    case '--scan-max-dirs': g.scanMaxDirs = scanArg(name, val, 'maxDirs'); break;
    case '--json': g.json = true; break;
    case '--yes': g.yes = true; break;
    case '--yes-i-really-want-everything': g.yesEverything = true; break;
    case '--pre': g.pre = true; break;
    default: throw new UsageError(`未处理的全局 flag ${name}`);
  }
}

/**
 * 扫描预算旋钮：非负整数 **且** 不超过 `target.mjs` 的硬顶。
 * 🔴 硬顶的**唯一出处**是 `SCAN_CEILINGS` —— 这里不复制一份数字，
 *    复制的那份迟早会跟本体漂。
 */
function scanArg(name, val, key) {
  const n = uintArg(name, val);
  if (n > SCAN_CEILINGS[key]) {
    throw new UsageError(
      `${name} 超过硬顶 ${SCAN_CEILINGS[key]}（收到 ${n}）。`
      + '预算旋钮不是关闭开关：无上限的遍历等于没有资源闸（04-install.md §3.5.1）。',
    );
  }
  return n;
}

/** 11-wire-contract.md §2：数字只允许非负整数，不允许前导零、浮点、指数、`-0`。 */
export function uintArg(name, val) {
  if (!/^(0|[1-9]\d*)$/.test(val)) {
    throw new UsageError(`${name} 需要一个非负整数（不允许前导零 / 浮点 / 指数），得到 ${val}`);
  }
  const n = Number(val);
  if (!Number.isSafeInteger(n)) throw new UsageError(`${name} 超出安全整数范围：${val}`);
  return n;
}

/**
 * 造运行时上下文。
 *
 * @param {object} globals  parseGlobals 的产物
 * @param {object} deps     🔴 只从 `main(argv, deps)` 的第二个形参来，argv/env 到不了这里
 */
/**
 * 本 CLI 自己的版本 —— 🔴 **从 package.json 读，不要硬编码。**
 *
 * ⚠️ 这里原本是字面量 `'0.0.0-m1'`。后果不是「显示得不好看」：
 *    `timestamp.min_cli_version` 是按真实版本号比对的策略门，
 *    而 `bin/skills-hub.mjs` 一个 dep 都不传 —— 于是**发布出去的 CLI
 *    自报 0.0.0-m1，会被自己的 min_cli_version 当场挡死**。
 *    2026-09-03 首次端到端安装时撞到：timestamp 写着 0.3.0，
 *    而刚从 npm 装下来的 0.3.0 报的是 0.0.0-m1 → E_MIN_CLI_VERSION。
 *
 * 🔴 读不到就**抛**，不要退回一个假版本号：一个编出来的版本号会让
 *    版本门做出错误判定，而那正是这道门要防的事。
 */
let cachedVersion;
export function ownVersion() {
  if (cachedVersion === undefined) {
    const p = new URL('../../package.json', import.meta.url);
    const v = JSON.parse(readFileSync(p, 'utf8')).version;
    if (typeof v !== 'string' || v === '') {
      throw new Error('读不出本 CLI 的版本号（package.json 的 version 不是非空字符串）');
    }
    cachedVersion = v;
  }
  return cachedVersion;
}

export function makeContext(globals, deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  assertPlatformSupported(env, deps.platform ?? platform());

  // 🔴 `--offline` 要在**任何**可能出网的代码求值之前置位。
  //    telemetry.offline() 读的就是这个变量，upload.flush() 一票否决靠它。
  if (globals.offline) env.GEOLY_OFFLINE = '1';
  const offline = globals.offline || env.GEOLY_OFFLINE === '1';

  const scope = globals.project !== undefined ? 'project' : 'global';
  let projectRoot = null;
  if (scope === 'project') {
    projectRoot = globals.project === '' ? cwd : resolvePath(cwd, globals.project);
    if (!isAbsolute(projectRoot)) throw new UsageError(`--project 的路径解析不出绝对路径：${globals.project}`);
    if (!existsSync(projectRoot)) throw new UsageError(`--project 指向的目录不存在：${projectRoot}`);
  }

  // 全局元数据目录（trust floor + metadata 锁）。埋点用的是同一个根，保持一致。
  const stateDir = deps.stateDir
    ?? env.GEOLY_STATE_DIR
    ?? resolvePath(home, '.local/state/geoly-skills');
  const cacheDir = deps.cacheDir ?? env.GEOLY_CACHE_DIR ?? resolvePath(home, '.cache/geoly-skills');

  const ctx = Object.freeze({
    ...globals,
    offline,
    scope,
    projectRoot,
    home,
    env,
    cwd,
    stateDir,
    cacheDir,
    /** 🔴 时间只从这里取：canonical JSON 要求严格 `YYYY-MM-DDTHH:MM:SSZ`，测试要能定死它 */
    now: deps.now ?? (() => new Date()),
    cliVersion: deps.cliVersion ?? env.GEOLY_CLI_VERSION ?? ownVersion(),
    /**
     * 🔴 验签器**没有逃生口**：`deps.verifier` 只有 `main(argv, deps)` 的调用方能给，
     *    而生产入口 `bin/skills-hub.mjs` 一个 dep 都不传。
     *    不给就用真验签器（内置信任根），`defaultVerifier` 那个会抛的桩绝不出现在这条路径上。
     */
    verifier: deps.verifier ?? null,
    /** 注入点：测试用内存 registry，生产用 `registry.mjs` 的缓存适配器 */
    registryFactory: deps.registryFactory ?? null,
    /**
     * 注入点：出网。生产走内建 `fetch`（`src/download.mjs` 的默认值）。
     * 🔴 与 `verifier` 一样**没有逃生口**：不给就是真出网，
     *    不存在「测试忘了注入所以静默不出网」这种状态 ——
     *    那会让「--offline 有没有被绕过」这个问题看起来被回答了，其实没有。
     */
    fetchImpl: deps.fetchImpl ?? null,
    /** 注入点：埋点。生产是 `telemetry.record` */
    record: deps.record ?? null,
    /**
     * 注入点：标准输入。**只有 `install --all` 的 §3 全量确认用它**。
     * 🔴 交互与否的判据是 `isTTY`，不是「有没有 stdin」—— 管道进来的 stdin
     *    照样可读，但那不是「用户正坐在终端前逐条看名单」。
     */
    stdin: deps.stdin ?? process.stdin,
    /**
     * 预检的扫描预算，直接喂给 `precheckTarget({ scan })`。
     * 🔴 没给旋钮时这两项是 `undefined` —— `normalizeScan` 把 `undefined` 读成
     *    「用默认值」。**不要**在这里填上默认值：填了以后默认值就有了两个出处
     *    （这里一份、target.mjs 一份），改一处漏一处的那种漂移正好发生在
     *    「上限是多少」这个用户会照着报错去调的数上。
     */
    scan: Object.freeze({ maxDepth: globals.scanMaxDepth, maxDirs: globals.scanMaxDirs }),
  });
  return ctx;
}

/** 真验签器（内置信任根）。🔴 懒加载：`list` / `--help` 不该为了解析信任根付出代价。 */
export async function realVerifier() {
  const { createSigstoreVerifier, loadBuiltinTrustedRoot } = await import('../sigstore.mjs');
  return createSigstoreVerifier({ trustedRoot: loadBuiltinTrustedRoot() });
}
