// Manual end-to-end check against a RUNNING hub and a RUNNING macOS agent (not part of `npm test`).
// It pairs a throwaway controller and drives this Mac through the full stack, restoring everything it changes:
// volume, microphone mute, a macro with a delay, live state (running apps), and failure reporting.
//   node apps/hub/test/e2e-mac.ts            (uses the same NRVL_DATA_DIR / NRVL_PORT as the hub)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { DeviceInfo, HubMsg } from '@nrvl/shared';
import { loadConfig } from '../src/config.ts';
import { createPairingCode, openDb } from '../src/db.ts';

const config = loadConfig();
const ca = readFileSync(join(config.dataDir, 'tls/ca.crt'));
const db = openDb(config.dataDir);
const { code } = createPairingCode(db, 'controller');
db.close();

const creds = await new Promise<{ deviceId: string; token: string }>((resolve, reject) => {
  const req = request({ host: config.host, port: config.port, path: '/api/pair', method: 'POST', ca }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(data))));
  });
  req.on('error', reject);
  req.end(JSON.stringify({ code, name: 'e2e-controller', os: 'other' }));
});

type Outcome = { ok: boolean; error?: string };
const ws = new WebSocket(`wss://${config.host}:${config.port}/ws`, { ca });
let devices: DeviceInfo[] = [];
const results = new Map<string, (r: Outcome) => void>();
const progress: string[] = [];
ws.on('message', (d) => {
  const m = JSON.parse(d.toString()) as HubMsg;
  if (m.t === 'state') devices = m.devices;
  if (m.t === 'macro.progress' && m.status !== 'running') progress.push(`${m.index}:${m.status}`);
  if (m.t === 'result') results.get(m.id)?.({ ok: m.ok, ...(m.error && { error: m.error }) });
});
await new Promise((r) => ws.once('open', r));
ws.send(JSON.stringify({ t: 'hello', v: 1, deviceId: creds.deviceId, token: creds.token }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent = () => devices.find((d) => d.role === 'agent' && d.online && d.os === 'macos');
const status = () => agent()!.status!;
async function waitFor(what: string, cond: () => boolean) {
  for (let i = 0; i < 50 && !cond(); i++) await sleep(200);
  assert.ok(cond(), `timed out waiting for ${what}`);
}
let n = 0;
const ask = (msg: object) => new Promise<Outcome>((resolve) => {
  const id = `e2e-${n++}`;
  results.set(id, resolve);
  ws.send(JSON.stringify({ ...msg, id }));
});
const exec = (type: string, params: object = {}) => ask({ t: 'execute', target: agent()!.id, action: { type, params } });
const step = (type: string, params: object = {}, over: object = {}) =>
  ({ kind: 'action', target: agent()!.id, action: { type, params }, onError: 'stop', ifOffline: 'fail', ...over });
const near = (a: number | null | undefined, b: number) => Math.abs((a ?? -99) - b) <= 4;

try {
  await waitFor('an online macOS agent', () => !!agent()?.capabilities.length);
  console.log(`agent online: ${agent()!.name} | ${agent()!.capabilities.length} actions | ${status().apps?.length ?? 0} running apps | scripts: ${JSON.stringify(status().scripts ?? [])}`);
  const original = status().volume;
  assert.equal(typeof original, 'number', 'agent must report a volume (output device without software volume?)');
  const other = original! >= 50 ? original! - 12 : original! + 12;

  assert.deepEqual(await exec('volume.set', { level: other }), { ok: true });
  await waitFor('status to follow volume.set', () => near(status().volume, other));
  console.log(`volume.set ${original} -> ${other}: ok, agent reports ${status().volume}`);

  // Macro: set volume back, wait, then a step that fails but is allowed to (continue), then one more step.
  progress.length = 0;
  const started = Date.now();
  const macro = await ask({ t: 'macro.run', steps: [
    step('volume.set', { level: original }), { kind: 'delay', ms: 400 },
    step('app.launch', { app: 'No Such App 4f9c2' }, { onError: 'continue' }), step('volume.set', { level: original }),
  ] });
  assert.deepEqual(progress, ['0:ok', '1:ok', '2:failed', '3:ok']);
  assert.deepEqual(macro, { ok: false, error: '1 step failed' });
  assert.ok(Date.now() - started >= 400);
  await waitFor('volume to be restored by the macro', () => near(status().volume, original!));
  console.log(`macro: 4 steps in order with a delay, failure reported honestly; volume restored to ${status().volume}`);

  // Microphone: definite states, then back to how it was.
  const micWas = status().micMuted;
  if (typeof micWas === 'boolean') {
    assert.deepEqual(await exec('mic.mute', { state: 'on' }), { ok: true });
    await waitFor('mic to report muted', () => status().micMuted === true);
    assert.deepEqual(await exec('mic.mute', { state: micWas ? 'on' : 'off' }), { ok: true });
    await waitFor('mic to be restored', () => status().micMuted === micWas);
    console.log(`mic.mute on -> state seen on controller -> restored (${micWas ? 'muted' : 'unmuted'})`);
  } else console.log('mic.mute skipped: no input device with volume control');

  assert.ok(status().apps?.includes('Finder'), 'running apps should include Finder');
  console.log('live state: running apps reported (Finder present)');

  if (status().scripts?.length) {
    assert.deepEqual(await exec('script.run', { name: status().scripts![0] }), { ok: true });
    console.log(`script.run “${status().scripts![0]}”: ok`);
  }
  const bad = await exec('script.run', { name: 'not allow-listed' });
  assert.equal(bad.ok, false);
  console.log('script.run of a name that is not allow-listed correctly failed:', bad.error);
  console.log('E2E PASSED');
} finally {
  ws.send(JSON.stringify({ t: 'device.remove', id: creds.deviceId }));
  await sleep(300);
  ws.close();
}
