import { isAbsolute, normalize, parse } from 'node:path';

export function requireAbsoluteDirectoryPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A workspace path is required.');
  const candidate = value.trim();
  if (!isAbsolute(candidate)) throw new Error('Workspace paths must be absolute.');
  const normalized = normalize(candidate);
  const root = parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/, '');
}

export function workspacePathKey(value) {
  const normalized = requireAbsoluteDirectoryPath(value).replaceAll('/', '\\');
  return /^(?:[a-z]:\\|\\\\)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function workspaceIdentity(workspace) {
  return {
    workspaceId: workspace?.id || null,
    workspaceName: workspace?.name || null,
    workspacePath: workspace?.git_root || null,
  };
}

export function didRepositorySnapshotChange(before, after) {
  if (!before || !after) return true;
  return before.head !== after.head || before.status !== after.status;
}
