# AOD Selectable Project Workspaces Design

**Date:** 2026-07-18
**Status:** Approved design, pending written-spec review

## Goal

Allow AOD to register and select existing local Git repositories as project workspaces. The selected workspace becomes the default project for newly created plans, runs, standalone tasks, and group sessions. Existing entities remain permanently bound to the workspace where they were created.

Agent group discussions run from the bound project root so agents can inspect the real project. Discussion turns are read-only and must detect unexpected repository changes without reverting user files.

## Confirmed Decisions

- AOD remains one global local control plane with one SQLite database.
- Only existing Git repositories with at least one commit can be registered.
- Selecting a path inside a repository resolves and stores the repository's actual Git root.
- Switching the active workspace changes only the default for new work. It does not move, filter, or rebind existing entities.
- AOD continues to use the control plane's shared `.aod.config.json`; project repositories do not get separate Agent adapter configuration.
- Group discussion Agent processes run with the bound project root as `cwd`.
- Discussion is read-only. It may use adapter `discussionArgs`, falling back to `reviewArgs`, but never writable task `args`.
- A discussion turn compares repository HEAD and porcelain status before and after execution. Any change freezes the turn as `recovery_required`; AOD never automatically reverts user files.
- Dirty repositories may be registered and used for read-only discussion. Existing clean-worktree gates continue to block worktree creation, integration, merge, and publication where required.
- Desktop is the delivery target for this iteration. Mobile layout work is out of scope.

## Scope

This iteration includes:

- a persistent project workspace registry;
- an active workspace setting;
- server-side folder browsing and repository validation;
- immutable workspace bindings for plans, runs, tasks, group sessions, events, and Agent processes;
- workspace-aware Git, planning, execution, review, verification, merge, recovery, publication, and cleanup behavior;
- read-only group discussions rooted in the selected project;
- a desktop workspace selector and project selection dialog;
- project identity and unavailable-path states throughout the existing console;
- migration of existing data to the current control repository.

## Non-Goals

- Moving the AOD database or shared configuration into each project.
- Per-project Agent adapter settings.
- Registering non-Git folders, empty repositories, bare repositories, or repositories without a valid `HEAD` commit.
- Rebinding existing plans, runs, tasks, or sessions after creation.
- Automatically repairing, cleaning, resetting, or reverting a selected repository.
- Adding remote multi-user access, cloud storage, or GitHub repository discovery.
- Redesigning the mobile interface.

## Current Problem

The server currently captures one process-wide repository root:

```js
const root = resolve(process.cwd());
const aodDir = join(root, '.aod');
const configPath = join(root, '.aod.config.json');
```

Git helpers, Codex planning, run branches, task worktrees, group session directories, and publication behavior derive from that global `root`. Simply replacing `root` when the user switches projects would corrupt execution semantics: an old task could validate, merge, recover, or publish against the newly selected repository.

The design therefore separates the stable control-plane root from registered project roots and resolves every operation through the entity's immutable `workspace_id`.

## Architecture

### Stable control plane

The directory where AOD starts remains the control-plane root. It owns:

- `.aod/orchestrator.db`;
- `.aod.config.json`;
- SQLite backups and AOD operational logs;
- the web server and static console.

This path never changes while the process is running.

### Workspace registry

`project_workspaces` stores normalized local repositories. A setting named `active_workspace_id` points to the workspace used by default for new entities.

The server introduces one workspace resolution boundary. Callers resolve a workspace record first, then pass its `git_root` explicitly to Git and process helpers. Helpers must not silently fall back to the active workspace when handling an existing entity.

Suggested focused modules:

- `workspace-domain.mjs`: normalization, validation result shaping, binding rules, status transitions, and pure invariants;
- server persistence helpers: SQLite CRUD and migration;
- server execution helpers: resolve an entity's workspace and provide explicit `cwd` values.

The exact file split may follow the codebase's existing patterns, but the domain rules must remain independently testable.

## Data Model

### `project_workspaces`

