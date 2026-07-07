# pi-tui 迁移审核摘要

## 结论

本 worktree 已完成 TUI 依赖从旧包 `@mariozechner/pi-tui@0.58.4` 到新包 `@earendil-works/pi-tui@^0.80.3` 的迁移验证。业务代码不再保留本地 adapter，运行时代码直接从新包导入。当前相对 `origin/main` 仅 ahead，迁移相关构建和专项 TUI 验收已通过。

## 修改内容

| 类别      | 终态变化                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| 依赖      | `package.json` 使用 `@earendil-works/pi-tui`，移除旧 scope 依赖。                                                         |
| 导入方式  | 删除 `src/main/tui/pi-tui.ts` adapter，TUI 运行时代码直接导入 `@earendil-works/pi-tui`。                                  |
| API 迁移  | 使用新包 `KeybindingsManager`、`getKeybindings`、`setKeybindings`、新 action id 和新 overlay/focus 行为。                 |
| 兼容修复  | 修复 autocomplete options 缺省、Mailbox/Calendar overlay focus、Ctrl+Backspace、Shift+Enter 多行输入。                    |
| CLI 打包  | `build-cli` 复制 pi-tui native helper 到 `dist/cli/native`，覆盖 macOS Terminal.app modifier 检测和 Windows VT 输入需求。 |
| Node 版本 | 固化 Node 要求为 `>=22.19.0`，`.nvmrc` 固定 `22.22.1`，与当前验证环境一致。                                               |
| 文档组织  | 审核证据集中到 `docs/reports/pi_tui_migration_review/`，模板类中间态文件已删除。                                          |

## 测试覆盖

| 覆盖面           | 已验证内容                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| 构建             | `npm run build-cli`、`npm run build` 通过。                                                            |
| 迁移门禁         | `npm run test:pi-tui-migration` 通过，覆盖 dependency/import/adapter/native helper/证据矩阵。          |
| 主输入           | Enter 提交、Shift+Enter/Ctrl+J 换行、Backspace、Ctrl+Backspace、Tab、Shift+Tab、输入焦点恢复。         |
| 复杂任务界面     | fake OpenAI-compatible server 流式输出，覆盖 Markdown、中文、列表、表格、代码块、状态栏和 token 区域。 |
| Resize           | 同一 TUI 进程内多轮 PTY resize，验证进程不崩、输出继续、debug redraw 记录存在。                        |
| 自动补全         | `/command` 行首补全、deterministic `/skillname` 行首补全、inline `/skillname` 补全。                   |
| 快捷键与 overlay | Ctrl+H、Ctrl+L、Ctrl+K、SelectList Up/Down/PageUp/PageDown/Enter/Esc。                                 |
| 应用入口         | Calendar、Mailbox、Skill Manager、Channel Manager、Dashboard 的 TUI 入口和退出路径。                   |
| 真实业务补充     | QQ Mailbox IMAP/SMTP verify、Mailbox TUI 脱敏证据、本地 Channel fixture 插件 E2E。                     |

边界：真实模型 smoke 因未提供 `OPENDESK_REVIEW_MODEL_*` 或 `/tmp/opendesk-review-real-model.env` 记录为 skipped；`npm test` 和 `npm run test:node` 仍有既有非 pi-tui 失败，详见验证记录。

## 文档和证据索引

