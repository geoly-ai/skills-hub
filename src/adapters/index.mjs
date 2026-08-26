// 客户端 adapter —— 规范见 04-install.md §2.3 / §3.3、10-open-questions.md Q12
//
// 🔴 adapter 是接口不是路径表。这里给出的是**数据 + 派生函数**：数据必须可枚举
// （`list` 与预检要遍历它），派生函数保证「target 路径」只有一处定义 ——
// `.gitignore` 模式、post-install 提示、预检的 base 全都从同一份数据派生，
// 免得像 M0 v8 那样在两个地方各写一遍、其中一处写错（v8 把项目级忽略写成了根上的
// `/.geoly/`，实际应该是 `/.claude/skills/.geoly/`）。
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { statSync } from 'node:fs';

/** 真实门记录的身份登记。外面拿不到这个引用，也就伪造不出成员资格。 */
const REAL_GATES = new WeakSet();

/**
 * 目录存不存在。
 * 🔴 只有 ENOENT/ENOTDIR 算「不存在」。**EACCES 不能当成不存在** ——
 * 那会让一个存在但读不了的目录被计划成 `willCreate: true` 进 selected，
 * 于是 `--create-missing` 会去「创建」一个已经在那儿的目录。
 * 存在但看不清 → 按「存在」算，后面的 target 预检会用 `not-writable` 拦住。
 */
const DIR_MISSING = 'missing';
const DIR_PRESENT = 'present';
const DIR_CONFLICT = 'conflict'; // 路径被占了，但不是目录

const probeDir = (p) => {
  try {
    return statSync(p).isDirectory() ? DIR_PRESENT : DIR_CONFLICT;
  } catch (err) {
    // 🔴 只有 ENOENT/ENOTDIR 算「不存在」。EACCES 不能当成不存在 ——
    // 那会让一个存在但读不了的目录被计划成 `willCreate: true`，
    // 于是 `--create-missing` 会去「创建」一个已经在那儿的目录。
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? DIR_MISSING : DIR_PRESENT;
  }
};

const isDir = (p) => probeDir(p) === DIR_PRESENT;

/** 🔴 门记录必须**深**冻结：浅冻结挡不住 `gate('global').status = 'passed'`。 */
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const SCOPES = Object.freeze(['global', 'project']);

/** 状态目录名。target 内的一切 per-target 状态都在这下面（§3.2）。 */
export const STATE_DIR = '.geoly';

// ── Q12 门 ───────────────────────────────────────────────────────────────────

/**
 * 🔴 Q12 是 **M1 的阻塞门**：`<target>/.geoly/` 会不会被客户端误当成 skill。
 * 「未通过的 client 不得合入 adapter，直接标为不支持」（00-decisions.md §5 第 1 条）。
 *
 * 但「未通过」有两种，必须分开，否则要么谎称测过、要么把 M1 全卡死：
 *
 *   `passed`      —— 有实测证据，enabled。
 *   `pending`     —— **门还没跑过这个组合**。可枚举、可 `list`，但默认不允许安装。
 *                    这不是「测了没过」，所以不能写成 unsupported —— 那会让「跑完门」
 *                    这件事从待办变成一个看起来已经有结论的既成事实。
 *   `unsupported` —— 实测不通过，或结构上就没有读者。**永远不允许**，不因 flag 放行。
 *
 * ⚠️ 每一条都必须带 `evidence`（指向 docs/m1/00-gates.md 的具体读数）。
 * 没有 evidence 的 `passed` 就是伪造证据 —— 宁可留 `pending`。
 *
 * 🔴 门要**绑定具体客户端版本**（Q12 明文），升级客户端要复测。
 * `clientVersion` 为 null 表示「门还没跑，自然也没有版本可绑」。
 */
export const GATE_PASSED = 'passed';
export const GATE_PENDING = 'pending';
export const GATE_UNSUPPORTED = 'unsupported';

/**
 * 🔴 `planTargets` 的**测试注入缝**，Symbol key（同 `target.mjs` 的 `TEST_DEPS`）。
 * 只用来在门尚未闭合时测「门过了之后」的分支；`assertPlanOk` 会拒绝被注入过的计划。
 */
export const TEST_GATES = Symbol('adapters.planTargets.testGates');

