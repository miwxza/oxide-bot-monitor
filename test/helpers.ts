import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig, loadConfig } from '../src/config';
import { DbService } from '../src/db/db.service';
import { signPayload } from '../src/webhooks/webhooks.service';

/** ฐานข้อมูลเทสต์แยกจากฐานข้อมูล dev (สร้างให้อัตโนมัติถ้ายังไม่มี) */
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://oxide:oxide_dev@localhost:55432/oxide_test';

export const ADMIN = { 'x-admin-token': 'test-admin', 'x-actor': 'tester' };
export const agent = (botId: string) => ({ 'x-agent-token': 'test-agent', 'x-bot-id': botId });

async function ensureDatabase(): Promise<void> {
  const url = new URL(TEST_DB_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) await c.query(`CREATE DATABASE "${name}"`);
  await c.end();
}

export interface TestCtx {
  app: INestApplication;
  db: DbService;
  cfg: AppConfig;
  http: () => ReturnType<typeof request>;
}

export async function startApp(overrides: Partial<AppConfig> = {}): Promise<TestCtx> {
  await ensureDatabase();
  const cfg = loadConfig({
    databaseUrl: TEST_DB_URL,
    adminToken: 'test-admin',
    agentToken: 'test-agent',
    webhookSecret: 'test-secret',
    simulatorUrl: 'http://127.0.0.1:1', // ไม่มี simulator — เทสต์ที่ต้องใช้จะส่ง URL ของตัวเองมา
    runJobs: false, // เทสต์เรียก job เองทีละรอบ เพื่อคุมจังหวะได้
    maxAttempts: 3,
    retryBaseS: 10,
    orderLeaseS: 30,
    botHeartbeatTimeoutS: 15,
    ...overrides,
  });
  const app = await createApp(cfg, { logger: false });
  await app.listen(0, '127.0.0.1'); // listen ครั้งเดียว — supertest จะไม่เปิด port ใหม่ทุก request
  const db = app.get(DbService);
  return { app, db, cfg, http: () => request(app.getHttpServer()) };
}

/** ล้างข้อมูลทุกตาราง แล้วใส่ seed ใหม่: bot-01..03 ออนไลน์ + heartbeat สด, ระบบเปิดรับงาน */
export async function reset(db: DbService): Promise<void> {
  await db.query(`TRUNCATE order_events, webhook_events, provider_topups, alerts, audit_logs,
    bot_deployments, code_packages, oxide_bot_commands, orders, oxide_bot_agents RESTART IDENTITY CASCADE`);
  await db.query(`INSERT INTO oxide_bot_agents (id, name, device_name, status, last_heartbeat, agent_connected)
    VALUES ('bot-01','Oxide Bot 01','oxide-worker-01','online', now(), true),
           ('bot-02','Oxide Bot 02','oxide-worker-02','online', now(), true),
           ('bot-03','Oxide Bot 03','oxide-worker-03','online', now(), true)`);
  await db.query(`UPDATE system_settings SET accepting_orders = true, changed_by = NULL WHERE id = 1`);
}

let seq = 0;
/** สร้างออเดอร์ + จ่ายเงิน (ผ่าน webhook ที่เซ็นจริง) → QUEUED */
export async function paidOrder(ctx: TestCtx, uid = '12345678', amount = 146): Promise<string> {
  const id = `T-${Date.now()}-${++seq}`;
  await ctx.http().post('/orders').set(ADMIN).send({ external_order_id: id, player_uid: uid, package_code: 'AOEM-99', amount }).expect(201);
  await sendWebhook(ctx, { event_id: `evt-${id}`, external_order_id: id, transaction_id: `txn-${id}`, amount, paid_at: new Date().toISOString() }).expect(200);
  return id;
}

export function sendWebhook(ctx: TestCtx, body: object, secret = 'test-secret') {
  const raw = JSON.stringify(body);
  return ctx.http().post('/webhooks/payment').set('content-type', 'application/json').set('x-signature', signPayload(raw, secret)).send(raw);
}

export async function orderRow(ctx: TestCtx, id: string): Promise<any> {
  return ctx.db.one('SELECT * FROM orders WHERE external_order_id = $1', [id]);
}
