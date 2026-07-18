import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionState } from './ui/action-feedback.js';

test('action state exposes pending and persistent failure text', () => {
  const state = createActionState();
  state.start('task-1:merge', '正在合并');
  assert.equal(state.get('task-1:merge').status, 'pending');
  state.fail('task-1:merge', new Error('branch is stale'));
  assert.deepEqual(state.get('task-1:merge'), { status: 'error', message: 'branch is stale' });
});

test('success expires only after the requested duration', () => {
  const timers = [];
  const state = createActionState({ setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer: () => {} });
  state.succeed('task-1:verify', '验收通过', 2000);
  assert.equal(state.get('task-1:verify').message, '验收通过');
  timers[0]();
  assert.equal(state.get('task-1:verify'), null);
});

test('starting a new attempt clears the previous error', () => {
  const state = createActionState();
  state.fail('publish', 'network unavailable');
  state.start('publish');
  assert.equal(state.get('publish').status, 'pending');
  assert.equal(state.get('publish').message, '处理中');
});
