# Architecture

```
iPad (PWA) ──WSS──▶ Hub (Node, on one Mac) ◀──WSS── Agent (Swift / C#) on each computer
                     │ SQLite (~/.nrvl-stream-deck/hub.db)
                     └ serves the PWA over HTTPS
```

| Path | Role |
| --- | --- |
| `packages/shared` | The contract: action registry, profile document, wire messages (zod) |
| `apps/hub` | HTTPS + WebSocket server, pairing, routing, SQLite, local CA |
| `apps/web` | React PWA for the iPad |
| `agents/macos` | Swift agent (`AgentCore` library + `nrvl-agent` CLI) |
| `scripts` | Install / update / uninstall for the hub Mac, and the (untested) Windows agent installer |
| `agents/windows` | C#/.NET 8 agent, same commands and protocol as the Swift one (written, not yet compiled) |

## Decisions

- **One hub, thin agents.** Agents dial out to the hub, so they need no open ports or certificates of their own.
  The iPad needs nothing installed beyond the PWA.
- **No build step for the hub.** Node 24+ runs TypeScript directly; `tsc` is typecheck-only. SQLite is the
  built-in `node:sqlite`. Runtime dependencies: `ws`, `zod`, `qrcode` (hub); `react` (web). The agent has none.
- **Profiles are JSON documents** in one SQLite column, validated by `ProfileSchema` on every read and write.
  The stored document *is* the export format; `schemaVersion` gates future migrations.
- **Deployment is launchd + scripts, not a package.** `npm run service install` writes a LaunchAgent that runs
  the hub from this folder with the Node that installed it and restarts it if it exits; the agent does the same
  for itself. Updating is re-running the install script.
- **Backups are whole snapshots** (`VACUUM INTO` copy of the database + the `tls` folder), taken at start and
  daily. Restoring one restores every pairing because devices trust the CA, not the server certificate.
- **Schema migrations** are an append-only array in `db.ts`, tracked by `PRAGMA user_version`.
- **Discovery is the mDNS hostname** (`<mac>.local`), baked into pairing URLs and the certificate. iPad Safari
  cannot browse Bonjour, so a service advertisement would add nothing for it.
- **Agent credentials** sit in a `0600` file rather than the Keychain (see the `shortcut:` note in `Config.swift`).
- **Folders are pages.** A folder is a page flagged `folder`, opened by a button whose action is `page.open`
  (handled in the controller, never sent to a computer). Folder pages no button leads to are pruned on save.
- **Icons** are emoji or a 96 px image the controller resizes and stores inline in the profile, so there is no
  upload endpoint or file store. Only PNG/JPEG/WebP data URLs are accepted (no SVG, no remote URLs).
- **Macros run on the hub**, one step at a time, reusing the same routing as a single button. That keeps them
  running if the controller disconnects and lets one macro span several computers. Navigation steps (switch
  profile, open folder) are handed back to the controller in the progress stream. Macros are stored inline in
  their button (`macro.run` params), cannot nest, and are capped at 50 steps and 60 s per wait.
- **Extending** is done in two ways rather than with a plugin loader: add an action (three small edits, below),
  or allow-list a script on a computer for `script.run`, which needs no code at all.
- **No retries of actions.** Most are not idempotent (volume up, play/pause); a failure is reported instead.

## Security model

- **TLS everywhere.** The hub creates a private CA and a server certificate on first run (`tls.ts`). The iPad
  installs the CA once. Agents receive the CA's SHA-256 inside the pairing string, download the certificate,
  verify the hash, and from then on trust *only* that CA.
- **Pairing.** One-time 10-character code (≈49 bits), 10-minute life, stored hashed, redeemed by one atomic
  UPDATE, 5 attempts per minute per IP. A code decides the role (controller or agent); roles cannot be mixed.
- **Device tokens.** 256-bit random, stored as SHA-256. Rotated every 30 days at connect; the previous token
  stays valid only until the new one is first used. Removing a device takes effect on its next message.
- **No remote shell.** Only action IDs in `ACTIONS` exist. Parameters are validated by the hub *and* the agent;
  app names can never be parsed as flags, URLs must be http(s), and nothing is passed through a shell.
- **Permissions.** An agent only accepts action IDs in its capability list (`allowedActions` in `agent.json`).
- **Scripts.** `script.run` carries only a name. The agent maps it to a path from its own `agent.json` and runs
  that one file with no arguments and no shell, with an 8 s limit. The hub cannot add or change that list.
