const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'recovery_required']);

export function dispatchAgentStreamEvent(event, consumers = [], onError = () => {}) {
  for (const consumer of consumers) {
    if (typeof consumer !== 'function') continue;
    try { consumer(event); }
    catch (error) {
      try { onError(error); } catch {}
    }
  }
}

export function boundAgentStreamDetail(serialized, maxBytes = 32768) {
  const value = serialized == null ? '' : String(serialized);
  const limit = Math.max(32, Number(maxBytes) || 32768);
  if (Buffer.byteLength(value, 'utf8') <= limit) return { json: value || null, truncated: false };
  let low = 0;
  let high = value.length;
  let json = JSON.stringify({ truncated: true, preview: '' });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ truncated: true, preview: value.slice(0, middle) });
    if (Buffer.byteLength(candidate, 'utf8') <= limit) {
      json = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { json, truncated: true };
}

export function agentStreamBatchTiming(events = []) {
  const agentEvents = events.filter(event => event.countsForLatency !== false);
  return {
    firstEventAt: agentEvents[0]?.at || null,
    firstTextAt: agentEvents.find(event => event.kind === 'text_delta')?.at || null,
    lastOutputAt: agentEvents.at(-1)?.at || null
  };
}

export function createTextBatcher({
  onFlush = () => {}, onError = () => {}, maxBytes = 8192, delayMs = 100,
  schedule = (callback, delay) => setTimeout(callback, delay), cancel = timer => clearTimeout(timer)
} = {}) {
  const byteLimit = Math.max(1, Number(maxBytes) || 8192);
  let pending = '';
  let timer = null;
  const flush = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    if (!pending) return;
    const text = pending;
    pending = '';
    try { onFlush(text); } catch (error) { try { onError(error); } catch {} }
  };
  const append = value => {
    const text = String(value || '');
    if (!text) return;
    pending += text;
    if (Buffer.byteLength(pending, 'utf8') >= byteLimit) flush();
    else if (timer === null) {
      timer = schedule(flush, Math.max(0, Number(delayMs) || 0));
      timer?.unref?.();
    }
  };
  return { append, flush };
}

export function createFlushRegistry({ onError = () => {} } = {}) {
  const entries = new Set();
  return {
    register(entry) {
      if (!entry || typeof entry.flush !== 'function') throw new Error('Flush registry entries require flush().');
      entries.add(entry);
      return () => entries.delete(entry);
    },
    flushAll() {
      let flushed = 0;
      for (const entry of entries) {
        try { entry.flush(); flushed += 1; }
        catch (error) { try { onError(error); } catch {} }
      }
      return flushed;
    },
    get size() { return entries.size; }
  };
}

export function normalizeAgentUsage(detail = {}) {
  const finite = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  const directInput = finite(detail.input_tokens ?? detail.inputTokens);
  const cacheCreation = finite(detail.cache_creation_input_tokens ?? detail.cacheCreationInputTokens);
  const cacheRead = finite(detail.cache_read_input_tokens ?? detail.cacheReadInputTokens);
  const inputParts = [directInput, cacheCreation, cacheRead].filter(value => value !== null);
  return {
    inputTokens: inputParts.length ? inputParts.reduce((total, value) => total + value, 0) : null,
    outputTokens: finite(detail.output_tokens ?? detail.outputTokens),
    costUsd: finite(detail.cost_usd ?? detail.costUsd ?? detail.total_cost_usd)
  };
}

function eventSummary(item = {}) {
  if (item.command) return String(item.command);
  if (item.name) return String(item.name);
  if (item.tool_name) return String(item.tool_name);
  if (item.server && item.tool) return `${item.server}.${item.tool}`;
  return String(item.type || 'tool');
}

