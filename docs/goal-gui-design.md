# Goal 机制 GUI 设计方案

> 当前实现：GUI 的 Goal 信息和 TodoWrite 集成在右侧栏「任务进展」tab 内；TodoWrite 永远在上，Goal 跟进层在下。无 Goal 但已有 TodoWrite 时，面板内提供轻量提示，用户可选择把当前待办设为跟进目标。

---

## 1. 设计原则

| 项目     | 当前方案                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------- |
| 触发方式 | 输入区 Goal 按钮触发，不从普通 prompt 或模型工具调用隐式创建 goal                                   |
| 创建流程 | 右侧栏展开 -> 「任务进展」tab -> 创建表单 -> `taskManager:createGoal`；已有未清除 goal 时提示先清除 |
| 展示位置 | 集成在右侧栏「任务进展」tab 内，TodoWrite 在上，Goal 跟进层在下                                     |
| 展示组件 | 作为 `<task-artifacts>` 的 `_renderTaskPlanPanel()` section 渲染，无新增 Web Component              |
| 状态同步 | full task load 和运行期 `getGoalStatus()` 都传递带当前 goal event summary 的 `GoalRenderSummary`    |

---

## 2. 触发流程

```text
用户点击输入区 Goal 按钮
         |
         v
右侧栏展开，切换到「任务进展」tab
         |
         v
显示 Goal 创建表单（objective）
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
       「任务进展」tab 显示当前待办和 Goal 跟进
       左侧任务列表显示从 goal objective 派生的任务名
```

### 非入口

- 普通 prompt 或模型工具调用不触发 goal 创建。
- GUI slash command 菜单不提供 `/goal`，手动输入 `/goal ...` 不作为 GUI goal 入口执行。
- 不提供 `goal:requestConfirmation`、`confirmGoalCreation` 或等价确认弹窗桥接。

---

## 3. 右侧栏任务进展集成

### 组件关系

```text
<task-view>
  ├── 左侧: 聊天历史 + agent input
  └── 右侧: <task-artifacts>
       ├── 任务进展 (dynamic, internal id: task-plan)
       │   ├── [当前待办]                ← TodoWrite，若存在则始终显示在最上方
       │   ├── [设为目标提示 / 创建表单] ← 仅无 goal 且有 TodoWrite，或打开创建表单时显示
       │   ├── [Goal section]            ← 有 goal 时显示在 TodoWrite 下方
       │   └── [Global 待办]             ← 若存在则显示在后面
       ├── 工作空间
       ├── 浏览器
       ├── 变更
       └── 任务记忆 (dynamic)
```

`<task-artifacts>` 内部仍复用 `task-plan` tab id 和 TodoWrite 渲染路径，用户可见 tab 文案通过 locale key 显示为「任务进展」/ `Task Progress`。

### 面板可见性规则

| 条件                           | 行为                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| 只有 TodoWrite，没有 Goal      | 只显示当前待办列表；列表下方显示“设为目标 / 暂不需要”的轻提示      |
| 用户点击“设为目标”             | 提示条原地展开为创建目标表单，位置仍在 TodoWrite 下方              |
| 用户点击 Goal 按钮但尚未创建   | 自动展开右侧栏，切换到「任务进展」tab，创建表单出现在待办列表下方  |
| Goal 首次创建                  | TodoWrite 保持在上方，Goal section 出现在下方                      |
| Goal 执行中                    | Goal section 保持可见，随 task update / `getGoalStatus()` 自动更新 |
| Goal blocked / paused 等未清除 | 再次点击 Goal 按钮只提示先清除目标后再创建，不显示新的创建表单     |
| Goal 完成或清除                | 若还有 TodoWrite，TodoWrite 仍在上方；终态 Goal 在下方弱化保留     |
| TodoWrite 刷新                 | 只局部更新待办列表，不能替换正在编辑中的 Goal 表单                 |
| 无 Goal 且未打开创建表单       | Goal section 不渲染，`_renderTaskPlanPanel()` 恢复现有行为         |

### 渲染内容

