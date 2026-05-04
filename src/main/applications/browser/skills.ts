export const BROWSER_SKILL = `
---
name: use-browser
description: 提供嵌入式网页浏览器功能：访问网页、页面导航、元素交互、内容提取、多标签页管理等自动化控制能力
---

# 嵌入式浏览器

本技能提供内置的网页浏览器功能，可以通过 OpenDesk 的浏览器标签直接访问网页，并支持通过工具进行自动化操作。
浏览器支持多标签页，所有标签页共享同一个会话（cookies / localStorage），跨任务也保持登录状态。

## 基本导航

- **browserNavigate** — 在浏览器中打开指定 URL。支持 \`newTab: true\` 在新标签页中打开。
- **browserGoBack** — 后退到上一个页面
- **browserGoForward** — 前进到下一个页面
- **browserRefresh** — 刷新当前页面

## 页面状态与交互

### 获取页面状态

使用 **browserGetState** 获取当前页面的完整状态，返回内容包括：
- URL 和标题
- viewport 尺寸（宽×高像素）
- 页面总尺寸和当前滚动位置
- 所有可交互元素列表，每个元素包含：
  - \`index\` — 元素索引（用于后续 click / input 操作）
  - \`tag\` — HTML 标签名
  - \`type\` / \`role\` — 输入类型或 ARIA 角色
  - \`text\` — 元素文本内容
  - \`placeholder\` / \`ariaLabel\` — 提示信息
  - \`value\` — 当前值（输入框）
  - \`href\` — 链接地址
  - \`rect\` — 元素在视口中的位置和尺寸 (x, y, w, h)

### 点击元素

使用 **browserClick** 与页面元素交互，支持两种定位方式：
1. **按索引点击**：传入 \`index\`（从 browserGetState 获取），会先滚动到元素位置再点击
2. **按坐标点击**：传入 \`x\` 和 \`y\` 坐标，直接点击视口中指定位置

点击使用完整的鼠标事件模拟（pointerdown → mousedown → pointerup → mouseup → click），兼容各种前端框架。

### 输入文本

使用 **browserInput** 向指定索引的输入框填写文本：
- 支持先清空再输入（\`clearFirst: true\`，默认）
- 使用原生 value setter + input/change 事件模拟，兼容 React/Vue 等框架
- 支持 contentEditable 元素
- 可通过 \`pressEnter: true\` 在输入后自动按 Enter 键（用于搜索框提交等）

### 滚动页面

使用 **browserScroll** 向上或向下滚动页面。返回值包含：
- 当前滚动位置
- 是否已到达顶部/底部
- 滚动百分比

## 内容提取

- **browserExtractContent** — 提取页面的结构化文本内容（标题、正文和链接列表）。
  可通过 \`selector\` 参数限定只提取特定 CSS 选择器匹配的区域内容。

- **browserGetHtml** — 获取页面的原始 HTML 或指定 CSS 选择器匹配元素的 HTML。
  适合需要分析 DOM 结构的场景。

## 标签页管理

浏览器支持多个标签页，可以并行打开多个网页：

- **browserListTabs** — 列出所有标签页（ID、标题、URL、是否活跃）
- **browserSwitchTab** — 切换到指定标签页
- **browserCloseTab** — 关闭指定标签页
- \`browserNavigate\` 配合 \`newTab: true\` — 在新标签页中打开链接

## 执行脚本

使用 **browserExecuteScript** 可以在当前页面中执行任意 JavaScript 代码。
适用于其他工具无法满足需求时的高级页面交互或数据提取。

## 典型工作流

### 搜索并提取信息
1. \`browserNavigate\` 打开搜索引擎
2. \`browserGetState\` 获取页面状态和搜索框索引
3. \`browserInput\` 在搜索框中输入关键词，设置 \`pressEnter: true\`
4. \`browserGetState\` 获取搜索结果页面状态
5. \`browserClick\` 点击感兴趣的结果链接
6. \`browserExtractContent\` 提取目标页面的内容

### 表单填写
1. \`browserNavigate\` 打开目标页面
2. \`browserGetState\` 获取所有表单字段的索引
3. 依次 \`browserInput\` 填写各个字段
4. \`browserClick\` 点击提交按钮

### 多页面并行操作
1. \`browserNavigate\` 配合 \`newTab: true\` 打开多个页面
2. \`browserListTabs\` 查看所有标签页
3. \`browserSwitchTab\` 在标签页之间切换
4. 分别在各标签页中提取或操作

## 注意事项

- 每次 click / input 操作前**必须**先调用 browserGetState 刷新元素索引（因为页面内容变化后索引会失效）
- 调用任何浏览器工具时，右侧浏览器面板会自动打开并切换到浏览器标签
- 所有任务的浏览器共享登录会话，无需重复登录
- 对于需要等待的操作（如导航后页面加载），工具内部已自动等待
- 使用坐标点击前，可参考 browserGetState 返回的元素 rect 确定位置
`;
