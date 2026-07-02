# PR #220 Goal Workflow 非测试代码审视

## 审视范围

- PR: https://gitcode.com/openharmony-robot/OpenDesk/pull/220/diffs
- PR head: `5abf265fbdb70c0e723607efc3c932928f19499c`
- Base: `origin/main b7f88ae36a78a71c5fa2d14c078b6dba79423159`
- 本文只审视非测试文件；`src/tests/**` 等测试文件未纳入逐行分析。
- 当前工作区里 `forge.config.cjs` 已被改回 `EnableEmbeddedAsarIntegrityValidation: true`，但 PR HEAD 中该值为 `false`。

## 主要问题

1. `src/renderer/components/taskartifacts.ts` 原先使用了 `t('goal.status.pending')`，但 `src/locale/en-us.ts` 和 `src/locale/zh-cn.ts` 没有这个 key。该 GUI 本地化缺失已修复为 renderer 专用 key `goal.renderer.continuation_pending`。

2. `src/main/aikernel/states/tasks.ts` 将 `submitUserMessage()` 改为返回 `{ status: 'ok' }` 或 `{ status: 'error'; messageKey }`。原先部分非 GUI 调用点仍忽略返回值，例如 TUI 的 `src/main/tui/components/taskview.ts`、headless、ACP、OpenCode 路由等，blocked goal 下普通输入可能被拒绝但没有反馈。该问题已修复：现有调用点均会处理错误返回。

3. `src/main/aikernel/goal/scheduler.ts` 在启动或恢复 goal 后返回 `GoalStates.renderSummary(goal)`，没有传入 `task.goal_event_log`。状态本身正确，但返回给 UI 的即时 summary 会缺少 recent events / objective events，可能导致 timeline 刷新不一致。

4. `src/renderer/components/slash-command.ts` 新增 `/goal` 描述时原先写死中文 `创建或管理跟进目标`，但 locale 已新增 `goal.description`。该用户可见文本本地化缺失已修复为 `t('goal.description')`。

5. `src/main/tui/message-utils.ts` 是新增非测试文件，但非测试代码没有引用。该无效维护面已删除。

6. PR HEAD 将 `forge.config.cjs` 的 `EnableEmbeddedAsarIntegrityValidation` 从 `true` 改为 `false`。这会降低 Electron 包完整性校验强度。除非有明确打包或 runtime 兼容原因，以及安全评审结论，否则不建议合入。

## 逐文件审视

### `forge.config.cjs`

- 将 `FuseV1Options.EnableEmbeddedAsarIntegrityValidation` 从 `true` 改为 `false`。
- 修改原因推测是规避 Electron 打包或 ASAR 完整性校验相关运行问题。
- 合理性不足。该 fuse 属于安全保护，关闭后会削弱应用包完整性校验。若必须关闭，应在 PR 或代码注释中说明触发场景、影响范围和安全接受理由。

### `jest.config.ts`

- `moduleNameMapper` 增加 `^@mariozechner/pi-tui$` 到测试 mock 的映射。
- 修改原因是 Jest 环境不应直接加载真实 TUI 包。
- 合理。这是测试基础设施配置，不影响业务运行路径。

### `packages/appsdk/src/index.ts`

- `eventSubscribers` 从 `Map<string, Set<any>>` 改成 `Map<string, Map<any, number>>`。
- `addSubscriber` 对同一 `senderFrame` 递增引用计数。
- `removeSubscriber` 递减引用计数，只在计数归零时删除对应 frame。
- `sendEventToSubscribers` 遍历 `subscribers.keys()` 发送事件。
- 修改原因是同一 renderer frame 可能多次订阅同一事件，不能因为一次 unsubscribe 就删除全部订阅。
- 合理，并且与 `preload.js` 中从 `removeAllListeners` 改为 `removeListener` 的修改配套。

### `src/common/goal-command.ts`

