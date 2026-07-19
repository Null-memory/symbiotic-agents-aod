export const GROUP_ROLES = Object.freeze(['executor', 'reviewer', 'fixer', 'advisor']);
const GROUP_TURN_COMPLETION_STATUSES = new Set(['completed', 'skipped', 'replaced']);

export function recoveryTurnStatus(action) {
  if (action === 'skip') return 'skipped';
  if (action === 'replace') return 'replaced';
  return 'superseded';
}

export function completedGroupTurnMemberIds(turns) {
  return new Set((turns || [])
    .filter(turn => GROUP_TURN_COMPLETION_STATUSES.has(turn.status))
    .map(turn => turn.member_id));
}

function compactMiddle(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  const marker = '\n...[middle omitted]...\n';
  if (limit <= marker.length + 2) return text.slice(-limit);
  const available = limit - marker.length;
  const head = Math.ceil(available * 0.55);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

export function buildBoundedGroupContext(messages = [], { totalChars = 48000, perMessageChars = 8000 } = {}) {
  const total = Math.max(0, Number(totalChars) || 0);
  const perMessage = Math.max(1, Number(perMessageChars) || 1);
  const blocks = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const sender = message.sender_member_id || message.sender_kind || 'unknown';
    const header = `[round ${message.round} / ${message.phase} / ${sender}]\n`;
    const block = `${header}${compactMiddle(message.content, perMessage)}`;
    const separator = blocks.length ? 2 : 0;
    if (used + separator + block.length > total) continue;
    blocks.unshift(block);
    used += separator + block.length;
  }
  return blocks.join('\n\n');
}

export function groupPhaseResponseGuidance(phase) {
  if (phase === 'synthesis') {
    return 'Return JSON only. Keep summaries, decisions, disagreements, and risks concise; include no fields outside the required schema.';
  }
  const focus = {
    proposal: 'Do not restate the requirement or emit a final DAG.',
    critique: 'Challenge only material assumptions; do not repeat proposals or emit a final DAG.',
    convergence: 'State only resolved decisions, assignments, dependencies, and verification.'
  }[phase] || 'Keep only decisions that advance the discussion.';
  return `Response budget: at most 6 bullets and 900 characters. ${focus}`;
}

export function acceptanceCommandGuidance(prefixes = []) {
  const commands = prefixes.map(prefix => String(prefix).trim()).filter(Boolean);
  const allowed = commands.length ? commands.join(', ') : 'npm, node, pnpm, yarn, git, python, py';
  return `Acceptance must be a complete executable command starting with one of: ${allowed}. A flags-only value is invalid; for example, normalize "--check server.mjs" to "node --check server.mjs".`;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/i;

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value) {
  return value == null ? '' : String(value).trim();
}

