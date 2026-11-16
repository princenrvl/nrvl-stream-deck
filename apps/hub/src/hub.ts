// The hub: HTTPS (web app + pairing), WSS (controllers + agents), and a plain-HTTP port for certificate install.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AgentMsgSchema, ControllerMsgSchema, HelloSchema, isClientAction, PairRequestSchema,
  type Action, type AgentStatus, type DeviceInfo, type HubMsg, type MacroStep, type Role, type StepStatus,
} from '@nrvl/shared';
import { dailyBackup } from './backup.ts';
import { hubUrl, log, type Config } from './config.ts';
import {
  audit, authenticate, createPairingCode, deleteProfile, getDevice, listDevices, listProfiles, openDb, putProfile,
  redeemPairingCode, removeDevice, starterProfile, touchDevice,
} from './db.ts';
import { ensureCerts } from './tls.ts';

/** True for loopback, link-local and RFC 1918 / ULA addresses. Everything else is refused. */
export function isLocalAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const ip = addr.replace(/^::ffff:/i, '');
  if (ip.includes(':')) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  const [a = -1, b = -1] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** Fixed-window counter. hit() returns false once the key is over its limit. */
class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= now) this.hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    return ++h.n <= limit;
  }
}

export const agentPairingString = (c: Config, code: string, caFingerprint: string) =>
  'nrvl1.' + Buffer.from(JSON.stringify({ u: hubUrl(c), c: code, f: caFingerprint })).toString('base64url');
export const controllerPairingUrl = (c: Config, code: string) => `${hubUrl(c)}/#pair=${code}`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};

const MAX_SOCKETS = 100; // far above any home setup; stops a misbehaving device from exhausting the hub
type Conn = { ws: WebSocket; id: string; role: Role; capabilities: string[]; status: AgentStatus | null };
type Pending = { agentId: string; timer: NodeJS.Timeout; done: (ok: boolean, error?: string) => void };
type Outcome = { ok: boolean; error?: string };
type MacroRun = { cancelled: boolean; wake?: () => void };

