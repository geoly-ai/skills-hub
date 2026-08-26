// 压力测试用：疯狂 record，把每条成功落盘的 eid 打到 stdout。
// 父进程同时反复 flush，于是 rename / unlink / 换代 会真的与 append 交错。
import { record } from '../../src/telemetry.mjs';

const n = Number(process.argv[2]);
for (let i = 0; i < n; i++) {
  const ev = record({ kind: 'install', result: 'ok', artifact: `skill:g/a${i}@1.0.0` });
  // 落盘失败（返回 null）不算数 —— 我们要验的是「说写成功了就一定读得到」
  if (ev) process.stdout.write(ev.eid + '\n');
}
