# The market and the rules

This page summarises the regulatory change Fletchery is built for, then maps each rule to the code that handles it.

> **Not legal advice.** This page is our reading of public law-firm summaries of the SEC's order, listed under [Sources](#sources). Read the order itself and take advice from qualified counsel before relying on any of it. Where we had to make an assumption, we say so.

## The Innovation Exemption in brief

On **17 September 2026** the SEC issued a five-year exemptive order, commonly called the **Innovation Exemption**. It is effective immediately and runs to **17 September 2031** unless the SEC changes it. It allows **tokenized NMS stocks** (tokens representing actual shares of US exchange-listed stocks) to trade on-chain through automated market maker (AMM) pools.

The order creates two exemptions:

- **The TSV Exemption.** A *Tokenized Securities Venue* (TSV) that meets every condition doesn't have to register as a national securities exchange or an ATS. A TSV runs one or more permissioned AMM pools.
- **The Covered Firm Exemption.** Liquidity providers that only trade for their own account in TSV pools, and don't hold customer assets, are not treated as dealers.

### Key conditions on a TSV

| Topic | What the order requires (per the summaries) |
|---|---|
| **Tiers** | **Tier 1** covers S&P 500 and Russell 1000 stocks plus eligible ETPs: at most **75** symbols, with monthly volume capped at **0.25%** of the prior month's average daily volume (ADV). **Tier 2** covers other eligible NMS stocks: at most **250** symbols, cap **2.5%** of prior-month ADV. Caps apply per TSV or set of affiliated TSVs. |
| **Cap breaches** | A first volume breach in a stock means the TSV must comply going forward. Each later breach means trading in that stock pauses for **three months**. Breaching the symbol limit takes the TSV outside the exemption. |
| **Issuer notice** | If a third party (not the issuer) tokenized the stock, the TSV must give the issuer written notice. The issuer has **30 calendar days** after receipt to object, and a timely objection bars trading. |
| **Halts** | A TSV must stop trading a tokenized stock at the same time as any halt or suspension of the underlying stock on its primary listing exchange. |
| **Shareholder rights** | Tokens must carry the same dividend, voting and residual-asset rights as the underlying stock. Third-party tokenizers must make proxy materials available to holders. |
| **Access controls** | TSVs must keep identity verification and wallet controls for OFAC and AML/CFT purposes. They may set their own permissioning criteria. |
| **Smart contracts** | Every smart contract a TSV uses must be public and auditable, deployed on a public, permissionless blockchain. |
| **Transparency** | Transaction data must be USD-denominated, freely and publicly available, machine-readable, and updated within 10 minutes of execution. |
| **Operations** | The TSV must be a US person, post a detailed public notice at least 30 days before starting, keep books and records in the US for the exemption period plus three years, and notify participants and the SEC of significant events. |
| **Hours and prices** | TSVs may operate 24/7. The summaries note that pool prices can diverge from exchange prices, especially outside US trading hours or in thin markets. |

### What the summaries say the order does *not* address

- **Routers and aggregators:** how third-party order routers fit in.
- **Broker-dealers and Reg NMS:** the order asks for comment on whether broker-dealers need extra Regulation NMS relief to take part.
- **Reporting specifics:** best execution and CAT reporting.
- **Voting mechanics:** how proxy votes actually work for token holders.

Fletchery is designed to run as **software used by registered broker-dealers and by TSVs**, not as a venue or broker itself. Exactly where routing sits legally is an open question to settle with counsel.

## How each rule maps to the code

✅ implemented · ⚠️ implemented with an assumption · 🗺️ on the roadmap · ➖ outside Fletchery's scope

