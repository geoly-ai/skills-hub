#!/usr/bin/env node
// PR 分流与路径白名单 —— 06-submission.md §4（两个验证入口）、§5（权限边界）。
//
// 🔴 **这是一道安全门，不是分类便利。** §4 写死了：
//    「分支保护要求『两个 workflow 中**恰好一个**通过，且 router 判定的那个必须是它』
//      —— 不能配成『任一通过即可』，否则投稿 PR 可以伪装成 promotion 分支绕过路径白名单。
//      router 的判定依据是 **PR 作者身份 + 分支名**，不是 PR 标题或标签（那些投稿者可控）。」
//
// ── 三类 PR（第三类 `maintainer` 是 2026-09-01 补的）────────────────────────
//
// | kind         | 判据（全部用**不可变 node id**，不用 login）           | 允许路径 |
// |--------------|-------------------------------------------------------|---------|
// | `promotion`  | 分支名严格 `promotion/hub-<N>` + head repo 是本仓库 + 作者 == release bot | `artifacts/ registry/ advisories/` |
// | `maintainer` | 作者 id 在 `registry/maintainers.json` 里 + head repo 是本仓库 | 除 `artifacts/**` 与 `registry/snapshots/**` 之外的一切 |
// | `submission` | 其余                                                  | 仅 `submissions/**`，另有 §5 硬拒清单 |
//
// 🔴 **为什么必须有第三类。** §5 的硬拒清单把 `.github/ artifacts/ registry/
//    cli/ scripts/ docs/` 对投稿关死，报错文案自己写着「改这些路径的 PR 必须
//    来自 org 成员，走单独的 maintainer 路径」—— 而那条路径一直没实现。
//    于是**任何**不是 release bot 开的 PR 都落进 `submission`，
//    维护者改代码的 PR 永远合不了。2026-09-01 实际撞上：两张真 PR
//    （改 `docs/**` 与 `test/**`）双双被拒。把 `pr-gate` 钉进 required checks
//    的那一刻，仓库会**锁死** —— 连修这个 bug 的 PR 都推不上去。
//
// 🔴 **本模块不碰网络。** 作者 login、head 分支名、改动路径清单，全由 workflow
//    从 GitHub 事件里取好后传进来。同 promote/build-inputs.mjs 的分工：
//    「取事实」与「按事实判定」分开，判定这一半才能在本机跑遍所有分支。

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

class ClassifyError extends Error {
  constructor(code, msg) { super(msg); this.name = 'ClassifyError'; this.code = code; }
}
const bad = (code, msg) => { throw new ClassifyError(code, msg); };

/**
 * promotion 分支的形状：`promotion/hub-<N>`。
 * 🔴 `<N>` 必须是**纯十进制、无前导零** —— 与 root key 的 `all@snapshot:<N>`
 *    同一条纪律：同一个逻辑值有两种写法，唯一性与排序就都不成立了。
 */
const RE_PROMOTION_BRANCH = /^promotion\/hub-(0|[1-9]\d*)$/;

export const PROMOTION_PATHS = Object.freeze(['artifacts/', 'registry/', 'advisories/']);

/**
 * 🔴 **promotion PR 对 `submissions/` 只许删，不许增或改。**
 *
 * 为什么必须有这一条：promote 的搬运是「复制进 artifacts/ + 从 submissions/ 移走」，
 * 所以它产出的 PR **必然**包含 `submissions/**` 的删除。而 PROMOTION_PATHS 里
 * 没有 `submissions/` —— 2026-09-01 第一次真跑时，promote **自己产出的 PR 过不了
 * 它自己的白名单**，router 直接拒掉。
 * ⚠️ 单元测试喂的是手造的路径列表，从没喂过 promote **实际产出**的那一组，
 *    所以这条不自洽一直没被发现。
 *
 * 🔴 **不能简单地把 `submissions/` 加进 PROMOTION_PATHS。** 那等于允许 promotion PR
 *    **新增**任意投稿 —— 而确定性复算门只验 `artifacts/ ↔ 快照`，管不到 `submissions/`：
 *    一份夹带进来的投稿会绕过投稿侧的全部门禁（结构、字符扫描、Tier 审批），
 *    静静躺在 main 上等下一次 promote 把它搬进 artifacts/。
 *
 * 判据用 route 已经算好的 `present`（`git diff --diff-filter=d`）：
 * 在 changed 里、不在 present 里 ＝ 这次删掉了。
 */
