// vendor —— 03-packs.md §6 的**物化器**。
//
// pack 是引用不是容器（§1），单独取 pack 得不到完整的目录树。
// 08-matrix-migration.md 要把主题仓的 vendored 目录改为「从 hub 取」，因此需要
// 一个把 pack + 全部成员摊平成目录树的东西。
//
//   npx <hub CLI> vendor pack:geoly/plaud-theme-matrix@0.3.6 \
//       --out .github/codex/plaud-theme-matrix --layout flat
//   （包名以 package.json 为准，本模块不写死 —— ERRATA 里正有一条在改它）
//
// 🔴 **本模块只做库，不做命令面。** 参数解析、下载、进度输出都在 CLI 那一侧。
// 本模块拿到的是「已经在内存里的字节 + 对应的快照 record」。
//
// 🔴 **`vendor` 不走安装账本** —— 它写的是用户仓库里的目录，不是 client skills 目录。
// 所以这里没有 generation、没有 attic、没有 refcount；但**整目录替换的事务纪律
// 与安装同样严格**：先在同一文件系统上把新树建完整，再一次 rename 换上去。
import { mkdtempSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, isAbsolute, basename } from 'node:path';

import { withVerifiedArtifact, writeEntries } from './artifact.mjs';
import { renameDirFsync, rmtreeFsync, fsyncDir, sameDevice, writeAtomic } from './atomic-fs.mjs';
import { treeDigest } from './tree-digest.mjs';
import { stringify, parseStrict } from './canonical-json.mjs';
import { collectTree, PackError } from './packer.mjs';
import { validatePackManifest, parseArtifactId } from './pack.mjs';

export const VENDORED_SCHEMA = 'geoly.skills.vendored/1';
export const VENDORED_FILE = 'VENDORED.json';
export const VENDOR_INTENT_SCHEMA = 'geoly.skills.vendor-intent/1';

const bad = (code, msg) => { throw new PackError(code, msg); };

/**
 * 🔴 **「整目录替换」在纯 Node 里做不成真原子的 —— 这里如实说明，不假装。**
 *
 * §6 说 vendor 与安装「同样的事务纪律」。安装靠的是 tx 目录 + journal + generation
 * 水位；vendor 不走账本，所以只能自己带一份**最小意图文件**。
 *
 * 我们能给的承诺，逐条：
 *   ✅ `out` **永远不会是半新半旧的混合树** —— 新树在 staging 上建完整、验过摘要，
 *      才开始换；换的过程只有两次 rename，没有逐文件覆盖。
 *   ❌ **不承诺**「任一时刻 `out` 都存在」。两次 rename 之间崩溃会留下 `out` 缺席。
 *      这不是可以掩盖的窗口：`renameat2(RENAME_EXCHANGE)` 在 Node 里拿不到，
 *      而「先删旧再换新」的空窗更长、「逐文件覆盖」直接产生混合树。
 *   ✅ 那个窗口**可恢复**：换之前先落 `.geoly-vendor-intent.json`（原子写 + fsync），
 *      记下 staging / out / retired 三个路径；`recoverVendor(parent)` 按它把状态收敛到
 *      「新树就位」或「旧树复原」，二选一，不留中间态。
 *
 * ⚠️ 意图文件里没有摘要以外的秘密：它只是**指路**，恢复时仍然重新验树摘要。
 */
function intentPath(parent) { return join(parent, '.geoly-vendor-intent.json'); }

export const STAGING_PREFIX = '.geoly-vendor-';
export const RETIRED_PREFIX = '.geoly-vendor-old-';

/**
 * 🔴 `existsSync` 是 fail-open 的：悬空 symlink、EACCES 都返回 false，
 * 于是「看不见」被当成「不存在」。凡是要据此**删除或覆盖**的判断都必须用这个。
 */
function lstatOrNull(p) {
  try { return lstatSync(p); } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw e;   // EACCES 之类：看不见就不能声称它不存在
  }
}

/** §6 目前只定义了 `flat`。**别的值不给「合理默认」**，直接拒。 */
export const LAYOUTS = Object.freeze(['flat']);

