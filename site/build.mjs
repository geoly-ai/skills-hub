#!/usr/bin/env node
// 站点数据管道：签名快照 → `site/.generated/site-data.json`。
//
// 🔴 **这一步必须跑在 `next build` 之前**（package.json 的 `prebuild` 已经接好）。
//    页面直接 `import` 那份 JSON，所以它是**构建期输入**，运行时不再读任何东西 ——
//    站点上线后不查后端、不发请求，页面上写的每个字都在构建那一刻就定死了。
//
// 🔴 **快照不存在时正常退出（码 0）并产出空状态数据**，不是报错。
//    registry 现在就是空的：`registry/snapshots/` 与 `artifacts/` 都还不存在，
//    一个已发布制品都没有。这是仓库有意的 fail-closed 状态（docs/m3/02-decisions.md），
//    不是构建故障 —— 把它当故障，站点就永远上不了线，而"registry 是空的"
//    恰恰是现在最需要被如实说出来的那句话。

import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SNAPSHOTS_DIR, ARTIFACTS_DIR, REPO_ROOT, DATA_FILE } from './lib/paths.mjs';
import { loadNewestSnapshot } from './lib/snapshot-source.mjs';
import { readVerifiedManifest } from './lib/payload.mjs';
import { buildModel } from './lib/model.mjs';

/**
 * 🔴 **本站点不做验签，这句话必须原样出现在页面上。**
 *    验 Sigstore 签名要三样东西，本站点一样都没有：`timestamp.json`（只作为 Release
 *    资产分发，仓库里不存，02-registry.md §3.2）、`.sigstore.json` bundle、内置 TUF 根。
 *    所以站点能证明的只有「仓库工作树里这个文件长这样、严格解析得开、sha256 是这个」，
 *    证不了「它是真的」「它是当前的」。
 *    含糊其辞（比如写"数据来自签名快照"就不往下说）比不写更坏：读者会以为验过了。
 */
const TRUST_STATEMENT = '本页读取的是仓库工作树里的 registry/snapshots/hub-<N>.json。'
  + '构建时只做了严格的 schema / canonical 解析，并在本地算了一次 SHA-256；'
  + '没有读 timestamp.json、没有读 Sigstore bundle、没有内置 TUF 信任根，'
  + '因此没有执行任何验签，证明不了这张快照是真的、是当前的、或未被改动过。'
  + '权威校验请用 CLI 的正常命令（它会走完 02-registry.md §6 的验证链）。';

/**
 * 埋点为什么给不出使用情况 —— 页面上要能解释"为什么这里没有那类数字"。
 *
 * ⚠️ 这句话本身**刻意不列举**那些词。site/test/export.test.mjs 会扫全部产物、
 *    把一整批表示使用情况的词判为违规；免责声明如果自己写满这些词，那道检查就只能
 *    开一堆例外，而例外多了它就拦不住真正的手滑了。
 */
const NO_USAGE_STATEMENT = '本站点不展示任何形式的使用情况指标。'
  + '这类数字我们根本没有：埋点是纯本地的，默认不配置上报端点，也没有内置默认端点'
  + '（docs/telemetry/00-spec.md §4），所以没有任何地方汇总过它们。'
  + '与其留一个占位说它以后会有，不如说清它不存在。';

/** 空状态要指向的三件上线前置（docs/m3/02-decisions.md「等你的三件事」）。 */
const PREREQUISITES = [
  {
    title: '建 @geoly-ai/maintainers 团队并填真实 node id',
    body: '至少两个人 —— Tier 2 要两名维护者 approve 且排除投稿者本人，一个人永远满足不了。'
      + 'node id 填进 registry/maintainers.json 并把 state 从 bootstrap 改成 active。',
  },
  {
    title: '建 release bot 的 GitHub App 并装到本仓库',
    body: '把它的 node id 填进两个 workflow 的 RELEASE_BOT_ID。顺序不能反：id 没填之前不要让 bot 开 PR，'
      + '那些 PR 会被 router 判成 submission，而那条路径只检 submissions/**，对 artifacts/** 与 registry/** 一个字都不看。',
  },
  {
    title: '配分支保护，并用一张真 PR 验一次 CODEOWNERS 确实生效',
    body: '见 docs/m3/00-branch-protection.md §1、§2。',
  },
];

