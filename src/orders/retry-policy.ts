/**
 * จัดประเภท error ที่ bot รายงาน — เก็บ policy ไว้ฝั่ง server ให้ทุกเครื่องใช้เกณฑ์เดียวกัน
 */
export type ErrorClass = 'permanent' | 'transient' | 'needs_review';

const PERMANENT = new Set(['INVALID_UID', 'UID_REGION_MISMATCH', 'PACKAGE_NOT_AVAILABLE']);
const NEEDS_REVIEW = new Set(['PAYMENT_STATUS_UNKNOWN', 'TOPUP_STATUS_UNKNOWN']);
const TRANSIENT = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_DOWN',
  'BOT_COOKIE_EXPIRED',
  'BOT_HEARTBEAT_TIMEOUT', // เครื่องหลุด (job ตรวจ heartbeat)
  'LEASE_EXPIRED', // bot ไม่ต่อ lease
]);

export function classifyError(code: string): ErrorClass {
  if (PERMANENT.has(code)) return 'permanent';
  if (NEEDS_REVIEW.has(code)) return 'needs_review';
  if (TRANSIENT.has(code)) return 'transient';
  // ไม่รู้จัก: retry แบบจำกัดครั้งแล้วจบที่ DELAYED ปลอดภัยกว่า FAILED เพราะลูกค้าจ่ายเงินแล้ว
  return 'transient';
}

/** exponential backoff: attempt 1 ล้ม → รอ base, attempt 2 ล้ม → รอ 2×base, ... */
export function backoffSeconds(attemptsSoFar: number, baseS: number): number {
  return baseS * 2 ** Math.max(0, attemptsSoFar - 1);
}

export type RetryDecision =
  | { action: 'retry'; delayS: number }
  | { action: 'delay' } // → DELAYED (แอดมินตรวจ)
  | { action: 'fail' }; // → FAILED

export function decideRetry(code: string, attemptsSoFar: number, maxAttempts: number, baseS: number): RetryDecision {
  const cls = classifyError(code);
  if (cls === 'permanent') return { action: 'fail' };
  if (cls === 'needs_review') return { action: 'delay' };
  if (attemptsSoFar >= maxAttempts) return { action: 'delay' };
  return { action: 'retry', delayS: backoffSeconds(attemptsSoFar, baseS) };
}