/**
 * `<out>/VENDORED.json` —— 供 CI 复核与后续重取（§6）。
 *
 * 🔴 记的是 **pack id、snapshot、每个成员的 id 与 `tree_digest`**。
 *    不记 asset.sha256：那是**制品字节**的身份，而物化出来的是**目录树**，
 *    树摘要才是能对着磁盘复算的那一个。记一个复算不了的值，CI 只能选择信任它。
 */
export function buildVendoredManifest({ packId, snapshot, layout, members, skipped = [] }) {
  const a = parseArtifactId(packId, 'pack id');
  if (a.kind !== 'pack') bad('E_VENDOR_INPUT', `vendor 的对象必须是 pack:，得到 ${packId}`);
  if (!Number.isSafeInteger(snapshot) || snapshot < 0) bad('E_VENDOR_INPUT', 'snapshot 必须是非负整数');
  if (!LAYOUTS.includes(layout)) bad('E_VENDOR_LAYOUT', `--layout 只支持 ${LAYOUTS.join(' / ')}，得到 ${JSON.stringify(layout)}`);
  return {
    schema: VENDORED_SCHEMA,
    pack: packId,
    snapshot,
    layout,
    members: [...members]
      .map(m => ({ dir: m.dir, id: m.id, role: m.role, tree_digest: m.tree_digest }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
    skipped: [...skipped].sort(),
  };
}

/**
 * 物化 pack + 成员到 `out`，**整目录替换**。
 *
 * 布局（`flat`，= 先例 vendored 目录的契约）：
 * ```
 * <out>/VENDORED.json
 * <out>/<成员 name>/…          每个成员的载荷
 * <out>/<pack 自己的载荷文件>   MATRIX.md / AGENTS.md / README.md / pack.json …
 * ```
 *
 * 🔴 pack 自己的载荷放在 `<out>` 根上（08-matrix-migration.md §4：
 * `MATRIX.md` / `AGENTS.md` / `README.md` / `CHANGELOG.md` 作为 pack 载荷的说明文档带进来）。
 * 若某个 pack 载荷文件的**首段**与某个成员目录同名 → 拒绝，不做「谁覆盖谁」的默认。
 *
 * @param {object} a
 * @param {{bytes:Buffer, record:object}} a.pack     pack 制品本身
 * @param {Array<{bytes:Buffer, record:object, role:string}>} a.members  已按 role 分好的成员
 * @param {string} a.out          绝对路径。**整目录被替换**
 * @param {number} a.snapshot     解析所用快照号
 * @param {string} [a.layout]
 * @returns {{out:string, tree_digest:string, members:Array, skipped:string[]}}
 */
export function materializeVendor({ pack, members, out, snapshot, layout = 'flat', skipped = [] }) {
  if (!LAYOUTS.includes(layout)) bad('E_VENDOR_LAYOUT', `--layout 只支持 ${LAYOUTS.join(' / ')}，得到 ${JSON.stringify(layout)}`);
  if (typeof out !== 'string' || !isAbsolute(out)) bad('E_VENDOR_INPUT', `--out 必须是绝对路径，得到 ${JSON.stringify(out)}`);
  const parent = dirname(out);
  if (lstatOrNull(parent) === null) bad('E_VENDOR_INPUT', `--out 的父目录不存在：${parent}`);
  // 🔴 out 的类型判定必须**排在最前面**，尤其排在任何会 stat（跟随）的检查之前。
  //    悬空 symlink 上 `sameDevice()` 里的 statSync 会先抛 ENOENT，
  //    于是报出来的是「文件不存在」而不是「这是个 symlink，拒绝」——
  //    诊断指向完全错的方向，而 symlink 那道门其实根本没跑到。
  const outSt = lstatOrNull(out);
  if (outSt !== null) {
    if (outSt.isSymbolicLink()) bad('E_VENDOR_TARGET', `${out} 是 symlink，拒绝替换（不跟随）`);
    if (!outSt.isDirectory()) bad('E_VENDOR_TARGET', `${out} 不是目录`);
    // 🔴 staging 必须与 out 同一个文件系统 —— rename 跨设备会失败（EXDEV），
    //    而「先复制再删」不是原子的。所以 staging 建在 out 的**父目录**里，不在 /tmp。
    if (!sameDevice(out, parent)) {
      bad('E_VENDOR_XDEV', `${out} 与其父目录不在同一文件系统上，无法原子替换`);
    }
  }

  // 早报：上一次没收尾就别开始新的。放在这里是为了**不做无用功** ——
  // 把全部成员解包完再报「上一次没收尾」，白跑几秒还留一堆临时目录。
  // ⚠️ 这是预检，不是保证（R-3）；真正的判定在交换点前**再查一次**。
  if (lstatOrNull(intentPath(parent)) !== null) {
    bad('E_VENDOR_INTENT_PENDING',
      `${intentPath(parent)} 还在：上一次 vendor 没收尾。先跑 recoverVendor()，不要覆盖它`);
  }

  const staging = mkdtempSync(join(parent, STAGING_PREFIX));
  let retired = null;
  try {
    const memberInfo = [];
    const usedDirs = new Map();

    for (const m of members) {
      // 🔴 嵌套 pack 成员：`flat` 布局对它**没有定义** —— 是把它自己的成员也摊到
      //    同一层（可能与外层成员撞名），还是给它一层目录（那就不是 flat 了）？
      //    规范没写，所以拒绝，不给「合理默认」。
      if (m.record.kind === 'pack') {
        bad('E_VENDOR_NESTED_PACK',
          `成员 ${m.record.id} 是 pack。§6 的 flat 布局没有定义嵌套 pack 的物化方式，拒绝`);
      }
      if (m.record.kind !== 'skill') bad('E_VENDOR_INPUT', `成员 ${m.record.id} 的 kind 不合法`);
      // 目录名 = name（四端 skills 目录是平铺的，vendored 目录沿用同一契约）
      const dir = m.record.name;
      if (usedDirs.has(dir)) {
        bad('E_VENDOR_DIR_COLLIDE', `两个成员都要物化到 ${dir}/：${usedDirs.get(dir)} 与 ${m.record.id}`);
      }
      usedDirs.set(dir, m.record.id);
      // 🔴 验签由调用方在拿 record 时做；这里做的是**验摘要 + 隔离解包**，
      //    并且用 withVerifiedArtifact —— 它结构上不可能忘记清理临时目录。
      withVerifiedArtifact({ bytes: m.bytes, record: m.record }, (art) => {
        const prefixed = art.entries.map(e => ({ ...e, path: `${dir}/${e.path}` }));
        writeEntries(staging, prefixed);
        memberInfo.push({ dir, id: m.record.id, role: m.role, tree_digest: art.treeDigest });
      });
    }

    // 🔴 大小写折叠冲突：macOS 上 `Foo/` 与 `foo/` 是同一个目录。
    const fold = new Map();
    for (const [d, id] of usedDirs) {
      const f = d.toLowerCase();
      if (fold.has(f)) bad('E_VENDOR_DIR_COLLIDE', `成员目录 ${d} 与 ${fold.get(f)} 大小写折叠后相同（macOS 上会互相覆盖）`);
      fold.set(f, d);
    }

    // pack 自己的载荷落在根上
    let packManifest = null;
    withVerifiedArtifact({ bytes: pack.bytes, record: pack.record }, (art) => {
      packManifest = validatePackManifest(JSON.parse(
        art.entries.find(e => e.path === 'pack.json').data.toString('utf8')));
      for (const e of art.entries) {
        const head = e.path.split('/')[0];
        if (usedDirs.has(head)) {
          bad('E_VENDOR_DIR_COLLIDE',
            `pack 载荷里的 ${e.path} 与成员目录 ${head}/ 冲突（§6 的 flat 布局把两者放在同一层）`);
        }
        if (e.path === VENDORED_FILE) {
          bad('E_VENDOR_DIR_COLLIDE', `pack 载荷里出现 ${VENDORED_FILE}，会与物化器自己写的那份冲突`);
        }
      }
      writeEntries(staging, art.entries);
    });

    // 🔴 **交上来的成员必须正好是 pack.json 锁定的那一组。**
    //    不查的话，调用方可以少给一个（物化出一棵缺东西的树，而 VENDORED.json 照样
    //    自洽）或多给一个（往 vendored 目录里塞不属于这个 pack 的 skill）——
    //    pack 是引用，物化器是它唯一一次把引用兑现成字节的地方，兑现得对不对
    //    只有在这里能判。判据是**摘要也要对上**，不只是 id 对上。
    const declared = new Map([...packManifest.members, ...packManifest.bundled]
      .map(m => [m.id, m.tree_digest]));
    const given = new Set(memberInfo.map(m => m.id));
    const skippedSet = new Set(skipped);
    for (const [id, td] of declared) {
      if (given.has(id)) {
        const got = memberInfo.find(m => m.id === id).tree_digest;
        if (got !== td) {
          bad('E_VENDOR_MEMBER_DIGEST',
            `完整性事件：成员 ${id} 物化出来的树摘要是 ${got}，pack.json 锁的是 ${td}`);
        }
        continue;
      }
      if (!skippedSet.has(id)) {
        bad('E_VENDOR_MEMBER_MISSING', `pack 锁定了成员 ${id}，但没有交上来，也没有列进 skipped`);
      }
    }
    for (const id of given) {
      if (!declared.has(id)) bad('E_VENDOR_MEMBER_EXTRA', `交上来的 ${id} 不是 ${packManifest.id} 的成员`);
    }

    const manifest = buildVendoredManifest({
      packId: pack.record.id, snapshot, layout, members: memberInfo, skipped,
    });
    writeEntries(staging, [{
      path: VENDORED_FILE, mode: 0o644, data: Buffer.from(stringify(manifest), 'utf8'),
    }]);
    fsyncDir(staging);

    const digest = treeDigest(staging);

    // ── 整目录替换（带恢复意图，见文件头的承诺清单） ──────────────────────
    // 🔴 判「out 在不在」不能用 existsSync：它对**悬空 symlink** 返回 false
    //    （fail-open）。于是 `ln -s /does/not/exist out` 会被当成「目标不存在」，
    //    直接被 rename 覆盖掉。判据必须是 lstat 的 errno。
    //    ⚠️ 这里是**复验**：函数入口已经判过一次类型，但那是几百毫秒之前的快照
    //    （中间跑完了全部成员的解包）。同 R-3：预检不保证世界不会变，
    //    真正的动作点必须自己复验它依赖的那几项。
    const nowSt = lstatOrNull(out);
    if (nowSt !== null) {
      if (nowSt.isSymbolicLink()) bad('E_VENDOR_TARGET', `${out} 在物化期间被换成了 symlink，拒绝`);
      if (!nowSt.isDirectory()) bad('E_VENDOR_TARGET', `${out} 在物化期间被换成了非目录，拒绝`);
    }
    const willRetire = nowSt !== null;
    const intent = intentPath(parent);
    const retiredPath = join(parent, `${RETIRED_PREFIX}${basename(staging)}`);
    if (lstatOrNull(intent) !== null) {
      bad('E_VENDOR_INTENT_PENDING',
        `${intent} 还在：上一次 vendor 没收尾。先跑 recoverVendor()，不要覆盖它`);
    }
    writeAtomic(intent, Buffer.from(stringify({
      schema: VENDOR_INTENT_SCHEMA,
      out, staging, retired: willRetire ? retiredPath : null, tree_digest: digest,
    }), 'utf8'));
    fsyncDir(parent);

    if (willRetire) { renameDirFsync(out, retiredPath); retired = retiredPath; }
    renameDirFsync(staging, out);
    // 🔴 **先删 retired，最后才删 intent。** 反过来（先删 intent 再删 retired）
    //    会多出一个无人认领的状态：intent 已经没了，retired 还在，
    //    recoverVendor 返回 none，那棵旧树变成永远回收不掉的 orphan（Codex 第二轮 #1）。
    //    intent 是「还没收尾」的唯一标记，所以它必须是**最后**一个消失的东西。
    if (retired !== null) { rmtreeFsync(retired); retired = null; }
    rmSync(intent, { force: true });
    fsyncDir(parent);

    return { out, tree_digest: digest, pack: packManifest.id, members: memberInfo, skipped };
  } finally {
    // staging 若还在（中途失败），清掉
    try { if (lstatOrNull(staging) !== null) rmtreeFsync(staging); } catch { /* 尽力而为 */ }
    // 🔴 **retired 只放回去，绝不在这里删。**
    //    Codex 第二轮给的反例：① 第一次 rename 把旧 out 移到 retired；
    //    ② 外部进程抢先建了一个新的 out；③ 第二次 rename 失败；
    //    ④ 旧版 finally 看到 out 存在，就把 retired 删了 —— 结果是**外部那个目录留下、
    //    真正的旧树被删掉**，而且 intent 也一并没了，人工都恢复不了。
    //    补偿动作比不补偿更糟，这是最坏的一种。
    //    现在的规矩：out 缺席才放回去；否则原样留着 retired 与 intent，交给
    //    recoverVendor / 人工判断。**留下证据永远好过替人做决定。**
    if (retired !== null) {
      try {
        if (lstatOrNull(out) === null) {
          renameDirFsync(retired, out);
          rmSync(intentPath(parent), { force: true });
          fsyncDir(parent);
        }
      } catch { /* 尽力而为；剩下的交给 recoverVendor */ }
    }
  }
}

/**
 * 🔴 意图文件是**磁盘上的普通文件**，谁都能改它 —— 而 recover 会照着它
 * **删目录**。所以它必须像任何 wire 输入一样被严格校验，不能只看 schema。
 *
 * Codex 第二轮给的恶意样例：把 staging / retired 指向 `/tmp/delete-me`，
 * recover 就会替攻击者删掉那两个目录。
 *
 * 约束（缺一不可）：
 *   · 三个路径都是绝对路径；
 *   · `staging` / `retired` **必须就在 `parent` 下**，且带我们自己的前缀 —— 
 *     recover 只允许删自己建的东西；
 *   · `out` 也必须在 `parent` 下（materializeVendor 的 staging 就建在 out 的父目录里）；
 *   · `retired` 要么是 null，要么是字符串（缺字段会让 existsSync(undefined) 抛 TypeError）；
 *   · `tree_digest` 形状正确。
 */
function assertIntentShape(doc, parent, where) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) bad('E_VENDOR_INTENT', `${where} 不是对象`);
  if (doc.schema !== VENDOR_INTENT_SCHEMA) bad('E_VENDOR_INTENT', `${where} 的 schema 不认识：${JSON.stringify(doc.schema)}`);
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'out,retired,schema,staging,tree_digest') bad('E_VENDOR_INTENT', `${where} 的键集不对：${keys}`);
  const { out, staging, retired, tree_digest } = doc;
  for (const [k, v] of [['out', out], ['staging', staging]]) {
    if (typeof v !== 'string' || !isAbsolute(v)) bad('E_VENDOR_INTENT', `${where}.${k} 必须是绝对路径`);
    if (dirname(v) !== parent) bad('E_VENDOR_INTENT', `${where}.${k} 不在 ${parent} 下：${v}`);
  }
  if (!basename(staging).startsWith(STAGING_PREFIX)) {
    bad('E_VENDOR_INTENT', `${where}.staging 不带 ${STAGING_PREFIX} 前缀 —— recover 只删自己建的目录：${staging}`);
  }
  if (retired !== null) {
    if (typeof retired !== 'string' || !isAbsolute(retired)) bad('E_VENDOR_INTENT', `${where}.retired 必须是 null 或绝对路径`);
    if (dirname(retired) !== parent) bad('E_VENDOR_INTENT', `${where}.retired 不在 ${parent} 下：${retired}`);
    if (!basename(retired).startsWith(RETIRED_PREFIX)) {
      bad('E_VENDOR_INTENT', `${where}.retired 不带 ${RETIRED_PREFIX} 前缀：${retired}`);
    }
  }
  if (typeof tree_digest !== 'string' || !/^geoly-tree-v1:sha256:[0-9a-f]{64}$/.test(tree_digest)) {
    bad('E_VENDOR_INTENT', `${where}.tree_digest 形状不对：${JSON.stringify(tree_digest)}`);
  }
  return { out, staging, retired, tree_digest };
}

