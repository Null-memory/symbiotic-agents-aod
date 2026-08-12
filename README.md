# Symbiotic Agents AOD

> **项目状态说明**
>
> 这是一个 vibe-coding 过程中的实验性产物，不是成熟稳定的软件。当前功能还不完善，很多边界情况、安装体验和跨环境兼容性都可能有问题。作者学业较重，更新和维护节奏会比较慢。你可以自己 clone 下来试一试、改一改，但请务必谨慎使用，不建议直接用于重要仓库、生产环境或不可轻易回滚的工作流。

一个可管理多个本地 Git 项目的多 Agent 协作器。它将运行、任务、事件、结构化日志、验收记录、进程状态和冲突审查持久化到全局 SQLite 控制平面，为每个工作单元创建独立 Git worktree，并只允许通过当前提交验证的变更合并回对应项目主线。

完整操作步骤参见：[中文使用指南](docs/USER_GUIDE.zh-CN.md)。

## 本机部署

AOD 当前是本机运行的 Node.js 桌面 Web 服务，不是已经打包好的桌面安装器。建议先在一台有 Git、Node.js 24 和目标 Agent CLI 的 Windows 机器上部署：

```powershell
git clone https://github.com/Null-memory/symbiotic-agents-aod.git
cd symbiotic-agents-aod
npm install
Copy-Item .\aod.config.example.json .\.aod.config.json
notepad .\.aod.config.json
npm run check
npm start
```

打开 `http://127.0.0.1:4821`。项目目录必须是一个至少有一条提交记录的 Git 仓库，才能创建 worktree。

`.aod.config.json` 只保存本机 CLI 启动命令和参数模板，已被 Git 忽略；不要把 API Key、账号密码或签名文件提交到仓库。若需要换端口，可以在启动前设置：

```powershell
$env:PORT = "4821"
npm start
```

面向他人试用时，建议只发布源码仓库和 GitHub Release 附件；不要提交 `.aod/` 数据库、`.aod.config.json`、`node_modules/`、Android 签名文件或本地构建目录。

## 项目工作区

顶栏项目选择器可以注册主机内已有的 Git 仓库。Windows 上可以直接点击“Windows 文件夹”打开系统文件夹选择器，选择结果会自动回填并验证；也支持直接输入绝对路径或从服务器目录浏览器选择目录。选择仓库子目录时会自动解析到真实 Git 根。仓库必须至少包含一次提交，非 Git 目录、bare 仓库和空仓库不会被注册。

当前选择只决定新建计划、运行、独立任务和群组会话的默认项目。已有实体永久绑定到创建时的项目，切换顶栏项目不会让旧任务、Reviewer、合并或 GitHub 发布改到其他仓库。脏仓库可以注册并用于只读群组讨论，但创建运行、worktree 或合并时仍受现有 clean gate 限制。

## Android 移动端

移动端位于 `mobile/`，使用 Expo Android 客户端连接桌面 AOD 服务。第一版默认关闭远程访问；需要先允许移动端监听局域网、Tailscale 或 VPN 地址，然后用新的进程环境启动 AOD：

```powershell
$env:AOD_MOBILE_ENABLED = "1"
$env:AOD_BIND_HOST = "0.0.0.0"
$env:AOD_PUBLIC_URL = "http://192.168.x.x:4821"
npm start
```

将 `AOD_PUBLIC_URL` 替换为桌面端“手机连接”里显示的可访问地址；同一 Wi-Fi 下通常是 Windows 的局域网地址，远程网络可使用 Tailscale 或 VPN 地址。需要在 Windows 防火墙中允许对应端口。桌面端点击顶栏“手机连接”，先设置一个移动账号；Android App 输入 AOD 地址、用户名和密码登录。登录成功后会保存独立设备令牌，设备仍可在桌面端撤销。移动端与 Windows 必须同时在线，GitHub CLI 登录仍在桌面端完成。

### APK 获取与发布

APK 不应直接提交进 Git 仓库。给手机安装时优先使用 GitHub Releases 中上传的 `AOD-Mobile-*.apk`；如果 Release 暂时没有附件，可以按下面步骤自行构建：

```powershell
cd mobile
npm install
npm run android:apk
```

`android:apk` 使用 EAS preview 配置生成可侧载安装的 APK，首次运行通常会要求登录 Expo 并配置 Android 签名凭据。构建完成后，EAS 输出会给出 APK 下载地址。下载到本机后可作为 GitHub Release 附件上传：

