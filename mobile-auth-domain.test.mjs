import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMobilePairingPayload,
  generateMobileToken,
  generatePairingCode,
  hashMobileSecret,
  isLoopbackAddress,
  parseBearerToken,
} from './mobile-auth-domain.mjs';

test('generates a readable pairing code and a cryptographically separate device token', () => {
  const bytes = Buffer.from('0123456789abcdef', 'hex');
  const code = generatePairingCode(() => bytes);
  const token = generateMobileToken(() => Buffer.alloc(32, 7));
  assert.match(code, /^[A-Z0-9-]{11,}$/);
  assert.equal(token.length >= 40, true);
  assert.notEqual(code, token);
});

test('hashes mobile secrets without persisting the raw value', () => {
  const secret = 'AOD-mobile-secret';
  const digest = hashMobileSecret(secret);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, hashMobileSecret(secret));
  assert.notEqual(digest, secret);
});

test('parses Bearer credentials and rejects other authorization schemes', () => {
  assert.equal(parseBearerToken('Bearer abc123'), 'abc123');
  assert.equal(parseBearerToken('bearer abc123'), 'abc123');
  assert.equal(parseBearerToken('Basic abc123'), null);
  assert.equal(parseBearerToken('Bearer'), null);
  assert.equal(parseBearerToken(''), null);
});

test('recognizes IPv4 and IPv6 loopback clients', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.64.0.4'), false);
});

test('builds a versioned QR pairing payload without including the device token', () => {
  const payload = JSON.parse(buildMobilePairingPayload({ baseUrl: 'http://100.64.0.4:4826', code: 'AOD-ABCD-EFGH', expiresAt: '2030-01-01T00:00:00.000Z' }));
  assert.deepEqual(payload, {
    type: 'aod-mobile-pairing',
    version: 1,
    url: 'http://100.64.0.4:4826',
    code: 'AOD-ABCD-EFGH',
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  assert.equal('token' in payload, false);
});
