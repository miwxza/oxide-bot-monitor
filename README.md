# Oxide Bot Monitor

ระบบศูนย์กลางสำหรับดูแลเครื่องบอทเติมเกมหลายเครื่อง และติดตามออเดอร์ตั้งแต่ชำระเงินจนเติมสำเร็จ

สิ่งที่ทำได้
- ดูสถานะทุกเครื่องแบบ real-time: heartbeat, สถานะบอท, งานล่าสุด, CPU/RAM, เวอร์ชันโค้ด
- Kill-switch ปิดรับงานทั้งระบบ, เปิด/ปิด/รีสตาร์ตบอทรายเครื่อง
- อัปโหลดโค้ดบอทเป็นไฟล์ zip แล้วอัปเดตทุกเครื่องหรือเลือกบางเครื่อง
- Order state machine `PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED` และจัดการออเดอร์เองเมื่อเครื่องหลุด

ใช้ Node.js 24, NestJS 11, PostgreSQL 16 (เขียน SQL ตรงผ่าน `pg`), WebSocket (`ws`), Jest และ Docker Compose

## เริ่มใช้งาน

```bash
docker compose up -d --build
```

- Dashboard: http://localhost:3000
- Swagger: http://localhost:3000/docs (header `X-Admin-Token: dev-admin-token`)
- Bot Simulator ของ candidate pack: http://localhost:8788/bots

ถ้าเปิด `localhost` ไม่ขึ้น ให้ใช้ `http://127.0.0.1:3000` แทน (Docker Desktop บน Windows บางเครื่องส่งต่อ IPv6 ไม่ได้)

Compose มี 4 service คือ `postgres` และ `simulator` จาก candidate pack (ไม่ได้แก้ไฟล์), `api` และ `agents` ซึ่งเป็นบอทจำลอง 3 เครื่อง (`bot-01` ถึง `bot-03`) แยก process กัน

ปิดระบบด้วย `docker compose down` ถ้าต้องการล้างข้อมูลด้วยให้ใส่ `-v`

### รันโดยไม่ใช้ Docker

ยังต้องใช้ Postgres จาก Docker อยู่

```bash
docker compose up -d postgres
npm install
npm run build
npm run simulator   # terminal ที่ 1
npm start           # terminal ที่ 2
npm run agents      # terminal ที่ 3
```

ค่าตั้งทั้งหมดอยู่ใน `.env.example` token ในไฟล์เป็นค่าสำหรับ dev เท่านั้น

### Live demo

ยังไม่ได้ deploy (จะใส่ลิงก์ที่นี่)

`render.yaml` สร้าง web service กับ PostgreSQL แบบฟรีบน Render แผนฟรีมีได้ container เดียว จึงรัน simulator, API และบอท 3 เครื่องไว้ด้วยกันผ่าน `node dist/agent/demo.js` ส่วน Docker Compose ยังแยก service ตามโครงสร้างจริง

token บน Render ถูกสุ่มใหม่ ไม่ใช่ค่า `dev-...` ใน repo ให้กดปุ่ม "ตั้งค่า Token" บน dashboard แล้วใส่ `ADMIN_TOKEN` จากหน้า Environment ของ Render แผนฟรีจะหยุดเมื่อไม่มีคนใช้ request แรกอาจรอประมาณ 1 นาที

## การทดสอบ

```bash
docker compose run --rm --build test
```

มีทั้งหมด 77 เทสต์ (unit 33, integration 44) integration test รันกับ PostgreSQL จริงทุกตัว ใช้เวลาประมาณ 1 นาที

ถ้ามี Node ในเครื่อง รัน `docker compose up -d postgres` แล้ว `npm test` ได้เหมือนกัน เทสต์จะสร้างฐานข้อมูล `oxide_test` แยกไว้ให้

ทดสอบ API ทีละคำสั่งได้จาก `requests/oxide.http` (VS Code + REST Client) ไฟล์เรียงตามหัวข้อ เปิด dashboard ไว้ดูผลไปพร้อมกันได้

### ลองเคสต่าง ๆ บน dashboard

ในกล่องออเดอร์มีฟอร์มสร้างออเดอร์และจ่ายเงินจำลอง บอทจะทำงานต่างกันตาม UID ที่เลือก

