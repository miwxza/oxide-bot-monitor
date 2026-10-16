# Oxide Bot Monitor

ศูนย์กลางควบคุมบอทเติมเกม (Centralized Bot Monitoring & Control Center) และระบบติดตามออเดอร์

- **Dashboard real-time** ของเครื่องบอททุกเครื่อง: heartbeat, สถานะบอท, งานล่าสุด, CPU/RAM, เวอร์ชันโค้ด
- **Kill-switch ทั้งระบบ**, **สั่งเปิด/ปิด/restart รายเครื่อง**, **อัปเดตโค้ด (zip) ทุกเครื่องหรือเลือกเครื่อง**
- **Order state machine** `PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED` พร้อมตรวจจับเครื่องหลุด (heartbeat timeout) แล้วปรับเป็น `QUEUED` / `DELAYED` / `FAILED` อัตโนมัติ

**Stack:** Node.js 24, NestJS 11, PostgreSQL 16 (SQL ตรงผ่าน `pg`), WebSocket (`ws`), Jest, Docker Compose

---

## วิธีรัน

```bash
docker compose up -d --build
```

| URL | |
|---|---|
| http://localhost:3000 | Dashboard |
| http://localhost:3000/docs | Swagger (ใส่ `X-Admin-Token: dev-admin-token`) |
| http://localhost:8788/bots | Bot Simulator จาก candidate pack |

ถ้า `localhost` ไม่ตอบ (บาง Windows ที่ Docker Desktop ส่งต่อ IPv6 ไม่ได้) ใช้ `http://127.0.0.1:3000` แทน

Compose รัน 4 service: `postgres` (จาก pack), `simulator` (จาก pack ไม่ได้แก้), `api` และ `agents` (บอทจำลอง 3 เครื่อง `bot-01..03` แต่ละเครื่องเป็น process แยก)

ปิดระบบ: `docker compose down` (ล้างข้อมูลด้วย `docker compose down -v`)

### Live demo

_(ลิงก์จะใส่หลัง deploy บน Render)_

- `render.yaml` สร้าง web service ฟรี 1 ตัว + PostgreSQL ฟรี: container เดียวรัน simulator + API + บอท 3 เครื่อง (`node dist/agent/demo.js`) เพราะแผนฟรีมี container เดียว ส่วน Docker Compose แยก service ตามโครงสร้างจริง
- `ADMIN_TOKEN` / `AGENT_TOKEN` / `WEBHOOK_SECRET` ถูกสุ่มบน Render ไม่ใช่ค่า `dev-...` ใน repo — เปิด dashboard แล้วกดปุ่ม 🔑 ใส่ admin token
- แผนฟรีหยุดเมื่อไม่มีคนใช้สักพัก request แรกอาจใช้เวลาประมาณ 1 นาที

### รันแบบไม่ใช้ Docker (ยกเว้น Postgres)

```bash
docker compose up -d postgres
npm install
npm run build
npm run simulator        # terminal 1: Bot Simulator :8788
npm start                # terminal 2: API + dashboard :3000
npm run agents           # terminal 3: บอท 3 เครื่อง
```

ค่าตั้งต่าง ๆ อยู่ใน `.env.example` (ค่า token ในไฟล์เป็นค่า dev เท่านั้น production ต้องตั้งใหม่)

### ทดสอบ

```bash
docker compose run --rm --build test
```

**64 เทสต์** (unit 22 + integration 42 บน PostgreSQL จริง) ใช้เวลาประมาณ 30 วินาที

หรือในเครื่อง: `docker compose up -d postgres` แล้ว `npm test` (เทสต์สร้างฐานข้อมูล `oxide_test` แยกให้เอง)

ทดสอบ API ด้วยมือ: `requests/oxide.http` (VS Code + REST Client) ไล่ตามลำดับเคสในไฟล์ แล้วเปิด dashboard ดูผลไปพร้อมกัน

---

## สถาปัตยกรรม

