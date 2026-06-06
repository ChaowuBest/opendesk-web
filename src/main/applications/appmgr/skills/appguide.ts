/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export const APPMGR_APPGUIDE_SKILL = `
---
name: appmgr-appguide
description: OpenDesk 应用开发指南，涵盖应用概念、AppSDK 能力、UI 设计规范（标题栏避让与深浅色主题适配）
---

# OpenDesk 应用开发指南

本指南面向 OpenDesk 三方动态加载应用（后装应用），介绍应用的基本概念、可用能力和 UI 设计必须遵守的规范。

---

## 一、应用的概念与主要组件

### 1.1 什么是 OpenDesk 应用

OpenDesk 应用是一个独立的功能模块，以 zip 包形式分发和安装。每个应用由一个 JSON 清单文件（\`opendesk-app.json\`）描述，包含代码、资源和可选的 Skills 定义。

### 1.2 应用清单 (opendesk-app.json)

清单文件位于应用 zip 包的根目录，结构如下：

\`\`\`json
{
    "schemaVersion": 1,
    "bundleName": "com.example.myapp",
    "displayName": "我的应用",
    "versionName": "1.0.0",
    "entry": "index.html",
    "icon": "icon.png",
    "description": "应用描述",
    "skills": ["skills/my-skill.md"],
    "permissions": []
}
\`\`\`

| 字段 | 必填 | 说明 |
|------|------|------|
| \`schemaVersion\` | 是 | 固定为 \`1\` |
| \`bundleName\` | 是 | 唯一包名，只能包含小写字母、数字、点号和连字符，以小写字母开头 |
| \`displayName\` | 是 | 显示名称 |
| \`versionName\` | 是 | 版本号字符串 |
| \`entry\` | 是 | 应用入口 HTML 文件路径（相对于 zip 根目录） |
| \`icon\` | 否 | 应用图标路径 |
| \`description\` | 否 | 应用描述 |
| \`skills\` | 否 | Skill 定义文件路径列表（Markdown 格式） |
| \`permissions\` | 否 | 权限声明列表 |

### 1.3 应用运行环境

三方应用在独立的 iframe 中运行（通过 \`application.html\` 承载），与 OpenDesk 主界面隔离。应用可以：

- 通过 \`window.applicationAPI\` 调用主进程方法
- 通过 \`window.opendeskAppAPI\` 获取主题等渲染端信息
- 通过 postMessage 接收主题变更等系统事件
- 注册为 Web Component（使用 \`customElements.define\` 或 SDK 提供的 \`defineOpenDeskApp\`）

---

## 二、AppSDK 能力

三方应用可以使用 \`@bitclub.ai/opendesk-appsdk\`（已内置在运行环境中）提供的能力。

### 2.1 渲染进程 API

#### window.applicationAPI

应用在渲染进程中通过 \`window.applicationAPI\` 与主进程通信：

\`\`\`js
// 调用主进程方法
const result = await window.applicationAPI.callMainWorld('methodName', arg1, arg2);

// 调用渲染进程侧方法
const result = await window.applicationAPI.call('methodName', arg1, arg2);

// 订阅事件
window.applicationAPI.subscribe('eventName', (data) => {
    console.log('收到事件:', data);
});

// 取消订阅
window.applicationAPI.unsubscribe('eventName', callback);
\`\`\`

#### window.opendeskAppAPI

获取主题等渲染端信息：

\`\`\`js
// 获取当前主题
const theme = await window.opendeskAppAPI.getTheme();
// 返回 'dark' | 'light'

// 监听主题变更
const unsubscribe = window.opendeskAppAPI.onThemeChanged((theme) => {
    console.log('主题变更为:', theme);
    // 更新 UI
});
\`\`\`

### 2.2 定义 Web Component

使用 SDK 提供的 \`defineOpenDeskApp\` 注册自定义元素（自动去重）：

\`\`\`js
import { defineOpenDeskApp } from '@bitclub.ai/opendesk-appsdk/renderer';

class MyAppWidget extends HTMLElement {
    connectedCallback() {
        this.innerHTML = '<div>Hello OpenDesk</div>';
    }
}

defineOpenDeskApp('myapp-entry-widget', MyAppWidget);
\`\`\`

### 2.3 文件系统访问

\`\`\`js
// 选择文件
const files = await window.fsAPI.selectFile();
// 读取文件
const content = await window.fsAPI.readFile(filePath);
\`\`\`

### 2.4 注意事项

- 三方应用运行在沙箱 iframe 中，**不能直接访问 Node.js API 或 Electron 主进程**
- 所有系统能力必须通过上述 API 调用
- 应用打包时不需要包含 \`@bitclub.ai/opendesk-appsdk\`，运行环境已内置

---

## 三、UI 设计规范

### 3.1 标题栏拖拽区域与窗口控制按钮避让

OpenDesk 使用 Electron 的无边框窗口，窗口顶部有一个**可拖拽区域**用于移动窗口。同时，右上角有系统窗口控制按钮（最小化、最大化、关闭）。

**应用页面顶部必须留出足够的拖拽空白区域，且右上角必须避让窗口控制按钮组。**

#### 标准实现范例

以下是最小化的标准布局模板（参考应用工坊和技能中心应用的实现）：

\`\`\`html
<div class="header-area">
    <div class="header-title">应用标题</div>
    <div class="header-toolbar">
        <!-- 左侧内容区，自动占满 -->
        <div class="toolbar-left">
            <!-- 标签页、搜索框等 -->
        </div>
        <!-- 右侧操作按钮，自动靠右 -->
        <div class="header-actions">
            <button>操作</button>
        </div>
    </div>
</div>
<div class="content">
    <!-- 应用主体内容 -->
</div>
\`\`\`

\`\`\`css
/* 头部区域：顶部留白 + 可拖拽 */
.header-area {
    flex-shrink: 0;
    padding: 20px 24px 16px;     /* 顶部 20px 留白给拖拽区域 */
    -webkit-app-region: drag;     /* 整个 header 可拖拽 */
    border-bottom: 0.5px solid rgba(0, 0, 0, 0.06);
}

/* 标题文字：不可拖拽（否则无法选中） */
.header-title {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 14px;
    -webkit-app-region: no-drag;
}

/* 工具栏行：不可拖拽（包含按钮等交互元素） */
.header-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    -webkit-app-region: no-drag;
}

.toolbar-left {
    flex: 1;
    min-width: 0;
}

/* 右侧操作按钮组：自然靠右，与窗口控制按钮保持安全距离 */
.header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    /* 右侧已有 24px padding，加上按钮组自身的间距，足够避让窗口控制按钮 */
}
\`\`\`

#### 关键要点

| 要点 | 说明 |
|------|------|
| **拖拽区域** | \`header-area\` 设置 \`-webkit-app-region: drag\`，顶部 \`padding-top: 20px\` 保证拖拽手感 |
| **不可拖拽元素** | 标题、按钮、输入框等交互元素必须设置 \`-webkit-app-region: no-drag\` |
| **右上角避让** | 窗口控制按钮（最小化/最大化/关闭）位于右上角约 32px 高度区域。\`header-actions\` 通过 \`padding-right: 24px\` + \`gap\` 自然避让，无需特殊处理 |
| **整体布局** | 应用应为 flex 纵向布局（\`flex-direction: column; height: 100%; overflow: hidden\`），header 固定高度，content 区域 \`flex: 1\` |

### 3.2 深色/浅色主题适配（必须实现）

**⚠️ 主题适配是三方应用的强制性要求，不可省略。**

OpenDesk 支持浅色（light）和深色（dark）两种主题，用户可随时切换。三方应用**必须**响应主题变更并正确渲染。

#### 主题传递机制

1. **初始加载**：应用 iframe 加载时，系统通过 postMessage 发送当前主题
2. **主题切换**：用户切换主题时，系统通过 postMessage 发送 \`THEME_SETTINGS\` 消息
3. **CSS 变量**：OpenDesk 在 \`html[data-theme]\` 上定义了一套语义化 CSS 变量

#### 方式一：使用 CSS 变量（推荐）

直接使用 OpenDesk 提供的 CSS 变量，由宿主环境自动切换：

\`\`\`css
/* 使用 OpenDesk 语义化 CSS 变量 */
.my-page {
    background: var(--od-bg, #f5f5f5);
    color: var(--od-text, #1f2937);
}

.my-card {
    background: var(--od-bg-elevated, #ffffff);
    border: 1px solid var(--od-border, rgba(0, 0, 0, 0.08));
    border-radius: 14px;
    padding: 16px;
}

.my-card:hover {
    background: var(--od-bg-muted, #fafafa);
}

.my-text-secondary {
    color: var(--od-text-muted, #6b7280);
}

.my-input {
    background: var(--od-bg-subtle, #f3f4f6);
    border: 1px solid var(--od-border-strong, rgba(0, 0, 0, 0.14));
    color: var(--od-text, #1f2937);
}

.my-input::placeholder {
    color: var(--od-placeholder, #9ca3af);
}

.my-input:focus {
    border-color: var(--od-accent, #3b82f6);
}
\`\`\`

可用的 CSS 变量及默认值：

| 变量 | 浅色默认值 | 深色默认值 | 用途 |
|------|-----------|-----------|------|
| \`--od-bg\` | \`#f5f5f5\` | \`#1e1e1e\` | 页面背景 |
| \`--od-bg-elevated\` | \`#ffffff\` | \`#252526\` | 卡片/弹窗背景 |
| \`--od-bg-muted\` | \`#fafafa\` | \`#2d2d30\` | 次要背景（hover 等） |
| \`--od-bg-subtle\` | \`#f3f4f6\` | \`#333333\` | 输入框/控件背景 |
| \`--od-text\` | \`#1f2937\` | \`#e4e4e4\` | 正文颜色 |
| \`--od-text-muted\` | \`#6b7280\` | \`#ababab\` | 次要文字 |
| \`--od-text-disabled\` | \`#9ca3af\` | \`#787878\` | 禁用文字 |
| \`--od-border\` | \`rgba(0,0,0,0.08)\` | \`rgba(255,255,255,0.12)\` | 边框 |
| \`--od-border-strong\` | \`rgba(0,0,0,0.14)\` | \`rgba(255,255,255,0.2)\` | 强调边框 |
| \`--od-accent\` | \`#3b82f6\` | \`#60a5fa\` | 主题色 |
| \`--od-placeholder\` | \`#9ca3af\` | \`#9a9a9a\` | 占位符颜色 |

> 注：CSS 变量由宿主注入到 \`html[data-theme]\` 上，应用 iframe 内 \`document.documentElement.dataset.theme\` 会被自动同步。始终提供 fallback 值（如上例中的第二个参数）以确保兼容性。

#### 方式二：监听主题变更事件

如果使用 JS 驱动 UI，可以监听主题变更：

\`\`\`js
// 方法 A：通过 opendeskAppAPI
const theme = await window.opendeskAppAPI.getTheme();
applyTheme(theme);

window.opendeskAppAPI.onThemeChanged((newTheme) => {
    applyTheme(newTheme);
});

// 方法 B：通过 postMessage
window.addEventListener('message', (event) => {
    if (event.data?.type === 'THEME_SETTINGS' && event.data.theme) {
        applyTheme(event.data.theme);
    }
});

// 方法 C：通过 CustomEvent
document.addEventListener('opendesk-theme-changed', (event) => {
    applyTheme(event.detail.effective);
});
\`\`\`

#### 方式三：CSS 媒体查询（作为兜底）

\`\`\`css
@media (prefers-color-scheme: dark) {
    /* 仅在系统级深色模式生效，推荐配合上述方式使用 */
}
\`\`\`

#### 主题适配检查清单

- [ ] 所有硬编码颜色值是否已替换为 CSS 变量？
- [ ] 占位符（placeholder）、禁用态颜色是否已适配？
- [ ] 阴影（box-shadow）在深色模式下是否仍然可见？
- [ ] 图标/图片在深色背景下是否有足够对比度？
- [ ] 滚动条样式是否在深色下可见？
- [ ] 是否测试了从浅色切换到深色再切回浅色的完整流程？
`;
