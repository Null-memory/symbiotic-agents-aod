export function buildGroupTimelineItems({ messages = [], turns = [], nowMs = Date.now() } = {}) {
  const items = messages.map(message => ({ kind: 'message', key: `message:${message.id}`, ...message }));
  const activeStatuses = new Set(['queued', 'running', 'recovery_required']);

  for (const turn of turns) {
    if (!activeStatuses.has(turn.status)) continue;
    const at = turn.started_at || turn.created_at;
    const startedMs = Date.parse(at);
    items.push({
      kind: 'turn_status',
      key: `turn:${turn.id}`,
      turnId: turn.id,
      senderMemberId: turn.member_id,
      round: turn.round,
      phase: turn.phase,
      status: turn.status,
      at,
      elapsedMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0
    });
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
