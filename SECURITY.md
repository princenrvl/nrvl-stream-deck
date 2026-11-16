# Security

Self-review of 2026-11-16, done by the author of the code. It is not an independent audit.

## What is protected, and from whom

The asset is control of your computers. The design assumes an attacker **on your home network** (a guest, a
compromised gadget) who can see and send traffic but has not been paired. It does not defend against someone
who already controls the hub Mac's user account, or against a paired controller: every paired controller is a
full administrator of the deck.

## Controls

| Threat | Control | Tested by |
| --- | --- | --- |
| Eavesdropping, tampering | TLS 1.2+ everywhere with a private CA; agents trust only that CA (pinned by fingerprint at pairing) | e2e pairing of the Swift agent |
| Pairing without permission | One-time 10-character code, 10 min life, stored hashed, single atomic redemption, 5 tries/min per address | `pairing code works exactly once`, `expired…`, `rate limited` |
| Commands without pairing | Nothing but a valid `hello` is accepted on a new socket; 5 s to authenticate | `unauthenticated sockets cannot execute anything` |
| Stolen or guessed token | 256-bit tokens stored as SHA-256, rotated every 30 days, instant revocation | `tokens rotate…`, `removing a device…` |
| Replayed command | TLS, plus command ID + timestamp checked by the agent (30 s window) | Swift/C# `ReplayGuard` tests |
| Remote shell | Only registered action IDs exist; parameters validated by hub **and** agent; no shell is ever invoked; app names cannot be flags; URLs must be http(s) | `hostile or malformed ones are rejected`, agent parameter tests |
| Arbitrary script execution | `script.run` sends a name; the path comes only from that computer's own `agent.json` | `testScriptsMustBeAllowListedLocally` |
| An agent acting as controller | Role is fixed by the pairing code; agent messages are parsed with a separate schema | `an agent cannot send controller commands` |
| Reading hub files over HTTP | Static serving confined to the web build folder; keys and database are outside it | `static files: no path traversal…` |
| Flooding | 50 msg/s per socket, 4 MB frames, 100 sockets, 30 logins/min per address, 5 macros per controller, 4 KB pairing body | `message flooding…`, `a flood of failed logins…` |
| Script injection in the app | React escaping; CSP `default-src 'self'`; icons limited to PNG/JPEG/WebP data URLs (no SVG) | `images are constrained` |
| Exposure to the internet | Both servers refuse non-private source addresses | `isLocalAddress…` |
| Unnoticed misuse | Audit log of pairings, failed logins, every action and macro (`npm run audit`), kept 90 days | `both executions audited` |

## Findings of this review

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | Failed logins beyond the rate limit were still written to the audit table, so a flood could grow the database | Low | Fixed, with a test |
| 2 | No cap on open sockets; unauthenticated connections could pile up for 5 s each | Low | Fixed (100) |
| 3 | `npm audit` on runtime dependencies (`ws`, `zod`, `qrcode`, `react`) | — | 0 known vulnerabilities on 2026-11-16 |

## Accepted risks

- **A paired controller can do anything the deck can do**, including typing text into whatever window has
  focus and removing other devices. Pair only devices you own; restrict a computer with `allowedActions`.
- **Tokens are stored in files** (`agent.json`, mode 600; the iPad's browser storage), not in the Keychain or
  DPAPI. Anyone who can read your user's files can already control that computer.
- **The setup page and the CA certificate are served over plain HTTP** on port 8080. The certificate is public
  information, but an attacker on the network at that exact moment could substitute their own. Compare the
  certificate name ("NRVL Stream Deck Local CA") and, if in doubt, pair with the hub Mac next to you.
- **Backups contain the CA private key.** The archive is written with mode 600; store it accordingly.
- **The binaries are not code-signed or notarised.** macOS therefore ties the Accessibility permission to each
  build, and Windows SmartScreen may warn about the agent.
- **The Windows agent's TLS pinning and input code have never run.** Treat that agent as unreviewed in practice.
