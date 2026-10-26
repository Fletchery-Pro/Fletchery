// A simulated trading week (Mon 26 Oct – Mon 2 Nov 2026) through the Fletchery engine.
// Every number is SIMULATED and illustrative. The point is to exercise each module against the
// situations brokers and the new SEC venues will face:
//   Mon  token-delivery orders split across TSVs; Venue B whitelists the Fletchery router
//   Tue  a TSLA limit-up/limit-down halt is mirrored everywhere
//   Wed  AI agents trade under customer mandates; over-limit orders are refused with reasons
//   Thu  NVDA runs into Tier 1 monthly caps late in the month; flow spills to other venues
//   Sat  a thin offshore AMC print spikes +40% (a classic thin-market glitch); Weekend
//        Guard ignores it and bands stop the US pools following it
//   Sun  index futures reopen −1.8%; fair value and bands re-centre before Monday
// Outputs go to engine/out/: scenario.json (for the dashboard), CAT CSV, best-ex, caps, audit log.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fletchery } from '../src/fletchery.ts';
import { defaultVenues, poolPrice, US } from '../src/execution/venues.ts';
import type { Order } from '../src/execution/router.ts';
import type { ReferenceData } from '../src/safety/fairValue.ts';
import { SESSION_NAME, sessionAt, Session } from '../src/market/session.ts';
import { toCsv } from '../src/compliance/reports.ts';
import { AuditLog } from '../src/proof/auditLog.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
mkdirSync(OUT, { recursive: true });

// deterministic PRNG so every run tells the same story
let seed = 0x5eed2026;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

const PRICES: Record<string, number> = { AAPL: 260, NVDA: 185, TSLA: 430, AMC: 3.2 };
const VOL: Record<string, number> = { AAPL: 0.24, NVDA: 0.45, TSLA: 0.6, AMC: 0.9 };
const BETA: Record<string, number> = { AAPL: 1.1, NVDA: 1.7, TSLA: 2.0, AMC: 1.4 };
const ADV: Record<string, number> = { AAPL: 50_000_000, NVDA: 180_000_000, TSLA: 90_000_000, AMC: 25_000_000 }; // prior-month consolidated ADV in shares (illustrative)

const refs: ReferenceData[] = Object.keys(PRICES).map((s) => ({
  symbol: s,
  lastClose: PRICES[s],
  nbboMid: PRICES[s],
  annualVol: VOL[s],
  beta: BETA[s],
  observations: [],
}));

const venues = defaultVenues(PRICES, { adv: ADV, capUsed: { AAPL: 0.55, NVDA: 0.9965, TSLA: 0.6, AMC: 0.2 } });
// AMC is a thin name: shrink its pools
for (const v of venues) {
  const p = v.pools.AMC;
  if (p && v.kind !== 'PRIMARY') {
    p.stock /= 80;
    p.cash /= 80;
  }
}
const c = new Fletchery(refs, venues);

const ET = (s: string) => Date.parse(s);
const timeline: { ts: number; kind: string; title: string; detail: string }[] = [];
const event = (ts: number, kind: string, title: string, detail: string) => {
  timeline.push({ ts, kind, title, detail });
  c.log.append('EVENT', { kind, title }, ts);
};

// price paths (primary-market mid), a gentle random walk during regular hours
const mid: Record<string, number> = { ...PRICES };
function stepPrices(ts: number) {
  const s = sessionAt(ts);
  for (const sym of Object.keys(mid)) {
    if (s === Session.REGULAR || s === Session.EXTENDED) {
      const dt = 15 / (60 * 24 * 365);
      mid[sym] *= Math.exp(VOL[sym] * Math.sqrt(dt) * (rand() * 2 - 1) * 1.6);
      c.refs.get(sym)!.nbboMid = mid[sym];
      if (s === Session.REGULAR) c.refs.get(sym)!.lastClose = mid[sym];
    } else {
      c.refs.get(sym)!.nbboMid = undefined;
    }
  }
}

// keeps on-chain pools near fair value, like real arbitrageurs, bounded by venue bands
function arbitrage(ts: number) {
  for (const sym of Object.keys(mid)) {
    const fv = c.fairValue(sym, ts);
    for (const v of c.venues) {
      if (!v.pools[sym]) continue;
      const p = v.pools[sym];
      const k = p.stock * p.cash;
      // the primary market always sits at the NBBO; on-chain pools converge partially
      const target = v.kind === 'PRIMARY' ? fv.price : poolPrice(p) + (fv.price - poolPrice(p)) * 0.6;
      p.cash = Math.sqrt(k * target);
      p.stock = k / p.cash;
    }
  }
}

let n = 0;
const samples: Record<string, { ts: number; fv: number; lo: number; hi: number; session: string; venues: Record<string, number> }[]> =
  Object.fromEntries(Object.keys(PRICES).map((s) => [s, []]));
