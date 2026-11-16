// Admin commands. They work directly on the database, so most also work while the hub is running.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import { RoleSchema } from '@nrvl/shared';
import { isSnapshot, restore, snapshot } from './backup.ts';
import { hubUrl, loadConfig } from './config.ts';
import { audit, createPairingCode, listDevices, openDb, removeDevice } from './db.ts';
import { agentPairingString, controllerPairingUrl } from './hub.ts';
import { ensureCerts } from './tls.ts';

const USAGE = `Usage: npm run <command>
  pair controller|agent        one-time pairing code (valid 10 minutes)
  devices                      list paired devices
  revoke <device-id>           remove a device
  audit [count]                show the latest audit log entries (default 30)
  backup [file.tgz]            write a backup archive (default: ~/nrvl-stream-deck-backup-<date>.tgz)
  restore <file.tgz|folder>    replace the hub's data with a backup (stop the hub first)
  service install|uninstall|status   start the hub at login (macOS)`;

const [cmd, arg, arg2] = process.argv.slice(2);
const config = loadConfig();

const LABEL = 'com.nrvl.streamdeck.hub';
const plistPath = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const logPath = join(homedir(), 'Library/Logs/nrvl-hub.log');
const domain = `gui/${userInfo().uid}`;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** launchd job that runs the hub with the Node that ran this command, restarting it if it ever exits. */
function servicePlist(): string {
  const entry = resolve(import.meta.dirname, 'index.ts');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }; // openssl and scutil must be findable
  for (const k of ['NRVL_DATA_DIR', 'NRVL_PORT', 'NRVL_HTTP_PORT', 'NRVL_HOST']) if (process.env[k]) env[k] = process.env[k]!;
  const dict = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>
  <key>WorkingDirectory</key><string>${xml(resolve(import.meta.dirname, '../../..'))}</string>
  <key>EnvironmentVariables</key><dict>${dict}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
}
const launchctl = (...args: string[]) => {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const hubIsRunning = () => new Promise<boolean>((done) => {
  const socket = connect({ host: '127.0.0.1', port: config.port });
  socket.once('connect', () => (socket.destroy(), done(true)));
  socket.once('error', () => done(false));
});

async function main(): Promise<number> {
  switch (cmd) {
    case 'pair': {
      if (!RoleSchema.safeParse(arg).success) break;
      const db = openDb(config.dataDir);
      const { code } = createPairingCode(db, arg as 'controller' | 'agent');
      db.close();
      if (arg === 'agent') {
        const { caFingerprint } = ensureCerts(config.dataDir, [config.host, ...config.ips]);
        console.log(`Run this on the computer you want to control (valid 10 minutes):\n\n  nrvl-agent pair ${agentPairingString(config, code, caFingerprint)}\n`);
      } else {
        const url = controllerPairingUrl(config, code);
        console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
        console.log(`  ${url}\n  Pairing code: ${code} (valid 10 minutes)\n  New iPad? Install the certificate first: http://${config.host}:${config.httpPort}\n`);
      }
      return 0;
    }
    case 'devices': {
      const db = openDb(config.dataDir);
      console.table(listDevices(db).map((d) => ({ id: d.id, name: d.name, role: d.role, os: d.os, lastSeen: new Date(d.last_seen).toISOString() })));
      db.close();
      return 0;
    }
    case 'revoke': {
      if (!arg) break;
      const db = openDb(config.dataDir);
      const removed = removeDevice(db, arg);
      if (removed) audit(db, null, 'device.removed', { removed: arg, by: 'cli' });
      db.close();
      console.log(removed ? `Revoked ${arg}` : `No device with id ${arg}`);
      return removed ? 0 : 1;
    }
    case 'audit': {
      const db = openDb(config.dataDir);
      const rows = db.prepare('SELECT ts, device_id, event, detail FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(arg) || 30, 1000)) as
        { ts: number; device_id: string | null; event: string; detail: string }[];
      const names = new Map(listDevices(db).map((d) => [d.id, d.name]));
      db.close();
      for (const r of rows.reverse()) console.log(`${new Date(r.ts).toISOString()}  ${(names.get(r.device_id ?? '') ?? r.device_id ?? '-').padEnd(20)}  ${r.event.padEnd(16)}  ${r.detail}`);
      return 0;
    }
    case 'backup': {
      const dest = resolve(arg ?? join(homedir(), `nrvl-stream-deck-backup-${new Date().toISOString().slice(0, 10)}.tgz`));
      const tmp = mkdtempSync(join(config.dataDir, 'backup-tmp-'));
      try {
        const db = openDb(config.dataDir);
        snapshot(db, config.dataDir, tmp);
        db.close();
        execFileSync('tar', ['-czf', dest, '-C', tmp, '.']);
        chmodSync(dest, 0o600);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      console.log(`Backup written to ${dest}\nKeep it private: it contains the hub's certificate key, and restoring it restores every pairing.`);
      return 0;
    }
    case 'restore': {
      if (!arg || !existsSync(arg)) break;
      if (await hubIsRunning()) {
        console.error('The hub is running. Stop it first (npm run service uninstall, or Ctrl+C), restore, then start it again.');
        return 1;
      }
      mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      let from = resolve(arg);
      const tmp = isSnapshot(from) ? null : mkdtempSync(join(config.dataDir, 'restore-tmp-'));
      try {
        if (tmp) {
          try {
            execFileSync('tar', ['-xzf', from, '-C', tmp], { stdio: 'pipe' });
          } catch {
            throw new Error('That file is not a readable backup archive');
          }
          from = tmp;
        }
        const aside = restore(config.dataDir, from);
        console.log(`Restored. The previous data was kept in ${aside}\nStart the hub again; paired devices reconnect on their own.`);
        return 0;
      } catch (err) {
        console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
        return 1;
      } finally {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
      }
    }
    case 'service': {
      if (process.platform !== 'darwin') {
        console.error('Auto-start is only implemented for macOS. On other systems run `npm run hub` from your own service manager.');
        return 1;
      }
      if (arg === 'install') {
        if (arg2 === '--dry-run') return console.log(servicePlist()), 0;
        if (!existsSync(join(config.webDir, 'index.html'))) return console.error('Build the iPad app first: npm run build'), 1;
        mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
        writeFileSync(plistPath, servicePlist());
        launchctl('bootout', `${domain}/${LABEL}`); // replace a previous install; fails harmlessly if there is none
        if (!launchctl('bootstrap', domain, plistPath)) return console.error(`launchctl could not load ${plistPath}`), 1;
        console.log(`Hub installed. It is running now and starts at every login.\n  App:   ${hubUrl(config)}\n  Logs:  ${logPath}\nRun this command again after upgrading Node.js or moving this folder.`);
        return 0;
      }
      if (arg === 'uninstall') {
        launchctl('bootout', `${domain}/${LABEL}`);
        rmSync(plistPath, { force: true });
        console.log(`Hub auto-start removed and the hub stopped. Its data in ${config.dataDir} is untouched.`);
        return 0;
      }
      if (arg === 'status') {
        console.log(`Auto-start: ${existsSync(plistPath) ? 'installed' : 'not installed'}\nHub:        ${(await hubIsRunning()) ? `running at ${hubUrl(config)}` : 'not running'}\nData:       ${config.dataDir}`);
        return 0;
      }
      break;
    }
  }
  console.error(USAGE);
  return 1;
}

process.exitCode = await main();
