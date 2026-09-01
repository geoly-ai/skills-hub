// 压力测试用：疯狂 record，把每条成功落盘的 eid 打到 stdout。
// 父进程同时反复 flush，于是 rename / unlink / 换代 会真的与 append 交错。
//
// 🔴 **什么时候停由父进程说了算，不靠「录满 N 条」赛跑。**
//    早先这里是「录 N 条就退出」，于是「录制期间父进程发出了几批」变成了一场
//    子进程 vs 父进程的赛跑：父进程每轮 drain 要做同步 I/O 再让一个宏任务，
//    机器一慢就只赶上两批，那条防退化的断言（>=3）就红 —— 而代码没有任何问题。
//    2026-09-01 在 CI 的 Node 22 runner 上实测红、同一个 commit 的 24 绿。
//    现在改成：录到 `minN` 之后开始看停止文件，父进程攒够交错批次再让它停。
//    `maxN` 只是防父进程挂了之后这里无限跑的兜底，不是正常退出路径。
import { existsSync } from 'node:fs';
import { record } from '../../src/telemetry.mjs';

const [minN, maxN, stopFile] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];

for (let i = 0; i < maxN; i++) {
  const ev = record({ kind: 'install', result: 'ok', artifact: `skill:g/a${i}@1.0.0` });
  // 落盘失败（返回 null）不算数 —— 我们要验的是「说写成功了就一定读得到」
  if (ev) process.stdout.write(ev.eid + '\n');
  // ⚠️ 每 50 条查一次而不是每条：existsSync 是同步系统调用，每条都查会让
  //    子进程慢到反过来影响它想复现的那个交错。
  if (i >= minN && i % 50 === 0 && existsSync(stopFile)) break;
}
