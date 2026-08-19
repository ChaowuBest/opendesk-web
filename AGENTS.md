# AGENTS.md

OpenDesk 是一个基于 Electron 的全能型 AI 工作站，同时提供 CLI 和 GUI 两种交互模式。
项目使用 TypeScript 编写，采用 Mulan PSL v2 开源协议。

## 开发命令

- 安装依赖: `npm install`
- 启动开发服务器 (Electron GUI): `npm start`
- 构建 CLI: `npm run build-cli`
- 构建全部 (Electron): `npm run build`
- 运行 CLI: `npm run cli`
- 运行测试: `npm test`
- 运行 Node runner 测试: `npm run test:node` (可选项，通常仅需要检查自己修改的这部分内容对应的 Node runner 测试是否通过)
- 代码检查: `npm run lint`
- 代码格式化: `npm run format`
- 架构检查: `npm run check:architecture`

### 开发规则

- 如果是定位 OpenDesk 的 bug，那么尽可能通过设计新的单元测试来复现这些问题，不要仅靠猜测。同样地，修复完 bug 之后要用你的单元测试进行回归，确保问题真正得到了解决；
- 在新特性的开发过程中要使用测试用例先行 (Test-Driven Development) 的模式;

## 验证变更

在完成代码修改后，必须运行以下命令确认构建通过：

```bash
npm run build-cli
npm run build
```

如果引入了新功能或修复了 bug，应当运行相关测试：

```bash
npm test
```

完成任务前，应当检查本次变更中的用户可见文本字面量（GUI/TUI/CLI、应用状态、错误提示、按钮文案等）是否已经接入本地化；如确认是内部日志、测试断言或不可本地化的协议字段，应在代码或回复中明确其边界。

## 测试规范

- Jest 单元测试放在 `src/tests/ut/**/*.test.ts`，搜索相关测试放在 `src/tests/ut/search/**/*.test.ts`，公共 `embedBrowserUse` 测试保留在 `src/common/embedBrowserUse/__tests__/**/*.test.ts`。
- 使用 `node:test`、`node:assert`、顶层 await 或手写 runner 的本地单元/轻集成测试，统一放在 `src/tests/ut/node/**/*.test.{js,ts}`，通过 `npm run test:node` 运行；不要再把这类测试放到业务源码目录的 `__tests__` 或 `test` 子目录中。
- 可运行示例可以放在相邻领域目录下，但不要使用 `.test.*` 后缀，避免被测试脚本自动收集。
- 测试导入业务源码时，继续遵循 ESM 约定，源码相对导入使用 `.js` 后缀；需要直接导入 TypeScript 文件时由 `tsx` 承载。

## 开源协议

- 对于所有非测试源码文件，在创建的时候请你参考 `src/main/main.ts` 添加 Mulan PSL 开源协议头;
- 对于测试文件，请不要再顶部放任何开源协议;

## 架构设计

### embedBrowserUse 公共库

`src/common/embedBrowserUse/` 是通用的 CDP 浏览器自动化库，应当保持与特定 UI 框架（如 OpenDesk 的 task-view / 侧边栏）无关的设计。在修改 `embedBrowserUse` 时：

- **不要引入 OpenDesk 专用逻辑**。与 OpenDesk UI 强绑定的脚本生成、renderer 通信等逻辑应放在 `src/main/applications/browser/utils.ts`
- **使用依赖注入**。如果 `embedBrowserUse` 中的类需要与宿主 UI 框架通信，应通过接口（如 `BrowserScriptGenerators`）注入，而非硬编码
- **OpenDesk 专用实现**放在 `src/main/applications/browser/` 目录下

### 子系统设计说明

- 修改或新增 CLI 弹窗、输入区 prompt、全屏配置页、快捷键捕获页等任何可能产生焦点冲突的控件时，请先阅读 `docs/specifications/tui_prompt_queue.md`，并遵循其中的 TUI prompt 队列与焦点恢复规则。

## 代码风格

- **语言**: TypeScript strict mode
- **模块**: ES Modules (`"type": "module"`)，所有导入使用 `.js` 后缀
- **导入**: 始终使用顶层静态 import 语句，除非有充分理由需要动态导入
- **注释**: 不要删除现有代码中的注释，除非你明确被要求删除或重构相关代码。添加新代码时只为不显而易见的逻辑添加注释
- **缩进**: 4 空格
- **引号**: 单引号
- **分号**: 必须有
- **尾逗号**: 无
