// Integration + security tests: a real hub on ephemeral ports with real TLS, driven by WebSocket clients.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import type { HubMsg } from '@nrvl/shared';
import { isSnapshot, restore, snapshot } from '../src/backup.ts';
import { loadConfig } from '../src/config.ts';
import { createPairingCode, listDevices, listProfiles, openDb } from '../src/db.ts';
import { isLocalAddress, startHub } from '../src/hub.ts';

process.env.NRVL_SILENT = '1';
type Hub = Awaited<ReturnType<typeof startHub>>;
const dirs: string[] = [];
const hubs: Hub[] = [];
let tlsDir: string;

async function makeHub(over: Partial<ReturnType<typeof loadConfig>> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nrvl-test-'));
  dirs.push(dataDir);
  const hub = await startHub({ ...loadConfig({}), dataDir, port: 0, httpPort: 0, host: 'localhost', ips: [], execTimeoutMs: 300, ...over });
  hubs.push(hub);
  return hub;
}
before(() => void (tlsDir = mkdtempSync(join(tmpdir(), 'nrvl-test-'))));
after(async () => {
  await Promise.all(hubs.map((h) => h.close()));
  for (const d of [...dirs, tlsDir]) rmSync(d, { recursive: true, force: true });
});

function post(hub: Hub, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port: hub.port, path, method: 'POST', ca: hub.ca, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function pair(hub: Hub, role: 'controller' | 'agent', name = role) {
  const { code } = createPairingCode(hub.db, role);
  const res = await post(hub, '/api/pair', { code, name, os: role === 'agent' ? 'macos' : 'ios' });
  assert.equal(res.status, 200);
  const { deviceId, token } = res.body as { deviceId: string; token: string };
  return { deviceId, token };
}

/** WebSocket client that queues messages so tests can await them in order. */
function client(hub: Hub) {
  const ws = new WebSocket(`wss://localhost:${hub.port}/ws`, { ca: hub.ca });
  const queue: HubMsg[] = [];
  const waiters: ((m: HubMsg) => void)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as HubMsg;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () => new Promise<HubMsg>((resolve, reject) => {
    const m = queue.shift();
    if (m) return resolve(m);
    const t = setTimeout(() => reject(new Error('timed out waiting for message')), 2000);
    waiters.push((x) => (clearTimeout(t), resolve(x)));
  });
  return {
    ws, next,
    open: new Promise<void>((r, j) => (ws.once('open', () => r()), ws.once('error', j))),
    closed: new Promise<number>((r) => ws.once('close', (code) => r(code))),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /** Next message of the given type, skipping others (e.g. state broadcasts). */
    async until<T extends HubMsg['t']>(t: T): Promise<Extract<HubMsg, { t: T }>> {
      for (;;) {
        const m = await next();
        if (m.t === t) return m as Extract<HubMsg, { t: T }>;
      }
    },
  };
}

async function connect(hub: Hub, creds: { deviceId: string; token: string }) {
  const c = client(hub);
  await c.open;
  c.send({ t: 'hello', v: 1, ...creds });
  const welcome = await c.until('welcome');
  return { ...c, welcome };
}

const CAPS = ['volume.set', 'url.open', 'system.sleep'];
async function setup(hub: Hub) {
  const agentCreds = await pair(hub, 'agent');
  const agent = await connect(hub, agentCreds);
  agent.send({ t: 'status', capabilities: CAPS, status: { volume: 50, muted: false } });
  const ctl = await connect(hub, await pair(hub, 'controller'));
  assert.ok((await ctl.until('state')).profiles, 'first state after connecting carries the profiles');
  // Wait until the controller sees the agent online with its capabilities.
  for (;;) {
    const s = await ctl.until('state');
    if (s.devices.find((d) => d.id === agentCreds.deviceId)?.capabilities.length) break;
  }
  return { agent, ctl, agentId: agentCreds.deviceId, agentCreds };
}
const exec = (target: string, action: unknown, id = 'e1') => ({ t: 'execute', id, target, action });

test('isLocalAddress only accepts private ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.20', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::1', '::ffff:192.168.1.5', 'fe80::1', 'fd00::1']) assert.ok(isLocalAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '100.64.0.1', '2001:4860::1', '', undefined]) assert.ok(!isLocalAddress(ip), String(ip));
});

test('database migrations are idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nrvl-test-'));
  dirs.push(dir);
  openDb(dir).close();
  const db = openDb(dir);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 1);
  db.close();
});

