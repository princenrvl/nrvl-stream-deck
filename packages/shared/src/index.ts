// Shared API contract: action registry, profile document, wire protocol.
// Used by the hub (validation) and the web controller (types + editor forms).
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const PROFILE_SCHEMA_VERSION = 1;

export type Platform = 'macos' | 'windows';
const BOTH: Platform[] = ['macos', 'windows'];
const NONE: Platform[] = []; // handled by the controller or the hub, never sent to a computer as-is

// ---------- keyboard ----------
export const MODIFIERS = ['cmd', 'ctrl', 'alt', 'shift'] as const; // cmd = Windows key on Windows
export type Modifier = (typeof MODIFIERS)[number];
export const KEYS: readonly string[] = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ...['space', 'enter', 'tab', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right'],
  ...['home', 'end', 'pageup', 'pagedown', 'minus', 'equal', 'comma', 'period', 'slash'],
  ...['semicolon', 'quote', 'leftbracket', 'rightbracket', 'backslash', 'grave'],
];

/** "cmd+shift+4" -> { modifiers: ['cmd','shift'], key: '4' }, or null if not a valid shortcut. */
export function parseShortcut(text: string): { modifiers: Modifier[]; key: string } | null {
  const parts = text.toLowerCase().split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const modifiers = [...new Set(parts)] as Modifier[];
  if (!KEYS.includes(key) || modifiers.some((m) => !MODIFIERS.includes(m))) return null;
  return { modifiers, key };
}

// ---------- actions ----------
const id = z.string().min(1).max(64);
const noParams = z.strictObject({});
// Mute actions toggle by default; macros can ask for a definite state so they are repeatable.
const muteParams = z.strictObject({ state: z.enum(['toggle', 'on', 'off']).optional() });
const httpUrl = z.string().max(2000).refine((u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}, 'Must be an http(s) URL');

function def<T extends z.ZodType>(name: string, description: string, params: T, platforms: Platform[] = BOTH, sensitive = false) {
  return { name, description, platforms, params, sensitive };
}

/**
 * The action registry. Agents implement handlers keyed by these IDs and report which they support.
 * `sensitive` actions ask for confirmation before running on several computers at once.
 */
export const ACTIONS = {
  'app.launch': def('Launch or switch to app', 'Open an application, or bring it to the front if it is already running.',
    // Leading "-" is rejected so the value can never be read as a command-line flag by an agent.
    z.strictObject({ app: z.string().min(1).max(200).regex(/^[^-\p{Cc}][^\p{Cc}]*$/u, 'Invalid app name') })),
  'url.open': def('Open website', 'Open an http(s) URL in the default browser.', z.strictObject({ url: httpUrl })),
  'keyboard.shortcut': def('Keyboard shortcut', 'Press a key combination, e.g. cmd+shift+4.',
    z.strictObject({
      modifiers: z.array(z.enum(MODIFIERS)).max(4),
      key: z.string().refine((k) => KEYS.includes(k), 'Unknown key'),
    })),
  'text.type': def('Type text', 'Type a piece of text into the app that has focus.',
    z.strictObject({ text: z.string().min(1).max(500).regex(/^(?:[^\p{Cc}]|[\n\t])+$/u, 'Text contains unsupported characters') })),
  'mouse.click': def('Mouse click', 'Click at the current pointer position.', z.strictObject({ button: z.enum(['left', 'right']) })),
  'volume.set': def('Set volume', 'Set output volume to a fixed level.', z.strictObject({ level: z.number().int().min(0).max(100) })),
  'volume.up': def('Volume up', 'Raise output volume one step.', noParams),
  'volume.down': def('Volume down', 'Lower output volume one step.', noParams),
  'volume.mute': def('Mute / unmute sound', 'Mute, unmute or toggle the speakers.', muteParams),
  'mic.mute': def('Mute / unmute microphone', 'Mute, unmute or toggle the microphone.', muteParams),
  'media.playpause': def('Play / pause', 'Toggle media playback.', noParams),
  'media.next': def('Next track', 'Skip to the next track.', noParams),
  'media.previous': def('Previous track', 'Go to the previous track.', noParams),
  'brightness.up': def('Brightness up', 'Raise the built-in display brightness one step.', noParams, ['macos']),
  'brightness.down': def('Brightness down', 'Lower the built-in display brightness one step.', noParams, ['macos']),
  'system.lock': def('Lock computer', 'Lock the screen.', noParams, BOTH, true),
  'system.sleep': def('Sleep computer', 'Put the computer to sleep.', noParams, BOTH, true),
  'script.run': def('Run script', 'Run a script that has been allow-listed on that computer (see README).',
    z.strictObject({ name: z.string().min(1).max(60).regex(/^[\w .-]+$/, 'Invalid script name') }), BOTH, true),
  'page.open': def('Open folder', 'Show another page of buttons, with a back button.', z.strictObject({ pageId: id }), NONE),
  'profile.switch': def('Switch profile', 'Show a different profile on this controller.', z.strictObject({ profileId: id }), NONE),
  // Steps are validated by MacroStepSchema (see ActionSchema); declared loosely here to avoid a circular definition.
  'macro.run': def('Macro', 'Run several actions in order, with optional delays.', z.strictObject({ steps: z.array(z.unknown()).min(1).max(50) }), NONE),
} as const;

