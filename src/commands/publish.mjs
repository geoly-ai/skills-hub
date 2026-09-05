// `skills-hub publish` —— 把「fork、建目录、算摘要、开 PR」这一串变成一条命令。
//
// ── 🔴 授权模型（用户 2026-09-05 拍板，不要重新设计）─────────────────────
//
// **不注册 OAuth App / GitHub App，直接用用户已有的 GitHub token，
// 不做 `login` / `logout`。** 决策记录见 `docs/m0/10-open-questions.md` Q4
// 与 `docs/m0/06-submission.md` §9 的偏离说明。
// 理由：注册应用是一次性且不可逆的公开面。
//
// 这个决定的代价必须**说出来**，而不是藏起来：用户已有的 token 很可能是
// classic `repo` PAT，权限面**比 `public_repo` 还大**，而 CLI **无法收窄它**。
// 所以本命令在任何写操作之前，把权限面摆到用户脸上并要求确认（§6 `disclose`）。
//
// ── 🔴 两条不可打折的实现约束 ────────────────────────────────────────────
//
// ① **全走 GitHub API，一次 `git` 都不用。** 带 token 的 `git push` 会让本地
//    `pre-push` hook 拿到 token —— 那是任意代码执行 + 凭据泄漏。
// ② **Git Data API，不是 Contents API。** Contents API 没有设置 mode 的字段，
//    `0755` 会被静默写成 `0644`；而 mode 进 `tree_digest`（同字节不同 mode 是
//    两个不同摘要），也进 capability 语义。用 Contents API 投稿 =
//    静默改掉制品身份。
//
// ── 📌 本地校验只是 UX，不是信任门 ───────────────────────────────────────
// 真正的判定在服务端的 PR gate（`validate-pr.yml` 从 base 那棵树跑校验器）。
// 这里跑的是**同一批**校验器（`scripts/submission/*`），目的只是让投稿者在
// 开 PR 之前就看到会红的地方。`--yes` 跳过的**只有**权限风险确认那一问，
// 不跳过这里任何一道校验。

import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

import { EXIT, UsageError } from '../exit-codes.mjs';
import { resolveToken } from '../publish/token.mjs';
import {
  createClient, UPSTREAM_FULL, UPSTREAM_REPO, BASE_BRANCH, API_ORIGIN,
} from '../publish/github.mjs';
import { readIdentity, stagePayload, runLocalGates, PayloadError } from '../publish/payload.mjs';
import {
  getViewer, getBaseline, ensureFork, findOpenDuplicates, branchName,
  assertBranchFree, pushSubmission, verifyBranch, openPullRequest, RemoteError,
} from '../publish/remote.mjs';

/**
 * 06-submission.md §9 里仍然成立的一条：**以 `npx github:` 运行时 publish 拒绝执行**。
 *
 * 判据：npm 从 git 安装一个包时，会往安装下来的 `package.json` 里写
 * `gitHead`（commit sha）或把 `_resolved` 写成 `git+https://…`。
 * 从 registry 装的包两者都没有。
 *
 * ⚠️ **诚实边界：这是尽力而为，不是完备判据。**
 *    · npm 的哪些版本写哪个字段没有正式契约，改了不会有任何东西变红；
 *    · 直接 `node /path/to/checkout/bin/skills-hub.mjs publish` 从**源码树**跑，
 *      两个字段都没有 —— 本函数放行，而那其实也是"未经 registry 分发的代码"。
 *    这道门挡的是最常见的那一种（`npx github:geoly-ai/skills-hub publish`），
 *    不要把它当成"只有签过名的 CLI 才能投稿"的保证。真正的保证在服务端。
 */
export function looksLikeGitInstall(pkgJsonText) {
  let doc;
  try { doc = JSON.parse(pkgJsonText); } catch { return false; }
  if (typeof doc.gitHead === 'string' && doc.gitHead !== '') return true;
  if (typeof doc._resolved === 'string' && /^git[+:]/.test(doc._resolved)) return true;
  return false;
}

function ownPackageJsonPath() {
  return fileURLToPath(new URL('../../package.json', import.meta.url));
}

