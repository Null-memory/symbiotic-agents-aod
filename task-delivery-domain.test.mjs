import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryArtifactGuidance, verificationSnapshotProblem } from './task-delivery-domain.mjs';

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
