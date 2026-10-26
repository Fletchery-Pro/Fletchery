import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, selector } from '../src/chain/keccak.ts';
import { encodeCall, symbolToBytes32, bytes32ToSymbol, decodeWords, asInt } from '../src/chain/abi.ts';

test('keccak256 matches known Ethereum vectors', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // longer than one 136-byte block
  assert.equal(
    keccak256('a'.repeat(200)),
    keccak256(new TextEncoder().encode('a'.repeat(200))),
  );
});

test('function selectors match Solidity', () => {
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selector('approve(address,uint256)'), '0x095ea7b3');
});

test('ABI encodes static and dynamic arguments', () => {
  const data = encodeCall(
    'anchor(bytes32,uint64,uint64,string)',
    ['bytes32', 'uint64', 'uint64', 'string'],
    ['0x' + 'ab'.repeat(32), 0n, 9n, 'hi'],
  );
  const w = decodeWords('0x' + data.slice(10));
  assert.equal(w[1], 0n);
  assert.equal(w[2], 9n);
  assert.equal(w[3], 128n); // offset of the string
  assert.equal(w[4], 2n); // length
});

test('symbols round-trip through bytes32', () => {
  const b = symbolToBytes32('AAPL');
  assert.equal(b, '0x4141504c' + '0'.repeat(56));
  assert.equal(bytes32ToSymbol(b), 'AAPL');
});

test('negative ints decode', () => {
  assert.equal(asInt((1n << 256n) - 5n), -5n);
});
