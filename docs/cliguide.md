# OpenDesk CLI 使用手册

## 目录

1. [简介](#简介)
2. [快速开始](#快速开始)
3. [Mode 机制与现有模式](#mode-机制与现有模式)
4. [交互界面功能](#交互界面功能)
5. [斜杠命令](#斜杠命令)
6. [快捷键](#快捷键)
7. [配置说明](#配置说明)
8. [命令行参数](#命令行参数)
9. [高级功能](#高级功能)
10. [开发介绍](#开发介绍)
11. [常见问题](#常见问题)
12. [获取帮助](#获取帮助)

---

## 简介

OpenDesk CLI 是 OpenDesk 的命令行版本，提供了基于终端的文本用户界面（TUI），让您可以在不启动完整桌面应用的情况下使用 OpenDesk 的强大功能。它支持与 AI 助手的自然对话、任务管理、文件操作等功能。

---

## 快速开始

### 启动 CLI

在项目根目录下运行：

```bash
npm run cli
```

这将自动构建 CLI 并启动 OpenDesk 终端界面。

### 首次配置

首次启动时，如果您尚未配置模型，会看到配置提示。请按照以下步骤配置：

1. 输入 `/config` 打开配置菜单
2. 选择"模型服务商配置"并添加一个模型服务商
3. 选择"模型配置"并添加一个模型
4. 选择 "默认模型配置"，并选择您要使用的模型

配置完成后，您就可以开始使用 OpenDesk CLI 了！

---

## Mode 机制与现有模式

主 Agent 的 **Mode（运行模式）** 决定文件读写、Shell 命令、工具调用等操作的**权限边界**与行为约束。不同模式对应不同的权限规则（`permissionFactory`），用于在「安全默认可用」与「高自主 / 无限制」之间取舍。

### 机制概要

- **会话内切换**：在 TUI 中可随时切换当前模式，无需重启。按 **Shift+Tab** 打开模式选择器；或在输入框执行 `/mode <模式id>`（见下文 [斜杠命令](#斜杠命令)）。
- **启动时指定**：通过命令行 `--mode <mode>` 指定本次进程的初始模式；`--allow-everything` 与 `--mode unlimited` 等价（详见 [命令行参数](#命令行参数)）。
- **与规划工作流**：**Plan** 模式用于「先只读调研、再在 `.plan` 中写方案」；确认方案后通常需要切换到 **Standard** 或 **Solo** 才能实际修改业务代码（Plan 下会禁用 `editFile`、`writeFile` 等直接改代码的工具）。
- **默认模式**：未另行指定时，一般为 **standard**（与代码中 `defaultModeId()` 一致）。

### 现有模式一览

| 模式 ID     | 标识         | 说明                                                                                                                                      |
| ----------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `standard`  | ⚡ standard  | **默认**。工作区内可自由读写；访问工作区外路径时通常需经用户确认，与常见「本地项目助手」体验一致。                                        |
| `plan`      | 📋 plan      | **规划**。以只读方式浏览代码与资料，可执行只读类 Shell；**仅 `.plan` 目录可写**，用于输出计划文档。不能直接改项目源码，便于先设计后实施。 |
| `solo`      | 🎮 solo      | **高自主**。工作区内外均可读写，接近无人值守自动化；仍会对**敏感路径**按策略拒绝，并非完全裸奔。                                          |
| `unlimited` | 🔓 unlimited | **无限制**。权限规则全部放通，**风险最高**；与命令行 `--allow-everything` 等价。                                                          |

### 如何切换与选用建议

- **TUI**：**Shift+Tab** 选择模式；或 `/mode plan`、`/mode standard` 等。
- **CLI**：例如 `npm run cli -- --mode plan`；可与 `-c`、`--headless` 等组合。
- **建议**：日常开发用 `standard`；需要先出方案再动手时用 `plan` → 再切 `standard`/`solo`；仅在充分信任环境与任务时使用 `solo` / `unlimited`。

---

## 交互界面功能

### 界面布局

OpenDesk CLI 界面包含以下主要组件：

1. **横幅区域** - 显示 OpenDesk 标志和当前工作区
2. **任务视图** - 显示当前对话历史和 AI 回复
3. **待办列表** - 显示当前任务的待办事项（如有）
4. **输入区域** - 您的输入框和状态栏
5. **日志面板** - 可选的日志显示区域

### 状态栏信息

输入区域底部的状态栏显示：

- 当前使用的模型名称
- 上下文窗口大小
- 本次对话消耗的总 token 数
- 任务执行时间

---

## 斜杠命令

OpenDesk CLI 提供了丰富的斜杠命令来增强交互体验。在输入框中输入 `/` 即可查看可用命令列表。

### 命令列表

| 命令            | 描述                                          | 用法                                                     |
| --------------- | --------------------------------------------- | -------------------------------------------------------- |
| `/new`          | 启动新任务并发送消息                          | `/new [消息]`                                            |
| `/switch`       | 切换到其他任务                                | `/switch`                                                |
| `/help`         | 显示快捷键与指令帮助                          | `/help`                                                  |
| `/exit`         | 退出 OpenDesk                                 | `/exit`                                                  |
| `/quit`         | 退出 OpenDesk（需确认）                       | `/quit`                                                  |
| `/cancel`       | 撤销消息队列中的所有待发送消息                | `/cancel`                                                |
| `/clear`        | 删除所有任务历史                              | `/clear`                                                 |
| `/export`       | 导出当前会话为 HTML 文件                      | `/export [文件名]`                                       |
| `/import`       | 导入会话数据                                  | `/import [文件名]`                                       |
| `/config`       | 打开系统设置                                  | `/config`                                                |
| `/log`          | 显示日志面板                                  | `/log [off\|last\|all]`                                  |
| `/debug`        | 调试命令                                      | `/debug log [on\|off]` 或 `/debug taskid`                |
| `/quickpass`    | 导出快捷口令                                  | `/quickpass config base\|all`                            |
| `/dashboard`    | 打开仪表盘                                    | `/dashboard`                                             |
| `/stop`         | 停止当前正在执行的任务                        | `/stop`                                                  |
| `/upgrade`      | 检查并升级 OpenDesk                           | `/upgrade`                                               |
| `/rename`       | 重命名当前任务                                | `/rename [新名称]`                                       |
| `/fork`         | 复制当前任务为新任务                          | `/fork`                                                  |
| `/recover`      | 从任务文件重建任务列表                        | `/recover tasks`                                         |
| `/compact`      | 压缩当前会话上下文                            | `/compact`                                               |
| `/memory`       | 管理长期记忆                                  | `/memory`                                                |
| `/bookmark`     | 管理书签                                      | `/bookmark`                                              |
| `/notification` | 管理通知设置                                  | `/notification`                                          |
| `/undo`         | 选择用户消息，回退并放回输入框                | `/undo`                                                  |
| `/redo`         | 恢复最近一次 `/undo` 回退的后续消息           | `/redo`                                                  |
| `/btw`          | 顺便提一下（添加补充信息）                    | `/btw [补充内容]`                                        |
| `/mode`         | 查看或切换 Agent 运行模式（也可用 Shift+Tab） | `/mode plan`                                             |
| `/reason`       | 调整思考深度与思考过程展示方式                | `/reason`、`/reason effort high`、`/reason display full` |
| `/manual`       | 打开用户手册                                  | `/manual`                                                |

### 命令详细说明

#### `/new` - 新建任务

```bash
/new 分析这个项目
```

创建一个新任务并可选地立即发送消息。

#### `/switch` - 切换任务

```bash
/switch
```

打开任务切换器，显示所有历史任务。您可以选择切换到任意任务，也可以使用 `Delete` 或 `Backspace` 键删除选中的任务。面板底部会显示操作提示。

#### `/export` - 导出会话

```bash
/export my-session.html
```

将当前会话导出为 HTML 文件。如果不指定文件名，将自动生成带时间戳的文件名。

#### `/log` - 日志控制

```bash
/log all    # 显示所有日志
/log last   # 显示最后 10 条日志
/log off    # 关闭日志显示
```

#### `/debug` - 调试命令

```bash
/debug log on     # 开启调试日志
/debug log off    # 关闭调试日志
/debug log        # 查看当前调试日志状态
/debug taskid     # 显示当前任务ID（如果没有活跃任务则提示）
```

#### `/quickpass` - 快捷口令

```bash
/quickpass config base  # 导出基础设置口令（不含应用配置）
/quickpass config all   # 导出全部设置口令（含应用配置）
```

口令是一段特殊格式的字符串，形如 `[[Opendesk 快捷口令 -- <base64数据>]]`，可以通过微信、邮件等方式发送给其他 OpenDesk 用户。对方只需将口令粘贴到 TUI 聊天输入框中提交，系统会自动识别并导入。

**导出口令：** 使用 `/quickpass config base` 导出不含应用配置的基础设置，或使用 `/quickpass config all` 导出包含应用配置的全部设置。口令会通过弹窗显示，方便复制。

**导入口令：** 在 TUI 聊天输入框中粘贴完整的口令字符串并按回车提交，系统会自动检测、校验并导入。如果口令仅包含基础设置，会保留当前的应用配置。

#### `/mode` - 运行模式

在输入框执行 `/mode <模式id>` 可切换到 `standard`、`plan`、`solo`、`unlimited`；也可按 **Shift+Tab** 打开模式菜单。**Mode 的设计与各模式差异**见上文 [Mode 机制与现有模式](#mode-机制与现有模式)。

#### `/reason` - 思考（推理）相关设置

不带参数执行 `/reason` 可查看当前默认模型的思考深度、以及思考过程的展示方式。

```bash
/reason                              # 查看当前配置
/reason effort default               # 使用模型默认思考深度
/reason effort none|low|medium|high  # 为当前默认模型设置思考深度
/reason display full                 # 完整展示思考过程
/reason display partial              # 仅预览末尾若干行（默认）
```

---

## 快捷键

OpenDesk CLI 支持以下键盘快捷键：

| 快捷键     | 功能                     |
| ---------- | ------------------------ |
| `Ctrl + N` | 新建任务                 |
| `Ctrl + L` | 切换任务                 |
| `Ctrl + C` | 清空输入框或显示帮助提示 |
| `Tab`      | 自动补全命令             |
| `Enter`    | 提交输入                 |
| `↑` / `↓`  | 浏览历史输入             |

---

## 配置说明

### 进入配置模式

输入 `/config` 命令进入配置模式，您可以配置：

1. **模型服务商配置** - 添加和管理 AI 模型服务商
2. **模型配置** - 添加和管理具体的 AI 模型
3. **默认模型配置** - 设置默认使用的模型

### 配置文件

OpenDesk 的配置保存在用户目录下的配置文件中。具体位置取决于您的操作系统。

---

## 命令行参数

OpenDesk CLI 支持以下命令行参数：

```
opendesk [workspace] [选项]
```

### 参数说明

| 参数                        | 说明                                                                   | 默认值              |
| --------------------------- | ---------------------------------------------------------------------- | ------------------- |
| `workspace`                 | 工作区目录路径                                                         | 当前目录 (`.`)      |
| `--model <alias>`           | 指定要使用的模型别名                                                   | 配置的默认模型      |
| `-c, --command <command>`   | 一次性执行命令后退出                                                   | 无                  |
| `--headless`                | 无头模式运行（无 TUI，需配合 `-c`）                                    | 无                  |
| `--export-html <path>`      | `-c` 任务完成后导出 HTML 会话记录                                      | 无                  |
| `--export-json <path>`      | `-c` 任务完成后导出 JSON 会话数据                                      | 无                  |
| `--dump-log <path>`         | 将所有日志输出到指定文件                                               | 无                  |
| `--profile <path>`          | 将性能分析报告写入指定 JSON 文件（需配合 `-c`）                        | 无                  |
| `--allow-everything`        | 不做权限检查，放行所有操作（等价于 `--mode unlimited`）                | 无                  |
| `--mode <mode>`             | 启动时使用的 Agent 模式：`standard`、`plan`、`solo`、`unlimited`       | 由配置/默认模式决定 |
| `--language <lang>`         | 界面与提示语言：`auto`、`zh-CN`、`en-US`（仅本次运行，不写入配置文件） | `auto`              |
| `--config-directory <path>` | 指定配置与数据目录（应用设置、任务等）                                 | 用户默认应用目录    |
| `-v, --version`             | 显示版本信息                                                           | 无                  |

除上述选项外，还支持若干**顶级子命令**（不进入 TUI），例如 `plugins`（插件管理）、`tools`（工具相关）、`quickpass`（快捷口令导入/导出）、`channels`（消息插件管理）。完整列表与用法请运行 `npm run cli -- --help`（或构建产物 `opendesk --help`）查看。

### 使用示例

```bash
# 在当前目录启动
npm run cli

# 在指定目录启动
npm run cli -- /path/to/workspace

# 使用特定模型启动
npm run cli -- --model gpt-4

# 一次性执行命令
npm run cli -- -c "分析当前目录的代码结构"

# 无头模式执行命令并导出会话记录
npm run cli -- --headless -c "修复 bug" --export-json result.json

# 生成性能分析报告
npm run cli -- -c "重构代码" --profile profile.json

# 无头模式 + 性能分析 + 日志
npm run cli -- --headless -c "修复 bug" --profile profile.json --dump-log debug.log

# 指定界面语言（本次运行）
npm run cli -- --language zh-CN

# 以规划模式启动（可与 -c 等组合使用）
npm run cli -- --mode plan

# 使用自定义配置目录
npm run cli -- --config-directory /path/to/config
```

---

## 高级功能

### 消息队列

您可以在 AI 正在处理任务时继续输入新的消息，这些消息会被放入队列中，待当前任务完成后自动依次处理。

### 待办事项管理

在对话过程中，AI 可以创建和管理待办事项，这些事项会实时显示在界面上。

### 任务切换

您可以随时切换到历史任务，继续之前的对话。所有任务的状态和待办事项都会被保存。

在任务切换面板（`/switch` 或 `Ctrl+L`）中：

- **Enter** - 切换到选中的任务
- **Delete / Backspace** - 删除选中的任务（需确认）
- **Esc** - 关闭面板

### 消息插件自动切换

当消息插件收到新消息时，系统会自动将前台任务切换到消息关联的任务（无论是新创建的还是已有的会话任务），并通过通知系统告知用户收到了来自哪个渠道的新消息。

### 性能分析 (--profile)

使用 `--profile <path>` 参数可以在 `-c` 命令执行完成后生成详细的性能分析报告，帮助分析 Agent 执行过程中各环节的耗时。

```bash
npm run cli -- -c "分析代码结构" --profile profile.json
```

#### Profile JSON 格式

生成的 JSON 文件包含以下结构：

```json
{
    "version": 1,
    "task_id": "task_abc12345_x7yz",
    "total_ms": 45230,
    "llm_total_ms": 30120,
    "tool_total_ms": 12500,
    "overhead_ms": 2610,
    "turns": [
        {
            "turn": 0,
            "llm_ms": 15060,
            "tool_ms": 8200,
            "total_ms": 23260,
            "tool_calls": [
                { "name": "readFile", "duration_ms": 120 },
                { "name": "executeCommand", "duration_ms": 8080 }
            ]
        }
    ],
    "tool_aggregates": [
        {
            "tool_name": "executeCommand",
            "call_count": 3,
            "total_ms": 10200,
            "avg_ms": 3400,
            "min_ms": 1500,
            "max_ms": 8080
        }
    ],
    "timeline": [
        {
            "category": "llm_completion",
            "name": "streamComplete",
            "turn": 0,
            "start_ms": 1712534400000,
            "end_ms": 1712534415060,
            "duration_ms": 15060,
            "meta": { "prompt_tokens": 1200, "completion_tokens": 350 }
        }
    ]
}
```

#### 字段说明

| 字段              | 说明                                                        |
| ----------------- | ----------------------------------------------------------- |
| `total_ms`        | 任务总耗时（从开始到结束）                                  |
| `llm_total_ms`    | 大模型推理累计耗时                                          |
| `tool_total_ms`   | 工具执行累计耗时                                            |
| `overhead_ms`     | 框架开销时间（= total - llm - tool）                        |
| `turns`           | 按轮次 (turn) 拆分的汇总，每轮包含 LLM 和工具耗时           |
| `tool_aggregates` | 按工具名聚合的统计（调用次数、总/平均/最小/最大耗时）       |
| `timeline`        | 完整的时间线事件列表，包含每次 LLM 调用和工具调用的详细计时 |

---

## 开发介绍

### CLI 入口与架构

#### 入口文件

CLI 的主入口文件是 [`src/main/cli.ts`](src/main/cli.ts)。这个文件负责：

1. **命令行参数解析** - 使用 `commander` 库解析启动参数
2. **平台初始化** - 设置 CLI 平台实现
3. **日志系统配置** - 配置 CLI 专用的日志传输
4. **TUI 启动** - 初始化并启动文本用户界面

#### 构建系统

CLI 使用 `esbuild` 进行构建，构建配置在 [`esbuild.config.ts`](esbuild.config.ts) 中定义：

- **生产版本** - `dist/cli/opendesk`（压缩版，无 sourcemap）
- **调试版本** - `dist/cli/opendesk-debug`（未压缩，内联 sourcemap）

构建脚本会自动注入 shebang 头部和 require shim，确保与 Node.js ESM 模块系统兼容。

### 主要代码架构

#### 平台抽象层

OpenDesk 采用了平台抽象设计，通过 [`src/platforms/base.ts`](src/platforms/base.ts) 中的 `AbstractPlatform` 类定义统一接口：

```
AbstractPlatform (基类)
├── CliPlatform (CLI 平台实现)
└── ElectronPlatform (Electron 平台实现)
```

这种设计使得核心业务逻辑可以在不同平台间复用。

#### CLI 平台实现

[`CliPlatform`](src/platforms/cli.ts) 类提供了 CLI 特定的平台功能：

- 应用注册 - 注册 CLI 可用的应用程序
- 路径处理 - 处理文件路径操作
- Worker 路径 - 返回 CLI Worker 的执行路径

#### TUI 组件架构

TUI（文本用户界面）位于 [`src/main/tui/`](src/main/tui/) 目录下：

- **入口类** - [`OpenDeskTUI`](src/main/tui/entry.ts) - 主界面控制器
- **组件目录** - [`src/main/tui/components/`](src/main/tui/components/) - 各种 UI 组件
    - [`taskview.ts`](src/main/tui/components/taskview.ts) - 任务视图组件
    - [`input.ts`](src/main/tui/components/input.ts) - 输入区域组件
    - [`help.ts`](src/main/tui/components/help.ts) - 帮助组件
    - [`todolist.ts`](src/main/tui/components/todolist.ts) - 待办列表组件
    - [`config/`](src/main/tui/components/config/) - 配置界面组件

#### 核心状态管理

- [`GlobalState`](src/main/aikernel/states/global.ts) - 全局状态管理
- [`TaskManagerState`](src/main/aikernel/states/tasks.ts) - 任务状态管理

### 与 Electron GUI 的关系

#### 共享的核心组件

CLI 和 Electron GUI 版本共享大量核心组件：

1. **AI 内核** - [`src/main/aikernel/`](src/main/aikernel/) 目录下的所有组件
    - Agent 系统
    - LLM 集成
    - 工具调用系统
    - 技能系统

2. **应用程序** - 大部分应用在两个平台都可用
    - 邮箱应用
    - 文件管理器
    - 搜索应用
    - 终端应用
    - MCP 管理器
    - 待办事项管理器

3. **状态管理** - 相同的全局状态和任务管理系统

4. **工具和实用函数** - 共享的工具类和辅助函数

#### 平台特定组件

| 组件     | CLI          | Electron GUI           |
| -------- | ------------ | ---------------------- |
| 界面渲染 | TUI (pi-tui) | Web (HTML/CSS/JS)      |
| 窗口管理 | 终端控制     | Electron BrowserWindow |
| 应用列表 | 部分应用     | 全部应用               |
| 通知系统 | 日志输出     | 原生通知               |

#### 应用注册差异

通过对比 [`CliPlatform`](src/platforms/cli.ts) 和 [`ElectronPlatform`](src/platforms/electron.ts) 可以看到：

- **CLI 特有** - 基础应用集
- **Electron 特有** - 额外包含 A2A、Recall、PPT 创建器、Designer、SkillMgr 等图形界面应用

### 复用的组件详解

#### 1. 应用层复用

所有继承自 [`BaseApplication`](src/main/applications/base.ts) 的应用都可以在两个平台间无缝复用，只要它们不依赖特定平台的 UI 功能。

#### 2. AI 内核完全复用

整个 AI 内核（Agent、LLM、工具、技能）是完全平台无关的，这确保了 CLI 和 GUI 版本具有一致的 AI 能力。

#### 3. 状态管理共享

使用相同的状态管理机制，确保任务、配置等数据在两个版本间的一致性。

#### 4. Worker 系统

两个版本都使用相同的 Worker 架构来处理后台任务，通过 [`initializeAppWorkers()`](src/main/applications/worker.ts) 初始化。

### 扩展开发指南

#### 添加新的斜杠命令

在 [`src/main/tui/commands/`](src/main/tui/commands/) 下新增 `registerMycommandCommand` 等模块，并在 [`registerAllCommands()`](src/main/tui/commands/index.ts) 中调用；[`OpenDeskTUI.setupCommands()`](src/main/tui/entry.ts) 会统一装载这些注册函数。注册示例：

```typescript
tui.commandRegistry.register({
    name: 'mycommand',
    description: '我的自定义命令',
    shortcut: Key.ctrl('m'), // 可选
    execute: async (args: string) => {
        // 命令实现
    }
});
```

#### 创建新的 TUI 组件

参考 [`src/main/tui/components/`](src/main/tui/components/) 目录下的现有组件，通过 `src/main/tui/pi-tui.ts` 适配层创建新组件。

#### 平台适配

如果需要开发同时支持两个平台的功能，通过 `getPlatform().getName()` 判断当前平台并提供相应实现。

### 工具的命令行渲染机制

OpenDesk 提供了灵活的工具渲染系统，让工具可以在 CLI 中提供自定义的视觉展示。

#### 渲染架构

工具渲染系统的核心组成：

1. **`BaseTool.renderToolCallCli()`** - 工具类中的自定义渲染方法
2. **`ToolCallView`** - 工具调用视图组件，负责选择使用自定义渲染还是默认渲染
3. **`DefaultToolCallView`** - 默认的工具调用渲染器
4. **`ToolCallMessagePartView`** - 管理多个工具调用的容器

#### 渲染流程

```
ToolCall (工具调用数据)
    ↓
ToolCallView 检查
    ↓
├─ 工具有 renderToolCallCli()? → 是 → 使用自定义渲染
│                                  ↓
│                              返回 string[]
│
└─ 否 → 使用 DefaultToolCallView
           ↓
       简洁的单行渲染
```

#### 默认渲染

[`DefaultToolCallView`](src/main/tui/components/toolcall.ts) 提供简洁的单行渲染：

```
  ● toolname ·········· 执行中…
```

显示内容包括：

- 状态图标（等待中/执行中/完成/失败）
- 工具名称（加粗）
- 连接点线
- 状态文本

状态使用 `chalk` 进行颜色渲染：

- 等待中：灰色 `○`
- 执行中：亮蓝色 `●`
- 完成：亮绿色 `✔`
- 失败：亮红色 `✘`

#### 自定义渲染

工具可以通过实现 `renderToolCallCli()` 方法提供自定义渲染：

```typescript
class MyCustomTool extends BaseTool {
    // ... 工具定义 ...

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        // 返回自定义渲染的行数组
        return [
            '╭───────────────────────────────────────────────╮',
            '│  My Custom Tool                               │',
            '│  参数: ' + JSON.stringify(toolcall.params) + ' │',
            '╰───────────────────────────────────────────────╯'
        ];
    }
}
```

**方法签名：**

```typescript
renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined
```

- `toolcall`: 工具调用对象，包含参数、状态、结果等信息
- `width`: 当前终端宽度，用于适配布局
- 返回值: `string[]` 表示渲染后的行，`undefined` 则使用默认渲染

#### 工具调用数据结构

[`ToolCall`](src/main/aikernel/messages.ts) 对象包含：

- `tool_name`: 工具名称
- `params`: 工具参数
- `status`: 状态 ('pending' | 'running' | 'success' | 'error')
- `result`: 执行结果
- `tool`: 工具实例引用（如果可用）

#### 渲染辅助工具

[`toolcall.ts`](src/main/tui/components/toolcall.ts) 提供了实用的辅助函数：

**`statusDisplay(status)`** - 将状态字符串转换为带样式的显示对象

```typescript
statusDisplay('running');
// 返回: { icon: chalk.blueBright('●'), text: chalk.blueBright('执行中…') }
```

**`truncText(str, maxWidth)`** - 截断文本以适应指定宽度

- 自动处理 ANSI 颜色代码
- 自动处理宽字符
- 超出部分用 `…` 表示

**`visibleWidth(str)`** - 计算文本的可见宽度（不计算 ANSI 代码）

#### 组件集成

在 [`TaskView`](src/main/tui/components/taskview.ts) 中的集成：

1. **`AssistantMessageView`** - 管理助手消息的所有部分
2. **`ToolCallMessagePartView`** - 容器，包含多个 `ToolCallView`
3. **`ToolCallView`** - 单个工具调用的视图，选择渲染策略
4. **流式更新** - 通过 `updateToolCallPart()` 实时更新工具状态

#### 实际示例

查看现有工具的自定义渲染实现可以参考：

- 终端应用工具
- 文件管理器工具
- 其他需要特殊展示的工具

实现自定义渲染时，建议：

1. 使用 `chalk` 进行颜色和样式
2. 考虑终端宽度限制
3. 保持与整体 TUI 风格一致
4. 提供清晰的状态反馈

---

## 常见问题

### Q: 如何退出 OpenDesk CLI？

A: 输入 `/exit` 命令，或在输入框为空时按 `Ctrl + C` 然后确认退出。

### Q: 我的配置保存在哪里？

A: 配置保存在您的用户目录下，具体位置取决于操作系统。

### Q: 可以同时运行多个 CLI 实例吗？

A: 可以，但建议在不同的工作区目录下运行，以避免配置冲突。

---

## 获取帮助

如果您需要更多帮助，可以：

1. 在 CLI 中输入 `/help` 查看帮助信息
2. 访问 OpenDesk 项目文档
3. 在 GitCode 上提交 Issue

---

_祝您使用 OpenDesk CLI 愉快！_
