# PR #257 代码检视报告

**PR 标题**: feat(goal): 目标评估进度实时通知、评估历史持久化及消息队列国际化  
**作者**: zxr0712  
**检视日期**: 2026-07-07  
**变更范围**: 23 个源文件 + 7 个测试文件，~1700 行新增，~350 行删除  
**9 个 commit**，从 `279cfec` 到 `f17b790`

---

## 一、总体评价

本次 PR 实现了三个主要功能：

1. **Goal 评估进度实时通知管道**：从内核 hooks → TUI → GUI 的端到端流式传输
2. **评估历史持久化**：将评估记录存入 `GoalState.evaluationHistory`，支持 reload 后恢复
3. **消息队列国际化及 Goal supplement 交互优化**

整体设计思路清晰，代码质量较好。核心架构改动合理，测试覆盖到位。但有若干需要关注的问题，详见下文。

---

## 二、逻辑合理性与边界条件

### ✅ 做得好的地方

1. **评估竞态保护完善**：`hooks.ts` 中在评估完成后，多处检查 `currentGoal.id !== evaluatingGoalId || currentGoal.revision !== evaluatingGoalRevision`，有效防止过期的评估结果污染当前 goal 状态。

2. **序列化向后兼容**：`normalizeEvaluationHistory()` 在 `evaluationHistory` 为空时自动从 `lastEvaluation` 迁移一条记录，确保旧数据平滑过渡。

3. **pending supplement 覆盖评估结果**：当评估期间收到新的 supplement 时，`hooks.ts` 会将本次评估标记为 `not_met`（原因："Supplemental context arrived during evaluation. Re-running with the latest context."）并在 turn loop 中重新调度。测试 `'does not complete a goal before materializing supplemental context added during evaluation'` 很好地覆盖了此场景。

4. **anchor message 查找的 fallback 逻辑**：`getEvaluationAnchor()` 从后向前查找第一个 assistant 消息作为锚点；找不到时返回空对象，后续代码用 spread 优雅处理。

5. **补充上下文清理 stale continuation**：`controller.ts` 中消费 pending supplements 时自动清除未消费的 `pendingContinuation`，避免了 stale evaluator prompt 残留。

6. **`removePendingGoalSupplementForText` 的匹配逻辑**：使用前缀/后缀/包含三种模式匹配，覆盖了多种合并场景，设计周详。

### ⚠️ 需要关注的问题

#### 2.1 `hooks.ts` - 评估结果查找存在潜在时序风险 (P1)

```typescript
// hooks.ts L127-128
const result = GoalController.recordEvaluation(task, evaluation);
const endRecord = currentGoal.evaluationHistory?.find((item) => item.evaluationId === evaluationId);
```

`recordEvaluation` 内部调用 `GoalStates.recordEvaluationEnd()` 将记录写入 `evaluationHistory`，然后这里再 `.find()` 查找。在当前同步代码中这是安全的，但如果未来 `recordEvaluation` 改为异步或其内部逻辑变更，可能导致 `endRecord` 查找失败。

**建议**：让 `recordEvaluation` 直接返回写入后的 `GoalEvaluationRecord`，而非依赖外部再次查找。

#### 2.2 `hooks.ts` - `t()` 调用在非 locale 初始化环境下可能返回 raw key (P2)

```typescript
function supplementSupersededEvaluationMessage(): string {
    return t('goal.eval.superseded_by_supplement');
}
```

此函数在 hook 执行期被调用。如果 locale 未正确初始化，`t()` 会返回 key 本身而非翻译文本，导致 UI 显示 `"goal.eval.superseded_by_supplement"` 这样的技术串。

**建议**：确保在 goal hook 注册前 locale 已初始化，或在 i18n 配置中为 `goal.eval.superseded_by_supplement` 添加 fallback 文案。

#### 2.3 `taskview.js` - `removePendingGoalSupplementForText` 匹配可能漏掉边界情况 (P2)

