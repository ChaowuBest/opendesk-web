# PR #429 独立详细代码检视报告

## 1. 结论

**检视结论：Request changes，当前版本禁止合入。**

PR 已提交的 HEAD `f4b9f47a716c6b5b48917ef15d41f3a25fce0c75` 在干净工作树中无法构建，原因不是类型或环境差异，而是 5 个被代码直接导入的源码文件没有进入 Git。除此之外，本次改造还让已有的 GUI“思考内容显示：内联/气泡”设置变成了无效设置，并存在订阅同步广播给错误接收者、图片诊断堆栈可能进入模型上下文、范围过大及少量死文案等问题。

建议至少解决本报告的 P0 和全部 P1 问题后，再进行下一轮审查。由于 P0 使真实 Electron 包无法生成，本轮不能完成可信的 GUI 视觉、交互和端到端验收。

问题统计：

| 级别 | 数量 | 含义                                         |
| ---- | ---: | -------------------------------------------- |
| P0   |    1 | 阻断构建或核心功能，绝对不能合入             |
| P1   |    2 | 明确的用户回归或隐私风险，合入前必须修复     |
| P2   |    3 | 并发/架构/交付质量风险，应在本 PR 修复或拆分 |
| P3   |    3 | 可维护性、可访问性和清理项                   |

## 2. 检视范围与方法

- PR 基线：`ef0d83bc5bc7584421e138e6a7703c749252faa1`
- PR HEAD：`f4b9f47a716c6b5b48917ef15d41f3a25fce0c75`
- PR 提交数：5
- 净变更：85 个文件，`7992` 行新增，`884` 行删除
- 审查对象：`git diff ef0d83bc..f4b9f47a`、相关调用链、仓库内既有实现和测试
- 验证方式：从 HEAD 创建干净源码快照，复用当前依赖目录；工作区未跟踪文件不进入快照
- 特别说明：按要求，没有读取任何已有检视报告的正文。仅从 Git 变更清单得知 PR 自身提交了 `PR_429_INDEPENDENT_CODE_REVIEW.md`，也仅把它作为变更文件统计。

这一步很重要：当前工作区存在若干未跟踪源码，恰好能遮蔽 PR 的缺文件问题。审查和构建必须以 Git 提交对象为准，而不能以作者本机“能找到文件”的工作区为准。

### 工作区未提交修复的复核状态

本次用户后续补充的工作区改动已经重新接回 `gui_reason_display`：

- `taskview.js` 重新读取 `gui_config.gui_reason_display`，并在设置改变时触发 task view 重绘。
- `taskview-output.ts` 增加 `inline | bubble` 的独立归一化函数。
- bubble reasoning 使用共享 process timeline，运行中自动展开，完成后可点击固定/取消固定。
- 流式 patch 会更新 bubble 内容并滚动到最新位置。
- CSS 增加桌面浮层、窄屏 fixed surface 和 reduced-motion 处理。
- 新增测试覆盖初始渲染、完成收起、固定/取消固定、流式追加和运行时切换。

该工作区修复经定向 Jest 验证为 **62 tests passed**，当前工作区的 `npm run build-cli` 和 Electron bundler 也已成功。因此下文 P1-1 的“完全忽略设置”结论仍准确描述 PR 已提交 HEAD，但**不再准确描述当前未提交工作区**；P0 仍准确描述 PR 的交付状态。合并前仍需把这些改动和 5 个缺失平台/应用模块纳入 PR，并在包含它们的 clean checkout 中重新验证。

## 3. 阻断及高优先级问题

### P0-1：最终提交漏掉 5 个被直接依赖的模块，CLI、Electron 和测试均无法构建

**证据**

已提交代码包含以下导入：

- `src/main/main.ts:71` -> `../platforms/electron-tool-call-detail.js`
- `src/platforms/electron.ts:28` -> `./electron-task-update-buffer.js`
- `src/tests/ut/aikernel/tool-call-render-json.test.ts:2` -> `../../../platforms/electron-task-update-render.js`
- `src/main/applications/filemgr/tools.ts:29` -> `./tool-presentation.js`
- 12 个搜索工具 -> `./presentation.js`，例如 `src/main/applications/search/tools/academicSearch.ts:12`

但以下文件全部不在 `git ls-tree HEAD` 中：

1. `src/platforms/electron-task-update-buffer.ts`
2. `src/platforms/electron-task-update-render.ts`
3. `src/platforms/electron-tool-call-detail.ts`
4. `src/main/applications/filemgr/tool-presentation.ts`
5. `src/main/applications/search/tools/presentation.ts`

提交历史进一步说明这是一次未完成的搬迁：`87e7780a0` 曾新增 `src/main/aikernel/task/update-render.ts` 和 `tool-call-detail.ts`，最终提交 `f4b9f47a7` 删除了它们并把导入改到 `src/platforms/`，却没有提交替代文件；对应测试也被删除或改为导入不存在的新位置。

