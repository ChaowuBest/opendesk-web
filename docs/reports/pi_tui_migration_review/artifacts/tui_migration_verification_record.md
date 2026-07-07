# pi-tui 迁移验证记录

日期：2026-07-07
提交号：bfde37be 之后的 Node 版本策略固化变更
执行人或执行进程：Codex CLI migration run
终端环境：Darwin 25.5.0, Node v22.22.1, npm 10.9.4, script PTY
自动 smoke result：通过，见 `behavior_post_migration.json` 与 `acceptance_fake_model.json`
深层 E2E 环境前提：Calendar 已使用真实本地数据只读验证；Mailbox 已使用临时配置 + QQ 邮箱授权码完成真实账号连接和 TUI 验证；reviewer 重点验收已通过 fake OpenAI-compatible 模型覆盖复杂任务流式渲染、动态 resize、`/command`/`/skillname` 补全、快捷键和 overlay 焦点；Skill Manager、Channel Manager 仍需要业务凭据或真实在线插件数据补充。

## Gate 0：盘点与状态

- replacement map 校验：已补齐 `replacement_map.json`，并通过 `npm run test:pi-tui-migration:structure` 校验其 rule/status 集合与 `migration-test-matrix.json` 完全一致。
- replacement map 状态汇总：45 项规则均已更新状态；`verified = 35`，`verified_with_deferred_business_e2e = 10`，`migrated_unverified = 0`，`verification_failed = 0`，`not_migrated = 0`。
- 新增签名变化规则：`combined-autocomplete-provider-get-suggestions-options`，覆盖新 pi-tui `CombinedAutocompleteProvider.getSuggestions(..., options)` 的 `signal/force` 参数要求。
- scan_failed：沿用盘点报告结论，未在本次版本切换中新增扫描失败项。
- unclassified：沿用盘点报告结论，未在本次版本切换中新增未分类项。
- rg_lines_missing_from_reports：本次版本切换命中范围已进入当前报告和迁移测试记录。

## Gate 1：静态迁移

- package.json：已从 `@mariozechner/pi-tui@^0.58.4` 切换为 `@earendil-works/pi-tui@^0.80.3`。
- 源码导入：应用代码和相关 UT 已直接从 `@earendil-works/pi-tui` 导入；临时 `src/main/tui/pi-tui.ts` adapter 已删除。
- Jest mapper：已从旧包名 mapper 切换为 `@earendil-works/pi-tui` mapper 或包级 mock。
- 文档示例：不再教用户直接导入旧包；迁移事实记录以直接导入新包为最终状态。

## Gate 2：构建与常规测试

| 命令                                                                                                                                                      | 结果 | 证据                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `npm install --package-lock=false`                                                                                                                        | 通过 | Node v22.22.1 下依赖树解析为 `@earendil-works/pi-tui@0.80.3`，无 pi-tui engine warning   |
| `npm run build-cli`                                                                                                                                       | 通过 | CLI production/debug bundle 生成成功                                                     |
| `npm run build`                                                                                                                                           | 通过 | Electron main/preload/renderer build 生成成功                                            |
| `npm run test:pi-tui-migration:structure`                                                                                                                 | 通过 | 5/5 pass                                                                                 |
| `node --experimental-vm-modules node_modules/jest/bin/jest.js --selectProjects unit --runTestsByPath src/tests/ut/tui/components/input-statusbar.test.ts` | 通过 | 4/4 pass                                                                                 |
| `npm run test:pi-tui-migration:behavior:post -- --repeat 1`                                                                                               | 通过 | `docs/reports/pi_tui_migration_review/artifacts/behavior_post_migration.json`            |
| `npm run test:pi-tui-migration:channel-fixture`                                                                                                           | 通过 | `docs/reports/pi_tui_migration_review/artifacts/channel_fixture_e2e_post_migration.json` |
| `npm run test:pi-tui-migration:mailbox-real`                                                                                                              | 通过 | `docs/reports/pi_tui_migration_review/artifacts/mailbox_real_e2e_post_migration.json`    |
| `npm run test:pi-tui-migration:acceptance:fake`                                                                                                           | 通过 | `docs/reports/pi_tui_migration_review/artifacts/acceptance_fake_model.json`              |
| `npm run test:pi-tui-migration:acceptance:real`                                                                                                           | 跳过 | 未提供 `/tmp/opendesk-review-real-model.env` 或 `OPENDESK_REVIEW_MODEL_*` 环境变量       |
| `npm run test:pi-tui-migration`                                                                                                                           | 通过 | 17/17 pass                                                                               |
| `npm run lint`                                                                                                                                            | 通过 | 0 errors, existing warnings remain                                                       |
| `npm run test:node`                                                                                                                                       | 失败 | 3 个 filemgr/storage 相关失败，见风险项                                                  |
| `npm test`                                                                                                                                                | 失败 | `src/tests/ut/platforms/fetch.test.ts` 2 个既有失败，见风险项                            |

