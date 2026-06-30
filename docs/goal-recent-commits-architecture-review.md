# 最近六个 Goal 相关提交的逻辑与架构审视

> 审视范围：`7f3d4998` 到 `73fa211c`，即当前 `main` 最近六个 commit。本文以当前工作区源码为准，结合 commit 变更范围、现有规格文档和测试覆盖进行分析。

## 1. 结论摘要

这六个 commit 的主体目标，是把 Goal 从一份设计规格推进为 task 之上的可运行控制层：用户可以在 TUI 或 GUI 中创建目标，系统通过 scheduler 启动内部执行轮次，在 turn 结束前由 evaluator 判断是否完成、阻塞或需要继续，并将状态、事件和 timeline 暴露给 TUI/GUI。

整体架构方向是合理的：Goal 没有侵入 `task_status`，而是作为 `TaskState` 上的独立控制状态存在；状态转换集中在 `GoalController`，运行编排集中在 `GoalService` 和 `GoalScheduler`，前端入口通过共享 service 进入，避免 renderer 直接改 `task.goal_state`。后续修复 commit 主要是在收敛边界条件：token 计量、GUI timeline 和终态显示、TUI 输入队列隔离、运行中替换 goal 的中断握手。

主要风险不在功能缺失，而在几个边界仍然偏保守或尚未完全解耦：

- `GoalController` 名义上是状态层，但仍直接调用 `persistLater()` 和发布 task list update，不是严格意义的纯 reducer。
- `buildGoalContextProjection()` 当前保留完整 transcript，测试也确认这一点；这降低了上下文丢失风险，但没有实现强隔离。
- event log 已有 inline tail 和 artifact 写入，但运行期渲染主要依赖内存 tail；artifact 的完整回读、修复和历史迁移仍是延后项。
- evaluator 的完成判定依赖 LLM 结构化输出，最低证据阈值和低置信度策略尚未在代码层制度化。

## 2. 六个 commit 的演进脉络

| Commit     | 主题                                               | 主体变更                                                                                                                                                                                                               | 架构意义                                                                               |
| ---------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `7f3d4998` | `wip`                                              | 首次加入 Goal 设计文档、`src/main/aikernel/goal/` 模块、TaskState goal 字段、runtime metadata、TUI `/goal`、GUI/preload/IPC 初始入口、压缩投影 metadata 和基础测试。                                                   | 建立 Goal 作为 task 上控制面状态的第一版骨架。                                         |
| `1ca75c8a` | `feat: add goal execution workflow`                | 大幅收敛规格和实现：迁移 goal 规范入口，扩展 state/controller/service/scheduler，加入 TUI GoalPanel、GUI goal section、renderer task artifacts、node projection 测试和更多单测。                                       | 从原型转为可执行工作流，形成 state -> scheduler -> internal turn -> evaluator 的闭环。 |
| `706da1ad` | `fix: preserve goal usage and recall last message` | 引入 goal token baseline，完成态继续显示本 goal token 使用；TUI 上一条用户消息回忆跳过 scheduler 内部消息；补充 message-utils 测试。                                                                                   | 解决多 goal 共用同一 task transcript 时预算污染，以及内部消息影响人工输入体验的问题。  |
| `bdcd0bd9` | `fix: improve goal gui state handling`             | 强化 GUI 状态刷新、timeline、event summary、inline edit、task name 派生、Todo 清理和 goal 状态导出；扩展 controller/state/task-todos 测试。                                                                            | 把 GUI 从临时展示推进到可信控制面，并避免旧 goal 事件或旧 Todo 泄漏到新 goal。         |
| `53b3ab5e` | `fix: isolate goal tui input queue`                | TUI active goal 运行时拒绝普通队列消息；GoalPanel 状态和本地化补足；evaluator 输出语言指令本地化；新增 goalpanel/input-statusbar 测试。                                                                                | 收紧 TUI 交互边界，避免用户普通输入被误排队到 goal runner 后面。                       |
| `73fa211c` | `fix: replace active goals across interfaces`      | TUI 新建 goal 时若已有未终结 goal，先确认再 `GoalService.replace()`；replace 会 clear、reset todos、interrupt runner、等待 runtime interrupt settle，再创建新 goal；GUI create 明确要求先 clear；新增 TUI entry 测试。 | 统一“替换旧 goal”这一危险操作的服务层语义，同时保留 TUI 和 GUI 的产品差异。            |

