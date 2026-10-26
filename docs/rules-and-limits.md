# Rules and limits reference

Every rule Fletchery enforces, with its parameters, where it is checked and the error it raises. Defaults are as shipped; most can be changed by the venue operator.

## Venue tiers

| Parameter | Tier 1 | Tier 2 | Where |
|---|---|---|---|
| Monthly volume cap | 0.25% of prior-month ADV (`capBps = 25`) | 2.5% (`capBps = 250`) | `VenueController` constructor |
| Maximum active symbols | 75 | 250 | `VenueController.activateListing` → `SymbolLimit(max)` |

## Monthly volume caps

| Rule | Value | Where | Error |
|---|---|---|---|
| Cap for this month | `priorMonthAdv × capBps / 10,000` | `VenueController.setCapBasis` | — |
| Cap basis must exist for the current month | fails closed | `recordVolume` | `NoCapBasis(symbol, monthKey)` |
| A fill may not take volume over the cap | checked before each fill | `recordVolume` (called from the hook's `afterSwap`) | `CapExceeded(symbol, wouldBe, cap)` |
| Month boundary | UTC calendar month; resets on the 1st | `monthKey` | — |
| Breach | volume already above a newly posted (lower) cap | `setCapBasis` → `_breach` | event `CapBreached` |
| Repeat breach | another breach within **365 days** | `_breach` | event `SymbolStopped` |
| Stop period | **90 days** | `STOP_PERIOD` | `Stopped(symbol, until)` |
| Off-chain sizing | orders sized to remaining headroom; venues with none are skipped | `router.ts` | reason `monthly volume cap exhausted` |

## Listings

| Rule | Value | Where | Error |
|---|---|---|---|
| Notice before trading | **30 days** | `NOTICE_PERIOD`, `activateListing` | `NoticePeriodRunning(activatesAt)` |
| Issuer may object (third-party tokens only) | within the 30 days | `objectToListing` | `ObjectionWindowClosed`, `IssuerSponsored`, `NotIssuer`, `NotNoticed` |
| Only active listings trade | — | `requireTradable` | `NotActive(symbol)` |
| No duplicate notice | — | `noticeListing` | `ListingExists(symbol)` |

## Halts

| Rule | Where | Error |
|---|---|---|
| Symbol halt mirrored from the listing exchange | `VenueController.setHalt` (`HALT_ORACLE`) | `Halted(symbol, reason)` |
| Market-wide halt | `setMarketWideHalt` | `Halted("*", reason)` |
| Off-chain mirror | `Fletchery.setHalt` | reason `symbol halted` |

## Access

| Rule | Default | Where | Error |
|---|---|---|---|
| Principal must hold a valid credential | — | `FletcheryHook._requireEligible` | `NoCredential(account)` |
| Credential valid only while not revoked, not expired, class ≠ NONE **and its attester is still trusted** | — | `CredentialRegistry.isValid` | (as above) |
| Blocked countries | the demo blocks 408 (North Korea) on-chain; the engine's sanctioned list is 408, 364, 760, 192 | `setJurisdictionBlocked`; `venues.ts` | `JurisdictionNotAllowed(code)`; reason `jurisdiction blocked` |
| Minimum investor class | `RETAIL` | `setMinClass` | `InvestorClassTooLow` |
| Only approved routers | — | `setRouter` | `RouterNotApproved(router)` |
| Liquidity providers must be credentialed | — | `beforeAddLiquidity` | `NoCredential(account)` |
| Stock token only moves between eligible holders or system contracts | — | `StockToken._transfer`, `mint` | `NotEligible(account)` |
| Venue whitelist of routers (venues that require one) | — | `router.ts` eligibility | reason `router not whitelisted by venue` |
| Venue country rules | US TSVs: US only; offshore: not US | `venues.ts` | reasons `jurisdiction not eligible` / `jurisdiction blocked` |

## Agent limits

Checked in this order, on-chain (`AgentMandates.canSpend` / `consume`) and off-chain (`MandateBook.check`):

| # | Rule | Error |
|---|---|---|
| 1 | A mandate exists and is active | `NoMandate` |
| 2 | Not expired | `MandateExpired` |
| 3 | Symbol allowed (or `anySymbol`) | `SymbolNotAllowed(symbol)` |
| 4 | Sells allowed, if selling | `SellsNotAllowed` |
| 5 | Notional ≤ per-trade limit | `PerTradeLimit(notional, limit)` |
| 6 | Today's spend + notional ≤ daily limit (UTC day) | `DailyLimit(wouldSpend, limit)` |

Revoking (`AgentMandates.revoke`, `DELETE /mandates/...`) takes effect immediately.

## Weekend Guard bands

| Session | When (ET) | Base width | Max age of fair value | Error when stale |
|---|---|---|---|---|
| Regular | 09:30–16:00 trading days | ±3% (300 bps) | 120 s | `StaleFairValue(symbol, updatedAt)` |
| Extended | 04:00–09:30, 16:00–20:00 | ±5% (500 bps) | 300 s | 〃 |
| Overnight | 20:00–04:00 before a trading day | ±7% (700 bps) | 600 s | 〃 |
| Closed | weekends, holidays | ±10% (1,000 bps) | 1,800 s | 〃 |

- **Band width:** the base width plus the fair value's own confidence (in bps), capped at 99.99%.
- **No fair value:** `NoFairValue(symbol)`.
- **Out of band:** a trade that leaves the pool price outside the band reverts with `PriceOutOfBand(priceE8, lowE8, highE8)`, **unless** it moved the price closer to the band than it was before the trade.

**Fair-value filters (off-chain):**

| Filter | Value |
|---|---|
| Outlier against other venues | > 4 median absolute deviations (with ≥ 3 observations) |
| Too far from the model | > 15% |
| Too thin | < $25,000 depth within ±2% |
| Most weight one venue can carry | 40% of the total |
| Confidence | 1.96 σ, clamped to 1–5,000 bps |

## Router

| Parameter | Value |
|---|---|
| Slices per order | 200 |
| Slice shrink steps when a full slice doesn't fit | 1, ½, ¼, ⅒ |
| Venue combinations searched | every non-empty subset of eligible venues |
| Plan chosen by | most shares filled, then lowest all-in cost (including gas per leg) |
| Limit price | no slice may fill at a worse marginal price |
| Token delivery | `delivery: "TOKEN"` excludes the primary market |

## Router contract

| Rule | Error |
|---|---|
| Deadline | `Expired` |
| Minimum output | `Slippage(out, minOut)` |
| Only the PoolManager may call back | `NotManager` |

## Shareholder rights

| Rule | Error |
|---|---|
| Dividend claimable from `payableAt` | `NotPayableYet` |
| One claim per holder per dividend | `AlreadyClaimed` |
| Zero entitlement can't be claimed | `NothingToClaim` |
| Only the registered beneficiary claims for a system holder | `NotBeneficiary` |
| Vote before the deadline, once, with a record-date balance | `VoteClosed`, `AlreadyVoted`, `NothingToClaim` |
| Support must be 0, 1 or 2 | `BadSupport` |

## Audit anchors

| Rule | Error |
|---|---|
| Batches must be contiguous | `NonContiguous(expectedFrom, got)` |
| `toSeq ≥ fromSeq` | `BadRange` |
