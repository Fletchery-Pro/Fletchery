# Testing and simulation

Fletchery is checked at three levels:

1. **Contract tests:** each rule on-chain, in isolation and fuzzed.
2. **Engine tests:** routing, pricing, sessions, limits, the audit log and the API.
3. **End to end:** the engine driving real contracts on a local chain, plus a simulated trading week.

## Contract tests

[`contracts/test/Fletchery.t.sol`](../contracts/test/Fletchery.t.sol) uses the [`Fixture`](../contracts/test/Fixture.sol), which deploys:

- the real Uniswap v4 `PoolManager`
- every Fletchery module, with the hook at a mined address
- an AAPL stock token and a demo dollar
- an AAPL pool at $200 with 10,000 shares of liquidity
- credentialed users (a US retail customer, a UK retail customer, a market maker), an agent and an uncredentialed user

**Run twice.** The suite runs twice, once with the stock as `currency0` and once as `currency1`, because the hook's price maths must work for either token ordering. The base suite has 32 tests, including the fuzz test. The flipped suite reruns all 32 plus one ordering check, for **65 tests** in total.

| Area | Tests | What they prove |
|---|---|---|
| Trading | `CredentialedBuyAndSell`, `FillEventCarriesAuditFields` | Normal buys and sells work; every fill emits a complete `Fill` event. |
| Access | `RejectsTraderWithoutCredential`, `RejectsUnapprovedRouter`, `RejectsBlockedJurisdiction`, `RevokedAndExpiredCredentialsFail`, `DistrustingAttesterInvalidatesItsCredentials`, `MinInvestorClass`, `StockTokenOnlyMovesBetweenEligibleHolders`, `UncredentialedLpCannotAddLiquidity` | Every access rule refuses with the right error. Removing an attester's role invalidates all its credentials at once. |
| Caps | `MonthlyCapEnforcedPreTrade`, `CapResetsOnFirstOfMonth_AndFailsClosedWithoutBasis`, `RepeatBreachStopsSymbolForThreeMonths`, `testFuzz_CapNeverExceeded` | Caps are enforced before the fill and reset on the 1st; no basis means no trading; a repeat breach stops the symbol for 90 days. The fuzz test tries 256 random order sizes and the cap is never exceeded. |
| Listings and halts | `HaltMirroring`, `ThirdPartyListingNeedsNotice_IssuerCanObject`, `ObjectionWindowCloses`, `Tier1SymbolLimit`, `Tier2Parameters`, `MonthKeyMatchesCalendar` | Halts block trading; the 30-day notice and the issuer's objection work; the symbol limits hold; month keys match the calendar. |
| Weekend Guard | `StaleFairValueFailsClosed`, `TradeThatDislocatesPriceIsRejected`, `WeekendBandIsWiderButStillBinding`, `ArbitrageTowardFairValueIsAlwaysAllowed` | A stale price stops trading; trades that would push the price out of band are refused; weekend bands are wider but still bind; repairing trades always pass. |
| Agents | `AgentTradesWithinMandate`, `AgentBlockedOverPerTradeLimit_AndAfterRevoke`, `AgentWithoutMandateCannotSpendSomeoneElsesFunds` | Agents trade within limits, are blocked over them and after a revoke, and can't spend a stranger's funds. |
| Rights | `DividendPaysRecordDateHolders_IncludingPoolPassThrough`, `ProxyVoteUsesRecordDateWeights`, `SnapshotHistoryIsExact` | Dividends and votes use exact record-date balances, including shares held by the pool. |
| Proof | `ProofAnchorsMustBeContiguous` | Anchors can't skip or overlap. |
| Ordering | `DefaultOrdering`, `OrderingIsFlipped` | Confirms which token ordering each run uses. |

```bash
cd contracts && forge test
```

## Engine tests

Three files in [`engine/test`](../engine/test), 20 tests:

| Test | What it proves |
|---|---|
| keccak256 matches known Ethereum vectors | The hash is correct. |
| function selectors match Solidity | Encoding matches the compiler. |
| ABI encodes static and dynamic arguments | Byte-for-byte match with Foundry's `cast`. |
| symbols round-trip through bytes32; negative ints decode | Helpers are correct. |
| sessions follow the New York clock, including DST and holidays | Session boundaries hold across clock changes, holidays and early closes. |
| hours since close counts across the weekend | Confidence widens correctly over a weekend. |
| regular hours: fair value is the NBBO mid with a tight band | Regular-hours behaviour. |
| weekend: one thin or manipulated offshore print cannot drag fair value | Outlier rejection and the 40% weight cap. |
| overnight: futures move the model by beta | The overnight model. |
| splits a large order across venues and beats the best single venue | Splitting pays off. |
| never routes past a venue cap | Cap headroom is respected. |
| respects jurisdiction: US clients never touch offshore tokens; UK clients never touch US TSVs | Country rules. |
| skips a venue that has not whitelisted the router, and says why | Whitelist handling. |
| halts and limit prices are honoured | Halts and limits. |
| execute moves pools and consumes caps | The simulation's state updates. |
| agent mandates enforce per-trade, daily, symbol and sell limits | Off-chain agent limits. |
| audit log detects any edit, deletion or reordering | Tamper detection. |
| Fletchery end to end: agent order, rejection with reason, reports, anchor | The engine object. |
| broker API: quote, order, mandate refusal, halt, reports, audit | The HTTP API. |