/**
 * 🔴 同 `target.mjs` 的 `CLEAN_PRECHECKS`：「这份计划是按真实门表算的」这个事实
 * 存在模块私有的 WeakSet 里，不存在计划对象的字段里 ——
 * 一个 `plan.gatesOverridden = false` 就能把公开字段那道边界拆掉。
 */
const CLEAN_PLANS = new WeakSet();

const ADAPTER_DEFS = [
  {
    client: 'claude',
    dirName: '.claude',
    envHome: null,
    gates: {
      global: {
        status: GATE_PENDING,
        clientVersion: null,
        evidence:
          'docs/m1/00-gates.md Gate 1 只记录了 codex 一端的 catalog 读数（5→6 正对照）；' +
          'claude 端没有自己的 catalog 读数，Q12 对该组合尚未执行',
      },
      project: {
        status: GATE_PENDING,
        clientVersion: null,
        evidence: 'docs/m1/00-gates.md Gate 1 未覆盖任何项目级 scope',
      },
    },
    postInstallHint: '重启 Claude Code，或在会话里跑 /skills 让它重扫技能目录',
  },
  {
    client: 'cursor',
    dirName: '.cursor',
    envHome: null,
    gates: {
      global: {
        status: GATE_PENDING,
        clientVersion: null,
        evidence: 'docs/m1/00-gates.md Gate 1 未覆盖 cursor 端（无 catalog 读数、无二进制核对）',
      },
      project: {
        status: GATE_PENDING,
        clientVersion: null,
        evidence: 'docs/m1/00-gates.md Gate 1 未覆盖任何项目级 scope',
      },
    },
    postInstallHint: '重启 Cursor（技能目录在启动时扫描）',
  },
  {
    client: 'codex',
    dirName: '.codex',
    // gates 里就是用 $CODEX_HOME 指到临时目录测的，adapter 要认同一个变量，
    // 否则「门测的路径」与「实际安装的路径」不是同一个，门就白测了。
    envHome: 'CODEX_HOME',
    gates: {
      global: {
        // 🔴 **这一格的证据是完整的**：测量有效（正对照 5→6）、结论为「未被识别」、
        // 且版本号已确认为 codex-cli 0.147.0（同一台机器、同一个未变更的安装，
        // 事后从二进制读出；期间没有升级过）。
        //
        // 它仍留在 pending，**卡的不是证据，是范围决策**：Q12 要求四端 × 两个 scope，
        // 而 claude / cursor / 全部项目级都还没测。「只启用一端就发车」是排期上的取舍，
        // 得由人来拍，不该由这张表自己决定。
        // 🔴 拍板走「先启用 codex/global」时：把 status 改成 GATE_PASSED、
        //    删掉 blockedOn 即可，clientVersion 已经在这里了。
        status: GATE_PENDING,
        blockedOn: 'scope-decision-pending',
        clientVersion: 'codex-cli 0.147.0',
        evidence:
          'docs/m1/00-gates.md Gate 1：$CODEX_HOME/skills 下放完整 .geoly fixture' +
          '（含 lock.db/-wal/-shm、tx-1/stage、attic/1）后 catalog_entries 仍为 6，' +
          '未被识别为 skill、无报错、不影响路由；同一次测量用真 skill 做正对照 5→6，证明测量有效。' +
          '版本 codex-cli 0.147.0（事后从同一个未变更的安装读出）',
      },
      project: {
        status: GATE_PENDING,
        clientVersion: null,
        evidence: 'docs/m1/00-gates.md Gate 1 只测了 $CODEX_HOME（全局），未覆盖 <repo>/.codex/skills',
      },
    },
    postInstallHint: '新开一个 codex 会话（catalog 在启动时构建）',
  },
  {
    client: 'agents',
    dirName: '.agents',
    envHome: null,
    gates: {
      // 🔴 这一端被标 unsupported 的理由不是「.geoly 被误当成 skill」，
      // 而是**这条路径根本没有读者** —— 装了也不会被加载。
      // 把没有读者的目录写满文件是纯粹的副作用：占盘、进 git、被 `git clean` 误删，
      // 却换不来任何一个 skill 生效。所以按 M0「未通过的客户端不得合入 adapter」处理。
      global: {
        status: GATE_UNSUPPORTED,
        reason: 'no-reader',
        clientVersion: null,
        evidence:
          "docs/m1/00-gates.md Gate 1 附带发现：用固定串核对（grep -F '.agents/skills'）" +
          '两个客户端二进制，命中数为 0 —— 该路径在当前版本下没有任何读者。' +
          "⚠️ 早先用 grep '\\.agents' 得到过假阳性，匹配到的是 .claude/agents（子代理目录），" +
          '与 skill 路由无关；核对路径一律用 -F',
      },
      project: {
        status: GATE_UNSUPPORTED,
        reason: 'no-reader',
        clientVersion: null,
        evidence: '同 global：`.agents/skills` 无读者，项目级同理（且项目级 scope 本身也未过 Q12）',
      },
    },
    postInstallHint: null,
  },
];

