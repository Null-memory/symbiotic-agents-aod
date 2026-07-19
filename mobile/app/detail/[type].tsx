import { useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { BackHeader, Card, ConfirmButton, ErrorState, Screen, StatusPill, styles } from '@/components';
import { mobileRequest } from '@/api/client';
import { colors, radius, spacing } from '@/theme';
import { useMobile } from '@/store';

const labels: Record<string, string> = { group: '群组会话', run: '运行详情', task: '任务详情' };

export default function DetailScreen() {
  const params = useLocalSearchParams<{ type: string; id: string }>();
  const { connection, data, runAction, refresh } = useMobile();
  const [detail, setDetail] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [message, setMessage] = useState('');
  const [consensusDraft, setConsensusDraft] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!connection || !params.id) return;
    const path = params.type === 'group' ? `/api/group-sessions/${params.id}` : params.type === 'run' ? `/api/runs/${params.id}` : `/api/tasks/${params.id}`;
    const requests = [mobileRequest<any>(connection, path)];
    if (params.type === 'group') requests.push(mobileRequest<any[]>(connection, `/api/group-sessions/${params.id}/messages`));
    if (params.type === 'task') requests.push(mobileRequest<any[]>(connection, `/api/tasks/${params.id}/logs`));
    Promise.all(requests).then(([main, secondary]) => {
      setDetail(main);
      if (params.type === 'group') {
        setMessages(secondary || []);
        setConsensusDraft(main.consensus ? JSON.parse(JSON.stringify(main.consensus)) : null);
      }
      if (params.type === 'task') setLogs(secondary || []);
    }).catch(reason => setError(reason instanceof Error ? reason.message : '无法读取详情。'));
  }, [connection, params.id, params.type]);
  if (error) return <Screen scroll={false}><BackHeader title={labels[params.type] || '详情'} /><ErrorState message={error} /></Screen>;
  if (!detail) return <Screen scroll={false}><BackHeader title={labels[params.type] || '详情'} /><View style={styles.center}><ActivityIndicator color={colors.accent} /></View></Screen>;
  const status = detail.status || detail.ci_status || 'unknown';
  const review = params.type === 'task' ? (data?.reviews || []).find(item => item.task_id === detail.id) : null;
  const action = params.type === 'group' ? groupAction(detail, runAction, refresh, consensusDraft) : params.type === 'run' ? runActionForRun(detail, runAction, refresh) : taskAction(detail, runAction, refresh);
  return <Screen><BackHeader title={labels[params.type] || '详情'} /><Card><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><Text style={{ color: colors.text, fontSize: 18, fontWeight: '800', flex: 1 }}>{detail.title || detail.name || detail.requirement || detail.id}</Text><StatusPill value={String(status)} /></View><Text style={{ color: colors.muted, fontFamily: 'Courier New', fontSize: 11 }}>{detail.id}</Text></Card>{action ? <View style={{ gap: 8, marginBottom: 8 }}>{action}</View> : null}{review ? <ConflictReview review={review} runAction={runAction} refresh={refresh} /> : null}{params.type === 'group' ? <><GroupConsensusEditor consensus={consensusDraft} members={detail.members || []} onChange={setConsensusDraft} /><GroupMessages messages={messages} message={message} setMessage={setMessage} send={async () => { if (!message.trim()) return; await executeActionAsync(runAction, refresh, `/api/group-sessions/${detail.id}/messages`, { content: message.trim() }); setMessage(''); if (connection) setMessages(await mobileRequest<any[]>(connection, `/api/group-sessions/${detail.id}/messages`)); }} /></> : null}{params.type === 'task' ? <TaskLogs logs={logs} /> : null}<Card><Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>实时信息</Text><Text selectable style={{ color: colors.muted, fontFamily: 'Courier New', fontSize: 11, lineHeight: 18 }}>{JSON.stringify(detail, null, 2)}</Text></Card></Screen>;
}

