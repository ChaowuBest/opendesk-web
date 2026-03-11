# 子任务编排落地草案（OpenDesk）

本文对应当前代码中的第一阶段改造，目标是让“是否规划、规划粒度、何时开始执行”变成系统策略，而不是完全依赖模型临场发挥。

## 1. 目标

- 避免简单任务过度规划（例如把“检查文件存在”拆成独立 todo）。
- 避免复杂任务不规划直接执行。
- 在长任务里固定主目标，减少上下文漂移。
- 为后续 `createSubTask` 委派链路打基础。

## 2. 已落地改动（Phase 1）

### 2.1 新增策略模块

文件：`src/main/aikernel/planning/strategy.ts`

提供能力：
- `decideExecutionMode(...)`：执行模式判定（`none | lite | delegate`）。
- `shouldRequireInitialTodoWrite(...)`：是否强制首轮先调用 `TodoWrite`。
- `normalizeTodoWriteTodos(...)`：todo 粒度归一化（去重、去微步骤、数量上限、状态规范）。
- `buildMissionAnchor(...)`：任务锚点生成。
- `buildRuntimeExecutionPolicy(...)`：运行时策略提示文本。
- `isPlanningTool(...) / isToolAllowedBeforePlanning(...)`：规划门控辅助函数。

### 2.2 在 TaskState 注入策略门控

文件：`src/main/states/tasks.ts`

新增状态字段：
- `execution_mode`
- `mission_anchor`
- `_todoPlanInitialized`
- `_todoPlanRequired`

接入点：
- `submitUserMessage(...)`
  - 根据用户输入和工具能力判定执行模式。
  - 生成 mission anchor。
  - 计算是否强制首轮规划。
  - 把运行时策略注入 system prompt（带 start/end tag，支持替换）。
- `processToolCall(...)`
  - 调用 `TodoWrite` 时执行粒度归一化。
  - `execution_mode=none` 时，TodoWrite 自动跳过（返回 success+skipped）。
  - `execution_mode=lite/delegate` 且要求首轮规划时，阻断非规划工具先行执行。

## 3. 执行模式定义

- `none`：简单任务，直接执行，不调用 `TodoWrite`。
- `lite`：中等复杂度，要求 2-3 个结果导向步骤。
- `delegate`：高复杂度，后续可扩展为子任务委派（见 Phase 2）。

## 4. Todo 粒度规则（当前实现）

- 首轮规划阶段：
  - 去重。
  - 过滤明显“操作型微步骤”（检查/进入目录/环境准备等）并尽量保留结果型步骤。
  - 限制最大数量（hard max 4）。
  - 统一状态：第一项 `in_progress`，其余 `pending`。
- 非首轮更新阶段：
  - 仅做去重与数量约束，保留模型推进状态。

## 5. PDF 场景示例

用户任务：提取 `E:\Huawei\test.pdf` 文本。

推荐行为：
1. 策略器判定为 `none` 或 `lite`（通常是 `none`）。
2. `none`：跳过 TodoWrite，直接提取文本。
3. 若提取失败或空文本，再进行 fallback（OCR/替代解析）并返回最终结果。

不推荐行为：
- 把“检查文件是否存在”单独拆成 todo。
- 在无失败信号时进入多轮规划。

## 6. Phase 2（已落地）

已接入子任务委派闭环，包含以下能力：

1. `planning-delegateTask` 工具（`src/main/aikernel/planning/tools.ts`）
   - 参数：`sub_goal`、`done_criteria`、`context`、`allowed_tools`、`budget`。
   - 作用：触发父任务创建子任务并返回结构化结果。

2. 子任务协议模块（`src/main/aikernel/planning/subtask.ts`）
   - 定义 `SubTaskRequest` / `SubTaskResult`。
   - 提供 `buildSubTaskPrompt(...)`（强制结构化输出格式）。
   - 提供 `parseSubTaskResult(...)`（支持 tag JSON 与容错解析）。

3. `TaskState.runSubTask(...)`（`src/main/states/tasks.ts`）
   - 使用 `createSubTask(parentId)` 创建子任务。
   - 默认继承父任务工具并自动排除 `planning-delegateTask`（避免无限递归委派）。
   - 支持 `allowed_tools` 白名单、`timeout_ms` 超时中断、`max_steps` 预算校验（按工具调用数统计）。
   - 自动回收子任务 artifacts 并回传父任务。

4. 主任务返回结构化结果给调用方
   - `status`、`summary`、`key_data`、`artifacts`、`next_action`、`subtask_id`、`raw_output`。

## 7. 风险与注意事项

- 当前是启发式判定，不是模型分类器，可能有边界误判。
- 若模型长期不按策略执行，需要在 agent prompt 再叠加强约束。
- 运行时策略注入使用 tag 替换，依赖 system prompt 作为稳定锚点，建议保持此机制。

## 8. 验证建议

最少跑以下四类回归：
- 简单单目标：不应出现 TodoWrite。
- 中复杂任务：应先有粗粒度 TodoWrite，再执行工具。
- 错误恢复任务：失败后可继续推进，不应被门控卡死。
- 长会话任务：mission anchor 仍能被持续遵循。
