export const statusLabel = (value: string) => ({
  awaiting_confirmation: '待确认',
  awaiting_merge: '等待人工合并',
  recovery_required: '等待恢复',
  merge_ready: '待合并',
  ready_to_publish: '可发布',
  not_published: '未发布',
  published: '已发布',
  running: '运行中',
  discussing: '讨论中',
  synthesizing: '正在收敛',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  draft: '草稿',
  ready: '就绪',
  preparing: '准备中',
  verifying: '验收中',
  reviewing: '审查中',
  repairing: '修复中',
  conflict_review: '冲突审查',
  unknown: '未知'
} as Record<string, string>)[value] || value || '未知';

export const statusTone = (status: string) => ['failed', 'cancelled', 'recovery_required', 'conflict_review'].includes(status)
  ? 'danger' as const
  : ['awaiting_confirmation', 'awaiting_merge', 'merge_ready', 'ready_to_publish', 'reviewing', 'repairing', 'paused'].includes(status)
    ? 'warning' as const
    : ['draft', 'pending'].includes(status)
      ? 'muted' as const
      : 'accent' as const;

export const connectionLabel = (phase: string) => ({
  live: 'LIVE',
  connecting: '连接中',
  reconnecting: '重连中',
  offline: '离线'
} as Record<string, string>)[phase] || '离线';