- 新增 `GOAL_SUBCOMMANDS`、`GoalSubcommand`、`ParsedGoalCommandResult` 等共享类型。
- `parseGoalCommandInput` 统一解析 `/goal help`、`pause`、`resume`、`clear` 和 objective。
- `validateGoalCommandResult` 统一禁止 `pause/resume/clear` 携带多余参数。
- `toGoalCommandErrorMessage` 将解析错误转换成 message key。
- `getGoalSubcommandCompletions` 提供首个 token 的补全。
- `isGoalTerminalStatus` 统一判断 `complete/cleared` 终态。
- 修改原因是 GUI/TUI/renderer 都需要一致的 `/goal` 行为。
- 合理。小限制是 `/goal resume <note>` 目前被共享 validator 禁止，虽然 service 层支持 resume note；这是产品行为取舍，不是实现错误。

### `src/main/aikernel/compaction/*`

- `session-memory-compact.ts` 删除未使用 import 和死代码。
- 原先 `types.ts`、`pipeline.ts`、`tool-results.ts` 中的 `activeContextOverride` 相关预留能力已经移除。
- 当前生产调用链没有外部传入 `activeContextOverride`，删除后不影响现有上下文准备、tool result budget、token 估算和 auto compact 逻辑。

### `src/main/aikernel/messages.ts`

- 新增 `RuntimeMetadata`，包括 `scope`、`origin`、`execution` 信息。
- `ToolCall`、`UserMessage`、`AssistantMessage` 接入 metadata。
- user/assistant render JSON 持久化 metadata。
- 修改原因是 goal 内部 turn、controller revision、generation、continuation 等需要被标记，后续才能隐藏内部消息、跳过过期工具调用、识别 runtime interrupt。
- 合理。`ToolCall.toRenderJSON()` 未暴露 metadata 也可接受，因为 stale tool call 判断在 main 进程侧完成。

### `src/main/aikernel/hooks.ts`

- before-finish hook 从普通函数扩展为带 `priority`、`phase`、`scope`、`order` 的注册对象。
- 兼容旧函数注册方式。
- task scope 和 global scope hook 被合并排序执行。
- 删除原先 task hook 后再 fallback 跑 global hook 的路径，避免 global hook 重复执行。
- 修改原因是 goal evaluator 需要在稳定阶段、稳定优先级执行。
- 合理，且兼容现有 hook API。

### `src/main/aikernel/todos/task-todos.ts`

- 新增 `resetInProgressTaskTodos(taskId, at)`。
- 将 `in_progress` todo 重置为 `pending`，更新 `updated_at`，删除 `started_at` 和 `completed_at`。
- 修改原因是 goal pause、clear、replace、interrupt 后，不能继续显示旧 todo 正在执行。
- 合理。该函数让运行中断后的 todo 状态与 task 状态一致。

## Goal 核心模块

### `src/main/aikernel/goal/state.ts`

- 定义 `GoalStatus`、edit history、scheduler lease、evaluation、continuation、supplement、event log、storage schema 等模型。
- 提供 `GoalStates.create`、`deserialize`、`serialize`、`renderSummary`。
- `GoalEvents.appendToTask` 将事件先存 inline，超过限制后追加到 artifact jsonl。
- 修改原因是 goal 需要独立于普通消息历史持久化，并支持跨重启恢复、timeline 展示和事件裁剪。
- 合理。状态归一化比较防御性，适合处理旧数据和异常数据。

### `src/main/aikernel/goal/controller.ts`

- 封装 create、edit objective、add supplement、consume supplement、pause、resume、clear、record evaluation 等状态机动作。
- GUI create/edit 时追加可见 `/goal ...` 用户消息，用于用户上下文和 timeline 锚点。
- resume、clear、replace 等操作会清理 lease、pending continuation、pending supplement。
- 历史回退、fork、异常恢复会将未完成 goal block 或 pause，避免继续基于不可靠历史执行。
- 修改原因是 goal 状态变化需要集中管理，避免 GUI/TUI/CLI 各自改状态。
- 合理。实现中对 revision 和 status 的检查比较完整。

### `src/main/aikernel/goal/service.ts`

