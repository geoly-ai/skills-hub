import { acquire } from './lock.mjs';

const HELP = `skills-hub (M1 开发中)

可用命令：
  stats [--json] [--export <file>]   本地埋点报表
  telemetry status                   看埋点/上报开关与队列
  telemetry flush                    立即上报一次（需已配端点）

全局：
  --offline                          禁止一切网络出口，埋点上报一并停掉

埋点开关（环境变量）：
  GEOLY_TELEMETRY=0                  完全关闭，本地一个字节都不写
  GEOLY_TELEMETRY_UPLOAD=0           只留本地，不上报
  GEOLY_TELEMETRY_ENDPOINT=https://… 不配就是纯本地
`;

export async function main(argv) {
  // M0 的全局 flag：置位后整个 CLI 不得有网络出口。埋点上报继承这条边界。
  if (argv.includes('--offline')) {
    process.env.GEOLY_OFFLINE = '1';
    argv = argv.filter((a) => a !== '--offline');
  }

  if (argv[0] === '--warn-probe') {
    // 内部：验证警告抑制
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    acquire(join(mkdtempSync(join(tmpdir(), 'probe-')), 'l.db'))();
    console.log('PROBE_OK');
    return 0;
  }

  switch (argv[0]) {
    case 'stats': return cmdStats(argv.slice(1));
    case 'telemetry': return cmdTelemetry(argv.slice(1));
    case undefined:
    case '-h':
    case '--help': console.log(HELP); return 0;
    default:
      console.error(`未知命令：${argv[0]}\n`);
      console.error(HELP);
      return 2;
  }
}

async function cmdStats(args) {
  const { stats, textReport } = await import('./stats.mjs');
  const { exportJson } = await import('./telemetry.mjs');
  const { agg, events } = stats();

  const exportIdx = args.indexOf('--export');
  if (exportIdx !== -1) {
    const dest = args[exportIdx + 1];
    if (!dest) {
      console.error('--export 需要一个文件路径');
      return 2;
    }
    const { writeAtomic } = await import('./atomic-fs.mjs');
    // 导出的就是 docs/dashboard/index.html 直接能读的格式
    writeAtomic(dest, exportJson(events));
    console.error(`已导出 ${events.length} 条事件到 ${dest}`);
    return 0;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(agg, null, 2));
    return 0;
  }
  process.stdout.write(textReport(agg));
  return 0;
}

async function cmdTelemetry(args) {
  const tm = await import('./telemetry.mjs');
  const up = await import('./upload.mjs');
  switch (args[0]) {
    case 'status': {
      let ep;
      try { ep = up.endpoint(); } catch (e) { ep = `无效（${e.message}）`; }
      const uploadOff =
        !tm.enabled() ? '关（埋点整体已关）'
        : tm.offline() ? '关（--offline）'
        : '关（GEOLY_TELEMETRY_UPLOAD=0）';
      console.log(`埋点      ${tm.enabled() ? '开' : '关（GEOLY_TELEMETRY=0）'}`);
      console.log(`上报      ${tm.uploadEnabled() ? '开' : uploadOff}`);
      console.log(`端点      ${ep ?? '未配置 —— 纯本地'}`);
      console.log(`待上报    ${tm.readAll().length} 条`);
      console.log(`报表历史  ${tm.readHistory().length} 条（上报不消费它）`);
      console.log(`状态目录  ${tm.stateDir()}`);
      return 0;
    }
    case 'flush': {
      const r = await up.flush();
      console.log(r.skipped ? `未上报：${r.reason}` : `已上报 ${r.sent} 条`);
      return r.skipped && r.reason?.startsWith('error:') ? 1 : 0;
    }
    default:
      console.error('用法：skills-hub telemetry <status|flush>');
      return 2;
  }
}
