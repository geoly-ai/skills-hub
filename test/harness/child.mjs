// 崩溃子进程的入口。父进程（crash-runner）spawn 它，用 env 传场景与注入配置。
//
// 为什么必须是**子进程**：throw 只能证明调用栈中断；`kill` 模式要的是
// 「进程内任何收尾代码都不可能跑」，那只有真的被 SIGKILL 才算数。
//
//   FX_TARGET     target 目录
//   FX_SCENARIO   场景名
//   FX_PHASE      'run'（跑被测流程）| 'recover'（跑恢复）| 'both'
//   GEOLY_FAULT*  见 src/fault-inject.mjs
//
// 退出码：0 正常 / 97 注入的 exit / 90 注入的 throw / 91 Corrupt / 92 其它异常
//        被 SIGKILL 时没有退出码（signal = 'SIGKILL'）

import { arm, armFromEnv, disarm, setTrace } from '../../src/fault-inject.mjs';
import { SCENARIOS } from './scenarios.mjs';

const target = process.env.FX_TARGET;
const scenario = SCENARIOS[process.env.FX_SCENARIO];
const phase = process.env.FX_PHASE ?? 'run';
if (!target || !scenario) {
  console.error('child: 缺 FX_TARGET / FX_SCENARIO');
  process.exit(93);
}

// 🔴 setup 是被测流程的**输入**，不是被测对象 —— 必须在注入解除的状态下跑。
disarm();
setTrace(null);
try {
  if (phase !== 'recover') scenario.setup(target);
} catch (e) {
  console.error(`child: setup 失败 ${e.stack}`);
  process.exit(94);
}

// setup 之后才武装
armFromEnv();
if (process.env.FX_ARM_NAME) {
  arm({
    name: process.env.FX_ARM_NAME,
    nth: Number(process.env.FX_ARM_NTH ?? 1),
    mode: process.env.FX_ARM_MODE ?? 'throw',
  });
}

try {
  if (phase === 'run' || phase === 'both') scenario.run(target);
  if (phase === 'recover' || phase === 'both') scenario.recover(target);
} catch (e) {
  if (e?.name === 'FaultInjected') { process.exit(90); }
  if (e?.corrupt) { console.error(`CORRUPT ${e.message}`); process.exit(91); }
  console.error(`child: ${e?.stack ?? e}`);
  process.exit(92);
}
process.exit(0);
