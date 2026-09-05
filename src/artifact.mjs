// 制品链：资产验证 → 隔离解包 → 重算树摘要 → manifest 绑定
// 规范：02-registry.md §6 第 7 步、01-artifacts.md §4/§5/§5.3/§6、04-install.md §7
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, futimesSync,
  utimesSync, chmodSync, fchmodSync, fstatSync, lstatSync, readFileSync, existsSync, statSync, rmSync, constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsyncDir } from './atomic-fs.mjs';
import { treeDigest } from './tree-digest.mjs';
import { untarGz, assertArtifactPath, TarViolation } from './untar.mjs';
import {
  IntegrityError, WireError,
  parseWireJson, assertExactKeys, assertString, assertStringArray, assertUint, assertTreeDigest,
} from './trust.mjs';

export const SKILL_MANIFEST_SCHEMA = 'geoly.skills.skill/1';
export const PACK_MANIFEST_SCHEMA = 'geoly.skills.pack/1';

const viol = (v, m) => { throw new IntegrityError(v, m); };

// ── 资产 ────────────────────────────────────────────────────────────────────

/**
 * §6 第 7 步的第一件事：验 `asset.sha256`（顺带验 `asset.size`）。
 * 🔴 没有期望值就直接抛 —— API 上不存在「不给期望值就跳过」的口子。
 */
export function assertAssetBytes(bytes, record) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const expected = record?.asset?.sha256;
  if (typeof expected !== 'string') viol('E_NO_EXPECTED_DIGEST', 'record.asset.sha256 缺失，拒绝校验资产');
  const got = 'sha256:' + createHash('sha256').update(buf).digest('hex');
  if (got !== expected) viol('E_ASSET_SHA256', `资产 sha256 是 ${got}，快照说应为 ${expected}`);
  // 🔴 `asset.size` **必填**，不是「有就查」。
  //    snapshot parser 本来就要求它存在，所以这里写成可选只在**直接调本 API** 时有区别 ——
  //    也就是说，它唯一的作用是给绕过尺寸一致性校验留一个口子。
  //    同 E_NO_EXPECTED_DIGEST 的立场：API 上不存在「不给期望值就跳过」。
  if (typeof record.asset.size !== 'number') {
    viol('E_NO_EXPECTED_SIZE', 'record.asset.size 缺失，拒绝校验资产');
  }
  if (buf.length !== record.asset.size) {
    viol('E_ASSET_SIZE', `资产 ${buf.length} 字节，快照说应为 ${record.asset.size}`);
  }
  return got;
}

// ── 隔离临时目录 ────────────────────────────────────────────────────────────

/**
 * 🔴 解到**隔离临时目录**（不是 target，不是 stage）——04-install.md §7 第 2 步。
 * `mkdtemp` 生成的目录名不可预测且 mode 0700：别人预先占位、或在解包途中
 * 往里塞 symlink，都需要先能写进这个目录。
 */
export function createIsolatedDir(parent = tmpdir()) {
  const d = mkdtempSync(join(parent, 'geoly-unpack-'));
  chmodSync(d, 0o700);
  return d;
}

/**
 * 把内存里的条目写进隔离目录。
 *
 * 🔴 每个中间目录都由**本函数自己**创建（`mkdir` 不带 recursive，`EEXIST` 即违规），
 * 每个文件用 `O_CREAT|O_EXCL|O_NOFOLLOW` 打开。
 * 为什么不用「先 lstat 再写」：那是 TOCTOU —— 检查与写之间有窗口。
 * 让内核在 `open` 这一次系统调用里同时完成「必须不存在」与「不许跟随符号链接」。
 */
