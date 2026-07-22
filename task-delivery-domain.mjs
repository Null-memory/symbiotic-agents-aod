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
