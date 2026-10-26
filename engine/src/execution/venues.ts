// Venue models for routing. Each venue is a constant-product pool per symbol (a fair stand-in
// for a full-range AMM) or, for the primary market, a deep book with a spread.
// The default landscape mirrors the real October 2026 market structure, with SIMULATED numbers.

import { Session } from '../market/session.ts';

export type VenueKind = 'TSV' | 'OFFSHORE' | 'PRIMARY';

export interface Pool {
  stock: number; // shares
  cash: number; // USD
}

export interface Venue {
  id: string;
  name: string;
  operator: string;
  chain: string;
  kind: VenueKind;
  allowJurisdictions?: number[]; // if set, only these
  blockJurisdictions?: number[];
  sessions: Session[];
  feeBps: number;
  gasUsd: number; // per leg
  requiresWhitelist: boolean; // venue only accepts approved routers
  fletcheryWhitelisted: boolean;
  mevProtected: boolean;
  capTier?: 1 | 2; // SEC TSV tier
  capRemaining: Record<string, number>; // shares left this month
  halted: Set<string>;
  pools: Record<string, Pool>;
  spreadBps?: number; // PRIMARY only
}

export const US = 840;
export const SANCTIONED = [408, 364, 760, 192]; // KP, IR, SY, CU

export function poolPrice(p: Pool): number {
  return p.cash / p.stock;
}

/** Shares out for a cash-in buy, and the post-trade price (constant product, fee on input). */
export function quoteBuy(p: Pool, cashIn: number, feeBps: number): { shares: number; post: number } {
  const eff = cashIn * (1 - feeBps / 10_000);
  const k = p.stock * p.cash;
  const newCash = p.cash + eff;
  const newStock = k / newCash;
  return { shares: p.stock - newStock, post: newCash / newStock };
}

/** Cash in needed to receive `shares`. */
export function costToBuy(p: Pool, shares: number, feeBps: number): { cash: number; post: number } {
  if (shares >= p.stock) return { cash: Infinity, post: Infinity };
  const k = p.stock * p.cash;
  const newStock = p.stock - shares;
  const newCash = k / newStock;
  return { cash: (newCash - p.cash) / (1 - feeBps / 10_000), post: newCash / newStock };
}

/** Cash out for selling `shares`. */
export function proceedsToSell(p: Pool, shares: number, feeBps: number): { cash: number; post: number } {
  const eff = shares * (1 - feeBps / 10_000);
  const k = p.stock * p.cash;
  const newStock = p.stock + eff;
  const newCash = k / newStock;
  return { cash: p.cash - newCash, post: newCash / newStock };
}

function pool(price: number, depthUsd: number): Pool {
  // Constant-product pool with `depthUsd` of *virtual* reserves on each side. Real TSV pools use
  // concentrated liquidity (Uniswap v4), which behaves like a much larger x·y=k pool near the price.
  return { stock: depthUsd / price, cash: depthUsd };
}

const ALL: Session[] = [Session.CLOSED, Session.OVERNIGHT, Session.EXTENDED, Session.REGULAR];

export interface LandscapeOptions {
  /** prior-month consolidated ADV in shares; sets Tier 1 caps (0.25%). */
  adv?: Record<string, number>;
  /** fraction of this month's cap already used (e.g. late in the month). */
  capUsed?: Record<string, number>;
}

/**
 * Simulated venue landscape. Venue names are generic and every number is illustrative:
 *  - Venue A: a TSV running the Fletchery hook (US persons, Tier 1)
 *  - Venue B: an independent TSV that only accepts routers it has approved (whitelist)
 *  - Venue C: a smaller TSV on a different chain
 *  - Offshore pool: stock tokens issued outside the US (non-US customers only)
 *  - Primary market via the broker's existing route (regular + extended hours only)
 */
export function defaultVenues(prices: Record<string, number>, opts: LandscapeOptions = {}): Venue[] {
  const syms = Object.keys(prices);
  const mk = (depthUsd: number): Record<string, Pool> =>
    Object.fromEntries(syms.map((s) => [s, pool(prices[s], depthUsd)]));
  const caps = (fallbackShares: number, share: number): Record<string, number> =>
    Object.fromEntries(
      syms.map((s) => {
        const cap = opts.adv?.[s] !== undefined ? opts.adv[s] * 0.0025 * share : fallbackShares;
        return [s, cap * (1 - (opts.capUsed?.[s] ?? 0))];
      }),
    );
  const unlimited = Object.fromEntries(syms.map((s) => [s, Number.POSITIVE_INFINITY]));
  return [
    {
      id: 'venue-a',
      name: 'Venue A',
      operator: 'Fletchery hook (simulated)',
      chain: 'Chain A',
      kind: 'TSV',
      allowJurisdictions: [US],
      sessions: ALL,
      feeBps: 10,
      gasUsd: 0.02,
      requiresWhitelist: false,
      fletcheryWhitelisted: true,
      mevProtected: true,
      capTier: 1,
      capRemaining: caps(9_000, 1),
      halted: new Set(),
      pools: mk(80_000_000),
    },
    {
      id: 'venue-b',
      name: 'Venue B',
      operator: 'Independent TSV (simulated)',
      chain: 'Chain B',
      kind: 'TSV',
      allowJurisdictions: [US],
      sessions: ALL,
      feeBps: 15,
      gasUsd: 0.01,
      requiresWhitelist: true,
      fletcheryWhitelisted: false, // flips to true once Venue B approves the Fletchery router
      mevProtected: false,
      capTier: 1,
      capRemaining: caps(12_000, 1.2),
      halted: new Set(),
      pools: mk(120_000_000),
    },
    {
      id: 'venue-c',
      name: 'Venue C',
      operator: 'Independent TSV (simulated)',
      chain: 'Chain C',
      kind: 'TSV',
      allowJurisdictions: [US],
      sessions: ALL,
      feeBps: 12,
      gasUsd: 0.05,
      requiresWhitelist: false,
      fletcheryWhitelisted: true,
      mevProtected: true,
      capTier: 1,
      capRemaining: caps(5_000, 0.6),
      halted: new Set(),
      pools: mk(50_000_000),
    },
    {
      id: 'offshore',
      name: 'Offshore pool',
      operator: 'Non-US token issuer (simulated)',
      chain: 'Chain A',
      kind: 'OFFSHORE',
      blockJurisdictions: [US, ...SANCTIONED],
      sessions: ALL,
      feeBps: 8,
      gasUsd: 0.02,
      requiresWhitelist: false,
      fletcheryWhitelisted: true,
      mevProtected: false,
      capRemaining: { ...unlimited },
      halted: new Set(),
      pools: mk(160_000_000),
    },
    {
      id: 'primary',
      name: 'Primary market (broker route)',
      operator: 'NMS exchanges via broker',
      chain: 'off-chain',
      kind: 'PRIMARY',
      blockJurisdictions: SANCTIONED,
      sessions: [Session.REGULAR, Session.EXTENDED],
      feeBps: 0,
      gasUsd: 0,
      requiresWhitelist: false,
      fletcheryWhitelisted: true,
      mevProtected: true,
      capRemaining: { ...unlimited },
      halted: new Set(),
      pools: mk(20_000_000_000),
      spreadBps: 2,
    },
  ];
}
