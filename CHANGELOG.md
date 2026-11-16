# Changelog

## 1.0.0 — 2026-11-16
- One-command install/update for the hub Mac (`scripts/install-mac.sh`), uninstall script, Windows install script (untested).
- Hub auto-start at login (`npm run service …`), automatic daily backups (7 kept), `npm run backup` / `restore`, `npm run audit`.
- Security review ([SECURITY.md](SECURITY.md)): audit-flood and socket-cap fixes, new tests for path traversal, login floods and disaster recovery.
- Agent compiles its status scripts once (lower idle CPU). Measured: ~10 ms median per button press.
- Macros: hub-side engine with waits, per-step "carry on after failure" and "skip when offline", live progress and cancel; macro editor.
- New actions: type text, mouse click, microphone mute, brightness (macOS), lock, sleep, allow-listed scripts, switch profile. Mute actions accept a definite state.
- Buttons can target several computers; sensitive actions confirm first. Live state for mic mute and running apps.
- Six profile templates; profile export/import with a documented file format.
- Interface: drag-and-drop arrangement (drop on a button to swap), long-press to edit, duplicate, image icons, action search.
- Folders (nestable, with Back), multiple pages, and a Layout sheet for profile name, grid size (3×3, 4×3, 4×4, 5×5, 6×4, custom up to 10×10) and pages; create, duplicate and delete profiles.
- Contract: `page.open` client action, optional button `image` and `target`, folder pages, `profile.delete`; profiles are sent to controllers only when they change.
- Windows agent (C#/.NET 8, no NuGet dependencies): pairing, all 10 actions, status, replay guard, reconnect, Run-key auto-start. Written without a compiler; untested.
- Hub: the starter profile now matches the first computer's OS (Notepad instead of Safari on Windows).

## 0.1.0 — 2026-11-16
- Hub: HTTPS/WSS server, local CA, one-time-code pairing, rotating device tokens, rate limits, audit log, SQLite with migrations.
- Shared contract: 10 actions (app launch, URL, keyboard shortcut, volume ×4, media ×3), profile schema v1, protocol v1.
- iPad PWA: pairing, button grid with live states, button editor, device management, dark/light themes, auto-reconnect.
- macOS agent (Swift): pinned-CA pairing, all 10 actions, status reporting, replay guard, reconnect, launchd install.
