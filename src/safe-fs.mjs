// 路径与文件系统安全 —— 规范见 01-artifacts.md §4.1/§5、04-install.md §2.2/§3.4/§3.5/§3.6
//
// 这个模块回答四个问题，每个都是「不做就会出安全或正确性事故」的：
//   1. 这个名字合法吗（D9：ASCII-only）
//   2. 这条路径链上有 symlink 吗（有就拒绝，不跟随）
//   3. 这个文件系统撑得住我们依赖的语义吗（rename 原子性 / advisory lock / fsync 持久性）
//   4. 这个目录是挂载点吗，它下面有挂载点吗
import { lstatSync, realpathSync, accessSync, constants, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, parse, sep } from 'node:path';
import { platform } from 'node:os';

// ── 1. 路径字符集（D9） ──────────────────────────────────────────────────────

/**
 * 🔴 segment 的合法字节只有 `[A-Za-z0-9._-]`（01-artifacts.md §4.1）。
 *
 * 这不是洁癖。允许 Unicode 会同时引入三个问题：macOS 的 APFS 枚举出的归一形式
 * 可能与写入时不同（装完重算树摘要就对不上）、USTAR 的 name/prefix 没有字符集
 * 声明、同形字混淆只能靠人眼审查。一刀切最省事。
 */
const RE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isSafeSegment(seg) {
  return typeof seg === 'string' && seg.length > 0 && RE_SEGMENT.test(seg);
}

/**
 * 校验一条**制品内的相对路径**。返回规范化后的 segment 数组。
 *
 * 拒绝：绝对路径、`.`、`..`、空 segment、反斜杠、非 ASCII、超深。
 * ⚠️ `..` 必须在**分段之后**判断，不能只做字符串 includes：`a..b` 是合法文件名。
 */
export function parseSafeRelPath(p, { maxDepth = 12 } = {}) {
  if (typeof p !== 'string' || p.length === 0) throw new Error('路径为空');
  if (isAbsolute(p) || p.startsWith('/')) throw new Error(`路径必须是相对路径：${p}`);
  if (p.includes('\\')) throw new Error(`路径含反斜杠：${p}`);
  if (p.includes('\0')) throw new Error('路径含 NUL');
  const segs = p.split('/');
  if (segs.length > maxDepth) throw new Error(`路径深度 ${segs.length} 超过上限 ${maxDepth}：${p}`);
  for (const s of segs) {
    if (s === '' ) throw new Error(`路径含空 segment：${p}`);
    if (s === '.' || s === '..') throw new Error(`路径含 ${s}：${p}`);
    if (!isSafeSegment(s)) throw new Error(`路径 segment 不是 ASCII-only [A-Za-z0-9._-]：${s}`);
  }
  return segs;
}

// ── 2. symlink ───────────────────────────────────────────────────────────────

/**
 * 🔴 从一个**可信基准**往下逐层 `lstat`，任一层是 symlink 就拒绝（04-install.md §3.4）。
 *
 * 为什么不能只 `lstat` 末端：`base/a/b` 里 `a` 是 symlink 时，对 `b` 的 lstat
 * 已经跟随过 `a` 了 —— 末端不是 symlink，但路径整体已经被重定向。
 *
 * 🔴 **为什么要有 base，而不是从 `/` 开始查**：macOS 上 `/var` 本身就是指向
 * `/private/var` 的系统 symlink，`$TMPDIR` 也在它下面；从根开始查会把每一个
 * 正常路径都判死。规格要防的是**我们管辖范围之内**被重定向（有人把
 * `<target>/.geoly` 换成软链），不是操作系统自己的布局。
 * 所以 base 先 `realpath`（接受它之上的 OS 级 symlink），只查 base 之下的层。
 *
 * 不存在的层直接停止 —— 还没创建的目录不构成风险。
 */
export function assertNoSymlinkInChain(base, relPath = '') {
  if (!isAbsolute(base)) throw new Error(`base 需要绝对路径：${base}`);
  let cur = realpathSync(base);
  for (const seg of String(relPath).split(/[\\/]/).filter(Boolean)) {
    cur = join(cur, seg);
    let st;
    try { st = lstatSync(cur); } catch { return; } // 还不存在，后面也不会存在
    if (st.isSymbolicLink()) throw new Error(`路径链上有符号链接，拒绝：${cur}`);
  }
}

/** 制品/target 里允许的文件类型（01-artifacts.md §5）。一律拒绝其余所有类型。 */
export function assertPlainFileOrDir(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`拒绝符号链接：${path}`);
  if (st.isFIFO()) throw new Error(`拒绝 FIFO：${path}`);
  if (st.isSocket()) throw new Error(`拒绝 socket：${path}`);
  if (st.isBlockDevice() || st.isCharacterDevice()) throw new Error(`拒绝设备文件：${path}`);
  if (st.isDirectory()) return st;
  if (!st.isFile()) throw new Error(`拒绝未知文件类型：${path}`);
  // 🔴 只对**普通文件**判 hardlink。对目录判会把每一棵正常的树都判死：
  // 目录的 nlink 天然是 2 + 子目录数。
  if (st.nlink !== 1) throw new Error(`拒绝硬链接（nlink=${st.nlink}）：${path}`);
  return st;
}

// ── 3. 文件系统类型 ──────────────────────────────────────────────────────────

/**
 * 🔴 拒绝清单（04-install.md §2.2）。这些文件系统不提供本规范依赖的
 * advisory lock 语义、`rename` 原子性或 `fsync` 崩溃持久性；
 * SQLite 的锁在网络文件系统上同样不可靠（D11′）。
 */