**影响**

- `npm run build-cli` 失败，报告 13 个无法解析的导入。
- Electron 主进程打包在 `src/main/main.ts:71` 立即失败。
- Jest 有 19 个测试套件因模块解析失败，失败扩散到 filemgr、search、plugin、platform 等本来不相关的套件。
- 工具详情的裁剪上限、流式序列/ACK、乱序恢复和缓存上限等关键实现根本不在 PR 中，无法做安全性和边界审查。
- 当前工作区中的同名未跟踪文件不能视为 PR 内容，也不能被 CI、其他开发者或发布流水线获得。

**修复要求**

1. 把所有预期模块和对应测试纳入提交，或者完整回退这些导入和搬迁。
2. 从全新 clone 或 `git archive HEAD` 验证，不能在含未跟踪文件的作者工作树中验证。
3. 增加 CI 的 clean-checkout 构建；`check:architecture` 不检查导入目标是否存在，不能替代编译。
4. 补回平台层三个模块的单元测试，特别覆盖乱序、重复、丢包、重连、ACK 上界和详情裁剪。

### P1-1（PR HEAD）：既有 `gui_reason_display` 设置仍可配置和保存，但渲染器已经完全忽略它

**证据**

- schema 仍声明 `inline | bubble`：`src/main/utils/setting.ts:210-214`。
- 设置页仍展示两个选项：`src/renderer/components/settingpanel.js:1246`、`1318-1323`。
- 设置页仍保存该值：`src/renderer/components/settingpanel.js:2233-2238`、`3635-3638`。
- 新版 task view 初始化只读取 `gui_config.output_mode`：`src/renderer/components/taskview.js:94-111`。
- HEAD 的 task view 对 `gui_reason_display`、`guiReasonDisplayMode`、`reasoning-bubble` 均为零引用。
- PR 同时删除了 `.reasoning-bubble*` CSS。
- 基线版本会读取该设置，并分别生成 inline/bubble DOM、处理 hover、pin 和自动隐藏。

**用户结果**

用户在设置页选择“气泡式”后配置会成功保存，但界面行为不会变化。这个问题比“功能暂未实现”更糟，因为 UI 明确承诺了一个不可用选项。

**修复要求**

- 在新的 process/output 模型中恢复 inline/bubble 两种行为，并保证详细/极简模式组合有明确语义；或者正式废弃该功能，同时删除设置项、schema 字段并提供迁移说明。
- 添加真实行为测试，至少覆盖 inline、bubble、运行时切换、历史消息重绘和流式 reasoning；仅检查源码字符串不够。

### P1-2：临时图片诊断把原始 `error.stack` 拼进工具错误，可能发送给远端模型并展示给用户

**证据**

- `src/main/applications/filemgr/image.ts:488-492` 捕获未知异常后，把 `error.stack ?? error.message` 写入 `ImageSourceError.details`。
- `src/main/applications/filemgr/tools.ts:1176-1180` 把 details 原样拼入本地化错误消息。
- `ReadImageTool` 与 `AskImageTool` 分别在 `tools.ts:1304-1305`、`1367-1370` 重新抛出该消息。
- 工具执行失败会在 `src/main/aikernel/states/tasks.ts:2671` 写入 `tool_call.result = "工具运行错误: ${err}"`。工具结果会进入后续模型上下文，详细输出模式也会按需展示结果。

**影响**

堆栈通常包含绝对工作区路径、用户名、安装路径、依赖内部文件及运行结构。它不应该进入远端模型请求，也不应该成为普通用户错误详情。代码注释已明确称其为“临时诊断”，说明它不是稳定产品协议。

**修复要求**

- 原始堆栈仅写内部日志，用户/模型侧返回稳定、本地化、无路径的错误码和说明。
- 如需设备诊断，使用显式 debug 模式和脱敏后的诊断 ID，而不是扩大所有 readImage/askImage 的数据暴露面。
- 增加回归测试，断言工具结果不含 `Error.stack`、工作区绝对路径和依赖路径。

## 4. 中低优先级问题

### P2-1：新订阅者的同步回放被广播给所有订阅者，而不是只发给请求同步者

`src/main/main.ts:1546-1561` 已经定位并验证了发起同步的 `subscriptionId`，注释也明确说“listener ready 后 replay”，但最后调用的是 `task.sendSubscriptionFeedback()`。该方法在 `src/main/aikernel/states/tasks.ts:2426` 调用 `publishTaskUpdate`，而 `publishChunkUpdate` 在 `735-744` 遍历 `this.subscribers`。

因此，当一个 task view 新建/重连时，已有 Electron view、TUI 或其他订阅者也会收到一次并非发给它们的回放。完整 replace 可能只是多余重绘；流式 delta 则可能造成重复、长度漂移或迫使缓冲器做额外纠错。当前缺失的 `ElectronTaskUpdateBuffer` 即使能够掩盖重复，也不应承担修正发布边界的职责。

