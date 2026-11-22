# TUI Overlay 设计规范

## 1. 背景

OpenDesk CLI/TUI 曾经有多处使用 `tui.showOverlay()` 显示阻塞式弹窗，例如任务切换、退出确认、通知中心、书签列表和 notice 类提示。旧式 overlay 是浮在主布局之上的独立层，容易受到背景文本宽度、终端重绘和焦点状态影响，出现位置偏移或焦点落到不可见控件的问题。

新的标准是：**所有阻塞式、需要用户选择或确认的 TUI 弹窗，都应设计为输入区位置的全宽 prompt widget**。该 widget 临时替代底部输入框；弹窗关闭后再恢复输入框或上一层 prompt。

本规范定义视觉、交互和实现约束。异步队列与焦点恢复的详细流程参见 `docs/specifications/tui_prompt_queue.md`。

## 2. 适用范围

必须遵守本规范的控件包括：

- 信息提示、错误提示、确认框、进度提示
- 任务切换、书签列表、通知中心、插件列表、升级选择等选择控件
- 权限确认、askUser、计划审批等由任务或工具调用触发的阻塞式询问
- config 页面内部需要临时提示错误或确认的局部 prompt

以下场景可以不使用输入区 prompt：

- 非阻塞、自动消失、不会抢占焦点的 toast
- 应用级完整工作台或全屏宿主界面，例如独立 calendar/mailbox/skill manager TUI 页面
- 纯背景状态渲染，不要求用户立即响应的状态条或提示

除上述例外外，不应新增基于 `tui.showOverlay()` 的交互式弹窗。

## 3. 术语

| 名称                 | 含义                                                            |
| -------------------- | --------------------------------------------------------------- |
| 输入区 prompt widget | 通过 `AgentInputArea.showPromptWidget()` 挂载到底部输入区的组件 |
| Editor 输入框        | 普通命令/消息输入框，即 `inputArea.input`                       |
| 阻塞式弹窗           | 显示期间需要拦截键盘、暂停普通输入的提示、确认、选择或进度控件  |
| prompt 栈            | `AgentInputArea` 内部维护的 prompt widget 栈，用于支持嵌套确认  |
| 旧式 overlay         | 通过 `tui.showOverlay()` 显示的浮层                             |

## 4. 设计原则

- **输入区替代**：阻塞式弹窗显示时必须隐藏 Editor 输入框，由 prompt widget 临时占据输入区。
- **全宽渲染**：prompt 使用 `render(width)` 接收到的完整宽度，不做居中浮窗、不使用固定窗口宽度。
- **焦点单一**：弹窗显示期间，焦点只能落在当前 prompt 内部可见组件上。
- **可恢复**：关闭当前 prompt 后，优先恢复上一层 prompt；没有上一层时才恢复输入框。
- **可嵌套**：确认删除、二次确认等场景使用 prompt 栈，不手动拼接多个浮窗。
- **模式隔离**：`/config`、模型未配置引导等隐藏输入区的模式默认延迟普通 prompt；只有局部配置错误提示可以显式允许显示。
- **本地化**：新增用户可见文案必须接入 locale；内部日志、测试断言、协议字段等不可本地化内容需要明确边界。

## 5. 视觉规范

### 5.1 位置

输入区 prompt 位于主内容区下方、状态栏上方，替代原本的 Editor 输入框。状态栏继续保留在最底部。

布局顺序应保持为：

1. 主内容区域
2. 输入区 prompt widget
3. status bar

不要把阻塞式 prompt 渲染成屏幕中央浮层，也不要让它依赖背景内容宽度计算位置。

### 5.2 宽度

prompt 必须按输入区可用宽度全宽渲染：

```typescript
render(width: number): string[] {
    return this.box.render(width);
}
```

禁止在 prompt 内部硬编码整体宽度或自行居中。例如不要使用固定 `60`、`80` 列宽作为容器宽度。长文本应由 `Text`、`Box`、`SelectList` 或显式截断逻辑处理，保持每行不超过传入宽度。