| UID | ผล |
|---|---|
| `12345678` | `COMPLETED` |
| `INVALID001` | `FAILED` ทันที |
| `FLAKY001` | ลองใหม่ 3 ครั้งแล้วเป็น `DELAYED` พร้อม alert |
| `UNKNOWN001` | `DELAYED` ทันที |
| `HANG001` | บอทเงียบจน lease หมด ออเดอร์กลับเข้าคิว ครบ 3 ครั้งเป็น `DELAYED` |
| `TOPUPCRASH001` | บอทล่มหลังเติม รอบที่สองไม่เติมซ้ำและจบที่ `COMPLETED` (ดูได้ในประวัติ) |

อยากลองเครื่องหลุดให้รัน `docker compose stop agents` ประมาณ 15 วินาทีการ์ดทุกเครื่องจะเป็นออฟไลน์ แล้วเปิดกลับด้วย `docker compose start agents`

อยากลองอัปเดตโค้ดให้อัปโหลด `requests/sample-package.zip` แล้วกด "อัปเดตทุกเครื่อง" ออเดอร์ถัดไปจะแสดง `oxide-bot@2.0.0` ในประวัติ

## ภาพรวมระบบ

```text
                  Dashboard (browser)
          REST สั่งงาน · WebSocket /ws/dashboard
                          │
Bot agent ×3 ── REST /agent/* ──►  API (NestJS)  ──► Bot Simulator
             ◄─ WebSocket /ws/agent ─  + jobs     ◄── GET /bots ทุก 3 วินาที
                                          │
ธนาคาร ── POST /webhooks/payment ────────┤
                                          ▼
                                      PostgreSQL
```

| ช่องทาง | ใช้ทำอะไร |
|---|---|
| WebSocket `/ws/agent` | agent ส่ง heartbeat ทุก 3 วินาที server ส่ง kill-switch, แจ้งงานใหม่ และคำสั่งอัปเดตโค้ด |
| REST `/agent/*` | รับงาน ต่อ lease จบงาน รายงาน error ใช้ REST เพราะการเปลี่ยนสถานะออเดอร์ต้องได้คำตอบชัดเจนว่าผ่านหรือ 409 |
| WebSocket `/ws/dashboard` | ส่งข้อมูลทั้งหน้าเมื่อมีอะไรเปลี่ยน (รวบเหตุการณ์ที่เกิดติดกันใน 200ms) ข้อมูลไม่กี่ KB ส่งทั้งก้อนจึงไม่ต้องห่วงลำดับ event |
| Poll simulator | ดึง CPU, RAM, uptime และสถานะ process เพราะ simulator ไม่มีช่องทาง push |
| Background jobs | ทุก 2 วินาที: หมดเวลาชำระ, เครื่องหลุด, lease หมด, SLA, ส่งคำสั่ง, ส่งอัปเดตโค้ด ใช้ row lock ของ Postgres แทน message queue |

### Simulator กับ agent ต่างกันอย่างไร

simulator ใน candidate pack รับได้แค่ `start/stop/restart/status` ไม่มี heartbeat ไม่รับออเดอร์ และไม่มีคำสั่งอัปเดตโค้ด จึงแบ่งหน้าที่แบบนี้

- simulator คือตัวจัดการ process ของบอทบนเครื่อง ปุ่มเปิด/ปิด/รีสตาร์ตบอทส่งคำสั่งไปที่ simulator และ CPU/RAM มาจาก simulator
- agent (`agent/bot-agent.ts`) คือโปรแกรมที่อยู่บนเครื่อง ส่ง heartbeat รับงาน และติดตั้งโค้ดใหม่

เครื่องจะรับงานได้เมื่อ heartbeat ของ agent ยังสด และ simulator บอกว่า process เปิดอยู่

### สถานะบน dashboard

| สถานะ | เงื่อนไข |
|---|---|
| เครื่องออนไลน์ | heartbeat ล่าสุดไม่เกิน 15 วินาที |
| เปิดรับงาน | ออนไลน์, process เปิด, ระบบไม่ได้ถูก kill-switch และไม่มีงานค้าง |
| รอรับงาน (Standby) | ออนไลน์ แต่ process ปิดอยู่ หรือระบบถูก kill-switch |
| กำลังทำงาน | ถือออเดอร์ `IN_PROGRESS` อยู่ |
| เครื่องออฟไลน์ | heartbeat ขาด |

