// 取「当前最新快照」并严格解析。
//
// 🔴 **挑最新的逻辑不在这里重写** —— 直接用 `scripts/release/build-timestamp.mjs`
//    导出的 `newestSnapshot()`。它已经踩平了两个坑（字典序把 `hub-10` 排在 `hub-2`
//    前面、`hub-<N>.json.sigstore.json` 也以 `.json` 结尾）。写第二份「挑最新」的
//    实现，迟早会和 timestamp 生成器取到不同的两张快照 —— 而 timestamp 是签名对象，
//    到那时页面说的和签名说的就不是同一件事了。
//
// 🔴 **解析只走 `parseSnapshot()`**，不 `JSON.parse` 之后自己信。快照是签名对象，
//    「能被 JSON 解析」离「是一张合法快照」差着排序、latest 投影自洽、id 一致性、
//    canonical 字节往返这一整套。

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { newestSnapshot } from '../../scripts/release/build-timestamp.mjs';
import { parseSnapshot } from '../../src/snapshot.mjs';

/**
 * 判断一个异常是不是「这里根本没有快照」——**空 registry 是正常状态，要出页不要报错**。
 *
 * 🔴 **不能按异常类型一把抓**。`newestSnapshot()` 用同一个 `TimestampError` 报
 *    「快照号超出安全整数范围」和「快照号出现在两个文件里」—— 那两种是**真故障**
 *    （磁盘上有东西但读不对），当成空状态吞掉的话，页面会平静地宣布
 *    「registry 还没有任何制品」，而实际上有一张快照因为文件名撞了没被看见。
 *    该类没有结构化的 reason 字段，所以只能精确匹配它那一条消息的前缀。
 *
 * ⚠️ 目录存在但里面只有**不合命名规则**的文件（`hub-01.json`、`hub-1e3.json`）时，
 *    `newestSnapshot()` 同样报「没有快照」。这确实是「没有可识别的快照文件」，
 *    与「目录是空的」不完全是一回事 —— 空状态文案因此写成「没有可识别的快照文件」，
 *    而不是「目录是空的」。
 */
function emptyReasonOf(err, dir) {
  if (err?.name === 'TimestampError' && typeof err.message === 'string'
      && err.message.startsWith(`${dir} 下没有快照`)) {
    return `${dir} 下没有可识别的快照文件（hub-<N>.json）`;
  }
  // readdirSync 对不存在的目录抛 ENOENT。只认「就是这个目录不存在」这一种：
  // 别的 ENOENT（比如某个被 import 的文件没了）不该被解释成 registry 是空的。
  if (err?.code === 'ENOENT' && err.syscall === 'scandir' && err.path === dir) {
    return `${dir} 不存在 —— 还没有过任何一次 promotion`;
  }
  return null;
}

/**
 * @param {string} dir registry/snapshots
 * @returns {{empty:true, reason:string} | {empty:false, file:string, fileName:string,
 *           fileNumber:number, bytes:number, sha256:string, snapshot:object}}
 */
export function loadNewestSnapshot(dir) {
  let picked;
  try {
    picked = newestSnapshot(dir);
  } catch (err) {
    const reason = emptyReasonOf(err, dir);
    if (reason === null) throw err;      // 真故障：原样抛，别伪装成空 registry
    return { empty: true, reason };
  }

  const bytes = readFileSync(picked.file);
  // 🔴 **不传 `expectSnapshot`**：那个参数的语义是「timestamp 说最新是第 N 张」，
  //    而本站点手上根本没有 timestamp（它只作为 Release 资产分发，仓库里不存，
  //    见 02-registry.md §3.2）。传文件名里的 N 进去等于拿文件名跟文件内容自己比自己，
  //    比出来的「一致」什么也不担保。文件名与内部编号的比对在下面单独做一次，
  //    并把两个数都摆到页面上，让人自己看。
  const snapshot = parseSnapshot(bytes);
  return {
    empty: false,
    file: picked.file,
    fileName: basename(picked.file),
    fileNumber: picked.n,
    bytes: bytes.length,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    snapshot,
  };
}
