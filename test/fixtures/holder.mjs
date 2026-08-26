import { acquire } from '../../src/lock.mjs';
acquire(process.argv[2]);
process.stdout.write('HELD\n');
setInterval(() => {}, 1000);