/** 所有 client 名，按定义顺序（报告与 `list` 的输出顺序要稳定）。 */
export const CLIENTS = Object.freeze(ADAPTER_DEFS.map((d) => d.client));

// ── adapter 接口（§2.3） ─────────────────────────────────────────────────────

function makeAdapter(def) {
  const configRoot = ({ home = homedir(), env = process.env } = {}) => {
    if (def.envHome && env[def.envHome]) {
      const v = env[def.envHome];
      if (!isAbsolute(v)) throw new Error(`$${def.envHome} 必须是绝对路径：${v}`);
      return v;
    }
    return join(home, def.dirName);
  };

  /**
   * target 路径。
   * - `global`：`<configRoot>/skills`
   * - `project`：`<projectRoot>/<dirName>/skills`
   *   🔴 项目级**不看 `$CODEX_HOME`** —— 它是「用户的 codex 家目录」，
   *   与「这个仓库里的 codex 目录」是两件事。
   */
  const root = ({ scope, home = homedir(), env = process.env, projectRoot } = {}) => {
    assertScope(scope);
    if (scope === 'global') return join(configRoot({ home, env }), 'skills');
    if (!projectRoot) throw new Error(`scope=project 需要 projectRoot（client=${def.client}）`);
    if (!isAbsolute(projectRoot)) throw new Error(`projectRoot 必须是绝对路径：${projectRoot}`);
    return join(projectRoot, def.dirName, 'skills');
  };

  /**
   * 🔴 「不存在」不是失败（§2.3）：默认目标 = 本机已存在的 client 目录，
   * 不存在的如实报告成 `skipped`，只有 `--create-missing` 才创建。
   */
  const exists = (opts = {}) => isDir(configRoot(opts));

  /**
   * 🔴 这个 **scope** 的客户端目录在不在。
   * global 看 `<configRoot>`，project 看 `<projectRoot>/<dirName>`。
   * ⚠️ 项目级绝不能拿 `$HOME/.claude` 来判 —— 那是另一台机器上的另一件事，
   * 拿它当判据会让「仓库里根本没有 .claude/」被判成「有」，或反过来。
   */
  const scopeRootDir = (opts = {}) => {
    assertScope(opts.scope);
    if (opts.scope === 'global') return configRoot(opts);
    const { projectRoot } = opts;
    if (!projectRoot) throw new Error(`scope=project 需要 projectRoot（client=${def.client}）`);
    return join(projectRoot, def.dirName);
  };

  /** `missing` / `present` / `conflict`（路径被普通文件之类占了）。 */
  const scopeRootState = (opts = {}) => probeDir(scopeRootDir(opts));

  const scopeRootExists = (opts = {}) => scopeRootState(opts) === DIR_PRESENT;

  const targetExists = (opts) => isDir(root(opts));

  const gate = (scope) => {
    assertScope(scope);
    return def.gates[scope]; // 已深冻结，调用方改不了（见 deepFreeze）
  };

  /**
   * 这个 scope 能不能装。
   * 🔴 **只有 `passed` 返回 true**。没有任何参数能放行 `pending` 或 `unsupported` ——
   * M0 §5 的原话是「未通过的客户端不得合入 adapter」，一个 `--allow-pending`
   * 就把这条门变成了建议。`pending` 是**门元数据**（供 `list`、报告、以及跑完门后启用），
   * 不是安装绕过机制。要装，就先把门跑完并把结果写进 `docs/m1/00-gates.md`。
   */
  const supports = (scope) => gate(scope).status === GATE_PASSED;

  /** 布局：target 里的状态目录长什么样（§3.2）。预检要遍历它。 */
  const layout = (opts) => {
    const target = root(opts);
    const state = join(target, STATE_DIR);
    return {
      target,
      state,
      // 🔴 这些路径必须逐个 lstat 无跟随（§3.4），所以要能被枚举出来
      lockDb: join(state, 'lock.db'),
      lockWal: join(state, 'lock.db-wal'),
      lockShm: join(state, 'lock.db-shm'),
      generation: join(state, 'generation'),
      ledger: join(state, 'ledger.json'),
      auditSeq: join(state, 'audit-seq'),
      journalDir: join(state, 'journal'),
      atticDir: join(state, 'attic'),
      quarantineDir: join(state, 'quarantine'),
      auditArchiveDir: join(state, 'audit-archive'),
      repairIntent: join(state, 'repair-intent.json'),
      auditArchiveIntent: join(state, 'audit-archive-intent.json'),
    };
  };

  const postInstallHint = () => def.postInstallHint;

  /**
   * 预检用的**可信 base**（§3.4 的 symlink 链检查需要它）。
   * 🔴 不能从 `/` 开始查：macOS 的 `/var` 本身是系统 symlink，从根查会把
   * 每个临时目录都判成假阳性。规格要防的是「我们管辖范围之内被重定向」。
   * - global：`$HOME`（或 `$CODEX_HOME` 的父）
   * - project：`projectRoot`
   */
  const trustedBase = ({ scope, home = homedir(), env = process.env, projectRoot } = {}) => {
    assertScope(scope);
    if (scope === 'project') return projectRoot;
    // 🔴 base 取 configRoot 的**父**，不是 configRoot 本身：
    //   ① 这样 `<configRoot>` 这一层本身是不是 symlink 也会被检查到
    //      （取 configRoot 当 base 等于先 realpath 掉它、把这一层放过去）；
    //   ② `$CODEX_HOME` 指向一个尚未创建的目录时，base 仍然存在 ——
    //      否则 `assertNoSymlinkInChain` 会在 realpath(base) 上吃 ENOENT，
    //      把「目录还没建」误报成「路径链上有 symlink」，`--create-missing` 直接没法用。
    return def.envHome && env[def.envHome] ? dirname(configRoot({ home, env })) : home;
  };

  /** 项目级 `.gitignore` 该忽略的**adapter 派生的实际路径**（§3.3）。 */
  const gitignorePattern = () => `/${def.dirName}/skills/${STATE_DIR}/`;

  return Object.freeze({
    client: def.client,
    dirName: def.dirName,
    envHome: def.envHome,
    configRoot,
    root,
    exists,
    scopeRootExists,
    scopeRootState,
    scopeRootDir,
    targetExists,
    layout,
    supports,
    gate,
    postInstallHint,
    trustedBase,
    gitignorePattern,
  });
}