```javascript
const consumed =
    pendingText === text ||
    text.startsWith(`${pendingText}\n\n`) ||
    text.endsWith(`\n\n${pendingText}`) ||
    text.includes(`\n\n${pendingText}\n\n`);
```

此逻辑假设 supplement text 间以 `\n\n` 分隔。但实际 materialize 后的 rawText 格式取决于 `appendInternalUserMessage` 的实现。如果格式变更（如使用 `\n---\n` 分隔），此匹配将失败，导致 pending supplement 未被清理。

**建议**：在 `appendInternalUserMessage` 中将单个 supplement 的 content 直接传递为 `rawText`（PR 中已做此改动：`tasks.ts` L1564 新增 `rawText` 参数），确保格式一致。或改用更精确的匹配策略。

#### 2.4 `tasks.ts` - turn loop 中多处 `materializePendingGoalSupplements` 调用可能导致重复 (P2)

turn loop 中新增了两处 `materializePendingGoalSupplements` 调用：

1. hooks check 之后（L4225）
2. backoff 延迟之后（L4263）

如果两个 choke point 都触发（即 hooks reject 后又进入 backoff），可能重复 materialize。不过 `materializePendingGoalSupplements` 内部会消费 `pendingSupplements`，且检查了 `this._turnGeneration`，所以实际上不会重复。但调用点的增多增加了维护负担。

**建议**：考虑将 materialize 逻辑整合到更集中的位置，或添加注释说明重复调用的安全性。

#### 2.5 `taskview.js` - evaluator selectorId 中的 fallback identity 可能产生碰撞 (P2)

```javascript
function getGoalEvalIdentity(progress) {
    return (
        progress?.evaluationId ||
        [progress?.goalId || progress?.task_id || 'goal', ...].join('-')
    );
}
```

当 `evaluationId` 不存在时，用 goalId + revision + timestamp 拼接。但同一 timestamp 可能产生多个 chunk（如 start 和 end），如果 start chunk 的 `evaluationId` 丢失，两次渲染会使用不同的 selectorId。

**当前影响**：实际使用中 evaluationId 总是通过 `crypto.randomUUID()` 生成，此 fallback 极少触发。但为防御性编程考虑，可以在 fallback 中加入 `phase` 字段。

#### 2.6 `taskview.js` - `_renderGoalEvalProgress` 未检查 historyContainer 是否存在 (P3)

```javascript
_renderGoalEvalProgress(progress) {
    const historyContainer = this.getHistoryContainer();
    const selectorId = getGoalEvalSelectorId(progress);
    const el = historyContainer.querySelector(`#${selectorId}`);
    // ...
}
```

如果 `getHistoryContainer()` 返回 null（如在不可见视图上），会抛出 `Cannot read properties of null` 错误。

**建议**：添加 `if (!historyContainer) return;` 守卫。

#### 2.7 `tasks.ts` - `publishChunkUpdate` 可见性变更需注意并发 (P3)

从 `private` 改为 `public` 后，外部代码（`hooks.ts`）可以直接调用。`publishChunkUpdate` 内部遍历 `this.subscribers` 发送消息，如果 subscriber 执行耗时操作（如 DOM 操作），且 caller 持有 task 锁，可能导致阻塞。当前 subscriber 的实现都是轻量的（IPC send），所以实际风险较低。

---

## 三、架构合理性与耦合度

### ✅ 做得好的地方

1. **Chunk 通信模式一致**：新增的 `TaskUpdateGoalEvalChunk` 遵循了已有的 `TaskUpdateUserChunk` / `TaskUpdateAssistantChunk` / `TaskUpdateRetryChunk` 模式，类型系统完整，不破坏现有联合类型。

2. **评估流程分层清晰**：
    - `hooks.ts`：触发评估、处理结果、发布 chunk
    - `controller.ts`：评估结果应用、业务逻辑
    - `state.ts`：评估记录的持久化、序列化、查询
    - `tasks.ts`：chunk 发布、turn loop 集成

3. **TUI 回调模式解耦**：`taskView.onGoalEvalUpdate` 回调让 GoalPanel 更新逻辑与 TaskView 渲染解耦。

4. **评估历史的归一化处理**：`normalizeEvaluationHistory` / `normalizeEvaluationRecord` 等函数遵循项目既有的 normalize\* 模式，风格一致。

5. **测试充分**：新增了多个关键场景的测试：
    - supplement 评估期间到达 → 重新评估
    - stale continuation 清理
    - hook reject + supplement 优先级
    - nextPrompt 在 chunk 中的传递
    - TUI 入口的终端 goal panel 快照逻辑

### ⚠️ 需要关注的问题

#### 3.1 `publishChunkUpdate` 从 `private` 改为 `public` 破坏封装 (P1)

```typescript
// 变更前
private publishChunkUpdate(chunkUpdate: TaskUpdateChunk, context: string): void

