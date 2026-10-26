# Engine

The engine is the off-chain half of Fletchery: TypeScript in [`engine/src`](../engine/src), with **no runtime dependencies**. Node 22.18+ runs `.ts` files directly by stripping the types, so there is no build step. `typescript` and `@types/node` are only needed for optional type-checking.

| Module | File | Job |
|---|---|---|
| [Engine object](#the-engine-object) | [`fletchery.ts`](../engine/src/fletchery.ts) | The one object a broker integrates with |
| [Venues](#venues) | [`execution/venues.ts`](../engine/src/execution/venues.ts) | Venue models and pool maths |
| [Router](#router) | [`execution/router.ts`](../engine/src/execution/router.ts) | Eligibility, splitting and best-single-venue comparison |
| [Weekend Guard](#weekend-guard-fair-value) | [`safety/fairValue.ts`](../engine/src/safety/fairValue.ts) | 24/7 fair value and bands |
| [Sessions](#sessions) | [`market/session.ts`](../engine/src/market/session.ts) | New York sessions, holidays, early closes |
| [Agent limits](#agent-limits) | [`access/mandates.ts`](../engine/src/access/mandates.ts) | Off-chain mirror of `AgentMandates` |
| [Audit log](#audit-log) | [`proof/auditLog.ts`](../engine/src/proof/auditLog.ts) | Hash-chained, tamper-evident log |
| [Reports](#reports) | [`compliance/reports.ts`](../engine/src/compliance/reports.ts) | Order events, best execution, cap usage |
| [Chain utilities](#chain-utilities) | [`chain/`](../engine/src/chain) | keccak-256, ABI encoding, JSON-RPC |
| Broker API | [`server.ts`](../engine/src/server.ts) | HTTP API ([Broker API](broker-api.md)) |

---

## The engine object

`new Fletchery(refs, venues?)` takes reference data per symbol (last close, volatility, beta and so on) and an optional venue list, defaulting to `defaultVenues`.

| Method | What it does |
|---|---|
| `fairValue(symbol, ts)` | Weekend Guard fair value. Adds every non-primary venue's current pool price as an observation, with depth taken as 4% of the pool's cash side. |
| `quote(order)` | Fair value, then the route plan. Logs `QUOTE`. Executes nothing. |
| `submit(order)` | Logs `ORDER`, checks the agent mandate if there is one, routes, rejects with a reason if nothing can fill, executes against the venue models, consumes the mandate, then logs `FILL` or `REJECT`. |
| `setHalt(symbol, halted, reason)` | Mirrors a halt to every venue. Logs `HALT`. |
| `setWhitelisted(venueId, ok)` | Records a venue approving or removing the router. Logs `WHITELIST`. |
| `updateReference(symbol, patch)` | Updates reference data, for example futures moves. Logs `REFERENCE`. |
| `reports(day, daysInMonth)` | Order events, best execution and cap usage. |
| `nextAnchor()` | The next audit-log batch to anchor on-chain: `{ head, fromSeq, toSeq }`. |

An `Order` looks like this:

```ts
{
  id: string; account: string; jurisdiction: number;   // ISO 3166-1 numeric
  symbol: string; side: 'BUY' | 'SELL'; shares: number;
  limitPrice?: number;
  agent?: string;                 // set when an AI agent places the order for `account`
  delivery?: 'TOKEN' | 'ANY';     // TOKEN = deliver the token to a wallet → on-chain venues only
  tsMs: number;
}
```

## Venues

Each venue is modelled as one **constant-product pool** (`x · y = k`) per symbol. The pool has *virtual* depth, a fair stand-in for concentrated liquidity near the current price. The primary market is a very deep pool with a 2 bps spread that re-centres on fair value after each trade.

Pool maths:

- `costToBuy(pool, shares, feeBps)` and `proceedsToSell(pool, shares, feeBps)` give the cash and the post-trade price.
- Fees are taken on the input side.

The default landscape is **simulated**, with generic names:

| id | Name | Kind | Who can use it | Sessions | Fee | Notes |
|---|---|---|---|---|---|---|
| `venue-a` | Venue A | TSV, Tier 1 | US persons | 24/7 | 10 bps | Runs the Fletchery hook |
| `venue-b` | Venue B | TSV, Tier 1 | US persons | 24/7 | 15 bps | Only accepts whitelisted routers; starts **not** whitelisted |
| `venue-c` | Venue C | TSV, Tier 1 | US persons | 24/7 | 12 bps | Smaller pools |
| `offshore` | Offshore pool | Offshore tokens | Everyone **except** US persons and sanctioned countries | 24/7 | 8 bps | No cap |
| `primary` | Primary market | Exchange via broker | Everyone except sanctioned countries | Regular and extended only | 0 bps + 2 bps spread | Can't deliver a token to a wallet |

When reference ADVs are supplied, the caps are 0.25% of prior-month ADV, multiplied by a per-venue share. `capUsed` can pre-consume part of the cap to simulate late-month conditions.

## Router

[`execution/router.ts`](../engine/src/execution/router.ts) turns an order into a **route plan**: legs per venue, average price, slippage against fair value, the best single venue for comparison, and a reason for every venue it skipped.

### 1. Eligibility

`eligibility(venue, order, fairValue)` returns `null` (eligible) or a reason. The checks run in this order:

1. `symbol not listed`
2. `token delivery requested (on-chain only)`: a `TOKEN` order can't use the primary market
3. `symbol halted`
4. `venue closed this session`
5. `jurisdiction not eligible` / `jurisdiction blocked`
6. `router not whitelisted by venue`
7. `monthly volume cap exhausted`
8. `pool price outside fair-value band`, **unless** the order would move the price back toward fair value (buying a pool that is below the band, or selling one that is above it)

### 2. Splitting

For a given set of venues, `greedyFill` cuts the order into **200 slices**. For each slice it:

- looks at every venue and computes the **marginal price** of adding that slice there, including fee and half-spread
- shrinks the slice to ½, ¼ or ⅒ if a full slice would break the venue's cap headroom, the fair-value band (the same `dPost < dPre` rule as the hook) or the customer's limit price
- gives the slice to the venue with the best marginal price

It stops when the order is filled or no venue can take more.

### 3. Choosing which venues to use

Splitting across every venue isn't always best, because each leg costs gas. The router runs `greedyFill` on **every non-empty subset** of eligible venues (at most 2⁵ − 1 = 31 with five venues). It keeps the plan that:

1. fills the most shares, then
2. has the lowest all-in cost (cash plus gas per leg used)

This is why a small order goes to one venue while a large one is split.

### 4. Best single venue and improvement

For comparison, the router also works out what the **best single venue** could have done alone. It respects that venue's cap, band and the limit price, shrinking the size by 15% steps until the order fits.

If the split plan and the best single venue fill the same quantity, the plan reports:

```
improvementVsSingleBps = sign × (bestSingle.avgPrice − plan.avgPrice) / bestSingle.avgPrice × 10,000
```

Here `sign` is +1 for buys and −1 for sells. `slippageVsFairBps` is measured against fair value the same way: positive means worse for the customer.

### 5. Execution (simulation)

`execute(plan, venues)` moves each venue's pool reserves and uses up its cap headroom. On-chain, the equivalent is one `swapExactIn` per leg ([on-chain run](testing.md#the-on-chain-run)).

## Weekend Guard (fair value)

[`safety/fairValue.ts`](../engine/src/safety/fairValue.ts) computes a fair value for each stock at any moment, with a confidence interval and the allowed band.

### Step 1: the model anchor

| Session | Anchor | Model uncertainty (σ) |
|---|---|---|
| Regular | NBBO mid | 0.05% |
| Extended | NBBO mid | 0.2% |
| Overnight or closed | `lastClose × (1 + beta × futuresReturnSinceClose)` | `annualVol × √(hours since close / 8,760)`, × 1.25 if futures are shut |

The time scaling uses calendar hours, which is deliberately conservative (weekend hours count fully), with a floor of 15 minutes.

### Step 2: throwing out bad observations

Observations are prices on other venues (offshore pools, other TSVs), each with its liquidity depth. An observation is rejected if:

- it is more than **4 MADs** (median absolute deviations) from the median of all observations, when there are at least 3
- it is more than **15%** from the model
- it has less than **$25k** of depth within ±2%

### Step 3: blending

The remaining observations are blended with the model, each weighted by **precision** (1/σ²):

- the model's σ comes from step 1
- each venue's σ is `0.4% × √($1m / depth)`, so deeper venues count for more
- **no single venue may carry more than 40% of the total weight**, so one manipulated pool can't drag fair value far

```
price      = Σ(value × weight) / Σ(weight)
σ          = √(1 / Σ(weight))
confidence = clamp(round(1.96 × σ × 10,000), 1, 5,000) bps
band       = price × (1 ± (sessionBaseBps + confidence) / 10,000)
```

The session base widths match the on-chain `FairValueOracle` defaults: ±3%, ±5%, ±7% and ±10% ([Rules and limits](rules-and-limits.md#weekend-guard-bands)).

### Worked example (from the simulated week)

On Saturday a thin offshore AMC pool prints **+40%**. The other venues and the model sit near $3.11.

- The print is more than 4 MADs from the other observations, so it is rejected as `outlier vs other venues`.
- Fair value stays **$3.110**, with a closed-session band of **$2.716–$3.504**.
- A panic market buy of 400,000 shares fills 57,100 of them at an average of $3.305, then stops as every pool reaches the top of the band.
- Nobody pays the glitch price of about $4.35.

## Sessions

[`market/session.ts`](../engine/src/market/session.ts) maps any timestamp to a New York session using `Intl.DateTimeFormat` with `America/New_York`, so daylight-saving changes are handled correctly.

| Session | When (ET) |
|---|---|
| `REGULAR` | 09:30–16:00 on trading days (13:00 on early-close days) |
| `EXTENDED` | 04:00–09:30, and close–20:00, on trading days |
| `OVERNIGHT` | 20:00–04:00, only when the next day is a trading day (so Sunday 20:00 opens it) |
| `CLOSED` | Everything else: weekends, holidays, Friday night |

The NYSE holiday and early-close lists cover **2026–2027**; extend them yearly. `hoursSinceLastClose` walks back to the most recent regular close, used for the fair-value confidence.

## Agent limits

[`access/mandates.ts`](../engine/src/access/mandates.ts) mirrors `AgentMandates.sol`, so the broker can tell a customer *instantly* why an agent's order was refused, without waiting for an on-chain revert.

- **Checks:** the same as on-chain, in the same order: `NoMandate`, `MandateExpired`, `SymbolNotAllowed`, `SellsNotAllowed`, `PerTradeLimit`, `DailyLimit`.
- **Units:** USD and UTC days.
- **Source of truth:** the on-chain contract remains the source of truth.

## Audit log

[`proof/auditLog.ts`](../engine/src/proof/auditLog.ts) records everything the engine does.

Each entry is `{ seq, ts, type, data, prev, hash }`:

- `hash = sha256(canonicalJSON({ seq, ts, type, data, prev }))`
- `prev` is the previous entry's hash; the first entry points at a zero "genesis" hash
- canonical JSON sorts object keys and drops `undefined` values, so the same data always hashes the same way

**What this guarantees:**

- Changing any past entry changes its hash, which breaks every later `prev` link.
- `AuditLog.verify(entries)` finds the exact entry where a log was edited, deleted or reordered, and says how: `sequence gap`, `previous-hash mismatch` or `entry contents altered`.
- **Anchoring:** `nextAnchor()` gives `{ head, fromSeq, toSeq }`, which goes to `ProofAnchor.anchor` once a day. Later, `AuditLog.verifyAgainstAnchor(entries, anchoredHead, toSeq)` proves the log up to `toSeq` is exactly what existed when it was anchored.

Entry types used: `ORDER`, `QUOTE`, `FILL`, `REJECT`, `HALT`, `WHITELIST`, `REFERENCE`, `MANDATE` and `MANDATE_REVOKED`.

## Reports

[`compliance/reports.ts`](../engine/src/compliance/reports.ts) builds three reports.

**`catEvents`:** order lifecycle events, using a simplified field set loosely modelled on CAT industry-member reporting. It is *not* the official schema. Event types:

| Code | Event |
|---|---|
| `MENO` | New order |
| `MEOR` | Route to a venue |
| `MEOF` | Fill |
| `MEOJ` | Rejection |

Agent orders carry `handlingInstructions = 'ALGO'`. `toCsv` writes them as CSV.

**`bestExecution`:**

- per venue: number of legs, shares, notional, share of volume (by notional) and average price against fair value (notional-weighted)
- overall: average slippage and average improvement against the best single venue
- counts of rejection reasons

**`capReport`:**

- per TSV and symbol: cap, used, remaining and utilisation
- the projected day of the month the cap runs out at the current run rate
- a status: `OK`, `WATCH` (projected to run out this month) or `EXHAUSTED`

## Chain utilities

These are small, dependency-free helpers so the engine can talk to the contracts:

- [`keccak.ts`](../engine/src/chain/keccak.ts): Keccak-256, tested against known Ethereum vectors.
- [`abi.ts`](../engine/src/chain/abi.ts):
  - ABI encoding of static and dynamic arguments, including tuples
  - function selectors and event topics
  - word decoding
  - `bytes32` symbol helpers

  Checked byte-for-byte against Foundry's `cast`.
- [`rpc.ts`](../engine/src/chain/rpc.ts): a JSON-RPC client.
  - `read` uses `eth_call`.
  - `send` dry-runs with `eth_call` first so reverts surface with their data, then sends through `eth_sendTransaction` from an **unlocked node account**, which is how the local demo works. Production would sign with a KMS or HSM.
  - `decodeRevert` turns custom-error data into readable text, such as `PerTradeLimit($3,000 > $2,000)`.