function assertScope(scope) {
  if (!SCOPES.includes(scope)) throw new Error(`未知 scope：${scope}（只有 ${SCOPES.join(' / ')}）`);
}

/**
 * 🔴 门表的两条不变量，在模块加载时就查死，不留到运行期：
 *
 * ① **`passed` 必须带 `clientVersion`**。Q12 明文「门要绑定具体客户端版本，
 *    adapter 或客户端升级时复测」。一条没有版本号的 `passed` 是没法复测的 ——
 *    没人知道它当初测的是哪一版，于是「升级后复测」这条规则永远触发不了。
 * ② **status 只能是那三个之一**。拼错一个字母就会同时躲过 `passed` 的放行判断
 *    与两个拒绝分支，落成静默放行。
 */
export function assertGateInvariants(defs) {
  const valid = new Set([GATE_PASSED, GATE_PENDING, GATE_UNSUPPORTED]);
  for (const d of defs) {
    for (const scope of SCOPES) {
      const g = d.gates[scope];
      if (!g) throw new Error(`adapter ${d.client} 缺 ${scope} 的门记录`);
      if (!valid.has(g.status)) throw new Error(`adapter ${d.client}/${scope} 的门状态非法：${g.status}`);
      if (!g.evidence) throw new Error(`adapter ${d.client}/${scope} 的门记录缺 evidence`);
      if (g.status === GATE_PASSED && !g.clientVersion) {
        throw new Error(
          `adapter ${d.client}/${scope} 标了 passed 却没有 clientVersion —— ` +
            'Q12 要求门绑定具体客户端版本，否则升级后无从复测',
        );
      }
    }
  }
}
assertGateInvariants(ADAPTER_DEFS);
ADAPTER_DEFS.forEach(deepFreeze);
// 登记真实门记录的身份（在冻结之后，登记的就是最终那批对象）
for (const d of ADAPTER_DEFS) for (const s of SCOPES) REAL_GATES.add(d.gates[s]);

