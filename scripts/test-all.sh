#!/usr/bin/env bash
# Runs everything: contract tests, engine tests, the simulated week, the on-chain end-to-end
# run, and rebuilds the dashboard from the fresh outputs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

echo "═══ 1/5 Smart contract tests (real Uniswap v4 PoolManager)"
(cd "$ROOT/contracts" && forge test)

echo "═══ 2/5 Engine tests"
(cd "$ROOT/engine" && node --test test/*.test.ts)

echo "═══ 3/5 Simulated trading week"
(cd "$ROOT/engine" && node scripts/simulate.ts)

echo "═══ 4/5 End-to-end on a local chain"
bash "$ROOT/scripts/e2e.sh"

echo "═══ 5/5 Dashboard"
(cd "$ROOT/engine" && node --no-warnings scripts/build-dashboard.ts)
echo "Open dashboard/index.html in a browser, or run: cd engine && node src/server.ts  → http://localhost:8787"
