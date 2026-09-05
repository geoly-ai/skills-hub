// `publish` 的远端一侧：取基线事实、核对 fork 身份、建树建 commit 建 ref、开 PR。
//
// ── 🔴 四条贯穿本模块的纪律 ───────────────────────────────────────────────
//
// ① **基线事实全部落在同一个 tree sha 上。** 上游的已有制品清单、
//    `registry/reserved.json`、`registry/owners.json`、以及「这条投稿路径在不在
//    base 里」—— 全部从**同一个** immutable tree sha 派生。分几次查会各自看到
//    不同时刻的仓库，而它们之间的不一致没有任何东西会发现。
//
// ② **绝不在可能被截断的结果上做判定。** GitHub 的 `?recursive=1` 有 `truncated`
//    标志，而 `compare` 的 `files` **最多 300 条且不分页** —— 载荷却最多允许
//    2000 个文件（`src/untar.mjs` 的 MAX_FILES）。一个在截断结果上得出的
//    「没查到 → 放行」，正是「看起来守住了」的教科书形状。
//    所以本模块**逐层 subtree 走**，每一层都查 `truncated`。
//
// ③ **POST 不是幂等的。** fork / 建 ref / 开 PR 三个 POST 超时之后，
//    服务端可能已经生效了。所以每一个都写成「先查 → 没有才发 → 发完读回」，
//    绝不在超时后盲目重发。
//    ⚠️ **读回读不到 ≠ 那个 POST 没到 GitHub**。读不到时我们以**网络错误**退出、
//    请用户重跑（重跑会先查），而不是重发，也不是宣布"没成功"。
//
// ④ **写完必须用独立的读去证明。** 「我发了一个 POST 而且它返回了 201」不等于
//    「远端现在的状态是我要的那个」。见 `verifyBranch` 的长注释 ——
//    那里是本模块最容易被写成「看起来守住了」的地方。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UPSTREAM_OWNER, UPSTREAM_REPO, UPSTREAM_FULL, BASE_BRANCH,
  seg, getAllPages, ApiHttpError,
} from './github.mjs';
import { parseStrict } from '../canonical-json.mjs';
import { readReserved } from '../../scripts/submission/structural-gates.mjs';

export class RemoteError extends Error {
  constructor(message, extra = {}) {
    super(message); this.name = 'RemoteError'; this.exitCode = extra.exitCode ?? 1;
    Object.assign(this, extra);
  }
}

const UP = `/repos/${seg(UPSTREAM_OWNER)}/${seg(UPSTREAM_REPO)}`;
const forkPathFor = (login) => `/repos/${seg(login)}/${seg(UPSTREAM_REPO)}`;

// ── tree 的逐层走法 ─────────────────────────────────────────────────────────

/**
 * 取一棵 tree。**每一次都查 `truncated`** —— 截断的结果上不做任何判定。
 *
 * 🔴 `recursive` 默认关。整棵仓库树的递归查询会随仓库增长而截断，
 *    而"先拿到结果再过滤前缀"已经太晚：被截掉的那部分恰恰可能就是我们要找的。
 *    只有对**已经缩到投稿目录**的 subtree 才用 recursive。
 */
export async function getTree(client, repoPath, sha, { recursive = false } = {}) {
  const q = recursive ? '?recursive=1' : '';
  const r = await client.get(`${repoPath}/git/trees/${seg(sha)}${q}`);
  const j = r.json ?? {};
  if (j.truncated === true) {
    throw new RemoteError(
      `tree ${sha} 的查询结果被 GitHub **截断**（truncated=true）—— 拒绝据此判定。\n`
      + '  🔴 在截断的结果上，「这条路径不存在」与「我们没看到它」分不开，\n'
      + '     而前者是放行、后者是不知道。',
      { exitCode: 6 },
    );
  }
  // 🔴 200 但 `tree` 不是数组 → **抛**，不当成空树。
  //    「空树」是一个会让下游放行的答案（路径不存在、版本没占用），
  //    而「响应形状不对」是一个我们什么都不知道的状态。两者不能同格。
  if (!Array.isArray(j.tree)) {
    throw new RemoteError(`tree ${sha} 的响应里 tree 不是数组 —— 拒绝把它当成空树`, { exitCode: 6 });
  }
  return j.tree;
}

/**
 * 从一棵 root tree 出发，**逐层非递归**地解析一条路径。
 * 找不到返回 `null` —— 这是一个**确定的**"不存在"，因为每一层都完整读过
 * （`getTree` 保证没有截断）。
 */
export async function resolvePath(client, repoPath, rootTreeSha, segments) {
  let sha = rootTreeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = await getTree(client, repoPath, sha);
    const hit = entries.find((e) => e.path === segments[i]);
    if (hit === undefined) return null;
    if (i === segments.length - 1) return hit;
    if (hit.type !== 'tree') return null;        // 中间一段不是目录 = 这条路径不存在
    sha = hit.sha;
  }
  return null;
}

// ── 身份 ────────────────────────────────────────────────────────────────────

/**
 * `GET /user` —— 认证用户是谁。
 *
 * 🔴 顺带读 `x-oauth-scopes`：classic PAT 会在这个头里回它的 scope。
 *    ⚠️ **空或缺席绝不代表「这个 token 权限小」** —— fine-grained token
 *    根本不回这个头，而它可能被授予了任意仓库的写权限。所以下游把
 *    `null` 显示成「看不见」，不显示成「无」。
 */
