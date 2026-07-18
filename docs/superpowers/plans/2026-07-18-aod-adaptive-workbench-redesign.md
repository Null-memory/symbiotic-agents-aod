# AOD Adaptive Workbench Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the desktop AOD console into a run-centered adaptive workbench with a shared, resizable context dock for Agent discussion, task details, and acceptance results.

**Architecture:** Keep the current server APIs and vanilla ES module stack. Move deterministic layout, stage, search, and refresh behavior into focused modules, while `app.js` remains the data/action coordinator. Render the operational workspace on light surfaces and the shared live context dock on a dark surface, preserving human approval gates.

**Tech Stack:** HTML, CSS custom properties and container queries, vanilla JavaScript ES modules, Node.js built-in test runner, SSE, Chrome DevTools Protocol.

---

### Task 1: Versioned Workbench State

**Files:**
- Modify: `ui/layout-state.js`
- Modify: `layout-state.test.mjs`

- [ ] **Step 1: Write failing tests for dock tabs, independent widths, scroll state, and route context**

```js
import {
  CONTEXT_TABS, createWorkbenchState, normalizeContextTab,
  parseRoute, serializeRoute, updateContextState
} from './ui/layout-state.js';

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

test('round trips group session context through the hash', () => {
  const route = { view: 'groups', runId: null, taskId: null, sessionId: 'session-9' };
  assert.deepEqual(parseRoute(serializeRoute(route)), route);
});

test('normalizes unsupported context tabs to task', () => {
  assert.deepEqual(CONTEXT_TABS, ['discussion', 'task', 'acceptance']);
  assert.equal(normalizeContextTab('unknown'), 'task');
});
```

- [ ] **Step 2: Run the state tests and confirm RED**

Run: `node --test layout-state.test.mjs`

Expected: FAIL because `createWorkbenchState`, `updateContextState`, and context route fields do not exist.

- [ ] **Step 3: Implement the immutable state helpers**

Add `CONTEXT_TABS`, `LAYOUT_STORAGE_KEY = 'aod.workbench.v2'`, `normalizeContextTab`, `createWorkbenchState`, and `updateContextState`. Clamp widths with the existing desktop limits, use `500px` as the discussion default and `360px` for task/acceptance, retain a `collapsed` boolean, and serialize `sessionId` as the `session` hash parameter.

- [ ] **Step 4: Run the state tests and confirm GREEN**

Run: `node --test layout-state.test.mjs`

Expected: all layout state tests pass.

- [ ] **Step 5: Commit the state model**

```powershell
git add ui/layout-state.js layout-state.test.mjs
git commit -m "feat: add adaptive context dock state"
```

### Task 2: Refresh Coalescing And Render Preservation

**Files:**
- Create: `ui/render-scheduler.js`
- Create: `render-scheduler.test.mjs`
- Modify: `package.json`
- Modify: `ui/api.js`

- [ ] **Step 1: Write failing tests for coalescing and preservation snapshots**

```js
import { createRefreshScheduler, captureElementState, restoreElementState } from './ui/render-scheduler.js';

test('coalesces events inside one 100ms refresh window', async () => {
  let calls = 0;
  const scheduler = createRefreshScheduler(async () => { calls += 1; }, { delay: 10 });
  scheduler.schedule(); scheduler.schedule(); scheduler.schedule();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
});

test('captures and restores input and scroll state', () => {
  const root = { scrollTop: 88, querySelector: () => ({ id: 'message', value: 'draft', selectionStart: 2, selectionEnd: 4 }) };
  const snapshot = captureElementState(root, '#message');
  assert.deepEqual(snapshot, { scrollTop: 88, input: { id: 'message', value: 'draft', selectionStart: 2, selectionEnd: 4 } });
});
```

- [ ] **Step 2: Run the scheduler tests and confirm RED**

Run: `node --test render-scheduler.test.mjs`

Expected: FAIL because `ui/render-scheduler.js` is missing.

- [ ] **Step 3: Implement the scheduler and DOM snapshot helpers**

`createRefreshScheduler(refresh, { delay = 100 })` exposes `schedule()` and `flush()`, holds one timer, and never overlaps active refreshes. `captureElementState` stores scroll and focused input selection. `restoreElementState` restores values, selection, focus, and scroll inside `requestAnimationFrame`.

- [ ] **Step 4: Use the scheduler for SSE events**

Keep `connectStream` event names unchanged. Replace the local ad hoc timeout in `app.js` with the scheduler during Task 8, and add `render-scheduler.test.mjs` to both `npm test` and `npm run check` coverage.

