# Goal 机制 GUI 设计方案

> 当前实现：GUI 通过明确按钮打开 Goal 创建表单；Goal 信息集成在右侧栏「目标执行」tab 内；运行期 timeline 持续显示，并优先展示目标创建/编辑变化。

---

## 1. 设计原则

| 项目     | 当前方案                                                                                |
| -------- | --------------------------------------------------------------------------------------- |
| 触发方式 | 输入区 Goal 按钮触发，不从普通 prompt 或模型工具调用隐式创建 goal                       |
| 创建流程 | 右侧栏展开 -> 「目标执行」tab -> 创建表单 -> `taskManager:createGoal`                   |
| 展示位置 | 集成在右侧栏「目标执行」tab 内，位于待办列表上方                                        |
| 展示组件 | 作为 `<task-artifacts>` 的 `_renderTaskPlanPanel()` section 渲染，无新增 Web Component  |
| 状态同步 | full task load 和运行期 `getGoalStatus()` 都传递带 event summary 的 `GoalRenderSummary` |

---

## 2. 触发流程

```text
用户点击输入区 Goal 按钮
         |
         v
右侧栏展开，切换到「目标执行」tab
         |
         v
显示 Goal 创建表单（objective、token budget、max attempts）
         |
    用户取消      用户点击创建
         |             |
         v             v
     关闭表单     taskManager:createGoal（source: 'gui'）
                       |
                       v
                Goal Scheduler 启动执行
                       |
                       v
       「目标执行」tab 顶部显示 Goal section
       左侧任务列表显示从 goal objective 派生的任务名
```

### 非入口

- 普通 prompt 或模型工具调用不触发 goal 创建。
- GUI slash command 菜单不提供 `/goal`，手动输入 `/goal ...` 不作为 GUI goal 入口执行。
- 不提供 `goal:requestConfirmation`、`confirmGoalCreation` 或等价确认弹窗桥接。

---

## 3. 右侧栏 Goal 集成

### 组件关系

```text
<task-view>
  ├── 左侧: 聊天历史 + agent input
  └── 右侧: <task-artifacts>
       ├── 目标执行 (dynamic, internal id: task-plan)
       │   ├── [Goal section / 创建表单]  ← 有 goal 或点击 Goal 按钮时显示
       │   ├── [任务级待办]              ← TodoWrite，若存在则显示在后面
       │   └── [Global 待办]             ← 若存在则显示在后面
       ├── 工作空间
       ├── 浏览器
       ├── 变更
       └── 任务记忆 (dynamic)
```

`<task-artifacts>` 内部仍复用 `task-plan` tab id 和 TodoWrite 渲染路径，用户可见 tab 文案通过 locale key 显示为「目标执行」/ `Goal Execution`。

### Goal section 可见性规则

| 条件                         | 行为                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| 用户点击 Goal 按钮但尚未创建 | 自动展开右侧栏，切换到「目标执行」tab，创建表单出现在待办列表上方  |
| Goal 首次创建                | Goal section 出现在待办列表上方                                    |
| Goal 执行中                  | Goal section 保持可见，随 task update / `getGoalStatus()` 自动更新 |
| Goal 完成或清除              | Goal section 保留显示终态，不按 30 秒自动移除                      |
| 无 Goal 且未打开创建表单     | Goal section 不渲染，`_renderTaskPlanPanel()` 恢复现有行为         |

### 渲染内容

| 区域             | 内容                                                   | 说明                                                                               |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Header           | 状态徽章 + revision + Edit/Pause/Resume/Clear 操作按钮 | 按 goal status 过滤可用按钮                                                        |
| Objective/Budget | 目标描述、token budget、max attempts                   | 点击 objective 后进入 inline edit；保存调用 `editGoal(taskId, objective, options)` |
| Progress         | Attempts 和 Tokens 指标进度条                          | 运行期通过 `getGoalStatus()` 刷新                                                  |
| Success criteria | chips 列表                                             | 空列表可省略                                                                       |
| Evaluation       | 最近一次评估结果、原因、时间戳                         | 仅在存在 `lastEvaluation` 时显示                                                   |
| Continuation     | pending continuation 提示                              | 仅在存在 pending continuation 时显示                                               |
| Timeline         | 目标变化时间线                                         | `<details open>`；优先展示 `objectiveEvents`，没有时 fallback 到 `recentEvents`    |

---

## 4. Timeline 数据来源

Goal timeline 使用 `GoalRenderSummary` 中的安全 event summary，不直接读取完整 `goal_event_log`。

- `recentEvents`：最近 goal event 的安全摘要。
- `objectiveEvents`：从 event log 中筛出的目标变化摘要，至少包含 `created` 和 `edited`，以及带 `objective` / `previousObjective` payload 的事件。
- GUI timeline 优先展示 `objectiveEvents`，突出 goal objective 的变化过程。
- full task load 和运行期 `getGoalStatus()` 都必须通过 `GoalStates.renderSummary(goal_state, goal_event_log)` 生成 summary。不能只用 `goal_state` 刷新 goal 数据，否则运行中刷新 token/progress 时会丢失 timeline。

---

## 5. 左侧栏任务名

GUI 创建 goal 时，如果 task 原本没有名称，或仍为 legacy fallback `未命名任务` / `Unnamed Task`，主进程会用 goal objective 派生一个简短 task name，并通过 task list update 刷新左侧栏。

该行为属于 `GoalController.create()` 的共享语义，不应在 renderer 侧用临时 display fallback 单独实现，避免左侧栏、收藏列表、搜索和 task switcher 显示不一致。

---

## 6. IPC 接口

GUI Goal 管理使用现有 task manager API 暴露的共享入口：

| API                                      | 行为                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `getGoalStatus(taskId)`                  | 返回带 token usage、`recentEvents`、`objectiveEvents` 的 `GoalStatusView` |
| `createGoal(taskId, objective, options)` | 创建 goal，source 为 `gui`，必要时派生 task name                          |
| `editGoal(taskId, objective, options)`   | 编辑 objective、token budget 和 max attempts                              |
| `pauseGoal(taskId)`                      | 与 TUI `/goal pause` 一样通过 runtime interrupt 暂停 active goal          |
| `resumeGoal(taskId, options?)`           | 恢复 paused/blocked goal；budget_limited 需要显式预算授权                 |
| `clearGoal(taskId)`                      | 清除 goal 并中断运行中的 goal turn                                        |

所有入口必须走 `GoalService` 或等价共享入口，不得在 renderer 或 IPC handler 中直接修改 `task.goal_state`。

---

## 7. 本地化

GUI/renderer 中新增或变更的用户可见文本必须走 locale：

- 右侧栏 tab：`renderer.taskartifacts.tab.goalExecution`
- Goal 创建、编辑、按钮、badge、timeline 标签：`goal.renderer.*` / `goal.label.*`
- 动态 objective、reason、event payload 只做 HTML escape，不翻译。

内部 enum、协议字段、测试 fixture、调试日志不需要本地化。