สถานะเหล่านี้คำนวณตอนอ่าน ไม่ได้เก็บแยกในตาราง ข้อมูลจึงไม่หลุดจากความจริง

## Schema และจุดที่โจทย์ขัดกัน

ไม่ได้แก้ `db/schema.sql` และ `db/seed.sql` ของ pack ส่วนที่เพิ่มอยู่ใน `db/migrations/` API รัน migration ให้ตอนเริ่มและบันทึกไว้ใน `schema_migrations`

**README ของ pack บอกว่าไม่ต้องทำ migration เพิ่ม** แต่ `orders.status` ในไฟล์ที่ให้มามีแค่ `pending/processing/completed/failed/cancelled` ไม่มี `QUEUED` และ `DELAYED` ที่ PDF กำหนด ผมเลือกเพิ่ม migration ที่แก้ CHECK constraint และแปลงข้อมูลเดิม (`pending` เป็น `PENDING_PAYMENT`, `processing` เป็น `IN_PROGRESS`) เพราะ PDF คือข้อกำหนดของระบบ และประโยคใน pack อ่านได้ว่า "ไม่จำเป็น" มากกว่า "ห้าม" การให้ฐานข้อมูลบังคับสถานะเองปลอดภัยกว่าเช็กในโค้ดอย่างเดียว

**`oxide_bot_commands` รับคำสั่งแค่ 4 แบบ** จึงไม่ยัดการอัปเดตโค้ดลงตารางนี้ แยกไปเป็น `bot_deployments` เพราะมีขั้นตอนต่างกัน (รอส่ง, ส่งแล้ว, ติดตั้งแล้ว, ไม่สำเร็จ และต้องรอ agent ยืนยัน) ส่วน kill-switch เก็บใน `system_settings`

**PDF ให้เลือก WebSocket, gRPC หรือ MQTT** เลือก WebSocket เพราะทำงานบน HTTP server เดียวกับ API, browser ใช้ได้ตรง ๆ และไม่ต้องเพิ่ม broker

ตารางที่เพิ่ม: `system_settings`, `code_packages`, `bot_deployments`, `webhook_events`, `provider_topups`, `alerts` และคอลัมน์ lease, attempts, version ใน `orders`

## Order state machine

```text
PENDING_PAYMENT ── จ่ายแล้ว ──► QUEUED ── บอทรับงาน ──► IN_PROGRESS ── เติมสำเร็จ ──► COMPLETED
      │                          ▲                         │
      └ หมดเวลาชำระ ► EXPIRED ───┘ (จ่ายทันแต่ webhook ช้า)  ├ เครื่องหลุด/error ชั่วคราว ► QUEUED
                                                            ├ ลองครบแล้ว/ผลไม่แน่นอน ► DELAYED ► แอดมินตัดสิน
                                                            └ error ถาวร ► FAILED ► แก้แล้วกลับเข้าคิว
```

การเปลี่ยนสถานะทุกครั้งผ่าน `transition()` ใน `src/orders/state-machine.ts` ซึ่งตรวจว่าเส้นทางนั้นอนุญาตไหม อัปเดตด้วยเงื่อนไข `WHERE status = <สถานะเดิม>` ถ้ามีใครเปลี่ยนไปก่อนจะได้ 409 แทนการเขียนทับ และบันทึก `order_events` ใน transaction เดียวกัน timeline ของออเดอร์จึงตรงกับสถานะจริงเสมอ

## การแก้เคสปัญหา

### 1. เครื่องหลุดหรือบอทเงียบ

บอทที่รับงานจะได้ lease 30 วินาทีและต้องต่อ lease ระหว่างทำงาน job จะตรวจทุก 2 วินาที ถ้าเครื่องที่ถือออเดอร์ heartbeat ขาดเกิน 15 วินาที จะจัดการออเดอร์นั้นทันทีโดยไม่ต้องรอ lease หมด ถ้าเครื่องยังออนไลน์แต่ไม่ต่อ lease จะจัดการตอน lease หมด

