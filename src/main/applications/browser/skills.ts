export const BROWSER_SKILL = `
---
name: useBrowser
description: 提供嵌入式网页浏览器功能：访问网页、页面导航、元素交互、内容提取、多标签页管理等自动化控制能力
---

# 嵌入式浏览器

本技能提供内置的网页浏览器功能，可以通过 OpenDesk 的浏览器标签直接访问网页，并支持通过工具进行自动化操作。
浏览器支持多标签页，所有标签页共享同一个会话（cookies / localStorage），跨任务也保持登录状态。

## 基本导航

- **browserNavigate** — 在浏览器中打开指定 URL
- **browserGoBack** — 后退
- **browserGoForward** — 前进
- **browserRefresh** — 刷新当前页面

## 页面状态与交互

### 获取页面状态

使用 **browserGetState** 获取当前页面的完整状态，包括 URL、标题、滚动位置，以及所有可交互元素的索引列表。
返回的每个元素都有一个 \`index\`（索引），后续的 click / input 操作通过这个索引来定位元素。

### 点击元素

使用 **browserClick** 并传入 \`index\`（从 browserGetState 获取）来点击页面上的按钮、链接等元素。
点击前会自动滚动到元素位置。

### 输入文本

使用 **browserInput** 向指定索引的输入框填写文本。支持先清空再输入（\`clearFirst: true\`）。

### 滚动页面

使用 **browserScroll** 向上或向下滚动页面。可指定滚动方向和距离（像素）。

## 内容提取

使用 **browserExtractContent** 提取当前页面的文本内容，包括标题、正文和链接列表。
适合用于阅读网页内容、总结文章等场景。

## 标签页管理

浏览器支持多个标签页，可以并行打开多个网页：

- **browserListTabs** — 列出所有标签页（ID、标题、URL、是否活跃）
- **browserSwitchTab** — 切换到指定标签页
- **browserCloseTab** — 关闭指定标签页

## 执行脚本

使用 **browserExecuteScript** 可以在当前页面中执行任意 JavaScript 代码，用于高级页面交互或数据提取。

## 典型工作流

1. \`browserNavigate\` 打开目标网页
2. \`browserGetState\` 获取页面状态和可交互元素
3. \`browserClick\` / \`browserInput\` 与页面元素交互
4. \`browserExtractContent\` 提取需要的信息
5. 如需操作多个页面，使用标签页管理工具

## 注意事项

- 每次 click / input 操作前应先调用 browserGetState 刷新元素索引
- 调用任何浏览器工具时，右侧浏览器面板会自动打开并切换到浏览器标签
- 所有任务的浏览器共享登录会话，无需重复登录
`;
