import { createHash, randomBytes as nodeRandomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function generateMobileToken(randomBytes = nodeRandomBytes) {
  return randomBytes(32).toString('base64url');
}

export function hashMobileSecret(secret) {
  return createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

export function parseBearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || null;
}

export function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === 'localhost') return true;
  const octets = normalized.split('.').map(Number);
  return octets.length === 4 && octets[0] === 127 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255);
}

const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeMobileUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!usernamePattern.test(username)) throw new Error('Username must be 3-64 characters using letters, numbers, dot, underscore, or hyphen.');
  return username;
}

export function validateMobileCredentials(payload) {
  const username = normalizeMobileUsername(payload?.username);
  const password = typeof payload?.password === 'string' ? payload.password : '';
  if (password.length < 8 || password.length > 256) throw new Error('Password must be between 8 and 256 characters.');
  return { username, password };
}

export function hashMobilePassword(password, randomBytes = nodeRandomBytes) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function verifyMobilePassword(password, encoded) {
  try {
    if (typeof password !== 'string' || typeof encoded !== 'string') return false;
    const [algorithm, salt, expectedHex] = encoded.split('$');
    if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expectedHex)) return false;
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