ถ้ายังลองได้อีก ออเดอร์กลับเข้าคิวให้เครื่องอื่นรับ (รอ 10 และ 20 วินาที) ครบ 3 ครั้งแล้วเป็น `DELAYED` และแจ้งแอดมิน lease เดิมใช้ไม่ได้อีก เครื่องที่กลับมาแล้วพยายามจบงานเดิมจะได้ `409 LEASE_LOST` และเครื่องที่ heartbeat ขาดขอรับงานใหม่ไม่ได้

PDF ให้เปลี่ยนเป็น `DELAYED` หรือ `FAILED` ผมให้เครื่องอื่นลองก่อนเพราะมีหลายเครื่อง และใช้ `DELAYED` เมื่อครบจำนวนครั้ง เพราะลูกค้าจ่ายเงินแล้วและเราไม่รู้ว่าเครื่องที่ล่มเติมไปหรือยัง ต้องให้คนตรวจก่อน `FAILED` ใช้เฉพาะ error ที่รู้แน่ว่าเติมไม่ได้

### 2. หลายเครื่องแย่งออเดอร์ หรือเติมซ้ำ

การรับงานใช้ `SELECT ... FOR UPDATE SKIP LOCKED` บอทที่ขอพร้อมกันจะได้ออเดอร์คนละตัวโดยไม่ต้องรอกัน

เครื่องหนึ่งถือได้ทีละออเดอร์ ตอนรับงานจะล็อกแถวของบอทด้วย `FOR UPDATE` ให้คำขอจากเครื่องเดียวกันต่อคิว และมี unique index บน `orders(assigned_bot_id) WHERE status = 'IN_PROGRESS'` กันไว้อีกชั้นในฐานข้อมูล ตอนแรกใช้ `FOR SHARE` ซึ่งหลาย transaction ถือพร้อมกันได้ เทสต์ที่ยิงคำขอจากเครื่องเดียว 5 ครั้งพร้อมกันได้ไปครบ 5 ออเดอร์ จึงแก้ทั้งสองชั้นและเก็บเทสต์นั้นไว้

ทุกออเดอร์มี `topup_key` ที่ไม่เปลี่ยนตลอดทุกครั้งที่ลอง และส่งให้ provider ทุกครั้ง ถ้าเครื่องแรกเติมแล้วล่มก่อนรายงานผล เครื่องถัดไปใช้ key เดิม provider จะตอบว่าเติมไปแล้วจึงไม่เติมซ้ำ การจบงานต้องถือ lease ปัจจุบันและต้องมีบันทึกการเติมที่ provider (`409 TOPUP_NOT_FOUND`) เรียกซ้ำด้วย token เดิมได้ผลเดิม

row lock ของ Postgres พอสำหรับคิวขนาดนี้ จึงไม่เพิ่ม Redis หรือ message queue ส่วนการกันเติมซ้ำต้องพึ่ง idempotency ฝั่ง provider เพราะฐานข้อมูลของเราไม่รู้ผลจริงที่เกิดภายนอก

### 3. Kill-switch, คำสั่งซ้ำ และการอัปเดตที่ซ้อนกัน

kill-switch บังคับที่ server ตอนรับงาน ไม่ได้แค่ส่งข้อความบอกบอท ตอนรับงานจะอ่าน `system_settings` ด้วย `FOR SHARE` ใน transaction เดียวกับการจองออเดอร์ ส่วนการกด kill-switch ล็อกแถวเดียวกันด้วย `FOR UPDATE` หลังกดปิดและ commit แล้ว จะไม่มีคำขอไหนรับงานได้อีก คำขอที่กำลังแข่งกันจะรอ lock แล้วเห็นค่าใหม่ งานที่รับไปก่อนหน้าทำต่อจนจบ เพื่อไม่ตัดกลางการจ่ายเงิน ถ้าส่งผ่าน WebSocket อย่างเดียวจะมีช่วงที่ข้อความยังไปไม่ถึงเครื่องและเครื่องยังรับงานได้

คำสั่งเปิด/ปิด/รีสตาร์ตเข้าคิวก่อน แล้ว executor ค่อยส่งให้ simulator รองรับ `Idempotency-Key` กดซ้ำหรือ network retry จะได้คำสั่งเดิม และเครื่องหนึ่งมีคำสั่งค้างได้ทีละคำสั่ง ถ้ากด start กับ stop พร้อมกัน ตัวหนึ่งจะได้ `409 COMMAND_IN_PROGRESS`

