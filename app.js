const $ = selector => document.querySelector(selector);
const board = $('#taskBoard');
const notice = $('#notice');
const dialog = $('#taskDialog');
let current = null;
let noticeTimer;

function tell(message, kind = '') {
  notice.textContent = message;
  notice.className = `notice visible ${kind}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.className = 'notice'; }, 3600);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function prettyStatus(status) {
  return { draft: '草稿', ready: '就绪', preparing: '准备中', running: '运行中', paused: '已暂停', verifying: '验证中', merge_ready: '待合并', merged: '已合并', failed: '失败', cancelled: '已取消' }[status] || status;
}

function render(state, health) {
  current = state;
  $('#workspace').textContent = state.workspace;
  $('#health').textContent = health.gitReady ? 'Daemon online / Git ready' : 'Daemon online / Git needs baseline commit';
  $('#health').classList.toggle('warning', !health.gitReady);
  $('#taskCount').textContent = state.tasks.length;
  $('#worktreeCount').textContent = state.tasks.filter(task => task.worktree).length;
  $('#mergeCount').textContent = state.tasks.filter(task => task.status === 'merge_ready').length;
  $('#gitState').textContent = health.gitReady ? 'Ready' : 'Needs commit';
  $('#dependsOn').innerHTML = '<option value="">无</option>' + state.tasks.filter(task => !['merged', 'cancelled'].includes(task.status)).map(task => `<option value="${task.id}">${task.id} ${escapeHtml(task.title)}</option>`).join('');

  if (!state.tasks.length) {
    board.innerHTML = '<p class="empty">还没有任务。先创建一个可交付的工作单元。</p>';
  } else {
    board.innerHTML = state.tasks.map(task => {
      const dependencies = task.dependsOn.length ? task.dependsOn.join(', ') : '无依赖';
      const canPrepare = task.status === 'draft';
      const canStart = task.status === 'ready';
      const canMove = state.transitions[task.status]?.length || 0;
      const canVerify = task.status === 'verifying';
      const canMerge = task.status === 'merge_ready';
      return `<article class="task-card status-${task.status}">
        <div class="task-meta"><span>${task.id}</span><span>${escapeHtml(task.agent)}</span></div>
        <h3>${escapeHtml(task.title)}</h3>
        <p class="paths">${task.files.map(escapeHtml).join('<br>')}</p>
        <div class="task-info"><span>依赖：${dependencies}</span><span>分支：${escapeHtml(task.branch)}</span></div>
        <div class="task-foot"><strong>${prettyStatus(task.status)}</strong><div>
          ${canPrepare ? `<button class="small primary" data-prepare="${task.id}">准备 worktree</button>` : ''}
          ${canStart ? `<button class="small primary" data-start="${task.id}">启动 Agent</button>` : ''}
          ${canVerify ? `<button class="small primary" data-verify="${task.id}">运行验收</button>` : ''}
          ${canMerge ? `<button class="small primary" data-merge="${task.id}">合并分支</button>` : ''}
          ${canMove ? `<button class="small secondary" data-status="${task.id}">更新状态</button>` : ''}
        </div></div>
      </article>`;
    }).join('');
  }
  $('#events').innerHTML = state.events.length ? state.events.slice(0, 8).map(event => `<div class="event"><time>${new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span>${escapeHtml(event.message)}</span></div>`).join('') : '<p class="empty">暂无事件。</p>';
}

async function refresh() {
  try {
    const [state, health] = await Promise.all([request('/api/state'), request('/api/health')]);
    render(state, health);
  } catch (error) {
    tell(error.message, 'error');
  }
}

$('#openTaskDialog').addEventListener('click', () => dialog.showModal());
$('#refresh').addEventListener('click', refresh);
$('#taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    dialog.close();
    return;
  }
  const form = new FormData(event.currentTarget);
  try {
    await request('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: form.get('title'), agent: form.get('agent'), files: String(form.get('files')).split(',').map(value => value.trim()).filter(Boolean),
      dependsOn: form.get('dependsOn') ? [form.get('dependsOn')] : [], acceptance: form.get('acceptance')
    }) });
    dialog.close(); event.currentTarget.reset(); tell('任务已创建。声明边界后即可准备隔离工作区。'); await refresh();
  } catch (error) { tell(error.message, 'error'); }
});

board.addEventListener('click', async event => {
  const prepare = event.target.closest('[data-prepare]');
  const start = event.target.closest('[data-start]');
  const status = event.target.closest('[data-status]');
  const verify = event.target.closest('[data-verify]');
  const merge = event.target.closest('[data-merge]');
  try {
    if (prepare) {
      await request(`/api/tasks/${prepare.dataset.prepare}/prepare`, { method: 'POST', body: '{}' });
      tell('Worktree 已准备，交接说明写入 .aod/handoffs。');
    }
    if (start) {
      await request(`/api/tasks/${start.dataset.start}/start`, { method: 'POST', body: '{}' });
      tell('Agent 进程已启动，输出会写入任务记录。');
    }
    if (status) {
      const task = current.tasks.find(item => item.id === status.dataset.status);
      const choices = current.transitions[task.status];
      const next = window.prompt(`选择下一个状态：${choices.join(', ')}`, choices[0]);
      if (!next) return;
      await request(`/api/tasks/${task.id}/status`, { method: 'POST', body: JSON.stringify({ status: next }) });
      tell(`${task.id} 已更新为 ${prettyStatus(next)}。`);
    }
    if (verify) {
      await request(`/api/tasks/${verify.dataset.verify}/verify`, { method: 'POST', body: '{}' });
      tell('验收命令已通过，任务进入合并队列。');
    }
    if (merge) {
      await request(`/api/tasks/${merge.dataset.merge}/merge`, { method: 'POST', body: '{}' });
      tell('分支已合并到当前主线。');
    }
    await refresh();
  } catch (error) { tell(error.message, 'error'); }
});

refresh();
