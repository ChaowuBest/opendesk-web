export const BROWSER_SKILL = `
---
name: browser
description: 提供嵌入式网页浏览器功能：访问网页、页面导航、执行JavaScript、获取CDP端口进行自动化控制
---

# 嵌入式浏览器

本技能提供内置的网页浏览器功能，可以通过 OpenDesk 的浏览器标签直接访问网页，也支持通过工具进行自动化操作。

## 打开网页

使用 **browserNavigate** 工具可以在浏览器中打开指定的 URL。

## 执行脚本

使用 **browserExecuteScript** 工具可以在当前页面中执行 JavaScript 代码，用于页面交互或数据提取。

## Playwright 自动化

使用 **browserGetCDPPort** 可以获取 Chrome DevTools Protocol (CDP) 的端口，然后使用 Playwright 或其他自动化工具连接到浏览器进行更复杂的自动化操作。

## 获取状态

使用 **browserGetState** 可以查看当前浏览器的状态。

## 注意事项

- 浏览器会在 OpenDesk 右侧栏的 "浏览器" 标签中显示
- 支持全屏模式，点击地址栏右侧的全屏按钮即可
- CDP 端口默认为 9222，可用于 Playwright 连接
`;