/**
 * publish 自己的 flag —— **不进 `commands/context.mjs`**（那里只放全局 flag，
 * 且 `test/flag-doc-parity.test.mjs` 只扫那个文件）。命令面按
 * `09-cli.md` §1 的既有规格：`publish [path] [--pack]`，另加 `--dry-run`。
 *
 * 🔴 `--pack` 是一条**断言**，不是提示：它说「我期望这是一个 pack」。
 *    与实际 manifest 不符即失败。写成"只是个提示、以 manifest 为准"的话，
 *    它就是一个用户以为自己设了、实际什么都没设的开关。
 */
function parseArgs(args) {
  const o = { path: null, pack: false, dryRun: false };
  for (const a of args) {
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (a === '--pack') { o.pack = true; continue; }
    if (a.startsWith('-')) {
      throw new UsageError(
        `publish 不认得 ${a}。可用：publish [path] [--pack] [--dry-run]`
        + '（全局 --yes / --json 照常可用）',
      );
    }
    if (o.path !== null) throw new UsageError('publish 只接受一个载荷目录');
    o.path = a;
  }
  return o;
}

/**
 * 权限披露。**在任何写请求之前**，且**不受 `--yes` 影响** ——
 * `--yes` 只是免掉那一问，不是免掉这一屏。
 *
 * 🔴 为什么这一屏必须存在：我们**无法收窄**用户的 token。
 *    一个 classic `repo` PAT 能读写他**所有**私有仓库；`public_repo` 能写他
 *    所有公开仓库。用户交给我们的权限，远大于「给 skills-hub 投一个 skill」
 *    所需 —— 那是这个授权模型的真实代价，藏起来就是在替他做决定。
 */
export function disclosureLines({ tokenInfo, viewer, plan }) {
  const L = [];
  L.push('');
  L.push('🔴 权限面披露 —— 请在继续之前读完');
  L.push('─'.repeat(64));
  L.push(`  token 来源     ${tokenInfo.sourceLabel}`);
  if (tokenInfo.others.length > 0) {
    L.push(`  ⚠️ 同时存在   ${tokenInfo.others.join('、')}（值相同，本次未使用它们）`);
  }
  L.push(`  认证身份       ${viewer.login}（node_id ${viewer.nodeId}，id ${viewer.id}）`);
  L.push(`  可见 scope     ${viewer.scopes === null
    ? '看不见（fine-grained token 通常不回 x-oauth-scopes 头）'
    : (viewer.scopes.length === 0 ? '（空 —— 多半是 fine-grained token）' : viewer.scopes.join(', '))}`);
  L.push('');
  L.push('  这个 token 能做什么（CLI **无法**收窄它）：');
  L.push('    · classic `repo` PAT      → 可读写你**所有**仓库，含**私有**仓库');
  L.push('    · classic `public_repo`   → 可写你**所有**公开仓库');
  L.push('    · fine-grained            → 以你建它时授予的仓库与权限为准（这里看不见）');
  L.push('    🔴 本命令不持有、不存储、不上传你的 token —— 它只活在这个进程里。');
  L.push('       但「我们不持有」**不等于**「它权限很小」。要收窄，请另建一个');
  L.push(`       fine-grained token，只授权你的 fork（${viewer.login}/${UPSTREAM_REPO}）`);
  L.push('       与上游的 Contents(读) + Pull requests(写)。');
  L.push('');
  L.push('  本次将要执行的**写**操作：');
  L.push(`    1. 若无 fork → 在 ${API_ORIGIN} 建 ${viewer.login}/${UPSTREAM_REPO}（fork 自 ${UPSTREAM_FULL}）`);
  L.push(`    2. 在你的 fork 上建 ${plan.files.length} 个 blob + 1 棵 tree + 1 个 commit`);
  L.push(`    3. 建分支 ${plan.branch}（**最后一步**才建，中途失败仓库上看不到任何东西）`);
  L.push(`    4. 向 ${UPSTREAM_FULL} 的 ${BASE_BRANCH} 开一个 PR，并置`);
  L.push('       `maintainer_can_modify: true` —— ⚠️ 这**额外授予上游维护者**修改');
  L.push(`       你 fork 上这个分支的权利（只限这个分支）。GitHub 的 PR 就是这么协作的，`);
  L.push('       但它是一项你正在给出的权限，不该藏在默认值里。');
  L.push('    🔴 不 force-push、不 amend、不改写任何已存在的分支或 PR。');
  L.push('');
  L.push(`  写入路径（只有这些，全部在 ${plan.prefix} 之下）：`);
  for (const f of plan.files) L.push(`    ${f.mode === 0o755 ? '0755' : '0644'}  ${f.repoPath}`);
  L.push('');
  L.push(`  tree_digest    ${plan.treeDigest}`);
  L.push('─'.repeat(64));
  return L;
}

