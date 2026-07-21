# AgentOffice 数字员工技术规格

> 本文档定义了 AgentOffice 数字员工（Staff）的完整技术规范，包括目录结构、文件格式、权限模型、任务流程和预设员工。AgentOffice 是 OpenDesk 的数字员工管理应用，为每个 Staff 提供独立的对话界面、消息历史、权限隔离和资源管理。

## 目录

1. [概述](#1-概述)
2. [目录结构](#2-目录结构)
3. [文件格式](#3-文件格式)
4. [权限模型](#4-权限模型)
5. [任务流程](#5-任务流程)
6. [预设员工](#6-预设员工)
7. [导入与导出](#7-导入与导出)
8. [Agent 配置](#8-agent-配置)

---

## 1. 概述

### 1.1 什么是数字员工

**数字员工（Staff）** 是 AgentOffice 中的独立 AI 工作者。每个 Staff 拥有：

- 独立的身份信息（名称、职位、专长）
- 独立的工作空间和资源目录
- 独立的权限配置（文件访问范围、网络访问）
- 独立的指令文件（agents.md）
- 独立的 MCP 服务器配置
- 独立的私有技能目录
- 独立的消息历史和任务记录
- 可选的专属模型和头像

### 1.2 与 Agent 系统的关系

Staff 使用 `MainAgentDecl`（standard mode）作为底层 agent，但在其基础上叠加了：

- Staff 专属的 `agents.md` 指令（注入到 system prompt）
- Staff 专属的权限隔离（`StaffPermissionEnforcer`）
- AgentOffice 专用工具集（`sendReply`、`getHistoryMessages`）
- 持久化的消息历史（`messages.jsonl`）

Staff 的 `agent/` 子目录格式与 [CustomAgent 规格](./agent_spec.md)对齐，可直接被 `CustomAgent.loadFromPath()` 加载。

---

## 2. 目录结构

### 2.1 存储位置

```
{appDataDirectory}/staffs/{staffId}/
```

- `appDataDirectory`：AgentOffice 应用数据目录
- `staffId`：UUID v4 格式的唯一标识符

### 2.2 完整目录结构

```
staffs/{staffId}/
├── staff.json                    # Staff 定义（身份信息）
├── agent/                        # Agent 配置目录（格式参见 agent_spec.md）
│   ├── agents.md                 # Staff 指令文件
│   ├── mcp.json                  # MCP 服务器配置
│   ├── portrait.png              # 头像图片（可选）
│   └── skills/                   # 私有技能目录
│       └── {skillName}/
│           └── SKILL.md
├── resources/                    # 用户上传的附件资源
├── protected/                    # 受保护数据（Agent 不可直接访问）
│   ├── metadata.json             # Staff 元数据
│   ├── permission.json           # 权限配置
│   ├── tasks.json                # 任务记录列表
│   └── messages.jsonl            # 消息历史（每行一条 JSON）
└── workspace/                    # Staff 专属工作空间
```

### 2.3 目录访问权限

| 目录 | Agent 访问 | 说明 |
|------|-----------|------|
| `agent/` | 读取 | Agent 可读取指令和技能，但不能修改 |
| `resources/` | 读取 | Agent 可读取用户上传的附件 |
| `workspace/` | 读写执行 | Agent 的工作空间，可自由读写 |
| `protected/` | 禁止访问 | 元数据、权限、任务记录、消息历史均受保护 |

---

## 3. 文件格式

### 3.1 staff.json

Staff 的身份定义文件。

**Schema：**

```typescript
{
    name: string;           // 员工名称（必填，非空）
    vendor_name: string;    // 供应商名称（必填，非空）
    title: string;          // 职位头衔（必填，非空）
    specialties: string[];  // 专长列表（默认空数组）
}
```

**示例：**

```json
{
    "name": "Avery",
    "vendor_name": "OpenDesk",
    "title": "Research Analyst",
    "specialties": [
        "Information retrieval",
        "Industry research",
        "Analysis reports"
    ]
}
```

### 3.2 agent/agents.md

Staff 的核心指令文件，定义员工的角色、工作方式和行为规范。格式为 Markdown。

**默认内容（创建时）：**

```markdown
# Digital employee instructions

Describe this employee's role and working style here.
```

**预设员工示例（Research Analyst）：**

```markdown
# Research Analyst

You specialize in research, fact-checking, and structured analysis. Confirm the objective and scope first, gather reliable information, call out uncertainty, and report clear conclusions, evidence, and recommendations.
```

### 3.3 agent/mcp.json

Staff 专属的 MCP 服务器配置。

**Schema：**

```json
{
    "servers": []
}
```

`servers` 数组中的元素格式参见 [agent_spec.md § 3.3](./agent_spec.md#33-mcpjson)。

**默认内容（创建时）：**

```json
{
    "servers": []
}
```

### 3.4 protected/metadata.json

Staff 的运行时元数据，不受 Agent 直接控制。

**Schema：**

```typescript
{
    id: string;                  // 与目录名一致的 UUID
    hired_at: string;            // 创建时间（ISO 8601）
    enabled: boolean;            // 是否启用
    model?: string;              // 专属模型别名（可选）
    usage_summary?: TaskUsageSummary;  // 累计 token 使用统计
}
```

**示例：**

```json
{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "hired_at": "2026-07-20T10:00:00.000Z",
    "enabled": true
}
```

### 3.5 protected/permission.json

Staff 的权限配置，控制 Agent 可访问的文件范围和网络权限。

**Schema：**

```typescript
{
    directories: {
        path: string;                    // 目录绝对路径
        access: 'read' | 'readwrite';    // 访问级别
    }[];
    network_access: boolean;             // 是否允许网络访问
}
```

**默认内容（创建时）：**

```json
{
    "directories": [],
    "network_access": true
}
```

**示例：**

```json
{
    "directories": [
        { "path": "/home/user/Documents", "access": "read" },
        { "path": "/home/user/Projects", "access": "readwrite" }
    ],
    "network_access": true
}
```

### 3.6 protected/tasks.json

Staff 的任务记录列表。

**Schema：**

```typescript
[
    {
        task_id: string;              // 任务 ID
        message_ids: string[];        // 关联的消息 ID 列表
        status: string;               // 'running' | 'stopped' | 'waiting'
        created_at: string;           // 创建时间（ISO 8601）
        updated_at: string;           // 更新时间（ISO 8601）
        usage_summary?: TaskUsageSummary;  // token 使用统计
    }
]
```

**默认内容（创建时）：** `[]`

### 3.7 protected/messages.jsonl

Staff 的消息历史，每行一条 JSON 消息。

**消息 Schema：**

```typescript
{
    id: string;                    // 消息唯一 ID
    role: 'user' | 'assistant';    // 发送角色
    task_id: string;               // 关联的任务 ID
    created_at: string;            // 创建时间（ISO 8601 datetime）
    status?: 'sent' | 'failed';    // 发送状态
    kind?: 'message' | 'error';    // 消息类型
    content: Content[];            // 内容块数组
}

// Content 类型
{ type: 'text', text: string }
| { type: 'resource', resource_id: string, media_type: 'image' | 'video' | 'audio' | 'file', mime_type: string, name: string, path: string }
```

**示例（每行一条）：**

```jsonl
{"id":"msg-1","role":"user","task_id":"abc123","created_at":"2026-07-20T10:00:00.000Z","status":"sent","kind":"message","content":[{"type":"text","text":"分析最近的行业趋势"}]}
{"id":"msg-2","role":"assistant","task_id":"abc123","created_at":"2026-07-20T10:01:00.000Z","status":"sent","kind":"message","content":[{"type":"text","text":"根据分析..."}]}
```

**默认内容（创建时）：** 空文件

### 3.8 agent/skills/

Staff 的私有技能目录。每个子目录为一个 Skill，需包含 `SKILL.md` 文件。格式遵循 [Skill 技术规格](./skill_spec.md)。

Staff 的 `agent/` 子目录格式与 [CustomAgent 规格的目录结构](./agent_spec.md#2-目录结构)完全一致。

---

## 4. 权限模型

### 4.1 StaffPermissionEnforcer

Staff 使用 `createStaffPermissionEnforcer()` 创建专属的权限执行器，基于 `GlobPermissionEnforcer` 并包装为 deny-by-default 模式。

**权限规则生成：**

| 资源 | 操作 | 路径 | 判定 |
|------|------|------|------|
| file | * | `protected/` 及子路径 | deny（始终拒绝） |
| file | read | `workspace/` 及子路径 | allow |
| file | write | `workspace/` 及子路径 | allow |
| file | execute | `workspace/` 及子路径 | allow |
| file | read | `resources/` 及子路径 | allow |
| skill | read | ** | allow |
| network | access | ** | allow（如果 network_access=true）/ deny（如果 false） |
| file | read | permission.directories 中 access=read 的路径 | allow |
| file | read/write | permission.directories 中 access=readwrite 的路径 | allow |

### 4.2 Deny-by-default

对于未匹配任何 allow 规则的请求，`DenyByDefaultPermissionEnforcer` 会将 `ask` 结果转换为 `deny`，确保 Staff Agent 不能访问未明确授权的资源。

### 4.3 符号链接解析

权限检查前会通过 `resolveThroughSymlinks()` 解析符号链接，防止通过符号链接绕过路径限制。

### 4.4 与 CustomAgent 权限模型的对比

| 特性 | Staff | CustomAgent |
|------|-------|-------------|
| 权限引擎 | StaffPermissionEnforcer (deny-by-default) | createDefaultPermissionRules (standard) |
| 工作空间 | Staff 专属 workspace/ 目录 | 继承父任务工作空间 |
| 外部目录 | 需在 permission.json 中显式声明 | ask（可通过 permissionPrompt 确认） |
| 网络访问 | 可配置（permission.network_access） | ask（隐式回退） |
| protected 目录 | 始终 deny | 不适用 |

---

## 5. 任务流程

### 5.1 发送消息

```
sendMessage(staffId, input)
  │
  ├── 获取 Staff 详情（验证 enabled 状态）
  ├── 获取或创建任务（复用 running 任务或创建新任务）
  ├── 初始化 workspace 和 harness
  │   ├── 创建 MainAgentDecl，使用 standard mode
  │   └── taskManager.initHarness(task, workspace, mode)
  ├── 设置 Staff 专属权限
  │   └── task.harnessContext.permission = createStaffPermissionEnforcer(...)
  ├── 附加 AgentOffice 工具集
  │   └── task.attachToolset(createAgentOfficeTaskToolset(...))
  │       ├── sendReply 工具：将回复写入 messages.jsonl
  │       └── getHistoryMessages 工具：查询历史消息
  ├── 生成 system prompt
  │   ├── agent.createSystemPrompt(mode, task)
  │   └── 追加 Office 交付规则
  ├── 准备用户消息（文本 + 附件 + 图片）
  └── 提交消息，任务开始执行
```

### 5.2 任务复用

当 Staff 有一个 `running` 状态的任务时，新消息会复用该任务，保持对话上下文连续。如果当前任务已停止，则创建新任务。

### 5.3 任务监控

```
monitorTaskTurn(task, staffId, replyTask)
  │
  ├── 监听 assistant 回复
  │   └── 通过 sendReply 工具将回复写入 messages.jsonl
  ├── 任务完成后更新 tasks.json 和 metadata.json
  └── 更新 usage_summary（token 使用统计）
```

### 5.4 AgentOffice 工具集

Staff 任务附加了两个专属工具：

| 工具 | 功能 |
|------|------|
| `sendReply` | Agent 通过此工具发送回复消息，消息被写入 `messages.jsonl` 并通知前端 |
| `getHistoryMessages` | Agent 查询历史消息，支持按数量或时间范围检索 |

---

## 6. 预设员工

AgentOffice 在首次启动时通过 `ensurePresetStaffs()` 自动安装预设员工。预设状态记录在 `preset-staffs.json` 中，避免重复安装。

### 6.1 内置预设

| key | name | title | specialties |
|-----|------|-------|-------------|
| `research-analyst-v1` | Avery | Research Analyst | Information retrieval, Industry research, Analysis reports |
| `project-planner-v1` | Parker | Project Planner | Task planning, Project management, Risk assessment |
| `content-writer-v1` | Casey | Content Writer | Copywriting, Content editing, Communication |

### 6.2 预设格式

```typescript
interface PresetStaffDefinition {
    key: string;                    // 预设唯一标识
    definition: StaffDefinition;    // Staff 身份定义
    agents_md: string;              // 预设的指令内容
}
```

### 6.3 安装逻辑

- 读取 `preset-staffs.json` 中的已安装列表
- 对未安装的预设调用 `createStaff(definition, agents_md)`
- 更新已安装列表
- 已安装的预设不会被覆盖

---

## 7. 导入与导出

### 7.1 导出

Staff 可导出为 ZIP 包，包含：

- `staff.json`：身份定义
- `agent/` 目录：完整的 agent 配置（agents.md、mcp.json、skills/）

```typescript
exportStaff(staffId, zipPath): string
```

### 7.2 导入

从 ZIP 包导入 Staff：

- ZIP 包必须包含 `staff.json` 和 `agent/` 目录
- 解析 `staff.json` 创建新 Staff（生成新的 staffId）
- 将 `agent/` 目录内容复制到新 Staff 的 `agent/` 目录

```typescript
importStaff(zipPath): StaffDetail
```

---

## 8. Agent 配置

Staff 的 `agent/` 子目录是 Agent 配置的核心部分，包含指令、MCP 配置和技能。其格式与 [CustomAgent 技术规格](./agent_spec.md)中定义的目录结构完全一致。

关于 `agents.md`、`mcp.json`、`skills/` 的详细格式定义，请参阅 [agent_spec.md](./agent_spec.md) 的以下章节：

- [§ 3.2 agents.md](./agent_spec.md#32-agentsmd)
- [§ 3.3 mcp.json](./agent_spec.md#33-mcpjson)
- [§ 3.4 skills/](./agent_spec.md#34-skills)

### 8.1 当前状态与展望

当前 AgentOffice Staff 对 `agent/` 子目录中的 MCP 和 Skills 配置仅做存储和 UI 管理，尚未实现自动连接和注入。后续计划通过集成 CustomAgent 的加载机制来实现：

```typescript
// 未来可能的集成方式
const agent = await CustomAgent.loadFromPath(`${staffDir}/agent`);
// MCP 服务器自动连接，Skills 自动注册
```

这将使 Staff 获得 CustomAgent 已实现的 MCP 工具注入和 Skills 自动注册能力。
