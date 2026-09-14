// 本 CLI 自己的版本号 —— **唯一的来源是 package.json**。
//
// 🔴 单独成文件，是为了让 `commands/context.mjs`（策略门 min_cli_version 用）和
//    `telemetry.mjs`（事件里的 `cli` 字段）取的是**同一个值**。
//    2026-09-03 context 那一处修掉了硬编码的 '0.0.0-m1'，埋点那一处却没人改：
//    从 npm 装下来的 CLI 一直上报 `cli: "0.0.0-m1"`，dashboard 的「CLI 版本」整栏是错的
//    （2026-09-14 端到端实测发现）。两处各自取值，迟早又有一处被漏掉。
// 🔴 零依赖（只用 node:fs）：telemetry.mjs 会 import 它，不能把命令层的依赖拖进来。
import { readFileSync } from 'node:fs';

let cachedVersion;

/**
 * 读不出来就**抛**，绝不退回一个编出来的值：
 * 假版本号会让 min_cli_version 这类版本门做出错误判定，也会让埋点把错的数当真。
 */
export function ownVersion() {
  if (cachedVersion === undefined) {
    const p = new URL('../package.json', import.meta.url);
    const v = JSON.parse(readFileSync(p, 'utf8')).version;
    if (typeof v !== 'string' || v === '') {
      throw new Error('读不出本 CLI 的版本号（package.json 的 version 不是非空字符串）');
    }
    cachedVersion = v;
  }
  return cachedVersion;
}
