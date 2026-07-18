import { request, connectStream } from './ui/api.js';
import { createStore } from './ui/state.js';
import { createLayout } from './ui/layout.js';
import { createRunCenter } from './ui/run-center.js';
import { buildGroupTimelineItems, createGroupConsole } from './ui/group-console.js';
import { createDialogs } from './ui/dialogs.js';
import { createWorkspaceController } from './ui/workspaces.js';
import { buildSearchIndex, searchEntities } from './ui/command-search.js';
import { createActionState } from './ui/action-feedback.js';
import { deriveNextAction, deriveRunStage } from './ui/run-stage.js';
import { captureElementState, createRefreshScheduler, restoreElementState } from './ui/render-scheduler.js';

const $ = selector => document.querySelector(selector);
const board = $('#taskBoard');
const notice = $('#notice');
const dialog = $('#taskDialog');
const runDialog = $('#runDialog');
const groupsBoard = $('#groupsBoard');
const groupDialog = $('#groupDialog');
const groupSessionDialog = $('#groupSessionDialog');
const groupConsole = $('#groupConsole');

function mountPrimaryViews() {
  const placements = {
    groups: ['.agent-health-section', '.groups-section'],
    tasks: ['.tasks-section'],
    delivery: ['.runs-section']
  };
  for (const [view, selectors] of Object.entries(placements)) {
    const host = document.querySelector(`[data-view-host="${view}"]`);
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) host.append(element);
    }
  }
  const legacyGrid = document.querySelector('.work-grid');
  if (legacyGrid && !legacyGrid.children.length) legacyGrid.remove();
}

mountPrimaryViews();
let state = null;
let selectedTaskId = null;
let noticeTimer;
let plannedRun = null;
let editingGroupId = null;
let selectedGroupId = null;
let selectedGroupSessionId = null;
let selectedGroupSession = null;
let groupMessages = [];
let groupMessagesAfter = 0;
let groupDetailRequest = 0;
let groupConsoleOpen = false;
let commandIndex = [];
let commandResults = [];
let commandSelection = 0;
let currentNextAction = null;

const statusLabels = {
  draft: '草稿', preparing: '准备中', ready: '就绪', queued: '排队中', running: '运行中', discussing: '讨论中', paused: '已暂停', synthesizing: '汇总中', awaiting_confirmation: '待确认', executing: '执行中', awaiting_merge: '待合并', reviewing: '审查中', repairing: '修复中', verifying: '验证中', merge_ready: '待合并', merging: '合并中', conflict_review: '冲突审查', recovery_required: '恢复确认', completed: '已完成', passed: '已通过', pending: '等待中', skipped: '已跳过', failed: '失败', cancelled: '已取消', merged: '已合并'
};
const modeCopy = { manual: '每一步由操作者触发', hybrid: '自动准备与验收，人工启动与合并', auto: '自动准备、启动与验收，合并仍需人工确认' };
const roleLabels = { executor: '执行', reviewer: '检查', fixer: '修复', advisor: '顾问' };
const agentLabels = { codex: 'Codex', 'claude-code': 'Claude Code', antigravity: '反重力 2.0' };
const processKindCopy = { task: '独立任务', group_turn: '群组回合', role_execute: '角色执行', role_review: '角色检查', role_repair: '角色修复', conflict_review: '冲突审查', planner: '需求规划' };
const processStatusCopy = { running: '运行中', succeeded: '已完成', failed: '失败', timed_out: '已超时', cancelled: '已取消', recovery_required: '需恢复' };
const recoveryStateCopy = { live: '进程仍存活', stale: '进程已失联', unverifiable: '状态无法确认' };
const store = createStore({ data: null, health: null, selection: {} });
const actionFeedback = createActionState({ onChange: renderActionFeedback });
const layout = createLayout({
  onRouteChange(route) {
    if (route.taskId) selectedTaskId = route.taskId;
    if (state) { renderBoard(); renderDetail(); }
  }
});
const contextDock = layout.contextDock;
const groupConsoleUi = createGroupConsole({ root: groupConsole });
const dialogsUi = createDialogs();
const workspaceUi = createWorkspaceController({ root: document, request, onSelected: () => refresh(), onError: error => tell(error.message, 'error') });
const runCenterUi = createRunCenter({
  root: $('#contextInspector'), request, tell, onRefresh: refresh, getSelectedTask: selectedTask,
  onContext: (tab, taskId) => contextDock.open(tab, taskId),
  executeAction: (action, operation) => withActionFeedback(`${action.dataset.id}:${action.dataset.action}`, `正在${action.textContent.trim()}`, '操作已完成', operation)
});
void dialogsUi;

$('#contextInspector [data-context-tabs]').addEventListener('click', () => requestAnimationFrame(() => {
  if (contextDock.getState().tab === 'discussion') renderGroupConsole();
  else renderDetail();
}));

