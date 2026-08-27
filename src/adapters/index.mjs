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
 * 🔴 `pending` 的**原因**必须是可枚举的常量，不能是自由文本。
 *
 * Q12 的历史教训是「一个不动的读数被当成了『没影响』」；它的孪生兄弟是
 * **「缺证据」被写成「只是还没拍板」** —— 两者都长得像「快好了」，代价却差一个数量级：
 * 缺决策拍个板就能开，缺证据要重新架一次实验。
 *
 * 所以这里把两类分开，并在模块加载期用 `clientVersion` 的有无**机械地**校验：
 * 证据完整的那一类**必须**带版本号，缺证据的那一类**必须**不带 ——
 * 谁也没法靠改一行 evidence 文案把自己挪到另一类里去。
 */
/** 证据完整，卡的是「要不要把这一格纳入发车范围」这个人来拍的取舍。 */
export const BLOCKED_ON_SCOPE_DECISION = 'scope-decision-pending';
/** 🔴 本机跑不起这个客户端，Q12 要求的运行时验收**没有做过**。 */
export const BLOCKED_ON_NO_RUNTIME = 'runtime-evidence-unavailable';

/** 带这些 blocker 的格子「证据完整」 —— 必须有 clientVersion。 */
const EVIDENCE_COMPLETE_BLOCKERS = new Set([BLOCKED_ON_SCOPE_DECISION]);
/** 带这些 blocker 的格子「缺证据」 —— 必须没有 clientVersion，否则就是在冒充测过。 */
const EVIDENCE_MISSING_BLOCKERS = new Set([BLOCKED_ON_NO_RUNTIME]);
const KNOWN_BLOCKERS = new Set([...EVIDENCE_COMPLETE_BLOCKERS, ...EVIDENCE_MISSING_BLOCKERS]);

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
      // 🔴 两个 scope 都是实测通过（2026-08-26，claude-code 2.1.246）。
      // 保护机制是**扫描不递归**：`<target>/` 下只看一层。深度对照证明了这一点 ——
      // 把一个有效 skill 放到 `<target>/probe3/tx-1/stage/<n>/SKILL.md`（与 `.geoly`
      // 里 staged skill 完全同深、且目录名不带点），读数**纹丝不动**（16 → 16）。
      //
      // ⚠️ **由此得到一条硬约束**：claude **不过滤点目录**（实测把
      // `<target>/.geoly/SKILL.md` 当成了名为 `.geoly` 的 skill 加载，15 → 16）。
      // 所以 §3.2 的布局**永远不得**在 `<target>/.geoly/SKILL.md` 放文件 ——
      // 这一格的通过完全建立在「.geoly 顶层没有 SKILL.md」之上。
      global: {
        status: GATE_PASSED,
        clientVersion: 'claude-code 2.1.246',
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 claude/global：读数取 `claude -p ' +
          '--output-format stream-json` 首条 system/init 事件的 skills 数组长度。' +
          '深度 1 正对照 15 → 16（且 canary 名恰好出现 1 次，证明测量敏感）；' +
          '放入完整 .geoly fixture（lock.db/-wal/-shm、generation、ledger.json、' +
          'audit-seq、journal/1.json、tx-1/stage/<n>/SKILL.md、attic/1/<n>.tar）后仍为 16，' +
          'staged/attic canary 在 catalog 与**真实发往模型的请求体**里命中数均为 0，' +
          '其余 skill 逐名一致，退出码 0、stderr 与基线逐字节相同',
      },
      project: {
        status: GATE_PASSED,
        clientVersion: 'claude-code 2.1.246',
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 claude/project：同 global 的协议，' +
          'target 取 <projectRoot>/.claude/skills。正对照 15 → 16，' +
          '加 .geoly fixture 后仍为 16，canary 在 catalog 与请求体命中数均为 0，退出码 0',
      },
    },
    postInstallHint: '重启 Claude Code，或在会话里跑 /skills 让它重扫技能目录',
  },
  {
    client: 'cursor',
    dirName: '.cursor',
    envHome: null,
    gates: {
      // 🔴 这两格**没有任何运行时证据**，而且静态分析**指向失败**，不是中性的「还没测」。
      //
      // 本机测不了：cursor-agent 2026.02.27-e7d2ef6 装了但未认证（跑任何命令都直接
      // `Authentication required`，登录要交互式浏览器 OAuth），Cursor IDE 没装。
      //
      // ⚠️ 读它的 bundle（只读）看到的机制是**两道保护都没有**：
      // Agent Skills 加载器逐级 readdir **递归**到深度 10，遇到任何 `SKILL.md` 就收，
      // 目录排除集只有 {node_modules,.git,.svn,.hg,__pycache__,.cache,dist,build,.next,.nuxt}
      // —— 既没有 `.geoly`，也没有任何点目录过滤。而 `.geoly/tx-1/stage/<n>/SKILL.md`
      // 在 target 下只有 3 层。**预判：一旦能跑，它很可能会把 staged skill 当成真 skill 收进去。**
      //
      // 🔴 但预判不是实测，所以**不标 unsupported** —— Q12 要的是运行时验收。
      //    同样**不因为「看起来八成会挂」就当它已经有结论**：这一格要的是把客户端跑起来。
      global: {
        status: GATE_PENDING,
        blockedOn: BLOCKED_ON_NO_RUNTIME,
        clientVersion: null,
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 cursor/global：**本机无法测量** —— ' +
          'cursor-agent 2026.02.27-e7d2ef6 已安装但未认证（需交互式浏览器 OAuth），' +
          'Cursor IDE 未安装，因此没有任何运行时读数。' +
          '⚠️ 静态分析**预判失败**：其 Agent Skills 加载器递归到深度 10 收集 SKILL.md，' +
          '排除集不含 .geoly 也不过滤点目录，而 .geoly/tx-1/stage/<n>/SKILL.md 只有 3 层。' +
          '要闭合这一格需要：登录 cursor-agent（或装 Cursor IDE）后重跑逐格协议',
      },
      project: {
        status: GATE_PENDING,
        blockedOn: BLOCKED_ON_NO_RUNTIME,
        clientVersion: null,
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 cursor/project：同 global —— ' +
          '本机跑不起 cursor 客户端，无运行时读数；静态分析同样预判失败（递归扫描、不过滤点目录）',
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
      // 🔴 两个 scope 都是实测通过（2026-08-26，codex-cli 0.147.0）。
      // 保护机制与 claude **不是同一个**：codex 的扫描**是递归的**（深度对照证明：
      // 同深度、非点名目录下的 skill 被收了，6 → 7），挡住 `.geoly` 的是**点目录过滤**
      // （实测 `<target>/.geoly/SKILL.md` 不被加载）。
      // ⚠️ 也就是说两端各只靠**一道**保护，且是不同的那一道 —— 任一端改了扫描策略都要复测。
      global: {
        status: GATE_PASSED,
        clientVersion: 'codex-cli 0.147.0',
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 codex/global：读数取 `codex debug ' +
          'prompt-input` 渲染的模型可见 prompt 里 <skills_instructions> 的条目数。' +
          '深度 1 正对照 5 → 6（canary 名恰好 1 次）；**同深度正对照** 6 → 7 ' +
          '（probe3/tx-1/stage/<n>/SKILL.md 被收，证明扫描能到达 .geoly 里 staged skill 的深度）；' +
          '再放入完整 .geoly fixture 后仍为 7，canary 命中 0，其余 skill 逐名一致，' +
          '退出码 0、stderr 0 字节。' +
          '⚠️ codex 是离线渲染，没有「请求体」这件产物 —— catalog 与模型可见内容是同一份，' +
          'claude 那边的请求体证据不外推到这里。' +
          '⚠️ 覆盖边界：加载 + 路由输入，未做端到端的 skill 调用验证',
      },
      project: {
        status: GATE_PASSED,
        clientVersion: 'codex-cli 0.147.0',
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 codex/project：同 global 的协议，' +
          'target 取 <projectRoot>/.codex/skills（cwd 下的 .codex/skills 确实是 codex 的 skill root）。' +
          '正对照 5 → 6、同深度正对照 6 → 7、加 .geoly fixture 后仍为 7，canary 命中 0，退出码 0',
      },
    },
    postInstallHint: '新开一个 codex 会话（catalog 在启动时构建）',
  },
  {
    client: 'agents',
    dirName: '.agents',
    envHome: null,
    gates: {
      // 🔴 **这一端原先标的 `unsupported / no-reader` 是错的，已推翻。**
      //
      // 原判据是「用固定串 `grep -F '.agents/skills'` 核对二进制，命中 0 → 没有读者」。
      // 假阴性：那条路径是**运行时 join 拼出来的**，二进制里根本不存在这个连续子串。
      // 实测（2026-08-26）：codex-cli 0.147.0 把 `$HOME/.agents/skills` 与
      // `<cwd>/.agents/skills` 都当作 skill root 加载 —— 正对照 5 → 6，
      // 且它渲染的 prompt 里直接列出了这两个 root。
      //
      // ⚠️ **「二进制里搜不到这个字符串」证明不了「没有读者」。** 固定串 grep 只能证
      // 存在、不能证不存在；要证不存在得把客户端跑起来做正对照 —— 这正是 Q12 的要求。
      //
      // 现在的状态：**证据完整**（测量有效 + 结论 + 读者版本号），卡的是**范围决策** ——
      // `.agents` 不是一个自己的客户端，它是一条**共享约定路径**，读者是 codex；
      // 同时启用 `codex` 与 `agents` 会让同一批 skill 在 catalog 里出现两次。
      // 「要不要把 .agents 纳入发车范围、以及它跟 codex 的关系怎么算」是人来拍的取舍。
      global: {
        status: GATE_PENDING,
        blockedOn: BLOCKED_ON_SCOPE_DECISION,
        // 🔴 这里记的是**读者**的版本，不是某个叫 agents 的客户端的版本 —— evidence 里写死了这件事。
        clientVersion: 'codex-cli 0.147.0',
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 agents/global：**读者是 codex-cli 0.147.0**' +
          '（.agents 没有自己的客户端，是共享约定路径）。深度 1 正对照 5 → 6、' +
          '同深度正对照 6 → 7、加完整 .geoly fixture 后仍为 7，canary 命中 0，退出码 0。' +
          "⚠️ 推翻了早先「grep -F '.agents/skills' 命中 0 ⇒ 无读者」的结论：" +
          '该路径是运行时 join 拼出来的，固定串 grep 搜不到只能证明搜不到，证明不了没有读者',
      },
      project: {
        status: GATE_PENDING,
        blockedOn: BLOCKED_ON_SCOPE_DECISION,
        clientVersion: 'codex-cli 0.147.0',
        evidence:
          'docs/m1/00-gates.md Gate 1 逐格实测表 agents/project：读者同为 codex-cli 0.147.0，' +
          'target 取 <projectRoot>/.agents/skills。正对照 5 → 6、同深度正对照 6 → 7、' +
          '加 .geoly fixture 后仍为 7，canary 命中 0，退出码 0。范围决策同 global',
      },
    },
    postInstallHint: '新开一个 codex 会话（.agents/skills 的读者是 codex，catalog 在启动时构建）',
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
      // 🔴 类型也要查，不只是真假。`clientVersion: true` 能骗过所有 `!g.clientVersion`
      // 判断，于是一个**根本不是版本号的东西**就能把格子送进「证据完整」那一档。
      // 空串同理：它是假值，会被当成「没有版本」，但写的人多半以为自己填了。
      // 约定：这几个字段要么**缺席**（undefined/null），要么是**非空字符串**。
      for (const f of ['clientVersion', 'reason', 'blockedOn']) {
        const v = g[f];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' || v.trim() === '') {
          throw new Error(
            `adapter ${d.client}/${scope} 的 ${f} 必须是非空字符串或缺席，拿到的是 ${JSON.stringify(v)}`,
          );
        }
      }
      if (!g.evidence) throw new Error(`adapter ${d.client}/${scope} 的门记录缺 evidence`);
      if (g.status === GATE_PASSED && !g.clientVersion) {
        throw new Error(
          `adapter ${d.client}/${scope} 标了 passed 却没有 clientVersion —— ` +
            'Q12 要求门绑定具体客户端版本，否则升级后无从复测',
        );
      }
      // ③ 🔴 `passed` 不得带 blockedOn。两者同时出现只可能是改了一半：
      //    要么门其实没过（那就别写 passed），要么 blocker 已经消解（那就删掉它）。
      //    留着它会让 `list` 一边说「已启用」一边说「被 X 卡住」。
      if (g.status === GATE_PASSED && g.blockedOn) {
        throw new Error(
          `adapter ${d.client}/${scope} 既是 passed 又带 blockedOn=${g.blockedOn} —— ` +
            '过了的门没有 blocker，这是改了一半',
        );
      }
      // ④ 🔴 `unsupported` 必须给 reason：「不支持」得说清是实测不通过还是结构上没读者，
      //    否则下一个人无从判断该不该重测。
      if (g.status === GATE_UNSUPPORTED && !g.reason) {
        throw new Error(`adapter ${d.client}/${scope} 标了 unsupported 却没有 reason`);
      }
      // ⑤ 🔴 `pending` 必须给一个**白名单内**的 blockedOn，并且
      //    「缺决策」与「缺证据」两类各自与 clientVersion 的有无死死绑住。
      //
      //    这条是整段不变量里最要紧的一条：Q12 栽过的跟头是「不敏感的测量被当成了负结果」，
      //    它在门表里的等价物就是**缺证据的格子伪装成只是没拍板**。两者都只差一个词，
      //    代价却差一个数量级 —— 拍板是一次会议，重做实验是重新架一套客户端。
      //    所以不靠 evidence 文案自证，靠 clientVersion 这个**机械**判据：
      //    没跑过客户端就不可能有版本号，有版本号就说明确实跑过。
      if (g.status === GATE_PENDING) {
        if (!KNOWN_BLOCKERS.has(g.blockedOn)) {
          throw new Error(
            `adapter ${d.client}/${scope} 是 pending 却没有已知的 blockedOn（拿到的是 ${g.blockedOn}）—— ` +
              `只能是 ${[...KNOWN_BLOCKERS].join(' / ')}；自由文本会让「缺证据」和「缺决策」混成一团`,
          );
        }
        if (EVIDENCE_COMPLETE_BLOCKERS.has(g.blockedOn) && !g.clientVersion) {
          throw new Error(
            `adapter ${d.client}/${scope} 的 blockedOn=${g.blockedOn} 表示「证据完整、只差拍板」，` +
              '那就必须带 clientVersion —— 没有版本号说明门根本没跑过，那是缺证据不是缺决策',
          );
        }
        // 🔴 必须**显式写成 null**，不能靠「字段缺席」蒙混。
        //    只查真假的话，把 `clientVersion: null` 那一行删掉就能悄悄绕过去，
        //    而删一行正是 review 时最容易滑过的改动（Codex 复核时就是这么戳穿的）。
        //    写死 `=== null` 等于逼作者在这一格上**明确表态**「这里没有版本号」。
        if (EVIDENCE_MISSING_BLOCKERS.has(g.blockedOn) && g.clientVersion !== null) {
          throw new Error(
            `adapter ${d.client}/${scope} 的 blockedOn=${g.blockedOn} 表示「没有运行时证据」，` +
              `那 clientVersion 必须显式写成 null（拿到的是 ${JSON.stringify(g.clientVersion)}）—— ` +
              '带着版本号是在冒充测过，字段缺席则是把这件事藏起来',
          );
        }
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
 * 而不是碰巧返回了对的东西。真门表 2026-08-26 起有四格闭合了，
 * 但 **`unsupported` 这一档一个格子都没有**（agents 的 no-reader 被实测推翻），
 * 那一支仍然只能靠合成门表非空地测。
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
 * 抽出来是为了能非空地测每一支：真门表里 `unsupported` 现在一个格子都没有，
 * 拿它去测 `deny-unsupported` 分支等于测了个空集。
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
  // 用来把「门是什么状态」与「目录/创建逻辑怎么走」解耦：注入一套写死的门表，
  // 这些用例就不会因为真门表的闭合情况变化而跟着改行为
  //（2026-08-26 真门表从「全空」变成「四格闭合」时，只覆盖一半的注入表就漂过一次）。
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
