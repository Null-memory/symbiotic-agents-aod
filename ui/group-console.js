export function projectAgentStream(events = []) {
  let text = '';
  const tools = new Map();
  const notices = [];
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    if (event.kind === 'text_delta') {
      text += event.text_delta || '';
      continue;
    }
    if (event.kind === 'warning' || event.kind === 'status') {
      notices.push(event);
      continue;
    }
    if (!event.kind?.startsWith('tool_')) continue;
    const id = event.tool_call_id || `event-${event.id}`;
    const current = tools.get(id) || {
      id,
      toolName: event.tool_name || 'tool',
      summary: event.summary || event.tool_name || 'tool',
      status: 'running',
      startedAt: event.at || null,
      finishedAt: null,
      details: []
    };
    current.toolName = event.tool_name || current.toolName;
    current.summary = event.summary || current.summary;
    if (event.kind === 'tool_completed') {
      current.status = 'completed';
      current.finishedAt = event.at || current.finishedAt;
    } else if (event.kind === 'tool_progress') current.status = 'running';
    if (event.detail != null) current.details.push(event.detail);
    tools.set(id, current);
  }
  return { text, tools: [...tools.values()], notices };
}

export async function loadAgentStreamPages(fetchPage, { after = 0, pageSize = 1000, cursor = 'id' } = {}) {
  const events = [];
  let next = Math.max(0, Number(after) || 0);
  const limit = Math.max(1, Number(pageSize) || 1000);
  while (true) {
    const page = await fetchPage(next, limit);
    if (!Array.isArray(page)) throw new Error('Agent stream page must be an array.');
    events.push(...page);
    if (page.length < limit) break;
    const candidate = Number(page.at(-1)?.[cursor]);
    if (!Number.isFinite(candidate) || candidate <= next) break;
    next = candidate;
  }
  return events;
}

export function latestAgentProcessEvents(events = []) {
  const ordered = [...events].sort((left, right) => left.id - right.id);
  const processId = ordered.at(-1)?.process_id;
  return processId ? ordered.filter(event => event.process_id === processId) : ordered;
}

export function buildGroupTimelineItems({ messages = [], turns = [], streamEvents = [], nowMs = Date.now() } = {}) {
  const items = messages.map(message => ({ kind: 'message', key: `message:${message.id}`, ...message }));
  const activeStatuses = new Set(['queued', 'running', 'recovery_required']);

  for (const turn of turns) {
    if (!activeStatuses.has(turn.status)) continue;
    const at = turn.started_at || turn.created_at;
    const startedMs = Date.parse(at);
    const projection = projectAgentStream(streamEvents.filter(event => event.entity_id === turn.id));
    const item = {
      kind: 'turn_status',
      key: `turn:${turn.id}`,
      turnId: turn.id,
      senderMemberId: turn.member_id,
      round: turn.round,
      phase: turn.phase,
      status: turn.status,
      at,
      elapsedMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0
    };
    if (projection.text || projection.tools.length || projection.notices.length) item.stream = projection;
    items.push(item);
  }

  return items;
}

export function createGroupConsole({ root }) {
  function setActivePane(name) {
    root.dataset.activePane = name;
    root.querySelectorAll('[data-group-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.groupTab === name)));
  }

  root.addEventListener('click', event => {
    const tab = event.target.closest('[data-group-tab]');
    if (tab) setActivePane(tab.dataset.groupTab);
  });

  return { setActivePane };
}
