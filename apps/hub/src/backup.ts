// Snapshots of everything needed to restore the hub: the database and the TLS material (CA + server keys).
// Restoring a snapshot restores every pairing, because devices trust the CA and the hub knows their token hashes.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';

/** Writes a consistent snapshot into `dest` (created or replaced). Safe while the hub is running. */
export function snapshot(db: Db, dataDir: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  // VACUUM INTO produces a complete, defragmented copy even while other connections are writing.
  db.prepare('VACUUM INTO ?').run(join(dest, 'hub.db'));
  cpSync(join(dataDir, 'tls'), join(dest, 'tls'), { recursive: true });
}

export const isSnapshot = (dir: string) => existsSync(join(dir, 'hub.db')) && existsSync(join(dir, 'tls', 'ca.crt')) && existsSync(join(dir, 'tls', 'ca.key'));

/** One snapshot per day under <dataDir>/backups, keeping the newest `keep`. Returns the snapshot's path. */
export function dailyBackup(db: Db, dataDir: string, keep = 7): string {
  const root = join(dataDir, 'backups');
  const dest = join(root, `auto-${new Date().toISOString().slice(0, 10)}`);
  snapshot(db, dataDir, dest);
  const old = readdirSync(root).filter((n) => n.startsWith('auto-')).sort().slice(0, -keep);
  for (const name of old) rmSync(join(root, name), { recursive: true, force: true });
  return dest;
}

/**
 * Replaces the live database and TLS material with a snapshot. The hub must be stopped.
 * What was there before is kept in <dataDir>/replaced-<timestamp>, so a wrong restore can be undone by hand.
 */
export function restore(dataDir: string, from: string): string {
  if (!isSnapshot(from)) throw new Error('That is not an NRVL Stream Deck backup (hub.db and tls/ca.crt + ca.key expected)');
  const aside = join(dataDir, `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const name of ['hub.db', 'hub.db-wal', 'hub.db-shm', 'tls']) {
    if (existsSync(join(dataDir, name))) renameSync(join(dataDir, name), join(aside, name));
  }
  cpSync(join(from, 'hub.db'), join(dataDir, 'hub.db'));
  cpSync(join(from, 'tls'), join(dataDir, 'tls'), { recursive: true });
  return aside;
}