function sample(ts: number) {
  for (const sym of Object.keys(PRICES)) {
    const fv = c.fairValue(sym, ts);
    samples[sym].push({
      ts,
      fv: +fv.price.toFixed(4),
      lo: +fv.lowBand.toFixed(4),
      hi: +fv.highBand.toFixed(4),
      session: SESSION_NAME[fv.session],
      venues: Object.fromEntries(c.venues.filter((v) => v.kind !== 'PRIMARY').map((v) => [v.id, +poolPrice(v.pools[sym]).toFixed(4)])),
    });
  }
}

function retail(ts: number) {
  const sym = pick(['AAPL', 'AAPL', 'AAPL', 'NVDA', 'NVDA', 'NVDA', 'TSLA', 'TSLA', 'AMC']);
  const uk = rand() < 0.25;
  const notional = 200 + rand() * 4800;
  const o: Order = {
    id: `R${++n}`,
    account: `${uk ? 'uk' : 'us'}-${Math.floor(rand() * 900 + 100)}`,
    jurisdiction: uk ? 826 : US,
    symbol: sym,
    side: rand() < 0.55 ? 'BUY' : 'SELL',
    shares: notional / mid[sym],
    delivery: rand() < 0.6 ? 'TOKEN' : 'ANY',
    tsMs: ts,
  };
  return c.submit(o);
}

const anchors: { ts: number; head: string; fromSeq: number; toSeq: number }[] = [];

// ─────────────────────────── run the week ───────────────────────────
const START = ET('2026-10-26T04:00:00-04:00');
const END = ET('2026-11-02T10:00:00-05:00');
const STEP = 15 * 60_000;
const big: Record<string, unknown> = {};