การอัปเดตโค้ด
- อัปโหลดไฟล์เดิมซ้ำได้แพ็กเกจเดิม (เทียบ sha256) เครื่องหนึ่งมีการอัปเดตที่ยังไม่จบได้ทีละอัน และเครื่องที่ใช้เวอร์ชันนั้นอยู่แล้วจะได้ `already_current`
- server บันทึกสถานะ "ส่งแล้ว" ก่อนส่งคำสั่ง ถ้าส่งไม่ถึงเพราะเครื่องออฟไลน์ค่อยคืนเป็น "รอส่ง" ตอนแรกบันทึกหลังส่ง ถ้า agent ตอบกลับเร็วมาก สถานะ "ติดตั้งแล้ว" จะโดนทับ มีเทสต์จำลองจังหวะนี้ไว้
- agent ดาวน์โหลดไฟล์ ตรวจ sha256 แตก zip ลงโฟลเดอร์ชั่วคราว (กันชื่อไฟล์แบบ `../` และ zip ที่แตกแล้วใหญ่ผิดปกติ) ลองโหลดโค้ดบอทจากแพ็กเกจ ถ้าผ่านจึงย้ายไปเป็น `releases/<version>/` และสลับ `current.json` ออเดอร์ถัดไปจะใช้โค้ดใหม่ แพ็กเกจที่โหลดไม่ได้จะถูกปฏิเสธ และเครื่องใช้เวอร์ชันเดิมต่อ
- agent ไม่สลับโค้ดระหว่างทำออเดอร์ จะรอให้งานที่ถืออยู่จบ จำเวอร์ชันข้ามการรีสตาร์ต และส่งเวอร์ชันจริงมากับทุก heartbeat ถ้าเครื่องเสียไฟล์ที่ติดตั้งไว้ server จะรู้และ deploy ใหม่ได้
- ออเดอร์ที่จบจะบันทึก `bot_version` ไว้ในประวัติ ตรวจย้อนหลังได้ว่าโค้ดเวอร์ชันไหนทำงานนั้น

คำสั่งทุกอย่างของแอดมินบันทึกใน `audit_logs` พร้อมชื่อคนกด (`X-Actor`)

#### รูปแบบแพ็กเกจโค้ดบอท

ตัวอย่างอยู่ใน `requests/sample-package/` (zip แล้วคือ `requests/sample-package.zip`)

```js
// package.json: { "name": "oxide-bot", "version": "2.0.0", "main": "bot.js" }
module.exports = {
  async run(ctx) {
    // ctx.job, ctx.extendLease(), ctx.topup(), ctx.complete(), ctx.fail(code, msg), ctx.sleep(ms), ctx.log(msg)
  },
};
```

agent ดูแลการเชื่อมต่อ heartbeat การรับงาน lease และการติดตั้ง ส่วนโค้ดบอททำงานผ่าน `ctx` อย่างเดียว จึงอัปเดตโค้ดบอทได้โดยไม่ต้องอัปเดต agent ถ้าโค้ดบอทโยน error agent จะรายงานเป็น `BOT_CODE_ERROR` และให้ลองใหม่แบบจำกัดครั้ง เครื่องที่ยังไม่เคยได้รับแพ็กเกจใช้โค้ดในตัว (`agent/builtin-bot.ts`)

### 4. Webhook ธนาคารซ้ำ มาช้า หรือใช้เงินก้อนเดิม

- ตรวจ HMAC-SHA256 ของ raw body จาก header `X-Signature`
- เก็บ `event_id` ใน transaction เดียวกับการเปลี่ยนสถานะ event ที่ส่งซ้ำจึงไม่ถูกประมวลผลซ้ำ
- unique index บน `payment_txn_id` ทำให้เงินก้อนเดียวจ่ายได้ออเดอร์เดียว
- ตัดสินว่าจ่ายทันหรือไม่จาก `paid_at` ของธนาคาร ไม่ใช่เวลาที่ webhook มาถึง ถ้าจ่ายทันแต่ออเดอร์ถูกเปลี่ยนเป็น `EXPIRED` ไปแล้ว จะกลับเข้าคิว ถ้าจ่ายหลังหมดเวลาจะคง `EXPIRED` และแจ้งแอดมินให้คืนเงิน
- ยอดไม่ตรง หรือออเดอร์ถูกจ่ายด้วยเงินอีกก้อน จะไม่ยืนยันการชำระและแจ้งแอดมิน