// 变更后
public publishChunkUpdate(chunkUpdate: TaskUpdateChunk, context: string): void
```

这个改动是为了让 `hooks.ts` 中的评估回调能发布 chunk。但这意味着**任何持有 TaskState 引用的代码都可以发布任何类型的 chunk**，失去了类型安全和调用者约束。

**影响分析**：

- `hooks.ts` 是当前唯一的额外调用方
- 如果未来有其他模块误用，可能导致 UI 收到异常 chunk
- `context` 参数失去了原有的 internal 语义（它本用于区分 `'goal_eval'`、`'user'` 等上下文）

**建议**：在 TaskState 上新增一个专用的 `publishGoalEvalChunk(chunk: TaskUpdateGoalEvalChunk)` 方法，保持 `publishChunkUpdate` 为 private（或至少为 protected）。

#### 3.2 GUI 渲染代码有一定程度重复 (P2)

评估卡片的渲染逻辑在多个位置有相似实现：

| 位置                             | 函数                                  |
| -------------------------------- | ------------------------------------- |
| `taskview.js`                    | `renderGoalEvalProgressHtml()`        |
| `taskview.js`                    | `renderGoalEvaluationRecordHtml()`    |
| `taskartifacts.ts`               | `_renderGoalEvaluationCard()`         |
| `taskartifacts.ts`               | `_renderGoalEvalProgressCard()`       |
| `taskview.js` (EmbeddedTaskView) | 重用了 `renderGoalEvalProgressHtml()` |

**分析**：`taskview.js` 和 `taskartifacts.ts` 的渲染逻辑确实有重复（status 映射、图标选择、HTML 结构），但因为一个是对话流内渲染、一个是右侧面板渲染，两者有一定差异。当前重复量在可接受范围内，但如果继续增加评估展示维度，建议抽取公共渲染逻辑。

#### 3.3 turn loop 复杂度持续增长 (P2)

`processTaskTurn` 中 `beforeFinishTurn` 的逻辑已经比较复杂：

```
hooks.checkBeforeFinishTurn →
  materializeGoalSupplements →
    (if materialized) continue →
  (if finish) done →
  (if reject) materializeGoalSupplements →
    (if materialized) continue →
  appendRejectReason →
  processTaskTurn
