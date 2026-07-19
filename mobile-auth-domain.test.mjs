import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateMobileToken,
  hashMobileSecret,
  isLoopbackAddress,
  hashMobilePassword,
  normalizeMobileUsername,
  parseBearerToken,
  validateMobileCredentials,
  verifyMobilePassword,
} from './mobile-auth-domain.mjs';

test('generates a cryptographically separate mobile device token', () => {
  const token = generateMobileToken(() => Buffer.alloc(32, 7));
  assert.equal(token.length >= 40, true);
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

test('normalizes usernames and validates password length', () => {
  assert.equal(normalizeMobileUsername('  Admin.User  '), 'admin.user');
  assert.throws(() => normalizeMobileUsername('a'), /username/i);
  assert.throws(() => validateMobileCredentials({ username: 'admin', password: 'short' }), /password/i);
  assert.deepEqual(validateMobileCredentials({ username: 'Admin', password: 'a-secure-pass' }), { username: 'admin', password: 'a-secure-pass' });
});

test('hashes and verifies account passwords without storing the raw password', () => {
  const encoded = hashMobilePassword('a-secure-pass', () => Buffer.alloc(16, 7));
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.notEqual(encoded, 'a-secure-pass');
  assert.equal(verifyMobilePassword('a-secure-pass', encoded), true);
  assert.equal(verifyMobilePassword('wrong-pass', encoded), false);
  assert.equal(verifyMobilePassword('a-secure-pass', 'broken-hash'), false);
});