### 5. Error ระหว่างเติม และออเดอร์ค้าง

server เป็นคนตัดสินว่า error แต่ละแบบต้องทำอะไร (`src/orders/retry-policy.ts`) ทุกเครื่องจึงใช้เกณฑ์เดียวกัน

| ประเภท | ตัวอย่าง | ผล |
|---|---|---|
| ถาวร | `INVALID_UID`, `UID_REGION_MISMATCH` | `FAILED` ทันที |
| ชั่วคราว | `PROVIDER_TIMEOUT`, `BOT_HEARTBEAT_TIMEOUT`, `LEASE_EXPIRED`, `BOT_CODE_ERROR` | กลับเข้าคิวแบบเว้นระยะ ครบ 3 ครั้งเป็น `DELAYED` |
| ผลไม่แน่นอน | `TOPUP_STATUS_UNKNOWN` | `DELAYED` ทันที ถ้าลองเองอาจเติมซ้ำ |
| ไม่รู้จัก | อื่น ๆ | ถือเป็นชั่วคราว มีเพดานและจบที่ `DELAYED` ให้คนตรวจ |

job อื่น ๆ: ออเดอร์ที่ไม่จ่ายเกินเวลาเป็น `EXPIRED` และออเดอร์ที่รอในคิวนานเกิน SLA จะแจ้งแอดมิน (ไม่แจ้งซ้ำ)

คำสั่งที่ส่งไป simulator ถ้า network error หรือได้ 5xx จะลองใหม่ 3 ครั้ง ถ้าได้ 4xx ถือว่าไม่สำเร็จทันที คำสั่งที่ค้างอยู่สถานะกำลังส่งนานผิดปกติ (process ตายกลางทาง) จะกลับเข้าคิว

แอดมินจัดการออเดอร์ `DELAYED` และ `FAILED` ได้ด้วย `requeue` (เริ่มนับครั้งใหม่) และ `resolve` (ตัดสินเป็น `COMPLETED` หรือ `FAILED` หลังตรวจกับ provider)

## API หลัก

แอดมินใช้ header `X-Admin-Token` และ `X-Actor` (ชื่อคนกด) ส่วน agent ใช้ `X-Agent-Token` กับ `X-Bot-Id` รายละเอียดครบอยู่ใน Swagger

| Method | Path | |
|---|---|---|
| GET | `/dashboard` | ข้อมูลทั้งหน้า dashboard |
| GET | `/bots`, `/bots/{id}` | รายการเครื่อง, รายละเอียดเครื่อง (log, metrics, คำสั่ง, อัปเดตโค้ด, audit) |
| POST | `/bots/{id}/commands` | `start`, `stop`, `restart`, `status` รับ `Idempotency-Key` ตอบ 202 |
| GET | `/commands/{id}` | สถานะคำสั่ง |
| PUT | `/system/kill-switch` | `{"accepting_orders": false}` ปิดรับงานทั้งระบบ |
| POST | `/packages` | อัปโหลด zip (multipart field `file`) |
| POST | `/packages/{id}/deploy` | อัปเดตทุกเครื่อง หรือส่ง `{"bot_ids": [...]}` |
| GET | `/deployments`, `/alerts`, `/audit-logs` | |
| POST | `/orders` | สร้างออเดอร์ `external_order_id` ใช้เป็น idempotency key (201, 200, 409) |
| GET | `/orders`, `/orders/{id}`, `/orders/{id}/timeline` | |
| POST | `/orders/{id}/requeue`, `/resolve`, `/cancel` | แอดมินจัดการออเดอร์ |
| POST | `/webhooks/payment` | ธนาคารแจ้งชำระเงิน |
| POST | `/dev/orders/{id}/pay` | จำลองธนาคาร ใช้ทดสอบเท่านั้น |
| POST | `/agent/claim`, `/agent/orders/{id}/lease`, `/complete`, `/fail` | สำหรับ agent |

