/**
 * ฝั่งควบคุมบอท: kill-switch, คำสั่งเปิด/ปิด (ผ่าน simulator), อัปเดตโค้ด, dashboard
 */
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { CommandsService } from '../../src/bots/commands.service';
import { DeployService } from '../../src/deploy/deploy.service';
import { ADMIN, agent, orderRow, paidOrder, reset, startApp, TestCtx } from '../helpers';

/** simulator ปลอม: ตอบเหมือน simulator/server.js และนับ request / ทำให้ล่มได้ */
function fakeSimulator() {
  const state = { calls: 0, failNext: 0, statusCode: 503 };
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const m = req.url?.match(/^\/bots\/([^/]+)\/commands$/);
    if (req.method === 'GET' && req.url === '/bots') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      return;
    }
    if (!m) return void res.writeHead(404).end('{}');
    state.calls++;
    if (state.failNext > 0) {
      state.failNext--;
      return void res.writeHead(state.statusCode, { 'content-type': 'application/json' }).end('{"error":"down"}');
    }
    const command = JSON.parse(body || '{}').command;
    const status = command === 'stop' ? 'offline' : 'online';
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ok: true, command, bot: { id: m[1], status, cpuPercent: 1, memoryPercent: 2, uptimeSeconds: 3 } }),
    );
  });
  return { server, state };
}

let ctx: TestCtx;
let sim: ReturnType<typeof fakeSimulator>;
beforeAll(async () => {
  sim = fakeSimulator();
  await new Promise<void>((r) => sim.server.listen(0, '127.0.0.1', r));
  ctx = await startApp({ simulatorUrl: `http://127.0.0.1:${(sim.server.address() as AddressInfo).port}` });
});
afterAll(async () => {
  await ctx?.app.close();
  sim?.server.close();
});
beforeEach(async () => {
  await reset(ctx.db);
  Object.assign(sim.state, { calls: 0, failNext: 0, statusCode: 503 });
});

const killSwitch = (accepting: boolean) =>
  ctx.http().put('/system/kill-switch').set(ADMIN).send({ accepting_orders: accepting }).expect(200);

describe('global kill-switch', () => {
  it('makes every bot refuse new orders, and resumes when turned back on', async () => {
    const id = await paidOrder(ctx);
    await killSwitch(false);
    for (const b of ['bot-01', 'bot-02', 'bot-03']) {
      expect((await ctx.http().post('/agent/claim').set(agent(b)).expect(409)).body.code).toBe('SYSTEM_PAUSED');
    }
    const dash = await ctx.http().get('/dashboard').set(ADMIN).expect(200);
    expect(dash.body.summary).toMatchObject({ online: 3, active: 0, standby: 3 });

    await killSwitch(true);
    expect((await ctx.http().post('/agent/claim').set(agent('bot-01')).expect(200)).body.external_order_id).toBe(id);
    const audit = await ctx.db.query(`SELECT action, actor FROM audit_logs ORDER BY id`);
    expect(audit).toEqual([
      { action: 'system.kill_switch', actor: 'tester' },
      { action: 'system.resume', actor: 'tester' },
    ]);
  });

  it('blocks a claim that races with the switch: no order is handed out after it commits', async () => {
    const id = await paidOrder(ctx);
    // แอดมินกด kill-switch แต่ transaction ยังไม่ commit
    const admin = await ctx.db.pool.connect();
    await admin.query('BEGIN');
    await admin.query(`UPDATE system_settings SET accepting_orders = false WHERE id = 1`);

    const claim = ctx.http().post('/agent/claim').set(agent('bot-01')).then((r) => r);
    await new Promise((r) => setTimeout(r, 300)); // claim ต้องรอ lock ไม่ใช่อ่านค่าเก่าแล้วผ่านไป
    await admin.query('COMMIT');
    admin.release();

    const r = await claim;
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SYSTEM_PAUSED');
    expect((await orderRow(ctx, id)).status).toBe('QUEUED');
  });

  it('lets an in-progress order finish after the switch is turned off', async () => {
    const id = await paidOrder(ctx);
    const job = (await ctx.http().post('/agent/claim').set(agent('bot-01')).expect(200)).body;
    await killSwitch(false);
    await ctx.http().post('/agent/provider/topup').set(agent('bot-01')).send({ topup_key: job.topup_key, external_order_id: id }).expect(200);
    await ctx.http().post(`/agent/orders/${id}/complete`).set(agent('bot-01')).send({ lease_token: job.lease_token }).expect(200);
  });
});