```powershell
gh release create mobile-v0.2.3-preview .\AOD-Mobile-0.2.3-arm64-preview.apk --title "AOD Mobile v0.2.3 Preview" --notes "Experimental APK build. Use with caution."
```

如果要提交到应用商店，请改用：

```powershell
cd mobile
npm run android:aab
```

移动端开发命令：

```powershell
cd mobile
npm install
npm run typecheck
npm start
```

## 运行模式

- `manual`：准备、启动 Agent、验收和合并均由操作者触发。
- `hybrid`：依赖满足后自动准备 worktree，Agent 正常退出后自动验收；启动与合并由操作者确认。
- `auto`：自动准备、启动和验收；任务合并仍由操作者确认。

守护进程重启后，运行中任务会进入“恢复确认”，不会被错误标记为完成。

## 自适应工作台

桌面控制台以当前运行作为主视图。首屏阶段条按“需求、协作、门禁、交付”展示持久化状态，“下一动作”只突出当前最需要处理的一项操作。左侧导航提供两种显示方式：

- `总览`：连续显示四个主要区域，左侧导航滚动到对应区域。
- `专注`：只显示运行、群组、任务或交付中的当前区域。

右侧上下文坞在“讨论、任务详情、验收”之间切换。打开群组会话、选择任务或打开审查项不会覆盖主工作区；讨论和任务型上下文分别记住宽度，每个标签独立记住滚动位置。拖动分隔条可调整宽度，双击恢复默认宽度，键盘方向键可进行微调，收起后保留 52px 的重新打开轨道。

顶部搜索框可按运行、任务、群组、会话和 Agent 适配器的 ID、名称或状态定位；按 `Ctrl+K` 或 `/` 可聚焦搜索。SSE 事件会在 100ms 内合并刷新，刷新期间保留主区滚动、上下文滚动和正在编辑的群聊消息。异步操作的等待、成功或失败结果显示在对应按钮旁，失败信息会保留到下一次尝试。

## 运行与 DAG 规划

控制台中的“发起工作”统一提供群组讨论、智能规划和直接任务三条路径。智能规划会将自然语言需求交给 Codex 或 Claude Code 规划器，返回可编辑的任务 DAG 预览；确认后，AOD 会创建一个独立集成分支 `aod/run-<id>` 和集成 worktree。运行内任务只合入该分支，不会直接改动 `main`。

当所有运行任务完成后，运行进入 `ready_to_publish`。此时可推送集成分支并创建一个 GitHub PR。最终 PR 合并始终由操作者在 GitHub 确认。

## Agent 群组

“Agent 群组”用于保存一套可重复使用的成员、模型档案与职责配置。同一群组允许创建多个使用相同 Agent 适配器的独立席位，例如三个 Claude Code 会话；每个席位必须有唯一 key、显示名称、模型档案和职责。成员角色包括执行者、检查者、修复者和顾问；主持者从现有成员中单独指定，因此可以兼任执行角色。模型档案只允许使用 `.aod.config.json` 中为该适配器定义的选项。

每个群组会话固定运行三轮：独立提案、交叉质询和方案收敛。主持者随后生成包含文件所有权、依赖、验收命令及角色分工的任务 DAG。操作者可以在控制台编辑 DAG，确认后才会创建运行和 worktree。

确认后的角色流水线会自动执行以下步骤：

1. 执行者在独立任务 worktree 中修改并提交。
2. AOD 对当前 commit 运行验收。
3. 检查者在临时 detached worktree 中只做审查。
4. 检查不通过时，修复者回到原任务 worktree 修复并提交，最多两次。
5. 检查通过后任务停在 `merge_ready`，必须由操作者确认合并。

讨论可在轮次边界暂停，操作者消息会进入下一轮上下文。失败或守护进程重启后的成员回合会进入恢复确认，可重试、跳过或替换成员；主持者最终汇总回合不能跳过。群组归档不会删除历史会话。

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

每个适配器可以定义 `profiles`、`defaultProfile`、`profileDefaults` 和 `profileArgs`。群组编辑器按席位选择模型档案和推理强度；创建会话时会冻结模型名称、档案标签和强度。任务执行、角色检查、角色修复与群组讨论都会使用对应席位的冻结配置；旧群组或普通任务没有席位配置时继续使用适配器默认值。进程观测同时记录 `requested_model` 和 Agent 初始化事件报告的 `actual_model`，用于识别代理或供应商的模型映射。