| Column | Meaning |
| --- | --- |
| `id` | Stable identifier such as `WS-001` |
| `name` | User-facing project name, initially derived from the Git root folder |
| `path` | Normalized selected path for audit; normally equal to `git_root` after resolution |
| `git_root` | Canonical normalized absolute Git worktree root |
| `head_commit` | Last observed full `HEAD` commit |
| `branch` | Last observed branch name or detached-HEAD label |
| `status` | `ready`, `unavailable`, or `invalid` |
| `last_error` | Latest validation/access error, nullable |
| `created_at` | Creation timestamp |
| `updated_at` | Last metadata refresh timestamp |
| `last_selected_at` | Last time this workspace became active |

`git_root` is unique using Windows-appropriate normalized path comparison. Registering the same repository through a subfolder or alternate slash/case form returns or updates the existing workspace instead of creating a duplicate.

### Entity bindings

Add nullable-then-backfilled `workspace_id` foreign keys to:

- `plans`;
- `runs`;
- `tasks`;
- `group_sessions`;
- `events`;
- `agent_processes`.

After migration, application writes treat these bindings as required. Events and process rows copy the workspace ID of the owning entity so diagnostics remain attributable even if that entity is later archived.

Group templates remain global. A group session freezes both its existing member/rule snapshot and its workspace binding.

### Migration

On first startup after the schema upgrade:

1. Validate the control-plane repository and insert it as `WS-001`.
2. Set `active_workspace_id` to `WS-001`.
3. Backfill every existing plan, run, task, group session, event, and Agent process to `WS-001`.
4. Preserve all existing IDs, timestamps, statuses, logs, and relationships.
5. Run the migration transactionally and idempotently.

If the control-plane directory cannot be validated as a Git repository with a commit, startup must stop with a specific migration error rather than silently attaching historical data to an invalid workspace.

## Repository Validation

Validation accepts an absolute existing directory and performs structured Git commands with that directory as `cwd`:

1. Confirm the path exists and is a directory.
2. Resolve `git rev-parse --show-toplevel`.
3. Reject bare repositories using `git rev-parse --is-bare-repository`.
4. Resolve and require `git rev-parse HEAD`.
5. Read branch metadata with `git branch --show-current`; detached HEAD is valid and clearly labelled.
6. Read `git status --porcelain` for dirty/clean presentation.
7. Normalize the resolved root and detect an already registered workspace.

Validation returns a structured result containing the resolved root, display name, branch, HEAD, dirty state, duplicate workspace ID when applicable, and a machine-readable error code on failure.

The directory browser is server-backed. It lists child directories only, does not read file contents, and rejects relative paths. Access errors are returned inline without terminating the server.

## Binding Rules

- A new plan captures `active_workspace_id` at creation.
- A run created from a plan inherits the plan workspace.
- A run created from a confirmed group session inherits the session workspace.
- Every task in a run inherits the run workspace.
- A standalone task captures the active workspace at creation.
- A group session captures the active workspace at creation; later workspace switching does not affect it.
- Verification, Reviewer, conflict review, merge, recovery, GitHub publication, report export, and cleanup resolve the workspace from the owning task/run/session.
- `workspace_id` cannot be changed through normal update endpoints.
- If a bound path becomes unavailable, the entity remains bound and enters a clear blocked/unavailable presentation. It is never redirected to the active workspace.

All expanded entity responses expose `workspaceId`, `workspaceName`, and `workspacePath`.

## Execution Behavior

Every Git command and child process receives an explicit workspace or worktree `cwd`.

- Codex planning runs in the plan's bound project root.
- A run integration branch is created from the run workspace repository.
- Run and task worktree storage derives from a stable workspace-specific namespace so same-named projects cannot collide. The implementation may use the workspace ID in the existing sibling storage convention.
- Task Agents continue to run only in their task worktrees.
- Verification runs in the task worktree and remains commit-bound.
- Check/review worktrees derive from the same bound repository.
- Integration, conflict handling, publication, local-main sync, retention, and cleanup never consult the currently active workspace.