function tell(message, kind = '') {
  notice.textContent = message;
  notice.className = `notice visible ${kind}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.className = 'notice'; }, 4200);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function workspaceBadge(entity) {
  if (!entity?.workspaceId) return '';
  return `<span class="workspace-badge" title="${escapeHtml(entity.workspacePath || '')}">${escapeHtml(entity.workspaceName || entity.workspaceId)}</span>`;
}
function statusLabel(status) { return statusLabels[status] || status; }
function modeLabel(mode) { return { manual: '人工', hybrid: '混合', auto: '自动' }[mode] || mode; }
function activeReview() { return state?.reviews.find(review => ['pending', 'running', 'suggested', 'failed'].includes(review.status)) || null; }
function selectedTask() { return state?.tasks.find(task => task.id === selectedTaskId) || state?.tasks.find(task => ['running', 'verifying', 'conflict_review', 'merge_ready'].includes(task.status)) || state?.tasks[0] || null; }

function selectedRun() {
  const route = layout.getRoute();
  const task = selectedTask();
  return state?.runs.find(run => run.id === route.runId)
    || state?.runs.find(run => run.id === task?.run_id)
    || state?.runs.find(run => !['completed', 'archived'].includes(run.status))
    || state?.runs[0]
    || null;
}

function renderActionFeedback(key, value) {
  document.querySelectorAll('[data-action-key]').forEach(button => {
    if (button.dataset.actionKey !== key) return;
    button.disabled = value?.status === 'pending';
    let feedback = button.parentElement?.querySelector(`.action-feedback[data-feedback-key="${key}"]`);
    if (!value) { feedback?.remove(); return; }
    if (!feedback) {
      feedback = document.createElement('span');
      feedback.className = 'action-feedback';
      feedback.dataset.feedbackKey = key;
      button.parentElement?.append(feedback);
    }
    feedback.className = `action-feedback is-${value.status}`;
    feedback.textContent = value.message;
  });
}

function applyActionFeedback() {
  for (const [key, value] of actionFeedback.entries()) renderActionFeedback(key, value);
}

async function withActionFeedback(key, pendingMessage, successMessage, operation) {
  actionFeedback.start(key, pendingMessage);
  try {
    const result = await operation();
    actionFeedback.succeed(key, successMessage);
    return result;
  } catch (error) {
    actionFeedback.fail(key, error);
    throw error;
  }
}

function taskActions(task) {
  const actions = [];
  if (task.status === 'draft') actions.push(`<button class="small primary" data-action="prepare" data-action-key="${task.id}:prepare" data-id="${task.id}">准备 worktree</button>`);
  if (task.status === 'ready') actions.push(`<button class="small primary" data-action="start" data-action-key="${task.id}:start" data-id="${task.id}">启动 Agent</button>`);
  if (task.status === 'verifying') actions.push(`<button class="small primary" data-action="verify" data-action-key="${task.id}:verify" data-id="${task.id}">运行验收</button>`);
  if (task.status === 'merge_ready') actions.push(`<button class="small primary" data-action="merge" data-action-key="${task.id}:merge" data-id="${task.id}">合并分支</button>`);
  if (task.status === 'conflict_review') actions.push(`<button class="small warn" data-action="review" data-action-key="${task.id}:review" data-id="${task.id}">请求审查建议</button>`);
  const next = state.transitions[task.status] || [];
  if (next.length) actions.push(`<select class="small secondary status-select" data-status="${task.id}" aria-label="更新 ${task.id} 状态"><option value="">更新状态</option>${next.map(value => `<option value="${value}">${statusLabel(value)}</option>`).join('')}</select>`);
  return actions.join('');
}

function renderRuns() {
  const runsBoard = $('#runsBoard');
  const overviewBoard = $('#runOverviewBoard');
  if (!state.runs?.length) {
    const empty = '<p class="empty">还没有运行单元。新建运行可让 Codex 先生成任务 DAG。</p>';
    runsBoard.innerHTML = empty;
    overviewBoard.innerHTML = empty;
    return;
  }
  overviewBoard.innerHTML = state.runs.map(run => {
    const tasks = state.tasks.filter(task => task.run_id === run.id);
    const completed = tasks.filter(task => ['merged', 'completed'].includes(task.status)).length;
    return `<article class="run-overview-row"><div><span>${escapeHtml(run.id)}</span><strong>${escapeHtml(run.title)}</strong></div><div class="run-progress"><span>${completed}/${tasks.length} 任务</span><span>${escapeHtml(run.integration_branch)}</span></div><b class="status-pill">${escapeHtml(run.status)}</b></article>`;
  }).join('');
  runsBoard.innerHTML = state.runs.map(run => {
    const tasks = state.tasks.filter(task => task.run_id === run.id);
    const merged = tasks.filter(task => task.status === 'merged').length;
    const publish = run.status === 'ready_to_publish' ? `<button class="small primary" data-action-key="run:${run.id}:publish" data-run-action="publish" data-run-id="${run.id}">发布 PR</button>` : '';
    const refresh = run.github_pr_number ? `<button class="small secondary" data-action-key="run:${run.id}:refresh" data-run-action="refresh" data-run-id="${run.id}">刷新 CI</button>` : '';
    return `<article class="run-card status-${run.status}"><div class="task-meta"><span>${run.id}</span><span>${modeLabel(run.mode)}</span>${workspaceBadge(run)}</div><h3>${escapeHtml(run.title)}</h3><p>${escapeHtml(run.requirement)}</p><div class="run-meta"><span>${merged}/${tasks.length} 已合并</span><span>${escapeHtml(run.integration_branch)}</span><span>CI: ${escapeHtml(run.ci_status)}</span></div><div class="task-foot"><strong>${escapeHtml(run.status)}</strong><div>${publish}${refresh}${run.github_pr_url ? `<a class="small secondary" href="${escapeHtml(run.github_pr_url)}" target="_blank" rel="noreferrer">打开 PR</a>` : ''}</div></div></article>`;
  }).join('');
}

function renderBoard() {
  if (!state.tasks.length) { board.innerHTML = '<p class="empty">还没有任务。创建一个具有清晰文件边界的工作单元。</p>'; return; }
  board.innerHTML = state.tasks.map(task => `
    <article class="task-card status-${task.status} ${task.id === selectedTaskId ? 'selected' : ''}" data-select="${task.id}">
      <div class="task-meta"><span>${task.id}</span><span>${escapeHtml(task.agent)}</span>${workspaceBadge(task)}</div>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="paths">${task.files.map(escapeHtml).join('<br>')}</p>
      <div class="task-info"><span>依赖：${task.dependsOn.length ? task.dependsOn.join(', ') : '无'}</span><span>尝试：${task.attempts}/${task.max_retries}</span>${task.worktree ? `<span title="${escapeHtml(task.worktree)}">worktree 已就绪</span>` : ''}</div>
      ${task.recovery_note ? `<p class="task-note">${escapeHtml(task.recovery_note)}</p>` : ''}
      <div class="task-foot"><strong>${statusLabel(task.status)}</strong><div>${taskActions(task)}</div></div>
    </article>`).join('');
}

function renderDetail() {
  const task = selectedTask();
  const taskHeaderActive = contextDock.getState().tab !== 'discussion';
  if (!task) { if (taskHeaderActive) { $('#taskDetailTitle').textContent = '选择任务'; $('#taskDetailStatus').textContent = 'IDLE'; $('#taskDetailMeta').textContent = '从队列选择一个任务以查看运行记录。'; } $('#taskOutput').textContent = 'No task selected.'; $('#verificationResult').innerHTML = '<p class="empty">尚无验收结果。</p>'; $('#inspectorOverview').innerHTML = '<div class="inspector-empty"><span>选择任务后显示 commit、worktree、依赖和可执行操作。</span></div>'; return; }
  selectedTaskId = task.id;
  if (taskHeaderActive) {
    $('#taskDetailTitle').textContent = `${task.id} ${task.title}`;
    $('#taskDetailStatus').textContent = statusLabel(task.status);
    $('#taskDetailMeta').textContent = `${task.agent} | ${task.worktree || '尚未准备 worktree'} | ${task.branch}`;
  }
  runCenterUi.setOutput(task.output || '等待 Agent 输出。');
  $('#verificationResult').innerHTML = task.verification ? `<span>验收：${escapeHtml(task.verification.command)}</span><b>${escapeHtml(task.verification.commit || '')}</b><pre>${escapeHtml(task.verification.output)}</pre>` : '';
  $('#inspectorOverview').innerHTML = `<dl class="task-overview-grid"><div><dt>Agent</dt><dd>${escapeHtml(task.agent)}</dd></div><div><dt>状态</dt><dd>${statusLabel(task.status)}</dd></div><div><dt>Commit</dt><dd>${shortCommit(task.verified_commit)}</dd></div><div><dt>分支</dt><dd>${escapeHtml(task.branch || '—')}</dd></div><div class="wide"><dt>绑定项目</dt><dd title="${escapeHtml(task.workspacePath || '')}">${escapeHtml(task.workspaceName || task.workspaceId || '—')}</dd></div><div class="wide"><dt>Worktree</dt><dd title="${escapeHtml(task.worktree || '')}">${escapeHtml(task.worktree || '尚未准备')}</dd></div><div class="wide"><dt>文件范围</dt><dd>${task.files.map(escapeHtml).join(', ')}</dd></div></dl><div class="inspector-actions">${taskActions(task) || '<span class="empty-inline">当前没有可执行操作</span>'}</div>`;
}

function renderApprovals() {
  const approvals = state.approvals || [];
  const kindCopy = {
    task_prepare: '准备任务', task_start: '启动 Agent', task_verify: '运行验收', task_merge: '合并任务',
    conflict_review: '冲突审查', conflict_patch: '确认补丁', task_recovery: '任务恢复', group_start: '启动讨论',
    group_consensus: '确认 DAG', group_recovery: '群组恢复', run_publish: '发布 PR', pr_merge: '合并 PR'
  };
  const actionCopy = { prepare: '准备', start: '启动', verify: '验收', merge: '合并', review: '请求审查', start_group: '启动讨论', publish: '发布 PR', open: '查看详情' };
  $('#approvalQueueLabel').textContent = `${approvals.length} PENDING`;
  if (!approvals.length) {
    $('#approvalBoard').innerHTML = '<p class="empty">当前没有等待确认的操作。</p>';
    return;
  }
  $('#approvalBoard').innerHTML = approvals.map(item => {
    const actions = item.actions.map(action => {
      if (action === 'external') return `<a class="small secondary" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">打开 GitHub</a>`;
      if (action === 'open') return `<button class="small secondary" type="button" data-approval-open="${escapeHtml(item.id)}">${actionCopy[action]}</button>`;
      return `<button class="small ${item.risk === 'high' ? 'warn' : 'primary'}" type="button" data-action-key="approval:${escapeHtml(item.id)}:${escapeHtml(action)}" data-approval-action="${escapeHtml(action)}" data-approval-id="${escapeHtml(item.id)}">${actionCopy[action] || escapeHtml(action)}</button>`;
    }).join('');
    return `<article class="approval-row risk-${escapeHtml(item.risk)}">
      <div class="approval-kind"><span>${escapeHtml(kindCopy[item.kind] || item.kind)}</span><b>${escapeHtml(item.entityId)}</b>${workspaceBadge(item)}</div>
      <div class="approval-copy"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p></div>
      <div class="approval-meta"><span>${item.runId ? escapeHtml(item.runId) : 'LOCAL'}</span><time>${item.createdAt ? new Date(item.createdAt).toLocaleString() : '—'}</time></div>
      <div class="approval-actions">${actions}</div>
    </article>`;
  }).join('');
}

function renderRunCommand() {
  const run = selectedRun();
  const tasks = run ? state.tasks.filter(task => task.run_id === run.id) : [];
  const approvals = (state.approvals || []).filter(item => !run || !item.runId || item.runId === run.id);
  const stage = deriveRunStage(run, tasks, approvals);
  $('#runStageBar').querySelectorAll('[data-stage]').forEach(element => {
    const item = stage.stages.find(candidate => candidate.key === element.dataset.stage);
    element.className = `run-stage is-${item?.state || 'upcoming'}`;
    element.setAttribute('aria-current', item?.state === 'current' ? 'step' : 'false');
  });
  currentNextAction = deriveNextAction(run, approvals);
  const passive = currentNextAction.kind === 'monitor';
  $('#nextAction').innerHTML = `<div><span>NEXT ACTION${run ? ` / ${escapeHtml(run.id)}` : ''}</span><strong>${escapeHtml(currentNextAction.label)}</strong></div>${passive ? '<span class="next-action-passive">实时等待</span>' : `<button class="primary compact" type="button" data-next-action="${escapeHtml(currentNextAction.kind)}">打开</button>`}`;
}

