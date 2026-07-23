# 工具渲染风格指南 (Electron GUI)

> 本文档定义 OpenDesk Electron GUI 中工具调用（ToolCall）的两种标准渲染风格，供新增或优化工具时参考。

## 目录

- [架构概述](#架构概述)
- [风格一：简洁行内风格 (Inline)](#风格一简洁行内风格-inline)
- [风格二：详细卡片风格 (Detailed Card)](#风格二详细卡片风格-detailed-card)
- [共通规范](#共通规范)
- [风格选择决策树](#风格选择决策树)
- [现有工具风格索引](#现有工具风格索引)

---

## 架构概述

工具的 GUI 渲染通过 `BaseTool.renderToolCall(toolcall: ToolCall): Promise<string | undefined>` 方法返回 **HTML 字符串**。渲染器（`taskview.js`）将该 HTML 直接插入 DOM。

- 如果工具未实现 `renderToolCall`，将回退到 `ToolCall.render()` 的默认渲染（wrench 图标 + 工具名）。
- TUI 端使用独立的 `renderToolCallCli` 方法，本文档仅关注 GUI 端。

### 关键约束

| 项目      | 要求                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| 样式框架  | Tailwind CSS（通过 class 控制），不使用内联 style（除历史遗留）                                              |
| 宽度      | `w-full`（占满父容器），由父容器控制最大宽度                                                                 |
| 外观      | **无内外阴影**，统一使用 `border border-gray-200`（浅色边框）和 `rounded-lg`（统一圆角）                     |
| 文本截断  | 使用 CSS `truncate` / `line-clamp-N` 实现自适应截断，**不在 JS 中手动 `.slice()`**                           |
| HTML 安全 | 所有用户可控文本必须经过 `escapeHtml()` 处理；markdown 内容使用 `marked.parse()`                             |
| 国际化    | 所有工具显示名称必须使用 `t('tools.xxx.name')` 获取，键定义在 `src/locale/zh-cn.ts` 和 `src/locale/en-us.ts` |
| Unicode   | 不在代码中直接写 `\uXXXX` 转义序列，使用正确的字符                                                           |

---

## 风格一：简洁行内风格 (Inline)

### 适用场景

- 工具执行快速、结果简单
- 用户只需知道"做了什么"，不需要查看详细输出
- 工具是信息获取类（读取、搜索、查询）

### 视觉结构

```
[图标] 工具名 [状态点] 关键参数摘要
```

单行，紧凑排列。高度约 24-28px。

### HTML 模板

```html
<div class="od-inline-toolcall-container">
    <div class="flex items-center gap-1.5 min-w-0">
        <i class="{icon-class} shrink-0 text-slate-400 text-xs"></i>
        <span class="shrink-0 text-slate-500 text-xs">{工具名}</span>
        {statusIcon}
        <span class="truncate text-xs text-slate-600">{detail}</span>
    </div>
</div>
```

### 组成元素

| 元素     | 说明                                               | 样式                                                 |
| -------- | -------------------------------------------------- | ---------------------------------------------------- |
| 图标     | FontAwesome 图标                                   | `text-slate-400 text-xs shrink-0`                    |
| 工具名   | i18n 本地化名称                                    | `text-slate-500 text-xs shrink-0`                    |
| 状态点   | running 时蓝色脉冲点，error 时红色点，success 时无 | `w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse` |
| 摘要信息 | 关键参数、结果计数等                               | `text-xs text-slate-600 truncate`                    |

### 辅助函数

`filemgr/tools.ts` 中的 `renderInlineTool()` 是该风格的标准实现，支持以下扩展：

- `fileList`: 在主行下方展示文件列表（如 readFiles）
- `body`: 在主行下方展示自定义 HTML 内容
- `detailTitle`: 为 detail 添加 hover tooltip

### 示例工具

| 工具            | 图标                       | 显示效果                                      |
| --------------- | -------------------------- | --------------------------------------------- |
| getCurrentTime  | `far fa-clock`             | 获取当前时间 2026-05-04 11:22                 |
| grepFiles       | `fas fa-code`              | 内容搜索 TODO · src/ · 3 文件 / 12 处匹配     |
| readFiles       | `fas fa-file-lines`        | 读取文件 src/main.ts · 3 个文件               |
| writeFile       | `fas fa-file-pen`          | 写入文件 output.txt · 1,234 字符              |
| listRecentTasks | `fas fa-list-ul`           | 列出任务 2026-05-01 ~ 2026-05-03，共 5 个任务 |
| getTaskHistory  | `fas fa-clock-rotate-left` | 获取历史 abc12345… · 最近 10 条 · 返回 8 条   |
| TodoWrite       | `fas fa-list-check`        | 更新任务计划 3/5                              |
| glob            | `fas fa-folder-tree`       | 模式匹配 \*_/_.ts · 42 个文件                 |

---

## 风格二：详细卡片风格 (Detailed Card)

### 适用场景

- 工具有丰富的输入/输出内容需要展示
- 结果包含结构化信息（diff、markdown、进度列表等）
- 用户需要查看详细信息来理解执行过程

### 视觉结构

```
┌─────────────────────────────────────────────┐
│ [图标] 工具名  参数标题      [状态徽章] ▾    │  ← header (summary)
├─────────────────────────────────────────────┤
│                                             │
│  详细内容（markdown / diff / 进度 / 选项）    │  ← body
│                                             │
└─────────────────────────────────────────────┘
```

使用 `<details>` 实现可折叠，默认展开（`open`）。

### HTML 模板

```html
<details class="my-1.5 rounded-lg border {borderColor} bg-white overflow-hidden w-full" open>
    <summary
        class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none
                     hover:bg-gray-50/60 transition-colors duration-150"
    >
        <span class="inline-flex items-center justify-center w-5 h-5 rounded {iconBg}">
            <i class="fa-solid {icon} text-[10px]"></i>
        </span>
        <span class="text-[12px] text-gray-500 shrink-0">{工具名}</span>
        <span class="text-[12px] text-gray-600 truncate flex-1">{标题/参数}</span>
        {statusBadge}
        <svg
            class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
        >
            <path d="M6 9l6 6 6-6" />
        </svg>
    </summary>
    <div class="border-t border-gray-100 bg-gray-50/40">
        <div class="max-h-[240px] overflow-y-auto">{bodyContent}</div>
    </div>
</details>
```

### 组成元素

#### Header (summary)

| 元素      | 说明                                                            | 样式                                        |
| --------- | --------------------------------------------------------------- | ------------------------------------------- |
| 图标容器  | 带背景色的圆角方块                                              | `w-5 h-5 rounded {bg-color}`                |
| 图标      | FontAwesome 图标，10px                                          | `text-[10px]`                               |
| 工具名    | i18n 名称，常规字重，不截断                                     | `text-[12px] text-gray-500 shrink-0`        |
| 标题/参数 | 核心参数信息，可截断，与工具名仅用空格分隔（不加 `·` 等分隔符） | `text-[12px] text-gray-600 truncate flex-1` |
| 状态徽章  | 执行状态标签                                                    | 见下方"状态徽章规范"                        |
| 折叠箭头  | SVG chevron                                                     | `w-3 h-3 text-gray-400`                     |

#### Body

| 场景          | 内容样式                               |
| ------------- | -------------------------------------- |
| 运行中        | 进度指示器或 spinner + 提示文字        |
| 成功 (文本)   | `markdown-body` 渲染的 markdown 内容   |
| 成功 (diff)   | 带颜色区分的 diff 视图                 |
| 成功 (结构化) | 自定义布局（如问答选项、工具调用序列） |
| 错误          | 红色文字错误信息                       |

Body 容器固定样式：`border-t border-gray-100 bg-gray-50/40`，内容区域设置 `max-h-[200px]`~`max-h-[280px]` 和 `overflow-y-auto`。

### 状态徽章规范

```html
<!-- 运行中 -->
<span
    class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium
             bg-blue-50 text-blue-500"
>
    <i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>执行中
</span>

<!-- 成功/完成 -->
<span
    class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium
             bg-emerald-50 text-emerald-600"
>
    <i class="fa-solid fa-circle-check text-[8px]"></i>完成
</span>

<!-- 失败 -->
<span
    class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium
             bg-red-50 text-red-500"
>
    <i class="fa-solid fa-circle-xmark text-[8px]"></i>失败
</span>

<!-- 等待中 -->
<span
    class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium
             bg-amber-50 text-amber-600"
>
    <i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>等待中
</span>
```

### 图标容器颜色方案

| 状态               | iconBg                           |
| ------------------ | -------------------------------- |
| 正常/运行          | `bg-blue-50 text-blue-400`       |
| 成功               | `bg-emerald-50 text-emerald-500` |
| 错误               | `bg-red-50 text-red-400`         |
| 等待/异步          | `bg-amber-50 text-amber-500`     |
| 特殊（追加消息等） | `bg-violet-50 text-violet-400`   |

### 错误状态边框

当工具处于 `error` 状态时，外层 `border` 从 `border-gray-200` 切换为 `border-red-200`，提供视觉区分。

### 示例工具

| 工具                       | 图标                    | Header 显示                           |
| -------------------------- | ----------------------- | ------------------------------------- |
| executeBash/PowerShell/Zsh | 终端 SVG                | 命令描述或命令内容                    |
| editFile (diff)            | 文件扩展名徽章（右侧）  | 编辑文件 filename.ts +3 -2 `[TS]`     |
| askFromTask                | `fa-comment-dots`       | **任务追问** 请总结这个任务的主要内容 |
| createSubTask              | `fa-diagram-project`    | **子任务** 实现用户认证模块 [异步]    |
| waitSubTask                | `fa-hourglass-half`     | **等待子任务** 实现用户认证模块       |
| attachToSubTask            | `fa-paper-plane`        | **追加消息到子任务** [同步]           |
| askUser                    | `fa-circle-question`    | **询问用户** 您希望使用哪种数据库？   |
| attemptCompletion          | `fa-check` / `fa-xmark` | 子任务报告 #abc12345                  |

---

## 共通规范

### 文本截断策略

- **JS 层面不手动 `.slice()` 截断**（除非是为构建最终展示字符串做极端保护，如 > 500 字符）
- 使用 Tailwind 的 `truncate`（单行省略）或 `line-clamp-N`（多行省略）让 CSS 自适应容器宽度
- 对于 `title` 属性可添加完整文本作为 hover tooltip

### Markdown 渲染

当工具返回的结果是 markdown 格式时，使用 `marked.parse()` 渲染为 HTML，并用 `markdown-body` class 包裹以获得正确的排版样式。

**注意：`marked.parse()` 返回 Promise，必须使用 `await`。**

```html
<div
    class="px-4 py-2.5 text-xs text-gray-700 leading-relaxed markdown-body
            max-h-[240px] overflow-y-auto"
>
    ${await marked.parse(result)}
</div>
```

### 色彩语义

| 语义      | 颜色系        | 使用场景               |
| --------- | ------------- | ---------------------- |
| 信息/运行 | blue          | 运行中状态、信息性内容 |
| 成功      | emerald/green | 完成、通过             |
| 错误/失败 | red/rose      | 错误状态、失败信息     |
| 警告/等待 | amber/yellow  | 等待用户输入、异步等待 |
| 新增      | emerald       | diff 中的添加行        |
| 删除      | rose          | diff 中的删除行        |
| 中性      | slate/gray    | 标签、边框、次要文字   |

### 用户消息气泡

用户发送的消息使用与详细卡片一致的边框风格：

```html
<div class="bg-white text-gray-900 rounded-lg px-3 py-1.5 max-w-3xl border border-gray-200">${content}</div>
```

**不使用** `shadow-sm`、`backdrop-blur`、`rounded-2xl` 等花哨效果。

### 深色模式适配

工具渲染的 HTML 使用 Tailwind CSS 的浅色类（如 `bg-white`、`text-gray-600`），在深色模式下通过 `src/renderer/theme/theme-dark.css` 中的 CSS 覆盖实现适配。

#### 适配原则

1. **HTML 中只写浅色样式**：在 `renderToolCall` 返回的 HTML 中，始终使用浅色 Tailwind 类（`bg-white`、`border-gray-200`、`text-gray-600` 等），**不要**在 HTML 中写深色模式的条件判断或 `@media` 查询。

2. **通过 CSS 类作用域实现深色覆盖**：为特定类型的工具卡片添加语义化的 CSS 类名，在 `theme-dark.css` 中通过 `html[data-theme='dark'] .类名` 选择器覆盖颜色和背景。

3. **使用 CSS 变量**：深色模式覆盖优先使用项目定义的 CSS 变量：
    - `--od-bg-elevated`： Elevated 层背景（替代 `bg-white`）
    - `--od-bg-muted`： Muted 层背景（替代 `bg-gray-50`）
    - `--od-bg-subtle`： Subtle 层背景（替代 `bg-gray-100`）
    - `--od-border-strong`： 强边框（替代 `border-gray-200`）
    - `--od-border`： 普通边框
    - `--od-text`： 主文本色
    - `--od-text-muted`： 次要文本色
    - `--od-accent`： 强调色

4. **状态色使用半透明 RGBA**：状态徽章（成功、错误、警告等）的深色模式适配使用对应颜色的半透明背景 + 亮色文字：

    | 状态          | 深色背景                   | 深色文字  |
    | ------------- | -------------------------- | --------- |
    | 蓝色 (运行中) | `rgba(96, 165, 250, 0.12)` | `#93c5fd` |
    | 翠绿 (成功)   | `rgba(16, 185, 129, 0.1)`  | `#6ee7b7` |
    | 红色 (错误)   | `rgba(244, 63, 94, 0.1)`   | `#fda4af` |
    | 琥珀 (等待)   | `rgba(251, 191, 36, 0.1)`  | `#fcd34d` |
    | 紫色          | `rgba(168, 85, 247, 0.1)`  | `#d8b4fe` |

#### 参考实现：终端类工具

终端类工具（`executeBash`/`executePowerShell`/`executeZsh`）是深色模式适配的参考标准：

```css
/* theme-dark.css */
html[data-theme='dark'] .terminal-tool {
    background: var(--od-bg-elevated) !important;
    border-color: var(--od-border-strong) !important;
}
html[data-theme='dark'] .terminal-tool .bg-gray-50\/40 {
    background: var(--od-bg-muted) !important;
}
html[data-theme='dark'] .terminal-tool .border-gray-100 {
    border-color: var(--od-border-strong) !important;
}
html[data-theme='dark'] .terminal-tool .text-gray-600 {
    color: var(--od-text-muted) !important;
}
html[data-theme='dark'] .terminal-tool summary:hover {
    background: var(--od-bg-muted) !important;
}
```

HTML 侧只需添加 `.terminal-tool` 类：

```html
<details class="terminal-tool my-1.5 rounded-lg border border-gray-200 bg-white overflow-hidden" open>...</details>
```

#### 新增工具类型的适配步骤

1. **在 HTML 中添加语义 CSS 类**：在 `renderToolCall` 返回的根元素上添加新的语义类名（如 `.subtask-tool`、`.file-tool-card`）
2. **在 theme-dark.css 中添加覆盖规则**：参考终端工具的模式，覆盖背景、边框、文字颜色
3. **覆盖所有使用的 Tailwind 颜色类**：包括 `bg-{color}`、`text-{color}`、`border-{color}` 等

#### 不同类型工具的深色模式适配指南

根据工具渲染风格的不同，深色模式适配策略有所区别：

**1. 详细卡片风格工具（可折叠 details）**

- **根元素**：语义类 + `#app-root task-view` 前缀（嵌入式对话使用 `task-view[embedded]`），确保 CSS 特异性足够覆盖全局 `:where(.text-gray-*)` 规则
- **背景覆盖**：`bg-white` → `var(--od-bg-elevated)`，`bg-gray-50/40` → `var(--od-bg-muted)`
- **边框覆盖**：`border-gray-100` / `border-gray-200` → `var(--od-border-strong)`
- **文字覆盖**：
    - `text-gray-700` → `var(--od-text)`（主文本，用于重要信息）
    - `text-gray-600` / `text-gray-500` / `text-gray-400` → `var(--od-text-muted)`（次要文本，正文/摘要）
    - **避免使用 `text-gray-600` 直接映射到 `var(--od-text)`**，这会导致正文过亮
- **hover 状态**：`summary:hover` / `hover:bg-gray-50/60` → `var(--od-bg-muted)`
- **状态徽章**：使用半透明 RGBA 背景 + 亮色文字（见上表）

**2. 终端类工具（`.terminal-tool`）**

- 适配模式与详细卡片一致，额外注意：
    - 输出内容区域 `bg-gray-50/40` 使用 `var(--od-bg-muted)` 保持与终端风格统一
    - 命令输出文本使用 `var(--od-text)` 确保可读性

**3. 内联行内风格工具（`.od-inline-toolcall-container`）**

- 通常依赖全局的 `#app-root task-view` 覆盖规则；嵌入模式也复用该组件和规则
- 如有特殊颜色需求，在语义类下单独覆盖
- `text-slate-*` 系列统一映射到 `var(--od-text-muted)`

**4. attemptCompletion 风格卡片（不可折叠 div）**

- 这类卡片使用语义类名（如 `.subtask-result`、`.subtask-result-header`、`.subtask-result-icon`、`.subtask-result-badge` 等），颜色值写在 CSS 规则中而非 Tailwind 任意值类中
- 根元素使用 `.subtask-result` + 状态修饰符（`.subtask-result--fail` / `--ask` / `--success`）区分不同状态
- 成功/失败/等待状态的背景色映射为对应颜色的半透明背景
- 边框颜色映射为对应颜色的半透明边框或 `var(--od-border-strong)`
- 子任务工具中的状态徽章使用 `.subtask-badge--*` 类，图标背景使用 `.subtask-icon--*` 类

**CSS 特异性注意事项**：

```css
/* ❌ 错误：特异性不足，会被全局 #app-root :where(.text-gray-600) 覆盖 */
html[data-theme='dark'] .subtask-tool .text-gray-600 {
    color: var(--od-text-muted) !important;
}

/* ✅ 正确：包含 #app-root task-view 前缀，特异性足够 */
html[data-theme='dark'] #app-root task-view .subtask-tool .text-gray-600,
html[data-theme='dark'] #app-root task-view[embedded] .subtask-tool .text-gray-600 {
    color: var(--od-text-muted) !important;
}
```

---

## 风格选择决策树

```
该工具是否有丰富的结果内容需要展示？
├─ 否 → 工具执行结果是否简单（成功/失败 + 少量统计）？
│   ├─ 是 → 使用 简洁行内风格
│   └─ 否 → 使用 详细卡片风格
└─ 是 → 结果是否包含以下之一？
    ├─ diff / 代码变更 → 详细卡片风格（带 diff 渲染）
    ├─ markdown 文本 → 详细卡片风格（带 markdown 渲染）
    ├─ 交互式选项 → 详细卡片风格（带选项 UI）
    ├─ 进度/子任务 → 详细卡片风格（带进度指示）
    └─ 仅文件列表 → 简洁行内风格（使用 fileList 扩展）
```

---

## 现有工具风格索引

### 简洁行内风格

| 工具               | 文件               | 图标                       | i18n key                     |
| ------------------ | ------------------ | -------------------------- | ---------------------------- |
| getCurrentTime     | `todomgr/tools.ts` | `far fa-clock`             | `tools.getCurrentTime.name`  |
| readFile           | `filemgr/tools.ts` | `fas fa-file-lines`        | `filemgr.readFile.name`      |
| extractText        | `filemgr/tools.ts` | `fas fa-file-lines`        | `filemgr.extractText.name`   |
| writeFile          | `filemgr/tools.ts` | `fas fa-file-pen`          | `filemgr.writeFile.name`     |
| editFile (无 diff) | `filemgr/tools.ts` | `fas fa-scissors`          | `filemgr.editFile.name`      |
| createFile         | `filemgr/tools.ts` | `fas fa-file-circle-plus`  | `filemgr.createFile.name`    |
| grepFiles          | `filemgr/tools.ts` | `fas fa-code`              | `filemgr.grep.name`          |
| glob               | `filemgr/tools.ts` | `fas fa-folder-tree`       | `filemgr.glob.name`          |
| listRecentTasks    | `states/tools.ts`  | `fas fa-list-ul`           | `tools.listRecentTasks.name` |
| getTaskHistory     | `states/tools.ts`  | `fas fa-clock-rotate-left` | `tools.getTaskHistory.name`  |
| TodoWrite          | `todomgr/tools.ts` | `fas fa-list-check`        | — (inline)                   |

### 详细卡片风格

| 工具              | 文件                   | 图标                      | i18n key                      | CSS 类            |
| ----------------- | ---------------------- | ------------------------- | ----------------------------- | ----------------- |
| executeBash       | `terminal/tools.ts`    | 终端 SVG                  | —                             | `.terminal-tool`  |
| executePowerShell | `terminal/tools.ts`    | 终端 SVG                  | —                             | `.terminal-tool`  |
| executeZsh        | `terminal/tools.ts`    | 终端 SVG                  | —                             | `.terminal-tool`  |
| semanticSearch    | `filemgr/tools.ts`     | `fas fa-magnifying-glass` | `filemgr.semanticSearch.name` | `.file-tool-card` |
| editFile (diff)   | `filemgr/tools.ts`     | 扩展名徽章                | `filemgr.editFile.name`       | `.diff-card`      |
| askFromTask       | `states/tools.ts`      | `fa-comment-dots`         | `tools.askFromTask.name`      | —                 |
| createSubTask     | `planning/tools.ts`    | `fa-diagram-project`      | `tools.createSubTask.name`    | `.subtask-tool`   |
| waitSubTask       | `planning/tools.ts`    | `fa-hourglass-half`       | `tools.waitSubTask.name`      | `.subtask-tool`   |
| attachToSubTask   | `planning/tools.ts`    | `fa-paper-plane`          | `tools.attachToSubTask.name`  | `.subtask-tool`   |
| askUser           | `interaction/tools.ts` | `fa-circle-question`      | `tools.askUser.name`          | —                 |
| attemptCompletion | `planning/tools.ts`    | `fa-check`                | —                             | `.subtask-result` |
