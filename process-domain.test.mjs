import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProcessMetrics, classifyInterruptedProcess } from './process-domain.mjs';
import * as processDomain from './process-domain.mjs';

test('normalizes Codex JSONL into text, tool, and usage events across chunk boundaries', () => {
  assert.equal(typeof processDomain.createAgentStreamParser, 'function');
  const events = [];
  const parser = processDomain.createAgentStreamParser({ protocol: 'codex-jsonl', onEvent: event => events.push(event) });

  parser.push('stdout', '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"git status","status":"in_progress"}}\n{"type":"item.comp');
  parser.push('stdout', 'leted","item":{"id":"item_0","type":"command_execution","command":"git status","aggregated_output":"clean","exit_code":0,"status":"completed"}}\n');
  parser.push('stdout', '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Repository is clean."}}\n{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}\n');
  parser.end();

  assert.deepEqual(events.map(event => event.kind), ['tool_started', 'tool_completed', 'text_delta', 'usage']);
  assert.equal(events[0].summary, 'git status');
  assert.equal(events[1].detail.aggregated_output, 'clean');
  assert.equal(events[2].text, 'Repository is clean.');
  assert.deepEqual(events[3].detail, { input_tokens: 12, output_tokens: 4 });
  assert.equal(parser.finalText(), 'Repository is clean.');
});

test('normalizes Claude partial text and expandable tool events', () => {
  assert.equal(typeof processDomain.createAgentStreamParser, 'function');
  const events = [];
  const parser = processDomain.createAgentStreamParser({ protocol: 'claude-stream-json', onEvent: event => events.push(event) });

  parser.push('stdout', [
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'server.mjs' } } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking ' } } }),
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the server.' } } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] } }),
  ].join('\n') + '\n');
  parser.end();

  assert.deepEqual(events.map(event => event.kind), ['tool_started', 'tool_progress', 'text_delta', 'text_delta', 'tool_completed']);
  assert.equal(events[0].toolName, 'Read');
  assert.deepEqual(events[0].detail.input, { file_path: 'server.mjs' });
  assert.equal(events[1].toolCallId, 'tool-1');
  assert.equal(events[1].toolName, 'Read');
  assert.equal(events[4].summary, 'Read completed');
  assert.equal(parser.finalText(), 'Checking the server.');
});

test('reports the actual model announced by an agent runtime', () => {
  const events = [];
  const parser = processDomain.createAgentStreamParser({ protocol: 'claude-stream-json', onEvent: event => events.push(event) });
  parser.push('stdout', `${JSON.stringify({ type: 'system', subtype: 'init', model: 'provider-mapped-model' })}\n`);
  parser.end();

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'status');
  assert.equal(events[0].actualModel, 'provider-mapped-model');
  assert.match(events[0].summary, /provider-mapped-model/);
});

test('normalizes Codex and Claude usage fields for process metrics', () => {
  assert.equal(typeof processDomain.normalizeAgentUsage, 'function');
  assert.deepEqual(processDomain.normalizeAgentUsage({ input_tokens: 120, output_tokens: 30, cost_usd: 0.04 }), {
    inputTokens: 120, outputTokens: 30, costUsd: 0.04
  });
  assert.deepEqual(processDomain.normalizeAgentUsage({ inputTokens: 75, outputTokens: 25, total_cost_usd: 0.02 }), {
    inputTokens: 75, outputTokens: 25, costUsd: 0.02
  });
  assert.deepEqual(processDomain.normalizeAgentUsage({
    input_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 900,
    output_tokens: 8
  }), { inputTokens: 1020, outputTokens: 8, costUsd: null });
  assert.deepEqual(processDomain.normalizeAgentUsage({}), { inputTokens: null, outputTokens: null, costUsd: null });
});

test('emits Claude result usage as a structured usage event', () => {
  const events = [];
  const parser = processDomain.createAgentStreamParser({ protocol: 'claude-stream-json', onEvent: event => events.push(event) });
  parser.push('stdout', `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', usage: { input_tokens: 42, output_tokens: 7 }, total_cost_usd: 0.01 })}\n`);
  parser.end();

  assert.deepEqual(events.map(event => event.kind), ['text_delta', 'usage', 'status']);
  assert.deepEqual(events[1].detail, { input_tokens: 42, output_tokens: 7, total_cost_usd: 0.01 });
});