test('pairing code works exactly once; bad codes are rejected', async () => {
  const hub = await makeHub();
  const { code } = createPairingCode(hub.db, 'controller');
  const body = { code: code.toLowerCase().replace('-', ' '), name: 'iPad', os: 'ios' }; // tolerant of formatting
  assert.equal((await post(hub, '/api/pair', body)).status, 200);
  assert.equal((await post(hub, '/api/pair', body)).status, 403, 'replayed code');
  assert.equal((await post(hub, '/api/pair', { ...body, code: 'AAAAA-AAAAA' })).status, 403);
  assert.equal((await post(hub, '/api/pair', { code })).status, 400, 'schema');
});

test('expired pairing code is rejected', async () => {
  const hub = await makeHub();
  const { code } = createPairingCode(hub.db, 'controller', -1);
  assert.equal((await post(hub, '/api/pair', { code, name: 'iPad', os: 'ios' })).status, 403);
});

test('pairing attempts are rate limited', async () => {
  const hub = await makeHub();
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await post(hub, '/api/pair', { code: 'WRONG-CODEX', name: 'x', os: 'ios' })).status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429, 429]);
});

test('unauthenticated sockets cannot execute anything', async () => {
  const hub = await makeHub();
  const { agent, agentId } = await setup(hub);
  const c = client(hub);
  await c.open;
  c.send(exec(agentId, { type: 'volume.set', params: { level: 100 } }));
  assert.deepEqual(await c.next(), { t: 'error', error: 'unauthorized' });
  assert.equal(await c.closed, 4003);

  const bad = client(hub);
  await bad.open;
  bad.send({ t: 'hello', v: 1, deviceId: agentId, token: 'x'.repeat(43) });
  assert.deepEqual(await bad.next(), { t: 'error', error: 'unauthorized' });
  assert.equal(await bad.closed, 4003);
  await assert.rejects(agent.next(), /timed out/, 'agent must not receive anything');
});

test('execute round trip reports the agent\'s real outcome', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);

  ctl.send(exec(agentId, { type: 'volume.set', params: { level: 35 } }, 'ok1'));
  const cmd = await agent.until('execute');
  assert.deepEqual(cmd.action, { type: 'volume.set', params: { level: 35 } });
  assert.ok(Math.abs(cmd.ts - Date.now()) < 2000);
  agent.send({ t: 'result', id: cmd.id, ok: true });
  assert.deepEqual(await ctl.until('result'), { t: 'result', id: 'ok1', ok: true });

  ctl.send(exec(agentId, { type: 'volume.set', params: { level: 36 } }, 'fail1'));
  agent.send({ t: 'result', id: (await agent.until('execute')).id, ok: false, error: 'No output device' });
  assert.deepEqual(await ctl.until('result'), { t: 'result', id: 'fail1', ok: false, error: 'No output device' });

  const rows = hub.db.prepare("SELECT detail FROM audit WHERE event='execute'").all() as { detail: string }[];
  assert.deepEqual(rows.map((r) => JSON.parse(r.detail).ok), [true, false], 'both executions audited');
});

test('invalid, unsupported and offline executions fail without reaching the agent', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);

  ctl.send(exec(agentId, { type: 'url.open', params: { url: 'file:///etc/passwd' } }, 'a'));
  let r = await ctl.until('result');
  assert.equal(r.id, 'a');
  assert.equal(r.ok, false);

  ctl.send(exec(agentId, { type: 'shell.exec', params: { cmd: 'id' } }, 'b'));
  assert.equal((await ctl.until('result')).ok, false);

  ctl.send(exec(agentId, { type: 'media.next', params: {} }, 'c')); // valid, but not in the agent's capabilities
  r = await ctl.until('result');
  assert.match(r.error ?? '', /does not support/);

  ctl.send(exec('no-such-device', { type: 'volume.set', params: { level: 1 } }, 'd'));
  assert.match((await ctl.until('result')).error ?? '', /offline/);

  await assert.rejects(agent.next(), /timed out/, 'agent must not receive anything');
});

test('a silent agent produces a timeout failure, a dropped agent a disconnect failure', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);
  ctl.send(exec(agentId, { type: 'volume.set', params: { level: 1 } }, 't'));
  assert.match((await ctl.until('result')).error ?? '', /Timed out/);

  ctl.send(exec(agentId, { type: 'volume.set', params: { level: 1 } }, 'u'));
  await agent.until('execute');
  await agent.until('execute');
  agent.ws.terminate();
  assert.match((await ctl.until('result')).error ?? '', /disconnected/);
});

