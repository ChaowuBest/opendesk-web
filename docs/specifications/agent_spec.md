# CustomAgent 技术规格

> 本文档定义了 CustomAgent 的完整格式规范和加载机制。CustomAgent 是 OpenDesk Agent 系统中的一种自定义 Agent 类型，支持从指定目录加载 agent 配置，包括系统提示词、MCP 服务器和私有技能。

## 目录

1. [概述](#1-概述)
2. [目录结构](#2-目录结构)
3. [文件格式](#3-文件格式)
4. [加载与注册](#4-加载与注册)
5. [System Prompt 生成](#5-system-prompt-生成)
6. [MCP 服务器支持](#6-mcp-服务器支持)
7. [Skills 支持](#7-skills-支持)
8. [权限模型](#8-权限模型)
9. [与 AgentOffice Staff 的关系](#9-与-agentoffice-staff-的关系)

---

## 1. 概述

### 1.1 什么是 CustomAgent

CustomAgent 是 `AgentDecl` 的子类，`agentType` 为 `'custom'`。它允许用户从文件系统目录加载自定义 agent 配置，包括：

- **系统提示词**：通过 `agents.md` 定义 agent 的角色和行为指令
- **MCP 服务器**：通过 `mcp.json` 声明 agent 专属的 MCP 服务器，自动连接并注入工具
- **私有技能**：通过 `skills/` 目录提供 agent 专属的 Skills，自动注册到 SkillRegistry

CustomAgent 的配置目录格式与 AgentOffice Staff 的 `agent/` 子目录完全对齐（参见 [staff_spec.md](./staff_spec.md)），使得两者可以共享同一套 agent 配置文件。

### 1.2 设计原则

- **应用层加载**：由 `AgentOfficeApplication.getAgents()` 统一扫描并通过 `CustomAgent.loadFromPath(dir)` 加载
- **启动时自动扫描**：从 `getOpendeskDirectory()/agents/` 目录自动发现并加载（见 [§ 10](#10-启动时自动加载)）
- **统一注册**：`ApplicationRegistry.loadAvailableAgents()` 收集所有应用的 `getAgents()` 返回值，再交给 `AgentRegistry`
- **权限继承**：CustomAgent 不设置独立权限限制，继承父任务的标准权限级别
- **MCP 复用**：CustomAgent 不创建 MCP client；AgentOffice 将配置注册到 MCPMgr，由 MCPMgr 统一连接、调用和清理
- **可清理**：提供 `dispose()` 方法注销 SkillProvider；MCP 连接生命周期归 MCPMgr 管理

### 1.3 在 Agent 系统中的位置

| Agent            | agentId                  | agentType  | dispatchable | 权限       |
| ---------------- | ------------------------ | ---------- | ------------ | ---------- |
| MainAgentDecl    | `main`                   | `builtin`  | 否           | 多模式     |
| ExploreAgentDecl | `explore`                | `builtin`  | 是           | 只读       |
| PlanAgentDecl    | `plan`                   | `builtin`  | 是           | 只读       |
| **CustomAgent**  | `agentoffice:{名称}`     | `'custom'` | 是           | 继承父任务 |
| Staff Agent      | `agentoffice:staff:{id}` | `'custom'` | 否           | Staff 权限 |

所有 Agent（包括 main 和 Staff）都注册到 `AgentRegistry`。只有 `dispatchable=true` 的 Agent
会被列入 `getAgentFrontmatterXml()` 并可通过 `createSubTask(agentName=...)` 调用。

---

## 2. 目录结构

```
my-agent/
├── agents.md           # System prompt 指令体（必需）
├── agent.json          # 元数据：name, when_to_use（可选）
├── mcp.json            # MCP 服务器配置（可选）
└── skills/             # 私有技能目录（可选）
    ├── my-skill/
    │   └── SKILL.md
    └── another-skill/
        ├── SKILL.md
        ├── .env
        └── scripts/
```

### 2.1 必需与可选文件

| 文件         | 必需 | 说明                                                                             |
| ------------ | ---- | -------------------------------------------------------------------------------- |
| `agents.md`  | 是   | Agent 的核心系统提示词内容                                                       |
| `agent.json` | 否   | Agent 元数据。缺失时从目录名推断 `name`，从 `agents.md` 第一行推断 `when_to_use` |
| `mcp.json`   | 否   | MCP 服务器配置。缺失或解析失败时不加载 MCP                                       |
| `skills/`    | 否   | 私有技能目录。缺失时不加载技能                                                   |

### 2.2 与 AgentOffice Staff 的目录对齐

AgentOffice Staff 的 `agent/` 子目录结构与 CustomAgent 的配置目录完全一致：

```
# AgentOffice Staff 目录
staffs/{staffId}/
├── staff.json              # Staff 定义（Staff 层级元数据）
├── agent/                  # ← 此子目录可直接作为 CustomAgent 的配置目录
│   ├── agents.md           # 与 CustomAgent 的 agents.md 相同
│   ├── mcp.json            # 与 CustomAgent 的 mcp.json 相同
│   ├── portrait.png        # Staff 专属（CustomAgent 忽略）
│   └── skills/             # 与 CustomAgent 的 skills/ 相同
├── resources/
├── protected/
└── workspace/
```

因此 `CustomAgent.loadFromPath(staffDir + '/agent')` 可以直接加载 Staff 的 agent 配置。

---

## 3. 文件格式

### 3.1 agent.json

Agent 元数据文件，使用 JSON 格式。

**Schema：**

```typescript
{
    name: string; // Agent 在所属应用作用域内的名称，是完整 agentId 的一部分
    when_to_use: string; // 使用场景描述，注入到 system prompt 的可派发 agent 列表中供 LLM 选择
}
```

**示例：**

```json
{
    "name": "code-reviewer",
    "when_to_use": "专注于代码审查的 agent。当需要检查代码质量、发现潜在 bug、审查 PR 变更时使用。"
}
```

**推断规则（agent.json 缺失时）：**

| 字段          | 推断来源                                           |
| ------------- | -------------------------------------------------- |
| `name`        | 配置目录的目录名（`path.basename(dir)`）           |
| `when_to_use` | `agents.md` 第一行文本，去除 Markdown 标题前缀 `#` |

### 3.2 agents.md

Agent 的核心系统提示词内容，使用 Markdown 格式。内容将作为 agent 的 system prompt 主体注入到任务中。

**示例：**

```markdown
# Code Reviewer

你是一个代码审查专家。你的职责是：

1. 检查代码质量和可维护性
2. 发现潜在的 bug 和安全问题
3. 审查代码风格和命名规范
4. 提出改进建议

## 工作流程

- 先阅读完整代码变更
- 按严重程度分类问题（阻断 / 警告 / 建议）
- 给出具体的修改建议和代码示例
```

### 3.3 mcp.json

MCP 服务器配置，使用 JSON 格式。`servers` 数组中的每个元素是一个 `McpServerConfig` 对象。

**Schema：**

```typescript
{
    servers: McpServerConfig[]
}

// McpServerConfig
{
    id: string;                              // 服务器唯一标识
    name: string;                            // 服务器显示名称
    transport: 'stdio' | 'sse' | 'streamableHttp';  // 传输方式
    enabled: boolean;                        // 是否启用
    command?: string;                        // stdio 传输时执行的命令
    args?: string[];                         // stdio 传输时的命令行参数
    cwd?: string;                            // stdio 传输时的工作目录
    url?: string;                            // sse/streamableHttp 传输时的服务端 URL
    env?: Record<string, string>;            // stdio 传输时的环境变量
    headers?: Record<string, string>;        // sse/streamableHttp 传输时的请求头
}
```

**示例：**

```json
{
    "servers": [
        {
            "id": "github",
            "name": "GitHub",
            "transport": "stdio",
            "enabled": true,
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {
                "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
            }
        },
        {
            "id": "web-search",
            "name": "Web Search",
            "transport": "sse",
            "enabled": true,
            "url": "https://mcp.example.com/sse"
        }
    ]
}
```

**说明：**

- `enabled: false` 的服务器不会被加载
- `mcp.json` 缺失或解析失败时不影响 agent 加载，仅跳过 MCP
- stdio 传输的 `cwd` 缺失时使用任务工作空间目录
- 环境变量会与全局环境变量和解释器隔离环境变量（UV_CACHE_DIR / PIP_TARGET / NPM_CONFIG_PREFIX 等）合并

### 3.4 skills/

私有技能目录，每个子目录为一个 Skill，需包含 `SKILL.md` 文件。格式遵循 [Agent Skills 开放标准](./skill_spec.md)。

**目录结构：**

```
skills/
├── my-skill/
│   ├── SKILL.md          # 必需，YAML frontmatter + Markdown 正文
│   ├── .env              # 可选，技能环境变量
│   ├── scripts/          # 可选，技能脚本
│   └── references/       # 可选，技能引用资料
└── another-skill/
    └── SKILL.md
```

**SKILL.md 格式：**

```markdown
---
name: my-skill
description: A skill that does something useful.
---

# My Skill

Instructions for the skill...
```

**说明：**

- 无效的 `SKILL.md` 会被跳过并记录警告，不影响其他技能的加载
- 加载的技能会注册到 `SkillRegistry`，bundleName 为 `custom:{配置目录绝对路径}`
- 技能自动出现在使用此 agent 的任务的 system prompt 技能列表中

---

## 4. 加载与注册

### 4.1 加载 API

```typescript
import { CustomAgent } from './applications/agentoffice/custom-agent.js';

// 从目录加载
const agent = await CustomAgent.loadFromPath('/path/to/my-agent');

// 正常启动流程由 AgentOfficeApplication.getAgents() 和
// ApplicationRegistry.loadAvailableAgents() 完成收集与注册。
```

### 4.2 加载流程

```
loadFromPath(dir)
  │
  ├── 读取 agents.md（必需，缺失或为空时抛出错误）
  │
  ├── 读取 agent.json（可选）
  │   ├── 存在 → 用 Zod schema 校验，提取 name 和 when_to_use
  │   └── 不存在 → 从目录名推断 name，从 agents.md 第一行推断 when_to_use
  │
  ├── 读取 mcp.json（可选）
  │   ├── 存在且为合法 JSON → 保留原始配置，等待 MCPMgr 校验
  │   └── 不存在或 JSON 解析失败 → mcpConfig = { servers: [] }
  │
  ├── 扫描 skills/ 目录（可选）
  │   ├── 遍历子目录，解析每个 SKILL.md
  │   ├── 设置 skill.directory 为技能目录路径
  │   └── 无效的 SKILL.md 被跳过
  │
  ├── 注册 SkillProvider（如有技能）
  │   └── SkillRegistry.registerSkillProvider(`custom:{name}`, provider)
  │
  └── 返回 CustomAgent 实例
```

### 4.3 资源清理

```typescript
// 不再使用时清理资源
await agent.dispose();
```

`dispose()` 执行以下操作：

- 注销 SkillProvider（从 SkillRegistry 移除）

MCP server 的替换、断开和工具刷新由 MCPMgr worker 统一处理。

### 4.4 Agent 与 Application 扩展点

```typescript
export abstract class AgentDecl {
    /** Agent 在作用域内的名称 */
    abstract readonly agentName: string;

    /** 规范 ID：内置 Agent 为 {agentName}，应用 Agent 为 {bundleName}:{agentName} */
    get agentId(): string;

    /** 是否可作为通用子任务执行者 */
    abstract readonly dispatchable: boolean;

    /** 返回此 Agent 支持的模式 */
    abstract supportedModes(): ModeDecl[];

    /** 返回默认模式；默认 mode id 是 AgentDecl 的内部实现细节 */
    getDefaultMode(): ModeDecl;

    /** 释放 Agent 自身持有的资源 */
    async dispose(): Promise<void> {
        // 默认空实现
    }
}

export abstract class BaseApplication {
    async getAgents(): Promise<AgentDecl[]> {
        return [];
    }
}
```

`ApplicationRegistry.loadAvailableAgents()` 先卸载旧的应用 Agent，再按应用 `bundleName` 收集并注册
`getAgents()` 的结果。主 Agent 通过始终返回非空声明的 `getMainAgent()` 获取；其他声明通过
`getBuiltinAgent(agentName)` 或
`getApplicationAgent(bundleName, agentName)` 获取声明；AIKernel 内部可以直接使用完整 agentId。
任务派发时把 `agentDecl.agentId` 写入 `TaskState.agentId`，供 prompt 重建及工具、Skill 过滤使用。
任务 JSON 持久化 `agentId`，旧任务缺失时使用 `main`；若恢复时找不到绑定的 Agent，也回退到
`main`。内置 Agent 的规范 ID 是不带作用域的 `agentName`，应用 Agent 的规范 ID 是
`<bundleName>:<agentName>`；不再解析其他历史 Agent 引用格式。`agent_system_prompt` 是运行时派生状态，重建它不触发
dirty；`custom_system_prompt` 是任务的持久化数据，没有附加提示词时落盘为 `null`。完整的
`chat_context.system_prompt` 仍然落盘，
用于保持旧格式兼容并方便调试。

`AgentRegistry` 只负责 Agent 的注册、查找和外部引用解析，不负责解释 Task 或创建 system prompt。
`TaskState` 通过 `getAgent()` 获取自身绑定，通过 `getAgentMode()` 解析自身的 `activeModeId`，并由
`buildSystemPrompt()` 调用该 Agent 的 `createSystemPrompt()`。因此调用方无需传递 Agent 或 Mode。

`main` 在顶层任务中生成完整主 Agent prompt；在带 `parent_id` 的默认子任务中重建通用
子任务 prompt。这样，缺少 `agentId` 的旧子任务仍可按 `main` 恢复，同时保留原有执行语义。

---

## 5. System Prompt 生成

普通重建入口是 `TaskState.rebuildSystemPrompt()`；它通过纯构建方法 `buildSystemPrompt()`，根据任务
自己的 `agentId` 和 `activeModeId` 获取 `AgentDecl` 与 `ModeDecl`，调用
`agent.createSystemPrompt(activeMode, taskCtx)` 生成 `agent_system_prompt`，再与持久化的
`custom_system_prompt` 拼接并安装到 ChatContext。`setSystemPrompt()` 只修改
`custom_system_prompt`。显式使用 `agentId: null` 的任务没有 Agent 部分，其完整 system prompt
仅由 custom 部分组成；旧任务缺少 `agentId` 字段时仍恢复为 `main`。
Agent 的实现按以下顺序拼接 agent system prompt：

```
1. agents.md 内容（主体）
2. 当前日期和时间提示
3. 当前运行环境（工作目录、操作系统、执行节点等）
4. attemptCompletion 提示（子任务必须通过此工具返回结果）
5. AGENTS.md 指令（工作空间和用户级，如果存在）
```

Skills 的 frontmatter 不在此处直接注入，而是通过 `SkillRegistry.getSkillFrontmatterXml()` 在 system prompt 的技能列表中自动展示。

---

## 6. MCP 服务器支持

### 6.1 注册与连接流程

```
AgentOfficeApplication.getAgents()
  │
  ├── 加载 CustomAgent，agentId = agentoffice:{agentName}
  ├── 收集每个 agent 的 mcpConfig
  └── McpMgrApplication.replaceAgentServers(...)
      │
      ├── 用 MCPMgr 的 schema 校验并过滤禁用配置
      ├── 为 server 标记 agentIds: [agentId]
      └── MCPMgr worker 创建 transport/client、发现工具并执行调用
  │
  └── McpMgrApplication.getToolsets()
      └── 返回带 agentIds 的 MCPTool
```

### 6.2 工具命名

MCP 工具名格式为 `{serverName}__{toolName}`，其中 serverName 中的非字母数字字符替换为 `_`。
为避免不同 CustomAgent 使用同名 server 时互相覆盖，agent 专属工具会在 serverName 后追加稳定的
server ID 短后缀；MCPMgr 界面仍显示配置中的原始 serverName。

### 6.3 工具调用

当 LLM 调用 MCP 工具时，通过 `client.callTool({ name, arguments })` 执行，返回结果中的 text 类型内容会被提取并拼接为字符串返回。

### 6.4 Agent 工具可见性

`BaseTool.agentIds?: readonly string[]` 定义工具暴露范围：

- `undefined`：不限制 Agent，兼容所有既有应用工具和通用 MCP
- 非空数组：仅 `TaskState.agentId` 在数组中的任务可见
- 空数组：不向任何 Agent 暴露

过滤发生在 `buildToolsetsForTask()`，因此工具在进入 ChatContext 和模型 tool definitions 前就已被移除。

### 6.5 传输方式

| 传输             | 适用场景                    | 配置要求                                  |
| ---------------- | --------------------------- | ----------------------------------------- |
| `stdio`          | 本地命令行工具              | `command`, `args` 必需；`cwd`, `env` 可选 |
| `sse`            | Server-Sent Events 远程服务 | `url` 必需；`headers` 可选                |
| `streamableHttp` | HTTP 流式远程服务           | `url` 必需；`headers` 可选                |

stdio 传输会自动合并全局环境变量和解释器隔离环境变量，确保 `uvx`、`npx` 等命令有可写的缓存目录。sse 和 streamableHttp 传输支持系统代理。

---

## 7. Skills 支持

### 7.1 注册机制

CustomAgent 在构造时将加载的技能注册为 `SkillProvider`：

- **bundleName**: 通用 CustomAgent 使用 `custom:{配置目录绝对路径}`；Staff 使用 `staff:{staffId}`
- **Provider**: `CustomAgentSkillProvider`，实现 `getSkills(): Promise<Skill[]>` 接口

每个私有 Skill 都带有 `agentIds: [agentId]`。只有当前 `TaskState.agentId` 匹配时，技能才会
出现在 system prompt 或用户可调用技能列表中，也只有匹配的任务才能通过 `LoadSkillTool`
和 `CallSkillTool` 读取或调用它。

### 7.2 技能目录扫描

```
skills/
├── my-skill/          → 扫描 SKILL.md → Skill.parseMd() → skill.directory = skills/my-skill
├── bad-skill/         → SKILL.md 解析失败 → 跳过，记录警告
└── not-a-skill.txt    → 非目录 → 跳过
```

### 7.3 生命周期

- **注册时机**：CustomAgent 构造时（如果有技能）
- **注销时机**：`dispose()` 调用时
- **缓存**：SkillRegistry 内部缓存技能，CustomAgent 注销时清除对应 bundleName 的缓存

---

## 8. 权限模型

### 8.1 Mode 权限

CustomAgent 使用单一 `default` mode，`permissionFactory` 返回 `createDefaultPermissionRules(workspace)`，与 Standard mode 一致：

- 工作空间内文件读写执行 → allow
- 工作空间外文件读写执行 → ask（隐式回退）
- 敏感路径（.ssh、.gnupg 等）→ ask（显式保护）
- 网络访问 → ask（隐式回退）
- 技能读取 → allow

### 8.2 父任务权限继承

在 `startSubTask` 中，当 `agentDecl.agentType === 'custom'` 时，从父任务继承本 turn 生效的 `permissionPrompt`：

```typescript
if (agentDecl.agentType === 'custom') {
    subTask.harnessContext.permissionPrompt = parentTask.getActivePermissionPrompt();
}
```

这确保 ask 权限能正常交互确认（如弹出 UI 确认对话框），而非自动拒绝。用 `getActivePermissionPrompt()` 而不是直接读字段，是为了让渠道 turn 里起的子任务把审批继续发给渠道用户。Builtin agent（explore/plan）不继承 permissionPrompt，ask 请求自动拒绝。

### 8.3 工具过滤

CustomAgent 的 default mode 设置 `disabledTools: ['exitPlanMode']`，与 Standard mode 一致。子任务不需要 plan mode 退出工具。

---

## 9. 与 AgentOffice Staff 的关系

### 9.1 格式兼容

CustomAgent 的配置目录格式与 AgentOffice Staff 的 `agent/` 子目录完全对齐。Staff 的 `agent/` 子目录可直接作为 CustomAgent 的配置目录使用：

```typescript
const agent = await CustomAgent.loadFromPath(`${staffDir}/agent`);
```

Staff 的 `agent/` 子目录包含 `agents.md`、`mcp.json`、`skills/`，这些文件都能被 CustomAgent 正确加载。Staff 没有的 `agent.json` 文件，CustomAgent 会从目录名推断元数据。

### 9.2 功能差异

| 能力               | AgentOffice Staff                         | CustomAgent                             |
| ------------------ | ----------------------------------------- | --------------------------------------- |
| agents.md 注入方式 | 作为 system prompt 主体                   | 作为 system prompt 主体                 |
| MCP 服务器连接     | 由 MCPMgr 自动连接并按 agentId 注入工具   | 由 MCPMgr 自动连接并按 agentId 注入工具 |
| Skills 加载        | 注册为 staff:{staffId} 私有 Provider      | 注册为 custom:{agentId} 私有 Provider   |
| 权限模型           | StaffPermissionEnforcer (deny-by-default) | 继承父任务标准权限                      |
| 任务创建           | AgentOffice 直接分配，注册但不可派发      | 通过 createSubTask                      |
| 消息历史           | 持久化到 messages.jsonl                   | 通过 attemptCompletion 返回             |

### 9.3 互补定位

- **AgentOffice Staff**：面向数字员工场景，提供独立的对话界面、消息历史、权限隔离和资源管理
- **CustomAgent**：面向子任务场景，提供按需加载的 agent 能力，可在 `createSubTask` 中被 LLM 自动选择

AgentOffice 同时负责两类配置的加载：`agents/` 下的通用 CustomAgent 和 Staff Agent 都返回给
`AgentRegistry`；Staff Agent 以 `dispatchable=false` 注册，并由 AgentOffice 直接分配给对应任务。
两者共用 CustomAgent 文件加载、SkillRegistry 注册以及 MCPMgr 连接链路。

---

## 10. 启动时自动加载

### 10.1 扫描目录

应用启动时，`AgentOfficeApplication.getAgents()` 会扫描 `getOpendeskDirectory()/agents/`
目录，将每个子目录作为可派发的 CustomAgent 配置目录加载；同时扫描 AgentOffice 数据目录中
已启用 Staff 的 `agent/` 目录；两者都会作为返回值进入 `AgentRegistry`，仅前者可派发：

```
{getOpendeskDirectory()}/agents/
├── code-reviewer/        # → CustomAgent.loadFromPath(".../agents/code-reviewer")
│   ├── agents.md
│   └── agent.json
├── doc-writer/           # → CustomAgent.loadFromPath(".../agents/doc-writer")
│   └── agents.md
└── test-runner/          # → CustomAgent.loadFromPath(".../agents/test-runner")
    ├── agents.md
    ├── agent.json
    ├── mcp.json
    └── skills/
```

### 10.2 加载时机

在所有启动入口中，先初始化应用和 MCPMgr worker，再调用 `ApplicationRegistry.loadAvailableAgents()`。
恢复任务的 lazy harness 和任何可执行任务的入口必须排在应用 Agent 注册之后，避免把尚未加载的合法
应用 agentId 误判为缺失：

| 启动入口       | 文件                                               | 调用位置                   |
| -------------- | -------------------------------------------------- | -------------------------- |
| Electron GUI   | `src/main/main.ts`                                 | `app.whenReady()` 启动序列 |
| CLI (headless) | `src/main/cli.ts`                                  | headless 命令模式启动      |
| CLI (TUI)      | `src/main/cli.ts`                                  | TUI 交互模式启动           |
| Server         | `src/main/tui/subcommands/serve.ts`                | serve 子命令启动           |
| Skill 测试     | `src/main/applications/skillmgr/skill-test-cli.ts` | skill-test CLI 启动        |

### 10.3 错误处理

- 目录不存在时静默跳过（不报错）
- 单个 agent 加载失败时记录警告，不影响其他 agent 的加载
- 同一应用作用域内出现重复 agentName 时跳过后注册项并记录警告

### 10.4 刷新 API

```typescript
// 重新收集应用提供的 Agent；内部先 dispose 旧 Agent。
// AgentOffice 同时原子替换 MCPMgr 中的 agent 专属 server。
await ApplicationRegistry.loadAvailableAgents();
```

后续可基于文件监听或 UI 手动触发该 API 实现热刷新。