export const REJECTED_FSTYPES = new Set([
  'nfs', 'nfs3', 'nfs4', 'autofs',
  'smbfs', 'cifs', 'smb2', 'afpfs',
  'fuse', 'osxfuse', 'macfuse', 'fusefs', 'sshfs', 'fuse.sshfs', 'fuse.s3fs',
  'overlay', 'overlayfs',
  'webdav', 'ftp', '9p',
]);

let _mountCache = null;
/** 读取挂载表。Linux 用 /proc/self/mountinfo，macOS 用 `mount` 输出。 */
export function mountTable({ refresh = false } = {}) {
  if (_mountCache && !refresh) return _mountCache;
  const rows = platform() === 'linux' ? readMountinfo() : readBsdMount();
  // 长路径在前：查某个路径属于哪个挂载点时，取最长前缀匹配
  rows.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  _mountCache = rows;
  return rows;
}

function readMountinfo() {
  let text;
  try { text = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    // …… 挂载点在第 5 字段；`-` 之后是 fstype
    const sepIdx = line.indexOf(' - ');
    if (sepIdx === -1) continue;
    const left = line.slice(0, sepIdx).split(' ');
    const right = line.slice(sepIdx + 3).split(' ');
    if (left.length < 5 || right.length < 1) continue;
    out.push({ mountPoint: unescapeMountinfo(left[4]), fstype: right[0] });
  }
  return out;
}
// mountinfo 用八进制转义空格等字符
const unescapeMountinfo = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

function readBsdMount() {
  let text;
  try {
    text = execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5000 });
  } catch { return []; }
  const out = [];
  // 形如：/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
  for (const line of text.split('\n')) {
    const m = /^(.*?) on (.*?) \(([^,)]+)/.exec(line);
    if (!m) continue;
    out.push({ mountPoint: m[2], fstype: m[3].trim() });
  }
  return out;
}

/** 某个路径落在哪个挂载点上 */
export function mountEntryFor(path) {
  const abs = resolveExisting(path);
  for (const row of mountTable()) {
    if (abs === row.mountPoint) return row;
    const withSep = row.mountPoint.endsWith(sep) ? row.mountPoint : row.mountPoint + sep;
    if (abs.startsWith(withSep)) return row;
  }
  return null;
}

/** 往上找到第一个已存在的祖先并 realpath（还没创建的 target 也要能预检） */
function resolveExisting(path) {
  let cur = isAbsolute(path) ? path : join(process.cwd(), path);
  for (;;) {
    try { return realpathSync(cur); } catch { /* 继续往上 */ }
    const parent = parse(cur).dir;
    if (!parent || parent === cur) return cur;
    cur = parent;
  }
}

/**
 * 🔴 拒绝时必须**报出检出的 fstype**，不笼统报错（§2.2 明文要求）——
 * 用户得知道是 sshfs 还是 NFS 才知道怎么办。
 */
export function assertSupportedFilesystem(path) {
  const entry = mountEntryFor(path);
  if (!entry) return null; // 读不到挂载表：不因此拒绝安装，但也不谎称验过
  const t = entry.fstype.toLowerCase();
  if (REJECTED_FSTYPES.has(t) || t.startsWith('fuse')) {
    throw new Error(
      `不支持在 ${entry.fstype} 上安装（挂载点 ${entry.mountPoint}）：` +
        '该文件系统不保证 rename 原子性、advisory lock 语义或 fsync 崩溃持久性',
    );
  }
  return entry;
}

// ── 4. 挂载点 ────────────────────────────────────────────────────────────────

/**
 * 🔴 `<target>/.geoly` 自身不得是挂载点，其下也不得含挂载点（§3.4）。
 *
 * 为什么比 `st_dev` 严：bind mount 的 `st_dev` **可以相同**，
 * 只比 dev 会漏掉「在某个别名的 .geoly 上再挂一个目录」——
 * 那样 payload 还是同一棵 target，锁和 journal 却分裂了。
 * 所以判据以挂载表为准。
 */
export function assertNotMountPoint(path) {
  const abs = resolveExisting(path);
  for (const row of mountTable()) {
    if (row.mountPoint === abs) {
      throw new Error(`${path} 本身是挂载点（${row.fstype}），拒绝`);
    }
  }
}

export function assertNoMountPointsUnder(path) {
  const abs = resolveExisting(path);
  const prefix = abs.endsWith(sep) ? abs : abs + sep;
  for (const row of mountTable()) {
    if (row.mountPoint.startsWith(prefix)) {
      throw new Error(`${path} 之下存在挂载点 ${row.mountPoint}（${row.fstype}），拒绝`);
    }
  }
}

// ── 5. 可写性 ────────────────────────────────────────────────────────────────

/**
 * target 不可写（只读挂载、只读仓库）直接拒绝，并报明原因（§3.6）。
 * 报错要说清「需要在这里创建 .geoly/」，否则用户不知道为什么装个 skill 要写目录。
 */
export function assertWritableDir(dir) {
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`${dir} 不可写：安装需要在其中创建 .geoly/ 状态目录`);
  }
  const entry = mountEntryFor(dir);
  if (entry && /(^|,|\s)read-only(,|\s|$)/.test(entry.fstype)) {
    throw new Error(`${dir} 位于只读挂载 ${entry.mountPoint} 上`);
  }
}

/** 两个路径是否同设备（stage 与 target 必须同设备，否则 rename 会 EXDEV） */
export function assertSameDevice(a, b) {
  const da = statSync(a).dev;
  const db = statSync(b).dev;
  if (da !== db) throw new Error(`${a} 与 ${b} 不在同一设备上（${da} vs ${db}），rename 会 EXDEV`);
}

/** 测试用：挂载表有缓存，改过挂载后要清 */
export const _resetMountCache = () => { _mountCache = null; };
