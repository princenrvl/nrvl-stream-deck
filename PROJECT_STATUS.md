# Project status (read this first in a new session)

**Updated:** 2026-11-16 · **Version:** 1.0.0 · **Done:** all six phases; macOS side tested, Windows agent written but never compiled · **Next:** run the installer for real, try a real iPad, verify the Windows agent on a PC (see TODO.md).

## Decisions made by the owner
- Hub runs on this Mac. Accent colour: electric blue.
- Windows agent: write it against protocol v1 and mark it untested (no .NET SDK here).

## What works and how it was verified
- `npm run check` — typecheck, 31 hub/contract tests, 8 Swift tests, web build: contract validation, pairing, auth, execution routing, timeouts, revocation, token rotation, rate limits.
- `npm run test:agent` — 8 Swift tests: pairing string, replay guard, parameter validation, key map.
- `npm run test:e2e` — real hub + real agent on this Mac: volume changed, read back, restored; failing app launch reported as failure.
- Browser at desktop size via `npm run dev`: pairing, button press reaching the agent, button editor, settings + QR.
- Hub restart: agent reconnected on its own.
- Phase 4 in the browser (mouse): drag to move and to swap, create and open a folder, Back, regrid 4×3 → 6×4 keeping positions, add a page, long-press opens the editor without firing the button, duplicate.

- Phase 5 via `npm run test:e2e`: macro with a wait and a tolerated failure, mic mute on/restore, running-apps state, allow-listed script, rejected script name.
- Phase 5 in the browser: Meetings template created (live "running" dot on Notes), macro editor loads and edits steps, macro runs with the progress bar.
- Phase 6: backup → restore into an empty folder → hub starts with the same devices and the agent's old token works (automated test + CLI run on throwaway data); launchd plist validated with `plutil`; latency ~10 ms median, agent ~1% CPU.
- Installed for real on this Mac with `./scripts/install-mac.sh` (2026-11-16): hub + agent run under launchd, this Mac is paired, e2e passed against them. Data: `~/.nrvl-stream-deck`.

## Not verified
- Whether hub and agent come back after a logout or restart (they are installed as login items but no restart was done).
**The Windows agent (`agents/windows`) was written on a Mac with no .NET SDK. It has never been compiled.**
Expect a few compile fixes on first build; its 8 xunit tests cover the pure logic once it builds.
See "Unverified so far" in TODO.md (real iPad, keyboard/media keys, launchd install).

## Layout
`packages/shared` contract · `apps/hub` server · `apps/web` PWA · `agents/macos` Swift agent · `agents/windows` C# agent. Details: ARCHITECTURE.md.
