# Unified Approval Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project every operator decision into one auditable inbox without bypassing task, group, conflict, run, or GitHub gates.

**Architecture:** A pure projection module derives deterministic approval items from current persisted states. The server exposes the projection and a stale-safe action endpoint for actions that need no additional editor input; complex decisions navigate to their existing detailed controls.

**Tech Stack:** Node.js modules, SQLite-backed server state, native HTML/CSS/JavaScript, Node test runner.

---

### Task 1: Approval Projection

**Files:**
- Create: `approval-domain.mjs`
- Create: `approval-domain.test.mjs`
- Modify: `package.json`

- [x] Test task start and merge approvals, suggested conflict patches without duplicate task conflict items, group confirmation and recovery, run publish, and CI-passed external PR merge.
- [x] Run the new test and confirm the module is missing.
- [x] Implement deterministic items with `id`, `kind`, entity IDs, title, description, risk, creation time, and allowed actions.
- [x] Add the module and test to syntax and test scripts.

### Task 2: API And Stale-Safe Actions

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`

- [x] Add integration expectations for `GET /api/approvals`, `/api/state.approvals`, task start through `POST /api/approvals/action`, and rejection after the approval becomes stale.
- [x] Run the integration test and confirm the endpoints are missing.
- [x] Build the inbox from current tasks, runs, reviews, and group session summaries.
- [x] Re-read the inbox for every action and reject missing IDs or actions that are no longer allowed.
- [x] Delegate `prepare`, `start`, `merge`, and `publish` to existing domain operations; do not implement generic conflict, group consensus, recovery, or PR merge mutations.

### Task 3: Desktop Approval Center

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles/views.css`
- Modify: `frontend-test.mjs`

- [x] Add failing contract checks for `#approvalBoard` and approval action controls.
- [x] Add a dense approval section under the run summary and display the total in the existing “需处理” metric.
- [x] Trigger server-backed simple actions explicitly; route complex items to task, group, review, delivery, or external PR views.
- [x] Keep rows stable and overflow-free on desktop container widths.

### Task 4: Verification

**Files:**
- Modify: `docs/USER_GUIDE.zh-CN.md`

- [x] Document approval kinds and which ones remain detailed/manual.
- [x] Run full tests, syntax checks, and diff checks.
- [x] Restart AOD and verify the inbox in Google Chrome.
- [x] Commit with `feat: add unified approval inbox`.