### 5.3 基本结构

常规 prompt 推荐使用以下结构：

1. 标题行：图标 + 标题
2. 分隔线：全宽 splitter
3. 空行或紧凑间距
4. 内容区：消息文本、搜索框、列表、进度内容或仪表盘内容
5. 操作区：`SelectList` 或明确的快捷操作 footer

示例：

```typescript
this.box = new Box(1, 1);
const oc = getOverlayColors();
this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
this.box.addChild(new Text(chalk.bold(`⚠️ ${title}`)));
this.box.addChild(new Splitter());
this.box.addChild(new Text(''));
this.box.addChild(new Text(message));
this.box.addChild(new Text(''));
this.box.addChild(this.list);
```

### 5.4 颜色和主题

- 通用提示、确认、进度控件应使用 `getOverlayColors()` 获取背景、前景和边框色。
- 列表选择控件应优先使用 `defaultSelectListTheme`。
- 不要为每个 prompt 发明完全独立的配色，除非该组件已有明确的产品语义。

### 5.5 高度

prompt 高度由内容自然决定，但应保持可扫描：

- 普通 Info/Confirm 不应超过必要行数。
- 列表类 prompt 应限制可见列表行数，过长内容应滚动或分页。
- 高信息密度面板可以更高，但仍应保持在输入区 prompt 宿主中，不使用旧式 overlay。

## 6. 交互规范

### 6.1 键盘

常规键位：

| 操作      | 语义                          |
| --------- | ----------------------------- |
| `Enter`   | 确认当前选项、打开详情或提交  |
| `Esc`     | 取消或关闭                    |
| `↑` / `↓` | 在列表中移动                  |
| `←` / `→` | 仅在 tab 或横向切换场景中使用 |
| `Delete`  | 删除当前项，必须有二次确认    |

组件自定义键位必须在组件自身的 `handleInput` 或内部子组件中处理，不应让底部 Editor 输入框接收。

### 6.2 焦点

显示 prompt 后必须把焦点设置到 prompt 内部的可交互组件：

```typescript
this.openDeskTUI.inputArea.showPromptWidget(this);
this.openDeskTUI.hasOpenOverlay = true;
this.openDeskTUI.tui.setFocus(this.list);
```

如果 prompt 自身包含搜索框或输入框，组件应实现 `Focusable`，或把焦点转发给内部输入组件。任务切换器这类“列表 + 搜索框”的控件必须保证普通字符输入进入内部搜索框，而不是进入 Editor 输入框。

### 6.3 关闭

关闭时必须使用统一的输入区 prompt 关闭流程：

```typescript
const restored = this.openDeskTUI.closeInputPrompt(this);
this.openDeskTUI.focusAfterInputPromptClose(restored);
```

规则：

- 如果 `restored` 存在，说明关闭后恢复到上一层 prompt，焦点应回到上一层 prompt。
- 如果没有上一层 prompt 且输入区可见，焦点回到 `inputArea.input`。
- 如果当前仍处于 `/config` 或模型未配置引导等输入区不可见模式，不主动把焦点设到 Editor。

不要直接调用 `tui.setFocus(inputArea.input)`，除非已经确认输入区在当前布局中可见。

### 6.4 嵌套确认

嵌套场景必须依赖 prompt 栈：

1. 外层 prompt 调用 `showPromptWidget(this)` 显示。
2. 内层确认框再调用 `showPromptWidget(confirm)`。
3. 内层关闭时 `hidePromptWidget(confirm)` 会自动恢复外层 prompt。
4. 焦点回到外层 prompt。

典型场景是任务切换器中按 `Delete` 后显示删除确认。取消删除后必须回到任务切换器，而不是直接回到底部输入框。

## 7. 生命周期规范

### 7.1 显示

普通 prompt 的 `show()` 应先处理模式延迟，再挂载：

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

如果 prompt 允许在 config 模式内部显示，必须显式声明：

