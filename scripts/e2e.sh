#!/usr/bin/env bash
# End-to-end: start a local chain, deploy Fletchery on a real Uniswap v4 PoolManager,
# wait out the 30-day listing notice, launch the AAPL pool, then drive it from the engine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
# anvil's first default key: a public test key, never use it with real funds
export PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

NOTICE_TS=1790346600   # Fri 25 Sep 2026 14:30 UTC: listing notice filed
LAUNCH_TS=1793025000   # Mon 26 Oct 2026 14:30 UTC (10:30 New York): regular session

anvil --silent --timestamp "$NOTICE_TS" --chain-id 31337 --code-size-limit 100000 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.1; done

mkdir -p "$ROOT/deployments"
cd "$ROOT/contracts"
echo "── Phase 1: deploy modules, issue credentials, file 30-day listing notice"
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow -q >/dev/null
echo "   deployed; addresses in deployments/local.json"

echo "── Advancing the chain 31 days (notice period)"
cast rpc evm_setNextBlockTimestamp "$LAUNCH_TS" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null

echo "── Phase 2: activate listing, post cap basis + fair value, open pool, add liquidity"
forge script script/Launch.s.sol --rpc-url "$RPC_URL" --broadcast --slow -q >/dev/null
echo "   AAPL/dUSD pool live"

echo "── Driving the venue from the Fletchery engine"
cd "$ROOT/engine"
RPC_URL="$RPC_URL" node scripts/onchain-demo.ts
