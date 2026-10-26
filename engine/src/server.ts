// Broker-facing HTTP API for the Fletchery engine. Zero dependencies (node:http).
//
//   GET  /health
//   GET  /venues                       venue landscape, caps, halts, whitelist status
//   GET  /fair-value/:symbol           Weekend Guard fair value and band right now
//   POST /quote                        route plan without executing
//   POST /orders                       route + execute (simulation venues)
//   POST /mandates                     customer grants an AI agent a mandate
//   DELETE /mandates/:principal/:agent kill switch
//   POST /halts                        mirror an exchange halt { symbol, halted, reason }
//   GET  /reports/cat.csv | /reports/best-ex | /reports/caps
//   GET  /audit/head | /audit/verify
//   GET  /                             dashboard (if dashboard/index.html exists)

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fletchery } from './fletchery.ts';
import type { Order } from './execution/router.ts';
import { toCsv } from './compliance/reports.ts';
import { AuditLog } from './proof/auditLog.ts';
import { SESSION_NAME } from './market/session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultEngine(): Fletchery {
  const px: Record<string, [number, number, number]> = {
    AAPL: [260, 0.24, 1.1],
    NVDA: [185, 0.45, 1.7],
    TSLA: [430, 0.6, 2.0],
    AMC: [3.2, 0.9, 1.4],
  };
  return new Fletchery(
    Object.entries(px).map(([symbol, [p, vol, beta]]) => ({
      symbol,
      lastClose: p,
      nbboMid: p,
      annualVol: vol,
      beta,
      observations: [],
    })),
  );
}

let orderSeq = 0;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(data, (_k, v) => (v instanceof Set ? [...v] : v === Infinity ? 'unlimited' : v), 2) : String(data);
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(payload);
}

function toOrder(b: Record<string, unknown>, now: number): Order {
  for (const f of ['account', 'symbol', 'side', 'shares']) if (b[f] === undefined) throw new Error(`missing field: ${f}`);
  if (b.side !== 'BUY' && b.side !== 'SELL') throw new Error('side must be BUY or SELL');
  const shares = Number(b.shares);
  if (!(shares > 0)) throw new Error('shares must be positive');
  return {
    id: String(b.id ?? `API-${++orderSeq}`),
    account: String(b.account),
    jurisdiction: Number(b.jurisdiction ?? 840),
    symbol: String(b.symbol).toUpperCase(),
    side: b.side,
    shares,
    limitPrice: b.limitPrice !== undefined ? Number(b.limitPrice) : undefined,
    agent: b.agent !== undefined ? String(b.agent) : undefined,
    delivery: b.delivery === 'TOKEN' ? 'TOKEN' : 'ANY',
    tsMs: b.tsMs !== undefined ? Number(b.tsMs) : now,
  };
}

export function createApi(engine: Fletchery = defaultEngine(), clock: () => number = Date.now): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      const now = clock();

      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (path === '/health') return send(res, 200, { ok: true, time: new Date(now).toISOString() });

      if (path === '/' || path === '/dashboard') {
        const f = join(HERE, '..', '..', 'dashboard', 'index.html');
        if (existsSync(f)) return send(res, 200, readFileSync(f, 'utf8'), 'text/html; charset=utf-8');
        return send(res, 404, { error: 'dashboard not built' });
      }

      if (path === '/venues' && req.method === 'GET') {
        return send(res, 200, engine.venues.map((v) => ({ ...v, halted: [...v.halted] })));
      }

      const fvMatch = path.match(/^\/fair-value\/([A-Za-z.]+)$/);
      if (fvMatch && req.method === 'GET') {
        const fv = engine.fairValue(fvMatch[1].toUpperCase(), now);
        return send(res, 200, { ...fv, session: SESSION_NAME[fv.session] });
      }

      if (path === '/quote' && req.method === 'POST') {
        const q = engine.quote(toOrder(await body(req), now));
        return send(res, 200, q);
      }

      if (path === '/orders' && req.method === 'POST') {
        const r = engine.submit(toOrder(await body(req), now));
        return send(res, r.record.status === 'REJECTED' ? 422 : 200, r.record);
      }

      if (path === '/mandates' && req.method === 'POST') {
        const b = await body(req);
        engine.mandates.set({
          principal: String(b.principal),
          agent: String(b.agent),
          maxPerTrade: Number(b.maxPerTrade),
          dailyLimit: Number(b.dailyLimit),
          expiryMs: Number(b.expiryMs ?? now + 7 * 86_400_000),
          allowSells: Boolean(b.allowSells),
          symbols: Array.isArray(b.symbols) ? new Set((b.symbols as string[]).map((s) => s.toUpperCase())) : 'ANY',
        });
        engine.log.append('MANDATE', b, now);
        return send(res, 201, { ok: true });
      }

      const mDel = path.match(/^\/mandates\/([^/]+)\/([^/]+)$/);
      if (mDel && req.method === 'DELETE') {
        engine.mandates.revoke(decodeURIComponent(mDel[1]), decodeURIComponent(mDel[2]));
        engine.log.append('MANDATE_REVOKED', { principal: mDel[1], agent: mDel[2] }, now);
        return send(res, 200, { ok: true });
      }

      if (path === '/halts' && req.method === 'POST') {
        const b = await body(req);
        engine.setHalt(String(b.symbol).toUpperCase(), Boolean(b.halted), String(b.reason ?? ''), now);
        return send(res, 200, { ok: true });
      }

      if (path.startsWith('/reports/')) {
        const d = new Date(now);
        const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        const r = engine.reports(d.getUTCDate(), dim);
        if (path === '/reports/cat.csv') return send(res, 200, toCsv(r.cat), 'text/csv');
        if (path === '/reports/best-ex') return send(res, 200, r.bestEx);
        if (path === '/reports/caps') return send(res, 200, r.caps);
      }

      if (path === '/audit/head') return send(res, 200, { head: engine.log.head(), entries: engine.log.entries.length });
      if (path === '/audit/verify') return send(res, 200, AuditLog.verify(engine.log.entries));

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  createApi().listen(port, () => console.log(`Fletchery API on http://localhost:${port}`));
}
