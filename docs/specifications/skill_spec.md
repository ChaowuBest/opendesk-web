# Skill 技术规格综述

> 本文档定义了 Skill 的完整技术规范，适用于实现 Skill Parser 和 Loader。文档涵盖 Agent Skills 开放标准与 Claude Code 扩展两部分内容。

## 目录

1. [概述](#1-概述)
2. [Skill 类型分类](#2-skill-类型分类)
3. [目录结构](#3-目录结构)
4. [SKILL.md 文件格式](#4-skillmd-文件格式)
5. [Frontmatter 字段完整定义](#5-frontmatter-字段完整定义)
6. [类型定义（Parser 实现）](#6-类型定义parser-实现)
7. [String Substitution 变量](#7-string-substitution-变量)
8. [动态上下文注入](#8-动态上下文注入)
9. [Hook 系统](#9-hook-系统)
10. [存储位置与优先级](#10-存储位置与优先级)
11. [解析注意事项](#11-解析注意事项)
12. [示例代码](#12-示例代码)

---

## 1. 概述

### 1.1 什么是 Skill

**Skill** 是 Agent Skills 开放标准定义的 AI Agent 能力扩展机制。它是一组打包好的指令、上下文和支持文件，使 AI Agent 能够执行特定领域的任务或遵循特定的工作流程。

Skill 遵循**渐进式披露（Progressive Disclosure）**原则：
- **元数据层**（~100 tokens）：启动时加载，用于技能发现
- **指令层**（<5000 tokens 推荐）：技能激活时加载
- **资源层**：按需加载，仅在需要时读取

### 1.2 标准化背景

| 标准 | 组织 | 兼容性 |
|------|------|--------|
| Agent Skills | Anthropic + 生态 | 30+ AI 工具 |
| Claude Code Extensions | Anthropic | 仅 Claude Code |

Agent Skills 开放标准由 Anthropic 开发，现已获得广泛采纳；Claude Code 在此基础上增加了大量扩展功能。

---

## 2. Skill 类型分类

### 2.1 按激活方式分类

| 类型 | 描述 | 调用方式 |
|------|------|----------|
| **Auto-Invoke Skill** | Claude 根据上下文自动激活 | Claude 自动调用 |
| **User-Invocable Skill** | 用户通过 `/skillname` 显式调用 | 用户手动输入 |
| **Hidden Skill** | 仅 Claude 可用，对用户隐藏 | 不可见，无快捷命令 |
| **Manual-Only Skill** | 仅用户可调用，Claude 不可自动激活 | 需显式 `/skillname` |

### 2.2 按执行上下文分类

| 类型 | 描述 | 适用场景 |
|------|------|----------|
| **Inline Skill** | 在主对话上下文中执行 | 常规任务、指南类技能 |
| **Forked Skill** | 在隔离的子代理上下文中执行 | 复杂任务、隔离操作 |
| **Hooked Skill** | 挂载到工具调用生命周期 | 自动化验证、审计 |

### 2.3 按内容类型分类

| 类型 | 描述 |
|------|------|
| **Reference Skill** | 添加 Claude 应用到当前工作的知识 |
| **Task Skill** | 提供执行特定操作的步骤说明 |
| **Template Skill** | 提供可填充的内容模板 |
| **Hybrid Skill** | 混合以上多种类型 |

---

## 3. 目录结构

### 3.1 标准目录结构

```
skill-name/
├── SKILL.md              # [必需] 主文件：YAML frontmatter + Markdown 指令
├── scripts/              # [可选] 可执行脚本
├── references/           # [可选] 参考文档（按需加载）
├── templates/            # [可选] 内容模板
├── examples/             # [可选] 示例文件
└── assets/               # [可选] 静态资源
```

### 3.2 目录用途详解

| 目录 | 用途 | 加载方式 |
|------|------|----------|
| `SKILL.md` | 主指令文件 | 激活时全量加载 |
| `scripts/` | Python/Bash/JS 等可执行脚本 | Claude 调用执行 |
| `references/` | 详细技术文档 | 按需加载 |
| `templates/` | 可填充的模板文件 | 按需加载 |
| `examples/` | 示例输出 | 按需加载 |
| `assets/` | 图片、数据文件等 | 按需引用 |

### 3.3 嵌套目录支持

Claude Code 支持从嵌套目录自动发现 Skill：

```
packages/
├── frontend/
│   └── .claude/
│       └── skills/
│           └── react-best-practices/
│               └── SKILL.md
└── backend/
    └── .claude/
        └── skills/
            └── api-design/
                └── SKILL.md
```

---

## 4. SKILL.md 文件格式

### 4.1 文件结构

```markdown
---
name: skill-name
description: 技能描述...
field: value
---

# Skill Title

这里是 Markdown 格式的指令内容...
```

### 4.2 Frontmatter 与 Body 的分隔

```
---              ← 开始边界（必须单独一行）
name: xxx
description: xxx
---              ← 结束边界（必须单独一行）

Markdown 内容...  ← 主体内容
```

### 4.3 Frontmatter 格式要求

| 项目 | 要求 |
|------|------|
| 分隔符 | `---`（三连横线），前后各一行 |
| 缩进 | 使用空格，禁止 Tab |
| 字符串引号 | 仅在包含特殊字符时需要（`:`, `#`, `|`, `>` 等） |
| 多行字符串 | 使用 `|` 或 `>`，但注意 Claude Code 解析限制 |

### 4.4 Body 内容格式

Body 部分是标准 Markdown 格式，建议包含以下章节：

```markdown
# Skill Title

## Overview
简要说明...

## When to Use
描述使用场景...

## Instructions
详细步骤...

## Examples
代码示例...

## Resources
- [参考文档](references/detail.md)
```

---

## 5. Frontmatter 字段完整定义

### 5.1 Agent Skills 标准字段

这些字段是开放标准的一部分，跨平台兼容。

#### `name`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | **推荐**（Agent Skills 标准要求，Claude Code 可选） |
| 最大长度 | 64 字符 |
| 命名规范 | 全小写字母、数字、连字符 |
| 禁止 | 以 `-` 开头/结尾、连续 `--`、保留词 |
| 默认值 | 目录名（当字段省略时） |

**正则表达式**：`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`

**示例**：
```yaml
name: api-testing          # ✓ 合法
name: my-skill              # ✓ 合法
name: MySkill               # ✗ 非法（大写）
name: -invalid              # ✗ 非法（开头横线）
name: invalid--name         # ✗ 非法（连续横线）
```

#### `description`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | **推荐** |
| 最大长度 | 1024 字符 |
| 建议长度 | 10-250 字符（过长会被截断） |
| 推荐语气 | 第三人称 |
| 推荐格式 | `[动作1]，[动作2]... Use when [场景1]，[场景2]，or when [关键词]` |

**重要性**：`description` 是 Claude 判断何时激活 Skill 的核心依据！

**良好示例**：
```yaml
description: Extract text and tables from PDFs, fill forms, merge documents. Use when working with PDF files or when user mentions PDFs, forms, extraction.
```

**不良示例**：
```yaml
description: Helps with documents  # ✗ 过于模糊
```

#### `license`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 推荐格式 | 许可证名称（如 `MIT`）或文件名（如 `./LICENSE`） |

#### `compatibility`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 最大长度 | 500 字符 |
| 用途 | 说明环境要求（目标产品、系统包、网络访问等） |

#### `metadata`

| 属性 | 值 |
|------|-----|
| 类型 | `object<string, string>` |
| 必需 | 否 |
| 用途 | 存储额外自定义元数据 |
| 推荐 | 使用唯一键名避免冲突 |

**示例**：
```yaml
metadata:
  author: John Doe
  version: "1.0.0"
  tags: "deployment,ci"
```

#### `allowed-tools`

| 属性 | 值 |
|------|-----|
| 类型 | `string[]`（YAML 中用 `tools:` 或 `tools:` 列表格式） |
| 必需 | 否 |
| 用途 | 预批准允许使用的工具列表 |
| 实验性 | 部分 Agent 实现可能不支持 |

**示例**：
```yaml
# 单行格式
allowed-tools: Read, Grep, Glob

# 列表格式
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(npm run:*)
```

**带参数的 Bash 工具**：`Bash(npm run:*)` 表示允许 `npm run` 开头的所有 Bash 命令。

---

### 5.2 Claude Code 扩展字段

以下字段仅在 Claude Code 中生效。

#### `argument-hint`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 用途 | 自动补全时显示的参数提示 |
| 格式示例 | `[optional-arg]` 或 `[filename] [format]` |

**示例**：
```yaml
argument-hint: "[issue-number]"
argument-hint: "[filename] [format]"
```

#### `user-invocable`

| 属性 | 值 |
|------|-----|
| 类型 | `boolean` |
| 必需 | 否 |
| 默认值 | `true` |
| 用途 | 控制是否在 `/` 菜单中显示 |

**效果**：
- `true`：用户可在 `/` 菜单中看到并调用
- `false`：从 `/` 菜单隐藏，但 Claude 仍可调用

#### `disable-model-invocation`

| 属性 | 值 |
|------|-----|
| 类型 | `boolean` |
| 必需 | 否 |
| 默认值 | `false` |
| 用途 | 阻止 Claude 自动激活此 Skill |

**使用场景**：
- `/deploy` - 用户显式部署，不希望 Claude 自动触发
- `/commit` - 用户显式提交，不希望 Claude 自动提交

**注意**：设置为 `true` 时，Skill 描述不会加载到 Claude 上下文。

#### `model`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 可选值 | `opus`, `sonnet`, `haiku`（别名）或完整模型 ID |

**别名映射**：
| 别名 | 完整 ID 示例 |
|------|--------------|
| `opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-6` |

#### `effort`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 可选值 | `low`, `medium`, `high`, `max` |
| 用途 | 覆盖会话的工作量级别 |

#### `context`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 可选值 | `fork` |
| 用途 | 在隔离的子代理上下文中执行 Skill |

**注意**：当设置 `context: fork` 时，`agent` 字段变为必需。

#### `agent`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 条件必需（当 `context: fork` 时） |
| 可选值 | `Explore`, `Plan`, `general-purpose`，或自定义代理名 |

**内置代理类型**：
| 代理 | 模型 | 工具 | 用途 |
|------|------|------|------|
| `Explore` | Haiku | 文件/Web/MCP（只读） | 精确检索，不做分析 |
| `Plan` | 继承 | 文件/Web/MCP（只读） | 研究后规划 |
| `general-purpose` | 继承 | 全部工具 | 复杂操作（默认） |

#### `hooks`

| 属性 | 值 |
|------|-----|
| 类型 | `object` |
| 必需 | 否 |
| 用途 | 定义技能生命周期内的钩子 |
| 详见 | [第 9 节 - Hook 系统](#9-hook-系统) |

#### `paths`

| 属性 | 值 |
|------|-----|
| 类型 | `string \| string[]` |
| 必需 | 否 |
| 用途 | Glob 模式列表，限制技能激活条件 |
| 格式 | 与 Memory 的 path-specific rules 相同 |

**示例**：
```yaml
paths: "src/**/*.ts"
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
```

#### `shell`

| 属性 | 值 |
|------|-----|
| 类型 | `string` |
| 必需 | 否 |
| 可选值 | `bash`, `powershell` |
| 用途 | 指定 `` !`<command>` `` 块使用的 Shell |

---

## 6. 类型定义（Parser 实现）

### 6.1 核心类型

```typescript
// ============================================
// Skill 相关类型定义
// ============================================

// --- Frontmatter 字段 ---

/**
 * 基础元数据（Agent Skills 标准）
 */
interface SkillBaseFrontmatter {
  name?: string;                    // 可选，默认为目录名
  description?: string;             // 可选，默认为正文第一段
  license?: string;                 // 可选
  compatibility?: string;          // 可选
  metadata?: Record<string, string>; // 可选
  "allowed-tools"?: string | string[]; // 可选
}

/**
 * Claude Code 扩展字段
 */
interface ClaudeCodeExtensions {
  "argument-hint"?: string;
  "user-invocable"?: boolean;
  "disable-model-invocation"?: boolean;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  context?: "fork";
  agent?: string;
  hooks?: SkillHooks;
  paths?: string | string[];
  shell?: "bash" | "powershell";
  tags?: string[];
  version?: string;
}

/**
 * 完整的 Frontmatter 类型
 */
interface SkillFrontmatter extends SkillBaseFrontmatter, ClaudeCodeExtensions {}

/**
 * Skill 钩子配置
 */
interface SkillHooks {
  PreToolUse?: HookRule[];
  PostToolUse?: HookRule[];
  Stop?: HookRule[];
}

/**
 * 钩子规则
 */
interface HookRule {
  matcher?: string;  // 正则表达式
  hooks: HookAction[];
}

/**
 * 钩子动作
 */
interface HookAction {
  type: "command";
  command: string;
  once?: boolean;
}

// --- Skill 实体 ---

/**
 * Skill 解析结果
 */
interface Skill {
  // 标识
  id: string;           // 唯一标识（目录名或 name 字段）
  name: string;         // 显示名称
  directory: string;    // 技能目录绝对路径
  
  // 元数据
  frontmatter: SkillFrontmatter;
  description: string;
  
  // 内容
  body: string;         // Markdown 正文（不含 frontmatter）
  
  // 解析信息
  parseError?: string;  // 解析错误信息
  
  // 调用控制
  isUserInvocable: boolean;
  isModelInvocable: boolean;
  
  // 关联文件
  scripts: string[];    // scripts/ 目录下的脚本
  references: string[]; // references/ 目录下的文档
  templates: string[]; // templates/ 目录下的模板
  examples: string[];  // examples/ 目录下的示例
  
  // 作用域
  scope: "personal" | "project" | "plugin" | "enterprise";
}

/**
 * Skill 目录信息
 */
interface SkillDirectory {
  path: string;        // 目录绝对路径
  scope: "personal" | "project" | "plugin" | "enterprise";
  skills: Skill[];
}

/**
 * Skill 加载结果
 */
interface SkillLoadResult {
  success: boolean;
  skill?: Skill;
  error?: string;
}
```

### 6.2 验证规则类型

```typescript
/**
 * Frontmatter 字段验证规则
 */
interface FieldValidationRule {
  field: string;
  type: "string" | "boolean" | "array" | "object";
  required: boolean;
  constraints?: {
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    enum?: string[];
    itemsType?: "string" | "number" | "boolean";
  };
  errorMessage?: string;
}

/**
 * 验证结果
 */
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}
```

### 6.3 预定义的验证规则

```typescript
const SKILL_FRONTMATTER_RULES: FieldValidationRule[] = [
  // name 字段验证
  {
    field: "name",
    type: "string",
    required: false,  // Agent Skills 要求，Claude Code 可选
    constraints: {
      maxLength: 64,
      pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
    },
    errorMessage: "name must be 1-64 chars, lowercase, only a-z, 0-9, and hyphens"
  },
  
  // description 字段验证
  {
    field: "description",
    type: "string",
    required: false,  // 推荐但非强制
    constraints: {
      minLength: 10,   // claudelint 要求
      maxLength: 1024
    },
    errorMessage: "description must be 10-1024 characters"
  },
  
  // license 字段验证
  {
    field: "license",
    type: "string",
    required: false
  },
  
  // compatibility 字段验证
  {
    field: "compatibility",
    type: "string",
    required: false,
    constraints: {
      maxLength: 500
    }
  },
  
  // user-invocable 字段验证
  {
    field: "user-invocable",
    type: "boolean",
    required: false
  },
  
  // disable-model-invocation 字段验证
  {
    field: "disable-model-invocation",
    type: "boolean",
    required: false
  },
  
  // model 字段验证
  {
    field: "model",
    type: "string",
    required: false,
    constraints: {
      enum: ["opus", "sonnet", "haiku", "inherit"]
    }
  },
  
  // effort 字段验证
  {
    field: "effort",
    type: "string",
    required: false,
    constraints: {
      enum: ["low", "medium", "high", "max"]
    }
  },
  
  // context 字段验证
  {
    field: "context",
    type: "string",
    required: false,
    constraints: {
      enum: ["fork"]
    }
  },
  
  // agent 字段验证
  {
    field: "agent",
    type: "string",
    required: false
  },
  
  // allowed-tools 字段验证
  {
    field: "allowed-tools",
    type: "array",
    required: false,
    constraints: {
      itemsType: "string"
    }
  },
  
  // argument-hint 字段验证
  {
    field: "argument-hint",
    type: "string",
    required: false
  },
  
  // shell 字段验证
  {
    field: "shell",
    type: "string",
    required: false,
    constraints: {
      enum: ["bash", "powershell"]
    }
  },
  
  // tags 字段验证
  {
    field: "tags",
    type: "array",
    required: false,
    constraints: {
      itemsType: "string"
    }
  }
];
```

---

## 7. String Substitution 变量

Skill 正文支持以下变量替换：

### 7.1 参数变量

| 变量 | 描述 | 示例 |
|------|------|------|
| `$ARGUMENTS` | 所有传入参数 | `/deploy prod` → `deploy prod` |
| `$ARGUMENTS[N]` | 按索引访问（第 N 个参数，0-based） | `$ARGUMENTS[0]` → 第一个参数 |
| `$N` | `$ARGUMENTS[N]` 的简写 | `$0`, `$1`, `$2` |

### 7.2 上下文变量

| 变量 | 描述 | 用途 |
|------|------|------|
| `${CLAUDE_SESSION_ID}` | 当前会话 ID | 日志记录、文件命名 |
| `${CLAUDE_SKILL_DIR}` | Skill 目录绝对路径 | 引用内置脚本、文件 |

### 7.3 替换时机

变量替换发生在**技能激活时**、在正文发送到 Claude **之前**。

**示例 SKILL.md**：
```markdown
---
description: Migrate a component from one framework to another
---

Migrate the $0 component from $1 to $2.
Preserve all existing behavior and tests.
```

调用 `/migrate-component SearchBar React Vue` 时：
- `$0` → `SearchBar`
- `$1` → `React`
- `$2` → `Vue`

---

## 8. 动态上下文注入

### 8.1 语法

使用 `` !`<command>` `` 语法执行 Shell 命令并将其输出插入正文。

### 8.2 执行时机

1. 技能激活时，`!<command>`` 块**立即执行**
2. 命令输出**替换** `!<command>`` 占位符
3. Claude 收到的是**预处理后的完整内容**

### 8.3 注意事项

- 这是**预处理**，不是 Claude 执行
- Claude 只能看到最终渲染结果
- 命令输出会被插入到技能正文的对应位置

### 8.4 示例

```markdown
---
name: pr-summary
description: Summarize a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Pull Request Context
- Diff: !`gh pr diff`
- Comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Summary Task
Analyze and summarize this PR...
```

---

## 9. Hook 系统

### 9.1 Hook 事件

| 事件 | 触发时机 | 常见用途 |
|------|----------|----------|
| `PreToolUse` | 工具执行前 | 验证、安全检查、参数修改 |
| `PostToolUse` | 工具执行成功后 | 格式化输出、后续处理 |
| `Stop` | 技能结束时 | 清理资源、生成报告 |

### 9.2 Hook 配置结构

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"           # 可选：正则匹配工具名
      hooks:
        - type: command
          command: "./scripts/check.sh"
          once: true             # 可选：仅运行一次
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "./scripts/lint.sh"
  Stop:
    - hooks:
        - type: command
          command: "./scripts/cleanup.sh"
```

### 9.3 Hook I/O 规范

| 项目 | 说明 |
|------|------|
| **输入** | 通过 stdin 接收 JSON（会话信息、工具名、参数） |
| **Exit 0** | 成功，允许继续 |
| **Exit 2** | 阻塞错误，阻止工具执行，显示 stderr |
| **其他 Exit** | 非阻塞错误，记录但继续执行 |

### 9.4 Matcher 语法

Matcher 是正则表达式，用于匹配工具名称：

```yaml
matcher: "Bash"           # 匹配 Bash 工具
matcher: "Write|Edit"     # 匹配 Write 或 Edit
matcher: "Bash(npm run:*)" # 匹配带参数的 Bash 命令
```

---

## 10. 存储位置与优先级

### 10.1 位置列表

| 作用域 | 路径 | 说明 |
|--------|------|------|
| **Enterprise** | 通过 managed settings 配置 | 组织级别 |
| **Personal** | `~/.claude/skills/` | 用户所有项目 |
| **Project** | `.claude/skills/` | 当前项目 |
| **Plugin** | `<plugin>/skills/` | 随插件分发 |

### 10.2 优先级（高 → 低）

```
Enterprise > Personal > Project > Plugin
```

### 10.3 命名空间

| 位置 | 命名空间 | 同名冲突处理 |
|------|----------|--------------|
| Enterprise/Personal/Project | 无前缀 | 高优先级覆盖低优先级 |
| Plugin | `plugin-name:skill-name` | 不会与其他位置冲突 |

### 10.4 额外目录支持

通过 `--add-dir` 添加的目录下的 `.claude/skills/` 也会被自动发现，并支持热重载。

---

## 11. 解析注意事项

### 11.1 Frontmatter 解析

#### 11.1.1 边界检测

```typescript
// 正确的边界检测
function findFrontmatterBounds(content: string): { start: number; end: number } | null {
  // 跳过 BOM 和空白
  let pos = 0;
  while (pos < content.length && /\s/.test(content[pos])) pos++;
  
  // 检查开始边界
  if (!content.slice(pos).startsWith('---')) {
    return null;
  }
  pos += 3;
  
  // 找到结束边界（独立的一行 ---）
  const endLine = content.indexOf('\n---', pos);
  if (endLine === -1) {
    return null;  // 缺少结束边界
  }
  
  return { start: 0, end: endLine + 4 };
}
```

#### 11.1.2 YAML 解析容错

某些 YAML 内容可能解析失败，需要容错处理：

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 冒号后无空格 | `description:Value` | 自动补全或报错 |
| 多行字符串 | 使用 `\|` 或 `>` | Claude Code 可能有解析问题 |
| 特殊字符 | `:`, `#`, `|` 等 | 使用单引号包裹 |
| 重复键 | 同名字段多次出现 | 取第一个或最后一个 |

**推荐**：使用容错的 YAML 解析器（如 `js-yaml` 的 safeLoad 但带 try-catch）。

### 11.2 描述截断

当 Skill 元数据超过预算时：
- **预算**：上下文窗口的 2%（最低 16,000 字符）
- **截断行为**：描述从可用技能列表中移除
- **影响**：Claude 无法自动调用，但用户仍可显式调用
- **覆盖方法**：设置 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 环境变量

### 11.3 名称匹配

- `name` 字段应与目录名匹配
- 目录名是 fallback 默认值
- 快捷调用命令格式为 `/<name>`

### 11.4 Shell 注入安全

当解析 `!<command>`` 块时：
- **验证命令来源**：仅允许 Skill 内置脚本
- **路径引用**：使用 `${CLAUDE_SKILL_DIR}` 引用内置文件
- **避免直接执行用户输入**

---

## 12. 示例代码

### 12.1 Skill Parser 实现

```typescript
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

/**
 * 解析 SKILL.md 文件
 */
function parseSkillFile(skillPath: string): Skill {
  const content = fs.readFileSync(skillPath, 'utf-8');
  const directory = path.dirname(skillPath);
  const directoryName = path.basename(directory);
  
  // 1. 提取 Frontmatter
  const { frontmatter, body, error } = parseFrontmatter(content);
  
  // 2. 确定名称
  const name = frontmatter.name ?? directoryName;
  
  // 3. 确定描述
  const description = frontmatter.description ?? extractFirstParagraph(body);
  
  // 4. 确定调用权限
  const isUserInvocable = frontmatter["user-invocable"] !== false;
  const isModelInvocable = frontmatter["disable-model-invocation"] !== true;
  
  // 5. 扫描关联文件
  const { scripts, references, templates, examples } = scanSupportingFiles(directory);
  
  return {
    id: name,
    name,
    directory,
    frontmatter,
    description,
    body,
    parseError: error,
    isUserInvocable,
    isModelInvocable,
    scripts,
    references,
    templates,
    examples,
    scope: detectScope(directory)
  };
}

/**
 * 解析 YAML Frontmatter
 */
function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
  error?: string;
} {
  // 移除 BOM
  let cleanContent = content.replace(/^\uFEFF/, '');
  
  // 检查开始边界
  if (!cleanContent.trimStart().startsWith('---')) {
    return {
      frontmatter: {},
      body: content,
      error: 'Missing frontmatter start boundary'
    };
  }
  
  // 找到结束边界
  const firstNewline = cleanContent.indexOf('\n');
  const afterStart = cleanContent.slice(firstNewline + 1);
  const endIndex = afterStart.indexOf('\n---');
  
  if (endIndex === -1) {
    return {
      frontmatter: {},
      body: content,
      error: 'Missing frontmatter end boundary'
    };
  }
  
  // 提取 YAML 部分
  const yamlContent = afterStart.slice(0, endIndex);
  const body = afterStart.slice(endIndex + 4).trimStart();
  
  try {
    const frontmatter = yaml.load(yamlContent) as SkillFrontmatter ?? {};
    return { frontmatter, body };
  } catch (e) {
    return {
      frontmatter: {},
      body: content,
      error: `YAML parse error: ${e.message}`
    };
  }
}

/**
 * 验证 Skill
 */
function validateSkill(skill: Skill): ValidationResult {
  const errors: ValidationError[] = [];
  
  // name 验证
  if (skill.name) {
    if (skill.name.length > 64) {
      errors.push({
        field: 'name',
        message: 'name must be at most 64 characters',
        value: skill.name
      });
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(skill.name)) {
      errors.push({
        field: 'name',
        message: 'name must match pattern: ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$',
        value: skill.name
      });
    }
  }
  
  // description 验证
  if (skill.description) {
    if (skill.description.length < 10) {
      errors.push({
        field: 'description',
        message: 'description should be at least 10 characters',
        value: skill.description
      });
    }
    if (skill.description.length > 1024) {
      errors.push({
        field: 'description',
        message: 'description must be at most 1024 characters',
        value: skill.description
      });
    }
  }
  
  // context: fork 需要 agent
  if (skill.frontmatter.context === 'fork' && !skill.frontmatter.agent) {
    errors.push({
      field: 'agent',
      message: 'agent is required when context is fork',
      value: skill.frontmatter.agent
    });
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * 替换 Skill 正文中的变量
 */
function substituteVariables(
  body: string,
  args: string[],
  context: { sessionId: string; skillDir: string }
): string {
  let result = body;
  
  // 替换 $ARGUMENTS
  if (args.length > 0) {
    result = result.replace(/\$ARGUMENTS/g, args.join(' '));
  }
  
  // 替换 $ARGUMENTS[N] 和 $N
  result = result.replace(/\$(\d+)/g, (match, index) => {
    const idx = parseInt(index, 10);
    return args[idx] ?? '';
  });
  
  // 替换上下文变量
  result = result.replace(/\$\{CLAUDE_SESSION_ID\}/g, context.sessionId);
  result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, context.skillDir);
  
  return result;
}
```

### 12.2 Skill Loader 实现

```typescript
/**
 * Skill 加载器
 */
class SkillLoader {
  private skills: Map<string, Skill> = new Map();
  private searchPaths: string[] = [];
  
  constructor() {
    this.initializeSearchPaths();
  }
  
  /**
   * 初始化搜索路径
   */
  private initializeSearchPaths(): void {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    
    // 优先级从低到高
    this.searchPaths = [
      path.join(home, '.claude', 'skills'),           // Personal
      '.claude/skills',                               // Project
    ];
    
    // 添加额外目录（如果有）
    const additionalDirs = process.env.CLAUDE_CODE_ADDITIONAL_DIRS;
    if (additionalDirs) {
      const dirs = additionalDirs.split(',');
      dirs.forEach(dir => {
        const skillsPath = path.join(dir, '.claude', 'skills');
        if (fs.existsSync(skillsPath)) {
          this.searchPaths.push(skillsPath);
        }
      });
    }
  }
  
  /**
   * 加载所有 Skills
   */
  loadAll(): void {
    this.skills.clear();
    
    for (const basePath of this.searchPaths) {
      if (fs.existsSync(basePath)) {
        this.loadFromDirectory(basePath, this.detectScope(basePath));
      }
    }
  }
  
  /**
   * 从目录加载 Skills
   */
  private loadFromDirectory(basePath: string, scope: Skill['scope']): void {
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const skillPath = path.join(basePath, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      
      try {
        const skill = parseSkillFile(skillPath);
        skill.scope = scope;
        
        // 检查同名冲突
        if (this.skills.has(skill.name)) {
          const existing = this.skills.get(skill.name)!;
          if (this.getPriority(scope) > this.getPriority(existing.scope)) {
            this.skills.set(skill.name, skill);
          }
        } else {
          this.skills.set(skill.name, skill);
        }
      } catch (e) {
        console.error(`Failed to load skill from ${skillPath}: ${e.message}`);
      }
    }
  }
  
  /**
   * 获取 Skill
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
  
  /**
   * 获取所有 Skills
   */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }
  
  /**
   * 获取可用户调用的 Skills
   */
  getUserInvocable(): Skill[] {
    return this.getAll().filter(s => s.isUserInvocable);
  }
  
  /**
   * 获取可模型调用的 Skills
   */
  getModelInvocable(): Skill[] {
    return this.getAll().filter(s => s.isModelInvocable);
  }
  
  /**
   * 根据上下文推荐 Skills
   */
  recommend(context: string): Skill[] {
    const keywords = context.toLowerCase().split(/\s+/);
    
    return this.getModelInvocable()
      .map(skill => {
        const desc = skill.description.toLowerCase();
        const matches = keywords.filter(k => desc.includes(k)).length;
        return { skill, score: matches };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ skill }) => skill);
  }
  
  /**
   * 确定作用域
   */
  private detectScope(dirPath: string): Skill['scope'] {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (dirPath.startsWith(home)) return 'personal';
    if (dirPath.includes('.claude/skills')) return 'project';
    return 'personal';
  }
  
  /**
   * 获取优先级
   */
  private getPriority(scope: Skill['scope']): number {
    const priorities = { plugin: 0, personal: 1, project: 2, enterprise: 3 };
    return priorities[scope] ?? 0;
  }
}
```

### 12.3 Skill 激活流程

```typescript
/**
 * 激活 Skill
 */
async function activateSkill(
  skillName: string,
  args: string[],
  context: { sessionId: string; skillDir: string }
): Promise<{ success: boolean; content?: string; error?: string }> {
  const loader = new SkillLoader();
  loader.loadAll();
  
  const skill = loader.get(skillName);
  if (!skill) {
    return { success: false, error: `Skill not found: ${skillName}` };
  }
  
  if (!skill.isUserInvocable && !skill.isModelInvocable) {
    return { success: false, error: `Skill is not invocable: ${skillName}` };
  }
  
  // 替换变量
  let content = substituteVariables(skill.body, args, {
    sessionId: context.sessionId,
    skillDir: skill.directory
  });
  
  // 处理动态上下文注入
  content = await processDynamicInjection(content, skill.directory);
  
  return { success: true, content };
}

/**
 * 处理动态上下文注入
 */
async function processDynamicInjection(
  body: string,
  skillDir: string
): Promise<string> {
  const regex = /!`([^`]+)`/g;
  const matches = [...body.matchAll(regex)];
  
  if (matches.length === 0) return body;
  
  let result = body;
  
  for (const match of matches) {
    const [fullMatch, command] = match;
    
    try {
      // 安全检查：仅允许执行 skill 内置脚本
      const safeCommand = sanitizeShellCommand(command, skillDir);
      const output = await execAsync(safeCommand, {
        cwd: skillDir,
        timeout: 30000
      });
      result = result.replace(fullMatch, output.stdout);
    } catch (e) {
      console.error(`Command failed: ${command}`);
      result = result.replace(fullMatch, `[Command failed: ${command}]`);
    }
  }
  
  return result;
}

/**
 * 清理 Shell 命令（安全检查）
 */
function sanitizeShellCommand(command: string, skillDir: string): string {
  // 仅允许执行 skill 内置脚本
  if (command.startsWith('./') || command.startsWith('scripts/')) {
    const fullPath = path.resolve(skillDir, command);
    if (!fullPath.startsWith(skillDir)) {
      throw new Error('Path traversal detected');
    }
    return command;
  }
  
  // 禁止其他命令
  throw new Error('Only local scripts within skill directory are allowed');
}
```

---

## 附录 A：完整 Frontmatter 字段速查表

| 字段 | 类型 | 标准 | Claude Code | 默认值 |
|------|------|------|------------|--------|
| `name` | string | ✅ | ✅ (可选) | 目录名 |
| `description` | string | ✅ | ✅ | 正文首段 |
| `license` | string | ✅ | ✅ | - |
| `compatibility` | string | ✅ | ✅ | - |
| `metadata` | object | ✅ | ✅ | - |
| `allowed-tools` | string[] | ✅ | ✅ | - |
| `argument-hint` | string | - | ✅ | - |
| `user-invocable` | boolean | - | ✅ | true |
| `disable-model-invocation` | boolean | - | ✅ | false |
| `model` | string | - | ✅ | inherit |
| `effort` | string | - | ✅ | inherit |
| `context` | string | - | ✅ | - |
| `agent` | string | - | ✅ | general-purpose |
| `hooks` | object | - | ✅ | - |
| `paths` | string[] | - | ✅ | - |
| `shell` | string | - | ✅ | bash |
| `tags` | string[] | - | ✅ (扩展) | - |
| `version` | string | - | ✅ (扩展) | - |

---

## 附录 B：错误代码

| 代码 | 含义 | 处理建议 |
|------|------|----------|
| `E001` | 缺少 frontmatter 开始边界 | 检查文件格式 |
| `E002` | 缺少 frontmatter 结束边界 | 添加 `---` 分隔符 |
| `E003` | YAML 解析失败 | 检查 YAML 语法 |
| `E004` | name 格式错误 | 使用小写字母、数字、连字符 |
| `E005` | description 长度超限 | 缩减到 1024 字符以内 |
| `E006` | context: fork 但缺少 agent | 添加 agent 字段 |
| `E007` | SKILL.md 文件不存在 | 检查目录结构 |
| `E008` | Shell 命令执行失败 | 检查脚本路径和权限 |
| `E009` | 路径遍历检测 | 禁止使用绝对路径或 `..` |

---

## 附录 C：参考资源

- [Agent Skills 官方规范](https://agentskills.io/specification)
- [Claude Code Skills 文档](https://code.claude.com/docs/en/slash-commands)
- [Claude Code Skills 完整参考 (2026-03)](https://github.com/jamie-bitflight/claude_skills)
- [YAML 1.2 规范](https://yaml.org/spec/1.2.2/)

---

*文档版本：1.0.0*  
*最后更新：2026-03-29*  
*目标用途：Skill Parser 和 Loader 实现参考*
