# Selectable Project Workspaces Chrome Verification

## Environment

- Date: 2026-07-18
- Browser: Google Chrome through the Chrome DevTools connection on `127.0.0.1:9223`
- Application: `http://127.0.0.1:4826`
- Control worktree: `<control-worktree>`
- Fixture repository: `<fixture-repository>`
- Viewport: `1600x863`
- Scope: desktop workspace selection; mobile remains out of scope

The Codex in-app browser was not used.

## Interaction Coverage

- Opened the top-bar project selector and browsed its registered repositories.
- Entered and validated the fixture repository by absolute path.
- Registered and selected the fixture as `WS-002`.
- Confirmed the top bar changed to the fixture repository, branch `main`.
- Confirmed an existing approval retained its original control-worktree workspace badge and path after the active workspace changed.
- Reopened the selector, selected `WS-001`, and confirmed the top bar returned to the control worktree, branch `feature/agent-groups`.
- Confirmed the dirty status was visible for the control worktree without blocking registration or read-only selection.

## Results

| Check | Result |
| --- | --- |
| Absolute-path validation | Passed |
| Repository registration | Passed |
| Active workspace switch | Passed |
| Immutable historical workspace badge | Passed |
| Switch back to control workspace | Passed |
| Document/body horizontal overflow | `0px` |
| Top-bar overflow | None |
| Console/runtime errors | `0` |

Unavailable-path behavior and cross-project execution gates are covered by the integration suite. They were not forced destructively in the retained Chrome demo environment.
