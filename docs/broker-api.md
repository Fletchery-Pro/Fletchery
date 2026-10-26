# Broker API

The broker-facing HTTP API is in [`engine/src/server.ts`](../engine/src/server.ts). It is built on `node:http` with no dependencies.

```bash
cd engine && node src/server.ts        # http://localhost:8787 (set PORT to change)
```

> **Prototype API.** It has no authentication or rate limiting, sends JSON with permissive CORS, and trades against the **simulated** venue models. A production API would sit behind authentication, run per broker and send on-chain legs through `FletcheryRouter`. See the [Roadmap](roadmap.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check and server time |
| `GET` | `/venues` | Venue landscape: caps left, halts, whitelist status, pools |
| `GET` | `/fair-value/:symbol` | Weekend Guard fair value and band right now |
| `POST` | `/quote` | Route plan without executing |
| `POST` | `/orders` | Route and execute (against the simulated venues) |
| `POST` | `/mandates` | Customer grants an AI agent a mandate |
| `DELETE` | `/mandates/:principal/:agent` | Kill switch: revoke a mandate |
| `POST` | `/halts` | Mirror an exchange halt or resume |
| `GET` | `/reports/cat.csv` | Order lifecycle events as CSV |
| `GET` | `/reports/best-ex` | Best-execution summary |
| `GET` | `/reports/caps` | Cap usage per venue and symbol |
| `GET` | `/audit/head` | Current audit-log head and entry count |
| `GET` | `/audit/verify` | Re-verify the whole audit log |
| `GET` | `/` | The dashboard, if `dashboard/index.html` has been built |

**Status codes:**

- `200` success (`201` for a created mandate)
- `422` an order was rejected; the body says why
- `400` a malformed request, with `{ "error": "..." }`
- `404` unknown path

## Order fields

Used by `/quote` and `/orders`:

| Field | Required | Type | Notes |
|---|---|---|---|
| `account` | yes | string | The customer (principal) |
| `symbol` | yes | string | Case-insensitive |
| `side` | yes | `"BUY"` or `"SELL"` | |
| `shares` | yes | number > 0 | Fractional shares allowed |
| `jurisdiction` | no | number | ISO 3166-1 numeric; defaults to `840` (US). `826` is the UK. |
| `limitPrice` | no | number | USD per share; the router won't fill worse than this |
| `agent` | no | string | Set when an AI agent is placing the order for `account` |
| `delivery` | no | `"TOKEN"` or `"ANY"` | `TOKEN` means the customer wants the token in a wallet, so only on-chain venues are used |
| `id` | no | string | Your order id; defaults to `API-n` |
| `tsMs` | no | number | Timestamp in milliseconds; defaults to now. Useful for testing other sessions. |

## Examples

All responses below were captured from the prototype with its default (simulated) data. Long decimals are trimmed.

### Fair value

```bash
curl -s localhost:8787/fair-value/AAPL
```

```json
{
  "symbol": "AAPL",
  "price": 260,
  "confidenceBps": 9,
  "session": "REGULAR",
  "model": 260,
  "usedObservations": ["venue-a", "venue-b", "venue-c", "offshore"],
  "rejectedObservations": [],
  "lowBand": 251.966,
  "highBand": 268.034
}
```

### Quote

A US customer wants 500 AAPL delivered to their wallet, during regular hours:

```bash
curl -s -X POST localhost:8787/quote -H 'content-type: application/json' \
  -d '{"account":"us-1","symbol":"AAPL","side":"BUY","shares":500,"delivery":"TOKEN"}'
```

```json
{
  "plan": {
    "orderId": "API-1",
    "symbol": "AAPL",
    "side": "BUY",
    "requested": 500,
    "filled": 500,
    "unfilled": 0,
    "legs": [
      { "venueId": "venue-a", "shares": 320, "cash": 83369.99, "avgPrice": 260.5312, "postPrice": 260.5416 },
      { "venueId": "venue-c", "shares": 180, "cash": 46900.13, "avgPrice": 260.5563, "postPrice": 260.4874 }
    ],
    "avgPrice": 260.5404,
    "totalCash": 130270.18,
    "fairValue": 260,
    "slippageVsFairBps": 20.78,
    "rejected": [
      { "venueId": "venue-b", "reason": "router not whitelisted by venue" },
      { "venueId": "offshore", "reason": "jurisdiction blocked" },
      { "venueId": "primary", "reason": "token delivery requested (on-chain only)" }
    ],
    "session": 3,
    "bestSingleVenue": { "venueId": "venue-a", "avgPrice": 260.6839, "filled": 500 },
    "improvementVsSingleBps": 5.51
  },
  "fairValue": { "symbol": "AAPL", "price": 260, "confidenceBps": 9, "session": 3, "lowBand": 251.966, "highBand": 268.034 }
}
```

**Reading the plan:**

- **Legs:** the order is split 320 / 180 between Venue A and Venue C.
- **Skipped venues:** every venue it didn't use is listed with a reason.
- **Improvement:** the split is 5.51 bps cheaper than the best single venue could manage alone.
- **Session codes:** `session` is numeric in plans (`0` closed, `1` overnight, `2` extended, `3` regular). `/fair-value` returns the name.

### Agent mandate, then an agent order that's too big

```bash
curl -s -X POST localhost:8787/mandates -H 'content-type: application/json' \
  -d '{"principal":"us-1","agent":"agent-7","maxPerTrade":5000,"dailyLimit":20000,"allowSells":false,"symbols":["AAPL","NVDA"]}'
# → 201 {"ok": true}

curl -s -X POST localhost:8787/orders -H 'content-type: application/json' \
  -d '{"account":"us-1","agent":"agent-7","symbol":"AAPL","side":"BUY","shares":40}'
```

```json
{
  "order": { "id": "API-2", "account": "us-1", "symbol": "AAPL", "side": "BUY", "shares": 40, "agent": "agent-7", "delivery": "ANY" },
  "plan": { "requested": 40, "filled": 0, "unfilled": 40, "legs": [] },
  "status": "REJECTED",
  "rejectReason": "PerTradeLimit: $10400.00 > $5000"
}
```

This comes back as HTTP `422`.

Mandate fields:

| Field | Notes |
|---|---|
| `principal`, `agent` | Required |
| `maxPerTrade`, `dailyLimit` | USD |
| `expiryMs` | Defaults to 7 days from now |
| `allowSells` | `false` by default |
| `symbols` | Omit for any symbol |

To revoke a mandate: `DELETE /mandates/us-1/agent-7`.

### Halts

```bash
curl -s -X POST localhost:8787/halts -H 'content-type: application/json' \
  -d '{"symbol":"TSLA","halted":true,"reason":"LULD"}'
# → {"ok": true}; every venue now refuses TSLA with "symbol halted"
```

Send `"halted": false` to resume.

### Reports

```bash
curl -s localhost:8787/reports/cat.csv
```

```csv
orderID,symbol,side,accountHolderType,handlingInstructions,session,eventType,eventTimestamp,quantity,price,reason
API-2,AAPL,B,I,ALGO,REGULAR,MENO,2026-10-26T14:30:00.000Z,40,,
API-2,AAPL,B,I,ALGO,REGULAR,MEOJ,2026-10-26T14:30:00.000Z,40,,PerTradeLimit: $10400.00 > $5000
```

`/reports/caps` returns one line per TSV and symbol:

```json
{ "venueId": "venue-a", "tier": 1, "symbol": "AAPL", "cap": 9000, "used": 0, "remaining": 9000,
  "utilisationPct": 0, "projectedExhaustionDay": null, "status": "OK" }
```

### Audit

```bash
curl -s localhost:8787/audit/head     # {"head": "0xdc1b…2024", "entries": 5}
curl -s localhost:8787/audit/verify   # {"ok": true}
```

If any entry had been altered, `/audit/verify` would return `{"ok": false, "brokenAt": n, "reason": "..."}`.

## Integration notes for brokers

- **Quote, then order.** Show the customer the plan, including skipped venues and the comparison with the best single venue, then submit.
- **Use the reasons.** Every refusal carries a reason you can show the customer as-is.
- **Halts.** In production, Fletchery would take the exchange halt feed directly. The `/halts` endpoint exists so the flow can be tested.
- **Agents.** Register mandates with the engine when the customer sets up the agent. The customer's wallet also signs `AgentMandates.setMandate` on-chain, which is what enforces the limits at fill time. Revoking should hit both.
