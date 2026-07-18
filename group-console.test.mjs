import assert from 'node:assert/strict';
import test from 'node:test';
import * as groupConsole from './ui/group-console.js';

test('shows active group turns in the timeline before the first completed message', () => {
  assert.equal(typeof groupConsole.buildGroupTimelineItems, 'function');

  const items = groupConsole.buildGroupTimelineItems({
    messages: [],
    turns: [{
      id: 'GT-001',
      member_id: 'G-001-M1',
      round: 1,
      phase: 'proposal',
      status: 'running',
      created_at: '2026-07-18T15:48:50.000Z',
      started_at: '2026-07-18T15:48:51.000Z'
    }],
    nowMs: Date.parse('2026-07-18T15:50:51.000Z')
  });

  assert.deepEqual(items, [{
    kind: 'turn_status',
    key: 'turn:GT-001',
    turnId: 'GT-001',
    senderMemberId: 'G-001-M1',
    round: 1,
    phase: 'proposal',
    status: 'running',
    at: '2026-07-18T15:48:51.000Z',
    elapsedMs: 120000
  }]);
});
