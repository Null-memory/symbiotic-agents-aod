# AOD Adaptive Workbench Redesign

## Goal

Redesign the desktop AOD console into a polished, efficient daily workbench that keeps run progress and Agent collaboration visible without turning the page into a long stack of unrelated sections. The approved direction combines an adaptive run-first workspace with a resizable context dock, a light/dark hybrid surface system, moderate 8px rounding, and fast spatial motion.

## Validated Direction

The visual brainstorming session established four decisions:

1. **Adaptive workbench:** preserve operational density while reorganizing information around the current delivery stage.
2. **Run plus collaboration:** run progress is the primary workspace; Agent discussion remains immediately available rather than living on a separate page.
3. **Adaptive context dock:** the right dock switches among discussion, task details, and acceptance results, can be resized or collapsed, and returns space to the run workspace.
4. **Hybrid contrast with fast fluid motion:** use light operational surfaces and a dark Agent context surface, 8px panel radii, restrained shadows, and 100-220ms interaction timing.

## Scope

This phase updates the desktop web console. It preserves the current task, run, group, approval, process, metrics, GitHub, and SSE APIs.

It includes:

- A new run-centered information hierarchy.
- A resizable, collapsible, tabbed context dock.
- Integrated Agent discussion in the default run workspace.
- A compact next-action and approval surface.
- Collapsible metrics, process, and historical sections.
- Faster and more consistent motion.
- Persisted layout preferences and scroll positions.
- Incremental rendering that preserves focus and scroll state.
- Desktop accessibility and Chrome verification.

It does not include:

- Mobile layout redesign.
- New backend orchestration behavior.
- Automatic merge or approval behavior.
- Drag-and-drop dashboard composition.
- User-authored visual themes.

## Information Architecture

### Application Shell

The shell retains four primary destinations: runs, groups, tasks, and delivery. The left navigation remains collapsible between its full and icon-only forms. The top bar contains workspace status, runtime mode, concurrency, the overview/focus switch, global search, and the pending-action count.

The existing `all / split` behavior is retained but presented as:

- **Overview:** all primary destinations remain available in one continuous workspace.
- **Focus:** only the selected primary destination is rendered as active content.

Changing a primary destination must visibly change the main workspace. Route hashes remain the source of deep-link state.

### Run Workspace

The default runs view is ordered by operational importance:

1. A sticky run stage bar for requirement, collaboration, gates, and delivery.
2. The active run and task topology.
3. Live events and the next required operator action.
4. Compact approval exceptions.
5. Collapsible metrics, process history, adapter health, and historical runs.

The stage bar shows the current stage, completed stages, blocked stages, and the next action. It must not imply that a stage is complete when its persisted run state is not complete.

### Context Dock

The right side becomes one shared context dock with three tabs:

- **Discussion:** member roster, round state, messages, and operator input.
- **Task details:** overview, output, commit/worktree metadata, and task actions.
- **Acceptance:** acceptance command, verification output, reviewer findings, and recovery information.

Selecting a task changes the dock to task details. Selecting a verification or review result changes it to acceptance. Opening a group session changes it to discussion. These transitions do not replace the main route or reset the main workspace scroll position.

The dock supports:

- Drag resize within the existing safe desktop range.
- Collapse to a 52px reopen rail.
- Main-workspace reflow when its width changes.
- Independent persisted widths for discussion and task-oriented tabs.
- Independent persisted scroll position for every tab.
- Restoration of the last open tab after reload when its entity still exists.

## Visual System

### Surfaces

- Use a cool gray application canvas.
- Use white or near-white surfaces for run planning, tasks, approvals, and metrics.
- Use a dark charcoal surface for live Agent discussion and active process context.
- Use shadows only for floating dialogs, drag state, and the currently focused context surface.
- Do not place decorative cards inside other cards. Section borders and background bands establish hierarchy.

### Shape And Spacing

- Panel radius: 8px.
- Control radius: 6px.
- Pills are reserved for compact statuses, counts, and modes.
- Spacing follows a 4/8px rhythm with 12-16px section padding.
- Stable grid tracks and minimum widths prevent status, controls, and changing labels from shifting surrounding content.

### Color

- Teal: healthy, active, completed, and selected operational state.
- Bright mint: live Agent activity on dark surfaces.
- Coral: commands, destructive actions, and high-risk gates.
- Amber: warnings, stale leases, and recovery-required states.
- Neutral gray: inactive controls and secondary metadata.

Every color-coded state also includes text or a familiar icon. Color is never the only state signal.

### Typography

- Continue using Bahnschrift with Chinese UI fallbacks for compact operational text.
- Continue using Cascadia Mono for IDs, commits, paths, metrics, and process metadata.
- Page headings remain restrained; compact panels use smaller headings and tighter line height.
- Body and actionable text must not be reduced below a readable desktop size merely to preserve one-line layouts.

## Interaction And Motion

Motion conveys spatial continuity and state change. It must feel responsive rather than decorative.

Timing targets:

