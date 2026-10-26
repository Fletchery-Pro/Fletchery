import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi, defaultEngine } from '../src/server.ts';

const SAT = Date.parse('2026-10-31T12:00:00-04:00');

test('broker API: quote, order, mandate refusal, halt, reports, audit', async () => {
  const server = createApi(defaultEngine(), () => SAT);
  await new Promise<void>((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, b: unknown) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const fv = await (await fetch(`${base}/fair-value/AAPL`)).json();
    assert.equal(fv.session, 'CLOSED');

    const q = await (await post('/quote', { account: 'us-1', symbol: 'AAPL', side: 'BUY', shares: 50, delivery: 'TOKEN' })).json();
    assert.ok(q.plan.legs.length >= 1);

    const o = await post('/orders', { account: 'us-1', symbol: 'AAPL', side: 'BUY', shares: 50, delivery: 'TOKEN' });
    assert.equal(o.status, 200);
    assert.equal((await o.json()).status, 'FILLED');

    await post('/mandates', { principal: 'us-1', agent: 'bot', maxPerTrade: 1000, dailyLimit: 2000, symbols: ['AAPL'] });
    const big = await post('/orders', { account: 'us-1', agent: 'bot', symbol: 'AAPL', side: 'BUY', shares: 10 });
    assert.equal(big.status, 422);
    assert.match((await big.json()).rejectReason, /PerTradeLimit/);

    await post('/halts', { symbol: 'TSLA', halted: true, reason: 'LULD' });
    const h = await post('/orders', { account: 'us-2', symbol: 'TSLA', side: 'BUY', shares: 1 });
    assert.match((await h.json()).rejectReason, /halted/);

    const bad = await post('/orders', { account: 'x', symbol: 'AAPL', side: 'HOLD', shares: 1 });
    assert.equal(bad.status, 400);

    const csv = await (await fetch(`${base}/reports/cat.csv`)).text();
    assert.match(csv.split('\n')[0], /eventType/);
    const caps = await (await fetch(`${base}/reports/caps`)).json();
    assert.ok(caps.length > 0);
    assert.deepEqual(await (await fetch(`${base}/audit/verify`)).json(), { ok: true });
  } finally {
    server.close();
  }
});
