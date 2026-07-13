import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.cwd());
const aodDir = join(root, '.aod');
const statePath = join(aodDir, 'state.json');
const handoffDir = join(aodDir, 'handoffs');
const configPath = join(root, '.aod.config.json');
const port = Number(process.env.PORT || 4821);
const agents = ['codex', 'claude-code', 'antigravity'];
const processes = new Map();
const transitions = {
  draft: ['preparing', 'cancelled'],
  preparing: ['ready', 'failed'],
  ready: ['running', 'cancelled'],
  running: ['verifying', 'failed'],
  verifying: ['failed'],
  merge_ready: ['failed'],
  failed: ['ready', 'cancelled'],
  merged: [],
  cancelled: []
};

function initialState() {
  return {
    version: 1,
    workspace: basename(root),
    createdAt: new Date().toISOString(),
    tasks: [],
    events: []
  };
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function loadState() {
  await mkdir(aodDir, { recursive: true });
  if (!(await exists(statePath))) return initialState();
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch { throw new Error('The AOD state file is not valid JSON.'); }
}

async function loadConfig() {
  if (!(await exists(configPath))) return { agents: {} };
  try { return JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('The AOD adapter config is not valid JSON.'); }
}

async function saveState(state) {
  await mkdir(aodDir, { recursive: true });
  const temp = `${statePath}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, statePath);
}

function appendEvent(state, type, message, taskId) {
  state.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), type, message, taskId });
  state.events = state.events.slice(0, 80);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 36) || 'task';
}

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
  const a = left.replaceAll('\\', '/').replace(/\/$/, '');
  const b = right.replaceAll('\\', '/').replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function assertOwnershipAvailable(tasks, files) {
  const activeTasks = tasks.filter(task => !['merged', 'cancelled', 'failed'].includes(task.status));
  for (const task of activeTasks) {
    for (const existing of task.files) {
      for (const requested of files) {
        if (pathsOverlap(existing, requested)) {
          throw new Error(`Ownership conflict: ${requested} overlaps with ${task.id} (${existing}).`);
        }
      }
    }
  }
}

function validateGraph(tasks) {
  const ids = new Set(tasks.map(task => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency}.`);
      if (dependency === task.id) throw new Error('A task cannot depend on itself.');
    }
  }
  const visited = new Set();
  const active = new Set();
  const visit = id => {
    if (active.has(id)) throw new Error('Task dependencies contain a cycle.');
    if (visited.has(id)) return;
    active.add(id);
    const task = tasks.find(item => item.id === id);
    task.dependsOn.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  tasks.forEach(task => visit(task.id));
}

function dependenciesComplete(state, task) {
  return task.dependsOn.every(id => state.tasks.find(item => item.id === id)?.status === 'merged');
}

function run(command, args, cwd = root) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', rejectRun);
    child.on('close', code => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

function runShell(command, cwd) {
  // Acceptance commands are defined by the task author and run only in its isolated worktree.
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', rejectRun);
    child.on('close', code => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(stderr.trim() || stdout.trim() || `Verification exited with ${code}`)));
  });
}

async function git(args, cwd = root) { return run('git', args, cwd); }

