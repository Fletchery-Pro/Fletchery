// Minimal Solidity ABI encoder/decoder: enough for Fletchery's contracts.
// Supports address, bool, uintN, intN, bytes32, string/bytes, and static tuples.

import { keccak256, selector, hexToBytes } from './keccak.ts';

export type AbiType = string | AbiType[]; // nested array = static tuple
export type AbiValue = string | bigint | number | boolean | AbiValue[];

const word = (n: bigint): string => {
  const v = n < 0n ? (1n << 256n) + n : n;
  return v.toString(16).padStart(64, '0');
};

function isDynamic(t: AbiType): boolean {
  if (Array.isArray(t)) return t.some(isDynamic);
  return t === 'string' || t === 'bytes';
}

function encodeStatic(t: AbiType, v: AbiValue): string {
  if (Array.isArray(t)) return t.map((tt, i) => encodeStatic(tt, (v as AbiValue[])[i])).join('');
  if (t === 'address') return (v as string).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (t === 'bool') return word(v ? 1n : 0n);
  if (t === 'bytes32') return (v as string).replace(/^0x/, '').padEnd(64, '0');
  if (t.startsWith('uint') || t.startsWith('int')) return word(BigInt(v as bigint));
  throw new Error(`unsupported static type ${t}`);
}

function encodeDynamic(t: string, v: AbiValue): string {
  const bytes = t === 'string' ? new TextEncoder().encode(v as string) : hexToBytes(v as string);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return word(BigInt(bytes.length)) + padded;
}

export function encodeArgs(types: AbiType[], values: AbiValue[]): string {
  const headSize = types.reduce<number>((n, t) => n + (Array.isArray(t) ? t.length : 1) * 32, 0);
  let head = '';
  let tail = '';
  types.forEach((t, i) => {
    if (isDynamic(t)) {
      if (Array.isArray(t)) throw new Error('dynamic tuples not supported');
      head += word(BigInt(headSize + tail.length / 2));
      tail += encodeDynamic(t, values[i]);
    } else {
      head += encodeStatic(t, values[i]);
    }
  });
  return head + tail;
}

/** Encode a call from a human signature, e.g. `encodeCall('setHalt(bytes32,bool,bytes32)', [..])`. */
export function encodeCall(signature: string, types: AbiType[], values: AbiValue[]): string {
  return selector(signature) + encodeArgs(types, values);
}

export function decodeWords(data: string): bigint[] {
  const h = data.replace(/^0x/, '');
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
  return out;
}

export const asAddress = (w: bigint): string => '0x' + w.toString(16).padStart(40, '0').slice(-40);
export const asInt = (w: bigint): bigint => (w >= 1n << 255n ? w - (1n << 256n) : w);

/** bytes32 of an ASCII ticker, right-padded (matches Solidity `bytes32("AAPL")`). */
export function symbolToBytes32(sym: string): string {
  let hex = '0x';
  for (const ch of new TextEncoder().encode(sym)) hex += ch.toString(16).padStart(2, '0');
  return hex.padEnd(66, '0');
}

export function bytes32ToSymbol(b: string | bigint): string {
  const h = typeof b === 'bigint' ? b.toString(16).padStart(64, '0') : b.replace(/^0x/, '');
  let s = '';
  for (let i = 0; i < h.length; i += 2) {
    const c = parseInt(h.slice(i, i + 2), 16);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export const eventTopic = (signature: string): string => keccak256(signature);
