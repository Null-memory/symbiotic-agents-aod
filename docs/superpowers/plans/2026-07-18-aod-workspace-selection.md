# AOD Selectable Project Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AOD register and select existing committed Git repositories while permanently binding every plan, run, task, and group session to its creation workspace.

**Architecture:** Keep the current startup directory as the stable control plane and add an SQLite workspace registry. Put path/repository invariants in a small pure module, resolve entity workspaces explicitly in `server.mjs`, and isolate the desktop selector in a dedicated UI module. Group turns run in the bound repository with review-only arguments and before/after Git snapshots.

**Tech Stack:** Node.js ESM, `node:sqlite`, native HTTP/SSE, Git CLI, HTML/CSS/JavaScript, Node test runner, Chrome CDP.

---

### Task 1: Workspace Domain Rules

**Files:**
- Create: `workspace-domain.mjs`
- Create: `workspace-domain.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing path and validation-shape tests**

```js
test('normalizes Windows workspace paths for identity', () => {
  assert.equal(workspacePathKey('C:\\Code\\Demo\\'), 'c:\\code\\demo');
});

test('rejects relative browse and validation paths', () => {
  assert.throws(() => requireAbsoluteDirectoryPath('demo'), /absolute/i);
});

test('creates immutable entity workspace fields', () => {
  assert.deepEqual(workspaceIdentity({ id: 'WS-002', name: 'Demo', git_root: 'C:\\Code\\Demo' }), {
    workspaceId: 'WS-002', workspaceName: 'Demo', workspacePath: 'C:\\Code\\Demo'
  });
});
```

- [ ] **Step 2: Run the domain test and verify RED**

Run: `node --test workspace-domain.test.mjs`

Expected: FAIL because `workspace-domain.mjs` does not exist.

- [ ] **Step 3: Implement minimal pure helpers**

```js
export function requireAbsoluteDirectoryPath(value) { /* trim, resolve and reject non-absolute input */ }
export function workspacePathKey(value) { /* normalize separators, trailing slash and Windows case */ }
export function workspaceIdentity(row) { /* map SQLite columns to public camelCase fields */ }
export function didRepositorySnapshotChange(before, after) { /* compare HEAD and exact status */ }
```

- [ ] **Step 4: Run focused and complete unit suites**

Run: `node --test workspace-domain.test.mjs`

Expected: all workspace-domain tests PASS.

- [ ] **Step 5: Add the module to `check` and `test`, then commit**

```powershell
git add workspace-domain.mjs workspace-domain.test.mjs package.json
git commit -m "feat: add workspace domain rules"
```

### Task 2: Workspace Registry, Migration, and APIs

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`

- [ ] **Step 1: Add failing integration assertions**

Add integration coverage that starts AOD in repository A, creates repository B, then asserts:

```js
const initial = await api('/api/workspaces');
assert.equal(initial.activeWorkspaceId, 'WS-001');
const validation = await api('/api/workspaces/validate', {
  method: 'POST', body: JSON.stringify({ path: nestedFolderInRepositoryB })
});
assert.equal(validation.gitRoot, repositoryB);
const registered = await api('/api/workspaces', {
  method: 'POST', body: JSON.stringify({ path: nestedFolderInRepositoryB })
});
await api(`/api/workspaces/${registered.id}/select`, { method: 'POST' });
assert.equal((await api('/api/state')).activeWorkspaceId, registered.id);
```

Also assert duplicate registration, non-Git rejection, relative path rejection, and directory listing behavior.

- [ ] **Step 2: Run integration test and verify RED**

Run: `node test.mjs`

Expected: FAIL with 404 for `/api/workspaces`.

- [ ] **Step 3: Add schema, migration, repository validation, and endpoints**

Add `project_workspaces`, `active_workspace_id`, and workspace columns. On startup, register the control repository as `WS-001` and backfill legacy rows transactionally. Implement:

```text
GET  /api/workspaces
GET  /api/filesystem/directories?path=<absolute>
POST /api/workspaces/validate
POST /api/workspaces
POST /api/workspaces/:id/select
```

Git validation must resolve `--show-toplevel`, reject bare/no-HEAD repositories, expose branch/commit/dirty state, and deduplicate normalized Git roots.

- [ ] **Step 4: Verify registry API GREEN**

Run: `node test.mjs`

Expected: integration suite PASS including migration and API cases.

- [ ] **Step 5: Commit registry slice**

```powershell
git add server.mjs test.mjs
git commit -m "feat: add project workspace registry"
```