async function gitReady() {
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    await git(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch { return false; }
}

function taskById(state, id) {
  const task = state.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} was not found.`);
  return task;
}

function expandArgument(value, task) {
  return value.replaceAll('{{taskId}}', task.id)
    .replaceAll('{{worktree}}', task.worktree)
    .replaceAll('{{promptFile}}', join(handoffDir, `${task.id}.md`));
}

async function appendOutput(id, chunk) {
  const state = await loadState();
  const task = taskById(state, id);
  task.output = `${task.output || ''}${chunk}`.slice(-12000);
  task.updatedAt = new Date().toISOString();
  await saveState(state);
}

async function finishProcess(id, child, outcome) {
  if (processes.get(id) !== child) return;
  processes.delete(id);
  const state = await loadState();
  const task = taskById(state, id);
  if (task.status !== 'running') return;
  task.status = outcome.ok ? 'verifying' : 'failed';
  task.updatedAt = new Date().toISOString();
  appendEvent(state, 'agent', outcome.ok ? `${id} agent exited; awaiting verification` : `${id} agent process failed`, id);
  await saveState(state);
}

async function startAgent(state, task) {
  if (task.status !== 'ready') throw new Error('Only prepared tasks can start an agent process.');
  if (!task.worktree || !(await exists(task.worktree))) throw new Error('This task has no prepared worktree.');
  if (processes.has(task.id)) throw new Error('An agent process is already attached to this task.');
  const config = await loadConfig();
  const adapter = config.agents?.[task.agent];
  if (!adapter || typeof adapter.command !== 'string' || !Array.isArray(adapter.args)) {
    throw new Error(`No ${task.agent} adapter is configured. Add it to ${configPath}.`);
  }
  const args = adapter.args.map(value => {
    if (typeof value !== 'string') throw new Error('Adapter arguments must be strings.');
    return expandArgument(value, task);
  });
  task.status = 'running';
  task.output = '';
  task.startedAt = new Date().toISOString();
  task.updatedAt = task.startedAt;
  appendEvent(state, 'agent', `${task.id} started ${task.agent}`, task.id);
  await saveState(state);
  const child = spawn(adapter.command, args, {
    cwd: task.worktree,
    shell: false,
    windowsHide: true,
    env: { ...process.env, AOD_TASK_ID: task.id, AOD_WORKTREE: task.worktree }
  });
  processes.set(task.id, child);
  child.stdout.on('data', data => { appendOutput(task.id, data.toString()).catch(() => {}); });
  child.stderr.on('data', data => { appendOutput(task.id, data.toString()).catch(() => {}); });
  child.once('error', error => { finishProcess(task.id, child, { ok: false, error }).catch(() => {}); });
  child.once('close', code => { finishProcess(task.id, child, { ok: code === 0 }).catch(() => {}); });
}

async function prepareWorktree(state, task) {
  if (!dependenciesComplete(state, task) && task.dependsOn.length) throw new Error('Dependencies must be merged before preparing this task.');
  if (!(await gitReady())) throw new Error('This workspace needs an initialized Git repository with at least one commit.');
  const area = join(dirname(root), `${basename(root)}.aod-worktrees`);
  const location = join(area, task.id);
  await mkdir(area, { recursive: true });
  if (await exists(location)) {
    try { await git(['worktree', 'remove', '--force', location]); }
    catch { await rm(location, { recursive: true, force: true }); }
  }
  await git(['worktree', 'add', '-b', task.branch, location, 'HEAD']);
  task.worktree = location;
  task.status = 'ready';
  task.updatedAt = new Date().toISOString();
  await mkdir(handoffDir, { recursive: true });
  const handoff = [
    `# ${task.id}: ${task.title}`,
    '',
    `Agent: ${task.agent}`,
    `Branch: ${task.branch}`,
    `Worktree: ${location}`,
    '',
    '## Owned paths',
    ...task.files.map(file => `- ${file}`),
    '',
    '## Dependencies',
    task.dependsOn.length ? task.dependsOn.map(id => `- ${id}`).join('\n') : '- None',
    '',
    '## Acceptance command',
    task.acceptance || 'Not specified',
    '',
    'Commit changes in this branch. Do not modify paths outside the ownership list without creating a follow-up task.'
  ].join('\n');
  await writeFile(join(handoffDir, `${task.id}.md`), `${handoff}\n`, 'utf8');
  appendEvent(state, 'worktree', `${task.id} worktree prepared`, task.id);
}

function publicState(state) {
  return {
    ...state,
    repositoryReady: undefined,
    agents,
    transitions,
    paths: { root, state: statePath, handoffs: handoffDir }
  };
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let data = '';
  for await (const chunk of request) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw new Error('Request body must be JSON.'); }
}