- 编排 create、replace、edit、pause、resume、clear 与 running task 的交互。
- 运行中 create/edit 会注入 internal reminder，而不是直接启动 scheduler。
- replace/clear/pause 会通过 runtime interrupt 停止当前 turn，并重置 in-progress todos。
- resume 会先恢复 state，再启动 scheduler；启动失败时回滚到之前 paused/blocked 状态。
- 修改原因是 controller 只负责状态，service 负责跨 task runtime 的副作用。
- 合理。runtime interrupt 和 scheduler 启动之间的边界清楚。

### `src/main/aikernel/goal/scheduler.ts`

- 构造 goal start/resume 的 internal prompt。
- 使用 30 秒 lease 避免重复启动同一 goal。
- 检查 task running、pending interrupt、goal revision/status 后再启动 internal turn。
- 启动后消费 pending continuation。
- 修改原因是 goal 需要自动发起模型继续执行，但必须避免重复启动和 stale revision。
- 基本合理。需要修正返回 summary 时未带 `task.goal_event_log` 的问题。

### `src/main/aikernel/goal/evaluator.ts`

- 构造只读 evaluator prompt，包含最近消息、todo、文件变化和 goal 状态。
- 使用 JSON schema 约束模型返回 `met`、`not_met`、`blocked`。
- 返回结果会被 controller 按当前 goal id/revision 校验后应用。
- 修改原因是每轮结束后需要判断目标是否完成、阻塞或继续。
- 合理。风险主要来自 LLM 判断本身，但代码层有 schema 和 revision 保护。

### `src/main/aikernel/goal/hooks.ts`

- 注册 before-finish-turn hook，优先级为 300，phase 为 `goal_evaluation`。
- 跳过 subtask、internal task、runtime interrupted task、无 active goal 的 task。
- 若仍有未完成 todo，则拒绝 finish 并注入内部提醒。
- 否则运行 evaluator，并根据结果 complete、block 或 continuation。
- 修改原因是 goal 要在每轮自然结束前决定是否继续。
- 合理。它依赖 `hooks.ts` 的 priority 改造，二者匹配。

### `src/main/aikernel/goal/prompt-data.ts`

- 将 goal prompt 数据 JSON 中的 `<`、`>`、`&` 转义。
- 修改原因是用户控制内容可能进入 `<system-reminder>`，需要避免被解释为标签或指令边界。
- 合理，是必要的 prompt 注入防护。

## TaskState 和运行时集成

### `src/main/aikernel/states/tasks.ts`

- 新增 `goal_state`、`goal_event_log`、`runtimeInterrupt`、active turn metadata、pending goal reminders、pending supplements 等字段。
- load/toJSON/toRenderJSON 接入 goal 状态和事件。
- `appendInternalUserMessage` 支持 metadata 和 rawText。
- `startInternalTurn` 为 goal scheduler 创建内部 user message 和 assistant message，并启动新 generation 的 turn。
- `materializePendingGoalEditReminders` 将运行中 create/edit goal 转成内部 reminder。
- `materializePendingGoalSupplements` 将用户补充内容转成内部 reminder。
- undo/redo/fork 会调用 goal controller block 未完成 goal。
- `submitUserMessage` 增加 paused/blocked/active running goal 的特殊处理。
- `interruptRunningTurn` 停止工具、权限请求和当前 turn，并标记 interrupted tool call。
- stale goal revision 的 tool call 会被标记 skipped，避免旧 revision 继续落地副作用。
- 修改原因是 goal 工作流需要控制普通 task turn 的生命周期，并与消息历史、工具调用、UI 订阅保持一致。
- 整体合理。原先所有调用方都必须处理 `submitUserMessage` 错误返回的缺口已修复。

## Main / CLI / TUI

### `src/main/main.ts`

- 新增 goal IPC：get status、create、edit、add supplement、pause、resume、clear。
- `submitMessage` 处理 `submitUserMessage` 错误返回并本地化。
- `stopTask` 在 active goal 下拒绝 stop，提示使用 pause。
- remove task / clear all tasks 后发布空 todo 状态。
- 启动时注册 goal hooks。
- 修改原因是 GUI 需要完整 goal 管理能力，并且 active goal 下 stop/submit 语义不同。
- 合理。GUI 主路径处理比较完整。