test('an agent cannot send controller commands', async () => {
  const hub = await makeHub();
  const { agent, agentId } = await setup(hub);
  agent.send({ t: 'device.remove', id: agentId });
  assert.deepEqual(await agent.next(), { t: 'error', error: 'Invalid message' });
  assert.equal((hub.db.prepare('SELECT count(*) n FROM devices').get() as any).n, 2);
});

test('removing a device disconnects it and invalidates its token', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId, agentCreds } = await setup(hub);
  ctl.send({ t: 'device.remove', id: agentId });
  assert.equal(await agent.closed, 4003);
  const again = client(hub);
  await again.open;
  again.send({ t: 'hello', v: 1, ...agentCreds });
  assert.deepEqual(await again.next(), { t: 'error', error: 'unauthorized' });
});

test('profiles are validated, stored and broadcast; first agent seeds a starter profile', async () => {
  const hub = await makeHub();
  const { ctl, agentId } = await setup(hub);
  ctl.send({ t: 'ping' });
  await ctl.until('pong');
  const profile = {
    schemaVersion: 1, id: 'p-new', name: 'Mine', grid: { cols: 3, rows: 3 },
    pages: [{ id: 'pg', name: 'Main', buttons: { '4': { id: 'b', label: 'Mute', target: agentId, action: { type: 'volume.mute', params: {} } } } }],
  };
  const profiles = async () => {
    for (;;) {
      const s = await ctl.until('state');
      if (s.profiles) return s.profiles.map((p) => p.name);
    }
  };
  ctl.send({ t: 'profile.put', profile });
  assert.deepEqual(await profiles(), ['Starter', 'Mine']);
  ctl.send({ t: 'profile.delete', id: 'p-new' });
  assert.deepEqual(await profiles(), ['Starter']);
  ctl.send({ t: 'profile.put', profile: { ...profile, grid: { cols: 0, rows: 3 } } });
  assert.equal((await ctl.until('error')).error.startsWith('Invalid request'), true);
});

test('a Windows computer pairs and gets a Windows starter profile', async () => {
  const hub = await makeHub();
  const { code } = createPairingCode(hub.db, 'agent');
  assert.equal((await post(hub, '/api/pair', { code, name: 'Windows Desktop', os: 'windows' })).status, 200);
  const doc = (hub.db.prepare('SELECT doc FROM profiles').get() as { doc: string }).doc;
  assert.match(doc, /notepad/);
  assert.doesNotMatch(doc, /Safari/);
});

test('controllers can create pairing codes for new devices', async () => {
  const hub = await makeHub();
  const { ctl } = await setup(hub);
  ctl.send({ t: 'pairing.create', role: 'controller' });
  const p = await ctl.until('pairing');
  assert.match(p.text, /^https:\/\/localhost:\d+\/#pair=/);
  assert.match(p.qr ?? '', /^<svg/);
  assert.equal((await post(hub, '/api/pair', { code: p.code, name: 'iPad 2', os: 'ios' })).status, 200);
  ctl.send({ t: 'pairing.create', role: 'agent' });
  const a = await ctl.until('pairing');
  const decoded = JSON.parse(Buffer.from(a.text.replace('nrvl1.', ''), 'base64url').toString());
  assert.equal(decoded.f, hub.caFingerprint);
  assert.equal(decoded.c, a.code);
});

test('tokens rotate; the old token works only until the new one is used', async () => {
  const hub = await makeHub({ tokenRotateMs: 0 });
  const creds = await pair(hub, 'controller');
  const first = await connect(hub, creds);
  const t2 = first.welcome.newToken;
  assert.ok(t2, 'rotated token issued');
  first.ws.close();

  // Device "lost" the new token and reconnects with the old one: still allowed, gets a fresh token.
  const second = await connect(hub, creds);
  const t3 = second.welcome.newToken;
  assert.ok(t3 && t3 !== t2);
  second.ws.close();

  // Device now uses the new token; the original is revoked.
  const third = await connect(hub, { deviceId: creds.deviceId, token: t3 });
  third.ws.close();
  const stale = client(hub);
  await stale.open;
  stale.send({ t: 'hello', v: 1, ...creds });
  assert.deepEqual(await stale.next(), { t: 'error', error: 'unauthorized' });
});

test('message flooding closes the socket', async () => {
  const hub = await makeHub();
  const ctl = await connect(hub, await pair(hub, 'controller'));
  for (let i = 0; i < 80; i++) ctl.send({ t: 'ping' });
  assert.equal(await ctl.closed, 1008);
});

// ---------- macros ----------
const vol = (target: string | undefined, level: number, over: object = {}) =>
  ({ kind: 'action', target, action: { type: 'volume.set', params: { level } }, onError: 'stop', ifOffline: 'fail', ...over });

/** Fake agent that answers every command; levels in `fail` are reported as failures. */
function autoAgent(agent: Awaited<ReturnType<typeof connect>>, fail: number[] = []) {
  const seen: number[] = [];
  agent.ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as HubMsg;
    if (m.t !== 'execute') return;
    const level = m.action.params.level as number;
    seen.push(level);
    agent.send({ t: 'result', id: m.id, ok: !fail.includes(level), ...(fail.includes(level) && { error: 'boom' }) });
  });
  return seen;
}
async function collect(ctl: Awaited<ReturnType<typeof connect>>, id: string) {
  const progress: string[] = [];
  for (;;) {
    const m = await ctl.next();
    if (m.t === 'macro.progress' && m.id === id && m.status !== 'running') progress.push(`${m.index}:${m.status}`);
    if (m.t === 'result' && m.id === id) return { progress, result: m };
  }
}