```text
                       ┌──────────────── Dashboard (browser) ────────────────┐
                       │  REST: สั่งงาน  ·  WebSocket /ws/dashboard: snapshot │
                       └──────────────────────────┬──────────────────────────┘
                                                  │
┌───────────────┐  REST /agent/*: claim, lease,   │      ┌──────────────────┐
│ Bot agent ×3  │  complete, fail, ดาวน์โหลด zip  ▼      │  Bot Simulator   │
│ (เครื่องบอท)  │──────────────────────────► ┌──────────┐  │  (candidate pack)│
│               │◄── WebSocket /ws/agent ───│  API     │──► start/stop/     │
│               │  heartbeat ↑ · system,     │ (NestJS) │  │  restart/status │
└───────────────┘  wake, deploy ↓           │ + jobs   │◄─ GET /bots (poll) │
                                            └────┬─────┘  └──────────────────┘
       ธนาคาร ──► POST /webhooks/payment (HMAC) ─┤
                                                 ▼
                                           PostgreSQL
```

| ช่องทาง | ใช้ทำอะไร | เหตุผล |
|---|---|---|
| WebSocket `/ws/agent` | heartbeat ทุก 3 วินาที, server ส่ง kill-switch / งานใหม่ / คำสั่งอัปเดตโค้ด | ตามข้อเสนอแนะใน PDF: real-time ทั้งสองทาง ไม่ต้อง poll |
| REST `/agent/*` | รับงาน ต่อ lease จบงาน รายงาน error | การเปลี่ยนสถานะออเดอร์ต้องได้คำตอบ (สำเร็จ / 409) แบบ request-response ชัดเจน retry ได้ |
| WebSocket `/ws/dashboard` | ส่ง snapshot ทั้งหน้าทุกครั้งที่มีการเปลี่ยนแปลง (รวมหลายเหตุการณ์ใน 200ms) + ทุก 2 วินาทีเพื่ออัปเดตอายุ heartbeat | ข้อมูลไม่กี่ KB ส่งทั้งก้อนง่ายและไม่มีปัญหาลำดับ event |
| Poll `GET /bots` ของ simulator ทุก 3 วินาที | CPU / RAM / uptime / สถานะ process | simulator ใน pack ไม่มีช่องทาง push |
| Background jobs (ทุก 2 วินาที) | หมดเวลาชำระ, เครื่องหลุด/lease หมด, SLA, ส่งคำสั่ง, ส่งอัปเดตโค้ด | ใช้ Postgres row lock (`SKIP LOCKED`) แทน message queue ลดจำนวน service |

### บทบาทของ Bot Simulator กับ Bot agent

โจทย์ให้ "เชื่อมต่อ Bot Simulator ที่ให้มา" แต่ simulator รับได้แค่ `start/stop/restart/status` ไม่มี heartbeat ไม่รับออเดอร์ และไม่มีคำสั่งอัปเดตโค้ด จึงแบ่งหน้าที่เป็น:

- **Simulator = ตัวจัดการ process ของบอทบนเครื่อง** — ปุ่ม เปิดบอท/ปิดบอท/restart ส่งไปที่ simulator และ CPU/RAM/สถานะ process มาจาก simulator
- **Bot agent (`agent/bot-agent.ts`) = โปรแกรมบนเครื่อง** — ส่ง heartbeat, รับออเดอร์ไปทำ, รับคำสั่งอัปเดตโค้ด

เครื่องจะรับงานได้ต้องผ่านทั้งสองฝั่ง: heartbeat ของ agent สด **และ** process ใน simulator เป็น `online`

### สถานะบน dashboard

| สถานะ | เงื่อนไข |
|---|---|
| ออนไลน์ (Online) | heartbeat ล่าสุดไม่เกิน 15 วินาที (`BOT_HEARTBEAT_TIMEOUT_S`) |
| เปิดรับงาน (Active) | ออนไลน์ + process เปิด + ระบบไม่ถูก kill-switch + ไม่มีงานค้าง |
| รับรอ (Standby) | ออนไลน์ แต่ process ปิด / กำลังเปิด-ปิด หรือระบบถูก kill-switch |
| กำลังทำงาน (In Progress) | ถือออเดอร์ `IN_PROGRESS` อยู่ |
| Offline | heartbeat ขาด (เครื่องหลุด/ล่ม) |

คำนวณตอนอ่านจาก `last_heartbeat`, สถานะ process และออเดอร์ ไม่เก็บซ้ำในตาราง จึงไม่มีปัญหาข้อมูลไม่ตรงกัน

