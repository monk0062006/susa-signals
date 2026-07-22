// SPEC-174 web signer self-test (CI). Proves the shipped @susatest/signals-core
// signer produces a correct HMAC and reproduces the cross-language known-answer
// vector that the Python server + Android + iOS tests also assert. Run after the
// SDK is built (npm run bundle) so this imports the real published output.
import { IngestClient } from '@susatest/signals-core';
import { webcrypto } from 'node:crypto';
import crypto from 'node:crypto';
import assert from 'node:assert';

const secretStr = '0123456789abcdef0123456789abcdef';
const bodyHash = crypto.createHash('sha256').update('{"a":1}').digest('hex');

// 1. The SDK signs with the exact HMAC over the canonical string.
let captured;
const signed = new IngestClient({
  endpoint: 'http://x/signals',
  projectId: 'p',
  ingestSecret: Buffer.from(secretStr).toString('base64url'),
  now: () => 1700000000,
  cryptoImpl: webcrypto,
  fetchImpl: async (_url, init) => { captured = init; return { ok: true, status: 201 }; },
});
await signed.sendEvents('{"a":1}');

const expected = 'v1=' + crypto
  .createHmac('sha256', Buffer.from(secretStr))
  .update(`v1\n1700000000\nPOST\n/v1/events\n${bodyHash}`)
  .digest('hex');
assert.equal(captured.headers['x-susa-signature'], expected, 'SDK signature != HMAC');
assert.equal(captured.headers['x-susa-timestamp'], '1700000000', 'missing timestamp');

// 2. The cross-language vector: node HMAC for the shared /v1/reports case must
//    equal the value pinned in the Python/Android/iOS tests.
const vector = crypto
  .createHmac('sha256', Buffer.from(secretStr))
  .update(`v1\n1700000000\nPOST\n/v1/reports\n${bodyHash}`)
  .digest('hex');
assert.equal(
  vector,
  'aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3',
  'cross-language known-answer vector mismatch',
);

// 3. Without a secret, nothing is signed.
let cap2;
const plain = new IngestClient({
  endpoint: 'http://x/signals',
  projectId: 'p',
  fetchImpl: async (_url, init) => { cap2 = init; return { ok: true, status: 201 }; },
});
await plain.sendEvents('{}');
assert.equal(cap2.headers['x-susa-signature'], undefined, 'unsigned client must not sign');

console.log('signing self-test: PASS');