## Gate 3：API 与快捷键契约

- keybinding replacement APIs：新包移除了旧导出 `EditorKeybindingsManager`、`getEditorKeybindings`、`setEditorKeybindings`，提供通用 `KeybindingsManager`、`getKeybindings`、`setKeybindings`。生产代码已迁移到新 API，并直接从 `@earendil-works/pi-tui` 导入，不再保留本地兼容 adapter。
- action id mapping：旧版 `EditorAction` 已从生产代码移除。OpenDesk 仍需覆盖的快捷键行为直接使用新命名空间 action id，例如 `tui.editor.deleteCharBackward`、`tui.select.up`、`tui.select.down`、`tui.select.confirm`、`tui.select.cancel`。
- overlay focus contract：新包 `OverlayHandle.unfocus({ target })` 用于 overlay 内部子控件焦点释放。`/mail` 与 `/calendar` 已避免在 overlay 内直接 `tui.setFocus(child)`，防止新包 overlay focus restore 将焦点恢复到 overlay 本体而导致 SelectList 上下键和 Esc 失效。
- mock 更新：Jest mapper 已指向新包名，现有 `pi-tui-mock.ts` 继续承载测试隔离。

## Gate 4：TUI 组件与 prompt/focus 行为

| 场景                            | 结果 | 证据                                                                          |
| ------------------------------- | ---- | ----------------------------------------------------------------------------- |
| `gate4-main-input-editor-flow`  | 通过 | `behavior_evidence/post_migration/gate4-main-input-editor-flow-120x30-1.log`  |
| `gate4-prompt-focus-queue-flow` | 通过 | `behavior_evidence/post_migration/gate4-prompt-focus-queue-flow-120x30-1.log` |

## Gate 5：应用级 TUI 行为

| 场景                               | 结果 | 证据                                                                             |
| ---------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `gate5-calendar-mailbox-flow`      | 通过 | `behavior_evidence/post_migration/gate5-calendar-mailbox-flow-120x30-1.log`      |
| `gate5-skill-channel-manager-flow` | 通过 | `behavior_evidence/post_migration/gate5-skill-channel-manager-flow-120x30-1.log` |

说明：自动 PTY smoke 只证明应用级入口、基础导航、关闭和焦点恢复可用；Calendar、Mailbox、Channel Manager 等依赖真实账号或业务数据的深层功能仍需独立 E2E 记录。

### Mailbox 真实账号 E2E

2026-07-07 使用 QQ 邮箱账号的授权码在临时 OpenDesk config 中执行真实 Mailbox E2E。授权码只从本机环境变量或 `/tmp/opendesk-mail-test.env` 读取，不写入仓库；原始 PTY transcript 和临时配置默认删除，仓库只保存脱敏 UI 证据、hash、字节数和结构化状态。

