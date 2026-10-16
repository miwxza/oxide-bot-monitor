# Oxide Bot Monitor

ระบบดูแลบอทเติมเกมหลายเครื่องจากหน้าเดียว ดูสถานะ สั่งเปิด/ปิด อัปเดตโค้ด และติดตามออเดอร์ตั้งแต่รอชำระเงินจนจบงาน

ใช้ Node.js 24, NestJS 11, PostgreSQL 16, WebSocket และ Jest หน้า Dashboard เขียนด้วย HTML, CSS และ JavaScript

## เริ่มใช้งาน

ต้องมี Docker และ Docker Compose เปิด terminal ในโฟลเดอร์โปรเจกต์แล้วรัน:

```bash
docker compose up -d --build
```

| หน้า | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Swagger | http://localhost:3000/docs |
| Bot Simulator | http://localhost:8788/bots |

หากเปิดผ่าน `localhost` ไม่ได้ ลองใช้ `127.0.0.1` แทน บน Dashboard กด **ตั้งค่า Token** แล้วใส่ `dev-admin-token` ส่วน Swagger ใช้ header `X-Admin-Token` ค่าเดียวกัน

Compose เปิด PostgreSQL, simulator, API และ agent จำลอง 3 ตัว (`bot-01` ถึง `bot-03`) โดย agent แต่ละตัวเป็น process แยกกัน CPU/RAM บนหน้าจอมาจาก simulator ไม่ใช่ค่าการใช้งานจริงของเครื่อง

```bash
# ปิดระบบ โดยเก็บข้อมูลไว้
docker compose down

# หลังแก้โค้ด ให้ build และเปิดใหม่
docker compose up -d --build
```

หากใช้ `docker compose down -v` จะลบทั้งข้อมูล PostgreSQL และแพ็กเกจที่ agent ติดตั้งไว้ด้วย

### รันแอปบนเครื่องโดยตรง

ต้องมี Node.js 24 และยังใช้ PostgreSQL จาก Docker:

```bash
docker compose up -d postgres
npm ci
npm run build
```

เปิดอีก 3 terminal ในโฟลเดอร์โปรเจกต์:

```bash
npm run simulator   # terminal 1
npm start           # terminal 2
npm run agents      # terminal 3
```

ค่าเริ่มต้นใช้กับ PostgreSQL และ simulator ที่รันตามคำสั่งข้างบนได้เลย ตัวแปรที่ปรับได้อยู่ใน `.env.example` แอปอ่านจาก environment ของ process ไม่ได้โหลดไฟล์ `.env` ให้อัตโนมัติ ส่วน Compose ตั้งค่าผ่าน `environment` ใน `docker-compose.yml`

## ทดสอบ

### เทสต์อัตโนมัติ

```bash
docker compose run --rm --build test
```

ผลตรวจล่าสุดผ่าน **77/77 กรณี ใน 6 ชุด** แบ่งเป็น unit 33 และ integration 44 โดย integration tests ใช้ PostgreSQL จริงและฐานข้อมูล `oxide_test` แยกจากข้อมูล demo เวลารันขึ้นกับเครื่อง รอบที่ตรวจใช้ประมาณ 1 นาที

หากติดตั้ง dependencies บนเครื่องแล้ว รันได้อีกทาง:

```bash
docker compose up -d postgres
npm test
```

เทสต์ครอบคลุม state machine, retry, webhook, การแย่งรับงาน, kill-switch, คำสั่งบอท และการติดตั้ง/โหลดโค้ดจากแพ็กเกจ

### ลองผ่าน Dashboard

เลือก UID ในฟอร์มสร้างออเดอร์ demo แล้วกดสร้างรายการ การชำระเงินและการเติมเกมในโปรเจกต์นี้เป็นของจำลอง

| UID | ผลที่ควรเห็น |
|---|---|
| `12345678` | จบที่ `COMPLETED` |
| `INVALID001` | `FAILED` เพราะ UID ไม่ถูกต้อง |
| `FLAKY001` | ทำงานรวมไม่เกิน 3 ครั้ง แล้วเป็น `DELAYED` พร้อมแจ้งเตือน |
| `UNKNOWN001` | `DELAYED` ทันที เพื่อรอตรวจผลก่อนส่งซ้ำ |
| `HANG001` | ไม่ต่อ lease งานกลับเข้าคิว และเป็น `DELAYED` เมื่อครบ 3 ครั้ง |
| `TOPUPCRASH001` | จำลองล่มหลังเติม ครั้งถัดไปใช้ key เดิมเพื่อไม่เติมซ้ำ แล้วจบที่ `COMPLETED` |

