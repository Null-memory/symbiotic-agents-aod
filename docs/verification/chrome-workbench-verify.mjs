import { mkdir, writeFile } from 'node:fs/promises';

const cdpPort = Number(process.env.CDP_PORT || 9223);
const appUrl = process.env.AOD_URL || 'http://127.0.0.1:4824';
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = targets.find(item => item.type === 'page' && item.url.startsWith(appUrl));
if (!target) throw new Error(`AOD Chrome target not found for ${appUrl}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const errors = [];

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    }
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text || 'Runtime exception');
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map(argument => argument.value || argument.description).join(' '));
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(expression, predicate, timeout = 2000) {
  const startedAt = Date.now();
  let value;
  do {
    value = await evaluate(expression);
    if (predicate(value)) return value;
    await wait(40);
  } while (Date.now() - startedAt < timeout);
  throw new Error(`Timed out waiting for ${expression}; last value: ${JSON.stringify(value)}`);
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload', { ignoreCache: true });
  await wait(1200);
}

async function screenshot(name) {
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const directory = new URL('./assets/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const path = new URL(name, directory);
  await writeFile(path, Buffer.from(image.data, 'base64'));
  return decodeURIComponent(path.pathname.replace(/^\/(.:)/, '$1'));
}

async function metrics(label) {
  return evaluate(`(() => {
    const shell = document.querySelector('#appShell');
    const nav = document.querySelector('#appNav');
    const main = document.querySelector('#workspaceMain');
    const dock = document.querySelector('#contextInspector');
    const viewport = document.querySelector('#contextDockViewport');
    const stage = document.querySelector('#runStageBar');
    const next = document.querySelector('#nextAction');
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) };
    };
    const clipped = [...document.querySelectorAll('button,strong,h1,h2,h3,span')]
      .filter(element => element.offsetParent && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1))
      .slice(0, 12)
      .map(element => ({ text: element.textContent.trim().slice(0, 40), className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    return {
      label: ${JSON.stringify(label)},
      inner: [innerWidth, innerHeight],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      shellColumns: getComputedStyle(shell).gridTemplateColumns,
      nav: rect(nav), main: rect(main), dock: rect(dock), viewport: rect(viewport), stage: rect(stage), next: rect(next),
      navCollapsed: shell.classList.contains('is-nav-collapsed'),
      dockCollapsed: shell.classList.contains('is-inspector-collapsed'),
      contextTab: dock.dataset.contextTab,
      activeViews: [...document.querySelectorAll('[data-view-panel].active')].map(element => element.dataset.viewPanel),
      clipped
    };
  })()`);
}

await send('Runtime.enable');
await send('Page.enable');
await evaluate(`localStorage.removeItem('aod.workbench.v2'); localStorage.setItem('aod.navCollapsed','0'); localStorage.setItem('aod.workspaceViewMode','split'); history.replaceState(null,'','#/view=runs')`);
await setViewport(1440, 900);

const result = { initial1440: await metrics('1440-initial') };
result.screenshot1440 = await screenshot('adaptive-workbench-1440-task.png');

await evaluate(`document.querySelector('[data-context-tab="discussion"]').click()`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 500);
result.discussion = await metrics('1440-discussion');
result.discussionBackground = await evaluate(`getComputedStyle(document.querySelector('#contextInspector')).backgroundColor`);
result.screenshotDiscussion = await screenshot('adaptive-workbench-1440-discussion.png');

await evaluate(`document.querySelector('[data-context-tab="task"]').click()`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 360);
await evaluate(`document.querySelector('#inspectorResizeHandle').focus(); document.querySelector('#inspectorResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 280);
result.minimum = await metrics('1440-minimum');
await evaluate(`document.querySelector('#inspectorResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 560);
result.maximum = await metrics('1440-maximum');
await evaluate(`document.querySelector('#inspectorResizeHandle').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 360);
await evaluate(`document.querySelector('#collapseInspector').click()`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 52);
result.collapsed = await metrics('1440-collapsed');
result.screenshotCollapsed = await screenshot('adaptive-workbench-1440-collapsed.png');

await evaluate(`document.querySelector('#expandInspector').click(); document.querySelector('#toggleNav').click()`);
await waitFor(`Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width)`, value => value === 360);
await waitFor(`Math.round(document.querySelector('#appNav').getBoundingClientRect().width)`, value => value === 72);
result.navCollapsed = await metrics('1440-nav-collapsed');

await evaluate(`document.querySelector('[data-view-mode="all"]').click()`);
await waitFor(`document.querySelectorAll('[data-view-panel].active').length`, value => value === 4);
result.overview = await metrics('1440-overview');
await evaluate(`document.querySelector('[data-view-mode="split"]').click(); document.querySelector('[data-view="groups"]').click()`);
await waitFor(`[...document.querySelectorAll('[data-view-panel].active')].map(element => element.dataset.viewPanel).join(',')`, value => value === 'groups');
result.focusGroups = await metrics('1440-focus-groups');

const hasSession = await evaluate(`Boolean(document.querySelector('.group-card:not(:has(.empty-session)) [data-group-action="open"]'))`);
if (hasSession) {
  await evaluate(`document.querySelector('.group-card:not(:has(.empty-session)) [data-group-action="open"]').click()`);
  await waitFor(`JSON.stringify({ tab: document.querySelector('#contextInspector').dataset.contextTab, open: !document.querySelector('#groupConsole').hidden, width: Math.round(document.querySelector('#contextInspector').getBoundingClientRect().width) })`, value => {
    const state = JSON.parse(value);
    return state.tab === 'discussion' && state.open && state.width === 500;
  }, 4000);
  result.activeDiscussion = await metrics('1440-active-discussion');
  result.screenshotActiveDiscussion = await screenshot('adaptive-workbench-1440-active-discussion.png');
}

await evaluate(`document.querySelector('#toggleNav').click(); document.querySelector('[data-view="runs"]').click()`);
await waitFor(`Math.round(document.querySelector('#appNav').getBoundingClientRect().width)`, value => value === 208);
await waitFor(`[...document.querySelectorAll('[data-view-panel].active')].map(element => element.dataset.viewPanel).join(',')`, value => value === 'runs');

await setViewport(1280, 800);
result.initial1280 = await metrics('1280-initial');
result.screenshot1280 = await screenshot('adaptive-workbench-1280.png');

await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`);
result.searchFocused = await evaluate(`document.activeElement?.id`);
await evaluate(`const input=document.querySelector('#commandSearch'); input.value='Chrome'; input.dispatchEvent(new Event('input',{bubbles:true}))`);
result.searchResultCount = await evaluate(`document.querySelectorAll('[data-command-result]').length`);

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
result.reducedMotion = await evaluate(`(() => {
  const shell = getComputedStyle(document.querySelector('#appShell'));
  const panel = getComputedStyle(document.querySelector('.context-panel.active'));
  return { shellTransition: shell.transitionDuration, panelAnimation: panel.animationDuration };
})()`);
await send('Emulation.setEmulatedMedia', { features: [] });
result.motion = await evaluate(`(() => {
  const root = getComputedStyle(document.documentElement);
  return {
    feedback: root.getPropertyValue('--motion-fast').trim(),
    tab: root.getPropertyValue('--motion-tab').trim(),
    open: root.getPropertyValue('--motion-open').trim(),
    close: root.getPropertyValue('--motion-close').trim(),
    layout: root.getPropertyValue('--motion-layout').trim()
  };
})()`);

result.errors = errors;
console.log(JSON.stringify(result, null, 2));
ws.close();