- Press and hover feedback: 100-140ms.
- Tab switch and content reveal: 140-180ms.
- Context dock opening: 180-220ms.
- Context dock closing: 140-180ms.
- Main workspace reflow: approximately 200ms.
- New message and state update: 120-160ms.

Use a direct ease-out curve for exits and a restrained cubic ease for spatial transitions. Do not use bouncing panels, long-distance movement, continuous floating, or animated decoration. Live status dots may use a subtle pulse. `prefers-reduced-motion` removes all nonessential transitions and uses immediate state changes.

## Core Workflows

### Run Progression

Opening a run selects it in the run workspace and updates the stage bar. Selecting a task updates the context dock without navigating away. The main workspace continues to show sibling tasks, dependencies, and live activity while the dock shows details.

### Agent Discussion

Opening a group session selects the discussion tab. The roster remains compact, the timeline owns most vertical space, and session controls remain visible without covering messages. Operator input remains attached to the discussion context and clearly indicates that the message takes effect at the next round boundary.

### Approval And Recovery

The top bar and run workspace show the count of pending decisions. The next-action surface shows the highest-priority applicable action. Complex approvals still open their existing detailed controls in the context dock. High-risk actions retain explicit confirmation. Stale approval actions are rejected by the server and replaced inline with the current state.

### Search And Navigation

A global command search locates runs, tasks, groups, sessions, and Agent adapters. Search results navigate to the correct primary view, select the entity, and open the appropriate context tab. Keyboard navigation and deep links produce the same state as pointer navigation.

## Frontend Architecture

The current APIs remain unchanged. The frontend is reorganized around focused render units:

- `AppShell`: navigation, top bar, mode controls, route state.
- `RunStageBar`: run stages and next action.
- `RunWorkspace`: active run, topology, live events, compact operational sections.
- `ContextDock`: dock width, collapse state, tabs, and entity context.
- `DiscussionView`: roster, messages, controls, and consensus access.
- `TaskContextView`: task overview, output, and task actions.
- `AcceptanceView`: verification, reviewer findings, and recovery state.
- `CommandSearch`: indexed client-side search over current public state.
- `ActionFeedback`: button pending state and inline success/failure feedback.

The large `app.js` orchestration layer should delegate rendering and event binding to these units. This is a targeted decomposition tied to the redesign, not a broad framework rewrite.

## State And Data Flow

`/api/state` remains the initial data source. SSE continues to trigger refreshes, but events arriving within approximately 100ms are coalesced. The state store determines which render units are affected and updates only those units.

Incremental updates must preserve:

- Keyboard focus and text input.
- Main workspace scroll position.
- Discussion and task-context scroll positions.
- Selected run, task, group, and session.
- Context dock tab, width, and collapsed state.
- Expanded/collapsed secondary sections.
- Overview/focus mode.

Persisted layout preferences use versioned local storage keys so incompatible future layouts can reset safely.

## Feedback And Error States

- Async controls disable repeated activation and show an inline pending state.
- Success feedback appears near the action and does not depend solely on a global toast.
- API failures stay visible in the affected row or context panel until dismissed or superseded.
- SSE reconnect state appears in the shell and live surfaces; existing data remains visible but is marked stale.
- Recovery-required processes show `live`, `stale`, or `unverifiable` text alongside their warning color.
- Empty, loading, error, and reconnecting states reserve stable dimensions to prevent layout shifts.
- A missing entity referenced by persisted layout state falls back to the nearest valid run or an explicit empty state.

## Accessibility

- Every icon-only control has an accessible name and tooltip.
- Focus order follows navigation, main workspace, then context dock.
- The dock resize separator remains keyboard adjustable.
- Tabs use tablist semantics and expose selected state.
- Status updates use restrained live regions; streaming logs do not announce every line.
- Text and controls meet desktop contrast requirements.
- Reduced-motion behavior is verified independently.

## Verification

Automated coverage must include:

- Overview/focus routing and deep links.
- Dock tab selection, width persistence, collapse/reopen, and independent scroll restoration.
- Context changes caused by task, group session, verification, and approval selection.
- SSE refresh coalescing and preservation of focused input and scroll state.
- Pending, failure, stale approval, reconnecting, and recovery-required states.
- Keyboard navigation and reduced-motion classes.

Real Google Chrome verification must cover:

- 1280x800 and 1440x900 desktop viewports.
- Minimum, default, maximum, and collapsed dock widths.
- Navigation expanded and collapsed.
- Overview and focus modes.
- Nonempty and empty run, discussion, approval, process, and metrics states.
- Zero horizontal overflow and no overlapping text or controls.
- Motion timings that complete within the approved ranges and do not block repeated actions.

## Acceptance Criteria

The redesign is complete when a user can open AOD, understand the active run and next action from the first viewport, follow Agent discussion without leaving the run workspace, inspect a task or acceptance result in the same adaptive dock, and collapse or resize that dock without dead space or overflow. State updates must remain stable under SSE activity, and all existing human approval and merge gates must remain intact.
