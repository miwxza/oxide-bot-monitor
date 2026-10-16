// โค้ดบอทเวอร์ชัน 2.0.0 (มากับแพ็กเกจ zip) — agent เรียก run(ctx) ทุกออเดอร์
// ctx: job, extendLease(), topup(), complete(), fail(code, message), sleep(ms), log(msg), workMs
const VERSION = '2.0.0';

const FAILURES = {
  INVALID001: ['INVALID_UID', 'Player UID not found at provider'],
  FLAKY001: ['PROVIDER_TIMEOUT', 'Provider did not respond in 30s'],
  UNKNOWN001: ['TOPUP_STATUS_UNKNOWN', 'Provider returned 500 after charging'],
};

module.exports = {
  async run(ctx) {
    const { job } = ctx;
    ctx.log(`oxide-bot ${VERSION} handling order`, { uid: job.player_uid });

    if (FAILURES[job.player_uid]) {
      await ctx.sleep(500);
      return ctx.fail(...FAILURES[job.player_uid]);
    }
    if (job.player_uid === 'HANG001') return ctx.log('simulating hang (no lease renewal)');

    // v2: ต่อ lease ทุก 1 วินาทีระหว่างทำงาน
    const steps = Math.max(1, Math.round(ctx.workMs / 1000));
    for (let i = 0; i < steps; i++) {
      await ctx.sleep(ctx.workMs / steps);
      if (!(await ctx.extendLease())) return ctx.log('lease lost, aborting');
    }
    const topup = await ctx.topup();
    if (!topup.ok) return ctx.fail('PROVIDER_DOWN', topup.error || 'provider error');
    if (job.player_uid === 'TOPUPCRASH001' && job.attempt === 1) return ctx.log('simulating crash after top-up');
    await ctx.complete();
  },
};
