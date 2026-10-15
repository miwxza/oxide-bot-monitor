import { Injectable } from '@nestjs/common';
import { BotsService } from '../bots/bots.service';
import { DbService } from '../db/db.service';
import { DeployService } from '../deploy/deploy.service';
import { SystemService } from '../system/system.service';

/** ข้อมูลทั้งหน้า dashboard ในก้อนเดียว (ใช้ทั้ง REST /dashboard และ WebSocket push) */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly bots: BotsService,
    private readonly system: SystemService,
    private readonly deploy: DeployService,
  ) {}

  async snapshot() {
    const [system, bots, orderCounts, orders, alerts, packages, deployments] = await Promise.all([
      this.system.get(),
      this.bots.list(),
      this.db.query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`),
      this.db.query(
        `SELECT external_order_id, status, amount, currency, player_uid, assigned_bot_id, attempts,
                last_error_code, updated_at
         FROM orders ORDER BY updated_at DESC, id DESC LIMIT 15`,
      ),
      this.db.query(`SELECT id, kind, severity, message, bot_id, created_at FROM alerts ORDER BY created_at DESC LIMIT 10`),
      this.deploy.listPackages(),
      this.deploy.recentDeployments(10),
    ]);
    return {
      generated_at: new Date().toISOString(),
      system,
      summary: BotsService.summarize(bots),
      bots,
      order_counts: Object.fromEntries(orderCounts.map((r) => [r.status, r.n])),
      orders,
      alerts,
      packages,
      deployments,
    };
  }
}