test('macro runs steps in order with delays and reports each step', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);
  const seen = autoAgent(agent);
  const started = Date.now();
  ctl.send({ t: 'macro.run', id: 'm1', steps: [vol(agentId, 10), { kind: 'delay', ms: 150 }, vol(agentId, 20)] });
  const { progress, result } = await collect(ctl, 'm1');
  assert.deepEqual(progress, ['0:ok', '1:ok', '2:ok']);
  assert.deepEqual(result, { t: 'result', id: 'm1', ok: true });
  assert.deepEqual(seen, [10, 20]);
  assert.ok(Date.now() - started >= 140, 'delay was honoured');
});

test('macro error handling: stop ends the macro, continue carries on but the macro still reports failure', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);
  const seen = autoAgent(agent, [13]);

  ctl.send({ t: 'macro.run', id: 'stop', steps: [vol(agentId, 13), vol(agentId, 20)] });
  let out = await collect(ctl, 'stop');
  assert.deepEqual(out.progress, ['0:failed']);
  assert.deepEqual(out.result, { t: 'result', id: 'stop', ok: false, error: 'Step 1 failed: boom' });
  assert.deepEqual(seen, [13], 'step 2 never ran');

  ctl.send({ t: 'macro.run', id: 'cont', steps: [vol(agentId, 13, { onError: 'continue' }), vol(agentId, 30)] });
  out = await collect(ctl, 'cont');
  assert.deepEqual(out.progress, ['0:failed', '1:ok']);
  assert.deepEqual(out.result, { t: 'result', id: 'cont', ok: false, error: '1 step failed' });
  assert.deepEqual(seen, [13, 13, 30]);
});

test('macro conditions: offline computers can be skipped; navigation steps go back to the controller', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);
  autoAgent(agent);
  const nav = { kind: 'action', action: { type: 'profile.switch', params: { profileId: 'p2' } }, onError: 'stop', ifOffline: 'fail' };
  ctl.send({ t: 'macro.run', id: 'm', steps: [vol('gone', 1, { ifOffline: 'skip' }), nav, vol(agentId, 5)] });
  const actions: unknown[] = [];
  const progress: string[] = [];
  for (;;) {
    const m = await ctl.next();
    if (m.t === 'macro.progress' && m.status !== 'running') (progress.push(`${m.index}:${m.status}`), m.action && actions.push(m.action));
    if (m.t === 'result') {
      assert.equal(m.ok, true);
      break;
    }
  }
  assert.deepEqual(progress, ['0:skipped', '1:ok', '2:ok']);
  assert.deepEqual(actions, [{ type: 'profile.switch', params: { profileId: 'p2' } }]);
});

test('macro can be cancelled during a delay; later steps do not run', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);
  const seen = autoAgent(agent);
  ctl.send({ t: 'macro.run', id: 'c', steps: [vol(agentId, 1), { kind: 'delay', ms: 30_000 }, vol(agentId, 2)] });
  for (;;) {
    const m = await ctl.next();
    if (m.t === 'macro.progress' && m.index === 1 && m.status === 'running') break;
  }
  ctl.send({ t: 'macro.cancel', id: 'c' });
  const { result } = await collect(ctl, 'c');
  assert.deepEqual(result, { t: 'result', id: 'c', ok: false, error: 'Cancelled before step 3 of 3' });
  assert.deepEqual(seen, [1]);
});