建议增加“向指定 subscriber 发送当前快照”的 API，`syncTaskUpdate` 只调用该 API。增加双订阅者测试：B 同步时 A 的消息数组必须保持不变。

### P2-2：PR 范围过大且混入与输出模式无直接关系的修改，降低可验证性

本 PR 同时包含输出模式、工具展示协议、平台流式缓冲、工具详情 IPC、链接右键菜单、marked-katex 打包绕过、HDC 解析、图片诊断、grep 详情改造和一份代码审查文档。85 文件、近 8k 行新增使任何一个回归都更难归因。

建议拆分：

1. 输出模式核心协议与 TUI。
2. GUI output model、流式缓冲与工具详情 IPC。
3. 各领域工具 presentation 接入。
4. HDC 兼容修复及独立测试。
5. marked-katex 构建修复。
6. 链接右键菜单。
7. 删除产品 PR 中的审查报告文件。

`electron.vite.config.ts` 直接绑定 `node_modules/marked-katex-extension/lib/index.cjs` 的包内部路径，且 `package.json` 使用 `^5.1.6`。锁文件当前版本存在该文件，但依赖升级可能不再保留这个内部布局。若确需保留，应锁定/校验版本并为打包结果加测试，最好单独提交。

### P2-3：关键流式恢复合同因实现缺失而无法审查，现有纯函数又会静默吞掉矛盾 delta

`src/renderer/components/taskview-output.ts:91-120` 在 `previousText.length > expectedLength` 时直接保留旧文本；在 `previousText.length === expectedLength` 时也丢弃新 delta。若 `text_length` 表示应用 delta 后的总长度，第二种行为可能用于去重；若序列发生跳跃或上游合同不同，则会静默保持错误文本，不会触发 reset/snapshot。

本应定义这个合同的 `electron-task-update-render.ts` 和 `electron-task-update-buffer.ts` 都没有提交，因而无法确认 `text_length`、`stream_reset`、`stream_sequence` 的严格语义。修复 P0 时必须把协议写成注释/类型不变量，并用表驱动测试覆盖：首包、重复包、跳号、乱序、旧 ACK、负数 ACK、reset、Unicode、终态 replace、重连。

### P3-1：存在当前已无生产引用的新增本地化键

以下新增键在 HEAD 的生产代码和测试中均无引用：

- `renderer.taskview.output.reasoningNumber`
- `renderer.taskview.output.toolCalls`
- `renderer.taskview.output.toolCount`

`display.minimal.running.reading` 只被一个测试 fixture 引用，生产实现没有引用；它很可能本应由漏提交的 file presentation helper 使用。修复缺文件后重新审计，未使用的键应删除，避免让翻译者维护不可达文案。

### P3-2：同一概念存在 `verbose` 和 `detailed` 两套内部枚举及适配逻辑

GUI 使用 `minimal | detailed`，TUI 类型和配置使用 `minimal | verbose`，命令对用户展示 `detailed`，解析时再映射到 `verbose`（`src/main/tui/display.ts:14-15`、`src/main/tui/commands/display.ts:17-22`）。schema 还要预处理 `full/detailed` 等历史别名。

兼容旧配置可以理解，但新代码应选一个领域层 canonical enum，只在旧配置迁移和 UI 边界转换。否则设置、状态栏、快捷键、命令、GUI 和测试长期都要记住两套词汇。

### P3-3：新增链接右键菜单只支持鼠标，缺少菜单语义和键盘关闭

`src/renderer/components/taskview.js:3588-3692` 新建了一个 DOM 菜单，但没有 `role="menu"/"menuitem"`、焦点进入、方向键导航、Escape 关闭或触发元素的键盘等价操作；复制失败也被静默吞掉。它对鼠标用户可用，但对键盘和辅助技术不友好。

建议复用或抽取统一 context-menu 控件，提供定位、焦点、Escape、屏幕边界、销毁和错误反馈的一致实现。当前仓库多个 renderer 各自实现 context menu，本次继续复制会加重这一重复模式。

## 5. 逻辑与边界条件审查