function renderCommandResults() {
  const root = $('#commandSearchResults');
  if (!commandResults.length) {
    root.innerHTML = '<p class="empty">没有匹配结果。</p>';
    root.hidden = !$('#commandSearch').value.trim();
    return;
  }
  const typeCopy = { run: '运行', task: '任务', group: '群组', session: '会话', adapter: 'Agent' };
  root.innerHTML = commandResults.map((result, index) => `<button class="command-search-option ${index === commandSelection ? 'active' : ''}" type="button" role="option" aria-selected="${index === commandSelection}" data-command-result="${index}"><strong>${escapeHtml(result.title)}</strong><span>${escapeHtml(typeCopy[result.type] || result.type)} / ${escapeHtml(result.id)}</span><small>${escapeHtml(result.meta)}</small></button>`).join('');
  root.hidden = false;
}

function refreshCommandIndex() {
  commandIndex = buildSearchIndex({
    runs: state.runs,
    tasks: state.tasks,
    groups: state.groups,
    groupSessions: state.groupSessions,
    adapters: state.agentHealth || state.agents
  });
}

async function selectCommandResult(result) {
  if (!result) return;
  $('#commandSearch').value = '';
  $('#commandSearchResults').hidden = true;
  if (result.type === 'session') return openGroupSession(result.entityId, state.groupSessions.find(session => session.id === result.entityId)?.group_id);
  if (result.contextTab) contextDock.open(result.contextTab, result.entityId);
  layout.setRoute(result.route);
  if (result.type === 'task') { selectedTaskId = result.entityId; renderBoard(); renderDetail(); }
  if (result.type === 'adapter') document.querySelector('.agent-health-section')?.setAttribute('open', '');
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
  if (value < 3600000) return `${(value / 60000).toFixed(1)} min`;
  return `${(value / 3600000).toFixed(1)} h`;
}

function formatPercent(value) { return `${Math.round(Math.max(0, Number(value) || 0) * 100)}%`; }

function relativeAge(value) {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at)) return '无输出';
  const age = Math.max(0, Date.now() - at);
  if (age < 5000) return '刚刚';
  if (age < 60000) return `${Math.floor(age / 1000)} 秒前`;
  if (age < 3600000) return `${Math.floor(age / 60000)} 分钟前`;
  return `${Math.floor(age / 3600000)} 小时前`;
}

function renderMetrics() {
  const metrics = state.metrics;
  const board = $('#metricsBoard');
  if (!metrics?.summary) {
    board.innerHTML = '<p class="empty">尚无可汇总的 Agent 运行记录。</p>';
    return;
  }
  const summary = metrics.summary;
  const elapsed = Math.max(0, Date.parse(metrics.range?.to) - Date.parse(metrics.range?.from));
  $('#metricsWindow').textContent = elapsed ? `${Math.round(elapsed / 3600000)}H WINDOW` : 'CURRENT';
  const cells = [
    ['调用', summary.invocations, `${summary.active} ACTIVE`],
    ['成功率', formatPercent(summary.successRate), `${summary.succeeded}/${summary.terminal} TERMINAL`],
    ['超时率', formatPercent(summary.timeoutRate), `${summary.timedOut} TIMEOUT`],
    ['平均耗时', formatDuration(summary.avgDurationMs), 'TERMINAL AVG'],
    ['重试', summary.retries, `${summary.failed} FAILED`],
    ['槽位利用率', formatPercent(metrics.concurrency?.utilization), `PEAK ${metrics.concurrency?.peak || 0}/${metrics.concurrency?.capacity || state.maxConcurrency}`]
  ];
  const summaryHtml = `<div class="metrics-summary">${cells.map(([label, value, meta]) => `<div class="metric-cell"><span>${label}</span><strong>${value}</strong><small>${meta}</small></div>`).join('')}</div>`;
  const adapterHtml = metrics.adapters?.length
    ? `<div class="metrics-adapters">${metrics.adapters.map(item => `<div class="metrics-adapter-row">
        <div><span class="agent-signal status-${item.active ? 'running' : item.failed || item.timedOut ? 'warning' : 'succeeded'}"></span><strong>${escapeHtml(agentLabels[item.agent] || item.agent)}</strong><small>${item.invocations} INVOCATIONS</small></div>
        <div class="metric-bar"><i style="--metric-fill:${Math.min(100, Math.max(0, Number(item.successRate) * 100))}%"></i><span>${formatPercent(item.successRate)} 成功</span></div>
        <span><b>${formatPercent(item.timeoutRate)}</b> 超时</span><span><b>${formatDuration(item.avgDurationMs)}</b> 均耗</span><span><b>${item.retries}</b> 重试</span>
      </div>`).join('')}</div>`
    : '<p class="empty">当前时间窗口没有适配器调用。</p>';
  board.innerHTML = summaryHtml + adapterHtml;
}