export async function getViewer(client) {
  const r = await client.get('/user');
  const u = r.json ?? {};
  for (const k of ['login', 'id', 'node_id']) {
    if (u[k] === undefined || u[k] === null) {
      throw new RemoteError(`GET /user 的响应里没有 ${k} —— 拒绝在身份不明的情况下继续`, { exitCode: 7 });
    }
  }
  const raw = r.headers?.get?.('x-oauth-scopes');
  const scopes = typeof raw === 'string'
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : null;                                    // ← null = **看不见**，不是「没有权限」
  // 🔴 同 `repo.id`：`owner.id === viewer.id` 那道门的判据，缺席即退化成恒真。
  if (typeof u.id !== 'number' || !Number.isInteger(u.id)) {
    throw new RemoteError(
      `GET /user 的 id 不是整数（得到 ${JSON.stringify(u.id)}）—— 拒绝继续：`
      + '它是 fork owner 与 PR 作者核对的判据。',
      { exitCode: 7 },
    );
  }
  return { login: String(u.login), id: u.id, nodeId: String(u.node_id), scopes };
}

// ── 基线 ────────────────────────────────────────────────────────────────────

/**
 * 上游 base 的全部事实，全部落在同一个 `baseTreeSha` 上。
 *
 * 🔴 **一次整仓 `?recursive=1` 都不发。** 我们要的三样东西都是 subtree 局部的：
 *      · 已有制品清单        → `artifacts/` 这一棵
 *      · 保留清单 / owners   → `registry/` 这一层
 *      · 这条投稿路径在不在  → 逐层解析那条路径
 *    整仓递归会随仓库增长而截断，而截断之后上面三条**全都**会得到假的「没有」。
 *
 * @param {object} a
 * @param {string[]} a.submissionSegments  形如 `['submissions','<ns>','<name>@<ver>']`
 */
export async function getBaseline(client, { submissionSegments }) {
  const repo = (await client.get(UP)).json ?? {};
  if (repo.full_name !== UPSTREAM_FULL) {
    throw new RemoteError(
      `上游仓库的 full_name 是 ${JSON.stringify(repo.full_name)}，应为 ${UPSTREAM_FULL} —— `
      + '多半是仓库被改名或被转移了。拒绝继续。',
    );
  }
  // 🔴 `repo.id` 必须是**真的数字**。它是后面核对 `fork.parent.id === upstreamId`
  //    的右操作数 —— 两边都缺席时 `undefined === undefined` 为真，
  //    于是那道 fork 身份门会静默放行**任何** fork。
  //    ⚠️ 这正是「看起来守住了」的形状：门写在那里，判据却退化成恒真。
  const upstreamId = repo.id;
  if (typeof upstreamId !== 'number' || !Number.isInteger(upstreamId)) {
    throw new RemoteError(
      `${UPSTREAM_FULL} 的 repo.id 不是整数（得到 ${JSON.stringify(upstreamId)}）—— 拒绝继续。\n`
      + '  🔴 它是 fork 身份核对的判据；拿不到它，那道门就退化成恒真。',
    );
  }

  const ref = (await client.get(`${UP}/git/ref/heads/${seg(BASE_BRANCH)}`)).json ?? {};
  if (ref.object?.type !== 'commit' || typeof ref.object?.sha !== 'string') {
    throw new RemoteError(`${UPSTREAM_FULL} 的 ${BASE_BRANCH} 不是一个 commit ref —— 拒绝继续`);
  }
  const baseCommitSha = ref.object.sha;

  const commit = (await client.get(`${UP}/git/commits/${seg(baseCommitSha)}`)).json ?? {};
  const baseTreeSha = commit.tree?.sha;
  if (typeof baseTreeSha !== 'string') {
    throw new RemoteError(`读不到 ${baseCommitSha} 的 tree sha —— 拒绝继续`);
  }

  // ① 已有制品：只递归 `artifacts/` 这一棵
  const artifactsEntry = await resolvePath(client, UP, baseTreeSha, ['artifacts']);
  let artifactPaths = [];
  if (artifactsEntry !== null) {
    if (artifactsEntry.type !== 'tree') throw new RemoteError('上游的 `artifacts` 不是目录 —— 拒绝继续');
    artifactPaths = (await getTree(client, UP, artifactsEntry.sha, { recursive: true }))
      .map((e) => `artifacts/${e.path}`);
  }

  // ② 注册表两份文件
  const registryEntry = await resolvePath(client, UP, baseTreeSha, ['registry']);
  // 🔴 `registry` 在但不是目录 → **抛**，不当成"里面什么都没有"。
  //    当成空的话，保留清单与 owners 都会退化成空表 —— 于是保留 namespace
  //    全部放行、每个 namespace 都被判成"首次注册"。
  if (registryEntry !== null && registryEntry.type !== 'tree') {
    throw new RemoteError(
      `上游的 \`registry\` 不是目录（type=${registryEntry.type}）—— 拒绝把保留清单当成空表`,
    );
  }
  const registryFiles = registryEntry === null ? [] : await getTree(client, UP, registryEntry.sha);
  const blobShaIn = (name) => {
    const e = registryFiles.find((x) => x.path === name);
    if (e === undefined) return null;
    // 🔴 类型必须**恰好**是 blob：一个同名的 tree / commit(gitlink) / symlink
    //    在这里被当成"文件读不出来"是不够的 —— 那会走到"文件不存在"那一支，
    //    于是保留清单被当成空的。
    if (e.type !== 'blob') throw new RemoteError(`registry/${name} 不是普通文件（type=${e.type}）—— 拒绝解读`);
    return e.sha;
  };

  // ③ 这条投稿路径在不在 base 里
  const existingSubmission = await resolvePath(client, UP, baseTreeSha, submissionSegments);

  return {
    upstreamId, baseCommitSha, baseTreeSha,
    existingSubmission,
    ...derivedFromTree(artifactPaths),
    ...(await readRegistryFiles(client, blobShaIn)),
  };
}

