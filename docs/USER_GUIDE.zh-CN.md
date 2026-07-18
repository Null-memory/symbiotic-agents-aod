# Symbiotic Agents AOD 使用指南

本指南面向在同一台电脑、同一个本地 Git 仓库中使用 Codex、Claude Code 和 Antigravity 协同开发的操作者。

## 1. AOD 能做什么

AOD 将一次需求组织为以下交付流程：

1. 使用 Codex 或 Claude Code 规划任务 DAG。
2. 为运行创建集成分支，为每个任务创建独立 Git worktree。
3. 启动配置好的本机 Agent CLI。
4. 保存进程输出、验收结果、检查结论和事件时间线。
5. 让执行者、检查者和修复者按角色接力。
6. 通过人工门禁将任务合入运行分支。
7. 推送运行分支并创建 GitHub PR。

AOD 是单机、单操作者工具。它不会自动合并 GitHub PR，也不会把凭据写入数据库。

## 2. 环境准备

### 2.1 必需软件

- Node.js 24，或支持 `node:sqlite` 的兼容版本。
- Git。
- 至少一个已安装并完成登录的 Agent CLI：Codex、Claude Code 或 Antigravity。
- 可选：GitHub CLI `gh`，用于发布 PR 和读取 CI 状态。

在 PowerShell 中确认命令可用：

```powershell
node --version
git --version
codex --version
claude --version
gh --version
```

未使用的 Agent 可以暂时不配置，但创建任务或群组时不要选择不可用的 Agent。

### 2.2 Git 仓库要求

项目目录必须是一个已有初始提交的 Git 仓库：

```powershell
git status
git branch --show-current
git log -1 --oneline
```

默认交付目标分支为 `main`。开始运行前应保证主工作区干净：

```powershell
git status --short
```

未提交变更不会被 AOD 自动处理。请先提交、暂存到其他分支或自行保存。

## 3. 配置 Agent

在项目根目录复制示例配置：

```powershell
Copy-Item aod.config.example.json .aod.config.json
```

`.aod.config.json` 被 Git 忽略，适合存放本机命令路径和参数，但不要在其中写令牌或密码。

默认结构：

```json
{
  "reviewerAgent": "codex",
  "defaults": {
    "agentTimeoutMs": 1800000,
    "groupTurnTimeoutMs": 600000,
    "reviewTimeoutMs": 600000,
    "plannerTimeoutMs": 600000,
    "maxRetries": 0
  },
  "security": {
    "allowedAcceptancePrefixes": ["npm ", "node ", "pnpm ", "yarn ", "git ", "python ", "py "]
  },
  "agents": {
    "codex": {
      "command": "codex",
      "args": ["exec", "--sandbox", "workspace-write", "{{prompt}}"],
      "reviewArgs": ["exec", "--sandbox", "read-only", "{{prompt}}"],
      "health": { "versionArgs": ["--version"], "timeoutMs": 10000 }
    },
    "claude-code": {
      "command": "claude",
      "args": ["--print", "--permission-mode", "acceptEdits", "{{prompt}}"],
      "reviewArgs": ["--print", "--permission-mode", "plan", "{{prompt}}"]
    }
  }
}
```

常用字段：

| 字段 | 用途 |
| --- | --- |
| `reviewerAgent` | Git 冲突时默认使用的 Reviewer |
| `agentTimeoutMs` | 普通任务执行超时 |
| `groupTurnTimeoutMs` | 单个群组讨论回合超时 |
| `reviewTimeoutMs` | 检查和修复阶段超时 |
| `plannerTimeoutMs` | DAG 规划超时 |
| `allowedAcceptancePrefixes` | 允许执行的验收命令前缀 |
| `args` | Agent 可写执行参数 |
| `reviewArgs` | 检查阶段的只读参数 |
| `stdin` | 通过标准输入传递给 CLI 的内容 |
| `health.versionArgs` | 版本或基础可用性探针，默认 `--version` |
| `health.authArgs` | 可选的非交互认证状态探针；不配置时不会猜测登录命令 |
| `health.timeoutMs` | 单个体检探针超时，默认 10 秒 |

可用占位符：

- `{{taskId}}`：任务 ID。
- `{{worktree}}`：任务 worktree 绝对路径。
- `{{promptFile}}`：完整提示词文件路径。
- `{{prompt}}`：完整任务或讨论提示词。

