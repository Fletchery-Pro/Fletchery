// Tamper-evident audit log (Fletchery · Proof module).
// Every quote, route decision, fill, rejection and report is appended as an entry whose hash
// covers the previous entry's hash. Editing or deleting any past entry breaks every later hash.
// The current head is anchored on-chain in ProofAnchor.sol, which fixes history at that point.

import { createHash } from 'node:crypto';

export interface LogEntry {
  seq: number;
  ts: number;
  type: string;
  data: unknown;
  prev: string;
  hash: string;
}

/** Canonical JSON: sorted keys, so the same data always hashes the same way. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return JSON.stringify(String(v));
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    return JSON.stringify(v);
  }
  if (v instanceof Set) return canonical([...v].sort());
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
  // like JSON.stringify, keys holding undefined are omitted
  const keys = Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
}

export const GENESIS = '0x' + '0'.repeat(64);

function hashEntry(seq: number, ts: number, type: string, data: unknown, prev: string): string {
  return '0x' + createHash('sha256').update(canonical({ seq, ts, type, data, prev })).digest('hex');
}

export class AuditLog {
  readonly entries: LogEntry[] = [];

  append(type: string, data: unknown, ts = Date.now()): LogEntry {
    const seq = this.entries.length;
    const prev = seq === 0 ? GENESIS : this.entries[seq - 1].hash;
    const plain = JSON.parse(canonical(data));
    const e: LogEntry = { seq, ts, type, data: plain, prev, hash: hashEntry(seq, ts, type, plain, prev) };
    this.entries.push(e);
    return e;
  }

  head(): string {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  }

  static verify(entries: LogEntry[]): { ok: true } | { ok: false; brokenAt: number; reason: string } {
    let prev = GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.seq !== i) return { ok: false, brokenAt: i, reason: 'sequence gap' };
      if (e.prev !== prev) return { ok: false, brokenAt: i, reason: 'previous-hash mismatch' };
      if (hashEntry(e.seq, e.ts, e.type, e.data, e.prev) !== e.hash) {
        return { ok: false, brokenAt: i, reason: 'entry contents altered' };
      }
      prev = e.hash;
    }
    return { ok: true };
  }

  /** Verify a log against a head anchored on-chain at sequence `toSeq`. */
  static verifyAgainstAnchor(entries: LogEntry[], anchoredHead: string, toSeq: number): boolean {
    const r = AuditLog.verify(entries.slice(0, toSeq + 1));
    return r.ok && entries[toSeq]?.hash === anchoredHead;
  }
}