```

新增的两处 `materializePendingGoalSupplements` 调用使流程更加复杂。**这打破了 "hooks 只负责决策，不触发 side effect" 的原则**。但当前没有更好的替代方案（需要在 hook reject 后立即检查是否有新的 supplement），所以暂时可以接受。

**长期建议**：考虑将 supplement materialization 集成到 hook 框架中，让 hooks 返回 `{ operation: 'materialize', supplements: [...] }` 而非在 turn loop 中硬编码检查点。

#### 3.4 修改影响面分析

| 修改模块                                   | 影响的其他模块                             | 修改量                                       |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------- |
| `GoalEvaluation` 接口新增 `evaluationId?`  | 所有 evaluator 实现                        | 向后兼容，无需同步修改                       |
| `TaskUpdateChunk` 联合类型新增 `goal_eval` | 所有 chunk subscriber（TUI、GUI、preload） | 需在各处新增 `goal_eval` 分支处理，PR 已覆盖 |
| `publishChunkUpdate` private → public      | 理论上所有 TaskState 使用者                | 仅 hooks.ts 使用，风险可控                   |
| `GoalPanelData` 新增 `evaluating?`         | TUI entry.goalPanel.update() 调用点        | PR 已更新所有调用点添加 `evaluating: false`  |
| `shouldAppendGoalDisplayMessage` 新增 tui  | TUI goal 创建流程                          | 测试已更新，改变 chat_context 消息索引       |

**总体评价**：此 PR 的修改面虽广（23 个文件），但大部分是**加法式修改**（新增字段、新增类型、新增回调），对现有逻辑的破坏性变更较少。唯一需要特别关注的是 `publishChunkUpdate` 可见性变更和 turn loop 的补充检查逻辑。

---

## 四、新增代码必要性与死代码

### ✅ 必要的代码

1. **`GoalEvaluationRecord` 接口及其系列函数**：评估历史持久化的核心数据结构，必须。
2. **`TaskUpdateGoalEvalChunk`**：评估进度通知的数据载体，必须。
3. **`chunkFromEvaluationRecord()`**：Record → Chunk 转换，必须。
4. **`GoalStates.recordEvaluationStart/End/upsertEvaluationRecord`**：评估记录的生命周期管理，必须。
5. **`getEvaluationAnchor()`**：评估卡片消息锚点查找，必须。
6. **`hasPendingSupplements()` / `supplementSupersededEvaluationMessage()`**：评估期间 supplement 到达的处理，必须。
7. **`normalizeEvaluationHistory/Record` 系列**：序列化兼容，必须。
8. **turn loop 中 `materializePendingGoalSupplements` 调用**：确保评估期间到达的 supplement 在 hook reject 后能立即注入，必须。
9. **`goal-time-format.js`**：时间格式化工具，GUI 和 renderer 共用，必须。
10. **消息队列国际化**：将硬编码中文替换为 i18n key，必须。

### ⚠️ 值得审视的代码

#### 4.1 `syncUserMessageFromHistory` 方法 (P2)

```typescript
// taskview.ts L1141-1153
syncUserMessageFromHistory(messageId: string): boolean {
    if (!this.taskState || this.messageIdToUserView.has(messageId)) {
        return false;
    }
    for (const message of this.taskState.chat_context.messages) {
        if (message instanceof UserMessage && message.message_id === messageId) {
            this.appendUserMessageView(message);
            this.tui.requestRender();
            return true;
        }
    }
    return false;
}
```

此方法在 diff 中定义，但从 `entry.ts` 的修改来看，实际使用的是 `appendLocalUserMessage`（创建一个新的临时 UserMessageView），而非从 history 同步。`syncUserMessageFromHistory` 可能被其他未展示的调用方使用（如 `commands/goal.ts` 中的 `syncGoalDisplayMessage`）。

**核实**：查看 `commands/goal.ts` 的 diff（截断），存在 `syncGoalDisplayMessage` 函数调用 `taskView.syncUserMessageFromHistory`。确认此代码**不是死代码**，而是为后续 goal 命令同步显示消息准备的。

#### 4.2 `user_message.rawText` 的 escape 方式变更 (P3)

```javascript
// taskview.js EmbeddedTaskView 中
- const rawAttr = user_message.rawText
-     ? ` data-raw-text="${user_message.rawText.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
+ const rawAttr = user_message.rawText ? ` data-raw-text="${escapeHtml(user_message.rawText)}"` : '';
```

