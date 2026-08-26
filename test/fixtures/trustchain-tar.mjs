// 测试夹具：canonical tar.gz 生成器 + 可控的「恶意变体」注入点。
// 🔴 只给测试用。生产链路不打包，只解包。
//
// 为什么要自己拼字节而不是调 `zlib.gzipSync`：Node 的 gzip 头会写
// `OS = 0x03`（Unix），而 canonical 要求 `OS = 255`。要生成规范里定义的
// 那一份字节，只能自己拼头和尾。
import { deflateRawSync } from 'node:zlib';
import { crc32, canonicalUstarSplit } from '../../src/untar.mjs';

const BLOCK = 512;

export function octalField(v, len) {
  return Buffer.from(v.toString(8).padStart(len - 1, '0') + '\0', 'latin1');
}

/**
 * 造一个 512 字节 ustar 头。`over` 允许测试直接覆盖任意字段字节，
 * 用来构造各类恶意变体（checksum 默认在覆盖之后重算，除非 `over.chksum` 给了值）。
 */
export function tarHeader({ path, mode = 0o644, size = 0, typeflag = '0', over = {} }) {
  const b = Buffer.alloc(BLOCK);
  const split = canonicalUstarSplit(path) ?? { prefix: '', name: path };
  b.write(over.name ?? split.name, 0, 100, 'latin1');
  octalField(over.mode ?? mode, 8).copy(b, 100);
  octalField(over.uid ?? 0, 8).copy(b, 108);
  octalField(over.gid ?? 0, 8).copy(b, 116);
  octalField(over.size ?? size, 12).copy(b, 124);
  octalField(over.mtime ?? 0, 12).copy(b, 136);
  b.write(over.typeflag ?? typeflag, 156, 1, 'latin1');
  if (over.linkname) b.write(over.linkname, 157, 100, 'latin1');
  b.write(over.magic ?? 'ustar\0', 257, 6, 'latin1');
  b.write(over.version ?? '00', 263, 2, 'latin1');
  if (over.uname) b.write(over.uname, 265, 32, 'latin1');
  if (over.gname) b.write(over.gname, 297, 32, 'latin1');
  octalField(over.devmajor ?? 0, 8).copy(b, 329);
  octalField(over.devminor ?? 0, 8).copy(b, 337);
  b.write(over.prefix ?? split.prefix, 345, 155, 'latin1');
  if (over.headerPad) b.write(over.headerPad, 500, 12, 'latin1');
  if (over.raw) over.raw(b); // 最后的逃生口：直接改字节

  if (over.chksum !== undefined) {
    b.write(over.chksum, 148, 8, 'latin1');
  } else {
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += b[i];
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  }
  return b;
}

const pad512 = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/**
 * @param {Array<{path:string,mode?:number,data:Buffer|string,typeflag?:string,over?:object}>} files
 * @param {{sort?:boolean, eofBlocks?:number, trailing?:Buffer, dataPad?:Buffer}} opts
 */
export function makeTar(files, opts = {}) {
  const { sort = true, eofBlocks = 2, trailing = null } = opts;
  const list = sort
    ? [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))
    : files;
  const parts = [];
  for (const f of list) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '', 'utf8');
    parts.push(tarHeader({ path: f.path, mode: f.mode ?? 0o644, size: data.length, typeflag: f.typeflag ?? '0', over: f.over ?? {} }));
    parts.push(data);
    parts.push(f.padOverride ?? pad512(data.length));
  }
  for (let i = 0; i < eofBlocks; i++) parts.push(Buffer.alloc(BLOCK));
  if (trailing) parts.push(trailing);
  return Buffer.concat(parts);
}

/** canonical gzip 封装：FLG=0、MTIME=0、XFL=2（level 9）、OS=255 */
export function makeGz(raw, over = {}) {
  const head = Buffer.alloc(10);
  head[0] = 0x1f; head[1] = 0x8b;
  head[2] = over.cm ?? 8;
  head[3] = over.flg ?? 0;
  head.writeUInt32LE(over.mtime ?? 0, 4);
  head[8] = over.xfl ?? 2;
  head[9] = over.os ?? 255;
  const body = over.body ?? deflateRawSync(raw, { level: 9 });
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(over.crc ?? crc32(raw), 0);
  tail.writeUInt32LE(over.isize ?? (raw.length >>> 0), 4);
  return Buffer.concat([head, body, tail, over.extra ?? Buffer.alloc(0)]);
}

export function makeTarGz(files, tarOpts = {}, gzOpts = {}) {
  return makeGz(makeTar(files, tarOpts), gzOpts);
}
