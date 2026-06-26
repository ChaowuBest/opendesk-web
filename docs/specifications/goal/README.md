# Goal 机制设计规范

> 当前状态：本文描述已经落地的 Goal 控制面和运行时语义。实现偏差、保守实现和延后事项记录在 [../goal_implementation_notes.md](../goal_implementation_notes.md)，GUI 细节记录在 [../../goal-gui-design.md](../../goal-gui-design.md)。旧的 `docs/specifications/goal_spec.md` 已迁移到本入口。

## 1. 定位

Goal 是 task 之上的控制状态，用来表达用户希望当前 task 持续推进并最终验收的目标。它不是普通聊天消息，也不是 Todo 的替代品。

核心约束：

- Goal 状态保存在 `task.goal_state`，不扩展 `task_status`。
- Task runner 状态仍然只表达 `waiting`、`running`、`stopped` 等运行状态。
- Todo 仍然表示 agent 的工作分解；Goal 表示用户级完成标准和自动续跑/验收控制。
- Compact summary、导出和 GUI 面板可以展示 goal 摘要，但 authoritative state 必须来自 `goal_state` 和 `goal_event_log`。
- TUI、GUI、IPC 和内部 scheduler 入口必须走 `GoalService` / `GoalController`，不得直接在 renderer 或 IPC handler 里改 `task.goal_state`。

## 2. 用户入口

### 2.1 TUI `/goal`

当前 TUI 命令：

```text
/goal
/goal help
/goal <objective> [--token-budget N] [--max-attempts N]
/goal pause
/goal resume [note]
/goal clear
```

行为规则：

| 输入                                 | 行为                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `/goal` 或 `/goal help`              | 只显示帮助，不创建 goal                                                      |
| `/goal status`                       | 兼容旧输入，显示帮助，不作为 status 命令                                     |
| `/goal <objective>`                  | 创建 active goal，并通过 scheduler 启动内部执行轮次                          |
| `/goal <objective> --token-budget N` | 创建 goal 并设置总 token 预算                                                |
| `/goal <objective> --max-attempts N` | 创建 goal 并设置最大续跑尝试次数                                             |
| `/goal pause`                        | 将未终结 goal 置为 paused；若 task 正在运行，会中断当前 runner 和运行中工具  |
| `/goal resume [note]`                | 恢复 paused / blocked goal；note 会记录到 resumed 事件并追加到 resume prompt |
| `/goal clear`                        | 将 goal 置为 cleared；若 task 正在运行，会中断当前 runner                    |

创建规则：

- objective 会 `trim()`，空 objective 显示帮助。
- 如果当前没有 active task，TUI 会先创建新 task，再创建 goal。
- 如果当前 task 已有未终结 goal，新建 goal 前会弹确认框；确认后先 clear 旧 goal，再创建新 goal。
- CLI/TUI 不提供 `/goal edit`。输入 `/goal edit something` 会被视为新 objective，并进入新建或替换流程。
- `--token-budget` 和 `--max-attempts` 只应用正整数值；flag 可以写在 objective 前后，支持 `--flag N` 和 `--flag=N`。
- `/goal pause` 不接受额外参数；补充信息应放在 `/goal resume [note]`。

补全规则：

- 裸 `/goal ` 不弹出子命令候选。
- 输入非空前缀时可补全 `help`、`pause`、`resume`、`clear`。
- `status` 和 `edit` 不在补全候选中。
- 输入 objective 后可补全 `--token-budget` 和 `--max-attempts`。
- 已经出现的 flag 不再重复提示。

### 2.2 GUI

GUI Goal 入口是显式按钮，不从普通 prompt、模型工具调用或 GUI slash command 隐式创建 goal。

流程：

```text
输入区 Goal 按钮
    -> 展开右侧栏并切换到「目标执行」tab
    -> 显示创建表单
    -> taskManager:createGoal
    -> GoalService.create
    -> GoalScheduler.startExecution
```

GUI 当前能力：

- 创建 goal，支持 objective、token budget、max attempts。
- inline 编辑 objective、token budget、max attempts。
- pause、resume、clear。
- budget_limited 状态下提供一次性授权和增加一次尝试的恢复入口。
- Goal 面板显示状态、revision、objective、budget、attempts、evaluation、pending continuation 和 timeline。
- Timeline 使用 `GoalRenderSummary.objectiveEvents`，没有 objective events 时 fallback 到 `recentEvents`。

