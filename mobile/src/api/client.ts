import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { MobileConnection, MobilePairingPayload, MobileState } from './types';

const CONNECTION_KEY = 'aod.mobile.connection.v1';

export class MobileApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'MobileApiError';
    this.status = status;
    this.code = code;
  }
}

export function normalizeBaseUrl(value: string) {
  return String(value || '').trim().replace(/\/$/, '');
}

export function parsePairingPayload(raw: string): MobilePairingPayload {
  const value = JSON.parse(raw) as Partial<MobilePairingPayload>;
  if (value.type !== 'aod-mobile-pairing' || value.version !== 1 || !value.url || !value.code || !value.expiresAt) {
    throw new Error('二维码不是有效的 AOD 手机配对信息。');
  }
  if (Date.parse(value.expiresAt) <= Date.now()) throw new Error('二维码已经过期，请在桌面端重新生成。');
  return value as MobilePairingPayload;
}

export async function saveConnection(connection: MobileConnection) {
  const value = JSON.stringify(connection);
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(CONNECTION_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(CONNECTION_KEY, value);
}

export async function loadConnection(): Promise<MobileConnection | null> {
  const raw = Platform.OS === 'web'
    ? globalThis.localStorage?.getItem(CONNECTION_KEY) || null
    : await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as MobileConnection; } catch { return null; }
}

export async function clearConnection() {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(CONNECTION_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(CONNECTION_KEY);
}

export async function completePairing(payload: MobilePairingPayload, deviceName: string) {
  const baseUrl = normalizeBaseUrl(payload.url);
  const response = await fetch(`${baseUrl}/api/mobile/pairing/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: payload.code, deviceName: deviceName.trim() || 'Android device' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `配对失败（${response.status}）。`);
  const connection: MobileConnection = { baseUrl, token: data.token, deviceId: data.deviceId, deviceName: data.deviceName };
  await saveConnection(connection);
  return connection;
}

export async function mobileRequest<T>(connection: MobileConnection, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${normalizeBaseUrl(connection.baseUrl)}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}`, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MobileApiError(data.error || `请求失败（${response.status}）。`, response.status, data.code);
  return data as T;
}

export function loadState(connection: MobileConnection) {
  return mobileRequest<MobileState>(connection, '/api/state');
}
