import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, stylesEntry, tokensCss, shellCss, componentsCss, viewsCss, script, apiModule, layoutModule, contextDockModule, runCenterModule, groupConsoleModule, dialogsModule, workspaceModule, server, readme, configExampleText] = await Promise.all([
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
  readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/tokens.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/shell.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/components.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/views.css', import.meta.url), 'utf8'),
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/api.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/layout.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/context-dock.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/run-center.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/group-console.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/dialogs.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/workspaces.js', import.meta.url), 'utf8'),
  readFile(new URL('./server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./README.md', import.meta.url), 'utf8'),
  readFile(new URL('./aod.config.example.json', import.meta.url), 'utf8')
]);
const css = [stylesEntry, tokensCss, shellCss, componentsCss, viewsCss].join('\n');
const configExample = JSON.parse(configExampleText);

for (const id of ['appNav', 'appTopbar', 'workspaceMain', 'contextInspector', 'inspectorResizeHandle']) {
  assert.equal(html.includes(`id="${id}"`), true, `Desktop shell is missing #${id}.`);
}
for (const id of ['runStageBar', 'nextAction', 'commandSearch', 'pendingActionCount', 'contextDockViewport']) {
  assert.equal(html.includes(`id="${id}"`), true, `Adaptive workbench is missing #${id}.`);
}
for (const id of ['workspaceSelector', 'workspaceDialog', 'workspaceList', 'workspacePath', 'workspaceBrowser', 'workspaceValidation', 'validateWorkspace', 'selectWorkspace']) {
  assert.equal(html.includes(`id="${id}"`), true, `Workspace selection is missing #${id}.`);
}
assert.equal(script.includes('createWorkspaceController'), true, 'The app must initialize the workspace controller.');
for (const endpoint of ['/api/workspaces', '/api/workspaces/validate', '/api/filesystem/directories']) {
  assert.equal(workspaceModule.includes(endpoint), true, `Workspace UI is missing ${endpoint}.`);
}
assert.equal(workspaceModule.includes('/select'), true, 'Workspace UI must select a validated registered project.');
assert.equal(script.includes('workspace-badge'), true, 'Entity views must expose bound workspace badges.');
for (const tab of ['discussion', 'task', 'acceptance']) {
  assert.equal(html.includes(`data-context-tab="${tab}"`), true, `Context dock is missing the ${tab} tab.`);
  assert.equal(html.includes(`data-context-panel="${tab}"`), true, `Context dock is missing the ${tab} panel.`);
}
for (const section of ['metrics', 'process', 'approval', 'agent-health', 'run-overview']) {
  assert.equal(html.includes(`operational-disclosure ${section}-section`), true, `The ${section} area must be collapsible.`);
}
for (const view of ['runs', 'groups', 'tasks', 'delivery']) {
  assert.equal(html.includes(`data-view-panel="${view}"`), true, `Desktop shell is missing the ${view} view.`);
}
assert.equal((html.match(/data-view-panel=/g) || []).length, 4, 'Desktop shell must expose exactly four primary views.');
assert.equal(html.includes('id="viewModeSwitch"'), true, 'Desktop shell is missing the workspace display mode control.');
assert.equal(html.includes('data-view-mode="all"'), true, 'Desktop shell is missing the continuous-page option.');
assert.equal(html.includes('data-view-mode="split"'), true, 'Desktop shell is missing the separate-view option.');
assert.equal(layoutModule.includes("route.view !== 'runs'"), false, 'Routes must not fall back to the runs panel after selection.');
assert.equal(layoutModule.includes("aod.workspaceViewMode"), true, 'Workspace display mode must persist locally.');
assert.equal(layoutModule.includes('scrollIntoView'), true, 'Continuous-page navigation must reveal its selected section.');
assert.equal(shellCss.includes('.is-view-mode-all .workspace-view'), true, 'Continuous-page mode needs dedicated workspace layout rules.');
assert.match(html, /<script\s+type="module"\s+src="app\.js"><\/script>/);
assert.match(shellCss, /--inspector-width/);
assert.match(shellCss, /grid-template-columns:[^;]*var\(--inspector-width\)/);
assert.equal(tokensCss.includes('--motion-tab:160ms'), true, 'Context tab motion must use the approved fast timing.');
assert.equal(tokensCss.includes('--motion-open:200ms'), true, 'Context opening must complete in 200ms.');
assert.equal(tokensCss.includes('--motion-close:160ms'), true, 'Context closing must complete in 160ms.');
assert.equal(shellCss.includes('52px'), true, 'Collapsed context dock must retain a 52px reopen rail.');
assert.equal(shellCss.includes('.is-discussion-context'), true, 'Discussion context needs a dedicated dark surface.');
assert.match(shellCss, /@media\(max-width:1120px\)[\s\S]*?\.summary-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(shellCss, /@media\(max-width:1120px\)[\s\S]*?\.topbar-context\{display:none\}/);
assert.equal(layoutModule.includes('createContextDock'), true, 'Layout must delegate inspector behavior to the shared context dock.');
assert.equal(contextDockModule.includes('aria-valuenow'), true, 'The context dock resize separator must expose its current width.');
assert.equal(apiModule.includes('Last-Event-ID'), true);
assert.equal(runCenterModule.includes('createRunCenter'), true);
assert.equal(groupConsoleModule.includes('createGroupConsole'), true);
assert.equal(script.includes('buildGroupTimelineItems'), true, 'The message timeline must project active group turns before replies complete.');
assert.equal(script.includes('正在生成本轮内容'), true, 'The message timeline must explain buffered CLI output while a turn is running.');
assert.equal(viewsCss.includes('.group-turn-progress'), true, 'Active group turns need a visible timeline progress state.');
assert.equal(dialogsModule.includes('createDialogs'), true);
const streamEndpointSource = server.slice(server.indexOf("url.pathname === '/api/stream'"), server.indexOf("url.pathname === '/api/state'"));
const broadcastSource = server.slice(server.indexOf('function broadcast'), server.indexOf('function appendEvent'));
for (const modulePath of ['ui/context-dock.js', 'ui/render-scheduler.js', 'ui/run-stage.js', 'ui/command-search.js', 'ui/action-feedback.js']) {
  assert.equal(server.includes(`'${modulePath}'`), true, `Static server must expose ${modulePath}.`);
}
assert.match(streamEndpointSource, /last-event-id/i);
assert.match(streamEndpointSource, /streamReplay/);
assert.match(broadcastSource, /id:/);

for (const id of ['groupsBoard', 'openGroupDialog', 'groupDialog', 'groupConsole', 'groupMessages', 'groupConsensus']) {
  assert.equal(html.includes(`id="${id}"`), true, `Console is missing #${id}.`);
}
for (const id of ['addGroupMember', 'groupMemberTemplate']) {
  assert.equal(html.includes(`id="${id}"`), true, `Multi-seat group editor is missing #${id}.`);
}
for (const id of ['agentHealthBoard', 'checkAllAgents']) {
  assert.equal(html.includes(`id="${id}"`), true, `Agent diagnostics are missing #${id}.`);
}
assert.equal(html.includes('id="approvalBoard"'), true, 'Run center is missing the unified approval inbox.');
for (const id of ['metricsBoard', 'processMonitor']) {
  assert.equal(html.includes(`id="${id}"`), true, `Process observability is missing #${id}.`);
}
assert.equal(html.includes('name="agent"'), true, 'Group seats need an adapter selector.');
assert.equal(html.includes('data-remove-group-member'), true, 'Group seats need an explicit remove control.');
assert.equal(script.includes('createGroupMemberRow'), true, 'Group editor must render dynamic member rows.');
assert.equal(script.includes('nextGroupMemberKey'), true, 'New group seats need deterministic unique keys.');
assert.equal(script.includes('data-agent-health'), true, 'Agent diagnostics need per-adapter check actions.');
assert.equal(script.includes('renderAgentHealth'), true, 'Agent diagnostics need a state renderer.');
assert.equal(script.includes('renderApprovals'), true, 'Approval inbox needs a state renderer.');
assert.equal(script.includes('renderMetrics'), true, 'Operational metrics need a state renderer.');
assert.equal(script.includes('renderProcessMonitor'), true, 'Process monitor needs a state renderer.');
assert.equal(script.includes('recoveryStateCopy'), true, 'Process recovery states need explicit user-facing labels.');
assert.equal(viewsCss.includes('.metrics-adapter-row'), true, 'Metrics need stable per-adapter rows.');
assert.equal(viewsCss.includes('.process-row'), true, 'Process monitor needs stable process rows.');
assert.equal(viewsCss.includes('-webkit-line-clamp:4'), true, 'Event summaries must not expand into full stack traces.');
assert.equal(script.includes('data-approval-action'), true, 'Approval inbox needs explicit action controls.');
assert.equal(script.includes('data-approval-open'), true, 'Complex approvals need detailed-view navigation.');
assert.equal(script.includes("contextDock.open('discussion'"), true, 'Group sessions must open the discussion context.');
assert.equal(script.includes("contextDock.open('task'"), true, 'Task selection must open task context.');
assert.equal(script.includes("contextDock.open('acceptance'"), true, 'Verification and review actions must open acceptance context.');
assert.equal(script.includes('groupConsole.scrollIntoView'), false, 'Opening discussion must not move the main workspace scroll position.');
assert.equal(script.includes('buildSearchIndex'), true, 'Global command search must index the current public state.');
assert.equal(script.includes('deriveRunStage'), true, 'The stage bar must derive state from persisted run data.');
assert.equal(script.includes('createActionState'), true, 'Async controls must expose durable inline feedback.');
assert.equal(script.includes('createRefreshScheduler'), true, 'SSE events must use the coalesced refresh scheduler.');
assert.equal(script.includes('captureElementState'), true, 'Live refreshes must preserve dock input and scroll state.');
assert.equal(script.includes('refreshTimer'), false, 'The legacy ad hoc refresh timer must be removed.');

assert.match(css, /@media\s*\(max-width:560px\)[\s\S]*?\.group-mobile-tabs\s*\{[^}]*display:flex/);
assert.equal(css.includes('[data-active-pane="chat"] [data-mobile-pane]:not([data-mobile-pane="chat"])'), true);
assert.equal(css.includes('[data-active-pane="members"] [data-mobile-pane]:not([data-mobile-pane="members"])'), true);
assert.equal(css.includes('[data-active-pane="consensus"] [data-mobile-pane]:not([data-mobile-pane="consensus"])'), true);
assert.match(css, /@media\s*\(max-width:560px\)[\s\S]*?\.consensus-table[^}]*display:block/);
assert.equal(script.includes('data-turn-recover'), true);
assert.equal(script.includes('/api/group-turns/'), true);
assert.equal(
  script.includes('event.currentTarget.reset()'),
  false,
  'Async submit handlers must capture the form before awaiting.'
);
const cancelSessionSource = server.slice(
  server.indexOf('function cancelGroupSession'),
  server.indexOf('async function recoverGroupTurn')
);
assert.equal(
  cancelSessionSource.includes('processes.delete(key)'),
  false,
  'Cancellation must retain process slots until child exit handlers run.'
);
assert.equal(script.includes("auto: '自动准备、启动与验收，合并仍需人工确认'"), true);
assert.equal(readme.includes('- `auto`：自动准备、启动和验收；任务合并仍由操作者确认。'), true);
assert.equal(server.includes('Reviewer adapters require a dedicated reviewArgs array.'), true);
assert.equal(configExample.agents.codex.reviewArgs.includes('read-only'), true);
assert.equal(configExample.agents['claude-code'].reviewArgs.includes('plan'), true);

console.log('AOD frontend contract test passed');
