# pi-tui 迁移验证记录模板

日期：
提交号：
执行人或执行进程：
终端环境：
自动 smoke result：
深层 E2E 环境前提：

## Gate 0：盘点与状态

- replacement map 校验：
- scan_failed：
- unclassified：
- rg_lines_missing_from_reports：

## Gate 1：静态迁移

- package.json：
- 源码导入：
- Jest mapper：
- 文档示例：

## Gate 2：构建与常规测试

| 命令                | 结果 | 证据 |
| ------------------- | ---- | ---- |
| `npm run build-cli` |      |      |
| `npm run build`     |      |      |
| `npm test`          |      |      |
| `npm run test:node` |      |      |

## Gate 3：API 与快捷键契约

- keybinding replacement APIs：
- action id mapping：
- mock 更新：

## Gate 4：TUI 组件与 prompt/focus 行为

| 场景                            | 结果 | 证据 |
| ------------------------------- | ---- | ---- |
| `gate4-main-input-editor-flow`  |      |      |
| `gate4-prompt-focus-queue-flow` |      |      |

## Gate 5：应用级 TUI 行为

| 场景                               | 结果 | 证据 |
| ---------------------------------- | ---- | ---- |
| `gate5-calendar-mailbox-flow`      |      |      |
| `gate5-skill-channel-manager-flow` |      |      |

说明：自动 PTY smoke 只证明应用级入口、基础导航、关闭和焦点恢复可用；Calendar、Mailbox 等需要真实账号或业务数据的深层功能，必须在此处补充独立 E2E 记录。

## Gate 6：真实终端渲染

| 场景                                         | 结果 | 证据 |
| -------------------------------------------- | ---- | ---- |
| `gate6-terminal-rendering-and-keyboard-flow` |      |      |

如 evidence 中存在 `controlledTermination: true`，表示 runner 在完成 CJK/ANSI/多尺寸渲染采样后由 harness 结束进程，不表示 TUI 崩溃。

## Gate 7：用户反馈复测

| 反馈 ID 或来源 | 重复执行次数 | 迁移前崩溃数 | 迁移后崩溃数 | 归因 | 证据 |
| -------------- | ------------ | ------------ | ------------ | ---- | ---- |
|                |              |              |              |      |      |

## 收口结论

- 是否允许关闭迁移：
- 未关闭原因：
- deferred 项及归属：
