import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';

export interface SimulatorBot {
  id: string;
  name: string;
  deviceName: string;
  status: 'online' | 'offline' | 'starting' | 'stopping' | 'error';
  cpuPercent: number;
  memoryPercent: number;
  uptimeSeconds: number;
}

/** error ที่ลองใหม่ได้ (network, 5xx) แยกจาก error ถาวร (4xx) */
export class SimulatorError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** HTTP client ของ Bot Simulator ใน candidate pack (ไม่แก้ไฟล์ simulator) */
@Injectable()
export class SimulatorClient {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.cfg.simulatorUrl + path, { ...init, signal: AbortSignal.timeout(5000) });
    } catch (err) {
      throw new SimulatorError(`simulator unreachable: ${(err as Error).message}`, true);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SimulatorError(`simulator ${res.status}: ${JSON.stringify(body)}`, res.status >= 500, res.status);
    }
    return body as T;
  }

  listBots(): Promise<SimulatorBot[]> {
    return this.call('/bots');
  }

  sendCommand(botId: string, command: string): Promise<{ ok: boolean; bot: SimulatorBot; command: string }> {
    return this.call(`/bots/${encodeURIComponent(botId)}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
  }
}