function renderProcessMonitor() {
  const processes = state.runtime?.processes || [];
  $('#processCount').textContent = `${processes.length} RECENT`;
  if (!processes.length) {
    $('#processMonitor').innerHTML = '<p class="empty">当前没有 Agent 进程记录。</p>';
    return;
  }
  $('#processMonitor').innerHTML = processes.map(item => {
    const entity = item.task_id
      ? `<button type="button" data-process-task="${escapeHtml(item.task_id)}">${escapeHtml(item.task_id)}</button>`
      : item.session_id
        ? `<button type="button" data-process-session="${escapeHtml(item.session_id)}">${escapeHtml(item.session_id)}</button>`
        : `<span>${escapeHtml(item.entity_id)}</span>`;
    const startedAt = Date.parse(item.started_at || '');
    const finishedAt = Date.parse(item.finished_at || '') || Date.now();
    const recovery = item.recovery_state ? recoveryStateCopy[item.recovery_state] || item.recovery_state : '';
    const latestSignal = item.last_output_at || item.heartbeat_at;
    return `<article class="process-row status-${escapeHtml(item.status)}" title="${escapeHtml(item.id)}">
      <div class="process-identity"><span class="process-signal" aria-hidden="true"></span><div><strong>${escapeHtml(agentLabels[item.agent] || item.agent)}</strong><small>${escapeHtml(processKindCopy[item.kind] || item.kind)}</small></div></div>
      <div class="process-entity"><span>ENTITY</span>${entity}</div>
      <div class="process-runtime"><span>PID / TRY</span><b>${item.pid || '—'} / ${item.attempt}</b></div>
      <div class="process-timing"><span>HEARTBEAT / OUTPUT</span><b>${relativeAge(item.heartbeat_at)} / ${relativeAge(item.last_output_at)}</b></div>
      <div class="process-outcome"><span class="status-pill">${escapeHtml(processStatusCopy[item.status] || item.status)}</span><b>${escapeHtml(recovery || formatDuration(Number.isFinite(startedAt) ? finishedAt - startedAt : 0))}</b>${item.terminal_reason ? `<small title="${escapeHtml(item.terminal_reason)}">${escapeHtml(item.terminal_reason)}</small>` : `<small>${escapeHtml(relativeAge(latestSignal))}</small>`}</div>
    </article>`;
  }).join('');
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

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function shortCommit(value) { return value ? String(value).slice(0, 8) : '—'; }
function latestGroupSession(groupId) { return (state?.groupSessions || []).find(session => session.group_id === groupId) || null; }
function groupById(groupId) { return (state?.groups || []).find(group => group.id === groupId) || null; }
function memberName(memberId) { return selectedGroupSession?.members.find(member => member.id === memberId)?.displayName || memberId || '系统'; }

function renderGroups() {
  const groups = state?.groups || [];
  if (!groups.length) { groupsBoard.innerHTML = '<p class="empty">还没有 Agent 群组。创建后可发起多轮讨论并确认执行 DAG。</p>'; return; }
  groupsBoard.innerHTML = groups.map(group => {
    const latest = latestGroupSession(group.id);
    const members = group.members || [];
    const roster = members.map(member => `<span class="group-role"><b>${escapeHtml(member.display_name)}</b><i>${escapeHtml(roleLabels[member.role] || member.role)}</i>${member.is_moderator ? '<em>主持</em>' : ''}</span>`).join('');
    const latestCopy = latest
      ? `<div class="group-latest"><span>${escapeHtml(latest.id)} / ${statusLabel(latest.status)} ${workspaceBadge(latest)}</span><strong>ROUND ${latest.current_round}/${latest.max_rounds}</strong><p>${escapeHtml(latest.title || latest.requirement)}</p></div>`
      : '<div class="group-latest empty-session"><span>NO SESSION</span><p>尚未创建会话</p></div>';
    return `<article class="group-card status-${escapeHtml(latest?.status || 'idle')}">
      <div class="task-meta"><span>${escapeHtml(group.id)}</span><span>${members.length} MEMBERS</span></div>
      <h3>${escapeHtml(group.name)}</h3><p class="group-description">${escapeHtml(group.description || '未设置群组描述。')}</p>
      <div class="group-roster">${roster}</div>${latestCopy}
      <div class="group-card-actions"><button class="small secondary" data-group-action="open" data-group-id="${escapeHtml(group.id)}">打开</button><button class="small primary" data-group-action="session" data-group-id="${escapeHtml(group.id)}">新会话</button><button class="small warn" data-group-action="archive" data-group-id="${escapeHtml(group.id)}">归档</button></div>
    </article>`;
  }).join('');
}

function renderAgentHealth() {
  const board = $('#agentHealthBoard');
  const rows = state.agentHealth || [];
  if (!rows.length) {
    board.innerHTML = '<p class="empty">尚无 Agent 适配器状态。</p>';
    return;
  }
  const statusCopy = { ready: '可用', warning: '需认证配置', error: '检查失败', unconfigured: '未配置', not_checked: '未检查' };
  const authCopy = { ready: '已通过', failed: '失败', unknown: '未配置', not_checked: '未检查' };
  board.innerHTML = rows.map(item => `<article class="agent-health-row status-${escapeHtml(item.status)}">
    <div class="agent-health-identity"><span class="agent-health-signal" aria-hidden="true"></span><div><strong>${escapeHtml(agentLabels[item.agent] || item.agent)}</strong><span title="${escapeHtml(item.resolved_path || item.command || '')}">${escapeHtml(item.resolved_path || item.command || '未配置命令')}</span></div></div>
    <div><span>VERSION</span><b>${escapeHtml(item.version || '—')}</b></div>
    <div><span>AUTH</span><b>${escapeHtml(authCopy[item.auth_status] || item.auth_status)}</b></div>
    <div><span>LATENCY</span><b>${item.checked_at ? `${Number(item.latency_ms || 0)} ms` : '—'}</b></div>
    <div class="agent-health-result"><span class="status-pill">${escapeHtml(statusCopy[item.status] || item.status)}</span><small title="${escapeHtml(item.message || '')}">${escapeHtml(item.message || '')}</small></div>
    <button class="secondary small" type="button" data-agent-health="${escapeHtml(item.agent)}">检查</button>
  </article>`).join('');
}

function renderGroupMembers() {
  const members = selectedGroupSession?.members || [];
  const turns = selectedGroupSession?.turns || [];
  $('#groupConcurrency').textContent = `${state?.runtime?.activeGroupTurns || 0} / ${state?.maxConcurrency || 0}`;
  if (!members.length) { $('#groupMembers').innerHTML = '<p class="empty">会话成员快照为空。</p>'; return; }
  $('#groupMembers').innerHTML = members.map(member => {
    const memberTurns = turns.filter(turn => turn.member_id === member.id);
    const latestTurn = memberTurns[memberTurns.length - 1];
    return `<div class="group-member-row">
      <span class="turn-signal status-${escapeHtml(latestTurn?.status || 'idle')}" aria-hidden="true"></span>
      <div><strong>${escapeHtml(member.displayName)}</strong><span>${escapeHtml(agentLabels[member.agent] || member.agent)}</span></div>
      <div class="member-runtime"><b>${escapeHtml(roleLabels[member.role] || member.role)}${member.isModerator ? ' / 主持' : ''}</b><span>${latestTurn ? `R${latestTurn.round} ${escapeHtml(latestTurn.phase)} / ${statusLabel(latestTurn.status)}` : '等待发言'}</span></div>
    </div>`;
  }).join('');
}

function renderGroupMessages() {
  const container = $('#groupMessages');
  const stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  const timelineItems = buildGroupTimelineItems({ messages: groupMessages, turns: selectedGroupSession?.turns || [] });
  if (!timelineItems.length) {
    const emptyCopy = selectedGroupSession?.status === 'draft' ? '讨论尚未启动。' : '正在准备讨论回合…';
    container.innerHTML = `<p class="empty">${emptyCopy}</p>`;
  } else container.innerHTML = timelineItems.map(item => {
    if (item.kind === 'message') return `<div class="group-message ${item.sender_kind === 'operator' ? 'operator' : 'member'}">
      <div class="group-message-meta"><strong>${escapeHtml(item.sender_kind === 'operator' ? '操作者' : memberName(item.sender_member_id))}</strong><span>R${item.round} / ${escapeHtml(item.phase)}</span><time>${formatTime(item.at)}</time></div>
      <div class="group-message-content">${escapeHtml(item.content)}</div>
    </div>`;
    const statusCopy = {
      queued: '正在等待可用的 Agent 并发槽位。',
      running: '正在生成本轮内容，完成后将在这里显示完整回复。',
      recovery_required: '本回合需要人工恢复确认。'
    }[item.status] || statusLabel(item.status);
    return `<div class="group-message group-turn-progress status-${escapeHtml(item.status)}">
      <div class="group-message-meta"><strong>${escapeHtml(memberName(item.senderMemberId))}</strong><span>R${item.round} / ${escapeHtml(item.phase)}</span><time>${formatDuration(item.elapsedMs)}</time></div>
      <div class="group-message-content">${escapeHtml(statusCopy)}</div>
      <small>CLI 可能在退出前缓冲输出；回合状态仍会持续保留。</small>
    </div>`;
  }).join('');
  if (stickToBottom) container.scrollTop = container.scrollHeight;
}

function renderGroupControls() {
  const session = selectedGroupSession;
  const controls = $('#groupSessionControls');
  const input = $('#groupMessageInput');
  if (!session) {
    $('#groupSessionMeta').innerHTML = '<p class="empty">没有打开的群组会话。</p>';
    controls.innerHTML = '';
    input.disabled = true;
    return;
  }
  $('#groupSessionMeta').innerHTML = `<dl>
    <div><dt>会话</dt><dd>${escapeHtml(session.id)}</dd></div><div><dt>状态</dt><dd>${statusLabel(session.status)}</dd></div>
    <div><dt>轮次</dt><dd>${session.current_round} / ${session.max_rounds}</dd></div><div><dt>修复预算</dt><dd>${session.max_repairs}</dd></div>
    <div><dt>运行</dt><dd>${escapeHtml(session.run_id || '未生成')}</dd></div><div><dt>更新</dt><dd>${formatTime(session.updated_at)}</dd></div>
  </dl><p>${escapeHtml(session.requirement)}</p>${session.recovery_note ? `<div class="group-recovery-note">${escapeHtml(session.recovery_note)}</div>` : ''}`;
  const buttons = [];
  const recoveryTurns = (session.turns || []).filter(turn => turn.status === 'recovery_required');
  if (session.status === 'draft') buttons.push('<button class="primary" data-session-action="start">启动讨论</button>');
  if (['discussing', 'synthesizing'].includes(session.status)) buttons.push(`<button class="secondary" data-session-action="pause" ${session.pause_requested ? 'disabled' : ''}>${session.pause_requested ? '等待暂停' : '暂停'}</button>`);
  if (session.status === 'paused' || (session.status === 'recovery_required' && !recoveryTurns.length)) buttons.push(`<button class="primary" data-session-action="resume">${session.run_id ? '重试角色流水线' : '恢复讨论'}</button>`);
  if (session.status === 'recovery_required' && recoveryTurns.length) {
    buttons.push(`<div class="turn-recovery-list">${recoveryTurns.map(turn => {
      const member = session.members.find(item => item.id === turn.member_id);
      const replacements = session.members.filter(item => item.id !== turn.member_id).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.displayName)}</option>`).join('');
      return `<div class="turn-recovery-row"><div><strong>${escapeHtml(member?.displayName || turn.member_id)}</strong><span>R${turn.round} / ${escapeHtml(turn.phase)}</span></div><div class="turn-recovery-actions"><button class="small primary" type="button" data-turn-recover="retry" data-turn-id="${escapeHtml(turn.id)}">重试</button>${turn.phase === 'synthesis' ? '' : `<button class="small secondary" type="button" data-turn-recover="skip" data-turn-id="${escapeHtml(turn.id)}">跳过</button>`}<select data-turn-replacement="${escapeHtml(turn.id)}" aria-label="替换 ${escapeHtml(member?.displayName || turn.member_id)}">${replacements}</select><button class="small secondary" type="button" data-turn-recover="replace" data-turn-id="${escapeHtml(turn.id)}">替换</button></div></div>`;
    }).join('')}</div>`);
  }
  if (!['cancelled', 'completed', 'failed', 'awaiting_merge'].includes(session.status)) buttons.push('<button class="warn" data-session-action="cancel">取消会话</button>');
  if (session.run_id) buttons.push('<button class="secondary" data-group-run-link type="button">查看运行</button>');
  buttons.push('<button class="secondary" data-group-config type="button">编辑群组</button>');
  controls.innerHTML = buttons.join('');
  input.disabled = ['cancelled', 'completed', 'failed'].includes(session.status);
}

function roleSelect(taskIndex, field, role, selectedId, allowEmpty = false) {
  const candidates = (selectedGroupSession?.members || []).filter(member => member.role === role);
  const empty = allowEmpty ? '<option value="">不启用</option>' : '';
  return `<select data-consensus-field="${field}" aria-label="任务 ${taskIndex + 1} ${roleLabels[role]}">${empty}${candidates.map(member => `<option value="${escapeHtml(member.id)}" ${member.id === selectedId ? 'selected' : ''}>${escapeHtml(member.displayName)}</option>`).join('')}</select>`;
}

function renderConsensusList(label, items) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<div><b>${label}</b><ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`;
}

