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

## 导航

- **navigate** — 打开指定 URL。\`newTab: true\` 在新标签页中打开。内置 20 秒超时机制，网址不可用时会返回错误信息而非无限等待。
- **goBack** — 后退到上一个页面
- **goForward** — 前进到下一个页面
- **reload** — 刷新当前页面

## 页面快照

使用 **snapshot** 获取当前页面的完整快照，返回：
- URL、标题、viewport 尺寸、滚动位置
- 所有可交互元素列表，每个元素包含：
  - \`ref\` — 元素引用（如 e0、e5），用于后续操作中的 target 参数
  - \`tag\` — HTML 标签名
  - \`role\` / \`type\` — ARIA 角色或输入类型
  - \`text\` — 元素文本内容
  - \`ariaLabel\` / \`placeholder\` — 提示信息
  - \`value\` — 当前值（输入框）
  - \`href\` — 链接地址
  - \`rect\` — 元素在视口中的位置 (x, y, w, h)
  - \`disabled\` / \`readonly\` — 状态标记

## 元素交互

### 点击

使用 **click** 点击元素：
- \`target\`：使用 ref（如 \`e3\`）或 CSS 选择器
- 支持 \`button\`（left/right/middle）、\`doubleClick\`、\`modifiers\`（Alt/Control/Meta/Shift）
- 通过 CDP 发送真实鼠标事件（mouseMoved → mousePressed → mouseReleased），兼容所有框架

### 输入文本

使用 **type** 在输入框中输入文本：
- \`target\`：ref 或 CSS 选择器
- \`clearFirst\`：是否先清空已有内容（默认 true）
- \`submit\`：输入后是否按 Enter（默认 false）。提交后会自动等待可能的页面导航完成。
- \`slowly\`：是否逐字符输入（默认 false）。设为 true 时会触发页面的逐键事件处理器（如搜索建议）。
- 默认模式（\`slowly: false\`）会一次性填入整段文本，速度快且可靠（类似 Playwright 的 fill）

### 悬停

使用 **hover** 将鼠标移到元素上，触发 hover 效果、tooltip 或下拉菜单。

### 按键

使用 **pressKey** 按下指定按键：
- 支持 Enter、Tab、Escape、ArrowDown/Up/Left/Right、Backspace 等
- 支持修饰键组合（如 \`modifiers: ["Control"]\`）

### 选择下拉选项

使用 **selectOption** 在 \`<select>\` 元素中选择指定选项。

### 滚动

使用 **scroll** 上下滚动页面，返回滚动位置、是否到顶/底等信息。

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
1. \`navigate\` 打开搜索引擎
2. \`snapshot\` 获取页面快照
3. \`type\` 在搜索框（如 e3）中输入关键词，\`submit: true\`
4. \`waitFor\` 等待搜索结果出现
5. \`snapshot\` 获取结果页面
6. \`click\` 点击结果链接
7. \`snapshot\` 或 \`evaluate\` 提取目标页面内容

### 表单填写
1. \`navigate\` 打开目标页面
2. \`snapshot\` 获取表单字段 ref
3. 依次 \`type\` 填写各个字段
4. \`selectOption\` 选择下拉选项
5. \`click\` 点击提交按钮

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
`;
