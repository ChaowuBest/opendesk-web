# 本地 Agent Skills（Anthropic 行业标准）

本目录为**示例与模板**。要启用本地技能，请将需要的技能子目录（如 `example`）**复制到应用数据目录下的 `skills` 文件夹**：

- **Windows**: `%APPDATA%/fillipdesk/skills/`
- **macOS**: `~/Library/Application Support/fillipdesk/skills/`

复制后重启应用或调用 `skillRegistry:refresh`，主进程对话即可自动发现并调用这些技能。

格式对齐 **Anthropic 发布的 Agent Skills 行业标准**：[agentskills.io](https://agentskills.io/specification)

## 技能目录结构

每个技能一个子目录，**目录名必须与 SKILL.md 中的 `name` 一致**。

- **SKILL.md**（必填）：YAML frontmatter + Markdown 正文
- **scripts/**（可选）：支持脚本
- **references/**（可选）：参考材料
- **assets/**（可选）：资源文件

## SKILL.md 格式

- **必填**：`name`（1–64 字符，小写字母/数字/连字符，不可首尾或连续连字符）、`description`（1–1024 字符）
- **可选**：`license`、`compatibility`（≤500 字符）、`metadata`、`allowed-tools`（实验性）

示例：

```yaml
---
name: example
description: 示例技能，用于测试本地端侧 Agent Skills 发现与调用。
license: MIT
metadata:
  version: "1.0.0"
---
```

正文为 Markdown，无结构限制，供模型按需加载。

## FillipDesk 扩展（可选执行）

未配置执行器时，主进程调用技能仅返回 SKILL.md 正文。若需“执行并返回结果”，可在 frontmatter 中增加 `fillipdesk` 扩展：

```yaml
fillipdesk:
  handler:
    type: module   # 或 script / url
    path: handler.js   # 相对技能目录
  input_schema:        # 可选，定义 tool 参数（JSON Schema）
    type: object
    properties:
      action: { type: string, enum: [echo, time] }
      message: { type: string }
    required: []
```

- **handler.type = module**：动态 import `path` 指向的模块，需导出 `execute(input, args) => Promise<string>`
- **handler.type = script**：在技能目录下执行脚本，`input` 通过 stdin 或环境变量 `SKILL_INPUT` 传入
- **handler.type = url**：POST 到指定 URL，body 为 `{ skill, input, arguments }`

## handler.js 约定（type: module）

需导出：

```js
export async function execute(input, args) {
  // input 为可选任务/输入摘要；args 为 input_schema 解析后的参数
  return "结果文本";
}
```
