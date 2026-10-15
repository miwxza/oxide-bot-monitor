import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { audit } from '../common/audit';
import { AppError, notFound } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { EventsService } from '../realtime/events.service';
import { addEvent, ORDER_STATUSES, OrderStatus, transition } from './state-machine';

export interface CreateOrderInput {
  external_order_id: string;
  player_uid: string;
  package_code: string;
  amount: number;
  currency: string;
}

const PUBLIC_COLUMNS = `id, external_order_id, status, amount, currency, player_uid, package_code,
  payment_expires_at, paid_at, assigned_bot_id, attempts, next_attempt_at, last_error_code,
  last_error_message, completed_at, created_at, updated_at`;

/** ตัดคอลัมน์ภายใน (lease_token ฯลฯ) ออกก่อนตอบ API */
export function publicOrder(o: any): any {
  if (!o) return o;
  const { lease_token, request_hash, lease_expires_at, version, ...rest } = o;
  return rest;
}

export function requestHash(i: Omit<CreateOrderInput, 'external_order_id'>): string {
  const canonical = JSON.stringify([i.player_uid, i.package_code, Number(i.amount).toFixed(2), i.currency]);
  return createHash('sha256').update(canonical).digest('hex');
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly events: EventsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * external_order_id (เลขออเดอร์ของร้าน) เป็น idempotency key ตามธรรมชาติ
   * - ส่งซ้ำข้อมูลเดิม → ได้ออเดอร์เดิม (created=false)
   * - ส่งซ้ำแต่ข้อมูลต่าง → 409 IDEMPOTENCY_MISMATCH
   * INSERT ... ON CONFLICT ทำให้ request ที่ยิงพร้อมกันได้ออเดอร์เดียว
   */
  async create(input: CreateOrderInput): Promise<{ order: any; created: boolean }> {
    const hash = requestHash(input);
    return this.db.tx(async (db) => {
      const inserted = await db.query(
        `INSERT INTO orders (external_order_id, status, amount, currency, player_uid, package_code, request_hash,
                             payment_expires_at)
         VALUES ($1, 'PENDING_PAYMENT', $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
         ON CONFLICT (external_order_id) DO NOTHING
         RETURNING ${PUBLIC_COLUMNS}`,
        [input.external_order_id, input.amount, input.currency, input.player_uid, input.package_code, hash, this.cfg.paymentWindowS],
      );
      if (inserted.rowCount) {
        const order = inserted.rows[0];
        await addEvent(db, order.id, 'created', { status: 'PENDING_PAYMENT' });
        this.events.changed('order.created');
        return { order, created: true };
      }
      const existing = (
        await db.query(`SELECT ${PUBLIC_COLUMNS}, request_hash FROM orders WHERE external_order_id = $1`, [
          input.external_order_id,
        ])
      ).rows[0];
      if (existing.request_hash !== hash) {
        throw new AppError(
          HttpStatus.CONFLICT,
          'IDEMPOTENCY_MISMATCH',
          'external_order_id already used with different order data',
        );
      }
      delete existing.request_hash;
      return { order: existing, created: false };
    });
  }

  async get(externalId: string): Promise<any> {
    const order = await this.db.one(`SELECT ${PUBLIC_COLUMNS} FROM orders WHERE external_order_id = $1`, [externalId]);
    if (!order) throw notFound('Order');
    return order;
  }

  async timeline(externalId: string): Promise<any[]> {
    const order = await this.get(externalId);
    return this.db.query(
      `SELECT id, event_type, payload, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at, id`,
      [order.id],
    );
  }

  async list(status: string | undefined, limit: number): Promise<any[]> {
    if (status && !ORDER_STATUSES.includes(status as OrderStatus)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_STATUS', `status must be one of ${ORDER_STATUSES.join(', ')}`);
    }
    return this.db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM orders WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [status ?? null, limit],
    );
  }

  /** แอดมิน: เอาออเดอร์ DELAYED / FAILED / EXPIRED(จ่ายแล้ว) กลับเข้าคิว — รีเซ็ตจำนวน attempt */
  async requeue(externalId: string, actor: string, note?: string): Promise<any> {
    const order = await this.db.tx(async (db) => {
      const o = await this.lock(db, externalId);
      if (o.status === 'EXPIRED' && !o.paid_at) {
        throw new AppError(HttpStatus.CONFLICT, 'NOT_PAID', 'Expired order has no payment to process');
      }
      const updated = await transition(db, o.id, o.status, 'QUEUED', {
        reason: 'admin_requeue',
        actor,
        data: { note },
        set: { attempts: 0, next_attempt_at: new Date(), last_error_code: null, last_error_message: null },
      });
      await audit(db, actor, 'order.requeue', 'order', externalId, { from: o.status, note });
      return updated;
    });
    this.events.toAgent('*', { type: 'wake' });
    this.events.changed('order.requeue');
    return order;
  }

  /** แอดมิน: ตัดสินออเดอร์ DELAYED หลังตรวจกับ provider แล้ว */
  async resolve(externalId: string, outcome: 'COMPLETED' | 'FAILED', actor: string, note?: string): Promise<any> {
    const order = await this.db.tx(async (db) => {
      const o = await this.lock(db, externalId);
      if (o.status !== 'DELAYED') {
        throw new AppError(HttpStatus.CONFLICT, 'INVALID_TRANSITION', 'Only DELAYED orders can be resolved');
      }
      const updated = await transition(db, o.id, 'DELAYED', outcome, {
        reason: 'admin_resolve',
        actor,
        data: { note },
        set: outcome === 'COMPLETED' ? { completed_at: new Date() } : {},
      });
      await audit(db, actor, 'order.resolve', 'order', externalId, { outcome, note });
      return updated;
    });
    this.events.changed('order.resolve');
    return order;
  }

  async cancel(externalId: string, actor: string): Promise<any> {
    const order = await this.db.tx(async (db) => {
      const o = await this.lock(db, externalId);
      if (o.status === 'QUEUED' && o.paid_at) {
        throw new AppError(HttpStatus.CONFLICT, 'ORDER_PAID', 'Paid order cannot be cancelled here; refund flow required');
      }
      const updated = await transition(db, o.id, o.status, 'CANCELLED', { reason: 'admin_cancel', actor });
      await audit(db, actor, 'order.cancel', 'order', externalId, {});
      return updated;
    });
    this.events.changed('order.cancel');
    return order;
  }

  private async lock(db: any, externalId: string): Promise<any> {
    const o = (await db.query('SELECT * FROM orders WHERE external_order_id = $1 FOR UPDATE', [externalId])).rows[0];
    if (!o) throw notFound('Order');
    return o;
  }
}
