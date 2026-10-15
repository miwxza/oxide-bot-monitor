import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { raiseAlert } from '../common/audit';
import { safeEqual } from '../common/auth';
import { AppError } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { addEvent, transition } from '../orders/state-machine';
import { EventsService } from '../realtime/events.service';

export interface PaymentWebhook {
  event_id: string;
  external_order_id: string;
  transaction_id: string;
  amount: number;
  paid_at: string;
}

export type WebhookOutcome =
  | 'paid'
  | 'duplicate_event'
  | 'already_paid'
  | 'unknown_order'
  | 'amount_mismatch'
  | 'transaction_reused'
  | 'paid_after_expiry'
  | 'unexpected_state';

export function signPayload(rawBody: Buffer | string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

@Injectable()
export class WebhooksService {
  private readonly log = new Logger('Webhook');

  constructor(
    private readonly db: DbService,
    private readonly events: EventsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  verifySignature(rawBody: Buffer | undefined, header: string | undefined): void {
    if (!rawBody || !header || !safeEqual(signPayload(rawBody, this.cfg.webhookSecret), header)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
    }
  }

  /**
   * ทุกอย่างใน transaction เดียว: บันทึก event_id + เปลี่ยนสถานะ
   * event_id ซ้ำ → ไม่ทำอะไร, transaction_id ซ้ำ → unique index กันเงินก้อนเดียวจ่ายสองออเดอร์
   * ตัดสินว่า "จ่ายทันไหม" จาก paid_at ของธนาคาร ไม่ใช่เวลาที่ webhook มาถึง
   */
  async handlePayment(p: PaymentWebhook): Promise<{ outcome: WebhookOutcome; status?: string }> {
    const result = await this.db.tx(async (db) => {
      const fresh = await db.query(
        `INSERT INTO webhook_events (event_id, outcome, payload) VALUES ($1, 'processing', $2)
         ON CONFLICT (event_id) DO NOTHING`,
        [p.event_id, p],
      );
      if (!fresh.rowCount) return { outcome: 'duplicate_event' as const };

      const order = (await db.query('SELECT * FROM orders WHERE external_order_id = $1 FOR UPDATE', [p.external_order_id]))
        .rows[0];
      const finish = async (outcome: WebhookOutcome, status?: string) => {
        await db.query('UPDATE webhook_events SET outcome = $2, order_id = $3 WHERE event_id = $1', [
          p.event_id,
          outcome,
          order?.id ?? null,
        ]);
        return { outcome, status };
      };

      if (!order) {
        await raiseAlert(db, {
          kind: 'webhook_unknown_order',
          message: `Payment ${p.transaction_id} for unknown order ${p.external_order_id}`,
          dedupeKey: `webhook_unknown_order:${p.transaction_id}`,
        });
        return finish('unknown_order');
      }
      if (order.payment_txn_id === p.transaction_id) return finish('already_paid', order.status);

      if (Number(order.amount).toFixed(2) !== Number(p.amount).toFixed(2)) {
        await raiseAlert(db, {
          kind: 'amount_mismatch',
          message: `Paid ${p.amount} but order ${order.external_order_id} is ${order.amount}`,
          orderId: order.id,
          dedupeKey: `amount_mismatch:${p.transaction_id}`,
        });
        await addEvent(db, order.id, 'payment_rejected', { reason: 'amount_mismatch', ...p });
        return finish('amount_mismatch', order.status);
      }

      const reused = await db.query('SELECT external_order_id FROM orders WHERE payment_txn_id = $1', [p.transaction_id]);
      if (reused.rowCount) {
        await raiseAlert(db, {
          kind: 'transaction_reused',
          message: `Transaction ${p.transaction_id} already paid ${reused.rows[0].external_order_id}`,
          orderId: order.id,
          dedupeKey: `transaction_reused:${p.transaction_id}:${order.id}`,
        });
        return finish('transaction_reused', order.status);
      }

      if (order.payment_txn_id) {
        // ออเดอร์นี้จ่ายด้วยเงินก้อนอื่นไปแล้ว = ลูกค้าจ่ายซ้ำ
        await raiseAlert(db, {
          kind: 'double_payment',
          message: `Order ${order.external_order_id} paid twice (${order.payment_txn_id}, ${p.transaction_id}) — refund one`,
          orderId: order.id,
          dedupeKey: `double_payment:${p.transaction_id}`,
          severity: 'critical',
        });
        return finish('unexpected_state', order.status);
      }

      const paidAt = new Date(p.paid_at);
      const set = { paid_at: paidAt, payment_txn_id: p.transaction_id };
      if (paidAt > new Date(order.payment_expires_at)) {
        // จ่ายหลังหมดเวลา: ไม่เติมเกม ให้แอดมินคืนเงิน
        if (order.status === 'PENDING_PAYMENT') {
          await transition(db, order.id, 'PENDING_PAYMENT', 'EXPIRED', { reason: 'paid_after_expiry', actor: 'bank', set });
        } else {
          await db.query('UPDATE orders SET paid_at = $2, payment_txn_id = $3 WHERE id = $1', [order.id, paidAt, p.transaction_id]);
        }
        await raiseAlert(db, {
          kind: 'paid_after_expiry',
          message: `Order ${order.external_order_id} paid after expiry — refund required`,
          orderId: order.id,
          dedupeKey: `paid_after_expiry:${p.transaction_id}`,
        });
        return finish('paid_after_expiry', 'EXPIRED');
      }

      if (order.status !== 'PENDING_PAYMENT' && order.status !== 'EXPIRED') {
        await raiseAlert(db, {
          kind: 'payment_unexpected_state',
          message: `Payment for ${order.external_order_id} in state ${order.status}`,
          orderId: order.id,
          dedupeKey: `payment_unexpected_state:${p.transaction_id}`,
        });
        return finish('unexpected_state', order.status);
      }
      // EXPIRED → QUEUED: จ่ายทันเวลาแต่ webhook มาช้ากว่า job หมดอายุ
      await transition(db, order.id, order.status, 'QUEUED', {
        reason: order.status === 'EXPIRED' ? 'late_webhook_paid_in_time' : 'payment_confirmed',
        actor: 'bank',
        data: { transaction_id: p.transaction_id },
        set: { ...set, next_attempt_at: new Date() },
      });
      return finish('paid', 'QUEUED');
    });

    this.log.log({ event_id: p.event_id, order: p.external_order_id, outcome: result.outcome });
    if (result.outcome === 'paid') this.events.toAgent('*', { type: 'wake' });
    this.events.changed('webhook');
    return result;
  }
}
