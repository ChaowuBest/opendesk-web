# Goal 机制设计规范评审

评审对象：

- `/Users/zhuxiaoran/work/OpenDesk/docs/specifications/goal/README.md`（由旧 `goal_spec.md` 迁移整理）
- `/Users/zhuxiaoran/WorkBuddy/2026-06-20-15-56-32/OpenDesk_new`

评审日期：2026-06-23

本评审最初基于旧 `goal_spec.md` 和指定源码生成。目标文档已迁移为 `goal/README.md`，原文件已删除。

> 注意：本文是历史评审记录。下文中的行号对应迁移前草案，用于保留当时的问题上下文，不再作为当前 `goal/README.md` 的精确行号。当前实现语义以 `goal/README.md` 和 `goal_implementation_notes.md` 为准。

## 总体结论

`goal/README.md`（由旧规格迁移）的核心方向是合理的：goal 被设计为 task 之上的控制状态，而不是普通聊天消息；goal 状态不复用 `task_status`；当前物化状态与审计日志分离；scheduler 不直接拼 runner 流程，而要求新增 `TaskState.startInternalTurn()`；finish hook 顺序要求 priority/phase；projection 也明确不能只在 adapter 层过滤。这些判断与当前 OpenDesk 架构基本一致。

当时草案还没有达到“可无歧义实现”的程度。主要剩余风险集中在阶段边界、runtime interrupt 的收尾语义、running edit 的 stale tool guard、projection 与 compact summary 的泄漏、budget 恢复语义、数据模型字段一致性、以及本地化和关键文件清单遗漏。建议先修订这些问题，再按 phase 实现。

## 主要优点

- **架构方向合理**：`GoalController` 只管状态机和持久化，`GoalService` 组合 scheduler/runtime interrupt，能避免 TUI/GUI 各自直接改 `task.goal_state`。
- **不污染 `task_status`**：规格明确 goal 状态放在 `task.goal_state.status`，避免把 runner 生命周期与业务目标状态混在一起。
- **正确识别 internal turn 抽象**：当前 `appendInternalUserMessage()` 只追加内部消息并通知订阅者，确实不能承担 resume/create 的 runner 启动语义。规格要求 `TaskState.startInternalTurn()` 是必要的。
- **正确识别 hook 顺序问题**：当前 `TaskHooks.checkBeforeFinishTurn()` 先执行 task-local hooks，再执行全局 HookRegistry；单靠 import/register 顺序不能保证 goal evaluator 晚于 todo/interruption guard。规格要求 priority/phase 是合理的。
- **测试矩阵覆盖面较广**：已覆盖数据模型、TUI、状态机、scheduler、runtime interrupt、finish hook、evaluator、projection、compact、rewind/fork/export、budget、GUI IPC、renderer。

## 高风险问题

### 1. Phase 1 与 Phase 3 的边界冲突

规格在 Phase 1 已要求：

- 新增 `GoalScheduler`。
- `/goal <objective>` 创建后通过 scheduler 启动 internal goal turn。
- `/goal resume` 可消费 continuation 或生成默认 prompt，并通过 `TaskState.startInternalTurn()` 启动。
- 同时 Phase 3 又命名为 “scheduler + resume”，继续要求 resume、lease、防并发 runner。

相关位置：

- `goal_spec.md:158`：create 使用 `create_and_start`。
- `goal_spec.md:197`：resume 允许从 paused/blocked/budget_limited 恢复。
- `goal_spec.md:1163`：Phase 1 包含 scheduler、resume、runtime interrupt。
- `goal_spec.md:1192`：Phase 3 又定义 scheduler + resume。

风险：

- 实现者无法判断 Phase 1 到底要做完整 scheduler，还是只做持久化骨架。
- 验收标准要求 Phase 1 验收 resume/stop/interrupt，但测试矩阵又把部分能力放到 Phase 3，容易出现阶段性实现无法验收。

建议：

- 将 Phase 1 明确定义为“可执行 MVP”：包含 create/start、pause、resume、clear、同进程 lease、防重复 internal turn。
- 或将 Phase 1 改为 create-only/status-only，并把 create/start、resume、lease、runtime interrupt 全部移到 Phase 3。
- 当前文档更像前者，应删除 Phase 3 的重复命名，改成“blocked 普通消息恢复 + lease 加固”。

