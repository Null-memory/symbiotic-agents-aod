const $ = selector => document.querySelector(selector);
const board = $('#taskBoard');
const notice = $('#notice');
const dialog = $('#taskDialog');
const runDialog = $('#runDialog');
let state = null;
let selectedTaskId = null;
let noticeTimer;
let plannedRun = null;
let stream = null;
let refreshTimer;

const statusLabels = {
  draft: '草稿', preparing: '准备中', ready: '就绪', running: '运行中', verifying: '验证中', merge_ready: '待合并', merging: '合并中', conflict_review: '冲突审查', recovery_required: '恢复确认', failed: '失败', cancelled: '已取消', merged: '已合并'
};
const modeCopy = { manual: '每一步由操作者触发', hybrid: '自动准备与验收，人工启动与合并', auto: '自动推进至合并，冲突仍需人工确认' };

function tell(message, kind = '') {
  notice.textContent = message;
  notice.className = `notice visible ${kind}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.className = 'notice'; }, 4200);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function statusLabel(status) { return statusLabels[status] || status; }
function modeLabel(mode) { return { manual: '人工', hybrid: '混合', auto: '自动' }[mode] || mode; }
async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function activeReview() { return state?.reviews.find(review => ['pending', 'running', 'suggested', 'failed'].includes(review.status)) || null; }
function selectedTask() { return state?.tasks.find(task => task.id === selectedTaskId) || state?.tasks.find(task => ['running', 'verifying', 'conflict_review', 'merge_ready'].includes(task.status)) || state?.tasks[0] || null; }

function taskActions(task) {
  const actions = [];
  if (task.status === 'draft') actions.push(`<button class="small primary" data-action="prepare" data-id="${task.id}">准备 worktree</button>`);
  if (task.status === 'ready') actions.push(`<button class="small primary" data-action="start" data-id="${task.id}">启动 Agent</button>`);
  if (task.status === 'verifying') actions.push(`<button class="small primary" data-action="verify" data-id="${task.id}">运行验收</button>`);
  if (task.status === 'merge_ready') actions.push(`<button class="small primary" data-action="merge" data-id="${task.id}">合并分支</button>`);
  if (task.status === 'conflict_review') actions.push(`<button class="small warn" data-action="review" data-id="${task.id}">请求审查建议</button>`);
  const next = state.transitions[task.status] || [];
  if (next.length) actions.push(`<select class="small secondary status-select" data-status="${task.id}" aria-label="更新 ${task.id} 状态"><option value="">更新状态</option>${next.map(value => `<option value="${value}">${statusLabel(value)}</option>`).join('')}</select>`);
  return actions.join('');
}

function renderRuns() {
  const runsBoard = $('#runsBoard');
  if (!state.runs?.length) { runsBoard.innerHTML = '<p class="empty">还没有运行单元。新建运行可让 Codex 先生成任务 DAG。</p>'; return; }
  runsBoard.innerHTML = state.runs.map(run => {
    const tasks = state.tasks.filter(task => task.run_id === run.id);
    const merged = tasks.filter(task => task.status === 'merged').length;
    const publish = run.status === 'ready_to_publish' ? `<button class="small primary" data-run-action="publish" data-run-id="${run.id}">发布 PR</button>` : '';
    const refresh = run.github_pr_number ? `<button class="small secondary" data-run-action="refresh" data-run-id="${run.id}">刷新 CI</button>` : '';
    return `<article class="run-card status-${run.status}"><div class="task-meta"><span>${run.id}</span><span>${modeLabel(run.mode)}</span></div><h3>${escapeHtml(run.title)}</h3><p>${escapeHtml(run.requirement)}</p><div class="run-meta"><span>${merged}/${tasks.length} 已合并</span><span>${escapeHtml(run.integration_branch)}</span><span>CI: ${escapeHtml(run.ci_status)}</span></div><div class="task-foot"><strong>${escapeHtml(run.status)}</strong><div>${publish}${refresh}${run.github_pr_url ? `<a class="small secondary" href="${escapeHtml(run.github_pr_url)}" target="_blank" rel="noreferrer">打开 PR</a>` : ''}</div></div></article>`;
  }).join('');
}

function renderBoard() {
  if (!state.tasks.length) { board.innerHTML = '<p class="empty">还没有任务。创建一个具有清晰文件边界的工作单元。</p>'; return; }
  board.innerHTML = state.tasks.map(task => `
    <article class="task-card status-${task.status} ${task.id === selectedTaskId ? 'selected' : ''}" data-select="${task.id}">
      <div class="task-meta"><span>${task.id}</span><span>${escapeHtml(task.agent)}</span></div>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="paths">${task.files.map(escapeHtml).join('<br>')}</p>
      <div class="task-info"><span>依赖：${task.dependsOn.length ? task.dependsOn.join(', ') : '无'}</span><span>尝试：${task.attempts}/${task.max_retries}</span>${task.worktree ? `<span title="${escapeHtml(task.worktree)}">worktree 已就绪</span>` : ''}</div>
      ${task.recovery_note ? `<p class="task-note">${escapeHtml(task.recovery_note)}</p>` : ''}
      <div class="task-foot"><strong>${statusLabel(task.status)}</strong><div>${taskActions(task)}</div></div>
    </article>`).join('');
}

function renderDetail() {
  const task = selectedTask();
  if (!task) { $('#taskDetailTitle').textContent = '选择任务'; $('#taskDetailStatus').textContent = 'IDLE'; $('#taskDetailMeta').textContent = '从队列选择一个任务以查看运行记录。'; $('#taskOutput').textContent = 'No task selected.'; $('#verificationResult').innerHTML = ''; return; }
  selectedTaskId = task.id;
  $('#taskDetailTitle').textContent = `${task.id} ${task.title}`;
  $('#taskDetailStatus').textContent = statusLabel(task.status);
  $('#taskDetailMeta').textContent = `${task.agent} | ${task.worktree || '尚未准备 worktree'} | ${task.branch}`;
  $('#taskOutput').textContent = task.output || '等待 Agent 输出。';
  $('#verificationResult').innerHTML = task.verification ? `<span>验收：${escapeHtml(task.verification.command)}</span><b>${escapeHtml(task.verification.commit || '')}</b><pre>${escapeHtml(task.verification.output)}</pre>` : '';
}

function renderReview() {
  const review = activeReview();
  const stateEl = $('#reviewState');
  if (!review) { stateEl.textContent = 'CLEAR'; $('#reviewContent').innerHTML = '<p class="empty">没有等待处理的冲突。</p>'; return; }
  stateEl.textContent = review.status.toUpperCase();
  const suggestions = review.suggestion ? `<details open><summary>Reviewer 建议</summary><pre>${escapeHtml(review.suggestion)}</pre></details>` : '<p class="review-wait">等待 Reviewer 输出。它只能提出建议，不能直接修改主线。</p>';
  const approve = review.status === 'suggested' ? `<label class="patch-label">确认后的 unified diff<textarea id="approvedPatch" placeholder="粘贴并核对 Reviewer 建议中的 diff"></textarea></label><button class="primary" data-review-approve="${review.id}">应用补丁并重新验收</button>` : '';
  $('#reviewContent').innerHTML = `<p class="review-files">${review.conflictFiles.map(escapeHtml).join('<br>')}</p>${suggestions}${approve}`;
}

function renderEvents() {
  $('#events').innerHTML = state.events.length ? state.events.slice(0, 12).map(event => `<div class="event"><time>${new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>${escapeHtml(event.message)}</span></div>`).join('') : '<p class="empty">暂无事件。</p>';
}

function render(nextState, health) {
  state = nextState;
  $('#workspace').textContent = state.workspace;
  $('#health').textContent = health.gitReady ? `Daemon online / ${state.integrationBranch}` : 'Git baseline required';
  $('#health').classList.toggle('warning', !health.gitReady);
  $('#modeDescription').textContent = modeCopy[state.mode];
  $('#maxConcurrency').value = state.maxConcurrency;
  $('#modeSwitch').querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
  $('#runCount').textContent = state.stats.runs;
  $('#agentCount').textContent = `${state.runtime.activeAgents} / ${state.maxConcurrency}`;
  $('#mergeCount').textContent = state.stats.mergeReady;
  $('#conflictCount').textContent = state.stats.conflicts;
  $('#dependsOn').innerHTML = '<option value="">无</option>' + state.tasks.filter(task => !['merged', 'cancelled'].includes(task.status)).map(task => `<option value="${task.id}">${task.id} ${escapeHtml(task.title)}</option>`).join('');
  renderRuns(); renderBoard(); renderDetail(); renderReview(); renderEvents();
}

async function refresh() {
  try {
    const [nextState, health, github] = await Promise.all([request('/api/state'), request('/api/health'), request('/api/github/status').catch(error => ({ error: error.message }))]);
    render(nextState, health);
    $('#githubStatus').textContent = github.authenticated ? `GitHub 已连接${github.remote ? ' / origin 已配置' : ' / 未配置远程'}` : github.available ? 'GitHub 未认证，点击连接' : 'GitHub CLI 未安装';
    $('#githubStatus').classList.toggle('warning', !github.authenticated);
  }
  catch (error) { tell(error.message, 'error'); }
}

function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 120); }
function connectStream() {
  if (stream) stream.close();
  stream = new EventSource('/api/stream');
  stream.addEventListener('event', scheduleRefresh);
  stream.addEventListener('log', scheduleRefresh);
  stream.onerror = () => { stream.close(); stream = null; setTimeout(connectStream, 2000); };
}

$('#openTaskDialog').addEventListener('click', () => dialog.showModal());
$('#openRunDialog').addEventListener('click', () => { plannedRun = null; $('#planPreview').hidden = true; runDialog.showModal(); });
$('#refresh').addEventListener('click', refresh);
$('#githubStatus').addEventListener('click', async () => { try { const result = await request('/api/github/connect', { method: 'POST', body: '{}' }); tell(result.message || 'GitHub 已连接。'); await refresh(); } catch (error) { tell(error.message, 'error'); } });
$('#modeSwitch').addEventListener('click', event => { const button = event.target.closest('[data-mode]'); if (button) $('#modeSwitch').dataset.pendingMode = button.dataset.mode; $('#modeSwitch').querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button)); });
$('#saveSettings').addEventListener('click', async () => {
  try { await request('/api/settings', { method: 'POST', body: JSON.stringify({ mode: $('#modeSwitch').dataset.pendingMode || state.mode, maxConcurrency: Number($('#maxConcurrency').value) }) }); tell('运行策略已更新。'); await refresh(); }
  catch (error) { tell(error.message, 'error'); }
});

$('#runForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return runDialog.close();
  const form = new FormData(event.currentTarget);
  try {
    plannedRun = await request('/api/runs/plan', { method: 'POST', body: JSON.stringify({ requirement: form.get('requirement'), planner: form.get('planner') }) });
    $('#planTitle').textContent = plannedRun.title;
    $('#planRequirement').textContent = plannedRun.requirement;
    $('#planTasks').value = JSON.stringify(plannedRun.tasks, null, 2);
    $('#planPreview').hidden = false;
  } catch (error) { tell(error.message, 'error'); }
});
$('#discardPlan').addEventListener('click', () => { plannedRun = null; $('#planPreview').hidden = true; });
$('#confirmPlan').addEventListener('click', async () => {
  try {
    const tasks = JSON.parse($('#planTasks').value);
    const run = await request('/api/runs', { method: 'POST', body: JSON.stringify({ planId: plannedRun.id, title: $('#planTitle').textContent, tasks }) });
    tell(`${run.id} 已创建，集成分支和任务已准备。`); runDialog.close(); await refresh();
  } catch (error) { tell(error.message || '任务 JSON 无效。', 'error'); }
});

$('#taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return dialog.close();
  const form = new FormData(event.currentTarget);
  try {
    const task = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: form.get('title'), agent: form.get('agent'), files: String(form.get('files')).split(',').map(value => value.trim()).filter(Boolean), dependsOn: form.get('dependsOn') ? [form.get('dependsOn')] : [], acceptance: form.get('acceptance'), timeoutMs: Number(form.get('timeoutMinutes')) * 60000, maxRetries: Number(form.get('maxRetries')) }) });
    selectedTaskId = task.id; dialog.close(); event.currentTarget.reset(); tell('任务已创建。当前模式会决定后续自动步骤。'); await refresh();
  } catch (error) { tell(error.message, 'error'); }
});

board.addEventListener('click', async event => {
  const card = event.target.closest('[data-select]'); if (card && !event.target.closest('button,select')) { selectedTaskId = card.dataset.select; renderBoard(); renderDetail(); return; }
  const action = event.target.closest('[data-action]'); if (!action) return;
  try {
    const endpoint = { prepare: 'prepare', start: 'start', verify: 'verify', merge: 'merge', review: 'review' }[action.dataset.action];
    await request(`/api/tasks/${action.dataset.id}/${endpoint}`, { method: 'POST', body: '{}' });
    selectedTaskId = action.dataset.id; tell(`${action.dataset.id} 已执行 ${action.textContent.trim()}。`); await refresh();
  } catch (error) { tell(error.message, 'error'); }
});
board.addEventListener('change', async event => {
  const select = event.target.closest('[data-status]'); if (!select?.value) return;
  try { await request(`/api/tasks/${select.dataset.status}/status`, { method: 'POST', body: JSON.stringify({ status: select.value }) }); tell('任务状态已更新。'); await refresh(); }
  catch (error) { select.value = ''; tell(error.message, 'error'); }
});
$('#runsBoard').addEventListener('click', async event => {
  const action = event.target.closest('[data-run-action]'); if (!action) return;
  try {
    const endpoint = action.dataset.runAction === 'publish' ? 'publish' : 'refresh';
    await request(`/api/runs/${action.dataset.runId}/${endpoint}`, { method: 'POST', body: '{}' });
    tell(endpoint === 'publish' ? '运行分支已推送并创建 PR。' : 'CI 状态已刷新。'); await refresh();
  } catch (error) { tell(error.message, 'error'); }
});
$('#reviewContent').addEventListener('click', async event => {
  const button = event.target.closest('[data-review-approve]'); if (!button) return;
  try { await request(`/api/reviews/${button.dataset.reviewApprove}/approve`, { method: 'POST', body: JSON.stringify({ patch: $('#approvedPatch').value }) }); tell('补丁已应用到任务 worktree，正在重新验收。'); await refresh(); }
  catch (error) { tell(error.message, 'error'); }
});

refresh();
connectStream();
