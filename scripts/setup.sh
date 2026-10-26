#!/usr/bin/env bash
# One-time setup: fetch the Uniswap v4 and forge-std sources and install Foundry if missing.
# Needs: git, Node.js 22.18+ and internet access to GitHub.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -d .git ]; then git submodule update --init --recursive; fi  # zip copies already include them

if ! command -v forge >/dev/null 2>&1 && [ ! -x "$HOME/.foundry/bin/forge" ]; then
  echo "Installing Foundry (forge, anvil, cast)…"
  curl -L https://foundry.paradigm.xyz | bash
  "$HOME/.foundry/bin/foundryup"
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) { console.error("Node 22.18+ required (runs TypeScript directly)"); process.exit(1) }'
echo "Ready. Next: ./scripts/test-all.sh"