export const PROMOTION_DELETE_ONLY = Object.freeze(['submissions/']);
export const SUBMISSION_PATHS = Object.freeze(['submissions/']);

/**
 * §5 的硬拒清单：投稿 PR **不得**修改这些路径。
 * 🔴 它与「白名单」是**两道**门，不是一道。白名单说「只许改 submissions/」，
 *    这张表说「这几个尤其不许」。两者重叠是有意的：白名单万一被放宽，
 *    这张表还在。**纵深，不是冗余。**
 */
export const SUBMISSION_DENY = Object.freeze([
  '.github/', 'artifacts/', 'registry/', 'cli/', 'scripts/', 'docs/',
]);

/**
 * maintainer PR 的硬拒清单。
 *
 * 🔴 **`maintainer` 不是「免检」，只是「不检投稿白名单」。** 维护者本来就是审
 *    `.github/`、`scripts/`、`docs/`、`cli/` 的人，拦着他们改这些路径，等于
 *    「连修这道门本身的 PR 都合不了」—— 那正是 2026-09-01 真实撞上的死锁。
 *    但**这两个目录例外**：
 *      · `artifacts/**`        —— 制品，受不可变门保护（01-artifacts §7）；
 *      · `registry/snapshots/**` —— 快照，受确定性复算门保护（06-submission §4）。
 *    它们只能由 **promotion PR** 动，而 promotion 路径上跑的是
 *    `verify-promotion.mjs`：用 PR 里记的 `--created-at` 重跑 `build-snapshot.mjs`
 *    并断言**字节一致**，再逐张比历史快照的不可变性。
 *    一个维护者手改一张快照，走的是 maintainer 路径 —— 那条路径上**没有**复算门，
 *    于是「快照必须是可复现地算出来的」这条就此失效，而它是整套签名/时间戳信任链
 *    的地基。**不这么拦的话，一次手滑或一次账号接管就能把任意内容写进 hub-<N>。**
 *
 * ⚠️ 这不是「不信任维护者」，是**不让任何一条路径绕过复算**：维护者要改快照，
 *    正确做法是改生成器 + 重跑 promote，让复算门重新证明一遍。
 */
export const MAINTAINER_DENY = Object.freeze(['artifacts/', 'registry/snapshots/']);

/**
 * @param {object} a
 * @param {string} a.headRef        PR 的 head 分支名
 * @param {string} a.authorId       🔴 PR 作者的**不可变** node id（不是 login）
 * @param {string} a.releaseBotId   release bot 的不可变 node id
 * @param {string} a.headRepo       PR 的 head 仓库全名（`owner/name`）
 * @param {string} a.thisRepo       本仓库全名
 * @param {string[]} [a.maintainerIds] 🔴 维护者的**不可变** node id 清单
 *   （`registry/maintainers.json`）。默认空 = fail-closed：名单取不到时
 *   所有人都落进 `submission`，宁可维护者被拦，也不能让路人拿到 maintainer 权限。
 * @param {string} [a.authorLogin]  仅用于文案
 * @returns {'promotion'|'maintainer'|'submission'}
 */