for (let ts = START; ts <= END; ts += STEP) {
  stepPrices(ts);
  arbitrage(ts);
  const s = sessionAt(ts);
  const iso = new Date(ts).toISOString();

  // background flow: busier in regular hours, still alive 24/7 on-chain
  const rate = s === Session.REGULAR ? 3 : s === Session.EXTENDED ? 1.2 : s === Session.OVERNIGHT ? 0.6 : 0.4;
  let k = rate;
  while (k > 0) {
    if (rand() < Math.min(1, k)) retail(ts);
    k -= 1;
  }

  // ── scripted moments ──
  if (iso === '2026-10-26T14:15:00.000Z') {
    const r = c.submit({ id: 'BLOCK-1', account: 'us-family-office', jurisdiction: US, symbol: 'AAPL', side: 'BUY', shares: 4_000, delivery: 'TOKEN', tsMs: ts });
    big.block1 = r.record.plan;
    event(ts, 'route', 'Token-delivery block split across venues', `4,000 AAPL for wallet delivery: ${r.record.plan.legs.map((l) => `${l.venueId} ${l.shares.toFixed(0)}`).join(', ')}. ${r.record.plan.improvementVsSingleBps !== undefined ? `${r.record.plan.improvementVsSingleBps.toFixed(1)} bps better than the best single venue` : `filled ${r.record.plan.filled.toFixed(0)}; the best single venue could fill only ${r.record.plan.bestSingleVenue?.filled.toFixed(0) ?? 0}`}.`);
  }
  if (iso === '2026-10-26T15:00:00.000Z') {
    c.setWhitelisted('venue-b', true, ts);
    event(ts, 'access', 'Venue B whitelists the Fletchery router', 'Venue B only accepts routers it has approved. Once approved, Fletchery customers reach its liquidity with no new integration.');
    const r = c.submit({ id: 'BLOCK-2', account: 'us-family-office', jurisdiction: US, symbol: 'AAPL', side: 'BUY', shares: 4_000, delivery: 'TOKEN', tsMs: ts });
    big.block2 = r.record.plan;
    event(ts, 'route', 'Same block after Venue B joins', `Now ${r.record.plan.legs.length} venues: avg ${r.record.plan.avgPrice.toFixed(2)} vs fair value ${r.record.plan.fairValue.toFixed(2)} (${r.record.plan.slippageVsFairBps.toFixed(1)} bps).`);
  }
  if (iso === '2026-10-27T17:15:00.000Z') {
    c.setHalt('TSLA', true, 'LULD', ts);
    event(ts, 'halt', 'TSLA limit-up/limit-down pause mirrored', 'Primary listing pauses TSLA. Fletchery sets the halt on every venue at once, so no pool keeps trading a stock the exchange has stopped.');
    const r = c.submit({ id: 'HALT-TEST', account: 'us-204', jurisdiction: US, symbol: 'TSLA', side: 'BUY', shares: 10, delivery: 'TOKEN', tsMs: ts });
    event(ts, 'reject', 'Order during halt refused with a reason', r.record.rejectReason ?? '');
  }
  if (iso === '2026-10-27T17:30:00.000Z') {
    c.setHalt('TSLA', false, 'resume', ts);
    event(ts, 'halt', 'TSLA resumes', 'Halt lifted everywhere at once.');
  }
  if (iso === '2026-10-28T13:45:00.000Z') {
    c.mandates.set({ principal: 'us-alice', agent: 'copilot-agent', maxPerTrade: 5_000, dailyLimit: 20_000, expiryMs: ts + 7 * 86_400_000, allowSells: false, symbols: new Set(['AAPL', 'NVDA']) });
    event(ts, 'agent', 'Customer gives an AI agent a mandate', '$5,000 per trade, $20,000 per day, buys only, AAPL and NVDA only, 7 days.');
  }
  if (ts >= ET('2026-10-28T10:00:00-04:00') && ts <= ET('2026-10-28T15:30:00-04:00') && new Date(ts).getUTCMinutes() === 0) {
    const sym = pick(['AAPL', 'NVDA']);
    const shares = (3_000 + rand() * 1_800) / mid[sym];
    const r = c.submit({ id: `AG${++n}`, account: 'us-alice', agent: 'copilot-agent', jurisdiction: US, symbol: sym, side: 'BUY', shares, delivery: 'TOKEN', tsMs: ts });
    if (r.record.status === 'REJECTED') event(ts, 'agent', 'Agent order refused', r.record.rejectReason ?? '');
  }
  if (iso === '2026-10-28T18:15:00.000Z') {
    const r = c.submit({ id: 'AG-OVER', account: 'us-alice', agent: 'copilot-agent', jurisdiction: US, symbol: 'AAPL', side: 'BUY', shares: 8_000 / mid.AAPL, tsMs: ts });
    event(ts, 'agent', 'Agent tries an $8,000 order', r.record.rejectReason ?? 'filled');
    const r2 = c.submit({ id: 'AG-TSLA', account: 'us-alice', agent: 'copilot-agent', jurisdiction: US, symbol: 'TSLA', side: 'BUY', shares: 2, tsMs: ts });
    event(ts, 'agent', 'Agent tries a symbol outside its mandate', r2.record.rejectReason ?? 'filled');
  }
  if (iso === '2026-10-29T14:00:00.000Z') {
    const caps = c.venues.filter((v) => v.capTier).map((v) => `${v.id} ${Math.max(0, v.capRemaining.NVDA).toFixed(0)}`).join(', ');
    const r = c.submit({ id: 'CAP-1', account: 'us-fund', jurisdiction: US, symbol: 'NVDA', side: 'BUY', shares: 3_000, delivery: 'TOKEN', tsMs: ts });
    big.cap1 = r.record.plan;
    event(ts, 'cap', 'NVDA meets late-month Tier 1 caps', `Headroom before: ${caps} shares. Order filled ${r.record.plan.filled.toFixed(0)} of 3,000 without breaching any venue cap${r.record.plan.unfilled > 1 ? `; ${r.record.plan.unfilled.toFixed(0)} left for the primary market or next month` : ''}.`);
  }
  if (iso === '2026-10-31T16:00:00.000Z') {
    c.updateReference('AMC', { observations: [{ venue: 'thin-offshore-pool', price: mid.AMC * 1.4, depthUsd: 6_000 }] }, ts);
    const fv = c.fairValue('AMC', ts);
    event(ts, 'guard', 'Thin offshore AMC print spikes +40%', `Weekend Guard rejects it (${[...new Set(fv.rejectedObservations.filter((r) => r.venue === 'thin-offshore-pool').map((r) => r.reason))].join(', ')}). Fair value stays ${fv.price.toFixed(3)}; band ${fv.lowBand.toFixed(3)}–${fv.highBand.toFixed(3)}.`);
    const r = c.submit({ id: 'FOMO-1', account: 'us-777', jurisdiction: US, symbol: 'AMC', side: 'BUY', shares: 400_000, delivery: 'TOKEN', tsMs: ts });
    big.fomo = r.record.plan;
    const atBand = r.record.plan.legs.every((l) => l.postPrice >= fv.highBand * 0.99);
    event(ts, 'guard', atBand ? 'Panic buy stopped at the band' : 'Panic buy limited by venue caps', `A $${(400_000 * mid.AMC).toLocaleString('en-US', { maximumFractionDigits: 0 })} market buy fills ${r.record.plan.filled.toFixed(0)} shares at avg ${r.record.plan.avgPrice.toFixed(3)}, then stops: ${atBand ? `every pool reached the top of the fair-value band (${fv.highBand.toFixed(3)}), so nobody pays the bad print's ${(mid.AMC * 1.4).toFixed(2)}` : 'monthly caps are used up'}. The rest stays unfilled rather than chasing the price.`);
  }
  if (iso === '2026-11-01T23:00:00.000Z') {
    for (const sym of Object.keys(PRICES)) c.updateReference(sym, { futuresReturnSinceClose: -0.018 }, ts);
    c.updateReference('AMC', { observations: [] }, ts);
    const fv = c.fairValue('NVDA', ts);
    event(ts, 'guard', 'Futures reopen −1.8%', `Fair values move by beta before Monday (NVDA ${fv.price.toFixed(2)}, β 1.7); overnight band ±${((fv.highBand / fv.price - 1) * 100).toFixed(1)}%.`);
  }

  if (new Date(ts).getUTCMinutes() === 0) sample(ts);
  // daily on-chain anchor at 21:00 ET
  if (new Date(ts).getUTCHours() === 1 && new Date(ts).getUTCMinutes() === 0) {
    const a = c.nextAnchor();
    if (a) anchors.push({ ts, ...a });
  }
}

const finalAnchor = c.nextAnchor();
if (finalAnchor) anchors.push({ ts: END, ...finalAnchor });

// ─────────────────────────── outputs ───────────────────────────
const reports = c.reports(29, 31);
const verify = AuditLog.verify(c.log.entries);
writeFileSync(join(OUT, 'cat_events.csv'), toCsv(reports.cat));
writeFileSync(join(OUT, 'best_execution.json'), JSON.stringify(reports.bestEx, null, 2));
writeFileSync(join(OUT, 'cap_report.csv'), toCsv(reports.caps));
writeFileSync(join(OUT, 'audit_log.jsonl'), c.log.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

const orders = c.records.map((r) => ({
  id: r.order.id,
  ts: r.order.tsMs,
  account: r.order.account,
  agent: r.order.agent ?? null,
  jurisdiction: r.order.jurisdiction,
  symbol: r.order.symbol,
  side: r.order.side,
  shares: +r.order.shares.toFixed(4),
  delivery: r.order.delivery ?? 'ANY',
  status: r.status,
  reason: r.rejectReason ?? null,
  filled: +r.plan.filled.toFixed(4),
  avgPrice: +r.plan.avgPrice.toFixed(4),
  fairValue: +r.plan.fairValue.toFixed(4),
  slippageBps: +r.plan.slippageVsFairBps.toFixed(2),
  improvementBps: r.plan.improvementVsSingleBps !== undefined ? +r.plan.improvementVsSingleBps.toFixed(2) : null,
  session: SESSION_NAME[r.plan.session],
  legs: r.plan.legs.map((l) => ({ venue: l.venueId, shares: +l.shares.toFixed(4), avgPrice: +l.avgPrice.toFixed(4) })),
}));

const scenario = {
  generatedAt: new Date().toISOString(),
  disclaimer: 'Simulated data. Venue names reflect public filings; all prices, depths, caps and flows are illustrative.',
  window: { start: START, end: END },
  venues: c.venues.map((v) => ({ id: v.id, name: v.name, operator: v.operator, chain: v.chain, kind: v.kind, tier: v.capTier ?? null, feeBps: v.feeBps, mevProtected: v.mevProtected, whitelisted: v.fletcheryWhitelisted })),
  timeline,
  samples,
  orders,
  bestEx: reports.bestEx,
  caps: reports.caps,
  audit: { entries: c.log.entries.length, head: c.log.head(), verified: verify.ok, anchors },
  highlights: big,
};
writeFileSync(join(OUT, 'scenario.json'), JSON.stringify(scenario));

// ─────────────────────────── narrative ───────────────────────────
const fmt = (ts: number) => new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit' });
console.log('\nFletchery — simulated week, 26 Oct – 2 Nov 2026 (illustrative data)\n');
for (const e of timeline) console.log(`${fmt(e.ts).padEnd(14)} [${e.kind}] ${e.title}\n${' '.repeat(16)}${e.detail}`);
const be = reports.bestEx;
console.log(`\nOrders: ${be.orders}  filled ${be.filled}  partial ${be.partial}  rejected ${be.rejected}`);
console.log(`Avg slippage vs fair value: ${be.avgSlippageVsFairBps} bps; avg improvement vs best single venue: ${be.avgImprovementVsBestSingleVenueBps} bps`);
console.log('Venue share:', be.venues.map((v) => `${v.venueId} ${v.shareOfVolumePct}%`).join(', '));
console.log(`Cap lines on WATCH/EXHAUSTED: ${reports.caps.filter((l) => l.status !== 'OK').map((l) => `${l.venueId}:${l.symbol}=${l.status}`).join(', ') || 'none'}`);
console.log(`Audit log: ${c.log.entries.length} entries, chain ${verify.ok ? 'verified' : 'BROKEN'}, ${anchors.length} daily anchors, head ${c.log.head().slice(0, 18)}…`);
console.log(`\nFiles written to ${OUT}`);