function readLine(stdin) {
  return new Promise((resolve) => {
    if (stdin === null || stdin === undefined) { resolve(''); return; }
    if (stdin.readableEnded === true || stdin.destroyed === true) { resolve(''); return; }
    let buf = '';
    const done = () => { stdin.off?.('data', onData); resolve(buf); };
    const onData = (c) => {
      buf += String(c);
      if (buf.includes('\n')) done();
    };
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.once('close', done);
    stdin.once('error', done);
    stdin.resume?.();
  });
}

/**
 * 🔴 `--yes` **只**代表「我读过权限披露、接受这个风险」。
 *    它不跳过本地结构门、不跳过重复投稿检测、不跳过 fork/PR 的事后核对。
 *    这一点写在这里，也写在 `--help` 里 —— 因为「一个 flag 到底关掉了什么」
 *    是用户唯一没法从行为上观察到的东西（他只会看到"过了"）。
 */
async function confirm(ctx, out) {
  const tty = ctx.stdin?.isTTY === true;
  if (ctx.yes) {
    out.note('已给 --yes：视为**确认了上面的权限风险**。⚠️ 它不跳过任何一道校验。');
    return;
  }
  if (!tty) {
    throw new UsageError(
      '非交互环境下必须显式给 --yes 才能继续 —— 它表示你读过上面的权限披露并接受风险。\n'
      + '  🔴 --yes **不跳过**任何一道校验，也不跳过 fork / PR 的事后核对。',
    );
  }
  out.line('');
  out.line('请输入 publish 以确认（回车不算确认）：');
  const answer = (await readLine(ctx.stdin)).trim();
  if (answer !== 'publish') {
    throw new UsageError(
      `未确认：需要输入 publish，实际得到 ${JSON.stringify(answer)}。什么都没做。`,
      { telemetryReason: 'user-abort' },
    );
  }
}

