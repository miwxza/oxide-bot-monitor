import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppConfig, CONFIG } from '../config';

export type Db = Pick<PoolClient, 'query'>;

// รันจาก root ของโปรเจกต์เสมอ (npm scripts, docker WORKDIR, jest)
const DB_DIR = join(process.cwd(), 'db');

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool: Pool;

  constructor(@Inject(CONFIG) cfg: AppConfig) {
    this.pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  /** รัน fn ใน transaction เดียว — error = rollback ทั้งก้อน */
  async tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * schema.sql + seed.sql (ไฟล์จาก candidate pack, ไม่แก้) แล้วตามด้วย db/migrations/*.sql ตามลำดับชื่อ
   * ใช้ advisory lock กันหลาย instance migrate พร้อมกัน
   */
  async migrate(): Promise<void> {
    await this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(424242)');
      await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
      await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const seeded = await db.query(`SELECT 1 FROM schema_migrations WHERE name = 'seed.sql'`);
      if (!seeded.rowCount) {
        await db.query(readFileSync(join(DB_DIR, 'seed.sql'), 'utf8'));
        await db.query(`INSERT INTO schema_migrations (name) VALUES ('seed.sql')`);
      }
      const files = readdirSync(join(DB_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        const done = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (done.rowCount) continue;
        await db.query(readFileSync(join(DB_DIR, 'migrations', file), 'utf8'));
        await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        this.log.log(`applied ${file}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
