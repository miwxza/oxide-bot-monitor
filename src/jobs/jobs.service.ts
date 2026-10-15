import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WorkService } from '../agent/work.service';
import { BotsService } from '../bots/bots.service';
import { CommandsService } from '../bots/commands.service';
import { SimulatorClient } from '../bots/simulator.client';
import { raiseAlert } from '../common/audit';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { DeployService } from '../deploy/deploy.service';
import { transition } from '../orders/state-machine';
import { EventsService } from '../realtime/events.service';

const BATCH = 100;

/**
 * งานเบื้องหลังแบบ polling — แต่ละ job ใช้ transaction และ row lock (SKIP LOCKED) ของตัวเอง
 * จึงรันซ้ำ/รันหลาย instance ได้ และ job หนึ่งพังไม่หยุด job อื่น
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private simulatorDown = false;

  constructor(
    private readonly db: DbService,
    private readonly work: WorkService,
    private readonly bots: BotsService,
    private readonly commands: CommandsService,
    private readonly deploy: DeployService,
    private readonly simulator: SimulatorClient,
    private readonly events: EventsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  start(): void {
    this.timers.push(setInterval(() => void this.tick(), this.cfg.jobIntervalMs));
    this.timers.push(setInterval(() => void this.syncSimulator(), this.cfg.simulatorPollMs));
    void this.syncSimulator();
  }

  /** หนึ่งรอบ — public เพื่อให้เทสต์เรียกตรง ๆ ได้ */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [name, job] of [
        ['expire_payments', () => this.expirePayments()],
        ['reclaim_stale_orders', () => this.reclaimStaleOrders()],
        ['queued_sla', () => this.alertQueuedSla()],
        ['bot_offline', () => this.alertOfflineBots()],
        ['commands', () => this.commands.runPending()],
        ['deployments', () => this.deploy.dispatchPending()],
      ] as const) {
        try {
          await job();
        } catch (err) {
          this.log.error({ job: name, err: (err as Error).message });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** PENDING_PAYMENT เกินเวลาชำระ → EXPIRED */
  async expirePayments(): Promise<number> {
    const n = await this.db.tx(async (db) => {
      const rows = (
        await db.query(
          `SELECT id FROM orders WHERE status = 'PENDING_PAYMENT' AND payment_expires_at < now()
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,
          [BATCH],
        )
      ).rows;
      for (const r of rows) {
        await transition(db, r.id, 'PENDING_PAYMENT', 'EXPIRED', { reason: 'payment_window_elapsed', actor: 'system' });
      }
      return rows.length;
    });
    if (n) this.events.changed('jobs.expire');
    return n;
  }

  /**
   * Heartbeat timeout: ออเดอร์ IN_PROGRESS ที่
   *  (ก) เครื่องที่ถืออยู่ heartbeat ขาด → เครื่องหลุด/ล่ม (ไม่ต้องรอ lease หมด)
   *  (ข) lease หมดอายุ → bot ไม่รายงานความคืบหน้า
   * ตัดสินด้วย retry policy เดียวกับ error ปกติ: มี attempt เหลือ → QUEUED (เครื่องอื่นรับต่อ),
   * ครบแล้ว → DELAYED + alert ให้แอดมินตรวจกับ provider ก่อน (ลูกค้าจ่ายเงินแล้ว จึงไม่ FAILED อัตโนมัติ)
   */
  async reclaimStaleOrders(): Promise<number> {
    const results = await this.db.tx(async (db) => {
      const rows = (
        await db.query(
          `SELECT o.*, COALESCE(a.last_heartbeat > now() - make_interval(secs => $2), false) AS bot_alive
           FROM orders o LEFT JOIN oxide_bot_agents a ON a.id = o.assigned_bot_id
           WHERE o.status = 'IN_PROGRESS'
             AND (o.lease_expires_at IS NULL OR o.lease_expires_at < now()
                  OR a.last_heartbeat IS NULL OR a.last_heartbeat < now() - make_interval(secs => $2))
           ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT $1`,
          [BATCH, this.cfg.botHeartbeatTimeoutS],
        )
      ).rows;
      const out = [];
      for (const o of rows) {
        const code = o.bot_alive ? 'LEASE_EXPIRED' : 'BOT_HEARTBEAT_TIMEOUT';
        out.push(await this.work.applyFailure(db, o, code, `${code} on ${o.assigned_bot_id ?? 'unknown bot'}`, 'system'));
      }
      return out;
    });
    if (results.length) {
      this.log.warn({ msg: 'reclaimed stale orders', results });
      if (results.some((r) => r.status === 'QUEUED')) this.events.toAgent('*', { type: 'wake' });
      this.events.changed('jobs.reclaim');
    }
    return results.length;
  }

  async alertQueuedSla(): Promise<number> {
    const rows = await this.db.query(
      `SELECT id, external_order_id, version FROM orders
       WHERE status = 'QUEUED' AND COALESCE(next_attempt_at, updated_at) < now() - make_interval(secs => $1)
         AND NOT EXISTS (SELECT 1 FROM alerts WHERE dedupe_key = 'queued_sla:' || orders.id || ':' || orders.version)
       ORDER BY id LIMIT $2`,
      [this.cfg.queuedSlaS, BATCH],
    );
    for (const r of rows) {
      await raiseAlert(this.db.pool, {
        kind: 'queued_sla',
        message: `Order ${r.external_order_id} waiting in queue longer than ${this.cfg.queuedSlaS}s (no bot available?)`,
        orderId: r.id,
        dedupeKey: `queued_sla:${r.id}:${r.version}`,
      });
    }
    if (rows.length) this.events.changed('jobs.sla');
    return rows.length;
  }

  async alertOfflineBots(): Promise<number> {
    const rows = await this.db.query(
      `SELECT id, last_heartbeat FROM oxide_bot_agents
       WHERE last_heartbeat IS NOT NULL AND last_heartbeat < now() - make_interval(secs => $1)`,
      [this.cfg.botHeartbeatTimeoutS],
    );
    let n = 0;
    for (const r of rows) {
      const created = await raiseAlert(this.db.pool, {
        kind: 'bot_offline',
        message: `${r.id} heartbeat timeout (last seen ${new Date(r.last_heartbeat).toISOString()})`,
        botId: r.id,
        dedupeKey: `bot_offline:${r.id}:${new Date(r.last_heartbeat).getTime()}`,
      });
      if (created) n++;
    }
    if (n) this.events.changed('jobs.bot_offline');
    return n;
  }

  async syncSimulator(): Promise<void> {
    try {
      await this.bots.applySimulator(await this.simulator.listBots());
      if (this.simulatorDown) this.log.log('simulator reachable again');
      this.simulatorDown = false;
      this.events.changed('simulator.sync');
    } catch (err) {
      if (!this.simulatorDown) {
        this.log.error({ msg: 'simulator unreachable', err: (err as Error).message });
        await raiseAlert(this.db.pool, {
          kind: 'simulator_down',
          message: `Bot Simulator unreachable: ${(err as Error).message}`,
          dedupeKey: `simulator_down:${new Date().toISOString().slice(0, 16)}`,
        }).catch(() => undefined);
      }
      this.simulatorDown = true;
    }
  }

  onModuleDestroy(): void {
    this.timers.forEach(clearInterval);
  }
}