กด **ประวัติ** เพื่อตรวจการเปลี่ยนสถานะและเหตุผลของแต่ละรายการ หรือใช้ `requests/oxide.http` กับ REST Client ใน VS Code เพื่อเรียก API ทีละขั้น

**ทดสอบเครื่องหลุด**

```bash
docker compose stop agents
```

รอประมาณ 15–20 วินาที เครื่องควรเป็นออฟไลน์และมีแจ้งเตือน จากนั้นเปิดกลับ:

```bash
docker compose start agents
```

**ทดสอบอัปเดตโค้ด**

อัปโหลด `requests/sample-package.zip` แล้วสั่งอัปเดตรายเครื่องหรือทุกเครื่อง สร้างออเดอร์ใหม่หลังอัปเดตเสร็จ ในประวัติงานที่สำเร็จควรมี `bot_version` เป็น `oxide-bot@2.0.0`

แพ็กเกจที่ไม่มีฟังก์ชัน `run(ctx)` จะถูกปฏิเสธ เครื่องยังใช้โค้ดเดิมต่อได้

## การทำงานของระบบ

```text
Dashboard ── REST / WebSocket ── API ── PostgreSQL
                                 │
                     ┌───────────┴───────────┐
                     │                       │
              Agent 3 processes        Bot Simulator
              รับงาน / heartbeat       start / stop / restart
              ติดตั้งโค้ดใหม่           สถานะ process และ metrics
```

| ส่วน | หน้าที่ |
|---|---|
| Dashboard | ดูสถานะและส่งคำสั่งผ่าน REST รับข้อมูลล่าสุดผ่าน WebSocket |
| API | จัดการออเดอร์ คิวคำสั่ง kill-switch แพ็กเกจ และประวัติ |
| Agent | ส่ง heartbeat ทุก 3 วินาที รับงาน ต่อ lease และโหลดโค้ดบอท |
| Simulator จาก candidate pack | จำลองสถานะ process, CPU/RAM และคำสั่ง start/stop/restart/status |
| Background jobs | ตรวจหมดเวลาชำระ heartbeat และ lease รวมถึงส่งคำสั่งและ deployment ที่ค้าง |

เลือก WebSocket เพราะใช้ร่วมกับ HTTP server และ browser ได้โดยไม่ต้องเพิ่ม broker ส่วนการรับงานและรายงานผลใช้ REST เพื่อให้แต่ละคำขอได้ผลตอบกลับชัดเจน

Agent ต้องมี heartbeat ภายใน 15 วินาที และสถานะ process จาก simulator ต้องเป็น `online` จึงจะรับงานได้

| สถานะบน Dashboard | ความหมาย |
|---|---|
| เครื่องออนไลน์ | Heartbeat ยังไม่หมดเวลา |
| เปิดรับงาน | เครื่องออนไลน์ บอทเปิด ระบบรับงาน และไม่มีออเดอร์ที่กำลังทำ |
| รอรับงาน | เครื่องออนไลน์ แต่บอทปิด/กำลังเปลี่ยนสถานะ หรือระบบปิดรับงาน |
| กำลังทำงาน | มีออเดอร์ `IN_PROGRESS` |
| เครื่องออฟไลน์ | Heartbeat หมดเวลา |

สถานะเหล่านี้คำนวณจาก heartbeat, process และออเดอร์เมื่ออ่านข้อมูล

## ออเดอร์และการแก้เคสปัญหา

เส้นทางปกติ:

```text
PENDING_PAYMENT → QUEUED → IN_PROGRESS → COMPLETED
```

`transition()` ใน `src/orders/state-machine.ts` ตรวจเส้นทางที่อนุญาต และบันทึกสถานะกับ `order_events` ใน transaction เดียวกัน หากสถานะเปลี่ยนไปแล้วจะตอบ `409` แทนการเขียนทับ

### 1. เครื่องหลุดหรือบอทเงียบ