export type ActionType = keyof typeof ACTIONS;
export const ACTION_TYPES = Object.keys(ACTIONS) as ActionType[];
export type Action = { type: ActionType; params: Record<string, unknown> };
/** True for actions that are not aimed at one computer: navigation (done by the controller) and macros (run by the hub). */
export const isClientAction = (type: ActionType) => ACTIONS[type].platforms.length === 0;

export const ActionSchema = z
  .strictObject({ type: z.enum(ACTION_TYPES as [ActionType, ...ActionType[]]), params: z.record(z.string(), z.unknown()) })
  .superRefine((a, ctx) => {
    const r = ACTIONS[a.type].params.safeParse(a.params);
    if (!r.success) return void ctx.addIssue({ code: 'custom', path: ['params'], message: r.error.issues[0]?.message ?? 'Invalid parameters' });
    const stepError = a.type === 'macro.run' ? macroStepsError(a.params.steps) : null;
    if (stepError) ctx.addIssue({ code: 'custom', path: ['params', 'steps'], message: stepError });
  });

// A function with an explicit return type, so ActionSchema and MacroStepSchema can refer to each other.
function macroStepsError(steps: unknown): string | null {
  const r = MacroStepsSchema.safeParse(steps);
  if (r.success) return null;
  const issue = r.error.issues[0];
  return `Step ${Number(issue?.path[0] ?? 0) + 1}: ${issue?.message ?? 'invalid'}`;
}

// ---------- macros ----------
export type MacroStep =
  | { kind: 'delay'; ms: number }
  | { kind: 'action'; target?: string; action: Action; onError: 'stop' | 'continue'; ifOffline: 'fail' | 'skip' };

export const MacroStepSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('delay'), ms: z.number().int().min(0).max(60_000) }),
    z.strictObject({
      kind: z.literal('action'),
      target: id.optional(),
      action: ActionSchema,
      onError: z.enum(['stop', 'continue']), // what a failed step does to the rest of the macro
      ifOffline: z.enum(['fail', 'skip']), // condition: skip this step when its computer is not connected
    }),
  ])
  .superRefine((s, ctx) => {
    if (s.kind !== 'action') return;
    if (s.action.type === 'macro.run') ctx.addIssue({ code: 'custom', message: 'A macro cannot contain another macro' });
    else if (!s.target && !isClientAction(s.action.type)) ctx.addIssue({ code: 'custom', message: 'Choose a computer' });
  });
export const MacroStepsSchema = z.array(MacroStepSchema).min(1).max(50);

