/**
 * Bot agent จำลอง — 1 process = 1 เครื่อง (Node/Notebook)
 *
 *   node dist/agent/bot-agent.js bot-01
 *
 * - WebSocket /ws/agent : heartbeat ทุก HEARTBEAT_MS, รับ system / wake / deploy
 * - REST /agent/*        : claim งาน, ต่อ lease, เติมเกมที่ provider, complete / fail
 *
 * พฤติกรรมตาม player_uid (สำหรับ demo เคสปัญหา):
 *   INVALID001     → INVALID_UID (permanent → FAILED)
 *   FLAKY001       → PROVIDER_TIMEOUT ทุกครั้ง (retry → DELAYED)
 *   UNKNOWN001     → TOPUP_STATUS_UNKNOWN (DELAYED ทันที)
 *   HANG001        → รับงานแล้วเงียบ (lease หมด → คืนคิว → เครื่องอื่นรับต่อ)
 *   TOPUPCRASH001  → เติมที่ provider แล้ว "ล่ม" ก่อน complete → เครื่องถัดไปเติมซ้ำด้วย topup_key เดิม = ไม่เติมซ้ำ
 *   อื่น ๆ          → สำเร็จ
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

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
let heartbeatTimer: NodeJS.Timeout | undefined;

const log = (msg: string, extra: object = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), bot: botId, msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    ws.send(JSON.stringify({ type: 'heartbeat', host: HOST, code_version: codeVersion }));
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
  try {
    const res = await fetch(`${SERVER}/agent/packages/${msg.packageId}`, {
      headers: { 'x-agent-token': TOKEN, 'x-bot-id': botId! },
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== msg.sha256) throw new Error('sha256 mismatch — package corrupted');
    // "ติดตั้ง": เก็บไฟล์ไว้ในโฟลเดอร์ของเครื่อง (bot จริงจะแตก zip แล้ว restart process)
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, `${version}-${msg.filename}`), buf);
    codeVersion = version;
    log('deploy applied', { version, filename: msg.filename });
    ack(true);
    sendHeartbeat();
  } catch (err) {
    log('deploy failed', { err: (err as Error).message });
    ack(false, (err as Error).message);
  }
}

// ---------------- Work ----------------
async function workLoopOnce(): Promise<void> {
  if (busy || !accepting || ws?.readyState !== WebSocket.OPEN) return;
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

async function process_(job: any): Promise<void> {
  const id = job.external_order_id;
  const token = job.lease_token;
  log('claimed', { order: id, uid: job.player_uid, attempt: job.attempt });
  const fail = (code: string, message: string) => api('POST', `/agent/orders/${id}/fail`, { lease_token: token, code, message });

  switch (job.player_uid) {
    case 'INVALID001':
      await sleep(500);
      return void (await fail('INVALID_UID', 'Player UID not found at provider'));
    case 'FLAKY001':
      await sleep(500);
      return void (await fail('PROVIDER_TIMEOUT', 'Provider did not respond in 30s'));
    case 'UNKNOWN001':
      await sleep(500);
      return void (await fail('TOPUP_STATUS_UNKNOWN', 'Provider returned 500 after charging'));
    case 'HANG001':
      log('simulating hang (no lease renewal)', { order: id });
      return;
  }

  // ทำงานจริง: ต่อ lease ระหว่างทำ ถ้า lease หาย (ถูกคืนคิว) ให้หยุดทันที
  const steps = Math.max(1, Math.round(WORK_MS / 1000));
  for (let i = 0; i < steps; i++) {
    await sleep(WORK_MS / steps);
    const lease = await api('POST', `/agent/orders/${id}/lease`, { lease_token: token });
    if (lease.status !== 200) return log('lease lost, aborting', { order: id });
  }
  const topup = await api('POST', '/agent/provider/topup', { topup_key: job.topup_key, external_order_id: id });
  if (topup.status !== 200) return void (await fail('PROVIDER_DOWN', JSON.stringify(topup.data)));
  if (topup.data.duplicate) log('provider: already topped up by previous attempt — not charging again', { order: id });

  if (job.player_uid === 'TOPUPCRASH001' && job.attempt === 1) {
    return log('simulating crash after top-up, before complete', { order: id });
  }
  const done = await api('POST', `/agent/orders/${id}/complete`, { lease_token: token });
  log(done.status === 200 ? 'completed' : 'complete rejected', { order: id, status: done.status, data: done.data });
}

connect();
setInterval(() => void workLoopOnce(), POLL_MS);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