describe('bot commands (start / stop via simulator)', () => {
  const send = (bot: string, command: string, key?: string) => {
    const req = ctx.http().post(`/bots/${bot}/commands`).set(ADMIN);
    return (key ? req.set('idempotency-key', key) : req).send({ command });
  };

  it('accepts only one pending command per bot when start and stop are pressed at once', async () => {
    const [a, b] = await Promise.all([send('bot-03', 'start'), send('bot-03', 'stop')]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe('COMMAND_IN_PROGRESS');
  });

  it('returns the same command for a repeated Idempotency-Key and sends it to the simulator once', async () => {
    const first = await send('bot-03', 'start', 'click-1').expect(202);
    const again = await send('bot-03', 'start', 'click-1').expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await send('bot-03', 'stop', 'click-1').expect(409)).body.code).toBe('IDEMPOTENCY_MISMATCH');

    await ctx.app.get(CommandsService).runPending();
    await ctx.app.get(CommandsService).runPending();
    expect(sim.state.calls).toBe(1);
    const cmd = (await ctx.http().get(`/commands/${first.body.id}`).set(ADMIN).expect(200)).body;
    expect(cmd.status).toBe('success');
    expect((await ctx.db.one(`SELECT status FROM oxide_bot_agents WHERE id = 'bot-03'`)).status).toBe('online');
  });

  it('retries when the simulator is down, then succeeds', async () => {
    sim.state.failNext = 1;
    const cmd = (await send('bot-02', 'stop').expect(202)).body;
    const commands = ctx.app.get(CommandsService);
    await commands.runPending();
    expect((await ctx.db.one('SELECT status, attempts FROM oxide_bot_commands WHERE id = $1', [cmd.id]))).toEqual({
      status: 'queued',
      attempts: 1,
    });
    await ctx.db.query('UPDATE oxide_bot_commands SET next_attempt_at = now() WHERE id = $1', [cmd.id]);
    await commands.runPending();
    expect((await ctx.db.one('SELECT status, attempts FROM oxide_bot_commands WHERE id = $1', [cmd.id]))).toEqual({
      status: 'success',
      attempts: 2,
    });
  });

  it('gives up after 3 attempts, and does not retry a 4xx answer', async () => {
    const commands = ctx.app.get(CommandsService);
    sim.state.failNext = 10;
    const down = (await send('bot-02', 'restart').expect(202)).body;
    for (let i = 0; i < 3; i++) {
      await ctx.db.query('UPDATE oxide_bot_commands SET next_attempt_at = now()');
      await commands.runPending();
    }
    expect((await ctx.db.one('SELECT status FROM oxide_bot_commands WHERE id = $1', [down.id])).status).toBe('failed');

    sim.state.failNext = 1;
    sim.state.statusCode = 400;
    const bad = (await send('bot-01', 'start').expect(202)).body;
    await commands.runPending();
    expect((await ctx.db.one('SELECT status, attempts FROM oxide_bot_commands WHERE id = $1', [bad.id]))).toEqual({
      status: 'failed',
      attempts: 1,
    });
  });

  it('rejects an unknown command and an unknown bot', async () => {
    await send('bot-01', 'format').expect(400);
    await send('bot-99', 'start').expect(404);
  });
});

