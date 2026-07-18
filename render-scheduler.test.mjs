import test from 'node:test';
import assert from 'node:assert/strict';
import { captureElementState, createRefreshScheduler, restoreElementState } from './ui/render-scheduler.js';

test('coalesces events inside one refresh window', async () => {
  let calls = 0;
  const scheduler = createRefreshScheduler(async () => { calls += 1; }, { delay: 10 });
  scheduler.schedule('state');
  scheduler.schedule('log');
  scheduler.schedule('group_message');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls, 1);
});

test('runs one trailing refresh when an event arrives during refresh', async () => {
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const scheduler = createRefreshScheduler(async () => {
    calls += 1;
    if (calls === 1) await blocked;
  }, { delay: 1 });
  scheduler.schedule('state');
  await new Promise(resolve => setTimeout(resolve, 8));
  scheduler.schedule('log');
  release();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 2);
});

test('captures and restores input and scroll state', () => {
  const input = {
    id: 'message', value: 'draft', selectionStart: 2, selectionEnd: 4,
    focusCalled: false,
    focus() { this.focusCalled = true; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  };
  const root = { scrollTop: 88, querySelector: selector => selector === '#message' ? input : null };
  const snapshot = captureElementState(root, '#message');
  assert.deepEqual(snapshot, { scrollTop: 88, input: { id: 'message', value: 'draft', selectionStart: 2, selectionEnd: 4 } });

  root.scrollTop = 0;
  input.value = '';
  restoreElementState(root, '#message', snapshot, callback => callback());
  assert.equal(root.scrollTop, 88);
  assert.equal(input.value, 'draft');
  assert.equal(input.focusCalled, true);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 4]);
});
