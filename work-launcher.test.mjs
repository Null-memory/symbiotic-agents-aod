import assert from 'node:assert/strict';
import { buildStandaloneTaskPayload, defaultLaunchMode, launchProgressCopy, normalizeLaunchMode } from './ui/work-launcher.js';

assert.equal(defaultLaunchMode([{ status: 'active' }]), 'group');
assert.equal(defaultLaunchMode([{ status: 'archived' }]), 'plan');
assert.equal(normalizeLaunchMode('task'), 'task');
assert.equal(normalizeLaunchMode('unknown'), 'plan');

assert.deepEqual(buildStandaloneTaskPayload({
  requirement: '实现成果筛选\n补充测试',
  agent: 'claude-code',
  files: 'app.js, styles/components.css, ',
  dependsOn: 'T-001',
  acceptance: 'npm test',
  timeoutMinutes: 45,
  maxRetries: 2
}), {
  title: '实现成果筛选',
  agent: 'claude-code',
  files: ['app.js', 'styles/components.css'],
  dependsOn: ['T-001'],
  acceptance: 'npm test',
  timeoutMs: 2700000,
  maxRetries: 2
});

assert.equal(launchProgressCopy('plan', 0), '需求已提交，正在启动规划器');
assert.equal(launchProgressCopy('plan', 9000), '正在拆分任务、依赖与文件边界');
assert.equal(launchProgressCopy('group', 7000), 'Agent 正在读取项目并准备首轮观点');
assert.equal(launchProgressCopy('task', 3000), '正在刷新任务队列');

console.log('Work launcher tests passed');