- [ ] **Step 5: Run tests and commit**

Run: `node --test render-scheduler.test.mjs`

Expected: all scheduler tests pass.

```powershell
git add ui/render-scheduler.js render-scheduler.test.mjs package.json ui/api.js
git commit -m "feat: coalesce live workbench refreshes"
```

### Task 3: Run Stage And Next Action Model

**Files:**
- Create: `ui/run-stage.js`
- Create: `run-stage.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for stage derivation**

```js
import { deriveRunStage, deriveNextAction } from './ui/run-stage.js';

test('shows collaboration while tasks are still running', () => {
  const result = deriveRunStage({ status: 'active' }, [{ status: 'running' }], []);
  assert.equal(result.current, 'collaboration');
  assert.equal(result.stages.find(item => item.key === 'collaboration').state, 'current');
});

test('does not claim delivery complete before the run is merged', () => {
  const result = deriveRunStage({ status: 'pr_open', ci_status: 'success' }, [{ status: 'merged' }], []);
  assert.equal(result.current, 'delivery');
  assert.notEqual(result.stages.at(-1).state, 'complete');
});

test('prioritizes a recovery approval over routine actions', () => {
  const action = deriveNextAction({ id: 'run-1' }, [], [{ type: 'process_recovery', status: 'pending' }]);
  assert.equal(action.kind, 'recovery');
});
```

- [ ] **Step 2: Run the stage tests and confirm RED**

Run: `node --test run-stage.test.mjs`

Expected: FAIL because the stage model is missing.

- [ ] **Step 3: Implement the pure stage model**

Define four stages: `requirement`, `collaboration`, `gates`, `delivery`. Derive completion only from persisted run/task states. `deriveNextAction` orders process recovery, conflict review, verification, task merge, PR publication, CI refresh, and idle guidance.

- [ ] **Step 4: Run tests and commit**

Run: `node --test run-stage.test.mjs`

Expected: all stage tests pass.

```powershell
git add ui/run-stage.js run-stage.test.mjs package.json
git commit -m "feat: derive run stages and next actions"
```

### Task 4: Shared Context Dock Controller

**Files:**
- Create: `ui/context-dock.js`
- Create: `context-dock.test.mjs`
- Modify: `ui/layout.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing controller tests using a minimal DOM fixture**

Test that selecting `discussion` restores its width, selecting `task` restores task width, collapse changes the shell class and `aria-expanded`, keyboard resize changes width by 8px, and tab changes restore the tab's scroll position.

- [ ] **Step 2: Run the controller tests and confirm RED**

Run: `node --test context-dock.test.mjs`

Expected: FAIL because `createContextDock` is missing.

- [ ] **Step 3: Implement `createContextDock`**

The controller accepts `{ shell, root, handle, storage, onTabChange }`, loads/saves one versioned JSON state object, binds pointer and keyboard resizing, and exposes:

```js
{
  open(tab, entity = null), collapse(), expand(), selectTab(tab),
  setEntity(tab, entity), getState(), rememberScroll()
}
```

Use `discussion` width `500`, task-oriented width `360`, minimum `320`, maximum `620`, and a collapsed rail of `52px`. Update labels and ARIA without replacing tab panel nodes.

- [ ] **Step 4: Delegate inspector behavior from `layout.js`**

Keep route, nav, Overview/Focus, and scroll behavior in `layout.js`. Remove direct inspector tab, drag, collapse, and storage wiring from it, and expose the dock controller from `createLayout`.

- [ ] **Step 5: Run tests and commit**

Run: `node --test context-dock.test.mjs layout-state.test.mjs`

Expected: all context and layout tests pass.

```powershell
git add ui/context-dock.js context-dock.test.mjs ui/layout.js package.json
git commit -m "feat: add shared adaptive context dock"
```

### Task 5: Workbench Markup And Visual System

**Files:**
- Modify: `index.html`
- Modify: `styles/tokens.css`
- Modify: `styles/shell.css`
- Modify: `styles/components.css`
- Modify: `styles/views.css`

- [ ] **Step 1: Add structural assertions to `frontend-test.mjs` and confirm RED**

Assert the HTML includes `runStageBar`, `nextAction`, `commandSearch`, `pendingActionCount`, context tabs for `discussion`, `task`, and `acceptance`, and one `contextDockViewport`. Assert CSS includes `--motion-tab:160ms`, `--motion-open:200ms`, `--motion-close:160ms`, the collapsed `52px` rail, dark dock selectors, and reduced-motion overrides.

