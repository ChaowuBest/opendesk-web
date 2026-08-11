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

通过 hdc（HarmonyOS Device Connector）操控已连接的鸿蒙设备。前提：hdc 在 PATH 中，\`hdc list targets\` 能检测到设备。

## 核心原则：无障碍优先，截图兜底

**始终优先用 snapshot（无障碍树）感知和操作界面。** 只有当目标元素在快照中缺失或内容为空（原生 \`<select>\`、XComponent、系统弹窗等），才用 screenshot + OCR 兜底。判断逻辑：先 snapshot → 目标缺失或内容为空时 → screenshot 该区域。

## 工作流程

1. **listApps** → 2. **openApp** → 3. **snapshot** → 4. **clickRef**（优先）或 **click**/input/scroll → 5. 目标不可达时 **screenshot** 兜底 → 6. **snapshot** 确认结果

## 操作后自动快照

所有交互工具（click、scroll、input、goBack、goForward、waitFor 等）支持 \`snapshot: true\`，操作后自动等 0.5s 获取快照。失败时返回 \`snapshotError\`，不要当做界面验证结果。在预期会触发界面变化时推荐开启，减少往返。

\`\`\`
clickRef({ snapshotId: "s12", ref: "e4", position: "left-center", snapshot: true })
\`\`\`

## 界面快照

\`snapshot\` 返回无障碍树，格式为缩进文本：

\`\`\`
- RootWebArea "应用标题":
  - button "登录" [ref=e0 x=200 y=300]
  - textbox "用户名" [ref=e1 x=200 y=400]
  - button "提交" [ref=e2 x=200 y=500]
\`\`\`

自动过滤系统 UI；长文本截断到 120 字符。关键字段：**role**（元素类型）、**"name"**（显示名）、**[ref=eN x y]**（可交互引用+中心坐标）、**[checked/disabled/selected]**（状态）、**- text:**（纯文本子节点）。

每次快照返回 \`snapshotId\`，并立即使此前快照的 ref 失效，后续只能使用最新快照的引用。用 \`bundleName\` 参数过滤特定应用窗口。

## 元素交互

### 点击

优先 **clickRef**：传入最新 \`snapshotId\` + 目标 \`ref\`（工具会自动验证 ref 属于最新快照并按元素真实 bounds 重算点击点）。对"发送"等右侧紧邻下拉选项的按钮，用 \`position: "left-center"\` 避开误触。只在无 ref 可用时用 **click** 传绝对坐标。

\`\`\`
clickRef({ snapshotId: "s12", ref: "e4", position: "left-center", snapshot: true })
\`\`\`

### 下拉选择

优先 **selectOption**，不要手工组合"点击触发器→截图→猜坐标"。先刷新快照，展开后用无障碍文本选择；原生 \`<select>\`/XComponent 自动 OCR 兜底，点击后验证选中状态。\`trigger.name\` 定位下拉框，\`option\` 为选项文本，默认精确匹配；只有界面给选项附加说明文字时才用 \`match: "contains"\`。失败才手工兜底。默认保留 \`verify: true\`。

\`\`\`
selectOption({
    trigger: { role: "combobox", name: "语言" },
    option: "简体中文",
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    verify: true
})
\`\`\`

### 输入文本

用 **input** 在 textbox 输入：从 snapshot 获取坐标，\`mode: "append"\`（默认）或 \`"replace"\`（从开头删 256 字符后输入，更长用 \`maxClearChars\`）。中文自动走剪贴板粘贴。快照无法校验输入框值，\`replace\` 非无上限清空断言。

\`\`\`
input({ x: 540, y: 1820, text: "新消息", mode: "replace", maxClearChars: 512 })
\`\`\`

### 系统文件选择器

**chooseFile**：必须先通过 GUI 点击打开系统 Picker。工具按路径末尾名称和按钮语义操作，Picker 不暴露目标时不盲点坐标。

文件选择器（com.huawei.hmos.filemanager）无障碍树要点：左侧含快速访问/存储位置/来源，右侧文件列表（listitem 有 ref），底部有文件格式过滤器和取消/打开按钮。用户主目录通过侧边栏「个人」进入（\`file://docs/storage/Users/currentUser/\`）。**chooseFile** 自动处理导航和选择。

**dropFixture**：通过 WebView 创建 File + DataTransfer，派发 dragenter/dragover/drop。优先用 **chooseFile**，只有产品支持拖放或 Picker 不可操作时才用 **dropFixture**。文件上限 20 MiB。上传后用 **waitFor** 验证缩略图/文件名/导入结果，不要把工具返回成功直接当业务成功。

\`\`\`
dropFixture({
    localPath: "/absolute/fixtures/gui-gap-icon.png",
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    x: 600, y: 720, snapshot: true
})
\`\`\`

### 指针手势

- **doubleClick**：原生双击，如双击打开、日期选择
- **drag**：起点到终点连续拖动，不能两次点击或 scroll 替代
- **longClick**：原生长按。**HDC 不支持原生右键**，长按是唯一右键模拟方案，部分 WebView/Electron 会将长按转 \`contextmenu\`

均支持 \`snapshot: true\`，\`native: true\` 表示已调用设备原生命令。

\`\`\`
drag({ fromX: 320, fromY: 540, toX: 620, toY: 540, speed: 600, snapshot: true })
\`\`\`

### 系统弹窗

**systemDialog** 通用系统弹窗交互工具，用于操作原生 \`<select>\` 选择器、Picker 等**不在无障碍树中**的系统级弹窗。

三种模式：**inspect**（仅检测弹窗） / **select**（按文本或索引选择选项） / **dismiss**（关闭弹窗）。

工作流程：点击触发元素 → 等待弹窗稳定 → \`snapshot_display\` 全屏截图 → 像素分析 → 点击选项。全链路自动完成。

\`\`\`
systemDialog({ action: "inspect" })
systemDialog({ action: "select", option: "深色" })
systemDialog({ action: "select", optionIndex: 1 })
systemDialog({ action: "select", option: "深色", triggerX: 2372, triggerY: 491 })
systemDialog({ action: "dismiss" })
\`\`\`

注意：系统弹窗不在无障碍树中，snapshot 看不到，本工具用 \`snapshot_display\` 全屏截图兜底。

### 系统权限确认

**handlePermission** 先获取新快照，识别权限提示文本和"允许/仅此一次/拒绝"按钮。不自动授权，必须显式传 \`action\`。\`"inspect"\` 不点击仅返回信息；未检测到安全对话框或操作不存在时拒绝点击。

\`\`\`
handlePermission({ action: "allowOnce", snapshot: true })
\`\`\`

### 滑动

**scroll** 滑动页面：\`direction\`（up/down/left/right）、可选 \`region\`（区域内 drag 手势，适用于侧边栏等独立滚动区）、\`distance\`（精确距离，仅对 region/scrollByContainer 有效）、\`scrollByContainer\`（按 role/name 自动定位容器，与 region 互斥）。不指定 region 时用全屏 dircFling（可能只影响当前焦点滚动容器）。

\`\`\`
scroll({ direction: "up", scrollByContainer: { role: "list", name: "任务" }, distance: 300, snapshot: true })
\`\`\`

### 滚动到指定元素

**scrollTo** 滚动直到目标元素可见。参数：\`targetRole\` + 可选 \`targetName\`/\`targetHint\`，默认向下查找，\`maxScrolls\` 默认 5，\`scrollDistance\` 默认 300，默认 \`snapshot: true\`。每次滚动后等 500ms，确保目标在可达范围内。

\`\`\`
scrollTo({ targetRole: "button", targetName: "停止生成", maxScrolls: 10 })
\`\`\`

### 导航

- **goBack**：返回键
- **goForward**：Alt+Right 前进（仅部分应用）

### 按键

**pressKey** 在当前焦点元素按键：支持 Enter/Tab/Escape/Backspace/Delete/方向键/Space/Home/pageUpDown/a-z/0-9/F1-F12/Paste/Copy/Cut/Refresh 等，可选 \`modifiers\`（如 \`["Ctrl"]\`）。**推荐输入后按 Enter 发送，比点击发送按钮可靠。**

\`\`\`
pressKey({ key: "Enter", snapshot: true })
pressKey({ key: "v", modifiers: ["Ctrl", "Shift"] })
\`\`\`

### OpenDesk 消息提交

通过设备界面发送：snapshot 定位 textbox → input 输入 → pressKey Enter → waitFor/snapshot 验证。HDC 命令成功不代表消息已被接受。专门测试发送按钮则用 \`clickRef({ position: "left-center" })\`。

### 等待

**waitFor** 条件模式优先，避免固定 sleep。条件满足/超时时均返回最后快照，超时默认附加 OCR 证据。

条件类型：**text**（出现/消失，exact/contains）、**element**（role/name/id/hint，visible/hidden/enabled/disabled）、**snapshotChange**（相对 snapshotId 变化）、**window**（出现/消失）。参数：\`timeout\` 默认 10s，\`interval\` 默认 500ms，\`stableFor\` 默认 300ms。

ref 不跨轮询稳定，等待元素用 role/name 定位，不要等字面量 "e3"。

\`\`\`
waitFor({
    condition: { type: "element", locator: { role: "button", name: "停止生成" }, state: "hidden" },
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    timeout: 120000, stableFor: 1000
})
\`\`\`

只有无法用界面状态表达时才用 \`waitFor({ duration: 1000, snapshot: true })\`。

### 截图与 OCR

**screenshot** 是 snapshot 的兜底，仅用于无障碍树无法暴露目标时（原生 select/XComponent/系统弹窗/视觉状态验证）。\`region\` 裁切区域，\`ocr\` 默认 true（需 tesseract）。返回 \`ocr\` 数组（text/x/y/width/height/confidence）和 \`regions\` 数组（y1/y2/avgBrightness/highlighted 高亮/选中行）。

\`\`\`
screenshot({ region: { x1: 1654, y1: 459, x2: 2079, y2: 601 } })
\`\`\`

### 视觉断言

**visualAssert** 三种模式：

- **diff**：像素级截图对比，\`baseline\` + \`threshold\`（默认 0.1）+ \`outputDiff\`（输出红色差异图），返回 \`diffPercent\`/\`passed\`
- **color**：坐标 RGB 采样，每点含 \`expected\` 颜色和 \`tolerance\`，返回 hex 和匹配状态
- **theme**：3x3 网格亮度检测浅色/深色主题，可选 \`expectedTheme\`

\`\`\`
visualAssert({ mode: "color", samples: [{ x: 600, y: 1800, expected: "#1976d2", tolerance: 15 }] })
\`\`\`

### 悬停

**hover** 模拟鼠标悬停，三层降级：HDC mouseMove → WebView JS 注入 → 0 像素 drag。\`duration\` 默认 800ms，返回 \`method\` 标识实际路径。若 \`method\` 为 \`zero-pixel-drag\` 则前两种方法不可用。

### 语义元素查询

**findElement** 从最新快照按条件查询元素，无需 LLM 解析文本：\`role\`/\`name\`（模糊匹配）/\`hint\`/\`state\`（disabled/enabled/checked/selected）/\`text\`（纯文本子节点）/ \`ref\`，AND 关系，默认 limit 20。返回 ref 可直接用于 clickRef。

\`\`\`
findElement({ role: "button", name: "发送" })
// → 直接用: clickRef({ snapshotId: "s3", ref: "e5" })
\`\`\`

**getElementState** 获取指定 ref 的完整状态（\`found\`/\`role\`/\`name\`/\`bounds\`/\`center\`/\`checked\`/\`disabled\`/\`selected\`）。

## 应用管理

- **listApps**：列出可打开的应用（bundleName + 显示名），按设备 ID 缓存
- **openApp**：按 bundleName 打开（部分系统应用可能无法打开）
- **appLifecycle**：强制停止/冷重启/清除缓存/清除数据，构造确定测试前置状态
- **listWindows**：当前窗口列表

### 应用生命周期

**appLifecycle** 操作：\`stop\`（停止）、\`restart\`（停止后重开）、\`clearCache\`（停止+清缓存，\`relaunch\` 默认 true）、\`clearData\`（停止+清全部本地数据，**不可恢复**，须 \`confirmDestructive: true\`，执行前确认是隔离测试环境，不要对生产数据执行）。\`settleTime\` 默认 1s，停止时不获取快照。

\`\`\`
appLifecycle({
    bundleName: "com.develop.opensource.ohpcd.opendesk",
    action: "clearData", confirmDestructive: true,
    settleTime: 2000, snapshot: true
})
\`\`\`

## 注意事项

1. 每次界面变化后重新 **snapshot**（或开 \`snapshot: true\` 自动获取）
2. **发送按钮**：用 \`clickRef({ position: "left-center" })\`，避免命中相邻选项按钮
3. OpenDesk 消息：snapshot 定位 textbox → input → pressKey Enter → 快照验证
4. **禁止 hdc shell uinput**：用 **pressKey** 工具，它能正确路由到目标应用
5. \`clearData\` 需确认 bundleName 和测试环境后才执行
`;

export function loadUseHarmonySkill(): Skill {
    const skill = Skill.parseMd(USE_HARMONY_SKILL);
    skill.toolsets = [createUseHarmonyToolset()];
    return skill;
}
