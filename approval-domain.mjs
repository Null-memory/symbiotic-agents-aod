function approval({ id, kind, entityType, entityId, runId = null, title, description, risk = 'normal', createdAt = null, actions, url = null }) {
  return { id, kind, entityType, entityId, runId, title, description, risk, createdAt, actions, url };
}

export function buildApprovalInbox({ tasks = [], runs = [], reviews = [], groupSessions = [] } = {}) {
  const items = [];
  const tasksById = new Map(tasks.map(task => [task.id, task]));
  const suggestedReviewByTask = new Map(reviews.filter(review => review.status === 'suggested').map(review => [review.task_id, review]));

  for (const task of tasks) {
    const common = { entityType: 'task', entityId: task.id, runId: task.run_id || null, createdAt: task.created_at || null };
    if (task.status === 'draft') items.push(approval({ ...common, id: `task:${task.id}:prepare`, kind: 'task_prepare', title: task.title, description: 'Prepare an isolated task worktree.', actions: ['prepare', 'open'] }));
    if (task.status === 'ready') items.push(approval({ ...common, id: `task:${task.id}:start`, kind: 'task_start', title: task.title, description: 'Start the assigned Agent in its task worktree.', actions: ['start', 'open'] }));
    if (task.status === 'verifying') items.push(approval({ ...common, id: `task:${task.id}:verify`, kind: 'task_verify', title: task.title, description: 'Run the configured acceptance command for the current commit.', actions: ['verify', 'open'] }));
    if (task.status === 'merge_ready') items.push(approval({ ...common, id: `task:${task.id}:merge`, kind: 'task_merge', title: task.title, description: 'Merge the verified task commit into its target branch.', risk: 'high', actions: ['merge', 'open'] }));
    if (task.status === 'conflict_review' && !suggestedReviewByTask.has(task.id)) items.push(approval({ ...common, id: `task:${task.id}:conflict`, kind: 'conflict_review', title: task.title, description: 'Request or inspect a conflict review suggestion.', risk: 'high', actions: ['review', 'open'] }));
    if (task.status === 'recovery_required') items.push(approval({ ...common, id: `task:${task.id}:recovery`, kind: 'task_recovery', title: task.title, description: task.recovery_note || 'Task requires an operator recovery decision.', risk: 'high', actions: ['open'] }));
  }

  for (const review of reviews) {
    if (review.status !== 'suggested') continue;
    const task = tasksById.get(review.task_id);
    items.push(approval({
      id: `review:${review.id}:patch`, kind: 'conflict_patch', entityType: 'review', entityId: review.id,
      runId: task?.run_id || null, title: task?.title || review.task_id,
      description: 'Review and explicitly apply the suggested conflict patch.', risk: 'high', createdAt: review.created_at || null, actions: ['open']
    }));
  }

  for (const session of groupSessions) {
    const common = { entityType: 'group_session', entityId: session.id, runId: session.run_id || null, createdAt: session.created_at || null };
    if (session.status === 'draft') items.push(approval({ ...common, id: `group-session:${session.id}:start`, kind: 'group_start', title: session.title || session.requirement || session.id, description: 'Start the three-round group discussion.', actions: ['start_group', 'open'] }));
    if (session.status === 'awaiting_confirmation') items.push(approval({ ...common, id: `group-session:${session.id}:confirm`, kind: 'group_consensus', title: session.title || session.requirement || session.id, description: 'Review and confirm the editable group consensus DAG.', risk: 'high', actions: ['open'] }));
    if (session.status === 'recovery_required') items.push(approval({ ...common, id: `group-session:${session.id}:recovery`, kind: 'group_recovery', title: session.title || session.requirement || session.id, description: session.recovery_note || 'Group session requires an operator recovery decision.', risk: 'high', actions: ['open'] }));
  }

  for (const run of runs) {
    const common = { entityType: 'run', entityId: run.id, runId: run.id, createdAt: run.created_at || null };
    if (run.status === 'ready_to_publish') items.push(approval({ ...common, id: `run:${run.id}:publish`, kind: 'run_publish', title: run.title, description: 'Push the integration branch and create or update its GitHub PR.', actions: ['publish', 'open'] }));
    if (run.status === 'published' && run.ci_status === 'passed' && run.github_pr_url) items.push(approval({ ...common, id: `run:${run.id}:pr-merge`, kind: 'pr_merge', title: run.title, description: 'Required checks passed. Final PR merge remains manual in GitHub.', risk: 'high', actions: ['external'], url: run.github_pr_url }));
  }

  const riskRank = { high: 0, normal: 1 };
  return items.sort((left, right) => (riskRank[left.risk] ?? 2) - (riskRank[right.risk] ?? 2)
    || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
    || left.id.localeCompare(right.id));
}
