import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GROUP_ROLES,
  validateConsensusDraft,
  validateGroupDraft,
} from './group-domain.mjs';

const supportedAgents = ['codex', 'claude-code', 'antigravity'];

function validGroupDraft(overrides = {}) {
  return {
    name: 'Delivery group',
    description: 'Ships and reviews a focused change.',
    maxRounds: 3,
    maxRepairs: 2,
    moderatorKey: 'builder',
    members: [
      { key: 'builder', agent: 'codex', role: 'executor', displayName: 'Builder', instructions: 'Implement the agreed tasks.' },
      { key: 'critic', agent: 'claude-code', role: 'reviewer', displayName: 'Critic', instructions: 'Review every acceptance result.' },
      { key: 'repair', agent: 'antigravity', role: 'fixer', displayName: 'Repair', instructions: 'Repair rejected work.' },
    ],
    ...overrides,
  };
}

const memberSnapshot = {
  maxRepairs: 1,
  members: [
    { id: 'member-builder', key: 'builder', role: 'executor' },
    { id: 'member-critic', key: 'critic', role: 'reviewer' },
    { id: 'member-repair', key: 'repair', role: 'fixer' },
    { id: 'member-advisor', key: 'advisor', role: 'advisor' },
  ],
};

const allowedAcceptancePrefixes = ['node ', 'npm test', 'git diff'];

function validConsensusDraft(overrides = {}) {
  return {
    title: '  Release the group domain  ',
    summary: '  Implement and independently review the validators.  ',
    decisions: ['  Keep the module dependency-free.  '],
    risks: ['  Callers must surface validation errors.  '],
    tasks: [
      {
        key: 'domain',
        title: '  Implement domain validation  ',
        files: ['group-domain.mjs'],
        dependsOn: [],
        acceptance: '  node --check group-domain.mjs  ',
        executorMemberId: 'member-builder',
        reviewerMemberId: 'member-critic',
        fixerMemberId: 'member-repair',
      },
      {
        key: 'tests',
        title: 'Exercise domain validation',
        files: ['test\\group-domain.test.mjs'],
        dependsOn: ['domain'],
        acceptance: 'npm test',
        executorMemberId: 'member-builder',
        reviewerMemberId: 'member-critic',
        fixerMemberId: 'member-repair',
      },
    ],
    ...overrides,
  };
}

test('exports the supported group roles and normalizes a valid group', () => {
  assert.deepEqual(GROUP_ROLES, ['executor', 'reviewer', 'fixer', 'advisor']);

  const result = validateGroupDraft({
    ...validGroupDraft(),
    name: '  Delivery group  ',
    description: '  Ships and reviews a focused change.  ',
    maxRounds: undefined,
    maxRepairs: undefined,
    members: [
      { key: ' builder ', agent: 'codex', role: 'executor', displayName: '  Builder  ', instructions: '  Implement the agreed tasks.  ' },
      { key: 'critic', agent: 'claude-code', role: 'reviewer', displayName: 'Critic', instructions: 'Review every acceptance result.' },
      { key: 'repair', agent: 'antigravity', role: 'fixer', displayName: 'Repair', instructions: 'Repair rejected work.' },
    ],
  }, supportedAgents);

  assert.deepEqual(result, {
    name: 'Delivery group',
    description: 'Ships and reviews a focused change.',
    maxRounds: 3,
    maxRepairs: 2,
    members: [
      { key: 'builder', agent: 'codex', role: 'executor', displayName: 'Builder', instructions: 'Implement the agreed tasks.' },
      { key: 'critic', agent: 'claude-code', role: 'reviewer', displayName: 'Critic', instructions: 'Review every acceptance result.' },
      { key: 'repair', agent: 'antigravity', role: 'fixer', displayName: 'Repair', instructions: 'Repair rejected work.' },
    ],
    moderatorKey: 'builder',
  });
});

test('rejects duplicate agents in a group', () => {
  const members = validGroupDraft().members.map(member => ({ ...member }));
  members[1].agent = 'codex';

  assert.throws(
    () => validateGroupDraft(validGroupDraft({ members }), supportedAgents),
    /duplicate agent/i,
  );
});