เมื่อรับงาน บอทได้ lease 30 วินาทีและต้องต่ออายุระหว่างทำงาน jobs ตรวจทุก 2 วินาที หาก heartbeat ขาดเกิน 15 วินาทีจะจัดการงานโดยไม่รอ lease หมด ส่วนเครื่องที่ยังออนไลน์แต่ไม่ต่อ lease จะถูกตรวจเมื่อ lease หมด

งานที่ลองต่อได้จะกลับเข้า `QUEUED` โดยเว้นระยะ 10 และ 20 วินาที เมื่อทำงานครบ 3 ครั้งจะเป็น `DELAYED` พร้อมแจ้งเตือน Lease ของรอบเก่าจะใช้จบงานไม่ได้อีก (`409 LEASE_LOST`)

เลือก `DELAYED` เมื่อไม่แน่ใจผล เพราะออเดอร์จ่ายเงินแล้ว ต้องให้แอดมินตรวจ ส่วน `FAILED` ใช้กับข้อผิดพลาดถาวรที่ทราบสาเหตุ

### 2. หลายเครื่องแย่งงาน หรือเครื่องเดียวรับงานซ้อน

เลือกออเดอร์ด้วย `FOR UPDATE SKIP LOCKED` เพื่อให้คำขอพร้อมกันได้คนละงาน ส่วนคำขอจากบอทเดียวกันล็อกแถวบอทด้วย `FOR UPDATE` และมี unique index กันการถือหลายออเดอร์ `IN_PROGRESS` อีกชั้น

ทุกออเดอร์ใช้ `topup_key` เดิมตลอดการ retry หากเติมแล้วล่มก่อนรายงานผล ครั้งถัดไป provider จำลองจะตอบว่าเติมไปแล้ว การจบงานต้องมี lease ตรงและมีบันทึกเติมจาก provider ก่อน เรียก complete ซ้ำด้วย token เดิมหลังสำเร็จได้ผลเดิม

วิธีนี้ใช้ row lock ของ PostgreSQL เป็นคิวโดยไม่เพิ่ม Redis ส่วนการกันเติมซ้ำภายนอกระบบต้องอาศัย provider ที่รองรับ idempotency ด้วย

### 3. Kill-switch คำสั่งซ้ำ และอัปเดตซ้อน

Kill-switch ตรวจที่ server ใน transaction รับงาน โดยอ่าน `system_settings` ด้วย `FOR SHARE` ขณะที่การปิดระบบใช้ `FOR UPDATE` หลังปิดและ commit แล้วจะไม่มีการรับงานใหม่ งานที่รับไปก่อนหน้าทำต่อจนจบ

คำสั่ง start/stop/restart เข้าคิวก่อนส่งให้ simulator รองรับ `Idempotency-Key` และอนุญาตคำสั่งค้างได้ทีละรายการต่อเครื่อง หากมีคำสั่งอื่นค้างจะตอบ `409 COMMAND_IN_PROGRESS`

การอัปเดตแพ็กเกจทำตามลำดับนี้:

1. เก็บ ZIP และ sha256 ไฟล์เดิมอัปโหลดซ้ำได้แพ็กเกจเดิม
2. สร้าง deployment รายเครื่อง เครื่องออฟไลน์รอส่งเมื่อเชื่อมต่อกลับ
3. บันทึก `sent` ก่อนส่งคำสั่ง เพื่อไม่ให้เขียนทับ `applied` ที่ agent ตอบเร็ว
4. Agent หยุดรับงานใหม่ ดาวน์โหลดและตรวจ sha256 รองานที่ทำอยู่จบ แล้วแตก ZIP ลงโฟลเดอร์ชั่วคราวและตรวจว่าโหลดโค้ดได้
5. ย้ายไป `releases/<version>/` สลับ `current.json` แล้วโหลดโค้ดใหม่ งานถัดไปเรียก `run(ctx)` ของแพ็กเกจนั้น
6. ส่งผลกลับและรายงานเวอร์ชันใน heartbeat เมื่อเปิด agent ใหม่ก็โหลดแพ็กเกจที่ติดตั้งไว้

เก็บ release ล่าสุด 3 ชุด ใน Docker Compose ไฟล์ติดตั้งอยู่ใน volume `agent_data` จึงไม่หายเมื่อสร้าง container ใหม่ คำสั่งแอดมินมี audit log พร้อมชื่อจาก `X-Actor` ออเดอร์ที่สำเร็จบันทึก `bot_version` ไว้ใน timeline