test('invalid macros are rejected whole: nested macros, missing computer, too many steps', async () => {
  const hub = await makeHub();
  const { agent, ctl, agentId } = await setup(hub);
  const nested = { kind: 'action', action: { type: 'macro.run', params: { steps: [vol(agentId, 1)] } }, onError: 'stop', ifOffline: 'fail' };
  for (const steps of [[nested], [vol(undefined, 1)], Array(51).fill(vol(agentId, 1)), [{ kind: 'delay', ms: 999_999 }], []]) {
    ctl.send({ t: 'macro.run', id: 'bad', steps });
    const r = await ctl.until('result');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /^Invalid request/);
  }
  await assert.rejects(agent.next(), /timed out/, 'agent must not receive anything');
});

// ---------- hardening, backup and recovery ----------
function get(hub: Hub, path: string, method = 'GET'): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port: hub.port, path, method, ca: hub.ca }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, type: String(res.headers['content-type']) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('static files: no path traversal, no private keys, only safe methods', async () => {
  const hub = await makeHub();
  for (const path of ['/../tls/ca.key', '/..%2f..%2ftls%2fca.key', '/%2e%2e/%2e%2e/tls/ca.key', '/assets/../../../../etc/passwd', '/tls/ca.key', '/hub.db', '/%00', '/%E0%A4%A']) {
    const r = await get(hub, path);
    assert.ok(!r.body.includes('PRIVATE KEY') && !r.body.includes('root:') && !r.body.includes('SQLite format'), `leak via ${path}`);
    assert.ok([200, 400, 404].includes(r.status), `${path} -> ${r.status}`);
    if (r.status === 200) assert.match(r.type, /text\/html/, 'only the app shell may be served for unknown paths');
  }
  const ca = await get(hub, '/ca.crt');
  assert.match(ca.body, /BEGIN CERTIFICATE/);
  assert.doesNotMatch(ca.body, /PRIVATE KEY/);
  assert.equal((await get(hub, '/', 'DELETE')).status, 405);
  assert.equal((await post(hub, '/api/pair', { code: 'x'.repeat(10_000), name: 'x', os: 'ios' })).status, 400, 'oversized body');
});

test('a flood of failed logins is throttled and cannot fill the audit log', async () => {
  const hub = await makeHub();
  const attempt = async () => {
    const c = client(hub);
    await c.open;
    c.send({ t: 'hello', v: 1, deviceId: 'nobody', token: 'x'.repeat(43) });
    await c.closed;
  };
  for (let i = 0; i < 40; i++) await attempt();
  const n = (hub.db.prepare("SELECT count(*) n FROM audit WHERE event='auth.failed'").get() as { n: number }).n;
  assert.equal(n, 30);
});

test('the hub backs itself up at start; a snapshot restores devices, profiles and trust', async () => {
  const hub = await makeHub();
  const { ctl, agentCreds } = await setup(hub);
  const dataDir = dirs[dirs.length - 1]!;
  assert.deepEqual(readdirSync(join(dataDir, 'backups')).map((n) => n.slice(0, 5)), ['auto-'], 'automatic backup exists');

  const snap = join(tlsDir, 'snap');
  snapshot(hub.db, dataDir, snap); // taken while the hub is running and connected
  assert.ok(isSnapshot(snap));
  ctl.ws.close();

  // "Disaster": a brand-new data folder. Restore into it and start a hub there.
  const fresh = mkdtempSync(join(tmpdir(), 'nrvl-test-'));
  dirs.push(fresh);
  const aside = restore(fresh, snap);
  assert.ok(existsSync(aside));
  assert.equal(readFileSync(join(fresh, 'tls/ca.crt'), 'utf8'), hub.ca, 'same certificate authority, so devices still trust the hub');
  const hub2 = await startHub({ ...loadConfig({}), dataDir: fresh, port: 0, httpPort: 0, host: 'localhost', ips: [] });
  hubs.push(hub2);
  assert.equal(listDevices(hub2.db).length, 2);
  assert.deepEqual(listProfiles(hub2.db).map((p) => p.name), ['Starter']);
  const again = await connect(hub2, agentCreds); // the agent's old token and pinned CA still work
  assert.equal(again.welcome.deviceId, agentCreds.deviceId);

  assert.throws(() => restore(fresh, join(tlsDir, 'not-a-backup')), /not an NRVL/);
});
