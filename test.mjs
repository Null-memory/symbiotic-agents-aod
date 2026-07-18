import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const fixture = await mkdtemp(join(tmpdir(), 'aod-integration-'));
const port = 4928;
const files = ['.gitignore', 'server.mjs', 'approval-domain.mjs', 'process-domain.mjs', 'group-domain.mjs', 'group-schema.mjs', 'app.js', 'index.html', 'styles.css', 'package.json', 'README.md', 'aod.config.example.json'];
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
async function apiFailure(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  assert.equal(response.ok, false, 'Expected API request to fail.');
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
async function waitForTaskStatus(id, expected, { timeoutMs = 9000, pollMs = 75 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const current = await api('/api/state', { signal: AbortSignal.timeout(remainingMs) });
    const task = current.tasks.find(item => item.id === id);
    if (task?.status === expected) return task;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  const current = await api('/api/state');
  const task = current.tasks.find(item => item.id === id);
  console.error('Task timeout diagnostics:', JSON.stringify({ task, events: current.events.slice(0, 8) }, null, 2));
  throw new Error(`Task ${id} did not reach ${expected}.`);
}
async function waitForGroupSessionStatus(id, expected, { timeoutMs = 9000, pollMs = 75 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    session = await api(`/api/group-sessions/${id}`, { signal: AbortSignal.timeout(remainingMs) });
    if (session.status === expected) return session;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  console.error('Group session timeout diagnostics:', JSON.stringify({ session }, null, 2));
  throw new Error(`Group session ${id} did not reach ${expected} within ${timeoutMs}ms.`);
}
async function waitForReviewStatus(taskId, expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await api('/api/state');
    const review = current.reviews.find(item => item.task_id === taskId);
    if (review?.status === expected) return review;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Conflict review for ${taskId} did not reach ${expected}.`);
}
async function observeGroupSessionConcurrency(id, { timeoutMs = 9000, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let maximum = 0;
  let session;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const state = await api('/api/state', { signal: AbortSignal.timeout(remainingMs) });
    maximum = Math.max(maximum, state.runtime.activeAgents);
    session = state.groupSessions.find(item => item.id === id);
    if (session?.status === 'awaiting_confirmation') {
      return { maximum, session: await api(`/api/group-sessions/${id}`, { signal: AbortSignal.timeout(remainingMs) }) };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  console.error('Group concurrency timeout diagnostics:', JSON.stringify({ maximum, session }, null, 2));
  throw new Error(`Group session ${id} did not finish within ${timeoutMs}ms.`);
}
async function observeActiveAgentsUntilSettled(operation, { timeoutMs = 5000, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let maximum = 0;
  let settled = false;
  let operationError;
  operation.then(() => { settled = true; }, error => { operationError = error; settled = true; });
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const state = await api('/api/state', { signal: AbortSignal.timeout(remainingMs) });
    maximum = Math.max(maximum, state.runtime.activeAgents);
    if (settled && state.runtime.activeAgents === 0) {
      if (operationError) throw operationError;
      return maximum;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Concurrent agent starts did not settle within ${timeoutMs}ms (maximum ${maximum}).`);
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
  const fakeCodex = "const fs=require('fs');const cp=require('child_process');if(process.env.AOD_GROUP_SESSION_ID&&!process.env.AOD_TASK_STAGE){if(process.env.AOD_GROUP_PHASE==='synthesis'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);const roster=JSON.parse(process.env.AOD_GROUP_ROSTER);const role=r=>roster.find(m=>m.role===r).id;console.log(JSON.stringify({title:'Group delivery',summary:'Agents reached agreement.',decisions:['Use the existing run pipeline.'],disagreements:[],risks:['Keep merges manual.'],maxRepairs:2,tasks:[{key:'group-doc',title:'Create group delivery note',description:'Create the agreed artifact.',files:['group-output.md'],dependsOn:[],acceptance:'node --check server.mjs',risk:'low',executorMemberId:role('executor'),reviewerMemberId:role('reviewer'),fixerMemberId:role('fixer')}]}));}else{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);console.log(process.env.AOD_GROUP_PHASE+' response from '+process.env.AOD_GROUP_MEMBER_ID);}process.exit(0);}if(process.env.AOD_TASK_STAGE==='execute'){const target=JSON.parse(process.env.AOD_TASK_FILES||'[\"group-output.md\"]')[0];if(target==='group-cancel.md')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);fs.writeFileSync(target,target.includes('repair')?'needs repair\\n':'group execution output\\n');cp.execFileSync('git',['add',target]);cp.execFileSync('git',['-c','user.name=AOD Agent','-c','user.email=aod@test.local','commit','-m','docs: add group output']);console.log('group executor complete');process.exit(0);}if(process.env.AOD_TASK_ID!=='T-001'){const target=JSON.parse(process.env.AOD_TASK_FILES||'[\"delivery-note.md\"]')[0];fs.writeFileSync(target,'run branch output\\n');cp.execFileSync('git',['add',target]);cp.execFileSync('git',['-c','user.name=AOD Agent','-c','user.email=aod@test.local','commit','-m','docs: add delivery note']);}console.log('fake agent complete')";
  const fakeClaude = "const fs=require('fs');if(process.env.AOD_TASK_STAGE==='review'){if(process.argv[1]!==process.env.AOD_WORKTREE){console.error('review worktree argument mismatch');process.exit(8);}const target=JSON.parse(process.env.AOD_TASK_FILES||'[]')[0];if(target==='group-cancel-review.md')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);if(target==='group-review-mutation.md')fs.appendFileSync(target,'reviewer mutation\\n');const needs=target&&fs.existsSync(target)&&fs.readFileSync(target,'utf8').includes('needs repair');console.log(JSON.stringify(needs?{decision:'changes_requested',findings:['Replace defect marker.'],summary:'Repair required.'}:{decision:'pass',findings:[],summary:'Review passed.'}));process.exit(0);}else if(process.env.AOD_GROUP_SESSION_ID){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);if(process.env.AOD_GROUP_PHASE==='synthesis'){const roster=JSON.parse(process.env.AOD_GROUP_ROSTER);const role=r=>roster.find(m=>m.role===r).id;console.log(JSON.stringify({title:'Multi-seat Claude group',summary:'Three Claude seats reached agreement.',decisions:['Keep seat identities independent.'],disagreements:[],risks:['Shared adapter capacity.'],maxRepairs:2,tasks:[{key:'multi-seat-doc',title:'Create multi-seat note',description:'Record the agreement.',files:['multi-seat-output.md'],dependsOn:[],acceptance:'node --check server.mjs',risk:'low',executorMemberId:role('executor'),reviewerMemberId:role('reviewer'),fixerMemberId:role('fixer')}]}));}else{console.log(process.env.AOD_GROUP_PHASE+' response from '+process.env.AOD_GROUP_MEMBER_ID);}process.exit(0);}else{setTimeout(()=>{},1000)}";
  const fakeAntigravity = "const fs=require('fs');const cp=require('child_process');if(process.env.AOD_TASK_STAGE==='repair'){const target=JSON.parse(process.env.AOD_TASK_FILES||'[]')[0];if(target==='group-repair-exhaust.md')fs.appendFileSync(target,'needs repair again\\n');else fs.writeFileSync(target,'repaired output\\n');cp.execFileSync('git',['add',target]);cp.execFileSync('git',['-c','user.name=AOD Agent','-c','user.email=aod@test.local','commit','-m','fix: repair group output']);console.log('repair complete');process.exit(0);}if(process.env.AOD_GROUP_SESSION_ID){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);console.log(process.env.AOD_GROUP_PHASE+' response from '+process.env.AOD_GROUP_MEMBER_ID);process.exit(0);}process.exit(7)";
  const fakeConflictReviewer = "const fs=require('fs');const target=JSON.parse(process.env.AOD_TASK_FILES||'[]')[0];if(target!=='conflict-approval.md')fs.writeFileSync('reviewer-leak.txt','must remain isolated\\n');console.log('Suggested patch only.');";
  await writeFile(join(fixture, '.aod.config.json'), JSON.stringify({
    defaults: { maxRetries: 0 },
    planner: {
      command: process.execPath,
      args: ['-e', "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);console.log(JSON.stringify({title:'Planned run',tasks:[{key:'docs',title:'Create delivery note',agent:'codex',files:['delivery-note.md'],dependsOn:[],acceptance:'node --check server.mjs',risk:'none'}]}))"]
    },
    agents: {
      codex: { command: process.execPath, args: ['-e', fakeCodex], reviewArgs: ['-e', fakeConflictReviewer, '{{worktree}}'], health: { versionArgs: ['--version'], authArgs: ['-e', "console.log('authenticated')"] } },
      'claude-code': { command: process.execPath, args: ['-e', fakeClaude, '{{worktree}}'], reviewArgs: ['-e', fakeClaude, '{{worktree}}'], timeoutMs: 75 },
      antigravity: { command: process.execPath, args: ['-e', fakeAntigravity], health: { versionArgs: ['--version'], authArgs: ['-e', "console.error('ghp_1234567890abcdefghijklmnopqrstuvwxyz');process.exit(3)"] } }
    }
  }));
  daemon = spawn(process.execPath, ['server.mjs'], { cwd: fixture, env: { ...process.env, PORT: String(port) }, windowsHide: true });
  await waitForHealth();

  const codexHealth = await api('/api/agents/codex/check', { method: 'POST', body: '{}' });
  assert.equal(codexHealth.status, 'ready');
  assert.equal(codexHealth.auth_status, 'ready');
  assert.equal(codexHealth.version.includes('v'), true);
  assert.equal(codexHealth.latency_ms >= 0, true);

  const failedHealth = await api('/api/agents/antigravity/check', { method: 'POST', body: '{}' });
  assert.equal(failedHealth.status, 'error');
  assert.equal(failedHealth.auth_status, 'failed');
  assert.equal(failedHealth.message.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(failedHealth.message.includes('[REDACTED]'), true);

  const healthRows = await api('/api/agents/health');
  assert.equal(healthRows.find(item => item.agent === 'codex').status, 'ready');
  assert.equal(healthRows.find(item => item.agent === 'antigravity').status, 'error');
  assert.equal((await api('/api/state')).agentHealth.find(item => item.agent === 'codex').checked_at, codexHealth.checked_at);
  assert.equal((await apiFailure('/api/agents/unknown/check', { method: 'POST', body: '{}' })).error.includes('supported'), true);

  const fixtureConfigPath = join(fixture, '.aod.config.json');
  const originalFixtureConfig = JSON.parse(await readFile(fixtureConfigPath, 'utf8'));
  const changedFixtureConfig = structuredClone(originalFixtureConfig);
  changedFixtureConfig.agents.codex.command = `${process.execPath}.changed`;
  await writeFile(fixtureConfigPath, JSON.stringify(changedFixtureConfig));
  const staleHealth = (await api('/api/agents/health')).find(item => item.agent === 'codex');
  assert.equal(staleHealth.status, 'not_checked');
  assert.equal(staleHealth.command, changedFixtureConfig.agents.codex.command);
  await writeFile(fixtureConfigPath, JSON.stringify(originalFixtureConfig));

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
  const firstProcess = (await api('/api/processes')).find(item => item.task_id === first.id && item.kind === 'task');
  assert.equal('metadata_json' in firstProcess, false, 'Process API leaked raw metadata JSON.');
  assert.equal(firstProcess.input_tokens, null);
  assert.equal(firstProcess.output_tokens, null);
  assert.equal(firstProcess.cost_usd, null);
  assert.deepEqual({
    agent: firstProcess.agent,
    status: firstProcess.status,
    exitCode: firstProcess.exit_code,
    pidRecorded: Number.isInteger(firstProcess.pid),
    heartbeatRecorded: typeof firstProcess.heartbeat_at === 'string',
    outputRecorded: typeof firstProcess.last_output_at === 'string',
    leaseOwnerRecorded: typeof firstProcess.lease_owner === 'string',
    timeoutRecorded: firstProcess.timeout_ms > 0
  }, {
    agent: 'codex', status: 'succeeded', exitCode: 0, pidRecorded: true, heartbeatRecorded: true,
    outputRecorded: true, leaseOwnerRecorded: true, timeoutRecorded: true
  });
  assert.equal((await readSseInitialState()).includes('event: state'), true);
  await api(`/api/tasks/${first.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'failed' }) });

  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'manual', maxConcurrency: 2 }) });
  const inboxTask = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Approval inbox task', agent: 'codex', files: ['approval-inbox.md'], acceptance: 'node --check server.mjs' }) });
  const prepareApprovalId = `task:${inboxTask.id}:prepare`;
  assert.equal((await api('/api/approvals')).some(item => item.id === prepareApprovalId), true);
  assert.equal((await api('/api/state')).approvals.some(item => item.id === prepareApprovalId), true);
  const preparedInboxTask = await api('/api/approvals/action', { method: 'POST', body: JSON.stringify({ id: prepareApprovalId, action: 'prepare' }) });
  assert.equal(preparedInboxTask.status, 'ready');
  const startApprovalId = `task:${inboxTask.id}:start`;
  assert.equal((await api('/api/approvals')).some(item => item.id === startApprovalId), true);
  await api('/api/approvals/action', { method: 'POST', body: JSON.stringify({ id: startApprovalId, action: 'start' }) });
  assert.equal((await apiFailure('/api/approvals/action', { method: 'POST', body: JSON.stringify({ id: startApprovalId, action: 'start' }) })).error.includes('no longer pending'), true);
  await waitForTaskStatus(inboxTask.id, 'verifying');
  const verifyApprovalId = `task:${inboxTask.id}:verify`;
  await api('/api/approvals/action', { method: 'POST', body: JSON.stringify({ id: verifyApprovalId, action: 'verify' }) });
  assert.equal((await waitForTaskStatus(inboxTask.id, 'merge_ready')).status, 'merge_ready');
  assert.equal((await api('/api/approvals')).some(item => item.id === `task:${inboxTask.id}:merge`), true);
  await api(`/api/tasks/${inboxTask.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'failed' }) });
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'hybrid', maxConcurrency: 2 }) });

  const second = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Recovery task', agent: 'claude-code', files: ['styles.css'], acceptance: 'node --check server.mjs' }) });
  assert.equal(second.status, 'ready');
  await api(`/api/tasks/${second.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'running' }) });
  await stopDaemon();
  daemon = spawn(process.execPath, ['server.mjs'], { cwd: fixture, env: { ...process.env, PORT: String(port) }, windowsHide: true });
  await waitForHealth();
  const recovered = await api('/api/state');
  assert.equal(recovered.tasks.find(task => task.id === second.id).status, 'recovery_required');
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'manual', maxConcurrency: 2 }) });

  const planningRequest = api('/api/runs/plan', { method: 'POST', body: JSON.stringify({ requirement: 'Create a delivery note', planner: 'codex' }) });
  const [plan, planningMaximum] = await Promise.all([planningRequest, observeActiveAgentsUntilSettled(planningRequest)]);
  assert.equal(planningMaximum, 1, 'Planner did not reserve a global agent slot.');
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

  const conflictTask = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Conflict reviewer isolation', agent: 'codex', files: ['conflict-note.md'], acceptance: 'node --check server.mjs' }) });
  const preparedConflictTask = await api(`/api/tasks/${conflictTask.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${conflictTask.id}/start`, { method: 'POST', body: '{}' });
  await waitForTaskStatus(conflictTask.id, 'verifying');
  await writeFile(join(fixture, 'conflict-note.md'), 'main-side conflict\n');
  await run('git', ['add', 'conflict-note.md']);
  await run('git', ['-c', 'user.name=AOD Test', '-c', 'user.email=aod@test.local', 'commit', '-m', 'docs: add main conflict']);
  await api(`/api/tasks/${conflictTask.id}/verify`, { method: 'POST', body: '{}' });
  const conflictHead = (await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: preparedConflictTask.worktree, shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`git rev-parse exited with ${code}`)));
  }));
  assert.equal((await api(`/api/tasks/${conflictTask.id}/merge`, { method: 'POST', body: '{}' })).status, 'conflict_review');
  await api(`/api/tasks/${conflictTask.id}/review`, { method: 'POST', body: '{}' });
  await waitForReviewStatus(conflictTask.id, 'failed');
  const conflictHeadAfterReview = (await new Promise((resolve, reject) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: preparedConflictTask.worktree, shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`git rev-parse exited with ${code}`)));
  }));
  assert.equal(conflictHeadAfterReview, conflictHead);
  assert.equal(await stat(join(preparedConflictTask.worktree, 'reviewer-leak.txt')).then(() => true, () => false), false);

  const approvalTask = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Conflict approval cleanliness', agent: 'codex', files: ['conflict-approval.md'], acceptance: 'node --check server.mjs' }) });
  const preparedApprovalTask = await api(`/api/tasks/${approvalTask.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${approvalTask.id}/start`, { method: 'POST', body: '{}' });
  await waitForTaskStatus(approvalTask.id, 'verifying');
  await writeFile(join(fixture, 'conflict-approval.md'), 'main-side approval conflict\n');
  await run('git', ['add', 'conflict-approval.md']);
  await run('git', ['-c', 'user.name=AOD Test', '-c', 'user.email=aod@test.local', 'commit', '-m', 'docs: add approval conflict']);
  await api(`/api/tasks/${approvalTask.id}/verify`, { method: 'POST', body: '{}' });
  assert.equal((await api(`/api/tasks/${approvalTask.id}/merge`, { method: 'POST', body: '{}' })).status, 'conflict_review');
  await api(`/api/tasks/${approvalTask.id}/review`, { method: 'POST', body: '{}' });
  const suggestedApprovalReview = await waitForReviewStatus(approvalTask.id, 'suggested');
  await writeFile(join(preparedApprovalTask.worktree, 'executor-leftover.txt'), 'not part of the approved patch\n');
  const approvalPatch = [
    'diff --git a/conflict-approval.md b/conflict-approval.md',
    '--- a/conflict-approval.md',
    '+++ b/conflict-approval.md',
    '@@ -1 +1 @@',
    '-run branch output',
    '+resolved conflict',
    ''
  ].join('\n');
  const dirtyApproval = await apiFailure(`/api/reviews/${suggestedApprovalReview.id}/approve`, { method: 'POST', body: JSON.stringify({ patch: approvalPatch }) });
  assert.equal(dirtyApproval.error.includes('clean'), true);
  assert.equal((await api('/api/state')).tasks.find(task => task.id === approvalTask.id).status, 'conflict_review');

  const group = await api('/api/groups', { method: 'POST', body: JSON.stringify({
    name: 'Delivery council',
    description: 'Discuss, implement, review, and repair delivery work.',
    moderatorKey: 'builder',
    members: [
      { key: 'builder', agent: 'codex', role: 'executor', displayName: 'Builder', instructions: 'Own implementation decisions.' },
      { key: 'inspector', agent: 'claude-code', role: 'reviewer', displayName: 'Inspector', instructions: 'Challenge assumptions and inspect changes.' },
      { key: 'repairer', agent: 'antigravity', role: 'fixer', displayName: 'Repairer', instructions: 'Prepare minimal fixes when requested.' }
    ]
  }) });
  assert.equal(group.name, 'Delivery council');
  assert.equal(group.max_rounds, 3);
  assert.equal(group.max_repairs, 2);
  assert.equal(group.members.length, 3);
  assert.equal(group.members.find(member => member.key === 'builder').is_moderator, true);
  assert.equal((await api('/api/groups')).some(item => item.id === group.id), true);
  assert.equal((await api(`/api/groups/${group.id}`)).members.length, 3);
  const renamedGroup = await api(`/api/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Delivery council v2' }) });
  assert.equal(renamedGroup.name, 'Delivery council v2');
  assert.equal(renamedGroup.members.length, 3);
  const invalidGroup = await apiFailure('/api/groups', { method: 'POST', body: JSON.stringify({
    name: 'No reviewer', moderatorKey: 'builder', maxRepairs: 0,
    members: [
      { key: 'builder', agent: 'codex', role: 'executor' },
      { key: 'advisor', agent: 'claude-code', role: 'advisor' }
    ]
  }) });
  assert.equal(invalidGroup.error.includes('reviewer'), true);

  const multiSeatGroup = await api('/api/groups', { method: 'POST', body: JSON.stringify({
    name: 'Three Claude perspectives',
    description: 'Use one adapter as three independent group participants.',
    moderatorKey: 'claude-builder',
    members: [
      { key: 'claude-builder', agent: 'claude-code', role: 'executor', displayName: 'Claude Builder', instructions: 'Design and implement.' },
      { key: 'claude-critic', agent: 'claude-code', role: 'reviewer', displayName: 'Claude Critic', instructions: 'Challenge and review.' },
      { key: 'claude-repair', agent: 'claude-code', role: 'fixer', displayName: 'Claude Repair', instructions: 'Repair rejected work.' }
    ]
  }) });
  assert.equal(multiSeatGroup.members.length, 3);
  assert.equal(multiSeatGroup.members.every(member => member.agent === 'claude-code'), true);
  assert.equal(new Set(multiSeatGroup.members.map(member => member.key)).size, 3);

  const multiSeatSession = await api(`/api/groups/${multiSeatGroup.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Reach agreement as three independent Claude seats.' }) });
  assert.equal(multiSeatSession.members.length, 3);
  assert.equal(new Set(multiSeatSession.members.map(member => member.id)).size, 3);
  await api(`/api/group-sessions/${multiSeatSession.id}/start`, { method: 'POST', body: '{}' });
  const completedMultiSeatSession = await waitForGroupSessionStatus(multiSeatSession.id, 'awaiting_confirmation');
  assert.equal(completedMultiSeatSession.consensus.title, 'Multi-seat Claude group');
  assert.equal(new Set(completedMultiSeatSession.turns.filter(turn => turn.phase !== 'synthesis').map(turn => turn.member_id)).size, 3);
  assert.equal((await api(`/api/group-sessions/${multiSeatSession.id}/messages?after=0`)).filter(message => message.sender_kind === 'member').length, 10);

  const groupSession = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Discuss and create a group delivery note.' }) });
  assert.equal(groupSession.status, 'draft');
  await api(`/api/group-sessions/${groupSession.id}/start`, { method: 'POST', body: '{}' });
  const observedDiscussion = await observeGroupSessionConcurrency(groupSession.id);
  assert.equal(observedDiscussion.maximum <= 2, true, `Global agent concurrency reached ${observedDiscussion.maximum}; expected at most 2.`);
  assert.equal(observedDiscussion.maximum, 2, 'The group discussion did not exercise both available agent slots.');
  const discussed = observedDiscussion.session;
  assert.equal(discussed.current_round, 3);
  assert.equal(discussed.consensus.title, 'Group delivery');
  assert.equal(discussed.consensus.tasks.length, 1);
  const groupOverview = await api('/api/state');
  assert.equal(groupOverview.groups.some(item => item.id === group.id), true);
  assert.equal(groupOverview.groupSessions.some(item => item.id === groupSession.id && item.status === 'awaiting_confirmation'), true);
  assert.equal('turns' in groupOverview.groupSessions[0], false);
  const messages = await api(`/api/group-sessions/${groupSession.id}/messages?after=0`);
  assert.equal(messages.filter(message => message.sender_kind === 'member').length, 10);
  assert.deepEqual([...new Set(messages.filter(message => message.round > 0).map(message => message.round))], [1, 2, 3]);
  const invalidRecovery = await apiFailure(`/api/group-turns/${discussed.turns[0].id}/recover`, { method: 'POST', body: JSON.stringify({ action: 'unknown' }) });
  assert.equal(invalidRecovery.error.includes('retry, skip, or replace'), true);

  const concurrentTasks = [];
  for (let index = 1; index <= 3; index += 1) {
    const task = await api('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: `Concurrency probe ${index}`,
      agent: 'claude-code',
      files: [`concurrency-probe-${index}.md`],
      acceptance: 'node --check server.mjs'
    }) });
    concurrentTasks.push(await api(`/api/tasks/${task.id}/prepare`, { method: 'POST', body: '{}' }));
  }
  const concurrentStarts = Promise.all(concurrentTasks.map(task => api(`/api/tasks/${task.id}/start`, { method: 'POST', body: '{}' })));
  const concurrentMaximum = await observeActiveAgentsUntilSettled(concurrentStarts);
  assert.equal(concurrentMaximum <= 2, true, `Global agent concurrency reached ${concurrentMaximum}; expected at most 2.`);
  assert.equal(concurrentMaximum, 2, 'Concurrent starts did not exercise both available agent slots.');

  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'auto', maxConcurrency: 1 }), signal: AbortSignal.timeout(2000) });
  const blockingPlanningRequest = api('/api/runs/plan', { method: 'POST', body: JSON.stringify({ requirement: 'Hold the only global agent slot.', planner: 'codex' }) });
  let plannerOccupiedSlot = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await api('/api/state')).runtime.activePlanners === 1) { plannerOccupiedSlot = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(plannerOccupiedSlot, true, 'Planner did not occupy the expected slot before group confirmation.');
  const confirmationRequest = api(`/api/group-sessions/${groupSession.id}/confirm`, { method: 'POST', body: JSON.stringify({ consensus: discussed.consensus }) });
  await blockingPlanningRequest;
  const confirmedSession = await confirmationRequest;
  assert.equal(confirmedSession.status, 'executing');
  assert.equal(typeof confirmedSession.run_id, 'string');
  const groupRun = await api(`/api/runs/${confirmedSession.run_id}`);
  assert.equal(groupRun.tasks.length, 1);
  const groupTask = await waitForTaskStatus(groupRun.tasks[0].id, 'merge_ready');
  assert.equal(groupTask.agent, 'codex');
  assert.equal(groupTask.attempts, 1);
  const roleSession = await api(`/api/group-sessions/${groupSession.id}`);
  assert.equal(roleSession.status, 'awaiting_merge');
  assert.equal(roleSession.assignments[0].stage, 'passed');
  assert.equal(roleSession.assignments[0].repair_count, 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  const autoRoleState = await api('/api/state');
  assert.equal(autoRoleState.tasks.find(task => task.id === groupTask.id).status, 'merge_ready');
  assert.equal(autoRoleState.groupSessions.find(session => session.id === groupSession.id).status, 'awaiting_merge');
  assert.deepEqual(
    autoRoleState.events.filter(event => event.task_id === groupTask.id && event.type === 'verify' && event.message.includes('acceptance check passed')).map(event => event.message),
    [`${groupTask.id} acceptance check passed (group)`]
  );

  const groupTurnCountBeforeExecutionRecovery = roleSession.turns.length;
  await stopDaemon();
  const recoveryDb = new DatabaseSync(join(fixture, '.aod', 'orchestrator.db'));
  try {
    recoveryDb.prepare("UPDATE group_sessions SET status = 'recovery_required' WHERE id = ?").run(groupSession.id);
    recoveryDb.prepare("UPDATE tasks SET status = 'recovery_required' WHERE id = ?").run(groupTask.id);
    recoveryDb.prepare("UPDATE task_role_assignments SET stage = 'recovery_required', review_json = NULL WHERE task_id = ?").run(groupTask.id);
    const insertInterruptedProcess = recoveryDb.prepare(`INSERT INTO agent_processes(
      id, kind, entity_id, agent, status, pid, lease_owner, lease_expires_at, heartbeat_at, started_at, timeout_ms, attempt
    ) VALUES (?, 'planner', ?, 'codex', 'running', ?, 'previous-daemon', ?, ?, ?, 600000, 1)`);
    const freshLease = new Date(Date.now() + 60000).toISOString();
    const expiredLease = new Date(Date.now() - 60000).toISOString();
    const startedAt = new Date(Date.now() - 120000).toISOString();
    insertInterruptedProcess.run('AP-RECOVERY-STALE', 'planner:stale', 2147483647, freshLease, freshLease, startedAt);
    insertInterruptedProcess.run('AP-RECOVERY-LIVE', 'planner:live', process.pid, freshLease, freshLease, startedAt);
    insertInterruptedProcess.run('AP-RECOVERY-UNVERIFIABLE', 'planner:unverifiable', process.pid, expiredLease, expiredLease, startedAt);
  } finally {
    recoveryDb.close();
  }
  daemon = spawn(process.execPath, ['server.mjs'], { cwd: fixture, env: { ...process.env, PORT: String(port) }, windowsHide: true });
  await waitForHealth();
  const recoveredProcesses = new Map((await api('/api/processes?limit=500')).map(item => [item.id, item]));
  assert.deepEqual(
    ['AP-RECOVERY-STALE', 'AP-RECOVERY-LIVE', 'AP-RECOVERY-UNVERIFIABLE'].map(id => ({
      id,
      status: recoveredProcesses.get(id)?.status,
      recoveryState: recoveredProcesses.get(id)?.recovery_state,
      finished: typeof recoveredProcesses.get(id)?.finished_at === 'string'
    })),
    [
      { id: 'AP-RECOVERY-STALE', status: 'recovery_required', recoveryState: 'stale', finished: true },
      { id: 'AP-RECOVERY-LIVE', status: 'recovery_required', recoveryState: 'live', finished: true },
      { id: 'AP-RECOVERY-UNVERIFIABLE', status: 'recovery_required', recoveryState: 'unverifiable', finished: true }
    ]
  );
  const resumedExecution = await api(`/api/group-sessions/${groupSession.id}/resume`, { method: 'POST', body: '{}' });
  assert.equal(resumedExecution.status, 'executing');
  await waitForTaskStatus(groupTask.id, 'reviewing');
  await waitForTaskStatus(groupTask.id, 'merge_ready');
  const recoveredRoleSession = await waitForGroupSessionStatus(groupSession.id, 'awaiting_merge');
  assert.equal(recoveredRoleSession.assignments[0].stage, 'passed');
  assert.equal(recoveredRoleSession.turns.length, groupTurnCountBeforeExecutionRecovery);

  const cancelDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Cancel an executing group task.' }) });
  await api(`/api/group-sessions/${cancelDiscussion.id}/start`, { method: 'POST', body: '{}' });
  const cancelConsensusSession = await waitForGroupSessionStatus(cancelDiscussion.id, 'awaiting_confirmation');
  const cancelConsensus = structuredClone(cancelConsensusSession.consensus);
  cancelConsensus.title = 'Execution cancellation';
  cancelConsensus.tasks[0].key = 'group-cancel';
  cancelConsensus.tasks[0].title = 'Create cancellable group note';
  cancelConsensus.tasks[0].files = ['group-cancel.md'];
  const cancelExecution = await api(`/api/group-sessions/${cancelDiscussion.id}/confirm`, { method: 'POST', body: JSON.stringify({ consensus: cancelConsensus }) });
  const cancelRun = await api(`/api/runs/${cancelExecution.run_id}`);
  const runningCancelTask = await waitForTaskStatus(cancelRun.tasks[0].id, 'running');
  assert.notEqual(runningCancelTask.process_pid, null);
  await api(`/api/group-sessions/${cancelDiscussion.id}/cancel`, { method: 'POST', body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 150));
  let cancelledState;
  let cancelledSession;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    [cancelledSession, cancelledState] = await Promise.all([
      api(`/api/group-sessions/${cancelDiscussion.id}`),
      api('/api/state')
    ]);
    const task = cancelledState.tasks.find(item => item.id === runningCancelTask.id);
    if (cancelledSession.status === 'cancelled' && task?.status === 'cancelled' && cancelledSession.assignments[0]?.stage === 'failed' && task.process_pid === null && cancelledState.runtime.activeAgents === 0) break;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  const cancelledTask = cancelledState.tasks.find(item => item.id === runningCancelTask.id);
  assert.deepEqual({
    session: cancelledSession.status,
    task: cancelledTask.status,
    assignment: cancelledSession.assignments[0].stage,
    processPid: cancelledTask.process_pid,
    activeAgents: cancelledState.runtime.activeAgents
  }, { session: 'cancelled', task: 'cancelled', assignment: 'failed', processPid: null, activeAgents: 0 });

  const reviewCancelDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Cancel an active group reviewer.' }) });
  await api(`/api/group-sessions/${reviewCancelDiscussion.id}/start`, { method: 'POST', body: '{}' });
  const reviewCancelConsensusSession = await waitForGroupSessionStatus(reviewCancelDiscussion.id, 'awaiting_confirmation');
  const reviewCancelConsensus = structuredClone(reviewCancelConsensusSession.consensus);
  reviewCancelConsensus.title = 'Review cancellation';
  reviewCancelConsensus.tasks[0].key = 'group-cancel-review';
  reviewCancelConsensus.tasks[0].title = 'Create review cancellation note';
  reviewCancelConsensus.tasks[0].files = ['group-cancel-review.md'];
  const reviewCancelExecution = await api(`/api/group-sessions/${reviewCancelDiscussion.id}/confirm`, { method: 'POST', body: JSON.stringify({ consensus: reviewCancelConsensus }) });
  const reviewCancelRun = await api(`/api/runs/${reviewCancelExecution.run_id}`);
  const reviewingCancelTask = await waitForTaskStatus(reviewCancelRun.tasks[0].id, 'reviewing');
  let activeReviewState;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    activeReviewState = await api('/api/state');
    if (activeReviewState.runtime.activeRoleProcesses > 0) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(activeReviewState.runtime.activeRoleProcesses > 0, true);
  const immediateReviewCancelSession = await api(`/api/group-sessions/${reviewCancelDiscussion.id}/cancel`, { method: 'POST', body: '{}' });
  const immediateReviewCancelState = await api('/api/state');
  assert.deepEqual({
    session: immediateReviewCancelSession.status,
    task: immediateReviewCancelState.tasks.find(item => item.id === reviewingCancelTask.id).status,
    assignment: immediateReviewCancelSession.assignments[0].stage
  }, { session: 'cancelled', task: 'cancelled', assignment: 'failed' });
  await new Promise(resolve => setTimeout(resolve, 1700));
  const [closedReviewCancelSession, closedReviewCancelState] = await Promise.all([
    api(`/api/group-sessions/${reviewCancelDiscussion.id}`),
    api('/api/state')
  ]);
  assert.deepEqual({
    session: closedReviewCancelSession.status,
    task: closedReviewCancelState.tasks.find(item => item.id === reviewingCancelTask.id).status,
    assignment: closedReviewCancelSession.assignments[0].stage,
    activeRoleProcesses: closedReviewCancelState.runtime.activeRoleProcesses
  }, { session: 'cancelled', task: 'cancelled', assignment: 'failed', activeRoleProcesses: 0 });

  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'manual', maxConcurrency: 2 }), signal: AbortSignal.timeout(2000) });
  const autoTask = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Automatic merge control', agent: 'codex', files: ['auto-merge-output.md'], acceptance: 'node --check server.mjs' }) });
  await api(`/api/tasks/${autoTask.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${autoTask.id}/start`, { method: 'POST', body: '{}' });
  await waitForTaskStatus(autoTask.id, 'verifying');
  await api(`/api/tasks/${autoTask.id}/verify`, { method: 'POST', body: '{}' });
  await waitForTaskStatus(autoTask.id, 'merge_ready');
  const autoGroupState = await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'auto', maxConcurrency: 2 }), signal: AbortSignal.timeout(2000) });
  assert.equal(autoGroupState.tasks.find(task => task.id === groupTask.id).status, 'merge_ready');
  assert.equal(autoGroupState.tasks.find(task => task.id === autoTask.id).status, 'merge_ready');
  assert.equal(autoGroupState.groupSessions.find(session => session.id === groupSession.id).status, 'awaiting_merge');
  await api(`/api/tasks/${autoTask.id}/merge`, { method: 'POST', body: '{}' });
  assert.equal((await waitForTaskStatus(autoTask.id, 'merged')).status, 'merged');
  await api(`/api/tasks/${groupTask.id}/merge`, { method: 'POST', body: '{}' });
  assert.equal((await api(`/api/group-sessions/${groupSession.id}`)).status, 'completed');
  const completedCancel = await apiFailure(`/api/group-sessions/${groupSession.id}/cancel`, { method: 'POST', body: '{}' });
  assert.equal(completedCancel.error.includes('cannot be cancelled'), true);
  assert.equal((await api(`/api/group-sessions/${groupSession.id}`)).status, 'completed');
  await api('/api/settings', { method: 'POST', body: JSON.stringify({ mode: 'manual', maxConcurrency: 2 }) });

  const repairDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Exercise the repair role pipeline.' }) });
  await api(`/api/group-sessions/${repairDiscussion.id}/start`, { method: 'POST', body: '{}' });
  const repairConsensusSession = await waitForGroupSessionStatus(repairDiscussion.id, 'awaiting_confirmation');
  const repairConsensus = structuredClone(repairConsensusSession.consensus);
  repairConsensus.title = 'Repair pipeline';
  repairConsensus.tasks[0].key = 'repair-doc';
  repairConsensus.tasks[0].title = 'Create repairable delivery note';
  repairConsensus.tasks[0].files = ['group-repair.md'];
  const repairExecution = await api(`/api/group-sessions/${repairDiscussion.id}/confirm`, { method: 'POST', body: JSON.stringify({ consensus: repairConsensus }) });
  const repairRun = await api(`/api/runs/${repairExecution.run_id}`);
  await waitForTaskStatus(repairRun.tasks[0].id, 'merge_ready');
  const repairedSession = await api(`/api/group-sessions/${repairDiscussion.id}`);
  assert.equal(repairedSession.assignments[0].stage, 'passed');
  assert.equal(repairedSession.assignments[0].repair_count, 1);

  const exhaustedDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Exhaust the repair budget.' }) });
  await api(`/api/group-sessions/${exhaustedDiscussion.id}/start`, { method: 'POST', body: '{}' });
  const exhaustedConsensusSession = await waitForGroupSessionStatus(exhaustedDiscussion.id, 'awaiting_confirmation');
  const exhaustedConsensus = structuredClone(exhaustedConsensusSession.consensus);
  exhaustedConsensus.title = 'Exhausted repair pipeline';
  exhaustedConsensus.tasks[0].key = 'exhausted-repair';
  exhaustedConsensus.tasks[0].title = 'Keep a defect after both repairs';
  exhaustedConsensus.tasks[0].files = ['group-repair-exhaust.md'];
  const exhaustedExecution = await api(`/api/group-sessions/${exhaustedDiscussion.id}/confirm`, { method: 'POST', body: JSON.stringify({ consensus: exhaustedConsensus }) });
  const exhaustedRun = await api(`/api/runs/${exhaustedExecution.run_id}`);
  await waitForTaskStatus(exhaustedRun.tasks[0].id, 'recovery_required');
  const exhaustedSession = await api(`/api/group-sessions/${exhaustedDiscussion.id}`);
  assert.equal(exhaustedSession.assignments[0].repair_count, 2);
  assert.equal(exhaustedSession.assignments[0].stage, 'recovery_required');
  assert.equal(exhaustedSession.status, 'recovery_required');

  const mutatingReviewDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Reject a reviewer that edits its detached worktree.' }) });
  await api(`/api/group-sessions/${mutatingReviewDiscussion.id}/start`, { method: 'POST', body: '{}' });
  const mutatingReviewConsensusSession = await waitForGroupSessionStatus(mutatingReviewDiscussion.id, 'awaiting_confirmation');
  const mutatingReviewConsensus = structuredClone(mutatingReviewConsensusSession.consensus);
  mutatingReviewConsensus.title = 'Reviewer mutation guard';
  mutatingReviewConsensus.tasks[0].key = 'review-mutation';
  mutatingReviewConsensus.tasks[0].title = 'Reject reviewer-side changes';
  mutatingReviewConsensus.tasks[0].files = ['group-review-mutation.md'];
  const mutatingReviewExecution = await api(`/api/group-sessions/${mutatingReviewDiscussion.id}/confirm`, { method: 'POST', body: JSON.stringify({ consensus: mutatingReviewConsensus }) });
  const mutatingReviewRun = await api(`/api/runs/${mutatingReviewExecution.run_id}`);
  const mutatingReviewTask = await waitForTaskStatus(mutatingReviewRun.tasks[0].id, 'recovery_required');
  assert.equal(mutatingReviewTask.recovery_note.includes('Reviewer modified'), true);
  assert.equal((await api(`/api/group-sessions/${mutatingReviewDiscussion.id}`)).status, 'recovery_required');

  const pausedDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Pause for operator guidance.' }) });
  await api(`/api/group-sessions/${pausedDiscussion.id}/start`, { method: 'POST', body: '{}' });
  await api(`/api/group-sessions/${pausedDiscussion.id}/pause`, { method: 'POST', body: '{}' });
  const paused = await waitForGroupSessionStatus(pausedDiscussion.id, 'paused');
  assert.equal(paused.current_round, 1);
  await api(`/api/group-sessions/${pausedDiscussion.id}/messages`, { method: 'POST', body: JSON.stringify({ content: 'Keep the final merge manual.' }) });
  await api(`/api/group-sessions/${pausedDiscussion.id}/resume`, { method: 'POST', body: '{}' });
  await waitForGroupSessionStatus(pausedDiscussion.id, 'awaiting_confirmation');
  const pausedMessages = await api(`/api/group-sessions/${pausedDiscussion.id}/messages?after=0`);
  assert.equal(pausedMessages.some(message => message.sender_kind === 'operator' && message.content.includes('final merge manual')), true);

  const synthesisPauseDiscussion = await api(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Pause while the moderator synthesizes consensus.' }) });
  await api(`/api/group-sessions/${synthesisPauseDiscussion.id}/start`, { method: 'POST', body: '{}' });
  await waitForGroupSessionStatus(synthesisPauseDiscussion.id, 'synthesizing', { timeoutMs: 5000, pollMs: 20 });
  await api(`/api/group-sessions/${synthesisPauseDiscussion.id}/pause`, { method: 'POST', body: '{}' });
  const synthesisPaused = await waitForGroupSessionStatus(synthesisPauseDiscussion.id, 'paused', { timeoutMs: 3000, pollMs: 20 });
  assert.equal(synthesisPaused.consensus.title, 'Group delivery');
  assert.equal(synthesisPaused.pause_requested, false);
  assert.equal(synthesisPaused.turns.filter(turn => turn.phase === 'synthesis').length, 1);
  const synthesisPausedTurnCount = synthesisPaused.turns.length;
  const resumedSynthesis = await api(`/api/group-sessions/${synthesisPauseDiscussion.id}/resume`, { method: 'POST', body: '{}' });
  assert.equal(resumedSynthesis.status, 'awaiting_confirmation');
  assert.equal(resumedSynthesis.turns.filter(turn => turn.phase === 'synthesis').length, 1);
  assert.equal(resumedSynthesis.turns.length, synthesisPausedTurnCount);

  const archivedGroup = await api(`/api/groups/${group.id}/archive`, { method: 'POST', body: '{}' });
  assert.equal(archivedGroup.status, 'archived');
  assert.equal((await api('/api/groups')).some(item => item.id === group.id), false);
  assert.equal((await api(`/api/group-sessions/${groupSession.id}`)).id, groupSession.id);
  assert.equal((await apiFailure(`/api/groups/${group.id}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: 'Must not start.' }) })).error.includes('active'), true);

  const timeout = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Timeout task', agent: 'claude-code', files: ['index.html'], acceptance: 'node --check server.mjs' }) });
  const timeoutCreationState = await api('/api/state');
  assert.equal(timeout.status, 'draft', `Timeout task was ${timeout.status} while mode was ${timeoutCreationState.mode}.`);
  await api(`/api/tasks/${timeout.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${timeout.id}/start`, { method: 'POST', body: '{}' });
  assert.equal((await waitForTaskStatus(timeout.id, 'failed')).recovery_note.includes('timed out'), true);

  const failed = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Exit code task', agent: 'antigravity', files: ['aod.config.example.json'], acceptance: 'node --check server.mjs' }) });
  await api(`/api/tasks/${failed.id}/prepare`, { method: 'POST', body: '{}' });
  await api(`/api/tasks/${failed.id}/start`, { method: 'POST', body: '{}' });
  assert.equal((await waitForTaskStatus(failed.id, 'failed')).last_exit_code, 7);
  const processHistory = await api('/api/processes?limit=500');
  const processKinds = new Set(processHistory.map(item => item.kind));
  for (const kind of ['task', 'group_turn', 'role_execute', 'role_review', 'role_repair', 'conflict_review', 'planner']) {
    assert.equal(processKinds.has(kind), true, `Process ledger is missing ${kind}.`);
  }
  assert.equal(processHistory.some(item => item.task_id === timeout.id && item.status === 'timed_out'), true);
  assert.equal(processHistory.some(item => item.task_id === failed.id && item.status === 'failed' && item.exit_code === 7), true);
  assert.equal(processHistory.some(item => item.run_id === groupRun.id && item.session_id === groupSession.id), true);
  assert.equal(processHistory.every(item => item.status !== 'running'), true, 'Settled integration fixtures left a running process ledger row.');
  const metrics = await api('/api/metrics');
  assert.equal(metrics.summary.invocations, processHistory.length);
  assert.equal(metrics.summary.timedOut >= 1, true);
  assert.equal(metrics.summary.failed >= 1, true);
  assert.equal(metrics.adapters.some(item => item.agent === 'codex' && item.invocations > 0), true);
  assert.equal(metrics.concurrency.capacity, 2);
  assert.equal(metrics.concurrency.peak >= 1, true);
  assert.equal(metrics.concurrency.utilization >= 0, true);
  assert.equal(Array.isArray(metrics.failures), true);
  const groupRunMetrics = await api(`/api/metrics?runId=${groupRun.id}`);
  assert.equal(groupRunMetrics.summary.invocations > 0, true);
  assert.deepEqual(groupRunMetrics.runs.map(item => item.runId), [groupRun.id]);
  assert.equal((await api('/api/state')).metrics.summary.invocations, metrics.summary.invocations);
  const consoleHtml = await readFile(join(process.cwd(), 'index.html'), 'utf8');
  for (const id of ['groupsBoard', 'openGroupDialog', 'groupDialog', 'groupConsole', 'groupMessages', 'groupConsensus']) {
    assert.equal(consoleHtml.includes(`id="${id}"`), true, `Console is missing #${id}.`);
  }
  const consoleScript = await readFile(join(process.cwd(), 'app.js'), 'utf8');
  assert.equal(consoleScript.includes('data-turn-recover'), true, 'Console is missing group-turn recovery controls.');
  assert.equal(consoleScript.includes('/api/group-turns/'), true, 'Console does not call the group-turn recovery API.');
  console.log('AOD integration test passed');
} finally {
  await stopDaemon();
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-worktrees`), { recursive: true, force: true });
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-runs`), { recursive: true, force: true });
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-group-sessions`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-role-reviews`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(join(dirname(fixture), `${basename(fixture)}.aod-conflict-reviews`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
