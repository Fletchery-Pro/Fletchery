import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, sessionAt, hoursSinceLastClose } from '../src/market/session.ts';
import { computeFairValue, type ReferenceData } from '../src/safety/fairValue.ts';
import { defaultVenues, US, type Venue } from '../src/execution/venues.ts';
import { route, execute, type Order } from '../src/execution/router.ts';
import { MandateBook } from '../src/access/mandates.ts';
import { AuditLog } from '../src/proof/auditLog.ts';
import { Fletchery } from '../src/fletchery.ts';

const ET = (iso: string) => Date.parse(iso); // pass explicit offsets
const MON_1030 = ET('2026-10-26T10:30:00-04:00');
const SAT_NOON = ET('2026-10-31T12:00:00-04:00');
const UK = 826;

const ref = (over: Partial<ReferenceData> = {}): ReferenceData => ({
  symbol: 'AAPL',
  lastClose: 200,
  nbboMid: 200,
  annualVol: 0.28,
  beta: 1.1,
  observations: [],
  ...over,
});

const order = (o: Partial<Order>): Order => ({
  id: 'o1',
  account: 'alice',
  jurisdiction: US,
  symbol: 'AAPL',
  side: 'BUY',
  shares: 100,
  tsMs: MON_1030,
  ...o,
});

// ───────── sessions ─────────

test('sessions follow the New York clock, including DST and holidays', () => {
  assert.equal(sessionAt(MON_1030), Session.REGULAR);
  assert.equal(sessionAt(ET('2026-10-26T08:00:00-04:00')), Session.EXTENDED);
  assert.equal(sessionAt(ET('2026-10-26T17:30:00-04:00')), Session.EXTENDED);
  assert.equal(sessionAt(ET('2026-10-26T22:00:00-04:00')), Session.OVERNIGHT);
  assert.equal(sessionAt(ET('2026-10-27T02:00:00-04:00')), Session.OVERNIGHT);
  assert.equal(sessionAt(SAT_NOON), Session.CLOSED);
  assert.equal(sessionAt(ET('2026-10-30T21:00:00-04:00')), Session.CLOSED); // Friday night
  assert.equal(sessionAt(ET('2026-11-01T20:30:00-05:00')), Session.OVERNIGHT); // Sunday 8:30pm (after DST ends)
  assert.equal(sessionAt(ET('2026-11-26T11:00:00-05:00')), Session.CLOSED); // Thanksgiving
  assert.equal(sessionAt(ET('2026-11-27T13:30:00-05:00')), Session.EXTENDED); // early close day
  assert.equal(sessionAt(ET('2026-11-25T21:00:00-05:00')), Session.CLOSED); // eve of Thanksgiving
});

test('hours since close counts across the weekend', () => {
  assert.equal(hoursSinceLastClose(MON_1030), 0);
  const h = hoursSinceLastClose(SAT_NOON);
  assert.ok(Math.abs(h - 20) < 0.01, `expected 20h (Fri 4pm → Sat noon), got ${h}`);
  assert.ok(Math.abs(hoursSinceLastClose(ET('2026-11-02T09:00:00-05:00')) - 66) < 0.01, 'Fri 4pm EDT → Mon 9am EST');
});

// ───────── fair value ─────────

test('regular hours: fair value is the NBBO mid with a tight band', () => {
  const fv = computeFairValue(ref(), MON_1030);
  assert.ok(Math.abs(fv.price - 200) < 0.01);
  assert.ok(fv.confidenceBps < 20);
  assert.equal(fv.session, Session.REGULAR);
});

