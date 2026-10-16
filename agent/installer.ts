/**
 * ติดตั้งแพ็กเกจโค้ด (zip) บนเครื่องบอท
 *
 *   <baseDir>/releases/<version>/   ไฟล์ที่แตกจาก zip (เก็บไว้ 3 ชุดล่าสุดไว้ย้อนกลับ)
 *   <baseDir>/current.json          เวอร์ชันที่ใช้งานอยู่ — สลับแบบ atomic (เขียนไฟล์ชั่วคราวแล้ว rename)
 *
 * แตกลงโฟลเดอร์ชั่วคราวก่อน แล้วให้ verify() ตรวจ (เช่น โหลดโค้ดบอทได้จริง) ก่อนสลับ
 * ถ้าพังหรือ verify ไม่ผ่าน เวอร์ชันเดิมยังใช้งานได้ตามปกติ
 */
import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
export const KEEP_RELEASES = 3;

export interface CurrentRelease {
  version: string;
  filename: string;
  installed_at: string;
}

export function readCurrent(baseDir: string): CurrentRelease | null {
  try {
    return JSON.parse(readFileSync(join(baseDir, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function installPackage(
  baseDir: string,
  version: string,
  filename: string,
  zipBuf: Buffer,
  verify?: (releaseDir: string) => void,
): CurrentRelease {
  const releases = join(baseDir, 'releases');
  const target = join(releases, version);
  const current = readCurrent(baseDir);
  if (current?.version === version && existsSync(target)) return current; // ส่งซ้ำ → ไม่ทำอะไร

  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuf);
  } catch (err) {
    throw new Error(`invalid zip: ${(err as Error).message}`);
  }
  const entries = zip.getEntries();
  if (!entries.some((e) => !e.isDirectory)) throw new Error('package is empty');
  if (entries.length > MAX_ENTRIES) throw new Error(`too many files (${entries.length})`);
  const unpacked = entries.reduce((n, e) => n + e.header.size, 0);
  if (unpacked > MAX_UNPACKED_BYTES) throw new Error(`package too large when unpacked (${unpacked} bytes)`);

  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const root = resolve(tmp) + sep;
  try {
    for (const e of entries) {
      const dest = resolve(tmp, e.entryName);
      // zip-slip: ชื่อไฟล์แบบ ../../x หรือ path เต็ม ห้ามเขียนออกนอกโฟลเดอร์ release
      if (!dest.startsWith(root)) throw new Error(`unsafe path in package: ${e.entryName}`);
      if (e.isDirectory) {
        mkdirSync(dest, { recursive: true });
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, e.getData());
      }
    }
    verify?.(tmp);
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  const next: CurrentRelease = { version, filename, installed_at: new Date().toISOString() };
  const pointer = join(baseDir, 'current.json');
  writeFileSync(`${pointer}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${pointer}.tmp`, pointer);

  pruneReleases(releases, version);
  return next;
}

function pruneReleases(releases: string, keep: string): void {
  const dirs = readdirSync(releases, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.includes('.tmp-'))
    .map((d) => ({ name: d.name, mtime: statSync(join(releases, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const d of dirs.slice(KEEP_RELEASES)) {
    if (d.name !== keep) rmSync(join(releases, d.name), { recursive: true, force: true });
  }
}