const ADAPTERS = Object.freeze(
  Object.fromEntries(ADAPTER_DEFS.map((d) => [d.client, makeAdapter(d)])),
);

/** 🔴 adapter 表必须可枚举 —— `list` 与预检要遍历它。 */
export function listAdapters() {
  return CLIENTS.map((c) => ADAPTERS[c]);
}

export function getAdapter(client) {
  const a = ADAPTERS[client];
  if (!a) throw new Error(`未知 client：${client}（已知：${CLIENTS.join(', ')}）`);
  return a;
}

/**
 * 从一批 adapter def 造出「客户端 → adapter」的表。
 *
 * 🔴 导出它，是为了让测试能用**合成门表**造一套 adapter，非空地验证
 * `supports()` / `gateMatrix()` / `enabledCombos()` 这三个函数**确实是从门状态推出来的**，
 * 而不是碰巧恒返回 false / 空数组 —— 真门表现在一个组合都没闭合，
 * 拿它测这三个函数等于在空集上断言。
 *
 * ⚠️ 合成 adapter 的门记录**不会**进 `REAL_GATES`，因此它们授权不了任何安装。
 */
export function buildAdapters(defs) {
  assertGateInvariants(defs);
  const list = defs.map((d) => makeAdapter(deepFreeze(d)));
  return Object.freeze({
    clients: Object.freeze(list.map((a) => a.client)),
    list: Object.freeze(list),
  });
}

/** 全部 client × scope 组合及其门状态。给 `list`、给报告、给测试断言。 */
export function gateMatrix(adapters = listAdapters()) {
  const out = [];
  for (const a of adapters) {
    for (const scope of SCOPES) {
      const g = a.gate(scope);
      out.push(Object.freeze({
        client: a.client,
        scope,
        status: g.status,
        reason: g.reason ?? null,
        blockedOn: g.blockedOn ?? null,
        clientVersion: g.clientVersion ?? null,
        evidence: g.evidence,
        enabled: g.status === GATE_PASSED,
      }));
    }
  }
  return Object.freeze(out);
}

/** 允许安装的组合。🔴 只有 Q12 已过的 —— 没有开关能扩大这个集合。 */
export function enabledCombos(adapters = listAdapters()) {
  return Object.freeze(gateMatrix(adapters).filter((r) => r.status === GATE_PASSED));
}

/**
 * 把 client + scope 解析成一个完整的 target 描述。
 *
 * 🔴 门在这里**强制**，且**没有放行开关**。
 * 报错必须说清是哪一档、依据是什么 —— 否则用户只看到「不支持」，
 * 分不出「测过不行」与「还没测」，也就不知道该去跑门还是该换客户端。
 *
 * ⚠️ 要在门跑完之前拿到路径（做诊断、写门本身的 fixture），
 * 用 `getAdapter(c).root(...)` / `.layout(...)` —— 它们不判门，因为它们不安装。
 */
export function resolveTarget({
  client,
  scope,
  home = homedir(),
  env = process.env,
  projectRoot,
} = {}) {
  const adapter = getAdapter(client);
  assertScope(scope);
  const g = adapter.gate(scope);
  assertGateAllows(g, `${client}/${scope}`);
  return describeTarget(adapter, { scope, home, env, projectRoot }, g.status);
}

/**
 * 门状态的**分类**（纯函数，无授权语义）。
 *
 * 🔴 它**不是**授权函数：给它一个 `{status:'passed'}` 字面量，它当然会说 `allow` ——
 * 那只是在回答「这个 status 属于哪一档」，不是在批准安装。
 * 真正的放行还要求那条门记录**来自本模块深冻结的门表**（见 `assertGateAllows`）。
 *
 * 抽出来是为了能非空地测每一支：门表现在一个组合都没闭合，
 * 拿真门表去测 `passed` 分支等于测了个空集。
 */