async function api(request, response, url) {
  const state = await loadState();
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return send(response, 200, { ok: true, gitReady: await gitReady(), workspace: root });
  }
  if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, publicState(state));
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const payload = await body(request);
    if (typeof payload.title !== 'string' || !payload.title.trim()) throw new Error('Task title is required.');
    if (!agents.includes(payload.agent)) throw new Error('Choose a supported agent adapter.');
    const files = cleanPaths(payload.files);
    assertOwnershipAvailable(state.tasks, files);
    const id = `T-${String(state.tasks.length + 1).padStart(3, '0')}`;
    const task = {
      id,
      title: payload.title.trim(),
      agent: payload.agent,
      files,
      dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn : [],
      acceptance: typeof payload.acceptance === 'string' ? payload.acceptance.trim() : '',
      status: 'draft',
      branch: `aod/${id.toLowerCase()}-${slug(payload.title)}`,
      worktree: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.tasks.push(task);
    validateGraph(state.tasks);
    appendEvent(state, 'task', `${id} created for ${task.agent}`, id);
    await saveState(state);
    return send(response, 201, task);
  }
  const matched = url.pathname.match(/^\/api\/tasks\/(T-\d+)(?:\/(prepare|start|status|verify|merge))?$/);
  if (matched && request.method === 'POST') {
    const [, id, action] = matched;
    const task = taskById(state, id);
    if (action === 'prepare') {
      if (task.status !== 'draft') throw new Error('Only draft tasks can prepare a worktree.');
      task.status = 'preparing';
      await saveState(state);
      try { await prepareWorktree(state, task); }
      catch (error) {
        task.status = 'draft';
        task.updatedAt = new Date().toISOString();
        appendEvent(state, 'error', `${id} worktree preparation failed`, id);
        await saveState(state);
        throw error;
      }
      await saveState(state);
      return send(response, 200, task);
    }
    if (action === 'start') {
      await startAgent(state, task);
      return send(response, 200, task);
    }
    if (action === 'status') {
      const payload = await body(request);
      if (!transitions[task.status]?.includes(payload.status)) throw new Error(`Cannot move ${id} from ${task.status} to ${payload.status}.`);
      task.status = payload.status;
      task.updatedAt = new Date().toISOString();
      appendEvent(state, 'status', `${id} moved to ${payload.status}`, id);
      await saveState(state);
      return send(response, 200, task);
    }
    if (action === 'verify') {
      if (task.status !== 'verifying') throw new Error('Only tasks in verification can run acceptance checks.');
      if (!task.worktree || !(await exists(task.worktree))) throw new Error('This task has no prepared worktree.');
      if (!task.acceptance) throw new Error('Add an acceptance command before verification.');
      try {
        const result = await runShell(task.acceptance, task.worktree);
        task.status = 'merge_ready';
        task.verification = { at: new Date().toISOString(), command: task.acceptance, output: `${result.stdout}${result.stderr}`.slice(-8000) };
        task.updatedAt = new Date().toISOString();
        appendEvent(state, 'verify', `${id} acceptance check passed`, id);
        await saveState(state);
        return send(response, 200, task);
      } catch (error) {
        task.status = 'failed';
        task.verification = { at: new Date().toISOString(), command: task.acceptance, output: error instanceof Error ? error.message : 'Verification failed.' };
        task.updatedAt = new Date().toISOString();
        appendEvent(state, 'verify', `${id} acceptance check failed`, id);
        await saveState(state);
        throw error;
      }
    }
    if (action === 'merge') {
      if (task.status !== 'merge_ready') throw new Error('Only verified tasks can enter the merge gate.');
      if (!(await gitReady())) throw new Error('The main repository is not ready for merging.');
      const ahead = await git(['rev-list', '--count', `HEAD..${task.branch}`]);
      if (Number(ahead.stdout.trim()) < 1) throw new Error('The task branch has no commits to merge.');
      try {
        await git(['merge', '--no-ff', task.branch, '-m', `merge: ${task.id} ${task.title}`]);
        task.status = 'merged';
        task.updatedAt = new Date().toISOString();
        appendEvent(state, 'merge', `${id} merged into main`, id);
        await saveState(state);
        return send(response, 200, task);
      } catch (error) {
        task.status = 'failed';
        task.updatedAt = new Date().toISOString();
        appendEvent(state, 'merge', `${id} merge failed`, id);
        await saveState(state);
        throw error;
      }
    }
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
}).listen(port, '127.0.0.1', () => {
  console.log(`AOD console is available at http://127.0.0.1:${port}`);
});
