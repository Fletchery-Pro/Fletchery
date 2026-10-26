# Fletchery documentation

These pages explain Fletchery in detail: what it is, why it exists, how every part works, and what it would take to run it for real.

If you only read one page, read [What is Fletchery?](what-is-fletchery.md).

## Reading order

| # | Page | Who it's for |
|---|---|---|
| 1 | [What is Fletchery?](what-is-fletchery.md) | Everyone. No technical background needed. |
| 2 | [The market and the rules](market-context.md) | Anyone who wants to understand the SEC Innovation Exemption and how Fletchery maps each rule to code. |
| 3 | [Architecture](architecture.md) | Engineers, partners and reviewers who want the big picture. |
| 4 | [Smart contracts](smart-contracts.md) | Solidity engineers and auditors. |
| 5 | [Engine](engine.md) | Engineers working on routing, pricing or reporting. |
| 6 | [Rules and limits reference](rules-and-limits.md) | Anyone who needs the exact numbers and error names. |
| 7 | [Broker API](broker-api.md) | Brokers and integrators. |
| 8 | [Getting started](getting-started.md) | Anyone running the code. |
| 9 | [Testing and simulation](testing.md) | Reviewers who want to know what has been proven. |
| 10 | [Security model](security.md) | Auditors and security reviewers. |
| 11 | [Roadmap](roadmap.md) | Partners, investors and contributors. |
| 12 | [FAQ](faq.md) | Quick answers. |
| 13 | [Glossary](glossary.md) | Terms used throughout. |

## Conventions

- **Simulated** means made-up data used to exercise the code. Every price, depth, cap and flow in the simulation and demo is simulated.
- **Venue A, Venue B, Venue C, Offshore pool** are generic placeholders for the kinds of venue a broker will face. They are not real venues.
- **bps** means basis points: 1 bps = 0.01%.
- **ET** means New York time (Eastern Time), which US equity sessions follow.
- Code links point to files in this repository. When a doc and the code disagree, the code is right; please [open an issue](https://github.com/Fletchery-Pro/Fletchery/issues).
