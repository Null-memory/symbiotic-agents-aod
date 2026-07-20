import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { AppState } from 'react-native';
import { clearConnection, loadConnection, loadState, MobileApiError } from './api/client';
import { connectMobileStream, retryDelayMs, type StreamHandle } from './api/stream';
import type { MobileConnection, MobileState, StreamEvent } from './api/types';

export type ConnectionPhase = 'offline' | 'connecting' | 'live' | 'reconnecting';

type Store = {
  connection: MobileConnection | null;
  data: MobileState | null;
  connected: boolean;
  connectionPhase: ConnectionPhase;
  loading: boolean;
  error: string | null;
  eventCursor: number;
  connect: (connection: MobileConnection) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  runAction: (path: string, body?: unknown) => Promise<any>;
};

type State = Omit<Store, 'refresh' | 'signOut' | 'runAction' | 'connect'>;
type Action =
  | { type: 'connection'; connection: MobileConnection | null }
  | { type: 'state'; data: MobileState }
  | { type: 'event'; event: StreamEvent }
  | { type: 'loading'; loading: boolean }
  | { type: 'error'; error: string | null }
  | { type: 'phase'; phase: ConnectionPhase };

const initialState: State = { connection: null, data: null, connected: false, connectionPhase: 'offline', loading: true, error: null, eventCursor: 0 };
const StoreContext = createContext<Store | null>(null);

function reducer(state: State, action: Action): State {
  if (action.type === 'connection') return action.connection
    ? { ...state, connection: action.connection, loading: false, error: null, connectionPhase: 'connecting', connected: false }
    : { ...initialState, loading: false };
  if (action.type === 'state') return { ...state, data: action.data, loading: false, error: null };
  if (action.type === 'event') return { ...state, eventCursor: Math.max(state.eventCursor, action.event.id || 0), ...(action.event.type === 'state' ? { data: action.event.data } : {}) };
  if (action.type === 'loading') return { ...state, loading: action.loading };
  if (action.type === 'error') return { ...state, error: action.error, loading: false };
  if (action.type === 'phase') return { ...state, connectionPhase: action.phase, connected: action.phase === 'live' };
  return state;
}

export function MobileProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const streamRef = useRef<StreamHandle | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const eventCursorRef = useRef(0);

  const stopLiveConnection = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
  }, []);

  const disconnect = useCallback(async () => {
    stopLiveConnection();
    await clearConnection();
    dispatch({ type: 'connection', connection: null });
  }, [stopLiveConnection]);

  const syncState = useCallback(async (quiet = false) => {
    if (!state.connection) return;
    if (!quiet) dispatch({ type: 'loading', loading: true });
    try {
      dispatch({ type: 'state', data: await loadState(state.connection) });
    } catch (error) {
      if (error instanceof MobileApiError && error.status === 401) {
        await disconnect();
        throw error;
      }
      if (!quiet) dispatch({ type: 'error', error: error instanceof Error ? error.message : '无法连接 AOD。' });
      throw error;
    }
  }, [disconnect, state.connection]);

  const refresh = useCallback(() => syncState(false), [syncState]);
  const connect = useCallback((connection: MobileConnection) => dispatch({ type: 'connection', connection }), []);

  const signOut = useCallback(async () => {
    await disconnect();
  }, [disconnect]);

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
    if (!state.connection) return undefined;
    let active = true;
    let appState = AppState.currentState;
    const connection = state.connection;

    const requestSnapshot = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void syncState(true).catch(scheduleRetry);
      }, 180);
    };

    const scheduleRetry = (reason: unknown) => {
      if (!active || appState !== 'active' || retryTimerRef.current) return;
      streamRef.current?.close();
      streamRef.current = null;
      dispatch({ type: 'phase', phase: 'reconnecting' });
      const delay = retryDelayMs(retryAttemptRef.current++);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void start('reconnecting');
      }, delay);
      if (reason instanceof MobileApiError && reason.status === 401) void disconnect();
    };

    const consumeEvent = (event: StreamEvent) => {
      eventCursorRef.current = Math.max(eventCursorRef.current, event.id || 0);
      dispatch({ type: 'event', event });
      dispatch({ type: 'phase', phase: 'live' });
      if (event.type !== 'state') requestSnapshot();
    };

    async function start(phase: Extract<ConnectionPhase, 'connecting' | 'reconnecting'>) {
      if (!active || appState !== 'active') return;
      streamRef.current?.close();
      streamRef.current = null;
      dispatch({ type: 'phase', phase });
      try {
        await syncState(true);
        if (!active || appState !== 'active') return;
        retryAttemptRef.current = 0;
        streamRef.current = connectMobileStream(connection, eventCursorRef.current, consumeEvent, scheduleRetry);
      } catch (error) {
        scheduleRetry(error);
      }
    }

    void start('connecting');
    const subscription = AppState.addEventListener('change', next => {
      appState = next;
      if (next === 'active') {
        retryAttemptRef.current = 0;
        void start('connecting');
      } else {
        stopLiveConnection();
        dispatch({ type: 'phase', phase: 'offline' });
      }
    });
    return () => {
      active = false;
      subscription.remove();
      stopLiveConnection();
    };
  }, [disconnect, state.connection, stopLiveConnection, syncState]);

  const value = useMemo<Store>(() => ({ ...state, connect, refresh, signOut, runAction }), [connect, refresh, runAction, signOut, state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useMobile() {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useMobile must be used inside MobileProvider.');
  return value;
}
