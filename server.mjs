import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.cwd());
const aodDir = join(root, '.aod');
const databasePath = join(aodDir, 'orchestrator.db');
const legacyStatePath = join(aodDir, 'state.json');
const handoffDir = join(aodDir, 'handoffs');
const configPath = join(root, '.aod.config.json');
const port = Number(process.env.PORT || 4821);
const agents = ['codex', 'claude-code', 'antigravity'];
const statuses = ['draft', 'preparing', 'ready', 'running', 'verifying', 'merge_ready', 'merging', 'conflict_review', 'recovery_required', 'failed', 'cancelled', 'merged'];
const transitions = {
  draft: ['preparing', 'cancelled'],
  preparing: ['ready', 'failed'],
  ready: ['running', 'cancelled'],
  running: ['verifying', 'failed'],
  verifying: ['failed'],
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
const eventStreams = new Set();
let advanceQueue = Promise.resolve();

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
`);

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
function requireTask(id) { const task = getTask(id); if (!task) throw new Error(`Task ${id} was not found.`); return task; }
function requireRun(id) { const run = getRun(id); if (!run) throw new Error(`Run ${id} was not found.`); return run; }
function requireReview(id) { const review = getReview(id); if (!review) throw new Error(`Review ${id} was not found.`); return review; }

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
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
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

function recoverInterruptedTasks() {
  const interrupted = db.prepare("SELECT id FROM tasks WHERE status IN ('preparing', 'running', 'verifying', 'merging')").all();
  for (const row of interrupted) {
    const task = requireTask(row.id);
    updateTask(task.id, { status: 'recovery_required', process_pid: null, recovery_note: 'Daemon restarted while work was in progress.' });
    appendEvent('recovery', `${task.id} requires operator confirmation after daemon restart`, task.id);
  }
  const interruptedReviews = db.prepare("SELECT id, task_id FROM reviews WHERE status = 'running'").all();
  for (const review of interruptedReviews) {
    db.prepare('UPDATE reviews SET status = ?, updated_at = ? WHERE id = ?').run('pending', now(), review.id);
    appendEvent('recovery', `${review.id} reviewer process was interrupted and can be retried`, review.task_id);
  }
}

importLegacyState();
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
function expand(value, task, prompt) {
  return String(value).replaceAll('{{taskId}}', task.id).replaceAll('{{worktree}}', task.worktree || '').replaceAll('{{promptFile}}', join(handoffDir, `${task.id}.md`)).replaceAll('{{prompt}}', prompt);
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

function currentProcessCount() { return taskProcesses.size; }
async function startTask(task, source = 'manual') {
  if (task.status !== 'ready') throw new Error('Only prepared tasks can start an agent process.');
  if (!task.worktree || !(await exists(task.worktree))) throw new Error('This task has no prepared worktree.');
  if (task.locked) throw new Error('This task is locked for conflict review.');
  if (taskProcesses.has(task.id)) throw new Error('An agent process is already attached to this task.');
  if (currentProcessCount() >= maxConcurrency()) throw new Error(`Concurrency limit of ${maxConcurrency()} is reached.`);
  const config = await loadConfig();
  const adapter = config.agents[task.agent];
  if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new Error(`No ${task.agent} adapter is configured.`);
  const promptPath = join(handoffDir, `${task.id}.md`);
  if (!(await exists(promptPath))) throw new Error('The task handoff file is missing. Prepare the worktree again.');
  const prompt = await readFile(promptPath, 'utf8');
  const args = adapter.args.map(value => expand(value, task, prompt));
  const timeoutMs = Math.max(1000, Number(adapter.timeoutMs || config.defaults.agentTimeoutMs || task.timeout_ms));
  const maxRetries = Math.max(0, Number(adapter.maxRetries ?? config.defaults.maxRetries ?? task.max_retries));
  task = updateTask(task.id, { status: 'running', output: '', process_pid: null, attempts: task.attempts + 1, max_retries: maxRetries, timeout_ms: timeoutMs, started_at: now(), finished_at: null, recovery_note: null });
  appendEvent('agent', `${task.id} started ${task.agent} (${source})`, task.id);
  const child = spawn(adapter.command, args, { cwd: task.worktree, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AOD_TASK_ID: task.id, AOD_WORKTREE: task.worktree } });
  const timer = setTimeout(() => { const entry = taskProcesses.get(task.id); if (entry) entry.timedOut = true; child.kill(); }, timeoutMs);
  taskProcesses.set(task.id, { child, timer, timedOut: false });
  updateTask(task.id, { process_pid: child.pid || null });
  child.stdin.end(adapter.stdin === undefined ? undefined : expand(adapter.stdin, task, prompt));
  child.stdout.on('data', data => { try { appendOutput(task.id, data.toString(), 'stdout'); } catch {} });
  child.stderr.on('data', data => { try { appendOutput(task.id, data.toString(), 'stderr'); } catch {} });
  child.once('error', error => finishTaskProcess(task.id, child, { ok: false, error, code: null }).catch(() => {}));
  child.once('close', code => finishTaskProcess(task.id, child, { ok: code === 0, code }).catch(() => {}));
  return getTask(task.id);
}

async function finishTaskProcess(id, child, outcome) {
  const entry = taskProcesses.get(id);
  if (!entry || entry.child !== child) return;
  clearTimeout(entry.timer);
  taskProcesses.delete(id);
  const task = requireTask(id);
  if (task.status !== 'running') return;
  const errorText = entry.timedOut ? `Agent timed out after ${task.timeout_ms}ms.` : outcome.error?.message;
  if (outcome.ok) {
    updateTask(id, { status: 'verifying', process_pid: null, last_exit_code: outcome.code, finished_at: now() });
    appendEvent('agent', `${id} exited successfully; awaiting verification`, id);
  } else if (currentMode() === 'auto' && task.attempts <= task.max_retries) {
    updateTask(id, { status: 'ready', process_pid: null, last_exit_code: outcome.code, recovery_note: errorText || 'Agent exited unsuccessfully.' });
    appendEvent('retry', `${id} will retry automatically (${task.attempts}/${task.max_retries})`, id);
  } else {
    updateTask(id, { status: 'failed', process_pid: null, last_exit_code: outcome.code, finished_at: now(), recovery_note: errorText || 'Agent exited unsuccessfully.' });
    appendEvent('agent', `${id} agent process failed`, id);
  }
  scheduleAdvance();
}

async function verifyTask(task, source = 'manual') {
  if (task.status !== 'verifying') throw new Error('Only tasks in verification can run acceptance checks.');
  if (!task.worktree || !(await exists(task.worktree))) throw new Error('This task has no prepared worktree.');
  if (!task.acceptance) throw new Error('Add an acceptance command before verification.');
  const commit = (await git(['rev-parse', 'HEAD'], task.worktree)).stdout.trim();
  try {
    const result = await runShell(task.acceptance, task.worktree, task.timeout_ms);
    updateTask(task.id, { status: 'merge_ready', verified_commit: commit, verification: { at: now(), command: task.acceptance, output: redactSecrets(`${result.stdout}${result.stderr}`).slice(-8000), commit }, recovery_note: null });
    appendEvent('verify', `${task.id} acceptance check passed (${source})`, task.id);
    return getTask(task.id);
  } catch (error) {
    updateTask(task.id, { status: 'failed', verification: { at: now(), command: task.acceptance, output: redactSecrets(error instanceof Error ? error.message : 'Verification failed.'), commit }, recovery_note: 'Acceptance failed.' });
    appendEvent('verify', `${task.id} acceptance check failed`, task.id);
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
      appendEvent('run', `${run.id} is ready to publish`, null, run.id);
    }
    await scheduleAdvance();
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
  const config = await loadConfig();
  const agent = config.reviewerAgent || review.reviewer_agent;
  const adapter = config.agents[agent];
  if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) throw new Error(`No reviewer adapter is configured for ${agent}.`);
  const prompt = [
    'You are a read-only merge conflict reviewer. Do not modify files or run write commands.',
    `Task: ${task.id} ${task.title}`, `Worktree: ${task.worktree}`, 'Conflicted files:', ...review.conflictFiles.map(file => `- ${file}`),
    '', 'Return a concise rationale and one optional unified diff patch in a ```diff code fence. The operator will review and apply it manually.', '', review.conflict_diff
  ].join('\n');
  const child = spawn(adapter.command, adapter.args.map(value => expand(value, task, prompt)), { cwd: task.worktree, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const timeoutMs = Number(adapter.timeoutMs || config.defaults?.reviewTimeoutMs || 600000);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  reviewProcesses.set(review.id, { child, timer });
  db.prepare('UPDATE reviews SET status = ?, reviewer_agent = ?, updated_at = ? WHERE id = ?').run('running', agent, now(), review.id);
  appendEvent('review', `${review.id} reviewer agent started`, task.id);
  child.stdin.end(adapter.stdin === undefined ? undefined : expand(adapter.stdin, task, prompt));
  child.stdout.on('data', data => { output = `${output}${data}`.slice(-24000); });
  child.stderr.on('data', data => { output = `${output}${data}`.slice(-24000); });
  const finish = (status) => {
    const active = reviewProcesses.get(review.id); if (!active || active.child !== child) return;
    clearTimeout(active.timer); reviewProcesses.delete(review.id);
    db.prepare('UPDATE reviews SET status = ?, suggestion = ?, updated_at = ? WHERE id = ?').run(status, output, now(), review.id);
    appendEvent('review', `${review.id} reviewer ${status}`, task.id);
  };
  child.once('error', () => finish('failed'));
  child.once('close', code => finish(code === 0 ? 'suggested' : 'failed'));
  return reviewFromRow(db.prepare('SELECT * FROM reviews WHERE id = ?').get(review.id));
}

async function approveReview(review, patch) {
  if (review.status !== 'suggested') throw new Error('Only a completed reviewer suggestion can be approved.');
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('Paste the reviewed unified diff before approving it.');
  const task = requireTask(review.task_id);
  if (task.status !== 'conflict_review' || !task.worktree) throw new Error('Task is not available for conflict resolution.');
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
      try {
        if (task.status === 'draft' && dependenciesComplete(task)) await prepareTask(task, mode);
        else if (task.status === 'ready' && mode === 'auto') await startTask(task, mode);
        else if (task.status === 'verifying') await verifyTask(task, mode);
        else if (task.status === 'merge_ready' && mode === 'auto') await mergeTask(task, mode);
      } catch (error) {
        appendEvent('automation', `${task.id}: ${error instanceof Error ? error.message : 'automatic step failed'}`, task.id);
      }
    }
  });
  return advanceQueue;
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
  const result = await new Promise((resolvePlan, rejectPlan) => {
    const child = spawn(adapter.command, args, { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); rejectPlan(new Error(`Planner timed out after ${timeoutMs}ms.`)); }, timeoutMs);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.stdin.end(adapter.stdin === undefined ? undefined : String(adapter.stdin).replaceAll('{{prompt}}', prompt));
    child.on('error', error => { clearTimeout(timer); rejectPlan(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolvePlan(output) : rejectPlan(new Error(output.trim() || `Planner exited with ${code}.`)); });
  });
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
  return { available: await commandAvailable('gh'), authenticated, remote };
}
async function commandAvailable(command) {
  try { await run(command === 'gh' ? ghExecutable() : command, ['--version'], root, 8000); return true; } catch { return false; }
}
function startGithubLogin() {
  const child = spawn(ghExecutable(), ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { cwd: root, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = `${output}${data}`.slice(-4000); appendEvent('github', redactSecrets(data), null, null); });
  child.stderr.on('data', data => { output = `${output}${data}`.slice(-4000); appendEvent('github', redactSecrets(data), null, null); });
  child.once('close', code => appendEvent('github', code === 0 ? 'GitHub authentication completed' : `GitHub authentication ended with ${code}: ${output.trim()}`, null, null));
  return { started: true, message: 'GitHub device authentication started. Complete it in the opened browser or terminal window.' };
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

function publicState() {
  const tasks = listTasks();
  const runs = listRuns();
  return {
    workspace: basename(root), mode: currentMode(), maxConcurrency: maxConcurrency(), integrationBranch: getSetting('integration_branch'),
    agents, statuses, transitions, tasks, runs, reviews: listReviews(),
    events: db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 120').all(),
    runtime: { activeAgents: currentProcessCount(), activeReviews: reviewProcesses.size, recoveryRequired: tasks.filter(task => task.status === 'recovery_required').length },
    stats: { total: tasks.length, runs: runs.length, worktrees: tasks.filter(task => task.worktree).length, mergeReady: tasks.filter(task => task.status === 'merge_ready').length, conflicts: tasks.filter(task => task.status === 'conflict_review').length }
  };
}

function send(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function body(request) { let data = ''; for await (const chunk of request) data += chunk; if (!data) return {}; try { return JSON.parse(data); } catch { throw new Error('Request body must be JSON.'); } }

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true, gitReady: await gitReady(), workspace: root, database: databasePath, metrics: await healthMetrics(), lastBackupAt: getSetting('last_backup_at') });
  if (request.method === 'GET' && url.pathname === '/api/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    eventStreams.add(response);
    const keepAlive = setInterval(() => response.write(': keepalive\n\n'), 20000);
    request.on('close', () => { clearInterval(keepAlive); eventStreams.delete(response); });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, publicState());
  if (request.method === 'GET' && url.pathname === '/api/github/status') return send(response, 200, await githubStatus());
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
  return send(response, 404, { error: 'Not found.' });
}

const mime = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
async function staticFile(response, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'styles.css', 'app.js'].includes(file)) return send(response, 404, { error: 'Not found.' });
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
