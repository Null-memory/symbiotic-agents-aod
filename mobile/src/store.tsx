import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';
import { AppState } from 'react-native';
import { clearConnection, loadConnection, loadState, MobileApiError } from './api/client';
import { connectMobileStream, type StreamHandle } from './api/stream';
import type { MobileConnection, MobileState, StreamEvent } from './api/types';

type Store = {
  connection: MobileConnection | null;
  data: MobileState | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  eventCursor: number;
  connect: (connection: MobileConnection) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  runAction: (path: string, body?: unknown) => Promise<any>;
};

type State = Omit<Store, 'refresh' | 'signOut' | 'runAction' | 'connect'>;
type Action = { type: 'connection'; connection: MobileConnection | null } | { type: 'state'; data: MobileState } | { type: 'event'; event: StreamEvent } | { type: 'loading'; loading: boolean } | { type: 'error'; error: string | null } | { type: 'connected'; connected: boolean };

const initialState: State = { connection: null, data: null, connected: false, loading: true, error: null, eventCursor: 0 };
const StoreContext = createContext<Store | null>(null);

function reducer(state: State, action: Action): State {
  if (action.type === 'connection') return { ...state, connection: action.connection, loading: false, error: null };
  if (action.type === 'state') return { ...state, data: action.data, loading: false, error: null };
  if (action.type === 'event') return { ...state, eventCursor: Math.max(state.eventCursor, action.event.id || 0), ...(action.event.type === 'state' ? { data: action.event.data } : {}) };
  if (action.type === 'loading') return { ...state, loading: action.loading };
  if (action.type === 'error') return { ...state, error: action.error, loading: false };
  if (action.type === 'connected') return { ...state, connected: action.connected };
  return state;
}

export function MobileProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [stream, setStream] = React.useState<StreamHandle | null>(null);

  const disconnect = useCallback(async () => {
    await clearConnection();
    dispatch({ type: 'connection', connection: null });
    dispatch({ type: 'connected', connected: false });
  }, []);

  const refresh = useCallback(async () => {
    if (!state.connection) return;
    dispatch({ type: 'loading', loading: true });
    try { dispatch({ type: 'state', data: await loadState(state.connection) }); }
    catch (error) {
      if (error instanceof MobileApiError && error.status === 401) {
        await disconnect();
        return;
      }
      dispatch({ type: 'error', error: error instanceof Error ? error.message : '无法连接 AOD。' });
    }
  }, [disconnect, state.connection]);

  const connect = useCallback((connection: MobileConnection) => dispatch({ type: 'connection', connection }), []);

  const signOut = useCallback(async () => {
    stream?.close();
    await disconnect();
  }, [disconnect, stream]);

  const runAction = useCallback(async (path: string, body: unknown = {}) => {
    if (!state.connection) throw new Error('尚未连接 AOD。');
    const { mobileRequest } = await import('./api/client');
    try {
      const result = await mobileRequest<any>(state.connection, path, { method: 'POST', body: JSON.stringify(body) });
      await refresh();
      return result;
    } catch (error) {
      if (error instanceof MobileApiError && error.status === 401) await disconnect();
      throw error;
    }
  }, [disconnect, refresh, state.connection]);

  useEffect(() => {
    let active = true;
    loadConnection().then(connection => { if (active) dispatch({ type: 'connection', connection }); }).catch(() => dispatch({ type: 'error', error: '无法读取本机安全连接信息。' }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    stream?.close();
    if (!state.connection) return undefined;
    let handle: StreamHandle | null = null;
    const start = () => {
      handle = connectMobileStream(state.connection!, state.eventCursor, event => { dispatch({ type: 'event', event }); dispatch({ type: 'connected', connected: true }); if (event.type !== 'state') refresh(); }, error => { dispatch({ type: 'connected', connected: false }); dispatch({ type: 'error', error: error.message }); });
      setStream(handle);
    };
    start();
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') { refresh(); start(); } else { handle?.close(); dispatch({ type: 'connected', connected: false }); } });
    return () => { subscription.remove(); handle?.close(); };
  }, [refresh, state.connection]);

  const value = useMemo<Store>(() => ({ ...state, connect, refresh, signOut, runAction }), [connect, refresh, runAction, signOut, state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useMobile() {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useMobile must be used inside MobileProvider.');
  return value;
}