GUI 不提供：

- `goal:requestConfirmation` / `confirmGoalCreation` 这类普通消息确认弹窗桥接。
- GUI slash command `/goal` 执行入口。
- time budget 输入控件。

## 3. 数据模型

### 3.1 TaskState 扩展

Task JSON 持久化字段：

| 字段                                      | 说明                                       |
| ----------------------------------------- | ------------------------------------------ |
| `goal_state?: GoalState`                  | 当前物化 goal 状态                         |
| `goal_event_log?: GoalEventLogStorage`    | 审计事件日志，支持 inline 和 artifact tail |
| `runtimeInterrupt?: TaskRuntimeInterrupt` | goal pause / clear 等运行时中断请求        |

Renderer 读取字段：

| 出口                         | Goal 数据                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| `TaskState.toRenderJSON()`   | `goal: GoalRenderSummary`，包含 cleared goal，供 full task load 使用 |
| `GoalController.getStatus()` | `GoalStatusView`，供 GUI 运行期刷新                                  |
| HTML export                  | `GoalStates.renderSummary()` 的摘要卡片                              |

`toRenderJSON()` 和 `getStatus()` 都必须携带 `goal_event_log` 生成的 event summary。只传 `goal_state` 会导致运行期刷新丢失 timeline。

### 3.2 GoalStatus

```ts
type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete' | 'cleared';
```

终结状态是 `complete` 和 `cleared`。未终结状态是 `active`、`paused`、`blocked`、`budget_limited`。

### 3.3 GoalState

关键字段：

| 字段                       | 说明                                    |
| -------------------------- | --------------------------------------- |
| `id`                       | Goal id                                 |
| `taskId`                   | 所属 task id                            |
| `objective`                | 当前目标描述                            |
| `successCriteria`          | 成功标准列表，当前入口通常为空          |
| `status`                   | 当前 GoalStatus                         |
| `revision`                 | 创建为 1，每次 edit 增加                |
| `attempts` / `maxAttempts` | 自动续跑计数和上限                      |
| `tokenBudget`              | `{ maxTotalTokens, usedTotalTokens }`   |
| `tokenUsageBaseline`       | goal 创建时 task 已累计 token 快照      |
| `timeBudgetMs`             | 数据模型支持，但当前 GUI/TUI 不提供输入 |
| `lastEvaluation`           | 最近一次 evaluator 结果                 |
| `pendingContinuation`      | 下次 resume 或 hook 续跑使用的 prompt   |
| `editHistory`              | objective 编辑历史                      |
| `oneShotBudgetOverride`    | 一次性预算授权                          |
| `schedulerLease`           | scheduler 防重入 lease                  |

Token 计量以 `tokenUsageBaseline` 为基线，只统计当前 goal 生命周期内新增的 assistant token。goal 完成后会重置 attempts、完成态耗时显示和 token budget used 值；这不影响 transcript 或 task 级历史 token。

### 3.4 GoalEvent

事件类型：

```ts
type GoalEventType =
    | 'created'
    | 'edited'
    | 'paused'
    | 'resumed'
    | 'evaluated'
    | 'continuation_created'
    | 'continuation_consumed'
    | 'blocked'
    | 'budget_limited'
    | 'completed'
    | 'forked'
    | 'cleared';
```

事件 source：

```ts
type GoalEventSource = 'tui' | 'chat' | 'gui' | 'api' | 'scheduler' | 'hook' | 'evaluator' | 'user_message' | 'system';
```

`GoalRenderSummary.recentEvents` 只暴露安全摘要；`objectiveEvents` 从 event log 中筛选 `created`、`edited` 或 payload 含 `objective` / `previousObjective` 的事件，供 GUI timeline 优先展示。

## 4. Controller 与 Service

`GoalController` 负责纯状态转换和事件记录；`GoalService` 负责把状态转换与 scheduler、runner interrupt 串起来。

### 4.1 create

`GoalService.create(task, input)`：

1. `GoalController.create()` 校验 objective。
2. 已存在未终结 goal 时返回 `goal_exists`。
3. 创建 active goal，设置 `tokenUsageBaseline`。
4. 如果 task 仍未命名或是 legacy fallback 名称，用 objective 派生 task name。
5. 记录 `created` 事件并持久化。
6. 调用 `GoalScheduler.startExecution(task, 'create')` 启动内部执行轮次。

