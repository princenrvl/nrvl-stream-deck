# TODO

## Phase 3 — Windows agent (code written 2026-11-16, NEVER COMPILED OR RUN)
- [ ] On a Windows PC: `dotnet test agents\windows\NrvlAgent.Tests`, fix any compile errors
- [ ] Pair with the hub (checks TLS pinning via X509Chain and `.local` name resolution)
- [ ] Check each action: volume/mute (Core Audio COM), shortcuts and media keys (SendInput), app launch, URL
- [ ] Check `install` (Run key auto-start, no console window at sign-in) and reconnect after Wi-Fi drop
- [ ] Later: launch Store apps (AUMID), restart after crash (Scheduled Task), DPAPI for the token

## Phase 4 — Stream Deck interface (done 2026-11-16)
- [ ] Try drag-and-drop and long-press with a finger on the real iPad (verified with a mouse only)
- [ ] Try picking an image icon from the iPad photo library (resize code not exercised in a browser yet)
- [ ] Later: move a button into a folder or to another page by dragging; reorder pages

## Phase 5 — Advanced (done 2026-11-16)
- [ ] Not exercised end to end on this Mac (they would disturb the session): text typing, mouse click,
      brightness keys, lock, sleep, and an "also run on" button with two real computers
- [ ] Not exercised in a browser: export/import of a profile file, macro Cancel button (hub side is tested)
- [ ] Later: now-playing state (no public macOS API), running-app state for macro buttons, reorder macro steps by drag

## Phase 6 — Hardening (done 2026-11-16)
- [x] `./scripts/install-mac.sh` run for real on this Mac (2026-11-16): hub and agent installed as login items,
      this Mac paired, `npm run test:e2e` passed against the installed services
- [ ] Enable Accessibility for `~/Library/Application Support/NRVLStreamDeck/nrvl-agent` (the installed agent
      reported it as not granted), then try a keyboard shortcut and a media key button
- [ ] Confirm both services come back after a logout/restart
- [ ] Later: signed and notarised agent app (keeps the Accessibility grant across updates), token in Keychain/DPAPI
- [ ] Later: browser end-to-end tests (Playwright) and a code formatter in CI
- [ ] Later: a packaged installer (.pkg / .msi) instead of scripts; hub on Windows needs a non-openssl certificate path

## Unverified so far
- [ ] Real iPad: certificate install, QR pairing, Add to Home Screen, offline launch
- [ ] macOS keyboard shortcuts and media keys end to end (code paths unit-tested only)
- [ ] `nrvl-agent install` (launchd auto-start)
- [ ] The entire Windows agent and `scripts/install-windows.ps1` (see Phase 3 above)