**รูปแบบแพ็กเกจ**

ตัวอย่างอยู่ใน `requests/sample-package/` ให้ ZIP โดยมี `package.json` อยู่ที่รากของไฟล์:

```json
{ "name": "oxide-bot", "version": "2.0.0", "main": "bot.js" }
```

`bot.js` ต้อง export ฟังก์ชันทำงาน:

```javascript
module.exports = {
  async run(ctx) {
    if (!(await ctx.extendLease())) return;
    const result = await ctx.topup();
    if (!result.ok) return ctx.fail('PROVIDER_DOWN', result.error || 'Provider error');
    await ctx.complete();
  }
};
```

ตัวอย่างข้างบนเป็นงานสั้น หากทำงานนานต้องต่อ lease ระหว่างทำด้วย `ctx` มี `job`, `sleep()`, `log()`, `extendLease()`, `topup()`, `complete()` และ `fail()` ให้ใช้ หากโค้ดโยน error agent รายงาน `BOT_CODE_ERROR` ให้ server ตัดสินตาม retry policy

### 4. Webhook ซ้ำ มาช้า หรือใช้ธุรกรรมเดิม

ตรวจ HMAC-SHA256 จาก raw body เก็บ `event_id` ใน transaction เดียวกับการเปลี่ยนสถานะ และใช้ unique index บน `payment_txn_id` ป้องกันธุรกรรมเดียวจ่ายหลายออเดอร์

ใช้ `paid_at` ตัดสินว่าจ่ายทันหรือไม่ หาก webhook มาช้าแต่อยู่ในเวลาชำระ ออเดอร์ `EXPIRED` กลับเป็น `QUEUED` ได้ หากจ่ายหลังหมดเวลา ยังคง `EXPIRED` และแจ้งให้คืนเงิน ยอดไม่ตรงหรือจ่ายซ้ำจะถูกแจ้งให้ตรวจ

### 5. Error ระหว่างทำงานและออเดอร์ค้าง

Retry policy อยู่ใน `src/orders/retry-policy.ts` ทุกเครื่องใช้เกณฑ์เดียวกัน:

| ประเภท | ตัวอย่าง | ผล |
|---|---|---|
| ถาวร | `INVALID_UID`, `UID_REGION_MISMATCH` | `FAILED` |
| ชั่วคราว | `PROVIDER_TIMEOUT`, `BOT_HEARTBEAT_TIMEOUT`, `LEASE_EXPIRED`, `BOT_CODE_ERROR` | กลับเข้าคิว ครบ 3 ครั้งเป็น `DELAYED` |
| ไม่ทราบผล | `TOPUP_STATUS_UNKNOWN` | `DELAYED` ทันที ให้ตรวจผลก่อนส่งซ้ำ |
| ไม่รู้จัก | รหัสอื่น | จัดเป็นชั่วคราวและจำกัดจำนวนครั้ง |

ออเดอร์ไม่จ่ายตามเวลาเป็น `EXPIRED` ส่วนงานค้างในคิวเกิน SLA จะแจ้งเตือน คำสั่งไป simulator ที่เจอ network error หรือ 5xx ทำงานรวมไม่เกิน 3 ครั้ง ส่วน 4xx ถือว่าล้มเหลว

แอดมินใช้ `requeue` กับ `DELAYED`/`FAILED` เพื่อเริ่มนับครั้งใหม่ และกับ `EXPIRED` ที่มีการชำระเงินแล้วได้ ส่วน `resolve` ใช้เฉพาะ `DELAYED` เพื่อตัดสินเป็น `COMPLETED` หรือ `FAILED` หลังตรวจผล

## API หลัก

แอดมินส่ง `X-Admin-Token` และ `X-Actor` ส่วน agent ส่ง `X-Agent-Token` กับ `X-Bot-Id` รายละเอียด request/response อยู่ใน Swagger และ `requests/oxide.http`