export function writeEntries(destDir, entries) {
  const madeDirs = [];
  const known = new Set([destDir]);

  const ensureDir = (abs) => {
    if (known.has(abs)) return;
    try {
      mkdirSync(abs, 0o755);
    } catch (e) {
      // 🔴 EEXIST 在这里就是异常：目录是我们刚建的、由我们独占，
      //    里面不该有别人先放好的东西
      viol('E_DEST_DIRTY', `隔离目录里已存在 ${abs}（${e.code}）：拒绝写入`);
    }
    // 建完立刻 lstat 确认它确实是目录而不是被换成了符号链接。
    // ⚠️ 这**收窄**竞态窗口，不消除它：Node 没有 openat/mkdirat，
    //    中间目录的 check-then-use 无法在纯 Node 里做成原子的。残余风险见交付汇报。
    const st = lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) viol('E_DEST_DIRTY', `${abs} 建出来之后不是普通目录`);
    chmodSync(abs, 0o755); // 绕开 umask，把 mode 钉死（§6.2：目录 mode 一律 0755）
    known.add(abs);
    madeDirs.push(abs);
  };

  const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
  for (const e of entries) {
    const segs = e.path.split('/');
    for (let i = 1; i < segs.length; i++) ensureDir(join(destDir, ...segs.slice(0, i)));
    const abs = join(destDir, ...segs);
    let fd;
    try {
      fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, e.mode);
    } catch (err) {
      viol('E_DEST_DIRTY', `无法以 O_EXCL|O_NOFOLLOW 创建 ${e.path}（${err.code}）`);
    }
    try {
      writeSync(fd, e.data, 0, e.data.length, 0);
      // 🔴 mode 用 fchmod 而不是 chmod：`open` 受 umask 影响（umask 077 会把
      //    0644 变成 0600），必须钉死；而按**路径**再 chmod 一次等于重新解析路径，
      //    那正是 Codex 指出的 TOCTOU 窗口。用已经拿到的 fd 就没有这次重解析。
      fchmodSync(fd, e.mode);
      fsyncSync(fd);
      // §6.2：mtime / atime 解包时一律置 0（epoch），归档里的时间戳不参与也不保留
      futimesSync(fd, 0, 0);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) viol('E_DEST_DIRTY', `${e.path} 写完之后不是 nlink=1 的普通文件`);
      if ((st.mode & 0o777) !== e.mode) viol('E_DEST_DIRTY', `${e.path} 的 mode 没能钉成 0${e.mode.toString(8)}`);
    } finally {
      closeSync(fd);
    }
  }

  // 目录时间与 fsync 放到最后：先设时间会被后续写子项覆盖
  for (let i = madeDirs.length - 1; i >= 0; i--) { utimesSync(madeDirs[i], 0, 0); fsyncDir(madeDirs[i]); }
  fsyncDir(destDir);
  return { dirs: madeDirs.length, files: entries.length };
}

/**
 * 🔴 `0755` 仅当 capability 声明了 `shell`（01-artifacts.md §5 载荷规则表）。
 * mode 进树摘要正是因为它关联这条 capability —— 只校验摘要不校验这条绑定，
 * 等于让一个没声明 shell 的制品带着可执行位装进去。
 */
export function assertModeCapabilityBinding(entries, record) {
  const caps = Array.isArray(record?.capabilities) ? record.capabilities : [];
  if (caps.includes('shell')) return;
  const bad = entries.filter(e => e.mode === 0o755).map(e => e.path);
  if (bad.length) {
    viol('E_MODE_CAPABILITY',
      `制品未声明 shell capability，却含 0755 文件：${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}`);
  }
}

/**
 * §6 第 7 步全流程：
 *   验 asset.sha256 → 隔离临时目录解包 → 重算 tree_digest → 校验归档内逻辑路径与 mode。
 *
 * 🔴 顺序不可调换：**解包永远发生在 sha256 验证之后**。
 * 先解包再验摘要等于把未经验证的字节喂给解析器，解析器的任何缺陷都直接可达。
 */
export function verifyAndExtract({ bytes, record, parent = tmpdir() }) {
  assertAssetBytes(bytes, record);

  const { entries, totals } = untarGz(bytes);
  if (entries.length === 0) viol('E_EMPTY_ARTIFACT', '制品没有任何文件');

  // 纵深防御：不信任 untar 的路径判定，再判一遍。任一侧将来放松，另一侧还在。
  for (const e of entries) assertArtifactPath(e.path, `payload:${e.path}`);
  assertModeCapabilityBinding(entries, record);

  const dir = createIsolatedDir(parent);
  // 🔴 失败路径必须自己收尸。这之前只有成功路径会把 dir 交给调用方，
  //    写盘失败或树摘要不符时目录就留在 /tmp 里没人管 —— 一个合法 gzip 配上错的
  //    tree_digest 就能让每次调用都完整写一遍盘再抛错，反复调用会堆出一地
  //    geoly-unpack-*。调用方拿不到 dir，也就不可能替我们删。
  let ok = false;
  try {
    writeEntries(dir, entries);

    // 解完重算树摘要（§7 第 4 步）
    const got = treeDigest(dir);
    if (got !== record.tree_digest) {
      viol('E_TREE_DIGEST', `解包后重算 ${got}，快照说应为 ${record.tree_digest}`);
    }
    ok = true;
    return { dir, entries, totals, treeDigest: got };
  } finally {
    // 只删我们自己用 mkdtemp 建的那一个；成功时所有权移交调用方，不能删
    if (!ok) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ } }
  }
}