- [ ] **Step 2: Run the frontend test and confirm RED**

Run: `node frontend-test.mjs`

Expected: FAIL on the new adaptive workbench selectors and IDs.

- [ ] **Step 3: Rebuild the desktop shell markup**

Add top-bar global search and pending-action button. Place a sticky stage bar and next-action strip at the top of the runs view. Move the existing group roster/messages/session controls into the `discussion` dock panel, retain task overview/output in `task`, and combine verification/review/recovery into `acceptance`. Keep existing element IDs required by action handlers.

- [ ] **Step 4: Apply the S3 visual system and fast M2 motion**

Use a cool gray canvas, white operational bands, charcoal dock, mint live state, teal selected state, coral risky actions, amber recovery states, 8px panel radius and 6px controls. Use `120ms` feedback, `160ms` tabs, `200ms` dock open/reflow, and `160ms` close. Remove nested card styling from major page sections and reserve shadows for dialogs, drag state, and focused dock.

- [ ] **Step 5: Make secondary operational areas collapsible**

Wrap metrics, process history, adapter health, approvals, and historical runs in native `details` elements or equivalent buttons with `aria-expanded`; default metrics/process/history closed while approvals containing pending items open automatically.

- [ ] **Step 6: Run frontend checks and commit**

Run: `node frontend-test.mjs && npm run check`

Expected: frontend structure assertions and syntax checks pass.

```powershell
git add index.html styles/tokens.css styles/shell.css styles/components.css styles/views.css frontend-test.mjs
git commit -m "feat: redesign adaptive workbench surfaces"
```

### Task 6: Discussion, Task, And Acceptance Views

**Files:**
- Modify: `ui/group-console.js`
- Modify: `ui/run-center.js`
- Modify: `app.js`
- Modify: `frontend-test.mjs`

- [ ] **Step 1: Add failing frontend assertions for shared dock behavior**

Assert `app.js` opens `discussion` for a group session, `task` for task selection, and `acceptance` for verification/review actions. Assert group console no longer calls `scrollIntoView` on the main workspace.

- [ ] **Step 2: Run the frontend test and confirm RED**

Run: `node frontend-test.mjs`

Expected: FAIL because group and task contexts still use separate page sections.

- [ ] **Step 3: Adapt the focused view modules**

`createGroupConsole` owns discussion subviews but receives the dock root. `createRunCenter` owns task output and acceptance tabs. Both preserve active inputs and scroll. Task selection calls `layout.contextDock.open('task', task.id)`, review/verification calls `open('acceptance', task.id)`, and session selection calls `open('discussion', session.id)`.

- [ ] **Step 4: Render context headers from selected entities**

Show the selected group/session, task, or acceptance result in the dock heading and status line. Missing persisted entities render an explicit empty state and fall back to the nearest active run/task without throwing.

- [ ] **Step 5: Run checks and commit**

Run: `npm run check && node frontend-test.mjs`

Expected: all syntax and frontend assertions pass.

```powershell
git add ui/group-console.js ui/run-center.js app.js frontend-test.mjs
git commit -m "feat: unify agent and task context views"
```

### Task 7: Run-Centered Rendering, Search, And Inline Feedback

**Files:**
- Create: `ui/command-search.js`
- Create: `command-search.test.mjs`
- Create: `ui/action-feedback.js`
- Create: `action-feedback.test.mjs`
- Modify: `app.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for search indexing and action state**

```js
import { buildSearchIndex, searchEntities } from './ui/command-search.js';
import { createActionState } from './ui/action-feedback.js';

test('search returns tasks with navigation context', () => {
  const index = buildSearchIndex({ runs: [], tasks: [{ id: 'task-1', title: 'SQLite recovery', run_id: 'run-1' }], groups: [], groupSessions: [], adapters: [] });
  assert.deepEqual(searchEntities(index, 'sqlite')[0].route, { view: 'tasks', runId: 'run-1', taskId: 'task-1' });
});

