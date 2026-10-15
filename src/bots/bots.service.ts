import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../common/errors';
import { AppConfig, CONFIG } from '../config';
import { DbService } from '../db/db.service';
import { EventsService } from '../realtime/events.service';
import { SimulatorBot } from './simulator.client';

/**
 * สถานะที่ dashboard แสดง (คำนวณตอนอ่าน ไม่เก็บซ้ำ)
 * - offline      : heartbeat ของ agent ขาดเกิน BOT_HEARTBEAT_TIMEOUT_S (เครื่องหลุด/ล่ม)
 * - in_progress  : กำลังทำออเดอร์
 * - active       : เครื่องออนไลน์ + bot process เปิด + ระบบเปิดรับงาน → รับงานได้
 * - standby      : เครื่องออนไลน์ แต่ bot ปิดอยู่ / กำลังเปิด-ปิด / ระบบถูก kill-switch
 */
export type BotState = 'offline' | 'in_progress' | 'active' | 'standby';

export interface BotView {
  id: string;
  name: string;
  device_name: string;
  host: string | null;
  process_status: string;
  state: BotState;
  heartbeat_ok: boolean;
  last_heartbeat: string | null;
  heartbeat_age_s: number | null;
  agent_connected: boolean;
  cpu_percent: string;
  memory_percent: string;
  uptime_seconds: string;
  code_version: string | null;
  current_order: string | null;
  last_job: { external_order_id: string; result: string; at: string; code?: string } | null;
}

export function deriveState(b: { heartbeat_ok: boolean; status: string; current_order: string | null }, accepting: boolean): BotState {
  if (!b.heartbeat_ok) return 'offline';
  if (b.current_order) return 'in_progress';
  if (b.status === 'online' && accepting) return 'active';
  return 'standby';
}

@Injectable()
export class BotsService {
  constructor(
    private readonly db: DbService,
    private readonly events: EventsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async list(): Promise<BotView[]> {
    const accepting = (await this.db.one('SELECT accepting_orders FROM system_settings WHERE id = 1'))!.accepting_orders;
    const rows = await this.db.query(
      `SELECT a.*,
         COALESCE(a.last_heartbeat > now() - make_interval(secs => $1), false) AS heartbeat_ok,
         EXTRACT(EPOCH FROM now() - a.last_heartbeat)::int AS heartbeat_age_s,
         (SELECT external_order_id FROM orders o WHERE o.assigned_bot_id = a.id AND o.status = 'IN_PROGRESS' LIMIT 1) AS current_order,
         (SELECT json_build_object('external_order_id', o.external_order_id, 'result', e.payload->>'to',
                                   'code', e.payload->>'code', 'at', e.created_at)
            FROM order_events e JOIN orders o ON o.id = e.order_id
           WHERE e.event_type = 'status_changed' AND e.payload->>'bot_id' = a.id
             AND e.payload->>'to' IN ('COMPLETED','FAILED','DELAYED','QUEUED')
           ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_job
       FROM oxide_bot_agents a ORDER BY a.id`,
      [this.cfg.botHeartbeatTimeoutS],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      device_name: r.device_name,
      host: r.host,
      process_status: r.status,
      state: deriveState(r, accepting),
      heartbeat_ok: r.heartbeat_ok,
      last_heartbeat: r.last_heartbeat,
      heartbeat_age_s: r.heartbeat_age_s,
      agent_connected: r.agent_connected,
      cpu_percent: r.cpu_percent,
      memory_percent: r.memory_percent,
      uptime_seconds: r.uptime_seconds,
      code_version: r.code_version,
      current_order: r.current_order,
      last_job: r.last_job,
    }));
  }

  static summarize(bots: BotView[]) {
    return {
      total: bots.length,
      online: bots.filter((b) => b.heartbeat_ok).length,
      active: bots.filter((b) => b.state === 'active').length,
      standby: bots.filter((b) => b.state === 'standby').length,
      in_progress: bots.filter((b) => b.state === 'in_progress').length,
      offline: bots.filter((b) => b.state === 'offline').length,
    };
  }

  /** รายละเอียดเครื่อง (ปุ่ม "รายละเอียด" / ดู Log & Metrics) */
  async detail(botId: string): Promise<any> {
    const bot = (await this.list()).find((b) => b.id === botId);
    if (!bot) throw notFound('Bot');
    const [commands, deployments, orders, logs] = await Promise.all([
      this.db.query(
        `SELECT id, command, requested_by, status, attempts, result, created_at, completed_at
         FROM oxide_bot_commands WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [botId],
      ),
      this.db.query(
        `SELECT d.id, d.status, d.attempts, d.error, d.requested_by, d.created_at, d.updated_at, p.filename, p.sha256
         FROM bot_deployments d JOIN code_packages p ON p.id = d.package_id
         WHERE d.bot_id = $1 ORDER BY d.created_at DESC LIMIT 20`,
        [botId],
      ),
      this.db.query(
        `SELECT o.external_order_id, e.payload->>'from' AS "from", e.payload->>'to' AS "to",
                e.payload->>'reason' AS reason, e.payload->>'code' AS code, e.created_at
         FROM order_events e JOIN orders o ON o.id = e.order_id
         WHERE e.event_type = 'status_changed' AND e.payload->>'bot_id' = $1
         ORDER BY e.created_at DESC, e.id DESC LIMIT 30`,
        [botId],
      ),
      this.db.query(
        `SELECT actor, action, metadata, created_at FROM audit_logs
         WHERE target_type = 'bot' AND target_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [botId],
      ),
    ]);
    return { bot, commands, deployments, order_history: orders, audit_logs: logs };
  }

  /** heartbeat จาก agent (WebSocket) */
  async heartbeat(botId: string, info: { host?: string; code_version?: string }): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE oxide_bot_agents SET last_heartbeat = now(), agent_connected = true, updated_at = now(),
         host = COALESCE($2, host), code_version = COALESCE($3, code_version)
       WHERE id = $1 RETURNING id`,
      [botId, info.host ?? null, info.code_version ?? null],
    );
    return r.length > 0;
  }

  async setConnected(botId: string, connected: boolean): Promise<void> {
    await this.db.query('UPDATE oxide_bot_agents SET agent_connected = $2, updated_at = now() WHERE id = $1', [botId, connected]);
    this.events.changed('agent.connection');
  }

  async exists(botId: string): Promise<boolean> {
    return !!(await this.db.one('SELECT 1 FROM oxide_bot_agents WHERE id = $1', [botId]));
  }

  /** sync metrics + process status จาก Bot Simulator */
  async applySimulator(bots: SimulatorBot[]): Promise<void> {
    for (const b of bots) {
      await this.db.query(
        `UPDATE oxide_bot_agents SET status = $2, cpu_percent = $3, memory_percent = $4, uptime_seconds = $5, updated_at = now()
         WHERE id = $1 AND (status, cpu_percent, memory_percent, uptime_seconds) IS DISTINCT FROM ($2, $3::numeric, $4::numeric, $5::bigint)`,
        [b.id, b.status, b.cpuPercent, b.memoryPercent, b.uptimeSeconds],
      );
    }
  }
}