function GroupConsensusEditor({ consensus, members, onChange }: { consensus: any; members: any[]; onChange: (value: any) => void }) {
  if (!consensus) return null;
  const updateConsensus = (field: string, value: string | number) => onChange({ ...consensus, [field]: value });
  const updateTask = (index: number, field: string, value: unknown) => {
    const tasks = (consensus.tasks || []).map((task: any, taskIndex: number) => taskIndex === index ? { ...task, [field]: value } : task);
    onChange({ ...consensus, tasks });
  };
  const roleMembers = (role: string) => members.filter(member => member.role === role);
  return <Card><Text style={detailStyles.sectionTitle}>共识与任务 DAG</Text><Text style={detailStyles.helper}>确认前可以直接编辑任务、文件范围、依赖、验收命令和角色分工。</Text><TextInput value={consensus.title || ''} onChangeText={value => updateConsensus('title', value)} placeholder="运行标题" style={detailStyles.input} /><TextInput value={consensus.summary || ''} onChangeText={value => updateConsensus('summary', value)} placeholder="共识摘要" multiline style={[detailStyles.input, detailStyles.multiline]} />{(consensus.tasks || []).map((task: any, index: number) => <View key={task.key || index} style={detailStyles.taskEditor}><View style={detailStyles.taskHeader}><Text style={detailStyles.taskTitle}>任务 {index + 1}</Text><StatusPill value={task.key || '未命名'} tone="muted" /></View><TextInput value={task.key || ''} onChangeText={value => updateTask(index, 'key', value)} placeholder="任务 key" style={detailStyles.input} /><TextInput value={task.title || ''} onChangeText={value => updateTask(index, 'title', value)} placeholder="任务标题" style={detailStyles.input} /><TextInput value={(task.files || []).join(', ')} onChangeText={value => updateTask(index, 'files', csv(value))} placeholder="文件范围，用逗号分隔" style={detailStyles.input} /><TextInput value={(task.dependsOn || []).join(', ')} onChangeText={value => updateTask(index, 'dependsOn', csv(value))} placeholder="依赖 key，用逗号分隔" style={detailStyles.input} /><TextInput value={task.acceptance || ''} onChangeText={value => updateTask(index, 'acceptance', value)} placeholder="验收命令，例如 npm test" autoCapitalize="none" style={[detailStyles.input, detailStyles.codeInput]} /><Text style={detailStyles.fieldLabel}>执行者</Text><MemberSelector members={roleMembers('executor')} value={task.executorMemberId} onChange={value => updateTask(index, 'executorMemberId', value)} /><Text style={detailStyles.fieldLabel}>检查者</Text><MemberSelector members={roleMembers('reviewer')} value={task.reviewerMemberId} onChange={value => updateTask(index, 'reviewerMemberId', value)} />{Number(consensus.maxRepairs ?? 0) > 0 ? <><Text style={detailStyles.fieldLabel}>修复者</Text><MemberSelector members={roleMembers('fixer')} value={task.fixerMemberId} onChange={value => updateTask(index, 'fixerMemberId', value)} /></> : null}<TextInput value={task.risk || ''} onChangeText={value => updateTask(index, 'risk', value)} placeholder="风险说明" multiline style={[detailStyles.input, detailStyles.multiline]} /></View>)}</Card>;
}

function MemberSelector({ members, value, onChange }: { members: any[]; value?: string; onChange: (value: string) => void }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={detailStyles.memberChoices}>{members.map(member => <Pressable key={member.id} onPress={() => onChange(member.id)} style={[detailStyles.memberChoice, value === member.id && detailStyles.memberChoiceActive]}><Text style={[detailStyles.memberChoiceText, value === member.id && detailStyles.memberChoiceTextActive]}>{member.displayName || member.display_name || member.key}</Text></Pressable>)}</ScrollView>;
}