```bash
cd engine && npm test
```

## The on-chain run

[`scripts/e2e.sh`](../scripts/e2e.sh) starts `anvil` with its clock set to 25 September 2026 and runs [`Deploy.s.sol`](../contracts/script/Deploy.s.sol). It then moves the chain forward 31 days to Monday 26 October 2026, 10:30 New York, runs [`Launch.s.sol`](../contracts/script/Launch.s.sol), and hands over to [`engine/scripts/onchain-demo.ts`](../engine/scripts/onchain-demo.ts).

The demo drives the real contracts through 19 steps. Each step either fills or is refused **on-chain** with the expected error:

| # | Step | Expected result |
|---|---|---|
| 1 | Weekend Guard posts fair value | $200.00 ± 10 bps (regular) |
| 2 | Read monthly cap headroom | 10,000 shares left (Tier 1) |
| 3 | US customer buys $10,000 of AAPL | Fills |
| 4 | UK customer sells 10 shares | Fills |
| 5 | Wallet with no credential tries to buy | `NoCredential` |
| 6 | Exchange halts AAPL; order during the halt | `Halted("AAPL", "LULD")` |
| 7 | Halt lifted; same order | Fills |
| 8 | Customer grants an AI agent a mandate | $2,000/trade, $5,000/day, buys only |
| 9 | Agent buys $1,500 for the customer | Fills; shares go to the customer |
| 10 | Agent tries $3,000 | `PerTradeLimit` |
| 11 | Agent tries to sell | `SellsNotAllowed` |
| 12 | $600,000 market buy | `PriceOutOfBand` |
| 13 | Cap basis revised down (ADV 200k → cap 500 shares) | Headroom shrinks |
| 14 | Sell over the remaining cap | `CapExceeded` |
| 15 | Engine sizes the order to headroom instead | Fills |
| 16 | Fair value is 3 minutes old (limit 2) | `StaleFairValue` |
| 17 | Engine reposts; order retried | Fills |
| 18 | $0.26 dividend on the record-date balance | Paid to the holder |
| 19 | Audit log anchored on-chain | Head verified against the anchor |

Outputs go to `engine/out/onchain_run.json`, `onchain_fills.csv` (decoded from `Fill` events) and `onchain_audit.jsonl`.

## The simulated week

[`engine/scripts/simulate.ts`](../engine/scripts/simulate.ts) runs a **simulated** week, Monday 26 October to Monday 2 November 2026, through the engine. It uses AAPL, NVDA, TSLA and AMC, with background order flow plus scripted events:

| Day | Scenario | What it shows |
|---|---|---|
| Mon | A token-delivery order is split across TSVs; Venue B whitelists the router; the same order is re-routed | Splitting, and new liquidity arriving with no new integration |
| Tue | A TSLA limit-up/limit-down halt is mirrored, then lifted | Halts block every venue with a reason |
| Wed | A customer gives an AI agent a mandate; over-limit, wrong-symbol and daily-limit orders are refused | Agent limits with readable reasons |
| Thu | NVDA hits late-month Tier 1 caps | Flow moves to venues with headroom; no cap is breached |
| Sat | A thin offshore AMC print spikes +40% | Weekend Guard ignores it; a panic buy stops at the band |
| Sun | Index futures reopen −1.8% | Fair values and bands move by beta before Monday |

**Summary from a typical run** (simulated data):

| Measure | Result |
|---|---|
| Orders | 843: 777 filled, 2 partial, 64 rejected with reasons |
| Average slippage vs fair value | 8.96 bps |
| Average improvement vs best single venue | 0.84 bps across all orders (most are small and single-venue; large orders improve far more) |
| Cap lines exhausted | NVDA on the three TSVs, with no breach |
| Audit log | 1,710 entries, chain verified, 8 daily anchors |

All of these numbers come from made-up market data. They show the code working, not real-world performance.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the contract tests, the engine type-check and tests, and the end-to-end run on every push and pull request.