不同 CLI 版本的参数可能不同。首次使用前，建议在终端中手动执行对应命令，确认其可以非交互退出。Agent 群组页的“Agent 连接体检”会持久化命令路径、版本、认证探针状态和耗时，但 CLI 凭据仍只由对应工具管理，不写入 AOD 数据库。

## 4. 启动 AOD

先执行检查和测试：

```powershell
npm run check
npm test
```

使用默认端口启动：

```powershell
npm start
```

打开：

```text
http://127.0.0.1:4821
```

如端口已占用，可指定其他端口：

```powershell
$env:PORT = "4823"
npm start
```

停止服务时，在启动终端中按 `Ctrl+C`。SQLite、日志和运行状态保存在项目的 `.aod/` 目录中。

## 5. 认识桌面工作台

### 左侧导航

- **运行中心**：查看指标、活动运行和事件。
- **Agent 群组**：查看群组模板和群组会话。
- **任务队列**：查看普通任务与角色任务。
- **GitHub 交付**：查看运行和 PR 状态。

顶栏的页面显示选择器支持两种方式：

- **整页**：四个区域在一个连续页面中完整显示，左侧导航用于快速定位对应区域。
- **分区**：一次只显示一个区域，左侧导航在四个独立页面之间切换。

页面显示方式和导航收起状态都会保存在浏览器本地。

### 顶栏

- 当前工作区和分支。
- `整页 / 分区` 页面显示方式。
- `manual / hybrid / auto` 运行模式。
- 全局 Agent 并发槽位。
- 守护进程与 SSE 实时连接状态。

### 统一审批中心

运行中心会把当前需要操作者决定的操作集中到一个列表，包括任务准备、Agent 启动、验收、任务合并、冲突审查、群组讨论启动、DAG 确认、恢复处理、运行发布和 CI 通过后的最终 PR 合并。

- 不需要额外输入的操作可以直接从审批行执行，服务端会在执行前重新检查该审批是否仍有效。
- 冲突补丁、可编辑 DAG、恢复选择等复杂操作会跳转到原有详细视图。
- GitHub PR 最终合并仍通过 GitHub 手动完成。
- 状态已变化的旧审批会被拒绝，不会重复执行。

### 右侧任务检查器

- 默认宽度 `360px`。
- 可拖动范围 `280-560px`。
- 双击分隔线恢复 `360px`。
- 键盘方向键微调，`Shift + 方向键` 大步调整。
- 可收起为 `52px` 操作轨道。
- 包含概览、实时输出、验收和审查视图。

## 6. 选择运行模式

| 模式 | 自动准备 worktree | 自动启动 Agent | 自动验收 | 自动合并 |
| --- | --- | --- | --- | --- |
| `manual` | 否 | 否 | 否 | 否 |
| `hybrid` | 是 | 否 | 是 | 否 |
| `auto` | 是 | 是 | 是 | 否 |

推荐日常使用 `hybrid`：系统自动处理可重复步骤，Agent 启动、任务合并和 PR 合并仍由操作者确认。

修改模式或并发槽位后，点击顶栏的“应用”。活动中的进程不会因为降低槽位而被强制终止，新任务会等待可用槽位。

## 7. 创建单个任务

适合范围明确、不需要先规划 DAG 的工作。

1. 点击“单个任务”。
2. 输入任务标题。
3. 选择执行 Agent。
4. 填写该任务拥有的文件或目录，多个范围用逗号分隔。
5. 可选：选择依赖任务。
6. 填写验收命令，例如 `npm run check`。
7. 设置超时和自动重试次数。
8. 创建任务。

任务创建后会按照当前运行模式推进。手动模式下依次执行：

1. 准备 worktree。
2. 启动 Agent。
3. 运行验收。
4. 确认合并。

任务 Agent 必须在对应 worktree 中创建至少一条新提交。只有工作区文件变化、但没有提交的任务，无法通过合并门禁。

## 8. 从需求创建运行

适合需要拆成多个并行任务的需求。

1. 点击“新建需求”。
2. 描述目标、范围、限制和完成标准。
3. 选择规划器。
4. 点击“生成预览”。
5. 检查任务 JSON 中的标题、Agent、文件范围、依赖和验收命令。
6. 确认后创建运行。

AOD 会创建：

