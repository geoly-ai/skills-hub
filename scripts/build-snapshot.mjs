#!/usr/bin/env node
// promotion：从 `artifacts/**` 构建一张快照 —— 02-registry.md §2、§2.2、§2.3，
// 03-packs.md §2.1（pack 的 clients / capabilities 由 promotion 计算）、§5（degraded）。
//
// 用法：
//   node scripts/build-snapshot.mjs \
//     --artifacts artifacts --inputs promotion-inputs.json \
//     --snapshot 42 --previous 41 --created-at 2026-08-25T12:00:00Z \
//     --repo geoly-ai/skills-hub --out registry/snapshots/hub-42.json \
//     [--assets-out dist/assets]
//
// 🔴 **确定性**（§2.2）：给同一棵 `artifacts/` 与同一个 `--created-at`，本脚本产出
//    **逐字节相同**的快照。`created_at` 是**输入**不是 `Date.now()` —— 审的人要能
//    在本地复算出与 promotion PR 里一模一样的字节来比对。
//
// 🔴 **本脚本不签名、不推送、不碰网络。** 它只把「目录树 + 元数据」变成一份
//    canonical JSON。签名是 release workflow 的事（02-registry.md §1）。
//
// ⚠️ **`owner` / `review` 从 `--inputs` 来，本脚本不发明它们。**
//    快照 record 必填 `owner` 与 `review{pr, approved_by, head_sha, capability_tier}`，
//    而这四样全是**投稿 PR 的事实**（06-submission.md），属于 M3 的投稿流水线。
//    M0 文档没有钉死它们在磁盘上长什么样，所以这里**不替 M3 拍板**：
//    本脚本收一份显式的 inputs 文件，M3 接上流水线时把那份文件换成流水线的产物即可，
//    本脚本一行都不用改。
//
// 本脚本**自己算**的（规范钉死、库层已就绪的那一半）：
//   · 制品打包与 `asset.{file,sha256,size}`、`tree_digest`（packer.mjs，canonical tar.gz）
//   · pack 的 `clients` = 成员 clients **交集**，`capabilities` = 成员+bundled 的**并集**
//     （03-packs.md §2.1）；交集为空 → **拒绝**
//   · pack 的 `degraded`（§5 的 yank 闭包，含嵌套 pack 的传递与环检测）
//   · `latest` 投影（排除 yanked / degraded / prerelease）
//   · `artifacts` 按 `id` 字节序排序、canonical JSON 字节

