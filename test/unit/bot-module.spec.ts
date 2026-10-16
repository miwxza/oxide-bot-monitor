import AdmZip from 'adm-zip';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotContext, loadBot } from '../../agent/bot-module';
import { runDemoBot } from '../../agent/builtin-bot';
import { installPackage, readCurrent } from '../../agent/installer';

const SAMPLE = join(__dirname, '..', '..', 'requests', 'sample-package');

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'oxide-bot-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function release(files: Record<string, string>): string {
  const d = join(dir, 'rel');
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true });
    writeFileSync(join(d, name), body);
  }
  return d;
}

/** ctx ปลอมที่บันทึกว่าโค้ดบอทเรียกอะไรบ้าง */
function fakeCtx(uid: string, opts: { leaseOk?: boolean; attempt?: number } = {}) {
  const calls: string[] = [];
  const ctx: BotContext = {
    job: { external_order_id: 'O-1', player_uid: uid, package_code: 'P', amount: '146', attempt: opts.attempt ?? 1, topup_key: 'k' },
    workMs: 20,
    sleep: async () => undefined,
    log: () => undefined,
    extendLease: async () => (calls.push('lease'), opts.leaseOk ?? true),
    topup: async () => (calls.push('topup'), { ok: true, duplicate: false }),
    complete: async () => (calls.push('complete'), true),
    fail: async (code) => void calls.push(`fail:${code}`),
  };
  return { ctx, calls };
}

describe('loading bot code from a package', () => {
  it('loads the sample package and runs it to completion', async () => {
    const bot = loadBot(SAMPLE);
    expect(bot).toMatchObject({ name: 'oxide-bot', version: '2.0.0' });
    const { ctx, calls } = fakeCtx('12345678');
    await bot.run(ctx);
    expect(calls.at(-2)).toBe('topup');
    expect(calls.at(-1)).toBe('complete');
  });

  it.each([
    [{ 'bot.js': 'module.exports = {}' }, /package.json not found/],
    [{ 'package.json': '{ nope', 'bot.js': '' }, /not valid JSON/],
    [{ 'package.json': '{"main":"missing.js"}' }, /main file not found/],
    [{ 'package.json': '{"main":"../../outside.js"}' }, /outside the package/],
    [{ 'package.json': '{"main":"bot.js"}', 'bot.js': 'module.exports = { run: 1 }' }, /must export run/],
    [{ 'package.json': '{"main":"bot.js"}', 'bot.js': 'this is not javascript (' }, /cannot load bot code/],
  ])('rejects a package that breaks the contract %#', (files, error) => {
    expect(() => loadBot(release(files as Record<string, string>))).toThrow(error);
  });

  it('refuses to install a package whose code cannot load, and keeps the current version', () => {
    const zip = (files: Record<string, string>) => {
      const z = new AdmZip();
      for (const [n, b] of Object.entries(files)) z.addFile(n, Buffer.from(b));
      return z.toBuffer();
    };
    const sample = zip({
      'package.json': readFileSync(join(SAMPLE, 'package.json'), 'utf8'),
      'bot.js': readFileSync(join(SAMPLE, 'bot.js'), 'utf8'),
    });
    installPackage(dir, 'good', 'good.zip', sample, (d) => void loadBot(d));
    const broken = zip({ 'package.json': '{"main":"bot.js"}', 'bot.js': 'module.exports = {}' });
    expect(() => installPackage(dir, 'bad', 'bad.zip', broken, (d) => void loadBot(d))).toThrow(/must export run/);
    expect(readCurrent(dir)?.version).toBe('good');
    expect(loadBot(join(dir, 'releases', 'good')).version).toBe('2.0.0');
  });
});

describe('builtin demo bot', () => {
  it('reports permanent errors without topping up', async () => {
    const { ctx, calls } = fakeCtx('INVALID001');
    await runDemoBot(ctx);
    expect(calls).toEqual(['fail:INVALID_UID']);
  });

  it('stops when the lease is lost', async () => {
    const { ctx, calls } = fakeCtx('12345678', { leaseOk: false });
    await runDemoBot(ctx);
    expect(calls).toEqual(['lease']);
  });

  it('tops up then "crashes" on the first attempt of TOPUPCRASH001', async () => {
    const { ctx, calls } = fakeCtx('TOPUPCRASH001', { attempt: 1 });
    await runDemoBot(ctx);
    expect(calls).not.toContain('complete');
    expect(calls).toContain('topup');
  });
});
