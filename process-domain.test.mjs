import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProcessMetrics, classifyInterruptedProcess } from './process-domain.mjs';

test('classifies interrupted process leases without reporting completion', () => {
  const at = '2026-07-18T10:00:00.000Z';

  assert.equal(classifyInterruptedProcess({ status: 'running', pid: null, lease_expires_at: at }, { alive: false }, at), 'stale');
  assert.equal(classifyInterruptedProcess({ status: 'running', pid: 100, lease_expires_at: '2026-07-18T10:00:10.000Z' }, { alive: true }, at), 'live');
  assert.equal(classifyInterruptedProcess({ status: 'running', pid: 101, lease_expires_at: '2026-07-18T09:59:59.000Z' }, { alive: true }, at), 'unverifiable');
  assert.equal(classifyInterruptedProcess({ status: 'running', pid: 102, lease_expires_at: '2026-07-18T10:00:10.000Z' }, { alive: null }, at), 'unverifiable');
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
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.1
  });
  assert.deepEqual(metrics.adapters, [
    {
      agent: 'claude-code', invocations: 2, terminal: 1, active: 1, succeeded: 0, failed: 1,
      timedOut: 0, retries: 0, successRate: 0, timeoutRate: 0, avgDurationMs: 2000,
      inputTokens: 0, outputTokens: 0, costUsd: 0
    },
    {
      agent: 'codex', invocations: 2, terminal: 2, active: 0, succeeded: 1, failed: 0,
      timedOut: 1, retries: 1, successRate: 0.5, timeoutRate: 0.5, avgDurationMs: 4000,
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

