function searchable(value) {
  return String(value ?? '').toLocaleLowerCase().normalize('NFKC');
}

function item({ id, type, title, meta, route, contextTab = null, entityId = id }) {
  return { id, type, title, meta, route, contextTab, entityId, haystack: searchable(`${id} ${title} ${meta}`) };
}

export function buildSearchIndex({ runs = [], tasks = [], groups = [], groupSessions = [], adapters = [] } = {}) {
  return [
    ...runs.map(run => item({
      id: run.id, type: 'run', title: run.title || run.id, meta: `${run.status || ''} ${run.integration_branch || ''} ${run.workspaceName || ''} ${run.workspacePath || ''}`,
      route: { view: 'runs', runId: run.id }
    })),
    ...tasks.map(task => item({
      id: task.id, type: 'task', title: task.title || task.id, meta: `${task.status || ''} ${task.agent || ''} ${(task.files || []).join(' ')} ${task.workspaceName || ''} ${task.workspacePath || ''}`,
      route: { view: 'tasks', runId: task.run_id || null, taskId: task.id }, contextTab: 'task'
    })),
    ...groups.map(group => item({
      id: group.id, type: 'group', title: group.name || group.id, meta: `${group.status || ''} ${group.description || ''}`,
      route: { view: 'groups' }
    })),
    ...groupSessions.map(session => item({
      id: session.id, type: 'session', title: session.title || session.requirement || session.id, meta: `${session.status || ''} ${session.group_id || ''} ${session.workspaceName || ''} ${session.workspacePath || ''}`,
      route: { view: 'groups', sessionId: session.id }, contextTab: 'discussion'
    })),
    ...adapters.map(adapter => {
      const data = typeof adapter === 'string' ? { id: adapter, name: adapter } : adapter;
      return item({
        id: data.id || data.agent || data.name, type: 'adapter', title: data.name || data.agent || data.id,
        meta: `${data.status || ''} ${data.command || ''}`, route: { view: 'groups' }
      });
    })
  ];
}

export function searchEntities(index, query, limit = 8) {
  const terms = searchable(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index
    .filter(entry => terms.every(term => entry.haystack.includes(term)))
    .map(entry => ({
      ...entry,
      score: terms.reduce((score, term) => score
        + (searchable(entry.title).startsWith(term) ? 8 : searchable(entry.title).includes(term) ? 4 : 1), 0)
    }))
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, limit);
}
