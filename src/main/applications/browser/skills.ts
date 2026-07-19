/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export const MANAGE_BROWSER_SKILL = `
---
name: manage-browser
description: 浏览器管理功能：删除浏览历史记录等维护操作
---

# 浏览器管理

本技能提供对 OpenDesk 浏览器的管理与维护功能。

## 删除历史记录

使用 **dropHistory** 工具可以按条件批量删除浏览历史记录。

支持的筛选条件（可同时指定）：
- **按时间范围**：指定 \`startTime\` 和/或 \`endTime\`（Unix 毫秒时间戳），删除该时间段内的记录
- **按域名**：指定 \`domains\` 列表（如 \`["google.com", "baidu.com"]\`），删除匹配域名的记录

当同时指定多个筛选条件时，只有同时满足所有条件的记录才会被删除（AND 逻辑）。

### 重要安全规则

**执行删除操作前，必须先使用 askUser 工具向用户确认！** 删除操作不可撤销，需要明确告知用户将要删除的范围并获得确认。

示例确认流程：
\`\`\`
askUser({
  questions: [{
    question: "即将删除以下范围的浏览历史记录，此操作不可撤销。",
    header: "确认删除历史记录",
    options: [
      { label: "确认删除", description: "删除符合条件的历史记录" },
      { label: "取消", description: "不执行删除" }
    ]
  }]
})
\`\`\`

只有用户选择"确认删除"后才能调用 dropHistory 执行实际删除。
`;

