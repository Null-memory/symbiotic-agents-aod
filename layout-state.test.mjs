import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_VIEWS,
  CONTEXT_TABS,
  VIEW_MODES,
  clampInspectorWidth,
  createWorkbenchState,
  isViewActive,
  normalizeContextTab,
  normalizeViewMode,
  parseRoute,
  serializeRoute,
  updateContextState
} from './ui/layout-state.js';

test('clamps inspector width to the desktop range', () => {
  assert.equal(clampInspectorWidth(null), 360);
  assert.equal(clampInspectorWidth(''), 360);
  assert.equal(clampInspectorWidth(120), 280);
  assert.equal(clampInspectorWidth(420), 420);
  assert.equal(clampInspectorWidth(900), 560);
});

test('round trips run and task selection through the hash route', () => {
  const route = { view: 'runs', runId: 'run-42', taskId: 'task-7', sessionId: null };
  assert.deepEqual(parseRoute(serializeRoute(route)), route);
});

test('round trips group session context through the hash route', () => {
  const route = { view: 'groups', runId: null, taskId: null, sessionId: 'session-9' };
  assert.deepEqual(parseRoute(serializeRoute(route)), route);
});

test('normalizes unsupported context tabs to task', () => {
  assert.deepEqual(CONTEXT_TABS, ['discussion', 'task', 'acceptance']);
  assert.equal(normalizeContextTab('discussion'), 'discussion');
  assert.equal(normalizeContextTab('unknown'), 'task');
});

test('keeps independent discussion and task dock widths', () => {
  let state = createWorkbenchState({ contextWidths: { discussion: 500, task: 330 } });
  state = updateContextState(state, { tab: 'discussion', width: 520 });
  state = updateContextState(state, { tab: 'task' });
  assert.equal(state.width, 330);
  assert.equal(state.contextWidths.discussion, 520);
});

test('stores independent dock scroll positions', () => {
  let state = createWorkbenchState();
  state = updateContextState(state, { tab: 'discussion', scrollTop: 640 });
  state = updateContextState(state, { tab: 'acceptance', scrollTop: 140 });
  assert.equal(state.contextScroll.discussion, 640);
  assert.equal(state.contextScroll.acceptance, 140);
});

test('only activates a panel whose view exactly matches the route', () => {
  assert.deepEqual(APP_VIEWS, ['runs', 'groups', 'tasks', 'delivery']);
  assert.equal(isViewActive('groups', 'groups', 'split'), true);
  assert.equal(isViewActive('runs', 'groups', 'split'), false);
  assert.equal(isViewActive('delivery', 'groups', 'split'), false);
});

test('normalizes workspace view modes', () => {
  assert.deepEqual(VIEW_MODES, ['split', 'all']);
  assert.equal(normalizeViewMode('all'), 'all');
  assert.equal(normalizeViewMode('split'), 'split');
  assert.equal(normalizeViewMode('unknown'), 'split');
  assert.equal(normalizeViewMode(null), 'split');
});

test('all mode activates every primary workspace panel', () => {
  for (const view of APP_VIEWS) assert.equal(isViewActive(view, 'groups', 'all'), true);
  assert.equal(isViewActive('unknown', 'groups', 'all'), false);
});

test('falls back to runs for an unknown view', () => {
  assert.equal(parseRoute('#/view=unknown').view, 'runs');
});
