import assert from 'node:assert/strict';
import test from 'node:test';

import {
  didRepositorySnapshotChange,
  requireAbsoluteDirectoryPath,
  workspaceIdentity,
  workspacePathKey,
} from './workspace-domain.mjs';

test('normalizes Windows workspace paths for identity', () => {
  assert.equal(workspacePathKey('C:\\Code\\Demo\\'), 'c:\\code\\demo');
  assert.equal(workspacePathKey('c:/code/demo'), 'c:\\code\\demo');
  assert.equal(workspacePathKey('C:\\'), 'c:\\');
});

test('requires an absolute directory path without accepting relative input', () => {
  assert.equal(requireAbsoluteDirectoryPath(' C:\\Code\\Demo\\ '), 'C:\\Code\\Demo');
  assert.throws(() => requireAbsoluteDirectoryPath('demo'), /absolute/i);
  assert.throws(() => requireAbsoluteDirectoryPath(''), /required/i);
});

test('maps a persisted workspace to public entity identity fields', () => {
  assert.deepEqual(workspaceIdentity({ id: 'WS-002', name: 'Demo', git_root: 'C:\\Code\\Demo' }), {
    workspaceId: 'WS-002',
    workspaceName: 'Demo',
    workspacePath: 'C:\\Code\\Demo',
  });
  assert.deepEqual(workspaceIdentity(null), {
    workspaceId: null,
    workspaceName: null,
    workspacePath: null,
  });
});

test('detects repository HEAD or porcelain status changes exactly', () => {
  const before = { head: 'abc123', status: ' M app.js\n?? notes.txt' };
  assert.equal(didRepositorySnapshotChange(before, { ...before }), false);
  assert.equal(didRepositorySnapshotChange(before, { ...before, head: 'def456' }), true);
  assert.equal(didRepositorySnapshotChange(before, { ...before, status: 'M  app.js\n?? notes.txt' }), true);
  assert.equal(didRepositorySnapshotChange(null, before), true);
});