---

## Schema และจุดที่โจทย์ขัดกัน

**ไม่ได้แก้ `db/schema.sql` และ `db/seed.sql` ของ pack** ส่วนที่เพิ่มอยู่ใน `db/migrations/001_bot_monitor.sql` ซึ่ง API รันให้ตอนเริ่ม (บันทึกใน `schema_migrations` รันซ้ำได้)

| จุดที่ขัดกัน | ตัดสินใจ | เหตุผล |
|---|---|---|
| README ของ pack: "ไม่ต้องทำ migration เพิ่ม" แต่ `orders.status` มีแค่ `pending/processing/completed/failed/cancelled` ไม่มี `QUEUED`, `DELAYED` ตามที่ PDF กำหนด | เพิ่ม migration แบบ **additive** เปลี่ยน CHECK ของ `orders.status` และแปลงข้อมูลเดิม (`pending → PENDING_PAYMENT`, `processing → IN_PROGRESS`) | PDF เป็นข้อกำหนดของระบบ ส่วนประโยคใน pack อ่านได้ว่า "ไม่จำเป็นต้อง" ไม่ใช่ "ห้าม" การบังคับใช้ state machine ด้วย CHECK ใน DB ปลอดภัยกว่าเก็บใน `order_events` อย่างเดียว |
| `oxide_bot_commands.command` รับแค่ 4 คำสั่ง | ไม่แก้ — อัปเดตโค้ดแยกเป็นตาราง `bot_deployments` และ kill-switch เป็น `system_settings` | การอัปเดตโค้ดมี lifecycle ต่างจากคำสั่ง (queued → sent → applied/failed, ต้องรอ agent ยืนยัน sha256) |
| PDF แนะนำ WebSocket/gRPC/MQTT | WebSocket | ทำงานบน HTTP server เดียวกัน, browser ใช้ได้ตรง, ไม่ต้องมี broker เพิ่ม |

ตารางที่เพิ่ม: `system_settings` (kill-switch), `code_packages`, `bot_deployments`, `webhook_events`, `provider_topups`, `alerts` และคอลัมน์ lease / attempts / version ใน `orders`

---

## Order state machine

```text
PENDING_PAYMENT ──(จ่ายแล้ว)──► QUEUED ──(bot claim)──► IN_PROGRESS ──(เติมสำเร็จ)──► COMPLETED
       │                         ▲                         │
       └─(หมดเวลาชำระ)► EXPIRED ─┘ (จ่ายทันแต่ webhook ช้า)  ├─(เครื่องหลุด / error ชั่วคราว, attempt เหลือ)─► QUEUED
                                                           ├─(attempt ครบ / ผลไม่แน่นอน)──► DELAYED ──(แอดมิน)─► QUEUED / COMPLETED / FAILED
                                                           └─(error ถาวร เช่น UID ผิด)────► FAILED ──(แก้แล้ว)─► QUEUED
```

ทุกการเปลี่ยนสถานะผ่าน `transition()` (`src/orders/state-machine.ts`) ซึ่งตรวจตารางเส้นทางที่อนุญาต, อัปเดตด้วย `WHERE status = <สถานะเดิม>` (ถ้ามีคนเปลี่ยนไปก่อน → 409 ไม่เขียนทับ) และบันทึก `order_events` ใน transaction เดียวกัน — `GET /orders/{id}/timeline` จึงตรงกับสถานะจริงเสมอ

---

## การแก้เคสปัญหา 5 ข้อ

### 1. เครื่องบอทหลุด / ล่ม / เงียบ (heartbeat timeout)

