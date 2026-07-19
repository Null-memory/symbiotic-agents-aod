import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

export function generatePairingCode(randomBytes = nodeRandomBytes) {
  const value = randomBytes(8).toString('hex').toUpperCase();
  return `AOD-${value.slice(0, 4)}-${value.slice(4, 8)}`;
}

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

export function buildMobilePairingPayload({ baseUrl, code, expiresAt }) {
  return JSON.stringify({
    type: 'aod-mobile-pairing',
    version: 1,
    url: String(baseUrl || '').replace(/\/$/, ''),
    code,
    expiresAt,
  });
}
