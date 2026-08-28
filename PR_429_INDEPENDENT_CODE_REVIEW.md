# PR #429 独立代码检视报告

## 结论先行

**建议暂缓合入（Request changes）。** PR 的目标是为 GUI/TUI 增加 minimal/detailed（TUI 中称 verbose）输出模式，整体功能方向合理，构建可以通过，新增测试数量也较充分；但是当前至少有两个用户可直接看到的确定性错误：

1. TUI 从历史记录重建消息时，把 assistant 消息的完成时间当成开始时间，导致历史耗时显示为“从完成到本次打开页面的时间”，而不是实际生成耗时。
2. TUI minimal 模式无论 assistant 最终是否包含错误，都追加绿色 `Complete`，失败请求会被显示成成功完成。

这两个问题会误导用户对任务结果和性能的判断，应在合入前修复并补回归测试。除此之外，PR 还把完整工具参数/结果放进原本明确设计为轻量的 render JSON，GUI 重新实现了一套与工具 schema 绑定的展示器，同时保留了已经失去生产调用者的旧 reasoning 渲染链路。这些问题不一定立刻造成错误，但会增加历史任务加载成本、维护成本和后续改动的耦合面。

本报告未读取仓库中已有的检视报告，结论来自 PR 提交本身、其父提交、整个仓库的调用关系和隔离构建/测试结果。

## 检视范围与方法

- PR 地址：`https://gitcode.com/openharmony-robot/OpenDesk/pull/429/diffs`
- 本地可确定的 PR 提交：`21a33c88eaf86123319650e4e98290c5573102df`
- 基线：`ef0d83bc5`（PR 父提交）
- 范围：`ef0d83bc5..21a33c88e`，40 个文件，`+5446/-263`
- 当前工作区有其他未提交修改；审查和验证均以 git 提交快照为准，没有把这些修改混入结论。
- 在 `/private/tmp` 解出的干净快照中运行了测试、lint、架构检查和两类构建。

## 严重问题

### P1-1：历史 TUI 耗时必然错误

证据链：

- 后端在流结束时执行 `assistant_message.timestamp = Date.now()`，该字段是完成时间：`src/main/aikernel/task/completion.ts:853-855`。
- 后端同时新增并持久化真正的 `AssistantMessage.elapsedSeconds`，并通过 `toRenderJSON()` 暴露：`src/main/aikernel/messages.ts:1587-1603`。
- TUI 重建历史时却将 `msg.timestamp` 传给 `AssistantMessageView.setStartedAt()`：`src/main/tui/components/taskview.ts:1840-1845`。
- 完成消息随后调用 `setTaskComplete(true)`，该方法把当前 `Date.now()` 记录为 `completedAt`：`src/main/tui/components/taskview.ts:778-785`。
- minimal 完成行使用 `formatMinimalElapsed(this.startedAt, this.completedAt)`：`src/main/tui/components/taskview.ts:1005-1018`。

因此，用户打开一个昨天完成的任务时，耗时会接近“昨天完成到现在”的时长。隔离快照中的最小回归用例设置 `elapsedSeconds=2`、重建时钟为 `100000ms`，实际输出为 `99.0s`，而不是 `2.0s`。这不是时钟精度问题，而是字段语义用错。

**建议修复：** `AssistantMessageView` 增加 `setElapsedSeconds()` 或直接让完成摘要优先使用持久化的 `msg.elapsedSeconds`；历史重建传入开始/结束语义明确的字段。对于旧数据没有 `elapsedSeconds` 的消息，应显示 `--`/不显示耗时，不能用当前打开时间伪造一个看似精确的值。新增测试至少覆盖：历史已完成消息、旧数据无耗时、正在运行的尾消息、任务切换后再次渲染。

### P1-2：错误结果仍被标记为绿色 Complete

