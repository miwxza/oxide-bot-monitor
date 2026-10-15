import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { audit } from '../common/audit';
import { DbService } from '../db/db.service';
import { EventsService } from '../realtime/events.service';

export interface SystemState {
  accepting_orders: boolean;
  changed_by: string | null;
  changed_at: string;
}

@Injectable()
export class SystemService {
  constructor(
    private readonly db: DbService,
    private readonly events: EventsService,
  ) {}

  async get(): Promise<SystemState> {
    return (await this.db.one<SystemState>('SELECT accepting_orders, changed_by, changed_at FROM system_settings WHERE id = 1'))!;
  }

  /**
   * Kill-switch: อัปเดตแถวเดียวด้วย row lock
   * claim งานอ่านแถวนี้ด้วย FOR SHARE ใน transaction เดียวกับการจองออเดอร์
   * → เมื่อ commit การปิดระบบแล้ว ไม่มี claim ไหนผ่านได้อีก (claim ที่ commit ก่อนหน้าถือว่าเริ่มไปแล้ว)
   */
  async setAccepting(accepting: boolean, actor: string): Promise<SystemState> {
    const state = await this.db.tx(async (db) => {
      const prev = await db.query('SELECT accepting_orders FROM system_settings WHERE id = 1 FOR UPDATE');
      const row = (
        await db.query(
          `UPDATE system_settings SET accepting_orders = $1, changed_by = $2, changed_at = now()
           WHERE id = 1 RETURNING accepting_orders, changed_by, changed_at`,
          [accepting, actor],
        )
      ).rows[0];
      if (prev.rows[0].accepting_orders !== accepting) {
        await audit(db, actor, accepting ? 'system.resume' : 'system.kill_switch', 'system', null, {});
      }
      return row as SystemState;
    });
    this.events.toAgent('*', { type: 'system', acceptingOrders: state.accepting_orders });
    this.events.changed('system');
    return state;
  }

  /** ใช้ใน transaction ของ claim — FOR SHARE ให้รอถ้ามีคนกำลังกด kill-switch */
  static async isAcceptingForUpdate(db: PoolClient): Promise<boolean> {
    const r = await db.query('SELECT accepting_orders FROM system_settings WHERE id = 1 FOR SHARE');
    return r.rows[0].accepting_orders;
  }
}
