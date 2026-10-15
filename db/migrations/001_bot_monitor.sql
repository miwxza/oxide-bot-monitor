-- Oxide Bot Monitor: ส่วนขยายของ db/schema.sql (ไม่แก้ไฟล์เดิม เพิ่มเฉพาะที่ PDF ต้องการ)
-- รันซ้ำได้ (idempotent) — migrator บันทึกชื่อไฟล์ใน schema_migrations

-- ---------------------------------------------------------------------------
-- 1) orders: state machine ตาม PDF  PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED
--    schema เดิมมี pending/processing/completed/failed/cancelled ซึ่งไม่มี QUEUED / DELAYED
--    จึงเปลี่ยน CHECK และแปลงข้อมูลเดิมให้ตรง (pending→PENDING_PAYMENT, processing→IN_PROGRESS)
-- ---------------------------------------------------------------------------
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
UPDATE orders SET status = CASE status
  WHEN 'pending' THEN 'PENDING_PAYMENT'
  WHEN 'processing' THEN 'IN_PROGRESS'
  WHEN 'completed' THEN 'COMPLETED'
  WHEN 'failed' THEN 'FAILED'
  WHEN 'cancelled' THEN 'CANCELLED'
  ELSE status END;
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'PENDING_PAYMENT';
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'PENDING_PAYMENT','QUEUED','IN_PROGRESS','COMPLETED','DELAYED','FAILED','EXPIRED','CANCELLED'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS player_uid TEXT,
  ADD COLUMN IF NOT EXISTS package_code TEXT,
  ADD COLUMN IF NOT EXISTS request_hash TEXT,              -- ตรวจ external_order_id ซ้ำแต่ข้อมูลต่าง
  ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_txn_id TEXT,
  ADD COLUMN IF NOT EXISTS assigned_bot_id TEXT REFERENCES oxide_bot_agents(id),
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT,
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- เงินก้อนเดียวจ่ายได้ออเดอร์เดียว
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_payment_txn ON orders(payment_txn_id) WHERE payment_txn_id IS NOT NULL;
-- คิวงาน: bot claim จาก index นี้
CREATE INDEX IF NOT EXISTS idx_orders_queue ON orders(next_attempt_at, id) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS idx_orders_lease ON orders(lease_expires_at) WHERE status = 'IN_PROGRESS';

-- webhook ธนาคาร: เก็บ event_id กันประมวลผลซ้ำ
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  order_id BIGINT REFERENCES orders(id),
  outcome TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- provider จำลอง: เติมเกมด้วย topup_key เดิมซ้ำได้ ไม่เติมสองครั้ง
CREATE TABLE IF NOT EXISTS provider_topups (
  topup_key TEXT PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  bot_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2) bots
-- ---------------------------------------------------------------------------
ALTER TABLE oxide_bot_agents
  ADD COLUMN IF NOT EXISTS code_version TEXT,                 -- package ที่ติดตั้งอยู่ (sha256 สั้น)
  ADD COLUMN IF NOT EXISTS agent_connected BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS host TEXT;

-- คำสั่ง: รับ Idempotency-Key และมีคำสั่งค้างได้ทีละ 1 ต่อเครื่อง
ALTER TABLE oxide_bot_commands
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_commands_idem ON oxide_bot_commands(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commands_inflight ON oxide_bot_commands(bot_id) WHERE status IN ('queued','running');

-- ---------------------------------------------------------------------------
-- 3) Kill-switch ทั้งระบบ (แถวเดียว)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  accepting_orders BOOLEAN NOT NULL DEFAULT true,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) Code deployment
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS code_packages (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,                                -- อัปโหลดไฟล์เดิมซ้ำได้ package เดิม
  size_bytes BIGINT NOT NULL,
  content BYTEA NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_deployments (
  id BIGSERIAL PRIMARY KEY,
  package_id BIGINT NOT NULL REFERENCES code_packages(id),
  bot_id TEXT NOT NULL REFERENCES oxide_bot_agents(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','applied','failed')),
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  requested_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- เครื่องหนึ่งมีการอัปเดตที่ยังไม่จบได้ทีละ 1
CREATE UNIQUE INDEX IF NOT EXISTS uq_deploy_inflight ON bot_deployments(bot_id) WHERE status IN ('queued','sent');

-- ---------------------------------------------------------------------------
-- 5) Alerts สำหรับแอดมิน (dedupe_key กันแจ้งซ้ำ)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  order_id BIGINT REFERENCES orders(id),
  bot_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