从演进看，最早两个 commit 建立主体功能，后四个 commit 都是在补足真实使用中的一致性问题：预算基线、UI 运行期刷新、输入隔离、运行中替换。这个演进顺序符合一个控制面功能从规格到落地的正常路径。

## 3. 当前主体逻辑

### 3.1 数据与持久化

Goal 状态挂在 `TaskState` 上：

- `goal_state?: GoalState` 保存当前物化状态。
- `goal_event_log?: GoalEventLogStorage` 保存审计事件，支持 inline 和 artifact tail。
- `runtimeInterrupt?: TaskRuntimeInterrupt` 表示 goal pause/clear 等运行时中断请求。

`GoalState` 的核心字段包括 `status`、`revision`、`attempts`、`tokenUsageBaseline`、`pendingContinuation`、`lastEvaluation`、`schedulerLease` 和编辑历史。状态集合是：

```ts
active | paused | blocked | complete | cleared;
```

这个建模的优点是 task runner 状态和用户目标状态保持正交：`task_status` 仍表达当前 runner 是否 running/stopped，Goal 表达用户级完成标准和自动续跑控制。这样可以避免把 task 状态机膨胀成大量组合状态。

### 3.2 状态转换层

`GoalController` 负责主要状态转换：

- `create()` 校验 objective、拒绝未终结 goal 重复创建、记录 token baseline、派生未命名 task name、写 `created` event。
- `editObjective()` 递增 revision，清空旧 evaluation/continuation/lease，记录 objective 变更。
- `pause()` / `resumeStateOnly()` / `clear()` 维护状态字段和事件。
- `recordEvaluation()` 根据 evaluator 结果进入 `complete`、`blocked` 或创建 continuation。
- `normalizeLoadedTask()`、`prepareForkedGoal()`、`blockForHistoryMutation()` 处理重启、fork、undo/redo 等历史变更边界。

这个层次把状态语义集中起来是合理的。但它当前不是纯状态 reducer：它会 append event、`persistLater()`、发布 task list update。考虑到 `TaskState` 本身是可变对象，这个选择降低了改造成本；代价是未来如果要做独立状态机测试、事务回滚或批量迁移，仍需要再拆出 reducer/repository 边界。

### 3.3 服务编排层

`GoalService` 将 controller 与 runner/scheduler/Todo 串起来：

- `create()` 先检查 runtime interrupt 和 running 状态，再 controller create，清空 task-local TodoWrite，启动 scheduler。
- `replace()` 先校验新 objective，清除旧 goal，重置 in-progress todo；若旧 runner 正在运行，调用 `interruptRunningTurn()` 并等待 `waitForRuntimeInterruptSettled()`，之后再创建新 goal 并启动 scheduler。
- `edit()` 对运行中 active goal 不硬停工具，而是注入 edit reminder；非运行中则启动 scheduler 继续推进。
- `pause()` / `clear()` 会在 task running 时发 runtime interrupt，并停止运行中工具、取消权限弹窗。
- `resume()` 等待 pending interrupt 稳定，拒绝仍在 running 的 task，恢复状态后启动 scheduler。

这层的存在很关键，因为 UI、IPC handler 或 TUI command 不需要知道 runner 停止、Todo 清理和 scheduler lease 的细节。最近的 `replace()` 修复尤其重要：它避免了“旧 turn 还没真正消费 pause/clear interrupt，新 goal 就启动”的竞态。

一个值得继续观察的取舍是：`replace()` 会先 clear 旧 goal，再等待旧 runner 停稳并尝试创建新 goal。如果后续创建或调度失败，用户会看到旧 goal 已清除但新 goal 未启动。当前实现用 objective 预校验和 interrupt settle 降低失败概率，但 UI 层仍应保持失败提示和恢复路径。

### 3.4 调度与执行循环

`GoalScheduler.startExecution()` 做三件事：

1. 校验 goal active、task 未 running、runtime interrupt 已处理。
2. 获取 30 秒 `schedulerLease`，防止重复调度。
3. 构造 internal user message，并调用 `task.startInternalTurn()`，给消息和工具调用附上 goal metadata。

`TaskState` 侧做了必要配合：

- `startInternalTurn()` 以 internal user message 启动 runner，并设置 `metadata.scope = 'goal'`。
- `processCompletion()` 在 goal turn 且 goal active 时，将 `buildGoalContextProjection()` 的结果作为 active context override。
- 工具调用执行前通过 goal id/revision 检查 stale tool call，过期时直接标记 skipped。
- turn 收尾时如果 runtime interrupt 来自 goal pause/clear，则跳过常规 finish hooks，避免被 evaluator 重新续跑。

