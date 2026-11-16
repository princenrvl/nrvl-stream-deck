import QRCode from 'qrcode';
import { hubUrl, loadConfig, log } from './config.ts';
import { createPairingCode, listDevices } from './db.ts';
import { controllerPairingUrl, startHub } from './hub.ts';

const config = loadConfig();
const hub = await startHub(config);
log('info', 'hub.started', { url: hubUrl(config), httpPort: hub.httpPort, dataDir: config.dataDir });

console.log(`\nNRVL Stream Deck hub is running.\n  App:    ${hubUrl(config)}\n  Setup:  http://${config.host}:${hub.httpPort}  (install the certificate on a new iPad first)\n`);
if (!listDevices(hub.db).some((d) => d.role === 'controller')) {
  const { code } = createPairingCode(hub.db, 'controller');
  const url = controllerPairingUrl(config, code);
  console.log(`No iPad paired yet. After installing the certificate, scan this (valid 10 minutes):\n`);
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`  ${url}\n  Pairing code: ${code}\n`);
}

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log('info', 'hub.stopping', { signal });
  await hub.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
