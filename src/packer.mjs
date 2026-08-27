// packer —— 从一棵目录树产出 canonical 制品字节（tar + gzip）与 asset.sha256。
// 规范：01-artifacts.md §4（路径 grammar）、§5（载荷规则与上限）、§6（树摘要）、
//       02-registry.md §4.1（canonical tar.gz）、ERRATA E-3 / E-5 / E-6。
//
// 🔴 **自己写字节，绝不 shell out 到系统 `tar`**（ERRATA E-6）：
// macOS 的 bsdtar 会为携带 xattr 注入 AppleDouble（`._*`）成员，而 §5 拒绝 xattr ——
// 于是用系统 tar 打的包会被**我们自己的校验器**拒掉，而打包的人从 `tar -tvf`
// 完全看不出异常（那个成员根本不会被列出来）。GNU tar 还会把尾部补到 20 个零块，
// 与 E-5 的「恰好两个零块」冲突。两条都指向同一个结论：字节必须由我们自己生成。
//
// ── 🔴 本模块最要紧的一条设计 ────────────────────────────────────────────────
//
// **packer 的接受集合按构造等于 parser 的接受集合。**
//
// R-11 反复出现的形状是「写入端与读取端各自合理但接受集合不同」。这里的具体风险是：
// `install.mjs` 的 `writeCanonicalTar()` 是一个**纯编码器**，它只校验路径 grammar、
// ustar 可切分性、mode 与重复路径；它**不查**
//   · 大小写折叠冲突（parseTar 的 E_CASE_COLLIDE）
//   · 同名既文件又目录（E_PATH_FILE_DIR_COLLIDE）
//   · 目录名之间的大小写冲突
//   · 单文件 / 总量 / 文件数上限（E_FILE_SIZE / E_TOTAL_SIZE / E_FILE_COUNT）
// 也就是说 `writeCanonicalTar` 能写出 `parseTar` 读不回来的归档。
//
// 消除办法**不是**在 packer 里再写一份校验器 —— 那正是「再造一次分叉」，
// 也正是 devmajor 与 `../x` 两次踩过的坑。办法是：
// **packer 把自己的产出立刻交给 `parseTar` / `gunzipCanonical` 反解，逐条比对；
// 反解不过或对不上就失败。** 于是「packer 接受某个输入」在定义上蕴含
// 「parser 接受它的产出」，两个集合相等是构造性的，不依赖两份代码保持同步。
//
// 代价是每次打包多解析一遍（≤16 MiB，实测微秒级到毫秒级），换来的是这一类 bug
// 结构上不可能再出现。
//
// 🔴 **这个办法证明了什么、没证明什么**（Codex 第一轮明确点出，别夸大）：
//   ✅ 证明「packer 产出的字节 ∈ parser 的接受集」——「写出自己读不回来的东西」这一类
//      bug 结构上消失。
//   ❌ **没有**证明两个集合相等：parser 仍可能接受 packer 永远不会生成的字节
//      （那一侧由 `test/untar.test.mjs` 的恶意样例覆盖，不归本模块）。
//   ❌ **没有**覆盖「两边同错」：writer 与 parser 共用 `assertArtifactPath` /
//      `canonicalUstarSplit`，共用部分若有 bug，往返照样通过。
//      所以 `test/packer.test.mjs` 里另有**独立的 golden 字节向量**与**逐字节突变测试**
//      （突变任意一个字节，parser 必须拒绝），它们不依赖往返。
//   ❌ **没有**覆盖制品语义：一个没有 `skill.json` 的目录能打成合法 tar.gz。
//      那一层由 `packArtifact()` 强制，`packEntries()` 只承诺 tar/gzip 形状。
//
// ⚠️ **gzip 字节的跨版本一致性不在承诺内**：zlib 的输出跨 Node / 架构不保证逐字节
//    相同（`untar.mjs` 的 CANON_SLACK 注释里记着同一件事）。因此**同一棵源码树在两台
//    机器上打出的 `asset.sha256` 可能不同**。制品的身份是**发布时那一串字节**，
//    发布链必须传递已构建的资产、不得让下游重新打包再比对摘要。
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, join, sep } from 'node:path';
import { deflateRawSync, constants as zlibConstants } from 'node:zlib';