这个设计把“goal 控制的一轮执行”映射到现有 task runner，而不是另起一套 runner。这是合理的：复用现有工具、权限、订阅、上下文压缩和持久化路径，风险比新建平行执行框架低。

### 3.5 Evaluator 与续跑

`registerGoalHooks()` 在 `beforeFinishTurn` 注册 goal evaluation hook。当前逻辑是：

- 子任务、internal task、runtime interrupted turn 不评估。
- 没有 active goal 或 goal 已终结不评估。
- TodoWrite 中仍有未完成 todo 时不评估。
- 调用 `GoalEvaluator.evaluate()`，要求 LLM 返回结构化 JSON。
- `met` -> complete；`blocked` -> blocked；`not_met` -> 创建 continuation 并 reject 当前 turn，让 runner 追加内部 continuation prompt 继续执行。
- 连续 hook reject 达到安全上限时，block active goal。

这是一个务实的闭环：agent 先用 Todo 表达工作分解，完成后 evaluator 决定是否满足用户目标。风险在于 evaluator 的“完成”阈值仍完全依赖提示词和模型输出，代码只校验 schema，不校验证据质量。对高价值目标，后续可以考虑增加更明确的 evidence policy，或将 “met” 后的完成报告暴露给用户确认。

### 3.6 TUI/GUI 控制面

TUI `/goal` 当前语义更偏 power user：

- `/goal <objective>` 直接创建并启动。
- 已有未终结 goal 时会弹确认；确认后走 `GoalService.replace()`。
- `/goal pause|resume|clear` 都走共享 service。
- `/goal edit` 不作为命令，`edit ...` 会被当作新 objective，仍需替换确认。
- active goal 运行时，普通输入队列被隔离，避免用户 follow-up 被排到 goal runner 后面。

GUI 当前语义更保守：

- 通过显式 Goal 按钮打开右侧栏「目标执行」tab。
- 创建、编辑、pause、resume、clear 走 IPC -> `GoalService`。
- 已有未清除 goal 时，create 返回 `goal.create.requires_clear`，要求用户先 clear，不提供替换。
- `getGoalStatus()` 和 full task load 都返回带安全 event summary 的 `GoalRenderSummary`，timeline 优先展示 objective/budget 事件。

TUI 允许确认替换，GUI 要求 clear-first，这个差异是合理的产品取舍：TUI 命令行用户能接受一次确认后的 destructive replace；GUI 侧保持更可预期的显式清除流程。关键是二者都没有绕过服务层。

## 4. 架构合理性分析

### 4.1 合理之处

1. Goal 没有扩展 `task_status`，避免 task 状态机爆炸。Goal 的生命周期和 runner 生命周期解耦，适合表达“目标暂停但 task 可对话”“goal active 但 runner 暂时 stopped”等组合状态。

2. 共享入口足够集中。TUI、GUI 和 IPC 基本都走 `GoalService` / `GoalController`，renderer 只展示 summary 和发起 API 调用，没有直接写 `task.goal_state`。

3. 事件日志和 render summary 的边界清晰。完整 event payload 可以保存在 task/event log 中，GUI/TUI 只拿安全摘要，避免 evaluator 原始证据、artifact path 等内部字段泄漏。

4. scheduler lease、runtime metadata 和 stale revision 检查组成了必要的并发保护。尤其是运行中 edit 后旧工具调用会被 revision guard 拦截，这比只更新 objective 更可靠。

5. token budget baseline 的引入解决了同一 task 多个 goal 串行执行时的预算污染。完成态继续保留本 goal 用量，同时新 goal 从新的 baseline 开始计量，符合用户直觉。

6. runtime interrupt settle 的事件式等待优于固定超时。`73fa211c` 把 replace 的等待从“猜时间”转为等待 task 消费 interrupt，避免慢工具或慢 turn 造成新旧 goal 交叠。

7. 测试覆盖与风险点匹配。当前测试覆盖了 create/resume/pause/clear、token baseline、event summary sanitization、timeline 过滤、fork block、TUI replace race、输入队列隔离、GUI slash command 禁用等关键边界。

### 4.2 需要继续收敛的点