function boundedInteger(value, fallback, min, max, label) {
  const candidate = value === undefined ? fallback : value;
  let normalized;
  if (typeof candidate === 'number') normalized = candidate;
  else if (typeof candidate === 'string' && /^[+-]?\d+$/.test(candidate.trim())) normalized = Number(candidate.trim());
  else {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return normalized;
}

function validKey(value, label) {
  const key = requiredString(value, label);
  if (!KEY_PATTERN.test(key)) throw new Error(`${label} is invalid: ${key}`);
  return key;
}

export function validateGroupDraft(payload, supportedAgents, profileCatalog = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Group draft must be an object.');

  const name = requiredString(payload.name, 'Group name');
  const description = optionalString(payload.description);
  const maxRounds = boundedInteger(payload.maxRounds, 3, 3, 3, 'maxRounds');
  const maxRepairs = boundedInteger(payload.maxRepairs, 2, 0, 2, 'maxRepairs');
  if (!Array.isArray(payload.members) || payload.members.length < 2) throw new Error('A group requires at least two members.');

  const supported = supportedAgents instanceof Set ? supportedAgents : new Set(Array.isArray(supportedAgents) ? supportedAgents : []);
  const keys = new Set();
  const members = payload.members.map((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error(`Member ${index + 1} must be an object.`);
    const key = validKey(member.key, `Member ${index + 1} key`);
    const agent = requiredString(member.agent, `Member ${key} agent`);
    const role = requiredString(member.role, `Member ${key} role`);
    if (keys.has(key)) throw new Error(`Duplicate member key: ${key}`);
    if (!supported.has(agent)) throw new Error(`Member ${key} has an unsupported agent: ${agent}`);
    if (!GROUP_ROLES.includes(role)) throw new Error(`Member ${key} has an invalid role: ${role}`);
    const profileKey = optionalString(member.profileKey ?? member.profile_key);
    const effort = optionalString(member.effort);
    const agentProfiles = profileCatalog?.[agent];
    if (profileKey && (!agentProfiles || !agentProfiles.profiles?.some(profile => profile.key === profileKey))) {
      throw new Error(`Member ${key} selected an unknown profile: ${profileKey}`);
    }
    if (effort && (!agentProfiles || !agentProfiles.efforts?.includes(effort))) {
      throw new Error(`Member ${key} selected an unsupported effort: ${effort}`);
    }
    keys.add(key);
    return {
      key,
      agent,
      role,
      displayName: optionalString(member.displayName),
      instructions: optionalString(member.instructions),
      profileKey,
      effort,
    };
  });

  const moderatorKey = requiredString(payload.moderatorKey, 'moderatorKey');
  if (!keys.has(moderatorKey)) throw new Error('moderatorKey must identify a group member.');
  if (!members.some(member => member.role === 'executor')) throw new Error('A group requires at least one executor.');
  if (!members.some(member => member.role === 'reviewer')) throw new Error('A group requires at least one reviewer.');
  if (maxRepairs > 0 && !members.some(member => member.role === 'fixer')) throw new Error('A group with repairs requires at least one fixer.');

  return { name, description, maxRounds, maxRepairs, members, moderatorKey };
}

function normalizeSnapshot(memberSnapshot) {
  if (Array.isArray(memberSnapshot)) return { members: memberSnapshot, maxRepairs: 2 };
  if (!memberSnapshot || typeof memberSnapshot !== 'object') throw new Error('Member snapshot must provide members.');
  return {
    members: memberSnapshot.members,
    maxRepairs: memberSnapshot.maxRepairs ?? memberSnapshot.group?.maxRepairs ?? 2,
  };
}

function normalizePath(value, taskKey) {
  const original = requiredString(value, `Task ${taskKey} file`);
  const path = original.replaceAll('\\', '/');
  const segments = path.split('/');
  const rawSegments = value.replaceAll('\\', '/').split('/');
  const normalizedSegments = segments.map(segment => segment.trim());
  if (
    path.startsWith('/')
    || path.startsWith('~')
    || path.includes(':')
    || /[\0\r\n]/.test(path)
    || normalizedSegments.some(segment => !segment || segment === '.' || segment === '..' || segment.endsWith('.'))
    || rawSegments.some(segment => /[. ]$/.test(segment))
  ) {
    throw new Error(`Unsafe relative path in task ${taskKey}: ${original}`);
  }
  return segments.join('/');
}

function pathsOverlap(left, right) {
  const a = left.replace(/\/$/, '').toLocaleLowerCase('en-US');
  const b = right.replace(/\/$/, '').toLocaleLowerCase('en-US');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function noteArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map(item => typeof item === 'string' ? item.trim() : item);
}

function validateDependencies(tasks, keys) {
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!keys.has(dependency)) throw new Error(`Task ${task.key} has an unknown dependency: ${dependency}`);
    }
  }

  const indegrees = new Map();
  const dependents = new Map(tasks.map(task => [task.key, []]));
  for (const task of tasks) {
    indegrees.set(task.key, task.dependsOn.length);
    for (const dependency of task.dependsOn) dependents.get(dependency).push(task.key);
  }

  const ready = tasks.filter(task => indegrees.get(task.key) === 0).map(task => task.key);
  let processed = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const key = ready[index];
    processed += 1;
    for (const dependent of dependents.get(key)) {
      const nextIndegree = indegrees.get(dependent) - 1;
      indegrees.set(dependent, nextIndegree);
      if (nextIndegree === 0) ready.push(dependent);
    }
  }
  if (processed !== tasks.length) throw new Error('Task dependencies contain a cycle.');
}

