# pi-tui 迁移测试方案

本文档定义 OpenDesk 从 `@mariozechner/pi-tui` 迁移到 `@earendil-works/pi-tui` 后的测试矩阵。核心目标不是证明替换后的代码“能编译”，而是证明迁移完成后 TUI 各功能、终端展示、焦点、输入和应用级页面仍然正常可用。

## 口径修正

此前把专项测试矩阵的“结构已落地”表述为“测试方案已落地”，这个口径不准确。结构性检查只能证明规则、Gate 和证据要求被列出，不能证明用户行为已经可用。

更新后的状态定义如下：

| 状态                     | 含义                                                            | 是否可关闭迁移             |
| ------------------------ | --------------------------------------------------------------- | -------------------------- |
| `matrix_defined`         | 规则、Gate、场景和证据文件已定义                                | 否                         |
| `static_passed`          | 依赖、导入、mock、文档和构建类静态门禁通过                      | 否                         |
| `baseline_recorded`      | 当前旧 pi-tui 版本下的 Gate 4-7 行为 baseline 已记录            | 否                         |
| `post_behavior_recorded` | 升级后的 Gate 4-7 行为结果已记录                                | 否                         |
| `behavior_compared`      | baseline 与升级后结果已比较，同一套功能行为场景在两个阶段均通过 | 是，前提是 Gate 0-3 也通过 |
| `blocked`                | 任一必需 Gate 失败或缺少证据                                    | 否                         |

## 专项测试组织

依赖升级新增测试先放在独立目录，不混入现有 Jest 或 node runner 常规矩阵：

- 专项目录：`src/tests/pi-tui-migration/`
- 结构校验：`npm run test:pi-tui-migration:structure`
- 完整门禁：`npm run test:pi-tui-migration`
- 当前旧版本行为 baseline 执行并生成结果：`npm run test:pi-tui-migration:behavior:baseline`
- 升级后行为结果执行并生成结果：`npm run test:pi-tui-migration:behavior:post`
- baseline/post 行为比较：`npm run test:pi-tui-migration:behavior`

后续如需把稳定用例迁入 `src/tests/ut/**` 或 `src/tests/ut/node/**`，必须先补迁入评估，说明执行成本、失败责任、是否属于长期产品行为契约，以及是否会让常规测试矩阵变慢或变脆。

## Gate 定义

| Gate   | 类型         | 必须证明的内容                                            |
| ------ | ------------ | --------------------------------------------------------- |
| Gate 0 | 盘点状态     | replacement map、全仓扫描和未分类项归零                   |
| Gate 1 | 静态迁移     | 依赖包名、源码导入、Jest mapper、文档示例已迁移           |
| Gate 2 | 构建测试     | `npm run build-cli`、`npm run build`、`npm test` 必须通过 |
| Gate 3 | API 契约     | keybinding API、action id、mock 和类型契约可用            |
| Gate 4 | TUI 行为     | 主输入、prompt 队列、焦点恢复、overlay 行为可用           |
| Gate 5 | 应用级 TUI   | Calendar、Mailbox、Skill Manager、Channel Manager 可操作  |
| Gate 6 | 真实终端渲染 | resize、中文/IME、ANSI/Markdown、长流式输出、键盘协议可用 |
| Gate 7 | 偶发崩溃复测 | 已知用户反馈 TUI 偶发崩溃有迁移前后重复执行复测结论       |

Gate 4-7 不能只依赖 TypeScript、Jest mock 或静态 API 检查。它们必须有真实终端或 PTY 行为结果，并分两阶段记录：

- 当前旧版本 baseline：`docs/reports/pi_tui_migration_inventory/20260706/behavior_baseline_current.json`
- 升级后结果：`docs/reports/pi_tui_migration_inventory/20260706/behavior_post_migration.json`

完整门禁会读取并比较这两个文件。文件缺失、场景缺失、缺少执行环境或证据，都会失败。功能行为场景使用同一套标准，baseline 与升级后均必须为 `passed`。用户反馈的偶发崩溃不降低功能断言标准，应作为 Gate 7 的稳定性/重复执行复测记录。

执行器说明：

- `test:pi-tui-migration:behavior:baseline` 和 `test:pi-tui-migration:behavior:post` 使用同一个 PTY runner。
- runner 读取 `src/tests/pi-tui-migration/behavior-smoke-scenarios.json`，创建临时 workspace 和临时 OpenDesk config，通过 `/usr/bin/script` 分配真实 PTY，启动 `dist/cli/opendesk-debug`。
- runner 会发送场景定义的按键和 slash command，采集 transcript 到 `docs/reports/pi_tui_migration_inventory/20260706/behavior_evidence/<phase>/`，再生成对应 JSON 结果。
- 因此执行 baseline 前必须先完成 `npm install` 和 `npm run build-cli`；缺少构建产物时 baseline 命令必须失败。
- runner 的自动化范围是无外部服务依赖的 PTY smoke：启动、真实终端渲染、编辑器键位、Help/TaskSwitcher/overlay、应用级入口打开/关闭、焦点返回和重复无崩溃。它不替代 Calendar/Mailbox 等需要真实账号或业务数据的深层人工/E2E 记录。
- 对 Gate 6 的 CJK/ANSI/多尺寸渲染场景，runner 会在完成渲染采样后由 harness 发送 SIGTERM 结束进程，并在 JSON 中标记 `controlledTermination: true`。这只表示测试 harness 控制结束，不等同于应用崩溃或正常用户退出。

## 行为场景

行为/e2e 场景定义在：

`src/tests/pi-tui-migration/behavior-smoke-scenarios.json`

最低场景包括：

- 主输入与 Editor：输入、提交、换行、补全、Tab、Shift+Tab、Ctrl+J。
- Prompt 与焦点队列：Permission、askUser、exitPlanMode、notice、TaskSwitcher。
- 应用级 TUI：Calendar、Mailbox、Skill Manager、Channel Manager。
- 真实终端渲染：80x24、120x30、160x40、运行中 resize、中文/IME、ANSI、Markdown、长输出。
- 用户反馈复测：每条已知偶发崩溃反馈必须有来源、复现步骤、重复执行次数、迁移前状态、迁移后结果和归因。

自动 baseline smoke 已经可以通过 `npm run test:pi-tui-migration:behavior:baseline` 生成。深层应用业务可用性仍需要在 `tui_migration_verification_record.md` 中记录执行环境、账号/数据前提、步骤和证据，不能仅凭 smoke 通过关闭迁移。

## 通过标准

迁移不能因为以下情况被标记完成：

- 只完成 package rename 或 import rename。
- 只通过结构校验。
- 只通过 TypeScript 编译。
- 只通过 mock 测试。
- Gate 4-7 没有真实行为证据。
- 用户反馈的偶发崩溃没有重复执行复测记录。

最终关闭条件：

1. `npm run test:pi-tui-migration:structure` 通过。
2. `npm run test:pi-tui-migration:behavior:baseline` 通过。
3. `npm run test:pi-tui-migration:behavior:post` 通过。
4. `npm run test:pi-tui-migration:behavior` 通过。
5. `npm run test:pi-tui-migration` 通过。
6. `npm run build-cli`、`npm run build`、`npm test` 通过。
7. replacement map 中所有可执行项达到 `verified`、`retained_verified`，或有明确 deferred 归属和理由。