### 2. `GoalService.edit()` 被使用但未进入 Service 接口

规格在 `/goal edit` 和 6.2 中要求 running active goal 的 edit 必须由 `GoalService.edit()` 完成：它既要更新 revision，又要向 runner 注入 internal reminder，还要避免启动第二个 runner。

但建议接口中：

- `GoalController` 有 `editObjective()`。
- `GoalService` 只有 `create/pause/resume/clear`，没有 `edit()`。

相关位置：

- `goal_spec.md:172`：active edit 的调度语义。
- `goal_spec.md:517`：`GoalService` 接口缺少 `edit`。
- `goal_spec.md:583`：正文又要求 `GoalService.edit()`。

风险：

- TUI 可能直接调用 `GoalController.editObjective()`，跳过 runner-safe reminder 注入和 stale tool guard。
- GUI 后续实现可能和 TUI 行为分叉。

建议：

在 `GoalService` 明确加入：

```ts
static edit(task: TaskState, objective: string, source?: GoalEvent['source']): Promise<GoalCommandResult>;
```

并规定 TUI/GUI/API edit 都必须走该入口。

### 3. Runtime interrupt 的 runner 收尾语义仍不完整

规格规定 pause/clear 通过 runtime interrupt 停止当前 runner，并且当前 turn 不进入 todo/interruption/goal evaluator。但当前源码中：

- `TaskState.stop()` 会立即设置 `task_status = 'stopped'`，取消 permission prompt，并把 pending/running tool call 标为错误。
- `processTaskTurn()` 在循环结束后仍会执行 `hooks.noticeAfterFinishTurn(this)`。
- 当前没有可区分 `goal_pause`、`goal_clear`、`user_stop` 的持久化或运行时 interrupt 字段。

源码证据：

- `src/main/aikernel/states/tasks.ts:1524`：`stop(reason = 'user')`。
- `src/main/aikernel/states/tasks.ts:1532`：取消 permission prompts。
- `src/main/aikernel/states/tasks.ts:1553`：标记 interrupted tool calls。
- `src/main/aikernel/states/tasks.ts:3226`：`processTaskTurn()` 主循环。
- `src/main/aikernel/states/tasks.ts:3304`：结束后执行 afterFinish hooks。

风险：

- 文档只说明跳过 beforeFinish guard/evaluator，没有说明 afterFinish hooks 是否运行。
- session memory、review、observer 类 after hooks 可能在 pause/clear 后仍运行，形成“用户以为已暂停，但系统继续做后处理”的行为。
- 如果直接复用 `task.stop()`，`stop_requested_by_user` 语义会把 goal pause 误判成普通用户 stop。

建议：

- 明确新增 `TaskRuntimeInterrupt` 的存储位置、生命周期和清理点。
- 明确 `goal_pause/goal_clear` 后是否运行 `afterFinishTurn`。若运行，after hook 必须能读取 interrupt reason 并决定跳过。
- `task.stop()` 保留底层原语，但 `/goal pause` 应走 `interruptRunningTurn()`，不能简单等同于 `task.stop('user')`。
- 验收标准补充：goal interrupt 后不得触发 session memory compact、task review、goal evaluator 或普通 completion observers，除非 hook 明确声明支持 interrupted turn。

### 4. Running edit 的 stale tool guard 设计复杂，但落点不够明确

规格要求 running active goal 上 `/goal edit` 不停止当前 turn，而是注入 reminder，并在工具调用前跳过旧 revision 生成的工具调用。

当前源码中：

- `ToolCall` 没有通用 `metadata` / `goalRevision` 字段，只有 `result_storage`、`microcompact` 等专用元数据。
- `processToolCalls()` 会扫描所有 assistant messages 的 pending tool call，先做权限检查，再并行执行工具。
- stale guard 如果放在 tool execution 前但权限检查后，旧 revision 工具仍可能弹 permission prompt。

源码证据：

