# Symbiotic Agents AOD

一个面向同一 Git 项目的本地多 Agent 协作原型。它把任务拆为带依赖的工作单元，为每个单元创建独立的 Git worktree，并要求通过验收后才允许合并回主线。

## 启动

```powershell
npm start
```

打开 `http://127.0.0.1:4821`。项目目录必须是一个至少有一条提交记录的 Git 仓库，才能创建 worktree。

## 工作流

1. 创建任务，声明 Agent、文件所有权、依赖和验收命令。
2. 准备 worktree，系统创建独立分支和交接文件。
3. 在 worktree 内让 Agent 完成修改并提交。
4. 运行验收命令；成功后任务进入合并队列。
5. 合并分支回 `main`。

任务分支至少应包含一条新的提交；空分支无法通过合并门禁。

运行模式默认采用混合模式：系统可自动准备工作区和运行验收，但 Agent 启动与主线合并仍由操作者确认。

活动任务的文件范围不能重叠。已完成或取消的任务不会阻塞新的所有权声明。

## Agent 适配器

复制 `aod.config.example.json` 为本机的 `.aod.config.json`，为已安装的 CLI 填写正确的 `command` 和 `args`。该配置被 Git 忽略，不应放入密钥。

可用占位符：

- `{{taskId}}`
- `{{worktree}}`
- `{{promptFile}}`
- `{{prompt}}`：完整的任务交接文本，可作为单个 CLI 参数或 `stdin` 内容。

调度器使用配置的命令和参数启动进程，将工作目录设为该任务 worktree，并把标准输出、标准错误保存到任务记录。不同版本的 Codex、Claude Code 与反重力 2.0 命令行参数可能不同，因此示例配置仅是结构模板。
