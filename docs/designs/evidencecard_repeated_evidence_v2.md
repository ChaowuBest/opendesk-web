# EvidenceCard repeated evidence V2 设计

## 背景

EvidenceCard 最初用于减少 Coding 任务中的重复读取、重复搜索和无效证据消耗。当前实现对所有工具使用同一判定：

```text
repeated_evidence = state.target_counts[target] > 0
```

该判定仅比较 target，不区分稳定证据读取、状态观察、验证和会改变外部状态的动作。对 GUI、后台进程、浏览器和交互任务，相同参数不代表相同结果，第二次调用也不代表重复证据。

## 目标

- 所有状态观察、动作、验证、交互和计划操作不再判定为 repeated evidence。
- 仅对明确的稳定证据读取和搜索启用 target 重复判定。
- 新增工具默认不参与 repeated，避免因遗漏分类影响任务完成。
- 保留所有工具的 ledger、token、phase、evidence kind 和 target 记录。

## 非目标

本次不修改：

- 证据债务算法。
- 预算、token 估算和工具结果压缩。
- target 生成规则。
- EvidenceCard ledger 的整体数据结构。
- 基于文件修改世代或 GUI 状态版本的精细失效机制。

## 设计原则

### 默认不参与

EvidenceCard 应使用 allowlist，而不是持续扩展工具名黑名单。

`EvidenceToolSemantics` 增加重复策略：

```ts
repeatPolicy: 'never' | 'target';
```

- `never`：默认值，不读写 `target_counts`，不产生 `decision=reuse`。
- `target`：仅用于已确认的稳定证据读取和搜索。

将来如果引入状态世代，可扩展 `epoch` 策略，但不在本次范围内。

### 只有成功调用才能成为重复证据

失败、取消或未完成的调用不写入重复索引。失败后使用相同参数重试应被视为新的尝试。

## 分类规则

### 不参与 repeated

| 类别           | operation  | 示例                                                            |
| -------------- | ---------- | --------------------------------------------------------------- |
| 状态观察       | `observe`  | 后台进程状态、UI/browser snapshot、tabs、窗口和应用列表         |
| 状态动作       | `act`      | navigate、click、input、scroll、hover、pressKey、MCP 和设备命令 |
| 文件及数据修改 | `edit`     | editFile、writeFile、applyPatch、知识库增删改                   |
| 通用执行       | `execute`  | 可能有副作用的 Shell 命令、Workflow                             |
| 验证           | `verify`   | test/build、visualAssert、waitFor                               |
| 交互           | `interact` | askUser、exitPlanMode                                           |
| 计划和任务状态 | `plan`     | Todo 更新、Task/Pool/Planning 操作                              |

以下工具明确使用 `never`：

- `checkShellStatus`，包括轮询和 kill。
- 浏览器导航和元素操作。
- UI snapshot、screenshot、clickRef、坐标点击、input、findElement、getElementState。
- visualAssert 和 waitFor。
- Todo 更新和用户提问。
- 失败的文件读取、搜索或其他工具调用。

`findElement` 即使携带 snapshotId，本次也使用 `never`。当前 snapshotId 可能退化为 `current`，尚不能保证引用的是不可变快照。

### 参与 target repeated

`target` 策略只显式赋给：

- 文件完整读取、分段读取和文本提取。
- 文件 glob、grep 和语义搜索。
- 被明确识别为读取或搜索的终端命令。
- Skill 定义加载。
- Web 搜索和 Web 内容读取。
- 知识库 retrieve/ask 等只读检索。
- MCP 工具定义搜索和读取。

未在上述 allowlist 中明确标记的工具，即使名称以 `read`、`get`或 `search` 开头，也默认使用 `never`。

## 记录逻辑

```text
eligible = semantics.repeatPolicy == target AND toolCall.status == success
previousTargetCount = eligible ? state.target_counts[target] ?? 0 : 0
repeated = eligible AND previousTargetCount > 0

if eligible:
    state.target_counts[target] = previousTargetCount + 1

decision = repeated
    ? reuse
    : actualTokens > plannedBudget
        ? compress
        : collect
```

`never` 工具仍然追加 ledger，但：

- `repeated_evidence=false`。
- 不增加 `repeated_evidence_count`。
- 不写入 `target_counts`。
- 不会因 target 相同得到 `decision=reuse`。

## 已知限制

- 修改文件后重新读取同一文件，当前仍可能被视为 repeated。后续可通过文件版本或全局 mutation epoch 失效旧读取证据。
- 相同 Web 或知识库查询可能随外部状态变化。本次仍将其视为任务期间的弱稳定证据。
- `checkShellStatus` 当前 target 未完整纳入 pid/kill。本次通过 `never` 避免误报，target 精度后续单独修正。

## 测试计划

### 正向重复证据

- 连续成功读取同一文件：第一次 false，第二次 true。
- 连续成功执行同一文件搜索：第一次 false，第二次 true。

### 不参与重复证据

- 同一 pid 连续查询后台进程：始终 false。
- 重复 navigate、snapshot、clickRef、input、findElement 和 visualAssert：始终 false。
- 重复 Todo 更新和 askUser：始终 false。
- 重复文件编辑、写入、补丁和通用 Shell 执行：始终 false。
- 相同测试或构建命令在修改前后重跑：始终 false。
- 第一次稳定读取失败、第二次成功：第二次仍为 false。

### 状态与决策

- `never` 工具不增加 `target_counts` 和 `repeated_evidence_count`。
- `never` 工具仍进入 ledger 并记录 token、phase、target 和 status。
- `never` 工具在超过预算时仍可得到 `decision=compress`，但不得到 `decision=reuse`。

## 实施边界

实施时应仅修改 EvidenceCard 语义分类、repeated 索引与相关单元测试。不同时调整证据债务、预算、target 格式或其他 EvidenceCard 策略。