- `src/main/aikernel/messages.ts:300`：`ToolCall` 当前字段。
- `src/main/aikernel/messages.ts:336`：`ToolCall.toJSON()` 持久化字段。
- `src/main/aikernel/states/tasks.ts:3151`：`processToolCalls()` 收集 pending calls。
- `src/main/aikernel/states/tasks.ts:3180`：先串行权限检查。
- `src/main/aikernel/states/tasks.ts:3199`：再并行执行工具。

风险：

- 如果用 task-local WeakMap 保存 revision，重启、render、redo、pending tool call 重新加载后会丢失信息。
- 如果 stale guard 只拦执行，不拦权限检查，会对旧目标产生用户可见权限请求。
- “skipped/error” 结果格式未定义，模型和 renderer 可能无法稳定理解。

建议：

- 给 `ToolCall` 增加持久化的 `metadata?: { goalId?: string; goalRevision?: number; source?: string }` 或等价字段。
- stale guard 必须在权限检查前执行。
- 定义 stale tool call 的标准结果对象，例如：

```json
{
    "skipped": true,
    "reason": "stale_goal_revision",
    "goalRevision": 2,
    "currentGoalRevision": 3
}
```

- 将 running edit 降级为后续 phase，或把它作为单独子规格实现；它的复杂度明显高于普通 edit。

### 5. `GoalSchedulerLease.reason` 缺少 create 场景

`/goal <objective>` 创建时要求通过 scheduler 启动，并且 scheduler 必须获取 lease。但 `GoalSchedulerLease.reason` 只有：

```ts
reason: 'resume' | 'continuation';
```

相关位置：

- `goal_spec.md:158`：create 后启动 scheduler。
- `goal_spec.md:729`：lease 类型。

风险：

- create/start 的 lease 无法合法表达。
- 日志、status、重复启动防护无法区分 create 与 resume/continuation。

建议：

将 reason 扩展为：

```ts
reason: 'create' | 'resume' | 'continuation' | 'hook';
```

并与 `startInternalTurn.source` 的枚举保持一致。

### 6. `budget_limited` 的恢复语义不闭合

规格允许 `budget_limited -> active`，方式是 `/goal resume`、提高预算或未来 GUI 授权。但当前命令集没有预算调整命令，`/goal resume` 也没有参数说明是否提高预算、重置预算、忽略一次预算，还是仅重试。

相关位置：

- `goal_spec.md:426`：budget_limited 状态机。
- `goal_spec.md:1131`：Budget。
- `goal_spec.md:1151`：触发顺序。

风险：

- 用户执行 `/goal resume` 后可能立即再次命中同一预算，形成循环。
- `maxAttempts`、`timeBudgetMs`、`tokenBudget` 的恢复策略不同，但规格没有拆开定义。
- token budget 在 evaluator 上要求计入，但当前 `LLM.askForObjectWithSchema()` 只返回 object，不返回 usage。

源码证据：

- `src/main/aikernel/llm.ts:480`：`askForObjectWithSchema()` 返回 object。
- `src/main/aikernel/states/tasks.ts:3277`：现有 hook reject count hard cap。

建议：

- MVP 暂不启用 token budget，并在 schema 中允许 `tokenBudget` 不出现。
- `/goal resume` 对 `budget_limited` 必须定义显式策略：拒绝并提示提高预算，或清空/增加预算，或允许一次 override。
- `maxAttempts` 与现有 10 次 hook reject safety cap 必须写清优先级和用户可见状态。

### 7. Projection 仍可能通过 compact/session memory summary 泄漏 interlude

规格要求 active goal 默认包含 `global + goal`，resume/evaluator 排除 `interlude`，并要求 compaction pipeline 使用统一 projection。这是正确方向，但仍缺少一个关键规则：compact boundary 和 session memory summary 本身属于 `global`，如果它们是在 paused/interlude 消息参与下生成的，后续 goal projection 仍会通过 summary 间接看到 interlude。

源码背景：

- `buildActiveContextView()` 当前基于最近 compact boundary 生成 active context。
- `CompactSeparatorMessage` 自带 metadata，但没有 goal/interlude scope 语义。
- session memory compact/full compact 都会基于 active context 摘要历史。

源码证据：