Before mutating operations, workspace metadata is refreshed and existing clean-repository gates run against the bound project. Dirty state remains a visible, actionable gate rather than an implicit failure.

## Read-Only Group Discussion

Group discussion no longer runs in a synthetic empty session directory. Each turn launches the selected member adapter with the group session's project root as `cwd`, giving the Agent read access to the real repository context.

Adapter argument selection is strict:

1. Use `discussionArgs` when configured.
2. Otherwise use `reviewArgs`.
3. If neither is configured, fail the turn with a configuration error.
4. Never fall back to writable execution `args`.

Before launching a turn, record:

- `git rev-parse HEAD`;
- `git status --porcelain` as an exact normalized snapshot.

After process exit, timeout, cancellation, or launch failure, capture both values again. If either differs:

- mark the turn and session `recovery_required`;
- emit an audit event containing before/after HEAD and status summaries;
- stop automatic progression to the next turn;
- preserve all files exactly as found;
- require an operator recovery decision after manually inspecting the repository.

This detects accidental writes but cannot prove that an Agent did not write and restore identical content. The first version relies on review-mode adapter arguments plus before/after Git checks; OS-level filesystem sandboxing is outside scope.

Dirty repositories are allowed because snapshot comparison detects changes relative to the initial state rather than requiring an initially clean tree.

## Shared Agent Configuration

The control-plane `.aod.config.json` remains the sole adapter source. The feature adds support for optional `discussionArgs` while preserving existing adapter keys and `reviewArgs` compatibility.

No credentials, tokens, or adapter commands are copied into project repositories or stored in `project_workspaces`. Existing log redaction applies to workspace-aware Agent output and events.

## Public APIs

### `GET /api/workspaces`

Returns registered workspaces, current observed metadata, active workspace ID, availability, and dirty state.

### `GET /api/filesystem/directories?path=<absolute-path>`

Returns the normalized current directory, optional parent, and accessible child directories. Relative paths and file paths are rejected.

### `POST /api/workspaces/validate`

Accepts `{ "path": "C:\\absolute\\project" }` and returns repository validation without persisting or selecting it.

### `POST /api/workspaces`

Validates and registers an existing repository. Duplicate roots return the existing workspace with a duplicate indicator. Registration alone does not have to switch the active workspace.

### `POST /api/workspaces/:id/select`

Revalidates the repository, refreshes its metadata, sets `active_workspace_id`, and emits a workspace-selection event. Invalid or unavailable workspaces cannot be selected.

### Existing APIs

Existing plan, run, task, group, Reviewer, merge, recovery, publication, report, state, and SSE endpoints remain compatible. Their expanded payloads include workspace identity. `/api/state` continues to return all projects and entities; active workspace selection is not a server-side filter.

## Desktop Console

### Top bar selector

Add a persistent workspace control to the top bar showing:

- project name;
- current branch or detached state;
- shortened path;
- clean, dirty, or unavailable status.

Changing it opens the project selection dialog. Selection updates the default context for new work and does not visually remove old runs or sessions.

### Project selection dialog

The desktop dialog contains:

- registered/recent project list;
- server-backed directory browser with parent navigation;
- direct absolute-path input;
- explicit validation action and result;
- repository root, branch, commit, and dirty-state preview;
- a select action enabled only after valid repository validation.

Rounded controls should match the established adaptive workbench styling. Transitions use the existing faster motion timing and must preserve stable panel dimensions.

### Project identity in existing views

- Runs, tasks, approvals, and group sessions show compact workspace badges.
- Badge hover exposes the full path.
- The context dock shows the selected entity's bound project, which may differ from the top bar's active project.
- Global search indexes workspace name and path.
- Unavailable bound projects show inline errors and disable only actions that require filesystem access.

## Error Handling

