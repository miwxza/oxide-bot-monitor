function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export interface AppConfig {
  databaseUrl: string;
  simulatorUrl: string;
  port: number;
  adminToken: string;
  agentToken: string;
  webhookSecret: string;
  botHeartbeatTimeoutS: number;
  orderLeaseS: number;
  paymentWindowS: number;
  queuedSlaS: number;
  maxAttempts: number;
  retryBaseS: number;
  jobIntervalMs: number;
  simulatorPollMs: number;
  runJobs: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: str('DATABASE_URL', 'postgresql://oxide:oxide_dev@localhost:55432/oxide_monitor'),
    simulatorUrl: str('BOT_SIMULATOR_URL', 'http://localhost:8788'),
    port: num('PORT', 3000),
    adminToken: str('ADMIN_TOKEN', 'dev-admin-token'),
    agentToken: str('AGENT_TOKEN', 'dev-agent-token'),
    webhookSecret: str('WEBHOOK_SECRET', 'dev-webhook-secret'),
    botHeartbeatTimeoutS: num('BOT_HEARTBEAT_TIMEOUT_S', 15),
    orderLeaseS: num('ORDER_LEASE_S', 30),
    paymentWindowS: num('PAYMENT_WINDOW_S', 900),
    queuedSlaS: num('QUEUED_SLA_S', 300),
    maxAttempts: num('MAX_ATTEMPTS', 3),
    retryBaseS: num('RETRY_BASE_S', 10),
    jobIntervalMs: num('JOB_INTERVAL_MS', 2000),
    simulatorPollMs: num('SIMULATOR_POLL_MS', 3000),
    runJobs: str('RUN_JOBS', 'true') !== 'false',
    ...overrides,
  };
}

export const CONFIG = Symbol('CONFIG');
