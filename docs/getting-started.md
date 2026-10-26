# Getting started

## Requirements

| Tool | Version | Notes |
|---|---|---|
| macOS or Linux | — | Windows users: use WSL2 |
| `git` | any recent | Needed to fetch the submodules |
| Node.js | **22.18 or newer** | Runs the TypeScript engine directly; nothing to install |
| Foundry (`forge`, `anvil`, `cast`) | recent stable | `scripts/setup.sh` installs it if missing |

## Install

```bash
git clone --recursive https://github.com/Fletchery-Pro/Fletchery.git
cd Fletchery
./scripts/setup.sh
```

`setup.sh`:

1. fetches the `v4-core` and `forge-std` submodules if you cloned without `--recursive`
2. installs Foundry if it isn't on your `PATH`
3. checks your Node version

## Run everything

```bash
./scripts/test-all.sh
```

This runs, in order:

1. **Contract tests:** `forge test`, 65 tests against the real Uniswap v4 `PoolManager`.
2. **Engine tests:** `node --test`, 20 tests.
3. **Simulated week:** writes reports to `engine/out/`.
4. **End-to-end on a local chain:** starts `anvil`, deploys, waits out the listing notice, launches a pool and drives it from the engine.
5. **Dashboard:** rebuilds `dashboard/index.html` from the fresh outputs.

It takes about a minute on a laptop once the compiler is cached.

## Run pieces individually

```bash
# Contracts
cd contracts
forge build
forge test                       # all tests
forge test --mt test_Agent -vv   # just the agent-limit tests, with logs
forge test --gas-report

# Engine
cd engine
npm test                         # node --test test/*.test.ts
npm run demo                     # simulated week → engine/out/
npm run dashboard                # rebuild dashboard/index.html
npm run serve                    # broker API on :8787
npm install && npm run typecheck # optional: full TypeScript type-check

# On-chain run
./scripts/e2e.sh
```

## What you get

After a full run, `engine/out/` contains:

| File | Contents |
|---|---|
| `scenario.json` | Everything the dashboard needs: events, fair-value series, venue prices |
| `cat_events.csv` | Order lifecycle events for the simulated week |
| `best_execution.json` | Best-execution summary |
| `cap_report.csv` | Cap usage per venue and symbol |
| `audit_log.jsonl` | The hash-chained audit log, one entry per line |
| `onchain_run.json` | Results of the 19 on-chain steps |
| `onchain_fills.csv` | Fills read back from on-chain `Fill` events |
| `onchain_audit.jsonl` | The audit log of the on-chain run |

`deployments/local.json` holds the contract addresses from the last local deploy.

Open `dashboard/index.html` in a browser, or start the API and visit `http://localhost:8787/`. The dashboard has:

- a live router you can play with
- the Weekend Guard chart for the week
- best-execution and cap panels
- the event timeline

## Troubleshooting

| Problem | Fix |
|---|---|
| `forge` can't download the compiler | Point `FOUNDRY_SOLC` at a local `solc` 0.8.26 binary, e.g. `export FOUNDRY_SOLC=$HOME/.foundry/solc/solc-0.8.26`. |
| `Node 22.18+ required` | Upgrade Node. Older versions can't run `.ts` files directly. |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | You're on a Node version without type stripping, or you added syntax that needs transforming (enums, parameter properties). The engine sticks to erasable syntax only. |
| Contract tests fail to compile with missing imports | Submodules are missing: `git submodule update --init --recursive`. |
| `e2e.sh` hangs at start | Something else is using port 8545. Stop it, or set `RPC_URL` and run `anvil` yourself. |
| Port 8787 in use | `PORT=8788 node src/server.ts` |

## Safety notes for local runs

- `e2e.sh` uses `anvil`'s first default private key. It's a **public** test key; never use it on a real network.
- The demo deploys a mock dollar token (`dUSD`, "Demo Dollar") with no value.