import { writeCanonicalTar } from './install.mjs';
import { createIsolatedDir, writeEntries, assertManifestBinding } from './artifact.mjs';
import {
  parseTar, gunzipCanonical, crc32, assertArtifactPath, canonicalUstarSplit,
  MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES,
} from './untar.mjs';
import { treeDigest } from './tree-digest.mjs';

/** packer 侧的失败。`code` 与 untar 的 `violation` 分属两个命名空间，别混用。 */
export class PackError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PackError';
    this.code = code;
  }
}
const bad = (code, msg, cause) => { throw new PackError(code, msg, cause); };

// 🔴 canonical deflate 参数必须与 `untar.gunzipCanonical` 用来核算分母的那一组**完全一致**。
//    untar 没有导出它（那是它的内部常量），所以这里重复写一遍是不可避免的；
//    但 `packEntries()` 的自反解会把这份重复变成**可证伪的**：参数一旦不一致，
//    canonical 重压缩比对（E_GZIP_NONCANONICAL）当场就红。
//    windowBits/memLevel/strategy 全部显式钉死 —— 任一走默认，换个 Node 就可能算出别的长度。
const CANON_DEFLATE = Object.freeze({
  level: 9,
  windowBits: 15,
  memLevel: 8,
  strategy: zlibConstants.Z_DEFAULT_STRATEGY,
});

const ALLOWED_MODES = new Set([0o644, 0o755]);

// ── gzip 封套 ───────────────────────────────────────────────────────────────

/**
 * canonical gzip（02-registry.md §4.1）：`CM=8`、`FLG=0`、`MTIME=0`、`XFL=2`、`OS=255`，
 * 单 member，尾部 CRC32 + ISIZE，之后什么都没有。
 *
 * 🔴 `FLG` 整字节 0 —— 不只是没有 FNAME/FCOMMENT，连 FTEXT / FEXTRA / FHCRC 与三个
 * 保留位都不许置。它们都是「规范没定义的组合」，读取端一律拒。
 */
export function gzipCanonical(tar) {
  const body = deflateRawSync(tar, CANON_DEFLATE);
  const head = Buffer.from([
    0x1f, 0x8b, // magic
    0x08,       // CM = deflate
    0x00,       // FLG = 0（整字节）
    0x00, 0x00, 0x00, 0x00, // MTIME = 0
    0x02,       // XFL = 2（level 9 的取值）
    0xff,       // OS = 255（unknown）
  ]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(tar), 0);        // 🔴 复用读取端那一份 crc32，不另写
  tail.writeUInt32LE(tar.length >>> 0, 4);  // ISIZE（载荷 ≤16 MiB，不会绕回）
  return Buffer.concat([head, body, tail]);
}

// ── 打包 ────────────────────────────────────────────────────────────────────

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) bad('E_PACK_INPUT', 'entries 必须是数组');
  if (entries.length === 0) {
    // 空归档在 parseTar 里是 E_NO_EOF... 实际上「只有两个零块」会被判 E_TRUNCATED 之外的
    // 分支放过去，但一个没有任何文件的制品在 §5 下没有意义（连 SKILL.md / pack.json
    // 都没有）。早报早清楚。
    bad('E_PACK_EMPTY', '载荷为空：制品至少要有一个文件（§5.1/§5.2 要求根上有 manifest）');
  }
  return entries.map((e, i) => {
    const w = `entries[${i}]`;
    if (e === null || typeof e !== 'object') bad('E_PACK_INPUT', `${w} 必须是对象`);
    if (typeof e.path !== 'string') bad('E_PACK_INPUT', `${w}.path 必须是字符串`);
    if (!ALLOWED_MODES.has(e.mode)) {
      bad('E_PACK_MODE', `${w}.mode 只允许 0644 / 0755，得到 ${JSON.stringify(e.mode)}（§5）`);
    }
    if (!Buffer.isBuffer(e.data)) bad('E_PACK_INPUT', `${w}.data 必须是 Buffer`);
    // 早报：路径 grammar 与 ustar 可切分性。**这两条不是权威判定** ——
    // 权威判定是下面的自反解。放在这里只是为了让错误信息指向具体那一条，
    // 而不是等到自反解时报一个「我写出来的东西自己读不回来」。
    assertArtifactPath(e.path, w);
    if (canonicalUstarSplit(e.path) === null) {
      bad('E_PACK_USTAR', `${w}.path 无法被 ustar 的 prefix(155)+name(100) 切分：${e.path}（§4.3）`);
    }
    if (e.data.length > MAX_FILE_BYTES) {
      bad('E_PACK_FILE_SIZE', `${w} 单文件 ${e.data.length} 字节超过 ${MAX_FILE_BYTES}（§5）：${e.path}`);
    }
    return { path: e.path, mode: e.mode, data: e.data };
  });
}

