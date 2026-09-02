// 压力测试用：疯狂 record，把每条成功落盘的 eid 打到 stdout。
// 父进程同时反复 flush，于是 rename / unlink / 换代 会真的与 append 交错。
//
// 🔴 **两件事都要确定：事件总量，和「录制期间父进程发了几批」。**
//    这里踩过两次，方向相反：
//    ① 最早是「录满 N 条就退出」——事件数固定，但交错次数取决于机器快慢，
//       慢机器上父进程只赶上两批，防退化的断言（>=3）无辜变红。
//    ② 改成「跑到父进程攒够批次才停」之后交错次数确定了，可**事件数变成了
//       随机值**：慢机器上能录出几万条。而丢失容忍度（≤1，见测试里的长注释）
//       是按 ~4000 条标定的绝对数 —— 事件一多、窗口就多，丢 2 条并不说明
//       代码更坏了，测试却红了。2026-09-02 实测 Node 24 上就是这么红的。
//
//    现在两头都框住：**总量硬上限 maxN**（回到原来的量级），
//    外加**节流**（每 throttleEvery 条歇 throttleMs），让父进程有足够的
//    真实时间窗口去 drain —— 而不是靠赌它跑得比子进程快。
import { existsSync } from 'node:fs';
import { record } from '../../src/telemetry.mjs';

const [minN, maxN, stopFile, throttleEvery, throttleMs] = [
  Number(process.argv[2]), Number(process.argv[3]), process.argv[4],
  Number(process.argv[5]), Number(process.argv[6]),
];

/** 同步歇一会儿 —— 这个子进程通篇是同步的，不能 await。 */
const spin = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };

for (let i = 0; i < maxN; i++) {
  const ev = record({ kind: 'install', result: 'ok', artifact: `skill:g/a${i}@1.0.0` });
  // 落盘失败（返回 null）不算数 —— 我们要验的是「说写成功了就一定读得到」
  if (ev) process.stdout.write(ev.eid + '\n');
  if (throttleEvery > 0 && i % throttleEvery === 0) spin(throttleMs);
  // ⚠️ 每 50 条查一次而不是每条：existsSync 是同步系统调用，每条都查会让
  //    子进程慢到反过来影响它想复现的那个交错。
  if (i >= minN && i % 50 === 0 && existsSync(stopFile)) break;
}