| 场景                         | 当前状态                                       | 评价/要求                                                                                          |
| ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 新安装缺省配置               | GUI/TUI 均默认 minimal                         | 合理，schema 有默认值                                                                              |
| 旧 TUI full reasoning 配置   | 有迁移到 verbose 的逻辑                        | 方向合理，已有 schema 测试                                                                         |
| `/display detailed` 与快捷键 | 命令持久化，快捷键可做任务级切换               | 用户语义基本合理，但 `verbose/detailed` 命名应收敛                                                 |
| minimal 下完整 reasoning     | 配置页禁用、命令提示先切 detailed              | 行为一致，新增文案已本地化                                                                         |
| Config 页面焦点              | 没有新增输入区 prompt；使用现有全屏 ConfigForm | 符合 `tui_prompt_queue.md` 的模式隔离；通用 `setItemDisabled` 若未来禁用当前焦点项，应主动迁移焦点 |
| 工具无 presentation          | core 回退到工具名                              | 合理，避免 renderer 硬编码所有内置工具                                                             |
| 插件 presentation 异常/过长  | core 捕获异常并裁剪字符、参数和 resource       | 设计较好；应补非法 locale key 和协议版本测试                                                       |
| 历史任务工具已不可用         | presentation 随任务持久化                      | 合理，已有测试                                                                                     |
| 超大工具结果                 | 摘要不进快照，详情按需 IPC                     | 架构方向正确，但详情实现漏提交，无法验证截断和内存上限                                             |
| 终态 assistant               | 增加完整 snapshot/replace                      | 能避免只补最后 part；已有单测                                                                      |
| 流式重复/乱序/丢包           | renderer 有长度启发式，平台缓冲缺失            | 未形成可审查的闭环，是本 PR 最大未验证边界之一                                                     |
| 新订阅者重连                 | 先装 listener 再 sync                          | 顺序正确，但 sync 错误广播给全部订阅者                                                             |
| 非法/负 ACK                  | 只检查 `Number.isSafeInteger`                  | 应额外要求 `sequence >= 0`，并测试大于已发送序列的 ACK                                             |
| task view 销毁               | 取消订阅并清详情缓存                           | 基本合理                                                                                           |
| reasoning inline/bubble      | 设置仍在，消费逻辑被删除                       | 明确回归                                                                                           |
| 图片处理底层异常             | 完整 stack 进入用户/模型错误                   | 不可接受，应日志与产品错误分层                                                                     |
| 中英文文案                   | 主要新文案均同时加入 zh/en                     | 本地化覆盖总体良好；存在 3 个确定死键                                                              |
| 小窗口/移动端/缩放           | CSS 改动 843 行                                | 因 HEAD 无法构建，未完成实际视觉验收；合入前需截图回归                                             |

## 6. 架构检视

### 合理部分

1. `ToolCallPresentation` 放在 aikernel 公共类型中，由工具所有者声明 displayName/summary/resource，而不是让 GUI 根据工具名猜语义。这个依赖方向正确，也降低 renderer 对内置应用的耦合。
2. `sanitizeToolCallPresentation` 在 core 统一做边界限制和资源动作白名单，比各工具自行拼对象更可靠。
3. `src/common/output-duration.ts` 是无 UI 依赖的纯格式化函数，TUI 与 GUI 共用且有测试，没有重复造轮子。
4. `src/renderer/components/taskview-output.ts` 把输出分组/可见性从 DOM 操作中抽成纯函数，明显提升可测试性。
5. 工具详情从主任务快照中移除并改成按需读取，能控制 IPC 负载和前端内存，方向正确。

### 需要改进部分

1. 平台协议闭环不完整：serializer、buffer、detail locator 都不在提交中，导致 core -> platform -> preload -> renderer 的主链断裂。
2. `TaskView` 本身已承担历史分页、流式更新、工具详情缓存、文件/浏览器路由、右侧栏、右键菜单、输出模型和 DOM morph。本 PR 又在该文件净增加大量职责。建议把 output controller、tool detail controller 和 context menu 拆成独立模块。
3. `syncTaskUpdate` 绕过 subscriber 边界，通过 TaskState 全局发布回放，属于 API 语义与实现不一致。
4. 新的 output canonical value 分裂为 GUI `detailed` 与 TUI `verbose`，把兼容成本扩散到命令、schema、设置页和测试。
5. `check:architecture` 通过只说明没有命中现有层级白名单；它既不检查导入文件是否存在，也不检查 renderer/platform 的职责边界，不能作为架构完整性证明。

## 7. 是否重复造轮子、是否有死代码

### 没有重复造轮子的部分

- 时长格式化正确抽到了 common，而不是 TUI/GUI 各写一套。
- 工具展示信息使用统一 presentation 协议和 sanitizer，而不是继续扩大 renderer 的工具名 switch。
- 新 output model 使用纯数据模型，复用了现有 i18n 和 DOM sanitizer/Markdown 渲染链路。

### 重复或可收敛部分

- `verbose/detailed` 是同一概念的两套词汇和转换代码。
- GUI/TUI 分别实现“工具名压缩、过程摘要、工具聚合”规则；视觉载体不同可以接受，但摘要领域规则应尽量共享，否则两端文案和截断会漂移。
- 链接右键菜单继续复制仓库中已有的 ad-hoc context menu 模式，建议抽通用控件。
- 各自绕过 marked-katex 包 exports，是同一依赖兼容问题的两套环境补丁，应在独立变更中用一个明确策略和构建测试约束。