- `src/main/aikernel/compaction/context-view.ts:14`：`buildActiveContextView()`。
- `src/main/aikernel/messages.ts:1831`：`CompactSeparatorMessage.metadata`。
- `src/main/aikernel/compaction/session-memory-compact.ts:637`：session memory 使用 active context。
- `src/main/aikernel/compaction/full-compact.ts:826`：full compact 使用 active context。

风险：

- resume/evaluator 表面排除了 interlude，实际仍可能从 compact summary/session memory 中读到 interlude 内容。
- 验收标准“resume 默认不把 interlude 送入 goal continuation 上下文”无法仅通过过滤 raw messages 证明。

建议：

- compact boundary metadata 增加参与摘要的 scope 信息。
- goal projection 下使用的 compact/session memory summary 必须由同一 goal projection 生成，或明确标记 summary 包含 interlude 并在 goal projection 中排除。
- Phase 4 验收增加：paused interlude 先被 compact，再 resume 时，goal context 中仍不得出现 interlude 内容。

### 8. Event log 字段设计前后不一致

前半部分要求 `TaskState` 新增：

```ts
goal_event_log?: GoalEvent[];
```

后半部分又引入：

```ts
goal_event_log_tail?: GoalEvent[];
goal_event_log_artifact?: string;
```

相关位置：

- `goal_spec.md:235`：TaskState 扩展。
- `goal_spec.md:1061`：event log 上限。

风险：

- load/status/export/fork 到底读取 `goal_event_log` 还是 `goal_event_log_tail` 不明确。
- 迁移到 artifact 后，`GoalEvents.deserialize()` 的输入类型和读取优先级未定义。

建议：

定义统一存储 schema，例如：

```ts
goal_event_log?: GoalEvent[];
goal_event_log_tail?: GoalEvent[];
goal_event_log_artifact?: string;
```

并规定优先级：

1. MVP 只写 `goal_event_log`。
2. 启用 artifact 后，`goal_event_log_tail` 是 task JSON 中的 tail，artifact 是完整历史或归档历史。
3. status/render 默认只读 tail；repair/export 可按需读 artifact。

### 9. `GoalController.recordEvaluatorFailure()` 被使用但未列入接口

Goal hook 伪代码和 evaluator exception policy 都要求调用 `GoalController.recordEvaluatorFailure()`，但 `GoalController` 建议接口没有这个方法。

相关位置：

- `goal_spec.md:492`：Controller 接口。
- `goal_spec.md:793`：hook 伪代码调用。
- `goal_spec.md:893`：exception policy 调用。

风险：

- evaluator failure 的状态转换入口可能被临时散落在 hook/evaluator 中，破坏 Controller 作为状态机唯一入口的原则。

建议：

在接口中补充：

```ts
static recordEvaluatorFailure(task: TaskState, goal: GoalState, error: unknown): GoalEvaluationApplyResult;
```

并规定 stale failure 丢弃规则也在该方法内部实现。

### 10. `waiting` task 状态未纳入 Task/Goal invariant

文档开头承认 `task_status` 为 `waiting | running | stopped`，但 invariant 表只覆盖 running/stopped，没有覆盖 waiting。

相关位置：

- `goal_spec.md:9`：TaskState/task_status 约束。
- `goal_spec.md:454`：Task/Goal 状态一致性表。

源码证据：

- `src/main/aikernel/states/tasks.ts:88`：`TaskStatus = 'waiting' | 'running' | 'stopped'`。
- `src/main/aikernel/states/tasks.ts:1604`：`waitUntilFinished()` 将 waiting 视为 active status。

风险：

- 新 task 初始 waiting 时创建 goal 的短暂状态未定义。
- import/recover 或 future API 可能留下 `active + waiting`，scheduler/controller 行为不明确。

建议：

在 invariant 表中加入 waiting，至少定义：

- 无 goal + waiting：新建未启动 task。
- active + waiting：非法稳定态，scheduler 应启动或转 paused。
- paused/blocked/budget_limited + waiting：应规范化为 stopped 或明确 UI 语义。

## 中风险问题

### 11. 默认 goal start prompt 未定义

