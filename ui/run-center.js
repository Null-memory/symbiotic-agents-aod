export function createRunCenter({ root, request, tell, onRefresh, getSelectedTask, onContext = () => {} }) {
  const output = root.querySelector('#taskOutput');
  const search = root.querySelector('#logSearch');
  const follow = root.querySelector('#logFollow');
  let rawOutput = '';

  const renderOutput = () => {
    const query = search.value.trim().toLowerCase();
    output.textContent = query ? rawOutput.split('\n').filter(line => line.toLowerCase().includes(query)).join('\n') || '没有匹配的输出。' : rawOutput || '等待 Agent 输出。';
    if (follow.checked) output.scrollTop = output.scrollHeight;
  };

  const setOutput = value => { rawOutput = String(value || ''); renderOutput(); };
  search.addEventListener('input', renderOutput);
  output.addEventListener('scroll', () => {
    if (output.scrollHeight - output.scrollTop - output.clientHeight > 90) follow.checked = false;
  });

  root.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const endpoint = { prepare: 'prepare', start: 'start', verify: 'verify', merge: 'merge', review: 'review' }[action.dataset.action];
    if (!endpoint) return;
    onContext(['verify', 'review'].includes(action.dataset.action) ? 'acceptance' : 'task', action.dataset.id);
    action.disabled = true;
    try {
      await request(`/api/tasks/${action.dataset.id}/${endpoint}`, { method: 'POST', body: '{}' });
      tell(`${action.dataset.id} 已执行 ${action.textContent.trim()}。`);
      await onRefresh();
    } catch (error) {
      action.disabled = false;
      tell(error.message, 'error');
    }
  });

  root.querySelector('[data-inspector-tab="overview"]').addEventListener('click', () => {
    if (!getSelectedTask()) tell('请先从任务队列选择一个任务。');
  });

  return { setOutput, renderOutput };
}