### 死代码/不可达内容

- 3 个确定无引用的 renderer locale key，见 P3-1。
- `display.minimal.running.reading` 在已提交生产代码中不可达，疑似随漏提交 helper 一起丢失。
- PR 中提交的代码审查 Markdown 不参与产品、构建或测试，不应成为功能交付的一部分。
- 因 5 个模块漏提交，所有依赖它们的新增入口在 clean checkout 中事实上不可达；这不是普通“潜在死代码”，而是交付不完整。

## 8. 用户体验检视

### 正向评价

- 默认 minimal 能明显降低长工具链的屏幕噪声；保留 detailed 让高级用户查看过程，产品方向合理。
- TUI 有 `/display`、快捷键、状态栏提示和配置页入口，发现性和操作效率较好。
- GUI 把最终结果与过程折叠分离，并按需加载工具详情，符合用户先看结论、需要时下钻的使用顺序。
- 运行态有 reasoning/tool/working 状态，避免 minimal 模式看起来卡死。

### 主要问题

- 气泡式 reasoning 设置“保存成功但无效果”会直接损害用户信任。
- 当前版本无法启动已提交的应用，因此任何静态 UX 评价都不能替代真实可用性验证。
- 过程摘要截断为固定字符数，需对长英文单词、CJK、窄窗口、200% 缩放做截图检查。
- 工具详情加载失败只有统一文案，没有重试按钮；短暂 IPC 失败后用户只能重新折叠/刷新任务。
- 链接菜单缺少键盘和辅助技术支持。

建议 GUI 能构建后至少验证：`1280x720`、`1440x900`、窄窗口、200% 缩放、浅色/深色、中/英文、长路径、长 URL、50+ 工具、超大结果、运行中切换模式、重连及历史任务。

## 9. 测试质量与实际验证结果

### 测试评价

新增测试数量很多，覆盖 output model、时长、TUI 命令/配置、工具 presentation 和终态 snapshot，这是优点。但有一部分 renderer 测试是读取源码后断言字符串顺序，例如 `preload-task-toolset-guard.test.ts:23-34`；它能防止文本被删，却不能验证双订阅者、ACK、回放目标或真实 IPC 行为。

最关键的缺口：

1. 没有 clean-checkout build 测试，否则 5 个缺失模块不可能通过。
2. 没有 GUI inline/bubble 兼容测试。
3. 没有双订阅者定向 sync 测试。
4. 没有原始图片 stack 不进入 tool result 的隐私测试。
5. 平台 buffer/detail 的测试文件没有进入提交。
6. 没有可运行应用的截图/交互测试。

### 干净 HEAD 验证

| 命令                         | 结果     | 说明                                                                                        |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `npm run build-cli`          | 失败     | 13 个 unresolved imports，file/search helper 缺失                                           |
| `npm run build`              | 无法完成 | 沙箱内 tsx IPC 先遇到 EPERM；直接执行 Electron bundler 可复现缺模块失败                     |
| `electron-vite build`        | 失败     | 首个错误为 `src/platforms/electron-tool-call-detail.js` 不存在                              |
| `npm test -- --runInBand`    | 失败     | 273 suites：254 passed / 19 failed；2502 tests：2477 passed / 25 failed；主要为缺失模块扩散 |
| `npm run test:node`          | 失败     | 沙箱外可启动；包含缺失 file helper 导致的失败，也包含与本 PR 无法可靠归因的仓库/环境失败    |
| `npm run lint`               | 通过     | 0 errors，411 warnings；新增 `messages.ts:430` 有 `_tool` unused warning                    |
| `npm run check:architecture` | 通过     | 检查 525 个文件；该检查不解析导入目标是否存在                                               |
| `git diff --check`           | 通过     | 未发现空白错误                                                                              |

## 10. 逐文件修改必要性

判定说明：**必要** = 属于功能主链；**条件必要** = 设计上合理但应在修复/拆分后保留；**不必要/应拆分** = 与本功能无直接关系或不应进入产品 PR；**测试** = 对应行为的测试，仍可能有覆盖缺口。

### 根目录、公共契约与本地化

| 文件                                | 判定     | 逐文件说明                                                                                 |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `PR_429_INDEPENDENT_CODE_REVIEW.md` | 不必要   | 审查材料不参与产品交付；会增加 PR 噪声，应移出功能提交。本报告未读取其正文。               |
| `electron.vite.config.ts`           | 应拆分   | marked-katex 的 Node ESM 兼容修复不由输出模式引起；硬编码包内部 CJS 路径需要独立构建测试。 |
| `jest.config.ts`                    | 应拆分   | 与上项配套的测试环境 workaround，应该和依赖兼容修复放在独立 PR。                           |
| `packages/plugin-sdk/src/index.ts`  | 条件必要 | 插件若要声明 presentation，SDK 必须导出类型；属于合理公共 API 扩展。                       |
| `src/common/output-duration.ts`     | 必要     | GUI/TUI 共用的纯时长格式化，边界清楚且避免重复实现。                                       |
| `src/locale/en-us.ts`               | 必要     | 新功能英文文案；需删除无引用键并补齐最终行为对应文案。                                     |
| `src/locale/zh-cn.ts`               | 必要     | 新功能中文文案；同上。                                                                     |

