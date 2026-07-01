# Goal 机制设计规范

> **目录**
>
> - [1. 背景](#1-背景)
> - [2. 设计原则](#2-设计原则)
>     - [2.1 Goal 是控制状态，不是普通聊天消息](#21-goal-是控制状态不是普通聊天消息)
>     - [2.2 Goal 不替代 Todo](#22-goal-不替代-todo)
>     - [2.3 Goal 不扩展 task_status](#23-goal-不扩展-task_status)
>     - [2.4 Compact summary 不是状态源](#24-compact-summary-不是状态源)
>     - [2.5 当前状态与审计日志分离](#25-当前状态与审计日志分离)
> - [3. TUI 指令设计](#3-tui-指令设计)
>     - [3.1 指令列表](#31-指令列表)
>     - [3.2 参数解析](#32-参数解析)
>     - [3.3 补全](#33-补全)
>     - [3.4 指令行为](#34-指令行为)
> - [4. 数据模型](#4-数据模型)
>     - [4.1 TaskState 扩展](#41-taskstate-扩展)
>     - [4.2 GoalStatus](#42-goalstatus)
>     - [4.3 GoalState](#43-goalstate)
>     - [4.4 GoalEvaluation](#44-goalevaluation)
>     - [4.5 GoalContinuation](#45-goalcontinuation)
>     - [4.6 GoalEvent](#46-goalevent)
>     - [4.7 GoalEventLogStorage](#47-goaleventlogstorage)
>     - [4.8 辅助类型](#48-辅助类型)
> - [5. 状态机](#5-状态机)
>     - [5.1 创建](#51-创建)
>     - [5.2 active](#52-active)
>     - [5.3 paused](#53-paused)
>     - [5.4 blocked](#54-blocked)
>     - [5.5 budget_limited](#55-budget_limited)
>     - [5.6 complete](#56-complete)
>     - [5.7 Task/Goal 状态一致性 invariant](#57-taskgoal-状态一致性-invariant)
> - [6. GoalController](#6-goalcontroller)
>     - [6.1 Runtime interrupt](#61-runtime-interrupt)
>     - [6.2 Goal edit reminder 与 revision guard](#62-goal-edit-reminder-与-revision-guard)
>     - [6.3 blocked 的普通对话恢复](#63-blocked-的普通对话恢复)
> - [7. Scheduler](#7-scheduler)
>     - [7.1 执行启动流程](#71-执行启动流程)
>     - [7.2 默认 prompt 与 continuation prompt 来源](#72-默认-prompt-与-continuation-prompt-来源)
>     - [7.3 lease](#73-lease)
> - [8. Finish Hook 集成](#8-finish-hook-集成)
>     - [8.1 短期实现：兼容现有二值 hook](#81-短期实现兼容现有二值-hook)
>     - [8.2 Hook 顺序](#82-hook-顺序)
>     - [8.3 Goal hook 伪代码](#83-goal-hook-伪代码)
> - [9. GoalEvaluator](#9-goalevaluator)
>     - [9.1 实现方式](#91-实现方式)
>     - [9.2 输入](#92-输入)
>     - [9.3 输出](#93-输出)
>     - [9.4 结果应用](#94-结果应用)
>     - [9.5 Evaluator exception policy](#95-evaluator-exception-policy)
> - [10. Projection 与 interlude](#10-projection-与-interlude)
>     - [10.1 消息范围](#101-消息范围)
>     - [10.2 何时标记 interlude](#102-何时标记-interlude)
>     - [10.3 Goal projection](#103-goal-projection)
>     - [10.4 与 compact pipeline 的关系](#104-与-compact-pipeline-的关系)
>     - [10.5 Compact boundary provenance](#105-compact-boundary-provenance)
> - [11. 持久化](#11-持久化)
>     - [11.1 保存位置](#111-保存位置)
>     - [11.2 Crash/restart recovery](#112-crashrestart-recovery)
>     - [11.3 序列化](#113-序列化)
>     - [11.4 Event log 上限](#114-event-log-上限)
> - [12. 与现有功能的交互](#12-与现有功能的交互)
>     - [12.1 Todo](#121-todo)
>     - [12.2 Stop](#122-stop)
>     - [12.3 Rewind](#123-rewind)
>     - [12.4 Fork](#124-fork)
>     - [12.5 Export](#125-export)
>     - [12.6 Subtask](#126-subtask)
>     - [12.7 Session memory](#127-session-memory)
> - [13. Budget](#13-budget)
>     - [13.1 budget_limited resume 策略](#131-budget_limited-resume-策略)
> - [14. 实现阶段](#14-实现阶段)
>     - [Phase 1：TUI + 持久化 + 可执行 MVP](#phase-1tui--持久化--可执行-mvp)
>     - [Phase 2：finish hook + evaluator](#phase-2finish-hook--evaluator)
>     - [Phase 3：blocked 普通消息恢复 + scheduler 加固](#phase-3blocked-普通消息恢复--scheduler-加固)
>     - [Phase 4：projection + interlude](#phase-4projection--interlude)
>     - [Phase 5：GUI IPC 与可视化](#phase-5gui-ipc-与可视化)
>     - [14.6 Phase 5 GUI 实现细节](#146-phase-5-gui-实现细节)
> - [15. 关键文件](#15-关键文件)
> - [16. 验收标准](#16-验收标准)
> - [17. 测试看护矩阵](#17-测试看护矩阵)

## 1. 背景

OpenDesk 当前已经具备 task、turn、hook、subtask、todo、context compact、session memory、TUI slash command 等基础设施。goal 机制应建立在这些现有机制之上，而不是另起一套任务运行系统。

现有架构中的关键约束：

- `TaskState` 是 task 的持久化主体，任务以 `tasks/<taskId>.json` 的形式落盘，修改持久化字段后应调用 `persistLater()`。
- `task_status` 的运行时主状态是 `waiting | running | stopped`，但从持久化 `running` 恢复时现有实现可能显示为 `failed`。它只表示 task runner 状态，不适合承载 goal 的 paused、blocked、complete 等业务状态。
- `beforeFinishTurn` 当前只支持 `{ operation: 'finish' }` 和 `{ operation: 'reject', message }`，`reject` 会追加 internal user message 并继续同一个 task turn。
- 主任务已有全局 finish hook：todo 未完成时拒绝结束；对话异常中断时拒绝结束。
- 当前 context projection 主要由 compact boundary 决定，尚不能表达 goal/interlude/global 消息范围。
- TUI slash command 是 flat registry，适合用一个 `/goal` 命令承载多个子命令。
- `task.stop()` 是 runner 级中断能力，不是 goal 状态转换。active goal 下不支持用户可见 `/stop` 指令；停止/暂停 goal 执行必须使用 `/goal pause`。
- TUI slash command 被 registry 消费后不会再进入普通用户消息提交路径，因此 `/goal <objective>` 若要启动执行，必须显式调用 goal scheduler。

goal 机制的目标是：让用户可以为当前 task 建立一个可持久化、可暂停、可恢复、可验收、可续跑的目标控制层。

## 2. 设计原则

### 2.1 Goal 是控制状态，不是普通聊天消息

`/goal <objective>`、`/goal pause`、`/goal resume` 等命令是 control plane 操作，不应作为普通 user message 交给主 agent 猜测执行。

TUI、未来 GUI、内部 scheduler 都应调用同一个 `GoalController`。

### 2.2 Goal 不替代 Todo

todo 是 agent 在执行过程中的计划与工作分解；goal 是用户级完成标准和最终验收目标。

finish 判断顺序采用有序短路：

0. runtime interrupt：如果当前 turn 已因 `/goal pause`、`/goal clear`、系统退出等原因被中断，不再进入 finish hook 链。
1. hard guard：任务停止、错误 part、子任务等无需 goal 处理的场景。
2. todo guard：如果还有未完成 todo，直接继续执行 todo。
3. interruption guard：如果最后回复异常中断，先继续补全。
4. goal evaluation：只有前面的 guard 都放行后，才验收 goal。

这样 todo 未完成时不会反复调用 goal evaluator。

`/goal pause` 不是 goal evaluation 的一部分。它是用户控制面中断，必须从用户视角立即生效，不能等 todo/interruption/goal evaluator 放行。

### 2.3 Goal 不扩展 `task_status`

goal 状态保存在 `task.goal_state.status`。例如 task 可以是 `stopped`，但 goal 仍然是 `blocked` 或 `paused`。

### 2.4 Compact summary 不是状态源

goal 摘要可以进入 compact summary，但 authoritative state 必须在 task JSON 中落盘。重启、compact、export、fork 等行为都必须以 `goal_state` 和结构化 `goal_event_log` storage 为准。

### 2.5 当前状态与审计日志分离

`goal_state` 是运行时和 UI 读取的当前物化状态。`goal_event_log` storage 是审计日志入口，不作为默认 replay 来源。load、fork、undo、redo、repair/migration 等路径不得依赖 event log 自动回放来恢复当前状态，除非显式进入修复或迁移流程。

## 3. TUI 指令设计

TUI 指令是第一入口；GUI IPC 与可视化在 Phase 5 接入，所有入口共享同一个 `GoalController`。

新增文件：

```text
src/main/tui/commands/goal.ts
```

并在：

```text
src/main/tui/commands/index.ts
```

注册 `registerGoalCommand(tui)`。

### 3.1 指令列表

```text
/goal
/goal status
/goal edit <objective>
/goal pause
/goal resume [note]
/goal clear
```

### 3.2 参数解析

- 子命令使用第一个 token。
- `edit`、`resume` 后面的内容保留原始字符串。
- `pause` 不接受参数；如果 `/goal pause` 后存在非空内容，必须拒绝并提示使用 `/goal resume [note]` 在恢复时补充上下文。
- 暂不支持 shell quote 语义，避免引入复杂解析器。

### 3.3 补全

顶层补全：

```text
status
edit
pause
resume
clear
```

MVP 可以返回固定补全；后续可根据当前 goal status 过滤不可用命令。

### 3.4 指令行为

#### `/goal`

裸 `/goal` 不创建 goal，不等同于 `/goal status`。它只展示 goal 指令帮助，使用 `InfoOverlay`。以下文案只是语义示例，实际用户可见字符串必须通过 `goal.*` locale key 输出：

```text
Goal commands:
  /goal <objective>     Create and start a goal
  /goal status          Show current goal
  /goal edit <objective>
  /goal pause
  /goal resume [note]
  /goal clear
```

如果用户输入 `/goal` 后只有空白字符，必须按裸 `/goal` 处理，展示上述帮助。

#### 用户可见文案与本地化

TUI、GUI、renderer、HTML export 中所有 goal 用户可见文案必须通过 locale 系统输出，新增 key 使用 `goal.*` 前缀。本文档中的英文/中文提示都是语义示例，不是可硬编码字符串。

要求：

- TUI command description、help、status、error、blocked/budget 提示都使用 locale key。
- GUI button、panel、badge、tooltip、empty state 都使用 locale key。
- renderer/export 展示的静态标签使用 locale key；objective、reason 等用户/模型生成内容只做 escape，不翻译。
- event type、protocol enum、测试 fixture、日志内部 code 不需要本地化。

#### `/goal status`

展示当前 task 的 goal 状态。没有 goal 时显示：

```text
No goal for current task.
```

有 goal 时展示：

```text
Goal: active  rev 3
Objective: 修复导出 HTML 中代码块渲染问题

Attempts: 2 / 5
Last evaluation: not_met, 2026-06-22T09:31:00.000Z
Reason: 还没有验证导出结果
Pending continuation: yes
```

Phase 1 只要求展示 objective、status、revision、pending continuation 等已实现字段。Criteria 不展示；Budget 仅在预算能力实际启用后展示。`successCriteria` 字段保留给未来版本；在没有明确维护入口前，evaluator 只能以 `objective` 为完成标准。

展示使用 `InfoOverlay`，不新增专门 TUI 面板。

#### `/goal <objective>`

创建新 goal 并进入 `active`。

规则：

- `<objective>` trim 后不能为空。空 objective 必须拒绝创建，并展示裸 `/goal` 的帮助提示。
- 当前没有 goal，或当前 goal 是 `complete | cleared`，允许创建。
- 当前存在 `active | paused | blocked | budget_limited` goal，拒绝创建，提示使用 `/goal edit` 或 `/goal clear`。
- 创建时 `revision = 1`，`attempts = 0`，`successCriteria = []`。
- 不自动提交普通用户消息。
- 创建后采用 `create_and_start` 语义：`GoalService.create()` 必须在写入 goal state 后通过 `GoalScheduler.startExecution()` 启动一个 internal goal turn。
- 创建启动使用默认 goal start prompt，不创建 `pendingContinuation`；scheduler 仍必须获取同进程 lease，避免同一 OpenDesk 进程内重复入口启动多个 runner。

#### `/goal edit <objective>`

修改 objective。

规则：

- `<objective>` trim 后不能为空。空 objective 必须拒绝修改，并展示裸 `/goal` 的帮助提示。
- 只允许对现有非 `cleared` goal 使用。
- `revision += 1`。
- 清空 `lastEvaluation`。
- 废弃 `pendingContinuation`。
- 如果当前状态是 `active`，清空 scheduler lease；若当前 task 未运行，由 scheduler 基于新 objective 启动新的 execution；若当前 task 正在运行，当前 turn 继续运行，但必须立即注入一条 internal goal edit reminder，并在后续 LLM/tool 循环中按新 revision 推进。过期 evaluation 必须丢弃。
- running active goal 的 `edit` 不通过 runtime interrupt 停止当前 turn，但必须防止旧 objective 生成的工具调用继续产生外部副作用。runner 必须在工具调用前执行 goal revision guard：如果 tool call 所属的 `goalRevision` 与当前 `goal_state.revision` 不一致，跳过该工具调用并写入结构化 skipped/error 结果，然后让后续 LLM 看到新的 internal reminder。
- 如果当前状态是 `paused`，保持 `paused`，不自动 resume。
- 如果当前状态是 `blocked | budget_limited`，保持原状态；`edit` 只修正目标，不自动恢复执行。

#### `/goal pause`

立即暂停 goal 自动验收和自动续跑，并尽快中断当前 goal runner。

规则：

- 用户执行后，`goal_state.status` 立即进入 `paused`，UI 立即刷新。
- 如果 task 正在运行，系统通过统一 runtime interrupt 机制 best-effort 停止当前 LLM/tool/runner。
- 不回滚已经完成的工具调用、文件修改或外部副作用。
- 当前被中断的 turn 不运行 todo guard、interruption guard、goal evaluator。
- 当前正在运行的工具如果支持取消，调用 `tool.stop()`；如果不支持取消，等待当前原子操作返回后停止 runner，不进入下一轮 LLM。
- pause 不是旧 turn 的可恢复执行栈；resume 总是开启新的 continuation turn。

#### `/goal resume [note]`

恢复 goal。`note` 是可选的本次继续执行补充信息，适合表达用户已经完成的外部动作、环境变化、授权变化或希望本次继续时注意的新事实，例如“我已经修改了网络状态，重新尝试你的搜索”。

规则：

- 允许从 `paused | blocked` 恢复。
- `budget_limited` 只有在本次 resume 同时携带明确预算授权或预算调整时才允许恢复。TUI MVP 的 `/goal resume [note]` 没有预算参数；即使携带 `note`，对 `budget_limited` 也必须拒绝并提示用户需要预算授权、未来 GUI 预算操作，或 `/goal clear`。
- `note` 原始字符串保留，写入 `resumed` event payload，并注入本次 continuation internal turn prompt。
- `note` 只作为本次继续执行的补充上下文，不修改 `objective`、`successCriteria`、`revision` 或 `editHistory`。
- `note` 只消费一次；不得因为后续自动 continuation 重复注入旧 note。
- goal 进入 `active`。
- 如果存在 `pendingContinuation`，由 scheduler 消费它，并通过 `TaskState.startInternalTurn()` 启动 task runner。
- 如果不存在 `pendingContinuation`，scheduler 生成一条默认 goal resume prompt，并通过 `TaskState.startInternalTurn()` 要求主 agent 根据当前 goal 继续推进。
- resume 应使用同进程 lock/lease 防止重复启动。

#### `/goal clear`

清除当前 goal 控制。

规则：

- 进入 `cleared`。
- 不删除历史消息。
- 清空 `pendingContinuation`，释放 `schedulerLease`。
- 通过统一 runtime interrupt 停止当前 runner；如果有 permission prompt，应取消 prompt；如果有 running tool 且支持停止，应 best-effort 调用 `tool.stop()`。
- 不回滚文件修改。
- 不表示成功或失败。

## 4. 数据模型

新增目录：

```text
src/main/aikernel/goal/
  state.ts
  controller.ts
  service.ts
  evaluator.ts
  scheduler.ts
  projection.ts
  hooks.ts
```

### 4.1 TaskState 扩展

在 `TaskState` 上新增：

```ts
goal_state?: GoalState;
goal_event_log?: GoalEventLogStorage;
```

必须接入：

- `TaskState.load()`
- `TaskState.toJSON()`
- `TaskState.toSimplifiedJSON()`
- `TaskState.toRenderJSON()`
- `TaskState.fork()`
- `TaskState.rewindMessages()` / `TaskState.redoMessages()` 或等价的 history mutation API
- `TaskManagerState.removeTask()`

`toRenderJSON()` 可以只返回 goal 摘要，避免把完整 event log 传给 renderer。renderer/export/sidebar 只能消费 `GoalRenderSummary` 或等价的安全摘要，不得读取完整 event payload、raw evaluator evidence 或 `GoalEventLogStorage.artifactPath`。

### 4.2 GoalStatus

```ts
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budget_limited' | 'complete' | 'cleared';
```

### 4.3 GoalState

```ts
export interface GoalState {
    version: 1;
    id: string;
    taskId: string;
    objective: string;
    successCriteria: string[];
    status: GoalStatus;
    revision: number;

    attempts: number;
    maxAttempts?: number;
    tokenBudget?: GoalTokenBudget;
    timeBudgetMs?: number;
    startedAt?: string;

    lastEvaluation?: GoalEvaluation;
    pendingContinuation?: GoalContinuation;
    editHistory: GoalEditRecord[];

    // 仅用于系统恢复、导入修复等内部原因；不来自用户 `/goal pause` 参数。
    pauseReason?: string;
    blockedReason?: string;
    budgetLimitedReason?: string;

    oneShotBudgetOverride?: GoalOneShotBudgetOverride;
    schedulerLease?: GoalSchedulerLease;

    createdAt: string;
    updatedAt: string;
    pausedAt?: string;
    resumedAt?: string;
    completedAt?: string;
    clearedAt?: string;
}
```

字段含义：

| 字段                  | 含义                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`             | `GoalState` schema 版本。当前固定为 `1`，用于后续 migration/repair 判断旧数据格式。                                                                     |
| `id`                  | 当前 goal 的唯一 ID。新建 goal 时生成；同一 task 内 complete/cleared 后再次创建新 goal，应生成新的 `id`。                                               |
| `taskId`              | 该 goal 所属 task 的 ID。fork task 时必须更新为 fork 后 task ID。                                                                                       |
| `objective`           | 用户要求达成的目标文本，是 goal 执行和验收的主目标。只有 `/goal <objective>` 创建和 `/goal edit <objective>` 修改它。                                   |
| `successCriteria`     | 可选的结构化验收标准列表。为空时 evaluator 以 `objective` 和上下文作为主要判断依据。                                                                    |
| `status`              | 当前 goal 状态，取值见 `GoalStatus`。这是运行时、scheduler、UI 判断当前 goal 的权威状态字段。                                                           |
| `revision`            | goal 目标版本号。创建时初始化；每次 `objective` 或 `successCriteria` 被 edit 后递增，用于丢弃 stale evaluator、continuation、tool call 或 resume 结果。 |
| `attempts`            | 当前 goal 已经消耗的自动推进尝试次数，用于 `maxAttempts` 预算判断。                                                                                     |
| `maxAttempts`         | 可选最大尝试次数预算。达到后应进入 `budget_limited`，不得继续自动续跑。                                                                                 |
| `tokenBudget`         | 可选 token 预算配置和已用量统计。token usage 暂不可得时，MVP 不应因 unknown usage 触发 `budget_limited`。                                               |
| `timeBudgetMs`        | 可选时间预算，单位毫秒。用于限制 goal 从开始到继续推进的总耗时或实现约定的预算窗口。                                                                    |
| `startedAt`           | goal 首次开始执行的时间，ISO string。用于时间预算、状态展示和审计。                                                                                     |
| `lastEvaluation`      | 最近一次 evaluator 的结构化结果。它是最近验收结论摘要，不是当前状态的唯一来源；应用结果后仍必须写入 `status` 等物化字段。                               |
| `pendingContinuation` | 待消费的一次性续跑请求。scheduler resume/continuation 时优先消费它；消费后必须标记 consumed，避免同一 continuation 被执行两次。                         |
| `editHistory`         | goal objective 的编辑历史。用于审计、状态展示和 stale revision 诊断；不能替代 `goal_event_log`。                                                        |
| `pauseReason`         | 内部暂停原因，只用于系统恢复、导入修复等非用户参数场景，例如 crash/restart recovery。用户 `/goal pause` 不接受 reason，也不写入该字段。                 |
| `blockedReason`       | 当前进入 `blocked` 的原因摘要，例如缺少用户信息、权限、凭据、外部状态或 evaluator failure。                                                             |
| `budgetLimitedReason` | 当前进入 `budget_limited` 的预算原因摘要，例如 time budget、token budget 或 max attempts 达到上限。                                                     |
| `schedulerLease`      | 当前进程内 scheduler 防重 lease。用于避免 create/resume/continuation/hook 等入口重复启动多个 runner；不是跨进程锁。                                     |
| `createdAt`           | goal 创建时间，ISO string。                                                                                                                             |
| `updatedAt`           | goal 最近一次状态或关键字段更新时间，ISO string。任何状态转换、edit、resume、pause、clear 等都应更新。                                                  |
| `pausedAt`            | 最近一次进入 `paused` 的时间。只在当前或历史上发生 pause/recovery pause 后存在。                                                                        |
| `resumedAt`           | 最近一次 resume 的时间。                                                                                                                                |
| `completedAt`         | 进入 `complete` 的时间。                                                                                                                                |
| `clearedAt`           | 执行 `/goal clear` 或等价 clear 操作的时间。                                                                                                            |

### 4.4 GoalEvaluation

```ts
export interface GoalEvaluation {
    goalId: string;
    goalRevision: number;
    status: 'met' | 'not_met' | 'blocked' | 'budget_limited';
    reason: string;
    evidence: string[];
    nextPrompt?: string;
    evaluatedAt: string;
}
```

`goalRevision` 必须等于当前 `goal_state.revision`，否则丢弃 evaluator 结果。

### 4.5 GoalContinuation

```ts
export interface GoalContinuation {
    id: string;
    goalId: string;
    goalRevision: number;
    prompt: string;
    reason: string;
    createdAt: string;
    consumedAt?: string;
    consumedByTurnGeneration?: number;
}
```

### 4.6 GoalEvent

```ts
export interface GoalEvent {
    id: string;
    goalId: string;
    taskId: string;
    type:
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
    revision: number;
    timestamp: string;
    source: 'tui' | 'gui' | 'api' | 'scheduler' | 'hook' | 'evaluator' | 'user_message' | 'system';
    payload?: Record<string, unknown>;
}
```

### 4.7 GoalEventLogStorage

`goal_event_log` 是唯一的 event log 持久化入口，使用 discriminated union 表达两种互斥存储模式：

```ts
export type GoalEventLogStorage = GoalEventLogInlineStorage | GoalEventLogArtifactStorage;

export interface GoalEventLogInlineStorage {
    mode: 'inline';
    events: GoalEvent[];
}

export interface GoalEventLogArtifactStorage {
    mode: 'artifact';
    tail: GoalEvent[];
    artifactPath: string;
}
```

规则：

- `inline` 模式表示完整 event log 直接保存在 task JSON 中，适合 Phase 1/MVP 和小日志 task。
- `artifact` 模式表示 task JSON 只保存最近事件 `tail` 和完整日志 artifact 指针 `artifactPath`。
- 两种模式互斥；不得同时维护 `goal_event_log` 数组、`goal_event_log_tail`、`goal_event_log_artifact` 等平行字段。
- `goal_state` 仍是当前状态源；`goal_event_log` 只用于审计、展示、导出、fork 和显式 repair/migration。

### 4.8 辅助类型

以下类型是 TUI、GUI IPC、scheduler、renderer 和测试共享的最小契约。实现可以增加字段，但不得让不同入口各自发明不兼容的返回结构。

```ts
export interface GoalTokenBudget {
    maxTotalTokens?: number;
    usedTotalTokens?: number;
}

export interface GoalEditRecord {
    revision: number;
    previousObjective: string;
    objective: string;
    editedAt: string;
    source: GoalEvent['source'];
}

export interface GoalSchedulerLease {
    id: string;
    acquiredAt: string;
    expiresAt: string;
    reason: 'create' | 'resume' | 'continuation' | 'hook';
}

export interface GoalBudgetOverride {
    maxAttemptsIncrement?: number;
    timeBudgetMsIncrement?: number;
    tokenBudgetIncrement?: number;
    oneShot?: boolean;
    reason?: string;
}

export interface GoalOneShotBudgetOverride {
    id: string;
    grantedAt: string;
    reason?: string;
    consumedAt?: string;
    consumedReason?: string;
}

export interface CreateGoalInput {
    objective: string;
    successCriteria?: string[];
    maxAttempts?: number;
    tokenBudget?: GoalTokenBudget;
    timeBudgetMs?: number;
    source?: GoalEvent['source'];
}

export interface ResumeGoalOptions {
    source?: GoalEvent['source'];
    promptOverride?: string;
    note?: string;
    budgetOverride?: GoalBudgetOverride;
}

export interface GoalRenderSummary {
    id: string;
    status: GoalStatus;
    revision: number;
    objective: string;
    pendingContinuation: boolean;
    updatedAt: string;
    completedAt?: string;
}

export interface GoalStatusView {
    summary?: GoalRenderSummary;
    lastEvaluationStatus?: GoalEvaluation['status'];
    lastEvaluationAt?: string;
    attempts?: number;
    maxAttempts?: number;
}

export interface GoalCommandResult {
    ok: boolean;
    status?: GoalStatus;
    messageKey?: string;
    messageArgs?: Record<string, unknown>;
    startedScheduler?: boolean;
    interruptedRunner?: boolean;
    summary?: GoalRenderSummary;
    errorCode?: string;
}

export type GoalEvaluationApplyResult =
    | { action: 'finish'; status: GoalStatus }
    | { action: 'continue'; continuationPrompt: string; continuationId: string };
```

`GoalRenderSummary` 是 renderer、task list、HTML export 的边界类型。它不得包含 event payload、完整 event log、raw evaluator evidence、`GoalEventLogStorage.artifactPath`、未经 HTML escape 的富文本，或其他只应留在主进程/持久化层的字段。

## 5. 状态机

### 5.1 创建

```text
none | complete | cleared
  -> active
```

如果已有未终结 goal，`create` 应失败。

### 5.2 active

```text
active
  -> complete         evaluator 判断目标达成
  -> blocked          evaluator 判断继续无意义，缺用户输入、权限或外部状态变化
  -> budget_limited   attempts/token/time 达到预算
  -> paused           用户执行 /goal pause，立即生效，并 best-effort 中断当前 runner
  -> paused           OpenDesk 重启后发现 task 在 running 状态下中断
  -> cleared          用户 clear
```

如果重启加载时发现持久化 task 处于 `running`，说明旧 runner/LLM stream/tool execution 栈已经丢失。goal 不允许继续保持可自动执行的 `active` 状态，必须按第 11.2 节的 crash/restart recovery 规则转为 `paused`，等待用户显式 `/goal resume` 后新开 continuation turn。

### 5.3 paused

```text
paused
  -> active           用户 resume
  -> cleared          用户 clear
```

`edit` paused goal 时状态仍为 `paused`，只增加 revision 并废弃旧 evaluation/continuation。

实现上可能短暂出现 `paused + running`，有两种场景：

1. **`/goal pause` 的 interrupt 收尾**：当前 LLM/tool 正在响应中断请求，goal 已 paused 但 runner 仍在收尾。该 runner 收尾后应进入 `paused + stopped`，且不进入 todo/interruption/goal evaluator。
2. **paused 期间用户提交 interlude 消息**：用户在 goal paused 时仍可进行普通对话（见第 10.2 节），消息默认标记为 `interlude`。提交 interlude 消息时 `task_status` 短暂变为 `running`，turn 完成后回到 `stopped`；interlude turn 不触发 goal evaluator 或自动续跑 scheduler。

两种场景下 `paused + running` 都是短暂瞬态，不允许长期稳定存在。

### 5.4 blocked

```text
blocked
  -> active           用户执行 /goal resume [note]
  -> active           用户普通消息明确表达继续、重试、再试一次等恢复意图
  -> active           用户普通消息补充了 blocker 所需的信息
  -> cleared          用户 clear
```

blocked 表示继续没有意义，需要用户输入、权限、凭据或外部状态变化。

blocked 可以由普通对话恢复，但不能由任意普通聊天自动恢复。只有当用户消息明确表达恢复意图，或明显补充了 blocker 所需信息时，才允许从 `blocked` 转回 `active`。

`budget_limited` 不适用普通对话恢复。它表示预算边界，必须通过预算授权或未来 GUI 的明确预算调整动作恢复；`/goal resume [note]` 在没有预算授权时不得绕过同一个预算边界。

### 5.5 budget_limited

```text
budget_limited
  -> active           用户显式提高预算、授权 one-shot override，或未来 GUI 执行等价预算操作
  -> paused           用户选择稍后继续
  -> cleared          用户 clear
```

budget_limited 表示可以继续，但达到系统预算边界。

### 5.6 complete

```text
complete
  -> cleared          用户 clear
  -> active           用户通过 `/goal <objective>` 创建新 goal
```

实现上创建新 goal 应生成新 `goalId`，不要复用旧 goal。

### 5.7 Task/Goal 状态一致性 invariant

`task_status` 和 `goal_state.status` 是两个状态机，必须有关联，但不能合并。

- `task_status` 描述 runner 生命周期：当前 task runner 是否正在执行。它不表达 goal 的业务语义。
- `goal_state.status` 描述用户目标控制状态：目标是否应继续推进、暂停、阻塞、预算受限、完成或清除。它不保证 runner 此刻一定在运行。

实现必须维护以下 invariant：

| goal 状态                        | task 状态                                | 语义                                                                                                                                                                     | 处理规则                                                                                                                                             |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无 goal / `cleared` / `complete` | `waiting`                                | 新建或尚未启动的普通 task。                                                                                                                                              | 不运行 goal hook/scheduler；task 被用户普通输入启动后按普通 task 处理。                                                                              |
| 无 goal / `cleared` / `complete` | `stopped`                                | 正常稳定态。                                                                                                                                                             | goal hook/scheduler 跳过。                                                                                                                           |
| 无 goal / `cleared` / `complete` | `running`                                | 正常普通 task turn，不受 goal 控制。                                                                                                                                     | 不启动 goal evaluator，不创建 goal continuation。                                                                                                    |
| `active`                         | `waiting`                                | 非法稳定态。active goal 已要求 scheduler 启动执行。                                                                                                                      | scheduler 必须启动 internal turn；若无法启动，controller 应转为 `paused` 或 `blocked` 并写入原因。                                                   |
| `active`                         | `running`                                | 正常 goal 执行态。                                                                                                                                                       | runner、finish hook、scheduler 按当前 `goalRevision` 推进。                                                                                          |
| `active`                         | `stopped`                                | 只在等待 scheduler 启动、已有 `pendingContinuation` 且明确允许等待，或短暂调度间隙中成立。                                                                               | 没有 `pendingContinuation` 且没有有效同进程 scheduler lease 时，scheduler 应启动 continuation 或由 controller 转入 `paused/blocked/budget_limited`。 |
| `active`                         | 从持久化 `running` 恢复出的停止/失败状态 | 非法稳定态。旧执行栈已经丢失。                                                                                                                                           | `TaskState.load()` 必须按第 11.2 节转为 `paused`，并保留或创建 recovery continuation。                                                               |
| `active`                         | 用户可见 `/stop` 后的 `stopped`          | 非法稳定态。                                                                                                                                                             | active goal 下 `/stop` 必须拒绝并提示使用 `/goal pause`；不得留下 `active + stopped`。                                                               |
| `paused`                         | `waiting`                                | 非法稳定态或 import/recovery 中间态。                                                                                                                                    | load/repair/controller 应规范化为 `stopped`，UI 展示 paused goal，不自动续跑。                                                                       |
| `paused`                         | `stopped`                                | 正常稳定态。                                                                                                                                                             | 不自动 evaluator，不自动续跑；等待 `/goal resume [note]`。                                                                                           |
| `paused`                         | `running`                                | 不允许作为长期稳定态。只允许作为以下两种短暂瞬态：(1) `/goal pause`/`/goal clear` runtime interrupt 收尾期间；(2) paused 期间用户提交 interlude 消息时的普通 turn 执行。 | 两种瞬态都不进入 goal evaluator 或自动续跑 scheduler。interrupt 收尾后 runner 必须进入 `stopped`；interlude turn 完成后 task 也回到 `stopped`。      |
| `blocked`                        | `waiting`                                | 非法稳定态或 import/recovery 中间态。                                                                                                                                    | load/repair/controller 应规范化为 `stopped`，等待用户恢复或清除。                                                                                    |
| `blocked`                        | `stopped`                                | 正常稳定态。                                                                                                                                                             | 等待 `/goal resume [note]` 或明确的普通对话恢复意图。                                                                                                |
| `blocked`                        | `running`                                | 只允许作为 evaluator/hook 应用 blocked 结果后的短暂清理态。                                                                                                              | 清理完成后必须停止 runner，不得继续自动 scheduler。                                                                                                  |
| `budget_limited`                 | `waiting`                                | 非法稳定态或 import/recovery 中间态。                                                                                                                                    | load/repair/controller 应规范化为 `stopped`，等待预算授权或清除。                                                                                    |
| `budget_limited`                 | `stopped`                                | 正常稳定态。                                                                                                                                                             | 等待预算授权、预算调整、未来 GUI 授权或清除；`/goal resume [note]` 无预算授权时不得绕过同一个预算边界。                                              |
| `budget_limited`                 | `running`                                | 只允许作为 evaluator/hook 应用预算结果后的短暂清理态。                                                                                                                   | 清理完成后必须停止 runner，不得继续自动 scheduler。                                                                                                  |

维护入口：

- `GoalService` 负责所有用户可见 goal control plane 操作，并在 pause/clear/resume/edit 时维护 invariant。
- `GoalScheduler` 启动前必须检查 goal/task 组合；`paused | blocked | budget_limited | complete | cleared` 不得自动启动 runner。
- `TaskState.load()` 负责 crash/restart recovery，把 `active + running-at-shutdown` 修复为 `paused + pendingContinuation`。
- 用户可见 `/stop` 在 active goal 下必须拒绝，提示使用 `/goal pause` 暂停并保留可恢复 goal。GUI stop 控件在 active goal 下不应暴露普通 stop 语义，应替换为 goal pause 控件或调用 `GoalService.pause()`。
- finish hook 应用 `complete | blocked | budget_limited` 后，不得再创建自动 continuation；`not_met` continuation 只能在 goal 仍为 `active` 且 revision 未过期时继续。
- low-level `task.stop()` 仍是 runner 原语，可供系统退出、任务删除等底层路径使用；但面向用户的停止入口必须经过 goal-aware 包装。

## 6. GoalController

`GoalController` 是所有入口共享的控制层。TUI 不直接修改 `task.goal_state`。

为避免 UI 入口各自复制 runner 停止逻辑，goal 入口应分两层：

- `GoalController`：只负责 goal 状态机、event log、持久化和订阅刷新；不直接调用 LLM，不直接停止工具。
- `GoalService`：TUI/GUI/内部 scheduler 的共享入口，负责组合 `GoalController`、`GoalScheduler` 和 runtime interrupt。

建议接口：

```ts
export class GoalController {
    static getStatus(task: TaskState): GoalStatusView;
    static create(task: TaskState, input: CreateGoalInput): GoalCommandResult;
    static editObjective(task: TaskState, objective: string): GoalCommandResult;
    static pause(task: TaskState, source?: GoalEvent['source']): GoalCommandResult;
    static resume(task: TaskState, options?: ResumeGoalOptions): Promise<GoalCommandResult>;
    static clear(task: TaskState, source?: GoalEvent['source']): GoalCommandResult;
    static recordEvaluation(task: TaskState, evaluation: GoalEvaluation): GoalEvaluationApplyResult;
    static recordEvaluatorFailure(task: TaskState, goal: GoalState, error: unknown): GoalEvaluationApplyResult;
    static maybeResumeBlockedGoalFromUserMessage(task: TaskState, message: string): Promise<GoalMaybeResumeResult>;
}
```

Controller 职责：

- 校验状态转换是否合法。
- 更新 `goal_state`。
- 追加 `goal_event_log`。
- 调用 `task.persistLater()`。
- 必要时通知订阅者刷新。
- 不直接调用 LLM。
- 不直接停止 runner 或工具。

共享入口建议：

```ts
export class GoalService {
    static create(task: TaskState, input: CreateGoalInput): Promise<GoalCommandResult>;
    static edit(task: TaskState, objective: string, source?: GoalEvent['source']): Promise<GoalCommandResult>;
    static pause(task: TaskState, source?: GoalEvent['source']): Promise<GoalCommandResult>;
    static resume(task: TaskState, options?: ResumeGoalOptions): Promise<GoalCommandResult>;
    static clear(task: TaskState, source?: GoalEvent['source']): Promise<GoalCommandResult>;
}
```

TUI、GUI IPC、API 和内部入口的 edit 都必须调用 `GoalService.edit()`，不得直接调用 `GoalController.editObjective()`。Controller 只负责 revision 和持久化；Service 负责 running active goal 的 reminder 注入、scheduler 触发和 stale revision guard 所需上下文。

`GoalService.pause()` 流程：

```text
GoalController.pause()
  -> status = paused
  -> append paused event, payload 不包含用户 reason
  -> persist/publish
  -> if task is running:
       TaskRuntimeInterruptor.interrupt(task, reason='goal_pause')
```

`GoalService.clear()` 流程：

```text
GoalController.clear()
  -> status = cleared
  -> clear pendingContinuation
  -> clear schedulerLease
  -> append cleared event
  -> persist/publish
  -> TaskRuntimeInterruptor.interrupt(task, reason='goal_clear')
```

### 6.1 Runtime interrupt

goal pause/clear 和普通 stop 都应复用同一个 runner 中断能力，而不是在 TUI/GUI 中复制逻辑。

建议新增：

```ts
export interface TaskRuntimeInterrupt {
    requested: boolean;
    reason: 'goal_pause' | 'goal_clear' | 'user_stop' | 'system_shutdown' | 'failure_recovery';
    requestedAt: string;
    turnGeneration?: number;
    handledAt?: string;
}
```

或在 `TaskState` 上提供等价方法：

```ts
task.interruptRunningTurn({
    reason: 'goal_pause',
    stopRunningTools: true,
    cancelPermissionPrompts: true
});
```

runner 必须在以下位置检查 runtime interrupt：

- 调用 LLM 前。
- 工具调用前。
- 工具调用后。
- `beforeFinishTurn` hook 前。

生命周期规则：

- `TaskRuntimeInterruptor.interrupt()` 在 controller 状态已经持久化后同步写入 `task.runtimeInterrupt` 或等价运行时字段，并取消 permission prompt、请求 running tool best-effort stop。
- `TaskRuntimeInterrupt` 是 runner 收尾信号，不是 goal 的权威状态源；重启后的权威恢复仍以 `task_status`、`goal_state` 和第 11.2 节规则为准。
- interrupt 必须绑定当前 `_turnGeneration` 或等价 generation，避免新 turn 误消费旧 interrupt。
- 如果 interrupt reason 是 `goal_pause` 或 `goal_clear`，当前 turn 收尾后直接停止，不进入 todo guard、interruption guard 或 goal evaluator。
- `noticeAfterFinishTurn` / session memory / task review / ordinary completion observer 默认不在 `goal_pause` 或 `goal_clear` 后运行。只有显式声明支持 interrupted turn 的 after hook，且能读取 interrupt reason，才可以 opt in 运行。
- runner 完成停止清理、发布 task 状态并处理完 opt-in after hook 后，设置 `handledAt` 并清理运行时 interrupt。
- `/goal pause` 和 `/goal clear` 可以复用底层停止原语，但不得等同于 `task.stop('user')`；用户 stop 语义、goal pause 语义和系统 shutdown 语义必须可区分。

### 6.2 Goal edit reminder 与 revision guard

running active goal 上执行 `/goal edit <objective>` 时，不能等当前 turn 自然结束后才让新 objective 生效。`GoalService.edit()` 在 `GoalController.editObjective()` 持久化新 revision 后，必须通过 `TaskState` 提供的 runner-safe 入口注入 internal reminder，例如：

```ts
task.injectGoalEditReminder({
    goalId,
    goalRevision: newRevision,
    objective,
    reason: 'goal_edit'
});
```

该入口必须保持 `processTaskTurn()` 的消息序列不变量：

- 如果当前没有 LLM stream 正在写入 assistant message，可以立即追加 internal user message，并确保后续继续时有 assistant message 承接。
- 如果当前 LLM stream 正在进行，先记录 pending injected reminder，在 stream 返回后、执行任何 stale tool call 前 materialize 到 transcript 或等价的 active context 中。
- 注入 reminder 不增加普通用户可见消息，不触发 slash skill、图片抽取、task name generation。
- 注入后不启动第二个 runner，不增加新的 scheduler lease；它只影响当前 running turn 的后续上下文。

goal runner 必须给 goal 相关 LLM 请求和由其生成的 assistant/tool call 记录来源与执行上下文。该信息不应设计成 goal 专用字段，而应作为通用 metadata 基础设施，供权限审计、undo/redo、fork/export、compact/projection、运行中断、并发防重、调试、多 agent/subtask 等场景复用。

建议在 `UserMessage` / `AssistantMessage` / `ToolCall` 上引入可选、可序列化、向后兼容的通用 metadata：

```ts
export interface RuntimeMetadata {
    scope?: 'task' | 'goal' | 'interlude' | 'global';
    origin?: {
        source: 'user' | 'internal' | 'hook' | 'scheduler' | 'compact' | 'tool' | 'system';
        reason?: string;
    };
    execution?: {
        turnId?: string;
        generation?: number;
        controller?: 'normal' | 'goal' | 'subtask' | 'system';
        controllerId?: string;
        controllerRevision?: number;
        continuationId?: string;
    };
    projection?: {
        policy?: string;
        includedScopes?: string[];
        excludedScopes?: string[];
    };
}
```

goal 场景中：

- `controller = 'goal'`。
- `controllerId = goalId`。
- `controllerRevision = goalRevision`。
- `origin.source` 标记该消息或工具调用来自用户、scheduler、hook continuation、goal edit reminder 等。

`ToolCall.metadata` 本身只提供判断依据，不能自动实时拦截工具。真正的 stale revision 拦截必须在 runner 的工具执行路径中完成，并至少覆盖两个安全点：

- 权限检查前：避免旧 revision 的 tool call 继续弹权限确认。
- 实际执行工具前：避免用户在权限确认、排队或其他异步等待期间执行 `/goal edit` 后，旧 tool call 仍被执行。

如果工具已经进入 `running`，metadata 只能帮助识别它属于旧 revision；停止仍依赖 runtime interrupt 或 `tool.stop()` 的 best-effort 行为，已经发生的外部副作用不回滚。

工具调用前必须执行：

```text
if toolCall.metadata.execution.controller == 'goal'
and toolCall.metadata.execution.controllerId == task.goal_state.id
and toolCall.metadata.execution.controllerRevision != task.goal_state.revision:
  mark tool call skipped/error with reason = stale_goal_revision
  do not execute tool
  continue runner so the injected reminder can drive the next LLM step
```

该 guard 的目的只是不执行旧 objective 生成的工具副作用；它不表示 goal blocked、paused 或 failed。stale tool call 的结果应进入 transcript，使模型理解该调用因目标已更新而未执行。

stale tool call 的标准结果对象必须稳定，便于模型、renderer 和测试识别：

```json
{
    "skipped": true,
    "reason": "stale_goal_revision",
    "goalRevision": 2,
    "currentGoalRevision": 3
}
```

### 6.3 blocked 的普通对话恢复

`blocked` 状态允许通过普通用户消息恢复，但必须经过显式判断：

```ts
GoalController.maybeResumeBlockedGoalFromUserMessage(task, message);
```

调用点必须放在 `TaskState.submitUserMessage()` 处理用户输入的最前段。所有 TUI、GUI、ACP、opencode 和内部入口都应继续只调用 `TaskState.submitUserMessage()`，避免不同入口复制 blocked 恢复判断。

判断结果必须是以下四类之一：

```ts
type GoalMaybeResumeResult =
    | { action: 'none' }
    | { action: 'resume_via_scheduler_only'; promptSource: 'pending_continuation' | 'default_resume' }
    | { action: 'resume_with_user_message' }
    | { action: 'ignore_and_reject'; messageKey: 'goal.blocked.unrelated_message' };
```

规则：

- 当前 goal 不是 `blocked`：返回 `none`，不处理。
- 用户消息是明确短恢复意图，例如 `继续`、`重试`、`再试一次`、`retry`、`continue`：返回 `resume_via_scheduler_only`。该短消息不作为普通 user message 入 transcript，不启动普通 submit turn；goal 转为 `active`，写入 `resumed` event，source 为 `user_message`，由 scheduler 拉起 continuation。
- 用户消息包含实质补充内容，且可以视为对 `blockedReason` 的回复：返回 `resume_with_user_message`。该消息正常进入 transcript，由同一个 submit turn 执行；goal 转为 `active`，不再额外调用 scheduler，避免双 turn。
- 用户消息明显是无关闲聊或新话题：MVP 固定返回 `ignore_and_reject`。保持 `blocked`，不启动 scheduler，不把该消息提交为普通 turn；UI 显示 blocked 提示，要求用户 `/goal resume`、补充 blocker 相关信息、`/goal edit` 或 `/goal clear`。Phase 4 若要允许普通聊天，必须在共享入口中统一改为 `ignore_and_submit_as_interlude`，并给消息标记 `interlude`，不得由各入口自行决定。
- 当前 goal 是 `budget_limited`：不处理。预算恢复必须来自预算调整命令、`ResumeGoalOptions.budgetOverride` 或未来 GUI 明确授权。

为了避免误判，MVP 可以先只实现 `resume_via_scheduler_only` 和 `ignore_and_reject`，只识别短恢复意图；对“补充 blocker 信息”的语义判断可以后续再引入轻量分类器。

## 7. Scheduler

`GoalScheduler` 负责启动 active goal 的执行和 continuation 消费。

### 7.1 执行启动流程

Scheduler 不得手工拼接 task runner 内部流程。现有 `appendInternalUserMessage()` 只负责追加 internal user message，不会设置 runner 状态、更新时间、清理 stop flag、创建 assistant message、attach toolsets、持久化或发布 task list 更新。

必须在 `TaskState` 上新增统一 internal turn API，例如：

```ts
task.startInternalTurn({
    prompt,
    source: 'goal_create' | 'goal_resume' | 'goal_continuation' | 'goal_hook',
    metadata: {
        goalId,
        goalRevision,
        continuationId
    }
});
```

该 API 复用普通 `submitUserMessage()` 的必要状态迁移：

- `task_status = running`。
- 更新 `started_at` / `updated_at` / `finished_at`。
- 清理 `stop_requested_by_user`。
- 持久化并发布 task list update。
- 追加 internal user message 和 assistant message。
- attach toolsets。
- 增加 `_turnGeneration` 并调用 `processTaskTurn()`。

该 API 不执行普通用户输入相关逻辑：

- 不进行 slash command 解析。
- 不抽取图片路径或 pasted image。
- 不执行 slash skill 文本替换。
- 不触发 task name generation，除非调用方显式要求。

```text
GoalService.create() 或 GoalService.resume()
  -> status = active
  -> GoalScheduler.startExecution(task)
     -> 获取 lease
     -> 选择 prompt
     -> 标记 pendingContinuation consumed（如有）
     -> task.startInternalTurn(...)
     -> 持久化 continuation_consumed event 和 lease 状态
```

create 和 resume 都开启新的 internal turn，不恢复旧 turn 的执行栈。

如果 `goal_state.status === 'paused'` 但 `task_status === 'running'`，说明 pause 的 runtime interrupt 仍在收尾。此时 `/goal resume` 不应启动第二个 runner，应提示用户当前 run 仍在停止中，或等待 stopped 后再由 scheduler 启动。

### 7.2 默认 prompt 与 continuation prompt 来源

`/goal <objective>` 创建后的首次执行使用默认 goal start prompt，不创建 `pendingContinuation`：

```text
<system-reminder>
开始推进当前 goal。

Goal objective:
...

Success criteria:
...

Budget:
...

请基于当前 task 上下文执行必要步骤，直到 goal 满足、遇到需要用户介入的 blocker，或达到预算边界。不要把本提醒作为普通用户消息回复。
</system-reminder>
```

`Success criteria` 为空时可以省略该段或明确显示为空；budget 未启用时可以省略 `Budget` 段。start prompt 必须带当前 `goalId`、`goalRevision` 的 runtime metadata，source 为 `goal_create`，scheduler lease reason 为 `create`。

resume/continuation prompt 优先级：

1. `goal_state.pendingContinuation.prompt`
2. evaluator `nextPrompt`
3. 默认 resume prompt

`evaluator.nextPrompt` 不应作为独立来源长期悬挂。Phase 2 中 goal hook 若收到 `not_met + nextPrompt`，应先把它 materialize 为 `pendingContinuation` 或同一 turn 的 hook reject message，再由统一 scheduler/internal turn 语义消费。

如果 `/goal resume [note]` 携带 `note`，scheduler 必须在最终选择出的 continuation prompt 中追加一次性 resume note 段，或等价地在同一个 `TaskState.startInternalTurn()` internal user message 中包含它。`note` 必须带当前 `goalId`、`goalRevision` 和 `source` metadata；不得保存为新的 objective，也不得在后续自动 continuation 中重复注入。

默认 resume prompt：

```text
<system-reminder>
继续推进当前 goal。

Goal objective:
...

Success criteria:
...

请根据当前上下文继续执行，直到满足 goal 或遇到需要用户介入的 blocker。
</system-reminder>
```

### 7.3 lease

MVP 的 lease 只保证同一 OpenDesk 进程内防重。跨 GUI/TUI/CLI 多进程同时 resume 同一个 task 不在 MVP 支持范围内；如果未来支持多进程共享同一个 task 目录并同时操作同一个 goal，必须引入文件锁、CAS lease 或等价的跨进程原子协调机制。

```ts
export interface GoalSchedulerLease {
    id: string;
    acquiredAt: string;
    expiresAt: string;
    reason: 'create' | 'resume' | 'continuation' | 'hook';
}
```

`GoalSchedulerLease` 的结构应与第 4.8 节保持一致；这里重复展示是为了强调 reason 必须覆盖 create/start、resume、hook continuation 等所有 scheduler 入口。在同一进程内，如果 lease 未过期，重复 `/goal resume` 不应启动第二个 turn。`goal_state.schedulerLease` 在 MVP 中是 UI/调试可见的调度状态，不是跨进程互斥锁。

## 8. Finish Hook 集成

### 8.1 短期实现：兼容现有二值 hook

MVP 不强制重构 `FinishTurnFeedback`。goal hook 可以用现有协议表达：

- met：写入 `complete`，返回 `finish`。
- blocked：写入 `blocked`，返回 `finish`。
- budget_limited：写入 `budget_limited`，返回 `finish`。
- not_met 且立即继续：写入 evaluation，创建 continuation，返回 `reject`，message 为 continuation prompt。
- not_met 但需要暂停或等待：写入 `pendingContinuation`，返回 `finish`。
- paused/cleared：跳过 evaluator，返回 `finish`。

这种方式把结构化状态保存在 `goal_state`，而不是试图让 hook return type 表达全部语义。

### 8.2 Hook 顺序

goal hook 必须在 todo/interruption hook 之后运行。

必须改造 `HookRegistry.beforeFinishTurn` 和 task-local `TaskHooks.beforeFinishTurn` 支持 priority 或 phase，不能依赖 import/register 顺序。现有 hook 系统会先执行 task-local hook，再执行全局 HookRegistry；单纯控制全局 hook 注册顺序无法保证 goal evaluator 一定晚于所有 hard guard。

```ts
beforeFinishTurn(callback, { priority: 300, phase: 'goal_evaluation' });
```

建议优先级：

```text
100 hard guard
200 todo / interruption guard
300 goal evaluation
900 fallback observers
```

`TaskHooks.checkBeforeFinishTurn()` 应把 task-local 和 global hook 合并为同一有序链，或至少保证 phase 的全局顺序覆盖两层 hook。Phase 2 不应在缺少 priority/phase 的情况下接入 goal evaluator。

### 8.3 Goal hook 伪代码

```ts
HookRegistry.beforeFinishTurn(async (task) => {
    if (task.parent_id !== null) return { operation: 'finish' };

    const goal = task.goal_state;
    if (!goal) return { operation: 'finish' };
    if (goal.status === 'cleared' || goal.status === 'complete') return { operation: 'finish' };

    if (goal.status !== 'active') {
        return { operation: 'finish' };
    }

    let evaluation: GoalEvaluation;
    try {
        evaluation = await GoalEvaluator.evaluate(task, goal);
    } catch (error) {
        GoalController.recordEvaluatorFailure(task, goal, error);
        return { operation: 'finish' };
    }

    const currentGoal = task.goal_state;
    if (
        !currentGoal ||
        currentGoal.id !== goal.id ||
        currentGoal.revision !== goal.revision ||
        currentGoal.status !== 'active'
    ) {
        return { operation: 'finish' };
    }

    const result = GoalController.recordEvaluation(task, evaluation);

    if (result.action === 'finish') {
        return { operation: 'finish' };
    }

    return { operation: 'reject', message: result.continuationPrompt };
});
```

## 9. GoalEvaluator

GoalEvaluator 是只读 evaluator，不应让主 agent 自判完成。

### 9.1 实现方式

MVP 必须使用轻量 `LLM.askForObjectWithSchema()` 或等价的只读 LLM 调用，不创建 task runner，不进入普通 task list，不触发 finish hook、session memory、todo 或 goal hook。

不要在 MVP 中创建 internal task 保留 evaluator transcript。当前 `createTask(undefined, { internal: true })` 创建的 task 仍然是 `parent_id === null`，会被现有主任务全局 termination hook 处理；仅仅“不注册 goal hook”不足以隔离 evaluator。

如果未来确实需要 evaluator task，必须先满足：

- evaluator task 有独立 `task.kind = 'evaluator'`，或 `parent_id` 指向被评估 task。
- 全局 hook 明确跳过 `task.internal === true` 或 `task.kind === 'evaluator'`。
- evaluator task 不进入普通 task list，不触发 session memory、todo、goal hook。
- 不暴露写文件工具。
- 不继承会修改外部状态的权限。
- 使用结构化输出 schema。

### 9.2 输入

Evaluator 输入：

- 当前 `GoalState`
- 当前 `goalRevision`
- 最近 `goal_event_log`
- goal projection 后的 transcript
- `task.getTaskChanges()` 的文件变更推断
- 最近工具调用摘要
- 最近测试、构建、命令结果摘要
- `pendingContinuation` 状态
- 当前 todo 摘要

### 9.3 输出

Evaluator 必须只输出 JSON：

```json
{
    "goalId": "...",
    "goalRevision": 3,
    "status": "not_met",
    "reason": "...",
    "evidence": ["..."],
    "nextPrompt": "...",
    "evaluatedAt": "2026-06-22T09:31:00.000Z"
}
```

`nextPrompt` 只在 `not_met` 时允许出现。

### 9.4 结果应用

应用 evaluation 前必须检查：

- `evaluation.goalId === task.goal_state.id`
- `evaluation.goalRevision === task.goal_state.revision`
- `task.goal_state.status === 'active'`

任何不匹配都丢弃，不修改 goal 状态。

### 9.5 Evaluator exception policy

`GoalEvaluator.evaluate()` 的失败不能被解释为 `not_met`。`not_met` 表示 evaluator 成功判断目标尚未达成；evaluator 自身失败表示系统暂时无法可靠验收 goal。

以下情况都属于 evaluator failure：

- LLM API 超时、网络错误、限流或服务不可用。
- 模型配置缺失、模型不可用、API key/权限错误。
- `LLM.askForObjectWithSchema()` 达到结构化输出重试上限后仍失败。
- LLM 返回非 JSON、无法解析 JSON、或 JSON 不符合 schema。
- evaluator prompt 构造、projection 构造或输入摘要生成失败，导致无法发起可靠评估。

当 evaluator failure 发生时，如果当前 goal 仍是同一个 `goalId`、同一个 `revision` 且状态仍为 `active`，必须应用为 `blocked`：

```ts
GoalController.recordEvaluatorFailure(task, goal, error);
```

应用规则：

- `goal_state.status = 'blocked'`。
- `blockedReason = 'goal_evaluator_failed'`。
- 清空 `schedulerLease`。
- 不创建新的 `pendingContinuation`；如已有 pending continuation，可保留但不得自动消费。
- 写入一条合成 `lastEvaluation`：

```json
{
    "status": "blocked",
    "reason": "goal_evaluator_failed: <sanitized error summary>",
    "evidence": ["Evaluator failed before producing a valid structured result"]
}
```

- 追加 `evaluated` 或 `blocked` event，payload 中包含 sanitized error summary。
- finish hook 返回 `{ operation: 'finish' }`，停止当前自动续跑。

如果 failure 发生后 goal 已被 edit/pause/clear/resume 改变，必须按 stale evaluation 规则丢弃 failure，不修改 goal。

用户修复模型、网络、凭据或配置后，可通过 `/goal resume [note]` 继续，并用 `note` 描述已修复的外部状态。resume 必须新开 continuation turn，不重放失败的 evaluator 调用栈。

## 10. Projection 与 interlude

### 10.1 消息范围

goal 需要区分三类消息：

- `goal`：属于当前 goal 执行过程的消息。
- `interlude`：goal paused 期间用户与 agent 的普通对话。
- `global`：系统层消息、compact boundary、长期上下文等。

建议给 `UserMessage` / `AssistantMessage` 增加可选通用 metadata。该 metadata 应与第 6.2 节的 `RuntimeMetadata` 结构兼容，goal 只使用其中的 scope、origin、execution 等字段，不新增 goal 专用消息类型：

```ts
export interface MessageRuntimeMetadata {
    scope: 'goal' | 'interlude' | 'global';
    goalId?: string;
    goalRevision?: number;
    source?: 'user' | 'continuation' | 'resume' | 'hook';
}
```

实现时可以保留上面的领域视图作为 helper 类型，但持久化字段应落在通用 `metadata` 上，例如：

```ts
message.metadata = {
    scope: 'goal',
    origin: { source: 'scheduler', reason: 'goal_continuation' },
    execution: {
        controller: 'goal',
        controllerId: goalId,
        controllerRevision: goalRevision,
        continuationId
    }
};
```

消息序列化时 metadata 随 message 一起保存。旧消息没有 metadata 时按 legacy transcript 处理；goal projection 需要根据场景选择保守策略，不能假设旧消息一定属于当前 goal。

### 10.2 何时标记 interlude

当 `goal_state.status === 'paused'` 时，普通用户提交的新消息默认标记为 `interlude`。

用户执行 `/goal edit` 可修改 goal objective，但不会自动把 paused 期间的 interlude 纳入 goal。未来可新增 `/goal absorb`，显式把 interlude 消息吸收到 goal 上下文。

### 10.3 Goal projection

新增：

```ts
buildGoalContextProjection(task: TaskState, options: GoalProjectionOptions): ActiveContextView
```

规则：

- active goal 默认包含 `global + goal`。
- resume continuation 默认排除 `interlude`。
- evaluator 使用同一 projection，避免验收和续跑看到不同上下文。
- 普通用户聊天仍可看到完整 visible transcript；projection 只影响模型上下文和 evaluator 输入。

### 10.4 与 compact pipeline 的关系

当前 `prepareContextForModel()` 和 adapter 都以 active context 为基础。goal projection 应在 context preparation 层统一接入，而不是只在 adapter 层过滤。

推荐方向：

```ts
prepareContextForModel(chatContext, model, {
    activeContextOverride: GoalProjection.buildActiveContext(task)
});
```

`PrepareContextOptions` 应新增 `activeContextOverride` 或 `activeContextProvider`。compaction pipeline 内部必须统一使用该 active context，包括：

- `prepareContextForModel()` 的轻量准备层。
- tool result budget projection。
- auto compact token estimate。
- microcompact candidate analysis。
- full compact 和 session memory compact。
- adapter message 构造。

Phase 4 不允许只在 adapter 层过滤 interlude。否则 evaluator、continuation、token estimation、compact boundary 和 session memory 看到的上下文会不一致。

过滤 interlude 后还必须明确 compact boundary、message index、assistant round replay 的稳定性规则。推荐保留原始 transcript 的 message id / round ref 作为稳定引用，projection 只决定 active view，不改变底层 transcript 顺序。

### 10.5 Compact boundary provenance

compact boundary 不能被无条件视为 `global` 消息。它是某个 transcript 范围在某种 projection policy 下生成的摘要，必须带 provenance，后续 goal projection 才能判断是否可以复用。

建议扩展 `CompactSeparatorMessage.metadata`：

```ts
export interface CompactBoundaryProjectionMetadata {
    projectionPolicy: 'full_transcript' | 'goal_only' | 'mixed_scoped';
    summarizedScopes: Array<'goal' | 'interlude' | 'global'>;
    summarizedGoalIds?: string[];
    containsInterlude: boolean;
    includedScopes?: string[];
    excludedScopes?: string[];
}
```

更推荐让 compact summary 结构化分段，而不是只保存一段无法过滤的文本：

```ts
export interface CompactSummarySegment {
    scope: 'goal' | 'interlude' | 'global';
    goalId?: string;
    startMessageId?: string;
    endMessageId?: string;
    text: string;
}
```

goal projection 构造 active context 时，不应直接把原始 compact boundary 放入模型上下文，而应生成 projection 后的 boundary：

```text
for each compact boundary:
  if boundary has summarySegments:
    keep segments where scope == global
      or (scope == goal and goalId == currentGoal.id)
    drop interlude and other goal segments
    if no segment remains: omit boundary from projected context
    else create projected boundary from kept segments
  else if boundary provenance proves containsInterlude == false
    and summarizedGoalIds is empty or contains currentGoal.id:
      keep boundary
  else:
      omit boundary from goal projection
```

MVP 应采用保守策略：旧格式 boundary 或缺少 provenance 的 boundary，在 goal continuation/evaluator projection 中不信任，默认不注入。这样会牺牲部分历史上下文，但能避免 paused 期间 interlude 被 compact summary 重新带入 goal context。

未来如果要降低上下文损失，可以在 compact 时同时生成多个 projection-aware summary segment，或把 compact summary 从“transcript 里的普通消息”升级为“可按 active view 注入的上下文构件”。底层 transcript 仍保留完整历史，模型上下文由 `ActiveContextView` 决定，compact boundary 只是 active view 中可过滤的摘要节点。

## 11. 持久化

### 11.1 保存位置

完整 schema：

```json
{
  "goal_state": { ... },
  "goal_event_log": {
    "mode": "inline",
    "events": [ ... ]
  }
}
```

Phase 1/MVP 只需要写 `goal_state` 和 `goal_event_log.mode = 'inline'`，直接把完整事件数组保存在 task JSON 中，复用 `_dirty`、`save()`、`flushAllPendingSaves()`。启用 event log 体积控制后，将 `goal_event_log` 从 `inline` 迁移为 `artifact` 模式；不得新增 `goal_event_log_tail`、`goal_event_log_artifact` 等平行字段。

### 11.2 Crash/restart recovery

当前 task runner 没有恢复旧执行栈的能力。OpenDesk 进程崩溃、被 kill、系统重启或异常退出后，如果 task JSON 中的 `task_status` 仍是 `running`，`TaskState.load()` 会把该 task 视为上次运行被中断，并标记未完成工具调用为停止/错误。goal 恢复必须遵守同一语义：不恢复旧 LLM stream、工具调用或 `processTaskTurn()` 栈，只能在用户显式恢复后开启新的 continuation turn。

加载 task 时必须记录持久化状态是否为 `running`，例如：

```ts
const wasRunningAtShutdown = task_json.task_status === 'running';
```

如果 `wasRunningAtShutdown === true` 且 `goal_state.status === 'active'`：

- 将 `goal_state.status` 改为 `paused`。
- 设置 `pauseReason = 'task_restarted_after_running_interruption'`。
- 设置 `pausedAt` / `updatedAt` 为当前时间。
- 清空 `schedulerLease`。
- 保留已有 `pendingContinuation`；如果不存在，创建默认 recovery continuation，prompt 应说明“上次执行因 OpenDesk 重启/进程中断而停止，请基于当前 goal 和已有上下文继续”。
- 追加 `paused` event，`source = 'system'`，payload 包含 `reason: 'task_restarted_after_running_interruption'` 和 `wasTaskStatus: 'running'`。
- 调用 `persistLater()` 或在 load 后确保该迁移状态落盘。

恢复后的用户可见状态应是：

```text
goal_state.status = paused
task_status = stopped | failed
pendingContinuation = yes
```

这里使用 `paused`，不是 `blocked`。进程中断不是缺少用户信息、权限、凭据或外部状态变化；用户执行 `/goal resume [note]` 即可继续。

`/goal resume [note]` 必须通过 `GoalScheduler.startExecution()` 和 `TaskState.startInternalTurn()` 新开 continuation turn，不恢复旧 turn 的执行栈。默认 recovery continuation prompt：

```text
<system-reminder>
OpenDesk 上次在执行当前 goal 时异常退出或重启，旧的执行栈已经不可恢复。

Goal objective:
...

请根据当前 transcript、文件状态和 goal state 继续推进。不要假设上次中断时正在运行的 LLM stream 或工具调用仍然有效；必要时重新检查当前状态。
</system-reminder>
```

如果 `wasRunningAtShutdown === true` 但 goal 已经是 `paused | blocked | budget_limited | complete | cleared`，不得自动改回 `active`。只清理过期 `schedulerLease`，并保留原 goal status。

### 11.3 序列化

新增：

```ts
GoalStates.serialize(state);
GoalStates.deserialize(raw);
GoalEvents.serialize(events);
GoalEvents.deserialize(raw);
```

所有时间使用 ISO string。

### 11.4 Event log 上限

MVP 可限制 task JSON 中最多保留最近 200 条 event。超过后写入 artifact 文件：

```text
artifacts/<taskId>/goal/events.jsonl
```

task JSON 保留：

```ts
goal_event_log: {
    mode: 'artifact';
    tail: GoalEvent[];
    artifactPath: string;
}
```

读取规则：

1. `goal_event_log.mode === 'inline'` 时，`events` 是完整结构化 event log；status/render/load/fork/export 都从同一个 storage 入口读取。
2. `goal_event_log.mode === 'artifact'` 时，`tail` 是 task JSON 内的最近事件，`artifactPath` 指向完整历史或归档历史；status/render 默认只读 tail。
3. load 不得通过 replay event log 恢复当前 `goal_state`。event log 只用于审计、展示和修复/迁移；权威当前状态始终是 `goal_state`。
4. repair/export/fork 如需完整历史，可以读取 `artifactPath`；读取失败时必须降级为 tail，并暴露可诊断的 warning，不得阻塞 task load。
5. 兼容旧格式时，如果 load 发现 `goal_event_log` 是数组，应迁移为 `{ mode: 'inline', events }`。如果发现旧 `goal_event_log_tail` / `goal_event_log_artifact`，应迁移为 `{ mode: 'artifact', tail, artifactPath }`。迁移完成后普通 save 不得继续写旧字段。

## 12. 与现有功能的交互

### 12.1 Todo

todo guard 在 goal evaluator 前运行。todo 未完成时不调用 evaluator。

由于当前 todo 是内存 Map，goal 不应依赖 todo 作为状态源。evaluator 可以读取 todo display summary 作为辅助证据，但 goal complete 不能由 todo 状态单独决定。

### 12.2 Stop

用户执行 `/stop` 是普通 task runner 停止。它不是 goal 状态转换，也不是 agent 可以使用的能力。

当当前 task 存在 active goal 时，不支持用户可见 `/stop` 指令。`/goal pause` 代替 goal 执行过程中的 stop 语义：

- `/stop` 必须拒绝，不修改 `goal_state`，不调用 `task.stop()`。
- 拒绝提示必须说明：使用 `/goal pause` 暂停当前 goal 并停止当前 runner；使用 `/goal clear` 清除 goal 控制。
- `/goal pause` 立即将 goal 置为 `paused`，并通过 runtime interrupt 停止当前 runner。
- GUI 中如果存在 stop 按钮，在 active goal 下不得触发普通 `task.stop()`；应隐藏普通 stop、替换为 pause goal 操作，或调用 `GoalService.pause()`。

这样避免出现 `goal_state.status = active` 但 `task_status = stopped` 的用户可见状态。底层 runner interrupt 仍然保留，供 `/goal pause`、`/goal clear`、应用退出、系统恢复等路径使用。

### 12.3 Rewind

TUI `/undo`、`/redo` 以及未来任何 rewind/redo 能力不得直接 splice/push `chat_context.messages`。必须新增并使用 `TaskState.rewindMessages()` / `TaskState.redoMessages()` 或等价 history mutation API，让 goal 状态和 transcript 变更在同一入口处理。

`/goal create/edit/pause/resume/clear` 是 control plane 操作，不是普通 user message，因此不能通过“被删除消息是否包含 goal event”判断 goal 是否需要回滚。

MVP 采用保守策略：只要当前 task 存在未终结 goal（`active | paused | blocked | budget_limited`），任何 rewind/redo 都将 goal 标记为 `blocked`，reason 为 `history_rewound_requires_goal_review`，清空 `pendingContinuation` 和 `schedulerLease`，写入 `blocked` event，要求用户 `/goal edit`、`/goal resume` 或 `/goal clear` 明确处理。

### 12.4 Fork

fork task 时复制 `goal_state` 和最近 event log storage，但生成新的 `goalId` 或记录 `forkedFromGoalId`。如果源 task 是 `artifact` 模式，fork 可以只复制 `tail` 并写入新的 `forked` event；如产品要求完整审计历史，再显式读取 `artifactPath` 并为 fork task 生成新的 artifact。

推荐：

- `taskId` 更新为 forked task id。
- `goalId` 重新生成。
- `revision` 保留。
- `schedulerLease` 清空。
- unfinished goal（`active | paused | blocked | budget_limited`）fork 后转为 `blocked`，`blockedReason = 'forked_history_requires_goal_review'`，清空 `pendingContinuation`。`complete | cleared` 保留原 status。
- 写入 `forked` event。

### 12.5 Export

export HTML 可以展示 `GoalRenderSummary`，但不得导出完整 event log、event payload、raw evaluator evidence 或 `artifactPath`。objective、reason 等动态内容必须 HTML escape；cleared 或不存在 goal 时不展示 goal summary。

### 12.6 Subtask

默认子任务不继承父 goal，也不运行 goal hook。

父 task 的 evaluator 可把子任务结果作为证据读取。

### 12.7 Session memory

session memory 可以记录 goal 摘要和当前状态，但它不是状态源。session memory summary 如果基于包含 interlude 的上下文生成，必须带 projection provenance；goal continuation/evaluator projection 不得通过 session memory summary 间接看到 paused 期间的 interlude 内容。

## 13. Budget

Goal budget 先定义三类，字段结构见第 4.3 和第 4.8 节：

```ts
tokenBudget?: GoalTokenBudget;
maxAttempts?: number;
timeBudgetMs?: number;
```

attempt 定义为 goal evaluator 触发后产生的 continuation 次数。只读 evaluator 自身调用不计入 attempts，但 evaluator token 应计入 token budget。

MVP 可以先不强制启用 token budget：如果当前实现链路尚未稳定暴露 usage，可先让 `usedTotalTokens` 为空或只在明确可得时更新。Phase 1/2 的优先级是让 goal 状态、resume 和 evaluator 语义闭环，而不是精确做 token 计量。

触发 `budget_limited` 的顺序：

1. 检查 time budget。
2. 检查 token budget。
3. 检查 max attempts。

budget_limited 必须保留 `pendingContinuation`，方便用户在预算授权后继续。

### 13.1 budget_limited resume 策略

MVP 不允许 `/goal resume [note]` 从 `budget_limited` 直接恢复。原因是如果没有提高预算或授权 override，resume 很可能立即再次命中同一个边界，形成无意义循环；`note` 只是补充上下文，不是预算授权。

恢复策略：

- `GoalService.resume(task, { budgetOverride })` 可以从 `budget_limited` 恢复，并写入 `resumed` event，payload 记录 override 类型和 reason。
- TUI MVP 的 `/goal resume [note]` 没有预算参数；当 goal 是 `budget_limited` 时必须返回 `ok: false`，`messageKey = 'goal.resume.requires_budget_authorization'`，不启动 scheduler。
- future GUI 或 API 可以提供预算授权：增加 `maxAttempts`、增加 `timeBudgetMs`、增加 token budget，或允许一次 `oneShot` override。
- `oneShot` override 只允许消费一次 pending continuation；如果再次命中同一预算，必须重新进入 `budget_limited`。
- token usage 暂不可得时，MVP 不启用 token budget 的硬限制；不得因为 unknown usage 把 goal 标为 `budget_limited`。

现有 `processTaskTurn()` 的 10 次 hook reject 仍是 runner safety cap，不是 goal attempt 计数；它只是兜底防止 finish hook 循环，不应被当作 goal 预算语义的一部分。

goal 的 `maxAttempts` 应在创建新的 continuation 前检查，因此正常情况下应先产生 `budget_limited`，而不是撞到 10 次 hook reject safety cap。若 safety cap 仍被触发，说明 hook/runner 进入异常循环，应停止 runner 并将 goal 标为 `blocked`，`blockedReason = 'hook_reject_safety_cap'`，而不是 `budget_limited`。

## 14. 实现阶段

### Phase 1：TUI + 持久化 + 可执行 MVP

目标：

- 新增 `goal_state`、`goal_event_log`。
- 新增 `GoalController`。
- 新增共享 `GoalService` 或等价入口，避免 TUI/GUI/API 各自实现 runner 中断。
- 新增 `GoalScheduler`。
- 新增 `/goal` TUI command。
- `/goal <objective>`、`status`、`edit`、`pause`、`resume`、`clear` 可用。
- `resume [note]` 可通过 scheduler 消费 continuation 或生成默认 goal resume prompt，并通过 `TaskState.startInternalTurn()` 启动；`note` 只注入本次 continuation，不修改 goal objective。
- `pause` 立即进入 `paused`，并通过 runtime interrupt best-effort 停止当前 runner。
- 同进程 scheduler lease 防止同一 OpenDesk 进程内重复 create/resume/continuation 启动。

不做：

- evaluator
- 自动续跑
- interlude projection

### Phase 2：finish hook + evaluator

目标：

- 注册 goal finish hook。
- todo/interruption guard 先运行，goal evaluator 后运行。
- evaluator 输出结构化 JSON。
- met/blocked/budget_limited/not_met 可写入 goal state。
- not_met immediate continuation 可用当前 `reject` 协议继续。

### Phase 3：blocked 普通消息恢复 + scheduler 加固

目标：

- blocked 状态下，明确的普通对话恢复意图可触发同一套 resume/scheduler 流程。
- blocked 状态下，无关普通消息采用统一 `ignore_and_reject` 策略，不由 TUI/GUI/ACP/opencode 各自决定。
- 补齐 scheduler lease 的过期清理、reason 审计和同进程重复入口测试。
- 补齐 `budget_limited` 的预算授权入口；`/goal resume [note]` 在预算未变化时必须拒绝。
- 对 pause runtime interrupt 尚未收尾时的 resume 做并发防护和用户提示加固。

### Phase 4：projection + interlude

目标：

- message metadata 支持 `goal/interlude/global`。
- paused 期间普通聊天默认标记 interlude。
- resume/evaluator 默认排除 interlude。
- compact/token estimation/evaluator/adapter 使用一致 projection。

### Phase 5：GUI IPC 与可视化

目标：

- `taskManager:getGoalStatus`
- `taskManager:createGoal`
- `taskManager:editGoal`
- `taskManager:pauseGoal`
- `taskManager:resumeGoal`
- `taskManager:clearGoal`
- renderer 展示 goal badge 和 status panel。

### 14.6 Phase 5 GUI 实现细节

#### 14.6.1 触发方式

Goal 不设 GUI 操作按钮（工具栏、侧边栏、输入区等均无按钮入口）。唯一触发方式为 **自然语言关键词**：用户在聊天中输入的 goal-like intent 由 AI kernel 检测，经过确认弹窗后创建。

绕过确认弹窗的方式：`/goal "目标描述"` 斜杠命令直接创建，不走弹窗流程。

#### 14.6.2 确认弹窗

直接复用 `confirmModal.ts` 的 `showConfirmModal`，不做任何 UI 定制：

```typescript
import { showConfirmModal } from './confirmModal.ts';

const confirmed = await showConfirmModal({
    icon: 'fa-bullseye',
    iconBg: '#E6F1FB',
    iconColor: '#378ADD',
    title: '启用 Goal 机制？',
    message: `检测到任务目标：<strong>${escapeHtml(objective)}</strong>。<br /><br />Goal 机制将在每次 AI 回复后自动评估目标是否达成，并在预算上限时自动暂停。`,
    confirmText: '启用',
    cancelText: '取消'
});
```

#### 14.6.3 触发流程

```
用户输入 "帮我重构认证模块..."
         │
         ▼
AI Kernel 处理用户消息
检测到 goal-like intent（LLM 输出 createGoal 工具调用，source === 'chat'）
         │
         ▼
拦截 createGoal 调用
不立即执行，改为向 GUI 发送 IPC 事件 'goal:requestConfirmation'
         │
         ▼
渲染进程弹出 showConfirmModal 确认弹窗
         │
     用户取消    用户确认
         │          │
         ▼          ▼
     放弃创建    创建 Goal（source: 'gui_confirm'）
                      │
                      ▼
               Goal Scheduler 启动执行
                      │
                      ▼
              右侧栏"任务计划"tab 底部出现 Goal section
              自动展开右侧栏并切换到"任务计划"tab
```

#### 14.6.4 右侧栏展示位置

Goal 执行信息集成在 `<task-artifacts>` 的"任务计划"tab 内，位于任务级待办列表下方，用浅灰色分割线隔开。不新增独立 tab。

```
<task-view>
  ├── 左侧: 聊天历史 + agent input
  └── 右侧: <task-artifacts>
       ├── 任务计划 (dynamic)
       │   ├── [任务级待办]         ← 已有
       │   ├── [Global 待办]        ← 已有
       │   └── [Goal section]       ← 🆕 仅 goal 活跃时显示
       ├── 工作空间
       ├── 浏览器
       ├── 变更
       └── 任务记忆 (dynamic)
```

#### 14.6.5 Goal section 渲染内容

每个区域按顺序从上到下渲染：

| 区域             | 内容                                                                  | 说明                                                   |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Header           | 状态徽章（颜色编码 + 圆点指示器）+ revision 号 + Pause/Clear 操作按钮 | 按钮仅在 goal 非 terminal 时显示                       |
| Objective        | 目标描述文本                                                          | 点击可 inline 编辑，切换为 textarea + Cancel/Save 按钮 |
| Progress         | Attempts 和 Tokens 双指标进度条                                       | 实时更新                                               |
| Success criteria | 可勾选的 chips 列表                                                   | 已完成 criterion 用 ✓ 前缀                             |
| Evaluation       | 蓝色信息栏：最近一次评估结果 + 原因 + 时间戳                          | 仅在存在 lastEvaluation 时显示                         |
| Continuation     | 琥珀色警告栏：pending continuation 提示                               | 仅在 pendingContinuation 存在时显示                    |
| Timeline         | 折叠式 `<details>` 事件历史列表                                       | 展示最近 goal_event_log 中的事件                       |

#### 14.6.6 状态颜色映射

| 状态             | 语义色 | 色值 (bg/fg/border)               |
| ---------------- | ------ | --------------------------------- |
| `active`         | 绿色   | `#EAF3DE` / `#3B6D11` / `#97C459` |
| `paused`         | 琥珀色 | `#FAEEDA` / `#854F0B` / `#FAC775` |
| `blocked`        | 红色   | `#FCEBEB` / `#A32D2D` / `#F09595` |
| `budget_limited` | 琥珀色 | `#FAEEDA` / `#854F0B` / `#FAC775` |
| `complete`       | 绿色   | `#EAF3DE` / `#3B6D11` / `#97C459` |
| `cleared`        | 灰色   | `#F1EFE8` / `#5F5E5A` / `#B4B2A9` |

#### 14.6.7 Goal section 可见性规则

| 条件            | 行为                                                                 |
| --------------- | -------------------------------------------------------------------- |
| Goal 首次创建   | 自动展开右侧栏，切换到"任务计划"tab，goal section 出现在待办列表下方 |
| Goal 执行中     | Goal section 保持可见，随 `reload()` 自动更新                        |
| Goal 完成或清除 | Goal section 保留 30 秒显示已完成状态后自动移除                      |
| 无 Goal         | Goal section 不渲染，`_renderTaskPlanPanel()` 恢复现有行为           |

#### 14.6.8 Objective inline 编辑

用户点击 goal section 中的 objective 文本，原地切换为编辑模式：

- 渲染模式：`<div>` 显示 objective 文本，点击触发编辑
- 编辑模式：`<textarea>` + [Cancel] [Save] 按钮
- 保存：调用 `window.taskManagerAPI.editGoal(taskId, newText)`，成功后 `reload()`
- 取消：恢复渲染模式，不修改

#### 14.6.9 状态同步机制

`taskview.js` 的 `reload()` 负责将 goal 状态传递给 `<task-artifacts>`：

```typescript
// taskview.js 中
async reload() {
    const task_state = await window.taskManagerAPI.getTaskState(this.task_id);
    this._currentGoal = task_state.goal || null;

    const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
    if (artifacts && typeof artifacts.setGoalState === 'function') {
        artifacts.setGoalState(this._currentGoal);
    }
}
```

`task-artifacts` 收到 goal 状态后：

```typescript
// taskartifacts.ts
private _goalState: GoalState | null = null;

setGoalState(goal: GoalState | null) {
    this._goalState = goal;
    const hasActiveGoal = goal && goal.status !== 'cleared';

    if (hasActiveGoal) {
        if (!this._taskPlanVisible) {
            this._taskPlanVisible = true;
            this._rebuildTabBar();
        }
        this._expandParentSidebar();
        this._switchTab('task-plan');
    }
    this._renderTaskPlanPanel(); // 内部追加 goal section
}

// 修改 _renderTaskPlanPanel()，在待办列表底部追加 goal section
private _renderTaskPlanPanel(): void {
    // ... 现有 todo 渲染逻辑不变 ...
    if (this._goalState) {
        panel.innerHTML += this._renderGoalSection(this._goalState);
    }
}
```

#### 14.6.10 需要修改的文件

| 文件                                         | 修改内容                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/renderer/preload.js`                    | 新增 `confirmGoalCreation(taskId, { confirmed, objective })` IPC 暴露                                           |
| `src/renderer/components/taskartifacts.ts`   | `_renderTaskPlanPanel()` 底部追加 goal section，新增 `setGoalState()`、`_renderGoalSection()`、inline edit 逻辑 |
| `src/renderer/components/taskview.js`        | 监听 `goal:requestConfirmation` 事件，调用 `showConfirmModal`；`reload()` 中传递 goal 给 task-artifacts         |
| `src/main/aikernel/goal/service.ts`          | 拦截 source='chat' 的 createGoal，发送确认请求，不直接执行                                                      |
| `src/main/aikernel/goal/state.ts`            | 扩展 `GoalEvent['source']` 新增 `'gui_confirm'`                                                                 |
| `src/main/main.ts`                           | 新增 `goal:requestConfirmation` IPC handler                                                                     |
| `src/locale/zh-cn.ts`, `src/locale/en-us.ts` | 新增确认弹窗相关文本                                                                                            |

不需要修改的文件：`sidebar.js`、`agentinput.js`、`homepage.js`、`shortcutManager.ts`（所有 GUI 按钮触发均去掉）。不需要新增独立的 `goalui.ts` Web Component 文件。

#### 14.6.11 不需要修改的文件

- `sidebar.js` — 不在侧边栏添加 goal badge 或按钮
- `agentinput.js` / `slash-command.ts` — 不在输入区添加 goal 按键
- `homepage.js` — 不添加 CTA
- `shortcutManager.ts` — 不注册快捷键
- `confirmModal.ts` — 直接复用，不做任何修改
- 无新增 Web Component 定义

## 15. 关键文件

新增：

```text
src/main/aikernel/goal/state.ts
src/main/aikernel/goal/controller.ts
src/main/aikernel/goal/service.ts
src/main/aikernel/goal/evaluator.ts
src/main/aikernel/goal/scheduler.ts
src/main/aikernel/goal/projection.ts
src/main/aikernel/goal/hooks.ts
src/main/tui/commands/goal.ts
```

不再新增独立的 GUI Web Component 文件（`goalui.ts`）。Goal GUI 修改直接集成在现有组件中：

- 确认弹窗复用 `src/renderer/components/confirmModal.ts`
- Goal section 渲染集成在 `src/renderer/components/taskartifacts.ts` 的 `_renderTaskPlanPanel()` 中

需要修改：

```text
src/main/main.ts
src/main/aikernel/states/tasks.ts
src/main/aikernel/messages.ts
src/main/aikernel/hooks.ts
src/main/aikernel/llm.ts
src/main/aikernel/planning/harness.ts
src/main/aikernel/compaction/context-view.ts
src/main/aikernel/compaction/pipeline.ts
src/main/aikernel/compaction/full-compact.ts
src/main/aikernel/compaction/session-memory-compact.ts
src/main/aikernel/compaction/tool-results.ts
src/main/aikernel/compaction/microcompact.ts
src/main/aikernel/compaction/auto-compact.ts
src/main/aikernel/adapters/context.ts
src/main/tui/commands/index.ts
src/main/tui/commands/stop.ts
src/locale/zh-cn.ts
src/locale/en-us.ts
src/renderer/preload.js
src/renderer/components/taskview.js
src/renderer/components/taskartifacts.ts
```

不再需要修改 `src/renderer/components/sidebar.js`（不添加 sidebar goal badge）。

Phase 1 只需要修改：

Phase 1 只需要修改：

```text
src/main/aikernel/states/tasks.ts
src/main/aikernel/messages.ts
src/main/aikernel/hooks.ts
src/main/aikernel/goal/state.ts
src/main/aikernel/goal/controller.ts
src/main/aikernel/goal/service.ts
src/main/aikernel/goal/scheduler.ts
src/main/tui/commands/goal.ts
src/main/tui/commands/index.ts
src/main/tui/commands/stop.ts
src/locale/zh-cn.ts
src/locale/en-us.ts
```

Phase 2 额外关注：

```text
src/main/aikernel/hooks.ts
src/main/aikernel/llm.ts
src/main/aikernel/goal/evaluator.ts
src/main/aikernel/goal/hooks.ts
```

Phase 4 额外关注：

```text
src/main/aikernel/messages.ts
src/main/aikernel/compaction/context-view.ts
src/main/aikernel/compaction/pipeline.ts
src/main/aikernel/compaction/full-compact.ts
src/main/aikernel/compaction/session-memory-compact.ts
src/main/aikernel/compaction/tool-results.ts
src/main/aikernel/compaction/microcompact.ts
src/main/aikernel/compaction/auto-compact.ts
src/main/aikernel/adapters/context.ts
```

## 16. 验收标准

### Phase 1 验收

- 裸 `/goal` 和 `/goal    ` 显示 goal 指令帮助，不创建 goal。
- `/goal 修复导出问题` 后，task JSON 中出现 `goal_state`，并通过 scheduler 启动一个 internal goal turn；start prompt 使用默认 goal start prompt，metadata 带 `goalId/revision`，lease reason 为 `create`。
- `GoalController`、`GoalService`、`GoalCommandResult`、`GoalRenderSummary` 等最小 API 契约存在；TUI edit 调用 `GoalService.edit()`，不直接改 `task.goal_state`。
- `/goal edit    ` 拒绝空 objective，并显示 goal 指令帮助；不得修改 revision、evaluation 或 continuation。
- `/goal status` 能展示 objective、status、revision。
- `/goal edit ...` 后 revision 增加，旧 evaluation/continuation 被清理。
- running active goal 上 `/goal edit ...` 注入 internal reminder；旧 revision tool call 在权限检查前被标记为 `stale_goal_revision` 并跳过，不弹 permission prompt。
- `/goal pause` 立即将 goal 标记为 `paused`，并在 task running 时触发 runtime interrupt。
- `/goal pause 任意内容` 被拒绝，不修改 goal，并提示使用 `/goal resume [note]` 在恢复时补充上下文。
- `/goal resume` 在没有 `pendingContinuation` 时生成默认 resume prompt，并通过 `TaskState.startInternalTurn()` 启动新的 continuation turn。
- `/goal resume` 在存在 `pendingContinuation` 时只消费一次该 continuation，并记录 consumed 状态。
- `/goal resume 我已经修改了网络状态，重新尝试搜索` 将 note 写入 `resumed` event payload，并只注入本次 continuation internal turn；不修改 objective、successCriteria、revision 或 editHistory。
- `/goal clear` 将 goal 置为 `cleared`，清空 `pendingContinuation` 和 `schedulerLease`；如果 task 正在 running，触发 runtime interrupt。
- `/goal pause` 和 `/goal clear` 的 interrupted turn 不触发 session memory compact、task review、goal evaluator 或普通 completion observer，除非 hook 显式 opt in interrupted turn。
- active goal 下 `/stop` 被拒绝，提示使用 `/goal pause`；不得调用普通 `task.stop()`，不得留下 `active + stopped`。
- `waiting` task 状态组合按 invariant 规范化：`active+waiting` 不可稳定存在，`paused/blocked/budget_limited+waiting` 加载或修复后转为 `stopped`。
- TUI goal help/status/error 文案使用 `goal.*` locale key；不得硬编码用户可见英文/中文。
- 重启 OpenDesk 后 `/goal status` 仍能展示同一 goal。
- 如果重启前 task JSON 是 `running` 且 goal 是 `active`，重启加载后 goal 进入 `paused`，保留或创建 `pendingContinuation`，`/goal resume` 通过新 continuation turn 继续。

### Phase 2 验收

- `HookRegistry.beforeFinishTurn` 与 task-local `TaskHooks.beforeFinishTurn` 支持 priority/phase，goal hook 不依赖 import/register 顺序。
- task-local hook、hard guard、todo guard、interruption guard 都稳定早于 goal evaluator。
- todo 未完成时不会调用 goal evaluator。
- todo 完成后才触发 goal evaluator。
- paused/cleared/complete goal 跳过 evaluator。
- evaluator 返回 met 时 goal 进入 complete。
- evaluator 返回 not_met 且 nextPrompt 存在时，task 继续执行。
- evaluator 返回 blocked 时，task 停止但 goal 状态为 blocked。
- evaluator 返回 budget_limited 时，task 停止但 goal 状态为 `budget_limited`，并保留可恢复 continuation。
- evaluator 抛错、LLM 超时、结构化输出解析失败或 schema 校验失败时，goal 进入 `blocked`，`blockedReason = 'goal_evaluator_failed'`，不创建新的 continuation。
- evaluator failure 通过 `GoalController.recordEvaluatorFailure()` 应用；stale failure 不修改当前 goal。
- revision 过期的 evaluator 结果不会修改 goal。

### Phase 3 验收

- goal 为 blocked 时，用户输入“继续”或“重试”能恢复为 active 并继续执行。
- blocked 状态下无关普通消息采用 `ignore_and_reject`，不提交普通 turn，不恢复 goal。
- goal 为 budget_limited 时，用户输入“继续”不会恢复执行；`/goal resume [note]` 也会拒绝，直到提供预算授权或预算调整。
- 同一进程内重复 `/goal resume` 不会启动两个并发 turn。
- pause 中断尚未收尾时，resume 不会启动第二个 runner。
- scheduler lease 过期清理、reason 审计和 stale lease 修复行为可观察、可测试。

### Phase 4 验收

- paused 期间普通聊天被标记为 interlude。
- resume 默认不把 interlude 送入 goal continuation 上下文。
- evaluator 与 continuation 使用同一 projection。
- compact 后 goal state 仍以 task JSON 为准。
- paused/interlude 内容先被 full compact 或 session memory compact 后，resume/evaluator 的 goal projection 仍不得看到 interlude summary。
- compact/token estimation/adapter 使用同一 goal projection。

### Phase 5 验收

- GUI IPC 的 get/create/edit/pause/resume/clear 都通过共享 `GoalService` 或等价入口，不直接修改 `task.goal_state`。
- GUI `pauseGoal` 与 TUI `/goal pause` 一样通过 runtime interrupt 停止当前 runner。
- GUI `clearGoal` 与 TUI `/goal clear` 一样通过 runtime interrupt 停止当前 runner。
- active goal 下 GUI 普通 stop 不调用 `task.stop()`；应隐藏/替换为 pause goal 操作，或调用 `GoalService.pause()`。
- `getFullTask()` 和 task list 返回 renderer 可展示的 goal summary。
- 关键字触发 goal 时，弹出确认弹窗（复用 `showConfirmModal`），包含 goal objective 信息和"启用"/"取消"按钮。
- 用户确认后 goal 创建，source 标记为 `'gui_confirm'`。
- 用户取消后不创建 goal，不启动 scheduler。
- 右侧栏"任务计划"tab 在 goal 活跃时底部展示 goal section，包含状态徽章、objective、progress bar、criteria、eval 结果、timeline。
- Goal section 与待办列表之间用分割线隔开，在同一个 tab 内。
- 点击 objective 文本可 inline 编辑，支持 textarea + 取消/保存。
- goal 完成或清除后 30 秒内自动移除 goal section。
- 无 goal 时右侧栏"任务计划"tab 恢复到现有行为，不显示空白 goal 区域。
- GUI/renderer 所有 goal 用户可见文案通过 locale key 输出。

### 跨阶段/机制验收

以下机制不强制归入单一 phase；一旦对应功能被实现或改动，必须同时满足：

- Rewind/redo：当前 task 存在未终结 goal 时，任何 rewind/redo 都将 goal 转为 `blocked`，reason 为 `history_rewound_requires_goal_review`，并清空 `pendingContinuation` 和 `schedulerLease`。
- Fork：fork 后复制 goal 摘要和最近 event log storage，更新 `taskId`，生成新 `goalId` 或记录 `forkedFromGoalId`，清空 `schedulerLease`，写入 `forked` event。
- Export：HTML export 可以展示 goal summary，但不得导出完整 event log；cleared 或不存在 goal 时不展示 goal summary。
- Budget：预算能力启用时，按 time budget、token budget、max attempts 的顺序触发 `budget_limited`；`budget_limited` 必须保留 continuation，`/goal resume [note]` 无预算授权时拒绝，授权后才能继续。
- Event log 上限：超过 task JSON 保留上限时，`goal_event_log` 必须迁移为 `artifact` 模式；`tail` 和 `artifactPath` 必须可被 load/status/export 读取；status/render 默认只读 tail，repair/export/fork 可读取 artifact，load 不依赖 replay event log 恢复当前状态。
- API consistency：TUI、GUI IPC、ACP/opencode 普通 submit 都通过共享 `GoalService`/`TaskState.submitUserMessage()` 入口，不复制 blocked 恢复、runtime interrupt 或 scheduler 逻辑。

## 17. 测试看护矩阵

spec 中每个机制都必须有对应测试。新增或修改机制时，同步补充以下测试矩阵：

| 机制                        | 测试要求                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 数据模型与持久化            | 覆盖 create/edit/pause/clear、revision、`GoalEventLogStorage` 的 `inline/artifact` 两种模式、旧数组/旧 tail+artifact 字段迁移、render summary 字段白名单、fork/load/save，以及 running task crash/restart 后 active goal 转 paused。                                                                   |
| TUI 指令                    | 覆盖裸 `/goal` 和 `/goal    ` 帮助、拒绝空 objective、`/goal <objective>`、`status/edit/pause/resume/clear`、`/goal pause` 拒绝参数、`/goal resume [note]` 保留原始 note、active goal 下 `/stop` 拒绝、`budget_limited` 的 `/goal resume [note]` 拒绝，以及不存在 `create/criteria` 子命令。           |
| Controller/Service API      | 覆盖 `GoalService.edit()`、`GoalController.recordEvaluatorFailure()`、`GoalCommandResult`、`GoalRenderSummary`、GUI/TUI/API edit 不绕过 Service，接口返回 messageKey 而非硬编码文本。                                                                                                                  |
| Controller 状态机           | 覆盖非法创建、complete/cleared 后创建新 goal 生成新 `goalId`、paused edit 不自动 resume、running active edit 注入 reminder 且 stale tool call 不执行、blocked ignore_and_reject、budget_limited 需授权 resume、clear 不删除历史。                                                                      |
| Task/Goal 状态一致性        | 覆盖 `waiting` 组合规范化、`active+running` 正常执行、`paused+running` 只允许中断收尾、`blocked/budget_limited+running` 不自动续跑、crash recovery 修复 `active+running-at-shutdown`、active goal 下 `/stop` 被拒绝且不留下 `active+stopped`。                                                         |
| Scheduler                   | 覆盖 create/start 默认 prompt、lease reason `create/resume/continuation/hook`、pendingContinuation 消费、默认 resume prompt、resume note 一次性注入且不修改 objective/revision、同进程 lease 防重、pause interrupt 收尾期间不启动第二 runner、internal user message metadata。                         |
| Runtime metadata            | 覆盖 `UserMessage`、`AssistantMessage`、`ToolCall` 的通用 metadata 序列化/反序列化、旧数据兼容、goal execution controllerId/controllerRevision 写入，以及 metadata 可被权限、工具执行、projection 读取。                                                                                               |
| Runtime interrupt           | 覆盖 `/goal pause` 立即 paused、`/goal clear` 立即 cleared、permission prompt cancel、running tool best-effort stop、中断后不进入 todo/interruption/goal evaluator、afterFinish/session memory/task review 默认跳过、opt-in interrupted hook 可运行、active goal 下 `/stop` 拒绝并提示 `/goal pause`。 |
| Stale tool call guard       | 覆盖 stale goal revision 在权限检查前被跳过、权限确认后执行前再次被跳过、跳过结果写入 transcript、已经 running 的工具只 best-effort stop 且不承诺回滚外部副作用。                                                                                                                                      |
| Finish hook                 | 覆盖 priority/phase 排序、task-local 与 global hook 合并顺序、todo/interruption guard 先于 goal evaluator、paused/cleared/complete 跳过 evaluator、met/not_met/blocked/budget_limited 应用。                                                                                                           |
| Evaluator                   | 覆盖结构化 JSON 解析、schema 不匹配、非 JSON、LLM timeout/model missing、stale revision 丢弃、stale failure 不修改 goal、LLM 失败转 blocked、failure 后不创建 continuation、sanitized error summary。                                                                                                  |
| Projection/interlude        | 覆盖 message metadata 序列化、paused 普通消息标记 interlude、blocked 无关消息在 MVP 被拒绝、resume/evaluator 排除 interlude、普通聊天可见完整 transcript。                                                                                                                                             |
| Compact boundary provenance | 覆盖 compact boundary projection metadata、summary segments 过滤、interlude segment 不进入 goal projection、其他 goalId 的 summary 不进入当前 goal projection、旧 boundary 或缺少 provenance 的 boundary 在 goal projection 中默认不注入、session memory summary 不泄漏 interlude。                    |
| Compact/token estimation    | 覆盖 `prepareContextForModel`、tool result budget projection、auto compact token estimate、microcompact candidate analysis、full compact/session memory compact、adapter 使用同一 goal projection。                                                                                                    |
| Rewind/fork/export          | 覆盖 rewind 后 blocked、redo 后 blocked 策略、fork 复制并换 goalId 或记录 fork 来源、fork 清 lease、export 只展示 `GoalRenderSummary` 且不导出完整 event log/`artifactPath`/raw evidence。                                                                                                             |
| Budget                      | 覆盖 time/token/maxAttempts 顺序、token budget 不可得时的 MVP 行为、budget_limited 保留 continuation、普通“继续”不能恢复 budget_limited、`/goal resume [note]` 无授权时拒绝、budgetOverride/oneShot 后只恢复一次。                                                                                     |
| Localization                | 覆盖 TUI help/status/error、GUI button/panel、renderer badge/export 标签都使用 `goal.*` locale key；event type/protocol enum/test fixture 不需要本地化。                                                                                                                                               |
| GUI IPC                     | 覆盖 get/create/edit/pause/resume/clear 都代理到共享 goal 入口，`pause/clear` 触发 runtime interrupt，active goal 下 GUI 普通 stop 不调用 `task.stop()`，blocked 恢复入口与 TUI/ACP/opencode 一致。                                                                                                    |
| Renderer 可视化             | 覆盖 keyword 触发弹窗（复用 `showConfirmModal`）、"任务计划"tab 内的 goal section 状态徽章颜色、progress bar、inline edit 保存/取消、goal section 30 秒清除、无 goal 时 tab 恢复原样、HTML escape、summary 不暴露 event payload/raw evidence/`artifactPath`。                                          |

不能为了通过测试把多个机制合并成一个大断言。每个机制至少要有一个能在行为回退时失败的测试用例。
