# Roadmap

Fletchery is a working prototype. This page lists what's done, the known limits of the prototype, and what it takes to run Fletchery for real.

## Done

- [x] Uniswap v4 hook enforcing credentials, halts, listings, agent limits, caps and the fair-value band on every swap
- [x] Broker gateway router with trader/principal identity
- [x] SEC rulebook contract: tiers, caps, breaches, three-month stops, 30-day notice and objection, halts
- [x] Weekend Guard: fair-value model, outlier rejection, weight caps, session bands, on-chain oracle
- [x] Reusable credentials with no personal data on-chain
- [x] On-chain agent limits with a kill switch
- [x] Stock token with record-date snapshots; dividends (including pool pass-through) and proxy votes
- [x] Hash-chained audit log with on-chain anchoring
- [x] Cap-aware router with venue-combination search and comparison against the best single venue
- [x] Order-event, best-execution and cap reports
- [x] Broker HTTP API
- [x] 65 contract tests (both token orderings, fuzzed caps); 20 engine tests; 19-step on-chain run; simulated week; dashboard
- [x] Public website with an interactive router demo: [fletchery.pro/try](https://fletchery.pro/try)

## Next: engineering

| Item | Why |
|---|---|
| Shared cap metering across affiliated venues | The order applies caps per TSV *or set of affiliated TSVs* |
| Multiple fair-value reporters with on-chain aggregation | Removes the single-reporter trust assumption |
| Timelock and two-party control for `DATA_ORACLE`, band policy and role changes | Limits the damage a single key can do |
| Per-LP dividend distribution (e.g. `PoolManager.donate` to in-range liquidity) | Replaces the single pass-through beneficiary |
| Public USD-denominated transaction feed (≤ 10 minutes) | A TSV transparency condition |
| Real venue adapters (quotes, depth, whitelisting, settlement) | Replaces the simulated venue models |
| Concentrated-liquidity pool maths in the router | More accurate quotes than the constant-product approximation |
| Production API: authentication, per-broker tenancy, rate limits, idempotency keys | Required for any real integration |
| KMS/HSM transaction signing | Replaces unlocked node accounts |
| Official reporting schemas | The reports use a simplified field set today |
| Extend the NYSE holiday calendar beyond 2027 | Session accuracy |
| Testnet deployment with monitoring | Proving it outside a local chain |

## Path to production: people, partners and approvals

Software alone can't take Fletchery live. These are needed too:

1. **Legal structure and regulatory advice.** Confirm how Fletchery operates: as a software vendor to registered broker-dealers and TSVs, or otherwise. Confirm the assumptions in [The market and the rules](market-context.md).
2. **Security audit** by a reputable firm, followed by a public bug bounty.
3. **Venue partnerships.** Each venue must approve Fletchery's router and agree data terms.
4. **Broker design partners.** The first integrations, to shape the API around real needs.
5. **Licensed market data.** NBBO, index futures and prior-month ADV from a licensed vendor.
6. **Transfer-agent relationships** for the shareholder-rights flows.

## Get involved

We're choosing our first design partners: brokers, trading apps and tokenized-stock venues. Email [team@fletchery.pro](mailto:team@fletchery.pro).

Issues and pull requests are welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).