/**
 * 把一次被打断的 `materializeVendor()` 收敛到二选一的终态。
 *
 * 逐崩溃点（意图文件在，说明换到一半）：
 *   · `staging` 还在、`out` 也在  → 换还没开始。删 staging，保留 out（**回到旧树**）。
 *   · `staging` 还在、`out` 不在  → 第一次 rename 之后崩的（旧树在 retired）。
 *     继续做第二次 rename（**前滚到新树**），再删 retired。
 *   · `staging` 不在、`out` 在    → 两次 rename 都做完了，只是没删 intent / retired。删掉即可。
 *   · `staging` 不在、`out` 不在  → 只可能是 retired 还在（新树没建成）。把 retired 换回来。
 *
 * 🔴 前滚之前**重新算一次树摘要并与意图里那份比对** —— 意图文件只指路，不作数。
 */
export function recoverVendor(parent) {
  const intent = intentPath(parent);
  if (lstatOrNull(intent) === null) return { action: 'none' };
  let doc;
  try {
    doc = parseStrict(readFileSync(intent, 'utf8'));
  } catch (e) {
    // 截断 / 非法 JSON：**不删它**。删掉等于把「有一次没收尾」这个事实也抹掉。
    bad('E_VENDOR_INTENT', `${intent} 解析失败（截断或被改坏），需人工处置：${e.message}`);
  }
  const { out, staging, retired, tree_digest } = assertIntentShape(doc, parent, intent);

  const stStaging = lstatOrNull(staging);
  const stOut = lstatOrNull(out);
  const stRetired = retired === null ? null : lstatOrNull(retired);
  // 🔴 三个路径都不许是 symlink：recover 会**删除**或 **rename** 它们，
  //    跟随一次就等于把删除动作转嫁到别人的目录上（Codex 第二轮 #1）。
  for (const [label, st, p] of [['staging', stStaging, staging], ['out', stOut, out], ['retired', stRetired, retired]]) {
    if (st !== null && st.isSymbolicLink()) bad('E_VENDOR_RECOVER', `${label} (${p}) 是 symlink，拒绝在恢复流程里碰它`);
    if (st !== null && !st.isDirectory()) bad('E_VENDOR_RECOVER', `${label} (${p}) 不是目录，拒绝`);
  }

  let action;
  if (stStaging !== null && stOut !== null) {
    rmtreeFsync(staging);
    action = 'rolled-back';
  } else if (stStaging !== null) {
    const got = treeDigest(staging);
    if (got !== tree_digest) {
      bad('E_VENDOR_RECOVER', `staging 的树摘要是 ${got}，意图里记的是 ${tree_digest} —— 拒绝前滚`);
    }
    renameDirFsync(staging, out);
    action = 'rolled-forward';
  } else if (stOut !== null) {
    action = 'already-done';
  } else if (stRetired !== null) {
    renameDirFsync(retired, out);
    action = 'restored-old';
  } else {
    bad('E_VENDOR_RECOVER', `既没有 staging、也没有 ${out}、也没有 retired —— 状态无法收敛，需人工处置`);
  }
  if (retired !== null && lstatOrNull(retired) !== null && lstatOrNull(out) !== null) rmtreeFsync(retired);
  rmSync(intent, { force: true });
  fsyncDir(parent);
  return { action, out };
}

