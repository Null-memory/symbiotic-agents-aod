import {
  INSPECTOR_DEFAULT,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  LAYOUT_STORAGE_KEY,
  clampInspectorWidth,
  createWorkbenchState,
  updateContextState
} from './layout-state.js';

const browserStorage = {
  getItem(key) { try { return localStorage.getItem(key); } catch { return null; } },
  setItem(key, value) { try { localStorage.setItem(key, value); } catch {} }
};

function loadState(storage) {
  try {
    return createWorkbenchState(JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY) || '{}'));
  } catch {
    return createWorkbenchState();
  }
}

export function createContextDock({
  shell,
  root,
  handle,
  collapseButton,
  expandButton,
  widthLabel = null,
  storage = browserStorage,
  frame = callback => requestAnimationFrame(callback),
  onTabChange = () => {}
}) {
  const viewport = root.querySelector('[data-context-viewport]') || root.querySelector('.inspector-content') || root;
  const tabsRoot = root.querySelector('[data-context-tabs]');
  let state = loadState(storage);
  if (globalThis.matchMedia?.('(max-width: 760px)').matches) {
    state = updateContextState(state, { collapsed: true });
  }
  let dragging = false;

  const save = () => storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));

  const apply = ({ restoreScroll = true } = {}) => {
    shell.style.setProperty('--inspector-width', `${state.width}px`);
    shell.classList.toggle('is-inspector-collapsed', state.collapsed);
    root.classList.toggle('is-discussion-context', state.tab === 'discussion');
    root.dataset.contextTab = state.tab;
    handle?.setAttribute('aria-valuenow', String(Math.round(state.width)));
    collapseButton?.setAttribute('aria-expanded', String(!state.collapsed));
    expandButton?.setAttribute('aria-expanded', String(!state.collapsed));
    if (widthLabel) widthLabel.textContent = `${Math.round(state.width)}px`;
    root.querySelectorAll('[data-context-tab]').forEach(tab => {
      const active = tab.dataset.contextTab === state.tab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    root.querySelectorAll('[data-context-panel]').forEach(panel => {
      const active = panel.dataset.contextPanel === state.tab;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
    if (restoreScroll) frame(() => { viewport.scrollTop = state.contextScroll[state.tab] || 0; });
    save();
  };

  const rememberScroll = () => {
    state = updateContextState(state, { scrollTop: viewport.scrollTop });
    save();
  };

  const applyWidth = value => {
    state = updateContextState(state, { width: clampInspectorWidth(value) });
    apply({ restoreScroll: false });
  };

  const selectTab = tab => {
    rememberScroll();
    state = updateContextState(state, { tab });
    apply();
    onTabChange(state.tab, state.entities[state.tab]);
  };

  const setCollapsed = collapsed => {
    state = updateContextState(state, { collapsed });
    apply({ restoreScroll: false });
  };

  const open = (tab, entity = undefined) => {
    rememberScroll();
    state = updateContextState(state, { tab, entity, collapsed: false });
    apply();
    onTabChange(state.tab, state.entities[state.tab]);
  };

  const setEntity = (tab, entity) => {
    const previousTab = state.tab;
    state = updateContextState(state, { tab, entity });
    if (previousTab !== tab) state = updateContextState(state, { tab: previousTab });
    save();
  };

  handle?.addEventListener('pointerdown', event => {
    if (state.collapsed) return;
    dragging = true;
    handle.classList.add('dragging');
    handle.setPointerCapture?.(event.pointerId);
  });
  handle?.addEventListener('pointermove', event => {
    if (!dragging) return;
    applyWidth(shell.getBoundingClientRect().right - event.clientX);
  });
  const stopDragging = event => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle?.addEventListener('pointerup', stopDragging);
  handle?.addEventListener('pointercancel', stopDragging);
  handle?.addEventListener('keydown', event => {
    const step = event.shiftKey ? 24 : 8;
    if (event.key === 'ArrowLeft') applyWidth(state.width + step);
    else if (event.key === 'ArrowRight') applyWidth(state.width - step);
    else if (event.key === 'Home') applyWidth(INSPECTOR_MIN);
    else if (event.key === 'End') applyWidth(INSPECTOR_MAX);
    else return;
    event.preventDefault();
  });
  handle?.addEventListener('dblclick', () => applyWidth(INSPECTOR_DEFAULT));
  collapseButton?.addEventListener('click', () => setCollapsed(true));
  expandButton?.addEventListener('click', () => setCollapsed(false));
  tabsRoot?.addEventListener('click', event => {
    const tab = event.target.closest('[data-context-tab]');
    if (tab) selectTab(tab.dataset.contextTab);
  });
  viewport.addEventListener?.('scroll', () => {
    state = updateContextState(state, { scrollTop: viewport.scrollTop });
    save();
  }, { passive: true });

  apply();
  return {
    open,
    collapse: () => setCollapsed(true),
    expand: () => setCollapsed(false),
    selectTab,
    setEntity,
    applyWidth,
    rememberScroll,
    getState: () => structuredClone(state)
  };
}