后续已在 `npm run test:pi-tui-migration:mailbox-real` runner 中加入 `/mail` 右键翻页后按 Up/Down/Esc 并向主输入框写入 `mailbox-focus-regression-sentinel` 的焦点回归断言。2026-07-07 重新注入 QQ 邮箱授权码后补跑通过，脱敏证据显示 `/mail` 渲染、筛选栏、Esc 关闭后的主输入焦点恢复 sentinel 均已出现。

| 场景                       | 结果 | 证据                                                                                  | 边界                                                               |
| -------------------------- | ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| QQ Mail IMAP 连接验证      | 通过 | `docs/reports/pi_tui_migration_review/artifacts/mailbox_real_e2e_post_migration.json` | 只验证登录，不保存邮件标题、正文、发件人或附件                     |
| QQ Mail SMTP 连接验证      | 通过 | `docs/reports/pi_tui_migration_review/artifacts/mailbox_real_e2e_post_migration.json` | 只执行 `verify()`，不发送邮件                                      |
| Mailbox TUI 账号与筛选渲染 | 通过 | `mailbox_real_evidence/post_migration/mailbox-real-tui.redacted.txt`                  | 覆盖 `/mail`、账号显示、筛选栏、关闭；不打开邮件详情               |
| 大邮箱后台同步受控终止     | 通过 | `controlledTermination: true` in `mailbox_real_e2e_post_migration.json`               | 账号约数千封邮件，runner 采集 TUI 证据后 SIGTERM，避免等待完整同步 |

### Channel 本地测试插件 E2E

2026-07-07 新增无网络、无凭据的本地 Channel fixture 插件，资源位于 `src/tests/resources/channel-plugins/opendesk-channel-fixture`。`npm run test:pi-tui-migration:channel-fixture` 会把 fixture 复制到临时 `extensions/node_modules/@opendesk-test/channel-fixture`，写入临时 `extensions/plugins.json`，然后通过真实 TUI 执行 `/channels list`、`/channels status`、`/plugins list`、`/plugins disable opendesk-channel-fixture`、`/plugins enable opendesk-channel-fixture` 和二次 `/channels status`。

| 场景                        | 结果 | 证据                                                                                     | 边界                                 |
| --------------------------- | ---- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| 本地 Channel 插件加载与状态 | 通过 | `channel_fixture_evidence/post_migration/channel-fixture-tui.ansi.txt`                   | 使用 fixture，无真实外部消息平台凭据 |
| 插件列表与启停 slash 命令   | 通过 | `docs/reports/pi_tui_migration_review/artifacts/channel_fixture_e2e_post_migration.json` | 不执行 npm install/uninstall，不触网 |

### 真实配置只读 E2E

2026-07-07 使用真实 `~/.opendesk` 配置执行只读 PTY E2E，结果记录在 `business_e2e_post_migration.json`。原始 PTY transcript 可能包含真实业务数据，未写入仓库；报告只保存状态、配置前提、字节数和 transcript hash。

| 场景                       | 命令               | 结果 | 边界                                                                                 |
| -------------------------- | ------------------ | ---- | ------------------------------------------------------------------------------------ |
| Calendar 真实数据只读导航  | `/calendar`        | 通过 | 本机 calendar db 存在 1 条记录                                                       |
| Mailbox 配置路径只读导航   | `/mail`            | 通过 | 本机未配置 mailbox 账号，只覆盖入口与空配置路径；真实账号覆盖见 Mailbox 真实账号 E2E |
| Skill Manager 真实配置只读 | `/skills`          | 通过 | 本机未配置 external paths / marketplace API key，不覆盖 marketplace                  |
| Channel 插件列表只读       | `/plugins list`    | 通过 | 只覆盖列表入口，不执行 install/uninstall/enable/disable                              |
| Channel 运行状态只读       | `/channels status` | 通过 | 只覆盖状态入口，不要求真实在线 channel                                               |
| Dashboard 真实状态只读     | `/dashboard`       | 通过 | 覆盖 dashboard 聚合入口                                                              |

