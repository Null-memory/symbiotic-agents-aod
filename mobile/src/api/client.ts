import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { MobileConnection, MobileState } from './types';

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
  const raw = String(value || '').trim();
  if (!raw) throw new MobileApiError('请输入 AOD 地址。', 0, 'MOBILE_URL_REQUIRED');
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch {
    throw new MobileApiError('AOD 地址格式不正确，请输入类似 http://192.168.1.10:4830 的地址。', 0, 'MOBILE_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MobileApiError('AOD 地址必须使用 http:// 或 https://。', 0, 'MOBILE_URL_INVALID');
  }
  return parsed.origin;
}

async function fetchJson(baseUrl: string, path: string, options: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, options);
  } catch {
    throw new MobileApiError(`无法连接 ${baseUrl}。请确认电脑和手机在同一网络，并使用桌面端“手机连接”里显示的可访问地址。`, 0, 'MOBILE_NETWORK_UNREACHABLE');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MobileApiError(data.error || `请求失败（${response.status}）。`, response.status, data.code);
  return data;
}

export async function loadMobileStatus(baseUrlValue: string) {
  const baseUrl = normalizeBaseUrl(baseUrlValue);
  return fetchJson(baseUrl, '/api/mobile/status') as Promise<{
    enabled?: boolean;
    accountConfigured?: boolean;
    bindHost?: string;
    publicUrl?: string | null;
    reachable?: boolean;
  }>;
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

export async function loginMobile(baseUrlValue: string, username: string, password: string, deviceName: string) {
  const baseUrl = normalizeBaseUrl(baseUrlValue);
  const status = await loadMobileStatus(baseUrl);
  if (!status.enabled) throw new MobileApiError('桌面端移动服务尚未开启。请先在 AOD 顶栏“手机连接”里开启“允许 Android 连接”。', 409, 'MOBILE_DISABLED');
  if (!status.accountConfigured) throw new MobileApiError('桌面端尚未设置移动账号。请先在“手机连接”里保存用户名和密码。', 409, 'MOBILE_ACCOUNT_REQUIRED');
  const data = await fetchJson(baseUrl, '/api/mobile/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password, deviceName: deviceName.trim() || 'Android device' }),
  });
  const connection: MobileConnection = { baseUrl, token: data.token, deviceId: data.deviceId, deviceName: data.deviceName };
  await saveConnection(connection);
  return connection;
}

export async function mobileRequest<T>(connection: MobileConnection, path: string, options: RequestInit = {}): Promise<T> {
  const data = await fetchJson(normalizeBaseUrl(connection.baseUrl), path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.token}`, ...(options.headers || {}) },
  });
  return data as T;
}

export function loadState(connection: MobileConnection) {
  return mobileRequest<MobileState>(connection, '/api/state');
}