TUI 的替换确认不在 `GoalController.create()` 内部做。TUI 确认后显式 clear 旧 goal，再调用 create。

### 4.2 edit

`GoalService.edit(task, objective, source, budgetUpdate)`：

- 是 GUI/API 共享入口，CLI/TUI 不提供 edit 命令。
- objective 或 budget 未变化时保持幂等。
- 发生变化时 revision 加 1，写入 `editHistory`，清空 `lastEvaluation`、`pendingContinuation`、`schedulerLease`。
- 支持设置或清除 `maxAttempts`、`tokenBudget`、`timeBudgetMs`。
- active goal 正在运行时，不强制停止外部工具，而是注入 goal edit reminder 和 revision metadata。
- active goal 不在运行时，会通过 scheduler 继续推进。

### 4.3 pause

`GoalService.pause(task, source, reason?)`：

- 要求存在未 cleared goal。
- 将 goal 置为 `paused`，记录可选 `pauseReason`。
- 清除 scheduler lease。
- task 正在运行时调用 `interruptRunningTurn({ reason: 'goal_pause', stopRunningTools: true, cancelPermissionPrompts: true })`。

### 4.4 resume

`GoalService.resume(task, options)`：

- 如果存在未处理 runtime interrupt，最多等待 2 秒让 runner 停稳。
- task 仍在 running 时拒绝恢复。
- 只允许从 `paused`、`blocked`、`budget_limited` 恢复。
- `budget_limited` 必须传入 `budgetOverride`。
- `budgetOverride.oneShot` 写入一次性授权；非 one-shot 可增加 max attempts、time budget 或 token budget。
- 成功后将 goal 置为 `active`，记录 `resumed` 事件，并启动 scheduler。

普通用户消息的恢复分类：

- `继续`、`恢复`、`重试`、`再试一次`、`retry`、`continue`、`resume` 会恢复 paused 或 blocked goal。
- paused goal 收到其他普通消息时，按普通对话处理，不自动续跑。
- blocked goal 收到无关普通消息时拒绝并显示本地化提示。

### 4.5 clear

`GoalService.clear(task, source)`：

- 没有 goal 时返回成功语义。
- 有 goal 时置为 `cleared`，清空 pending continuation 和 scheduler lease。
- task 正在运行时调用 `interruptRunningTurn({ reason: 'goal_clear', stopRunningTools: true, cancelPermissionPrompts: true })`。

## 5. Scheduler

`GoalScheduler.startExecution()` 只启动 active goal。

执行规则：

- task 已 running 时拒绝启动。
- 有未处理 runtime interrupt 时拒绝启动。
- 使用 30 秒 `schedulerLease` 防重入。
- 优先消费未 consumed 的 `pendingContinuation`。
- 没有 continuation 时，create 使用默认 start prompt，resume 使用默认 resume prompt。
- resume note 会追加到内部 prompt。
- 通过 `TaskState.startInternalTurn()` 写入 internal user message 和 assistant placeholder。
- turn metadata 标记为 `scope: 'goal'`，`execution.controller: 'goal'`，并携带 goal id、revision、continuation id。

内部 turn 的 source：

| lease reason          | internal source     |
| --------------------- | ------------------- |
| `create`              | `goal_create`       |
| consumed continuation | `goal_continuation` |
| `hook`                | `goal_hook`         |
| other resume          | `goal_resume`       |

## 6. Finish Hook 与 Evaluator

Goal hook 注册到 `HookRegistry.beforeFinishTurn()`：

- `priority: 300`
- `phase: 'goal_evaluation'`

短路顺序：

1. parent task 或 internal task 直接 finish。
2. goal pause / clear runtime interrupt 直接 finish，不再进入 evaluator。
3. 无 goal、cleared、complete 或非 active goal 直接 finish。
4. TodoWrite 仍有未完成 todo 时直接 finish，避免 goal evaluator 反复抢在 todo 前续跑。
5. 调用 `GoalEvaluator.evaluate()`。

Evaluator 输入包含：

- goal id、revision、objective、success criteria、attempts。
- task todo summary。
- 文件变更摘要。
- 最近 transcript 摘要。

Evaluator 输出：

