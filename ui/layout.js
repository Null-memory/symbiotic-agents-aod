import { createContextDock } from './context-dock.js';
import { isViewActive, normalizeViewMode, parseRoute, serializeRoute } from './layout-state.js';

const safeStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
};

export function createLayout({ onRouteChange = () => {} } = {}) {
  const shell = document.querySelector('#appShell');
  const navButton = document.querySelector('#toggleNav');
  const workspace = document.querySelector('#workspaceMain');
  const viewModeSwitch = document.querySelector('#viewModeSwitch');
  const viewScrollPositions = new Map();
  let viewMode = normalizeViewMode(safeStorage.get('aod.workspaceViewMode'));
  const contextDock = createContextDock({
    shell,
    root: document.querySelector('#contextInspector'),
    handle: document.querySelector('#inspectorResizeHandle'),
    collapseButton: document.querySelector('#collapseInspector'),
    expandButton: document.querySelector('#expandInspector'),
    widthLabel: document.querySelector('#inspectorWidthLabel')
  });

  const setNavCollapsed = collapsed => {
    shell.classList.toggle('is-nav-collapsed', collapsed);
    navButton.setAttribute('aria-expanded', String(!collapsed));
    navButton.setAttribute('aria-label', collapsed ? '展开导航' : '收起导航');
    navButton.title = collapsed ? '展开导航' : '收起导航';
    safeStorage.set('aod.navCollapsed', collapsed ? '1' : '0');
  };

  const rememberSplitScroll = () => {
    if (viewMode !== 'split') return;
    const currentPanel = document.querySelector('[data-view-panel].active');
    if (currentPanel) viewScrollPositions.set(currentPanel.dataset.viewPanel, workspace.scrollTop);
  };

  const revealView = (view, behavior = 'smooth') => {
    document.querySelector(`[data-view-panel="${view}"]`)?.scrollIntoView({ behavior, block: 'start' });
  };

  const renderViewMode = () => {
    shell.classList.toggle('is-view-mode-all', viewMode === 'all');
    viewModeSwitch.querySelectorAll('[data-view-mode]').forEach(button => {
      const active = button.dataset.viewMode === viewMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };

  const renderRoute = (route, { rememberScroll = true, reveal = false } = {}) => {
    if (rememberScroll) rememberSplitScroll();
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === route.view));
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('active', isViewActive(panel.dataset.viewPanel, route.view, viewMode)));
    if (viewMode === 'split') workspace.scrollTop = viewScrollPositions.get(route.view) || 0;
    else if (reveal) requestAnimationFrame(() => revealView(route.view));
    onRouteChange(route);
  };

  const setRoute = (route, { replace = false, reveal = viewMode === 'all' } = {}) => {
    const next = serializeRoute(route);
    if (location.hash !== next) history[replace ? 'replaceState' : 'pushState'](null, '', next);
    renderRoute(parseRoute(next), { reveal });
  };

  const setViewMode = value => {
    const nextMode = normalizeViewMode(value);
    if (nextMode === viewMode) return;
    rememberSplitScroll();
    viewMode = nextMode;
    safeStorage.set('aod.workspaceViewMode', viewMode);
    renderViewMode();
    renderRoute(parseRoute(location.hash), { rememberScroll: false, reveal: viewMode === 'all' });
  };

  setNavCollapsed(safeStorage.get('aod.navCollapsed') === '1');
  renderViewMode();
  navButton.addEventListener('click', () => setNavCollapsed(!shell.classList.contains('is-nav-collapsed')));
  viewModeSwitch.addEventListener('click', event => {
    const button = event.target.closest('[data-view-mode]');
    if (button) setViewMode(button.dataset.viewMode);
  });

  document.querySelector('#appNav').addEventListener('click', event => {
    const item = event.target.closest('[data-view]');
    if (!item) return;
    setRoute({ view: item.dataset.view });
  });

  document.querySelector('.inspector-tabs')?.addEventListener('click', event => {
    const tab = event.target.closest('[data-inspector-tab]');
    if (!tab) return;
    const name = tab.dataset.inspectorTab;
    document.querySelectorAll('[data-inspector-tab]').forEach(item => { item.classList.toggle('active', item === tab); item.setAttribute('aria-selected', String(item === tab)); });
    document.querySelectorAll('[data-inspector-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.inspectorPanel === name));
  });

  window.addEventListener('hashchange', () => renderRoute(parseRoute(location.hash), { reveal: viewMode === 'all' }));
  renderRoute(parseRoute(location.hash), { reveal: viewMode === 'all' });

  return {
    contextDock,
    applyWidth: contextDock.applyWidth,
    setInspectorCollapsed: collapsed => collapsed ? contextDock.collapse() : contextDock.expand(),
    setNavCollapsed,
    setRoute,
    setViewMode,
    getRoute: () => parseRoute(location.hash),
    getViewMode: () => viewMode,
    getInspectorWidth: () => contextDock.getState().width
  };
}