```typescript
new InfoOverlay(openDeskTUI, {
    title,
    message,
    type: 'error',
    allowDuringConfig: true
}).show();
```

`allowDuringConfig` 只允许用于 config 页面自身的局部即时反馈。后台任务完成提示、权限确认、askUser、计划审批等跨任务 prompt 不应使用它。

### 7.2 关闭

`close()`、`onCancel`、`onSelect`、异步完成回调都必须走同一关闭路径。不要在不同分支里重复实现焦点恢复逻辑。

```typescript
private close(): void {
    const restored = this.openDeskTUI.closeInputPrompt(this);
    this.openDeskTUI.focusAfterInputPromptClose(restored);
}
```

### 7.3 Progress

`ProgressOverlay` 或类似短生命周期 prompt 需要考虑异步时序：

- 先显示进度，再执行异步任务。
- 异步任务完成后先关闭 progress，再显示结果 Info。
- 如果 progress 在 config 模式中被延迟显示，而任务已经完成，应避免退出 config 后补弹过期进度框。
- 进度 prompt 不应接收普通输入；如果需要取消能力，应显式设计取消键和取消语义。

## 8. 旧式 overlay 使用边界

`tui.showOverlay()` 不再作为阻塞式弹窗的默认实现。

允许保留的情况：

- toast：非阻塞、自动消失、显示期间不改变焦点。
- 应用宿主界面：完整接管当前工作流的全屏/应用层 TUI 页面。

不允许的情况：

- 确认框、错误提示、选择列表、任务切换器、通知中心等需要用户按键关闭或选择的控件。
- 会抢占焦点但不隐藏输入框的浮层。
- 宽度或位置依赖背景内容的居中弹窗。

## 9. 实现检查表

新增或修改 TUI 弹窗类时，必须检查：

- 是否是阻塞式交互；如果是，是否使用 `AgentInputArea.showPromptWidget()`。
- 显示时是否隐藏 Editor 输入框。
- `render(width)` 是否使用传入宽度全宽渲染。
- 是否避免固定整体宽度和居中浮窗定位。
- 是否在 `show()` 中调用 `deferInputPromptIfBlockedByMode()`。
- 是否正确设置 `hasOpenOverlay`。
- 是否把焦点设置到当前 prompt 内部可见组件。
- `Enter`、`Esc`、方向键等是否由 prompt 或其子组件处理。
- 关闭时是否调用 `closeInputPrompt()` 和 `focusAfterInputPromptClose()`。
- 嵌套确认是否使用 prompt 栈恢复上一层。
- config 模式下显示是否真的需要 `allowDuringConfig`。
- 异步 progress 是否处理完成后关闭和结果提示。
- 新增用户可见文案是否已接入本地化。

## 10. 参考实现

| 文件                                                | 说明                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/main/tui/components/input.ts`                  | `showPromptWidget()`、`hidePromptWidget()` 和 prompt 栈                               |
| `src/main/tui/entry.ts`                             | `deferInputPromptIfBlockedByMode()`、`closeInputPrompt()`、焦点恢复和 config 宿主切换 |
| `src/main/tui/components/notice.ts`                 | `InfoOverlay`、`ConfirmOverlay`、`ProgressOverlay` 的标准实现                         |
| `src/main/tui/components/taskswitcher.ts`           | 带内部搜索框和嵌套确认的输入区 prompt                                                 |
| `src/main/tui/components/bookmarklist.ts`           | 简单列表类 prompt                                                                     |
| `src/main/tui/components/notification.ts`           | 通知中心 prompt；toast 是旧式 overlay 的允许例外                                      |
| `src/main/tui/components/upgrade.ts`                | 异步选择/状态类 prompt                                                                |
| `src/main/applications/channelmgr/plugins-tui.ts`   | 应用插件列表 prompt                                                                   |
| `src/main/tui/components/config/shortcutsConfig.ts` | config 模式局部错误 Info prompt                                                       |
