# pi-tui 迁移验证记录

日期：2026-07-07
提交号：bfde37be 之后的 Node 版本策略固化变更
执行人或执行进程：Codex CLI migration run
终端环境：Darwin 25.5.0, Node v22.22.1, npm 10.9.4, script PTY
自动 smoke result：通过，见 `behavior_post_migration.json`
深层 E2E 环境前提：需要真实 Calendar、Mailbox、Skill Manager、Channel Manager 账号或业务数据；本记录只覆盖自动 PTY smoke 可证明的入口、导航、焦点、渲染和退出行为。

## Gate 0：盘点与状态

- replacement map 校验：已通过 `npm run test:pi-tui-migration:structure`。
- scan_failed：沿用盘点报告结论，未在本次版本切换中新增扫描失败项。
- unclassified：沿用盘点报告结论，未在本次版本切换中新增未分类项。
- rg_lines_missing_from_reports：本次版本切换命中范围已进入当前报告和迁移测试记录。

## Gate 1：静态迁移

- package.json：已从 `@mariozechner/pi-tui@^0.58.4` 切换为 `@earendil-works/pi-tui@^0.80.3`。
- 源码导入：应用代码继续通过 `src/main/tui/pi-tui.ts` 适配层导入。
- Jest mapper：已从旧包名 mapper 切换为 `@earendil-works/pi-tui` mapper。
- 文档示例：已在上一阶段收口为内部适配层路径，不再教用户直接导入旧包。

## Gate 2：构建与常规测试

| 命令                                                                                                                                                      | 结果 | 证据                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `npm install --package-lock=false`                                                                                                                        | 通过 | Node v22.22.1 下依赖树解析为 `@earendil-works/pi-tui@0.80.3`，无 pi-tui engine warning |
| `npm run build-cli`                                                                                                                                       | 通过 | CLI production/debug bundle 生成成功                                                   |
| `npm run build`                                                                                                                                           | 通过 | Electron main/preload/renderer build 生成成功                                          |
| `npm run test:pi-tui-migration:structure`                                                                                                                 | 通过 | 5/5 pass                                                                               |
| `node --experimental-vm-modules node_modules/jest/bin/jest.js --selectProjects unit --runTestsByPath src/tests/ut/tui/components/input-statusbar.test.ts` | 通过 | 4/4 pass                                                                               |
| `npm run test:pi-tui-migration:behavior:post -- --repeat 1`                                                                                               | 通过 | `docs/reports/pi_tui_migration_inventory/20260706/behavior_post_migration.json`        |
| `npm run test:pi-tui-migration`                                                                                                                           | 通过 | 12/12 pass                                                                             |
| `npm run lint`                                                                                                                                            | 通过 | 0 errors, existing warnings remain                                                     |
| `npm run test:node`                                                                                                                                       | 失败 | 3 个 filemgr/storage 相关失败，见风险项                                                |
| `npm test`                                                                                                                                                | 失败 | `src/tests/ut/platforms/fetch.test.ts` 2 个既有失败，见风险项                          |

## Gate 3：API 与快捷键契约

- keybinding replacement APIs：新包移除了旧导出 `EditorKeybindingsManager`、`getEditorKeybindings`、`setEditorKeybindings`，提供通用 `KeybindingsManager`、`getKeybindings`、`setKeybindings`。本次在 `src/main/tui/pi-tui.ts` 内保留旧 API 兼容导出。
- action id mapping：旧版 `EditorAction` 包含 OpenDesk 使用的自定义 action，例如 `expandTools`、`treeFoldOrUp`、`toggleSessionPath`。本次 adapter 保留旧 action 名和旧默认键位，避免业务调用点在同一阶段大面积改写。
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

## Gate 6：真实终端渲染

| 场景                                         | 结果 | 证据                                                                                                      |
| -------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `gate6-terminal-rendering-and-keyboard-flow` | 通过 | `behavior_evidence/post_migration/gate6-terminal-rendering-and-keyboard-flow-{80x24,120x30,160x40}-1.log` |

`controlledTermination: true` 只出现在完成多尺寸渲染采样后的 harness 结束进程，不表示 TUI 崩溃。

## Gate 7：用户反馈复测

| 反馈 ID 或来源           | 重复执行次数 | 迁移前崩溃数 | 迁移后崩溃数 | 归因                                        | 证据                                                                                 |
| ------------------------ | ------------ | ------------ | ------------ | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 已知偶发 TUI crash smoke | 1            | 0            | 0            | 自动 smoke 未复现；仍需用户原始复现路径补充 | `behavior_evidence/post_migration/gate7-intermittent-crash-regressions-120x30-1.log` |

## 风险与边界

- Node 版本策略已固化：根 `package.json` 与 CLI 发布包模板均声明 `engines.node >=22.19.0`，`.nvmrc` 固定为 `22.22.1`，与 Electron 39.8.10 内置 Node `22.22.1` 对齐。已在 Node v22.22.1 下执行 `npm install --package-lock=false`，不再触发 pi-tui engine warning。
- `npm install` 触发项目 postinstall 的 Electron ABI rebuild，其中 `@kenhkl/agent-moss` 内部 `better-sqlite3` rebuild 失败后被脚本标记为 skipping，npm 最终退出码为 0。该项不是 pi-tui API 失败，但需要由 native dependency 维护流程单独治理。
- `npm run test:node` 失败于 filemgr/storage 相关用例：`src/tests/ut/node/filemgr/storage.test.js` 缺失测试函数引用、`src/tests/ut/node/filemgr/worker.test.js` 多个扫描/embedding 状态断言失败并出现 lock compromise、`src/tests/ut/node/services/storage/platform.test.ts` logger 隔离目录断言失败。上述路径不依赖 TUI adapter。
- `npm test` 失败于 `src/tests/ut/platforms/fetch.test.ts`：带 credential 的 URL 构造 `Request` 抛错，以及 `proxy fetch 使用 Headers 时保留 Content-Type` 超时。该失败在本次版本切换前已经出现，和 pi-tui 迁移无直接关系。
- 本记录没有替代真实账号/业务数据下的深层应用 E2E。

## 收口结论

- 是否允许关闭迁移：允许关闭当前“版本切换 + 自动化 smoke + Node 版本策略固化”阶段；不建议直接关闭发布级迁移风险。
- 未关闭原因：真实业务数据深层 E2E、用户原始偶发 crash 路径复测仍需补证据。
- deferred 项及归属：业务账号 E2E、原始 crash 复现路径由后续迁移验收阶段处理。