/**
 * entries → canonical tar.gz。
 *
 * 🔴 产出**立刻被自己的解析器反解并逐条比对**（见文件头的设计说明）。
 * 反解不过的输入就不是可打包的输入 —— packer 的接受集合按构造等于 parser 的。
 *
 * @returns {{tar: Buffer, bytes: Buffer, sha256: string, size: number,
 *            entries: Array<{path:string,mode:number,data:Buffer}>}}
 *          `bytes` 是最终制品（gzip）；`sha256` 就是快照里的 `asset.sha256`。
 */
export function packEntries(entries) {
  const norm = normalizeEntries(entries);
  if (norm.length > MAX_FILES) {
    bad('E_PACK_FILE_COUNT', `文件数 ${norm.length} 超过 ${MAX_FILES}（§5）`);
  }
  const total = norm.reduce((n, e) => n + e.data.length, 0);
  if (total > MAX_TOTAL_BYTES) {
    bad('E_PACK_TOTAL_SIZE', `解压后总计 ${total} 字节超过 ${MAX_TOTAL_BYTES}（§5）`);
  }

  const tar = writeCanonicalTar(norm);   // 🔴 复用既有写入端，不另写一个 tar writer

  // ── 自反解 ① tar ─────────────────────────────────────────────────────────
  // parseTar 抛出的 TarViolation 原样向上传 —— 它的 violation 码（E_CASE_COLLIDE、
  // E_PATH_FILE_DIR_COLLIDE、E_ORDER…）**就是**对输入的准确诊断，包一层反而丢信息。
  const back = parseTar(tar);
  const want = [...norm].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  if (back.entries.length !== want.length) {
    bad('E_PACK_ROUNDTRIP',
      `自反解条目数不符：写入 ${want.length}，读回 ${back.entries.length}`);
  }
  for (let i = 0; i < want.length; i++) {
    const a = want[i], b = back.entries[i];
    if (a.path !== b.path || a.mode !== b.mode || !a.data.equals(b.data)) {
      bad('E_PACK_ROUNDTRIP',
        `自反解第 ${i} 项不符：写入 ${JSON.stringify(a.path)}/0${a.mode.toString(8)}/${a.data.length}B，`
        + `读回 ${JSON.stringify(b.path)}/0${b.mode.toString(8)}/${b.data.length}B`);
    }
  }

  // ── 自反解 ② gzip ────────────────────────────────────────────────────────
  const bytes = gzipCanonical(tar);
  const backTar = gunzipCanonical(bytes);
  if (!backTar.equals(tar)) {
    bad('E_PACK_ROUNDTRIP', `gzip 自反解字节不符（${backTar.length} vs ${tar.length}）`);
  }

  return {
    tar,
    bytes,
    size: bytes.length,
    sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    entries: want,
  };
}

// ── 目录树 → entries ────────────────────────────────────────────────────────

/**
 * 无跟随遍历一棵载荷目录，产出 entries。
 *
 * 拒绝：symlink、hardlink、非普通文件、mode 非 0644/0755、**空目录**（§5：不可表示）、
 * 以及 §4 路径 grammar 的一切违规（含 AppleDouble 的专门违规码）。
 *
 * 🔴 空目录必须**拒绝而不是静默忽略**：忽略等于「打出来的包与源目录不是同一棵树」，
 *    而打包的人无从知道。同 E-6 的教训 —— 诊断必须针对字节。
 */
