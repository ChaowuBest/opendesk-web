# PR 257 代码审查

PR: https://gitcode.com/openharmony-robot/OpenDesk/pull/257/diffs

审查日期: 2026-07-07

## 审查范围

本次审查按用户要求重点检查以下内容：

- 逻辑是否合理，是否覆盖关键边界条件。
- 架构是否合理，是否破坏既有架构或造成模块过度耦合。
- 新增代码是否必要，是否存在死代码或无关变更。

本 PR 的变更主要集中在 goal 评估进度与历史记录、task update chunk、TUI/GUI 渲染、goal supplement 处理、本地化、测试以及 package 依赖。

## 总体结论

该 PR 的方向有价值，但不建议按当前状态合入。当前存在一个阻断构建的语法问题，并且 active goal 补充上下文、goal evaluation history 持久化等核心流程存在行为和边界问题。此外，PR 中还包含未使用依赖和测试 debug 日志。

## 问题清单

### Blocker: TUI 入口文件存在全角逗号，阻断构建

文件: `src/main/tui/entry.ts:19`

import 列表中 `BaseTaskManagerUpdateSubscriber` 后面使用了全角逗号 `，`，即 `U+FF0C`，而不是 ASCII 逗号 `,`。

影响：

- TypeScript/esbuild 无法正确解析该文件。
- TUI 入口构建和运行会被阻断。

证据：

- 源码中可见 `BaseTaskManagerUpdateSubscriber，`。
- 单字符检查确认 `BaseTaskManagerUpdateSubscriber` 后一个字符码为 `ff0c`。

建议修复：

- 将全角逗号替换为 ASCII 逗号。
- 修复后重新运行正常构建命令，因为这是语法级问题。

### High: 运行中的 active goal 输入不再立即进入补充上下文

相关文件：

- `src/renderer/components/taskview.js:3169`
- `src/renderer/components/taskview.js:1741`
- `src/renderer/components/taskview-goal-input.js:5`

当前 submit 事件处理中，如果任务正在运行且当前 goal 为 active，代码直接调用 `addToMessageQueue(event.detail)`，绕过了 `_handleRunningGoalInput()` 以及既有的 `canSubmitAsGoalSupplement()` 判断。

影响：

- 用户在 active goal 运行期间输入的纯文本补充，不会立即进入 goal supplemental context，而是进入消息队列。
- 评估器可能在缺少最新用户补充上下文的情况下继续评估。
- 只有用户再点击队列里的 “Send now” 才会尝试作为 supplement 发送，交互语义发生了变化。
- 现有 helper 测试仍然断言运行中 active goal 的纯文本输入应作为 supplement，但生产 submit 路径已经不符合这个契约。

建议修复：

- 恢复 submit 路径，优先调用 `_handleRunningGoalInput(event.detail, { alertUnsupported: true })`。
- 仅在非 goal 输入或不支持 supplement 的 payload 上回退到普通队列逻辑；如果产品语义确实改为 queue-first，则需要同步修改 helper、测试和 UI 文案。
- 增加覆盖真实 `submit` 事件路径的 renderer 测试，而不只测试 helper。

### High: evaluation history 可能永久停留在 `phase: start`

相关文件：

- `src/main/aikernel/goal/hooks.ts:76`
- `src/main/aikernel/goal/hooks.ts:86`
- `src/main/aikernel/goal/state.ts:705`
- `src/renderer/components/taskartifacts.ts:1511`

`recordEvaluationStart()` 会在 evaluator 运行前持久化一条 start record。若 evaluator 返回时 goal 已经被编辑、清除、暂停、完成，或者 revision/status 已经不再匹配，当前逻辑只发布一条临时 end chunk，并不会把对应的 end record 写回 `evaluationHistory`。

影响：

- 刷新页面或切换任务后，最新的持久化评估记录可能仍是 `phase: start`。
- 侧边栏可能长期显示 “Evaluating goal progress...”，即使该评估实际已经结束或被丢弃。
- 这是异步 evaluator 返回过期结果时的边界条件缺口。

建议修复：

- 当已持久化 start 的评估变为 stale 时，也写入一个终态记录，例如 `status: error`，或新增明确的 superseded/cancelled 展示状态。
- 或者不要持久化 `phase: start`，将 live progress 保持为纯临时 UI 状态，只持久化终态记录。
- 增加 evaluator 结束时 goal revision/status 已变化的测试。

### Medium: `nextPrompt` 只存在于 live chunk，无法持久化恢复

相关文件：

- `src/main/aikernel/goal/hooks.ts:146`
- `src/main/aikernel/goal/state.ts:39`
- `src/main/aikernel/goal/state.ts:728`
- `src/renderer/components/taskartifacts.ts:1507`
- `src/renderer/components/taskartifacts.ts:1535`

