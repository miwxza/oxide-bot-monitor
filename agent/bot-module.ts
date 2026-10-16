/**
 * สัญญาระหว่าง agent กับ "โค้ดบอท" ที่มากับแพ็กเกจ zip
 *
 * แพ็กเกจต้องมี package.json (name, version, main) และไฟล์ main ต้อง export:
 *
 *   module.exports = { async run(ctx) { ... } }
 *
 * agent (supervisor) ดูแล WebSocket / heartbeat / claim / lease / การติดตั้ง
 * ส่วนโค้ดบอททำงานเติมเกมผ่าน ctx เท่านั้น จึงอัปเดตโค้ดบอทได้โดยไม่ต้องอัปเดต agent
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface Job {
  external_order_id: string;
  player_uid: string;
  package_code: string;
  amount: string;
  attempt: number;
  topup_key: string;
}

export interface BotContext {
  job: Job;
  /** ต่อ lease — false = ออเดอร์ถูกคืนคิว/ให้เครื่องอื่นแล้ว ต้องหยุดทันที */
  extendLease(): Promise<boolean>;
  /** เติมที่ provider ด้วย topup_key ของออเดอร์ (เรียกซ้ำได้ ไม่เติมซ้ำ) */
  topup(): Promise<{ ok: boolean; duplicate?: boolean; error?: string }>;
  complete(): Promise<boolean>;
  fail(code: string, message: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(msg: string, extra?: object): void;
  workMs: number;
}

export interface BotModule {
  name: string;
  version: string;
  run(ctx: BotContext): Promise<void>;
}

/** โหลดโค้ดบอทจากโฟลเดอร์ release — โยน error ถ้าแพ็กเกจไม่ตรงสัญญา */
export function loadBot(releaseDir: string): BotModule {
  const root = resolve(releaseDir);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) throw new Error('package.json not found in package');
  let pkg: { name?: string; version?: string; main?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new Error('package.json is not valid JSON');
  }
  const entry = resolve(root, pkg.main ?? 'index.js');
  if (!entry.startsWith(root + sep)) throw new Error(`main points outside the package: ${pkg.main}`);
  if (!existsSync(entry)) throw new Error(`main file not found: ${pkg.main ?? 'index.js'}`);

  // โหลดใหม่เสมอ (ไม่ใช้ cache ของ require จากรอบก่อนในโฟลเดอร์เดียวกัน)
  for (const key of Object.keys(require.cache)) if (key.startsWith(root + sep)) delete require.cache[key];
  let mod: any;
  try {
    mod = require(entry);
  } catch (err) {
    throw new Error(`cannot load bot code: ${(err as Error).message}`);
  }
  const run = mod?.run ?? mod?.default?.run;
  if (typeof run !== 'function') throw new Error('bot code must export run(ctx)');
  return { name: pkg.name ?? 'unnamed', version: pkg.version ?? '0.0.0', run };
}
