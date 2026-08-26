// geoly-tree-v1 / geoly-tx-v1 —— 规范见 01-artifacts.md §6、04-install.md §5.10
// 两者复用同一套 path 规范化与 leaf 编码，只是域分离前缀与覆盖面不同。
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ALLOWED_FILE_MODES = new Set([0o644, 0o755]);
const DIR_MODE = 0o755;

function leaf(content) {
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(content.length));
  return createHash('sha256').update('blob\0').update(len).update(content).digest('hex');
}

function normPath(rel) {
  const p = rel.split(sep).join('/');
  return p.normalize('NFC');
}

/** 无跟随遍历；遇到不被允许的类型直接抛错（fail-closed） */
function walk(root, { includeDirs }) {
  const files = [], dirs = [];
  (function rec(dir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new Error(`tree-digest: 拒绝 symlink ${abs}`);
      if (st.isDirectory()) {
        if ((st.mode & 0o777) !== DIR_MODE && includeDirs) {
          throw new Error(`tree-digest: 目录 mode 必须是 0755，${abs} 是 ${(st.mode & 0o777).toString(8)}`);
        }
        dirs.push(abs); rec(abs); continue;
      }
      if (!st.isFile()) throw new Error(`tree-digest: 拒绝非普通文件 ${abs}`);
      // 🔴 nlink 检查只针对普通文件；对目录做会让每个正常 tx 都无法成像
      if (st.nlink !== 1) throw new Error(`tree-digest: 拒绝 hardlink（nlink=${st.nlink}）${abs}`);
      const mode = st.mode & 0o777;
      if (!ALLOWED_FILE_MODES.has(mode)) {
        throw new Error(`tree-digest: 文件 mode 只允许 0644/0755，${abs} 是 ${mode.toString(8)}`);
      }
      files.push(abs);
    }
  })(root);
  return { files, dirs };
}

/** geoly-tree-v1：只覆盖文件叶子（制品禁止空目录，目录结构由文件路径隐含） */
export function treeDigest(root) {
  const { files } = walk(root, { includeDirs: false });
  const entries = files.map(abs => {
    const st = lstatSync(abs);
    const mode = (st.mode & 0o777) === 0o755 ? '0755' : '0644';
    return { path: normPath(relative(root, abs)), mode, leaf: leaf(readFileSync(abs)) };
  });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const seen = new Set();
  const h = createHash('sha256').update('geoly-tree-v1\n');
  for (const e of entries) {
    const fold = e.path.toLowerCase();
    if (seen.has(fold)) throw new Error(`tree-digest: 大小写折叠后重名 ${e.path}`);
    seen.add(fold);
    h.update(Buffer.from(e.path, 'utf8')).update(Buffer.from([0]))
     .update(e.mode).update(Buffer.from([0])).update(e.leaf).update('\n');
  }
  return 'geoly-tree-v1:sha256:' + h.digest('hex');
}

/**
 * geoly-tx-v1：目录项也进摘要（含空目录、含 tx 根本身）。
 * 🔴 不能复用 geoly-tree-v1 —— 它只覆盖文件叶子，tx 的 stage/ retired/ 可以是空的，
 *    空目录被删掉摘要不变，「落入同一等价类」就不成立。
 */
export function txDigest(root) {
  const { files, dirs } = walk(root, { includeDirs: true });
  const items = [];
  items.push({ kind: 'd', path: '', mode: '0755' });            // 🔴 根目录本身也计入
  for (const d of dirs) items.push({ kind: 'd', path: normPath(relative(root, d)), mode: '0755' });
  for (const f of files) {
    const st = lstatSync(f);
    items.push({
      kind: 'f', path: normPath(relative(root, f)),
      mode: (st.mode & 0o777) === 0o755 ? '0755' : '0644',
      leaf: leaf(readFileSync(f)),
    });
  }
  items.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
    return c !== 0 ? c : (a.kind === b.kind ? 0 : a.kind === 'd' ? -1 : 1);   // "d" < "f"
  });
  const seen = new Set();
  const h = createHash('sha256').update('geoly-tx-v1\n');
  for (const e of items) {
    const key = e.kind + '\0' + e.path;
    if (seen.has(key)) throw new Error(`tx-digest: 重复条目 ${key}`);
    seen.add(key);
    h.update(e.kind).update(Buffer.from([0]))
     .update(Buffer.from(e.path, 'utf8')).update(Buffer.from([0])).update(e.mode);
    if (e.kind === 'f') h.update(Buffer.from([0])).update(e.leaf);
    h.update('\n');
  }
  return 'geoly-tx-v1:sha256:' + h.digest('hex');
}
