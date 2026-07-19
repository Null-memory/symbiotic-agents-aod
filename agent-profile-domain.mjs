const PROFILE_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function profileEntries(adapter = {}) {
  if (!adapter.profiles || typeof adapter.profiles !== 'object' || Array.isArray(adapter.profiles)) return [];
  return Object.entries(adapter.profiles).map(([key, value]) => {
    if (!PROFILE_KEY.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid agent profile: ${key}`);
    }
    return [key, {
      label: clean(value.label) || key,
      model: clean(value.model),
    }];
  });
}

function profileMap(adapter = {}) {
  return new Map(profileEntries(adapter));
}

function allowedEfforts(adapter = {}) {
  if (adapter.efforts == null) return [];
  if (!Array.isArray(adapter.efforts)) throw new Error('Agent efforts must be an array.');
  return [...new Set(adapter.efforts.map(clean).filter(Boolean))];
}

function assertEffort(adapter, effort) {
  if (!effort) return;
  if (!allowedEfforts(adapter).includes(effort)) throw new Error(`Unsupported effort: ${effort}`);
}

export function agentProfileCatalog(config = {}) {
  const catalog = {};
  for (const [agent, adapter] of Object.entries(config.agents || {})) {
    catalog[agent] = {
      defaultProfile: clean(adapter?.defaultProfile),
      profiles: profileEntries(adapter).map(([key, profile]) => ({
        key,
        label: profile.label,
        model: profile.model || null,
      })),
      efforts: allowedEfforts(adapter),
    };
  }
  return catalog;
}

export function freezeAgentProfile(adapter = {}, selection = {}) {
  const profiles = profileMap(adapter);
  const profileKey = clean(selection.profileKey ?? selection.profile_key) || clean(adapter.defaultProfile);
  const profile = profileKey ? profiles.get(profileKey) : null;
  if (profileKey && !profile) throw new Error(`Unknown profile: ${profileKey}`);
  const effort = clean(selection.effort);
  assertEffort(adapter, effort);
  if (profile?.model && !Array.isArray(adapter.profileArgs?.model)) throw new Error('Agent model argument template is not configured.');
  if (effort && !Array.isArray(adapter.profileArgs?.effort)) throw new Error('Agent effort argument template is not configured.');
  return {
    profileKey,
    profileLabel: profile?.label || 'Adapter default',
    model: profile?.model || null,
    effort,
  };
}

function stageName(stage) {
  if (stage === 'execute') return 'task';
  if (stage === 'conflict_review') return 'review';
  return stage;
}

function argumentTemplate(adapter, stage) {
  if (stage === 'discussion') return adapter.discussionArgs ?? adapter.reviewArgs;
  if (stage === 'review') return adapter.reviewArgs;
  return adapter.args;
}

function expandProfileArgs(template, values) {
  return template.map(value => String(value)
    .replaceAll('{{model}}', values.model)
    .replaceAll('{{effort}}', values.effort)
    .replaceAll('{{profile}}', values.profile));
}

export function buildAgentInvocation(adapter = {}, stage, selection = null) {
  const normalizedStage = stageName(stage);
  const base = argumentTemplate(adapter, normalizedStage);
  if (!Array.isArray(base)) throw new Error(`No argument template is configured for ${normalizedStage}.`);

  const defaults = adapter.profileDefaults?.[normalizedStage] || {};
  const profiles = profileMap(adapter);
  const hasFrozenModel = selection != null && Object.prototype.hasOwnProperty.call(selection, 'model');
  const profileKey = clean(selection?.profileKey ?? selection?.profile_key)
    || clean(defaults.profileKey ?? defaults.profile)
    || clean(adapter.defaultProfile);
  const profile = profileKey ? profiles.get(profileKey) : null;
  if (profileKey && !profile && !hasFrozenModel) throw new Error(`Unknown profile: ${profileKey}`);

  const requestedModel = clean(hasFrozenModel ? selection.model : profile?.model) || null;
  const requestedEffort = clean(selection?.effort) || clean(defaults.effort) || null;
  assertEffort(adapter, requestedEffort);
  const profileLabel = clean(selection?.profileLabel ?? selection?.profile_label) || profile?.label || 'Adapter default';
  const result = base.map(String);

  if (requestedModel) {
    if (!Array.isArray(adapter.profileArgs?.model)) throw new Error('Agent model argument template is not configured.');
    result.push(...expandProfileArgs(adapter.profileArgs.model, { model: requestedModel, effort: requestedEffort || '', profile: profileKey }));
  }
  if (requestedEffort) {
    if (!Array.isArray(adapter.profileArgs?.effort)) throw new Error('Agent effort argument template is not configured.');
    result.push(...expandProfileArgs(adapter.profileArgs.effort, { model: requestedModel || '', effort: requestedEffort, profile: profileKey }));
  }

  return { argumentTemplate: result, profileKey, profileLabel, requestedModel, requestedEffort };
}