test('weekend: one thin or manipulated offshore print cannot drag fair value', () => {
  const fv = computeFairValue(
    ref({
      nbboMid: undefined,
      observations: [
        { venue: 'eu-pool', price: 201, depthUsd: 2_000_000 },
        { venue: 'kraken-x', price: 200.6, depthUsd: 1_000_000 },
        { venue: 'thin-pool', price: 260, depthUsd: 5_000 }, // the AMC-style print
      ],
    }),
    SAT_NOON,
  );
  assert.equal(fv.session, Session.CLOSED);
  assert.ok(fv.price > 199 && fv.price < 202, `fv ${fv.price}`);
  assert.ok(fv.rejectedObservations.some((r) => r.venue === 'thin-pool'));
  assert.ok(fv.highBand < 230, 'band excludes the dislocated print');
});

test('overnight: futures move the model by beta', () => {
  const fv = computeFairValue(ref({ nbboMid: undefined, futuresReturnSinceClose: -0.02 }), ET('2026-10-26T22:00:00-04:00'));
  assert.ok(Math.abs(fv.model - 200 * (1 - 0.022)) < 1e-9);
});

// ───────── router ─────────

const fvAt = (ts: number) => computeFairValue(ref(), ts);

test('splits a large order across venues and beats the best single venue', () => {
  const venues = defaultVenues({ AAPL: 200 });
  venues.find((v) => v.id === 'venue-b')!.fletcheryWhitelisted = true;
  const plan = route(order({ shares: 3_000, tsMs: SAT_NOON }), venues, computeFairValue(ref({ nbboMid: undefined }), SAT_NOON));
  assert.ok(plan.legs.length >= 2, 'multiple venues used');
  assert.ok(Math.abs(plan.filled - 3_000) < 1e-6);
  assert.ok((plan.improvementVsSingleBps ?? 0) > 0, `improvement ${plan.improvementVsSingleBps}`);
});

test('never routes past a venue cap', () => {
  const venues = defaultVenues({ AAPL: 200 });
  for (const v of venues) if (v.capTier) v.capRemaining.AAPL = 50;
  const plan = route(order({ shares: 1_000, tsMs: SAT_NOON }), venues, computeFairValue(ref({ nbboMid: undefined }), SAT_NOON));
  for (const l of plan.legs) {
    const v = venues.find((x) => x.id === l.venueId)!;
    assert.ok(l.shares <= 50 + 1e-9, `${v.id} got ${l.shares}`);
  }
  assert.ok(plan.unfilled > 0, 'weekend: primary closed, so caps bind');
});

test('respects jurisdiction: US clients never touch offshore tokens; UK clients never touch US TSVs', () => {
  const venues = defaultVenues({ AAPL: 200 });
  const us = route(order({ shares: 500, tsMs: SAT_NOON }), venues, fvAt(SAT_NOON));
  assert.ok(us.legs.every((l) => l.venueId !== 'offshore'));
  const uk = route(order({ jurisdiction: UK, shares: 500, tsMs: SAT_NOON }), venues, fvAt(SAT_NOON));
  assert.ok(uk.legs.every((l) => l.venueId === 'offshore'));
});

test('skips a venue that has not whitelisted the router, and says why', () => {
  const venues = defaultVenues({ AAPL: 200 });
  const plan = route(order({ shares: 100 }), venues, fvAt(MON_1030));
  assert.deepEqual(plan.rejected.find((r) => r.venueId === 'venue-b'), {
    venueId: 'venue-b',
    reason: 'router not whitelisted by venue',
  });
});

test('halts and limit prices are honoured', () => {
  const venues = defaultVenues({ AAPL: 200 });
  for (const v of venues) v.halted.add('AAPL');
  const halted = route(order({}), venues, fvAt(MON_1030));
  assert.equal(halted.filled, 0);

  const fresh = defaultVenues({ AAPL: 200 });
  const lim = route(order({ shares: 2_000, limitPrice: 200.05, tsMs: SAT_NOON }), fresh, fvAt(SAT_NOON));
  for (const l of lim.legs) assert.ok(l.avgPrice <= 200.05 + 1e-9);
});

