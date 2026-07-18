import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, searchEntities } from './ui/command-search.js';

test('search returns tasks with navigation and context', () => {
  const index = buildSearchIndex({
    runs: [],
    tasks: [{ id: 'task-1', title: 'SQLite recovery', status: 'running', run_id: 'run-1' }],
    groups: [], groupSessions: [], adapters: []
  });
  const result = searchEntities(index, 'sqlite')[0];
  assert.deepEqual(result.route, { view: 'tasks', runId: 'run-1', taskId: 'task-1' });
  assert.equal(result.contextTab, 'task');
});

test('search matches multiple terms regardless of order', () => {
  const index = buildSearchIndex({
    runs: [{ id: 'run-7', title: 'GitHub delivery', status: 'published' }],
    tasks: [], groups: [], groupSessions: [], adapters: []
  });
  assert.equal(searchEntities(index, 'published github')[0].id, 'run-7');
});

test('group sessions open discussion context', () => {
  const index = buildSearchIndex({
    runs: [], tasks: [], groups: [],
    groupSessions: [{ id: 'session-2', group_id: 'group-1', requirement: 'Review architecture', status: 'discussing' }],
    adapters: []
  });
  const result = searchEntities(index, 'architecture')[0];
  assert.equal(result.contextTab, 'discussion');
  assert.deepEqual(result.route, { view: 'groups', sessionId: 'session-2' });
});
