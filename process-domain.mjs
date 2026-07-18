const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'recovery_required']);

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyInterruptedProcess(record, observation, at = new Date().toISOString()) {
  if (!record?.pid || observation?.alive === false) return 'stale';
  if (observation?.alive !== true) return 'unverifiable';
  const leaseExpiresAt = timestamp(record.lease_expires_at);
  const observedAt = timestamp(at);
  if (leaseExpiresAt !== null && observedAt !== null && leaseExpiresAt >= observedAt) return 'live';
  return 'unverifiable';
}

function aggregate(rows, key, value) {
  const matches = rows.filter(row => row[key] === value);
  const terminal = matches.filter(row => TERMINAL_STATUSES.has(row.status));
  const completedDurations = terminal
    .map(row => {
      const startedAt = timestamp(row.started_at);
      const finishedAt = timestamp(row.finished_at);
      return startedAt === null || finishedAt === null ? null : Math.max(0, finishedAt - startedAt);
    })
    .filter(duration => duration !== null);
  const succeeded = terminal.filter(row => row.status === 'succeeded').length;
  const timedOut = terminal.filter(row => row.status === 'timed_out').length;
  return {
    invocations: matches.length,
    terminal: terminal.length,
    active: matches.filter(row => row.status === 'running').length,
    succeeded,
    failed: terminal.filter(row => row.status === 'failed').length,
    timedOut,
    cancelled: terminal.filter(row => row.status === 'cancelled').length,
    recoveryRequired: terminal.filter(row => row.status === 'recovery_required').length,
    retries: matches.filter(row => number(row.attempt) > 1).length,
    successRate: terminal.length ? succeeded / terminal.length : 0,
    timeoutRate: terminal.length ? timedOut / terminal.length : 0,
    avgDurationMs: completedDurations.length ? completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length : 0,
    inputTokens: matches.reduce((sum, row) => sum + number(row.input_tokens), 0),
    outputTokens: matches.reduce((sum, row) => sum + number(row.output_tokens), 0),
    costUsd: matches.reduce((sum, row) => sum + number(row.cost_usd), 0)
  };
}

function concurrency(rows, from, to, capacity) {
  const events = [];
  for (const row of rows) {
    const startedAt = timestamp(row.started_at);
    const finishedAt = timestamp(row.finished_at) ?? to;
    if (startedAt === null) continue;
    const start = Math.max(from, startedAt);
    const end = Math.min(to, finishedAt);
    if (end <= start) continue;
    events.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let activeMs = 0;
  let peak = 0;
  let previousAt = from;
  for (const event of events) {
    activeMs += active * Math.max(0, event.at - previousAt);
    active += event.delta;
    peak = Math.max(peak, active);
    previousAt = event.at;
  }
  const windowMs = Math.max(0, to - from);
  return {
    capacity,
    peak,
    activeMs,
    utilization: windowMs && capacity ? activeMs / (windowMs * capacity) : 0
  };
}

export function buildProcessMetrics(rows = [], options = {}) {
  const to = timestamp(options.to) ?? Date.now();
  const from = timestamp(options.from) ?? Math.max(0, to - 24 * 60 * 60 * 1000);
  const maxConcurrency = Math.max(1, Math.floor(number(options.maxConcurrency) || 1));
  const selected = rows.filter(row => {
    if (options.runId && row.run_id !== options.runId) return false;
    const startedAt = timestamp(row.started_at);
    const finishedAt = timestamp(row.finished_at) ?? to;
    return startedAt !== null && startedAt < to && finishedAt > from;
  });

  const summary = aggregate(selected, '__all__', undefined);
  const adapters = [...new Set(selected.map(row => row.agent).filter(Boolean))].sort()
    .map(agent => ({ agent, ...aggregate(selected, 'agent', agent) }))
    .map(({ cancelled, recoveryRequired, ...adapter }) => adapter);
  const runs = [...new Set(selected.map(row => row.run_id).filter(Boolean))].sort()
    .map(runId => ({ runId, ...aggregate(selected, 'run_id', runId) }));
  const failureCounts = new Map();
  for (const row of selected) {
    if (!['failed', 'timed_out', 'recovery_required'].includes(row.status)) continue;
    const reason = String(row.terminal_reason || row.status).trim();
    failureCounts.set(reason, (failureCounts.get(reason) || 0) + 1);
  }
  const failures = [...failureCounts].map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));

  return {
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    summary,
    adapters,
    runs,
    failures,
    concurrency: concurrency(selected, from, to, maxConcurrency)
  };
}

