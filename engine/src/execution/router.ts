// Cap-aware smart order router (Fletchery · Execution module).
//
// The problem: from Sept 2026 a US broker can reach several SEC Tokenized Securities Venues plus
// the primary market and (for non-US clients) offshore stock-token pools. Each TSV has a hard
// monthly volume cap (0.25% / 2.5% of prior-month ADV), its own whitelist, halts and a
// fair-value band. No single venue can absorb size, and routing blindly risks rejected orders.
//
// The router filters venues by eligibility, then fills the order in slices, each slice going to
// the venue with the best marginal all-in price (fees, half-spread, gas on first use), never
// exceeding a venue's cap headroom, the fair-value band or the client's limit price.

import {
  type Venue,
  costToBuy,
  proceedsToSell,
  poolPrice,
} from './venues.ts';
import { Session, sessionAt } from '../market/session.ts';
import type { FairValue } from '../safety/fairValue.ts';

export type Side = 'BUY' | 'SELL';

export interface Order {
  id: string;
  account: string;
  jurisdiction: number;
  symbol: string;
  side: Side;
  shares: number;
  limitPrice?: number;
  agent?: string; // set when an AI agent places the order for `account`
  /** TOKEN = customer wants the stock token delivered to their wallet, so on-chain venues only. */
  delivery?: 'TOKEN' | 'ANY';
  tsMs: number;
}

export interface Leg {
  venueId: string;
  shares: number;
  cash: number;
  avgPrice: number;
  postPrice: number;
}

export interface Rejection {
  venueId: string;
  reason: string;
}

export interface RoutePlan {
  orderId: string;
  symbol: string;
  side: Side;
  requested: number;
  filled: number;
  unfilled: number;
  legs: Leg[];
  avgPrice: number;
  totalCash: number;
  fairValue: number;
  slippageVsFairBps: number; // positive = worse than fair value
  bestSingleVenue?: { venueId: string; avgPrice: number; filled: number };
  improvementVsSingleBps?: number;
  rejected: Rejection[];
  session: Session;
}

const SLICES = 200;

export function eligibility(v: Venue, o: Order, fv: FairValue): string | null {
  const s = sessionAt(o.tsMs);
  if (!v.pools[o.symbol]) return 'symbol not listed';
  if (o.delivery === 'TOKEN' && v.kind === 'PRIMARY') return 'token delivery requested (on-chain only)';
  if (v.halted.has(o.symbol)) return 'symbol halted';
  if (!v.sessions.includes(s)) return 'venue closed this session';
  if (v.allowJurisdictions && !v.allowJurisdictions.includes(o.jurisdiction)) return 'jurisdiction not eligible';
  if (v.blockJurisdictions?.includes(o.jurisdiction)) return 'jurisdiction blocked';
  if (v.requiresWhitelist && !v.fletcheryWhitelisted) return 'router not whitelisted by venue';
  if ((v.capRemaining[o.symbol] ?? 0) <= 0) return 'monthly volume cap exhausted';
  const px = poolPrice(v.pools[o.symbol]);
  if (v.kind !== 'PRIMARY' && (px < fv.lowBand || px > fv.highBand)) {
    // still eligible if trading would move it toward fair value
    const helps = (o.side === 'BUY' && px < fv.lowBand) || (o.side === 'SELL' && px > fv.highBand);
    if (!helps) return 'pool price outside fair-value band';
  }
  return null;
}

function legCost(v: Venue, symbol: string, side: Side, shares: number): { cash: number; post: number } {
  const fee = v.feeBps + (v.spreadBps ?? 0) / 2;
  const p = v.pools[symbol];
  return side === 'BUY' ? costToBuy(p, shares, fee) : proceedsToSell(p, shares, fee);
}

function bandOk(v: Venue, side: Side, post: number, fv: FairValue, pre: number): boolean {
  if (v.kind === 'PRIMARY') return true;
  const outside = (x: number) => (x < fv.lowBand ? fv.lowBand - x : x > fv.highBand ? x - fv.highBand : 0);
  const dPost = outside(post);
  return dPost === 0 || dPost < outside(pre); // same rule as FletcheryHook
}

function greedyFill(order: Order, eligible: Venue[], fv: FairValue): Map<string, number> {
  const sign = order.side === 'BUY' ? 1 : -1; // buy: minimise cash; sell: maximise cash
  const alloc = new Map<string, number>(eligible.map((v) => [v.id, 0]));
  const slice = order.shares / SLICES;
  let left = order.shares;
  while (left > 1e-9) {
    let best: { v: Venue; marginal: number; take: number } | null = null;
    for (const v of eligible) {
      const cur = alloc.get(v.id)!;
      const capLeft = (v.capRemaining[order.symbol] ?? 0) - cur;
      const pre = poolPrice(v.pools[order.symbol]);
      const before = cur === 0 ? { cash: 0, post: pre } : legCost(v, order.symbol, order.side, cur);
      // full slice, or the largest smaller piece that fits the cap and the band
      for (const frac of [1, 0.5, 0.25, 0.1]) {
        const take = Math.min(slice * frac, capLeft, left);
        if (take <= order.shares * 1e-6) break;
        const after = legCost(v, order.symbol, order.side, cur + take);
        if (!Number.isFinite(after.cash)) continue;
        if (!bandOk(v, order.side, after.post, fv, pre)) continue;
        const marginalPx = (after.cash - before.cash) / take;
        if (order.limitPrice !== undefined && sign * (marginalPx - order.limitPrice) > 0) continue;
        const marginal = sign * marginalPx;
        if (!best || marginal < best.marginal) best = { v, marginal, take };
        break;
      }
    }
    if (!best) break;
    alloc.set(best.v.id, alloc.get(best.v.id)! + best.take);
    left -= best.take;
  }
  return alloc;
}