test('rejects groups missing required reviewer or fixer roles', () => {
  const withoutReviewer = validGroupDraft({
    maxRepairs: 0,
    members: [
      { key: 'builder', agent: 'codex', role: 'executor' },
      { key: 'advisor', agent: 'claude-code', role: 'advisor' },
    ],
  });
  assert.throws(() => validateGroupDraft(withoutReviewer, supportedAgents), /reviewer/i);

  const withoutFixer = validGroupDraft({
    members: [
      { key: 'builder', agent: 'codex', role: 'executor' },
      { key: 'critic', agent: 'claude-code', role: 'reviewer' },
    ],
  });
  assert.throws(() => validateGroupDraft(withoutFixer, supportedAgents), /fixer/i);
});

test('enforces fixed group rounds and bounded repair limits', () => {
  for (const maxRounds of [3, '3']) {
    const normalized = validateGroupDraft(validGroupDraft({ maxRounds }), supportedAgents);
    assert.equal(normalized.maxRounds, 3);
  }
  for (const maxRepairs of [0, 1, 2, '0', '1', '2']) {
    const normalized = validateGroupDraft(validGroupDraft({ maxRepairs }), supportedAgents);
    assert.equal(normalized.maxRepairs, Number(maxRepairs));
  }

  for (const [field, value] of [
    ['maxRounds', 1],
    ['maxRounds', 2],
    ['maxRounds', 4],
    ['maxRounds', 5],
    ['maxRounds', '1'],
    ['maxRounds', '4'],
    ['maxRounds', true],
    ['maxRounds', null],
    ['maxRounds', [3]],
    ['maxRounds', { valueOf: () => 3 }],
    ['maxRounds', ''],
    ['maxRounds', '   '],
    ['maxRounds', '3.0'],
    ['maxRounds', '3e0'],
    ['maxRounds', '0x3'],
    ['maxRepairs', 3],
    ['maxRepairs', 4],
    ['maxRepairs', '3'],
    ['maxRepairs', '4'],
    ['maxRepairs', false],
    ['maxRepairs', [2]],
    ['maxRepairs', { valueOf: () => 2 }],
    ['maxRepairs', ''],
    ['maxRepairs', '2.0'],
  ]) {
    assert.throws(
      () => validateGroupDraft(validGroupDraft({ [field]: value }), supportedAgents),
      new RegExp(`${field}.*integer`, 'i'),
      `${field}: ${String(value)}`,
    );
  }
});

test('normalizes a valid consensus using the snapshot repair default', () => {
  const result = validateConsensusDraft(validConsensusDraft(), memberSnapshot, allowedAcceptancePrefixes);

  assert.deepEqual(result, {
    title: 'Release the group domain',
    summary: 'Implement and independently review the validators.',
    maxRepairs: 1,
    tasks: [
      {
        key: 'domain',
        title: 'Implement domain validation',
        files: ['group-domain.mjs'],
        dependsOn: [],
        acceptance: 'node --check group-domain.mjs',
        executorMemberId: 'member-builder',
        reviewerMemberId: 'member-critic',
        fixerMemberId: 'member-repair',
      },
      {
        key: 'tests',
        title: 'Exercise domain validation',
        files: ['test/group-domain.test.mjs'],
        dependsOn: ['domain'],
        acceptance: 'npm test',
        executorMemberId: 'member-builder',
        reviewerMemberId: 'member-critic',
        fixerMemberId: 'member-repair',
      },
    ],
    decisions: ['Keep the module dependency-free.'],
    disagreements: [],
    risks: ['Callers must surface validation errors.'],
  });
});