`/goal <objective>` 规则说创建启动使用默认 goal start prompt，但文档只给了默认 resume prompt 和 recovery continuation prompt，没有给 create/start prompt 的完整内容。

相关位置：

- `goal_spec.md:159`：默认 goal start prompt。
- `goal_spec.md:708`：默认 resume prompt。
- `goal_spec.md:1033`：recovery prompt。

风险：

- create 后首轮执行和 resume 后续跑的模型指令可能不一致。
- 测试无法断言默认 prompt。

建议：

补充默认 goal start prompt，并明确它是否包含 successCriteria、budget、当前 task transcript、以及“不完成不要结束”的约束。

### 12. 用户可见文案未接入本地化要求

规格中直接写了 TUI help/status 文案，例如 `Goal commands:`、`No goal for current task.`。项目现有 TUI command 普遍通过 `t()` 取本地化文案。

源码证据：

- `src/main/tui/commands/stop.ts:9`：`description: t('stop.description')`。
- `src/locale/zh-cn.ts`、`src/locale/en-us.ts`：现有本地化入口。

风险：

- Phase 1 实现时容易直接硬编码英文文案。
- 与 AGENTS.md 的“用户可见文本必须接入本地化”要求冲突。

建议：

- 规格明确新增 `goal.*` locale keys。
- 验收标准增加：TUI/GUI/renderer 中 goal 用户可见文案必须通过 locale；内部 event type、protocol enum、test fixture 可不本地化。
- 关键文件清单加入 `src/locale/zh-cn.ts`、`src/locale/en-us.ts`。

### 13. 关键文件清单漏掉若干必要修改点

Phase 1 验收要求 active goal 下 `/stop` 被拒绝，但 Phase 1 只需要修改的文件列表没有 `src/main/tui/commands/stop.ts`。runtime interrupt、message metadata、budget/evaluator usage、本地化也缺少对应文件。

相关位置：

- `goal_spec.md:1255`：Phase 1 文件清单。
- `goal_spec.md:1280`：Phase 1 `/stop` 验收。

建议补充：

- Phase 1：`src/main/tui/commands/stop.ts`、`src/locale/*`。
- Phase 2：`src/main/aikernel/llm.ts` 如果要拿 evaluator usage 或统一 timeout。
- Phase 4：`src/main/aikernel/messages.ts`、`src/main/aikernel/compaction/full-compact.ts`、`src/main/aikernel/compaction/session-memory-compact.ts`、`src/main/aikernel/compaction/tool-results.ts`、`src/main/aikernel/compaction/microcompact.ts`、`src/main/aikernel/compaction/auto-compact.ts`。

### 14. Data model 缺少若干类型定义

`GoalState` 使用了 `GoalTokenBudget`、`GoalEditRecord`、`GoalSchedulerLease`。其中 `GoalSchedulerLease` 和 `GoalTokenBudget` 在后文有定义或部分定义，但 `GoalEditRecord` 未定义。接口里还出现 `GoalStatusView`、`CreateGoalInput`、`GoalCommandResult`、`ResumeGoalOptions`、`GoalEvaluationApplyResult` 等类型，但没有最小结构。

相关位置：

- `goal_spec.md:276`：`GoalTokenBudget`。
- `goal_spec.md:284`：`GoalEditRecord`。
- `goal_spec.md:491`：Controller 接口相关类型。

风险：

- 实现者会自行补类型，容易导致 TUI/GUI/API 返回结构不一致。

建议：

补齐最小类型定义，尤其是 command result 的状态、用户可见 message key、是否启动 scheduler、是否产生 interrupt。

### 15. blocked 普通消息恢复仍留有产品策略空洞

文档已要求 blocked 恢复判断放在 `TaskState.submitUserMessage()` 前段，这个方向正确。但对于 `ignore` 分支，文档写“该消息是否作为普通聊天处理由当前产品交互策略决定”。

相关位置：

- `goal_spec.md:636`：blocked 恢复规则。

风险：

- TUI、GUI、ACP、opencode 对无关消息可能出现不同策略：有的继续普通聊天，有的拒绝，有的静默忽略。
- 如果 blocked goal 下允许普通聊天，后续普通 turn 是否应标记 interlude/global 也未定义。