// ── 05-lifecycle.md §6.1 / 08-matrix-migration.md §3.1 的双摘要 ─────────────

/**
 * `scripts/verify-vendored.mjs` 那道 CI 门的**判定核心**（脚本面由别人接线）。
 *
 * 校验：hub 制品的载荷**去掉 `added_files` 白名单里的文件之后**，逐字节等于上游那棵树，
 * 且上游那棵树的摘要 == `provenance.origin_tree_digest`。
 * `added_files` 只允许 `["skill.json"]`；**任何其他新增、任何修改、任何删除都让门失败**。
 *
 * 🔴 判据是**逐字节**（path + mode + 内容），不是「文件都在」——
 *    「文件在不在」从来不是判据。
 *
 * ⚠️ **书写形式的冲突，本函数不替调用方吞掉**：
 *    §6.1 规定摘要值自带算法前缀（`geoly-tree-v1:sha256:…`），而 `snapshot.mjs`
 *    对 `provenance.origin_tree_digest` 用的是 `assertAssetDigest`，只接受 `sha256:…`。
 *    两者不兼容。本函数**要求传进来的期望值带 `geoly-tree-v1:` 前缀**（§6.1 的形式），
 *    不做静默截断 —— 静默转换正是 E-3 要消灭的「一个逻辑值多种书写」。
 *
 * @param {object} a
 * @param {string} a.hubPayloadDir     hub 制品解出来的载荷目录
 * @param {string} a.originDir         上游 origin_commit 下 origin_subpath 的原始文件
 * @param {string[]} a.addedFiles      provenance.added_files
 * @param {string} a.expectedOriginTreeDigest
 * @param {string[]} [a.allowedAddedFiles] 白名单，默认 ['skill.json']
 */
