import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'aod-integration-'));
const port = 4928;
const files = ['.gitignore', 'server.mjs', 'app.js', 'index.html', 'styles.css', 'package.json', 'README.md', 'aod.config.example.json'];
for (const file of files) await cp(join(process.cwd(), file), join(fixture, file));

function run(command, args, cwd = fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `${command} exited with ${code}`)));
  });
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('Test daemon did not start.');
}
async function api(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}
async function readSseInitialState() {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  return new TextDecoder().decode(value);
}
async function waitForTaskStatus(id, expected) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await api('/api/state');
    const task = current.tasks.find(item => item.id === id);
    if (task?.status === expected) return task;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Task ${id} did not reach ${expected}.`);
}
async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return;
  const closed = new Promise(resolve => daemon.once('close', resolve));
  daemon.kill();
  await closed;
}

let daemon;
try {
  await run('git', ['init', '--initial-branch=main']);
  await run('git', ['add', '.']);
  await run('git', ['-c', 'user.name=AOD Test', '-c', 'user.email=aod@test.local', 'commit', '-m', 'fixture']);
  await writeFile(join(fixture, '.aod.config.json'), JSON.stringify({
    defaults: { maxRetries: 0 },
    planner: {
      command: process.execPath,
      args: ['-e', "console.log(JSON.stringify({title:'Planned run',tasks:[{key:'docs',title:'Create delivery note',agent:'codex',files:['delivery-note.md'],dependsOn:[],acceptance:'node --check server.mjs',risk:'none'}]}))"]
    },
    agents: {
      codex: { command: process.execPath, args: ['-e', "const fs=require('fs');const cp=require('child_process');if(process.env.AOD_TASK_ID!=='T-001'){fs.writeFileSync('delivery-note.md','run branch output\\n');cp.execFileSync('git',['add','delivery-note.md']);cp.execFileSync('git',['-c','user.name=AOD Agent','-c','user.email=aod@test.local','commit','-m','docs: add delivery note']);}console.log('fake agent complete')"] },
      'claude-code': { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1000)'], timeoutMs: 75 },
      antigravity: { command: process.execPath, args: ['-e', 'process.exit(7)'] }
    }
  }));
  daemon = spawn(process.execPath, ['server.mjs'], { cwd: fixture, env: { ...process.env, PORT: String(port) }, windowsHide: true });
  await waitForHealth();

  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'manual', maxConcurrency: 2 }) });
  const first = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Manual task', agent: 'codex', files: ['README.md'], acceptance: 'node --check server.mjs' }) });
  assert.equal(first.status, 'draft');

  const hybrid = await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'hybrid', maxConcurrency: 2 }) });
  assert.equal(hybrid.tasks.find(task => task.id === first.id).status, 'ready');
  await stat(hybrid.tasks.find(task => task.id === first.id).worktree);
  assert.equal(await stat(join(fixture, '.aod', 'orchestrator.db')).then(() => true), true);
  await api(`/api/tasks/${first.id}/start`, { method: 'POST', body: '{}' });
  assert.equal((await waitForTaskStatus(first.id, 'merge_ready')).last_exit_code, 0);
  assert.equal((await api(`/api/tasks/${first.id}/logs`)).length > 0, true);
  assert.equal((await readSseInitialState()).includes('event: state'), true);

  const second = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Recovery task', agent: 'claude-code', files: ['styles.css'], acceptance: 'node --check server.mjs' }) });
  assert.equal(second.status, 'ready');
  await api(`/api/tasks/${second.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'running' }) });
  await stopDaemon();
  daemon = spawn(process.execPath, ['server.mjs'], { cwd: fixture, env: { ...process.env, PORT: String(port) }, windowsHide: true });
  await waitForHealth();
  const recovered = await api('/api/state');
  assert.equal(recovered.tasks.find(task => task.id === second.id).status, 'recovery_required');
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'manual', maxConcurrency: 2 }) });

  const plan = await api('/api/runs/plan', { method: 'POST', body: JSON.stringify({ requirement: 'Create a delivery note', planner: 'codex' }) });
  assert.equal(plan.tasks.length, 1);
  const deliveryRun = await api('/api/runs', { method: 'POST', body: JSON.stringify({ planId: plan.id }) });
  assert.equal(deliveryRun.status, 'active');
  await stat(deliveryRun.integration_worktree);
  const runState = await api(`/api/runs/${deliveryRun.id}`);
  assert.equal(runState.tasks.length, 1);
  assert.equal(runState.tasks[0].run_id, deliveryRun.id);
  const runTask = runState.tasks[0];
  await api(`/api/tasks/${runTask.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${runTask.id}/start`, { method: 'POST', body: '{}' });
  await waitForTaskStatus(runTask.id, 'verifying');
  await api(`/api/tasks/${runTask.id}/verify`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${runTask.id}/merge`, { method: 'POST', body: '{}' });
  assert.equal((await api(`/api/runs/${deliveryRun.id}`)).status, 'ready_to_publish');
  const backupResult = await api('/api/maintenance/backup', { method: 'POST', body: '{}' });
  await stat(backupResult.path);
  const github = await api('/api/github/status');
  assert.equal(typeof github.available, 'boolean');

  const timeout = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Timeout task', agent: 'claude-code', files: ['index.html'], acceptance: 'node --check server.mjs' }) });
  await api(`/api/tasks/${timeout.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${timeout.id}/start`, { method: 'POST', body: '{}' });
  assert.equal((await waitForTaskStatus(timeout.id, 'failed')).recovery_note.includes('timed out'), true);

  const failed = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Exit code task', agent: 'antigravity', files: ['aod.config.example.json'], acceptance: 'node --check server.mjs' }) });
  await api(`/api/tasks/${failed.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${failed.id}/start`, { method: 'POST', body: '{}' });
  assert.equal((await waitForTaskStatus(failed.id, 'failed')).last_exit_code, 7);
  console.log('AOD integration test passed');
} finally {
  await stopDaemon();
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-worktrees`), { recursive: true, force: true });
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-runs`), { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
}