test('action state exposes pending and persistent failure text', () => {
  const state = createActionState();
  state.start('merge');
  assert.equal(state.get('merge').status, 'pending');
  state.fail('merge', new Error('branch is stale'));
  assert.equal(state.get('merge').message, 'branch is stale');
});
```

- [ ] **Step 2: Run the unit tests and confirm RED**

Run: `node --test command-search.test.mjs action-feedback.test.mjs`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement client-side search**

Index runs, tasks, groups, sessions, and adapters by ID, title/name, status, and adapter command. Return a route and context tab for each result. Bind `/` and `Ctrl+K` to focus search, arrow keys to move results, Enter to select, and Escape to close.

- [ ] **Step 4: Implement action feedback**

Track actions by stable entity/action key. While pending, disable only that action and show progress text. On success, show inline confirmation for 2 seconds. On failure, keep the row/panel message visible until the next attempt or dismissal.

- [ ] **Step 5: Render stage bar, next action, pending count, and compact exceptions**

Use `deriveRunStage` and `deriveNextAction` for the selected run. Render stage semantics with text and state classes, display one applicable operator command, and keep the existing detailed approval controls available in the acceptance dock.

- [ ] **Step 6: Run tests and commit**

Run: `node --test command-search.test.mjs action-feedback.test.mjs run-stage.test.mjs && npm run check`

Expected: all unit tests and syntax checks pass.

```powershell
git add ui/command-search.js command-search.test.mjs ui/action-feedback.js action-feedback.test.mjs app.js package.json
git commit -m "feat: add workbench search and inline actions"
```

### Task 8: Incremental Live Updates And Full Regression

**Files:**
- Modify: `app.js`
- Modify: `ui/state.js`
- Modify: `frontend-test.mjs`
- Modify: `README.md`
- Modify: `C:\Users\Lenovo\project-promot-intro.md`

- [ ] **Step 1: Add failing regression assertions for coalesced SSE refreshes**

Assert `app.js` imports `createRefreshScheduler`, uses one scheduler for all SSE event types, and captures/restores discussion input, dock scroll, and workspace scroll around affected renders.

- [ ] **Step 2: Run the frontend test and confirm RED**

Run: `node frontend-test.mjs`

Expected: FAIL because the existing SSE path still refreshes the full page state directly.

- [ ] **Step 3: Wire refresh scheduling and focused rendering**

Coalesce events for 100ms. Preserve selected IDs, hash route, focused input, workspace scroll, and dock scroll. Split `render` into shell, runs, groups, tasks, delivery, and context calls and invoke only units affected by the event type where event metadata identifies the entity; fall back to one stable full refresh when metadata is absent.

- [ ] **Step 4: Update usage documentation**

Document Overview/Focus, global search, stage bar, shared context dock, independent widths, collapse/reopen, discussion operator messages, task/acceptance tabs, inline failures, and Chrome desktop support. Preserve existing Agent setup, approval, PR, and recovery instructions.

- [ ] **Step 5: Run the complete automated verification**

Run: `npm test`

Expected: all domain, frontend, integration, and new workbench tests pass.

Run: `npm run check`

Expected: every JavaScript module passes syntax checking.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit the integrated workbench**

```powershell
git add app.js ui/state.js frontend-test.mjs README.md
git commit -m "feat: complete adaptive agent workbench"
```

`C:\Users\Lenovo\project-promot-intro.md` is a user-owned guide outside this Git worktree. Update it in the same step, verify it separately, and do not attempt to stage it in this repository.

### Task 9: Real Chrome Desktop Verification

**Files:**
- Create: `docs/verification/2026-07-18-adaptive-workbench-chrome.md`

- [ ] **Step 1: Start the AOD server**

Run: `npm start`

Expected: AOD listens on `http://127.0.0.1:4823` without startup errors.

- [ ] **Step 2: Connect to the user's Chrome on CDP port 9223**

Use the existing real Chrome CDP session. Open `http://127.0.0.1:4823`; do not use the Codex in-app browser.

- [ ] **Step 3: Verify both desktop viewports**

At `1280x800` and `1440x900`, verify expanded/collapsed navigation, Overview/Focus, each primary route, dock widths `320/500/620`, collapsed `52px` rail, all three dock tabs, empty/nonempty states, no overlap, and `document.documentElement.scrollWidth === document.documentElement.clientWidth`.

- [ ] **Step 4: Verify interaction timing and accessibility**

Measure computed transitions: hover `120ms`, tab `160ms`, open/reflow `200ms`, close `160ms`. Verify keyboard resize, tab semantics, icon names/tooltips, focus preservation during SSE refresh, and reduced-motion transition duration near zero.

- [ ] **Step 5: Record evidence and run final checks**

Write viewport, overflow, timing, interaction, console-error, and screenshot paths to the verification document.

Run: `npm test && npm run check && git diff --check`

Expected: all commands pass after browser verification.

- [ ] **Step 6: Commit verification evidence**

```powershell
git add docs/verification/2026-07-18-adaptive-workbench-chrome.md
git commit -m "test: verify adaptive workbench in Chrome"
```