`AssistantMessageView.renderMinimal()` 遍历错误 part 时会正常渲染错误框，但只要 `taskComplete` 为真且没有最终 text，就无条件追加 `renderMinimalCompletion()`：`src/main/tui/components/taskview.ts:1034-1109`。`renderMinimalCompletion()` 固定使用绿色 `● Complete`，没有读取 error part 或工具失败状态：`src/main/tui/components/taskview.ts:1005-1018`。

后端在关闭自动重试时会向同一个 assistant message 追加 `ErrorMessagePart`：`src/main/aikernel/task/completion.ts:761-775`。所以典型失败输出是：红色错误框 + 绿色 `Complete · 0.0s`。工具调用失败也会被 `renderMinimalToolSummary()` 以绿色图标概括，无法区分成功和失败。

隔离回归用例已复现该结果。用户可能据此误以为请求成功，尤其在 minimal 模式中，错误详情和完成标记同时出现会造成明显矛盾。

**建议修复：** 在 assistant 视图中计算 `hasError`（包括 `ErrorMessagePart` 和 tool status=`error`），失败时渲染本地化的 `Failed`/`Stopped` 状态，或者至少不渲染 `Complete`。工具汇总应按成功、失败、取消分别显示图标和状态。补充“LLM 失败、工具失败、只有错误 part、错误后有部分正文”四类测试。

## 高风险问题

### P2-1：minimal 模式隐藏整个 retry 状态，降低故障可操作性

`RetryStatusView.render()` 在 minimal 模式直接返回空数组：`src/main/tui/components/taskview.ts:513-514`。同一组件在 verbose 模式会显示上次错误、尝试次数、下次重试时间和 `/retry` 提示：`src/main/tui/components/taskview.ts:519-540`。现有测试还明确锁定了“minimal 不显示 Retry”的行为：`src/tests/ut/tui/components/taskview.test.ts:718-735`。

这会让网络错误或限流等待期间只剩一个泛化的“Generating response…”状态，用户看不到失败原因、倒计时，也不知道可以用 `/retry` 立即继续。minimal 的目标是减少过程噪声，不应删除错误和恢复入口。

**建议修复：** minimal 只压缩正常过程，保留一行黄色错误/重试状态，例如“Retrying (2) in 3s · /retry”；错误信息过长时截断并允许 verbose 查看完整详情。

### P2-2：render JSON 违反既有轻量数据契约，完整结果会进入 IPC 和 DOM 前置路径

既有注释明确说明 render JSON “only frontend fields, no large fields”：`src/main/aikernel/task/serializer.ts:167-185`。PR 修改 `ToolCall.toRenderJSON()`，把完整 `args_string`、`result`、`elapsedSeconds` 和 `rendered` 全部放入消息树：`src/main/aikernel/messages.ts:429-440`。

GUI 的 `reload()` 调用 `taskManagerAPI.getFullTask()`，随后把完整历史传给 `_renderInitialHistoryWindow()`：`src/renderer/components/taskview.js:2734-2833`。原有的历史 DOM 限制只是在已完成 JSON 到达 renderer 后限制插入窗口，不能减少 IPC 序列化、反序列化和 GC 成本。工具结果通常会被 compact，但这不是所有工具、所有结果、所有参数都成立的保证；大参数、二进制转文本、失败结果和未达到 compact 阈值的结果仍可能非常大。

**建议修复：** 保持默认 render DTO 轻量，只传 `result_preview`/长度/存储 ID；展开单个工具时按需通过独立 IPC 读取完整结果，优先复用已有 `result_storage`/compact 存储。若确实需要首屏详情，至少设置按字节而不是按字符的上限，并在主进程、IPC、renderer 三层都截断。不要用“固定高度滚动区”替代传输层容量控制。

### P2-3：GUI 新渲染器与旧 reasoning 渲染链路并存，旧链路已经没有生产调用者

PR 新增 `_renderAssistantOutputHtml()`，并让 history、assistant replace、增量 progress 都走它：`src/renderer/components/taskview.js:1858-1931`、`2362`、`2432`。旧的 `createReasoningPartHtml()`、`renderAssistantPart()`、`renderAssistantParts()`、`updateReasoningPreview()`、`scheduleReasoningPreviewUpdate()` 仍在类中：`src/renderer/components/taskview.js:797-1068`，但搜索显示它们只互相引用，没有新渲染路径调用。

