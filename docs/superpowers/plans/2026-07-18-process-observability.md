# Process Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every Agent invocation with a renewable lease, classify interrupted processes after restart, and expose run/adapter operational metrics from the same ledger.

**Architecture:** Add a pure process domain module for restart classification and metric aggregation, then add an `agent_processes` SQLite ledger in the daemon. Every task, group turn, conflict reviewer, role reviewer/fixer, and planner process opens one ledger row, renews it on a timer/output, and writes one terminal outcome. Recovery and metrics read this append-only history; existing task and merge gates remain unchanged.

**Tech Stack:** Node.js ES modules, `node:sqlite`, native child processes, native HTML/CSS/JavaScript, Node test runner.

---

### Task 1: Recovery And Metrics Domain

**Files:**
- Create: `process-domain.mjs`
- Create: `process-domain.test.mjs`
- Modify: `package.json`

- [x] Add a failing test for `classifyInterruptedProcess(record, observation, at)` covering: missing PID as `stale`, live PID with an unexpired lease as `live`, and live PID with an expired lease as `unverifiable`.
- [x] Run `node --test process-domain.test.mjs` and confirm the missing module failure.
- [x] Implement the pure classifier using ISO timestamps and an injected `{ alive }` observation.
- [x] Add a failing test for `buildProcessMetrics(rows, options)` covering adapter totals, success/failure/timeout rates, attempts, average duration, failure reasons, run totals, token/cost sums, peak concurrency, and capacity utilization.
- [x] Run the test and confirm metric assertions fail for missing behavior.
- [x] Implement a sweep-line aggregation clipped to the requested time range; keep token and cost fields optional and numeric only.
- [x] Add the module and test to `npm test` and `npm run check`, then run both commands.

### Task 2: Persistent Process Ledger

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`

- [x] Add integration assertions for `GET /api/processes`: a running task exposes PID, lease owner, heartbeat, output timestamp, adapter, task/run IDs, and timeout; its completed row exposes exit code and exactly one terminal state.
- [x] Run `node test.mjs` and confirm `/api/processes` is missing.
- [x] Add `agent_processes` and indexes to SQLite with fields for kind, entity links, adapter, status, PID, lease owner/expiry, heartbeat/output timestamps, timeout, attempt, exit code, terminal reason, token/cost values, and metadata JSON.
- [x] Add ledger helpers that create a row after spawn, renew heartbeat/lease on an unref'ed interval, touch output timestamps, and finalize idempotently.
- [x] Instrument ordinary tasks and group turns, preserving their existing process maps, retry behavior, logs, and state transitions.
- [x] Instrument conflict reviewers, role reviewers/fixers, and planners with the same helpers.
- [x] Add `GET /api/processes` and a bounded process summary to `/api/state.runtime`; redact terminal reasons and metadata before returning them.
- [x] Run `node test.mjs`, `npm test`, `npm run check`, and `git diff --check`.
- [x] Commit with `feat: add persistent agent process leases`.

### Task 3: Restart Recovery Classification

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`
- Modify: `docs/USER_GUIDE.zh-CN.md`

- [x] Add restart fixtures containing three running process rows: a dead PID, the live test-runner PID with a fresh lease, and the live test-runner PID with an expired lease.
- [x] Restart the daemon and assert recovery states are respectively `stale`, `live`, and `unverifiable`; assert affected task/group/review entities remain behind operator recovery gates.
- [x] Replace blanket startup recovery notes with classification-specific notes while retaining process rows and clearing only entity-level attached PID fields.
- [x] Ensure startup recovery never reports a recovered process as completed and never auto-kills or auto-retries it.
- [x] Document the three classifications and operator expectations.
- [x] Run full verification and commit with `feat: classify interrupted agent processes`.

### Task 4: Operational Metrics API

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`

- [ ] Add integration assertions for `GET /api/metrics` default totals and `?runId=<id>` filtering, including completed, failed, and timed-out fixture invocations.
- [ ] Run `node test.mjs` and confirm the endpoint is missing.
- [ ] Build metrics from `agent_processes`, accepting bounded `from`, `to`, and `runId` query values and using the configured max concurrency as capacity.
- [ ] Return `{ range, summary, adapters, runs, failures, concurrency }` with stable numeric fields and no raw prompts/output.
- [ ] Include a compact metrics summary in `/api/state` for SSE refreshes.
- [ ] Run integration and domain tests, then commit with `feat: expose agent runtime metrics`.

### Task 5: Desktop Process And Metrics Views

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles/views.css`
- Modify: `frontend-test.mjs`
- Modify: `docs/USER_GUIDE.zh-CN.md`

- [ ] Add failing frontend contract checks for `#processMonitor`, `#metricsBoard`, recovery-state labels, adapter metric rows, and runtime refresh rendering.
- [ ] Run `node frontend-test.mjs` and confirm the new contracts fail.
- [ ] Add a compact process monitor showing kind, Agent, linked entity, PID, heartbeat/output age, lease, and terminal/recovery state.
- [ ] Add a metrics band showing invocation count, success/timeout rate, average duration, retries, peak concurrency/utilization, and per-adapter rows.
- [ ] Keep process output and prompts out of the metrics view; link entities to existing detail views.
- [ ] Verify the desktop layout at 1440x900 in real Google Chrome via CDP, check zero horizontal overflow, and save a screenshot under `.aod/`.
- [ ] Run `npm test`, `npm run check`, and `git diff --check`.
- [ ] Commit with `feat: add process observability dashboard`.
