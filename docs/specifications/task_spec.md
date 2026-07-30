# OpenDesk Task Specification

## 目录

1. [概述](#概述)
2. [Task 核心数据结构](#task-核心数据结构)
3. [Task 序列化格式](#task-序列化格式)
4. [JSON Schema 定义](#json-schema-定义)
5. [完整示例](#完整示例)
6. [Task 状态与生命周期](#task-状态与生命周期)
7. [嵌套数据结构](#嵌套数据结构)
8. [字段说明](#字段说明)

---

## 概述

OpenDesk 中的 Task 是对话任务的核心抽象，每个 Task 代表一个独立的 AI 对话会话。Task 数据通过 JSON 格式持久化到磁盘，存储在 `tasks/` 目录下。

### 存储结构

```
<app_data_dir>/
└── tasks/
    ├── task_list.json          # Task 列表摘要
    └── <task_id>.json          # 每个 Task 的完整数据
```

- **task_list.json**: 包含所有 Task 的简化摘要（不含聊天上下文）
- **<task_id>.json**: 每个 Task 的完整序列化数据

---

## Task 核心数据结构

### 内部类型 (TypeScript)

```typescript
type TaskStatus = 'waiting' | 'running' | 'stopped';
type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

class TaskState {
    task_id: string; // 格式: task_<timestamp>_<random>
    parent_id: string | null; // 父任务 ID，null 表示主任务
    task_name: string | null; // 用户定义的任务名称
    task_status: TaskStatus; // 任务状态
    chat_context: ChatContext; // 对话上下文
    tool_result_replacement_state: ToolResultReplacementState; // 工具结果替换状态
    auto_compact_state: AutoCompactState; // 自动压缩熔断状态

    // 可选字段
    model?: string; // LLM 模型名称
    reasoningEffort?: ReasoningEffort; // 推理力度
    agentId?: string; // 绑定的规范 Agent ID；显式无 Agent 时为 undefined
    agent_system_prompt?: string; // 由 Agent/Mode 派生，不单独触发落盘
    custom_system_prompt?: string; // setSystemPrompt() 设置的持久化附加提示词

    // 不参与序列化
    harnessContext: HarnessContext;
    activeModeId?: string;
    disabledTools?: string[];
    message_queue: string[];

    // 执行状态
    stop_requested_by_user: boolean;
    started_at?: Date;
    finished_at?: Date;
    total_elapsed_ms: number;
    bookmark_path?: string;
    origin?: Participant;

    getAgent(): AgentDecl;
    getAgentMode(): ModeDecl;
    buildSystemPrompt(): Promise<string>;
    rebuildSystemPrompt(): Promise<void>;
}
```

Task 自己拥有 Agent 绑定的解释权：`getAgent()` 通过 `AgentRegistry` 解析 `agentId`，并把
失效绑定回退到主 Agent 的规范 ID；`getAgentMode()` 根据运行时 `activeModeId` 选择该 Agent 的 Mode；
`buildSystemPrompt()` 再通过二者生成 prompt。普通调用使用 `rebuildSystemPrompt()` 完成构建和安装；
只有需要原子延迟提交或二次包装 prompt 的流程才直接使用纯构建方法。`AgentRegistry` 本身不接收
Task，也不创建 prompt。

---

## Task 序列化格式

### 完整序列化 (`toJSON()`)

用于存储单个 Task 的完整数据到 `<task_id>.json` 文件。

**序列化字段（snake_case 命名）：**

| 字段                            | 类型           | 必填 | 说明                                 |
| ------------------------------- | -------------- | ---- | ------------------------------------ |
| `task_id`                       | string         | 是   | 任务唯一标识符                       |
| `parent_id`                     | string \| null | 是   | 父任务 ID                            |
| `task_name`                     | string \| null | 是   | 任务名称                             |
| `task_status`                   | string         | 是   | 任务状态                             |
| `agentId`                       | string \| null | 是   | 规范 Agent ID；null 表示显式无 Agent |
| `chat_context`                  | object         | 是   | 对话上下文                           |
| `tool_result_replacement_state` | object         | 是   | 工具结果替换状态                     |
| `auto_compact_state`            | object         | 是   | 自动压缩状态                         |
| `started_at`                    | string \| null | 是   | ISO 8601 时间戳                      |
| `finished_at`                   | string \| null | 是   | ISO 8601 时间戳                      |
| `total_elapsed_ms`              | number         | 是   | 总耗时（毫秒）                       |
| `bookmark_path`                 | string \| null | 否   | 书签路径                             |
| `origin`                        | object \| null | 否   | 任务来源（渠道发起）                 |
| `stop_requested_by_user`        | boolean        | 是   | 用户是否请求停止                     |

### 简化序列化 (`toSimplifiedJSON()`)

用于 `task_list.json`，不包含聊天上下文以减小文件体积。

**简化字段：**

| 字段                     | 类型           | 必填 | 说明             |
| ------------------------ | -------------- | ---- | ---------------- |
| `task_id`                | string         | 是   | 任务唯一标识符   |
| `parent_id`              | string \| null | 是   | 父任务 ID        |
| `task_name`              | string \| null | 是   | 任务名称         |
| `task_status`            | string         | 是   | 任务状态         |
| `started_at`             | string \| null | 是   | ISO 8601 时间戳  |
| `finished_at`            | string \| null | 是   | ISO 8601 时间戳  |
| `total_elapsed_ms`       | number         | 是   | 总耗时（毫秒）   |
| `bookmark_path`          | string \| null | 否   | 书签路径         |
| `origin`                 | object \| null | 否   | 任务来源         |
| `stop_requested_by_user` | boolean        | 是   | 用户是否请求停止 |

---

## JSON Schema 定义

### Task JSON Schema (完整版)

```json
{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "https://opendesk.org/schemas/task.json",
    "title": "OpenDesk Task",
    "description": "OpenDesk Task 完整序列化格式",
    "type": "object",
    "required": [
        "task_id",
        "parent_id",
        "task_name",
        "task_status",
        "chat_context",
        "tool_result_replacement_state",
        "auto_compact_state",
        "started_at",
        "finished_at",
        "total_elapsed_ms",
        "stop_requested_by_user"
    ],
    "properties": {
        "task_id": {
            "type": "string",
            "pattern": "^task_[a-z0-9]+_[a-z0-9]+$",
            "description": "任务唯一标识符，格式: task_<timestamp>_<random>"
        },
        "parent_id": {
            "oneOf": [{ "type": "string" }, { "type": "null" }],
            "description": "父任务 ID，null 表示主任务"
        },
        "task_name": {
            "oneOf": [{ "type": "string" }, { "type": "null" }],
            "description": "用户定义的任务名称"
        },
        "task_status": {
            "type": "string",
            "enum": ["waiting", "running", "stopped"],
            "description": "任务状态"
        },
        "chat_context": {
            "$ref": "#/definitions/ChatContext"
        },
        "tool_result_replacement_state": {
            "$ref": "#/definitions/ToolResultReplacementState"
        },
        "auto_compact_state": {
            "$ref": "#/definitions/AutoCompactState"
        },
        "started_at": {
            "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }],
            "description": "任务开始时间 (ISO 8601)"
        },
        "finished_at": {
            "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }],
            "description": "任务结束时间 (ISO 8601)"
        },
        "total_elapsed_ms": {
            "type": "number",
            "minimum": 0,
            "description": "总耗时（毫秒）"
        },
        "bookmark_path": {
            "oneOf": [{ "type": "string" }, { "type": "null" }],
            "description": "书签路径"
        },
        "origin": {
            "oneOf": [{ "$ref": "#/definitions/Participant" }, { "type": "null" }],
            "description": "任务来源（渠道发起）"
        },
        "stop_requested_by_user": {
            "type": "boolean",
            "description": "用户是否请求停止"
        }
    },
    "definitions": {
        "ChatContext": {
            "type": "object",
            "required": ["messages"],
            "properties": {
                "system_prompt": {
                    "$ref": "#/definitions/SystemMessage"
                },
                "messages": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/ChatMessage"
                    }
                }
            }
        },
        "ChatMessage": {
            "oneOf": [
                { "$ref": "#/definitions/UserMessage" },
                { "$ref": "#/definitions/AssistantMessage" },
                { "$ref": "#/definitions/CompactSeparatorMessage" }
            ]
        },
        "SystemMessage": {
            "type": "object",
            "required": ["role", "content"],
            "properties": {
                "role": {
                    "type": "string",
                    "const": "system"
                },
                "content": {
                    "type": "string",
                    "description": "系统提示词内容"
                }
            }
        },
        "UserMessage": {
            "type": "object",
            "required": ["role", "message_id", "content"],
            "properties": {
                "role": {
                    "type": "string",
                    "const": "user"
                },
                "message_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "消息唯一标识符"
                },
                "internal": {
                    "type": "boolean",
                    "description": "是否为内部消息"
                },
                "content": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/UserMessagePart"
                    }
                }
            }
        },
        "UserMessagePart": {
            "oneOf": [
                { "$ref": "#/definitions/TextMessagePart" },
                { "$ref": "#/definitions/ImageMessagePart" },
                { "$ref": "#/definitions/FileMessagePart" }
            ]
        },
        "TextMessagePart": {
            "type": "object",
            "required": ["type"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "text"
                },
                "text": {
                    "type": "string"
                },
                "rendered": {
                    "type": "string"
                }
            }
        },
        "ImageMessagePart": {
            "type": "object",
            "required": ["type", "image_url"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "image_url"
                },
                "image_url": {
                    "type": "object",
                    "required": ["url"],
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "图片 URL 或 data URI"
                        }
                    }
                },
                "rendered": {
                    "type": "string"
                }
            }
        },
        "FileMessagePart": {
            "type": "object",
            "required": ["type", "path"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "file"
                },
                "path": {
                    "type": "string",
                    "description": "文件路径"
                },
                "rendered": {
                    "type": "string"
                }
            }
        },
        "AssistantMessage": {
            "type": "object",
            "required": ["role", "message_id", "content"],
            "properties": {
                "role": {
                    "type": "string",
                    "const": "assistant"
                },
                "message_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "消息唯一标识符"
                },
                "usage": {
                    "$ref": "#/definitions/Usage"
                },
                "content": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/AssistantMessagePart"
                    }
                }
            }
        },
        "AssistantMessagePart": {
            "oneOf": [
                { "$ref": "#/definitions/TextMessagePart" },
                { "$ref": "#/definitions/ReasoningMessagePart" },
                { "$ref": "#/definitions/ToolCallMessagePart" },
                { "$ref": "#/definitions/ErrorMessagePart" }
            ]
        },
        "ReasoningMessagePart": {
            "type": "object",
            "required": ["type", "content", "source"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "reasoning"
                },
                "content": {
                    "type": "string",
                    "description": "推理内容"
                },
                "source": {
                    "type": "string",
                    "enum": ["reasoning_content", "think_tag"],
                    "description": "推理内容来源"
                },
                "rendered": {
                    "type": "string"
                }
            }
        },
        "ToolCallMessagePart": {
            "type": "object",
            "required": ["type", "toolcalls"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "tool_call"
                },
                "toolcalls": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/ToolCall"
                    }
                },
                "rendered": {
                    "type": "string"
                }
            }
        },
        "ToolCall": {
            "type": "object",
            "required": ["index", "id", "tool_name", "args_string", "status"],
            "properties": {
                "index": {
                    "type": "integer",
                    "description": "工具调用索引"
                },
                "id": {
                    "type": "string",
                    "description": "工具调用唯一 ID"
                },
                "tool_name": {
                    "type": "string",
                    "description": "工具名称"
                },
                "args_string": {
                    "type": "string",
                    "description": "工具参数（JSON 字符串）"
                },
                "status": {
                    "type": "string",
                    "enum": ["pending", "running", "success", "error"],
                    "description": "工具调用状态"
                },
                "result": {
                    "type": "string",
                    "description": "工具执行结果"
                },
                "compress_id": {
                    "type": "string",
                    "description": "压缩 ID（如果有）"
                },
                "result_storage": {
                    "$ref": "#/definitions/ToolResultStorageMetadata"
                },
                "microcompact": {
                    "$ref": "#/definitions/ToolCallMicrocompactMetadata"
                }
            }
        },
        "ToolResultStorageMetadata": {
            "type": "object",
            "required": ["result_id", "storage_version"],
            "properties": {
                "result_id": {
                    "type": "string",
                    "description": "结果唯一标识符"
                },
                "storage_version": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "存储版本"
                },
                "relative_path": {
                    "type": "string",
                    "description": "相对路径"
                },
                "original_chars": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "原始字符数"
                },
                "original_lines": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "原始行数"
                },
                "persisted_at": {
                    "type": "string",
                    "format": "date-time",
                    "description": "持久化时间"
                },
                "replacement_text": {
                    "type": "string",
                    "description": "替换文本"
                }
            }
        },
        "ToolCallMicrocompactMetadata": {
            "type": "object",
            "required": ["version", "strategy", "cleared_at"],
            "properties": {
                "version": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Microcompact 版本"
                },
                "strategy": {
                    "type": "string",
                    "const": "local_clear",
                    "description": "压缩策略"
                },
                "cleared_at": {
                    "type": "string",
                    "format": "date-time",
                    "description": "清理时间"
                },
                "original_chars": {
                    "type": "integer",
                    "minimum": 0
                },
                "original_lines": {
                    "type": "integer",
                    "minimum": 0
                },
                "replacement_text": {
                    "type": "string"
                },
                "artifact_path_hint": {
                    "type": "string"
                }
            }
        },
        "ErrorMessagePart": {
            "type": "object",
            "required": ["type", "title", "message"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "error"
                },
                "title": {
                    "type": "string",
                    "description": "错误标题"
                },
                "message": {
                    "type": "string",
                    "description": "错误消息"
                },
                "rendered": {
                    "type": "string"
                }
            }
        },
        "CompactSeparatorMessage": {
            "type": "object",
            "required": ["role", "summary", "metadata"],
            "properties": {
                "role": {
                    "type": "string",
                    "const": "compact_separator"
                },
                "summary": {
                    "type": "string",
                    "description": "压缩摘要"
                },
                "metadata": {
                    "$ref": "#/definitions/CompactBoundaryMetadata"
                }
            }
        },
        "CompactBoundaryMetadata": {
            "type": "object",
            "required": ["boundary_id", "summary_version", "created_at"],
            "properties": {
                "boundary_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "边界 ID"
                },
                "summary_version": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "摘要版本"
                },
                "created_at": {
                    "type": "string",
                    "format": "date-time",
                    "description": "创建时间"
                },
                "summarized_range": {
                    "$ref": "#/definitions/CompactSummarizedRange"
                },
                "previous_boundary_id": {
                    "type": "string",
                    "format": "uuid"
                }
            }
        },
        "CompactSummarizedRange": {
            "type": "object",
            "required": [
                "start_index",
                "end_index_exclusive",
                "message_count",
                "user_messages",
                "assistant_messages",
                "tool_calls"
            ],
            "properties": {
                "start_index": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "起始索引"
                },
                "end_index_exclusive": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "结束索引（不包含）"
                },
                "message_count": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "消息总数"
                },
                "user_messages": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "用户消息数"
                },
                "assistant_messages": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "助手消息数"
                },
                "tool_calls": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "工具调用数"
                }
            }
        },
        "Usage": {
            "type": "object",
            "required": ["prompt_tokens", "completion_tokens", "total_tokens"],
            "properties": {
                "prompt_tokens": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "提示词 token 数"
                },
                "completion_tokens": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "完成 token 数"
                },
                "total_tokens": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "总 token 数"
                }
            }
        },
        "Participant": {
            "type": "object",
            "required": ["type", "channel", "accountId", "recipientId"],
            "properties": {
                "type": {
                    "type": "string",
                    "const": "channel"
                },
                "channel": {
                    "type": "string",
                    "description": "渠道标识符，如 'feishu', 'slack'"
                },
                "accountId": {
                    "type": "string",
                    "description": "机器人在渠道中的账号 ID"
                },
                "recipientId": {
                    "type": "string",
                    "description": "消息接收者 ID"
                }
            }
        },
        "ToolResultReplacementState": {
            "type": "object",
            "required": ["seen_ids", "replacements"],
            "properties": {
                "seen_ids": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "已见过的结果 ID 列表"
                },
                "replacements": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/ToolResultReplacementRecord"
                    }
                }
            }
        },
        "ToolResultReplacementRecord": {
            "type": "object",
            "required": ["result_id", "replacement_text"],
            "properties": {
                "result_id": {
                    "type": "string",
                    "description": "结果 ID"
                },
                "replacement_text": {
                    "type": "string",
                    "description": "替换文本"
                },
                "relative_path": {
                    "type": "string",
                    "description": "相对路径"
                }
            }
        },
        "AutoCompactState": {
            "type": "object",
            "required": ["consecutive_failures", "failure_threshold", "cooldown_ms"],
            "properties": {
                "consecutive_failures": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "连续失败次数"
                },
                "last_attempt_at": {
                    "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }],
                    "description": "最后尝试时间"
                },
                "last_failure_at": {
                    "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }],
                    "description": "最后失败时间"
                },
                "last_success_at": {
                    "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }],
                    "description": "最后成功时间"
                },
                "cooldown_until": {
                    "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }],
                    "description": "冷却截止时间"
                },
                "failure_threshold": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "失败阈值"
                },
                "cooldown_ms": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "冷却时间（毫秒）"
                },
                "last_failure_reason": {
                    "oneOf": [{ "type": "string" }, { "type": "null" }],
                    "description": "最后失败原因"
                }
            }
        }
    }
}
```

### Task List JSON Schema (简化版)

```json
{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "https://opendesk.org/schemas/task-list.json",
    "title": "OpenDesk Task List",
    "description": "Task 列表简化格式，用于 task_list.json",
    "type": "array",
    "items": {
        "type": "object",
        "required": [
            "task_id",
            "parent_id",
            "task_name",
            "task_status",
            "started_at",
            "finished_at",
            "total_elapsed_ms",
            "stop_requested_by_user"
        ],
        "properties": {
            "task_id": {
                "type": "string",
                "pattern": "^task_[a-z0-9]+_[a-z0-9]+$"
            },
            "parent_id": {
                "oneOf": [{ "type": "string" }, { "type": "null" }]
            },
            "task_name": {
                "oneOf": [{ "type": "string" }, { "type": "null" }]
            },
            "task_status": {
                "type": "string",
                "enum": ["waiting", "running", "stopped"]
            },
            "started_at": {
                "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }]
            },
            "finished_at": {
                "oneOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }]
            },
            "total_elapsed_ms": {
                "type": "number",
                "minimum": 0
            },
            "bookmark_path": {
                "oneOf": [{ "type": "string" }, { "type": "null" }]
            },
            "origin": {
                "oneOf": [
                    {
                        "type": "object",
                        "required": ["type", "channel", "accountId", "recipientId"],
                        "properties": {
                            "type": { "type": "string", "const": "channel" },
                            "channel": { "type": "string" },
                            "accountId": { "type": "string" },
                            "recipientId": { "type": "string" }
                        }
                    },
                    { "type": "null" }
                ]
            },
            "stop_requested_by_user": {
                "type": "boolean"
            }
        }
    }
}
```

---

## 完整示例

### task_list.json 示例

```json
[
    {
        "task_id": "task_a1b2c3d4_x7yz",
        "parent_id": null,
        "task_name": "主任务",
        "task_status": "running",
        "started_at": "2026-04-17T02:00:00.000Z",
        "finished_at": null,
        "total_elapsed_ms": 300000,
        "bookmark_path": "bookmarks/root.json",
        "origin": null,
        "stop_requested_by_user": false
    },
    {
        "task_id": "task_e5f6g7h8_k9mn",
        "parent_id": "task_a1b2c3d4_x7yz",
        "task_name": "子任务",
        "task_status": "waiting",
        "started_at": "2026-04-17T02:05:00.000Z",
        "finished_at": null,
        "total_elapsed_ms": 0,
        "bookmark_path": null,
        "origin": {
            "type": "channel",
            "channel": "feishu",
            "accountId": "bot_001",
            "recipientId": "user_123"
        },
        "stop_requested_by_user": false
    }
]
```

### 单个 Task JSON 示例

````json
{
    "task_id": "task_a1b2c3d4_x7yz",
    "parent_id": null,
    "task_name": "主任务",
    "task_status": "running",
    "chat_context": {
        "system_prompt": {
            "role": "system",
            "content": "You are a helpful AI assistant."
        },
        "messages": [
            {
                "role": "user",
                "message_id": "550e8400-e29b-41d4-a716-446655440000",
                "internal": false,
                "content": [
                    {
                        "type": "text",
                        "text": "Hello, how are you?"
                    }
                ]
            },
            {
                "role": "assistant",
                "message_id": "550e8400-e29b-41d4-a716-446655440001",
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "total_tokens": 150
                },
                "content": [
                    {
                        "type": "reasoning",
                        "content": "The user is greeting me, I should respond politely.",
                        "source": "reasoning_content"
                    },
                    {
                        "type": "text",
                        "text": "Hello! I'm doing well, thank you for asking. How can I help you today?"
                    }
                ]
            },
            {
                "role": "user",
                "message_id": "550e8400-e29b-41d4-a716-446655440002",
                "internal": false,
                "content": [
                    {
                        "type": "text",
                        "text": "Can you help me write a function?"
                    }
                ]
            },
            {
                "role": "assistant",
                "message_id": "550e8400-e29b-41d4-a716-446655440003",
                "usage": {
                    "prompt_tokens": 150,
                    "completion_tokens": 120,
                    "total_tokens": 270
                },
                "content": [
                    {
                        "type": "tool_call",
                        "toolcalls": [
                            {
                                "index": 0,
                                "id": "call_abc123",
                                "tool_name": "writeFile",
                                "args_string": "{\"path\":\"test.js\",\"content\":\"function hello() {\\n  console.log('Hello World');\\n}\"}",
                                "status": "success",
                                "result": "File written successfully",
                                "result_storage": {
                                    "result_id": "result_001",
                                    "storage_version": 1,
                                    "relative_path": "artifacts/task_a1b2c3d4_x7yz/tool-results/result_001.txt",
                                    "original_chars": 56,
                                    "original_lines": 2,
                                    "persisted_at": "2026-04-17T02:01:30.000Z",
                                    "replacement_text": "File written successfully"
                                }
                            }
                        ]
                    },
                    {
                        "type": "text",
                        "text": "I've written the function for you. Here's what it does:\n\n```javascript\nfunction hello() {\n  console.log('Hello World');\n}\n```"
                    }
                ]
            }
        ]
    },
    "tool_result_replacement_state": {
        "seen_ids": ["result_001"],
        "replacements": [
            {
                "result_id": "result_001",
                "replacement_text": "File written successfully",
                "relative_path": "artifacts/task_a1b2c3d4_x7yz/tool-results/result_001.txt"
            }
        ]
    },
    "auto_compact_state": {
        "consecutive_failures": 0,
        "last_attempt_at": null,
        "last_failure_at": null,
        "last_success_at": null,
        "cooldown_until": null,
        "failure_threshold": 3,
        "cooldown_ms": 600000,
        "last_failure_reason": null
    },
    "started_at": "2026-04-17T02:00:00.000Z",
    "finished_at": null,
    "total_elapsed_ms": 300000,
    "bookmark_path": "bookmarks/root.json",
    "origin": null,
    "stop_requested_by_user": false
}
````

### 包含推理内容的 Assistant Message 示例

```json
{
    "role": "assistant",
    "message_id": "550e8400-e29b-41d4-a716-446655440004",
    "usage": {
        "prompt_tokens": 200,
        "completion_tokens": 180,
        "total_tokens": 380
    },
    "content": [
        {
            "type": "reasoning",
            "content": "The user is asking me to explain how a neural network works. Let me break this down into key concepts: 1) Neurons, 2) Layers, 3) Weights and biases, 4) Activation functions. I should provide a clear explanation with a simple example.",
            "source": "think_tag"
        },
        {
            "type": "text",
            "text": "A neural network is inspired by the biological neural networks in our brains. Here's how it works:\n\n## Key Components\n\n1. **Neurons (Nodes)**: Basic computational units that receive input, process it, and produce output.\n\n2. **Layers**: Neurons are organized in layers:\n   - Input layer: Receives data\n   - Hidden layers: Process information\n   - Output layer: Produces final results\n\n3. **Weights and Biases**: Parameters that are learned during training.\n\n4. **Activation Functions**: Determine if a neuron should \"fire\" based on its input."
        },
        {
            "type": "tool_call",
            "toolcalls": [
                {
                    "index": 0,
                    "id": "call_def456",
                    "tool_name": "readFiles",
                    "args_string": "{\"paths\":[\"example.py\"]}",
                    "status": "success",
                    "result": "# example.py\nimport numpy as np\n\nclass SimpleNeuralNetwork:\n    def __init__(self, input_size, hidden_size, output_size):\n        self.weights1 = np.random.randn(input_size, hidden_size)\n        self.weights2 = np.random.randn(hidden_size, output_size)\n        self.bias1 = np.zeros((1, hidden_size))\n        self.bias2 = np.zeros((1, output_size))\n    \n    def sigmoid(self, x):\n        return 1 / (1 + np.exp(-x))\n    \n    def forward(self, X):\n        self.hidden = self.sigmoid(np.dot(X, self.weights1) + self.bias1)\n        self.output = self.sigmoid(np.dot(self.hidden, self.weights2) + self.bias2)\n        return self.output"
                }
            ]
        }
    ]
}
```

### 带有错误状态的 ToolCall 示例

```json
{
    "type": "tool_call",
    "toolcalls": [
        {
            "index": 0,
            "id": "call_err789",
            "tool_name": "readFiles",
            "args_string": "{\"paths\":[\"nonexistent.txt\"]}",
            "status": "error",
            "result": "Error: ENOENT: no such file or directory, open 'nonexistent.txt'",
            "compress_id": null,
            "result_storage": null,
            "microcompact": null
        }
    ]
}
```

### Auto Compact State 示例

```json
{
    "consecutive_failures": 3,
    "last_attempt_at": "2026-04-17T02:10:00.000Z",
    "last_failure_at": "2026-04-17T02:10:00.000Z",
    "last_success_at": null,
    "cooldown_until": "2026-04-17T02:20:00.000Z",
    "failure_threshold": 3,
    "cooldown_ms": 600000,
    "last_failure_reason": "compact failed: context window exceeded"
}
```

### Compact Separator Message 示例

```json
{
    "role": "compact_separator",
    "summary": "用户询问了关于神经网络的问题。AI 解释了神经网络的基本组成部分，包括神经元、层、权重和偏置、激活函数等概念。AI 还提供了一个简单的 Python 实现示例。",
    "metadata": {
        "boundary_id": "550e8400-e29b-41d4-a716-446655440099",
        "summary_version": 1,
        "created_at": "2026-04-17T03:00:00.000Z",
        "summarized_range": {
            "start_index": 0,
            "end_index_exclusive": 10,
            "message_count": 10,
            "user_messages": 5,
            "assistant_messages": 4,
            "tool_calls": 1
        },
        "previous_boundary_id": null
    }
}
```

---

## Task 状态与生命周期

### TaskStatus 枚举

| 状态      | 说明                 |
| --------- | -------------------- |
| `waiting` | 任务等待中，初始状态 |
| `running` | 任务执行中           |
| `stopped` | 任务已停止           |

### Task 状态转换

```
waiting ─────► running ─────► stopped
                   │
                   ▼
               (stopped by user)
```

### 序列化/反序列化注意事项

1. **task_status 特殊处理**: 当加载 task 时，如果 `task_status === 'running'`，会被转换为 `'failed'`，因为 running 状态的任务不应该被持久化。

2. **日期字段**: 所有日期字段存储为 ISO 8601 格式的字符串，反序列化时转换为 `Date` 对象。

---

## 嵌套数据结构

### ChatContext

对话上下文，包含系统提示和消息历史。

```
ChatContext {
  system_prompt?: SystemMessage
  messages: ChatMessage[]
}
```

### ChatMessage 类型

```
ChatMessage = UserMessage | AssistantMessage | CompactSeparatorMessage
```

### Message Part 类型

```
UserMessagePart = TextMessagePart | ImageMessagePart | FileMessagePart
AssistantMessagePart = TextMessagePart | ReasoningMessagePart | ToolCallMessagePart | ErrorMessagePart
```

### ToolCall 内部结构

```
ToolCall {
  index: number           // 调用索引
  id: string             // 唯一 ID
  tool_name: string       // 工具名
  args_string: string     // JSON 参数
  status: 'pending' | 'running' | 'success' | 'error'
  result?: string         // 执行结果
  compress_id?: string    // 压缩 ID
  result_storage?: ToolResultStorageMetadata
  microcompact?: ToolCallMicrocompactMetadata
}
```

---

## 字段说明

### 核心标识字段

| 字段        | 类型           | 说明                                                                    |
| ----------- | -------------- | ----------------------------------------------------------------------- |
| `task_id`   | string         | 任务唯一标识，格式 `task_<timestamp>_<random>`，如 `task_a1b2c3d4_x7yz` |
| `parent_id` | string \| null | 父任务 ID，用于子任务/分支任务，null 表示主任务                         |
| `agentId`   | string \| null | Agent ID；null 表示无 Agent；旧任务缺失时使用 `main`                    |

### 状态字段

| 字段                     | 类型           | 说明                              |
| ------------------------ | -------------- | --------------------------------- |
| `task_name`              | string \| null | 用户定义的友好名称                |
| `task_status`            | string         | 任务状态：waiting/running/stopped |
| `stop_requested_by_user` | boolean        | 用户是否主动请求停止              |

### 时间与性能字段

| 字段               | 类型           | 说明                    |
| ------------------ | -------------- | ----------------------- |
| `started_at`       | string \| null | ISO 8601 格式，开始时间 |
| `finished_at`      | string \| null | ISO 8601 格式，结束时间 |
| `total_elapsed_ms` | number         | 任务总耗时（毫秒）      |

### 上下文字段

| 字段                            | 类型           | 说明                                                       |
| ------------------------------- | -------------- | ---------------------------------------------------------- |
| `chat_context`                  | object         | 对话上下文；包含完整的 `system_prompt`，用于格式兼容和调试 |
| `custom_system_prompt`          | string \| null | 调用 `setSystemPrompt()` 设置的附加提示词                  |
| `tool_result_replacement_state` | object         | 工具结果替换状态，用于上下文压缩                           |
| `auto_compact_state`            | object         | 自动压缩熔断状态                                           |

### 书签与来源

| 字段            | 类型           | 说明                             |
| --------------- | -------------- | -------------------------------- |
| `bookmark_path` | string \| null | 书签文件路径，用于恢复会话状态   |
| `origin`        | object \| null | 任务来源信息，用于渠道集成的任务 |

### 不参与序列化的字段

以下字段仅存在于运行时，不存储到 JSON：

- `harnessContext`: 工程框架上下文（包含敏感环境变量）
- `agent_system_prompt`: 根据 Agent 和 Mode 重建的提示词部分
- `activeModeId`: 当前运行模式 ID
- `disabledTools`: 禁用工具列表
- `message_queue`: 运行时消息队列
- `profiler`: 性能分析器
- `interactionToolset`: 交互工具集
- `subscribers`: UI 订阅者
- `hooks`: 任务钩子

---

## 参考文件

- 源码位置: `src/main/aikernel/states/tasks.ts`
- 消息类型: `src/main/aikernel/messages.ts`
- 自动压缩: `src/main/aikernel/compaction/auto-compact.ts`
- 工具结果: `src/main/aikernel/compaction/tool-results.ts`
- 插件类型: `src/main/plugins/types.ts`
- 测试用例: `src/tests/ut/compact/task-persistence.test.ts`
