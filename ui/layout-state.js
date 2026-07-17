export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 360;
export const APP_VIEWS = ['runs', 'groups', 'tasks', 'delivery'];

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
    taskId: params.get('task') || null
  };
}

export function isViewActive(panelView, routeView) {
  return panelView === routeView;
}

export function serializeRoute(route = {}) {
  const params = new URLSearchParams({ view: route.view || 'runs' });
  if (route.runId) params.set('run', route.runId);
  if (route.taskId) params.set('task', route.taskId);
  return `#/${params}`;
}
