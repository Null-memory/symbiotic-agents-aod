import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, stylesEntry, tokensCss, shellCss, componentsCss, viewsCss, script, apiModule, layoutModule, runCenterModule, groupConsoleModule, dialogsModule, server, readme, configExampleText] = await Promise.all([
  readFile(new URL('./index.html', import.meta.url), 'utf8'),
  readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/tokens.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/shell.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/components.css', import.meta.url), 'utf8'),
  readFile(new URL('./styles/views.css', import.meta.url), 'utf8'),
  readFile(new URL('./app.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/api.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/layout.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/run-center.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/group-console.js', import.meta.url), 'utf8'),
  readFile(new URL('./ui/dialogs.js', import.meta.url), 'utf8'),
  readFile(new URL('./server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./README.md', import.meta.url), 'utf8'),
  readFile(new URL('./aod.config.example.json', import.meta.url), 'utf8')
]);
const css = [stylesEntry, tokensCss, shellCss, componentsCss, viewsCss].join('\n');
const configExample = JSON.parse(configExampleText);

for (const id of ['appNav', 'appTopbar', 'workspaceMain', 'contextInspector', 'inspectorResizeHandle']) {
  assert.equal(html.includes(`id="${id}"`), true, `Desktop shell is missing #${id}.`);
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
assert.match(shellCss, /@media\(max-width:1120px\)[\s\S]*?\.summary-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(shellCss, /@media\(max-width:1120px\)[\s\S]*?\.topbar-context\{display:none\}/);
assert.equal(layoutModule.includes('aria-valuenow'), true);
assert.equal(apiModule.includes('Last-Event-ID'), true);
assert.equal(runCenterModule.includes('createRunCenter'), true);
assert.equal(groupConsoleModule.includes('createGroupConsole'), true);
assert.equal(dialogsModule.includes('createDialogs'), true);
const streamEndpointSource = server.slice(server.indexOf("url.pathname === '/api/stream'"), server.indexOf("url.pathname === '/api/state'"));
const broadcastSource = server.slice(server.indexOf('function broadcast'), server.indexOf('function appendEvent'));
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
assert.equal(script.includes('data-approval-action'), true, 'Approval inbox needs explicit action controls.');
assert.equal(script.includes('data-approval-open'), true, 'Complex approvals need detailed-view navigation.');

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