describe('code deployment', () => {
  const zip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake zip body')]);
  const upload = (buf = zip, name = 'oxide-test.zip') => ctx.http().post('/packages').set(ADMIN).attach('file', buf, name);

  it('stores a package once per content and refuses non-zip files', async () => {
    const a = await upload().expect(201);
    const b = await upload(zip, 'renamed.zip').expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await upload(Buffer.from('hello'), 'x.zip').expect(400)).body.code).toBe('NOT_A_ZIP');
  });

  it('deploys to all bots once, then reports already_current after the agents confirm', async () => {
    const pkg = (await upload().expect(201)).body;
    const first = await ctx.http().post(`/packages/${pkg.id}/deploy`).set(ADMIN).send({}).expect(202);
    expect(first.body.results.map((r: any) => r.result)).toEqual(['queued', 'queued', 'queued']);

    const again = await ctx.http().post(`/packages/${pkg.id}/deploy`).set(ADMIN).send({}).expect(202);
    expect(again.body.results.map((r: any) => r.result)).toEqual(['in_progress', 'in_progress', 'in_progress']);

    const deploy = ctx.app.get(DeployService);
    for (const r of first.body.results) await deploy.ack(r.bot_id, String(r.deployment_id), true);
    await deploy.ack('bot-01', String(first.body.results[0].deployment_id), true); // ack ซ้ำไม่เป็นไร

    const third = await ctx.http().post(`/packages/${pkg.id}/deploy`).set(ADMIN).send({}).expect(202);
    expect(third.body.results.map((r: any) => r.result)).toEqual(['already_current', 'already_current', 'already_current']);
    const versions = await ctx.db.query('SELECT DISTINCT code_version FROM oxide_bot_agents');
    expect(versions).toEqual([{ code_version: pkg.sha256.slice(0, 12) }]);
  });

  it('can target selected bots and records a failed update', async () => {
    const pkg = (await upload().expect(201)).body;
    const r = await ctx.http().post(`/packages/${pkg.id}/deploy`).set(ADMIN).send({ bot_ids: ['bot-02'] }).expect(202);
    expect(r.body.results).toEqual([{ bot_id: 'bot-02', result: 'queued', deployment_id: expect.anything() }]);
    await ctx.app.get(DeployService).ack('bot-02', String(r.body.results[0].deployment_id), false, 'sha256 mismatch');
    const d = await ctx.db.one('SELECT status, error FROM bot_deployments');
    expect(d).toEqual({ status: 'failed', error: 'sha256 mismatch' });
    await ctx.http().post(`/packages/${pkg.id}/deploy`).set(ADMIN).send({ bot_ids: ['bot-99'] }).expect(400);
  });

  it('serves the package to agents only', async () => {
    const pkg = (await upload().expect(201)).body;
    await ctx.http().get(`/agent/packages/${pkg.id}`).expect(401);
    const r = await ctx.http().get(`/agent/packages/${pkg.id}`).set(agent('bot-01')).expect(200);
    expect(r.headers['x-sha256']).toBe(pkg.sha256);
  });
});

describe('dashboard', () => {
  it('summarizes machine and bot states', async () => {
    await ctx.db.query(`UPDATE oxide_bot_agents SET last_heartbeat = now() - interval '1 hour' WHERE id = 'bot-03'`);
    await ctx.db.query(`UPDATE oxide_bot_agents SET status = 'offline' WHERE id = 'bot-02'`);
    await paidOrder(ctx);
    await ctx.http().post('/agent/claim').set(agent('bot-01')).expect(200);
    const d = (await ctx.http().get('/dashboard').set(ADMIN).expect(200)).body;
    expect(d.summary).toEqual({ total: 3, online: 2, active: 0, standby: 1, in_progress: 1, offline: 1 });
    expect(d.bots.find((b: any) => b.id === 'bot-01').current_order).toMatch(/^T-/);
  });
});