export function collectTree(root) {
  // 🔴 根本身也要查：「遍历时拒绝 symlink」不覆盖根路径 —— 把 root 指到一个
  //    symlink 上，第一次 readdir 就已经跟随过去了（Codex 第一轮 #4）。
  const rootSt = lstatSync(root);
  if (rootSt.isSymbolicLink()) bad('E_PACK_SYMLINK', `载荷根 ${root} 是 symlink，拒绝跟随`);
  if (!rootSt.isDirectory()) bad('E_PACK_INPUT', `载荷根 ${root} 不是目录`);
  const out = [];
  (function rec(dir) {
    const names = readdirSync(dir);
    let files = 0;
    for (const name of names.sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const rel = relative(root, abs).split(sep).join('/').normalize('NFC');
      if (st.isSymbolicLink()) bad('E_PACK_SYMLINK', `拒绝 symlink：${rel}（§5）`);
      if (st.isDirectory()) {
        // 目录名同样要过路径 grammar —— 否则一个非法目录名要等到它下面的文件
        // 才被报出来，错误信息指向的是文件而不是真正的病灶。
        assertArtifactPath(rel, `dir:${rel}`);
        const n = rec(abs);
        if (n === 0) {
          bad('E_PACK_EMPTY_DIR',
            `空目录不可表示，制品禁止空目录（§5）：${rel}。`
            + `它不会进树摘要，也不会进归档 —— 静默丢掉会让制品与源目录不是同一棵树`);
        }
        files += n;
        continue;
      }
      if (!st.isFile()) bad('E_PACK_NOT_REGULAR', `拒绝非普通文件（FIFO/socket/设备）：${rel}（§5）`);
      if (st.nlink !== 1) bad('E_PACK_HARDLINK', `拒绝 hardlink（nlink=${st.nlink}）：${rel}（§5）`);
      // 🔴 掩码取 0o7777 而不是 0o777：`& 0o777` 会把 setuid/setgid/sticky **静默抹掉**，
      //    于是 `chmod 4755 SKILL.md` 被当成一个普通的 0755 文件收下（Codex 第二轮 #3）。
      //    §5 说的是「mode 只允许 0644 或 0755」——**恰好等于**，不是「低九位等于」。
      //    截断是最坏的处理方式：源树里那个特权位既没被拒绝、也没被保留，
      //    打包的人不会知道它消失了。
      const mode = st.mode & 0o7777;
      if (!ALLOWED_MODES.has(mode)) {
        bad('E_PACK_MODE',
          `文件 mode 只允许 0644 / 0755，${rel} 是 0${mode.toString(8)}（§5）`
          + ((st.mode & 0o7000) ? '；它带了 setuid/setgid/sticky 位' : ''));
      }
      assertArtifactPath(rel, `file:${rel}`);
      out.push({ path: rel, mode, data: readFileSync(abs) });
      files++;
    }
    return files;
  })(root);
  if (out.length === 0) bad('E_PACK_EMPTY', `载荷目录没有任何文件：${root}`);
  return out;
}

/**
 * 一棵目录树 → 完整的制品身份三件套。
 *
 * 🔴 `tree_digest` 走**共享的** `tree-digest.mjs`（§6.3：CLI 与 CI 一份实现，
 *    两份必然分叉、而分叉点正好是绕过点）。packer 不自己算摘要。
 *
 * 🔴 **摘要算的是「归档里的那棵树」，不是源目录**（Codex 第一轮 #4）：
 *    先把打好的 entries 写进一个隔离临时目录，再对它算摘要。
 *    直接 `treeDigest(root)` 是**第二次读源目录** —— 打包与算摘要之间源文件被改，
 *    产出的 `asset.sha256` 与 `tree_digest` 就会指向两棵不同的树，
 *    而安装端要到解包后重算摘要时才发现（那时已经发布出去了）。
 *    这与 R-1 是同一形状：判据必须落在**我们手上的那份字节**上。
 *
 * @returns {{entries, tar, bytes, size, sha256, tree_digest}}
 */
