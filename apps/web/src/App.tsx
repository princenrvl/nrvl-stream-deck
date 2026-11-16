import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ACTIONS, firstFreeCell, isClientAction, ProfileFileSchema, prunePages, retarget, type Action, type Button, type MacroStep, type Page, type Profile } from '@nrvl/shared';
import { cancelMacro, clearPairing, createPairing, deleteProfile, execute, runMacro, saveProfile, useHub, type Result } from './conn.ts';
import { buildTemplate } from './templates.ts';
import { ButtonEditor } from './Editor.tsx';
import { LayoutSheet, PairScreen, Settings } from './Sheets.tsx';

type Flash = 'running' | 'success' | 'error';
const uuid = () => crypto.randomUUID();
const appKey = (s: unknown) => String(s).toLowerCase().replace(/\.(app|exe)$/, '');

export function App() {
  const hub = useHub();
  const [profileId, setProfileId] = useState(() => localStorage.getItem('nrvl.profile') ?? '');
  const [tab, setTab] = useState(0);
  const [stack, setStack] = useState<string[]>([]); // open folders, innermost last
  const [editing, setEditing] = useState(false);
  const [editCell, setEditCell] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'settings' | 'layout' | null>(null);
  const [flash, setFlash] = useState<Record<string, Flash | undefined>>({});
  const [toast, setToastState] = useState<{ text: string; ok?: boolean } | null>(null);
  const setToast = (text: string, ok = false) => setToastState(text ? { text, ok } : null);
  const [macro, setMacro] = useState<{ id: string; label: string; index: number; total: number } | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('nrvl.theme') ?? '');

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    localStorage.setItem('nrvl.theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToastState(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  if (hub.link === 'unpaired') return <PairScreen />;

  const profile = hub.profiles.find((p) => p.id === profileId) ?? hub.profiles[0];
  const topPages = profile?.pages.filter((p) => !p.folder) ?? [];
  const folder = stack.length ? profile?.pages.find((p) => p.id === stack[stack.length - 1]) : undefined;
  const page: Page | undefined = folder ?? topPages[Math.min(tab, topPages.length - 1)];
  const agents = hub.devices.filter((d) => d.role === 'agent');
  const cells = profile ? profile.grid.cols * profile.grid.rows : 0;

  function selectProfile(id: string) {
    localStorage.setItem('nrvl.profile', id);
    setProfileId(id);
    setTab(0);
    setStack([]);
  }
  function save(next: Profile) {
    if (!saveProfile(prunePages(next))) setToast('Not connected — change not saved');
  }
  function savePage(buttons: Record<string, Button>, extraPage?: Page) {
    if (!profile || !page) return;
    save({ ...profile, pages: [...profile.pages.map((p) => (p.id === page.id ? { ...p, buttons } : p)), ...(extraPage ? [extraPage] : [])] });
  }

  /** Navigation actions happen on this controller. Also called for navigation steps inside a macro. */
  function navigate(action: Action) {
    if (action.type === 'page.open') {
      const id = String(action.params.pageId);
      if (!profile?.pages.some((p) => p.id === id)) return setToast('That folder no longer exists');
      setStack((s) => [...s, id]);
    } else if (action.type === 'profile.switch') {
      const id = String(action.params.profileId);
      if (!hub.profiles.some((p) => p.id === id)) return setToast('That profile no longer exists');
      selectProfile(id);
    }
  }

  async function press(b: Button) {
    const { type } = b.action;
    if (type === 'page.open' || type === 'profile.switch') return navigate(b.action);
    if (flash[b.id] === 'running') return;
    const mark = (f?: Flash) => setFlash((s) => ({ ...s, [b.id]: f }));
    let r: Result;
    if (type === 'macro.run') {
      mark('running');
      const run = runMacro(b.action.params.steps as MacroStep[], (p) => {
        if (p.action) navigate(p.action);
        if (p.status === 'running') setMacro({ id: run.id, label: b.label || 'Macro', index: p.index, total: p.total });
      });
      r = await run.done;
      setMacro(null);
    } else {
      const targets = [...new Set([b.target!, ...(b.targets ?? [])])];
      // Sensitive actions (sleep, lock, scripts) on several computers at once always ask first.
      if (targets.length > 1 && ACTIONS[type].sensitive && !confirm(`${ACTIONS[type].name} on ${targets.length} computers?`)) return;
      mark('running');
      const results = await Promise.all(targets.map((t) => execute(t, b.action)));
      const failed = results.flatMap((x, i) => (x.ok ? [] : [`${targets.length > 1 ? `${hub.devices.find((d) => d.id === targets[i])?.name ?? 'Unknown'}: ` : ''}${x.error ?? 'failed'}`]));
      r = failed.length ? { ok: false, error: failed.join(' · ') } : { ok: true };
    }
    mark(r.ok ? 'success' : 'error');
    if (!r.ok) setToast(`${b.label || ACTIONS[b.action.type].name}: ${r.error ?? 'failed'}`);
    setTimeout(() => mark(undefined), 900);
  }

  function setButton(cell: number, b: Button | null, newFolder?: Page) {
    if (!page) return;
    const buttons = { ...page.buttons };
    if (b) buttons[cell] = b;
    else delete buttons[cell];
    savePage(buttons, newFolder);
    setEditCell(null);
  }
  function removeButton(cell: number) {
    const b = page?.buttons[cell];
    const inside = b?.action.type === 'page.open' ? profile?.pages.find((p) => p.id === b.action.params.pageId) : undefined;
    const count = inside ? Object.keys(inside.buttons).length : 0;
    if (count && !confirm(`Delete folder “${inside!.name}” and the ${count} button${count > 1 ? 's' : ''} inside it?`)) return;
    setButton(cell, null);
  }
  function duplicateButton(cell: number) {
    const b = page?.buttons[cell];
    if (!page || !b) return;
    const free = firstFreeCell(page.buttons, cells);
    if (free < 0) return setToast('This page is full');
    savePage({ ...page.buttons, [free]: { ...b, id: uuid() } });
    setEditCell(null);
  }
  function moveButton(from: number, to: number) {
    if (!page || from === to || !page.buttons[from]) return;
    const buttons = { ...page.buttons };
    const displaced = buttons[to];
    buttons[to] = buttons[from]!;
    if (displaced) buttons[from] = displaced; // dropping on another button swaps the two
    else delete buttons[from];
    savePage(buttons);
  }

  /** template: index into TEMPLATES, or -1 for a blank profile. */
  function newProfile(from?: Profile, template = -1, agentId?: string) {
    const agent = agents.find((d) => d.id === agentId) ?? agents[0];
    const p: Profile = from ? { ...from, id: uuid(), name: `${from.name} copy`.slice(0, 40) }
      : template >= 0 && agent ? buildTemplate(template, agent)
      : { schemaVersion: 1, id: uuid(), name: 'New profile', grid: { cols: 4, rows: 3 }, pages: [{ id: uuid(), name: 'Main', buttons: {} }] };
    save(p);
    selectProfile(p.id);
    setEditing(!from && template < 0);
    setSheet(!from && template < 0 ? 'layout' : null);
  }

  function exportProfile() {
    if (!profile) return;
    const file = new Blob([JSON.stringify({ format: 'nrvl-stream-deck-profile', version: 1, profile }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = `${profile.name.replace(/[^\w -]+/g, '').trim() || 'profile'}.nrvl.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  async function importProfile(file: File) {
    let parsed;
    try {
      parsed = ProfileFileSchema.safeParse(JSON.parse(await file.text()));
    } catch {
      return setToast('That file is not valid JSON');
    }
    if (!parsed.success) return setToast(`Not a valid NRVL profile file: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`);
    // Buttons made on another hub point at computers this hub does not know: aim them at the first computer here.
    const { profile: fixed, changed } = retarget(parsed.data.profile as Profile, new Set(agents.map((d) => d.id)), agents[0]?.id ?? '');
    if (changed && !agents.length) return setToast('Pair a computer before importing: the buttons in this file need one to control');
    const p = { ...fixed, id: uuid() };
    save(p);
    selectProfile(p.id);
    setSheet(null);
    setToast(`Imported “${p.name}”${changed ? `. ${changed} button${changed > 1 ? 's were' : ' was'} pointed at ${agents[0]!.name}` : ''}`, true);
  }

  return (
    <div className="app">
      <header>
        <div className="title">
          <span className={`dot ${hub.link === 'online' ? 'on' : 'wait'}`} title={hub.link} />
          {folder ? (
            <><button onClick={() => setStack(stack.slice(0, -1))} aria-label="Back">‹ Back</button><h1>{folder.name}</h1></>
          ) : hub.profiles.length > 1 ? (
            <select value={profile?.id} onChange={(e) => selectProfile(e.target.value)} aria-label="Profile">
              {hub.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : (
            <h1>{profile?.name ?? 'NRVL Stream Deck'}</h1>
          )}
        </div>
        <div className="chips">
          {agents.map((d) => (
            <span key={d.id} className="chip" title={d.online ? 'Online' : `Last seen ${new Date(d.lastSeen).toLocaleString()}`}>
              <span className={`dot ${d.online ? 'on' : 'off'}`} />{d.name}
              {d.online && d.status?.volume != null && <small>{d.status.muted ? 'muted' : `${Math.round(d.status.volume)}%`}</small>}
            </span>
          ))}
        </div>
        <div className="tools">
          {editing && profile && <button onClick={() => setSheet('layout')}>Layout</button>}
          <button className={editing ? 'primary' : ''} onClick={() => setEditing(!editing)} disabled={!profile}>{editing ? 'Done' : 'Edit'}</button>
          <button onClick={() => setSheet('settings')} aria-label="Settings">⚙︎</button>
        </div>
      </header>

      {hub.link !== 'online' && <div className="banner">Reconnecting to the hub…</div>}

      {profile && page ? (
        <main>
          <div className="grid" style={{ '--cols': profile.grid.cols, '--rows': profile.grid.rows } as CSSProperties}>
            {Array.from({ length: cells }, (_, cell) => {
              const b = page.buttons[cell];
              if (!b && !editing) return <div key={cell} className="key blank" />;
              const remote = !!b && !isClientAction(b.action.type);
              const targets = remote ? [b.target!, ...(b.targets ?? [])].map((id) => hub.devices.find((d) => d.id === id)) : [];
              const down = targets.filter((d) => !d?.online).length;
              const offline = remote && down === targets.length;
              const unsupported = remote && !offline && targets.some((d) => d?.online && !d.capabilities.includes(b.action.type));
              // Live state reported by the button's (first) computer.
              const st = targets[0]?.online ? targets[0].status : null;
              const type = b?.action.type;
              const active = (type === 'volume.mute' && st?.muted) || (type === 'mic.mute' && st?.micMuted);
              const live = type === 'app.launch' && st?.apps?.some((x) => appKey(x) === appKey(b!.action.params.app));
              return (
                <DeckKey key={`${page.id}:${cell}`} cell={cell} button={b} editing={editing}
                  className={[b && flash[b.id], offline && 'offline', unsupported && 'disabled', active && 'active', live && 'live'].filter(Boolean).join(' ')}
                  badge={offline ? 'offline' : down ? `${down} offline` : unsupported ? 'unsupported' : active ? 'muted' : ''}
                  onPress={() => b && press(b)} onEdit={() => setEditCell(cell)} onMove={(to) => moveButton(cell, to)} />
              );
            })}
          </div>
          {!editing && Object.keys(page.buttons).length === 0 && <p className="hint">Nothing here yet. Tap Edit to add buttons.</p>}
          {!folder && (topPages.length > 1 || editing) && (
            <nav className="pages">
              {topPages.map((p, i) => <button key={p.id} className={p === page ? 'primary' : ''} onClick={() => setTab(i)}>{p.name}</button>)}
            </nav>
          )}
        </main>
      ) : (
        <main className="emptystate">
          <h2>{agents.length ? 'No profile yet' : 'No computers yet'}</h2>
          <p>{agents.length ? 'Create a profile to start adding buttons.' : 'Pair a Mac or Windows PC and a starter set of buttons will appear here.'}</p>
          <div className="row">
            {!agents.length && <button className="primary" onClick={() => (setSheet('settings'), createPairing('agent'))} disabled={hub.link !== 'online'}>Pair a computer</button>}
            <button className={agents.length ? 'primary' : ''} onClick={() => newProfile()} disabled={hub.link !== 'online'}>New profile</button>
          </div>
        </main>
      )}

      {macro && (
        <div className="macrobar" role="status">
          <span>Running “{macro.label}” — step {macro.index + 1} of {macro.total}</span>
          <button onClick={() => cancelMacro(macro.id)}>Cancel</button>
        </div>
      )}
      {toast && <div className={`toast ${toast.ok ? 'ok' : ''}`} role="alert" onClick={() => setToastState(null)}>{toast.text}</div>}

      {editCell !== null && profile && page && (
        <ButtonEditor button={page.buttons[editCell]} agents={agents} profiles={hub.profiles} folders={profile.pages.filter((p) => p.folder && p.id !== page.id)}
          onSave={(b, newFolder) => setButton(editCell, b, newFolder)} onDelete={() => removeButton(editCell)}
          onDuplicate={() => duplicateButton(editCell)} onClose={() => setEditCell(null)} />
      )}
      {sheet === 'settings' && <Settings devices={hub.devices} theme={theme} setTheme={setTheme} onClose={() => (setSheet(null), clearPairing())} />}
      {sheet === 'layout' && profile && (
        <LayoutSheet profile={profile} agents={agents} onSave={(p) => (save(p), setSheet(null))} onNew={(t, agentId) => newProfile(undefined, t, agentId)}
          onDuplicate={() => newProfile(profile)} onExport={exportProfile} onImport={importProfile}
          onDelete={() => (deleteProfile(profile.id), selectProfile(''), setSheet(null), setEditing(false))} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/**
 * One grid cell. Normal mode: tap runs the button, a long press opens its editor.
 * Edit mode: tap opens the editor, dragging moves the button to the cell it is dropped on.
 */
function DeckKey(props: { cell: number; button?: Button; editing: boolean; className: string; badge: string; onPress: () => void; onEdit: () => void; onMove: (to: number) => void }) {
  const { button: b, editing } = props;
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const skipClick = useRef(false); // set when a gesture (long press or drag) already handled this touch
  const longPress = useRef<number | undefined>(undefined);

  function down(e: PointerEvent<HTMLButtonElement>) {
    skipClick.current = false;
    if (!b) return;
    if (editing) {
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      longPress.current = window.setTimeout(() => {
        skipClick.current = true;
        props.onEdit();
      }, 550);
    }
  }
  function move(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 8) return; // small jitter is still a tap
    d.moved = true;
    e.currentTarget.classList.add('dragging');
    e.currentTarget.style.translate = `${dx}px ${dy}px`;
  }
  function up(e: PointerEvent<HTMLButtonElement>) {
    clearTimeout(longPress.current);
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    skipClick.current = true;
    const el = e.currentTarget;
    el.classList.remove('dragging');
    el.style.translate = '';
    const dropOn = document.elementsFromPoint(e.clientX, e.clientY).find((x): x is HTMLElement => x !== el && x instanceof HTMLElement && x.dataset.cell !== undefined);
    if (dropOn) props.onMove(Number(dropOn.dataset.cell));
  }
  function click() {
    if (skipClick.current) return void (skipClick.current = false);
    if (editing) props.onEdit();
    else props.onPress();
  }

  if (!b) return <button className="key empty" data-cell={props.cell} onClick={props.onEdit} aria-label="Add button">+</button>;
  const isFolder = b.action.type === 'page.open';
  return (
    <button className={`key ${props.className} ${editing ? 'editing' : ''}`} data-cell={props.cell}
      style={b.color ? ({ '--key': b.color } as CSSProperties) : undefined}
      onClick={click} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onPointerLeave={() => clearTimeout(longPress.current)} onContextMenu={(e) => e.preventDefault()}
      aria-label={`${b.label || ACTIONS[b.action.type].name}${props.badge ? ` (${props.badge})` : ''}`}>
      {b.image ? <img src={b.image} alt="" draggable={false} /> : <span className="icon">{b.icon || (isFolder ? '📁' : b.action.type === 'macro.run' ? '⚡️' : '')}</span>}
      <span className="label">{b.label}</span>
      {props.badge && <span className="badge">{props.badge}</span>}
    </button>
  );
}
