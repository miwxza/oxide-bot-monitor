import { HttpStatus } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppError } from '../common/errors';

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'QUEUED',
  'IN_PROGRESS',
  'COMPLETED',
  'DELAYED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * เส้นทางที่อนุญาต — ทุกการเปลี่ยนสถานะต้องผ่าน transition() ซึ่งตรวจตารางนี้
 *
 * เส้นทางปกติ: PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED
 */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['QUEUED', 'EXPIRED', 'CANCELLED'],
  // QUEUED → DELAYED: ค้างในคิวเกินเวลาแล้วแอดมินพักไว้ตรวจ
  QUEUED: ['IN_PROGRESS', 'DELAYED', 'CANCELLED'],
  IN_PROGRESS: [
    'COMPLETED',
    'QUEUED', // เครื่องหลุด / error ชั่วคราว และยังมี attempt เหลือ
    'DELAYED', // ใช้ attempt ครบ หรือผลไม่แน่นอน → ให้แอดมินตรวจ
    'FAILED', // error ถาวร เช่น UID ผิด
  ],
  DELAYED: ['QUEUED', 'COMPLETED', 'FAILED'], // แอดมินตัดสินใจ
  FAILED: ['QUEUED'], // แก้ข้อมูลแล้วลองใหม่
  EXPIRED: ['QUEUED'], // จ่ายทันเวลาแต่ webhook มาช้า
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL: readonly OrderStatus[] = ['COMPLETED', 'CANCELLED'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionOptions {
  reason: string;
  actor: string;
  data?: Record<string, unknown>;
  /** คอลัมน์อื่นที่ต้องอัปเดตพร้อมกัน (ชื่อคอลัมน์มาจากโค้ด ไม่ใช่ input ผู้ใช้) */
  set?: Record<string, unknown>;
}

/**
 * เปลี่ยนสถานะ + บันทึก order_events ใน transaction เดียวกัน
 * ใช้ WHERE status = from (optimistic) — ถ้ามีคนเปลี่ยนไปก่อนจะได้ 409 แทนการเขียนทับ
 */
export async function transition(
  db: PoolClient,
  orderId: string | number,
  from: OrderStatus,
  to: OrderStatus,
  opts: TransitionOptions,
): Promise<any> {
  if (!canTransition(from, to)) {
    throw new AppError(HttpStatus.CONFLICT, 'INVALID_TRANSITION', `Cannot move order from ${from} to ${to}`, {
      from,
      to,
    });
  }
  const set = opts.set ?? {};
  const cols = Object.keys(set);
  const assignments = cols.map((c, i) => `${c} = $${i + 4}`);
  const sql = `UPDATE orders SET status = $3, version = version + 1, updated_at = now()
               ${assignments.length ? ', ' + assignments.join(', ') : ''}
               WHERE id = $1 AND status = $2 RETURNING *`;
  const res = await db.query(sql, [orderId, from, to, ...cols.map((c) => set[c])]);
  if (!res.rowCount) {
    throw new AppError(HttpStatus.CONFLICT, 'STALE_ORDER_STATE', `Order is no longer ${from}`);
  }
  await db.query(
    `INSERT INTO order_events (order_id, event_type, payload) VALUES ($1, 'status_changed', $2)`,
    [orderId, { from, to, reason: opts.reason, actor: opts.actor, ...(opts.data ?? {}) }],
  );
  return res.rows[0];
}

export async function addEvent(db: Pick<PoolClient, 'query'>, orderId: string | number, type: string, payload: object) {
  await db.query(`INSERT INTO order_events (order_id, event_type, payload) VALUES ($1, $2, $3)`, [
    orderId,
    type,
    payload,
  ]);
}