error ทุกตัวตอบรูปแบบเดียวกัน `{ "code": "SYSTEM_PAUSED", "message": "...", "request_id": "..." }`

## โครงสร้างโค้ด

```text
src/
  orders/     state machine, retry policy, order service
  agent/      รับงาน, lease, จบงาน, provider จำลอง
  bots/       สถานะเครื่อง, คิวคำสั่ง, client ของ simulator
  deploy/     อัปโหลดและส่งอัปเดตโค้ด
  system/     kill-switch
  webhooks/   webhook ธนาคาร
  realtime/   WebSocket ของ agent และ dashboard
  jobs/       งานเบื้องหลัง
  api/        controllers
agent/        bot-agent.ts, installer.ts (ติดตั้ง zip), bot-module.ts (โหลดโค้ดบอท),
              builtin-bot.ts (โค้ดบอทในตัว), fleet.ts (รันหลายเครื่อง)
public/       dashboard (HTML + JS)
db/           schema.sql, seed.sql จาก pack และ migrations/
test/         unit และ integration
requests/     oxide.http, sample-package/ และ sample-package.zip
```

## การใช้ AI

ใช้ Claude Code ช่วยพัฒนาตามที่โจทย์อนุญาต ขั้นตอนที่ใช้ตรวจงานที่ได้จาก AI

- อ่านโจทย์และ candidate pack ก่อนเริ่ม แล้วตัดสินใจเรื่องที่โจทย์ขัดกันเอง (schema, บทบาทของ simulator) พร้อมเขียนเหตุผลไว้ในหัวข้อด้านบน
- เคสปัญหาทุกข้อมีเทสต์บน PostgreSQL จริง ไม่ mock ฐานข้อมูล เพราะเรื่องอย่าง `SKIP LOCKED`, `FOR UPDATE` หรือ unique index mock แล้วไม่ได้ทดสอบอะไรจริง
- เช็กว่าเทสต์จับบั๊กได้จริง เช่น ลองเอาการล็อก `system_settings` ตอนรับงานออก เทสต์ kill-switch พังตามที่ควร แล้วค่อยใส่กลับ
- รันระบบจริงด้วย Docker Compose ก่อนเขียน README ทั้งปิด process บอทเพื่อดู heartbeat timeout และอัปเดตโค้ดให้เครื่องที่เพิ่งกลับมาออนไลน์
- ตอนทบทวนโค้ดรอบหลังเจอ race condition 2 จุดที่เทสต์ชุดแรกไม่ครอบคลุม คือเครื่องเดียวรับหลายออเดอร์พร้อมกัน และสถานะ deployment ถูกทับ เขียนเทสต์ให้บั๊กเกิดซ้ำได้ก่อน เห็นเทสต์พังแล้วจึงแก้
- ตอนทดสอบอัปเดตโค้ดกับ Docker พบว่าเครื่องที่เสียไฟล์ติดตั้ง deploy ใหม่ไม่ได้ เพราะ server ยังจำเวอร์ชันเก่า แก้ให้ agent ส่งเวอร์ชันจริงทุก heartbeat และเก็บไฟล์ติดตั้งไว้ใน volume

## ข้อจำกัด

- ใช้ token คงที่สำหรับแอดมินและ agent ถ้าใช้งานจริงควรมีระบบ login และ token แยกต่อเครื่อง token ของ WebSocket ส่งผ่าน query string เพราะ browser ตั้ง header ไม่ได้ ควรเปลี่ยนเป็น ticket อายุสั้น
- provider เติมเกมและธนาคารเป็นของจำลอง
- เก็บไฟล์ zip ในฐานข้อมูล (จำกัด 20 MB) ไฟล์ใหญ่ควรย้ายไป object storage
- ยังไม่มีระบบคืนเงิน ออเดอร์ที่จ่ายหลังหมดเวลาค้างที่ `EXPIRED` และแจ้งให้แอดมินคืนเงินเอง
- โค้ดบอทจากแพ็กเกจรันใน process เดียวกับ agent ถ้าใช้งานจริงควรแยก process หรือ sandbox และจำกัดสิทธิ์ เพราะแพ็กเกจคือโค้ดที่รันได้ ตอนนี้กันไว้ด้วยการให้เฉพาะแอดมินอัปโหลดและตรวจ sha256