export const BROWSER_SKILL = `
---
name: use-browser
description: 提供嵌入式网页浏览器控制功能：访问网页、页面导航、元素交互、内容提取、多标签页管理等自动化控制能力
---

# 嵌入式网页浏览器

本技能提供内置的网页浏览器功能，可以通过 OpenDesk 的任务级浏览器标签直接访问网页，并支持通过工具进行自动化操作。
每个任务拥有自己独立的浏览器实例。浏览器支持多标签页，所有标签页共享同一个会话（cookies / localStorage），跨任务也保持登录状态。

底层使用 Chrome DevTools Protocol (CDP) 进行真实用户输入模拟（鼠标点击、键盘输入等），兼容所有前端框架（React / Vue / Angular 等）。

## 核心工作流

每次与页面交互前，**必须先调用 snapshot** 获取页面快照和元素 ref：

1. \`snapshot\` → 得到可交互元素列表，每个元素有 ref（如 e0、e3、e12）
2. 使用 ref 调用 \`click\` / \`type\` / \`hover\` 等操作工具
3. 操作后页面变化 → 再次调用 \`snapshot\` 刷新 ref

## 操作后自动快照

所有控制类工具（navigate、click、type、uploadFile、hover、pressKey、selectOption、scrollTo、goBack、goForward、reload、evaluate、tabs、waitFor）都支持可选的 \`snapshot\` 参数：

- \`snapshot: true\` — 操作成功后自动等待 0.5 秒获取页面快照，结果以 \`snapshot\` 字段返回
- \`snapshot: false\`（默认）— 不自动快照，与原有行为一致

使用 \`snapshot: true\` 可以省略操作后显式调用 \`snapshot\` 的步骤，减少单次交互的往返次数。快照结果格式与 \`snapshot\` 工具一致。

**推荐用法**：在预期操作会触发显著页面变化时（如点击链接导航、提交表单后），设置 \`snapshot: true\` 可以直接获得变化后的页面状态。

示例：
\`\`\`
// 点击按钮后自动获取快照
click({ target: "e8", snapshot: true })

// 输入并提交搜索后自动获取快照
type({ target: "e3", text: "关键词", submit: true, snapshot: true })
\`\`\`

## 导航

- **navigate** — 打开指定 URL。\`newTab: true\` 在新标签页中打开。内置 20 秒超时机制，网址不可用时会返回错误信息而非无限等待。
- **goBack** — 后退到上一个页面
- **goForward** — 前进到下一个页面
- **reload** — 刷新当前页面

## 页面快照（Accessibility Snapshot）

使用 **snapshot** 获取当前页面的无障碍树快照，输出格式为标准 ARIA YAML（与 Playwright MCP 的 browser_snapshot 对齐）。

返回内容包括：
- 页面 URL、标题、viewport 尺寸、滚动位置
- YAML 格式的完整 ARIA 树，展示页面的层级结构

YAML 中每个节点的格式为：
\`\`\`
- role "accessible name" [state] [ref=eN] [cursor=pointer]
\`\`\`

示例输出：
\`\`\`yaml
- navigation [ref=e0]:
  - list [ref=e1]:
    - listitem [ref=e2]:
      - link "首页" [ref=e3] [cursor=pointer]:
        - /url: /home
    - listitem [ref=e4]:
      - link "关于" [ref=e5] [cursor=pointer]:
        - /url: /about
- heading "欢迎" [level=1] [ref=e6]
- textbox "搜索" [ref=e7]
- button "提交" [ref=e8]
\`\`\`

关键概念：
- **role** — 元素的 ARIA 角色（如 button、link、textbox、heading、navigation 等）
- **"name"** — 元素的无障碍名称（来自 aria-label、文本内容、alt 等）
- **[ref=eN]** — 可交互元素的引用标识，用于后续 click/type 操作的 target 参数
- **[cursor=pointer]** — 鼠标指针为手型，表示该元素可点击
- **[checked]**、**[disabled]**、**[expanded]**、**[level=N]**、**[selected]** — ARIA 状态
- **- /url: ...**、**- /placeholder: ...** — 元素属性（链接地址、占位符等）
- **- text: ...** — 纯文本节点
- 树的层级用缩进表示，子节点缩进 2 个空格

## 元素交互

### 点击

使用 **click** 点击元素：
- \`target\`：使用 ref（如 \`e3\`）或 CSS 选择器
- 支持 \`button\`（left/right/middle）、\`doubleClick\`、\`modifiers\`（Alt/Control/Meta/Shift）
- 通过 CDP 发送真实鼠标事件（mouseMoved → mousePressed → mouseReleased），兼容所有框架

### 输入文本

使用 **type** 在输入框中输入文本：
- \`target\`：ref 或 CSS 选择器
- \`clearFirst\`：
  - \`true\`（默认）：清空已有内容后输入，替换模式
  - \`false\`：将光标移到末尾后输入，追加模式
- \`submit\`：输入后是否按 Enter（默认 false）。提交后会自动等待可能的页面导航完成。
- \`slowly\`：是否逐字符输入（默认 false）。设为 true 时会触发页面的逐键事件处理器（如搜索建议）。
- 默认模式（\`slowly: false\`）会一次性填入整段文本，速度快且可靠（类似 Playwright 的 fill）

### 上传文件

使用 **uploadFile** 向网页上传本地文件：
- \`target\`：上传控件 ref 或 CSS 选择器。可以是 \`input[type=file]\` 本身，也可以是它的 label 或触发隐藏 file input 的上传按钮
- \`filePath\`：上传单个本地文件
- \`filePaths\`：上传多个本地文件，目标控件必须支持 multiple

遇到“上传图片 / 选择文件 / 添加附件”等控件时，**禁止使用 click**，因为 click 会打开系统文件选择窗口，浏览器自动化无法控制。应先 \`snapshot\` 找到上传控件 ref，然后直接调用 \`uploadFile\`。

上传控件的强制规则：
- 无论 \`uploadFile\` 成功、失败、超时或返回状态不确定，都不要改用 \`click\` 点击这类上传按钮或文件选择控件
- 如果页面已经出现上传后的缩略图、文件名、预览卡片或进度变化，应视为上传可能已经生效，先调用 \`snapshot\` / \`waitFor\` 检查页面状态
- 如果确实需要重试，只能再次调用 \`uploadFile\`，并使用新的 snapshot ref；不要点击会打开系统文件选择窗口的按钮
- CSS 选择器也遵守同一规则：不要用 \`click\` 点击 \`input[type=file]\`、其 label、或任何“选择文件/上传图片/添加附件”按钮

示例：
\`\`\`
uploadFile({ target: "e8", filePath: "/home/user/image.png", snapshot: true })
uploadFile({ target: "e12", filePaths: ["./a.png", "./b.png"], snapshot: true })
\`\`\`

### 悬停

使用 **hover** 将鼠标移到元素上，触发 hover 效果、tooltip 或下拉菜单。

### 按键

使用 **pressKey** 按下指定按键：
- 支持 Enter、Tab、Escape、ArrowDown/Up/Left/Right、Backspace 等
- 支持修饰键组合（如 \`modifiers: ["Control"]\`）

### 选择下拉选项

使用 **selectOption** 在 \`<select>\` 元素中选择指定选项。

### 滚动

使用 **scrollTo** 上下滚动页面，返回滚动位置、是否到顶/底等信息。

## 标签页管理

使用 **tabs** 统一管理：
- \`action: "list"\` — 列出所有标签页
- \`action: "new"\` — 新建标签页（可指定 url）
- \`action: "switch"\` — 切换到指定标签页（需提供 tabId）
- \`action: "close"\` — 关闭标签页（需提供 tabId）

## 执行脚本

使用 **evaluate** 在当前页面执行任意 JavaScript 表达式并返回结果。
适用于其他工具无法满足需求时的高级操作或数据提取。

## 等待条件

使用 **waitFor** 等待特定条件满足：
- \`text\`：等待页面出现指定文本
- \`textGone\`：等待页面中指定文本消失
- \`timeout\`：超时时间（秒），默认 10

## 典型工作流示例

### 搜索并提取信息
1. \`navigate\` 打开搜索引擎，\`snapshot: true\` 获取首页快照
2. 从快照中找到搜索框 ref
3. \`type\` 在搜索框中输入关键词，\`submit: true, snapshot: true\` 提交并获取结果页快照
4. \`waitFor\` 等待搜索结果出现
5. 从快照中的搜索结果找到目标链接 ref
6. \`click\` 点击结果链接，\`snapshot: true\` 获取目标页面快照
7. \`evaluate\` 提取目标页面内容

### 表单填写
1. \`navigate\` 打开目标页面
2. \`snapshot\` 获取表单字段 ref
3. 依次 \`type\` 填写各个字段
4. 如需上传图片或附件，用 \`uploadFile\` 设置文件
5. \`selectOption\` 选择下拉选项
6. \`click\` 点击提交按钮

## 遇到需要登录的页面

当浏览器打开的页面需要登录才能继续操作时（如出现登录弹窗、跳转到登录页、提示"请先登录"等），**不要**自行绕过或改用其他方案。应当：

1. 调用 \`askUser\` 工具提示用户手动完成登录，提供以下选项：
   - **我已经完成登录** — 用户手动在浏览器中完成登录后选择此项
   - **我不想登录，尝试其他方案** — 用户不愿登录时选择此项

2. 如果用户选择"已完成登录"，调用 \`snapshot\` 刷新页面状态后继续操作
3. 如果用户选择"尝试其他方案"，再考虑替代途径（如搜索引擎等）

示例：
\`\`\`
askUser({
  questions: [{
    question: "当前页面需要登录才能继续操作，请在浏览器中手动完成登录后告诉我。",
    header: "需要登录",
    options: [
      { label: "我已完成登录", description: "我已经在浏览器中登录成功，请继续操作" },
      { label: "不想登录", description: "跳过登录，尝试其他方式完成任务" }
    ]
  }]
})
\`\`\`

> **重要**：不要自动跳过登录页面。浏览器的登录会话是跨任务共享的，一次登录可以长期受益。

## 注意事项

- 每次操作前**必须**先调用 \`snapshot\` 获取最新的元素 ref（页面变化后 ref 会失效）
- ref 格式为 e0、e1、e2…，是通过 snapshot 生成的临时标识
- 也支持使用 CSS 选择器作为 target，但 ref 更可靠
- 所有任务的浏览器共享登录会话，无需重复登录
- 工具内部已包含自动重试和等待机制
- 点击操作（click）会自动等待可能的页面导航完成后才返回，无需额外 waitFor
- 操作结果中包含当前页面状态（URL、标题等），可据此判断操作是否触发了导航
- 工具支持 \`snapshot: true\` 选项，可在操作后自动获取快照，减少显式 snapshot 调用
`;