/**
 * 从 `artifacts/` 的路径清单派生「已有制品」。
 *
 * 布局：`artifacts/{skills,packs}/<ns>/<name>/<ver>/…`（01-artifacts.md §2）。
 * ⚠️ 这是本模块唯一一处**复刻**了 `run-gates.mjs` `main()` 里的逻辑而不是调用它
 *    （那边从磁盘 `readdirSync` 数，这边只有路径字符串）。有测试喂同一组输入、
 *    钉两者给出同一组 id。
 */
export function derivedFromTree(artifactPaths) {
  const existingIds = new Set();
  const byNs = new Map();
  for (const p of artifactPaths) {
    const parts = p.split('/');
    // artifacts / <kindDir> / <ns> / <name> / <ver> / …
    if (parts.length < 6) continue;
    const kind = parts[1] === 'skills' ? 'skill' : parts[1] === 'packs' ? 'pack' : null;
    if (kind === null) continue;
    const [, , ns, name, ver] = parts;
    existingIds.add(`${kind}:${ns}/${name}@${ver}`);
    if (!byNs.has(ns)) byNs.set(ns, new Set());
    byNs.get(ns).add(name);
  }
  return {
    existingIds: [...existingIds],
    existingNamesByNs: new Map([...byNs].map(([k, v]) => [k, [...v]])),
  };
}

/**
 * `registry/reserved.json` 与 `registry/owners.json` —— 从**同一棵 base 树**取，
 * 不从 npm 包里带。
 *
 * 🔴 为什么不打进 npm 包：它们是**仓库数据**，会随每次 promote 变。
 *    一个跟着 CLI 版本走的副本必然过期，而过期的保留清单意味着
 *    「本地放行、CI 拒绝」（新加的保留 namespace 本地看不见）。
 */
async function readRegistryFiles(client, blobShaIn) {
  const readText = async (name) => {
    const sha = blobShaIn(name);
    if (sha === null) return null;                       // 上游还没有这个文件
    const b = (await client.get(`${UP}/git/blobs/${seg(sha)}`)).json ?? {};
    if (b.encoding !== 'base64' || typeof b.content !== 'string') {
      throw new RemoteError(
        `registry/${name} 的 blob 不是 base64（encoding=${JSON.stringify(b.encoding)}）—— 拒绝解读`,
      );
    }
    // 🔴 `Buffer.from(…, 'base64')` 是**宽容**的：非法字符被静默跳过。
    //    回编码比一遍，让一个被截断/改坏的 content 变成一次失败，
    //    而不是"内容原来就是这样"。
    const buf = Buffer.from(b.content, 'base64');
    if (buf.toString('base64') !== b.content.replace(/\s/g, '')) {
      throw new RemoteError(`registry/${name} 的 base64 内容不自洽 —— 拒绝解读`);
    }
    return buf.toString('utf8');
  };

  const reserved = reservedFromText(await readText('reserved.json'));

  const ownersText = await readText('owners.json');
  let registeredNamespaces;
  if (ownersText === null) {
    registeredNamespaces = new Set();
  } else {
    let doc;
    try { doc = parseStrict(ownersText); } catch (e) {
      // 🔴 读不出来时**不能当成空的**：那会让每个 namespace 都被判成「首次注册」，
      //    于是任何人都能声明 claim_owner。与 `run-gates.readRegistered` 同一条判据。
      throw new RemoteError(
        `registry/owners.json 读不出来（${e.message}）—— 拒绝在「不知道谁注册过」的情况下判首次注册`,
      );
    }
    registeredNamespaces = new Set(Object.keys(doc.namespaces ?? {}));
  }
  return { reserved, registeredNamespaces };
}

/**
 * 远端取来的 `reserved.json` 字节 → `structural-gates.readReserved` 的产物。
 *
 * 🔴 **不重写它的解析。** `readReserved` 做三件事：`parseStrict`（拒重复 key ——
 *    `{"namespaces":[…],"namespaces":[]}` 能把整张保留清单清空而文件看着正常）、
 *    schema 核对、以及「保留清单内部同形折叠自撞」检查。在这里照抄一遍，
 *    就是又一处会与服务端分叉的实现，而分叉点正好是绕过点。
 *
 * ⚠️ 代价：它的入参是**文件路径**而我们手上是字节，所以要落一次隔离临时文件。
 *    内容是公开的注册表（不是凭据），用完即删。比"为了不落盘而复制一份解析逻辑"划算。
 */
