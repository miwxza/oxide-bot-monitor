/**
 * โค้ดบอทในตัว agent — ใช้เมื่อเครื่องยังไม่เคยได้รับแพ็กเกจ (หรือแพ็กเกจที่ติดตั้งไว้โหลดไม่ได้)
 * แพ็กเกจที่อัปโหลดผ่าน dashboard มาแทนที่ตัวนี้ (ตัวอย่าง: requests/sample-package/bot.js)
 *
 * พฤติกรรมตาม player_uid (สำหรับ demo เคสปัญหา):
 *   INVALID001     → INVALID_UID (permanent → FAILED)
 *   FLAKY001       → PROVIDER_TIMEOUT ทุกครั้ง (retry → DELAYED)
 *   UNKNOWN001     → TOPUP_STATUS_UNKNOWN (DELAYED ทันที)
 *   HANG001        → รับงานแล้วเงียบ (lease หมด → คืนคิว)
 *   TOPUPCRASH001  → เติมแล้ว "ล่ม" ก่อน complete → รอบถัดไปเติมด้วย topup_key เดิม = ไม่เติมซ้ำ
 *   อื่น ๆ          → สำเร็จ
 */
import type { BotContext, BotModule } from './bot-module';

export async function runDemoBot(ctx: BotContext): Promise<void> {
  const { job } = ctx;
  switch (job.player_uid) {
    case 'INVALID001':
      await ctx.sleep(500);
      return ctx.fail('INVALID_UID', 'Player UID not found at provider');
    case 'FLAKY001':
      await ctx.sleep(500);
      return ctx.fail('PROVIDER_TIMEOUT', 'Provider did not respond in 30s');
    case 'UNKNOWN001':
      await ctx.sleep(500);
      return ctx.fail('TOPUP_STATUS_UNKNOWN', 'Provider returned 500 after charging');
    case 'HANG001':
      return ctx.log('simulating hang (no lease renewal)');
  }

  // ทำงาน: ต่อ lease ระหว่างทำ ถ้า lease หาย (ถูกคืนคิว) ให้หยุดทันที
  const steps = Math.max(1, Math.round(ctx.workMs / 1000));
  for (let i = 0; i < steps; i++) {
    await ctx.sleep(ctx.workMs / steps);
    if (!(await ctx.extendLease())) return ctx.log('lease lost, aborting');
  }
  const topup = await ctx.topup();
  if (!topup.ok) return ctx.fail('PROVIDER_DOWN', topup.error ?? 'provider error');
  if (topup.duplicate) ctx.log('provider: already topped up by previous attempt — not charging again');
  if (job.player_uid === 'TOPUPCRASH001' && job.attempt === 1) {
    return ctx.log('simulating crash after top-up, before complete');
  }
  await ctx.complete();
}

export const builtinBot: BotModule = { name: 'builtin', version: 'builtin', run: runDemoBot };