- 运行集成分支 `aod/run-<id>`。
- 运行集成 worktree。
- 每个任务的独立分支和 worktree。

同一运行中的任务先合入运行集成分支，不直接合入 `main`。依赖任务完成后，下游任务才会进入可执行状态。

规划预览检查重点：

- 依赖图没有循环。
- 活动任务的文件范围不重叠。
- 验收命令位于允许列表中。
- Agent 在本机可用。
- 高风险改动有独立检查任务。

## 9. 使用 Agent 群组

### 9.1 创建群组

1. 点击“创建群组”。
2. 输入群组名称和描述。
3. 保留默认席位或点击“添加席位”；每个席位可选择 Codex、Claude Code 或 Antigravity。
4. 为每个席位选择角色：`executor`、`reviewer`、`fixer` 或 `advisor`。
5. 指定一名主持者。
6. 设置最大修复次数。
7. 保存群组。

约束：

- 群组必须包含执行者和检查者。
- 最大修复次数大于 0 时必须包含修复者。
- 同一个 Agent 适配器可以重复加入。例如可创建 Claude 架构师、Claude 检查者和 Claude 修复者三个席位。
- 重复席位共享本机 CLI 适配器配置，但拥有独立席位 key、显示名、职责、回合和输出。
- 主持者可以兼任成员的主角色。

### 9.2 创建并启动会话

1. 在群组上点击“新会话”。
2. 输入需要讨论的需求。
3. 创建会话并点击“启动讨论”。

固定讨论协议：

1. 第一轮：成员独立提出方案。
2. 第二轮：成员读取第一轮记录并交叉质询。
3. 第三轮：收敛分歧并确认分工。
4. 主持者生成结构化共识和任务 DAG。

讨论期间可输入操作者消息。消息在下一轮边界生效，不会强制中断当前 CLI。

### 9.3 暂停、继续与取消

- **暂停**：等待当前 CLI 回合结束，在轮次边界暂停。
- **继续**：从暂停边界继续。
- **取消**：终止活动进程并关闭会话，需要确认。

守护进程重启或成员回合失败后，会话进入恢复确认。可以：

- **重试**：使用原成员重新执行回合。
- **跳过**：跳过非主持者最终汇总回合。
- **替换**：使用群组中的另一名成员重新执行。

主持者最终汇总回合不能跳过。

### 9.4 确认共识 DAG

讨论完成后，在共识区检查：

- 任务标题和说明。
- 文件范围和依赖。
- 验收命令和风险。
- 执行者、检查者和修复者。

确认 DAG 后，AOD 创建运行并启动角色流水线：

1. 执行者修改并提交。
2. AOD 验收当前 commit。
3. 检查者在临时 detached worktree 中只读检查。
4. 检查不通过时，修复者修改原任务 worktree。
5. 重新验收和检查。
6. 检查通过后停在 `merge_ready`，等待人工合并。

## 10. 查看任务与日志

点击任务后，右侧检查器显示该任务。

- **概览**：Agent、状态、分支、commit、worktree 和文件范围。
- **实时输出**：标准输出与标准错误；支持搜索和自动跟随。
- **验收**：命令、绑定 commit 和验收输出。
- **审查**：冲突 Reviewer 状态和补丁建议。

当你向上滚动日志时，自动跟随会关闭，避免页面强制跳到底部。

验收结果只对记录中的 commit 有效。Agent 新增提交后，旧验收自动失效，必须重新执行。

## 11. 合并与冲突审查

任务进入 `merge_ready` 后，人工点击合并。

合并门禁会检查：

- 主工作区干净。
- 任务分支包含新提交。
- 依赖任务已经完成。
- 验收结果对应当前任务 HEAD。
- 目标分支和路径不存在冲突。

发生 Git 冲突时：

1. AOD 中止当前 merge，保持目标工作区干净。
2. 任务进入 `conflict_review`。
3. 点击请求 Reviewer 建议。
4. 阅读冲突文件和统一 diff 建议。
5. 将确认后的 diff 放入补丁输入区。
6. 点击应用补丁并重新验收。

Reviewer 只提供建议，不会直接修改 `main` 或运行集成分支。

## 12. GitHub 认证与 PR

### 12.1 安装和登录

确认 GitHub CLI 可用：

```powershell
gh --version
gh auth status
```

