# Agent Multi-Seat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one Agent adapter to occupy multiple independently configured seats in a persistent Agent group.

**Architecture:** Keep `agent` as the adapter lookup key and make the existing member `key` the group-local seat identity. Rebuild the legacy SQLite member table to remove only `UNIQUE(group_id, agent)`, then replace the fixed three-row editor with a dynamic roster that submits unique seat keys.

**Tech Stack:** Node.js, `node:sqlite`, native HTML/CSS/JavaScript, Node test runner.

---

### Task 1: Domain Contract

**Files:**
- Modify: `group-domain.test.mjs`
- Modify: `group-domain.mjs`

- [ ] Replace the duplicate-adapter rejection test with a test that submits executor, reviewer, and fixer seats using `claude-code` and asserts all three normalized members remain distinct by key.
- [ ] Run `node --test group-domain.test.mjs` and confirm it fails with `Duplicate agent in group`.
- [ ] Remove adapter uniqueness validation while retaining duplicate key, supported adapter, and role validation.
- [ ] Re-run `node --test group-domain.test.mjs` and confirm it passes.

### Task 2: SQLite Migration

**Files:**
- Create: `group-schema.mjs`
- Create: `group-schema.test.mjs`
- Modify: `server.mjs`
- Modify: `package.json`

- [ ] Create an in-memory legacy member table with `UNIQUE(group_id, agent)`, insert an existing moderator member, call `migrateAgentGroupMembers`, then assert a second row with the same adapter succeeds and a duplicate key still fails.
- [ ] Run `node --test group-schema.test.mjs` and confirm the missing module fails.
- [ ] Implement `migrateAgentGroupMembers(db)` to inspect the table SQL, disable foreign keys, transactionally rebuild the table without adapter uniqueness, copy all rows, and restore the original foreign-key setting.
- [ ] Import and call the migration after initial schema creation, and add the migration test to `npm test` and `npm run check`.
- [ ] Re-run the migration and domain tests.

### Task 3: API And Session Snapshot

**Files:**
- Modify: `test.mjs`
- Modify: `server.mjs`

- [ ] Add an integration case that creates a group containing three `claude-code` seats with unique keys and roles, then assert the API and a new session snapshot preserve all three seats.
- [ ] Run `node test.mjs` and confirm group creation fails on the legacy unique constraint before the migration implementation is active.
- [ ] Keep create, patch, and session snapshot operations keyed by member key and member ID; ensure no adapter-based lookup collapses repeated seats.
- [ ] Re-run the integration test and confirm the multi-seat group succeeds.

### Task 4: Dynamic Group Editor

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles/views.css`
- Modify: `frontend-test.mjs`

- [ ] Add contract assertions for `#addGroupMember`, the member-row template, an adapter selector, and a remove-seat control; run `node frontend-test.mjs` and confirm failure.
- [ ] Replace the fixed enabled rows with a dynamic editor and template containing adapter, role, display name, instructions, moderator, and remove controls.
- [ ] Render default and existing members, generate unique adapter-based keys for new seats, and read every rendered row into the current group API payload.
- [ ] Update desktop styling for the five-column roster and retain existing narrow-container behavior.
- [ ] Re-run frontend contract and syntax checks.

### Task 5: Verification And Commit

**Files:**
- Modify: `docs/USER_GUIDE.zh-CN.md`

- [ ] Document repeated Agent seats and their independent roles and outputs.
- [ ] Run `npm test`, `npm run check`, and `git diff --check`.
- [ ] Use the user's Google Chrome to create and edit a group with three Claude Code seats, verify unique seat identities and no horizontal overflow, and leave the result visible.
- [ ] Review the staged diff and commit with `feat: support multiple seats per agent`.