建议：

MVP 明确采用一个策略：

- `ignore_and_submit_as_interlude`：普通聊天继续，但 message 标记 interlude，不恢复 goal。
- 或 `ignore_and_reject`：显示 blocked 提示，不提交普通 turn。

不要把产品策略留给入口自行决定。

### 16. Export / render summary 边界仍偏粗

规格要求 `toRenderJSON()` 可只返回 goal summary，export HTML 可以展示 goal summary 但不导出完整 event log。这是合理方向，但 summary 字段结构没有定义。

相关位置：

- `goal_spec.md:250`：render JSON summary。
- `goal_spec.md:1117`：export。
- `goal_spec.md:1310`：GUI 可展示 goal summary。

风险：

- renderer、sidebar、export 各自拼字段，容易暴露 full event log 或遗漏 HTML escape。
- cleared/complete 的展示策略可能不一致。

建议：

定义 `GoalRenderSummary`：

```ts
interface GoalRenderSummary {
    id: string;
    status: GoalStatus;
    revision: number;
    objective: string;
    pendingContinuation: boolean;
    updatedAt: string;
    completedAt?: string;
}
```

并明确不包含 event payload、raw evaluator evidence、artifact path。

## 测试设计评审

当前测试矩阵覆盖面较好，但需要以下补充或调整：

- **阶段可执行性**：将 Phase 1/Phase 3 的 scheduler/resume/lease 测试重新分组，避免 Phase 1 无法独立通过。
- **本地化测试**：TUI help/status/error、GUI button/panel、renderer badge 文案必须覆盖 locale key，不应硬编码。
- **interrupt after hook 测试**：pause/clear 后不仅要验证 beforeFinish guard/evaluator 不运行，也要验证 afterFinish/session memory/task review 是否按规格跳过。
- **stale tool guard 测试**：必须覆盖 stale tool 在权限检查前被跳过，不弹 permission prompt。
- **compact 泄漏测试**：interlude 被 compact/session memory summary 后，resume/evaluator 仍不能看到 interlude。
- **event log artifact 测试**：超过 200 条后 load/status/export/fork 的读取策略必须覆盖。
- **budget resume 测试**：如果 `/goal resume` 允许从 `budget_limited` 恢复，必须覆盖预算没有提高时的行为。
- **API 一致性测试**：TUI、GUI IPC、ACP/opencode 普通 submit 都应通过同一个 blocked 恢复入口。

## 验收标准评审

验收标准总体较完整，但还应补齐：

- Phase 1 是否包含完整 scheduler/resume/lease，必须和阶段规划一致。
- `/goal edit` running 场景的验收应明确 stale tool call 在权限检查前被跳过。
- `/goal clear` 和 `/goal pause` 的 afterFinish/session memory/task review 行为。
- `GoalService.edit()`、`recordEvaluatorFailure()` 这类 API 完整性。
- `GoalSchedulerLease.reason = create` 的验收。
- `waiting` task 状态组合的规范化验收。
- 本地化验收。
- compact summary 不泄漏 interlude 的验收。

## 建议修订顺序

1. 先修 Phase 划分，明确 Phase 1 是否是可执行 MVP。
2. 补齐 API：`GoalService.edit()`、`GoalController.recordEvaluatorFailure()`、`GoalSchedulerLease.reason`。
3. 完整定义 runtime interrupt 生命周期，包括 after hooks。
4. 决定 running edit 是否进入 MVP；如果进入，补 `ToolCall` metadata 和权限前 stale guard。
5. 明确 budget_limited resume 策略。
6. 补 event log tail/artifact schema 与读取优先级。
7. 补 projection 对 compact/session memory summary 的 scope 规则。
8. 补本地化要求和关键文件清单。

## 最终判断

该规格已经覆盖了 goal 机制的大部分关键面，方向上可以作为实现基础；但仍有若干会导致实现分叉或行为歧义的缺口。尤其是 Phase 边界、runtime interrupt、running edit、projection/compact、budget 恢复和数据 schema，需要在编码前修订。测试矩阵应跟随这些修订重排，否则会出现“测试很全但阶段不可落地”的问题。