export function classifyPr({
  headRef, authorId, releaseBotId, headRepo, thisRepo, maintainerIds = [], authorLogin = '(未给)',
}) {
  for (const [k, v] of [['headRef', headRef], ['authorId', authorId],
    ['releaseBotId', releaseBotId], ['headRepo', headRepo], ['thisRepo', thisRepo]]) {
    if (typeof v !== 'string' || v === '') bad('E_CLASSIFY_INPUT', `${k} 必须是非空字符串`);
  }
  if (!Array.isArray(maintainerIds)) bad('E_CLASSIFY_INPUT', 'maintainerIds 必须是数组');
  for (const id of maintainerIds) {
    if (typeof id !== 'string' || id === '') bad('E_CLASSIFY_INPUT', 'maintainerIds 里有空项');
  }
  const looksPromotion = RE_PROMOTION_BRANCH.test(headRef);

  // 🔴 **判据是不可变的 node id，不是 login。** login 可以改名、也可以被别人
  //    重新认领：bot 改名之后，workflow 配置里还留着旧 login，攻击者认领那个
  //    旧 login、建一个 `promotion/hub-9` 分支，三个字符串条件就全都成立了
  //    —— 那是一条实打实的提权路径（Codex 2026-08-31）。
  const byBot = authorId === releaseBotId;

  // 🔴 **promotion 分支必须来自本仓库，不能来自 fork。** promote.yml 产出的 PR
  //    永远在本仓库开；一个来自 fork 的「promotion」PR 无论作者是谁都不合法。
  //    多这一条是纵深：万一 bot 的凭据泄漏，攻击面仍被限制在本仓库内。
  const fromThisRepo = headRepo === thisRepo;

  // ── 🔴🔴 三类的**优先级**：分支名是第一判据 ──────────────────────────────
  //
  // 为什么必须先判分支名：2026-09-01 起 release bot 的身份**就是**维护者
  // chovizzz 的 node id（用户选了细粒度 PAT 而非 GitHub App），所以同一个作者
  // **同时满足** promotion 与 maintainer 的判据。谁先判，结果就不一样：
  //   · 先判分支名 → `promotion/hub-42` 判 promotion，跑确定性复算门 ✅
  //   · 先判维护者 → 同一张 PR 判 maintainer，**复算门被跳过**，
  //     而 maintainer 路径上根本没有那道门 —— 于是每一张 promotion PR 都
  //     悄悄降级成「维护者手改了 artifacts/ 和 registry/」。
  // 后者不会报错、不会变红，只是**门没跑**。这就是为什么顺序要写进注释、
  // 并且有一条测试专门钉住它：不要把下面两段调换。
  //
  // ⚠️ 另一半同样重要：maintainer 的硬拒清单里有 `artifacts/` 与
  //    `registry/snapshots/`，所以「降级成 maintainer」的 promotion PR 其实会被
  //    路径门拒掉、而不是静默放行。但那是**第二道**保险，不是可以省掉第一道的理由。
  if (looksPromotion && byBot && fromThisRepo) return 'promotion';

  // 🔴 分支名像 promotion、却不满足其余条件 —— **这不是普通投稿，是一次伪装**。
  //    仍按 submission 处理（路径白名单会把它拦下），但要**大声说出来**：
  //    静默降级会让这类尝试淹没在正常流量里。
  //
  // 🔴🔴 **这里不能 fall through 到 maintainer**，哪怕作者确实在维护者名单里。
  //    `promotion/hub-<N>` 是一个**保留的分支命名空间**：落在它上面却不满足
  //    promotion 条件的一切，一律 fail-closed 到最严的那条路径（只许改
  //    `submissions/`）。理由有两层：
  //      ① 一次伪装尝试不该因为「作者恰好是维护者」而拿到**更宽**的权限；
  //      ② 维护者自己想改代码，换个分支名就行 —— 代价是一次改名，
  //         而放宽的代价是给伪装留一条更宽的出路。
  if (looksPromotion) {
    const why = [];
    if (!byBot) why.push(`作者 ${authorLogin}(id=${authorId}) 不是 release bot(id=${releaseBotId})`);
    if (!fromThisRepo) why.push(`head 仓库 ${headRepo} 不是 ${thisRepo}`);
    process.stderr.write(
      `⚠️ 🔴 分支名 ${headRef} 形如 promotion，但${why.join('，且')} —— 按**投稿**处理。\n`
      + '   §4：router 只认作者身份 + 分支名，不认标题或标签（那些投稿者可控）。\n'
      + `   ⚠️ 即使作者在维护者名单里也不会降级成 maintainer：${'`promotion/hub-<N>`'} 是保留命名空间。\n`,
    );
    return 'submission';
  }

  // ── maintainer：06-submission.md §5「改这些路径的 PR 必须来自 org 成员，
  //    走单独的 maintainer 路径」——就是这一条 ─────────────────────────────
  //
  // 🔴 判据同样是**不可变 node id**，不是 login。名单来自
  //    `registry/maintainers.json`，而 workflow 必须从 **base** 那棵树读它：
  //    让被检的 PR 自己提供名单，等于让投稿者把自己写进维护者名单。
  //
  // 🔴 **fork 来的一律不算。** 维护者身份是「这个人是谁」，而 head repo 是
  //    「这些提交长在哪棵树上」。一个 fork 上的分支由 fork 的 owner 说了算，
  //    维护者的 fork 被接管、或维护者从别人的 fork 开 PR，都会让「作者是维护者」
  //    这一条与「内容可信」脱钩。多这一条与 promotion 那条是同一个纵深理由。
  const byMaintainer = maintainerIds.includes(authorId);
  if (byMaintainer && fromThisRepo) return 'maintainer';

  if (byMaintainer && !fromThisRepo) {
    process.stderr.write(
      `⚠️ 作者 ${authorLogin}(id=${authorId}) 在维护者名单里，但 head 仓库 ${headRepo}`
      + ` 不是 ${thisRepo} —— 按**投稿**处理。\n`
      + '   fork 上的分支由 fork 的 owner 说了算，维护者身份不能跨仓库带过来。\n',
    );
  }
  return 'submission';
}