同时，`connectedCallback()` 仍注册 `_handleReasoningToggleClick` 和 hover handlers：`src/renderer/components/taskview.js:4988-5003`；这些事件只查询 `.reasoning-block-od`，而新 HTML 使用 `.od-process-reason`/`.od-process-entry`。停止和卸载清理仍查询 `.reasoning-block-od.reasoning-active`：`src/renderer/components/taskview.js:3200-3201`、`5167-5168`、`5259-5264`，因此对新节点不起作用。

结果是两套 DOM 协议、CSS 和事件语义同时存在：死代码增加阅读和修改成本，旧定时器逻辑也容易在未来被误调用后泄漏。PR 应删除旧链路，或明确保留一个真实兼容入口并为其写测试；不要让不可达代码继续注册事件。

### P2-4：工具展示逻辑重复且硬编码在 GUI/TUI，绕过已有工具 renderer 抽象

GUI 在 `TaskView` 内按字符串解析工具名和参数：`src/renderer/components/taskview.js:1126-1295`，并硬编码 `readfile`、`writefile`、`editfile`、`loadskill`、`callskill`、search 等工具及其参数键。TUI minimal 又在 `src/main/tui/components/taskview.ts:676-744` 实现另一套工具 kind/name/summary 映射；verbose 则复用 `ToolCallView` 的已有 renderer。

这不是单纯的格式差异：新增工具或改变参数 schema 时，工具实现、GUI、TUI 需要同步修改，且三处可能产生不一致。工具系统已有 `rendered`/`renderToolCallCli` 等展示扩展点，PR 的 GUI 只在部分情况下使用它，随后重新解析 raw args/result，形成新的展示轮子。

**建议修复：** 在共享层定义面向展示的、大小受限的 `ToolDisplaySnapshot`，由工具或工具注册表提供标题、目的、文件动作、结果格式和状态；GUI/TUI 只负责布局。至少把工具 kind、名称和参数提取合并成一个可测试的共享 helper，避免两套映射继续漂移。

### P2-5：旧配置没有真正迁移，升级后可能静默改变所有 TUI 用户的显示

PR 新增 `cli_config.output_display`，默认值是 `minimal`：`src/main/utils/setting.ts:257-277`、`420-434`。旧版本只有 `reason_display`，虽然新 schema 把 `output_display='full'` 兼容映射为 `verbose`，但旧配置没有这个字段，因此拥有 `reason_display='full'` 的用户升级后仍会得到 `output_display='minimal'`，原本完整思考和工具时间线会突然消失。

`isReasoningDisplayFullConfigured()` 仍保留旧字段：`src/main/tui/display.ts:38-47`，这会让用户在 verbose 临时切换后恢复旧偏好，但不能避免默认启动时的静默变化。

**建议修复：** 明确产品决策：如果必须改变默认值，应做一次性迁移（旧 `reason_display=full` -> `output_display=verbose`），并在 release note/首次启动提示中说明；如果要保持兼容，则旧配置缺失 `output_display` 时默认 verbose。补测试覆盖旧 JSON、部分字段 JSON、无配置首次启动和切换后重启。

### P2-6：工具耗时包含权限等待和校验时间，展示语义与“执行时长”不一致

`TaskState.processToolCall()` 在参数解析/校验之前启动计时：`src/main/aikernel/states/tasks.ts:2542-2559`，之后还包含停止检查、权限询问和用户等待：`src/main/aikernel/states/tasks.ts:2594-2608`，直到 `finally` 才结束：`src/main/aikernel/states/tasks.ts:2653-2655`。

GUI 详情把它作为工具的 execution duration 显示。用户拒绝权限、长时间停留在权限弹窗或参数校验很慢时，耗时会被算入工具执行时间；跨机器执行时这个差异更明显。