function renderGroupConsensus() {
  const content = $('#groupConsensusContent');
  const session = selectedGroupSession;
  const consensus = session?.consensus;
  if (!session) { content.innerHTML = '<p class="empty">讨论结束后将在这里生成可确认的执行 DAG。</p>'; return; }
  if (!consensus) {
    const copy = ['discussing', 'synthesizing'].includes(session.status) ? `第 ${session.current_round}/${session.max_rounds} 轮进行中，等待主持者汇总。` : session.status === 'draft' ? '启动讨论后将生成任务 DAG。' : '当前会话还没有可展示的共识。';
    content.innerHTML = `<p class="empty">${escapeHtml(copy)}</p>`;
    return;
  }
  const editable = session.status === 'awaiting_confirmation';
  const memberMap = new Map(session.members.map(member => [member.id, member]));
  const rows = consensus.tasks.map((task, index) => {
    const assignment = session.assignments[index];
    const runtimeTask = assignment ? state.tasks.find(item => item.id === assignment.task_id) : null;
    const commit = assignment?.review_commit || runtimeTask?.verified_commit;
    const taskCell = editable
      ? `<span class="dag-key">${escapeHtml(task.key)}</span><input data-consensus-field="title" value="${escapeHtml(task.title)}" aria-label="${escapeHtml(task.key)} 标题" /><textarea data-consensus-field="description" rows="2" aria-label="${escapeHtml(task.key)} 描述">${escapeHtml(task.description || '')}</textarea>`
      : `<span class="dag-key">${escapeHtml(task.key)}</span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.description || '')}</small>`;
    const scopeCell = editable
      ? `<input data-consensus-field="files" value="${escapeHtml((task.files || []).join(', '))}" aria-label="${escapeHtml(task.key)} 文件" /><input data-consensus-field="dependsOn" value="${escapeHtml((task.dependsOn || []).join(', '))}" aria-label="${escapeHtml(task.key)} 依赖" />`
      : `<span>${escapeHtml((task.files || []).join(', '))}</span><small>依赖：${escapeHtml((task.dependsOn || []).join(', ') || '无')}</small>`;
    const gateCell = editable
      ? `<input data-consensus-field="acceptance" value="${escapeHtml(task.acceptance || '')}" aria-label="${escapeHtml(task.key)} 验收命令" /><input data-consensus-field="risk" value="${escapeHtml(task.risk || '')}" aria-label="${escapeHtml(task.key)} 风险" />`
      : `<span>${escapeHtml(task.acceptance || '未设置')}</span><small>${escapeHtml(task.risk || '无风险说明')}</small>`;
    const roleCell = editable
      ? `${roleSelect(index, 'executorMemberId', 'executor', task.executorMemberId)}${roleSelect(index, 'reviewerMemberId', 'reviewer', task.reviewerMemberId)}${roleSelect(index, 'fixerMemberId', 'fixer', task.fixerMemberId, session.max_repairs === 0)}`
      : `<span>执行 / ${escapeHtml(memberMap.get(task.executorMemberId)?.displayName || '—')}</span><span>检查 / ${escapeHtml(memberMap.get(task.reviewerMemberId)?.displayName || '—')}</span><span>修复 / ${escapeHtml(memberMap.get(task.fixerMemberId)?.displayName || '—')}</span>`;
    return `<tr data-consensus-task="${index}"><td data-label="任务">${taskCell}</td><td data-label="范围 / 依赖">${scopeCell}</td><td data-label="验收 / 风险">${gateCell}</td><td data-label="角色映射" class="dag-roles">${roleCell}</td><td data-label="执行状态" class="dag-runtime"><b>${statusLabel(assignment?.stage || (editable ? 'pending' : session.status))}</b><span>Commit ${shortCommit(commit)}</span><span>修复 ${assignment?.repair_count || 0}/${assignment?.max_repairs ?? session.max_repairs}</span></td></tr>`;
  }).join('');
  const title = editable ? `<label class="consensus-title-field">运行标题<input id="groupConsensusRunTitle" value="${escapeHtml(consensus.title || '')}" maxlength="120" /></label>` : `<h4>${escapeHtml(consensus.title || '群组共识')}</h4>`;
  content.innerHTML = `<form id="groupConsensusForm">
    <div class="consensus-summary">${title}<p>${escapeHtml(consensus.summary || '')}</p><div class="consensus-notes">${renderConsensusList('决策', consensus.decisions)}${renderConsensusList('风险', consensus.risks)}${renderConsensusList('分歧', consensus.disagreements)}</div></div>
    <div class="consensus-table-wrap"><table class="consensus-table"><thead><tr><th>任务</th><th>范围 / 依赖</th><th>验收 / 风险</th><th>角色映射</th><th>执行状态</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${editable ? '<div class="consensus-actions"><span>确认后将创建运行并进入角色流水线。</span><button class="primary" type="submit">确认 DAG 并执行</button></div>' : ''}
  </form>`;
}

function renderGroupConsole() {
  groupConsole.hidden = !groupConsoleOpen;
  $('#discussionEmpty').hidden = groupConsoleOpen;
  if (!groupConsoleOpen) {
    if (contextDock.getState().tab === 'discussion') {
      $('#taskDetailTitle').textContent = '选择群组会话';
      $('#taskDetailStatus').textContent = 'IDLE';
      $('#taskDetailMeta').textContent = '从群组列表打开一个讨论会话。';
    }
    return;
  }
  const group = groupById(selectedGroupId || selectedGroupSession?.group_id);
  $('#groupConsoleTitle').textContent = group ? `${group.name} / 运行中心` : '群组运行中心';
  $('#groupConsoleStatus').textContent = selectedGroupSession ? `${selectedGroupSession.id} / ${statusLabel(selectedGroupSession.status)}` : 'LOADING';
  if (contextDock.getState().tab === 'discussion') {
    $('#taskDetailTitle').textContent = group?.name || '群组讨论';
    $('#taskDetailStatus').textContent = selectedGroupSession ? statusLabel(selectedGroupSession.status) : 'LOADING';
    $('#taskDetailMeta').textContent = selectedGroupSession ? `${selectedGroupSession.id} | 第 ${selectedGroupSession.current_round}/${selectedGroupSession.max_rounds} 轮` : '正在读取会话。';
  }
  $('#groupRound').textContent = selectedGroupSession ? `ROUND ${selectedGroupSession.current_round} / ${selectedGroupSession.max_rounds}` : 'ROUND 0 / 0';
  renderGroupMembers();
  renderGroupMessages();
  renderGroupControls();
  renderGroupConsensus();
}

function readConsensusForm() {
  const consensus = JSON.parse(JSON.stringify(selectedGroupSession.consensus));
  consensus.title = $('#groupConsensusRunTitle').value.trim();
  $('#groupConsensusForm').querySelectorAll('[data-consensus-task]').forEach(row => {
    const task = consensus.tasks[Number(row.dataset.consensusTask)];
    row.querySelectorAll('[data-consensus-field]').forEach(field => {
      const key = field.dataset.consensusField;
      if (key === 'files' || key === 'dependsOn') task[key] = field.value.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
      else if (key === 'fixerMemberId') task[key] = field.value || null;
      else task[key] = field.value.trim();
    });
  });
  return consensus;
}

