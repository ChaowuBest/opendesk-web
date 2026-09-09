# 本地 Agent Skills（Anthropic 行业标准）

本目录为**示例与模板**。要启用本地技能，请将需要的技能子目录（如 `example`）**复制到应用数据目录下的 `skills` 文件夹**：

- **Windows**: `%APPDATA%/opendesk/skills/`
- **macOS**: `~/Library/Application Support/opendesk/skills/`

复制后重启应用或调用 `skillRegistry:refresh`，主进程对话即可自动发现并调用这些技能。

格式对齐 **Anthropic 发布的 Agent Skills 行业标准**：[agentskills.io](https://agentskills.io/specification)

## 技能目录结构

每个技能一个子目录。通过「添加」导入时，**拷贝到应用数据目录下的子目录名以 SKILL.md 中的 `name` 为准**（源目录或 zip 内目录名可与 `name` 不一致）。

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
    version: '1.0.0'
---
```

正文为 Markdown，无结构限制，供模型按需加载。

## 渐进式加载（调用时加载资源与能力）

当主进程**调用**某技能（tool 被触发）时，会**渐进式加载**该技能的全部资源，一并返回给模型：

1. **技能说明**：SKILL.md 正文
2. **参考文档**：技能根目录下除 SKILL.md 外的 `.md` 文件（如 `reference.md`、`forms.md`）及 `references/` 子目录内容
3. **可用脚本**：`scripts/` 下列出的脚本路径
4. **资源文件**：`assets/` 下列出的文件路径

因此无需在发现阶段加载全文；模型在“需要该技能时”调用 tool，即可获得完整说明与参考文档、脚本列表，便于按步骤执行或调用脚本。

## OpenDesk 扩展（可选执行）

未配置执行器时，主进程调用技能会返回上述渐进式加载的完整内容。若需“执行并返回结果”，可在 frontmatter 中增加 `opendesk` 扩展：

```yaml
opendesk:
    handler:
        type: module # 或 script / url
        path: handler.js # 相对技能目录
    input_schema: # 可选，定义 tool 参数（JSON Schema）
        type: object
        properties:
            action: { type: string, enum: [echo, time] }
            message: { type: string }
        required: []
```

- **handler.type = module**：动态 import `path` 指向的模块，需导出 `execute(input, args, skillContext?) => Promise<string>`
- **handler.type = script**：在技能目录下执行脚本，`input` 通过 stdin 或环境变量 `SKILL_INPUT` 传入
- **handler.type = url**：POST 到指定 URL，body 为 `{ skill, input, arguments, skillContext }`

配置 handler 后，返回给模型的内容为：**渐进式加载的完整技能内容** + **执行结果**，便于模型结合说明与结果继续推理。

## handler.js 约定（type: module）

需导出：

```js
export async function execute(input, args, skillContext) {
    // input: 可选任务/输入摘要；args: input_schema 解析后的参数
    // skillContext: { skillDir, body, frontmatter, resources: { referencesSections, scriptsList, assetsList } }
    return '结果文本';
}
```
