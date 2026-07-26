/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { Skill } from '../../../../aikernel/skill.js';
import { createUseHarmonyToolset } from './tools.js';

const USE_HARMONY_SKILL = `
---
name: use-harmony
description: 通过 hdc 操控鸿蒙设备：应用管理、界面快照、点击/滑动/输入等自动化控制能力
---

# 鸿蒙设备控制

本技能通过 hdc（HarmonyOS Device Connector）操控已连接的鸿蒙设备。使用前请确保：

1. 系统环境中已安装 hdc 并可正常调用（在 PATH 中）
2. 已通过 USB 或网络连接鸿蒙设备，且 \`hdc list targets\` 能检测到设备

## 工作流程

典型的设备操控流程：

1. 使用 **listApps** 获取可打开的应用列表
2. 使用 **openApp** 打开目标应用
3. 使用 **snapshot** 获取当前界面的无障碍快照
4. 根据快照中的元素坐标，使用 **click**、**input**、**scroll** 等工具进行交互
5. 使用 **snapshot** 确认操作结果

## 操作后自动快照

所有交互工具（click、scroll、input、goBack、goForward、waitFor）都支持可选的 \`snapshot\` 参数：

- \`snapshot: true\` - 操作成功后自动等待 0.5 秒获取界面快照，结果以 \`snapshot\` 字段返回
- \`snapshot: false\`（默认）- 不自动快照，与原有行为一致

使用 \`snapshot: true\` 可以省略操作后显式调用 snapshot 的步骤，减少交互往返次数。快照结果格式与 **snapshot** 工具一致。

**推荐用法**：在预期操作会触发界面变化时（如点击按钮后、滑动页面后），设置 \`snapshot: true\` 可以直接获得变化后的界面状态。

示例：
\`\`\`
// 点击按钮后自动获取快照
click({ x: 200, y: 300, snapshot: true })

// 滑动后自动获取快照
scroll({ direction: "up", snapshot: true })

// 等待页面加载后自动获取快照
waitFor({ duration: 2000, snapshot: true })
\`\`\`

## 界面快照

使用 **snapshot** 获取当前界面的无障碍树（aria tree），格式如下：

\`\`\`
- RootWebArea "应用标题":
  - button "登录" [ref=e0 x=200 y=300 40x41]
  - textbox "用户名" [ref=e1 x=200 y=400 100x35]
  - button "提交" [ref=e2 x=200 y=500 40x41]
\`\`\`

快照会自动过滤系统 UI（桌面、Dock、状态栏）以减少输出体积。如需查看系统 UI，指定 \`bundleName: "com.ohos.sceneboard"\`。长文本会被截断到 200 字符。

关键概念：
- **role** - 元素类型（button、textbox、img、heading、list、listitem 等）
- **"name"** - 元素的显示名称
- **[ref=eN x=<cx> y=<cy>]** - 可交互元素的引用标识，包含中心坐标
- **[checked]**、**[disabled]**、**[selected]** - 元素状态
- **- /hint: ...** - 元素的提示文本
- **- text: ...** - 纯文本节点

### 指定窗口

使用 \`bundleName\` 参数可以只获取指定应用窗口的快照，过滤掉系统状态栏等其他窗口的干扰。

## 元素交互

### 点击

使用 **click** 点击指定坐标：
- 通过 snapshot 获取目标元素的 \`[ref=eN x=<cx> y=<cy>]\` 标签
- 将 x、y 坐标传入 click 工具
- 设置 \`snapshot: true\` 可在点击后自动获取界面快照
- **注意按钮重叠区域**：如果一个按钮旁边紧挨着下拉箭头/选项按钮，两者的坐标区域可能重叠。点击时应倾向于按钮的左侧区域，避免触发下拉菜单

### 输入文本

使用 **input** 在输入框中输入文本：
- 通过 snapshot 找到 textbox 元素的坐标
- 将坐标和文本内容传入 input 工具
- 支持中文输入：对非 ASCII 文本自动通过剪贴板粘贴实现
- 设置 \`snapshot: true\` 可在输入后自动获取界面快照

### 滑动

使用 **scroll** 滑动页面：
- **direction**：up（向上滑，查看下方内容）、down（向下滑，查看上方内容）、left、right
- 设置 \`snapshot: true\` 可在滑动后自动获取界面快照

### 导航

- **goBack**：按下返回键。支持 \`snapshot\` 参数
- **goForward**：按下 Alt+Right 前进导航（仅部分应用支持）。支持 \`snapshot\` 参数

### 按键

使用 **pressKey** 在当前焦点元素上按下指定按键：
- \`key\`：按键名称（Enter、Tab、Escape、Backspace、Delete、ArrowUp/Down/Left/Right、Space、Home、Back、PageUp/Down、a-z、0-9、F1-F12、Paste、Copy、Cut、Refresh 等）
- \`modifiers\`：可选修饰键列表，如 \`["Ctrl"]\` 或 \`["Ctrl", "Shift"]\`
- 设置 \`snapshot: true\` 可在按键后自动获取界面快照
- **推荐在输入消息后使用 pressKey({ key: "Enter" }) 发送，比点击"发送"按钮更可靠**

示例：
\`\`\`
// 按 Enter（推荐用于发送消息）
pressKey({ key: "Enter" })

// 按 Ctrl+A 全选
pressKey({ key: "a", modifiers: ["Ctrl"] })

// 按 Ctrl+Shift+V 粘贴
pressKey({ key: "v", modifiers: ["Ctrl", "Shift"] })
\`\`\`

### OpenDesk 消息提交

当目标是运行本技能的同一个 OpenDesk 实例时，若 HarmonyOS WebView 无法接收“发送”按钮的点击或 Enter 事件，可使用 **submitOpenDeskMessage** 直接向指定任务提交纯文本消息。该工具不通过 HDC 操作远端界面。

- \`taskId\`：本机 OpenDesk 的目标任务 ID，可通过 \`listRecentTasks\` 获取
- \`text\`：要提交的纯文本消息
- 目标任务正在运行时工具会拒绝提交，防止绕过输入框的消息队列
- 工具也会拒绝向调用它的任务自身提交，避免递归中断当前工具调用

该工具仅适用于本机 OpenDesk 任务运行时；不能向另一台设备上的 OpenDesk 实例发送消息。

### 等待

使用 **waitFor** 等待指定时间（毫秒），用于等待页面加载或动画完成。
- 设置 \`snapshot: true\` 可在等待结束后自动获取界面快照

## 应用管理

- **listApps**：获取所有可从桌面打开的应用列表。结果按设备 ID 缓存在内存中，同一设备不会重复查询（重启后重新生成）
- **openApp**：通过 bundleName 打开应用
- **listWindows**：获取当前所有窗口列表

## 注意事项

1. 每次界面变化后，都应重新调用 **snapshot** 获取最新快照（或使用 \`snapshot: true\` 自动获取）
2. 快照中的坐标是设备屏幕的绝对坐标，直接用于 click 工具
3. hdc 命令异步执行，不会阻塞界面响应
4. 部分系统应用可能无法通过 openApp 正常打开
5. **按钮重叠**：按钮与相邻下拉箭头/选项按钮的坐标区域可能重叠（如"发送"+"发送选项"），点击时应选择按钮左侧区域
6. **发送消息优先用 pressKey**：在输入框中输入文本后，优先使用 \`pressKey({ key: "Enter" })\` 发送，比点击"发送"按钮更可靠
7. **不要使用 uinput 命令**：不要通过 \`hdc shell uinput\` 发送按键事件，应使用 skill 内置的 \`pressKey\` 工具，它可以正确路由到目标应用
`;

export function loadUseHarmonySkill(): Skill {
    const skill = Skill.parseMd(USE_HARMONY_SKILL);
    skill.toolsets = [createUseHarmonyToolset()];
    return skill;
}