**建议修复：** 若产品需要“用户等待 + 执行”的总时长，应改名为 total duration；否则将计时起点移到真正调用 `tool.execute()` 前，并可另存 permission/queue duration。补权限允许、权限拒绝、hook deny、真正 execute 四类边界测试。

## 中低风险问题

### P3-1：文件变更链接用 suffix 匹配，存在路径歧义

GUI 的 `openFileChanges()` 通过 `candidate.endsWith('/' + requested)` 或反向 suffix 判断匹配：`src/renderer/components/taskartifacts.ts` 的新增实现，以及 `src/renderer/components/taskview.js:3857-3867` 的调用链。当 workspace 中同时存在 `src/a/index.ts` 和 `test/a/index.ts`，工具只传 `index.ts` 或相对后缀时，可能打开第一个匹配项而不是实际变更文件。

**建议修复：** 优先 canonical absolute path 和 workspace-relative path 的精确比较；suffix 只能作为最后的候选，并在多匹配时显示选择列表，而不是静默选一个。

### P3-2：输出模式变更通过全量 reload 实现，交互状态和性能不理想

设置改变后，所有 `task-view` 调用 `_handleGuiOutputModeChanged()`，该方法直接执行 `reload()`：`src/renderer/components/taskview.js:102`、`4117-4119`。reload 会清空 message caches 和 assistant part snapshots，再重新取完整任务和重建历史：`src/renderer/components/taskview.js:2760-2763`、`2830-2833`。

切换一个纯展示选项不需要再次走主进程完整任务序列化；大任务会有明显延迟，用户手工展开的 process、正在滚动的位置和正在等待的增量 DOM 也更容易被重建覆盖。建议直接以当前快照 rerender，只有快照缺失时才 reload，并明确保存/恢复滚动与 disclosure 状态。

### P3-3：Ctrl+O 是固定快捷键，不进入现有 shortcut 配置体系

PR 在 TUI entry/help/dashboard 中增加 Ctrl+O 的输出模式切换/提示，但没有加入 `DEFAULT_SHORTCUTS` 或可配置 shortcut schema。用户不能避开与终端/输入法/自身习惯的冲突，也会出现“帮助中有快捷键但配置页无法修改”的不一致。建议复用现有快捷键注册和配置机制，或把它明确标为不可配置的内置键并处理冲突提示。

### P3-4：输入框额外上下各增加一行，和输出模式功能无直接关系

`VerticallyPaddedComponent` 及 `inputFrame` 包装使输入区固定多出两行：`src/main/tui/components/input.ts:678-694`、`725-735`。这会压缩小终端中消息历史和重试提示的可见区域，属于与本 PR 目标无关的范围扩大。若是设计需要，应单独说明最小终端高度并补布局测试；否则应拆出或删除。

## 边界条件矩阵

| 场景                               | 当前行为                                      | 判断                                                   |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| 新任务流式 reasoning/tool/text     | minimal 聚合，verbose 保留已有 renderer       | 方向合理，已有测试覆盖基本顺序                         |
| 历史已完成 assistant               | 用完成 timestamp 作为 start，当前时间作为 end | P1，耗时错误                                           |
| 历史无 `elapsedSeconds`            | 仍计算一个当前打开时刻的伪耗时                | P1 修复的一部分                                        |
| LLM 失败且关闭自动重试             | 错误 part 后追加绿色 Complete                 | P1                                                     |
| tool status=`error`                | 汇总图标/文案仍偏成功                         | P1 相关边界                                            |
| retry scheduled/retrying + minimal | 整块隐藏                                      | P2，恢复入口不可见                                     |
| verbose + 旧 `reason_display=full` | 可恢复完整 reasoning                          | 兼容逻辑部分存在，但首次默认仍可能降级                 |
| GUI 模式切换                       | 全量 getFullTask + 历史重建                   | P3 性能/状态风险                                       |
| 大 tool args/result                | 进入完整 render JSON、IPC 和 renderer         | P2 容量风险                                            |
| 新工具或参数 schema                | GUI/TUI 各自 hardcode                         | P2 架构漂移                                            |
| 同后缀不同文件                     | suffix 可能选错文件                           | P3                                                     |
| 中英文 locale                      | 新增主要文案已接入 `en-us.ts`/`zh-cn.ts`      | 基本通过；raw tool field/protocol 值属于不可本地化边界 |
| overlay/prompt 中按 Ctrl+O         | entry 逻辑排除了配置页、文本页和 overlay      | 设计方向正确，建议再做终端实测                         |

