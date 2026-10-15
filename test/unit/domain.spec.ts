import { deriveState, BotsService } from '../../src/bots/bots.service';
import { requestHash } from '../../src/orders/orders.service';
import { backoffSeconds, classifyError, decideRetry } from '../../src/orders/retry-policy';
import { canTransition, ORDER_STATUSES, TERMINAL, TRANSITIONS } from '../../src/orders/state-machine';
import { signPayload } from '../../src/webhooks/webhooks.service';

describe('order state machine', () => {
  it('allows the happy path from the brief', () => {
    expect(canTransition('PENDING_PAYMENT', 'QUEUED')).toBe(true);
    expect(canTransition('QUEUED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('lets heartbeat timeout move IN_PROGRESS to QUEUED, DELAYED or FAILED', () => {
    for (const to of ['QUEUED', 'DELAYED', 'FAILED'] as const) expect(canTransition('IN_PROGRESS', to)).toBe(true);
  });

  it.each([
    ['PENDING_PAYMENT', 'IN_PROGRESS'], // ข้ามการจ่ายเงินไม่ได้
    ['PENDING_PAYMENT', 'COMPLETED'],
    ['QUEUED', 'COMPLETED'], // ต้องผ่าน bot
    ['COMPLETED', 'QUEUED'],
    ['CANCELLED', 'QUEUED'],
    ['FAILED', 'COMPLETED'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('has no exits from terminal states and every target is a known status', () => {
    for (const t of TERMINAL) expect(TRANSITIONS[t]).toHaveLength(0);
    for (const targets of Object.values(TRANSITIONS)) for (const t of targets) expect(ORDER_STATUSES).toContain(t);
  });
});

describe('retry policy', () => {
  it('classifies errors', () => {
    expect(classifyError('INVALID_UID')).toBe('permanent');
    expect(classifyError('TOPUP_STATUS_UNKNOWN')).toBe('needs_review');
    expect(classifyError('PROVIDER_TIMEOUT')).toBe('transient');
    expect(classifyError('BOT_HEARTBEAT_TIMEOUT')).toBe('transient');
    expect(classifyError('SOMETHING_NEW')).toBe('transient');
  });

  it('backs off exponentially', () => {
    expect([1, 2, 3].map((a) => backoffSeconds(a, 10))).toEqual([10, 20, 40]);
  });

  it('retries transient errors until attempts are used up, then DELAYED', () => {
    expect(decideRetry('PROVIDER_TIMEOUT', 1, 3, 10)).toEqual({ action: 'retry', delayS: 10 });
    expect(decideRetry('PROVIDER_TIMEOUT', 2, 3, 10)).toEqual({ action: 'retry', delayS: 20 });
    expect(decideRetry('PROVIDER_TIMEOUT', 3, 3, 10)).toEqual({ action: 'delay' });
  });

  it('fails permanent errors immediately and sends unknown outcomes to review', () => {
    expect(decideRetry('INVALID_UID', 1, 3, 10)).toEqual({ action: 'fail' });
    expect(decideRetry('TOPUP_STATUS_UNKNOWN', 1, 3, 10)).toEqual({ action: 'delay' });
  });
});

describe('bot state', () => {
  const base = { heartbeat_ok: true, status: 'online', current_order: null };
  it('derives dashboard state', () => {
    expect(deriveState({ ...base, heartbeat_ok: false }, true)).toBe('offline');
    expect(deriveState({ ...base, current_order: 'X' }, true)).toBe('in_progress');
    expect(deriveState(base, true)).toBe('active');
    expect(deriveState({ ...base, status: 'offline' }, true)).toBe('standby');
    expect(deriveState(base, false)).toBe('standby'); // kill-switch
  });

  it('summarizes counts for the overview bar', () => {
    const bots = ['active', 'standby', 'standby', 'in_progress', 'offline'].map((state) => ({
      state,
      heartbeat_ok: state !== 'offline',
    })) as any;
    expect(BotsService.summarize(bots)).toEqual({ total: 5, online: 4, active: 1, standby: 2, in_progress: 1, offline: 1 });
  });
});

describe('idempotency + signatures', () => {
  it('hashes order data canonically', () => {
    const a = { player_uid: 'u', package_code: 'p', amount: 146, currency: 'THB' };
    expect(requestHash(a)).toBe(requestHash({ ...a, amount: 146.0 }));
    expect(requestHash(a)).not.toBe(requestHash({ ...a, amount: 147 }));
  });

  it('signs webhook bodies with HMAC-SHA256', () => {
    expect(signPayload('{"a":1}', 'secret')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload('{"a":1}', 'secret')).not.toBe(signPayload('{"a":2}', 'secret'));
  });
});
