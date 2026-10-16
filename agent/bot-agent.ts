/**
 * Bot agent (supervisor) — 1 process = 1 เครื่อง (Node/Notebook)
 *
 *   node dist/agent/bot-agent.js bot-01
 *
 * - WebSocket /ws/agent : heartbeat ทุก HEARTBEAT_MS, รับ system / wake / deploy
 * - REST /agent/*        : claim งาน, ต่อ lease, เติมเกมที่ provider, complete / fail
 * - โค้ดที่ทำงานเติมเกมโหลดจากแพ็กเกจที่ติดตั้งไว้ (releases/<version>/, ดู bot-module.ts)
 *   ถ้ายังไม่มีแพ็กเกจ ใช้โค้ดในตัว (builtin-bot.ts)
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { BotContext, BotModule, Job, loadBot } from './bot-module';
import { builtinBot } from './builtin-bot';
import { installPackage, readCurrent } from './installer';

const botId = process.argv[2] ?? process.env.BOT_ID;
if (!botId) {
  console.error('usage: bot-agent <bot-id>');
  process.exit(1);
}
const SERVER = (process.env.SERVER_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN ?? 'dev-agent-token';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 3000);
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const WORK_MS = Number(process.env.WORK_MS ?? 2500);
const DATA_DIR = join(process.env.AGENT_DATA_DIR ?? '.agent-data', botId);
const HOST = process.env.AGENT_HOST ?? `${hostname()}-${botId}`;

let ws: WebSocket | undefined;
let accepting = true;
let busy = false;
let codeVersion: string | undefined;
let bot: BotModule = builtinBot;
let installing = false;
let heartbeatTimer: NodeJS.Timeout | undefined;

const log = (msg: string, extra: object = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), bot: botId, msg, ...extra }));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const releaseDir = (version: string) => join(DATA_DIR, 'releases', version);

/** ตอนเริ่ม agent: โหลดโค้ดบอทจากแพ็กเกจที่ติดตั้งไว้ล่าสุด (จำข้ามการ restart) */
function loadInstalledBot(): void {
  const current = readCurrent(DATA_DIR);
  if (!current) return log('no package installed — using builtin bot code');
  try {
    bot = loadBot(releaseDir(current.version));
    codeVersion = current.version;
    log('bot code loaded', { bot_code: `${bot.name}@${bot.version}`, version: codeVersion });
  } catch (err) {
    log('installed package cannot be loaded — using builtin bot code', { version: current.version, err: (err as Error).message });
  }
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(SERVER + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-agent-token': TOKEN, 'x-bot-id': botId! },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// ---------------- WebSocket ----------------
function connect(): void {
  const url = `${SERVER.replace(/^http/, 'ws')}/ws/agent?bot_id=${encodeURIComponent(botId!)}&token=${encodeURIComponent(TOKEN)}&host=${encodeURIComponent(HOST)}`;
  ws = new WebSocket(url);
  ws.on('open', () => {
    log('connected');
    sendHeartbeat();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  });
  ws.on('message', (raw) => void onMessage(JSON.parse(raw.toString())));
  ws.on('close', (code) => {
    clearInterval(heartbeatTimer);
    log('disconnected, retrying in 3s', { code });
    setTimeout(connect, 3000);
  });
  ws.on('error', (err) => log('ws error', { err: err.message }));
}

function sendHeartbeat(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    // ส่งเวอร์ชันจริงเสมอ (รวมถึง builtin) ให้ server รู้ทันทีถ้าเครื่องเสียไฟล์ที่ติดตั้งไว้
    ws.send(JSON.stringify({ type: 'heartbeat', host: HOST, code_version: codeVersion ?? 'builtin' }));
  }
}

async function onMessage(msg: any): Promise<void> {
  if (msg.type === 'system') {
    accepting = msg.acceptingOrders;
    log(accepting ? 'system: accepting orders' : 'system: KILL-SWITCH ON — not taking new orders');
  } else if (msg.type === 'wake') {
    void workLoopOnce();
  } else if (msg.type === 'deploy') {
    await applyDeploy(msg);
  }
}

// ---------------- Deploy ----------------
async function applyDeploy(msg: { deploymentId: string; packageId: string; sha256: string; filename: string }) {
  const ack = (ok: boolean, error?: string) =>
    ws?.send(JSON.stringify({ type: 'deploy_ack', deploymentId: msg.deploymentId, ok, error }));
  const version = msg.sha256.slice(0, 12);
  if (codeVersion === version) return ack(true); // ส่งซ้ำ → ตอบผลเดิม
  if (installing) return; // กำลังติดตั้งอยู่ — server จะส่งซ้ำถ้าไม่ได้ ack
  installing = true; // หยุดรับงานใหม่ระหว่างติดตั้ง
  try {
    const res = await fetch(`${SERVER}/agent/packages/${msg.packageId}`, {
      headers: { 'x-agent-token': TOKEN, 'x-bot-id': botId! },
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== msg.sha256) throw new Error('sha256 mismatch — package corrupted');
    // ไม่สลับโค้ดระหว่างทำออเดอร์: รอให้งานที่ถืออยู่จบก่อน
    while (busy) await sleep(200);
    // verify: ต้องโหลดโค้ดบอทจากแพ็กเกจได้ก่อนสลับ ไม่งั้นปฏิเสธ (เวอร์ชันเดิมทำงานต่อ)
    installPackage(DATA_DIR, version, msg.filename, buf, (dir) => void loadBot(dir));
    bot = loadBot(releaseDir(version)); // งานถัดไปใช้โค้ดใหม่
    codeVersion = version;
    log('deploy applied — bot code reloaded', { version, bot_code: `${bot.name}@${bot.version}`, filename: msg.filename });
    ack(true);
    sendHeartbeat();
  } catch (err) {
    log('deploy failed', { err: (err as Error).message });
    ack(false, (err as Error).message);
  } finally {
    installing = false;
  }
}

// ---------------- Work ----------------
async function workLoopOnce(): Promise<void> {
  if (busy || installing || !accepting || ws?.readyState !== WebSocket.OPEN) return;
  busy = true;
  try {
    const { status, data } = await api('POST', '/agent/claim');
    if (status === 204) return;
    if (status !== 200) {
      if (!['BOT_NOT_READY', 'SYSTEM_PAUSED', 'BOT_BUSY'].includes(data?.code)) log('claim failed', { status, data });
      return;
    }
    await process_(data);
  } catch (err) {
    log('work error', { err: (err as Error).message });
  } finally {
    busy = false;
  }
}

async function process_(job: Job & { lease_token: string }): Promise<void> {
  const id = job.external_order_id;
  const token = job.lease_token;
  const running = bot; // ใช้โค้ดชุดเดียวตลอดออเดอร์นี้
  const botVersion = `${running.name}@${running.version}`;
  log('claimed', { order: id, uid: job.player_uid, attempt: job.attempt, bot_code: botVersion });

  const ctx: BotContext = {
    job,
    workMs: WORK_MS,
    sleep,
    log: (msg, extra = {}) => log(msg, { order: id, ...extra }),
    extendLease: async () => (await api('POST', `/agent/orders/${id}/lease`, { lease_token: token })).status === 200,
    topup: async () => {
      const r = await api('POST', '/agent/provider/topup', { topup_key: job.topup_key, external_order_id: id });
      return r.status === 200 ? { ok: true, duplicate: r.data.duplicate } : { ok: false, error: JSON.stringify(r.data) };
    },
    complete: async () => {
      const r = await api('POST', `/agent/orders/${id}/complete`, { lease_token: token, bot_version: botVersion });
      log(r.status === 200 ? 'completed' : 'complete rejected', { order: id, status: r.status, data: r.data });
      return r.status === 200;
    },
    fail: async (code, message) => {
      await api('POST', `/agent/orders/${id}/fail`, { lease_token: token, code, message });
    },
  };
  try {
    await running.run(ctx);
  } catch (err) {
    // โค้ดบอทในแพ็กเกจโยน error → รายงานให้ server ตัดสินตาม retry policy
    log('bot code threw', { order: id, err: (err as Error).message });
    await ctx.fail('BOT_CODE_ERROR', (err as Error).message);
  }
}

loadInstalledBot();
connect();
setInterval(() => void workLoopOnce(), POLL_MS);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