live `goal_eval` chunk 会附带 `nextPrompt`，但 `GoalEvaluationRecord` 和 `recordEvaluationEnd()` 都没有存储该字段，`GoalRenderSummary.lastEvaluation` 也没有暴露该字段。侧边栏渲染却会尝试读取 `evaluation.nextPrompt`。

影响：

- “Next step” 信息在 live 状态下可能显示，但 reload 或 task switch 后会丢失。
- `taskartifacts.ts` 访问了 summary 类型里不存在的 `goal.lastEvaluation.nextPrompt`，类型和数据契约不一致。

建议修复：

- 在 `GoalEvaluationRecord` 中增加 `nextPrompt?: string`，并从 evaluator 输出或 continuation prompt 中写入。
- 如果 renderer 需要展示该字段，则 `GoalRenderSummary` 也应一致暴露。
- 增加 `not_met + nextPrompt` 场景的 reload/render 测试。

### Medium: 新增直接依赖未被使用

文件: `package.json:156`, `package.json:160`

PR 新增了 `pako` 和 `pkce-challenge` 两个顶层依赖，但当前审查到的源码中没有任何引用。

影响：

- 增加安装体积和依赖审计面。
- 与 goal evaluation 功能无直接关系，看起来是无关依赖变更。

建议修复：

- 如果本 PR 没有实际使用，应移除这两个依赖。

### Low: 测试中残留 debug 日志

文件: `src/tests/ut/aikernel/task-llm-retry.test.ts:168`, `src/tests/ut/aikernel/task-llm-retry.test.ts:223`

PR 在 retry 测试中保留了多处 `console.log('DEBUG...')`。

影响：

- 污染测试输出。
- CI 日志噪声变大，可能干扰排查真实失败。

建议修复：

- 稳定测试后删除这些 debug log。

## 架构观察

### goal hooks 直接依赖 task update chunk 传输协议

相关文件：

- `src/main/aikernel/goal/hooks.ts`
- `src/main/aikernel/states/tasks.ts`

PR 将 `TaskState.publishChunkUpdate()` 改为 public，并由 goal hooks 直接构造 `TaskUpdateGoalEvalChunk`。这样能实现功能，但会让 goal domain 直接依赖 task streaming transport schema。

风险：

- 后续 renderer chunk 协议变化时，需要同步修改 goal hooks。
- goal evaluation 逻辑了解了过多 UI streaming 细节。

建议方向：

- 尽量保持 `publishChunkUpdate()` 为内部传输接口。
- 提供更窄的 task API，例如 `task.publishGoalEvaluationUpdate(record)`，或通过注入 notifier 接口，让 goal hooks 只发布领域记录，由 TaskState/transport 层负责转换成 chunk。

### TUI 被纳入 goal display-message 持久化路径

文件: `src/main/aikernel/goal/controller.ts:74`

PR 将 `shouldAppendGoalDisplayMessage()` 从 GUI-only 改为 GUI/TUI。该变更把既有 controller-to-chat UI 展示消息耦合扩展到了 TUI。

风险：

- goal controller 负责创建展示用途的 chat message，本质上混入了 UI 展示关注点。
- TUI 需要额外同步逻辑来避免漏显或重复显示这些消息。

建议方向：

- 如果该行为是产品预期，应记录不变式：来自 UI source 的 goal create/edit 会向 `chat_context` 追加可见命令消息。
- 如果不是必要行为，应考虑把 display message 创建逻辑移动到 UI command 层，让 controller 更专注 goal state/event。

## 验证记录

尝试运行：

```bash
npm run build-cli
```

结果：

- 命令在源码编译前失败，错误为 `spawn .../node_modules/@esbuild/linux-arm64/bin/esbuild EACCES`。
- 因为环境中的 esbuild 可执行权限问题，该命令未能进一步报告 TypeScript 语法错误。
- 全角逗号问题已通过源码内容和字符码直接确认。

补充说明：

- 当前 SSHFS 工作区中，部分宽范围 `git`/`rg` 操作较慢或会挂起，因此主要基于 PR patch 和文件级源码阅读形成证据。

## 建议修复顺序

1. 修复全角逗号，并重新运行 `npm run build-cli`。
2. 恢复 active goal 运行期间纯文本输入直接作为 supplement 的路径；若改为 queue-first 是刻意设计，则同步更新 helper、测试和 UX 文案。
3. 明确 evaluation start record 是否应持久化；若持久化，则保证每条 start 都有对应终态记录。
4. 持久化并一致渲染 `nextPrompt`，或从持久化评估卡片中移除 “Next step” 展示。
5. 移除未使用依赖和测试 debug 日志。
6. 重新运行相关测试，至少包括 goal controller tests、renderer taskview queue tests、TUI goal tests 和 retry tests。