从手动 partial escape 改为统一使用 `escapeHtml()`，这是一个好的改进，但也 escape 了更多的字符（`&`, `>`, 等）。需要确认 `rawText` 的消费者是否能正确反解。

#### 4.3 移除的代码确认 (P3)

以下移除的代码确认是合理的清理：

| 移除的代码                                                                | 所在文件           | 原因                                  |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------- |
| `getEvaluationIcon()` / `getColoredEvaluationIcon()` / `buildEvalTrail()` | `goalpanel.ts`     | 由 GoalEvalMessageView 替代，不再使用 |
| `_canSubmitAsGoalSupplement()`                                            | `taskview.js`      | 交互逻辑变更，不再需要                |
| `_PRIORITY_STYLE`                                                         | `taskartifacts.ts` | 未被引用的死代码                      |
| `canSubmitAsGoalSupplement` import                                        | `taskview.js`      | 对应方法已删除                        |
| `t` import (from `../../../locale/index.js`)                              | `tasks.ts`         | 未使用的 import                       |
| `console.log` debug 语句                                                  | `taskartifacts.ts` | 开发调试残留                          |

---

## 五、综合建议

### P1（建议修复后再合入）

1. **`publishChunkUpdate` 可见性**：新增 `publishGoalEvalChunk()` 专用方法，恢复 `publishChunkUpdate` 为 private。
2. **评估结果查找**：让 `recordEvaluation` 直接返回 `GoalEvaluationRecord`，避免外部二次查找。

### P2（建议合入后跟进）

1. **`t()` 调用保护**：确保 `goal.eval.superseded_by_supplement` 有 fallback 文案。
2. **turn loop 复杂度**：考虑将 supplement materialization 集成到 hook 框架中。
3. **GUI 渲染重复**：如果评估展示维度继续增长，抽取公共渲染逻辑。
4. **`_renderGoalEvalProgress` null guard**：添加 historyContainer 为空检查。

### P3（建议后续优化）

1. **`getGoalEvalIdentity` fallback 碰撞**：加入 `phase` 字段提升唯一性。

---

## 六、测试覆盖总结

| 测试场景                               | 覆盖状态                                          |
| -------------------------------------- | ------------------------------------------------- |
| 评估 chunk start → end 完整流程        | ✅ `goal.test.ts` 新增测试                        |
| nextPrompt 在 chunk 中的传递           | ✅ `goal.test.ts` 新增测试                        |
| 评估期间 supplement 到达 → 重新评估    | ✅ `goal.test.ts` "does not complete..."          |
| 补充上下文清除 stale continuation      | ✅ `goal.test.ts` "materializing supplemental..." |
| hooks 运行中新增 supplement → re-enter | ✅ `goal.test.ts` "materializes supplemental..."  |
| supplement 优先于 hook reject prompt   | ✅ `goal.test.ts` "prioritizes supplemental..."   |
| TUI goal panel 评估状态更新            | ✅ `entry.test.ts` 新增测试                       |
| TUI goal panel 终端状态快照            | ✅ `entry.test.ts` "goal evaluation end..."       |
| 评估历史序列化/反序列化                | ❌ 未发现独立的序列化测试                         |

**建议**：为 `normalizeEvaluationHistory` 添加一个序列化往返测试，确保旧数据（无 `evaluationHistory` 字段）能正确迁移。

---

## 七、结论

此 PR 的功能设计合理，实现质量较高。核心的评估管道架构遵循了项目已有的通信模式，类型系统完整。主要风险点在于 `publishChunkUpdate` 的封装破坏和 turn loop 的复杂度增长，建议在合入前解决 P1 问题，P2 问题在合入后跟随。

**总体评分**：代码质量 8/10，测试覆盖 8/10，架构一致性 7.5/10。

---

_检视人: WorkBuddy AI Reviewer_  
_检视范围: `origin/main..pr-257`，9 commits，23 source files + 7 test files_