`streamProtocol` 用于声明 CLI 输出协议：Codex 使用 `codex-jsonl`，Claude Code 使用 `claude-stream-json`，不支持结构化事件的适配器使用 `text`。AOD 将正文、工具调用、状态、告警和用量事件批量写入 SQLite，并通过 SSE 的 `agent_stream` 事件实时推送。刷新或断线后可通过 `GET /api/agent-stream?after=<global-id>` 分页恢复，也可用 `GET /api/processes/:id/stream?after=<sequence>` 查看单个进程。工具详情会脱敏并限制在 32KB；任务摘要日志按 100ms 或 8KB 批量写入，避免高频 token 回调拖慢 Agent。

运行指标分别显示“首事件”和“首正文”：前者表示 CLI 首次返回真实状态或工具事件，后者表示首段可读回复；编排器自己的进程启动事件不参与统计。示例配置使用临时 Codex 会话、标准输入和独立轻量规划器，并关闭讨论阶段无关的 Claude 会话与 MCP 加载，以降低首次响应时间。

示例的低延迟档位不会通过缩短超时或重启慢进程实现：Codex 任务使用 `medium`、讨论与规划使用 `low`、检查使用 `medium`；Claude 讨论使用 `sonnet + low`，检查使用 `sonnet + medium`。示例配置保留仓库级 `AGENTS.md/CLAUDE.md` 规则；若确认项目不依赖这些规则，本机极速配置可以额外使用 Codex `--ignore-rules` 和 Claude `--safe-mode`，换取更快启动。群组前三轮限制重复陈述并给出 900 字符回复预算，综合回合保留完整 JSON。实测中 Codex `resume` 会让第二轮输入 token 近乎翻倍，当前供应商的 `fast_mode` 也更慢，因此两者均不启用。

群组讨论在会话绑定项目的 Git 根目录运行，因此 Agent 可以读取真实代码上下文。讨论优先使用只读 `discussionArgs`，缺省时只回退到 `reviewArgs`，绝不会使用普通任务的可写 `args`。AOD 在每个回合前后比较 HEAD 和完整 porcelain 状态；检测到变化时冻结会话为 `recovery_required`，保留现场且不会自动 reset、checkout 或删除文件。检查者仍必须配置只读 `reviewArgs`，并在检查结束后验证 detached worktree 的提交和文件状态未变化。`defaults.groupTurnTimeoutMs` 控制单个讨论回合超时；检查和修复默认沿用 `defaults.reviewTimeoutMs`。群组讨论、任务执行、角色检查和冲突 Reviewer 共用全局并发槽位。

验收命令默认仅允许 `npm`、`node`、`pnpm`、`yarn`、`git`、`python` 和 `py` 前缀。可在 `security.allowedAcceptancePrefixes` 调整。常见令牌会从结构化日志和验收输出中脱敏。

Agent 体检除了版本和认证，还可以按 `health.capabilityArgs` 执行本地帮助命令，并用 `health.requiredOptions` 检查当前 CLI 是否支持配置中使用的参数；因此旧版 CLI 会在启动任务前显示兼容性错误，不会等到群组回合才失败。

## GitHub 交付

安装 GitHub CLI 后，在控制台点击 GitHub 状态启动设备授权。完成浏览器授权后，运行可发布到已存在的 `origin`。若没有远程仓库，调用发布接口时需提供 `owner/repo`，AOD 会通过 `gh repo create` 创建仓库、配置 `origin` 并推送。

GitHub CLI 默认路径会自动检测 Windows 标准安装位置。若使用自定义路径，可设置环境变量 `AOD_GH_PATH`。

## 运维

`POST /api/maintenance/backup` 创建 SQLite 快照，保留最近 7 份。`POST /api/maintenance/flush` 立即冲刷尚在内存中的 Agent 流和任务摘要；正常 `SIGINT`/`SIGTERM` 关闭也会自动冲刷。`POST /api/maintenance/cleanup` 只清理超过保留期且状态为已完成、已取消或失败的非锁定 worktree；冲突审查任务永不自动清理。

## 验证

```powershell
npm run check
npm test
```
