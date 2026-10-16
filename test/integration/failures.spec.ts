/**
 * เครื่องหลุด / lease หมด / error จาก bot / ออเดอร์ค้าง (Postgres จริง, เรียก job เองทีละรอบ)
 */
import { JobsService } from '../../src/jobs/jobs.service';
import { ADMIN, agent, orderRow, paidOrder, reset, startApp, TestCtx } from '../helpers';

let ctx: TestCtx;
let jobs: JobsService;
beforeAll(async () => {
  ctx = await startApp();
  jobs = ctx.app.get(JobsService);
});
afterAll(async () => ctx?.app.close());
beforeEach(async () => reset(ctx.db));

async function claim(bot: string) {
  const r = await ctx.http().post('/agent/claim').set(agent(bot)).expect(200);
  return r.body as { external_order_id: string; lease_token: string; topup_key: string; attempt: number };
}
const fail = (bot: string, id: string, token: string, code: string) =>
  ctx.http().post(`/agent/orders/${id}/fail`).set(agent(bot)).send({ lease_token: token, code });
/** ทำให้ออเดอร์พร้อมรับใหม่ทันที (ข้ามช่วง backoff) */
const skipBackoff = (id: string) => ctx.db.query(`UPDATE orders SET next_attempt_at = now() WHERE external_order_id = $1`, [id]);

describe('machine goes offline (heartbeat timeout)', () => {
  it('requeues the order right away without waiting for the lease, and another bot finishes it', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '1 minute' WHERE id = 'bot-01'`);

    expect(await jobs.reclaimStaleOrders()).toBe(1);
    const o = await orderRow(ctx, id);
    expect(o).toMatchObject({ status: 'QUEUED', last_error_code: 'BOT_HEARTBEAT_TIMEOUT', lease_token: null });

    // bot-01 กลับมาแล้วพยายามจบงานเดิม → token เก่าใช้ไม่ได้
    const late = await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-01')).send({ lease_token: job.lease_token }).expect(409);
    expect(late.body.code).toBe('LEASE_LOST');

    // เครื่องที่ heartbeat ขาดรับงานใหม่ไม่ได้
    expect((await ctx.http().post('/agent/claim').set(agent('bot-01')).expect(409)).body.code).toBe('BOT_NOT_READY');

    await skipBackoff(id);
    const retry = await claim('bot-02');
    expect(retry).toMatchObject({ external_order_id: id, attempt: 2, topup_key: job.topup_key });
  });

  it('moves the order to DELAYED with an alert after the last attempt (paid order is not auto-FAILED)', async () => {
    const id = await paidOrder(ctx);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await skipBackoff(id);
      const bot = `bot-0${attempt}`;
      await claim(bot);
      await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '1 minute' WHERE id = $1`, [bot]);
      await jobs.reclaimStaleOrders();
    }
    expect((await orderRow(ctx, id)).status).toBe('DELAYED');
    expect(await ctx.db.query(`SELECT 1 FROM alerts WHERE kind = 'order_delayed'`)).toHaveLength(1);
  });

  it('reclaims an order whose lease expired while the machine is still online', async () => {
    const id = await paidOrder(ctx);
    await claim('bot-01');
    await ctx.db.query(`UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE external_order_id = $1`, [id]);
    await jobs.reclaimStaleOrders();
    expect(await orderRow(ctx, id)).toMatchObject({ status: 'QUEUED', last_error_code: 'LEASE_EXPIRED' });
  });

  it('keeps a lease alive while the bot reports progress', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    await ctx.db.query(`UPDATE orders SET lease_expires_at = now() + interval '1 second' WHERE external_order_id = $1`, [id]);
    await ctx.http().post(`/agent/orders/${id}/lease`).set(agent('bot-01')).send({ lease_token: job.lease_token }).expect(200);
    expect(await jobs.reclaimStaleOrders()).toBe(0);
  });
});

describe('top-up after a crash is not charged twice', () => {
  it('second attempt reuses the topup_key: provider reports duplicate and the order completes', async () => {
    const id = await paidOrder(ctx);
    const first = await claim('bot-01');
    await ctx.http().post('/agent/provider/topup').set(agent('bot-01')).send({ topup_key: first.topup_key, external_order_id: id }).expect(200);
    // ล่มก่อน complete
    await ctx.db.query(`UPDATE orders SET lease_expires_at = now() - interval '1 second' WHERE external_order_id = $1`, [id]);
    await jobs.reclaimStaleOrders();
    await skipBackoff(id);

    const second = await claim('bot-02');
    const topup = await ctx.http().post('/agent/provider/topup').set(agent('bot-02')).send({ topup_key: second.topup_key, external_order_id: id }).expect(200);
    expect(topup.body).toEqual({ duplicate: true });
    await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-02')).send({ lease_token: second.lease_token }).expect(200);
    expect(await ctx.db.query('SELECT 1 FROM provider_topups')).toHaveLength(1);
  });

  it('refuses to complete without a recorded top-up, and repeats the same answer for a repeated complete', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    const noTopup = await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-01')).send({ lease_token: job.lease_token }).expect(409);
    expect(noTopup.body.code).toBe('TOPUP_NOT_FOUND');
    await ctx.http().post('/agent/provider/topup').set(agent('bot-01')).send({ topup_key: job.topup_key, external_order_id: id }).expect(200);
    const done = await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-01')).send({ lease_token: job.lease_token }).expect(200);
    const again = await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-01')).send({ lease_token: job.lease_token }).expect(200);
    expect(done.body.duplicate).toBe(false);
    expect(again.body.duplicate).toBe(true);
  });
});

