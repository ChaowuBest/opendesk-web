# TUI Prompt 队列与焦点管理设计规范

## 1. 背景

OpenDesk CLI/TUI 中存在多类会临时抢占输入焦点的交互控件：

- 输入区 prompt widget：`InfoOverlay`、`ConfirmOverlay`、`ProgressOverlay`、权限确认、askUser、计划审批、`/switch`、`/skills`
- 全屏或主布局模式：`/config`、模型未配置引导页、文本页面
- 旧式 TUI overlay：通知 toast、应用层特殊 overlay

这些控件如果在同一时间争用焦点，容易出现以下问题：

- 焦点落到不可见组件，用户无法按键关闭弹窗
- 背景任务完成后弹窗插入到当前不可见的输入区
- 关闭弹窗后把焦点恢复到已经不在布局中的输入框
- 多个 prompt 同时显示，后一个 prompt 覆盖前一个 prompt 的焦点状态

典型问题是：用户手动触发上下文压缩后立即进入 `/config`。压缩成功时 `InfoOverlay` 试图显示在输入区 prompt 插槽中，但 `/config` 默认隐藏输入区，导致弹窗显示与焦点状态不一致。

## 2. 设计目标

- **单入口显示**：新增或修改输入区 prompt 时优先走 `AgentInputArea.showPromptWidget()`。
- **模式隔离**：`/config` 等隐藏输入区的模式下，普通 prompt 不立即显示，而是延迟到模式退出后再处理。
- **焦点可见性约束**：只有输入区确实挂载在当前布局中时，才允许把焦点恢复到 `inputArea.input`。
- **顺序处理**：同一时刻只显示一个阻塞式 prompt；后续 prompt 等前一个关闭后再处理。
- **保留例外**：配置页内部自身需要显示的错误提示可以显式允许在 config 模式下显示。

## 3. 核心状态

核心实现位于 `src/main/tui/entry.ts`：

| 成员 / 方法                                      | 作用                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `pendingInputPromptActions`                      | 保存被 `/config` 等模式延迟的 prompt 显示动作                    |
| `isInputAreaMounted()`                           | 判断 `inputArea` 当前是否在主布局中                              |
| `isInputBlocked()`                               | 判断当前是否已有 config、overlay 或 prompt 阻塞输入              |
| `deferInputPromptIfBlockedByMode(show, options)` | 如果当前处于不适合显示输入区 prompt 的模式，则入队并返回 `true`  |
| `closeInputPrompt(widget?)`                      | 统一关闭输入区 prompt，并同步 `hasOpenOverlay`                   |
| `focusInputAreaIfAvailable()`                    | 仅当输入区可见时恢复输入焦点                                     |
| `focusAfterInputPromptClose(restored)`           | prompt 关闭后优先恢复上层 prompt，否则恢复可见输入框             |
| `processPendingPrompts()`                        | 退出阻塞状态后依次处理延迟 prompt、权限、askUser、计划审批等队列 |

## 4. 显示流程

普通 prompt 的 `show()` 必须先判断是否需要延迟：

```typescript
show() {
    if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
        return;
    }

    this.openDeskTUI.inputArea.showPromptWidget(this);
    this.openDeskTUI.hasOpenOverlay = true;
    this.openDeskTUI.tui.setFocus(this.list);
}
```

当当前处于 `/config` 等不应插入输入区 prompt 的模式时：

1. `deferInputPromptIfBlockedByMode()` 把 `show` 回调放入 `pendingInputPromptActions`
2. 当前 prompt 不显示，也不改变焦点
3. 退出 `/config` 后调用 `processPendingPrompts()`
4. `processPendingInputPrompts()` 取出队首回调并显示 prompt
5. 如果显示后进入阻塞状态，本轮停止继续处理其他 prompt

## 5. 关闭流程

关闭输入区 prompt 时不要直接调用 `inputArea.hidePromptWidget()` 后手写恢复焦点，统一使用：

