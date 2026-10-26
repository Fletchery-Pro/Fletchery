// US equity market sessions in New York time, matching FairValueOracle.Session on-chain.
//   REGULAR    09:30–16:00 ET on trading days
//   EXTENDED   04:00–09:30 and 16:00–20:00 ET on trading days
//   OVERNIGHT  20:00–04:00 ET between two trading days (as offered by 24-hour brokers: Sun 8pm – Fri 8pm)
//   CLOSED     weekends and exchange holidays
// Holiday list: NYSE published calendar. Verify yearly before production use.

export const Session = { CLOSED: 0, OVERNIGHT: 1, EXTENDED: 2, REGULAR: 3 } as const;
export type Session = (typeof Session)[keyof typeof Session];
export const SESSION_NAME: Record<Session, string> = {
  0: 'CLOSED',
  1: 'OVERNIGHT',
  2: 'EXTENDED',
  3: 'REGULAR',
};

export const NYSE_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
/** 13:00 ET early closes */
export const NYSE_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

export interface NyTime {
  date: string; // YYYY-MM-DD in New York
  weekday: number; // 0 = Sunday
  minutes: number; // minutes after midnight New York
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyTime(tsMs: number): NyTime {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(tsMs)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WD[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function isTradingDay(date: string): boolean {
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  return wd !== 0 && wd !== 6 && !NYSE_HOLIDAYS.has(date);
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function sessionAt(tsMs: number): Session {
  const t = nyTime(tsMs);
  const today = isTradingDay(t.date);
  const close = NYSE_EARLY_CLOSE.has(t.date) ? 13 * 60 : 16 * 60;
  if (today) {
    if (t.minutes >= 9 * 60 + 30 && t.minutes < close) return Session.REGULAR;
    if (t.minutes >= 4 * 60 && t.minutes < 9 * 60 + 30) return Session.EXTENDED;
    if (t.minutes >= close && t.minutes < 20 * 60) return Session.EXTENDED;
    // before 04:00 on a trading day: the overnight session opened at 20:00 the evening before
    if (t.minutes < 4 * 60) return Session.OVERNIGHT;
    // after 20:00: overnight only if tomorrow trades
    return isTradingDay(addDays(t.date, 1)) ? Session.OVERNIGHT : Session.CLOSED;
  }
  // Non-trading day: Sunday (or holiday) evening opens the overnight session before a trading day.
  if (t.minutes >= 20 * 60 && isTradingDay(addDays(t.date, 1))) return Session.OVERNIGHT;
  return Session.CLOSED;
}

/** Hours since the most recent regular-session close, used to widen fair-value confidence. */
export function hoursSinceLastClose(tsMs: number): number {
  let probe = tsMs;
  for (let i = 0; i < 24 * 12; i++) {
    const t = nyTime(probe);
    const close = NYSE_EARLY_CLOSE.has(t.date) ? 13 * 60 : 16 * 60;
    if (isTradingDay(t.date) && t.minutes >= close) {
      const minutesAfterClose = t.minutes - close;
      return (tsMs - probe) / 3_600_000 + minutesAfterClose / 60;
    }
    if (sessionAt(probe) === Session.REGULAR) return 0;
    probe -= 3_600_000;
  }
  return 24 * 12;
}
