import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextDock } from './ui/context-dock.js';

function classList() {
  const values = new Set();
  return {
    toggle(name, force) { if (force === undefined ? !values.has(name) : force) values.add(name); else values.delete(name); },
    contains: name => values.has(name)
  };
}

function fixture(saved = null) {
  const attributes = new Map();
  const shell = { classList: classList(), style: { setProperty(name, value) { this[name] = value; } } };
  const viewport = { scrollTop: 0 };
  const root = { dataset: {}, classList: classList(), querySelector: selector => selector === '[data-context-viewport]' ? viewport : null, querySelectorAll: () => [] };
  const handle = { addEventListener() {}, setAttribute(name, value) { attributes.set(name, value); } };
  const collapseButton = { addEventListener() {}, setAttribute(name, value) { attributes.set(`collapse:${name}`, value); } };
  const expandButton = { addEventListener() {}, setAttribute(name, value) { attributes.set(`expand:${name}`, value); } };
  const memory = new Map(saved ? [['aod.workbench.v2', JSON.stringify(saved)]] : []);
  const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
  return { shell, root, handle, viewport, collapseButton, expandButton, storage, attributes };
}

test('restores independent widths as context tabs change', () => {
  const elements = fixture({ tab: 'task', contextWidths: { task: 330, discussion: 520 } });
  const dock = createContextDock({ ...elements, frame: callback => callback() });
  assert.equal(elements.shell.style['--inspector-width'], '330px');
  dock.selectTab('discussion');
  assert.equal(elements.shell.style['--inspector-width'], '520px');
  dock.selectTab('task');
  assert.equal(elements.shell.style['--inspector-width'], '330px');
});

test('collapses to a reopen rail and expands to the previous width', () => {
  const elements = fixture();
  const dock = createContextDock({ ...elements, frame: callback => callback() });
  dock.collapse();
  assert.equal(elements.shell.classList.contains('is-inspector-collapsed'), true);
  assert.equal(elements.attributes.get('collapse:aria-expanded'), 'false');
  dock.expand();
  assert.equal(elements.shell.classList.contains('is-inspector-collapsed'), false);
  assert.equal(elements.shell.style['--inspector-width'], '360px');
});

test('restores each context tab scroll position', () => {
  const elements = fixture();
  const dock = createContextDock({ ...elements, frame: callback => callback() });
  elements.viewport.scrollTop = 240;
  dock.selectTab('discussion');
  elements.viewport.scrollTop = 90;
  dock.selectTab('task');
  assert.equal(elements.viewport.scrollTop, 240);
  dock.selectTab('discussion');
  assert.equal(elements.viewport.scrollTop, 90);
});