export function route(order: Order, venues: Venue[], fv: FairValue): RoutePlan {
  const sign = order.side === 'BUY' ? 1 : -1;
  const rejected: Rejection[] = [];
  const eligible: Venue[] = [];
  for (const v of venues) {
    const why = eligibility(v, order, fv);
    if (why) rejected.push({ venueId: v.id, reason: why });
    else eligible.push(v);
  }

  // Try every subset of eligible venues (at most 2^5) and keep the plan that fills the most,
  // then costs the least all-in. This stops tiny orders being split where gas outweighs savings.
  let best: { alloc: Map<string, number>; filled: number; cost: number } | null = null;
  const nSub = 1 << eligible.length;
  for (let mask = 1; mask < nSub; mask++) {
    const subset = eligible.filter((_, i) => mask & (1 << i));
    const alloc = greedyFill(order, subset, fv);
    let filled = 0;
    let cost = 0;
    for (const v of subset) {
      const sh = alloc.get(v.id)!;
      if (sh <= 0) continue;
      filled += sh;
      cost += legCost(v, order.symbol, order.side, sh).cash * sign + v.gasUsd;
    }
    if (
      !best ||
      filled > best.filled + 1e-9 ||
      (Math.abs(filled - best.filled) <= 1e-9 && cost < best.cost - 1e-9)
    ) {
      best = { alloc, filled, cost };
    }
  }
  const alloc = best?.alloc ?? new Map<string, number>();

  const legs: Leg[] = [];
  for (const v of eligible) {
    const sh = alloc.get(v.id) ?? 0;
    if (sh <= 0) {
      rejected.push({ venueId: v.id, reason: 'eligible but not competitive / capacity' });
      continue;
    }
    const c = legCost(v, order.symbol, order.side, sh);
    legs.push({ venueId: v.id, shares: sh, cash: c.cash, avgPrice: c.cash / sh, postPrice: c.post });
  }
  const filled = legs.reduce((a, l) => a + l.shares, 0);
  const totalCash = legs.reduce((a, l) => a + l.cash, 0) + legs.reduce((a, l) => a + (venues.find((v) => v.id === l.venueId)!.gasUsd), 0) * sign;
  const avgPrice = filled ? totalCash / filled : 0;

  // Baseline: the best any single eligible venue could have done alone (respecting its cap)
  let bestSingle: RoutePlan['bestSingleVenue'];
  for (const v of eligible) {
    const cap = Math.min(order.shares, v.capRemaining[order.symbol] ?? 0);
    let sh = cap;
    // shrink until band and limit allow
    for (let k = 0; k < 40 && sh > 0; k++) {
      const c = legCost(v, order.symbol, order.side, sh);
      const ok =
        Number.isFinite(c.cash) &&
        bandOk(v, order.side, c.post, fv, poolPrice(v.pools[order.symbol])) &&
        (order.limitPrice === undefined || sign * (c.cash / sh - order.limitPrice) <= 0);
      if (ok) break;
      sh *= 0.85;
    }
    if (sh <= 0) continue;
    const c = legCost(v, order.symbol, order.side, sh);
    const ap = (c.cash + sign * v.gasUsd) / sh;
    if (!bestSingle || sh > bestSingle.filled + 1e-9 || (Math.abs(sh - bestSingle.filled) < 1e-9 && sign * ap < sign * bestSingle.avgPrice)) {
      bestSingle = { venueId: v.id, avgPrice: ap, filled: sh };
    }
  }

  const slippage = filled ? (sign * (avgPrice - fv.price) / fv.price) * 10_000 : 0;
  const plan: RoutePlan = {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    requested: order.shares,
    filled,
    unfilled: Math.max(0, order.shares - filled),
    legs,
    avgPrice,
    totalCash,
    fairValue: fv.price,
    slippageVsFairBps: slippage,
    rejected,
    session: sessionAt(order.tsMs),
    bestSingleVenue: bestSingle,
  };
  if (bestSingle && filled && Math.abs(bestSingle.filled - filled) < 1e-6) {
    plan.improvementVsSingleBps = (sign * (bestSingle.avgPrice - avgPrice) / bestSingle.avgPrice) * 10_000;
  }
  return plan;
}

/** Apply a plan to venue state (simulation): move pool reserves and consume cap headroom. */
export function execute(plan: RoutePlan, venues: Venue[]): void {
  for (const leg of plan.legs) {
    const v = venues.find((x) => x.id === leg.venueId)!;
    const p = v.pools[plan.symbol];
    const fee = v.feeBps + (v.spreadBps ?? 0) / 2;
    if (plan.side === 'BUY') {
      p.cash += leg.cash * (1 - fee / 10_000);
      p.stock -= leg.shares;
    } else {
      p.stock += leg.shares * (1 - fee / 10_000);
      p.cash -= leg.cash;
    }
    if (v.kind === 'PRIMARY') {
      // the primary market re-centres on fair value; it is not a captive pool
      const k = p.stock * p.cash;
      p.cash = Math.sqrt(k * plan.fairValue);
      p.stock = k / p.cash;
    }
    v.capRemaining[plan.symbol] -= leg.shares;
  }
}
