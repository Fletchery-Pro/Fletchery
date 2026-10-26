// Drives a locally deployed Fletchery venue (real Uniswap v4 PoolManager on anvil) from the
// engine: fair-value posting, cap-aware sizing, compliant fills, refusals with readable reasons,
// halt sync, an AI agent under a mandate, a dividend, and anchoring the audit log on-chain.
// Run via ../scripts/e2e.sh, which starts anvil and deploys the contracts first.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rpc, RpcError, decodeRevert, type Log } from '../src/chain/rpc.ts';
import { symbolToBytes32, decodeWords, asAddress, eventTopic } from '../src/chain/abi.ts';
import { computeFairValue } from '../src/safety/fairValue.ts';
import { SESSION_NAME } from '../src/market/session.ts';
import { AuditLog } from '../src/proof/auditLog.ts';
import { toCsv } from '../src/compliance/reports.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(join(HERE, '..', '..', 'deployments', 'local.json'), 'utf8')) as Record<string, string | boolean>;
const OUT = join(HERE, '..', 'out');
mkdirSync(OUT, { recursive: true });
const rpc = new Rpc(process.env.RPC_URL ?? 'http://127.0.0.1:8545');
const log = new AuditLog();

const A = (k: string) => D[k] as string;
const AAPL = symbolToBytes32('AAPL');
const stockIs0 = D.stockIsCurrency0 as boolean;
const KEY_T = [['address', 'address', 'uint24', 'int24', 'address']];
const key = [[stockIs0 ? A('aapl') : A('dusd'), stockIs0 ? A('dusd') : A('aapl'), 3000n, 60n, A('hook')]];
const SWAP = 'swapExactIn((address,address,uint24,int24,address),bool,uint256,uint256,address,uint256)';
const SWAP_T = [...KEY_T, 'bool', 'uint256', 'uint256', 'address', 'uint256'];
const FILL = eventTopic('Fill(bytes32,bytes32,address,address,address,bool,uint256,uint256,uint256,uint256)');

const results: { step: string; ok: boolean; detail: string }[] = [];
const fills: Record<string, unknown>[] = [];
let now = 0;

function report(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  log.append(ok ? 'STEP_OK' : 'STEP_REFUSED', { step, detail }, now * 1000);
  console.log(`${ok ? '  ✓' : '  ✗'} ${step.padEnd(46)} ${detail}`);
}

function parseFills(logs: Log[]) {
  for (const l of logs) {
    if (l.topics[0] !== FILL || l.address.toLowerCase() !== A('hook').toLowerCase()) continue;
    const w = decodeWords(l.data);
    const f = {
      tx: l.transactionHash,
      block: Number(BigInt(l.blockNumber)),
      trader: asAddress(BigInt(l.topics[3])),
      principal: asAddress(w[0]),
      router: asAddress(w[1]),
      side: w[2] === 1n ? 'SELL' : 'BUY',
      shares: Number(w[3]) / 1e18,
      cash: Number(w[4]) / 1e6,
      price: Number(w[5]) / 1e8,
      fairValue: Number(w[6]) / 1e8,
    };
    fills.push(f);
    log.append('FILL', f, now * 1000);
  }
}

async function swap(who: string, buy: boolean, amount: bigint, onBehalfOf = '0x' + '0'.repeat(40)) {
  const zeroForOne = buy ? !stockIs0 : stockIs0;
  const r = await rpc.send(who, A('router'), SWAP, SWAP_T, [...key, zeroForOne, amount, 0n, onBehalfOf, BigInt(now + 600)]);
  parseFills(r.logs);
  return r;
}

async function attempt(step: string, fn: () => Promise<unknown>, expectOk: boolean, describe: () => string = () => '') {
  try {
    await fn();
    report(step, expectOk, expectOk ? describe() : 'UNEXPECTEDLY SUCCEEDED');
  } catch (e) {
    const reason = e instanceof RpcError ? decodeRevert(e.data) : String(e);
    report(step, !expectOk, expectOk ? `FAILED: ${reason}` : `refused on-chain → ${reason}`);
  }
}

