import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
`);

setDefault('run_mode', 'hybrid');
setDefault('max_concurrency', '3');
setDefault('integration_branch', 'main');

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

function reviewFromRow(row) {
  if (!row) return null;
  return { ...row, conflictFiles: json(row.conflict_files_json, []) };
}

function listTasks() { return db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all().map(taskFromRow); }
function getTask(id) { return taskFromRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)); }
function getReview(id) { return reviewFromRow(db.prepare('SELECT * FROM reviews WHERE id = ?').get(id)); }
function listReviews() { return db.prepare('SELECT * FROM reviews ORDER BY created_at DESC').all().map(reviewFromRow); }
function requireTask(id) { const task = getTask(id); if (!task) throw new Error(`Task ${id} was not found.`); return task; }
function requireReview(id) { const review = getReview(id); if (!review) throw new Error(`Review ${id} was not found.`); return review; }

function saveTask(task) {
  task.updated_at = now();
  db.prepare(`UPDATE tasks SET
    title = ?, agent = ?, files_json = ?, depends_json = ?, acceptance = ?, status = ?, branch = ?, worktree = ?,
    base_commit = ?, verified_commit = ?, verification_json = ?, output = ?, process_pid = ?, attempts = ?,
    max_retries = ?, timeout_ms = ?, locked = ?, recovery_note = ?, last_exit_code = ?, updated_at = ?, started_at = ?, finished_at = ?
    WHERE id = ?`).run(
    task.title, task.agent, JSON.stringify(task.files), JSON.stringify(task.dependsOn), task.acceptance, task.status, task.branch,
    task.worktree, task.base_commit, task.verified_commit, task.verification ? JSON.stringify(task.verification) : null,
    task.output || '', task.process_pid, task.attempts, task.max_retries, task.timeout_ms, task.locked ? 1 : 0,
    task.recovery_note, task.last_exit_code, task.updated_at, task.started_at, task.finished_at, task.id
  );
  return task;
}

function updateTask(id, fields) { return saveTask({ ...requireTask(id), ...fields }); }

function appendEvent(type, message, taskId = null) {
  db.prepare('INSERT INTO events(id, at, type, message, task_id) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), now(), type, message, taskId);
}

function appendOutput(taskId, chunk) {
  const task = requireTask(taskId);
  updateTask(taskId, { output: `${task.output || ''}${chunk}`.slice(-16000) });
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
async function gitClean() { return (await git(['status', '--porcelain'])).stdout.trim() === ''; }

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
  updateTask(task.id, { status: 'preparing' });
  const area = join(dirname(root), `${basename(root)}.aod-worktrees`);
  const location = join(area, task.id);
  try {
    await mkdir(area, { recursive: true });
    if (await exists(location)) {
      try { await git(['worktree', 'remove', '--force', location]); } catch { await rm(location, { recursive: true, force: true }); }
    }
    await git(['worktree', 'add', '-b', task.branch, location, 'HEAD']);
    const prepared = updateTask(task.id, { status: 'ready', worktree: location, base_commit: (await git(['rev-parse', 'HEAD'])).stdout.trim(), recovery_note: null });
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
  child.stdout.on('data', data => { try { appendOutput(task.id, data.toString()); } catch {} });
  child.stderr.on('data', data => { try { appendOutput(task.id, data.toString()); } catch {} });
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
    updateTask(task.id, { status: 'merge_ready', verified_commit: commit, verification: { at: now(), command: task.acceptance, output: `${result.stdout}${result.stderr}`.slice(-8000), commit }, recovery_note: null });
    appendEvent('verify', `${task.id} acceptance check passed (${source})`, task.id);
    return getTask(task.id);
  } catch (error) {
    updateTask(task.id, { status: 'failed', verification: { at: now(), command: task.acceptance, output: error instanceof Error ? error.message : 'Verification failed.', commit }, recovery_note: 'Acceptance failed.' });
    appendEvent('verify', `${task.id} acceptance check failed`, task.id);
    throw error;
  }
}

async function createConflictReview(task, error) {
  const files = (await git(['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split(/\r?\n/).filter(Boolean);
  const diff = (await git(['diff', '--no-ext-diff'])).stdout.slice(-24000);
  try { await git(['merge', '--abort']); } catch {}
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
  const branch = getSetting('integration_branch') || 'main';
  const currentBranch = (await git(['branch', '--show-current'])).stdout.trim();
  if (currentBranch !== branch) throw new Error(`Merge must run from ${branch}, currently on ${currentBranch || 'detached HEAD'}.`);
  if (!(await gitClean())) throw new Error('Integration branch has uncommitted changes. Commit or stash them before merging.');
  const branchHead = (await git(['rev-parse', task.branch])).stdout.trim();
  if (task.verified_commit !== branchHead) throw new Error('Task branch changed after verification. Run verification again.');
  const ahead = Number((await git(['rev-list', '--count', `HEAD..${task.branch}`])).stdout.trim());
  if (ahead < 1) throw new Error('The task branch has no commits to merge.');
  updateTask(task.id, { status: 'merging' });
  try {
    await git(['merge', '--no-ff', task.branch, '-m', `merge: ${task.id} ${task.title}`]);
    updateTask(task.id, { status: 'merged', locked: false, finished_at: now(), recovery_note: null });
    appendEvent('merge', `${task.id} merged into ${branch} (${source})`, task.id);
    await scheduleAdvance();
    return getTask(task.id);
  } catch (error) {
    if (await createConflictReview(task, error instanceof Error ? error : new Error('Merge failed.'))) return getTask(task.id);
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

function publicState() {
  const tasks = listTasks();
  return {
    workspace: basename(root), mode: currentMode(), maxConcurrency: maxConcurrency(), integrationBranch: getSetting('integration_branch'),
    agents, statuses, transitions, tasks, reviews: listReviews(),
    events: db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 120').all(),
    runtime: { activeAgents: currentProcessCount(), activeReviews: reviewProcesses.size, recoveryRequired: tasks.filter(task => task.status === 'recovery_required').length },
    stats: { total: tasks.length, worktrees: tasks.filter(task => task.worktree).length, mergeReady: tasks.filter(task => task.status === 'merge_ready').length, conflicts: tasks.filter(task => task.status === 'conflict_review').length }
  };
}

function send(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function body(request) { let data = ''; for await (const chunk of request) data += chunk; if (!data) return {}; try { return JSON.parse(data); } catch { throw new Error('Request body must be JSON.'); } }

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true, gitReady: await gitReady(), workspace: root, database: databasePath });
  if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, publicState());
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
    const index = Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count) + 1;
    const id = `T-${String(index).padStart(3, '0')}`;
    const task = {
      id, title: payload.title.trim(), agent: payload.agent, files, dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : [],
      acceptance: typeof payload.acceptance === 'string' ? payload.acceptance.trim() : '', status: 'draft', branch: `aod/${id.toLowerCase()}-${slug(payload.title)}`,
      worktree: null, base_commit: null, verified_commit: null, verification: null, output: '', process_pid: null,
      attempts: 0, max_retries: Math.max(0, Number(payload.maxRetries || 0)), timeout_ms: Math.max(1000, Number(payload.timeoutMs || 1800000)), locked: false, recovery_note: null, last_exit_code: null,
      created_at: now(), updated_at: now(), started_at: null, finished_at: null
    };
    validateGraph([...tasks, task]);
    db.prepare(`INSERT INTO tasks (id, title, agent, files_json, depends_json, acceptance, status, branch, worktree, base_commit, verified_commit, verification_json, output, process_pid, attempts, max_retries, timeout_ms, locked, recovery_note, last_exit_code, created_at, updated_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.title, task.agent, JSON.stringify(task.files), JSON.stringify(task.dependsOn), task.acceptance, task.status, task.branch, task.worktree, task.base_commit, task.verified_commit, null, task.output, null, task.attempts, task.max_retries, task.timeout_ms, 0, null, null, task.created_at, task.updated_at, null, null);
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
