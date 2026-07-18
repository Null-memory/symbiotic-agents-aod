# Adaptive Workbench Chrome Verification

## Environment

- Date: 2026-07-18
- Browser: Google Chrome 150.0.7871.128
- Browser control: native Chrome DevTools Protocol on `127.0.0.1:9223`
- Application: `http://127.0.0.1:4825`
- Worktree: `E:\多agent协同-agent-groups`
- Mobile verification: out of scope for this desktop phase

The Codex in-app browser was not used.

## Automated Results

The reusable CDP check is `docs/verification/chrome-workbench-verify.mjs`. Raw output is stored in `docs/verification/chrome-workbench-results.json`.

| Check | Result |
| --- | --- |
| 1440x900 document/body horizontal overflow | `0px / 0px` |
| 1280x800 document/body horizontal overflow | `0px / 0px` |
| Default task dock | `360px` |
| Discussion dock | `500px`, `rgb(24, 35, 38)` |
| Keyboard minimum / maximum | `280px / 560px` |
| Collapsed dock rail | `52px` |
| Collapsed navigation | `72px` |
| Overview mode active views | `4` |
| Focus mode active view | `groups` only |
| Global search focus | `commandSearch` |
| Search result count for `Chrome` | `2` |
| Reduced-motion shell transition | `0s` |
| Reduced-motion panel animation | `0s` |
| Console/runtime errors | `0` |

Approved motion tokens were confirmed from computed styles:

- Press/hover feedback: `120ms`
- Context tab reveal: `160ms`
- Context open and workspace reflow: `200ms`
- Context close: `160ms`
- General layout reflow: `200ms`

## Interaction Coverage

- Drag/keyboard width state uses independent discussion and task-oriented widths.
- `Home`, `End`, and double-click resize behavior reaches minimum, maximum, and default widths.
- Collapsing the dock returns its space to the main workspace and leaves a usable 52px reopen rail.
- Navigation collapse returns space to the main workspace.
- Overview activates all four primary areas; Focus activates only the selected area.
- Opening a stored group session switches the shared dock to Discussion without replacing the Groups workspace.
- `Ctrl+K` focuses global search and current-state indexing returns matching entities.
- Empty discussion and populated group-session states both render without overlap.
- Long event error text is constrained to a four-line summary instead of expanding the timeline.

## Defect Found During Verification

The first Chrome load showed styled static HTML but no live data because the server's static-file allowlist did not include the five new frontend modules. A frontend contract test now requires those paths, and `server.mjs` serves them. The page then loaded state, SSE, search, layout controls, and context behavior without console errors.

## Screenshots

- `docs/verification/assets/adaptive-workbench-1440-task.png`
- `docs/verification/assets/adaptive-workbench-1440-discussion.png`
- `docs/verification/assets/adaptive-workbench-1440-active-discussion.png`
- `docs/verification/assets/adaptive-workbench-1440-collapsed.png`
- `docs/verification/assets/adaptive-workbench-1280.png`
