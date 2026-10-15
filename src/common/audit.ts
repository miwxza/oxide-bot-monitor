import type { Db } from '../db/db.service';

export async function audit(
  db: Db,
  actor: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, targetType, targetId, metadata],
  );
}

/** แจ้งแอดมิน — dedupe_key เดิมจะไม่สร้างซ้ำ (job รันซ้ำได้) */
export async function raiseAlert(
  db: Db,
  a: { kind: string; message: string; dedupeKey: string; orderId?: string | number; botId?: string; severity?: string },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO alerts (kind, severity, message, order_id, bot_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [a.kind, a.severity ?? 'warning', a.message, a.orderId ?? null, a.botId ?? null, a.dedupeKey],
  );
  return (r.rowCount ?? 0) > 0;
}
