import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { audit } from '../common/audit';
import { AppError, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { backoffSeconds } from '../orders/retry-policy';
import { EventsService } from '../realtime/events.service';
import { BotsService } from './bots.service';
import { SimulatorClient, SimulatorError } from './simulator.client';

export const BOT_COMMANDS = ['start', 'stop', 'restart', 'status'] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];

const MAX_COMMAND_ATTEMPTS = 3;
const COMMAND_RETRY_BASE_S = 2;
/** คำสั่งที่ค้าง running นานเกินนี้ถือว่า process ตายกลางทาง → คืนเข้าคิว */
const STUCK_RUNNING_S = 60;

const isUniqueViolation = (err: any, index: string) => err?.code === '23505' && err?.constraint === index;

@Injectable()
export class CommandsService {
  private readonly log = new Logger('Commands');

  constructor(
    private readonly db: DbService,
    private readonly bots: BotsService,
    private readonly simulator: SimulatorClient,
    private readonly events: EventsService,
  ) {}

  /**
   * บันทึกคำสั่งลงคิวก่อน (queued) แล้ว executor ค่อยส่งให้ simulator
   * - Idempotency-Key เดิม → ได้คำสั่งเดิม (กดปุ่มซ้ำ / network retry ไม่สั่งซ้ำ)
   * - เครื่องหนึ่งมีคำสั่งค้างได้ทีละ 1 (unique index) → กด start กับ stop พร้อมกันได้ 409
   */
  async request(botId: string, command: BotCommand, actor: string, idempotencyKey?: string): Promise<{ command: any; created: boolean }> {
    if (!(await this.bots.exists(botId))) throw notFound('Bot');
    if (idempotencyKey) {
      const existing = await this.db.one('SELECT * FROM oxide_bot_commands WHERE idempotency_key = $1', [idempotencyKey]);
      if (existing) return this.sameRequest(existing, botId, command);
    }
    try {
      const created = await this.db.tx(async (db) => {
        const row = (
          await db.query(
            `INSERT INTO oxide_bot_commands (bot_id, command, requested_by, idempotency_key)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [botId, command, actor, idempotencyKey ?? null],
          )
        ).rows[0];
        await audit(db, actor, `bot.command.${command}`, 'bot', botId, { command_id: row.id });
        return row;
      });
      this.events.changed('command.queued');
      return { command: created, created: true };
    } catch (err) {
      if (isUniqueViolation(err, 'uq_commands_idem')) {
        // อีก request ที่ใช้ key เดียวกัน insert ไปก่อนเสี้ยววินาที
        const existing = await this.db.one('SELECT * FROM oxide_bot_commands WHERE idempotency_key = $1', [idempotencyKey]);
        return this.sameRequest(existing, botId, command);
      }
      if (isUniqueViolation(err, 'uq_commands_inflight')) {
        const inflight = await this.db.one(
          `SELECT id, command, status FROM oxide_bot_commands WHERE bot_id = $1 AND status IN ('queued','running')`,
          [botId],
        );
        throw new AppError(HttpStatus.CONFLICT, 'COMMAND_IN_PROGRESS', 'Bot already has a pending command', inflight);
      }
      throw err;
    }
  }

  private sameRequest(existing: any, botId: string, command: string) {
    if (existing.bot_id !== botId || existing.command !== command) {
      throw new AppError(HttpStatus.CONFLICT, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key already used for a different command');
    }
    return { command: existing, created: false };
  }

  async get(id: string): Promise<any> {
    const c = await this.db.one('SELECT * FROM oxide_bot_commands WHERE id = $1', [id]);
    if (!c) throw notFound('Command');
    return c;
  }

  /**
   * executor (เรียกจาก job ทุกรอบ): หยิบคำสั่ง queued ด้วย SKIP LOCKED แล้ว mark running ก่อนเรียก HTTP
   * จึงรันหลาย instance พร้อมกันได้โดยไม่ส่งคำสั่งซ้ำ
   */
  async runPending(limit = 10): Promise<number> {
    await this.db.query(
      `UPDATE oxide_bot_commands SET status = 'queued', next_attempt_at = now()
       WHERE status = 'running' AND next_attempt_at < now() - make_interval(secs => $1)`,
      [STUCK_RUNNING_S],
    );
    const batch = await this.db.tx(async (db) =>
      (
        await db.query(
          `UPDATE oxide_bot_commands SET status = 'running', attempts = attempts + 1, next_attempt_at = now()
           WHERE id IN (SELECT id FROM oxide_bot_commands WHERE status = 'queued' AND next_attempt_at <= now()
                        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1)
           RETURNING *`,
          [limit],
        )
      ).rows,
    );
    for (const cmd of batch) await this.execute(cmd);
    if (batch.length) this.events.changed('command.executed');
    return batch.length;
  }

  private async execute(cmd: any): Promise<void> {
    try {
      const res = await this.simulator.sendCommand(cmd.bot_id, cmd.command);
      await this.db.tx(async (db) => {
        await db.query(
          `UPDATE oxide_bot_commands SET status = 'success', result = $2, completed_at = now() WHERE id = $1 AND status = 'running'`,
          [cmd.id, res],
        );
        if (res.bot) {
          await db.query(
            `UPDATE oxide_bot_agents SET status = $2, cpu_percent = $3, memory_percent = $4, uptime_seconds = $5, updated_at = now()
             WHERE id = $1`,
            [cmd.bot_id, res.bot.status, res.bot.cpuPercent, res.bot.memoryPercent, res.bot.uptimeSeconds],
          );
        }
      });
      this.log.log({ command_id: cmd.id, bot: cmd.bot_id, command: cmd.command, msg: 'success' });
    } catch (err) {
      const e = err as SimulatorError;
      const retry = e.retryable !== false && cmd.attempts < MAX_COMMAND_ATTEMPTS;
      await this.db.query(
        retry
          ? `UPDATE oxide_bot_commands SET status = 'queued', result = $2,
               next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`
          : `UPDATE oxide_bot_commands SET status = 'failed', result = $2, completed_at = now() WHERE id = $1`,
        retry
          ? [cmd.id, { error: e.message, attempt: cmd.attempts }, backoffSeconds(cmd.attempts, COMMAND_RETRY_BASE_S)]
          : [cmd.id, { error: e.message, attempt: cmd.attempts }],
      );
      this.log.warn({ command_id: cmd.id, bot: cmd.bot_id, error: e.message, retry });
    }
  }
}