export function validateConsensusDraft(payload, memberSnapshot, allowedAcceptancePrefixes) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Consensus draft must be an object.');
  const title = requiredString(payload.title, 'Consensus title');
  const summary = requiredString(payload.summary, 'Consensus summary');
  if (!Array.isArray(payload.tasks) || !payload.tasks.length) throw new Error('Consensus requires at least one task.');

  const snapshot = normalizeSnapshot(memberSnapshot);
  if (!Array.isArray(snapshot.members)) throw new Error('Member snapshot must provide members.');
  const maxRepairs = boundedInteger(payload.maxRepairs, snapshot.maxRepairs, 0, 2, 'maxRepairs');
  const membersById = new Map();
  for (const member of snapshot.members) {
    if (!member || typeof member !== 'object') continue;
    const id = optionalString(member.id ?? member.memberId ?? member.key);
    if (!id) continue;
    if (membersById.has(id)) throw new Error(`Duplicate member id in snapshot: ${id}`);
    membersById.set(id, member);
  }

  const allowedPrefixes = Array.isArray(allowedAcceptancePrefixes)
    ? allowedAcceptancePrefixes.filter(prefix => typeof prefix === 'string' && prefix.length > 0)
    : [];
  const keys = new Set();
  const tasks = payload.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`Task ${index + 1} must be an object.`);
    const key = validKey(task.key, `Task ${index + 1} key`);
    if (keys.has(key)) throw new Error(`Duplicate task key: ${key}`);
    keys.add(key);
    const taskTitle = requiredString(task.title, `Task ${key} title`);
    if (!Array.isArray(task.files) || !task.files.length) throw new Error(`Task ${key} requires at least one file.`);
    const files = task.files.map(file => normalizePath(file, key));
    const dependsOn = task.dependsOn == null
      ? []
      : Array.isArray(task.dependsOn)
        ? task.dependsOn.map(dependency => validKey(dependency, `Task ${key} dependency`))
        : (() => { throw new Error(`Task ${key} dependsOn must be an array.`); })();
    if (typeof task.acceptance === 'string' && (/[;&|<>`\r\n]/.test(task.acceptance) || task.acceptance.includes('$('))) {
      throw new Error(`Task ${key} acceptance command contains a shell control operator.`);
    }
    const acceptance = requiredString(task.acceptance, `Task ${key} acceptance`);
    if (!allowedPrefixes.some(prefix => acceptance.startsWith(prefix))) {
      throw new Error(`Task ${key} acceptance command is not allowed: ${acceptance}`);
    }

    const assignment = (field, role, required = true) => {
      const memberId = optionalString(task[field]);
      if (!memberId && !required) return null;
      const member = membersById.get(memberId);
      if (!member || member.role !== role) throw new Error(`Task ${key} ${field} must identify a ${role} member.`);
      return memberId;
    };

    return {
      key,
      title: taskTitle,
      files,
      dependsOn,
      acceptance,
      executorMemberId: assignment('executorMemberId', 'executor'),
      reviewerMemberId: assignment('reviewerMemberId', 'reviewer'),
      fixerMemberId: assignment('fixerMemberId', 'fixer', maxRepairs > 0),
    };
  });

  validateDependencies(tasks, keys);
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      for (const a of tasks[left].files) {
        for (const b of tasks[right].files) {
          if (pathsOverlap(a, b)) throw new Error(`Task file ownership conflict: ${a} overlaps with ${b}.`);
        }
      }
    }
  }

  return {
    title,
    summary,
    maxRepairs,
    tasks,
    decisions: noteArray(payload.decisions, 'decisions'),
    disagreements: noteArray(payload.disagreements, 'disagreements'),
    risks: noteArray(payload.risks, 'risks'),
  };
}