// ── manifest 绑定（01-artifacts.md §5.3） ──────────────────────────────────

const SKILL_MANIFEST_KEYS = {
  required: ['schema', 'kind', 'namespace', 'name', 'version', 'description', 'license',
    'clients', 'capabilities', 'replaces', 'conflicts'],
  // 🔴 **`provenance` 从必填改成可选**（2026-09-05 用户拍板）。
  //
  //    原因是它构成一个**时间循环**：`submitted_by_pr` 必须等于真实 PR 号，
  //    而 PR 号只有开了 PR 才知道 —— 于是投稿者被要求在开 PR **之前**
  //    写进一个开 PR 之后才存在的值。实际做法是「先开 PR → 回填 → 强推同一分支」，
  //    而漏回填的投稿会**先进 main、再在 promote 卡死**。
  //
  //    ⚠️ 更能说明问题的是它与 `PROMOTION.json` **自相矛盾**：那边明确
  //    **拒绝**投稿者声明 `author_github_id` / `submitted_by_pr`
  //    （理由：投稿者只能声明只有他知道的事），而这边却要求他自己写同样两个字段。
  //    同一个仓库里两套相反的规则 —— 我自己在两天里踩了它两次。
  //
  //    现在：缺省即由 promote 填（与 pack 一致）；**若投稿者写了，仍然逐字核对**
  //    （`assertProvenanceMatchesPr`）—— 不静默改写，写错了要有人看见。
  //
  // 🔴 改成 optional 而不是删掉：已发布的 5 张快照里的制品**都带着这个字段**，
  //    删掉会让它们验不过。可选是唯一向后兼容的形状。
  optional: ['provenance'],
};

const PACK_MANIFEST_KEYS = {
  required: ['schema', 'kind', 'namespace', 'name', 'version', 'description', 'license',
    'members', 'bundled', 'conflicts', 'contract_paths', 'compatibility'],
};

/** 最小 YAML frontmatter 子集：`---` 包围、单行 `key: value`。其余一律拒绝。 */
/**
 * SKILL.md frontmatter 的全部检查 —— **投稿门与建快照必须调同一个**。
 *
 * 🔴 2026-09-02：投稿侧的结构门**根本没解析过 frontmatter**，于是 11 个投稿
 *    全绿合并进 main，promote 建快照时才红在 `E_FRONTMATTER`（10 个用了 YAML
 *    折叠标量 `>`，而这里的解析器是刻意最小化的、只认单行 `key: value`）。
 *    那正是本仓库反复警告的「**PR 时绿、promote 时红**」——
 *    投稿已经在 main 上了，改起来要走一整轮。
 *
 * ⚠️ 所以这段逻辑抽成一个函数、两处调用，而**不是**在投稿门里另写一份：
 *    另写一份就是又一处会分叉的实现。
 *
 * @param {object} a
 * @param {string} a.payloadDir
 * @param {string} a.name              期望的 name（来自 record / 目录名）
 * @param {(code:string,msg:string)=>void} a.viol  报错回调
 * @returns {object|null} 解析出来的 frontmatter
 */
