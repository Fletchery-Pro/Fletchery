// Off-chain mirror of AgentMandates.sol ("Leash"). Brokers call `check` before submitting an
// agent's order so the customer gets a clear reason instantly instead of an on-chain revert.
// The on-chain contract remains the source of truth and enforces the same rules at fill time.

export interface Mandate {
  principal: string;
  agent: string;
  maxPerTrade: number; // USD
  dailyLimit: number; // USD per UTC day
  expiryMs: number;
  allowSells: boolean;
  symbols: Set<string> | 'ANY';
}

export class MandateBook {
  private mandates = new Map<string, Mandate>();
  private spent = new Map<string, number>(); // `${principal}|${agent}|${day}` → USD

  private key(p: string, a: string): string {
    return `${p}|${a}`;
  }

  set(m: Mandate): void {
    this.mandates.set(this.key(m.principal, m.agent), m);
  }

  revoke(principal: string, agent: string): void {
    this.mandates.delete(this.key(principal, agent));
  }

  get(principal: string, agent: string): Mandate | undefined {
    return this.mandates.get(this.key(principal, agent));
  }

  spentToday(principal: string, agent: string, tsMs: number): number {
    return this.spent.get(`${principal}|${agent}|${Math.floor(tsMs / 86_400_000)}`) ?? 0;
  }

  check(
    principal: string,
    agent: string,
    symbol: string,
    isSell: boolean,
    notional: number,
    tsMs: number,
  ): { ok: true } | { ok: false; reason: string } {
    const m = this.get(principal, agent);
    if (!m) return { ok: false, reason: 'NoMandate: agent has no mandate from this customer' };
    if (m.expiryMs <= tsMs) return { ok: false, reason: 'MandateExpired' };
    if (m.symbols !== 'ANY' && !m.symbols.has(symbol)) return { ok: false, reason: `SymbolNotAllowed: ${symbol}` };
    if (isSell && !m.allowSells) return { ok: false, reason: 'SellsNotAllowed' };
    if (notional > m.maxPerTrade) {
      return { ok: false, reason: `PerTradeLimit: $${notional.toFixed(2)} > $${m.maxPerTrade}` };
    }
    const would = this.spentToday(principal, agent, tsMs) + notional;
    if (would > m.dailyLimit) return { ok: false, reason: `DailyLimit: $${would.toFixed(2)} > $${m.dailyLimit}` };
    return { ok: true };
  }

  consume(principal: string, agent: string, notional: number, tsMs: number): void {
    const k = `${principal}|${agent}|${Math.floor(tsMs / 86_400_000)}`;
    this.spent.set(k, (this.spent.get(k) ?? 0) + notional);
  }
}
