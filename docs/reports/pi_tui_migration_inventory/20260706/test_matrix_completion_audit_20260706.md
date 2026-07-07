# pi-tui 测试矩阵完成度更正审计

日期：2026-07-06

## 结论

当前不能声称“迁移测试方案已经完整落地并验证 TUI 可用”。准确状态是：

- 规则矩阵、Gate 和行为场景可以被结构化校验。
- 完整迁移门禁已经设置为在缺少真实行为/e2e 证据时失败。
- 当前旧版本 baseline PTY smoke 已可执行并通过，证据文件已生成。
- 当前仓库仍使用 `@mariozechner/pi-tui`，因此完整门禁预期失败。
- 源码和测试中的直接 pi-tui import 已收口到 `src/main/tui/pi-tui.ts` 适配层。
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

## 当前阻断项

- 旧依赖仍存在：`@mariozechner/pi-tui`。
- 适配层 `src/main/tui/pi-tui.ts` 仍指向旧包。
- Jest mapper 仍指向旧包 mock。
- `tui_migration_verification_record.md` 尚未生成。
- `behavior_baseline_current.json` 已生成，当前 baseline smoke 为 `passed`。
- `behavior_post_migration.json` 尚未生成。

这些失败表示迁移和行为验证尚未完成，不应解释为“测试方案已经证明 TUI 不可用”，也不应解释为“只有接口升级未做所以无所谓”。它们是阻断迁移关闭的证据缺口。

## 当前 baseline smoke 结果

执行命令：

```bash
npm run test:pi-tui-migration:behavior:baseline -- --repeat 1
```

结果文件：

- `docs/reports/pi_tui_migration_inventory/20260706/behavior_baseline_current.json`
- `docs/reports/pi_tui_migration_inventory/20260706/behavior_evidence/baseline_current/`

所有自动 smoke 场景当前均为 `passed`。其中 Gate 6 的三种终端尺寸使用 `controlledTermination: true`，表示完成渲染采样后由 harness 结束进程，避免把留在输入框中的 CJK/ANSI 测试文本提交给模型。