test('enforces consensus repair limits', () => {
  for (const maxRepairs of [0, 1, 2, '0', '1', '2']) {
    const normalized = validateConsensusDraft(validConsensusDraft({ maxRepairs }), memberSnapshot, allowedAcceptancePrefixes);
    assert.equal(normalized.maxRepairs, Number(maxRepairs));
  }

  for (const maxRepairs of [3, 4, '3', '4', true, null, [1], { valueOf: () => 1 }, '', ' ', '1.0', '1e0', '0x1']) {
    assert.throws(
      () => validateConsensusDraft(validConsensusDraft({ maxRepairs }), memberSnapshot, allowedAcceptancePrefixes),
      /maxRepairs.*integer/i,
      String(maxRepairs),
    );
  }
});

test('rejects cyclic consensus task dependencies', () => {
  const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
  tasks[0].dependsOn = ['tests'];

  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
    /cycle/i,
  );
});

test('reports a diagnostic cycle error for a dependency graph deeper than the call stack', () => {
  const taskCount = 15_000;
  const template = validConsensusDraft().tasks[0];
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    ...template,
    key: `task-${index}`,
    title: `Task ${index}`,
    files: [`generated/task-${index}.mjs`],
    dependsOn: [`task-${(index + taskCount - 1) % taskCount}`],
  }));

  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
    /cycle/i,
  );
});

test('rejects file ownership conflicts across consensus tasks', () => {
  const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
  tasks[0].files = ['SRC'];
  tasks[1].files = ['src/domain/group-domain.mjs'];

  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
    /conflict|overlap/i,
  );
});

test('rejects consensus assignments to a member with the wrong role', () => {
  const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
  tasks[0].executorMemberId = 'member-critic';

  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
    /executor/i,
  );
});

test('rejects acceptance commands outside the allowlist', () => {
  const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
  tasks[0].acceptance = 'powershell Remove-Item group-domain.mjs';

  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
    /acceptance.*allowed/i,
  );
});

test('rejects shell control operators and line breaks in acceptance commands', () => {
  const dangerousCommands = [
    'npm test && node attack.mjs',
    'npm test || node attack.mjs',
    'npm test; node attack.mjs',
    'npm test & node attack.mjs',
    'npm test | node attack.mjs',
    'npm test\nnode attack.mjs',
    'npm test\r\nnode attack.mjs',
    'npm test > out.txt',
    'npm test < input.txt',
    'npm test $(node attack.mjs)',
    'npm test `node attack.mjs`',
  ];

  for (const acceptance of dangerousCommands) {
    const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
    tasks[0].acceptance = acceptance;
    assert.throws(
      () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
      /acceptance.*control operator/i,
      acceptance,
    );
  }
});

test('allows ordinary acceptance command arguments', () => {
  for (const acceptance of [
    'npm test -- --runInBand',
    'node --test group-domain.test.mjs --test-name-pattern "validation (safe)"',
    'git diff --check',
  ]) {
    const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
    tasks[0].acceptance = acceptance;
    assert.doesNotThrow(
      () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
      acceptance,
    );
  }
});

test('rejects duplicate task keys and unsafe relative paths', () => {
  const duplicateTasks = validConsensusDraft().tasks.map(task => ({ ...task, key: 'domain' }));
  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks: duplicateTasks }), memberSnapshot, allowedAcceptancePrefixes),
    /duplicate task key/i,
  );

  const unsafeTasks = validConsensusDraft().tasks.map(task => ({ ...task }));
  unsafeTasks[0].files = ['../group-domain.mjs'];
  assert.throws(
    () => validateConsensusDraft(validConsensusDraft({ tasks: unsafeTasks }), memberSnapshot, allowedAcceptancePrefixes),
    /unsafe.*path/i,
  );
});

test('rejects Windows path segments ending in a dot or space', () => {
  const aliasedPaths = [
    'src/file.js.',
    'src/file.js ',
    'src/file.js.\t',
    'src/generated./file.js',
    'src/generated /file.js',
  ];

  for (const file of aliasedPaths) {
    const tasks = validConsensusDraft().tasks.map(task => ({ ...task }));
    tasks[0].files = [file];
    assert.throws(
      () => validateConsensusDraft(validConsensusDraft({ tasks }), memberSnapshot, allowedAcceptancePrefixes),
      /unsafe.*path/i,
      file,
    );
  }
});