**วิธีแก้**
- บอทรับงานแล้วได้ **lease** 30 วินาที ต้องต่อ lease ระหว่างทำ (`/agent/orders/{id}/lease`)
- job ตรวจทุก 2 วินาที: ออเดอร์ `IN_PROGRESS` ที่ **เครื่องที่ถืออยู่ heartbeat ขาดเกิน 15 วินาที** จะถูกจัดการ**ทันทีโดยไม่ต้องรอ lease หมด** ส่วนเครื่องที่ยังออนไลน์แต่ไม่ต่อ lease จะถูกจัดการเมื่อ lease หมด
- มี attempt เหลือ → `QUEUED` ให้เครื่องอื่นรับต่อ (backoff 10s, 20s) / ครบ 3 attempts → **`DELAYED` + alert**
- lease token เก่าใช้ไม่ได้อีก: เครื่องเดิมกลับมาแล้วพยายามจบงานจะได้ `409 LEASE_LOST`
- เครื่องที่ heartbeat ขาดขอรับงานใหม่ไม่ได้ (`409 BOT_NOT_READY`)

**เหตุผล:** PDF ให้ปรับเป็น `DELAYED` หรือ `FAILED` เมื่อเครื่องหลุด เลือกส่งให้เครื่องอื่นลองก่อนเพราะบอทมีหลายเครื่อง และใช้ `DELAYED` (ไม่ใช่ `FAILED`) เมื่อครบจำนวนครั้ง เพราะลูกค้าจ่ายเงินแล้วและระบบไม่รู้ว่าเครื่องที่ล่มเติมไปแล้วหรือยัง ต้องให้แอดมินตรวจก่อนตัดสิน `FAILED` ใช้กับ error ถาวรที่รู้แน่ว่าเติมไม่ได้

### 2. หลายเครื่องแย่งออเดอร์ / เติมซ้ำ (concurrency)

**วิธีแก้**
- claim ด้วย `SELECT ... FOR UPDATE SKIP LOCKED`: บอทขอพร้อมกันได้ออเดอร์คนละตัว ไม่มีใครได้ซ้ำ และไม่ต้องรอกัน
- เครื่องหนึ่งถือได้ทีละออเดอร์ (`409 BOT_BUSY`): claim ล็อกแถวของบอทด้วย `FOR UPDATE` ให้คำขอจากเครื่องเดียวกันเข้าคิวกัน และมี unique index `orders(assigned_bot_id) WHERE status = 'IN_PROGRESS'` เป็นด่านสุดท้ายในฐานข้อมูล — เดิมใช้ `FOR SHARE` ซึ่งถือพร้อมกันได้ เทสต์ยิง claim จากเครื่องเดียว 5 ครั้งพร้อมกันพบว่าได้ไป 5 ออเดอร์ จึงแก้ทั้งสองชั้นและเก็บเทสต์นี้ไว้
- ทุกออเดอร์มี **`topup_key` คงที่ทุก attempt** ส่งให้ provider: ถ้าเครื่องแรกเติมแล้วล่มก่อนรายงาน เครื่องถัดไปเติมด้วย key เดิม provider ตอบ `duplicate: true` จึง**ไม่เติมซ้ำ**
- `complete` ต้องถือ lease ปัจจุบัน และต้องมีหลักฐานการเติมที่ provider (`409 TOPUP_NOT_FOUND`) — เรียกซ้ำด้วย token เดิมได้ผลเดิม

**เหตุผล:** row lock ของ Postgres พอสำหรับคิวขนาดนี้ ไม่ต้องเพิ่ม Redis/queue ส่วนการกันเติมซ้ำต้องอาศัย idempotency ฝั่ง provider เพราะฐานข้อมูลของเรายืนยันผลภายนอกเองไม่ได้

### 3. Kill-switch แข่งกับการรับงาน, คำสั่งซ้ำ, อัปเดตซ้อน (concurrency + idempotency)

