// The Fletchery engine: one object a broker integrates with.
// quote → (mandate check) → route → execute → record → audit log → reports → on-chain anchor.

import { type Venue, defaultVenues, poolPrice } from './execution/venues.ts';
import { type Order, type RoutePlan, route, execute } from './execution/router.ts';
import { type ReferenceData, type FairValue, computeFairValue } from './safety/fairValue.ts';
import { MandateBook } from './access/mandates.ts';
import { AuditLog } from './proof/auditLog.ts';
import { type OrderRecord, catEvents, bestExecution, capReport } from './compliance/reports.ts';

export interface SubmitResult {
  record: OrderRecord;
  fairValue: FairValue;
}

export class Fletchery {
  venues: Venue[];
  readonly startingCaps: Record<string, Record<string, number>>;
  readonly refs = new Map<string, ReferenceData>();
  readonly mandates = new MandateBook();
  readonly log = new AuditLog();
  readonly records: OrderRecord[] = [];
  private lastAnchoredSeq = -1;

  constructor(refs: ReferenceData[], venues?: Venue[]) {
    for (const r of refs) this.refs.set(r.symbol, r);
    const prices = Object.fromEntries(refs.map((r) => [r.symbol, r.nbboMid ?? r.lastClose]));
    this.venues = venues ?? defaultVenues(prices);
    this.startingCaps = Object.fromEntries(this.venues.map((v) => [v.id, { ...v.capRemaining }]));
  }

  venue(id: string): Venue {
    const v = this.venues.find((x) => x.id === id);
    if (!v) throw new Error(`unknown venue ${id}`);
    return v;
  }

  updateReference(symbol: string, patch: Partial<ReferenceData>, ts = Date.now()): void {
    const r = this.refs.get(symbol);
    if (!r) throw new Error(`unknown symbol ${symbol}`);
    Object.assign(r, patch);
    this.log.append('REFERENCE', { symbol, ...patch }, ts);
  }

  fairValue(symbol: string, ts: number): FairValue {
    const ref = this.refs.get(symbol);
    if (!ref) throw new Error(`unknown symbol ${symbol}`);
    // live venue prices feed the estimate (TSV + offshore pools)
    const observations = [
      ...ref.observations,
      ...this.venues
        .filter((v) => v.kind !== 'PRIMARY' && v.pools[symbol])
        .map((v) => ({ venue: v.id, price: poolPrice(v.pools[symbol]), depthUsd: v.pools[symbol].cash * 0.04 })),
    ];
    return computeFairValue({ ...ref, observations }, ts);
  }

  quote(order: Order): { plan: RoutePlan; fairValue: FairValue } {
    const fv = this.fairValue(order.symbol, order.tsMs);
    const plan = route(order, this.venues, fv);
    this.log.append('QUOTE', { orderId: order.id, symbol: order.symbol, side: order.side, shares: order.shares, legs: plan.legs, fv: fv.price }, order.tsMs);
    return { plan, fairValue: fv };
  }

  submit(order: Order): SubmitResult {
    const fv = this.fairValue(order.symbol, order.tsMs);
    this.log.append('ORDER', order, order.tsMs);

    if (order.agent) {
      const notional = order.shares * fv.price;
      const chk = this.mandates.check(order.account, order.agent, order.symbol, order.side === 'SELL', notional, order.tsMs);
      if (!chk.ok) return this.reject(order, fv, chk.reason);
    }

    const plan = route(order, this.venues, fv);
    if (plan.filled <= 1e-9) {
      const reasons = [...new Set(plan.rejected.map((r) => r.reason))].join('; ');
      return this.reject(order, fv, `no eligible venue: ${reasons}`, plan);
    }
    execute(plan, this.venues);
    if (order.agent) this.mandates.consume(order.account, order.agent, plan.totalCash, order.tsMs);

    const record: OrderRecord = {
      order,
      plan,
      status: plan.unfilled > 1e-6 ? 'PARTIAL' : 'FILLED',
    };
    this.records.push(record);
    this.log.append('FILL', { orderId: order.id, status: record.status, legs: plan.legs, avgPrice: plan.avgPrice, fv: fv.price, slippageBps: plan.slippageVsFairBps }, order.tsMs);
    return { record, fairValue: fv };
  }

  private reject(order: Order, fv: FairValue, reason: string, plan?: RoutePlan): SubmitResult {
    const p: RoutePlan = plan ?? {
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      requested: order.shares,
      filled: 0,
      unfilled: order.shares,
      legs: [],
      avgPrice: 0,
      totalCash: 0,
      fairValue: fv.price,
      slippageVsFairBps: 0,
      rejected: [],
      session: fv.session,
    };
    const record: OrderRecord = { order, plan: p, status: 'REJECTED', rejectReason: reason };
    this.records.push(record);
    this.log.append('REJECT', { orderId: order.id, reason }, order.tsMs);
    return { record, fairValue: fv };
  }

  setHalt(symbol: string, halted: boolean, reason: string, ts = Date.now()): void {
    for (const v of this.venues) halted ? v.halted.add(symbol) : v.halted.delete(symbol);
    this.log.append('HALT', { symbol, halted, reason }, ts);
  }

  setWhitelisted(venueId: string, ok: boolean, ts = Date.now()): void {
    this.venue(venueId).fletcheryWhitelisted = ok;
    this.log.append('WHITELIST', { venueId, ok }, ts);
  }

  reports(dayOfMonth: number, daysInMonth: number) {
    return {
      cat: catEvents(this.records),
      bestEx: bestExecution(this.records),
      caps: capReport(this.venues, this.startingCaps, dayOfMonth, daysInMonth),
    };
  }

  /** Batch to anchor on-chain: everything since the previous anchor. */
  nextAnchor(): { head: string; fromSeq: number; toSeq: number } | null {
    const toSeq = this.log.entries.length - 1;
    if (toSeq <= this.lastAnchoredSeq) return null;
    const batch = { head: this.log.head(), fromSeq: this.lastAnchoredSeq + 1, toSeq };
    this.lastAnchoredSeq = toSeq;
    return batch;
  }
}
