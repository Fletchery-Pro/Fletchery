# Security model

> **The contracts have not been audited. Do not use them with real funds.**
> To report a vulnerability, see [SECURITY.md](../SECURITY.md).

This page sets out what Fletchery trusts, what it defends against, and the issues we already know about. It is written to help auditors and reviewers.

## Goals

1. **No trade breaks a rule.** That covers credentials, halts, listings, caps, agent limits and price bands, even if the engine is buggy, bypassed or compromised.
2. **Fail closed.** Missing or stale inputs (fair value, cap basis, pool registration) stop trading rather than letting it through.
3. **No one can trade as someone else** or spend someone else's funds.
4. **History can't be rewritten unnoticed** once it has been anchored.
5. **No personal data on-chain.**

## Trusted parties

Each of these can do damage if its key is compromised or misused. In production, each needs a separate key held in a multisig, HSM or KMS, and the powerful levers need a timelock.

| Party | Role | What it could do if misused | Mitigation (planned) |
|---|---|---|---|
| Venue operator | `owner` of each module and of the hook | Grant any role; register pools; approve routers; change band policies; block countries | Multisig plus timelock; two-step ownership is already in place |
| Attesters (brokers, KYC providers) | `ATTESTER` | Issue credentials to anyone | Only trusted attesters; removing the role invalidates everything they issued at once (tested) |
| Fair-value reporter | `REPORTER` | Post a wrong fair value, widening or shifting the band so bad trades pass | Multiple reporters with on-chain median or deviation checks; confidence limits; monitoring |
| Market-data oracle | `DATA_ORACLE` | Post a wrong ADV basis: too high lets volume past the real cap; too low causes a "breach" and can **stop a symbol for 90 days** | Two-source confirmation; timelock or second signer on downward revisions |
| Halt oracle | `HALT_ORACLE` | Halt or un-halt symbols | Direct exchange feed; alerts on mismatch |
| Anchorer | `ANCHORER` | Anchor a wrong head, or none | Anchors are public and contiguous; anyone holding the log can check them |
| Transfer agent | `TRANSFER_AGENT` | Mint or burn stock tokens; take snapshots | Regulated party; reconciliation against the share register |
| Corporate actions | `CORPORATE_ACTIONS` | Declare dividends and open votes | Dividends must be fully funded up front |

## Threats and defences

| Threat | Defence | Where |
|---|---|---|
| Trading without a credential | Hook checks the principal's credential on every swap | `FletcheryHook._requireEligible` |
| Using an unapproved router to skip checks or spoof `hookData` | Only approved routers' `hookData` is accepted; the approved router always writes `trader = msg.sender` | `_actors`, `FletcheryRouter` |
| Agent spending a stranger's funds via `onBehalfOf` | Needs a live mandate from that principal for that agent | `AgentMandates.consume` (test `AgentWithoutMandateCannotSpendSomeoneElsesFunds`) |
| Agent exceeding its limits | Per-trade, daily, symbol, sell and expiry checks on-chain at fill time | `AgentMandates` |
| Pushing a pool to a glitch price, e.g. a fat-finger order or manipulation on a quiet weekend | Post-trade price must be inside the band, or moving toward it | `_checkBand` |
| Trading on stale prices | Fair value older than the session's limit reverts | `FairValueOracle.band` |
| Breaching a monthly cap | Checked before every fill; reverts rather than going over | `VenueController.recordVolume` (fuzzed) |
| Trading during a halt | Every swap checks the halt flags | `requireTradable` |
| Stock tokens reaching ineligible wallets | Both sides of every transfer are checked | `StockToken._transfer` |
| Editing the audit log after the fact | Hash chain plus contiguous on-chain anchors | `auditLog.ts`, `ProofAnchor` |
| Pool initialised by anyone | Only the hook owner, and only for registered pools | `beforeInitialize` |
| Uncredentialed liquidity providers | Credential required to add liquidity | `beforeAddLiquidity` |

## Known issues and limitations

These are known and tracked. Several are on the [Roadmap](roadmap.md).

1. **Affiliated venues don't share a cap.** The order applies caps per TSV *or set of affiliated TSVs*. Each `VenueController` meters on its own today.
2. **The `DATA_ORACLE` is powerful.** A wrong downward ADV revision triggers a breach, and a second one stops the symbol for 90 days. It needs two-party control.
3. **Single fair-value reporter.** One `REPORTER` key sets the band. Production needs several reporters with on-chain aggregation and sanity checks, such as a maximum move per update.
4. **Availability vs safety.** Because the system fails closed, a reporter outage stops trading after the staleness window (2–30 minutes). That's intended, but it needs monitoring and redundancy.
5. **MEV within the band.** The band limits how far a pool can be pushed, but someone could still sandwich trades *inside* the band. Customers should set `minOut`. Venues may want MEV-protected order flow.
6. **Gaps between anchors.** History is fixed only up to the last anchored head. Entries since then could be rewritten by whoever runs the engine. Anchor more often for high-value flow.
7. **Pool dividends go to one beneficiary.** Shares held by the `PoolManager` are claimed by a single pass-through beneficiary, not paid to each LP directly.
8. **Mandate units.** Limits are in the pool's cash-token units. A venue with several cash tokens would need normalisation.
9. **Engine API has no authentication.** The prototype API is for local use only.
10. **Engine signing.** The demo sends transactions from an unlocked node account. Production must sign with a KMS or HSM.
11. **Assumed rule details.** These are assumptions to confirm with counsel ([The market and the rules](market-context.md)):
    - the 365-day lookback for repeat breaches
    - a 90-day stop standing in for "three months"
    - the UTC calendar month
    - the notice clock starting at on-chain notice rather than the issuer's receipt
12. **Integer rounding.** Prices in `Fill` events and dividend amounts use integer division. Dividend rounding dust stays in the distributor.

## Audit plan

1. Freeze the contracts and tag a release.
2. Hold an external audit by a reputable firm. Uniswap v4 hook experience is preferred.
3. Fix the findings and publish the report in this repository.
4. Launch a public bug bounty.
5. Deploy to a testnet with monitoring, then to production behind multisig and timelock controls.

## Reporting a vulnerability

Please email **team@fletchery.pro** with details and steps to reproduce. Don't open a public issue for security problems. See [SECURITY.md](../SECURITY.md).