| 区域             | 内容                                                   | 说明                                                                                              |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Header           | 状态徽章 + revision + Edit/Pause/Resume/Clear 操作按钮 | 按 goal status 过滤可用按钮                                                                       |
| Objective        | 目标描述                                               | 点击 objective 后进入 inline edit；保存调用 `editGoal(taskId, objective)`                         |
| Progress         | Attempts 指标                                          | 运行期通过 `getGoalStatus()` 刷新                                                                 |
| Success criteria | chips 列表                                             | 空列表可省略                                                                                      |
| Evaluation       | 最近一次评估结果、原因、时间戳                         | 仅在存在 `lastEvaluation` 时显示                                                                  |
| Continuation     | pending continuation 提示                              | 仅在存在 pending continuation 时显示                                                              |
| Timeline         | 目标变化时间线                                         | `<details>`；保留用户展开/收起状态；优先展示 `objectiveEvents`，没有时 fallback 到 `recentEvents` |

### 轻提示文案

当只有 TodoWrite 且没有 Goal 时，当前待办列表下方显示轻提示：

- 提示：想让我持续跟进这些待办，直到确认结果完成吗？
- 主按钮：设为目标
- 次按钮：暂不需要
- 表单标题：设定跟进目标
- 表单说明：描述你希望我最终完成并确认的结果
- 表单占位：例如：完成这些待办，并确认结果可以正常使用
- 提交按钮：开始跟进

---

## 4. Timeline 数据来源

Goal timeline 使用 `GoalRenderSummary` 中的安全 event summary，不直接读取完整 `goal_event_log`。

- `recentEvents`：当前 goal 的最近 event 安全摘要。
- `objectiveEvents`：从当前 goal event log 中筛出的目标变化摘要，至少包含 `created` 和 `edited`，以及带 `objective` / `previousObjective` payload 的事件。
- GUI timeline 优先展示 `objectiveEvents`，突出 goal objective 的变化过程。
- 新建 goal 后，summary 必须按新的 `goal.id` 过滤事件，不能显示同一 task 中旧 goal 的 timeline。
- full task load 和运行期 `getGoalStatus()` 都必须通过 `GoalStates.renderSummary(goal_state, goal_event_log)` 生成 summary。不能只用 `goal_state` 刷新 goal 数据，否则运行中刷新 token/progress 时会丢失 timeline。

---

## 5. 左侧栏任务名

GUI 创建 goal 时，如果 task 原本没有名称，或仍为 legacy fallback `未命名任务` / `Unnamed Task`，主进程会用 goal objective 派生一个简短 task name，并通过 task list update 刷新左侧栏。

该行为属于 `GoalController.create()` 的共享语义，不应在 renderer 侧用临时 display fallback 单独实现，避免左侧栏、收藏列表、搜索和 task switcher 显示不一致。

左侧栏还会为 root task 显示 goal 终态标记：

- `complete` 显示本地化的 `goal.label.status.complete`。
- `blocked` 显示本地化的 `goal.label.status.blocked`。
- 标记应覆盖普通任务列表、收藏任务列表和带子任务分组的父任务 header。

---

## 6. IPC 接口

GUI Goal 管理使用现有 task manager API 暴露的共享入口：

| API                                      | 行为                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `getGoalStatus(taskId)`                  | 返回带 `recentEvents`、`objectiveEvents` 的 `GoalStatusView`     |
| `createGoal(taskId, objective, options)` | 创建 goal，source 为 `gui`，必要时派生 task name                 |
| `editGoal(taskId, objective)`            | 编辑 objective                                                   |
| `pauseGoal(taskId)`                      | 与 TUI `/goal pause` 一样通过 runtime interrupt 暂停 active goal |
| `resumeGoal(taskId, options?)`           | 恢复 paused/blocked goal                                         |
| `clearGoal(taskId)`                      | 清除 goal 并中断运行中的 goal turn                               |

所有入口必须走 `GoalService` 或等价共享入口，不得在 renderer 或 IPC handler 中直接修改 `task.goal_state`。GUI `createGoal` 不提供替换语义；当前 task 已有 active / paused / blocked goal 时返回本地化提示，要求先 clear 当前 goal。

创建新 goal 成功后会清空当前 task 的 task-local TodoWrite，并通过 `taskTodosUpdated` 刷新右侧栏，避免旧 goal 的待办事项继续显示在新 goal 下。

---

## 7. 本地化

GUI/renderer 中新增或变更的用户可见文本必须走 locale：

- 右侧栏 tab：`renderer.taskartifacts.tab.taskProgress`
- Goal 创建、编辑、按钮、badge、timeline 标签：`goal.renderer.*` / `goal.label.*`
- 动态 objective、reason、event payload 只做 HTML escape，不翻译。

内部 enum、协议字段、测试 fixture、调试日志不需要本地化。