首轮真实配置 E2E 曾暴露 `/skills` 与 `/dashboard` 崩溃：`CombinedAutocompleteProvider.getSuggestions` 收到缺失 `options` 后读取 `options.force` 抛错。已在 OpenDesk 自动补全适配层补齐新 pi-tui 签名兼容，并在同一套真实配置 E2E 下复跑通过。

## Gate 6：真实终端渲染

| 场景                                         | 结果 | 证据                                                                                                      |
| -------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `gate6-terminal-rendering-and-keyboard-flow` | 通过 | `behavior_evidence/post_migration/gate6-terminal-rendering-and-keyboard-flow-{80x24,120x30,160x40}-1.log` |

Gate 6 的 baseline 与 post-migration 使用同一个 runner 和同一套断言：每个启动尺寸都在同一运行中 PTY 内执行 80x20、160x40、120x30 动态 resize，结果 JSON 记录请求尺寸、实际 PTY 尺寸、`resizeErrors: []` 和 `PI_DEBUG_REDRAW` full redraw 证据。`controlledTermination: true` 只出现在完成多尺寸渲染和动态 resize 采样后的 harness 结束进程，不表示 TUI 崩溃。

### reviewer 重点验收

2026-07-07 按审核要求新增独立 review acceptance runner，仍存放在 pi-tui migration 独立测试矩阵内，不并入常规 Jest/Node 矩阵。fake 模型模式是阻塞门禁；真实模型 smoke 是补充证据，当前因未提供 `/tmp/opendesk-review-real-model.env` 或 `OPENDESK_REVIEW_MODEL_*` 环境变量而记录为 skipped。

| 场景                                | 结果 | 证据                                                                            | 覆盖                                                                                |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 复杂任务流式渲染 + 动态 resize      | 通过 | `docs/reports/pi_tui_migration_review/artifacts/acceptance_fake_model.json`     | fake OpenAI-compatible server、Markdown/CJK/code/table、token 状态、多轮 PTY resize |
| `/command` 与 `/skillname` 自动补全 | 通过 | `acceptance_evidence/fake/slash-command-and-skill-autocomplete-120x30.ansi.txt` | 内置 slash command、临时 user-invocable skill、inline skill 补全                    |
| 快捷键与 overlay 焦点               | 通过 | `acceptance_evidence/fake/shortcuts-and-overlay-focus-120x30.ansi.txt`          | 输入编辑键、Ctrl+H、Ctrl+L、Ctrl+K、SelectList 导航、overlay 关闭                   |

### 真实手工验证补充

2026-07-07 手工验证发现：macOS Terminal.app 中直接运行 `npm run cli` 时，`Shift+Return` 表现为提交而不是换行；`Ctrl+J` 换行正常。独立 raw input probe 显示 Terminal.app 对普通 Return 与 Shift+Return 均发送 `\r`，但 pi-tui 的 macOS native modifier helper 能在 Shift 按下时把输入 normalize 为 `shift+enter`。因此问题不是 `Shift+Return` 与 `Shift+Enter` 命名差异，而是 bundled CLI 构建产物没有携带 `@earendil-works/pi-tui/native` 下的 `.node` helper，导致 `dist/cli/opendesk-debug` 运行时无法检测 macOS Shift modifier。

修复：`esbuild.config.ts` 在 `build-cli` 完成后复制 `node_modules/@earendil-works/pi-tui/native` 到 `dist/cli/native`。该路径与 bundled `native-modifiers.js` 的运行时查找候选 `dist/cli/native/darwin/prebuilds/<arch>/darwin-modifiers.node` 对齐。`npm run build-cli` 后已确认以下文件存在：