// ---------- profile document (also the export/import format) ----------
export const ButtonSchema = z
  .strictObject({
    id,
    label: z.string().max(40),
    icon: z.string().max(16).optional(), // emoji
    // Small custom icon, resized by the controller before upload. Takes precedence over `icon`.
    image: z.string().max(64_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    target: id.optional(), // device ID of the agent this button controls; absent for client actions
    targets: z.array(id).max(10).optional(), // further computers the same action also runs on
    action: ActionSchema,
  })
  .superRefine((b, ctx) => {
    if (!b.target && !isClientAction(b.action.type)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'Choose a computer' });
  });
export type Button = z.infer<typeof ButtonSchema> & { action: Action };

export const PageSchema = z.strictObject({
  id,
  name: z.string().min(1).max(40),
  folder: z.boolean().optional(), // folder pages are reached through a page.open button, not the page tabs
  buttons: z.record(z.string().regex(/^\d{1,3}$/), ButtonSchema), // key = grid cell index, row-major
});

export const ProfileSchema = z.strictObject({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  id,
  name: z.string().min(1).max(40),
  grid: z.strictObject({ cols: z.number().int().min(1).max(10), rows: z.number().int().min(1).max(10) }),
  pages: z.array(PageSchema).min(1).max(50),
});
export type Page = { id: string; name: string; folder?: boolean; buttons: Record<string, Button> };
export type Profile = Omit<z.infer<typeof ProfileSchema>, 'pages'> & { pages: Page[] };

/** File format written by "Export profile" and read by "Import profile". */
export const ProfileFileSchema = z.strictObject({ format: z.literal('nrvl-stream-deck-profile'), version: z.literal(1), profile: ProfileSchema });

export const GRID_PRESETS = [[3, 3], [4, 3], [4, 4], [5, 5], [6, 4]] as const; // [cols, rows]

/** Lowest empty cell index, or -1 when the page is full. */
export function firstFreeCell(buttons: Record<string, unknown>, cells: number): number {
  for (let i = 0; i < cells; i++) if (!(i in buttons)) return i;
  return -1;
}

/**
 * Changes a profile's grid size. Buttons keep their row and column where that still exists; the rest move to
 * the first free cells. Returns null if any page has more buttons than the new grid can hold.
 */
export function regrid(profile: Profile, cols: number, rows: number): Profile | null {
  const pages: Page[] = [];
  for (const page of profile.pages) {
    const buttons: Record<string, Button> = {};
    const overflow: Button[] = [];
    for (const [key, b] of Object.entries(page.buttons)) {
      const row = Math.floor(Number(key) / profile.grid.cols);
      const col = Number(key) % profile.grid.cols;
      if (row < rows && col < cols) buttons[row * cols + col] = b;
      else overflow.push(b);
    }
    for (const b of overflow) {
      const free = firstFreeCell(buttons, cols * rows);
      if (free < 0) return null;
      buttons[free] = b;
    }
    pages.push({ ...page, buttons });
  }
  return { ...profile, grid: { cols, rows }, pages };
}

/** Drops folder pages that no button leads to any more (e.g. after their folder button was deleted). */
export function prunePages(profile: Profile): Profile {
  const byId = new Map(profile.pages.map((p) => [p.id, p]));
  const keep = new Set<string>();
  const visit = (page: Page) => {
    if (keep.has(page.id)) return;
    keep.add(page.id);
    for (const b of Object.values(page.buttons)) {
      const next = b.action.type === 'page.open' ? byId.get(String(b.action.params.pageId)) : undefined;
      if (next) visit(next);
    }
  };
  profile.pages.filter((p) => !p.folder).forEach(visit);
  return { ...profile, pages: profile.pages.filter((p) => keep.has(p.id)) };
}

/**
 * Points every button and macro step whose computer is not in `known` at `fallback` (used when importing a
 * profile made on another hub). Returns the new profile and how many references were changed.
 */