```typescript
const restored = this.openDeskTUI.closeInputPrompt(this);
this.openDeskTUI.focusAfterInputPromptClose(restored);
```

规则：

- 如果关闭后恢复到上一层 prompt，则焦点回到上一层 prompt。
- 如果已经没有 prompt，且输入区当前可见，则焦点回到 `inputArea.input`。
- 如果当前处于 `/config` 或模型未配置引导等输入区不可见模式，不主动设置输入框焦点。

## 6. Config 模式例外

默认情况下，`/config` 模式会延迟普通 prompt。少数 config 页面内部的即时错误提示需要继续在 config 模式下显示，例如快捷键设置页捕获到非法单键时的错误弹窗。

这类场景必须显式声明：

```typescript
new InfoOverlay(openDeskTUI, {
    title,
    message,
    type: 'error',
    allowDuringConfig: true
}).show();
```

只允许 config 页面自身的局部提示使用 `allowDuringConfig: true`。后台任务完成提示、权限确认、askUser、计划审批等跨任务 prompt 不应使用该选项。

## 7. ProgressOverlay 延迟取消

`ProgressOverlay` 可能在 config 模式中被延迟显示，但后台操作可能在用户退出 config 前已经完成并调用 `hide()`。

为避免退出 config 后补弹过期进度框，`ProgressOverlay` 使用 `cancelled` 与 `deferredToken`：

- `show()` 入队时记录 token
- `hide()` 会标记 cancelled 并递增 token
- 延迟回调执行时仅在 token 仍匹配且未取消时显示

新增可取消或短生命周期 prompt 时，也应考虑类似的延迟取消语义。

## 8. 与专用队列的关系

权限确认、askUser、计划审批已经有各自的业务队列。它们仍保留自己的队列语义，但显示前必须遵守统一阻塞判断：

- 如果 `openDeskTUI.isInputBlocked()` 为 `true`，业务请求留在各自队列中
- 退出阻塞状态后由 `processPendingPrompts()` 依次触发：
    1. 延迟的通用输入区 prompt
    2. 权限确认队列
    3. askUser 队列
    4. exitPlanMode 队列
    5. 全局默认模型切换提示

每显示一个 prompt 后都要重新检查 `isInputBlocked()`，避免同一轮连续弹出多个控件。

## 9. 新增或修改 TUI 弹窗的检查表

新增或修改 CLI/TUI 弹窗、输入区替代控件、全屏页面、快捷键捕获页时，必须检查：

- 是否会抢占焦点或拦截键盘输入
- 是否使用 `AgentInputArea.showPromptWidget()` 挂载到输入区
- `show()` 是否先调用 `deferInputPromptIfBlockedByMode()`
- `close/cancel/done` 是否使用 `closeInputPrompt()` 和 `focusAfterInputPromptClose()`
- 是否可能在后台异步完成后显示提示
- 是否可能在 `/config`、模型未配置引导、已有 prompt 显示时触发
- 是否需要业务队列，还是只需要通用延迟队列
- 是否有短生命周期 progress，需要延迟取消保护
- 是否引入了新的用户可见文案，并按项目本地化要求处理

## 10. 参考实现

| 文件                                           | 说明                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `src/main/tui/entry.ts`                        | 队列、阻塞判断、焦点恢复公共方法                                |
| `src/main/tui/components/notice.ts`            | `InfoOverlay`、`ConfirmOverlay`、`ProgressOverlay` 接入通用队列 |
| `src/main/tui/components/permission.ts`        | 权限确认业务队列与公共焦点恢复                                  |
| `src/main/tui/components/askUser.ts`           | askUser 业务队列与公共焦点恢复                                  |
| `src/main/tui/components/exitPlanMode.ts`      | 计划审批业务队列与公共焦点恢复                                  |
| `src/main/tui/components/taskswitcher.ts`      | 输入区 prompt 风格的任务切换面板                                |
| `src/main/applications/skillmgr/skills-tui.ts` | `/skills` 输入区 prompt 风格面板                                |
