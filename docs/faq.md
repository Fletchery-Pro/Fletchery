# FAQ

### What is Fletchery, in one sentence?

The routing and compliance layer for tokenized stocks. Brokers connect once and get the best price across every venue, with every rule checked before and during the trade.

### Is it live? Can I trade with it?

No. This is a working prototype. The contracts have not been audited, and every price, venue and flow in the demos is simulated. Nothing here touches real money.

### Is Fletchery a broker, an exchange or a token issuer?

None of those. It is software that sits between brokers and venues. Brokers hold customer accounts, venues run the pools, and issuers or transfer agents create the tokens. See [What is Fletchery?](what-is-fletchery.md#what-fletchery-is-not)

### Is Fletchery approved by the SEC, or partnered with any venue or broker?

No. Nothing in this repository claims approval by, or a relationship with, any regulator, exchange, broker or venue. "Venue A/B/C" and "Offshore pool" are generic placeholders.

### Which venues does it support?

In the prototype, simulated ones. The contracts are designed so that any TSV can run `FletcheryHook` in its pools. The engine can route to venues that don't run the hook too, via adapters, which are on the [roadmap](roadmap.md).

### Why check the rules twice, off-chain and on-chain?

- **Off-chain** checks give customers an instant, readable answer and let the router plan around limits.
- **On-chain** checks guarantee the rules hold even if the engine is wrong or someone goes around it.

See [Architecture](architecture.md#design-principles).

### What happens if the fair-value feed stops?

Trading in that stock stops once the last fair value is older than the session's limit (2 minutes in regular hours, up to 30 minutes at weekends). This is deliberate: Fletchery fails closed.

### Can a trade ever move a price outside the band?

Only if it moves the price **closer** to fair value than it was before. Trades that repair a dislocated pool must never be blocked, or a bad price would be stuck.

### How does an AI agent trade without its own KYC?

The **customer** holds the credential. The agent trades under the customer's **mandate**: per-trade and daily limits, a stock list, whether it may sell, and an expiry. All of it is enforced on-chain, and the customer can revoke the mandate instantly.

### Does personal data go on-chain?

No. A credential holds a country code, an investor class, an expiry and a hash pointing to the attester's own KYC record.

### What does "tamper-evident" mean for the audit log?

Each entry includes the hash of the previous one, so changing any entry breaks every later link. The latest hash is written on-chain daily. Anyone holding the log can prove it matches what was anchored.

### Why is the code public?

- **The rules require it.** The order requires a TSV's smart contracts to be public and auditable on a public blockchain.
- **Trust.** Public code lets brokers, venues and auditors see exactly what is enforced.

See the [README](../README.md#why-the-code-is-public).

### Can I use this code?

Yes, for any non-production purpose under the [Business Source License 1.1](../LICENSE): reading, research, testing, evaluation and building an integration. Production use needs a commercial licence; email [team@fletchery.pro](mailto:team@fletchery.pro). On 26 October 2030 the code becomes available under GPL-2.0-or-later.

### Why the name?

*Fletchery* is the craft of making arrows: getting each one to fly true. Fletchery gets each order to the right place.

### How do I get in touch?

[team@fletchery.pro](mailto:team@fletchery.pro) · [fletchery.pro](https://fletchery.pro)
