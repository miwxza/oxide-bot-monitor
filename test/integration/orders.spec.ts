/**
 * Order API + webhook (Postgres จริง)
 * เคส: idempotency ของการสร้างออเดอร์, webhook ซ้ำ / มาช้า / เงินก้อนเดิม, bot แย่งออเดอร์เดียวกัน
 */
import { ADMIN, agent, orderRow, paidOrder, reset, sendWebhook, startApp, TestCtx } from '../helpers';

let ctx: TestCtx;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx?.app.close());
beforeEach(async () => reset(ctx.db));

const body = (id: string, uid = '12345678') => ({ external_order_id: id, player_uid: uid, package_code: 'AOEM-99', amount: 146 });

describe('create order (idempotency)', () => {
  it('returns 201 then 200 with the same order, 409 for different data', async () => {
    const first = await ctx.http().post('/orders').set(ADMIN).send(body('SHOP-1')).expect(201);
    expect(first.body.status).toBe('PENDING_PAYMENT');
    const again = await ctx.http().post('/orders').set(ADMIN).send(body('SHOP-1')).expect(200);
    expect(again.body.id).toBe(first.body.id);
    const diff = await ctx.http().post('/orders').set(ADMIN).send(body('SHOP-1', '99999999')).expect(409);
    expect(diff.body.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('creates exactly one order when the same request arrives 10 times at once', async () => {
    const res = await Promise.all(Array.from({ length: 10 }, () => ctx.http().post('/orders').set(ADMIN).send(body('SHOP-RACE'))));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 200)).toHaveLength(9);
    expect((await ctx.db.query(`SELECT 1 FROM orders WHERE external_order_id = 'SHOP-RACE'`)).length).toBe(1);
  });

  it('rejects invalid input with the uniform error shape', async () => {
    const r = await ctx.http().post('/orders').set(ADMIN).send({ external_order_id: 'x', amount: -1 }).expect(400);
    expect(r.body).toMatchObject({ code: 'VALIDATION_ERROR', request_id: expect.any(String) });
  });

  it('requires the admin token', async () => {
    await ctx.http().post('/orders').send(body('SHOP-2')).expect(401);
  });
});

describe('payment webhook', () => {
  const pay = (id: string, extra: object = {}) => ({
    event_id: `evt-${id}`, external_order_id: id, transaction_id: `txn-${id}`, amount: 146, paid_at: new Date().toISOString(), ...extra,
  });

  beforeEach(async () => {
    await ctx.http().post('/orders').set(ADMIN).send(body('W-1')).expect(201);
  });

  it('rejects a bad signature', async () => {
    await sendWebhook(ctx, pay('W-1'), 'wrong-secret').expect(401);
    expect((await orderRow(ctx, 'W-1')).status).toBe('PENDING_PAYMENT');
  });

  it('processes a duplicated event once', async () => {
    const a = await sendWebhook(ctx, pay('W-1')).expect(200);
    const b = await sendWebhook(ctx, pay('W-1')).expect(200);
    expect(a.body.outcome).toBe('paid');
    expect(b.body.outcome).toBe('duplicate_event');
    const events = await ctx.db.query(`SELECT 1 FROM order_events e JOIN orders o ON o.id = e.order_id
      WHERE o.external_order_id = 'W-1' AND e.payload->>'to' = 'QUEUED'`);
    expect(events).toHaveLength(1);
  });

  it('does not let one bank transaction pay two orders', async () => {
    await ctx.http().post('/orders').set(ADMIN).send(body('W-2')).expect(201);
    await sendWebhook(ctx, pay('W-1', { transaction_id: 'TXN-SAME' })).expect(200);
    const r = await sendWebhook(ctx, pay('W-2', { event_id: 'evt-other', transaction_id: 'TXN-SAME' })).expect(200);
    expect(r.body.outcome).toBe('transaction_reused');
    expect((await orderRow(ctx, 'W-2')).status).toBe('PENDING_PAYMENT');
  });

  it('queues an order that expired before the webhook arrived but was paid in time', async () => {
    await ctx.db.query(`UPDATE orders SET status = 'EXPIRED', payment_expires_at = now() - interval '1 minute' WHERE external_order_id = 'W-1'`);
    const paidAt = new Date(Date.now() - 5 * 60_000).toISOString(); // จ่ายก่อนหมดเวลา
    const r = await sendWebhook(ctx, pay('W-1', { paid_at: paidAt })).expect(200);
    expect(r.body).toEqual({ outcome: 'paid', status: 'QUEUED' });
  });

  it('does not top up when paid after expiry, and alerts for a refund', async () => {
    await ctx.db.query(`UPDATE orders SET payment_expires_at = now() - interval '1 minute' WHERE external_order_id = 'W-1'`);
    const r = await sendWebhook(ctx, pay('W-1')).expect(200);
    expect(r.body.outcome).toBe('paid_after_expiry');
    expect((await orderRow(ctx, 'W-1')).status).toBe('EXPIRED');
    expect(await ctx.db.query(`SELECT 1 FROM alerts WHERE kind = 'paid_after_expiry'`)).toHaveLength(1);
  });

  it('rejects a wrong amount without confirming payment', async () => {
    const r = await sendWebhook(ctx, pay('W-1', { amount: 1 })).expect(200);
    expect(r.body.outcome).toBe('amount_mismatch');
    expect((await orderRow(ctx, 'W-1')).status).toBe('PENDING_PAYMENT');
  });
});

describe('bots claiming orders (concurrency)', () => {
  it('gives one queued order to exactly one of three bots claiming at once', async () => {
    const id = await paidOrder(ctx);
    const res = await Promise.all(['bot-01', 'bot-02', 'bot-03'].map((b) => ctx.http().post('/agent/claim').set(agent(b))));
    const winners = res.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(winners[0].body.external_order_id).toBe(id);
    expect(res.filter((r) => r.status === 204)).toHaveLength(2);
  });

  it('spreads 6 orders over 3 bots with no order taken twice', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => paidOrder(ctx)));
    const taken: string[] = [];
    for (let round = 0; round < 2; round++) {
      const res = await Promise.all(['bot-01', 'bot-02', 'bot-03'].map((b) => ctx.http().post('/agent/claim').set(agent(b))));
      for (const r of res) {
        expect(r.status).toBe(200);
        taken.push(r.body.external_order_id);
        // จบงานก่อนรับงานใหม่ (เครื่องหนึ่งทำได้ทีละออเดอร์)
        const bot = r.request.getHeader('x-bot-id') as string;
        await ctx.http().post('/agent/provider/topup').set(agent(bot)).send({ topup_key: r.body.topup_key, external_order_id: r.body.external_order_id }).expect(200);
        await ctx.http().post(`/agent/orders/${r.body.external_order_id}/complete`).set(agent(bot)).send({ lease_token: r.body.lease_token }).expect(200);
      }
    }
    expect(new Set(taken).size).toBe(6);
    expect(taken.sort()).toEqual(ids.sort());
  });

  it('gives a bot only one order even when it claims 5 times at once', async () => {
    await Promise.all(Array.from({ length: 5 }, () => paidOrder(ctx)));
    const res = await Promise.all(Array.from({ length: 5 }, () => ctx.http().post('/agent/claim').set(agent('bot-01'))));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => r.body.code === 'BOT_BUSY')).toBe(true);
    const held = await ctx.db.query(`SELECT 1 FROM orders WHERE assigned_bot_id = 'bot-01' AND status = 'IN_PROGRESS'`);
    expect(held).toHaveLength(1);
  });

  it('lets a bot hold only one order at a time', async () => {
    await paidOrder(ctx);
    await paidOrder(ctx);
    await ctx.http().post('/agent/claim').set(agent('bot-01')).expect(200);
    const second = await ctx.http().post('/agent/claim').set(agent('bot-01')).expect(409);
    expect(second.body.code).toBe('BOT_BUSY');
  });
});