- `dist/cli/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node`
- `dist/cli/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node`
- `dist/cli/native/win32/prebuilds/win32-arm64/win32-console-mode.node`
- `dist/cli/native/win32/prebuilds/win32-x64/win32-console-mode.node`

补充复测发现：仅携带 native helper 后，真实 Terminal.app 中 `Shift+Return` 仍可能表现为提交。OpenDesk 已在全局输入层显式将 `shift+enter` 归一化输入映射为编辑器换行，避免只依赖 pi-tui Editor 默认 keybinding。Gate 4 主输入行为流也已改为先发送 CSI-u `shift-enter`，再发送 `ctrl-j`，确认归一化后的 `shift+enter` 不会被当作普通提交。

新增 gate：`npm run test:pi-tui-migration` 会检查 `esbuild.config.ts` 保留 pi-tui native helper 复制逻辑；若本地已有 `dist/cli/opendesk-debug`，还会检查 macOS helper 文件实际存在。同时检查 `src/main/tui/entry.ts` 保留 `Key.shift(Key.enter)` 到 `\n` 的显式多行输入保护。手工复测要求：在 macOS Terminal.app 中重新运行 `npm run cli`，输入 `aaa`、按 `Shift+Return`、输入 `bbb`，预期为两行文本且不提交；`Ctrl+J` 仍作为稳定换行路径保留。

## Gate 7：用户反馈复测

| 反馈 ID 或来源           | 重复执行次数 | 迁移前崩溃数 | 迁移后崩溃数 | 归因                                        | 证据                                                                                 |
| ------------------------ | ------------ | ------------ | ------------ | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 已知偶发 TUI crash smoke | 1            | 0            | 0            | 自动 smoke 未复现；仍需用户原始复现路径补充 | `behavior_evidence/post_migration/gate7-intermittent-crash-regressions-120x30-1.log` |

## 风险与边界

- Node 版本策略已固化：根 `package.json` 与 CLI 发布包模板均声明 `engines.node >=22.19.0`，`.nvmrc` 固定为 `22.22.1`，与 Electron 39.8.10 内置 Node `22.22.1` 对齐。已在 Node v22.22.1 下执行 `npm install --package-lock=false`，不再触发 pi-tui engine warning。
- `npm install` 触发项目 postinstall 的 Electron ABI rebuild，其中 `@kenhkl/agent-moss` 内部 `better-sqlite3` rebuild 失败后被脚本标记为 skipping，npm 最终退出码为 0。该项不是 pi-tui API 失败，但需要由 native dependency 维护流程单独治理。
- `npm run test:node` 失败于 filemgr/storage 相关用例：`src/tests/ut/node/filemgr/storage.test.js` 缺失测试函数引用、`src/tests/ut/node/filemgr/worker.test.js` 多个扫描/embedding 状态断言失败并出现 lock compromise、`src/tests/ut/node/services/storage/platform.test.ts` logger 隔离目录断言失败。上述路径不依赖 TUI adapter。
- `npm test` 失败于 `src/tests/ut/platforms/fetch.test.ts`：带 credential 的 URL 构造 `Request` 抛错，以及 `proxy fetch 使用 Headers 时保留 Content-Type` 超时。该失败在本次版本切换前已经出现，和 pi-tui 迁移无直接关系。
- 本记录已补充真实配置只读 E2E 和 QQ Mailbox 真实账号 E2E，但没有替代 Skill marketplace 凭据、在线 channel plugin 或用户原始偶发 crash 路径下的深层复测。

## 收口结论

- 是否允许关闭迁移：允许关闭当前“版本切换 + 自动化 smoke + Node 版本策略固化 + Mailbox 真实账号 E2E”阶段；不建议直接关闭发布级迁移风险。
- 未关闭原因：Skill marketplace 凭据、在线 channel plugin、用户原始偶发 crash 路径复测仍需补证据。
- deferred 项及归属：剩余业务凭据 E2E、原始 crash 复现路径由后续迁移验收阶段处理。
