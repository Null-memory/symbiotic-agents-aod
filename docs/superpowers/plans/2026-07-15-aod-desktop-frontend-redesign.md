# AOD Desktop Frontend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AOD 桌面网页端更新为浅色运行工作台、深色实时工作面和可伸缩右侧检查器，同时保持现有 Agent 群组、任务、Reviewer 与 GitHub API 行为。

**Architecture:** 保持零构建的原生 ES modules。`app.js` 作为入口，`ui/` 模块分别负责 API/SSE、状态、布局、运行中心、群组中心和对话框；CSS 按设计变量、外壳、组件和视图拆分。服务端通过显式静态文件白名单提供这些资源。

**Tech Stack:** Node.js ESM、原生 HTML/CSS/JavaScript、SSE、Node test runner、Google Chrome。

---

## File Map

- Modify: `index.html` - 桌面应用外壳、导航、顶栏、主视图和检查器挂载点。
- Modify: `app.js` - 入口、模块装配和首轮刷新。
- Modify: `server.mjs` - 显式允许新增的前端模块与样式资源。
- Modify: `package.json` - 加入布局纯函数测试。
- Modify: `frontend-test.mjs` - 桌面工作台静态契约测试。
- Create: `layout-state.test.mjs` - 检查器尺寸、偏好和 hash 路由纯函数测试。
- Create: `ui/api.js` - JSON 请求、错误规范化和 SSE 重连。
- Create: `ui/state.js` - 服务端状态、选择状态与订阅。
- Create: `ui/layout-state.js` - 可测试的尺寸、偏好和路由纯函数。
- Create: `ui/layout.js` - 导航、检查器拖动、键盘和标签交互。
- Create: `ui/run-center.js` - 运行、任务、日志、Reviewer 和 GitHub 视图。
- Create: `ui/group-console.js` - 群组、成员、讨论、会话和共识视图。
- Create: `ui/dialogs.js` - 任务、运行、群组和会话对话框。
- Create: `styles/tokens.css` - 设计变量。
- Create: `styles/shell.css` - 应用外壳、导航、顶栏和检查器。
- Create: `styles/components.css` - 按钮、表格、表单、状态、日志和对话框。
- Create: `styles/views.css` - 运行、群组、Reviewer 和交付视图。
- Modify: `styles.css` - 仅作为兼容入口导入四个样式文件。

### Task 1: Lock Desktop Contracts and Static Asset Serving

**Files:**
- Modify: `frontend-test.mjs`
- Create: `layout-state.test.mjs`
- Modify: `package.json`
- Modify: `server.mjs`

- [ ] **Step 1: Add failing desktop shell and module contracts**

Add assertions to `frontend-test.mjs` that read `index.html`, all four CSS files, `app.js`, and the six `ui/*.js` modules. Assert these contracts:

```js
for (const id of ['appNav', 'appTopbar', 'workspaceMain', 'contextInspector', 'inspectorResizeHandle']) {
  assert.equal(html.includes(`id="${id}"`), true, `Desktop shell is missing #${id}.`);
}
assert.match(html, /<script\s+type="module"\s+src="app\.js"><\/script>/);
assert.match(shellCss, /--inspector-width/);
assert.match(shellCss, /grid-template-columns:[^;]*var\(--inspector-width\)/);
assert.equal(layoutModule.includes('aria-valuenow'), true);
assert.equal(apiModule.includes('Last-Event-ID'), true);
```

- [ ] **Step 2: Add failing layout-state tests**

Create `layout-state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInspectorWidth, parseRoute, serializeRoute } from './ui/layout-state.js';

test('clamps inspector width to the desktop range', () => {
  assert.equal(clampInspectorWidth(120), 280);
  assert.equal(clampInspectorWidth(420), 420);
  assert.equal(clampInspectorWidth(900), 560);
});

