import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ACTIONS, ACTION_TYPES, ButtonSchema, isClientAction, parseShortcut,
  type ActionType, type Button, type DeviceInfo, type MacroStep, type Page, type Profile,
} from '@nrvl/shared';
import { Sheet } from './Sheets.tsx';

/** Centre-crops any picture to a 96px square so icons stay a few kilobytes inside the profile document. */
async function fileToIcon(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const side = Math.min(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96);
  return canvas.toDataURL('image/webp', 0.85); // browsers without WebP encoding return PNG, which is also accepted
}

/** One action being edited: what to do, on which computer, with which parameters. */
type Draft = { type: ActionType; target: string; params: Record<string, unknown> };
type StepDraft = { key: string; kind: 'delay'; ms: number } | { key: string; kind: 'action'; draft: Draft; onError: 'stop' | 'continue'; ifOffline: 'fail' | 'skip' };
type Context = { agents: DeviceInfo[]; folders: Page[]; profiles: Profile[] };

function defaultParams(type: ActionType, ctx: Context, agent?: DeviceInfo): Record<string, unknown> {
  switch (type) {
    case 'app.launch': return { app: '' };
    case 'url.open': return { url: 'https://' };
    case 'keyboard.shortcut': return { modifiers: [], key: '' };
    case 'text.type': return { text: '' };
    case 'mouse.click': return { button: 'left' };
    case 'volume.set': return { level: 50 };
    case 'script.run': return { name: agent?.status?.scripts?.[0] ?? '' };
    case 'page.open': return { pageId: '' };
    case 'profile.switch': return { profileId: ctx.profiles[0]?.id ?? '' };
    default: return {};
  }
}