import { readFileSync, readdirSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { writeAtomic } from '../src/atomic-fs.mjs';

import { packArtifact } from '../src/packer.mjs';
import { stringify, parseStrict } from '../src/canonical-json.mjs';
import {
  parseArtifactId, validatePackManifest, derivePackClients, derivePackCapabilities,
  computePackStatusClosure,
} from '../src/pack.mjs';
import { parseSnapshot } from '../src/snapshot.mjs';

export const INPUTS_SCHEMA = 'geoly.skills.promotion-inputs/1';
export const SNAPSHOT_SCHEMA = 'geoly.skills.snapshot/2';

class PromotionError extends Error {
  constructor(msg) { super(msg); this.name = 'PromotionError'; }
}
const bad = (msg) => { throw new PromotionError(msg); };

// ── 扫 artifacts/ ───────────────────────────────────────────────────────────

const KIND_DIR = Object.freeze({ __proto__: null, skills: 'skill', packs: 'pack' });

/**
 * 枚举 `artifacts/{skills,packs}/<ns>/<name>/<version>/`。
 *
 * 🔴 **只认这一个深度**。多一层少一层都拒 —— `artifacts/**` 是不可变区（01 §1），
 *    一个放错地方的目录要么是打错了，要么是有人想往里塞不该有的东西，
 *    两种都不该被「宽松地跳过」。
 */
export function scanArtifacts(root) {
  const found = [];
  for (const kindDir of readdirSync(root).sort()) {
    const kind = KIND_DIR[kindDir];
    if (kind === undefined) bad(`artifacts/ 下只允许 skills/ 与 packs/，发现 ${kindDir}`);
    const kindPath = join(root, kindDir);
    for (const ns of readdirSync(kindPath).sort()) {
      for (const name of readdirSync(join(kindPath, ns)).sort()) {
        for (const version of readdirSync(join(kindPath, ns, name)).sort()) {
          const dir = join(kindPath, ns, name, version);
          found.push({
            kind,
            namespace: ns,
            name,
            version,
            id: `${kind}:${ns}/${name}@${version}`,
            dir,
            path: `artifacts/${kindDir}/${ns}/${name}/${version}`,
          });
        }
      }
    }
  }
  return found;
}

/** 载荷根的 manifest（`skill.json` / `pack.json`）。 */
function readManifest(a) {
  const file = a.kind === 'skill' ? 'skill.json' : 'pack.json';
  const p = join(a.dir, file);
  if (!existsSync(p)) bad(`${a.path} 缺少 ${file}`);
  return parseStrict(readFileSync(p, 'utf8'));
}

/** `asset.file` 的命名（02-registry.md §2 的样例）。 */
export function assetFileName({ kind, namespace, name, version }) {
  return `${kind}_${namespace}_${name}_${version}.tar.gz`;
}

// ── inputs ─────────────────────────────────────────────────────────────────

export function readInputs(path) {
  const doc = parseStrict(readFileSync(path, 'utf8'));
  if (doc.schema !== INPUTS_SCHEMA) bad(`--inputs 的 schema 应为 ${INPUTS_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
  if (doc.artifacts === null || typeof doc.artifacts !== 'object' || Array.isArray(doc.artifacts)) {
    bad('--inputs.artifacts 必须是对象（id → {status, owner, review}）');
  }
  return { artifacts: doc.artifacts, yanked: doc.yanked ?? [] };
}

// ── 组装 record ────────────────────────────────────────────────────────────

/**
 * 🔴 **`degraded` 不是可以输入的状态。** `pack.computePackStatus()` 自己就写死了
 *    「`selfStatus` 不接受 degraded —— 它是本函数的输出，不是输入」，promotion 这一侧
 *    必须守同一条线：让它从 `--inputs` 进来，等于允许一个**上一轮算出来的结论**
 *    伪装成事实参与这一轮的计算。
 *
 * 🔴 **`yanked` 也不从这里来。** 它的权威是快照的 `yanked[]`（那里才有 at / reason /
 *    advisory）。两个来源就会有两个真值。
 */
function assertInputStatus(id, status) {
  if (status === 'published' || status === 'deprecated') return status;
  if (status === 'degraded') {
    bad(`--inputs 里 ${id} 的 status 是 degraded —— 它是 promotion 每次**重算**的派生状态，`
      + '不是输入（03-packs.md §5）。要表达「这个 pack 现在装不了」，去 yank 拖累它的那个成员。');
  }
  if (status === 'yanked') {
    bad(`--inputs 里 ${id} 的 status 是 yanked —— yank 的权威是快照的 yanked[]（那里有 at / reason / advisory）。`
      + '两个来源就会有两个真值：请把它写进 --inputs 的 yanked 列表。');
  }
  bad(`--inputs 里 ${id} 的 status 不认识：${JSON.stringify(status)}（只能是 published / deprecated）`);
}

/**
 * skill 的 record 完全由「载荷 manifest + inputs」决定。
 *
 * 🔴 `clients` / `capabilities` 对 **skill** 来自它自己的 `skill.json`；
 *    对 **pack** 由 promotion 计算（§2.1）—— pack.json 里根本没有这两个字段。
 */
function baseRecord(a, manifest, meta, packed) {
  if (!Object.hasOwn(meta, 'owner') || !Object.hasOwn(meta, 'review')) {
    bad(`--inputs 里 ${a.id} 缺 owner / review（它们是投稿 PR 的事实，本脚本不发明）`);
  }
  // 🔴 **规范缺口，如实处理，不静默补一个。**
  //    快照 record **必填** `provenance`（snapshot.mjs 的 RECORD_KEYS），
  //    而 `pack.json` 的键集里**根本没有这个字段**（03-packs.md §2 的 schema，
  //    validatePackManifest 也不认它）—— 于是 pack 的 provenance 没有出处。
  //    skill 走 `skill.json`，pack 只能走 `--inputs`（它同样是投稿 PR 的事实）。
  //    两边都没有就**拒绝**：编一个 `{kind:'original', author_github_id:'?'}`
  //    会让一条查不到来源的记录混进签名对象里。
  const provenance = manifest.provenance ?? meta.provenance;
  if (provenance === undefined) {
    bad(`${a.id} 没有 provenance：skill 应写在 skill.json 里，`
      + `pack 的 pack.json 里没有这个字段（03-packs.md §2），只能由 --inputs 提供`);
  }
  return {
    id: a.id,
    kind: a.kind,
    namespace: a.namespace,
    name: a.name,
    version: a.version,
    path: a.path,
    tree_digest: packed.tree_digest,
    asset: { file: assetFileName(a), sha256: packed.sha256, size: packed.size },
    clients: [],           // pack 由下面计算；skill 由 manifest 填
    capabilities: [],
    replaces: manifest.replaces ?? [],
    conflicts: manifest.conflicts ?? [],
    license: manifest.license,
    owner: meta.owner,
    provenance,
    status: assertInputStatus(a.id, meta.status ?? 'published'),
    review: meta.review,
  };
}

/**
 * 一次 promotion 的全部派生计算。
 *
 * @param {object} a
 * @param {string} a.artifactsRoot
 * @param {object} a.inputs        readInputs() 的产物
 * @param {number} a.snapshot
 * @param {number|null} a.previous
 * @param {string} a.createdAt     🔴 **输入**，不是 Date.now()（§2.2 的确定性）
 * @param {string} a.repo
 * @returns {{doc:object, assets:Array<{file:string,bytes:Buffer}>}}
 */
export function buildSnapshot({ artifactsRoot, inputs, snapshot, previous, createdAt, repo }) {
  const found = scanArtifacts(artifactsRoot);
  const seen = new Set();
  for (const a of found) {
    parseArtifactId(a.id, `artifacts 目录 ${a.path}`);   // grammar 门（ns/name/semver）
    if (seen.has(a.id)) bad(`同一个 ArtifactId 出现两次：${a.id}`);
    seen.add(a.id);
  }

  // ── 第 1 遍：打包 + 组装除 pack 派生字段之外的一切 ───────────────────────
  const records = new Map();
  const manifests = new Map();
  const assets = [];
  for (const a of found) {
    const manifest = readManifest(a);
    const meta = inputs.artifacts[a.id];
    if (meta === undefined) bad(`--inputs 里没有 ${a.id}（每一个制品都要有 owner / review / status）`);

    const first = packArtifact({ root: a.dir, kind: a.kind });
    const rec = baseRecord(a, manifest, meta, first);
    if (a.kind === 'skill') {
      rec.clients = manifest.clients ?? [];
      rec.capabilities = manifest.capabilities ?? [];
    } else {
      manifests.set(a.id, validatePackManifest(manifest));
    }
    records.set(a.id, rec);
    assets.push({ file: rec.asset.file, bytes: first.bytes, id: a.id, dir: a.dir, kind: a.kind });
  }

  // ── 第 2 遍：pack 的 clients / capabilities（§2.1）────────────────────────
  // 🔴 **按依赖序算**：成员可以是另一个 pack，而那个 pack 的 clients 也是算出来的。
  //    环由 computePackStatusClosure 报（pack 不可变，环意味着两个 pack 互锁摘要，
  //    第一个都发布不出来）—— 这里先自己判一次，免得下面递归不终止。
  const packIds = [...manifests.keys()];
  const state = new Map();
  const derive = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') bad(`pack 成员图有环：${[...stack, id].join(' → ')}`);
    state.set(id, 'visiting');
    const man = manifests.get(id);
    const memberRecs = [];
    const allRecs = [];
    for (const m of [...man.members, ...man.bundled]) {
      const sub = records.get(m.id);
      if (sub === undefined) bad(`${id} 的成员 ${m.id} 不在 artifacts/ 里（pack 锁定的是精确版本）`);
      // 🔴 pack.json 里冗余记的 tree_digest 必须与实际打出来的一致（03-packs.md §2）
      if (sub.tree_digest !== m.tree_digest) {
        bad(`完整性事件：${id} 锁定成员 ${m.id} 的 tree_digest 是 ${m.tree_digest}，实际打出来是 ${sub.tree_digest}`);
      }
      if (sub.kind === 'pack') derive(m.id, [...stack, id]);
      allRecs.push(sub);
      if (man.members.some((x) => x.id === m.id)) memberRecs.push(sub);
    }
    const rec = records.get(id);
    rec.clients = derivePackClients(memberRecs);
    rec.capabilities = derivePackCapabilities(allRecs);
    // §2.1：交集为空 → 该 pack 不可安装，promotion 阶段**直接拒绝**
    if (rec.clients.length === 0) {
      bad(`${id} 的 clients 交集为空（成员各自声明：`
        + `${memberRecs.map((r) => `${r.id}=[${r.clients.join(',')}]`).join('; ')}）—— 该 pack 不可安装，拒绝进快照`);
    }
    state.set(id, 'done');
  };
  for (const id of packIds) derive(id, []);

  // ── 第 3 遍：degraded 闭包（§5）────────────────────────────────────────────
  // 🔴 `degraded` 是 promotion **每次重算**并写进快照的派生状态 ——
  //    快照是签名对象，状态必须在签名覆盖范围内，绝不能在运行时算出来当真值。
  const yankedIds = new Set(inputs.yanked.map((y) => y.id));
  for (const [id, rec] of records) if (yankedIds.has(id)) rec.status = 'yanked';
  const lookup = (id) => {
    const r = records.get(id);
    if (r === undefined) return undefined;
    return { status: r.status, manifest: manifests.get(id) };
  };
  // 🔴 **权威写回，不是「只在算出 degraded 时才写」。**
  //    单向写回会让上一轮的结论粘住：一个 pack 的成员修好了、闭包算出 published，
  //    而它的 record 仍是 degraded，`latest` 于是永远不选它（Codex 2026-08-30）。
  //    「每次重算」的意思就是**这一轮算出什么就是什么**。
  //    ⚠️ 输入侧已经不接受 degraded / yanked（见 assertInputStatus），
  //    所以这里写回的一定是本轮算出来的。
  const decided = new Map();
  for (const id of packIds) {
    for (const [pid, res] of computePackStatusClosure({ rootId: id, lookup })) {
      const prev = decided.get(pid);
      if (prev !== undefined && prev !== res.status) {
        // 闭包是按边的 role 算的，同一个 pack 从不同根出发结论必须一致；
        // 不一致说明算法或图有问题，**不猜哪个对**。
        bad(`${pid} 的 degraded 重算结果不一致：${prev} vs ${res.status}`);
      }
      decided.set(pid, res.status);
    }
  }
  for (const [pid, status] of decided) {
    const r = records.get(pid);
    if (r !== undefined) r.status = status;
  }

  // ── 第 4 遍：绑定复验 + 确定性自证 ────────────────────────────────────────
  // 🔴 **再打一次，这次带上 record**：`packArtifact` 会跑 `assertManifestBinding()`
  //    —— 与**安装端同一份**校验器（§5.3 的全等）。只在这里能判「这份 manifest 与
  //    我们即将写进快照的 record 真的是一回事」。
  //    ⚠️ 必须排在 pack 的 clients / capabilities 算完之后：pack.json 里没有这两个
  //    字段，它们是 promotion 算出来的，早于第 2 遍去绑定就会拿一个空数组去比。
  // 🔴 顺带把「打包是确定性的」变成**可证伪的断言**，而不是一句承诺：
  //    两次打包的 sha256 与 tree_digest 必须完全相同。
  for (const asset of assets) {
    const rec = records.get(asset.id);
    const again = packArtifact({ root: asset.dir, kind: asset.kind, record: rec });
    if (again.sha256 !== rec.asset.sha256 || again.size !== rec.asset.size) {
      bad(`打包不确定：${asset.id} 两次的资产摘要/字节数不同`
        + `（${rec.asset.sha256}/${rec.asset.size} vs ${again.sha256}/${again.size}）`);
    }
    if (again.tree_digest !== rec.tree_digest) {
      bad(`打包不确定：${asset.id} 两次的树摘要不同（${rec.tree_digest} vs ${again.tree_digest}）`);
    }
  }

  // ── 排序 + latest 投影（§2.3）─────────────────────────────────────────────
  const artifacts = [...records.values()]
    .sort((x, y) => Buffer.compare(Buffer.from(x.id, 'utf8'), Buffer.from(y.id, 'utf8')));

  const latest = {};
  for (const r of artifacts) {
    if (r.status === 'yanked' || r.status === 'degraded') continue;
    if (r.version.includes('-')) continue;                     // prerelease 不进 latest
    const key = `${r.kind}:${r.namespace}/${r.name}`;
    if (latest[key] === undefined || cmpVersion(r.version, latest[key]) > 0) latest[key] = r.version;
  }

  const doc = {
    schema: SNAPSHOT_SCHEMA,
    snapshot,
    previous,
    created_at: createdAt,
    repo,
    artifacts,
    yanked: [...inputs.yanked].sort((x, y) => Buffer.compare(Buffer.from(x.id), Buffer.from(y.id))),
    latest,
  };
  return { doc, assets };
}

/** 只用来在 latest 里挑最高版（正式版之间比较，没有预发布）。 */
function cmpVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) bad(`不认得参数 ${a}`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    let val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined) bad(`${name} 需要一个值`);
    o[name.slice(2)] = val;
  }
  return o;
}

export async function main(argv) {
  const o = parseArgs(argv);
  for (const k of ['artifacts', 'inputs', 'snapshot', 'created-at', 'repo', 'out']) {
    if (o[k] === undefined) bad(`缺少 --${k}`);
  }
  const snapshot = Number(o.snapshot);
  if (!Number.isSafeInteger(snapshot) || snapshot < 0) bad(`--snapshot 必须是非负整数，得到 ${o.snapshot}`);
  const previous = o.previous === undefined || o.previous === 'none' ? null : Number(o.previous);
  if (previous !== null && (!Number.isSafeInteger(previous) || previous < 0)) {
    bad(`--previous 必须是非负整数或 none，得到 ${o.previous}`);
  }

  const { doc, assets } = buildSnapshot({
    artifactsRoot: o.artifacts,
    inputs: readInputs(o.inputs),
    snapshot,
    previous,
    createdAt: o['created-at'],
    repo: o.repo,
  });

  const bytes = Buffer.from(stringify(doc), 'utf8');

  // 🔴 **自己产出的快照必须能被自己的读取端接受。** 写入端接受的每一个输入，
  //    读取端都必须接受（R-11 的判据）。这里就地过一遍 `parseSnapshot()` ——
  //    它会校验 latest 投影自洽、排序、id 一致性、provenance 形状等等。
  //    不过这一关就不落盘：一张读不回来的快照比没有快照更糟。
  parseSnapshot(bytes, { expectSnapshot: snapshot });

  // 🔴 **先写资产，最后才写快照。** 反过来的话，资产写到一半失败会留下
  //    「一张声明了全部资产的快照 + 一个残缺的资产目录」——
  //    而快照是下游唯一的索引，它在就意味着「这些都齐了」。
  //    反向的残留（有资产、没快照）无人引用，无害。（Codex 2026-08-30）
  if (o['assets-out'] !== undefined) {
    mkdirSync(o['assets-out'], { recursive: true });
    for (const a of assets) writeAtomic(join(o['assets-out'], a.file), a.bytes);
    process.stderr.write(`已写出 ${assets.length} 个资产到 ${o['assets-out']}\n`);
  }

  // 🔴 **原子写**：`writeFileSync` 会先把已有的那张有效快照截断，再写新字节 ——
  //    中途被杀就只剩半份 JSON，而且旧的那份也没了。
  //    临时文件 + fsync + rename（atomic-fs.writeAtomic）。
  mkdirSync(dirname(o.out), { recursive: true });
  writeAtomic(o.out, bytes);
  process.stderr.write(`已写出 ${o.out}（${doc.artifacts.length} 个制品，${bytes.length} 字节）\n`);
  return 0;
}

export { PromotionError };

// 🔴 **入口守卫必须比 realpath**。早先写的是
//    `import.meta.url === `file://${process.argv[1]}``，它在两种很常见的现场下
//    悄悄判假：① 路径上有符号链接（`import.meta.url` 用 realpath，`argv[1]` 不用）；
//    ② 路径里有需要 URL 转义的字符（空格、中文…）。
//    判假的后果不是报错，是 **`main()` 根本不跑、进程退出 0** ——
//    一个「跑完了、什么都没产出、还说自己成功」的发布脚本。本机实测踩过。
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // 🔴 realpath 失败（文件被删、权限）时**按「是入口」处理**：
    //    宁可多跑一次也不要静默不跑。被 import 的场景 argv[1] 一定存在且解析得开。
    return true;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); },
  );
}