test('isolates stream consumer failures so later consumers still receive events', () => {
  assert.equal(typeof processDomain.dispatchAgentStreamEvent, 'function');
  const received = [];
  const failures = [];
  const event = { kind: 'text_delta', text: 'partial reply' };

  processDomain.dispatchAgentStreamEvent(event, [
    () => { throw new Error('task output unavailable'); },
    value => received.push(value)
  ], error => failures.push(error.message));

  assert.deepEqual(received, [event]);
  assert.deepEqual(failures, ['task output unavailable']);
});

test('bounds serialized stream detail including its truncation envelope', () => {
  assert.equal(typeof processDomain.boundAgentStreamDetail, 'function');
  const result = processDomain.boundAgentStreamDetail(JSON.stringify({ output: 'x'.repeat(40000) }), 32768);

  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.json, 'utf8') <= 32768, true);
  assert.equal(JSON.parse(result.json).truncated, true);
});

test('does not treat synthetic process status as Agent output timing', () => {
  assert.equal(typeof processDomain.agentStreamBatchTiming, 'function');
  assert.deepEqual(processDomain.agentStreamBatchTiming([
    { kind: 'status', at: '2026-07-19T05:00:00.000Z', countsForLatency: false }
  ]), { firstEventAt: null, firstTextAt: null, lastOutputAt: null });
  assert.deepEqual(processDomain.agentStreamBatchTiming([
    { kind: 'status', at: '2026-07-19T05:00:00.000Z', countsForLatency: false },
    { kind: 'tool_started', at: '2026-07-19T05:00:00.400Z', countsForLatency: true },
    { kind: 'text_delta', at: '2026-07-19T05:00:01.200Z', countsForLatency: true }
  ]), {
    firstEventAt: '2026-07-19T05:00:00.400Z',
    firstTextAt: '2026-07-19T05:00:01.200Z',
    lastOutputAt: '2026-07-19T05:00:01.200Z'
  });
});

test('batches rapid text deltas before writing task summaries', () => {
  assert.equal(typeof processDomain.createTextBatcher, 'function');
  const flushed = [];
  const scheduled = [];
  const batcher = processDomain.createTextBatcher({
    onFlush: text => flushed.push(text),
    maxBytes: 8,
    schedule: callback => { scheduled.push(callback); return callback; },
    cancel: () => {}
  });

  batcher.append('one');
  batcher.append('two');
  assert.deepEqual(flushed, []);
  assert.equal(scheduled.length, 1);
  batcher.append('!!');
  assert.deepEqual(flushed, ['onetwo!!']);
  batcher.append('tail');
  batcher.flush();
  assert.deepEqual(flushed, ['onetwo!!', 'tail']);
});

test('flushes every registered runtime buffer during graceful shutdown', () => {
  assert.equal(typeof processDomain.createFlushRegistry, 'function');
  const flushed = [];
  const failures = [];
  const registry = processDomain.createFlushRegistry({ onError: error => failures.push(error.message) });
  const unregister = registry.register({ flush: () => flushed.push('stream') });
  registry.register({ flush: () => { throw new Error('closed'); } });

  assert.equal(registry.size, 2);
  assert.equal(registry.flushAll(), 1);
  assert.deepEqual(flushed, ['stream']);
  assert.deepEqual(failures, ['closed']);
  unregister();
  assert.equal(registry.size, 1);
});

test('classifies interrupted process leases without reporting completion', () => {
  const at = '2026-07-18T10:00:00.000Z';

  assert.equal(classifyInterruptedProcess({ status: 'running', pid: null, lease_expires_at: at }, { alive: false }, at), 'stale');
  assert.equal(classifyInterruptedProcess({ status: 'running', pid: 100, lease_expires_at: '2026-07-18T10:00:10.000Z' }, { alive: true }, at), 'live');
  assert.equal(classifyInterruptedProcess({ status: 'running', pid: 101, lease_expires_at: '2026-07-18T09:59:59.000Z' }, { alive: true }, at), 'unverifiable');
  assert.equal(classifyInterruptedProcess({ status: 'running', pid: 102, lease_expires_at: '2026-07-18T10:00:10.000Z' }, { alive: null }, at), 'unverifiable');
});

