import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { audit } from '../common/audit';
import { AppError, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { EventsService } from '../realtime/events.service';

export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_DEPLOY_ATTEMPTS = 3;
/** ส่งไปแล้วแต่ agent ไม่ตอบภายในเวลานี้ → ส่งใหม่ */
const ACK_TIMEOUT_S = 60;

export const shortVersion = (sha256: string) => sha256.slice(0, 12);

const PACKAGE_COLUMNS = 'id, filename, sha256, size_bytes, uploaded_by, created_at';

@Injectable()
export class DeployService {
  private readonly log = new Logger('Deploy');

  constructor(
    private readonly db: DbService,
    private readonly events: EventsService,
  ) {}

  /** เก็บไฟล์ zip — ไฟล์เดียวกัน (sha256 เดิม) อัปโหลดซ้ำได้ package เดิม */
  async upload(filename: string, content: Buffer, actor: string): Promise<{ package: any; created: boolean }> {
    if (!content?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_FILE', 'File is empty');
    if (content.length > MAX_PACKAGE_BYTES) throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', 'Max 20 MB');
    // zip ขึ้นต้นด้วย "PK\x03\x04" (หรือ PK\x05\x06 สำหรับ zip ว่าง)
    if (content[0] !== 0x50 || content[1] !== 0x4b) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_ZIP', 'Only .zip packages are accepted');
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    const result = await this.db.tx(async (db) => {
      const inserted = await db.query(
        `INSERT INTO code_packages (filename, sha256, size_bytes, content, uploaded_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sha256) DO NOTHING RETURNING ${PACKAGE_COLUMNS}`,
        [filename, sha256, content.length, content, actor],
      );
      if (inserted.rowCount) {
        await audit(db, actor, 'package.upload', 'package', String(inserted.rows[0].id), { filename, sha256 });
        return { package: inserted.rows[0], created: true };
      }
      const existing = (await db.query(`SELECT ${PACKAGE_COLUMNS} FROM code_packages WHERE sha256 = $1`, [sha256])).rows[0];
      return { package: existing, created: false };
    });
    this.events.changed('package.upload');
    return result;
  }

  listPackages(): Promise<any[]> {
    return this.db.query(`SELECT ${PACKAGE_COLUMNS} FROM code_packages ORDER BY created_at DESC, id DESC`);
  }

  async content(packageId: string): Promise<{ filename: string; sha256: string; content: Buffer }> {
    const p = await this.db.one('SELECT filename, sha256, content FROM code_packages WHERE id = $1', [packageId]);
    if (!p) throw notFound('Package');
    return p;
  }

  async deletePackage(packageId: string, actor: string): Promise<void> {
    await this.db.tx(async (db) => {
      const used = await db.query('SELECT 1 FROM bot_deployments WHERE package_id = $1 LIMIT 1', [packageId]);
      if (used.rowCount) throw new AppError(HttpStatus.CONFLICT, 'PACKAGE_IN_USE', 'Package has deployment history');
      const r = await db.query('DELETE FROM code_packages WHERE id = $1 RETURNING filename', [packageId]);
      if (!r.rowCount) throw notFound('Package');
      await audit(db, actor, 'package.delete', 'package', packageId, { filename: r.rows[0].filename });
    });
    this.events.changed('package.delete');
  }

  /**
   * สั่งอัปเดตทุกเครื่อง (botIds ว่าง) หรือเลือกเครื่อง
   * - เครื่องที่ใช้ package นี้อยู่แล้ว → already_current (กดซ้ำไม่ทำอะไร)
   * - เครื่องที่มีการอัปเดตค้างอยู่ → in_progress (unique index กันซ้อน)
   * - เครื่องออฟไลน์ → queued ไว้ ส่งให้ตอน agent ต่อกลับมา
   */
  async deploy(packageId: string, botIds: string[] | undefined, actor: string): Promise<{ results: any[] }> {
    const pkg = await this.db.one('SELECT id, sha256, filename FROM code_packages WHERE id = $1', [packageId]);
    if (!pkg) throw notFound('Package');
    const targets = await this.db.query<{ id: string; code_version: string | null }>(
      `SELECT id, code_version FROM oxide_bot_agents WHERE ($1::text[] IS NULL OR id = ANY($1)) ORDER BY id`,
      [botIds?.length ? botIds : null],
    );
    if (botIds?.length) {
      const unknown = botIds.filter((id) => !targets.some((t) => t.id === id));
      if (unknown.length) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_BOT', 'Unknown bot id(s)', unknown);
    }
    const results: any[] = [];
    for (const bot of targets) {
      if (bot.code_version === shortVersion(pkg.sha256)) {
        results.push({ bot_id: bot.id, result: 'already_current' });
        continue;
      }
      const row = await this.db.one(
        `INSERT INTO bot_deployments (package_id, bot_id, requested_by) VALUES ($1, $2, $3)
         ON CONFLICT (bot_id) WHERE status IN ('queued','sent') DO NOTHING RETURNING id`,
        [pkg.id, bot.id, actor],
      );
      results.push(row ? { bot_id: bot.id, result: 'queued', deployment_id: row.id } : { bot_id: bot.id, result: 'in_progress' });
    }
    await audit(this.db.pool, actor, 'package.deploy', 'package', String(pkg.id), { bot_ids: botIds ?? 'all', results });
    await this.dispatchPending();
    this.events.changed('deploy');
    return { results };
  }

  /**
   * ส่งคำสั่ง deploy ที่ยังไม่จบให้ agent (เรียกตอน deploy, ตอน agent ต่อเข้ามา และจาก job)
   * ส่งซ้ำได้: agent ตรวจ sha256 และตอบ applied ถ้ามีเวอร์ชันนี้แล้ว
   */
  async dispatchPending(onlyBot?: string): Promise<void> {
    await this.db.query(
      `UPDATE bot_deployments SET status = 'failed', error = 'agent did not acknowledge', updated_at = now()
       WHERE status = 'sent' AND attempts >= $1 AND updated_at < now() - make_interval(secs => $2)`,
      [MAX_DEPLOY_ATTEMPTS, ACK_TIMEOUT_S],
    );
    const due = await this.db.query(
      `SELECT d.id, d.bot_id, p.id AS package_id, p.sha256, p.filename FROM bot_deployments d
       JOIN code_packages p ON p.id = d.package_id
       WHERE ($1::text IS NULL OR d.bot_id = $1)
         AND (d.status = 'queued' OR (d.status = 'sent' AND d.updated_at < now() - make_interval(secs => $2)))`,
      [onlyBot ?? null, ACK_TIMEOUT_S],
    );
    for (const d of due) {
      // เขียน sent "ก่อน" ส่ง: agent อาจ ack applied กลับมาเร็วมาก ถ้าเขียน sent ทีหลังจะทับ applied
      // เงื่อนไขใน WHERE ทำให้ dispatch ที่รันซ้อนกันส่งได้ครั้งเดียว
      const claimed = await this.db.one(
        `UPDATE bot_deployments SET status = 'sent', attempts = attempts + 1, updated_at = now()
         WHERE id = $1 AND (status = 'queued' OR (status = 'sent' AND updated_at < now() - make_interval(secs => $2)))
         RETURNING id`,
        [d.id, ACK_TIMEOUT_S],
      );
      if (!claimed) continue;
      const delivered = this.events.toAgent(d.bot_id, {
        type: 'deploy',
        deploymentId: String(d.id),
        packageId: String(d.package_id),
        sha256: d.sha256,
        filename: d.filename,
      });
      if (!delivered) {
        // agent ออฟไลน์ → กลับเป็น queued ส่งใหม่ตอนต่อกลับมา (เฉพาะถ้ายังเป็น sent — ไม่ทับผลที่ agent ตอบแล้ว)
        await this.db.query(
          `UPDATE bot_deployments SET status = 'queued', attempts = attempts - 1, updated_at = now()
           WHERE id = $1 AND status = 'sent'`,
          [d.id],
        );
      }
    }
  }

  /** agent ตอบผลการอัปเดต — ตอบซ้ำได้ (เฉพาะ queued/sent เท่านั้นที่เปลี่ยน) */
  async ack(botId: string, deploymentId: string, ok: boolean, error?: string): Promise<void> {
    await this.db.tx(async (db) => {
      const d = (
        await db.query(
          `UPDATE bot_deployments SET status = $3, error = $4, updated_at = now()
           WHERE id = $1 AND bot_id = $2 AND status IN ('queued','sent') RETURNING package_id`,
          [deploymentId, botId, ok ? 'applied' : 'failed', ok ? null : (error ?? 'unknown error')],
        )
      ).rows[0];
      if (!d || !ok) return;
      const pkg = (await db.query('SELECT sha256 FROM code_packages WHERE id = $1', [d.package_id])).rows[0];
      await db.query('UPDATE oxide_bot_agents SET code_version = $2, updated_at = now() WHERE id = $1', [
        botId,
        shortVersion(pkg.sha256),
      ]);
    });
    this.log.log({ bot: botId, deployment: deploymentId, ok, error });
    this.events.changed('deploy.ack');
  }

  recentDeployments(limit = 20): Promise<any[]> {
    return this.db.query(
      `SELECT d.id, d.bot_id, d.status, d.attempts, d.error, d.requested_by, d.created_at, d.updated_at, p.filename
       FROM bot_deployments d JOIN code_packages p ON p.id = d.package_id
       ORDER BY d.created_at DESC, d.id DESC LIMIT $1`,
      [limit],
    );
  }
}
