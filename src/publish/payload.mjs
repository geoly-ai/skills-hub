// `publish` 的**本地**预检 —— 载荷冻结、暂存、跑既有的投稿门。
//
// ── 🔴 这一层是 UX，不是信任门 ────────────────────────────────────────────
//
// 真正的判定在服务端的 PR gate（`.github/workflows/validate-pr.yml` 从 **base**
// 那棵树跑 `base-tools/scripts/submission/*`）。这里做的事只有一个目的：
// **让投稿者在开 PR 之前就看到会红的地方**，而不是开完 PR 再被 CI 打回来。
//
// 因此本模块的纪律是：**一条自己的校验规则都不写。** 全部调 `scripts/submission/`
// 与 `src/` 里现成的那几个。另写一套的结局只有两个 —— 「本地绿、CI 红」，
// 或者两套规则各自演化然后分叉，而分叉点正好是绕过点（R-11 反复出现的形状）。

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parseStrict } from '../canonical-json.mjs';
import { parseArtifactId } from '../pack.mjs';
import { collectTree } from '../packer.mjs';
import { treeDigest } from '../tree-digest.mjs';
import { createIsolatedDir, writeEntries } from '../artifact.mjs';
import { runGates } from '../../scripts/submission/run-gates.mjs';
import { scanTree, format as formatScan } from '../../scripts/submission/scan-text.mjs';
import { assertArtifactPath } from '../untar.mjs';

export class PayloadError extends Error {
  /** 「你的投稿不合规」是**用法错误**，不是制品完整性问题 —— 09-cli.md §6。 */
  constructor(message, extra = {}) {
    super(message); this.name = 'PayloadError'; this.exitCode = 1; Object.assign(this, extra);
  }
}

/** `submissions/<ns>/<name>@<ver>/`。**唯一**允许写的前缀。 */
export const submissionPrefix = (ns, name, version) => `submissions/${ns}/${name}@${version}/`;

/**
 * 读 manifest，定 kind / namespace / name / version。
 *
 * 🔴 `skill.json` 与 `pack.json` **恰好有一个** —— 两个都在时「这是什么制品」
 *    有两个答案，而下游每个校验器只读其中一个。这与 `run-gates.mjs` ③ 处
 *    以及 `packer.packArtifact` 的判据是同一条，这里提前报，好让错误指向源目录
 *    而不是暂存目录。
 */
export function readIdentity(payloadDir) {
  const has = (f) => { try { return readFileSync(join(payloadDir, f), 'utf8'); } catch { return null; } };
  const skill = has('skill.json');
  const pack = has('pack.json');
  if ((skill === null) === (pack === null)) {
    throw new PayloadError(
      `载荷根必须**恰好**有 skill.json 或 pack.json 其中一个`
      + `（现在 skill.json=${skill !== null}、pack.json=${pack !== null}）——\n`
      + '  两个都在时「这是什么制品」有两个答案；一个都没有时 publish 不知道该投什么。',
    );
  }
  const kind = skill !== null ? 'skill' : 'pack';
  let doc;
  try {
    // 🔴 `parseStrict` 不是 `JSON.parse`：11-wire-contract.md §2 要求拒绝重复 key。
    //    `{"version":"1.0.0","version":"9.9.9"}` 在 JSON.parse 下静默取最后一个 ——
    //    于是本地看到的版本与服务端看到的可以不是同一个。
    doc = parseStrict(kind === 'skill' ? skill : pack);
  } catch (e) {
    throw new PayloadError(`${kind}.json 解析失败：${e.message}`);
  }
  for (const k of ['namespace', 'name', 'version']) {
    if (typeof doc[k] !== 'string' || doc[k] === '') {
      throw new PayloadError(`${kind}.json 缺少字符串字段 ${k} —— publish 靠它决定投到哪个路径。`);
    }
  }
  // 🔴🔴 **ns / name / version 的 grammar 必须在这里就钉死**，而且要用**共享**的
  //    那一份（`pack.parseArtifactId` = 01-artifacts.md §3 的 RE_NAMESPACE /
  //    RE_NAME + 禁 `+build` 的 semver）。
  //
  //    为什么这条不是可有可无的整洁：这三个字段是**投稿者完全可控**的，而它们
  //    接下来会走进
  //      · 仓库路径前缀 `submissions/<ns>/<name>@<ver>/`
  //      · **分支名**，而分支名会被拼进我们自己发出去的 API URL。
  //    一个 `version: "1.0.0?x="` 或 `"1.0.0#y"` 经 `encodeURI` **不会**被转义
  //    （`?` `#` `&` 都是 encodeURI 的保留字符），于是它能往我们的请求里注入
  //    query / fragment —— 那是一次实打实的请求伪造，而载荷里每个文件的相对
  //    路径看起来都完全正常。
  //    ⚠️ 光靠"路径逐段校验"抓不到它：`?` 与 `#` 在路径里是合法字符。
  let parsed;
  try {
    parsed = parseArtifactId(`${kind}:${doc.namespace}/${doc.name}@${doc.version}`, `${kind}.json`);
  } catch (e) {
    throw new PayloadError(
      `${kind}.json 的 namespace / name / version 不合 grammar（01-artifacts.md §3）：${e.message}`,
    );
  }
  return {
    kind, namespace: parsed.namespace, name: parsed.name, version: parsed.version,
    manifest: doc, id: parsed.id,
  };
}

