// Weekend Guard: a 24/7 fair value for each tokenized stock.
//
// When the primary market is open, fair value is the NBBO mid. When it is shut, the engine
// starts from the last close and moves it by things that do still trade:
//   - index futures (Sun 18:00 – Fri 17:00 ET), scaled by the stock's beta
//   - prices on offshore / other tokenized venues, weighted by depth, with outliers rejected
// Confidence widens with time since the close (volatility × √time), and a thin or manipulated
// offshore print cannot drag the estimate far because each observation's weight is capped.

import { Session, sessionAt, hoursSinceLastClose } from '../market/session.ts';

export interface ReferenceData {
  symbol: string;
  lastClose: number; // USD
  nbboMid?: number; // only meaningful in REGULAR / EXTENDED
  annualVol: number; // e.g. 0.30
  beta: number; // vs the futures proxy
  futuresReturnSinceClose?: number; // e.g. -0.012 for -1.2%; undefined when futures are shut
  observations: VenueObservation[];
}

export interface VenueObservation {
  venue: string;
  price: number;
  depthUsd: number; // liquidity within ±2%
}

export interface FairValue {
  symbol: string;
  price: number;
  confidenceBps: number;
  session: Session;
  model: number;
  usedObservations: string[];
  rejectedObservations: { venue: string; reason: string }[];
  lowBand: number;
  highBand: number;
}

/** Mirrors FairValueOracle's on-chain defaults: [baseBps, maxStalenessSeconds]. */
export const BAND_POLICY: Record<Session, { baseBps: number; maxStaleness: number }> = {
  [Session.REGULAR]: { baseBps: 300, maxStaleness: 120 },
  [Session.EXTENDED]: { baseBps: 500, maxStaleness: 300 },
  [Session.OVERNIGHT]: { baseBps: 700, maxStaleness: 600 },
  [Session.CLOSED]: { baseBps: 1000, maxStaleness: 1800 },
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function computeFairValue(ref: ReferenceData, tsMs: number): FairValue {
  const session = sessionAt(tsMs);
  const rejected: { venue: string; reason: string }[] = [];

  // 1. Model anchor
  let model: number;
  let modelSigma: number; // as a fraction of price
  if ((session === Session.REGULAR || session === Session.EXTENDED) && ref.nbboMid) {
    model = ref.nbboMid;
    modelSigma = session === Session.REGULAR ? 0.0005 : 0.002;
  } else {
    const hours = hoursSinceLastClose(tsMs);
    // calendar-time scaling; conservative, since weekend hours count as fully as weekday hours
    const effTradingYears = Math.max(hours, 0.25) / (24 * 365);
    const futMove = ref.futuresReturnSinceClose ?? 0;
    model = ref.lastClose * (1 + ref.beta * futMove);
    const idio = ref.annualVol * Math.sqrt(effTradingYears);
    modelSigma = ref.futuresReturnSinceClose === undefined ? idio * 1.25 : idio;
  }

  // 2. Observations: reject stale outliers (> 4 MADs or > 15% from model)
  const obs = ref.observations.filter((o) => o.price > 0 && o.depthUsd > 0);
  const med = obs.length ? median(obs.map((o) => o.price)) : model;
  const mad = obs.length ? median(obs.map((o) => Math.abs(o.price - med))) || med * 0.002 : 0;
  const used: VenueObservation[] = [];
  for (const o of obs) {
    if (Math.abs(o.price - med) > 4 * mad && obs.length >= 3) {
      rejected.push({ venue: o.venue, reason: 'outlier vs other venues' });
    } else if (Math.abs(o.price / model - 1) > 0.15) {
      rejected.push({ venue: o.venue, reason: '>15% from model' });
    } else if (o.depthUsd < 25_000) {
      rejected.push({ venue: o.venue, reason: 'too thin (<$25k depth)' });
    } else {
      used.push(o);
    }
  }

  // 3. Precision-weighted blend. Each venue's precision grows with depth but is capped so no
  //    single venue can carry more than 40% of the total weight.
  const modelPrec = 1 / (modelSigma * modelSigma);
  let weights = used.map((o) => {
    const sigma = 0.004 * Math.sqrt(1_000_000 / o.depthUsd); // ±0.4% at $1m depth
    return 1 / (sigma * sigma);
  });
  const totalObs = weights.reduce((a, b) => a + b, 0);
  const cap = 0.4 * (modelPrec + totalObs);
  weights = weights.map((w) => Math.min(w, cap));
  const totalW = modelPrec + weights.reduce((a, b) => a + b, 0);
  const price = (model * modelPrec + used.reduce((a, o, i) => a + o.price * weights[i], 0)) / totalW;
  const sigma = Math.sqrt(1 / totalW);
  const confidenceBps = Math.min(5000, Math.max(1, Math.round(sigma * 1.96 * 10_000)));

  const width = BAND_POLICY[session].baseBps + confidenceBps;
  return {
    symbol: ref.symbol,
    price,
    confidenceBps,
    session,
    model,
    usedObservations: used.map((o) => o.venue),
    rejectedObservations: rejected,
    lowBand: price * (1 - width / 10_000),
    highBand: price * (1 + width / 10_000),
  };
}

export function inBand(fv: FairValue, price: number): boolean {
  return price >= fv.lowBand && price <= fv.highBand;
}