export function packDirectory(root, { parent = tmpdir() } = {}) {
  const entries = collectTree(root);
  const packed = packEntries(entries);
  const dir = createIsolatedDir(parent);
  try {
    writeEntries(dir, packed.entries);
    return { ...packed, tree_digest: treeDigest(dir) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

/**
 * 🔴 **最终 packer 入口** —— 在 `packDirectory()` 之上强制 §5.1/§5.2 的载荷规则。
 *
 * Codex 第一轮 #4 指出的口子：`packEntries()` 只保证「产出能被 `parseTar` 接受」，
 * 而**制品的接受集合比 tar 的窄** —— 一个没有 `skill.json` 的目录照样能打成
 * 合法 tar.gz，然后在 `verifyArtifact()` 那里被拒。打包的人要等到安装才知道。
 * 所以「打一个制品」这个动作必须在这里就把 manifest 必需项判掉。
 *
 * `packEntries` / `packDirectory` 保留为**底层 API**，前置条件写在这里：
 * 它们只承诺 tar/gzip 形状，不承诺制品语义。
 *
 * @param {'skill'|'pack'} kind
 */
export function packArtifact({ root, kind, record = null, parent = tmpdir() }) {
  if (kind !== 'skill' && kind !== 'pack') bad('E_PACK_INPUT', `kind 只能是 skill / pack，得到 ${JSON.stringify(kind)}`);
  const entries = collectTree(root);
  const packed = packEntries(entries);
  const have = new Set(packed.entries.map(e => e.path));
  const need = kind === 'skill' ? ['SKILL.md', 'skill.json'] : ['pack.json'];
  for (const f of need) {
    if (!have.has(f)) bad('E_PACK_MANIFEST_MISSING', `${kind} 载荷根缺少 ${f}（01-artifacts.md §5.1/§5.2）`);
  }
  // 反向：skill 载荷不得带 pack.json，反之亦然 —— 两个 manifest 并存时
  // 「这是什么制品」有两个答案，而 assertManifestBinding 只读其中一个。
  // ⚠️ 这一条**比 `verifyArtifact()` 严**（它不查 foreign manifest）。方向是安全的
  //    （生产侧更严），但两侧接受集合确实不等，已写进交付汇报。
  const foreign = kind === 'skill' ? 'pack.json' : 'skill.json';
  if (have.has(foreign)) bad('E_PACK_MANIFEST_MISSING', `${kind} 载荷根不得同时带 ${foreign}`);

  const dir = createIsolatedDir(parent);
  try {
    writeEntries(dir, packed.entries);
    // 🔴 给了 record 就跑**真正的**绑定校验（§5.3 的六/七项全等）。
    //    只查「manifest 文件在不在」是不够的 —— `skill.json = {}` 也能过存在性检查，
    //    然后在安装端被 verifyArtifact 拒掉（Codex 第二轮 #3）。
    //    这里刻意调 artifact.mjs 那一份，**不另写一个校验器**：
    //    打包端与安装端判的必须是同一件事。
    if (record !== null) assertManifestBinding(record, dir);
    return { ...packed, kind, tree_digest: treeDigest(dir), boundTo: record?.id ?? null };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

/**
 * 05-lifecycle.md §6.1 / 08-matrix-migration.md §3.1 的**上游侧**摘要。
 *
 * vendored 制品在导入时必然新增 `skill.json`，所以它的 `tree_digest` 与上游那棵树
 * 的摘要**不可能相等**（v1 承诺两者一致，那是错的）。这个函数算的是上游那一份，
 * 即 `provenance.origin_tree_digest` 的**内容**。
 *
 * ⚠️ **书写形式有冲突，调用方必须知道**：本函数返回 `geoly-tree-v1:sha256:<hex>`
 * （§6.1 规定算法标识进入每一个摘要值本身）；而 `snapshot.mjs` 对
 * `provenance.origin_tree_digest` 用的是 `assertAssetDigest`，只接受 `sha256:<hex>`
 * ——两者不兼容。见交付汇报「迁移视角」。这里**不做静默转换**：
 * 静默截掉算法前缀正是 E-3 要消灭的「一个逻辑值多种书写」。
 */
export function payloadTreeDigest(root) {
  return treeDigest(root);
}

export { MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES };
