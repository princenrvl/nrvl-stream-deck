// Ready-made profiles. Each is built for one computer, with shortcuts that fit its operating system.
import { ACTIONS, parseShortcut, ProfileSchema, type ActionType, type Button, type DeviceInfo, type MacroStep, type Platform, type Profile } from '@nrvl/shared';

type Spec = [label: string, icon: string, type: ActionType, params?: Record<string, unknown>];

const keys = (label: string, icon: string, combo: string): Spec => [label, icon, 'keyboard.shortcut', parseShortcut(combo)!];
const app = (label: string, icon: string, mac: string, windows: string, os: string): Spec => [label, icon, 'app.launch', { app: os === 'windows' ? windows : mac }];

const volume: Spec[] = [['Vol −', '🔉', 'volume.down'], ['Mute', '🔇', 'volume.mute'], ['Vol +', '🔊', 'volume.up']];
const media: Spec[] = [['Previous', '⏮️', 'media.previous'], ['Play / Pause', '⏯️', 'media.playpause'], ['Next', '⏭️', 'media.next']];

export const TEMPLATES: { name: string; build: (os: string, mod: string) => Spec[]; macro?: (os: string) => { label: string; icon: string; steps: Spec[] } }[] = [
  {
    name: 'General Productivity',
    build: (os, mod) => [
      keys('Copy', '📋', `${mod}+c`), keys('Paste', '📥', `${mod}+v`), keys('Cut', '✂️', `${mod}+x`), keys('Undo', '↩️', `${mod}+z`),
      keys('Redo', '↪️', os === 'windows' ? 'ctrl+y' : 'cmd+shift+z'), keys('Select all', '🔲', `${mod}+a`), keys('Save', '💾', `${mod}+s`), keys('Find', '🔍', `${mod}+f`),
      keys('Screenshot', '📸', os === 'windows' ? 'cmd+shift+s' : 'cmd+shift+4'), ...volume,
    ],
  },
  {
    name: 'Development',
    build: (os, mod) => [
      app('VS Code', '🧩', 'Visual Studio Code', 'Visual Studio Code', os), app('Terminal', '⌨️', 'Terminal', 'wt', os),
      keys('Save', '💾', `${mod}+s`), keys('Commands', '🎛️', `${mod}+shift+p`),
      keys('Find in files', '🔎', `${mod}+shift+f`), keys('Go to file', '📄', `${mod}+p`), keys('Comment', '💬', `${mod}+slash`), keys('Terminal panel', '🖥️', 'ctrl+grave'),
      ['GitHub', '🐙', 'url.open', { url: 'https://github.com' }],
    ],
    macro: (os) => ({
      label: 'Work mode', icon: '🚀',
      steps: [app('', '', 'Visual Studio Code', 'Visual Studio Code', os), app('', '', 'Google Chrome', 'chrome', os), ['', '', 'volume.set', { level: 35 }], ['', '', 'url.open', { url: 'https://github.com' }]],
    }),
  },
  {
    name: 'Meetings',
    build: (os) => [
      app('Zoom', '🎥', 'zoom.us', 'Zoom', os), ['Mic', '🎙️', 'mic.mute'], ['Mute sound', '🔇', 'volume.mute'], ['Volume 50%', '🎚️', 'volume.set', { level: 50 }],
      app('Notes', '📝', 'Notes', 'notepad', os), ...volume.filter((v) => v[2] !== 'volume.mute'),
    ],
    macro: (os) => ({
      label: 'Meeting mode', icon: '🤝',
      steps: [app('', '', 'zoom.us', 'Zoom', os), ['', '', 'volume.set', { level: 50 }], ['', '', 'mic.mute', { state: 'on' }], app('', '', 'Notes', 'notepad', os)],
    }),
  },
  { name: 'Media Control', build: () => [...volume, ['Volume 35%', '🎚️', 'volume.set', { level: 35 }], ...media, ['Mic', '🎙️', 'mic.mute']] },
  {
    name: 'Browser Control',
    build: (os, mod) => [
      keys('New tab', '➕', `${mod}+t`), keys('Close tab', '✖️', `${mod}+w`), keys('Reopen tab', '♻️', `${mod}+shift+t`), keys('Reload', '🔄', `${mod}+r`),
      keys('Back', '⬅️', os === 'windows' ? 'alt+left' : 'cmd+leftbracket'), keys('Forward', '➡️', os === 'windows' ? 'alt+right' : 'cmd+rightbracket'),
      keys('Address bar', '🔗', `${mod}+l`), keys('Find', '🔍', `${mod}+f`), keys('Next tab', '⏩', 'ctrl+tab'), keys('Previous tab', '⏪', 'ctrl+shift+tab'),
    ],
  },
  {
    name: 'System Control',
    build: () => [
      ['Lock', '🔒', 'system.lock'], ['Sleep', '🌙', 'system.sleep'], ['Mute sound', '🔇', 'volume.mute'], ['Mic', '🎙️', 'mic.mute'],
      ['Brightness −', '🔅', 'brightness.down'], ['Brightness +', '🔆', 'brightness.up'], ['Vol −', '🔉', 'volume.down'], ['Vol +', '🔊', 'volume.up'],
    ],
  },
];

/** Builds template `index` for `agent`; actions that computer's OS cannot do are left out. */
export function buildTemplate(index: number, agent: DeviceInfo): Profile {
  const template = TEMPLATES[index]!;
  const supported = (type: ActionType) => (ACTIONS[type].platforms as readonly Platform[]).includes(agent.os as Platform);
  const button = ([label, icon, type, params = {}]: Spec): Button =>
    ({ id: crypto.randomUUID(), label, icon, target: agent.id, action: { type, params } });
  const buttons = template.build(agent.os, agent.os === 'windows' ? 'ctrl' : 'cmd').filter((s) => supported(s[2])).map(button);
  const macro = template.macro?.(agent.os);
  if (macro) {
    const steps: MacroStep[] = macro.steps.map(([, , type, params = {}]) => ({ kind: 'action', target: agent.id, action: { type, params }, onError: 'continue', ifOffline: 'fail' }));
    buttons.unshift({ id: crypto.randomUUID(), label: macro.label, icon: macro.icon, color: '#1f4fd8', action: { type: 'macro.run', params: { steps } } });
  }
  const cols = 4;
  return ProfileSchema.parse({
    schemaVersion: 1, id: crypto.randomUUID(), name: template.name, grid: { cols, rows: Math.max(3, Math.ceil(buttons.length / cols)) },
    pages: [{ id: crypto.randomUUID(), name: 'Main', buttons: Object.fromEntries(buttons.map((b, i) => [String(i), b])) }],
  }) as Profile;
}
