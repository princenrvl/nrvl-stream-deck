// Manual latency check against a running hub + macOS agent: 30 round trips of a harmless action.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { HubMsg } from '@nrvl/shared';
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
  req.end(JSON.stringify({ code, name: 'perf', os: 'other' }));
});
const ws = new WebSocket(`wss://${config.host}:${config.port}/ws`, { ca });
let agent = '';
let volume = 50;
const waiting = new Map<string, () => void>();
ws.on('message', (d) => {
  const m = JSON.parse(d.toString()) as HubMsg;
  if (m.t === 'state') {
    const a = m.devices.find((x) => x.role === 'agent' && x.online);
    if (a) (agent = a.id), (volume = a.status?.volume ?? volume);
  }
  if (m.t === 'result') waiting.get(m.id)?.();
});
await new Promise((r) => ws.once('open', r));
ws.send(JSON.stringify({ t: 'hello', v: 1, deviceId: creds.deviceId, token: creds.token }));
for (let i = 0; i < 50 && !agent; i++) await new Promise((r) => setTimeout(r, 100));
if (!agent) throw new Error('no online agent');
const times: number[] = [];
for (let i = 0; i < 30; i++) {
  const start = performance.now();
  await new Promise<void>((resolve) => {
    waiting.set(`p${i}`, resolve);
    ws.send(JSON.stringify({ t: 'execute', id: `p${i}`, target: agent, action: { type: 'volume.set', params: { level: Math.round(volume) } } }));
  });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(`button press -> hub -> agent -> action -> result, 30 runs: median ${times[15]!.toFixed(0)} ms, slowest ${times[29]!.toFixed(0)} ms`);
ws.send(JSON.stringify({ t: 'device.remove', id: creds.deviceId }));
setTimeout(() => ws.close(), 200);
