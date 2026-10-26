# Glossary

| Term | Meaning |
|---|---|
| **ADV** | Average daily volume: the average number of shares traded per day. TSV caps use the *prior month's* consolidated ADV. |
| **AMM** | Automated market maker. A pool of two tokens that prices trades by formula instead of matching orders. |
| **Agent** | Software, often AI, that places orders for a customer. In Fletchery it trades under the customer's mandate. |
| **Anchor** | Writing the latest audit-log hash on-chain, so history up to that point can't be changed unnoticed. |
| **Attester** | A broker or KYC provider trusted to issue credentials. |
| **Band** | The allowed price range around fair value. Its width depends on the session and the fair value's confidence. |
| **Basis point (bps)** | 0.01%. 100 bps = 1%. |
| **Best execution** | A broker's duty to get customers the most favourable terms reasonably available. |
| **CAT** | Consolidated Audit Trail, the US regulatory database of order events. Fletchery's report is a simplified, CAT-*style* output. |
| **Cap basis** | The prior-month ADV posted for a symbol, which sets this month's cap. |
| **Covered Firm** | A liquidity provider exempted from dealer registration under the Innovation Exemption, if it meets the conditions. |
| **Credential** | An on-chain record that an account passed KYC: country, investor class, expiry and a reference hash. No personal data. |
| **Fail closed** | When an input is missing or stale, stop rather than proceed. |
| **Fair value** | Fletchery's estimate of what a stock is worth right now, including when the exchange is shut. |
| **Fill** | An executed trade, or part of one. The hook emits a `Fill` event for each. |
| **Halt** | A pause in trading a stock on its listing exchange. TSVs must mirror it. |
| **Hook** | In Uniswap v4, a contract the pool calls before and after actions. Fletchery's hook enforces the rules. |
| **Innovation Exemption** | The SEC's exemptive order of 17 September 2026 allowing on-chain trading of tokenized NMS stocks on TSVs. |
| **Issuer-sponsored** | A token created by, or for, the company itself, rather than by a third party. |
| **KYC** | Know your customer: identity checks. |
| **Leg** | The part of an order sent to one venue. |
| **LULD** | Limit up–limit down: US single-stock price bands that pause trading after sharp moves. |
| **MAD** | Median absolute deviation, a robust measure of spread used to reject outlier prices. |
| **Mandate** | A customer's limits for an agent: per-trade, daily, stocks, sells allowed and expiry. |
| **MEV** | Value extracted by reordering or inserting transactions, e.g. sandwiching a trade. |
| **MWCB** | Market-wide circuit breaker: a halt of the whole US market. |
| **NBBO** | National best bid and offer across US exchanges. Its mid-point is fair value during regular hours. |
| **NMS stock** | A stock listed on a US national securities exchange. |
| **Principal** | The beneficial owner of a trade, whose funds and shares move. |
| **Record date** | The date that decides who receives a dividend or can vote. Fletchery uses on-chain snapshots. |
| **Router** | Either the engine's routing logic or `FletcheryRouter`, the on-chain gateway. Context makes it clear which. |
| **Session** | Regular, extended, overnight or closed, in New York time. |
| **Slippage** | How much worse than fair value an order filled, in bps. |
| **Snapshot** | A fixed record of token balances at a moment, used for record dates. |
| **Tier 1 / Tier 2** | TSV categories with different symbol limits (75 / 250) and caps (0.25% / 2.5% of prior-month ADV). |
| **Token delivery** | The customer wants the stock token in their own wallet, so only on-chain venues can be used. |
| **Transfer agent** | The regulated party that keeps the share register and mints or burns stock tokens against real shares. |
| **TSV** | Tokenized Securities Venue: a venue running permissioned AMM pools under the Innovation Exemption. |
| **Weekend Guard** | Fletchery's 24/7 fair value and band system. |
