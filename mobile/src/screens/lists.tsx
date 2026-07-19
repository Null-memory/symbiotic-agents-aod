import { router } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';
import { Card, EmptyState, ErrorState, Header, LoadingState, Metric, Screen, StatusPill, styles } from '@/components';
import { colors, spacing } from '@/theme';
import { useMobile } from '@/store';

const tone = (status: string) => ['failed', 'cancelled', 'recovery_required', 'conflict_review'].includes(status) ? 'danger' as const : ['awaiting_confirmation', 'merge_ready', 'reviewing', 'repairing'].includes(status) ? 'warning' as const : ['draft', 'pending'].includes(status) ? 'muted' as const : 'accent' as const;
const statusText = (status: string) => ({ awaiting_confirmation: '待确认', recovery_required: '恢复确认', merge_ready: '待合并', not_published: '未发布', published: '已发布', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', draft: '草稿', ready: '就绪', verifying: '验收中', conflict_review: '冲突审查' } as Record<string, string>)[status] || status || '未知';

function useListScreen() {
  const store = useMobile();
  const body = store.loading && !store.data ? <LoadingState /> : store.error && !store.data ? <ErrorState message={store.error} onRetry={store.refresh} /> : null;
  return { ...store, body };
}

export function RunsScreen() {
  const { data, refresh, body, connected } = useListScreen();
  if (body) return <Screen scroll={false}>{body}</Screen>;
  const runs = data?.runs || [];
  return <Screen refreshing={false} onRefresh={refresh}><Header eyebrow="LOCAL ORCHESTRATION" title="运行中心" action={<StatusPill value={connected ? 'LIVE' : 'OFFLINE'} tone={connected ? 'accent' : 'warning'} />} /><View style={styles.metricsRow}><Metric label="运行" value={String(data?.stats?.runs ?? 0)} /><Metric label="任务" value={String(data?.stats?.total ?? 0)} /><Metric label="待合并" value={String(data?.stats?.mergeReady ?? 0)} /></View>{runs.length ? runs.map(run => <Card key={run.id} onPress={() => router.push({ pathname: '/detail/[type]', params: { type: 'run', id: run.id } })}><View style={styles.cardLine}><Text style={styles.cardTitle} numberOfLines={2}>{run.title || run.requirement || run.id}</Text><StatusPill value={statusText(run.status)} tone={tone(run.status)} /></View><Text style={styles.meta}>{run.id} · {run.integration_branch || '未创建集成分支'}</Text><Text style={styles.description} numberOfLines={2}>{run.requirement || '暂无需求描述'}</Text></Card>) : <EmptyState title="还没有运行" copy="在桌面端创建需求并确认 DAG 后，运行会显示在这里。" />}</Screen>;
}

export function GroupsScreen() {
  const { data, refresh, body, connected } = useListScreen();
  if (body) return <Screen scroll={false}>{body}</Screen>;
  const groups = data?.groups || [];
  const sessions = data?.groupSessions || [];
  return <Screen onRefresh={refresh}><Header eyebrow="COLLABORATION TEMPLATES" title="Agent 群组" action={<StatusPill value={connected ? 'LIVE' : 'OFFLINE'} tone={connected ? 'accent' : 'warning'} />} />{groups.length ? groups.map(group => { const session = sessions.find(item => item.group_id === group.id); return <Card key={group.id} onPress={() => session && router.push({ pathname: '/detail/[type]', params: { type: 'group', id: session.id } })}><View style={styles.cardLine}><Text style={styles.cardTitle} numberOfLines={1}>{group.name}</Text><StatusPill value={`${group.members?.length || 0} 席位`} tone="muted" /></View><Text style={styles.description} numberOfLines={2}>{group.description || '未设置群组描述。'}</Text><Text style={styles.meta}>{session ? `${session.id} · ${statusText(session.status)} · 第 ${session.current_round}/${session.max_rounds} 轮` : '尚未创建会话'}</Text></Card>; }) : <EmptyState title="还没有群组" copy="群组模板需要在桌面端创建和编辑。" />}</Screen>;
}

export function TasksScreen() {
  const { data, refresh, body } = useListScreen();
  if (body) return <Screen scroll={false}>{body}</Screen>;
  const tasks = data?.tasks || [];
  return <Screen onRefresh={refresh}><Header eyebrow="WORK QUEUE" title="任务队列" />{tasks.length ? tasks.map(task => <Card key={task.id} onPress={() => router.push({ pathname: '/detail/[type]', params: { type: 'task', id: task.id } })}><View style={styles.cardLine}><Text style={styles.cardTitle} numberOfLines={2}>{task.title || task.id}</Text><StatusPill value={statusText(task.status)} tone={tone(task.status)} /></View><Text style={styles.meta}>{task.id} · {task.agent} · {task.branch || '未分配分支'}</Text><Text style={styles.description} numberOfLines={2}>{(task.files || []).join(', ') || '未设置文件范围'}</Text></Card>) : <EmptyState title="没有任务" copy="新建运行或从群组共识确认任务后，会在这里看到任务进度。" />}</Screen>;
}

export function DeliveryScreen() {
  const { data, refresh, body } = useListScreen();
  if (body) return <Screen scroll={false}>{body}</Screen>;
  const runs = data?.runs || [];
  return <Screen onRefresh={refresh}><Header eyebrow="GITHUB DELIVERY" title="交付" />{runs.length ? runs.map(run => <Card key={run.id} onPress={() => router.push({ pathname: '/detail/[type]', params: { type: 'run', id: run.id } })}><View style={styles.cardLine}><Text style={styles.cardTitle} numberOfLines={2}>{run.title || run.id}</Text><StatusPill value={statusText(run.ci_status || run.status)} tone={tone(run.ci_status || run.status)} /></View><Text style={styles.meta}>{run.integration_branch || '未创建分支'} · PR {run.github_pr_number || '未创建'}</Text><Text style={styles.description} numberOfLines={2}>{run.github_pr_url || '等待发布到 GitHub'}</Text></Card>) : <EmptyState title="没有交付运行" copy="发布集成分支后，PR 和 CI 状态会显示在这里。" />}</Screen>;
}
