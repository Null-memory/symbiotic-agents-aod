export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 360;
export const APP_VIEWS = ['runs', 'groups', 'tasks', 'delivery'];
export const VIEW_MODES = ['split', 'all'];
export const CONTEXT_TABS = ['discussion', 'task', 'acceptance'];
export const LAYOUT_STORAGE_KEY = 'aod.workbench.v2';

const DEFAULT_CONTEXT_WIDTHS = Object.freeze({ discussion: 500, task: INSPECTOR_DEFAULT });
const DEFAULT_CONTEXT_SCROLL = Object.freeze({ discussion: 0, task: 0, acceptance: 0 });

export function clampInspectorWidth(value) {
  if (value === null || value === undefined || value === '') return INSPECTOR_DEFAULT;
  const width = Number(value);
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT;
  return Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, width));
}

export function parseRoute(hash = '') {
  const params = new URLSearchParams(String(hash).replace(/^#\/?/, ''));
  const requestedView = params.get('view');
  return {
    view: APP_VIEWS.includes(requestedView) ? requestedView : 'runs',
    runId: params.get('run') || null,
    taskId: params.get('task') || null,
    sessionId: params.get('session') || null
  };
}

export function normalizeViewMode(value) {
  return VIEW_MODES.includes(value) ? value : 'split';
}

export function normalizeContextTab(value) {
  return CONTEXT_TABS.includes(value) ? value : 'task';
}

function widthKey(tab) {
  return tab === 'discussion' ? 'discussion' : 'task';
}

export function createWorkbenchState(value = {}) {
  const tab = normalizeContextTab(value.tab);
  const contextWidths = {
    discussion: clampInspectorWidth(value.contextWidths?.discussion ?? DEFAULT_CONTEXT_WIDTHS.discussion),
    task: clampInspectorWidth(value.contextWidths?.task ?? DEFAULT_CONTEXT_WIDTHS.task)
  };
  return {
    version: 2,
    tab,
    collapsed: Boolean(value.collapsed),
    width: contextWidths[widthKey(tab)],
    contextWidths,
    contextScroll: {
      discussion: Math.max(0, Number(value.contextScroll?.discussion) || DEFAULT_CONTEXT_SCROLL.discussion),
      task: Math.max(0, Number(value.contextScroll?.task) || DEFAULT_CONTEXT_SCROLL.task),
      acceptance: Math.max(0, Number(value.contextScroll?.acceptance) || DEFAULT_CONTEXT_SCROLL.acceptance)
    },
    entities: {
      discussion: value.entities?.discussion || null,
      task: value.entities?.task || null,
      acceptance: value.entities?.acceptance || null
    }
  };
}

export function updateContextState(current, patch = {}) {
  const state = createWorkbenchState(current);
  const tab = patch.tab === undefined ? state.tab : normalizeContextTab(patch.tab);
  const contextWidths = { ...state.contextWidths };
  if (patch.width !== undefined) contextWidths[widthKey(tab)] = clampInspectorWidth(patch.width);
  const contextScroll = { ...state.contextScroll };
  if (patch.scrollTop !== undefined) contextScroll[tab] = Math.max(0, Number(patch.scrollTop) || 0);
  const entities = { ...state.entities };
  if (Object.hasOwn(patch, 'entity')) entities[tab] = patch.entity || null;
  return createWorkbenchState({
    tab,
    collapsed: patch.collapsed === undefined ? state.collapsed : Boolean(patch.collapsed),
    contextWidths,
    contextScroll,
    entities
  });
}

export function isViewActive(panelView, routeView, viewMode = 'split') {
  if (normalizeViewMode(viewMode) === 'all') return APP_VIEWS.includes(panelView);
  return panelView === routeView;
}

export function serializeRoute(route = {}) {
  const params = new URLSearchParams({ view: route.view || 'runs' });
  if (route.runId) params.set('run', route.runId);
  if (route.taskId) params.set('task', route.taskId);
  if (route.sessionId) params.set('session', route.sessionId);
  return `#/${params}`;
}
