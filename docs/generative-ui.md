# 生成式 UI

模型在对话里调用 `showUI` / `askUI`，按组件名和数据渲染出可交互的卡片，桌面版与 web 模式通用。

## 原理

- 组件是预制的 React 组件（`src/renderer/genui/vendor/assistant-ui`，来自 [assistant-ui](https://github.com/assistant-ui/assistant-ui) 的 Elements，MIT），模型只提供数据，不生成代码。
- 组件直接挂载在对话 DOM 中，不使用 iframe；样式走全局 Tailwind，shadcn 语义色（`background`、`foreground`、`muted-foreground` 等）在 `src/renderer/styles/common.css` 里映射到 OpenDesk 主题变量，`dark:` 跟随 `html[data-theme='dark']`。
- 工具参数按 `src/common/genui/catalog.ts` 的 zod schema 校验，校验失败作为工具错误交还模型；工具说明里附带每个组件的 JSON Schema。
- 主进程把工具调用渲染为带 `data-genui` 载荷的占位节点；渲染进程的 MutationObserver（`src/renderer/genui/index.ts`）发现占位节点后按需加载 React（`mount.tsx`），并按「调用 id + 组件 + props」缓存组件节点：taskview 重建或就地合并消息 HTML 后接回原节点，未提交的输入不会丢。
- 组件条目在对话里始终显示，不随已完成的过程折叠（`taskview-output.ts` 的 `widget` 项）。

## 工具

| 工具     | 组件                                                                   | 行为                                                                                                  |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `showUI` | `data-table`、`chart`、`comparison-card`、`link-preview`、`spec-sheet` | 展示后立即返回                                                                                        |
| `askUI`  | `option-list`、`question-flow`、`approval-card`、`form`                | 阻塞等待用户操作，结果（及给模型看的摘要）作为工具结果返回；无人值守模式不可用，30 分钟无操作自动取消 |

`askUI` 的请求 id 随工具调用的渲染结果下发，组件拿到后才可交互；用户操作经 `genui:respond` 回到主进程（`electronGenUi.ts`），按组件 schema 校验后结算。web 模式下多个标签页看到同一张卡片，任一标签页提交后其余标签页随工具结果刷新为回执。

两个工具只在 Electron 平台的交互工具集里挂载（主任务、用户发起的轮次）。

## 新增组件

1. 把组件放进 `src/renderer/genui/vendor/assistant-ui/elements`（或自写），保持与上游可对比；
2. 在 `src/common/genui/protocol.ts` 的 `GENUI_COMPONENT_NAMES` 加名字，在 `catalog.ts` 加 props schema（交互组件还要回传 schema、校验与摘要）；
3. 在 `src/renderer/genui/widgets.tsx` 的 `WIDGETS` 里接上；
4. 在 `src/tests/ut/genui/fixtures.ts` 补一份样例 props，现有测试会覆盖校验与渲染。

## 测试

- 单元测试：`npm test -- src/tests/ut/genui`
- 端到端（web 模式，本机或容器）：脚本自带模型桩，逐个场景驱动界面并截图

```bash
node scripts/e2e/genui-web.mjs --url http://127.0.0.1:8790 --token <令牌> --out /tmp/genui-e2e
# 被测实例在容器里时，模型桩地址要让容器能访问到：
node scripts/e2e/genui-web.mjs --url http://127.0.0.1:8080 --token <令牌> \
    --mock-url http://host.docker.internal:18790/v1
```