function render(nextState, health) {
  state = nextState;
  store.setState({ data: nextState, health, selection: { taskId: selectedTaskId, groupId: selectedGroupId, sessionId: selectedGroupSessionId } });
  $('#workspace').textContent = state.workspace;
  workspaceUi.render(state);
  $('#health').textContent = health.gitReady ? `Daemon online / ${state.integrationBranch}` : 'Git baseline required';
  $('#health').classList.toggle('warning', !health.gitReady);
  $('#modeDescription').textContent = modeCopy[state.mode];
  $('#maxConcurrency').value = state.maxConcurrency;
  $('#modeSwitch').querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === state.mode));
  $('#runCount').textContent = state.stats.runs;
  $('#agentCount').textContent = `${state.runtime.activeAgents} / ${state.maxConcurrency}`;
  $('#mergeCount').textContent = state.stats.mergeReady;
  $('#conflictCount').textContent = state.approvals?.length || 0;
  $('#pendingActionCount strong').textContent = state.approvals?.length || 0;
  $('#dependsOn').innerHTML = '<option value="">无</option>' + state.tasks.filter(task => !['merged', 'cancelled'].includes(task.status)).map(task => `<option value="${task.id}">${task.id} ${escapeHtml(task.title)}</option>`).join('');
  renderMetrics(); renderProcessMonitor(); renderApprovals(); renderAgentHealth(); renderGroups(); renderGroupConsole(); renderRuns(); renderBoard(); renderDetail(); renderReview(); renderEvents(); renderRunCommand(); refreshCommandIndex(); applyActionFeedback();
}

async function openApprovalItem(item) {
  if (item.entityType === 'task') {
    selectedTaskId = item.entityId;
    const tab = ['task_verify', 'task_recovery', 'conflict_review'].includes(item.kind) ? 'acceptance' : 'task';
    contextDock.open(tab, item.entityId);
    layout.setRoute({ view: 'tasks', runId: item.runId, taskId: item.entityId });
    renderBoard(); renderDetail();
    return;
  }
  if (item.entityType === 'review') {
    const review = state.reviews.find(candidate => candidate.id === item.entityId);
    selectedTaskId = review?.task_id || null;
    contextDock.open('acceptance', selectedTaskId);
    layout.setRoute({ view: 'tasks', runId: item.runId, taskId: selectedTaskId });
    renderBoard(); renderDetail(); renderReview();
    return;
  }
  if (item.entityType === 'group_session') {
    const session = state.groupSessions.find(candidate => candidate.id === item.entityId);
    await openGroupSession(item.entityId, session?.group_id || null);
    return;
  }
  if (item.entityType === 'run') layout.setRoute({ view: 'delivery', runId: item.entityId });
}

async function refreshSelectedGroupSession(resetMessages = false) {
  if (!selectedGroupSessionId) return;
  const sessionId = selectedGroupSessionId;
  const requestId = ++groupDetailRequest;
  const after = resetMessages ? 0 : groupMessagesAfter;
  const [session, messages] = await Promise.all([
    request(`/api/group-sessions/${sessionId}`),
    request(`/api/group-sessions/${sessionId}/messages?after=${after}`)
  ]);
  if (requestId !== groupDetailRequest || sessionId !== selectedGroupSessionId) return;
  selectedGroupSession = session;
  selectedGroupId = session.group_id;
  if (resetMessages) { groupMessages = []; groupMessagesAfter = 0; }
  const known = new Set(groupMessages.map(message => message.id));
  for (const message of messages) if (!known.has(message.id)) groupMessages.push(message);
  groupMessages.sort((left, right) => left.id - right.id);
  groupMessagesAfter = groupMessages.length ? groupMessages[groupMessages.length - 1].id : 0;
  renderGroupConsole();
}

async function openGroupSession(sessionId, groupId = null) {
  selectedGroupSessionId = sessionId;
  selectedGroupId = groupId;
  selectedGroupSession = null;
  groupMessages = [];
  groupMessagesAfter = 0;
  groupConsoleOpen = true;
  contextDock.open('discussion', sessionId);
  groupConsoleUi.setActivePane('chat');
  renderGroupConsole();
  await refreshSelectedGroupSession(true);
}

async function refresh({ includeGithub = true } = {}) {
  try {
    const [nextState, health, github] = await Promise.all([request('/api/state'), request('/api/health'), includeGithub ? request('/api/github/status').catch(error => ({ error: error.message })) : Promise.resolve(null)]);
    render(nextState, health);
    if (github) {
      const login = github.login;
      $('#githubStatus').textContent = github.authenticated ? `GitHub 已连接${github.remote ? ' / origin 已配置' : ' / 未配置远程'}` : login?.pending ? (login.deviceCode ? `GitHub code: ${login.deviceCode}` : 'GitHub authorization is starting...') : github.available ? 'GitHub 未认证，点击连接' : 'GitHub CLI 未安装';
      $('#githubStatus').title = login?.deviceUrl || '';
      $('#githubStatus').classList.toggle('warning', !github.authenticated);
    }
    if (selectedGroupSessionId) await refreshSelectedGroupSession();
  }
  catch (error) { tell(error.message, 'error'); }
}

async function refreshFromStream(types) {
  const workspaceSnapshot = captureElementState($('#workspaceMain'));
  const dockSnapshot = captureElementState($('#contextDockViewport'), '#groupMessageInput', document.activeElement);
  if (types.length && types.every(type => type === 'group_message') && selectedGroupSessionId) await refreshSelectedGroupSession();
  else await refresh({ includeGithub: false });
  restoreElementState($('#workspaceMain'), null, workspaceSnapshot);
  restoreElementState($('#contextDockViewport'), '#groupMessageInput', dockSnapshot);
}

const streamRefresh = createRefreshScheduler(refreshFromStream, { delay: 100, onError: error => tell(error.message, 'error') });

const groupMemberDefaults = {
  codex: { role: 'executor', displayName: 'Codex 执行', instructions: '拆解方案并负责实现与提交。' },
  'claude-code': { role: 'reviewer', displayName: 'Claude 检查', instructions: '检查假设、验收结果与潜在回归。' },
  antigravity: { role: 'fixer', displayName: '反重力 修复', instructions: '根据审查意见执行最小范围修复。' }
};

const initialGroupMembers = Object.entries(groupMemberDefaults).map(([agent, defaults]) => ({ key: agent, agent, ...defaults }));

function groupMemberRows() {
  return [...$('#groupMemberEditor').querySelectorAll('[data-member-key]')];
}

function nextGroupMemberKey(agent, excludedRow = null) {
  const used = new Set(groupMemberRows().filter(row => row !== excludedRow).map(row => row.dataset.memberKey));
  let key = agent;
  let suffix = 2;
  while (used.has(key)) key = `${agent}-${suffix++}`;
  return key;
}

function createGroupMemberRow(member = {}, { moderator = false, autoKey = false } = {}) {
  const row = $('#groupMemberTemplate').content.firstElementChild.cloneNode(true);
  const agent = groupMemberDefaults[member.agent] ? member.agent : 'claude-code';
  const defaults = groupMemberDefaults[agent];
  const key = member.key || nextGroupMemberKey(agent);
  row.dataset.memberKey = key;
  row.dataset.keyAuto = String(autoKey || !member.key);
  row.dataset.lastAgent = agent;
  row.querySelector('[name="agent"]').value = agent;
  row.querySelector('[name="role"]').value = member.role || defaults.role;
  row.querySelector('[name="displayName"]').value = member.displayName ?? member.display_name ?? defaults.displayName;
  row.querySelector('[name="instructions"]').value = member.instructions ?? defaults.instructions;
  row.querySelector('.member-seat-key').textContent = key;
  const radio = row.querySelector('[name="moderatorKey"]');
  radio.value = key;
  radio.checked = moderator || member.isModerator || member.is_moderator || false;
  return row;
}

function renderGroupMemberRows(members, moderatorKey = null) {
  const rows = members.map(member => createGroupMemberRow(member, {
    moderator: member.key === moderatorKey || member.isModerator || member.is_moderator,
    autoKey: false
  }));
  $('#groupMemberEditor').replaceChildren(...rows);
  syncGroupMemberRows();
}

function syncGroupMemberRows() {
  const rows = groupMemberRows();
  const moderator = rows.find(row => row.querySelector('[name="moderatorKey"]').checked);
  if (!moderator && rows.length) rows[0].querySelector('[name="moderatorKey"]').checked = true;
  for (const row of rows) {
    const key = row.dataset.memberKey;
    row.querySelector('[name="moderatorKey"]').value = key;
    row.querySelector('.member-seat-key').textContent = key;
    row.querySelector('[data-remove-group-member]').disabled = rows.length <= 2;
  }
}

function resetGroupForm() {
  const form = $('#groupForm');
  form.reset();
  editingGroupId = null;
  $('#groupDialogTitle').textContent = '创建 Agent 群组';
  $('#groupFormSubmit').textContent = '创建群组';
  renderGroupMemberRows(initialGroupMembers, 'codex');
}