| Method | Path | หน้าที่ |
|---|---|---|
| GET | `/dashboard` | ข้อมูลภาพรวม |
| GET | `/bots`, `/bots/{id}` | สถานะเครื่อง รายละเอียด log และ metrics |
| POST | `/bots/{id}/commands` | สั่ง start/stop/restart/status |
| GET | `/commands/{id}` | ผลคำสั่ง |
| PUT | `/system/kill-switch` | เปิด/ปิดรับงานทั้งระบบ |
| POST | `/packages` | อัปโหลด ZIP ด้วย multipart field `file` |
| POST | `/packages/{id}/deploy` | อัปเดตทุกเครื่อง หรือระบุ `bot_ids` |
| GET | `/deployments`, `/alerts`, `/audit-logs` | ประวัติและการแจ้งเตือน |
| POST | `/orders` | สร้างออเดอร์ ใช้ `external_order_id` กันคำขอซ้ำ |
| GET | `/orders`, `/orders/{id}`, `/orders/{id}/timeline` | รายการออเดอร์และประวัติ |
| POST | `/orders/{id}/requeue` | ส่งกลับเข้าคิว |
| POST | `/orders/{id}/resolve` | ตัดสินออเดอร์ DELAYED |
| POST | `/orders/{id}/cancel` | ยกเลิกออเดอร์ที่ยังไม่ชำระเงิน |
| POST | `/webhooks/payment` | รับผลชำระเงินพร้อมลายเซ็น |
| POST | `/dev/orders/{id}/pay` | จำลองชำระเงิน |
| POST | `/agent/claim` | Agent รับงาน |
| POST | `/agent/orders/{id}/lease` | ต่อ lease |
| POST | `/agent/orders/{id}/complete` | จบงาน |
| POST | `/agent/orders/{id}/fail` | รายงานข้อผิดพลาด |

ตัวอย่าง error:

```json
{ "code": "SYSTEM_PAUSED", "message": "...", "request_id": "..." }
```

## การปรับ schema จาก candidate pack

เก็บ `db/schema.sql`, `db/seed.sql` และ simulator เดิมไว้ ส่วนที่เพิ่มอยู่ใน `db/migrations/` API รันตอนเริ่มและบันทึกชื่อไฟล์ใน `schema_migrations`

Schema เดิมมีสถานะ `pending/processing/completed/failed/cancelled` แต่ PDF ใช้ `PENDING_PAYMENT`, `QUEUED`, `IN_PROGRESS`, `COMPLETED` และ `DELAYED` จึงเพิ่ม migration สำหรับสถานะและข้อมูล lease รวมถึงตารางระบบ แพ็กเกจ deployment webhook และ alert

Candidate pack ระบุว่าไม่ต้องเพิ่ม migration แต่ schema เดิมรองรับ state machine ใน PDF ไม่ได้ จึงเลือกเพิ่ม migration แบบไม่แก้ไฟล์เดิม ประเด็นนี้ควรยืนยันกับผู้ให้โจทย์

## ข้อจำกัด

- Agent และ provider เป็นของจำลอง ไม่เชื่อมต่อระบบเติมเกมหรือธนาคารจริง
- ใช้ token คงที่สำหรับ local ส่วน WebSocket ส่ง token ใน query string
- ZIP เก็บในฐานข้อมูล จำกัด 20 MB
- ยังไม่มีขั้นตอนคืนเงินอัตโนมัติ ใช้แจ้งเตือนให้แอดมินจัดการ
- โค้ดแพ็กเกจรันใน process เดียวกับ agent การอัปโหลดจึงจำกัดเฉพาะแอดมินที่เชื่อถือได้ การตรวจ sha256 ยืนยันความตรงของไฟล์ ไม่ได้ยืนยันว่าโค้ดปลอดภัย

## โครงสร้างไฟล์

```text
src/
  orders/      state machine และ retry policy
  agent/       claim, lease, complete, fail และ provider จำลอง
  bots/        สถานะเครื่องและคิวคำสั่ง
  deploy/      แพ็กเกจและ deployment
  system/      kill-switch
  webhooks/    ผลชำระเงิน
  realtime/    WebSocket
  jobs/        ตรวจ timeout และงานค้าง
  api/         controllers
agent/
  bot-agent.ts    ดูแลการเชื่อมต่อและเรียกโค้ดบอท
  bot-module.ts   โหลดโค้ดจากแพ็กเกจ
  installer.ts    แตก ZIP และสลับ release
  builtin-bot.ts  บอทเริ่มต้น
  fleet.ts        เปิด agent หลาย process
public/        Dashboard
db/            schema, seed และ migrations
test/          unit และ integration tests
requests/      oxide.http และแพ็กเกจตัวอย่าง
```
