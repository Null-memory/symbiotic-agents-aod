const STAGES = [
  { key: 'requirement', label: '需求' },
  { key: 'collaboration', label: '协作' },
  { key: 'gates', label: '门禁' },
  { key: 'delivery', label: '交付' }
];

const BLOCKED_TASKS = new Set(['failed', 'recovery_required', 'cancelled']);
const GATE_TASKS = new Set(['merge_ready', 'merging', 'conflict_review', 'merged']);
const COMPLETE_RUNS = new Set(['completed', 'merged', 'archived']);

export function deriveRunStage(run, tasks = [], approvals = []) {
  let current = 'requirement';
  if (run && run.status !== 'draft') current = 'collaboration';

  const hasTasks = tasks.length > 0;
  const allAtGate = hasTasks && tasks.every(task => GATE_TASKS.has(task.status));
  const allMerged = hasTasks && tasks.every(task => task.status === 'merged');
  const inDelivery = allMerged || ['ready_to_publish', 'published', ...COMPLETE_RUNS].includes(run?.status);
  if (allAtGate) current = 'gates';
  if (inDelivery) current = 'delivery';

  const currentIndex = STAGES.findIndex(stage => stage.key === current);
  const blocked = tasks.some(task => BLOCKED_TASKS.has(task.status))
    || approvals.some(item => ['task_recovery', 'group_recovery'].includes(item.kind));
  const deliveryComplete = COMPLETE_RUNS.has(run?.status);

  return {
    current,
    stages: STAGES.map((stage, index) => ({
      ...stage,
      state: stage.key === 'delivery' && deliveryComplete
        ? 'complete'
        : index < currentIndex
          ? 'complete'
          : index === currentIndex
            ? (blocked ? 'blocked' : 'current')
            : 'upcoming'
    }))
  };
}

const ACTION_PRIORITY = {
  task_recovery: 0,
  group_recovery: 0,
  conflict_patch: 1,
  conflict_review: 2,
  task_verify: 3,
  task_merge: 4,
  group_consensus: 5,
  task_start: 6,
  task_prepare: 7,
  group_start: 8,
  run_publish: 9,
  pr_merge: 10
};

const ACTION_COPY = {
  task_recovery: { kind: 'recovery', label: '处理恢复确认' },
  group_recovery: { kind: 'recovery', label: '处理群组恢复' },
  conflict_patch: { kind: 'conflict', label: '核对冲突补丁' },
  conflict_review: { kind: 'conflict', label: '请求冲突审查' },
  task_verify: { kind: 'verify', label: '运行任务验收' },
  task_merge: { kind: 'merge', label: '确认合并任务' },
  group_consensus: { kind: 'consensus', label: '确认讨论共识' },
  task_start: { kind: 'start', label: '启动 Agent' },
  task_prepare: { kind: 'prepare', label: '准备 worktree' },
  group_start: { kind: 'discussion', label: '启动群组讨论' },
  run_publish: { kind: 'publish', label: '发布 GitHub PR' },
  pr_merge: { kind: 'pr', label: '在 GitHub 合并 PR' }
};

export function deriveNextAction(run, items = [], urgentItems = []) {
  const candidates = [...urgentItems, ...items]
    .filter(item => !run?.id || !item.runId || item.runId === run.id)
    .sort((left, right) => (ACTION_PRIORITY[left.kind] ?? 99) - (ACTION_PRIORITY[right.kind] ?? 99));
  const item = candidates[0];
  if (item) return { ...item, ...(ACTION_COPY[item.kind] || { kind: 'open', label: '查看待处理项' }) };
  if (run?.status === 'ready_to_publish') return { kind: 'publish', label: '发布 GitHub PR', entityId: run.id, runId: run.id };
  if (run?.status === 'published') return { kind: 'refresh_ci', label: '刷新 CI 状态', entityId: run.id, runId: run.id };
  if (!run) return { kind: 'create', label: '新建运行', entityId: null, runId: null };
  return { kind: 'monitor', label: '等待 Agent 推进', entityId: run.id, runId: run.id };
}