### `src/main/cli.ts`

- CLI/headless/TUI 启动时注册 goal hooks。
- 修改原因是 goal evaluator 不只服务 GUI，也要在 CLI/TUI/headless 中生效。
- 合理，且 hook 注册函数幂等。

### `src/main/tui/commands/goal.ts`

- 新增 TUI `/goal` 命令。
- 支持 help、pause、resume、clear、objective 创建/编辑。
- 无 active task 时 objective 会创建新 task。
- 已存在未终态 goal 时创建 objective 会弹确认，用 edit 替代直接覆盖。
- 修改原因是 TUI 需要与 GUI 近似的 goal 操作入口。
- 合理。

### `src/main/tui/commands/index.ts`

- 注册 goal command。
- 修改原因是让 `/goal` 进入 TUI 命令系统。
- 合理。

### `src/main/tui/commands/undo.ts` / `redo.ts`

- 改用 TaskState 封装的 rewind/redo 方法。
- 修改原因是历史修改时需要统一触发 goal block 和持久化。
- 合理。

### `src/main/tui/commands/stop.ts`

- active goal 下不直接 stop，而提示使用 pause 或 clear。
- 修改原因是 stop 会破坏 goal 状态机，应通过 pause/clear 表达用户意图。
- 合理，并与 GUI stop 行为一致。

### `src/main/tui/components/goalpanel.ts`

- 新增 TUI goal 面板，展示状态、objective、evaluation、token、timeline 等摘要。
- 修改原因是 TUI 需要可见的 goal 状态反馈。
- 合理。注意它引入了若干图标字符，这是 TUI 表示层选择，不是本地化问题。

### `src/main/tui/components/input.ts`

- running task 默认输入 queue；active goal running 时切换成 supplement 模式。
- supplement 成功后显示 queued hint 并清空输入。
- goal clear stopping 时拒绝继续输入。
- 修改原因是 active goal 运行中，用户文本应作为目标补充，而不是普通排队消息。
- 合理。

### `src/main/tui/entry.ts`

- 接入 GoalPanel。
- 支持 active goal running 下直接提交 supplement。
- 定时刷新 goal elapsed/token 状态。
- goal terminal 后清理 queued messages。
- 修改原因是 TUI 主循环需要理解 goal 状态并更新 UI。
- 合理。普通 `submitUserMessage` 错误返回处理已补齐。

### `src/main/tui/message-utils.ts`

- 该文件原先新增了获取最后一个非 internal user message 的工具函数。
- 非测试代码没有引用该工具函数。
- 已删除该源文件及其孤立测试，避免保留无效维护面。

## Renderer

### `src/renderer/preload.js`

- 新增 goal IPC 暴露。
- `subscribeEvent` 的 unsubscribe 从 `removeAllListeners(channel)` 改为 `removeListener(channel, listener)`。
- 修改原因是单个订阅释放时不能清掉同 channel 的其他订阅。
- 合理，并且与 app SDK 的引用计数修改配套。

### `src/renderer/components/agentinput.js`

- 新增 `runningInputMode`，区分 queue 和 goal supplement。
- 新增 goal toolbar button。
- slash command 支持参数解析。
- `/goal` autocomplete 支持 `acceptsArgs`，选中后保留输入空间而不是立即执行。
- homepage 场景通过 `hide-goal` 隐藏 goal 按钮。
- 修改原因是 GUI 输入框需要直接承载 goal 创建和运行中补充输入。
- 合理。

### `src/renderer/components/homepage.js`

- 首页 agent input 增加 `hide-goal`。
- 修改原因是 goal 操作需要绑定具体 task，首页不应展示 goal 按钮。
- 合理。

### `src/renderer/components/sidebar.js`

- 任务列表增加 goal terminal tag。
- 修改原因是 complete/blocked 等 goal 状态需要在侧边栏快速可见。
- 合理。

### `src/renderer/components/slash-command.ts`

