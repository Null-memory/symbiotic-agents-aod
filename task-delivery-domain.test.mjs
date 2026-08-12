import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryArtifactGuidance, resolveArtifactRevealTarget, taskArtifactDescriptor, verificationSnapshotProblem, windowsExplorerRevealInvocation } from './task-delivery-domain.mjs';

test('blocks verification when the task worktree contains uncommitted artifacts', () => {
  assert.match(verificationSnapshotProblem({
    baseCommit: 'base',
    headCommit: 'next',
    porcelain: '?? scripts/generated.js',
    requiresCommit: true,
  }), /uncommitted changes/i);
});

test('requires a group executor to create a new commit', () => {
  assert.match(verificationSnapshotProblem({
    baseCommit: 'same',
    headCommit: 'same',
    porcelain: '',
    requiresCommit: true,
  }), /new commit/i);
  assert.equal(verificationSnapshotProblem({
    baseCommit: 'same',
    headCommit: 'same',
    porcelain: '',
    requiresCommit: false,
  }), null);
});

test('defines document and runnable engineering delivery requirements', () => {
  const guidance = deliveryArtifactGuidance();
  assert.match(guidance, /requested format/i);
  assert.match(guidance, /Markdown \(\.md\)/i);
  assert.match(guidance, /project location/i);
  assert.match(guidance, /install and start commands/i);
  assert.match(guidance, /one-click startup script/i);
});

test('classifies task-owned delivery artifacts for the console', () => {
  assert.deepEqual(taskArtifactDescriptor('outputs/report.md'), {
    path: 'outputs/report.md', name: 'report.md', extension: '.md', kind: 'document', text: true, primary: true,
  });
  assert.equal(taskArtifactDescriptor('scripts/run.cmd').kind, 'launcher');
  assert.equal(taskArtifactDescriptor('scripts/README.md').kind, 'guide');
  assert.equal(taskArtifactDescriptor('src/index.ts').kind, 'source');
});

test('builds a Windows Explorer reveal only inside the registered artifact root', () => {
  const target = resolveArtifactRevealTarget('E:\\runs\\RUN-001', 'outputs/report.md');
  assert.equal(target, 'E:\\runs\\RUN-001\\outputs\\report.md');
  assert.deepEqual(windowsExplorerRevealInvocation(target, true), {
    command: 'explorer.exe',
    args: ['/select,E:\\runs\\RUN-001\\outputs\\report.md'],
  });
  assert.throws(() => resolveArtifactRevealTarget('E:\\runs\\RUN-001', '../secret.txt'), /escapes/);
  assert.throws(() => resolveArtifactRevealTarget('E:\\runs\\RUN-001', 'C:\\Windows\\win.ini'), /relative artifact path/);
  assert.throws(() => windowsExplorerRevealInvocation('outputs\\report.md', true), /absolute target path/);
});
