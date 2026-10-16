import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { raiseAlert } from '../common/audit';
import { AppError, notFound } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { decideRetry } from '../orders/retry-policy';
import { addEvent, transition } from '../orders/state-machine';
import { EventsService } from '../realtime/events.service';
import { SystemService } from '../system/system.service';

export interface ClaimedJob {
  external_order_id: string;
  player_uid: string;
  package_code: string;
  amount: string;
  lease_token: string;
  lease_expires_at: string;
  attempt: number;
  /** คงที่ทุก attempt — ส่งให้ provider เพื่อไม่ให้เติมซ้ำเมื่อ retry */
  topup_key: string;
}

export const topupKey = (orderId: string | number) => `topup-${orderId}`;

@Injectable()
export class WorkService {
  private readonly log = new Logger('Work');

  constructor(
    private readonly db: DbService,
    private readonly events: EventsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * bot ของาน 1 ชิ้น
   * - kill-switch อ่านด้วย FOR SHARE ใน transaction เดียวกัน
   * - เครื่องต้องมี heartbeat สด และ process (จาก simulator) เป็น online
   * - เครื่องหนึ่งทำได้ทีละออเดอร์: ล็อกแถวบอทด้วย FOR UPDATE ให้ claim ของเครื่องเดียวกันเข้าคิวกัน
   *   (FOR SHARE ถือพร้อมกันได้ → claim ที่ยิงพร้อมกันผ่านเช็ก BOT_BUSY ทั้งหมด) + unique index เป็นด่านสุดท้าย
   * - เลือกออเดอร์ด้วย FOR UPDATE SKIP LOCKED: bot หลายตัวขอพร้อมกันได้คนละออเดอร์ ไม่มีใครได้ซ้ำ
   */
  async claim(botId: string): Promise<ClaimedJob | null> {
    const job = await this.db.tx(async (db) => this.claimIn(db, botId)).catch((err) => {
      if (err?.code === '23505' && err?.constraint === 'uq_orders_one_in_progress_per_bot') {
        throw new AppError(HttpStatus.CONFLICT, 'BOT_BUSY', 'Bot already has an order in progress');
      }
      throw err;
    });
    if (job) {
      this.log.log({ bot: botId, order: job.external_order_id, attempt: job.attempt, msg: 'claimed' });
      this.events.changed('order.claimed');
    }
    return job;
  }

  private async claimIn(db: PoolClient, botId: string): Promise<ClaimedJob | null> {
    if (!(await SystemService.isAcceptingForUpdate(db))) {
      throw new AppError(HttpStatus.CONFLICT, 'SYSTEM_PAUSED', 'Kill-switch is on: not accepting new orders');
    }
    const bot = (
      await db.query(
        `SELECT id, status, last_heartbeat > now() - make_interval(secs => $2) AS heartbeat_ok
         FROM oxide_bot_agents WHERE id = $1 FOR UPDATE`,
        [botId, this.cfg.botHeartbeatTimeoutS],
      )
    ).rows[0];
    if (!bot) throw notFound('Bot');
    if (!bot.heartbeat_ok || bot.status !== 'online') {
      throw new AppError(HttpStatus.CONFLICT, 'BOT_NOT_READY', `Bot is not ready (status=${bot.status}, heartbeat_ok=${bot.heartbeat_ok})`);
    }
    const busy = await db.query(`SELECT 1 FROM orders WHERE assigned_bot_id = $1 AND status = 'IN_PROGRESS'`, [botId]);
    if (busy.rowCount) throw new AppError(HttpStatus.CONFLICT, 'BOT_BUSY', 'Bot already has an order in progress');

    const pick = (
      await db.query(
        `SELECT id, attempts FROM orders
         WHERE status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY next_attempt_at NULLS FIRST, id
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
    ).rows[0];
    if (!pick) return null;

    const o = await transition(db, pick.id, 'QUEUED', 'IN_PROGRESS', {
      reason: 'claimed',
      actor: botId,
      data: { bot_id: botId },
      set: {
        assigned_bot_id: botId,
        lease_token: randomUUID(),
        lease_expires_at: new Date(Date.now() + this.cfg.orderLeaseS * 1000),
        attempts: pick.attempts + 1,
      },
    });
    return {
      external_order_id: o.external_order_id,
      player_uid: o.player_uid,
      package_code: o.package_code,
      amount: o.amount,
      lease_token: o.lease_token,
      lease_expires_at: o.lease_expires_at,
      attempt: o.attempts,
      topup_key: topupKey(o.id),
    } satisfies ClaimedJob;
  }

  /** ต่ออายุ lease ระหว่างทำงาน — lease หาย (ถูกคืนเข้าคิวแล้ว) → 409 ให้ bot หยุดทันที */
  async extendLease(botId: string, externalId: string, token: string): Promise<{ lease_expires_at: string }> {
    const r = await this.db.one(
      `UPDATE orders SET lease_expires_at = now() + make_interval(secs => $4)
       WHERE external_order_id = $1 AND lease_token = $2 AND assigned_bot_id = $3 AND status = 'IN_PROGRESS'
       RETURNING lease_expires_at`,
      [externalId, token, botId, this.cfg.orderLeaseS],
    );
    if (!r) throw leaseLost();
    return r;
  }

  /**
   * จบงาน: ต้องถือ lease และต้องมีหลักฐานการเติมที่ provider (provider_topups)
   * เรียกซ้ำด้วย token เดิมหลังสำเร็จแล้ว → ตอบผลเดิม (idempotent)
   */
  async complete(botId: string, externalId: string, token: string, botVersion?: string): Promise<any> {
    const result = await this.db.tx(async (db) => {
      const o = await this.lockOwned(db, externalId);
      if (o.status === 'COMPLETED' && o.lease_token === token && o.assigned_bot_id === botId) {
        return { external_order_id: o.external_order_id, status: o.status, duplicate: true };
      }
      this.assertLease(o, botId, token);
      const topup = await db.query('SELECT 1 FROM provider_topups WHERE topup_key = $1', [topupKey(o.id)]);
      if (!topup.rowCount) {
        throw new AppError(HttpStatus.CONFLICT, 'TOPUP_NOT_FOUND', 'No provider top-up recorded for this order');
      }
      // lease_token เก็บไว้เพื่อให้ complete ซ้ำ (เช่น response หาย) ได้ผลเดิม
      await transition(db, o.id, 'IN_PROGRESS', 'COMPLETED', {
        reason: 'topup_succeeded',
        actor: botId,
        data: { bot_id: botId, attempt: o.attempts, ...(botVersion ? { bot_version: botVersion } : {}) },
        set: { completed_at: new Date(), lease_expires_at: null },
      });
      return { external_order_id: o.external_order_id, status: 'COMPLETED', duplicate: false };
    });
    this.events.changed('order.completed');
    return result;
  }

  /** bot รายงาน error → server ตัดสินตาม retry policy */
  async fail(botId: string, externalId: string, token: string, code: string, message?: string): Promise<any> {
    const result = await this.db.tx(async (db) => {
      const o = await this.lockOwned(db, externalId);
      this.assertLease(o, botId, token);
      return this.applyFailure(db, o, code, message ?? code, botId);
    });
    if (result.status === 'QUEUED') this.events.toAgent('*', { type: 'wake' });
    this.events.changed('order.failed');
    return result;
  }

  /** ใช้ร่วมกับ job ตรวจ heartbeat timeout */
  async applyFailure(db: PoolClient, o: any, code: string, message: string, actor: string): Promise<any> {
    const decision = decideRetry(code, o.attempts, this.cfg.maxAttempts, this.cfg.retryBaseS);
    const base = {
      last_error_code: code,
      last_error_message: message,
      lease_token: null,
      lease_expires_at: null,
    };
    const data = { bot_id: o.assigned_bot_id, code, attempt: o.attempts };
    if (decision.action === 'retry') {
      await transition(db, o.id, 'IN_PROGRESS', 'QUEUED', {
        reason: 'retry_scheduled',
        actor,
        data: { ...data, retry_in_s: decision.delayS },
        set: { ...base, next_attempt_at: new Date(Date.now() + decision.delayS * 1000) },
      });
      return { external_order_id: o.external_order_id, status: 'QUEUED', retry_in_s: decision.delayS };
    }
    const to = decision.action === 'fail' ? 'FAILED' : 'DELAYED';
    await transition(db, o.id, 'IN_PROGRESS', to, { reason: code, actor, data, set: base });
    if (to === 'DELAYED') {
      await raiseAlert(db, {
        kind: 'order_delayed',
        message: `Order ${o.external_order_id} DELAYED after ${o.attempts} attempt(s): ${code}`,
        orderId: o.id,
        botId: o.assigned_bot_id,
        dedupeKey: `order_delayed:${o.id}:${o.version}`,
      });
    }
    return { external_order_id: o.external_order_id, status: to };
  }

  /** provider จำลอง: topup_key เดิมซ้ำ = ไม่เติมซ้ำ (duplicate: true) */
  async providerTopup(botId: string, topupKeyValue: string, externalId: string): Promise<{ duplicate: boolean }> {
    const o = await this.db.one('SELECT id FROM orders WHERE external_order_id = $1', [externalId]);
    if (!o || topupKey(o.id) !== topupKeyValue) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TOPUP_KEY', 'topup_key does not match order');
    const r = await this.db.query(
      `INSERT INTO provider_topups (topup_key, order_id, bot_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1`,
      [topupKeyValue, o.id, botId],
    );
    if (!r.length) await addEvent(this.db.pool, o.id, 'provider_duplicate_topup_prevented', { bot_id: botId });
    return { duplicate: r.length === 0 };
  }

  private async lockOwned(db: PoolClient, externalId: string): Promise<any> {
    const o = (await db.query('SELECT * FROM orders WHERE external_order_id = $1 FOR UPDATE', [externalId])).rows[0];
    if (!o) throw notFound('Order');
    return o;
  }

  private assertLease(o: any, botId: string, token: string): void {
    if (o.status !== 'IN_PROGRESS' || o.lease_token !== token || o.assigned_bot_id !== botId) throw leaseLost();
  }
}

const leaseLost = () =>
  new AppError(HttpStatus.CONFLICT, 'LEASE_LOST', 'Lease is no longer valid (order was reassigned or finished)');