- **Sensitive actions** (lock, sleep, scripts) are flagged in the registry; the controller confirms before
  sending one to more than one computer.
- **Replay.** Besides TLS, every command carries an ID and timestamp; agents refuse duplicates and anything
  more than 30 s old (so the computers' clocks must roughly agree).
- **Exposure.** Both servers refuse non-private source addresses. Plain HTTP (:8080) serves only the public CA
  certificate and a setup page.
- **Limits and audit.** 50 messages/s per socket, 4 MB frames, 100 sockets, 5 s to authenticate. Pairing, auth failures,
  executions, profile edits and removals are written to the `audit` table (kept 90 days).

## Wire protocol (v1)

JSON text frames on `wss://hub:8443/ws`. The first frame must be `hello`.

| Direction | Message |
| --- | --- |
| any → hub | `{t:"hello", v:1, deviceId, token}` → `{t:"welcome", deviceId, newToken?}` or `{t:"error", error:"unauthorized"}` |
| any → hub | `{t:"ping"}` → `{t:"pong"}` |
| controller → hub | `{t:"execute", id, target, action:{type, params}}` → `{t:"result", id, ok, error?}` |
| controller → hub | `{t:"macro.run", id, steps}` → `{t:"macro.progress", id, index, total, status, error?, action?}` per step, then `{t:"result", …}`; `{t:"macro.cancel", id}` |
| controller → hub | `{t:"profile.put", profile}`, `{t:"profile.delete", id}`, `{t:"device.remove", id}`, `{t:"pairing.create", role}` → `{t:"pairing", …}` |
| hub → controller | `{t:"state", devices, profiles?}` on every change; `profiles` is included on connect and when profiles changed |
| hub → agent | `{t:"execute", id, ts, action}` → agent replies `{t:"result", id, ok, error?}` |
| agent → hub | `{t:"status", capabilities, status:{volume, muted, micMuted?, apps?, scripts?}}` |

`POST /api/pair {code, name, os}` → `{deviceId, token, role}`. `GET /ca.crt` → the CA certificate.

Health: the hub pings every socket every 10 s and drops silent ones; the web app and the agent send their own
pings and reconnect with backoff when the line goes quiet. An execution with no reply fails after 10 s.

## Profile file format

"Export to file" writes `{ "format": "nrvl-stream-deck-profile", "version": 1, "profile": <Profile> }`, where
`<Profile>` is exactly the stored document (`ProfileSchema` in `packages/shared`): `schemaVersion`, `id`, `name`,
`grid {cols, rows}`, and `pages[]` of `{id, name, folder?, buttons{cellIndex: Button}}`. A `Button` has `id`,
`label`, optional `icon`/`image`/`color`, `target` (+ optional `targets`) and `action {type, params}`.

## Database (schema v1)

`devices(id, name, role, os, token_hash, prev_token_hash, token_issued_at, capabilities, created_at, last_seen)` ·
`pairing_codes(code_hash, role, expires_at, used)` · `profiles(id, doc, updated_at)` · `prefs(key, value)` ·
`audit(id, ts, device_id, event, detail)`

## Adding an action

1. Add it to `ACTIONS` in `packages/shared/src/index.ts` (name, description, platforms, parameter schema).
2. Add a `case` in `Actions.perform` and the ID to `Actions.supported` in **both** agents (`Actions.swift`, `Actions.cs`).
3. If it has parameters, add its field to `ButtonEditor` in `apps/web/src/App.tsx`.

## Known platform limits

- iOS only accepts the hub's certificate after the CA is installed *and* switched on in Certificate Trust Settings.
- macOS keyboard and media-key events need the Accessibility permission, granted per binary path.
- Output devices without software volume (some HDMI/DisplayPort) report no volume; volume actions fail honestly.
- Windows drops injected key presses aimed at administrator windows and the lock screen; the agent reports that as a failure.
- Windows app launch is limited to Start Menu shortcuts, bare program names and full .exe paths, so a button can
  never open a document, script or URL through `app.launch`.
- Windows auto-start uses the per-user Run key: no admin rights needed, but no restart after a crash.
- Play/pause state cannot be shown: macOS has no public "now playing" API, so media buttons do not change face.
- macOS has no microphone mute switch; `mic.mute` sets the input volume to 0 and restores the previous level.
- "Is this app running" on Windows matches the process name or its file description, so some Start Menu names
  will not light up.
- Brightness buttons use the brightness keys, so they act on the built-in display only, and only on macOS.
- Display brightness has no public API for external monitors on either OS (planned: built-in display only).