export async function startHub(config: Config) {
  const certs = ensureCerts(config.dataDir, [config.host, ...config.ips]);
  const db = openDb(config.dataDir);
  const limiter = new RateLimiter();
  const conns = new Map<string, Conn>();
  const pending = new Map<string, Pending>();
  const macros = new Map<string, MacroRun>(); // key: controller device id + macro id
  const alive = new WeakMap<WebSocket, boolean>();

  const send = (ws: WebSocket, msg: HubMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  function deviceInfos(): DeviceInfo[] {
    return listDevices(db).map((d) => {
      const c = conns.get(d.id);
      return {
        id: d.id, name: d.name, role: d.role, os: d.os, online: !!c, lastSeen: c ? Date.now() : d.last_seen,
        capabilities: c?.role === 'agent' ? c.capabilities : (JSON.parse(d.capabilities) as string[]),
        status: c?.status ?? null,
      };
    });
  }
  // Device status changes often; profiles rarely and can be large (icons), so they only ride along when asked.
  function broadcastState(withProfiles = false, only?: Conn) {
    const msg: HubMsg = { t: 'state', devices: deviceInfos(), ...(withProfiles && { profiles: listProfiles(db) }) };
    for (const c of only ? [only] : conns.values()) if (c.role === 'controller') send(c.ws, msg);
  }

  // ---------- HTTP ----------
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  };
  const sendCa = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="nrvl-stream-deck-ca.crt"' });
    res.end(certs.ca);
  };

  async function readBody(req: IncomingMessage, max: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      if ((size += chunk.length) > max) throw new Error('Body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse, ip: string) {
    if (!limiter.hit(`pair:${ip}`, 5, 60_000)) return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch {
      return json(res, 400, { error: 'Invalid request' });
    }
    const parsed = PairRequestSchema.safeParse(body);
    if (!parsed.success) return json(res, 400, { error: 'Invalid request' });
    const out = redeemPairingCode(db, parsed.data.code, parsed.data.name, parsed.data.os);
    if (!out) {
      audit(db, null, 'pair.failed', { ip });
      return json(res, 403, { error: 'Invalid or expired pairing code' });
    }
    // First computer paired: give the user something to press.
    if (out.role === 'agent' && listProfiles(db).length === 0) putProfile(db, starterProfile(out.deviceId, parsed.data.os));
    audit(db, out.deviceId, 'pair.ok', { role: out.role, name: parsed.data.name, ip });
    log('info', 'device.paired', { deviceId: out.deviceId, role: out.role, name: parsed.data.name });
    broadcastState(true);
    json(res, 200, out);
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    let file: string;
    try {
      file = join(config.webDir, normalize(decodeURIComponent(pathname)));
    } catch {
      return json(res, 400, { error: 'Bad path' });
    }
    if (file !== config.webDir && !file.startsWith(config.webDir + sep)) return json(res, 404, { error: 'Not found' });
    if (!extname(file)) file = join(config.webDir, 'index.html'); // single-page app fallback
    try {
      const body = await readFile(file);
      const immutable = pathname.startsWith('/assets/'); // Vite content-hashed files
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(body);
    } catch {
      json(res, 404, { error: file.endsWith('index.html') ? 'Web app not built. Run: npm run build' : 'Not found' });
    }
  }

  const https = createHttps({ key: certs.key, cert: certs.cert + certs.ca }, (req, res) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!isLocalAddress(ip)) return void res.writeHead(403).end();
    const { pathname } = new URL(req.url ?? '/', 'https://hub');
    const run = async () => {
      if (req.method === 'POST' && pathname === '/api/pair') return handlePair(req, res, ip);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      if (pathname === '/ca.crt') return sendCa(res);
      return serveStatic(pathname, res);
    };
    run().catch((err) => {
      log('error', 'http.error', { message: String(err) });
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      else res.end();
    });
  });

  // Plain HTTP exists only so a new iPad can fetch the CA certificate before it trusts the hub.
  const http = createHttp((req, res) => {
    if (!isLocalAddress(req.socket.remoteAddress)) return void res.writeHead(403).end();
    if (req.url === '/ca.crt') return sendCa(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(setupPage(hubUrl(config)));
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ server: https, path: '/ws', maxPayload: 4 * 1024 * 1024 }); // room for a profile with image icons

  function failPendingFor(agentId: string, error: string) {
    for (const p of pending.values()) if (p.agentId === agentId) p.done(false, error);
  }

  function dropDevice(id: string) {
    const c = conns.get(id);
    if (c) {
      send(c.ws, { t: 'error', error: 'unauthorized' });
      c.ws.close(4003, 'revoked');
    }
  }

  /** Sends one action to one computer and resolves with what that computer reported. Always audited. */
  function runAction(by: string, target: string, action: Action): Promise<Outcome> {
    return new Promise((resolve) => {
      const finish = (ok: boolean, error?: string) => {
        audit(db, by, 'execute', { target, action: action.type, ok, error });
        resolve(ok ? { ok } : { ok, error });
      };
      const agent = conns.get(target);
      if (!agent || agent.role !== 'agent') return finish(false, 'Computer is offline');
      if (!agent.capabilities.includes(action.type)) return finish(false, 'This computer does not support that action');
      const execId = randomUUID();
      const done = (ok: boolean, error?: string) => {
        const p = pending.get(execId);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(execId);
        finish(ok, error);
      };
      const timer = setTimeout(() => done(false, 'Timed out waiting for the computer'), config.execTimeoutMs);
      pending.set(execId, { agentId: agent.id, timer, done });
      send(agent.ws, { t: 'execute', id: execId, ts: Date.now(), action });
    });
  }

  /**
   * Runs macro steps in order on the hub, so a macro keeps going even if the iPad drops off Wi-Fi mid-way.
   * Every step change is reported; the final `result` is ok only if no step failed.
   */
  async function runMacro(conn: Conn, id: string, steps: MacroStep[]) {
    const key = `${conn.id}:${id}`;
    const finish = (ok: boolean, error?: string) => send(conn.ws, { t: 'result', id, ok, ...(error && { error }) });
    if (macros.has(key)) return finish(false, 'That macro is already running');
    if ([...macros.keys()].filter((k) => k.startsWith(`${conn.id}:`)).length >= 5) return finish(false, 'Too many macros are running');
    const run: MacroRun = { cancelled: false };
    macros.set(key, run);
    const progress = (index: number, status: StepStatus, extra: { error?: string; action?: Action } = {}) =>
      send(conn.ws, { t: 'macro.progress', id, index, total: steps.length, status, ...extra });
    let failures = 0;
    try {
      for (const [index, step] of steps.entries()) {
        if (run.cancelled) return finish(false, `Cancelled before step ${index + 1} of ${steps.length}`);
        progress(index, 'running');
        if (step.kind === 'delay') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, step.ms);
            run.wake = () => (clearTimeout(timer), resolve());
          });
          run.wake = undefined;
          progress(index, 'ok');
        } else if (isClientAction(step.action.type)) {
          progress(index, 'ok', { action: step.action }); // the controller performs navigation steps itself
        } else if (step.ifOffline === 'skip' && !conns.has(step.target!)) {
          progress(index, 'skipped');
        } else {
          const r = await runAction(conn.id, step.target!, step.action);
          progress(index, r.ok ? 'ok' : 'failed', r.ok ? {} : { error: r.error });
          if (!r.ok) {
            failures++;
            if (step.onError === 'stop') return finish(false, `Step ${index + 1} failed: ${r.error}`);
          }
        }
      }
      finish(failures === 0, failures ? `${failures} step${failures > 1 ? 's' : ''} failed` : undefined);
    } finally {
      macros.delete(key);
      audit(db, conn.id, 'macro.run', { steps: steps.length, failures, cancelled: run.cancelled });
    }
  }

  async function onControllerMsg(conn: Conn, raw: unknown) {
    const parsed = ControllerMsgSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      const error = `Invalid request: ${parsed.error.issues[0]?.message ?? 'bad message'}`;
      const awaited = ['execute', 'macro.run'].includes(String((raw as { t?: unknown } | null)?.t)); // the sender is waiting on this id
      return void send(conn.ws, typeof id === 'string' && awaited ? { t: 'result', id, ok: false, error } : { t: 'error', error });
    }
    const msg = parsed.data;
    switch (msg.t) {
      case 'ping':
        return void send(conn.ws, { t: 'pong' });
      case 'execute':
        return void send(conn.ws, { t: 'result', id: msg.id, ...(await runAction(conn.id, msg.target, msg.action as Action)) });
      case 'macro.run':
        return runMacro(conn, msg.id, msg.steps as MacroStep[]);
      case 'macro.cancel': {
        const run = macros.get(`${conn.id}:${msg.id}`);
        if (run) {
          run.cancelled = true;
          run.wake?.(); // cut a delay short
        }
        return;
      }
      case 'profile.put':
        putProfile(db, msg.profile as never);
        audit(db, conn.id, 'profile.put', { profile: msg.profile.id });
        return broadcastState(true);
      case 'profile.delete':
        if (deleteProfile(db, msg.id)) audit(db, conn.id, 'profile.deleted', { profile: msg.id });
        return broadcastState(true);
      case 'device.remove':
        if (removeDevice(db, msg.id)) {
          audit(db, conn.id, 'device.removed', { removed: msg.id });
          log('info', 'device.removed', { deviceId: msg.id, by: conn.id });
          dropDevice(msg.id);
        }
        return broadcastState();
      case 'pairing.create': {
        const { code, expiresAt } = createPairingCode(db, msg.role);
        audit(db, conn.id, 'pairing.created', { role: msg.role });
        if (msg.role === 'agent') return void send(conn.ws, { t: 'pairing', role: 'agent', code, expiresAt, text: agentPairingString(config, code, certs.caFingerprint) });
        const url = controllerPairingUrl(config, code);
        return void send(conn.ws, { t: 'pairing', role: 'controller', code, expiresAt, text: url, qr: await QRCode.toString(url, { type: 'svg', margin: 1 }) });
      }
    }
  }

  function onAgentMsg(conn: Conn, raw: unknown) {
    const parsed = AgentMsgSchema.safeParse(raw);
    if (!parsed.success) return void send(conn.ws, { t: 'error', error: 'Invalid message' });
    const msg = parsed.data;
    switch (msg.t) {
      case 'ping':
        return void send(conn.ws, { t: 'pong' });
      case 'result': {
        const p = pending.get(msg.id);
        if (p?.agentId === conn.id) p.done(msg.ok, msg.ok ? undefined : (msg.error ?? 'Action failed'));
        return;
      }
      case 'status':
        conn.capabilities = msg.capabilities;
        conn.status = msg.status;
        touchDevice(db, conn.id, msg.capabilities);
        return broadcastState();
    }
  }

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!isLocalAddress(ip) || wss.clients.size > MAX_SOCKETS) return ws.close(1008);
    const connKey = randomUUID();
    let conn: Conn | null = null;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 5000);

    ws.on('message', (data, isBinary) => {
      if (isBinary || !limiter.hit(`msg:${connKey}`, 50, 1000)) return ws.close(1008, 'policy');
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return void send(ws, { t: 'error', error: 'Invalid JSON' });
      }

      if (!conn) {
        // Nothing but a valid hello is accepted on an unauthenticated socket.
        const hello = HelloSchema.safeParse(raw);
        const allowed = limiter.hit(`hello:${ip}`, 30, 60_000);
        const auth = hello.success && allowed ? authenticate(db, hello.data.deviceId, hello.data.token, config.tokenRotateMs) : null;
        if (!auth) {
          if (allowed) audit(db, null, 'auth.failed', { ip }); // a flood must not be able to fill the audit table
          send(ws, { t: 'error', error: 'unauthorized' });
          return ws.close(4003, 'unauthorized');
        }
        clearTimeout(helloTimer);
        conns.get(auth.device.id)?.ws.close(4000, 'replaced');
        conn = { ws, id: auth.device.id, role: auth.device.role, capabilities: [], status: null };
        conns.set(conn.id, conn);
        touchDevice(db, conn.id);
        log('info', 'device.connected', { deviceId: conn.id, role: conn.role });
        send(ws, { t: 'welcome', deviceId: conn.id, newToken: auth.newToken });
        broadcastState(true, conn);
        return broadcastState();
      }

      // A device removed while connected (UI or CLI) loses access immediately.
      if (!getDevice(db, conn.id)) return dropDevice(conn.id);
      if (conn.role === 'controller') onControllerMsg(conn, raw).catch((err) => log('error', 'ws.error', { message: String(err) }));
      else onAgentMsg(conn, raw);
    });

    ws.on('error', (err) => log('warn', 'ws.socket_error', { message: err.message }));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn || conns.get(conn.id) !== conn) return;
      conns.delete(conn.id);
      if (conn.role === 'agent') failPendingFor(conn.id, 'Computer disconnected');
      if (getDevice(db, conn.id)) touchDevice(db, conn.id);
      log('info', 'device.disconnected', { deviceId: conn.id });
      broadcastState();
    });
  });

  // Heartbeat: a socket that misses one ping round is dead (covers Wi-Fi drops that never send a FIN).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 10_000);

  // A snapshot at start-up and then daily, so a bad edit or a corrupted file costs at most a day.
  const backup = () => {
    try {
      log('info', 'backup.ok', { path: dailyBackup(db, config.dataDir) });
    } catch (err) {
      log('error', 'backup.failed', { message: String(err) });
    }
  };
  backup();
  const backupTimer = setInterval(backup, 24 * 3600_000);
  backupTimer.unref();

  const listen = (srv: typeof http | typeof https, port: number) =>
    new Promise<number>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, () => resolve((srv.address() as AddressInfo).port));
    });
  const port = await listen(https, config.port);
  const httpPort = await listen(http, config.httpPort);

  return {
    db, port, httpPort, ca: certs.ca, caFingerprint: certs.caFingerprint,
    async close() {
      clearInterval(heartbeat);
      clearInterval(backupTimer);
      for (const run of macros.values()) (run.cancelled = true), run.wake?.();
      for (const p of pending.values()) p.done(false, 'Hub is shutting down');
      for (const ws of wss.clients) ws.close(1001, 'shutdown');
      await new Promise((r) => wss.close(r));
      https.closeAllConnections();
      http.closeAllConnections();
      await Promise.all([new Promise((r) => https.close(r)), new Promise((r) => http.close(r))]);
      db.close();
    },
  };
}

function setupPage(appUrl: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NRVL Stream Deck setup</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:34rem;margin:8vh auto;padding:0 20px;background:#0b0d12;color:#e8ebf2}
a.btn{display:inline-block;background:#2f7dff;color:#fff;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:600}
li{margin:.7em 0}code{background:#1a1e28;padding:2px 6px;border-radius:6px}h1{font-size:1.5rem}</style>
<h1>NRVL Stream Deck — first-time setup</h1>
<p>Your iPad must trust this hub's private certificate so the connection is encrypted. You only do this once per device.</p>
<ol>
<li><a class="btn" href="/ca.crt">Download certificate</a><br>Tap <b>Allow</b> when asked to download a configuration profile.</li>
<li>Open <b>Settings → General → VPN &amp; Device Management</b>, tap <b>NRVL Stream Deck Local CA</b> and <b>Install</b>.</li>
<li>Open <b>Settings → General → About → Certificate Trust Settings</b> and switch on <b>NRVL Stream Deck Local CA</b>.</li>
<li>Scan the pairing QR code shown by the hub, or open <a href="${appUrl}">${appUrl}</a> and enter the pairing code.</li>
<li>In Safari tap <b>Share → Add to Home Screen</b> to install the app.</li>
</ol></html>`;
}
