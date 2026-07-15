import { INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN, clampInspectorWidth, parseRoute, serializeRoute } from './layout-state.js';

const safeStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch {} }
};

export function createLayout({ onRouteChange = () => {} } = {}) {
  const shell = document.querySelector('#appShell');
  const handle = document.querySelector('#inspectorResizeHandle');
  const widthLabel = document.querySelector('#inspectorWidthLabel');
  const collapseButton = document.querySelector('#collapseInspector');
  const expandButton = document.querySelector('#expandInspector');
  const navButton = document.querySelector('#toggleNav');
  let width = clampInspectorWidth(safeStorage.get('aod.inspectorWidth'));
  let dragging = false;

  const applyWidth = value => {
    width = clampInspectorWidth(value);
    shell.style.setProperty('--inspector-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    widthLabel.textContent = `${Math.round(width)}px`;
    safeStorage.set('aod.inspectorWidth', Math.round(width));
  };

  const setInspectorCollapsed = collapsed => {
    shell.classList.toggle('is-inspector-collapsed', collapsed);
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    expandButton.setAttribute('aria-expanded', String(!collapsed));
    safeStorage.set('aod.inspectorCollapsed', collapsed ? '1' : '0');
    if (!collapsed) applyWidth(width);
  };

  const setNavCollapsed = collapsed => {
    shell.classList.toggle('is-nav-collapsed', collapsed);
    navButton.setAttribute('aria-expanded', String(!collapsed));
    navButton.setAttribute('aria-label', collapsed ? '展开导航' : '收起导航');
    navButton.title = collapsed ? '展开导航' : '收起导航';
    safeStorage.set('aod.navCollapsed', collapsed ? '1' : '0');
  };

  const renderRoute = route => {
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === route.view));
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.viewPanel === route.view || (route.view !== 'runs' && panel.dataset.viewPanel === 'runs')));
    onRouteChange(route);
  };

  const setRoute = (route, { replace = false } = {}) => {
    const next = serializeRoute(route);
    if (location.hash !== next) history[replace ? 'replaceState' : 'pushState'](null, '', next);
    renderRoute(parseRoute(next));
  };

  applyWidth(width || INSPECTOR_DEFAULT);
  setInspectorCollapsed(safeStorage.get('aod.inspectorCollapsed') === '1');
  setNavCollapsed(safeStorage.get('aod.navCollapsed') === '1');

  handle.addEventListener('pointerdown', event => {
    if (shell.classList.contains('is-inspector-collapsed')) return;
    dragging = true;
    handle.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    applyWidth(shell.getBoundingClientRect().right - event.clientX);
  });
  const stopDragging = event => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener('pointerup', stopDragging);
  handle.addEventListener('pointercancel', stopDragging);
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === 'ArrowLeft') applyWidth(width + step);
    else if (event.key === 'ArrowRight') applyWidth(width - step);
    else if (event.key === 'Home') applyWidth(INSPECTOR_MIN);
    else if (event.key === 'End') applyWidth(INSPECTOR_MAX);
    else return;
    event.preventDefault();
  });
  handle.addEventListener('dblclick', () => applyWidth(INSPECTOR_DEFAULT));
  collapseButton.addEventListener('click', () => setInspectorCollapsed(true));
  expandButton.addEventListener('click', () => setInspectorCollapsed(false));
  navButton.addEventListener('click', () => setNavCollapsed(!shell.classList.contains('is-nav-collapsed')));

  document.querySelector('#appNav').addEventListener('click', event => {
    const item = event.target.closest('[data-view]');
    if (!item) return;
    setRoute({ view: item.dataset.view });
    const target = { groups: '.groups-section', tasks: '.tasks-section', delivery: '.runs-section' }[item.dataset.view];
    if (target) document.querySelector(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelector('.inspector-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-inspector-tab]');
    if (!tab) return;
    const name = tab.dataset.inspectorTab;
    document.querySelectorAll('[data-inspector-tab]').forEach(item => { item.classList.toggle('active', item === tab); item.setAttribute('aria-selected', String(item === tab)); });
    document.querySelectorAll('[data-inspector-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.inspectorPanel === name));
  });

  window.addEventListener('hashchange', () => renderRoute(parseRoute(location.hash)));
  renderRoute(parseRoute(location.hash));

  return { applyWidth, setInspectorCollapsed, setNavCollapsed, setRoute, getRoute: () => parseRoute(location.hash), getInspectorWidth: () => width };
}
