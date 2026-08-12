export const launchModes = Object.freeze({
  group: {
    eyebrow: 'TEAM DISCUSSION',
    title: '群组讨论',
    description: '先让多个 Agent 讨论并形成可编辑 DAG。',
    submitLabel: '创建并开始讨论'
  },
  plan: {
    eyebrow: 'FAST PLANNING',
    title: '智能规划',
    description: '由规划器直接生成任务 DAG，确认后再执行。',
    submitLabel: '生成 DAG 预览'
  },
  task: {
    eyebrow: 'DIRECT EXECUTION',
    title: '直接任务',
    description: '跳过讨论，为一个 Agent 创建独立工作任务。',
    submitLabel: '创建独立任务'
  }
});

export function defaultLaunchMode(groups = []) {
  return groups.some(group => group.status === 'active') ? 'group' : 'plan';
}

export function normalizeLaunchMode(mode) {
  return Object.hasOwn(launchModes, mode) ? mode : 'plan';
}

export function launchProgressCopy(mode, elapsedMs = 0) {
  const seconds = Math.max(0, Math.floor(Number(elapsedMs || 0) / 1000));
  if (mode === 'task') return seconds < 2 ? '正在登记任务与文件边界' : '正在刷新任务队列';
  if (mode === 'group') {
    if (seconds < 2) return '正在创建群组会话';
    if (seconds < 6) return '正在申请全局 Agent 槽位';
    return 'Agent 正在读取项目并准备首轮观点';
  }
  if (seconds < 2) return '需求已提交，正在启动规划器';
  if (seconds < 8) return '规划器正在读取项目结构';
  if (seconds < 20) return '正在拆分任务、依赖与文件边界';
  return '正在校验 DAG，请保持此窗口打开';
}

export function buildStandaloneTaskPayload({ requirement, title, agent, files, dependsOn, acceptance, timeoutMinutes, maxRetries }) {
  const normalizedRequirement = String(requirement || '').trim();
  const normalizedTitle = String(title || '').trim() || normalizedRequirement.split(/\r?\n/).find(Boolean)?.slice(0, 100) || '';
  return {
    title: normalizedTitle,
    agent: String(agent || 'codex'),
    files: String(files || '').split(',').map(value => value.trim()).filter(Boolean),
    dependsOn: dependsOn ? [String(dependsOn)] : [],
    acceptance: String(acceptance || '').trim(),
    timeoutMs: Number(timeoutMinutes || 30) * 60000,
    maxRetries: Number(maxRetries || 0)
  };
}
