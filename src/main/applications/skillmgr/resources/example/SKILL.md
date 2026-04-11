---
name: example
description: 示例技能，用于测试本地端侧 Agent Skills 发现与调用。可回显输入或返回当前时间。
license: MIT
metadata:
    version: '1.0.0'
    author: OpenDesk
# OpenDesk 扩展：配置后主进程会执行并返回结果；不配置则仅返回下方正文供模型参考
fillipdesk:
    handler:
        type: module
        path: handler.js
    input_schema:
        type: object
        properties:
            action:
                type: string
                enum: [echo, time]
                description: 执行动作，echo=回显输入，time=返回当前时间
            message:
                type: string
                description: 当 action 为 echo 时的要回显的文本
        required: []
---

# 示例技能说明

本技能演示 Anthropic Agent Skills 标准格式（agentskills.io）：

- **name** 仅小写字母、数字、连字符；添加后技能目录以 name 命名
- **description** 描述能力与适用场景
- 正文为 Markdown，可写使用说明与步骤

配置 `fillipdesk.handler` 后，主进程对话会调用对应脚本/模块并返回执行结果；未配置时仅将本正文提供给模型作为参考。

## 使用示例

- 让助手「调用 example 技能，action 为 time」可得到当前时间
- 「用 example 回显 hello」可得到 echo 结果