**วิธีแก้**
- **Kill-switch บังคับที่ server ตอน claim** ไม่ได้แค่ broadcast บอกบอท: claim อ่าน `system_settings` ด้วย `FOR SHARE` ใน transaction เดียวกับการจองออเดอร์ ส่วนการกด kill-switch ล็อกแถวด้วย `FOR UPDATE` — **หลังกดปิดแล้ว commit ไม่มี claim ไหนผ่านได้อีก** (claim ที่กำลังแข่งจะรอ lock แล้วเห็นค่าใหม่) งานที่รับไปก่อนหน้าทำต่อจนจบ เพื่อไม่ตัดกลางการจ่ายเงิน
- **คำสั่ง start/stop/restart**: บันทึกลงคิวก่อน แล้ว executor ค่อยส่งให้ simulator รับ `Idempotency-Key` (กดซ้ำ/network retry ได้คำสั่งเดิม) และ unique index ให้เครื่องหนึ่งมีคำสั่งค้างได้ทีละ 1 (กด start กับ stop พร้อมกัน → ตัวหนึ่ง `409 COMMAND_IN_PROGRESS`)
- **อัปเดตโค้ด**: ไฟล์เดิม (sha256 เดิม) อัปโหลดซ้ำได้แพ็กเกจเดิม, เครื่องหนึ่งมีการอัปเดตที่ยังไม่จบได้ทีละ 1, เครื่องที่ใช้เวอร์ชันนั้นอยู่แล้วได้ `already_current`
  - server บันทึก `sent` **ก่อน**ส่งคำสั่ง แล้วถ้า agent ออฟไลน์ค่อยคืนเป็น `queued` แบบมีเงื่อนไข — เดิมบันทึก `sent` หลังส่ง ถ้า agent ตอบเร็วจะทับ `applied` (มีเทสต์จำลองจังหวะนี้)
  - agent ดาวน์โหลด → ตรวจ sha256 → แตก zip ลงโฟลเดอร์ชั่วคราว (กัน zip-slip `../` และ zip bomb) → ย้ายเป็น `releases/<version>/` → สลับ `current.json` แบบ atomic → ack และเก็บ release ล่าสุด 3 ชุดไว้ย้อนกลับ ถ้าพังกลางทาง เวอร์ชันเดิมยังใช้งานต่อได้
  - agent ไม่สลับโค้ดระหว่างทำออเดอร์ (รอให้งานที่ถืออยู่จบ และหยุดรับงานใหม่ระหว่างติดตั้ง) และจำเวอร์ชันที่ติดตั้งไว้ข้ามการ restart
- ทุกคำสั่งของแอดมินบันทึก `audit_logs` พร้อมชื่อผู้กด (`X-Actor`)

**เหตุผล:** การส่ง kill-switch ผ่าน WebSocket อย่างเดียวมีช่วงที่ข้อความยังไปไม่ถึงเครื่อง ระหว่างนั้นเครื่องยังรับงานได้ จึงต้องบังคับที่จุดเดียวที่ทุกเครื่องต้องผ่าน (claim)

### 4. Webhook ธนาคารซ้ำ / มาช้า / เงินก้อนเดิม (idempotency)

**วิธีแก้**
- ตรวจ HMAC-SHA256 ของ raw body (`X-Signature`)
- เก็บ `event_id` ใน transaction เดียวกับการเปลี่ยนสถานะ → event ซ้ำไม่ประมวลผลซ้ำ
- unique index บน `payment_txn_id` → เงินก้อนเดียวจ่ายได้ออเดอร์เดียว
- ตัดสินว่า "จ่ายทันไหม" จาก `paid_at` ของธนาคาร ไม่ใช่เวลาที่ webhook มาถึง: จ่ายทันแต่ออเดอร์ถูก job เปลี่ยนเป็น `EXPIRED` ไปแล้ว → กลับเป็น `QUEUED`, จ่ายหลังหมดเวลา → คง `EXPIRED` + alert ให้คืนเงิน
- ยอดไม่ตรง / จ่ายซ้ำด้วยเงินอีกก้อน → ไม่ยืนยันการจ่าย + alert

### 5. Error ระหว่างเติม และออเดอร์ค้าง (retry)

**วิธีแก้**
- server จัดประเภท error ที่บอทรายงาน (`src/orders/retry-policy.ts`) ให้ทุกเครื่องใช้เกณฑ์เดียวกัน:

  | ประเภท | ตัวอย่าง | ผล |
  |---|---|---|
  | ถาวร | `INVALID_UID`, `UID_REGION_MISMATCH` | `FAILED` ทันที |
  | ชั่วคราว | `PROVIDER_TIMEOUT`, `BOT_HEARTBEAT_TIMEOUT`, `LEASE_EXPIRED` | `QUEUED` + exponential backoff, ครบ 3 ครั้ง → `DELAYED` |
  | ผลไม่แน่นอน | `TOPUP_STATUS_UNKNOWN` | `DELAYED` ทันที (เสี่ยงเติมซ้ำถ้า retry เอง) |
  | ไม่รู้จัก | อื่น ๆ | ใช้แบบชั่วคราว (มีเพดาน จบที่ `DELAYED` ให้คนตรวจ) |

