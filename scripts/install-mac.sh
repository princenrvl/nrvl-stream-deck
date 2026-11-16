#!/bin/sh
# NRVL Stream Deck — install or update on the hub Mac. Safe to run again at any time.
# It builds everything, starts the hub at login, pairs this Mac as the first computer and shows the iPad QR code.
set -eu
cd "$(dirname "$0")/.."
say() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nError: %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || fail "Node.js 24 or newer is required: https://nodejs.org"
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 24')" = "true" ] || fail "Node.js 24 or newer is required (found $(node -v))"
command -v swift >/dev/null || fail "Xcode or the Xcode Command Line Tools are required: xcode-select --install"
command -v openssl >/dev/null || fail "openssl is required (it ships with macOS)"

say "Installing dependencies and building the iPad app"
npm install --no-audit --no-fund
npm run build

say "Building the Mac agent"
swift build -c release --package-path agents/macos
AGENT="agents/macos/.build/release/nrvl-agent"

say "Starting the hub (and at every login)"
node apps/hub/src/cli.ts service install
i=0
until node apps/hub/src/cli.ts service status | grep -q "running at"; do
  i=$((i + 1)); [ "$i" -le 30 ] || fail "The hub did not start. See ~/Library/Logs/nrvl-hub.log"
  sleep 1
done

if "$AGENT" status >/dev/null 2>&1; then
  say "This Mac is already paired"
else
  say "Pairing this Mac"
  PAIRING=$(node apps/hub/src/cli.ts pair agent | grep -o 'nrvl1\.[A-Za-z0-9_-]*')
  "$AGENT" pair "$PAIRING"
fi
say "Starting the agent (and at every login)"
"$AGENT" install

say "Pair your iPad"
node apps/hub/src/cli.ts pair controller
cat <<'TXT'
Done.
  1. New iPad: open the "Install the certificate first" address above on the iPad and follow the three steps.
  2. Scan the QR code with the iPad camera, then Share -> Add to Home Screen.
  3. For keyboard shortcuts, media keys, typing and lock: System Settings -> Privacy & Security -> Accessibility,
     enable ~/Library/Application Support/NRVLStreamDeck/nrvl-agent (again after every update).
To update later: get the new code and run this script again.
TXT