test('execute moves pools and consumes caps', () => {
  const venues: Venue[] = defaultVenues({ AAPL: 200 });
  const fv = fvAt(SAT_NOON);
  const plan = route(order({ shares: 400, tsMs: SAT_NOON }), venues, fv);
  const before = Object.fromEntries(venues.map((v) => [v.id, v.capRemaining.AAPL]));
  execute(plan, venues);
  for (const l of plan.legs) {
    const v = venues.find((x) => x.id === l.venueId)!;
    assert.ok(Math.abs(before[v.id] - v.capRemaining.AAPL - l.shares) < 1e-9);
  }
});

// ───────── mandates ─────────

test('agent mandates enforce per-trade, daily, symbol and sell limits', () => {
  const m = new MandateBook();
  m.set({ principal: 'alice', agent: 'bot', maxPerTrade: 1000, dailyLimit: 1500, expiryMs: MON_1030 + 86_400_000, allowSells: false, symbols: new Set(['AAPL']) });
  assert.deepEqual(m.check('alice', 'bot', 'AAPL', false, 900, MON_1030), { ok: true });
  assert.equal(m.check('alice', 'bot', 'AAPL', false, 1100, MON_1030).ok, false);
  assert.equal(m.check('alice', 'bot', 'TSLA', false, 10, MON_1030).ok, false);
  assert.equal(m.check('alice', 'bot', 'AAPL', true, 10, MON_1030).ok, false);
  m.consume('alice', 'bot', 900, MON_1030);
  assert.equal(m.check('alice', 'bot', 'AAPL', false, 700, MON_1030).ok, false);
  assert.equal(m.check('alice', 'bot', 'AAPL', false, 700, MON_1030 + 86_400_000 - 1).ok, true, 'next UTC day resets');
  m.revoke('alice', 'bot');
  assert.equal(m.check('alice', 'bot', 'AAPL', false, 1, MON_1030).ok, false);
});

// ───────── audit log ─────────

test('audit log detects any edit, deletion or reordering', () => {
  const log = new AuditLog();
  for (let i = 0; i < 5; i++) log.append('FILL', { i, px: 200 + i }, 1000 + i);
  assert.deepEqual(AuditLog.verify(log.entries), { ok: true });

  const edited = structuredClone(log.entries);
  (edited[2].data as { px: number }).px = 999;
  assert.deepEqual(AuditLog.verify(edited), { ok: false, brokenAt: 2, reason: 'entry contents altered' });

  const deleted = structuredClone(log.entries);
  deleted.splice(1, 1);
  assert.equal(AuditLog.verify(deleted).ok, false);

  assert.ok(AuditLog.verifyAgainstAnchor(log.entries, log.entries[3].hash, 3));
});

// ───────── integration ─────────

test('Fletchery end to end: agent order, rejection with reason, reports, anchor', () => {
  const c = new Fletchery([ref()]);
  c.mandates.set({ principal: 'alice', agent: 'bot', maxPerTrade: 5_000, dailyLimit: 10_000, expiryMs: MON_1030 + 7 * 86_400_000, allowSells: false, symbols: 'ANY' });
  const ok = c.submit(order({ id: 'a1', agent: 'bot', shares: 20 }));
  assert.equal(ok.record.status, 'FILLED');
  const tooBig = c.submit(order({ id: 'a2', agent: 'bot', shares: 100 }));
  assert.equal(tooBig.record.status, 'REJECTED');
  assert.match(tooBig.record.rejectReason!, /PerTradeLimit/);

  const r = c.reports(26, 31);
  assert.ok(r.cat.some((e) => e.eventType === 'MEOF' && e.handlingInstructions === 'ALGO'));
  assert.ok(r.cat.some((e) => e.eventType === 'MEOJ'));
  assert.equal(r.bestEx.orders, 2);
  const a = c.nextAnchor()!;
  assert.equal(a.fromSeq, 0);
  assert.equal(a.head, c.log.head());
  assert.equal(c.nextAnchor(), null);
});