/**
 * 目标仓库路径的逐段校验。
 *
 * 🔴 **`collectTree` 已经对载荷内的相对路径跑过 `assertArtifactPath` 了，
 *    这里查的是别的东西**：拼接之后的**完整仓库相对路径**。
 *    namespace / name / version 来自 manifest（投稿者完全可控），它们没经过
 *    载荷路径的 grammar —— 一个 `version: "../../.github"` 会让前缀跑出
 *    `submissions/` 之外，而载荷里每个文件的相对路径看起来都完全正常。
 *
 * 🔴 百分号解码这一格：GitHub 的 tree API 收的是**字面路径**，不做 URL 解码，
 *    所以 `%2F` 在 git 里就是三个普通字符、不构成目录分隔。但我们仍然拒 ——
 *    理由不是 git 会误解，而是**下游会**：PR 页面、workflow 里的 shell、
 *    `git diff --name-only` 的消费者各自有各自的解码习惯，而路径白名单是按
 *    前缀字符串判的。一个解码后含 `/` 的段，是在给"这条路径到底是几层"留两个答案。
 */
export function assertRepoPath(repoPath, { prefix }) {
  if (!repoPath.startsWith(prefix)) {
    throw new PayloadError(`路径 ${JSON.stringify(repoPath)} 不在允许的前缀 ${prefix} 之下`);
  }
  const segs = repoPath.split('/');
  for (const s of segs) {
    if (s === '') throw new PayloadError(`路径 ${JSON.stringify(repoPath)} 含空段（前导/尾随/连续斜杠）`);
    if (s === '.' || s === '..') throw new PayloadError(`路径 ${JSON.stringify(repoPath)} 含 ${JSON.stringify(s)} 段`);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(s)) throw new PayloadError(`路径 ${JSON.stringify(repoPath)} 含控制字符`);
    if (s.includes('\\')) throw new PayloadError(`路径 ${JSON.stringify(repoPath)} 含反斜杠`);
    let decoded;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      // 🔴 解不开也**拒**，不是"用原样继续查"。一个含 `%` 却不是合法转义的段
      //    （`%zz`、`%e0%a4`）在不同消费者手里会得到不同结果，而这道门的全部
      //    意义就是不留"两个答案"。
      throw new PayloadError(
        `路径段 ${JSON.stringify(s)} 含无法解码的百分号转义 —— 拒绝。`,
      );
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded === '..') {
      throw new PayloadError(
        `路径段 ${JSON.stringify(s)} 百分号解码之后是 ${JSON.stringify(decoded)} —— 拒绝。\n`
        + '  🔴 一条解码后含分隔符的路径段，是在给「这条路径到底是几层」留两个答案，\n'
        + '     而下游的路径白名单是按前缀字符串判的。',
      );
    }
  }
  if (repoPath.startsWith('/')) throw new PayloadError(`路径 ${JSON.stringify(repoPath)} 是绝对路径`);
  return true;
}

/**
 * 冻结载荷 → 暂存成 `submissions/<ns>/<name>@<ver>/` → 跑既有的门。
 *
 * 🔴 **只读一次盘。** `collectTree` 的产物（path/mode/data）就是我们**唯一**的
 *    那份字节；之后算摘要、跑门、传 blob 全用它。
 *    直接在源目录上算摘要、然后再从源目录读一次去上传，是两次读 ——
 *    两次之间源文件被改（编辑器保存、另一个进程在跑），产出的 `tree_digest`
 *    与实际上传的字节就是两棵树，而这要到安装端重算摘要时才会被发现。
 *
 * @param {object} [o]
 * @param {function} [o.afterFreeze]
 *   🔴 **测试注入点，生产路径永远不传。** 在载荷冻结（`collectTree` 返回）之后、
 *   算摘要之前调用一次。它存在的唯一理由是：让「冻结之后源目录再怎么变都影响不到
 *   我们要上传的那份字节」这条**可以被测试证明**，而不是只能靠读代码相信。
 *   没有它的话，「摘要从暂存树算」与「摘要从源目录算」这两种写法在所有正常输入下
 *   结果相同 —— 于是把它改坏也不会有任何测试变红（Codex 2026-09-05 指出，
 *   我当时误判成"等价变异"）。
 *
 * @returns {{entries, treeDigest, prefix, files, gateProblems, scanLines, staging}}
 */