function csv(value: string) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function GroupMessages({ messages, message, setMessage, send }: { messages: any[]; message: string; setMessage: (value: string) => void; send: () => Promise<void> }) {
  return <Card><Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>消息时间线</Text>{messages.length ? <FlatList data={messages.slice(-60)} keyExtractor={item => String(item.id)} scrollEnabled={false} renderItem={({ item }) => <View style={{ gap: 3, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}><Text style={{ color: colors.accent, fontSize: 10, fontWeight: '800' }}>{item.sender_kind === 'operator' ? '你' : item.sender_member_id || 'Agent'} · {item.phase}</Text><Text style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>{item.content}</Text></View>} /> : <Text style={{ color: colors.muted, fontSize: 13 }}>会话尚未产生消息。</Text>}<View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end', marginTop: spacing.sm }}><TextInput value={message} onChangeText={setMessage} placeholder="给下一轮留一句话" multiline style={{ flex: 1, minHeight: 48, maxHeight: 110, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, color: colors.text, backgroundColor: colors.surfaceSubtle }} /><ConfirmButton label="发送" message="发送这条操作者消息？" onConfirm={send} /></View></Card>;
}

function TaskLogs({ logs }: { logs: any[] }) {
  return <Card><Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>验收与输出</Text>{logs.length ? <FlatList data={logs.slice(-100)} keyExtractor={item => String(item.id)} scrollEnabled={false} renderItem={({ item }) => <Text selectable style={{ color: colors.muted, fontFamily: 'Courier New', fontSize: 10, lineHeight: 17 }}>{`[${item.stream}] ${item.message}`}</Text>} /> : <Text style={{ color: colors.muted, fontSize: 13 }}>暂无结构化日志。</Text>}</Card>;
}

function ConflictReview({ review, runAction, refresh }: { review: any; runAction: (path: string, body?: unknown) => Promise<any>; refresh: () => Promise<void> }) {
  const [patch, setPatch] = useState(review.patch || '');
  if (review.status !== 'suggested') return <Card><Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>冲突审查</Text><Text style={{ color: colors.muted, fontSize: 13 }}>等待 Reviewer 生成修复建议。</Text><ConfirmButton label="请求审查建议" message="确认启动冲突 Reviewer？" onConfirm={() => executeAction(runAction, refresh, `/api/tasks/${review.task_id}/review`)} /></Card>;
  return <Card><Text style={{ color: colors.text, fontSize: 15, fontWeight: '800' }}>确认 Reviewer 补丁</Text><Text selectable style={{ color: colors.muted, fontFamily: 'Courier New', fontSize: 11, lineHeight: 17 }}>{review.suggestion || 'Reviewer 未提供文字说明。'}</Text><TextInput value={patch} onChangeText={setPatch} multiline placeholder="核对或粘贴 unified diff" style={{ minHeight: 130, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, color: colors.text, backgroundColor: colors.surfaceSubtle, fontFamily: 'Courier New', fontSize: 11 }} /><ConfirmButton label="应用补丁并重新验收" message="确认把这份补丁应用到任务 worktree？" onConfirm={() => executeAction(runAction, refresh, `/api/reviews/${review.id}/approve`, { patch })} />;</Card>;
}

function groupAction(detail: any, runAction: (path: string, body?: unknown) => Promise<any>, refresh: () => Promise<void>, consensusDraft: any) {
  if (detail.status === 'draft') return <ConfirmButton label="启动讨论" message="确认启动这个群组会话？" onConfirm={() => executeAction(runAction, refresh, `/api/group-sessions/${detail.id}/start`)} />;
  if (['discussing', 'synthesizing'].includes(detail.status)) return <ConfirmButton label="暂停讨论" message="确认请求暂停当前讨论回合？" tone="secondary" onConfirm={() => executeAction(runAction, refresh, `/api/group-sessions/${detail.id}/pause`)} />;
  if (detail.status === 'paused') return <ConfirmButton label="继续讨论" message="确认继续群组讨论？" onConfirm={() => executeAction(runAction, refresh, `/api/group-sessions/${detail.id}/resume`)} />;
  if (detail.status === 'awaiting_confirmation' && consensusDraft) return <ConfirmButton label="确认 DAG" message="确认共识任务 DAG 并创建运行？" onConfirm={() => executeAction(runAction, refresh, `/api/group-sessions/${detail.id}/confirm`, { consensus: consensusDraft })} />;
  if (!['completed', 'cancelled', 'failed'].includes(detail.status)) return <ConfirmButton label="取消会话" message="取消后当前群组 Agent 会停止，确认继续？" tone="danger" onConfirm={() => executeAction(runAction, refresh, `/api/group-sessions/${detail.id}/cancel`)} />;
  return null;
}

function runActionForRun(detail: any, runAction: (path: string, body?: unknown) => Promise<any>, refresh: () => Promise<void>) {
  if (detail.status === 'ready_to_publish') return <ConfirmButton label="发布 PR" message="确认推送集成分支并创建或更新 GitHub PR？" onConfirm={() => executeAction(runAction, refresh, `/api/runs/${detail.id}/publish`)} />;
  if (detail.github_pr_number) return <ConfirmButton label="刷新 CI" message="确认读取 GitHub PR 和 CI 的最新状态？" tone="secondary" onConfirm={() => executeAction(runAction, refresh, `/api/runs/${detail.id}/refresh`)} />;
  return null;
}

function taskAction(detail: any, runAction: (path: string, body?: unknown) => Promise<any>, refresh: () => Promise<void>) {
  const base = `/api/tasks/${detail.id}`;
  if (detail.status === 'draft') return <ConfirmButton label="准备任务" message="确认准备任务 worktree？" onConfirm={() => executeAction(runAction, refresh, `${base}/prepare`)} />;
  if (detail.status === 'ready') return <ConfirmButton label="启动任务" message="确认启动 Agent 修改任务？" onConfirm={() => executeAction(runAction, refresh, `${base}/start`)} />;
  if (detail.status === 'merge_ready') return <ConfirmButton label="合并任务" message="确认合并任务分支？" onConfirm={() => executeAction(runAction, refresh, `${base}/merge`)} />;
  if (detail.status === 'recovery_required') return <ConfirmButton label="恢复任务" message="确认重新进入任务流程？" onConfirm={() => executeAction(runAction, refresh, `${base}/status`, { status: 'ready' })} />;
  return null;
}

function executeAction(runAction: (path: string, body?: unknown) => Promise<any>, refresh: () => Promise<void>, path: string, body: unknown = {}) {
  runAction(path, body).then(refresh).catch(error => Alert.alert('操作失败', error instanceof Error ? error.message : 'AOD 没有接受这个操作。'));
}

async function executeActionAsync(runAction: (path: string, body?: unknown) => Promise<any>, refresh: () => Promise<void>, path: string, body: unknown = {}) {
  try { await runAction(path, body); await refresh(); } catch (error) { Alert.alert('操作失败', error instanceof Error ? error.message : 'AOD 没有接受这个操作。'); throw error; }
}

const detailStyles = {
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '800' as const },
  helper: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  input: { minHeight: 46, paddingHorizontal: 10, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, color: colors.text, backgroundColor: colors.surfaceSubtle, fontSize: 13 },
  multiline: { minHeight: 76, textAlignVertical: 'top' as const },
  codeInput: { fontFamily: 'Courier New' as const, fontSize: 11 },
  taskEditor: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSubtle },
  taskHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const },
  taskTitle: { color: colors.text, fontSize: 14, fontWeight: '800' as const },
  fieldLabel: { color: colors.muted, fontSize: 11, fontWeight: '700' as const, marginTop: 2 },
  memberChoices: { gap: spacing.sm },
  memberChoice: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  memberChoiceActive: { borderColor: colors.accent, backgroundColor: '#e1f3ef' },
  memberChoiceText: { color: colors.text, fontSize: 12, fontWeight: '700' as const },
  memberChoiceTextActive: { color: colors.accent },
};