### Task 3: Immutable Entity Binding and Workspace-Aware Execution

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`

- [ ] **Step 1: Add failing cross-project binding tests**

Create a plan/session in repository A, switch to B, and assert the old entity still reports A. Create new entities and assert they report B. Exercise planning/run/task preparation with test adapters that print `process.cwd()` and assert each operation uses its bound repository or managed worktree.

- [ ] **Step 2: Run integration test and verify RED**

Run: `node test.mjs`

Expected: FAIL because existing inserts and execution helpers still use the process-wide root.

- [ ] **Step 3: Thread workspace IDs through persistence and execution**

Capture/inherit workspace IDs at each creation boundary. Expand public rows with:

```js
{ workspaceId, workspaceName, workspacePath }
```

Resolve the bound workspace for planning, integration branches/worktrees, task worktrees, verification, review, merge, recovery, GitHub publication, report and cleanup. Keep `.aod.config.json` and the database rooted at the control directory.

- [ ] **Step 4: Verify immutable binding GREEN**

Run: `node test.mjs`

Expected: all cross-project binding and existing integration cases PASS.

- [ ] **Step 5: Commit execution slice**

```powershell
git add server.mjs test.mjs
git commit -m "feat: bind orchestration entities to workspaces"
```

### Task 4: Read-Only Group Discussion Protection

**Files:**
- Modify: `server.mjs`
- Modify: `aod.config.example.json`
- Modify: `test.mjs`

- [ ] **Step 1: Add failing group-turn safety tests**

Configure `discussionArgs` and `reviewArgs` fixture adapters. Assert `discussionArgs` wins, `reviewArgs` is the only fallback, task `args` is never used, and `cwd` equals the session workspace. Add a mutating fixture turn and assert the session reaches `recovery_required` while the changed file remains unchanged by AOD.

- [ ] **Step 2: Run integration test and verify RED**

Run: `node test.mjs`

Expected: FAIL because group turns currently run in a synthetic session folder and do not snapshot Git state.

- [ ] **Step 3: Implement protected group execution**

Record `{ head, status }` before and after every turn termination path. Launch only with `discussionArgs ?? reviewArgs`; fail clearly if neither exists. If snapshots differ, persist audit metadata, mark turn/session `recovery_required`, stop progression, and never call reset/checkout/clean.

- [ ] **Step 4: Verify group protection GREEN**

Run: `node test.mjs`

Expected: group safety and all existing integration tests PASS.

- [ ] **Step 5: Commit group safety slice**

```powershell
git add server.mjs test.mjs aod.config.example.json
git commit -m "feat: run group discussions in bound projects"
```

### Task 5: Desktop Workspace Selector

**Files:**
- Create: `ui/workspaces.js`
- Modify: `index.html`
- Modify: `app.js`
- Modify: `ui/api.js`
- Modify: `styles/shell.css`
- Modify: `styles/components.css`
- Modify: `styles/views.css`
- Modify: `frontend-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing frontend contract assertions**

Require `#workspaceSelector`, `#workspaceDialog`, registered list, directory browser, absolute-path input, validation preview, and select action. Assert `app.js` initializes `createWorkspaceController`, entity renderers expose workspace badges, and the new module calls all five workspace APIs.

- [ ] **Step 2: Run frontend test and verify RED**

Run: `node frontend-test.mjs`

Expected: FAIL because workspace controls and module do not exist.

- [ ] **Step 3: Implement selector UI and project identity**

Create a top-bar control showing name, branch, shortened path and status. Build the rounded desktop dialog with registered projects, server directory navigation, direct path validation, and guarded selection. Add workspace badges/tooltips to runs, tasks, approvals and sessions, bound workspace details to the context dock, and workspace text to search indexing.

- [ ] **Step 4: Verify frontend GREEN**

Run: `node frontend-test.mjs && npm run check`

Expected: frontend contract passes and all JavaScript parses.

- [ ] **Step 5: Commit frontend slice**

```powershell
git add ui/workspaces.js index.html app.js ui/api.js styles/shell.css styles/components.css styles/views.css frontend-test.mjs package.json
git commit -m "feat: add desktop project workspace selector"
```

### Task 6: Full Verification and Real Chrome

**Files:**
- Modify: `README.md`
- Modify: `docs/USER_GUIDE.zh-CN.md`
- Create: `docs/verification/2026-07-18-workspace-selection-chrome.md`

- [ ] **Step 1: Document workspace semantics and configuration**

Document registration requirements, active-versus-bound workspace behavior, dirty/unavailable cases, shared Agent configuration, and read-only discussion arguments.

- [ ] **Step 2: Run complete automated verification**

Run: `npm test && npm run check && git diff --check`

Expected: all tests PASS, syntax checks PASS, no whitespace errors.

- [ ] **Step 3: Start the development server on a free port**

Run AOD from the feature worktree and record the chosen URL.

- [ ] **Step 4: Verify in the user's Chrome via CDP 9223**

At 1280x800 and 1440x900, register/select a second repository, inspect an old bound entity, exercise dirty/unavailable presentation, and assert zero console errors and zero horizontal overflow. Do not use the Codex built-in browser.

- [ ] **Step 5: Save evidence and commit**

```powershell
git add README.md docs/USER_GUIDE.zh-CN.md docs/verification/2026-07-18-workspace-selection-chrome.md
git commit -m "docs: verify selectable project workspaces"
```
