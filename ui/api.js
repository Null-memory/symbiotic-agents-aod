export async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

export function connectStream({ onEvent, onConnection }) {
  let source = null;
  let retryTimer = null;
  let lastEventId = sessionStorage.getItem('aod.lastEventId') || '';

  const open = () => {
    const suffix = lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : '';
    source = new EventSource(`/api/stream${suffix}`);
    source.onopen = () => onConnection('online');
    for (const type of ['state', 'event', 'log', 'group_session', 'group_turn', 'group_message', 'task_role']) {
      source.addEventListener(type, event => {
        // Native EventSource uses Last-Event-ID during transport reconnects; this cursor also survives page reloads.
        if (event.lastEventId) {
          lastEventId = event.lastEventId;
          sessionStorage.setItem('aod.lastEventId', lastEventId);
        }
        onEvent(type, event);
      });
    }
    source.onerror = () => {
      onConnection('reconnecting');
      source.close();
      retryTimer = setTimeout(open, 2000);
    };
  };

  open();
  return () => { clearTimeout(retryTimer); source?.close(); };
}