/**
 * 一条路径是否落在某个前缀清单**之内**。
 *
 * 🔴 **裸目录名不算。** 第一版写的是 `p === pre.slice(0, -1) || p.startsWith(pre)`，
 *    于是 `submissions`（没有斜杠）被判成白名单内 —— 而规范允许的是 `submissions/**`。
 *    git 产得出这种路径：把原来的 `submissions/` 树删掉、提交一个**同名的 symlink
 *    或 gitlink**，改动清单里就是那个裸名（Codex 2026-08-31）。
 *    那样一来「只允许目录内的文件」这条边界就守不住了。
 *    symlink / gitlink 本身由后续的载荷结构门拒，但**这道门不该先把它放进来**。
 */
const underAny = (p, prefixes) => prefixes.some((pre) => p.startsWith(pre));

/**
 * 硬拒清单专用：**目录内的东西要拒，那个目录本身也要拒**。
 *
 * 🔴 与上面 `underAny` 的差别只有裸目录名一格，但这一格在**拒**这一侧的方向
 *    是反的：白名单里放进裸名是漏（见 `underAny` 的说明），黑名单里漏掉裸名
 *    同样是漏 —— 而且更难看见。
 *    投稿路径上这一格由白名单兜住了（`artifacts` 既不在白名单里也不在目录内，
 *    照样被 `E_PATH_OUTSIDE` 拒）；但 **maintainer 路径没有白名单**，
 *    黑名单是唯一的门：一张 maintainer PR 把 `artifacts/` 整个删掉、
 *    换成一个同名 symlink 或 gitlink，git 产出的改动路径就是裸名 `artifacts`，
 *    `startsWith('artifacts/')` 判假，制品目录就这么被换掉了。
 */
const underOrIs = (p, prefixes) => prefixes.some((pre) => p === pre.slice(0, -1) || p.startsWith(pre));

/**
 * §4 的路径白名单 + §5 的硬拒清单。
 *
 * 🔴 **rename 的两端都要受检。** 裸字符串表达不了「从哪改名过来」：
 *    `.github/x.yml → submissions/x.yml` 在 `git diff -M --name-only` 下**只出现新路径**，
 *    于是一次「把受保护文件删掉」的改动会从投稿白名单溜过去（Codex 2026-08-31）。
 *    两条出路，本函数都支持：
 *      ① 调用方用 `--no-renames`（git 会拆成一删一增，两端都出现在清单里）；
 *      ② 或者把 rename 传成 `旧路径\t新路径` / `旧路径 -> 新路径`，本函数拆开各查一次。
 *    ⚠️ 本函数**无法验证**调用方用了哪种 —— 只给一条空字符串路径它也不知道。
 *    workflow 那一侧必须显式用 `--no-renames`，这条写进它的注释里。
 *
 * 🔴 **三条路径各自的形状不一样，别把它们想成同一张表：**
 *   · `submission` —— 白名单（只许 `submissions/`）**加**硬拒清单，两道门；
 *   · `promotion`  —— 只有白名单（`artifacts/ registry/ advisories/`）；
 *   · `maintainer` —— **没有白名单**（维护者本来就是审全仓的人），只有硬拒清单
 *     （`artifacts/`、`registry/snapshots/`）。
 *     它不是「免检」：CODEOWNERS 审批与 `ci-gate` 都照跑，
 *     另外 `validate-pr.yml` 的 `maintainer-gates` 还会扫改动文件的
 *     不可见字符 / bidi —— 维护者一样会被钓鱼。
 *
 * @param {object} a
 * @param {'promotion'|'maintainer'|'submission'} a.kind
 * @param {string[]} a.changedPaths  本次 PR 改动的全部路径（仓库根相对）
 */