- Missing or inaccessible paths set the workspace to `unavailable` with `last_error`; they do not delete the registry row or entity bindings.
- Paths that exist but fail Git validation are `invalid` and cannot become active.
- A repository subdirectory resolves to its Git root and is represented once.
- Dirty state is metadata, not an invalid registration state.
- Detached HEAD is valid for registration and read-only discussion; existing branch/worktree gates decide whether a mutating workflow may proceed.
- Workspace deletion is not included. Historical bindings therefore remain resolvable.
- API errors include stable codes and human-readable messages suitable for inline display.
- Switching active workspace is serialized in SQLite and emits SSE so all open console views converge.

## Security and Operational Constraints

- Directory browsing accepts only absolute local paths and returns directory names/paths, not file content.
- All Git and Agent invocations use argument arrays; paths are never concatenated into shell command strings.
- The database stores local paths but not repository credentials.
- Shared log redaction applies before persistence and SSE delivery.
- Cleanup verifies the target belongs to the bound workspace's AOD-managed worktree namespace and is not an active/recovery worktree.
- Repository write detection never triggers automatic reset, checkout, clean, or file deletion.

## Test Plan

### Domain and persistence tests

- Normalize Windows paths, slash variants, case variants, repository subfolders, and duplicate roots.
- Validate a normal repository, dirty repository, detached HEAD, non-Git directory, bare repository, missing path, inaccessible path, and repository without a commit.
- Migrate an existing database to `WS-001` transactionally and idempotently.
- Verify immutable plan, run, task, session, event, and process bindings.
- Verify active switching affects only newly created entities.
- Verify unavailable workspaces preserve historical bindings and errors.

### Execution tests

- Plan in workspace A, switch to B, then prove planning/run creation still uses A.
- Create standalone tasks and sessions before and after a switch and verify their `cwd` values.
- Verify task worktrees and run integration branches cannot collide across projects.
- Verify validation, review, merge, recovery, publication, sync, and cleanup resolve the bound workspace.
- Verify dirty repositories are accepted for discussion but rejected by existing mutation gates where required.
- Verify `discussionArgs` takes precedence, `reviewArgs` is the only fallback, and writable `args` is never used.
- Verify unchanged clean and dirty discussion repositories advance normally.
- Verify HEAD or porcelain-status changes freeze the turn in `recovery_required` and leave files untouched.
- Verify timeout, cancellation, non-zero exit, and launch failure still run the after-snapshot check.

### API and SSE tests

- Register, validate, deduplicate, list, and select workspaces.
- Browse accessible directories and handle invalid, relative, file, and inaccessible paths.
- Confirm expanded entity payloads expose workspace identity.
- Confirm `/api/state` keeps entities from all workspaces.
- Confirm workspace selection and unavailable-state events reach multiple SSE clients in order.

### Real Chrome verification

Use the user's Chrome through CDP on port `9223`; do not use the Codex built-in browser.

- Register a second real test repository through the directory browser and direct-path input.
- Select between two repositories and verify top-bar metadata updates.
- Confirm older runs/tasks/sessions remain visible with their original workspace badges.
- Confirm context dock identity differs correctly from active workspace when inspecting an old entity.
- Confirm unavailable and dirty states render with correct disabled actions and inline explanations.
- Verify the desktop console at 1280x800 and 1440x900 has no accidental horizontal overflow, clipped dialog controls, overlap, or console errors.

## Acceptance Criteria

The feature is complete when:

1. A user can browse to or enter an existing committed Git repository, validate it, register it, and select it from the desktop console.
2. New plans, runs, tasks, and group sessions bind to the selected workspace.
3. Switching projects cannot change the Git root or process `cwd` used by existing entities.
4. Group discussion Agents inspect the bound project root using only read-only adapter arguments.
5. Any before/after HEAD or status change freezes discussion and never causes an automatic revert.
6. Existing single-project data migrates without loss to `WS-001`.
7. Missing, invalid, dirty, detached, duplicate, and subdirectory cases behave as specified.
8. Existing task, Reviewer, merge, recovery, and GitHub workflows remain compatible and workspace-correct.
9. Automated tests pass and the desktop workflow is verified in the user's Chrome via CDP `9223`.