export function createAgentStreamParser({ protocol = 'text', onEvent = () => {} } = {}) {
  const buffers = { stdout: '', stderr: '' };
  const claudeTools = new Map();
  const claudeToolsByIndex = new Map();
  let text = '';

  const emit = event => onEvent(event);
  const emitText = value => {
    const delta = String(value || '');
    if (!delta) return;
    text += delta;
    emit({ kind: 'text_delta', text: delta });
  };

  const codex = record => {
    const item = record?.item || {};
    if (record?.type === 'item.started' && item.type !== 'agent_message') {
      emit({ kind: 'tool_started', toolCallId: item.id || null, toolName: item.type || 'tool', summary: eventSummary(item), detail: item });
    } else if (record?.type === 'item.completed' && item.type === 'agent_message') {
      emitText(item.text);
    } else if (record?.type === 'item.completed') {
      emit({ kind: 'tool_completed', toolCallId: item.id || null, toolName: item.type || 'tool', summary: eventSummary(item), detail: item });
    } else if (record?.type === 'turn.completed') {
      emit({ kind: 'usage', summary: 'Token usage', detail: record.usage || {} });
    } else if (record?.type === 'error' || record?.type === 'turn.failed') {
      emit({ kind: 'warning', summary: String(record.message || record.error?.message || 'Codex reported an error.'), detail: record });
    } else if (record?.type === 'thread.started' || record?.type === 'turn.started') {
      emit({ kind: 'status', summary: record.type === 'thread.started' ? 'Codex session started' : 'Codex is working', detail: record });
    }
  };

  const claude = record => {
    if (record?.type === 'stream_event') {
      const event = record.event || {};
      const block = event.content_block || {};
      const delta = event.delta || {};
      if (event.type === 'content_block_start' && block.type === 'tool_use') {
        const tool = { id: block.id || null, name: block.name || 'tool', input: block.input || {} };
        claudeTools.set(block.id, tool);
        if (event.index !== undefined) claudeToolsByIndex.set(event.index, tool);
        emit({ kind: 'tool_started', toolCallId: block.id || null, toolName: block.name || 'tool', summary: block.name || 'tool', detail: block });
      } else if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
        emitText(delta.text);
      } else if (event.type === 'content_block_delta' && delta.type === 'input_json_delta') {
        const tool = claudeToolsByIndex.get(event.index) || { id: block.id || null, name: block.name || 'tool' };
        emit({ kind: 'tool_progress', toolCallId: tool.id, toolName: tool.name, summary: 'Preparing tool input', detail: delta });
      }
      return;
    }
    if (record?.type === 'user') {
      for (const block of record.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const tool = claudeTools.get(block.tool_use_id) || { name: 'tool' };
        emit({ kind: 'tool_completed', toolCallId: block.tool_use_id || null, toolName: tool.name, summary: `${tool.name} completed`, detail: block });
      }
      return;
    }
    if (record?.type === 'result') {
      if (!text && typeof record.result === 'string') emitText(record.result);
      if (record.usage || record.total_cost_usd !== undefined) {
        emit({ kind: 'usage', summary: 'Token usage', detail: { ...(record.usage || {}), ...(record.total_cost_usd !== undefined ? { total_cost_usd: record.total_cost_usd } : {}) } });
      }
      emit({ kind: record.subtype === 'success' ? 'status' : 'warning', summary: record.subtype === 'success' ? 'Claude completed' : String(record.error || record.subtype || 'Claude failed'), detail: record });
      return;
    }
    if (record?.type === 'system' && record.subtype === 'init') emit({ kind: 'status', summary: 'Claude session started', detail: record });
  };

  const parseLine = (stream, line) => {
    const value = line.trim();
    if (!value) return;
    if (stream === 'stderr') {
      emit({ kind: 'warning', summary: value.slice(0, 500), detail: { stream, message: value } });
      return;
    }
    let record;
    try { record = JSON.parse(value); }
    catch {
      emit({ kind: 'warning', summary: 'Unstructured agent output', detail: { stream, message: value } });
      return;
    }
    if (protocol === 'codex-jsonl') codex(record);
    else claude(record);
  };

  const push = (stream, chunk) => {
    const value = String(chunk || '');
    if (!value) return;
    if (protocol === 'text') {
      if (stream === 'stdout') emitText(value);
      else emit({ kind: 'warning', summary: value.trim().slice(0, 500), detail: { stream, message: value } });
      return;
    }
    buffers[stream] = `${buffers[stream] || ''}${value}`;
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop() || '';
    for (const line of lines) parseLine(stream, line);
  };

  const end = () => {
    for (const stream of ['stdout', 'stderr']) {
      if (buffers[stream]) parseLine(stream, buffers[stream]);
      buffers[stream] = '';
    }
  };

  return { push, end, finalText: () => text };
}

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
  const latencyFromStart = field => matches
    .map(row => {
      const startedAt = timestamp(row.started_at);
      const reachedAt = timestamp(row[field]);
      return startedAt === null || reachedAt === null ? null : Math.max(0, reachedAt - startedAt);
    })
    .filter(latency => latency !== null);
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
    avgFirstEventMs: average(latencyFromStart('first_event_at')),
    avgFirstTextMs: average(latencyFromStart('first_text_at')),
    inputTokens: matches.reduce((sum, row) => sum + number(row.input_tokens), 0),
    outputTokens: matches.reduce((sum, row) => sum + number(row.output_tokens), 0),
    costUsd: matches.reduce((sum, row) => sum + number(row.cost_usd), 0)
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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