async function postFairValue(price: number) {
  now = await rpc.timestamp();
  const fv = computeFairValue({ symbol: 'AAPL', lastClose: price, nbboMid: price, annualVol: 0.28, beta: 1.1, observations: [] }, now * 1000);
  await rpc.send(A('operator'), A('oracle'), 'post(bytes32,uint128,uint32,uint8)', ['bytes32', 'uint128', 'uint32', 'uint8'], [AAPL, BigInt(Math.round(fv.price * 1e8)), BigInt(fv.confidenceBps), BigInt(fv.session)]);
  log.append('FAIR_VALUE', { price: fv.price, confidenceBps: fv.confidenceBps, session: SESSION_NAME[fv.session] }, now * 1000);
  return fv;
}

async function headroom() {
  const [remaining, cap, used] = await rpc.read(A('venue'), 'headroom(bytes32)', ['bytes32'], [AAPL]);
  return { remaining: Number(remaining) / 1e18, cap: Number(cap) / 1e18, used: Number(used) / 1e18 };
}

async function main() {
  now = await rpc.timestamp();
  console.log(`\nFletchery on-chain demo — local chain at ${new Date(now * 1000).toISOString()}\n`);

  for (const who of [A('alice'), A('bob'), A('eve')]) {
    for (const t of [A('aapl'), A('dusd')]) {
      await rpc.send(who, t, 'approve(address,uint256)', ['address', 'uint256'], [A('router'), (1n << 256n) - 1n]);
    }
  }

  const fv = await postFairValue(200);
  report('Weekend Guard posts fair value', true, `$${fv.price.toFixed(2)} ±${fv.confidenceBps}bps (${SESSION_NAME[fv.session]})`);
  const h0 = await headroom();
  report('Read monthly cap headroom', true, `${h0.remaining.toLocaleString()} of ${h0.cap.toLocaleString()} shares left (Tier 1, 0.25% of ADV)`);

  await attempt('US customer buys $10,000 of AAPL', () => swap(A('alice'), true, 10_000n * 10n ** 6n), true, () => {
    const f = fills.at(-1) as { shares: number; price: number };
    return `${f.shares.toFixed(3)} shares @ $${f.price.toFixed(2)}`;
  });
  await attempt('UK customer sells 10 shares', () => swap(A('bob'), false, 10n * 10n ** 18n), true, () => {
    const f = fills.at(-1) as { cash: number };
    return `received $${f.cash.toFixed(2)}`;
  });
  await attempt('Wallet with no credential tries to buy', () => swap(A('eve'), true, 1_000n * 10n ** 6n), false);

  await rpc.send(A('operator'), A('venue'), 'setHalt(bytes32,bool,bytes32)', ['bytes32', 'bool', 'bytes32'], [AAPL, true, symbolToBytes32('LULD')]);
  log.append('HALT', { symbol: 'AAPL', halted: true }, now * 1000);
  await attempt('Exchange halts AAPL: order during halt', () => swap(A('alice'), true, 500n * 10n ** 6n), false);
  await rpc.send(A('operator'), A('venue'), 'setHalt(bytes32,bool,bytes32)', ['bytes32', 'bool', 'bytes32'], [AAPL, false, '0x' + '0'.repeat(64)]);
  await attempt('Halt lifted: same order', () => swap(A('alice'), true, 500n * 10n ** 6n), true, () => 'filled');

  await rpc.send(A('alice'), A('mandates'), 'setMandate(address,uint128,uint128,uint64,bool,bool)', ['address', 'uint128', 'uint128', 'uint64', 'bool', 'bool'], [A('agent'), 2_000n * 10n ** 6n, 5_000n * 10n ** 6n, BigInt(now + 7 * 86400), false, true]);
  report('Customer grants AI agent a mandate', true, '$2,000/trade, $5,000/day, buys only');
  await attempt('Agent buys $1,500 for the customer', () => swap(A('agent'), true, 1_500n * 10n ** 6n, A('alice')), true, () => {
    const f = fills.at(-1) as { shares: number; principal: string };
    return `${f.shares.toFixed(3)} shares delivered to customer ${f.principal.slice(0, 8)}…`;
  });
  await attempt('Agent tries $3,000 (over per-trade limit)', () => swap(A('agent'), true, 3_000n * 10n ** 6n, A('alice')), false);
  await attempt('Agent tries to sell (not allowed)', () => swap(A('agent'), false, 1n * 10n ** 18n, A('alice')), false);

  await attempt('$600,000 market buy (would dislocate price)', () => swap(A('alice'), true, 600_000n * 10n ** 6n), false);

  await rpc.send(A('operator'), A('venue'), 'setCapBasis(bytes32,uint256)', ['bytes32', 'uint256'], [AAPL, 200_000n * 10n ** 18n]);
  const h1 = await headroom();
  report('Cap basis revised (ADV 200k → cap 500 sh)', true, `${h1.remaining.toFixed(3)} shares of headroom left`);
  const over = BigInt(Math.ceil((h1.remaining + 5) * 1e6)) * 10n ** 12n;
  await attempt(`Sell ${(h1.remaining + 5).toFixed(1)} shares (over cap)`, () => swap(A('alice'), false, over), false);
  const exact = BigInt(Math.floor(h1.remaining * 1e6)) * 10n ** 12n;
  await attempt('Engine sizes the order to headroom instead', () => swap(A('alice'), false, exact), true, () => 'filled');
  const h2 = await headroom();
  results[results.length - 1].detail = `filled; headroom now ${h2.remaining.toFixed(6)} shares`;
  await rpc.send(A('operator'), A('venue'), 'setCapBasis(bytes32,uint256)', ['bytes32', 'uint256'], [AAPL, 4_000_000n * 10n ** 18n]);

  await rpc.setNextTimestamp(now + 180);
  now = await rpc.timestamp();
  await attempt('Fair value 3 min old (limit 2 min)', () => swap(A('alice'), true, 500n * 10n ** 6n), false);
  await postFairValue(200);
  await attempt('Engine reposts; order retried', () => swap(A('alice'), true, 500n * 10n ** 6n), true, () => 'filled');

  // Rights: record date, dividend, claim
  const snap = await rpc.send(A('operator'), A('aapl'), 'snapshot()');
  const snapId = BigInt(snap.logs[0].topics[1]);
  const [aliceAtRecord] = await rpc.read(A('aapl'), 'balanceOfAt(address,uint64)', ['address', 'uint64'], [A('alice'), snapId]);
  await rpc.send(A('operator'), A('dusd'), 'approve(address,uint256)', ['address', 'uint256'], [A('rights'), (1n << 256n) - 1n]);
  await rpc.send(A('operator'), A('rights'), 'declareDividend(address,uint64,address,uint256,uint64)', ['address', 'uint64', 'address', 'uint256', 'uint64'], [A('aapl'), snapId, A('dusd'), 260_000n, BigInt(now)]);
  const [before] = await rpc.read(A('dusd'), 'balanceOf(address)', ['address'], [A('alice')]);
  await rpc.send(A('alice'), A('rights'), 'claim(uint256,address)', ['uint256', 'address'], [0n, A('alice')]);
  const [after] = await rpc.read(A('dusd'), 'balanceOf(address)', ['address'], [A('alice')]);
  report('Dividend $0.26/share on record-date balance', true, `customer held ${(Number(aliceAtRecord) / 1e18).toFixed(3)} sh → paid $${(Number(after - before) / 1e6).toFixed(2)}`);
  log.append('DIVIDEND', { snapshotId: snapId.toString(), paid: Number(after - before) / 1e6 }, now * 1000);

  // Proof: anchor the audit log head on-chain
  const head = log.head();
  const toSeq = log.entries.length - 1;
  await rpc.send(A('operator'), A('proof'), 'anchor(bytes32,uint64,uint64,string)', ['bytes32', 'uint64', 'uint64', 'string'], [head, 0n, BigInt(toSeq), 'file://engine/out/onchain_audit.jsonl']);
  const [anchored] = await rpc.read(A('proof'), 'isAnchored(bytes32)', ['bytes32'], [head]);
  const verified = AuditLog.verifyAgainstAnchor(log.entries, head, toSeq);
  report('Audit log anchored on-chain', anchored === 1n && verified, `${toSeq + 1} entries, head ${head.slice(0, 14)}… verified=${verified}`);

  // outputs
  writeFileSync(join(OUT, 'onchain_audit.jsonl'), log.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(OUT, 'onchain_fills.csv'), toCsv(fills));
  writeFileSync(join(OUT, 'onchain_run.json'), JSON.stringify({ chainTime: now, deployments: D, results, fills, auditHead: head }, null, 2));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} steps behaved as expected. ${fills.length} compliant fills recorded from on-chain Fill events.`);
  console.log(`Outputs: ${OUT}/onchain_run.json, onchain_fills.csv, onchain_audit.jsonl\n`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof RpcError ? `${e.message} ${decodeRevert(e.data)}` : e);
  process.exit(1);
});
