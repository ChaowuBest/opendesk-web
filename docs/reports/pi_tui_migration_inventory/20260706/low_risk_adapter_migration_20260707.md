# pi-tui 低风险适配层迁移记录

日期：2026-07-07

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

- 运行时代码行为应保持不变：适配层仍 re-export `@mariozechner/pi-tui`。
- 源码/测试直接旧包 import 已收口，唯一直接旧包 import 位于 `src/main/tui/pi-tui.ts`。
- 依赖声明仍是 `@mariozechner/pi-tui@^0.58.4`。
- 尚未开始正式切换 `@earendil-works/pi-tui`。

## 验证

- `npm run test:pi-tui-migration:structure`：通过。
- `npm run build-cli`：通过。
- `npm run build`：通过。
- `npm run test:pi-tui-migration:behavior:baseline -- --repeat 1`：通过，并刷新 baseline evidence。
- `node --experimental-vm-modules node_modules/jest/bin/jest.js --selectProjects unit --runTestsByPath src/tests/ut/tui/components/input-statusbar.test.ts`：通过。
- `npm run lint`：通过，存在仓库既有 warning。
- `npm test`：失败于 `src/tests/ut/platforms/fetch.test.ts` 的 proxy fetch 用例，和本次 pi-tui 适配层迁移无关。

## 下一步

下一批应处理适配层的真实切包前准备：

- 明确 Jest 对适配层的 mock 策略。
- 对比 `@earendil-works/pi-tui` 的导出和当前适配层 re-export 是否需要兼容 shim。
- 在小分支中尝试只切 `src/main/tui/pi-tui.ts` 和依赖声明，然后运行同一套 baseline/post 行为矩阵。
