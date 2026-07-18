import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApprovalInbox } from './approval-domain.mjs';

test('projects operator decisions across task, review, group, run, and PR states', () => {
  const approvals = buildApprovalInbox({
    tasks: [
      { id: 'T-001', title: 'Prepare me', status: 'draft', created_at: '2026-01-01T00:00:01Z' },
      { id: 'T-002', title: 'Start me', status: 'ready', created_at: '2026-01-01T00:00:02Z' },
      { id: 'T-003', title: 'Merge me', status: 'merge_ready', run_id: 'RUN-001', created_at: '2026-01-01T00:00:03Z' },
      { id: 'T-004', title: 'Resolve me', status: 'conflict_review', created_at: '2026-01-01T00:00:04Z' },
      { id: 'T-005', title: 'Recover me', status: 'recovery_required', recovery_note: 'Process was lost.', created_at: '2026-01-01T00:00:05Z' },
      { id: 'T-006', title: 'Verify me', status: 'verifying', created_at: '2026-01-01T00:00:06Z' },
    ],
    reviews: [
      { id: 'R-001', task_id: 'T-004', status: 'suggested', created_at: '2026-01-01T00:00:06Z' },
    ],
    groupSessions: [
      { id: 'GS-001', group_id: 'G-001', status: 'awaiting_confirmation', title: 'Confirm this DAG', created_at: '2026-01-01T00:00:07Z' },
      { id: 'GS-002', group_id: 'G-002', status: 'recovery_required', recovery_note: 'Turn failed.', created_at: '2026-01-01T00:00:08Z' },
      { id: 'GS-003', group_id: 'G-003', status: 'draft', requirement: 'Start discussion', created_at: '2026-01-01T00:00:09Z' },
    ],
    runs: [
      { id: 'RUN-001', title: 'Publish me', status: 'ready_to_publish', created_at: '2026-01-01T00:00:09Z' },
      { id: 'RUN-002', title: 'Merge PR', status: 'published', ci_status: 'passed', github_pr_url: 'https://github.com/acme/repo/pull/2', created_at: '2026-01-01T00:00:10Z' },
    ],
  });

  const byId = new Map(approvals.map(item => [item.id, item]));
  assert.deepEqual(byId.get('task:T-001:prepare').actions, ['prepare', 'open']);
  assert.deepEqual(byId.get('task:T-002:start').actions, ['start', 'open']);
  assert.deepEqual(byId.get('task:T-003:merge').actions, ['merge', 'open']);
  assert.deepEqual(byId.get('task:T-006:verify').actions, ['verify', 'open']);
  assert.equal(byId.get('review:R-001:patch').risk, 'high');
  assert.equal(byId.has('task:T-004:conflict'), false);
  assert.equal(byId.get('task:T-005:recovery').description, 'Process was lost.');
  assert.deepEqual(byId.get('group-session:GS-001:confirm').actions, ['open']);
  assert.deepEqual(byId.get('group-session:GS-002:recovery').actions, ['open']);
  assert.deepEqual(byId.get('group-session:GS-003:start').actions, ['start_group', 'open']);
  assert.deepEqual(byId.get('run:RUN-001:publish').actions, ['publish', 'open']);
  assert.deepEqual(byId.get('run:RUN-002:pr-merge').actions, ['external']);
  assert.equal(byId.get('run:RUN-002:pr-merge').url, 'https://github.com/acme/repo/pull/2');
  assert.equal(approvals[0].risk, 'high');
});

test('uses a task conflict item until a suggested patch exists', () => {
  const approvals = buildApprovalInbox({
    tasks: [{ id: 'T-009', title: 'Conflict', status: 'conflict_review', created_at: '2026-01-01T00:00:00Z' }],
    reviews: [{ id: 'R-009', task_id: 'T-009', status: 'pending', created_at: '2026-01-01T00:00:01Z' }],
  });

  assert.deepEqual(approvals.find(item => item.id === 'task:T-009:conflict').actions, ['review', 'open']);
  assert.equal(approvals.some(item => item.id === 'review:R-009:patch'), false);
});
