import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveNextAction, deriveRunStage } from './ui/run-stage.js';

test('shows collaboration while tasks are still running', () => {
  const result = deriveRunStage({ status: 'active' }, [{ status: 'running' }], []);
  assert.equal(result.current, 'collaboration');
  assert.equal(result.stages.find(item => item.key === 'collaboration').state, 'current');
});

test('moves to gates after every task reaches a verified merge state', () => {
  const result = deriveRunStage({ status: 'active' }, [{ status: 'merge_ready' }, { status: 'merged' }], []);
  assert.equal(result.current, 'gates');
  assert.equal(result.stages.find(item => item.key === 'collaboration').state, 'complete');
});

test('does not claim delivery complete before the run is merged', () => {
  const result = deriveRunStage({ status: 'published', ci_status: 'passed' }, [{ status: 'merged' }], []);
  assert.equal(result.current, 'delivery');
  assert.notEqual(result.stages.at(-1).state, 'complete');
});

test('marks a blocked collaboration stage from persisted task state', () => {
  const result = deriveRunStage({ status: 'active' }, [{ status: 'recovery_required' }], []);
  assert.equal(result.current, 'collaboration');
  assert.equal(result.stages.find(item => item.key === 'collaboration').state, 'blocked');
});

test('prioritizes a recovery approval over routine actions', () => {
  const action = deriveNextAction(
    { id: 'run-1' },
    [{ kind: 'task_verify', entityId: 'task-1' }],
    [{ kind: 'task_recovery', entityId: 'task-2', risk: 'high' }]
  );
  assert.equal(action.kind, 'recovery');
  assert.equal(action.entityId, 'task-2');
});

test('returns a publication action when a run is ready', () => {
  const action = deriveNextAction({ id: 'run-1', status: 'ready_to_publish' }, [], []);
  assert.equal(action.kind, 'publish');
  assert.equal(action.label, '发布 GitHub PR');
});