- 新增 `/goal` slash command，复用共享 parser。
- 支持 objective 创建 task、创建 goal、编辑已有 goal，以及 pause/resume/clear。
- 修改原因是 GUI 需要命令式 goal 入口。
- 基本合理。`/goal` description 写死中文的问题已修复为 `t('goal.description')`。

### `src/renderer/components/taskartifacts-goal-state.ts`

- 抽出 goal 状态判断、suggestion 显示判断、action id 计算等纯函数。
- 修改原因是 `taskartifacts.ts` 过大，状态逻辑需要可测试、可复用。
- 合理。

### `src/renderer/components/taskview-goal-input.js`

- 抽出 active goal running、text-only supplement、状态结果 unwrap 等纯函数。
- 修改原因是 `taskview.js` 中输入分流逻辑较复杂，适合拆成独立 helper。
- 合理。

### `src/renderer/components/taskview.js`

- 隐藏 internal user messages，避免 goal 内部 prompt 出现在聊天历史中。
- active goal running 时，普通文本输入变为 supplement。
- stop button 在 active goal 下转为 pause。
- 接收 goal-state-changed、goal-message-anchor、open-goal-creation 等事件。
- task-list-updated 时同步当前 goal 状态。
- 修改原因是 GUI task view 需要完整承载 goal 执行态。
- 合理。

### `src/renderer/components/taskartifacts.ts`

- 新增 goal tab、goal creation/edit form、suggestion、timeline、状态卡片和 action buttons。
- goal 操作调用 taskManager IPC，并通过事件通知 taskview/sidebar 更新。
- 修改原因是 artifacts 区域需要承载 goal 的可视化管理界面。
- 基本合理。`goal.status.pending` 缺失 locale key 的问题已修复为 `goal.renderer.continuation_pending`。

### `src/renderer/locale.ts`

- 在读取 `navigator` 前增加存在性判断。
- 修改原因是部分测试或非浏览器环境没有 `navigator`。
- 合理。

## Locale

### `src/locale/en-us.ts` / `src/locale/zh-cn.ts`

- 新增大量 `goal.*` 文案，覆盖 CLI/TUI/GUI 的创建、编辑、暂停、恢复、清理、状态、错误、timeline 等文本。
- 修改原因是 goal 是用户可见功能，必须本地化。
- 大部分合理。
- 已修复：原 `goal.status.pending` 使用点改为 `goal.renderer.continuation_pending`，并已补齐中英文文案。
- 已修复：`slash-command.ts` 新增描述已使用已有 `goal.description`。
- 内部给模型看的 `<system-reminder>`、evaluator prompt、controller prompt 不属于 GUI/TUI/CLI 用户文案，可以不走 locale；这是合理边界。

## Export

### `src/main/utils/export.ts`

- 导出 HTML 顶部增加 goal summary。
- 使用 `t()` 输出标题、状态、版本、目标。
- 对 HTML 内容做 escape。
- 修改原因是导出的任务记录需要包含 goal 上下文。
- 合理。这里不必输出完整 event timeline，摘要足够。

## 结论

PR 的主线设计合理：它为 OpenDesk 增加了跨 GUI、TUI、CLI 的 goal 执行状态机，并处理了运行中中断、历史回退、fork、过期工具调用、补充输入、事件持久化和本地化等关键边界。

合入前建议至少完成以下修正：

1. 已完成：补齐 GUI continuation pending 文案，替换原 `goal.status.pending` 使用点。
2. 已完成：TUI/headless/ACP/OpenCode 以及内部任务调用点均处理 `submitUserMessage()` 错误返回。
3. `GoalScheduler.startExecution` 返回 summary 时传入 `task.goal_event_log`。
4. `/goal` slash command 描述改为 locale。
5. 已完成：删除未被非测试代码引用的 `src/main/tui/message-utils.ts`。
6. 明确 `EnableEmbeddedAsarIntegrityValidation` 是否真的需要关闭；如需关闭，应补充安全和兼容性说明。

## 验证状态

- 本次只整理审视文档，没有修改业务代码。
- 未运行 `npm run build-cli`、`npm run build`、`npm test`。
- 若该 PR 继续推进，仍应按项目要求在 `rlocal` 上执行构建验证。