- job: `PENDING_PAYMENT` เกินเวลา → `EXPIRED`, `QUEUED` ค้างเกิน SLA → alert (dedupe key ไม่แจ้งซ้ำ)
- คำสั่งไป simulator: network error / 5xx → retry 3 ครั้ง (backoff), 4xx → `failed` ทันที, คำสั่งที่ค้าง `running` นานผิดปกติ (process ตายกลางทาง) → คืนเข้าคิว
- แอดมินจัดการออเดอร์ `DELAYED`/`FAILED` ได้: `requeue` (รีเซ็ต attempt), `resolve` (COMPLETED/FAILED หลังตรวจกับ provider)

---

## ทดลองเคสปัญหาบน dashboard

ฟอร์ม "สร้างออเดอร์ + จ่ายเงิน (demo)" บน dashboard เลือก UID ที่ทำให้บอทจำลองมีพฤติกรรมต่างกัน:

| UID | ผลที่ควรเห็น |
|---|---|
| `12345678` | `COMPLETED` |
| `INVALID001` | `FAILED` ทันที |
| `FLAKY001` | retry 3 ครั้ง → `DELAYED` + alert |
| `UNKNOWN001` | `DELAYED` ทันที |
| `HANG001` | บอทเงียบ → lease หมด → คืนเข้าคิวให้รับใหม่ → ครบ 3 ครั้ง `DELAYED` |
| `TOPUPCRASH001` | ล่มหลังเติม → รอบสองไม่เติมซ้ำ → `COMPLETED` (ดู timeline: `provider_duplicate_topup_prevented`) |

ทดลองเครื่องหลุด: `docker compose stop agents` → ประมาณ 15 วินาทีการ์ดทุกเครื่องเป็น Offline และออเดอร์ที่ค้างถูกจัดการ → `docker compose start agents` เครื่องกลับมาและได้รับอัปเดตโค้ดที่ค้างอยู่ทันที

---

## API หลัก

Header: แอดมิน `X-Admin-Token` (+ `X-Actor` ชื่อผู้กด), bot agent `X-Agent-Token` + `X-Bot-Id` — รายละเอียดครบใน Swagger `/docs`

| Method | Path | |
|---|---|---|
| GET | `/dashboard` | ข้อมูลทั้งหน้า: system, summary, bots, orders, alerts, packages |
| GET | `/bots`, `/bots/{id}` | การ์ดเครื่อง / รายละเอียด (log, metrics, คำสั่ง, อัปเดตโค้ด, audit) |
| POST | `/bots/{id}/commands` | `start` / `stop` / `restart` / `status` (รับ `Idempotency-Key`) → 202 |
| GET | `/commands/{id}` | สถานะคำสั่ง |
| PUT | `/system/kill-switch` | `{"accepting_orders": false}` ปิดทั้งระบบ |
| POST | `/packages` | อัปโหลด zip (multipart `file`) |
| POST | `/packages/{id}/deploy` | อัปเดตทุกเครื่อง หรือ `{"bot_ids": [...]}` |
| GET | `/deployments`, `/alerts`, `/audit-logs` | |
| POST | `/orders` | สร้างออเดอร์ (`external_order_id` = idempotency key) → 201 / 200 / 409 |
| GET | `/orders`, `/orders/{id}`, `/orders/{id}/timeline` | |
| POST | `/orders/{id}/requeue`, `/resolve`, `/cancel` | แอดมินจัดการออเดอร์ |
| POST | `/webhooks/payment` | ธนาคารแจ้งชำระ (HMAC) |
| POST | `/dev/orders/{id}/pay` | จำลองธนาคาร (demo เท่านั้น) |
| POST | `/agent/claim`, `/agent/orders/{id}/lease`, `/complete`, `/fail` | bot agent |

Error ทุกตัวใช้รูปแบบเดียว: `{ "code": "SYSTEM_PAUSED", "message": "...", "request_id": "..." }`

---

## โครงสร้างโค้ด

