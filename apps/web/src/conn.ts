// Connection to the hub: pairing, authenticated WebSocket, heartbeat and automatic reconnect.
import { useSyncExternalStore } from 'react';
import { PROTOCOL_VERSION, type Action, type DeviceInfo, type HubMsg, type MacroStep, type PairResponse, type Profile } from '@nrvl/shared';

type Pairing = Extract<HubMsg, { t: 'pairing' }>;
export type MacroProgress = Extract<HubMsg, { t: 'macro.progress' }>;
export type State = {
  link: 'unpaired' | 'connecting' | 'online';
  devices: DeviceInfo[];
  profiles: Profile[];
  pairing: Pairing | null;
};
export type Result = { ok: boolean; error?: string };

const CREDS_KEY = 'nrvl.creds';
type Creds = { deviceId: string; token: string };
const loadCreds = (): Creds | null => {
  try {
    return JSON.parse(localStorage.getItem(CREDS_KEY) ?? 'null');
  } catch {
    return null;
  }
};

let creds = loadCreds();
let state: State = { link: creds ? 'connecting' : 'unpaired', devices: [], profiles: [], pairing: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const useHub = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
export const myDeviceId = () => creds?.deviceId;

let ws: WebSocket | null = null;
let retry = 0;
let retryTimer: number | undefined;
let lastRx = 0;
const waiting = new Map<string, (r: Result) => void>();
const macroListeners = new Map<string, (p: MacroProgress) => void>();

function failAll(error: string) {
  for (const done of waiting.values()) done({ ok: false, error });
  waiting.clear();
}

function connect() {
  clearTimeout(retryTimer);
  if (!creds || (ws && ws.readyState <= WebSocket.OPEN)) return;
  const sock = (ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  sock.onopen = () => sock.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, ...creds }));
  sock.onmessage = (ev) => {
    lastRx = Date.now();
    const msg = JSON.parse(ev.data as string) as HubMsg;
    switch (msg.t) {
      case 'welcome':
        retry = 0;
        if (msg.newToken && creds) localStorage.setItem(CREDS_KEY, JSON.stringify((creds = { ...creds, token: msg.newToken })));
        return set({ link: 'online' });
      case 'state':
        return set({ devices: msg.devices, ...(msg.profiles && { profiles: msg.profiles }) });
      case 'result':
        waiting.get(msg.id)?.(msg);
        return void waiting.delete(msg.id);
      case 'macro.progress':
        return void macroListeners.get(msg.id)?.(msg);
      case 'pairing':
        return set({ pairing: msg });
      case 'error':
        if (msg.error === 'unauthorized') unpair();
        return;
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    failAll('Connection lost');
    if (!creds) return;
    set({ link: 'connecting' });
    retryTimer = window.setTimeout(connect, Math.min(500 * 2 ** retry++, 5000));
  };
}

function unpair() {
  localStorage.removeItem(CREDS_KEY);
  creds = null;
  ws?.close();
  set({ link: 'unpaired', devices: [], profiles: [], pairing: null });
}

// Heartbeat: iOS can leave a dead socket "open" after a Wi-Fi drop, so silence for 12s forces a reconnect.
setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastRx > 12_000) return ws.close();
  ws.send('{"t":"ping"}');
}, 5000);
// Returning to the app (or to Wi-Fi) reconnects immediately instead of waiting out the backoff.
const wake = () => {
  if (document.visibilityState !== 'visible') return;
  retry = 0;
  connect();
};
document.addEventListener('visibilitychange', wake);
window.addEventListener('online', wake);
connect();

function sendMsg(msg: object): boolean {
  if (ws?.readyState !== WebSocket.OPEN || state.link !== 'online') return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export async function pair(code: string, name: string): Promise<string | null> {
  try {
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, os: 'ios' }) });
    const body = (await res.json()) as PairResponse & { error?: string };
    if (!res.ok) return body.error ?? 'Pairing failed';
    localStorage.setItem(CREDS_KEY, JSON.stringify((creds = { deviceId: body.deviceId, token: body.token })));
    set({ link: 'connecting' });
    connect();
    return null;
  } catch {
    return 'Cannot reach the hub';
  }
}

/** Sends a message that the hub answers with a `result` carrying the same id. */
function request(build: (id: string) => object, timeoutMs?: number, onProgress?: (p: MacroProgress) => void) {
  const id = crypto.randomUUID();
  const done = new Promise<Result>((resolve) => {
    if (!sendMsg(build(id))) return resolve({ ok: false, error: 'Not connected to the hub' });
    if (onProgress) macroListeners.set(id, onProgress);
    const timer = timeoutMs ? setTimeout(() => waiting.get(id)?.({ ok: false, error: 'No response from the hub' }), timeoutMs) : undefined;
    waiting.set(id, (r) => {
      clearTimeout(timer);
      waiting.delete(id);
      macroListeners.delete(id);
      resolve(r);
    });
  });
  return { id, done };
}

export const execute = (target: string, action: Action) => request((id) => ({ t: 'execute', id, target, action }), 15_000).done;
/** Macros run on the hub and can take minutes, so there is no client timeout: the hub always sends a final result. */
export const runMacro = (steps: MacroStep[], onProgress: (p: MacroProgress) => void) => request((id) => ({ t: 'macro.run', id, steps }), undefined, onProgress);
export const cancelMacro = (id: string) => sendMsg({ t: 'macro.cancel', id });

export const saveProfile = (profile: Profile) => sendMsg({ t: 'profile.put', profile });
export const deleteProfile = (id: string) => sendMsg({ t: 'profile.delete', id });
export const removeDevice = (id: string) => sendMsg({ t: 'device.remove', id });
export const createPairing = (role: 'controller' | 'agent') => sendMsg({ t: 'pairing.create', role });
export const clearPairing = () => set({ pairing: null });