## 架构与新增代码必要性评价

### 合理且必要的部分

- `src/main/aikernel/types/messages.ts` 增加 `elapsedSeconds` 类型字段：必要，前后端需要稳定契约。
- `AssistantMessage`/`ToolCall` 的计时生命周期：总体方向必要，但历史消费和权限计时语义需要修复。
- `src/main/tui/display.ts`：把输出模式解析、默认值和持久化集中起来，抽象边界合理。
- `src/main/tui/commands/display.ts`、commands index/reason：命令注册和旧 reason 兼容属于必要配套。
- `displayConfig.ts`、`form.ts` 的 disabled/config navigation 支持：为“minimal 时禁用完整 reasoning”提供了可复用控件能力，设计基本合理。
- `taskview-output.ts`：把 GUI 输出分组模型抽成纯函数是正确方向，测试也比直接测 DOM 更稳定。
- `taskartifacts.ts` 的文件变更入口：和 workspace 变更面板结合有实际用户价值，但路径匹配需修正。
- locale、settingpanel、dashboard/help/statusbar：完成用户可见配置、提示和状态反馈所需的配套，方向必要。

### 需要删减、合并或重新归属的部分

- GUI 旧 reasoning 生成/更新/hover 链路：新渲染器接管后为死代码，应删除或真正接回新 DOM。
- GUI/TUI 两套 `_toolKind`/display-name/参数解析：应下沉共享展示模型，避免每个 UI 再造一套轮子。
- `ToolCall.toRenderJSON()` 直接暴露完整字段：不应把 UI 展示需求硬塞进通用 render JSON；应另设受限 DTO 和按需加载接口。
- `input.ts` 的垂直 padding：与输出模式无直接关系，建议拆分。
- `taskview.js` 一次增加约 1232 行、`custom.css` 增加约 694 行，仍把工具 schema、HTML、事件、文件动作全部放入单一 TaskView；即便 `taskview-output.ts` 已抽出模型，展示层仍然过于集中，后续每个工具变更都会触碰这个巨型组件。

## 测试质量评价

PR 新增和修改的测试覆盖了配置 schema、命令、TUI 基本聚合、GUI 输出模型、DOM 交互和消息队列，数量充分；但是测试偏重“期望当前设计输出什么”，缺少以下回归：

- 历史 assistant 的持久化耗时与当前时钟分离。
- assistant 只有 error part 或 tool error 时不得显示 Complete。
- 重试 minimal 模式仍显示错误/恢复入口。
- 大结果的 render DTO 上限和按需加载行为。
- 旧配置迁移和重启后的 output mode。
- 同 suffix 多文件的文件变更定位。
- GUI 模式切换时滚动、process 展开状态和运行中增量更新。

## 验证记录

验证在 PR 的干净 git 快照进行，未使用当前工作区的未提交代码。

- `npm run build-cli`：通过。
- `npm run build`：通过。Electron/Vite 输出已有外部依赖未使用、eval、chunk 大于 500KB 等 warning，但没有构建错误。
- `npm run check:architecture`：通过，检查 524 个文件。
- `npm run lint`：退出码 0，但有 413 个既有 warning；本 PR 相关文件没有 error，`messages.ts` 的 `toJSON()` 解构等处仍有 warning，应在清理死代码时一并处理。
- 原始 PR Jest 配置在 Node `v26.3.0` 下有 7 个套件在加载 `marked-katex-extension` 时 `SyntaxError: Unexpected token '{'`；这是 PR 未包含的依赖转换配置缺失。临时加入当前工作区已有的 `transformIgnorePatterns` 后：
    - PR 相关 17 个套件：238/238 通过。
    - 全量 Jest：271 个套件、2558 个测试通过；Jest 提示结束后一秒仍有异步句柄，建议后续用 `--detectOpenHandles` 定位。
