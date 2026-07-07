# pi-tui 测试矩阵完成度更正审计

日期：2026-07-06

## 结论

本审计最初用于纠正“测试矩阵结构已落地”等同于“迁移可关闭”的口径。当前在后续迁移和 PL 验收完成后，准确状态更新为：

- 规则矩阵、Gate 和行为场景可以被结构化校验。
- 完整迁移门禁已经设置为在缺少真实行为/e2e 证据时失败，并已在迁移后通过。
- 当前旧版本 baseline PTY smoke 与迁移后 PTY smoke 均已执行并通过，证据文件已生成。
- 当前仓库已切换到 `@earendil-works/pi-tui`。
- 源码和测试中的 pi-tui import 已在 PL 验收通过后改为直接导入 `@earendil-works/pi-tui`；临时 `src/main/tui/pi-tui.ts` 适配层已删除。
- Gate 4-7 需要真实终端或 PTY 行为结果，不能由静态测试替代；自动 smoke 不能替代需要真实账号/业务数据的深层应用 E2E 记录。

## 原误差

之前的错误在于把“测试矩阵文件已建立”和“行为验证已完成”混为一谈。对于 pi-tui 迁移，这个判断不成立，因为 API 兼容、action id 兼容、焦点恢复、终端渲染和应用级 TUI 可用性都可能在编译通过时仍然失败。

## 已修正的门禁

- `npm run test:pi-tui-migration:structure`：只验证矩阵结构、规则全集和行为场景覆盖。
- `npm run test:pi-tui-migration`：验证结构、当前静态迁移状态和行为证据。
- `npm run test:pi-tui-migration:behavior`：验证 Gate 4-7 行为结果文件。

完整迁移门禁必须读取并比较：

- `docs/reports/pi_tui_migration_inventory/20260706/behavior_baseline_current.json`
- `docs/reports/pi_tui_migration_inventory/20260706/behavior_post_migration.json`

任一文件缺失或任一场景在任一阶段不是 `passed` 时，迁移不得关闭。

## 历史阻断项与当前结论

- 旧依赖阻断项已关闭：`package.json` 当前声明 `@earendil-works/pi-tui`。
- 适配层阻断项已关闭：`src/main/tui/pi-tui.ts` 已不再存在，当前运行时代码直接导入新包。
- Jest mapper 旧包阻断项已关闭。
- `tui_migration_verification_record.md` 已生成并持续更新。
- `behavior_baseline_current.json` 与 `behavior_post_migration.json` 均已生成并通过。
- PL 重点 fake acceptance 已通过；真实模型 smoke 因缺少本地模型 env 被记录为 skipped，按当前计划不是阻塞门禁。

上述项目在本报告创建时曾是阻断项；当前只作为审计历史保留，不再代表仓库当前状态。

## 当前 baseline smoke 结果

执行命令：

```bash
npm run test:pi-tui-migration:behavior:baseline -- --repeat 1
```

结果文件：

- `docs/reports/pi_tui_migration_inventory/20260706/behavior_baseline_current.json`
- `docs/reports/pi_tui_migration_inventory/20260706/behavior_evidence/baseline_current/`

所有自动 smoke 场景当前均为 `passed`。其中 Gate 6 的三种终端尺寸使用 `controlledTermination: true`，表示完成渲染采样后由 harness 结束进程，避免把留在输入框中的 CJK/ANSI 测试文本提交给模型。
