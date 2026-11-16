import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionSchema, ButtonSchema, ControllerMsgSchema, firstFreeCell, parseShortcut, ProfileSchema, prunePages, regrid, type Profile } from '../src/index.ts';

const ok = (a: unknown) => ActionSchema.safeParse(a).success;

test('actions: valid ones pass', () => {
  assert.ok(ok({ type: 'volume.set', params: { level: 35 } }));
  assert.ok(ok({ type: 'app.launch', params: { app: 'Visual Studio Code' } }));
  assert.ok(ok({ type: 'url.open', params: { url: 'https://example.com/a?b=1' } }));
  assert.ok(ok({ type: 'keyboard.shortcut', params: { modifiers: ['cmd', 'shift'], key: '4' } }));
  assert.ok(ok({ type: 'media.playpause', params: {} }));
});

test('actions: hostile or malformed ones are rejected', () => {
  assert.ok(!ok({ type: 'shell.exec', params: { cmd: 'rm -rf /' } }), 'unknown type');
  assert.ok(!ok({ type: 'url.open', params: { url: 'file:///etc/passwd' } }), 'non-http scheme');
  assert.ok(!ok({ type: 'url.open', params: { url: 'javascript:alert(1)' } }));
  assert.ok(!ok({ type: 'app.launch', params: { app: '--args' } }), 'flag injection');
  assert.ok(!ok({ type: 'app.launch', params: { app: 'a\nb' } }), 'control chars');
  assert.ok(!ok({ type: 'volume.set', params: { level: 101 } }));
  assert.ok(!ok({ type: 'volume.set', params: { level: 10, extra: 1 } }), 'unknown params');
  assert.ok(!ok({ type: 'keyboard.shortcut', params: { modifiers: ['hyper'], key: 'a' } }));
  assert.ok(!ok({ type: 'media.next', params: {}, extra: true }), 'unknown top-level field');
});

test('parseShortcut', () => {
  assert.deepEqual(parseShortcut('Cmd + Shift + 4'), { modifiers: ['cmd', 'shift'], key: '4' });
  assert.deepEqual(parseShortcut('f5'), { modifiers: [], key: 'f5' });
  assert.equal(parseShortcut('cmd+'), null);
  assert.equal(parseShortcut('hyper+a'), null);
});

test('profile and controller message schemas', () => {
  const profile = {
    schemaVersion: 1, id: 'p1', name: 'Test', grid: { cols: 4, rows: 3 },
    pages: [{ id: 'pg', name: 'Main', buttons: { '0': { id: 'b', label: 'Mute', target: 'd1', action: { type: 'volume.mute', params: {} } } } }],
  };
  assert.ok(ProfileSchema.safeParse(profile).success);
  assert.ok(!ProfileSchema.safeParse({ ...profile, schemaVersion: 2 }).success);
  assert.ok(!ProfileSchema.safeParse({ ...profile, grid: { cols: 99, rows: 3 } }).success);
  assert.ok(ControllerMsgSchema.safeParse({ t: 'profile.put', profile }).success);
  assert.ok(!ControllerMsgSchema.safeParse({ t: 'execute', id: 'x', target: 'd1', action: { type: 'nope', params: {} } }).success);
});

const btn = (id: string, action: unknown = { type: 'volume.mute', params: {} }) => ({ id, label: id, target: 'd1', action });
const folderBtn = (id: string, pageId: string) => ({ id, label: id, action: { type: 'page.open', params: { pageId } } });

test('buttons: computer actions need a target, folder buttons do not; images are constrained', () => {
  assert.ok(ButtonSchema.safeParse(btn('a')).success);
  assert.ok(!ButtonSchema.safeParse({ ...btn('a'), target: undefined }).success, 'missing target');
  assert.ok(ButtonSchema.safeParse(folderBtn('f', 'pg2')).success);
  assert.ok(ButtonSchema.safeParse({ ...btn('a'), image: 'data:image/png;base64,iVBORw0KGgo=' }).success);
  assert.ok(!ButtonSchema.safeParse({ ...btn('a'), image: 'data:image/svg+xml;base64,PHN2Zz4=' }).success, 'svg can carry script');
  assert.ok(!ButtonSchema.safeParse({ ...btn('a'), image: 'https://example.com/x.png' }).success, 'no remote images');
  assert.ok(!ButtonSchema.safeParse({ ...btn('a'), image: 'data:image/png;base64,' + 'A'.repeat(70_000) }).success, 'too large');
});

test('regrid keeps positions, relocates overflow, refuses when it cannot fit', () => {
  const profile = ProfileSchema.parse({
    schemaVersion: 1, id: 'p', name: 'P', grid: { cols: 4, rows: 3 },
    pages: [{ id: 'pg', name: 'Main', buttons: { '0': btn('a'), '5': btn('b'), '11': btn('c') } }],
  }) as Profile;
  const wider = regrid(profile, 6, 4)!; // (row,col): a=(0,0) b=(1,1) c=(2,3)
  assert.deepEqual(Object.fromEntries(Object.entries(wider.pages[0]!.buttons).map(([k, b]) => [k, b.id])), { '0': 'a', '7': 'b', '15': 'c' });
  const smaller = regrid(profile, 3, 3)!; // c's column 3 no longer exists -> first free cell
  assert.deepEqual(Object.fromEntries(Object.entries(smaller.pages[0]!.buttons).map(([k, b]) => [k, b.id])), { '0': 'a', '4': 'b', '1': 'c' });
  assert.equal(regrid(profile, 2, 1), null, '3 buttons cannot fit in 2 cells');
  assert.equal(firstFreeCell({ '0': 1, '1': 1 }, 2), -1);
});

test('prunePages removes only unreachable folders', () => {
  const profile = ProfileSchema.parse({
    schemaVersion: 1, id: 'p', name: 'P', grid: { cols: 3, rows: 3 },
    pages: [
      { id: 'main', name: 'Main', buttons: { '0': folderBtn('f1', 'apps') } },
      { id: 'apps', name: 'Apps', folder: true, buttons: { '0': folderBtn('f2', 'nested'), '1': folderBtn('loop', 'apps') } },
      { id: 'nested', name: 'Nested', folder: true, buttons: {} },
      { id: 'orphan', name: 'Orphan', folder: true, buttons: { '0': btn('x') } },
      { id: 'second', name: 'Second', buttons: {} },
    ],
  }) as Profile;
  assert.deepEqual(prunePages(profile).pages.map((p) => p.id), ['main', 'apps', 'nested', 'second']);
});
