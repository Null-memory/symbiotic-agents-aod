import assert from 'node:assert/strict';
import test from 'node:test';
import * as groupConsole from './ui/group-console.js';

test('projects streamed text and collapsible tool lifecycle events', () => {
  assert.equal(typeof groupConsole.projectAgentStream, 'function');
  const projection = groupConsole.projectAgentStream([
    { id: 1, kind: 'text_delta', text_delta: 'Checking ' },
    { id: 2, kind: 'tool_started', tool_call_id: 'tool-1', tool_name: 'Read', summary: 'Read', detail: { input: { file: 'server.mjs' } }, at: '2026-07-19T01:00:00.000Z' },
    { id: 3, kind: 'text_delta', text_delta: 'done.' },
    { id: 4, kind: 'tool_completed', tool_call_id: 'tool-1', tool_name: 'Read', summary: 'Read completed', detail: { output: 'contents' }, at: '2026-07-19T01:00:01.000Z' },
  ]);

  assert.equal(projection.text, 'Checking done.');
  assert.deepEqual(projection.tools, [{
    id: 'tool-1',
    toolName: 'Read',
    summary: 'Read completed',
    status: 'completed',
    startedAt: '2026-07-19T01:00:00.000Z',
    finishedAt: '2026-07-19T01:00:01.000Z',
    details: [{ input: { file: 'server.mjs' } }, { output: 'contents' }]
  }]);
});

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

test('loads every persisted stream page using the correct cursor', async () => {
  assert.equal(typeof groupConsole.loadAgentStreamPages, 'function');
  const events = [1, 2, 3, 4, 5].map(id => ({ id, sequence: id, kind: 'text_delta', text_delta: String(id) }));
  const cursors = [];
  const loaded = await groupConsole.loadAgentStreamPages(async (after, limit) => {
    cursors.push(after);
    return events.filter(event => event.id > after).slice(0, limit);
  }, { pageSize: 2 });

  assert.deepEqual(loaded, events);
  assert.deepEqual(cursors, [0, 2, 4]);
});

test('projects only the latest task process instead of concatenating retries and role stages', () => {
  assert.equal(typeof groupConsole.latestAgentProcessEvents, 'function');
  const events = [
    { id: 1, process_id: 'AP-old', kind: 'text_delta', text_delta: 'old retry' },
    { id: 2, process_id: 'AP-current', kind: 'status', summary: 'repair started' },
    { id: 3, process_id: 'AP-current', kind: 'text_delta', text_delta: 'current repair' }
  ];

  assert.deepEqual(groupConsole.latestAgentProcessEvents(events), events.slice(1));
});