export function classifyGate(g) {
  const status = g?.status;
  if (status === GATE_PASSED) return { decision: 'allow', status };
  if (status === GATE_UNSUPPORTED) {
    return {
      decision: 'deny-unsupported',
      status,
      detail: `标为不支持（reason=${g.reason}）：${g.evidence}。这是实测结论/结构事实，没有开关能放行`,
    };
  }
  // 🔴 默认拒绝：`pending` 与任何**意料之外的 status** 都走这一支。
  // 白名单式分类才不会因为一个拼错的字面量变成静默放行。
  return {
    decision: 'deny-gate-open',
    status,
    detail:
      `Q12 阻塞门未闭合（status=${status}${g?.blockedOn ? `, blockedOn=${g.blockedOn}` : ''}）：` +
      `${g?.evidence}。跑完门并把结果写进 docs/m1/00-gates.md（含被测客户端版本）后改为 passed。` +
      '🔴 没有 --allow-pending 这种开关 —— 那会把阻塞门降级成建议',
  };
}

/**
 * 🔴 **唯一**的放行判据，模块私有。两个条件缺一不可：
 *   ① 分类是 `allow`；
 *   ② 这条门记录**确实来自本模块的门表**（WeakSet 成员）——
 *      否则外面伪造一个 `{status:'passed'}` 就能授权自己。
 */
function assertGateAllows(g, label) {
  if (!REAL_GATES.has(g)) {
    throw new Error(`${label} 的门记录不是来自 adapter 门表，拒绝（不接受外部构造的门记录）`);
  }
  const c = classifyGate(g);
  if (c.decision === 'allow') return true;
  throw new Error(`${label} ${c.detail}`);
}


/**
 * target 描述的**唯一**构造点。`resolveTarget` 与 `planTargets` 共用它 ——
 * 两处各拼一份迟早会漂（`base` 的取法尤其容易只改一边）。
 */
function describeTarget(adapter, opts, gateStatus, extra = {}) {
  const { home, env } = opts;
  return Object.freeze({
    client: adapter.client,
    scope: opts.scope,
    gate: gateStatus,
    configRoot: adapter.configRoot({ home, env }),
    base: adapter.trustedBase(opts),
    ...adapter.layout(opts),
    adapter,
    ...extra,
  });
}

/**
 * 把「这次命令要装到哪些 target」算出来。
 *
 * 🔴 §2.3 的两条语义必须分开，否则「跳过」会掩盖「用户明确点名了一个装不了的端」：
 *
 * - **默认目标**（没传 `--clients`）= 本机**已存在**的全部 client 目录。
 *   目录不存在 → `skipped: missing-dir`（如实报告，**不是失败**）；
 *   门没过 → `skipped: gate-<status>`。
 * - **显式 `--clients`** → 任一项装不了都是**硬错误**，不静默降级成 skipped。
 *   （「兼容性不是部分失败」。）
 *
 * `--create-missing` 只影响「目录不存在」这一条，**影响不了门**。
 */
