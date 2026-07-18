import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { buildApprovalInbox } from './approval-domain.mjs';
import { validateConsensusDraft, validateGroupDraft } from './group-domain.mjs';
import { migrateAgentGroupMembers } from './group-schema.mjs';
import { classifyInterruptedProcess } from './process-domain.mjs';

const root = resolve(process.cwd());
const aodDir = join(root, '.aod');
const databasePath = join(aodDir, 'orchestrator.db');
const legacyStatePath = join(aodDir, 'state.json');
const handoffDir = join(aodDir, 'handoffs');
const configPath = join(root, '.aod.config.json');
const port = Number(process.env.PORT || 4821);
const agents = ['codex', 'claude-code', 'antigravity'];
const statuses = ['draft', 'preparing', 'ready', 'running', 'verifying', 'reviewing', 'repairing', 'merge_ready', 'merging', 'conflict_review', 'recovery_required', 'failed', 'cancelled', 'merged'];
const transitions = {
  draft: ['preparing', 'cancelled'],
  preparing: ['ready', 'failed'],
  ready: ['running', 'cancelled'],
  running: ['verifying', 'failed'],
  verifying: ['failed'],
  reviewing: ['recovery_required', 'failed'],
  repairing: ['recovery_required', 'failed'],
  merge_ready: ['failed'],
  merging: ['failed'],
  conflict_review: [],
  recovery_required: ['ready', 'cancelled'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
  merged: []
};
const runtimeModes = ['manual', 'hybrid', 'auto'];
const taskProcesses = new Map();
const reviewProcesses = new Map();
const groupProcesses = new Map();
const roleProcesses = new Map();
const plannerProcesses = new Map();
const processHeartbeats = new Map();
const eventStreams = new Set();
const streamReplay = [];
let streamEventId = 0;
let pendingAgentStarts = 0;
let githubLogin = null;
let advanceQueue = Promise.resolve();
const daemonLeaseOwner = crypto.randomUUID();
const processHeartbeatMs = Math.max(250, Number(process.env.AOD_PROCESS_HEARTBEAT_MS || 5000));
const processLeaseMs = Math.max(processHeartbeatMs * 2, Number(process.env.AOD_PROCESS_LEASE_MS || 15000));

mkdirSync(aodDir, { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    agent TEXT NOT NULL,
    files_json TEXT NOT NULL,
    depends_json TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    status TEXT NOT NULL,
    branch TEXT NOT NULL UNIQUE,
    worktree TEXT,
    base_commit TEXT,
    verified_commit TEXT,
    verification_json TEXT,
    output TEXT NOT NULL DEFAULT '',
    process_pid INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 1800000,
    locked INTEGER NOT NULL DEFAULT 0,
    recovery_note TEXT,
    last_exit_code INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    reviewer_agent TEXT NOT NULL,
    status TEXT NOT NULL,
    conflict_files_json TEXT NOT NULL,
    conflict_diff TEXT NOT NULL,
    suggestion TEXT NOT NULL DEFAULT '',
    patch TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    requirement TEXT NOT NULL,
    planner TEXT NOT NULL,
    dag_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    requirement TEXT NOT NULL,
    planner TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    integration_branch TEXT NOT NULL UNIQUE,
    integration_worktree TEXT,
    base_commit TEXT,
    github_repo TEXT,
    github_pr_number INTEGER,
    github_pr_url TEXT,
    ci_status TEXT NOT NULL DEFAULT 'not_published',
    ci_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS run_tasks (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (run_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    stream TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_processes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    run_id TEXT,
    task_id TEXT,
    session_id TEXT,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    pid INTEGER,
    lease_owner TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    last_output_at TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    timeout_ms INTEGER NOT NULL,
    exit_code INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1,
    command_hash TEXT,
    recovery_state TEXT,
    terminal_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_processes_status ON agent_processes(status, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_processes_run ON agent_processes(run_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_processes_task ON agent_processes(task_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_processes_agent ON agent_processes(agent, started_at DESC);
  CREATE TABLE IF NOT EXISTS agent_health_checks (
    agent TEXT PRIMARY KEY,
    configured INTEGER NOT NULL,
    status TEXT NOT NULL,
    command TEXT,
    resolved_path TEXT,
    version TEXT,
    auth_status TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    moderator_member_id TEXT,
    max_rounds INTEGER NOT NULL DEFAULT 3,
    max_repairs INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_group_members (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    agent TEXT NOT NULL,
    role TEXT NOT NULL,
    display_name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(group_id, key)
  );
  CREATE TABLE IF NOT EXISTS group_sessions (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES agent_groups(id),
    requirement TEXT NOT NULL,
    member_snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL,
    current_round INTEGER NOT NULL DEFAULT 0,
    max_rounds INTEGER NOT NULL,
    max_repairs INTEGER NOT NULL,
    consensus_json TEXT,
    run_id TEXT REFERENCES runs(id),
    pause_requested INTEGER NOT NULL DEFAULT 0,
    recovery_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS group_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_hash TEXT,
    output TEXT NOT NULL DEFAULT '',
    process_pid INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL,
    exit_code INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES group_turns(id) ON DELETE SET NULL,
    round INTEGER NOT NULL,
    sender_kind TEXT NOT NULL,
    sender_member_id TEXT,
    phase TEXT NOT NULL,
    content TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_role_assignments (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
    executor_member_id TEXT NOT NULL,
    reviewer_member_id TEXT NOT NULL,
    fixer_member_id TEXT,
    stage TEXT NOT NULL,
    repair_count INTEGER NOT NULL DEFAULT 0,
    max_repairs INTEGER NOT NULL DEFAULT 0,
    review_commit TEXT,
    review_json TEXT,
    updated_at TEXT NOT NULL
  );
`);
migrateAgentGroupMembers(db);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('tasks', 'run_id', 'TEXT REFERENCES runs(id)');
ensureColumn('events', 'run_id', 'TEXT REFERENCES runs(id)');

setDefault('run_mode', 'hybrid');
setDefault('max_concurrency', '3');
setDefault('integration_branch', 'main');
setDefault('worktree_retention_hours', '72');
setDefault('last_backup_at', '');

function setDefault(key, value) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(key, value);
}

function now() { return new Date().toISOString(); }
function json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function getSetting(key) { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value; }
function setSetting(key, value) { db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }
function currentMode() { return getSetting('run_mode') || 'hybrid'; }
function maxConcurrency() { return Math.max(1, Number(getSetting('max_concurrency') || 3)); }

function taskFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    files: json(row.files_json, []),
    dependsOn: json(row.depends_json, []),
    verification: json(row.verification_json, null),
    locked: Boolean(row.locked)
  };
}

function runFromRow(row) {
  if (!row) return null;
  return { ...row, ci: json(row.ci_json, null) };
}

function reviewFromRow(row) {
  if (!row) return null;
  return { ...row, conflictFiles: json(row.conflict_files_json, []) };
}

function listTasks() { return db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all().map(taskFromRow); }
function getTask(id) { return taskFromRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)); }
function listRuns() { return db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all().map(runFromRow); }
function getRun(id) { return runFromRow(db.prepare('SELECT * FROM runs WHERE id = ?').get(id)); }
function getReview(id) { return reviewFromRow(db.prepare('SELECT * FROM reviews WHERE id = ?').get(id)); }
function listReviews() { return db.prepare('SELECT * FROM reviews ORDER BY created_at DESC').all().map(reviewFromRow); }
function groupFromRow(row) {
  if (!row) return null;
  const members = db.prepare('SELECT * FROM agent_group_members WHERE group_id = ? ORDER BY position ASC').all(row.id)
    .map(member => ({ ...member, enabled: Boolean(member.enabled), is_moderator: member.id === row.moderator_member_id }));
  return { ...row, members };
}
function listGroups() { return db.prepare("SELECT * FROM agent_groups WHERE status != 'archived' ORDER BY created_at DESC").all().map(groupFromRow); }
function getGroup(id) { return groupFromRow(db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(id)); }
function groupSessionFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    members: json(row.member_snapshot_json, []),
    consensus: json(row.consensus_json, null),
    pause_requested: Boolean(row.pause_requested),
    turns: db.prepare('SELECT * FROM group_turns WHERE session_id = ? ORDER BY created_at ASC').all(row.id),
    assignments: db.prepare('SELECT * FROM task_role_assignments WHERE session_id = ? ORDER BY task_id ASC').all(row.id).map(item => ({ ...item, review: json(item.review_json, null) }))
  };
}
function getGroupSession(id) { return groupSessionFromRow(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(id)); }
function listGroupSessions() { return db.prepare('SELECT * FROM group_sessions ORDER BY created_at DESC').all().map(groupSessionFromRow); }
function getGroupTurn(id) { return db.prepare('SELECT * FROM group_turns WHERE id = ?').get(id) || null; }
function requireTask(id) { const task = getTask(id); if (!task) throw new Error(`Task ${id} was not found.`); return task; }
function requireRun(id) { const run = getRun(id); if (!run) throw new Error(`Run ${id} was not found.`); return run; }
function requireReview(id) { const review = getReview(id); if (!review) throw new Error(`Review ${id} was not found.`); return review; }
function requireGroup(id) { const group = getGroup(id); if (!group) throw new Error(`Group ${id} was not found.`); return group; }
function requireGroupSession(id) { const session = getGroupSession(id); if (!session) throw new Error(`Group session ${id} was not found.`); return session; }
function requireGroupTurn(id) { const turn = getGroupTurn(id); if (!turn) throw new Error(`Group turn ${id} was not found.`); return turn; }

function updateGroupSession(id, fields) {
  const current = requireGroupSession(id);
  const next = { ...current, ...fields, updated_at: now() };
  db.prepare(`UPDATE group_sessions SET status = ?, current_round = ?, consensus_json = ?, run_id = ?, pause_requested = ?, recovery_note = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
    .run(next.status, next.current_round, next.consensus ? JSON.stringify(next.consensus) : null, next.run_id || null, next.pause_requested ? 1 : 0, next.recovery_note || null, next.updated_at, next.finished_at || null, id);
  broadcast('group_session', { id, status: next.status, currentRound: next.current_round, at: next.updated_at });
  return requireGroupSession(id);
}

function getTaskRoleAssignment(taskId) {
  const row = db.prepare('SELECT * FROM task_role_assignments WHERE task_id = ?').get(taskId);
  return row ? { ...row, review: json(row.review_json, null) } : null;
}

function updateTaskRoleAssignment(taskId, fields) {
  const current = getTaskRoleAssignment(taskId);
  if (!current) throw new Error(`Task role assignment for ${taskId} was not found.`);
  const next = { ...current, ...fields };
  db.prepare('UPDATE task_role_assignments SET stage = ?, repair_count = ?, review_commit = ?, review_json = ?, updated_at = ? WHERE task_id = ?')
    .run(next.stage, next.repair_count, next.review_commit || null, next.review ? JSON.stringify(next.review) : null, now(), taskId);
  broadcast('task_role', { taskId, sessionId: next.session_id, stage: next.stage, repairCount: next.repair_count, at: now() });
  return getTaskRoleAssignment(taskId);
}

function appendGroupMessage(sessionId, { turnId = null, round = 0, senderKind, senderMemberId = null, phase, content }) {
  const message = redactSecrets(content).slice(-12000);
  const result = db.prepare('INSERT INTO group_messages(session_id, turn_id, round, sender_kind, sender_member_id, phase, content, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, turnId, round, senderKind, senderMemberId, phase, message, now());
  broadcast('group_message', { id: Number(result.lastInsertRowid), sessionId, turnId, round, senderKind, senderMemberId, phase, content: message, at: now() });
  return Number(result.lastInsertRowid);
}

function createGroupSession(group, payload) {
  if (typeof payload.requirement !== 'string' || !payload.requirement.trim()) throw new Error('A group session requires a natural-language requirement.');
  if (group.status !== 'active') throw new Error('Only active groups can create sessions.');
  const id = `GS-${String(Number(db.prepare('SELECT COUNT(*) AS count FROM group_sessions').get().count) + 1).padStart(3, '0')}`;
  const createdAt = now();
  const snapshot = group.members.filter(member => member.enabled).map(member => ({
    id: member.id, key: member.key, agent: member.agent, role: member.role, displayName: member.display_name,
    instructions: member.instructions, isModerator: member.is_moderator
  }));
  db.prepare(`INSERT INTO group_sessions(id, group_id, requirement, member_snapshot_json, status, current_round, max_rounds, max_repairs, pause_requested, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', 0, ?, ?, 0, ?, ?)`)
    .run(id, group.id, payload.requirement.trim(), JSON.stringify(snapshot), group.max_rounds, group.max_repairs, createdAt, createdAt);
  appendEvent('group_session', `${id} created for ${group.id}`);
  return requireGroupSession(id);
}

function createGroup(payload) {
  const draft = validateGroupDraft(payload, agents);
  const id = `G-${String(Number(db.prepare('SELECT COUNT(*) AS count FROM agent_groups').get().count) + 1).padStart(3, '0')}`;
  const createdAt = now();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO agent_groups(id, name, description, status, max_rounds, max_repairs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, draft.name, draft.description, 'active', draft.maxRounds, draft.maxRepairs, createdAt, createdAt);
    let moderatorId = null;
    draft.members.forEach((member, position) => {
      const memberId = `${id}-M${position + 1}`;
      db.prepare('INSERT INTO agent_group_members(id, group_id, key, agent, role, display_name, instructions, position, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(memberId, id, member.key, member.agent, member.role, member.displayName || member.key, member.instructions, position);
      if (member.key === draft.moderatorKey) moderatorId = memberId;
    });
    db.prepare('UPDATE agent_groups SET moderator_member_id = ? WHERE id = ?').run(moderatorId, id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  appendEvent('group', `${id} created`);
  return requireGroup(id);
}

function patchGroup(group, payload) {
  const members = group.members.map(member => ({ key: member.key, agent: member.agent, role: member.role, displayName: member.display_name, instructions: member.instructions }));
  const draft = validateGroupDraft({
    name: payload.name ?? group.name, description: payload.description ?? group.description,
    maxRounds: payload.maxRounds ?? group.max_rounds, maxRepairs: payload.maxRepairs ?? group.max_repairs,
    members: payload.members ?? members,
    moderatorKey: payload.moderatorKey ?? group.members.find(member => member.is_moderator)?.key
  }, agents);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE agent_groups SET name = ?, description = ?, max_rounds = ?, max_repairs = ?, moderator_member_id = NULL, updated_at = ? WHERE id = ?')
      .run(draft.name, draft.description, draft.maxRounds, draft.maxRepairs, now(), group.id);
    db.prepare('DELETE FROM agent_group_members WHERE group_id = ?').run(group.id);
    let moderatorId = null;
    draft.members.forEach((member, position) => {
      const memberId = `${group.id}-M${position + 1}`;
      db.prepare('INSERT INTO agent_group_members(id, group_id, key, agent, role, display_name, instructions, position, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(memberId, group.id, member.key, member.agent, member.role, member.displayName || member.key, member.instructions, position);
      if (member.key === draft.moderatorKey) moderatorId = memberId;
    });
    db.prepare('UPDATE agent_groups SET moderator_member_id = ? WHERE id = ?').run(moderatorId, group.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  appendEvent('group', `${group.id} updated`);
  return requireGroup(group.id);
}

function archiveGroup(group) {
  if (group.status === 'archived') return group;
  db.prepare("UPDATE agent_groups SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), group.id);
  appendEvent('group', `${group.id} archived`);
  return requireGroup(group.id);
}

function saveTask(task) {
  task.updated_at = now();
  db.prepare(`UPDATE tasks SET
    title = ?, agent = ?, files_json = ?, depends_json = ?, acceptance = ?, status = ?, branch = ?, worktree = ?, run_id = ?,
    base_commit = ?, verified_commit = ?, verification_json = ?, output = ?, process_pid = ?, attempts = ?,
    max_retries = ?, timeout_ms = ?, locked = ?, recovery_note = ?, last_exit_code = ?, updated_at = ?, started_at = ?, finished_at = ?
    WHERE id = ?`).run(
    task.title, task.agent, JSON.stringify(task.files), JSON.stringify(task.dependsOn), task.acceptance, task.status, task.branch,
    task.worktree, task.run_id || null, task.base_commit, task.verified_commit, task.verification ? JSON.stringify(task.verification) : null,
    task.output || '', task.process_pid, task.attempts, task.max_retries, task.timeout_ms, task.locked ? 1 : 0,
    task.recovery_note, task.last_exit_code, task.updated_at, task.started_at, task.finished_at, task.id
  );
  return task;
}

function updateTask(id, fields) { return saveTask({ ...requireTask(id), ...fields }); }

function saveRun(run) {
  run.updated_at = now();
  db.prepare(`UPDATE runs SET title = ?, requirement = ?, planner = ?, mode = ?, status = ?, base_branch = ?, integration_branch = ?, integration_worktree = ?, base_commit = ?, github_repo = ?, github_pr_number = ?, github_pr_url = ?, ci_status = ?, ci_json = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
    .run(run.title, run.requirement, run.planner, run.mode, run.status, run.base_branch, run.integration_branch, run.integration_worktree, run.base_commit, run.github_repo, run.github_pr_number, run.github_pr_url, run.ci_status, run.ci ? JSON.stringify(run.ci) : null, run.updated_at, run.finished_at, run.id);
  return run;
}

function updateRun(id, fields) { return saveRun({ ...requireRun(id), ...fields }); }
function runTasks(runId) { return listTasks().filter(task => task.run_id === runId); }

function broadcast(type, payload) {
  const eventId = ++streamEventId;
  const data = `id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  streamReplay.push({ id: eventId, data });
  if (streamReplay.length > 500) streamReplay.shift();
  for (const response of eventStreams) {
    try { response.write(data); } catch { eventStreams.delete(response); }
  }
}

function appendEvent(type, message, taskId = null, runId = null) {
  const derivedRunId = runId || (taskId ? getTask(taskId)?.run_id : null) || null;
  db.prepare('INSERT INTO events(id, at, type, message, task_id, run_id) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), now(), type, message, taskId, derivedRunId);
  broadcast('event', { type, message, taskId, runId: derivedRunId, at: now() });
}

function redactSecrets(value) {
  return String(value).replace(/(ghp_|github_pat_|sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|Bearer\s+)[A-Za-z0-9_\-./=]+/g, '$1[REDACTED]');
}

function processFromRow(row) {
  if (!row) return null;
  const { metadata_json: metadataJson, ...fields } = row;
  return {
    ...fields,
    terminal_reason: row.terminal_reason ? redactSecrets(row.terminal_reason) : null,
    metadata: json(redactSecrets(metadataJson || '{}'), {})
  };
}

function listAgentProcesses({ limit = 100, runId = null } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = runId
    ? db.prepare('SELECT * FROM agent_processes WHERE run_id = ? ORDER BY started_at DESC LIMIT ?').all(runId, boundedLimit)
    : db.prepare('SELECT * FROM agent_processes ORDER BY started_at DESC LIMIT ?').all(boundedLimit);
  return rows.map(processFromRow);
}

function leaseExpiry(at = Date.now()) { return new Date(at + processLeaseMs).toISOString(); }

function startAgentProcessRecord({ kind, entityId, runId = null, taskId = null, sessionId = null, agent, child, command, args = [], timeoutMs, attempt = 1, metadata = {} }) {
  const id = `AP-${crypto.randomUUID()}`;
  const startedAt = now();
  const commandHash = createHash('sha256').update(JSON.stringify([command, args])).digest('hex');
  db.prepare(`INSERT INTO agent_processes(
    id, kind, entity_id, run_id, task_id, session_id, agent, status, pid, lease_owner, lease_expires_at,
    heartbeat_at, started_at, timeout_ms, attempt, command_hash, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, kind, entityId, runId, taskId, sessionId, agent, child.pid || null, daemonLeaseOwner, leaseExpiry(),
    startedAt, startedAt, timeoutMs, Math.max(1, Number(attempt) || 1), commandHash, JSON.stringify(metadata || {})
  );
  const heartbeat = setInterval(() => {
    const heartbeatAt = now();
    try {
      db.prepare("UPDATE agent_processes SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ? AND status = 'running'")
        .run(heartbeatAt, leaseExpiry(), id);
      broadcast('process', { id, status: 'running', heartbeatAt });
    } catch {}
  }, processHeartbeatMs);
  heartbeat.unref?.();
  processHeartbeats.set(id, heartbeat);
  broadcast('process', { id, kind, entityId, taskId, sessionId, runId, agent, status: 'running', pid: child.pid || null, at: startedAt });
  return id;
}

function touchAgentProcessOutput(id) {
  if (!id) return;
  const outputAt = now();
  db.prepare("UPDATE agent_processes SET heartbeat_at = ?, last_output_at = ?, lease_expires_at = ? WHERE id = ? AND status = 'running'")
    .run(outputAt, outputAt, leaseExpiry(), id);
  broadcast('process', { id, status: 'running', lastOutputAt: outputAt });
}

function finishAgentProcessRecord(id, { status, exitCode = null, reason = null, inputTokens = null, outputTokens = null, costUsd = null } = {}) {
  if (!id) return null;
  const heartbeat = processHeartbeats.get(id);
  if (heartbeat) clearInterval(heartbeat);
  processHeartbeats.delete(id);
  const finishedAt = now();
  db.prepare(`UPDATE agent_processes SET status = ?, heartbeat_at = ?, lease_expires_at = ?,
    finished_at = ?, exit_code = ?, terminal_reason = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?
    WHERE id = ? AND status = 'running'`).run(
    status, finishedAt, finishedAt, finishedAt, exitCode, reason ? redactSecrets(reason) : null,
    inputTokens !== null && inputTokens !== undefined && Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : null,
    outputTokens !== null && outputTokens !== undefined && Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : null,
    costUsd !== null && costUsd !== undefined && Number.isFinite(Number(costUsd)) ? Number(costUsd) : null,
    id
  );
  broadcast('process', { id, status, exitCode, at: finishedAt });
  return processFromRow(db.prepare('SELECT * FROM agent_processes WHERE id = ?').get(id));
}

function appendOutput(taskId, chunk, stream = 'stdout') {
  const task = requireTask(taskId);
  const message = redactSecrets(chunk);
  updateTask(taskId, { output: `${task.output || ''}${message}`.slice(-16000) });
  db.prepare('INSERT INTO task_logs(task_id, at, stream, message) VALUES (?, ?, ?, ?)').run(taskId, now(), stream, message);
  broadcast('log', { taskId, stream, message, at: now() });
}

function importLegacyState() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  if (count || !existsSync(legacyStatePath)) return;
  const legacy = json(readFileSync(legacyStatePath, 'utf8'), null);
  if (!legacy?.tasks?.length) return;
  for (const oldTask of legacy.tasks) {
    const createdAt = oldTask.createdAt || now();
    db.prepare(`INSERT OR IGNORE INTO tasks (
      id, title, agent, files_json, depends_json, acceptance, status, branch, worktree, output,
      max_retries, timeout_ms, locked, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(oldTask.id, oldTask.title, oldTask.agent, JSON.stringify(oldTask.files || []), JSON.stringify(oldTask.dependsOn || []),
        oldTask.acceptance || '', oldTask.status || 'draft', oldTask.branch, oldTask.worktree, oldTask.output || '',
        0, 1800000, 0, createdAt, oldTask.updatedAt || createdAt);
  }
  for (const event of legacy.events || []) appendEvent(event.type || 'legacy', event.message || 'Imported legacy event', event.taskId || null);
}

function observePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false };
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (error) {
    if (error?.code === 'ESRCH') return { alive: false };
    return { alive: null };
  }
}

function processRecoveryNote(processRecord) {
  if (!processRecord) return 'Daemon restarted while work was in progress.';
  if (processRecord.recovery_state === 'live') return `Daemon restarted; PID ${processRecord.pid} still appears live with a valid lease. Confirm its outcome before retrying.`;
  if (processRecord.recovery_state === 'stale') return `Daemon restarted; the ${processRecord.kind} process lease is stale and its PID is no longer running.`;
  return `Daemon restarted; PID ${processRecord.pid || 'unknown'} cannot be verified because its lease expired or process access was unavailable.`;
}

function recoverInterruptedAgentProcesses() {
  const interrupted = db.prepare("SELECT * FROM agent_processes WHERE status = 'running' ORDER BY started_at ASC").all();
  for (const row of interrupted) {
    const recoveryState = classifyInterruptedProcess(row, observePid(row.pid), now());
    const recoveredAt = now();
    const note = processRecoveryNote({ ...row, recovery_state: recoveryState });
    db.prepare(`UPDATE agent_processes SET status = 'recovery_required', recovery_state = ?, finished_at = ?, terminal_reason = ? WHERE id = ? AND status = 'running'`)
      .run(recoveryState, recoveredAt, note, row.id);
    appendEvent('process_recovery', `${row.id} classified as ${recoveryState} after daemon restart`, row.task_id || null, row.run_id || null);
  }
}

function latestRecoveredProcess({ taskId = null, sessionId = null, entityId = null } = {}) {
  if (taskId) return processFromRow(db.prepare("SELECT * FROM agent_processes WHERE task_id = ? AND status = 'recovery_required' ORDER BY started_at DESC LIMIT 1").get(taskId));
  if (sessionId) return processFromRow(db.prepare("SELECT * FROM agent_processes WHERE session_id = ? AND status = 'recovery_required' ORDER BY started_at DESC LIMIT 1").get(sessionId));
  if (entityId) return processFromRow(db.prepare("SELECT * FROM agent_processes WHERE entity_id = ? AND status = 'recovery_required' ORDER BY started_at DESC LIMIT 1").get(entityId));
  return null;
}

function recoverInterruptedTasks() {
  const interrupted = db.prepare("SELECT id FROM tasks WHERE status IN ('preparing', 'running', 'verifying', 'reviewing', 'repairing', 'merging')").all();
  for (const row of interrupted) {
    const task = requireTask(row.id);
    const recoveryNote = processRecoveryNote(latestRecoveredProcess({ taskId: task.id }));
    updateTask(task.id, { status: 'recovery_required', process_pid: null, recovery_note: recoveryNote });
    const assignment = getTaskRoleAssignment(task.id);
    if (assignment) {
      updateTaskRoleAssignment(task.id, { stage: 'recovery_required' });
      updateGroupSession(assignment.session_id, { status: 'recovery_required', recovery_note: recoveryNote });
    }
    appendEvent('recovery', `${task.id} requires operator confirmation after daemon restart`, task.id);
  }
  const interruptedReviews = db.prepare("SELECT id, task_id FROM reviews WHERE status = 'running'").all();
  for (const review of interruptedReviews) {
    db.prepare('UPDATE reviews SET status = ?, updated_at = ? WHERE id = ?').run('pending', now(), review.id);
    const recoveredProcess = latestRecoveredProcess({ entityId: review.id });
    appendEvent('recovery', `${review.id} reviewer process was ${recoveredProcess?.recovery_state || 'interrupted'} and requires confirmation`, review.task_id);
  }
  const interruptedSessions = db.prepare("SELECT id FROM group_sessions WHERE status IN ('discussing', 'synthesizing')").all();
  for (const session of interruptedSessions) {
    const recoveryNote = processRecoveryNote(latestRecoveredProcess({ sessionId: session.id }));
    db.prepare("UPDATE group_sessions SET status = 'recovery_required', recovery_note = ?, updated_at = ? WHERE id = ?")
      .run(recoveryNote, now(), session.id);
    db.prepare("UPDATE group_turns SET status = 'recovery_required', process_pid = NULL, finished_at = ? WHERE session_id = ? AND status = 'running'")
      .run(now(), session.id);
    appendEvent('recovery', `${session.id} requires operator confirmation after daemon restart`);
  }
}

importLegacyState();
recoverInterruptedAgentProcesses();
recoverInterruptedTasks();

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 36) || 'task'; }
function cleanPaths(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('At least one owned file or directory is required.');
  return files.map(value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Owned paths must be non-empty strings.');
    const path = normalize(value.trim().replaceAll('\\', '/'));
    if (path.startsWith('..') || path.startsWith('/') || path.includes(':')) throw new Error(`Unsafe owned path: ${value}`);
    return path;
  });
}
function pathsOverlap(left, right) {
  const a = left.replaceAll('\\', '/').replace(/\/$/, '').toLocaleLowerCase('en-US');
  const b = right.replaceAll('\\', '/').replace(/\/$/, '').toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function assertOwnershipAvailable(tasks, files) {
  for (const task of tasks.filter(item => !['merged', 'cancelled', 'failed'].includes(item.status))) {
    for (const owned of task.files) for (const requested of files) {
      if (pathsOverlap(owned, requested)) throw new Error(`Ownership conflict: ${requested} overlaps with ${task.id} (${owned}).`);
    }
  }
}
function validateGraph(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visited = new Set();
  const active = new Set();
  const visit = id => {
    if (active.has(id)) throw new Error('Task dependencies contain a cycle.');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown dependency ${id}.`);
    active.add(id);
    task.dependsOn.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  tasks.forEach(task => visit(task.id));
}
function dependenciesComplete(task) { return task.dependsOn.every(id => getTask(id)?.status === 'merged'); }

function run(command, args, cwd = root, timeoutMs = 120000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); rejectRun(new Error(`${command} timed out after ${timeoutMs}ms.`)); }, timeoutMs);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); rejectRun(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(stderr.trim() || stdout.trim() || `${command} exited with ${code}`)); });
  });
}
function runShell(command, cwd, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); rejectRun(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return rejectRun(new Error(`Acceptance command timed out after ${timeoutMs}ms.`));
      return code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(stderr.trim() || stdout.trim() || `Verification exited with ${code}`));
    });
  });
}
async function git(args, cwd = root, timeoutMs) { return run('git', args, cwd, timeoutMs); }
async function gitReady() { try { await git(['rev-parse', '--is-inside-work-tree']); await git(['rev-parse', '--verify', 'HEAD']); return true; } catch { return false; } }
async function gitClean(cwd = root) { return (await git(['status', '--porcelain'], cwd)).stdout.trim() === ''; }

async function loadConfig() {
  if (!(await exists(configPath))) return { agents: {}, defaults: {} };
  const config = json(await readFile(configPath, 'utf8'), null);
  if (!config) throw new Error('The AOD adapter config is not valid JSON.');
  return { agents: {}, defaults: {}, ...config };
}

function configuredAgentCommands() {
  if (!existsSync(configPath)) return new Map();
  const config = json(readFileSync(configPath, 'utf8'), {});
  return new Map(Object.entries(config?.agents || {}).map(([agent, adapter]) => [agent, typeof adapter?.command === 'string' ? adapter.command : null]));
}

function listAgentHealth() {
  const configured = configuredAgentCommands();
  const saved = new Map(db.prepare('SELECT * FROM agent_health_checks').all().map(row => [row.agent, row]));
  return agents.map(agent => {
    const row = saved.get(agent);
    const currentCommand = configured.get(agent);
    const isConfigured = typeof currentCommand === 'string';
    if (row && isConfigured && row.command === currentCommand) return { ...row, configured: true };
    return {
      agent,
      configured: isConfigured,
      status: isConfigured ? 'not_checked' : 'unconfigured',
      command: currentCommand || null,
      resolved_path: null,
      version: null,
      auth_status: 'not_checked',
      latency_ms: 0,
      message: isConfigured ? 'Run a connection check.' : 'Adapter is not configured.',
      checked_at: null
    };
  });
}

function saveAgentHealth(result) {
  db.prepare(`INSERT INTO agent_health_checks(agent, configured, status, command, resolved_path, version, auth_status, latency_ms, message, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent) DO UPDATE SET configured = excluded.configured, status = excluded.status, command = excluded.command,
      resolved_path = excluded.resolved_path, version = excluded.version, auth_status = excluded.auth_status,
      latency_ms = excluded.latency_ms, message = excluded.message, checked_at = excluded.checked_at`)
    .run(result.agent, result.configured ? 1 : 0, result.status, result.command, result.resolved_path, result.version,
      result.auth_status, result.latency_ms, result.message, result.checked_at);
  const saved = { ...db.prepare('SELECT * FROM agent_health_checks WHERE agent = ?').get(result.agent), configured: Boolean(result.configured) };
  broadcast('agent_health', saved);
  appendEvent('agent_health', `${result.agent}: ${result.status}${result.message ? ` / ${result.message}` : ''}`);
  return saved;
}

async function resolveAgentCommand(command, timeoutMs) {
  if (existsSync(command)) return resolve(command);
  const lookup = process.platform === 'win32'
    ? await run('where.exe', [command], root, timeoutMs)
    : await run('which', [command], root, timeoutMs);
  const path = `${lookup.stdout}\n${lookup.stderr}`.split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!path) throw new Error(`Executable was not found: ${command}`);
  return path;
}

async function checkAgentHealth(agent) {
  if (!agents.includes(agent)) throw new Error('Choose a supported agent adapter.');
  const startedAt = Date.now();
  const checkedAt = now();
  const config = await loadConfig();
  const adapter = config.agents?.[agent];
  const base = {
    agent,
    configured: Boolean(adapter),
    status: 'unconfigured',
    command: typeof adapter?.command === 'string' ? adapter.command : null,
    resolved_path: null,
    version: null,
    auth_status: 'not_checked',
    latency_ms: 0,
    message: 'Adapter is not configured.',
    checked_at: checkedAt
  };
  if (!adapter || typeof adapter.command !== 'string') {
    base.latency_ms = Date.now() - startedAt;
    return saveAgentHealth(base);
  }

  const health = adapter.health && typeof adapter.health === 'object' ? adapter.health : {};
  const timeoutMs = Math.max(1000, Math.min(60000, Number(health.timeoutMs || 10000)));
  try {
    base.resolved_path = await resolveAgentCommand(adapter.command, timeoutMs);
    const versionArgs = health.versionArgs === undefined ? ['--version'] : health.versionArgs;
    if (!Array.isArray(versionArgs)) throw new Error('health.versionArgs must be an array.');
    const versionResult = await run(adapter.command, versionArgs.map(String), root, timeoutMs);
    base.version = redactSecrets(`${versionResult.stdout}\n${versionResult.stderr}`).trim().split(/\r?\n/).find(Boolean)?.slice(0, 500) || 'available';
    base.status = 'warning';
    base.auth_status = 'unknown';
    base.message = 'Executable is ready; authentication probe is not configured.';

    if (health.authArgs !== undefined) {
      if (!Array.isArray(health.authArgs)) throw new Error('health.authArgs must be an array.');
      try {
        await run(adapter.command, health.authArgs.map(String), root, timeoutMs);
        base.status = 'ready';
        base.auth_status = 'ready';
        base.message = 'Executable and authentication probes passed.';
      } catch (error) {
        base.status = 'error';
        base.auth_status = 'failed';
        base.message = redactSecrets(error instanceof Error ? error.message : 'Authentication probe failed.').slice(-2000);
      }
    }
  } catch (error) {
    base.status = 'error';
    base.auth_status = base.auth_status === 'failed' ? 'failed' : 'not_checked';
    base.message = redactSecrets(error instanceof Error ? error.message : 'Agent connection check failed.').slice(-2000);
  }
  base.latency_ms = Date.now() - startedAt;
  return saveAgentHealth(base);
}

function expand(value, task, prompt, promptFile = join(handoffDir, `${task.id}.md`)) {
  return String(value).replaceAll('{{taskId}}', task.id).replaceAll('{{worktree}}', task.worktree || '').replaceAll('{{promptFile}}', promptFile).replaceAll('{{prompt}}', prompt);
}
async function writeHandoff(task) {
  await mkdir(handoffDir, { recursive: true });
  const handoff = [
    `# ${task.id}: ${task.title}`, '', `Agent: ${task.agent}`, `Branch: ${task.branch}`, `Worktree: ${task.worktree}`, '',
    '## Owned paths', ...task.files.map(file => `- ${file}`), '', '## Dependencies', task.dependsOn.length ? task.dependsOn.map(id => `- ${id}`).join('\n') : '- None', '',
    '## Acceptance command', task.acceptance || 'Not specified', '',
    'Commit changes in this branch. Do not modify paths outside the ownership list. Report changed files, commit SHA, test output, and residual risks.'
  ].join('\n');
  await writeFile(join(handoffDir, `${task.id}.md`), `${handoff}\n`, 'utf8');
}

function recentGroupContext(sessionId) {
  const messages = db.prepare('SELECT round, sender_kind, sender_member_id, phase, content FROM group_messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
  const text = messages.map(message => `[round ${message.round} / ${message.phase} / ${message.sender_member_id || message.sender_kind}]\n${message.content}`).join('\n\n');
  return text.slice(-48000);
}

function groupTurnPrompt(session, member, round, phase) {
  const objectives = {
    proposal: 'Propose a concrete implementation approach, responsibilities, risks, and acceptance criteria.',
    critique: 'Read the proposals, challenge assumptions, identify conflicts, and recommend corrections.',
    convergence: 'Resolve disagreements and state the task split, dependencies, ownership, and verification strategy.',
    synthesis: 'Synthesize the discussion into the required JSON object. Return JSON only, without markdown.'
  };
  const roster = session.members.map(item => `- ${item.id}: ${item.displayName} (${item.agent}, ${item.role})${item.isModerator ? ' [moderator]' : ''}`).join('\n');
  const schema = phase === 'synthesis' ? [
    'Required JSON shape:',
    '{"title":"...","summary":"...","decisions":["..."],"disagreements":[],"risks":["..."],"maxRepairs":2,"tasks":[{"key":"...","title":"...","description":"...","files":["path"],"dependsOn":[],"acceptance":"npm test","risk":"...","executorMemberId":"...","reviewerMemberId":"...","fixerMemberId":"..."}]}',
    'Use exact member IDs from the roster. Tasks must be acyclic and own disjoint files.'
  ].join('\n') : '';
  return [
    `Group session: ${session.id}`, `Requirement: ${session.requirement}`, `Round: ${round}/${session.max_rounds}`, `Phase: ${phase}`,
    `You are ${member.displayName}, role ${member.role}.`, member.instructions ? `Responsibilities: ${member.instructions}` : '',
    'Roster:', roster, '', objectives[phase], schema, '', 'Discussion so far:', recentGroupContext(session.id) || '(none)'
  ].filter(Boolean).join('\n');
}

async function validateSessionConsensus(session, draft) {
  const config = await loadConfig();
  const allowed = config.security?.allowedAcceptancePrefixes || ['npm ', 'node ', 'pnpm ', 'yarn ', 'git ', 'python ', 'py '];
  const validated = validateConsensusDraft({ ...draft, maxRepairs: session.max_repairs }, { members: session.members, maxRepairs: session.max_repairs }, allowed);
  const sourceByKey = new Map(draft.tasks.map(task => [task.key, task]));
  validated.tasks = validated.tasks.map(task => ({
    ...sourceByKey.get(task.key), ...task,
    description: String(sourceByKey.get(task.key)?.description || ''), risk: String(sourceByKey.get(task.key)?.risk || '')
  }));
  return validated;
}

async function acquireAgentSlot(checkCancelled) {
  while (true) {
    checkCancelled?.();
    if (currentProcessCount() + pendingAgentStarts < maxConcurrency()) {
      pendingAgentStarts += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pendingAgentStarts -= 1;
      };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

async function runGroupTurn(session, member, round, phase) {
  const checkCancelled = () => {
    if (requireGroupSession(session.id).status === 'cancelled') throw new Error('Group session was cancelled.');
  };
  let releaseAgentSlot = await acquireAgentSlot(checkCancelled);
  try {
    const config = await loadConfig();
    const adapter = config.agents[member.agent];
    if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new Error(`No ${member.agent} adapter is configured.`);
    const id = `GT-${crypto.randomUUID().slice(0, 8)}`;
    const directory = join(dirname(root), `${basename(root)}.aod-group-sessions`, session.id, id);
    await mkdir(directory, { recursive: true });
    const prompt = groupTurnPrompt(session, member, round, phase);
    const promptFile = join(directory, 'prompt.md');
    await writeFile(promptFile, `${prompt}\n`, 'utf8');
    const timeoutMs = Math.max(1000, Number(adapter.groupTimeoutMs || config.defaults?.groupTurnTimeoutMs || adapter.timeoutMs || 600000));
    const maxRetries = Math.max(0, Number(adapter.maxRetries ?? config.defaults?.maxRetries ?? 0));
    db.prepare(`INSERT INTO group_turns(id, session_id, member_id, round, phase, status, prompt_hash, timeout_ms, max_retries, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(id, session.id, member.id, round, phase, createHash('sha256').update(prompt).digest('hex'), timeoutMs, maxRetries, now());
    broadcast('group_turn', { id, sessionId: session.id, memberId: member.id, round, phase, status: 'queued' });

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      if (!releaseAgentSlot) releaseAgentSlot = await acquireAgentSlot(checkCancelled);
      checkCancelled();
      const pseudoTask = { id, worktree: directory };
      const args = adapter.args.map(value => expand(value, pseudoTask, prompt, promptFile));
      const outcome = await new Promise(resolveTurn => {
        const child = spawn(adapter.command, args, {
          cwd: directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, AOD_GROUP_SESSION_ID: session.id, AOD_GROUP_MEMBER_ID: member.id, AOD_GROUP_PHASE: phase, AOD_GROUP_ROSTER: JSON.stringify(session.members) }
        });
        let output = '';
        let settled = false;
        let timedOut = false;
        const processId = startAgentProcessRecord({
          kind: 'group_turn', entityId: id, runId: session.run_id, sessionId: session.id, agent: member.agent,
          child, command: adapter.command, args, timeoutMs, attempt,
          metadata: { memberId: member.id, round, phase }
        });
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          groupProcesses.delete(id);
          const cancelled = getGroupSession(session.id)?.status === 'cancelled';
          finishAgentProcessRecord(processId, {
            status: cancelled ? 'cancelled' : result.ok ? 'succeeded' : timedOut ? 'timed_out' : 'failed',
            exitCode: result.code,
            reason: result.ok ? null : result.error?.message || `Group turn exited with ${result.code}.`
          });
          resolveTurn({ ...result, output });
        };
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        groupProcesses.set(id, { child, timer, sessionId: session.id, processId });
        releaseAgentSlot();
        releaseAgentSlot = null;
        db.prepare("UPDATE group_turns SET status = 'running', process_pid = ?, attempts = ?, started_at = ? WHERE id = ?").run(child.pid || null, attempt, now(), id);
        broadcast('group_turn', { id, sessionId: session.id, memberId: member.id, round, phase, status: 'running', attempt });
        child.stdin.end(adapter.stdin === undefined ? undefined : expand(adapter.stdin, pseudoTask, prompt, promptFile));
        child.stdout.on('data', data => { output = `${output}${data}`.slice(-12000); touchAgentProcessOutput(processId); });
        child.stderr.on('data', data => { output = `${output}${data}`.slice(-12000); touchAgentProcessOutput(processId); });
        child.once('error', error => finish({ ok: false, error, code: null }));
        child.once('close', code => finish({ ok: !timedOut && code === 0, code, error: timedOut ? new Error(`Group turn timed out after ${timeoutMs}ms.`) : null }));
      });
      if (outcome.ok) {
        const output = redactSecrets(outcome.output).slice(-12000).trim();
        db.prepare("UPDATE group_turns SET status = 'completed', output = ?, process_pid = NULL, exit_code = ?, finished_at = ? WHERE id = ?")
          .run(output, outcome.code, now(), id);
        appendGroupMessage(session.id, { turnId: id, round, senderKind: 'member', senderMemberId: member.id, phase, content: output });
        broadcast('group_turn', { id, sessionId: session.id, memberId: member.id, round, phase, status: 'completed' });
        return output;
      }
      lastError = outcome.error || new Error(`Group turn exited with ${outcome.code}.`);
    }
    db.prepare("UPDATE group_turns SET status = 'recovery_required', output = ?, process_pid = NULL, finished_at = ? WHERE id = ?")
      .run(redactSecrets(lastError?.message || 'Group turn failed.'), now(), id);
    broadcast('group_turn', { id, sessionId: session.id, memberId: member.id, round, phase, status: 'recovery_required' });
    throw lastError || new Error('Group turn failed.');
  } finally {
    releaseAgentSlot?.();
  }
}

async function runGroupDiscussion(sessionId) {
  let session = requireGroupSession(sessionId);
  try {
    const phases = ['proposal', 'critique', 'convergence'];
    for (let round = session.current_round + 1; round <= session.max_rounds; round += 1) {
      session = requireGroupSession(sessionId);
      await Promise.all(session.members.map(member => runGroupTurn(session, member, round, phases[Math.min(round - 1, phases.length - 1)])));
      session = updateGroupSession(sessionId, { current_round: round });
      if (session.pause_requested) {
        updateGroupSession(sessionId, { status: 'paused', pause_requested: false });
        return;
      }
    }
    session = updateGroupSession(sessionId, { status: 'synthesizing' });
    const moderator = session.members.find(member => member.isModerator);
    if (!moderator) throw new Error('The session snapshot has no moderator.');
    const output = await runGroupTurn(session, moderator, session.max_rounds, 'synthesis');
    const draft = extractJson(output);
    if (!draft) throw new Error('Moderator did not return a valid consensus DAG.');
    const consensus = await validateSessionConsensus(session, draft);
    session = requireGroupSession(sessionId);
    if (session.pause_requested) {
      updateGroupSession(sessionId, { status: 'paused', consensus, pause_requested: false, finished_at: now(), recovery_note: null });
    } else {
      updateGroupSession(sessionId, { status: 'awaiting_confirmation', consensus, finished_at: now(), recovery_note: null });
    }
  } catch (error) {
    if (getGroupSession(sessionId)?.status !== 'cancelled') updateGroupSession(sessionId, { status: 'recovery_required', recovery_note: error instanceof Error ? error.message : 'Group discussion failed.' });
  }
}

function startGroupDiscussion(session) {
  if (session.status === 'paused' && session.current_round === session.max_rounds && session.consensus) {
    return updateGroupSession(session.id, { status: 'awaiting_confirmation', pause_requested: false, recovery_note: null });
  }
  if (!['draft', 'paused', 'recovery_required'].includes(session.status)) throw new Error('This group session cannot start or resume from its current status.');
  const next = updateGroupSession(session.id, { status: 'discussing', pause_requested: false, recovery_note: null });
  runGroupDiscussion(session.id).catch(() => {});
  return next;
}

function resumeGroupSession(session) {
  if (!session.run_id) {
    if (!['paused', 'recovery_required'].includes(session.status)) throw new Error('Only a paused or interrupted group discussion can be resumed.');
    return startGroupDiscussion(session);
  }
  if (session.status !== 'recovery_required') throw new Error('Only an interrupted group execution can be resumed.');

  for (const assignment of session.assignments.filter(item => item.stage === 'recovery_required')) {
    const task = requireTask(assignment.task_id);
    if (assignment.review?.decision === 'changes_requested' && assignment.repair_count < assignment.max_repairs) {
      updateTaskRoleAssignment(task.id, { stage: 'repairing' });
      updateTask(task.id, { status: 'repairing', recovery_note: assignment.review.summary || task.recovery_note });
    } else if (task.verified_commit && task.verified_commit === assignment.review_commit) {
      updateTaskRoleAssignment(task.id, { stage: 'reviewing' });
      updateTask(task.id, { status: 'reviewing', recovery_note: null });
    } else {
      updateTaskRoleAssignment(task.id, { stage: 'pending' });
      updateTask(task.id, { status: task.worktree ? 'ready' : 'draft', process_pid: null, recovery_note: null });
    }
  }

  const resumed = updateGroupSession(session.id, { status: 'executing', pause_requested: false, recovery_note: null });
  scheduleGroupAdvance();
  return resumed;
}

function cancelGroupSession(session) {
  if (['completed', 'cancelled', 'failed'].includes(session.status)) {
    throw new Error(`A ${session.status} group session cannot be cancelled.`);
  }
  const assignments = db.prepare('SELECT * FROM task_role_assignments WHERE session_id = ?').all(session.id);
  const taskIds = new Set(assignments.map(assignment => assignment.task_id));
  const finishedAt = now();
  const stop = entry => {
    clearTimeout(entry.timer);
    try { entry.child.kill(); } catch {}
  };

  updateGroupSession(session.id, { status: 'cancelled', pause_requested: false, recovery_note: null, finished_at: finishedAt });
  for (const assignment of assignments) {
    const task = getTask(assignment.task_id);
    if (task && !['merged', 'cancelled', 'failed'].includes(task.status)) {
      updateTask(task.id, { status: 'cancelled', process_pid: null, finished_at: finishedAt, recovery_note: null });
    }
    updateTaskRoleAssignment(assignment.task_id, { stage: 'failed' });
  }
  for (const entry of groupProcesses.values()) if (entry.sessionId === session.id) stop(entry);
  for (const entry of roleProcesses.values()) if (entry.sessionId === session.id) stop(entry);
  for (const taskId of taskIds) {
    const entry = taskProcesses.get(taskId);
    if (entry) stop(entry);
  }
  appendEvent('group_session', `${session.id} cancelled`);
  return requireGroupSession(session.id);
}

async function recoverGroupTurn(turn, payload) {
  if (!['retry', 'skip', 'replace'].includes(payload.action)) throw new Error('Recovery action must be retry, skip, or replace.');
  const session = requireGroupSession(turn.session_id);
  if (session.status !== 'recovery_required' || turn.status !== 'recovery_required') throw new Error('Only an interrupted group turn can be recovered.');
  if ([...groupProcesses.values()].some(entry => entry.sessionId === session.id)) throw new Error('Wait for active group turns to stop before recovering this session.');
  let member = session.members.find(item => item.id === turn.member_id);
  if (payload.action === 'replace') {
    member = session.members.find(item => item.id === payload.replacementMemberId);
    if (!member) throw new Error('replacementMemberId must identify a session member.');
  }
  if (payload.action === 'skip' && turn.phase === 'synthesis') throw new Error('The moderator synthesis turn cannot be skipped.');

  db.prepare("UPDATE group_turns SET status = ?, finished_at = ? WHERE id = ?").run(payload.action === 'skip' ? 'skipped' : 'superseded', now(), turn.id);
  if (payload.action === 'skip') {
    appendGroupMessage(session.id, { round: turn.round, senderKind: 'system', phase: 'recovery', content: `${member?.displayName || turn.member_id} was skipped by the operator.` });
  } else {
    const output = await runGroupTurn(session, member, turn.round, turn.phase);
    if (turn.phase === 'synthesis') {
      const draft = extractJson(output);
      if (!draft) throw new Error('Recovered moderator turn did not return a valid consensus DAG.');
      const consensus = await validateSessionConsensus(session, draft);
      return updateGroupSession(session.id, { status: 'awaiting_confirmation', consensus, recovery_note: null, finished_at: now() });
    }
  }

  const completed = new Set(db.prepare("SELECT member_id FROM group_turns WHERE session_id = ? AND round = ? AND phase = ? AND status IN ('completed', 'skipped')")
    .all(session.id, turn.round, turn.phase).map(item => item.member_id));
  if (payload.action === 'replace') completed.add(turn.member_id);
  if (session.members.every(item => completed.has(item.id))) {
    updateGroupSession(session.id, { status: 'discussing', current_round: Math.max(session.current_round, turn.round), recovery_note: null });
    runGroupDiscussion(session.id).catch(() => {});
  } else {
    updateGroupSession(session.id, { status: 'recovery_required', recovery_note: 'Additional member turns in this round still require recovery.' });
  }
  return requireGroupSession(session.id);
}

async function prepareTask(task, source = 'manual') {
  if (task.status !== 'draft') throw new Error('Only draft tasks can prepare a worktree.');
  if (!dependenciesComplete(task) && task.dependsOn.length) throw new Error('Dependencies must be merged before preparing this task.');
  if (!(await gitReady())) throw new Error('This workspace needs an initialized Git repository with at least one commit.');
  const run = task.run_id ? requireRun(task.run_id) : null;
  const baseRef = run ? run.integration_branch : 'HEAD';
  updateTask(task.id, { status: 'preparing' });
  const area = join(dirname(root), `${basename(root)}.aod-worktrees`);
  const location = join(area, task.id);
  try {
    await mkdir(area, { recursive: true });
    if (await exists(location)) {
      try { await git(['worktree', 'remove', '--force', location]); } catch { await rm(location, { recursive: true, force: true }); }
    }
    await git(['worktree', 'add', '-b', task.branch, location, baseRef]);
    const prepared = updateTask(task.id, { status: 'ready', worktree: location, base_commit: (await git(['rev-parse', baseRef])).stdout.trim(), recovery_note: null });
    await writeHandoff(prepared);
    appendEvent('worktree', `${task.id} worktree prepared (${source})`, task.id);
    return prepared;
  } catch (error) {
    updateTask(task.id, { status: 'draft', recovery_note: error instanceof Error ? error.message : 'Worktree preparation failed.' });
    appendEvent('error', `${task.id} worktree preparation failed`, task.id);
    throw error;
  }
}

function currentProcessCount() { return taskProcesses.size + reviewProcesses.size + groupProcesses.size + roleProcesses.size + plannerProcesses.size; }
async function startTask(task, source = 'manual') {
  if (task.status !== 'ready') throw new Error('Only prepared tasks can start an agent process.');
  if (!task.worktree || !(await exists(task.worktree))) throw new Error('This task has no prepared worktree.');
  if (task.locked) throw new Error('This task is locked for conflict review.');
  if (taskProcesses.has(task.id)) throw new Error('An agent process is already attached to this task.');
  const releaseAgentSlot = await acquireAgentSlot();
  try {
    const config = await loadConfig();
    const adapter = config.agents[task.agent];
    if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new Error(`No ${task.agent} adapter is configured.`);
    const promptPath = join(handoffDir, `${task.id}.md`);
    if (!(await exists(promptPath))) throw new Error('The task handoff file is missing. Prepare the worktree again.');
    const prompt = await readFile(promptPath, 'utf8');
    const args = adapter.args.map(value => expand(value, task, prompt));
    const timeoutMs = Math.max(1000, Number(adapter.timeoutMs || config.defaults.agentTimeoutMs || task.timeout_ms));
    const maxRetries = Math.max(0, Number(adapter.maxRetries ?? config.defaults.maxRetries ?? task.max_retries));
    const roleAssignment = getTaskRoleAssignment(task.id);
    if (roleAssignment) updateTaskRoleAssignment(task.id, { stage: 'executing' });
    task = updateTask(task.id, { status: 'running', output: '', process_pid: null, attempts: task.attempts + 1, max_retries: maxRetries, timeout_ms: timeoutMs, started_at: now(), finished_at: null, recovery_note: null });
    appendEvent('agent', `${task.id} started ${task.agent} (${source})`, task.id);
    const child = spawn(adapter.command, args, { cwd: task.worktree, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AOD_TASK_ID: task.id, AOD_WORKTREE: task.worktree, AOD_TASK_STAGE: roleAssignment ? 'execute' : 'task', AOD_TASK_FILES: JSON.stringify(task.files) } });
    const processId = startAgentProcessRecord({
      kind: roleAssignment ? 'role_execute' : 'task', entityId: task.id, runId: task.run_id, taskId: task.id,
      sessionId: roleAssignment?.session_id || null, agent: task.agent, child, command: adapter.command, args,
      timeoutMs, attempt: task.attempts, metadata: { source, stage: roleAssignment ? 'execute' : 'task' }
    });
    const timer = setTimeout(() => { const entry = taskProcesses.get(task.id); if (entry) entry.timedOut = true; child.kill(); }, timeoutMs);
    taskProcesses.set(task.id, { child, timer, timedOut: false, processId });
    releaseAgentSlot();
    updateTask(task.id, { process_pid: child.pid || null });
    child.stdin.end(adapter.stdin === undefined ? undefined : expand(adapter.stdin, task, prompt));
    child.stdout.on('data', data => { try { appendOutput(task.id, data.toString(), 'stdout'); touchAgentProcessOutput(processId); } catch {} });
    child.stderr.on('data', data => { try { appendOutput(task.id, data.toString(), 'stderr'); touchAgentProcessOutput(processId); } catch {} });
    child.once('error', error => finishTaskProcess(task.id, child, { ok: false, error, code: null }).catch(() => {}));
    child.once('close', code => finishTaskProcess(task.id, child, { ok: code === 0, code }).catch(() => {}));
    return getTask(task.id);
  } finally {
    releaseAgentSlot();
  }
}

async function finishTaskProcess(id, child, outcome) {
  const entry = taskProcesses.get(id);
  if (!entry || entry.child !== child) return;
  clearTimeout(entry.timer);
  taskProcesses.delete(id);
  const task = requireTask(id);
  const roleAssignment = getTaskRoleAssignment(id);
  if (task.status !== 'running') {
    finishAgentProcessRecord(entry.processId, { status: 'cancelled', exitCode: outcome.code, reason: `Task entered ${task.status} before the process closed.` });
    return;
  }
  const errorText = entry.timedOut ? `Agent timed out after ${task.timeout_ms}ms.` : outcome.error?.message;
  finishAgentProcessRecord(entry.processId, {
    status: outcome.ok ? 'succeeded' : entry.timedOut ? 'timed_out' : 'failed',
    exitCode: outcome.code,
    reason: outcome.ok ? null : errorText || `Agent exited with ${outcome.code}.`
  });
  if (outcome.ok) {
    updateTask(id, { status: 'verifying', process_pid: null, last_exit_code: outcome.code, finished_at: now() });
    if (getTaskRoleAssignment(id)) updateTaskRoleAssignment(id, { stage: 'verifying' });
    appendEvent('agent', `${id} exited successfully; awaiting verification`, id);
  } else if (roleAssignment) {
    updateTask(id, { status: 'recovery_required', process_pid: null, last_exit_code: outcome.code, finished_at: now(), recovery_note: errorText || 'Group executor exited unsuccessfully.' });
    updateTaskRoleAssignment(id, { stage: 'recovery_required' });
    updateGroupSession(roleAssignment.session_id, { status: 'recovery_required', recovery_note: errorText || 'Group executor failed.' });
    appendEvent('agent', `${id} group executor requires recovery`, id);
  } else if (currentMode() === 'auto' && task.attempts <= task.max_retries) {
    updateTask(id, { status: 'ready', process_pid: null, last_exit_code: outcome.code, recovery_note: errorText || 'Agent exited unsuccessfully.' });
    appendEvent('retry', `${id} will retry automatically (${task.attempts}/${task.max_retries})`, id);
  } else {
    updateTask(id, { status: 'failed', process_pid: null, last_exit_code: outcome.code, finished_at: now(), recovery_note: errorText || 'Agent exited unsuccessfully.' });
    appendEvent('agent', `${id} agent process failed`, id);
  }
  scheduleAdvance();
  scheduleGroupAdvance();
}

async function verifyTask(task, source = 'manual') {
  if (task.status !== 'verifying') throw new Error('Only tasks in verification can run acceptance checks.');
  if (!task.worktree || !(await exists(task.worktree))) throw new Error('This task has no prepared worktree.');
  if (!task.acceptance) throw new Error('Add an acceptance command before verification.');
  const commit = (await git(['rev-parse', 'HEAD'], task.worktree)).stdout.trim();
  try {
    const result = await runShell(task.acceptance, task.worktree, task.timeout_ms);
    const roleAssignment = getTaskRoleAssignment(task.id);
    updateTask(task.id, { status: roleAssignment ? 'reviewing' : 'merge_ready', verified_commit: commit, verification: { at: now(), command: task.acceptance, output: redactSecrets(`${result.stdout}${result.stderr}`).slice(-8000), commit }, recovery_note: null });
    if (roleAssignment) updateTaskRoleAssignment(task.id, { stage: 'reviewing', review_commit: commit });
    appendEvent('verify', `${task.id} acceptance check passed (${source})`, task.id);
    if (roleAssignment) scheduleGroupAdvance();
    return getTask(task.id);
  } catch (error) {
    const roleAssignment = getTaskRoleAssignment(task.id);
    const verification = { at: now(), command: task.acceptance, output: redactSecrets(error instanceof Error ? error.message : 'Verification failed.'), commit };
    if (roleAssignment?.fixer_member_id && roleAssignment.repair_count < roleAssignment.max_repairs) {
      updateTaskRoleAssignment(task.id, { stage: 'repairing', review: { decision: 'changes_requested', summary: 'Acceptance failed.', findings: [verification.output] } });
      updateTask(task.id, { status: 'repairing', verification, recovery_note: 'Acceptance failed; repair requested.' });
      scheduleGroupAdvance();
    } else if (roleAssignment) {
      updateTaskRoleAssignment(task.id, { stage: 'recovery_required', review: { decision: 'changes_requested', summary: 'Acceptance failed.', findings: [verification.output] } });
      updateTask(task.id, { status: 'recovery_required', verification, recovery_note: 'Acceptance failed and repair is unavailable.' });
      updateGroupSession(roleAssignment.session_id, { status: 'recovery_required', recovery_note: 'Task acceptance failed.' });
    } else {
      updateTask(task.id, { status: 'failed', verification, recovery_note: 'Acceptance failed.' });
    }
    appendEvent('verify', `${task.id} acceptance check failed`, task.id);
    if (roleAssignment) return getTask(task.id);
    throw error;
  }
}

async function createConflictReview(task, error, cwd = root) {
  const files = (await git(['diff', '--name-only', '--diff-filter=U'], cwd)).stdout.trim().split(/\r?\n/).filter(Boolean);
  const diff = (await git(['diff', '--no-ext-diff'], cwd)).stdout.slice(-24000);
  try { await git(['merge', '--abort'], cwd); } catch {}
  if (!files.length) return false;
  const reviewId = `R-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare('INSERT INTO reviews(id, task_id, reviewer_agent, status, conflict_files_json, conflict_diff, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(reviewId, task.id, 'codex', 'pending', JSON.stringify(files), diff, now(), now());
  updateTask(task.id, { status: 'conflict_review', locked: true, recovery_note: error.message });
  appendEvent('conflict', `${task.id} merge conflict captured for review ${reviewId}`, task.id);
  return true;
}

async function mergeTask(task, source = 'manual') {
  if (task.status !== 'merge_ready') throw new Error('Only verified tasks can enter the merge gate.');
  if (!(await gitReady())) throw new Error('The main repository is not ready for merging.');
  const run = task.run_id ? requireRun(task.run_id) : null;
  const branch = run ? run.integration_branch : (getSetting('integration_branch') || 'main');
  const cwd = run?.integration_worktree || root;
  if (run && !run.integration_worktree) throw new Error('Run integration worktree is missing.');
  const currentBranch = (await git(['branch', '--show-current'], cwd)).stdout.trim();
  if (currentBranch !== branch) throw new Error(`Merge must run from ${branch}, currently on ${currentBranch || 'detached HEAD'}.`);
  if (!(await gitClean(cwd))) throw new Error('Integration branch has uncommitted changes. Commit or stash them before merging.');
  const branchHead = (await git(['rev-parse', task.branch])).stdout.trim();
  if (task.verified_commit !== branchHead) throw new Error('Task branch changed after verification. Run verification again.');
  const ahead = Number((await git(['rev-list', '--count', `HEAD..${task.branch}`])).stdout.trim());
  if (ahead < 1) throw new Error('The task branch has no commits to merge.');
  updateTask(task.id, { status: 'merging' });
  try {
    await git(['merge', '--no-ff', task.branch, '-m', `merge: ${task.id} ${task.title}`], cwd);
    updateTask(task.id, { status: 'merged', locked: false, finished_at: now(), recovery_note: null });
    appendEvent('merge', `${task.id} merged into ${branch} (${source})`, task.id);
    if (run && runTasks(run.id).every(item => item.id === task.id || item.status === 'merged')) {
      updateRun(run.id, { status: 'ready_to_publish' });
      const groupSession = db.prepare('SELECT id FROM group_sessions WHERE run_id = ?').get(run.id);
      if (groupSession) updateGroupSession(groupSession.id, { status: 'completed', finished_at: now() });
      appendEvent('run', `${run.id} is ready to publish`, null, run.id);
    }
    scheduleAdvance();
    await scheduleGroupAdvance();
    return getTask(task.id);
  } catch (error) {
    if (await createConflictReview(task, error instanceof Error ? error : new Error('Merge failed.'), cwd)) return getTask(task.id);
    updateTask(task.id, { status: 'failed', recovery_note: error instanceof Error ? error.message : 'Merge failed.' });
    appendEvent('merge', `${task.id} merge failed`, task.id);
    throw error;
  }
}

async function startReview(task) {
  if (task.status !== 'conflict_review') throw new Error('This task is not waiting for conflict review.');
  const review = listReviews().find(item => item.task_id === task.id && ['pending', 'failed'].includes(item.status));
  if (!review) throw new Error('No pending conflict review exists for this task.');
  if (reviewProcesses.has(review.id)) throw new Error('Reviewer agent is already running.');
  const releaseAgentSlot = await acquireAgentSlot();
  let area = null;
  try {
    const config = await loadConfig();
    const agent = config.reviewerAgent || review.reviewer_agent;
    const adapter = config.agents[agent];
    if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.reviewArgs)) throw new Error(`No read-only reviewer adapter is configured for ${agent}.`);
    area = join(dirname(root), `${basename(root)}.aod-conflict-reviews`, review.id);
    if (await exists(area)) {
      try { await git(['worktree', 'remove', '--force', area]); } catch { await rm(area, { recursive: true, force: true }); }
    }
    await mkdir(dirname(area), { recursive: true });
    const reviewCommit = (await git(['rev-parse', 'HEAD'], task.worktree)).stdout.trim();
    await git(['worktree', 'add', '--detach', area, reviewCommit]);
    const reviewTask = { ...task, worktree: area };
    const prompt = [
      'You are a read-only merge conflict reviewer. Do not modify files or run write commands.',
      `Task: ${task.id} ${task.title}`, `Worktree: ${area}`, 'Conflicted files:', ...review.conflictFiles.map(file => `- ${file}`),
      '', 'Return a concise rationale and one optional unified diff patch in a ```diff code fence. The operator will review and apply it manually.', '', review.conflict_diff
    ].join('\n');
    const child = spawn(adapter.command, adapter.reviewArgs.map(value => expand(value, reviewTask, prompt)), {
      cwd: area, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AOD_TASK_ID: task.id, AOD_WORKTREE: area, AOD_TASK_STAGE: 'conflict_review', AOD_TASK_FILES: JSON.stringify(task.files) }
    });
    let output = '';
    const timeoutMs = Number(adapter.timeoutMs || config.defaults?.reviewTimeoutMs || 600000);
    let timedOut = false;
    const processId = startAgentProcessRecord({
      kind: 'conflict_review', entityId: review.id, runId: task.run_id, taskId: task.id, agent,
      child, command: adapter.command, args: adapter.reviewArgs.map(value => expand(value, reviewTask, prompt)),
      timeoutMs, metadata: { worktree: area }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    reviewProcesses.set(review.id, { child, timer, area, finishing: false, processId });
    releaseAgentSlot();
    db.prepare('UPDATE reviews SET status = ?, reviewer_agent = ?, updated_at = ? WHERE id = ?').run('running', agent, now(), review.id);
    appendEvent('review', `${review.id} reviewer agent started`, task.id);
    child.stdin.end(adapter.stdin === undefined ? undefined : expand(adapter.stdin, reviewTask, prompt));
    child.stdout.on('data', data => { output = `${output}${data}`.slice(-24000); touchAgentProcessOutput(processId); });
    child.stderr.on('data', data => { output = `${output}${data}`.slice(-24000); touchAgentProcessOutput(processId); });
    const finish = async (candidateStatus, outcome = {}) => {
      const active = reviewProcesses.get(review.id);
      if (!active || active.child !== child || active.finishing) return;
      active.finishing = true;
      clearTimeout(active.timer);
      let status = candidateStatus;
      if (status === 'suggested') {
        try {
          const [head, changes] = await Promise.all([
            git(['rev-parse', 'HEAD'], area),
            git(['status', '--porcelain', '--untracked-files=all'], area)
          ]);
          if (head.stdout.trim() !== reviewCommit || changes.stdout.trim()) status = 'failed';
        } catch { status = 'failed'; }
      }
      try { await git(['worktree', 'remove', '--force', area]); } catch { try { await rm(area, { recursive: true, force: true }); } catch {} }
      reviewProcesses.delete(review.id);
      finishAgentProcessRecord(processId, {
        status: status === 'suggested' ? 'succeeded' : timedOut ? 'timed_out' : 'failed',
        exitCode: outcome.code ?? null,
        reason: status === 'suggested' ? null : timedOut ? `Conflict reviewer timed out after ${timeoutMs}ms.` : outcome.error?.message || 'Conflict reviewer failed or modified its worktree.'
      });
      db.prepare('UPDATE reviews SET status = ?, suggestion = ?, updated_at = ? WHERE id = ?').run(status, output, now(), review.id);
      appendEvent('review', `${review.id} reviewer ${status}`, task.id);
    };
    child.once('error', error => { finish('failed', { error }).catch(() => {}); });
    child.once('close', code => { finish(code === 0 ? 'suggested' : 'failed', { code }).catch(() => {}); });
    return reviewFromRow(db.prepare('SELECT * FROM reviews WHERE id = ?').get(review.id));
  } finally {
    releaseAgentSlot();
  }
}

async function approveReview(review, patch) {
  if (review.status !== 'suggested') throw new Error('Only a completed reviewer suggestion can be approved.');
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('Paste the reviewed unified diff before approving it.');
  const task = requireTask(review.task_id);
  if (task.status !== 'conflict_review' || !task.worktree) throw new Error('Task is not available for conflict resolution.');
  if (!(await gitClean(task.worktree))) throw new Error('The task worktree must be clean before an approved conflict patch can be applied.');
  const patchPath = join(aodDir, `review-${review.id}.patch`);
  await writeFile(patchPath, patch, 'utf8');
  try {
    await git(['apply', '--check', patchPath], task.worktree);
    await git(['apply', patchPath], task.worktree);
    await git(['add', '--all'], task.worktree);
    const changed = (await git(['diff', '--cached', '--name-only'], task.worktree)).stdout.trim();
    if (!changed) throw new Error('The approved patch did not change the task worktree.');
    await git(['commit', '-m', `fix: resolve conflict for ${task.id}`], task.worktree);
    db.prepare('UPDATE reviews SET status = ?, patch = ?, updated_at = ? WHERE id = ?').run('approved', patch, now(), review.id);
    updateTask(task.id, { status: 'verifying', locked: false, verified_commit: null, recovery_note: null });
    appendEvent('review', `${review.id} patch approved and committed`, task.id);
    scheduleAdvance();
    return getTask(task.id);
  } finally { try { await rm(patchPath, { force: true }); } catch {} }
}

function scheduleAdvance() {
  advanceQueue = advanceQueue.catch(() => {}).then(async () => {
    const mode = currentMode();
    if (mode === 'manual') return;
    for (const task of listTasks()) {
      if (getTaskRoleAssignment(task.id)) continue;
      try {
        if (task.status === 'draft' && dependenciesComplete(task)) await prepareTask(task, mode);
        else if (task.status === 'ready' && mode === 'auto') await startTask(task, mode);
        else if (task.status === 'verifying') await verifyTask(task, mode);
      } catch (error) {
        appendEvent('automation', `${task.id}: ${error instanceof Error ? error.message : 'automatic step failed'}`, task.id);
      }
    }
  });
  return advanceQueue;
}

let groupAdvanceQueue = Promise.resolve();

async function runRoleAdapter(task, member, stage, prompt, cwd) {
  const session = requireGroupSession(getTaskRoleAssignment(task.id).session_id);
  const checkCancelled = () => {
    if (requireGroupSession(session.id).status === 'cancelled') throw new Error('Group session was cancelled.');
  };
  const releaseAgentSlot = await acquireAgentSlot(checkCancelled);
  try {
    const config = await loadConfig();
    const adapter = config.agents[member.agent];
    if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new Error(`No ${member.agent} adapter is configured.`);
    const argumentTemplate = stage === 'review' ? adapter.reviewArgs : adapter.args;
    if (!Array.isArray(argumentTemplate)) throw new Error('Reviewer adapters require a dedicated reviewArgs array.');
    const key = `${task.id}:${stage}`;
    const promptFile = join(cwd, `.aod-${stage}-prompt.md`);
    await writeFile(promptFile, `${prompt}\n`, 'utf8');
    checkCancelled();
    const invocationTask = { ...task, worktree: cwd };
    const args = argumentTemplate.map(value => expand(value, invocationTask, prompt, promptFile));
    const timeoutMs = Math.max(1000, Number(adapter.roleTimeoutMs || config.defaults?.reviewTimeoutMs || adapter.timeoutMs || 600000));
    return await new Promise((resolveRole, rejectRole) => {
      const child = spawn(adapter.command, args, {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AOD_TASK_ID: task.id, AOD_WORKTREE: cwd, AOD_TASK_STAGE: stage, AOD_TASK_FILES: JSON.stringify(task.files), AOD_GROUP_SESSION_ID: session.id, AOD_GROUP_MEMBER_ID: member.id }
      });
      let output = '';
      let settled = false;
      let timedOut = false;
      const assignment = getTaskRoleAssignment(task.id);
      const processId = startAgentProcessRecord({
        kind: `role_${stage}`, entityId: task.id, runId: task.run_id, taskId: task.id, sessionId: session.id,
        agent: member.agent, child, command: adapter.command, args, timeoutMs,
        attempt: Math.max(1, Number(assignment?.repair_count || 0) + 1), metadata: { memberId: member.id, stage }
      });
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        roleProcesses.delete(key);
        try { rm(promptFile, { force: true }); } catch {}
        const cancelled = getGroupSession(session.id)?.status === 'cancelled';
        finishAgentProcessRecord(processId, {
          status: cancelled ? 'cancelled' : !error && !timedOut && code === 0 ? 'succeeded' : timedOut ? 'timed_out' : 'failed',
          exitCode: code,
          reason: cancelled ? 'Group session was cancelled.' : error?.message || (timedOut ? `${stage} timed out after ${timeoutMs}ms.` : code === 0 ? null : `${stage} exited with ${code}.`)
        });
        if (cancelled) {
          rejectRole(new Error('Group session was cancelled.'));
          return;
        }
        if (error || timedOut || code !== 0) rejectRole(error || new Error(timedOut ? `${stage} timed out after ${timeoutMs}ms.` : `${stage} exited with ${code}.`));
        else resolveRole(redactSecrets(output).slice(-12000).trim());
      };
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      roleProcesses.set(key, { child, timer, sessionId: session.id, taskId: task.id, stage, processId });
      releaseAgentSlot();
      child.stdin.end(adapter.stdin === undefined ? undefined : expand(adapter.stdin, invocationTask, prompt, promptFile));
      child.stdout.on('data', data => { output = `${output}${data}`.slice(-12000); appendOutput(task.id, data.toString(), stage); touchAgentProcessOutput(processId); });
      child.stderr.on('data', data => { output = `${output}${data}`.slice(-12000); appendOutput(task.id, data.toString(), stage); touchAgentProcessOutput(processId); });
      child.once('error', error => finish(error, null));
      child.once('close', code => finish(null, code));
    });
  } finally {
    releaseAgentSlot();
  }
}

async function inspectGroupTask(task) {
  const assignment = getTaskRoleAssignment(task.id);
  if (!assignment || task.status !== 'reviewing') return task;
  if (task.verified_commit !== assignment.review_commit) throw new Error('Task verification commit no longer matches the requested review commit.');
  const session = requireGroupSession(assignment.session_id);
  const reviewer = session.members.find(member => member.id === assignment.reviewer_member_id);
  if (!reviewer) throw new Error('Assigned reviewer is missing from the session snapshot.');
  const area = join(dirname(root), `${basename(root)}.aod-role-reviews`, task.id);
  if (await exists(area)) {
    try { await git(['worktree', 'remove', '--force', area]); } catch { await rm(area, { recursive: true, force: true }); }
  }
  await mkdir(dirname(area), { recursive: true });
  await git(['worktree', 'add', '--detach', area, task.verified_commit]);
  try {
    const diff = (await git(['diff', '--stat', `${task.base_commit}..${task.verified_commit}`], area)).stdout;
    const prompt = [
      `Review task ${task.id}: ${task.title}`, `Commit: ${task.verified_commit}`, `Acceptance: ${task.acceptance}`,
      'Inspect this detached worktree. Do not modify the task branch.',
      'Return JSON only: {"decision":"pass|changes_requested","summary":"...","findings":["..."]}', '', diff
    ].join('\n');
    const output = await runRoleAdapter(task, reviewer, 'review', prompt, area);
    if (getGroupSession(session.id)?.status === 'cancelled') return getTask(task.id);
    await rm(join(area, '.aod-review-prompt.md'), { force: true });
    const [reviewedCommit, reviewerChanges] = await Promise.all([
      git(['rev-parse', 'HEAD'], area),
      git(['status', '--porcelain', '--untracked-files=all'], area)
    ]);
    if (reviewedCommit.stdout.trim() !== task.verified_commit || reviewerChanges.stdout.trim()) {
      throw new Error('Reviewer modified the detached inspection worktree. Only a structured decision is allowed.');
    }
    const review = extractJson(output);
    if (!review || !['pass', 'changes_requested'].includes(review.decision)) throw new Error('Reviewer did not return a valid decision.');
    if (review.decision === 'pass') {
      updateTaskRoleAssignment(task.id, { stage: 'passed', review });
      updateTask(task.id, { status: 'merge_ready', recovery_note: null });
      appendEvent('task_role', `${task.id} passed group review`, task.id);
      const assignments = db.prepare('SELECT stage FROM task_role_assignments WHERE session_id = ?').all(session.id);
      if (assignments.length && assignments.every(item => item.stage === 'passed')) updateGroupSession(session.id, { status: 'awaiting_merge' });
    } else if (assignment.fixer_member_id && assignment.repair_count < assignment.max_repairs) {
      updateTaskRoleAssignment(task.id, { stage: 'repairing', review });
      updateTask(task.id, { status: 'repairing', recovery_note: review.summary || 'Reviewer requested changes.' });
    } else {
      updateTaskRoleAssignment(task.id, { stage: 'recovery_required', review });
      updateTask(task.id, { status: 'recovery_required', recovery_note: 'Review changes requested and repair budget is exhausted.' });
      updateGroupSession(session.id, { status: 'recovery_required', recovery_note: 'Review changes requested and repair budget is exhausted.' });
    }
    return getTask(task.id);
  } finally {
    try { await git(['worktree', 'remove', '--force', area]); } catch { try { await rm(area, { recursive: true, force: true }); } catch {} }
  }
}

async function repairGroupTask(task) {
  const assignment = getTaskRoleAssignment(task.id);
  if (!assignment || task.status !== 'repairing') return task;
  if (!assignment.fixer_member_id || assignment.repair_count >= assignment.max_repairs) {
    updateTaskRoleAssignment(task.id, { stage: 'recovery_required' });
    const recovered = updateTask(task.id, { status: 'recovery_required', recovery_note: 'Repair budget is exhausted.' });
    updateGroupSession(assignment.session_id, { status: 'recovery_required', recovery_note: 'Repair budget is exhausted.' });
    return recovered;
  }
  const session = requireGroupSession(assignment.session_id);
  const fixer = session.members.find(member => member.id === assignment.fixer_member_id);
  if (!fixer) throw new Error('Assigned fixer is missing from the session snapshot.');
  const before = (await git(['rev-parse', 'HEAD'], task.worktree)).stdout.trim();
  const prompt = [
    `Repair task ${task.id}: ${task.title}`, `Worktree: ${task.worktree}`,
    'Apply the smallest fix for the reviewer findings, run focused checks, and commit the changes.',
    'Do not modify files outside the owned paths.', '', JSON.stringify(assignment.review || {}, null, 2)
  ].join('\n');
  try {
    await runRoleAdapter(task, fixer, 'repair', prompt, task.worktree);
    if (getGroupSession(session.id)?.status === 'cancelled') return getTask(task.id);
    const after = (await git(['rev-parse', 'HEAD'], task.worktree)).stdout.trim();
    if (after === before) throw new Error('Fixer completed without creating a new commit.');
    updateTaskRoleAssignment(task.id, { stage: 'verifying', repair_count: assignment.repair_count + 1, review_commit: null });
    updateTask(task.id, { status: 'verifying', verified_commit: null, verification: null, recovery_note: null });
    appendEvent('task_role', `${task.id} repair ${assignment.repair_count + 1}/${assignment.max_repairs} committed`, task.id);
    return getTask(task.id);
  } catch (error) {
    if (getGroupSession(session.id)?.status !== 'cancelled') {
      updateTaskRoleAssignment(task.id, { stage: 'recovery_required' });
      updateTask(task.id, { status: 'recovery_required', recovery_note: error instanceof Error ? error.message : 'Repair failed.' });
    }
    throw error;
  }
}

function scheduleGroupAdvance() {
  groupAdvanceQueue = groupAdvanceQueue.catch(() => {}).then(async () => {
    const assignments = db.prepare("SELECT * FROM task_role_assignments WHERE stage NOT IN ('passed', 'recovery_required', 'failed') ORDER BY task_id ASC").all();
    for (const assignment of assignments) {
      const session = requireGroupSession(assignment.session_id);
      if (!['executing', 'awaiting_merge'].includes(session.status)) continue;
      try {
        for (let step = 0; step < 6; step += 1) {
          const task = requireTask(assignment.task_id);
          if (task.status === 'draft' && dependenciesComplete(task)) { await prepareTask(task, 'group'); continue; }
          if (task.status === 'ready') { await startTask(task, 'group'); break; }
          if (task.status === 'verifying') { await verifyTask(task, 'group'); continue; }
          if (task.status === 'reviewing' && !roleProcesses.has(`${task.id}:review`)) { await inspectGroupTask(task); continue; }
          if (task.status === 'repairing' && !roleProcesses.has(`${task.id}:repair`)) { await repairGroupTask(task); continue; }
          break;
        }
      } catch (error) {
        const session = getGroupSession(assignment.session_id);
        if (session?.status === 'cancelled') continue;
        const message = error instanceof Error ? error.message : 'Role pipeline failed.';
        const current = getTaskRoleAssignment(assignment.task_id);
        if (current && current.stage !== 'passed') updateTaskRoleAssignment(assignment.task_id, { stage: 'recovery_required' });
        const task = getTask(assignment.task_id);
        if (task && !['merged', 'cancelled', 'merge_ready'].includes(task.status)) updateTask(task.id, { status: 'recovery_required', recovery_note: message, process_pid: null });
        updateGroupSession(assignment.session_id, { status: 'recovery_required', recovery_note: message });
        appendEvent('task_role', `${assignment.task_id}: ${message}`, assignment.task_id);
      }
    }
  });
  return groupAdvanceQueue;
}

function nextTaskId() {
  const index = Number(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count) + 1;
  return `T-${String(index).padStart(3, '0')}`;
}

async function acceptanceAllowed(command, required = false) {
  if (!command?.trim()) {
    if (required) throw new Error('Every planned task requires an acceptance command.');
    return '';
  }
  const config = await loadConfig();
  const allowed = config.security?.allowedAcceptancePrefixes || ['npm ', 'node ', 'pnpm ', 'yarn ', 'git ', 'python ', 'py '];
  if (/[;&|<>`\r\n]/.test(command) || command.includes('$(')) throw new Error(`Acceptance command contains a shell control operator: ${command}`);
  if (!allowed.some(prefix => command.trim().startsWith(prefix))) throw new Error(`Acceptance command is not allowed: ${command}`);
  return command.trim();
}

function validateDraftTasks(drafts) {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('A run requires at least one planned task.');
  const keys = new Set();
  const normalized = drafts.map((draft, index) => {
    const key = String(draft.key || `task-${index + 1}`).trim();
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(key) || keys.has(key)) throw new Error(`Invalid or duplicate task key: ${key}`);
    keys.add(key);
    if (typeof draft.title !== 'string' || !draft.title.trim()) throw new Error(`Task ${key} needs a title.`);
    if (!agents.includes(draft.agent)) throw new Error(`Task ${key} has an unsupported agent.`);
    return { key, title: draft.title.trim(), agent: draft.agent, files: cleanPaths(draft.files), dependsOn: Array.isArray(draft.dependsOn) ? draft.dependsOn.map(String) : [], acceptance: String(draft.acceptance || '').trim(), risk: String(draft.risk || '').trim(), timeoutMs: Number(draft.timeoutMs || 1800000), maxRetries: Number(draft.maxRetries || 0) };
  });
  for (const task of normalized) for (const dependency of task.dependsOn) if (!keys.has(dependency) || dependency === task.key) throw new Error(`Task ${task.key} has an invalid dependency: ${dependency}`);
  for (let left = 0; left < normalized.length; left += 1) for (let right = left + 1; right < normalized.length; right += 1) {
    for (const a of normalized[left].files) for (const b of normalized[right].files) if (pathsOverlap(a, b)) throw new Error(`Planned ownership conflict: ${a} overlaps with ${b}.`);
  }
  const graph = normalized.map(task => ({ id: task.key, dependsOn: task.dependsOn }));
  validateGraph(graph);
  return normalized;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return json(candidate, null);
}

async function planWithCodex(requirement, planner = 'codex') {
  const config = await loadConfig();
  const adapter = config.planner || config.agents[planner];
  if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new Error(`No planner adapter is configured for ${planner}.`);
  const prompt = [
    'You are the planning controller for a local multi-agent coding run.',
    'Return JSON only, no markdown. Use this shape:',
    '{"title":"short run title","tasks":[{"key":"api","title":"...","agent":"codex|claude-code|antigravity","files":["path"],"dependsOn":["key"],"acceptance":"npm run check","risk":"short risk"}]}',
    'Tasks must have disjoint file ownership and an acyclic dependency graph. Every task needs a concrete acceptance command.',
    '', `Requirement:\n${requirement}`
  ].join('\n');
  const args = adapter.args.map(value => String(value).replaceAll('{{prompt}}', prompt).replaceAll('{{worktree}}', root).replaceAll('{{taskId}}', 'planner').replaceAll('{{promptFile}}', ''));
  const timeoutMs = Number(adapter.timeoutMs || config.defaults?.plannerTimeoutMs || 600000);
  let releaseAgentSlot = await acquireAgentSlot();
  let result;
  try {
    result = await new Promise((resolvePlan, rejectPlan) => {
      const id = `planner:${crypto.randomUUID()}`;
      const child = spawn(adapter.command, args, { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let settled = false;
      let timedOut = false;
      const processId = startAgentProcessRecord({
        kind: 'planner', entityId: id, agent: planner, child, command: adapter.command, args,
        timeoutMs, metadata: { requirementHash: createHash('sha256').update(requirement).digest('hex') }
      });
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        plannerProcesses.delete(id);
        finishAgentProcessRecord(processId, {
          status: !error && !timedOut && code === 0 ? 'succeeded' : timedOut ? 'timed_out' : 'failed',
          exitCode: code,
          reason: error?.message || (timedOut ? `Planner timed out after ${timeoutMs}ms.` : code === 0 ? null : `Planner exited with ${code}.`)
        });
        if (timedOut) rejectPlan(new Error(`Planner timed out after ${timeoutMs}ms.`));
        else if (error) rejectPlan(error);
        else if (code === 0) resolvePlan(output);
        else rejectPlan(new Error(output.trim() || `Planner exited with ${code}.`));
      };
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      plannerProcesses.set(id, { child, timer, processId });
      releaseAgentSlot();
      releaseAgentSlot = null;
      child.stdout.on('data', data => { output += data; touchAgentProcessOutput(processId); });
      child.stderr.on('data', data => { output += data; touchAgentProcessOutput(processId); });
      child.stdin.end(adapter.stdin === undefined ? undefined : String(adapter.stdin).replaceAll('{{prompt}}', prompt));
      child.once('error', error => finish(error, null));
      child.once('close', code => finish(null, code));
    });
  } finally {
    releaseAgentSlot?.();
  }
  const dag = extractJson(result);
  if (!dag || typeof dag.title !== 'string') throw new Error('Planner did not return a valid JSON run plan.');
  const tasks = validateDraftTasks(dag.tasks);
  for (const task of tasks) await acceptanceAllowed(task.acceptance, true);
  return { title: dag.title.trim(), tasks };
}

async function createRunFromPlan(plan, overrides = {}) {
  if (!(await gitReady())) throw new Error('A Git repository with an initial commit is required.');
  if (!(await gitClean(root))) throw new Error('Main worktree has uncommitted changes. Commit or stash them before creating a run.');
  const tasks = validateDraftTasks(overrides.tasks || json(plan.dag_json, {}).tasks);
  for (const task of tasks) await acceptanceAllowed(task.acceptance, true);
  const baseBranch = getSetting('integration_branch') || 'main';
  const baseCommit = (await git(['rev-parse', baseBranch])).stdout.trim();
  const id = `RUN-${Date.now().toString(36).toUpperCase()}`;
  const integrationBranch = `aod/run-${id.toLowerCase()}`;
  const area = join(dirname(root), `${basename(root)}.aod-runs`);
  const integrationWorktree = join(area, id);
  const run = { id, title: String(overrides.title || json(plan.dag_json, {}).title || 'Untitled run').trim(), requirement: plan.requirement, planner: plan.planner, mode: currentMode(), status: 'creating', base_branch: baseBranch, integration_branch: integrationBranch, integration_worktree: integrationWorktree, base_commit: baseCommit, github_repo: null, github_pr_number: null, github_pr_url: null, ci_status: 'not_published', ci: null, created_at: now(), updated_at: now(), finished_at: null };
  db.prepare('INSERT INTO runs(id, title, requirement, planner, mode, status, base_branch, integration_branch, integration_worktree, base_commit, github_repo, github_pr_number, github_pr_url, ci_status, ci_json, created_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(run.id, run.title, run.requirement, run.planner, run.mode, run.status, run.base_branch, run.integration_branch, run.integration_worktree, run.base_commit, null, null, null, run.ci_status, null, run.created_at, run.updated_at, null);
  try {
    await mkdir(area, { recursive: true });
    await git(['worktree', 'add', '-b', integrationBranch, integrationWorktree, baseBranch]);
    updateRun(id, { status: 'active' });
    const firstTaskIndex = Number(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count) + 1;
    const keyToId = new Map(tasks.map((task, index) => [task.key, `T-${String(firstTaskIndex + index).padStart(3, '0')}`]));
    for (let index = 0; index < tasks.length; index += 1) {
      const draft = tasks[index];
      const task = { id: keyToId.get(draft.key), title: draft.title, agent: draft.agent, files: draft.files, dependsOn: draft.dependsOn.map(key => keyToId.get(key)), acceptance: draft.acceptance, status: 'draft', branch: `aod/${id.toLowerCase()}/${slug(draft.title)}`, worktree: null, run_id: id, base_commit: null, verified_commit: null, verification: null, output: '', process_pid: null, attempts: 0, max_retries: Math.max(0, draft.maxRetries), timeout_ms: Math.max(1000, draft.timeoutMs), locked: false, recovery_note: draft.risk || null, last_exit_code: null, created_at: now(), updated_at: now(), started_at: null, finished_at: null };
      db.prepare(`INSERT INTO tasks (id, title, agent, files_json, depends_json, acceptance, status, branch, worktree, run_id, base_commit, verified_commit, verification_json, output, process_pid, attempts, max_retries, timeout_ms, locked, recovery_note, last_exit_code, created_at, updated_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, task.title, task.agent, JSON.stringify(task.files), JSON.stringify(task.dependsOn), task.acceptance, task.status, task.branch, null, task.run_id, null, null, null, '', null, 0, task.max_retries, task.timeout_ms, 0, task.recovery_note, null, task.created_at, task.updated_at, null, null);
      db.prepare('INSERT INTO run_tasks(run_id, task_id, position) VALUES (?, ?, ?)').run(id, task.id, index);
      appendEvent('task', `${task.id} added to ${id}`, task.id, id);
    }
    db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run('confirmed', now(), plan.id);
    appendEvent('run', `${id} created with ${tasks.length} tasks`, null, id);
    await scheduleAdvance();
    return requireRun(id);
  } catch (error) {
    updateRun(id, { status: 'failed', finished_at: now() });
    appendEvent('run', `${id} creation failed: ${error instanceof Error ? error.message : 'unknown error'}`, null, id);
    throw error;
  }
}

async function confirmGroupConsensus(session, payload) {
  if (session.status !== 'awaiting_confirmation') throw new Error('Only a completed discussion can be confirmed.');
  const draft = payload.consensus || session.consensus;
  if (!draft) throw new Error('A confirmed group session requires a task DAG.');
  const consensus = await validateSessionConsensus(session, draft);
  const memberById = new Map(session.members.map(member => [member.id, member]));
  const tasks = consensus.tasks.map(task => {
    const executor = memberById.get(task.executorMemberId);
    const reviewer = memberById.get(task.reviewerMemberId);
    const fixer = task.fixerMemberId ? memberById.get(task.fixerMemberId) : null;
    if (executor?.role !== 'executor') throw new Error(`Task ${task.key} has an invalid executor assignment.`);
    if (reviewer?.role !== 'reviewer') throw new Error(`Task ${task.key} has an invalid reviewer assignment.`);
    if (session.max_repairs > 0 && fixer?.role !== 'fixer') throw new Error(`Task ${task.key} has an invalid fixer assignment.`);
    return {
      key: task.key, title: task.title, description: String(task.description || ''), agent: executor.agent,
      files: task.files, dependsOn: task.dependsOn, acceptance: task.acceptance, risk: task.risk,
      timeoutMs: task.timeoutMs, maxRetries: task.maxRetries,
      executorMemberId: executor.id, reviewerMemberId: reviewer.id, fixerMemberId: fixer?.id || null
    };
  });
  const normalizedTasks = validateDraftTasks(tasks);
  for (const task of normalizedTasks) await acceptanceAllowed(task.acceptance, true);
  const planId = `PLAN-GROUP-${session.id}`;
  const createdAt = now();
  const planDag = { title: String(consensus.title || 'Group run').trim(), tasks: normalizedTasks };
  db.prepare('INSERT INTO plans(id, requirement, planner, dag_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(planId, session.requirement, `group:${session.group_id}`, JSON.stringify(planDag), 'ready', createdAt, createdAt);
  const run = await createRunFromPlan(db.prepare('SELECT * FROM plans WHERE id = ?').get(planId), { title: planDag.title, tasks: normalizedTasks });
  const createdTasks = runTasks(run.id);
  db.exec('BEGIN');
  try {
    createdTasks.forEach((task, index) => {
      const source = tasks[index];
      db.prepare(`INSERT INTO task_role_assignments(task_id, session_id, executor_member_id, reviewer_member_id, fixer_member_id, stage, repair_count, max_repairs, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(task.id, session.id, source.executorMemberId, source.reviewerMemberId, source.fixerMemberId, session.max_repairs, now());
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const updated = updateGroupSession(session.id, { status: 'executing', consensus, run_id: run.id, finished_at: null, recovery_note: null });
  appendEvent('group_session', `${session.id} confirmed as ${run.id}`, null, run.id);
  await scheduleGroupAdvance();
  return updated;
}

function ghExecutable() {
  if (process.env.AOD_GH_PATH) return process.env.AOD_GH_PATH;
  const windowsPath = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  return existsSync(windowsPath) ? windowsPath : 'gh';
}
async function gh(args, cwd = root, timeoutMs = 120000) { return run(ghExecutable(), args, cwd, timeoutMs); }
async function githubAuthenticated() { try { await gh(['auth', 'status', '--hostname', 'github.com']); return true; } catch { return false; } }
async function githubStatus() {
  const authenticated = await githubAuthenticated();
  let remote = null;
  try { remote = (await git(['remote', 'get-url', 'origin'])).stdout.trim(); } catch {}
  const login = githubLogin && !githubLogin.completed
    ? { pending: true, deviceCode: githubLogin.deviceCode, deviceUrl: githubLogin.deviceUrl, startedAt: githubLogin.startedAt }
    : null;
  return { available: await commandAvailable('gh'), authenticated, remote, login };
}
async function commandAvailable(command) {
  try { await run(command === 'gh' ? ghExecutable() : command, ['--version'], root, 8000); return true; } catch { return false; }
}
function startGithubLogin() {
  if (githubLogin && !githubLogin.completed) {
    return { started: true, pending: true, message: 'GitHub device authentication is already in progress.', deviceCode: githubLogin.deviceCode, deviceUrl: githubLogin.deviceUrl };
  }
  const child = spawn(ghExecutable(), ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  githubLogin = { child, startedAt: new Date().toISOString(), completed: false, deviceCode: null, deviceUrl: null, output: '', enterSent: false };
  const receive = data => {
    const text = String(data);
    githubLogin.output = `${githubLogin.output}${text}`.slice(-4000);
    githubLogin.deviceCode ||= githubLogin.output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1] || null;
    githubLogin.deviceUrl ||= githubLogin.output.match(/https:\/\/github\.com\/login\/device/i)?.[0] || null;
    appendEvent('github', redactSecrets(text), null, null);
    if (!githubLogin.enterSent && /Press Enter to open/i.test(githubLogin.output) && child.stdin.writable) {
      githubLogin.enterSent = true;
      child.stdin.write('\n');
    }
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  child.once('error', error => {
    githubLogin.completed = true;
    appendEvent('github', `GitHub authentication could not start: ${error.message}`, null, null);
  });
  child.once('close', code => {
    const output = githubLogin.output;
    githubLogin.completed = true;
    appendEvent('github', code === 0 ? 'GitHub authentication completed' : `GitHub authentication ended with ${code}: ${output.trim()}`, null, null);
  });
  return { started: true, message: 'GitHub device authentication started. The authorization code will appear here shortly.' };
}
async function ensureGithubRemote(payload = {}) {
  const status = await githubStatus();
  if (!status.available) throw new Error('GitHub CLI is not installed. Install gh before connecting GitHub.');
  if (!status.authenticated) throw new Error('GitHub CLI is not authenticated. Start /api/github/connect first.');
  if (status.remote) return status.remote;
  if (!payload.repo || !/^[\w.-]+\/[\w.-]+$/.test(payload.repo)) throw new Error('No origin remote is configured. Provide repo as owner/name to create one.');
  const visibility = payload.visibility === 'public' ? '--public' : '--private';
  await gh(['repo', 'create', payload.repo, visibility, '--source', '.', '--remote', 'origin', '--push']);
  return (await git(['remote', 'get-url', 'origin'])).stdout.trim();
}
async function refreshRunCi(run) {
  if (!run.github_pr_number || !(await githubAuthenticated())) return run;
  try {
    const view = json((await gh(['pr', 'view', String(run.github_pr_number), '--json', 'url,state,mergeStateStatus'])).stdout, {});
    let checks = [];
    try { checks = json((await gh(['pr', 'checks', String(run.github_pr_number), '--json', 'name,state,link,bucket'])).stdout, []); } catch {}
    const states = checks.map(check => check.state);
    const ciStatus = states.some(value => ['FAILURE', 'ERROR', 'CANCELLED'].includes(value)) ? 'failed' : states.length && states.every(value => ['SUCCESS', 'SKIPPING', 'NEUTRAL'].includes(value)) ? 'passed' : 'pending';
    return updateRun(run.id, { ci_status: ciStatus, ci: { view, checks, checkedAt: now() }, github_pr_url: view.url || run.github_pr_url });
  } catch (error) {
    appendEvent('github', `${run.id} CI refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`, null, run.id);
    return run;
  }
}
async function publishRun(run, payload = {}) {
  if (run.status !== 'ready_to_publish' && run.status !== 'published') throw new Error('Run is not ready to publish. All tasks must be merged into its integration branch.');
  await ensureGithubRemote(payload);
  await git(['push', '--set-upstream', 'origin', run.integration_branch], run.integration_worktree || root);
  let prUrl = run.github_pr_url;
  let prNumber = run.github_pr_number;
  if (!prNumber) {
    try {
      prUrl = (await gh(['pr', 'create', '--base', run.base_branch, '--head', run.integration_branch, '--title', run.title, '--body', `AOD run ${run.id}\n\n${run.requirement}`], run.integration_worktree || root)).stdout.trim();
    } catch {
      prUrl = (await gh(['pr', 'view', run.integration_branch, '--json', 'url', '--jq', '.url'], run.integration_worktree || root)).stdout.trim();
    }
    const view = json((await gh(['pr', 'view', prUrl, '--json', 'number,url'])).stdout, {});
    prNumber = view.number;
    prUrl = view.url || prUrl;
  }
  const published = updateRun(run.id, { status: 'published', github_pr_number: prNumber, github_pr_url: prUrl, ci_status: 'pending' });
  appendEvent('github', `${run.id} published as ${prUrl}`, null, run.id);
  return refreshRunCi(published);
}

async function fileSize(path) { try { return (await stat(path)).size; } catch { return 0; } }
async function directorySize(path) {
  try {
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) total += entry.isDirectory() ? await directorySize(join(path, entry.name)) : await fileSize(join(path, entry.name));
    return total;
  } catch { return 0; }
}
async function healthMetrics() {
  const databaseBytes = await fileSize(databasePath) + await fileSize(`${databasePath}-wal`) + await fileSize(`${databasePath}-shm`);
  const logBytes = await directorySize(handoffDir) + Number(db.prepare('SELECT COALESCE(SUM(LENGTH(message)), 0) AS size FROM task_logs').get().size || 0);
  return { databaseBytes, logBytes, worktreeBytes: await directorySize(join(dirname(root), `${basename(root)}.aod-worktrees`)), warning: databaseBytes > 200 * 1024 * 1024 || logBytes > 100 * 1024 * 1024 };
}
async function backupDatabase() {
  const backupDir = join(aodDir, 'backups');
  await mkdir(backupDir, { recursive: true });
  const destination = join(backupDir, `aod-${now().replace(/[:.]/g, '-')}.db`);
  await backup(db, destination);
  setSetting('last_backup_at', now());
  const files = (await readdir(backupDir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.db')).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of files.slice(0, -7)) await rm(join(backupDir, entry.name), { force: true });
  appendEvent('maintenance', `SQLite backup created: ${basename(destination)}`);
  return destination;
}
async function cleanupTerminalWorktrees() {
  const hours = Math.max(1, Number(getSetting('worktree_retention_hours') || 72));
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const cleaned = [];
  for (const task of listTasks()) {
    if (!['merged', 'cancelled', 'failed'].includes(task.status) || task.locked || !task.worktree || Date.parse(task.updated_at) > cutoff) continue;
    try {
      await git(['worktree', 'remove', '--force', task.worktree]);
      try { await git(['branch', '-D', task.branch]); } catch {}
      updateTask(task.id, { worktree: null });
      cleaned.push(task.id);
    } catch (error) { appendEvent('maintenance', `${task.id} cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`, task.id); }
  }
  if (cleaned.length) appendEvent('maintenance', `Cleaned worktrees: ${cleaned.join(', ')}`);
  return cleaned;
}

function currentApprovals() {
  return buildApprovalInbox({ tasks: listTasks(), runs: listRuns(), reviews: listReviews(), groupSessions: listGroupSessions() });
}

async function executeApprovalAction(payload) {
  if (typeof payload.id !== 'string' || typeof payload.action !== 'string') throw new Error('Approval id and action are required.');
  const item = currentApprovals().find(approvalItem => approvalItem.id === payload.id);
  if (!item || !item.actions.includes(payload.action)) throw new Error('Approval is no longer pending or does not allow this action.');
  const actionPayload = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
  if (payload.action === 'prepare') return prepareTask(requireTask(item.entityId), 'approval');
  if (payload.action === 'start') return startTask(requireTask(item.entityId), 'approval');
  if (payload.action === 'verify') return verifyTask(requireTask(item.entityId), 'approval');
  if (payload.action === 'merge') return mergeTask(requireTask(item.entityId), 'approval');
  if (payload.action === 'review') return startReview(requireTask(item.entityId));
  if (payload.action === 'start_group') return startGroupDiscussion(requireGroupSession(item.entityId));
  if (payload.action === 'publish') return publishRun(requireRun(item.entityId), actionPayload);
  throw new Error('This approval must be completed in its detailed view.');
}

function publicState() {
  const tasks = listTasks();
  const runs = listRuns();
  const groups = listGroups();
  const reviews = listReviews();
  const groupSessions = listGroupSessions().map(session => ({
    id: session.id, group_id: session.group_id, requirement: session.requirement, status: session.status,
    current_round: session.current_round, max_rounds: session.max_rounds, max_repairs: session.max_repairs,
    member_count: session.members.length, title: session.consensus?.title || null, run_id: session.run_id,
    recovery_note: session.recovery_note, created_at: session.created_at, updated_at: session.updated_at
  }));
  return {
    workspace: basename(root), mode: currentMode(), maxConcurrency: maxConcurrency(), integrationBranch: getSetting('integration_branch'),
    agents, agentHealth: listAgentHealth(), approvals: buildApprovalInbox({ tasks, runs, reviews, groupSessions }), statuses, transitions, tasks, runs, groups, groupSessions, reviews,
    events: db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 120').all(),
    runtime: {
      activeAgents: currentProcessCount(), activeReviews: reviewProcesses.size, activeGroupTurns: groupProcesses.size,
      activeRoleProcesses: roleProcesses.size, activePlanners: plannerProcesses.size,
      recoveryRequired: tasks.filter(task => task.status === 'recovery_required').length + groupSessions.filter(session => session.status === 'recovery_required').length,
      processes: listAgentProcesses({ limit: 20 })
    },
    stats: { total: tasks.length, runs: runs.length, groups: groups.length, groupSessions: groupSessions.length, worktrees: tasks.filter(task => task.worktree).length, mergeReady: tasks.filter(task => task.status === 'merge_ready').length, conflicts: tasks.filter(task => task.status === 'conflict_review').length }
  };
}

function send(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function body(request) { let data = ''; for await (const chunk of request) data += chunk; if (!data) return {}; try { return JSON.parse(data); } catch { throw new Error('Request body must be JSON.'); } }

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true, gitReady: await gitReady(), workspace: root, database: databasePath, metrics: await healthMetrics(), lastBackupAt: getSetting('last_backup_at') });
  if (request.method === 'GET' && url.pathname === '/api/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const after = Math.max(0, Number(url.searchParams.get('after') || request.headers['last-event-id'] || 0) || 0);
    for (const event of streamReplay) if (event.id > after) response.write(event.data);
    response.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    eventStreams.add(response);
    const keepAlive = setInterval(() => response.write(': keepalive\n\n'), 20000);
    request.on('close', () => { clearInterval(keepAlive); eventStreams.delete(response); });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, publicState());
  if (request.method === 'GET' && url.pathname === '/api/processes') return send(response, 200, listAgentProcesses({ limit: url.searchParams.get('limit'), runId: url.searchParams.get('runId') }));
  if (request.method === 'GET' && url.pathname === '/api/github/status') return send(response, 200, await githubStatus());
  if (request.method === 'GET' && url.pathname === '/api/approvals') return send(response, 200, currentApprovals());
  if (request.method === 'POST' && url.pathname === '/api/approvals/action') return send(response, 200, await executeApprovalAction(await body(request)));
  if (request.method === 'GET' && url.pathname === '/api/agents/health') return send(response, 200, listAgentHealth());
  const agentHealthMatch = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/check$/i);
  if (agentHealthMatch && request.method === 'POST') return send(response, 200, await checkAgentHealth(agentHealthMatch[1]));
  if (url.pathname === '/api/groups') {
    if (request.method === 'GET') return send(response, 200, listGroups());
    if (request.method === 'POST') return send(response, 201, createGroup(await body(request)));
  }
  const groupSessionCreateMatch = url.pathname.match(/^\/api\/groups\/(G-\d+)\/sessions$/);
  if (groupSessionCreateMatch && request.method === 'POST') return send(response, 201, createGroupSession(requireGroup(groupSessionCreateMatch[1]), await body(request)));
  const groupArchiveMatch = url.pathname.match(/^\/api\/groups\/(G-\d+)\/archive$/);
  if (groupArchiveMatch && request.method === 'POST') return send(response, 200, archiveGroup(requireGroup(groupArchiveMatch[1])));
  const groupMatch = url.pathname.match(/^\/api\/groups\/(G-\d+)$/);
  if (groupMatch && request.method === 'GET') return send(response, 200, requireGroup(groupMatch[1]));
  if (groupMatch && request.method === 'PATCH') return send(response, 200, patchGroup(requireGroup(groupMatch[1]), await body(request)));
  const groupSessionMatch = url.pathname.match(/^\/api\/group-sessions\/(GS-\d+)(?:\/(start|pause|resume|cancel|messages|confirm))?$/);
  if (groupSessionMatch) {
    const [, id, action] = groupSessionMatch;
    const session = requireGroupSession(id);
    if (request.method === 'GET' && !action) return send(response, 200, session);
    if (request.method === 'GET' && action === 'messages') {
      const after = Math.max(0, Number(url.searchParams.get('after') || 0));
      return send(response, 200, db.prepare('SELECT * FROM group_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT 500').all(id, after));
    }
    if (request.method === 'POST' && action === 'start') {
      if (session.status !== 'draft') throw new Error('Only a draft group session can start discussion.');
      return send(response, 202, startGroupDiscussion(session));
    }
    if (request.method === 'POST' && action === 'resume') return send(response, 202, resumeGroupSession(session));
    if (request.method === 'POST' && action === 'confirm') return send(response, 201, await confirmGroupConsensus(session, await body(request)));
    if (request.method === 'POST' && action === 'pause') {
      if (!['discussing', 'synthesizing'].includes(session.status)) throw new Error('Only an active session can be paused.');
      return send(response, 200, updateGroupSession(id, { pause_requested: true }));
    }
    if (request.method === 'POST' && action === 'cancel') {
      return send(response, 200, cancelGroupSession(session));
    }
    if (request.method === 'POST' && action === 'messages') {
      const payload = await body(request);
      if (typeof payload.content !== 'string' || !payload.content.trim()) throw new Error('Operator message cannot be empty.');
      if (['cancelled', 'completed', 'failed'].includes(session.status)) throw new Error('This session no longer accepts messages.');
      const messageId = appendGroupMessage(id, { round: session.current_round, senderKind: 'operator', phase: 'operator_note', content: payload.content.trim() });
      return send(response, 201, db.prepare('SELECT * FROM group_messages WHERE id = ?').get(messageId));
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/github/connect') {
    if (!(await commandAvailable('gh'))) return send(response, 409, { error: 'GitHub CLI is not installed. Install gh, then retry.' });
    if (await githubAuthenticated()) return send(response, 200, { authenticated: true, ...(await githubStatus()) });
    return send(response, 202, startGithubLogin());
  }
  if (request.method === 'POST' && url.pathname === '/api/maintenance/backup') return send(response, 201, { path: await backupDatabase() });
  if (request.method === 'POST' && url.pathname === '/api/maintenance/cleanup') return send(response, 200, { cleaned: await cleanupTerminalWorktrees() });
  if (request.method === 'POST' && url.pathname === '/api/runs/plan') {
    const payload = await body(request);
    if (typeof payload.requirement !== 'string' || !payload.requirement.trim()) throw new Error('A natural-language requirement is required.');
    const planner = payload.planner || 'codex';
    if (!agents.includes(planner)) throw new Error('Unsupported planner agent.');
    const createdAt = now();
    const id = `PLAN-${Date.now().toString(36).toUpperCase()}`;
    const plan = await planWithCodex(payload.requirement.trim(), planner);
    db.prepare('INSERT INTO plans(id, requirement, planner, dag_json, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, payload.requirement.trim(), planner, JSON.stringify(plan), 'ready', null, createdAt, createdAt);
    appendEvent('plan', `${id} generated by ${planner}`);
    return send(response, 201, { id, requirement: payload.requirement.trim(), planner, status: 'ready', ...plan });
  }
  if (request.method === 'POST' && url.pathname === '/api/runs') {
    const payload = await body(request);
    if (!payload.planId) throw new Error('A planId is required to create a run.');
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(payload.planId);
    if (!plan || plan.status !== 'ready') throw new Error('Plan is not available for confirmation.');
    const run = await createRunFromPlan(plan, { title: payload.title, tasks: payload.tasks });
    return send(response, 201, { ...run, tasks: runTasks(run.id) });
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/(RUN-[\w-]+)(?:\/(publish|refresh))?$/);
  if (runMatch) {
    const [, id, action] = runMatch;
    const run = requireRun(id);
    if (request.method === 'GET' && !action) return send(response, 200, { ...run, tasks: runTasks(id), events: db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY at DESC').all() });
    if (request.method === 'POST' && action === 'publish') return send(response, 200, await publishRun(run, await body(request)));
    if (request.method === 'POST' && action === 'refresh') return send(response, 200, await refreshRunCi(run));
  }
  const logMatch = url.pathname.match(/^\/api\/tasks\/(T-\d+)\/logs$/);
  if (logMatch && request.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return send(response, 200, db.prepare('SELECT * FROM task_logs WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT 500').all(logMatch[1], after));
  }
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    const payload = await body(request);
    if (payload.mode !== undefined) { if (!runtimeModes.includes(payload.mode)) throw new Error('Unsupported run mode.'); setSetting('run_mode', payload.mode); }
    if (payload.maxConcurrency !== undefined) { const value = Number(payload.maxConcurrency); if (!Number.isInteger(value) || value < 1 || value > 12) throw new Error('Max concurrency must be an integer between 1 and 12.'); setSetting('max_concurrency', value); }
    await scheduleAdvance();
    return send(response, 200, publicState());
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const payload = await body(request);
    if (typeof payload.title !== 'string' || !payload.title.trim()) throw new Error('Task title is required.');
    if (!agents.includes(payload.agent)) throw new Error('Choose a supported agent adapter.');
    const files = cleanPaths(payload.files);
    const tasks = listTasks();
    assertOwnershipAvailable(tasks, files);
    const id = nextTaskId();
    const task = {
      id, title: payload.title.trim(), agent: payload.agent, files, dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : [],
      acceptance: typeof payload.acceptance === 'string' ? payload.acceptance.trim() : '', status: 'draft', branch: `aod/${id.toLowerCase()}-${slug(payload.title)}`,
      worktree: null, run_id: null, base_commit: null, verified_commit: null, verification: null, output: '', process_pid: null,
      attempts: 0, max_retries: Math.max(0, Number(payload.maxRetries || 0)), timeout_ms: Math.max(1000, Number(payload.timeoutMs || 1800000)), locked: false, recovery_note: null, last_exit_code: null,
      created_at: now(), updated_at: now(), started_at: null, finished_at: null
    };
    validateGraph([...tasks, task]);
    db.prepare(`INSERT INTO tasks (id, title, agent, files_json, depends_json, acceptance, status, branch, worktree, run_id, base_commit, verified_commit, verification_json, output, process_pid, attempts, max_retries, timeout_ms, locked, recovery_note, last_exit_code, created_at, updated_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.title, task.agent, JSON.stringify(task.files), JSON.stringify(task.dependsOn), task.acceptance, task.status, task.branch, task.worktree, null, task.base_commit, task.verified_commit, null, task.output, null, task.attempts, task.max_retries, task.timeout_ms, 0, null, null, task.created_at, task.updated_at, null, null);
    appendEvent('task', `${id} created for ${task.agent}`, id);
    await scheduleAdvance();
    return send(response, 201, getTask(id));
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/(T-\d+)(?:\/(prepare|start|status|verify|merge|review))?$/);
  if (taskMatch && request.method === 'POST') {
    const [, id, action] = taskMatch;
    const task = requireTask(id);
    if (action === 'prepare') return send(response, 200, await prepareTask(task));
    if (action === 'start') return send(response, 200, await startTask(task));
    if (action === 'verify') return send(response, 200, await verifyTask(task));
    if (action === 'merge') return send(response, 200, await mergeTask(task));
    if (action === 'review') return send(response, 202, await startReview(task));
    if (action === 'status') {
      const payload = await body(request);
      if (!transitions[task.status]?.includes(payload.status)) throw new Error(`Cannot move ${id} from ${task.status} to ${payload.status}.`);
      const updated = updateTask(id, { status: payload.status, recovery_note: null });
      appendEvent('status', `${id} moved to ${payload.status}`, id);
      await scheduleAdvance();
      return send(response, 200, updated);
    }
  }
  const reviewMatch = url.pathname.match(/^\/api\/reviews\/(R-[\w-]+)\/approve$/);
  if (reviewMatch && request.method === 'POST') {
    const payload = await body(request);
    return send(response, 200, await approveReview(requireReview(reviewMatch[1]), payload.patch));
  }
  const groupTurnRecoveryMatch = url.pathname.match(/^\/api\/group-turns\/(GT-[\w-]+)\/recover$/);
  if (groupTurnRecoveryMatch && request.method === 'POST') return send(response, 202, await recoverGroupTurn(requireGroupTurn(groupTurnRecoveryMatch[1]), await body(request)));
  return send(response, 404, { error: 'Not found.' });
}

const mime = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const publicFiles = new Set([
  'index.html', 'styles.css', 'app.js',
  'styles/tokens.css', 'styles/shell.css', 'styles/components.css', 'styles/views.css',
  'ui/api.js', 'ui/state.js', 'ui/layout-state.js', 'ui/layout.js',
  'ui/run-center.js', 'ui/group-console.js', 'ui/dialogs.js'
]);
async function staticFile(response, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!publicFiles.has(file)) return send(response, 404, { error: 'Not found.' });
  const path = resolve(root, file);
  if (!(await exists(path))) return send(response, 404, { error: 'Not found.' });
  response.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' });
  response.end(await readFile(path));
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await api(request, response, url);
    else await staticFile(response, url.pathname);
  } catch (error) {
    send(response, 400, { error: error instanceof Error ? error.message : 'Unexpected error.' });
  }
}).listen(port, '127.0.0.1', () => console.log(`AOD console is available at http://127.0.0.1:${port}`));

setInterval(() => {
  Promise.all(listRuns().filter(run => run.status === 'published').map(refreshRunCi)).catch(() => {});
}, 30000).unref();
setInterval(() => {
  const last = Date.parse(getSetting('last_backup_at') || '');
  if (!last || Date.now() - last > 24 * 60 * 60 * 1000) backupDatabase().catch(() => {});
  cleanupTerminalWorktrees().catch(() => {});
}, 60 * 60 * 1000).unref();
