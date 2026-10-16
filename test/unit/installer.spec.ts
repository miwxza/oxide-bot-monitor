import AdmZip from 'adm-zip';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPackage, readCurrent } from '../../agent/installer';

function zipOf(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, body] of Object.entries(files)) z.addFile(name, Buffer.from(body));
  return z.toBuffer();
}

/** zip ที่มีชื่อไฟล์อันตราย (AdmZip.addFile จะ normalize ชื่อให้ จึงแก้ entryName หลังเพิ่ม) */
function zipWithEntryName(name: string): Buffer {
  const z = new AdmZip();
  z.addFile('placeholder.txt', Buffer.from('x'));
  z.getEntries()[0].entryName = name;
  return z.toBuffer();
}

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'oxide-agent-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('agent package installer', () => {
  it('unpacks the zip into a release folder and switches current.json', () => {
    installPackage(dir, 'v1', 'oxide-v1.zip', zipOf({ 'src/bot.js': 'v1', 'package.json': '{"version":"1.0.0"}' }));
    expect(readFileSync(join(dir, 'releases', 'v1', 'src', 'bot.js'), 'utf8')).toBe('v1');
    expect(readCurrent(dir)).toMatchObject({ version: 'v1', filename: 'oxide-v1.zip' });
  });

  it('is idempotent for the same version', () => {
    const first = installPackage(dir, 'v1', 'a.zip', zipOf({ 'a.txt': '1' }));
    const again = installPackage(dir, 'v1', 'a.zip', zipOf({ 'a.txt': '1' }));
    expect(again.installed_at).toBe(first.installed_at);
  });

  it('rejects a path traversal entry and keeps the current version', () => {
    installPackage(dir, 'v1', 'ok.zip', zipOf({ 'a.txt': '1' }));
    expect(() => installPackage(dir, 'v2', 'evil.zip', zipWithEntryName('../../evil.txt'))).toThrow(/unsafe path/);
    expect(existsSync(join(dir, '..', 'evil.txt'))).toBe(false);
    expect(readCurrent(dir)?.version).toBe('v1');
    expect(readdirSync(join(dir, 'releases'))).toEqual(['v1']); // ไม่มีโฟลเดอร์ชั่วคราวค้าง
  });

  it('rejects a file that is not a zip and an empty zip', () => {
    expect(() => installPackage(dir, 'v1', 'x.zip', Buffer.from('PK\x03\x04 not really'))).toThrow(/invalid zip|empty/);
    expect(() => installPackage(dir, 'v1', 'empty.zip', new AdmZip().toBuffer())).toThrow(/invalid zip|empty/);
    expect(readCurrent(dir)).toBeNull();
  });

  it('keeps only the last 3 releases', () => {
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) installPackage(dir, v, `${v}.zip`, zipOf({ 'f.txt': v }));
    expect(readdirSync(join(dir, 'releases')).sort()).toEqual(['v3', 'v4', 'v5']);
    expect(readCurrent(dir)?.version).toBe('v5');
  });
});