describe('which bot code finished the order', () => {
  it('records bot_version from the package in the timeline', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    await ctx.http().post('/agent/provider/topup').set(agent('bot-01')).send({ topup_key: job.topup_key, external_order_id: id }).expect(200);
    await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-01')).send({ lease_token: job.lease_token, bot_version: 'oxide-bot@2.0.0' }).expect(200);
    const timeline = (await ctx.http().get(`/orders/${id}/timeline`).set(ADMIN).expect(200)).body;
    expect(timeline.at(-1).payload).toMatchObject({ to: 'COMPLETED', bot_id: 'bot-01', bot_version: 'oxide-bot@2.0.0' });
  });

  it('retries when the bot code itself throws', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    expect((await fail('bot-01', id, job.lease_token, 'BOT_CODE_ERROR').expect(200)).body.status).toBe('QUEUED');
  });
});

describe('errors reported by bots (retry policy on the server)', () => {
  it('fails a permanent error immediately', async () => {
    const id = await paidOrder(ctx, 'INVALID001');
    const job = await claim('bot-01');
    expect((await fail('bot-01', id, job.lease_token, 'INVALID_UID').expect(200)).body.status).toBe('FAILED');
  });

  it('retries a transient error with backoff, then DELAYED after max attempts', async () => {
    const id = await paidOrder(ctx);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await skipBackoff(id);
      const job = await claim('bot-01');
      const r = await fail('bot-01', id, job.lease_token, 'PROVIDER_TIMEOUT').expect(200);
      if (r.body.retry_in_s) delays.push(r.body.retry_in_s);
      if (i < 2) {
        const o = await orderRow(ctx, id);
        expect(o.status).toBe('QUEUED');
        expect(new Date(o.next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // ยังไม่ถึงเวลา retry
        expect((await ctx.http().post('/agent/claim').set(agent('bot-02'))).status).toBe(204);
      }
    }
    expect(delays).toEqual([10, 20]);
    expect((await orderRow(ctx, id)).status).toBe('DELAYED');
  });

  it('sends an unknown top-up outcome straight to admin review', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    expect((await fail('bot-01', id, job.lease_token, 'TOPUP_STATUS_UNKNOWN').expect(200)).body.status).toBe('DELAYED');
  });

  it('lets an admin requeue a DELAYED order with fresh attempts', async () => {
    const id = await paidOrder(ctx);
    const job = await claim('bot-01');
    await fail('bot-01', id, job.lease_token, 'TOPUP_STATUS_UNKNOWN').expect(200);
    const r = await ctx.http().post(`/orders/${id}/requeue`).set(ADMIN).send({ note: 'checked provider: not charged' }).expect(200);
    expect(r.body).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(r.body.lease_token).toBeUndefined();
  });

  it('rejects an invalid state change with 409', async () => {
    const id = await paidOrder(ctx);
    const r = await ctx.http().post(`/orders/${id}/resolve`).set(ADMIN).send({ outcome: 'COMPLETED' }).expect(409);
    expect(r.body.code).toBe('INVALID_TRANSITION');
  });
});

describe('stuck orders', () => {
  it('expires unpaid orders after the payment window', async () => {
    await ctx.http().post('/orders').set(ADMIN).send({ external_order_id: 'UNPAID', player_uid: '12345678', package_code: 'AOEM-99', amount: 146 }).expect(201);
    await ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '1 second' WHERE external_order_id = 'UNPAID'`);
    expect(await jobs.expirePayments()).toBe(1);
    expect((await orderRow(ctx, 'UNPAID')).status).toBe('EXPIRED');
  });

  it('alerts once for an order queued longer than the SLA', async () => {
    const id = await paidOrder(ctx);
    await ctx.db.query(`UPDATE orders SET next_attempt_at = now() - interval '1 hour' WHERE external_order_id = $1`, [id]);
    expect(await jobs.alertQueuedSla()).toBe(1);
    expect(await jobs.alertQueuedSla()).toBe(0); // รันซ้ำไม่แจ้งซ้ำ
  });
});