1. Controller 与持久化耦合仍偏重。当前 controller 每次状态变化直接 persist/publish，短期可接受；长期如果要支持事务式 replace、批量迁移、回放 event log 或更精细的错误恢复，应考虑拆出无副作用 reducer。

2. Goal context projection 目前是保守全量投影。`src/main/aikernel/goal/projection.ts` 只是复制完整 `ChatContext`，相关测试也要求保留 full transcript 和其他 goal history。这避免遗漏上下文，但不提供真正的 goal-only 隔离。

3. evaluator 的完成标准还缺制度化边界。代码可以验证 JSON schema，但无法判断 evidence 是否充分。当前适合“自动推进直到模型认为完成”的工作流；如果 Goal 被用于更高风险任务，应增加用户确认、证据最小要求或二次审查机制。

4. artifact event log 的读取能力仍未闭环。超过 inline limit 后会写 JSONL artifact，但状态/导出主要依赖 tail。对于长期目标，timeline 只展示 tail 是合理默认，但“审计完整性”还不能只靠当前 UI。

5. replace 语义仍有失败后的中间态风险。服务层先 clear 旧 goal，再启动新 goal；如果创建或调度失败，旧 goal 已终结。当前 TUI 有确认，GUI 不支持 replace，风险已降低，但后续可以考虑把 replace 做成更接近事务的状态机，或至少在失败时记录更明确的 `blocked`/`replace_failed` 事件。

6. 资源限制配置已经从当前用户功能中移除。`tokenUsageBaseline` 仍用于展示当前 goal 生命周期内的 token 增量，但不再作为自动停止条件。

7. GUI 运行期交互还有工程债。Goal panel 已能展示和操作，但仍使用 alert 做错误反馈，且完整预算编辑器/time budget 输入延后。对当前目标足够，但不应视为最终 UX。

## 5. 与现有文档的一致性

基本一致的部分：

- `docs/specifications/goal/README.md` 对 Goal 定位、状态、TUI/GUI 入口、create/edit/pause/resume/clear 的描述与当前代码大体一致。
- `docs/goal-gui-design.md` 对 GUI 明确按钮入口、右侧栏集成、timeline 数据来源和 clear-first 创建策略的描述与当前实现一致。
- `docs/specifications/goal_implementation_notes.md` 对 GUI 控件最小化、event artifact 侧重写入、evaluator 证据阈值和分叉语义歧义的记录是必要的。

需要修正或澄清的部分：

- `goal_implementation_notes.md` 应明确当前 `buildGoalContextProjection()` 是保守完整投影，不应承诺已经过滤其他目标/插曲。
- `GoalController` 在文档中容易被理解为纯状态转换层，但当前仍包含持久化和发布副作用。文档可以用“状态语义集中层”而不是“纯状态层”来描述。

## 6. 后续建议

1. 先修正文档与投影实现的事实不一致。短期建议改文档，因为当前测试明确要求全量投影；等需要更强隔离时再设计 goal-only projection。

2. 为 `GoalService.replace()` 增加失败路径的用户可恢复语义。例如调度失败时记录专门事件，或返回 summary 让 UI 明确显示“旧 goal 已清除，新 goal 未启动”的状态。

3. 将 evaluator 的证据策略写入规格，并补测试覆盖低置信度/空 evidence 的行为。即使仍交给 LLM 判断，也应明确 UI 和状态机如何解释 evidence。

4. 在 event artifact 读取闭环前，文档中应避免承诺完整 timeline 可回溯。可以明确当前 UI timeline 是当前 goal 的安全 tail 摘要。

5. 如果 Goal 后续继续扩大，应考虑把 `GoalController` 拆成 reducer + task adapter：reducer 只返回 next state/events，adapter 负责 persist/publish/Todo/scheduler。这会让 replace、load normalization、fork 等复杂路径更容易验证。

## 7. 总体评价

这六个 commit 的方向是稳健的：先建立 Goal 控制面，再通过连续修复把真实交互中最容易出错的边界补起来。当前架构已经具备可维护的核心分层：Goal state/controller 表达语义，service 负责运行编排，scheduler 复用 task runner，TUI/GUI 只通过共享入口操作。

它还不是最终形态，尤其是上下文投影、evaluator 证据阈值、event artifact 回读和 controller 副作用隔离仍有后续空间。但以当前代码规模和功能阶段看，这些取舍偏务实：优先保证不会误续跑、不会预算串账、不会把旧 goal timeline/Todo 混进新 goal，并通过测试锁定了关键行为。
