# pi-tui 低风险适配层迁移记录

日期：2026-07-07

> 当前状态更新：该适配层方案只是迁移过程中的中间步骤。PL 重点验收通过后，`src/main/tui/pi-tui.ts` adapter 已删除，运行时代码和相关测试已直接导入 `@earendil-works/pi-tui`。本文以下内容保留为历史记录，不代表当前实现方式。

## 目标

在不升级依赖、不改变运行行为的前提下，先把 OpenDesk 源码和测试中的 `pi-tui` 直接 import 收口到内部适配层，为后续切换 `@earendil-works/pi-tui` 降低风险。

## 本次范围

- 新增 `src/main/tui/pi-tui.ts`。
- 将 `src/main/**` 和相关 TUI 单测中的直接 `@mariozechner/pi-tui` import 改为相对导入适配层。
- 更新用户面向文档示例，要求新组件通过适配层导入 TUI primitives。
- 调整专项迁移 gate：
    - “源码和测试不再直接 import 旧包”可独立通过。
    - “适配层指向新包”“依赖切新包”“Jest mapper 切新包”仍作为迁移关闭前的阻断项。

## 当前状态

- 适配层已删除：`src/main/tui/pi-tui.ts` 不再存在。
- 源码/测试已直接导入 `@earendil-works/pi-tui`。
- 依赖声明已切换为 `@earendil-works/pi-tui@^0.80.3`。
- 后续事实依据以 `replacement_map.json`、`tui_migration_verification_record.md` 和 PL acceptance 结果为准。

## 验证

- `npm run test:pi-tui-migration:structure`：通过。
- `npm run build-cli`：通过。
- `npm run build`：通过。
- `npm run test:pi-tui-migration:behavior:baseline -- --repeat 1`：通过，并刷新 baseline evidence。
- `node --experimental-vm-modules node_modules/jest/bin/jest.js --selectProjects unit --runTestsByPath src/tests/ut/tui/components/input-statusbar.test.ts`：通过。
- `npm run lint`：通过，存在仓库既有 warning。
- `npm test`：失败于 `src/tests/ut/platforms/fetch.test.ts` 的 proxy fetch 用例，和本次 pi-tui 适配层迁移无关。

## 下一步

该中间方案已被最终 direct-import 方案取代。后续维护重点：

- 不重新引入本地 adapter。
- 新 TUI 代码直接从 `@earendil-works/pi-tui` 导入。
- 继续使用 PL fake acceptance 和 migration matrix 防止回归。
