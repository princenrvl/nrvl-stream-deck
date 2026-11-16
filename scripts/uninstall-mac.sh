#!/bin/sh
# Stops the hub and the agent and removes their auto-start. Your data and pairings are kept.
set -u
cd "$(dirname "$0")/.."
AGENT="$HOME/Library/Application Support/NRVLStreamDeck/nrvl-agent"
[ -x "$AGENT" ] && "$AGENT" uninstall
node apps/hub/src/cli.ts service uninstall
echo "To erase everything as well: rm -rf ~/.nrvl-stream-deck \"$HOME/Library/Application Support/NRVLStreamDeck\""