- 临时回归用例（只写入 `/private/tmp`，未修改工作区）稳定复现 P1-1：输出 `99.0s` 而非持久化 `2.0s`；以及 P1-2：错误框后仍输出 `● Complete`。

## 逐文件必要性说明

下表覆盖 PR 的全部 40 个文件。必要性不是对代码质量的单一评分，而是说明该文件是否是实现目标所必需、是否应保留当前实现。

| 文件                                                           | 修改必要性           | 检视结论                                                                          |
| -------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `src/locale/en-us.ts`                                          | 必要                 | GUI/TUI 新文案已本地化；需补失败状态/重试 compact 文案。                          |
| `src/locale/zh-cn.ts`                                          | 必要                 | 同上；建议检查“minimal/verbose/detailed”术语统一。                                |
| `src/main/aikernel/messages.ts`                                | 必要但需重构         | elapsed 字段必要；完整 tool render JSON 破坏轻量契约，历史错误状态也未被消费。    |
| `src/main/aikernel/states/tasks.ts`                            | 必要但需调整         | tool timing 和最终 assistant timing 必要；计时起点应与 execution 语义一致。       |
| `src/main/aikernel/task/types.ts`                              | 必要                 | 类型同步必要；应明确 elapsed 的单位和起止语义。                                   |
| `src/main/aikernel/types/messages.ts`                          | 必要                 | 稳定 JSON 类型必要；建议为受限 ToolDisplaySnapshot 另设类型。                     |
| `src/main/tui/commands/display.ts`                             | 必要                 | `/display` 命令边界清楚；错误/帮助文案需保持 locale。                             |
| `src/main/tui/commands/index.ts`                               | 必要                 | 注册新命令必要。                                                                  |
| `src/main/tui/commands/reason.ts`                              | 必要但需统一         | 兼容旧 reason 设置有价值；需与 output mode 的迁移策略一致。                       |
| `src/main/tui/components/config/displayConfig.ts`              | 必要                 | 配置页需要；禁用项焦点/小终端布局需补测。                                         |
| `src/main/tui/components/config/form.ts`                       | 部分必要             | 通用 disabled/navigation 支持合理，但应确认没有把本 PR 无关表单行为混入。         |
| `src/main/tui/components/dashboard.ts`                         | 必要                 | 展示当前模式/快捷键有用户价值；Ctrl+O 应进入配置体系。                            |
| `src/main/tui/components/help.ts`                              | 必要                 | 帮助提示必要；术语和快捷键可配置性需统一。                                        |
| `src/main/tui/components/input.ts`                             | 不必要/应拆分        | 垂直 padding 与输出模式无直接关系，增加小终端风险。                               |
| `src/main/tui/components/taskview.ts`                          | 必要但风险最高       | 核心聚合逻辑必要；需修复两个 P1、保留 retry 错误、历史使用 elapsed。              |
| `src/main/tui/display.ts`                                      | 必要                 | 配置读写抽象合理。                                                                |
| `src/main/tui/entry.ts`                                        | 必要但需收敛         | 全局/任务级切换 wiring 必要；全局默认、任务临时覆盖和重启语义需文档化。           |
| `src/main/utils/setting.ts`                                    | 必要但需迁移         | schema/default 必要；旧 `reason_display` 缺失字段的迁移不完整。                   |
| `src/renderer/components/settingpanel.js`                      | 必要                 | GUI 设置入口必要；保存后不应依赖所有 task view 全量 reload。                      |
| `src/renderer/components/taskartifacts.ts`                     | 必要但需修正         | changes 入口合理；suffix 匹配可能打开错误文件。                                   |
| `src/renderer/components/taskview-output.ts`                   | 必要                 | 纯模型拆分是好边界；应继续承载共享工具展示模型，而不是让 TaskView 重新解析。      |
| `src/renderer/components/taskview.js`                          | 必要但应大幅清理     | 新 GUI 体验的主实现必要；当前包含死 reasoning 链路、重复工具 schema 和过多职责。  |
| `src/renderer/styles/custom.css`                               | 必要但需审查         | 新布局样式必要；旧 reasoning 样式若无节点应删除，避免两套协议。                   |
| `src/tests/ut/aikernel/assistant-think-tags.test.ts`           | 必要                 | 验证新增 timing/part 变化与 think tag 交互；应增加 error/elapsed 断言。           |
| `src/tests/ut/aikernel/tool-call-render-json.test.ts`          | 必要但断言方向需调整 | 验证 DTO 有字段有价值；同时应断言大小限制/不会传完整大结果。                      |
| `src/tests/ut/renderer/gui-output-model.test.ts`               | 必要                 | 纯模型测试必要；应增加 error/tool error 和空 toolcalls 边界。                     |
| `src/tests/ut/renderer/settingpanel-config-management.test.ts` | 必要                 | GUI 设置保存回归必要。                                                            |
| `src/tests/ut/renderer/taskartifacts-goal-disclosure.test.ts`  | 必要                 | 侧栏状态回归必要；需补多 suffix 文件。                                            |
| `src/tests/ut/renderer/taskview-message-queue.test.ts`         | 必要                 | 证明重构没有破坏队列/嵌入模式；和 output renderer 的关联较弱。                    |
| `src/tests/ut/renderer/taskview-output-mode.test.ts`           | 必要但不完整         | 覆盖量大且验证交互；没有覆盖 reload 保留状态、旧 reasoning 死链路和错误完成标记。 |
| `src/tests/ut/settings/schema.test.ts`                         | 必要                 | schema 默认/兼容回归必要；需加入旧配置迁移断言。                                  |
| `src/tests/ut/tui/commands/display.test.ts`                    | 必要                 | 新命令解析和持久化回归必要。                                                      |
| `src/tests/ut/tui/commands/reason.test.ts`                     | 必要                 | 兼容 reason 命令必要；应覆盖无 active task 的一致性。                             |
| `src/tests/ut/tui/components/config/displayConfig.test.ts`     | 必要                 | 配置页可用性回归必要。                                                            |
| `src/tests/ut/tui/components/config/form.test.ts`              | 必要                 | disabled 表单通用行为需要测试。                                                   |
| `src/tests/ut/tui/components/dashboard.test.ts`                | 必要                 | 模式状态/快捷键提示回归必要。                                                     |
| `src/tests/ut/tui/components/help.test.ts`                     | 必要                 | 帮助内容回归必要。                                                                |
| `src/tests/ut/tui/components/input-statusbar.test.ts`          | 部分必要             | status bar 模式字段需要测；padding 的小终端布局尚未验证。                         |
| `src/tests/ut/tui/components/taskview.test.ts`                 | 必要但缺关键场景     | 聚合/耗时/顺序测试充分；缺历史 elapsed 和 error Complete 回归。                   |
| `src/tests/ut/tui/entry.test.ts`                               | 必要                 | 全局/任务级切换 wiring 需要测；应加旧设置迁移与重启语义。                         |

## 合入前最小修复清单

1. 修复 TUI 历史耗时：使用持久化 `elapsedSeconds`，无值时不要用当前时间伪造。
2. 修复错误状态：任何 assistant/tool error 都不能显示绿色 `Complete`；补四类失败回归。
3. minimal 模式保留 retry 错误、倒计时或 `/retry` 恢复入口。
4. 设计受限的 render DTO/按需结果 IPC，恢复“render JSON 不含大字段”的架构约束。
5. 删除或真正接回旧 reasoning 渲染链路；合并 GUI/TUI 工具展示元数据。
6. 给旧 `reason_display` 做明确迁移，并统一 TUI `verbose` 与 GUI `detailed` 的产品术语。
7. 补充历史、重试、旧配置、大结果、路径歧义和模式切换状态测试。
