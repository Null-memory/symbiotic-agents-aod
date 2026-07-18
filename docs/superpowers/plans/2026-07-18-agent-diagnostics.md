# Agent Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators a persistent preflight view of adapter configuration, executable discovery, version, authentication readiness, and probe latency.

**Architecture:** The server runs bounded non-interactive probes from `.aod.config.json`, redacts their output, and stores only diagnostic results in SQLite. The groups workspace renders those results and exposes explicit per-adapter and check-all actions; credentials remain owned by each CLI.

**Tech Stack:** Node.js child processes, SQLite, native HTML/CSS/JavaScript, Node integration tests.

---

### Task 1: Diagnostic Persistence And API

**Files:**
- Modify: `server.mjs`
- Modify: `test.mjs`

- [ ] Add integration expectations for `POST /api/agents/codex/check`, a failed authentication probe, output redaction, and `GET /api/agents/health` persistence.
- [ ] Run `node test.mjs` and confirm the endpoints are missing.
- [ ] Create `agent_health_checks` with one latest row per adapter and fields for configuration, status, command, resolved path, version, authentication status, latency, message, and checked time.
- [ ] Resolve commands with `where.exe` on Windows or `which` elsewhere, run `health.versionArgs` or `--version`, optionally run `health.authArgs`, and cap each probe with `health.timeoutMs` or 10 seconds.
- [ ] Return diagnostic failures as persisted `error` or `unconfigured` results instead of HTTP failures; reject unknown adapter keys.
- [ ] Broadcast `agent_health` events after each check.

### Task 2: Diagnostic Console

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles/views.css`
- Modify: `frontend-test.mjs`

- [ ] Add failing contract assertions for `#agentHealthBoard`, `#checkAllAgents`, and per-adapter check actions.
- [ ] Add an unframed diagnostics section before group templates with compact rows for adapter, executable, version, auth, latency, status, and check action.
- [ ] Render state from `/api/state`, check adapters sequentially for the all action, and refresh through the existing API/SSE flow.
- [ ] Add status colors and stable responsive tracks without horizontal overflow.

### Task 3: Verification

**Files:**
- Modify: `aod.config.example.json`
- Modify: `docs/USER_GUIDE.zh-CN.md`

- [ ] Document optional `health.versionArgs`, `health.authArgs`, and `health.timeoutMs` fields without asserting CLI-specific auth commands.
- [ ] Run `npm test`, `npm run check`, and `git diff --check`.
- [ ] Restart the local service and use Google Chrome to run a check and inspect the resulting status rows.
- [ ] Commit with `feat: add agent adapter diagnostics`.