test('round trips run and task selection through the hash route', () => {
  const route = { view: 'runs', runId: 'run-42', taskId: 'task-7' };
  assert.deepEqual(parseRoute(serializeRoute(route)), route);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `node frontend-test.mjs && node --test layout-state.test.mjs`

Expected: FAIL because the desktop shell, modules and pure layout functions do not exist.

- [ ] **Step 4: Serve only the explicit new assets**

Replace the three-file check in `server.mjs` with an explicit set:

```js
const publicFiles = new Set([
  'index.html', 'styles.css', 'app.js',
  'styles/tokens.css', 'styles/shell.css', 'styles/components.css', 'styles/views.css',
  'ui/api.js', 'ui/state.js', 'ui/layout-state.js', 'ui/layout.js',
  'ui/run-center.js', 'ui/group-console.js', 'ui/dialogs.js'
]);
if (!publicFiles.has(file)) return send(response, 404, { error: 'Not found.' });
```

Add `.mjs` only if a browser asset uses it; this plan uses `.js`, so the existing MIME map is sufficient.

- [ ] **Step 5: Register the new pure-function test**

Update `package.json`:

```json
"test": "node --test group-domain.test.mjs layout-state.test.mjs && node frontend-test.mjs && node test.mjs"
```

- [ ] **Step 6: Commit the contract and server changes**

```powershell
git add frontend-test.mjs layout-state.test.mjs package.json server.mjs
git commit -m "test: define desktop frontend contracts"
```

### Task 2: Build the Desktop Workbench Shell

**Files:**
- Modify: `index.html`
- Create: `styles/tokens.css`
- Create: `styles/shell.css`
- Modify: `styles.css`

- [ ] **Step 1: Replace the page stack with the application shell**

Keep every existing dialog and API-facing element ID, but wrap the main views in this structure:

```html
<div class="app-shell" id="appShell">
  <aside class="app-nav" id="appNav">...</aside>
  <div class="app-frame">
    <header class="app-topbar" id="appTopbar">...</header>
    <main class="workspace-main" id="workspaceMain">...</main>
  </div>
  <div class="inspector-resize" id="inspectorResizeHandle" role="separator"
       aria-orientation="vertical" aria-label="调整任务详情宽度" tabindex="0"></div>
  <aside class="context-inspector" id="contextInspector">...</aside>
</div>
```

Move `#taskDetailTitle`, `#taskDetailStatus`, `#taskDetailMeta`, `#taskOutput`, `#verificationResult`, `#reviewState`, and `#reviewContent` into `#contextInspector`. Preserve `#taskBoard`, `#runsBoard`, `#groupsBoard`, `#groupConsole`, `#events`, all forms and dialogs.

- [ ] **Step 2: Add design tokens**

Create `styles/tokens.css` with semantic variables:

```css
:root {
  --surface-canvas:#edf1f1; --surface-panel:#fff; --surface-live:#182326;
  --text-primary:#182428; --text-muted:#667478; --border:#ccd6d8;
  --accent:#087f75; --accent-soft:#dce8e7; --command:#e95e4f;
  --warning:#b77a18; --danger:#b83f36;
  --radius-panel:8px; --radius-control:6px;
  --motion-fast:140ms; --motion-layout:240ms;
  --inspector-width:360px; --nav-width:208px;
}
```

- [ ] **Step 3: Implement the three-column shell**

Create `styles/shell.css` with a stable grid:

```css
.app-shell{display:grid;grid-template-columns:var(--nav-width) minmax(0,1fr) 7px var(--inspector-width);height:100vh;overflow:hidden;background:var(--surface-canvas)}
.app-shell.is-nav-collapsed{--nav-width:72px}
.app-shell.is-inspector-collapsed{--inspector-width:52px}
.workspace-main{min-width:0;overflow:auto;container-type:inline-size}
.context-inspector{min-width:0;overflow:hidden;background:var(--surface-panel)}
```

Use explicit `@media (min-width: 901px)` collapsed grid values so Chrome can animate `grid-template-columns` reliably.

- [ ] **Step 4: Make `styles.css` a compatibility entry**

```css
@import url('./styles/tokens.css');
@import url('./styles/shell.css');
@import url('./styles/components.css');
@import url('./styles/views.css');
```

- [ ] **Step 5: Run the static contract test**

Run: `node frontend-test.mjs`

Expected: still FAIL only for modules and interaction contracts not yet implemented; shell ID and CSS token assertions pass.

- [ ] **Step 6: Commit the workbench shell**

```powershell
git add index.html styles.css styles/tokens.css styles/shell.css
git commit -m "feat: add desktop workbench shell"
```

### Task 3: Implement Inspector, Navigation, Preferences, and Routing

**Files:**
- Create: `ui/layout-state.js`
- Create: `ui/layout.js`
- Modify: `app.js`

- [ ] **Step 1: Implement pure layout functions**

Create `ui/layout-state.js`:

```js
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 360;
export const clampInspectorWidth = value => Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, Number(value) || INSPECTOR_DEFAULT));

export function parseRoute(hash = '') {
  const params = new URLSearchParams(hash.replace(/^#\/?/, ''));
  return { view: params.get('view') || 'runs', runId: params.get('run') || null, taskId: params.get('task') || null };
}
export function serializeRoute(route) {
  const params = new URLSearchParams({ view: route.view || 'runs' });
  if (route.runId) params.set('run', route.runId);
  if (route.taskId) params.set('task', route.taskId);
  return `#/${params}`;
}
```

- [ ] **Step 2: Run pure-function tests and verify GREEN**

Run: `node --test layout-state.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 3: Implement DOM layout behavior**

Create `ui/layout.js` exporting `createLayout({ onRouteChange })`. It must:

- restore `aod.navCollapsed`, `aod.inspectorCollapsed`, and `aod.inspectorWidth`;
- set `--inspector-width` in pixels;
- update `aria-valuemin`, `aria-valuemax`, and `aria-valuenow`;
- handle pointer drag, arrow keys, `Shift + Arrow`, and double click reset;
- keep the last expanded width when the inspector is collapsed;
- write route selection through `history.replaceState` and respond to `hashchange`.

The resize function must use:

```js
const applyWidth = value => {
  width = clampInspectorWidth(value);
  shell.style.setProperty('--inspector-width', `${width}px`);
  handle.setAttribute('aria-valuenow', String(width));
  storage.setItem('aod.inspectorWidth', String(width));
};
```

- [ ] **Step 4: Wire layout initialization in `app.js`**

```js
import { createLayout } from './ui/layout.js';
const layout = createLayout({ onRouteChange: route => selectRoute(route) });
```

Update task selection to call `layout.setRoute({ view:'runs', runId:task.run_id, taskId:task.id })`.

- [ ] **Step 5: Run check and tests**

Run: `npm run check && node --test layout-state.test.mjs`

Expected: syntax check passes and layout tests pass.

- [ ] **Step 6: Commit layout behavior**

```powershell
git add app.js ui/layout-state.js ui/layout.js layout-state.test.mjs
git commit -m "feat: add persistent resizable inspector"
```

### Task 4: Extract API/SSE and State Modules

**Files:**
- Create: `ui/api.js`
- Create: `ui/state.js`
- Modify: `app.js`

- [ ] **Step 1: Add the API and stream client**

Create `ui/api.js` with:

```js
export async function request(path, options = {}) {
  const response = await fetch(path, { headers:{'content-type':'application/json'}, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

export function connectStream({ onEvent, onConnection }) {
  let source;
  let retryTimer;
  let lastEventId = sessionStorage.getItem('aod.lastEventId') || '';
  const open = () => {
    source = new EventSource(`/api/stream${lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : ''}`);
    source.onopen = () => onConnection('online');
    for (const type of ['state','event','log','group_session','group_turn','group_message','task_role']) {
      source.addEventListener(type, event => { if (event.lastEventId) { lastEventId=event.lastEventId; sessionStorage.setItem('aod.lastEventId', lastEventId); } onEvent(type,event); });
    }
    source.onerror = () => { onConnection('reconnecting'); source.close(); retryTimer=setTimeout(open,2000); };
  };
  open();
  return () => { clearTimeout(retryTimer); source?.close(); };
}
```

The static contract checks for `Last-Event-ID`; include a comment explaining that native `EventSource` sends it on browser-managed reconnects while the query parameter restores it across page reloads.

- [ ] **Step 2: Add the observable state container**

Create `ui/state.js` exporting `createStore(initial)` with `getState`, `setState`, `patchSelection`, and `subscribe`. Only layout preferences remain outside this store.

- [ ] **Step 3: Replace local request and stream globals in `app.js`**

Import `request`, `connectStream`, and `createStore`; retain the current `refresh()` API calls and render order. Update the topbar connection element on `online` and `reconnecting`.

- [ ] **Step 4: Run syntax and full tests**

Run: `npm run check && npm test`

Expected: all existing tests pass.

- [ ] **Step 5: Commit API and state extraction**

```powershell
git add app.js ui/api.js ui/state.js
git commit -m "refactor: isolate frontend state and stream client"
```

### Task 5: Move Run Center and Inspector Rendering

**Files:**
- Create: `ui/run-center.js`
- Create: `styles/components.css`
- Create: `styles/views.css`
- Modify: `app.js`

- [ ] **Step 1: Extract run-center rendering behind one interface**

Create `createRunCenter({ root, getState, request, tell, onTaskSelected })` returning:

```js
return {
  render,
  selectTask(taskId) { selectedTaskId=taskId; onTaskSelected(taskId); render(); },
  bind() { root.addEventListener('click', handleClick); root.addEventListener('change', handleChange); }
};
```

Move `taskActions`, `renderRuns`, `renderBoard`, `renderDetail`, `renderReview`, and `renderEvents` into the module. Replace task cards with dense table rows while preserving all `data-action`, `data-status`, `data-run-action`, and `data-review-approve` contracts.

- [ ] **Step 2: Add inspector tabs and log controls**

Render tabs with `data-inspector-tab="overview|output|verification|review"`. Add log search, level filter and auto-follow controls. Disable auto-follow when the log container is more than 90px from the bottom.

- [ ] **Step 3: Add shared component styles**

In `styles/components.css`, implement 6px controls, 8px panels, pill status tags, dense tables, dialogs, segmented controls, focus-visible states, dark logs and reduced-motion rules.

- [ ] **Step 4: Add run and delivery view styles**

In `styles/views.css`, use container queries:

```css
@container (max-width:760px){.summary-grid{grid-template-columns:repeat(2,1fr)}.run-list{display:none}}
@container (max-width:560px){.task-table .column-files,.task-table .column-attempts{display:none}}
```

- [ ] **Step 5: Wire the module in `app.js`**

Initialize once, call `runCenter.render()` after refresh, and remove the moved rendering and event-listener blocks from `app.js`.

- [ ] **Step 6: Run full tests**

Run: `npm run check && npm test`

Expected: all tests pass with no syntax errors.

- [ ] **Step 7: Commit the run center**

```powershell
git add app.js ui/run-center.js styles/components.css styles/views.css
git commit -m "feat: redesign run center and task inspector"
```

### Task 6: Move Group Console and Dialog Behavior

**Files:**
- Create: `ui/group-console.js`
- Create: `ui/dialogs.js`
- Modify: `app.js`
- Modify: `styles/views.css`

- [ ] **Step 1: Extract the group console**

Create `createGroupConsole({ root, getState, request, tell, onRunRequested })`. Move member, message, control, consensus, recovery and DAG rendering into this module. Preserve existing IDs and API paths.

The module owns `selectedGroupId`, `selectedGroupSessionId`, messages, paging cursor and detail request token. `openSession(sessionId, groupId)` updates the hash route through a callback and fetches session plus incremental messages.

- [ ] **Step 2: Extract dialogs**

Create `createDialogs({ getState, request, tell, onRefresh, onOpenGroupSession })`. Move task, run, group and group-session form listeners into it. Capture `event.currentTarget` before every `await`.

- [ ] **Step 3: Restyle group operations without nested cards**

Use a member status rail, dark timeline and resizable consensus inspector. Keep message round dividers, role pills and inline DAG validation. At 1024px reduce the member rail width rather than hiding chat or consensus.

- [ ] **Step 4: Wire modules and remove duplicate code**

Keep `app.js` responsible only for initialization, topbar settings, global refresh and module orchestration.

- [ ] **Step 5: Run full tests**

Run: `npm run check && npm test`

Expected: group CRUD, discussion, recovery and role pipeline tests remain green; frontend contract test passes.

- [ ] **Step 6: Commit group and dialog extraction**

```powershell
git add app.js ui/group-console.js ui/dialogs.js styles/views.css
git commit -m "refactor: isolate group console interactions"
```

### Task 7: Desktop Visual Verification and Final Regression

**Files:**
- Modify as needed: `index.html`, `styles/*.css`, `ui/*.js`, `frontend-test.mjs`

- [ ] **Step 1: Run all automated verification**

Run: `npm run check`

Expected: exit 0.

Run: `npm test`

Expected: all Node, group-domain, frontend-contract and integration tests pass.

- [ ] **Step 2: Start the feature server**

Run: `$env:PORT=4822; npm start`

Expected: AOD reports `http://127.0.0.1:4822` and remains running. If 4822 is occupied by the same worktree server, restart it; otherwise use the next free port.

- [ ] **Step 3: Verify only in the user's Chrome**

Open the server URL in Google Chrome. At 1440x900, 1280x800 and 1024x768 verify:

- no horizontal overflow or overlapping text;
- navigation collapse and restore;
- inspector drag from 280px to 560px, collapse to 52px, reopen to prior width;
- keyboard resize and double-click reset;
- metric wrapping, task-column reduction and run-list collapse;
- task output, verification, review and GitHub states;
- group members, discussion timeline, controls and consensus DAG;
- SSE online/reconnecting feedback;
- reduced-motion behavior.

- [ ] **Step 4: Record visual defects as failing contract assertions where practical**

For each discovered structural regression, add an assertion to `frontend-test.mjs`, run it to observe failure, then apply the smallest CSS/markup fix and rerun `npm test`.

- [ ] **Step 5: Final diff and status review**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only intentional AOD feature and frontend redesign changes remain.
