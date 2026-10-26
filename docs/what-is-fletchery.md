# What is Fletchery?

This page explains Fletchery without jargon. Technical detail lives in the other pages.

## The short version

Stocks are starting to trade as tokens on blockchains. In the US, the SEC now allows this on a new kind of venue (see [The market and the rules](market-context.md)). Several venues are expected, each with its own sign-up process, its own limits and its own prices.

**Fletchery sits between the apps people use to buy stocks and all of those venues.** When a customer places an order, Fletchery:

1. checks which venues that customer is allowed to use right now
2. asks each of them for a price
3. sends the order to the best one, or splits it across several when that works out cheaper
4. checks every rule before the trade, and again at the moment of the trade
5. keeps a record of every decision that nobody can secretly change later

The customer just sees a better price. The broker gets one integration instead of many.

## The problem, in more detail

Imagine you run a trading app and want to offer tokenized stocks. Here's what you're up against.

**There are several venues, and none of them talk to each other.** Each one has its own whitelist and onboarding. Some only accept order routers they've approved. Prices differ between them, sometimes a lot.

**Each venue has a hard monthly volume cap per stock.** For the largest stocks, a venue may trade no more than 0.25% of that stock's average daily volume from the previous month. One big order can use up a venue's whole allowance. Breach the cap twice and that stock is stopped on that venue for three months.

**Halts have to match the real exchange.** If the exchange pauses a stock, every venue has to pause it too, at the same moment.

**Venues can be open when the exchange is shut.** On a Saturday there's no official price for the stock. A thin pool can print a price 40% away from reality, and anyone who buys there pays it.

**Token holders keep their rights.** Dividends and votes still have to reach whoever held the stock on the record date, including shares sitting inside a trading pool.

**AI agents are about to start trading for people.** Customers will want to give an agent a budget and some rules. Those limits need to hold even if the agent misbehaves.

**Regulators will ask why an order went where it did.** The answer needs to be written down at the time, in a form that can't be quietly edited.

Every broker could build all of this. Fletchery lets them build it once.

## What Fletchery is made of

| Part | What it does, simply |
|---|---|
| **Routing** | Gets a price from every venue the customer can use and picks the best split. |
| **Rulebook** | Knows every venue's caps, halts and listing rules, and refuses anything that would break them. |
| **Weekend Guard** | Keeps a fair price for every stock 24/7 and stops pools trading at glitch prices. |
| **Access** | Lets one broker's identity check work at every venue, without putting personal data on-chain. |
| **Agent limits** | Lets customers give an AI agent a spending limit, a stock list and a kill switch. |
| **Shareholder rights** | Pays dividends and counts votes from exact record-date balances. |
| **Audit trail** | Writes down every quote, route, fill and refusal in a chain of records that can't be edited unnoticed. |
| **Reports** | Produces the order, best-execution and cap reports a regulated firm needs. |

## Two layers: the engine and the contracts

Fletchery works in two places at once.

**The engine** runs on a server. It does the thinking: works out fair prices, picks routes, explains refusals and writes reports. Brokers talk to it through an API.

**The smart contracts** live on the blockchain, inside the venue's pools. They do the enforcing: at the exact moment of a trade they check the customer's credential, the agent's limits, the volume cap, the halt status and the price band. If anything is wrong the trade simply doesn't happen.

The engine checks first so customers get a clear, instant answer. The contracts check again so that nothing can get past the rules, even if the engine had a bug or someone bypassed it.

## Who it's for

- **Brokers and trading apps** that want to offer tokenized stocks with the best price, without building and maintaining a connection to every venue.
- **Tokenized-stock venues** that want order flow from many brokers without onboarding each one separately, and want the SEC's rules enforced in their pools.
- **AI-agent platforms** that need a safe way for agents to trade on a customer's behalf.

## What Fletchery is not

- **Not a venue.** Fletchery doesn't run its own exchange or hold its own pools. It connects to venues.
- **Not a broker.** It doesn't hold customer money or accounts. Brokers do.
- **Not a token issuer.** It doesn't create stock tokens. Issuers and transfer agents do.
- **Not finished.** This repository is a working prototype. See the [Roadmap](roadmap.md) for what it would take to go live.

## Try it

The website has a live demo of the router with simulated venues and prices: [fletchery.pro/try](https://fletchery.pro/try). Nothing there is a real trade.
