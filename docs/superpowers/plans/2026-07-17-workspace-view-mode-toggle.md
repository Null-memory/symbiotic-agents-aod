# Workspace View Mode Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators choose between one continuous workspace page and the existing separate primary views.

**Architecture:** Keep the hash route as the selected workspace section in both modes. Store the display mode in local storage; `split` activates only the routed panel, while `all` activates every primary panel and turns left navigation into smooth in-page navigation.

**Tech Stack:** Native HTML, CSS, JavaScript modules, Node test runner, Google Chrome.

---

### Task 1: Display mode state

**Files:**
- Modify: `ui/layout-state.js`
- Test: `layout-state.test.mjs`

- [ ] Add failing tests for valid mode normalization and all-panel activation.
- [ ] Run `node --test layout-state.test.mjs` and confirm the missing exports fail.
- [ ] Add `VIEW_MODES`, `normalizeViewMode`, and mode-aware `isViewActive`.
- [ ] Re-run the state tests and confirm they pass.

### Task 2: Mode selector and navigation

**Files:**
- Modify: `index.html`
- Modify: `ui/layout.js`
- Modify: `styles/shell.css`
- Test: `frontend-test.mjs`

- [ ] Add failing contract checks for the segmented control and persisted mode.
- [ ] Add the `整页 / 分区` control to the top bar.
- [ ] Apply and persist mode state, expose pressed state, and activate the correct panels.
- [ ] In all mode, make primary navigation smoothly reveal the selected section; retain route switching in split mode.
- [ ] Style continuous sections, separators, and mode transitions without changing mobile behavior.

### Task 3: Verification

**Files:**
- Test: `layout-state.test.mjs`
- Test: `frontend-test.mjs`

- [ ] Run `npm test` and `git diff --check`.
- [ ] Verify both display modes and all four navigation targets in the user's Google Chrome.
- [ ] Review the final diff and commit the feature.