未认证时，可以点击工作台中的 GitHub 状态启动设备授权，也可以直接运行：

```powershell
gh auth login
```

设备授权时：

1. 复制终端显示的一次性代码。
2. 打开 `https://github.com/login/device`。
3. 输入代码并确认授权。
4. 返回终端等待登录完成。

凭据由 GitHub CLI 管理，不写入 AOD SQLite。

### 12.2 配置远程仓库

检查现有远程：

```powershell
git remote -v
```

已有仓库时配置 `origin`：

```powershell
git remote add origin https://github.com/OWNER/REPO.git
```

如果 `gh` 安装在非标准位置，可在启动 AOD 前设置：

```powershell
$env:AOD_GH_PATH = "C:\path\to\gh.exe"
```

### 12.3 发布运行

当运行进入可发布状态：

1. 点击“发布 PR”。
2. AOD 推送运行集成分支。
3. 创建或更新该运行对应的 PR。
4. 点击刷新 CI，读取检查状态。
5. required checks 全部通过后，在 GitHub 人工合并 PR。

AOD 当前不会自动点击 GitHub 的最终合并按钮。

## 13. 备份与清理

### 创建 SQLite 备份

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4821/api/maintenance/backup
```

备份位于 `.aod/`，默认保留最近 7 份。

### 清理终态 worktree

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4821/api/maintenance/cleanup
```

清理只处理超过保留期且已经完成、取消或失败的非锁定 worktree。活动任务、恢复任务和冲突审查任务不会被自动删除。

如果服务使用自定义端口，请替换命令中的 `4821`。

## 14. 常见问题

### 页面无法打开

- 确认 `npm start` 终端仍在运行。
- 检查终端输出的实际端口。
- 端口被占用时设置新的 `PORT`。

### Agent 启动后立即失败

- 在普通终端中手动运行 `.aod.config.json` 对应命令。
- 检查 Agent CLI 是否已登录。
- 检查当前 CLI 版本是否支持配置中的参数。
- 查看任务检查器的实时输出和退出码。

### Agent 没有产生可合并变更

- 确认 Agent 的工作目录是任务 worktree。
- 确认 Agent 已执行 `git add` 和 `git commit`。
- 空任务分支不能进入合并门禁。

### 验收命令被拒绝

- 命令必须以允许前缀开头。
- 不允许使用管道、重定向、换行或其他 shell 控制符。
- 如确有需要，在 `.aod.config.json` 的 `allowedAcceptancePrefixes` 中增加明确前缀，然后重启 AOD。

### 无法合并

- 检查主工作区是否干净。
- 检查任务是否有新提交。
- 检查验收 commit 是否仍等于任务 HEAD。
- 检查依赖任务是否完成。
- 冲突任务先完成 Reviewer 补丁流程。

### GitHub 按钮没有完成授权

- 在终端执行 `gh auth status`。
- 未登录时执行 `gh auth login`。
- 设备授权页面只接受当前终端生成的一次性代码。
- 授权成功后返回终端等待 CLI 结束，再刷新 AOD。

### 守护进程重启后任务显示“恢复确认”

这是预期行为。AOD 无法证明旧进程仍然有效，因此不会把任务误报完成。检查 worktree、分支和日志后，再选择重试、恢复或取消。

## 15. 当前限制

- 仅支持单机、单操作者和本地 Git 仓库。
- 移动端界面暂未实施，建议使用 1024px 以上桌面视口。
- GitHub PR 最终合并必须人工完成。
- AOD 不负责安装、登录或升级 Agent CLI。
- Agent 的实际质量取决于提示词、CLI 能力、模型权限和任务文件边界。

## 16. 推荐的首次验证流程

不要第一次就使用真实大需求。建议创建一个临时 Git 仓库并完成以下检查：

1. 创建一个只修改单个文本文件的任务。
2. 验证 worktree 和任务分支创建成功。
3. 验证 Agent 能修改、提交并正常退出。
4. 验证验收命令通过。
5. 人工确认任务合并。
6. 创建两成员群组，完成三轮讨论但暂不确认 DAG。
7. 检查暂停、继续和操作者消息。
8. 确认一个低风险 DAG，验证执行、检查和修复角色接力。
9. 最后再连接 GitHub 并发布测试 PR。

完成以上流程后，再将 AOD 用于正式项目。