function openGroupEditor(groupId = null) {
  resetGroupForm();
  const group = groupId ? groupById(groupId) : null;
  if (group) {
    editingGroupId = group.id;
    $('#groupDialogTitle').textContent = `编辑 ${group.name}`;
    $('#groupFormSubmit').textContent = '保存群组';
    const form = $('#groupForm');
    form.querySelector('[name="name"]').value = group.name;
    form.querySelector('[name="description"]').value = group.description || '';
    form.querySelector('[name="maxRounds"]').value = String(group.max_rounds);
    form.querySelector('[name="maxRepairs"]').value = String(group.max_repairs);
    renderGroupMemberRows(group.members, group.members.find(member => member.is_moderator)?.key);
  }
  groupDialog.showModal();
}

function readGroupForm() {
  const form = $('#groupForm');
  const rows = groupMemberRows();
  if (rows.length < 2) throw new Error('至少需要 2 个 Agent 席位。');
  const members = rows.map(row => ({
    key: row.dataset.memberKey,
    agent: row.querySelector('[name="agent"]').value,
    role: row.querySelector('[name="role"]').value,
    displayName: row.querySelector('[name="displayName"]').value.trim(),
    instructions: row.querySelector('[name="instructions"]').value.trim()
  }));
  const maxRepairs = Number(form.querySelector('[name="maxRepairs"]').value);
  if (!members.some(member => member.role === 'executor')) throw new Error('群组至少需要一名 executor。');
  if (!members.some(member => member.role === 'reviewer')) throw new Error('群组至少需要一名 reviewer。');
  if (maxRepairs > 0 && !members.some(member => member.role === 'fixer')) throw new Error('修复次数大于 0 时至少需要一名 fixer。');
  const moderator = rows.find(row => row.querySelector('[name="moderatorKey"]').checked);
  if (!moderator) throw new Error('请选择一名主持者。');
  return {
    name: form.querySelector('[name="name"]').value.trim(),
    description: form.querySelector('[name="description"]').value.trim(),
    maxRounds: Number(form.querySelector('[name="maxRounds"]').value),
    maxRepairs,
    moderatorKey: moderator.dataset.memberKey,
    members
  };
}

function openGroupSessionDialog(groupId) {
  const group = groupById(groupId);
  const form = $('#groupSessionForm');
  form.reset();
  form.querySelector('[name="groupId"]').value = groupId;
  $('#groupSessionTarget').textContent = group ? `${group.id} / ${group.name}` : groupId;
  groupSessionDialog.showModal();
}

$('#openTaskDialog').addEventListener('click', () => dialog.showModal());
$('#openTaskDialogFromTasks').addEventListener('click', () => dialog.showModal());
$('#openRunDialog').addEventListener('click', () => { plannedRun = null; $('#planPreview').hidden = true; runDialog.showModal(); });
$('#openGroupDialog').addEventListener('click', () => openGroupEditor());
$('#refresh').addEventListener('click', refresh);
$('#pendingActionCount').addEventListener('click', () => {
  layout.setRoute({ view: 'runs', runId: selectedRun()?.id || null });
  document.querySelector('.approval-section')?.setAttribute('open', '');
  document.querySelector('.approval-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#nextAction').addEventListener('click', async event => {
  if (!event.target.closest('[data-next-action]') || !currentNextAction) return;
  if (currentNextAction.kind === 'create') return $('#openRunDialog').click();
  const approval = state.approvals?.find(item => item.id === currentNextAction.id);
  if (approval) {
    if (approval.actions.includes('external') && approval.url) return window.open(approval.url, '_blank', 'noopener');
    return openApprovalItem(approval);
  }
  const run = selectedRun();
  if (!run) return;
  const endpoint = currentNextAction.kind === 'publish' ? 'publish' : 'refresh';
  try {
    await withActionFeedback(`run:${run.id}:${endpoint}`, endpoint === 'publish' ? '正在发布 PR' : '正在刷新 CI', endpoint === 'publish' ? 'PR 已发布' : 'CI 已刷新', () => request(`/api/runs/${run.id}/${endpoint}`, { method: 'POST', body: '{}' }));
    await refresh();
  } catch (error) { tell(error.message, 'error'); }
});

$('#commandSearch').addEventListener('input', event => {
  commandSelection = 0;
  commandResults = searchEntities(commandIndex, event.currentTarget.value);
  renderCommandResults();
});
$('#commandSearch').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!commandResults.length) return;
    commandSelection = (commandSelection + (event.key === 'ArrowDown' ? 1 : -1) + commandResults.length) % commandResults.length;
    renderCommandResults();
    event.preventDefault();
  } else if (event.key === 'Enter') {
    selectCommandResult(commandResults[commandSelection]);
    event.preventDefault();
  } else if (event.key === 'Escape') {
    $('#commandSearchResults').hidden = true;
  }
});
$('#commandSearchResults').addEventListener('click', event => {
  const option = event.target.closest('[data-command-result]');
  if (option) selectCommandResult(commandResults[Number(option.dataset.commandResult)]);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey && event.key.toLowerCase() === 'k') || (event.key === '/' && !event.target.closest('input,textarea,select'))) {
    event.preventDefault();
    $('#commandSearch').focus();
    $('#commandSearch').select();
  }
});
$('#githubStatus').addEventListener('click', async () => { try { const result = await request('/api/github/connect', { method: 'POST', body: '{}' }); tell(result.message || 'GitHub 已连接。'); await refresh(); } catch (error) { tell(error.message, 'error'); } });
$('#modeSwitch').addEventListener('click', event => { const button = event.target.closest('[data-mode]'); if (button) $('#modeSwitch').dataset.pendingMode = button.dataset.mode; $('#modeSwitch').querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button)); });
$('#saveSettings').addEventListener('click', async () => {
  try { await request('/api/settings', { method: 'POST', body: JSON.stringify({ mode: $('#modeSwitch').dataset.pendingMode || state.mode, maxConcurrency: Number($('#maxConcurrency').value) }) }); tell('运行策略已更新。'); await refresh(); }
  catch (error) { tell(error.message, 'error'); }
});

$('#agentHealthBoard').addEventListener('click', async event => {
  const button = event.target.closest('[data-agent-health]');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await request(`/api/agents/${button.dataset.agentHealth}/check`, { method: 'POST', body: '{}' });
    tell(`${agentLabels[result.agent] || result.agent}：${result.message}`);
    await refresh();
  } catch (error) {
    tell(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#checkAllAgents').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    for (const agent of state.agents) await request(`/api/agents/${agent}/check`, { method: 'POST', body: '{}' });
    tell('Agent 连接体检已完成。');
    await refresh();
  } catch (error) {
    tell(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#approvalBoard').addEventListener('click', async event => {
  const actionButton = event.target.closest('[data-approval-action]');
  const openButton = event.target.closest('[data-approval-open]');
  if (!actionButton && !openButton) return;
  const id = actionButton?.dataset.approvalId || openButton.dataset.approvalOpen;
  const item = state.approvals.find(candidate => candidate.id === id);
  if (!item) return tell('该审批已不再等待处理。', 'error');
  if (openButton) return openApprovalItem(item);
  const action = actionButton.dataset.approvalAction;
  const key = `approval:${id}:${action}`;
  try {
    await withActionFeedback(key, '正在执行', '审批动作已完成', () => request('/api/approvals/action', { method: 'POST', body: JSON.stringify({ id, action }) }));
    tell('审批动作已执行。');
    await refresh();
  } catch (error) {
    tell(error.message, 'error');
  }
});

$('#processMonitor').addEventListener('click', async event => {
  const taskButton = event.target.closest('[data-process-task]');
  if (taskButton) {
    const task = state.tasks.find(item => item.id === taskButton.dataset.processTask);
    if (!task) return tell('关联任务已不在当前工作区。', 'error');
    selectedTaskId = task.id;
    contextDock.open('task', task.id);
    layout.setRoute({ view: 'tasks', runId: task.run_id, taskId: task.id });
    renderBoard();
    renderDetail();
    return;
  }
  const sessionButton = event.target.closest('[data-process-session]');
  if (sessionButton) {
    const session = state.groupSessions.find(item => item.id === sessionButton.dataset.processSession);
    if (!session) return tell('关联群组会话已不在当前工作区。', 'error');
    await openGroupSession(session.id, session.group_id);
  }
});

$('#groupMemberEditor').addEventListener('change', event => {
  const row = event.target.closest('[data-member-key]');
  if (row && event.target.matches('[name="agent"]')) {
    const previousAgent = row.dataset.lastAgent;
    const nextAgent = event.target.value;
    const previousDefaults = groupMemberDefaults[previousAgent];
    const nextDefaults = groupMemberDefaults[nextAgent];
    if (row.dataset.keyAuto === 'true') row.dataset.memberKey = nextGroupMemberKey(nextAgent, row);
    const displayName = row.querySelector('[name="displayName"]');
    const instructions = row.querySelector('[name="instructions"]');
    if (!displayName.value || displayName.value === previousDefaults?.displayName) displayName.value = nextDefaults.displayName;
    if (!instructions.value || instructions.value === previousDefaults?.instructions) instructions.value = nextDefaults.instructions;
    row.dataset.lastAgent = nextAgent;
  }
  syncGroupMemberRows();
});

$('#groupMemberEditor').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-group-member]');
  if (!remove) return;
  remove.closest('[data-member-key]').remove();
  syncGroupMemberRows();
});