### AI kernel 与协议

| 文件                                     | 判定         | 逐文件说明                                                                                         |
| ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `src/main/aikernel/interaction/tools.ts` | 条件必要     | 给 askUser 提供领域展示名，职责归属正确。                                                          |
| `src/main/aikernel/messages.ts`          | 必要         | ToolCall timing、presentation、轻量 render JSON 是主协议；改动面关键，应依赖完整 serializer 测试。 |
| `src/main/aikernel/planning/tools.ts`    | 条件必要     | 给 subtask 工具添加展示元数据，避免 GUI 猜工具名；可随 presentation 接入拆分。                     |
| `src/main/aikernel/skill.ts`             | 条件必要     | skill 工具拥有自身 presentation，依赖方向合理；保留现有 ESM 后缀一致性需另行整理。                 |
| `src/main/aikernel/states/tasks.ts`      | 必要但有缺陷 | 推送 timing/终态 snapshot 是主链；`sendSubscriptionFeedback` 被 sync 全局广播的问题必须修复。      |
| `src/main/aikernel/task/tools.ts`        | 条件必要     | task 工具 presentation 接入合理。                                                                  |
| `src/main/aikernel/task/types.ts`        | 必要         | 扩展 renderer 更新协议；应写清 delta/reset/length 不变量。                                         |
| `src/main/aikernel/tool-presentation.ts` | 必要         | presentation sanitize/resolve 的统一入口，架构位置合理。                                           |
| `src/main/aikernel/tool.ts`              | 必要         | BaseTool 暴露 presentation 扩展点，避免具体 UI 与工具耦合。                                        |
| `src/main/aikernel/types/index.ts`       | 必要         | 公共类型出口同步。                                                                                 |
| `src/main/aikernel/types/messages.ts`    | 必要         | 持久化/渲染消息契约同步。                                                                          |
| `src/main/aikernel/types/tools.ts`       | 必要         | presentation 和插件上下文的公共类型定义。                                                          |

### 应用工具接入

| 文件                                                        | 判定               | 逐文件说明                                                                        |
| ----------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `src/main/applications/browser/tools.ts`                    | 条件必要           | URL/导航 presentation 属于 browser owner；改动 80 行，应和领域接入单独审查。      |
| `src/main/applications/builtin/skills/use-harmony/tools.ts` | 应拆分一部分       | presentation 相关改动可保留；HDC 新旧格式解析属于独立兼容修复，应单独提交和验证。 |
| `src/main/applications/filemgr/image.ts`                    | 不应按现状保留     | 原始 stack 透传与输出模式无关且有隐私风险；应改为内部日志。                       |
| `src/main/applications/filemgr/tools.ts`                    | 条件必要但当前阻断 | file presentation/详情属于主功能，但 helper 漏提交；图片 stack 拼接必须删除。     |
| `src/main/applications/pluginmgr/runtime/tool-provider.ts`  | 必要               | 把插件声明的 presentation 接到 BaseTool，属于 SDK 功能闭环。                      |
| `src/main/applications/search/tools/academicSearch.ts`      | 条件必要但当前阻断 | 切到统一 SearchPresentationTool 合理，但基类文件漏提交。                          |
| `src/main/applications/search/tools/baidu.ts`               | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/baseAcademicEngine.ts`  | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/bing.ts`                | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/bocha.ts`               | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/brave.ts`               | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/duckduckgo.ts`          | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/exa.ts`                 | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/manage.ts`              | 条件必要但当前阻断 | 搜索管理工具展示接入合理，但 helper 漏提交。                                      |
| `src/main/applications/search/tools/tavily.ts`              | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/webSearch.ts`           | 条件必要但当前阻断 | 同上。                                                                            |
| `src/main/applications/search/tools/webfetch.ts`            | 条件必要但当前阻断 | URL/resultFormat presentation 合理，但 helper 漏提交。                            |
| `src/main/applications/terminal/tools.ts`                   | 条件必要           | 命令工具 summary/activity 属于领域层；应确认不会把完整命令放入轻量快照。          |
| `src/main/applications/todomgr/tools.ts`                    | 条件必要           | todo 工具展示名接入合理。                                                         |
| `src/main/main.ts`                                          | 必要但当前阻断     | 新增工具详情、sync/ack IPC 属主进程边界；detail 模块缺失且 sync 目标错误。        |