const EMPTY_NOTE = '在上面这三件做完之前，仓库是 fail-closed 的：maintainers.json 还是 bootstrap 且名单为空，'
  + '审批门直接拒，promote 跑不起来，因此不可能有任何制品被发布。这是有意的，不是故障。';

/**
 * @param {object} [opts]
 * @param {string} [opts.snapshotsDir]  默认仓库的 registry/snapshots
 * @param {string} [opts.artifactsRoot] 默认仓库的 artifacts/
 *
 * 两个目录做成参数，是为了测试能拿 fixture 快照跑**同一条**管道。
 * ⚠️ 不接受环境变量覆盖：那会让「线上这份页面是拿哪张快照渲染的」多出一个
 * 不写在代码里的答案，而这正是本站点最不该含糊的一件事。
 */
export function collectData({ snapshotsDir = SNAPSHOTS_DIR, artifactsRoot = ARTIFACTS_DIR } = {}) {
  const loaded = loadNewestSnapshot(snapshotsDir);
  const common = {
    trust_statement: TRUST_STATEMENT,
    no_usage_statement: NO_USAGE_STATEMENT,
    repo: 'geoly-ai/skills-hub',
    snapshots_dir: relative(REPO_ROOT, snapshotsDir),
  };

  if (loaded.empty) {
    return {
      ...common,
      empty: true,
      empty_reason: loaded.reason.replace(REPO_ROOT, ''),
      prerequisites: PREREQUISITES,
      empty_note: EMPTY_NOTE,
    };
  }

  // 载荷核对：快照 record 里没有的那部分（description、pack 成员）只能从这里来，
  // 且只有 tree_digest 对得上才用（payload.mjs 的说明）。
  const payloads = new Map();
  for (const r of loaded.snapshot.artifacts) {
    payloads.set(r.id, readVerifiedManifest(r, artifactsRoot));
  }

  const model = buildModel({ snapshot: loaded.snapshot, payloads });
  return {
    ...common,
    empty: false,
    source: {
      file: relative(REPO_ROOT, loaded.file),
      file_name: loaded.fileName,
      // 🔴 文件名里的 N 与快照内部的 `snapshot` 字段**分别摆出来**。
      //    没有 timestamp 就没有第三方说「最新是第几张」，两个数一致只是自洽，
      //    页面如实呈现这一点而不是替读者宣布"编号已核对"。
      file_number: loaded.fileNumber,
      internal_number: loaded.snapshot.snapshot,
      number_agrees: loaded.fileNumber === loaded.snapshot.snapshot,
      sha256: loaded.sha256,
      bytes: loaded.bytes,
    },
    ...model,
  };
}

/**
 * `--snapshots <dir>` / `--artifacts <dir>` 只用于**本地预览与测试**
 * （测试要拿 fixture 快照跑同一条管道）。线上不传，走仓库里的真目录。
 *
 * ⚠️ 刻意做成显式命令行参数而不是环境变量：环境变量会让「这份页面是拿哪张快照渲染的」
 * 变成一个看不见的答案，而这正是本站点最不该含糊的一件事。
 */
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--snapshots') o.snapshotsDir = argv[++i];
    else if (k === '--artifacts') o.artifactsRoot = argv[++i];
    else throw new Error(`不认得参数 ${k}（只接受 --snapshots / --artifacts）`);
    if (argv[i] === undefined) throw new Error(`${k} 需要一个值`);
  }
  return o;
}

export function main(opts) {
  const data = collectData(opts);
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);
  const what = data.empty
    ? `空 registry（${data.empty_reason}）`
    : `快照 ${data.source.internal_number}，${data.snapshot.artifact_count} 个制品`;
  process.stderr.write(`已写出 ${relative(REPO_ROOT, DATA_FILE)}：${what}\n`);
  return 0;
}

// 入口守卫比 realpath —— 与仓库里几个发布脚本同一个写法。
// 朴素的 `import.meta.url === 'file://' + argv[1]` 在路径含符号链接或需转义的字符时
// 会**悄悄判假**，后果是「跑完了、什么都没产出、还退出 0」。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;   // 宁可多跑一次，也不要静默不跑
  }
}

if (invokedDirectly()) process.exit(main(parseArgs(process.argv.slice(2))));
