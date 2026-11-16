import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { GRID_PRESETS, ProfileSchema, regrid, type DeviceInfo, type Profile } from '@nrvl/shared';
import { createPairing, myDeviceId, pair, removeDevice, useHub } from './conn.ts';
import { TEMPLATES } from './templates.ts';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="sheet">
        <div className="sheethead"><h2>{title}</h2><button onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </dialog>
  );
}

export function PairScreen() {
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('pair') ?? '');
  const [name, setName] = useState('iPad');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const err = await pair(code, name);
    setBusy(false);
    if (err) setError(err);
    else history.replaceState(null, '', location.pathname); // drop the used code from the URL
  }
  return (
    <form className="pair" onSubmit={submit}>
      <h1>NRVL Stream Deck</h1>
      <p>Enter the pairing code shown by the hub on your computer.</p>
      <label>Pairing code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" autoCapitalize="characters" autoComplete="off" spellCheck={false} required /></label>
      <label>Name of this device<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Pairing…' : 'Pair'}</button>
    </form>
  );
}

export function Settings({ devices, theme, setTheme, onClose }: { devices: DeviceInfo[]; theme: string; setTheme: (t: string) => void; onClose: () => void }) {
  const { pairing } = useHub();
  return (
    <Sheet title="Settings" onClose={onClose}>
      <h3>Devices</h3>
      <ul className="list">
        {devices.map((d) => (
          <li key={d.id}>
            <span className={`dot ${d.online ? 'on' : 'off'}`} />
            <div className="grow">
              <b>{d.name}</b>{d.id === myDeviceId() && ' (this device)'}
              <small>{d.role === 'agent' ? 'Computer' : 'Controller'} · {d.os} · {d.online ? 'online' : `last seen ${new Date(d.lastSeen).toLocaleString()}`}</small>
            </div>
            <button className="danger" onClick={() => confirm(`Remove “${d.name}”? It will need to be paired again.`) && removeDevice(d.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button onClick={() => createPairing('agent')}>Pair a computer</button>
        <button onClick={() => createPairing('controller')}>Pair another iPad</button>
      </div>
      {pairing && (
        <div className="pairing">
          {pairing.role === 'agent' ? (
            <><p>On the computer, run (valid 10 minutes):</p><code>nrvl-agent pair {pairing.text}</code></>
          ) : (
            <><p>After installing the certificate on the new device, scan this or enter code <b>{pairing.code}</b> (valid 10 minutes):</p>
              {pairing.qr && <img alt="Pairing QR code" src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qr)}`} />}</>
          )}
        </div>
      )}
      <h3>Appearance</h3>
      <div className="row">
        {[['', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, name]) => (
          <button key={v} className={theme === v ? 'primary' : ''} onClick={() => setTheme(v!)}>{name}</button>
        ))}
      </div>
    </Sheet>
  );
}

type LayoutProps = {
  profile: Profile; agents: DeviceInfo[]; onSave: (p: Profile) => void; onNew: (template: number, agentId: string) => void; onDuplicate: () => void;
  onExport: () => void; onImport: (file: File) => void; onDelete: () => void; onClose: () => void;
};

/** Profile name, grid size and pages. Nothing is written until Save, so a half-finished edit never reaches other devices. */
export function LayoutSheet({ profile, agents, onSave, onNew, onDuplicate, onExport, onImport, onDelete, onClose }: LayoutProps) {
  const [template, setTemplate] = useState(-1);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [name, setName] = useState(profile.name);
  const [cols, setCols] = useState(profile.grid.cols);
  const [rows, setRows] = useState(profile.grid.rows);
  const [custom, setCustom] = useState(!GRID_PRESETS.some(([c, r]) => c === profile.grid.cols && r === profile.grid.rows));
  const [pages, setPages] = useState(() => profile.pages.filter((p) => !p.folder).map((p) => ({ id: p.id, name: p.name })));
  const [error, setError] = useState('');
  const clamp = (n: number) => Math.min(10, Math.max(1, Math.round(n) || 1));

  function removePage(id: string) {
    const count = Object.keys(profile.pages.find((p) => p.id === id)?.buttons ?? {}).length;
    if (count && !confirm(`Delete this page and its ${count} button${count > 1 ? 's' : ''}?`)) return;
    setPages(pages.filter((p) => p.id !== id));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const existing = new Map(profile.pages.map((p) => [p.id, p]));
    const top = pages.map((d) => ({ ...(existing.get(d.id) ?? { id: d.id, buttons: {} }), name: d.name.trim() || 'Page' }));
    const next = regrid({ ...profile, name: name.trim() || profile.name, pages: [...top, ...profile.pages.filter((p) => p.folder)] }, cols, rows);
    if (!next) return setError('A page or folder has more buttons than that grid can hold. Remove some buttons or choose a larger grid.');
    const parsed = ProfileSchema.safeParse(next);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid layout');
    onSave(next);
  }

  return (
    <Sheet title="Layout" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Profile name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required /></label>
        <div className="row">
          <label className="grow">Grid (columns × rows)
            <select value={custom ? 'custom' : `${cols}x${rows}`} onChange={(e) => {
              const preset = GRID_PRESETS.find(([c, r]) => `${c}x${r}` === e.target.value);
              setCustom(!preset);
              if (preset) (setCols(preset[0]), setRows(preset[1]));
            }}>
              {GRID_PRESETS.map(([c, r]) => <option key={`${c}x${r}`} value={`${c}x${r}`}>{c} × {r}</option>)}
              <option value="custom">Custom…</option>
            </select>
          </label>
          {custom && <label>Columns<input className="num" type="number" min={1} max={10} value={cols} onChange={(e) => setCols(clamp(e.target.valueAsNumber))} /></label>}
          {custom && <label>Rows<input className="num" type="number" min={1} max={10} value={rows} onChange={(e) => setRows(clamp(e.target.valueAsNumber))} /></label>}
        </div>

        <h3>Pages</h3>
        <ul className="list">
          {pages.map((p, i) => (
            <li key={p.id}>
              <input className="grow" value={p.name} maxLength={40} aria-label={`Name of page ${i + 1}`}
                onChange={(e) => setPages(pages.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))} />
              <button type="button" className="danger" disabled={pages.length < 2} onClick={() => removePage(p.id)}>Delete</button>
            </li>
          ))}
        </ul>
        <div className="row">
          <button type="button" disabled={pages.length >= 20} onClick={() => setPages([...pages, { id: crypto.randomUUID(), name: `Page ${pages.length + 1}` }])}>Add page</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end"><button className="primary">Save layout</button></div>

        <h3>New profile</h3>
        <div className="row">
          <label className="grow">Start from
            <select value={template} onChange={(e) => setTemplate(Number(e.target.value))}>
              <option value={-1}>Blank (custom)</option>
              {agents.length > 0 && TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
            </select>
          </label>
          {template >= 0 && agents.length > 1 && (
            <label className="grow">For computer
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </label>
          )}
          <button type="button" onClick={() => onNew(template, agentId)}>Create</button>
        </div>
        {agents.length === 0 && <small>Pair a computer to unlock the ready-made templates.</small>}

        <h3>This profile</h3>
        <div className="row">
          <button type="button" onClick={onDuplicate}>Duplicate</button>
          <button type="button" onClick={onExport}>Export to file</button>
          <label className="filebtn">Import from file<input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} /></label>
          <button type="button" className="danger" onClick={() => confirm(`Delete profile “${profile.name}” and all its buttons?`) && onDelete()}>Delete</button>
        </div>
      </form>
    </Sheet>
  );
}