| status           | 处理                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `met`            | goal 置为 `complete`，记录 `completed`，重置完成态计量展示             |
| `not_met`        | 创建 pending continuation；预算允许时 hook reject 并继续当前 task turn |
| `blocked`        | goal 置为 `blocked`，等待用户恢复或补充                                |
| `budget_limited` | goal 置为 `budget_limited`，必要时保留 continuation                    |

预算检查在续跑前后执行，顺序为 time budget、token budget、max attempts。mid-turn 预算边界也会在工具调用后、下一次 LLM 调用前检查。

Evaluator 异常会把 active goal 置为 `blocked`，并记录 `goal_evaluator_failed`。

## 7. Projection 与上下文边界

当前 `buildGoalContextProjection(task)` 是保守实现：复制完整 `ChatContext`，由 evaluator 在最近 transcript 摘要中截断。更细粒度的 goal/interlude/global 投影和按作用域 LLM 压缩摘要仍记录在实现说明的延后事项中。

已经落地的边界：

- goal scheduler 注入的 internal user message 带 goal metadata。
- goal 控制的 assistant message 和工具调用继承 goal execution metadata。
- active goal 编辑后会注入 revision reminder，避免继续按旧 objective 推进。
- compact boundary 的投影元数据和 summary segments 已记录，但旧非结构化摘要不会事后重写。

## 8. 持久化与恢复

保存：

- `TaskState.toJSON()` 序列化 `goal_state` 和 `goal_event_log`。
- 事件日志 inline 上限为 200 条；超过后追加写入 artifact JSONL，并在 task 中保留 tail。

加载：

- `GoalStates.deserialize()` 规范化旧数据和缺失字段。
- `GoalEvents.deserialize()` 支持旧数组、inline storage 和 artifact storage。
- `GoalController.normalizeLoadedTask()` 会清理 scheduler lease。
- 如果重启前 task 正在 running 且 goal active，加载后 goal 进入 `paused` 并生成 recovery continuation。
- 如果加载到 active goal 但 task 是 waiting，也会转为 paused 并把 task 置为 stopped。
- paused、blocked、budget_limited goal 加载到 waiting task 时，task 会置为 stopped。

fork：

- fork 后 goal 会克隆到新 task，换新 goal id，并以 fork 后 transcript token 总量作为新 baseline。
- 未终结 goal 会进入 `blocked`，原因是 `forked_history_requires_goal_review`。
- forked task 只保留源 task goal event tail 的最近 50 条，再追加 `forked` 事件。

history mutation：

- undo、redo、rewind 等历史变更会把未终结 goal 置为 blocked，原因是需要用户重新确认 goal 与历史状态的一致性。

## 9. 与现有功能的交互

### 9.1 Todo

Todo 是 agent 的计划；Goal 是用户级验收。Goal evaluator 只在 task 级 TodoWrite 都完成后运行。

### 9.2 Stop

active goal 下普通 stop 被拒绝：

- TUI `/stop` 提示使用 `/goal pause` 或 `/goal clear`。
- GUI `taskManager:stopTask` 在 active goal 下返回本地化错误。

暂停或清除 active goal 必须走 `GoalService.pause()` / `GoalService.clear()`，这样 runner interrupt、工具停止、权限弹窗取消和 goal 状态可以保持一致。

### 9.3 Export

HTML export 会在消息列表前渲染 goal summary，包含 status、revision 和 objective。动态 objective、reason 等内容只做 HTML escape，不翻译。

### 9.4 Subtask

Goal hook 跳过 parent_id 非空的 task 和 internal task。当前 goal 控制面不把子任务当作独立 goal runner。

### 9.5 Session memory 与 compact

Goal state 不以 session memory 或 compact summary 为状态源。summary 可以引用 goal 信息，但恢复、导出、fork 和 UI 必须读取结构化字段。

## 10. GUI 渲染摘要

`GoalRenderSummary` 是 renderer 和导出的安全读模型。

字段：

