import SSE from 'react-native-sse';
import type { MobileConnection, StreamEvent } from './types';

export type StreamHandle = { close: () => void };

export function connectMobileStream(connection: MobileConnection, after: number, onEvent: (event: StreamEvent) => void, onError: (error: Error) => void): StreamHandle {
  const url = `${connection.baseUrl.replace(/\/$/, '')}/api/stream?after=${Math.max(0, after)}`;
  const source = new SSE<'state' | 'event' | 'workspace' | 'process' | 'group_session' | 'group_turn' | 'group_message' | 'task_role' | 'agent_stream'>(url, { headers: { authorization: `Bearer ${connection.token}`, 'last-event-id': String(Math.max(0, after)) }, timeout: 0 });
  const consume = (type: string, event: unknown) => {
    const message = event as { lastEventId?: string | null; data?: string | null };
    try { onEvent({ id: Number(message.lastEventId || 0), type, data: JSON.parse(message.data || '{}') }); } catch (error) { onError(error instanceof Error ? error : new Error('无法解析实时事件。')); }
  };
  for (const type of ['state', 'event', 'workspace', 'process', 'group_session', 'group_turn', 'group_message', 'task_role', 'agent_stream'] as const) source.addEventListener(type, event => consume(type, event));
  source.addEventListener('message', event => consume('message', event));
  source.addEventListener('error', () => onError(new Error('实时连接已断开，正在重试。')));
  return { close: () => source.close() };
}