/**
 * @param {object} a
 * @param {string} a.kind
 * @param {string[]} a.changedPaths        本 PR 碰过的所有路径（含删掉的）
 * @param {string[]|null} [a.presentPaths] PR 之后**仍然存在**的那些
 *   （route 用 `git diff --diff-filter=d` 算的）。promotion 判「只许删」要用它；
 *   给 `null` 表示拿不到 —— 那时 promotion 碰 submissions/ 一律拒（fail-closed）。
 */
export function assertPathsAllowed({ kind, changedPaths, presentPaths = null }) {
  // 🔴 kind 必须是这三个之一。拼错一个字母就落进 `else`，而 `else` 曾经等价于
  //    「按 submission 判」—— 一个错字换来一次静默的降级或提权，不能这样。
  if (!['promotion', 'maintainer', 'submission'].includes(kind)) {
    bad('E_CLASSIFY_INPUT', `不认得的 kind：${JSON.stringify(kind)}`);
  }
  if (!Array.isArray(changedPaths)) bad('E_CLASSIFY_INPUT', 'changedPaths 必须是数组');
  if (changedPaths.length === 0) bad('E_NO_CHANGES', 'PR 没有改动任何文件 —— 不判定，交人工');
  // rename 的两端拆开，各查一次
  changedPaths = changedPaths.flatMap((p) => (typeof p === 'string' ? p.split(/\t| -> /) : [p]))
    .map((p) => (typeof p === 'string' ? p.trim() : p))
    .filter((p) => p !== '');

  // 🔴 `maintainer` 的 `allowed` 是 `null`，不是「一张装着所有前缀的表」——
  //    "没有白名单" 与 "白名单碰巧覆盖了一切" 读起来一样，改起来天差地别。
  const allowed = { promotion: PROMOTION_PATHS, submission: SUBMISSION_PATHS, maintainer: null }[kind];
  const deny = { promotion: [], submission: SUBMISSION_DENY, maintainer: MAINTAINER_DENY }[kind];
  const outside = [];
  const denied = [];
  const stillPresent = [];
  const present = presentPaths === null ? null
    : new Set(presentPaths.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== ''));
  for (const p of changedPaths) {
    if (typeof p !== 'string' || p === '') bad('E_CLASSIFY_INPUT', 'changedPaths 里有空项');
    // 🔴 路径里出现 `..` 一律拒 —— 白名单靠前缀判定，而 `submissions/../cli/x`
    //    的前缀是 `submissions/`。git 不会产出这种路径，但判据不能依赖
    //    「上游不会给我坏输入」。
    //    ⚠️ maintainer 没有白名单，但这一条对它同样生效：`registry/snapshots/../../x`
    //    的前缀不是 `registry/snapshots/`，硬拒清单一样会被绕过。
    if (p.split('/').includes('..')) bad('E_PATH_TRAVERSAL', `改动路径含 ..：${p}`);
    if (underOrIs(p, deny)) denied.push(p);
    else if (allowed !== null && !underAny(p, allowed)) {
      // promotion 对 submissions/ 只许删 —— 见 PROMOTION_DELETE_ONLY 的长注释
      if (kind === 'promotion' && underAny(p, PROMOTION_DELETE_ONLY)) {
        // 🔴 拿不到 present 就**不能**放行：那时「它是被删掉的」只是猜测。
        //    fail-closed —— 少一个输入不该变成多一份信任。
        if (present === null) {
          bad('E_CLASSIFY_INPUT',
            `promotion PR 动了 ${p}，但没有给 --present，无法证明它是**被删掉**的。\n`
            + '  🔴 promotion 对 submissions/ 只许删；拿不到证据就不放行。');
        } else if (present.has(p)) stillPresent.push(p);
        // 不在 present 里 ＝ 这次删掉了 ＝ 放行
      } else outside.push(p);
    }
  }

  if (stillPresent.length) {
    bad('E_PROMOTION_SUBMISSION_WRITE',
      'promotion PR 对 `submissions/` **只许删**，这些路径在 PR 之后仍然存在：\n'
      + stillPresent.map((x) => `  · ${x}`).join('\n')
      + '\n  🔴 允许 promotion 新增/修改投稿，等于让它绕开投稿侧的全部门禁'
      + '（结构门、字符扫描、Tier 审批）——\n'
      + '     确定性复算门只验 `artifacts/ ↔ 快照`，看不见 `submissions/`。');
  }

  if (denied.length && kind === 'maintainer') {
    bad('E_PATH_DENIED',
      'maintainer PR **不得**修改这些路径 —— 它们只能由 promotion PR 动：\n'
      + denied.map((p) => `  · ${p}`).join('\n')
      + `\n  ${MAINTAINER_DENY.join('、')} 受 promotion 路径上的**确定性复算门**与`
      + '**不可变门**保护（06-submission.md §4、01-artifacts.md §7）。\n'
      + '  手改一张快照或一个制品，就是绕过「快照必须能被字节一致地复算出来」——\n'
      + '  而那是签名与时间戳信任链的地基。要改，请改生成器并重跑 promote。');
  }
  if (denied.length) {
    bad('E_PATH_DENIED',
      `投稿 PR **不得**修改这些路径（06-submission.md §5）：\n`
      + denied.map((p) => `  · ${p}`).join('\n')
      + '\n  改这些路径的 PR 必须来自 org 成员，走单独的 maintainer 路径。');
  }
  if (outside.length) {
    bad('E_PATH_OUTSIDE',
      `${kind} PR 只允许改 ${allowed.join('、')}，但改了：\n`
      + outside.map((p) => `  · ${p}`).join('\n'));
  }
  return true;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad('E_CLASSIFY_INPUT', `不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad('E_CLASSIFY_INPUT', `${name} 需要一个值`);
    o[name.slice(2)] = val;
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  // 🔴 `--maintainer-ids` 在必填之列：**不给就报错，而不是默默当成空名单**。
  //    空名单是 fail-closed 的（所有人都判 submission，维护者的 PR 全被拦），
  //    看起来"安全"，但它与「jq 表达式写错了、名单没取到」长得一模一样 ——
  //    于是 2026-09-01 那场死锁会原样重演一遍，而且这次连报错都没有。
  //    必填之后，"名单为空" 只能是显式传了空串，那是一个看得见的动作。
  for (const k of ['head-ref', 'author-id', 'release-bot-id', 'head-repo', 'this-repo',
    'maintainer-ids', 'changed-paths']) {
    if (o[k] === undefined) bad('E_CLASSIFY_INPUT', `缺少 --${k}`);
  }
  const kind = classifyPr({
    headRef: o['head-ref'],
    authorId: o['author-id'], releaseBotId: o['release-bot-id'],
    headRepo: o['head-repo'], thisRepo: o['this-repo'],
    // 逗号分隔；空串 = 空名单（fail-closed，所有人都是 submission）
    maintainerIds: o['maintainer-ids'].split(',').map((s) => s.trim()).filter(Boolean),
    authorLogin: o.author ?? '(未给)',
  });
  // 换行分隔：路径里可以有逗号，不能有换行（§01-4 的 grammar 更严，但输入来自 git）
  const changedPaths = o['changed-paths'].split('\n').map((s) => s.trim()).filter(Boolean);
  // 🔴 `--present-paths` **必填**（可以是空串）。缺省成 null 的话，
  //    「workflow 忘了传」与「这次真的一个文件都没剩」长得一模一样，
  //    而前者会让 promotion 在 submissions/ 上一律被拒 —— 又是一次没有报错的死锁。
  //    必填之后，拿不到证据是一个**看得见**的失败。
  if (o['present-paths'] === undefined) bad('E_CLASSIFY_INPUT', '缺少 --present-paths');
  const presentPaths = o['present-paths'].split('\n').map((x) => x.trim()).filter(Boolean);
  assertPathsAllowed({ kind, changedPaths, presentPaths });
  process.stdout.write(`${kind}\n`);
  process.stderr.write(`✔ 判定为 ${kind}，${changedPaths.length} 个改动路径全部合规\n`);
  return 0;
}

export { ClassifyError };

// 入口守卫比 realpath —— 见 scripts/release/build-timestamp.mjs 里的说明。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return true; }
}

if (invokedDirectly()) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
