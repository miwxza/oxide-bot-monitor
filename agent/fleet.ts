/**
 * รัน agent หลายเครื่องพร้อมกัน (แต่ละเครื่องเป็น process แยก ปิดทีละเครื่องเพื่อทดสอบ heartbeat timeout ได้)
 *
 *   node dist/agent/fleet.js            # bot-01, bot-02, bot-03
 *   node dist/agent/fleet.js bot-01 bot-02
 */
import { ChildProcess, fork } from 'node:child_process';
import { join } from 'node:path';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['bot-01', 'bot-02', 'bot-03'];
const children: ChildProcess[] = ids.map((id) => fork(join(__dirname, 'bot-agent.js'), [id], { stdio: 'inherit' }));

const stop = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
