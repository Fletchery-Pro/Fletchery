// Minimal JSON-RPC client for an EVM node (anvil locally, the venue's chain in production).
// Uses unlocked node accounts (anvil) via eth_sendTransaction. A production deployment would
// sign with a KMS/HSM-held key instead; that is the only piece that changes.

import { encodeCall, decodeWords, asAddress, asInt, type AbiType, type AbiValue } from './abi.ts';
import { selector } from './keccak.ts';

export class RpcError extends Error {
  readonly data?: string;
  constructor(message: string, data?: string) {
    super(message);
    this.data = data;
  }
}

export interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

export class Rpc {
  private id = 0;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string; data?: string | { data?: string } } };
    if (body.error) {
      const d = body.error.data;
      throw new RpcError(body.error.message, typeof d === 'string' ? d : d?.data);
    }
    return body.result as T;
  }

  async read(to: string, sig: string, types: AbiType[] = [], values: AbiValue[] = []): Promise<bigint[]> {
    const data = encodeCall(sig, types, values);
    const out = await this.call<string>('eth_call', [{ to, data }, 'latest']);
    return decodeWords(out);
  }

  /** Send a transaction from an unlocked account and wait for the receipt. Throws RpcError with revert data. */
  async send(from: string, to: string, sig: string, types: AbiType[] = [], values: AbiValue[] = []) {
    const data = encodeCall(sig, types, values);
    // eth_call first so a revert surfaces with its data before anything is broadcast
    await this.call('eth_call', [{ from, to, data }, 'latest']);
    const hash = await this.call<string>('eth_sendTransaction', [{ from, to, data, gas: '0x7a1200' }]);
    for (let i = 0; i < 200; i++) {
      const r = await this.call<{ status: string; logs: Log[]; gasUsed: string } | null>('eth_getTransactionReceipt', [hash]);
      if (r) {
        if (r.status !== '0x1') throw new RpcError(`transaction ${hash} reverted`);
        return { hash, logs: r.logs, gasUsed: BigInt(r.gasUsed) };
      }
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new RpcError(`no receipt for ${hash}`);
  }

  async timestamp(): Promise<number> {
    const b = await this.call<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
    return Number(BigInt(b.timestamp));
  }

  async setNextTimestamp(ts: number): Promise<void> {
    await this.call('evm_setNextBlockTimestamp', [ts]);
    await this.call('evm_mine', []);
  }
}

// ───────── revert decoding ─────────

const ERRORS = [
  'NoCredential(address)',
  'JurisdictionNotAllowed(uint16)',
  'InvestorClassTooLow()',
  'RouterNotApproved(address)',
  'PriceOutOfBand(uint256,uint256,uint256)',
  'PoolNotRegistered()',
  'NotActive(bytes32)',
  'Halted(bytes32,bytes32)',
  'Stopped(bytes32,uint64)',
  'NoCapBasis(bytes32,uint256)',
  'CapExceeded(bytes32,uint256,uint256)',
  'StaleFairValue(bytes32,uint64)',
  'NoFairValue(bytes32)',
  'NoMandate()',
  'MandateExpired()',
  'SymbolNotAllowed(bytes32)',
  'SellsNotAllowed()',
  'PerTradeLimit(uint256,uint256)',
  'DailyLimit(uint256,uint256)',
  'NotEligible(address)',
  'Slippage(uint256,uint256)',
  'Expired()',
];
const BY_SELECTOR = new Map(ERRORS.map((e) => [selector(e), e]));
const WRAPPED = selector('WrappedError(address,bytes4,bytes,bytes)');

/** Turn raw revert data into a readable reason, unwrapping Uniswap v4's WrappedError. */
export function decodeRevert(data?: string): string {
  if (!data || data.length < 10) return 'reverted (no reason)';
  let sel = data.slice(0, 10);
  let body = data.slice(10);
  if (sel === WRAPPED) {
    const w = decodeWords('0x' + body);
    const off = Number(w[2]) * 2; // offset of `reason` bytes
    const len = Number(BigInt('0x' + body.slice(off, off + 64)));
    const reason = body.slice(off + 64, off + 64 + len * 2);
    sel = '0x' + reason.slice(0, 8);
    body = reason.slice(8);
  }
  const name = BY_SELECTOR.get(sel);
  if (!name) return `reverted (${sel})`;
  const args = decodeWords('0x' + body);
  const types = name.slice(name.indexOf('(') + 1, -1).split(',').filter(Boolean);
  const shown = types.map((t, i) => {
    const w = args[i];
    if (w === undefined) return '?';
    if (t === 'address') return asAddress(w);
    if (t === 'bytes32') return `"${Buffer.from(w.toString(16).padStart(64, '0'), 'hex').toString().replace(/\0+$/, '')}"`;
    if (t.startsWith('int')) return asInt(w).toString();
    return w.toString();
  });
  const short = name.slice(0, name.indexOf('('));
  const usd = (w: bigint, dec: number) => '$' + (Number(w) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const sh = (w: bigint) => (Number(w) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' sh';
  // human-friendly forms for the errors people see most
  if (short === 'PriceOutOfBand') return `PriceOutOfBand(post-trade ${usd(args[0], 8)} vs band ${usd(args[1], 8)}–${usd(args[2], 8)})`;
  if (short === 'CapExceeded') return `CapExceeded(${shown[0]}: would reach ${sh(args[1])}, cap ${sh(args[2])})`;
  if (short === 'PerTradeLimit' || short === 'DailyLimit') return `${short}(${usd(args[0], 6)} > ${usd(args[1], 6)})`;
  return `${short}(${shown.join(', ')})`;
}
