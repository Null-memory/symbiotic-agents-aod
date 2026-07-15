import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInspectorWidth, parseRoute, serializeRoute } from './ui/layout-state.js';

test('clamps inspector width to the desktop range', () => {
  assert.equal(clampInspectorWidth(null), 360);
  assert.equal(clampInspectorWidth(''), 360);
  assert.equal(clampInspectorWidth(120), 280);
  assert.equal(clampInspectorWidth(420), 420);
  assert.equal(clampInspectorWidth(900), 560);
});

test('round trips run and task selection through the hash route', () => {
  const route = { view: 'runs', runId: 'run-42', taskId: 'task-7' };
  assert.deepEqual(parseRoute(serializeRoute(route)), route);
});