### TUI

| 文件                                                | 判定       | 逐文件说明                                                                                    |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `src/main/tui/commands/display.ts`                  | 必要       | 提供可发现的 `/display` 命令；应统一 detailed/verbose canonical 值。                          |
| `src/main/tui/commands/index.ts`                    | 必要       | 注册新命令。                                                                                  |
| `src/main/tui/commands/reason.ts`                   | 必要       | minimal 下禁止 full reasoning 并给出切换提示，用户反馈明确。                                  |
| `src/main/tui/components/config/displayConfig.ts`   | 必要       | 配置输出模式并联动禁用 reasoning；符合全屏 config 模式。                                      |
| `src/main/tui/components/config/form.ts`            | 条件必要   | disabled 支持为配置页所需；共享组件应在禁用当前 active item 时修复焦点。                      |
| `src/main/tui/components/config/shortcutsConfig.ts` | 必要       | 暴露输出模式快捷键配置。                                                                      |
| `src/main/tui/components/dashboard.ts`              | 必要       | 把模式应用到 task view/dashboard。                                                            |
| `src/main/tui/components/help.ts`                   | 必要       | 新命令/快捷键发现入口。                                                                       |
| `src/main/tui/components/input.ts`                  | 必要       | 状态栏展示当前输出模式及切换提示。                                                            |
| `src/main/tui/components/taskview.ts`               | 必要但过大 | TUI minimal/detailed 核心渲染；359 行改动集中在既有大组件，应抽共享摘要策略并补宽度边界测试。 |
| `src/main/tui/display.ts`                           | 必要       | 输出模式配置读写的集中入口；应收敛 verbose/detailed 命名。                                    |
| `src/main/tui/entry.ts`                             | 必要       | 快捷键、任务级模式和视图刷新接线；未新增违反 prompt queue 的弹窗。                            |
| `src/main/utils/setting.ts`                         | 必要       | schema、默认值、迁移和快捷键；兼容逻辑需保持单向、幂等。                                      |

### Electron 平台与 GUI

| 文件                                         | 判定              | 逐文件说明                                                                          |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `src/platforms/electron.ts`                  | 必要但当前阻断    | 订阅更新需要缓冲/序列化，但 `ElectronTaskUpdateBuffer` 未提交。                     |
| `src/renderer/components/settingpanel.js`    | 必要但存在回归    | 新 output mode 选项合理；保留的 reasoning bubble 设置已无消费者。                   |
| `src/renderer/components/taskartifacts.ts`   | 条件必要          | process 中的资源动作需要右侧栏能力；改动应与工具 resource 行为测试配套。            |
| `src/renderer/components/taskview-output.ts` | 必要              | 纯 output model 是合理拆分；流式 merge 需以完整平台合同验证。                       |
| `src/renderer/components/taskview.js`        | 必要但需拆分/修复 | GUI 主功能所在；同时承担过多职责，且删除 bubble 行为、加入无障碍不足的链接菜单。    |
| `src/renderer/preload.js`                    | 必要              | 订阅 listener-before-sync、ACK 和详情 IPC 桥接；源码字符串测试不足以证明并发正确。  |
| `src/renderer/styles/custom.css`             | 必要但需视觉验收  | 新过程/最终结果/详情样式；改动 843 行且删除 bubble CSS，必须构建后截图回归。        |
| `src/renderer/theme/theme-dark.css`          | 条件必要          | 若新样式统一使用 CSS variables，删除旧 dark override 可合理；需深色截图证明无回归。 |

### 测试文件

