import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProfileSchema, type Profile, type Role } from '@nrvl/shared';

// Append-only: never edit a released migration, add a new one. Position in the array = schema version.
const MIGRATIONS = [
  `CREATE TABLE devices (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, os TEXT NOT NULL,
     token_hash TEXT NOT NULL, prev_token_hash TEXT, token_issued_at INTEGER NOT NULL,
     capabilities TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
   CREATE TABLE pairing_codes (code_hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE profiles (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, device_id TEXT, event TEXT NOT NULL, detail TEXT);
   CREATE INDEX audit_ts ON audit(ts);`,
];

export type Db = DatabaseSync;
export type DeviceRow = {
  id: string; name: string; role: Role; os: string; token_hash: string; prev_token_hash: string | null;
  token_issued_at: number; capabilities: string; created_at: number; last_seen: number;
};

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'hub.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec(`BEGIN; ${MIGRATIONS[v]}; PRAGMA user_version=${v + 1}; COMMIT;`);
  }
  db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - 90 * 86400_000);
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(Date.now());
  return db;
}

// ---------- pairing + tokens ----------
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newToken = () => randomBytes(32).toString('base64url');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** One-time code, valid for 10 minutes. Only its hash is stored. */
export function createPairingCode(db: Db, role: Role, ttlMs = 10 * 60_000): { code: string; expiresAt: number } {
  const code = Array.from(randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const expiresAt = Date.now() + ttlMs;
  db.prepare('INSERT INTO pairing_codes (code_hash, role, expires_at) VALUES (?, ?, ?)').run(sha(code), role, expiresAt);
  return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt };
}

export function redeemPairingCode(db: Db, code: string, name: string, os: string) {
  // Single atomic UPDATE so a code can never be redeemed twice, even concurrently.
  const row = db.prepare('UPDATE pairing_codes SET used=1 WHERE code_hash=? AND used=0 AND expires_at>? RETURNING role')
    .get(sha(normalizeCode(code)), Date.now()) as { role: Role } | undefined;
  if (!row) return null;
  const deviceId = randomUUID();
  const token = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO devices (id, name, role, os, token_hash, token_issued_at, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?)')
    .run(deviceId, name, row.role, os, sha(token), now, now, now);
  return { deviceId, token, role: row.role };
}

/**
 * Verifies a device token and rotates it when older than rotateMs.
 * The previous token stays valid until the device first connects with the new one,
 * so a device that never received the rotated token is not locked out.
 */
export function authenticate(db: Db, deviceId: string, token: string, rotateMs: number): { device: DeviceRow; newToken?: string } | null {
  const device = getDevice(db, deviceId);
  if (!device) return null;
  const h = sha(token);
  const now = Date.now();
  if (same(h, device.token_hash)) {
    if (device.prev_token_hash) db.prepare('UPDATE devices SET prev_token_hash=NULL WHERE id=?').run(deviceId);
    if (now - device.token_issued_at < rotateMs) return { device };
    const t = newToken();
    db.prepare('UPDATE devices SET prev_token_hash=token_hash, token_hash=?, token_issued_at=? WHERE id=?').run(sha(t), now, deviceId);
    return { device, newToken: t };
  }
  if (device.prev_token_hash && same(h, device.prev_token_hash)) {
    const t = newToken();
    db.prepare('UPDATE devices SET token_hash=?, token_issued_at=? WHERE id=?').run(sha(t), now, deviceId);
    return { device, newToken: t };
  }
  return null;
}

// ---------- devices ----------
export const getDevice = (db: Db, id: string) => db.prepare('SELECT * FROM devices WHERE id=?').get(id) as DeviceRow | undefined;
export const listDevices = (db: Db) => db.prepare('SELECT * FROM devices ORDER BY created_at').all() as DeviceRow[];
export const removeDevice = (db: Db, id: string) => db.prepare('DELETE FROM devices WHERE id=?').run(id).changes > 0;
export const touchDevice = (db: Db, id: string, capabilities?: string[]) =>
  capabilities
    ? db.prepare('UPDATE devices SET last_seen=?, capabilities=? WHERE id=?').run(Date.now(), JSON.stringify(capabilities), id)
    : db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(Date.now(), id);

// ---------- profiles ----------
export function listProfiles(db: Db): Profile[] {
  return (db.prepare('SELECT doc FROM profiles ORDER BY rowid').all() as { doc: string }[]).flatMap((r) => {
    const p = ProfileSchema.safeParse(JSON.parse(r.doc));
    return p.success ? [p.data as Profile] : [];
  });
}
export const putProfile = (db: Db, p: Profile) =>
  db.prepare('INSERT INTO profiles (id, doc, updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, updated_at=excluded.updated_at')
    .run(p.id, JSON.stringify(p), Date.now());
export const deleteProfile = (db: Db, id: string) => db.prepare('DELETE FROM profiles WHERE id=?').run(id).changes > 0;

export function starterProfile(agentId: string, os = 'macos'): Profile {
  const b = (label: string, icon: string, type: string, params: Record<string, unknown> = {}) =>
    ({ id: randomUUID(), label, icon, target: agentId, action: { type, params } });
  const buttons = [
    b('Vol −', '🔉', 'volume.down'), b('Mute', '🔇', 'volume.mute'), b('Vol +', '🔊', 'volume.up'), b('35%', '🎚️', 'volume.set', { level: 35 }),
    b('Previous', '⏮️', 'media.previous'), b('Play / Pause', '⏯️', 'media.playpause'), b('Next', '⏭️', 'media.next'), os === 'windows' ? b('Notepad', '📝', 'app.launch', { app: 'notepad' }) : b('Safari', '🧭', 'app.launch', { app: 'Safari' }),
  ];
  return ProfileSchema.parse({
    schemaVersion: 1, id: randomUUID(), name: 'Starter', grid: { cols: 4, rows: 3 },
    pages: [{ id: randomUUID(), name: 'Main', buttons: Object.fromEntries(buttons.map((x, i) => [String(i), x])) }],
  }) as Profile;
}

// ---------- audit ----------
export const audit = (db: Db, deviceId: string | null, event: string, detail: Record<string, unknown> = {}) =>
  db.prepare('INSERT INTO audit (ts, device_id, event, detail) VALUES (?,?,?,?)').run(Date.now(), deviceId, event, JSON.stringify(detail));