function reservedFromText(text) {
  if (text === null) return { schema: 'geoly.skills.reserved/1', namespaces: [] };
  const d = mkdtempSync(join(tmpdir(), 'geoly-pub-'));
  try {
    const p = join(d, 'reserved.json');
    writeFileSync(p, text, { mode: 0o600 });
    return readReserved(p);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ── fork ────────────────────────────────────────────────────────────────────

/**
 * 保证认证用户名下有一个**上游的** fork，并核对它确实是。
 *
 * 🔴 核对的三条缺一不可：
 *   · `fork === true`      —— 一个同名的**普通**仓库不是 fork；
 *   · `owner.id === me.id` —— 用不可变 id 比，不比 login（login 可以改名 + 被别人认领）；
 *   · `parent.id === upstreamId` —— 「是个 fork」不等于「是**这个仓库**的 fork」。
 *   三条里少任何一条，我们都可能把投稿推进一个不属于用户、或者根本不指向上游的仓库。
 */
export async function ensureFork(client, {
  viewer, upstreamId, baseCommitSha, sleep = defaultSleep, maxWaitMs = 60000, now = Date.now,
}) {
  const path = forkPathFor(viewer.login);

  // 🔴🔴 **判据两边都必须是真的整数。** 这三条门写的是 `a !== b`，
  //    而 `undefined !== undefined` 为假 —— 于是两边都缺席时，
  //    门原地退化成恒真、放行任何 fork。上游 `getBaseline` / `getViewer`
  //    已经各自把 id 钉成整数了，**这里再钉一次**是纵深：
  //    那两处与这里相隔很远，将来有人绕过它们直接调 `ensureFork`
  //    （测试、别的命令）时，门不该跟着失效。
  const intOr = (v, what) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new RemoteError(
        `fork 身份核对拿不到整数的 ${what}（得到 ${JSON.stringify(v)}）—— 拒绝继续。\n`
        + '  🔴 判据缺席时 `a !== b` 会退化成恒真，那道门就等于没设。',
      );
    }
    return v;
  };
  intOr(upstreamId, 'upstream repo id');
  intOr(viewer.id, '认证用户 id');

  const check = (repo) => {
    if (repo.fork !== true) {
      throw new RemoteError(
        `${viewer.login}/${UPSTREAM_REPO} 存在，但它**不是** fork（fork=false）——\n`
        + '  拒绝往一个同名的普通仓库里写投稿。请改名或删掉它，再重跑。',
      );
    }
    if (intOr(repo.owner?.id, `${viewer.login}/${UPSTREAM_REPO} 的 owner.id`) !== viewer.id) {
      throw new RemoteError(
        `${viewer.login}/${UPSTREAM_REPO} 的 owner id 是 ${repo.owner?.id}，`
        + `而认证用户是 ${viewer.id} —— 拒绝继续。`,
      );
    }
    if (intOr(repo.parent?.id, `${viewer.login}/${UPSTREAM_REPO} 的 parent.id`) !== upstreamId) {
      throw new RemoteError(
        `${viewer.login}/${UPSTREAM_REPO} 是一个 fork，但它的 parent id 是 ${repo.parent?.id}，`
        + `不是 ${UPSTREAM_FULL}（id=${upstreamId}）——\n`
        + '  「是个 fork」不等于「是**这个仓库**的 fork」。拒绝继续。',
      );
    }
    return repo;
  };

  const probe = async () => {
    const r = await client.get(path, { softStatus: [404] });
    return r.status === 404 ? null : (r.json ?? {});
  };

  const existing = await probe();
  if (existing !== null) {
    const repo = check(existing);
    await assertForkHasBase(client, { login: viewer.login, baseCommitSha });
    return { repo, created: false };
  }

  // 🔴 POST 之前先查过了（上面那次）。POST 之后**再查**才算数：
  //    fork 是**异步**创建的，201 只表示"排上队了"。
  try {
    await client.post(`${UP}/forks`, {});
  } catch (e) {
    // 🔴 超时 / 5xx 时**不重发** —— 去查。fork 可能已经建出来了。
    //    ⚠️ 查不到也**不等于**那个 POST 没到 GitHub，所以下面轮询到期是以
    //    网络错误退出、请用户重跑，而不是再发一次。
    if (e?.timedOut !== true && !(e instanceof ApiHttpError && e.status >= 500)) throw e;
  }

  const deadline = now() + maxWaitMs;
  let delay = 1000;
  for (;;) {
    const repo = await probe();
    if (repo !== null) {
      check(repo);
      const ready = await client.get(
        `${path}/git/ref/heads/${seg(BASE_BRANCH)}`, { softStatus: [404, 409] },
      );
      if (ready.status === 200) {
        await assertForkHasBase(client, { login: viewer.login, baseCommitSha });
        return { repo, created: true };
      }
    }
    if (now() >= deadline) {
      throw new RemoteError(
        `等 ${viewer.login}/${UPSTREAM_REPO} 这个 fork 就绪超过 ${Math.round(maxWaitMs / 1000)} 秒。\n`
        + '  fork 是异步创建的，请稍后重跑 —— 本命令**先查后建**，不会重复建 fork。\n'
        + '  ⚠️ 到这一步为止**没有**建过任何分支或 PR。',
        { exitCode: 6 },
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }
}

/**
 * 🔴 fork 里必须真的读得到我们选定的那个 base commit —— 否则后面
 *    `base_tree` / `parents` 引用的对象在 fork 的网络里不存在，
 *    建 tree / commit 会以一个语焉不详的 422 失败，而真正的原因
 *    （fork 刚建出来、对象还没同步完）在那条错误里根本看不出来。
 */
async function assertForkHasBase(client, { login, baseCommitSha }) {
  const r = await client.get(
    `${forkPathFor(login)}/git/commits/${seg(baseCommitSha)}`, { softStatus: [404, 409, 422] },
  );
  if (r.status !== 200) {
    throw new RemoteError(
      `你的 fork ${login}/${UPSTREAM_REPO} 里读不到上游 ${BASE_BRANCH} 的 commit ${baseCommitSha}`
      + `（HTTP ${r.status}）。\n`
      + '  fork 刚建出来时对象同步需要一点时间；请稍后重跑。\n'
      + '  ⚠️ 到这一步为止**没有**建过任何分支或 PR。',
      { exitCode: 6 },
    );
  }
}

const defaultSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── 重复投稿检测 ────────────────────────────────────────────────────────────

/**
 * 同版本可能已经在**另一个未合并的 PR** 里 —— 只看 `artifacts/` 是看不见的。
 *
 * 🔴 **判据是沿 PR 的 `head.sha` 逐层解析那条路径，不是读 `/pulls/<n>/files`。**
 *    files 列表会分页、也会被 GitHub 截断，而"我只看了第一页所以没看到"
 *    与"它不在里面"是两件完全不同的事 —— 前者是不知道，后者才是放行。
 *    tree 解析每一层都完整读过：基线已经证明这条路径在 base 上不存在，
 *    所以**任何**开放 PR 的 head 上出现它，就是冲突。
 *
 * ⚠️ **诚实边界（请读完再信这道门）**：它证明的是**扫描那一瞬间**没有冲突。
 *    扫完之后立刻有人开新 PR / 往已有 PR 推新 commit，这里什么都不知道。
 *    **它不是并发正确性门**，只是一次 UX 上的提前告知 —— 最终裁决在服务端的
 *    PR gate 与 promote。
 *
 * 🔴 分页预算用尽 → `getAllPages` 抛 `TruncatedError`，**不在这里吞掉**：
 *    一个静默截断的重复检测，比没有这道门更坏。
 */
export async function findOpenDuplicates(client, { submissionSegments, maxPages = 10 }) {
  const pulls = await getAllPages(client, `${UP}/pulls?state=open`, { perPage: 100, maxPages });
  const matches = [];
  for (const pr of pulls) {
    const headSha = pr.head?.sha;
    if (typeof headSha !== 'string') {
      throw new RemoteError(`PR #${pr.number} 没有 head.sha —— 拒绝在看不全的情况下宣布"没有重复"`);
    }
    // 🔴 从**上游**仓库解析：PR 的 head commit 通过 `refs/pull/<n>/head` 在上游可读，
    //    即使它长在别人的 fork 上。
    const commit = await client.get(`${UP}/git/commits/${seg(headSha)}`, { softStatus: [404, 422] });
    if (commit.status !== 200) {
      throw new RemoteError(
        `读不到 PR #${pr.number} 的 head commit ${headSha}（HTTP ${commit.status}）——\n`
        + '  拒绝在"有一个 PR 没查成"的情况下宣布没有重复投稿。',
        { exitCode: 6 },
      );
    }
    const rootTree = commit.json?.tree?.sha;
    if (typeof rootTree !== 'string') {
      throw new RemoteError(`PR #${pr.number} 的 head commit 没有 tree sha —— 拒绝继续`);
    }
    if (await resolvePath(client, UP, rootTree, submissionSegments) !== null) {
      matches.push({
        number: pr.number, title: pr.title, url: pr.html_url,
        author: pr.user?.login ?? '(未知)',
      });
    }
  }
  return { matches, scanned: pulls.length };
}

// ── 写：blob → tree → commit → ref ─────────────────────────────────────────

/**
 * 分支名。`tree_digest` 前 8 位做后缀 —— 内容变了就是另一个分支，**从不复用**。
 *
 * 🔴 出厂前过一道**字符白名单**。分支名会被拼进我们自己发出去的 API URL，
 *    而 `encodeURI` **不转义** `?` `#` `&`（它们是 URI 的保留字符）——
 *    一个混进这三个字符的分支名能往我们的请求里注入 query / fragment。
 *    ⚠️ 上游 `readIdentity` 已经用共享 grammar 把 ns/name/version 钉死了，
 *    所以今天走不到这里。**留着是因为这道门与那道门相隔很远**：
 *    哪天有人放宽了 version 的 grammar，这里会当场失败，而不是悄悄发出
 *    一个被注入的请求。
 */
const RE_SAFE_BRANCH = /^[A-Za-z0-9._@/+-]+$/;

export function branchName({ namespace, name, version, treeDigest }) {
  const hex = /:([0-9a-f]{64})$/.exec(treeDigest)?.[1];
  if (hex === undefined) throw new RemoteError(`认不得的 tree_digest 形状：${treeDigest}`);
  const b = `submit/${namespace}/${name}@${version}-${hex.slice(0, 8)}`;
  if (!RE_SAFE_BRANCH.test(b) || b.includes('..') || b.includes('//') || b.endsWith('/')) {
    throw new RemoteError(
      `拒绝使用分支名 ${JSON.stringify(b)} —— 它含有会被拼进 API URL 的危险字符。\n`
      + '  这是由 manifest 的 namespace / name / version 拼出来的，请检查那三个字段。',
    );
  }
  return b;
}

/**
 * 🔴 分支已存在 → **只读、核对、报告，不改写**。
 *    不 force-push、不 amend 是硬约束：那两个动作会让别人已经看过 / 审过的东西
 *    在他不知情的时候变掉。
 */
export async function assertBranchFree(client, { login, branch }) {
  const r = await client.get(
    `${forkPathFor(login)}/git/ref/heads/${encodeURI(branch)}`, { softStatus: [404] },
  );
  if (r.status === 404) return null;
  const sha = r.json?.object?.sha ?? '(未知)';
  throw new RemoteError(
    `你的 fork 上已经有分支 ${branch}（指向 ${sha}）——\n`
    + '  🔴 本命令**不会** force-push、也不会 amend 已有分支：那会让别人已经看过的\n'
    + '     内容在他不知情时变掉。\n'
    + '  ⚠️ 分支名带了内容摘要，所以同名意味着**同一份字节**已经推上去过了。\n'
    + '  怎么办：去 GitHub 上看那个分支（也许 PR 已经开着了）；\n'
    + '  确实要重来就手动删掉它，再重跑本命令。',
    { branch, sha, exitCode: 3 },
  );
}

/**
 * 建 blob → tree → commit，**最后**一次性建 ref。
 *
 * 🔴 顺序是安全语义的一部分：ref 之前的三步产出的都是**不可见的 object**，
 *    中途失败在仓库上什么都看不见。反过来（先建分支再一个个写文件 ——
 *    Contents API 的形状）失败会留下**半棵可见的投稿树**，而我们的
 *    「同名分支只读、不改写」策略会让那棵半成品谁也收拾不了。
 *
 * 🔴 `mode` 必须原样带过去（`100644` / `100755`）。Contents API 没有这个字段，
 *    那正是它不能用的根本原因：mode 进 `tree_digest`（同字节不同 mode 是两个
 *    不同摘要），也进 capability 语义（`executableEvidence` 看的就是可执行位）。
 */
export async function pushSubmission(client, {
  login, branch, files, baseTreeSha, baseCommitSha, message,
}) {
  const fp = forkPathFor(login);

  const treeItems = [];
  for (const f of files) {
    if (f.mode !== 0o644 && f.mode !== 0o755) {
      throw new RemoteError(`内部错误：${f.repoPath} 的 mode 是 0${f.mode.toString(8)}，只允许 0644/0755`);
    }
    const b = await client.post(`${fp}/git/blobs`, {
      content: f.data.toString('base64'), encoding: 'base64',
    });
    const sha = b.json?.sha;
    if (typeof sha !== 'string') throw new RemoteError(`建 blob 失败：${f.repoPath} 没有拿到 sha`);
    treeItems.push({
      path: f.repoPath, mode: f.mode === 0o755 ? '100755' : '100644', type: 'blob', sha,
    });
  }

  const tr = await client.post(`${fp}/git/trees`, { base_tree: baseTreeSha, tree: treeItems });
  const newTreeSha = tr.json?.sha;
  if (typeof newTreeSha !== 'string') throw new RemoteError('建 tree 失败：没有拿到 sha');

  const cm = await client.post(`${fp}/git/commits`, {
    message, tree: newTreeSha, parents: [baseCommitSha],
  });
  const commitSha = cm.json?.sha;
  if (typeof commitSha !== 'string') throw new RemoteError('建 commit 失败：没有拿到 sha');

  try {
    await client.post(`${fp}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitSha });
  } catch (e) {
    if (e instanceof ApiHttpError && e.status === 422) {
      throw new RemoteError(
        `建分支 ${branch} 时它已经存在了（422）—— 拒绝改写。\n`
        + `  你要的那个 commit 已经建好了（${commitSha}），但**没有**任何分支指向它，\n`
        + '  所以仓库上看不到任何变化。请手动处理已有分支后重跑。',
        { exitCode: 3 },
      );
    }
    if (e?.timedOut === true) {
      // 🔴 建 ref 超时：**读回**。ref 是三个非幂等 POST 里唯一能被读回**确证**的 ——
      //    它指向的 sha 要么正是我们这次建的 commit（成功），要么是别的（冲突）。
      //    fork 与 PR 没有这种"内容自证"的性质，所以它们只能以网络错误退出。
      const now = await client.get(`${fp}/git/ref/heads/${encodeURI(branch)}`, { softStatus: [404] });
      if (now.status === 200 && now.json?.object?.sha === commitSha) {
        return { commitSha, newTreeSha, treeItems };
      }
      if (now.status === 200) {
        throw new RemoteError(
          `建分支 ${branch} 超时后读回，它指向 ${now.json?.object?.sha}，不是我们建的 ${commitSha}`
          + ' —— 拒绝改写。',
          { exitCode: 3 },
        );
      }
    }
    throw e;
  }
  return { commitSha, newTreeSha, treeItems };
}

// ── 写完之后的核对 ──────────────────────────────────────────────────────────

/**
 * 🔴🔴 **这里是最容易写成「看起来守住了」的地方，所以判据要说清楚。**
 *
 * 一个**不够**的写法（我第一版就是它，Codex 2026-09-05 挑出来的）：
 * 用 `GET /compare/main...<login>:<branch>` 断言 `files` 恰好是我们那批路径。
 * 它有两个致命盲区：
 *   · `compare` 的 `files` **最多 300 条且不分页**，而载荷最多允许 2000 个文件
 *     （`src/untar.mjs` 的 MAX_FILES）—— 超过 300 之后它给的就是一个截断的清单，
 *     而"清单里没有别的东西"在截断下毫无意义；
 *   · `compare` **看不见 mode**。而 mode 正是我们放弃 Contents API 的全部理由。
 * 再补一次整仓 `?recursive=1` 也不行：它同样会随仓库增长而截断，
 * 而"先拿到结果再过滤前缀"已经太晚 —— 被截掉的可能正是要找的那部分。
 *
 * **够的写法（本函数）**：沿着 tree 结构逐层证明，每一层都不可能被截断。
 *   ① ref 指向我们建的那个 commit；
 *   ② 那个 commit 的**唯一** parent 是固定的 base commit，tree 是我们建的那棵；
 *   ③ 从 root 起逐层比 base tree 与 new tree：**除了通往投稿目录的那一条链，
 *      每一层的其余条目 `path + type + mode + sha` 全等** ——
 *      这证明"没有动别的任何东西"，且不依赖任何会截断的清单；
 *   ④ 投稿目录那一棵递归读（≤ 2000 条，且查 truncated），
 *      blob 的 `path + mode + sha` 集合与我们上传的集合**严格相等**。
 *
 * ⚠️ 比较一律按**集合 + 计数**，不依赖 GitHub 返回条目的顺序。
 * ⚠️ 核对失败时**不自动清理**分支：不 force-push / 不删是硬约束，
 *    而且一个核对不过的分支正是需要人去看的东西。
 */
export async function verifyBranch(client, {
  login, branch, segments, treeItems, commitSha, newTreeSha, baseCommitSha, baseTreeSha,
}) {
  const fp = forkPathFor(login);
  const stop = (msg, extra = '') => {
    throw new RemoteError(
      `🔴 核对失败：${msg}\n${extra}`
      + `  ⚠️ 分支 ${branch} 已经建出来了，本命令**不会**自动删它（不 force-push 是硬约束）。\n`
      + '  请人工检查后手动处理。**没有**开 PR。',
      { exitCode: 2 },
    );
  };

  // ① ref → commit
  const ref = (await client.get(`${fp}/git/ref/heads/${encodeURI(branch)}`)).json ?? {};
  if (ref.object?.sha !== commitSha) {
    stop(`分支 ${branch} 指向 ${ref.object?.sha}，不是我们建的 ${commitSha}`);
  }

  // ② commit → parent / tree
  const cm = (await client.get(`${fp}/git/commits/${seg(commitSha)}`)).json ?? {};
  const parents = Array.isArray(cm.parents) ? cm.parents.map((p) => p.sha) : [];
  if (parents.length !== 1 || parents[0] !== baseCommitSha) {
    stop(`commit 的 parent 是 [${parents.join(', ')}]，应当恰好是 [${baseCommitSha}]`);
  }
  if (cm.tree?.sha !== newTreeSha) stop(`commit 的 tree 是 ${cm.tree?.sha}，不是 ${newTreeSha}`);

  // ③ 逐层比：除了通往投稿目录那一条链，其余全等
  let baseSha = baseTreeSha;
  let newSha = newTreeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const name = segments[i];
    const where = segments.slice(0, i).join('/') || '<仓库根>';
    const baseEntries = baseSha === null ? [] : await getTree(client, UP, baseSha);
    const newEntries = await getTree(client, fp, newSha);

    const key = (e) => `${e.path}\0${e.type}\0${e.mode}\0${e.sha}`;
    const baseRest = baseEntries.filter((e) => e.path !== name).map(key).sort();
    const newRest = newEntries.filter((e) => e.path !== name).map(key).sort();
    if (baseRest.length !== newRest.length || baseRest.some((x, k) => x !== newRest[k])) {
      const only = (a, b) => a.filter((x) => !b.includes(x)).map((x) => x.split('\0')[0]);
      stop(
        `${where} 这一层，除了 ${name} 之外还动了别的条目。`,
        `  多出来：${only(newRest, baseRest).join('、') || '(无)'}\n`
        + `  少掉了：${only(baseRest, newRest).join('、') || '(无)'}\n`,
      );
    }

    const newChild = newEntries.find((e) => e.path === name);
    if (newChild === undefined || newChild.type !== 'tree') {
      stop(`新树里 ${where}/${name} 不存在或不是目录`);
    }
    const baseChild = baseEntries.find((e) => e.path === name);
    // 🔴 最后一段（投稿目录本身）**必须是新增的** —— 它在 base 上存在就是覆盖。
    if (i === segments.length - 1 && baseChild !== undefined) {
      stop(`${segments.join('/')} 在上游 base 上已经存在 —— publish 只新增，绝不覆盖。`);
    }
    baseSha = baseChild === undefined ? null : baseChild.sha;
    newSha = newChild.sha;
  }

  // ④ 投稿目录那一棵：递归读，blob 集合严格相等
  const leaf = await getTree(client, fp, newSha, { recursive: true });
  const prefix = `${segments.join('/')}/`;
  const nonBlob = leaf.filter((e) => e.type !== 'blob' && e.type !== 'tree');
  if (nonBlob.length > 0) {
    stop(`投稿目录里有非文件条目：${nonBlob.map((e) => `${e.path}(${e.type})`).join('、')}`);
  }
  const want = new Map(treeItems.map((t) => [t.path, `${t.mode}\0${t.sha}`]));
  const got = new Map(leaf.filter((e) => e.type === 'blob').map((e) => [prefix + e.path, `${e.mode}\0${e.sha}`]));
  if (want.size !== got.size) {
    stop(`投稿目录下有 ${got.size} 个文件，我们上传了 ${want.size} 个。`);
  }
  for (const [p, v] of want) {
    const g = got.get(p);
    if (g === undefined) stop(`新树里没有 ${p}`);
    if (g !== v) {
      const [gm, gs] = g.split('\0');
      const [wm, ws] = v.split('\0');
      stop(
        gm !== wm ? `${p} 的 mode 是 ${gm}，我们要的是 ${wm}` : `${p} 的 blob sha 是 ${gs}，我们要的是 ${ws}`,
        gm !== wm ? '  mode 进 tree_digest —— 它错了，制品身份就是另一个。\n' : '',
      );
    }
  }
  return { commitSha, files: [...want.keys()] };
}

// ── PR ──────────────────────────────────────────────────────────────────────

/** 已有的、head 指向这个分支的 PR（任何状态）。POST 之前查、POST 超时后也查。 */
export async function findPrForHead(client, { login, branch }) {
  const r = await client.get(`${UP}/pulls?state=all&head=${seg(`${login}:${branch}`)}`);
  const arr = Array.isArray(r.json) ? r.json : [];
  return arr.length > 0 ? arr[0] : null;
}

export async function openPullRequest(client, {
  login, branch, title, body, viewer, forkId, upstreamId, commitSha,
}) {
  // 🔴 POST 之前先查：`POST /pulls` 不是幂等的，重发会开出第二个 PR。
  const already = await findPrForHead(client, { login, branch });
  if (already !== null) {
    throw new RemoteError(
      `这个分支上已经有 PR #${already.number}（${already.state}）：${already.html_url}\n`
      + '  🔴 本命令**不会**再开一个，也不会改写已有的那个 —— 只读取、核对、报告。',
      { exitCode: 3, prNumber: already.number, prUrl: already.html_url },
    );
  }

  let pr;
  try {
    pr = (await client.post(`${UP}/pulls`, {
      title, body, head: `${login}:${branch}`, base: BASE_BRANCH, maintainer_can_modify: true,
    })).json;
  } catch (e) {
    if (e?.timedOut !== true) throw e;
    // 🔴 超时之后**先查再说**，绝不盲目重发。
    //    ⚠️ 查不到**不等于**那个 POST 没到 GitHub —— 所以这里以网络错误退出、
    //    请用户重跑（重跑会先查，看到就不再开），而不是自己再发一次。
    const found = await findPrForHead(client, { login, branch });
    if (found === null) {
      throw new RemoteError(
        `开 PR 的请求超时，且随后查不到 head=${login}:${branch} 的 PR。\n`
        + '  🔴 **这不能证明那个请求没有到达 GitHub。** 拒绝重发（重发可能开出第二个 PR）。\n'
        + `  分支 ${branch} 已经推上去了。请去 ${UPSTREAM_FULL} 看一眼；\n`
        + '  确认没有 PR 之后重跑本命令（它会先查，看到已有的就不再开）。',
        { exitCode: 6 },
      );
    }
    pr = found;
  }

  return assertPr(pr, { branch, viewer, forkId, upstreamId, commitSha });
}

/**
 * PR 建完之后的核对 —— 六条，**全部用不可变 id / 精确字符串**。
 *
 * 🔴 为什么要核对我们自己刚发的东西：`head: "<login>:<branch>"` 是一个**字符串**，
 *    服务端怎么解读它（login 与某个 org 重名、分支名含特殊字符、fork 被改名）
 *    不是我们说了算。核对的是**结果**，不是我们的意图。
 */
export function assertPr(pr, { branch, viewer, forkId, upstreamId, commitSha }) {
  if (pr === null || typeof pr !== 'object') throw new RemoteError('开 PR 之后没有拿到 PR 对象', { exitCode: 2 });
  const fail = (msg) => {
    throw new RemoteError(
      `🔴 PR #${pr.number} 建出来了，但核对不过：${msg}\n`
      + `  ${pr.html_url ?? ''}\n`
      + '  本命令**不会**自动关掉或改写它。请人工检查。',
      { exitCode: 2, prNumber: pr.number, prUrl: pr.html_url },
    );
  };
  // 🔴 同 `ensureFork`：id 两边都缺席时 `!==` 退化成恒真。先把判据本身钉成整数。
  for (const [what, v] of [['fork id', forkId], ['上游 repo id', upstreamId], ['认证用户 id', viewer.id],
    ['PR 的 head.repo.id', pr.head?.repo?.id], ['PR 的 base.repo.id', pr.base?.repo?.id],
    ['PR 作者 id', pr.user?.id]]) {
    if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${what} 不是整数（得到 ${JSON.stringify(v)}）`);
  }
  if (pr.head?.repo?.id !== forkId) fail(`head 仓库 id 是 ${pr.head?.repo?.id}，应为你的 fork（${forkId}）`);
  if (pr.head?.ref !== branch) fail(`head 分支是 ${JSON.stringify(pr.head?.ref)}，应为 ${branch}`);
  if (pr.head?.sha !== commitSha) fail(`head sha 是 ${pr.head?.sha}，应为 ${commitSha}`);
  if (pr.base?.repo?.id !== upstreamId) fail(`base 仓库 id 是 ${pr.base?.repo?.id}，应为 ${UPSTREAM_FULL}（${upstreamId}）`);
  if (pr.base?.ref !== BASE_BRANCH) fail(`base 分支是 ${JSON.stringify(pr.base?.ref)}，应为 ${BASE_BRANCH}`);
  if (pr.user?.id !== viewer.id) fail(`PR 作者 id 是 ${pr.user?.id}，应为认证用户 ${viewer.id}`);
  return { number: pr.number, url: pr.html_url, state: pr.state };
}