test('measures first event and first text latency separately from total duration', () => {
  const metrics = buildProcessMetrics([{
    id: 'P-LATENCY', agent: 'codex', kind: 'planner', status: 'succeeded', attempt: 1,
    started_at: '2026-07-18T10:00:00.000Z', first_event_at: '2026-07-18T10:00:00.250Z',
    first_text_at: '2026-07-18T10:00:01.500Z', finished_at: '2026-07-18T10:00:05.000Z'
  }], { from: '2026-07-18T09:59:59.000Z', to: '2026-07-18T10:00:06.000Z' });

  assert.equal(metrics.summary.avgFirstEventMs, 250);
  assert.equal(metrics.summary.avgFirstTextMs, 1500);
});

test('aggregates process outcomes, adapters, runs, failures, and concurrency', () => {
  const metrics = buildProcessMetrics([
    {
      id: 'P-1', agent: 'codex', kind: 'task', run_id: 'RUN-1', status: 'succeeded', attempt: 1,
      started_at: '2026-07-18T10:00:00.000Z', finished_at: '2026-07-18T10:00:04.000Z',
      input_tokens: 100, output_tokens: 50, cost_usd: 0.1
    },
    {
      id: 'P-2', agent: 'codex', kind: 'task', run_id: 'RUN-1', status: 'timed_out', attempt: 2,
      started_at: '2026-07-18T10:00:02.000Z', finished_at: '2026-07-18T10:00:06.000Z', terminal_reason: 'Agent timeout'
    },
    {
      id: 'P-3', agent: 'claude-code', kind: 'role_review', run_id: 'RUN-2', status: 'failed', attempt: 1,
      started_at: '2026-07-18T10:00:05.000Z', finished_at: '2026-07-18T10:00:07.000Z', terminal_reason: 'Exit 7'
    },
    {
      id: 'P-4', agent: 'claude-code', kind: 'group_turn', run_id: null, status: 'running', attempt: 1,
      started_at: '2026-07-18T10:00:08.000Z', finished_at: null
    }
  ], {
    from: '2026-07-18T10:00:00.000Z',
    to: '2026-07-18T10:00:10.000Z',
    maxConcurrency: 2
  });

  assert.deepEqual(metrics.summary, {
    invocations: 4,
    terminal: 3,
    active: 1,
    succeeded: 1,
    failed: 1,
    timedOut: 1,
    cancelled: 0,
    recoveryRequired: 0,
    retries: 1,
    successRate: 1 / 3,
    timeoutRate: 1 / 3,
    avgDurationMs: 10000 / 3,
    avgFirstEventMs: 0,
    avgFirstTextMs: 0,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.1
  });
  assert.deepEqual(metrics.adapters, [
    {
      agent: 'claude-code', invocations: 2, terminal: 1, active: 1, succeeded: 0, failed: 1,
      timedOut: 0, retries: 0, successRate: 0, timeoutRate: 0, avgDurationMs: 2000,
      avgFirstEventMs: 0, avgFirstTextMs: 0,
      inputTokens: 0, outputTokens: 0, costUsd: 0
    },
    {
      agent: 'codex', invocations: 2, terminal: 2, active: 0, succeeded: 1, failed: 0,
      timedOut: 1, retries: 1, successRate: 0.5, timeoutRate: 0.5, avgDurationMs: 4000,
      avgFirstEventMs: 0, avgFirstTextMs: 0,
      inputTokens: 100, outputTokens: 50, costUsd: 0.1
    }
  ]);
  assert.deepEqual(metrics.runs.map(run => ({ runId: run.runId, invocations: run.invocations, succeeded: run.succeeded, timedOut: run.timedOut })), [
    { runId: 'RUN-1', invocations: 2, succeeded: 1, timedOut: 1 },
    { runId: 'RUN-2', invocations: 1, succeeded: 0, timedOut: 0 }
  ]);
  assert.deepEqual(metrics.failures, [
    { reason: 'Agent timeout', count: 1 },
    { reason: 'Exit 7', count: 1 }
  ]);
  assert.deepEqual(metrics.concurrency, {
    capacity: 2,
    peak: 2,
    activeMs: 12000,
    utilization: 0.6
  });
});
