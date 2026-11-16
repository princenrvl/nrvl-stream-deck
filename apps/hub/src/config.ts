import { execFileSync } from 'node:child_process';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';

export type Config = {
  dataDir: string;
  port: number; // HTTPS + WSS
  httpPort: number; // plain HTTP: certificate download + setup page only
  host: string; // mDNS name the iPad and agents use, e.g. my-mac.local
  ips: string[];
  webDir: string;
  execTimeoutMs: number;
  tokenRotateMs: number;
};

function localHostName(): string {
  if (process.platform === 'darwin') {
    try {
      return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() + '.local';
    } catch {
      /* fall through */
    }
  }
  return hostname();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
  return {
    dataDir: env.NRVL_DATA_DIR ?? join(homedir(), '.nrvl-stream-deck'),
    port: Number(env.NRVL_PORT ?? 8443),
    httpPort: Number(env.NRVL_HTTP_PORT ?? 8080),
    host: env.NRVL_HOST ?? localHostName(),
    ips,
    webDir: join(import.meta.dirname, '../../web/dist'),
    execTimeoutMs: 10_000,
    tokenRotateMs: 30 * 24 * 3600_000,
  };
}

export const hubUrl = (c: Config) => `https://${c.host}:${c.port}`;

export function log(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): void {
  if (process.env.NRVL_SILENT) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));
}