export function assertSkillFrontmatter({ payloadDir, name, viol }) {
  const sp = join(payloadDir, 'SKILL.md');
  if (!existsSync(sp) || !statSync(sp).isFile()) {
    viol('E_MANIFEST_MISSING', '载荷根缺少 SKILL.md（§5.1）');
    return null;
  }
  const frontmatter = parseFrontmatter(readFileSync(sp, 'utf8'));
  if (frontmatter.name !== name) {
    viol('E_MANIFEST_BINDING', `⑦ SKILL.md frontmatter 的 name 是 ${JSON.stringify(frontmatter.name)}，应为 ${name}`);
  }
  if (typeof frontmatter.description !== 'string' || frontmatter.description === '') {
    viol('E_MANIFEST_BINDING', 'SKILL.md frontmatter 缺少 description（§5.1）');
  }
  // 🔴 版本只放 skill.json；SKILL.md frontmatter 只承担运行时语义（§5.1 末段）
  if (Object.hasOwn(frontmatter, 'version')) {
    viol('E_MANIFEST_BINDING', 'SKILL.md frontmatter 不得带 version —— 版本只放 skill.json（§5.1）');
  }
  return frontmatter;
}

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) throw new WireError('E_FRONTMATTER', 'SKILL.md 必须以 --- 开头的 YAML frontmatter 起始');
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) throw new WireError('E_FRONTMATTER', 'SKILL.md 的 frontmatter 没有闭合的 ---');
  const body = text.slice(4, end + 1);
  const out = {};
  for (const raw of body.split('\n')) {
    if (raw.trim() === '') continue;
    if (raw.includes('\t')) throw new WireError('E_FRONTMATTER', 'frontmatter 含 TAB');
    if (raw === '---' || raw.startsWith('---')) throw new WireError('E_FRONTMATTER', 'frontmatter 里出现多文档分隔符');
    const m = /^([A-Za-z0-9_-]+): (.*)$/.exec(raw);
    if (!m) throw new WireError('E_FRONTMATTER', `frontmatter 只支持单行 key: value，无法解析：${JSON.stringify(raw)}`);
    let v = m[2];
    // 拒绝 YAML 锚点 / 别名 / 合并键 —— 它们能让同一份文本解出不同结构
    if (/^[&*]/.test(v) || m[1] === '<<') throw new WireError('E_FRONTMATTER', 'frontmatter 禁止 YAML 锚点/别名');
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    if (Object.hasOwn(out, m[1])) throw new WireError('E_FRONTMATTER', `frontmatter 重复 key ${m[1]}`);
    out[m[1]] = v;
  }
  return out;
}

function readPayloadJson(payloadDir, file) {
  const p = join(payloadDir, file);
  if (!existsSync(p) || !statSync(p).isFile()) {
    viol('E_MANIFEST_MISSING', `载荷根缺少 ${file}（01-artifacts.md §5.1/§5.2）`);
  }
  return { bytes: readFileSync(p), path: p };
}

/**
 * 🔴 §5.3：manifest ↔ ArtifactId 的**六项全等**（skill 再加第七项）。
 * v1 只强制了「三处 name 一致」，能发布出「路径 x@1.0.0、载荷声明 x@2.0.0」的制品。
 *
 * 这一步必须在**第 7 步**做 —— manifest 在资产内部，第 5 步（解析快照）时
 * 根本还没下载到（v3 在第 5 步要求校验它，顺序上不可能）。
 */