| 文件                                                           | 判定               | 逐文件说明                                                              |
| -------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- |
| `src/tests/ut/aikernel/assistant-think-tags.test.ts`           | 测试               | 覆盖 reasoning 计时/think tag 边界，必要。                              |
| `src/tests/ut/aikernel/task-subscription-feedback.test.ts`     | 测试但不足         | 覆盖终态 snapshot 和 subscriber 异常；缺双订阅者定向 sync。             |
| `src/tests/ut/aikernel/tool-call-hook-order.test.ts`           | 测试               | 工具计时不应改变 hook 顺序，回归价值高。                                |
| `src/tests/ut/aikernel/tool-call-render-json.test.ts`          | 测试但当前不可运行 | 覆盖轻量 payload/presentation；直接导入漏提交 serializer。              |
| `src/tests/ut/common/output-duration.test.ts`                  | 测试               | 覆盖共享格式化边界，必要。                                              |
| `src/tests/ut/node/builtin/use-harmony.test.ts`                | 测试/应拆分        | HDC 新格式测试有效，但属于独立设备兼容修复。                            |
| `src/tests/ut/node/filemgr/diff-grep-render.test.ts`           | 测试               | 覆盖 grep 详情筛选；当前因 file helper 缺失无法运行。                   |
| `src/tests/ut/pluginmgr/tool-provider.test.ts`                 | 测试               | 覆盖插件 presentation 和渲染上下文，必要。                              |
| `src/tests/ut/renderer/gui-output-model.test.ts`               | 测试               | 纯模型分组/可见性测试，必要且结构清晰。                                 |
| `src/tests/ut/renderer/preload-task-toolset-guard.test.ts`     | 测试但偏弱         | 新增 ACK/sync 仅做源码字符串断言，应补真实 mock IPC 行为测试。          |
| `src/tests/ut/renderer/settingpanel-config-management.test.ts` | 测试               | 覆盖新 output setting 保存；还应断言 bubble setting 对 task view 生效。 |
| `src/tests/ut/renderer/taskartifacts-goal-disclosure.test.ts`  | 测试               | 右侧资源/goal 展开状态回归，条件必要。                                  |
| `src/tests/ut/renderer/taskview-message-queue.test.ts`         | 测试               | 更新排队与 reload 时序重要；需和平台序列测试闭环。                      |
| `src/tests/ut/renderer/taskview-output-mode.test.ts`           | 测试但过大         | 覆盖面广，但单文件新增近 1500 行；当前提交没有 bubble 模式行为测试。    |
| `src/tests/ut/settings/schema.test.ts`                         | 测试               | 默认值、别名和迁移测试，必要。                                          |
| `src/tests/ut/tui/commands/display.test.ts`                    | 测试               | `/display` 参数、持久化和任务模式，必要。                               |
| `src/tests/ut/tui/commands/reason.test.ts`                     | 测试               | minimal/detailed 与 reasoning 的交互，必要。                            |
| `src/tests/ut/tui/components/config/displayConfig.test.ts`     | 测试               | 配置页联动禁用与保存，必要。                                            |
| `src/tests/ut/tui/components/config/form.test.ts`              | 测试但不足         | 覆盖 disabled 跳过；应补“当前项被动态禁用后焦点迁移”。                  |
| `src/tests/ut/tui/components/config/shortcutsConfig.test.ts`   | 测试               | 新快捷键配置，必要。                                                    |
| `src/tests/ut/tui/components/dashboard.test.ts`                | 测试               | dashboard 模式传播，必要。                                              |
| `src/tests/ut/tui/components/help.test.ts`                     | 测试               | 新命令/快捷键可发现性，必要。                                           |
| `src/tests/ut/tui/components/input-statusbar.test.ts`          | 测试               | 状态栏展示与宽度行为，必要。                                            |
| `src/tests/ut/tui/components/taskview.test.ts`                 | 测试               | TUI 主渲染覆盖充分但体量很大；需确保 snapshot/窄宽度失败易定位。        |
| `src/tests/ut/tui/entry.test.ts`                               | 测试               | 快捷键与任务级状态接线，必要。                                          |

## 11. 建议修复顺序

1. 补齐 5 个缺失模块及其测试，在 clean checkout 中先让 `build-cli`、Electron build、Jest 恢复。
2. 修复 `syncTaskUpdate` 为定向回放，并补双订阅者/重连/ACK/乱序测试。
3. 决定并恢复 `gui_reason_display` 产品合同，补 inline/bubble 行为测试。
4. 删除图片错误的 stack 外泄，改为内部日志和脱敏错误。
5. 明确定义 delta/reset/length/sequence 协议，补平台 buffer 表驱动测试。
6. 拆分 HDC、marked-katex、链接菜单和审查文档等非核心变更。
7. 清理死 locale key，统一 detailed/verbose canonical 值。
8. 构建可运行 GUI 后完成中英文、主题、缩放、窄窗口、长内容和运行中切换的视觉/交互验收。

在以上步骤完成前，本 PR 不满足仓库 AGENTS.md 要求的 `npm run build-cli`、`npm run build` 和相关测试通过条件。

## 12. 工作区回退与缺失文件补提交说明（2026-08-28）

后续复核中按维护方要求恢复了旧的任务更新处理机制：移除了 `syncTaskUpdate` 同步回放入口，并进一步移除了 delta/ACK 传输优化。`electron-task-update-buffer.ts`、`electron-task-update-render.ts` 及其专用测试不再作为本次提交内容；Renderer 改为接收完整任务更新快照，`streaming` 仅作为显示布局标记。

仍被现有代码直接导入、需要进入版本库的缺失模块为：

1. `src/main/aikernel/task/update-render.ts`（恢复完整快照的 Electron 序列化入口）
2. `src/platforms/electron-tool-call-detail.ts`
3. `src/main/applications/filemgr/tool-presentation.ts`
4. `src/main/applications/search/tools/presentation.ts`

因此原 P0-1 中关于“5 个模块全部缺失”的结论适用于 PR 原始提交；在本次回退后，两个 delta/ACK 模块已被有意删除，以上四个模块会随修订提交补齐。
