/**
 * Live demo ใน container เดียว (Render แผนฟรีมีได้ container เดียว)
 *   Bot Simulator (:8788) + API (:$PORT) + บอท 3 เครื่อง — แต่ละตัวเป็น process แยกเหมือน Docker Compose
 *
 *   node dist/agent/demo.js
 */
import { ChildProcess, fork } from 'node:child_process';
import { join } from 'node:path';

const port = process.env.PORT ?? '3000';
const root = join(__dirname, '..', '..');
const children: ChildProcess[] = [];

function start(script: string, args: string[], env: Record<string, string>): void {
  const child = fork(join(root, script), args, { env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.error(`${script} exited (${code}) — stopping demo`);
    stop(1);
  });
  children.push(child);
}

function stop(code = 0): void {
  for (const c of children) c.removeAllListeners('exit').kill();
  process.exit(code);
}

start('simulator/server.js', [], { PORT: '8788' });
start('dist/src/main.js', [], { PORT: port, BOT_SIMULATOR_URL: 'http://127.0.0.1:8788' });
// agent ต่อใหม่เองทุก 3 วินาทีจนกว่า API จะพร้อม
start('dist/agent/fleet.js', ['bot-01', 'bot-02', 'bot-03'], { SERVER_URL: `http://127.0.0.1:${port}` });

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
