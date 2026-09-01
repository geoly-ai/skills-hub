// 验「认领自动上报名额要在上报锁下」：父进程持着那把锁时，这个子进程一个名额都不许拿到。
// 跨进程互斥只能用真进程验 —— 模块内的 held 表拦不住别的进程。
//
// 🔴 判据是**父进程持锁**这个受控前提，不是「两个子进程同时抢、看谁赢」：
//    后者靠时序碰运气（Codex 2026-09-01 指出），A 完整跑完再轮到 B 时，
//    就算完全没有互斥它也会「只有一个 claimed」而绿掉。
import { claimAutoUploadSlot } from '../../src/telemetry.mjs';

process.stdout.write(claimAutoUploadSlot() ? 'claimed' : 'skipped');
