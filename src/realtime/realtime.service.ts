import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { BotsService } from '../bots/bots.service';
import { safeEqual } from '../common/auth';
import { AppConfig, CONFIG } from '../config';
import { DeployService } from '../deploy/deploy.service';
import { DashboardService } from './dashboard.service';
import { AgentMessage, EventsService } from './events.service';
import { SystemService } from '../system/system.service';

/**
 * WebSocket 2 ช่องบน HTTP server เดียวกัน
 *  /ws/agent?bot_id=..&token=..   bot agent: ส่ง heartbeat / ผล deploy, รับคำสั่ง (system, wake, deploy)
 *  /ws/dashboard?token=..         dashboard: รับ snapshot ทุกครั้งที่มีการเปลี่ยนแปลง (+ ทุก 2 วินาทีเพื่ออัปเดตอายุ heartbeat)
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly log = new Logger('Realtime');
  private readonly agentWss = new WebSocketServer({ noServer: true });
  private readonly dashWss = new WebSocketServer({ noServer: true });
  private readonly agents = new Map<string, WebSocket>();
  private pushTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly events: EventsService,
    private readonly bots: BotsService,
    private readonly deploy: DeployService,
    private readonly system: SystemService,
    private readonly dashboard: DashboardService,
  ) {
    events.setAgentSender((botId, msg) => this.sendToAgent(botId, msg));
    events.on('changed', () => this.schedulePush());
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      if (url.pathname === '/ws/agent' && safeEqual(token, this.cfg.agentToken)) {
        const botId = url.searchParams.get('bot_id') ?? '';
        this.agentWss.handleUpgrade(req, socket, head, (ws) => void this.onAgent(ws, botId, url.searchParams.get('host')));
      } else if (url.pathname === '/ws/dashboard' && safeEqual(token, this.cfg.adminToken)) {
        this.dashWss.handleUpgrade(req, socket, head, (ws) => void this.onDashboard(ws));
      } else {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    });
    this.tickTimer = setInterval(() => this.schedulePush(), 2000);
  }

  // ---------------- agent ----------------
  private async onAgent(ws: WebSocket, botId: string, host: string | null): Promise<void> {
    if (!(await this.bots.exists(botId))) {
      ws.close(4004, 'unknown bot');
      return;
    }
    // เครื่องเดิมต่อซ้ำ (เช่น reconnect ก่อน socket เก่าปิด) → ใช้อันใหม่
    this.agents.get(botId)?.close(4000, 'replaced by new connection');
    this.agents.set(botId, ws);
    await this.bots.heartbeat(botId, { host: host ?? undefined });
    await this.bots.setConnected(botId, true);
    this.log.log({ bot: botId, msg: 'agent connected' });

    ws.on('message', (raw) => void this.onAgentMessage(botId, raw.toString()));
    ws.on('close', () => {
      if (this.agents.get(botId) !== ws) return;
      this.agents.delete(botId);
      void this.bots.setConnected(botId, false);
      this.log.warn({ bot: botId, msg: 'agent disconnected' });
    });

    const state = await this.system.get();
    this.sendToAgent(botId, { type: 'system', acceptingOrders: state.accepting_orders });
    await this.deploy.dispatchPending(botId);
  }

  private async onAgentMessage(botId: string, raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.type === 'heartbeat') {
        await this.bots.heartbeat(botId, { host: msg.host, code_version: msg.code_version });
      } else if (msg.type === 'deploy_ack' && msg.deploymentId) {
        await this.deploy.ack(botId, String(msg.deploymentId), !!msg.ok, msg.error);
      }
    } catch (err) {
      this.log.error({ bot: botId, err: (err as Error).message });
    }
  }

  sendToAgent(botId: string, msg: AgentMessage): boolean {
    const data = JSON.stringify(msg);
    const targets = botId === '*' ? [...this.agents.values()] : [this.agents.get(botId)].filter(Boolean);
    let sent = false;
    for (const ws of targets as WebSocket[]) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        sent = true;
      }
    }
    return sent;
  }

  isAgentConnected(botId: string): boolean {
    return this.agents.get(botId)?.readyState === WebSocket.OPEN;
  }

  // ---------------- dashboard ----------------
  private async onDashboard(ws: WebSocket): Promise<void> {
    ws.send(JSON.stringify({ type: 'snapshot', data: await this.dashboard.snapshot() }));
  }

  /** รวมการเปลี่ยนแปลงที่เกิดติดกันเป็น push เดียว (debounce 200ms) */
  private schedulePush(): void {
    if (this.pushTimer || this.dashWss.clients.size === 0) return;
    this.pushTimer = setTimeout(async () => {
      this.pushTimer = undefined;
      try {
        const data = JSON.stringify({ type: 'snapshot', data: await this.dashboard.snapshot() });
        for (const c of this.dashWss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
      } catch (err) {
        this.log.error({ err: (err as Error).message, msg: 'snapshot failed' });
      }
    }, 200);
  }

  onModuleDestroy(): void {
    clearInterval(this.tickTimer);
    clearTimeout(this.pushTimer);
    for (const ws of this.agents.values()) ws.terminate();
    for (const ws of this.dashWss.clients) ws.terminate();
    this.agentWss.close();
    this.dashWss.close();
  }
}
