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

export const USE_HARMONY_SKILL = `
---
name: use-harmony
description: 通过 hdc 操控鸿蒙设备：应用管理、界面快照、点击/滑动/输入等自动化控制能力
---

# 鸿蒙设备控制

本技能通过 hdc（HarmonyOS Device Connector）操控已连接的鸿蒙设备。使用前请确保：

1. 系统环境中已安装 hdc 并可正常调用（在 PATH 中）
2. 已通过 USB 或网络连接鸿蒙设备，且 \`hdc list targets\` 能检测到设备

## 核心原则：无障碍优先，截图兜底

**始终优先使用无障碍树（snapshot）感知和操作界面。** 只有当无障碍树无法覆盖目标元素时，才使用截图与 OCR（screenshot）作为补充。

典型场景：
- **优先 snapshot**：按钮、文本框、链接、列表等 DOM 元素 → snapshot 能看到 ref 和文本 → 用 clickRef 交互
- **需要 screenshot 兜底**：原生 \`<select>\` 弹窗、XComponent 渲染内容、系统级弹窗等 → snapshot 只看到空容器或无子节点 → 用 screenshot 获取可视文本和坐标

判断逻辑：先用 snapshot 获取界面，如果目标元素在快照中缺失或内容为空（如只有 generic 无文本），再对该区域使用 screenshot。

## 工作流程

典型的设备操控流程：

1. 使用 **listApps** 获取可打开的应用列表
2. 使用 **openApp** 打开目标应用
3. 使用 **snapshot** 获取当前界面的无障碍快照和 \`snapshotId\`
4. 根据快照中的元素引用，优先使用 **clickRef**；仅在无法获得 ref 时才使用 **click**、**input**、**scroll** 等工具进行交互
5. 当快照中目标元素缺失或内容为空时，使用 **screenshot** 获取可视文本和坐标，再用 **click** 交互
6. 使用 **snapshot** 确认操作结果

## 操作后自动快照

所有交互工具（click、scroll、input、goBack、goForward、waitFor）都支持可选的 \`snapshot\` 参数：

- \`snapshot: true\` - 操作成功后自动等待 0.5 秒获取界面快照，结果以 \`snapshot\` 字段返回
- 如果自动快照失败，操作结果仍会保留，但会返回 \`snapshotError\` 字段；此时不要把操作结果当作界面验证结果
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

每次快照还会返回 \`snapshotId\`。每次成功快照都会重新生成 ref 映射，并立即使此前快照的 \`snapshotId\` 与 ref 失效；后续操作只能使用最新快照返回的引用。带 \`snapshot: true\` 的操作也会返回一份新的快照和新的引用。

### 指定窗口

使用 \`bundleName\` 参数可以只获取指定应用窗口的快照，过滤掉系统状态栏等其他窗口的干扰。

## 元素交互

### 点击

优先使用 **clickRef** 点击快照中的元素：
- 传入同一次 snapshot 返回的 \`snapshotId\` 和目标 \`ref\`
- 工具会验证该 ref 属于最新快照，并按该元素的真实 bounds 重新计算点击点，避免把旧快照坐标用于已变化的界面
- 对“发送”这类右侧紧邻下拉选项的按钮，使用 \`position: "left-center"\`，稳定避开右侧选项区域
- 设置 \`snapshot: true\` 可在点击后自动获取同一应用的界面快照

只有没有可交互 ref 时才使用 **click** 传入绝对坐标。

示例：
\`\`\`
// snapshot 返回 { snapshotId: "s12", snapshot: "... [ref=e4 ...]" }
clickRef({ snapshotId: "s12", ref: "e4", position: "left-center", snapshot: true })
\`\`\`

### 下拉选择

操作下拉框时优先使用 **selectOption**，不要手工组合“点击触发器、重新截图、猜坐标点击选项”。该工具会在每次尝试前刷新快照，展开下拉框后优先按无障碍文本选择；原生 \`<select>\`、XComponent 等未暴露选项的界面会自动使用局部 OCR 兜底，并在点击后验证选中状态或触发器显示值。

\`trigger.name\` 用于定位下拉框本身，\`option\` 是要选择的选项文本。默认使用精确匹配；只有界面会给选项附加说明文字时才改用 \`match: "contains"\`。

\`\`\`
selectOption({
    trigger: { role: "combobox", name: "语言" },
    option: "简体中文",
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    verify: true
})
\`\`\`

只有 **selectOption** 明确返回失败时，才使用 **snapshot**、**screenshot** 和 **click** 手工兜底。不要把“已点击选项”当作成功；默认保留 \`verify: true\`，以工具的验证结果为准。

### 输入文本

使用 **input** 在输入框中输入文本：
- 通过 snapshot 找到 textbox 元素的坐标
- 将坐标和文本内容传入 input 工具
- 默认使用 \`mode: "append"\` 在当前光标处追加；已知内容长度上限时，可使用 \`mode: "replace"\` 从开头删除已有文本后再输入
- \`replace\` 默认最多删除 256 个字符；已知内容更长时显式传入 \`maxClearChars\`。快照无法校验输入框当前值，不要将此模式当作无上限的清空断言
- 支持中文输入：对非 ASCII 文本自动通过剪贴板粘贴实现
- 设置 \`snapshot: true\` 可在输入后自动获取界面快照

示例：

\`\`\`
input({ x: 540, y: 1820, text: "新消息", mode: "replace", maxClearChars: 512 })
\`\`\`

### 测试文件、系统文件选择器与拖放

使用 **stageFixture** 将宿主机测试文件或目录下发到设备，再通过 **chooseFile** 完成系统文件选择器中的文件、目录或保存路径选择。目标目录必须是系统 Picker 可浏览的位置。

\`\`\`
// 下发应用包，然后在已经打开的系统 Picker 中选择它
stageFixture({
    localPath: "/absolute/fixtures/gui-gap-demo.zip",
    deviceDirectory: "/data/local/tmp/opendesk-fixtures"
})
chooseFile({
    path: "/data/local/tmp/opendesk-fixtures/gui-gap-demo.zip",
    mode: "openFile",
    snapshot: true
})

// 选择技能目录
chooseFile({
    path: "/data/local/tmp/opendesk-fixtures/gui-gap-skill",
    mode: "openDirectory"
})

// 在保存 Picker 中填写文件名并确认
chooseFile({
    path: "/data/local/tmp/opendesk-fixtures/setting.json",
    mode: "saveFile"
})
\`\`\`

**chooseFile 使用边界**：

- 必须先通过 GUI 点击打开系统 Picker；工具不会替用户触发“导入”或“上传”按钮
- 工具依赖系统 Picker 的无障碍树，按路径末尾名称和“打开 / 选择 / 保存”等按钮语义操作
- 如果 Picker 没有暴露目标条目或确认按钮，工具会停止并返回最后快照，不会盲点坐标
- \`/data/local/tmp\` 在部分设备上可能不会被系统 Picker 展示；遇到此情况应把 fixture 下发到已验证可浏览的公共测试目录

**系统文件选择器无障碍树结构**（com.huawei.hmos.filemanager）：

当系统文件选择器打开后，可用 **snapshot** 获取其完整无障碍树，所有元素均有 ref：

\`\`\`
左侧导航栏：
├── 主页
├── 智能分类
├── 快速访问（可折叠）
│   ├── 桌面 → file://docs/storage/Users/currentUser/Desktop
│   ├── 文档 → file://docs/storage/Users/currentUser/Documents
│   ├── 下载 → file://docs/storage/Users/currentUser/Download
│   ├── 图片、音频、视频
├── 存储位置
│   ├── developer（设备根存储）
│   ├── 系统
│   ├── 个人（用户主目录）
│   ├── 网络、我的云盘
└── 来源

右侧文件列表：grid 或 list 视图，每个文件/文件夹都有 ref

底部：
├── 文件格式过滤器（如 "Zip archive.(*.zip)"）
├── 已选 (N/M)
├── 取消 / 打开（确认按钮）
顶部：关闭按钮
\`\`\`

**关键导航模式**：
- 用户主目录通过侧边栏「个人」进入（路径：\`file://docs/storage/Users/currentUser/\`）
- 侧边栏所有导航项均可通过 **clickRef** 精确点击，不需要坐标盲点
- 文件/文件夹在列表中以 listitem 形式呈现，有完整 ref 和文本名称，**clickRef** 可直接选中
- 确认按钮（「打开」/「选择」）和取消按钮同样有 ref，可精确点击
- **chooseFile** 工具会自动处理上述所有导航和选择逻辑，无需手动操作

当产品通过拖放接收图片或附件时，使用 **dropFixture**。它在目标 WebView 坐标创建 \`File\` 和 \`DataTransfer\`，并依次派发 \`dragenter\`、\`dragover\`、\`drop\`，从而进入产品真实的拖放处理逻辑。文件上限为 20 MiB。

\`\`\`
dropFixture({
    localPath: "/absolute/fixtures/gui-gap-icon.png",
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    x: 600,
    y: 720,
    snapshot: true
})
\`\`\`

优先使用 \`chooseFile\` 覆盖真正的系统 Picker 集成；只有产品本身支持拖放、或 Picker 无障碍树不可操作时才使用 \`dropFixture\`。上传后继续用 **waitFor** 验证缩略图、文件名或导入结果，不要把工具返回成功直接当作业务成功。

### 指针手势

- 使用 **doubleClick** 在指定坐标执行原生双击，用于双击打开、日期选择等场景
- 使用 **drag** 在指定起点和终点之间执行连续拖动，用于调整布局、拖动选择或拖放；不能使用两次点击或 scroll 替代
- 使用 **longClick** 在指定坐标执行原生长按；部分 HarmonyOS WebView 可能将长按转换为 \`contextmenu\`，但该行为不保证适用于所有原生控件
- **右键模拟**：HDC 工具链不支持原生右键点击。如需模拟右键（如测试 Electron 上下文菜单），应使用 **longClick** 替代。部分 HarmonyOS WebView 和 Electron 应用会将长按事件转换为 \`contextmenu\` 事件，从而触发右键菜单。该行为不保证 100% 覆盖所有控件，但这是 HDC 环境下唯一可行的右键模拟方案
- 三种手势均支持 \`snapshot: true\`；结果中的 \`native: true\` 表示已调用设备原生手势命令

示例：

\`\`\`
doubleClick({ x: 720, y: 420, snapshot: true })
drag({ fromX: 320, fromY: 540, toX: 620, toY: 540, speed: 600, snapshot: true })
longClick({ x: 480, y: 360, snapshot: true })
\`\`\`

### 系统权限确认

使用 **handlePermission** 处理当前系统权限确认框。该工具会先获取新的界面快照，识别同时具有权限/通知提示文本和标准“允许 / 仅此一次 / 拒绝”按钮的对话框。

- 必须显式传入 \`action\`，不会自动授予权限
- \`action: "inspect"\` 只返回权限提示、可用操作和新的 \`snapshotId\`，不点击
- \`action: "allow"\`、\`"allowOnce"\`、\`"deny"\` 仅点击对话框实际提供的对应按钮
- 未检测到安全可识别的权限确认框，或请求的操作不存在时，工具会拒绝点击

示例：
\`\`\`
// 先查看系统正在请求什么权限
handlePermission({ action: "inspect" })

// 仅在明确需要时授权
handlePermission({ action: "allowOnce", snapshot: true })
\`\`\`

### 滑动

使用 **scroll** 滑动页面：

- **direction**：up（向上滑，查看下方内容）、down（向下滑，查看上方内容）、left、right
- **region**：可选，指定滑动区域 \`{ x, y, width, height }\`。不指定则使用全屏 dircFling（可能只影响当前焦点滚动容器）。指定后会在该区域内执行 drag 手势，适用于侧边栏等独立滚动区域
- **distance**：可选，精确滚动距离（像素）。不指定时默认为容器高度/宽度的 60%。仅对区域滚动（region 或 scrollByContainer）有效
- **scrollByContainer**：可选，\`{ role, name? }\`——从最新快照中自动定位滚动容器区域，无需预先知道坐标。role 如 \`"list"\`、\`"generic"\`，name 用于进一步匹配。与 region 互斥
- 设置 \`snapshot: true\` 可在滑动后自动获取界面快照

示例：
\`\`\`
// 全屏滑动
scroll({ direction: "up", snapshot: true })

// 在侧边栏区域精确滑动 200px
scroll({ direction: "up", region: { x: 400, y: 700, width: 500, height: 400 }, distance: 200, snapshot: true })

// 按容器 role 自动定位——滚动侧边栏任务列表
scroll({ direction: "up", scrollByContainer: { role: "list", name: "任务" }, distance: 300 })

// 滚动聊天历史区域
scroll({ direction: "up", scrollByContainer: { role: "generic" }, snapshot: true })
\`\`\`

### 滚动到指定元素

使用 **scrollTo** 滚动页面直到目标元素在快照中可见（scrollIntoView 语义）：

- **targetRole**：目标元素的 role（\`"button"\`、\`"listitem"\`、\`"textbox"\` 等）
- **targetName**：可选，目标元素的显示名称，模糊匹配
- **targetHint**：可选，目标元素的 hint 提示文本
- **containerRole** / **containerName**：可选，指定滚动容器。不指定则使用全屏 dircFling
- **direction**：可选，滚动方向（\`"up"\` / \`"down"\`），不指定时默认向下查找（up 方向）
- **maxScrolls**：最大滚动尝试次数，默认 5
- **scrollDistance**：每次滚动的距离（像素），默认 300
- **snapshot**：默认 true，滚动完成后自动获取界面快照

返回 \`scrollsUsed\`（实际滚动次数）、\`targetFound\`（是否找到）和找到的元素信息。

典型用法：
\`\`\`
// 滚动任务列表直到看到"任务甲"
scrollTo({ targetRole: "listitem", targetName: "任务甲", containerRole: "list" })

// 滚动聊天历史直到看到"停止生成"按钮
scrollTo({ targetRole: "button", targetName: "停止生成", maxScrolls: 10, scrollDistance: 500 })

// 在 notes 列表中滚动到指定笔记
scrollTo({ targetRole: "listitem", targetName: "滚动笔记-25", containerRole: "list", maxScrolls: 8 })
\`\`\`

**注意**：\`scrollTo\` 会多次获取快照（每次滚动后等待 500ms），总耗时 ≈ \`maxScrolls × (scroll动画 + 500ms)\`。确保目标元素确实在滚动容器的可达范围内。


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

不要使用绕过界面的 OpenDesk 内部消息提交入口。通过设备界面发送消息时，组合使用通用 HDC 工具：

1. 使用 **snapshot** 获取 OpenDesk 窗口的最新快照
2. 从快照中找到 role 为 \`textbox\` 的消息输入框及其坐标
3. 使用 **input** 输入文本
4. 使用 **pressKey** 按 Enter 发送
5. 使用 **waitFor** 或新的 **snapshot** 验证用户消息、运行状态或错误提示

示例：

\`\`\`
// snapshot 中显示 textbox "在这里输入消息，按 Enter 发送" [ref=e3 x=540 y=1820 ...]
input({ x: 540, y: 1820, text: "帮我写一段 Hello World 的 Python 代码" })
pressKey({ key: "Enter", snapshot: true })
\`\`\`

HDC 命令成功只表示输入或按键已经派发，不能单独证明消息已被应用接受。专门验证发送按钮点击时，使用 **clickRef** 并指定 \`position: "left-center"\`。

### 等待

优先使用 **waitFor** 的条件模式等待界面进入预期状态，避免用固定 sleep 猜测页面加载时间。条件满足和超时时都会返回最后一份无障碍快照；超时还会默认尝试附加屏幕 OCR 证据。

- **text**：等待文本出现或消失，支持 exact / contains
- **element**：按 role、name、id、hint 定位元素，等待 visible / hidden / enabled / disabled
- **snapshotChange**：等待界面内容相对指定 \`snapshotId\` 发生变化；比较时忽略临时 ref 和坐标
- **window**：等待指定 bundleName 的窗口出现或消失
- \`timeout\`：条件等待的总超时，默认 10000 毫秒
- \`interval\`：无障碍树轮询间隔，默认 500 毫秒
- \`stableFor\`：条件需要连续成立的时间，默认 300 毫秒，防止把动画或闪烁状态当成成功

ref 只属于单次快照，不能跨轮询稳定使用。因此等待元素时使用 role/name/id/hint 重新定位，不要等待字面量 \`e3\`。

示例：

\`\`\`
// 发送消息后，等待任务进入生成状态
waitFor({
    condition: {
        type: "element",
        locator: { role: "button", name: "停止生成" },
        state: "visible"
    },
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    timeout: 15000
})

// 等待生成结束
waitFor({
    condition: {
        type: "element",
        locator: { role: "button", name: "停止生成" },
        state: "hidden"
    },
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    timeout: 120000,
    stableFor: 1000
})

// 等待回复中出现目标文本
waitFor({
    condition: { type: "text", text: "Hello World", match: "contains", state: "visible" },
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    timeout: 120000
})
\`\`\`

只有无法用界面状态表达等待条件时，才使用兼容的固定等待模式：\`waitFor({ duration: 1000, snapshot: true })\`。

### 截图与 OCR（无障碍树的兜底方案）

使用 **screenshot** 截取设备屏幕并执行 OCR 文本识别和区域亮度分析。**此工具是 snapshot 的补充，不是替代**——仅当无障碍树无法暴露目标元素时才使用，例如：

- 原生 \`<select>\` 弹窗：snapshot 只看到空的 XComponent 容器，screenshot 能识别选项文本和行位置
- 系统级弹窗：snapshot 不包含其内容，screenshot 能直接读取
- 需要验证视觉状态（深色/浅色主题、颜色变化）：screenshot 的亮度分析可判断

- \`region\`：可选裁剪区域 \`{x1, y1, x2, y2}\`，只分析指定区域。不指定则返回全屏分析结果
- \`ocr\`：是否执行 OCR 文本识别，默认 true。需要系统安装 tesseract
- 返回 \`ocr\` 数组：每项包含 \`text\`、\`x\`/\`y\`（设备坐标）、\`width\`/\`height\`、\`confidence\`
- 返回 \`regions\` 数组（仅当指定 region 时）：每项包含 \`y1\`/\`y2\`（行范围）、\`avgBrightness\`、\`highlighted\`（是否为高亮/选中行）

示例：
\`\`\`
// 截取全屏并 OCR
screenshot({})

// 截取指定区域并分析亮度行（用于识别下拉选项）
screenshot({ region: { x1: 1654, y1: 459, x2: 2079, y2: 601 } })

// 只做亮度分析，不执行 OCR
screenshot({ region: { x1: 1654, y1: 459, x2: 2079, y2: 601 }, ocr: false })
\`\`\`

### 视觉断言

使用 **visualAssert** 对截图进行像素级对比或颜色采样，用于验证主题切换、布局变化、按钮状态等视觉行为。支持三种模式：

#### diff 模式 — 截图对比

与基线截图做像素级对比，用于回归测试和布局变化检测。

- \`baseline\`：基线截图的本地文件路径（PNG 或 JPEG）
- \`threshold\`：像素差异容差（0-1），默认 0.1。值越小越严格
- \`outputDiff\`：是否输出差异叠加图（红色高亮差异像素），默认 false
- \`region\`：可选，只对比指定区域

返回 \`diffPixels\`（差异像素数）、\`diffPercent\`（差异百分比）、\`passed\`（是否通过）。

示例：
\`\`\`
// 全屏对比
visualAssert({ mode: "diff", baseline: "/path/to/baseline.png", threshold: 0.05 })

// 只对比侧边栏区域
visualAssert({
    mode: "diff",
    baseline: "/path/to/sidebar-baseline.png",
    region: { x1: 0, y1: 0, x2: 300, y2: 1920 },
    outputDiff: true
})
\`\`\`

#### color 模式 — 颜色采样

采样指定坐标的 RGB 颜色值，用于验证主题色、按钮 disabled 灰化、active 高亮等。

- \`samples\`：采样点数组，每项含 \`x\`/\`y\` 坐标、可选的 \`expected\` 颜色和 \`tolerance\` 容差
- 返回每个采样点的 \`r\`/\`g\`/\`b\` 值和 \`hex\` 字符串，以及是否匹配预期

示例：
\`\`\`
// 验证"发送"按钮的蓝色
visualAssert({
    mode: "color",
    samples: [
        { x: 600, y: 1800, expected: "#1976d2", tolerance: 15 },
        { x: 200, y: 100, expected: "#f5f5f5", tolerance: 10 }
    ]
})
\`\`\`

#### theme 模式 — 主题检测

自动检测当前界面是浅色还是深色主题。采样 3x3 网格区域计算平均亮度。

- \`expectedTheme\`：可选，如指定则返回 \`passed\` 字段判断是否匹配

示例：
\`\`\`
// 检测当前主题
visualAssert({ mode: "theme" })

// 验证已切换为深色主题
visualAssert({ mode: "theme", expectedTheme: "dark" })
\`\`\`

### 悬停

使用 **hover** 在指定坐标模拟鼠标悬停（pointerenter / mouseover 事件）。

采用三层降级策略：
1. 优先尝试 HDC 原生 mouseMove 命令
2. 降级为 WebView JavaScript 事件注入（向 OpenDesk WebView 注入 PointerEvent）
3. 最后降级为 0 像素低速 drag 变通方案（不可靠，可能不触发 :hover CSS）

- \`x\`/\`y\`：悬停位置坐标
- \`duration\`：悬停保持时长（毫秒），默认 800ms
- 返回 \`method\` 字段标识实际生效的路径，\`native\` 表示是否为原生命令
- 设置 \`snapshot: true\` 可在悬停后自动获取界面快照

**注意**：方法 1 和 2 的成功率取决于设备环境。若 hover 未产生预期效果（如 tooltip 未出现），检查返回的 \`method\` 字段；若为 \`zero-pixel-drag\` 则说明环境不支持前两种方法。

示例：
\`\`\`
// 悬停在截断单元格上查看 tooltip
hover({ x: 500, y: 300, duration: 1000, snapshot: true })

// 悬停在任务条目上展开子菜单
hover({ x: 200, y: 400, duration: 500 })
\`\`\`

### 语义元素查询

使用 **findElement** 从最新快照中按条件编程化查询元素，**无需 LLM 手动解析无障碍树文本**。所有条件是 AND 关系。

- **role**：可选，元素角色（\`"button"\`、\`"textbox"\`、\`"listitem"\` 等）
- **name**：可选，元素显示名称，大小写不敏感模糊匹配
- **hint**：可选，元素的 hint 提示文本
- **state**：可选，\`"disabled"\` / \`"enabled"\` / \`"checked"\` / \`"selected"\`
- **text**：可选，搜索元素内纯文本子节点（\`- text: "..."\`）
- **ref**：可选，精确按 ref 查找
- **limit**：最大返回数量，默认 20

返回匹配元素的 \`ref\`、\`role\`、\`name\`、\`bounds\`、\`center\` 和状态标记。返回的 \`ref\` 可直接用于 \`clickRef\` 等后续操作。

典型模式：
\`\`\`
// 查找"发送"按钮
findElement({ role: "button", name: "发送" })
// → { elements: [{ ref: "e5", role: "button", name: "发送", center: {x:600,y:1800}, ... }] }
// 然后直接: clickRef({ snapshotId: "s3", ref: "e5" })

// 查找所有禁用按钮
findElement({ role: "button", state: "disabled" })

// 按文本内容查找列表项
findElement({ role: "listitem", text: "Hello World" })
\`\`\`

### 元素状态查询

使用 **getElementState** 获取指定 ref 的完整状态：

- **ref**：元素引用标识（如 \`"e5"\`），必须来自最新快照

返回 \`found\`、\`role\`、\`name\`、\`bounds\`、\`center\` 和 \`checked\` / \`disabled\` / \`selected\` 状态。

\`\`\`
// 验证按钮是否被禁用
getElementState({ ref: "e5" })
// → { found: true, disabled: true, role: "button", name: "发送", ... }

// 验证勾选框状态
getElementState({ ref: "e8" })
// → { found: true, checked: true, role: "checkbox", ... }
\`\`\`

## 应用管理

- **listApps**：获取所有可从桌面打开的应用列表。结果按设备 ID 缓存在内存中，同一设备不会重复查询（重启后重新生成）
- **openApp**：通过 bundleName 打开应用
- **appLifecycle**：强制停止、冷重启、清除缓存或清除应用数据，用于构造确定的 GUI 测试前置状态
- **listWindows**：获取当前所有窗口列表

### 应用生命周期与测试环境重置

使用 **appLifecycle** 控制被测应用的进程和本地状态：

- \`action: "stop"\`：强制停止应用，不再启动
- \`action: "restart"\`：强制停止后重新解析入口 Ability 并启动，用于冷启动与持久化恢复测试
- \`action: "clearCache"\`：强制停止并清除缓存；\`relaunch\` 默认为 true
- \`action: "clearData"\`：强制停止并清除全部应用本地数据、账号和配置；必须显式设置 \`confirmDestructive: true\`，\`relaunch\` 默认为 true
- \`settleTime\`：操作完成后的稳定等待时间，默认 1000 毫秒
- \`snapshot: true\`：重新启动后获取目标应用快照。应用保持停止时不会尝试获取快照

\`clearData\` 是不可恢复的破坏性操作。执行前必须确认 bundleName 指向隔离的测试应用或允许清空的测试环境；不要对用户正在使用的生产数据执行。

示例：

\`\`\`
// 冷重启并验证恢复后的界面
appLifecycle({
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    action: "restart",
    settleTime: 2000,
    snapshot: true
})

// 清除测试应用数据，建立干净 profile 后重新启动
appLifecycle({
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    action: "clearData",
    confirmDestructive: true,
    relaunch: true,
    settleTime: 2000,
    snapshot: true
})
\`\`\`

## 注意事项

1. **无障碍优先**：始终先使用 **snapshot** 感知界面；只有当目标元素在快照中缺失或内容为空时，才使用 **screenshot** 作为兜底
2. 每次界面变化后，都应重新调用 **snapshot** 获取最新快照（或使用 \`snapshot: true\` 自动获取）
3. 快照中的坐标是设备屏幕的绝对坐标，直接用于 click 工具
4. hdc 命令异步执行，不会阻塞界面响应
5. 部分系统应用可能无法通过 openApp 正常打开
6. **发送按钮**：不要直接点击快照中心坐标；使用 \`clickRef({ snapshotId, ref, position: "left-center" })\`，避免命中相邻的发送选项按钮
7. **OpenDesk 测试发送消息**：使用 snapshot 定位输入框，使用 input 输入，再用 pressKey 按 Enter；必须根据操作后的快照验证结果。专门测试发送按钮时使用 \`clickRef\` 的 \`left-center\`
8. **不要使用 uinput 命令**：不要通过 \`hdc shell uinput\` 发送按键事件，应使用 skill 内置的 \`pressKey\` 工具，它可以正确路由到目标应用
9. **清除数据需显式确认**：只有在确认目标 bundleName 和测试环境后，才可使用 \`appLifecycle({ action: "clearData", confirmDestructive: true })\`
`;
