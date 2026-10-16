-- เครื่องหนึ่งถือออเดอร์ IN_PROGRESS ได้ทีละ 1 (กันที่ระดับฐานข้อมูล นอกจากการล็อกแถวบอทตอน claim)
-- ออเดอร์ที่ซ้อนอยู่ก่อนแล้ว (จากบั๊กเดิม) ให้คืนเข้าคิว เหลือไว้ตัวที่เริ่มก่อนสุดต่อเครื่อง
WITH extra AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY assigned_bot_id ORDER BY updated_at, id) AS n
    FROM orders WHERE status = 'IN_PROGRESS' AND assigned_bot_id IS NOT NULL
  ) t WHERE n > 1
)
UPDATE orders SET status = 'QUEUED', lease_token = NULL, lease_expires_at = NULL, next_attempt_at = now(),
                  version = version + 1, updated_at = now()
WHERE id IN (SELECT id FROM extra);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_one_in_progress_per_bot
  ON orders(assigned_bot_id) WHERE status = 'IN_PROGRESS';
