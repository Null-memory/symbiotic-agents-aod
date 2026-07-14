# Symbiotic Agents AOD

一个面向同一 Git 项目的本地多 Agent 协作器。它将运行、任务、事件、结构化日志、验收记录、进程状态和冲突审查持久化到 SQLite，为每个工作单元创建独立 Git worktree，并只允许通过当前提交验证的变更合并回主线。

## 启动

```powershell
npm start
```

打开 `http://127.0.0.1:4821`。项目目录必须是一个至少有一条提交记录的 Git 仓库，才能创建 worktree。

## 运行模式

- `manual`：准备、启动 Agent、验收和合并均由操作者触发。
- `hybrid`：依赖满足后自动准备 worktree，Agent 正常退出后自动验收；启动与合并由操作者确认。
- `auto`：自动准备、启动、验收与合并；Git 冲突始终转入人工审查。

守护进程重启后，运行中任务会进入“恢复确认”，不会被错误标记为完成。

## 运行与 DAG 规划

控制台中的“新建运行”会将自然语言需求交给 Codex 规划器，返回可编辑的任务 DAG 预览。确认后，AOD 会创建一个独立集成分支 `aod/run-<id>` 和集成 worktree；运行内任务只合入该分支，不会直接改动 `main`。

当所有运行任务完成后，运行进入 `ready_to_publish`。此时可推送集成分支并创建一个 GitHub PR。最终 PR 合并始终由操作者在 GitHub 确认。

## 工作流

1. 创建任务，声明 Agent、文件所有权、依赖和验收命令。
2. 准备 worktree，系统创建独立分支和交接文件。
3. 在 worktree 内让 Agent 完成修改并提交。
4. 运行验收命令；成功后任务进入合并队列。
5. 合并分支回 `main`。

任务分支至少应包含一条新的提交；空分支无法通过合并门禁。

运行模式默认采用混合模式：系统可自动准备工作区和运行验收，但 Agent 启动与主线合并仍由操作者确认。

活动任务的文件范围不能重叠。已完成或取消的任务不会阻塞新的所有权声明。

## 冲突审查

合并发生 Git 冲突时，主线会立即执行 `merge --abort` 并保持干净。系统记录冲突文件和 diff，创建 Reviewer 任务。Reviewer 只能提出统一 diff 建议；操作者核对后粘贴补丁，系统才会将补丁应用到原任务 worktree、提交并重新验收。

## Agent 适配器

复制 `aod.config.example.json` 为本机的 `.aod.config.json`，为已安装的 CLI 填写正确的 `command` 和 `args`。该配置被 Git 忽略，不应放入密钥。

可用占位符：

- `{{taskId}}`
- `{{worktree}}`
- `{{promptFile}}`
- `{{prompt}}`：完整的任务交接文本，可作为单个 CLI 参数或 `stdin` 内容。

调度器使用配置的命令和参数启动进程，将工作目录设为该任务 worktree，并把标准输出、标准错误保存到任务记录。不同版本的 Codex、Claude Code 与反重力 2.0 命令行参数可能不同，因此示例配置仅是结构模板。

验收命令默认仅允许 `npm`、`node`、`pnpm`、`yarn`、`git`、`python` 和 `py` 前缀。可在 `security.allowedAcceptancePrefixes` 调整。常见令牌会从结构化日志和验收输出中脱敏。

## GitHub 交付

安装 GitHub CLI 后，在控制台点击 GitHub 状态启动设备授权。完成浏览器授权后，运行可发布到已存在的 `origin`。若没有远程仓库，调用发布接口时需提供 `owner/repo`，AOD 会通过 `gh repo create` 创建仓库、配置 `origin` 并推送。

GitHub CLI 默认路径会自动检测 Windows 标准安装位置。若使用自定义路径，可设置环境变量 `AOD_GH_PATH`。

## 运维

`POST /api/maintenance/backup` 创建 SQLite 快照，保留最近 7 份。`POST /api/maintenance/cleanup` 只清理超过保留期且状态为已完成、已取消或失败的非锁定 worktree；冲突审查任务永不自动清理。

## 验证

```powershell
npm run check
npm test
```
