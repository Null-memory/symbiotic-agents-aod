import assert from 'node:assert/strict';
import test from 'node:test';

import * as profiles from './agent-profile-domain.mjs';

const adapter = {
  args: ['exec', '--write'],
  discussionArgs: ['exec', '--read-only'],
  reviewArgs: ['exec', '--review'],
  profiles: {
    inherit: { label: 'Follow CLI default', model: '' },
    focused: { label: 'Focused model', model: 'model-focused' },
  },
  defaultProfile: 'inherit',
  efforts: ['low', 'medium', 'high'],
  profileDefaults: {
    task: { profileKey: 'inherit', effort: 'medium' },
    discussion: { profileKey: 'inherit', effort: 'low' },
    review: { profileKey: 'inherit', effort: 'medium' },
    repair: { profileKey: 'inherit', effort: 'medium' },
  },
  profileArgs: {
    model: ['--model', '{{model}}'],
    effort: ['--effort', '{{effort}}'],
  },
};

test('publishes only safe model profile metadata for the console', () => {
  assert.equal(typeof profiles.agentProfileCatalog, 'function');
  assert.deepEqual(profiles.agentProfileCatalog({ agents: { codex: adapter } }), {
    codex: {
      defaultProfile: 'inherit',
      profiles: [
        { key: 'inherit', label: 'Follow CLI default', model: null },
        { key: 'focused', label: 'Focused model', model: 'model-focused' },
      ],
      efforts: ['low', 'medium', 'high'],
    },
  });
});

test('freezes a selected profile without copying executable arguments', () => {
  assert.equal(typeof profiles.freezeAgentProfile, 'function');
  assert.deepEqual(profiles.freezeAgentProfile(adapter, { profileKey: 'focused', effort: 'high' }), {
    profileKey: 'focused',
    profileLabel: 'Focused model',
    model: 'model-focused',
    effort: 'high',
  });
  assert.throws(() => profiles.freezeAgentProfile(adapter, { profileKey: 'missing' }), /unknown profile/i);
  assert.throws(() => profiles.freezeAgentProfile(adapter, { profileKey: 'focused', effort: 'ultra' }), /unsupported effort/i);
});

test('builds stage arguments from a frozen member profile', () => {
  assert.equal(typeof profiles.buildAgentInvocation, 'function');
  assert.deepEqual(profiles.buildAgentInvocation(adapter, 'discussion', {
    profileKey: 'focused', profileLabel: 'Old label', model: 'snapshot-model', effort: 'high'
  }), {
    argumentTemplate: ['exec', '--read-only', '--model', 'snapshot-model', '--effort', 'high'],
    profileKey: 'focused',
    profileLabel: 'Old label',
    requestedModel: 'snapshot-model',
    requestedEffort: 'high',
  });
  assert.deepEqual(profiles.buildAgentInvocation(adapter, 'repair', null).argumentTemplate, [
    'exec', '--write', '--effort', 'medium'
  ]);
});

test('rejects selected values when an adapter cannot express them safely', () => {
  assert.throws(
    () => profiles.buildAgentInvocation({ ...adapter, profileArgs: {} }, 'task', { profileKey: 'focused' }),
    /model argument template/i,
  );
  assert.throws(
    () => profiles.buildAgentInvocation({ ...adapter, profileArgs: { model: adapter.profileArgs.model } }, 'task', { profileKey: 'inherit', effort: 'high' }),
    /effort argument template/i,
  );
});