export async function cmdPublish(ctx, args, out) {
  const o = parseArgs(args);

  // ── 前置守卫（都在任何网络请求之前）────────────────────────────────────
  if (ctx.offline) {
    throw new UsageError(
      'publish 需要网络（它要读上游 base、建 fork、开 PR），与 --offline 互斥。\n'
      + '  🔴 --offline 承诺的是「整个 CLI 不得有任何网络出口」，不是「尽量少出网」。',
    );
  }
  let ownPkg = '';
  try { ownPkg = readFileSync(ownPackageJsonPath(), 'utf8'); } catch { ownPkg = ''; }
  if (looksLikeGitInstall(ownPkg)) {
    throw new UsageError(
      '拒绝以 `npx github:…`（从 git 安装的副本）运行 publish —— 06-submission.md §9。\n'
      + '  🔴 这条命令会拿你的 GitHub token 去做写操作；那份代码没有经过 npm 的\n'
      + '     发布链（provenance / 签名 / 版本不可变），我们不该请你把凭据交给它。\n'
      + '  请用 `npx @geoly-ai/skills-hub publish`。',
    );
  }

  // ── 载荷：读一次盘，之后全用这份字节 ──────────────────────────────────
  const payloadDir = resolvePath(ctx.cwd, o.path ?? '.');
  const identity = readIdentity(payloadDir);
  // 🔴 `--pack` 是断言：不符就失败，不是"以 manifest 为准"地静默忽略。
  const wantKind = o.pack ? 'pack' : 'skill';
  if (identity.kind !== wantKind) {
    throw new UsageError(
      `载荷是一个 ${identity.kind}（根目录里是 ${identity.kind}.json），`
      + `但${o.pack ? '你给了 --pack' : '你没给 --pack'} —— 期望的是 ${wantKind}。\n`
      + `  ${o.pack ? '去掉 --pack' : '加上 --pack'} 再重跑，或者检查载荷目录是不是指错了。`,
    );
  }
  const staged = stagePayload(payloadDir, identity);

  try {
    // ── token（不落盘、不进 argv、不进子进程 env）────────────────────────
    // 🔴 **不包 catch-all。** `resolveToken` 只抛 `TokenError`；用
    //    `catch { throw new TokenError(...) }` 兜住的话，一个 CLI 自身的 bug
    //    会被伪装成「你的认证有问题」，而用户会去查他的 token —— 查不出任何东西。
    const tokenInfo = resolveToken({ env: ctx.env });

    const client = createClient({
      token: tokenInfo.token,
      // 🔴 显式传：`createClient` 不做隐式回退。于是"用了真 fetch"是一个
      //    写得出来的动作，测试忘了注入不会静默出网。
      fetchImpl: ctx.fetchImpl ?? globalThis.fetch,
      userAgent: `skills-hub/${ctx.cliVersion} (+https://github.com/${UPSTREAM_FULL})`,
    });

    // ── 基线（只读）──────────────────────────────────────────────────────
    // 🔴 顺序：基线 → 本地门 → `/user` → 重复检测 → 披露 → 确认 → 写。
    //    `/user` 排在本地门**之后**是有意的：一个连结构门都过不了的投稿，
    //    不该先让我们去问「你是谁」——那次查询会把用户的身份连同 token 发出去，
    //    而它对这次失败没有任何用处。
    //    ⚠️ 401/403 在这一路上**不换下一个 token 来源重试**：
    //    那会让用户看到的身份与实际投稿身份不同。
    const segments = staged.prefix.slice(0, -1).split('/');   // ['submissions', ns, 'name@ver']
    const baseline = await getBaseline(client, { submissionSegments: segments });

    // ── 本地门（跑的是服务端那一批，不是另写的一套）──────────────────────
    const gates = runLocalGates({ staging: staged.staging, baseline });
    const problems = [...gates.problems];

    // base 里已经有这条路径 → 拒（禁止覆盖 base 中已存在的路径）
    if (baseline.existingSubmission !== null) {
      problems.push(
        `${staged.prefix} 在上游 ${BASE_BRANCH} 上已经存在 —— publish 只新增，绝不覆盖已有路径。`,
      );
    }
    if (gates.scanErrors > 0) {
      problems.push(`载荷里有 ${gates.scanErrors} 处**服务端会拒**的字符问题（见下面的扫描结果）`);
    }
    for (const l of gates.scanLines) out.warn({ kind: 'scan-text', message: l });

    if (problems.length > 0) {
      throw new PayloadError(
        // ⚠️ 措辞要准：到这里为止已经发过若干**只读** GET（取基线要用），
        //    但**一个写请求都没有**。说成「没有发出任何请求」是不实的。
        `${problems.length} 处不合规，**没有**发出任何写请求（fork / 分支 / PR 都没建）：\n`
        + problems.map((p) => `  · ${p}`).join('\n')
        + '\n  📌 这批门与服务端 PR gate 跑的是同一批实现，所以本地过了 CI 大概率也过。',
        { violations: problems.map((m) => ({ code: 'E_PUBLISH_GATE', message: m })) },
      );
    }

    // 🔴 provenance 是**可选**的（8b9741c 起）。用户自己写了不是错，但值得提醒。
    if (identity.kind === 'skill' && identity.manifest.provenance !== undefined) {
      out.warn({
        kind: 'provenance-declared',
        message:
          'skill.json 里写了 provenance —— 它会被 promote **逐字核对**，'
          + '而其中 `submitted_by_pr` / `author_github_id` 在 PR 开出来之前根本不存在。\n'
          + '  建议直接删掉 provenance：它现在是可选的，promote 会按 PR 事实自动填，'
          + '省掉一轮回填与重新审批。',
      });
    }

    const branch = branchName({ ...identity, treeDigest: staged.treeDigest });
    const plan = { files: staged.files, prefix: staged.prefix, treeDigest: staged.treeDigest, branch };

    // ── 身份（披露与 fork 都要它；排在本地门之后，见上面那段说明）────────
    const viewer = await getViewer(client);

    // ── 重复投稿竞争（读，且**在 fork 之前**）────────────────────────────
    //    🔴 必须早于 fork：撞上重复时不该在用户账号下留一个多余的 fork，
    //    `--dry-run` 的「一个写请求都不发」也才是真的。
    const dup = await findOpenDuplicates(client, { submissionSegments: segments });
    if (dup.matches.length > 0) {
      throw new RemoteError(
        `${staged.prefix} 已经在 ${dup.matches.length} 个**开着的** PR 里了：\n`
        + dup.matches.map((m) => `  · #${m.number} by ${m.author} —— ${m.url}`).join('\n')
        + '\n  🔴 只读取、核对、报告 —— 本命令不会再开一个，也不改写已有的那个。\n'
        + '  ⚠️ 只看 artifacts/ 是发现不了这种竞争的：同一个版本可能正躺在一个'
        + '尚未合并的 PR 里。',
        { exitCode: 3 },
      );
    }

    // ── 披露 + 确认（🔴 在任何写请求之前）────────────────────────────────
    for (const l of disclosureLines({ tokenInfo, viewer, plan })) out.line(l);

    if (o.dryRun) {
      out.line('');
      out.line('--dry-run：到此为止，**一个写请求都没有发**。');
      return out.emit('publish', {
        dry_run: true,
        artifact_id: identity.id,
        tree_digest: staged.treeDigest,
        branch,
        prefix: staged.prefix,
        files: staged.files.map((f) => ({ path: f.repoPath, mode: f.mode === 0o755 ? '100755' : '100644' })),
        token_source: tokenInfo.source,
        viewer: { login: viewer.login, node_id: viewer.nodeId, scopes: viewer.scopes },
      }, EXIT.OK);
    }

    await confirm(ctx, out);

    // ── 写 ───────────────────────────────────────────────────────────────
    const { repo: fork, created } = await ensureFork(client, {
      viewer, upstreamId: baseline.upstreamId, baseCommitSha: baseline.baseCommitSha,
    });
    if (created) out.note(`已建 fork ${viewer.login}/${UPSTREAM_REPO}`);

    await assertBranchFree(client, { login: viewer.login, branch });

    const pushed = await pushSubmission(client, {
      login: viewer.login,
      branch,
      files: staged.files,
      baseTreeSha: baseline.baseTreeSha,
      baseCommitSha: baseline.baseCommitSha,
      message: `投稿 ${identity.id}\n\ntree_digest: ${staged.treeDigest}\n`,
    });
    out.note(`已建 commit ${pushed.commitSha}，分支 ${branch}`);

    // 🔴 写完用**独立的读**证明结果，而不是相信 201。
    await verifyBranch(client, {
      login: viewer.login, branch, segments, ...pushed,
      baseCommitSha: baseline.baseCommitSha, baseTreeSha: baseline.baseTreeSha,
    });

    const pr = await openPullRequest(client, {
      login: viewer.login,
      branch,
      title: `投稿 ${identity.id}`,
      body: prBody({ identity, treeDigest: staged.treeDigest, files: staged.files }),
      viewer,
      forkId: fork.id,
      upstreamId: baseline.upstreamId,
      commitSha: pushed.commitSha,
    });

    out.line('');
    out.line(`✔ PR #${pr.number} 已开：${pr.url}`);
    out.line('  接下来由服务端的 PR gate 判定 —— 本地那几道门只是提前告诉你会不会红。');
    return out.emit('publish', {
      dry_run: false,
      artifact_id: identity.id,
      tree_digest: staged.treeDigest,
      branch,
      prefix: staged.prefix,
      commit_sha: pushed.commitSha,
      pr: { number: pr.number, url: pr.url, state: pr.state },
      token_source: tokenInfo.source,
      viewer: { login: viewer.login, node_id: viewer.nodeId, scopes: viewer.scopes },
    }, EXIT.OK);
  } finally {
    // 暂存目录里是投稿载荷（公开内容），但它是我们建的，就该我们收。
    try { rmSync(staged.staging, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

function prBody({ identity, treeDigest, files }) {
  return [
    `## ${identity.id}`,
    '',
    `- kind: \`${identity.kind}\``,
    `- tree_digest: \`${treeDigest}\``,
    `- 文件数: ${files.length}`,
    '',
    '由 `skills-hub publish` 生成。载荷只写在',
    `\`submissions/${identity.namespace}/${identity.name}@${identity.version}/\` 之下。`,
    '',
    '> ⚠️ `provenance` 由 promote 按 PR 事实填 —— 本 PR 未自行声明它。',
  ].join('\n');
}