export function verifyVendoredPayload({
  hubPayloadDir, originDir, addedFiles, expectedOriginTreeDigest,
  allowedAddedFiles = ['skill.json'],
}) {
  if (!Array.isArray(addedFiles)) bad('E_VENDORED_ADDED', 'provenance.added_files 必填且必须是数组（ERRATA E-1）');
  const allow = new Set(allowedAddedFiles);
  for (const f of addedFiles) {
    if (!allow.has(f)) {
      bad('E_VENDORED_ADDED',
        `added_files 里的 ${JSON.stringify(f)} 不在白名单 [${[...allow].join(', ')}] 内`);
    }
  }
  if (new Set(addedFiles).size !== addedFiles.length) bad('E_VENDORED_ADDED', 'added_files 有重复项');

  const hub = new Map(collectTree(hubPayloadDir).map(e => [e.path, e]));
  const origin = new Map(collectTree(originDir).map(e => [e.path, e]));

  const added = new Set(addedFiles);
  // 🔴 声明为新增的文件必须**真的是新增**：上游已有同名文件时，把它列进 added_files
  //    就等于用白名单掩盖一次修改。
  for (const f of added) {
    if (!hub.has(f)) bad('E_VENDORED_ADDED', `added_files 声明了 ${f}，但 hub 载荷里没有它`);
    if (origin.has(f)) bad('E_VENDORED_ADDED', `added_files 声明 ${f} 是新增，但上游已经有这个文件（那是修改，不是新增）`);
  }

  const extra = [...hub.keys()].filter(p => !added.has(p) && !origin.has(p)).sort();
  if (extra.length) bad('E_VENDORED_EXTRA', `hub 载荷多出未声明的文件：${extra.join(', ')}`);
  const missing = [...origin.keys()].filter(p => !hub.has(p)).sort();
  if (missing.length) bad('E_VENDORED_MISSING', `hub 载荷缺少上游的文件（不允许删除）：${missing.join(', ')}`);

  const modified = [];
  for (const [p, o] of origin) {
    const h = hub.get(p);
    if (h.mode !== o.mode || !h.data.equals(o.data)) modified.push(p);
  }
  if (modified.length) bad('E_VENDORED_MODIFIED', `hub 载荷与上游逐字节不符：${modified.sort().join(', ')}`);

  const got = treeDigest(originDir);
  if (got !== expectedOriginTreeDigest) {
    bad('E_VENDORED_ORIGIN_DIGEST',
      `上游树摘要是 ${got}，provenance.origin_tree_digest 说是 ${expectedOriginTreeDigest}`);
  }
  return { origin_tree_digest: got, added_files: [...added].sort(), files: origin.size };
}

export { PackError };
