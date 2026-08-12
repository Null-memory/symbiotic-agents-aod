import { win32 } from 'node:path';

const DELIVERY_GUIDANCE = [
  'Delivery requirements:',
  'Document and summary work must create an actual artifact in the requested format; when no format is specified, use Markdown (.md). Do not provide the result only in chat or stdout.',
  'Code and engineering work must report the project location plus exact install and start commands.',
  'When a runnable project or tool can reasonably support it, include a ready-to-run one-click startup script in the owned paths and verify that script.',
].join(' ');

export function deliveryArtifactGuidance() {
  return DELIVERY_GUIDANCE;
}

export function verificationSnapshotProblem({ baseCommit, headCommit, porcelain, requiresCommit = false }) {
  if (String(porcelain || '').trim()) {
    return 'Task worktree has uncommitted changes. Commit every owned artifact before verification.';
  }
  if (requiresCommit && String(headCommit || '').trim() === String(baseCommit || '').trim()) {
    return 'Group executor completed without creating a new commit.';
  }
  return null;
}

const documentExtensions = new Set(['.md', '.txt', '.json', '.csv', '.html', '.pdf', '.docx', '.pptx', '.xlsx']);
const textExtensions = new Set(['.md', '.txt', '.json', '.csv', '.html', '.xml', '.yaml', '.yml', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.cmd', '.bat', '.ps1', '.sh']);
const launcherExtensions = new Set(['.cmd', '.bat', '.ps1', '.sh']);

export function taskArtifactDescriptor(value) {
  const path = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const name = path.split('/').pop() || path;
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  const outputDirectory = /^(outputs?|artifacts?|deliverables?)\//i.test(path);
  const kind = /^readme(?:\.|$)/i.test(name)
    ? 'guide'
    : launcherExtensions.has(extension)
      ? 'launcher'
      : documentExtensions.has(extension)
        ? 'document'
        : 'source';
  return {
    path,
    name,
    extension,
    kind,
    text: textExtensions.has(extension),
    primary: outputDirectory || kind === 'document',
  };
}

export function resolveArtifactRevealTarget(rootPath, relativePath) {
  const rawRoot = String(rootPath || '');
  const relative = String(relativePath || '').replaceAll('/', '\\');
  if (!win32.isAbsolute(rawRoot) || !relative || win32.isAbsolute(relative)) throw new Error('Artifact reveal requires an absolute registered root and a relative artifact path.');
  const root = win32.resolve(rawRoot);
  const target = win32.resolve(root, relative);
  const boundary = win32.relative(root, target);
  if (!boundary || boundary === '..' || boundary.startsWith(`..${win32.sep}`) || win32.isAbsolute(boundary)) {
    throw new Error('Artifact reveal target escapes the registered worktree.');
  }
  return target;
}

export function windowsExplorerRevealInvocation(targetPath, selectFile = false) {
  const rawTarget = String(targetPath || '');
  if (!win32.isAbsolute(rawTarget)) throw new Error('Windows Explorer requires an absolute target path.');
  const target = win32.normalize(rawTarget);
  return { command: 'explorer.exe', args: selectFile ? [`/select,${target}`] : [target] };
}