| 字段                        | 说明                                           |
| --------------------------- | ---------------------------------------------- |
| `id`                        | goal id                                        |
| `status`                    | GoalStatus                                     |
| `revision`                  | 当前 revision                                  |
| `objective`                 | 当前 objective                                 |
| `pendingContinuation`       | 是否有未消费 continuation                      |
| `updatedAt` / `completedAt` | 更新时间和完成时间                             |
| `successCriteria`           | 成功标准                                       |
| `attempts` / `maxAttempts`  | 尝试计数                                       |
| `tokenBudget`               | token budget，运行期会补实时 used 值           |
| `lastEvaluation`            | 最近 evaluation 的 status、reason、evaluatedAt |
| `recentEvents`              | 最近事件摘要                                   |
| `objectiveEvents`           | objective 变化相关事件摘要                     |

Renderer 规则：

- task full load 使用 `TaskState.toRenderJSON().goal`。
- 运行期刷新使用 `taskManager:getGoalStatus`。
- 两条路径都要保留 event summary。
- Goal tab 用户可见文案通过 locale key `renderer.taskartifacts.tab.goalExecution` 输出。

## 11. 本地化

用户可见文本必须接入 locale：

- TUI command description、help、错误、确认替换文案。
- GUI tab、按钮、状态徽章、tooltip、表单、空状态、错误。
- export 静态标签。

不需要本地化：

- event type、status enum、protocol 字段。
- 测试 fixture。
- 内部日志 code。
- 用户输入的 objective、模型生成的 reason、event payload 动态文本。

## 12. 关键文件

| 文件                                          | 职责                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `src/main/tui/commands/goal.ts`               | TUI `/goal` 命令、参数解析、补全、替换确认                                 |
| `src/main/aikernel/goal/state.ts`             | Goal 类型、序列化、event log、render summary                               |
| `src/main/aikernel/goal/controller.ts`        | 状态转换、预算、恢复分类、加载/fork/history mutation 处理                  |
| `src/main/aikernel/goal/service.ts`           | controller + scheduler + runtime interrupt 编排                            |
| `src/main/aikernel/goal/scheduler.ts`         | internal turn 启动、lease、continuation 消费                               |
| `src/main/aikernel/goal/hooks.ts`             | beforeFinishTurn goal evaluator hook                                       |
| `src/main/aikernel/goal/evaluator.ts`         | LLM structured evaluator                                                   |
| `src/main/aikernel/goal/projection.ts`        | 当前保守 projection                                                        |
| `src/main/aikernel/states/tasks.ts`           | TaskState 持久化、render JSON、internal turn、interrupt、history/fork 集成 |
| `src/main/main.ts`                            | GUI IPC handlers                                                           |
| `src/renderer/preload.js`                     | renderer taskManagerAPI goal 暴露                                          |
| `src/renderer/components/taskartifacts.ts`    | Goal 创建表单和 Goal panel 渲染                                            |
| `src/renderer/components/taskview.js`         | goal status 运行期刷新和 active goal stop 控制                             |
| `src/main/utils/export.ts`                    | HTML export goal summary                                                   |
| `src/locale/zh-cn.ts` / `src/locale/en-us.ts` | goal 用户可见文本                                                          |

## 13. 测试看护矩阵

| 场景                   | 重点                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `/goal` 空输入和 help  | 不创建 goal，只显示帮助                                     |
| `/goal <objective>`    | 创建 active goal、启动 scheduler、写 internal metadata      |
| budget flags           | objective 保留，预算字段应用，补全不重复 flag               |
| 替换 active goal       | 先确认；取消不清除；确认后 token baseline 重置              |
| 无 active task 创建    | TUI 先建 task，再建 goal 并 follow running task             |
| CLI 无 edit/status     | `status` 显示帮助；`edit ...` 按新 objective 替换处理       |
| pause/resume/clear     | 共享 GoalService 语义，pause 参数拒绝，resume note 记录事件 |
| active goal + stop     | 普通 stop 被拒绝，不调用 task.stop                          |
| renderer subscriptions | 卸载只取消当前 listener，不破坏其他实时刷新                 |
| TodoWrite 清理         | task view 清理时 artifacts 不残留上一任务 running todo      |
| GUI timeline           | full load 和 getGoalStatus 都保留 objectiveEvents           |
| task name 派生         | GUI/API 创建 goal 后未命名 task 使用 objective 派生名称     |
| completed usage reset  | complete 后 attempts/token used/完成态耗时显示归零          |

新增或修改 goal 行为时，应优先补充：

- `src/tests/ut/tui/commands/goal.test.ts`
- `src/tests/ut/aikernel/goal.test.ts`
- `src/tests/ut/node/goal-projection.test.ts`
