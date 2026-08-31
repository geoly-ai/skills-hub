#!/usr/bin/env node
// PR 分流与路径白名单 —— 06-submission.md §4（两个验证入口）、§5（权限边界）。
//
// 🔴 **这是一道安全门，不是分类便利。** §4 写死了：
//    「分支保护要求『两个 workflow 中**恰好一个**通过，且 router 判定的那个必须是它』
//      —— 不能配成『任一通过即可』，否则投稿 PR 可以伪装成 promotion 分支绕过路径白名单。
//      router 的判定依据是 **PR 作者身份 + 分支名**，不是 PR 标题或标签（那些投稿者可控）。」
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
 * @param {object} a
 * @param {string} a.headRef        PR 的 head 分支名
 * @param {string} a.authorId       🔴 PR 作者的**不可变** node id（不是 login）
 * @param {string} a.releaseBotId   release bot 的不可变 node id
 * @param {string} a.headRepo       PR 的 head 仓库全名（`owner/name`）
 * @param {string} a.thisRepo       本仓库全名
 * @param {string} [a.authorLogin]  仅用于文案
 * @returns {'promotion'|'submission'}
 */
export function classifyPr({ headRef, authorId, releaseBotId, headRepo, thisRepo, authorLogin = '(未给)' }) {
  for (const [k, v] of [['headRef', headRef], ['authorId', authorId],
    ['releaseBotId', releaseBotId], ['headRepo', headRepo], ['thisRepo', thisRepo]]) {
    if (typeof v !== 'string' || v === '') bad('E_CLASSIFY_INPUT', `${k} 必须是非空字符串`);
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

  if (looksPromotion && byBot && fromThisRepo) return 'promotion';

  // 🔴 分支名像 promotion、却不满足其余条件 —— **这不是普通投稿，是一次伪装**。
  //    仍按 submission 处理（路径白名单会把它拦下），但要**大声说出来**：
  //    静默降级会让这类尝试淹没在正常流量里。
  if (looksPromotion) {
    const why = [];
    if (!byBot) why.push(`作者 ${authorLogin}(id=${authorId}) 不是 release bot(id=${releaseBotId})`);
    if (!fromThisRepo) why.push(`head 仓库 ${headRepo} 不是 ${thisRepo}`);
    process.stderr.write(
      `⚠️ 🔴 分支名 ${headRef} 形如 promotion，但${why.join('，且')} —— 按**投稿**处理。\n`
      + '   §4：router 只认作者身份 + 分支名，不认标题或标签（那些投稿者可控）。\n',
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
 * @param {object} a
 * @param {'promotion'|'submission'} a.kind
 * @param {string[]} a.changedPaths  本次 PR 改动的全部路径（仓库根相对）
 */
export function assertPathsAllowed({ kind, changedPaths }) {
  if (!Array.isArray(changedPaths)) bad('E_CLASSIFY_INPUT', 'changedPaths 必须是数组');
  if (changedPaths.length === 0) bad('E_NO_CHANGES', 'PR 没有改动任何文件 —— 不判定，交人工');
  // rename 的两端拆开，各查一次
  changedPaths = changedPaths.flatMap((p) => (typeof p === 'string' ? p.split(/\t| -> /) : [p]))
    .map((p) => (typeof p === 'string' ? p.trim() : p))
    .filter((p) => p !== '');

  const allowed = kind === 'promotion' ? PROMOTION_PATHS : SUBMISSION_PATHS;
  const outside = [];
  const denied = [];
  for (const p of changedPaths) {
    if (typeof p !== 'string' || p === '') bad('E_CLASSIFY_INPUT', 'changedPaths 里有空项');
    // 🔴 路径里出现 `..` 一律拒 —— 白名单靠前缀判定，而 `submissions/../cli/x`
    //    的前缀是 `submissions/`。git 不会产出这种路径，但判据不能依赖
    //    「上游不会给我坏输入」。
    if (p.split('/').includes('..')) bad('E_PATH_TRAVERSAL', `改动路径含 ..：${p}`);
    if (kind === 'submission' && underAny(p, SUBMISSION_DENY)) denied.push(p);
    else if (!underAny(p, allowed)) outside.push(p);
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
  for (const k of ['head-ref', 'author-id', 'release-bot-id', 'head-repo', 'this-repo', 'changed-paths']) {
    if (o[k] === undefined) bad('E_CLASSIFY_INPUT', `缺少 --${k}`);
  }
  const kind = classifyPr({
    headRef: o['head-ref'],
    authorId: o['author-id'], releaseBotId: o['release-bot-id'],
    headRepo: o['head-repo'], thisRepo: o['this-repo'],
    authorLogin: o.author ?? '(未给)',
  });
  // 换行分隔：路径里可以有逗号，不能有换行（§01-4 的 grammar 更严，但输入来自 git）
  const changedPaths = o['changed-paths'].split('\n').map((s) => s.trim()).filter(Boolean);
  assertPathsAllowed({ kind, changedPaths });
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
