// Q12 夹具 —— `.geoly` 的**完整形态**，不是空壳。
//
// Q12 要问的是「客户端会不会把 .geoly 里的东西当成 skill」。
// 空壳答不了这个问题：里头必须真的有**有效、唯一、可识别**的 canary skill，
// 客户端要是收了它，读数就会动、名字就会出现在 catalog 里。
// docs/m1/00-gates.md 明文要求这一条。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** canary 名字每次随机 —— 固定名会与用户环境里恰好同名的 skill 撞车。 */
export function newCanary(kind) {
  return `q12-${kind}-${randomBytes(4).toString('hex')}`;
}

/**
 * 一个**有效**的 skill。四端认的都是 `<dir>/SKILL.md` + YAML frontmatter。
 * description 要够独特，才能在渲染出来的 prompt / 请求体里做定点搜索。
 */
export function writeSkill(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Q12 canary marker ${name}. Never route to this; it exists only to prove the measurement is sensitive.\n---\n\n# ${name}\n\nQ12 canary body ${name}.\n`,
  );
  return name;
}

/**
 * S1 的深度 1 正对照：`<target>/<name>/SKILL.md`。
 * 🔴 读数在这一步不动 ⇒ 测量不敏感 ⇒ 该格作废（见 protocol.mjs）。
 */
export function writeDepth1Probe(target) {
  const name = newCanary('probe1');
  writeSkill(join(target, name), name);
  return name;
}

/**
 * S2 的**同深度**正对照：`<target>/probe3/tx-1/stage/<n>/SKILL.md`。
 * 与 `.geoly/tx-1/stage/<n>/SKILL.md` 层数完全相同，但目录名**不带点** ——
 * 于是它单独回答一个问题：「扫描够不够深，能不能到达 .geoly 里 staged skill 那一层」。
 * 读数动了 ⇒ 会递归（那么挡住 .geoly 的只能是点目录过滤）；
 * 读数不动 ⇒ 不递归（那么挡住 .geoly 的是深度，与点目录无关）。R-7 就是这么分出来的。
 */
export function writeSameDepthProbe(target) {
  const name = newCanary('probe3');
  writeSkill(join(target, 'probe3', 'tx-1', 'stage', name), name);
  return name;
}

/**
 * 完整的 `.geoly/` 状态目录。
 *
 * 🔴 顶层**永远不得**出现 SKILL.md。实测 claude 会把它当成一个名叫 `.geoly`
 *    的 skill 加载（15 → 16）—— 见 docs/m1/01-residual-risks.md R-7。
 *    这不是「碰巧安全」，是一条必须守住的布局不变量，所以函数末尾直接断言。
 *
 * @returns {{canaries: string[]}} 埋在 stage 与 attic 里的 canary 名
 */
export function writeGeolyFixture(target) {
  const g = join(target, '.geoly');
  mkdirSync(g, { recursive: true });

  // ① 真的用 node:sqlite 建锁库，连 -wal / -shm 一起落盘 ——
  //    这三个文件是 D11′ 的锁协议在磁盘上的真实形态，用空文件糊弄等于没测。
  const dbPath = join(g, 'lock.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS lock_holder (k TEXT PRIMARY KEY, v TEXT)');
  db.exec("INSERT OR REPLACE INTO lock_holder VALUES ('generation', '1')");
  db.close();
  // WAL/SHM 在 close 后可能被 checkpoint 掉；Q12 要的是「这些文件在目录里」这个形态，
  // 缺了就自己补出来，否则测的就不是真实布局。
  for (const suffix of ['-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    try { writeFileSync(p, '', { flag: 'wx' }); } catch { /* 已存在，正是我们要的 */ }
  }

  writeFileSync(join(g, 'generation'), '1\n');
  writeFileSync(join(g, 'ledger.json'), JSON.stringify({ schema: 'geoly.skills.ledger/1', entries: [] }) + '\n');
  writeFileSync(join(g, 'audit-seq'), '0\n');

  mkdirSync(join(g, 'journal'), { recursive: true });
  writeFileSync(join(g, 'journal', '1.json'), JSON.stringify({ generation: 1, intents: [] }) + '\n');

  // ② stage 里放一个**有效且唯一**的 canary —— 这是整个 Q12 的核心探针。
  const staged = newCanary('stage');
  writeSkill(join(g, 'tx-1', 'stage', staged), staged);
  mkdirSync(join(g, 'tx-1', 'retired'), { recursive: true });

  // ③ attic 里的旧副本按 D3 是**单个 tar，不展开**。
  //    但 Q12 要能测出「万一有人把它展开了会怎样」，所以两种形态都放：
  //    一个真的 tar（D3 的形态）+ 一个展开的 canary 目录（对手/bug 的形态）。
  const atticName = newCanary('attic');
  mkdirSync(join(g, 'attic', '1'), { recursive: true });
  writeFileSync(join(g, 'attic', '1', `${atticName}.tar`), makeMinimalTar(`${atticName}/SKILL.md`,
    `---\nname: ${atticName}\ndescription: Q12 canary marker ${atticName} inside an attic tar.\n---\n`));
  const atticExploded = newCanary('attic-exploded');
  writeSkill(join(g, 'attic', '1', atticExploded), atticExploded);

  mkdirSync(join(g, 'quarantine', '1'), { recursive: true });
  mkdirSync(join(g, 'audit-archive'), { recursive: true });

  // 🔴 布局不变量：.geoly 顶层不得有 SKILL.md。
  const top = readdirSync(g);
  if (top.includes('SKILL.md')) {
    throw new Error(
      '🔴 夹具在 .geoly 顶层放了 SKILL.md —— claude 会把它当成名为 .geoly 的 skill 加载（R-7）。' +
        '这一格的通过完全建立在这个文件不存在之上，夹具不得违反它',
    );
  }

  return { canaries: [staged, atticName, atticExploded] };
}

/**
 * 最小 USTAR 归档 —— 一个成员，两个零块收尾（ERRATA E-5 的规范形式）。
 * 🔴 **自己写字节，不 shell out 到系统 tar**（ERRATA E-6：macOS 的 tar 会注入
 *    AppleDouble 成员，而 `tar -tvf` 根本不会把它列出来）。夹具也要遵守这条 ——
 *    夹具里混进 `._*` 成员就等于在测一个我们自己会拒绝的形态。
 */
function makeMinimalTar(path, content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  const put = (s, off, len) => header.write(String(s).slice(0, len - 1), off, 'ascii');
  put(path, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  put('00000000000\0', 136, 12);
  header.write('        ', 148, 8, 'ascii'); // checksum 占位：先填空格再算
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, pad, Buffer.alloc(1024, 0)]);
}