$('#addGroupMember').addEventListener('click', () => {
  const row = createGroupMemberRow({ agent: 'claude-code' }, { autoKey: true });
  $('#groupMemberEditor').append(row);
  syncGroupMemberRows();
  row.querySelector('[name="agent"]').focus();
});

$('#groupForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return groupDialog.close();
  try {
    const payload = readGroupForm();
    const path = editingGroupId ? `/api/groups/${editingGroupId}` : '/api/groups';
    const saved = await request(path, { method: editingGroupId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    groupDialog.close();
    tell(`${saved.id} ${editingGroupId ? '配置已更新' : '已创建'}。`);
    await refresh();
  } catch (error) { tell(error.message, 'error'); }
});

$('#groupSessionForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return groupSessionDialog.close();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const groupId = form.get('groupId');
  try {
    const session = await request(`/api/groups/${groupId}/sessions`, { method: 'POST', body: JSON.stringify({ requirement: form.get('requirement') }) });
    groupSessionDialog.close();
    formElement.reset();
    tell(`${session.id} 已创建，可在运行中心启动讨论。`);
    await refresh();
    await openGroupSession(session.id, groupId);
  } catch (error) { tell(error.message, 'error'); }
});

groupsBoard.addEventListener('click', async event => {
  const button = event.target.closest('[data-group-action]');
  if (!button) return;
  const groupId = button.dataset.groupId;
  try {
    if (button.dataset.groupAction === 'session') return openGroupSessionDialog(groupId);
    if (button.dataset.groupAction === 'open') {
      const latest = latestGroupSession(groupId);
      return latest ? await openGroupSession(latest.id, groupId) : openGroupEditor(groupId);
    }
    if (button.dataset.groupAction === 'archive') {
      const group = groupById(groupId);
      if (!window.confirm(`归档 ${group?.name || groupId}？已有会话记录仍会保留。`)) return;
      await request(`/api/groups/${groupId}/archive`, { method: 'POST', body: '{}' });
      if (selectedGroupId === groupId) { groupConsoleOpen = false; renderGroupConsole(); }
      tell(`${groupId} 已归档。`);
      await refresh();
    }
  } catch (error) { tell(error.message, 'error'); }
});

$('#closeGroupConsole').addEventListener('click', () => { groupConsoleOpen = false; contextDock.selectTab('task'); renderGroupConsole(); renderDetail(); });
groupConsole.addEventListener('click', async event => {
  const tab = event.target.closest('[data-group-tab]');
  if (tab) return;
  if (event.target.closest('[data-group-config]')) return openGroupEditor(selectedGroupId);
  if (event.target.closest('[data-group-run-link]')) return layout.setRoute({ view: 'delivery', runId: selectedGroupSession?.run_id || null });
  const recovery = event.target.closest('[data-turn-recover]');
  if (recovery) {
    const action = recovery.dataset.turnRecover;
    const turnId = recovery.dataset.turnId;
    const replacement = groupConsole.querySelector(`[data-turn-replacement="${turnId}"]`);
    recovery.disabled = true;
    try {
      await request(`/api/group-turns/${turnId}/recover`, { method: 'POST', body: JSON.stringify({ action, replacementMemberId: action === 'replace' ? replacement?.value : undefined }) });
      tell({ retry: '失败回合已重试。', skip: '失败回合已跳过。', replace: '替换成员回合已完成。' }[action]);
      await refreshSelectedGroupSession();
      await refresh();
    } catch (error) { recovery.disabled = false; tell(error.message, 'error'); }
    return;
  }
  const action = event.target.closest('[data-session-action]');
  if (!action || !selectedGroupSessionId) return;
  const endpoint = action.dataset.sessionAction;
  if (endpoint === 'cancel' && !window.confirm(`取消会话 ${selectedGroupSessionId}？`)) return;
  action.disabled = true;
  try {
    await request(`/api/group-sessions/${selectedGroupSessionId}/${endpoint}`, { method: 'POST', body: '{}' });
    tell({ start: '讨论已启动。', pause: '暂停请求已提交。', resume: '讨论已恢复。', cancel: '会话已取消。' }[endpoint]);
    await refresh();
  } catch (error) { action.disabled = false; tell(error.message, 'error'); }
});

$('#groupMessageForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#groupMessageInput');
  const content = input.value.trim();
  if (!content || !selectedGroupSessionId) return;
  try {
    input.disabled = true;
    await request(`/api/group-sessions/${selectedGroupSessionId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
    input.value = '';
    await refreshSelectedGroupSession();
  } catch (error) { tell(error.message, 'error'); }
  finally { renderGroupControls(); input.focus(); }
});

$('#groupConsensus').addEventListener('submit', async event => {
  if (event.target.id !== 'groupConsensusForm') return;
  event.preventDefault();
  const button = event.submitter;
  try {
    button.disabled = true;
    const consensus = readConsensusForm();
    await request(`/api/group-sessions/${selectedGroupSessionId}/confirm`, { method: 'POST', body: JSON.stringify({ consensus }) });
    tell('共识 DAG 已确认，角色流水线开始执行。');
    await refresh();
  } catch (error) { button.disabled = false; tell(error.message, 'error'); }
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
    tell(`${run.id} 已创建，集成分支和任务已准备。`); runDialog.close(); layout.setRoute({ view: 'runs', runId: run.id }); await refresh();
  } catch (error) { tell(error.message || '任务 JSON 无效。', 'error'); }
});

$('#taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return dialog.close();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const task = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ title: form.get('title'), agent: form.get('agent'), files: String(form.get('files')).split(',').map(value => value.trim()).filter(Boolean), dependsOn: form.get('dependsOn') ? [form.get('dependsOn')] : [], acceptance: form.get('acceptance'), timeoutMs: Number(form.get('timeoutMinutes')) * 60000, maxRetries: Number(form.get('maxRetries')) }) });
    selectedTaskId = task.id; dialog.close(); formElement.reset(); contextDock.open('task', task.id); layout.setRoute({ view: 'tasks', taskId: task.id }); tell('任务已创建。当前模式会决定后续自动步骤。'); await refresh();
  } catch (error) { tell(error.message, 'error'); }
});

board.addEventListener('click', async event => {
  const card = event.target.closest('[data-select]'); if (card && !event.target.closest('button,select')) { selectedTaskId = card.dataset.select; const task = state.tasks.find(item => item.id === selectedTaskId); contextDock.open('task', selectedTaskId); layout.setRoute({ view: 'tasks', runId: task?.run_id || null, taskId: selectedTaskId }); renderBoard(); renderDetail(); return; }
  const action = event.target.closest('[data-action]'); if (!action) return;
  try {
    const endpoint = { prepare: 'prepare', start: 'start', verify: 'verify', merge: 'merge', review: 'review' }[action.dataset.action];
    contextDock.open(['verify', 'review'].includes(action.dataset.action) ? 'acceptance' : 'task', action.dataset.id);
    await withActionFeedback(`${action.dataset.id}:${action.dataset.action}`, `正在${action.textContent.trim()}`, '操作已完成', () => request(`/api/tasks/${action.dataset.id}/${endpoint}`, { method: 'POST', body: '{}' }));
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
    await withActionFeedback(`run:${action.dataset.runId}:${endpoint}`, endpoint === 'publish' ? '正在发布 PR' : '正在刷新 CI', endpoint === 'publish' ? 'PR 已发布' : 'CI 已刷新', () => request(`/api/runs/${action.dataset.runId}/${endpoint}`, { method: 'POST', body: '{}' }));
    tell(endpoint === 'publish' ? '运行分支已推送并创建 PR。' : 'CI 状态已刷新。'); await refresh();
  } catch (error) { tell(error.message, 'error'); }
});
$('#reviewContent').addEventListener('click', async event => {
  const button = event.target.closest('[data-review-approve]'); if (!button) return;
  try { await request(`/api/reviews/${button.dataset.reviewApprove}/approve`, { method: 'POST', body: JSON.stringify({ patch: $('#approvedPatch').value }) }); tell('补丁已应用到任务 worktree，正在重新验收。'); await refresh(); }
  catch (error) { tell(error.message, 'error'); }
});

refresh();
connectStream({
  onEvent: type => streamRefresh.schedule(type),
  onConnection(status) {
    $('#streamState').textContent = status === 'online' ? '实时连接' : '正在重连';
    $('#appNav').classList.toggle('is-reconnecting', status !== 'online');
  }
});