| 文件位置                                                                                 | 作用概述                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `docs/reports/pi_tui_migration_review/artifacts/tui_migration_verification_record.md`    | 主验证记录，汇总构建、专项测试、真实账号 E2E、风险和边界。          |
| `docs/reports/pi_tui_migration_review/artifacts/replacement_map.json`                    | 迁移事实依据，逐条记录 API/导入替换、风险等级、验证状态和证据链接。 |
| `docs/reports/pi_tui_migration_review/artifacts/05_type_contract_diff.md`                | 新旧包类型导出与签名差异摘要。                                      |
| `docs/reports/pi_tui_migration_review/artifacts/05_non_signature_api_verification.json`  | 非签名类 API 的逐项验证结果。                                       |
| `docs/reports/pi_tui_migration_review/artifacts/06_upstream_docs_review.md`              | 上游文档和迁移信息复核。                                            |
| `docs/reports/pi_tui_migration_review/artifacts/07_upstream_implementation_diff.md`      | 上游实现差异复核。                                                  |
| `docs/reports/pi_tui_migration_review/artifacts/08_api_usage_to_behavior_matrix.md`      | OpenDesk 实际 API 使用到行为测试的映射。                            |
| `docs/reports/pi_tui_migration_review/artifacts/09_behavior_verification_matrix.md`      | 行为验证矩阵摘要。                                                  |
| `docs/reports/pi_tui_migration_review/artifacts/behavior_baseline_current.json`          | 迁移前行为基准结果。                                                |
| `docs/reports/pi_tui_migration_review/artifacts/behavior_post_migration.json`            | 迁移后行为结果。                                                    |
| `docs/reports/pi_tui_migration_review/artifacts/behavior_evidence/`                      | Gate 4-7 PTY transcript 证据。                                      |
| `docs/reports/pi_tui_migration_review/artifacts/acceptance_fake_model.json`              | review fake acceptance 结构化结果。                                 |
| `docs/reports/pi_tui_migration_review/artifacts/acceptance_evidence/`                    | review fake acceptance ANSI 证据。                                  |
| `docs/reports/pi_tui_migration_review/artifacts/mailbox_real_e2e_post_migration.json`    | QQ Mailbox 真实账号 E2E 结构化结果。                                |
| `docs/reports/pi_tui_migration_review/artifacts/mailbox_real_evidence/`                  | Mailbox TUI 脱敏证据。                                              |
| `docs/reports/pi_tui_migration_review/artifacts/channel_fixture_e2e_post_migration.json` | 本地 Channel fixture E2E 结构化结果。                               |
| `docs/reports/pi_tui_migration_review/artifacts/channel_fixture_evidence/`               | Channel fixture TUI ANSI 证据。                                     |

## 建议常态化测试

| 测试位置                                                   | 主要覆盖内容                                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/tests/tui-regression/current-state-gates.test.mjs`    | 依赖 scope、direct import、adapter 移除、native helper 打包、Shift+Enter 多行输入保护。 |
| `src/tests/tui-regression/behavior-smoke-scenarios.json`   | TUI 主输入、overlay、应用入口、resize、反复启动不崩的行为场景定义。                     |
| `scripts/tui-regression-tests/run-behavior-smoke.mjs`      | 无外部服务 PTY smoke runner，可作为未来稳定回归门禁候选。                               |
| `src/tests/tui-regression/acceptance-scenarios.json`       | 复杂任务、resize、自动补全、快捷键和 overlay 的 reviewer 重点验收场景。                 |
| `scripts/tui-regression-tests/run-acceptance.mjs`          | fake-model 阻塞验收 runner，真实模型 smoke 为可选补充。                                 |
| `scripts/tui-regression-tests/run-channel-fixture-e2e.mjs` | 本地无网络 Channel 插件加载、状态、启停验证。                                           |
| `scripts/tui-regression-tests/run-mailbox-real-e2e.mjs`    | 真实邮箱可选 E2E，适合凭据齐备时作为人工/受控门禁。                                     |

## 仅本次迁移涉及测试

| 测试位置                                                            | 主要覆盖内容                             |
| ------------------------------------------------------------------- | ---------------------------------------- |
| `src/tests/pi-tui-migration-only/migration-test-matrix.json`        | 本次迁移规则宇宙、gate、风险、状态定义。 |
| `src/tests/pi-tui-migration-only/gate-evidence-map.json`            | 本次迁移 gate 到证据文件的映射。         |
| `src/tests/pi-tui-migration-only/matrix-structure.test.mjs`         | replacement map、矩阵、证据覆盖完整性。  |
| `src/tests/pi-tui-migration-only/behavior-evidence.test.mjs`        | 迁移前后行为证据可比性检查。             |
| `scripts/pi-tui-migration-only-tests/run.mjs`                       | 本次迁移专项 gate 聚合 runner。          |
| `scripts/pi-tui-migration-only-tests/verify-non-signature-apis.mjs` | 非签名 API 差异验证报告生成。            |
