# OpenDesk 滚动条设计规范

## 概述

OpenDesk 使用 WebKit 自定义滚动条（`::-webkit-scrollbar` 伪元素），按区域的使用场景分为**两级**，并统一通过 `html[data-theme='dark']` 属性选择器适配深色/浅色模式。

---

## 一、分级设计

### 一级滚动条（Primary）：主导航区 & 主内容区

**适用场景**：侧边栏列表、主内容聊天区、邮件列表等需要频繁滚动的大面积区域。

| 属性                     | 浅色模式              | 深色模式                    |
| ------------------------ | --------------------- | --------------------------- |
| `width`                  | 4px                   | 4px                         |
| `track background`       | `transparent`         | `transparent`               |
| `thumb background`       | `rgba(0, 0, 0, 0.12)` | `rgba(255, 255, 255, 0.18)` |
| `thumb:hover background` | `rgba(0, 0, 0, 0.22)` | `rgba(255, 255, 255, 0.28)` |
| `thumb border-radius`    | `4px`                 | `4px`                       |

**代码模板**：

```css
/* 浅色模式 - custom.css */
.primary-scroll::-webkit-scrollbar {
    width: 4px;
}
.primary-scroll::-webkit-scrollbar-track {
    background: transparent;
}
.primary-scroll::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.12);
    border-radius: 4px;
}
.primary-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.22);
}

/* 深色模式 - theme-dark.css */
html[data-theme='dark'] .primary-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18) !important;
}
html[data-theme='dark'] .primary-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.28) !important;
}
```

**已有参考**：`#task-list-container`（侧边栏）、`#taskview-chat-history`（TaskView）

> **注意**：当内容区宽度达到 6px 以上的视觉需求时（如 TaskView 主聊天区），可将 `width` 调整为 4px 或 6px，同时 `border-radius` 随之调整为宽度的一半。

---

### 二级滚动条（Compact）：面板 / 弹窗 / 小区域

**适用场景**：技能面板、子任务分组、弹窗列表、代码块内部等紧凑区域。

| 属性                     | 浅色模式                                    | 深色模式                    |
| ------------------------ | ------------------------------------------- | --------------------------- |
| `width`                  | 3–4px                                       | 3–4px                       |
| `track background`       | `transparent`                               | `transparent`               |
| `thumb background`       | 实色灰（`#d1d5db` / `#e5e7eb` / `#cbd5e1`） | `rgba(255, 255, 255, 0.18)` |
| `thumb:hover background` | —（或略深一级灰）                           | `rgba(255, 255, 255, 0.28)` |
| `thumb border-radius`    | `2px`                                       | `2px`                       |

**代码模板**：

```css
/* 浅色模式 - custom.css */
.compact-scroll::-webkit-scrollbar {
    width: 4px;
}
.compact-scroll::-webkit-scrollbar-track {
    background: transparent;
}
.compact-scroll::-webkit-scrollbar-thumb {
    background: #d1d5db;
    border-radius: 2px;
}

/* 深色模式 - theme-dark.css */
html[data-theme='dark'] .compact-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.18) !important;
}
html[data-theme='dark'] .compact-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.28) !important;
}
```

**已有参考**：`.skill-panel-list`、`.subtask-group-scroll`、`.sb-app-popover-visible`、代码块 `.code-block-body`

---

## 二、深色/浅色模式适配机制

### 主题切换方式

通过 `<html>` 元素的 `data-theme` 属性标识当前主题：

- 浅色模式：`<html>`（无 `data-theme` 属性，或 `data-theme="light"`）
- 深色模式：`<html data-theme="dark">`

### CSS 编写规则

1. **浅色模式样式**写在 `src/renderer/styles/custom.css`，不加主题选择器前缀
2. **深色模式覆盖样式**写在 `src/renderer/theme/theme-dark.css`，必须加 `html[data-theme='dark']` 前缀
3. 深色模式下只需覆盖颜色相关的属性（`background`），`width`、`border-radius`、`track` 等结构属性保持不变，由浅色模式统一定义
4. 深色模式覆盖需加 `!important`，因为浅色模式选择器可能与 Web Component 的 Shadow DOM 穿透叠加

### 颜色语义

| 模式 | thumb 颜色               | hover 颜色               | 设计意图                           |
| ---- | ------------------------ | ------------------------ | ---------------------------------- |
| 浅色 | `rgba(0,0,0,0.12)`       | `rgba(0,0,0,0.22)`       | 低调融入浅色背景，hover 时略微加深 |
| 深色 | `rgba(255,255,255,0.18)` | `rgba(255,255,255,0.28)` | 在深色背景上有足够对比度但不刺眼   |

- 二级滚动条浅色模式下使用实色灰（如 `#d1d5db`），在紧凑区域提供更稳定的视觉锚点
- 深色模式下统一使用半透明白色，与一级滚动条保持一致的颜色体系

---

## 三、最佳实践

### 要做的事

- 为所有预期的滚动区域显式定义 `::-webkit-scrollbar` 样式
- Track 始终设为 `transparent`，保持界面干净
- 使用 `rgba()` 而非固定颜色值，确保在不同背景下都自然融入
- `border-radius` 设为 `width` 的一半或等于 `width`，形成圆角/圆形 thumb
- 浅色和深色模式的样式分别写在对应文件中

### 不要做的事

- 不要在深色模式 CSS 中重复定义 `width`、`border-radius` 等结构属性
- 不要使用过于鲜艳或饱和度高的 thumb 颜色
- 不要忘记加 `!important`（深色覆盖时）
- 不要将滚动条宽度设得过大（>8px），会破坏界面紧凑感

---

## 四、文件位置约定

| 文件                                | 内容                     |
| ----------------------------------- | ------------------------ |
| `src/renderer/styles/custom.css`    | 浅色模式滚动条样式       |
| `src/renderer/theme/theme-dark.css` | 深色模式滚动条覆盖样式   |
| `src/renderer/theme/theme.css`      | CSS 变量定义（背景色等） |

---

## 五、引用对照表

| 组件                                 | 分级 | 宽度 | 浅色 thumb         | 深色 thumb               | 圆角 |
| ------------------------------------ | ---- | ---- | ------------------ | ------------------------ | ---- |
| `#task-list-container`（侧边栏）     | 一级 | 4px  | `rgba(0,0,0,0.12)` | `rgba(255,255,255,0.18)` | 4px  |
| `#taskview-chat-history`（TaskView） | 一级 | 6px  | 浏览器默认         | `rgba(255,255,255,0.18)` | 3px  |
| `.skill-panel-list`                  | 二级 | 4px  | `#e5e7eb`          | `rgba(255,255,255,0.18)` | 2px  |
| `.subtask-group-scroll`              | 二级 | 3px  | `#e5e7eb`          | `rgba(255,255,255,0.18)` | 2px  |
| `.sb-app-popover-visible`            | 二级 | 4px  | `#d1d5db`          | —                        | 2px  |
| `.code-block-body`                   | 二级 | 4px  | `#d1d5db`          | `rgba(255,255,255,0.18)` | 2px  |