function ShortcutInput({ params, onChange }: { params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const [text, setText] = useState(params.key ? [...((params.modifiers as string[]) ?? []), params.key].join('+') : '');
  return (
    <label>Shortcut
      <input value={text} placeholder="cmd+shift+4" autoCapitalize="none" spellCheck={false} required
        onChange={(e) => (setText(e.target.value), onChange(parseShortcut(e.target.value) ?? { modifiers: [], key: e.target.value.trim() }))} />
      <small>Modifiers: cmd (Windows key on a PC), ctrl, alt, shift. Keys: a–z, 0–9, f1–f12, space, enter, tab, escape, arrows…</small>
    </label>
  );
}

/** Action picker + computer + the parameter fields for that action. Used for a button and for each macro step. */
function ActionForm(props: { value: Draft; onChange: (d: Draft) => void; ctx: Context; exclude?: ActionType[]; search?: boolean; newFolder?: { name: string; set: (n: string) => void } }) {
  const { value, onChange, ctx } = props;
  const { type, params } = value;
  const [query, setQuery] = useState('');
  const agent = ctx.agents.find((a) => a.id === value.target);
  const q = query.trim().toLowerCase();
  const choices = ACTION_TYPES.filter((t) => !props.exclude?.includes(t) && (t === type || !q || `${ACTIONS[t].name} ${ACTIONS[t].description}`.toLowerCase().includes(q)));
  const set = (p: Record<string, unknown>) => onChange({ ...value, params: p });
  const scripts = agent?.status?.scripts ?? [];

  return (
    <>
      <label>Action
        {props.search && <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search actions" />}
        <select value={type} onChange={(e) => onChange({ ...value, type: e.target.value as ActionType, params: defaultParams(e.target.value as ActionType, ctx, agent) })}>
          {choices.map((t) => {
            const unsupported = !isClientAction(t) && agent?.online && !agent.capabilities.includes(t);
            return <option key={t} value={t}>{ACTIONS[t].name}{unsupported ? ' — not supported on this computer' : ''}</option>;
          })}
        </select>
        <small>{ACTIONS[type].description}</small>
      </label>
      {!isClientAction(type) && (
        <label>Computer
          <select value={value.target} onChange={(e) => onChange({ ...value, target: e.target.value })} required>
            {ctx.agents.length === 0 && <option value="">No computers paired</option>}
            {ctx.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.os}){a.online ? '' : ' — offline'}</option>)}
          </select>
        </label>
      )}
      {type === 'app.launch' && <label>App name{agent?.os === 'macos' ? ' or bundle ID' : ''}<input value={String(params.app ?? '')} onChange={(e) => set({ app: e.target.value })} placeholder="Visual Studio Code" required /></label>}
      {type === 'url.open' && <label>URL<input type="url" value={String(params.url ?? '')} onChange={(e) => set({ url: e.target.value })} required /></label>}
      {type === 'keyboard.shortcut' && <ShortcutInput params={params} onChange={set} />}
      {type === 'text.type' && <label>Text to type<textarea value={String(params.text ?? '')} onChange={(e) => set({ text: e.target.value })} maxLength={500} rows={3} required /></label>}
      {type === 'mouse.click' && (
        <label>Button
          <select value={String(params.button)} onChange={(e) => set({ button: e.target.value })}><option value="left">Left click</option><option value="right">Right click</option></select>
        </label>
      )}
      {type === 'volume.set' && <label>Level: {Number(params.level)}%<input type="range" min={0} max={100} value={Number(params.level)} onChange={(e) => set({ level: Number(e.target.value) })} /></label>}
      {(type === 'volume.mute' || type === 'mic.mute') && (
        <label>When pressed
          <select value={String(params.state ?? 'toggle')} onChange={(e) => set(e.target.value === 'toggle' ? {} : { state: e.target.value })}>
            <option value="toggle">Toggle</option><option value="on">Always mute</option><option value="off">Always unmute</option>
          </select>
        </label>
      )}
      {type === 'script.run' && (scripts.length ? (
        <label>Script
          <select value={String(params.name)} onChange={(e) => set({ name: e.target.value })}>
            {!scripts.includes(String(params.name)) && <option value={String(params.name)}>{String(params.name) || 'Choose…'}</option>}
            {scripts.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
      ) : <p className="note">No scripts are allow-listed on that computer yet. Add them to its agent.json (see README), then restart the agent.</p>)}
      {type === 'page.open' && (
        <>
          <label>Folder
            <select value={String(params.pageId ?? '')} onChange={(e) => set({ pageId: e.target.value })} required={!props.newFolder}>
              {props.newFolder ? <option value="">New folder…</option> : <option value="">Choose…</option>}
              {ctx.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          {props.newFolder && !params.pageId && <label>Folder name<input value={props.newFolder.name} onChange={(e) => props.newFolder!.set(e.target.value)} maxLength={40} placeholder="Apps" /></label>}
        </>
      )}
      {type === 'profile.switch' && (
        <label>Profile
          <select value={String(params.profileId)} onChange={(e) => set({ profileId: e.target.value })} required>
            {ctx.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

type Props = Context & {
  button?: Button;
  onSave: (b: Button, newFolder?: Page) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
};

export function ButtonEditor({ button, agents, folders, profiles, onSave, onDelete, onDuplicate, onClose }: Props) {
  const ctx = { agents, folders, profiles };
  const firstAgent = agents[0]?.id ?? '';
  const [label, setLabel] = useState(button?.label ?? '');
  const [icon, setIcon] = useState(button?.icon ?? '');
  const [image, setImage] = useState(button?.image ?? '');
  const [color, setColor] = useState(button?.color ?? '');
  const [draft, setDraft] = useState<Draft>(() => {
    const type = button?.action.type ?? (agents.length ? 'app.launch' : 'page.open');
    return { type, target: button?.target ?? firstAgent, params: button?.action.params ?? defaultParams(type, ctx, agents[0]) };
  });
  const [also, setAlso] = useState<string[]>(button?.targets ?? []);
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    ((button?.action.type === 'macro.run' ? button.action.params.steps : []) as MacroStep[]).map((s) =>
      s.kind === 'delay' ? { ...s, key: crypto.randomUUID() }
        : { key: crypto.randomUUID(), kind: 'action', draft: { type: s.action.type, target: s.target ?? firstAgent, params: s.action.params }, onError: s.onError, ifOffline: s.ifOffline }));
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');
  const { type } = draft;
  const others = agents.filter((a) => a.id !== draft.target);

  async function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImage(await fileToIcon(file));
      setError('');
    } catch {
      setError('That file is not an image this device can read');
    }
  }

  const patchStep = (key: string, patch: Partial<StepDraft>) => setSteps(steps.map((s) => (s.key === key ? ({ ...s, ...patch } as StepDraft) : s)));
  const moveUp = (i: number) => setSteps(steps.map((s, j) => (j === i - 1 ? steps[i]! : j === i ? steps[i - 1]! : s)));
  const addStep = (s: StepDraft) => setSteps([...steps, s]);

  function submit(e: FormEvent) {
    e.preventDefault();
    let params = draft.params;
    let newFolder: Page | undefined;
    if (type === 'page.open' && !params.pageId) {
      if (!folderName.trim()) return setError('Give the new folder a name');
      newFolder = { id: crypto.randomUUID(), name: folderName.trim().slice(0, 40), folder: true, buttons: {} };
      params = { pageId: newFolder.id };
    }
    if (type === 'macro.run') {
      if (!steps.length) return setError('Add at least one step to the macro');
      params = {
        steps: steps.map((s): MacroStep => s.kind === 'delay' ? { kind: 'delay', ms: s.ms } : {
          kind: 'action', ...(!isClientAction(s.draft.type) && s.draft.target && { target: s.draft.target }),
          action: { type: s.draft.type, params: s.draft.params }, onError: s.onError, ifOffline: s.ifOffline,
        }),
      };
    }
    const remote = !isClientAction(type);
    const targets = also.filter((t) => t !== draft.target && agents.some((a) => a.id === t));
    const parsed = ButtonSchema.safeParse({
      id: button?.id ?? crypto.randomUUID(),
      label: label.trim() || (newFolder?.name ?? ''),
      action: { type, params },
      ...(remote && draft.target && { target: draft.target }), ...(remote && targets.length > 0 && { targets }),
      ...(icon.trim() && { icon: icon.trim() }), ...(image && { image }), ...(color && { color }),
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid button');
    onSave(parsed.data as Button, newFolder);
  }

  return (
    <Sheet title={button ? 'Edit button' : 'New button'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label className="grow">Label<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} /></label>
          <label>Icon<input className="emoji" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="🎵" maxLength={16} /></label>
          <label>Colour<input type="color" value={color || '#1c2230'} onChange={(e) => setColor(e.target.value)} /></label>
        </div>
        <div className="row">
          {image && <img className="preview" src={image} alt="Current icon" />}
          <label className="filebtn">{image ? 'Change image' : 'Use an image as icon'}<input type="file" accept="image/*" onChange={pickImage} /></label>
          {image && <button type="button" onClick={() => setImage('')}>Remove image</button>}
          {color && <button type="button" onClick={() => setColor('')}>Reset colour</button>}
        </div>

        <ActionForm value={draft} onChange={setDraft} ctx={ctx} search newFolder={{ name: folderName, set: setFolderName }} />

        {!isClientAction(type) && others.length > 0 && (
          <fieldset>
            <legend>Also run on</legend>
            {others.map((a) => (
              <label key={a.id} className="check">
                <input type="checkbox" checked={also.includes(a.id)} onChange={(e) => setAlso(e.target.checked ? [...also, a.id] : also.filter((x) => x !== a.id))} />
                {a.name} ({a.os})
              </label>
            ))}
            {ACTIONS[type].sensitive && also.length > 0 && <small>You will be asked to confirm each time, because this action affects several computers.</small>}
          </fieldset>
        )}

        {type === 'macro.run' && (
          <div className="steps">
            {steps.map((s, i) => (
              <div key={s.key} className="step">
                <div className="row">
                  <b className="grow">Step {i + 1}{s.kind === 'delay' ? ' — wait' : ''}</b>
                  <button type="button" disabled={i === 0} onClick={() => moveUp(i)} aria-label={`Move step ${i + 1} up`}>↑</button>
                  <button type="button" className="danger" onClick={() => setSteps(steps.filter((x) => x.key !== s.key))} aria-label={`Remove step ${i + 1}`}>✕</button>
                </div>
                {s.kind === 'delay' ? (
                  <label>Seconds to wait<input className="num" type="number" min={0} max={60} step={0.5} value={s.ms / 1000}
                    onChange={(e) => patchStep(s.key, { ms: Math.round(Math.min(60, Math.max(0, e.target.valueAsNumber || 0)) * 1000) })} /></label>
                ) : (
                  <>
                    <ActionForm value={s.draft} onChange={(d) => patchStep(s.key, { draft: d })} ctx={ctx} exclude={['macro.run']} />
                    {!isClientAction(s.draft.type) && (
                      <>
                        <label className="check"><input type="checkbox" checked={s.onError === 'continue'} onChange={(e) => patchStep(s.key, { onError: e.target.checked ? 'continue' : 'stop' })} />Carry on with the next step if this one fails</label>
                        <label className="check"><input type="checkbox" checked={s.ifOffline === 'skip'} onChange={(e) => patchStep(s.key, { ifOffline: e.target.checked ? 'skip' : 'fail' })} />Skip this step when that computer is offline</label>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}
            <div className="row">
              <button type="button" disabled={steps.length >= 50} onClick={() => {
                const t: ActionType = agents.length ? 'app.launch' : 'profile.switch';
                addStep({ key: crypto.randomUUID(), kind: 'action', draft: { type: t, target: firstAgent, params: defaultParams(t, ctx, agents[0]) }, onError: 'stop', ifOffline: 'fail' });
              }}>Add action</button>
              <button type="button" disabled={steps.length >= 50} onClick={() => addStep({ key: crypto.randomUUID(), kind: 'delay', ms: 1000 })}>Add wait</button>
            </div>
          </div>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          {button && <button type="button" className="danger" onClick={onDelete}>Delete</button>}
          {button && <button type="button" onClick={onDuplicate}>Duplicate</button>}
          <button className="primary">Save</button>
        </div>
      </form>
    </Sheet>
  );
}