export function assertManifestBinding(record, payloadDir) {
  const isSkill = record.kind === 'skill';
  const file = isSkill ? 'skill.json' : 'pack.json';
  const { bytes } = readPayloadJson(payloadDir, file);
  const doc = parseWireJson(bytes, file);

  // 🔴 「skill.json 里没有 digest 字段，永远不会有。摘要只存在于 registry snapshot，
  //    投稿者声明的一律不读。」——给它一个专门的违规码，别混在「未知字段」里。
  if (Object.hasOwn(doc, 'digest')) {
    viol('E_MANIFEST_DIGEST', `${file} 出现 digest 字段：投稿者声明的摘要一律不读（01-artifacts.md §5.1）`);
  }

  if (!isSkill) {
    // pack.json（03-packs.md §2）。这里只做**绑定所需**的严格校验：
    // schema、必填键集、成员锁定必须是精确版本+摘要。
    // ⚠️ 成员图的解析、degraded 判定、conflicts 匹配等属于 packs 模块的职责，不在本模块。
    assertExactKeys(doc, PACK_MANIFEST_KEYS, file);
    if (doc.schema !== PACK_MANIFEST_SCHEMA) {
      throw new WireError('E_SCHEMA', `${file}.schema 必须是 ${PACK_MANIFEST_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
    }
    assertString(doc.description, `${file}.description`);
    assertString(doc.license, `${file}.license`);
    assertStringArray(doc.conflicts, `${file}.conflicts`);
    assertStringArray(doc.contract_paths, `${file}.contract_paths`);
    for (const listName of ['members', 'bundled']) {
      const list = doc[listName];
      if (!Array.isArray(list)) throw new WireError('E_WIRE_TYPE', `${file}.${listName} 必须是数组`);
      list.forEach((m, i) => {
        const w = `${file}.${listName}[${i}]`;
        assertExactKeys(m, { required: ['id', 'tree_digest', 'role'], optional: ['order'] }, w);
        // 🔴 成员锁定：精确版本 + 摘要，不接受 semver range
        //    （range 意味着「装的时候才知道装到什么」）
        if (!/^(skill|pack):[a-z0-9-]+\/[a-z0-9-]+@[^*^~ ]+$/.test(assertString(m.id, `${w}.id`))) {
          throw new WireError('E_PACK_MEMBER_ID', `${w}.id 必须是精确的 ArtifactId，不接受 range：${m.id}`);
        }
        assertTreeDigest(m.tree_digest, `${w}.tree_digest`);
        assertString(m.role, `${w}.role`);
        if (Object.hasOwn(m, 'order')) assertUint(m.order, `${w}.order`);
      });
    }
  }

  if (isSkill) {
    assertExactKeys(doc, SKILL_MANIFEST_KEYS, file);
    if (doc.schema !== SKILL_MANIFEST_SCHEMA) {
      throw new WireError('E_SCHEMA', `${file}.schema 必须是 ${SKILL_MANIFEST_SCHEMA}，得到 ${JSON.stringify(doc.schema)}`);
    }
    assertString(doc.description, `${file}.description`);
    assertString(doc.license, `${file}.license`);
    assertStringArray(doc.clients, `${file}.clients`);
    assertStringArray(doc.capabilities, `${file}.capabilities`);
    assertStringArray(doc.replaces, `${file}.replaces`);
    assertStringArray(doc.conflicts, `${file}.conflicts`);
  }

  // ①—⑤：仓库路径、kind、namespace、name、version
  const wantPath = `artifacts/${record.kind}s/${record.namespace}/${record.name}/${record.version}`;
  const checks = [
    ['① 仓库路径', record.path, wantPath],
    ['② kind', doc.kind, record.kind],
    ['③ namespace', doc.namespace, record.namespace],
    ['④ name', doc.name, record.name],
    ['⑤ version', doc.version, record.version],
    // ⑥ snapshot record 的 id / ns / name / version / kind
    ['⑥ id', record.id, `${record.kind}:${record.namespace}/${record.name}@${record.version}`],
  ];
  for (const [label, got, want] of checks) {
    if (got !== want) viol('E_MANIFEST_BINDING', `${label} 不一致：${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  }

  // ⑦ skill 的第七项：SKILL.md frontmatter 的 name
  let frontmatter = null;
  if (isSkill) frontmatter = assertSkillFrontmatter({ payloadDir, name: record.name, viol });

  return { manifest: doc, frontmatter };
}

/**
 * 第 7 步的组合入口：验资产 → 解包 → 树摘要 → manifest 绑定。
 *
 * 🔴 成功时 `dir` 的所有权移交调用方，**调用方必须调 `dispose()`**。
 * 返回值里带 `dispose` 而不是只在文档里写一句「记得删」——
 * 实测「靠调用方记得」是不成立的：我们自己的测试就漏了一地，
 * 一轮全量跑之后 `$TMPDIR` 里有 3807 个 `geoly-unpack-*`。
 *
 * 能用 `withVerifiedArtifact()` 就用它，那个结构上不可能忘。
 */
export function verifyArtifact({ bytes, record, parent = tmpdir() }) {
  const r = verifyAndExtract({ bytes, record, parent });
  // 🔴 `dispose` 必须在**任何可能抛错的步骤之前**就能用。
  // 早先它构造在 assertManifestBinding 之后 —— 绑定失败时 r.dir 就没人收尸了，
  // 而调用方连 dir 都拿不到（异常里没有它），想清也清不了。
  // 与 verifyAndExtract 里那段「失败路径必须自己收尸」是同一条，我漏了这一处。
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { rmSync(r.dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  };
  let b;
  try {
    b = assertManifestBinding(record, r.dir);
  } catch (err) {
    dispose();
    throw err;
  }
  return { ...r, ...b, dispose };
}

/**
 * 作用域版：`fn` 无论正常返回还是抛错，隔离目录都会被清掉。
 *
 * 🔴 **这是首选入口。** 把「记得清理」从一条纪律变成一个结构性质：
 * 调用方拿不到不清理的写法。异步 `fn` 也支持。
 */
export function withVerifiedArtifact({ bytes, record, parent = tmpdir() }, fn) {
  const art = verifyArtifact({ bytes, record, parent });
  let promise = false;
  try {
    const out = fn(art);
    if (out && typeof out.then === 'function') {
      promise = true;
      return out.finally(() => art.dispose());
    }
    return out;
  } finally {
    if (!promise) art.dispose();
  }
}

export { TarViolation };
