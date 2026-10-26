// Compliance outputs (Fletchery · Compliance module).
//   catEvents      CAT-style order lifecycle events (new order → route → fill). A simplified
//                  field set modelled on the CAT Industry Member spec, not the official schema.
//   bestExecution  Rule 605/606-style venue quality summary vs. fair value.
//   capReport      Monthly cap utilisation per TSV and symbol, with a run-rate forecast.

import type { Order, RoutePlan } from '../execution/router.ts';
import type { Venue } from '../execution/venues.ts';
import { SESSION_NAME } from '../market/session.ts';

export interface OrderRecord {
  order: Order;
  plan: RoutePlan;
  status: 'FILLED' | 'PARTIAL' | 'REJECTED';
  rejectReason?: string;
}

export interface CatEvent {
  eventType: 'MENO' | 'MEOR' | 'MEOF' | 'MEOJ'; // new order, route, fill, rejection
  eventTimestamp: string;
  orderID: string;
  symbol: string;
  side: 'B' | 'SL';
  quantity: number;
  price?: number;
  destination?: string;
  accountHolderType: 'I' | 'A'; // individual / institutional
  handlingInstructions?: string; // 'ALGO' when an AI agent placed the order
  session: string;
  reason?: string;
}

export function catEvents(records: OrderRecord[]): CatEvent[] {
  const out: CatEvent[] = [];
  for (const r of records) {
    const ts = new Date(r.order.tsMs).toISOString();
    const base = {
      orderID: r.order.id,
      symbol: r.order.symbol,
      side: (r.order.side === 'BUY' ? 'B' : 'SL') as 'B' | 'SL',
      accountHolderType: 'I' as const,
      handlingInstructions: r.order.agent ? 'ALGO' : undefined,
      session: SESSION_NAME[r.plan.session],
    };
    out.push({ ...base, eventType: 'MENO', eventTimestamp: ts, quantity: r.order.shares, price: r.order.limitPrice });
    if (r.status === 'REJECTED') {
      out.push({ ...base, eventType: 'MEOJ', eventTimestamp: ts, quantity: r.order.shares, reason: r.rejectReason });
      continue;
    }
    for (const leg of r.plan.legs) {
      out.push({ ...base, eventType: 'MEOR', eventTimestamp: ts, quantity: round(leg.shares, 6), destination: leg.venueId });
      out.push({
        ...base,
        eventType: 'MEOF',
        eventTimestamp: ts,
        quantity: round(leg.shares, 6),
        price: round(leg.avgPrice, 4),
        destination: leg.venueId,
      });
    }
  }
  return out;
}

export function toCsv(rows: object[]): string {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc((r as Record<string, unknown>)[c])).join(','))].join('\n') + '\n';
}

export interface VenueQuality {
  venueId: string;
  legs: number;
  shares: number;
  notional: number;
  shareOfVolumePct: number; // by notional
  avgVsFairBps: number; // notional-weighted, positive = worse for the customer
}

export interface BestExReport {
  orders: number;
  filled: number;
  partial: number;
  rejected: number;
  avgSlippageVsFairBps: number;
  avgImprovementVsBestSingleVenueBps: number | null;
  venues: VenueQuality[];
  rejectionReasons: Record<string, number>;
}

export function bestExecution(records: OrderRecord[]): BestExReport {
  const vq = new Map<string, { legs: number; shares: number; notional: number; wSlip: number }>();
  const reasons: Record<string, number> = {};
  let slipSum = 0;
  let slipN = 0;
  let impSum = 0;
  let impN = 0;
  for (const r of records) {
    for (const rej of r.plan.rejected) reasons[rej.reason] = (reasons[rej.reason] ?? 0) + 1;
    if (r.status === 'REJECTED') continue;
    slipSum += r.plan.slippageVsFairBps;
    slipN++;
    if (r.plan.improvementVsSingleBps !== undefined) {
      impSum += r.plan.improvementVsSingleBps;
      impN++;
    }
    const sign = r.order.side === 'BUY' ? 1 : -1;
    for (const l of r.plan.legs) {
      const q = vq.get(l.venueId) ?? { legs: 0, shares: 0, notional: 0, wSlip: 0 };
      q.legs++;
      q.shares += l.shares;
      q.notional += l.cash;
      // weight by notional, so a cheap stock's large share counts don't dominate
      q.wSlip += l.cash * ((sign * (l.avgPrice - r.plan.fairValue)) / r.plan.fairValue) * 10_000;
      vq.set(l.venueId, q);
    }
  }
  const totalNotional = [...vq.values()].reduce((a, q) => a + q.notional, 0) || 1;
  return {
    orders: records.length,
    filled: records.filter((r) => r.status === 'FILLED').length,
    partial: records.filter((r) => r.status === 'PARTIAL').length,
    rejected: records.filter((r) => r.status === 'REJECTED').length,
    avgSlippageVsFairBps: slipN ? round(slipSum / slipN, 2) : 0,
    avgImprovementVsBestSingleVenueBps: impN ? round(impSum / impN, 2) : null,
    venues: [...vq.entries()]
      .map(([venueId, q]) => ({
        venueId,
        legs: q.legs,
        shares: round(q.shares, 4),
        notional: round(q.notional, 2),
        shareOfVolumePct: round((q.notional / totalNotional) * 100, 2),
        avgVsFairBps: round(q.wSlip / q.notional, 2),
      }))
      .sort((a, b) => b.notional - a.notional),
    rejectionReasons: reasons,
  };
}

export interface CapLine {
  venueId: string;
  tier: number;
  symbol: string;
  cap: number;
  used: number;
  remaining: number;
  utilisationPct: number;
  projectedExhaustionDay: number | null; // day of month at current run-rate
  status: 'OK' | 'WATCH' | 'EXHAUSTED';
}

/** `startingCaps` = cap at the start of the month; `dayOfMonth`/`daysInMonth` for the run-rate. */
export function capReport(
  venues: Venue[],
  startingCaps: Record<string, Record<string, number>>,
  dayOfMonth: number,
  daysInMonth: number,
): CapLine[] {
  const out: CapLine[] = [];
  for (const v of venues) {
    if (!v.capTier) continue;
    for (const symbol of Object.keys(v.pools)) {
      const cap = startingCaps[v.id]?.[symbol] ?? 0;
      const remaining = Math.max(0, v.capRemaining[symbol] ?? 0);
      const used = cap - remaining;
      const util = cap ? (used / cap) * 100 : 0;
      const rate = used / Math.max(dayOfMonth, 1);
      const proj = rate > 0 ? Math.ceil(cap / rate) : null;
      out.push({
        venueId: v.id,
        tier: v.capTier,
        symbol,
        cap,
        used: round(used, 4),
        remaining: round(remaining, 4),
        utilisationPct: round(util, 2),
        projectedExhaustionDay: proj !== null && proj <= daysInMonth ? proj : null,
        status: remaining <= 0 ? 'EXHAUSTED' : proj !== null && proj <= daysInMonth ? 'WATCH' : 'OK',
      });
    }
  }
  return out;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