| Rule | Status | Where | Notes |
|---|---|---|---|
| Tier 1 / Tier 2 symbol limits (75 / 250) | ✅ | `VenueController.activateListing` → `SymbolLimit` | Enforced when a listing goes live, so the limit can never be crossed. |
| Monthly volume cap (0.25% / 2.5% of prior-month ADV) | ⚠️ | `VenueController.recordVolume` → `CapExceeded`; engine `router.ts` | Checked **before** each fill, so a breach can't happen through trading. **Assumption:** the month is the UTC calendar month. |
| Caps apply across affiliated TSVs | 🗺️ | — | Each `VenueController` meters on its own today. Shared metering for affiliated venues is on the [roadmap](roadmap.md). |
| First breach: comply; later breaches: three-month pause | ⚠️ | `VenueController.setCapBasis` → `_breach` → `SymbolStopped` | **Assumptions:** "later" means within 365 days of the last breach, and three months is 90 days. A breach can only arise from a downward revision of the ADV basis mid-month. |
| Issuer notice and 30-day objection window | ⚠️ | `noticeListing`, `objectToListing`, `activateListing` | **Assumption:** the window starts when the notice is recorded on-chain, standing in for the issuer's receipt. Issuer-sponsored tokens skip the objection step. |
| Halts mirrored at the same time | ✅ | `VenueController.setHalt`, `setMarketWideHalt`; engine `setHalt` | Depends on how fast the off-chain halt feed is. Every swap checks the halt flag before it can fill. |
| Same rights as the underlying share | ✅ | `StockToken` snapshots, `RightsDistributor` | Dividends and votes use exact record-date balances, including shares held in pools. Delivering proxy materials is ➖. |
| Identity verification and wallet controls | ✅ | `CredentialRegistry`, `FletcheryHook._requireEligible` | KYC itself is done by trusted attesters (brokers or KYC providers). Only a country code, investor class and expiry go on-chain. |
| Sanctions screening | ⚠️ | `FletcheryHook.setJurisdictionBlocked` | Blocks by country code. Screening individual wallets against sanctions lists is the attester's job before it issues a credential. |
| Public, auditable smart contracts | ✅ | this repository | The contracts must be deployed on a public, permissionless chain. |
| Public transaction data within 10 minutes | 🗺️ | `Fill` events | Every fill is a public on-chain event. A USD-denominated, machine-readable public feed is on the roadmap. |
| Books and records | ⚠️ | `auditLog.ts`, `ProofAnchor.sol` | The tamper-evident log and its on-chain anchors cover the "what happened". Keeping records in the US for the required period is an operational duty. |
| 24/7 trading and price divergence | ✅ | Weekend Guard (`fairValue.ts`, `FairValueOracle.sol`, hook band check) | Not required by the order. It is Fletchery's answer to the price-divergence risk the summaries highlight. |
| Liquidity providers | ✅ | `FletcheryHook.beforeAddLiquidity` | Only credentialed accounts can add liquidity. |
| TSV is a US person, 30-day public notice, SEC exams | ➖ | — | Duties of the venue operator. |

## What this means for brokers

A broker that wants to offer tokenized stocks faces, per venue: onboarding and whitelisting, cap tracking, halt syncing, fair-price checks out of hours, and the record-keeping to prove best execution. With several venues, that work multiplies. Fletchery does it once and gives the broker a single API ([Broker API](broker-api.md)).

## Sources

- Skadden, *SEC's Innovation Exemption Establishes a New Framework for Trading Tokenized Stocks* (22 Sep 2026): <https://www.skadden.com/insights/publications/2026/09/sec-innovation-exemption-establishes>
- Gibson Dunn, *SEC Opens Up Five-Year Sandbox for Tokenized Trading of NMS Stocks* (Sep 2026): <https://www.gibsondunn.com/wp-content/uploads/2026/09/sec-opens-up-five-year-sandbox-for-tokenized-trading-of-nms-stocks.pdf>
- Simpson Thacher, *SEC Issues Innovation Exemption for Tokenized Securities Venues* (7 Oct 2026): <https://www.stblaw.com/about-us/publications/view/2026/10/07/sec-issues-innovation-exemption-for-tokenized-securities-venues-a-new-framework-for-onchain-trading-of-tokenized-nms-stocks>
- Dechert OnPoint on the Innovation Exemption (Sep 2026): <https://www.dechert.com/knowledge/onpoint/2026/9/sec-issues--innovation-exemption--to-facilitate-trading-of-token.html>