export function retarget(profile: Profile, known: Set<string>, fallback: string): { profile: Profile; changed: number } {
  let changed = 0;
  const fix = (t: string | undefined) => (t && !known.has(t) ? (changed++, fallback) : t);
  const fixAction = (a: Action): Action =>
    a.type !== 'macro.run' ? a : {
      ...a,
      params: { steps: (a.params.steps as MacroStep[]).map((s) => (s.kind === 'action' && s.target ? { ...s, target: fix(s.target) } : s)) },
    };
  const pages = profile.pages.map((page) => ({
    ...page,
    buttons: Object.fromEntries(Object.entries(page.buttons).map(([k, b]) => {
      const targets = b.targets?.filter((t) => known.has(t));
      return [k, { ...b, ...(b.target && { target: fix(b.target) }), ...(b.targets && { targets }), action: fixAction(b.action) }];
    })),
  }));
  return { profile: { ...profile, pages }, changed };
}

// ---------- wire protocol (JSON over WebSocket, plus POST /api/pair) ----------
export const RoleSchema = z.enum(['controller', 'agent']);
export type Role = z.infer<typeof RoleSchema>;

export const PairRequestSchema = z.strictObject({
  code: z.string().min(4).max(32),
  name: z.string().trim().min(1).max(60),
  os: z.enum(['macos', 'windows', 'ios', 'other']),
});
export type PairResponse = { deviceId: string; token: string; role: Role };

export const HelloSchema = z.strictObject({
  t: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  deviceId: id,
  token: z.string().min(20).max(200),
});

const ping = z.strictObject({ t: z.literal('ping') });

export const ControllerMsgSchema = z.discriminatedUnion('t', [
  ping,
  z.strictObject({ t: z.literal('execute'), id, target: id, action: ActionSchema }),
  z.strictObject({ t: z.literal('macro.run'), id, steps: MacroStepsSchema }),
  z.strictObject({ t: z.literal('macro.cancel'), id }),
  z.strictObject({ t: z.literal('profile.put'), profile: ProfileSchema }),
  z.strictObject({ t: z.literal('profile.delete'), id }),
  z.strictObject({ t: z.literal('device.remove'), id }),
  z.strictObject({ t: z.literal('pairing.create'), role: RoleSchema }),
]);

export const AgentStatusSchema = z.strictObject({
  volume: z.number().min(0).max(100).nullable(),
  muted: z.boolean().nullable(),
  micMuted: z.boolean().nullable().optional(),
  apps: z.array(z.string().max(200)).max(300).optional(), // names of running apps, for "is it running" button state
  scripts: z.array(z.string().max(60)).max(50).optional(), // names allow-listed on that computer for script.run
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentMsgSchema = z.discriminatedUnion('t', [
  ping,
  z.strictObject({ t: z.literal('result'), id, ok: z.boolean(), error: z.string().max(500).optional() }),
  z.strictObject({ t: z.literal('status'), capabilities: z.array(z.string().max(64)).max(100), status: AgentStatusSchema }),
]);

export type DeviceInfo = {
  id: string;
  name: string;
  role: Role;
  os: string;
  online: boolean;
  lastSeen: number;
  capabilities: string[];
  status: AgentStatus | null;
};

export type StepStatus = 'running' | 'ok' | 'failed' | 'skipped';

/** Messages the hub sends. `execute` goes to agents; the rest go to controllers (welcome/error/pong to both). */
export type HubMsg =
  | { t: 'welcome'; deviceId: string; newToken?: string }
  | { t: 'state'; devices: DeviceInfo[]; profiles?: Profile[] } // profiles only when they changed (they can be large)
  | { t: 'result'; id: string; ok: boolean; error?: string }
  // One per macro step change. `action` is set for steps the controller itself must perform (navigation).
  | { t: 'macro.progress'; id: string; index: number; total: number; status: StepStatus; error?: string; action?: Action }
  | { t: 'pairing'; role: Role; code: string; expiresAt: number; text: string; qr?: string }
  | { t: 'execute'; id: string; ts: number; action: Action }
  | { t: 'error'; error: string }
  | { t: 'pong' };