export function stagePayload(payloadDir, identity, { parent = undefined, afterFreeze = null } = {}) {
  const entries = collectTree(payloadDir);          // ← 唯一一次读盘
  const prefix = submissionPrefix(identity.namespace, identity.name, identity.version);

  // 前缀本身要先过一遍：ns/name/version 是投稿者可控的
  for (const s of prefix.slice(0, -1).split('/')) {
    if (s === '' || s === '.' || s === '..') {
      throw new PayloadError(
        `投稿目录前缀 ${JSON.stringify(prefix)} 不合法 —— 它由 manifest 的 `
        + 'namespace / name / version 拼成，请检查这三个字段。',
      );
    }
  }

  const files = entries.map((e) => {
    const repoPath = prefix + e.path;
    assertRepoPath(repoPath, { prefix });
    // 载荷内相对路径的 grammar 再跑一遍（`collectTree` 跑过；这里是纵深，
    // 且它覆盖的是"我们即将发出去的那个字符串"，不是"我们读进来的那个"）。
    assertArtifactPath(e.path, `publish:${repoPath}`);
    return { repoPath, relPath: e.path, mode: e.mode, data: e.data };
  });

  // 🔴 冻结完成。从这里往下**再也不碰 `payloadDir`** —— 摘要、门、上传全用
  //    上面那份 `entries`。测试用 `afterFreeze` 在这一刻改动源目录来证明这一点。
  if (typeof afterFreeze === 'function') afterFreeze();

  // 暂存：把**这份字节**写成一棵真的 `submissions/` 树，然后让现成的门去跑它。
  const staging = createIsolatedDir(parent);
  try {
    writeEntries(staging, files.map((f) => ({ path: f.repoPath, mode: f.mode, data: f.data })));
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return {
    entries, files, prefix, staging,
    payloadDir: join(staging, prefix.slice(0, -1)),
    // 🔴 摘要算的是**暂存树**（= 我们即将上传的那棵），不是源目录。
    //    与 `packer.packDirectory` 同一条纪律：判据必须落在我们手上的那份字节上。
    treeDigest: treeDigest(join(staging, prefix.slice(0, -1))),
  };
}

/**
 * 跑既有的结构门 + 字符扫描。**一条规则都不在这里写。**
 *
 * @param {object} a
 * @param {string} a.staging          `stagePayload` 的暂存根（里面是 `submissions/…`）
 * @param {object} a.baseline         从上游 base 树派生的事实（见 `remote.mjs`）
 * @returns {{problems:string[], scanLines:string[], scanErrors:number}}
 */
export function runLocalGates({ staging, baseline }) {
  const { checked, problems } = runGates({
    submissionsRoot: join(staging, 'submissions'),
    reserved: baseline.reserved,
    existingIds: baseline.existingIds,
    existingNamesByNs: baseline.existingNamesByNs,
    registeredNamespaces: baseline.registeredNamespaces,
    // 🔴 **恒为 false**：「是不是维护者」是 PR 侧的事实，本地无从证明。
    //    传 true 会让保留 namespace 在本地被放行、然后在 CI 上被拒 ——
    //    正是「本地绿、CI 红」。fail-closed 与服务端默认值一致。
    byMaintainer: false,
  });
  if (checked !== 1) {
    throw new PayloadError(`内部错误：暂存树里应当恰好有 1 个投稿，实际 ${checked} 个`);
  }
  const scan = scanTree(join(staging, 'submissions'));
  return {
    problems,
    scanLines: formatScan(scan),
    // 🔴 `forbidden` 是**服务端会拒**的那一档（不可见字符 / bidi / symlink）；
    //    `suspicious` / `mixedScript` / `compatibility` 只是要人看一眼。
    //    两者分开数，不要混成一个"有几条告警"。
    scanErrors: scan.forbidden.length,
  };
}