export function planTargets(opts = {}) {
  const {
    clients = null,
    scope = 'global',
    home = homedir(),
    env = process.env,
    projectRoot,
    createMissing = false,
  } = opts;
  assertScope(scope);
  // 🔴 测试注入缝，Symbol key（同 target.mjs 的 TEST_DEPS，理由一样）：
  // 门表现在**一个组合都没闭合**，不注入就没法测「门过了之后」的那几条分支
  // （missing-dir / willCreate / selected）—— 那正是门一闭合就会立刻走到的路径。
  // 结果里记 `gatesOverridden`，`assertPlanOk` 会拒绝放行被注入过的计划。
  const gateOverride = opts[TEST_GATES] ?? null;
  const gateOf = (adapter, sc) =>
    gateOverride?.[`${adapter.client}/${sc}`] ?? adapter.gate(sc);
  const explicit = clients != null;
  const list = explicit ? clients : CLIENTS;
  const selected = [];
  const skipped = [];
  const errors = [];

  for (const client of list) {
    const adapter = getAdapter(client); // 未知 client 直接抛，显式与否都一样
    const g = gateOf(adapter, scope);
    const c = classifyGate(g);
    if (c.decision !== 'allow') {
      const why = `${client}/${scope} 的 Q12 门是 ${g.status}${g.reason ? `（${g.reason}）` : ''}：${g.evidence}`;
      if (explicit) errors.push(why);
      else skipped.push({ client, scope, reason: `gate-${g.status}`, message: why });
      continue;
    }
    // 🔴 门过了才谈目录存不存在 —— 反过来会让「目录碰巧不存在」把门的结论盖掉
    // 🔴 判的是**这个 scope 的**目录：project 看 `<repo>/.claude`，不是 `$HOME/.claude`
    const scopeOpts = { scope, home, env, projectRoot };
    const dir = adapter.scopeRootDir(scopeOpts);
    const state = adapter.scopeRootState(scopeOpts);

    // 🔴 「被普通文件（或别的非目录）占了」既不是 missing 也不是 present。
    // 当成 missing 会让 `--create-missing` 去「创建」一个已经被占的路径，
    // 结果必然 ENOTDIR —— 而且是在事务中途炸，不是在预检时。
    // 这是**硬错误**，`--create-missing` 也解决不了：得先由人把那个文件挪走。
    if (state === DIR_CONFLICT) {
      const why = `${client}/${scope} 的客户端目录 ${dir} 被一个非目录占用（--create-missing 解决不了，需人工挪走）`;
      if (explicit) errors.push(why);
      else skipped.push({ client, scope, reason: 'dir-conflict', message: why });
      continue;
    }

    const dirExists = state === DIR_PRESENT;
    if (!dirExists && !createMissing) {
      const why = `${client}/${scope} 的客户端目录 ${dir} 不存在`;
      if (explicit) errors.push(`${why}（要创建请传 --create-missing ${client}）`);
      else skipped.push({ client, scope, reason: 'missing-dir', message: why });
      continue;
    }
    selected.push(describeTarget(adapter, scopeOpts, g.status, { willCreate: !dirExists }));
  }
  // 🔴 「兼容性不是部分失败」：显式点名里有一项装不了 → **整批不执行**。
  // 仍然返回 `wouldSelect` 供报错时展示，但 `selected` 必须是空的 ——
  // 调用方忘了看 `errors` 时，最坏结果是什么都没装，而不是装了一半。
  const ok = errors.length === 0;
  const clean = gateOverride === null;
  const plan = Object.freeze({
    ok,
    selected: Object.freeze(ok ? selected : []),
    wouldSelect: Object.freeze(selected),
    skipped: Object.freeze(skipped.map((s) => Object.freeze(s))),
    errors: Object.freeze(errors),
    explicit,
    gatesOverridden: !clean, // 给人看的；放行判据是 CLEAN_PLANS
  });
  if (clean) CLEAN_PLANS.add(plan);
  return plan;
}

/** 计划有硬错误就抛，报出全部。 */
export function assertPlanOk(plan) {
  if (!CLEAN_PLANS.has(plan)) {
    throw new Error(
      '这份目标计划不是按真实门表算的（注入了 TEST_GATES，或对象被替换/篡改过），不得用来放行安装',
    );
  }
  if (plan.ok) return plan;
  const err = new Error(
    `目标解析失败（${plan.errors.length} 项）：\n` +
      plan.errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n'),
  );
  err.errors = plan.errors;
  throw err;
}

// ── 项目级 .gitignore（§3.3） ────────────────────────────────────────────────

/**
 * 🔴 忽略的是 **adapter 派生的实际路径**（`/.claude/skills/.geoly/`），
 * **不是**根上的 `/.geoly/` —— M0 §3.3 明确注明 v8 写错过这一点。
 * 根上那条既挡不住真正的状态目录，又会误伤别的东西。
 */
export function gitignorePatternsFor(clients = CLIENTS) {
  return clients.map((c) => getAdapter(c).gitignorePattern());
}

/** `git clean -xfd` 的后果必须写进 README / 提示里（§3.3、Q12）。 */
export const GIT_CLEAN_WARNING =
  '⚠️ `git clean -xfd` 会删掉整个 `.geoly/` —— 不只是进行中的事务状态，' +
  '**还包括本地审计历史**（live `audit` 与 `audit-archive/`）。' +
  '审计历史一旦被清，event_id 序列会重新开始，这是规范承认的「放弃本地 audit」边界，' +
  '但它不可恢复。项目级安装务必先把下面几条加进 `.gitignore`。';