```text
src/
  orders/       state-machine.ts (เส้นทางสถานะ), retry-policy.ts, orders.service.ts
  agent/        work.service.ts — claim / lease / complete / fail / provider จำลอง
  bots/         bots.service.ts (สถานะ + summary), commands.service.ts (คิวคำสั่ง), simulator.client.ts
  deploy/       อัปโหลดและส่งอัปเดตโค้ด
  system/       kill-switch
  webhooks/     webhook ธนาคาร
  realtime/     WebSocket agent + dashboard, snapshot
  jobs/         งานเบื้องหลัง
  api/          controllers
agent/          bot agent จำลอง (bot-agent.ts) + fleet.ts รันหลายเครื่อง
public/         dashboard (HTML + JS ไม่มี build step)
db/             schema.sql, seed.sql (จาก pack) + migrations/
test/           unit + integration (Postgres จริง)
requests/       oxide.http + ไฟล์ zip ตัวอย่าง
```

---

## การใช้ AI

โปรเจกต์นี้พัฒนาร่วมกับ AI (Claude Code) ตามที่โจทย์อนุญาต แนวทางที่ใช้เพื่อไม่ให้เชื่อผลจาก AI โดยไม่ตรวจ:

- **อ่านโจทย์และ candidate pack ก่อนเขียนโค้ด** แล้วระบุจุดที่ขัดกัน (schema, simulator) และตัดสินใจพร้อมเหตุผลในหัวข้อด้านบน แทนการเดา
- **ทุกเคสปัญหามี integration test บน Postgres จริง** ไม่ใช้ mock ฐานข้อมูล เพราะเคส concurrency (`SKIP LOCKED`, `FOR SHARE`, unique index) mock ไม่ได้
- **ตรวจว่าเทสต์วัดได้จริง (mutation check):** ลองเอา `FOR SHARE` ออกจาก claim → เทสต์ kill-switch แข่งกับ claim **พัง** ตามที่ควร แล้วจึงใส่กลับ
- **รันระบบจริงครบทุกเคส** (Docker Compose + บอท 3 เครื่อง + simulator) ก่อนเขียน README: ปิด process บอทจริงเพื่อดู heartbeat timeout, เปิดเครื่องที่ออฟไลน์กลับมาเพื่อดูว่าได้อัปเดตโค้ดที่ค้าง
- เทสต์ที่เขียนพังในรอบแรก 1 ตัวเพราะข้อมูลทดสอบผิด (validation ของ API ถูกต้องแล้ว) — แก้ที่เทสต์ ไม่ใช่ลดความเข้มของ API
- **review โค้ดซ้ำหลังเสร็จ** แล้วพบ race condition 2 จุดที่เทสต์ชุดแรกไม่ครอบคลุม (บอทเดียวรับหลายออเดอร์พร้อมกัน, สถานะ deployment `sent` ทับ `applied`) — เขียนเทสต์ที่ทำให้บั๊กเกิดซ้ำได้ก่อน เห็นเทสต์พัง แล้วจึงแก้

## ข้อจำกัด

- Authentication ใช้ token คงที่ (admin / agent) — production ควรใช้ระบบ login + token ต่อเครื่อง และ token ของ WebSocket ส่งผ่าน query string (browser ตั้ง header ไม่ได้) ควรเปลี่ยนเป็น ticket อายุสั้น
- Provider เติมเกมและธนาคารเป็นของจำลอง (`/agent/provider/topup`, `/dev/orders/{id}/pay`)
- เก็บไฟล์ zip ในฐานข้อมูล (`bytea`, จำกัด 20 MB) — ไฟล์ใหญ่ควรย้ายไป object storage
- ยังไม่มีระบบคืนเงิน: ออเดอร์ที่จ่ายหลังหมดเวลาค้างเป็น `EXPIRED` + alert ให้แอดมินคืนเงินเอง
- agent จำลองแตก zip และสลับเวอร์ชันจริง แต่ตัว agent ไม่ได้รันโค้ดจากแพ็กเกจ (logic บอทจำลองอยู่ใน agent เอง) — บอทจริงต้อง restart process ให้โหลดโค้ดจาก `releases/<version>/` หลังสลับ `current.json`
